/**
 * backend/lib/dshdriver.js 的契约测试（node --test，零依赖，真起本地**假驱动** HTTP 服务）。
 *
 * 为什么打本地假服务（而不是只打桩函数）：本模块的契约一半在「线上」——方法/路径/查询串/
 * 请求体/请求头（令牌）、响应映射、错误码映射。假服务形状抄 `tests/fakedriver.py`（隔离 e2e
 * 用的替身）与真插件 `dsh-plugin/lib/agent-driver.js` 的响应体，故断言的是**线上字节**，
 * 不是自证式的 mock 期望。**绝不连宿主驱动**（`TS_AGENT_DRIVER_URL` 一律指向本文件的临时
 * 端口；未配置用例显式清空该变量）。
 *
 * 覆盖：
 *   ① 未配置/地址口径（-1）与超时/不可达/非 JSON（-2）、4xx/5xx 状态码映射；
 *   ② 逐端点的方法/路径/查询串/请求体/请求头（token）与响应映射；
 *   ③ `ensure_session` 回落链、`split_model`、`apply_session_defaults` 的下发顺序与告警文案；
 *   ④ 归档 410、看管 404=unsupported；
 *   ⑤ `TurnWaiter` 的 Promise 形态（结论优先级 / consume-on-read / 唤醒 / 超时后可续等）；
 *   ⑥ `stream`/`stateStream`/`feedInto` 的 SSE 行为（帧/seq/stop/超时/对端关闭/非 200）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import * as driver from '../lib/dshdriver.js';
import { SseError, streamEvents as sseStreamEvents } from '../lib/sse.js';

/** 假驱动只认这个令牌（真插件同款 `x-ts-driver-token`） */
const TOKEN = 'tsfake-token-0123456789';
/** 1x1 PNG（媒体端点用；抄 tests/fakedriver.py 的 PNG_1PX） */
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082',
  'hex');

/**
 * 假 dsh 驱动：形状与 `tests/fakedriver.py` 一致（响应体逐字对齐真插件）。
 *
 * 可编排项（测试用）：
 *   `mode`            ok | http500（JSON error）| http500plain（非 JSON 正文）| badjson | empty | hang
 *   `healthOk`        `/health` 的 ok 值（验 available 的布尔口径）
 *   `watchFail`       `/watch` 一律 404（模拟旧插件没该端点）
 *   `archiveFail`     `/archive` 一律 409（硬失败）
 *   `permissionFail`  `/permission` 一律 409（验 best-effort 告警）
 *   `sessionBody`     置值后 `/session` 一律回该 JSON（验写路径回执校验；null = 正常）
 *   `eventsMode`      keepalive | close | silent | reject（SSE 行为）
 */
class FakeDriver {
  constructor() {
    this.calls = [];
    this.mode = 'ok';
    this.healthOk = true;
    this.watchFail = false;
    this.archiveFail = false;
    this.permissionFail = false;
    this.sessionBody = null;
    this.eventsMode = 'keepalive';
    this.archived = ['session-a'];
    this.sessionFrames = [
      { seq: 1, type: 'turn/start', session_id: 'session-a', data: { turn: 1 } },
      { seq: 2, type: 'assistant/message', session_id: 'session-a', data: { text: '片段' } },
      { seq: 4, type: 'turn/end', session_id: 'session-a', data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    this.stateFrames = [
      { seq: 1, type: 'agent/status', session_id: 'session-a', data: { status: 'running' } },
      { seq: 3, type: 'turn/end', session_id: 'session-a', data: { turn: 1, reason: 'completed' } },
    ];
    this.server = null;
    this.url = '';
    this.base = '';
    this.agentBase = '/touchstone-agent';
  }

  /** 起服务（127.0.0.1 随机端口）；`base` 即插件下发的 `TS_AGENT_DRIVER_URL` 形态 */
  async start() {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(() => { /* 收尾竞态：忽略 */ });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    this.base = this.url + this.agentBase;
    return this;
  }

  /** 停服务：先掐掉挂起连接（hang/SSE 长连），再关监听 */
  async close() {
    if (this.server === null) return;
    const srv = this.server;
    this.server = null;
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }

  /** 单条调用记录（最后一次） */
  last() {
    return this.calls[this.calls.length - 1];
  }

  /** 某路径的全部调用记录 */
  byPath(path) {
    return this.calls.filter((c) => c.path === this.agentBase + path);
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
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    this.calls.push({
      method: req.method,
      path: url.pathname,
      rawQuery: url.search,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      raw,
      body,
    });
    if (this.mode === 'hang') return;                 // 挂住不回（测客户端超时）
    if (req.headers['x-ts-driver-token'] !== TOKEN) {
      return this._json(res, 401, { error: '驱动令牌不匹配' });
    }
    const route = url.pathname.startsWith(this.agentBase)
      ? url.pathname.slice(this.agentBase.length) || '/'
      : url.pathname;
    if (route === '/events') return this._events(req, res, url);
    if (this.mode === 'http500') return this._json(res, 500, { error: '宿主崩了' });
    if (this.mode === 'http500plain') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('boom');
    }
    if (this.mode === 'badjson') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('这不是 JSON');
    }
    if (this.mode === 'empty') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('');
    }
    if (req.method === 'GET') return this._get(route, url, res);
    if (req.method === 'POST') return this._post(route, body, res);
    return this._json(res, 404, { error: `未知驱动端点 ${route}` });
  }

  _get(route, url, res) {
    if (route === '/health') {
      return this._json(res, 200, { ok: this.healthOk, live: 1, sessions: 2 });
    }
    if (route === '/live') {
      return this._json(res, 200, {
        sessions: [
          { session_id: 'session-a', status: 'running', cwd: '/w', owned: true, last_seq: 7 },
          { session_id: 'session-ext', status: 'idle', cwd: '/w', owned: false },
        ],
        complete: true,
      });
    }
    if (route === '/status') {
      const sid = url.searchParams.get('session_id') || '';
      if (sid === 'missing') return this._json(res, 404, { error: 'session not found' });
      return this._json(res, 200, {
        session_id: sid, status: 'running', last_seq: 7,
        last_turn_reason: 'completed', interaction: null, cwd: '/w', task: 't1',
      });
    }
    if (route === '/media') {
      const id = url.searchParams.get('id') || '';
      if (id === 'missing') return this._json(res, 404, { error: 'attachment not found' });
      return this._json(res, 200, {
        content_type: 'image/png', bytes: PNG_1PX.length, data: PNG_1PX.toString('base64'),
      });
    }
    if (route === '/models') {
      return this._json(res, 200, {
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [{ id: 'deepseek-official', name: 'DeepSeek 官方',
          models: [{ id: 'deepseek-flash', name: 'DeepSeek-Flash' }] }],
        routable_providers: ['deepseek-official'], failures: [],
      });
    }
    if (route === '/presets') {
      return this._json(res, 200, {
        current: 'workspace-write', default: 'workspace-write',
        options: [{ value: 'workspace-write', name: '工作区可写', approval: 'ask' },
          { value: 'danger-full-access', name: '完全访问', approval: 'never' }],
      });
    }
    if (route === '/archived') return this._json(res, 200, { archived: this.archived.slice() });
    return this._json(res, 404, { error: `未知驱动端点 ${route}` });
  }

  _post(route, body, res) {
    const b = body || {};
    if (route === '/session') {
      if (this.sessionBody !== null) return this._json(res, 200, this.sessionBody);
      return this._json(res, 200, { session_id: b.session_id || 'session-new' });
    }
    if (route === '/prompt' || route === '/steer' || route === '/cancel' || route === '/dispose') {
      return this._json(res, 200, { ok: true });
    }
    if (route === '/compact') return this._json(res, 200, { started: true });
    if (route === '/fork') return this._json(res, 200, { new_session_id: 'session-fork-1' });
    if (route === '/rename') {
      return this._json(res, 200, { ok: true, session_id: b.session_id, title: b.title });
    }
    if (route === '/model') {
      const selected = { provider: b.provider || 'deepseek-official', model: b.model };
      if (b.reasoning_effort) selected.reasoningEffort = b.reasoning_effort;
      return this._json(res, 200, { selected });
    }
    if (route === '/permission') {
      if (this.permissionFail) return this._json(res, 409, { error: 'permissionPresets 服务不可用' });
      const approval = b.preset === 'workspace-write' ? 'ask' : 'never';
      return this._json(res, 200, {
        preset: b.preset, approval, hold_approvals: approval === 'ask', permission: b.preset,
      });
    }
    if (route === '/approval') {
      if (b.approval_id === 'gone') {
        return this._json(res, 409, { error: '当前没有等待中的审批（或已由 GUI 作答）' });
      }
      return this._json(res, 200, { outcome: b.decision });
    }
    if (route === '/answer') {
      return this._json(res, 200, { accepted: b.call_id !== 'gone' });
    }
    if (route === '/watch') {
      if (this.watchFail) return this._json(res, 404, { error: '未知驱动端点 /watch' });
      return this._json(res, 200, {
        ok: true, session_id: b.session_id, watched: b.on !== false,
      });
    }
    if (route === '/archive') {
      if (this.archiveFail) return this._json(res, 409, { error: '归档集不可写' });
      if (b.session_id === 'ghost') {
        return this._json(res, 410, { error: `会话不存在，无法归档: ${b.session_id}` });
      }
      return this._json(res, 200, { session_id: b.session_id, archived: b.archived !== false });
    }
    return this._json(res, 404, { error: `未知驱动端点 ${route}` });
  }

  /** SSE：先补发 ring 内 `seq > since` 的帧，再按 `eventsMode` 决定 keepalive/关闭/静默 */
  _events(req, res, url) {
    const scope = url.searchParams.get('scope') || '';
    const sid = url.searchParams.get('session_id') || '';
    if (this.eventsMode === 'reject') return this._json(res, 500, { error: '事件流被拒: 测试' });
    if (scope !== 'state' && sid === 'missing') {
      return this._json(res, 404, { error: 'session not found' });
    }
    const since = Number(url.searchParams.get('since') || '0') || 0;
    const frames = (scope === 'state' ? this.stateFrames : this.sessionFrames)
      .filter((f) => f.seq > since);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    res.write(': keepalive\n\n');
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (this.eventsMode === 'close') return res.end();
    if (this.eventsMode === 'silent') return undefined;      // 挂着不写（测空闲超时）
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 25);
    res.on('close', () => clearInterval(timer));
    req.on('close', () => clearInterval(timer));
    return undefined;
  }
}

