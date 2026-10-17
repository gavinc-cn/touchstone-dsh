/**
 * backend/lib/lock.js 的契约测试（node --test，零依赖，真起子进程 + 真起 Python）。
 *
 * 为什么必须真进程：这一层的接口是**跨进程互斥**——同库第二实例、`kill -9` 后自动释放、
 * 与 Python `sqlite3` 的跨语言互斥，全都不在函数签名里，桩不出来。期望值逐条对齐
 * Python 侧 `lifecycle.SingleInstance`（`lifecycle.py:205-364`）。
 *
 * 隔离红线：所有临时库/锁/记录都落 `fs.mkdtempSync(os.tmpdir())` 的独立目录，
 * **绝不碰 `~/.touchstone/` 下的真实库**；所有子进程带 `--disable-warning=ExperimentalWarning`；
 * 不真起监听端口的后端（用 `--host 192.0.2.1` 让 listen 必然 EADDRNOTAVAIL，从而既能证明
 * 「已经越过取锁段」，又不占任何端口）。
 *
 * 覆盖（对应任务书 6 类要求）：
 *   ① 同库互斥：真起 `backend/server.js` 的第二实例 → exit 3 + reason 含占用者 pid 与出口提示
 *   ② 跨语言互斥两个方向：Python 持锁 → Node 拿不到；Node 持锁 → Python `database is locked`
 *   ③ `kill -9` 持锁进程 → 锁随即释放（不依赖任何清理动作，`.pid` 记录照旧残留）
 *   ④ `--allow-shared-db` 跳过锁（两个进程都能起）
 *   ⑤ 存量孤儿收口（+ 三条「绝不代杀」反例）
 *   ⑥ 锁文件打不开 ⇒ 降级为无锁运行
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { acquireSingleInstance, parentAlive, readPidRecord, resolveDbPath, writePidRecord } from '../lib/lock.js';
import { looksLikeBackend, pidAlive } from '../lib/proc.js';

const NODE = process.execPath;
const NODE_OPTS = ['--disable-warning=ExperimentalWarning'];
const SERVER_JS = path.resolve(import.meta.dirname, '..', 'server.js');
const LOCK_JS = path.resolve(import.meta.dirname, '..', 'lib', 'lock.js');
/** listen 必然失败的非本机地址：用来「越过取锁段、又不起监听」（EADDRNOTAVAIL） */
const UNBINDABLE_HOST = '192.0.2.1';
/**
 * 确定「已死」的 ppid：Linux 的 `pid_max` 上限是 4194304（2^22，内核硬上限），
 * 比它大的 pid 永远分配不出来 ⇒ `parentAlive()` 必为 false，且**不存在 pid 复用竞态**
 * （用「刚退出的子进程 pid」来构造死父，理论上会被别的进程回收走，测试会偶发假红）。
 */
const IMPOSSIBLE_PID = 99999999;

/** 本测试文件的全部临时产物根（结束时整体删除） */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-lock-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

/**
 * 夹具 1：按模式占住 `<db>.lock` 后常驻。
 *   mode=lock   → 走 lock.js 的 acquireSingleInstance（写 .pid 记录）
 *   mode=shared → 同上但 allowShared=true（`--allow-shared-db`）
 *   mode=raw    → 裸 SQLite 排它锁，**不写 .pid**（模拟 Python 侧持锁 / 存量孤儿持锁）
 * 额外位置参数只用来往 cmdline 里塞标记串（供 looksLikeBackend 判据用），夹具本身不读。
 */
const HOLD_MJS = path.join(WORK, 'hold.mjs');
fs.writeFileSync(HOLD_MJS, `import fs from 'node:fs';

const [dbPath, mode] = process.argv.slice(2);
if (mode === 'raw') {
  const { DatabaseSync } = await import('node:sqlite');
  fs.writeFileSync(dbPath + '.lock', '');
  const db = new DatabaseSync(dbPath + '.lock', { timeout: 0 });
  db.exec('PRAGMA busy_timeout=0');
  db.exec('PRAGMA locking_mode=EXCLUSIVE');
  db.exec('BEGIN IMMEDIATE');
  db.exec('CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER)');
  db.exec('INSERT OR REPLACE INTO holder (id, pid) VALUES (1, ' + process.pid + ')');
  db.exec('COMMIT');
  process.stdout.write('LOCKED\\n');
} else {
  const { acquireSingleInstance } = await import(process.env.TS_LOCK_MODULE);
  const result = acquireSingleInstance({
    dbPath,
    repoDir: '/tmp/fake-repo',
    parentWatch: false,
    allowShared: mode === 'shared',
    logger: (msg) => process.stderr.write(msg + '\\n'),
  });
  process.stdout.write(result.ok ? 'ACQUIRED\\n' : 'BUSY:' + result.reason + '\\n');
  if (!result.ok) process.exit(0);
}
setInterval(() => {}, 1000);
`);

