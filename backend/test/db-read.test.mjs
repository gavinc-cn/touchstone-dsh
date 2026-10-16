/**
 * backend/lib/db.js **读路径**（M3）单测（node --test，零依赖）。
 *
 * 判据分三层：
 *   ① 形状与语义：每个读函数的返回形态（普通对象 / null / {} / 数组）、NULL→null、
 *      派生键注入（project_view 的 cases_root/bug_dir）、rowOpt 的「缺列/None 回落」；
 *   ② SQL 口径：过滤与排序**逐条**钉死——`trashed=0`（读板）与 `trashed=1`（回收站，
 *      `trashed_at DESC, id DESC`）、`list_tasks` 的 `id DESC`、`list_rounds` 的
 *      `round_no` 升序（不是 id）、`list_board_cards` 的 `column_key, sort_order, id`、
 *      `list_queued_board_cards` 的三个条件、`list_projects` 的 user 隔离、
 *      `list_board_comments` 的 JOIN 限定与**不过滤 trashed**（回收站卡的评论仍要返回）；
 *   ③ 跨语言抽查（末尾一条）：把 `~/.touchstone/node-test.db` 快照**拷到 /tmp**，
 *      用 `tools/parity/probe/db_read.py` 在同一份冻结字节上跑 Python 侧同名函数，
 *      Node 侧读同一份拷贝，逐 op deep-equal。库或 Python 缺失时整条 skip（不假绿）。
 *
 * 落地口径：读函数末位可选 `options = {dbPath, db, env}`——本文件多数用例显式传
 * `{dbPath}`（临时库），另有一条专门验证「缺省落 TOUCHSTONE_DB」与「`{db}` 复用句柄不关闭」。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as db from '../lib/db.js';

/** 种子环境：空口令 admin、不强制改密（与 db.test.mjs 的 ENV_PASSWORDLESS 同） */
const ENV_PASSWORDLESS = { TS_ADMIN_PASSWORDLESS: '1' };

/** 夹具里所有固定时间戳（读路径不解析时间，取定值只为断言可读） */
const T0 = '2026-01-02 03:04:05';

/** 建临时目录 */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 建一个临时库并种入读路径夹具。
 * 表结构走 `db.initDb()`（= 生产建库路径），数据用显式 id 插入，便于断言排序与隔离。
 * @returns {{dir: string, dbPath: string}}
 */
function makeReadDb() {
  const dir = tmpDir('ts-db-read-');
  const dbPath = path.join(dir, 'read.db');
  db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  const handle = db.openDb(dbPath);
  try {
    seedReadFixture(handle);
  } finally {
    handle.close();
  }
  return { dir, dbPath };
}

/**
 * 读路径夹具（id 全显式）：
 *   users   1 admin(种子) / 2 bob / 3 carol
 *   projects 1,2 属 user 1；3 属 user 2（user 隔离）；项目 1 的 bug_dir 列塞旧值（必须被派生值覆盖）
 *   tasks   1,2 → 项目 1；3 → 项目 2；4 → 项目 3
 *   rounds  任务 1 三轮（**插入序 3,1,2**，证明按 round_no 排）；任务 2 第 1 轮（同名轮次，验 getLogRound 的任务过滤）
 *   cards   项目 1 五列 + 队列占位 + 回收站（含一条 trashed_at 为 NULL）；项目 2 一条（跨项目隔离）
 *   comments 项目 1 活卡 1 条 + **回收站卡 1 条**；项目 2 卡 1 条（JOIN 排除）
 */
