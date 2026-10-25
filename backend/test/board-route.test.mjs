/**
 * `backend/routes/board.js` 的契约测试（`node --test`，零依赖，真起本地 HTTP 服务 + 临时库）。
 *
 * 三条硬约束（与 `backend/test/m3fixture.mjs` 文件头一致）：
 *   ① **临时库、绝不碰生产库**：每例 `freshDb()` 一个 mkdtemp 目录 + 全新库文件；
 *   ② **真 SQL 造行**（不 mock 数据层），断言的是**响应字节/JSON 结构**；
 *   ③ **真 HTTP**：本文件起一个「信任头已过 + 路由分派」的最小服务（与 `server.js` 读路径同形），
 *      所以 SSE 的首帧/keepalive/断连收尾走的是真实 socket 与 `res.on('close')`，
 *      不是自证式的桩。
 *
 * 覆盖（对应 task-3 验收②）：
 *   - 七条端点的主路径与 404/400 语义（`project not found` / `card not found` /
 *     `session not found` / `bad fid`）；
 *   - `/board` 的 `family`/`capabilities`/`session_titles` 与键序；
 *   - `/board/sessions` 的 `bound` 标记（用**真 zstd 会话文件**造，不走 mock）；
 *   - `/board/media/<fid>` 的 fid 白名单、MIME 反查、`work_dir` 派生、读不到 404；
 *   - worktree 预览三态（已在 worktree / 已有主会话 / 非 git 仓库）+ 卡片 404；
 *   - 看板流：hello 首帧与头部、refresh（db 信号 + 绑定会话 dsh 帧）、非绑定帧被过滤、
 *     keepalive 注释帧、30s 绑定集合重算、客户端断开收尾与**订阅者零泄漏**；
 *   - 会话流：hello（含 `events:true` 与 unquote）、本 sid 帧 → refresh、别的 sid 不发、
 *     归属校验 404、断开零泄漏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

import { respondJson } from '../lib/http.js';
import * as localbus from '../lib/localbus.js';
import * as dshevents from '../lib/dshevents.js';
import * as sessparse from '../lib/sessparse.js';
import { dispatch, makeContext } from '../routes/index.js';
import {
  SSE_BOUND_REFRESH_MS,
  SSE_WAIT_MS,
  _setSseTiming,
} from '../routes/board.js';
import {
  freshDb,
  insertCard,
  insertComment,
  insertProject,
  insertTask,
  setBoardSettings,
} from './m3fixture.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询到条件成立（SSE 是异步推流，只能等） */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return Boolean(predicate());
    await sleep(5);
  }
}

/**
 * 起「信任头已过 + 路由分派」的最小服务（`server.js` 读路径的等价裁剪）。
 * @param {object} handle 已打开的临时库句柄
 * @param {{userId?: number}} [opts]
 */
async function startServer(handle, { userId = 1 } = {}) {
  const server = http.createServer((req, res) => {
    (async () => {
      const rawUrl = String(req.url || '/');
      const path = rawUrl.split('?')[0];
      const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
      const ctx = makeContext({ req, res, db: handle, user: { id: userId }, path, search });
      if (await dispatch(ctx)) return;
      respondJson(res, 404, { error: 'not found' });
    })().catch((error) => {
      try {
        respondJson(res, 500, { error: `boom: ${(error && error.message) || error}` });
      } catch { /* 响应已发出：忽略 */ }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 取 JSON（同时留正文与 Content-Type，便于断言头部口径） */
async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 非 JSON 正文（如 _send_file 的 404 文本） */ }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json };
}

/** 取原始字节（附件端点用） */
async function getRaw(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', buf, text: buf.toString('utf8') };
}

/**
 * 打开一条 SSE 连接并后台收帧（`event:` 帧进 `events`，`:` 注释帧进 `comments`）。
 * 返回的 `abort()` 模拟客户端断开（触发服务端 `res.on('close')`）。
 */
async function openSse(url, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const state = {
    status: res.status,
    type: res.headers.get('content-type') || '',
    accel: res.headers.get('x-accel-buffering') || '',
    events: [],
    comments: [],
    done: false,
  };
  if (res.status !== 200 || !res.body) {
    try { await res.text(); } catch { /* 忽略 */ }
    state.done = true;
    return { state, abort: () => {} };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf8');
  const pump = (async () => {
    let carry = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = carry.indexOf('\n\n')) >= 0) {
          const block = carry.slice(0, idx);
          carry = carry.slice(idx + 2);
          let name = 'message';
          const dataLines = [];
          let comment = null;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comment = line.slice(1).trim();
            else if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) {
            if (comment !== null) state.comments.push(comment);
            continue;
          }
          let data = null;
          try { data = JSON.parse(dataLines.join('\n')); } catch { data = dataLines.join('\n'); }
          state.events.push({ event: name, data });
        }
      }
    } catch { /* abort：正常收尾 */ } finally {
      state.done = true;
    }
  })();
  void pump;
  return {
    state,
    abort: () => {
      try { controller.abort(); } catch { /* 已断 */ }
    },
  };
}

