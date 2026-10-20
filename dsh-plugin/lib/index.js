/**
 * Touchstone dsh 插件 — Node 薄壳（服务端半）
 * 职责四件（路线 A 起，见 doc_ai/spec/dsh_plugin/dsh插件形态.md）:
 *  1. spawn Touchstone 后端子进程（127.0.0.1 随机端口 + 插件版前端 + 免登信任头）:
 *     缺省 Node（`backend/server.js`，2026-10-15 M8 翻）/ `config.backend: python` 时 Python（`server.py`）
 *  2. 向 dsh webServer 注册 /touchstone 前缀路由, 全量反代到子进程（流式管道, SSE 不缓冲）
 *  3. agent 驱动（路线 A）: 进程内会话池 + 会话事件 SSE 推送, 挂 /touchstone-agent 前缀;
 *     驱动地址与一次性令牌经环境变量下发给 server.py（见 lib/agent-driver.js）
 *  4. 插件停用时注销路由、断开 SSE、释放常驻会话并 SIGTERM 子进程（server.py 侧有优雅退出）
 * 静态页/SPA 回退/REST/SSE 全部由后端自身承载, 薄壳本身不实现业务
 * （两版后端共用同一份 apply() 其余逻辑: 端口解析、日志落盘、stopBackend、驱动下发都不分叉）。
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

/**
 * 缺省解释器探测顺序（未配置 config.pythonPath 时）: `python` → `python3`。
 *
 * 为什么 `python` 排第一（2026-10-11 用户裁定「兜底应该用 python, 不要用 python3」）:
 *  - **Windows 上没有 `python3` 这个名字**（官方安装器只装 `python.exe` / `py.exe`）,
 *    桌面端零配置安装下, 写死 `python3` 会让 `spawn` 直接 `ENOENT` —— 比「找到解释器但
 *    缺依赖」更糟：预检连跑都跑不起来, 只能走 `skip()` 放行, 然后后端在导入期崩掉,
 *    用户既看不到缺什么、也拿不到可复制的修复命令。
 *  - Linux 上两者都在（本机用户 shell 的 `python`/`python3` 同为 conda my_pyenv）,
 *    顺序换成 `python` 优先不改变命中结果。
 *  - 用 `python3` 当第二档是为了兜住「只有 python3、没有 python」的环境
 *    （部分精简发行版/容器镜像如此）, 比单点写死更稳。
 *  探测方式 = 真 spawn 一次 `-c pass`（受 PATH 解析、能识破 Microsoft Store 的
 *  `python3.exe` 占位别名——它是 GUI 应用, 跑起来不会正常退出）, 而不是查文件表。
 */
const PYTHON_CANDIDATES = ['python', 'python3'];
const PYTHON_PROBE_TIMEOUT_MS = 5000;
/**
 * 探测用的命令。带一个可识别的标记：测试里的假解释器要能把「探测调用」与
 * 「依赖预检调用」区分开（两者都是 `-c`），否则探测会污染预检的调用记录。
 * 标记写成 Python 注释, 对真解释器没有任何语义影响。
 */
const PYTHON_PROBE_CODE = 'pass  # touchstone-python-probe';

/**
 * 后端实现选择（2026-10-11 M0 起为 `config.backend`；**2026-10-15 M8 翻缺省**）：
 * `config.backend` = `'node'`（**缺省**）| `'python'`（显式，仍完整可用）。
 *
 * 为什么是配置键而不是「有 Python 就用 Python、没有就自动用 Node」：换后端是**验收动作**，
 * 必须能一行改回；自动探测会让「对拍还没过的版本」在用户机器上被静默启用。
 *
 * 缺省值变迁（M8，用户 2026-10-15 裁决「默认可以改为 nodejs 后台，但 python 版现在不能删」）：
 *  - 翻转前：缺省 python（Node 是影子/可选路径，未验收前谁都不受影响）；
 *  - 翻转后：缺省 node（Node 已在 M0–M7.5 逐项对拍过关，Gate 1 的全量对拍判据已达成）；
 *  - Python 版**不退役**：`server.py` 与包内 `*.py` 照旧随包分发，`backend: python`
 *    是观测期唯一的回滚动作（**必须显式写 `python`，删键现在等于 node**）。
 *
 * `backend: 'node'` 时整条 Python 链（解释器探测 + 依赖预检 + 缺依赖提示页）**一律跳过** ——
 * 那正是换 Node 的收益本身（不再要求用户机器上有 Python 与 pip）。改由 Node 侧自己的能力探测
 * （`node:sqlite`，见 `renderNodeRuntimeHint`）兜「宿主 Node 太老」这一类失败。
 */
const BACKEND_PYTHON = 'python';
const BACKEND_NODE = 'node';

/** Node 后端入口（相对 repoDir）。进程契约见方案 §3.2，两版 argv 只差入口路径与 node 选项。 */
const NODE_ENTRY_REL = 'backend/server.js';
/** Python 后端入口与运行依赖清单（相对 repoDir）；源码在 backend_py/（2026-10-19 起）。 */
const PYTHON_ENTRY_REL = 'backend_py/server.py';
const PYTHON_REQUIREMENTS_REL = 'backend_py/requirements.txt';

/**
 * 只给 Node 后端的进程选项：`node:sqlite` 在 22.x 是实验特性，每次启动往 stderr 打
 * `ExperimentalWarning`（R1c）——而 `plugin-backend.log` 是排障唯一证据源，噪声必须压掉。
 */
const NODE_EXTRA_FLAGS = ['--disable-warning=ExperimentalWarning'];