function seedReadFixture(handle) {
  const run = (sql, ...params) => handle.prepare(sql).run(...params);

  run('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES(?,?,?,?,?,?)', 2, 'bob', 'h', 's', 0, T0);
  run('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES(?,?,?,?,?,?)', 3, 'carol', 'h', 's', 0, T0);

  const project = (id, userId, name, workDir, bugDirColumn) => run(
    'INSERT INTO projects(id, user_id, name, project_dir, agent_path, work_dir, bug_dir, created_at)'
    + ' VALUES(?,?,?,?,?,?,?,?)', id, userId, name, `/src/${name}`, '', workDir, bugDirColumn, T0);
  project(1, 1, 'p-one', '/wd/one', 'legacy-should-be-overridden');
  project(2, 1, 'p-two', '/wd/two', '');
  project(3, 2, 'p-three', '/wd/three', '');

  const task = (id, projectId, name) => run(
    'INSERT INTO tasks(id, project_id, name, created_at) VALUES(?,?,?,?)', id, projectId, name, T0);
  task(1, 1, 't1');
  task(2, 1, 't2');
  task(3, 2, 't3');
  task(4, 3, 't4');

  const round = (id, taskId, roundNo, kind = 'agent', runKey = '') => run(
    'INSERT INTO rounds(id, task_id, round_no, status, log_path, started_at, summary, kind, run_key)'
    + ' VALUES(?,?,?,?,?,?,?,?,?)', id, taskId, roundNo, 'done', `/log/${id}`, T0, `s${id}`, kind, runKey);
  round(1, 1, 3);                       // 插入序 3 → 1 → 2，期望读出来是 1,2,3
  round(2, 1, 1);
  round(3, 1, 2, 'load', '20260201_000000');
  round(4, 2, 1);
  round(5, 3, 1);

  const card = (id, projectId, columnKey, sortOrder, { blockKind = null, trashed = 0,
    trashedAt = null, updatedAt = T0 } = {}) => run(
    'INSERT INTO board_cards(id, project_id, title, column_key, sort_order, block_kind,'
    + ' trashed, trashed_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, projectId, `card-${id}`, columnKey, sortOrder, blockKind, trashed, trashedAt, T0, updatedAt);
  card(1, 1, 'todo', 2);
  card(2, 1, 'todo', 1);
  card(3, 1, 'doing', 0);
  card(4, 1, 'blocked', 0);
  card(5, 1, 'review', 0);
  card(6, 1, 'done', 0);
  card(7, 1, 'doing', 0, { blockKind: 'queue' });                                    // 排队占位：计入 doing
  card(8, 1, 'todo', 0, { blockKind: 'queue' });                                     // 队列卡但不在 doing → 不进排队列表
  card(9, 1, 'doing', 0, { blockKind: 'queue', trashed: 1, trashedAt: '2026-02-02 00:00:00' });
  card(10, 1, 'blocked', 0, { trashed: 1, trashedAt: '2026-02-03 00:00:00' });
  card(11, 1, 'done', 0, { trashed: 1, trashedAt: '2026-02-01 00:00:00' });
  card(12, 1, 'review', 0, { trashed: 1, trashedAt: null });                         // NULL 排最后（DESC）
  card(13, 2, 'doing', 0);                                                           // 跨项目隔离
  card(14, 2, 'doing', 0, { blockKind: 'queue', updatedAt: '2026-01-01 00:00:00' }); // 排队列表跨项目 + 按 updated_at 升序（id 更大却更早）

  const comment = (id, cardId, text) => run(
    'INSERT INTO board_comments(id, card_id, text, created_at) VALUES(?,?,?,?)', id, cardId, text, T0);
  comment(1, 3, 'c1');     // 项目 1 活卡
  comment(2, 9, 'c2');     // 项目 1 **回收站卡**（列表不过滤 trashed）
  comment(3, 13, 'c3');    // 项目 2 → 必须被 JOIN 排除

  run('INSERT INTO board_settings(project_id, json) VALUES(?,?)', 1, '{"mode": "serial", "n": 1}');
  run('INSERT INTO board_settings(project_id, json) VALUES(?,?)', 2, '{broken');

  run('INSERT INTO app_settings(key, json) VALUES(?,?)', 'good', '{"a": 1}');
  run('INSERT INTO app_settings(key, json) VALUES(?,?)', 'bad', 'not json at all');
  run('INSERT INTO app_settings(key, json) VALUES(?,?)', 'nan', '{"x": NaN}');

  const pref = (userId, projectId, key, value) => run(
    'INSERT INTO user_prefs(user_id, project_id, key, value, updated_at) VALUES(?,?,?,?,?)',
    userId, projectId, key, value, T0);
  pref(1, 1, 'tabs', '{"order": ["board"]}');
  pref(1, 1, 'bad', '{oops');                 // 坏 JSON：该键降级跳过
  pref(1, 1, 'scalar', 'true');               // 非对象值也要原样返回
  pref(1, 1, '__proto__', '{"polluted": 1}'); // 键名踩原型：必须仍是普通自有键
  pref(1, 1, 'nan', 'NaN');
  pref(1, 2, 'tabs', '{"order": ["other-project"]}');
  pref(2, 1, 'tabs', '{"order": ["other-user"]}');
}

/** 共享夹具（本文件用例只读，一次建库即可） */
const FIX = makeReadDb();
const OPT = { dbPath: FIX.dbPath };

// --------------------------------------------------------------------------
// 纯函数：路径派生与行取值容错
// --------------------------------------------------------------------------

test('casesRootOf/bugRootOf：<工作目录>/free_style 与 /bug_report（含尾斜杠与空串）', () => {
  assert.equal(db.CASES_SUBDIR, 'free_style');
  assert.equal(db.BUG_SUBDIR, 'bug_report');
  assert.equal(db.casesRootOf('/wd/one'), '/wd/one/free_style');
  assert.equal(db.casesRootOf('/wd/one/'), '/wd/one/free_style', '尾斜杠不产生双斜杠');
  assert.equal(db.bugRootOf('/wd/one'), '/wd/one/bug_report');
  // Python `os.path.join("", "free_style")` == "free_style"（相对路径原样拼接）
  assert.equal(db.casesRootOf(''), 'free_style');
  assert.equal(db.bugRootOf(''), 'bug_report');
});

test('rowOpt：缺列 / None 回落 default，0/空串/false 不算缺', () => {
  assert.equal(db.rowOpt({ a: 1 }, 'a'), 1);
  assert.equal(db.rowOpt({ a: 'x' }, 'a', 'D'), 'x');
  assert.equal(db.rowOpt({ a: null }, 'a', 'D'), 'D', 'None 折成 default');
  assert.equal(db.rowOpt({}, 'a', 'D'), 'D', '缺列折成 default');
  assert.equal(db.rowOpt({ a: undefined }, 'a', 'D'), 'D', 'undefined 视同缺列');
  assert.equal(db.rowOpt({ a: 0 }, 'a', 'D'), 0, '0 要原样返回');
  assert.equal(db.rowOpt({ a: '' }, 'a', 'D'), '', '空串要原样返回');
  assert.equal(db.rowOpt({ a: false }, 'a', 'D'), false, 'false 要原样返回');
  assert.equal(db.rowOpt(null, 'a'), '', '缺省 default 是空串');
  assert.equal(db.rowOpt(undefined, 'a'), '');
  assert.equal(db.rowOpt(5, 'a', 'D'), 'D', '对齐 Python 的 TypeError 分支');
  // 位置取值：Python 的 list/tuple 分支在普通对象上不成立，但字符串/数组下标两侧一致
  assert.equal(db.rowOpt(['x'], 0, 'D'), 'x');
  assert.equal(db.rowOpt('abc', 0, 'D'), 'a');
});

test('projectView：注入 cases_root 并覆盖同名列 bug_dir（原行不动、键序不跳位）', () => {
  const row = { id: 1, work_dir: '/wd/x', bug_dir: 'legacy' };
  const view = db.projectView(row);
  assert.deepEqual(view, {
    id: 1, work_dir: '/wd/x', bug_dir: '/wd/x/bug_report', cases_root: '/wd/x/free_style',
  });
  assert.deepEqual(row, { id: 1, work_dir: '/wd/x', bug_dir: 'legacy' }, '原行不被改写');
  assert.deepEqual(Object.keys(view), ['id', 'work_dir', 'bug_dir', 'cases_root'],
    'bug_dir 原位覆盖、cases_root 追加在末尾（同 Python dict 赋值语义）');
});

// --------------------------------------------------------------------------
// projects / users
// --------------------------------------------------------------------------

test('listProjects：只返回本用户项目、按 id 升序、注入派生路径', () => {
  const mine = db.listProjects(1, OPT);
  assert.deepEqual(mine.map((r) => r.id), [1, 2]);
  assert.deepEqual(mine.map((r) => r.name), ['p-one', 'p-two']);
  assert.equal(mine[0].cases_root, '/wd/one/free_style');
  assert.equal(mine[0].bug_dir, '/wd/one/bug_report', '派生值覆盖存量 bug_dir 列');
  assert.deepEqual(db.listProjects(2, OPT).map((r) => r.name), ['p-three']);
  assert.deepEqual(db.listProjects(99, OPT), [], '无项目的用户返回空数组（不是 null）');
});

test('listProjectsAll：跨用户全量、按 id 升序', () => {
  assert.deepEqual(db.listProjectsAll(OPT).map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(db.listProjectsAll(OPT).map((r) => r.user_id), [1, 1, 2]);
});

test('getProject：命中返回派生视图，未命中 null', () => {
  const row = db.getProject(1, OPT);
  assert.equal(row.name, 'p-one');
  assert.equal(row.cases_root, '/wd/one/free_style');
  assert.equal(row.bug_dir, '/wd/one/bug_report');
  assert.equal(db.getProject(999, OPT), null);
});

test('listUsers：只取三列（不含口令/盐）、按 id 升序', () => {
  const rows = db.listUsers(OPT);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.username), ['admin', 'bob', 'carol']);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['id', 'username', 'created_at'], '口令哈希与盐不得外泄');
  }
});

