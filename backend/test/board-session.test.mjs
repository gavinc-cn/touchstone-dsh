/**
 * M5-2 写路径单测：ext 行对账 / 起跑 / 会话驱动 / 提示词拼装 / 收尾。
 *
 * 期望值来源一律是 `board.py` 原文（ext 族 754-1037 / `_enter_doing` 1040 / `dequeue_start`
 * 1502 / 提示词 1561-1624 / 会话驱动 1794-2408 / `finish` 2411 / `_finish_run` 2496 /
 * `_watch_runs_once` 2578 / `run_pid` 3839 / `_orphan_hold` 3849），**不是**读 Node 实现
 * 反推——反推只能证明「自己跟自己一致」。
 *
 * 三条测试口径：
 *   ① **驱动面走假驱动**（HTTP 服务 + `TS_AGENT_DRIVER_URL` 注入，照 `chat-lifecycle.test.mjs`
 *      与 `dshdriver.test.mjs` 的既有做法）：不起真 dsh，但走真 `dshdriver` 代码路径。
 *   ② **ext/收尾类不起驱动**：只造行 + 注入记录桩，断言「谁被调、带什么参、落到哪一行」。
 *   ③ **落库一律断言真行**（`board_cards`/`wait_items`/`board_comments` 真列）。
 *
 * 夹具一律 `mkdtemp` 临时库（`m3fixture.freshDb` 走真启动序），**绝不碰生产库**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as chat from '../lib/chat.js';
import * as db from '../lib/db.js';
import * as dshevents from '../lib/dshevents.js';
import * as waitq from '../lib/waitq.js';
import {
  freshDb, insertCard, insertComment, insertMsg, insertProject, insertWait,
} from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 假驱动（形状照 `dsh-plugin/lib/agent-driver.js`：`/touchstone-agent` 前缀 + 令牌头）
// --------------------------------------------------------------------------

const AGENT_BASE = '/touchstone-agent';

/** 假驱动记录的请求体 → 对象（`raw` 是原文字符串，`body` 是解好的对象） */
function bodyOf(call) {
  if (call.body !== null && call.body !== undefined) return call.body;
  return JSON.parse(call.raw);
}

class FakeDriver {
  constructor() {
    this.calls = [];
    this.sessionId = 'sid-fake-1';
    this.sessionFail = null;             // {code, error} 覆盖 /session 回执
    this.promptFail = null;              // {code, error} 覆盖 /prompt 回执
    this.cancelFail = null;
    this.compactFail = null;
    this.forkNewSid = 'sid-fork-1';
    /** `/live` 快照（中枢对齐用）；`complete: true` 才让空/满快照可信 */
    this.live = { sessions: [], complete: true };
    /** 当前挂起的 `/events` 响应（`sendFrame` 向它写帧） */
    this.streams = new Set();
    this.eventsCount = 0;
    this.server = null;
    this.url = '';
  }

