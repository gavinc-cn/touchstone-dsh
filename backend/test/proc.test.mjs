/**
 * backend/lib/proc.js 的契约测试（node --test，零依赖，真起子进程）。
 *
 * 为什么必须真进程：这层的接口就是「pid 的存活与死亡」——函数签名里没有进程，桩不出来。
 * 期望值逐条对齐 Python 侧 `platcompat.pid_alive` / `platcompat.kill_tree` /
 * `lifecycle.kill_children`（M1 的存量孤儿收口与退出清理都靠它）。
 *
 * 子进程一律用 `process.execPath` + `--disable-warning=ExperimentalWarning` 起（不用 sleep/sh，
 * 跨平台且不依赖外部二进制）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

import { collectDescendants, killTree, looksLikeBackend, pidAlive, terminatePid } from '../lib/proc.js';

const NODE = process.execPath;
const NODE_OPTS = ['--disable-warning=ExperimentalWarning'];
/** 常驻脚本：什么都不干，等着被杀 */
const IDLE = 'setInterval(() => {}, 1000)';
/** 顽固脚本：安装 SIGTERM 忽略器后打印 READY（测试必须等这行，否则信号可能早于 handler 到达） */
const STUBBORN = "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)";
/** 树根脚本：起两个常驻子进程，把它们的 pid 打到 stdout 第一行，然后自己常驻 */
const TREE_ROOT = `
const { spawn } = require('node:child_process');
const kids = [0, 1].map(() => spawn(process.execPath,
  ['--disable-warning=ExperimentalWarning', '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
process.stdout.write(JSON.stringify(kids.map((k) => k.pid)) + '\\n');
setInterval(() => {}, 1000);
`;

