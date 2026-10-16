/**
 * 写请求地基单测（M4.5）：`lib/http.js:readJsonBody` + `lib/access.js` + `routes/index.js`
 * 的三个新 ctx 口（`readBody` / `stateCache` / `sessionContext`）。
 *
 * 为什么这些边界必须逐条钉死：
 *   - `readJsonBody` 是**每个写端点的入口**，它的五种回落（空长度 / 非法 JSON / 非普通对象 /
 *     非法 UTF-8 / 短读）都是 Python `_read_json` 明写的语义，错一条就是整族端点的行为分叉；
 *   - `readBody` 的**记忆化**是「一个请求只读一次」这条不变量：不记忆化时第二次调用会挂死在
 *     已耗尽的流上（表现为请求永不返回，比报错更难查）；
 *   - `sessionContext` 的**无响应副作用**：它内部若借道 `ctx.ownedTask`（会回 404），会话族
 *     端点会二次响应 ⇒ `ERR_HTTP_HEADERS_SENT`；
 *   - 强制改密闸**在 GET 与 POST 两个方法上生效**（Python `do_GET`(1023)/`do_POST`(1040) 都调它，
 *     而 `do_PATCH`/`do_DELETE` 没有这道闸）——这条口径写进 `lib/access.js` 的文档，这里用单测
 *     把它钉住（判据本体是纯函数，server.js 只负责调用时机）。
 *     ⚠ 2026-10-14 订正：此处此前写的是「只在 POST」，与 `server.py` 不符；`server.js` 曾照做，
 *     导致持一次性口令的账号能 GET 全部读端点（M7-R3 车道实测，已在 server.js 修正）。
 *
 * 期望值来源：`server.py` 的 `_read_json`(5256) / `_must_change_pw_blocked`(5203) /
 * `_session_context`(4738) 逐行对照，不是读 Node 实现反推。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { MUST_CHANGE_PW_ALLOW, mustChangePwBlocked } from '../lib/access.js';
import { StateCache } from '../lib/casescan.js';
import { readJsonBody } from '../lib/http.js';
import { STATE_CACHE, makeContext } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/**
 * 造一个「像 IncomingMessage」的请求流。
 * @param {object} headers 请求头（键一律小写，Node 的 req.headers 就是这样）
 * @param {Buffer|string|Array} [body] 请求体（可给多段，模拟分块到达）
 * @param {{emitClose?: boolean}} [opts] `emitClose=false`：只发 data/end（不发 close），
 *   用来验证「end 就能收尾」这条路径不依赖 close
 */
function fakeReq(headers, body = '', { emitClose = true } = {}) {
  const chunks = body === '' ? [] : (Array.isArray(body) ? body : [body])
    .map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')));
  const stream = Readable.from(chunks, { objectMode: false });
  stream.headers = headers;
  if (!emitClose) stream.on('end', () => stream.removeAllListeners('close'));
  return stream;
}

/** 假 res：只用到 writeHead/end/destroy（与 `lib/http.js` 的实际调用面一致） */
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

/** 建临时库夹具 + 两组「用户 × 项目 × 任务」（用共享夹具的真 SQL，「造场景不 mock」） */
function setup() {
  const fx = freshDb('write-base');
  const now = '2026-10-12 00:00:00';
  // 种子已占 id=1（admin）：测试用户从 101 起，避免撞主键
  for (const [id, name] of [[101, 'alice'], [102, 'bob']]) {
    fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
      + ' VALUES (?,?,?,?,?,?)').run(id, name, 'x', '', 0, now);
  }
  const pAlice = insertProject(fx.db, { userId: 101, name: 'P-alice', workDir: fx.dir });
  const pBob = insertProject(fx.db, { userId: 102, name: 'P-bob', workDir: fx.dir });
  for (const [id, pid, name] of [[100, pAlice, 'T-alice'], [200, pBob, 'T-bob']]) {
    fx.db.prepare('INSERT INTO tasks(id, project_id, name, task_type, status, created_at)'
      + ' VALUES (?,?,?,?,?,?)').run(id, pid, name, 'normal', 'queued', now);
  }
  return { ...fx, pAlice, pBob };
}

// --------------------------------------------------------------------------
// readJsonBody —— Python `_read_json` 的五种回落
// --------------------------------------------------------------------------

test('readJsonBody：无 Content-Length ⇒ 空对象，不读流', async () => {
  const value = await readJsonBody(fakeReq({}, ''));
  assert.deepEqual(value, {});
});

test('readJsonBody：Content-Length=0 与空串头 ⇒ 空对象', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ 'content-length': '0' }, '')), {});
  assert.deepEqual(await readJsonBody(fakeReq({ 'content-length': '' }, '')), {});
});

