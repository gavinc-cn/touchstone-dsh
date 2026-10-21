/**
 * `backend/lib/runner.js` **M6.5-R2 的执行记录回归钉**（`node --test`，零依赖）。
 *
 * 为什么单独一个文件：`execution_<分钟戳>_script.md` 的**文件名就是时刻**，而量具
 * （`tools/parity/mod-run.mjs`）的 `state.files` 只认字面路径、没有 glob ⇒ 对拍里**寻址不到**
 * 这份文件（`state.tree` 能比键、比不了内容：记录正文含 `- **时间**: %Y-%m-%d %H:%M`）。
 * 于是「记录全文」这条判据只能落在单测里，**期望值取自 Python oracle 的真实观测**
 * （`python3` 直调 `Runner._run_one_script` 打印记录，见下方 golden 常量），不是手抄：
 *
 *   - 退出码 0 `_run_one_script(..., '预发环境')`
 *   - 退出码 3（非协议码 ⇒ 归一成 1，正文追加 `### 非协议退出码 3，按疑似回归处理`）
 *   - 超时（`Runner.SCRIPT_RETEST_TIMEOUT = 1` + 脚本 `sleep 30` ⇒
 *     `### 执行超时（>1s），按疑似回归处理`；Node 侧靠**实例属性覆写**注入同一超时，
 *     见 runner.js 构造器注释）
 *   - 启动失败（`cwd` 不存在 ⇒ `[1, …]` 且**不落盘**记录）
 *
 * 三条硬约束（照 `runner-core.test.mjs` / `runner-bug.test.mjs` 的既有口径）：
 *   - **临时库、绝不用生产库**：`freshDb` 把 `TOUCHSTONE_DB` 指到一次性目录（本文件其实
 *     不碰库，但夹具的进程级兜底闸仍是「单测结构上写不到生产库」的那道保证）；
 *   - **不起真后台循环**：`new Runner(true, …)`（启动闸关着），只直调纯逻辑方法；
 *   - **不 mock 子进程**：真起 `python3`（与生产同一条路径：A 侧 `sys.executable` 的
 *     对应物 = `runner.pythonExe()` 解析出的绝对路径）。
 *
 * 其余 R2 分支（完成序 ⇒ `failed_ids`、`_spawn_load` 的停止两支、`_write_load_report` 四支、
 * `_script_live` 合并语义、`_next_load_round_no` 三档、`_spawn_retest_task` 去重）都由
 * `tools/parity/cases-mod/runner_script_load.json` 与 Python 逐字节对拍，这里不重复。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as runner from '../lib/runner.js';
import { freshDb } from './m3fixture.mjs';

/** 一份 fixture：临时库（进程级 `TOUCHSTONE_DB` 兜底）+ 停闸 Runner + 一个用例目录。 */
function withCase(tag, verifyPy, fn) {
  const fx = freshDb(`r2-${tag}`);
  const caseDir = path.join(fx.dir, 'case');
  fs.mkdirSync(caseDir, { recursive: true });
  if (verifyPy !== null) fs.writeFileSync(path.join(caseDir, 'verify.py'), verifyPy, 'utf8');
  const inst = new runner.Runner(true, { db: fx.db });
  try {
    const ret = fn(inst, caseDir);
    if (ret && typeof ret.then === 'function') return ret.finally(() => fx.close());
    fx.close();
    return ret;
  } catch (err) {
    fx.close();
    throw err;
  }
}

/** 读该用例目录里唯一那份执行记录，并把 `- **时间**: …` 行掩成占位（挂钟不进判据）。 */
function recordText(caseDir) {
  const names = fs.readdirSync(caseDir).filter((n) => n.startsWith('execution_'));
  assert.equal(names.length, 1, `应恰好落一份执行记录，实到 ${JSON.stringify(names)}`);
  return fs.readFileSync(path.join(caseDir, names[0]), 'utf8')
    .replace(/^- \*\*时间\*\*: .*$/m, '- **时间**: <time>');
}

