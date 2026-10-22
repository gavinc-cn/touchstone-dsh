/**
 * backend/lib/db.js 单测（node --test，零依赖）：M1 的核心证据——
 * **Node 侧跑完启动序后，老库/空库都收敛到 `schema.json` 的目标结构，且数据效果与 Python 一致**。
 *
 * 断言分四类：
 *   ① 结构：`(表集合, 每表列集合 name/type/notnull/dflt/pk, 索引 name/unique/columns/归一化 sql)`
 *      与 `schema.json` 逐项相等（归一化口径照抄 tools/export_schema.py:_norm_sql）；
 *   ② executed：`runDeclaredMigrations` 实际执行的 step id 列表——期望值来自**Python 真跑**
 *      （2026-10-11 用 `db.init_db()` 对同一份夹具实测导出，见各常量注释）：
 *      它是「两版执行同一份清单」最直接的证据，跳过/多跑一步都会红；
 *   ③ 数据效果：任务书逐条点名的迁移结果（guide_text 合并、work_dir 改写、user_id 回填、
 *      claimed→starting、leases DROP、飞书桥接、卡片列归位、索引重建、schema_version 落章）；
 *   ④ 边界与守卫：未知 handler/未知 kind 必须抛错（绝不静默跳过）、事务回滚、幂等性。
 *
 * 已知且**必须复刻**的 Python 行为（ancient 夹具）：`projects` 带全局 UNIQUE(name)，
 * 重建那一步 `RENAME → CREATE TABLE（只搬 12 个老列）→ INSERT…SELECT → DROP`，
 * 于是第一轮会把后加的 9 个列（model/archived/skill_×5/reasoning_effort/permission_mode）
 * 全丢掉，第二轮启动由补列加回——本文件显式钉住这个「两轮才收敛」。
 *
 * 末尾另有 `pyJsonDumps`（backend/lib/pyjson.js）的向量测试：JSON 列的落库文本必须与
 * CPython `json.dumps(..., ensure_ascii=False)` 逐字节一致（M1 后所有 JSON 写入点共用）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import { verifyPassword } from '../lib/auth.js';
import { pyJsonDumps } from '../lib/pyjson.js';

const FIXTURE_DIR = path.join(db.SCHEMA_DIR, 'fixtures');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PYTHON = process.env.TS_PYTHON || 'python3';

/** 与 Python 侧夹具自检一致的运行环境（空口令 admin、不强制改密） */
const ENV_PASSWORDLESS = { TS_ADMIN_PASSWORDLESS: '1' };

/**
 * `pyJsonDumps` 的对照向量：`expected` 全部由 **CPython 真跑**生成（2026-10-11，Python 3.12）：
 *   python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1]), ensure_ascii=False))" '<json>'
 * 覆盖：中文/emoji、引号、反斜杠、换行与控制字符、DEL/U+2028（不转义）、嵌套、键序、
 * true/false/null、整数与安全边界、常见浮点（两侧一致的子集）。
 */
const PYJSON_VECTORS = [
  { name: '空对象/空数组', value: {}, expected: '{}' },
  { name: '数组顶层混合', value: [1, 'a', null, true, [2, { k: 'v' }]],
    expected: '[1, "a", null, true, [2, {"k": "v"}]]' },
  { name: '空容器嵌套', value: { a: [], b: {} }, expected: '{"a": [], "b": {}}' },
  { name: '整数/负数/零', value: { i: 42, n: -7, z: 0 }, expected: '{"i": 42, "n": -7, "z": 0}' },
  { name: '整数安全边界', value: { max: 9007199254740991, min: -9007199254740991 },
    expected: '{"max": 9007199254740991, "min": -9007199254740991}' },
  { name: '布尔与 null', value: { t: true, f: false, n: null },
    expected: '{"t": true, "f": false, "n": null}' },
  { name: '中文与 emoji（非 ASCII 原样输出）',
    value: { cjk: '测试用例：中文', emoji: '🔒', mix: 'a中b' },
    expected: '{"cjk": "测试用例：中文", "emoji": "🔒", "mix": "a中b"}' },
  { name: '引号与反斜杠',
    value: { q: 'he said "hi"', bs: 'C:\\tmp\\x', sq: "it's" },
    expected: "{\"q\": \"he said \\\"hi\\\"\", \"bs\": \"C:\\\\tmp\\\\x\", \"sq\": \"it's\"}" },
  { name: '键含引号与反斜杠', value: { 'a"b\\c': 1 }, expected: '{"a\\"b\\\\c": 1}' },
  { name: '控制字符（\\n \\t \\r \\b \\f 与 \\u00XX）',
    value: { nl: 'l1\nl2', tab: 'a\tb', cr: 'a\rb', bs2: 'a\bb', ff: 'a\fb', ctrl: '\u0001\u001f' },
    expected: "{\"nl\": \"l1\\nl2\", \"tab\": \"a\\tb\", \"cr\": \"a\\rb\", \"bs2\": \"a\\bb\","
      + " \"ff\": \"a\\fb\", \"ctrl\": \"\\u0001\\u001f\"}" },
  { name: 'DEL/U+2028/U+2029 不转义', value: { del: '\u007f', ls: '\u2028\u2029' },
    expected: '{"del": "\u007f", "ls": "\u2028\u2029"}' },
  { name: '嵌套对象与数组', value: { a: { b: [1, 2, { c: true }] }, d: null },
    expected: '{"a": {"b": [1, 2, {"c": true}]}, "d": null}' },
  { name: '键序保持插入序', value: { z: 1, a: 2, m: 3 }, expected: '{"z": 1, "a": 2, "m": 3}' },
  { name: '空键与空值', value: { '': '' }, expected: '{"": ""}' },
  { name: '飞书 legacy 真身',
    value: { app_id: 'cli_legacy', app_secret: 'sec_legacy', base_url: 'https://open.feishu.cn' },
    expected: '{"app_id": "cli_legacy", "app_secret": "sec_legacy",'
      + ' "base_url": "https://open.feishu.cn"}' },
  { name: 'URL 中的斜杠不转义', value: { url: 'https://open.feishu.cn/a/b?c=1&d=2' },
    expected: '{"url": "https://open.feishu.cn/a/b?c=1&d=2"}' },
  { name: '浮点一致子集（最短往返表示相同）',
    value: { f: 1.5, g: 0.1, h: 3.141592653589793 },
    expected: '{"f": 1.5, "g": 0.1, "h": 3.141592653589793}' },
];

/** 活的 Python 交叉验证 helper：读 argv 的 JSON，按 CPython 默认口径 dumps 到 stdout */
const PYJSON_HELPER = [
  'import json, sys',
  'sys.stdout.write(json.dumps(json.loads(sys.argv[1]), ensure_ascii=False))',
].join('\n');

