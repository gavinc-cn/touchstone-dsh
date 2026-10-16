/**
 * `backend/lib/chat.js` 的 **M4 消息生命周期**单测（node --test，零依赖）。
 *
 * 覆盖（对应 M4 交付要求的五组）：
 *   ① `submit` 的三种单元形态（纯会话 / 任务 / 卡片评论）与 `DeliveryRefused` 拒投路径
 *      （含 `TS_EXTERNAL_DELIVER=0` 回退阀、看管声明失败、宿主无活 agent）；
 *   ② `state` / `running` / `msgsOfSid` 读口（同步快路径 + Promise 慢路径两条分支）；
 *   ③ `cancelQueued` 与 `cancel`（含 removeMsg 调用、终态守卫、运行中不命中）；
 *   ④ `runUnit` 的三条终态（done/yielded/error）+ `fireMsgDone` 钩子（抛异常被吞、
 *      thenable 拒绝被吞、孤儿 claim 收口）；
 *   ⑤ `TurnSubscription` 预订阅池的 TTL 回收与上限（`DSH_SUB_MAX`）、同 sid 覆盖、对象同一性。
 * 附带覆盖：等 turn 的总时限/断连两条收口（文案 + 日志落点）、外部会话走全局状态流的
 * 「预订阅 + 帧口袋」（缺陷 A）、宿主会话存活判定与 resume 接回、运行产物目录与 `.gitignore`。
 *
 * 三条硬约束：
 *   ① **临时库、绝不碰生产库**：每个用例 `mkdtemp` + 真启动序建库（`m3fixture.freshDb`）；
 *      另把 `TOUCHSTONE_DB` 指向临时库作**金丝雀**——万一有调用漏传 `options`（默认库路径），
 *      那条调用也只会落在临时库上。
 *   ② **不打真 dsh 主机**：驱动交互一律指向本文件内的 `FakeDriver`（127.0.0.1 随机端口，
 *      经 `TS_AGENT_DRIVER_URL` 注入——这正是 `dshdriver.js` 提供的可注入点，与
 *      `dshdriver.test.mjs` 同款做法）；`dshevents` 侧用其**订阅者回调**喂帧（不建真 SSE）。
 *   ③ **造行用真 SQL**（`m3fixture` 的 insert*），读出来就是生产库那种普通对象。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import * as chat from '../lib/chat.js';
import * as dshevents from '../lib/dshevents.js';
import * as waitq from '../lib/waitq.js';
import { freshDb, insertMsg, insertProject, insertWait } from './m3fixture.mjs';

/** 并行移植窗口：waitq 的 M4 写口符号是否齐备（缺谁由第一条用例指名报告） */
const WQ_MISSING = chat.missingWaitqSymbols();

// --------------------------------------------------------------------------
// 假驱动（形状照 `dsh-plugin/lib/agent-driver.js`：`/touchstone-agent` 前缀 + 令牌头）
// --------------------------------------------------------------------------

const AGENT_BASE = '/touchstone-agent';

class FakeDriver {
  constructor() {
    this.calls = [];
    /** `/status` 回执（用例按需改：`{status, last_seq}`） */
    this.status = { status: 'idle', last_seq: 7 };
    /** 会话 SSE（`/events?session_id=`）要补发的帧（按 `seq > since` 过滤） */
    this.sessionFrames = [];
    /** SSE 收尾形态：keepalive=推完帧后挂住（用例结束由 close() 收）；close=推完就断 */
    this.eventsMode = 'keepalive';
    /** `/session`（resume）回执里的 session_id；`null` = 回请求里的同值 */
    this.sessionFail = false;
    this.server = null;
    this.url = '';
    this.base = '';
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(() => { /* 收尾竞态：忽略 */ });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    this.base = this.url + AGENT_BASE;
    return this;
  }

  async close() {
    if (this.server === null) return;
    const srv = this.server;
    this.server = null;
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }

  /** 某路径的调用记录（路径不含 agent 前缀） */
  byPath(p) {
    return this.calls.filter((c) => c.path === p);
  }

  _json(res, code, body) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': raw.length });
    res.end(raw);
  }

  async _handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.startsWith(AGENT_BASE)
      ? url.pathname.slice(AGENT_BASE.length) || '/' : url.pathname;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    this.calls.push({ method: req.method, path: route, raw, body });
    if (route === '/events') return this._events(res, url);
    if (req.method === 'GET' && route === '/status') return this._json(res, 200, this.status);
    if (req.method === 'POST' && route === '/prompt') return this._json(res, 200, { ok: true });
    if (req.method === 'POST' && route === '/steer') return this._json(res, 200, { ok: true });
    if (req.method === 'POST' && route === '/cancel') return this._json(res, 200, { ok: true });
    if (req.method === 'POST' && route === '/session') {
      if (this.sessionFail) return this._json(res, 404, { error: '会话文件不存在' });
      return this._json(res, 200, { session_id: (body || {}).session_id || '' });
    }
    return this._json(res, 404, { error: `未知驱动端点 ${route}（假驱动）` });
  }

  _events(res, url) {
    const since = Number(url.searchParams.get('since') || '0') || 0;
    const frames = this.sessionFrames.filter((f) => Number(f.seq || 0) > since);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    res.write(': keepalive\n\n');
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (this.eventsMode === 'close') return res.end();
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 25);
    res.on('close', () => clearInterval(timer));
    req.on('close', () => clearInterval(timer));
    return undefined;
  }
}

// --------------------------------------------------------------------------
// 夹具：临时库 + env 金丝雀 + hub 快照 + 全量清理
// --------------------------------------------------------------------------

/** 保存 `dshevents.HUB` 的可变状态（用例会直接改它，模拟「已连接 + 已对齐」） */
function saveHub() {
  return {
    sessions: new Map(dshevents.HUB._sessions),
    archived: dshevents.HUB._archived === null ? null : new Set(dshevents.HUB._archived),
    connected: dshevents.HUB._connected,
    aligned: dshevents.HUB._aligned,
    lastSeq: dshevents.HUB._lastSeq,
    subscribers: [...dshevents.HUB._subscribers],
  };
}

function restoreHub(saved) {
  dshevents.HUB._sessions = saved.sessions;
  dshevents.HUB._archived = saved.archived;
  dshevents.HUB._connected = saved.connected;
  dshevents.HUB._aligned = saved.aligned;
  dshevents.HUB._lastSeq = saved.lastSeq;
  dshevents.HUB._subscribers = saved.subscribers;
}

/**
 * 把 hub 置成「链路在线 ∧ 快照可信 ∧ 注册表里有这些会话」。
 * @param {object[]} sessions 注册表条目（`{session_id, owned, status, last_seq, ...}`）
 */
function setHub(sessions = []) {
  dshevents.HUB._connected = true;
  dshevents.HUB._aligned = true;
  dshevents.HUB._sessions = new Map(sessions.map((s) => [s.session_id, { ...s }]));
}

const ENV_KEYS = [
  'TOUCHSTONE_DB', 'TS_AGENT_DRIVER_URL', 'TS_AGENT_DRIVER_TOKEN',
  'TS_EXTERNAL_DELIVER', 'TS_HOST_SESSION_REVIVE', 'TS_DSH_WAIT_TURN_TIMEOUT',
];

