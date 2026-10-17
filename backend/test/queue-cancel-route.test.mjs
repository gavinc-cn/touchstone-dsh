/**
 * 「取消排队」端点单测（`mode=cancel_queue`；node --test，零依赖）——2026-10-17。
 *
 * 背景（用户报障）：会话窗那个「取消排队」按钮原先借用「停止」链路（`stop_card` /
 * `chat.stop`），停止回执只说明**轮次**有没有被打断：没有在跑的轮次时驱动 404 ⇒
 * `stopped:false` ⇒ 前端弹「该会话未在运行或无法停止」并提前 return，于是消息其实已被
 * 取消、界面却仍显示「排队中」且文字不回输入框。本批把「取消排队」拆成独立的平台侧动作
 * （不碰轮次、对池外会话同样有效），并把被取消消息的**全文**回带给前端。
 *
 * 覆盖验收点：
 *   ① 任务端点 `POST /api/tasks/<id>/session/chat/stop`：不带体 ⇒ 原样停止、响应体
 *      **紧凑字节串** `{"ok":true}` 一字不变（旧前端不破）；`mode=cancel_queue` ⇒ 只取消
 *      排队消息、回带 `{ok,cancelled,msgs}`（json.dumps 形态）。
 *   ② 看板端点 `POST .../board/cards/<cid>/stop`：不带体 ⇒ `{"ok": true, "stopped": …}`
 *      一字不变；`mode=cancel_queue` ⇒ 按卡取消。
 *   ③ `msg_id` 单条口径的**归属判定**（任务按 task_id、看板按 card_id）——不命中同一个
 *      404 文案（不细分，避免暴露他人消息是否存在）。
 *   ④ 回带的 `text` 是**全文**（展示面 120 字截断不回流到输入框）；`cancelled=0` 不是错误。
 *
 * 走**真路由表**（`makeContext` + `dispatch`）：分派顺序、`ctx.readBody` 记忆化、两种正文
 * 字节形态都在链路上，直接调 handler 会漏掉这些。全程临时库（`m3fixture`），不碰生产库。
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as waitq from '../lib/waitq.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertCard, insertMsg, insertProject, insertTask } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台（照 `board-write-route.test.mjs`：真 ctx、假 res/req）
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: null, headers: null, body: null, destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) { cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'); },
      destroy() { cap.destroyed = true; },
    },
  };
}

function fakeReq(method, body) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = text.length ? { 'content-length': String(text.length) } : {};
  stream.method = method;
  return stream;
}

function setup(tag) {
  const fx = freshDb(`queue-cancel-${tag}`);
  const pid = insertProject(fx.db, { userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir });
  const admin = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, pid, admin };
}

async function call(env, method, target, { body } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body), res, db: env.db, user: env.admin, path: target, search: '',
  });
  const hit = await dispatch(ctx);
  return {
    hit,
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

// --------------------------------------------------------------------------
// ① 任务端点
// --------------------------------------------------------------------------

test('任务 stop 端点：不带体 ⇒ 旧语义 + 紧凑 `{"ok":true}` 一字不变', async () => {
  const s = setup('task-default');
  const tid = insertTask(s.db, s.pid, { sessionId: 'sid-t1' });
  insertMsg(s.db, { id: 't-1', projectId: s.pid, sid: 'sid-t1', taskId: tid, message: 'q', state: 'queued' });
  const r = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`);
  assert.equal(r.status, 200);
  assert.equal(r.hit, true);
  assert.equal(r.text(), '{"ok":true}', '紧凑字节串（Python 是硬编码 b\'{"ok":true}\'）');
  // 缺省＝停止：仍走 chat.stop（内里先取消排队消息，旧行为不变，U4 拆分属另一批）
  assert.equal(waitq.msgGet('t-1', { db: s.db }).state, 'cancelled');
  s.close();
});

test('任务 stop 端点 mode=cancel_queue：只取消排队、回带全文（不截 120 字）', async () => {
  const s = setup('task-cancel');
  const tid = insertTask(s.db, s.pid, { sessionId: 'sid-t2' });
  const long = '长'.repeat(200);
  insertMsg(s.db, { id: 't-2a', projectId: s.pid, sid: 'sid-t2', taskId: tid, message: long, state: 'queued', createdAt: 1 });
  insertMsg(s.db, { id: 't-2b', projectId: s.pid, sid: 'sid-t2', taskId: tid, message: '第二条', state: 'queued', createdAt: 2 });
  insertMsg(s.db, { id: 't-2c', projectId: s.pid, sid: 'sid-t2', taskId: tid, message: '跑着的', state: 'running', createdAt: 3 });
  const r = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`, { body: { mode: 'cancel_queue' } });
  assert.equal(r.status, 200);
  assert.equal(r.text(), '{"ok": true, "cancelled": 2, "msgs": ['
    + `{"id": "t-2a", "text": "${long}"}, {"id": "t-2b", "text": "第二条"}]}`,
  'json.dumps(ensure_ascii=False) 形态：带空格、中文原样');
  assert.equal(waitq.msgGet('t-2a', { db: s.db }).state, 'cancelled');
  assert.equal(waitq.msgGet('t-2c', { db: s.db }).state, 'running', '执行中的不被取消');
  s.close();
});

test('任务 stop 端点 mode=cancel_queue + msg_id：单条口径与归属判定（不命中同一个 404）', async () => {
  const s = setup('task-msg');
  const tid = insertTask(s.db, s.pid, { sessionId: 'sid-t3' });
  const other = insertTask(s.db, s.pid, { sessionId: 'sid-t3x', name: 'other' });
  insertMsg(s.db, { id: 't-3a', projectId: s.pid, sid: 'sid-t3', taskId: tid, message: 'A', state: 'queued', createdAt: 1 });
  insertMsg(s.db, { id: 't-3b', projectId: s.pid, sid: 'sid-t3', taskId: tid, message: 'B', state: 'queued', createdAt: 2 });
  insertMsg(s.db, { id: 't-3c', projectId: s.pid, sid: 'sid-t3x', taskId: other, message: 'C', state: 'queued' });

  const one = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`,
    { body: { mode: 'cancel_queue', msg_id: 't-3b' } });
  assert.equal(one.text(), '{"ok": true, "cancelled": 1, "msgs": [{"id": "t-3b", "text": "B"}]}');
  assert.equal(waitq.msgGet('t-3a', { db: s.db }).state, 'queued', '不牵连同会话其它排队消息');

  const alien = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`,
    { body: { mode: 'cancel_queue', msg_id: 't-3c' } });
  assert.equal(alien.status, 404);
  assert.equal(alien.text(), '{"error": "消息不存在或不在该会话下"}');
  assert.equal(waitq.msgGet('t-3c', { db: s.db }).state, 'queued', '越权消息不动');

  const unknown = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`,
    { body: { mode: 'cancel_queue', msg_id: '不存在' } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text(), '{"error": "消息不存在或不在该会话下"}');
  s.close();
});

test('任务 stop 端点：未知 mode 按 stop 处理（缺省兼容）；任务不存在仍 404 紧凑体', async () => {
  const s = setup('task-mode');
  const tid = insertTask(s.db, s.pid, { sessionId: 'sid-t4' });
  const r = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`, { body: { mode: 'stop' } });
  assert.equal(r.text(), '{"ok":true}');
  const bogus = await call(s, 'POST', `/api/tasks/${tid}/session/chat/stop`, { body: { mode: 42 } });
  assert.equal(bogus.text(), '{"ok":true}', '非字符串 mode 也走停止（Python `(body.get("mode") or "")`）');
  const missing = await call(s, 'POST', '/api/tasks/999999/session/chat/stop', { body: { mode: 'cancel_queue' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.text(), '{"error":"task not found"}');
  s.close();
});

// --------------------------------------------------------------------------
// ② 看板端点
// --------------------------------------------------------------------------

test('看板 stop 端点：不带体 ⇒ `{"ok": true, "stopped": …}` 一字不变；mode=cancel_queue 按卡取消', async () => {
  const s = setup('board');
  const cid = insertCard(s.db, s.pid, { title: 'C1', columnKey: 'blocked' });
  const other = insertCard(s.db, s.pid, { title: 'C2', columnKey: 'blocked' });
  insertMsg(s.db, { id: 'b-1', projectId: s.pid, sid: 'sid-b1', cardId: cid, message: '甲', state: 'queued', createdAt: 1 });
  insertMsg(s.db, { id: 'b-2', projectId: s.pid, sid: 'sid-b2', cardId: cid, message: '乙', state: 'queued', createdAt: 2 });
  insertMsg(s.db, { id: 'b-3', projectId: s.pid, sid: 'sid-b3', cardId: other, message: '丙', state: 'queued' });

  const stop = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${cid}/stop`);
  assert.equal(stop.status, 200);
  assert.equal(stop.text(), '{"ok": true, "stopped": false}',
    '无在管会话/无 sid ⇒ stopped:false，但响应形态与旧版一字不变');
  assert.equal(waitq.msgGet('b-1', { db: s.db }).state, 'cancelled', '缺省＝停止：内里仍取消排队（旧行为）');

  // 缺省停止已把该卡的两条排队消息带走（旧语义）；重造一条验 mode=cancel_queue 的落点
  insertMsg(s.db, { id: 'b-2b', projectId: s.pid, sid: 'sid-b2', cardId: cid, message: '乙', state: 'queued', createdAt: 3 });
  const cancelled = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${cid}/stop`,
    { body: { mode: 'cancel_queue' } });
  assert.equal(cancelled.text(), '{"ok": true, "cancelled": 1, "msgs": [{"id": "b-2b", "text": "乙"}]}');
  assert.equal(waitq.msgGet('b-3', { db: s.db }).state, 'queued', '别人卡的排队消息不动');

  const alien = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${cid}/stop`,
    { body: { mode: 'cancel_queue', msg_id: 'b-3' } });
  assert.equal(alien.status, 404);
  assert.equal(alien.text(), '{"error": "消息不存在或不在该会话下"}');
  s.close();
});

test('看板 stop 端点 mode=cancel_queue + msg_id：本卡消息可取消（行内「取消」按钮的落点）', async () => {
  const s = setup('board-msg');
  const cid = insertCard(s.db, s.pid, { title: 'C3', columnKey: 'blocked' });
  insertMsg(s.db, { id: 'b-4', projectId: s.pid, sid: 'sid-b4', cardId: cid, message: '单条', state: 'queued' });
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${cid}/stop`,
    { body: { mode: 'cancel_queue', msg_id: 'b-4' } });
  assert.equal(r.text(), '{"ok": true, "cancelled": 1, "msgs": [{"id": "b-4", "text": "单条"}]}');
  assert.equal(waitq.msgGet('b-4', { db: s.db }).state, 'cancelled');
  s.close();
});

test('看板 stop 端点：cancelled=0 不是错误（消息已被 worker 抢走执行）', async () => {
  const s = setup('board-race');
  const cid = insertCard(s.db, s.pid, { title: 'C4', columnKey: 'blocked' });
  insertMsg(s.db, { id: 'b-5', projectId: s.pid, sid: 'sid-b5', cardId: cid, message: '已开跑', state: 'running' });
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${cid}/stop`,
    { body: { mode: 'cancel_queue', msg_id: 'b-5' } });
  assert.equal(r.status, 200);
  assert.equal(r.text(), '{"ok": true, "cancelled": 0, "msgs": []}');
  assert.equal(waitq.msgGet('b-5', { db: s.db }).state, 'running', '执行中不可取消（消息已发出去）');
  s.close();
});
