/**
 * Touchstone dsh 插件 — Node 薄壳（服务端半）
 * 职责四件（路线 A 起，见 doc_ai/spec/dsh_plugin/dsh插件形态.md）:
 *  1. spawn Touchstone 的 server.py 子进程（127.0.0.1 随机端口 + 插件版前端 + 免登信任头）
 *  2. 向 dsh webServer 注册 /touchstone 前缀路由, 全量反代到子进程（流式管道, SSE 不缓冲）
 *  3. agent 驱动（路线 A）: 进程内会话池 + 会话事件 SSE 推送, 挂 /touchstone-agent 前缀;
 *     驱动地址与一次性令牌经环境变量下发给 server.py（见 lib/agent-driver.js）
 *  4. 插件停用时注销路由、断开 SSE、释放常驻会话并 SIGTERM 子进程（server.py 侧有优雅退出）
 * 静态页/SPA 回退/REST/SSE 全部由 Python 现有逻辑承载, 薄壳本身不实现业务。
 *
 * 生命周期自愈（2026-10-04，修「Plugins 面板停用不回收」）:
 *   dsh 热重载换下条目时**不保证**走到本插件的 disposer。真机实测（隔离 profile）：
 *   面板停用后旧 fiber 仍在跑 —— `/touchstone` 与 `/touchstone-agent` 路由、
 *   server.py 子进程都活着，且 runtime 里已看不到该条目的 fiber；此时重新启用，
 *   新实例的 `webServer.register` 直接抛 `duplicate prefix route "/touchstone-agent"`,
 *   条目激活失败（面板报「1 entry did not activate」）。两条兜底：
 *   ① **启用即回收**：进程级注册表（`Symbol.for('touchstone.live')`）记着上一份有效壳,
 *      新壳 `apply` 先 `await` 它的 `reclaim()`（注销路由 + 断驱动 + 等子进程真退出）
 *      再注册; 子进程必须先退（同库单实例锁：旧进程活着会让新进程 exit 3）;
 *   ② **掉线自检**：每 2s 查一次 `ctx.loader.entries()`, 若本 fiber 已不在 loader 里
 *      （被换下却没 dispose）, 自主停壳（子进程退出、路由释放）。
 *   两条与正常 dispose 共用同一个幂等 `teardown()`, 因此正常路径行为不变。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { AgentDriver, loadUserMessageFactory, loadModelSelectionInstaller }
  from './agent-driver.js';

/** 反代统一注入的免登信任头（server.py --trust-internal-user 时生效） */
const TRUST_HEADER = 'x-ts-internal-user';

/** 停用后端时的退出宽限（ms）：SIGTERM 后等这么久仍不退，升级 SIGKILL（2026-10-03 P2） */
const BACKEND_EXIT_GRACE_MS = 5000;

/** 掉线自检节拍（ms）：热重载把本条目换下却不 dispose 时的兜底发现窗口 */
const UNMOUNT_WATCH_MS = 2000;

/** 进程级存活壳注册表键（同一 dsh 进程内只允许一份有效壳） */
const LIVE_KEY = Symbol.for('touchstone.live');

/** 子进程句柄与解析出的后端端口（每 profile 一个插件实例, 模块级单例即可） */
let child = null;
let backendPort = 0;
/** agent 驱动实例（模块级单例: 与 child 同生命周期, 热重载时整体替换） */
let driver = null;

/**
 * 反代 /touchstone/* 到本机 server.py 子进程: 剥掉 /touchstone 前缀后原样转发
 * （路径/查询串原样; Node http 管道流式转发不缓冲, SSE 事件实时透传）。
 */
