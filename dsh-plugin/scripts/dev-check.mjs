/**
 * 薄壳自检（不经 dsh）: 桩 ctx 调 apply, 自建临时 HTTP 服务把 /touchstone/* 分派给
 * 已注册 handler, 走真实 server.py（--port 0 + 信任头 + dist-plugin）验证全链路:
 *   1) banner 端口解析  2) /touchstone/api/auth/me 免登返回 admin  3) /touchstone/ 含插件版资源
 * 用法: node scripts/dev-check.mjs <repoDir> [pythonPath]
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

/** 本次自检的隔离库（跑完删掉 db/lock/pid 三件） */
const dbFile = path.join(os.tmpdir(), `ts-shell-check-${process.pid}.db`);


const repoDir = process.argv[2];
if (!repoDir) { console.error('用法: node scripts/dev-check.mjs <repoDir> [pythonPath]'); process.exit(1); }

// 桩 webServer: 按路径捕获注册的 handler（驱动先注册 /touchstone-agent, 反代随后）
const routes = new Map();
const ctx = {
  logger: () => ({ info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a) }),
  get: (name) => (name === 'webServer'
    ? { port: 0, register: (route) => { routes.set(route.path, route.handler); return () => { routes.delete(route.path); }; } }
    : null),
  // 驱动 start() 会 ctx.inject(['agents'], cb)：桩里立即用最小 agentCtx 回调
  inject: (names, cb) => {
    if (cb && names.includes('agents')) cb({ on: () => () => {}, agents: { get: () => null } });
    return { dispose() {} };
  },
};
/** 反代 handler：真机由 webServer 按前缀分派, 桩里手工按 /touchstone 取。 */
const handler = (req, res) => {
  const fn = routes.get('/touchstone');
  if (!fn) { res.writeHead(503); res.end(); return; }
  fn(req, res);
};
const dispose = await apply(ctx, {
  repoDir,
  pythonPath: process.argv[3] || 'python3',
  // 隔离库：真机常有实例占着默认库（同库单实例锁 → 新进程 exit 3），
  // 且隔离实例必须显式给管理员口令（否则随机一次性口令 + 首次强制改密门）
  extraEnv: { TOUCHSTONE_DB: dbFile, TS_ADMIN_PASSWORD: 'shell-check' },
});
if (!routes.has('/touchstone')) { console.error('FAIL: /touchstone 路由未注册'); process.exit(1); }

// 临时服务: /touchstone/* → handler, 其余 404
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/touchstone')) handler(req, res);
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// 等后端就绪（最长 15s）
let ok = 0;
for (let i = 0; i < 150 && ok !== 200; i++) {
  ok = await fetch(`http://127.0.0.1:${port}/touchstone/api/auth/me`).then((r) => r.status).catch(() => 0);
  if (ok !== 200) await new Promise((r) => setTimeout(r, 100));
}
if (ok !== 200) { console.error('FAIL: /touchstone/api/auth/me 15s 未就绪'); dispose(); server.close(); process.exit(1); }
const me = await fetch(`http://127.0.0.1:${port}/touchstone/api/auth/me`).then((r) => r.json());
// 注意: 用 /touchstone/app 断言 SPA 回退（/touchstone/ 会 302 到根相对 /app, 插件形态不可用——
// iframe 因此直接指向 /touchstone/app, 未登录跳转由 SPA 路由守卫在客户端完成）
const idx = await fetch(`http://127.0.0.1:${port}/touchstone/app`).then((r) => r.text());
const pass = me.username === 'admin' && me.is_admin === true && idx.includes('/touchstone/assets/');
console.log(`auth/me → ${JSON.stringify(me)}`);
console.log(pass ? 'PASS: 薄壳全链路 OK' : 'FAIL: admin 免登或插件版产物不符（确认已 npm run build:plugin）');
dispose();
server.close();
for (const suffix of ['', '.lock', '.pid']) {
  try { fs.rmSync(dbFile + suffix, { force: true }); } catch { /* 忽略 */ }
}
process.exit(pass ? 0 : 1);