const HEAD = (code, envLabel) => '# 脚本复测执行记录\n\n- **时间**: <time>\n'
  + `- **执行环境**: ${envLabel}\n- **退出码**: ${code}\n\n## 脚本输出\n\n\`\`\`\n`;

test('runOneScript：退出码 0 的记录全文（Python oracle 逐字节）', async () => {
  const src = "import sys\nprint('out zero')\nsys.stderr.write('err zero\\n')\nsys.exit(0)\n";
  await withCase('zero', src, async (inst, caseDir) => {
    const [code, execName] = await inst.runOneScript(caseDir, '预发环境');
    assert.equal(code, 0);
    assert.match(execName, /^execution_\d{8}_\d{4}_script\.md$/);
    assert.equal(recordText(caseDir),
      `${HEAD(0, '预发环境')}out zero\nerr zero\n\n\`\`\`\n`);
  });
});

test('runOneScript：协议码 1/2 原样保留，非协议码 3 归一成 1 并附注', async () => {
  const src = "import sys\nprint('out three')\nsys.exit(3)\n";
  await withCase('three', src, async (inst, caseDir) => {
    const [code] = await inst.runOneScript(caseDir, '预发环境');
    assert.equal(code, 1);
    assert.equal(recordText(caseDir),
      `${HEAD(1, '预发环境')}out three\n\n### 非协议退出码 3，按疑似回归处理\n\n\`\`\`\n`);
  });
});

test('runOneScript：超时支按疑似回归处理（实例覆写 SCRIPT_RETEST_TIMEOUT）', async () => {
  const src = "import sys, time\nprint('out timeout', flush=True)\n"
    + "sys.stderr.write('err timeout\\n')\ntime.sleep(30)\n";
  await withCase('timeout', src, async (inst, caseDir) => {
    inst.SCRIPT_RETEST_TIMEOUT = 1;                       // 对拍注入不了：只在这里钉
    const t0 = Date.now();
    const [code] = await inst.runOneScript(caseDir, '预发环境');
    assert.equal(code, 1);
    assert.ok(Date.now() - t0 < 15000, '超时应在 1s 量级收口（不是等满 120s）');
    assert.equal(recordText(caseDir),
      `${HEAD(1, '预发环境')}out timeout\nerr timeout\n\n`
      + '### 执行超时（>1s），按疑似回归处理\n\n```\n');
  });
});

test('runOneScript：cwd 不存在 ⇒ 启动失败支（归 1，且记录写不进去）', async () => {
  await withCase('badcwd', null, async (inst, caseDir) => {
    const missing = path.join(caseDir, '没有这个目录');
    const [code, execName] = await inst.runOneScript(missing, '本机');
    assert.equal(code, 1);
    assert.match(execName, /^execution_\d{8}_\d{4}_script\.md$/);
    assert.equal(fs.existsSync(path.join(missing, execName)), false);
    // 记录落不进去属**预期**（照 Python `except OSError: pass`）：不能因此抛异常
    assert.equal(fs.existsSync(missing), false);
  });
});

test('pythonExe：解析到绝对路径且缓存（不回落字面量）', () => {
  const exe = runner.pythonExe();
  assert.ok(path.isAbsolute(exe), `应为绝对路径，实到 ${exe}`);
  assert.equal(runner.pythonExe(), exe);
  assert.ok(fs.existsSync(exe));
  assert.equal(typeof runner.PythonInterpreterMissing, 'function');
});

test('pythonExe：PATH 里一个候选都没有 ⇒ 抛具名错误（绝不回落字面量）', () => {
  assert.throws(
    () => runner.pythonExe({ env: { ...process.env, PATH: path.join(os.tmpdir(), 'ts-空路径-不存在') } }),
    (err) => {
      assert.equal(err.name, 'PythonInterpreterMissing');
      assert.ok(err instanceof runner.PythonInterpreterMissing);
      return true;
    },
  );
  assert.equal(runner.pythonExe(), runner.pythonExe());     // 已缓存的那份不受影响
});