/** 当前 dshevents 单例的订阅者数量（订阅者零泄漏的判据；`_subscribers` 是进程内数组） */
const subscriberCount = () => dshevents.HUB._subscribers.length;

/**
 * 断开一条 SSE 并等**服务端摘完订阅者**：订阅者数是「断连收尾已完成」的唯一可观测判据。
 * `baseline` = 开这条流之前的订阅者数（用例内先取）。等待超时即断言失败（泄漏）。
 */
async function abortAndSettle(sse, baseline) {
  sse.abort();
  const ok = await waitFor(() => subscriberCount() === baseline, 2000);
  assert.ok(ok, `SSE 断开后订阅者未收回：当前 ${subscriberCount()}，期望 ${baseline}`);
}

/** 临时会话存储根：`sessparse` 的 `~/.dsh/sessions` 替身（用完还原） */
function withSessionsRoot(fn) {
  const old = sessparse.dshSessionsRoot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dsh-sessions-'));
  sessparse.setSessionsRoot(root);
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => sessparse.setSessionsRoot(old));
}

/** 写一个**真** dsh 主会话文件（单帧 zstd；目录名/sid 两代形态都支持） */
function writeDshSession(root, cwd, sid, { title = '', prompt = '' } = {}) {
  const bucket = sessparse.dsh_bucket(cwd);       // 与读侧同一份路径推导（不手抄算法）
  const sdir = path.join(bucket, sid);
  fs.mkdirSync(sdir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 4 })];
  if (title) lines.push(JSON.stringify({ type: 'session/title', data: { title } }));
  if (prompt) {
    lines.push(JSON.stringify({
      type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] },
    }));
  }
  const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(bytes));
  sessparse.cache_clear();                        // 文件是新造的：清 stamp 缓存
  return sdir;
}

// ============================================================================
// GET /api/projects/<id>/board
// ============================================================================

