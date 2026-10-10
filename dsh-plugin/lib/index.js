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
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync }
  from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDriver, loadUserMessageFactory, loadModelSelectionInstaller }
  from './agent-driver.js';

/**
 * 包自身目录（本文件位于 <包根>/dsh-plugin/lib/index.js, 上溯三级）。
 * 2026-10-07 起本包**自包含**（Python 平台 + 预构建 webui/dist-plugin 都在包内）,
 * 因此安装后的包目录本身就是平台根, 直接充当 repoDir 的缺省值 —— 用户零配置即可跑。
 */
const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 反代统一注入的免登信任头（server.py --trust-internal-user 时生效） */
const TRUST_HEADER = 'x-ts-internal-user';

/** 停用后端时的退出宽限（ms）：SIGTERM 后等这么久仍不退，升级 SIGKILL（2026-10-03 P2） */
const BACKEND_EXIT_GRACE_MS = 5000;

/** 掉线自检节拍（ms）：热重载把本条目换下却不 dispose 时的兜底发现窗口 */
const UNMOUNT_WATCH_MS = 2000;

/** 插件形态后端日志（2026-10-08）：与库同目录追加写；启动时超过该体积先轮转一份 `.1` */
const BACKEND_LOG_NAME = 'plugin-backend.log';
const BACKEND_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 进程级存活壳注册表键（同一 dsh 进程内只允许一份有效壳） */
const LIVE_KEY = Symbol.for('touchstone.live');

/**
 * 后端 Python 依赖预检（2026-10-07 增）:
 *  为什么——插件模式下 server.py 由本壳直接 spawn, 用户若只 `dsh plugin add` 而没跑
 *  `pip install -r requirements.txt`, Python 侧在**导入期**就退出（server.py 的
 *  `import sessparse` → sessparse.py 模块级 `import zstandard`; `import feishu`
 *  → feishu.py 模块级 `import requests`）。此时面板只会看到 503 JSON、日志只有一行
 *  traceback, 新用户无从下手 —— 而 npm 安装的预期是「装完就能用」。
 *  做法——spawn 前用**同一个解释器**探一次: 硬依赖用真 import 验（将来新增模块级硬依赖
 *  要同步这个列表）, requirements.txt 里其余发行名用 importlib.metadata 验, 只作告警。
 *  铁律——预检自身任何异常/超时一律**放行**, 绝不因为预检挡住启动。
 */
const FATAL_PY_MODULES = ['zstandard', 'requests'];
const PREFLIGHT_TIMEOUT_MS = 10000;

/** 子进程句柄与解析出的后端端口（每 profile 一个插件实例, 模块级单例即可） */
let child = null;
let backendPort = 0;
/** agent 驱动实例（模块级单例: 与 child 同生命周期, 热重载时整体替换） */
let driver = null;
/** 依赖缺失时的提示页 HTML: 非空 ⇒ proxy 用它代替 503 JSON（每次 apply 重算） */
let backendHint = '';

/**
 * HTML 转义: 提示页里要嵌路径与命令原文（含用户配置的 pythonPath）
 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 读 requirements.txt 的发行名清单（注释/空行/选项行跳过, 剥掉版本与 extras 约束）。
 * 读不到就返回空数组 —— 预检降级为「只验硬依赖」, 不影响启动。
 */