// --------------------------------------------------------------------------
// tasks / rounds
// --------------------------------------------------------------------------

test('getTask：命中行全列，未命中 null', () => {
  const row = db.getTask(1, OPT);
  assert.equal(row.name, 't1');
  assert.equal(row.project_id, 1);
  assert.equal(row.status, 'queued', '默认列值也在（SELECT * 全列）');
  assert.equal(db.getTask(999, OPT), null);
});

test('listTasks：按项目过滤且新任务在前（id DESC）', () => {
  assert.deepEqual(db.listTasks(1, OPT).map((r) => r.id), [2, 1]);
  assert.deepEqual(db.listTasks(2, OPT).map((r) => r.id), [3]);
  assert.deepEqual(db.listTasks(99, OPT), []);
});

test('listAllTasks：按 id 升序（恢复序），跨项目', () => {
  assert.deepEqual(db.listAllTasks(OPT).map((r) => r.id), [1, 2, 3, 4]);
});

test('listRounds：按 round_no 升序（不是 id），并保留 kind/run_key', () => {
  const rows = db.listRounds(1, OPT);
  assert.deepEqual(rows.map((r) => r.round_no), [1, 2, 3], '插入序是 3,1,2 —— 必须按轮次号排');
  assert.deepEqual(rows.map((r) => r.id), [2, 3, 1]);
  assert.deepEqual(rows.map((r) => r.kind), ['agent', 'load', 'agent']);
  assert.equal(rows[1].run_key, '20260201_000000');
  assert.deepEqual(db.listRounds(99, OPT), []);
});