/** 环境变量保存/恢复（驱动连接信息就在 env 里，测试必须成对清理） */
function saveEnv() {
  return {
    url: process.env[driver.URL_ENV],
    token: process.env[driver.TOKEN_ENV],
  };
}

function restoreEnv(saved) {
  if (saved.url === undefined) delete process.env[driver.URL_ENV];
  else process.env[driver.URL_ENV] = saved.url;
  if (saved.token === undefined) delete process.env[driver.TOKEN_ENV];
  else process.env[driver.TOKEN_ENV] = saved.token;
}

/**
 * 起假驱动 + 把连接信息写进 env + 跑用例 + 收尾（顺序固定）。
 * `token=null` 表示不发令牌；`useUrl=false` 表示保持「未配置」。
 */
async function withDriver(fn, { token = TOKEN, useUrl = true } = {}) {
  const drv = await new FakeDriver().start();
  const saved = saveEnv();
  if (useUrl) process.env[driver.URL_ENV] = drv.base;
  else delete process.env[driver.URL_ENV];
  if (token === null) delete process.env[driver.TOKEN_ENV];
  else process.env[driver.TOKEN_ENV] = token;
  try {
    return await fn(drv);
  } finally {
    restoreEnv(saved);
    await drv.close();
  }
}

// ---------- 连接与配置 ----------

test('未配置驱动：configured/driverUrl/available 与 -1 口径（health/splitDriverUrl/stream）', async () => {
  const saved = saveEnv();
  delete process.env[driver.URL_ENV];
  delete process.env[driver.TOKEN_ENV];
  try {
    assert.equal(driver.driverUrl(), '');
    assert.equal(driver.configured(), false);
    assert.equal(await driver.available(), false);
    await assert.rejects(() => driver.health(), (e) => {
      assert.ok(e instanceof driver.DshDriverError);
      assert.equal(e.code, -1);
      assert.equal(e.message, '未配置 dsh agent 驱动（非插件形态或插件未下发驱动地址）');
      assert.equal(String(e), e.message, 'String(err) 是纯消息（无元组串）');
      return true;
    });
    assert.throws(() => driver.splitDriverUrl(),
      (e) => e.code === -1 && e.message === '驱动地址不可用: (空)');
    // 非 http 协议同样判 -1（对齐 Python `_split_url` 的 scheme 校验）
    process.env[driver.URL_ENV] = 'https://127.0.0.1:3080/touchstone-agent';
    assert.throws(() => driver.splitDriverUrl(),
      (e) => e.code === -1 && e.message.includes('驱动地址不可用'));
    await assert.rejects(() => driver.stream('s1', () => {}), (e) => e.code === -1);
    await assert.rejects(() => driver.stateStream(() => {}), (e) => e.code === -1);
  } finally {
    restoreEnv(saved);
  }
});

test('driverUrl 归一（trim + 去尾斜杠）与 splitDriverUrl 三元组口径', async () => {
  const saved = saveEnv();
  try {
    process.env[driver.URL_ENV] = '  http://127.0.0.1:3080/touchstone-agent//  ';
    assert.equal(driver.driverUrl(), 'http://127.0.0.1:3080/touchstone-agent');
    assert.equal(driver.configured(), true);
    // Python `_split_url()` 返回 ("127.0.0.1", 3080, "/touchstone-agent")；Node 返回对象
    assert.deepEqual(driver.splitDriverUrl(),
      { host: '127.0.0.1', port: 3080, basePath: '/touchstone-agent' });
    // 无端口 ⇒ 80；无路径 ⇒ basePath 空串（对齐 Python `path.rstrip('/')`）
    process.env[driver.URL_ENV] = 'http://127.0.0.1';
    assert.deepEqual(driver.splitDriverUrl(), { host: '127.0.0.1', port: 80, basePath: '' });
  } finally {
    restoreEnv(saved);
  }
});

