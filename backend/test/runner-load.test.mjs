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

test('pythonExe：PATH 里没有 python3 ⇒ 抛具名错误（绝不回落 "python3" 字面量）', async () => {
  const saved = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), 'ts-空路径-不存在');
  try {
    // 缓存是模块级的 ⇒ 用查询串另取一份模块实例（同 ESM 语义下的「全新模块」）
    const fresh = await import('../lib/runner.js?no-python-on-path');
    assert.throws(() => fresh.pythonExe(), (err) => {
      assert.equal(err.name, 'PythonInterpreterMissing');
      assert.ok(err instanceof fresh.PythonInterpreterMissing);
      return true;
    });
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(runner.pythonExe(), runner.pythonExe());     // 已缓存的那份不受影响
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
