/**
 * 进程探活与进程树终止（Node 后端对 `platcompat` + `lifecycle` 的等价实现，M1）。
 *
 * 为什么单独一个模块：单实例锁的「存量孤儿收口」要判活 + **只向单个 pid** 发信号，
 * 后续里程碑的退出清理要连子进程树一起收掉；两处都要求零依赖、可单测。
 *
 * 与 Python 侧的逐项对应（2026-10-11 复核 platcompat.py / lifecycle.py）：
 *   `platcompat.pid_alive`          → pidAlive          ：POSIX `kill(pid, 0)`；EPERM 视为存活
 *   `lifecycle._looks_like_server`  → looksLikeBackend  ：读命令行的粗校验（防 PID 复用误杀）
 *   `lifecycle._term_pid`           → terminatePid      ：只向单个 pid 发信号，异常全吞
 *   `platcompat.kill_tree`          → killTree          ：整树终止（口径见下）
 *   `platcompat.spawn_session`      → spawnSession      ：独立进程组的后台子进程（口径见下）
 *
 * killTree 的取舍（与 Python 侧的**有意差异**，务必读）：
 *   - Python POSIX 走 `killpg(getpgid(pid))`，要求目标自成进程组（`spawn_session` 保证）；
 *     Windows 走 psutil「先子孙后自身」。**Node 没有「进程组归属」的现成读口**，而调用点
 *     未必 setsid——薄壳起来的后端与 dsh 宿主同组，`killpg` 等价物在 Node 里就是「杀掉宿主」。
 *     Python 侧 `lifecycle._safe_kill_tree` 正是为此加了「同组降级为单进程」的防护；
 *     Node 侧一律按**父子关系递归收树**，天然不会碰到无关的同组进程。
 *   - 信号升级口径照抄 `lifecycle.kill_children`：先 SIGTERM → 宽限 `KILL_GRACE_MS` → 仍活则 SIGKILL。
 *     判活用 `isRunning`（比 `pidAlive` 多认僵尸）：等待是同步的，自己的子进程在父 reap 前
 *     一直是僵尸，只认 `pidAlive` 会白等满宽限并向僵尸投 SIGKILL（详见 isRunning 注释）。
 *
 * 依据（Linux，本机实测可用）：`/proc/<pid>/task/<tid>/children` 给出该线程**直接子进程**的
 * pid 列表（空格分隔，Linux 3.5+）。**逐线程读**是必需的：子进程可能由任意线程 fork 出来，
 * 只读主线程会漏掉。无 `/proc` 的平台（macOS 等）回落 `ps -A -o pid=,ppid=` 的父子表；
 * Windows 无 ps（Python 侧靠 psutil），此时退化为「只终止已知 pid」，见 collectDescendants 注释。
 *
 * 不实现 `platcompat.listen_ports`：Python 侧它已随 kimi web/opencode serve 退场、暂无调用方，
 * M1 也不需要（端口归属判定在 POSIX 由调用方读 /proc 承担）。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

/** SIGTERM 后升级 SIGKILL 的宽限（毫秒）。对齐 `lifecycle.KILL_GRACE = 1.5s` */
export const KILL_GRACE_MS = 1500;
/** 等待进程退出的轮询间隔（毫秒）。对齐 Python 侧 `time.sleep(0.05)` 的同量级口径 */
export const POLL_MS = 50;

/** 同步 sleep 用的共享缓冲（Atomics.wait：主线程可用的同步等待，不占 CPU） */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