/**
 * 宿主 Node 能力探测（M8 新增）。判据是**能力**而不是版本号比较：
 * `node:sqlite` 从 22.5 才有、且 22.19 之前必须显式 `--experimental-sqlite` 才 import 得到
 * （方案 R1 实测：22.19 unflag 可用），而自编译/裁剪过的 Node 也可能没编进 sqlite。
 * 所以真 spawn 一个 `process.execPath`（＝随后要拉起后端的那一个二进制）探一次，
 * 探测用的 flags 与 env 与随后 spawn **同一份** —— 与「缺省解释器改真 spawn 探一次」同一条口径。
 *
 * 探到 `DatabaseSync` 不是函数也算失败：import 成功但 API 缺失（22.5-22.18 带 flag 的形态）
 * 会在建库那一刻才炸，那时用户看到的只是「后端起不来」。
 */
const NODE_PROBE_CODE = 'import("node:sqlite").then((m)=>{'
  + 'if(typeof m.DatabaseSync!=="function"){console.error("node:sqlite 无 DatabaseSync");process.exit(4)}'
  + 'console.log("node:sqlite ok");process.exit(0)},(e)=>{'
  + 'console.error(String((e&&e.message)||e));process.exit(3)})';
/** 探测超时（与 Python 侧 PREFLIGHT_TIMEOUT_MS 同量级：探不动就放行，绝不卡住激活） */
const NODE_PROBE_TIMEOUT_MS = 5000;

/** 解析 `config.backend`；未知值 warn 一句后按缺省 node 处理（不静默、不猜测） */
function resolveBackend(config, logger) {
  const raw = config.backend;
  if (raw === undefined || raw === null || raw === '') return BACKEND_NODE;
  if (raw === BACKEND_PYTHON || raw === BACKEND_NODE) return raw;
  logger.warn(`touchstone: 未知的 config.backend=${JSON.stringify(raw)}（只认 python/node），按缺省 node 处理`);
  return BACKEND_NODE;
}

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
 * 探一个候选解释器能不能真跑起来（`-c pass`, 5s 超时）。
 *
 * 为什么不是「查文件在不在」: spawn 走 PATH 解析, 而 Windows 的 Microsoft Store
 * 别名会在 PATH 上放一个 `python3.exe` 占位（是 GUI 应用, 跑起来不返回）——
 * 只有真跑一次才知道它是不是能用的解释器。任何异常（ENOENT/超时）都算不可用。
 * `env` 由调用方传（用 `{...process.env, ...extraEnv}`）: profile 的 extraEnv 可能改 PATH,
 * 探测必须与随后真正 spawn 后端的环境一致, 否则会出现「探测到 A、实际跑 B」。
 */
function canRunPython(name, env) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let proc = null;
    try {
      proc = spawn(name, ['-c', PYTHON_PROBE_CODE], { stdio: 'ignore', env });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* 已退出：忽略 */ }
      done(false);
    }, PYTHON_PROBE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    proc.on('error', () => { clearTimeout(timer); done(false); });
    proc.on('close', (code) => { clearTimeout(timer); done(code === 0); });
  });
}

/**
 * 解析未配置 pythonPath 时该用哪个解释器: 按 PYTHON_CANDIDATES 顺序探测, 返回第一个能跑的。
 * 全都跑不起来（或本平台一个都没有）时返回 null, 由调用方给明确的配置指引。
 */
async function resolveDefaultPython(env = process.env) {
  for (const name of PYTHON_CANDIDATES) {
    if (await canRunPython(name, env)) return name;
  }
  return null;
}

/**
 * 读 requirements.txt 的发行名清单（注释/空行/选项行跳过, 剥掉版本与 extras 约束）。
 * 读不到就返回空数组 —— 预检降级为「只验硬依赖」, 不影响启动。
 */