function saveEnv() {
  const out = {};
  for (const key of ENV_KEYS) out[key] = process.env[key];
  return out;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/** 清理所有 M4 进程内状态（登记表 / 两张旁表 / 预订阅池 / 桥 / 钩子 / runner 替身） */
function clearChatState() {
  chat.CHAT_REGISTRY.clear();
  chat.DSH_BASELINE.clear();
  chat.DSH_INJECT.clear();
  for (const sub of [...chat.DSH_SUB.values()]) sub.close();
  chat.DSH_SUB.clear();
  chat.setBoardBridge(null);
  chat.setMsgDoneHook(null);
  chat.setRunnerInstance(null);
}

/**
 * 临时库夹具：建库（真启动序）→ 指向 env 金丝雀 → 跑用例 → 全量清理。
 * @param {string} tag
 * @param {(fx: object) => Promise<any>|any} fn
 */
async function withFixture(tag, fn) {
  const fx = freshDb(tag);
  const hubSaved = saveHub();
  const envSaved = saveEnv();
  process.env.TOUCHSTONE_DB = fx.dbPath;     // 金丝雀：漏传 options 也只落临时库
  try {
    return await fn(fx);
  } finally {
    clearChatState();
    restoreHub(hubSaved);
    restoreEnv(envSaved);
    fx.close();
  }
}

/** 起假驱动并把连接信息写进 env（用例结束必停）；`fn` 抛错也保证停服 */
async function withDriver(fn) {
  const drv = await new FakeDriver().start();
  process.env.TS_AGENT_DRIVER_URL = drv.base;
  delete process.env.TS_AGENT_DRIVER_TOKEN;
  try {
    return await fn(drv);
  } finally {
    delete process.env.TS_AGENT_DRIVER_URL;
    await drv.close();
  }
}

/** 插一条项目（work_dir 指向夹具目录，日志会落到 <dir>/.web/） */
function project(fx, opts = {}) {
  return insertProject(fx.db, { name: 'p', workDir: fx.dir, ...opts });
}

/** 读 `<dir>/.web/` 下唯一的对话日志（`dshSendNow` 每次投递写一份） */
function chatLog(fx) {
  const dir = path.join(fx.dir, '.web');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('chat_dsh_'));
  assert.equal(files.length, 1, `.web 下应恰有一份对话日志，实得 ${files.join(',')}`);
  return { name: files[0], text: fs.readFileSync(path.join(dir, files[0]), 'utf8') };
}

/** 会话 SSE 的「一轮正常结束」帧序列（基线 last_seq=7 ⇒ turn/start 的 seq 8 才算本轮） */
function turnOkFrames() {
  return [
    { seq: 8, type: 'turn/start', session_id: 'sid-a', data: { event_seq: 8, turn: 1 } },
    { seq: 9, type: 'turn/end', session_id: 'sid-a', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

// ==========================================================================
// 前置门：waitq 写口符号（并行移植窗口的进度报告；齐备时本用例恒过）
// ==========================================================================

test('前置门：waitq.js 的 M4 写口符号齐备（缺谁指名报告）', () => {
  assert.deepEqual(WQ_MISSING, [],
    `waitq.js 仍缺 M4 写口符号：${WQ_MISSING.join(', ')}（chat.js 经运行期符号门调用，见文件头差异⑦）`);
});

// ==========================================================================
// ① submit：三种单元形态 + DeliveryRefused 拒投 + 回退阀
// ==========================================================================

test('submit①：无 runner（同步路径）纯会话消息 ⇒ 假驱动跑完 turn 即 done，不写等待项', async () => {
  await withFixture('chatm4-a1', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      drv.status = { status: 'idle', last_seq: 7 };
      drv.sessionFrames = turnOkFrames();
      const res = await chat.submit(pid, 'sid-a', '你好', { family: 'dsh_plugin', db: fx.db });

      assert.deepEqual(res, { id: res.id, state: chat.STATE_DONE, queued: false });
      const row = waitq.msgGet(res.id, { db: fx.db });
      assert.equal(row.state, 'done', 'chat_msgs 终态 done');
      assert.equal(row.message, '你好');
      assert.equal(row.sid, 'sid-a');
      assert.equal(row.task_id, null);
      assert.equal(row.card_id, null);
      assert.ok(row.started_at > 0 && row.ended_at >= row.started_at);
      assert.equal(waitq.getActive(waitq.KIND_MSG, res.id, { db: fx.db }), null,
        '无 runner ⇒ queue=false，不写等待项（P5 R13 孤儿行收口）');

      // 投递痕迹：/status（取基线）→ /prompt（followup），日志两份标题行齐备
      assert.equal(drv.byPath('/status').length, 1);
      assert.equal(drv.byPath('/prompt').length, 1);
      assert.equal(drv.byPath('/prompt')[0].body.session_id, 'sid-a');
      assert.equal(drv.byPath('/prompt')[0].body.prompt, '你好');
      const log = chatLog(fx);
      assert.ok(log.text.includes('### PROMPT "你好"\n'), `日志首行：${log.text.split('\n')[0]}`);
      assert.ok(log.text.includes('### DRIVER dsh_plugin sid=sid-a followup\n'));
      // 运行产物目录与 .gitignore（lib.ensure_runtime_dirs 的等价物）
      assert.ok(fs.existsSync(path.join(fx.dir, '.live')));
      assert.ok(fs.readFileSync(path.join(fx.dir, '.gitignore'), 'utf8').includes('.web/'));
      // 登记表记录（state 的数据源）
      const rec = chat.CHAT_REGISTRY.get('sid-a');
      assert.equal(rec.dsh_plugin, true);
      assert.equal(rec.task_id, null);
      assert.equal(rec.message, '你好');
      assert.equal(rec.log_path, path.join(fx.dir, '.web', log.name));
    });
  });
});

test('submit①：任务侧消息（task_id 非空）走同一投递分支且 done；卡评论未接线 ⇒ M5 缝响亮失败', async () => {
  await withFixture('chatm4-a2', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      drv.sessionFrames = turnOkFrames();
      // 任务侧：无 runner 的同步路径
      const res = await chat.submit(pid, 'sid-a', '任务消息',
        { taskId: 42, family: 'dsh_plugin', db: fx.db });
      assert.equal(res.state, chat.STATE_DONE);
      assert.equal(waitq.msgGet(res.id, { db: fx.db }).task_id, 42);
      assert.equal(waitq.getActive(waitq.KIND_MSG, res.id, { db: fx.db }), null);

      // 卡片评论：board 桥未接线 ⇒ 抛「卡片投递桥未接线（M5）」并由 submit 收口成 error 终态
      const before = drv.byPath('/prompt').length;
      await assert.rejects(
        () => chat.submit(pid, 'sid-a', '评论',
          { cardId: 7, commentId: 3, family: 'dsh_plugin', db: fx.db }),
        (err) => err instanceof Error && err.message === chat.CARD_BRIDGE_MISSING,
      );
      const rows = waitq.msgRows({ cardId: 7, states: [chat.STATE_ERROR] }, { db: fx.db });
      assert.equal(rows.length, 1, 'error 终态落表');
      assert.equal(rows[0].error, chat.CARD_BRIDGE_MISSING, 'chat_msgs.error 就是桥文案');
      assert.equal(drv.byPath('/prompt').length, before, '桥未接线 ⇒ 一个字节都没投出去');
      assert.equal(waitq.getActive(waitq.KIND_MSG, rows[0].id, { db: fx.db }), null);

      // 族守卫：family 为空（调用方漏传，Python 默认 family=""）⇒ 与 Python 同文案的响亮失败
      await assert.rejects(
        () => chat.submit(pid, 'sid-a', '无族', { db: fx.db }),
        (err) => err.message === '该智能体族已下线，请在项目设置里改绑 dsh 插件：未知',
      );
    });
  });
});

