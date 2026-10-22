/**
 * `backend/routes/sessions.js` 单测（node --test，零依赖）——M3 会话族的五条读端点。
 *
 * 覆盖验收点：
 *   ① `sessionPayload` **四个分支**：family 不支持 / 无 sid / `load` 未 found（无 total 键）/ 正常；
 *   ② 两条 `after` 语义的差异（board 400 `bad after` vs task 静默回落 0）与缺席 400/404；
 *   ③ SSE 三帧序列（meta → entries(id) → chat）、`Last-Event-ID` 续传、sid 切换与 total 回退
 *      的**归零重发**、~15s 心跳（用 `maxIdleTicks` 压缩）、`found:false` 无 total 不炸；
 *   ④ 媒体 **async 注入必须 await**（M2 评审 P1），含拒绝路径不留 unhandled rejection。
 *
 * 全程临时库（`m3fixture`）+ **临时会话根**（`sessparse.setSessionsRoot`）——不碰生产库、
 * 不碰 `~/.dsh/sessions`。请求走**真的** `makeContext`（真 parse_qs / 真 json 写口），
 * 只把 `res` 换成记录器，这样测到的是 ctx 契约本身而不是自造的桩。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import * as board from '../lib/board.js';
import * as dshevents from '../lib/dshevents.js';
import * as sessparse from '../lib/sessparse.js';
import * as serverstate from '../lib/serverstate.js';
import { jsonBody } from '../lib/http.js';
import { makeContext } from '../routes/index.js';
import {
  boardSessionMedia, boardSessionMessages, runSessionStream, streamStartAfter,
  taskSessionMedia, taskSessionMessages, taskSessionStream,
} from '../routes/sessions.js';
import { freshDb, insertCard, insertMsg, insertProject, insertTask, insertWait } from './m3fixture.mjs';

const PROJECT_DIR = '/tmp/proj';
const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sessparse-routes-'));
sessparse.setSessionsRoot(sessionsRoot);
const BUCKET = path.basename(sessparse.dsh_bucket(PROJECT_DIR));

/** 造一个多帧 zstd 会话文件（每帧一批 JSONL 行），返回 sid 用的事件流路径 */
function writeSession(sid, frames, fileName = 'session.v4.jsonl.zstd') {
  const dir = path.join(sessionsRoot, BUCKET, sid);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat(frames.map((rows) => zstdCompressSync(
    Buffer.from(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8'))));
  const p = path.join(dir, fileName);
  fs.writeFileSync(p, buf);
  return p;
}

/** 4 条 entry 的合成会话（2 问 2 答），返回 sid */
function makeSession(sid) {
  writeSession(sid, [
    [{ type: 'session', version: 4, id: sid, cwd: PROJECT_DIR }],
    [
      { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Q1' }] } },
      { type: 'assistant/message', seq: 2, time: 1001, data: { message: { content: [{ type: 'text', text: 'A1' }] } } },
    ],
    [
      { type: 'user/message', seq: 3, time: 1002, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Q2' }] } },
      { type: 'assistant/message', seq: 4, time: 1003, data: { message: { content: [{ type: 'text', text: 'A2' }] } } },
    ],
  ]);
  return sid;
}

/** 记录型 res（足够 `lib/http.js` 的 respond/openSse 用） */
class FakeRes {
  constructor() {
    this.status = 0;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
    this.listeners = {};
  }

  writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; }

  flushHeaders() {}

  write(chunk) {
    if (this.ended) throw new Error('write after end');
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    this.ended = true;
  }

  on(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); return this; }

  emit(name) { for (const fn of this.listeners[name] || []) fn(); }

  get body() { return this.chunks.join(''); }
}

/** 真 ctx（真 parse_qs / 真写口），res 用记录器 */
function mkCtx(fx, { search = '', headers = {}, userId } = {}) {
  const res = new FakeRes();
  const uid = userId === undefined ? fx.db.prepare("SELECT id FROM users WHERE username='admin'").get().id : userId;
  const ctx = makeContext({
    req: { method: 'GET', headers },
    res,
    db: fx.db,
    user: { id: uid },
    path: '/x',
    search,
  });
  return { ctx, res };
}

/** JSON 响应体 */
function bodyJson(res) { return JSON.parse(res.body); }

/** 跑一个用例并保证句柄关闭（**必须 await 用例体**：早关句柄会让异步用例撞 "database is not open"） */
async function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return await fn(fx);
  } finally {
    fx.close();
  }
}

/** SSE 帧解析：`{event, id, data}` 列表（注释行单独收集） */
function parseFrames(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    if (block.startsWith(':')) { frames.push({ comment: block.slice(1).trim() }); continue; }
    let event = 'message';
    let id = null;
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    frames.push({ event, id, data: data.length ? JSON.parse(data.join('\n')) : null });
  }
  return frames;
}

/** SSE 帧的**原始 data 文本**（字节级断言用：键序/转义口径只在原文里可见） */
function rawFrames(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue;
    let event = 'message';
    let id = null;
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      // 线上形态是 `data: <json>`：剥掉协议规定的那个可选空格，留下 JSON 原文
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    out.push({ event, id, raw: data.join('\n') });
  }
  return out;
}