test('authHeaders：令牌有无两态 + content-type/accept 头口径', async () => {
  const saved = saveEnv();
  try {
    process.env[driver.TOKEN_ENV] = 'tok-1';
    assert.deepEqual(driver.authHeaders(), {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      'x-ts-driver-token': 'tok-1',
    });
    delete process.env[driver.TOKEN_ENV];
    const head = driver.authHeaders();
    assert.equal('x-ts-driver-token' in head, false, '无令牌时不下发该头');
    assert.equal(head.accept, 'application/json');
  } finally {
    restoreEnv(saved);
  }
});

// ---------- 探活与错误映射 ----------

test('health/available：ok 布尔口径 + 令牌头透传', async () => {
  await withDriver(async (drv) => {
    const resp = await driver.health();
    assert.deepEqual(resp, { ok: true, live: 1, sessions: 2 });
    assert.equal(await driver.available(), true);
    const call = drv.last();
    assert.equal(call.method, 'GET');
    assert.equal(call.path, '/touchstone-agent/health');
    assert.equal(call.headers['x-ts-driver-token'], TOKEN);
    assert.equal(call.headers.accept, 'application/json');
    assert.equal(call.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(call.raw, '', 'GET 不带请求体');
    // ok=false ⇒ available false（不抛）
    drv.healthOk = false;
    assert.equal(await driver.available(), false);
  });
});

test('令牌不匹配 ⇒ DshDriverError(401)，消息取正文 error 字段', async () => {
  await withDriver(async () => {
    await assert.rejects(() => driver.health(), (e) => {
      assert.ok(e instanceof driver.DshDriverError);
      assert.equal(e.code, 401);
      assert.equal(e.message, '驱动令牌不匹配');
      return true;
    });
  }, { token: 'wrong-token' });
});

test('5xx/4xx 映射：正文 JSON error 优先，非 JSON 正文回落「驱动返回 HTTP <code>」', async () => {
  await withDriver(async (drv) => {
    drv.mode = 'http500';
    await assert.rejects(() => driver.health(),
      (e) => e.code === 500 && e.message === '宿主崩了');
    drv.mode = 'http500plain';
    await assert.rejects(() => driver.health(),
      (e) => e.code === 500 && e.message === '驱动返回 HTTP 500');
    drv.mode = 'ok';
    await assert.rejects(() => driver.status('missing'),
      (e) => e.code === 404 && e.message === 'session not found');
    await assert.rejects(() => driver.media('missing'),
      (e) => e.code === 404 && e.message === 'attachment not found');
  });
});

test('响应体非法 JSON ⇒ -2；空正文 ⇒ {}（用于无体端点）', async () => {
  await withDriver(async (drv) => {
    drv.mode = 'badjson';
    await assert.rejects(() => driver.health(), (e) => {
      assert.equal(e.code, -2);
      assert.match(e.message, /^驱动响应不是 JSON: 这不是 JSON/);
      return true;
    });
    drv.mode = 'empty';
    assert.deepEqual(await driver.health(), {});
    assert.equal(await driver.available(), false, '{} 无 ok ⇒ false');
  });
});

test('请求超时 ⇒ DshDriverError(-2)（含「超时」字样），不挂死', async () => {
  await withDriver(async (drv) => {
    drv.mode = 'hang';
    const started = Date.now();
    await assert.rejects(() => driver.health({ timeoutMs: 150 }), (e) => {
      assert.equal(e.code, -2);
      assert.match(e.message, /驱动不可达: 请求超时（>150ms 无响应）/);
      return true;
    });
    assert.ok(Date.now() - started < 2000, '客户端超时应及时收口');
  });
});

test('驱动不可达 ⇒ -2（连接被拒）', async () => {
  const probe = await new FakeDriver().start();
  const dead = probe.base;
  await probe.close();                       // 端口随即释放 ⇒ 连接被拒
  const saved = saveEnv();
  process.env[driver.URL_ENV] = dead;
  process.env[driver.TOKEN_ENV] = TOKEN;
  try {
    await assert.rejects(() => driver.health(), (e) => {
      assert.equal(e.code, -2);
      assert.match(e.message, /^驱动不可达: /);
      return true;
    });
    assert.equal(await driver.available(), false);
  } finally {
    restoreEnv(saved);
  }
});

// ---------- 读端点 ----------

test('liveSnapshot/live：原始响应（含 complete）与行表读口分离', async () => {
  await withDriver(async (drv) => {
    const snap = await driver.liveSnapshot();
    assert.equal(snap.complete, true);
    assert.equal(snap.sessions.length, 2);
    const rows = await driver.live();
    assert.deepEqual(rows.map((r) => r.session_id), ['session-a', 'session-ext']);
    assert.equal(rows[1].owned, false);
    const call = drv.last();
    assert.equal(call.method, 'GET');
    assert.equal(call.path, '/touchstone-agent/live');
    assert.deepEqual(call.query, {});
  });
});

test('status/media/presets：查询串编码（Python quote 口径，逐字节）+ 响应映射', async () => {
  await withDriver(async (drv) => {
    const st = await driver.status('session a&b');
    assert.equal(st.last_seq, 7);
    assert.deepEqual(drv.last().query, { session_id: 'session a&b' }, '特殊字符往返一致');
    assert.equal(drv.last().path, '/touchstone-agent/status');
    // Python `quote(sid)`：空格 %20、`/` 不编码、`?`/`=`/`&` 编码、`!'()*` 也编码
    await driver.status('a b/c?d=1&e');
    assert.equal(drv.last().rawQuery, '?session_id=a%20b/c%3Fd%3D1%26e');
    await driver.status("it's(a)*b!");
    assert.equal(drv.last().rawQuery, '?session_id=it%27s%28a%29%2Ab%21');

    const pic = await driver.media('attach-1');
    assert.equal(pic.content_type, 'image/png');
    assert.deepEqual(Buffer.from(pic.data, 'base64'), PNG_1PX);
    assert.deepEqual(drv.last().query, { id: 'attach-1' });
    // `quote(id, safe="")`：斜杠也编码（与 status 的 safe='/' 不同）
    await driver.media('sha256:ab/cd');
    assert.equal(drv.last().rawQuery, '?id=sha256%3Aab%2Fcd');

    const pre = await driver.presets('session-a');
    assert.equal(pre.current, 'workspace-write');
    assert.equal(pre.options[0].value, 'workspace-write');
    assert.deepEqual(drv.last().query, { session_id: 'session-a' });
    await driver.presets('a/b');
    assert.equal(drv.last().rawQuery, '?session_id=a/b', 'presets 同 status：斜杠不编码');
    // 2026-10-21：空 session_id ⇒ **不带查询串**（取目录用，插件侧不查会话池）
    await driver.presets();
    assert.equal(drv.last().path, '/touchstone-agent/presets');
    assert.equal(drv.last().rawQuery, '');
    assert.deepEqual(drv.last().query, {});
    await driver.presets('');
    assert.equal(drv.last().rawQuery, '', "显式空串同「不带 session_id」");
  });
});

test('models/archived：响应映射（archived 只取数组；缺字段 ⇒ 空表）', async () => {
  await withDriver(async (drv) => {
    const cat = await driver.models();
    assert.equal(cat.default.model, 'deepseek-flash');
    assert.equal(cat.groups[0].models[0].id, 'deepseek-flash');
    assert.deepEqual(await driver.archived(), ['session-a']);
    drv.archived = [];
    assert.deepEqual(await driver.archived(), []);
  });
});

// ---------- 会话生命周期（写路径） ----------

test('createSession/resumeSession/ensureSession：请求体逐键 + 回落链', async () => {
  await withDriver(async (drv) => {
    assert.equal(await driver.createSession('/tmp/x', 'task-1', 'deepseek-flash', 'deepseek-official'),
      'session-new');
    assert.deepEqual(drv.last().body, {
      cwd: '/tmp/x', task: 'task-1', model: 'deepseek-flash', provider: 'deepseek-official',
    });

    // 空 model/provider 不下发这两个键（对齐 Python `if model:` / `if provider:`）
    await driver.createSession('/tmp/x');
    assert.deepEqual(drv.last().body, { cwd: '/tmp/x', task: '' });

    assert.equal(await driver.resumeSession('session-a', 'task-1', '/tmp/x'), 'session-a');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', task: 'task-1', cwd: '/tmp/x' });

    // ensure_session：有 sid ⇒ resume 分支（带 session_id）；无 sid ⇒ create 分支（不带）
    await driver.ensureSession('session-a', '/tmp/x', 'task-1');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', task: 'task-1', cwd: '/tmp/x' });
    await driver.ensureSession('', '/tmp/x', 'task-1', 'm', 'p');
    assert.deepEqual(drv.last().body, { cwd: '/tmp/x', task: 'task-1', model: 'm', provider: 'p' });
    assert.equal('session_id' in drv.last().body, false);
  });
});

test('写路径不宽容（P7）：/session 回执缺 session_id / 值为空 ⇒ 抛 -2，不返回 undefined', async () => {
  const bad = [
    [{}, '缺键'],
    [{ session_id: null }, 'null'],
    [{ session_id: '' }, '空串'],
    [{ ok: true }, '别的键'],
  ];
  for (const [body, why] of bad) {
    await withDriver(async (drv) => {
      drv.sessionBody = body;
      const check = (e) => {
        assert.ok(e instanceof driver.DshDriverError, `${why}: 必须抛 DshDriverError`);
        assert.equal(e.code, -2, why);
        assert.equal(e.message, '驱动响应缺少 session_id', why);
        return true;
      };
      // 三条入口都走同一校验：create（空 sid）/ resume（有 sid）/ ensure 的两条回落链
      await assert.rejects(() => driver.createSession('/tmp/x'), check);
      await assert.rejects(() => driver.resumeSession('session-a', 't', '/tmp/x'), check);
      await assert.rejects(() => driver.ensureSession('session-a', '/tmp/x'), check);
      await assert.rejects(() => driver.ensureSession('', '/tmp/x'), check);
      assert.equal(drv.byPath('/session').length, 4, '四次调用都真的发了请求（失败发生在回执校验）');
    });
  }
});

test('写路径不宽容（P7）：回执正常时照旧返回 sid（ensure 两条回落链语义不变）', async () => {
  await withDriver(async (drv) => {
    assert.equal(await driver.createSession('/tmp/x'), 'session-new');
    assert.equal(await driver.resumeSession('session-a'), 'session-a');
    assert.equal(await driver.ensureSession('session-a', '/tmp/x'), 'session-a');
    assert.equal(await driver.ensureSession('', '/tmp/x'), 'session-new');
    assert.equal(drv.byPath('/session').length, 4);
  });
});

test('请求体字节口径：pyJsonDumps（与 CPython json.dumps 逐字节一致，非紧凑形态）', async () => {
  await withDriver(async (drv) => {
    // 期望串 = CPython `json.dumps(obj, ensure_ascii=False)` 的默认形态（分隔符 ", " / ": "）
    await driver.prompt('session-a', '写用例：中文 ≤ 符号');
    assert.equal(drv.last().raw, '{"session_id": "session-a", "prompt": "写用例：中文 ≤ 符号"}');
    await driver.createSession('/cwd');
    assert.equal(drv.last().raw, '{"cwd": "/cwd", "task": ""}');
    await driver.cancel('session-a', true);
    assert.equal(drv.last().raw, '{"session_id": "session-a", "keep_inbox": true}');
    await driver.fork('session-a', 5);
    assert.equal(drv.last().raw, '{"session_id": "session-a", "at_seq": 5}');
    await driver.answerQuestion('session-a', 'call-1', [{ id: 'q1', selected: ['A'], custom: '' }]);
    assert.equal(drv.last().raw,
      '{"session_id": "session-a", "call_id": "call-1", '
      + '"answers": [{"id": "q1", "selected": ["A"], "custom": ""}]}');
    // 转义口径与 CPython 相同：换行走 \n（不是字面换行）、引号走 \"
    await driver.steer('session-a', '一\n二 "三"');
    assert.equal(drv.last().raw, '{"session_id": "session-a", "prompt": "一\\n二 \\"三\\""}');
  });
});

test('splitModel：provider/model 拆分口径（含无前缀与空串）', () => {
  assert.deepEqual(driver.splitModel('deepseek-official/deepseek-flash'),
    ['deepseek-official', 'deepseek-flash']);
  assert.deepEqual(driver.splitModel('deepseek-flash'), ['', 'deepseek-flash']);
  assert.deepEqual(driver.splitModel(''), ['', '']);
  assert.deepEqual(driver.splitModel('/x'), ['', '/x'], '缺 provider 不拆');
  assert.deepEqual(driver.splitModel('x/'), ['', 'x/'], '缺 model id 不拆');
});

test('prompt/steer/cancel/dispose：方法/路径/请求体（中文 UTF-8 原样发）', async () => {
  await withDriver(async (drv) => {
    await driver.prompt('session-a', '写用例：中文 ≤ 符号');
    assert.equal(drv.last().method, 'POST');
    assert.equal(drv.last().path, '/touchstone-agent/prompt');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', prompt: '写用例：中文 ≤ 符号' });
    assert.ok(drv.last().raw.includes('中文'), 'JSON 不转义非 ASCII（对齐 ensure_ascii=False）');

    await driver.steer('session-a', '插话');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', prompt: '插话' });

    await driver.cancel('session-a');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', keep_inbox: false });
    await driver.cancel('session-a', true);
    assert.deepEqual(drv.last().body, { session_id: 'session-a', keep_inbox: true });

    await driver.dispose('session-a');
    assert.deepEqual(drv.last().body, { session_id: 'session-a' });
  });
});

test('compact/fork/rename：at_seq 缺省语义与「宿主接受值」回传', async () => {
  await withDriver(async (drv) => {
    assert.deepEqual(await driver.compact('session-a'), { started: true });
    assert.deepEqual(drv.last().body, { session_id: 'session-a' });

    const forked = await driver.fork('session-a');
    assert.equal(forked.new_session_id, 'session-fork-1');
    assert.deepEqual(drv.last().body, { session_id: 'session-a' }, 'at_seq 缺省不下发');
    await driver.fork('session-a', 7);
    assert.deepEqual(drv.last().body, { session_id: 'session-a', at_seq: 7 });
    await driver.fork('session-a', 0);
    assert.deepEqual(drv.last().body, { session_id: 'session-a' }, 'at_seq=0 视为缺省（if at_seq）');

    const renamed = await driver.rename('session-a', '新标题');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', title: '新标题' });
    assert.equal(renamed.title, '新标题');
  });
});

test('setModel/setPermission：可选键缺省语义', async () => {
  await withDriver(async (drv) => {
    await driver.setModel('session-a', 'deepseek-flash');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', model: 'deepseek-flash' });
    await driver.setModel('session-a', '', '', 'high');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', model: '', reasoning_effort: 'high' },
      'model 可空（只改思考等级）');
    await driver.setModel('session-a', 'm', 'p', 'high');
    assert.deepEqual(drv.last().body,
      { session_id: 'session-a', model: 'm', provider: 'p', reasoning_effort: 'high' });

    await driver.setPermission('session-a', 'workspace-write');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', preset: 'workspace-write' });
    await driver.setPermission('session-a', 'workspace-write', 'manual');
    assert.deepEqual(drv.last().body,
      { session_id: 'session-a', preset: 'workspace-write', mode: 'manual' });
  });
});

