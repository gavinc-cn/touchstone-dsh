/**
 * 薄壳「子进程输出落盘 + 跨 chunk 行解析」自检（不经 dsh）。
 *
 * 用法: node scripts/dev-check-shell-stdout.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 背景（2026-10-08 缺陷定位）：插件形态下 server.py 的 stdout 只有薄壳一个消费者。
 * 旧实现只解析 `TOUCHSTONE_LISTEN`，其余 stdout 行**既不转发也不落盘**——首启随机
 * 一次性口令横幅恰好在这些行里（口令只打印一次、内存读后即清），于是插件形态首装
 * 必然拿不到口令，再撞上「首次登录强制改密」门就是死锁；`[board]`/`[waitq]`/
 * `[runner]` 等运行诊断也一并不可见。同一处理器还没有跨 chunk 行缓冲——marker 被
 * 管道切开就永远解析不到端口，面板固定 503。
 *
 * 本 harness 用假 server.py（node 脚本：打印真实横幅文案 + stderr 诊断 + 真起一个
 * HTTP 上游并在端口就绪后**分两段**写 marker）把三件事钉死：
 *   ① stdout / stderr 全部逐行落 <库目录>/plugin-backend.log（0600）；
 *   ② marker 仍被解析——经注册的 `/touchstone` 反代 handler 真取到上游响应体；
 *   ③ 行缓冲跨 chunk（marker 故意分两次 write）。
 * 另有一条「日志目录不可写时绝不阻断启动」的兜底场景（写失败退 logger.warn）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { apply } from '../lib/index.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

const PW = 'BANNER-PW-9f3';
const BANNER = `  （首次启动已创建默认账号 admin，一次性初始口令：${PW}，首次登录须修改；仅本次显示，请立即记录）`;

/** 假 server.py：打印横幅/诊断到两个流，真起 HTTP 上游，marker 分两段写。 */
function fakeServerSource() {
  return [
    "const http = require('http');",
    `process.stdout.write('Touchstone 站点已启动，监听 127.0.0.1:0${BANNER}\\n');`,
    "process.stdout.write('访问: http://127.0.0.1:0/\\n');",
    "process.stdout.write('数据库: ' + (process.env.TOUCHSTONE_DB || '?') + '\\n');",
    "process.stdout.write('PASSWORDLESS=' + (process.env.TS_ADMIN_PASSWORDLESS || '') + '\\n');",
    "process.stderr.write('STDERR-DIAG-LINE\\n');",
    "const srv = http.createServer((req, res) => {",
    "  res.writeHead(200, { 'content-type': 'text/plain' });",
    "  res.end('PROXY-OK');",
    "});",
    "srv.listen(0, '127.0.0.1', () => {",
    "  const port = srv.address().port;",
    "  process.stdout.write('TOUCHSTONE_LIS');",              // 故意切开：前半段
    "  setTimeout(() => process.stdout.write('TEN ' + port + '\\n'), 120);",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
    '',
  ].join('\n');
}

function makeFakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shell-stdout-'));
  fs.writeFileSync(path.join(dir, 'server.py'), fakeServerSource());
  return dir;
}

/** 桩 webServer：只保留注册表（本档只需拿到反代 handler）。 */
function makeWebServer() {
  const prefixes = new Map();
  return {
    port: 45999,
    register(route) {
      prefixes.set(route.path, route);
      return () => { prefixes.delete(route.path); };
    },
    handler: (p) => prefixes.get(p) && prefixes.get(p).handler,
  };
}

/** 桩 ctx：logger 记录到数组（不打印），loader 恒「在挂载中」（行 fiber 与 ctx 同源，
 *  否则 2s 掉线自检会把壳自己停掉，反代 handler 随之消失）。 */
function makeCtx(webServer, logs) {
  const fiber = { stub: true };
  return {
    fiber,
    logger: () => ({
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
    }),
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'loader') return { entries: () => [{ id: 'include:touchstone', fiber }] };
      return undefined;
    },
    inject(names, callback) {
      if (callback && names.includes('agents')) {
        callback({ on: () => () => {}, agents: { get: () => null } });
      }
      return { dispose() {} };
    },
  };
}