/** 起一个 `node -e <script>` 子进程（可附加位置参数进 cmdline，供 looksLikeBackend 用） */
function nodeEval(script, extraArgv = []) {
  return spawn(NODE, [...NODE_OPTS, '-e', script, ...extraArgv], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 等子进程退出（已退出则立即返回；带超时，避免测试挂死） */
function waitExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程 ${child.pid} ${timeoutMs}ms 内未退出`)), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

/** 轮询等待条件成立（等收割/等 reparent 的必然延迟，别用固定 sleep 赌） */
async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 收尾：确保子进程被杀且已收割（测试失败时也不留后台进程） */
async function killAndWait(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try {
    await waitExit(child, 3000);
  } catch {
    /* 已在退出路径上：忽略 */
  }
}

test('pidAlive：自己/活着的子进程 → true；已退出的子进程与非法 pid → false', async () => {
  assert.equal(pidAlive(process.pid), true);
  const child = nodeEval(IDLE);
  try {
    assert.equal(pidAlive(child.pid), true);
  } finally {
    child.kill('SIGKILL');
  }
  await waitExit(child);
  await waitFor(() => !pidAlive(child.pid), `pid ${child.pid} 退出后不再存活`);
  // 非法输入：Python `platcompat.pid_alive` 同口径一律 False（绝不抛）
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('abc'), false);
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(undefined), false);
});

test('terminatePid：只向单个 pid 投递；对不存在的 pid 返回 false 且不抛', async () => {
  const dead = nodeEval('');
  await waitExit(dead);
  assert.equal(terminatePid(dead.pid), false, '已退出/不存在的 pid 投递失败即可，不抛');
  assert.equal(terminatePid(0), false);

  const child = nodeEval(IDLE);
  try {
    assert.equal(terminatePid(child.pid, 'SIGTERM'), true);
    const { signal } = await waitExit(child);
    assert.equal(signal, 'SIGTERM');
  } finally {
    await killAndWait(child);
  }
});

test('looksLikeBackend：同时接受 backend/server.js 与 server.py；普通进程 → false', async () => {
  const serverJs = path.resolve(import.meta.dirname, '..', 'server.js');   // 含 backend/server.js
  const kids = [
    nodeEval(IDLE, [serverJs]),                    // 命令行含 backend/server.js（Node 后端）
    nodeEval(IDLE, ['/repo/server.py']),           // 命令行含 server.py（Python 后端）
    nodeEval(IDLE),                                // 普通 node 进程
    nodeEval(IDLE, ['/repo/not-a-backend.js']),    // 名字像但不是
  ];
  try {
    assert.equal(looksLikeBackend(kids[0].pid), true, 'Node 后端必须被认出（两版互为孤儿时要能收口）');
    assert.equal(looksLikeBackend(kids[1].pid), true, 'Python 后端必须被认出');
    assert.equal(looksLikeBackend(kids[2].pid), false);
    assert.equal(looksLikeBackend(kids[3].pid), false);
  } finally {
    await Promise.all(kids.map((k) => killAndWait(k)));
  }
});

test('looksLikeBackend：非 Linux 走真实命令行（回归：Windows 无 /proc 时不许无条件返回 true）', () => {
  // 真机事故（2026-10-17 桌面端 npm 0.3.0，Windows）：残留 `.pid` 里的 pid 被无关进程
  // （OpenConsole.exe）复用后，旧实现 `process.platform !== 'linux' ⇒ return true` 让
  // 「是否像本平台后端」恒真 ⇒ 既误拦启动（exit 3 永久卡死），又埋着 SIGTERM 误杀无关进程的风险
  // （`reapStale` 收口存量孤儿时按这个判据决定杀不杀）。
  //
  // 现口径：从平台真实拿命令行（Windows: PowerShell Get-CimInstance / wmic；macOS: ps），
  // 拿不到就返回 **false** ——「确认不了」不能当成「像后端」：它同时会触发启动拦截与进程终止，
  // 两个方向的误判代价都远大于「对 M1 之前的 flock-only 旧实例少拦一次」。
  const byOptions = (platform, readCmdline) =>
    looksLikeBackend(424242, { platform, readCmdline: typeof readCmdline === 'function' ? readCmdline : () => readCmdline });

  // Windows：读得到命令行 ⇒ 与 Linux 同一判据（反斜杠归一后比 substring）
  assert.equal(byOptions('win32', [
    '"C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.24.12741.0_x64__8wekyb3d8bbwe\\OpenConsole.exe"',
    '--headless',
  ]), false, '真机事故现场：pid 被复用成 OpenConsole.exe ⇒ 不许认成后端');
  assert.equal(byOptions('win32', [
    '"C:\\Program Files\\nodejs\\node.exe"',
    '"C:\\Users\\user\\.dsh\\profiles\\desktop\\node_modules\\@gavinc-cn\\touchstone-dsh\\backend\\server.js"',
    '--host', '127.0.0.1',
  ]), true, 'Windows 后端命令行含 backend\\server.js ⇒ 必须认出');
  assert.equal(byOptions('win32', ['"C:\\Python312\\python.exe"', '"C:\\x\\server.py"']), true,
    'Python 后端命令行含 server.py ⇒ 必须认出');
  assert.equal(byOptions('darwin', '/usr/local/bin/python3 /repo/server.py --host 127.0.0.1'), true,
    'macOS 走 ps 拿到的命令行同样要能认出');
  // 拿不到命令行（权限不足 / 进程刚消失 / PowerShell 不可用）⇒ false（不拦、不杀）
  assert.equal(byOptions('win32', () => { throw new Error('拒绝访问'); }), false,
    '读不到命令行必须返回 false，不许再恒真');
  assert.equal(byOptions('darwin', () => null), false);
  // Linux 缺省路径：/proc 读不到（不存在的 pid）同样是 false
  assert.equal(looksLikeBackend(99999999), false, '不存在的 pid 读不到 /proc ⇒ 不能断言像后端');
});

test('collectDescendants：宽度优先收集全部后代（父先于子，不含自身）', async () => {
  const root = spawn(NODE, [...NODE_OPTS, '-e', TREE_ROOT], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const kidPids = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('树根未打印子进程 pid')), 8000);
      let buffer = '';
      root.stdout.setEncoding('utf8');
      root.stdout.on('data', (chunk) => {
        buffer += chunk;
        const line = buffer.split('\n')[0];
        if (line.includes(']')) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
    });
    await waitFor(() => collectDescendants(root.pid).length >= 2, '收齐 2 个后代');
    const descendants = collectDescendants(root.pid);
    assert.deepEqual([...descendants].sort((a, b) => a - b), [...kidPids].sort((a, b) => a - b));
    assert.equal(descendants.includes(root.pid), false, '不得包含自身');
    assert.ok(descendants.indexOf(kidPids[0]) < descendants.length);
  } finally {
    await killAndWait(root);
  }
});

test('killTree：连子进程一起收掉（先 SIGTERM，宽限内全死则不升级）', async () => {
  const root = spawn(NODE, [...NODE_OPTS, '-e', TREE_ROOT], { stdio: ['ignore', 'pipe', 'pipe'] });
  let kidPids = [];
  try {
    kidPids = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('树根未打印子进程 pid')), 8000);
      let buffer = '';
      root.stdout.setEncoding('utf8');
      root.stdout.on('data', (chunk) => {
        buffer += chunk;
        const line = buffer.split('\n')[0];
        if (line.includes(']')) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
    });
    await waitFor(() => collectDescendants(root.pid).length >= 2, '收齐 2 个后代');

    const started = Date.now();
    const result = killTree(root.pid, { graceMs: 1500 });
    const elapsed = Date.now() - started;
    assert.ok(result.signaled >= 3, `应当向整树（根 + 2 子）投递信号，实际 ${result.signaled}`);

    await waitExit(root);                                   // 根是我们自己的子进程：等收割
    await waitFor(
      () => !pidAlive(root.pid) && kidPids.every((pid) => !pidAlive(pid)),
      '根与两个子进程全部退出',
    );
    assert.equal(result.killed, 0, 'SIGTERM 足够时不该有任何 SIGKILL 升级');
    assert.deepEqual(result.alive, [], '僵尸按已退出计：回来时不该还有「仍在运行」的目标');
    assert.ok(elapsed < 1500, `全树都停了就不该等满宽限（实际 ${elapsed}ms）`);
  } finally {
    await killAndWait(root);
    for (const pid of kidPids) {
      if (pidAlive(pid)) terminatePid(pid, 'SIGKILL');
    }
  }
});

test('killTree：忽略 SIGTERM 的顽固进程在宽限后被 SIGKILL 升级收掉', async () => {
  const child = spawn(NODE, [...NODE_OPTS, '-e', STUBBORN], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('顽固进程未打印 READY')), 8000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (chunk.includes('READY')) { clearTimeout(timer); resolve(); } });
    });
    const started = Date.now();
    const result = killTree(child.pid, { graceMs: 400 });
    const elapsed = Date.now() - started;
    assert.equal(result.killed, 1, '顽固进程应被计入 SIGKILL 升级');
    assert.ok(elapsed >= 380, `应先给足宽限再升级（实际 ${elapsed}ms）`);
    const { signal } = await waitExit(child);
    assert.equal(signal, 'SIGKILL', 'SIGTERM 被忽略后必须走 SIGKILL');
  } finally {
    await killAndWait(child);
  }
});

test('killTree：对不存在的 pid 安全返回（不抛，与 lifecycle._safe_kill_tree 同口径）', async () => {
  const gone = nodeEval('');
  await waitExit(gone);
  const result = killTree(gone.pid, { graceMs: 50 });
  assert.deepEqual(result, { signaled: 0, killed: 0, alive: [] });
  assert.deepEqual(killTree(0), { signaled: 0, killed: 0, alive: [] });
});
