/**
 * M11（2026-10-17）：飞书接入操作卡片 + 换凭据免重启（Node 侧）。
 *
 * 对拍对象：`feishu.py` 同名节（`setup_card`/`send_setup_card`/`maybe_send_switch_card`/
 * `stop_inbound_for`/`restart_inbound_for`/`_on_setup_card_action`）。本文件的判据分三层：
 *   ① **卡片 JSON 逐字段**（换应用 / 同应用 / 空态三档；mod-run 另做两侧逐字节对拍）；
 *   ② **动作分发文案与顺序**（先取码再用新应用重连；码发不出去就不动连接）；
 *   ③ **可停长连接的真机制**——用 `wsClient` 注入缝的假客户端跑真 `stopInboundFor`/
 *      `restartInboundFor`（真关连接、真等 runner 收口、真用新凭据起新连接）。
 *
 * 生产库兜底：`freshDb()` 会把进程 env 指向临时库（见 m3fixture 的★★闸★★），
 * 测试期间任何漏传 options 的调用都落临时库，结构上不可能碰生产库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './m3fixture.mjs';
import * as dbMod from '../lib/db.js';
import * as cfgMod from '../lib/feishu_cfg.js';
import * as inbound from '../lib/feishu_inbound.js';
import { FeishuRestError } from '../lib/feishu_rest.js';

const CFG_OLD = Object.freeze({ app_id: 'cli_old', app_secret: 'sec_old' });
const CFG_NEW = Object.freeze({ app_id: 'cli_new', app_secret: 'sec_new' });
const BOUND = Object.freeze({ open_id: 'ou_1', user_id: 1 });

/** 建临时库夹具 + 一组默认注入件（rest/provision/log 都记录实参） */
function harness(tag = 'm11') {
  const fx = freshDb(tag);
  inbound.resetSetupState();
  inbound._WS_CLIENTS.clear();
  cfgMod.clearInboundThread(1);
  cfgMod.clearInboundThread(2);
  const calls = { card: [], dm: [], reply: [], restart: [], bindcode: 0 };
  const rest = {
    async restSendCard(openId, card, cfg) { calls.card.push([openId, card, cfg]); },
    async restSendText(openId, text, cfg) { calls.dm.push([openId, text, cfg]); },
    async restReply(mid, text, cfg) { calls.reply.push([mid, text, cfg]); },
  };
  const options = {
    db: fx.db, dbPath: fx.dbPath, rest,
    log: () => {},
    env: {},
  };
  return { fx, calls, rest, options, close: () => fx.close() };
}

function setCfg(fx, cfg) {
  dbMod.setFeishuUserCfg(1, cfg, { db: fx.db });
}

function setBinding(fx, openId = 'ou_1', userId = 1) {
  dbMod.setFeishuBinding(openId, userId, 0, { db: fx.db });
}

/** 假 ws 客户端：start() 挂起到 close()，close() 立即兑现（= R1 真客户端的契约） */
class FakeWsClient {
  static instances = [];

  constructor(opts = {}) {
    this.appId = opts.appId === undefined ? '' : String(opts.appId);
    this.closed = false;
    this._resolve = null;
    FakeWsClient.instances.push(this);
  }

  start() {
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  async close() {
    this.closed = true;
    if (this._resolve !== null) { this._resolve(); this._resolve = null; }
  }
}

function fakeOptions(fx, rest, extra = {}) {
  return {
    db: fx.db, dbPath: fx.dbPath, rest, log: () => {}, env: {},
    wsClient: FakeWsClient, ...extra,
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(5);
  }
  return false;
}

// ==========================================================================
// ① 卡片 JSON（纯函数；oracle 口径转抄，逐字段）
// ==========================================================================

test('setupCard 换应用形态：整卡逐字段（状态行/说明/5 按钮/页脚）', () => {
  const card = inbound.setupCard(1, 'cli_new', 'cli_old', 'nonce1234');
  const btn = (label, action, type = 'default') => ({
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { t: 'fs', a: action, u: 1, n: 'nonce1234' } }],
  });
  assert.deepEqual(card, {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '🔁 飞书应用已变更' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown',
          content: '**当前应用**：`cli_new`\n**入站长连接**：运行中 · 绑在 `cli_old`' },
        { tag: 'markdown',
          content: '检测到应用凭据已换为 `cli_new`，但长连接还绑在旧应用 `cli_old` 上。'
            + '点「换用新应用」：我会先把新绑定码发到本会话，再用新应用重连——'
            + '之后在新机器人单聊里回复「绑定 <码>」即可。' },
        btn('🔁 换用新应用', 'switch', 'primary'),
        btn('🔑 生成绑定码', 'bindcode'),
        btn('🩺 配置自检', 'doctor'),
        btn('🧩 补齐配置', 'apply'),
        btn('🚀 提交发布', 'publish'),
        { tag: 'markdown', content: '卡片 10 分钟内有效；过期后发「接入」重新获取。' },
      ],
    },
  });
});