/** 夹具 2：Python 侧持锁（`sqlite3` + busy_timeout=0 + locking_mode=EXCLUSIVE + 一次写事务） */
const PY_HOLD = path.join(WORK, 'py_hold.py');
fs.writeFileSync(PY_HOLD, `import os, sqlite3, sys, time

lock = sys.argv[1] + '.lock'
open(lock, 'a').close()
conn = sqlite3.connect(lock, timeout=0)
conn.execute("PRAGMA busy_timeout=0")
conn.execute("PRAGMA locking_mode=EXCLUSIVE")
conn.execute("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER)")
conn.execute("INSERT OR REPLACE INTO holder (id, pid) VALUES (1, ?)", (os.getpid(),))
conn.commit()
print("LOCKED", flush=True)
time.sleep(60)
`);

/** 夹具 3：Python 侧试取同一把锁；拿到打 GOT LOCK 退出 0，被占用打原因到 stderr 退出 1 */
const PY_TRY = path.join(WORK, 'py_try.py');
fs.writeFileSync(PY_TRY, `import sqlite3, sys

lock = sys.argv[1] + '.lock'
try:
    conn = sqlite3.connect(lock, timeout=0)
    conn.execute("PRAGMA busy_timeout=0")
    conn.execute("PRAGMA locking_mode=EXCLUSIVE")
    conn.execute("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER)")
    conn.execute("INSERT OR REPLACE INTO holder (id, pid) VALUES (1, 999)")
    conn.commit()
except Exception as exc:
    print("BLOCKED %s: %s" % (type(exc).__name__, exc), file=sys.stderr)
    sys.exit(1)
print("GOT LOCK")
`);

// ---------------------------------------------------------------- 小工具

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(WORK, 'db-'));
  return { dir, dbPath: path.join(dir, 'test.db') };
}

/** 最小 webDir（server.js 取锁前要过「index.html 存在」这一关） */
function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(WORK, 'web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body></body></html>\n');
  return dir;
}

/** 收集日志的内存 logger（断言 warn/收口日志用） */
function makeLogger() {
  const lines = [];
  return { lines, log: (msg) => lines.push(String(msg)) };
}

