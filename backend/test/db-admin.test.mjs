/**
 * backend/lib/db.js **管理面写口**（M6）单测（node --test，零依赖）。
 *
 * 对象是 10 个从 `db.py` 逐字移植的写函数：`insertUser` / `updateUser` / `deleteUser` /
 * `changePassword` / `insertProject` / `updateProject` / `deleteProject` /
 * `setProjectArchived` / `setAppSetting` / `setUserPref`。判据分四层：
 *   ① 形状：`insert_*` 回新 id（number）、其余回 undefined、缺省参数落空串、`created_at`
 *      是 `nowStr()` 形态的本地时间串；
 *   ② 数据效果：逐列断言落库值（含 `bug_dir` **恒空串**、`updateProject` **不碰**
 *      `bug_dir`/`created_at`、`deleteProject` 只级联自己项目的 tasks/rounds、
 *      `archived` 以整数 1/0 存储）；
 *   ③ 约束错：重名（同用户同名项目 / 重名用户）与 NOT NULL 一律**原样抛**——断言
 *      `err.code === 'ERR_SQLITE_ERROR'` 且 `(err.errcode & 0xff) === 19`
 *      （= Python `sqlite3.IntegrityError` 的**整个约束族**；判据同 waitq.js:214）；
 *   ④ JSON 列：落库文本必须与 CPython `json.dumps(..., ensure_ascii=False)` 逐字节一致
 *      ——中文原样、分隔符 `", "`/`": "`（断言硬编码字面量，不是拿 `pyJsonDumps` 自证）。
 *
 * 落地口径：写函数末位可选 `options = {dbPath, db, env}`，与 `insertTask`/`setBoardSettings`
 * 同形——本文件既覆盖「自开短连接（`{dbPath}`）」，也覆盖「复用常驻句柄（`{db: handle}`，
 * 两次调用必须互见，且句柄不被关闭）」。
 *
 * ⚠ `insertProject`/`updateProject` 的 options 是**第 18 个位置参数**（前 17 个照 Python
 * 一字不改）。写测试时手数 18 段极易把 options 喂给 `guide_text` —— 那会静默回落
 * `defaultDbPath()`（测试进程里直接抛错，正好是 `db.js:defaultDbPath` 设计的防线）。
 * 故本文件统一走下面的 `addProject`/`editProject` 封装拼参数。
 *
 * 另有一条**不移植**的契约钉子：`db.py:take_seed_password()` 是模块级口令 + 读后即清；
 * Node 侧口令只由 `initDb()` 的返回值承载，故第二次 `initDb()` 必须回
 * `seeded:false, seedPassword:''`（口令不会被打印第二次）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import { pyJsonDumps } from '../lib/pyjson.js';

/** 种子环境：空口令 admin、不强制改密（与 db.test.mjs / db-read.test.mjs 同） */
const ENV_PASSWORDLESS = { TS_ADMIN_PASSWORDLESS: '1' };

/** 夹具里的固定时间戳（断言「update 不许碰」用） */
const T0 = '2001-02-03 04:05:06';

/** `projects` 的 12 个可选文本列（顺序 = Python 形参顺序，options 之前） */
const PROJECT_TEXT_KEYS = ['guideText', 'commitSpec', 'deploySpec', 'envLabel', 'model',
  'skillUnderstand', 'skillDeploy', 'skillCommit', 'skillTest', 'skillCases',
  'reasoningEffort', 'permissionMode'];

/** 建临时目录 */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 建一个临时空库（结构走 `db.initDb()` = 生产建库路径，种子一个 admin）。
 * @returns {{dir: string, dbPath: string}}
 */
function makeDb(prefix = 'ts-db-admin-') {
  const dir = tmpDir(prefix);
  const dbPath = path.join(dir, 'admin.db');
  db.initDb({ dbPath, env: ENV_PASSWORDLESS });
  return { dir, dbPath };
}

