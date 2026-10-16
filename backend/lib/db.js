/**
 * Node 后端数据层（`db.py` 的对应物，M1 地基）：schema 契约装载、老库收敛、
 * 声明式迁移执行、admin 种子与最小访问口。
 *
 * 设计口径（方案 §3.4「同一份 schema 契约」）：
 *   - **真源在 `db.py`**，Node 侧只读 `backend/schema/*` 三个导出件（由 tools/export_schema.py
 *     实测导出，禁止手改）：`schema.sql`（目标 DDL，整段幂等）、`schema.json`（结构化目标，
 *     收敛器按它补列/建索引）、`migrations.json`（数据级/结构重建清单，两版执行同一份）。
 *   - **启动序与 Python 一致**：`exec schema.sql` → 收敛（= Python `migrate()` 的 ALTER 补列）
 *     → `seedAdmin()` → 声明式迁移 steps。顺序是不变量：清单里所有步骤都只依赖已补齐的列，
 *     而 `seed_admin()` 又要在「项目归属回填」之前把 admin id 落库。
 *   - **收敛只补缺、不改定义**：已存在的列/索引一律跳过（哪怕定义与目标不同）。改定义是
 *     迁移清单的职责（如 ancient 夹具的 idx_wait_active 由清单重建）——收敛器顺手「修正」
 *     会让两版的 executed 列表分叉，那正是对拍要抓的东西。
 *   - **未知 handler 必须抛错退出**（绝不静默跳过：静默跳过会让两侧库悄悄分叉）。
 *   - 时间字符串口径同 Python `db.now_str()`：`YYYY-MM-DD HH:MM:SS`（**本地时间**）。
 *
 * 已知与 Python 的差异（有意为之，见各函数注释）：
 *   - 迁移里的 handler 对「非对象 JSON」容错（Python 侧会 AttributeError 崩启动）；
 *   - JSON 里的**浮点**值文本形态（清单见 pyjson.js 文件头）。除此之外 JSON 文本与 Python
 *     逐字节一致：所有 JSON 写入点统一走 `pyjson.js` 的 `pyJsonDumps`
 *     （= CPython `json.dumps(..., ensure_ascii=False)` 的默认形态）。
 *
 * 零 npm 依赖：只用 node:sqlite / node:crypto / node:fs / node:path。
 * 注意 `node:sqlite` 在 Node 22.x 每次启动会往 stderr 打 ExperimentalWarning，
 * 起进程时用 `--disable-warning=ExperimentalWarning` 压制（测试 spawn 子进程时同）。
 * 后端**不得使用 `Session` API**（Node 22.19 没有）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { hashPassword, md5Password } from './auth.js';
import { boardTopic, publish } from './localbus.js';
import { pyJsonDumps } from './pyjson.js';

/** 仓库根 = 本文件上溯三级（<根>/backend/lib/db.js），与 lib/args.js 同口径 */
export const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** schema 契约目录（`schema.sql` / `schema.json` / `migrations.json`） */
export const SCHEMA_DIR = path.join(REPO_ROOT, 'backend', 'schema');

/** 案例库子目录名（对齐 db.py:CASES_SUBDIR，工作目录化 handler 用它判「旧值是不是案例库根」） */
export const CASES_SUBDIR = 'free_style';

/** 契约缓存（三个文件一次读入，进程内不变；测试改文件不受影响，属有意行为） */
let _contract = null;

/**
 * 装载 schema 契约（进程内缓存）。
 * @returns {{schemaSql: string, schema: object, migrations: object}}
 */
export function loadContract() {
  if (_contract) return _contract;
  _contract = {
    schemaSql: fs.readFileSync(path.join(SCHEMA_DIR, 'schema.sql'), 'utf8'),
    schema: JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'schema.json'), 'utf8')),
    migrations: JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'migrations.json'), 'utf8')),
  };
  return _contract;
}

/** schema 版本号（来自 schema.json；两侧对拍前先断言相等，对齐 db.py:SCHEMA_VERSION） */
export const SCHEMA_VERSION = loadContract().schema.schemaVersion;

// --------------------------------------------------------------------------
// 通用小工具
// --------------------------------------------------------------------------

/**
 * SQL 标识符加双引号（对齐 tools/export_schema.py:_quote_ident）。
 * PRAGMA 与 ALTER 语句里的表名/索引名一律经它，避免保留字与特殊字符。
 * @param {string} name
 * @returns {string}
 */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Python `str.isspace()` 的字符集合（JS `\s` 多含 U+FEFF、少含 U+001C-U+001F/U+0085） */
const PY_SPACE = ' \t\n\v\f\r\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
const PY_RSTRIP_RE = new RegExp(`[${PY_SPACE}]+$`);

/**
 * Python `str.strip()` 等价（迁移 handler 的判空口径，与 db.py 逐字对齐）。
 * @param {unknown} text
 * @returns {string}
 */
function pyStrip(text) {
  return String(text == null ? '' : text).replace(PY_STRIP_RE, '');
}

/**
 * Python `str.rstrip()` 等价（guide_text 合并时的右侧空白处理）。
 * @param {unknown} text
 * @returns {string}
 */
function pyRstrip(text) {
  return String(text == null ? '' : text).replace(PY_RSTRIP_RE, '');
}

/**
 * 把 node:sqlite 的行对象转成普通对象（它的行是 null 原型，deepStrictEqual 与展开行为都反直觉）。
 * 未命中（undefined）归一为 null，与 Python 的 `fetchone() is None` 同判据。
 * @param {object|undefined} row
 * @returns {object|null}
 */
function plainRow(row) {
  return row === undefined ? null : { ...row };
}

/**
 * 同 plainRow 的批量版。
 * @param {object[]} rows
 * @returns {object[]}
 */
function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

/**
 * 参数绑定前把 undefined 归一为 null（node:sqlite 拒绑 undefined，而 Python 侧等价于绑 None）。
 * @param {unknown} value
 * @returns {unknown}
 */
function bindable(value) {
  return value === undefined ? null : value;
}

/**
 * 当前时间字符串（本地时间，`YYYY-MM-DD HH:MM:SS`）。对齐 `db.now_str()`。
 * 不用 toISOString()：那是 UTC，口径会整体差时区偏移。
 * @returns {string}
 */
export function nowStr() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 展开 `~` 前缀（对齐 Python `os.path.expanduser`，只处理最常见的 `~` 与 `~/`）。
 * @param {string} p
 * @returns {string}
 */
