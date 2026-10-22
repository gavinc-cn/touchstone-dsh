/**
 * backend/lib/dshevents.js 的契约测试（`node --test`，零依赖，真起本地**假状态驱动** HTTP 服务）。
 *
 * 为什么打本地假服务（而不是只打桩函数）：本模块的契约一半在「线上」——(重)连时序、
 * `since=last_seq` 续传、一次(重)连只对齐一次、静置期零请求、退避间隔。假服务实现
 * `/events?scope=state`（SSE）/`/live`/`/archived` 三个端点，可脚本化发帧、断流、报错、延迟。
 * **绝不连宿主驱动**：凡会起消费循环的用例都把 `TS_AGENT_DRIVER_URL` 指向本文件临时端口，
 * 未配置用例显式清空该变量（其余用例只用 `_onFrame` 纯本地折叠，不起循环）。
 *
 * 覆盖（对应任务书七类）：
 *   ① 帧折叠表：12 种状态帧逐条（含 turn/end 只在 running 置 idle、interaction asked/else、
 *      session/disposed 删除、driver/archived 整表覆盖、origin 缺字段不覆盖）；
 *   ② 断连=未知：get/snapshot/archived/archivedSet 全未知；重连按 since=last_seq 续传；
 *   ③ 快照可信判定：空快照未声明 complete ⇒ 保留旧表 + aligned=false；complete:true 空表 ⇒
 *      权威空；非空快照 ⇒ 整表覆盖；`/live` 失败 ⇒ 不清表 + 留痕；
 *   ④ 一次(重)连只对齐一次：/live 与 /archived 请求计数，静置期不增长；
 *   ⑤ 退避：连续失败时间隔**稳定在基数**（对齐 Python 实测口径：`finally` 复位吃掉翻倍，
 *      有效退避恒 1s）、退避期间不发请求；
 *   ⑥ 订阅者：变更回调、回调抛异常不影响消费、退订后不再收到；
 *   ⑦ start()：未配置驱动返回 false 且不起消费循环（不连网）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import {
  EventHub,
  HUB,
  RECONNECT_MAX,
  RECONNECT_MIN,
  STREAM_IDLE,
  archived,
  archivedSet,
  connected,
  get,
  sessionEffort,
  sessionPermissionMode,
  snapshot,
  start,
  stats,
  stop,
  subscribe,
  unsubscribe,
  wait,
  waitConnected,
} from '../lib/dshevents.js';
import { configured } from '../lib/dshdriver.js';

/** 驱动连接信息环境变量（与 dshdriver.URL_ENV 同值；测试里显式定向到假驱动） */
const DRIVER_URL_ENV = 'TS_AGENT_DRIVER_URL';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一帧状态帧（形状与插件 `_publishState` 一致） */
const frame = (type, sid, data, seq) => ({
  seq, time: Date.now() / 1000, type, session_id: sid, data,
});

/** 轮询到条件成立；轮询间隔复用中枢自己的 `wait()`（事件驱动，最多 25ms 一轮兜底） */
async function until(hub, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    const remain = deadline - Date.now();
    if (remain <= 0) return predicate();
    await hub.wait(Math.min(remain, 25));
  }
}

/** 临时接管 console.log（断言 `[dshevents] …` 留痕行；用完必须 restore） */
function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

/**
 * 假 dsh 状态驱动：三个端点 + 可编排项。
 *
 *   `live`           `/live` 响应体原文（`{sessions, complete?}`；缺 complete 即「未声明完整」）
 *   `archivedIds`    `/archived` 的 `{archived: [...]}` 内容
 *   `liveMode`       ok | fail500（验对齐失败不清表）
 *   `archivedMode`   ok | fail500（验归档集取不到保持未知）
 *   `eventsMode`     sse | http500（验退避）
 *
 * 记录：`calls`（三个端点请求计数）、`eventsQueries`（每次 `/events` 的 scope/since/到达时刻）、
 * `streams`（当前挂起的 SSE 响应，`send()` 向其写帧、`closeStreams()` 模拟断连）。
 */
class FakeStateDriver {
  constructor() {
    this.server = null;
    this.url = '';
    this.live = { sessions: [], complete: true };
    this.archivedIds = [];
    this.liveMode = 'ok';
    this.liveDelayMs = 0;           // >0：`/live` 延迟响应（复现「对齐飞行中 stop」的窗口）
    this.archivedMode = 'ok';
    this.eventsMode = 'sse';
    this.calls = { live: 0, archived: 0, events: 0 };
    this.eventsQueries = [];
    this.streams = new Set();
    this.tokens = [];
    this._timers = new Set();       // 延迟响应定时器（stop() 时清掉，免得留悬挂句柄）
  }

