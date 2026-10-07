/**
 * 薄壳生命周期自检（不经 dsh）：用桩 ctx 驱动 lib/index.js 的 apply/reclaim/掉线自检，
 * 验证「Plugins 面板停用不回收」的两条兜底（2026-10-04）。
 *
 * 用法: node scripts/dev-check-shell.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：真机复现（隔离 profile）表明 dsh 热重载换下本条目时**不保证**调用
 * 本插件的 disposer —— 旧 fiber 仍在跑（路由 + server.py 子进程都活着），随后重新
 * 启用时 `webServer.register` 抛 `duplicate prefix route "/touchstone-agent"`。
 * 本 harness 把两条兜底钉死：
 *   ① 启用即回收：同一 webServer（路由表里残留旧路由）下 apply 两次必须成功，
 *      且旧子进程真死（否则同库单实例锁会让新进程 exit 3）；
 *   ② 掉线自检：fiber 不在 loader.entries() 里时 2s 内自主停壳。
 * 后端用**假 server.py**（node 脚本：打印 TOUCHSTONE_LISTEN、写 pid 文件、SIGTERM 退出），
 * 只验壳的生命周期，不碰真正的 Python 后端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/** 桩 webServer：与真机同语义——重复 (kind,path) 注册直接抛。 */
function makeWebServer() {
  const prefixes = new Map();
  return {
    port: 45999,
    prefixes,
    register(route) {
      if (prefixes.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      }
      prefixes.set(route.path, route);
      return () => { prefixes.delete(route.path); };
    },
  };
}

/** 桩 ctx：webServer / loader（可变的 entries 行）/ logger / inject / fiber。 */
function makeCtx(webServer, rows) {
  const fiber = { stub: true };
  return {
    fiber,
    rows,
    logger: () => ({ info() {}, warn() {} }),
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'loader') return { entries: () => rows };
      return undefined;
    },
    inject(names, callback) {
      // 真机等 agents 服务就绪才回调；桩里立即回调一个最小 agentCtx。
      if (callback && names.includes('agents')) {
        callback({ on: () => () => {}, agents: { get: () => null } });
      }
      return { dispose() {} };
    },
  };
}

/** 写假 server.py（node 脚本，可被 node 直接执行；只做三件事）。 */
function makeFakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shell-check-'));
  fs.writeFileSync(path.join(dir, 'server.py'), [
    "const fs = require('fs');",
    "fs.appendFileSync(process.env.FAKE_PID_FILE, process.pid + '\\n');",
    "process.stdout.write('TOUCHSTONE_LISTEN 45998\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  return dir;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function readPids(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function main() {
  console.log('== 薄壳生命周期自检（apply / 启用即回收 / 掉线自检 / dispose）==');
  const repoDir = makeFakeRepo();
  const pidFile = path.join(repoDir, 'pids.txt');
  const config = { repoDir, pythonPath: process.execPath, extraEnv: { FAKE_PID_FILE: pidFile } };
  const spawned = [];

  try {
    // ---- 1) 首次 apply：注册两条路由 + 起一个后端 ----
    const webServer = makeWebServer();
    const ctx1 = makeCtx(webServer, []);
    const dispose1 = await apply(ctx1, config);
    ctx1.rows.push({ id: 'include:touchstone', fiber: ctx1.fiber });
    let pids = readPids(pidFile);
    // 子进程启动是异步的：等假后端把 pid 写出来（最多 3s）
    await waitFor(() => readPids(pidFile).length >= 1, 3000);
    pids = readPids(pidFile);
    check('apply#1 注册 /touchstone 与 /touchstone-agent',
      webServer.prefixes.has('/touchstone') && webServer.prefixes.has('/touchstone-agent'),
      JSON.stringify([...webServer.prefixes.keys()]));
    check('apply#1 拉起假后端', pids.length === 1 && alive(pids[0]), JSON.stringify(pids));
    spawned.push(...pids);
    check('apply#1 返回 disposer', typeof dispose1 === 'function');

    // ---- 2) 模拟「热重载换下却不 dispose」：同一 webServer 再 apply 一次 ----
    // 不回收的话 register 必抛 duplicate（真机现象），且旧后端会一直活着占库。
    const ctx2 = makeCtx(webServer, []);
    let apply2Error = '';
    let dispose2 = null;
    try {
      dispose2 = await apply(ctx2, config);
    } catch (error) {
      apply2Error = error && error.message;
    }
    ctx2.rows.push({ id: 'include:touchstone', fiber: ctx2.fiber });
    await waitFor(() => readPids(pidFile).length >= 2, 3000);
    pids = readPids(pidFile);
    spawned.push(...pids);
    check('apply#2（路由表残留旧路由）不抛 duplicate', apply2Error === '', apply2Error);
    check('apply#2 路由表仍只有一份 /touchstone 与 /touchstone-agent',
      webServer.prefixes.size === 2
      && webServer.prefixes.has('/touchstone') && webServer.prefixes.has('/touchstone-agent'),
      JSON.stringify([...webServer.prefixes.keys()]));
    check('apply#2 起了第二个后端', pids.length === 2, JSON.stringify(pids));
    check('apply#2 回收时旧后端真退出（同库单实例锁前提）',
      pids.length === 2 && !alive(pids[0]) && alive(pids[1]), JSON.stringify(pids));
    check('apply#2 返回 disposer', typeof dispose2 === 'function');

    // ---- 3) 掉线自检：fiber 不在 loader 里（被换下）→ 自主停壳 ----
    const webServer3 = makeWebServer();
    const ctx3 = makeCtx(webServer3, []);
    await apply(ctx3, config);
    ctx3.rows.push({ id: 'include:touchstone', fiber: ctx3.fiber });
    await waitFor(() => readPids(pidFile).length >= 3, 3000);
    pids = readPids(pidFile);
    spawned.push(...pids);
    const pid3 = pids[pids.length - 1];
    check('apply#3 起第三个后端', pids.length === 3 && alive(pid3), JSON.stringify(pids));
    ctx3.rows.length = 0;                     // 模拟：条目被换下，loader 里已无本 fiber
    const watched = await waitFor(
      () => !alive(pid3) && webServer3.prefixes.size === 0, 5000);
    check('掉线自检（2s 节拍）自主停壳：后端退出 + 路由释放', watched,
      JSON.stringify({ alive: alive(pid3), routes: [...webServer3.prefixes.keys()] }));

    // ---- 4) 正常 dispose：路由释放 + 后端退出（幂等，可重复调用） ----
    await dispose2();
    const stopped = await waitFor(
      () => !alive(pids[1]) && webServer.prefixes.size === 0, 5000);
    check('dispose#2 释放路由并停后端', stopped,
      JSON.stringify({ alive: alive(pids[1]), routes: [...webServer.prefixes.keys()] }));
    await dispose2();
    check('dispose 幂等（重复调用无副作用）', webServer.prefixes.size === 0);
  } finally {
    // 收尾：任何残留的假后端一律 SIGKILL，绝不留孤儿
    for (const pid of spawned) {
      try {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      } catch { /* 已退出 */ }
    }
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch { /* 清理失败不影响结论 */ }
  }

  console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('harness error:', error);
  process.exit(1);
});
