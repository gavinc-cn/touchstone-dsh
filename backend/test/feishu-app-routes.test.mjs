/**
 * 飞书「应用面」族单测（M7-R5）：`backend/routes/feishu_app.js`（5 条路由）+
 * `backend/lib/feishu_provision.js` 的 R5 追加段（`feishu.py:2665-2934` 的对应物）。
 *
 * 期望值**全部来自 oracle 源码**（`feishu.py` / `server.py` 的行号写在每个用例里），
 * 不从这里实现反推；实例级对拍（`tools/parity/http-run.mjs --case m7_feishu_app`）
 * 负责跨运行时的语义等价，本文件负责三件对拍器**结构比对照不到**的东西：
 *
 * ① **字节形态**。对拍器的 JSON 观测通道是 `compareJson`（`lib/compare.mjs:58-65`）：
 *    键集合**排序后**比、值递归比 ⇒ **键序与空白都不在判据里**。而本族正好两种形态并存：
 *    - `ctx.json`（= Python `json.dumps`，分隔符 `, `/`: `）⇒ **带空格**：成功体、`doctor`、
 *      `slash-commands` 的全部 200 体、以及 `/provision` 的 400；
 *    - `ctx.error`（硬编码字节串）⇒ **紧凑**：401/403 与全站同形。
 *    这里用 `assert.equal(r.text(), '<字面量>')` 把带空格那一族的**字节**钉死，
 *    并把键序用 `Object.keys()` 钉死（`JSON.parse` 保留插入序）。
 * ② **能力探测（M9 已变）**：`provisionSupported()` 曾是 Node 侧**恒 false**（零 npm 依赖、
 *    没有 lark-oapi）；M9 起改为**真能力探测**（`fetch` + `node:zlib.gzipSync`），与 oracle 的
 *    `_lark_min_ok()`（lark-oapi ≥ 1.5.5）**同语义**（都是「本运行时有没有这个能力」）。
 *    对拍器仍把这个字段掩成 `<env>`（`NORMALIZE.supported`）并把**原始读数**记进报告；
 *    「判定当场读运行时、不缓存」这条事实只能在这里钉。
 * ③ **闸门顺序**：`provisionStart` 的四道闸逐字照抄 oracle（总闸 → 能力 → 进行中未超 TTL →
 *    已配置需 force）。M9 起第 ② 道闸不再恒拦 ⇒ **③④ 与第 ⑤ 步（起 worker）全部可达**，
 *    本文件用 `_setRegisterAppImplForTest` 打桩 worker 把它们逐条钉住；同时仍钉住
 *    「能力档先于已配置档」这条顺序（否则将来把能力档挪到后面就会与 oracle 分叉）。
 *
 * 走**真分派链**（`makeContext()` + `dispatch()`，与 `feishu-hook-routes.test.mjs` 同款）：
 * 五条路由里三条是 `/api/me/feishu*` 前缀，只有真分派才测得到「谁先匹配」与
 * 「POST 才读体、GET 全程不读体」。
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { SLASH_COMMANDS } from '../lib/feishu_slash.js';
import { _PROVISION, _setRegisterAppImplForTest, _docItem, _nextVersion, doctor,
  inboundWsItem,
  PROVISION_TTL, provisionApply, provisionCancel, provisionEnabled, provisionPublish,
  provisionStart, provisionStatus, provisionSupported } from '../lib/feishu_provision.js';
import { clearInboundThread, inboundStatus, inboundThreadAppId,
  setInboundThread } from '../lib/feishu_cfg.js';
import { AppAccessDeniedError, RegisterAppError } from '../lib/feishu_device.js';
// worker 清的是 `feishu_rest.js` 的 token 缓存（`_TOKEN_CACHE.pop(app_id, None)`，feishu.py:3079）
import { _TOKEN_CACHE } from '../lib/feishu_rest.js';
import { routes as appRoutes } from '../routes/feishu_app.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 打桩：Device Flow（`_setRegisterAppImplForTest`，对齐 oracle 测试的
// `monkeypatch.setattr(feishu, "_register_app_impl", stub)`）
// --------------------------------------------------------------------------

/** 装桩；返回收集器（`calls` 记录每次 `(onQrCode, onStatusChange, cancel, addons)`） */
function stubRegisterApp(impl) {
  const calls = [];
  _setRegisterAppImplForTest((onQrCode, onStatusChange, cancel, addons) => {
    calls.push({ onQrCode, onStatusChange, cancel, addons });
    return impl(onQrCode, onStatusChange, cancel, addons);
  });
  return calls;
}

function unhookRegisterApp() {
  _setRegisterAppImplForTest(null);
}