test('getRound / getLogRound：按 id 与「任务+轮次号」取行', () => {
  assert.equal(db.getRound(3, OPT).round_no, 2);
  assert.equal(db.getRound(999, OPT), null);
  // 任务 1 与任务 2 都有 round_no=1：getLogRound 必须带 task_id 过滤
  assert.equal(db.getLogRound(1, 1, OPT).id, 2);
  assert.equal(db.getLogRound(2, 1, OPT).id, 4);
  assert.equal(db.getLogRound(1, 99, OPT), null);
});

// --------------------------------------------------------------------------
// board：卡片 / 评论 / 设置 / 计数
// --------------------------------------------------------------------------

test('listBoardCards：trashed=0 过滤 + 按 column_key, sort_order, id 排序', () => {
  const rows = db.listBoardCards(1, OPT);
  assert.deepEqual(rows.map((r) => r.id), [4, 3, 7, 6, 5, 8, 2, 1],
    '列名字典序 blocked<doing<done<review<todo；同列按 sort_order 再按 id');
  assert.equal(rows.every((r) => r.trashed === 0), true, '回收站卡片必须消失');
  assert.deepEqual(db.listBoardCards(2, OPT).map((r) => r.id), [13, 14]);
  assert.deepEqual(db.listBoardCards(99, OPT), []);
});