/** 开一个常驻句柄跑断言，返回前必关。 */
function withHandle(dbPath, fn) {
  const handle = db.openDb(dbPath);
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

/** `insertProject` 的正确拼参（末位 options；见文件头 ⚠） */
function addProject(options, userId, name, projectDir, agentPath, workDir, extra = {}) {
  const rest = PROJECT_TEXT_KEYS.map((k) => (k in extra ? extra[k] : undefined));
  return db.insertProject(userId, name, projectDir, agentPath, workDir, ...rest, options);
}

/** `updateProject` 的正确拼参（末位 options；见文件头 ⚠） */
function editProject(options, projectId, name, projectDir, agentPath, workDir, extra = {}) {
  const rest = PROJECT_TEXT_KEYS.map((k) => (k in extra ? extra[k] : undefined));
  return db.updateProject(projectId, name, projectDir, agentPath, workDir, ...rest, options);
}

/** `db.py` 里 `sqlite3.IntegrityError` 的 Node 对应物：SQLITE_CONSTRAINT(19) 整个族 */
function assertConstraintError(err) {
  assert.equal(err.code, 'ERR_SQLITE_ERROR');
  assert.equal(Number(err.errcode) & 0xff, 19, `期望约束族（主码 19），实际 errcode=${err.errcode}`);
}

/** `now_str()` 形态：`YYYY-MM-DD HH:MM:SS`（本地时间） */
const NOW_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 造一行任务（`insertTask` 的 `retest`/`stopType`/`stopValue` 在 Python 里**没有缺省**，
 * 必须给：schema 对应列 NOT NULL 且无默认值，落 NULL 会被约束拦下）。
 */
function addTask(handle, projectId, name) {
  return db.insertTask(projectId, {
    name, retest: '不复测', stopType: 'rounds', stopValue: '1',
  }, { db: handle });
}

/** 读一行（列名取值；未命中 → null，便于断言） */
function row(handle, sql, ...params) {
  const hit = handle.prepare(sql).get(...params);
  return hit === undefined ? null : { ...hit };
}

/** 数一行（COUNT(*)） */
function count(handle, sql, ...params) {
  return Number(handle.prepare(sql).get(...params).n);
}

// --------------------------------------------------------------------------
// users：insert / update / delete / change_password
// --------------------------------------------------------------------------

test('insertUser：返回新 id，created_at 有值，salt 缺省为空串', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const id = db.insertUser('alice', 'hash-a', undefined, { db: handle });
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);

    const alice = row(handle, 'SELECT * FROM users WHERE id=?', id);
    assert.equal(alice.username, 'alice');
    assert.equal(alice.pass_hash, 'hash-a');
    assert.equal(alice.salt, '', 'salt 缺省必须是空串（Python salt=""）');
    assert.equal(alice.must_change_pw, 0, 'must_change_pw 走列默认 0');
    assert.match(alice.created_at, NOW_RE);
    assert.equal(typeof alice.created_at, 'string');

    // 显式给 salt：原样落库
    const bobId = db.insertUser('bob', 'hash-b', 'salt-b', { db: handle });
    assert.equal(row(handle, 'SELECT salt FROM users WHERE id=?', bobId).salt, 'salt-b');

    // 自开短连接（{dbPath}）写进的是同一个库
    const carolId = db.insertUser('carol', 'hash-c', undefined, { dbPath });
    assert.equal(row(handle, 'SELECT username FROM users WHERE id=?', carolId).username, 'carol');
  });
});

test('insertUser：重名与 NOT NULL 都抛约束族错（原样抛，不吞不折算）', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    db.insertUser('dup', 'h', 's', { db: handle });

    let dupErr = null;
    try {
      db.insertUser('dup', 'h2', 's2', { db: handle });
    } catch (err) {
      dupErr = err;
    }
    assert.ok(dupErr, '重名必须抛（Python sqlite3.IntegrityError）');
    assertConstraintError(dupErr);
    // 撞唯一索引：确实没写进去第二行
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users WHERE username=?', 'dup'), 1);

    let nnErr = null;
    try {
      db.insertUser(null, 'h3', 's3', { db: handle });
    } catch (err) {
      nnErr = err;
    }
    assert.ok(nnErr, 'username NOT NULL 也必须抛（约束族不只唯一索引）');
    assertConstraintError(nnErr);
  });
});