test('submit①：卡片评论接线后（setBoardBridge.deliverUnit）走 board 分支，投递参数逐字对齐', async () => {
  await withFixture('chatm4-a3', async (fx) => {
    const pid = project(fx);
    const seen = [];
    chat.setBoardBridge({
      deliverUnit: async (proj, card, comment, message, inject) => {
        seen.push({ proj, card, comment, message, inject });
        return null;
      },
    });
    const res = await chat.submit(pid, 'sid-card', '看板评论', {
      cardId: 9, commentId: 5, family: 'dsh_plugin', model: 'm1', db: fx.db,
    });
    assert.equal(res.state, chat.STATE_DONE);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].proj.id, pid);
    assert.deepEqual(seen[0].card, { id: 9, session_id: 'sid-card', model: 'm1' });
    assert.deepEqual(seen[0].comment, { id: 5 });
    assert.equal(seen[0].message, '看板评论');
    assert.equal(seen[0].inject, false);
  });
});

test('submit①：有 runner ⇒ 只入队不执行；queued 与 meta 快照（含 comment_id/extraMeta 平铺）', async () => {
  await withFixture('chatm4-a4', async (fx) => {
    const pid = project(fx);
    const calls = [];
    chat.setRunnerInstance({
      submitMsg: (msgId, projectId, sid) => { calls.push([msgId, projectId, sid]); },
      removeMsg: () => {},
    });
    // 项目空闲：queued=false（runner.unitBusy 的表读口径）
    const idle = await chat.submit(pid, 'sid-b', '排队消息', { family: 'dsh_plugin', model: 'm2', db: fx.db });
    assert.deepEqual(idle, { id: idle.id, state: chat.STATE_QUEUED, queued: false });
    assert.deepEqual(calls, [[idle.id, pid, 'sid-b']]);
    const row = waitq.msgGet(idle.id, { db: fx.db });
    assert.equal(row.state, 'queued');
    assert.equal(row.inject, 0);
    const wrow = waitq.getActive(waitq.KIND_MSG, idle.id, { db: fx.db });
    assert.equal(wrow.state, 'waiting', '有 runner ⇒ queue=true，写等待项行');
    assert.deepEqual(JSON.parse(wrow.meta), { family: 'dsh_plugin', model: 'm2' });

    // meta 平铺：comment_id（有值才写）+ extraMeta 原样带命名空间
    const card = await chat.submit(pid, 'sid-card', '卡评', {
      cardId: 3, commentId: 8, inject: true, family: 'dsh_plugin', model: '',
      extraMeta: { feishu: { open_id: 'o1' } }, db: fx.db,
    });
    const cw = waitq.getActive(waitq.KIND_MSG, card.id, { db: fx.db });
    assert.deepEqual(JSON.parse(cw.meta), {
      family: 'dsh_plugin', model: '', comment_id: 8, feishu: { open_id: 'o1' },
    });
    assert.equal(waitq.msgGet(card.id, { db: fx.db }).inject, 1);

    // 项目忙（有活跃 ext 行）⇒ queued=true（与调度侧放行口径一致）
    insertWait(fx.db, { projectId: pid, kind: 'ext', targetId: 'ext-1', state: 'running', seq: 1 });
    const busy = await chat.submit(pid, 'sid-b', '忙时提交', { db: fx.db });
    assert.equal(busy.queued, true);
  });
});

test('DeliveryRefused：外部会话三条拒投文案（未获许可 / 无活 agent / 回退阀）+ 不落行', async () => {
  await withFixture('chatm4-a5', async (fx) => {
    const pid = project(fx);
    const baseline = () => waitq.msgRows({ sid: 's-ext' }, { db: fx.db }).length;
    assert.equal(baseline(), 0);

    // ① 外部会话 + 未接线看管声明（M5 缝①）⇒ 按 Python 的「看管声明失败」文案拒投
    setHub([{ session_id: 's-ext', owned: false, status: 'running', last_seq: 1 }]);
    await assert.rejects(() => chat.submit(pid, 's-ext', 'hi', { db: fx.db }), (err) => {
      assert.ok(err instanceof chat.DeliveryRefused, '必须是 DeliveryRefused（端点是 instanceof 判定）');
      assert.ok(!(err instanceof chat.InjectRefused), '两个异常类互不混淆');
      assert.equal(err.message, '该会话是 dsh 直跑会话，平台未获投递许可'
        + '（看管声明失败：插件过旧或不可达），请到 dsh 会话窗口发送');
      return true;
    });
    assert.equal(baseline(), 0, '拒投 ⇒ 不落 chat_msgs 行');

    // ② 看管声明成功 ⇒ 放行（落到投递；这里没有驱动 ⇒ 消息落 error，但**行落了**）
    chat.setBoardBridge({ ensureWatch: () => true });
    await assert.rejects(() => chat.submit(pid, 's-ext', 'hi', { db: fx.db }));
    assert.equal(baseline(), 1, '放行 ⇒ 行落表（投递失败另算）');

    // ③ 宿主无活 agent ⇒ 拒投
    setHub([{ session_id: 's-ext2', owned: false, status: 'unknown', last_seq: 1 }]);
    await assert.rejects(() => chat.submit(pid, 's-ext2', 'hi', { db: fx.db }), (err) => {
      assert.equal(err.message, '会话已结束，无法投递（宿主无活动 agent）');
      return true;
    });

    // ④ 回退阀 TS_EXTERNAL_DELIVER=0 ⇒ 外部会话一律拒投（连看管都不声明）
    // 注意：setHub 是整表重建（③ 之后 s-ext 已不在表内 ⇒ 会按「未知放行」），故先复位
    setHub([{ session_id: 's-ext', owned: false, status: 'running', last_seq: 1 }]);
    process.env.TS_EXTERNAL_DELIVER = '0';
    await assert.rejects(() => chat.submit(pid, 's-ext', 'hi', { db: fx.db }), (err) => {
      assert.equal(err.message, '该会话是 dsh 直跑会话，平台已关闭外部会话投递'
        + '（TS_EXTERNAL_DELIVER=0），请到 dsh 会话窗口发送');
      return true;
    });
    assert.equal(chat.externalDeliverEnabled(), false);
    delete process.env.TS_EXTERNAL_DELIVER;

    // ⑤ 池内会话（owned=true）与未知（hub 断连 ⇒ get 为 null）一律放行，不抛
    setHub([{ session_id: 's-own', owned: true, status: 'idle', last_seq: 0 }]);
    chat.externalPreflight('s-own', { db: fx.db });
    dshevents.HUB._connected = false;
    chat.externalPreflight('s-ext', { db: fx.db });
    chat.externalPreflight('', { db: fx.db });
  });
});

// ==========================================================================
// ② state / running / msgsOfSid 读口
// ==========================================================================

