/**
 * 同库单实例锁（Node 后端对 `lifecycle.SingleInstance` 的等价实现，M1）。
 *
 * 背景：Python 后端与 Node 后端共用 `~/.touchstone/touchstone.db`（或 `TOUCHSTONE_DB`
 * 指定的库），同库双实例会双写任务/队列行。Python 侧用 `<db>.lock` 的
 * `flock(LOCK_EX|LOCK_NB)` 强制互斥，第二个实例 **exit 3** 并打印占用者。
 *
 * Node 没有 stdlib `flock`，改用 **SQLite 自身的排它锁**、落在**同一个 `<db>.lock` 路径**
 * 上（2026-10-11 实测，方案 §附录 C③ / 风险 R4）：
 *   ① `new DatabaseSync(lockPath, { timeout: 0 })` + `PRAGMA busy_timeout=0`
 *      + `PRAGMA locking_mode=EXCLUSIVE`，再做一次写事务 ⇒ 排它锁**持有到连接关闭**
 *      （`locking_mode=EXCLUSIVE` 的语义：首次写入后不再释放文件锁）；
 *   ② 第二个进程（Node 的 `node:sqlite` 或 Python 的 `sqlite3`）再试同一操作 ⇒ **立即**
 *      `database is locked`（Node：`code=ERR_SQLITE_ERROR errcode=5`；Python：`OperationalError`）；
 *   ③ `kill -9` 持有者 ⇒ 内核释放文件锁，下一个进程随即拿到（**不需要任何清理动作**）；
 *   ④ **跨语言互通**：flock 与 SQLite 锁互不相干，所以两边都要取 SQLite 锁才是真互斥
 *      ——本文件是 Node 侧那一半。
 *
 * 语义（逐条对齐 `lifecycle.SingleInstance`，行号见该文件 205-364）：
 *   - 拿不到锁 ⇒ 读 `<db>.pid`（JSON `{pid, ppid, repo_dir, parent_watch, started_at}`；
 *     Node 版多写 `"backend": "node"` 便于排障）；
 *   - 记录里 `parent_watch` 为真、其 `ppid` 已死、且 pid 命令行像本平台后端
 *     （`server.py` **或** `backend/server.js`）⇒ 判为**存量孤儿**，只向**该单个 pid**
 *     SIGTERM（绝不 killpg：孤儿常与宿主同组），在 `staleWaitMs` 内等它让出锁后**重试一次**；
 *   - 否则返回失败与同义文案，由 server.js 打印并以 **exit 3** 退出；
 *   - `--allow-shared-db`（`allowShared`）跳过整条锁流程，只打一条 warn；
 *   - 锁文件打不开/不可写 ⇒ **降级为无锁运行**（warn 后继续），绝不因锁问题让后端起不来；
 *   - `release()` 幂等：仅当 `.pid` 记录的 pid 仍是自己时删除记录，并关闭 SQLite 连接释放锁。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { isRunning, looksLikeBackend, pidAlive, terminatePid } from './proc.js';

/** 存量孤儿 SIGTERM 后等待其让出锁的上限（毫秒）。对齐 `lifecycle.STALE_WAIT = 5.0s` */
export const STALE_WAIT_MS = 5000;
/** 等待孤儿退出的轮询间隔（毫秒）。对齐 Python 侧 `time.sleep(0.1)` */
export const REAP_POLL_MS = 100;
/** 库路径缺省值（与 `db.py:DB_OVERRIDE` 的缺省逐字相同） */
export const DEFAULT_DB = '~/.touchstone/touchstone.db';
/** 锁库里的归属表名（内容仅供参考/排障：判据是 SQLite 的排它锁本身，不是表里那一行） */
const LOCK_TABLE = 'touchstone_instance_lock';

/** 同步 sleep 用的共享缓冲（Atomics.wait：主线程可用的同步等待，不占 CPU） */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