test('readJsonBody：正常对象 ⇒ 原样返回（含中文与嵌套）', async () => {
  const text = JSON.stringify({ name: '任务', n: 1, nested: { a: [1, 2] } });
  const req = fakeReq({ 'content-length': String(Buffer.byteLength(text)) }, text);
  assert.deepEqual(await readJsonBody(req), { name: '任务', n: 1, nested: { a: [1, 2] } });
});

test('readJsonBody：非法 JSON ⇒ 空对象（不抛）', async () => {
  for (const text of ['{', 'not json', '{"a":}', '']) {
    const req = fakeReq({ 'content-length': String(Buffer.byteLength(text)) }, text);
    assert.deepEqual(await readJsonBody(req), {}, `输入 ${JSON.stringify(text)}`);
  }
});

test('readJsonBody：合法 JSON 但非普通对象 ⇒ 空对象（Python 注释：非 dict 会 AttributeError）', async () => {
  for (const text of ['[1,2]', '"str"', '42', 'true', 'false', 'null']) {
    const req = fakeReq({ 'content-length': String(text.length) }, text);
    assert.deepEqual(await readJsonBody(req), {}, `输入 ${text}`);
  }
});

test('readJsonBody：非法 UTF-8 字节 ⇒ 空对象（严格解码；buf.toString 会静默替换成分叉）', async () => {
  // `{"a":"<0xff>"}`：宽松解码会变成 `{"a":"\uFFFD"}` 并解析成功 —— Python 是 UnicodeDecodeError ⇒ {}
  const raw = Buffer.concat([
    Buffer.from('{"a":"', 'utf8'), Buffer.from([0xff]), Buffer.from('"}', 'utf8'),
  ]);
  const req = fakeReq({ 'content-length': String(raw.length) }, raw);
  assert.deepEqual(await readJsonBody(req), {});
});

test('readJsonBody：只读 Content-Length 字节（多余的留给下一个请求）', async () => {
  const body = Buffer.from('{"a":1}EXTRA', 'utf8');
  const req = fakeReq({ 'content-length': '7' }, body);
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('readJsonBody：短读（客户端提前断开）⇒ 按已读内容解析', async () => {
  const req = fakeReq({ 'content-length': '100' }, '{"a":1}');
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('readJsonBody：非数字 Content-Length ⇒ 抛错（Python int() 抛 ValueError ⇒ 该连接无响应）', async () => {
  await assert.rejects(() => readJsonBody(fakeReq({ 'content-length': 'abc' }, '')), /invalid literal/);
  await assert.rejects(() => readJsonBody(fakeReq({ 'content-length': '12px' }, '')), /invalid literal/);
  await assert.rejects(() => readJsonBody(fakeReq({ 'content-length': '-1x' }, '')), /invalid literal/);
});

test('readJsonBody：Python int() 的宽容面（前后空白、正号、下划线分隔）照收', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ 'content-length': ' 7 ' }, '{"a":1}')), { a: 1 });
  assert.deepEqual(await readJsonBody(fakeReq({ 'content-length': '+7' }, '{"a":1}')), { a: 1 });
  // int("1_0") == 10 —— 只有 7 字节可读，按短读解析
  assert.deepEqual(await readJsonBody(fakeReq({ 'content-length': '1_0' }, '{"a":1}')), { a: 1 });
});

test('readJsonBody：分块到达（多段 data）也要拼全', async () => {
  const parts = ['{"a"', ':1,"b"', ':"x"}'];
  const total = parts.reduce((n, p) => n + Buffer.byteLength(p), 0);
  const req = fakeReq({ 'content-length': String(total) }, parts);
  assert.deepEqual(await readJsonBody(req), { a: 1, b: 'x' });
});