function expandUser(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 数据库文件缺省路径：`TOUCHSTONE_DB` > `~/.touchstone/touchstone.db`（对齐 db.py:DB_OVERRIDE）。
 *
 * **测试进程禁落缺省路径**（2026-10-13 第三起误写生产库事故的结构性防线）：
 * `node --test` 会给每个测试文件子进程设 `NODE_TEST_CONTEXT`。此时若 `TOUCHSTONE_DB`
 * 没设，说明调用方**漏传了 `{db}`/`{dbPath}`**——那正是历次事故的形态（缝形参错位 ⇒
 * `options` 落空 ⇒ 静默读写成产库）。这里直接抛错，把「静默写生产库」变成「当场红」。
 * 生产/独立形态不受影响（无 `NODE_TEST_CONTEXT`）；对拍量具的 Node worker 是普通进程，
 * 且它们显式设了 `TOUCHSTONE_DB`，同样不受影响。
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export function defaultDbPath({ env = process.env } = {}) {
  if (env.TOUCHSTONE_DB) return expandUser(env.TOUCHSTONE_DB);
  if (env.NODE_TEST_CONTEXT) {
    throw new Error('测试进程禁止回落缺省库路径（= 生产库 ~/.touchstone/touchstone.db）：'
      + '请传 {db}/{dbPath}，或在夹具里设 TOUCHSTONE_DB（见 backend/test/m3fixture.mjs）');
  }
  return path.join(os.homedir(), '.touchstone', 'touchstone.db');
}

/**
 * 确保数据库文件的父目录存在（对齐 Python `connect()` 里的 os.makedirs）。
 * `:memory:` 之类的特殊路径直接跳过。
 * @param {string} dbPath
 */
export function ensureParentDir(dbPath) {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return;
  const dir = path.dirname(path.resolve(dbPath));
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
}

/**
 * 打开数据库连接（对齐 Python `db.connect()`：建目录 + 10s 忙等 + 外键打开）。
 * 返回的 DatabaseSync 由调用方负责 close()（Python 是每调用短连接；Node 侧由调用方决定生命周期）。
 * @param {string} dbPath 数据库文件路径（或 ':memory:'）
 * @param {{timeoutMs?: number}} [options] 忙等超时毫秒（对齐 sqlite3.connect(timeout=10)）
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(dbPath, { timeoutMs = 10000 } = {}) {
  ensureParentDir(dbPath);
  const wait = Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 10000;
  const db = new DatabaseSync(dbPath, { timeout: wait });
  // 显式再设一次 busy_timeout：老版本 22.x 的构造选项覆盖不到时的兜底，语义与 Python timeout 完全一致
  db.exec(`PRAGMA busy_timeout = ${wait}`);
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}

// --------------------------------------------------------------------------
// 结构读取（收敛与测试共用）
// --------------------------------------------------------------------------

/**
 * 表是否存在。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {boolean}
 */
function tableExists(db, name) {
  const row = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

/**
 * 表的列元数据（PRAGMA table_info，按 name → 行）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @returns {Map<string, object>}
 */
function tableColumns(db, table) {
  const map = new Map();
  for (const row of db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all()) {
    map.set(row.name, row);
  }
  return map;
}

/**
 * 表的索引清单（PRAGMA index_list）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @returns {object[]}
 */
function indexList(db, table) {
  return plainRows(db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all());
}

/**
 * DEFAULT 子句的 SQL 字面量：schema.json 里的 `dflt` 是 SQLite 原文（`''` / `0` /
 * `datetime('now', 'localtime')`）。字面量与数字直接拼；**表达式必须加括号**
 * （ALTER TABLE ADD COLUMN 的 DEFAULT 只接受常量或括号表达式）。
 * 判据照抄 tools/export_schema.py:_ddl_from_columns。
 * @param {string} dflt
 * @returns {string}
 */
function defaultLiteral(dflt) {
  const text = String(dflt);
  if (text.startsWith("'")) return text;
  const upper = text.toUpperCase();
  if (upper === 'NULL' || upper === 'TRUE' || upper === 'FALSE') return text;
  if (text.trim() !== '' && !Number.isNaN(Number(text))) return text;
  return `(${text})`;
}

/**
 * 一列的 DDL 片段（列名 + 类型 + NOT NULL + DEFAULT）。
 * @param {object} column schema.json 的列元数据
 * @returns {string}
 */
function columnDdl(column) {
  let sql = `${quoteIdent(column.name)} ${column.type || 'TEXT'}`;
  if (column.notnull) sql += ' NOT NULL';
  if (column.dflt !== null && column.dflt !== undefined) {
    sql += ` DEFAULT ${defaultLiteral(column.dflt)}`;
  }
  return sql;
}

/**
 * 给 CREATE 语句补 `IF NOT EXISTS`（schema.json 的 ddl 原文没有；口径照抄
 * tools/export_schema.py:_with_if_not_exists）。
 * @param {string} sql
 * @returns {string}
 */
function withIfNotExists(sql) {
  if (sql.includes('IF NOT EXISTS')) return sql;
  for (const head of ['CREATE UNIQUE INDEX ', 'CREATE INDEX ', 'CREATE TABLE ']) {
    if (sql.startsWith(head)) return head + 'IF NOT EXISTS ' + sql.slice(head.length);
  }
  throw new Error(`无法补 IF NOT EXISTS 的语句: ${sql.slice(0, 60)}`);
}

// --------------------------------------------------------------------------
// 收敛：把老库补齐到 schema.json 的目标结构
// --------------------------------------------------------------------------

/**
 * 按 schema.json 把库**补齐**（幂等）：缺表建表、缺列 ALTER 补列、缺索引建索引。
 *
 * 只补缺、不改定义（见文件头）：已存在的列/索引一律跳过。补列顺序照 schema.json 的
 * 列序（列顺序不入契约，仅影响老库 ALTER 后的物理列序）。主键列不可能后补
 * （SQLite 不允许 ADD COLUMN 带 PRIMARY KEY），老库里必然已有，直接跳过。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{addedColumns: string[], addedIndexes: string[]}} 本次实际补的东西（供日志/测试）
 */
export function converge(db) {
  const { schema } = loadContract();
  const addedColumns = [];
  const addedIndexes = [];
  for (const table of schema.tables) {
    if (!tableExists(db, table.name)) {
      // schema.sql 已整段执行，正常不会走到这里；保留分支是为了「只喂 schema.json」也能收敛
      db.exec(withIfNotExists(table.ddl));
    }
    const columns = tableColumns(db, table.name);
    for (const column of table.columns) {
      if (columns.has(column.name) || column.pk) continue;
      db.exec(`ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${columnDdl(column)}`);
      addedColumns.push(`${table.name}.${column.name}`);
    }
    const indexes = new Set(indexList(db, table.name).map((row) => row.name));
    for (const index of table.indexes) {
      if (!index.sql || indexes.has(index.name)) continue; // sql=null 是自动索引，建不了也不用建
      db.exec(index.sql);
      addedIndexes.push(index.name);
    }
  }
  return { addedColumns, addedIndexes };
}

// --------------------------------------------------------------------------
// 声明式迁移（与 Python 共用 backend/schema/migrations.json）
// --------------------------------------------------------------------------

/**
 * 判定一条迁移的运行条件是否成立（when 为空 = 无条件执行）。
 * 守卫 SQL 只读、方言中立；kind 只有 `rows`（有行即跑）与 `index_origin_unique`
 * （表上存在 UNIQUE 约束索引即跑）两种，未知 kind 直接抛错。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object|null|undefined} when
 * @returns {boolean}
 */
export function migrationWhenHit(db, when) {
  if (!when) return true;
  if (when.kind === 'rows') {
    return db.prepare(when.sql).get() !== undefined;
  }
  if (when.kind === 'index_origin_unique') {
    return indexList(db, when.table).some((row) => row.origin === 'u');
  }
  throw new Error(`未知迁移守卫 kind: ${JSON.stringify(when.kind)}`);
}

/**
 * handler：废弃列 commit_spec/deploy_spec 并入 guide_text 后清空（幂等）。
 * 与 `db._mh_projects_guide_text_merge` 逐字等价：
 *   段 = 「git commit message 规范：<commit_spec.strip()>」（非空时）+
 *        「部署说明：<deploy_spec.strip()>」（非空时）；
 *   merged = guide_text.rstrip()，非空则 `merged + "\n\n" + 段.join("\n")`，否则就是段 join。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function projectsGuideTextMerge(db) {
  const rows = db.prepare('SELECT id, guide_text, commit_spec, deploy_spec FROM projects').all();
  const update = db.prepare(
    "UPDATE projects SET guide_text=?, commit_spec='', deploy_spec='' WHERE id=?");
  for (const row of rows) {
    const extra = [];
    const commitSpec = pyStrip(row.commit_spec);
    const deploySpec = pyStrip(row.deploy_spec);
    if (commitSpec) extra.push('git commit message 规范：' + commitSpec);
    if (deploySpec) extra.push('部署说明：' + deploySpec);
    if (!extra.length) continue;
    const merged = pyRstrip(row.guide_text);
    const text = merged ? merged + '\n\n' + extra.join('\n') : extra.join('\n');
    update.run(text, row.id);
  }
}

/**
 * handler：旧 work_dir（案例库根）改存工作目录、bug_dir 列废弃置空。
 * 与 `db._mh_projects_work_dir_from_legacy_cases_root` 逐字等价：
 *   旧值 strip + 去尾随 `/`；以 `/free_style` 结尾 → 取父目录（path.dirname），
 *   否则回落 `path.join(project_dir || '~', '.touchstone')`；磁盘文件一律不动。
 * 幂等标记 = bug_dir 非空（WHERE 子句）。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function projectsWorkDirFromLegacyCasesRoot(db) {
  const rows = db.prepare(
    "SELECT id, project_dir, work_dir FROM projects WHERE bug_dir != ''").all();
  const update = db.prepare("UPDATE projects SET work_dir=?, bug_dir='' WHERE id=?");
  for (const row of rows) {
    const old = pyRstrip(pyStrip(row.work_dir)).replace(/\/+$/, '');
    // 注意：判定用字面 '/'、不用 os.sep（对齐 Python 侧硬编码的 "/" + CASES_SUBDIR）
    const next = old.endsWith('/' + CASES_SUBDIR)
      ? path.dirname(old)
      : path.join(row.project_dir || '~', '.touchstone');
    update.run(next, row.id);
  }
}

/**
 * handler：旧全局飞书配置 app_settings['feishu'] → admin 的用户级配置。
 * 与 `db._mh_feishu_appsettings_bridge` 等价：无行直接返回；坏 JSON 视为 `{}`；
 * legacy 真值且任一凭据字段真值 → admin 存在且 feishu_user_cfgs 无该 user_id 行才 INSERT。
 * 只 INSERT、不删 app_settings 行，故本步长期可重入（有用户级配置后恒为 no-op）。
 * JSON 文本走 `pyJsonDumps`（CPython `json.dumps(ensure_ascii=False)` 默认形态），与 Python 逐字节一致。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function feishuAppSettingsBridge(db) {
  const row = db.prepare("SELECT json FROM app_settings WHERE key='feishu'").get();
  if (row === undefined) return;
  let legacy;
  try {
    legacy = JSON.parse(row.json);
  } catch {
    legacy = {}; // 对齐 Python 的 json.loads ValueError 分支
  }
  // Python：`(legacy and legacy.get("app_id")) or legacy.get("default_webhook") or ...`
  // legacy 真值时与 `legacy && (a || b || ...)` 等价；legacy 假值（null/{}/""/0）两侧同为不迁移
  // （Python 对 legacy=null 会 AttributeError 崩启动，这里按「不迁移」处理，属有意的更稳行为）
  if (legacy && typeof legacy === 'object'
      && (legacy.app_id || legacy.default_webhook || legacy.base_url
          || legacy.app_secret || legacy.default_secret)) {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    if (admin !== undefined
        && db.prepare('SELECT 1 AS hit FROM feishu_user_cfgs WHERE user_id=?').get(admin.id)
          === undefined) {
      db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?,?)')
        .run(admin.id, pyJsonDumps(legacy));
    }
  }
}

/** 步骤名 → 宿主语言实现（与 db.py:MIGRATION_HANDLERS 同名同语义） */
export const HANDLERS = {
  projects_guide_text_merge: projectsGuideTextMerge,
  projects_work_dir_from_legacy_cases_root: projectsWorkDirFromLegacyCasesRoot,
  feishu_appsettings_bridge: feishuAppSettingsBridge,
};

/**
 * 执行一组迁移步骤（每条一步一个事务；返回**实际执行**的 step id 列表）。
 * 未知 handler 抛错（绝不静默跳过）；步骤内任一语句/handler 抛错 → 回滚该步并向上抛。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} steps migrations.json 的 steps（可直接注入自造步骤用于测试）
 * @returns {string[]} executed step id
 */
export function runMigrationSteps(db, steps) {
  const executed = [];
  for (const step of steps) {
    if (!migrationWhenHit(db, step.when)) continue;
    db.exec('BEGIN');
    try {
      for (const statement of step.sql || []) db.exec(statement);
      if (step.handler) {
        const handler = HANDLERS[step.handler];
        if (!handler) {
          throw new Error(`未知迁移 handler: ${step.handler}（步骤 ${step.id}）`);
        }
        handler(db);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 语句自身失败时事务可能已自动回滚，ROLLBACK 再失败不覆盖原始错误
      }
      throw error;
    }
    executed.push(step.id);
  }
  return executed;
}

/**
 * 执行 migrations.json 的完整清单（幂等、可重复跑）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]} 本次实际执行的 step id 列表
 */
export function runDeclaredMigrations(db) {
  return runMigrationSteps(db, loadContract().migrations.steps);
}

// --------------------------------------------------------------------------
// admin 种子
// --------------------------------------------------------------------------

/**
 * 确保某张契约表的列齐全（seedAdmin 单独调用时的兜底；initDb 里已由 converge 覆盖）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} tableName
 */
function ensureContractColumns(db, tableName) {
  const { schema } = loadContract();
  const table = schema.tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`schema.json 里没有表: ${tableName}`);
  const columns = tableColumns(db, tableName);
  for (const column of table.columns) {
    if (columns.has(column.name) || column.pk) continue;
    db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${columnDdl(column)}`);
  }
}

/**
 * 无任何用户时插入 admin（幂等：有用户就返回 seeded=false）。
 *
 * 口令来源（优先级与 db.py:seed_admin 逐条一致）：
 *   ① `TS_ADMIN_PASSWORD` 非空 → 用它（PBKDF2 + 随机盐，must_change_pw=0，不强制改密）；
 *   ② `TS_ADMIN_PASSWORDLESS=1` → 空口令（MD5 哈希、盐空串，must_change_pw=0；插件形态）；
 *   ③ 都没有 → `randomBytes(12).toString('base64url')` 一次性口令（对齐
 *      `secrets.token_urlsafe(12)`，16 位），PBKDF2 + 随机盐，must_change_pw=1，
 *      口令**只经返回值交出一次**（Python 侧是 take_seed_password() 读后即清）。
 *
 * 「users 表已存在但零用户」的边界：插入前先确保 `must_change_pw` 列在（老库的 users
 * 表不会被 schema.sql 的 CREATE IF NOT EXISTS 改动）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{seeded: boolean, seedPassword: string}} seedPassword 仅「随机生成且必须改密」时非空
 */
export function seedAdmin(db, { env = process.env } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return { seeded: false, seedPassword: '' };
  ensureContractColumns(db, 'users');

  let password;
  let mustChange;
  let seedHash = null;
  if (env.TS_ADMIN_PASSWORD) {
    password = env.TS_ADMIN_PASSWORD;
    mustChange = 0;
  } else if (env.TS_ADMIN_PASSWORDLESS === '1') {
    password = '';
    mustChange = 0;
    seedHash = md5Password('');
  } else {
    password = randomBytes(12).toString('base64url');
    mustChange = 1;
  }
  let pwHash;
  let salt;
  if (seedHash !== null) {
    pwHash = seedHash;
    salt = '';
  } else {
    ({ hash: pwHash, salt } = hashPassword(password));
  }
  db.prepare('INSERT INTO users(username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES(?,?,?,?,?)')
    .run('admin', pwHash, salt, mustChange, nowStr());
  return { seeded: true, seedPassword: mustChange ? password : '' };
}

// --------------------------------------------------------------------------
// 启动序与版本
// --------------------------------------------------------------------------

/**
 * 完整启动序（对齐 `db.init_db()`）：
 * `exec schema.sql` → 收敛（补列/建索引）→ seedAdmin → 声明式迁移 steps。
 * @param {{dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 *   dbPath 省略时回落 `defaultDbPath()`（TOUCHSTONE_DB > ~/.touchstone/touchstone.db）
 * @returns {{seeded: boolean, seedPassword: string, executed: string[]}}
 */
export function initDb({ dbPath, env = process.env } = {}) {
  const target = dbPath || defaultDbPath({ env });
  const db = openDb(target);
  try {
    db.exec(loadContract().schemaSql);
    converge(db);
    const { seeded, seedPassword } = seedAdmin(db, { env });
    const executed = runDeclaredMigrations(db);
    return { seeded, seedPassword, executed };
  } finally {
    db.close();
  }
}

/**
 * 读迁移清单最后一步写入的 schema 版本号（app_settings['schema_version']）。
 * 未写入或不是 JSON 数字 → null（对拍前置断言：两侧必须相等）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number|null}
 */
export function schemaVersion(db) {
  const row = db.prepare("SELECT json FROM app_settings WHERE key='schema_version'").get();
  if (row === undefined) return null;
  try {
    const value = JSON.parse(row.json);
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// 最小访问口（对齐 db.py 同名函数语义；Node 侧由调用方持有连接）
// --------------------------------------------------------------------------

/**
 * 按用户名查用户行（未命中 null）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 * @returns {object|null}
 */
export function getUserByName(db, username) {
  return plainRow(db.prepare('SELECT * FROM users WHERE username=?').get(bindable(username)));
}

/**
 * 按 id 查用户行（未命中 null）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
export function getUserById(db, id) {
  return plainRow(db.prepare('SELECT * FROM users WHERE id=?').get(bindable(id)));
}

/**
 * 新建会话行（created_at 取当前本地时间，与 `db.create_session` 同）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {string} token
 * @param {string} expiresAt `YYYY-MM-DD HH:MM:SS`
 */
export function createSession(db, userId, token, expiresAt) {
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(bindable(token), bindable(userId), nowStr(), bindable(expiresAt));
}

/**
 * 取未过期会话行（空 token / 未命中 / 已过期 → null）。语义对齐 `db.get_session`：
 * 过期判据是字符串比较 `expires_at < now_str()`（`YYYY-MM-DD HH:MM:SS` 定长可直接比）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 * @returns {object|null}
 */
export function getSession(db, token) {
  if (!token) return null;
  const row = plainRow(db.prepare('SELECT * FROM sessions WHERE token=?').get(token));
  if (!row) return null;
  if (row.expires_at < nowStr()) return null;
  return row;
}

/**
 * 删除指定 token 的会话行。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 */
export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token=?').run(bindable(token));
}

/** 清理所有已过期会话行。 */
export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowStr());
}

// --------------------------------------------------------------------------
// 读路径（M3）：`db.py` 读函数对应物
// --------------------------------------------------------------------------
//
// 形态与口径（与 db.py 同名函数逐点等价——差异即对拍红灯）：
//   - **一次调用一个短连接**（对齐 Python 的 `with connect() as conn`；注意 Python 的
//     `with conn` 只管事务提交/回滚、连接靠 GC 回收，Node 侧显式 close 更干净）：
//     缺省落 `defaultDbPath()`（TOUCHSTONE_DB > ~/.touchstone/touchstone.db，与
//     `lib/lock.js:resolveDbPath` 同源），可用 `options.dbPath` 覆盖；`options.db`
//     传已打开句柄时**复用它且不关**（端点内复用同一连接 / 单测 / 对拍用），句柄
//     直接当 options 传也认（见 isReadHandle）。
//   - 行一律经 `plainRow`/`plainRows` 转普通对象：`row["col"]` 取值语义与 sqlite3.Row
//     一致；**不支持** `row[0]` 位置下标（那是 sqlite3.Row 独有的，M3 调用方全走列名）。
//   - NULL → `null`（= Python None 的 JSON 形态）；只有 `rowOpt` 按 Python 语义把
//     None 折成 default，其余一律不许把 None 折成空串。
//   - SQL 与 db.py **逐字同序**（列集合、WHERE、GROUP BY、ORDER BY 全照抄）：
//     「顺手优化」会让对拍红，而排序/过滤差异在业务上是静默错误。

/** bug 报告子目录名（对齐 db.py:BUG_SUBDIR；`bug_dir` 列已废弃，一律由 work_dir 派生） */
export const BUG_SUBDIR = 'bug_report';

/**
 * 第一个参数是不是一个连接句柄（DatabaseSync 独有的 `prepare` + `exec` 两个方法）。
 *
 * 为什么要有这条容错：M1 的访问口是「句柄当第一个参数」（`getUserByName(db, name)`），
 * 读路径改成了末位 options 袋，于是集成层两种写法都出现过（`listUsers(ctx.db)` 与
 * `getProject(id, {db: ctx.db})`）。**两者都必须复用同一个句柄**——把句柄当 options 袋
 * 静默解构的后果是回落 `TOUCHSTONE_DB` 去开另一个库（生产同库时看不出，隔离实例/单测
 * 里就是读错库）。故在此收口，不指望调用方记住口径。
 * @param {unknown} value
 * @returns {boolean}
 */
function isReadHandle(value) {
  return !!value && typeof value === 'object'
    && typeof value.prepare === 'function' && typeof value.exec === 'function';
}

/**
 * 跑一次读查询：缺省自开短连接（返回前 close），给了句柄就复用调用方句柄（不关）。
 * 句柄可以装在 `options.db` 里，也可以直接当 options 传（见 isReadHandle）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}|object} [options]
 * @param {(handle: import('node:sqlite').DatabaseSync) => any} fn
 * @returns {any}
 */
export function withReadDb(options, fn) {
  const opts = isReadHandle(options) ? { db: options } : (options || {});
  const { db = null, dbPath = null, env = process.env } = opts;
  if (db) return fn(db);
  const handle = openDb(dbPath || defaultDbPath({ env }));
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

/**
 * 跑一次写事务：缺省自开短连接并**包一层 `BEGIN`…`COMMIT`**（异常 `ROLLBACK` + 重抛），
 * 给了句柄就复用调用方句柄（**不代为开事务、也不提交**——外层负责事务边界）。
 *
 * 与 Python 的对应关系（`waitq.py`/`chat.py`/`runner.py` 的写口几乎全是
 * `with db.connect() as conn:`）：
 *   - Python 的 `with conn:` 是**事务上下文**（成功 commit、异常 rollback），但**不 close**；
 *     连接靠引用计数回收。本函数把「事务 + 归还连接」合成一步，语义等价且不留悬挂句柄。
 *   - 差异只有**加锁时刻**：Python 的隐式事务在**第一条 DML** 才 BEGIN（块内纯 SELECT 不开事务），
 *     本函数在块首就放一个 `BEGIN`（SQLite 的 `BEGIN` 是 DEFERRED，纯 SELECT 只取 SHARED 锁）。
 *     为什么可以接受：Node 侧 `node:sqlite` 是**同步 API + 单事件循环**，进程内所有库访问天然串行；
 *     跨进程并发由**同库单实例锁**（`lifecycle`/`lock.js`）挡死——两版永不并发写同一个库。
 *     ⚠ 例外：将来把重活挪进 `worker_threads`（M3 方案 R2）时，线程各有连接，这条前提失效，
 *     届时要重新审「块内 SELECT → DML」两段式加锁（rollback journal 下双方各持 SHARED 抢 RESERVED
 *     会直接 SQLITE_BUSY 而不是等忙）。
 *   - **不许嵌套**：内层若再调 `withWriteDb` 会撞 `cannot start a transaction within a transaction`。
 *     块内复用连接的函数一律写成 `xxxOn(handle, …)` 形态（同 `waitq.js` 读侧的既有做法）。
 *
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv, tx?: boolean}|object} [options]
 * @param {(handle: import('node:sqlite').DatabaseSync) => any} fn
 * @returns {any}
 */
export function withWriteDb(options, fn) {
  const opts = isReadHandle(options) ? { db: options } : (options || {});
  const { db = null, dbPath = null, env = process.env, tx = true } = opts;
  if (db) return fn(db);                  // 复用调用方句柄：事务边界归调用方
  const handle = openDb(dbPath || defaultDbPath({ env }));
  try {
    if (tx) handle.exec('BEGIN');
    const result = fn(handle);
    if (result && typeof result.then === 'function') {
      // 异步体在这里是**必然的错误**：COMMIT/finally-close 会在 await 之前跑完，
      // 事务边界与调用方的意图脱节（等待期间连接已关）。宁可炸得响，不许静默半提交。
      throw new Error('withWriteDb 的 fn 必须是同步的（node:sqlite 同步 API）；'
        + '需要 await 的部分请放在 withWriteDb 之外');
    }
    if (tx) handle.exec('COMMIT');
    return result;
  } catch (err) {
    if (tx) {
      try { handle.exec('ROLLBACK'); } catch { /* 事务可能已因错误自动回滚，吞掉 */ }
    }
    throw err;
  } finally {
    handle.close();
  }
}

/** `pyJsonLoads` 的哨兵串：只在这三个字面量出现处替换，反序列化后再还原成三个特殊浮点 */
const PY_JSON_NAN = '\u0000py-json:NaN\u0000';
const PY_JSON_INF = '\u0000py-json:Infinity\u0000';
const PY_JSON_NEG_INF = '\u0000py-json:-Infinity\u0000';

/**
 * 把源码里**字符串之外**的 `NaN` / `Infinity` / `-Infinity` 换成哨兵串（只在严格解析
 * 失败后才走这里，见 pyJsonLoads）；一处都没换返回 null（没必要重试）。
 * 逐字符扫描是为了不误伤字符串里的同名文本（`{"a": "NaN"}` 是合法 JSON）。
 * @param {string} src
 * @returns {string|null}
 */
function patchPyJsonSpecials(src) {
  let out = '';
  let changed = false;
  let inString = false;
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {              // 转义对整体跳过，免得把 \" 当成字符串结束
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (src.startsWith('-Infinity', i)) {
      out += JSON.stringify(PY_JSON_NEG_INF);
      i += 9;
      changed = true;
      continue;
    }
    if (src.startsWith('Infinity', i)) {
      out += JSON.stringify(PY_JSON_INF);
      i += 8;
      changed = true;
      continue;
    }
    if (src.startsWith('NaN', i)) {
      out += JSON.stringify(PY_JSON_NAN);
      i += 3;
      changed = true;
      continue;
    }
    out += ch;
    i += 1;
  }
  return changed ? out : null;
}

/**
 * CPython `json.loads()` 的读侧对应物（只补齐读路径可观察到的差异）。
 *
 * 为什么要自己写而不是直接用 `JSON.parse`：Python 默认 `allow_nan=True`，
 * `json.loads('{"a": NaN}')` **是合法的**（返回 float('nan')），而 `JSON.parse` 直接抛。
 * 平台自己的写点全走 `pyJsonDumps`（非有限浮点会写成 `NaN`/`Infinity` 字面量），
 * 所以这种值确实可能是平台写下的，不该被当成「坏 JSON」降级掉。故：先严格解析；
 * 失败且源码里有这三种字面量才替换重试；仍失败一律抛 `SyntaxError`（= Python 的
 * `ValueError` 分支，调用方据此降级）。
 *
 * 入参口径照抄 Python：只接受 str（Node 里另加 BLOB 的 Uint8Array，Python 的
 * `json.loads` 也收 bytes）；其它类型抛 `TypeError`——`getUserPrefs` 这类调用点
 * 只 catch ValueError，与 Python 一样让 TypeError 冒出去。
 *
 * 已知不覆盖：超出 2^53 的整数字面量（Python 任意精度 int，JS 只能折成浮点）。
 * 库里没有这种值（schema_version 等都是小整数）；真出现时两侧行为差异会在对拍里现形。
 * @param {string|Uint8Array} text
 * @returns {any}
 */
function pyJsonLoads(text) {
  let src;
  if (typeof text === 'string') src = text;
  else if (text instanceof Uint8Array) src = new TextDecoder('utf-8').decode(text);
  else {
    throw new TypeError(
      `the JSON object must be str, bytes or bytearray, not ${text === null ? 'NoneType' : typeof text}`);
  }
  try {
    return JSON.parse(src);
  } catch (strictError) {
    const patched = patchPyJsonSpecials(src);
    if (patched === null) throw strictError;
    return JSON.parse(patched, (key, value) => {
      if (value === PY_JSON_NAN) return NaN;
      if (value === PY_JSON_INF) return Infinity;
      if (value === PY_JSON_NEG_INF) return -Infinity;
      return value;
    });
  }
}

/**
 * 案例库根 = `<工作目录>/free_style`（对齐 `db.cases_root_of`）。
 * @param {string} workDir
 * @returns {string}
 */
export function casesRootOf(workDir) {
  return path.join(workDir, CASES_SUBDIR);
}

/**
 * bug 报告目录 = `<工作目录>/bug_report`（对齐 `db.bug_root_of`）。
 * @param {string} workDir
 * @returns {string}
 */
export function bugRootOf(workDir) {
  return path.join(workDir, BUG_SUBDIR);
}

/**
 * 行取值容错：列在则取值，缺列/None 回落 default（对齐 `db.row_opt`）。
 *
 * 为什么需要：起会话路径要读**新加列**（项目 reasoning_effort / permission_mode），
 * 而单测里手工构造的行对象可能缺这些键——读一个可选默认值不该让起会话抛错。
 * 与 Python 的差异只有一处：Python 的 sqlite3.Row 支持 `row[0]` 位置下标（IndexError
 * 分支），普通对象没有位置语义，传数字键只会回落 default（M3 调用方全走列名）。
 * @param {object|null|undefined} row
 * @param {string} key
 * @param {any} [defaultValue] Python 侧形参名是保留字 `default`，故此处改名（位置传参不变）
 * @returns {any}
 */
export function rowOpt(row, key, defaultValue = '') {
  if (row === null || row === undefined) return defaultValue;   // 对齐 row[key] 的 TypeError 分支
  const value = row[key];
  return value === undefined || value === null ? defaultValue : value;
}

/**
 * projects 行 → 普通对象，注入派生路径键（读取层统一派生，下游直接取用）：
 *   - `cases_root`：案例库根 = `<工作目录>/free_style`
 *   - `bug_dir`：bug 报告目录 = `<工作目录>/bug_report`（**覆盖**已废弃的同名存量列值）
 *
 * 为什么在读取层做：`bug_dir` 列已废弃（迁移后恒为空串），但存量调用方仍按
 * `row["bug_dir"]` 取报告目录；在这里统一注入，下游与业务层零改动。
 * 键序说明：JS 与 Python 一样，给**已存在**的键赋新值只改值、不动位置（`bug_dir`
 * 在原列位，`cases_root` 追加在末尾），故两侧键序也一致。
 * @param {object} row
 * @returns {object}
 */
export function projectView(row) {
  const view = { ...row };
  view.cases_root = casesRootOf(view.work_dir);
  view.bug_dir = bugRootOf(view.work_dir);
  return view;
}

/**
 * 按用户列出项目（多用户隔离），仅返回归属该用户的项目（对齐 `db.list_projects`）。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listProjects(userId, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT * FROM projects WHERE user_id=? ORDER BY id').all(bindable(userId))))
    .map(projectView);
}

/**
 * 全部项目（跨用户；目录重复检测等场景用，对齐 `db.list_projects_all`）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listProjectsAll(options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT * FROM projects ORDER BY id').all())).map(projectView);
}

/**
 * 按 id 取项目（不校验归属；归属校验在 server 层按当前用户进行，对齐 `db.get_project`）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getProject(projectId, options = {}) {
  const row = withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM projects WHERE id=?').get(bindable(projectId))));
  return row === null ? null : projectView(row);
}

/**
 * 全部用户（后台管理用），按 id 升序；**只取三列**（不含口令哈希与盐，对齐 `db.list_users`）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listUsers(options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT id, username, created_at FROM users ORDER BY id').all()));
}

/**
 * 按 id 取任务（未命中 null，对齐 `db.get_task`）。
 * @param {number} taskId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getTask(taskId, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM tasks WHERE id=?').get(bindable(taskId))));
}

/**
 * 项目下任务，**新任务在前**（`ORDER BY id DESC`；任务列表 UI 的口径，对齐 `db.list_tasks`）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listTasks(projectId, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT * FROM tasks WHERE project_id=? ORDER BY id DESC').all(bindable(projectId))));
}

/**
 * 全部任务（服务启动恢复时用），按 id 升序（对齐 `db.list_all_tasks`）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listAllTasks(options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT * FROM tasks ORDER BY id').all()));
}

/**
 * 任务的轮次，按 `round_no` 升序（**不是 id**：压测的运行键与 agent 轮次共表，
 * 轮次号才是叙述顺序，对齐 `db.list_rounds`）。
 * @param {number} taskId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listRounds(taskId, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT * FROM rounds WHERE task_id=? ORDER BY round_no').all(bindable(taskId))));
}

/**
 * 按 id 取轮次行（未命中 null，对齐 `db.get_round`）。
 * @param {number} roundId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getRound(roundId, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM rounds WHERE id=?').get(bindable(roundId))));
}

/**
 * 按 任务+轮次号 取轮次行（日志查询用，对齐 `db.get_log_round`）：
 * 不用 id 是因为「任务第 N 轮」才是用户与 URL 的口径。
 * @param {number} taskId
 * @param {number} roundNo
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getLogRound(taskId, roundNo, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM rounds WHERE task_id=? AND round_no=?').get(bindable(taskId), bindable(roundNo))));
}

/**
 * 按 id 取卡片（不校验项目归属，归属由 server 层 `_owned_project` 保证，对齐 `db.get_board_card`）。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getBoardCard(cardId, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM board_cards WHERE id=?').get(bindable(cardId))));
}

/**
 * 项目全部**有效**卡片（回收站外；按列 + 列内序号 + id 排序，对齐 `db.list_board_cards`）。
 * `trashed=0` 是读板路径的统一过滤：软删卡只出现在回收站里。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listBoardCards(projectId, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    "SELECT * FROM board_cards WHERE project_id=? AND trashed=0"
    + ' ORDER BY column_key, sort_order, id').all(bindable(projectId))));
}

/**
 * 项目回收站卡片（**新删在前**：trashed_at DESC, id DESC，对齐 `db.list_trashed_cards`）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listTrashedCards(projectId, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT * FROM board_cards WHERE project_id=? AND trashed=1'
    + ' ORDER BY trashed_at DESC, id DESC').all(bindable(projectId))));
}

/**
 * 批量统计各项目看板三列（doing/blocked/review）的卡片数量（对齐 `db.board_counts_many`）。
 *
 * 只统计回收站外卡片（trashed=0）；排队占位卡（block_kind='queue'）落在 doing 列一并计入。
 * 返回 `{project_id: {doing, blocked, review}}`：**入参里的每个项目都在**（无卡片记 0），
 * 项目列表端点用它一次 GROUP BY 算全量，避免逐项目查库；空入参直接返回 `{}`（**不开连接**）。
 * 键序说明：JS 对象的整数样键按升序列举（Python dict 是插入序），但调用方只按 id 取值、
 * 且序列化成 JSON 后键都是字符串，故不入判据（值集合与默认项完全一致）。
 * @param {number[]} projectIds
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Record<string, {doing: number, blocked: number, review: number}>}
 */
export function boardCountsMany(projectIds, options = {}) {
  const ids = projectIds.map((pid) => bindable(pid));
  const out = Object.fromEntries(ids.map((pid) => [pid, { doing: 0, blocked: 0, review: 0 }]));
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(', ');
  return withReadDb(options, (handle) => {
    const rows = handle.prepare(
      'SELECT project_id, column_key, COUNT(*) FROM board_cards'
      + " WHERE trashed=0 AND column_key IN ('doing','blocked','review')"
      + ` AND project_id IN (${marks}) GROUP BY project_id, column_key`).all(...ids);
    // Python 是 `if pid in out`：int 1 与 str "1" 不是同一个键，用 Set 保住这条严格性
    const known = new Set(ids);
    for (const row of rows) {
      const [pid, col, n] = Object.values(row);   // 列序即 SELECT 序（同 Python 的元组解包）
      if (known.has(pid)) out[pid][col] = n;
    }
    return out;
  });
}

/**
 * 全部项目的排队看板卡片（P4 单态：`block_kind='queue'` + `column_key='doing'`，
 * 按 `updated_at, id` 升序）——runner recover 重建队列用（对齐 `db.list_queued_board_cards`）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listQueuedBoardCards(options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    "SELECT * FROM board_cards WHERE block_kind='queue' AND trashed=0"
    + " AND column_key='doing' ORDER BY updated_at, id").all()));
}

/**
 * 项目全部卡片的评论（JOIN 限定项目，按评论 id 升序；前端按 card_id 分组，对齐
 * `db.list_board_comments`）。
 *
 * 注意与读板路径的差别：这里**刻意不过滤 `trashed=0`**——回收站里的卡片也保留
 * 评论（还原后要能看见），Python 侧就没有这道过滤，照抄。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listBoardComments(projectId, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT c.* FROM board_comments c'
    + ' JOIN board_cards k ON k.id=c.card_id'
    + ' WHERE k.project_id=? ORDER BY c.id').all(bindable(projectId))));
}

/**
 * 看板设置（无记录 / 坏 JSON 都返回 `{}`，调用方再与默认值合并，对齐 `db.get_board_settings`）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object}
 */
export function getBoardSettings(projectId, options = {}) {
  const row = withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT json FROM board_settings WHERE project_id=?').get(bindable(projectId))));
  if (row === null) return {};
  try {
    return pyJsonLoads(row.json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;   // 只吞 ValueError 分支（同 Python）
    return {};
  }
}

/**
 * 全局 KV 设置（app_settings 表，json 列）：dict 或 `{}`（无记录/坏 JSON 降级，
 * 对齐 `db.get_app_setting`）。
 * @param {string} key
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object}
 */
export function getAppSetting(key, options = {}) {
  const row = withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT json FROM app_settings WHERE key=?').get(bindable(key))));
  if (row === null) return {};
  try {
    return pyJsonLoads(row.json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;   // 只吞 ValueError 分支（同 Python）
    return {};
  }
}

/**
 * 某用户在某项目下的全部 UI 偏好：`{key: value}`（对齐 `db.get_user_prefs`）。
 *
 * **坏 JSON 的键降级跳过**（`value` 列被手工改坏时不能炸掉整个设置页），逐条 try/catch
 * 与 Python 的 `continue` 同义；键序 = 行序（用 `Object.fromEntries` 还能安全容纳
 * `__proto__` 这种键名——直接赋值会去改原型，Python 侧却是普通键）。
 * @param {number} userId
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Record<string, any>}
 */
export function getUserPrefs(userId, projectId, options = {}) {
  const rows = withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT key, value FROM user_prefs WHERE user_id=? AND project_id=?')
    .all(bindable(userId), bindable(projectId))));
  const entries = [];
  for (const row of rows) {
    try {
      entries.push([row.key, pyJsonLoads(row.value)]);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;   // 只吞 ValueError 分支（同 Python）
      // 坏 JSON（手工改库等）视同无此偏好
    }
  }
  return Object.fromEntries(entries);
}

// --------------------------------------------------------------------------
// 写口（M4 起：调度核心要用的任务/轮次写；**白名单与 SQL 照 db.py 逐字**）
// --------------------------------------------------------------------------

/**
 * Python `int(x)` 的最小实现（`insert_task` 的 `int(cases_base or 0)` 用）。
 *
 * 为什么要单独写：`Number()` 会把 `"abc"` 静默变成 `NaN` 落库，而 Python 的
 * `int("abc")` 抛 **ValueError** —— 在 HTTP 路径上那等于「这个请求无响应、连接被掐断」。
 * 这里同形抛错（TypeError 由 `dispatchSafely` 收口成断连），绝不静默写坏数据。
 * 接受面照 CPython：number 截断、字符串允许两端空白/正负号/下划线分隔（`"1_0"` = 10）。
 * @param {unknown} value
 * @returns {number}
 */
function pyIntOf(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`int() 不接受 ${value}`);
    return Math.trunc(value);
  }
  const text = pyStrip(value);
  if (!/^[+-]?\d(?:_?\d)*$/.test(text)) {
    throw new TypeError(`invalid literal for int(): ${JSON.stringify(text)}`);
  }
  return Number(text.replaceAll('_', ''));
}

/** Python 真值（`""`/`0`/`None`/`False`/空容器为假）；JS 的 `[]`/`{}` 是 truthy，必须显式收口 */
function pyTruthyOf(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `tasks` 的 INSERT 列序（**逐字照抄** `db.py:insert_task` 的列清单与顺序） */
const TASK_INSERT_COLUMNS = [
  'project_id', 'name', 'auto_fix', 'retest', 'stop_type', 'stop_value',
  'task_type', 'payload', 'extra', 'model', 'permission', 'auto_commit', 'auto_deploy',
  'auto_retest', 'cases_base', 'start_stage', 'end_stage', 'date_from', 'date_to',
  'created_at',
];

/**
 * 插入任务行，返回新 id（对齐 `db.py:insert_task`(1012)）。
 *
 * 形态说明：Python 是 19 个位置参数（后 13 个带缺省）；Node 侧按**字段对象**收
 * （与 `updateTask(taskId, fields)` 同风格 —— 19 个位置参数在调用点无法阅读）。
 * 列序由 `TASK_INSERT_COLUMNS` 固定，与 `db.py` 的 INSERT 逐字同序，故调用方键序无关。
 *
 * 两处 Python 的隐式转换照做（**别顺手换成 JS 语义**）：
 *   - `1 if auto_fix else 0`（`auto_fix`/`auto_commit`/`auto_deploy`/`auto_retest`）：
 *     真值判定按 Python 口径（`[]`/`{}` 为假，JS 原生真值判定会给 1）；
 *   - `int(cases_base or 0)`：假值 → 0；真值走 `pyIntOf`（非法值抛错，见该函数）。
 * 缺省值只在**键缺省**时生效（`=== undefined`）：显式传 `null` 与 Python 一样落 NULL、
 * 由 NOT NULL 约束拦下 —— 不静默折成空串。
 *
 * `created_at` 一律用 `nowStr()`（= `db.now_str()`），不接受调用方传入。
 *
 * @param {number} projectId
 * @param {{name: string, autoFix?: any, retest?: any, stopType?: any, stopValue?: any,
 *          taskType?: string, payload?: string, extra?: any, model?: any, permission?: any,
 *          autoCommit?: any, autoDeploy?: any, autoRetest?: any, casesBase?: any,
 *          startStage?: any, endStage?: any, dateFrom?: any, dateTo?: any}} fields
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 新任务 id（`lastrowid`）
 */
export function insertTask(projectId, fields = {}, options = {}) {
  // Python 的「参数缺省」语义：只有**没给**才用缺省（`null` 是显式值，落 NULL 由约束拦）
  const orDefault = (value, dflt) => (value === undefined ? dflt : value);
  const values = [
    projectId,
    bindable(fields.name),
    pyTruthyOf(fields.autoFix) ? 1 : 0,
    bindable(fields.retest),                    // Python 无缺省：调用方必须给（retest 列 NOT NULL）
    bindable(fields.stopType),
    bindable(fields.stopValue),
    orDefault(fields.taskType, 'normal'),
    orDefault(fields.payload, ''),
    orDefault(fields.extra, ''),
    orDefault(fields.model, ''),
    orDefault(fields.permission, ''),
    pyTruthyOf(fields.autoCommit) ? 1 : 0,
    pyTruthyOf(fields.autoDeploy) ? 1 : 0,
    pyTruthyOf(fields.autoRetest) ? 1 : 0,
    pyTruthyOf(fields.casesBase) ? pyIntOf(fields.casesBase) : 0,   // int(cases_base or 0)
    fields.startStage || '',                    // 后四列 Python 是 `x or ""`（假值→空串）
    fields.endStage || '',
    fields.dateFrom || '',
    fields.dateTo || '',
    nowStr(),
  ];
  const sql = `INSERT INTO tasks(${TASK_INSERT_COLUMNS.join(',')})`
    + ` VALUES(${TASK_INSERT_COLUMNS.map(() => '?').join(',')})`;
  return withWriteDb(options, (handle) => Number(handle.prepare(sql).run(...values).lastInsertRowid));
}

/**
 * 任务可更新字段白名单（`db.py:update_task` 的 `allowed` 集合）。
 *
 * **不改这份清单**：它是注入防线（只有清单里的列能进 SQL），Python 侧同款；
 * 增删字段必须两侧一起改。
 */
export const TASK_UPDATE_FIELDS = Object.freeze(new Set([
  'name', 'auto_fix', 'retest', 'stop_type', 'stop_value', 'status',
  'session_id', 'current_round', 'new_bugs', 'started_at', 'ended_at',
  'error', 'task_type', 'payload', 'extra', 'model', 'permission',
  'auto_commit', 'auto_deploy', 'auto_retest', 'cases_base',
  'fresh_prompt', 'start_stage', 'end_stage', 'date_from', 'date_to',
  'load_rerun',
]));

/**
 * 按字段名更新任务（白名单字段防注入，对齐 `db.update_task(task_id, **fields)`）。
 *
 * 三个逐点保留的细节：
 *  - **白名单外的字段被静默丢弃**（Python 同：`cols` 空则整条 no-op，不报错）；
 *  - 列序 = 调用方给的 `fields` **键序**（Python dict 保序，SQL 文本因此可比）；
 *  - `null` 原样写（`ended_at=None` 是「清空」的正式形态，不许折成空串/0）。
 *
 * @param {number} taskId
 * @param {Record<string, any>} fields
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function updateTask(taskId, fields, options = {}) {
  const cols = Object.keys(fields || {}).filter((k) => TASK_UPDATE_FIELDS.has(k));
  if (!cols.length) return;
  const sql = `UPDATE tasks SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`;
  withWriteDb(options, (handle) => {
    handle.prepare(sql).run(...cols.map((c) => bindable(fields[c])), bindable(taskId));
  });
}

/**
 * 开一轮：落一行 `running` 轮次（对齐 `db.insert_round`）。
 * `kind='load'` 时 `runKey` 是该次发压运行的唯一标识（开始时刻 `YYYYmmdd_HHMMSS`）。
 * @returns {number} 新轮次行 id
 */
export function insertRound(taskId, roundNo, logPath, kind = 'agent', runKey = '', options = {}) {
  return withWriteDb(options, (handle) => Number(handle.prepare(
    'INSERT INTO rounds(task_id, round_no, status, log_path, started_at, kind, run_key)'
    + ' VALUES(?,?,?,?,?,?,?)',
  ).run(bindable(taskId), bindable(roundNo), 'running', bindable(logPath),
    nowStr(), bindable(kind), bindable(runKey)).lastInsertRowid));
}

/**
 * 结束一轮：状态/退出码/摘要；`logPath` 非空时先补写日志路径（进程离线场景）。
 * 两次 UPDATE 在**同一事务**内（Python 的 `with connect()` 同款）。
 */
export function finishRound(roundId, status, exitCode, summary, logPath = null, options = {}) {
  withWriteDb(options, (handle) => {
    if (logPath) {
      handle.prepare('UPDATE rounds SET log_path=? WHERE id=?')
        .run(bindable(logPath), bindable(roundId));
    }
    handle.prepare('UPDATE rounds SET status=?, exit_code=?, summary=?, ended_at=? WHERE id=?')
      .run(bindable(status), bindable(exitCode), bindable(summary), nowStr(), bindable(roundId));
  });
}

/** 清空任务的轮次记录（restart 调用，避免重启后 round_no 重复；对齐 `db.delete_rounds`）。 */
export function deleteRounds(taskId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM rounds WHERE task_id=?').run(bindable(taskId));
  });
}

/** 删除任务及其轮次记录（磁盘日志不清理；对齐 `db.delete_task`）。 */
export function deleteTask(taskId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM rounds WHERE task_id=?').run(bindable(taskId));
    handle.prepare('DELETE FROM tasks WHERE id=?').run(bindable(taskId));
  });
}

// --------------------------------------------------------------------------
// 看板写口（M5-1：卡片 / 评论 / 设置；**SQL 与白名单照 db.py:1140-1394 逐字**）
// --------------------------------------------------------------------------
//
// 形态与口径（与 `db.py` 同名函数逐点等价——差异即对拍红灯）：
//   - 每次调用一个写事务（`withWriteDb`，缺省 `BEGIN`…`COMMIT`）；给了 `{db}` 句柄就复用它
//     ——此时**不代为开事务**（M4.5 登记偏差：Python 的多语句写口包在一个事务里，而
//     `{db}` 在库内的惯用法是「加入调用方事务」，见 `withWriteDb` 的文档与 M4.5 记录 §3.1）。
//     `{db, tx:true}` 独立选项是 M5 的登记重构项，本批**未**改（本段只追加，不动既有语义）。
//   - 「变更信号」= `localbus.publish(boardTopic(projectId))`，**只发信号不带载荷**
//     （前端收到后重取 payload）。发信号的位置与 Python **同序**：都在写事务的 `fn` 内、
//     COMMIT 之前（Python 的 `with connect() as conn:` 是「提交在退出块时」，块内即未提交）。
//   - 返回**值**即契约：`insert_*` 回 `lastrowid`，`mark_card_viewed` 回布尔，
//     其余 Python 隐式回 `None` ⇒ Node 返回 `undefined`（调用方不得依赖返回值）。
//
// 谁发信号 / 谁不发（逐条对齐 db.py，**不是遗漏**）：
//   - 发：`insertBoardCard`（用**传参**的 project_id）、`updateBoardCard`（先读行，卡不在则
//     整条 no-op 故不发）、`markCardViewed`（**只有真清了标记才发**）、`trashBoardCard`、
//     `restoreBoardCard`、`purgeBoardCard`（用**删前**读到的 project_id，存在才发）；
//   - 不发：`insertBoardComment`、`updateBoardComment`、`deleteBoardComment`、
//     `setBoardSettings`，以及 `purgeTrashedCards` —— **清空回收站在 Python 侧空/非空都不发**
//     （`db.py:1326-1337` 全函数无 `localbus` 调用，已用真 Python 探针实测确认）。
//     前端「清空回收站」按响应自行重取，Node 侧照抄，**不许顺手补一个信号**。

/**
 * `update_board_card` 的可更新字段白名单（防注入；照抄 `db.py:BOARD_CARD_FIELDS`）。
 *
 * **不改这份清单**：只有清单里的列能进 SQL。注意 `unread` **不在**其中：它只由
 * `updateBoardCard` 按「列真变化」派生、由 `markCardViewed` 清除，调用方无法经 `fields` 误置。
 */
export const BOARD_CARD_FIELDS = Object.freeze(new Set([
  'title', 'description', 'column_key', 'sort_order', 'session_id', 'sessions',
  'block_kind', 'block_text', 'parent_card_id', 'readonly', 'model',
  'scheduled_at', 'worktree', 'jira_key', 'last_error', 'last_error_at',
  'done_at', 'origin',
]));

/** `update_board_comment` 的可更新字段白名单（照抄 `db.py:update_board_comment` 的局部 `allowed`）。 */
export const BOARD_COMMENT_UPDATE_FIELDS = Object.freeze(new Set([
  'sent', 'session_id', 'sent_text',
]));

/**
 * 卡片写路径的进程内变更信号（对齐 `db.py:_notify_card_change`）。
 *
 * 同连接按主键读 `project_id`（带索引，微秒级），命中才发对应看板 topic 的信号。
 * **异常一律吞掉**（Python 是空 `except`）：通知失败绝不影响业务写。
 * 调用位置在写事务的 `fn` 内（COMMIT 之前），与 Python 完全同序。
 * @param {import('node:sqlite').DatabaseSync} handle
 * @param {number} cardId
 */
function notifyCardChange(handle, cardId) {
  try {
    const row = handle.prepare('SELECT project_id FROM board_cards WHERE id=?')
      .get(bindable(cardId));
    if (row) publish(boardTopic(row.project_id));
  } catch {
    // 通知失败绝不影响业务写（对应 Python 的空 except）
  }
}

/**
 * 新建看板卡片（默认落 `todo` 列尾），返回卡片 id（对齐 `db.insert_board_card`）。
 *
 * 列尾口径照抄 Python：`MAX(sort_order)+1 WHERE project_id=? AND column_key='todo'`
 * ——**没有 `trashed=0` 过滤**，回收站里的 todo 卡也占号（实测：手工插一张
 * `trashed=1, sort_order=50` 的 todo 卡后，新卡取 51）。这不是疏漏，是 oracle 的既有行为，
 * 顺手加过滤会让两侧 `sort_order` 在「删卡后新建」这条路径上分叉。
 *
 * `created_at` 与 `updated_at` 是**两次** `now_str()`（Python 同），故理论上可能跨秒不同。
 * 插入后在**同一写事务内**发一次变更信号（用的是**传参**的 `projectId`，不重读行）。
 *
 * @param {number} projectId
 * @param {string} title
 * @param {string} [description]
 * @param {string} [jiraKey]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 新卡片 id（`lastrowid`）
 */
export function insertBoardCard(projectId, title, description = '', jiraKey = '', options = {}) {
  return withWriteDb(options, (handle) => {
    const row = handle.prepare(
      'SELECT COALESCE(MAX(sort_order),0)+1 FROM board_cards'
      + " WHERE project_id=? AND column_key='todo'").get(bindable(projectId));
    const sortOrder = Object.values(row)[0];    // 单列未命名：按位置取（同 Python 的 row[0]）
    const info = handle.prepare(
      'INSERT INTO board_cards(project_id, title, description, column_key,'
      + ' sort_order, jira_key, created_at, updated_at)'
      + " VALUES(?,?,?,'todo',?,?,?,?)",
    ).run(bindable(projectId), bindable(title), bindable(description), bindable(sortOrder),
      bindable(jiraKey), nowStr(), nowStr());
    publish(boardTopic(projectId));             // P4 看板事件化：新建卡片也发一次信号
    return Number(info.lastInsertRowid);
  });
}

/**
 * 按白名单字段更新卡片，自动刷新 `updated_at`（对齐 `db.update_board_card`）。
 *
 * 四条语义**逐字照抄**（顺序也是契约的一部分）：
 *  ① 白名单过滤：`BOARD_CARD_FIELDS` 之外的一律丢弃；**过滤后为空直接返回**（连
 *     `updated_at` 都不写、信号也不发）；
 *  ② `done_at` 派生：`column_key` 在 fields 且**未显式给** `done_at` ⇒ 落 `done` 盖当前时间、
 *     其它列清 `NULL`（集中在此维护，覆盖所有「置 done」的写路径）；
 *  ③ `unread` 派生：`markUnread` 为真且本次带 `column_key` ⇒ **同连接读现值**比对，
 *     列**真变化**才置 `unread=1`（同列写回不置位）；读不到行 ⇒ **整体 no-op 返回**
 *     （卡片已删：不动任何列、不刷 `updated_at`、不发信号）。`markUnread=false` 用于
 *     「用户本人在看板上操作引起」的列迁移（拖列/开始/停止/作答送达），不给自己提醒；
 *  ④ SQL 在派生**之后**拼（列集合此时才定），恒带 `, updated_at=?`。
 *
 * 列序 = `fields` 的**键序**，其后依次追加派生的 `done_at`、`unread`——与 Python dict 的
 * 插入序一致（显式给了 `done_at` 就保持它原来的位置，不追加）。Python 的 `**fields` 是
 * 一份**新** dict，本实现同样不修改调用方传入的 `fields`（只读它的键值）；除 `updated_at`
 * 外不写任何隐式列；`null` 原样写（`done_at: null` = 清空）。
 *
 * @param {number} cardId
 * @param {any} [markUnread] 真值判定按 Python 口径（见 `pyTruthyOf`）
 * @param {Record<string, any>} [fields]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function updateBoardCard(cardId, markUnread = true, fields = {}, options = {}) {
  const given = fields || {};
  const cols = Object.keys(given).filter((k) => BOARD_CARD_FIELDS.has(k));
  if (!cols.length) return;                     // ① 全被白名单挡掉：整条 no-op
  const values = cols.map((c) => given[c]);     // 与 cols 同步追加，保证「列序 = 值序」
  if (Object.hasOwn(given, 'column_key') && !Object.hasOwn(given, 'done_at')) {
    // ② done_at 派生。时刻口径与 Python 同：Python 也是在 `with connect()` **之前**算好这个值，
    //    故它与事务内取的 `updated_at` 是两次 now_str()（理论上可跨秒，实测同秒）。
    cols.push('done_at');
    values.push(given.column_key === 'done' ? nowStr() : null);
  }
  withWriteDb(options, (handle) => {
    if (pyTruthyOf(markUnread) && Object.hasOwn(given, 'column_key')) {
      const row = handle.prepare('SELECT column_key FROM board_cards WHERE id=?')
        .get(bindable(cardId));
      if (row === undefined) return;            // ③ 卡片已删：不动任何列
      if (row.column_key !== given.column_key) {
        cols.push('unread');
        values.push(1);
      }
    }
    // ④ SQL 在派生之后拼（列集合此时才是最终的）；恒带 updated_at
    const sql = 'UPDATE board_cards SET '
      + cols.map((c) => `${c}=?`).join(',') + ', updated_at=? WHERE id=?';
    handle.prepare(sql).run(...values.map(bindable), nowStr(), bindable(cardId));
    notifyCardChange(handle, cardId);
  });
}

/**
 * 清卡片「状态有更新·用户未打开」标记（对齐 `db.mark_card_viewed`）。
 *
 * 只写 `unread=0`，**刻意不刷 `updated_at`**：查看不是卡片内容变更，顺带刷时间会污染
 * 「更新新→旧」排序口径与 `list_queued_board_cards` 的排队顺序（该查询按 `updated_at` 排）。
 * 返回本次是否真清了标记（无卡 / 本来就未读 ⇒ false）；**只有真清过才发看板变更信号**
 * （省掉无意义的前端重取）。
 *
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function markCardViewed(cardId, options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare('UPDATE board_cards SET unread=0 WHERE id=? AND unread=1')
      .run(bindable(cardId));
    const changed = Number(info.changes) > 0;   // Python: cur.rowcount > 0
    if (changed) notifyCardChange(handle, cardId);
    return changed;
  });
}

/**
 * 卡片移入回收站（软删）：`trashed=1` + `trashed_at` + `updated_at`，发信号（对齐
 * `db.trash_board_card`）。此时卡片从看板列表消失（读板路径统一 `trashed=0` 过滤），
 * 行与评论保留待还原。行不存在时 UPDATE 是 0 行，且 `notifyCardChange` 读不到行 ⇒
 * **不发信号**（与 Python `_notify_card_change` 同）。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function trashBoardCard(cardId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE board_cards SET trashed=1, trashed_at=?, updated_at=? WHERE id=?')
      .run(nowStr(), nowStr(), bindable(cardId));
    notifyCardChange(handle, cardId);
  });
}

/**
 * 回收站还原：清 `trashed` 标记（回原列原位置，`sort_order` 保留）+ 清 `trashed_at`，
 * 发信号（对齐 `db.restore_board_card`）。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function restoreBoardCard(cardId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE board_cards SET trashed=0, trashed_at=NULL, updated_at=? WHERE id=?')
      .run(nowStr(), bindable(cardId));
    notifyCardChange(handle, cardId);
  });
}

/**
 * 彻底删除卡片并连带删其评论（对齐 `db.purge_board_card`）。
 *
 * 信号用的是**删前**读到的 `project_id`（删完就查不到行了，故不能走 `notifyCardChange`）；
 * 行本来就不存在 ⇒ 不发信号（Python `if pid_row:`）。三条语句在同一连接内按序执行
 * （Python 的隐式事务在第一条 DML 才 BEGIN，故那次 SELECT 实际在事务外——结果等价）。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function purgeBoardCard(cardId, options = {}) {
  withWriteDb(options, (handle) => {
    const pidRow = handle.prepare('SELECT project_id FROM board_cards WHERE id=?')
      .get(bindable(cardId));
    handle.prepare('DELETE FROM board_comments WHERE card_id=?').run(bindable(cardId));
    handle.prepare('DELETE FROM board_cards WHERE id=?').run(bindable(cardId));
    if (pidRow) publish(boardTopic(pidRow.project_id));
  });
}

/**
 * 清空项目回收站：真删全部已删卡及其评论（对齐 `db.purge_trashed_cards`）。
 *
 * **空回收站直接返回**（连 DELETE 都不发）。**非空也不发看板信号**——Python 原文全函数
 * 没有 `localbus` 调用（已实测确认），端点靠响应让前端重取；照抄，不许顺手补信号。
 * 那次 SELECT 与两条 `IN (?,…)` 删除在同一连接内按序执行（同 `purgeBoardCard` 的事务口径）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function purgeTrashedCards(projectId, options = {}) {
  withWriteDb(options, (handle) => {
    const rows = handle.prepare(
      'SELECT id FROM board_cards WHERE project_id=? AND trashed=1').all(bindable(projectId));
    const ids = rows.map((r) => r.id);
    if (!ids.length) return;
    const marks = ids.map(() => '?').join(',');   // Python: ",".join("?" * len(ids))
    handle.prepare(`DELETE FROM board_comments WHERE card_id IN (${marks})`)
      .run(...ids.map(bindable));
    handle.prepare(`DELETE FROM board_cards WHERE id IN (${marks})`).run(...ids.map(bindable));
  });
}

/**
 * 给卡片加评论，返回评论 id（对齐 `db.insert_board_comment`）。**不发看板信号**
 * （评论不改变卡面列/排序，Python 侧同样不发）。
 * @param {number} cardId
 * @param {string} text
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number}
 */
export function insertBoardComment(cardId, text, options = {}) {
  return withWriteDb(options, (handle) => Number(handle.prepare(
    'INSERT INTO board_comments(card_id, text, created_at) VALUES(?,?,?)',
  ).run(bindable(cardId), bindable(text), nowStr()).lastInsertRowid));
}

/**
 * 按白名单更新评论（投递状态 / 投递文本 / 投递会话；对齐 `db.update_board_comment`）。
 * 白名单外的键静默丢弃，过滤后为空即 no-op（不报错、不发信号）。
 * @param {number} commentId
 * @param {Record<string, any>} [fields]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function updateBoardComment(commentId, fields = {}, options = {}) {
  const given = fields || {};
  const cols = Object.keys(given).filter((k) => BOARD_COMMENT_UPDATE_FIELDS.has(k));
  if (!cols.length) return;
  const sql = 'UPDATE board_comments SET ' + cols.map((c) => `${c}=?`).join(',') + ' WHERE id=?';
  withWriteDb(options, (handle) => {
    handle.prepare(sql).run(...cols.map((c) => bindable(given[c])), bindable(commentId));
  });
}

/**
 * 删除单条评论（对齐 `db.delete_board_comment`）。行不存在同样静默（0 行）。
 * @param {number} commentId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function deleteBoardComment(commentId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM board_comments WHERE id=?').run(bindable(commentId));
  });
}

/**
 * 覆盖写看板设置（对齐 `db.set_board_settings`）。
 *
 * 序列化必须走 `pyJsonDumps`（= CPython `json.dumps(..., ensure_ascii=False)` 的默认形态）：
 * 与 Python **逐字节一致**，中文不转义、默认分隔符 `", "` / `": "`。
 * 例：`{a:"中文",b:[1,2]}` ⇒ `{"a": "中文", "b": [1, 2]}`。**不发看板信号**（Python 同）。
 * @param {number} projectId
 * @param {any} settings
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setBoardSettings(projectId, settings, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('INSERT OR REPLACE INTO board_settings(project_id, json) VALUES(?,?)')
      .run(bindable(projectId), pyJsonDumps(settings));
  });
}

// --------------------------------------------------------------------------
// 管理面写口（M6）：用户 / 项目 / 设置（**SQL 与列序照 db.py 逐字**）
// --------------------------------------------------------------------------
//
// 形态与口径（与 `db.py` 同名函数逐点等价——差异即对拍红灯）：
//   - **位置参数顺序一字不改**（`insert_user(username, pass_hash, salt="")` ⇒
//     `insertUser(username, passHash, salt = '')`）：Python 的缺省 = JS 的**末位形参缺省**
//     ——只有 `undefined`（=「没给」）才吃缺省，显式 `null` 与 Python 一样落 NULL、由
//     NOT NULL 约束拦下（同 `insertTask` 的 `orDefault` 口径）。末位多一个
//     `options = {dbPath, db, env}`，与文件内既有读/写口同形（`withWriteDb` 认句柄直传）。
//   - **约束错原样抛，绝不吞**：Python `sqlite3.IntegrityError`（唯一索引 2067 /
//     NOT NULL 1299 …整个约束族）在 Node 是
//     `err.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === 19`（`SQLITE_CONSTRAINT`）。
//     判据的既有实现是 `waitq.js` 的 `isIntegrityError`（该函数未导出）；本文件**不新增
//     重复实现**——写口只负责把错原样抛给调用方（路由层翻 400），需要判据的调用方自行
//     `err.errcode` 判定或从 `waitq.js` 引入（本批不许改 waitq.js）。
//   - JSON 列一律 `pyJsonDumps`（**不是** `JSON.stringify`）：中文不转义、分隔符
//     `", "`/`": "`，与 CPython `json.dumps(..., ensure_ascii=False)` 逐字节一致。
//   - 返回值即契约：`insert_*` 回 `lastrowid`，其余 Python 隐式回 `None` ⇒ 返回 `undefined`。

/**
 * 插入新用户，返回新 id（对齐 `db.insert_user`(db.py:823)）。
 *
 * 用户名唯一冲突（`sqlite3.IntegrityError`）**原样抛**，由调用方翻 400。
 * @param {string} username
 * @param {string} passHash
 * @param {string} [salt] 缺省空串（Python `salt=""`）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 新用户 id（`lastrowid`）
 */
export function insertUser(username, passHash, salt = '', options = {}) {
  return withWriteDb(options, (handle) => Number(handle.prepare(
    'INSERT INTO users(username, pass_hash, salt, created_at) VALUES(?,?,?,?)',
  ).run(bindable(username), bindable(passHash), bindable(salt), nowStr()).lastInsertRowid));
}

/**
 * 更新用户名与密码哈希（后台管理重置；对齐 `db.update_user`(db.py:831)）。
 * 行不存在静默（0 行）；用户名撞唯一索引同样**原样抛**。
 * @param {number} userId
 * @param {string} username
 * @param {string} passHash
 * @param {string} salt
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function updateUser(userId, username, passHash, salt, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE users SET username=?, pass_hash=?, salt=? WHERE id=?')
      .run(bindable(username), bindable(passHash), bindable(salt), bindable(userId));
  });
}

/**
 * 删除用户及其会话（对齐 `db.delete_user`(db.py:838)）。两条 DELETE 在**同一事务**内
 * （Python 的 `with connect()` 同款）；行不存在静默（各 0 行）。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function deleteUser(userId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM sessions WHERE user_id=?').run(bindable(userId));
    handle.prepare('DELETE FROM users WHERE id=?').run(bindable(userId));
  });
}

/**
 * 更新密码哈希并清除「强制改密」标记（改密成功后不再拦截其他端点；对齐
 * `db.change_password`(db.py:845)）。`must_change_pw` 写常量 0（不是绑定参数）。
 * @param {number} userId
 * @param {string} passHash
 * @param {string} salt
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function changePassword(userId, passHash, salt, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE users SET pass_hash=?, salt=?, must_change_pw=0 WHERE id=?')
      .run(bindable(passHash), bindable(salt), bindable(userId));
  });
}

/**
 * 插入项目（归属 `userId`），返回新 id（对齐 `db.insert_project`(db.py:950)）。
 *
 * 两处**必须照做**的细节：
 *   - `bug_dir` 列已废弃（bug 报告目录由 `work_dir` 派生），**恒写空串**——旧库该列
 *     NOT NULL 且无默认值，不能省略不写；
 *   - `(user_id, name)` 上有唯一索引 `idx_projects_user_name`，同用户重名**原样抛**
 *     `sqlite3.IntegrityError`（不同用户同名不冲突）。
 *
 * 位置参数顺序照 Python（`user_id` 在前，而 INSERT 列序里 `name` 在前——两者不同，别顺手对齐）。
 * @param {number} userId
 * @param {string} name
 * @param {string} projectDir
 * @param {string} agentPath
 * @param {string} workDir
 * @param {string} [guideText]
 * @param {string} [commitSpec]
 * @param {string} [deploySpec]
 * @param {string} [envLabel]
 * @param {string} [model]
 * @param {string} [skillUnderstand]
 * @param {string} [skillDeploy]
 * @param {string} [skillCommit]
 * @param {string} [skillTest]
 * @param {string} [skillCases]
 * @param {string} [reasoningEffort]
 * @param {string} [permissionMode]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 新项目 id（`lastrowid`）
 */
export function insertProject(userId, name, projectDir, agentPath, workDir,
  guideText = '', commitSpec = '', deploySpec = '', envLabel = '', model = '',
  skillUnderstand = '', skillDeploy = '', skillCommit = '', skillTest = '', skillCases = '',
  reasoningEffort = '', permissionMode = '', options = {}) {
  return withWriteDb(options, (handle) => Number(handle.prepare(
    'INSERT INTO projects(name, user_id, project_dir, agent_path, work_dir, bug_dir,'
    + ' guide_text, commit_spec, deploy_spec, env_label, model,'
    + ' skill_understand, skill_deploy, skill_commit, skill_test, skill_cases,'
    + ' reasoning_effort, permission_mode, created_at)'
    + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    bindable(name), bindable(userId), bindable(projectDir), bindable(agentPath),
    bindable(workDir), '',                      // bug_dir 恒空串（列已废弃，见函数注释）
    bindable(guideText), bindable(commitSpec), bindable(deploySpec), bindable(envLabel),
    bindable(model), bindable(skillUnderstand), bindable(skillDeploy), bindable(skillCommit),
    bindable(skillTest), bindable(skillCases), bindable(reasoningEffort),
    bindable(permissionMode), nowStr(),
  ).lastInsertRowid));
}

/**
 * 更新项目（对齐 `db.update_project`(db.py:975)）：只写这 16 列。
 *
 * `bug_dir`（已废弃）与 `created_at` **不碰**——别顺手补进去。同用户重名**原样抛**约束错。
 * @param {number} projectId
 * @param {string} name
 * @param {string} projectDir
 * @param {string} agentPath
 * @param {string} workDir
 * @param {string} [guideText]
 * @param {string} [commitSpec]
 * @param {string} [deploySpec]
 * @param {string} [envLabel]
 * @param {string} [model]
 * @param {string} [skillUnderstand]
 * @param {string} [skillDeploy]
 * @param {string} [skillCommit]
 * @param {string} [skillTest]
 * @param {string} [skillCases]
 * @param {string} [reasoningEffort]
 * @param {string} [permissionMode]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function updateProject(projectId, name, projectDir, agentPath, workDir,
  guideText = '', commitSpec = '', deploySpec = '', envLabel = '', model = '',
  skillUnderstand = '', skillDeploy = '', skillCommit = '', skillTest = '', skillCases = '',
  reasoningEffort = '', permissionMode = '', options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'UPDATE projects SET name=?, project_dir=?, agent_path=?, work_dir=?,'
      + ' guide_text=?, commit_spec=?, deploy_spec=?, env_label=?, model=?,'
      + ' skill_understand=?, skill_deploy=?, skill_commit=?, skill_test=?,'
      + ' skill_cases=?, reasoning_effort=?, permission_mode=? WHERE id=?',
    ).run(
      bindable(name), bindable(projectDir), bindable(agentPath), bindable(workDir),
      bindable(guideText), bindable(commitSpec), bindable(deploySpec), bindable(envLabel),
      bindable(model), bindable(skillUnderstand), bindable(skillDeploy), bindable(skillCommit),
      bindable(skillTest), bindable(skillCases), bindable(reasoningEffort),
      bindable(permissionMode), bindable(projectId),
    );
  });
}

/**
 * 删除项目及其任务/轮次（外键级联由应用层执行；对齐 `db.delete_project`(db.py:994)）。
 * 三条 DELETE **同序**（先 rounds 后 tasks 再 projects）且在同一事务内。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function deleteProject(projectId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM rounds WHERE task_id IN (SELECT id FROM tasks'
      + ' WHERE project_id=?)').run(bindable(projectId));
    handle.prepare('DELETE FROM tasks WHERE project_id=?').run(bindable(projectId));
    handle.prepare('DELETE FROM projects WHERE id=?').run(bindable(projectId));
  });
}

/**
 * 设置项目归档标记（True=归档 False=恢复）；只改标记，不动任务与文件（对齐
 * `db.set_project_archived`(db.py:1003)）。
 *
 * 真值判定照 Python（`1 if archived else 0`）：`[]`/`{}` 在 Python 是假、JS 原生真值却是真，
 * 故走 `pyTruthyOf`；`archived` 列的**存储类型就是整数** 1/0。
 * @param {number} projectId
 * @param {any} archived
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setProjectArchived(projectId, archived, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE projects SET archived=? WHERE id=?')
      .run(pyTruthyOf(archived) ? 1 : 0, bindable(projectId));
  });
}

/**
 * UPSERT 全局 KV 设置（dict 序列化为 json 列，整对象覆盖；对齐 `db.set_app_setting`(db.py:1414)）。
 * 序列化走 `pyJsonDumps`（中文不转义、`", "`/`": "` 分隔符，与 Python 逐字节一致）。
 * @param {string} key
 * @param {any} obj
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setAppSetting(key, obj, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'INSERT INTO app_settings(key, json) VALUES(?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET json=excluded.json',
    ).run(bindable(key), pyJsonDumps(obj));
  });
}

/**
 * UPSERT 一条 UI 偏好（value 为可 JSON 序列化对象，整对象覆盖；对齐
 * `db.set_user_pref`(db.py:1475)）。
 *
 * 冲突键是 `(user_id, project_id, key)` 三元组；覆盖时 `value` 与 `updated_at` 一起换新
 * （`excluded.value` / `excluded.updated_at`）。序列化同样走 `pyJsonDumps`。
 * @param {number} userId
 * @param {number} projectId
 * @param {string} key
 * @param {any} value
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setUserPref(userId, projectId, key, value, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'INSERT INTO user_prefs(user_id, project_id, key, value, updated_at)'
      + ' VALUES(?, ?, ?, ?, ?)'
      + ' ON CONFLICT(user_id, project_id, key)'
      + ' DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    ).run(bindable(userId), bindable(projectId), bindable(key), pyJsonDumps(value), nowStr());
  });
}

// --------------------------------------------------------------------------
// 飞书族数据访问（M7-R1：`db.py:1423-1623` 的 17 个函数）
// --------------------------------------------------------------------------
//
// 形态与口径（与 `db.py` 同名函数逐点等价——差异即对拍红灯）：
//   - 名字映射 = Python 名整串 snake_case → camelCase（`get_feishu_user_cfg` ⇒
//     `getFeishuUserCfg`），**基名不许多字少字**（R0 量具按该映射自动找 Node 函数）。
//     末位多一个 `options = {db, dbPath, env}`，与文件内既有读/写口同形。
//   - **一次调用一个短连接**（对齐 Python 的 `with connect() as conn`）；给了 `{db}` 就复用
//     调用方句柄（事务边界归调用方，同 `withWriteDb` 的文档）。
//   - `setFeishuBinding` 的 DELETE + INSERT 在**同一个 `withWriteDb`** 内（= Python 那一条
//     `with connect()`，同一事务）：中途失败不许留下「已解绑」残态。实测把 INSERT 打成必失败
//     （触发器 `RAISE(ABORT)`）后，旧行连同 `bound_at` 一起回滚 ⇒ **不许拆成两次写**。
//   - `feishuOutboxPush` 的 dedup SELECT 与 INSERT 在 Python 侧是**两个独立事务**
//     （`db.py:1510-1522` 两个 `with connect()` 块）⇒ 这里照抄：读走 `withReadDb`、写走
//     `withWriteDb`，中间的 **check-then-insert 窗口照留**（并发下同 dedup_key 可能插出两条
//     pending，属 oracle 既有行为，登记为未验项，不在这里「顺手修」）。唯一形态差异：调用方
//     给 `{db}` 且自己开着事务时该窗口会塌掉 —— Python 每次调用都是新连接，不存在这种形态。
//   - JSON 列一律 `pyJsonDumps` / `pyJsonLoads`（中文不转义、分隔符 `", "` / `": "`），与
//     CPython `json.dumps(..., ensure_ascii=False)` 逐字节一致。
//   - `feishu_outbox` 的插入把 `next_at` **硬编码 0**、`created_at` 取 `nowStr()`
//     （= `db.now_str()`：本地时间 `YYYY-MM-DD HH:MM:SS`），与 `db.py` 的 SQL 字面量同形。
//   - 两张表**不加 CHECK 约束、不加索引**（oracle 的 DDL 就没有；`schema.sql` 是共同真源）。
//   - 写口返回 `undefined`（Python 隐式 `None` 的对应物），只有 `feishuOutboxPush` 回 `lastrowid`。

/**
 * Python 侧 sqlite3 会把 bool 隐式适配成 1/0（`True` → 1）；`node:sqlite` 拒绑 boolean
 * （实测 `TypeError: Provided value cannot be bound to SQLite parameter N`）。
 * `setFeishuHook` 的 `enabled` 是唯一可能收到 bool 的形参，故在此做同形转换；其余值原样下传。
 * @param {unknown} value
 * @returns {unknown}
 */
function pyBoolInt(value) {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/**
 * 用户飞书配置 dict（`feishu_user_cfgs` 表 json 列）：dict 或 `{}`（无记录降级）。
 * 对齐 `db.get_feishu_user_cfg`(db.py:1423)。坏 JSON 降级 `{}`（**只吞 ValueError 分支**，
 * 即 Node 的 SyntaxError；类型错照 Python 抛 TypeError）。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object}
 */
export function getFeishuUserCfg(userId, options = {}) {
  const row = withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT json FROM feishu_user_cfgs WHERE user_id=?').get(bindable(userId))));
  if (row === null) return {};
  try {
    return pyJsonLoads(row.json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;   // 只吞 ValueError 分支（同 Python）
    return {};
  }
}

/**
 * UPSERT 用户飞书配置（整对象覆盖；secret 以明文落库，同旧全局语义）。
 * 对齐 `db.set_feishu_user_cfg`(db.py:1436)；JSON 文本走 `pyJsonDumps`（逐字节同 Python）。
 * @param {number} userId
 * @param {any} obj
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setFeishuUserCfg(userId, obj, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?, ?)'
      + ' ON CONFLICT(user_id) DO UPDATE SET json=excluded.json',
    ).run(bindable(userId), pyJsonDumps(obj));
  });
}

/**
 * 全部用户的飞书配置 `[[user_id, dict], …]`（服务启动遍历入站长连接用）。
 * 对齐 `db.list_feishu_user_cfgs`(db.py:1445)：**坏 JSON 整行丢弃**（不是降级 `{}`——
 * 那是 `getFeishuUserCfg` 的单行语义）。返回二元组数组（Python 的 list[tuple]）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Array<[number, object]>}
 */
export function listFeishuUserCfgs(options = {}) {
  const rows = withReadDb(options, (handle) => plainRows(handle.prepare(
    'SELECT user_id, json FROM feishu_user_cfgs').all()));
  const out = [];
  for (const row of rows) {
    try {
      out.push([row.user_id, pyJsonLoads(row.json)]);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;   // 只吞 ValueError 分支（同 Python）
      // 坏 JSON 行跳过（视同无配置）
    }
  }
  return out;
}

/**
 * 项目飞书推送绑定行（webhook/secret/事件开关），无记录返回 `null`。
 * 对齐 `db.get_feishu_hook`(db.py:1487)。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getFeishuHook(projectId, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM feishu_hooks WHERE project_id=?').get(bindable(projectId))));
}

/**
 * UPSERT 项目推送绑定（`events` 为逗号拼接串，合法性由调用方保证）。
 * 对齐 `db.set_feishu_hook`(db.py:1494)：覆盖时四列一起换新（`enabled` 不做 0/1 归一，
 * 原样落库；bool 走 `pyBoolInt`，与 Python sqlite3 的 bool→int 适配同形）。
 * @param {number} projectId
 * @param {string} webhookUrl
 * @param {string} webhookSecret
 * @param {string} events
 * @param {any} enabled
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setFeishuHook(projectId, webhookUrl, webhookSecret, events, enabled,
  options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'INSERT INTO feishu_hooks(project_id, webhook_url, webhook_secret, events, enabled)'
      + ' VALUES(?,?,?,?,?)'
      + ' ON CONFLICT(project_id) DO UPDATE SET webhook_url=excluded.webhook_url,'
      + ' webhook_secret=excluded.webhook_secret, events=excluded.events,'
      + ' enabled=excluded.enabled',
    ).run(bindable(projectId), bindable(webhookUrl), bindable(webhookSecret),
      bindable(events), bindable(pyBoolInt(enabled)));
  });
}

/**
 * 投递入队（飞书事件唯一入口）：同 `dedupKey` 已有 `pending` 行时幂等跳过（返回 `null`），
 * 否则插入并返回新行 id。对齐 `db.feishu_outbox_push`(db.py:1506)。
 *
 * 语义要点（逐条实测自 oracle，别改）：
 *   - dedup 只按 `dedup_key` + `status='pending'`，**不看 `user_id`**（换用户推同一 key 也算重复）；
 *   - 命中的是 `sent`/`failed` 行 ⇒ **照插新行**；
 *   - `dedupKey` 空串（假值）⇒ **恒插**，不做任何去重查询；
 *   - `next_at` 硬编码 `0`、`created_at` 用 `nowStr()`（本地时间口径）。
 * SELECT 与 INSERT 分属两次连接（两个事务），check-then-insert 窗口见本段文件头注释。
 * @param {string} target
 * @param {string} secret
 * @param {string} payload 调用方已序列化好的 JSON 文本（本函数**不做**序列化）
 * @param {string} [dedupKey]
 * @param {number} [userId] 投递归属用户（项目所有者，供设置页过滤）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number|null} 新行 id；dedup 命中回 `null`
 */
export function feishuOutboxPush(target, secret, payload, dedupKey = '', userId = 0,
  options = {}) {
  if (dedupKey) {
    const dup = withReadDb(options, (handle) => plainRow(handle.prepare(
      "SELECT id FROM feishu_outbox WHERE dedup_key=? AND status='pending'")
      .get(bindable(dedupKey))));
    if (dup !== null) return null;
  }
  return withWriteDb(options, (handle) => Number(handle.prepare(
    'INSERT INTO feishu_outbox(user_id, target, secret, payload, dedup_key,'
    + ' next_at, created_at) VALUES(?,?,?,?,?,0,?)')
    .run(bindable(userId), bindable(target), bindable(secret), bindable(payload),
      bindable(dedupKey), nowStr()).lastInsertRowid));
}

/**
 * 到期待投递行（`pending` 且 `next_at <= nowTs`，按 id 稳定序限量）。
 * 对齐 `db.feishu_outbox_due`(db.py:1525)：边界**含相等**（实测 `next_at=1000` 在
 * `nowTs=1000` 时命中、在 `999.9999` 时不命中）。
 * @param {number} nowTs epoch 秒（REAL 列，支持小数）
 * @param {number} [limit]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function feishuOutboxDue(nowTs, limit = 5, options = {}) {
  return withReadDb(options, (handle) => plainRows(handle.prepare(
    "SELECT * FROM feishu_outbox WHERE status='pending' AND next_at<=?"
    + ' ORDER BY id LIMIT ?').all(bindable(nowTs), bindable(limit))));
}

/**
 * 投递结果落账（发送线程专用：状态/重试数/下次重试时刻/末次错误摘要）。
 * 对齐 `db.feishu_outbox_mark`(db.py:1533)：**只改这四列**（`payload`/`target`/
 * `created_at`/`dedup_key` 一律不动）；id 不存在时静默 no-op（不抛）。
 * @param {number} oid
 * @param {string} status
 * @param {number} retries
 * @param {number} nextAt
 * @param {string} [lastError]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function feishuOutboxMark(oid, status, retries, nextAt, lastError = '', options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'UPDATE feishu_outbox SET status=?, retries=?, next_at=?, last_error=? WHERE id=?')
      .run(bindable(status), bindable(retries), bindable(nextAt), bindable(lastError),
        bindable(oid));
  });
}

/**
 * 最近投递记录（**新→旧**，`ORDER BY id DESC`）；`userId` 非 `null` 时仅返回该用户的
 * （设置页过滤）。对齐 `db.feishu_outbox_recent`(db.py:1541)。
 *
 * 注意 `userId=0` 是**合法过滤值**（系统/遗留投递归 0），不是「不过滤」——
 * 不过滤的唯一形态是 `null`（缺省）。
 * @param {number} [limit]
 * @param {number|null} [userId]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function feishuOutboxRecent(limit = 50, userId = null, options = {}) {
  return withReadDb(options, (handle) => {
    if (userId === null) {
      return plainRows(handle.prepare(
        'SELECT * FROM feishu_outbox ORDER BY id DESC LIMIT ?').all(bindable(limit)));
    }
    return plainRows(handle.prepare(
      'SELECT * FROM feishu_outbox WHERE user_id=? ORDER BY id DESC LIMIT ?')
      .all(bindable(userId), bindable(limit)));
  });
}

/**
 * 飞书号绑定行（`open_id` → Touchstone 用户），未绑返回 `null`。
 * 对齐 `db.get_feishu_binding_by_open`(db.py:1553)。
 * @param {string} openId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getFeishuBindingByOpen(openId, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM feishu_bindings WHERE open_id=?').get(bindable(openId))));
}

/**
 * 用户绑定行（Touchstone 用户 → 飞书号），未绑返回 `null`。
 * 对齐 `db.get_feishu_binding_by_user`(db.py:1560)。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function getFeishuBindingByUser(userId, options = {}) {
  return withReadDb(options, (handle) => plainRow(handle.prepare(
    'SELECT * FROM feishu_bindings WHERE user_id=?').get(bindable(userId))));
}

/**
 * 绑定飞书号 ↔ 用户（双向一对一），对齐 `db.set_feishu_binding`(db.py:1567)。
 *
 * 两条语句、**同一事务**（见本段文件头）：先 `DELETE WHERE user_id=?`（换号重绑：该 user
 * 名下的旧 open_id 行一律清掉），再对 `open_id` UPSERT；写「当前会话」四列时一律归零——
 * 绑定态不能跨身份继承（2026-10-08 起「换绑归零」）。
 *
 * `bound_at` **不在 INSERT 的列清单里**（照抄 oracle），故两条路径行为不同（实测）：
 *   - 「先 DELETE 再 INSERT」路径：新行取列默认 `datetime('now','localtime')` ⇒ `bound_at`
 *     刷新；同 openId 同 user 重绑也走这里，因为 DELETE **会删掉自己那一行**（实测表里另有
 *     更高 rowid 行时 rowid 由 1 变 3），随后是无冲突的普通插入；
 *   - `ON CONFLICT(open_id)` 覆盖路径（同 openId 换 user）：冲突分支**不更新** `bound_at`
 *     （只设 user_id / default_project_id 与四列），旧值保留。
 * @param {string} openId
 * @param {number} userId
 * @param {number} [defaultProjectId]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setFeishuBinding(openId, userId, defaultProjectId = 0, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM feishu_bindings WHERE user_id=?').run(bindable(userId));
    handle.prepare(
      'INSERT INTO feishu_bindings(open_id, user_id, default_project_id,'
      + " cur_sid, cur_project_id, cur_title, cur_bound_at)"
      + " VALUES(?,?,?,'',0,'','') ON CONFLICT(open_id) DO UPDATE SET"
      + ' user_id=excluded.user_id, default_project_id=excluded.default_project_id,'
      + " cur_sid='', cur_project_id=0, cur_title='', cur_bound_at=''",
    ).run(bindable(openId), bindable(userId), bindable(defaultProjectId));
  });
}

/**
 * 按飞书号解绑。对齐 `db.del_feishu_binding_by_open`(db.py:1584)：不存在的行静默 no-op。
 * @param {string} openId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function delFeishuBindingByOpen(openId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM feishu_bindings WHERE open_id=?').run(bindable(openId));
  });
}

/**
 * 按用户解绑（用户主动解绑 / admin 强制解绑）。对齐 `db.del_feishu_binding_by_user`(db.py:1590)。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function delFeishuBindingByUser(userId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('DELETE FROM feishu_bindings WHERE user_id=?').run(bindable(userId));
  });
}

/**
 * 设置单聊默认项目（0=无；归属校验由调用方保证）。对齐 `db.set_feishu_default_project`(db.py:1596)：
 * 行不存在时静默 no-op；**不动**「当前会话」四列，也不刷 `bound_at`。
 * @param {string} openId
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setFeishuDefaultProject(openId, projectId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE feishu_bindings SET default_project_id=? WHERE open_id=?')
      .run(bindable(projectId), bindable(openId));
  });
}

/**
 * 写「当前会话」绑定（`open_id` 行必须已存在；`cur_bound_at` 取本地时间字符串）。
 * 对齐 `db.set_feishu_cur_session`(db.py:1604)。
 *
 * 空值口径照 Python 的 `or`：`sid or ""` / `title or ""` / `int(project_id or 0)`——
 * 传 `null`/`undefined`/空串等价于清空对应字段（行上不出现 NULL）。`int()` 走 `pyIntOf`
 * （非法值抛 TypeError，同 `db.py` 里 `int()` 抛 ValueError 的位置）。行不存在 = no-op。
 * @param {string} openId
 * @param {number} projectId
 * @param {string} sid
 * @param {string} [title]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function setFeishuCurSession(openId, projectId, sid, title = '', options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      'UPDATE feishu_bindings SET cur_sid=?, cur_project_id=?, cur_title=?,'
      + ' cur_bound_at=? WHERE open_id=?')
      .run(pyTruthyOf(sid) ? sid : '',
        pyTruthyOf(projectId) ? pyIntOf(projectId) : 0,
        pyTruthyOf(title) ? title : '', nowStr(), bindable(openId));
  });
}

/**
 * 清「当前会话」绑定（**保留默认项目**；未绑定时为 no-op）。对齐
 * `db.clear_feishu_cur_session`(db.py:1618)。
 * @param {string} openId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function clearFeishuCurSession(openId, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare(
      "UPDATE feishu_bindings SET cur_sid='', cur_project_id=0,"
      + " cur_title='', cur_bound_at='' WHERE open_id=?").run(bindable(openId));
  });
}