test('GET /board：看板全量 + family/capabilities + session_titles（键序照 Python）', async () => {
  const fx = freshDb('board-payload');
  const srv = await startServer(fx.db);
  try {
    const pid = insertProject(fx.db, { name: 'p1', projectDir: path.join(fx.dir, 'proj') });
    const c1 = insertCard(fx.db, pid, {
      title: '卡一', sessions: JSON.stringify(['session-aaaa']), sessionId: 'session-aaaa',
    });
    insertCard(fx.db, pid, { title: '卡二', columnKey: 'done', doneAt: '2026-10-11 01:00:00' });
    insertComment(fx.db, c1, '评论一');
    setBoardSettings(fx.db, pid, { mode: 'parallel' });
    insertTask(fx.db, pid, { name: '跑着的任务', status: 'running' });

    await withSessionsRoot(async () => {
      const r = await getJson(`${srv.url}/api/projects/${pid}/board`);
      assert.equal(r.status, 200);
      assert.equal(r.type, 'application/json; charset=utf-8');
      // 键序 = Python dict 插入序（board_payload 四键 + 本端点追加三项）
      assert.deepEqual(Object.keys(r.json), [
        'cards', 'comments', 'settings', 'active_tasks', 'family', 'capabilities', 'session_titles',
      ]);
      assert.equal(r.json.family, 'dsh_plugin');
      assert.equal(r.json.capabilities.stream, true);
      assert.equal(r.json.capabilities.events, true);
      assert.deepEqual(Object.keys(r.json.capabilities), [
        'stream', 'chat', 'queue', 'steer', 'abort', 'compact', 'fork', 'rewind',
        'profile', 'permission', 'events',
      ]);
      assert.deepEqual(r.json.session_titles, { 'session-aaaa': '' });
      assert.deepEqual(r.json.cards.map((c) => c.id).sort((a, b) => a - b), [c1, c1 + 1]);
      assert.equal(r.json.comments.length, 1);
      assert.equal(r.json.comments[0].text, '评论一');
      assert.equal(r.json.settings.mode, 'parallel');
      assert.equal(r.json.active_tasks.length, 1);
      assert.equal(r.json.active_tasks[0].column, 'doing');       // running → doing 列
    });
  } finally {
    await srv.close();
    fx.close();
  }
});

