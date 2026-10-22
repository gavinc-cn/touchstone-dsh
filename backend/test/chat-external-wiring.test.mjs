/**
 * 回归 #1003（2026-10-22）：外部会话从 TS 侧「续跑」的**生产接线**单测。
 *
 * 缺陷形态：`board.js` 末尾的 `chatMod.setBoardBridge(...)` 只接了 `deliverUnit`/`deliverNow`，
 * **漏了 `ensureWatch`** ⇒ `chat.externalPreflight` 第⑤步永远没有「看管声明」口，所有
 * `owned:false` 的会话（用户在 dsh GUI 里直跑的会话 / `origin='sync'` 的卡片）从 TS 会话窗
 * 发送恒被拒，文案却是「看管声明失败：插件过旧或不可达」——**实际一次 `/watch` 都没发**，
 * 与插件新旧无关。现场：卡 1003（project 126，sync 卡）连发 6 条「继续」全部 400。
 *
 * 为什么必须测**生产接线**而不是只测 chat 侧的桩桥：
 *   ① 桩桥（`setBoardBridge({ensureWatch: () => true})`）测不出「board.js 忘了接线」——那正是
 *      本缺陷；只有 import 真 board.js、让它的模块副作用注册桥，再观察**假驱动是否真收到
 *      `/watch`**，才能钉住这条线。
 *   ② `board.ensureWatch` 是 **async**，而 `externalPreflight` 原先是同步 `!ensureWatch(sid)`：
 *      Promise 恒为真值 ⇒ 即便接上线，`watched=false` 也会被误放行。故本文件同时钉住
 *      「await 声明结果」（watched=false / 404 两档必须拒投）。
 *
 * 三条测试口径（与 `chat-lifecycle.test.mjs` / `board-session.test.mjs` 同源）：
 *   ① 驱动面走假驱动（真 HTTP + `TS_AGENT_DRIVER_URL` 注入，走真 `dshdriver` 代码路径）；
 *   ② `dshevents.HUB` 直接摆成「在线 + 已对齐 + 注册表有该会话」（不建真 SSE）；
 *   ③ **绝不投递消息**：本文件只调 `chat.externalPreflight`（前置闸），不调 `submit`，
 *      所以假驱动只会看到 `/watch`——不会把它当成一次成功投递。
 *
 * 本文件**不改任何库文件**：临时库不需要（preflight 零 DB 读写），脏的只有 env 与 HUB，
 * 用例结束全部还原。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

// 生产接线的本体：import board.js 的模块副作用 = `chatMod.setBoardBridge({ensureWatch, ...})`。
// 只测 chat 侧替身桥测不出本缺陷（见文件头「为什么必须测生产接线」）。
import '../lib/board.js';
import * as chat from '../lib/chat.js';
import * as dshevents from '../lib/dshevents.js';

const AGENT_BASE = '/touchstone-agent';

/** 与 `chat.js` 逐字一致的三条分类文案（改了任一字符这里就红） */
const MSG_WATCH_FAILED = '该会话是 dsh 直跑会话，平台未获投递许可'
  + '（看管声明失败：插件过旧或不可达），请到 dsh 会话窗口发送';
const MSG_DELIVER_OFF = '该会话是 dsh 直跑会话，平台已关闭外部会话投递'
  + '（TS_EXTERNAL_DELIVER=0），请到 dsh 会话窗口发送';

// --------------------------------------------------------------------------
// 假驱动（只实现本文件用得到的 `/watch`；其余端点一律 404「未知驱动端点」，形状照
// `dsh-plugin/lib/agent-driver.js`：`/touchstone-agent` 前缀 + `x-ts-driver-token` 头）
// --------------------------------------------------------------------------

class WatchDriver {
  constructor() {
    /** 全部请求（`{method, path, body}`；path 不含 agent 前缀） */
    this.calls = [];
    /** `/watch` 回执的 `watched`（用例按需改） */
    this.watched = true;
    /** `/watch` 模拟旧插件：返回 404 未知端点（`dshdriver.WATCH_UNSUPPORTED` 档） */
    this.unsupported = false;
    /** `/watch` 回执延迟（毫秒）：用来证明 preflight **等到声明完成**才放行 */
    this.delayMs = 0;
    /** `/watch` 的 handler 是否已跑完（区分「请求发出」与「结果已采纳」） */
    this.answered = false;
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

  byPath(p) {
    return this.calls.filter((c) => c.path === p);
  }

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
    this.calls.push({ method: req.method, path: route, body });
    if (req.method === 'POST' && route === '/watch') {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (this.unsupported) return this._json(res, 404, { error: `未知驱动端点 ${route}（假驱动）` });
      this.answered = true;
      return this._json(res, 200, {
        ok: true, session_id: (body || {}).session_id || '', watched: this.watched,
      });
    }
    return this._json(res, 404, { error: `未知驱动端点 ${route}（假驱动）` });
  }
}

// --------------------------------------------------------------------------
// 夹具：HUB 快照 / env 还原 / 假驱动注入（用例结束一律还原，互不串味）
// --------------------------------------------------------------------------

function saveHub() {
  return {
    sessions: new Map(dshevents.HUB._sessions),
    connected: dshevents.HUB._connected,
    aligned: dshevents.HUB._aligned,
    lastSeq: dshevents.HUB._lastSeq,
  };
}

