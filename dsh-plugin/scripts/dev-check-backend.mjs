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
 * 临时目录，再真调 `apply()` 走一遍七场景：
 *   A 未配 backend（**缺省 node**，2026-10-15 M8 翻）⇒ 不碰 Python + 真起 Node 骨架
 *   B backend: node           ⇒ 同 A + 日志/SPA 判据
 *   C backend: node 但入口缺失 ⇒ 不抛异常、路由仍在、面板看到可读提示页
 *   D backend: python 显式     ⇒ 走 Python 探测链（**Python 版未退役，这是一行回滚**）
 *   E backend: 未知值          ⇒ 回落 **node** 并 warn（不静默）
 *   F backend: node 且入口在、但进程起来就崩 ⇒ 面板拿到可读提示页
 *   G 能力探测失败（宿主 Node 无 node:sqlite）⇒ **不 spawn** + 提示页 + 两条出路
 *     （G 靠 `_setNodeRuntimeProbeForTest` 注入，真机上造不出「能力不足的宿主 Node」）
 */
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

  // ---- F backend: node 且入口在、但进程起来就崩：面板必须拿到可读提示页 ----
  // 这是「新开关最常见的失败」：宿主 Node 版本不认、dist-plugin 缺失、被策略拦……
  // 若只回通用 503 JSON，用户在面板里看到的是一段 JSON 原文，不知道发生了什么。
  const crashRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-crash-'));
  fs.mkdirSync(path.join(crashRepo, 'backend'));
  fs.writeFileSync(path.join(crashRepo, 'backend', 'server.js'),
    'process.stderr.write("假后端: 起来就崩\\n");\nprocess.exit(3);\n');
  await withShell({ ...baseConfig, repoDir: crashRepo, backend: 'node' }, async (s) => {
    // 等子进程崩掉（假后端立即 exit 3）：崩之前是通用 503 JSON，崩之后才该换成提示页
    let page = await probe(s.port, '/app');
    const deadline = Date.now() + 6000;
    while (!String(page.contentType || '').startsWith('text/html') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      page = await probe(s.port, '/app');
    }
    check('F 后端起来就崩 ⇒ 面板看到 503 提示页（不是通用 JSON）',
      page.status === 503 && String(page.contentType).startsWith('text/html')
      && page.text.includes('Node'), `status=${page.status} type=${page.contentType} body=${page.text.slice(0, 120)}`);
    check('F 崩溃信息进日志（入口路径 + 退出码各一条，别写成一个断言——临时目录名随机，会假绿/假红）',
      s.logs.some((l) => l.includes('backend/server.js')) && s.logs.some((l) => /code=3\b/.test(l)),
      s.logs.slice(-4).join(' | '));
  });
  fs.rmSync(crashRepo, { recursive: true, force: true });

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
} finally {
  for (const suffix of ['', '.lock', '.pid']) {
    try { fs.rmSync(tmpDb + suffix, { force: true }); } catch { /* 忽略 */ }
  }
}

console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