test('setupCard 同应用形态 + 空态兜底（未配置/未运行）', () => {
  const card = inbound.setupCard(2, 'cli_x', 'cli_x', 'n0');
  assert.deepEqual(card.header, {
    title: { tag: 'plain_text', content: '🛠 飞书接入操作' }, template: 'blue',
  });
  assert.equal(card.body.elements[0].content,
    '**当前应用**：`cli_x`\n**入站长连接**：运行中 · 绑在 `cli_x`');
  assert.equal(card.body.elements[1].content, '需要时点下面的按钮；换应用后我会自动发一张新的确认卡片。');
  assert.deepEqual(card.body.elements[2], {
    tag: 'button',
    type: 'primary',
    text: { tag: 'plain_text', content: '🔄 重连入站' },
    behaviors: [{ type: 'callback', value: { t: 'fs', a: 'restart', u: 2, n: 'n0' } }],
  });
  const empty = inbound.setupCard('9', '', '', 'nn');
  assert.equal(empty.body.elements[0].content, '**当前应用**：（未配置）\n**入站长连接**：未运行');
  assert.equal(empty.body.elements[2].behaviors[0].value.u, 9);
  assert.equal(empty.header.title.content, '🛠 飞书接入操作');
});

test('setupCard 纯函数：同入参同 JSON，用户/应用/nonce 变则对应字段变', () => {
  assert.deepEqual(inbound.setupCard(3, 'cli_a', 'cli_b', 'n1'),
    inbound.setupCard(3, 'cli_a', 'cli_b', 'n1'));
  assert.equal(inbound.setupCard(4, 'cli_a', 'cli_b', 'n1')
    .body.elements[2].behaviors[0].value.u, 4);
  assert.equal(inbound.setupCard(3, 'cli_a', 'cli_b', 'n2')
    .body.elements[2].behaviors[0].value.n, 'n2');
  assert.equal(inbound.setupCard(3, 'cli_a', 'cli_a', 'n1')
    .body.elements[2].behaviors[0].value.a, 'restart');
});

// ==========================================================================
// ② nonce（内存态 10 分钟、绑定用户）
// ==========================================================================

test('setupNonce：16 位 hex、TTL 600、绑定用户、过期项在下次生成时清掉', () => {
  inbound._SETUP_NONCES.clear();
  try {
    assert.equal(inbound.SETUP_NONCE_TTL, 600);
    const n1 = inbound.setupNonce(1);
    assert.match(n1, /^[0-9a-f]{16}$/);
    const [uid, exp] = inbound._SETUP_NONCES.get(n1);
    assert.equal(uid, 1);
    assert.ok(exp - Date.now() / 1000 > 590 && exp - Date.now() / 1000 <= 600);
    inbound._SETUP_NONCES.set(n1, [1, Date.now() / 1000 - 1]);   // 人为过期
    const n2 = inbound.setupNonce(2);
    assert.equal(inbound._SETUP_NONCES.has(n1), false);
    assert.equal(inbound._SETUP_NONCES.get(n2)[0], 2);
  } finally {
    inbound.resetSetupState();
  }
});

// ==========================================================================
// ③ 动作分发：身份 + nonce 双复核
// ==========================================================================

test('onSetupCardAction 未绑定：DM 引导 + error toast（文案与 t=sc/t=dp 同款）', async () => {
  const h = harness('m11-unbound');
  try {
    const out = await inbound.onSetupCardAction(
      'ou_x', { t: 'fs', a: 'restart', u: 1, n: 'x' }, CFG_OLD, h.options);
    assert.deepEqual(out, { toast: { type: 'error', content: '尚未绑定站点账号' } });
    assert.equal(h.calls.dm.length, 1);
    assert.match(h.calls.dm[0][1], /尚未绑定 Touchstone 账号/);
  } finally {
    h.close();
  }
});