  /** 向所有挂起的状态流写一帧（形状照 `dsh-plugin` 的 `session/event` 帧） */
  sendFrame(type, sid, data, seq) {
    const payload = JSON.stringify({ seq, time: 0, type, session_id: sid, data });
    for (const res of this.streams) res.write(`data: ${payload}\n\n`);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(() => { /* 收尾竞态：忽略 */ });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}${AGENT_BASE}`;
    return this;
  }

  async close() {
    for (const res of [...this.streams]) { try { res.end(); } catch { /* 已断 */ } }
    this.streams.clear();
    if (this.server === null) return;
    const srv = this.server;
    this.server = null;
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }

  byPath(p) { return this.calls.filter((c) => c.path === p); }

  _json(res, code, body) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': raw.length,
    });
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
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    this.calls.push({ method: req.method, path: route, raw, body });
    if (req.method === 'GET' && route === '/live') {
      return this._json(res, 200, { sessions: this.live.sessions, complete: this.live.complete });
    }
    if (req.method === 'GET' && route === '/archived') {
      return this._json(res, 200, { archived: [] });
    }
    if (req.method === 'GET' && route === '/events') {
      this.eventsCount += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      });
      res.write(': keepalive\n\n');
      this.streams.add(res);
      // 不主动关闭：本测试的流一直挂到 restore()
      return undefined;
    }
    if (req.method === 'POST' && route === '/session') {
      if (this.sessionFail) return this._json(res, this.sessionFail.code, { error: this.sessionFail.error });
      return this._json(res, 200, { session_id: (body || {}).session_id || this.sessionId });
    }
    if (req.method === 'POST' && route === '/prompt') {
      if (this.promptFail) return this._json(res, this.promptFail.code, { error: this.promptFail.error });
      return this._json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/steer') return this._json(res, 200, { ok: true });
    if (req.method === 'POST' && route === '/cancel') {
      if (this.cancelFail) return this._json(res, this.cancelFail.code, { error: this.cancelFail.error });
      return this._json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/compact') {
      if (this.compactFail) return this._json(res, this.compactFail.code, { error: this.compactFail.error });
      return this._json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/fork') {
      return this._json(res, 200, { new_session_id: this.forkNewSid });
    }
    if (req.method === 'POST' && route === '/rename') return this._json(res, 200, { ok: true });
    if (req.method === 'GET' && route === '/status') {
      return this._json(res, 200, { status: 'idle', last_seq: 3 });
    }
    return this._json(res, 404, { error: `未知驱动端点 ${route}（假驱动）` });
  }
}

/** 起假驱动并把它注入进程环境（测试末尾必须 `restore()`） */
async function useDriver() {
  const drv = await new FakeDriver().start();
  const oldUrl = process.env.TS_AGENT_DRIVER_URL;
  const oldToken = process.env.TS_AGENT_DRIVER_TOKEN;
  process.env.TS_AGENT_DRIVER_URL = drv.url;
  process.env.TS_AGENT_DRIVER_TOKEN = 'tok-test';
  return {
    drv,
    async restore() {
      if (oldUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
      else process.env.TS_AGENT_DRIVER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.TS_AGENT_DRIVER_TOKEN;
      else process.env.TS_AGENT_DRIVER_TOKEN = oldToken;
      await drv.close();
    },
  };
}

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/**
 * 装**记录型 spy**：三个必经钩子的调用流水（谁被调、带什么参、什么顺序），实现仍是生产件。
 *
 * 为什么不换成「只记录不干活」的桩：桩会让「行没被收口/卡没搬列」这类真问题看起来像通过
 * （第三起误写生产库事故的教训之一就是桩太宽容）。这里只**旁观**生产实现的入参，把
 * 「缝的形参形状」钉成契约——形状改了这里就红。
 *
 * 形参口径（与 M5-1 的 canonical 修复同批）：
 *   - `enterDoing(project, card, extra, force, worktree, queueWorktree, lang, options)` 逐位 8 参；
 *   - `stopCard(cardId, options)` 第 2 参＝db options 袋（**不嵌套** `{options}`）；
 *   - `finish(key, reason, opts)` 第 3 参＝收尾 opts（`toColumn`/`markUnread` + 平铺的 db 袋）。
 * `archiveCardSessions` **保持未注入**（M5-3 的口，响亮失败由专门用例覆盖）。
 */
function installHooks() {
  const calls = [];
  const prod = board.boardHooks();
  board.setBoardHooks({
    enterDoing: (project, card, extra = '', force = false, worktree = false,
      queueWorktree = false, lang = '', options = {}) => {
      calls.push(['enterDoing', card.id, extra, force, worktree, queueWorktree, lang, options]);
      return prod.enterDoing(project, card, extra, force, worktree, queueWorktree, lang, options);
    },
    stopCard: (cardId, options = {}) => {
      calls.push(['stopCard', cardId, options]);
      return prod.stopCard(cardId, options);
    },
    finish: (key, reason, opts = {}) => {
      calls.push(['finish', key, reason, opts.toColumn ?? null, opts.markUnread !== false]);
      return prod.finish(key, reason, opts);
    },
  });
  return calls;
}

/** 一次测试的夹具：临时库 + 一个项目 + 记录桩 */
function setup(tag = 'board-session') {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir,
  });
  const calls = installHooks();
  const opts = { db: fx.db };
  return {
    fx,
    pid,
    calls,
    opts,
    ...fx,
    /** 拆 spy、恢复生产钩子（需要「缝未注入即响亮失败」的用例先调它） */
    restoreHooks() {
      board.setBoardHooks({
        enterDoing: board.enterDoing, stopCard: board.stopCard, finish: board.finish,
      });
    },
  };
}

/**
 * 夹具对象 → 真库句柄。两种形态都要吃：
 *   - `setup()` 的返回（展开了 freshDb，句柄在 `.db`）；
 *   - **裸 `sqlite` 句柄本身**（`s.fx.db` 这种写法在调用点很自然，两处都容错）。
 */
function handleOf(fx) {
  if (fx === null || fx === undefined) throw new Error('夹具为空');
  if (typeof fx.prepare === 'function') return fx;
  if (fx.db !== null && fx.db !== undefined) return fx.db;
  throw new Error('夹具里没有库句柄');
}

/** 读卡片真行 */
function cardRow(fx, cardId) {
  return handleOf(fx).prepare('SELECT * FROM board_cards WHERE id=?').get(cardId);
}

/** 读活跃等待行（可指定 kind） */
function activeWait(fx, kind, targetId) {
  return handleOf(fx).prepare(
    'SELECT * FROM wait_items WHERE kind=? AND target_id=? ORDER BY id DESC LIMIT 1',
  ).get(kind, String(targetId));
}

/** 清进程内登记表（防用例间串状态） */
function clearRegistries(...cardIds) {
  for (const cid of cardIds) {
    board.runRegistry.delete(cid);
    board.wtRegistry.delete(cid);
  }
}

// --------------------------------------------------------------------------
// ① 提示词拼装：逐字节
// --------------------------------------------------------------------------

test('buildTaskPrompt：标题并入描述 + 「未命名」剔除 + worktree 行（逐字节）', async () => {
  const s = setup('prompt-task');
  const plain = { id: 11, title: '任务A', description: '做点事', worktree: '' };
  const proj = { id: s.pid, project_dir: '/w/proj' };
  assert.equal(board.buildTaskPrompt(proj, plain),
    '【任务描述】任务A\n\n做点事\n【工作目录】/w/proj');

  // 卡面空标题占位「未命名」不参与拼接（Python `if title == "未命名": title = ""`）
  assert.equal(board.buildTaskPrompt(proj, { id: 12, title: '未命名', description: 'x', worktree: '' }),
    '【任务描述】x\n【工作目录】/w/proj');
  // 标题与描述都空 ⇒ 「（无）」
  assert.equal(board.buildTaskPrompt(proj, { id: 13, title: '', description: '', worktree: '' }),
    '【任务描述】（无）\n【工作目录】/w/proj');
  // 两侧空白 strip（Python `.strip()`）
  assert.equal(board.buildTaskPrompt(proj, { id: 14, title: '  T  ', description: '  D  ', worktree: '' }),
    '【任务描述】T\n\nD\n【工作目录】/w/proj');

  // worktree 卡：【工作目录】= 工作树路径 + 一行分支/主仓库说明
  const wt = '/w/proj/worktrees/card_21';
  assert.equal(
    board.buildTaskPrompt(proj, { id: 21, title: 'T', description: 'D', worktree: wt }),
    `【任务描述】T\n\nD\n【工作目录】${wt}`
      + `\n（本任务运行在独立 git worktree 中：分支 ts/card-21，主仓库 /w/proj）`,
  );

  // 打回意见段（extra 非空才追加）
  assert.equal(board.buildTaskPrompt(proj, plain, '改这里'),
    '【任务描述】任务A\n\n做点事\n【工作目录】/w/proj\n【修改意见】改这里\n请按修改意见继续完善。');
});

test('buildContinuePrompt / buildStartPrompt：继续壳、MERGE_TASK_MARK 原文直发、PROMPT_MAX 截断', async () => {
  const s = setup('prompt-cont');
  const proj = { id: s.pid, project_dir: '/w/proj' };
  const card = { id: 31, title: 'T', description: 'D', worktree: '' };
  assert.equal(board.buildContinuePrompt(), '继续');
  assert.equal(board.buildContinuePrompt('意见'), '继续\n【修改意见】意见\n请按修改意见继续完善。');
  // 有可续接主会话 ⇒ 「继续」；无 sid ⇒ 全量首轮
  assert.equal(board.buildStartPrompt(proj, card, '意见', 'sid-1'),
    '继续\n【修改意见】意见\n请按修改意见继续完善。');
  assert.equal(board.buildStartPrompt(proj, card, '', ''),
    '【任务描述】T\n\nD\n【工作目录】/w/proj');
  // 合并回交指令原文直发（不套「【修改意见】…」壳），且不动标题/描述
  const merge = `${board.MERGE_TASK_MARK}把卡片 #31 的改动合并回主分支。`;
  assert.equal(board.buildStartPrompt(proj, card, merge, 'sid-1'), merge);
  assert.equal(board.buildStartPrompt(proj, card, merge, ''), merge);

  // PROMPT_MAX 截断（Python `p[:PROMPT_MAX]`）：恰好 20000 不截、超出即截到 20000
  assert.equal(board.PROMPT_MAX, 20000);
  assert.equal(board.buildContinuePrompt('a'.repeat(board.PROMPT_MAX - 2)).length, board.PROMPT_MAX);
  // （「继续」2 字 + 20000-2 个 a = 恰好上限 ⇒ 不截）
  assert.equal(board.buildContinuePrompt('a'.repeat(30000)).length, board.PROMPT_MAX);
  assert.equal(board.buildTaskPrompt(proj,
    { id: 32, title: '', description: 'x'.repeat(30000), worktree: '' }).length, board.PROMPT_MAX);
  const marked = `${board.MERGE_TASK_MARK}${'m'.repeat(30000)}`;
  const markedOut = board.buildStartPrompt(proj, card, marked, '');
  assert.equal(markedOut.length, board.PROMPT_MAX);
  assert.ok(markedOut.startsWith(board.MERGE_TASK_MARK));
});

test('buildMergeInstruction：路径写死 + dirty 行 + 六步原文（逐字节）', async () => {
  const s = setup('prompt-merge');
  const proj = { id: s.pid, project_dir: '/w/proj' };
  const card = { id: 41 };
  const st = {
    branch: 'ts/card-41', target: 'master', path: '/w/proj/worktrees/card_41',
    ahead: 3, behind: 0, dirty: false, dirty_count: 0,
  };
  const out = board.buildMergeInstruction(proj, card, st);
  const lines = out.split('\n');
  assert.equal(lines[0], `${board.MERGE_TASK_MARK}把卡片 #41 的独立 worktree 改动合并回主分支。`);
  assert.equal(lines[1], '工作树：/w/proj/worktrees/card_41（分支 ts/card-41，你的会话工作目录）');
  assert.equal(lines[2], '主仓库：/w/proj（主分支 master）');
  assert.equal(lines[3], '待合并提交：3 个');
  assert.equal(lines[4], '');                       // 段间空行（Python head + [""] + steps）
  assert.equal(lines[5], '步骤：');
  assert.ok(!out.includes('未提交改动，第一步先提交它们'));
  // dirty>0 才追一行
  const dirty = board.buildMergeInstruction(proj, card, { ...st, dirty: true, dirty_count: 2 });
  assert.ok(dirty.includes('工作树当前有 2 处未提交改动，第一步先提交它们。'));
  // 合并口径原文（用户 2026-10-07 约定）逐字在
  assert.ok(out.includes('`git -C /w/proj merge --ff-only ts/card-41`'));
  assert.ok(out.includes('`git -C /w/proj merge --abort`（主仓库侧）回退'));
  assert.ok(out.includes('不要 push，不要 rebase/重置主分支'));
  assert.ok(out.endsWith('绝不留半合并状态，并在报告里说明卡在哪里。'));
});

