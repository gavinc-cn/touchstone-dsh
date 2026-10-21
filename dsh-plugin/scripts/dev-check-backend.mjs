/**
 * `config.backend` 双后端开关自检（不经 dsh，2026-10-11 M0）。
 *
 * 用法: node dsh-plugin/scripts/dev-check-backend.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：换 Node 后端的**全部收益**就是「不再要求用户机器上有 Python 与 pip」，
 * 所以判据不是「node 能起来」，而是 node 路径下**一次都不许碰 Python**
 * （不探测解释器、不跑依赖预检、不出现缺依赖提示页）。这条性质只有把 PATH 完全控制住、
 * 用「被调用就写标记文件」的假解释器才测得准——所以本脚本把 PATH 换成只有假 python 的
 * 临时目录，再真调 `apply()` 走一遍八组场景：
 *   A 未配 backend（**缺省 node**，2026-10-15 M8 翻）⇒ 不碰 Python + 真起 Node 骨架
 *   B backend: node           ⇒ 同 A + 日志/SPA 判据
 *   C backend: node 但入口缺失 ⇒ 不抛异常、路由仍在、面板看到可读提示页
 *   D backend: python 显式     ⇒ 走 Python 探测链（**Python 版未退役，这是一行回滚**）
 *   E backend: 未知值          ⇒ 回落 **node** 并 warn（不静默）
 *   F backend: node 且入口在、但进程起来就崩 ⇒ 面板拿到可读提示页；按 `<db>.pid` 归属记录分档：
 *     F0 无记录（通用锁冲突文案）/ F2 有活占用者（点名另一个宿主 + 两条出路 + 不许删锁文件）/
 *     F3 记录已过期（残留）/ F4 pid 存活但父进程已死（PID 复用/父死残留，不断言活宿主）
 *   G 能力探测失败（宿主 Node 无 node:sqlite）⇒ **不 spawn** + 提示页 + 两条出路
 *     （G 靠 `_setNodeRuntimeProbeForTest` 注入，真机上造不出「能力不足的宿主 Node」）
 *   H node 后端 + 显式 `pythonPath` ⇒ 透传为子进程 `TS_PYTHON`（夹具脚本解释器；负对照＝
 *     不配就不注入，交给 backend/lib/runner.js 按平台候选自行探测）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { apply, _setNodeRuntimeProbeForTest } from '../lib/index.js';

const REPO_DIR = path.resolve(import.meta.dirname, '..', '..');
const LIVE_KEY = Symbol.for('touchstone.live');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/**
 * 起一份壳做一次场景：PATH 只留假 python（被调用即往 marker 追加一行），
 * 桩 ctx 照 dev-check.mjs 的写法（驱动需要 ctx.inject(['agents'], cb)）。
 * 结束时用壳自己的 reclaim() 停干净（与 disposer 同一条 teardown）。
 */
async function withShell(config, run) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-backend-check-'));
  const marker = path.join(bin, 'python-called.txt');
  fs.writeFileSync(path.join(bin, 'python'),
    `#!/bin/sh\necho "$@" >> "${marker}"\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'python'), 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = bin;          // 真解释器不许混进来：探到的只可能是假的那个
  const logs = [];
  const routes = new Map();
  const ctx = {
    logger: () => ({
      info: (...a) => logs.push(`info: ${a.join(' ')}`),
      warn: (...a) => logs.push(`warn: ${a.join(' ')}`),
    }),
    get: (name) => (name === 'webServer'
      ? {
        port: 0,
        register: (route) => {
          routes.set(route.path, route.handler);
          return () => { routes.delete(route.path); };
        },
      }
      : null),
    inject: (names, cb) => {
      if (cb && names.includes('agents')) cb({ on: () => () => {}, agents: { get: () => null } });
      return { dispose() {} };
    },
  };

  let server = null;
  try {
    await apply(ctx, config);
    server = http.createServer((req, res) => {
      const fn = routes.get('/touchstone');
      if (!fn) { res.writeHead(404); res.end(); return; }
      fn(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    /** 等后端就绪（反代 503 = 尚未 LISTEN；真机面板同样靠轮询，10s 上限） */
    const ready = async (ms = 10000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const me = await probe(port, '/api/auth/me');
        if (me.status !== 503 || Date.now() > deadline) return me;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    return await run({
      port,
      logs,
      routes,
      ready,
      pythonCalled: () => fs.existsSync(marker),
    });
  } finally {
    process.env.PATH = savedPath;
    if (server) await new Promise((r) => server.close(r));
    const shell = globalThis[LIVE_KEY];
    if (shell && typeof shell.reclaim === 'function') {
      try { await shell.reclaim('check-end'); } catch { /* 已停：忽略 */ }
    }
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

/** 探一次面板接口（带薄壳会注入的信任头），返回 {status, text, json} */
async function probe(port, urlPath, withTrust = true) {
  const res = await fetch(`http://127.0.0.1:${port}/touchstone${urlPath}`, {
    headers: withTrust ? { 'x-ts-internal-user': 'admin' } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, text, json, contentType: res.headers.get('content-type') };
}