test('state/running②：无登记记录 ⇒ base（三键，不带 started_at/message/exit_code），一律 async', async () => {
  await withFixture('chatm4-b1', async (fx) => {
    const pid = project(fx);
    insertMsg(fx.db, { id: 'm1', projectId: pid, sid: 'sid-q', message: '排队', state: 'queued', createdAt: 1 });
    insertMsg(fx.db, { id: 'm2', projectId: pid, sid: 'sid-q', message: '跑着', state: 'running', createdAt: 2 });
    insertMsg(fx.db, { id: 'm3', projectId: pid, sid: 'sid-q', message: '失败', state: 'error', error: 'e', createdAt: 3 });
    insertMsg(fx.db, { id: 'm4', projectId: pid, sid: 'sid-q', message: '完成', state: 'done', createdAt: 4 });

    const pending = chat.state('sid-q', { db: fx.db });
    assert.ok(pending instanceof Promise, 'M4 起 state 整体 async（漏 await 会把 Promise 序列化成 {}）');
    const st = await pending;
    assert.deepEqual(Object.keys(st), ['running', 'queued', 'msgs']);
    assert.equal(st.running, false);
    assert.equal(st.queued, 1);
    assert.deepEqual(st.msgs.map((m) => m.id), ['m1', 'm2', 'm3']);
    assert.equal(await chat.running('sid-q', { db: fx.db }), false);
    assert.deepEqual(await chat.state('', { db: fx.db }), { running: false, queued: 0, msgs: [] });
    assert.deepEqual(await chat.state(null, { db: fx.db }), { running: false, queued: 0, msgs: [] });
    // 非 dsh 记录（防呆分支）：按空闲呈现
    chat.CHAT_REGISTRY.set('sid-q', { dsh_plugin: false });
    assert.equal((await chat.state('sid-q', { db: fx.db })).running, false);
    // 返回的 base 每次现造：调用方就地改字段不污染后续调用（routes/sessions.js 的用法）
    const one = await chat.state('sid-q', { db: fx.db });
    one.running = true;
    assert.equal((await chat.state('sid-q', { db: fx.db })).running, false);
  });
});

test('state/running②：有 dsh 记录 ⇒ await 后带三键；忙閒切换与 exit_code 顺手回填', async () => {
  await withFixture('chatm4-b2', async (fx) => {
    await withDriver(async (drv) => {
      chat.register('sid-r', 5, 'm'.repeat(300), { logPath: '/tmp/x.log', dshPlugin: true, since: 3 });
      const rec = chat.CHAT_REGISTRY.get('sid-r');
      assert.equal(rec.message.length, 200, '登记记录里的 message 截 200（照 Python）');
      assert.equal(rec.exit_code, null);

      drv.status = { status: 'running', last_seq: 9 };
      const st = await chat.state('sid-r', { db: fx.db });
      assert.equal(st.running, true);
      assert.equal(st.started_at, rec.started_at);
      assert.equal(st.message, rec.message);
      assert.equal(st.exit_code, null, 'busy 时不回填');

      drv.status = { status: 'idle', last_seq: 9 };
      const st2 = await chat.state('sid-r', { db: fx.db });
      assert.equal(st2.running, false);
      assert.equal(st2.exit_code, 0, '!busy 且 exit_code 为 null ⇒ 顺手写回 0（进程内记录）');
      assert.equal(rec.exit_code, 0, '回填就地生效（不落库）');
      assert.equal(await chat.running('sid-r', { db: fx.db }), false, 'running 的 Promise 分支');

      // 驱动不可用（未配置）⇒ dshBusy 吞 DshDriverError 成 false，state 仍是「不忙」
      delete process.env.TS_AGENT_DRIVER_URL;
      const st3 = await chat.state('sid-r', { db: fx.db });
      assert.equal(st3.running, false);
    });
  });
});

// ==========================================================================
// ③ cancelQueued 与 cancel
// ==========================================================================

test('cancel③：msg_cancel 守卫命中 ⇒ 行终态 cancelled + 等待项取消 + removeMsg；重复/运行中不命中', async () => {
  await withFixture('chatm4-c1', async (fx) => {
    const pid = project(fx);
    const removed = [];
    chat.setRunnerInstance({ removeMsg: (msgId) => removed.push(msgId), submitMsg: () => {} });
    insertMsg(fx.db, { id: 'q1', projectId: pid, sid: 'sid-c', message: 'a', state: 'queued', createdAt: 1 });
    insertWait(fx.db, { projectId: pid, kind: 'msg', targetId: 'q1', state: 'waiting', seq: 1 });
    insertMsg(fx.db, { id: 'r1', projectId: pid, sid: 'sid-c', message: 'b', state: 'running', createdAt: 2 });
    insertWait(fx.db, { projectId: pid, kind: 'msg', targetId: 'r1', state: 'starting', seq: 2, claimedBy: 'worker' });

    assert.equal(chat.cancel('q1', { db: fx.db }), true);
    const row = waitq.msgGet('q1', { db: fx.db });
    assert.equal(row.state, 'cancelled');
    assert.equal(row.error, '已取消');
    assert.ok(row.ended_at > 0);
    assert.deepEqual(removed, ['q1'], '内存键摘除（runner.removeMsg）');
    const wrow = waitq.getItem(1, { db: fx.db });
    assert.equal(wrow.state, 'cancelled', '等待项行终态化（waitq.cancel）');
    assert.equal(JSON.parse(wrow.meta).cancel_reason, '已取消');
    assert.equal(chat.cancel('q1', { db: fx.db }), false, '重复取消不命中（queued 守卫）');
    assert.equal(chat.cancel('r1', { db: fx.db }), false, '执行中的消息不可取消');
    assert.equal(waitq.msgGet('r1', { db: fx.db }).state, 'running');
  });
});

test('cancel③：cancelQueued 按 sid / cardId 过滤计数；空过滤返回 0；只取 queued', async () => {
  await withFixture('chatm4-c2', async (fx) => {
    const pid = project(fx);
    insertMsg(fx.db, { id: 's1', projectId: pid, sid: 'sid-1', message: 'a', state: 'queued', createdAt: 1 });
    insertMsg(fx.db, { id: 's2', projectId: pid, sid: 'sid-1', message: 'b', state: 'queued', createdAt: 2 });
    insertMsg(fx.db, { id: 's3', projectId: pid, sid: 'sid-1', message: 'c', state: 'running', createdAt: 3 });
    insertMsg(fx.db, { id: 's4', projectId: pid, sid: 'sid-2', cardId: 77, message: 'd', state: 'queued', createdAt: 4 });
    insertMsg(fx.db, { id: 's5', projectId: pid, sid: 'sid-3', cardId: 78, message: 'e', state: 'done', createdAt: 5 });

    assert.equal(chat.cancelQueued({}, { db: fx.db }), 0, '空过滤（sid 与 cardId 皆空）⇒ 0');
    assert.equal(chat.cancelQueued({ sid: 'sid-1' }, { db: fx.db }), 2);
    assert.equal(waitq.msgGet('s3', { db: fx.db }).state, 'running', 'running 不在取消面内');
    assert.equal(chat.cancelQueued({ cardId: 77 }, { db: fx.db }), 1);
    assert.equal(waitq.msgGet('s4', { db: fx.db }).state, 'cancelled');
    assert.equal(chat.cancelQueued({ cardId: 78 }, { db: fx.db }), 0, 'done 行不取消');
    assert.deepEqual([...chat.queuedCardIds({ db: fx.db })], [], 'queued 卡集合已空');
  });
});

// ==========================================================================
// ④ runUnit 三条终态 + 终态钩子
// ==========================================================================

/** 造一条「runner 已拾起」的 msg 单元：chat_msgs=queued + wait_items=starting/worker */
function seedQueuedMsg(fx, pid, opts = {}) {
  const id = opts.id || 'run-1';
  insertMsg(fx.db, {
    id, projectId: pid, sid: opts.sid || 'sid-a', message: opts.message || '跑一轮',
    state: 'queued', createdAt: opts.createdAt || 1,
  });
  const waitState = opts.waitState || 'starting';
  insertWait(fx.db, {
    projectId: pid, kind: 'msg', targetId: id, state: waitState, seq: opts.seq || 1,
    claimedAt: waitState === 'waiting' ? null : '2026-10-11 00:00:00',
    claimedBy: waitState === 'waiting' ? '' : 'worker',
    meta: JSON.stringify(opts.meta || { family: 'dsh_plugin', model: '' }),
  });
  return id;
}