function readRequirementNames(repoDir) {
  try {
    return readFileSync(join(repoDir, PYTHON_REQUIREMENTS_REL), 'utf8')
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
function preflightDeps(pythonPath, repoDir, logger, env) {
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
    // env 必须显式传（与探测/启动后端同一份）: profile 的 extraEnv 可能改 PATH,
    // 不传就出现「探测用 A、预检用 B」的分裂（2026-10-11 自检抓到的真 bug）。
    const proc = spawn(pythonPath, argv, { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
 * 真 spawn 探一次宿主 Node 能力（判据与理由见 `NODE_PROBE_CODE`），返回
 * `{ ok, skipped, detail }`：
 *   ok=true   —— 能力齐备（`detail` 是子进程 stdout 那一行，进日志当证据）；
 *   ok=false  —— 探到了且不满足（`detail` = 子进程 stderr / 退出码）⇒ 调用方**不 spawn 后端**；
 *   skipped   —— 探测本身没跑成（超时 / 无法 spawn / 无输出）⇒ **照常启动后端**：
 *                与 Python 依赖预检同一口径（预检不确定不许阻断一个本来能跑的部署），
 *                真起不来还有「起来就崩」提示页兜底。
 *
 * env 必须与随后 spawn 后端同一份（profile 的 extraEnv 可能改 `NODE_OPTIONS`/`PATH`），
 * flags 也同一份（`NODE_EXTRA_FLAGS`）——「探测用 A、启动用 B」的分裂是 Python 侧踩过的真 bug。
 */
function probeNodeRuntime(execPath, flags, env) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const skip = (why) => settle({ ok: false, skipped: true, detail: why });
    let proc = null;
    try {
      proc = spawn(execPath, [...flags, '-e', NODE_PROBE_CODE], {
        cwd: homedir(), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      skip(error && error.message ? error.message : String(error));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      skip(`超过 ${NODE_PROBE_TIMEOUT_MS}ms`);
      try {
        proc.kill('SIGKILL');
      } catch { /* 已退出：忽略 */ }
    }, NODE_PROBE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    proc.stdout.on('data', (buf) => { stdout += String(buf); });
    proc.stderr.on('data', (buf) => { stderr += String(buf); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      skip(err.message);
    });
    // 用 close 而不是 exit：exit 可能早于 stdout 最后一个数据块（Python 预检的同一教训）。
    proc.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim().split('\n').pop() || '';
      const err = stderr.trim().split('\n').pop() || '';
      if (code === 0) {
        if (!out) { skip('无输出'); return; }
        settle({ ok: true, skipped: false, detail: out });
        return;
      }
      settle({ ok: false, skipped: false, detail: err || `探测进程退出 code=${code}` });
    });
  });
}

/**
 * 能力探测的测试缝（`dev-check-backend.mjs` 场景 G 用；生产路径恒为 null ⇒ 走真探测）。
 * 「宿主 Node 太老」这一支在真机上造不出来（本机是能力齐备的 Node），不给缝就只能是未验项。
 */
let nodeProbeForTest = null;
export function _setNodeRuntimeProbeForTest(fn) {
  nodeProbeForTest = fn;
}

/**
 * 依赖缺失时的面板提示页（代替 503 JSON）: 缺什么 + 一条可直接复制的修复命令
 * + 修完怎么让插件重来（停用再启用即会重跑 apply, 按 spec §8.8 不必重启 dsh web）。
 *
 * `viaDefault` = 这个解释器是缺省兜底探到的（用户没配 `pythonPath`）, 页面上要说明一句 ——
 * 否则用户修完命令仍可能指错解释器, 且不知道该往哪里配。
 */
function renderDepHint(pythonPath, repoDir, missing, viaDefault) {
  const cmd = `${pythonPath} -m pip install -r ${join(repoDir, PYTHON_REQUIREMENTS_REL)}`;
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
    + (viaDefault
      ? '<p style="color:#8b949e">上面这个解释器是<b>缺省探测</b>得到的（未配置 '
        + '<code>pythonPath</code>：依次试 <code>python</code>、<code>python3</code>）。'
        + '若它不是你机器上装了依赖的那个，直接在它里面装依赖最省事（上面这条命令就是）；'
        + '也可以改用另一个解释器 —— 在 profile patch 的 <code>touchstone-dsh</code> 条目里写 '
        + '<code>pythonPath</code> 指向它。</p>'
      : '<p style="color:#8b949e">若这个解释器不对，可在 profile patch 的 <code>touchstone-dsh</code> 条目里配置 '
        + '<code>pythonPath</code> 指向含这些依赖的解释器。</p>')
    + '</body></html>';
}

/**
 * 缺省解释器一个都跑不起来时的提示页: 这不是「缺依赖」而是「找不到 Python」,
 * 要给的是安装/配置指引, 不是 pip 命令（此时 pip 也没得跑）。
 */
function renderNoPythonHint() {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<title>Touchstone 后端未启动</title></head>'
    + '<body style="margin:0;padding:2rem;font:14px/1.75 ui-monospace,Menlo,Consolas,monospace;'
    + 'background:#14161a;color:#e6e6e6">'
    + '<h2 style="color:#ffb454;margin:0 0 .9rem">Touchstone 后端未启动：找不到 Python 解释器</h2>'
    + '<p>依次探测 <code>python</code>、<code>python3</code> 都没能跑起来（未配置 '
    + '<code>pythonPath</code>）。</p>'
    + '<p>请先安装 Python 3.12+（<code>python.org</code>，Windows 上安装时勾选 '
    + '<code>Add python.exe to PATH</code>），然后在 profile patch 的 '
    + '<code>touchstone-dsh</code> 条目里写 <code>pythonPath</code> 指向它；'
    + '若解释器已装好只是不在 PATH 上，也要靠这个配置项指过去。</p>'
    + '<p style="color:#8b949e">配置后把本插件<b>停用再启用</b>即会重试，不必重启 dsh web。</p>'
    + '</body></html>';
}

/**
 * Node 后端入口缺失时的提示页（缺省实现；也可显式配 `backend: node`）。
 * 与「找不到 Python」并列的一类失败：装的是老包（包里还没有 `backend/` 目录）、
 * 或 repoDir 指到了老检出。这条路径**不早退**——照常注册路由，面板因此能看到原因，
 * 而不是一个 404 白页。
 */
function renderNoNodeBackendHint(repoDir) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<title>Touchstone 后端未启动</title></head>'
    + '<body style="margin:0;padding:2rem;font:14px/1.75 ui-monospace,Menlo,Consolas,monospace;'
    + 'background:#14161a;color:#e6e6e6">'
    + '<h2 style="color:#ffb454;margin:0 0 .9rem">Touchstone 后端未启动：Node 后端入口缺失</h2>'
    + `<p>没找到 <code>${escapeHtml(`${repoDir}/backend/server.js`)}</code>，`
    + '而本插件走的是 Node 后端（<b>缺省实现</b>，也可显式配 <code>backend: node</code>）。</p>'
    + '<p>两种常见原因：① 装的是不含 Node 后端的旧包 —— 重跑 <code>dsh-plugin/install.sh</code>；'
    + '② profile patch 里的 <code>repoDir</code> 指向了另一个检出 —— 改成含 '
    + '<code>backend/server.js</code> 的那个目录，或删掉该项用缺省（包自身目录）。</p>'
    + '<p style="color:#8b949e">改完把本插件<b>停用再启用</b>即会重试，不必重启 dsh web。'
    + '要退回 Python 后端：把 <code>backend</code> <b>显式写成</b> <code>python</code>'
    + '（包里的 <code>backend_py/server.py</code> 仍在，Python 版未退役；注意<b>删掉该键现在等于 node</b>，'
    + '不能靠删键回退）。</p>'
    + '</body></html>';
}

/**
 * 宿主 Node 能力不足时的提示页（M8 新增）。为什么需要：缺省翻成 node 之后，
 * 「宿主 Node 太老」从「可选路径的边角情况」变成**默认路径上的头号失败**——
 * `node:sqlite` 在 22.5 才有、22.19 之前要显式 `--experimental-sqlite`，更老的 Node 直接没有这个 builtin。
 * 那时后端会在 import 期就退出，面板只会显示 503 JSON 或一段日志尾巴，用户不知道该升级什么、
 * 也不知道其实**有一条一行配置的退路**。
 */
function renderNodeRuntimeHint({ execPath, version, detail, logPath }) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<title>Touchstone 后端未启动</title></head>'
    + '<body style="margin:0;padding:2rem;font:14px/1.75 ui-monospace,Menlo,Consolas,monospace;'
    + 'background:#14161a;color:#e6e6e6">'
    + '<h2 style="color:#ffb454;margin:0 0 .9rem">Touchstone 后端未启动：宿主 Node 不满足要求</h2>'
    + `<p>当前运行 dsh 的 Node 是 <code>${escapeHtml(String(version))}</code>`
    + `（<code>${escapeHtml(String(execPath))}</code>），探测 <code>node:sqlite</code> 未通过：</p>`
    + `<pre style="background:#0d0f12;border:1px solid #2a2f36;border-radius:6px;padding:.8rem 1rem;`
    + `overflow:auto">${escapeHtml(String(detail || ''))}</pre>`
    + '<p>Node 后端要求 <b>Node &gt;= 22.19</b>（该版本起 <code>node:sqlite</code> 免 flag 可用；'
    + '22.5–22.18 需要 <code>--experimental-sqlite</code>，更老的版本没有这个内建模块）。'
    + '两条出路任选一条：</p>'
    + '<p>① <b>升级 Node 到 22.19+</b>，重启 dsh web（后端用的是宿主那个 Node，'
    + '与 PATH 上的 <code>node</code> 无关）；<br>'
    + '② <b>改回 Python 后端</b>：在 profile patch 的 <code>touchstone-dsh</code> 条目里'
    + ' <b>显式</b>写 <code>backend: python</code>（注意<b>删掉该键等于 node</b>），'
    + '然后停用再启用本插件 —— Python 版随包分发、未退役。</p>'
    + '<p style="color:#8b949e">后端日志：<code>'
    + `${escapeHtml(logPath || '<库目录>/plugin-backend.log')}</code></p>`
    + '</body></html>';
}