/** 轮询等 worker 把状态推进到目标态（oracle `_wait_state` 同款；超时即失败） */
async function waitState(userId, state, options, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = provisionStatus(userId, options);
    if (st.state === state) return st;
    if (Date.now() > deadline) {
      throw new Error(`等待状态 ${state} 超时：${JSON.stringify(st)}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

/** 让 worker 至少跑过一轮（`await` 若干次微任务 + 一个宏任务） */
function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// --------------------------------------------------------------------------
// 测试台（`lib/http.js` 的调用面只有 writeHead/write/end/destroy）
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: 0, headers: null, chunks: [], destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      write(chunk) { cap.chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) cap.chunks.push(Buffer.from(chunk));
      },
      destroy() { cap.destroyed = true; },
    },
  };
}

/** 请求桩：`body` 给对象（走 JSON.stringify），不给 = 无 body（`readState.ended` = GET 有没有读体） */
function fakeReq(method, { body } = {}) {
  const text = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text === null ? [] : [text], { objectMode: false });
  stream.headers = text === null ? {} : { 'content-length': String(text.length) };
  stream.method = method;
  const readState = { ended: false };
  stream.on('end', () => { readState.ended = true; });
  return { stream, readState };
}

/** 发一次请求（走真路由表） */
async function call(env, method, target, { body, user } = {}) {
  const { stream, readState } = fakeReq(method, { body });
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: stream,
    res,
    db: env.db,
    user: user === undefined ? env.admin : user,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  const buf = Buffer.concat(cap.chunks);
  return {
    status: cap.status,
    headers: cap.headers,
    hit,
    readState,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

/** 逐字节正文断言（本族判据的核心形态：键序 + 空白都在字节里） */
async function expectBody(env, method, target, opts, status, expectedBody) {
  const r = await call(env, method, target, opts);
  assert.equal(r.hit, true, `路由没命中：${method} ${target}`);
  assert.equal(r.status, status, `状态码：${r.text()}`);
  assert.equal(r.text(), expectedBody);
  assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
  return r;
}

/** 在 `TS_FEISHU_PROVISION=0` 的进程环境下跑一段（闸门是**进程级** env，路由层不传 env） */
async function withProvisionOff(fn) {
  const saved = process.env.TS_FEISHU_PROVISION;
  process.env.TS_FEISHU_PROVISION = '0';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TS_FEISHU_PROVISION;
    else process.env.TS_FEISHU_PROVISION = saved;
  }
}

// --------------------------------------------------------------------------
// 夹具
// --------------------------------------------------------------------------

/** 临时库 + 一个非 admin 用户（id=101）；凭据/绑定行走**真 SQL**（与实例级用例的 dbStage 同口径） */
function setup(tag) {
  const fx = freshDb(`fa-${tag}`);
  fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES (?,?,?,?,?,?)').run(101, 'u101', 'x', '', 0, '2026-10-14 00:00:00');
  return {
    ...fx,
    admin: fx.db.prepare('SELECT * FROM users WHERE id=1').get(),
    u101: fx.db.prepare('SELECT * FROM users WHERE id=101').get(),
  };
}

/** 写用户应用凭据（`feishu_user_cfgs.json`：`app_id`+`app_secret` 齐备 ⇒ `app_config` 非 None） */
function setCreds(env, userId, appId = 'app_ok', appSecret = 'sec_ok') {
  env.db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?,?)'
    + ' ON CONFLICT(user_id) DO UPDATE SET json=excluded.json')
    .run(userId, JSON.stringify({ enabled: 1, push_enabled: 1, default_webhook: '',
      default_secret: '', base_url: '', app_id: appId, app_secret: appSecret }));
}

const P = '/api/me/feishu/provision';
const S = '/api/me/feishu/slash-commands';
const D = '/api/me/feishu/doctor';

/** 总闸关文案（`feishu.py:2727/3009/3121` 三处同一模板 `配置自动化已关闭（{PROVISION_ENV}=0）`） */
const OFF = '配置自动化已关闭（TS_FEISHU_PROVISION=0）';
/** 无凭据文案（`feishu.py:2731/3119`，apply 与 publish 各一份、逐字相同） */
const NO_CREDS = '应用凭据未配置（App ID / App Secret），请先保存凭据';
/** SDK 档文案（`feishu.py:3017`；M9 起只在**能力真的不可用**时才出现） */
const SDK_MIN = '本机 lark-oapi 版本过低（register_app 需 ≥1.5.5），请升级依赖后重试';

// --------------------------------------------------------------------------
// ① 路由表形态
// --------------------------------------------------------------------------

test('路由表：六条端点的方法与字面路径（顺序即匹配顺序，与 server.py:1076/1079/1082/1085/1065/1068 同序）', () => {
  const shape = appRoutes.map((r) => [r.method || 'GET', r.path, typeof r.handler,
    r.re === undefined ? null : String(r.re)]);
  assert.deepEqual(shape, [
    ['GET', '/api/me/feishu/slash-commands', 'function', null],
    ['POST', '/api/me/feishu/slash-commands', 'function', null],
    ['GET', '/api/me/feishu/provision', 'function', null],
    ['POST', '/api/me/feishu/provision', 'function', null],
    ['POST', '/api/me/feishu/doctor', 'function', null],
    // M11.1：设置页「重连入站」按钮（oracle do_POST:1085 → `_api_me_feishu_reconnect`:1826）
    ['POST', '/api/me/feishu/reconnect', 'function', null],
  ]);
});

// --------------------------------------------------------------------------
// ② provision：GET / 缺 action ⇒ 400 / 4 动作分派
// --------------------------------------------------------------------------

test('GET /api/me/feishu/provision：无凭据档**逐字节**（含键序）；supported=true（真能力探测）', async () => {
  const fx = setup('prov-get');
  try {
    // oracle `provision_status`(feishu.py:2985-3004) 的键序 = supported/enabled/state/url/error/app_id/steps/age_s
    // M9 起 `supported` 与 oracle 同值（本机 oracle 是 true）：Node 判「本运行时能跑 RFC 8628 客户端」，
    // oracle 判「lark-oapi ≥ 1.5.5」，两者同为**运行时能力**判定 ⇒ 这条字节串两侧可比。
    await expectBody(fx, 'GET', P, {}, 200,
      '{"supported": true, "enabled": true, "state": "idle", "url": "", "error": "",'
      + ' "app_id": "", "steps": [], "age_s": 0}');
    assert.equal(fx.admin.must_change_pw, 0, '夹具的 admin 不该是强制改密态');
  } finally { fx.close(); }
});

test('GET 不读请求体（Python `do_GET` 全程没有 `_read_json`）；POST 必读（`do_POST:1048` 在分派之前）', async () => {
  const fx = setup('prov-body');
  try {
    const g = await call(fx, 'GET', P, {});
    assert.equal(g.readState.ended, false, 'GET 读了请求体 ⇒ 与 Python 的读体时机分叉');
    const p = await call(fx, 'POST', P, { body: { action: 'cancel' } });
    assert.equal(p.readState.ended, true, 'POST 必须把 body 读掉（否则污染 keep-alive 连接）');
  } finally { fx.close(); }
});

test('POST /api/me/feishu/provision：缺 action / 空白 / null / 空串 ⇒ 400（**带空格**的 json.dumps 体）', async () => {
  const fx = setup('prov-400');
  const expected = '{"error": "action 仅支持 start / cancel / apply / publish"}';
  try {
    // 缺 action：`str(body.get("action") or "")` = "" ⇒ 不在表内（**与 /slash-commands 缺省 sync 相反**）
    await expectBody(fx, 'POST', P, { body: {} }, 400, expected);
    // 空白串：`str()` **不 strip** ⇒ 也是非法
    await expectBody(fx, 'POST', P, { body: { action: '   ' } }, 400, expected);
    await expectBody(fx, 'POST', P, { body: { action: null } }, 400, expected);
    await expectBody(fx, 'POST', P, { body: { action: '' } }, 400, expected);
    // 大小写敏感（`"Start"` 不认）
    await expectBody(fx, 'POST', P, { body: { action: 'Start' } }, 400, expected);
    // 容器走 Python repr ⇒ 不在表内（`str(["start"])` = `"['start']"`）
    await expectBody(fx, 'POST', P, { body: { action: ['start'] } }, 400, expected);
  } finally { fx.close(); }
});

test('POST cancel 无流程：三键（**没有 url**）、state=idle —— 键序 ok/state/error', async () => {
  const fx = setup('prov-cancel');
  try {
    await expectBody(fx, 'POST', P, { body: { action: 'cancel' } }, 200,
      '{"ok": false, "state": "idle", "error": "当前没有进行中的扫码流程"}');
  } finally { fx.close(); }
});

test('POST apply / publish 无凭据档：两族键序**不同**（ok/need_patch_scope/steps/error vs ok/version/version_id/need_patch_scope/error）', async () => {
  const fx = setup('prov-nocreds');
  try {
    await expectBody(fx, 'POST', P, { body: { action: 'apply' } }, 200,
      `{"ok": false, "need_patch_scope": false, "steps": [], "error": "${NO_CREDS}"}`);
    await expectBody(fx, 'POST', P, { body: { action: 'publish' } }, 200,
      `{"ok": false, "version": "", "version_id": "", "need_patch_scope": false,`
      + ` "error": "${NO_CREDS}"}`);
  } finally { fx.close(); }
});

test('总闸关档（`TS_FEISHU_PROVISION=0`）：start/apply/publish 三条同文案，且**先于**凭据判定', async () => {
  const fx = setup('prov-off');
  try {
    setCreds(fx, 101);                       // 有凭据也得被总闸挡住 ⇒ 证明闸门顺序（总闸 → app_config）
    await withProvisionOff(async () => {
      await expectBody(fx, 'POST', P, { body: { action: 'start' } }, 200,
        `{"ok": false, "state": "idle", "url": "", "error": "${OFF}"}`);
      await expectBody(fx, 'POST', P, { body: { action: 'apply' } }, 200,
        `{"ok": false, "need_patch_scope": false, "steps": [], "error": "${OFF}"}`);
      await expectBody(fx, 'POST', P, { body: { action: 'publish' } }, 200,
        `{"ok": false, "version": "", "version_id": "", "need_patch_scope": false,`
        + ` "error": "${OFF}"}`);
    });
  } finally { fx.close(); }
});

test('POST start（总闸开）：能力可用后第 ③④ 道闸**可达**（force 语义逐字照抄 oracle）', async () => {
  const fx = setup('prov-start');
  // 路由用的是 `ctx.user.id`，这里 `call()` 缺省喂 `env.admin` ⇒ **uid=1**（不是 101）。
  // 前两版用例把 101 当 uid，导致等的是别人（admin）的状态 —— 这条注释就是为了不再踩。
  const uid = fx.admin.id;
  const opts = { db: fx.db, env: {} };
  try {
    // 无凭据 ⇒ 越过 ②③ 直达第 ⑤ 步（起 worker）；用打桩 worker 关掉真 Device Flow。
    // 桩回 null ⇒ worker 走「未返回应用凭据」分支落到 failed，故可以先**等到确定态**，
    // 不给 fire-and-forget 留竞态。
    stubRegisterApp(async () => null);
    await expectBody(fx, 'POST', P, { body: { action: 'start' } }, 200,
      '{"ok": true, "state": "waiting", "url": "", "error": ""}');
    await waitState(uid, 'failed', opts);
    // 四道闸的**顺序**仍逐字照抄 oracle：有凭据 + 不给 force ⇒ 撞「已配置需 force」而不是别的
    _PROVISION.delete(uid);
    setCreds(fx, uid);
    await expectBody(fx, 'POST', P, { body: { action: 'start' } }, 200,
      '{"ok": false, "state": "idle", "url": "", "error": "已配置应用 app_ok；如需换应用请确认后重试"}');
    // force=true ⇒ 放行（第 ④ 道闸真被越过）
    await expectBody(fx, 'POST', P, { body: { action: 'start', force: true } }, 200,
      '{"ok": true, "state": "waiting", "url": "", "error": ""}');
    await waitState(uid, 'failed', opts);
  } finally { _PROVISION.delete(uid); unhookRegisterApp(); fx.close(); }
});

// --------------------------------------------------------------------------
// ③ provision lib：闸门 / 纯函数
// --------------------------------------------------------------------------

test('provisionEnabled：`(env[K] or "1") != "0"`（缺键/空串 ⇒ 开；只有字面 "0" 关）', () => {
  assert.equal(provisionEnabled({}), true);
  assert.equal(provisionEnabled({ TS_FEISHU_PROVISION: '' }), true);
  assert.equal(provisionEnabled({ TS_FEISHU_PROVISION: '1' }), true);
  assert.equal(provisionEnabled({ TS_FEISHU_PROVISION: '0' }), false);
  assert.equal(provisionEnabled({ TS_FEISHU_PROVISION: ' 0' }), true);
});

test('provisionSupported：真能力探测（`fetch` + `node:zlib` 的 gzipSync），与 oracle 同语义', () => {
  // M9 起不再是硬编码常量：判据 = 「本运行时能否跑 RFC 8628 客户端」。
  // oracle 的对应判据是 `_lark_min_ok()`（lark-oapi 版本 ≥ 1.5.5）——同为**运行时能力**静态判定，
  // 不是业务状态（与凭据 / 总闸 / 用户配置无关）。
  assert.equal(provisionSupported(), true);
  assert.equal(typeof globalThis.fetch, 'function', '前提：本运行时 fetch 可用');
  assert.equal(typeof gzipSync, 'function', '前提：本运行时 node:zlib.gzipSync 可用');
  // 判据必须**只读运行时能力**：总闸关掉、用户有/无凭据都不影响它
  const fx = setup('prov-supported');
  try {
    setCreds(fx, 101);
    assert.equal(provisionEnabled({ TS_FEISHU_PROVISION: '0' }), false);
    assert.equal(provisionSupported(), true, '总闸与能力探测无关（oracle 亦如此）');
    assert.equal(provisionStatus(101, { db: fx.db }).supported, true);
  } finally { fx.close(); }
  // 即便 fetch 被拿掉，判定也必须是「当场读」而不是模块加载期缓存
  const saved = globalThis.fetch;
  try {
    delete globalThis.fetch;
    assert.equal(provisionSupported(), false, 'fetch 缺失 ⇒ 能力不成立');
  } finally { globalThis.fetch = saved; }
  assert.equal(provisionSupported(), true, '还原后恢复');
});

test('provisionStart 闸门顺序（lib 直调）：总闸 → 能力 → 进行中未超 TTL → 已配置需 force', async () => {
  const fx = setup('prov-gates');
  try {
    const env = {};
    const opts = { db: fx.db, env };
    // ① 总闸关：压过一切（哪怕有凭据）
    setCreds(fx, 101);
    assert.deepEqual(await provisionStart(101, false, { db: fx.db, env: { TS_FEISHU_PROVISION: '0' } }),
      { ok: false, state: 'idle', url: '', error: OFF });
    // ② 能力不可用：压过「已配置需 force」（把 fetch 拿掉 ⇒ provisionSupported() = false）
    const savedFetch = globalThis.fetch;
    try {
      delete globalThis.fetch;
      assert.equal(provisionSupported(), false);
      assert.deepEqual(await provisionStart(101, false, opts),
        { ok: false, state: 'idle', url: '', error: SDK_MIN });
      assert.deepEqual(await provisionStart(101, true, opts),
        { ok: false, state: 'idle', url: '', error: SDK_MIN });
    } finally { globalThis.fetch = savedFetch; }
    // ③④ 能力可用 ⇒ 两道闸**可达**：先撞「已配置需 force」，force 才放行。
    // 桩**挂起**（不立刻返回）⇒ 起完流程后状态稳定停在 waiting、url 保持桩给的值，
    // 可以确定性地验第 ③ 道闸（否则 worker 会在断言前把状态推到 failed）。
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = stubRegisterApp(async (onQr) => {
      onQr({ url: 'https://accounts.feishu.cn/qr/one', expire_in: 600 });
      await gate;
      return null;
    });
    try {
      assert.deepEqual(await provisionStart(101, false, opts),
        { ok: false, state: 'idle', url: '',
          error: '已配置应用 app_ok；如需换应用请确认后重试' });
      assert.deepEqual(calls.length, 0, '被 force 闸拦下时不许起流程');
      const forced = await provisionStart(101, true, opts);
      assert.deepEqual(forced, { ok: true, state: 'waiting', url: '', error: '' });
      // 返回体键序（Python dict 字面量 ok/state/url/error）
      assert.deepEqual(Object.keys(forced), ['ok', 'state', 'url', 'error']);
      await tick();                                  // 让 worker 把 on_qr 的链接落进状态
      // ③ 进行中且未超 TTL ⇒ 返回**既有**流程现状（url 是 worker 落的那个，不重复起流程）
      const again = await provisionStart(101, false, opts);
      assert.deepEqual(again,
        { ok: true, state: 'waiting', url: QR('https://accounts.feishu.cn/qr/one'), error: '' });
      assert.equal(calls.length, 1, '同一用户同时只许跑一条流程');
      release();
      await waitState(101, 'failed', opts);
    } finally { unhookRegisterApp(); }
  } finally { _PROVISION.delete(101); fx.close(); }
});

test('TTL 过期：status 对外按 failed 呈现，且 start 可重新发起（走 ⑤ 而不是被 ③ 拦）', async () => {
  const fx = setup('prov-ttl');
  try {
    const opts = { db: fx.db, env: {} };
    const calls = stubRegisterApp(async () => { await tick(); return { client_id: 'c', client_secret: 's' }; });
    try {
      await provisionStart(101, false, opts);
      // 把已登记流程的时间戳推到 TTL 之外（`started_at` 是哨兵值，不依赖等 10 分钟）
      _PROVISION.get(101).started_at = Date.now() / 1000 - PROVISION_TTL - 1;
      const st = provisionStatus(101, opts);
      assert.equal(st.state, 'failed');
      assert.equal(st.error, '确认链接已超时（10 分钟有效），可重新发起');
      assert.ok(st.age_s > PROVISION_TTL, `age_s 应超 TTL，实际 ${st.age_s}`);
      // 第 ③ 道闸不再拦（状态已不是 waiting）⇒ 走到 ⑤ 重新起一条
      const out = await provisionStart(101, false, opts);
      assert.deepEqual(out, { ok: true, state: 'waiting', url: '', error: '' });
      assert.equal(calls.length, 2, '过期后允许重新发起');
      await waitState(101, 'success', opts);
    } finally { unhookRegisterApp(); }
  } finally { _PROVISION.delete(101); fx.close(); }
});

test('worker 取消：cancel 事件置位、状态转 cancelled，且 worker **不**把状态改回 failed', async () => {
  const fx = setup('prov-cancel-worker');
  try {
    const opts = { db: fx.db, env: {} };
    let observedCancel = false;
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = stubRegisterApp(async (onQr, onStatus, cancel) => {
      onQr({ url: 'https://accounts.feishu.cn/qr/x', expire_in: 600 });
      await gate;
      // oracle 的 stub 在收到 cancel 后抛 `RuntimeError("用户取消")`（tests:284-285）
      observedCancel = cancel.isSet();
      if (observedCancel) throw new Error('用户取消');
      return { client_id: 'c', client_secret: 's' };
    });
    try {
      await provisionStart(101, false, opts);
      const qr = provisionStatus(101, opts);
      assert.equal(qr.state, 'waiting');
      assert.deepEqual(qr.url, QR('https://accounts.feishu.cn/qr/x'),
        'on_qr 落的链接要被 status 读到（**oracle 口径**：存的是 SDK 回调的那个 dict，见文件头注释）');
      assert.equal(qr.age_s, 0);
      // 第 ⑤ 步：worker 是 fire-and-forget ⇒ `start` 已经返回，SDK 侧还没结束
      assert.equal(calls.length, 1);
      const cancelled = provisionCancel(101, opts);
      assert.deepEqual(cancelled, { ok: true, state: 'cancelled', error: '' });
      assert.equal(calls[0].cancel.isSet(), true, '取消事件必须被置位');
      release();
      await tick();
      assert.equal(observedCancel, true);
      await waitState(101, 'cancelled', opts);
      // 让 worker 彻底跑完，再确认状态**没有**被覆写成 failed
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      const after = provisionStatus(101, opts);
      assert.equal(after.state, 'cancelled', '取消后 worker 不许把状态改成 failed');
      assert.equal(after.error, '');
    } finally { unhookRegisterApp(); }
  } finally { _PROVISION.delete(101); fx.close(); }
});

/**
 * `on_qr` 收到的那个 dict（oracle 口径：`st["url"]` 原样存它 —— 见
 * `tests/test_feishu_provision_url_shape.py`，那份用例驱动**真 oracle** 钉死这条）。
 * 期望值不写字符串：`url` 字段在响应里是**对象**，写字符串就等于把首版的无意偏离固化成期望。
 */
const QR = (url, expireIn = 600) => ({ url, expire_in: expireIn });

test('worker 域切换：`on_status_change` 收到 domain_switched ⇒ 作废旧链接（st.url 清空）', async () => {
  const fx = setup('prov-domain-switch');
  try {
    const opts = { db: fx.db, env: {} };
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = stubRegisterApp(async (onQr, onStatus) => {
      onQr({ url: 'https://accounts.feishu.cn/qr/old', expire_in: 600 });
      await gate;
      onStatus({ status: 'domain_switched' });        // 飞书/Lark 切域 ⇒ 旧 URL 失效
      onQr({ url: 'https://accounts.larksuite.com/qr/new', expire_in: 600 });
      return { client_id: 'c', client_secret: 's' };
    });
    try {
      await provisionStart(101, false, opts);
      assert.deepEqual(provisionStatus(101, opts).url, QR('https://accounts.feishu.cn/qr/old'));
      release();
      await waitState(101, 'success', opts);
      assert.equal(calls.length, 1);
      // 最终留下的是**新**链接
      assert.deepEqual(provisionStatus(101, opts).url, QR('https://accounts.larksuite.com/qr/new'));
    } finally { unhookRegisterApp(); }
  } finally { _PROVISION.delete(101); fx.close(); }
});

test('provisionStatus：`app_id` 回落用户配置的 app_id（只填 app_id 也算「已接入」）', async () => {
  const fx = setup('prov-fallback');
  try {
    assert.equal(provisionStatus(101, { db: fx.db }).app_id, '');
    // 只写 app_id、不写 secret：`app_config` 仍为 None（apply/start 的闸门按两件齐备），
    // 但 `provision_status.app_id` 回落只要求 app_id 非空（feishu.py:3000-3002）
    fx.db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?,?)')
      .run(101, JSON.stringify({ app_id: 'only-id' }));
    const st = provisionStatus(101, { db: fx.db });
    assert.equal(st.app_id, 'only-id');
    assert.equal((await provisionApply(101, { db: fx.db })).error, NO_CREDS);
  } finally { fx.close(); }
});

test('worker 旧流程不许污染新流程（TTL 过期后重发时并发收尾的真实竞态）', async () => {
  const fx = setup('prov-stale');
  const uid = 101;
  const opts = { db: fx.db, env: {} };
  const gates = [];
  const releases = [];
  let n = 0;
  const calls = stubRegisterApp(async (onQr, onStatus, cancel) => {
    n += 1;
    const mine = n;
    gates.push(new Promise((resolve) => { releases.push(resolve); }));
    onQr({ url: `https://accounts.feishu.cn/qr/${mine}`, expire_in: 600 });
    await gates[mine - 1];
    return { client_id: `cli_${mine}`, client_secret: `sec_${mine}` };
  });
  try {
    // 第一条：挂住不收尾
    await provisionStart(uid, false, opts);
    await tick();
    assert.equal(calls.length, 1);
    const oldFlow = _PROVISION.get(uid);
    assert.deepEqual(provisionStatus(uid, opts).url, QR('https://accounts.feishu.cn/qr/1'));
    // 模拟 TTL 过期后用户重新发起（`provision_start` 覆盖 `_PROVISION[uid]`）
    oldFlow.started_at = Date.now() / 1000 - PROVISION_TTL - 1;
    const restart = await provisionStart(uid, false, opts);
    assert.deepEqual(restart, { ok: true, state: 'waiting', url: '', error: '' });
    assert.equal(calls.length, 2, '重新发起必须真起第二条流程');
    assert.notEqual(_PROVISION.get(uid), oldFlow, '新流程必须是新的状态对象');
    await tick();
    assert.deepEqual(provisionStatus(uid, opts).url, QR('https://accounts.feishu.cn/qr/2'));
    // 旧流程此刻才收尾（拿到自己的凭据）——它**不许**碰新流程的状态
    releases[0]();
    await tick();
    await tick();
    const st = provisionStatus(uid, opts);
    assert.deepEqual(st.url, QR('https://accounts.feishu.cn/qr/2'), '旧 worker 不许改新流程的 url');
    assert.equal(st.state, 'waiting', '旧 worker 不许把新流程改成 success/failed');
    assert.equal(st.app_id, '', '旧 worker 不许把旧 app_id 写进新流程');
    // 旧流程的凭据也不许落库（它已经不是当前流程了）
    const cfg = fx.db.prepare('SELECT json FROM feishu_user_cfgs WHERE user_id=?').get(uid);
    assert.equal(cfg, undefined, '旧流程的凭据不许落库');
    // 新流程自己收尾 ⇒ 正常落库
    releases[1]();
    await waitState(uid, 'success', opts);
    assert.equal(provisionStatus(uid, opts).app_id, 'cli_2');
    assert.equal(JSON.parse(fx.db.prepare('SELECT json FROM feishu_user_cfgs WHERE user_id=?')
      .get(uid).json).app_id, 'cli_2');
  } finally { _PROVISION.delete(uid); unhookRegisterApp(); fx.close(); }
});

