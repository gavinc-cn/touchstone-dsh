/**
 * `backend/routes/sessions.js` **三条写端点**单测（M4.5）：chat / chat/inject / chat/stop。
 *
 * 期望值的唯一来源是 `server.py` 与 `chat.py`（不读 Node 实现反推）：
 *   - `_api_session_chat`(4930) / `_api_session_chat_inject`(3781) / `_inject_msg`(3795) /
 *     `_api_session_chat_stop`(4994)，以及 `chat.py:msg_info`(441) / `inject_now`(452) /
 *     `start`(1125) / `stop`(1173)；
 *   - **错误体两种字节形态**逐处判：硬编码字节串（`b'{"error":"…"}'`）⇒ 紧凑无空格；
 *     `json.dumps({"error": …}, ensure_ascii=False)` ⇒ `{"error": "…"}` 带空格。
 *     三处成功体同理：chat 的 200 是 `json.dumps({...})`（带空格 + 键序 = 源码字面序），
 *     inject/stop 的 200 是硬编码 `b'{"ok":true}'`（紧凑）。
 *
 * 请求走**真路由表**（`routes/index.js:dispatch` + `makeContext`）：路径正则、method 门、
 * `ctx.readBody()` 记忆化、`ctx.sessionContext()` 的无响应副作用一起被测到——直调 handler
 * 会漏掉「路由根本没挂上」这类错。全程临时库（`m3fixture` 的真建库序 + 真 SQL 造行），
 * 并用 `TOUCHSTONE_DB` 金丝雀把「漏传 options.db」的失误钉在临时库里（绝不碰生产库）。
 *
 * 三个**必测的照抄点**（Python 注释里写明理由，见 `sessions.js` 写路径段文件头）：
 *   ① except 顺序 DshDriverError → OSError → 裸 RuntimeError(= DeliveryRefused)；
 *   ② 校验顺序 message 空 → 超长 → 族 → sid；
 *   ③ `_inject_msg` 归属三重判定（+任务第四重）都回同一个 404 文案。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as chat from '../lib/chat.js';
import * as dshevents from '../lib/dshevents.js';
import * as waitq from '../lib/waitq.js';
import { makeContext, dispatch } from '../routes/index.js';
import { freshDb, insertMsg, insertProject, insertTask, insertWait } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/**
 * 「像 IncomingMessage」的请求流（`lib/http.js:readJsonBody` 的调用面：`.headers` / `.on`）。
 * `Readable.from` 是关键——延迟到挂上 'data' 监听才开始流动，正好复刻真请求的时序。
 */
function fakeReq({ method = 'POST', headers = {}, body = null } = {}) {
  const chunks = [];
  if (body !== null && body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (text !== '') chunks.push(Buffer.from(text, 'utf8'));
  }
  const stream = Readable.from(chunks, { objectMode: false });
  stream.method = method;
  stream.headers = body === null || body === undefined || chunks.length === 0
    ? headers
    : { 'content-length': String(chunks[0].length), ...headers };
  return stream;
}

/** 记录型 res（只覆盖 `lib/http.js` 的实际调用面）+ 响应写完的时刻（stop 的 await 守卫用） */
class FakeRes {
  constructor() {
    this.status = null;
    this.headers = null;
    this.text = '';
    this.destroyed = false;
    this.endedAt = 0;
  }

  writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; }

  end(buf) {
    if (buf !== undefined && buf !== null) {
      this.text += Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    }
    this.endedAt = Date.now();
  }

  destroy() { this.destroyed = true; }

  get json() { return JSON.parse(this.text); }
}

/** 真 ctx + **真路由表**分派（`path` 不含查询串，与 server.js 的构造一致） */
async function post(fx, path, body, { userId, headers = {} } = {}) {
  const res = new FakeRes();
  const uid = userId === undefined
    ? fx.db.prepare("SELECT id FROM users WHERE username='admin'").get().id
    : userId;
  const ctx = makeContext({
    req: fakeReq({ body, headers }),
    res,
    db: fx.db,
    user: { id: uid },
    path,
    search: '',
  });
  await dispatch(ctx);
  return res;
}

/** 假 runner 单例（`chat.setRunnerInstance` 的注入面：只用到这两个方法） */
function fakeRunner() {
  return {
    submitted: [],
    removed: [],
    submitMsg(msgId, projectId, sid) { this.submitted.push([msgId, projectId, sid]); },
    removeMsg(msgId) { this.removed.push(msgId); },
  };
}