/**
 * 「同库单实例锁被另一个**活着的**宿主占用」的提示（2026-10-18 真机事故收口）。
 *
 * 真机形态（Windows，npm 安装）：DSH 桌面端（desktop profile）开着，它的 Touchstone 后端
 * 占着 `~/.touchstone/touchstone.db`；另一个 `dsh web`（web profile）再起后端就 exit 3。
 * 旧提示页只说「可能另有实例，或锁文件/归属记录残留 → 仍失败把 *.lock / *.pid 移走」：
 *   - 明明归属记录就在盘上（pid/ppid/repo_dir），却不点名是谁，用户得自己翻任务管理器；
 *   - 「移走锁文件」与项目红线矛盾（新实例会在新 inode 上取锁、与占用者双写）。
 * 所以这里按档给确切事实 + 只给安全出路（退出那个宿主 / 换独立库），并明确不许动锁文件。
 */
function renderLiveHolderHint(holder, dbPath) {
  // 独立库示例路径：与当前库同目录，改一个文件名即可（extraEnv.TOUCHSTONE_DB 接受绝对路径）
  const altDb = join(dirname(dbPath), 'touchstone-alt.db');
  const started = holder.startedAt
    ? new Date(holder.startedAt * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    : '';
  return '<p><b>同库单实例锁被占用</b>：占着这个库的是另一个<b>正在运行</b>的 Touchstone 后端 —— '
    + `<b>${escapeHtml(holder.host)}</b>（pid=<code>${holder.pid}</code>，`
    + `ppid=<code>${holder.ppid || '?'}</code>，父进程也存活）。`
    + '同一个库同一时刻只允许一个后端（防双写、防重复调度），所以本宿主退出码 <code>3</code>；'
    + '这不是「锁文件残留」。</p>'
    + '<ul style="margin:.2rem 0 .9rem 1.2rem;padding:0">'
    + `<li>占用者安装目录：<code>${escapeHtml(holder.repo || '（记录里没有 repo_dir）')}</code></li>`
    + `<li>归属记录：<code>${escapeHtml(holder.recordPath)}</code>`
    + `${started ? `（启动于 ${escapeHtml(started)}）` : ''}</li></ul>`
    + '<p>两条出路（任选一条）：</p>'
    + '<p>① <b>只用当前宿主</b>：把上面那个宿主退出（DSH 桌面端要从托盘彻底退出；'
    + '或直接在它的 Plugins 面板里停用 Touchstone —— 停用会回收它的后端），'
    + '然后在本面板把本插件<b>停用再启用</b>，即会重试。<br>'
    + '② <b>两个宿主都要用</b>：给本宿主换一个<b>独立库</b>（数据会分成两份）——在 profile 的 '
    + '<code>touchstone-dsh</code> 条目里加 <code>extraEnv.TOUCHSTONE_DB</code>，例如：</p>'
    + '<pre style="background:#0d0f12;border:1px solid #2a2f36;border-radius:6px;padding:.8rem 1rem;'
    + `overflow:auto">extraEnv:\n  TOUCHSTONE_DB: ${escapeHtml(altDb)}</pre>`
    + '<p>改完重启 dsh（config 值不热生效）。</p>'
    + '<p style="color:#ff6b6b"><b>不要删除或移动 <code>*.lock</code> / <code>*.pid</code></b>：'
    + '占用者还活着时移走锁文件，新实例会在新 inode 上取锁 ⇒ 两个后端同时写同一个库，可能损坏数据。'
    + '<code>--allow-shared-db</code> 同理，是自担双写风险的逃生口，不建议。</p>';
}

/** 归属记录已过期（pid 已退出）的提示：教「停用再启用」而不是教删锁文件 */
function renderStaleHolderHint(holder) {
  return '<p><b>同库单实例锁被占用</b>，但归属记录里的进程已经退出'
    + `（pid=<code>${holder.pid || '?'}</code>，ppid=<code>${holder.ppid || '?'}</code>；`
    + `记录文件 <code>${escapeHtml(holder.recordPath)}</code>）：这是上次进程被强杀留下的`
    + '<b>残留记录</b>（Windows 上 SIGTERM=TerminateProcess，退出清理跑不到）。</p>'
    + '<p>停用→启用本插件即会重试 —— 新版后端会自动接管失效的 <code>.pid</code> 记录并取锁；'
    + '<b>不需要</b>手动删除 <code>*.lock</code> / <code>*.pid</code>（删锁文件会在新 inode 上取锁，'
    + '有双写风险）。</p>';
}

/**
 * pid 存活但父进程已死的存疑档（2026-10-17 Windows 事故家族：pid 会被无关进程复用）。
 * 这一档**绝不能**说「另一个宿主正在运行」——把用户引去关一个并不存在的窗口是最好的误导。
 */
function renderAmbiguousHolderHint(holder) {
  return '<p><b>同库单实例锁被占用</b>，归属记录里的 pid 仍存在，但它的父进程已退出'
    + `（pid=<code>${holder.pid}</code>，ppid=<code>${holder.ppid || '?'}</code>；`
    + `记录文件 <code>${escapeHtml(holder.recordPath)}</code>）—— 可能是父死残留的孤儿后端，`
    + '也可能是 <b>PID 复用</b>（Windows 上同号进程被无关程序复用，2026-10-17 真机事故同型）⇒ '
    + '不能据此断定「另一个宿主还开着」。</p>'
    + '<p>先确认没有实例在跑（任务管理器里找带 <code>backend/server.js</code> / <code>backend_py/server.py</code> '
    + '的 node/python 进程），再停用→启用本插件重试。<b>不要删除或移动 <code>*.lock</code> / '
    + '<code>*.pid</code></b>：占用者若还活着，删锁文件会造成双写；新版后端会自动接管失效记录。'
    + '确需并行请给本宿主配置独立库（<code>extraEnv.TOUCHSTONE_DB</code>）。</p>';
}

/** code=3 的锁冲突提示：有归属记录按三档分派，没有记录走通用安全文案（一律不教删锁文件） */
function renderLockConflictHint(occupant, dbPath) {
  if (!occupant) {
    return '<p><b>同库单实例锁被占用</b>，但读不到 <code>*.pid</code> 归属记录：'
      + '可能是另一版后端的异常窗口（取锁后、写记录前被杀）或第三方进程占着这把锁。</p>'
      + '<p>先确认没有其它 Touchstone 后端在跑（任务管理器里找带 <code>backend/server.js</code> / '
      + '<code>backend_py/server.py</code> 的 node/python 进程），再停用→启用本插件重试。'
      + '<b>不要删除仍可能被占用的 <code>*.lock</code> / <code>*.pid</code></b>（新实例会在新 inode '
      + '上取锁 ⇒ 双写风险）；确需并行请给本宿主配置独立库（<code>extraEnv.TOUCHSTONE_DB</code>）。</p>';
  }
  if (occupant.status === 'live') return renderLiveHolderHint(occupant, dbPath);
  if (occupant.status === 'ambiguous') return renderAmbiguousHolderHint(occupant);
  return renderStaleHolderHint(occupant);
}

/**
 * `backend: node` 且进程**起来就崩**时的提示页（M0 评审 I3）。
 * 为什么需要：「入口缺失」只是新开关失败的一种；更常见的是入口在、跑不起来
 * （宿主 Node 版本不认 `--disable-warning`、`dist-plugin` 缺失、被执行策略拦、脚本自身报错）。
 * 那时 `backendPort` 一直是 0，proxy 只会回通用 503 JSON —— 面板里显示一段 JSON 原文，
 * 用户既不知道发生了什么、也不知道去哪看。提示页给四件事：失败原因、**后端最后几行输出**、
 * 日志路径、怎么回退。
 *
 * 2026-10-17 桌面端真机事故的教训：提示页原先只教用户自己 `tail` 日志文件（Windows 用户得先
 * 找到库目录、开终端），而失败原因（「同一数据库已有运行中的实例：pid=…」）就一行字。现改为
 * 把**内存里收到的最后几行**直接内联（见 apply 里的 `crashTail`）。
 * 2026-10-18 真机事故再补：`code=3` 的专项提示按 `<db>.pid` 归属记录分「活占用 / 存疑 / 残留」
 * 三档，活占用档点名是哪个宿主并给两条安全出路，全部档位都明确**不许删锁文件**（见上）。
 */
function renderBackendCrashHint({
  entryPath, logPath, code, signal, tailLines, occupant = null, dbPath = '',
}) {
  const logPathText = escapeHtml(logPath || '<库目录>/plugin-backend.log');
  const tail = (Array.isArray(tailLines) ? tailLines : [])
    .map((line) => String(line)).filter((line) => line.trim()).slice(-10);
  const tailBlock = tail.length
    ? '<p>后端进程最后输出（内存缓冲；启动失败原因通常就在最后几行）：</p>'
      + '<pre style="background:#0d0f12;border:1px solid #2a2f36;border-radius:6px;'
      // 失败原因那行很长（占用者 pid/ppid/repo 全在一行），必须换行显示，别让用户横向滚动找证据
      + 'padding:.8rem 1rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">'
      + `${escapeHtml(tail.join('\n'))}</pre>`
    : '';
  // code=3 在**两版后端**里都是「同库单实例锁没拿到」（server.py 与 backend/server.js 的
  // exit 3 同义，见 spec §十九）。按归属记录分档，别让用户对着 generic 文案猜。
  const isLockConflict = String(code) === '3';
  const liveHolder = isLockConflict && occupant && occupant.status === 'live' ? occupant : null;
  const heading = liveHolder
    ? `Touchstone 后端未启动：同一个库正被 ${liveHolder.host}使用`
    : 'Touchstone 后端未启动：Node 后端进程退出';
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<title>Touchstone 后端未启动</title></head>'
    + '<body style="margin:0;padding:2rem;font:14px/1.75 ui-monospace,Menlo,Consolas,monospace;'
    + 'background:#14161a;color:#e6e6e6">'
    + `<h2 style="color:#ffb454;margin:0 0 .9rem">${escapeHtml(heading)}</h2>`
    + `<p>入口 <code>${escapeHtml(entryPath)}</code> 起来了但没有报出监听端口就退出`
    + `（code=${escapeHtml(String(code))}${signal ? `, signal=${escapeHtml(String(signal))}` : ''}）。</p>`
    + tailBlock
    + (isLockConflict ? renderLockConflictHint(occupant, dbPath) : '')
    + '<p>下一步：看完整后端日志里的最后几行（启动失败原因就在那里）——</p>'
    + `<pre style="background:#0d0f12;border:1px solid #2a2f36;border-radius:6px;padding:.8rem 1rem;`
    + `overflow:auto">tail -n 40 ${logPathText}</pre>`
    + '<p>常见原因：<code>dist-plugin</code> 构建产物缺失、被执行策略拦下、入口脚本自身报错、'
    + '同库单实例锁被占/残留（<code>code=3</code>）。'
    + '若日志里是 <code>node:sqlite</code> / <code>ERR_UNKNOWN_BUILTIN_MODULE</code> 一类，'
    + '那是宿主 Node 太老 —— 升级到 22.19+ 或改回 <code>backend: python</code>。'
    + '改完把本插件<b>停用再启用</b>即会重试。</p>'
    + '<p style="color:#8b949e">要退回 Python 后端：把 profile 里的 <code>backend</code> '
    + '<b>显式写成</b> <code>python</code>（Python 版随包分发、未退役；'
    + '注意<b>删掉该键现在等于 node</b>）。</p>'
    + '</body></html>';
}

/**
 * 插件形态后端日志路径：与子进程用的**同一个库**同目录（`<库目录>/plugin-backend.log`）。
 * 不落 node_modules 下的 .run：装机目录可能只读、重装即清，而且日志跟着库走才对得上
 * 首启口令与运行审计。库路径优先级与 server.py 侧一致：extraEnv（profile 显式配置）
 * > 宿主环境 > 缺省 `~/.touchstone/touchstone.db`。
 */
function backendLogPath(extraEnv) {
  return join(dirname(resolveDbPath(extraEnv)), BACKEND_LOG_NAME);
}

/**
 * 库路径解析（日志与 `<db>.pid` 记录共用）：`extraEnv.TOUCHSTONE_DB` > 宿主环境 `TOUCHSTONE_DB`
 * > 缺省 `~/.touchstone/touchstone.db`。与 server.py / backend/lib/lock.js 的 `resolveDbPath`
 * 同源，仅用来把日志与归属记录定位到「同库同目录」——薄壳自己不打开库文件。
 */
function resolveDbPath(extraEnv = {}) {
  return resolve(extraEnv.TOUCHSTONE_DB || process.env.TOUCHSTONE_DB
    || join(homedir(), '.touchstone', 'touchstone.db'));
}

/** 读 `<db>.pid` 归属记录（不存在/坏 JSON/不是对象 ⇒ null）。字段与两版后端的 writePidRecord 同源 */
function readPidRecord(pidPath) {
  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    return record;
  } catch {
    return null;
  }
}

