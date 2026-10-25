/**
 * Task 3（KB-02）：RAG 测试连接 / Jira 残余 JSON 错误路径 + `sendNow` 死键边界
 * （Node 侧；与 `tests/test_i18n_rag_jira.py` 逐条镜像）。
 *
 * 覆盖：
 *   ① RAG：`test_connection(cfg, 'en')` 的三条固定错误（字段不全 + `_cfg_int` 两键）、
 *      `_post_embeddings` 三条固定错误（缺 data / 条数不符 / 超时）；动态异常不翻；
 *   ② Jira：`jiraMyself` / `jiraImport` 两条固定错误；`HTTP {status}: …` 动态不翻；
 *   ③ 端点级（真路由表 + makeContext）：`POST /api/admin/rag/test` 与
 *      `POST .../board/jira/*` 带 `x-ts-lang: en` 时 200/400 body 英文；无头（zh）
 *      响应逐字节等于改前 golden；
 *   ④ `sendNow` 死键：`i18n/en.json` 不再含 `…：{family}` 键，throw 仍中文
 *      （Ruling R-A5：删键，不接线）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as board from '../lib/board.js';
import * as chat from '../lib/chat.js';
import * as rag from '../lib/rag.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --------------------------------------------------------------------------
// 路由测试台（与 board-write-route-m5c.test.mjs 同款最小版）
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

function fakeReq(method, body, headers = {}) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = text.length
    ? { 'content-length': String(text.length), ...headers }
    : { ...headers };
  stream.method = method;
  return stream;
}

function setup(tag) {
  const fx = freshDb(`i18n-rag-jira-${tag}`);
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir,
  });
  const adminRow = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, pid, adminRow };
}

async function call(env, method, target, { body, headers = {} } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body, headers),
    res,
    db: env.db,
    user: env.adminRow,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  return {
    hit,
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

/** 起一个只回固定 body 的假 embeddings 服务；`requests` 暴露请求数（钉重试次数）。 */
async function startEmbedServer(payload) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --------------------------------------------------------------------------
// ① RAG：固定错误 en / zh golden
// --------------------------------------------------------------------------

test('RAG 固定错误：zh 逐字旧串；en 走共享词条', async () => {
  const cfg = { api_base: 'http://x/v1', api_key: 'k', model: 'm' };
  // zh golden（实现前实测旧串）
  assert.deepEqual(await rag.test_connection({}),
    { ok: false, error: 'api_base / model / api_key 尚未填写完整' });
  assert.deepEqual(await rag.test_connection({ ...cfg, timeout_s: 'x' }),
    { ok: false, error: 'timeout_s 须为正整数' });
  assert.deepEqual(await rag.test_connection({ ...cfg, timeout_s: 0 }),
    { ok: false, error: 'timeout_s 须在 1~300 之间' });
  // en
  assert.deepEqual(await rag.test_connection({}, 'en'),
    { ok: false, error: 'api_base / model / api_key are incomplete' });
  assert.deepEqual(await rag.test_connection({ ...cfg, timeout_s: 'x' }, 'en'),
    { ok: false, error: 'timeout_s must be a positive integer' });
  assert.deepEqual(await rag.test_connection({ ...cfg, timeout_s: 0 }, 'en'),
    { ok: false, error: 'timeout_s must be between 1 and 300' });
});

test('RAG `_cfg_int` 透传 lang：两条已有键同 key+vars 载体', () => {
  assert.throws(() => rag._cfg_int('x', 30, 300, 'timeout_s'),
    (err) => err.message === 'timeout_s 须为正整数'
      && err.i18nKey === '{name} 须为正整数'
      && err.i18nVars.name === 'timeout_s');
  assert.throws(() => rag._cfg_int('x', 30, 300, 'timeout_s', 'en'),
    (err) => err.message === 'timeout_s must be a positive integer'
      && err.i18nKey === '{name} 须为正整数');
  assert.throws(() => rag._cfg_int(999, 30, 300, 'timeout_s', 'en'),
    (err) => err.message === 'timeout_s must be between 1 and 300'
      && err.i18nKey === '{name} 须在 1~{upper} 之间');
  assert.throws(() => rag._cfg_int(0, 30, 300, 'timeout_s'),
    (err) => err.message === 'timeout_s 须在 1~300 之间');
});