/** 同步睡眠（毫秒）。killTree 是同步 API（对齐 `platcompat.kill_tree`），不能用 await */
function sleepMs(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

/**
 * 进程探活（对齐 `platcompat.pid_alive`）：存在且有权发信号 ⇒ true。
 *
 * `process.kill(pid, 0)` 只做存在性校验、不投递信号；EPERM（进程存在但无权发信号，
 * 例如别人的 root 进程）按 Python 同口径视为**存活**，ESRCH/EINVAL 视为不存在。
 * 注意：僵尸进程同样算「存活」（`kill(pid, 0)` 成功）——与 Python 行为一致，
 * 调用方若需要「真退出」应等自己的子进程 exit 事件（父进程 reap 之后 pid 才消失）。
 */
export function pidAlive(pid) {
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
 * 进程是否仍在**运行**（比 `pidAlive` 更严：Linux 上僵尸进程不算）。
 *
 * 为什么需要这一层：本项目的等待循环都是**同步**的（`Atomics.wait` 阻塞事件循环），
 * 而自己直接 spawn 的子进程在父进程 reap 之前会一直以僵尸形态存在——事件循环被阻塞时
 * 根本不会去 reap，`pidAlive` 便一直为真，等待方会白等满宽限、向僵尸白投 SIGKILL。
 * 生产路径（存量孤儿是上一轮运行的残留，不是本进程的子进程）不受影响，但
 * 「父进程自己收子进程」与全部测试场景必须认僵尸，否则宽限/升级计数全是假的。
 *
 * Linux 依据：`/proc/<pid>/stat` 的 `state` 字段 `Z`。comm 字段可能含空格与括号，
 * 故取**最后一个 `)` 之后**的第一个字符（内核文档推荐的解析方式）。
 * 非 Linux（无僵尸语义）与读不到 stat 时退化为 `pidAlive` 的口径。
 */
export function isRunning(pid) {
  if (!pidAlive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return stat.slice(close + 2, close + 3) !== 'Z';
  } catch {
    return true;                                 // 读不到就按 pidAlive 的口径算活着（宁可不杀）
  }
}

/**
 * 拉起「独立进程组」的后台子进程（对齐 `platcompat.spawn_session`，M6.5-R2 落地）。
 *
 * POSIX 语义 = `subprocess.Popen(..., start_new_session=True)`：`detached: true` 让子进程
 * `setsid()`，自成会话亦即新进程组——`killTree(pid)` 的「整树」语义与「用户停止发压」
 * 都靠它（脚本可能自起子进程，只杀组长会留孤儿）。
 *
 * 与 Python 侧的**有意差异**（逐条备案）：
 *   - Python 把 `preexec_fn` 透传给 Popen（父死联动 PDEATHSIG 等）；Node 的 `spawn` 无
 *     preexec 口，且**当前无调用方**（唯一生产调用点 `_spawn_load` 不传）⇒ 本函数不收该参数；
 *   - Windows：Python 显式丢弃 `start_new_session` 并加 `CREATE_NO_WINDOW`（隐藏控制台窗口）；
 *     Node 的 `detached: true` 在 Windows 上是 `DETACHED_PROCESS`（同样脱离控制台），
 *     无 CREATE_NO_WINDOW 位的等价设置——Windows 不在 M6.5 的判据面内，登记不追。
 *   - **启动失败是异步的**：Python `Popen` 在 fork 失败时**同步抛** OSError，Node 的 `spawn`
 *     把 ENOENT/EACCES 这类错误放到 `'error'` 事件上 ⇒ 调用方必须等 `'spawn'/'error'`
 *     二者之一才算「拉起来了」（`runner.spawnLoad` 就是照 Python 的 try/except OSError 写的）。
 *
 * @param {string[]|string} cmd 完整 argv（`[可执行文件, …参数]`）
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, stdio?: Array}} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnSession(cmd, { cwd, env, stdio } = {}) {
  const argv = Array.isArray(cmd) ? cmd : [cmd];
  const options = { detached: true };
  if (cwd !== undefined) options.cwd = cwd;
  if (env !== undefined) options.env = env;
  if (stdio !== undefined) options.stdio = stdio;
  return spawn(argv[0], argv.slice(1), options);
}

/**
 * 只向**单个 pid** 发信号（对齐 `lifecycle._term_pid`）：异常一律吞（收口失败由调用方的
 * 等待循环兜底）。返回是否成功投递。
 *
 * 收口存量孤儿**绝不能**用本函数之外的进程组/树动作：孤儿往往与它的宿主（乃至正在启动
 * 我们的这个 dsh 进程）同组，`killpg` 会连带杀掉自己——Python 侧实测踩中过。
 * Windows 说明：Node 在 Windows 上对任何信号都走 TerminateProcess（无优雅信号可投递），
 * 与 `lifecycle._term_pid` 的 psutil 分支同效。
 */
export function terminatePid(pid, sig = 'SIGTERM') {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, sig);
    return true;
  } catch {
    return false;
  }
}

/** 读一个 pid 的**直接子进程**：Linux 走 /proc（逐线程），其余平台回落 ps 父子表 */
function directChildren(pid) {
  if (process.platform === 'linux') return procChildren(pid);
  return psChildren(pid);
}

