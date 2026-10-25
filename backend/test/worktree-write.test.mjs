/**
 * M6-1：`worktree.js` **写口**（`create`/`status`/`remove` + 指针归一）单测，外加**直起路径回归测试**。
 *
 * ## 本文件的第一条测试是「先红后绿」的现场
 * M5 收口时登记了一条未验项「真 worktree create/remove」——它的根因在 M6-1 开工前的静态取证：
 * `board.js:1916` 引用 `worktreePath`，而该标识符**既未 import 也未定义**（全仓 grep 只有那一处引用，
 * 定义在 `worktree.js:116` 的导出里）。⇒ `enterDoingWorktree` → `wtCreate` 一路抛 `ReferenceError`。
 * 为什么 M5 的三层判据全绿却没抓到：函数级对拍（`board-run`）的 op 集合没有 worktree 直起、
 * 实例级对拍（`http-run`）也走不到（需要真 git 仓库 + 未配置驱动两条同时成立），单测同样没覆盖。
 *
 * 本文件把「直起一次真建出工作树」写成断言：**修复前它必须红**（ReferenceError），修复后必须绿。
 *
 * ## 为什么必须真跑 git
 * 本模块的契约就是「跑 `git -C …` 并把结果归一成中文错误串/dict」，mock 掉 git 等于把被测对象换掉。
 * 每个用例在 `mkdtemp` 里 `git init` 一个独立仓库（**绝不碰本仓库**），并显式隔离全局/系统 git 配置。
 *
 * 覆盖：
 *   ① `create`：新建 / 幂等复用 / 用户删目录后重建（分支保留 ⇒ 检出既有分支）/ 路径被占的错误串 /
 *      非 git 仓库的错误串；
 *   ② 指针归一：两处指针（`<wt>/.git` 与 `<repo>/.git/worktrees/<n>/gitdir`）改写为**相对路径**
 *      且 `git rev-parse` 仍可解析（跨平台可用的判据）；
 *   ③ `status`：无标记 / 目录不存在 / 干净 / 脏（含未跟踪）；
 *   ④ `remove`：脏拒删（目录与分支都留着）/ 干净删（目录消失、**分支保留**）/ 两种错误早退；
 *   ⑤ 直起路径回归（上）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as db from '../lib/db.js';
import * as worktree from '../lib/worktree.js';
import { freshDb, insertCard, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// git 夹具（与 worktree.test.mjs 同款：真仓库、隔离配置、绝不碰本仓库）
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

/** 造一个真仓库夹具：`<dir>/repo` 是仓库，`<dir>/wt` 是数据目录（worktree 建在仓库外） */
function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wtw-'));
  const repo = path.join(dir, 'repo');
  const work = path.join(dir, 'wt');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const project = { id: 1, project_dir: repo, work_dir: work, name: 'repo' };
  return { dir, repo, work, project };
}

// --------------------------------------------------------------------------
// create
// --------------------------------------------------------------------------