/** Python `json.dumps(..., sort_keys=True)` 的键序（测试侧独立实现，用于比对原文） */
function sortedDeep(value) {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedDeep(value[key]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- 看板会话 messages

test('board/session/messages：项目不归本人 ⇒ 404 project not found（隔离红线）', () => {
  withFixture('sess-route-404proj', (fx) => {
    const { ctx, res } = mkCtx(fx, { search: 'sid=session-x' });
    return boardSessionMessages(ctx, 999999).then(() => {
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'project not found' });
    });
  });
});

test('board/session/messages：bad after 400 → sid required 400 → session not found 404（顺序即 Python）', async () => {
  await withFixture('sess-route-400', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-aaaa1111-2222-4333-8444-555555555555');
    const card = insertCard(fx.db, pid, { sessionId: sid });
    // ① after 非数字 ⇒ 400 bad after（**在 sid 校验之前**）
    {
      const { ctx, res } = mkCtx(fx, { search: 'sid=' + sid + '&after=abc' });
      await boardSessionMessages(ctx, pid);
      assert.equal(res.status, 400);
      assert.deepEqual(bodyJson(res), { error: 'bad after' });
    }
    // ② 无 sid ⇒ 400 sid required
    {
      const { ctx, res } = mkCtx(fx, { search: 'after=0' });
      await boardSessionMessages(ctx, pid);
      assert.equal(res.status, 400);
      assert.deepEqual(bodyJson(res), { error: 'sid required' });
    }
    // ③ sid 不在本项目卡片并集内 ⇒ 404 session not found
    {
      const { ctx, res } = mkCtx(fx, { search: 'sid=session-not-mine' });
      await boardSessionMessages(ctx, pid);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'session not found' });
    }
    // ④ 合法 after 的三种写法都该放行（'0' / ' 3 ' / '1_0' 是 Python int() 的可接受形态）
    for (const after of ['0', '%203%20', '1_0']) {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}&after=${after}` });
      await boardSessionMessages(ctx, pid);
      assert.equal(res.status, 200, `after=${after} 应放行`);
      assert.equal(bodyJson(res).found, true);
    }
    assert.ok(card > 0);
  });
});

test('board/session/messages：load 未 found ⇒ 200 + found:false + 派生字段齐全（无 total）', async () => {
  await withFixture('sess-route-foundfalse', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    // 老形态 sid（下划线）不在 sessparse 白名单 ⇒ found:false reason=missing
    const sid = 'session_0c24a606-2cc1-4a94-881d-b5420956e690';
    insertCard(fx.db, pid, { sessionId: sid, worktree: ' /tmp/wt ' });
    const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
    await boardSessionMessages(ctx, pid);
    assert.equal(res.status, 200);
    const payload = bodyJson(res);
    assert.equal(payload.found, false);
    assert.equal(payload.reason, 'missing');
    assert.equal('total' in payload, false, 'found:false 的 payload 没有 total 键（Python 同）');
    assert.equal('entries' in payload, false);
    // 看板会话派生字段：键集合与 Python 逐条对齐
    assert.equal(payload.session_id, sid);
    assert.equal(payload.family, 'dsh_plugin');
    assert.deepEqual(payload.capabilities, {
      stream: true, chat: true, queue: true, steer: true, abort: true,
      compact: true, fork: true, rewind: true, profile: true, permission: true, events: true,
    });
    assert.equal(payload.running, false);
    assert.deepEqual(payload.chat, { running: false, queued: 0, msgs: [] });
    assert.equal(payload.project_busy, serverstate.projectBusy(pid, { db: fx.db }));
    assert.deepEqual(payload.unit_state, { state: 'idle', pos: 0, total: 0 });
    assert.equal(payload.card_column, 'todo');
    assert.equal(payload.card_worktree, '/tmp/wt', '两侧 strip 后再下发');
    assert.equal(payload.answer_pending, false);
    assert.equal(payload.interaction, null, '调和器缓存为空 ⇒ null（键仍在）');
    assert.equal(payload.owned, null, 'dshevents 未连接 ⇒ 归属未知（三态里的 null）');
    assert.equal(payload.queue_state, board.QS_IDLE);
  });
});

test('board/session/messages：interaction 取调和器缓存（会话窗问答对话框的数据源）', async () => {
  await withFixture('sess-route-interaction', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-cccc1111-2222-4333-8444-555555555555');
    insertCard(fx.db, pid, {
      sessionId: sid, columnKey: 'blocked', blockKind: 'interaction', blockText: '等你答',
    });
    // 调和器（`board.iwOnce`）写进 `_IW_CACHE` 的就是这份形状；测试缝直接灌一条等价条目
    board.setIwCacheForTest(sid, {
      pending: true, busy: true, kind: 'question', qid: 'call_1', wire: 'q_0',
      question: '用哪种颜色形态标识？', header: '颜色方案', body: '',
      options: [{ id: 'A', label: 'A', description: '' }],
      questions: [{
        id: 'q_0', question: '用哪种颜色形态标识？', header: '颜色方案', body: '',
        options: [{ id: 'A', label: 'A', description: '' }], multi_select: false,
        allow_other: true, other_label: '其他', other_description: '',
      }],
      answerable: true, text: '用哪种颜色形态标识？', ts: 1,
    });
    try {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMessages(ctx, pid);
      assert.equal(res.status, 200);
      const payload = bodyJson(res);
      assert.equal(payload.found, true);
      // pending=true ⇒ 前端 SessionView 渲染 InteractionCard
      assert.equal(payload.interaction.pending, true);
      assert.equal(payload.interaction.qid, 'call_1');
      assert.equal(payload.interaction.questions[0].question, '用哪种颜色形态标识？');
      assert.equal(payload.interaction.questions[0].options[0].label, 'A');
      // 卡片交互阻塞 ⇒ 队列态仍是 interaction_pending（两者互不替代）
      assert.equal(payload.queue_state, board.QS_INTERACTION);
    } finally {
      board.resetIwState();          // 模块级缓存：用完清干净，不污染其他用例
    }
  });
});

test('board/session/messages：normal 分支（found:true）的字段与 queue_state 派生', async () => {
  await withFixture('sess-route-normal', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-bbbb1111-2222-4333-8444-555555555555');
    const card = insertCard(fx.db, pid, { sessionId: sid, columnKey: 'doing' });
    // ① 普通运行中：not found:false；带 after 增量
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}&after=2` });
      await boardSessionMessages(ctx, pid);
      const payload = bodyJson(res);
      assert.equal(payload.found, true);
      assert.equal(payload.total, 4);
      assert.deepEqual(payload.entries.map((e) => e.seq), [2, 3]);
      assert.equal(payload.agent, 'main');
      assert.deepEqual(payload.agents, [{ id: 'main', type: 'main', parent: '' }]);
      assert.equal(payload.card_column, 'doing');
      assert.equal(payload.queue_state, board.QS_IDLE);
      assert.equal(payload.running, false);
    }
    // ② 卡片有活跃 c: 行 ⇒ unit_state=running ⇒ queue_state=running（行口径）
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: card, state: 'running', seq: 1 });
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMessages(ctx, pid);
      const payload = bodyJson(res);
      assert.deepEqual(payload.unit_state, { state: 'running', pos: 0, total: 0 });
      assert.equal(payload.queue_state, board.QS_RUNNING);
    }
    // ③ 已作答·待送达 ⇒ answer_pending=true、running 被压掉、queue_state=answer_pending
    //    注意：answer 行要挂在**归属卡**（boardOwnsSid 取第一张含该 sid 的卡）上，
    //    挂到第二张卡上不会生效——这本身就是归属判定的守卫
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: card, state: 'waiting', seq: 2 });
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMessages(ctx, pid);
      const payload = bodyJson(res);
      assert.equal(payload.answer_pending, true);
      assert.equal(payload.running, false);
      assert.equal(payload.queue_state, board.QS_ANSWER);
    }
    // ④ 卡片提问挂起（block_kind=interaction）⇒ interaction_pending（压过上面的 c: running 行）
    fx.db.prepare("DELETE FROM wait_items WHERE kind='answer'").run();
    fx.db.prepare('UPDATE board_cards SET block_kind=? WHERE id=?').run('interaction', card);
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMessages(ctx, pid);
      assert.equal(bodyJson(res).queue_state, board.QS_INTERACTION);
    }
  });
});

