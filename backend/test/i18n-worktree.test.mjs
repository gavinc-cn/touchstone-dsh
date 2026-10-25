/**
 * Task 4（KB-03）：`worktree.js` 用户可见固定中文 + `worktreePreview` reason 的双语验收
 * （Node 侧；与 `tests/test_i18n_worktree.py` 逐条镜像）。
 *
 * 覆盖：
 *   ① zh 零 churn：缺省 `lang`（或显式 `'zh'`）时 `repoRoot` / `preview` / `create` /
 *      `status` / `remove` / `mergeStatus` 的返回与改动前逐字节相同（golden 为改前实测）；
 *   ② en：每条固定模板（含 preview 的两条 reason）按尾参 `'en'` 渲染英文；动态内容
 *      （git stderr、路径）原样保留，只翻外层骨架；
 *   ③ 端点级（真路由表 + makeContext）：`x-ts-lang: en` 的 GET preview / DELETE cleanup
 *      （400）/ POST merge（400）正文英文；无头（zh）正文逐字节仍是旧中文。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import { t } from '../lib/i18n.js';
import * as worktree from '../lib/worktree.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertCard, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 路由测试台（与 i18n-rag-jira.test.mjs 同款最小版）
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: null, headers: null, body: null };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) { cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'); },
      destroy() { cap.destroyed = true; },
    },
  };
}

function fakeReq(method, body, headers = {}) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = text.length
    ? { 'content-length': String(text.length), ...headers }
    : { ...headers };
  stream.method = method;
  return stream;
}

function newCtx(db, user, target, { method = 'GET', headers = {}, body } = {}) {
  const { res, cap } = fakeRes();
  const idx = target.indexOf('?');
  const ctx = makeContext({
    req: fakeReq(method, body, headers),
    res,
    db,
    user,
    path: idx < 0 ? target : target.slice(0, idx),
    search: idx < 0 ? '' : target.slice(idx + 1),
  });
  return { ctx, cap };
}

async function call(env, method, target, { headers = {}, body } = {}) {
  const { ctx, cap } = newCtx(env.db, env.user, target, { method, headers, body });
  assert.equal(await dispatch(ctx), true, `路由未命中: ${method} ${target}`);
  return { ...cap, text: () => cap.body.toString('utf8'), json: () => JSON.parse(cap.body) };
}

function plainDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wt-i18n-'));
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  return { dir, plain, project: { project_dir: plain, work_dir: dir } };
}

// --------------------------------------------------------------------------
// ① zh golden（改前实测）+ ② en：固定模板逐条
// --------------------------------------------------------------------------

test('repoRoot：zh golden 与 en 骨架（动态 git stderr 原样）', () => {
  const { dir, plain, project } = plainDir();
  const missing = path.join(dir, 'nope');
  // zh golden（改前实测）
  assert.deepEqual(worktree.repoRoot(''), { root: null, error: '项目目录为空' });
  assert.deepEqual(worktree.repoRoot(missing),
    { root: null, error: `项目目录不存在: ${missing}` });
  const zhPlain = worktree.repoRoot(plain);
  assert.equal(zhPlain.root, null);
  assert.ok(zhPlain.error.startsWith('fatal: not a git repository'));
  // 缺省 = 显式 zh
  assert.deepEqual(worktree.repoRoot('', 'zh'), worktree.repoRoot(''));
  // en
  assert.deepEqual(worktree.repoRoot('', 'en'), { root: null, error: 'Project directory is empty' });
  assert.deepEqual(worktree.repoRoot(missing, 'en'),
    { root: null, error: `Project directory does not exist: ${missing}` });
  assert.ok(worktree.repoRoot(plain, 'en').error.startsWith('fatal: not a git repository'));
  assert.equal(project.project_dir, plain);
});

test('preview / create 非 git：zh golden 与 en', () => {
  const { plain, project } = plainDir();
  const detail = worktree.repoRoot(plain).error;
  assert.deepEqual(worktree.preview(project, 3), {
    ok: false,
    error: `项目目录不是 git 仓库（${detail}）`,
    path: '',
    branch: 'ts/card-3',
    exists: false,
    root: '',
  });
  assert.deepEqual(worktree.create(project, 3),
    ['', '', `无法创建 worktree：项目目录不是 git 仓库（${detail}）`]);
  // en
  assert.equal(worktree.preview(project, 3, 'en').error,
    `Project directory is not a git repository (${detail})`);
  assert.equal(worktree.create(project, 3, 'en')[2],
    `Cannot create worktree: project directory is not a git repository (${detail})`);
});

test('status / remove / mergeStatus 固定错误：zh golden 与 en', () => {
  const { dir } = plainDir();
  const project = { project_dir: path.join(dir, 'plain'), work_dir: dir };
  const missing = path.join(dir, 'missing');
  const noWt = { id: 3, worktree: '' };
  const gone = { id: 3, worktree: missing };

  // zh golden（改前实测）
  assert.equal(worktree.status(project, noWt).error, '该卡片没有独立 worktree');
  assert.equal(worktree.status(project, gone).error, 'worktree 目录不存在');
  assert.deepEqual(worktree.remove(project, noWt), [false, '该卡片没有独立 worktree']);
  assert.deepEqual(worktree.remove(project, gone), [false, 'worktree 目录不存在']);
  assert.equal(worktree.mergeStatus(project, noWt).error, '该卡片没有独立 worktree');
  assert.equal(worktree.mergeStatus(project, gone).error, 'worktree 目录不存在');
  // en
  assert.equal(worktree.status(project, noWt, 'en').error, 'This card has no standalone worktree');
  assert.equal(worktree.status(project, gone, 'en').error, 'The worktree directory does not exist');
  assert.deepEqual(worktree.remove(project, noWt, 'en'),
    [false, 'This card has no standalone worktree']);
  assert.deepEqual(worktree.remove(project, gone, 'en'),
    [false, 'The worktree directory does not exist']);
  assert.equal(worktree.mergeStatus(project, noWt, 'en').error,
    'This card has no standalone worktree');
  assert.equal(worktree.mergeStatus(project, gone, 'en').error,
    'The worktree directory does not exist');
});

test('git 不可用：error 分支按语言渲染；超时模板进词表', () => {
  const saved = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), 'ts-no-such-git-bin');
  try {
    const zh = worktree.git(['status'], os.tmpdir(), 1000);
    assert.equal(zh.rc, -1);
    assert.ok(zh.err.startsWith('git 不可用: '), zh.err);
    const en = worktree.git(['status'], os.tmpdir(), 1000, 'en');
    assert.equal(en.rc, -1);
    assert.ok(en.err.startsWith('git is unavailable: '), en.err);
  } finally {
    process.env.PATH = saved;
  }
  // 超时分支是 js-only 模板（Python 超时走 TimeoutExpired 英文原文，见 R-A8）
  assert.equal(t('api', 'git 不可用: 命令被中断或超时（{args}）', 'en',
    { args: 'status --porcelain' }),
  'git is unavailable: the command was interrupted or timed out (status --porcelain)');
});

test('worktreePreview reasons：zh golden 与 en', () => {
  const { dir } = plainDir();
  const project = { project_dir: path.join(dir, 'plain'), work_dir: dir };
  const cardWt = { id: 5, worktree: path.join(dir, 'wt-x'), session_id: '' };
  const cardSess = { id: 6, worktree: '', session_id: 'sid' };
  // zh golden（改前实测；缺省与显式 zh 相同）
  assert.equal(board.worktreePreview(project, cardWt).reason, '该卡片已在独立 worktree 中运行');
  assert.equal(board.worktreePreview(project, cardSess).reason,
    '该卡片已有主会话，不能切换到独立 worktree（请新建卡片）');
  assert.equal(board.worktreePreview(project, cardWt, 'zh').reason,
    '该卡片已在独立 worktree 中运行');
  // en
  assert.equal(board.worktreePreview(project, cardWt, 'en').reason,
    'This card is already running in a standalone worktree');
  assert.equal(board.worktreePreview(project, cardSess, 'en').reason,
    'This card already has a main session and cannot switch to a standalone worktree'
    + ' (create a new card)');
});

// --------------------------------------------------------------------------
// ③ 端点级：GET preview / DELETE cleanup / POST merge
// --------------------------------------------------------------------------

function setup(tag) {
  const fx = freshDb(`i18n-wt-${tag}`);
  const plain = path.join(fx.dir, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const user = fx.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const pid = insertProject(fx.db, { userId: user.id, name: `P-${tag}`, projectDir: plain });
  const cid = insertCard(fx.db, pid, { title: 'wt-i18n' });
  return { ...fx, user, pid, cid, plain };
}

test('端点：GET preview / DELETE cleanup / POST merge 的 zh 逐字节与 en', async () => {
  const env = setup('endpoint');
  try {
    const base = `/api/projects/${env.pid}/board/cards/${env.cid}/worktree`;
    const detail = worktree.repoRoot(env.plain).error;

    // ①② zh 无头：preview reason = 固定骨架 + git stderr 原文
    const zhPreview = await call(env, 'GET', base);
    assert.equal(zhPreview.status, 200);
    assert.equal(zhPreview.json().reason, `项目目录不是 git 仓库（${detail}）`);
    const zhClean = await call(env, 'DELETE', base);
    assert.equal(zhClean.status, 400);
    assert.equal(zhClean.text(), '{"error": "该卡片没有独立 worktree"}');
    const zhMerge = await call(env, 'POST', `${base}/merge`, { body: {} });
    assert.equal(zhMerge.status, 400);
    assert.equal(zhMerge.text(), '{"error": "该卡片尚无主会话，无法交给 agent 合并"}');

    // en：同三条路径
    const en = { headers: { 'x-ts-lang': 'en' } };
    const enPreview = await call(env, 'GET', base, en);
    assert.equal(enPreview.status, 200);
    assert.equal(enPreview.json().reason,
      `Project directory is not a git repository (${detail})`);
    const enClean = await call(env, 'DELETE', base, en);
    assert.equal(enClean.status, 400);
    assert.equal(enClean.text(), '{"error": "This card has no standalone worktree"}');
    const enMerge = await call(env, 'POST', `${base}/merge`, { body: {}, ...en });
    assert.equal(enMerge.status, 400);
    assert.equal(enMerge.text(), '{"error": "This card has no main session yet, so the merge '
      + 'cannot be handed to an agent"}');
  } finally {
    env.close();
  }
});

test('端点：DELETE cleanup 运行中 409 的中英正文（无头与显式 zh 逐字节相同）', async () => {
  const env = setup('cleanup-409');
  try {
    const base = `/api/projects/${env.pid}/board/cards/${env.cid}/worktree`;
    board.runRegistry.set(env.cid, { proc: null });   // 运行位在场 ⇒ 端点直接 409
    const zhBody = '{"error": "会话运行中，请先停止卡片再清理 worktree"}';
    const noHead = await call(env, 'DELETE', base);
    assert.equal(noHead.status, 409);
    assert.equal(noHead.text(), zhBody);
    const zh = await call(env, 'DELETE', base, { headers: { 'x-ts-lang': 'zh' } });
    assert.equal(zh.status, 409);
    assert.equal(zh.text(), noHead.text(), '显式 zh 必须与无语言头逐字节相同');
    const en = await call(env, 'DELETE', base, { headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 409);
    assert.equal(en.text(), '{"error": "The session is running; stop the card before '
      + 'cleaning up the worktree"}');
  } finally {
    board.runRegistry.delete(env.cid);
    env.close();
  }
});