function proxy(req, res) {
  if (!backendPort) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":"touchstone 后端尚未就绪, 稍后重试"}');
    return;
  }
  const path = req.url.slice('/touchstone'.length) || '/';
  const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` };
  headers[TRUST_HEADER] = 'admin'; // 覆盖式写入: 客户端伪造的同名头在此被替换
  const upstream = http.request(
    { host: '127.0.0.1', port: backendPort, path, method: req.method, headers },
    (ures) => {
      res.writeHead(ures.statusCode || 502, ures.headers);
      ures.pipe(res); // 流式管道: 静态/JSON/SSE 一条通路, 无缓冲
    },
  );
  upstream.on('error', () => {
    // 子进程退出/重启窗口期: 统一 502 JSON, 不影响 dsh 进程本身
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":"touchstone 后端不可达"}');
  });
  req.pipe(upstream);
}

/**
 * 停后端并**等它真的退出**（P2 起；2026-10-04 改为可 await，供「启用即回收」串行化）：
 * SIGTERM（Python 侧 handler 会清子进程树 + 释放同库单实例锁）→ 最多
 * BACKEND_EXIT_GRACE_MS → SIGKILL 兜底。只处理传进来的这个句柄，不读模块级
 * 变量做判断（热重载时模块级可能已被新实例改写）。
 */
function stopChild(proc, logger, why) {
  if (!proc) return Promise.resolve();
  if (child === proc) {
    child = null;
    backendPort = 0;
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const pid = proc.pid;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    const deadline = Date.now() + BACKEND_EXIT_GRACE_MS;
    const timer = setInterval(() => {
      if (settled) {
        clearInterval(timer);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        try {
          proc.kill('SIGKILL');
        } catch { /* 已退出：忽略 */ }
        logger.warn(`touchstone: 后端 pid=${pid} 在 ${BACKEND_EXIT_GRACE_MS}ms 内未退出，已 SIGKILL（${why}）`);
      }
    }, 100);
    if (timer.unref) timer.unref();
  });
}

/**
 * cordis 插件入口。config 来自 profile patch insert 条目（install.sh 写入）:
 *   repoDir    Touchstone 仓库根（必填）
 *   pythonPath Python 解释器（默认 python3; 本机应指含 zstandard 的 conda env）
 *   extraEnv   透传子进程的额外环境变量（如 TOUCHSTONE_DB 指向隔离实例库）
 * 返回组合 disposer（注销路由 + 断开驱动 + SIGTERM 子进程），dsh 停用插件时调用；
 * 另有「启用即回收上一份壳」与「掉线自检」两条自愈路径（见文件头注释）。
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ? ctx.logger('touchstone') : console;
  const repoDir = config.repoDir;
  if (!repoDir) {
    logger.warn('touchstone: 缺少 config.repoDir(应由 install.sh 写入), 插件不启动');
    return;
  }
  // ① 启用即回收：上一份壳若没走到 disposer（热重载换下不 dispose），它的路由与
  //    server.py 子进程都还在。必须先回收干净再注册，否则本实例 register 抛
  //    duplicate route 直接激活失败，且旧后端会一直占着同一个库。
  const previous = globalThis[LIVE_KEY];
  if (previous && typeof previous.reclaim === 'function') {
    logger.warn('touchstone: 上一份壳未正常退出（热重载换下未 dispose），先回收再启动');
    try {
      await previous.reclaim('superseded');
    } catch (error) {
      logger.warn(`touchstone: 回收上一份壳失败（继续启动）: ${error && error.message}`);
    }
    if (globalThis[LIVE_KEY] === previous) delete globalThis[LIVE_KEY];
  }

  // agent 驱动先起来: 它决定下发给 Python 的驱动地址/令牌。webServer 缺失（非 web profile）
  // 时驱动只注册路由这一步跳过, 反代与子进程照旧, 不影响现有形态。
  const webServer = ctx.get('webServer');
  const myDriver = new AgentDriver(ctx, logger);
  driver = myDriver;
  myDriver.start();
  void loadUserMessageFactory(logger).then((factory) => {
    if (driver === myDriver && factory) myDriver._userMessageFactory = factory;
  });
  void loadModelSelectionInstaller(logger).then((install) => {
    if (driver === myDriver && install) myDriver._installModelSelection = install;
  });
  const driverUrl = webServer && webServer.port
    ? `http://127.0.0.1:${webServer.port}/touchstone-agent` : '';

  const args = [
    `${repoDir}/server.py`,
    '--host', '127.0.0.1',                        // 只绑回环: 信任头等价 admin, 不得对外网开放
    '--port', '0',                                // 随机端口, 按 stdout 的 TOUCHSTONE_LISTEN 行解析
    '--web-dir', `${repoDir}/webui/dist-plugin`,  // 插件版前端(base=/touchstone/)
    '--trust-internal-user',                      // 免登: 反代注入信任头即视为 admin
    '--parent-watch',                             // 父死感知: dsh 退出/崩溃时后端自主退出
  ];
  const extraEnv = { ...(config.extraEnv || {}) };
  if (driverUrl) {
    // 驱动契约经环境变量下发（不写配置文件）: 重启 server.py 即重新握手, 无陈旧状态
    extraEnv.TS_AGENT_DRIVER_URL = driverUrl;
    extraEnv.TS_AGENT_DRIVER_TOKEN = myDriver.token;
  }
  logger.info(`touchstone: 启动后端 ${config.pythonPath || 'python3'} ${args.join(' ')}`);
  // stdio[0] 必须是 pipe 且**永不写入**：这是父死感知的 A 通道——dsh 进程无论
  // 优雅退出还是被 kill -9，OS 都会关闭该管道写端，Python 侧 os.read(0) 收到
  // EOF 即自主退出（实测父 kill -9 后 1.94s 退出）。改成 'ignore' 会让该通道失效。
  const myChild = spawn(config.pythonPath || 'python3', args, {
    cwd: repoDir,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = myChild;
  myChild.stdout.on('data', (buf) => {
    for (const line of String(buf).split('\n')) {
      const m = line.match(/^TOUCHSTONE_LISTEN (\d+)/);
      if (m) {
        backendPort = Number(m[1]);
        logger.info(`touchstone: 后端就绪 127.0.0.1:${backendPort}`);
      }
    }
  });
  myChild.stderr.on('data', (buf) => logger.warn(`touchstone[py]: ${String(buf).trim()}`));
  myChild.on('exit', (code, sig) => logger.warn(`touchstone: 后端退出 code=${code} sig=${sig}`));
  myChild.on('error', (err) => logger.warn(`touchstone: 后端拉起失败: ${err.message}`));

  let disposeRoute = null;
  if (!webServer) {
    logger.warn('touchstone: webServer 服务不可用(dsh web profile 之外?), 不注册路由');
  } else {
    disposeRoute = webServer.register({ kind: 'prefix', path: '/touchstone', handler: proxy });
  }

  /** 幂等停壳：注销路由 → 断驱动 → 等子进程退出。dispose / 回收 / 掉线自检共用。 */
  let disposed = false;
  let watchdog = null;
  const teardown = async (why) => {
    if (disposed) return;
    disposed = true;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    if (globalThis[LIVE_KEY] === shell) delete globalThis[LIVE_KEY];
    if (disposeRoute) {
      try {
        disposeRoute();
      } catch { /* 路由已随 fiber 注销：忽略 */ }
      disposeRoute = null;
    }
    if (driver === myDriver) driver = null;
    try {
      await myDriver.dispose();
    } catch (error) {
      logger.warn(`touchstone: 驱动释放失败（忽略）: ${error && error.message}`);
    }
    await stopChild(myChild, logger, why);
    logger.info(`touchstone: 壳已停（${why}）`);
  };

  const shell = {
    pid: () => (myChild ? myChild.pid : 0),
    startedAt: Date.now(),
    reclaim: (why) => teardown(why || 'reclaim'),
  };
  globalThis[LIVE_KEY] = shell;

  // ② 掉线自检：dsh 热重载换下条目却不 dispose 时, fiber 会脱离 loader 但仍在跑。
  //    探不到 loader 服务就不断言（宁可不收，不可误收）；命中即自主停壳。
  watchdog = setInterval(() => {
    if (disposed) return;
    const mounted = (() => {
      try {
        const loader = ctx.get('loader');
        if (!loader || typeof loader.entries !== 'function') return true;
        for (const row of loader.entries()) if (row && row.fiber === ctx.fiber) return true;
        return false;
      } catch {
        return true;
      }
    })();
    if (!mounted) {
      logger.warn('touchstone: 本条目已不在 loader（热重载换下未 dispose），自主停壳');
      void teardown('unmounted');
    }
  }, UNMOUNT_WATCH_MS);
  if (watchdog.unref) watchdog.unref();

  return () => {
    void teardown('dispose');
  };
}

// cordis 服务依赖声明(命名空间级导出, cordis 在 plugin.inject 上读取; 函数对象上的
// apply.inject 不可见——首版踩坑): 等 dsh-host-webserver 的 webServer 服务就绪再调 apply,
// 否则 ctx.get('webServer') 拿到 undefined 会静默跳过路由注册。
// 注意: agents 服务**不在这里声明**——本插件的反代职责不应因「某 profile 没有 agent loop」
// 而整包不加载; agent 驱动改用 ctx.inject(['agents'], ...) 延迟注入（见 agent-driver.js）。
export const inject = ['webServer'];