// --------------------------------------------------------------------------
// 解释器解析：候选顺序 / 真跑探测 / 显式覆盖（跨平台；Windows 官方安装器只有 python.exe）
//
// 为什么不能「查文件在不在」：Windows 的 Microsoft Store 会在 PATH 上放 python3.exe
// 占位别名（GUI 应用，真跑不返回）、部分环境的 python 是 python2 或坏 shim ——
// 只有真 spawn 一次才识破。故决策逻辑用**注入的假探针**做纯单测（跨平台同一套判据），
// 真 spawn 的探针协议另由下面的 POSIX 假解释器用例端到端钉住（Windows 上跑不了 /bin/sh
// 假脚本，真机由系统 python 覆盖，见 spec/platform/Windows原生运行.md）。
// --------------------------------------------------------------------------

/** 假探针：记录被尝试的候选（`"名字 参数…"`），按表返回绝对路径或 null（=不可用）。 */
function fakeProbe(table, log = []) {
  return (name, args) => {
    log.push([name, ...args].join(' '));
    return table[[name, ...args].join(' ')] ?? null;
  };
}

/** 假环境：PATH 指到一次性目录（保留 HOME 等，避免影响到真解释器）。 */
function fakeEnv(dir) {
  const env = { ...process.env, PATH: dir };
  delete env.TS_PYTHON;
  return env;
}

/**
 * 造一个假解释器（POSIX shell 脚本）：按探针协议打印
 * `ts-python-probe <主版本> <sys.executable 的 UTF-8 hex>`，见 runner.js `probePython`。
 */