test('runUnit④：done 路径（turn/end）⇒ 两表终态 done + 钩子收 done', async () => {
  await withFixture('chatm4-d1', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      const id = seedQueuedMsg(fx, pid);
      drv.sessionFrames = turnOkFrames();
      const fired = [];
      chat.setMsgDoneHook((msgId, state) => fired.push([msgId, state]));

      await chat.runUnit(id, { db: fx.db });

      assert.equal(waitq.msgGet(id, { db: fx.db }).state, 'done');
      const wrow = waitq.getItem(1, { db: fx.db });
      assert.equal(wrow.state, 'done', '等待项行终态在同一函数闭环（裁决 R6）');
      assert.deepEqual(fired, [[id, 'done']], '终态钩子恰一次');
    });
  });
});

test('runUnit④：yielded 路径（driver/interaction）⇒ 让位终态 + evidence + 钩子收 yielded', async () => {
  await withFixture('chatm4-d2', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      const id = seedQueuedMsg(fx, pid, { id: 'run-2' });
      drv.sessionFrames = [
        { seq: 8, type: 'turn/start', session_id: 'sid-a', data: { event_seq: 8 } },
        { seq: 9, type: 'driver/interaction', session_id: 'sid-a', data: { state: 'asked', interaction: { id: 'q' } } },
      ];
      const fired = [];
      chat.setMsgDoneHook((msgId, state) => fired.push([msgId, state]));
      const logs = [];
      const savedLog = console.log;
      console.log = (line) => logs.push(String(line));

      try {
        await chat.runUnit(id, { db: fx.db });
      } finally {
        console.log = savedLog;
      }

      assert.equal(waitq.msgGet(id, { db: fx.db }).state, 'yielded');
      const wrow = waitq.getItem(1, { db: fx.db });
      assert.equal(wrow.state, 'done', '让位＝行终态 done（运行位即释放）');
      assert.deepEqual(JSON.parse(wrow.evidence), { desc: '消息投递挂起让位', reason: 'turn 等待作答' });
      assert.deepEqual(fired, [[id, 'yielded']]);
      assert.ok(logs.some((line) => line.includes(`消息单元挂起让位：m:${id}`)), '平台日志留痕');
    });
  });
});

test('runUnit④：error 路径（项目不存在）⇒ error 终态文案逐字 + 等待项 failed + 钩子收 error', async () => {
  await withFixture('chatm4-d3', async (fx) => {
    const pid = project(fx);
    // 消息行的 project_id 指向不存在的项目（payload 重建即抛「项目不存在」）
    insertMsg(fx.db, { id: 'run-3', projectId: 999999, sid: 'sid-a', message: 'x', state: 'queued', createdAt: 1 });
    insertWait(fx.db, { projectId: pid, kind: 'msg', targetId: 'run-3', state: 'starting', seq: 1, claimedBy: 'worker' });
    const fired = [];
    chat.setMsgDoneHook((msgId, state) => fired.push([msgId, state]));

    await chat.runUnit('run-3', { db: fx.db });

    const row = waitq.msgGet('run-3', { db: fx.db });
    assert.equal(row.state, 'error');
    assert.equal(row.error, '项目不存在', 'str(e) 语义（不带 Error: 前缀）');
    const wrow = waitq.getActive(waitq.KIND_MSG, 'run-3', { db: fx.db });
    assert.equal(wrow, null, '等待项已落终态（不再活跃）');
    const done = fx.db.prepare('SELECT state, meta FROM wait_items WHERE target_id=?').get('run-3');
    assert.equal(done.state, 'failed');
    assert.ok(String(JSON.parse(done.meta).error || '').includes('项目不存在'), done.meta);
    assert.deepEqual(fired, [['run-3', 'error']]);
  });
});

test('runUnit④：非 queued 早退 + 孤儿 claim 收口（starting/worker ⇒ failed「消息已不在排队中」）', async () => {
  await withFixture('chatm4-d4', async (fx) => {
    const pid = project(fx);
    insertMsg(fx.db, { id: 'run-4', projectId: pid, sid: 'sid-a', message: 'x', state: 'cancelled', createdAt: 1 });
    insertWait(fx.db, { projectId: pid, kind: 'msg', targetId: 'run-4', state: 'starting', seq: 1, claimedBy: 'worker' });
    insertMsg(fx.db, { id: 'run-5', projectId: pid, sid: 'sid-a', message: 'y', state: 'cancelled', createdAt: 2 });
    insertWait(fx.db, { projectId: pid, kind: 'msg', targetId: 'run-5', state: 'starting', seq: 2, claimedBy: 'inject-now' });

    await chat.runUnit('run-4', { db: fx.db });
    await chat.runUnit('run-5', { db: fx.db });

    const a = fx.db.prepare('SELECT state, meta FROM wait_items WHERE target_id=?').get('run-4');
    assert.equal(a.state, 'failed');
    assert.ok(String(JSON.parse(a.meta).error).includes('消息已不在排队中'),
      'claimed_by=worker 的孤儿 claim 收口');
    const b = fx.db.prepare('SELECT state, meta FROM wait_items WHERE target_id=?').get('run-5');
    assert.equal(b.state, 'starting', 'inject-now 的 claim 不由 worker 路径收口（它自行收口）');
    assert.equal(waitq.msgGet('run-4', { db: fx.db }).state, 'cancelled', '消息行态不被改写');
  });
});

test('runUnit④：终态钩子抛异常 / 返回拒绝的 thenable 都只留痕，收口照常完成', async () => {
  await withFixture('chatm4-d5', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      const id = seedQueuedMsg(fx, pid, { id: 'run-6' });
      drv.sessionFrames = turnOkFrames();
      const logs = [];
      const savedLog = console.log;
      console.log = (line) => logs.push(String(line));
      try {
        chat.setMsgDoneHook(() => { throw new Error('钩子炸了'); });
        await chat.runUnit(id, { db: fx.db });
        assert.equal(waitq.msgGet(id, { db: fx.db }).state, 'done', '钩子抛错不影响收口');

        chat.setMsgDoneHook(() => Promise.reject(new Error('异步炸了')));
        const id2 = seedQueuedMsg(fx, pid, { id: 'run-7', seq: 2 });
        await chat.runUnit(id2, { db: fx.db });
        await new Promise((resolve) => { setImmediate(resolve); });
        assert.equal(waitq.msgGet(id2, { db: fx.db }).state, 'done');
      } finally {
        console.log = savedLog;
      }
      assert.ok(logs.some((l) => l.includes('终态钩子异常') && l.includes('钩子炸了')));
      assert.ok(logs.some((l) => l.includes('终态钩子异常') && l.includes('异步炸了')));
    });
  });
});

test('runUnit④：M5 缝② —— 卡评论 msg 单元在桥未接线时落 error 终态（不是静默成功）', async () => {
  await withFixture('chatm4-d6', async (fx) => {
    const pid = project(fx);
    insertMsg(fx.db, { id: 'run-8', projectId: pid, sid: 'sid-a', message: 'c', state: 'queued', cardId: 5, createdAt: 1 });
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: 'run-8', state: 'starting', seq: 1, claimedBy: 'worker',
      meta: JSON.stringify({ family: 'dsh_plugin', model: '', comment_id: 2 }),
    });
    await chat.runUnit('run-8', { db: fx.db });
    const row = waitq.msgGet('run-8', { db: fx.db });
    assert.equal(row.state, 'error');
    assert.equal(row.error, chat.CARD_BRIDGE_MISSING);
    const done = fx.db.prepare('SELECT state FROM wait_items WHERE target_id=?').get('run-8');
    assert.equal(done.state, 'failed');
  });
});

// ==========================================================================
// ④b injectNow（立即注入）——与 ③/④ 同族的写路径
// ==========================================================================