/** python3 可用性（不可用则活体交叉验证那条 skip，静态向量仍全覆盖） */
function detectPython() {
  try {
    return spawnSync(PYTHON, ['-c', 'pass'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const PYTHON_SKIP = detectPython() ? false : `未找到可用的 Python 解释器: ${PYTHON}（TS_PYTHON 可指定）`;

// Python 真跑实测的 executed 列表（2026-10-11，db.init_db() + 夹具 SQL 副本）
/** 空库首启：清单里两种无条件步 + 版本落章（补列由收敛完成、不产生清单步） */
const FRESH_EXECUTED = [
  '2026-09-04_projects_user_name_unique_index',
  '2026-09-24_drop_leases',
  '2026-10-11_schema_version_stamp',
];
/** pre_alter 第一轮：无历史包袱 → 只跑无条件步 + 旧口径活跃索引重建 */
const PRE_ALTER_ROUND1_EXECUTED = [
  '2026-09-04_projects_user_name_unique_index',
  '2026-09-24_drop_leases',
  '2026-09-21_wait_items_rebuild_active_index',
  '2026-10-11_schema_version_stamp',
];
/** pre_alter 第二轮：索引已新口径 → 不再重建 */
const PRE_ALTER_ROUND2_EXECUTED = FRESH_EXECUTED;
/** ancient 第一轮：13 步全跑（含表重建） */
const ANCIENT_ROUND1_EXECUTED = [
  '2026-09-04_projects_guide_text_merge',
  '2026-09-04_projects_user_id_backfill',
  '2026-09-13_board_cards_clear_commit_block_text',
  '2026-09-13_board_cards_clear_commit_errors',
  '2026-09-04_projects_drop_global_unique_name',
  '2026-09-04_projects_user_name_unique_index',
  '2026-08-30_projects_work_dir_from_legacy_cases_root',
  '2026-09-19_board_cards_queue_state_doing',
  '2026-09-09_feishu_appsettings_bridge',
  '2026-09-24_drop_leases',
  '2026-09-21_wait_items_claimed_to_starting',
  '2026-09-21_wait_items_rebuild_active_index',
  '2026-10-11_schema_version_stamp',
];
/** ancient 第二轮：重建已发生 → 只剩无条件步 + 长期可重入的飞书桥接 */
const ANCIENT_ROUND2_EXECUTED = [
  '2026-09-04_projects_user_name_unique_index',
  '2026-09-09_feishu_appsettings_bridge',
  '2026-09-24_drop_leases',
  '2026-10-11_schema_version_stamp',
];

/** 重建迁移的 INSERT…SELECT 只搬这 12 个老列（ancient 第一轮 projects 的精确列集合） */
const LEGACY_PROJECT_COLUMNS = [
  'id', 'user_id', 'name', 'project_dir', 'agent_path', 'work_dir', 'bug_dir',
  'guide_text', 'commit_spec', 'deploy_spec', 'env_label', 'created_at',
];

/** 重建会丢、第二轮补列加回的 9 列（model/archived/skill_×5/reasoning_effort/permission_mode） */
const DROPPED_BY_REBUILD = [
  'model', 'archived', 'skill_understand', 'skill_deploy', 'skill_commit',
  'skill_test', 'skill_cases', 'reasoning_effort', 'permission_mode',
];

// --------------------------------------------------------------------------
// 测试辅助
// --------------------------------------------------------------------------

/** 建临时目录 */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 用夹具 SQL 建一个临时老库（等价「拿 fixtures/*.sql 喂给 sqlite3」）。
 * @param {string} name pre_alter | ancient
 * @param {string} dir 目标目录
 * @returns {string} 库文件路径
 */
function makeFixtureDb(name, dir) {
  const dbPath = path.join(dir, `${name}.db`);
  const handle = new DatabaseSync(dbPath);
  handle.exec(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.sql`), 'utf8'));
  handle.close();
  return dbPath;
}

/** SQL 文本归一：去 IF NOT EXISTS + 折叠空白（照抄 tools/export_schema.py:_norm_sql） */
function normSql(sql) {
  return String(sql || '').replace(/IF NOT EXISTS /g, '').replace(/IF NOT EXISTS/g, '')
    .trim().split(/\s+/).join(' ');
}

/** 标识符加双引号（PRAGMA 里用） */
function quote(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * 结构视图（照抄 Python `export_schema.structure_view` 的口径）：
 * 表 → 列集合（按 name 排序的 name/type/notnull/dflt/pk 五元组）+ 索引（name → unique/columns/归一化 sql）。
 * 列顺序不入契约，故只比集合。
 * @param {import('node:sqlite').DatabaseSync} handle
 * @returns {object}
 */
function structureView(handle) {
  const view = {};
  const tables = handle.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
    .all();
  for (const table of tables) {
    const columns = handle.prepare(`PRAGMA table_info(${quote(table.name)})`).all()
      .map((c) => [c.name, String(c.type || '').toUpperCase(), c.notnull, c.dflt_value, c.pk])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const indexes = {};
    for (const index of handle.prepare(`PRAGMA index_list(${quote(table.name)})`).all()) {
      const indexColumns = handle.prepare(`PRAGMA index_info(${quote(index.name)})`).all()
        .map((c) => c.name);
      const row = handle.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name);
      indexes[index.name] = [index.unique, indexColumns, row && row.sql ? normSql(row.sql) : null];
    }
    view[table.name] = { columns, indexes };
  }
  return view;
}

/**
 * 契约视图：把 schema.json 摊成与 structureView 同形（两边逐项 deepStrictEqual）。
 * @returns {object}
 */
function contractView() {
  const contract = db.loadContract();
  const view = {};
  for (const table of contract.schema.tables) {
    view[table.name] = {
      columns: table.columns
        .map((c) => [c.name, String(c.type || '').toUpperCase(), c.notnull, c.dflt, c.pk])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      indexes: Object.fromEntries(table.indexes.map(
        (i) => [i.name, [i.unique, i.columns, i.sql ? normSql(i.sql) : null]])),
    };
  }
  return view;
}

/** 取一行（无行 → null） */
function one(handle, sql, ...params) {
  const row = handle.prepare(sql).get(...params);
  return row === undefined ? null : { ...row };
}

/** 取多行（普通对象数组） */
function many(handle, sql, ...params) {
  return handle.prepare(sql).all(...params).map((row) => ({ ...row }));
}

/** 表是否存在 */
function hasTable(handle, name) {
  return one(handle, "SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name=?", name) !== null;
}

/** 表列名集合 */
function columnNames(handle, table) {
  return handle.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => c.name).sort();
}

// --------------------------------------------------------------------------
// ① 契约装载
// --------------------------------------------------------------------------

test('契约：loadContract 三件套 + SCHEMA_VERSION 三处同源 + handler 注册表完整', () => {
  const first = db.loadContract();
  assert.equal(db.loadContract(), first, '契约应被缓存（同一对象）');
  assert.deepEqual(Object.keys(first).sort(), ['migrations', 'schema', 'schemaSql']);
  assert.match(first.schemaSql, /CREATE TABLE IF NOT EXISTS users \(/);
  assert.equal(db.SCHEMA_VERSION, first.schema.schemaVersion);
  assert.equal(first.migrations.schemaVersion, first.schema.schemaVersion,
    'schema.json 与 migrations.json 的 schemaVersion 必须同源');
  assert.equal(db.SCHEMA_VERSION, 1);
  assert.equal(db.SCHEMA_DIR, path.join(db.REPO_ROOT, 'backend', 'schema'));

  // 清单里出现的每个 handler 名都必须在本模块注册表里找得到（找不到就必须抛错，见下一条测试）
  const declared = new Set(first.migrations.steps.filter((s) => s.handler).map((s) => s.handler));
  for (const name of declared) assert.ok(db.HANDLERS[name], `缺 handler 实现: ${name}`);
  assert.deepEqual(Object.keys(db.HANDLERS).sort(), [...declared].sort(),
    'HANDLERS 注册表与清单声明的 handler 集合必须一一对应');
  assert.deepEqual(Object.keys(db.HANDLERS).sort(), Object.keys(first.migrations.handlers).sort());
});

test('openDb：建父目录、busy_timeout 与 foreign_keys 生效（对齐 db.connect）', () => {
  const nested = path.join(tmpDir('ts-db-open-'), 'a', 'b', 'c.db');
  db.ensureParentDir(nested);
  assert.ok(fs.existsSync(path.dirname(nested)), 'ensureParentDir 应递归建目录');
  const handle = db.openDb(nested);
  try {
    assert.equal(one(handle, 'PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(one(handle, 'PRAGMA busy_timeout').timeout, 10000);
  } finally {
    handle.close();
  }
  const short = db.openDb(path.join(tmpDir('ts-db-open2-'), 'x.db'), { timeoutMs: 3000 });
  try {
    assert.equal(one(short, 'PRAGMA busy_timeout').timeout, 3000);
  } finally {
    short.close();
  }
  // 缺省库路径：TOUCHSTONE_DB 覆盖 > ~/.touchstone/touchstone.db（对齐 db.py:DB_OVERRIDE）
  assert.equal(db.defaultDbPath({ env: { TOUCHSTONE_DB: '/x/y.db' } }), '/x/y.db');
  assert.equal(db.defaultDbPath({ env: { TOUCHSTONE_DB: '~/z.db' } }),
    path.join(os.homedir(), 'z.db'));
  assert.equal(db.defaultDbPath({ env: {} }),
    path.join(os.homedir(), '.touchstone', 'touchstone.db'));
});

// --------------------------------------------------------------------------
// ② 空库：一次 initDb 即目标结构
// --------------------------------------------------------------------------

test('空库（文件与父目录都不存在）：一次 initDb 即等于目标结构 + admin 种子 + executed', () => {
  const dbPath = path.join(tmpDir('ts-db-fresh-'), 'deep', 'nested', 'fresh.db');
  assert.equal(fs.existsSync(dbPath), false);
  const result = db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  assert.deepEqual(result, { seeded: true, seedPassword: '', executed: FRESH_EXECUTED });

  const handle = db.openDb(dbPath);
  try {
    assert.deepStrictEqual(structureView(handle), contractView(), '空库结构必须一次到位');
    const users = many(handle, 'SELECT id, username, pass_hash, salt, must_change_pw FROM users');
    assert.equal(users.length, 1, '只种一个 admin');
    assert.equal(users[0].username, 'admin');
    assert.equal(users[0].pass_hash, 'd41d8cd98f00b204e9800998ecf8427e', '空口令 = md5("")');
    assert.equal(users[0].salt, '');
    assert.equal(users[0].must_change_pw, 0);
    assert.equal(db.schemaVersion(handle), 1);
    assert.equal(one(handle, "SELECT json FROM app_settings WHERE key='schema_version'").json, '1');
    // 幂等：再收敛一次不该补任何东西
    assert.deepEqual(db.converge(handle), { addedColumns: [], addedIndexes: [] });
    assert.deepEqual(db.runDeclaredMigrations(handle), FRESH_EXECUTED);
  } finally {
    handle.close();
  }
  // 再次 initDb：已有用户 → 不重复种子
  const again = db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  assert.equal(again.seeded, false);
  assert.equal(again.seedPassword, '');
});

// --------------------------------------------------------------------------
// ③ pre_alter 夹具：一轮收敛
// --------------------------------------------------------------------------

test('pre_alter 夹具：一轮收敛到目标结构（补 9 列）+ executed + 无历史包袱的数据效果', () => {
  const dir = tmpDir('ts-db-pre-');
  const dbPath = makeFixtureDb('pre_alter', dir);
  const result = db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  assert.deepEqual(result.executed, PRE_ALTER_ROUND1_EXECUTED);
  assert.equal(result.seeded, false, '夹具自带 admin，不该重复种子');

  const handle = db.openDb(dbPath);
  try {
    assert.deepStrictEqual(structureView(handle), contractView(), 'pre_alter 一轮必须收敛到目标');
    assert.equal(columnNames(handle, 'projects').length, 21, '补列后 projects 应有 21 列');
    // 无历史包袱：work_dir 原样、guide_text 空、卡片仍 todo、无飞书用户级配置
    const project = one(handle, 'SELECT * FROM projects WHERE id=1');
    assert.equal(project.bug_dir, '');
    assert.equal(project.work_dir, '/tmp/ts-fixture/proj', 'bug_dir 为空 ⇒ 工作目录化 handler 不该跑');
    assert.equal(project.user_id, 1);
    assert.equal(project.guide_text, '');
    assert.equal(project.commit_spec, '');
    assert.equal(one(handle, 'SELECT column_key FROM board_cards WHERE id=1').column_key, 'todo');
    assert.equal(many(handle, 'SELECT * FROM feishu_user_cfgs').length, 0);
    assert.equal(many(handle, 'SELECT * FROM wait_items').length, 0);
    assert.equal(hasTable(handle, 'leases'), false);
    assert.equal(hasTable(handle, 'projects_old'), false, '重建中间表必须已 DROP');
    assert.match(one(handle, "SELECT sql FROM sqlite_master WHERE name='idx_wait_active'").sql,
      /'starting'/);
    assert.equal(db.schemaVersion(handle), 1);
  } finally {
    handle.close();
  }
  // 第二轮：只剩无条件步（索引已新口径）
  assert.deepEqual(db.initDb({ dbPath, env: ENV_PASSWORDLESS }).executed, PRE_ALTER_ROUND2_EXECUTED);
});

// --------------------------------------------------------------------------
// ④ ancient 夹具：两轮收敛 + 全量数据效果
// --------------------------------------------------------------------------

test('ancient 夹具：第一轮表重建丢 9 列（既有行为），第二轮收敛 + 全量数据效果', () => {
  const dir = tmpDir('ts-db-ancient-');
  const dbPath = makeFixtureDb('ancient', dir);

  // ---- 第一轮 ----
  const first = db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  assert.deepEqual(first.executed, ANCIENT_ROUND1_EXECUTED, '13 步全跑（含表重建）');
  const afterFirst = db.openDb(dbPath);
  try {
    // 显式钉住已知行为：projects 只剩 12 个老列，后加的 9 列被重建丢掉
    assert.deepEqual(columnNames(afterFirst, 'projects'), [...LEGACY_PROJECT_COLUMNS].sort(),
      '重建的 INSERT…SELECT 只搬 12 个老列');
    for (const name of DROPPED_BY_REBUILD) {
      assert.equal(columnNames(afterFirst, 'projects').includes(name), false,
        `第一轮应缺列（已知行为）: ${name}`);
    }
    // 重建已完成：全局 UNIQUE(name) 消失、用户内唯一索引已建
    assert.equal(one(afterFirst,
      "SELECT count(*) AS n FROM pragma_index_list('projects') WHERE origin='u'").n, 0);
    assert.equal(hasTable(afterFirst, 'projects_old'), false);
  } finally {
    afterFirst.close();
  }

  // ---- 第二轮：补列加回，结构收敛到目标 ----
  const second = db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  assert.deepEqual(second.executed, ANCIENT_ROUND2_EXECUTED);
  assert.equal(second.seeded, false);

  const handle = db.openDb(dbPath);
  try {
    assert.deepStrictEqual(structureView(handle), contractView(), '第二轮必须收敛到目标结构');
    assert.equal(columnNames(handle, 'projects').length, 21);

    const admin = db.getUserByName(handle, 'admin');
    const project = one(handle, 'SELECT * FROM projects WHERE id=1');
    assert.equal(project.bug_dir, '', 'bug_dir 废弃置空');
    assert.equal(project.user_id, admin.id, 'user_id 回填成 admin id');
    assert.equal(project.work_dir, '/tmp/ts-fixture/proj',
      '旧 work_dir 以 /free_style 结尾 ⇒ 取父目录');
    assert.equal(project.guide_text, 'git commit message 规范：fix: 老规范\n部署说明：部署：老说明');
    assert.match(project.guide_text, /git commit message 规范：fix: 老规范/);
    assert.equal(project.commit_spec, '');
    assert.equal(project.deploy_spec, '');

    const wait = one(handle, "SELECT * FROM wait_items WHERE kind='card'");
    assert.equal(wait.state, 'starting', 'claimed → starting');

    const card = one(handle, 'SELECT * FROM board_cards WHERE id=1');
    assert.equal(card.column_key, 'doing', 'blocked+queue → doing');
    assert.equal(card.block_text, '', '存量机器文案清空');
    assert.equal(card.last_error, '');
    assert.equal(card.last_error_at, null);

    assert.equal(hasTable(handle, 'leases'), false, 'leases 表已 DROP');
    assert.equal(hasTable(handle, 'projects_old'), false);

    const configs = many(handle, 'SELECT * FROM feishu_user_cfgs');
    assert.equal(configs.length, 1, '旧全局飞书配置桥接给 admin');
    assert.equal(configs[0].user_id, admin.id);
    assert.deepEqual(JSON.parse(configs[0].json), {
      app_id: 'cli_legacy', app_secret: 'sec_legacy', base_url: 'https://open.feishu.cn',
    });
    // 原始文本也要与 Python 逐字节相同（CPython json.dumps 的 ", " / ": " 形态，非紧凑 JSON）
    assert.equal(configs[0].json,
      '{"app_id": "cli_legacy", "app_secret": "sec_legacy",'
      + ' "base_url": "https://open.feishu.cn"}');

    assert.match(one(handle, "SELECT sql FROM sqlite_master WHERE name='idx_wait_active'").sql,
      /'starting'/);
    assert.equal(one(handle,
      "SELECT json FROM app_settings WHERE key='schema_version'").json, '1');
    assert.equal(db.schemaVersion(handle), 1);

    // admin 仍是夹具里那个空口令账号（种子被跳过）
    assert.equal(admin.pass_hash, 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(verifyPassword('', admin.pass_hash, admin.salt), true);
  } finally {
    handle.close();
  }
  // 第三轮应该完全幂等（结构与数据都不再变）
  assert.deepEqual(db.initDb({ dbPath, env: ENV_PASSWORDLESS }).executed, ANCIENT_ROUND2_EXECUTED);
});

// --------------------------------------------------------------------------
// ④b 数据迁移：旧权限三档 → DSH 宿主 preset key（2026-10-21 契约 §4）
// --------------------------------------------------------------------------

test('迁移：projects.permission_mode 旧三档（manual/yolo/auto）在 initDb 后归一为宿主 preset key', () => {
  const dbPath = path.join(tmpDir('ts-db-permission-'), 'perm.db');
  // ① 空库首启：rows 守卫无行 ⇒ 本步跳过，executed 与既有期望逐项相同（不新增执行项）
  assert.deepEqual(db.initDb({ dbPath, env: ENV_PASSWORDLESS }).executed, FRESH_EXECUTED);

  // ② 造旧行（模拟迁移前的老库）：三个旧档值各一行
  const handle = db.openDb(dbPath);
  try {
    const insert = handle.prepare(
      'INSERT INTO projects(user_id, name, project_dir, work_dir, bug_dir,'
      + ' created_at, permission_mode) VALUES(1,?,?,?,?,?,?)');
    const before = [
      ['p-manual', 'manual'], ['p-yolo', 'yolo'], ['p-auto', 'auto'], ['p-empty', ''],
    ];
    for (const [name, permissionMode] of before) {
      insert.run(name, `/src/${name}`, `/wd/${name}`, '', '2026-10-01 00:00:00', permissionMode);
    }
    assert.deepEqual(many(handle,
      'SELECT name, permission_mode FROM projects ORDER BY name'), [
      { name: 'p-auto', permission_mode: 'auto' },
      { name: 'p-empty', permission_mode: '' },
      { name: 'p-manual', permission_mode: 'manual' },
      { name: 'p-yolo', permission_mode: 'yolo' },
    ]);
  } finally {
    handle.close();
  }

  // ③ 再跑一次启动序：迁移步在清单里的顺序（rebuild 之前）执行，值归一
  assert.deepEqual(db.initDb({ dbPath, env: ENV_PASSWORDLESS }).executed, [
    '2026-10-21_projects_permission_mode_presets',
    ...FRESH_EXECUTED,
  ]);
  const after = db.openDb(dbPath);
  try {
    assert.deepEqual(many(after,
      'SELECT name, permission_mode FROM projects ORDER BY name'), [
      { name: 'p-auto', permission_mode: 'danger-full-access' },
      { name: 'p-empty', permission_mode: '' },                 // 空串不动（= 不指定）
      { name: 'p-manual', permission_mode: 'workspace-write' },
      { name: 'p-yolo', permission_mode: 'danger-full-access' },
    ]);
  } finally {
    after.close();
  }

  // ④ 幂等：归一后守卫不再命中，再启动不重复执行本步
  assert.deepEqual(db.initDb({ dbPath, env: ENV_PASSWORDLESS }).executed, FRESH_EXECUTED);
});

test('迁移：Node 侧执行的是与 Python 同一份清单（step id/守卫/语句逐条相同）', () => {
  const steps = db.loadContract().migrations.steps;
  const step = steps.find((s) => s.id === '2026-10-21_projects_permission_mode_presets');
  assert.ok(step, 'migrations.json 必须包含 2026-10-21 权限档迁移步');
  assert.equal(step.when.kind, 'rows');
  assert.match(step.when.sql, /permission_mode IN \('manual','yolo','auto'\)/);
  assert.deepEqual(step.sql, [
    "UPDATE projects SET permission_mode='workspace-write' WHERE permission_mode='manual'",
    "UPDATE projects SET permission_mode='danger-full-access' WHERE permission_mode IN ('yolo','auto')",
  ]);
  assert.equal(step.handler, undefined, '本步是纯 SQL、无宿主语言 handler');
  // 位置：必须在「重建表」那步之前（重建只搬 12 个老列，会把 permission_mode 丢回空）
  const index = steps.findIndex((s) => s.id === step.id);
  const rebuild = steps.findIndex((s) => s.id === '2026-09-04_projects_drop_global_unique_name');
  assert.ok(index >= 0 && rebuild >= 0 && index < rebuild,
    '权限档迁移必须排在重建表之前（db.py 注释里的兼容性约束）');
});

// --------------------------------------------------------------------------
// ⑤ seedAdmin 三档口令来源
// --------------------------------------------------------------------------

test('seedAdmin：TS_ADMIN_PASSWORD 非空 ⇒ 用之（PBKDF2 + 随机盐、不强制改密）', () => {
  const dbPath = path.join(tmpDir('ts-db-seed-pw-'), 'a.db');
  const result = db.initDb({ dbPath, env: { TS_ADMIN_PASSWORD: 'init-pw-123' } });
  assert.equal(result.seeded, true);
  assert.equal(result.seedPassword, '', '显式口令不进一次性口令通道');
  const handle = db.openDb(dbPath);
  try {
    const admin = db.getUserByName(handle, 'admin');
    assert.equal(admin.must_change_pw, 0);
    assert.match(admin.pass_hash, /^[0-9a-f]{64}$/, 'PBKDF2 格式');
    assert.match(admin.salt, /^[0-9a-f]{32}$/);
    assert.equal(verifyPassword('init-pw-123', admin.pass_hash, admin.salt), true);
    assert.equal(verifyPassword('wrong', admin.pass_hash, admin.salt), false);
  } finally {
    handle.close();
  }
});

test('seedAdmin：未设任何环境变量 ⇒ 随机 16 位一次性口令 + must_change_pw=1', () => {
  const dbPath = path.join(tmpDir('ts-db-seed-rand-'), 'a.db');
  const result = db.initDb({ dbPath, env: {} });
  assert.equal(result.seeded, true);
  assert.match(result.seedPassword, /^[A-Za-z0-9_-]{16}$/,
    '对齐 secrets.token_urlsafe(12)（12 字节 base64url = 16 字符，无填充）');
  const handle = db.openDb(dbPath);
  try {
    const admin = db.getUserByName(handle, 'admin');
    assert.equal(admin.must_change_pw, 1);
    assert.match(admin.pass_hash, /^[0-9a-f]{64}$/);
    assert.match(admin.salt, /^[0-9a-f]{32}$/);
    assert.equal(verifyPassword(result.seedPassword, admin.pass_hash, admin.salt), true,
      '交出的一次性口令必须能验过');
    assert.match(admin.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'now_str 口径');
  } finally {
    handle.close();
  }
});

test('seedAdmin：users 表已存在但零用户且缺 must_change_pw 列（老库边界）也能种', () => {
  const dbPath = path.join(tmpDir('ts-db-seed-old-'), 'a.db');
  const handle = db.openDb(dbPath);
  try {
    // 模拟「SCHEMA 的 CREATE IF NOT EXISTS 不生效」的老 users 表：无 must_change_pw、零用户
    handle.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,'
      + ' pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL)');
    const seeded = db.seedAdmin(handle, { env: ENV_PASSWORDLESS });
    assert.deepEqual(seeded, { seeded: true, seedPassword: '' });
    const admin = db.getUserByName(handle, 'admin');
    assert.equal(admin.must_change_pw, 0);
    assert.equal(admin.pass_hash, 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(db.seedAdmin(handle, { env: ENV_PASSWORDLESS }).seeded, false, '已有用户不再种');
    assert.equal(many(handle, 'SELECT id FROM users').length, 1);
  } finally {
    handle.close();
  }
});

// --------------------------------------------------------------------------
// ⑥ 访问口（用户/会话）
// --------------------------------------------------------------------------

test('访问口：用户/会话读写与过期语义（对齐 db.py 同名函数）', () => {
  const dbPath = path.join(tmpDir('ts-db-access-'), 'a.db');
  db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  const handle = db.openDb(dbPath);
  try {
    // 用户
    const admin = db.getUserByName(handle, 'admin');
    assert.equal(Object.getPrototypeOf(admin), Object.prototype, '行必须是普通对象（便于 JSON/断言）');
    assert.equal(admin.id, 1);
    assert.deepEqual(db.getUserById(handle, admin.id), admin);
    assert.equal(db.getUserByName(handle, 'nobody'), null);
    assert.equal(db.getUserById(handle, 999), null);

    // 会话
    assert.equal(db.getSession(handle, ''), null);
    assert.equal(db.getSession(handle, 'nope'), null);
    db.createSession(handle, admin.id, 'tok-1', '2999-01-01 00:00:00');
    const session = db.getSession(handle, 'tok-1');
    assert.equal(session.user_id, admin.id);
    assert.equal(session.expires_at, '2999-01-01 00:00:00');
    assert.match(session.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 过期：getSession 判空，purge 才删行
    db.createSession(handle, admin.id, 'tok-expired', '2000-01-01 00:00:00');
    assert.equal(db.getSession(handle, 'tok-expired'), null, '过期会话读不到');
    assert.equal(one(handle, "SELECT count(*) AS n FROM sessions WHERE token='tok-expired'").n, 1,
      '读不到 ≠ 删掉（过期清理是 purge 的职责）');
    db.purgeExpiredSessions(handle);
    assert.equal(many(handle, 'SELECT token FROM sessions').length, 1);
    assert.equal(db.getSession(handle, 'tok-1').token, 'tok-1');

    db.deleteSession(handle, 'tok-1');
    assert.equal(db.getSession(handle, 'tok-1'), null);
  } finally {
    handle.close();
  }
});

test('nowStr：本地时间口径 YYYY-MM-DD HH:MM:SS（与 Python db.now_str 同格式）', () => {
  assert.match(db.nowStr(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const parsed = new Date(db.nowStr().replace(' ', 'T'));
  assert.equal(Number.isNaN(parsed.getTime()), false);
  assert.ok(Math.abs(Date.now() - parsed.getTime()) < 5000, '必须是本地时间且为当下');
});

// --------------------------------------------------------------------------
// ⑦ 迁移守卫与「绝不静默跳过」
// --------------------------------------------------------------------------

test('守卫：when=rows 无行则跳过；index_origin_unique 按 origin=u 判定；未知 kind 抛错', () => {
  const handle = db.openDb(path.join(tmpDir('ts-db-guard-'), 'g.db'));
  try {
    // rows：无行 → 跳过（标记表不该被建）
    const skipped = db.runMigrationSteps(handle, [{
      id: 'step_skip', when: { kind: 'rows', sql: 'SELECT 1 WHERE 0' },
      sql: ['CREATE TABLE guard_skipped(x)'],
    }]);
    assert.deepEqual(skipped, []);
    assert.equal(hasTable(handle, 'guard_skipped'), false);

    // rows：有行 → 执行
    const ran = db.runMigrationSteps(handle, [{
      id: 'step_run', when: { kind: 'rows', sql: 'SELECT 1' },
      sql: ['CREATE TABLE guard_ran(x)'],
    }]);
    assert.deepEqual(ran, ['step_run']);
    assert.equal(hasTable(handle, 'guard_ran'), true);

    // index_origin_unique：无 UNIQUE 约束索引 → 跳过；有则执行
    handle.exec('CREATE TABLE plain(x INTEGER)');
    handle.exec('CREATE TABLE uniq(x INTEGER UNIQUE)');
    assert.deepEqual(db.runMigrationSteps(handle, [{
      id: 'step_unique_skip', when: { kind: 'index_origin_unique', table: 'plain' }, sql: [],
    }]), []);
    assert.deepEqual(db.runMigrationSteps(handle, [{
      id: 'step_unique_run', when: { kind: 'index_origin_unique', table: 'uniq' }, sql: [],
    }]), ['step_unique_run']);

    // when 为空 = 无条件执行
    assert.deepEqual(db.runMigrationSteps(handle, [{ id: 'step_always', when: null, sql: [] }]),
      ['step_always']);

    // 未知 kind 必须抛错（不是当作「不执行」）
    assert.throws(() => db.runMigrationSteps(handle,
      [{ id: 'step_bad', when: { kind: 'nope' }, sql: [] }]), /未知迁移守卫 kind/);
  } finally {
    handle.close();
  }
});

test('未知 handler 抛错且该步整体回滚（绝不静默跳过）', () => {
  const handle = db.openDb(path.join(tmpDir('ts-db-handler-'), 'h.db'));
  try {
    assert.throws(() => db.runMigrationSteps(handle, [{
      id: 'step_unknown_handler',
      when: null,
      sql: ['CREATE TABLE handler_marker(x)'],
      handler: 'no_such_handler',
    }]), /未知迁移 handler: no_such_handler/);
    assert.equal(hasTable(handle, 'handler_marker'), false,
      '该步的 SQL 必须随事务一起回滚（不能留下半截状态）');
  } finally {
    handle.close();
  }
});

// --------------------------------------------------------------------------
// ⑧ 三个 handler 的独立口径（不依赖夹具的地基用例）
// --------------------------------------------------------------------------

test('handler：guide_text 合并的三种形态（两段/单段/已有正文追加）', () => {
  const handle = db.openDb(path.join(tmpDir('ts-db-h1-'), 'h.db'));
  try {
    handle.exec(`CREATE TABLE projects (
      id INTEGER PRIMARY KEY, guide_text TEXT NOT NULL DEFAULT '',
      commit_spec TEXT NOT NULL DEFAULT '', deploy_spec TEXT NOT NULL DEFAULT '')`);
    handle.exec("INSERT INTO projects(id, guide_text, commit_spec, deploy_spec) VALUES"
      + "(1, '', 'c1', 'd1'), (2, '', 'c2', ''), (3, '已有正文', '', 'd3'), (4, '', '', '')");
    db.HANDLERS.projects_guide_text_merge(handle);
    const rows = many(handle, 'SELECT * FROM projects ORDER BY id');
    assert.equal(rows[0].guide_text, 'git commit message 规范：c1\n部署说明：d1');
    assert.equal(rows[1].guide_text, 'git commit message 规范：c2');
    assert.equal(rows[2].guide_text, '已有正文\n\n部署说明：d3', '原有正文 rstrip 后空行分隔');
    assert.equal(rows[3].guide_text, '', '无段则不动');
    assert.deepEqual(rows.map((r) => [r.commit_spec, r.deploy_spec]),
      [['', ''], ['', ''], ['', ''], ['', '']]);
  } finally {
    handle.close();
  }
});

test('handler：work_dir 工作目录化两条分支（以 /free_style 结尾 / 回落 .touchstone）', () => {
  const handle = db.openDb(path.join(tmpDir('ts-db-h2-'), 'h.db'));
  try {
    handle.exec(`CREATE TABLE projects (
      id INTEGER PRIMARY KEY, project_dir TEXT NOT NULL DEFAULT '',
      work_dir TEXT NOT NULL DEFAULT '', bug_dir TEXT NOT NULL DEFAULT '')`);
    handle.exec("INSERT INTO projects(id, project_dir, work_dir, bug_dir) VALUES"
      + "(1, '/p', '/p/free_style', 'b1'),"
      + "(2, '/p2', '/legacy/cases', 'b2'),"
      + "(3, '/p3/', '  /p3/free_style/  ', 'b3'),"
      + "(4, '/p4', '/p4/free_style', '')");
    db.HANDLERS.projects_work_dir_from_legacy_cases_root(handle);
    const rows = many(handle, 'SELECT * FROM projects ORDER BY id');
    assert.equal(rows[0].work_dir, '/p');
    assert.equal(rows[1].work_dir, '/p2/.touchstone', '不以 free_style 结尾 ⇒ 回落项目目录');
    assert.equal(rows[2].work_dir, '/p3', '先 strip 再去尾随 /，父目录取 /p3');
    assert.equal(rows[3].work_dir, '/p4/free_style', 'bug_dir 为空 ⇒ 幂等跳过（不重复改写）');
    assert.deepEqual(rows.map((r) => r.bug_dir), ['', '', '', '']);
  } finally {
    handle.close();
  }
});

test('handler：strip/rstrip 口径逐字符对齐 Python str.strip()（含 U+001C-U+001F/U+0085/U+2000-U+200A）', () => {
  // Python `str.isspace()` 的真集合（2026-10-11 在 Python 3.12 上实测枚举得到）：
  // 它比 JS 的 String.trim() 多 U+001C-U+001F/U+0085、少 U+FEFF（BOM）——两边混用就会在
  // 「字段里带特殊空白」的存量数据上分叉。注意 U+200B/U+180E/U+FEFF 都不是 Python 空白。
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const pythonWhitespace = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
    ...range(0x2000, 0x200a), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ];
  const notWhitespace = [0x200b, 0x180e, 0xfeff, 0x41];
  const handle = db.openDb(path.join(tmpDir('ts-db-strip-'), 'p.db'));
  try {
    handle.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, guide_text TEXT NOT NULL DEFAULT \'\','
      + ' commit_spec TEXT NOT NULL DEFAULT \'\', deploy_spec TEXT NOT NULL DEFAULT \'\')');
    const insert = handle.prepare(
      'INSERT INTO projects(id, guide_text, commit_spec, deploy_spec) VALUES(?,?,?,?)');
    let id = 0;
    // 空白字符：commit_spec 正常、deploy_spec 全是空白（strip 后必须没有「部署说明」段），
    // 同时 guide_text 尾部是空白（rstrip 后不该把空白带进合并结果）
    for (const cp of pythonWhitespace) {
      insert.run(++id, 'A' + String.fromCodePoint(cp), 'c', String.fromCodePoint(cp).repeat(2));
    }
    const whitespaceRows = id;
    for (const cp of notWhitespace) insert.run(++id, '', String.fromCodePoint(cp), '');
    db.HANDLERS.projects_guide_text_merge(handle);
    const rows = many(handle, 'SELECT * FROM projects ORDER BY id');
    for (let i = 0; i < whitespaceRows; i += 1) {
      assert.equal(rows[i].guide_text, 'A\n\ngit commit message 规范：c',
        `U+${pythonWhitespace[i].toString(16).toUpperCase()} 未按 Python 口径 strip/rstrip`);
    }
    for (let i = whitespaceRows; i < rows.length; i += 1) {
      const cp = notWhitespace[i - whitespaceRows];
      assert.equal(rows[i].guide_text, 'git commit message 规范：' + String.fromCodePoint(cp),
        `U+${cp.toString(16).toUpperCase()} 不是 Python 空白，不该被 strip 掉`);
    }
  } finally {
    handle.close();
  }
});

test('handler：飞书桥接（无行 no-op / 坏 JSON 当空 / 已存在不覆盖 / 无凭据不迁移）', () => {
  const handle = db.openDb(path.join(tmpDir('ts-db-h3-'), 'h.db'));
  try {
    handle.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL DEFAULT \'{}\')');
    handle.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)');
    handle.exec("CREATE TABLE feishu_user_cfgs (user_id INTEGER PRIMARY KEY, json TEXT NOT NULL DEFAULT '{}')");
    handle.exec("INSERT INTO users(id, username) VALUES(1, 'admin')");

    db.HANDLERS.feishu_appsettings_bridge(handle);   // 无 app_settings 行 → no-op
    assert.equal(many(handle, 'SELECT * FROM feishu_user_cfgs').length, 0);

    handle.exec("INSERT INTO app_settings(key, json) VALUES('feishu', 'not-json')");
    db.HANDLERS.feishu_appsettings_bridge(handle);   // 坏 JSON 视为 {} → no-op
    assert.equal(many(handle, 'SELECT * FROM feishu_user_cfgs').length, 0);

    handle.exec("UPDATE app_settings SET json='{}' WHERE key='feishu'");
    db.HANDLERS.feishu_appsettings_bridge(handle);   // 空对象 → 无凭据 → no-op
    assert.equal(many(handle, 'SELECT * FROM feishu_user_cfgs').length, 0);

    handle.exec("UPDATE app_settings SET json='{\"base_url\":\"https://x\"}' WHERE key='feishu'");
    db.HANDLERS.feishu_appsettings_bridge(handle);   // 任一凭据字段真值即迁移
    const configs = many(handle, 'SELECT * FROM feishu_user_cfgs');
    assert.equal(configs.length, 1);
    assert.deepEqual(JSON.parse(configs[0].json), { base_url: 'https://x' });
    // 落库文本必须是 CPython `json.dumps(..., ensure_ascii=False)` 的形态（不是 JSON.stringify 的紧凑形态）
    assert.equal(configs[0].json, '{"base_url": "https://x"}');

    db.HANDLERS.feishu_appsettings_bridge(handle);   // 已有用户级配置 → 不覆盖、不重复插
    assert.equal(many(handle, 'SELECT * FROM feishu_user_cfgs').length, 1);
    assert.deepEqual(JSON.parse(many(handle, 'SELECT * FROM feishu_user_cfgs')[0].json),
      { base_url: 'https://x' });
  } finally {
    handle.close();
  }
});

test('handler：schemaVersion 读口对空值/坏值返回 null', () => {
  const handle = db.openDb(path.join(tmpDir('ts-db-sv-'), 's.db'));
  try {
    handle.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL DEFAULT \'{}\')');
    assert.equal(db.schemaVersion(handle), null, '无行 → null');
    handle.exec("INSERT INTO app_settings(key, json) VALUES('schema_version', 'not-json')");
    assert.equal(db.schemaVersion(handle), null, '非 JSON → null');
    handle.exec("UPDATE app_settings SET json='\"1\"' WHERE key='schema_version'");
    assert.equal(db.schemaVersion(handle), null, 'JSON 字符串不是数字 → null');
    handle.exec("UPDATE app_settings SET json='2' WHERE key='schema_version'");
    assert.equal(db.schemaVersion(handle), 2);
  } finally {
    handle.close();
  }
});

// --------------------------------------------------------------------------
// ⑨ pyJsonDumps：JSON 列的落库文本与 CPython json.dumps 逐字节一致
// --------------------------------------------------------------------------

test('pyJsonDumps：CPython 生成的全部向量逐字符命中（含中文/引号/反斜杠/控制字符/嵌套/键序）', () => {
  assert.ok(PYJSON_VECTORS.length >= 15, '向量表至少覆盖 15 种形态');
  for (const vector of PYJSON_VECTORS) {
    assert.equal(pyJsonDumps(vector.value), vector.expected, `向量不符：${vector.name}`);
  }
});

test('pyJsonDumps：与真 python3 的 json.dumps(ensure_ascii=False) 逐字符一致', { skip: PYTHON_SKIP }, () => {
  for (const vector of PYJSON_VECTORS) {
    const result = spawnSync(
      PYTHON, ['-c', PYJSON_HELPER, JSON.stringify(vector.value)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `python 调用失败: ${result.stderr}`);
    assert.equal(result.stdout, vector.expected,
      `Python 现算与硬编码期望不一致（基准需重新生成）：${vector.name}`);
    assert.equal(pyJsonDumps(vector.value), result.stdout,
      `Node 输出与 Python 输出不一致：${vector.name}`);
  }
  // 中文/emoji 必须原样输出（不是 \uXXXX 转义），这是 ensure_ascii=False 的判据
  assert.match(pyJsonDumps({ s: '中文🔒' }), /中文🔒/);
});

test('pyJsonDumps：BigInt 逐字符等于 Python 任意精度 int；JS 专有值/非普通对象抛 TypeError', () => {
  // 超过 2^53 的整数（普通 number 已丢精度，调用方应传 BigInt）：Python int 是任意精度，输出同形
  assert.equal(pyJsonDumps(2n ** 64n), '18446744073709551616');
  assert.equal(pyJsonDumps({ big: 9007199254740993n }), '{"big": 9007199254740993}');
  // null 原型对象可用（node:sqlite 的行就是这种）
  assert.equal(pyJsonDumps(Object.assign(Object.create(null), { a: 1 })), '{"a": 1}');
  // Python 侧不存在的值 → 抛错，绝不静默写成 null/丢键（JSON.stringify 会丢键，这里刻意不跟）
  assert.throws(() => pyJsonDumps(undefined), TypeError);
  assert.throws(() => pyJsonDumps({ a: undefined }), TypeError);
  assert.throws(() => pyJsonDumps([undefined]), TypeError);
  assert.throws(() => pyJsonDumps(() => {}), TypeError);
  assert.throws(() => pyJsonDumps(Symbol('s')), TypeError);
  // CPython 只认 dict/list/str/int/float/bool/None：Date/Map/Set/类实例同样抛 TypeError
  assert.throws(() => pyJsonDumps(new Date()), TypeError);
  assert.throws(() => pyJsonDumps(new Map([['a', 1]])), TypeError);
  assert.throws(() => pyJsonDumps(new Set([1])), TypeError);
  assert.throws(() => pyJsonDumps({ nested: new Date() }), TypeError);
});

test('pyJsonDumps：浮点残余偏差（已知、刻意保留；注释里的 Python 期望值即差异清单）', () => {
  // 整数值浮点：Python `json.dumps({"x": 1.0})` → `{"x": 1.0}`；JS 的 1.0 就是 1，类型信息在
  // JSON.parse 时已丢失 ⇒ 输出 `{"x": 1}`。**无法对齐**（信息不存在），不是实现 bug。
  assert.equal(pyJsonDumps({ x: 1.0 }), '{"x": 1}');
  // 指数记法阈值：CPython repr 在 exp < -4 / >= 16 用指数，JS 在 exp < -7 / >= 21 用
  assert.equal(pyJsonDumps({ x: 1e-5 }), '{"x": 0.00001}', 'Python 为 {"x": 1e-05}');
  assert.equal(pyJsonDumps({ x: 1e16 }), '{"x": 10000000000000000}', 'Python 为 {"x": 1e+16}');
  assert.equal(pyJsonDumps({ x: 1e21 }), '{"x": 1e+21}', '这一档两侧一致（>=21 两边都用指数）');
  // -0.0：Python → -0.0；JS String(-0) → 0
  assert.equal(pyJsonDumps({ x: -0 }), '{"x": 0}', 'Python 为 {"x": -0.0}');
  // NaN/Infinity：CPython 默认 allow_nan=True，字面量与两侧一致（严格 JSON 非法，但 Python 就这么写）
  assert.equal(pyJsonDumps({ n: NaN, i: Infinity, ni: -Infinity }),
    '{"n": NaN, "i": Infinity, "ni": -Infinity}');
  // 指数补零（2026-10-11 评审补记的第二类偏差，与阈值无关）：两侧都落指数记法，但 CPython 的
  // 指数至少两位补零、JS 不补 ⇒ 这里刻意钉住 JS 侧形态，免得有人以为「指数档一致」而漏报
  assert.equal(pyJsonDumps({ x: 1e-7 }), '{"x": 1e-7}', 'Python 为 {"x": 1e-07}');
  assert.equal(pyJsonDumps({ x: 2e-7 }), '{"x": 2e-7}', 'Python 为 {"x": 2e-07}');
  assert.equal(pyJsonDumps({ x: 1e-8 }), '{"x": 1e-8}', 'Python 为 {"x": 1e-08}');
  // ≥1e21 的普通 number：两侧都切指数但形态可能不同，且「已丢精度」的理由对 1e21 这种可精确
  // 表示的值不成立 —— 该量级要逐字节一致请传 BigInt（BigInt 走十进制原文，与 Python int 同形）
  assert.equal(pyJsonDumps({ x: 1e22 }), '{"x": 1e+22}', 'Python 为 {"x": 1e+22}（这一档一致）');
  assert.equal(pyJsonDumps({ x: 1000000000000000000000n }),
    '{"x": 1000000000000000000000}', 'BigInt 十进制原文');
});

test('feishu 桥接：落库 JSON 文本与 Python 完全相同（回归 M1 唯一差异点）', () => {
  // 直接构造夹具里的 legacy 配置，比对**原始文本**（解析后的值早就相同，这里要的是字节一致）
  const handle = db.openDb(path.join(tmpDir('ts-db-bridge-text-'), 'b.db'));
  try {
    handle.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL DEFAULT \'{}\')');
    handle.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)');
    handle.exec("CREATE TABLE feishu_user_cfgs (user_id INTEGER PRIMARY KEY, json TEXT NOT NULL DEFAULT '{}')");
    handle.exec("INSERT INTO users(id, username) VALUES(1, 'admin')");
    const legacy = { app_id: 'cli_legacy', app_secret: 'sec_legacy',
      base_url: 'https://open.feishu.cn' };
    // 夹具文本就是 Python json.dumps 的产物（见 fixtures/ancient.sql）
    handle.prepare("INSERT INTO app_settings(key, json) VALUES('feishu', ?)")
      .run('{"app_id": "cli_legacy", "app_secret": "sec_legacy", "base_url": "https://open.feishu.cn"}');
    db.HANDLERS.feishu_appsettings_bridge(handle);
    assert.equal(many(handle, 'SELECT json FROM feishu_user_cfgs')[0].json, pyJsonDumps(legacy));
    assert.equal(many(handle, 'SELECT json FROM feishu_user_cfgs')[0].json,
      '{"app_id": "cli_legacy", "app_secret": "sec_legacy", "base_url": "https://open.feishu.cn"}');
  } finally {
    handle.close();
  }
});