test('create：新建工作树；幂等复用；用户删目录后重建**保留既往提交**；路径被占报错', () => {
  const fx = gitRepo();
  const [p, branch, err] = worktree.create(fx.project, 7);
  assert.equal(err, '');
  assert.equal(branch, 'ts/card-7');
  assert.equal(p, path.join(fx.work, 'worktrees', 'card_7'));
  assert.equal(fs.existsSync(path.join(p, '.git')), true, '工作树里应有 .git 指针文件');

  // 在工作树里提交一次（未回流），用于验证「重建后历史保留」
  fs.writeFileSync(path.join(p, 'wt.txt'), 'wt\n');
  git(['add', '.'], p);
  git(['commit', '-q', '-m', 'wt-1'], p);
  const sha1 = git(['rev-parse', 'HEAD'], p).trim();

  // 幂等：已可用的工作树直接复用（同 path/branch、无错、内容不动）
  const again = worktree.create(fx.project, 7);
  assert.deepEqual(again, [p, branch, '']);
  assert.equal(git(['rev-parse', 'HEAD'], p).trim(), sha1);

  // 用户手删目录（git 侧仍有注册残留）⇒ 重建走 prune 后重试，且检出**既有分支**（历史保留）
  fs.rmSync(p, { recursive: true, force: true });
  const [p2, branch2, err2] = worktree.create(fx.project, 7);
  assert.equal(err2, '');
  assert.equal(p2, p);
  assert.equal(branch2, branch);
  assert.equal(fs.existsSync(path.join(p2, 'wt.txt')), true, '既有分支被检出 ⇒ 既往提交还在');
  assert.equal(git(['rev-parse', 'HEAD'], p2).trim(), sha1);

  // 路径被占（非本卡工作树的普通目录）⇒ 明确报错，不擅自删用户目录
  const fx2 = gitRepo();
  const occupied = path.join(fx2.work, 'worktrees', 'card_8');
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'user-data.txt'), 'keep\n');
  const [p3, b3, err3] = worktree.create(fx2.project, 8);
  assert.deepEqual([p3, b3], ['', '']);
  assert.equal(err3, `worktree 路径已存在且不可复用：${occupied}`);
  assert.equal(fs.existsSync(path.join(occupied, 'user-data.txt')), true, '不擅自动用户目录');
});

test('create：非 git 仓库 ⇒ 中文错误串（不是异常）；不存在的项目目录同理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wtw-nogit-'));
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  const [p, b, err] = worktree.create({ project_dir: plain, work_dir: plain }, 3);
  assert.deepEqual([p, b], ['', '']);
  assert.match(err, /^无法创建 worktree：项目目录不是 git 仓库（/);
  const missing = worktree.create({ project_dir: path.join(dir, 'nope'), work_dir: dir }, 3);
  assert.match(missing[2], /项目目录不存在/);
});

test('指针归一：两处指针改写为**相对路径**，且 git 仍能解析（跨平台可用判据）', () => {
  const fx = gitRepo();
  const [p] = worktree.create(fx.project, 11);
  const gitfileText = fs.readFileSync(path.join(p, '.git'), 'utf8');
  const m = /^gitdir:\s*(.+?)\s*$/.exec(gitfileText.split('\n')[0]);
  assert.ok(m, `.git 文件首行应是 gitdir 指针：${JSON.stringify(gitfileText)}`);
  const admin = m[1];
  assert.equal(path.isAbsolute(admin), false, '① 工作树侧的指针必须是相对路径');

  const adminAbs = path.resolve(p, admin);
  assert.equal(fs.existsSync(path.join(adminAbs, 'gitdir')), true, 'admin 目录应可定位');
  const gd = fs.readFileSync(path.join(adminAbs, 'gitdir'), 'utf8').trim();
  assert.equal(path.isAbsolute(gd), false, '② 仓库侧的 gitdir 指针也必须是相对路径');
  assert.equal(fs.realpathSync(path.resolve(adminAbs, gd)), fs.realpathSync(p));

  // 复验：git 仍认这个工作树（归一失败会回滚成绝对指针，这条就红）
  assert.equal(worktree.git(['rev-parse', '--show-toplevel'], p).rc, 0);
  assert.equal(worktree.git(['rev-parse', '--abbrev-ref', 'HEAD'], p).out.trim(), 'ts/card-11');
});

// --------------------------------------------------------------------------
// status / remove
// --------------------------------------------------------------------------

test('status：无标记 / 目录不存在 / 干净 / 脏（含未跟踪）；dirty 判据是「输出非空白」', () => {
  const fx = gitRepo();
  const noMark = worktree.status(fx.project, { id: 12, worktree: '' });
  assert.deepEqual(noMark, {
    ok: false, error: '该卡片没有独立 worktree', path: '', branch: 'ts/card-12',
    dirty: false, exists: false,
  });
  const noDir = worktree.status(fx.project, { id: 12, worktree: path.join(fx.dir, 'nope') });
  assert.equal(noDir.ok, false);
  assert.equal(noDir.error, 'worktree 目录不存在');

  const [p] = worktree.create(fx.project, 12);
  const clean = worktree.status(fx.project, { id: 12, worktree: p });
  assert.deepEqual(clean, {
    ok: true, error: '', path: p, branch: 'ts/card-12', dirty: false, exists: true,
  });
  // 未跟踪文件也算脏（照 plan D8：只在干净时清理）
  fs.writeFileSync(path.join(p, 'untracked.txt'), 'u\n');
  const dirty = worktree.status(fx.project, { id: 12, worktree: p });
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.ok, true);
});