test('updateUser：改用户名 + 哈希 + 盐（其余列不动）', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const id = db.insertUser('old-name', 'old-hash', 'old-salt', { db: handle });
    const before = row(handle, 'SELECT * FROM users WHERE id=?', id);

    db.updateUser(id, 'new-name', 'new-hash', 'new-salt', { db: handle });

    const after = row(handle, 'SELECT * FROM users WHERE id=?', id);
    assert.equal(after.username, 'new-name');
    assert.equal(after.pass_hash, 'new-hash');
    assert.equal(after.salt, 'new-salt');
    assert.equal(after.created_at, before.created_at, 'created_at 不参与 UPDATE');
    assert.equal(after.must_change_pw, before.must_change_pw);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users'), 2, 'admin + 这一行');
    // 行不存在时静默（0 行，不抛）
    db.updateUser(99999, 'ghost', 'h', 's', { db: handle });
  });
});

test('deleteUser：删用户的同时删掉其会话，别人的会话不受影响', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const victim = db.insertUser('victim', 'h', 's', { db: handle });
    const keeper = db.insertUser('keeper', 'h', 's', { db: handle });
    db.createSession(handle, victim, 'tok-victim', '2099-01-01 00:00:00');
    db.createSession(handle, keeper, 'tok-keeper', '2099-01-01 00:00:00');
    // admin(id=1) 也留一条会话，验证不误删
    db.createSession(handle, 1, 'tok-admin', '2099-01-01 00:00:00');
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM sessions'), 3);

    db.deleteUser(victim, { db: handle });

    assert.equal(row(handle, 'SELECT * FROM users WHERE id=?', victim), null);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', victim), 0);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users WHERE id=?', keeper), 1);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM sessions'), 2, 'keeper/admin 的会话留着');
    // 行不存在时静默（各 0 行，不抛）
    db.deleteUser(99999, { db: handle });
  });
});

test('changePassword：must_change_pw 1 → 0，且哈希/盐换新', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const id = db.insertUser('needs-change', 'old-hash', 'old-salt', { db: handle });
    // 造「强制改密」状态（登录时 seed/管理重置的形态）
    handle.prepare('UPDATE users SET must_change_pw=1 WHERE id=?').run(id);
    const before = row(handle, 'SELECT * FROM users WHERE id=?', id);
    assert.equal(before.must_change_pw, 1);

    db.changePassword(id, 'fresh-hash', 'fresh-salt', { db: handle });

    const after = row(handle, 'SELECT * FROM users WHERE id=?', id);
    assert.equal(after.must_change_pw, 0, '改密成功后不再拦截其他端点');
    assert.equal(after.pass_hash, 'fresh-hash');
    assert.equal(after.salt, 'fresh-salt');
    assert.equal(after.username, before.username);
    assert.equal(after.created_at, before.created_at);
  });
});

// --------------------------------------------------------------------------
// projects：insert / update / delete / archived
// --------------------------------------------------------------------------

test('insertProject：17 个入参全字段落库、bug_dir 恒空串、返回新 id', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const id = addProject({ db: handle }, 7, 'p-full', '/src/full', '/agent/bin', '/wd/full', {
      guideText: 'guide 正文',
      commitSpec: 'commit spec',
      deploySpec: 'deploy spec',
      envLabel: 'env-label',
      model: 'gpt-x',
      skillUnderstand: 'skill-u',
      skillDeploy: 'skill-d',
      skillCommit: 'skill-c',
      skillTest: 'skill-t',
      skillCases: 'skill-cases',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
    });
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);

    const p = row(handle, 'SELECT * FROM projects WHERE id=?', id);
    assert.equal(p.name, 'p-full');
    assert.equal(p.user_id, 7);
    assert.equal(p.project_dir, '/src/full');
    assert.equal(p.agent_path, '/agent/bin');
    assert.equal(p.work_dir, '/wd/full');
    assert.equal(p.bug_dir, '', 'bug_dir 列已废弃：恒写空串（老库该列 NOT NULL 无默认值）');
    assert.equal(p.guide_text, 'guide 正文');
    assert.equal(p.commit_spec, 'commit spec');
    assert.equal(p.deploy_spec, 'deploy spec');
    assert.equal(p.env_label, 'env-label');
    assert.equal(p.model, 'gpt-x');
    assert.equal(p.skill_understand, 'skill-u');
    assert.equal(p.skill_deploy, 'skill-d');
    assert.equal(p.skill_commit, 'skill-c');
    assert.equal(p.skill_test, 'skill-t');
    assert.equal(p.skill_cases, 'skill-cases');
    assert.equal(p.reasoning_effort, 'high');
    assert.equal(p.permission_mode, 'acceptEdits');
    assert.equal(p.archived, 0, 'archived 走列默认 0');
    assert.match(p.created_at, NOW_RE);
  });
});