test('answerQuestion/answerApproval：受理布尔与 409 映射', async () => {
  await withDriver(async (drv) => {
    assert.equal(await driver.answerQuestion('session-a', 'call-1',
      [{ id: 'q_0', selected: ['通过'] }]), true);
    assert.deepEqual(drv.last().body, {
      session_id: 'session-a', call_id: 'call-1', answers: [{ id: 'q_0', selected: ['通过'] }],
    });
    assert.equal(await driver.answerQuestion('session-a', 'gone', []), false, '已答/不存在 ⇒ false');

    const out = await driver.answerApproval('session-a', 'ap-1', 'allowed-once');
    assert.equal(out.outcome, 'allowed-once');
    await assert.rejects(() => driver.answerApproval('session-a', 'gone', 'rejected'),
      (e) => e.code === 409 && e.message.includes('等待中的审批'));
  });
});

test('archive/unarchive：410=会话不存在、硬失败 409、archived 归一', async () => {
  await withDriver(async (drv) => {
    const ok = await driver.archive('session-a');
    assert.deepEqual(ok, { session_id: 'session-a', archived: true });
    assert.deepEqual(drv.last().body, { session_id: 'session-a', archived: true });
    await driver.unarchive('session-a');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', archived: false });

    await assert.rejects(() => driver.archive('ghost'), (e) => {
      assert.equal(e.code, driver.ARCHIVE_UNKNOWN_SESSION);
      assert.equal(e.code, 410);
      assert.equal(e.message, '会话不存在，无法归档: ghost');
      return true;
    });
    drv.archiveFail = true;
    await assert.rejects(() => driver.archive('session-a'),
      (e) => e.code === 409 && e.message === '归档集不可写');
  });
});

