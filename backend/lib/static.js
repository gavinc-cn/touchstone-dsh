/**
 * 静态托管 + SPA 全路由回退（Node 后端的 `server.py:_serve_static()` / `_send_file()`）。
 *
 * 为什么逐条对齐 Python：前端 `webui/dist-plugin` 两版共用同一份产物，它是契约测试本身
 * （方案 §3.5）——静态语义差一点，SPA 的深链、资源 404 与 MIME 就会在 Node 版下变异。
 * 语义（照抄 Python）：
 *   ① 空相对路径 ⇒ index.html；
 *   ② normpath 后逃出 WEB_DIR ⇒ 403 `forbidden`（text/plain）；
 *   ③ 目录**或文件不存在** ⇒ 回退 index.html（这就是 SPA 回退，`/app`、`/haha.js` 都走它）；
 *   ④ 扩展名 → MIME 表（未知 = application/octet-stream）；⑤ 读不到文件 ⇒ 404 `not found`。
 * 路径不做百分号解码：Python 侧 `self.path` 也不解码，`%2e%2e` 在两个实现里同样不构成越界。
 */
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { respond } from './http.js';

/** 扩展名 → MIME。表抄自 `server.py:_serve_static()`。 */
export function mimeFor(ext) {
  const table = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };
  return table[String(ext).toLowerCase()] || 'application/octet-stream';
}

/**
 * 静态路径解析（`_serve_static` 的解析段，不含 IO）。
 * 返回 `{ forbidden: true }` 或 `{ file, contentType }`。
 * 用同步 stat 是有意的：解析段要在路由分派里同步决定「转发给静态还是回退」，
 * 一次本地 stat 的代价远小于把它拆成异步状态机。
 */
export function resolveStaticPath(webDir, urlPath) {
  const base = path.resolve(webDir);
  const rel = String(urlPath || '').replace(/^\/+/, '') || 'index.html';
  const full = path.normalize(path.join(base, rel));
  if (full !== base && !full.startsWith(base + path.sep)) return { forbidden: true };
  const index = path.join(base, 'index.html');
  let target = full;
  try {
    if (!statSync(full).isFile()) target = index;
  } catch {
    target = index;
  }
  return { file: target, contentType: mimeFor(path.extname(target)) };
}

/**
 * 服务一个静态请求：越界 → 403，命中 → 200 + MIME，解析到的目标读不到 → 404。
 * （`_send_file` 的 OSError 分支＝文件在解析与读取之间消失，Node 侧同样兜住。）
 */
export async function serveStatic(res, webDir, urlPath) {
  const resolved = resolveStaticPath(webDir, urlPath);
  if (resolved.forbidden) {
    respond(res, 403, 'forbidden', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const data = await readFile(resolved.file);
    respond(res, 200, data, resolved.contentType);
  } catch {
    respond(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

/** WEB_DIR 是否就绪（index.html 在不在）：启动期校验，别把错误留到首个请求 */
export async function webDirReady(webDir) {
  try {
    return (await stat(path.join(webDir, 'index.html'))).isFile();
  } catch {
    return false;
  }
}