test('board/session/messages：meta.permission 回显会话实况 preset（§5.5；旧 mode 只做展示兜底）', async () => {
  await withFixture('sess-route-perm', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-dddd1111-2222-4333-8444-555555555555');
    insertCard(fx.db, pid, { sessionId: sid });
    // dshevents 注册表是模块级单例：直接灌实时态（生产由 driver/permission 状态帧折入）
    const hub = dshevents.HUB;
    hub._setConnected(true);
    try {
      const readPermission = async () => {
        const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
        await boardSessionMessages(ctx, pid);
        assert.equal(res.status, 200);
        return bodyJson(res);
      };
      // ① 新帧：preset 优先、原样回显（path-rules 平台不认识也照实给前端）
      hub._sessions.set(sid, { permission: { mode: '', preset: 'path-rules' } });
      assert.equal((await readPermission()).permission, 'path-rules');
      // ② 新帧内置档：原样（不再是旧三档反查值）
      hub._sessions.set(sid, { permission: { mode: '', preset: 'workspace-write' } });
      assert.equal((await readPermission()).permission, 'workspace-write');
      // ③ 旧插件旧帧：preset 空、mode=yolo ⇒ 展示兜底映射成 danger-full-access
      hub._sessions.set(sid, { permission: { mode: 'yolo', preset: '' } });
      assert.equal((await readPermission()).permission, 'danger-full-access');
      // ④ 两样都没有 / mode 不认识 ⇒ 不下发 permission 键（前端置灰，不猜）
      hub._sessions.set(sid, { permission: { mode: '', preset: '' } });
      assert.equal('permission' in (await readPermission()), false);
      hub._sessions.set(sid, { permission: { mode: 'boss', preset: '' } });
      assert.equal('permission' in (await readPermission()), false);
    } finally {
      hub._sessions.delete(sid);
      hub._setConnected(false);
    }
  });
});