test('onSetupCardAction 防串号 + nonce 失效/过期四档', async () => {
  const h = harness('m11-nonce');
  try {
    setBinding(h.fx);
    inbound._SETUP_NONCES.clear();
    const call = (value) => inbound.onSetupCardAction('ou_1', value, CFG_OLD, h.options);
    assert.deepEqual(await call({ t: 'fs', a: 'restart', u: 2, n: 'x' }),
      { toast: { type: 'error', content: '该卡片不属于当前账号' } });
    assert.deepEqual(await call({ t: 'fs', a: 'restart', u: 1, n: 'missing' }),
      { toast: { type: 'error', content: '卡片已失效，发「接入」重新获取' } });
    inbound._SETUP_NONCES.set('n-other', [2, Date.now() / 1000 + 600]);   // 别人名下
    assert.deepEqual(await call({ t: 'fs', a: 'restart', u: 1, n: 'n-other' }),
      { toast: { type: 'error', content: '卡片已失效，发「接入」重新获取' } });
    inbound._SETUP_NONCES.set('n-old', [1, Date.now() / 1000 - 1]);       // 过期
    assert.deepEqual(await call({ t: 'fs', a: 'restart', u: 1, n: 'n-old' }),
      { toast: { type: 'error', content: '卡片已过期，发「接入」重新获取' } });
    assert.equal(inbound._SETUP_NONCES.has('n-old'), false);
    assert.equal(h.calls.dm.length, 0);
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('生成绑定码动作：文案逐字（未绑定 / 已绑定换号两条指引）', () => {
  const h = harness('m11-bindcode');
  try {
    h.options.feishu = { makeBindCode: () => 'AB12CD' };
    const [toastOut, text] = inbound._setup_bindcode(1, h.options);
    assert.deepEqual(toastOut, { toast: { type: 'success', content: '绑定码已私聊发你' } });
    assert.equal(text, '🔑 新的绑定码：AB12CD（10 分钟内有效）\n'
      + '· 未绑定：在本机器人单聊回复「绑定 <码>」\n'
      + '· 已绑定换号：先发「解绑」，再发「绑定 <码>」');
  } finally {
    h.close();
  }
});

test('重连动作：成功/失败两条文案；凭据缺失不调重连', async () => {
  const h = harness('m11-restart-text');
  try {
    setCfg(h.fx, CFG_OLD);
    let restarts = 0;
    h.options.restart = async () => { restarts += 1; return true; };
    let out = await inbound.onSetupCardAction('ou_1',
      { t: 'fs', a: 'restart', u: 1, n: 'n' }, CFG_OLD, h.options);
    inbound._SETUP_NONCES.set('n', [1, Date.now() / 1000 + 600]);
    setBinding(h.fx);
    out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'restart', u: 1, n: 'n' },
      CFG_OLD, h.options);
    assert.deepEqual(out, { toast: { type: 'success', content: '已重连' } });
    assert.equal(restarts, 1);
    assert.equal(h.calls.dm.at(-1)[1], '🔄 已用当前应用 `cli_old` 重新建立长连接。');
    // 失败档
    h.options.restart = async () => false;
    out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'restart', u: 1, n: 'n' },
      CFG_OLD, h.options);
    assert.deepEqual(out, { toast: { type: 'error', content: '重连失败，看私聊' } });
    assert.equal(h.calls.dm.at(-1)[1],
      '❌ 重连失败：旧连接未在超时内退出，稍后再点一次；仍不行请重启站点。');
    // 凭据缺失：零重连
    restarts = 0;
    dbMod.setFeishuUserCfg(1, { app_id: '', app_secret: '' }, { db: h.fx.db });
    out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'restart', u: 1, n: 'n' },
      CFG_OLD, h.options);
    assert.equal(restarts, 0);
    assert.deepEqual(out, { toast: { type: 'error', content: '应用凭据未配置' } });
    assert.ok(h.calls.dm.at(-1)[1].startsWith('❌ 应用凭据未配置'));
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('换用新应用：先 DM 绑定码（旧应用凭据）→ 再重连；成功后不再补 DM', async () => {
  const h = harness('m11-switch-order');
  try {
    setCfg(h.fx, CFG_NEW);                 // 库里已是新应用
    setBinding(h.fx);
    inbound._SETUP_NONCES.set('n', [1, Date.now() / 1000 + 600]);
    const order = [];
    h.options.feishu = { makeBindCode: () => { order.push('code'); return 'NEW123'; } };
    h.rest.restSendText = async (openId, text, cfg) => {
      order.push('dm');
      h.calls.dm.push([openId, text, cfg]);
    };
    h.options.rest = h.rest;
    h.options.restart = async () => { order.push('restart'); return true; };
    const out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'switch', u: 1, n: 'n' },
      CFG_OLD, h.options);
    assert.deepEqual(order, ['code', 'dm', 'restart']);
    assert.deepEqual(out, { toast: { type: 'success', content: '已切换，去新机器人绑定' } });
    assert.equal(h.calls.dm.length, 1);    // 只有那条码 DM；成功档不再补 DM
    assert.deepEqual(h.calls.dm[0], ['ou_1',
      '🔁 已切换到新应用 `cli_new`。\n'
      + '**新的绑定码：NEW123**（10 分钟内有效）\n'
      + '本（旧）机器人的连接马上断开；请到新机器人单聊里回复：\n'
      + '绑定 NEW123', CFG_OLD]);
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('换用新应用：码发不出去 ⇒ 不重连（否则新旧机器人都断）', async () => {
  const h = harness('m11-switch-dmfail');
  try {
    setCfg(h.fx, CFG_NEW);
    setBinding(h.fx);
    inbound._SETUP_NONCES.set('n', [1, Date.now() / 1000 + 600]);
    let restarts = 0;
    h.options.feishu = { makeBindCode: () => 'NEW123' };
    h.rest.restSendText = async () => {
      throw new FeishuRestError('send failed code=230001', 230001);
    };
    h.options.rest = h.rest;
    h.options.restart = async () => { restarts += 1; return true; };
    const logs = [];
    const out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'switch', u: 1, n: 'n' },
      CFG_OLD, { ...h.options, log: (line) => logs.push(line) });
    assert.equal(restarts, 0);
    assert.deepEqual(out, { toast: { type: 'error', content: '绑定码发送失败' } });
    // 说明 DM 也走同一条（坏掉的）旧应用 REST ⇒ dmText 吞异常只留一行日志（best effort，
    // 与 oracle 的 `_dm_text` 同款）；用户至少能看到 toast 里的错误
    assert.ok(logs.some((line) => line.includes('DM 回执发送失败')));
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('换用新应用：只换 secret（同 app_id）⇒ 不取码、直接重连', async () => {
  const h = harness('m11-switch-sameapp');
  try {
    setCfg(h.fx, CFG_OLD);
    setBinding(h.fx);
    inbound._SETUP_NONCES.set('n', [1, Date.now() / 1000 + 600]);
    let restarts = 0;
    h.options.feishu = { makeBindCode: () => { throw new Error('不该取码'); } };
    h.options.restart = async () => { restarts += 1; return true; };
    const out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'switch', u: 1, n: 'n' },
      CFG_OLD, h.options);
    assert.equal(restarts, 1);
    assert.deepEqual(out, { toast: { type: 'success', content: '已重连' } });
    assert.equal(h.calls.dm.at(-1)[1],
      '🔄 已用当前应用 `cli_old` 重新建立长连接，绑定关系不变。');
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('慢动作：自检摘要只列 fail/warn；补齐/发布成功失败文案', async () => {
  const h = harness('m11-slow');
  try {
    h.options.provision = {
      async doctor() {
        return {
          items: [
            { key: 'creds', label: '应用凭据', state: 'ok', detail: '已配置', hint: '' },
            { key: 'token', label: '凭据有效性', state: 'fail', detail: 'code=10003',
              hint: '检查 App ID / Secret' },
            { key: 'webhook', label: '默认推送 Webhook', state: 'warn',
              detail: '未配置', hint: '去群机器人拿 Webhook' },
          ],
          summary: { ok: 1, fail: 1, warn: 1, skip: 0 },
        };
      },
      async provisionApply() { return { ok: true, steps: [], error: '', need_patch_scope: false }; },
      async provisionPublish() { return { ok: true, version: '1.0.4', version_id: 'v1',
        need_patch_scope: false, error: '' }; },
    };
    await inbound.setupSlowAction(1, 'ou_1', 'doctor', CFG_OLD, h.options);
    assert.equal(h.calls.dm.at(-1)[1], '🩺 配置自检：ok 1 / fail 1 / warn 1 / skip 0\n'
      + '· 凭据有效性：code=10003（检查 App ID / Secret）\n'
      + '· 默认推送 Webhook：未配置（去群机器人拿 Webhook）');
    await inbound.setupSlowAction(1, 'ou_1', 'apply', CFG_OLD, h.options);
    assert.equal(h.calls.dm.at(-1)[1],
      '🧩 配置补齐成功：机器人能力 / 权限 / 长连接订阅 / 事件 / 回调已写入（需发布新版本生效）。');
    await inbound.setupSlowAction(1, 'ou_1', 'publish', CFG_OLD, h.options);
    assert.equal(h.calls.dm.at(-1)[1],
      '🚀 已提交发布版本 1.0.4；仍需租户管理员审批后线上生效。');
    h.options.provision.provisionApply = async () => ({
      ok: false, steps: [], error: '应用缺少权限', need_patch_scope: true });
    await inbound.setupSlowAction(1, 'ou_1', 'apply', CFG_OLD, h.options);
    assert.equal(h.calls.dm.at(-1)[1], '❌ 配置补齐失败：应用缺少权限');
    h.options.provision.provisionPublish = async () => ({
      ok: false, version: '', version_id: '', need_patch_scope: false, error: '发布失败: boom' });
    await inbound.setupSlowAction(1, 'ou_1', 'publish', CFG_OLD, h.options);
    assert.equal(h.calls.dm.at(-1)[1], '❌ 提交发布失败：发布失败: boom');
  } finally {
    h.close();
  }
});

test('慢动作档在回调里立刻回 toast（不在回调里等 REST）', async () => {
  const h = harness('m11-slow-toast');
  try {
    setBinding(h.fx);
    inbound._SETUP_NONCES.set('n', [1, Date.now() / 1000 + 600]);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.options.provision = {
      async doctor() { await gate; return { items: [], summary: { ok: 0, fail: 0, warn: 0, skip: 0 } }; },
    };
    const out = await inbound.onSetupCardAction('ou_1', { t: 'fs', a: 'doctor', u: 1, n: 'n' },
      CFG_OLD, h.options);
    assert.deepEqual(out, { toast: { type: 'success', content: '已收到，结果稍后私聊发你' } });
    release();
    await waitFor(() => h.calls.dm.length === 1);
    assert.match(h.calls.dm[0][1], /^🩺 配置自检：/);
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

// ==========================================================================
// ④ 发卡入口：主动（接入）/ 自动（换应用）
// ==========================================================================

test('sendSetupCard：未配凭据 / 未绑定两档中文错误，不抛异常', async () => {
  const h = harness('m11-send-err');
  try {
    assert.deepEqual(await inbound.sendSetupCard(1, null, h.options),
      [false, '未配置应用凭据（App ID / App Secret），先保存配置再发卡片']);
    setCfg(h.fx, CFG_OLD);
    assert.deepEqual(await inbound.sendSetupCard(1, null, h.options),
      [false, '尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复「绑定 <码>」']);
    assert.equal(inbound._SETUP_NONCES.size, 0);
  } finally {
    h.close();
  }
});

test('sendSetupCard 成功：用传入凭据发、nonce 登记到用户、卡片取当前配置 app', async () => {
  const h = harness('m11-send-ok');
  try {
    setCfg(h.fx, CFG_NEW);
    setBinding(h.fx);
    const [ok, err] = await inbound.sendSetupCard(1, CFG_OLD, h.options);
    assert.deepEqual([ok, err], [true, '']);
    const [openId, card, cfg] = h.calls.card[0];
    assert.equal(openId, 'ou_1');
    assert.equal(cfg, CFG_OLD);
    assert.equal(card.header.title.content, '🛠 飞书接入操作');    // 线程未跑 ⇒ 同应用形态
    const nonce = card.body.elements[2].behaviors[0].value.n;
    assert.equal(inbound._SETUP_NONCES.get(nonce)[0], 1);
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('maybeSendSwitchCard 条件矩阵：三种不满足零请求 + 全满足时用旧凭据发切换卡', async () => {
  const h = harness('m11-switch-card');
  try {
    setBinding(h.fx);
    // ① 应用没变
    setCfg(h.fx, CFG_OLD);
    assert.equal(await inbound.maybeSendSwitchCard(1, CFG_OLD, h.options), false);
    // ② 线程没在跑
    setCfg(h.fx, CFG_NEW);
    assert.equal(await inbound.maybeSendSwitchCard(1, CFG_OLD, h.options), false);
    // 起一条「旧应用」连接（假客户端），线程在跑、记录 app=cli_old
    setCfg(h.fx, CFG_OLD);
    FakeWsClient.instances = [];
    assert.equal(inbound.startInboundFor(1, fakeOptions(h.fx, h.rest)), true);
    await waitFor(() => cfgMod.inboundStatus(1, h.options).thread);
    assert.equal(cfgMod.inboundThreadAppId(1), 'cli_old');
    // ③ 线程绑的已是新应用（无需切换）
    setCfg(h.fx, CFG_NEW);
    assert.equal(await inbound.maybeSendSwitchCard(1, CFG_OLD, h.options), true);  // 先证可发
    assert.equal(h.calls.card.length, 1);
    const [openId, card, cfg] = h.calls.card[0];
    assert.equal(openId, 'ou_1');
    assert.equal(cfg, CFG_OLD);                                   // 旧凭据发
    assert.equal(card.header.title.content, '🔁 飞书应用已变更');
    // ④ 无绑定行：删掉后不再发
    dbMod.delFeishuBindingByOpen('ou_1', { db: h.fx.db });
    assert.equal(await inbound.maybeSendSwitchCard(1, CFG_OLD, h.options), false);
    assert.equal(h.calls.card.length, 1);
  } finally {
    await inbound.stopInboundFor(1, h.options);
    inbound._WS_CLIENTS.clear();
    cfgMod.clearInboundThread(1);
    h.close();
  }
});

test('maybeSendSwitchCard 绝不抛出：REST 炸了也只回 false + 一行日志', async () => {
  const h = harness('m11-switch-card-err');
  try {
    setBinding(h.fx);
    setCfg(h.fx, CFG_OLD);
    FakeWsClient.instances = [];
    inbound.startInboundFor(1, fakeOptions(h.fx, h.rest));
    await waitFor(() => cfgMod.inboundStatus(1, h.options).thread);
    setCfg(h.fx, CFG_NEW);
    const logs = [];
    const opts = { ...fakeOptions(h.fx, h.rest), log: (line) => logs.push(line) };
    opts.rest = { async restSendCard() { throw new Error('boom'); } };
    assert.equal(await inbound.maybeSendSwitchCard(1, CFG_OLD, opts), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /换应用确认卡片发送失败/);
  } finally {
    await inbound.stopInboundFor(1, h.options);
    inbound._WS_CLIENTS.clear();
    cfgMod.clearInboundThread(1);
    h.close();
  }
});

// ==========================================================================
// ⑤ 可停长连接（真机制：假客户端 + 真 stopInboundFor/restartInboundFor）
// ==========================================================================

test('stopInboundFor：关连接 → runner 收口 → 注册表摘净；幂等再停 false', async () => {
  const h = harness('m11-stop');
  try {
    setCfg(h.fx, CFG_OLD);
    FakeWsClient.instances = [];
    const opts = fakeOptions(h.fx, h.rest);
    assert.equal(inbound.startInboundFor(1, opts), true);
    await waitFor(() => FakeWsClient.instances.length === 1);
    const client = FakeWsClient.instances[0];
    assert.equal(client.appId, 'cli_old');
    assert.equal(inbound._WS_CLIENTS.get(1), client);
    assert.equal(await inbound.stopInboundFor(1, opts), true);
    assert.equal(client.closed, true);
    assert.equal(inbound._WS_CLIENTS.has(1), false);
    assert.equal(cfgMod.inboundStatus(1, h.options).thread, false);
    assert.equal(await inbound.stopInboundFor(1, opts), false);   // 幂等
  } finally {
    inbound._WS_CLIENTS.clear();
    cfgMod.clearInboundThread(1);
    h.close();
  }
});

test('restartInboundFor：停旧 → 用当前库里的新凭据起新（app 序列 old→new）', async () => {
  const h = harness('m11-restart');
  try {
    setCfg(h.fx, CFG_OLD);
    FakeWsClient.instances = [];
    const opts = fakeOptions(h.fx, h.rest);
    assert.equal(inbound.startInboundFor(1, opts), true);
    await waitFor(() => FakeWsClient.instances.length === 1);
    const first = FakeWsClient.instances[0];
    setCfg(h.fx, CFG_NEW);
    assert.equal(await inbound.restartInboundFor(1, opts), true);
    await waitFor(() => FakeWsClient.instances.length === 2);
    assert.equal(first.closed, true);
    assert.equal(FakeWsClient.instances[1].appId, 'cli_new');
    assert.equal(cfgMod.inboundThreadAppId(1), 'cli_new');
    assert.equal(cfgMod.inboundStatus(1, h.options).thread, true);
    assert.equal(await inbound.stopInboundFor(1, opts), true);
  } finally {
    inbound._WS_CLIENTS.clear();
    cfgMod.clearInboundThread(1);
    h.close();
  }
});

// ==========================================================================
// ⑥ 触发面：「接入」消息 + t=fs 分发
// ==========================================================================

test('handleMessageEvent「接入」：给绑定用户发卡 + 回执（失败带原因）', async () => {
  const h = harness('m11-intent');
  try {
    setCfg(h.fx, CFG_NEW);
    setBinding(h.fx);
    const evt = (mid) => ({
      message_id: mid, message_type: 'text', content: '{"text": "接入"}',
      chat_type: 'p2p', mentions: [], sender_open_id: 'ou_1',
    });
    await inbound.handleMessageEvent(evt('om_m11_1'), CFG_OLD, h.options);
    assert.equal(h.calls.card.length, 1);
    assert.deepEqual(h.calls.reply.at(-1), ['om_m11_1',
      '🛠 已发送「飞书接入操作卡片」，请在卡片上操作。', CFG_OLD]);
    h.options.rest = {
      ...h.rest,
      async restSendCard() { throw new FeishuRestError('send failed code=230001', 230001); },
    };
    await inbound.handleMessageEvent(evt('om_m11_2'), CFG_OLD, h.options);
    assert.equal(h.calls.reply.at(-1)[1], '卡片发送失败：卡片发送失败：send failed code=230001');
  } finally {
    inbound.resetSetupState();
    h.close();
  }
});

test('onCardAction 把 t=fs 分流到接入卡片；同一 event_id 重推只执行一次', async () => {
  const h = harness('m11-dispatch');
  try {
    setCfg(h.fx, CFG_OLD);
    setBinding(h.fx);
    const nonce = inbound.setupNonce(1);
    let restarts = 0;
    h.options.restart = async () => { restarts += 1; return true; };
    const data = (eid) => ({
      header: { event_id: eid },
      event: {
        operator: { open_id: 'ou_1' },
        action: { value: { t: 'fs', a: 'restart', u: 1, n: nonce } },
      },
    });
    inbound.resetInboundState();
    const out = await inbound.onCardAction(data('ev-m11-1'), CFG_OLD, h.options);
    assert.deepEqual(out, { toast: { type: 'success', content: '已重连' } });
    assert.equal(restarts, 1);
    assert.equal(h.calls.dm.at(-1)[1], '🔄 已用当前应用 `cli_old` 重新建立长连接。');
    const again = await inbound.onCardAction(data('ev-m11-1'), CFG_OLD, h.options);
    assert.equal(again, null);
    assert.equal(restarts, 1);
  } finally {
    inbound.resetSetupState();
    inbound.resetInboundState();
    h.close();
  }
});

test('parseIntent「接入」→ setup；HELP_TEXT 可发现该指令', () => {
  assert.deepEqual(inbound.parseIntent('接入'), { action: 'setup', groups: [] });
  assert.equal(inbound.parseIntent('帮助').action, 'help');
  assert.ok(inbound.HELP_TEXT.includes('· 接入 — 飞书接入操作卡片（换应用/重连/绑定码/自检/补齐/发布）'));
});