test('insertProject：后 12 个可选参数缺省即空串（只给前 5 个必填）', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    // 12 个 undefined 显式占位 = Python 的「没给」（JS 形参缺省只在 undefined 时生效）
    const id = db.insertProject(1, 'p-default', '/src/d', '/agent/d', '/wd/d',
      ...Array(12).fill(undefined), { dbPath });
    const p = row(handle, 'SELECT * FROM projects WHERE id=?', id);
    for (const col of PROJECT_TEXT_KEYS) {
      const column = col.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      assert.equal(p[column], '', `${column} 缺省应为空串`);
    }
    assert.equal(p.bug_dir, '');
  });
});

test('insertProject：同用户重名抛约束错，不同用户同名不冲突', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    addProject({ db: handle }, 1, 'same', '/src/a', '', '/wd/a');

    let sameUserErr = null;
    try {
      addProject({ db: handle }, 1, 'same', '/src/b', '', '/wd/b');
    } catch (err) {
      sameUserErr = err;
    }
    assert.ok(sameUserErr, '同用户重名必须抛（UNIQUE(user_id, name)）');
    assertConstraintError(sameUserErr);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM projects WHERE name=?', 'same'), 1);

    // 另一个用户同名：唯一索引是 (user_id, name)，不冲突
    const otherId = addProject({ dbPath }, 2, 'same', '/src/c', '', '/wd/c');
    assert.ok(otherId > 0);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM projects WHERE name=?', 'same'), 2);
  });
});

test('updateProject：16 列全部更新，且绝不碰 bug_dir / created_at', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const id = addProject({ db: handle }, 1, 'p-old', '/src/old', '/agent/old', '/wd/old', {
      guideText: 'g-old', commitSpec: 'c-old', deploySpec: 'd-old', envLabel: 'e-old',
      model: 'm-old', skillUnderstand: 'su-old', skillDeploy: 'sd-old', skillCommit: 'sc-old',
      skillTest: 'st-old', skillCases: 'sca-old', reasoningEffort: 're-old',
      permissionMode: 'pm-old',
    });
    // 老库遗留：bug_dir 列里塞旧值 + 固定 created_at（都必须原样留着）
    handle.prepare('UPDATE projects SET bug_dir=?, created_at=? WHERE id=?')
      .run('legacy-bug-dir', T0, id);

    editProject({ db: handle }, id, 'p-new', '/src/new', '/agent/new', '/wd/new', {
      guideText: 'g-new', commitSpec: 'c-new', deploySpec: 'd-new', envLabel: 'e-new',
      model: 'm-new', skillUnderstand: 'su-new', skillDeploy: 'sd-new', skillCommit: 'sc-new',
      skillTest: 'st-new', skillCases: 'sca-new', reasoningEffort: 're-new',
      permissionMode: 'pm-new',
    });

    const p = row(handle, 'SELECT * FROM projects WHERE id=?', id);
    assert.equal(p.name, 'p-new');
    assert.equal(p.project_dir, '/src/new');
    assert.equal(p.agent_path, '/agent/new');
    assert.equal(p.work_dir, '/wd/new');
    assert.equal(p.guide_text, 'g-new');
    assert.equal(p.commit_spec, 'c-new');
    assert.equal(p.deploy_spec, 'd-new');
    assert.equal(p.env_label, 'e-new');
    assert.equal(p.model, 'm-new');
    assert.equal(p.skill_understand, 'su-new');
    assert.equal(p.skill_deploy, 'sd-new');
    assert.equal(p.skill_commit, 'sc-new');
    assert.equal(p.skill_test, 'st-new');
    assert.equal(p.skill_cases, 'sca-new');
    assert.equal(p.reasoning_effort, 're-new');
    assert.equal(p.permission_mode, 'pm-new');
    assert.equal(p.bug_dir, 'legacy-bug-dir', 'bug_dir 已废弃：update 不许碰');
    assert.equal(p.created_at, T0, 'created_at 不参与 UPDATE');
    assert.equal(p.user_id, 1, 'user_id 不参与 UPDATE');
    // 行不存在时静默（0 行，不抛）
    editProject({ db: handle }, 99999, 'ghost', '/src/g', '', '/wd/g');
  });
});