// ---------------------------------------------------------------- 看板会话 media

test('board/session/media：sid required 400 / session not found 404 / media not found 404 / 200 字节', async () => {
  await withFixture('sess-route-media', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-cccc1111-2222-4333-8444-555555555555');
    insertCard(fx.db, pid, { sessionId: sid });
    const mid = `sha256:${'a'.repeat(64)}`;
    // ① 无 sid ⇒ 400
    {
      const { ctx, res } = mkCtx(fx, {});
      await boardSessionMedia(ctx, pid, mid);
      assert.equal(res.status, 400);
      assert.deepEqual(bodyJson(res), { error: 'sid required' });
    }
    // ② sid 不归属 ⇒ 404 session not found
    {
      const { ctx, res } = mkCtx(fx, { search: 'sid=session-nope' });
      await boardSessionMedia(ctx, pid, mid);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'session not found' });
    }
    // ③ 归属正确但驱动没数据 ⇒ 404 media not found（未注入 fetcher）
    sessparse.setMediaFetcher(null);
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMedia(ctx, pid, mid);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'media not found' });
    }
    // ④ 注入**异步** fetcher（dshdriver.media 的真实形态）⇒ 200 + 字节 + Content-Type
    sessparse.setMediaFetcher(async (id) => {
      assert.equal(id, mid);
      await new Promise((r) => setTimeout(r, 2));
      return { data: Buffer.from('png-bytes').toString('base64'), content_type: 'image/png' };
    });
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMedia(ctx, pid, mid);
      assert.equal(res.status, 200);
      assert.equal(res.headers['Content-Type'], 'image/png');
      assert.equal(res.body, 'png-bytes');
    }
    // ⑤ 附件 id 形态不符 ⇒ 404（在 fetcher 之前拦掉）
    {
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMedia(ctx, pid, 'not-a-media-id');
      assert.equal(res.status, 404);
    }
    sessparse.setMediaFetcher(null);
  });
});