function writeFakePython(dir, name, opts = {}) {
  const { major = 3, exe = path.join(dir, name), exitCode = 0, silent = false,
    onlyArg = null } = opts;
  const lines = ['#!/bin/sh'];
  if (onlyArg !== null) lines.push(`[ "$1" = "${onlyArg}" ] || exit 64`);
  if (!silent) {
    lines.push(`printf 'ts-python-probe ${major} ${Buffer.from(exe, 'utf8').toString('hex')}\\n'`);
  }
  lines.push(`exit ${exitCode}`, '');
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

/** 一次性假 bin 目录（挂 t.after 清理）。 */
function tmpBin(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('pythonExe：win32 候选顺序 python → python3 → py -3（官方安装器只有 python.exe）', () => {
  const log = [];
  const exe = runner.pythonExe({
    platform: 'win32',
    env: {},
    probe: fakeProbe({ python: 'C:\\Python312\\python.exe' }, log),
  });
  assert.equal(exe, 'C:\\Python312\\python.exe');
  assert.deepEqual(log, ['python'], '命中即停：不该继续探 python3 / py -3');
});

test('pythonExe：win32 上 python 不可用 ⇒ 回落 py -3 启动器（取它解析出的真解释器）', () => {
  const log = [];
  const exe = runner.pythonExe({
    platform: 'win32',
    env: {},
    probe: fakeProbe({ 'py -3': 'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python312\\python.exe' }, log),
  });
  assert.equal(exe, 'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python312\\python.exe');
  assert.deepEqual(log, ['python', 'python3', 'py -3']);
});

test('pythonExe：POSIX 保持 python3 优先、python 仅作回退（对拍口径不变）', () => {
  const log = [];
  const exe = runner.pythonExe({
    platform: 'linux',
    env: {},
    probe: fakeProbe({ python3: '/usr/bin/python3', python: '/usr/bin/python' }, log),
  });
  assert.equal(exe, '/usr/bin/python3');
  assert.deepEqual(log, ['python3'], 'python3 命中即停');
  // 只有 python（无 python3）也能用：有些精简发行版/虚拟环境只有 python
  const fallbackLog = [];
  assert.equal(runner.pythonExe({
    platform: 'linux',
    env: {},
    probe: fakeProbe({ python: '/usr/bin/python' }, fallbackLog),
  }), '/usr/bin/python');
  assert.deepEqual(fallbackLog, ['python3', 'python']);
});

test('pythonExe：全部不可用 ⇒ 抛具名错误，文案列出试过的候选与两条修法', () => {
  assert.throws(
    () => runner.pythonExe({ platform: 'win32', env: {}, probe: () => null }),
    (err) => {
      assert.equal(err.name, 'PythonInterpreterMissing');
      assert.match(err.message, /python、python3、py -3/);   // 按尝试顺序列出
      assert.match(err.message, /TS_PYTHON/);
      assert.match(err.message, /Add python\.exe to PATH/);
      return true;
    },
  );
});

test('pythonExe：TS_PYTHON 显式覆盖优先（绝对路径 / 名字都行），失败不静默回落', () => {
  const log = [];
  const exe = runner.pythonExe({
    platform: 'linux',
    env: { TS_PYTHON: '/opt/venv/bin/python' },
    probe: fakeProbe({ '/opt/venv/bin/python': '/opt/venv/bin/python' }, log),
  });
  assert.equal(exe, '/opt/venv/bin/python');
  assert.deepEqual(log, ['/opt/venv/bin/python'], '显式覆盖要先于 PATH 候选，且命中即停');
  // 显式配置写错 ⇒ 响亮报错（不静默换 PATH 上另一支：那会让「配了 A 却跑 B」成为谜案）
  const badLog = [];
  assert.throws(
    () => runner.pythonExe({
      platform: 'linux',
      env: { TS_PYTHON: 'C:\\bad\\python.exe' },
      probe: fakeProbe({ python3: '/usr/bin/python3' }, badLog),
    }),
    (err) => {
      assert.equal(err.name, 'PythonInterpreterMissing');
      assert.match(err.message, /TS_PYTHON/);
      assert.ok(err.message.includes('C:\\bad\\python.exe'));
      return true;
    },
  );
  assert.deepEqual(badLog, ['C:\\bad\\python.exe'], '覆盖失败后不该再探 PATH 候选');
});

test('pythonExe：注入缝不走缓存（生产调用才缓存）', () => {
  const a = runner.pythonExe({ platform: 'linux', env: {}, probe: () => '/a/python3' });
  const b = runner.pythonExe({ platform: 'linux', env: {}, probe: () => '/b/python3' });
  assert.notEqual(a, b);
});

test('pythonExe：真 spawn 的探针能认出坏候选（退出码 / python2 / 无探针输出）', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX 假解释器脚本（Windows 真机由系统 python 覆盖）');
    return;
  }
  const dir = tmpBin(t, 'py-bad');
  writeFakePython(dir, 'python', { exitCode: 3 });            // 存在但跑不起来
  writeFakePython(dir, 'python3', { major: 2 });             // 是 python2 哨兵（不是 Python 3）
  writeFakePython(dir, 'py', { silent: true });              // 退出 0 但没有探针输出
  assert.throws(() => runner.pythonExe({ env: fakeEnv(dir) }), /PythonInterpreterMissing/);
  // 把 python 换成好的 ⇒ 立即恢复（证明失败不缓存、上面的抛错是「候选全坏」而不是解析器崩了）
  writeFakePython(dir, 'python');
  assert.equal(runner.pythonExe({ env: fakeEnv(dir) }), path.join(dir, 'python'));
});

test('pythonExe：系统默认解释器只叫 python（无 python3）⇒ 真 spawn 也能解析（Windows 形态）', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX 假解释器脚本（Windows 真机由系统 python 覆盖）');
    return;
  }
  const dir = tmpBin(t, 'py-only-python');
  writeFakePython(dir, 'python');
  const exe = runner.pythonExe({ env: fakeEnv(dir) });
  assert.equal(exe, path.join(dir, 'python'));               // 绝对路径，不是字面量
  assert.ok(path.isAbsolute(exe));
  assert.ok(fs.existsSync(exe));
});

test('waitKilled：超时窗口内未退出 ⇒ null（Python `TimeoutExpired` 支）', async () => {
  const inst = new runner.Runner(true, {});
  const proc = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
  try {
    const t0 = Date.now();
    assert.equal(await inst.waitKilled(proc, 300), null);   // 无信号投递：纯等待窗口
    assert.ok(Date.now() - t0 < 15000);
  } finally {
    proc.kill('SIGKILL');
  }
  // 反过来：已退出 ⇒ 给归一后的退出码（而不是 null）
  const done = spawn('/bin/sh', ['-c', 'exit 7'], { stdio: 'ignore' });
  assert.equal(await inst.waitKilled(done, 5000), 7);
});