test('GET /board：未知项目 / 他人项目 → 404 project not found', async () => {
  const fx = freshDb('board-404');
  const srv = await startServer(fx.db, { userId: 1 });
  try {
    const mine = insertProject(fx.db, { name: 'mine', userId: 1 });
    const other = insertProject(fx.db, { name: 'other', userId: 99 });
    const missing = await getJson(`${srv.url}/api/projects/999999/board`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'project not found' });
    // 错误体是**紧凑** JSON（冒号后无空格）——与 Python 硬编码 `b'{"error":"…"}'` 逐字节相同
    assert.equal(missing.text, '{"error":"project not found"}');
    const foreign = await getJson(`${srv.url}/api/projects/${other}/board`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, { error: 'project not found' });
    assert.equal((await getJson(`${srv.url}/api/projects/${mine}/board`)).status, 200);
  } finally {
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// GET /api/projects/<id>/board/trash
// ============================================================================

test('GET /board/trash：只列回收站卡片（删除时间倒序）+ 404', async () => {
  const fx = freshDb('board-trash');
  const srv = await startServer(fx.db);
  try {
    const pid = insertProject(fx.db, { name: 'p' });
    insertCard(fx.db, pid, { title: '在板' });
    const older = insertCard(fx.db, pid, {
      title: '先删', trashed: 1, trashedAt: '2026-10-11 02:00:00',
    });
    const newer = insertCard(fx.db, pid, {
      title: '后删', trashed: 1, trashedAt: '2026-10-11 03:00:00',
    });
    const r = await getJson(`${srv.url}/api/projects/${pid}/board/trash`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['cards']);
    assert.deepEqual(r.json.cards.map((c) => c.id), [newer, older]);   // trashed_at DESC
    assert.equal(r.json.cards[0].trashed, true);
    assert.equal(r.json.cards[0].running, false);
    assert.equal(r.json.cards[0].queue_state, 'idle');
    assert.equal((await getJson(`${srv.url}/api/projects/999999/board/trash`)).status, 404);
  } finally {
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// GET /api/projects/<id>/board/sessions
// ============================================================================

test('GET /board/sessions：真会话文件枚举 + bound 标记（族归一 dsh_plugin→dsh）', async () => {
  const fx = freshDb('board-sessions');
  const srv = await startServer(fx.db);
  try {
    const projectDir = path.join(fx.dir, 'proj');
    const pid = insertProject(fx.db, { name: 'p', projectDir });
    const boundSid = 'session-11111111-2222-3333-4444-555555555555';
    const freeSid = '22222222-3333-4444-5555-666666666666';
    insertCard(fx.db, pid, { title: '绑了', sessionId: boundSid, sessions: JSON.stringify([boundSid]) });

    await withSessionsRoot(async (root) => {
      writeDshSession(root, projectDir, boundSid, { title: '已绑定会话', prompt: '第一问' });
      writeDshSession(root, projectDir, freeSid, { title: '空闲会话' });
      const r = await getJson(`${srv.url}/api/projects/${pid}/board/sessions`);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json), ['sessions']);
      const bySid = new Map(r.json.sessions.map((it) => [it.sid, it]));
      assert.deepEqual([...bySid.keys()].sort(), [freeSid, boundSid].sort());
      assert.equal(bySid.get(boundSid).bound, true);
      assert.equal(bySid.get(freeSid).bound, false);
      assert.equal(bySid.get(boundSid).title, '已绑定会话');
      assert.equal(bySid.get(boundSid).first_prompt, '第一问');
      // 键集与 Python list_sessions 条目同形（bound 追加在末尾）
      assert.deepEqual(Object.keys(bySid.get(freeSid)),
        ['sid', 'title', 'titles', 'first_prompt', 'has_content', 'mtime', 'archived', 'bound']);
    });
    assert.equal((await getJson(`${srv.url}/api/projects/999999/board/sessions`)).status, 404);
  } finally {
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// GET /api/projects/<id>/board/media/<fid>
// ============================================================================

test('GET /board/media/<fid>：fid 白名单 400、MIME 反查、work_dir 派生、缺文件 404', async () => {
  const fx = freshDb('board-media');
  const srv = await startServer(fx.db);
  try {
    const workDir = path.join(fx.dir, 'work');
    const mdir = path.join(workDir, 'board_media');
    fs.mkdirSync(mdir, { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    fs.writeFileSync(path.join(mdir, 'm1700000000000_0123456789.png'), png);
    fs.writeFileSync(path.join(mdir, 'm1700000000001_0123456789.svg'), '<svg/>');
    fs.writeFileSync(path.join(mdir, 'm1700000000002_0123456789.xyz'), 'raw');
    const pid = insertProject(fx.db, { name: 'p', projectDir: path.join(fx.dir, 'proj'), workDir });

    const ok = await getRaw(`${srv.url}/api/projects/${pid}/board/media/m1700000000000_0123456789.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.type, 'image/png');
    assert.deepEqual(ok.buf, png);
    const svg = await getRaw(`${srv.url}/api/projects/${pid}/board/media/m1700000000001_0123456789.svg`);
    assert.equal(svg.type, 'image/svg+xml');
    // 扩展名不在 MIME 表 ⇒ octet-stream（Python 同）
    const unknown = await getRaw(`${srv.url}/api/projects/${pid}/board/media/m1700000000002_0123456789.xyz`);
    assert.equal(unknown.status, 200);
    assert.equal(unknown.type, 'application/octet-stream');
    // 大写扩展名：白名单允许，反查前 lower()
    fs.writeFileSync(path.join(mdir, 'm1700000000003_0123456789.PNG'), png);
    const upper = await getRaw(`${srv.url}/api/projects/${pid}/board/media/m1700000000003_0123456789.PNG`);
    assert.equal(upper.status, 200);
    assert.equal(upper.type, 'image/png');

    // 白名单拒绝（路由正则命中、fid 形态不符）⇒ 400 bad fid
    for (const fid of [
      'm1700000000000_ZZZZZZZZZZ.png',    // 非 hex
      'x1700000000000_0123456789.png',    // 不以 m 开头
      'm1700000000000_0123456789',        // 无扩展名
      'm1700000000000_0123456789.abcd-efg', // 扩展名含非法字符（路由就拦下 → 见下）
    ]) {
      const r = await getJson(`${srv.url}/api/projects/${pid}/board/media/${fid}`);
      assert.equal(r.status, 400, `${fid} 应为 400，实为 ${r.status}`);
      assert.deepEqual(r.json, { error: 'bad fid' });
      assert.equal(r.text, '{"error":"bad fid"}', '错误体必须是紧凑 JSON（Python 硬编码字节串口径）');
    }
    // 路径穿越：路由正则（[A-Za-z0-9._-]+）不含 `%`/`/` ⇒ 不命中 → 全局 404 not found（Python 同）
    const trav = await getJson(`${srv.url}/api/projects/${pid}/board/media/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(trav.status, 404);
    assert.deepEqual(trav.json, { error: 'not found' });

    // 合法 fid 但文件不存在 ⇒ 404 not found + text/plain（Python `_send_file` 同形）
    const gone = await getRaw(`${srv.url}/api/projects/${pid}/board/media/m1700000000009_0123456789.png`);
    assert.equal(gone.status, 404);
    assert.equal(gone.type, 'text/plain; charset=utf-8');
    assert.equal(gone.text, 'not found');
    // 未知项目
    assert.equal((await getJson(`${srv.url}/api/projects/999999/board/media/m1700000000000_0123456789.png`)).status, 404);
  } finally {
    await srv.close();
    fx.close();
  }
});

test('GET /board/media/<fid>：work_dir 为空时回落 <project_dir>/.touchstone/board_media', async () => {
  const fx = freshDb('board-media-fallback');
  const srv = await startServer(fx.db);
  try {
    const projectDir = path.join(fx.dir, 'proj');
    const mdir = path.join(projectDir, '.touchstone', 'board_media');
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, 'm1700000000000_0123456789.txt'), 'hello');
    const pid = insertProject(fx.db, { name: 'p', projectDir });
    // 夹具的 insertProject 会用 project_dir 顶替空 work_dir；这里显式改回空串以覆盖回落分支
    fx.db.prepare('UPDATE projects SET work_dir=? WHERE id=?').run('', pid);
    const r = await getRaw(`${srv.url}/api/projects/${pid}/board/media/m1700000000000_0123456789.txt`);
    assert.equal(r.status, 200);
    assert.equal(r.type, 'text/plain');
    assert.equal(r.text, 'hello');
  } finally {
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// GET /api/projects/<id>/board/cards/<id>/worktree
// ============================================================================

test('GET /board/cards/<id>/worktree：预览三态 + 卡片 404', async () => {
  const fx = freshDb('board-worktree');
  const srv = await startServer(fx.db);
  try {
    // 项目目录不存在 ⇒ worktree.preview 必然 not-ok（非 git 仓库分支）
    const pid = insertProject(fx.db, { name: 'p', projectDir: path.join(fx.dir, 'no-such-dir') });
    const free = insertCard(fx.db, pid, { title: '全新卡' });
    const bound = insertCard(fx.db, pid, { title: '有主会话', sessionId: 'session-x' });
    const wtDir = path.join(fx.dir, 'wt-card');
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = insertCard(fx.db, pid, { title: '已在 worktree', worktree: wtDir });
    const otherPid = insertProject(fx.db, { name: 'other', userId: 1 });
    const otherCard = insertCard(fx.db, otherPid, { title: '他人卡' });

    const rFree = await getJson(`${srv.url}/api/projects/${pid}/board/cards/${free}/worktree`);
    assert.equal(rFree.status, 200);
    assert.deepEqual(Object.keys(rFree.json),
      ['supported', 'reason', 'path', 'branch', 'exists', 'merge']);
    assert.equal(rFree.json.supported, false);                 // 非 git 仓库
    assert.equal(rFree.json.path, '');
    assert.equal(rFree.json.exists, false);
    assert.equal(typeof rFree.json.reason, 'string');
    assert.ok(rFree.json.reason.length > 0);
    assert.equal(rFree.json.branch, `ts/card-${free}`);

    const rBound = await getJson(`${srv.url}/api/projects/${pid}/board/cards/${bound}/worktree`);
    assert.equal(rBound.json.supported, false);
    assert.equal(rBound.json.reason, '该卡片已有主会话，不能切换到独立 worktree（请新建卡片）');
    assert.equal(rBound.json.path, '');

    const rWt = await getJson(`${srv.url}/api/projects/${pid}/board/cards/${wt}/worktree`);
    assert.equal(rWt.json.supported, false);
    assert.equal(rWt.json.reason, '该卡片已在独立 worktree 中运行');
    assert.equal(rWt.json.path, wtDir);
    assert.equal(rWt.json.exists, true);

    const missing = await getJson(`${srv.url}/api/projects/${pid}/board/cards/999999/worktree`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'card not found' });
    // 卡片存在但不属于该项目 ⇒ 同样 card not found（防跨项目读卡）
    const cross = await getJson(`${srv.url}/api/projects/${pid}/board/cards/${otherCard}/worktree`);
    assert.equal(cross.status, 404);
    assert.deepEqual(cross.json, { error: 'card not found' });
    // 项目不存在 ⇒ project not found
    const noProj = await getJson(`${srv.url}/api/projects/999999/board/cards/${free}/worktree`);
    assert.equal(noProj.status, 404);
    assert.deepEqual(noProj.json, { error: 'project not found' });
  } finally {
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// GET /api/projects/<id>/board/stream（SSE）
// ============================================================================

test('看板流：hello 首帧 + 头部（X-Accel-Buffering: no）+ 未知项目 404', async () => {
  const fx = freshDb('board-stream-hello');
  const srv = await startServer(fx.db);
  try {
    const pid = insertProject(fx.db, { name: 'p' });
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/stream`);
    try {
      assert.equal(s.state.status, 200);
      assert.equal(s.state.type, 'text/event-stream; charset=utf-8');
      assert.equal(s.state.accel, 'no');
      assert.ok(await waitFor(() => s.state.events.length >= 1));
      assert.deepEqual(s.state.events[0], { event: 'hello', data: { project_id: pid } });
    } finally {
      await abortAndSettle(s, base);
    }
    const missing = await getJson(`${srv.url}/api/projects/999999/board/stream`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'project not found' });
  } finally {
    await srv.close();
    fx.close();
  }
});

test('看板流：坏 sessions JSON 不炸（`_sids()` 的 ValueError/TypeError 分支）', async () => {
  const fx = freshDb('board-stream-badjson');
  const srv = await startServer(fx.db);
  try {
    const badSid = 'session-badjson-1';
    const pid = insertProject(fx.db, { name: 'p' });
    // sessions 列是坏 JSON、但 session_id 有效：Python `_sids()` 吞 ValueError 后靠 session_id 认出
    insertCard(fx.db, pid, { title: '坏 JSON 卡', sessionId: badSid, sessions: 'not-json' });
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/stream`);
    try {
      assert.equal(s.state.status, 200, '坏 sessions JSON 不得让流建不起来');
      assert.ok(await waitFor(() => s.state.events.length >= 1));       // hello
      const refreshes = () => s.state.events.filter((e) => e.event === 'refresh');
      dshevents.HUB._onFrame({
        seq: 1, type: 'agent/status', session_id: badSid, data: { status: 'running' },
      });
      assert.ok(await waitFor(() => refreshes().length === 1), '有效 session_id 应仍被认作绑定会话');
    } finally {
      await abortAndSettle(s, base);
    }
  } finally {
    await srv.close();
    fx.close();
  }
});

test('看板流：db 信号与绑定会话 dsh 帧触发 refresh，非绑定会话被过滤', async () => {
  const fx = freshDb('board-stream-refresh');
  const srv = await startServer(fx.db);
  try {
    const boundSid = 'session-bound-1';
    const pid = insertProject(fx.db, { name: 'p' });
    insertCard(fx.db, pid, { title: '在管卡', sessionId: boundSid, sessions: JSON.stringify([boundSid]) });
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/stream`);
    try {
      const refreshes = () => s.state.events.filter((e) => e.event === 'refresh');
      assert.ok(await waitFor(() => s.state.events.length >= 1));       // hello
      // ① 本项目 db 写路径信号（lib/localbus 由 db 层发布；这里直接发一次同 topic）
      localbus.publish(localbus.boardTopic(pid));
      assert.ok(await waitFor(() => refreshes().length === 1));
      assert.deepEqual(refreshes()[0].data, { project_id: pid });
      // ② 本项目绑定会话的 dsh 状态帧（dshevents 转发路径）
      dshevents.HUB._onFrame({
        seq: 1, type: 'agent/status', session_id: boundSid, data: { status: 'running' },
      });
      assert.ok(await waitFor(() => refreshes().length === 2));
      // ③ 非绑定会话的帧：不发信号（不产生 refresh）
      dshevents.HUB._onFrame({
        seq: 2, type: 'agent/status', session_id: 'session-other', data: { status: 'running' },
      });
      await sleep(150);
      assert.equal(refreshes().length, 2, '非绑定会话的帧不得唤醒本连接');
    } finally {
      await abortAndSettle(s, base);
    }
  } finally {
    await srv.close();
    fx.close();
  }
});

test('看板流：无变化时发 `: keepalive` 注释帧（缩短等待窗口）', async () => {
  const fx = freshDb('board-stream-keepalive');
  const srv = await startServer(fx.db);
  const old = _setSseTiming({ waitMs: 120 });
  try {
    const pid = insertProject(fx.db, { name: 'p' });
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/stream`);
    try {
      assert.ok(await waitFor(() => s.state.comments.length >= 2, 3000));
      assert.deepEqual(s.state.comments.slice(0, 2), ['keepalive', 'keepalive']);
      assert.equal(s.state.events.length, 1);                          // 只有 hello
    } finally {
      await abortAndSettle(s, base);
    }
  } finally {
    _setSseTiming(old);
    await srv.close();
    fx.close();
  }
});

test('看板流：30s 绑定集合重算 —— 新绑定的会话也能被 dsh 帧唤醒（缩短周期）', async () => {
  const fx = freshDb('board-stream-rebind');
  const srv = await startServer(fx.db);
  const old = _setSseTiming({ waitMs: 60, boundRefreshMs: 60 });
  try {
    const lateSid = 'session-late-1';
    const pid = insertProject(fx.db, { name: 'p' });
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/stream`);
    try {
      const refreshes = () => s.state.events.filter((e) => e.event === 'refresh');
      assert.ok(await waitFor(() => s.state.events.length >= 1));      // hello
      // 连接建立之后才绑定新卡（此时连接手上的 bound 集合里没有它）
      insertCard(fx.db, pid, { title: '新卡', sessionId: lateSid, sessions: JSON.stringify([lateSid]) });
      await waitFor(() => s.state.comments.length >= 2, 2000);         // 走过至少两拍 ⇒ 已重算
      const before = refreshes().length;
      dshevents.HUB._onFrame({
        seq: 3, type: 'agent/status', session_id: lateSid, data: { status: 'running' },
      });
      assert.ok(await waitFor(() => refreshes().length > before, 1500),
        '新绑定的会话未被 dsh 帧唤醒（绑定集合没重算）');
    } finally {
      await abortAndSettle(s, base);
    }
  } finally {
    _setSseTiming(old);
    await srv.close();
    fx.close();
  }
});

test('看板流：客户端断开即收尾，订阅者零泄漏（可重复连接）', async () => {
  const fx = freshDb('board-stream-leak');
  const srv = await startServer(fx.db);
  const old = _setSseTiming({ waitMs: 200 });
  try {
    const pid = insertProject(fx.db, { name: 'p' });
    // 前一例的收尾可能还在飞：先等订阅者数归零再取基线（本文件用例串行）
    assert.ok(await waitFor(() => subscriberCount() === 0, 2000), '进入本用例时订阅者未归零');
    const base = subscriberCount();
    for (let i = 0; i < 3; i += 1) {
      const s = await openSse(`${srv.url}/api/projects/${pid}/board/stream`);
      assert.ok(await waitFor(() => s.state.events.length >= 1));
      assert.equal(subscriberCount(), base + 1, `第 ${i + 1} 次连接应恰好挂 1 个订阅者`);
      await abortAndSettle(s, base);                    // 断开 → 摘订阅者（超时即断言失败）
    }
    assert.equal(subscriberCount(), base);
  } finally {
    _setSseTiming(old);
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// GET /api/projects/<id>/board/sessions/<sid>/stream（SSE）
// ============================================================================

test('会话流：hello（events:true）+ 本 sid 帧 → refresh；别的 sid 不发帧', async () => {
  const fx = freshDb('session-stream');
  const srv = await startServer(fx.db);
  const old = _setSseTiming({ waitMs: 150 });
  try {
    const sid = 'session-ss-1';
    const pid = insertProject(fx.db, { name: 'p' });
    insertCard(fx.db, pid, { title: '卡', sessionId: sid, sessions: JSON.stringify([sid]) });
    // sid 用百分号编码（%2D = '-'）：验证服务端 unquote 后才做归属判定（Python 同）
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/sessions/session%2Dss%2D1/stream`);
    try {
      assert.equal(s.state.status, 200);
      assert.equal(s.state.accel, 'no');
      assert.ok(await waitFor(() => s.state.events.length >= 1));
      assert.deepEqual(s.state.events[0], {
        event: 'hello', data: { project_id: pid, session_id: sid, events: true },
      });
      const refreshes = () => s.state.events.filter((e) => e.event === 'refresh');
      // 别的会话的帧：不唤醒
      dshevents.HUB._onFrame({
        seq: 1, type: 'transcript', session_id: 'session-other', data: { event_seq: 3 },
      });
      await sleep(120);
      assert.equal(refreshes().length, 0, '别的 sid 的帧不得唤醒本连接');
      // 本会话的帧（transcript 逐条消息）→ refresh
      dshevents.HUB._onFrame({
        seq: 2, type: 'transcript', session_id: sid, data: { event_seq: 4 },
      });
      assert.ok(await waitFor(() => refreshes().length === 1));
      assert.deepEqual(refreshes()[0].data, { session_id: sid });
    } finally {
      await abortAndSettle(s, base);
    }
  } finally {
    _setSseTiming(old);
    await srv.close();
    fx.close();
  }
});

test('会话流：归属校验（未绑定 sid / 未知项目 / 仅回收站卡片绑定）404；断开零泄漏', async () => {
  const fx = freshDb('session-stream-404');
  const srv = await startServer(fx.db);
  const old = _setSseTiming({ waitMs: 200 });
  try {
    const pid = insertProject(fx.db, { name: 'p' });
    insertCard(fx.db, pid, { title: '卡', sessionId: 'session-ok', sessions: '["session-ok"]' });
    insertCard(fx.db, pid, {
      title: '回收站卡', sessionId: 'session-trashed', sessions: '["session-trashed"]',
      trashed: 1, trashedAt: '2026-10-11 03:00:00',
    });
    const unbound = await getJson(`${srv.url}/api/projects/${pid}/board/sessions/session-nope/stream`);
    assert.equal(unbound.status, 404);
    assert.deepEqual(unbound.json, { error: 'session not found' });
    // 只在回收站卡片里绑定的 sid：不算归属（list_board_cards 只含 trashed=0）
    const trashed = await getJson(`${srv.url}/api/projects/${pid}/board/sessions/session-trashed/stream`);
    assert.equal(trashed.status, 404);
    assert.deepEqual(trashed.json, { error: 'session not found' });
    const noProj = await getJson(`${srv.url}/api/projects/999999/board/sessions/session-ok/stream`);
    assert.equal(noProj.status, 404);
    assert.deepEqual(noProj.json, { error: 'project not found' });

    // 合法 sid：断开后订阅者归零
    const base = subscriberCount();
    const s = await openSse(`${srv.url}/api/projects/${pid}/board/sessions/session-ok/stream`);
    assert.ok(await waitFor(() => s.state.events.length >= 1));
    assert.equal(subscriberCount(), base + 1);
    await abortAndSettle(s, base);
  } finally {
    _setSseTiming(old);
    await srv.close();
    fx.close();
  }
});

// ============================================================================
// 常量与路由顺序
// ============================================================================

test('常量：keepalive 等待与绑定集合重算周期（与 Python 字面量同值）', () => {
  assert.equal(SSE_WAIT_MS, 15000);
  assert.equal(SSE_BOUND_REFRESH_MS, 30000);
});