/** 同步睡眠（毫秒）：收口等待是同步流程（对齐 Python 的 time.sleep） */
function sleepMs(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

/**
 * 数据库文件路径（对齐 `db.py:db_path()`：`TOUCHSTONE_DB` 覆盖，缺省 `~/.touchstone/touchstone.db`，
 * 且对取值做 `~` 展开——展开口径与 `backend/lib/db.js:defaultDbPath` 的 `expandUser` 逐条相同）。
 *
 * **不变量：锁路径必须与「数据层真正打开的那个库」同源**（`<db>.lock` 锁错文件等于没锁）。
 * Node 侧数据层的权威解析口是 `db.js:defaultDbPath()`（M1 已落地）；本函数是**不依赖数据层**的
 * 同口径实现，供入口与单测使用（放这里是为了让锁模块自包含、可脱离 schema 契约单独跑）。
 * 两者对任意取值同口径（含 `TOUCHSTONE_DB=""`：按未设处理，与 `defaultDbPath` 的 `||` 一致；
 * 该取值在 Python 侧会落到 `sqlite3.connect('')` 的临时库，本就不是可用配置）。
 * M2 起 server.js 也可以直接改传
 * `db.defaultDbPath()`，届时删除本函数即可（**不要**留两份各自演化的解析器）。
 */
export function resolveDbPath({ env = process.env, home = os.homedir() } = {}) {
  // 空串按「未设」处理（与 `db.js:defaultDbPath` 的 `||` 同口径）：空串在 Python 侧会落到
  // `sqlite3.connect('')` 的临时库（一个不可用的库），两侧都不该把它当成真路径。
  const value = env && env.TOUCHSTONE_DB;
  const raw = String(value ? value : DEFAULT_DB);
  let expanded = raw;
  if (raw === '~') expanded = home;
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) expanded = path.join(home, raw.slice(2));
  return path.resolve(expanded);
}

/**
 * 由库路径派生锁路径（对齐 `SingleInstance.__init__` 的两条 `+ ".lock"` / `+ ".pid"`）。
 * `dbPath` 一律转绝对路径：Python 侧 `os.path.abspath(db_file)` 同款。
 */
export function lockPaths(dbPath) {
  const abs = path.resolve(String(dbPath));
  return { dbPath: abs, lockPath: `${abs}.lock`, pidPath: `${abs}.pid` };
}