test('watchSession：watched 当前值语义、404=WATCH_UNSUPPORTED、超时 2s 常量', async () => {
  assert.equal(driver.WATCH_TIMEOUT, 2);
  assert.equal(driver.WATCH_UNSUPPORTED, 404);
  await withDriver(async (drv) => {
    assert.equal(await driver.watchSession('ext-1'), true);
    assert.deepEqual(drv.last().body, { session_id: 'ext-1', on: true });
    assert.equal(await driver.watchSession('ext-1', false), false, '撤销 ⇒ watched 当前为 false');
    assert.deepEqual(drv.last().body, { session_id: 'ext-1', on: false });
    assert.equal(await driver.watchSession('ext-1', 0), false, '真值归一（Boolean(on)）');
    drv.watchFail = true;
    await assert.rejects(() => driver.watchSession('ext-1'), (e) => {
      assert.equal(e.code, driver.WATCH_UNSUPPORTED);
      assert.equal(e.message, '未知驱动端点 /watch');
      return true;
    });
  });
});

// ---------- 项目级默认值 ----------

test('applySessionDefaults：权限先于思考等级下发；无告警；log 不被调用', async () => {
  await withDriver(async (drv) => {
    const logs = [];
    const warns = await driver.applySessionDefaults('session-a', 'deepseek-flash',
      'deepseek-official', 'high', 'manual', (t) => logs.push(t));
    assert.deepEqual(warns, []);
    assert.deepEqual(logs, []);
    const paths = drv.calls.map((c) => c.path);
    assert.deepEqual(paths, ['/touchstone-agent/permission', '/touchstone-agent/model'],
      '先权限档后思考等级（与 Python 同序）');
    // 2026-10-21：权限档改为 host preset 直达 ⇒ manual 别名映射后下发，**不再带 mode**
    assert.deepEqual(drv.calls[0].body,
      { session_id: 'session-a', preset: 'workspace-write' });
    assert.deepEqual(drv.calls[1].body,
      { session_id: 'session-a', model: 'deepseek-flash', provider: 'deepseek-official', reasoning_effort: 'high' });
  });
});

test('applySessionDefaults：preset 直达（manual/yolo 别名映射，path-rules/auto 原样，均不带 mode）', async () => {
  await withDriver(async (drv) => {
    const cases = [
      ['manual', 'workspace-write'],          // 旧档别名
      ['yolo', 'danger-full-access'],         // 旧档别名
      ['auto', 'auto'],                       // 不再走旧别名：宿主的 auto 是独立实验档
      ['path-rules', 'path-rules'],           // 宿主自定义档原样
      ['write-guard', 'write-guard'],
      ['read-only', 'read-only'],
    ];
    for (const [input, preset] of cases) {
      const warns = await driver.applySessionDefaults('session-a', '', '', '', input);
      assert.deepEqual(warns, [], input);
      assert.deepEqual(drv.last().body, { session_id: 'session-a', preset }, input);
      assert.equal('mode' in drv.last().body, false, `${input}：不再下传 mode`);
    }
    // 带空白的入参先 strip 再映射
    await driver.applySessionDefaults('session-a', '', '', '', '  manual  ');
    assert.deepEqual(drv.last().body, { session_id: 'session-a', preset: 'workspace-write' });
  });
});