function readRequirementNames(repoDir) {
  try {
    return readFileSync(join(repoDir, 'requirements.txt'), 'utf8')
      .split('\n')
      .map((line) => line.split('#')[0].trim())
      .filter((line) => line && !line.startsWith('-'))
      .map((line) => line.split(/[<>=!~;[\s]/, 1)[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 用 pythonPath 探一次运行依赖, 返回 { fatal, advisory, skipped }:
 *   fatal    —— 缺失的硬依赖（会导致 server.py 导入期退出）
 *   advisory —— requirements.txt 里缺失的可选依赖（只影响对应功能）
 *   skipped  —— 预检本身没跑成（解释器缺失/超时/输出不可解析）⇒ 调用方照常启动
 */
function preflightDeps(pythonPath, repoDir, logger) {
  const advisory = readRequirementNames(repoDir)
    .filter((name) => !FATAL_PY_MODULES.includes(name.toLowerCase()));
  const script = [
    'import importlib, importlib.metadata as md, json, sys',
    'fatal, rest = sys.argv[1].split(","), sys.argv[2].split(",")',
    'out = {"fatal": [], "advisory": []}',
    'for mod in fatal:',
    '    try: importlib.import_module(mod)',
    '    except Exception: out["fatal"].append(mod)',
    'for dist in rest:',
    '    if not dist: continue',
    '    try: md.version(dist)',
    '    except Exception: out["advisory"].append(dist)',
    'print(json.dumps(out))',
  ].join('\n');
  const argv = ['-c', script, FATAL_PY_MODULES.join(','), advisory.join(',')];
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const skip = (why) => {
      if (settled) return;   // error 与 close 可能都到, 只记一次
      logger.warn(`touchstone: 依赖预检未完成（${why}）, 照常启动后端`);
      settle({ fatal: [], advisory: [], skipped: true });
    };
    const proc = spawn(pythonPath, argv, { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      skip(`超过 ${PREFLIGHT_TIMEOUT_MS}ms`);
      try {
        proc.kill('SIGKILL');
      } catch { /* 已退出：忽略 */ }
    }, PREFLIGHT_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    proc.stdout.on('data', (buf) => { stdout += String(buf); });
    proc.stderr.on('data', (buf) => logger.warn(`touchstone[py-preflight]: ${String(buf).trim()}`));
    proc.on('error', (err) => {
      clearTimeout(timer);
      skip(err.message);
    });
    // 必须用 close 而不是 exit: exit 可能在 stdout 最后一个数据块**之前**触发,
    // 那会把正常输出读成空串而静默放行（缺依赖的机器上照样拉起注定退出的后端）。
    // close = 子进程已退出且 stdio 全部关闭, 此时 stdout 一定收全。
    proc.on('close', () => {
      clearTimeout(timer);
      const text = stdout.trim().split('\n').pop() || '';
      if (!text) {
        // 解释器存在但什么都没输出（如非 Python 的解释器、启动即崩）⇒ 放行
        skip('无输出');
        return;
      }
      try {
        const parsed = JSON.parse(text);
        settle({
          fatal: parsed.fatal || [], advisory: parsed.advisory || [], skipped: false,
        });
      } catch {
        skip('输出不可解析');
      }
    });
  });
}

/**
 * 依赖缺失时的面板提示页（代替 503 JSON）: 缺什么 + 一条可直接复制的修复命令
 * + 修完怎么让插件重来（停用再启用即会重跑 apply, 按 spec §8.8 不必重启 dsh web）。
 */
function renderDepHint(pythonPath, repoDir, missing) {
  const cmd = `${pythonPath} -m pip install -r ${join(repoDir, 'requirements.txt')}`;
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<title>Touchstone 后端未启动</title></head>'
    + '<body style="margin:0;padding:2rem;font:14px/1.75 ui-monospace,Menlo,Consolas,monospace;'
    + 'background:#14161a;color:#e6e6e6">'
    + '<h2 style="color:#ffb454;margin:0 0 .9rem">Touchstone 后端未启动：Python 运行依赖缺失</h2>'
    + `<p>缺少：<b style="color:#ff6b6b">${escapeHtml(missing.join(', '))}</b></p>`
    + '<p>在本机执行一次（用下面这个解释器，也就是插件启动后端用的那个）：</p>'
    + '<pre style="background:#0d0f12;border:1px solid #2a2f36;border-radius:6px;'
    + `padding:.8rem 1rem;overflow:auto">${escapeHtml(cmd)}</pre>`
    + '<p>装完把本插件<b>停用再启用</b>（Plugins 面板里那一行的开关）即会重试，不必重启 dsh web。</p>'
    + '<p style="color:#8b949e">若这个解释器不对，可在 profile patch 的 touchstone 条目里配置 '
    + '<code>pythonPath</code> 指向含这些依赖的解释器。</p>'
    + '</body></html>';
}

/**
 * 插件形态后端日志路径：与子进程用的**同一个库**同目录（`<库目录>/plugin-backend.log`）。
 * 不落 node_modules 下的 .run：装机目录可能只读、重装即清，而且日志跟着库走才对得上
 * 首启口令与运行审计。库路径优先级与 server.py 侧一致：extraEnv（profile 显式配置）
 * > 宿主环境 > 缺省 `~/.touchstone/touchstone.db`。
 */
function backendLogPath(extraEnv) {
  const dbPath = resolve(extraEnv.TOUCHSTONE_DB || process.env.TOUCHSTONE_DB
    || join(homedir(), '.touchstone', 'touchstone.db'));
  return join(dirname(dbPath), BACKEND_LOG_NAME);
}

/**
 * 打开后端日志追加流（必要时先把超限的旧日志轮转成 `.1`）。任何失败都只 warn 并返回
 * null —— 日志不可用**绝不阻断后端启动**，调用方退化为只走 dsh 日志。
 */
function openBackendLog(logPath, logger) {
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    if (existsSync(logPath) && statSync(logPath).size > BACKEND_LOG_MAX_BYTES) {
      try {
        rmSync(logPath + '.1', { force: true });   // Windows 不允许改名覆盖已存在文件
        renameSync(logPath, logPath + '.1');
      } catch { /* 轮转失败照样追加：不因轮转挡启动 */ }
    }
    const stream = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    let broken = false;
    stream.on('error', (error) => {
      if (broken) return;                          // 只报一次，避免刷屏
      broken = true;
      logger.warn(`touchstone: 后端日志写入失败（${error && error.message}）, 后续只走 dsh 日志`);
    });
    return stream;
  } catch (error) {
    logger.warn(`touchstone: 后端日志不可用（${error && error.message}）, 输出只走 dsh 日志: ${logPath}`);
    return null;
  }
}

/**
 * 行缓冲转发子进程输出。为什么不直接 `split('\n')`：data 事件按 chunk 到达，**行可能
 * 被切开**——`TOUCHSTONE_LISTEN` 被切成两段就永远匹配不上，端口解析不到、面板固定 503
 * （2026-10-08 缺陷定位时一并修）。每个流各持一段 carry，拼齐整行才交给 onLine。
 */
function pumpLines(stream, onLine) {
  let carry = '';
  stream.setEncoding('utf8');        // 内部 StringDecoder：多字节字符跨 chunk 不截断乱码
  stream.on('data', (chunk) => {
    carry += chunk;
    const lines = carry.split('\n');
    carry = lines.pop();             // 末段不完整，留到下一 chunk
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => { if (carry) onLine(carry); });
}

/**
 * 反代 /touchstone/* 到本机 server.py 子进程: 剥掉 /touchstone 前缀后原样转发
 * （路径/查询串原样; Node http 管道流式转发不缓冲, SSE 事件实时透传）。
 */
function proxy(req, res) {
  if (!backendPort) {
    // 依赖缺失导致后端没起来时给可操作的提示页, 其余未就绪窗口仍回 503 JSON
    if (backendHint) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(backendHint);
      return;
    }
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
 *   repoDir    Touchstone 平台根（可选; 缺省 = 包自身目录, 因为包是自包含的）
 *   pythonPath Python 解释器（默认 python3; 本机应指含 zstandard 的 conda env）
 *   extraEnv   透传子进程的额外环境变量（如 TOUCHSTONE_DB 指向隔离实例库）
 * 返回组合 disposer（注销路由 + 断开驱动 + SIGTERM 子进程），dsh 停用插件时调用；
 * 另有「启用即回收上一份壳」与「掉线自检」两条自愈路径（见文件头注释）。
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ? ctx.logger('touchstone') : console;
  // repoDir 缺省 = 包自身目录（自包含包: 包里就有 server.py 与 webui/dist-plugin）, 用户零配置即可跑;
  // 显式 config.repoDir 仍优先 —— 要指向开发中的工作副本、或包被拆开放置时才需要写。
  const repoDir = config.repoDir || PACKAGE_DIR;
  if (!existsSync(join(repoDir, 'server.py'))) {
    logger.warn(`touchstone: 找不到 ${repoDir}/server.py（repoDir 配置有误, 或安装包不完整）, 插件不启动`);
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
  // 插件形态默认「空口令 admin」（2026-10-08 用户口径）：面板本来就是免登 admin，
  // 而随机一次性口令只印在启动横幅里、用户拿不到 —— 首装必被「强制改密门」锁死
  // （横幅+门+薄壳丢 stdout 三者叠加，见 bug_report/20261008_1856）。这里下发开关：
  // db.seed_admin 种子时存空口令、不置 must_change_pw；用户在设置页设了密码就按设置的来。
  // 部署方显式配了 TS_ADMIN_PASSWORD 时无需让位（db 侧以该变量优先）。
  if (!('TS_ADMIN_PASSWORDLESS' in extraEnv)) {
    extraEnv.TS_ADMIN_PASSWORDLESS = '1';
  }
  if (driverUrl) {
    // 驱动契约经环境变量下发（不写配置文件）: 重启 server.py 即重新握手, 无陈旧状态
    extraEnv.TS_AGENT_DRIVER_URL = driverUrl;
    extraEnv.TS_AGENT_DRIVER_TOKEN = myDriver.token;
  }

  // 依赖预检（2026-10-07）: 缺硬依赖时**不 spawn** —— spawn 了也必然在导入期退出,
  // 日志里只留一行 traceback。改为把「缺什么 + 一条可复制的修复命令」同时送进
  // 日志与面板（backendHint 由 proxy 渲染）, 让 npm 安装真正做到「装完就知道缺什么」。
  const pythonPath = config.pythonPath || 'python3';
  const deps = await preflightDeps(pythonPath, repoDir, logger);
  let myChild = null;
  /** 本次壳的开的后端日志流（teardown 关闭；null = 不可用/未启动） */
  let myLog = null;
  if (deps.fatal.length) {
    backendHint = renderDepHint(pythonPath, repoDir, deps.fatal);
    logger.warn(`touchstone: 后端未启动 —— Python 运行依赖缺失: ${deps.fatal.join(', ')}`);
    logger.warn(`touchstone: 修复: ${pythonPath} -m pip install -r ${join(repoDir, 'requirements.txt')}`);
    logger.warn('touchstone: 装完把本插件停用再启用即会重试（不必重启 dsh web）');
  } else {
    backendHint = '';
    if (deps.advisory.length) {
      logger.warn(`touchstone: 可选依赖未安装（只影响对应功能, 不影响启动）: ${deps.advisory.join(', ')}`);
    }
    logger.info(`touchstone: 启动后端 ${pythonPath} ${args.join(' ')}`);
    // stdio[0] 必须是 pipe 且**永不写入**：这是父死感知的 A 通道——dsh 进程无论
    // 优雅退出还是被 kill -9，OS 都会关闭该管道写端，Python 侧 os.read(0) 收到
    // EOF 即自主退出（实测父 kill -9 后 1.94s 退出）。改成 'ignore' 会让该通道失效。
    myChild = spawn(pythonPath, args, {
      cwd: repoDir,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = myChild;
    // 子进程输出落盘（2026-10-08）：stdout 此前只用来解析 marker，**其余行全部丢弃**——
    // 首启一次性口令横幅（设计上唯一出口，见 server._seed_hint）与 [board]/[waitq]/[runner]
    // 运行诊断都在这些行里。现在 stdout/stderr 都逐行追加到 <库目录>/plugin-backend.log。
    myLog = openBackendLog(backendLogPath(extraEnv), logger);
    const writeLog = (line) => {
      if (!myLog) return;
      try { myLog.write(line + '\n'); } catch { /* 流已坏：忽略，绝不打断读取 */ }
    };
    pumpLines(myChild.stdout, (line) => {
      writeLog(line);
      const m = line.match(/^TOUCHSTONE_LISTEN (\d+)/);
      if (m) {
        backendPort = Number(m[1]);
        logger.info(`touchstone: 后端就绪 127.0.0.1:${backendPort}`);
      }
    });
    pumpLines(myChild.stderr, (line) => {
      writeLog(line);
      if (line.trim()) logger.warn(`touchstone[py]: ${line.trim()}`);
    });
    myChild.on('exit', (code, sig) => {
      writeLog(`[touchstone] 后端退出 code=${code} sig=${sig}`);
      logger.warn(`touchstone: 后端退出 code=${code} sig=${sig}`);
    });
    myChild.on('error', (err) => {
      writeLog(`[touchstone] 后端拉起失败: ${err.message}`);
      logger.warn(`touchstone: 后端拉起失败: ${err.message}`);
    });
  }

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
    if (myLog) {                    // 子进程停稳后再收日志流：最后几行不丢
      try { myLog.end(); } catch { /* 已关闭：忽略 */ }
      myLog = null;
    }
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