/**
 * Linux：逐线程读 `/proc/<pid>/task/<tid>/children`。
 * 读不到（进程刚消失、权限不足、线程正在退出）一律跳过——收集是尽力而为，
 * 漏掉的孙进程会因父死被 init 收养，不再属于本树。
 */
function procChildren(pid) {
  const out = [];
  let tids;
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;                                  // 进程已退出/无 /proc：无子进程可收
  }
  for (const tid of tids) {
    let text = '';
    try {
      text = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8');
    } catch {
      continue;                                  // 线程刚消失：忽略
    }
    for (const token of text.trim().split(/\s+/)) {
      const child = Number(token);
      if (Number.isInteger(child) && child > 0 && !out.includes(child)) out.push(child);
    }
  }
  return out;
}

/**
 * 非 Linux 回落：`ps -A -o pid=,ppid=`（Linux/BSD 都认）建一次父子表。
 * `ps` 不可用（Windows 无 ps）时返回空表 ⇒ 收树退化为「只终止根 pid」，
 * 与「Node 版 Windows 尚无 psutil 等价物」的现状一致（M1 不把 Windows 树杀当承诺）。
 */
function psChildren(pid) {
  let text = '';
  try {
    text = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m && Number(m[2]) === Number(pid)) out.push(Number(m[1]));
  }
  return out;
}

/**
 * 收集 pid 的**全部后代**（不含自身），宽度优先 ⇒ 父一定排在子前面。
 * 调用方按需 reverse 得到「先子孙后自身」的终止顺序。带 visited 去重防环。
 */
