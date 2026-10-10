/**
 * 缺省解释器探测自检（不经 dsh, 2026-10-11）。
 *
 * 用法: node scripts/dev-check-python.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：用户口径「兜底应该用 python, 不要用 python3」——`lib/index.js` 未配置
 * `pythonPath` 时按 `python` → `python3` 顺序**真跑一次** `-c pass` 探解释器。
 * 这条探测链决定「零配置安装能不能起来」, 但它是 PATH 相关的行为, 单测拿不到,
 * 所以用「临时 bin 目录 + 假解释器」把 PATH 完全控制住, 把三件事钉死：
 *   ① `python` 可用 ⇒ 选它（顺序正确, 不被 python3 抢）;
 *   ② `python` 不可用而 `python3` 可用 ⇒ 回落到 python3;
 *   ③ 两个都不可用 ⇒ 退出码 1（调用方据此给「装 Python / 配 pythonPath」的提示页）;
 *   ④ 探测是**真跑**不是查文件：一个存在但执行即失败的 `python` 必须被判不可用。
 * 最后再用真 PATH 跑一次（本机必有 python3, 否则该环境连测试都跑不了）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB = path.resolve(import.meta.dirname, '../lib/index.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/** 造一个假解释器: 收得下探测调用（`-c <probe>`）, 按 exitCode 决定成败。 */
function makeFakePython(dir, name, exitCode, executable = true) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, ['#!/bin/sh', `exit ${exitCode}`, ''].join('\n'));
  fs.chmodSync(file, executable ? 0o755 : 0o644);
  return file;
}

const tmpDirs = [];
function makeBin(...specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-python-check-'));
  tmpDirs.push(dir);
  for (const [name, exitCode, executable] of specs) makeFakePython(dir, name, exitCode, executable);
  return dir;
}

/** 在指定 PATH 下跑一次解析入口（只给 python 探测用的最小环境, 免得真解释器混进来）。 */
function resolveWithPath(dir) {
  const res = spawnSync(process.execPath, [LIB, '--resolve-python'], {
    encoding: 'utf8',
    // PATH 只留假 bin: `python`/`python3` 都只能从这里解析, 结论才确定
    env: { PATH: dir, HOME: process.env.HOME || '' },
    timeout: 20000,
  });
  return { out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), status: res.status };
}

/** 真 PATH 下的解析（同一入口, 不设 PATH 覆盖）。 */
function resolveReal() {
  const res = spawnSync(process.execPath, [LIB, '--resolve-python'], { encoding: 'utf8', timeout: 20000 });
  return { out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), status: res.status };
}

console.log('== 缺省解释器探测自检（python 优先 / python3 回落 / 都没有 / 真跑而非查文件）==');
try {
  // ---- ① 两个都在且都能跑 ⇒ 必须选 python ----
  const onlyNamesOpt = ['python3', 'python'];
  const bothDir = makeBin(['python', 0], ['python3', 0]);
  const both = resolveWithPath(bothDir);
  check('python 与 python3 都可用时选 python',
    both.status === 0 && both.out === 'python', JSON.stringify(both));

  // ---- ② 只有 python3 ⇒ 回落到 python3 ----
  const onlyPy3Dir = makeBin(['python3', 0]);
  const onlyPy3 = resolveWithPath(onlyPy3Dir);
  check('只有 python3 时回落到 python3',
    onlyPy3.status === 0 && onlyPy3.out === 'python3', JSON.stringify(onlyPy3));

  // ---- ③ 一个都没有 ⇒ 退出码 1（调用方据此给「装 Python」提示页） ----
  const noneDir = makeBin();
  const none = resolveWithPath(noneDir);
  check('都没有时退出码 1 且说明试过哪些名字',
    none.status === 1 && none.out === '' && none.err.includes('python')
    && none.err.includes('python3'), JSON.stringify(none));

  // ---- ④ 存在但跑不起来 ⇒ 判不可用（顺序与「真跑」两件事一起验） ----
  const broken = resolveWithPath(makeBin(['python', 3], ['python3', 0]));
  check('python 存在但执行失败时跳过它、回落 python3',
    broken.status === 0 && broken.out === 'python3', JSON.stringify(broken));

  // 不可执行文件（缺 +x）也算不可用: spawn 会 EACCES —— 不许「文件在就算有」
  const notExec = resolveWithPath(makeBin(['python', 0, false], ['python3', 0]));
  check('不可执行的 python 文件不算数（回落 python3）',
    notExec.status === 0 && notExec.out === 'python3', JSON.stringify(notExec));

  // ---- 真 PATH：本机必须能探到一支 ----
  const real = resolveReal();
  check('真 PATH 下能探到解释器（本机现状）',
    real.status === 0 && onlyNamesOpt.includes(real.out), JSON.stringify(real));
} finally {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