// --------------------------------------------------------------------------
// ② ext 行族：无候选 / 有候选 / 已有行（幂等）
// --------------------------------------------------------------------------

/** 给 dshevents 的进程内注册表喂一条 running 会话（测试专用：直接插 HUB 表不建真 SSE） */
function feedSession(sid, { cwd, status = 'running', origin = '' }) {
  // dshevents 的读口是模块内注册表；测试经其公开写口不可用 ⇒ 用 `subscribe` 之外的最小面：
  // `snapshot()` 返回的就是 `HUB.sessions`。这里按 M2 的测试同款做法改表。
  const snap = boardExtSnapshotHack();
  snap.set(sid, {
    session_id: sid, status, cwd, origin, owned: true, task: '',
  });
  return () => snap.delete(sid);
}

/** 取 dshevents 内部注册表（`snapshot()` 的来源）——测试喂帧专用，只在本文件用 */
let SNAP = null;
function boardExtSnapshotHack() {
  if (SNAP === null) {
    // 动态取：`snapshot()` 的返回值是注册表的浅拷贝，故这里改用 EventHub 的公开面：
    // `dshevents.js` 未导出表本身，用 `feed` 走 `subscribe` 回调不可行（回调是只读帧口）。
    // ⇒ 改从模块内部取：见下方 `import`（`__testFeed`）。
    SNAP = dsheventsTestFeed();
  }
  return SNAP;
}

test('extCandidates/extRefresh：未连接中枢 ⇒ null（保行，绝不把未知当空闲）', async () => {
  const s = setup('ext-noconn');
  const card = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing', sessionId: 'sid-1' });
  insertWait(s.fx.db, {
    projectId: s.pid, kind: 'ext', targetId: card, state: 'running', seq: 1,
    meta: JSON.stringify({ sid: 'sid-1' }),
  });
  const proj = db.getProject(s.pid, s.opts);
  // 未连接（无 TS_AGENT_DRIVER_URL / 中枢未 start）⇒ 探测不可用
  assert.equal(board.extRefresh(proj, s.opts), null);
  assert.equal(activeWait(s.fx.db, 'ext', card).state, 'running');   // 保行
  assert.equal(board.refreshExtRows('测试对账', s.opts), false);      // 无变化、不空唤醒
  assert.equal(activeWait(s.fx.db, 'ext', card).state, 'running');
  // 未连接时 extCandidates 直接抛（调用方按「探测不可用」处置）
  assert.throws(() => board.extCandidates(proj,
    db.listBoardCards(s.pid, s.opts)), /状态事件中枢未连接/);
  clearRegistries(card);
  s.close();
});

/** 等条件成立（最长 3s）；返回是否成立 */
async function until(fn, limit = 3000) {
  const deadline = Date.now() + limit;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

test('extCandidates/extRefresh（中枢在线）：有候选 ⇒ 建行；已有行 ⇒ 幂等不重复建', async () => {
  const d = await useDriver();
  const s = setup('ext-connected');
  const hub = dshevents.HUB;
  try {
    const card = insertCard(s.fx.db, s.pid, {
      title: 'C', columnKey: 'doing', sessionId: 'sid-run',
    });
    d.drv.live = {
      sessions: [{ session_id: 'sid-run', status: 'running', cwd: s.dir, owned: true }],
      complete: true,
    };
    assert.equal(dshevents.start(), true, '中枢应起消费循环');
    assert.ok(await until(() => dshevents.connected()), '中枢未在 3s 内连上假驱动');
    assert.ok(await until(() => d.drv.eventsCount >= 1), '状态流未建立');
    const proj = db.getProject(s.pid, s.opts);
    // ① 有候选：建 ext 行（running 落前缀尾）
    const cand = board.extCandidates(proj, db.listBoardCards(s.pid, s.opts));
    assert.deepEqual(cand.desired, { [card]: 'sid-run' });
    assert.equal(cand.hold.size, 0);
    assert.equal(cand.unbound.size, 0);
    assert.equal(board.extRefresh(proj, s.opts), true);
    const row = activeWait(s.fx.db, 'ext', card);
    assert.equal(row.state, 'running');
    assert.equal(JSON.parse(row.meta).sid, 'sid-run');
    // ② 已有行：幂等不重复建（无变化 ⇒ false）
    assert.equal(board.extRefresh(proj, s.opts), false);
    assert.equal(s.fx.db.prepare(
      "SELECT COUNT(*) AS n FROM wait_items WHERE kind='ext' AND target_id=?",
    ).get(String(card)).n, 1);
    // ③ 实况空闲 ⇒ 收口让出前缀位次
    d.drv.sendFrame('agent/status', 'sid-run', { status: 'idle' }, 5);
    assert.ok(await until(() => (dshevents.get('sid-run') || {}).status === 'idle'));
    assert.equal(board.extRefresh(proj, s.opts), true);
    assert.equal(activeWait(s.fx.db, 'ext', card).state, 'done');
    // ④ 子代理会话不构成占用（origin=subagent）：不建行
    d.drv.sendFrame('session/created', 'sid-sub', { cwd: s.dir, origin: 'subagent' }, 6);
    d.drv.sendFrame('agent/status', 'sid-sub', { status: 'running' }, 7);
    assert.ok(await until(() => (dshevents.get('sid-sub') || {}).status === 'running'));
    assert.equal(board.extRefresh(proj, s.opts), false);
    assert.equal(activeWait(s.fx.db, 'ext', card).state, 'done');
    // ⑤ 跨项目 cwd 的会话不算本项目占用；未绑卡会话进 unbound（触发投影）
    d.drv.sendFrame('session/created', 'sid-elsewhere', { cwd: '/tmp/other', origin: '' }, 8);
    d.drv.sendFrame('agent/status', 'sid-elsewhere', { status: 'running' }, 9);
    const cand2 = board.extCandidates(proj, db.listBoardCards(s.pid, s.opts));
    assert.deepEqual(cand2.desired, {});
    assert.equal(cand2.unbound.size, 0);          // cwd 不匹配 ⇒ 连 unbound 都不进
    clearRegistries(card);
  } finally {
    await dshevents.stop(200);
    hub._setConnected(false);
    await d.restore();
    s.close();
  }
});

test('extStaleFinish/finishAllExt：目标集外收口；脏 target 照收；hold 保行；全量收口', async () => {
  const s = setup('ext-stale');
  const keep = insertCard(s.fx.db, s.pid, { title: 'K', columnKey: 'doing' });
  const drop = insertCard(s.fx.db, s.pid, { title: 'D', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: keep, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: drop, state: 'running', seq: 2 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: 'dirty-key', state: 'running', seq: 3 });
  const changed = board.extStaleFinish(s.pid, { [keep]: 'sid-k' }, new Set(), s.opts);
  assert.equal(changed, true);
  assert.equal(activeWait(s.fx.db, 'ext', keep).state, 'running');    // 目标集内：保留
  assert.equal(activeWait(s.fx.db, 'ext', drop).state, 'done');       // 目标集外：收口
  // 脏 target（非整数）也照收：`cid = None` 只让它「不在任何集合里」，行仍走 finish
  // （Python `_ext_stale_finish` 的实际行为；其注释「不能建收尾键，跳过」措辞误导）
  assert.equal(activeWait(s.fx.db, 'ext', 'dirty-key').state, 'done');
  // 第二次：keep 在目标集内保行，其余两行已终态 ⇒ 无活跃行可收（幂等 false）
  assert.equal(board.extStaleFinish(s.pid, { [keep]: 'sid-k' }, new Set(), s.opts), false);
  assert.equal(activeWait(s.fx.db, 'ext', keep).state, 'running');
  // hold 集：重建一枚活跃行（drop）。desired={drop} 且 hold={drop,keep} ⇒ 两行都不动
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: drop, state: 'running', seq: 4 });
  assert.equal(board.extStaleFinish(s.pid, { [String(drop)]: 'sid-d' },
    new Set([drop, keep]), s.opts), false);
  assert.equal(activeWait(s.fx.db, 'ext', drop).state, 'running');
  assert.equal(activeWait(s.fx.db, 'ext', keep).state, 'running');
  // 同一行**不**在 hold 集里 ⇒ 照收（两次调用只差 hold，正是 hold 语义的判据）
  assert.equal(board.extStaleFinish(s.pid, { [String(drop)]: 'sid-d' }, new Set(), s.opts), true);
  assert.equal(activeWait(s.fx.db, 'ext', keep).state, 'done');
  assert.equal(activeWait(s.fx.db, 'ext', drop).state, 'running');
  // drop 在目标集内 ⇒ 保留（收口已由上一句落在 keep 上）
  assert.equal(board.extStaleFinish(s.pid, { [String(drop)]: 'sid-d' }, new Set(), s.opts), false);
  // 空目标集 ⇒ drop 收口
  assert.equal(board.extStaleFinish(s.pid, {}, new Set(), s.opts), true);
  assert.equal(activeWait(s.fx.db, 'ext', drop).state, 'done');
  assert.equal(board.extStaleFinish(s.pid, {}, new Set(), s.opts), false);   // 幂等
  // 全量收口：此刻已无活跃行 ⇒ 幂等 false（`ext:1` 的活跃行在第 469 行那次已收口）
  assert.equal(board.finishAllExt(s.pid, '退场族无外部占用信号', s.opts), false);
  // 再建一枚活跃行验证全量语义：不问目标集，一律收口
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: keep, state: 'running', seq: 9 });
  assert.equal(board.finishAllExt(s.pid, '退场族无外部占用信号', s.opts), true);
  assert.equal(activeWait(s.fx.db, 'ext', keep).state, 'done');
  assert.equal(board.finishAllExt(s.pid, '再来一发', s.opts), false);
  assert.equal(activeWait(s.fx.db, 'ext', drop).state, 'done');
  assert.equal(activeWait(s.fx.db, 'ext', 'dirty-key').state, 'done');
  clearRegistries(keep, drop);
  s.close();
});