test('remove：脏 ⇒ 拒删且目录/分支都留着；干净 ⇒ 删目录但**保留分支**；两种错误早退', () => {
  const fx = gitRepo();
  assert.deepEqual(worktree.remove(fx.project, { id: 13, worktree: '' }),
    [false, '该卡片没有独立 worktree']);
  assert.deepEqual(worktree.remove(fx.project, { id: 13, worktree: path.join(fx.dir, 'nope') }),
    [false, 'worktree 目录不存在']);

  const [p, branch] = worktree.create(fx.project, 13);
  fs.writeFileSync(path.join(p, 'wip.txt'), 'wip\n');
  assert.deepEqual(worktree.remove(fx.project, { id: 13, worktree: p }),
    [false, '工作树有未提交改动，请先提交或清理后再移除']);
  assert.equal(fs.existsSync(p), true, '拒删后目录必须还在');

  fs.rmSync(path.join(p, 'wip.txt'));
  assert.deepEqual(worktree.remove(fx.project, { id: 13, worktree: p }), [true, '']);
  assert.equal(fs.existsSync(p), false, '干净时删掉工作树目录');
  assert.match(git(['branch', '--list', branch], fx.repo), /ts\/card-13/,
    '不删分支（提交可能还没回流，删了要 reflog 才找得回）');
});

// --------------------------------------------------------------------------
// 直起路径回归（M5 未验项的根因）
// --------------------------------------------------------------------------

test('回归：worktree 直起必须真建出工作树（修复前 ReferenceError: worktreePath is not defined）', async () => {
  const fx = gitRepo();
  const h = freshDb('wt-start');
  try {
    const pid = insertProject(h.db, { projectDir: fx.repo, workDir: fx.work });
    const cid = insertCard(h.db, pid, { title: 'WT', columnKey: 'todo' });
    const project = db.getProject(pid, { db: h.db });
    const card = db.getBoardCard(cid, { db: h.db });
    const [cur, info] = await board.enterDoingWorktree(project, card, '', false, true, '',
      { db: h.db });

    const wtPath = path.join(fx.work, 'worktrees', `card_${cid}`);
    // ① 主断言：工作树真建出来了（修复前这一行之前就抛 ReferenceError）
    assert.equal(fs.existsSync(wtPath), true, `工作树未建出：${wtPath}`);
    assert.match(fs.readFileSync(path.join(wtPath, '.git'), 'utf8'), /^gitdir: /);
    // ② 卡片落 worktree 标记（起会话失败也保留 ⇒ 重按开始即复用）
    assert.equal(db.getBoardCard(cid, { db: h.db }).worktree, wtPath);
    // ③ 测试进程没配驱动 ⇒ 起会话失败：返回错误串（不是抛异常），列回滚原列
    assert.equal(cur, null);
    // 起会话失败的文案按 key+vars 契约承载（会话启动失败: {detail}）；
    // 路由层渲染后 HTTP 形状不变，这里按契约取 detail。
    const startErr = info?.error;
    const startText = typeof startErr === 'string'
      ? startErr
      : `${startErr?.message ?? ''} ${startErr?.vars?.detail ?? ''}`;
    assert.match(startText, /未配置 dsh agent 驱动/);
    assert.equal(db.getBoardCard(cid, { db: h.db }).column_key, 'todo', '起会话失败 ⇒ 回原列');
  } finally {
    h.close();
  }
});