/**
 * 等「Node 后端起来就崩」提示页替换掉通用 503 JSON：崩之前 proxy 回 JSON、崩之后才渲染提示页。
 * F 系四个崩溃子场景共用（墙钟截止这里只影响交互式自检的等待上限，不改变任何产品判据）。
 */
async function waitForCrashHint(s, ms = 6000) {
  let page = await probe(s.port, '/app');
  const deadline = performance.now() + ms;   // 单调钟：墙钟前跳不改变等待上限（M13 约定）
  while (!String(page.contentType || '').startsWith('text/html') && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    page = await probe(s.port, '/app');
  }
  return page;
}

/** 造一个「起来就崩」的假后端仓库（F 系子场景各占一份临时目录；stderr 文案由调用方给） */
function makeCrashRepo(tag, stderrText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-node-crash-${tag}-`));
  fs.mkdirSync(path.join(dir, 'backend'));
  fs.writeFileSync(path.join(dir, 'backend', 'server.js'),
    `process.stderr.write(${JSON.stringify(stderrText)} + "\\n");\nprocess.exit(3);\n`);
  return dir;
}

/**
 * 造一个「把子进程收到的 TS_PYTHON 写盘就退出」的假后端仓库（H 用）。
 * 为什么真起子进程而不是读代码：判据是**环境变量真的传到了后端进程**（Node 后端的
 * 夹具脚本解释器覆盖），静态 grep 只能证明写了那行赋值。
 */
function makeEnvRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-node-env-${tag}-`));
  fs.mkdirSync(path.join(dir, 'backend'));
  const out = path.join(dir, 'seen-ts-python.txt');
  fs.writeFileSync(path.join(dir, 'backend', 'server.js'),
    'const fs = require("node:fs");\n'
    + `fs.writeFileSync(${JSON.stringify(out)}, String(process.env.TS_PYTHON ?? ""));\n`
    + 'process.exit(0);\n');
  return { dir, out };
}

/** 等假后端把观测结果写出来（子进程启动是异步的；5s 上限只防死等） */
async function waitFile(file, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!fs.existsSync(file) && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return fs.existsSync(file);
}

/** 往隔离库写一条 `<db>.pid` 归属记录（形状与 backend/lib/lock.js:writePidRecord 同源） */
function writePidRecord(record) {
  fs.writeFileSync(tmpDb + '.pid', JSON.stringify(record));
}

/** 清掉隔离库的归属记录（F0 的「无记录」语义必须显式归零，不能依赖前面场景是否残留） */
function clearPidRecord() {
  fs.rmSync(tmpDb + '.pid', { force: true });
}

