/**
 * backend/lib/worktree.js 单测（node --test，零依赖）——**只读子集**，用**真 git 仓库**验。
 *
 * 为什么必须真跑 git：本模块的契约就是「跑 `git -C …` 并把结果归一成中文错误串/dict」，
 * mock 掉 git 等于把被测对象换掉。故每个用例在 `mkdtemp` 目录里 `git init` 一个独立仓库
 * （**绝不碰本仓库**：不跑指向本仓的 `git -C`，不读它的状态），
 * `git worktree add` 造真工作树，再断言 ahead/behind/dirty。
 *
 * 覆盖：
 *   ① `branchFor` 的确定性命名；
 *   ② `preview`：非 git 仓库的中文原因 / 真仓库的 path+branch+exists / 仓库内回退落点；
 *   ③ `headBranch`：正常分支名 / 游离 HEAD 的中文原因；
 *   ④ `mergeStatus`：无待合并（ahead=0）/ 有未回流提交（ahead>0）/ 脏工作树 dirty_count /
 *      分支不存在按「无待合并」放行 / 目录不存在 / 无 worktree 标记；
 *   ⑤ `git` 的降级口径：目录不存在 ⇒ `rc=-1` 且是**返回值**不是异常。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as worktree from '../lib/worktree.js';

// --------------------------------------------------------------------------
// git 夹具：一个 mkdtemp 里的真仓库（每测一个，互不干扰）
// --------------------------------------------------------------------------

/** 跑一条 git 命令（夹具用；显式隔离全局/系统配置，结果与开发机配置无关） */
function git(args, cwd) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'ts-test',
    GIT_AUTHOR_EMAIL: 'ts@example.invalid',
    GIT_COMMITTER_NAME: 'ts-test',
    GIT_COMMITTER_EMAIL: 'ts@example.invalid',
  };
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (p.status !== 0) {
    throw new Error(`夹具 git ${args.join(' ')} 失败(${p.status}): ${p.stderr}`);
  }
  return p.stdout;
}

/**
 * 造一个真仓库夹具：`<dir>/repo` 是仓库，`<dir>/wt` 是数据目录（work_dir 落这里，
 * 于是卡片 worktree 会建到 `<dir>/wt/worktrees/card_N` —— 在仓库**外**，不需要回退）。
 */
function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wt-'));
  const repo = path.join(dir, 'repo');
  const work = path.join(dir, 'wt');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const project = {
    id: 1, project_dir: repo, work_dir: work, name: 'repo',
  };
  return { dir, repo, work, project };
}

test('branchFor：确定性命名 ts/card-<id>（非法输入归一 NaN，与 Python int() 抛错不同）', () => {
  assert.equal(worktree.branchFor(7), 'ts/card-7');
  assert.equal(worktree.branchFor('42'), 'ts/card-42');
  assert.equal(worktree.BRANCH_PREFIX, 'ts/card-');
  assert.equal(worktree.WT_DIRNAME, 'worktrees');
  assert.equal(worktree.FALLBACK_DIRNAME, '.touchstone-worktrees');
});

test('preview：非 git 仓库 ⇒ ok=false + 中文原因；空目录 ⇒ 项目目录不存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wt-nogit-'));
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  const pv = worktree.preview({ project_dir: plain, work_dir: plain }, 3);
  assert.equal(pv.ok, false);
  assert.match(pv.error, /不是 git 仓库/);
  assert.equal(pv.path, '');
  assert.equal(pv.branch, 'ts/card-3', 'branch 仍给（前端置灰时也显示）');
  assert.equal(pv.exists, false);
  assert.deepEqual(Object.keys(pv).sort(),
    ['branch', 'error', 'exists', 'ok', 'path', 'root']);

  // 目录不存在 ⇒ 「项目目录不存在」
  const missing = worktree.preview({ project_dir: path.join(dir, 'nope'), work_dir: dir }, 3);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /项目目录不存在/);
  // 空 project_dir ⇒ 「项目目录为空」
  const empty = worktree.preview({ project_dir: '', work_dir: dir }, 3);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /项目目录为空/);
});