test('spawnLoad：启动失败支返回 [null, 说明] 且不登记进程表（照 Python `except OSError`）', async () => {
  const fx = freshDb('r2-spawnfail');
  const dir = path.join(fx.dir, 'case');
  fs.mkdirSync(dir, { recursive: true });
  const inst = new runner.Runner(true, { db: fx.db });
  const logPath = path.join(dir, 'load.log');
  const stopPath = path.join(dir, 'load.stop');
  const project = { id: 1, work_dir: dir, project_dir: dir, cases_root: dir };
  try {
    const res = await inst.spawnLoad(project, 1,
      { driver: 'script', case_dir: dir }, ['/不存在的解释器-ts-单测'],
      logPath, stopPath, path.join(dir, 'metrics.jsonl'));
    assert.equal(res[0], null);
    assert.match(res[1], /^发压进程启动失败: /);
    // 照 Python `with open(log_path, "ab")`：失败前日志文件**已被创建**（空）
    assert.equal(fs.readFileSync(logPath, 'utf8'), '');
    assert.equal(inst._procs.has(1), false);                // 未登记
    assert.equal(fs.existsSync(stopPath), false);           // 也没写停止标志
  } finally {
    fx.close();
  }
});

test('spawnLoad：脚本驱动注入的 PYTHONPATH 指向 Python 库目录（run.py 可 import loadgen）', async (t) => {
  // 2026-10-19 Python 后端搬进 backend_py/ 后，脚本的 `import loadgen` 靠 PYTHONPATH：
  // A 侧 runner.py 的 ROOT_DIR = backend_py/（runner.py:58「脚本驱动的 PYTHONPATH 注入点」），
  // Node 侧必须同值 —— 否则 Node 后端（插件缺省）下 agent 按内置提示词写的 run.py 会
  // ModuleNotFoundError（内置提示词明说「脚本可以 import loadgen」）。
  if (process.platform === 'win32') {
    t.skip('POSIX 夹具命令（/bin/sh）；注入值本身与平台无关');
    return;
  }
  const fx = freshDb('r2-pythonpath');
  const dir = path.join(fx.dir, 'case');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'seen-pythonpath.txt');
  const inst = new runner.Runner(true, { db: fx.db });
  const project = { id: 1, work_dir: dir, project_dir: dir, cases_root: dir };
  try {
    const [code] = await inst.spawnLoad(project, 1, { driver: 'script', case_dir: dir },
      ['/bin/sh', '-c', `printf '%s' "$PYTHONPATH" > ${JSON.stringify(out)}`],
      path.join(dir, 'load.log'), path.join(dir, 'load.stop'), path.join(dir, 'metrics.jsonl'));
    assert.equal(code, 0);
    const first = fs.readFileSync(out, 'utf8').split(path.delimiter)[0];
    assert.equal(first, path.join(runner.ROOT_DIR, 'backend_py'),
      'PYTHONPATH 首段应为 Python 库目录（与 Python 后端 ROOT_DIR 同值）');
    assert.ok(fs.existsSync(path.join(first, 'loadgen.py')), 'loadgen.py 必须就在该目录下');
  } finally {
    fx.close();
  }
});

test('createCompletionPool 的入口常量：SCRIPT_WORKERS=4 / SCRIPT_RETEST_TIMEOUT=120', () => {
  assert.equal(runner.SCRIPT_WORKERS, 4);
  assert.equal(runner.SCRIPT_RETEST_TIMEOUT, 120);
  const inst = new runner.Runner(true, {});
  assert.equal(inst.SCRIPT_WORKERS, 4);
  assert.equal(inst.SCRIPT_RETEST_TIMEOUT, 120);
  assert.equal(runner.LOAD_MAX_SECONDS, 7200);
  assert.equal(runner.LOAD_STOP_GRACE, 10.0);
  assert.ok(os.tmpdir().length > 0);                     // 保持 os 引用（夹具口径一致）
});