test('injectNow④：排队消息立即投递（steer）⇒ done + 行/等待项双终态；拒投三种文案', async () => {
  await withFixture('chatm4-i1', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      const removed = [];
      chat.setRunnerInstance({ removeMsg: (id) => removed.push(id), submitMsg: () => {} });
      const id = seedQueuedMsg(fx, pid, { id: 'inj-1', waitState: 'waiting' });

      await chat.injectNow(id, { db: fx.db });

      assert.equal(waitq.msgGet(id, { db: fx.db }).state, 'done');
      assert.equal(fx.db.prepare('SELECT state FROM wait_items WHERE target_id=?').get(id).state, 'done');
      assert.deepEqual(removed, [id], '出队唤醒 worker');
      assert.equal(drv.byPath('/steer').length, 1, '注入走 steer（不是 followup）');
      assert.equal(drv.byPath('/prompt').length, 0);
      assert.equal(chat.CHAT_REGISTRY.get('sid-a').since, 7, '登记表记录带本次基线');

      // 终态消息不可再注入
      await assert.rejects(() => chat.injectNow(id, { db: fx.db }), (err) => {
        assert.ok(err instanceof chat.InjectRefused);
        assert.equal(err.message, '该消息已不在排队中（可能已开始发送）');
        return true;
      });
      await assert.rejects(() => chat.injectNow('missing', { db: fx.db }), (err) => {
        assert.equal(err.message, '消息不存在或已回收');
        return true;
      });
      // 族不支持注入（meta.family 非 dsh_plugin）
      const other = seedQueuedMsg(fx, pid, {
        id: 'inj-2', seq: 2, waitState: 'waiting', meta: { family: 'retired', model: '' },
      });
      await assert.rejects(() => chat.injectNow(other, { db: fx.db }), (err) => {
        assert.equal(err.message, '该消息不支持立即注入');
        return true;
      });
      assert.equal(waitq.msgGet('inj-2', { db: fx.db }).state, 'queued', '被拒 ⇒ 消息未动，仍在队列');
    });
  });
});

// ==========================================================================
// ⑤ TurnSubscription 预订阅池（TTL / 上限 / 覆盖 / 同一性）
// ==========================================================================

test('预订阅⑤：只收本 sid 的帧；close 幂等退订；同 sid 覆盖即回收旧订阅', async () => {
  await withFixture('chatm4-s1', async () => {
    const sub = chat.dshSubOpen('s1');
    assert.equal(chat.DSH_SUB.get('s1'), sub);
    assert.ok(dshevents.HUB._subscribers.includes(sub._cb), '已进中枢订阅者列表');

    sub.onFrame({ session_id: 'other', type: 'turn/start' });
    assert.equal(sub.frames.getNowait(), null, '跨会话帧不入队');
    const frame = { session_id: 's1', type: 'turn/start', data: { event_seq: 1 } };
    sub.onFrame(frame);
    assert.deepEqual(sub.frames.getNowait(), frame);
    assert.equal(sub.frames.getNowait(), null);

    sub.close();
    sub.close();                                   // 幂等
    assert.ok(!dshevents.HUB._subscribers.includes(sub._cb), '退订后不在订阅者列表');

    const first = chat.dshSubOpen('s2');
    const second = chat.dshSubOpen('s2');
    assert.equal(chat.DSH_SUB.get('s2'), second, '表里是新的');
    assert.equal(first._closed, true, '同 sid 旧订阅被覆盖即退订');
    assert.ok(!dshevents.HUB._subscribers.includes(first._cb));
    // dshSubDrop 按对象同一性：drop 一个已被替换的旧对象不误删新对象
    chat.dshSubDrop(first);
    assert.equal(chat.DSH_SUB.get('s2'), second);
    chat.dshSubDrop(second);
    assert.equal(chat.DSH_SUB.has('s2'), false);
    assert.ok(!dshevents.HUB._subscribers.includes(second._cb));
  });
});

test('预订阅⑤：TTL 过期回收（出表 + 真退订）', async () => {
  await withFixture('chatm4-s2', async () => {
    const alive = chat.dshSubOpen('alive');
    const stale = chat.dshSubOpen('stale');
    stale.created = Date.now() / 1000 - chat.DSH_SUB_TTL - 1;   // 手动做旧

    const reaped = chat.dshSubReap();
    assert.deepEqual(reaped.map((s) => s.sid), ['stale']);
    assert.equal(stale._closed, false, 'dshSubReap 只出表并返回待退订列表（退订归调用方，照 Python）');
    for (const item of reaped) item.close();
    assert.equal(stale._closed, true);
    assert.equal(chat.DSH_SUB.has('stale'), false);
    assert.equal(chat.DSH_SUB.get('alive'), alive, '未过期的不动');
    assert.ok(!dshevents.HUB._subscribers.includes(stale._cb), 'TTL 回收是真退订（防回调泄漏）');
    // 取口也会顺带回收
    const stale2 = chat.dshSubOpen('stale2');
    stale2.created = Date.now() / 1000 - chat.DSH_SUB_TTL - 1;
    assert.equal(chat.dshSubTake('nobody'), null);
    assert.equal(chat.DSH_SUB.has('stale2'), false);
    alive.close();
  });
});

test('预订阅⑤：条数上限 DSH_SUB_MAX（超出按建订阅时刻从旧到新回收）', async () => {
  await withFixture('chatm4-s3', async () => {
    const overflow = 3;
    const total = chat.DSH_SUB_MAX + overflow;
    const subs = [];
    for (let i = 0; i < total; i += 1) {
      const sub = chat.dshSubOpen(`sub-${i}`);
      // 手工把 created 拉开，保证「最旧的」是确定的（同一毫秒内建 35 个时时刻会打平）
      sub.created = 1000 + i;
      subs.push(sub);
    }
    // 每次 open 后都做了回收，故最终表内只有最后 DSH_SUB_MAX 个
    assert.ok(chat.DSH_SUB.size <= chat.DSH_SUB_MAX,
      `表大小 ${chat.DSH_SUB.size} 应 ≤ ${chat.DSH_SUB_MAX}`);
    for (let i = 0; i < overflow; i += 1) {
      assert.equal(chat.DSH_SUB.has(`sub-${i}`), false, `最旧的 sub-${i} 应被回收`);
      assert.equal(subs[i]._closed, true);
    }
    assert.equal(chat.DSH_SUB.has(`sub-${total - 1}`), true, '最新的一定在表内');
    // 全部回收后表清空
    for (const sub of [...chat.DSH_SUB.values()]) chat.dshSubDrop(sub);
    assert.equal(chat.DSH_SUB.size, 0);
    assert.equal(dshevents.HUB._subscribers.filter((cb) => subs.some((s) => s._cb === cb)).length, 0,
      '被回收的订阅回调全部退订');
  });
});

// ==========================================================================
// ⑤b 等 turn 的两条通道 + 两条收口（与预订阅池同族，缺陷 A 的正面用例）
// ==========================================================================