/**
 * 极简假驱动（只覆盖本文件用到的端点）：`/status` → 空闲基线；`/prompt`/`/steer`/`/cancel`
 * → 200 `{ok:true}`。`handlers[path]` 可整体接管某端点（造 4xx/5xx 与延迟响应）。
 */
function startDriver(handlers = {}) {
  const calls = [];
  const state = { cancelDoneAt: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const path = String(req.url || '').split('?')[0];
      calls.push({ method: req.method, path, body });
      const reply = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      if (typeof handlers[path] === 'function') {
        handlers[path]({ req, res, body, reply, state, calls });
        return;
      }
      if (path === '/status') return reply(200, { status: 'idle', last_seq: 7 });
      if (path === '/prompt' || path === '/steer' || path === '/cancel') {
        return reply(200, { ok: true });
      }
      return reply(404, { error: `未知驱动端点 ${path}（假驱动）` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 假驱动挂进 env（用例结束必摘）；`fn` 抛错也保证停服 */
async function withDriver(handlers, fn) {
  const drv = await startDriver(handlers);
  const saved = process.env.TS_AGENT_DRIVER_URL;
  process.env.TS_AGENT_DRIVER_URL = drv.base;
  try {
    return await fn(drv);
  } finally {
    if (saved === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = saved;
    await drv.close();
  }
}

/** 会话族的进程内状态（登记表 / runner 替身 / hub）——用例间必须清干净 */
function clearChatState() {
  chat.CHAT_REGISTRY.clear();
  chat.DSH_BASELINE.clear();
  chat.DSH_INJECT.clear();
  chat.setRunnerInstance(null);
}

/** hub 快照/恢复（`_inject_msg` 不读 hub，但 chat.submit 的前置闸读——造 DeliveryRefused 要用） */
function saveHub() {
  return {
    sessions: dshevents.HUB._sessions,
    connected: dshevents.HUB._connected,
    aligned: dshevents.HUB._aligned,
  };
}

function restoreHub(saved) {
  dshevents.HUB._sessions = saved.sessions;
  dshevents.HUB._connected = saved.connected;
  dshevents.HUB._aligned = saved.aligned;
}

/** 临时库夹具（金丝雀：漏传 options.db 只会打到临时库，绝不碰生产库） */
async function withFixture(tag, fn) {
  const fx = freshDb(tag);
  const hubSaved = saveHub();
  const dbSaved = process.env.TOUCHSTONE_DB;
  process.env.TOUCHSTONE_DB = fx.dbPath;
  try {
    return await fn(fx);
  } finally {
    clearChatState();
    restoreHub(hubSaved);
    if (dbSaved === undefined) delete process.env.TOUCHSTONE_DB;
    else process.env.TOUCHSTONE_DB = dbSaved;
    fx.close();
  }
}

/** 造一个「本人 + 指定 agent_path」的项目 */
function project(fx, opts = {}) {
  return insertProject(fx.db, { name: opts.name || 'p', workDir: fx.dir, ...opts });
}

/** 读某项目下的 msg 等待项行（`_inject_msg` 的归属判定面） */
function waitRowOf(fx, msgId) {
  return fx.db.prepare("SELECT * FROM wait_items WHERE kind='msg' AND target_id=? ORDER BY id DESC")
    .get(String(msgId));
}

// --------------------------------------------------------------------------
// chat：404 / 校验四道闸（顺序即 Python）
// --------------------------------------------------------------------------

test('chat：任务不存在 / 他人任务 ⇒ 404 task not found（紧凑体，且早于 message 校验）', async () => {
  await withFixture('sessw-404', async (fx) => {
    const pid = project(fx);
    // ① 任务不存在（message 也空——404 仍优先，证明归属闸在最前）
    const a = await post(fx, '/api/tasks/999999/session/chat', {});
    assert.equal(a.status, 404);
    assert.equal(a.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(a.text, '{"error":"task not found"}', '硬编码字节串 ⇒ 紧凑');
    // ② 任务存在但项目不归本人（多用户隔离红线；文案与①逐字相同，不泄露存在性）
    const other = fx.db.prepare("INSERT INTO users(id, username, pass_hash, salt, must_change_pw,"
      + " created_at) VALUES (102,'bob','x','',0,'2026-10-12 00:00:00')").run();
    assert.ok(other.changes === 1);
    const pOther = project(fx, { userId: 102, name: 'other', projectDir: '/tmp/other' });
    const tOther = insertTask(fx.db, pOther, { sessionId: 'session-other' });
    const b = await post(fx, `/api/tasks/${tOther}/session/chat`, { message: 'hi' });
    assert.equal(b.status, 404);
    assert.equal(b.text, '{"error":"task not found"}');
    assert.ok(pid > 0);
  });
});

test('chat：message 空 ⇒ 400 `message 不能为空`（含 Python 空白集/假值口径）', async () => {
  await withFixture('sessw-empty', async (fx) => {
    const pid = project(fx, { agentPath: '' });            // 空 agent_path = dsh_plugin 默认族
    const task = insertTask(fx.db, pid, { sessionId: 'session-e1' });
    const path = `/api/tasks/${task}/session/chat`;
    for (const body of [{}, { message: '' }, { message: '   ' }, { message: '\t\n' },
      { message: 0 }, { message: false }, { message: null }, { message: [] }, { message: {} },
      // Python `"\x1c".strip()` 为空（str.isspace 含 \x1c-\x1f），JS `trim()` 不剥它
      { message: '\u001c' }]) {
      const res = await post(fx, path, body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应 400`);
      assert.equal(res.text, '{"error":"message 不能为空"}');
    }
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM chat_msgs').get().n, 0, '校验不通过不落行');
  });
});

test('chat：message 超长 ⇒ 400 `message 过长`；边界按**码点**计（emoji 不翻倍）', async () => {
  await withFixture('sessw-long', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const task = insertTask(fx.db, pid, { sessionId: 'session-l1' });
    const path = `/api/tasks/${task}/session/chat`;
    // 超限：20001 个 ASCII
    const over = await post(fx, path, { message: 'a'.repeat(chat.MESSAGE_MAX + 1) });
    assert.equal(over.status, 400);
    assert.equal(over.text, '{"error":"message 过长"}');
    // 边界放行：正好 20000（真入队，见下一条用例）——这里只要不是 400
    const inst = fakeRunner();
    chat.setRunnerInstance(inst);
    const edge = await post(fx, path, { message: 'b'.repeat(chat.MESSAGE_MAX) });
    assert.equal(edge.status, 200, 'len == MESSAGE_MAX 必须放行（Python `>` 不是 `>=`）');
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM chat_msgs').get().n, 1);
    // 码点口径：20000 个 emoji（UTF-16 长度 40000）Python `len()` = 20000 ⇒ 放行；
    // 用 JS `.length` 判会误 400（这就是 pyLen 的存在理由）
    const emoji = await post(fx, path, { message: '😀'.repeat(chat.MESSAGE_MAX) });
    assert.equal(emoji.status, 200, 'emoji 按码点计数：20000 个 emoji 仍是 20000');
    const overEmoji = await post(fx, path, { message: '😀'.repeat(chat.MESSAGE_MAX + 1) });
    assert.equal(overEmoji.status, 400);
    assert.equal(overEmoji.text, '{"error":"message 过长"}');
  });
});

test('chat：族白名单（409）在 message 之后、sid 之前；sid 空 ⇒ 409（两条文案都紧凑）', async () => {
  await withFixture('sessw-gates', async (fx) => {
    const retired = project(fx, { name: 'retired', projectDir: '/tmp/retired', agentPath: '/usr/local/bin/kimi' });
    const tRetired = insertTask(fx.db, retired, { sessionId: 'session-r1' });
    const rPath = `/api/tasks/${tRetired}/session/chat`;
    // ① 族不支持 ⇒ 409（紧凑）
    const a = await post(fx, rPath, { message: 'hi' });
    assert.equal(a.status, 409);
    assert.equal(a.text, '{"error":"该 agent 暂不支持对话"}');
    // ② 顺序：退场族 + 空 message ⇒ 仍是 400（message 闸在族闸之前）
    const b = await post(fx, rPath, {});
    assert.equal(b.status, 400);
    assert.equal(b.text, '{"error":"message 不能为空"}');
    // ③ 顺序：退场族 + 无 sid ⇒ 仍是 409 族文案（族闸在 sid 闸之前）
    const tRetired2 = insertTask(fx.db, retired, { name: 'r2' });
    const c = await post(fx, `/api/tasks/${tRetired2}/session/chat`, { message: 'hi' });
    assert.equal(c.status, 409);
    assert.equal(c.text, '{"error":"该 agent 暂不支持对话"}');
    // ④ dsh 族 + 无 sid ⇒ 409 会话尚未生成（紧凑）
    const pid = project(fx, { agentPath: '' });
    const noSid = insertTask(fx.db, pid, {});
    const d = await post(fx, `/api/tasks/${noSid}/session/chat`, { message: 'hi' });
    assert.equal(d.status, 409);
    assert.equal(d.text, '{"error":"会话尚未生成（首轮执行后才有）"}');
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM chat_msgs').get().n, 0);
  });
});

// --------------------------------------------------------------------------
// chat：正常入队（真落 chat_msgs + wait_items）
// --------------------------------------------------------------------------

test('chat：正常 ⇒ 200（带空格 + 键序=Python 字面序）+ 真落 chat_msgs/wait_items 两行', async () => {
  await withFixture('sessw-ok', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const task = insertTask(fx.db, pid, { sessionId: 'session-ok1' });
    const inst = fakeRunner();
    chat.setRunnerInstance(inst);

    const res = await post(fx, `/api/tasks/${task}/session/chat`, { message: '  你好  ' });
    assert.equal(res.status, 200);
    const rec = res.json;
    assert.equal(rec.ok, true);
    assert.equal(rec.queued, false, '项目空闲 ⇒ queued=false');
    assert.equal(rec.state, 'queued');
    assert.equal(rec.prompt_id, '', 'Python rec 里没有 prompt_id 键 ⇒ 恒空串');
    // 字节级：`json.dumps({"ok":…}, ensure_ascii=False)` 的键序 = 源码字面序，中文原样
    assert.equal(res.text, `{"ok": true, "queued": false, "msg_id": "${rec.msg_id}",`
      + ' "state": "queued", "prompt_id": ""}');
    assert.match(rec.msg_id, /^\d+-\d+$/);

    // ① chat_msgs 行：message 已 strip；inject=0；task_id 挂钩
    const row = waitq.msgGet(rec.msg_id, { db: fx.db });
    assert.equal(row.project_id, pid);
    assert.equal(row.sid, 'session-ok1');
    assert.equal(row.task_id, task);
    assert.equal(row.message, '你好', 'Python `str(...).strip()`');
    assert.equal(row.state, 'queued');
    assert.equal(row.inject, 0);
    // ② wait_items 行：kinds=msg、state=waiting、meta 定格 family/model
    const wrow = waitRowOf(fx, rec.msg_id);
    assert.equal(wrow.project_id, pid);
    assert.equal(wrow.state, 'waiting');
    assert.deepEqual(JSON.parse(wrow.meta), { family: 'dsh_plugin', model: '' });
    // ③ 提交进 runner 的入口被调用（有单例 ⇒ 只入队，不真投递）
    assert.deepEqual(inst.submitted, [[rec.msg_id, pid, 'session-ok1']]);
    assert.equal(inst.removed.length, 0);

    // ④ 项目忙（幽灵 running `t:` 行堵死前缀窗口）⇒ queued=true，其余不变
    const ghost = insertTask(fx.db, pid, { name: 'ghost', status: 'running' });
    insertWait(fx.db, { projectId: pid, kind: 'task', targetId: ghost, state: 'running', seq: 1 });
    const busy = await post(fx, `/api/tasks/${task}/session/chat`, { message: '忙时', inject: true });
    assert.equal(busy.status, 200);
    assert.equal(busy.json.queued, true, '同项目有运行前缀行 ⇒ 必然排队');
    const busyRow = waitq.msgGet(busy.json.msg_id, { db: fx.db });
    assert.equal(busyRow.inject, 1, 'inject 真值透传（Python `bool(body.get("inject"))`）');
    assert.equal(busyRow.message, '忙时');
    // ⑤ 假值/非字符串 message：Python `str(x or "")` 口径（0 ⇒ 空 ⇒ 400；5 ⇒ "5"）
    const zero = await post(fx, `/api/tasks/${task}/session/chat`, { message: 0 });
    assert.equal(zero.status, 400, '`0 or ""` ⇒ 空串 ⇒ 400');
    const five = await post(fx, `/api/tasks/${task}/session/chat`, { message: 5 });
    assert.equal(five.status, 200);
    assert.equal(waitq.msgGet(five.json.msg_id, { db: fx.db }).message, '5', 'Python str(5)');
  });
});

// --------------------------------------------------------------------------
// chat：三档异常（照抄 Python 的 except 顺序）
// --------------------------------------------------------------------------

test('chat：DshDriverError 409 ⇒ 409（带空格、用驱动文案）；其余码 ⇒ 500 `agent 调用失败: …`', async () => {
  await withFixture('sessw-driverr', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const task = insertTask(fx.db, pid, { sessionId: 'session-d1' });
    const path = `/api/tasks/${task}/session/chat`;
    chat.setRunnerInstance(null);                          // 无单例 ⇒ chat 同步执行体，异常直达端点

    // ① 驱动 409（会话运行中）⇒ 端点 409 + `json.dumps` 的带空格体，文案取驱动的 error 字段
    await withDriver({
      '/prompt': ({ reply }) => reply(409, { error: '会话运行中' }),
    }, async (drv) => {
      const res = await post(fx, path, { message: 'hi' });
      assert.equal(res.status, 409);
      assert.equal(res.text, '{"error": "会话运行中"}');
      assert.equal(drv.calls.filter((c) => c.path === '/prompt').length, 1);
      // 消息行落 error（chat.submit 的失败收口），不是 queued
      const row = fx.db.prepare('SELECT * FROM chat_msgs ORDER BY created_at DESC, id DESC').get();
      assert.equal(row.state, 'error');
    });
    // ② 驱动 500 ⇒ 端点 500 + `agent 调用失败: <str(e)>`（Python 的 str(e) 是纯消息）
    await withDriver({
      '/prompt': ({ reply }) => reply(500, { error: '驱动炸了' }),
    }, async () => {
      const res = await post(fx, path, { message: 'hi' });
      assert.equal(res.status, 500);
      assert.equal(res.text, '{"error": "agent 调用失败: 驱动炸了"}');
    });
    // ③ 未配置驱动（`-1`）也走 500 档，文案来自 dshdriver 的常量
    const res = await post(fx, path, { message: 'hi' });
    assert.equal(res.status, 500);
    assert.equal(res.text,
      '{"error": "agent 调用失败: 未配置 dsh agent 驱动（非插件形态或插件未下发驱动地址）"}');
  });
});

test('chat：DeliveryRefused（投递前置闸）⇒ 400 + 闸的中文文案（排在 DshDriverError 之后）', async () => {
  await withFixture('sessw-gate', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const task = insertTask(fx.db, pid, { sessionId: 'session-g1' });
    chat.setRunnerInstance(null);
    // hub：在线 + 已对齐 + 该 sid 是**外部会话**且宿主无活 agent ⇒ externalPreflight 拒投
    const saved = saveHub();
    dshevents.HUB._connected = true;
    dshevents.HUB._aligned = true;
    dshevents.HUB._sessions = new Map([['session-g1',
      { session_id: 'session-g1', owned: false, status: 'unknown' }]]);
    try {
      await withDriver({}, async (drv) => {
        const res = await post(fx, `/api/tasks/${task}/session/chat`, { message: 'hi' });
        assert.equal(res.status, 400, '闸拒投是 400（Python 的裸 RuntimeError 档），不是 500');
        assert.equal(res.text, '{"error": "会话已结束，无法投递（宿主无活动 agent）"}');
        // 英文模式（T10 R18 扩展）：lib 抛的 DeliveryRefused 也按请求语言整条英文化
        const en = await post(fx, `/api/tasks/${task}/session/chat`, { message: 'hi' },
          { headers: { 'X-TS-Lang': 'en' } });
        assert.equal(en.status, 400);
        assert.equal(en.text,
          '{"error": "The session has ended and cannot receive deliveries (no active agent in the host)"}');
        assert.equal(drv.calls.length, 0, '闸在投递之前：驱动一个请求都不该收到');
        // 消息未落行（Python：`提交首行前置闸`，chat_msgs 查不到这次发送）
        assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM chat_msgs').get().n, 0);
      });
    } finally {
      dshevents.HUB._sessions = saved.sessions;
      dshevents.HUB._connected = saved.connected;
      dshevents.HUB._aligned = saved.aligned;
    }
  });
});

// --------------------------------------------------------------------------
// inject：404 四重归属 + 400 两档
// --------------------------------------------------------------------------

test('inject：任务不存在 ⇒ 404；无 sid ⇒ 409（紧凑体）', async () => {
  await withFixture('sessw-inj-404t', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const a = await post(fx, '/api/tasks/999999/session/chat/inject', { msg_id: 'm1' });
    assert.equal(a.status, 404);
    assert.equal(a.text, '{"error":"task not found"}');
    const noSid = insertTask(fx.db, pid, {});
    const b = await post(fx, `/api/tasks/${noSid}/session/chat/inject`, { msg_id: 'm1' });
    assert.equal(b.status, 409);
    assert.equal(b.text, '{"error":"会话尚未生成（首轮执行后才有）"}');
  });
});

test('inject：归属四重判定（不存在/sid/project_id/task_id）都回同一个 404 文案', async () => {
  await withFixture('sessw-inj-own', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const sid = 'session-i1';
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const otherTask = insertTask(fx.db, pid, { name: 't2', sessionId: sid });
    const otherProj = project(fx, { name: 'p2', projectDir: '/tmp/p2', agentPath: '' });
    const path = `/api/tasks/${task}/session/chat/inject`;
    const NOT_FOUND = '{"error": "消息不存在或不在该会话下"}';   // json.dumps ⇒ 带空格

    // ① msg_id 不存在（三种形态：查无此 id / 空串 / null）
    for (const msgId of ['no-such-msg', '', null, undefined]) {
      const res = await post(fx, path, { msg_id: msgId });
      assert.equal(res.status, 404, `msg_id=${JSON.stringify(msgId)}`);
      assert.equal(res.text, NOT_FOUND);
    }
    // ② sid 不符
    insertMsg(fx.db, { id: 'm-sid', projectId: pid, sid: 'session-other', taskId: task });
    const b = await post(fx, path, { msg_id: 'm-sid' });
    assert.equal(b.status, 404);
    assert.equal(b.text, NOT_FOUND);
    // ③ project_id 不符（同 sid、同 task_id，但消息挂在别的项目下）
    insertMsg(fx.db, { id: 'm-proj', projectId: otherProj, sid, taskId: task });
    const c = await post(fx, path, { msg_id: 'm-proj' });
    assert.equal(c.status, 404);
    assert.equal(c.text, NOT_FOUND);
    // ④ task_id 不符（任务路径的第四重；同项目同 sid）
    insertMsg(fx.db, { id: 'm-task', projectId: pid, sid, taskId: otherTask });
    const d = await post(fx, path, { msg_id: 'm-task' });
    assert.equal(d.status, 404);
    assert.equal(d.text, NOT_FOUND);
    // ⑤ 四重全对 ⇒ 不再是 404。注意还需**活跃等待项**把 family 定格成 dsh_plugin：
    //    Python `_msg_meta(None)` = {} ⇒ `meta.get("family") != "dsh_plugin"` ⇒ 同样是
    //    InjectRefused（400「该消息不支持立即注入」）——这里造全，让它走到投递档
    insertMsg(fx.db, { id: 'm-ok', projectId: pid, sid, taskId: task, state: 'queued' });
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: 'm-ok', state: 'waiting', seq: 1,
      meta: JSON.stringify({ family: 'dsh_plugin', model: '' }),
    });
    const e = await post(fx, path, { msg_id: 'm-ok' });
    assert.equal(e.status, 502, '归属正确后进投递档（无驱动 ⇒ 502）');
    assert.ok(e.text.startsWith('{"error": "注入失败：'), e.text);
  });
});

test('inject：族不支持 ⇒ 400；InjectRefused ⇒ 400（消息仍在队列、状态不变）', async () => {
  await withFixture('sessw-inj-400', async (fx) => {
    const retired = project(fx, { name: 'retired', projectDir: '/tmp/retired', agentPath: 'kimi' });
    const tRetired = insertTask(fx.db, retired, { sessionId: 'session-r' });
    insertMsg(fx.db, { id: 'm-r', projectId: retired, sid: 'session-r', taskId: tRetired });
    const a = await post(fx, `/api/tasks/${tRetired}/session/chat/inject`, { msg_id: 'm-r' });
    assert.equal(a.status, 400);
    assert.equal(a.text, '{"error": "该 agent 族不支持立即注入"}');

    // dsh 族，但消息不在排队中（state=running）⇒ InjectRefused ⇒ 400 + Python 原文案
    const pid = project(fx, { agentPath: '' });
    const sid = 'session-i2';
    const task = insertTask(fx.db, pid, { sessionId: sid });
    insertMsg(fx.db, { id: 'm-run', projectId: pid, sid, taskId: task, state: 'running' });
    const b = await post(fx, `/api/tasks/${task}/session/chat/inject`, { msg_id: 'm-run' });
    assert.equal(b.status, 400);
    assert.equal(b.text, '{"error": "该消息已不在排队中（可能已开始发送）"}');
    // 英文模式：InjectRefused 同样按请求语言整条英文化
    const en = await post(fx, `/api/tasks/${task}/session/chat/inject`, { msg_id: 'm-run' },
      { headers: { 'X-TS-Lang': 'en' } });
    assert.equal(en.status, 400);
    assert.equal(en.text,
      '{"error": "The message is no longer queued (it may have started sending)"}');
    assert.equal(waitq.msgGet('m-run', { db: fx.db }).state, 'running', '被拒 ⇒ 消息未动');
  });
});

// --------------------------------------------------------------------------
// inject：200（真驱动 steer）与 502（投递失败回滚）
// --------------------------------------------------------------------------

test('inject：排队消息 ⇒ 200 `{"ok":true}`（紧凑）+ steer 投递 + 两表双终态', async () => {
  await withFixture('sessw-inj-ok', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const sid = 'session-i3';
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const inst = fakeRunner();
    chat.setRunnerInstance(inst);
    insertMsg(fx.db, {
      id: 'm-go', projectId: pid, sid, taskId: task, message: '立即注入', createdAt: 1,
    });
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: 'm-go', state: 'waiting', seq: 1,
      meta: JSON.stringify({ family: 'dsh_plugin', model: '' }),
    });
    await withDriver({}, async (drv) => {
      const res = await post(fx, `/api/tasks/${task}/session/chat/inject`, { msg_id: 'm-go' });
      assert.equal(res.status, 200);
      assert.equal(res.text, '{"ok":true}', '硬编码字节串 ⇒ 紧凑（ctx.json 会多一个空格）');
      // 投递：先 GET /status 取基线，再 POST /steer（「立即注入」的语义，不是 followup）
      assert.equal(drv.calls.filter((c) => c.path === '/status').length, 1);
      assert.equal(drv.calls.filter((c) => c.path === '/steer').length, 1);
      assert.equal(drv.calls.filter((c) => c.path === '/prompt').length, 0);
      assert.equal(drv.calls.find((c) => c.path === '/steer').body.session_id, sid);
      // 双终态：chat_msgs done + 等待项 done；并把单元从统一队列摘除
      assert.equal(waitq.msgGet('m-go', { db: fx.db }).state, 'done');
      assert.equal(waitRowOf(fx, 'm-go').state, 'done');
      assert.deepEqual(inst.removed, ['m-go']);
    });
  });
});

test('inject：投递失败 ⇒ 502 `注入失败：…`，消息按原位次退回排队（不丢）', async () => {
  await withFixture('sessw-inj-502', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const sid = 'session-i4';
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const inst = fakeRunner();
    chat.setRunnerInstance(inst);
    insertMsg(fx.db, { id: 'm-bad', projectId: pid, sid, taskId: task, createdAt: 1 });
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: 'm-bad', state: 'waiting', seq: 7,
      meta: JSON.stringify({ family: 'dsh_plugin', model: '' }),
    });
    await withDriver({
      '/steer': ({ reply }) => reply(500, { error: 'steer 炸了' }),
    }, async () => {
      const res = await post(fx, `/api/tasks/${task}/session/chat/inject`, { msg_id: 'm-bad' });
      assert.equal(res.status, 502);
      assert.equal(res.text, '{"error": "注入失败：steer 炸了"}');
      // 回滚：消息退回 queued、等待项退回 waiting 且 seq 不动（原位次）
      assert.equal(waitq.msgGet('m-bad', { db: fx.db }).state, 'queued');
      const wrow = waitRowOf(fx, 'm-bad');
      assert.equal(wrow.state, 'waiting');
      assert.equal(wrow.seq, 7);
      assert.deepEqual(inst.submitted, [['m-bad', pid, sid]], '退回后重新提交给 runner');
    });
  });
});

// --------------------------------------------------------------------------
// stop：404 / 200（含 await 守卫）
// --------------------------------------------------------------------------

test('stop：任务不存在 ⇒ 404 task not found（紧凑体）；无 sid ⇒ 照常 200（Python `or ""`）', async () => {
  await withFixture('sessw-stop-404', async (fx) => {
    const res = await post(fx, '/api/tasks/999999/session/chat/stop', undefined);
    assert.equal(res.status, 404);
    assert.equal(res.text, '{"error":"task not found"}');
    // Python `chat.stop(task["session_id"] or "")`：空 sid 不报错——`cancel_queued(sid="")`
    // 直接返回 0、`_CHATS.get("")` 取不到 ⇒ 响应仍是 200（照抄，不「顺手」改成 409）
    const pid = project(fx, { agentPath: '' });
    const noSid = insertTask(fx.db, pid, {});
    const b = await post(fx, `/api/tasks/${noSid}/session/chat/stop`, {});
    assert.equal(b.status, 200);
    assert.equal(b.text, '{"ok":true}');
  });
});

test('stop：200 `{"ok":true}`（紧凑）+ 取消该会话排队消息 + /cancel 真被 await 完', async () => {
  await withFixture('sessw-stop-ok', async (fx) => {
    const pid = project(fx, { agentPath: '' });
    const sid = 'session-s1';
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const inst = fakeRunner();
    chat.setRunnerInstance(inst);
    // ① 该会话两条排队消息（本次请求体**非空**——stop 不消费 body，但读体时机照 Python）
    insertMsg(fx.db, { id: 's-q1', projectId: pid, sid, taskId: task, message: 'a', createdAt: 1 });
    insertMsg(fx.db, { id: 's-q2', projectId: pid, sid, taskId: task, message: 'b', createdAt: 2 });
    // ② 另一会话的排队消息不得被误伤（cancel_queued(sid=sid) 是按 sid 过滤）
    insertMsg(fx.db, { id: 's-other', projectId: pid, sid: 'session-other', message: 'c', createdAt: 3 });
    // ③ 登记表里要有 dsh 记录，chat.stop 才会真去中断（Python `_CHATS.get(sid)`）
    chat.register(sid, task, '跑', { dshPlugin: true });

    await withDriver({
      // /cancel 延迟 60ms 才回：把「端点在响应前真的等完了中断」变成可判定事实
      '/cancel': ({ reply, state }) => {
        setTimeout(() => { state.cancelDoneAt = Date.now(); reply(200, { ok: true }); }, 60);
      },
    }, async (drv) => {
      const res = await post(fx, `/api/tasks/${task}/session/chat/stop`, { ignored: 1 });
      assert.equal(res.status, 200);
      assert.equal(res.text, '{"ok":true}', '硬编码字节串 ⇒ 紧凑');
      // ① 排队消息被取消（chat.stop 第一件事：cancel_queued(sid=sid)）
      assert.equal(waitq.msgGet('s-q1', { db: fx.db }).state, 'cancelled');
      assert.equal(waitq.msgGet('s-q2', { db: fx.db }).state, 'cancelled');
      assert.equal(waitq.msgGet('s-other', { db: fx.db }).state, 'queued', '别的会话不受影响');
      assert.deepEqual(inst.removed.sort(), ['s-q1', 's-q2']);
      // ② 中断真发出且**已 await**：/cancel 的响应先于本端点的响应
      assert.equal(drv.calls.filter((c) => c.method === 'POST' && c.path === '/cancel').length, 1);
      assert.equal(drv.calls.find((c) => c.path === '/cancel').body.session_id, sid);
      assert.ok(drv.state.cancelDoneAt > 0, '假驱动的 /cancel 已响应');
      assert.ok(res.endedAt >= drv.state.cancelDoneAt,
        '漏 await chat.stop 时端点在 /cancel 返回前就写响应（本断言即守卫）');
    });
  });
});

// --------------------------------------------------------------------------
// profile：驱动 HTTP 错误的 detail 必须保留（T10 fix round 2 回归）
// --------------------------------------------------------------------------

test('profile：驱动 5xx 的 detail 在中文/en 都保留；无 detail 才回落通用文案', async () => {
  await withFixture('sessw-profile-502', async (fx) => {
    const pid = project(fx);
    const task = insertTask(fx.db, pid, { sessionId: 'session-p1' });
    const path = `/api/tasks/${task}/session/profile`;

    // ① 驱动正文带 `error` ⇒ `.message` 就是 detail；中文无头必须保持旧字节（detail 原样，
    //    不能再被「驱动返回 HTTP <status>」覆盖掉），英文给「Driver returned HTTP …: detail」。
    await withDriver({
      '/model': ({ reply }) => reply(500, { error: '宿主崩了' }),
    }, async () => {
      const zh = await post(fx, path, { reasoning_effort: 'high' });
      assert.equal(zh.status, 502);
      assert.equal(zh.text, '{"error": "宿主崩了"}',
        '中文无头：detail 必须逐字节保留（旧版 pyStrErr(e) 的输出）');
      const en = await post(fx, path, { reasoning_effort: 'high' },
        { headers: { 'X-TS-Lang': 'en' } });
      assert.equal(en.status, 502);
      assert.equal(en.text, '{"error": "Driver returned HTTP 500: 宿主崩了"}');
    });

    // ② 正文非 JSON ⇒ detail 为空，回落「驱动返回 HTTP <status>」（中英各一条）。
    await withDriver({
      '/model': ({ res }) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not json');
      },
    }, async () => {
      const zh = await post(fx, path, { reasoning_effort: 'high' });
      assert.equal(zh.status, 502);
      assert.equal(zh.text, '{"error": "驱动返回 HTTP 500"}');
      const en = await post(fx, path, { reasoning_effort: 'high' },
        { headers: { 'X-TS-Lang': 'en' } });
      assert.equal(en.status, 502);
      assert.equal(en.text, '{"error": "Driver returned HTTP 500"}');
    });
  });
});