test('preview：真仓库 ⇒ ok=true，path 落 <work_dir>/worktrees/card_<id>，exists 反映磁盘', () => {
  const fx = gitRepo();
  const pv = worktree.preview(fx.project, 5);
  assert.equal(pv.ok, true);
  assert.equal(pv.error, '');
  assert.equal(pv.branch, 'ts/card-5');
  assert.equal(pv.root, fs.realpathSync(fx.repo), 'root = git 顶层（realpath 归一 /tmp 软链差异）');
  assert.equal(pv.path, path.join(fx.work, 'worktrees', 'card_5'));
  assert.equal(pv.exists, false, '未创建 ⇒ false（**只读，不落盘**）');
  assert.equal(fs.existsSync(pv.path), false, 'preview 绝不建目录');
  // 真建出来后 exists = true
  git(['worktree', 'add', '-q', pv.path, '-b', pv.branch], fx.repo);
  const pv2 = worktree.preview(fx.project, 5);
  assert.equal(pv2.exists, true);
});

test('worktreePath：落点在仓库内 ⇒ 回退仓库同级 .touchstone-worktrees/<名>_card_<id>', () => {
  const fx = gitRepo();
  // work_dir 落进仓库内部（项目常见形态：<project_dir>/.touchstone）
  const inner = { ...fx.project, work_dir: path.join(fx.repo, '.touchstone') };
  const p = worktree.worktreePath(inner, 9, fx.repo);
  assert.equal(p, path.join(fx.dir, '.touchstone-worktrees', 'repo_card_9'));
  // 不传 repoRoot 时按 project_dir 判定（回退同样成立）
  assert.equal(worktree.worktreePath(inner, 9), p);
  // 仓库外（正常形态）不回退
  assert.equal(worktree.worktreePath(fx.project, 9, fx.repo),
    path.join(fx.work, 'worktrees', 'card_9'));
  // work_dir 为空 ⇒ 回落 project_dir（照 Python `work_dir or project_dir`）
  const noWork = { project_dir: fx.repo, work_dir: '' };
  assert.equal(worktree.worktreePath(noWork, 9, fx.repo),
    path.join(fx.dir, '.touchstone-worktrees', 'repo_card_9'));
});

test('headBranch：主仓库当前分支；游离 HEAD ⇒ 中文原因且 name 为空', () => {
  const fx = gitRepo();
  assert.deepEqual(worktree.headBranch(fx.repo), { name: 'main', error: '' });
  // 造游离 HEAD
  const sha = git(['rev-parse', 'HEAD'], fx.repo).trim();
  git(['checkout', '-q', '--detach', sha], fx.repo);
  const detached = worktree.headBranch(fx.repo);
  assert.equal(detached.name, '');
  assert.match(detached.error, /游离 HEAD/);
});

test('mergeStatus：无待合并（分支不存在 / 分支与主分支同点）都按 ok=true + ahead=0', () => {
  const fx = gitRepo();
  const pv = worktree.preview(fx.project, 4);
  git(['worktree', 'add', '-q', pv.path, '-b', pv.branch], fx.repo);
  const card = { id: 4, worktree: pv.path, session_id: '' };

  // 刚建出来：分支指向与 main 同一提交 ⇒ ahead=0/behind=0/dirty=false
  const st = worktree.mergeStatus(fx.project, card);
  assert.equal(st.ok, true);
  assert.equal(st.error, '');
  assert.equal(st.branch, 'ts/card-4');
  assert.equal(st.target, 'main');
  assert.equal(st.exists, true);
  assert.equal(st.branch_exists, true);
  assert.equal(st.ahead, 0);
  assert.equal(st.behind, 0);
  assert.equal(st.dirty, false);
  assert.equal(st.dirty_count, 0);
  assert.deepEqual(Object.keys(st).sort(), [
    'ahead', 'behind', 'branch', 'branch_exists', 'dirty', 'dirty_count',
    'error', 'exists', 'ok', 'path', 'target',
  ]);

  // 分支不存在（删掉）⇒ 没有可合并的东西，按 ok=true/ahead=0 放行。
  // 注意**顺序**：`merge_status` 先判 `os.path.isdir(path)`（目录不存在就早退 ok=false），
  // 再判分支存在 ⇒ 要走到「分支不存在」分支，目录必须还在。故摘掉工作树后把空目录补回来，
  // 模拟「用户删过工作树目录但分支留着 / 分支被单独删掉」的真实形态。
  git(['worktree', 'remove', pv.path], fx.repo);
  git(['branch', '-D', pv.branch], fx.repo);
  fs.mkdirSync(pv.path, { recursive: true });
  const gone = worktree.mergeStatus(fx.project, card);
  assert.equal(gone.exists, true);
  assert.equal(gone.branch_exists, false);
  assert.equal(gone.ok, true, '没有可合并的东西 ⇒ 放行（调用方按普通卡完成）');
  assert.equal(gone.ahead, 0);
  assert.equal(gone.dirty, false);

  // 卡上没有 worktree 标记 / 目录不存在 ⇒ ok=false + 中文原因（调用方按「不拦用户」处置）
  assert.equal(worktree.mergeStatus(fx.project, { id: 4, worktree: '' }).ok, false);
  assert.match(worktree.mergeStatus(fx.project, { id: 4, worktree: '' }).error, /没有独立 worktree/);
  const noDir = worktree.mergeStatus(fx.project, { id: 4, worktree: path.join(fx.dir, 'nope') });
  assert.equal(noDir.ok, false);
  assert.match(noDir.error, /worktree 目录不存在/);
});