function collect(child) {
  const out = { stdout: '', stderr: '' };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { out.stdout += chunk; });
  child.stderr?.on('data', (chunk) => { out.stderr += chunk; });
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起 hold.mjs 夹具（extraArgv 只进 cmdline，供 looksLikeBackend 用） */
function spawnFixture(dbPath, mode, extraArgv = []) {
  const child = spawn(NODE, [...NODE_OPTS, HOLD_MJS, dbPath, mode, ...extraArgv], {
    env: { ...process.env, TS_LOCK_MODULE: pathToFileURL(LOCK_JS).href },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = collect(child);
  return child;
}

/** 起 backend/server.js（TOUCHSTONE_DB 指向临时库，绝不碰真实库） */
function spawnBackend(dbPath, extraArgv = []) {
  const child = spawn(NODE, [
    ...NODE_OPTS, SERVER_JS,
    '--host', UNBINDABLE_HOST, '--port', '0',
    '--web-dir', makeWebDir(),
    ...extraArgv,
  ], {
    env: { ...process.env, TOUCHSTONE_DB: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.logs = collect(child);
  return child;
}

function waitExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程 ${child.pid} ${timeoutMs}ms 内未退出`)), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

/** 等子进程 stdout 里出现 match（字符串包含或谓词）；子进程提前退出即报错（带全部输出） */
async function waitOutput(child, match, timeoutMs = 15000) {
  const hit = typeof match === 'function' ? match : (text) => text.includes(match);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hit(child.logs.stdout)) return child.logs.stdout;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`子进程提前退出 code=${child.exitCode} signal=${child.signalCode}`
        + ` stdout=${JSON.stringify(child.logs.stdout)} stderr=${JSON.stringify(child.logs.stderr)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待子进程输出超时 stdout=${JSON.stringify(child.logs.stdout)}`
        + ` stderr=${JSON.stringify(child.logs.stderr)}`);
    }
    await sleep(20);
  }
}

async function killAndWait(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try {
    await waitExit(child, 5000);
  } catch {
    /* 已在退出路径上：忽略 */
  }
}

/** 造一个「确定已死」的 pid（当 .pid 记录里那个已死的 ppid 用） */
async function deadPid() {
  const child = spawn(NODE, [...NODE_OPTS, '-e', ''], { stdio: 'ignore' });
  const { code } = await waitExit(child);
  assert.equal(code, 0);
  return child.pid;
}

/** 找可用的 python3（本机一定有 /usr/bin/python3；找不到则该用例 skip） */
function findPython() {
  for (const bin of [process.env.TS_PYTHON, 'python3', '/usr/bin/python3'].filter(Boolean)) {
    const probe = spawnSync(bin, ['-c', 'import sqlite3'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

// ---------------------------------------------------------------- ① 取锁 / 记录 / release

test('acquire：0 字节 flock 文件上取得 SQLite 排它锁；.pid 记录与 Python 同格式；release 幂等且只删自己的记录', () => {
  const { dir, dbPath } = tmpDb();
  const lockPath = `${dbPath}.lock`;
  const pidPath = `${dbPath}.pid`;
  fs.writeFileSync(lockPath, '');                 // 模拟 Python 侧遗留的 0 字节 flock 文件
  const { lines, log } = makeLogger();

  const first = acquireSingleInstance({ dbPath, repoDir: dir, logger: log });
  assert.equal(first.ok, true, `应当拿到锁：${first.reason}`);
  assert.equal(first.reason, '');
  assert.equal(first.reapedPid, 0);

  // ① .pid 记录：字段与 Python `_write_record` 同格式，另加 backend=node 便于排障
  const record = readPidRecord(pidPath);
  assert.equal(record.pid, process.pid);
  assert.equal(record.ppid, process.ppid);
  assert.equal(record.repo_dir, dir);
  assert.equal(record.parent_watch, false);
  assert.equal(record.backend, 'node');
  assert.equal(typeof record.started_at, 'number');

  // ② 锁文件已被写成真正的 SQLite 库（机制证据：锁就是 SQLite 的排它锁）
  assert.ok(fs.statSync(lockPath).size > 0, '锁文件应当是有效的 SQLite 库（写事务已提交）');

  // ③ 同库第二次取锁（同进程第二连接）必须被拒，且文案含占用者 pid 与两个出口提示
  const second = acquireSingleInstance({ dbPath, logger: log });
  assert.equal(second.ok, false, '同一把锁不该被第二次拿到');
  assert.match(second.reason, new RegExp(`pid=${process.pid}`));
  assert.match(second.reason, /ppid=/);
  assert.match(second.reason, /独立库/);
  assert.match(second.reason, /TOUCHSTONE_DB/);
  assert.match(second.reason, /extraEnv\.TOUCHSTONE_DB/);
  assert.match(second.reason, /--allow-shared-db/);
  second.release();                               // 未持锁：release 必须什么都不做
  assert.ok(fs.existsSync(pidPath), '未持锁的实例不得删别人的 .pid 记录');

  // ④ 记录不是自己 ⇒ release 不删（对齐 Python `release`）
  writePidRecord(pidPath, { pid: 999999, ppid: 1, repo_dir: '/x', parent_watch: false, started_at: 0 });
  first.release();
  assert.ok(fs.existsSync(pidPath), '记录 pid 不是自己时不得删除');
  first.release();                                // 幂等：重复 release 不抛
  fs.rmSync(pidPath, { force: true });

  // ④b 释放后用另一个连接读锁库：写的归属行可读（锁文件是正常 SQLite 库，不是垃圾字节）
  const probe = new DatabaseSync(lockPath, { timeout: 0 });
  const row = probe.prepare('SELECT pid, backend FROM touchstone_instance_lock WHERE id = 1').get();
  probe.close();
  assert.equal(row.pid, process.pid);
  assert.equal(row.backend, 'node');

  // ⑤ 释放后锁真的回到可用状态，且 release 会删掉自己的记录
  const third = acquireSingleInstance({ dbPath, logger: log });
  assert.equal(third.ok, true, `释放后应能重新拿到：${third.reason}`);
  third.release();
  assert.equal(fs.existsSync(pidPath), false, 'release 应删除自己的 .pid 记录');
  assert.equal(fs.existsSync(lockPath), true, '锁文件本身不删（与 Python 的 flock 文件同）');
  assert.equal(lines.filter((line) => line.includes('降级')).length, 0, '正常路径不该出现降级日志');
});

// ---------------------------------------------------------------- ② 同库互斥（真 server.js）

test('同库互斥：真起 backend/server.js 的第二实例 ⇒ exit 3 + reason 含占用者 pid 与出口提示', { timeout: 40000 }, async () => {
  const { dir, dbPath } = tmpDb();
  const { log } = makeLogger();
  const holder = acquireSingleInstance({ dbPath, repoDir: dir, parentWatch: true, logger: log });
  assert.equal(holder.ok, true, holder.reason);
  try {
    const child = spawnBackend(dbPath);
    const { code } = await waitExit(child);
    assert.equal(code, 3, `第二实例必须以 exit 3 退出（与 server.py 同码）`
      + ` stdout=${JSON.stringify(child.logs.stdout)} stderr=${JSON.stringify(child.logs.stderr)}`);
    assert.doesNotMatch(child.logs.stdout, /TOUCHSTONE_LISTEN/, '取不到锁不该起监听');
    assert.match(child.logs.stderr, /错误/);
    assert.match(child.logs.stderr, new RegExp(`pid=${process.pid}`), 'reason 要指出占用者 pid');
    assert.match(child.logs.stderr, /repo=/);
    assert.match(child.logs.stderr, /独立库/);
    assert.match(child.logs.stderr, /TOUCHSTONE_DB/);
    assert.match(child.logs.stderr, /--allow-shared-db/);
  } finally {
    holder.release();
  }
});

// ---------------------------------------------------------------- ③ 跨语言互斥（两个方向）

test('跨语言互斥：Python 持 SQLite 锁 → Node 拿不到；Node 持锁 → Python 报 database is locked', { timeout: 60000 }, async (t) => {
  const python = findPython();
  if (!python) {
    t.skip('环境无可用 python3（找不到 python3 也无 /usr/bin/python3）');
    return;
  }
  const { dbPath } = tmpDb();
  const { log } = makeLogger();

  // 方向 A：Python 持锁 → Node 被拒
  const pyHolder = spawn(python, [PY_HOLD, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  pyHolder.logs = collect(pyHolder);
  try {
    await waitOutput(pyHolder, 'LOCKED');         // 必须等它真持上锁再试，否则测的是「没锁时能拿」
    const nodeAfterPython = acquireSingleInstance({ dbPath, logger: log });
    assert.equal(nodeAfterPython.ok, false, 'Python 持锁时 Node 不得拿到（否则跨语言双写）');
    assert.match(nodeAfterPython.reason, /锁文件被占用且无归属记录/);
    assert.match(nodeAfterPython.reason, /--allow-shared-db/);
    assert.match(nodeAfterPython.reason, /TOUCHSTONE_DB/);
    // 两版对齐后的安全口径：无归属记录时**不许**教用户删锁文件（换 inode ⇒ 与占用者双写）
    assert.doesNotMatch(nodeAfterPython.reason, /删除该锁文件/);
  } finally {
    pyHolder.kill('SIGKILL');                     // 不给它任何清理机会
    await killAndWait(pyHolder);
  }

  // 方向 A 续：持锁者被强杀 ⇒ Node 立刻接手（内核释放，无清理动作）
  const nodeAfterKill = acquireSingleInstance({ dbPath, logger: log });
  assert.equal(nodeAfterKill.ok, true, `Python 被 kill -9 后锁应立刻可用：${nodeAfterKill.reason}`);

  // 方向 B：Node 持锁 → Python 写事务被拒（timeout=0 ⇒ 立即 database is locked）
  const pyBlocked = spawnSync(python, [PY_TRY, dbPath], { encoding: 'utf8' });
  assert.equal(pyBlocked.status, 1, `Python 侧应报占用：stdout=${pyBlocked.stdout} stderr=${pyBlocked.stderr}`);
  assert.match(`${pyBlocked.stdout}${pyBlocked.stderr}`, /database is locked/);

  // Node 释放后 Python 立即可拿（release 真的放锁，且跨语言可见）
  nodeAfterKill.release();
  const pyAfter = spawnSync(python, [PY_TRY, dbPath], { encoding: 'utf8' });
  assert.equal(pyAfter.status, 0, `Node 释放后 Python 应能拿到：stdout=${pyAfter.stdout} stderr=${pyAfter.stderr}`);
  assert.match(pyAfter.stdout, /GOT LOCK/);
});

// ---------------------------------------------------------------- ④ kill -9 释放

test('kill -9 持锁进程 ⇒ 锁随即释放（不依赖任何清理动作，.pid 记录照旧残留）', { timeout: 40000 }, async () => {
  const { dbPath } = tmpDb();
  const { log } = makeLogger();
  const holder = spawnFixture(dbPath, 'lock');
  try {
    await waitOutput(holder, 'ACQUIRED');
    assert.ok(fs.existsSync(`${dbPath}.pid`), '持锁进程应写下 .pid 记录');
    holder.kill('SIGKILL');
    const { signal } = await waitExit(holder);
    assert.equal(signal, 'SIGKILL');
    // 强杀不会有任何清理动作：记录还在（这正是「锁不能依赖 .pid 清理」的理由）
    assert.ok(fs.existsSync(`${dbPath}.pid`), 'kill -9 不会清理 .pid，记录应残留');

    const next = acquireSingleInstance({ dbPath, logger: log });
    assert.equal(next.ok, true, `锁未随进程退出释放：${next.reason}`);
    next.release();
    assert.equal(fs.existsSync(`${dbPath}.pid`), false, '接手者 release 时删掉的是自己的记录');
  } finally {
    await killAndWait(holder);
  }
});

// ---------------------------------------------------------------- ⑤ --allow-shared-db

test('--allow-shared-db：占用者存在时照样能起（只打 warn），server.js 侧也越过取锁段', { timeout: 40000 }, async () => {
  const { dbPath } = tmpDb();
  const holder = spawnFixture(dbPath, 'lock');
  const shared = [];
  try {
    await waitOutput(holder, 'ACQUIRED');

    // 两个子进程都用 allowShared=true 取一次锁：都不许报占用
    for (let i = 0; i < 2; i += 1) {
      const child = spawnFixture(dbPath, 'shared');
      shared.push(child);
      await waitOutput(child, (text) => text.includes('ACQUIRED') || text.includes('BUSY:'));
      assert.match(child.logs.stdout, /^ACQUIRED/, `第 ${i + 1} 个共享实例不该被占用：${child.logs.stdout}`);
      assert.match(child.logs.stderr, /--allow-shared-db/);
      assert.match(child.logs.stderr, /跳过同库单实例锁/);
      assert.ok(fs.existsSync(`${dbPath}.pid`), '共享模式不该动占用者的 .pid 记录');
    }

    // server.js 侧同样越过取锁段：listen 必然失败（非本机地址）⇒ exit 1 而不是 3
    const backend = spawnBackend(dbPath, ['--allow-shared-db']);
    const { code } = await waitExit(backend);
    assert.equal(code, 1, `--allow-shared-db 下不该因占用退出 3`
      + ` stdout=${JSON.stringify(backend.logs.stdout)} stderr=${JSON.stringify(backend.logs.stderr)}`);
    assert.match(backend.logs.stderr, /监听失败/, '应当走到 listen 段（证明已越过取锁段）');
    assert.doesNotMatch(backend.logs.stderr, /同一数据库已有运行中的实例/);
  } finally {
    for (const child of [holder, ...shared]) await killAndWait(child);
  }
});

// ---------------------------------------------------------------- ⑥ 存量孤儿收口

test('存量孤儿收口：parent_watch=true + 父已死 + 命令行像后端 ⇒ SIGTERM 后宽限内接手并记录 reapedPid', { timeout: 40000 }, async () => {
  const { dir, dbPath } = tmpDb();
  // 真持锁的「孤儿」：裸 SQLite 锁 + cmdline 含 backend/server.js（模拟上一轮的 Node 后端）
  const orphan = spawnFixture(dbPath, 'raw', [SERVER_JS]);
  try {
    await waitOutput(orphan, 'LOCKED');
    const father = IMPOSSIBLE_PID;                 // 确定性「已死」（见常量注释）
    writePidRecord(`${dbPath}.pid`, {
      pid: orphan.pid, ppid: father, repo_dir: dir,
      parent_watch: true, started_at: 0, backend: 'node',
    });

    const { lines, log } = makeLogger();
    const startedAt = Date.now();
    const inst = acquireSingleInstance({ dbPath, repoDir: dir, staleWaitMs: 3000, logger: log });
    const elapsed = Date.now() - startedAt;
    try {
      if (!inst.ok) {
        // 失败时把判定依据全部打出来：收口逻辑有四个 early-return，别让排障靠猜
        assert.fail(`孤儿应被收口后接手：${inst.reason}\n诊断: orphanAlive=${pidAlive(orphan.pid)}`
          + ` looksLike=${looksLikeBackend(orphan.pid)} fatherAlive=${pidAlive(father)}`
          + ` record=${JSON.stringify(readPidRecord(`${dbPath}.pid`))} 日志=${JSON.stringify(lines)}`);
      }
      assert.equal(inst.reapedPid, orphan.pid, 'reapedPid 要如实记录被收口的 pid');
      assert.ok(elapsed < 3000, `应在宽限内完成收口（实际 ${elapsed}ms）`);
      const text = lines.join('\n');
      assert.match(text, /发现存量孤儿后端/);
      assert.match(text, /已收口/);
      const { signal } = await waitExit(orphan);
      assert.equal(signal, 'SIGTERM', '收口只许发 SIGTERM（绝不 killpg，孤儿常与宿主同组）');
    } finally {
      inst.release();
    }
  } finally {
    await killAndWait(orphan);
  }
});

test('绝不代杀三反例：parent_watch=false / 其父仍活着 / 命令行不像后端 ⇒ 一个都不许动', { timeout: 60000 }, async () => {
  const cases = [
    { name: 'parent_watch=false', record: (pid, dir, father) => ({ pid, ppid: father, repo_dir: dir, parent_watch: false }), marker: [SERVER_JS] },
    { name: '其父仍活着', record: (pid, dir) => ({ pid, ppid: process.pid, repo_dir: dir, parent_watch: true }), marker: [SERVER_JS] },
    { name: '命令行不像后端', record: (pid, dir, father) => ({ pid, ppid: father, repo_dir: dir, parent_watch: true }), marker: [] },
  ];
  for (const item of cases) {
    const { dir, dbPath } = tmpDb();
    const holder = spawnFixture(dbPath, 'raw', item.marker);
    try {
      await waitOutput(holder, 'LOCKED');
      const father = IMPOSSIBLE_PID;               // 确定性「已死」（见常量注释）
      writePidRecord(`${dbPath}.pid`, item.record(holder.pid, dir, father));
      const { lines, log } = makeLogger();
      const inst = acquireSingleInstance({ dbPath, repoDir: dir, staleWaitMs: 500, logger: log });
      assert.equal(inst.ok, false, `${item.name}：不该拿到锁`);
      assert.equal(inst.reapedPid, 0, `${item.name}：不该收口任何进程`);
      assert.match(inst.reason, new RegExp(`pid=${holder.pid}`), `${item.name}：文案要指出占用者`);
      assert.equal(pidAlive(holder.pid), true, `${item.name}：持锁进程绝不能被代杀`);
      if (item.name === '命令行不像后端') {
        assert.match(lines.join('\n'), /不像本平台后端/);
      }
      inst.release();
    } finally {
      await killAndWait(holder);
    }
  }
});

// ---------------------------------------------------------------- ⑦ 降级 / 路径

test('锁库建不出来（父路径不是目录）⇒ 拒绝启动 + 可操作修复步骤（不再降级）', () => {
  const dir = fs.mkdtempSync(path.join(WORK, 'degrade-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x\n');                       // 用它当「目录」⇒ 建目录/建锁库都失败
  const dbPath = path.join(blocker, 'sub', 'test.db');
  const { lines, log } = makeLogger();
  const inst = acquireSingleInstance({ dbPath, logger: log });
  try {
    // 2026-10-11 评审 P1 后**口径反转**：锁不可用不再降级放行——降级 = 跨语言互斥无声消失
    // （Node 没有 flock 兜底），评审实测两版都能就绪 ⇒ 同库双写。改为显式拒绝 + 修复指引。
    assert.equal(inst.ok, false, '锁不可用时必须拒绝启动');
    assert.match(inst.reason, /单实例锁文件不可用/);
    assert.match(inst.reason, /\.broken/);
    assert.match(inst.reason, /--allow-shared-db/);
    assert.ok(lines.length >= 0, '拒绝路径不要求日志，但 release 必须安全');
  } finally {
    inst.release();                                       // 拒绝路径的 release 也必须是安全的 no-op
  }
});

test('resolveDbPath：TOUCHSTONE_DB 覆盖与缺省 ~/.touchstone/touchstone.db（与 db.py / db.js 同口径）', () => {
  assert.equal(resolveDbPath({ env: {}, home: '/home/u' }), '/home/u/.touchstone/touchstone.db');
  assert.equal(resolveDbPath({ env: { TOUCHSTONE_DB: '/data/x.db' }, home: '/home/u' }), '/data/x.db');
  assert.equal(resolveDbPath({ env: { TOUCHSTONE_DB: '~/y.db' }, home: '/home/u' }), '/home/u/y.db');
  assert.equal(resolveDbPath({ env: { TOUCHSTONE_DB: '~' }, home: '/home/u' }), '/home/u');
  assert.equal(resolveDbPath({ env: { TOUCHSTONE_DB: 'rel/z.db' }, home: '/home/u' }),
    path.resolve('rel/z.db'));
  // 空串按未设处理：与 db.js:defaultDbPath 的 `||` 同口径（空串在 Python 侧是不可用配置，
  // 若这里退化成 path.resolve('')=cwd，锁就会**锁错文件**=等于没锁）
  assert.equal(resolveDbPath({ env: { TOUCHSTONE_DB: '' }, home: '/home/u' }),
    '/home/u/.touchstone/touchstone.db');
  // 缺省路径绝不能是真实 home（本用例传假 home，顺带钉住「测试不碰真实库」）
  assert.notEqual(resolveDbPath({ env: {}, home: '/home/u' }),
    path.join(os.homedir(), '.touchstone', 'touchstone.db'));
});

test('parentAlive：父仍活着 → true；ppid<=1 / 非法 / 已死的 pid → false（对齐 lifecycle.parent_alive）', async () => {
  assert.equal(parentAlive(process.pid), true);
  assert.equal(parentAlive(1), false, 'ppid=1 表示已被 init 收养 ⇒ 父已死');
  assert.equal(parentAlive(0), false);
  assert.equal(parentAlive(-5), false);
  assert.equal(parentAlive('abc'), false);
  // 已死的 pid：Linux pid_max 上限 4194304（2^22），比它大的 pid 永远分配不出来 ⇒ 确定性「已死」
  assert.equal(parentAlive(99999999), false);
  const reaped = await deadPid();
  assert.equal(parentAlive(reaped), false, `已退出的子进程 pid=${reaped} 应判定为父已死`);
});

// ---------- ⑦ 锁文件不可用 ⇒ fail closed（2026-10-11 评审 P1）----------
//
// 评审实测：锁文件是垃圾内容/是目录时，Node 与 Python **都能就绪** ⇒ 跨语言互斥无声消失、
// 同库双写（这一条比「启动被拒」严重得多）。现在一律拒绝并给修复步骤。

test('锁路径是目录 ⇒ 拒绝启动（不再降级为无锁运行）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lock-dir-'));
  const dbPath = path.join(dir, 't.db');
  fs.mkdirSync(`${dbPath}.lock`);                       // 锁路径占成目录
  const result = acquireSingleInstance({ dbPath, logger: () => {} });
  assert.equal(result.ok, false, '锁不可用时必须拒绝启动');
  assert.match(result.reason, /单实例锁文件不可用/);
  assert.match(result.reason, /\.broken/);
  assert.match(result.reason, /--allow-shared-db/);
});

test('锁文件是垃圾内容 ⇒ 拒绝启动', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lock-junk-'));
  const dbPath = path.join(dir, 't.db');
  fs.writeFileSync(`${dbPath}.lock`, '这不是 SQLite 库\n', 'utf8');
  const result = acquireSingleInstance({ dbPath, logger: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /单实例锁文件不可用/);
});

test('--allow-shared-db 时锁文件损坏也照常起步（自担风险）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lock-shared-'));
  const dbPath = path.join(dir, 't.db');
  fs.mkdirSync(`${dbPath}.lock`);
  const logs = [];
  const result = acquireSingleInstance({ dbPath, allowShared: true, logger: (m) => logs.push(m) });
  assert.equal(result.ok, true);
  assert.ok(logs.some((m) => m.includes('--allow-shared-db')));
  result.release();
});

test('dbPath 缺省/非法 ⇒ 立刻抛错（漏传会让锁落到 CWD，等于没锁）', () => {
  assert.throws(() => acquireSingleInstance({}), /dbPath/);
  assert.throws(() => acquireSingleInstance({ dbPath: '' }), /dbPath/);
});

test('归属记录里已有活着的别家后端 ⇒ 拒绝启动（补 Node 看不见 flock 的洞）', async () => {
  // 这是**真实事故**的回归钉子：M1 之前的 Python 实例只持 flock，Node 只认 SQLite 锁，
  // 于是 Node 起在了生产库上并覆写/删掉了生产实例的 .pid（2026-10-11 03:09:40）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lock-foreign-'));
  const dbPath = path.join(dir, 't.db');
  // 一个「像后端的活进程」：argv 里带 backend/server.js（looksLikeBackend 命中）
  const holder = spawn(NODE, [...NODE_OPTS, '-e', 'setTimeout(() => {}, 60000)',
    'backend/server.js'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pidAlive(holder.pid), true);
    assert.equal(looksLikeBackend(holder.pid), true);
    fs.writeFileSync(`${dbPath}.pid`, JSON.stringify({
      pid: holder.pid, ppid: process.pid, repo_dir: '/repo',
      parent_watch: true, started_at: 0,
    }), 'utf8');
    const result = acquireSingleInstance({ dbPath, logger: () => {} });
    assert.equal(result.ok, false, 'SQLite 锁虽空闲，但记录里有活着的别家后端 ⇒ 必须拒绝');
    assert.match(result.reason, new RegExp(`pid=${holder.pid}`));
    assert.match(result.reason, /旧版后端|运行中的实例/);
    // 拒绝时不得留下任何痕迹：记录原样、锁没被我们持有
    assert.equal(readPidRecord(`${dbPath}.pid`).pid, holder.pid);
  } finally {
    holder.kill('SIGKILL');
    holder.unref();
  }
});

test('残留的 node 归属记录（pid 已被复用成「像后端」的活进程）⇒ 不得拒绝启动（Windows 升级卡死回归）', async () => {
  // 真机事故（2026-10-17 桌面端 npm 0.3.0，Windows）：Node 后端被薄壳 SIGTERM 停掉时走的是
  // TerminateProcess ⇒ 进程内优雅退出/`release()` 全跑不到 ⇒ `.pid` 留盘；随后那个 pid 被
  // 无关进程（实测 OpenConsole.exe）复用。下次启动时新后端**已经拿到 SQLite 排它锁**（老进程
  // 确实死了），却因为「记录里 pid 还活着 + looksLikeBackend 在非 Linux 无条件 true」判定
  // 「同一数据库已有运行中的实例」⇒ exit 3，且此后每次启动都如此 ⇒ 插件面板永久打不开。
  //
  // 不变量：Node 版后端自己也持这把 SQLite 排它锁到进程退出 ⇒ 我们拿到锁时，一条
  // `backend: "node"` 的记录**不可能**还属于活实例 ⇒ 一律按残留处理（覆写成自己的记录）。
  // 这里故意用「命令行完全像 Node 后端」的活进程当复用对象——比真机场景更恶劣，
  // 确保判据靠的是「已持锁」这个不变量，而不是「命令行不像后端」的偶然。
  const dir = fs.mkdtempSync(path.join(WORK, 'db-stale-node-'));
  const dbPath = path.join(dir, 'test.db');
  const reused = spawn(NODE, [...NODE_OPTS, '-e', 'setTimeout(() => {}, 60000)', SERVER_JS],
    { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pidAlive(reused.pid), true);
    assert.equal(looksLikeBackend(reused.pid), true,
      '夹具前提：这个「复用 pid」的活进程要被现有命令行判据认成后端，回归才有杀伤力');
    fs.writeFileSync(`${dbPath}.pid`, JSON.stringify({
      pid: reused.pid, ppid: IMPOSSIBLE_PID, repo_dir: '/old-install',
      parent_watch: true, started_at: 0, backend: 'node',
    }), 'utf8');
    const { lines, log } = makeLogger();
    const inst = acquireSingleInstance({ dbPath, repoDir: '/mine', logger: log });
    try {
      assert.equal(inst.ok, true, `自持 SQLite 排它锁 ⇒ node 残留记录不得拒绝启动：${inst.reason}`
        + `（日志=${JSON.stringify(lines)}）`);
      assert.equal(readPidRecord(`${dbPath}.pid`).pid, process.pid,
        '残留的 node 记录必须被本进程的归属记录覆写（否则它永远是排障噪声）');
      assert.equal(pidAlive(reused.pid), true, '绝不能把疑似 PID 复用的无关进程杀掉/收口');
    } finally {
      inst.release();
    }
  } finally {
    reused.kill('SIGKILL');
    reused.unref();
  }
});

test('writePidRecord 不覆写活着的别家记录（对方排障凭据）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lock-pidwrite-'));
  const pidPath = path.join(dir, 't.db.pid');
  const holder = spawn(NODE, [...NODE_OPTS, '-e', 'setTimeout(() => {}, 60000)',
    'backend/server.js'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(pidPath, JSON.stringify({ pid: holder.pid, ppid: 1, repo_dir: '/repo',
      parent_watch: true, started_at: 0 }), 'utf8');
    const logs = [];
    const wrote = writePidRecord(pidPath, { pid: process.pid, ppid: process.ppid,
      repo_dir: '/mine', parent_watch: false, started_at: 1 }, (m) => logs.push(m));
    assert.equal(wrote, false, '活着的别家记录不许覆写');
    assert.equal(readPidRecord(pidPath).pid, holder.pid, '原记录必须原样保留');
    assert.ok(logs.some((m) => m.includes('拒绝覆写')));
  } finally {
    holder.kill('SIGKILL');
    holder.unref();
  }
});