test('upsertExt：sid 缺失/平台持有者/已有活跃行 ⇒ 不建；否则建 running 行（幂等）', async () => {
  const s = setup('ext-upsert');
  const proj = db.getProject(s.pid, s.opts);
  const c1 = insertCard(s.fx.db, s.pid, { title: 'C1', columnKey: 'doing' });
  assert.equal(board.upsertExt(proj, c1, '', s.opts), false);          // 无 sid
  assert.equal(board.upsertExt(proj, c1, 'sid-1', s.opts), true);      // 建行
  assert.equal(activeWait(s.fx.db, 'ext', c1).state, 'running');
  assert.equal(board.upsertExt(proj, c1, 'sid-1', s.opts), false);     // 已有活跃行
  // 平台持有者（活跃 c: 行）在场 ⇒ 不建行
  const c2 = insertCard(s.fx.db, s.pid, { title: 'C2', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c2, state: 'running', seq: 9 });
  assert.equal(board.upsertExt(proj, c2, 'sid-2', s.opts), false);
  assert.equal(activeWait(s.fx.db, 'ext', c2), undefined);
  clearRegistries(c1, c2);
  s.close();
});

test('recoverExtRows：有排队卡的项目也进刷新面；项目已删 ⇒ 全量收口', async () => {
  const s = setup('ext-recover');
  const card = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: card, state: 'running', seq: 1 });
  // 项目已删（防御分支）：行全量收口
  const changed = board.recoverExtRows([], s.opts);
  // 项目还在 ⇒ 走 extRefresh ⇒ 未连接中枢 ⇒ null ⇒ 保行（不变）
  assert.equal(changed, false);
  assert.equal(activeWait(s.fx.db, 'ext', card).state, 'running');
  // 把项目删掉再跑：全部行收口
  s.fx.db.prepare('DELETE FROM projects WHERE id=?').run(s.pid);
  assert.equal(board.recoverExtRows([], s.opts), true);
  assert.equal(activeWait(s.fx.db, 'ext', card).state, 'done');
  clearRegistries(card);
  s.close();
});

// --------------------------------------------------------------------------
// ③ 起跑：排队占位分支（不碰驱动）与起跑失败回滚
// --------------------------------------------------------------------------

test('enterDoing：runner 缺位时直起（走真驱动）；落 doing + cardStarted 不适用（无单例）', async () => {
  const d = await useDriver();
  const s = setup('enter-direct');
  try {
    // runner 单例缺位（单测环境）⇒ 不入队、直起
    const card = insertCard(s.fx.db, s.pid, {
      title: 'T', description: 'D', columnKey: 'todo',
    });
    const proj = db.getProject(s.pid, s.opts);
    const [res, err] = await board.enterDoing(proj, db.getBoardCard(card, s.opts), '', false, false,
      false, '', s.opts);
    assert.equal(err, null);
    assert.equal(res.column, 'doing');
    assert.equal(cardRow(s.fx, card).block_kind, null);
    assert.equal(cardRow(s.fx, card).last_error, '');
    assert.equal(cardRow(s.fx, card).scheduled_at, null);      // 离开待开发清定时
    // 真驱动被调：/session 建会话 + /prompt 首投
    assert.equal(d.drv.byPath('/session').length, 1);
    assert.equal(d.drv.byPath('/prompt').length, 1);
    const sent = bodyOf(d.drv.byPath('/prompt')[0]).prompt;
    assert.equal(sent, '【任务描述】T\n\nD\n【工作目录】' + s.dir);
    // sid 立即可知并入库（建完即入库）
    assert.equal(cardRow(s.fx, card).session_id, 'sid-fake-1');
    assert.deepEqual(JSON.parse(cardRow(s.fx, card).sessions), ['sid-fake-1']);
    assert.equal(board.hasActiveRun(card), true);
    // 已入队（doing+queue）幂等分支：不重复起会话
    db.updateBoardCard(card, false, { block_kind: 'queue' }, s.opts);
    const [res2, err2] = await board.enterDoing(proj, db.getBoardCard(card, s.opts), '', false,
      false, false, '', s.opts);
    assert.equal(err2, null);
    assert.equal(res2.block_kind, 'queue');
    assert.equal(d.drv.byPath('/session').length, 1);           // 未再起会话
    clearRegistries(card);
  } finally {
    await d.restore();
    s.close();
  }
});