function restoreHub(saved) {
  dshevents.HUB._sessions = saved.sessions;
  dshevents.HUB._connected = saved.connected;
  dshevents.HUB._aligned = saved.aligned;
  dshevents.HUB._lastSeq = saved.lastSeq;
}

/** 把 hub 摆成「链路在线 ∧ 快照可信 ∧ 注册表里有这些会话」 */
function setHub(sessions = []) {
  dshevents.HUB._connected = true;
  dshevents.HUB._aligned = true;
  dshevents.HUB._sessions = new Map(sessions.map((s) => [s.session_id, { ...s }]));
}

const ENV_KEYS = ['TS_AGENT_DRIVER_URL', 'TS_AGENT_DRIVER_TOKEN', 'TS_EXTERNAL_DELIVER'];

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

/** 起假驱动、注入 env、跑用例、还原（HUB 由调用方用 setHub/withHub 管） */
async function withDriver(fn) {
  const drv = await new WatchDriver().start();
  const saved = saveEnv();
  process.env.TS_AGENT_DRIVER_URL = drv.url;
  process.env.TS_AGENT_DRIVER_TOKEN = 'tok-test';
  try {
    return await fn(drv);
  } finally {
    await drv.close();
    restoreEnv(saved);
  }
}

/** HUB 快照 + 假驱动注入的组合夹具 */
async function withFixture(fn) {
  const hubSaved = saveHub();
  try {
    return await withDriver(fn);
  } finally {
    restoreHub(hubSaved);
  }
}

// --------------------------------------------------------------------------
// 用例
// --------------------------------------------------------------------------

test('生产接线①：外部会话经 board.js 的真桥声明看管成功才放行，且**等到声明完成**', async () => {
  await withFixture(async (drv) => {
    // 故意让 /watch 慢一点：同步判定（`!ensureWatch(sid)` 把 Promise 当真值）会「立刻放行」，
    // 而 `answered` 仍是 false —— 这正是必须 await 的原因。
    drv.delayMs = 60;
    setHub([{ session_id: 's-ext-w1', owned: false, status: 'idle', last_seq: 1 }]);

    await chat.externalPreflight('s-ext-w1');

    const calls = drv.byPath('/watch');
    assert.equal(calls.length, 1,
      '外部会话投递前必须向驱动声明看管（board.js 漏接线时这里恒为 0 —— #1003 的缺陷形态）');
    assert.deepEqual(calls[0].body, { session_id: 's-ext-w1', on: true });
    assert.equal(drv.answered, true, 'preflight 返回时 /watch 必须已完成（await 声明结果）');
  });
});

test('生产接线②：watched=false ⇒ 按「看管声明失败」文案拒投（Promise 真值不得当成功）', async () => {
  await withFixture(async (drv) => {
    drv.watched = false;
    setHub([{ session_id: 's-ext-w2', owned: false, status: 'running', last_seq: 1 }]);

    await assert.rejects(async () => chat.externalPreflight('s-ext-w2'), (err) => {
      assert.ok(err instanceof chat.DeliveryRefused,
        '必须是 DeliveryRefused（端点按 instanceof 归到 400 档）');
      assert.equal(err.message, MSG_WATCH_FAILED);
      return true;
    });
    assert.equal(drv.byPath('/watch').length, 1, '拒投前必须真发过 /watch（不是凭缓存直接拒）');
  });
});

test('生产接线③：驱动无 /watch（旧插件）⇒ 同一文案拒投（响亮失败保留）', async () => {
  await withFixture(async (drv) => {
    drv.unsupported = true;
    setHub([{ session_id: 's-ext-w3', owned: false, status: 'idle', last_seq: 1 }]);

    await assert.rejects(async () => chat.externalPreflight('s-ext-w3'), (err) => {
      assert.equal(err.message, MSG_WATCH_FAILED);
      return true;
    });
    assert.equal(drv.byPath('/watch').length, 1, '旧插件档也必须先尝试声明（404 才归到失败）');
  });
});

test('生产接线④：池内/未知零驱动请求放行；回退阀关闭 ⇒ 外部会话连看管都不声明', async () => {
  await withFixture(async (drv) => {
    setHub([
      { session_id: 's-own-w4', owned: true, status: 'idle', last_seq: 1 },
      { session_id: 's-ext-w4', owned: false, status: 'idle', last_seq: 1 },
    ]);

    // 池内（owned:true）与注册表未知（不在表内 ⇒ get 为 null）一律放行，且不碰驱动
    await chat.externalPreflight('s-own-w4');
    await chat.externalPreflight('s-unknown-w4');
    await chat.externalPreflight('');
    assert.equal(drv.calls.length, 0, '池内/未知/空 sid 不得发 /watch');

    // 回退阀：外部会话一律拒投，且**连看管都不声明**（与 Python 半同序）
    process.env.TS_EXTERNAL_DELIVER = '0';
    await assert.rejects(async () => chat.externalPreflight('s-ext-w4'), (err) => {
      assert.equal(err.message, MSG_DELIVER_OFF);
      return true;
    });
    assert.equal(drv.calls.length, 0, '回退阀在声明看管之前生效（零驱动请求）');
  });
});