test('applySessionDefaults：空白档位只告警跳过；非空值一律按 preset 下发（合法性由宿主/落库校验）', async () => {
  await withDriver(async (drv) => {
    const warns = await driver.applySessionDefaults('session-a', 'm', 'p', 'turbo', '   ');
    assert.equal(drv.calls.length, 0, '空白档位 + 非法等级都不该发请求');
    assert.deepEqual(warns, [
      "### 项目权限档 '' 非法，已跳过（会话沿用宿主默认）\n",   // 与 Python 同：strip 后再 repr
      "### 项目思考等级 'turbo' 非法，已跳过（合法值：off/minimal/low/medium/high/xhigh/max）\n",
    ]);
    // 非空但宿主不认识的 value：新口径不在驱动层本地判非法（项目落库时已按宿主目录校验过），
    // 原样作为 preset 下发、由宿主裁决（契约 §5.6：`preset = LEGACY_PERMISSION_ALIASES.get(v, v)`）
    const forwarded = await driver.applySessionDefaults('session-a', '', '', '', 'boss');
    assert.deepEqual(forwarded, []);
    assert.deepEqual(drv.last().body, { session_id: 'session-a', preset: 'boss' });
  });
});

test('applySessionDefaults：驱动失败只告警（best-effort 不抛），log 回调收到同文', async () => {
  await withDriver(async (drv) => {
    drv.permissionFail = true;
    const logs = [];
    const warns = await driver.applySessionDefaults('session-a', 'm', 'p', 'high', 'manual',
      (t) => logs.push(t));
    // 权限档失败 ⇒ 一条告警；思考等级这一步走 /model 成功 ⇒ 无告警（两步互不牵连）
    assert.deepEqual(warns, ['### 项目权限档 manual 未生效：permissionPresets 服务不可用\n']);
    assert.deepEqual(logs, warns, 'log 逐条即时收到同一份文案');
    assert.deepEqual(drv.calls.map((c) => c.path),
      ['/touchstone-agent/permission', '/touchstone-agent/model'], '失败后仍继续下一步');

    // 两步都失败 ⇒ 两条告警（且不抛）
    drv.mode = 'http500';
    const both = await driver.applySessionDefaults('session-a', 'm', 'p', 'high', 'manual');
    assert.equal(both.length, 2);
    assert.equal(both[0], '### 项目权限档 manual 未生效：宿主崩了\n');
    assert.equal(both[1], '### 项目思考等级 high 未生效：宿主崩了\n');
  });
});

test('applySessionDefaults：log 抛异常不影响业务（告警照收），空参数直接返回空表', async () => {
  await withDriver(async (drv) => {
    const warns = await driver.applySessionDefaults('session-a', 'm', 'p', 'turbo', 'manual',
      () => { throw new Error('日志盘满了'); });
    assert.deepEqual(warns, ["### 项目思考等级 'turbo' 非法，已跳过"
      + '（合法值：off/minimal/low/medium/high/xhigh/max）\n']);
    assert.equal(drv.calls.length, 1, '只有权限档那一步发了请求');
    assert.deepEqual(await driver.applySessionDefaults('session-a'), []);
    assert.equal(drv.calls.length, 1, '空参数不发任何请求');
  });
});

// ---------- 权限目录归一（纯函数，契约 §3） ----------

test('permissionOption：内置中文产品名 / EN 默认名 / 自定义透传 / kebab Title-Case / 宿主 desc 优先', () => {
  const ZH = driver.BUILTIN_PERMISSION_LABELS_ZH;
  const EN = driver.BUILTIN_PERMISSION_LABELS_EN;
  const DESC = driver.BUILTIN_PERMISSION_DESCRIPTIONS;
  // ① 内置三档：宿主上报的 name 就是 machine value ⇒ 仍显示中文产品名；描述用 TS 侧补充
  assert.deepEqual(driver.permissionOption('read-only', 'read-only', ''),
    { value: 'read-only', label: '仅可查看', description: DESC['read-only'] });
  assert.deepEqual(driver.permissionOption('workspace-write', 'workspace-write'),
    { value: 'workspace-write', label: '工作区内修改', description: DESC['workspace-write'] });
  assert.deepEqual(driver.permissionOption('danger-full-access', 'danger-full-access', ''),
    { value: 'danger-full-access', label: '完全权限', description: DESC['danger-full-access'] });
  // ② EN 默认名同样归中文产品名（镜像 DSH 客户端 DEFAULT_PRESET_LABELS）
  assert.equal(EN['read-only'], 'Read Only');
  assert.equal(EN['workspace-write'], 'Workspace Write');
  assert.equal(EN['danger-full-access'], 'Full access');
  assert.equal(driver.permissionOption('read-only', 'Read Only', '').label, '仅可查看');
  assert.equal(driver.permissionOption('workspace-write', 'Workspace Write', '').label, '工作区内修改');
  assert.equal(driver.permissionOption('danger-full-access', 'Full access', '').label, '完全权限');
  // ③ auto：DSH 客户端对 auto 恒用产品名（host name 即使给别的也不用）
  assert.deepEqual(driver.permissionOption('auto', 'auto', ''),
    { value: 'auto', label: '自动审查（实验）', description: DESC.auto });
  assert.equal(driver.permissionOption('auto', '完全自主', '').label, '自动审查（实验）');
  // ④ 自定义档：宿主 name/description 透传
  assert.deepEqual(driver.permissionOption('path-rules', '路径规则', '项目内可读写；项目外读允许、写需审批；白名单直通；黑名单一律审批。'),
    { value: 'path-rules', label: '路径规则', description: '项目内可读写；项目外读允许、写需审批；白名单直通；黑名单一律审批。' });
  // ⑤ 宿主给了 description ⇒ 优先于内置描述
  assert.equal(driver.permissionOption('read-only', 'read-only', '宿主自己的描述').description,
    '宿主自己的描述');
  // ⑥ 无 name / name===value 的 kebab 值 ⇒ Title-Case（镜像 DSH）
  assert.equal(driver.permissionOption('some-preset').label, 'Some Preset');
  assert.equal(driver.permissionOption('some-preset', 'some-preset', '').label, 'Some Preset');
  assert.equal(driver.permissionOption('a-b-c', '', '').label, 'A B C');
  // ⑦ 未知 value + 非 kebab 的 name ⇒ 原样；未知且无描述 ⇒ 空描述
  const odd = driver.permissionOption('奇怪档', '奇怪 档', '');
  assert.deepEqual(odd, { value: '奇怪档', label: '奇怪 档', description: '' });
  assert.deepEqual(driver.permissionOption('path-rules', '路径规则', ''),
    { value: 'path-rules', label: '路径规则', description: '' });
  // ⑧ value 两端空白先 strip；空 value ⇒ 空对象（调用方过滤）
  assert.equal(driver.permissionOption(' path-rules ', '路径规则', '').value, 'path-rules');
  assert.deepEqual(driver.permissionOption(''), {});
  assert.deepEqual(driver.permissionOption('   '), {});
  assert.deepEqual(driver.permissionOption(null), {});
  assert.deepEqual(driver.permissionOption(undefined), {});
  // ⑨ 常量逐字（跨语言契约）
  assert.deepEqual(driver.LEGACY_PERMISSION_ALIASES,
    { manual: 'workspace-write', yolo: 'danger-full-access' });
  assert.deepEqual(ZH, { 'read-only': '仅可查看', 'workspace-write': '工作区内修改',
    'danger-full-access': '完全权限', auto: '自动审查（实验）' });
  assert.deepEqual(Object.keys(DESC).sort(),
    ['auto', 'danger-full-access', 'read-only', 'workspace-write']);
});

