/**
 * 卡片 compact 的「会话存活前置」单测（2026-10-17 修卡 907：「TS 侧 /compact 对已结束会话必失败」）。
 *
 * 报障现场：卡 907（项目 126、`review`、`origin=NULL` 平台自建卡）的会话是 9 天前跑完的
 * （会话文件最后写入 2026-10-08），宿主里没有活 agent ⇒ 会话窗 `/compact` 与卡详情「compact」
 * 按钮一律 toast `compact 失败: 会话已结束（宿主无活动 agent）: session-4e00af1c-…`。
 * 两跳（补看管声明）救不回来：驱动只在「池内」或「看管 + 宿主有活 agent」两档放行。
 *
 * 修法（与 Python `board.compact_session` 同批同形）：压缩前先按投递腿 `deliverNow` 同款
 * 「会话存活前置」——中枢可信 ∧ 注册表无此 sid ⇒ `ensureCardSession` 按 resume 语义接回
 * 宿主，再走既有两跳。dsh GUI 自己的 `/compact` 也是按需 resume
 * （`dsh-api-session-controller.resolve` → `agents.resume`）。
 *
 * 期望值来源是 `board.py:2296-2350` 原文与本批设计（**不是**读 Node 实现反推）。
 * 三条口径：
 *   ① 驱动面走**假驱动**（HTTP 服务 + `TS_AGENT_DRIVER_URL` 注入，照 `board-session.test.mjs`
 *      的既有做法）：不起真 dsh，但走真 `dshdriver` 代码路径；
 *   ② 中枢状态直接写 `dshevents.HUB`（真 `EventHub` 实例；`aligned()` 是唯一判据）；
 *   ③ 夹具一律 `freshDb` 临时库（进程级 `TOUCHSTONE_DB` 兜底），**绝不碰生产库**。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as dshevents from '../lib/dshevents.js';
import { freshDb, insertCard, insertProject } from './m3fixture.mjs';

const AGENT_BASE = '/touchstone-agent';

// --------------------------------------------------------------------------
// 假驱动（形状照 `dsh-plugin/lib/agent-driver.js`：前缀 + 令牌头；只实现本文件用到的口）
// --------------------------------------------------------------------------

class FakeDriver {
  constructor() {
    this.calls = [];
    this.sessionFail = null;      // {code, error} 覆盖 /session 回执
    this.compactFail = null;      // {code, error} 覆盖 /compact 回执
    this.sessionId = 'sid-fake';
    this.server = null;
    this.url = '';
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
    if (this.server === null) return;
    const srv = this.server;
    this.server = null;
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }

  byPath(p) { return this.calls.filter((c) => c.path === p); }

  _json(res, code, body) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': raw.length });
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
    if (req.method === 'POST' && route === '/session') {
      if (this.sessionFail) {
        return this._json(res, this.sessionFail.code, { error: this.sessionFail.error });
      }
      return this._json(res, 200, {
        session_id: (body || {}).session_id || this.sessionId, resumed: true,
      });
    }
    if (req.method === 'POST' && route === '/compact') {
      if (this.compactFail) {
        return this._json(res, this.compactFail.code, { error: this.compactFail.error });
      }
      return this._json(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && route === '/watch') {
      return this._json(res, 200, { ok: true, session_id: (body || {}).session_id, watched: true });
    }
    return this._json(res, 404, { error: `未知驱动端点 ${route}（假驱动）` });
  }
}

/** 起假驱动并注入驱动连接 env（测试末尾 `restore()`；env 是进程级，逐例复原） */
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

/**
 * 写中枢状态（真 `EventHub`）：`aligned()` = connected ∧ _aligned 是「缺席即已失去」的唯一判据。
 * 返回复原函数（用例末尾必调；`node --test` 每文件一进程，但同文件内会互相串）。
 */
function setHub({ sessions = {}, aligned = true } = {}) {
  const hub = dshevents.HUB;
  const old = { connected: hub._connected, aligned: hub._aligned };
  const oldRows = new Map(hub._sessions);
  hub._connected = true;
  hub._aligned = aligned;
  hub._sessions.clear();
  for (const [sid, row] of Object.entries(sessions)) {
    hub._sessions.set(sid, {
      session_id: sid, status: '', cwd: '', task: '', owned: false, origin: '',
      interaction: null, last_turn_reason: null, last_seq: 0, usage: null,
      permission: null, inbox: [], updated_at: 0, ...row,
    });
  }
  return () => {
    hub._connected = old.connected;
    hub._aligned = old.aligned;
    hub._sessions.clear();
    for (const [sid, row] of oldRows) hub._sessions.set(sid, row);
  };
}

/** 一次测试的夹具：临时库 + 一个项目 + 一张卡（带 sid；`origin` 区分平台卡 / sync 卡） */
function setup(tag, { sid, origin = '', columnKey = 'review' } = {}) {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir,
  });
  const cid = insertCard(fx.db, pid, {
    title: 'compact 用例', columnKey, sessionId: sid, sessions: JSON.stringify([sid]), origin,
  });
  const project = fx.db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
  const card = fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cid);
  return { fx, pid, cid, project, card, opts: { db: fx.db } };
}

// --------------------------------------------------------------------------
// ① 冷会话：先接回、再压缩（本批修的正是这一档）
// --------------------------------------------------------------------------