/** 读 `.pid` 归属记录：不存在/坏 JSON/不是对象 ⇒ null（对齐 Python `_read_record`） */
export function readPidRecord(pidPath) {
  try {
    const record = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * 归属记录是否指向「可能活着的别家后端」。**唯一判据源**（writePidRecord 与
 * liveForeignHolder 共用，别再各写一份——2026-10-17 的 Windows 事故就是两处各自判活）。
 *
 * 判据：
 *   - 不是自己、pid 合法；
 *   - **`backend: "node"` 的记录一律不算**（2026-10-17 真机事故新增）：Node 版后端自己也持
 *     `<db>.lock` 上的 SQLite 排它锁，并一直持有到进程退出（`locking_mode=EXCLUSIVE`）。
 *     所以**只要本进程已经拿到这把锁**（两个调用点的唯一生产前提），一条 node 记录就不可能
 *     还属于活实例 ⇒ 必然是残留：典型成因是 Windows 上 SIGTERM=TerminateProcess，后端优雅
 *     退出/`release()` 跑不到、`.pid` 不删；pid 随后被无关进程复用。
 *     （M1 之前的 Python 实例只持 flock，SQLite 锁看不见它 ⇒ 无 `backend` 键的记录仍要判活。）
 *   - 其余记录（Python 版）：pid 存活且命令行像本平台后端才算活着。
 */
export function recordIsLiveForeignHolder(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (record.backend === 'node') return false;       // 见上：已持 SQLite 锁 ⇒ 本版记录必为残留
  if (!pidAlive(pid)) return false;
  if (!looksLikeBackend(pid)) return false;
  return true;
}

/**
 * 写 `.pid` 归属记录（临时文件 + rename 原子替换，对齐 Python `_write_record`）。
 * 写不进去**不影响运行**（只是失去存量孤儿识别能力）：记一条日志返回 false。
 */
export function writePidRecord(pidPath, record, logger) {
  const log = typeof logger === 'function' ? logger : () => {};
  // 绝不覆写「活着的别家后端」的归属记录（2026-10-11 评审 P1）：那是对方的排障凭据，
  // 实测被覆盖并删除过一次（Node 起在同一库上，旧版 Python 实例的 `.pid` 就消失了）。
  // 自己写自己（同 pid）允许——重启/重入路径要用。判据统一走 recordIsLiveForeignHolder
  // （node 记录按「已持锁 ⇒ 必为残留」处理，Windows PID 复用才不会把记录永久钉在原处）。
  const existing = readPidRecord(pidPath);
  if (recordIsLiveForeignHolder(existing)) {
    log(`[lock] 已有活着的后端归属记录 pid=${existing.pid}，拒绝覆写 ${pidPath}`);
    return false;
  }
  const tmp = `${pidPath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, pidPath);
    return true;
  } catch (error) {
    log(`[lock] pid 记录写入失败（忽略）: ${(error && error.message) || error}`);
    return false;
  }
}

/** 删 `.pid` 归属记录：不存在或删不掉都安全忽略（对齐 Python `_remove_record`） */
export function removePidRecord(pidPath) {
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {
    /* 忽略：记录清理失败不影响锁（锁由内核在进程退出时释放） */
  }
}

/**
 * 父进程是否仍存活（对齐 `lifecycle.parent_alive`）：ppid 非法或 <=1 视为父已死
 * （POSIX 孤儿被 init 收养 ⇒ ppid=1；Windows 不收养，但 Node 侧同样以非法值兜底）。
 */
export function parentAlive(ppid = process.ppid) {
  const n = Number(ppid);
  if (!Number.isInteger(n) || n <= 1) return false;
  return pidAlive(n);
}

/** SQLITE_BUSY / "database is locked" 判定：区分「被别人占着」与「根本打不开」两类失败 */
export function isBusyError(error) {
  if (!error) return false;
  if (error.errcode === 5) return true;                     // SQLITE_BUSY
  return /database (is|table is) locked|SQLITE_BUSY/i.test(String(error.message || ''));
}

/**
 * 在 `<db>.lock` 上取 SQLite 排它锁（本模块的核心机制，已实测；见文件头 ①②③④）。
 * 成功返回**持有锁的连接**（调用方必须一直持有到进程退出/释放：关连接即释放锁）；
 * 失败抛原错误（`isBusyError` 为真的 ⇒ 被占用；否则 ⇒ 打不开，调用方降级无锁）。
 *
 * 三件事的顺序不能变：`busy_timeout=0` 必须在任何语句前（否则会阻塞等待而不是立即报忙）；
 * `locking_mode=EXCLUSIVE` 必须在第一次写入前（写后再设就晚了，锁会在事务结束时放开）。
 */
export function tryExclusiveLock(lockPath) {
  const db = new DatabaseSync(lockPath, { timeout: 0 });    // 打开本身不加锁
  try {
    db.exec('PRAGMA busy_timeout=0');                       // 立即失败，绝不阻塞在锁上
    db.exec('PRAGMA locking_mode=EXCLUSIVE');               // 首写后锁不释放（持有到连接关闭）
    db.exec('BEGIN IMMEDIATE');
    db.exec(`CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} `
      + '(id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, backend TEXT, acquired_at INTEGER)');
    db.exec(`INSERT OR REPLACE INTO ${LOCK_TABLE} (id, pid, backend, acquired_at) `
      + `VALUES (1, ${process.pid}, 'node', ${Math.floor(Date.now() / 1000)})`);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 关闭失败无妨：进程退出时内核会释放所有文件锁 */
    }
    throw error;
  }
}

/**
 * 存量孤儿收口（对齐 `lifecycle.SingleInstance._reap_stale`，判定顺序逐条相同）。
 * 返回被收口的 pid；未收口返回 0（记录过期 / 非父死感知托管 / 父仍活着 / 不像后端 / 等不到退出）。
 *
 * **只向该单个 pid 发 SIGTERM，绝不 killpg/杀进程组**：孤儿往往与它的宿主
 * （甚至是正在启动我们的这个 dsh 进程）同组，整组终止会连带杀掉自己——Python 侧实测踩中。
 */
export function reapStale({ record, staleWaitMs = STALE_WAIT_MS, logger } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  if (!record || typeof record !== 'object') return 0;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return 0;   // 记录已过期：直接试锁
  if (!record.parent_watch) return 0;                                   // 非父死感知托管：绝不代杀
  if (parentAlive(record.ppid)) return 0;                               // 其父还活着：真·另一实例
  if (!looksLikeBackend(pid)) {
    log(`[lock] pid 记录 ${pid} 不像本平台后端（PID 复用？），不处置`);
    return 0;
  }
  log(`[lock] 发现存量孤儿后端 pid=${pid}（父已死），SIGTERM 收口…`);
  terminatePid(pid);                                                    // 只杀单个 pid
  const deadline = Date.now() + Math.max(Number(staleWaitMs) || 0, 0);
  // 判活用 isRunning（僵尸算已退出）：本循环是同步的（Atomics.wait 阻塞事件循环），
  // 若孤儿恰好是本进程的子进程，父进程不 reap 它就一直 pidAlive=true，会白等满宽限。
  // 僵尸不持有任何锁（内核已回收），按「已退出」处理既正确又不会误判存量实例。
  while (isRunning(pid) && Date.now() < deadline) sleepMs(REAP_POLL_MS);
  if (isRunning(pid)) {
    log(`[lock] 孤儿 pid=${pid} 未在 ${staleWaitMs}ms 内退出，放弃收口`);
    return 0;
  }
  log(`[lock] 存量孤儿 pid=${pid} 已收口`);
  return pid;
}

/**
 * 归属记录里的**活着的别家后端**（不是自己、进程存活、且命令行像后端）。返回记录或 null。
 *
 * 为什么需要这道额外检查（2026-10-11 评审 P1，**已在生产上实际发生过一次**）：Node 只有
 * SQLite 那道锁，而 M1 之前的 Python 实例只持 flock（Node 看不见）⇒ Node 能起在同一库上，
 * 实测还覆写并删掉了生产实例的 `.pid`。`looksLikeBackend` 用来扛 PID 复用误判。
 *
 * **调用前提：本进程已拿到 SQLite 排它锁**（`backend:"node"` 记录不算活实例的判据靠它，见
 * `recordIsLiveForeignHolder`；2026-10-17 桌面端 Windows 永久 exit 3 事故的修复点）。
 * @param {string} pidPath
 * @returns {object|null}
 */
export function liveForeignHolder(pidPath) {
  const record = readPidRecord(pidPath);
  return recordIsLiveForeignHolder(record) ? record : null;
}

/** 锁文件不可用（非「被占用」）的拒绝文案：说清现象、危害与两条可行修复路径 */
export function unusableLockReason(lockPath, dbPath, error) {
  return `单实例锁文件不可用：${lockPath}（库 ${dbPath}）。原因：`
    + `${(error && error.message) || error}。`
    + '该文件应为 SQLite 库或 0 字节空文件；内容损坏/被换成目录时无法建立互斥，'
    + '继续启动会与另一版后端同库双写（任务重复执行、队列行被抢）。'
    + '修复：确认没有实例在跑之后把它移走再启动'
    + `（mv ${lockPath} ${lockPath}.broken）；`
    + '或显式 --allow-shared-db 自担双写风险。';
}

/** 归属记录里已有活着的别家后端时的拒绝文案（含「未升级的旧版实例」这一真实成因） */
export function foreignHolderReason(record, dbPath, pidPath) {
  return `同一数据库已有运行中的实例：pid=${record.pid} ppid=${record.ppid} `
    + `repo=${record.repo_dir || '-'}（库 ${dbPath}）。`
    + '它可能是 M1 之前启动的旧版后端（只持 flock，本版看不见那道锁）。'
    + '如需并行请用独立库（TOUCHSTONE_DB / 插件 extraEnv.TOUCHSTONE_DB），'
    + `或先停掉它；确认记录已过期可删除 ${pidPath} 后重试。`;
}

/**
 * 占用者明确时的失败文案（与 `lifecycle.py:339-344` **逐字同义**：
 * pid/ppid/repo + 独立库出口 + `--allow-shared-db` 逃生口）。
 */
export function instanceBusyReason(record, dbPath) {
  const ppid = record.ppid === undefined || record.ppid === null ? '-' : record.ppid;
  return `同一数据库已有运行中的实例：pid=${record.pid} ppid=${ppid} repo=${record.repo_dir || '-'}`
    + `（库 ${dbPath}）。如需并行请用独立库`
    + `（TOUCHSTONE_DB / 插件 extraEnv.TOUCHSTONE_DB），`
    + `或显式 --allow-shared-db 自担双写风险。`;
}

/**
 * 锁被占但**没有归属记录**时的失败文案（与 Python `lifecycle.py` 的同名分支**同义**，
 * 2026-10-11 两版对齐后的口径）：
 *   - **绝不教用户「删除锁文件」**——删除会把 inode 换掉，新实例在新 inode 上取锁，
 *     与仍在运行的占用者双写（flock 与 SQLite 锁同理），是危险的错误建议；
 *   - 只给两个安全出口：独立库（TOUCHSTONE_DB / 插件 extraEnv.TOUCHSTONE_DB）与
 *     `--allow-shared-db`（自担双写风险）——这也是 M1 对失败提示的硬要求。
 * 可能出现的场景：另一版后端在「取锁成功、写 .pid 之前」被杀（Node 侧窗口），
 * 或第三方进程占着同一把 SQLite 锁。
 */
export function lockBusyReason(lockPath, dbPath) {
  return `锁文件被占用且无归属记录：${lockPath}`
    + `（库 ${dbPath}）。占用者可能是另一版后端的异常窗口`
    + `（取锁后、写 .pid 前被杀）或残留的第三方进程；`
    + `如需并行请用独立库（TOUCHSTONE_DB / 插件 extraEnv.TOUCHSTONE_DB），`
    + `或显式 --allow-shared-db 自担双写风险。`;
}

/**
 * 取同库单实例锁（`lifecycle.SingleInstance.acquire` 的等价物）。
 *
 * @param {object}   opts
 * @param {string}   opts.dbPath       库文件路径（锁 = `<dbPath>.lock`，记录 = `<dbPath>.pid`）
 * @param {string}   [opts.repoDir]    写进归属记录的仓库目录（排障用）
 * @param {boolean}  [opts.parentWatch] 本进程是否由父死感知托管（决定别家能否收口我们）
 * @param {boolean}  [opts.allowShared] `--allow-shared-db`：跳过整条锁流程
 * @param {Function} [opts.logger]     日志口（缺省 stderr）
 * @param {number}   [opts.staleWaitMs] 存量孤儿等待上限（缺省 5s，单测可调小）
 * @returns {{ok: boolean, reason: string, reapedPid: number, release: Function}}
 *          `ok=false` 时 `reason` 是给用户的完整中文说明（server.js 打印后 exit 3）。
 */
export function acquireSingleInstance({
  dbPath,
  repoDir = '',
  parentWatch = false,
  allowShared = false,
  logger,
  staleWaitMs = STALE_WAIT_MS,
} = {}) {
  const log = typeof logger === 'function' ? logger : (msg) => console.error(msg);
  // dbPath 必填：漏传会让 path.resolve(undefined) 落在进程 CWD（`undefined.lock` 这种
  // 脏产物实测出现过——锁错文件 = 等于没锁，必须在入口挡掉而不是静默继续）
  if (typeof dbPath !== 'string' || !dbPath) {
    throw new Error('acquireSingleInstance 需要 dbPath（库文件路径，锁与归属记录都由它派生）');
  }
  const paths = lockPaths(dbPath);
  const state = { handle: null, held: false, reapedPid: 0 };

  /**
   * 释放锁与归属记录（幂等）。仅当**本次真的持锁**且 `.pid` 记录的 pid 仍是自己时才删记录
   * （对齐 Python `release`；比它多一道 `held` 闸：失败/降级/共享模式下调用 release 也绝不
   * 误删别人的记录）。关连接 = 释放 SQLite 锁；进程被 kill 时不需要走到这里（内核释放）。
   */
  const release = () => {
    if (!state.held && state.handle === null) return;
    const record = readPidRecord(paths.pidPath);
    if (state.held && record && Number(record.pid) === process.pid) removePidRecord(paths.pidPath);
    if (state.handle) {
      try {
        state.handle.close();
      } catch {
        /* 已关闭/已释放：忽略 */
      }
      state.handle = null;
    }
    state.held = false;
  };

  if (allowShared) {
    log('[lock] --allow-shared-db：跳过同库单实例锁（自担双写风险）');
    return { ok: true, reason: '', reapedPid: 0, release };
  }

  // 目录先建出来（对齐 Python `os.makedirs(dirname, exist_ok=True)`）；建不出来不在这里报错，
  // 下面打开锁文件时同样会失败，统一走「降级为无锁运行」分支。
  try {
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  } catch {
    /* 交给打开失败分支 */
  }

  let reaped = false;
  for (;;) {
    let handle = null;
    try {
      handle = tryExclusiveLock(paths.lockPath);
    } catch (error) {
      if (!isBusyError(error)) {
        // **不再静默降级**（2026-10-11 评审 P1）：锁文件是垃圾内容/是目录/不可读时，
        // 降级放行 = 跨语言互斥无声消失（Node 没有 flock 可兜底），实测「先起 Python
        // 再起 Node」两边都能就绪 ⇒ 同库双写。锁不可用属于**环境损坏**，必须显式拒绝
        // 并给出可操作修复步骤；确要自担风险可显式 --allow-shared-db。
        return { ok: false, reapedPid: 0, release,
          reason: unusableLockReason(paths.lockPath, paths.dbPath, error) };
      }
    }
    if (handle) {
      // 拿到 SQLite 锁还不够：**M1 之前的 Python 实例只持 flock**（那道锁 Node 看不见），
      // 所以还要看归属记录里有没有活着的别家后端。同库双写比「启动被拒」严重得多。
      const holder = liveForeignHolder(paths.pidPath);
      if (holder) {
        try { handle.close(); } catch { /* 已关闭：忽略 */ }
        return { ok: false, reapedPid: state.reapedPid, release,
          reason: foreignHolderReason(holder, paths.dbPath, paths.pidPath) };
      }
      state.handle = handle;
      state.held = true;
      const wrote = writePidRecord(paths.pidPath, {
        pid: process.pid,
        ppid: process.ppid,
        repo_dir: repoDir,
        parent_watch: Boolean(parentWatch),
        started_at: Math.floor(Date.now() / 1000),
        backend: 'node',                       // Node 侧独有键：排障时一眼看出占用者版本
      }, log);
      if (!wrote && liveForeignHolder(paths.pidPath)) {
        // 记录写不进去且里面是活着的别家：极窄的竞态窗口（另一个实例刚好在我们取锁后写记录）
        state.held = false;
        try { handle.close(); } catch { /* 忽略 */ }
        state.handle = null;
        return { ok: false, reapedPid: state.reapedPid, release,
          reason: foreignHolderReason(liveForeignHolder(paths.pidPath), paths.dbPath,
            paths.pidPath) };
      }
      return { ok: true, reason: '', reapedPid: state.reapedPid, release };
    }

    const record = readPidRecord(paths.pidPath);
    if (record && !reaped) {
      const reapedPid = reapStale({ record, staleWaitMs, logger: log });
      if (reapedPid > 0) {
        reaped = true;                         // 孤儿已收口：其锁随进程退出释放，重试一次
        state.reapedPid = reapedPid;
        continue;
      }
    }
    const reason = record
      ? instanceBusyReason(record, paths.dbPath)
      : lockBusyReason(paths.lockPath, paths.dbPath);
    return { ok: false, reason, reapedPid: state.reapedPid, release };
  }
}