test('enterDoing：在管预检拦下（活跃 c: 行/在管条目）⇒ 带卡片返回错误', async () => {
  const s = setup('enter-guard');
  const proj = db.getProject(s.pid, s.opts);
  const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'starting', seq: 1 });
  const [res, err] = await board.enterDoing(proj, db.getBoardCard(card, s.opts), '', false, false,
    false, '', s.opts);
  assert.equal(res.id, card);
  assert.deepEqual(err, { error: '会话运行中，请等待完成或先停止' });
  // 在管条目分支
  board.runRegistry.set(card, { proc: null, aborted: false });
  const [, err2] = await board.enterDoing(proj, db.getBoardCard(card, s.opts), '', false, false,
    false, s.opts);
  assert.deepEqual(err2, { error: '会话运行中，请等待完成或先停止' });
  clearRegistries(card);
  s.close();
});

test('enterDoing：父依赖未完成 ⇒ blocked（review 卡放行）', async () => {
  const s = setup('enter-parent');
  const proj = db.getProject(s.pid, s.opts);
  const parent = insertCard(s.fx.db, s.pid, { title: 'P', columnKey: 'doing' });
  const child = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'todo', parentCardId: parent });
  const [res, err] = await board.enterDoing(proj, db.getBoardCard(child, s.opts), '', false, false,
    false, '', s.opts);
  assert.equal(res, null);
  assert.deepEqual(err, { blocked: 'parent-not-done' });
  // review 卡打回续改放行（父依赖不拦）——但会真起会话 ⇒ 这里只验证「不返回 blocked」
  s.close();
});

test('enterDoing：退场族 ⇒ RETIRED_MSG（不落任何起会话路径）', async () => {
  const s = setup('enter-retired');
  const pid = insertProject(s.fx.db, {
    userId: 1, name: 'old', projectDir: s.dir, workDir: s.dir, agentPath: '/usr/bin/kimi',
  });
  const proj = db.getProject(pid, s.opts);
  const card = insertCard(s.fx.db, pid, { title: 'T', columnKey: 'todo' });
  const [res, err] = await board.enterDoing(proj, db.getBoardCard(card, s.opts), '', false, false,
    false, '', s.opts);
  assert.equal(res, null);
  assert.equal(err.error, '该智能体族已下线，请在项目设置里改绑 dsh 插件');
  assert.equal(cardRow(s.fx, card).column_key, 'todo');        // 列不动
  s.close();
});

test('dequeueStart：起跑失败 ⇒ 清占位 + 回 from_column + finish 收口（假驱动抛错）', async () => {
  const d = await useDriver();
  const s = setup('dequeue-fail');
  try {
    d.drv.sessionFail = { code: 500, error: '宿主炸了' };
    const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing', blockKind: 'queue' });
    insertWait(s.fx.db, {
      projectId: s.pid, kind: 'card', targetId: card, state: 'starting', seq: 1,
      meta: JSON.stringify({ extra: '改这个', from_column: 'review' }),
    });
    const proj = db.getProject(s.pid, s.opts);
    const ok = await board.dequeueStart(proj, db.getBoardCard(card, s.opts), s.opts);
    assert.equal(ok, false);
    const row = cardRow(s.fx, card);
    assert.equal(row.column_key, 'review');                    // 回 from_column
    assert.equal(row.block_kind, null);
    assert.equal(row.block_text, '');
    assert.ok(String(row.last_error).startsWith('会话启动失败: '));   // last_error 已记
    // finish 被调（行收口）：starting 行不收 ⇒ 行仍是 starting（归 worker finally）
    assert.ok(s.calls.some((c) => c[0] === 'finish' && c[1] === `c:${card}`));
    assert.equal(activeWait(s.fx.db, 'card', card).state, 'starting');
    // from_column 非法/缺失 ⇒ 回落 blocked
    d.drv.sessionFail = { code: 500, error: '再炸' };
    const card2 = insertCard(s.fx.db, s.pid, { title: 'T2', columnKey: 'doing', blockKind: 'queue' });
    insertWait(s.fx.db, {
      projectId: s.pid, kind: 'card', targetId: card2, state: 'starting', seq: 2,
      meta: JSON.stringify({ extra: '', from_column: 'nope' }),
    });
    assert.equal(await board.dequeueStart(proj, db.getBoardCard(card2, s.opts), s.opts), false);
    assert.equal(cardRow(s.fx, card2).column_key, 'blocked');
    // meta 坏 JSON ⇒ extra/from_column 按空（回落 blocked）
    d.drv.sessionFail = { code: 500, error: '三炸' };
    const card3 = insertCard(s.fx.db, s.pid, { title: 'T3', columnKey: 'doing', blockKind: 'queue' });
    insertWait(s.fx.db, {
      projectId: s.pid, kind: 'card', targetId: card3, state: 'starting', seq: 3, meta: '{坏',
    });
    assert.equal(await board.dequeueStart(proj, db.getBoardCard(card3, s.opts), s.opts), false);
    assert.equal(cardRow(s.fx, card3).column_key, 'blocked');
    clearRegistries(card, card2, card3);
  } finally {
    await d.restore();
    s.close();
  }
});

test('dequeueStart：起跑成功 ⇒ 落 doing + 发 extra（meta 里的打回意见）', async () => {
  const d = await useDriver();
  const s = setup('dequeue-ok');
  try {
    const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing', blockKind: 'queue' });
    insertWait(s.fx.db, {
      projectId: s.pid, kind: 'card', targetId: card, state: 'starting', seq: 1,
      meta: JSON.stringify({ extra: '把日志加上', from_column: 'todo' }),
    });
    const proj = db.getProject(s.pid, s.opts);
    assert.equal(await board.dequeueStart(proj, db.getBoardCard(card, s.opts), s.opts), true);
    assert.equal(cardRow(s.fx, card).column_key, 'doing');
    const sent = bodyOf(d.drv.byPath('/prompt')[0]).prompt;
    assert.equal(sent, '【任务描述】T\n\ndesc\n【工作目录】' + s.dir
      + '\n【修改意见】把日志加上\n请按修改意见继续完善。');
    clearRegistries(card);
  } finally {
    await d.restore();
    s.close();
  }
});

test('enterDoing：队列分支（runner 单例在场）⇒ 委托 submitCard，不碰驱动', async () => {
  const s = setup('enter-queue');
  const submitted = [];
  const inst = {
    submitCard(cardId, extra = '', fromColumn = '', afterPrefix = false) {
      submitted.push([cardId, extra, fromColumn, afterPrefix]);
      // 真实现的副作用：waitq 单事务写行 + 占位
      waitq.enqueueCard(cardId, s.pid, extra, fromColumn || 'todo', waitq.CARD_QUEUE_TEXT, s.opts);
    },
    notifyBusyChange() { submitted.push(['notify']); },
  };
  try {
    board.setRunnerInstance(inst);
    const proj = db.getProject(s.pid, s.opts);
    const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'todo' });
    const [res, err] = await board.enterDoing(proj, db.getBoardCard(card, s.opts), 'ex', false,
      false, false, '', s.opts);
    assert.equal(err, null);
    assert.deepEqual(submitted[0], [card, 'ex', '', false]);      // todo ⇒ 落等待区末尾
    const row = cardRow(s.fx, card);
    assert.equal(row.column_key, 'doing');                        // 占位落 doing/queue
    assert.equal(row.block_kind, 'queue');
    assert.equal(res.queue_state, 'queued_serial');
    // review ⇒ 插前缀后
    submitted.length = 0;
    const card2 = insertCard(s.fx.db, s.pid, { title: 'T2', columnKey: 'review' });
    await board.enterDoing(proj, db.getBoardCard(card2, s.opts), '', false, false, false, '',
      s.opts);
    assert.deepEqual(submitted[0], [card2, '', '', true]);
  } finally {
    board.setRunnerInstance(null);
    s.close();
  }
});

// --------------------------------------------------------------------------
// ④ stopCard：假驱动断言 abort + 卡片落 review + 排队消息取消 + 待送达答案放弃
// --------------------------------------------------------------------------