test('RAG embeddings 三条固定错误：en 渲染；动态异常原样', async () => {
  const base = { api_key: 'k', model: 'm' };

  const missing = await startEmbedServer({ data: 'oops' });
  try {
    assert.deepEqual(await rag.test_connection({ ...base, api_base: missing.url }),
      { ok: false, error: 'embeddings 响应缺 data' });
    assert.deepEqual(await rag.test_connection({ ...base, api_base: missing.url }, 'en'),
      { ok: false, error: 'embeddings response is missing data' });
    assert.equal(missing.requests.length, 4, '两次调用各重试 1 次（2 请求/调用）');
  } finally {
    await missing.close();
  }

  const mismatch = await startEmbedServer({ data: [] });
  try {
    assert.deepEqual(await rag.test_connection({ ...base, api_base: mismatch.url }, 'en'),
      { ok: false, error: 'embeddings response item count mismatch' });
  } finally {
    await mismatch.close();
  }

  const hang = http.createServer((req) => { req.resume(); /* 故意不回 */ });
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  try {
    const out = await rag.test_connection({
      ...base,
      api_base: `http://127.0.0.1:${hang.address().port}/v1`,
      timeout_s: 1,
    }, 'en');
    assert.deepEqual(out, { ok: false, error: 'embeddings request timed out' });
  } finally {
    hang.closeAllConnections?.();
    await new Promise((resolve) => hang.close(resolve));
  }

  // 动态异常（HTTP 原文）不翻
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(503); res.end('down'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const out2 = await rag.test_connection({
      ...base, api_base: `http://127.0.0.1:${server.address().port}/v1`,
    }, 'en');
    assert.equal(out2.ok, false);
    assert.match(out2.error, /HTTP Error 503/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/admin/rag/test：en body 英文；无头 zh 与旧字节相同', async () => {
  const env = setup('rag');
  try {
    const body = { api_base: '', model: '' };
    const zh = await call(env, 'POST', '/api/admin/rag/test', { body });
    assert.equal(zh.status, 200);
    // zh golden（改前抓取）：json.dumps 带空格；键序 ok→error
    assert.equal(zh.text(),
      '{"ok": false, "error": "api_base / model / api_key 尚未填写完整"}');
    const en = await call(env, 'POST', '/api/admin/rag/test',
      { body, headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 200);
    assert.equal(en.text(),
      '{"ok": false, "error": "api_base / model / api_key are incomplete"}');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ② Jira：固定错误 en / zh golden + 端点级
// --------------------------------------------------------------------------

test('Jira 固定错误：zh 逐字旧串；en 走共享词条', async () => {
  assert.deepEqual(await board.jiraMyself({}),
    { ok: false, error: '请填全 Jira 地址 / 用户名 / token' });
  assert.deepEqual(await board.jiraMyself({}, 'en'),
    { ok: false, error: 'Fill in the Jira URL, username, and token' });

  const fx = freshDb('i18n-jira-lib');
  try {
    const pid = insertProject(fx.db, { userId: 1, name: 'jira', projectDir: fx.dir });
    assert.deepEqual(await board.jiraImport(pid, 'zh', { db: fx.db }),
      { ok: false, error: '请先在设置中配置 Jira' });
    assert.deepEqual(await board.jiraImport(pid, 'en', { db: fx.db }),
      { ok: false, error: 'Configure Jira in settings first' });
  } finally {
    fx.close();
  }
});

test('POST .../board/jira/*：en 400 body 英文；无头 zh 与旧字节相同', async () => {
  const env = setup('jira');
  try {
    const testPath = `/api/projects/${env.pid}/board/jira/test`;
    const body = { url: 'https://jira.example.com' };
    const zh = await call(env, 'POST', testPath, { body });
    assert.equal(zh.status, 400);
    assert.equal(zh.text(),
      '{"ok": false, "error": "请填全 Jira 地址 / 用户名 / token"}');
    const en = await call(env, 'POST', testPath,
      { body, headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 400);
    assert.equal(en.text(),
      '{"ok": false, "error": "Fill in the Jira URL, username, and token"}');

    const importPath = `/api/projects/${env.pid}/board/jira/import`;
    const zhImport = await call(env, 'POST', importPath, { body: {} });
    assert.equal(zhImport.status, 400);
    assert.equal(zhImport.text(),
      '{"ok": false, "error": "请先在设置中配置 Jira"}');
    const enImport = await call(env, 'POST', importPath,
      { body: {}, headers: { 'x-ts-lang': 'en' } });
    assert.equal(enImport.status, 400);
    assert.equal(enImport.text(),
      '{"ok": false, "error": "Configure Jira in settings first"}');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ③ sendNow 死键（Ruling R-A5）
// --------------------------------------------------------------------------

const DEAD_KEY = '该智能体族已下线，请在项目设置里改绑 dsh 插件：{family}';
const FROZEN_MSG = '该智能体族已下线，请在项目设置里改绑 dsh 插件';
const FROZEN_NOTE = '单族世界该分支不可达；中文为冻结诊断（无请求语言通道，'
  + 'chat_msgs 无 lang 列），不接词表';

test('sendNow 死键已删，throw 仍为冻结中文', async () => {
  const dict = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'i18n', 'en.json'), 'utf8'));
  assert.equal(Object.hasOwn(dict.api, DEAD_KEY), false,
    'en.json 的 sendNow 死键应已删除（R-A5）');
  assert.equal(dict.api[FROZEN_MSG],
    'This agent family has been retired; rebind the dsh plugin in project settings');

  await assert.rejects(
    () => chat.sendNow(null, null, '', 'sid', 'msg', false),
    (err) => err instanceof Error && err.message === `${FROZEN_MSG}：未知`,
  );
  const src = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'lib', 'chat.js'), 'utf8');
  assert.ok(src.includes(FROZEN_NOTE), 'Node 侧 throw 旁应留冻结诊断注释');
});