async function waitFor(predicate, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/** 走注册在 /touchstone 上的反代 handler 发一次 GET，返回 { status, body }。 */
async function callProxy(handler, url = '/touchstone/api/projects') {
  const req = Readable.from([]);
  req.url = url;
  req.method = 'GET';
  req.headers = {};
  let status = 0;
  let body = '';
  const res = new Writable({ write(chunk, _enc, cb) { body += String(chunk); cb(); } });
  res.writeHead = (code) => { status = code; return res; };
  handler(req, res);
  await Promise.race([
    new Promise((resolve) => res.on('finish', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  return { status, body };
}

async function scenario(name, extraEnv) {
  console.log(`\n== ${name} ==`);
  const repoDir = makeFakeRepo();
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shell-db-'));
  const dbPath = path.join(libDir, 'touchstone.db');
  const logPath = path.join(libDir, 'plugin-backend.log');
  const webServer = makeWebServer();
  const logs = [];
  const ctx = makeCtx(webServer, logs);
  let dispose = null;
  try {
    dispose = await apply(ctx, {
      repoDir, pythonPath: process.execPath,
      extraEnv: { ...extraEnv, TOUCHSTONE_DB: extraEnv.TOUCHSTONE_DB || dbPath },
    });
    const readLog = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } };
    await waitFor(() => readLog().includes('TOUCHSTONE_LISTEN '));
    return { readLog, logPath, webServer, logs, dispose, cleanup: () => {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(libDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    } };
  } catch (error) {
    console.log(`  ✗ apply 抛错: ${error && error.message}`);
    failures++;
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(libDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return null;
  }
}

async function main() {
  console.log('== 薄壳 stdout/stderr 落盘 + 跨 chunk marker 解析自检 ==');

  // ---- 场景 1：默认库目录，输出应全部落 plugin-backend.log ----
  const s1 = await scenario('场景 1：输出落盘 + marker 跨 chunk', {});
  if (s1) {
    const text = s1.readLog();
    check('plugin-backend.log 已生成', fs.existsSync(s1.logPath), s1.logPath);
    check('首启一次性口令横幅已落盘（修复前被丢弃）', text.includes(`一次性初始口令：${PW}`),
      JSON.stringify(text.slice(0, 200)));
    check('「访问:」行已落盘', text.includes('访问: http://127.0.0.1:0/'));
    check('「数据库:」行已落盘', text.includes('数据库: ' + path.join(path.dirname(s1.logPath), 'touchstone.db')));
    check('stderr 诊断行已落盘', text.includes('STDERR-DIAG-LINE'));
    check('TS_ADMIN_PASSWORDLESS=1 已下发给子进程（插件形态默认空口令 admin）',
      text.includes('PASSWORDLESS=1'), JSON.stringify(text.match(/PASSWORDLESS=\S*/g)));
    if (process.platform !== 'win32') {
      const mode = fs.existsSync(s1.logPath) ? (fs.statSync(s1.logPath).mode & 0o777) : 0;
      check('日志文件权限 0600', mode === 0o600, mode.toString(8));
    }
    const handler = s1.webServer.handler('/touchstone');
    const out = handler ? await callProxy(handler) : { status: 0, body: '' };
    check('marker 跨 chunk 仍被解析（反代真取到上游）',
      out.status === 200 && out.body === 'PROXY-OK',
      JSON.stringify({ handler: typeof handler, status: out.status, body: out.body.slice(0, 120) }));
    try { await s1.dispose(); } catch { /* 忽略 */ }
    s1.cleanup();
  }

  // ---- 场景 2：日志目录不可写时绝不阻断启动（退 logger.warn） ----
  // 用「目录位置放一个普通文件」构造 ENOTDIR（mkdir 立即失败）；不用 /proc 这类
  // 病态路径——Node 的 mkdirSync({recursive:true}) 在 procfs 上会挂死（实测）。
  const blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shell-block-'));
  fs.writeFileSync(path.join(blockerDir, 'blocker'), 'x');
  const s2 = await scenario('场景 2：日志不可写时降级不阻断',
    { TOUCHSTONE_DB: path.join(blockerDir, 'blocker', 'sub', 'touchstone.db') });
  if (s2) {
    const handler = s2.webServer.handler('/touchstone');
    const out = handler ? await callProxy(handler) : { status: 0, body: '' };
    check('日志不可写仍拉起后端并解析 marker', out.status === 200 && out.body === 'PROXY-OK',
      JSON.stringify({ status: out.status, body: out.body.slice(0, 120) }));
    check('降级时给出 warn 提示',
      s2.logs.some(([lv, m]) => lv === 'warn' && /日志/.test(m)),
      JSON.stringify(s2.logs.slice(0, 6)));
    try { await s2.dispose(); } catch { /* 忽略 */ }
    s2.cleanup();
  }
  try { fs.rmSync(blockerDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('harness error:', error);
  process.exit(1);
});