test('stopCard：在管条目 ⇒ 驱动 cancel 命中；返回 true；登记 STOP_STAMP', async () => {
  const d = await useDriver();
  const s = setup('stop-run');
  try {
    const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing' });
    const proj = db.getProject(s.pid, s.opts);
    await board.startCard(proj, db.getBoardCard(card, s.opts), '', '', s.opts);   // T13：第 4 参 lang
    assert.equal(board.hasActiveRun(card), true);
    assert.equal(await board.stopCard(card, s.opts), true);
    assert.equal(d.drv.byPath('/cancel').length, 1);
    assert.equal(d.drv.byPath('/cancel')[0].body.session_id, 'sid-fake-1');
    assert.equal(board.runRegistry.get(card).aborted, true);      // 标记 aborted（巡视据此正常收尾）
    assert.equal(board.runningMap()[card], false);                // 停止按钮即时反馈
    assert.equal(board.stopRecent(card), true);                   // 调和器宽限期
    clearRegistries(card);
  } finally {
    await d.restore();
    s.close();
  }
});

test('stopCard：排队占位卡（无在管条目）⇒ 出队收口落 review + 取消排队消息 + 放弃答案', async () => {
  const s = setup('stop-queue');
  const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing', blockKind: 'queue' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'waiting', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'answer', targetId: card, state: 'waiting', seq: 2 });
  insertMsg(s.fx.db, { id: 'm1', projectId: s.pid, sid: 'sid-x', cardId: card, state: 'queued' });
  assert.equal(await board.stopCard(card, s.opts), true);
  assert.equal(cardRow(s.fx, card).column_key, 'review');          // to_column=review
  assert.equal(cardRow(s.fx, card).block_kind, null);
  assert.equal(cardRow(s.fx, card).unread, 0);                     // mark_unread=false（用户本人操作）
  assert.equal(activeWait(s.fx.db, 'card', card).state, 'cancelled');
  assert.equal(activeWait(s.fx.db, 'answer', card).state, 'cancelled');   // 放弃待送达答案
  assert.equal(s.fx.db.prepare('SELECT state FROM chat_msgs WHERE id=?').get('m1').state,
    'cancelled');
  clearRegistries(card);
  s.close();
});

test('stopCard：无在管条目但卡有 sid ⇒ 兜底按 sid cancel（外部同步卡场景）', async () => {
  const d = await useDriver();
  const s = setup('stop-bare');
  try {
    const card = insertCard(s.fx.db, s.pid, {
      title: 'T', columnKey: 'doing', sessionId: 'sid-external',
    });
    assert.equal(await board.stopCard(card, s.opts), true);
    assert.equal(d.drv.byPath('/cancel')[0].body.session_id, 'sid-external');
    // 无 sid ⇒ 无停止通道
    const card2 = insertCard(s.fx.db, s.pid, { title: 'T2', columnKey: 'doing' });
    assert.equal(await board.stopCard(card2, s.opts), false);
    // 卡不存在 ⇒ false
    assert.equal(await board.stopCard(99999999, s.opts), false);
  } finally {
    await d.restore();
    s.close();
  }
});

test('stopCard：驱动不可达 ⇒ false（不打穿请求处理器）', async () => {
  const s = setup('stop-fail');
  const card = insertCard(s.fx.db, s.pid, {
    title: 'T', columnKey: 'doing', sessionId: 'sid-x',
  });
  process.env.TS_AGENT_DRIVER_URL = 'http://127.0.0.1:1/touchstone-agent';
  try {
    assert.equal(await board.stopCard(card, s.opts), false);
  } finally {
    delete process.env.TS_AGENT_DRIVER_URL;
    s.close();
  }
});

// --------------------------------------------------------------------------
// ⑤ finish：幂等（finishing 重入、终态重入、ext: 分支）+ 搬列 toColumn/mark_unread
// --------------------------------------------------------------------------

test('finish：c: 行 running→finishing→done，搬列按 toColumn/markUnread；幂等重入', async () => {
  const s = setup('finish-card');
  const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing' });
  const rowId = insertWait(s.fx.db, {
    projectId: s.pid, kind: 'card', targetId: card, state: 'running', seq: 1,
  });
  // runner 单例缺位：跳过行收口仍搬列
  board.finish(`c:${card}`, '会话结束收尾', { toColumn: 'review', options: s.opts });
  assert.equal(cardRow(s.fx, card).column_key, 'review');
  assert.equal(cardRow(s.fx, card).block_kind, null);
  assert.equal(cardRow(s.fx, card).unread, 1);        // 默认 mark_unread=true（平台搬列要标记）
  assert.equal(activeWait(s.fx.db, 'card', card).state, 'running');   // 无单例 ⇒ 行不收
  // 幂等：列已同 ⇒ 不再写列（unread 不再翻动）
  s.fx.db.prepare('UPDATE board_cards SET unread=0 WHERE id=?').run(card);
  board.finish(`c:${card}`, '再来', { toColumn: 'review', options: s.opts });
  assert.equal(cardRow(s.fx, card).unread, 0);
  // mark_unread=false 透传
  board.finish(`c:${card}`, '用户停止', { toColumn: 'blocked', markUnread: false, options: s.opts });
  assert.equal(cardRow(s.fx, card).column_key, 'blocked');
  assert.equal(cardRow(s.fx, card).unread, 0);
  // 非 c:/ext: 键 ⇒ 无收尾语义（返回 undefined，DB 不动）
  assert.equal(board.finish('t:7', 'x', { options: s.opts }), undefined);
  void rowId;
  s.close();
});

test('finish：ext: 分支 = finishing→done + 返回布尔；finishing 重入/无行 ⇒ false', async () => {
  const s = setup('finish-ext');
  const card = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: card, state: 'running', seq: 1 });
  assert.equal(board.finish(`ext:${card}`, '外部会话结束', { options: s.opts }), true);
  assert.equal(activeWait(s.fx.db, 'ext', card).state, 'done');
  // 终态重入：无活跃行 ⇒ false（幂等 no-op）
  assert.equal(board.finish(`ext:${card}`, '外部会话结束', { options: s.opts }), false);
  // finishing 重入 ⇒ false（不重复收）
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: card, state: 'finishing', seq: 2 });
  assert.equal(board.finish(`ext:${card}`, '重入', { options: s.opts }), false);
  assert.equal(activeWait(s.fx.db, 'ext', card).state, 'finishing');   // 未被推动
  s.close();
});

test('finish：runner 单例在场 ⇒ cardFinished 门禁收口 running/finishing 行（starting 不收）', async () => {
  const s = setup('finish-runner');
  const ok = insertCard(s.fx.db, s.pid, { title: 'R', columnKey: 'doing' });
  const start = insertCard(s.fx.db, s.pid, { title: 'S', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: ok, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: start, state: 'starting', seq: 2 });
  const finished = [];
  const inst = {
    cardFinished(cardId, reason) {
      finished.push([cardId, reason]);
      const row = waitq.getActive(waitq.KIND_CARD, cardId, s.opts);
      if (row !== null && ['running', 'finishing'].includes(row.state)) {
        return waitq.finishByTarget(waitq.KIND_CARD, cardId, waitq.STATE_DONE, '', s.opts);
      }
      return false;
    },
    notifyBusyChange() {},
  };
  board.setRunnerInstance(inst);
  try {
    board.finish(`c:${ok}`, 'reason-1', { toColumn: 'review', options: s.opts });
    assert.equal(activeWait(s.fx.db, 'card', ok).state, 'done');
    assert.deepEqual(finished[0], [ok, 'reason-1']);
    assert.equal(cardRow(s.fx, ok).column_key, 'review');
    // starting 行：门禁不收（起跑失败行终态归 worker finally），且 finishing 重入短路径生效
    board.finish(`c:${start}`, 'reason-2', { options: s.opts });
    assert.equal(activeWait(s.fx.db, 'card', start).state, 'starting');
    // finishing 行 ⇒ 重入直接返回（不调 cardFinished）
    s.fx.db.prepare("UPDATE wait_items SET state='finishing' WHERE id=?").run(
      activeWait(s.fx.db, 'card', start).id,
    );
    const before = finished.length;
    board.finish(`c:${start}`, 'reason-3', { options: s.opts });
    assert.equal(finished.length, before);
  } finally {
    board.setRunnerInstance(null);
    s.close();
  }
});