/** 等一个 pid 真的「探不到」（子进程 exit 后可能短暂是僵尸：pidAlive 会误判成活着） */
async function waitPidGone(pid, ms = 2000) {
  const deadline = performance.now() + ms;   // 单调钟（M13 约定）
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (performance.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 造一个「确定已经退出」的 pid（F3 当残留记录、F4 当死掉的父进程用） */
async function retirePid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((r) => child.on('exit', r));
  await waitPidGone(pid);
  return pid;
}

/** 本次自检的隔离库（Node 骨架 M0 不读库，仅防 Python 侧污染生产库） */
const tmpDb = path.join(os.tmpdir(), `ts-backend-check-${process.pid}.db`);
const baseConfig = { repoDir: REPO_DIR, extraEnv: { TOUCHSTONE_DB: tmpDb, TS_ADMIN_PASSWORD: 'check' } };

console.log('== 双后端开关自检（缺省 node / 显式 python / 入口缺失 / 未知值 / 能力探测）==');
try {
  // ---- A 缺省：**node**（2026-10-15 M8 翻），一次都不许碰 Python ----
  await withShell(baseConfig, async (s) => {
    check('A 未配 backend ⇒ 一次都没调用 Python（假 python 无标记文件）', !s.pythonCalled(),
      s.logs.join(' | '));
    check('A 未配 backend ⇒ 缺省就是 node（日志「启动后端（node）」）',
      s.logs.some((l) => l.includes('启动后端') && l.includes('（node）')),
      s.logs.filter((l) => l.includes('启动后端')).join(' | '));
    check('A 未配 backend ⇒ 能力探测真跑过且留痕（node:sqlite ok）',
      s.logs.some((l) => l.includes('能力探测通过') && l.includes('node:sqlite ok')),
      s.logs.filter((l) => l.includes('能力探测')).join(' | '));
    const me = await s.ready();
    check('A 缺省路径真起后端 ⇒ /api/auth/me 200 且是 admin',
      me.status === 200 && me.json && me.json.username === 'admin' && me.json.is_admin === true,
      JSON.stringify(me) + ' | ' + s.logs.join(' | '));
  });

  // ---- B backend: node 显式：与缺省同路，另加日志/SPA 判据 ----
  await withShell({ ...baseConfig, backend: 'node' }, async (s) => {
    check('B backend: node ⇒ 完全没调用 Python（无标记文件）', !s.pythonCalled());
    check('B backend: node ⇒ /touchstone 路由已注册', s.routes.has('/touchstone'));
    const me = await s.ready();
    check('B 面板接口 /api/auth/me 200 且是 admin',
      me.status === 200 && me.json && me.json.username === 'admin' && me.json.is_admin === true,
      JSON.stringify(me) + ' | ' + s.logs.join(' | '));
    const app = await probe(s.port, '/app');
    check('B 插件版 SPA 可达（index.html 含 dist-plugin 资源）',
      app.status === 200 && app.text.includes('/assets/'), `status=${app.status}`);
    check('B 日志里能看到「启动后端 … backend/server.js」',
      s.logs.some((l) => l.includes('启动后端') && l.includes('backend/server.js')),
      s.logs.filter((l) => l.includes('启动后端')).join(' | '));
  });

  // ---- C backend: node 但入口缺失：不抛异常、路由在、面板有可读提示 ----
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-norepo-'));
  await withShell({ ...baseConfig, repoDir: emptyRepo, backend: 'node' }, async (s) => {
    const hint = await probe(s.port, '/');
    check('C 入口缺失 ⇒ 不抛异常且路由仍在', s.routes.has('/touchstone'));
    check('C 入口缺失 ⇒ 面板看到 503 提示页（HTML 含 Node）',
      hint.status === 503 && hint.text.includes('Node'), `status=${hint.status}`);
    check('C 入口缺失 ⇒ 日志给出确切路径',
      s.logs.some((l) => l.includes('backend/server.js')), s.logs.join(' | '));
    check('C 入口缺失 ⇒ 提示页的回滚说明是「显式写 python」而不是「删掉该键」',
      hint.text.includes('显式写成') && hint.text.includes('删掉该键现在等于 node'),
      hint.text.slice(0, 200));
  });
  fs.rmSync(emptyRepo, { recursive: true, force: true });

  // ---- D 显式 python：Python 版未退役，这条就是观测期的回滚动作 ----
  await withShell({ ...baseConfig, backend: 'python' }, async (s) => {
    check('D backend: python 显式 ⇒ 仍走 Python 探测链', s.pythonCalled());
  });

  // ---- E 未知值：回落 node 且 warn 一句（不静默） ----
  await withShell({ ...baseConfig, backend: 'nodejs' }, async (s) => {
    check('E 未知 backend 值 ⇒ 回落 node（不碰 Python）', !s.pythonCalled(), s.logs.join(' | '));
    check('E 未知 backend 值 ⇒ 有 warn 说明按缺省 node 处理',
      s.logs.some((l) => l.startsWith('warn') && l.includes('backend') && l.includes('node')),
      s.logs.join(' | '));
    check('E 未知 backend 值 ⇒ 日志「启动后端（node）」',
      s.logs.some((l) => l.includes('启动后端') && l.includes('（node）')),
      s.logs.filter((l) => l.includes('启动后端')).join(' | '));
  });

  // ---- F 系 backend: node 且入口在、但进程起来就崩：面板必须拿到可读提示页 ----
  // 这是「新开关最常见的失败」：宿主 Node 版本不认、dist-plugin 缺失、被策略拦……
  // 若只回通用 503 JSON，用户在面板里看到的是一段 JSON 原文，不知道发生了什么。
  // 2026-10-18 真机事故的形态：退出码 3 = 同库单实例锁被**另一个活着的 DSH 宿主**占着，
  // 而提示页还让用户猜「可能残留」并建议移走 `.lock`/`.pid`（与项目红线矛盾：删锁文件会在
  // 新 inode 上取锁 ⇒ 双写）。现在按 `<db>.pid` 归属记录分三档，判据见 F0/F2/F3/F4。
  clearPidRecord();   // A/B 的真后端退出时会删记录；这里显式归零，F0 才有「无记录」语义
  const crashRepo = makeCrashRepo('plain', '假后端: 起来就崩');
  await withShell({ ...baseConfig, repoDir: crashRepo, backend: 'node' }, async (s) => {
    const page = await waitForCrashHint(s);
    check('F0 后端起来就崩 ⇒ 面板看到 503 提示页（不是通用 JSON）',
      page.status === 503 && String(page.contentType).startsWith('text/html')
      && page.text.includes('Node'), `status=${page.status} type=${page.contentType} body=${page.text.slice(0, 120)}`);
    // 2026-10-17 桌面端真机事故教训：提示页原先只教用户自己去 tail 日志文件 —— Windows 用户
    // 得先找到库目录、开终端。现改为把内存里收到的最后几行直接内联，提示页要能自解释。
    check('F0 提示页内联后端最后输出（免去手动 tail；真机失败原因就在这一行）',
      page.text.includes('假后端: 起来就崩'), page.text.slice(0, 400));
    check('F0 code=3 且无归属记录 ⇒ 提示页给同库单实例锁说明（两版后端的 exit 3 同义）',
      page.text.includes('同库单实例锁') && page.text.includes('读不到'),
      page.text.slice(0, 400));
    check('F0 无记录分支 ⇒ 不教用户「移走 *.lock / *.pid」（防双写红线），而是明确不要删除',
      !page.text.includes('移走后重试') && !page.text.includes('把库目录下的')
      && page.text.includes('不要删除'), page.text.slice(0, 500));
    check('F0 崩溃信息进日志（入口路径 + 退出码各一条，别写成一个断言——临时目录名随机，会假绿/假红）',
      s.logs.some((l) => l.includes('backend/server.js')) && s.logs.some((l) => /code=3\b/.test(l)),
      s.logs.slice(-4).join(' | '));
  });
  fs.rmSync(crashRepo, { recursive: true, force: true });

  // ---- F2 活占用者：`.pid` 指向一个**真活着**的进程（真 spawn 一个 dummy，不用 mock pid） ----
  // 真机形态：另一个 DSH 宿主（desktop profile）开着，它的 Touchstone 后端占着同一个库。
  const liveCrashRepo = makeCrashRepo('live', '假后端: 同库锁被占');
  const liveHolder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    writePidRecord({
      pid: liveHolder.pid,
      ppid: process.pid,                       // 父进程（= 宿主替身）也活着 ⇒ 判定「宿主正开着」
      repo_dir: 'C:\\Users\\dev\\.dsh\\profiles\\desktop\\node_modules\\@gavinc-cn\\touchstone-dsh',
      parent_watch: true,
      started_at: Math.floor(Date.now() / 1000),
      backend: 'node',
    });
    await withShell({ ...baseConfig, repoDir: liveCrashRepo, backend: 'node' }, async (s) => {
      const page = await waitForCrashHint(s);
      check('F2 活占用者 ⇒ 面板点名「另一个正在运行的宿主」（repo 路径认出 desktop profile）',
        page.text.includes('正在运行') && page.text.includes('DSH 桌面端'), page.text.slice(0, 500));
      check('F2 活占用者 ⇒ 给出占用者 pid 与两条正确出路（退出那个宿主 / 独立库 TOUCHSTONE_DB）',
        page.text.includes(String(liveHolder.pid)) && page.text.includes('TOUCHSTONE_DB')
        && page.text.includes('停用再启用'), page.text.slice(0, 600));
      check('F2 活占用者 ⇒ 明确警告「不要删除或移动 *.lock / *.pid」（防双写）',
        page.text.includes('不要删除') && page.text.includes('.lock'), page.text.slice(0, 600));
      check('F2 活占用者 ⇒ 不再出现「移走锁文件后重试」这种危险建议',
        !page.text.includes('移走后重试') && !page.text.includes('把库目录下的'),
        page.text.slice(0, 600));
      check('F2 活占用者 ⇒ dsh 日志留一行占用者摘要（排障从宿主日志即可看到是谁占着）',
        s.logs.some((l) => l.includes('DSH 桌面端') && l.includes(String(liveHolder.pid))),
        s.logs.slice(-6).join(' | '));
    });
  } finally {
    try { liveHolder.kill('SIGKILL'); } catch { /* 已退：忽略 */ }
    clearPidRecord();
    fs.rmSync(liveCrashRepo, { recursive: true, force: true });
  }

  // ---- F3 残留记录：`.pid` 指向一个**已经退出**的进程 ⇒ 归「残留」，不许断言另一宿主在跑 ----
  const staleCrashRepo = makeCrashRepo('stale', '假后端: 记录残留');
  const deadPid = await retirePid();
  try {
    writePidRecord({
      pid: deadPid,
      ppid: deadPid,                           // 父进程同样不存在
      repo_dir: '/home/dev/.dsh/profiles/web/node_modules/@gavinc-cn/touchstone-dsh',
      parent_watch: true,
      started_at: 1,
      backend: 'node',
    });
    await withShell({ ...baseConfig, repoDir: staleCrashRepo, backend: 'node' }, async (s) => {
      const page = await waitForCrashHint(s);
      check('F3 记录已过期 ⇒ 提示页判「残留记录」（不说另一个宿主正在运行）',
        page.text.includes('残留') && !page.text.includes('正在运行'), page.text.slice(0, 500));
      check('F3 残留分支 ⇒ 教「停用→启用即会重试」，并明确不需要手动删 `.lock`/`.pid`',
        page.text.includes('停用→启用') && page.text.includes('不需要')
        && page.text.includes('.lock'), page.text.slice(0, 600));
      check('F3 残留分支 ⇒ 不出现「移走锁文件后重试」危险建议',
        !page.text.includes('移走后重试') && !page.text.includes('把库目录下的'),
        page.text.slice(0, 600));
    });
  } finally {
    clearPidRecord();
    fs.rmSync(staleCrashRepo, { recursive: true, force: true });
  }

  // ---- F4 pid 存活但父进程已死（parent_watch=true）⇒ PID 复用/父死残留，不能断言活宿主 ----
  // 2026-10-17 真机事故家族：Windows 上 pid 会被复用，只看「pid 存活」会把残留记录误判成活实例。
  const orphanCrashRepo = makeCrashRepo('orphan', '假后端: pid 残留');
  const orphanChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    writePidRecord({
      pid: orphanChild.pid,
      ppid: deadPid,                           // 父进程已死 ⇒ 无法证明「那个宿主还开着」
      repo_dir: 'C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules\\@gavinc-cn\\touchstone-dsh',
      parent_watch: true,
      started_at: Math.floor(Date.now() / 1000),
      backend: 'node',
    });
    await withShell({ ...baseConfig, repoDir: orphanCrashRepo, backend: 'node' }, async (s) => {
      const page = await waitForCrashHint(s);
      check('F4 pid 活着但父进程已死 ⇒ 判「疑似残留/PID 复用」而不是「另一个宿主正在运行」',
        page.text.includes('PID 复用') && !page.text.includes('正在运行'), page.text.slice(0, 600));
      check('F4 存疑分支同样不教「移走锁文件后重试」，且明确不要删除',
        !page.text.includes('移走后重试') && !page.text.includes('把库目录下的')
        && page.text.includes('不要删除'), page.text.slice(0, 600));
    });
  } finally {
    try { orphanChild.kill('SIGKILL'); } catch { /* 已退：忽略 */ }
    clearPidRecord();
    fs.rmSync(orphanCrashRepo, { recursive: true, force: true });
  }

  // ---- G 能力探测失败（宿主 Node 没有 node:sqlite）：不许 spawn，且必须给两条出路 ----
  // 真机上造不出「能力不足的宿主 Node」（本机是能力齐备的 Node 24），所以走测试缝注入。
  // 这一支在缺省翻成 node 之后是**默认路径上的头号失败**，值得一条行为判据。
  _setNodeRuntimeProbeForTest(async () => ({
    ok: false,
    skipped: false,
    detail: 'Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite',
  }));
  try {
    await withShell(baseConfig, async (s) => {
      const hint = await probe(s.port, '/');
      check('G 探测失败 ⇒ 不 spawn 后端（日志里没有「启动后端」）',
        !s.logs.some((l) => l.includes('启动后端')), s.logs.join(' | '));
      check('G 探测失败 ⇒ 面板拿到 503 提示页（标题＝宿主 Node 不满足要求）',
        hint.status === 503 && hint.text.includes('宿主 Node 不满足要求'),
        `status=${hint.status} body=${hint.text.slice(0, 160)}`);
      check('G 探测失败 ⇒ 提示页给两条出路（升级 Node 22.19+ / 显式 backend: python）',
        hint.text.includes('22.19') && hint.text.includes('backend: python'), hint.text.slice(0, 200));
      check('G 探测失败 ⇒ 日志两条出路都可复制（>= 22.19 与 backend: python 各一条）',
        s.logs.some((l) => l.startsWith('warn') && l.includes('22.19'))
        && s.logs.some((l) => l.startsWith('warn') && l.includes('backend: python')),
        s.logs.filter((l) => l.startsWith('warn')).join(' | '));
      check('G 探测失败 ⇒ 探测原文进日志（用户据此判断是不是 sqlite 的问题）',
        s.logs.some((l) => l.includes('ERR_UNKNOWN_BUILTIN_MODULE')), s.logs.join(' | '));
    });
  } finally {
    _setNodeRuntimeProbeForTest(null);
  }

  // ---- H node 后端 + 显式 pythonPath：透传 TS_PYTHON（夹具脚本解释器随配置） ----
  // Node 后端不等于「不需要 Python」：脚本复测 verify.py / 脚本驱动压测 run.py 仍是 Python
  // 夹具脚本，由 backend/lib/runner.js 解析解释器。配了 pythonPath 就该以配置为准（失败时
  // 后端响亮报错，不静默换 PATH 上另一支），没配则不注入、由后端按平台候选自己探。
  const cfgEnvRepo = makeEnvRepo('cfg');
  try {
    const fakePy = 'C:/Users/dev/AppData/Local/Programs/Python/Python312/python.exe';
    await withShell({
      ...baseConfig, repoDir: cfgEnvRepo.dir, backend: 'node', pythonPath: fakePy,
      // 宿主环境即使有 TS_PYTHON 也要被显式配置覆盖 ⇒ 判据只由 config.pythonPath 决定
      extraEnv: { ...baseConfig.extraEnv, TS_PYTHON: '' },
    }, async (s) => {
      const seen = await waitFile(cfgEnvRepo.out);
      const value = seen ? fs.readFileSync(cfgEnvRepo.out, 'utf8') : '<未写盘>';
      check('H node 后端 + config.pythonPath ⇒ 子进程收到 TS_PYTHON（夹具脚本解释器以配置为准）',
        value === fakePy, `${value} | ${s.logs.slice(-3).join(' | ')}`);
    });
  } finally {
    fs.rmSync(cfgEnvRepo.dir, { recursive: true, force: true });
  }
  // 负对照：不配 pythonPath ⇒ 不注入（后端自行按平台候选探测；这里用空串显式隔离宿主环境）
  const noCfgEnvRepo = makeEnvRepo('none');
  try {
    await withShell({
      ...baseConfig, repoDir: noCfgEnvRepo.dir, backend: 'node',
      extraEnv: { ...baseConfig.extraEnv, TS_PYTHON: '' },
    }, async (s) => {
      const seen = await waitFile(noCfgEnvRepo.out);
      const value = seen ? fs.readFileSync(noCfgEnvRepo.out, 'utf8') : '<未写盘>';
      check('H 负对照：未配 pythonPath ⇒ 不注入 TS_PYTHON（Python 链仍一次不碰）',
        value === '' && !s.pythonCalled(), `${value} | ${s.logs.slice(-3).join(' | ')}`);
    });
  } finally {
    fs.rmSync(noCfgEnvRepo.dir, { recursive: true, force: true });
  }
} finally {
  for (const suffix of ['', '.lock', '.pid']) {
    try { fs.rmSync(tmpDb + suffix, { force: true }); } catch { /* 忽略 */ }
  }
}

console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