test('deleteProject：级联删自己的 tasks 与 rounds，不误删别的项目', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const pid = addProject({ db: handle }, 1, 'p-del', '/src/del', '', '/wd/del');
    const other = addProject({ db: handle }, 1, 'p-keep', '/src/keep', '', '/wd/keep');

    const t1 = addTask(handle, pid, 't1');
    const t2 = addTask(handle, pid, 't2');
    const tOther = addTask(handle, other, 't-keep');
    db.insertRound(t1, 1, '/log/1', 'agent', '', { db: handle });
    db.insertRound(t1, 2, '/log/2', 'agent', '', { db: handle });
    db.insertRound(t2, 1, '/log/3', 'agent', '', { db: handle });
    db.insertRound(tOther, 1, '/log/keep', 'agent', '', { db: handle });

    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM tasks WHERE project_id=?', pid), 2);
    const roundCount = (p) => count(handle,
      'SELECT COUNT(*) AS n FROM rounds WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)', p);
    assert.equal(roundCount(pid), 3);

    db.deleteProject(pid, { db: handle });

    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM projects WHERE id=?', pid), 0);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM tasks WHERE project_id=?', pid), 0);
    assert.equal(roundCount(pid), 0);
    // 别的项目连任务带轮次一起留着
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM projects WHERE id=?', other), 1);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM tasks WHERE project_id=?', other), 1);
    assert.equal(roundCount(other), 1);
    // 行不存在时静默（三条 DELETE 各 0 行，不抛）
    db.deleteProject(99999, { db: handle });
  });
});

test('setProjectArchived：True→1 / False→0（整数存储），且只动标记', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const pid = addProject({ db: handle }, 1, 'p-arch', '/src/arch', '', '/wd/arch');
    const tid = addTask(handle, pid, 't');
    const before = row(handle, 'SELECT * FROM projects WHERE id=?', pid);

    db.setProjectArchived(pid, true, { db: handle });
    let p = row(handle, 'SELECT * FROM projects WHERE id=?', pid);
    assert.equal(p.archived, 1);
    assert.equal(typeof p.archived, 'number', 'archived 列存储类型就是整数');

    db.setProjectArchived(pid, false, { db: handle });
    p = row(handle, 'SELECT * FROM projects WHERE id=?', pid);
    assert.equal(p.archived, 0);

    // Python 真值口径（`1 if archived else 0`）：空容器在 Python 是**假**，JS 原生真值是真
    db.setProjectArchived(pid, [], { db: handle });
    assert.equal(row(handle, 'SELECT archived FROM projects WHERE id=?', pid).archived, 0,
      '[] 在 Python 为假 ⇒ 0（JS 原生真值判定会给 1）');
    db.setProjectArchived(pid, {}, { db: handle });
    assert.equal(row(handle, 'SELECT archived FROM projects WHERE id=?', pid).archived, 0,
      '{} 在 Python 为假 ⇒ 0');
    db.setProjectArchived(pid, 1, { db: handle });
    assert.equal(row(handle, 'SELECT archived FROM projects WHERE id=?', pid).archived, 1);
    db.setProjectArchived(pid, 0, { db: handle });

    // 「只改标记，不动任务与文件」：其余列与任务行原样
    assert.equal(p.name, before.name);
    assert.equal(p.work_dir, before.work_dir);
    assert.equal(p.created_at, before.created_at);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM tasks WHERE id=?', tid), 1);
  });
});

// --------------------------------------------------------------------------
// 设置：app_settings / user_prefs（JSON 列逐字节）
// --------------------------------------------------------------------------