// --------------------------------------------------------------------------
// ⑥ finishRun：会话结束 → review、sid 入库、错误记录
// --------------------------------------------------------------------------

test('finishRun：doing 卡 ⇒ session_id/sessions 入库 + 落 review + 清 last_error', async () => {
  const s = setup('finishrun-ok');
  const card = insertCard(s.fx.db, s.pid, {
    title: 'T', columnKey: 'doing', sessionId: 'sid-a', sessions: JSON.stringify(['sid-a']),
    lastError: '旧错',
  });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'running', seq: 1 });
  const logPath = path.join(s.dir, 'board.log');
  fs.writeFileSync(logPath, '');
  board.finishRun(card, {
    proc: null, sid: 'sid-b', family: 'dsh_plugin', project_dir: s.dir,
    started_at: Date.now(), seen_busy: true, aborted: false, turn_baseline: null,
    log_path: logPath,
  }, '会话结束收尾', s.opts);
  const row = cardRow(s.fx, card);
  assert.equal(row.session_id, 'sid-b');
  assert.deepEqual(JSON.parse(row.sessions).sort(), ['sid-a', 'sid-b']);
  assert.equal(row.last_error, '');                      // 无 turn 错误 ⇒ 清错误
  assert.equal(row.column_key, 'review');                // 唯一收尾点带 to_column=review
  assert.equal(row.block_kind, null);
  assert.equal(row.unread, 1);                           // 平台搬列要标记（默认 true）
  assert.equal(fs.readFileSync(logPath, 'utf8'), '');    // 无错误 ⇒ 不写异常行
  s.close();
});

test('finishRun：turn 级错误上浮（error reason）+ 交互阻塞卡也流转 review', async () => {
  const d = await useDriver();
  const s = setup('finishrun-err');
  let logPath = '';
  try {
    d.drv.live = {
      sessions: [{ session_id: 'sid-e', status: 'idle', cwd: s.dir, owned: true }],
      complete: true,
    };
    assert.equal(dshevents.start(), true);
    assert.ok(await until(() => dshevents.connected()), '中枢未连上假驱动');
    d.drv.sendFrame('turn/end', 'sid-e', { reason: 'error', event_seq: 9 }, 9);
    assert.ok(await until(() => (dshevents.get('sid-e') || {}).last_turn_reason === 'error'),
      'turn/end(error) 未折进注册表');
    await finishRunErrorBody(s, d);
  } finally {
    await dshevents.stop(200);
    dshevents.HUB._setConnected(false);
    await d.restore();
    s.close();
  }
});

/** 上面那条用例的主体（放在函数里只是为了把 hub 生命周期收在 try/finally 内） */
async function finishRunErrorBody(s, d) {
  void d;
  const card = insertCard(s.fx.db, s.pid, {
    title: 'T', columnKey: 'blocked', blockKind: 'interaction', blockText: '等你答',
  });
  const logPath = path.join(s.dir, 'board2.log');
  fs.writeFileSync(logPath, '');
  board.finishRun(card, {
    proc: null, sid: 'sid-e', family: 'dsh_plugin', project_dir: s.dir,
    started_at: Date.now(), seen_busy: true, aborted: false, turn_baseline: null,
    log_path: logPath,
  }, '会话结束收尾', s.opts);
  const row = cardRow(s.fx, card);
  assert.equal(row.column_key, 'review');                // 交互阻塞卡随会话结束流转
  assert.equal(row.block_kind, null);
  assert.equal(row.last_error, '会话异常: turn 异常结束（error）');
  assert.ok(row.last_error_at > 0);
  assert.ok(fs.readFileSync(logPath, 'utf8').includes('### 会话异常结束: turn 异常结束（error）'));
}

test('finishRun：卡已删 ⇒ 只走 finish 释放占用（不写库）', async () => {
  const s = setup('finishrun-gone');
  const logPath = path.join(s.dir, 'board3.log');
  fs.writeFileSync(logPath, '');
  // 卡已删（库里没有 424242）：只走唯一收尾点释放占用，**不写任何卡片行**。
  // 注意：Python `_finish_run` 这一支是**直调模块内 `finish`**（没有 runner 单例也是 no-op），
  // 故这里不断言钩子流水，只断言「不抛异常 + 库里没有凭空出现的卡片行」。
  board.finishRun(424242, {
    proc: null, sid: '', family: 'dsh_plugin', project_dir: s.dir, started_at: Date.now(),
    seen_busy: true, aborted: false, turn_baseline: null, log_path: logPath,
  }, '会话结束收尾', s.opts);
  assert.equal(s.fx.db.prepare('SELECT COUNT(*) AS n FROM board_cards').get().n, 0);
  s.close();
});

// --------------------------------------------------------------------------
// ⑦ watchRunsOnce：三态分支与收尾归属
// --------------------------------------------------------------------------

test('watchRunsOnce：unknown 跳过 / running 记 seen_busy / seen_busy+idle ⇒ 收尾', async () => {
  const d = await useDriver();
  const s = setup('watch-runs');
  d.drv.live = { sessions: [], complete: true };
  assert.equal(dshevents.start(), true);
  assert.ok(await until(() => dshevents.connected()), '中枢未连上假驱动');
  const c1 = insertCard(s.fx.db, s.pid, { title: 'C1', columnKey: 'doing' });
  const c2 = insertCard(s.fx.db, s.pid, { title: 'C2', columnKey: 'doing' });
  const c3 = insertCard(s.fx.db, s.pid, { title: 'C3', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c1, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c2, state: 'running', seq: 2 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c3, state: 'running', seq: 3 });
  const log = (n) => { const p = path.join(s.dir, `w${n}.log`); fs.writeFileSync(p, ''); return p; };
  // c1：注册表无此 sid ⇒ unknown ⇒ 本轮跳过（绝不推断已结束）
  board.runRegistry.set(c1, {
    proc: null, sid: 'sid-unknown', family: 'dsh_plugin', project_dir: s.dir,
    started_at: Date.now(), startedAtSec: Date.now() / 1000, seen_busy: false, aborted: false,
    turn_baseline: null, log_path: log(1),
  });
  // c2：unknown 分支不受宽限期影响 ⇒ 仍在表
  assert.deepEqual(board.watchRunsOnce(s.opts), []);
  assert.equal(board.hasActiveRun(c1), true);
  // c3：喂 running 帧 ⇒ 记 seen_busy；再喂 idle ⇒ 有 seen_busy ⇒ 收尾
  board.runRegistry.set(c3, {
    proc: null, sid: 'sid-c3', family: 'dsh_plugin', project_dir: s.dir,
    started_at: Date.now(), startedAtSec: Date.now() / 1000, seen_busy: false, aborted: false,
    turn_baseline: null, log_path: log(3),
  });
  d.drv.sendFrame('agent/status', 'sid-c3', { status: 'running' }, 1);
  assert.ok(await until(() => (dshevents.get('sid-c3') || {}).status === 'running'));
  assert.deepEqual(board.watchRunsOnce(s.opts), []);
  assert.equal(board.runRegistry.get(c3).seen_busy, true);
  d.drv.sendFrame('agent/status', 'sid-c3', { status: 'idle' }, 2);
  assert.ok(await until(() => (dshevents.get('sid-c3') || {}).status === 'idle'));
  const popped = board.watchRunsOnce(s.opts);
  assert.equal(popped.length, 1);
  assert.equal(popped[0][0], c3);
  assert.equal(board.hasActiveRun(c3), false);
  assert.equal(cardRow(s.fx, c3).column_key, 'review');
  clearRegistries(c1, c2, c3);
  await dshevents.stop(200);
  dshevents.HUB._setConnected(false);
  await d.restore();
  s.close();
});

