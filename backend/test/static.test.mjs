/**
 * backend/lib/static.js + backend/lib/http.js 的语义测试（node --test，零依赖）。
 *
 * 为什么逐条对齐 Python：静态托管 + SPA 全路由回退是前端契约的一部分（方案 §3.5），
 * 期望值全部抄自 `server.py` 的 `_serve_static()` / `_send_file()` / `_respond()`：
 *   ① 空相对路径 ⇒ index.html；② 目录或文件不存在 ⇒ 回退 index.html（这就是 SPA 回退）；
 *   ③ normpath 后逃出 WEB_DIR ⇒ 403 `forbidden`（text/plain）；④ 扩展名 → MIME 表，
 *   未知扩展 = application/octet-stream；⑤ 每个响应都带 Cache-Control: no-store。
 * 注意 ③ 走**未解码**的原始路径（Python 侧 self.path 也不解码），故 `%2e%2e` 不构成越界。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { mimeFor } from '../lib/static.js';
import { respond } from '../lib/http.js';

/** 造一个临时 WEB_DIR：index.html + 一个 js + 一个未知扩展文件 + 一个子目录 */
function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id=root></div>\n');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(dir, 'assets', 'style.css'), 'body{}\n');
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  fs.mkdirSync(path.join(dir, 'sub'));
  return dir;
}

/** 最小响应桩：记录状态码/头/正文，够 respond() 用 */
function makeRes() {
  const seen = { status: 0, headers: {}, body: null };
  return {
    seen,
    writeHead(status, headers) { seen.status = status; seen.headers = { ...headers }; },
    end(body) { seen.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

test('扩展名 → MIME 与 Python 表逐项一致，未知扩展 = octet-stream', () => {
  assert.equal(mimeFor('.html'), 'text/html; charset=utf-8');
  assert.equal(mimeFor('.js'), 'application/javascript; charset=utf-8');
  assert.equal(mimeFor('.mjs'), 'application/javascript; charset=utf-8');
  assert.equal(mimeFor('.css'), 'text/css; charset=utf-8');
  assert.equal(mimeFor('.svg'), 'image/svg+xml');
  assert.equal(mimeFor('.png'), 'image/png');
  assert.equal(mimeFor('.ico'), 'image/x-icon');
  assert.equal(mimeFor('.woff2'), 'font/woff2');
  assert.equal(mimeFor('.json'), 'application/json; charset=utf-8');
  assert.equal(mimeFor('.map'), 'application/json; charset=utf-8');
  assert.equal(mimeFor('.bin'), 'application/octet-stream');
  assert.equal(mimeFor(''), 'application/octet-stream');
  assert.equal(mimeFor('.JS'), 'application/javascript; charset=utf-8');
});

test('回应统一带 Content-Length 与 Cache-Control: no-store（对齐 _respond）', () => {
  const res = makeRes();
  respond(res, 200, Buffer.from('中文'), 'text/plain; charset=utf-8');
  assert.equal(res.seen.status, 200);
  assert.equal(res.seen.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(res.seen.headers['Content-Length'], String(Buffer.byteLength('中文')));
  assert.equal(res.seen.headers['Cache-Control'], 'no-store');
  assert.equal(res.seen.body.toString('utf8'), '中文');
});

test('静态解析：空路径/目录/不存在 ⇒ index.html；越界 ⇒ forbidden；命中 ⇒ 该文件与 MIME', async () => {
  const webDir = makeWebDir();
  const { resolveStaticPath } = await import('../lib/static.js');
  const index = path.join(webDir, 'index.html');

  assert.deepEqual(resolveStaticPath(webDir, '/'),
    { file: index, contentType: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveStaticPath(webDir, '/assets'),
    { file: index, contentType: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveStaticPath(webDir, '/app'),
    { file: index, contentType: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveStaticPath(webDir, '/haha.js'),
    { file: index, contentType: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveStaticPath(webDir, '/assets/index-abc.js'),
    { file: path.join(webDir, 'assets/index-abc.js'), contentType: 'application/javascript; charset=utf-8' });
  // 未解码的原始路径不构成越界（Python 的 self.path 同样不解码）⇒ 回退 index.html
  assert.deepEqual(resolveStaticPath(webDir, '/%2e%2e/etc/passwd'),
    { file: index, contentType: 'text/html; charset=utf-8' });
  // 真 `..` 段 ⇒ 越界
  assert.deepEqual(resolveStaticPath(webDir, '/../etc/passwd'), { forbidden: true });
});

test('serveStatic：命中文件 200、越界 403 forbidden、index.html 缺失 404 not found', async () => {
  const webDir = makeWebDir();
  const { serveStatic } = await import('../lib/static.js');

  const ok = makeRes();
  await serveStatic(ok, webDir, '/assets/index-abc.js');
  assert.equal(ok.seen.status, 200);
  assert.equal(ok.seen.headers['Content-Type'], 'application/javascript; charset=utf-8');
  assert.equal(ok.seen.body.toString('utf8'), 'console.log(1)\n');

  const bad = makeRes();
  await serveStatic(bad, webDir, '/../etc/passwd');
  assert.equal(bad.seen.status, 403);
  assert.equal(bad.seen.body.toString('utf8'), 'forbidden');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-static-empty-'));
  const missing = makeRes();
  await serveStatic(missing, empty, '/app');
  assert.equal(missing.seen.status, 404);
  assert.equal(missing.seen.body.toString('utf8'), 'not found');
  assert.equal(missing.seen.headers['Content-Type'], 'text/plain; charset=utf-8');
});