test('worker 成功路径：凭据落库（保留既有字段）+ 起长连接 + 自动 apply 的 steps 落状态', async () => {
  const fx = setup('prov-success');
  const uid = 101;
  const opts = { db: fx.db, env: {} };
  // 既有配置里有 enabled / push_enabled / default_webhook / base_url：**必须被保留**，
  // 只换 app_id / app_secret（oracle `cfg = dict(user_config(user_id) or {})` 的合并语义，:3075-3078）
  fx.db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?,?)')
    .run(uid, JSON.stringify({ enabled: 0, push_enabled: 1, default_webhook: 'https://hook/x',
      default_secret: 's', base_url: '', app_id: '', app_secret: '' }));
  // 清 token 缓存那一步（`_TOKEN_CACHE.pop(app_id, None)`，feishu.py:3079）要能观测：
  // 先塞一条同 app_id 的假缓存，跑完必须没了。
  _TOKEN_CACHE.set('cli_new', { token: 'stale', expire: Date.now() / 1000 + 3600 });
  // 桩里把 addons 记下来：`_provision_worker` 传的是 `_provision_addons()`(feishu.py:2972-2982)
  const calls = stubRegisterApp(async (onQr, onStatus, cancel, addons) => {
    onQr({ url: 'https://accounts.feishu.cn/qr/ok', expire_in: 600 });
    return { client_id: 'cli_new', client_secret: 'sec-new' };
  });
  // 入站长连接的注册表是**模块级**、跨用例共享的：前面几档（TTL / 闸门顺序）已经把 uid=101
  // 的 runner 登记过了 ⇒ 不先清掉，`startInboundFor` 会走「幂等短路」直接返回 false，
  // 本档就测不到「worker 到底有没有起长连接」。先清，才测得到真拉起。
  clearInboundThread(uid);
  // 拦出站长连接的构造点（`feishu_ws.js:829` 的 `new WebSocket(connUrl)`）：
  // ① 不真建连；② **故意不派发任何事件** —— `_connect()` 会一直挂在 `open`/`error` 那个
  // Promise 上，于是 `wsRun` 不 settle ⇒ `makeInboundRunner` 的 `alive` 保持 `true`。
  // 这样 `inbound_ws.thread` 就从「真实 ws 秒失败 ⇒ 时变」变成**确定性读数**（拿到证据：
  // 变异「去掉 inboundStartFor」会让这条断言变红）。
  const wsAttempts = [];
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) { wsAttempts.push(String(url)); }
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
  // 还要让出站长连接的**建连前那一步**（`POST /callback/ws/endpoint` 换 URL）成功：
  // 沙箱里这个请求拿不到可用 URL，`_getConnUrl()` 会先抛 ⇒ 永远走不到 `new WebSocket`，
  // 「起没起长连接」就观测不到。只拦这一个端点，其余（token / application REST）原样放行。
  const realFetch = globalThis.fetch;
  const WS_ENDPOINT = '/callback/ws/endpoint';
  const TOKEN_ENDPOINT = '/open-apis/auth/v3/tenant_access_token/internal';
  const CONN_URL = 'wss://fake.example/connect?device_id=d-1&service_id=1';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(WS_ENDPOINT)) {
      return new Response(JSON.stringify({ code: 0, data: { URL: CONN_URL } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // token 端点也钉死：`provisionApply` 会拿假凭据去真飞书换 token，
    // 沙箱里那一步可能挂满 `TOKEN_TIMEOUT_S` ⇒ 本档从「毫秒级」变成「分钟级」。
    // 回一个真实的业务错体（code/msg 与飞书一致）⇒ 走 `FeishuRestError` 那条路，
    // worker 照样落「应用已创建，但配置补齐未完成：…」，语义不变且完全离线。
    if (url.includes(TOKEN_ENDPOINT)) {
      return new Response(JSON.stringify({ code: 10003, msg: 'invalid param' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };
  try {
    await provisionStart(uid, false, opts);
    const st = await waitState(uid, 'success', opts);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].addons, {
      preset: false,
      scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly',
        'im:message:send_as_bot', 'application:app_slash_command:read',
        'application:app_slash_command:write', 'im:message:readonly'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    }, 'addons 的键序与内容 = `_provision_addons()`');
    // 状态：`app_id` = 新应用、url = 桩落的链接
    assert.equal(st.app_id, 'cli_new');
    assert.deepEqual(st.url, QR('https://accounts.feishu.cn/qr/ok'));
    // token 缓存必须被清（新凭据不许复用旧 token）
    assert.equal(_TOKEN_CACHE.has('cli_new'), false, '新凭据要清同 app_id 的旧 token 缓存');
    // 起长连接（`start_inbound_for(user_id)`，:3082）的证据：
    // ① `inbound_ws.thread` —— 上面的 WebSocket 替身不派发事件 ⇒ `alive` 恒 true ⇒ 确定性；
    // ② 连接地址真的被构造过（`feishu_ws.js:829` 是唯一构造点）。
    // 这两条让「worker 忘了起长连接」这类变异必然变红（见报告「变异 11」）。
    assert.equal(inboundStatus(uid, opts).thread, true,
      'worker 必须把长连接拉起来（`inbound_ws` 的线程态）');
    assert.ok(wsAttempts.length >= 1, `长连接构造次数=${wsAttempts.length}`);
    assert.equal(wsAttempts[0].startsWith('wss://'), true, `连接地址形态可疑：${wsAttempts[0]}`);
    // steps 落状态：`_provision_worker` 把 `applied["steps"]` 原样落进状态（:3087）
    assert.ok(Array.isArray(st.steps) && st.steps.length >= 1, 'steps 必须如实回传');
    for (const item of st.steps) {
      assert.deepEqual(Object.keys(item), ['key', 'label', 'ok', 'detail']);
      assert.equal(typeof item.ok, 'boolean');
    }
    // 凭据落库：只换 app_id / app_secret，其余字段逐字保留
    const saved = JSON.parse(fx.db.prepare('SELECT json FROM feishu_user_cfgs WHERE user_id=?')
      .get(uid).json);
    assert.equal(saved.app_id, 'cli_new');
    assert.equal(saved.app_secret, 'sec-new');
    assert.equal(saved.enabled, 0);
    assert.equal(saved.push_enabled, 1);
    assert.equal(saved.default_webhook, 'https://hook/x');
    assert.equal(saved.default_secret, 's');
    assert.equal(saved.base_url, '');
    // 脱网环境：假凭据过不了真飞书 ⇒ 这一段通常落「配置补齐未完成」告警（另一档专门钉逐字文案）；
    // 真联得上时 error 应为空串。两种都自洽，故只断言取值域。
    assert.ok(st.error === '' || st.error.startsWith('应用已创建，但配置补齐未完成：'),
      `error 取值域不对：${JSON.stringify(st.error)}`);
  } finally {
    clearInboundThread(uid);
    globalThis.WebSocket = realWebSocket;
    globalThis.fetch = realFetch;
    _TOKEN_CACHE.delete('cli_new');
    _PROVISION.delete(uid); unhookRegisterApp(); fx.close();
  }
});

test('worker 失败档：凭据没回来 ⇒ 状态 failed + 逐字文案（不 unhandled rejection）', async () => {
  const fx = setup('prov-nocreds-worker');
  const uid = 101;
  const opts = { db: fx.db, env: {} };
  const stubs = [
    ['缺 secret', async () => ({ client_id: 'cli_only' })],
    ['缺 client_id', async () => ({ client_secret: 'sec_only' })],
    ['空对象', async () => ({})],
    ['null（oracle 的 `(out or {})` 口径）', async () => null],
    ['undefined', async () => undefined],
    ['空串凭据（假值）', async () => ({ client_id: '', client_secret: '' })],
  ];
  try {
    for (const [label, impl] of stubs) {
      _PROVISION.delete(uid);
      stubRegisterApp(impl);
      await provisionStart(uid, false, opts);
      const st = await waitState(uid, 'failed', opts);
      assert.equal(st.error, '扫码流程未返回应用凭据（可能超时或未确认），可重新发起', label);
      assert.equal(st.app_id, '', `${label}：没拿到凭据就不许写 app_id`);
    }
  } finally { _PROVISION.delete(uid); unhookRegisterApp(); fx.close(); }
});

test('worker 异常档：`扫码创建失败: {str(e)}`（含 RegisterAppError 的元组 str 口径）', async () => {
  const fx = setup('prov-exc-worker');
  const uid = 101;
  const opts = { db: fx.db, env: {} };
  // oracle 测试 `_RegStub(exc=RuntimeError("access_denied 用户拒绝"))` ⇒ `"access_denied" in st["error"]`
  // （tests/test_feishu_provision.py:380-388）
  const plain = new Error('access_denied 用户拒绝');
  const cases = [
    ['RuntimeError 形态', plain, '扫码创建失败: access_denied 用户拒绝'],
    ['TypeError 形态', new TypeError('bad shape'), '扫码创建失败: bad shape'],
    // `RegisterAppError("access_denied", "用户拒绝")`：Python `str(e)` 走「args 长度 ≠ 1」分支
    // ⇒ **元组 repr**（见 `feishu_provision.js:pyErrStr`）。这条是两侧逐字对齐的关键。
    ['RegisterAppError', new AppAccessDeniedError('access_denied', '用户拒绝'),
      "扫码创建失败: ('access_denied', '用户拒绝')"],
    ['RegisterAppError 带单引号', new RegisterAppError('weird', "it's odd"),
      '扫码创建失败: (\'weird\', "it\'s odd")'],
    ['无 code 的普通异常', new Error('boom'), '扫码创建失败: boom'],
  ];
  try {
    for (const [label, error, expected] of cases) {
      _PROVISION.delete(uid);
      stubRegisterApp(async () => { throw error; });
      await provisionStart(uid, false, opts);
      const st = await waitState(uid, 'failed', opts);
      assert.equal(st.error, expected, label);
    }
  } finally { _PROVISION.delete(uid); unhookRegisterApp(); fx.close(); }
});

test('worker 部分成功：应用建好了但 `apply` 未完成 ⇒ success + **逐字**告警文案', async () => {
  const fx = setup('prov-partial');
  const uid = 101;
  const opts = { db: fx.db, env: {} };
  stubRegisterApp(async () => ({ client_id: 'cli_new', client_secret: 'sec-new' }));
  // 把 token 端点钉成确定的业务错 ⇒ `provisionApply` 第 ① 步（ability）必失败，
  // 于是「部分成功」那份 error 文案的**后半段**（`applied["error"]`）也成了确定值，
  // 可以逐字断言（否则只断言前缀 ⇒ 「拼接错内容」这类变异测不出来）。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/open-apis/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 10003, msg: 'invalid param' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };
  try {
    await provisionStart(uid, false, opts);
    const st = await waitState(uid, 'success', opts);
    // oracle:3089-3090  `"error": "" if applied.get("ok") else f"应用已创建，但配置补齐未完成：{applied.get('error')}"`
    // `applied["error"]` 即 `_apply_error`/`str(e)` 的产物 ⇒ 这里是 `FeishuRestError` 的文案。
    assert.equal(st.error,
      '应用已创建，但配置补齐未完成：token 获取失败 code=10003 invalid param');
    assert.equal(st.app_id, 'cli_new');
    assert.equal(st.state, 'success');
    // steps 如实回传（第 ① 步就失败 ⇒ 只有一条，`ok=false`，detail 是业务码文案）
    assert.deepEqual(st.steps, [{ key: 'ability', label: '开启机器人能力', ok: false,
      detail: 'token 获取失败 code=10003 invalid param' }]);
  } finally { globalThis.fetch = realFetch; _PROVISION.delete(uid); unhookRegisterApp(); fx.close(); }
});

test('provisionCancel 无流程：键序 ok/state/error、无 url；且**不改** `_PROVISION` 状态', () => {
  const fx = setup('prov-cancel-lib');
  try {
    const out = provisionCancel(999, { db: fx.db });
    assert.deepEqual(out, { ok: false, state: 'idle', error: '当前没有进行中的扫码流程' });
    assert.deepEqual(Object.keys(out), ['ok', 'state', 'error']);
    // 取消之后再读状态：仍是 idle（`state` 只前进不回退，没起过流程就不会变）
    assert.equal(provisionStatus(999, { db: fx.db }).state, 'idle');
  } finally { fx.close(); }
});

test('provisionPublish 无凭据 / 总闸关：`version` 与 `version_id` 恒空串（与 apply 的键序不同）', async () => {
  const fx = setup('prov-publish-lib');
  try {
    const a = await provisionPublish(101, { db: fx.db });
    assert.deepEqual(a, { ok: false, version: '', version_id: '',
      need_patch_scope: false, error: NO_CREDS });
    assert.deepEqual(Object.keys(a),
      ['ok', 'version', 'version_id', 'need_patch_scope', 'error']);
    const b = await provisionPublish(101, { db: fx.db, env: { TS_FEISHU_PROVISION: '0' } });
    assert.equal(b.error, OFF);
    setCreds(fx, 101);
    const c = await provisionPublish(101, { db: fx.db, env: { TS_FEISHU_PROVISION: '0' } });
    assert.equal(c.error, OFF, '总闸先于 app_config：有凭据也回总闸文案');
  } finally { fx.close(); }
});

test('_nextVersion：整数元组比较（`1.0.10 > 1.0.3`，字符串序会得 1.0.4）', () => {
  assert.equal(_nextVersion([]), '1.0.0');
  assert.equal(_nextVersion(null), '1.0.0');
  assert.equal(_nextVersion([{ version: '1.0.3' }, { version: '1.0.10' }]), '1.0.11');
  assert.equal(_nextVersion([{ version: '2.0.0' }, { version: 'x.y.z' }]), '2.0.1');
  // 非三段 / 非数字 / 空 / 缺 version 键 / 非 dict 项一律 `continue`（一个都不算）
  assert.equal(_nextVersion([{ version: 'bad' }, { version: '1.0' }, { version: '' },
    {}, { version: '1.2.3.4' }, null, 'x']), '1.0.0');
  // 先 `strip()` 再解析（`str(v or "").strip()` 口径）
  assert.equal(_nextVersion([{ version: ' 1.9.9 ' }]), '1.9.10');
  // `int()` 口径：负段位也能解析，且参与元组比较（(2,0,-1) > (1,9,9)）
  assert.equal(_nextVersion([{ version: '1.9.9' }, { version: '2.0.-1' }]), '2.0.0');
  // 版本值是非字符串（数字/布尔/None）也走 `str()`：`1` ⇒ 段数 1 ⇒ 忽略；`1.2.3` 数字形态取不到
  assert.equal(_nextVersion([{ version: 1 }, { version: true }, { version: null }]), '1.0.0');
});

test('_docItem：五项固定键序 key/label/state/detail/hint（hint 缺省空串）', () => {
  assert.deepEqual(_docItem('k', 'l', 'ok', 'd'), { key: 'k', label: 'l', state: 'ok',
    detail: 'd', hint: '' });
  assert.deepEqual(Object.keys(_docItem('k', 'l', 'ok', 'd')), ['key', 'label', 'state',
    'detail', 'hint']);
});

// --------------------------------------------------------------------------
// ④ doctor：八项 + summary（无凭据档是唯一两侧确定可比的档）
// --------------------------------------------------------------------------

test('POST /api/me/feishu/doctor：无凭据档八项 + summary 计数（键序与值逐项钉死）', async () => {
  const fx = setup('doctor');
  try {
    await expectBody(fx, 'POST', D, { body: {} }, 200, r0text());
  } finally { fx.close(); }
});

/** doctor 无凭据档的期望正文（由 oracle `feishu.py:2776-2925` 的八项字面量拼出） */
function r0text() {
  const items = [
    ['creds', '应用凭据（App ID / App Secret）', 'fail', '未配置',
      '在「飞书机器人配置」填入 App ID 与 App Secret 并保存'],
    ['token', '凭据有效性（tenant_access_token）', 'skip', '凭据未配置，跳过', ''],
    ['bot', '机器人能力与启用状态', 'skip', '凭据未通过，跳过', ''],
    ['inbound_ws', '入站长连接（长连接）', 'skip', '凭据未配置，跳过', ''],
    ['inbound_event', '事件订阅（真实收到过消息）', 'skip', '凭据未配置，跳过', ''],
    ['slash_scope', '斜杠指令权限', 'skip', '凭据未通过，跳过', ''],
    ['send_scope', '发消息权限（可选探测）', 'skip', '未绑定飞书账号，跳过',
      '先在下方生成绑定码并在飞书里发「绑定 <码>」'],
    ['webhook', '默认推送 Webhook', 'warn', '未配置（不影响机器人对话，只影响阻塞事件推送）',
      '群设置 → 群机器人 → 添加自定义机器人，把 Webhook 填到设置页'],
  ];
  const body = items.map(([key, label, state, detail, hint]) =>
    `{"key": ${JSON.stringify(key)}, "label": ${JSON.stringify(label)}, "state": `
    + `${JSON.stringify(state)}, "detail": ${JSON.stringify(detail)}, "hint": `
    + `${JSON.stringify(hint)}}`).join(', ');
  return `{"items": [${body}], "summary": {"ok": 0, "fail": 1, "warn": 1, "skip": 6}}`;
}

test('doctor 无凭据档：`send_probe` 取值不可观测（true / "0" / 缺键三者逐字节相同）', async () => {
  const fx = setup('doctor-probe');
  try {
    const base = r0text();
    await expectBody(fx, 'POST', D, { body: {} }, 200, base);
    await expectBody(fx, 'POST', D, { body: { send_probe: true } }, 200, base);
    // `bool("0")` 为真：与不传等价（无凭据时 send_scope 走「未绑定…跳过」，频控分支不可达）
    await expectBody(fx, 'POST', D, { body: { send_probe: '0' } }, 200, base);
    await expectBody(fx, 'POST', D, { body: { send_probe: 0 } }, 200, base);
    const parsed = (await call(fx, 'POST', D, { body: {} })).json();
    assert.deepEqual(Object.keys(parsed), ['items', 'summary']);
    assert.deepEqual(Object.keys(parsed.items[0]), ['key', 'label', 'state', 'detail', 'hint']);
    assert.deepEqual(Object.keys(parsed.summary), ['ok', 'fail', 'warn', 'skip']);
    assert.deepEqual(parsed.items.map((it) => it.key),
      ['creds', 'token', 'bot', 'inbound_ws', 'inbound_event', 'slash_scope', 'send_scope',
        'webhook']);
  } finally { fx.close(); }
});

test('doctor lib 直调：与路由层同形（`options` 透传 db；无凭据时零网络）', async () => {
  const fx = setup('doctor-lib');
  try {
    const out = await doctor(101, false, { db: fx.db });
    assert.equal(out.items.length, 8);
    assert.deepEqual(out.summary, { ok: 0, fail: 1, warn: 1, skip: 6 });
  } finally { fx.close(); }
});

// --------------------------------------------------------------------------
// ④b doctor 的 `inbound_ws` 第三档（M10，2026-10-17）：线程绑的应用 ≠ 配置的应用 ⇒ warn
//
// 实测踩过的坑：面板显示「已接入应用 X」、本项也绿，但消息仍打到旧机器人（换凭据必须
// 重启站点，而 `start_inbound_for` 见线程活着就短路、lark SDK 无干净停止）。
// 纯函数测：文案与 oracle `feishu.doctor` 的同名分支**逐字一致**（pytest 侧钉同一组字面量）。
// --------------------------------------------------------------------------

test('inboundWsItem：换凭据未重启 ⇒ warn，文案与 oracle 逐字一致', () => {
  assert.deepEqual(inboundWsItem({ thread: true, app_id: 'cli_old' }, { app_id: 'cli_new' }),
    _docItem('inbound_ws', '入站长连接（长连接）', 'warn',
      '连接线程仍绑在 cli_old（配置已改为 cli_new）',
      '在机器人私聊发「接入」点「换用新应用」即可免重启切换；仍不生效再重启站点'));
  // 正常档不受影响
  assert.deepEqual(inboundWsItem({ thread: true, app_id: 'cli_x' }, { app_id: 'cli_x' }),
    _docItem('inbound_ws', '入站长连接（长连接）', 'ok', '连接线程运行中', ''));
  // 线程没跑 ⇒ 仍是 fail（新档只在「线程活着 + 两侧 app 都有值 + 不相等」时命中）
  assert.equal(inboundWsItem({ thread: false, app_id: 'cli_old' }, { app_id: 'cli_new' }).state,
    'fail');
  // 空值不误报（老替身没有 app_id；也不能因为缺字段就报警）
  assert.equal(inboundWsItem({ thread: true, app_id: '' }, { app_id: 'cli_new' }).state, 'ok');
  assert.equal(inboundWsItem({ thread: true, app_id: 'cli_old' }, {}).state, 'ok');
  // Python 真值口径：thread 用 pyTruthy 收口（`thread: 0/''` 都按没跑）
  assert.equal(inboundWsItem({ thread: 0, app_id: 'cli_old' }, { app_id: 'cli_new' }).state,
    'fail');
});

test('inboundThreadAppId：登记线程时带上的 app_id 可回读，注销后清空；inboundStatus 形状不变', () => {
  const fx = setup('inbound-app-id');
  try {
    setInboundThread(7, { isAlive: () => true }, 'cli_old');
    try {
      const st = inboundStatus(7, { db: fx.db });
      assert.equal(st.thread, true);
      // **形状契约**：`inboundStatus` 是 `/api/me/feishu-cfg` 的响应子对象 ⇒ 只许两键。
      // 「线程绑的 app」走独立访问口（加进这里就是改对外契约，本文件其余形状判据会红）。
      assert.deepEqual(Object.keys(st), ['configured', 'thread']);
      assert.equal(inboundThreadAppId(7), 'cli_old');
    } finally { clearInboundThread(7); }
    assert.equal(inboundThreadAppId(7), '');
  } finally { fx.close(); }
});

// --------------------------------------------------------------------------
// ⑤ slash-commands 族（路由层接线：缺省 action / 追加两键的键序 / 400 文案）
// --------------------------------------------------------------------------

test('GET /api/me/feishu/slash-commands：无凭据档（desired 17 条 + 引导文案），键序 configured/desired/remote/extra/need_scope/error', async () => {
  const fx = setup('slash-get');
  try {
    const r = await expectDesiredShape(fx);
    assert.equal(r.readState.ended, false, 'GET 读了请求体');
  } finally { fx.close(); }
});

/** GET slash 的期望：走路由 + 直调库函数双比（值来自 `feishu.slash_status`） */
async function expectDesiredShape(fx) {
  const r = await call(fx, 'GET', S, {});
  assert.equal(r.status, 200);
  const body = r.json();
  assert.deepEqual(Object.keys(body),
    ['configured', 'desired', 'remote', 'extra', 'need_scope', 'error']);
  assert.equal(body.configured, false);
  assert.deepEqual(body.desired, SLASH_COMMANDS.map(([command, description, icon]) =>
    ({ command, description, icon })));
  assert.equal(body.desired.length, 17);
  assert.deepEqual(body.remote, []);
  assert.deepEqual(body.extra, []);
  assert.equal(body.need_scope, false);
  assert.equal(body.error, '未配置应用凭据（App ID/App Secret），先在上方「飞书机器人配置」保存后重试');
  return r;
}

test('POST /api/me/feishu/slash-commands：**缺 action 缺省 sync**，且 sync/clear 回包逐字节相同（+ 追加 card_sent/card_error）', async () => {
  const fx = setup('slash-default');
  try {
    const expected = '{"ok": false, "need_scope": false,'
      + ' "error": "未配置应用凭据（App ID/App Secret）", "card_sent": false, "card_error": ""}';
    const a = await expectBody(fx, 'POST', S, { body: {} }, 200, expected);
    const b = await expectBody(fx, 'POST', S, { body: { action: 'sync' } }, 200, expected);
    const c = await expectBody(fx, 'POST', S, { body: { action: 'clear' } }, 200, expected);
    // 追加两键 ⇒ 键序 ok/need_scope/error/card_sent/card_error（Python dict 插入序）
    assert.deepEqual(Object.keys(a.json()),
      ['ok', 'need_scope', 'error', 'card_sent', 'card_error']);
    assert.equal(b.text(), c.text(), 'oracle 实测：失败/短路档 sync 与 clear 回包逐字节相同');
  } finally { fx.close(); }
});

test('POST /api/me/feishu/slash-commands notify：键序 ok/card_sent/card_error（与 sync/clear **不同**）', async () => {
  const fx = setup('slash-notify');
  try {
    const r = await expectBody(fx, 'POST', S, { body: { action: 'notify' } }, 200,
      '{"ok": false, "card_sent": false, "card_error": "未配置应用凭据（App ID/App Secret），'
      + '先保存配置再发卡片"}');
    assert.deepEqual(Object.keys(r.json()), ['ok', 'card_sent', 'card_error']);
  } finally { fx.close(); }
});

test('POST /api/me/feishu/slash-commands：非法 action ⇒ 400 带空格体（大小写敏感 / 容器 / 数字）', async () => {
  const fx = setup('slash-400');
  const expected = '{"error": "action 仅支持 sync / clear / notify"}';
  try {
    await expectBody(fx, 'POST', S, { body: { action: 'Sync' } }, 400, expected);
    await expectBody(fx, 'POST', S, { body: { action: ['sync'] } }, 400, expected);
    await expectBody(fx, 'POST', S, { body: { action: 1 } }, 400, expected);
    await expectBody(fx, 'POST', S, { body: { action: true } }, 400, expected);
    // 假值走缺省 sync（`or` 口径）：0 / false / null / 空串 / 空表 全部当 sync，200 而不是 400
    for (const falsy of [0, false, null, '', []]) {
      const r = await call(fx, 'POST', S, { body: { action: falsy } });
      assert.equal(r.status, 200, `action=${JSON.stringify(falsy)} 应走缺省 sync`);
    }
  } finally { fx.close(); }
});

// --------------------------------------------------------------------------
// ④ 重连入站（M11.1 设置页面板按钮）：`POST /api/me/feishu/reconnect`
// --------------------------------------------------------------------------
//
// 本档只打**无凭据**的确定性路径：`restartInboundFor` = 停（注册表没有 runner ⇒ false）→
// 起（`app_config` 为 None ⇒ 打一行 stderr 后 false）——零网络、零线程。**有凭据时真停旧连接
// 再用新凭据起新**由 `backend/test/feishu-setup-card.test.mjs` 的 `restartInboundFor` 用例
// （假 ws 客户端 + 真 stopInboundFor）与 `feishu-inbound.test.mjs` 的注册表用例覆盖；
// 对拍侧见 `cases-http/m11_feishu_reconnect.json`（A/B 两实例都走无凭据档）。

test('POST /api/me/feishu/reconnect：无凭据档**逐字节**（键序/空格/两键 inbound）+ POST 必读体', async () => {
  const R = '/api/me/feishu/reconnect';
  const fx = setup('reconnect');
  try {
    const r = await expectBody(fx, 'POST', R, { body: {} }, 200,
      '{"ok": true, "started": false,'
      + ' "inbound": {"configured": false, "thread": false}}');
    // 两键形状契约（`inbound_status` 是 GET cfg 的响应子对象 ⇒ 加键就是对外契约变更）
    assert.deepEqual(Object.keys(r.json()), ['ok', 'started', 'inbound']);
    assert.deepEqual(Object.keys(r.json().inbound), ['configured', 'thread']);
    // 读体时机照 Python `do_POST:1048`（分派前统一读）⇒ POST 必须把体读掉
    assert.equal(r.readState.ended, true, 'POST 未读体 ⇒ 与 Python 读体时机分叉');
  } finally { fx.close(); }
});

test('POST /api/me/feishu/reconnect：幂等（重复点按钮逐字节同体）且**不写库**', async () => {
  const R = '/api/me/feishu/reconnect';
  const expected = '{"ok": true, "started": false,'
    + ' "inbound": {"configured": false, "thread": false}}';
  const fx = setup('reconnect-idem');
  try {
    await expectBody(fx, 'POST', R, { body: {} }, 200, expected);
    await expectBody(fx, 'POST', R, { body: { anything: 1 } }, 200, expected);
    // 只读动作：不建用户配置行（配置写口只有 POST|PATCH /api/me/feishu-cfg）
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM feishu_user_cfgs').get().n, 0);
  } finally { fx.close(); }
});