/** 进程探活（与 backend/lib/proc.js 的 pidAlive 同口径：ESRCH 不存在，EPERM 视为存活） */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * 从归属记录的 `repo_dir` 认出占用者属于哪个 DSH 宿主。
 * 为什么靠路径认：`desktop` profile 是 Electron 桌面端独占（CLI 拒绝管理），而 npm 安装副本
 * 都落在 `<home>/.dsh/profiles/<profile>/node_modules/@gavinc-cn/touchstone-dsh` ——
 * 把 profile 名翻译成人话，用户才知道该去哪个窗口里关它（真机事故里就是这个信息缺失）。
 */
function describeHolderHost(repoDir) {
  const text = String(repoDir || '');
  const match = text.match(/[\\/]profiles[\\/]([^\\/]+)[\\/]/i);
  if (!match) return '另一个 DSH 宿主/检出';
  const profile = match[1];
  if (profile.toLowerCase() === 'desktop') return 'DSH 桌面端（desktop profile）';
  if (profile.toLowerCase() === 'web') return 'dsh web（web profile）';
  return `DSH 宿主（${profile} profile）`;
}

/**
 * 读 `<db>.pid` 并判「占用者是否真的还活着」（2026-10-18 真机事故收口）。
 *
 * code=3 的提示页此前只会让用户猜「可能另有实例，或锁文件/归属记录残留」——而归属记录就在
 * 盘上，里面的 pid/ppid/repo_dir 足够点名「是哪个宿主占着」，也足够区分三档：
 *   - `live`      ：pid 存活，且（非父死感知托管 ‖ 其父进程也存活）⇒ 另一个真开着的宿主；
 *   - `ambiguous` ：pid 存活但 `parent_watch=true` 且父进程已死 ⇒ 父死残留/PID 复用，**不能**
 *                   断言「另一个宿主还开着」（2026-10-17 Windows 事故家族：pid 会被无关进程复用）；
 *   - `stale`     ：pid 已不存在 ⇒ 记录过期。
 * 与 backend/lib/lock.js 的 `reapStale` 同思路，但**只读不杀**（薄壳不处置别的宿主进程）。
 *
 * @returns {null | {pid,ppid,repo,host,backend,startedAt,parentWatch,recordPath,status:'live'|'ambiguous'|'stale'}}
 */