test('等 turn⑤b：外部会话（owned:false）走全局状态流——预订阅帧口袋接住「早到」的 turn/start', async () => {
  await withFixture('chatm4-e1', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      drv.status = { status: 'running', last_seq: 3 };
      setHub([{ session_id: 's-ext', owned: false, status: 'running', last_seq: 3 }]);

      const since = await chat.dshSend('s-ext', '外部会话消息', false, { db: fx.db });
      assert.equal(since, 3, '基线取自驱动 /status.last_seq');
      const sub = chat.DSH_SUB.get('s-ext');
      assert.ok(sub !== undefined, '外部会话投递前建了预订阅');
      // 「帧早到」：turn/start 在等待器启动**之前**到达（缺陷 A 现场 9~13ms）
      dshevents.HUB._callSubscribers({
        seq: 4, type: 'turn/start', session_id: 's-ext', data: { event_seq: 4 },
      });

      const waiting = chat.waitTurn(fx.dir, 's-ext', 'dsh_plugin', since, '', { db: fx.db });
      setTimeout(() => {
        dshevents.HUB._callSubscribers({
          seq: 5, type: 'turn/end', session_id: 's-ext', data: { reason: { kind: 'completed' } },
        });
      }, 5);
      assert.equal(await waiting, null, 'turn/end 收口 ⇒ 本轮结束（未被 60s 宽限吞掉）');
      assert.equal(chat.DSH_SUB.has('s-ext'), false, '取走即弃（等待器 finally close）');
      assert.equal(sub._closed, true);
      assert.equal(drv.byPath('/prompt').length, 1);
      assert.equal(chat.DSH_INJECT.get('s-ext'), undefined, '旁表取走即弃');

      // 挂起让位：driver/interaction{asked} ⇒ STATE_YIELDED
      await chat.dshSend('s-ext', '再一轮', false, { db: fx.db });
      const yielding = chat.waitTurn(fx.dir, 's-ext', 'dsh_plugin', since, '', { db: fx.db });
      setTimeout(() => {
        dshevents.HUB._callSubscribers({
          seq: 8, type: 'turn/start', session_id: 's-ext', data: { event_seq: 8 },
        });
        dshevents.HUB._callSubscribers({
          seq: 9, type: 'driver/interaction', session_id: 's-ext',
          data: { state: 'asked', interaction: { id: 'q' } },
        });
      }, 5);
      assert.equal(await yielding, chat.STATE_YIELDED);
    });
  });
});

test('等 turn⑤b：全局状态流的两条收口文案——断连与总时限（都按超时口径留痕）', async () => {
  await withFixture('chatm4-e2', async (fx) => {
    const pid = project(fx);
    const logPath = path.join(fx.dir, 'timeout.log');

    // ① 断连（connected=false）⇒ 「状态流断连：Ns 无 turn/end」+ 返回 null
    dshevents.HUB._connected = false;
    assert.equal(await chat.dshWaitTurnViaEvents('s-x', 0, logPath, true, { db: fx.db }), null);
    let text = fs.readFileSync(logPath, 'utf8');
    assert.ok(/### 会话等待 turn 结束超时（状态流断连：0s 无 turn\/end）/.test(text), text);

    // ② 总时限（TS_DSH_WAIT_TURN_TIMEOUT 调小）⇒ 「0.2s 无 turn/end」+ 返回 null
    setHub([{ session_id: 's-x', owned: false, status: 'running', last_seq: 0 }]);
    process.env.TS_DSH_WAIT_TURN_TIMEOUT = '0.2';
    assert.equal(chat.dshWaitTurnLimit(), 0.2);
    const t0 = Date.now();
    assert.equal(await chat.dshWaitTurnViaEvents('s-x', 0, logPath, true, { db: fx.db }), null);
    assert.ok(Date.now() - t0 < 5000, '到点即返回（不再多等一个 TICK）');
    text = fs.readFileSync(logPath, 'utf8');
    assert.ok(text.includes('### 会话等待 turn 结束超时（0.2s 无 turn/end）'), text);
    assert.equal(chat.DSH_SUB.size, 0, '等待器自建订阅也要退订');

    // ③ 非法/非正环境变量回落常量
    process.env.TS_DSH_WAIT_TURN_TIMEOUT = 'abc';
    assert.equal(chat.dshWaitTurnLimit(), chat.DSH_WAIT_TURN_TIMEOUT);
    process.env.TS_DSH_WAIT_TURN_TIMEOUT = '-1';
    assert.equal(chat.dshWaitTurnLimit(), chat.DSH_WAIT_TURN_TIMEOUT);
    delete process.env.TS_DSH_WAIT_TURN_TIMEOUT;
  });
});

test('等 turn⑤b：池内会话走按会话 SSE（turn/end ⇒ null；interaction ⇒ yielded）', async () => {
  await withFixture('chatm4-e3', async (fx) => {
    await withDriver(async (drv) => {
      // turn/end
      drv.sessionFrames = turnOkFrames();
      assert.equal(await chat.dshWaitTurn('sid-a', null, true, '', { db: fx.db }), null);
      // interaction（不让位 ⇒ 继续等，直到链路结束/宽限；这里验证 yielded 分支）
      drv.sessionFrames = [
        { seq: 8, type: 'turn/start', session_id: 'sid-a', data: { event_seq: 8 } },
        { seq: 9, type: 'driver/interaction', session_id: 'sid-a', data: { state: 'asked' } },
      ];
      assert.equal(await chat.dshWaitTurn('sid-a', 0, true, '', { db: fx.db }), chat.STATE_YIELDED);
      // 非 dsh 族：无 turn 可等
      assert.equal(await chat.waitWebBusy(fx.dir, 'sid-a', 'retired', { db: fx.db }), null);
    });
  });
});

test('等 turn⑤b：投递基线的两级来源——驱动 /status 权威优先，拿不到 last_seq 才回落中枢', async () => {
  await withFixture('chatm4-e4', async (fx) => {
    await withDriver(async (drv) => {
      setHub([{ session_id: 's-b', owned: false, status: 'idle', last_seq: 42 }]);
      // 外部会话形状：`/status` 刻意没有 last_seq（T6 修正的现场）⇒ 回落中枢本地值
      drv.status = { status: 'idle' };
      assert.equal(await chat.dshBaselineSince('s-b'), 42);
      // 驱动给了 ⇒ 权威优先（即使与中枢不一致）
      drv.status = { status: 'idle', last_seq: 7 };
      assert.equal(await chat.dshBaselineSince('s-b'), 7);
      // 驱动不可用 ∧ 中枢没有该 sid ⇒ 0（无基线语义）
      delete process.env.TS_AGENT_DRIVER_URL;
      assert.equal(await chat.dshBaselineSince('s-none'), 0);
    });
  });
});

test('等 turn⑤b：I1 安全阀——steer 注入「已在跑的 turn」也能收口（不靠 turn/start 帧）', async () => {
  await withFixture('chatm4-e5', async (fx) => {
    await withDriver(async (drv) => {
      const logPath = path.join(fx.dir, 'i1.log');
      drv.status = { status: 'running', last_seq: 3 };
      setHub([{ session_id: 's-i1', owned: false, status: 'running', last_seq: 3 }]);
      process.env.TS_DSH_WAIT_TURN_TIMEOUT = '1';   // 回归时的兜底时限（正常应远早于它返回）
      const since = await chat.dshSend('s-i1', '插话', true, { db: fx.db });
      assert.equal(since, 3);
      assert.equal(chat.DSH_INJECT.get('s-i1'), true, '旁表记下本次投递是 steer');
      assert.equal(drv.byPath('/steer').length, 1);

      const t0 = Date.now();
      const waiting = chat.dshWaitTurnViaEvents('s-i1', since, logPath, true, { db: fx.db });
      setTimeout(() => {
        // 只喂 turn/end（**没有** turn/start）：本轮的 turn/start 早于订阅，全局流无回放
        dshevents.HUB._callSubscribers({
          seq: 4, type: 'turn/end', session_id: 's-i1', data: { reason: { kind: 'completed' } },
        });
      }, 5);
      assert.equal(await waiting, null);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 900, `I1 播种 started ⇒ 直接认 turn/end（实耗 ${elapsed}ms，未落回 60s 宽限）`);
      assert.ok(!fs.existsSync(logPath), '没有走超时收口（不该留痕）');
    });
  });
});