test('listTrashedCards：trashed=1 + trashed_at DESC, id DESC（NULL 排最后）', () => {
  const rows = db.listTrashedCards(1, OPT);
  assert.deepEqual(rows.map((r) => r.id), [10, 9, 11, 12]);
  assert.equal(rows.every((r) => r.trashed === 1), true);
  assert.deepEqual(db.listTrashedCards(2, OPT), []);
});

test('getBoardCard：按 id 取（回收站里的也能取到），未命中 null', () => {
  assert.equal(db.getBoardCard(3, OPT).title, 'card-3');
  assert.equal(db.getBoardCard(9, OPT).trashed, 1, '回收站卡片单取仍可见（还原路径要用）');
  assert.equal(db.getBoardCard(999, OPT), null);
});

test('boardCountsMany：只数 doing/blocked/review 且 trashed=0，无卡项目补 0', () => {
  assert.deepEqual(db.boardCountsMany([1, 2, 3, 999], OPT), {
    1: { doing: 2, blocked: 1, review: 1 },   // doing: 3 + 排队占位 7；回收站 9 不计
    2: { doing: 2, blocked: 0, review: 0 },   // 13 + 排队占位 14
    3: { doing: 0, blocked: 0, review: 0 },
    999: { doing: 0, blocked: 0, review: 0 },
  });
  // 空入参：不查库、也不该建目录/连库
  const missing = path.join(tmpDir('ts-db-read-x-'), 'nope', 'never.db');
  assert.deepEqual(db.boardCountsMany([], { dbPath: missing }), {});
  assert.equal(fs.existsSync(path.dirname(missing)), false, '空入参不应打开连接');
});

test('listQueuedBoardCards：block_kind=queue ∧ trashed=0 ∧ doing 列，按 updated_at,id 升序', () => {
  const rows = db.listQueuedBoardCards(OPT);
  assert.deepEqual(rows.map((r) => r.id), [14, 7], '跨项目、按 updated_at 升序（14 早于 7）');
  assert.equal(rows.every((r) => r.block_kind === 'queue' && r.trashed === 0
    && r.column_key === 'doing'), true);
});

test('listBoardComments：JOIN 限定项目、按评论 id 升序、回收站卡的评论照常返回', () => {
  const rows = db.listBoardComments(1, OPT);
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.deepEqual(rows.map((r) => r.card_id), [3, 9]);
  assert.equal(rows[1].text, 'c2', '回收站卡（id=9）的评论必须保留');
  assert.deepEqual(db.listBoardComments(99, OPT), []);
});

test('getBoardSettings：命中解析 JSON；无记录与坏 JSON 都降级为 {}', () => {
  assert.deepEqual(db.getBoardSettings(1, OPT), { mode: 'serial', n: 1 });
  assert.deepEqual(db.getBoardSettings(2, OPT), {}, '坏 JSON 降级');
  assert.deepEqual(db.getBoardSettings(3, OPT), {}, '无记录降级');
});

test('getAppSetting：命中解析 JSON；无记录与坏 JSON 都降级为 {}；NaN 按 Python 语义保留', () => {
  assert.deepEqual(db.getAppSetting('good', OPT), { a: 1 });
  assert.deepEqual(db.getAppSetting('bad', OPT), {});
  assert.deepEqual(db.getAppSetting('missing', OPT), {});
  const nan = db.getAppSetting('nan', OPT);
  assert.equal(Number.isNaN(nan.x), true, 'Python json.loads 接受裸 NaN，两侧都不能当坏 JSON 丢掉');
});

