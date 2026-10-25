/**
 * Task 12d：站点设置面 doctor/provision/verify 数据文案按**请求语言**本地化（Node 验收）。
 *
 * 判据与 `tests/test_feishu_i18n_t12d.py` 镜像，双端共用同一组 golden：
 *   ① 无语言信号（zh）时 doctor/provision status/start/apply/publish/cancel/verify 的
 *      payload 与改动前 HEAD（`789bf1c`）逐字节相同（`ZH_GOLDEN`）；
 *   ② 同一组 ctx + `en` 时 label/detail/hint/error 为英文且无中文（协议指令词/动态值
 *      白名单除外），机器值（key/state/ok/version/app_id/supported/enabled/age_s）不变；
 *   ③ 语言源 = 请求语言（头 → query → 偏好 → zh）；`TS_I18N=0` ⇒ zh 且零偏好读库；
 *   ④ 双端同 ctx en payload sha256 相同（`EN_GOLDEN` 与 Python 测试逐字相同）。
 *
 * 全程离线：`fetch` 全打桩，DB 用 `freshDb` 临时库，绝不发真实飞书请求。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as cfg from '../lib/feishu_cfg.js';
import * as inbound from '../lib/feishu_inbound.js';
import * as prov from '../lib/feishu_provision.js';
import { _TOKEN_CACHE } from '../lib/feishu_rest.js';
import * as slash from '../lib/feishu_slash.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import { dispatch, makeContext } from '../routes/index.js';
import { routes as appRoutes } from '../routes/feishu_app.js';
import { freshDb } from './m3fixture.mjs';

const UID = 995001;
const FROZEN_NOW = 1000;          // Date.now() 冻结值（秒 = FROZEN_NOW/1000）
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const shaObj = (obj) => sha256(pyJsonDumps(obj));
const HAN = /[\u4e00-\u9fff]/;
const PROTOCOL_TOKENS = ['接入', '绑定'];

// 改动前 HEAD（789bf1c）同 ctx 的 sha256（与 Python 测试 ZH_GOLDEN 逐字相同）
const ZH_GOLDEN = {
  doctor_no_creds: '06095f775a6168ebe69d580ac29496c9e319ae3140939ade653e254ee9fe33e5',
  doctor_full: '0787252be88a7ebc7240f3fd5496d61e73309d0384215d1e642b1318d52a1643',
  verify_ok: 'd95566d95558c5618ca2cbfa667a9c163f6931e7a683225b5ae7749b30eedef1',
  verify_warn: '5f33906ec30a2791ab0006b3e4d87bb4ca6c6f021335278ed040bcca9fc3fd1d',
  verify_no_creds: '8d7caa9eef9a9bca0312a8f63148efc39489e711f5bd75f254d37a1265da9422',
  apply_ok: '107517c13cebab6e60cb0b6a6db07e1602aad11e0f2f4e828e597c36d0139183',
  apply_no_creds: 'b4056b49d1a5618733477078c1b960ab44616ff58699369b7f33b336590f4b75',
  apply_disabled: '01e8b96b2b6b67f90ff8990d250ce337985dda11f94eb45d9cb2e89c531af14c',
  publish_ok: '85dc7373c41964a540490bb9aa9e2ccfc6f8f52d94f8a455cf8934d731fa9013',
  publish_no_creds: 'a6d387e6ea3fa1b0215d299c4b12acaf3d9fc4ccbc561180c6eddb571860a06b',
  start_disabled: '636223b9be06c27e6c5156be09dc3d8e3406558af5c5dac6c2b54be33a012621',
  start_unsupported: '26cb53c81ca9d36d554250b96303b5f730ecc2ebd734abfe14da70d839a08107',
  status_idle: 'f1e47375ba701b1051f83bdeeeea6179ff388478f7bafe5d8dbd249e5eb9ba57',
  status_ttl: '783676d36f62d57ef8797bbef5db4b5d907e9154684a23344d301bee0008d1ee',
  status_steps_ok: '180e4e1b8c4bd67559388efefc0d23f04a910f742bd5e7a503315205324a4325',
  status_worker_error: 'db60a0a243acc840a94988727c4b637e6cb72a1645d8b011d1a2026b4cf9b496',
  status_partial_error: 'cd9ffcfbb541f7c4115ee169d8fef33ec9d8da2e4d8cb1bdc31f5e68aac618e5',
  status_no_creds_error: '87fba74bd6a29ef8c92b91ce8f222a957b20a78bb54d51dee8363e19b0d613ff',
  cancel_none: '364394ecb9c5ec48f5155add5a7fed6bcbee66f7a08892b2f95f0faa1e335f6a',
};
// 同一组 ctx 的英文 payload sha256（Python 孪生测试断言同一组常量）
const EN_GOLDEN = {
  doctor_no_creds: '81e8e3243e97306808761795baac8b2fb2e1b2e2d3c48016fd1aad32d91b02ba',
  doctor_full: '5fcf3aa61e2403931fea116f304f0d99ca1a1f3194462cf2d139f38895ba5878',
  verify_ok: '181c278a1a540eb6070c19e2d252de5501b5508f27c164d50da884006c83996a',
  apply_ok: '64379a1b806b7a30a6a8bad746484eb4d70137718c8c59dda8c9a473b75656ad',
  publish_ok: '85dc7373c41964a540490bb9aa9e2ccfc6f8f52d94f8a455cf8934d731fa9013',
  status_idle: 'f1e47375ba701b1051f83bdeeeea6179ff388478f7bafe5d8dbd249e5eb9ba57',
  status_steps_ok: '9d8a7e584d662e6d4793096f9fe9202df37c9355bbff92676096887250c46427',
  status_ttl: '2a5159fc66a12b866a063496f0b6ecbb39e1079372024bfaa28901d763cb2e6d',
  cancel_none: 'c5fa0de5c20032017ad5fb882914dfeb70f3a2961dffe03cf175ba08e7a194f5',
};

function assertNoChinese(value, extra = []) {
  const text = typeof value === 'string' ? value : pyJsonDumps(value);
  let cleaned = text;
  for (const token of [...new Set([...PROTOCOL_TOKENS, ...extra])]
    .sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.split(token).join('');
  }
  assert.ok(!HAN.test(cleaned), `英文面仍含中文: ${JSON.stringify(text)}`);
}

const realFetch = globalThis.fetch;
const realNow = Date.now;

function fresh(tag) {
  const fx = freshDb(`t12d-${tag}`);
  _TOKEN_CACHE.clear();
  prov._PROVISION.clear();
  prov._LAST_EVENT_TS.clear();
  prov._LAST_PROBE_TS.clear();
  cfg.clearInboundThread(UID);
  return fx;
}

function freezeNow() { Date.now = () => FROZEN_NOW * 1000; }
function restoreNow() { Date.now = realNow; }

function setCreds(fx, obj = {}) {
  db.setFeishuUserCfg(UID, { enabled: 1, push_enabled: 1, default_webhook: '',
    default_secret: '', base_url: '', app_id: 'cli_x', app_secret: 's',
    ...obj }, { db: fx.db });
}
function setBinding(fx) { db.setFeishuBinding('ou_x', UID, 0, { db: fx.db }); }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } });
}

/** 统一 fetch 桩：所有网络都由本函数按 URL 应答（未脚本化 URL 直接炸）。 */
function stdFetch({ activate = 2, slashItems = [], slashFail = null,
  onProbe = null, fail = null } = {}) {
  return async (url, init = {}) => {
    if (fail && fail(url)) return jsonResponse(fail(url));
    if (url.includes('/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 });
    }
    if (url.includes('/bot/v3/info')) {
      return jsonResponse({ code: 0, bot: { app_name: 'Bot', activate_status: activate } });
    }
    if (url.includes('/app_slash_commands')) {
      if (slashFail) return jsonResponse(slashFail);
      return jsonResponse({ code: 0, data: { items: slashItems } });
    }
    if (url.includes('/im/v1/messages')) {
      if (onProbe) onProbe(init);
      return jsonResponse({ code: 0, data: {} });
    }
    if (/\/applications\/[^/]+\/(ability|config)$/.test(url)) {
      return jsonResponse({ code: 0 });
    }
    if (url.includes('/app_versions')) {
      return jsonResponse({ code: 0, data: { items: [{ version: '1.0.3' }] } });
    }
    if (url.includes('/publish')) {
      return jsonResponse({ code: 0, data: { version: '1.0.4', version_id: 'v1' } });
    }
    throw new Error(`未脚本化 fetch：${url}`);
  };
}

// ---------------------------------------------------------------------------
// 确定性场景（与 Python 测试同名同 ctx）
// ---------------------------------------------------------------------------

async function doctorNoCreds(monkeypatchFetch = stdFetch()) {
  const fx = fresh('doc-nocreds');
  try {
    globalThis.fetch = monkeypatchFetch;
    return await prov.doctor(UID, false, { db: fx.db });
  } finally { fx.close(); }
}

async function doctorFull(lang) {
  const fx = fresh('doc-full');
  freezeNow();
  try {
    setCreds(fx, { default_webhook: 'https://example.com/hook' });
    cfg.setInboundThread(UID, { isAlive: () => true }, 'cli_x');
    setBinding(fx);
    prov._LAST_EVENT_TS.set(UID, FROZEN_NOW - 10);
    globalThis.fetch = stdFetch();
    return await prov.doctor(UID, false, { db: fx.db, dataLang: lang });
  } finally { restoreNow(); fx.close(); }
}

async function doctorWarn(lang) {
  const fx = fresh('doc-warn');
  freezeNow();
  try {
    setCreds(fx, { app_id: 'cli_x', app_secret: 's' });
    cfg.setInboundThread(UID, { isAlive: () => true }, 'cli_old');
    setBinding(fx);
    prov._LAST_EVENT_TS.set(UID, FROZEN_NOW - 900);
    const sent = [];
    globalThis.fetch = stdFetch({
      activate: 1, slashFail: { code: 99991640, msg: 'no perm' },
      onProbe: (init) => sent.push(JSON.parse(init.body)),
    });
    const out = await prov.doctor(UID, true, { db: fx.db, dataLang: lang });
    return { out, sent };
  } finally { restoreNow(); fx.close(); }
}

async function verifyOk(lang) {
  const fx = fresh('verify-ok');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch();
    return await prov.verifyCredentials(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function verifyWarn(lang) {
  const fx = fresh('verify-warn');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch({ activate: 1 });
    return await prov.verifyCredentials(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function verifyNoCreds(lang) {
  const fx = fresh('verify-nocreds');
  try { return await prov.verifyCredentials(UID, { db: fx.db, lang }); }
  finally { fx.close(); }
}
async function verifyRestFail(lang) {
  const fx = fresh('verify-restfail');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch({ fail: (url) => url.includes('/tenant_access_token/')
      ? { code: 10014, msg: 'bad creds' } : null });
    return await prov.verifyCredentials(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function verifyExc(lang) {
  const fx = fresh('verify-exc');
  try {
    setCreds(fx);
    globalThis.fetch = async () => { throw new TypeError('boom'); };
    return await prov.verifyCredentials(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}

async function applyOk(lang) {
  const fx = fresh('apply-ok');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch();
    return await prov.provisionApply(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function applyNoCreds(lang) {
  const fx = fresh('apply-nocreds');
  try { return await prov.provisionApply(UID, { db: fx.db, lang }); }
  finally { fx.close(); }
}
async function applyDisabled(lang) {
  const fx = fresh('apply-disabled');
  try {
    setCreds(fx);
    return await prov.provisionApply(UID,
      { db: fx.db, env: { TS_FEISHU_PROVISION: '0' }, lang });
  } finally { fx.close(); }
}
async function applyAbilityFail(lang) {
  const fx = fresh('apply-abilityfail');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch({ fail: (url) => url.endsWith('/ability')
      ? { code: 99991640, msg: 'no perm' } : null });
    return await prov.provisionApply(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function applyConfigFail(lang) {
  const fx = fresh('apply-configfail');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch({ fail: (url) => url.endsWith('/config')
      ? { code: 1, msg: 'config boom' } : null });
    return await prov.provisionApply(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}

async function publishOk(lang) {
  const fx = fresh('publish-ok');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch();
    return await prov.provisionPublish(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function publishNoCreds(lang) {
  const fx = fresh('publish-nocreds');
  try { return await prov.provisionPublish(UID, { db: fx.db, lang }); }
  finally { fx.close(); }
}
async function publishRestFail(lang) {
  const fx = fresh('publish-restfail');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch({ fail: (url) => url.includes('/publish')
      ? { code: 1, msg: 'publish boom' } : null });
    return await prov.provisionPublish(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}
async function publishExc(lang) {
  const fx = fresh('publish-exc');
  try {
    setCreds(fx);
    globalThis.fetch = stdFetch({ fail: (url) => url.includes('/app_versions')
      ? { code: 1, msg: 'boom' } : null });
    return await prov.provisionPublish(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}

async function startErrors(lang) {
  const fx = fresh('start-errors');
  try {
    const out = {};
    setCreds(fx);
    out.disabled = await prov.provisionStart(UID, false,
      { db: fx.db, env: { TS_FEISHU_PROVISION: '0' }, lang });
    const saved = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      out.unsupported = await prov.provisionStart(UID, false, { db: fx.db, lang });
    } finally { globalThis.fetch = saved; }
    out.configured = await prov.provisionStart(UID, false, { db: fx.db, lang });
    return out;
  } finally { fx.close(); }
}

function statusCases(lang) {
  const fx = fresh('status-cases');
  freezeNow();
  try {
    prov._PROVISION.clear();
    const out = { idle: prov.provisionStatus(UID, { db: fx.db, lang }) };
    prov._PROVISION.set(UID, { state: 'waiting', url: '', error: '', app_id: '',
      steps: [], started_at: 0 });
    out.ttl = prov.provisionStatus(UID, { db: fx.db, lang });
    prov._PROVISION.set(UID, {
      state: 'success', url: '', error: '', app_id: 'cli_x',
      steps: [
        { key: 'ability', label: '开启机器人能力', ok: true, detail: '已开启' },
        { key: 'config', label: '权限 / 长连接订阅 / 事件 / 回调', ok: true,
          detail: '已写入（需发布新版本后生效）' },
      ], started_at: 900,
    });
    out.steps_ok = prov.provisionStatus(UID, { db: fx.db, lang });
    prov._PROVISION.set(UID, {
      state: 'failed', url: '', error: '扫码创建失败: boom', app_id: '',
      steps: [{ key: 'ability', label: '开启机器人能力', ok: false, detail: 'no perm' }],
      started_at: 900,
    });
    out.worker_error = prov.provisionStatus(UID, { db: fx.db, lang });
    prov._PROVISION.set(UID, {
      state: 'success', url: '', app_id: 'cli_x', steps: [],
      error: '应用已创建，但配置补齐未完成：应用缺少「application:application:patch」'
        + '权限：请到开发者后台 → 权限管理添加该权限并创建版本发布；'
        + '或把该权限对应用设为免审后再试',
      started_at: 900,
    });
    out.partial_error = prov.provisionStatus(UID, { db: fx.db, lang });
    prov._PROVISION.set(UID, {
      state: 'failed', url: '', app_id: '', steps: [],
      error: '扫码流程未返回应用凭据（可能超时或未确认），可重新发起', started_at: 900,
    });
    out.no_creds_error = prov.provisionStatus(UID, { db: fx.db, lang });
    prov._PROVISION.clear();
    return out;
  } finally { restoreNow(); fx.close(); }
}

function cancelNone(lang) {
  const fx = fresh('cancel-none');
  try {
    prov._PROVISION.clear();
    return prov.provisionCancel(UID, { db: fx.db, lang });
  } finally { fx.close(); }
}

// ---------------------------------------------------------------------------
// HTTP 调用面（真分派链；只实现 ctx 用到的 writeHead/write/end/destroy）
// ---------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: 0, headers: null, chunks: [] };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      write(chunk) { cap.chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) cap.chunks.push(Buffer.from(chunk));
      },
      destroy() {},
    },
  };
}

function fakeReq(method, { body, headers = {} } = {}) {
  const text = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text === null ? [] : [text], { objectMode: false });
  stream.headers = text === null ? { ...headers }
    : { ...headers, 'content-length': String(text.length) };
  stream.method = method;
  return stream;
}

async function call(env, method, target, { body, headers = {}, user } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, { body, headers }),
    res,
    db: env.db,
    user: user === undefined ? env.user : user,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  const buf = Buffer.concat(cap.chunks);
  return { status: cap.status, hit, text: () => buf.toString('utf8') };
}

function setup(tag) {
  const fx = freshDb(`t12d-http-${tag}`);
  const user = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, user };
}

// ---------------------------------------------------------------------------
// ① zh 逐字节保全 + ② en 面
// ---------------------------------------------------------------------------

test('zh payloads 逐字节等于改动前 HEAD golden（doctor/verify/apply/publish/start/status/cancel）', async () => {
  assert.equal(shaObj(await doctorNoCreds()), ZH_GOLDEN.doctor_no_creds);
  assert.equal(shaObj(await doctorFull()), ZH_GOLDEN.doctor_full);
  assert.equal(shaObj(await verifyOk()), ZH_GOLDEN.verify_ok);
  assert.equal(shaObj(await verifyWarn()), ZH_GOLDEN.verify_warn);
  assert.equal(shaObj(await verifyNoCreds()), ZH_GOLDEN.verify_no_creds);
  assert.equal(shaObj(await applyOk()), ZH_GOLDEN.apply_ok);
  assert.equal(shaObj(await applyNoCreds()), ZH_GOLDEN.apply_no_creds);
  assert.equal(shaObj(await applyDisabled()), ZH_GOLDEN.apply_disabled);
  assert.equal(shaObj(await publishOk()), ZH_GOLDEN.publish_ok);
  assert.equal(shaObj(await publishNoCreds()), ZH_GOLDEN.publish_no_creds);
  const starts = await startErrors();
  assert.equal(shaObj(starts.disabled), ZH_GOLDEN.start_disabled);
  assert.equal(shaObj(starts.unsupported), ZH_GOLDEN.start_unsupported);
  const status = statusCases();
  for (const key of ['idle', 'ttl', 'steps_ok', 'worker_error',
    'partial_error', 'no_creds_error']) {
    assert.equal(shaObj(status[key]), ZH_GOLDEN[`status_${key}`], key);
  }
  assert.equal(shaObj(cancelNone()), ZH_GOLDEN.cancel_none);
  globalThis.fetch = realFetch;
});

test('en doctor：八项英文 label/detail/hint + 机器值不变 + 双端同 sha', async () => {
  const zh = await doctorFull();
  const en = await doctorFull('en');
  assert.deepEqual(en.items.map((i) => i.key), zh.items.map((i) => i.key));
  assert.deepEqual(en.items.map((i) => i.state), zh.items.map((i) => i.state));
  assert.deepEqual(en.summary, zh.summary);
  assert.deepEqual(en.items.map((i) => [i.label, i.detail, i.hint]), [
    ['App credentials (App ID / App Secret)', 'Configured', ''],
    ['Credential validity (tenant_access_token)', 'Token obtained successfully', ''],
    ['Bot ability and activation status', 'Bot (activate_status=2)', ''],
    ['Inbound long connection', 'Connection thread is running', ''],
    ['Event subscription (a real message received)',
      'Event received 10 seconds ago', ''],
    ['Slash command permissions', 'Permissions available', ''],
    ['Send-message permission (optional probe)',
      'Not probed (tick “Send a test message” and rerun the self-check)', ''],
    ['Default push webhook', 'Configured', ''],
  ]);
  assertNoChinese(en);
  assert.equal(shaObj(en), EN_GOLDEN.doctor_full);
  globalThis.fetch = realFetch;
});

test('en doctor warn：hints 英文、探针 DM 仍按收件人语言（zh）', async () => {
  const zh = await doctorWarn();
  const en = await doctorWarn('en');
  assert.deepEqual(en.out.items.map((i) => i.key), zh.out.items.map((i) => i.key));
  assert.deepEqual(en.out.items.map((i) => i.state), zh.out.items.map((i) => i.state));
  assert.equal(en.out.items[2].hint,
    'App capabilities → add “Bot”, then publish it in version management and release for it to take effect');
  assert.equal(en.out.items[3].detail,
    'The connection thread is still bound to cli_old (configuration changed to cli_x)');
  assert.equal(en.out.items[4].detail, 'The last event was more than 5 minutes ago');
  assert.equal(en.out.items[5].detail,
    'The app lacks the “app slash command” permission: in the Feishu developer '
    + 'console → Permission management, add application:app_slash_command:read '
    + 'and write, then create and publish a new version and retry');
  assert.equal(en.out.items[7].detail,
    'Not configured (does not affect bot conversations; only blocking-event pushes)');
  assertNoChinese(en.out);
  const probe = JSON.parse(en.sent[0].content).text;
  assert.equal(probe, '🔍 Touchstone 配置自检：收到这条消息说明「发消息」权限已开通。');
  globalThis.fetch = realFetch;
});

test('en verify / apply / publish 变体 + 白名单动态值', async () => {
  assert.deepEqual(await verifyOk('en'),
    { ok: true, detail: 'Credentials are valid: bot Bot (Enabled)' });
  assert.deepEqual(await verifyWarn('en'),
    { ok: true, detail: 'Credentials are valid: bot Bot (activation status=1; '
      + 'the app may not be published or enabled)' });
  assert.deepEqual(await verifyNoCreds('en'),
    { ok: false, detail: 'App credentials are not configured (App ID / App Secret)' });
  assert.deepEqual(await verifyRestFail('en'),
    { ok: false, detail: 'token 获取失败 code=10014 bad creds' });
  // Node 的 token 获取把 fetch 异常包成 FeishuRestError（见 feishu_rest.js），
  // 故这里走的是「上游错误原文透传」桶；Python 侧另有 Probe failed 分支用例。
  assert.deepEqual(await verifyExc('en'),
    { ok: false, detail: 'token 请求失败: boom' });

  assert.deepEqual((await applyOk('en')).steps, [
    { key: 'ability', label: 'Enable bot ability', ok: true, detail: 'Enabled' },
    { key: 'config',
      label: 'Permissions / long-connection subscription / events / callbacks',
      ok: true, detail: 'Written (publish a new version for it to take effect)' },
  ]);
  assert.equal((await applyNoCreds('en')).error,
    'App credentials are not configured (App ID / App Secret); save the credentials first');
  assert.equal((await applyDisabled('en')).error,
    'Configuration automation is disabled (TS_FEISHU_PROVISION=0)');
  const ability = await applyAbilityFail('en');
  assert.equal(ability.need_patch_scope, true);
  assert.ok(ability.error.startsWith('The app lacks the “application:application:patch” permission:'));
  assert.equal(ability.steps[0].detail,
    'REST /open-apis/application/v7/applications/cli_x/ability code=99991640 no perm');
  assertNoChinese(ability);
  const cfgFail = await applyConfigFail('en');
  assert.equal(cfgFail.error, 'REST /open-apis/application/v7/applications/cli_x/config code=1 config boom');

  const pub = await publishOk('en');
  assert.equal(pub.version, '1.0.4');
  assert.equal(pub.version_id, 'v1');
  assert.equal((await publishNoCreds('en')).error,
    'App credentials are not configured (App ID / App Secret); save the credentials first');
  assert.equal((await publishRestFail('en')).error,
    'REST /open-apis/application/v7/applications/cli_x/publish code=1 publish boom');
  // 上游 REST 失败是 FeishuRestError（走透传桶）；「Publish failed: …」泛化分支由
  // Python 侧用例覆盖（Node 的 rest() 把一切网络/业务失败都包成 FeishuRestError）。
  assert.equal((await publishExc('en')).error,
    'REST /open-apis/application/v6/applications/cli_x/app_versions code=1 boom');
  assert.equal(shaObj(await verifyOk('en')), EN_GOLDEN.verify_ok);
  assert.equal(shaObj(await applyOk('en')), EN_GOLDEN.apply_ok);
  assert.equal(shaObj(await publishOk('en')), EN_GOLDEN.publish_ok);
  assert.equal(shaObj(cancelNone('en')), EN_GOLDEN.cancel_none);
  globalThis.fetch = realFetch;
});

test('en start/cancel/status：英文错误与步骤 + 机器值不变', async () => {
  const out = await startErrors('en');
  assert.equal(out.disabled.error,
    'Configuration automation is disabled (TS_FEISHU_PROVISION=0)');
  assert.equal(out.unsupported.error,
    'The local lark-oapi version is too old (register_app requires ≥1.5.5); '
    + 'upgrade the dependency and retry');
  assert.equal(out.configured.error,
    'App cli_x is already configured; confirm before replacing it and retry');
  assert.equal(cancelNone('en').error, 'No provisioning flow is in progress');
  const zh = statusCases();
  const en = statusCases('en');
  for (const key of Object.keys(zh)) {
    assert.deepEqual(Object.keys(en[key]), Object.keys(zh[key]), key);
    for (const machine of ['supported', 'enabled', 'state', 'app_id', 'age_s']) {
      assert.deepEqual(en[key][machine], zh[key][machine], `${key}.${machine}`);
    }
  }
  assert.equal(en.ttl.error,
    'The confirmation link has expired (it is valid for 10 minutes); start again');
  assert.deepEqual(en.steps_ok.steps, [
    { key: 'ability', label: 'Enable bot ability', ok: true, detail: 'Enabled' },
    { key: 'config',
      label: 'Permissions / long-connection subscription / events / callbacks',
      ok: true, detail: 'Written (publish a new version for it to take effect)' },
  ]);
  assert.equal(en.worker_error.error, 'QR-code app creation failed: boom');
  assert.equal(en.worker_error.steps[0].detail, 'no perm');
  assert.equal(en.partial_error.error,
    'The app was created, but the configuration setup did not complete: '
    + 'The app lacks the “application:application:patch” permission: in the '
    + 'developer console → Permission management, add the permission and create '
    + 'a version release; or set the permission to auto-approve for the app and try again');
  assert.equal(en.no_creds_error.error,
    'The QR-code flow did not return app credentials (it may have timed out or '
    + 'not been confirmed); start again');
  assertNoChinese(en);
  assert.equal(shaObj(en.idle), EN_GOLDEN.status_idle);
  assert.equal(shaObj(en.ttl), EN_GOLDEN.status_ttl);
  assert.equal(shaObj(en.steps_ok), EN_GOLDEN.status_steps_ok);
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// ③ HTTP 级：无头字节 / en payload / 头与 query 优先级
// ---------------------------------------------------------------------------

test('HTTP 无头响应逐字节不变（doctor/provision status/cancel/apply/publish）', async (t) => {
  const env = setup('zh');
  t.after(() => env.close());
  const doctorRes = await call(env, 'POST', '/api/me/feishu/doctor', { body: {} });
  assert.equal(doctorRes.status, 200);
  assert.equal(sha256(doctorRes.text()), ZH_GOLDEN.doctor_no_creds);
  const statusRes = await call(env, 'GET', '/api/me/feishu/provision');
  assert.equal(statusRes.status, 200);
  assert.equal(sha256(statusRes.text()), ZH_GOLDEN.status_idle);
  for (const action of ['cancel', 'apply', 'publish']) {
    const r = await call(env, 'POST', '/api/me/feishu/provision', { body: { action } });
    assert.equal(r.status, 200);
    const key = action === 'cancel' ? 'cancel_none'
      : action === 'apply' ? 'apply_no_creds' : 'publish_no_creds';
    assert.equal(sha256(r.text()), ZH_GOLDEN[key], action);
  }
  // 显式 `X-TS-Lang: zh` 与无头同字节（兼容红线覆盖「zh 请求」这一档）
  const zhHeaders = { 'x-ts-lang': 'zh' };
  const zhDoctor = await call(env, 'POST', '/api/me/feishu/doctor',
    { body: {}, headers: zhHeaders });
  assert.equal(sha256(zhDoctor.text()), ZH_GOLDEN.doctor_no_creds);
  const zhStatus = await call(env, 'GET', '/api/me/feishu/provision',
    { headers: zhHeaders });
  assert.equal(sha256(zhStatus.text()), ZH_GOLDEN.status_idle);
  const zhCancel = await call(env, 'POST', '/api/me/feishu/provision',
    { body: { action: 'cancel' }, headers: zhHeaders });
  assert.equal(sha256(zhCancel.text()), ZH_GOLDEN.cancel_none);
  // KB-28：apply / publish 的 HTTP zh 逐字节门禁（此前只有函数级与无头档）
  for (const action of ['apply', 'publish']) {
    const noHead = await call(env, 'POST', '/api/me/feishu/provision',
      { body: { action } });
    const zhRes = await call(env, 'POST', '/api/me/feishu/provision',
      { body: { action }, headers: zhHeaders });
    const key = action === 'apply' ? 'apply_no_creds' : 'publish_no_creds';
    assert.equal(noHead.status, 200);
    assert.equal(zhRes.status, 200);
    assert.equal(zhRes.text(), noHead.text(), `${action}: zh 头与无头逐字节相同`);
    assert.equal(sha256(zhRes.text()), ZH_GOLDEN[key], action);
  }
});

test('HTTP verify：无头与 zh 头正文逐字节相同；en 对照（KB-28）', async (t) => {
  const env = setup('verify-http');
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    cfg.clearInboundThread(1);
    env.close();
  });
  globalThis.fetch = stdFetch();
  // 入站线程「活着」⇒ saveUserConfig 的 inbound_started 恒 false（消除时序字节差）
  cfg.setInboundThread(1, { isAlive: () => true }, 'cli_x');

  const noHead = await call(env, 'POST', '/api/me/feishu-cfg', {
    body: { app_id: 'cli_x', app_secret: 's' },
  });
  assert.equal(noHead.status, 200, noHead.text());
  const zh = await call(env, 'POST', '/api/me/feishu-cfg',
    { body: {}, headers: { 'x-ts-lang': 'zh' } });
  const en = await call(env, 'POST', '/api/me/feishu-cfg',
    { body: {}, headers: { 'x-ts-lang': 'en' } });
  assert.equal(zh.status, 200, zh.text());
  assert.equal(en.status, 200, en.text());
  assert.equal(zh.text(), noHead.text(), 'zh 头与无头逐字节相同');
  assert.deepEqual(JSON.parse(noHead.text()).verify,
    { ok: true, detail: '凭据可用：机器人 Bot（已启用）' });
  assert.deepEqual(JSON.parse(en.text()).verify,
    { ok: true, detail: 'Credentials are valid: bot Bot (Enabled)' });
  assert.notEqual(en.text(), noHead.text());
});

test('HTTP en：doctor/provision 英文 payload；头优先于 query', async (t) => {
  const env = setup('en');
  t.after(() => env.close());
  const headers = { 'x-ts-lang': 'en' };
  const doctorRes = await call(env, 'POST', '/api/me/feishu/doctor',
    { body: {}, headers });
  assert.equal(doctorRes.status, 200);
  assert.equal(sha256(doctorRes.text()), EN_GOLDEN.doctor_no_creds);
  const payload = JSON.parse(doctorRes.text());
  assert.equal(payload.items[0].label, 'App credentials (App ID / App Secret)');
  assert.equal(payload.items[0].detail, 'Not configured');
  assertNoChinese(payload);
  const statusRes = await call(env, 'GET', '/api/me/feishu/provision', { headers });
  assert.equal(sha256(statusRes.text()), EN_GOLDEN.status_idle);
  const cancelRes = await call(env, 'POST', '/api/me/feishu/provision?lang=en',
    { body: { action: 'cancel' }, headers: { 'x-ts-lang': 'zh' } });
  assert.equal(JSON.parse(cancelRes.text()).error, '当前没有进行中的扫码流程');
  const queryRes = await call(env, 'POST', '/api/me/feishu/provision?lang=en',
    { body: { action: 'cancel' } });
  assert.equal(JSON.parse(queryRes.text()).error, 'No provisioning flow is in progress');
});

// ---------------------------------------------------------------------------
// ④ TS_I18N=0：zh + 零偏好读库（SQL 计数 + 正对照）
// ---------------------------------------------------------------------------

function countingDb(real) {
  const sqls = [];
  return {
    sqls,
    prepare(sql) { sqls.push(sql); return real.prepare(sql); },
    exec(sql) { sqls.push(sql); return real.exec(sql); },
    close() {},
  };
}

test('TS_I18N=0：即使函数收到 en 也恒 zh（payload 与 zh golden 同字节）', async () => {
  const saved = process.env.TS_I18N;
  try {
    process.env.TS_I18N = '0';
    assert.equal(shaObj(await doctorFull('en')), ZH_GOLDEN.doctor_full);
    assert.equal(shaObj(await verifyOk('en')), ZH_GOLDEN.verify_ok);
    assert.equal(shaObj(await applyOk('en')), ZH_GOLDEN.apply_ok);
    assert.equal(shaObj(statusCases('en').ttl), ZH_GOLDEN.status_ttl);
  } finally {
    if (saved === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = saved;
    globalThis.fetch = realFetch;
  }
});

test('TS_I18N=0：恒 zh 且零偏好读库（正对照证明桩可被读）', async (t) => {
  const env = setup('rollback');
  t.after(() => env.close());
  db.setUserPref(env.user.id, 0, 'lang', { v: 'en' }, { db: env.db });
  const saved = process.env.TS_I18N;
  const savedFetch = globalThis.fetch;
  try {
    process.env.TS_I18N = '0';
    const zero = countingDb(env.db);
    const before = await call({ ...env, db: zero }, 'POST', '/api/me/feishu/doctor',
      { body: {} });
    assert.equal(before.status, 200);
    assert.deepEqual(JSON.parse(before.text()).items[0].detail, '未配置');
    assert.equal(zero.sqls.some((s) => s.includes('user_prefs')), false,
      `TS_I18N=0 仍读了偏好: ${JSON.stringify(zero.sqls)}`);

    delete process.env.TS_I18N;
    globalThis.fetch = stdFetch();
    const one = countingDb(env.db);
    const after = await call({ ...env, db: one }, 'POST', '/api/me/feishu/doctor',
      { body: {} });
    assert.equal(after.status, 200);
    assert.deepEqual(JSON.parse(after.text()).items[0].detail, 'Not configured');
    assert.equal(one.sqls.some((s) => s.includes('user_prefs')), true,
      '正对照未读到偏好（桩失效）');
  } finally {
    if (saved === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = saved;
    globalThis.fetch = savedFetch;
  }
});

// ---------------------------------------------------------------------------
// ⑦ KB-27 / KB-36：接入卡慢动作 DM 数据面 + slash 设置页数据面跟随语言
// ---------------------------------------------------------------------------

// 改动前（本任务前）无凭据档的 sha256（与 Python 测试同名常量逐字相同；勿手改）
const SLASH_GET_ZH_SHA = '2c4e0e279ca5da65eb987c121d85e2a764e0086bec54309592a30079aa24eac3';
const SLASH_CLEAR_ZH_SHA = '280fc6a5d90f476da5d6a40e695ac3386d7914c743fbe59ce95296868b7b2639';
// 改动前慢动作 DM（无凭据档，zh）的 sha256：证明新增 dataLang/lang 透传后字节不变
const SLOW_DM_ZH_SHA = {
  doctor: '7f2b49c57750cead5b6c13af53e909c83b32469bf72ddf9d23ee647b6c979844',
  apply: '929a85a7d5892b7f0bee68853e6d9bbea1ebaedb35d247489aac4b897f285e77',
  publish: '757be30948fb76a030b42fe13b8c4c80919e3a615f7b4bb98724f7dc164f0244',
};
const SLASH_CFG_NULL_EN = 'App credentials are not configured (App ID/App Secret); '
  + 'save them under “Feishu bot configuration” above and retry';
const SLASH_NO_CREDS_EN = 'App credentials are not configured (App ID/App Secret)';
// en 同场景 payload 的 sha256（与 Python 测试同名常量逐字相同 ⇒ 双端逐字节一致）
const SLASH_GET_EN_SHA = '712d5f2d4963437d943d9be5c140a8087f7e7cfc389533488c54ef3e02b9c031';
const SLASH_CLEAR_EN_SHA = 'a86879ec510281f5faf78ff64907d7f9af83234d1de0ec272eb3afe2b54d981f';

/** 用**真** provision 模块跑慢动作，只把 DM 发送收进数组（无凭据 ⇒ 零网络）。 */
async function slowActionDms(tag, action, lang) {
  const fx = fresh(`t12d-slow-${tag}`);
  const dms = [];
  try {
    const options = {
      db: fx.db,
      rest: { async restSendText(openId, text) { dms.push(text); } },
      provision: prov,
      log: () => {},
    };
    await inbound.setupSlowAction(UID, 'ou_x', action, null, options, lang);
    return dms;
  } finally { fx.close(); }
}

test('zh 慢动作 DM 逐字节不变（KB-27 硬约束①）', async () => {
  for (const action of ['doctor', 'apply', 'publish']) {
    const dms = await slowActionDms(`zh-${action}`, action);
    assert.equal(dms.length, 1, action);
    assert.equal(sha256(dms[0]), SLOW_DM_ZH_SHA[action], action);
  }
});

test('en 慢动作：doctor/apply/publish DM 数据面英文（KB-27）', async () => {
  const doctorDms = await slowActionDms('en-doctor', 'doctor', 'en');
  assert.equal(doctorDms.length, 1);
  assert.equal(doctorDms[0],
    '🩺 Configuration self-check: ok 0 / fail 1 / warn 1 / skip 6\n'
    + '· App credentials (App ID / App Secret): Not configured '
    + '(Enter the App ID and App Secret under “Feishu bot configuration” and save)\n'
    + '· Default push webhook: Not configured (does not affect bot conversations; '
    + 'only blocking-event pushes) (Group settings → Group bots → add a custom bot, '
    + 'then enter the webhook on the settings page)');
  assertNoChinese(doctorDms[0]);

  const applyDms = await slowActionDms('en-apply', 'apply', 'en');
  assert.deepEqual(applyDms, ['❌ Failed to apply configuration: '
    + 'App credentials are not configured (App ID / App Secret); '
    + 'save the credentials first']);
  const publishDms = await slowActionDms('en-publish', 'publish', 'en');
  assert.deepEqual(publishDms, ['❌ Failed to submit for publishing: '
    + 'App credentials are not configured (App ID / App Secret); '
    + 'save the credentials first']);
});

test('HTTP slash：zh 逐字节不变；en 头 error 英文而 desired 17 条保持中文（KB-36）', async (t) => {
  const env = setup('slash-lang');
  t.after(() => env.close());
  const S = '/api/me/feishu/slash-commands';
  const zhGet = await call(env, 'GET', S);
  assert.equal(zhGet.status, 200);
  assert.equal(sha256(zhGet.text()), SLASH_GET_ZH_SHA);
  const zhClear = await call(env, 'POST', S, { body: { action: 'clear' } });
  assert.equal(zhClear.status, 200);
  assert.equal(sha256(zhClear.text()), SLASH_CLEAR_ZH_SHA);
  const zhHeader = await call(env, 'GET', S, { headers: { 'x-ts-lang': 'zh' } });
  assert.equal(sha256(zhHeader.text()), SLASH_GET_ZH_SHA);

  const enGet = await call(env, 'GET', S, { headers: { 'x-ts-lang': 'en' } });
  assert.equal(enGet.status, 200);
  const payload = JSON.parse(enGet.text());
  assert.equal(payload.configured, false);
  assert.equal(payload.error, SLASH_CFG_NULL_EN);
  assert.equal(sha256(enGet.text()), SLASH_GET_EN_SHA);
  assert.equal(payload.desired.length, 17);
  // 17 条说明是机器人协议面（飞书客户端里的中文指令说明），不许被改成英文
  assert.ok(payload.desired.every((d) => HAN.test(d.description)));
  assert.deepEqual(payload.desired.map((d) => d.description),
    slash.SLASH_COMMANDS.map(([, description]) => description));
  assertNoChinese(payload.error);
  for (const action of ['sync', 'clear']) {
    const r = await call(env, 'POST', S,
      { body: { action }, headers: { 'x-ts-lang': 'en' } });
    assert.equal(r.status, 200, action);
    const out = JSON.parse(r.text());
    assert.equal(out.error, SLASH_NO_CREDS_EN, action);
    assert.equal(out.card_sent, false);
    assert.equal(out.card_error, '');
    assert.equal(sha256(r.text()), SLASH_CLEAR_EN_SHA, action);
  }
});

test('HTTP slash notify：无头请求不求值 ctx.lang（零偏好读库；clear 正对照读一次）', async (t) => {
  const env = setup('slash-notify-lang');
  t.after(() => env.close());
  const saved = process.env.TS_I18N;
  try {
    delete process.env.TS_I18N;                       // 确保偏好档是活的（回滚开关不是假绿来源）
    db.setUserPref(env.user.id, 0, 'lang', { v: 'en' }, { db: env.db });
    const S = '/api/me/feishu/slash-commands';

    // notify 分支不消费请求语言（卡片语言取收件人偏好）⇒ 无 X-TS-Lang 时必须零偏好读库
    const notifyDb = countingDb(env.db);
    const notify = await call({ ...env, db: notifyDb }, 'POST', S,
      { body: { action: 'notify' } });
    assert.equal(notify.status, 200);
    const out = JSON.parse(notify.text());
    assert.deepEqual(Object.keys(out), ['ok', 'card_sent', 'card_error']);
    assert.equal(out.card_sent, false);
    assert.equal(notifyDb.sqls.some((s) => s.includes('user_prefs')), false,
      `notify 仍读了请求语言偏好: ${JSON.stringify(notifyDb.sqls)}`);

    // 正对照：clear 按请求语言渲染 error ⇒ 无头时读一次偏好（证明计数桩有效）
    const clearDb = countingDb(env.db);
    const clear = await call({ ...env, db: clearDb }, 'POST', S,
      { body: { action: 'clear' } });
    assert.equal(clear.status, 200);
    assert.equal(JSON.parse(clear.text()).error, SLASH_NO_CREDS_EN);
    assert.equal(clearDb.sqls.some((s) => s.includes('user_prefs')), true,
      '正对照未读到偏好（桩失效）');
  } finally {
    if (saved === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = saved;
  }
});

test('clearSlashCommands 失败路径：failed[0] 与 error 同文案；en 权限引导英文（zh 对照）', async () => {
  const fx = fresh('slash-clear-fail');
  const savedFetch = globalThis.fetch;
  const HINT_EN = 'The app lacks the “app slash command” permission: in the Feishu '
    + 'developer console → Permission management, add application:app_slash_command:read '
    + 'and write, then create and publish a new version and retry';
  try {
    setCreds(fx);
    globalThis.fetch = async (url, init = {}) => {
      if (url.includes('/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 });
      }
      if (url.includes('/app_slash_commands')) {
        if (String(init.method || 'GET').toUpperCase() === 'DELETE') {
          return jsonResponse({ code: 99991640, msg: 'no permission' });
        }
        return jsonResponse({ code: 0, data: { items: [{
          command: 'help', command_id: 'c1',
          description: '查看可用指令', icon_key: 'skill_outlined',
        }] } });
      }
      throw new Error(`未脚本化 fetch：${url}`);
    };

    const zh = await slash.clearSlashCommands(UID, { db: fx.db });
    assert.equal(zh.need_scope, true);
    assert.deepEqual(zh.deleted, []);
    assert.equal(zh.failed.length, 1);
    assert.ok(zh.failed[0].startsWith('help: 应用缺少「应用指令」权限'));
    assert.equal(zh.error, zh.failed[0]);

    const en = await slash.clearSlashCommands(UID, { db: fx.db, lang: 'en' });
    assert.equal(en.failed.length, 1);
    assert.equal(en.failed[0], `help: ${HINT_EN}`);
    assert.equal(en.error, en.failed[0]);
    assertNoChinese(en.failed[0]);
  } finally {
    globalThis.fetch = savedFetch;
    fx.close();
  }
});