// ==========================================================================
// ⑤c 宿主会话存活兜底（hostSessionLost / reviveHostSession）
// ==========================================================================

test('宿主兜底⑤c：可信快照 ∧ 无此 sid ⇒ 已失去；resume 接回；回滚阀关闭则不接', async () => {
  await withFixture('chatm4-h1', async (fx) => {
    // 未对齐 ⇒ 一律「未知」（不动）
    dshevents.HUB._connected = true;
    dshevents.HUB._aligned = false;
    assert.equal(chat.hostSessionLost('s-gone'), false);
    // 已对齐 ∧ 注册表无此 sid ⇒ 确已失去
    dshevents.HUB._aligned = true;
    assert.equal(chat.hostSessionLost('s-gone'), true);
    assert.equal(chat.hostSessionLost(''), false);
    // 注册表里有 ⇒ 没失去
    dshevents.HUB._sessions.set('s-live', { session_id: 's-live', owned: true });
    assert.equal(chat.hostSessionLost('s-live'), false);

    await withDriver(async (drv) => {
      assert.equal(await chat.reviveHostSession('s-gone', '/tmp/wt', 'card-1', { db: fx.db }), true);
      const resumed = drv.byPath('/session');
      assert.equal(resumed.length, 1, '确已失去 ⇒ resume 接回');
      assert.deepEqual(resumed[0].body, { session_id: 's-gone', task: 'card-1', cwd: '/tmp/wt' });

      // 接不回（驱动 404）⇒ false（调用方给明确文案，不再发必然 404 的投递）
      drv.sessionFail = true;
      const logs = [];
      const savedLog = console.log;
      console.log = (line) => logs.push(String(line));
      try {
        assert.equal(await chat.reviveHostSession('s-gone', '', '', { db: fx.db }), false);
      } finally {
        console.log = savedLog;
      }
      assert.ok(logs.some((l) => l.includes('会话接回失败 sid=s-gone')));

      // 回滚阀 TS_HOST_SESSION_REVIVE=0 ⇒ 不接回、直接放行（零请求）
      const before = drv.byPath('/session').length;
      process.env.TS_HOST_SESSION_REVIVE = '0';
      assert.equal(await chat.reviveHostSession('s-gone', '', '', { db: fx.db }), true);
      assert.equal(drv.byPath('/session').length, before);
      delete process.env.TS_HOST_SESSION_REVIVE;
    });
  });
});

// ==========================================================================
// ⑥ start / stop / 常量对齐
// ==========================================================================

test('start⑥：组装 family/model 后提交（模型回落项目值）；注入参数透传', async () => {
  await withFixture('chatm4-f1', async (fx) => {
    const pid = project(fx);
    const calls = [];
    chat.setRunnerInstance({
      submitMsg: (id, p, s) => calls.push([id, p, s]),
      removeMsg: () => {},
      unitBusy: () => false,
    });
    const task = { id: 11, session_id: 'sid-t', model: '  ' };
    const proj = { id: pid, agent_path: 'dsh-plugin:/usr/local/bin/dsh', model: 'proj-model' };
    const res = await chat.start(task, proj, '任务消息', false, { db: fx.db });
    assert.equal(res.state, chat.STATE_QUEUED);
    assert.equal(calls.length, 1);
    const wrow = waitq.getActive(waitq.KIND_MSG, res.id, { db: fx.db });
    assert.deepEqual(JSON.parse(wrow.meta), { family: 'dsh_plugin', model: 'proj-model' });
    assert.equal(waitq.msgGet(res.id, { db: fx.db }).task_id, 11);
    // 任务自带模型优先
    const res2 = await chat.start({ id: 12, session_id: 'sid-t2', model: 'task-model' }, proj, 'x', true, { db: fx.db });
    assert.equal(JSON.parse(waitq.getActive(waitq.KIND_MSG, res2.id, { db: fx.db }).meta).model, 'task-model');
    assert.equal(waitq.msgGet(res2.id, { db: fx.db }).inject, 1);
  });
});

test('stop⑥：先取消排队消息，再中断 turn；无记录/非 dsh 记录 ⇒ false', async () => {
  await withFixture('chatm4-f2', async (fx) => {
    await withDriver(async (drv) => {
      const pid = project(fx);
      insertMsg(fx.db, { id: 'st-1', projectId: pid, sid: 'sid-s', message: 'q', state: 'queued', createdAt: 1 });
      chat.register('sid-s', null, 'm', { dshPlugin: true, since: 1 });
      assert.equal(await chat.stop('sid-s', { db: fx.db }), true);
      assert.equal(waitq.msgGet('st-1', { db: fx.db }).state, 'cancelled', '停止先取消排队消息');
      assert.equal(drv.byPath('/cancel').length, 1, '再中断 turn');
      assert.deepEqual(drv.byPath('/cancel')[0].body, { session_id: 'sid-s', keep_inbox: false });

      assert.equal(await chat.stop('nobody', { db: fx.db }), false);
      chat.CHAT_REGISTRY.set('sid-legacy', { dsh_plugin: false });
      assert.equal(await chat.stop('sid-legacy', { db: fx.db }), false);

      // 驱动不可用（未配置）⇒ 吞 DshDriverError 成 false
      delete process.env.TS_AGENT_DRIVER_URL;
      chat.register('sid-s2', null, 'm', { dshPlugin: true, since: 1 });
      assert.equal(await chat.stop('sid-s2', { db: fx.db }), false);
    });
  });
});

test('常量⑥：M4 常量逐条对齐 chat.py', () => {
  assert.equal(chat.MESSAGE_MAX, 20000);
  assert.equal(chat.MSG_KEEP_SEC, 600);
  assert.equal(chat.MSG_MAX, 200);
  assert.equal(chat.TURN_START_GRACE, 60);
  assert.equal(chat.TICK, 2);
  assert.equal(chat.DSH_WAIT_TURN_TIMEOUT, 2700.0);
  assert.equal(chat.DSH_WAIT_TURN_TIMEOUT_ENV, 'TS_DSH_WAIT_TURN_TIMEOUT');
  assert.equal(chat.EXTERNAL_DELIVER_ENV, 'TS_EXTERNAL_DELIVER');
  assert.equal(chat.HOST_REVIVE_ENV, 'TS_HOST_SESSION_REVIVE');
  assert.equal(chat.DSH_SUB_MAX, 32);
  assert.equal(chat.DSH_SUB_TTL, 120.0);
  assert.deepEqual([...chat.CHAT_FAMILIES], ['dsh_plugin']);
  assert.deepEqual(
    [chat.STATE_QUEUED, chat.STATE_RUNNING, chat.STATE_DONE, chat.STATE_YIELDED,
      chat.STATE_ERROR, chat.STATE_CANCELLED],
    ['queued', 'running', 'done', 'yielded', 'error', 'cancelled'],
  );
  // 错误类可 instanceof 判定（端点 400/502 分档的依据）
  assert.ok(new chat.InjectRefused('x') instanceof chat.InjectRefused);
  assert.ok(new chat.DeliveryRefused('x') instanceof chat.DeliveryRefused);
  assert.ok(!(new chat.DeliveryRefused('x') instanceof chat.InjectRefused));
  assert.equal(new chat.InjectRefused('x').name, 'InjectRefused');
  assert.equal(new chat.DeliveryRefused('x').name, 'DeliveryRefused');
  // msgId 形态：毫秒时间戳-自增序号（无冒号，可直接作队列键后缀）
  const id = chat.newMsgId();
  assert.match(id, /^\d{13}-\d+$/);
  assert.notEqual(chat.newMsgId(), id);
});