test('board/session/media：async fetcher 拒绝 ⇒ 404 且不留 unhandled rejection（M2 评审 P1）', async () => {
  await withFixture('sess-route-media-reject', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-dddd1111-2222-4333-8444-555555555555');
    insertCard(fx.db, pid, { sessionId: sid });
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      sessparse.setMediaFetcher(async () => { throw new Error('驱动 404'); });
      const { ctx, res } = mkCtx(fx, { search: `sid=${sid}` });
      await boardSessionMedia(ctx, pid, `sha256:${'b'.repeat(64)}`);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'media not found' });
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(unhandled, [], `不应有未处理拒绝：${unhandled.map((e) => e.message)}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      sessparse.setMediaFetcher(null);
    }
  });
});

// ---------------------------------------------------------------- 任务会话 messages

test('tasks/session/messages：404 task not found / family 不支持 / 无 sid / load 未 found / 正常', async () => {
  await withFixture('sess-route-task', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-eeee1111-2222-4333-8444-555555555555');
    // ① 任务不存在 ⇒ 404 task not found
    {
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMessages(ctx, 999999);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'task not found' });
    }
    // ② family 不在 sessparse 白名单（退场族）⇒ found:false reason=family
    {
      const pidRetired = insertProject(fx.db, { name: 'retired', projectDir: '/tmp/retired', agentPath: '/usr/local/bin/kimi' });
      const task = insertTask(fx.db, pidRetired, { sessionId: sid });
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMessages(ctx, task);
      const payload = bodyJson(res);
      assert.equal(res.status, 200);
      assert.equal(payload.found, false);
      assert.equal(payload.reason, 'family');
      assert.equal(payload.family, 'retired');
      assert.equal('total' in payload, false);
    }
    // ③ 任务无 session_id 且工作区里探不到 ⇒ reason=no_session
    {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-empty-'));
      const pidEmpty = insertProject(fx.db, { name: 'empty', projectDir: emptyDir });
      const task = insertTask(fx.db, pidEmpty, {});
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMessages(ctx, task);
      const payload = bodyJson(res);
      assert.equal(payload.found, false);
      assert.equal(payload.reason, 'no_session');
      assert.equal(payload.session_id, '');
    }
    // ④ 有 sid 但会话存储里没有 ⇒ reason=missing
    {
      const task = insertTask(fx.db, pid, { sessionId: 'session-ffff1111-2222-4333-8444-555555555555' });
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMessages(ctx, task);
      const payload = bodyJson(res);
      assert.equal(payload.found, false);
      assert.equal(payload.reason, 'missing');
      // `sessparse.load` 的 not-found 分支**不带 agents 键** ⇒ Python `data.get("agents", [])` = []
      assert.deepEqual(payload.agents, []);
      assert.equal(payload.agent, 'main');
    }
    // ⑤ 正常：found:true + entries + chat（chat_msgs 里的排队消息）
    {
      const task = insertTask(fx.db, pid, { sessionId: sid });
      insertMsg(fx.db, { id: 'm1', projectId: pid, sid, taskId: task, message: 'hi', state: 'queued' });
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMessages(ctx, task);
      const payload = bodyJson(res);
      assert.equal(payload.found, true);
      assert.equal(payload.total, 4);
      assert.equal(payload.session_id, sid);
      assert.equal(payload.task_id, task);
      assert.equal(payload.family, 'dsh_plugin');
      assert.equal(payload.chat.queued, 1);
      assert.equal(payload.chat.msgs.length, 1);
      assert.deepEqual(payload.unit_state, { state: 'idle', pos: 0, total: 0 });
      assert.equal(payload.queue_state, board.QS_IDLE);
      assert.equal(payload.model, '');           // 无显式 model / 无轮次日志 / 无 dsh 默认 ⇒ ''
      assert.equal('sessionEffort' in payload, false);
    }
    // ⑥ after 语义：**非数字静默回落 0**（与 board 的 400 不同）
    {
      const task = insertTask(fx.db, pid, { sessionId: sid });
      const { ctx, res } = mkCtx(fx, { search: 'after=abc' });
      await taskSessionMessages(ctx, task);
      assert.equal(bodyJson(res).entries.length, 4);
      const inc = mkCtx(fx, { search: 'after=3' });
      await taskSessionMessages(inc.ctx, task);
      assert.equal(bodyJson(inc.res).entries.length, 1);
    }
  });
});

test('tasks/session/media：404 task not found / 404 media not found / 200（async fetcher）', async () => {
  await withFixture('sess-route-tmedia', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-99991111-2222-4333-8444-555555555555');
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const mid = `sha256:${'c'.repeat(64)}`;
    // ① 任务不存在
    {
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMedia(ctx, 999999, mid);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'task not found' });
    }
    // ② 任务存在但取不到附件
    sessparse.setMediaFetcher(async () => { throw new Error('404'); });
    {
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMedia(ctx, task, mid);
      assert.equal(res.status, 404);
      assert.deepEqual(bodyJson(res), { error: 'media not found' });
    }
    // ③ 成功
    sessparse.setMediaFetcher(async () => ({ data: Buffer.from('jpg-bytes').toString('base64'), content_type: 'image/jpeg' }));
    {
      const { ctx, res } = mkCtx(fx, {});
      await taskSessionMedia(ctx, task, mid);
      assert.equal(res.status, 200);
      assert.equal(res.headers['Content-Type'], 'image/jpeg');
      assert.equal(res.body, 'jpg-bytes');
    }
    sessparse.setMediaFetcher(null);
  });
});

// ---------------------------------------------------------------- 任务会话 SSE

test('SSE：首拍 meta → entries(id) → chat 三帧，`id` = 末条 seq', async () => {
  await withFixture('sess-route-sse', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-11112222-3333-4444-8555-666666666666');
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const { ctx, res } = mkCtx(fx, {});
    await taskSessionStream(ctx, task, { tickMs: 0, maxTicks: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal('X-Accel-Buffering' in res.headers, false, '会话流不带该头（只有看板两条流带）');
    const frames = parseFrames(res.body);
    assert.deepEqual(frames.map((f) => f.event), ['meta', 'entries', 'chat']);
    assert.equal(frames[1].id, '3');                       // after(=total 4) - 1
    assert.deepEqual(frames[1].data.entries.map((e) => e.seq), [0, 1, 2, 3]);
    assert.equal(frames[1].data.total, 4);
    assert.equal(frames[0].data.found, true);
    assert.equal(frames[0].data.session_id, sid);
    assert.equal(frames[0].data.total, 4);
    assert.equal('entries' in frames[0].data, false, 'meta 帧不含 entries');
    assert.equal('chat' in frames[0].data, false, 'meta 帧不含 chat');
    assert.deepEqual(frames[2].data, { running: false, queued: 0, msgs: [] });
  });
});

test('SSE：三帧各自「变了才发」+ 空闲到阈值发 `: hb` 心跳', async () => {
  await withFixture('sess-route-sse-idle', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-22223333-4444-4555-8666-777777777777');
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const { ctx, res } = mkCtx(fx, {});
    // 2 拍、心跳阈值 1：第 2 拍无变化 ⇒ 只发心跳，不重发 meta/entries/chat
    await taskSessionStream(ctx, task, { tickMs: 0, maxTicks: 2, maxIdleTicks: 1 });
    const frames = parseFrames(res.body);
    assert.deepEqual(frames.map((f) => f.event || `:${f.comment}`), ['meta', 'entries', 'chat', ':hb']);
  });
});

test('SSE：sid 切换（探测 sid 被真实 sid 纠正）⇒ 增量基点归零、全量重发', async () => {
  await withFixture('sess-route-sse-switch', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-33334444-5555-4666-8777-888888888888');
    const task = insertTask(fx.db, pid, { sessionId: sid });
    const { ctx, res } = mkCtx(fx, {});
    // 第 1 拍后把任务行的 session_id 改掉（轮后写库的场景），第 2 拍必须感知并全量重发
    let tick = 0;
    await taskSessionStream(ctx, task, {
      tickMs: 0,
      maxTicks: 3,
      shouldStop: () => {
        tick += 1;
        if (tick === 2) {
          fx.db.prepare('UPDATE tasks SET session_id=? WHERE id=?')
            .run('session-44445555-6666-4777-8888-999999999999', task);
        }
        return false;
      },
    });
    const frames = parseFrames(res.body);
    const metas = frames.filter((f) => f.event === 'meta').map((f) => f.data.session_id);
    // 第 1 拍旧 sid；第 2 拍切换后重发 meta（新 sid）与全量 entries；第 3 拍无变化
    assert.deepEqual(metas, [sid, 'session-44445555-6666-4777-8888-999999999999']);
    const entriesFrames = frames.filter((f) => f.event === 'entries');
    // 切换后的那帧是新会话（不存在）⇒ 无 entries；这里断言「切换被感知且没有再发旧会话的增量」
    assert.equal(entriesFrames.length, 1, '切换后不再发旧会话条目');
    assert.deepEqual(entriesFrames[0].data.entries.map((e) => e.seq), [0, 1, 2, 3]);
  });
});

test('SSE：total 回退（会话被截断）⇒ 归零重发全量；found:false 无 total 路径不炸', async () => {
  await withFixture('sess-route-sse-total', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const task = insertTask(fx.db, pid, {});
    const { ctx, res } = mkCtx(fx, {});
    const all = [0, 1, 2].map((i) => ({ seq: i, kind: 'assistant', time: i, text: `t${i}` }));
    // 注入 payload：第 1 拍 total=3；第 2 拍起 total=1（模拟会话被截断）；第 4 拍起 found:false（无 total 键）
    let tickNo = 0;
    const scripted = async (_ctx, _task, _project, _family, _agent, after) => {
      if (tickNo >= 4) return { found: false, reason: 'missing', session_id: 'session-x', chat: {} };
      const total = tickNo <= 1 ? 3 : 1;
      return {
        found: true, session_id: 'session-x', total, chat: {},
        entries: all.slice(0, total).filter((e) => e.seq >= after),
      };
    };
    await taskSessionStream(ctx, task, {
      tickMs: 0,
      maxTicks: 5,
      shouldStop: () => { tickNo += 1; return false; },
      sessionPayload: scripted,
    });
    const frames = parseFrames(res.body);
    const entriesFrames = frames.filter((f) => f.event === 'entries');
    assert.equal(entriesFrames.length, 2, '第 1 拍全量 + 第 2 拍回退后重发；found:false 无 entries');
    assert.equal(entriesFrames[0].id, '2');
    assert.equal(entriesFrames[1].id, '0', 'total 回退后 after=0 ⇒ id=0 且重发全量');
    assert.deepEqual(entriesFrames[1].data.entries.map((e) => e.seq), [0], '发的是重取后的全量');
    assert.equal(entriesFrames[1].data.total, 1);
    // found:false 的几拍只发 meta（且 meta 变了才发）——不因缺 total 抛异常
    assert.equal(frames.filter((f) => f.event === 'meta').length, 3);
  });
});

test('SSE 首拍游标：`?after=` 数字优先，否则 Last-Event-ID+1，再否则 0；且首拍一律归零重发', async () => {
  await withFixture('sess-route-sse-resume', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-55556666-7777-4888-8999-000000000000');
    const task = insertTask(fx.db, pid, { sessionId: sid });
    // ① 游标解析（导出函数直测；Python 原文：after_s.isdigit() / lid.isdigit()）
    const parse = (search, headers = {}) => streamStartAfter(mkCtx(fx, { search, headers }).ctx);
    assert.equal(parse('after=3'), 3);
    assert.equal(parse('after=abc', { 'last-event-id': '2' }), 3, '非数字 after ⇒ Last-Event-ID+1');
    assert.equal(parse('after=abc', { 'last-event-id': 'zzz' }), 0);
    assert.equal(parse('', { 'last-event-id': '7' }), 8);
    assert.equal(parse('after=1', { 'last-event-id': '3' }), 1, '数字 after 优先于 Last-Event-ID');
    assert.equal(parse('after=1_0'), 0, 'Python `"1_0".isdigit()` 为假 ⇒ 回落 Last-Event-ID/0');
    // ② 帧序列层面：**首拍必归零重发**（Python `cur_sid=""` 口径）——带 Last-Event-ID 也一样
    for (const headers of [{ 'last-event-id': '2' }, {}]) {
      const { ctx, res } = mkCtx(fx, { search: 'after=abc', headers });
      await taskSessionStream(ctx, task, { tickMs: 0, maxTicks: 1 });
      const entries = parseFrames(res.body).find((f) => f.event === 'entries');
      assert.deepEqual(entries.data.entries.map((e) => e.seq), [0, 1, 2, 3],
        '首拍 sid 从 "" 变为真实 sid ⇒ after 归零、重取全量（Python 同）');
      assert.equal(entries.id, '3');
    }
    // ③ `?after=9` 同样被首拍归一化（照抄，不「顺手修好」）
    {
      const { ctx, res } = mkCtx(fx, { search: 'after=9' });
      await taskSessionStream(ctx, task, { tickMs: 0, maxTicks: 1 });
      const entries = parseFrames(res.body).find((f) => f.event === 'entries');
      assert.deepEqual(entries.data.entries.map((e) => e.seq), [0, 1, 2, 3]);
    }
  });
});

test('SSE 帧文本口径：meta 按键序（sort_keys）、chat 走 `\\uXXXX` 转义（ensure_ascii）', async () => {
  await withFixture('sess-route-sse-bytes', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const sid = makeSession('session-aaaa5555-6666-4777-8888-999999999999');
    const task = insertTask(fx.db, pid, { sessionId: sid });
    // 中文进 chat（错误消息）：Python 的 chat 帧 ensure_ascii 默认 True ⇒ 原文必须是 \uXXXX
    insertMsg(fx.db, { id: 'm-cn', projectId: pid, sid, taskId: task, message: '中文消息', state: 'error', error: '失败：中文' });
    const { ctx, res } = mkCtx(fx, {});
    await taskSessionStream(ctx, task, { tickMs: 0, maxTicks: 1 });
    const raw = rawFrames(res.body);
    // ① meta 帧：data 原文 == 按 sort_keys 重新序列化的等价文本（未排序的键序会不等）
    const metaRaw = raw.find((f) => f.event === 'meta').raw;
    assert.deepEqual(JSON.parse(metaRaw), JSON.parse(metaRaw));
    assert.equal(metaRaw, jsonBody(sortedDeep(JSON.parse(metaRaw))),
      'meta 帧必须按键序序列化（Python `sort_keys=True`）');
    // ② chat 帧：非 ASCII 一律 \uXXXX 转义（Python 这一帧没写 ensure_ascii=False）
    const chatRaw = raw.find((f) => f.event === 'chat').raw;
    assert.match(chatRaw, /\\u[0-9a-f]{4}/, 'chat 帧应含 \\uXXXX 转义');
    assert.equal(chatRaw.includes('中文'), false, 'chat 帧不得出现裸中文');
    assert.equal(JSON.parse(chatRaw).msgs[0].text, '中文消息', '转义后解析回来仍是原文');
    assert.equal(JSON.parse(chatRaw).msgs[0].error, '失败：中文');
    // 对照：meta 帧是 ensure_ascii=False ⇒ 中文原样出现（两条帧转义口径不同，别统一）
    assert.equal(metaRaw.includes('\\u4e2d'), false);
  });
});

test('SSE：total 缺失/null 不得参与回退比较（否则每拍归零重取）', async () => {
  await withFixture('sess-route-sse-total-null', async (fx) => {
    const pid = insertProject(fx.db, { projectDir: PROJECT_DIR });
    const task = insertTask(fx.db, pid, {});
    const { ctx, res } = mkCtx(fx, {});
    let calls = 0;
    const payloadArg = [];
    await runSessionStream(ctx, task, {
      sse: ctx.sse({}),
      agent: 'main',
      after: 5,                                  // 游标非 0 才看得出「被误当归零重取」
      task: fx.db.prepare('SELECT * FROM tasks WHERE id=?').get(task),
      project: { id: pid, project_dir: PROJECT_DIR },
      family: 'dsh_plugin',
      tickMs: 0,
      maxTicks: 2,
      sessionPayload: async (_c, _t, _p, _f, _a, after) => {
        calls += 1;
        payloadArg.push(after);
        // found:false + session_id 为空（不触发 sid 切换）+ total=null（不得当 0）
        return { found: false, reason: 'no_session', session_id: '', total: null, chat: {} };
      },
    });
    assert.deepEqual(payloadArg, [5, 5], 'total 为 null 时不得走回退分支（走了会给 0）');
    assert.equal(calls, 2, '两拍各取一次 payload');
    assert.equal(parseFrames(res.body).some((f) => f.event === 'entries'), false);
  });
});

test('SSE：任务不存在 ⇒ 404 task not found（不开流）', async () => {
  await withFixture('sess-route-sse-404', async (fx) => {
    const { ctx, res } = mkCtx(fx, {});
    await taskSessionStream(ctx, 999999, { tickMs: 0, maxTicks: 1 });
    assert.equal(res.status, 404);
    assert.deepEqual(bodyJson(res), { error: 'task not found' });
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  });
});