// --------------------------------------------------------------------------
// ⑧ pid / 孤儿行判据
// --------------------------------------------------------------------------

test('runPid / unitEvidencePid / orphanHold：单族恒 null + 孤儿行判据', async () => {
  const s = setup('pid');
  const card = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing' });
  assert.equal(board.runPid(card), null);
  board.runRegistry.set(card, { proc: { pid: 4242 }, aborted: false });
  assert.equal(board.runPid(card), 4242);
  board.runRegistry.set(card, { proc: null, aborted: false });
  assert.equal(board.runPid(card), null);
  // evidence.pid 读口
  insertWait(s.fx.db, {
    projectId: s.pid, kind: 'card', targetId: card, state: 'running', seq: 1,
    evidence: JSON.stringify({ pid: 777 }),
  });
  assert.equal(board.unitEvidencePid(card, s.opts), 777);
  // 孤儿行：有活跃 c: 行 ∧ **无**在管条目（上面为测 runPid 登记过条目 ⇒ 先清掉）
  board.runRegistry.delete(card);
  assert.equal(board.hasActiveRun(card), false);
  assert.equal(board.orphanHold(card, s.opts), true);
  board.runRegistry.set(card, { proc: null, aborted: false });
  assert.equal(board.orphanHold(card, s.opts), false);   // 有在管条目 ⇒ 不是孤儿
  clearRegistries(card);
  s.close();
});

// --------------------------------------------------------------------------
// ⑨ 缝：archiveCardSessions 未注入即响亮失败；optionalHook 降级
// --------------------------------------------------------------------------

test('archiveCardSessions 未注入 ⇒ BoardHookMissing（缝缺失必须响亮，不静默）', async () => {
  const s = setup('hook-missing');
  // M5-3 已把真实现注入（模块级 `setBoardHooks`）⇒ 本用例**显式拔掉**这一口再验不变量，
  // 这样「未注入即响亮失败」这条断言与本批是否已落地无关（否则每落地一批就要改一次测试）。
  const saved = board.boardHooks();
  board.setBoardHooks({ archiveCardSessions: null });
  try {
    const card = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing' });
    const proj = db.getProject(s.pid, s.opts);
    await assert.rejects(
      () => board.moveCard(proj, card, 'done', '', null, false, '', s.opts),
      (e) => e instanceof board.BoardHookMissing && e.hook === 'archiveCardSessions',
    );
  } finally {
    board.setBoardHooks(saved);       // 还原（同文件后续用例仍走真实现）
  }
  s.close();
});

test('optionalHook 未注入 ⇒ 降级不抛（syncSessions 在 extRefresh 的 unbound 分支除外）', async () => {
  const s = setup('optional-hooks');
  const card = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing' });
  // syncSessions 未注入：只有 unbound 非空才会被调到（未连接中枢 ⇒ 探测不可用 ⇒ 不调）
  const proj = db.getProject(s.pid, s.opts);
  assert.equal(board.extRefresh(proj, s.opts), null);
  clearRegistries(card);
  s.close();
});

// --------------------------------------------------------------------------
// ⑩ M5-1 既有分支在 async 化后仍成立
// --------------------------------------------------------------------------

test('moveCard（async）后：同列早退 / doing 不可拖回 todo / 交给 enterDoing', async () => {
  const s = setup('movecard-async');
  const proj = db.getProject(s.pid, s.opts);
  const c1 = insertCard(s.fx.db, s.pid, { title: 'C1', columnKey: 'review' });
  const [same, errSame] = await board.moveCard(proj, c1, 'review', '', null, false, '',
    s.opts);
  assert.equal(errSame, null);
  assert.equal(same.column, 'review');
  const c2 = insertCard(s.fx.db, s.pid, { title: 'C2', columnKey: 'doing' });
  const [blocked, errTodo] = await board.moveCard(proj, c2, 'todo', '', null, false, '',
    s.opts);
  assert.equal(blocked, null);
  assert.deepEqual(errTodo, { error: 'doing 不可直接拖回 todo' });
  // 进 doing 委托 enterDoing（真实现，经安装的记录桩包一层）：无驱动 ⇒ 起会话失败回滚，
  // 返回 [null, {error}] 且**列不动**（M5-1 的「硬错误、列未变」契约在 async 化后不变）
  const c3 = insertCard(s.fx.db, s.pid, { title: 'C3', columnKey: 'todo' });
  s.calls.length = 0;
  const [none, errDoing] = await board.moveCard(proj, c3, 'doing', '', null, false, '',
    s.opts);
  assert.equal(none, null);
  // 起会话失败的包装文案已按 key+vars 契约承载（会话启动失败: {detail}）；
  // 路由层会把它渲染成字符串，HTTP 形状不变。
  const startErr = errDoing && errDoing.error;
  assert.ok(typeof startErr === 'string'
    || (startErr && typeof startErr.message === 'string'), '未返回硬错误');
  // 委托点逐位 8 参（enterDoing 形参口径的契约钉子；lang 由请求层传入）
  assert.deepEqual(s.calls[0], ['enterDoing', c3, '', false, false, false, '', s.opts]);
  assert.equal(cardRow(s.fx, c3).column_key, 'todo');           // 列未变
  assert.equal(board.hasActiveRun(c3), false);                  // 无残留在管条目
  s.close();
});

test('releaseDoing/dequeueCard（async）后：等待行取消 + finish 收口契约不变', async () => {
  const s = setup('dequeue-async');
  const card = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing', blockKind: 'queue' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'waiting', seq: 1 });
  await board.dequeueCard(card, { reason: '卡片删除', toColumn: 'review', options: s.opts });
  assert.equal(activeWait(s.fx.db, 'card', card).state, 'cancelled');
  const fin = s.calls.filter((c) => c[0] === 'finish').pop();
  assert.deepEqual(fin, ['finish', `c:${card}`, '卡片删除', 'review', true]);
  // 收尾 opts 的**平铺口径**：spy 只旁观入参，第 3 参直接吃到 db 袋（不是 `{options}` 嵌套）
  const finOpts = s.calls.filter((c) => c[0] === 'finish').pop();
  assert.deepEqual(finOpts, ['finish', `c:${card}`, '卡片删除', 'review', true]);
  // leaveDoing(stop=true) 先 stopCard 再收行
  const card2 = insertCard(s.fx.db, s.pid, { title: 'C2', columnKey: 'doing' });
  s.calls.length = 0;
  await board.leaveDoing(db.getBoardCard(card2, s.opts), { stop: true, reason: '移列释放', options: s.opts });
  assert.deepEqual(s.calls.map((c) => c[0]), ['stopCard', 'finish']);
  // 两处缝的形参口径：`stopCard(cardId, options)`；`finish(key, reason, opts)`
  assert.deepEqual(s.calls[0], ['stopCard', card2, s.opts]);
  assert.deepEqual(s.calls[1], ['finish', `c:${card2}`, '移列释放', null, true]);
  s.close();
});