test('mergeStatus：ahead>0（未回流提交）与 dirty_count（含未跟踪），behind 随主分支前进', () => {
  const fx = gitRepo();
  const pv = worktree.preview(fx.project, 6);
  git(['worktree', 'add', '-q', pv.path, '-b', pv.branch], fx.repo);
  const card = { id: 6, worktree: pv.path, session_id: '' };

  // 工作树里提交两次（未回流）
  fs.writeFileSync(path.join(pv.path, 'b.txt'), 'b\n');
  git(['add', '.'], pv.path);
  git(['commit', '-q', '-m', 'wt-1'], pv.path);
  fs.writeFileSync(path.join(pv.path, 'c.txt'), 'c\n');
  git(['add', '.'], pv.path);
  git(['commit', '-q', '-m', 'wt-2'], pv.path);
  // 未跟踪文件（dirty 判据含未跟踪，照 plan D8）
  fs.writeFileSync(path.join(pv.path, 'untracked.txt'), 'u\n');

  const st = worktree.mergeStatus(fx.project, card);
  assert.equal(st.ok, true);
  assert.equal(st.ahead, 2, 'ts/card-6 比 main 多 2 个提交 = 有改动待回流');
  assert.equal(st.behind, 0);
  assert.equal(st.dirty, true);
  assert.equal(st.dirty_count, 1, '只有未跟踪那一处（两个提交已入库）');

  // 主分支前进一次 ⇒ behind=1（agent 需先同步）
  fs.writeFileSync(path.join(fx.repo, 'd.txt'), 'd\n');
  git(['add', '.'], fx.repo);
  git(['commit', '-q', '-m', 'main-1'], fx.repo);
  const st2 = worktree.mergeStatus(fx.project, card);
  assert.equal(st2.ahead, 2);
  assert.equal(st2.behind, 1);
});

test('git 降级口径：跑不起来的 git 是非 0 **返回值**（不抛）；gitInt 异常输出归一 0', () => {
  // 目录不存在：git 自身 exit 128（stderr 非空）——与 Python `subprocess.run` 逐点同
  // （两侧都不把它归一到 -1；`-1` 只留给「git 可执行文件都起不来」的 OSError/ENOENT）
  const r = worktree.git(['rev-parse', 'HEAD'], path.join(os.tmpdir(), 'ts-no-such-dir-xyz'));
  assert.notEqual(r.rc, 0);
  assert.equal(r.out, '');
  assert.match(r.err, /cannot change|No such file/);
  // 非仓库目录：rc !== 0 且 err 非空（调用方按错误串回 400）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wt-plain-'));
  const notRepo = worktree.git(['rev-parse', '--show-toplevel'], dir);
  assert.notEqual(notRepo.rc, 0);
  assert.ok(notRepo.err.length > 0, 'stderr 摘要非空');
  assert.ok(notRepo.err.length <= 300, '错误串截断 ≤ 300 字');

  // 「git 起不来」分支（rc=-1 + 统一文案）用**可信不可执行**的 PATH 触发：
  // 这是 `_git` 的 `except OSError` 分支在 Node 侧的对应物（spawnSync 的 error）。
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), 'ts-no-such-bin-dir-xyz');
  try {
    const missing = worktree.git(['rev-parse', 'HEAD'], os.tmpdir());
    assert.equal(missing.rc, -1);
    assert.equal(missing.out, '');
    assert.match(missing.err, /git 不可用/);
  } finally {
    process.env.PATH = savedPath;
  }

  assert.equal(worktree.gitInt('7\n'), 7);
  assert.equal(worktree.gitInt(''), 0);
  assert.equal(worktree.gitInt('abc'), 0);
  assert.equal(worktree.gitInt('3\n9\n'), 3, '只取第一行');
});