test('readJsonBody：不发 close 事件（只有 end）也能收尾', async () => {
  const req = fakeReq({ 'content-length': '7' }, '{"a":1}', { emitClose: false });
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

// --------------------------------------------------------------------------
// ctx.readBody / ctx.stateCache / ctx.sessionContext
// --------------------------------------------------------------------------

test('ctx.readBody：记忆化——两次调用同一对象，且只读一次流', async () => {
  const fx = setup();
  try {
    let reads = 0;
    const req = fakeReq({ 'content-length': '7' }, '{"a":1}');
    req.on('data', () => { reads += 1; });
    const { res } = fakeRes();
    const ctx = makeContext({
      req, res, db: fx.db, user: { id: 101 }, path: '/x', search: '',
    });
    const p1 = ctx.readBody();
    const p2 = ctx.readBody();
    assert.equal(p1, p2, '两次调用必须返回同一个 promise');
    const v1 = await p1;
    const v2 = await p2;
    assert.equal(v1, v2, '解析结果必须是同一个对象');
    assert.deepEqual(v1, { a: 1 });
    assert.equal(reads, 1);
  } finally {
    fx.close();
  }
});

test('ctx.readBody：抛错也要记忆化（同一请求重复调用得到同一失败）', async () => {
  const fx = setup();
  try {
    const { res } = fakeRes();
    const ctx = makeContext({
      req: fakeReq({ 'content-length': 'x' }, ''), res, db: fx.db, user: { id: 101 },
      path: '/x', search: '',
    });
    const p1 = ctx.readBody();
    assert.equal(ctx.readBody(), p1);
    await assert.rejects(() => p1, /invalid literal/);
  } finally {
    fx.close();
  }
});

test('ctx.stateCache：缺省 = 全进程单例；显式传入可覆盖（server.js 走这条）', () => {
  const fx = setup();
  try {
    const { res } = fakeRes();
    const base = { res, db: fx.db, user: { id: 101 }, path: '/x', search: '' };
    const ctx1 = makeContext({ ...base, req: fakeReq({}, '') });
    assert.equal(ctx1.stateCache, STATE_CACHE);
    const mine = new StateCache();
    const ctx2 = makeContext({ ...base, req: fakeReq({}, ''), stateCache: mine });
    assert.equal(ctx2.stateCache, mine);
  } finally {
    fx.close();
  }
});

test('ctx.sessionContext：本人任务 ⇒ 三件套齐全，family 回落 dsh_plugin', () => {
  const fx = setup();
  try {
    const { res, cap } = fakeRes();
    const ctx = makeContext({
      req: fakeReq({}, ''), res, db: fx.db, user: { id: 101 }, path: '/x', search: '',
    });
    const got = ctx.sessionContext(100);
    assert.equal(got.task.id, 100);
    assert.equal(got.project.id, fx.pAlice);
    assert.equal(got.family, 'dsh_plugin');
    assert.equal(cap.status, null, 'sessionContext 不许有响应副作用');
  } finally {
    fx.close();
  }
});

test('ctx.sessionContext：任务不存在 / 他人项目 ⇒ 三空，且**不发响应**（避免二次 writeHead）', () => {
  const fx = setup();
  try {
    const { res, cap } = fakeRes();
    const ctx = makeContext({
      req: fakeReq({}, ''), res, db: fx.db, user: { id: 101 }, path: '/x', search: '',
    });
    assert.deepEqual(ctx.sessionContext(999), { task: null, project: null, family: null });
    assert.deepEqual(ctx.sessionContext(200), { task: null, project: null, family: null });
    assert.equal(cap.status, null, '不许回 404（那是调用方的事）');
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// mustChangePwBlocked —— 强制改密闸（Python `_must_change_pw_blocked`）
// --------------------------------------------------------------------------

test('强制改密闸：must_change_pw 为假 / user 为空 ⇒ 放行（401 由更早的检查发）', () => {
  assert.equal(mustChangePwBlocked(null, '/api/tasks/1/stop'), false);
  assert.equal(mustChangePwBlocked(undefined, '/api/tasks/1/stop'), false);
  assert.equal(mustChangePwBlocked({ must_change_pw: 0 }, '/api/tasks/1/stop'), false);
  assert.equal(mustChangePwBlocked({ must_change_pw: false }, '/api/tasks/1/stop'), false);
});

test('强制改密闸：持一次性口令 + 非信任头 + 白名单外 ⇒拦；白名单三端点放行', () => {
  const user = { must_change_pw: 1 };
  assert.equal(mustChangePwBlocked(user, '/api/tasks/1/stop'), true);
  assert.equal(mustChangePwBlocked(user, '/api/projects/1/tasks'), true);
  for (const p of MUST_CHANGE_PW_ALLOW) {
    assert.equal(mustChangePwBlocked(user, p), false, p);
  }
  // 白名单是**精确路径**比较（Python `path in MUST_CHANGE_PW_ALLOW`），不是前缀
  assert.equal(mustChangePwBlocked(user, '/api/auth/me/extra'), true);
  assert.equal(mustChangePwBlocked(user, '/api/auth/logout/'), true);
});

test('强制改密闸：免登信任头整体跳过（插件形态死锁修复口径）', () => {
  assert.equal(mustChangePwBlocked({ must_change_pw: 1 }, '/api/tasks/1/stop', { trusted: true }),
    false);
});