test('setAppSetting：UPSERT 覆盖 + 中文不转义（逐字节对齐 json.dumps）', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    db.setAppSetting('ui.theme', { mode: 'dark' }, { db: handle });
    assert.equal(row(handle, "SELECT json FROM app_settings WHERE key='ui.theme'").json,
      '{"mode": "dark"}');

    // 同一 key 再写：整对象覆盖（不是插入第二行）
    const value = { cjk: '中文测试', n: [1, 2], quote: 'a"b', emoji: '🔒' };
    db.setAppSetting('ui.theme', value, { db: handle });

    const stored = row(handle, "SELECT json FROM app_settings WHERE key='ui.theme'").json;
    assert.equal(stored,
      '{"cjk": "中文测试", "n": [1, 2], "quote": "a\\"b", "emoji": "🔒"}',
      'JSON 列文本必须逐字节等于 CPython json.dumps(..., ensure_ascii=False)');
    assert.equal(stored, pyJsonDumps(value), '与 pyJsonDumps 口径一致');
    assert.ok(stored.includes('中文测试'), '中文不许被 \\uXXXX 转义');
    assert.equal(count(handle,
      "SELECT COUNT(*) AS n FROM app_settings WHERE key='ui.theme'"), 1, 'UPSERT 不是新插入');

    // 另一个 key 独立成行；读回来等价（注意 initDb 已在 app_settings 落了 schema_version）
    const before = count(handle, 'SELECT COUNT(*) AS n FROM app_settings');
    db.setAppSetting('other', { a: true }, { db: handle });
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM app_settings'), before + 1);
    assert.deepEqual({ ...db.getAppSetting('ui.theme', { db: handle }) }, value);
  });
});

test('setUserPref：UPSERT 覆盖 + updated_at 变化 + 中文口径 + 三元组键', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    db.setUserPref(1, 2, 'tab-layout', { tabs: ['a', 'b'], 标题: '中文' }, { db: handle });

    const first = row(handle,
      'SELECT * FROM user_prefs WHERE user_id=1 AND project_id=2 AND key=?', 'tab-layout');
    assert.equal(first.value, '{"tabs": ["a", "b"], "标题": "中文"}',
      '中文原样（ensure_ascii=False）、分隔符 ", "');
    assert.match(first.updated_at, NOW_RE);

    // 把 updated_at 拨回过去，再 UPSERT：必须被覆盖成新时间（否则「updated_at 变化」不可判）
    handle.prepare('UPDATE user_prefs SET updated_at=? WHERE user_id=1 AND project_id=2 AND key=?')
      .run(T0, 'tab-layout');

    db.setUserPref(1, 2, 'tab-layout', { tabs: [] }, { db: handle });

    const second = row(handle,
      'SELECT * FROM user_prefs WHERE user_id=1 AND project_id=2 AND key=?', 'tab-layout');
    assert.equal(second.value, '{"tabs": []}', '整对象覆盖');
    assert.notEqual(second.updated_at, T0, 'updated_at 必须换成新值');
    assert.match(second.updated_at, NOW_RE);
    assert.equal(count(handle,
      'SELECT COUNT(*) AS n FROM user_prefs WHERE user_id=1 AND project_id=2 AND key=?',
      'tab-layout'), 1, 'UPSERT 不是新插入');

    // 三元组：同 key 不同 project_id（或不同 user_id）各成一行
    db.setUserPref(1, 3, 'tab-layout', 'v3', { db: handle });
    db.setUserPref(2, 2, 'tab-layout', 'v4', { db: handle });
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM user_prefs'), 3);
    assert.deepEqual({ ...db.getUserPrefs(1, 2, { db: handle }) }, { 'tab-layout': { tabs: [] } });
    // 短连接读回同口径
    assert.deepEqual({ ...db.getUserPrefs(1, 3, { dbPath }) }, { 'tab-layout': 'v3' });
  });
});

// --------------------------------------------------------------------------
// 句柄复用（{db}）与短连接（{dbPath}）互见
// --------------------------------------------------------------------------