// ---------- 常量与轮次口径 ----------

test('常量：思考等级/帧类型/退出码（旧三档映射常量已随 2026-10-21 权限对齐删除）', () => {
  assert.equal('PERMISSION_PRESETS' in driver, false);
  assert.equal('PRESET_MODES' in driver, false);
  assert.deepEqual([...driver.EFFORT_LEVELS],
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(driver.TURN_END, 'turn/end');
  assert.equal(driver.INTERACTION, 'driver/interaction');
  assert.equal(driver.REQUEST_TIMEOUT, 120);
  assert.equal(driver.HEALTH_TIMEOUT, 5);
  assert.equal(driver.STREAM_IDLE_TIMEOUT, 90);
  assert.equal(driver.STOP_WATCH_INTERVAL, 0.25, 'Python 秒值同名导出（实际节拍在 sse.js）');
  assert.equal(driver.STOP_WATCH_INTERVAL_MS, 250);
  assert.equal(driver.URL_ENV, 'TS_AGENT_DRIVER_URL');
  assert.equal(driver.TOKEN_ENV, 'TS_AGENT_DRIVER_TOKEN');
  assert.equal(driver.turnExitCode('completed'), 0);
  assert.equal(driver.turnExitCode('aborted'), 130);
  assert.equal(driver.turnExitCode('error'), 1);
  assert.equal(driver.turnExitCode(null), 1);
  assert.equal(driver.turnExitCode(undefined), 1);
});

// ---------- TurnWaiter（Promise 形态） ----------

test('TurnWaiter：turn/start→timeout、turn/end→turn_end（退出码/原因）', async () => {
  const w = new driver.TurnWaiter();
  w.feed({ type: 'turn/start', seq: 1, data: { turn: 1 } });
  assert.equal(w.started, true);
  assert.equal(await w.wait(30), 'timeout');
  assert.equal(w.exitCode, null);
  w.feed({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(await w.wait(30), 'turn_end');
  assert.equal(w.exitCode, 0);
  assert.equal(w.turnReason, 'completed');
  assert.equal(await w.wait(0), 'turn_end', '结论保留（可重复读取）');
});

test('TurnWaiter：reason=null / 键缺失归一为 aborted（130），显式 error 不覆盖', async () => {
  const cases = [
    { data: { turn: 1, reason: null }, reason: 'aborted', code: 130 },
    { data: { turn: 1 }, reason: 'aborted', code: 130 },
    { data: { turn: 1, reason: { kind: 'error' } }, reason: 'error', code: 1 },
    { data: { turn: 1, reason: 'aborted' }, reason: 'aborted', code: 130 },
  ];
  for (const c of cases) {
    const w = new driver.TurnWaiter();
    w.feed({ type: 'turn/end', seq: 1, data: c.data });
    assert.equal(await w.wait(10), 'turn_end');
    assert.equal(w.turnReason, c.reason);
    assert.equal(w.exitCode, c.code);
  }
});

test('TurnWaiter：interaction consume-on-read + started；多次提问不空转', async () => {
  const w = new driver.TurnWaiter();
  const mark = { kind: 'question', call_id: 'c1', questions: [] };
  w.feed({ type: driver.INTERACTION, seq: null, data: { state: 'asked', interaction: mark } });
  assert.equal(w.started, true, '提问意味着 turn 已在跑');
  assert.equal(await w.wait(30), 'interaction');
  assert.equal(w.interaction, null, '读后清零');
  assert.equal(await w.wait(30), 'timeout');
  // 同一轮第二次提问
  w.feed({ type: driver.INTERACTION, seq: null, data: { state: 'asked', interaction: mark } });
  assert.equal(await w.wait(30), 'interaction');
  // resolved 态不产生挂起实况
  w.feed({ type: driver.INTERACTION, seq: null, data: { state: 'resolved', interaction: null } });
  assert.equal(await w.wait(30), 'timeout');
});

test('TurnWaiter：fail → error；链路错误优先于挂起交互', async () => {
  const w = new driver.TurnWaiter();
  w.fail('链路僵死');
  assert.equal(await w.wait(30), 'error');
  assert.equal(w.error, '链路僵死');
  const w2 = new driver.TurnWaiter();
  w2.feed({ type: driver.INTERACTION, seq: 1, data: { state: 'asked', interaction: { id: 'x' } } });
  w2.fail('事件流被对端关闭');
  assert.equal(await w2.wait(30), 'error', 'error 优先级高于 interaction');
});

test('TurnWaiter：阻塞式唤醒（不是轮询）+ 超时后状态保留可续等', async () => {
  const w = new driver.TurnWaiter();
  const pending = w.wait(5000);
  setTimeout(() => w.feed({ type: 'turn/end', seq: 1, data: { reason: { kind: 'aborted' } } }), 60);
  const started = Date.now();
  assert.equal(await pending, 'turn_end');
  assert.ok(Date.now() - started < 1000, '被 feed 立即唤醒');
  assert.equal(w.exitCode, 130);

  // 超时后 feed，再 wait 拿到结论（'timeout' 只是本地窗口到期）
  const w2 = new driver.TurnWaiter();
  assert.equal(await w2.wait(30), 'timeout');
  w2.feed({ type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } });
  assert.equal(await w2.wait(30), 'turn_end');
});

test('TurnWaiter：多等待者同轮唤醒，interaction 只被一个取走', async () => {
  const w = new driver.TurnWaiter();
  const a = w.wait(300);
  const b = w.wait(300);
  w.feed({ type: driver.INTERACTION, seq: 1, data: { state: 'asked', interaction: { id: 'q' } } });
  const results = [await a, await b].sort();
  assert.deepEqual(results, ['interaction', 'timeout'].sort(),
    '一个取走挂起交互、另一个继续等（consume-on-read）');
});

// ---------- SSE：stream / stateStream / feedInto ----------

test('stream：路径/查询串/收帧/lastSeq/stop 主动断开（stopped=true 不算异常）', async () => {
  await withDriver(async (drv) => {
    const seen = [];
    let enough = false;
    const result = await driver.stream('session-a', (f) => {
      seen.push(f.type);
      if (seen.length >= 3) enough = true;
    }, { since: 0, stop: () => enough });
    assert.deepEqual(seen, ['turn/start', 'assistant/message', 'turn/end']);
    assert.deepEqual(result, { frames: 3, lastSeq: 4, stopped: true });
    const call = drv.calls.find((c) => c.path.endsWith('/events'));
    assert.equal(call.method, 'GET');
    assert.deepEqual(call.query, { session_id: 'session-a', since: '0' });
    assert.equal(call.headers.accept, 'text/event-stream');
    assert.equal(call.headers['x-ts-driver-token'], TOKEN);
  });
});

test('stateStream：scope=state&since= 续传 + 同 stream 语义', async () => {
  await withDriver(async (drv) => {
    const seen = [];
    let enough = false;
    const result = await driver.stateStream((f) => {
      seen.push(f.type);
      if (seen.length >= 1) enough = true;
    }, { since: 1, stop: () => enough });
    assert.deepEqual(seen, ['turn/end'], 'since=1 ⇒ 只补发 seq>1 的帧');
    assert.equal(result.lastSeq, 3);
    assert.equal(result.stopped, true);
    const call = drv.calls.find((c) => c.path.endsWith('/events'));
    assert.deepEqual(call.query, { scope: 'state', since: '1' });
  });
});

test('stream：非 200 ⇒ DshDriverError(状态码)；空闲超时/对端关闭 ⇒ -2', async () => {
  await withDriver(async (drv) => {
    await assert.rejects(() => driver.stream('missing', () => {}), (e) => {
      assert.equal(e.code, 404);
      assert.match(e.message, /^事件流被拒: /);
      return true;
    });
    drv.eventsMode = 'silent';
    await assert.rejects(
      () => driver.stream('session-a', () => {}, { idleTimeoutMs: 120 }),
      (e) => e.code === -2 && /空闲超时/.test(e.message));
    drv.eventsMode = 'close';
    await assert.rejects(() => driver.stream('session-a', () => {}),
      (e) => e.code === -2 && /对端关闭/.test(e.message));
    drv.eventsMode = 'reject';
    await assert.rejects(() => driver.stateStream(() => {}),
      (e) => e.code === 500 && /事件流被拒/.test(e.message));
  });
});

test('feedInto：帧喂给 waiter；链路异常 ⇒ waiter.fail；主动 stop 不算异常', async () => {
  await withDriver(async (drv) => {
    drv.eventsMode = 'close';                  // 帧发完即关（链路异常路径）
    const w = new driver.TurnWaiter();
    const frames = [];
    const r = await driver.feedInto('session-a', 0, w, null, (f) => frames.push(f.type));
    assert.equal(w.error, '事件流被对端关闭', '未主动断开 ⇒ fail 上抛');
    assert.equal(await w.wait(30), 'turn_end', 'turn/end 先到 ⇒ 结论优先于链路错误');
    assert.deepEqual(frames, ['turn/start', 'assistant/message', 'turn/end']);
    assert.equal(r, null);

    // on_frame 抛异常不影响等待线程
    const w2 = new driver.TurnWaiter();
    await driver.feedInto('session-a', 0, w2, null, () => { throw new Error('落日志失败'); });
    assert.equal(await w2.wait(30), 'turn_end');
  });
});

test('feedInto：主动 stop 时不写 waiter.error；stop 可用 AbortSignal', async () => {
  await withDriver(async (drv) => {
    // 先喂完 turn/start 就停：用回调真值驱动 stop
    const w = new driver.TurnWaiter();
    const ctl = new AbortController();
    const p = driver.feedInto('session-a', 0, w, () => ctl.signal.aborted, null);
    setTimeout(() => ctl.abort(), 80);
    const r = await p;
    assert.equal(r.stopped, true);
    assert.equal(w.error, null, '主动断开不算链路异常');

    // AbortSignal 形态的 stop
    const w2 = new driver.TurnWaiter();
    const ctl2 = new AbortController();
    const p2 = driver.feedInto('session-a', 0, w2, ctl2.signal, null);
    setTimeout(() => ctl2.abort(), 60);
    const r2 = await p2;
    assert.equal(r2.stopped, true);
    assert.equal(w2.error, null);
  });
});

test('feedInto：stop 收「鸭子 {aborted}」对象（M6.5-R3 真缺陷回归钉）', async () => {
  // 现场（2026-10-14）：`consumeEvents` 曾用与 `stopProbe` 同一条松判据认定 AbortSignal，
  // 于是普通 `{aborted:false}` 被塞进 `fetch(..., {signal})` ⇒ `sse.js` 的
  // `signal.addEventListener('abort', …)` 抛 `signal.addEventListener is not a function`，
  // 整轮以「事件流异常」收口、轮次被判失败。修法＝新增 `isAbortSignal()`（要求
  // `addEventListener` 是函数）：鸭子对象只当**停止探针**，不再充当 fetch 的中断信号。
  await withDriver(async (drv) => {
    const w = new driver.TurnWaiter();
    const flag = { aborted: false };                 // 故意**不是** AbortSignal
    const p = driver.feedInto('session-a', 0, w, flag, null);
    setTimeout(() => { flag.aborted = true; }, 80);
    const r = await p;
    assert.equal(r.stopped, true, '鸭子 {aborted} 必须是有效的停止信号');
    assert.equal(w.error, null, '主动断开不算链路异常（尤其不许是 addEventListener 那条）');
  });
});

test('接口冻结：streamEvents/parseStreamLine/STOP_WATCH_INTERVAL_MS 从 dshdriver 再导出', () => {
  assert.equal(driver.streamEvents, sseStreamEvents, '再导出的是同一函数（不是包装）');
  assert.equal(driver.SseError, SseError, '错误类型也再导出（调用方只需 import dshdriver）');
  assert.equal(typeof driver.parseStreamLine, 'function');
  assert.equal(driver.parseStreamLine(': keepalive'), null);
  assert.deepEqual(driver.parseStreamLine('data: {"type":"turn/end"}'), { type: 'turn/end' });
  assert.deepEqual(driver.parseSseBlock('data: {"seq":1}\ndata: {"seq":2}\n: c'), [{ seq: 1 }, { seq: 2 }]);
  assert.equal(driver.sseUrl('http://h:1/x', '/events', { scope: 'state', since: 0 }),
    'http://h:1/x/events?scope=state&since=0');
  assert.equal(driver.STOP_WATCH_INTERVAL_MS, 250);
  assert.equal(typeof driver.stateStream, 'function');
  assert.equal(typeof driver.authHeaders, 'function');
  assert.equal(typeof driver.driverUrl, 'function');
  assert.equal(typeof driver.configured, 'function');
  assert.equal(typeof driver.liveSnapshot, 'function');
  assert.equal(typeof driver.status, 'function');
  assert.equal(typeof driver.archived, 'function');
});

test('request：内部口直接调用（方法/正文/错误码）——供 M4/M5 复用', async () => {
  await withDriver(async (drv) => {
    assert.deepEqual(await driver.request('GET', '/health'),
      { ok: true, live: 1, sessions: 2 });
    assert.equal(drv.last().method, 'GET');
    const resp = await driver.request('POST', '/session', { cwd: '/x', task: 't-1' });
    assert.equal(resp.session_id, 'session-new');
    assert.deepEqual(drv.last().body, { cwd: '/x', task: 't-1' });
    await assert.rejects(() => driver.request('GET', '/nope'),
      (e) => e.code === 404 && e.message === '未知驱动端点 /nope');
    await assert.rejects(() => driver.request('GET', '/health', null, 5000, () => {
      throw new TypeError('fetch failed');
    }), (e) => e.code === -2 && e.message === '驱动不可达: fetch failed');
  });
});