function inspectLockHolder(extraEnv) {
  const recordPath = `${resolveDbPath(extraEnv)}.pid`;
  const record = readPidRecord(recordPath);
  if (!record) return null;
  const pid = Number(record.pid);
  const ppid = Number(record.ppid);
  const pidOk = Number.isInteger(pid) && pid > 0;
  const ppidOk = Number.isInteger(ppid) && ppid > 1;
  const alive = pidOk && pidAlive(pid);
  const parentAlive = ppidOk && pidAlive(ppid);
  let status = 'stale';
  if (alive) status = (!record.parent_watch || parentAlive) ? 'live' : 'ambiguous';
  return {
    pid: pidOk ? pid : 0,
    ppid: ppidOk ? ppid : 0,
    repo: typeof record.repo_dir === 'string' ? record.repo_dir : '',
    host: describeHolderHost(record.repo_dir),
    backend: typeof record.backend === 'string' ? record.backend : '',
    startedAt: Number(record.started_at) > 0 ? Number(record.started_at) : 0,
    parentWatch: Boolean(record.parent_watch),
    recordPath,
    status,
  };
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
 *   pythonPath Python 解释器（可选; 缺省按 `python` → `python3` 顺序真跑一次探一个,
 *              本机该指含 zstandard 的 conda env 或已 pip 装过依赖的那支）
 *   extraEnv   透传子进程的额外环境变量（如 TOUCHSTONE_DB 指向隔离实例库）
 * 返回组合 disposer（注销路由 + 断开驱动 + SIGTERM 子进程），dsh 停用插件时调用；
 * 另有「启用即回收上一份壳」与「掉线自检」两条自愈路径（见文件头注释）。
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ? ctx.logger('touchstone') : console;
  // repoDir 缺省 = 包自身目录（自包含包: 包里就有 backend/server.js、backend_py/server.py 与
  // webui/dist-plugin）, 用户零配置即可跑;
  // 显式 config.repoDir 仍优先 —— 要指向开发中的工作副本、或包被拆开放置时才需要写。
  const repoDir = config.repoDir || PACKAGE_DIR;
  const backend = resolveBackend(config, logger);
  const entryRel = backend === BACKEND_NODE ? NODE_ENTRY_REL : PYTHON_ENTRY_REL;
  const entryPath = join(repoDir, entryRel);
  const entryMissing = !existsSync(entryPath);
  if (entryMissing) {
    logger.warn(`touchstone: 找不到 ${entryPath}（repoDir 配置有误, 或安装包不完整）`);
    // Python 侧行为与改动前一致：不注册路由、直接退出（存量用户不受影响）。
    // Node 侧改为继续往下走：注册路由 + backendHint，让新开关的失败在面板里自解释。
    if (backend !== BACKEND_NODE) return;
    backendHint = renderNoNodeBackendHint(repoDir);
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

  // 两个后端共用的参数尾巴（方案 §3.2 的进程契约）：只差入口路径与 node 的进程选项，
  // 因此从入口之后的部分**逐字相同** —— 薄壳不需要为哪个后端分叉。
  const args = [
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
  // 解释器（2026-10-11 改）: 配置优先; 没配就按 `python` → `python3` 真探一次
  // （Windows 上没有 python3 这个名字, 写死它会直接 ENOENT——那样连缺依赖都报不出来）。
  // 探测用「与随后 spawn 后端同一份 env」, extraEnv 里改过 PATH 时两者才一致。
  //
  // 这一段按 backend 分叉**只到「决定用什么命令拉起」为止**：探测/预检属 Python 专有，
  // 之后 spawn、日志落盘、端口解析、退出处理全部共用（见下面的 launch 分支）。
  const childEnv = { ...process.env, ...extraEnv };
  let myChild = null;
  /** 本次壳的开的后端日志流（teardown 关闭；null = 不可用/未启动） */
  let myLog = null;
  /** 待拉起的命令（null = 本次不拉后端：入口缺失/缺依赖/缺解释器，三种都有提示页） */
  let launch = null;
  if (backend === BACKEND_NODE) {
    // Node 后端：不探测解释器、不跑依赖预检、不会有缺依赖提示页。
    // 用 process.execPath（= 当前 dsh 宿主跑的那个 node）而不是 PATH 上的 `node`：
    // 用户机器上可能根本没有 node 在 PATH 里（dsh 自己是打包运行的），
    // 而且这样能保证「探测的 Node」与「拉起后端的 Node」是同一个二进制（同一个 runtime）。
    if (!entryMissing) {
      // 能力探测（M8）：探不到的常见形态是 import 期就退出的后端 —— 那时日志里只有一行
      // `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`，用户无从下手。
      // 探测本身不确定（超时/无法 spawn）**不阻断启动**，见 probeNodeRuntime。
      const probe = nodeProbeForTest
        ? await nodeProbeForTest()
        : await probeNodeRuntime(process.execPath, NODE_EXTRA_FLAGS, childEnv);
      const logPath = backendLogPath(extraEnv);
      if (probe.ok) {
        backendHint = '';
        // 观测期（Gate 1）要靠这行判「这次到底跑的是哪一版、跑在什么 Node 上」。
        logger.info(`touchstone: 宿主 Node ${process.versions.node} 能力探测通过（${probe.detail}）`);
        launch = { cmd: process.execPath, argv: [...NODE_EXTRA_FLAGS, entryPath, ...args] };
      } else if (probe.skipped) {
        backendHint = '';
        logger.warn(`touchstone: 宿主 Node 能力探测未完成（${probe.detail}）, 照常启动后端`);
        launch = { cmd: process.execPath, argv: [...NODE_EXTRA_FLAGS, entryPath, ...args] };
      } else {
        backendHint = renderNodeRuntimeHint({
          execPath: process.execPath, version: process.versions.node, detail: probe.detail, logPath,
        });
        logger.warn(`touchstone: 后端未启动 —— 宿主 Node ${process.versions.node} 不满足要求: ${probe.detail}`);
        logger.warn('touchstone: 两条出路: ① 升级 Node 到 >= 22.19 后重启 dsh web; '
          + '② 在本插件 config 里显式写 backend: python（Python 版随包分发、未退役）后停用再启用');
      }
    }
  } else {
    const pythonPath = config.pythonPath || await resolveDefaultPython(childEnv);
    if (!pythonPath) {
      backendHint = renderNoPythonHint();
      logger.warn(`touchstone: 找不到 Python 解释器（依次试过 ${PYTHON_CANDIDATES.join(', ')}）, 插件不启动后端`);
      logger.warn('touchstone: 请安装 Python 3.12+ 或在本插件 config 里配 pythonPath, 然后停用再启用');
      return;
    }
    const viaDefault = !config.pythonPath;
    if (viaDefault) logger.info(`touchstone: 未配置 pythonPath, 缺省探到解释器: ${pythonPath}`);
    const deps = await preflightDeps(pythonPath, repoDir, logger, childEnv);
    if (deps.fatal.length) {
      backendHint = renderDepHint(pythonPath, repoDir, deps.fatal, viaDefault);
      logger.warn(`touchstone: 后端未启动 —— Python 运行依赖缺失: ${deps.fatal.join(', ')}`);
      logger.warn(`touchstone: 修复: ${pythonPath} -m pip install -r ${join(repoDir, PYTHON_REQUIREMENTS_REL)}`);
      logger.warn('touchstone: 装完把本插件停用再启用即会重试（不必重启 dsh web）');
    } else {
      backendHint = '';
      if (deps.advisory.length) {
        logger.warn(`touchstone: 可选依赖未安装（只影响对应功能, 不影响启动）: ${deps.advisory.join(', ')}`);
      }
      launch = { cmd: pythonPath, argv: [entryPath, ...args] };
    }
  }

  if (launch) {
    logger.info(`touchstone: 启动后端（${backend}） ${launch.cmd} ${launch.argv.join(' ')}`);
    // stdio[0] 必须是 pipe 且**永不写入**：这是父死感知的 A 通道——dsh 进程无论
    // 优雅退出还是被 kill -9，OS 都会关闭该管道写端，后端读到 EOF 即自主退出
    // （Python 侧实测父 kill -9 后 1.94s 退出；Node 侧走 process.stdin 的 end/close）。
    // 改成 'ignore' 会让该通道失效。
    myChild = spawn(launch.cmd, launch.argv, {
      cwd: repoDir,
      env: childEnv,
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
    let sawListen = false;   // 是否报出过监听端口（判「起来就崩」用，见 renderBackendCrashHint）
    // 崩溃提示页要内联「最后几行输出」：从管道现收一份内存环形缓冲。为什么不读日志文件——
    // 日志是 append 写流（异步落盘），退出的那一刻盘上可能还差最后几行；只有这里保存的是
    // pumpLines **已经交付**的完整行（2026-10-17 桌面端真机事故：失败原因就一行，但用户拿不到）。
    const CRASH_TAIL_LINES = 12;
    const crashTail = [];
    const keepLine = (line) => {
      crashTail.push(line);
      if (crashTail.length > CRASH_TAIL_LINES) crashTail.shift();
    };
    pumpLines(myChild.stdout, (line) => {
      writeLog(line);
      keepLine(line);
      const m = line.match(/^TOUCHSTONE_LISTEN (\d+)/);
      if (m) {
        sawListen = true;
        backendPort = Number(m[1]);
        logger.info(`touchstone: 后端就绪 127.0.0.1:${backendPort}`);
      }
    });
    pumpLines(myChild.stderr, (line) => {
      writeLog(line);
      keepLine(line);
      if (line.trim()) logger.warn(`touchstone[${backend === BACKEND_NODE ? 'node' : 'py'}]: ${line.trim()}`);
    });
    // 「起来就崩」不再只留一行 dsh 日志：Node 分支给面板一个可读提示页（Python 分支行为不动）。
    // 2026-10-18：code=3 时把 `<db>.pid` 归属记录读出来一起渲染（谁占着、是否真活着），
    // 并往宿主日志打一行摘要 —— 真机上用户拿不到面板时，dsh 日志就是唯一线索。
    let crashNoted = false;
    const crashed = (code, sig) => {
      if (sawListen || backend !== BACKEND_NODE) return;   // 只在 Node 分支、且从未就绪时给提示页
      const occupant = inspectLockHolder(extraEnv);
      if (!crashNoted && occupant) {
        crashNoted = true;
        const holderState = occupant.status === 'live' ? '仍在运行'
          : occupant.status === 'ambiguous' ? '父进程已死（疑似残留/PID 复用）' : '已退出（残留记录）';
        logger.warn(`touchstone: 同库单实例锁被占 —— ${occupant.host} pid=${occupant.pid} `
          + `ppid=${occupant.ppid || '?'} repo=${occupant.repo || '-'}（占用者进程${holderState}）`);
      }
      backendHint = renderBackendCrashHint({
        entryPath, logPath: backendLogPath(extraEnv), code, signal: sig,
        tailLines: crashTail.slice(), occupant, dbPath: resolveDbPath(extraEnv),
      });
    };
    myChild.on('exit', (code, sig) => {
      writeLog(`[touchstone] 后端退出 code=${code} sig=${sig}`);
      logger.warn(`touchstone: 后端退出 code=${code} sig=${sig}`);
      crashed(code, sig);
    });
    // `exit` 可能先于 stdio 最后几个 chunk 交付（Node 文档：exit 后仍可能收到 data），
    // `close` 才是「stdio 全部读空」。补渲染一次，让提示页里的最后几行是完整的。
    myChild.on('close', (code, sig) => crashed(code, sig));
    myChild.on('error', (err) => {
      writeLog(`[touchstone] 后端拉起失败: ${err.message}`);
      logger.warn(`touchstone: 后端拉起失败: ${err.message}`);
      crashed('spawn-error', null);
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

// 自检入口（2026-10-11）: `node lib/index.js --resolve-python` 打印缺省解释器解析结果
// —— 给 scripts/dev-check-python.mjs 用真 PATH 驱动「python → python3」探测顺序的判决,
// 也方便排障时在用户机器上一条命令看到「本机探到哪支」。命中输出名字、退出码 0;
// 一个都探不到输出一行错误、退出码 1。被 dsh import 时 process.argv[1] 不是本文件, 不触发。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    && process.argv.includes('--resolve-python')) {
  const found = await resolveDefaultPython();
  if (found) {
    console.log(found);
    process.exit(0);
  }
  console.error(`no python interpreter found (tried: ${PYTHON_CANDIDATES.join(', ')})`);
  process.exit(1);
}