test('写口支持 {db} 复用常驻句柄：用户族同一句柄两次调用互见，句柄不被关闭', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const id = db.insertUser('reuse-u', 'h', 's', { db: handle });
    assert.equal(typeof id, 'number');

    // 第二次调用（同句柄）看得见第一次的数据
    db.updateUser(id, 'reuse-u2', 'h2', 's2', { db: handle });
    assert.equal(row(handle, 'SELECT username FROM users WHERE id=?', id).username, 'reuse-u2');

    db.changePassword(id, 'h3', 's3', { db: handle });
    assert.equal(row(handle, 'SELECT pass_hash FROM users WHERE id=?', id).pass_hash, 'h3');

    // 短连接（{dbPath}）写、常驻句柄读：必须落在同一个库
    db.insertUser('reuse-u3', 'h', 's', { dbPath });
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users WHERE username=?', 'reuse-u3'), 1);

    db.deleteUser(id, { db: handle });
    assert.equal(row(handle, 'SELECT * FROM users WHERE id=?', id), null);

    // 句柄仍然可用（没被 withWriteDb 关掉）
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users'), 2);
  });
});

test('写口支持 {db} 复用常驻句柄：项目族互见，且 {dbPath} 短连接写的数据也看得见', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    const pid = addProject({ db: handle }, 1, 'p-reuse', '/src/r', '', '/wd/r');
    editProject({ db: handle }, pid, 'p-reuse2', '/src/r2', '', '/wd/r2');
    assert.equal(row(handle, 'SELECT name FROM projects WHERE id=?', pid).name, 'p-reuse2');

    db.setProjectArchived(pid, true, { db: handle });
    assert.equal(row(handle, 'SELECT archived FROM projects WHERE id=?', pid).archived, 1);

    // 短连接插的项目，常驻句柄读得到
    const pid2 = addProject({ dbPath }, 2, 'p-reuse-short', '/src/s', '', '/wd/s');
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM projects WHERE id=?', pid2), 1);

    db.deleteProject(pid, { db: handle });
    assert.equal(row(handle, 'SELECT * FROM projects WHERE id=?', pid), null);
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM projects'), 1, '句柄仍可用');
  });
});

test('写口支持 {db} 复用常驻句柄：设置族互见（UPSERT 两次只有一行）', () => {
  const { dbPath } = makeDb();
  withHandle(dbPath, (handle) => {
    db.setAppSetting('k', { n: 1 }, { db: handle });
    db.setAppSetting('k', { n: 2 }, { db: handle });
    assert.equal(row(handle, "SELECT json FROM app_settings WHERE key='k'").json, '{"n": 2}');

    db.setUserPref(1, 1, 'p', { n: 1 }, { db: handle });
    db.setUserPref(1, 1, 'p', { n: 2 }, { db: handle });
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM user_prefs'), 1);
    assert.equal(row(handle, 'SELECT value FROM user_prefs').value, '{"n": 2}');

    // 短连接读回同样口径
    assert.deepEqual({ ...db.getAppSetting('k', { dbPath }) }, { n: 2 });
    assert.deepEqual({ ...db.getUserPrefs(1, 1, { dbPath }) }, { p: { n: 2 } });
  });
});

// --------------------------------------------------------------------------
// 种子口令：不移植 take_seed_password 的结构性等价证明
// --------------------------------------------------------------------------

test('initDb 二次调用：seeded=false 且 seedPassword 为空串（口令不会被打印第二次）', () => {
  const dir = tmpDir('ts-db-admin-seed-');
  const dbPath = path.join(dir, 'seed.db');

  // 第一次：无 TS_ADMIN_PASSWORD* ⇒ 随机一次性口令，**只经返回值交出一次**
  const first = db.initDb({ dbPath, env: {} });
  assert.equal(first.seeded, true);
  assert.ok(first.seedPassword.length > 0, '首次必须交出一次性口令');
  withHandle(dbPath, (handle) => {
    assert.equal(row(handle, "SELECT must_change_pw FROM users WHERE username='admin'").must_change_pw,
      1, '随机口令形态必须强制改密');
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users'), 1);
  });

  // 第二次（同库）：Node 侧取代 Python `_SEED_PASSWORD` + `take_seed_password()` 的
  // 「读后即清」——口令不再存在于任何返回值里
  const second = db.initDb({ dbPath, env: {} });
  assert.equal(second.seeded, false);
  assert.equal(second.seedPassword, '');
  assert.ok(Array.isArray(second.executed), 'executed 仍是步骤 id 数组（幂等重跑）');
  withHandle(dbPath, (handle) => {
    assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM users'), 1, '不重复种 admin');
  });
});