test('compact①：宿主已失去会话 ⇒ 先 /session 接回再 /compact（顺序 + 参数）', async () => {
  const { drv, restore } = await useDriver();
  const unsetHub = setHub({ sessions: {} });          // 可信快照 ∧ 注册表无此 sid = 确已失去
  const s = setup('compact-cold', { sid: 'session-cold-907' });
  try {
    await board.compactSession(s.project, s.card, 'session-cold-907', 'zh', s.opts);
    assert.deepEqual(drv.calls.map((c) => c.path), ['/session', '/compact']);
    assert.deepEqual(drv.byPath('/session')[0].body, {
      session_id: 'session-cold-907', task: `card-${s.cid}`, cwd: s.fx.dir,
    });
    assert.deepEqual(drv.byPath('/compact')[0].body, { session_id: 'session-cold-907' });
  } finally {
    unsetHub();
    await restore();
    s.fx.close();
  }
});

test('compact②：会话在场 ⇒ 零 /session 请求（既有路径一字未动）', async () => {
  const { drv, restore } = await useDriver();
  const sid = 'session-warm';
  const unsetHub = setHub({ sessions: { [sid]: { owned: true, status: 'idle' } } });
  const s = setup('compact-warm', { sid });
  try {
    await board.compactSession(s.project, s.card, sid, 'zh', s.opts);
    assert.deepEqual(drv.calls.map((c) => c.path), ['/compact']);
    assert.equal(drv.byPath('/session').length, 0);
  } finally {
    unsetHub();
    await restore();
    s.fx.close();
  }
});

// --------------------------------------------------------------------------
// ② 不接回的两档：未知（未对齐）与 sync 卡
// --------------------------------------------------------------------------

test('compact③：中枢未对齐 ⇒ 未知 ≠ 已失去：不接回，压缩照旧按驱动 404 收口', async () => {
  const { drv, restore } = await useDriver();
  drv.compactFail = { code: 404, error: '会话已结束（宿主无活动 agent）: session-unaligned' };
  const unsetHub = setHub({ sessions: {}, aligned: false });
  const s = setup('compact-unaligned', { sid: 'session-unaligned' });
  try {
    await assert.rejects(
      () => board.compactSession(s.project, s.card, 'session-unaligned', 'zh', s.opts),
      (e) => e.message.includes('compact 失败') && e.message.includes('会话已结束'),
    );
    assert.equal(drv.byPath('/session').length, 0, '未知态绝不乱 resume');
    assert.ok(drv.byPath('/compact').length >= 1, '压缩本身照旧发出');
  } finally {
    unsetHub();
    await restore();
    s.fx.close();
  }
});

test('compact④：sync 卡冷会话 ⇒ 不收养（零 /session），仍抛中文文案', async () => {
  const { drv, restore } = await useDriver();
  drv.compactFail = { code: 404, error: '会话已结束（宿主无活动 agent）: session-sync-cold' };
  const unsetHub = setHub({ sessions: {} });
  const s = setup('compact-sync', { sid: 'session-sync-cold', origin: 'sync' });
  try {
    await assert.rejects(
      () => board.compactSession(s.project, s.card, 'session-sync-cold', 'zh', s.opts),
      (e) => e.message.includes('compact 失败'),
    );
    assert.equal(drv.byPath('/session').length, 0, 'C 批：平台不接管外部会话');
  } finally {
    unsetHub();
    await restore();
    s.fx.close();
  }
});

test('compact⑤：接不回 ⇒ 只试一次 /session，不吞错（驱动文案兜底）', async () => {
  const { drv, restore } = await useDriver();
  drv.sessionFail = { code: 500, error: '会话恢复失败: 会话不存在' };
  drv.compactFail = { code: 404, error: '会话已结束（宿主无活动 agent）: session-dead' };
  const unsetHub = setHub({ sessions: {} });
  const s = setup('compact-dead', { sid: 'session-dead' });
  const savedLog = console.log;
  console.log = () => { /* 接回失败诊断行：本用例只关心请求形状 */ };
  try {
    await assert.rejects(
      () => board.compactSession(s.project, s.card, 'session-dead', 'zh', s.opts),
      (e) => e.message.includes('compact 失败'),
    );
    assert.equal(drv.byPath('/session').length, 1, '只接一次，不重试刷请求');
  } finally {
    console.log = savedLog;
    unsetHub();
    await restore();
    s.fx.close();
  }
});

// --------------------------------------------------------------------------
// ③ 回滚阀与投递腿同一个：`TS_HOST_SESSION_REVIVE=0` ⇒ 压缩腿也不接回
// --------------------------------------------------------------------------

test('compact⑥：回滚阀 TS_HOST_SESSION_REVIVE=0 ⇒ 不接回，退回修复前行为', async () => {
  const { drv, restore } = await useDriver();
  drv.compactFail = { code: 404, error: '会话已结束（宿主无活动 agent）: session-valve' };
  const unsetHub = setHub({ sessions: {} });
  const s = setup('compact-valve', { sid: 'session-valve' });
  process.env.TS_HOST_SESSION_REVIVE = '0';
  try {
    await assert.rejects(
      () => board.compactSession(s.project, s.card, 'session-valve', 'zh', s.opts),
      (e) => e.message.includes('compact 失败'),
    );
    assert.equal(drv.byPath('/session').length, 0, '阀关：一个 resume 请求都不发');
    assert.ok(drv.byPath('/compact').length >= 1, '压缩本身照旧发出（退回修复前）');
  } finally {
    delete process.env.TS_HOST_SESSION_REVIVE;
    unsetHub();
    await restore();
    s.fx.close();
  }
});