test('getUserPrefs：用户+项目隔离，坏 JSON 键降级跳过，非对象值原样返回', () => {
  const prefs = db.getUserPrefs(1, 1, OPT);
  assert.deepEqual(prefs.tabs, { order: ['board'] });
  assert.equal(prefs.scalar, true, '非对象 JSON 值原样返回');
  assert.equal('bad' in prefs, false, '坏 JSON 的键跳过（不是抛错、也不是空对象占位）');
  assert.equal(Number.isNaN(prefs.nan), true, 'NaN 是合法 JSON 值（Python 口径）');
  assert.deepEqual(prefs['__proto__'], { polluted: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(prefs, '__proto__'), true,
    '__proto__ 必须是自有键（普通赋值会去改原型）');
  assert.equal(Object.getPrototypeOf(prefs), Object.prototype, '原型不得被污染');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(db.getUserPrefs(1, 2, OPT), { tabs: { order: ['other-project'] } },
    '项目维度隔离');
  assert.deepEqual(db.getUserPrefs(2, 1, OPT), { tabs: { order: ['other-user'] } },
    '用户维度隔离');
  assert.deepEqual(db.getUserPrefs(1, 99, OPT), {});
});

// --------------------------------------------------------------------------
// 落点与句柄：短连接缺省路径 / 复用调用方句柄
// --------------------------------------------------------------------------

test('缺省落点：不给 options 时读 TOUCHSTONE_DB（与 defaultDbPath 同源）', () => {
  const saved = process.env.TOUCHSTONE_DB;
  process.env.TOUCHSTONE_DB = FIX.dbPath;
  try {
    assert.deepEqual(db.listUsers().map((r) => r.id), [1, 2, 3]);
    assert.equal(db.getProject(1).name, 'p-one');
    assert.deepEqual(db.listRounds(1).map((r) => r.round_no), [1, 2, 3]);
  } finally {
    if (saved === undefined) delete process.env.TOUCHSTONE_DB;
    else process.env.TOUCHSTONE_DB = saved;
  }
});

test('options.db：复用调用方句柄且不关闭它', () => {
  const handle = db.openDb(FIX.dbPath);
  try {
    assert.equal(db.listUsers({ db: handle }).length, 3);
    assert.equal(db.getProject(1, { db: handle }).name, 'p-one');
    assert.equal(handle.prepare('SELECT 1 AS ok').get().ok, 1, '句柄必须仍可用（没被 close）');
  } finally {
    handle.close();
  }
});

test('句柄直接当第一个参数（M1 取句柄风格）：同样复用，不回落 TOUCHSTONE_DB', () => {
  // 把缺省落点指到一个空库：若句柄被当成 options 袋静默解构，这里会去开空库并报
  // 「no such table: users」——反过来证明句柄真的被用上了（也避免误读生产库）
  const decoy = path.join(tmpDir('ts-db-read-decoy-'), 'absent.db');
  const saved = process.env.TOUCHSTONE_DB;
  process.env.TOUCHSTONE_DB = decoy;
  const handle = db.openDb(FIX.dbPath);
  try {
    assert.equal(db.listUsers(handle).length, 3);
    assert.equal(db.getProject(1, handle).name, 'p-one');
    assert.deepEqual(db.listRounds(1, handle).map((r) => r.round_no), [1, 2, 3]);
    assert.equal(handle.prepare('SELECT 1 AS ok').get().ok, 1, '句柄必须仍可用（没被 close）');
    assert.equal(fs.existsSync(decoy), false, '不得悄悄去开缺省落点');
  } finally {
    handle.close();
    if (saved === undefined) delete process.env.TOUCHSTONE_DB;
    else process.env.TOUCHSTONE_DB = saved;
  }
});

// --------------------------------------------------------------------------
// 跨语言抽查：同一份冻结库字节上，Python db.py 与 Node db.js 逐 op deep-equal
// --------------------------------------------------------------------------

const PYTHON = process.env.TS_PYTHON || 'python3';
const SNAPSHOT = process.env.TS_PARITY_DB
  || path.join(os.homedir(), '.touchstone', 'node-test.db');
const PROBE = path.join(db.REPO_ROOT, 'tools', 'parity', 'probe', 'db_read.py');

/** Python 解释器可用性（不可用则整条 skip；**绝不**在缺 Python 时假装通过） */
function detectPython() {
  try {
    return spawnSync(PYTHON, ['-c', 'pass'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const PYTHON_SKIP = detectPython() ? false : `未找到可用的 Python 解释器: ${PYTHON}（TS_PYTHON 可指定）`;
const PARITY_SKIP = PYTHON_SKIP
  || (fs.existsSync(SNAPSHOT) ? false : `缺冻结库快照: ${SNAPSHOT}（TS_PARITY_DB 可指定）`);

/** 文件 sha256（证明探针只读：跑前跑后必须一致） */
function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 跑 Python 探针（ops 经 stdin 送进去），返回逐行解析的 JSONL */
function runProbe(dbFile, ops) {
  const proc = spawnSync(PYTHON, [PROBE, '--db', dbFile], {
    input: JSON.stringify({ ops }), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(proc.status, 0, `探针退出码非 0（stderr: ${proc.stderr}）`);
  return proc.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

/** 取一行（无行 → null）；params 用于 where 条件，避免把 id 拼进 SQL */
function pick(handle, sql, ...params) {
  const row = handle.prepare(sql).get(...params);
  return row === undefined ? null : { ...row };
}

/** 原始 projects 行（projectView 的 op 要单独验注入，不能走已注入的 getProject） */
function rawProjectRow(projectId, opts) {
  const handle = db.openDb(opts.dbPath);
  try {
    const row = handle.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    return row === undefined ? null : { ...row };
  } finally {
    handle.close();
  }
}

/** Node 侧执行同一个 op（字段名与探针完全一致） */
function callNodeOp(op, opts) {
  switch (op.op) {
    case 'meta':
      return { path: opts.dbPath, sha256: opts.sha256, schema_version: db.SCHEMA_VERSION };
    case 'list_users': return db.listUsers(opts);
    case 'list_projects': return db.listProjects(op.user_id, opts);
    case 'list_projects_all': return db.listProjectsAll(opts);
    case 'get_project': return db.getProject(op.project_id, opts);
    case 'list_tasks': return db.listTasks(op.project_id, opts);
    case 'get_task': return db.getTask(op.task_id, opts);
    case 'list_all_tasks': return db.listAllTasks(opts);
    case 'list_rounds': return db.listRounds(op.task_id, opts);
    case 'get_round': return db.getRound(op.round_id, opts);
    case 'get_log_round': return db.getLogRound(op.task_id, op.round_no, opts);
    case 'get_board_card': return db.getBoardCard(op.card_id, opts);
    case 'list_board_cards': return db.listBoardCards(op.project_id, opts);
    case 'list_trashed_cards': return db.listTrashedCards(op.project_id, opts);
    case 'board_counts_many': return db.boardCountsMany(op.project_ids, opts);
    case 'list_queued_board_cards': return db.listQueuedBoardCards(opts);
    case 'list_board_comments': return db.listBoardComments(op.project_id, opts);
    case 'get_board_settings': return db.getBoardSettings(op.project_id, opts);
    case 'get_app_setting': return db.getAppSetting(op.key, opts);
    case 'get_user_prefs': return db.getUserPrefs(op.user_id, op.project_id, opts);
    case 'cases_root': return db.casesRootOf(op.work_dir);
    case 'bug_root': return db.bugRootOf(op.work_dir);
    case 'row_opt': return db.rowOpt(op.row, op.key, op.default);
    case 'project_view': return db.projectView(rawProjectRow(op.project_id, opts));
    default: throw new Error(`未知 op: ${op.op}`);
  }
}

/** JSON 往返归一（两侧都过一遍，消掉 undefined/数值形态差异，只比 JSON 能表达的值） */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

test('跨语言抽查：同一份冻结库字节上 Python db.py 与 Node db.js 逐 op 全等', {
  skip: PARITY_SKIP,
}, (t) => {
  // 只读红线：只碰 /tmp 下的**拷贝**（生产库 ~/.touchstone/touchstone.db 一个字都不读）
  const dir = tmpDir('ts-db-read-parity-');
  const frozen = path.join(dir, 'snapshot.db');
  fs.copyFileSync(SNAPSHOT, frozen);
  const digestBefore = sha256File(frozen);

  // 真实 id 从同一份拷贝里发现（不猜、不写死）：user 1 是任务书口径
  const handle = db.openDb(frozen);
  let pid; let pid2; let tid; let rid; let roundNo; let cid; let workDir;
  try {
    const first = pick(handle, 'SELECT id FROM projects WHERE user_id=1 ORDER BY id')
      || pick(handle, 'SELECT id FROM projects ORDER BY id');
    if (first === null) {
      t.skip('冻结库里没有任何项目行，跨语言抽查无从取样');
      return;
    }
    pid = first.id;
    pid2 = (pick(handle, 'SELECT id FROM projects WHERE id!=? ORDER BY id', pid) || {}).id ?? pid;
    tid = ((pick(handle, 'SELECT id FROM tasks WHERE project_id=? ORDER BY id', pid)
      || pick(handle, 'SELECT id FROM tasks ORDER BY id')) || {}).id ?? null;
    const round = pick(handle, 'SELECT id, round_no FROM rounds WHERE task_id=? ORDER BY id', tid)
      || pick(handle, 'SELECT id, round_no FROM rounds ORDER BY id');
    rid = round ? round.id : null;
    roundNo = round ? round.round_no : 0;
    cid = ((pick(handle, 'SELECT id FROM board_cards WHERE project_id=? ORDER BY id', pid)
      || pick(handle, 'SELECT id FROM board_cards ORDER BY id')) || {}).id ?? null;
  } finally {
    handle.close();
  }
  workDir = (db.getProject(pid, { dbPath: frozen }) || {}).work_dir || '/wd/none';

  const ops = [
    { op: 'meta' },
    { op: 'list_users' },
    { op: 'list_projects', user_id: 1 },
    { op: 'list_projects_all' },
    { op: 'get_project', project_id: pid },
    { op: 'project_view', project_id: pid },
    { op: 'list_tasks', project_id: pid },
    { op: 'get_task', task_id: tid },
    { op: 'list_all_tasks' },
    { op: 'list_rounds', task_id: tid },
    { op: 'get_round', round_id: rid },
    { op: 'get_log_round', task_id: tid, round_no: roundNo },
    { op: 'get_board_card', card_id: cid },
    { op: 'list_board_cards', project_id: pid },
    { op: 'list_trashed_cards', project_id: pid },
    { op: 'board_counts_many', project_ids: [pid, pid2, 987654321] },
    { op: 'list_queued_board_cards' },
    { op: 'list_board_comments', project_id: pid },
    { op: 'get_board_settings', project_id: pid },
    { op: 'get_app_setting', key: 'agent_cfg' },
    { op: 'get_user_prefs', user_id: 1, project_id: pid },
    { op: 'cases_root', work_dir: workDir },
    { op: 'bug_root', work_dir: workDir },
    { op: 'row_opt', row: { a: null, b: 0, c: 'x' }, key: 'a', default: 'D' },
  ];

  const py = runProbe(frozen, ops);
  assert.equal(py.length, ops.length, '探针必须逐 op 回一行');

  let compared = 0;
  for (const [index, op] of ops.entries()) {
    const got = py[index];
    assert.equal(got.ok, true, `Python 侧 op 失败 ${op.op}: ${got.error}`);
    const nodeValue = jsonRoundTrip(callNodeOp(op, { dbPath: frozen, sha256: digestBefore }));
    assert.deepEqual(nodeValue, got.value, `op ${op.op} 两侧不一致`);
    compared += 1;
  }

  // meta 是「两侧同一份字节」的直接证据；跑完再核 sha256 证明探针只读
  assert.equal(py[0].value.sha256, digestBefore, '两侧读的必须是同一份冻结字节');
  assert.equal(sha256File(frozen), digestBefore, '探针不得写库（sha256 跑前跑后必须一致）');
  assert.equal(compared, ops.length);
  t.diagnostic(`跨语言抽查 ${compared}/${ops.length} 项 deep-equal 全等`
    + `（冻结库 sha256=${digestBefore.slice(0, 16)}…，pid=${pid} tid=${tid} rid=${rid} cid=${cid}）`);
});