  async start() {
    this.server = http.createServer((req, res) => {
      try {
        this._handle(req, res);
      } catch {
        try {
          res.destroy();
        } catch { /* 收尾竞态：忽略 */ }
      }
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = req.headers['x-ts-driver-token'];
    if (token) this.tokens.push(token);
    if (url.pathname === '/events') {
      this.calls.events += 1;
      this.eventsQueries.push({
        scope: url.searchParams.get('scope'),
        since: url.searchParams.get('since'),
        at: Date.now(),
      });
      if (this.eventsMode === 'http500') {
        json(res, 500, { error: '状态流不可用' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': ok\n\n');                    // keepalive 注释：只重置空闲计时，不出帧
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      return;
    }
    if (url.pathname === '/live') {
      this.calls.live += 1;
      if (this.liveMode === 'fail500') {
        json(res, 500, { error: '/live 不可用' });
        return;
      }
      if (this.liveDelayMs > 0) {
        const timer = setTimeout(() => {
          this._timers.delete(timer);
          try {
            json(res, 200, this.live);
          } catch { /* 连接已被收掉：忽略 */ }
        }, this.liveDelayMs);
        this._timers.add(timer);
        return;
      }
      json(res, 200, this.live);
      return;
    }
    if (url.pathname === '/archived') {
      this.calls.archived += 1;
      if (this.archivedMode === 'fail500') {
        json(res, 500, { error: '/archived 不可用' });
        return;
      }
      json(res, 200, { archived: this.archivedIds });
      return;
    }
    json(res, 404, { error: '未知端点' });
  }

  /** 向所有挂起的 SSE 连接写一帧 */
  send(stateFrame) {
    const chunk = `data: ${JSON.stringify(stateFrame)}\n\n`;
    for (const res of this.streams) res.write(chunk);
  }

  /** 模拟断连：掐掉所有挂起的 SSE 连接（对端关闭） */
  closeStreams() {
    for (const res of [...this.streams]) {
      this.streams.delete(res);
      res.end();
    }
  }

  async stop() {
    this.closeStreams();
    for (const timer of this._timers) clearTimeout(timer);   // 延迟响应定时器：别留悬挂句柄
    this._timers.clear();
    if (!this.server) return;
    if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** 构造一个 JSON 响应 */
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 起假驱动 + 把驱动地址指向它；`setup(fake)` 在建连前配置首连快照。
 * 用例结束自动还原环境变量并收掉假服务（用例内部的 hub 先自行 `stop()`）。
 */
async function withFakeDriver(setup, fn) {
  const prev = process.env[DRIVER_URL_ENV];
  const fake = await new FakeStateDriver().start();
  process.env[DRIVER_URL_ENV] = fake.url;
  try {
    if (setup) setup(fake);
    await fn(fake);
  } finally {
    if (prev === undefined) delete process.env[DRIVER_URL_ENV];
    else process.env[DRIVER_URL_ENV] = prev;
    await fake.stop();
  }
}

/** 起中枢并等它「已连接 + 状态流已建连」（假驱动为 `sse` 模式时） */
async function startHub(fake, opts = {}) {
  const hub = new EventHub({ reconnectMinMs: 30, ...opts });
  assert.equal(hub.start(), true, 'start() 应起消费循环');
  const up = await until(hub, () => hub.connected(), 3000);
  assert.ok(up, '中枢未在 3s 内连上假驱动');
  const streamed = await until(hub, () => fake.calls.events >= 1, 3000);
  assert.ok(streamed, '中枢未在 3s 内建立状态流连接');
  return hub;
}

// ============================================================================
// ① 帧折叠表（纯本地：直接喂 `_onFrame`，不起循环、不连网）
// ============================================================================

test('帧折叠表：12 种状态帧逐条折进注册表', () => {
  const hub = new EventHub();
  hub._setConnected(true);
  const send = (type, sid, data, seq) => hub._onFrame(frame(type, sid, data, seq));

  // ⑫ session/created：新条目落地（字段集＝Python 初始形状）+ cwd/origin
  send('session/created', 'sub1', { cwd: '/a', owned: false, origin: 'subagent' }, 1);
  const created = hub.get('sub1');
  assert.deepEqual(Object.keys(created).sort(), [
    'cwd', 'inbox', 'interaction', 'last_seq', 'last_turn_reason', 'origin', 'owned',
    'permission', 'session_id', 'status', 'task', 'updated_at', 'usage',
  ]);
  assert.equal(created.status, '');
  assert.equal(created.cwd, '/a');
  assert.equal(created.task, '');
  assert.equal(created.owned, false);
  assert.equal(created.origin, 'subagent');
  assert.equal(created.interaction, null);
  assert.equal(created.last_turn_reason, null);
  assert.equal(created.last_seq, 0);
  assert.equal(created.usage, null);
  assert.equal(created.permission, null);
  assert.deepEqual(created.inbox, []);
  assert.equal(typeof created.updated_at, 'number');
  assert.equal(hub.stats().last_seq, 1, '帧 seq 只进全局序号，不进会话 last_seq');
  assert.equal(hub.archived('x'), null, '未对齐时归档集＝未知');

  // ① agent/status
  send('agent/status', 'sub1', { status: 'running', agent: 'x' }, 2);
  assert.equal(hub.get('sub1').status, 'running');
  // ② turn/start：起轮即忙 + event_seq → 会话 last_seq
  send('turn/start', 'sub1', { event_seq: 7 }, 3);
  assert.equal(hub.get('sub1').status, 'running');
  assert.equal(hub.get('sub1').last_seq, 7);
  // ③ turn/end（running ⇒ 置 idle）+ 原因 + event_seq
  send('turn/end', 'sub1', { reason: 'completed', event_seq: 9 }, 4);
  assert.equal(hub.get('sub1').status, 'idle');
  assert.equal(hub.get('sub1').last_turn_reason, 'completed');
  assert.equal(hub.get('sub1').last_seq, 9);
  // ③b turn/end **仅当** status==='running' 才置 idle
  send('agent/status', 's2', { status: 'blocked' }, 5);
  send('turn/end', 's2', { reason: 'aborted', event_seq: 11 }, 6);
  assert.equal(hub.get('s2').status, 'blocked', '非 running 不得被 turn/end 改状态');
  assert.equal(hub.get('s2').last_turn_reason, 'aborted');
  assert.equal(hub.get('s2').last_seq, 11);
  send('turn/end', 's3', { reason: 'completed' }, 7);
  assert.equal(hub.get('s3').status, '', '空状态不等于 running ⇒ 不得置 idle');
  assert.equal(hub.get('s3').last_turn_reason, 'completed');

  // ④ driver/attached：owned 恒 true；cwd/task/model 仅在非空时覆盖
  send('driver/attached', 's2',
    { owned: false, cwd: '/w', task: 'card-1', model: { provider: 'p', model: 'm' } }, 8);
  assert.equal(hub.get('s2').owned, true, 'attached 帧本身即权威 owned 标记');
  assert.equal(hub.get('s2').cwd, '/w');
  assert.equal(hub.get('s2').task, 'card-1');
  assert.deepEqual(hub.get('s2').model, { provider: 'p', model: 'm' });
  send('driver/attached', 's2', { cwd: '', task: '', model: null }, 9);
  assert.equal(hub.get('s2').cwd, '/w', '空 cwd 不覆盖');
  assert.equal(hub.get('s2').task, 'card-1', '空 task 不覆盖');
  assert.deepEqual(hub.get('s2').model, { provider: 'p', model: 'm' }, '假值 model 不覆盖');

  // ⑤ driver/model：整对象（last-wins）+ sessionEffort 读口
  send('driver/model', 's2', { provider: 'q', model: 'w', reasoningEffort: 'high' }, 10);
  assert.deepEqual(hub.get('s2').model, { provider: 'q', model: 'w', reasoningEffort: 'high' });
  assert.equal(hub.sessionEffort('s2'), 'high');
  // ⑥ driver/permission：{mode, preset}（都转字符串，空帧也整项覆盖）
  send('driver/permission', 's2', { mode: 'yolo', preset: 'danger-full-access' }, 11);
  assert.deepEqual(hub.get('s2').permission, { mode: 'yolo', preset: 'danger-full-access' });
  // 2026-10-21 §5.5：preset 优先（可能已是 path-rules 等宿主档），mode 仅作旧帧兜底
  assert.equal(hub.sessionPermissionMode('s2'), 'danger-full-access');
  send('driver/permission', 's2', {}, 12);
  assert.deepEqual(hub.get('s2').permission, { mode: '', preset: '' });

  // ⑦ driver/inbox：整表覆盖
  send('driver/inbox', 's2', { items: [{ id: 'a' }, { id: 'b' }] }, 13);
  assert.deepEqual(hub.get('s2').inbox, [{ id: 'a' }, { id: 'b' }]);
  send('driver/inbox', 's2', { items: [{ id: 'b' }] }, 14);
  assert.deepEqual(hub.get('s2').inbox, [{ id: 'b' }]);
  // ⑧ driver/detached
  send('driver/detached', 's2', {}, 15);
  assert.equal(hub.get('s2').owned, false);

  // ⑨ driver/interaction：asked ⇒ 存；否则置空
  send('driver/interaction', 's2',
    { state: 'asked', interaction: { kind: 'question', call_id: 'c1' } }, 16);
  assert.deepEqual(hub.get('s2').interaction, { kind: 'question', call_id: 'c1' });
  send('driver/interaction', 's2', { state: 'decided', outcome: 'allowed-once' }, 17);
  assert.equal(hub.get('s2').interaction, null);
  send('driver/interaction', 's2', { state: 'asked' }, 18);
  assert.equal(hub.get('s2').interaction, null, 'asked 但缺 interaction 字段 ⇒ null（不是 undefined）');

  // ⑩ usage：四个 int 字段（缺字段 0、字符串按 int()）
  send('usage', 's2', { input: 7, output: 3, total: 10, cache_read: 0 }, 19);
  assert.deepEqual(hub.get('s2').usage, { input: 7, output: 3, total: 10, cache_read: 0 });
  send('usage', 's2', { input: '5' }, 20);
  assert.deepEqual(hub.get('s2').usage, { input: 5, output: 0, total: 0, cache_read: 0 });

  // ⑫b session/created 的 origin：缺字段/空串保持旧值（绝不推断）
  send('session/created', 'sub1', { cwd: '' }, 21);
  assert.equal(hub.get('sub1').origin, 'subagent');
  assert.equal(hub.get('sub1').cwd, '/a', '空 cwd 保持旧值');
  send('session/created', 'sub1', { origin: '' }, 22);
  assert.equal(hub.get('sub1').origin, 'subagent', '空 origin 不得把已认出的子代理会话变成未知');
  send('session/created', 'main1', {}, 23);
  assert.equal(hub.get('main1').origin, '', '未上报 ⇒ 空串＝未知');
  // ⑬ session/disposed：删除该会话
  send('session/disposed', 'sub1', {}, 24);
  assert.equal(hub.get('sub1'), null);
  assert.equal(hub.snapshot().sub1, undefined);

  // updated_at 每帧刷新；未知帧类型照旧计数/唤醒但不动会话字段
  const before = hub.get('s2').updated_at;
  const changed = hub.stats().changed;
  send('agent/status', 's2', { status: 'idle' }, 25);
  assert.ok(hub.get('s2').updated_at >= before);
  assert.equal(hub.get('s2').status, 'idle');
  send('transcript', 's2', { event_seq: 30 }, 26);
  assert.ok(hub.stats().changed > changed, '未知帧也要唤醒订阅者');
  assert.equal(hub.get('s2').last_seq, 11, 'transcript 帧不改会话字段');

  // ⑭ driver/archived：无 sid 的全局帧，整表覆盖，不进会话注册表
  hub._onFrame({ seq: 27, type: 'driver/archived', session_id: '', data: { archived: ['s2', 's9'] } });
  assert.equal(hub.archived('s2'), true);
  assert.equal(hub.archived('s1'), false, '已知归档集里没有＝明确未归档');
  assert.equal(hub.archived(''), null, '空 sid＝未知');
  assert.deepEqual([...hub.archivedSet()].sort(), ['s2', 's9']);
  assert.equal(hub.get('s9'), null, '归档帧不得建注册表条目');
  hub._onFrame({ seq: 28, type: 'driver/archived', session_id: '', data: { archived: ['s9'] } });
  assert.equal(hub.archived('s2'), false, '整表覆盖');
  assert.equal(hub.archived('s9'), true);
  assert.equal(hub.stats().archived, 1);

  assert.equal(hub.stats().frames, 28);
  assert.equal(hub.stats().last_seq, 28);
  assert.equal(hub.stats().sessions, 3);          // s2 + s3 + main1（sub1 已删）

  // 快照键安全：`__proto__` 这类 sid 不得改原型（内部走 defineProperty）
  send('agent/status', '__proto__', { status: 'running' }, 29);
  assert.ok(Object.keys(hub.snapshot()).includes('__proto__'));
  assert.equal(hub.snapshot()['__proto__'].status, 'running');
});

test('sessionEffort / sessionPermissionMode：取值优先级与「未知」口径', () => {
  const hub = new EventHub();
  hub._setConnected(true);
  const send = (type, sid, data, seq) => hub._onFrame(frame(type, sid, data, seq));
  send('session/created', 's1', {}, 1);
  assert.equal(hub.sessionEffort('s1'), '');
  assert.equal(hub.sessionPermissionMode('s1'), '');
  send('driver/model', 's1', { model: 'm', reasoningEffort: 'medium' }, 2);
  assert.equal(hub.sessionEffort('s1'), 'medium');
  // ① preset 优先：宿主实况档原样回读（含 path-rules / write-guard 这类平台不认识的档）
  send('driver/permission', 's1', { mode: '', preset: 'workspace-write' }, 3);
  assert.equal(hub.sessionPermissionMode('s1'), 'workspace-write');
  send('driver/permission', 's1', { mode: '', preset: 'path-rules' }, 4);
  assert.equal(hub.sessionPermissionMode('s1'), 'path-rules');
  // ② preset 优先于 mode（旧插件才带 mode；新写入路径不再传 mode）
  send('driver/permission', 's1', { mode: 'auto', preset: 'workspace-write' }, 5);
  assert.equal(hub.sessionPermissionMode('s1'), 'workspace-write');
  // ③ 旧帧兜底：preset 为空时才按 mode 做展示映射（新代码基本走不到）
  send('driver/permission', 's1', { mode: 'manual', preset: '' }, 6);
  assert.equal(hub.sessionPermissionMode('s1'), 'workspace-write');
  send('driver/permission', 's1', { mode: 'yolo', preset: '' }, 7);
  assert.equal(hub.sessionPermissionMode('s1'), 'danger-full-access');
  send('driver/permission', 's1', { mode: 'auto', preset: '' }, 8);
  assert.equal(hub.sessionPermissionMode('s1'), 'danger-full-access', '旧 auto 语义已并入完全权限');
  // ④ 未知 mode ⇒ 空串（不猜）；preset 非空一律原样回读（宿主是权威）
  send('driver/permission', 's1', { mode: 'bogus', preset: '' }, 9);
  assert.equal(hub.sessionPermissionMode('s1'), '');
  send('driver/permission', 's1', { mode: '', preset: 'toString' }, 10);
  assert.equal(hub.sessionPermissionMode('s1'), 'toString', 'preset 原样回读，不再按白名单反查');
  send('driver/permission', 's1', { mode: '', preset: '不存在的档' }, 11);
  assert.equal(hub.sessionPermissionMode('s1'), '不存在的档');
  // ⑤ 断连=未知：读口一律空串
  hub._setConnected(false);
  assert.equal(hub.sessionEffort('s1'), '');
  assert.equal(hub.sessionPermissionMode('s1'), '');
  assert.equal(hub.sessionEffort('没见过'), '');
});

// ============================================================================
// ② 断连=未知 + 重连 since 续传（真链路）
// ============================================================================

test('断连=未知：读口一律未知；重连带 since=last_seq 续传（断言假驱动收到的 query 串）', async () => {
  await withFakeDriver((fake) => {
    fake.live = {
      sessions: [{ session_id: 's1', status: 'running', cwd: '/w', owned: true }],
      complete: true,
    };
    fake.archivedIds = ['s1'];
  }, async (fake) => {
    const hub = await startHub(fake);
    try {
      assert.equal(hub.aligned(), true);
      assert.equal(hub.get('s1').status, 'running');
      assert.equal(hub.archived('s1'), true);
      assert.equal(hub.archived('s2'), false);

      // 状态帧经 SSE 真链路折进注册表；订阅者收到的是原始帧
      const seen = [];
      const off = hub.subscribe((fr) => seen.push(fr));
      fake.send(frame('agent/status', 's1', { status: 'idle' }, 5));
      assert.ok(await until(hub, () => hub.stats().last_seq === 5, 3000), '状态帧未折进注册表');
      assert.equal(hub.get('s1').status, 'idle');
      assert.deepEqual(seen.map((f) => f.type), ['agent/status']);
      assert.equal(seen[0].seq, 5);
      assert.equal(seen[0].session_id, 's1');
      off();

      // —— 断连：一切读口＝未知（绝不当成空闲/未归档）——
      const down = hub.wait(3000);
      fake.closeStreams();
      assert.equal(await down, true, '断连应唤醒 wait()');
      assert.equal(hub.connected(), false);
      assert.equal(hub.aligned(), false);
      assert.equal(hub.get('s1'), null);
      assert.deepEqual(hub.snapshot(), {});
      assert.equal(hub.archived('s1'), null);
      assert.equal(hub.archivedSet(), null);
      assert.equal(hub.stats().archived, null);
      assert.equal(hub.stats().connected, false);

      // —— 重连：带 since=已消费最大 seq 续传 + 一次 /live、一次 /archived 对齐 ——
      assert.ok(await until(hub, () => hub.connected() === true && fake.eventsQueries.length === 2,
        3000), '未在 3s 内重连');
      assert.equal(fake.eventsQueries[0].scope, 'state');
      assert.equal(fake.eventsQueries[0].since, '0');
      assert.equal(fake.eventsQueries[1].scope, 'state');
      assert.equal(fake.eventsQueries[1].since, '5', '重连必须以 last_seq 续传');
      assert.equal(fake.calls.live, 2);
      assert.equal(fake.calls.archived, 2);
      assert.equal(hub.aligned(), true, '重连对齐后恢复可信');
      assert.equal(hub.get('s1').status, 'running', '对齐快照为准');
      assert.equal(hub.archived('s1'), true);
      assert.ok(hub.stats().reconnects >= 2);
    } finally {
      await hub.stop(500);
    }
  });
});

// ============================================================================
// ③ 快照可信判定（bug_report/20261008_1935 的回归闸）
// ============================================================================

test('快照可信判定：空快照未声明 complete ⇒ 保留旧表 + aligned=false；complete:true ⇒ 权威空', async () => {
  await withFakeDriver((fake) => {
    fake.live = {
      sessions: [{ session_id: 's1', status: 'running', cwd: '/w', owned: true }],
      complete: true,
    };
    fake.archivedIds = ['s1'];
  }, async (fake) => {
    const hub = await startHub(fake);
    try {
      assert.equal(hub.aligned(), true);
      assert.equal(hub.get('s1').cwd, '/w');

      // 热重载后驱动实例重建的已知形态：/live 空表且**未声明** complete ⇒ 未知
      fake.live = { sessions: [] };
      const logs = captureLogs();
      try {
        fake.closeStreams();
        const untrusted = await until(hub,
          () => hub.connected() === true && hub.aligned() === false, 3000);
        assert.ok(untrusted, '空快照未声明完整时必须置不可信');
        assert.equal(hub.get('s1').status, 'running', '旧表必须保留（宁可多等不可误放行）');
        assert.equal(hub.get('s1').cwd, '/w');
        assert.equal(hub.stats().sessions, 1);
        assert.equal(hub.archived('s1'), true, '这次对齐仍刷新了归档集');
        assert.ok(logs.lines.some((l) => l.includes('[dshevents] /live 空快照且插件未声明完整')),
          `缺留痕行：${logs.lines.join(' | ')}`);
      } finally {
        logs.restore();
      }

      // 插件声明完整（真·零会话）⇒ 权威空：表清空 + 可信
      fake.live = { sessions: [], complete: true };
      // 先等第二次重连的流真的建起来（`_setConnected(true)` 早于 /events 请求到达服务端），
      // 否则 closeStreams() 可能掐了个空
      assert.ok(await until(hub, () => fake.calls.events === 2, 3000), '第二次重连未建流');
      fake.closeStreams();
      const recovered = await until(hub,
        () => hub.connected() === true && hub.aligned() === true, 3000);
      assert.ok(recovered, 'complete:true 的空快照应恢复可信');
      assert.deepEqual(hub.snapshot(), {}, '权威空表清空注册表');
      assert.equal(hub.get('s1'), null);
    } finally {
      await hub.stop(500);
    }
  });
});

test('_align：/live 失败不清表且置不可信（留痕）；/archived 取不到 ⇒ 归档集保持未知', async () => {
  // ① /archived 失败：新中枢首次对齐 ⇒ 会话表照进、归档集仍「未知」
  await withFakeDriver((fake) => {
    fake.live = { sessions: [{ session_id: 's1', status: 'running' }], complete: true };
    fake.archivedMode = 'fail500';
  }, async (fake) => {
    const hub = await startHub(fake);
    try {
      assert.equal(hub.aligned(), true);
      assert.equal(hub.get('s1').status, 'running');
      assert.equal(hub.archived('s1'), null, '取不到归档集 ⇒ 未知，绝不推断未归档');
      assert.equal(hub.archivedSet(), null);
      assert.equal(hub.stats().archived, null);
    } finally {
      await hub.stop(500);
    }
  });

  // ② /live 失败：保留旧表 + 置不可信 + 一行留痕
  await withFakeDriver((fake) => {
    fake.live = { sessions: [{ session_id: 's1', status: 'running', cwd: '/w' }], complete: true };
  }, async (fake) => {
    const hub = await startHub(fake);
    try {
      fake.liveMode = 'fail500';
      const logs = captureLogs();
      try {
        await hub._align();
      } finally {
        logs.restore();
      }
      assert.equal(hub.get('s1').status, 'running', '对齐失败不清表');
      assert.equal(hub.get('s1').cwd, '/w');
      assert.equal(hub.aligned(), false);
      assert.ok(logs.lines.some((l) => l.includes('[dshevents] /live 对齐失败')),
        `缺留痕行：${logs.lines.join(' | ')}`);
    } finally {
      await hub.stop(500);
    }
  });
});

test('_align：非空快照整表覆盖；permission 合并；usage/model/inbox/origin/interaction 不清值', async () => {
  await withFakeDriver((fake) => {
    fake.live = {
      sessions: [{
        session_id: 's1', status: 'running', owned: true, cwd: '/a', task: 't1',
        last_turn_reason: 'completed', last_seq: 5, origin: 'subagent',
      }],
      complete: true,
    };
  }, async (fake) => {
    const hub = await startHub(fake);
    try {
      assert.equal(hub.get('s1').last_seq, 5);
      assert.equal(hub.get('s1').origin, 'subagent');
      assert.equal(hub.get('s1').owned, true);
      assert.equal(hub.get('s1').task, 't1');

      // 事件学到的 model/usage/inbox/permission/interaction：对齐不清值
      const send = (type, sid, data, seq) => fake.send(frame(type, sid, data, seq));
      send('driver/model', 's1', { provider: 'q', model: 'w', reasoningEffort: 'high' }, 6);
      send('usage', 's1', { input: 1, output: 2, total: 3, cache_read: 4 }, 7);
      send('driver/inbox', 's1', { items: [{ id: 'a' }] }, 8);
      send('driver/permission', 's1', { mode: 'manual', preset: 'workspace-write' }, 9);
      send('driver/interaction', 's1', { state: 'asked', interaction: { call_id: 'c1' } }, 10);
      assert.ok(await until(hub, () => hub.stats().last_seq === 10, 3000));
      await hub._align();                                  // 快照没带这些字段
      assert.deepEqual(hub.get('s1').model, { provider: 'q', model: 'w', reasoningEffort: 'high' });
      assert.deepEqual(hub.get('s1').usage, { input: 1, output: 2, total: 3, cache_read: 4 });
      assert.deepEqual(hub.get('s1').inbox, [{ id: 'a' }]);
      assert.deepEqual(hub.get('s1').permission, { mode: 'manual', preset: 'workspace-write' });
      assert.deepEqual(hub.get('s1').interaction, { call_id: 'c1' }, '快照没带 interaction ⇒ 保留');
      assert.equal(hub.get('s1').origin, 'subagent', '快照没带 origin ⇒ 保留');

      // permission 合并：preset 以快照为准、mode 保留平台记下的值
      fake.live = {
        sessions: [{
          session_id: 's1', status: 'idle', permission: { mode: '', preset: 'danger-full-access' },
        }],
        complete: true,
      };
      await hub._align();
      assert.deepEqual(hub.get('s1').permission, { mode: 'manual', preset: 'danger-full-access' });
      // 显式 interaction: null 覆盖（区分「缺字段」与「明确无等待」）
      fake.live = { sessions: [{ session_id: 's1', status: 'idle', interaction: null }], complete: true };
      await hub._align();
      assert.equal(hub.get('s1').interaction, null);
      // origin 缺字段保留（会话固有不变量：别把已认出的子代理又变成未知）
      assert.equal(hub.get('s1').origin, 'subagent');

      // 非空快照＝权威整表：不在行表里的会话消失
      fake.live = {
        sessions: [{ session_id: 's2', status: 'idle', owned: false, cwd: '/b' }],
        complete: true,
      };
      await hub._align();
      assert.deepEqual(Object.keys(hub.snapshot()), ['s2']);
      assert.equal(hub.get('s2').owned, false);
      assert.equal(hub.get('s2').permission, null, '两者皆空 ⇒ null（未知）');
      assert.equal(hub.get('s1'), null);
    } finally {
      await hub.stop(500);
    }
  });
});

// ============================================================================
// ④ 一次(重)连只对齐一次；静置期零请求
// ============================================================================

test('一次(重)连只对齐一次：/live 与 /archived 各 +1；静置期请求数不增长', async () => {
  await withFakeDriver((fake) => {
    fake.live = { sessions: [{ session_id: 's1', status: 'idle' }], complete: true };
    fake.archivedIds = [];
  }, async (fake) => {
    const hub = await startHub(fake, { reconnectMinMs: 25 });
    try {
      assert.deepEqual({ ...fake.calls }, { live: 1, archived: 1, events: 1 }, '首连只对齐一次');
      assert.equal(fake.streams.size, 1, '状态流只能有一条长连');

      await sleep(300);                                    // 静置：不重连、不对齐、零请求
      assert.deepEqual({ ...fake.calls }, { live: 1, archived: 1, events: 1 });
      assert.equal(hub.connected(), true);

      fake.closeStreams();                                 // 断连 → 重连
      const up = await until(hub,
        () => hub.connected() === true && fake.calls.events === 2, 3000);
      assert.ok(up, '未在 3s 内重连');
      assert.deepEqual({ ...fake.calls }, { live: 2, archived: 2, events: 2 },
        '重连后 /live 与 /archived 各只 +1');

      await sleep(300);                                    // 再静置：仍不增长
      assert.deepEqual({ ...fake.calls }, { live: 2, archived: 2, events: 2 });
      assert.equal(fake.streams.size, 1);
    } finally {
      await hub.stop(500);
    }
  });
});

// ============================================================================
// ⑤ 退避（与 Python 实际行为等价：恒为基数，不递增）
// ============================================================================

test('退避：连续失败时重连间隔稳定在基数（对齐 Python 实测口径）、期间不发请求', async (t) => {
  await withFakeDriver((fake) => {
    fake.live = { sessions: [], complete: true };
    fake.eventsMode = 'http500';                 // 建流一律失败（驱动不可用的等价形态）
  }, async (fake) => {
    // 口径来源：Python `_run` 的 `finally: backoff = RECONNECT_MIN`（dshevents.py:240-241）把
    // `except` 分支 `continue` 前的翻倍立刻复位 ⇒ 实测每次重连前都是 1.0s（docstring 的
    // 「1s→10s」落空）。M2 判据是**两版行为等价**，故这里钉住「恒基数」而不是递增。
    // ⚠️ 若将来两侧一起改成真退避（1s→10s 封顶），本用例必须同步改成递增断言。
    const BASE = 50;
    const hub = new EventHub({ reconnectMinMs: BASE });
    assert.equal(hub.start(), true);
    try {
      const enough = await until(hub, () => fake.eventsQueries.length >= 5, 5000);
      assert.ok(enough, `重连尝试过少：${fake.eventsQueries.length}`);
      const at = fake.eventsQueries.map((q) => q.at);
      const gaps = at.slice(1).map((time, i) => time - at[i]);
      t.diagnostic(`重连间隔实测（ms）：${gaps.join('/')}（基数 ${BASE}，应稳定在基数附近，不递增）`);
      for (const [i, gap] of gaps.entries()) {
        assert.ok(gap >= BASE * 0.7,
          `第 ${i + 1} 轮间隔短于基数：${gaps.join('/')}`);
        assert.ok(gap <= BASE * 2.5,
          `第 ${i + 1} 轮间隔远大于基数（真退避已按裁决禁止）：${gaps.join('/')}`);
      }
      assert.ok(fake.eventsQueries.length <= 12,
        `疑似忙循环（退避等待不该发请求）：${fake.eventsQueries.length} 次尝试`);
      assert.equal(hub.connected(), false);
      assert.equal(hub.aligned(), false);
      // 退避期间 align 照走（每次(重)连各一次），但状态流始终没建成
      assert.equal(fake.calls.live, fake.calls.events);
    } finally {
      await hub.stop(500);
    }
  });
});

// ============================================================================
// ⑤b stop()/start() 语义（对齐 Python：stop 无条件复位，超时也可立刻重启）
// ============================================================================

test('stop() 超时：运行标记无条件复位、立刻 start() 可用、旧循环不再置 connected=true', async () => {
  await withFakeDriver((fake) => {
    fake.live = { sessions: [{ session_id: 's1', status: 'idle' }], complete: true };
    fake.liveDelayMs = 1200;                     // 把消费循环卡在 `_align()` 的慢 /live 上
  }, async (fake) => {
    const hub = new EventHub({ reconnectMinMs: 30 });
    assert.equal(hub.start(), true);
    try {
      await sleep(150);                          // 循环已进入慢 /live（尚未建流）
      assert.equal(hub.connected(), false);
      assert.equal(hub.stats().thread, true);
      const t0 = Date.now();
      await hub.stop(300);                       // 显式短超时：必然超时返回
      const cost = Date.now() - t0;
      assert.ok(cost >= 250 && cost < 900, `stop(300) 耗时异常：${cost}ms`);
      // 对齐 Python `stop()` 末尾的 `self._thread = None`：超时也**无条件**复位
      assert.equal(hub.stats().thread, false, 'stop() 后 thread 必须复位（否则 start() 被静默拒绝）');
      // 旧循环 1.2s 后才从 align 返回：修复后既不得建流，也不得再置 connected=true
      const samples = [];
      const watch = setInterval(() => samples.push(hub.connected()), 25);
      await sleep(1500);
      clearInterval(watch);
      assert.ok(samples.length >= 30, `采样过少：${samples.length}`);
      assert.ok(samples.every((v) => v === false),
        `stop 之后出现 connected=true 抖动：${samples.filter(Boolean).length}/${samples.length} 次采样为真`);
      assert.equal(fake.streams.size, 0, '旧循环不得再建状态流');
      assert.equal(hub.stats().frames, 0);
      // 超时也允许立刻重启（Python 同场景：`_thread=None` ⇒ start() 必然 True）
      fake.liveDelayMs = 0;
      assert.equal(hub.start(), true, 'stop() 超时后必须可以立刻 start()');
    } finally {
      await hub.stop(1000);
    }
  });
});

test('stop() 超时后重启：新循环正常建流，旧循环收尾不得覆盖在线态、不得并行消费', async () => {
  await withFakeDriver((fake) => {
    fake.live = { sessions: [{ session_id: 's1', status: 'idle' }], complete: true };
    fake.liveDelayMs = 1000;                     // 第一代卡在慢 /live
  }, async (fake) => {
    const hub = new EventHub({ reconnectMinMs: 30 });
    assert.equal(hub.start(), true);
    try {
      await sleep(120);
      const t0 = Date.now();
      await hub.stop(250);                       // 超时返回：第一代仍在 /live 里
      fake.liveDelayMs = 0;                      // 第二代对齐改快
      assert.equal(hub.start(), true, '超时后必须可重启');
      assert.ok(await until(hub, () => hub.connected() === true, 3000), '重启后的循环未建流');
      // 第一代的 align 约在 t0+1000ms 才落地：其收尾不得把新循环的在线态清成未知
      const remain = Math.max(300, 1000 - (Date.now() - t0) + 300);
      await sleep(remain);
      assert.equal(hub.connected(), true, '旧循环收尾覆盖了新循环的在线态');
      assert.equal(hub.aligned(), true);
      assert.equal(hub.get('s1').status, 'idle');
      assert.equal(fake.streams.size, 1, '不得出现两个并行消费循环');
    } finally {
      await hub.stop(1000);
    }
  });
});

test('stop() 打断退避睡眠：大基数下快速返回（不等满 backoff）', async () => {
  await withFakeDriver((fake) => {
    fake.live = { sessions: [], complete: true };
    fake.eventsMode = 'http500';                 // 建流失败 ⇒ 循环进入退避睡眠
  }, async (fake) => {
    const hub = new EventHub({ reconnectMinMs: 5000 });   // 基数远大于断言窗口
    assert.equal(hub.start(), true);
    try {
      assert.ok(await until(hub, () => fake.calls.events >= 1, 2000), '未发起首次尝试');
      await sleep(60);                            // 确保循环已进入 _sleep(5000)
      assert.equal(hub.connected(), false);
      const t0 = Date.now();
      await hub.stop(1500);                       // 不打断则必然耗满 1500ms 的 race 上限
      const cost = Date.now() - t0;
      assert.ok(cost < 800, `stop() 未打断退避睡眠：耗时 ${cost}ms（退避基数 5000ms）`);
      assert.equal(hub.stats().thread, false);
      await sleep(80);
      assert.equal(hub.connected(), false);
      assert.equal(fake.calls.events, 1, 'stop 后不得再发起重连尝试');
    } finally {
      await hub.stop(200);
    }
  });
});

// ============================================================================
// ⑥ 订阅者
// ============================================================================

test('订阅者：变更回调 / 回调抛异常不影响消费 / 退订后不再收到', () => {
  const hub = new EventHub();
  hub._setConnected(true);
  const seen = [];
  const seen2 = [];
  const off = hub.subscribe((fr) => seen.push(fr.type));
  assert.equal(typeof off, 'function', 'subscribe 返回退订函数');
  hub.subscribe((fr) => {
    seen2.push(fr.type);
    throw new Error('订阅者炸了');
  });

  hub._onFrame(frame('agent/status', 's1', { status: 'running' }, 1));
  assert.deepEqual(seen, ['agent/status']);
  assert.deepEqual(seen2, ['agent/status']);
  assert.equal(hub.get('s1').status, 'running', '回调抛异常不影响折叠');

  off();                                                    // 退订（subscribe 返回值）
  hub._onFrame(frame('agent/status', 's1', { status: 'idle' }, 2));
  assert.deepEqual(seen, ['agent/status'], '退订后不再收到');
  assert.deepEqual(seen2, ['agent/status', 'agent/status']);

  // 订阅者收到**原始帧**（含 seq/session_id/data）
  const raw = [];
  const cb = (fr) => raw.push(fr);
  hub.subscribe(cb);
  hub._onFrame(frame('usage', 's1', { total: 1 }, 3));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].seq, 3);
  assert.equal(raw[0].session_id, 's1');
  assert.equal(raw[0].type, 'usage');
  // 全局归档帧同样通知订阅者
  hub._onFrame({ seq: 4, type: 'driver/archived', session_id: '', data: { archived: ['s1'] } });
  assert.equal(raw.length, 2);
  assert.equal(raw[1].type, 'driver/archived');
  // unsubscribe(cb) 口径（与退订器等价）；重复退订/退订未注册回调静默
  hub.unsubscribe(cb);
  hub.unsubscribe(cb);
  hub._onFrame(frame('usage', 's1', { total: 2 }, 5));
  assert.equal(raw.length, 2);

  // get() 返回浅拷贝：改顶层字段不影响内部注册表
  const copy = hub.get('s1');
  copy.status = '被篡改';
  assert.equal(hub.get('s1').status, 'idle');
});

// ============================================================================
// ⑦ 未配置驱动不启循环 + 模块级薄封装 + 常量
// ============================================================================

test('start()：未配置驱动返回 false 且不起消费循环（不连网）', async () => {
  const prev = process.env[DRIVER_URL_ENV];
  delete process.env[DRIVER_URL_ENV];
  try {
    assert.equal(configured(), false, '用例前置：驱动地址必须为空');
    const hub = new EventHub({ reconnectMinMs: 10 });
    assert.equal(hub.start(), false);
    assert.equal(hub.stats().thread, false);
    assert.equal(hub.connected(), false);
    assert.equal(hub.get('s1'), null);
    await sleep(80);                                        // 若误起循环，这里会发起连接
    assert.equal(hub.stats().frames, 0);
    assert.equal(hub.stats().reconnects, 0);
    await hub.stop(100);                                    // 幂等、无异常
    assert.equal(await hub.wait(20), false);
    // 模块级薄封装同样不误连
    assert.equal(start(), false);
    assert.equal(connected(), false);
  } finally {
    if (prev === undefined) delete process.env[DRIVER_URL_ENV];
    else process.env[DRIVER_URL_ENV] = prev;
  }
});

test('模块级单例薄封装：读口与 EventHub 同口径（未连接=未知）', async () => {
  assert.ok(HUB instanceof EventHub);
  assert.equal(connected(), false);
  assert.equal(get('s1'), null);
  assert.deepEqual(snapshot(), {});
  assert.equal(archived('s1'), null);
  assert.equal(archivedSet(), null);
  assert.equal(sessionEffort('s1'), '');
  assert.equal(sessionPermissionMode('s1'), '');
  assert.deepEqual(stats(), {
    connected: false, sessions: 0, aligned: false, last_seq: 0, frames: 0,
    reconnects: 0, changed: 0, archived: null, thread: false,
  });
  assert.equal(await wait(30), false);
  assert.equal(await waitConnected(30), false);
  const off = subscribe(() => {});
  assert.equal(typeof off, 'function');
  off();
  unsubscribe(() => {});                                    // 未注册回调：静默（对齐 Python 吞 ValueError）
  assert.equal(await stop(100), undefined);
});

test('常量：退避与空闲超时口径（秒，与 Python 同名同值）', () => {
  assert.equal(RECONNECT_MIN, 1.0);
  assert.equal(RECONNECT_MAX, 10.0);
  assert.equal(STREAM_IDLE, 60.0);
});

// ============================================================================
// 等待口（Promise 形态，语义对齐 Python 条件变量）
// ============================================================================

test('wait()/waitConnected()：变更/就绪即真，超时为假；迟到连接被唤醒', async () => {
  const hub = new EventHub();
  assert.equal(await hub.wait(30), false, '无变更 ⇒ 超时 false');
  const t0 = Date.now();
  assert.equal(await hub.waitConnected(60), false, '未连接 ⇒ 超时 false');
  assert.ok(Date.now() - t0 >= 50, '应确实等满超时，不是立刻返回');

  hub._setConnected(true);
  assert.equal(await hub.waitConnected(500), true, '已连接 ⇒ 立即真');

  // 迟到连接：被唤醒而非等满超时
  const late = new EventHub();
  const pending = late.waitConnected(3000);
  const t1 = Date.now();
  setTimeout(() => late._setConnected(true), 40);
  assert.equal(await pending, true);
  assert.ok(Date.now() - t1 < 1500, '迟到连接应立刻唤醒 waitConnected');

  // wait 被变更唤醒
  const changed = hub.wait(3000);
  setTimeout(() => hub._onFrame(frame('agent/status', 's1', { status: 'running' }, 1)), 30);
  assert.equal(await changed, true);

  // stop() 的唤醒（对齐 notify_all）不算变更 ⇒ 返回 false；但必须是**被唤醒**（快）而不是
  // 等满 3000ms 超时——只看返回值的话，漏掉唤醒的变异体也会（3000ms 后）返回 false（评审指出）
  const tWake = Date.now();
  const stopped = hub.wait(3000);
  setTimeout(() => {
    hub.stop(10);
  }, 30);
  assert.equal(await stopped, false);
  const wokeCost = Date.now() - tWake;
  assert.ok(wokeCost < 500,
    `stop() 未唤醒 wait()：耗时 ${wokeCost}ms（超时口径 3000ms ⇒ 疑似漏了 notify）`);
});