export function collectDescendants(pid) {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 0) return [];
  const seen = new Set([root]);
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of directChildren(current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * 整树终止（对齐 `lifecycle.kill_children` 的顺序 + `platcompat.kill_tree` 的「整树」语义）。
 *
 * 顺序：**先子孙、后自身**（父先死会让子孙被 init 收养、父子关系丢失，反而更难收）。
 * 过程：对全树投一次 SIGTERM → 等 `graceMs`（轮询，全树不再运行即提前结束）→
 * 对仍在运行的升级 SIGKILL。
 * 异常面：本函数**不抛**（与 `lifecycle._safe_kill_tree` 吞 OSError 同口径），
 * 已消失/无权的 pid 直接跳过。
 *
 * 返回 `{signaled, killed, alive}`：投递信号的目标数、升级 SIGKILL 的个数、
 * 调用结束时**仍在运行**的 pid 列表（僵尸按「已退出」计，见 `isRunning`——
 * 否则父进程自己收子进程时永远收不了尾）。
 */
export function killTree(pid, { sig = 'SIGTERM', graceMs = KILL_GRACE_MS } = {}) {
  const root = Number(pid);
  const result = { signaled: 0, killed: 0, alive: [] };
  if (!Number.isInteger(root) || root <= 0) return result;

  const descendants = collectDescendants(root);
  const targets = [...descendants.reverse(), root];   // 子孙在前，自身最后
  for (const target of targets) {
    if (terminatePid(target, sig)) result.signaled += 1;
  }

  const deadline = Date.now() + Math.max(Number(graceMs) || 0, 0);
  while (targets.some((target) => isRunning(target)) && Date.now() < deadline) {
    sleepMs(POLL_MS);
  }

  for (const target of targets) {
    if (!isRunning(target)) continue;                 // 已退出/僵尸：不升级（僵尸不该再收信号）
    terminatePid(target, 'SIGKILL');
    result.killed += 1;
  }
  result.alive = targets.filter((target) => isRunning(target));
  return result;
}

/** Windows 命令行查询缓存：同一次判定里同一 pid 可能被问两遍（liveForeignHolder + writePidRecord） */
const WIN_CMDLINE_CACHE = new Map();
const WIN_CMDLINE_CACHE_MAX = 32;

/** 往缓存里记一条（超限丢最早的；数字键的插入序即写入序，够用） */
function cacheWinCmdline(pid, value) {
  if (WIN_CMDLINE_CACHE.size >= WIN_CMDLINE_CACHE_MAX) {
    WIN_CMDLINE_CACHE.delete(WIN_CMDLINE_CACHE.keys().next().value);
  }
  WIN_CMDLINE_CACHE.set(pid, value);
  return value;
}

/**
 * Windows：用系统自带工具读 pid 的命令行。读不到返回 null。
 *
 * 为什么不是「读不到就算它是后端」：**判据会被用在两个方向**——
 *   ① `liveForeignHolder` 用它决定「要不要拒绝启动」（exit 3）；
 *   ② `reapStale` 用它决定「要不要 SIGTERM 掉这个 pid」。
 * 2026-10-17 桌面端真机事故（npm 0.3.0 / Windows）就是①：Node 后端被 TerminateProcess 硬杀后
 * `.pid` 残留、其 pid 被 OpenConsole.exe 复用，旧实现 `非 linux ⇒ return true` 让「没有活实例」
 * 永久误判成「已有运行中的实例」⇒ 面板再也打不开。两个方向误判的代价都远大于「确认不了就放行」。
 *
 * 工具选择（零 npm 依赖红线）：PowerShell 的 CIM（Win7+ 自带，`-NoProfile -NonInteractive` 尽量快）
 * 优先；`wmic` 兜底（Win10/11 仍可用，但已被微软标记弃用）。权限不足时输出为空，用 wmic 再试。
 */
function windowsProcessCmdline(pid) {
  if (WIN_CMDLINE_CACHE.has(pid)) return WIN_CMDLINE_CACHE.get(pid);
  const opts = { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  let text = '';
  try {
    const script = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '"; '
      + 'if ($p -and $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }';
    text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts);
  } catch {
    /* 没有 PowerShell / 超时 / 权限不足：退 wmic */
  }
  if (text && text.trim()) return cacheWinCmdline(pid, text.trim());
  try {
    const out = execFileSync('wmic',
      ['process', 'where', `processid=${pid}`, 'get', 'commandline', '/value'], opts);
    const line = String(out || '').split(/\r?\n/).find((l) => l.startsWith('CommandLine='));
    if (line && line.length > 'CommandLine='.length) {
      return cacheWinCmdline(pid, line.slice('CommandLine='.length).trim());
    }
  } catch {
    /* 无 wmic（新系统可能已移除）/ 超时：确认不了 */
  }
  return cacheWinCmdline(pid, null);
}

/**
 * 读 pid 的真实命令行（字符串；读不到 null，绝不抛）。
 *
 * `platform` 是显式形参而不是直接读 `process.platform`，为了单测能**在 Linux 上验 Windows
 * 分支**（真机事故形态没法在 CI 复现，见 `backend/test/proc.test.mjs` 的注入用例）。
 * macOS 等 POSIX：`ps -p <pid> -o command=`。
 */
function readProcessCmdline(pid, platform) {
  if (platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      return null;                                   // 进程刚消失/无权限：确认不了
    }
  }
  if (platform === 'win32') return windowsProcessCmdline(pid);
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * 命令行粗校验：这个 pid 是否**像**本平台后端（防 PID 复用误杀，对齐
 * `lifecycle.SingleInstance._looks_like_server`）。
 *
 * 与 Python 的差异：Python 只认 `server.py`；Node 侧**同时接受 `backend/server.js`**
 * ——两个版本互为孤儿时都要能收口（Python 杀 Node 孤儿、Node 杀 Python 孤儿）。
 *
 * **读不到命令行（含非 Linux 平台、进程刚消失、权限不足）一律返回 false**（2026-10-17 订正）：
 * 旧实现返回 true，等于把「不知道」当成「像后端」，在 Windows 上造成两个方向的真机误判
 * （见 `windowsProcessCmdline` 的注释）。宁可不拦/不杀，也不拿不确定当判据。
 *
 * @param {number} pid
 * @param {{platform?: string, readCmdline?: (pid: number) => string|string[]|null}} [options]
 *        测试缝：注入平台与命令行读取器（生产路径不传）。
 */
export function looksLikeBackend(pid, { platform = process.platform, readCmdline } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  let raw;
  try {
    raw = typeof readCmdline === 'function' ? readCmdline(n) : readProcessCmdline(n, platform);
  } catch {
    return false;                                    // 读取器抛错同样算「确认不了」
  }
  if (raw === null || raw === undefined || raw === '') return false;
  const cmdline = (Array.isArray(raw) ? raw.join(' ') : String(raw)).replace(/\\/g, '/');
  return cmdline.includes('server.py') || cmdline.includes('backend/server.js');
}
