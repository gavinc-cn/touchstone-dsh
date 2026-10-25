/**
 * T13：任务/卡片语言字段与首轮冻结（Node 侧验收）。
 *
 * 与 `tests/test_task_lang.py` **同一组语义**（双端逐条镜像）：
 *   ① 迁移：旧库（无 lang 列）经 `initDb` 后 tasks/board_cards 两表补列，存量行 `zh`；
 *   ② 任务创建冻结：`X-TS-Lang` → `?lang=` → 用户偏好 → `zh`；非法值跳过落下一来源
 *      （R27）；`TS_I18N=0` ⇒ `zh` 且创建路径不读偏好（SQL 计数，含正对照）；
 *   ③ pipeline 后段任务 = 父任务（请求）语言；runner 自动复测/复核 = 发起任务语言；
 *   ④ 卡片：新建 `lang=''`；首次 start 冻结请求语言；二次 start 不覆盖；
 *      所有带请求上下文的起跑入口（start / 拖列进 doing / 强制运行手势 / worktree
 *      合并回交）都在门禁之后冻结；无请求上下文的定时开工 / 队列拾起保持 `''`（F1 修复轮）；
 *   ⑤ payload：`taskJson` / `cardJson` 暴露规范化后的 `lang`；
 *   ⑥ 冻结语义：`lang` 不在 `TASK_UPDATE_FIELDS` / `BOARD_CARD_FIELDS` 白名单；
 *   ⑦ 飞书打回起跑：`executeBoardAction` 把已解析的收件人语言传给 `startCard`（R22）。
 *
 * 全部离线：不建真 dsh 会话、不发真飞书请求；建库走 `m3fixture.freshDb` 的临时库。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as db from '../lib/db.js';
import * as i18n from '../lib/i18n.js';
import * as inbound from '../lib/feishu_inbound.js';
import * as runner from '../lib/runner.js';
import { taskJson } from '../lib/taskjson.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertProject, insertWait } from './m3fixture.mjs';

const PRE_ALTER_SQL = new URL('../../backend/schema/fixtures/pre_alter.sql', import.meta.url);

/**
 * 造一个真 git 仓库夹具（worktree 合并回交路径要真跑 `git rev-list/status`）。
 * 隔离全局/系统 git 配置、只在 mkdtemp 里操作，**绝不碰本仓库**。
 */
function gitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-node-${tag}-`));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'ts-test',
    GIT_AUTHOR_EMAIL: 'ts@example.invalid',
    GIT_COMMITTER_NAME: 'ts-test',
    GIT_COMMITTER_EMAIL: 'ts@example.invalid',
  };
  const run = (args) => {
    const p = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    assert.equal(p.status, 0, `夹具 git ${args.join(' ')} 失败: ${p.stderr}`);
    return p.stdout;
  };
  run(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return { dir, repo, run };
}

// --------------------------------------------------------------------------
// 测试台（与 task-write.test.mjs 同款：真路由表 + 真库 + 停闸 Runner）
// --------------------------------------------------------------------------
function fakeReq({ method = 'GET', body = undefined, headers = {} } = {}) {
  const merged = { ...headers };
  let chunks = [];
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const buf = Buffer.from(text, 'utf8');
    merged['content-length'] = String(buf.length);
    chunks = [buf];
  }
  const stream = Readable.from(chunks, { objectMode: false });
  stream.headers = merged;
  stream.method = method;
  return stream;
}

function fakeRes() {
  const cap = { status: null, headers: null, body: null, destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) {
        cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
      },
      destroy() { cap.destroyed = true; },
    },
  };
}

const STATE_CACHE = {
  get: () => ({ library: { stats: { total: 0 } } }),
  fingerprint: () => '',
};

function setup(tag = 'task-lang') {
  const fx = freshDb(tag);
  const workDir = path.join(fx.dir, 'work');
  fs.mkdirSync(path.join(workDir, 'free_style'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'bug_report'), { recursive: true });
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, workDir, projectDir: path.join(workDir, 'proj'), agentPath: '',
  });
  const inst = new runner.Runner(true, { db: fx.db });      // bootGate=true ⇒ 永不拾取
  runner.setInstance(inst);
  return {
    fx, workDir, pid, inst,
    user: { id: 1, username: 'admin' },
    close() { runner.setInstance(null); fx.close(); },
  };
}

/** 发一次请求（真路由分派）；返回 {status, body, text(), json()}。 */
async function call(env, target, {
  method = 'GET', body, headers = {}, search = '', db: dbArg,
} = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq({ method, body, headers }),
    res,
    db: dbArg === undefined ? env.fx.db : dbArg,
    user: env.user,
    path: target,
    search,
    stateCache: STATE_CACHE,
  });
  await dispatch(ctx);
  return {
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

async function createTask(env, { headers = {}, search = '', body = { name: 'lang' },
  db: dbArg } = {}) {
  const res = await call(env, `/api/projects/${env.pid}/tasks`, {
    method: 'POST', body, headers, search, db: dbArg,
  });
  assert.equal(res.status, 200, res.text());
  return res.json();
}

/**
 * 包一层 `db` 句柄：记录所有 `prepare` 的 SQL（判「零偏好读」用），其余方法直通。
 * `withReadDb` 只要求 prepare/exec ⇒ 代理不会被当成「无句柄」而回落默认库。
 */
function countingDb(handle) {
  const hits = [];
  const proxy = new Proxy(handle, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          hits.push(String(sql));
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, hits };
}

const hasPrefQuery = (hits) => hits.some((sql) => /user_prefs/.test(sql));

// --------------------------------------------------------------------------
// ① 迁移：旧库补列 + 存量行默认 zh
// --------------------------------------------------------------------------
test('迁移：旧库经 initDb 后两表补 lang、存量行 zh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-tasklang-mig-'));
  const dbPath = path.join(dir, 'pre_alter.db');
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec(fs.readFileSync(PRE_ALTER_SQL, 'utf8'));
    // 先断言夹具确实「老」（防空对空）
    const colsOf = (table) => new Set(raw.prepare(`PRAGMA table_info(${table})`).all()
      .map((r) => r.name));
    assert.equal(colsOf('tasks').has('lang'), false);
    assert.equal(colsOf('board_cards').has('lang'), false);
  } finally {
    raw.close();
  }
  db.initDb({ dbPath, env: { TS_ADMIN_PASSWORDLESS: '1' } });
  const handle = db.openDb(dbPath);
  try {
    for (const table of ['tasks', 'board_cards']) {
      const cols = handle.prepare(`PRAGMA table_info(${table})`).all();
      const lang = cols.find((c) => c.name === 'lang');
      assert.ok(lang, `${table} 缺 lang 列`);
      assert.equal(lang.type, 'TEXT');
      assert.equal(lang.notnull, 1);
      assert.equal(lang.dflt_value, "'zh'");
      assert.equal(handle.prepare(`SELECT lang FROM ${table} WHERE id=1`).get().lang, 'zh');
    }
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// ② 语言取值函数（纯语义，双端同名）
// --------------------------------------------------------------------------
test('taskLang / cardLang 规范化：只认 en，其余（未知/空/缺失）一律 zh', () => {
  const cases = [
    [{ lang: 'en' }, 'en'],
    [{ lang: 'EN' }, 'en'],
    [{ lang: ' en ' }, 'en'],
    [{ lang: 'en-US' }, 'zh'],
    [{ lang: 'zh' }, 'zh'],
    [{ lang: 'zh-CN' }, 'zh'],
    [{ lang: '' }, 'zh'],
    [{ lang: null }, 'zh'],
    [{}, 'zh'],
    [null, 'zh'],
    [{ lang: 1 }, 'zh'],
  ];
  for (const [row, expected] of cases) {
    assert.equal(i18n.taskLang(row), expected, `taskLang(${JSON.stringify(row)})`);
    assert.equal(i18n.cardLang(row), expected, `cardLang(${JSON.stringify(row)})`);
  }
});

// --------------------------------------------------------------------------
// ③ 任务创建冻结：来源矩阵（真路由表）
// --------------------------------------------------------------------------
test('创建任务：X-TS-Lang: en → 行 lang=en', async () => {
  const env = setup('task-lang-hdr');
  try {
    const { id } = await createTask(env, { headers: { 'x-ts-lang': 'en' } });
    assert.equal(db.getTask(id, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('创建任务：?lang=en → 行 lang=en；显式头优先于 query', async () => {
  const env = setup('task-lang-query');
  try {
    const q = await createTask(env, { search: '?lang=en' });
    assert.equal(db.getTask(q.id, { db: env.fx.db }).lang, 'en');
    const both = await createTask(env, {
      headers: { 'x-ts-lang': 'zh' }, search: '?lang=en', body: { name: 'both' },
    });
    assert.equal(db.getTask(both.id, { db: env.fx.db }).lang, 'zh');
  } finally { env.close(); }
});

test('创建任务：无头/非法头/非法 query → zh', async () => {
  const env = setup('task-lang-zh');
  try {
    for (const [headers, search] of [
      [{}, ''],
      [{ 'x-ts-lang': 'fr' }, ''],
      [{ 'x-ts-lang': '' }, '?lang=xx'],
    ]) {
      const { id } = await createTask(env, { headers, search });
      assert.equal(db.getTask(id, { db: env.fx.db }).lang, 'zh');
    }
  } finally { env.close(); }
});

test('创建任务：用户偏好 en 兜底；非法头跳过落到偏好（R27）', async () => {
  const env = setup('task-lang-pref');
  try {
    db.setUserPref(1, 0, 'lang', { v: 'en' }, { db: env.fx.db });
    const plain = await createTask(env);
    assert.equal(db.getTask(plain.id, { db: env.fx.db }).lang, 'en');
    const invalid = await createTask(env, {
      headers: { 'x-ts-lang': 'fr-FR' }, body: { name: 'invalid' },
    });
    assert.equal(db.getTask(invalid.id, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('创建任务：TS_I18N=0 ⇒ zh 且不读偏好（SQL 计数，含正对照）', async () => {
  const env = setup('task-lang-zero');
  const prev = process.env.TS_I18N;
  try {
    db.setUserPref(1, 0, 'lang', { v: 'en' }, { db: env.fx.db });
    // 正对照：正常路径确实会读 user_prefs（证明计数桩有效）
    const normal = countingDb(env.fx.db);
    const { id: normalId } = await createTask(env, { db: normal.proxy });
    assert.equal(db.getTask(normalId, { db: env.fx.db }).lang, 'en');
    assert.equal(hasPrefQuery(normal.hits), true);

    process.env.TS_I18N = '0';
    const zero = countingDb(env.fx.db);
    const { id } = await createTask(env, {
      headers: { 'x-ts-lang': 'en' }, db: zero.proxy, body: { name: 'zero' },
    });
    assert.equal(db.getTask(id, { db: env.fx.db }).lang, 'zh');
    assert.equal(hasPrefQuery(zero.hits), false, 'TS_I18N=0 时不得读偏好');
  } finally {
    if (prev === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = prev;
    env.close();
  }
});

// --------------------------------------------------------------------------
// ④ pipeline 后段继承 + 拒绝 bug 建修例任务
// --------------------------------------------------------------------------
test('pipeline 后段任务继承父任务语言（en / zh 两档）', async () => {
  const env = setup('task-lang-pipe');
  try {
    const en = await createTask(env, {
      headers: { 'x-ts-lang': 'en' }, body: { name: 'pipe-en', end_stage: 'deploy' },
    });
    assert.equal(db.getTask(en.id, { db: env.fx.db }).lang, 'en');
    assert.ok(en.pipeline_id);
    assert.equal(db.getTask(en.pipeline_id, { db: env.fx.db }).lang, 'en');
    const zh = await createTask(env, {
      body: { name: 'pipe-zh', end_stage: 'deploy' },
    });
    assert.equal(db.getTask(zh.pipeline_id, { db: env.fx.db }).lang, 'zh');
  } finally { env.close(); }
});

test('拒绝 bug 建修例任务：请求语言', async () => {
  const env = setup('task-lang-reject');
  try {
    const bugDir = path.join(env.workDir, 'bug_report', 'BUG1');
    fs.mkdirSync(bugDir, { recursive: true });
    fs.writeFileSync(path.join(bugDir, 'bug_report.md'),
      '# 误报\n\n- **状态**: 待修复\n', 'utf8');
    const res = await call(env, `/api/projects/${env.pid}/bugs/BUG1/reject`, {
      method: 'POST', headers: { 'x-ts-lang': 'en' }, body: { reason: '不是产品问题' },
    });
    assert.equal(res.status, 200, res.text());
    const payload = res.json();
    const task = db.getTask(payload.task_id, { db: env.fx.db });
    assert.equal(task.task_type, 'reject');
    assert.equal(task.lang, 'en');
  } finally { env.close(); }
});

// --------------------------------------------------------------------------
// ⑤ runner 自动任务：继承发起任务语言
// --------------------------------------------------------------------------
test('自动复测任务继承 fix 任务 lang（en / zh 两档）', () => {
  const env = setup('task-lang-retest');
  try {
    const inst = new runner.Runner(true, { db: env.fx.db });
    const fixId = db.insertTask(env.pid, {
      name: '修复 BUG1', autoFix: 0, retest: '不复测', stopType: 'rounds',
      stopValue: '1', taskType: 'fix', payload: JSON.stringify({ bug_dir: 'BUG1' }),
      lang: 'en',
    }, { db: env.fx.db });
    inst.maybeAutoRetest(db.getProject(env.pid, { db: env.fx.db }),
      db.getTask(fixId, { db: env.fx.db }), { db: env.fx.db });
    let rows = db.listTasks(env.pid, { db: env.fx.db })
      .filter((t) => ['retest_bug', 'script_retest'].includes(t.task_type));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lang, 'en');

    const zhFix = db.insertTask(env.pid, {
      name: '修复 BUG2', autoFix: 0, retest: '不复测', stopType: 'rounds',
      stopValue: '1', taskType: 'fix', payload: JSON.stringify({ bug_dir: 'BUG2' }),
    }, { db: env.fx.db });
    inst.maybeAutoRetest(db.getProject(env.pid, { db: env.fx.db }),
      db.getTask(zhFix, { db: env.fx.db }), { db: env.fx.db });
    rows = db.listTasks(env.pid, { db: env.fx.db })
      .filter((t) => ['retest_bug', 'script_retest'].includes(t.task_type)
        && JSON.parse(t.payload || '{}').bug_dir === 'BUG2');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lang, 'zh');
  } finally { env.close(); }
});

test('spawnRetestTask 写入 lang；脚本复测回落时传发起任务语言', async () => {
  const env = setup('task-lang-spawn');
  try {
    const inst = new runner.Runner(true, { db: env.fx.db });
    const project = db.getProject(env.pid, { db: env.fx.db });
    const tid = inst.spawnRetestTask(project, 'BUG3', [], '/tmp/task-lang-round.log',
      '复测', 'en', { db: env.fx.db });
    assert.equal(db.getTask(tid, { db: env.fx.db }).lang, 'en');

    const taskId = db.insertTask(env.pid, {
      name: '脚本复测 BUG4', autoFix: 0, retest: '不复测', stopType: 'rounds',
      stopValue: '1', taskType: 'script_retest',
      payload: JSON.stringify({ bug_dir: 'BUG4' }), lang: 'en',
    }, { db: env.fx.db });
    const calls = [];
    inst.scriptCaseDirs = () => null;
    inst.scriptLive = () => {};
    inst.spawnRetestTask = (...args) => { calls.push(args); return 1; };
    await inst.runScriptRetest(project, db.getTask(taskId, { db: env.fx.db }),
      { db: env.fx.db });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][5], 'en');            // 第 6 位 = lang（发起任务）
  } finally { env.close(); }
});

// --------------------------------------------------------------------------
// ⑥ 卡片：未冻结 / 首轮冻结 / 二次 start 不覆盖 / 原子口
// --------------------------------------------------------------------------
test('新建卡 lang=""（未冻结），payload 兜底 zh；setBoardCardLang 先到先得', () => {
  const env = setup('task-lang-card-new');
  try {
    const cid = db.insertBoardCard(env.pid, '新卡', '', '', { db: env.fx.db });
    const row = db.getBoardCard(cid, { db: env.fx.db });
    assert.equal(row.lang, '');
    assert.equal(board.cardJson(row, {}, { db: env.fx.db }).lang, 'zh');
    assert.equal(db.setBoardCardLang(cid, 'en', { db: env.fx.db }), true);
    assert.equal(db.setBoardCardLang(cid, 'zh', { db: env.fx.db }), false);
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('卡片起跑：首次 start 冻结 en，二次 start 带 zh 不覆盖', async () => {
  const env = setup('task-lang-card-freeze');
  try {
    const cid = db.insertBoardCard(env.pid, '起跑', '', '', { db: env.fx.db });
    const project = db.getProject(env.pid, { db: env.fx.db });
    const [cardDict, err] = await board.startIntoDoing(project,
      db.getBoardCard(cid, { db: env.fx.db }), '', false, false, false, 'en',
      { db: env.fx.db });
    // Runner 在岗（bootGate=true）⇒ 统一排队路径：落 doing+queue，不真起会话
    assert.notEqual(cardDict, null);
    assert.equal(err, null);
    assert.equal(cardDict.lang, 'en');
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
    assert.equal(board.cardJson(db.getBoardCard(cid, { db: env.fx.db }), {},
      { db: env.fx.db }).lang, 'en');
    await board.startIntoDoing(project, db.getBoardCard(cid, { db: env.fx.db }),
      '', false, false, false, 'zh', { db: env.fx.db });
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('卡片起跑：无请求上下文（定时开工/队列拾起/内部调用）保持未冻结', async () => {
  const env = setup('task-lang-card-nolang');
  try {
    // 注意：**拖列进 doing 不是无 lang 路径**——它来自用户请求，会冻结 ctx.lang
    // （见下方 F1 修复轮用例）。这里固定的是无请求上下文的入口形态。
    const cid = db.insertBoardCard(env.pid, '无请求上下文', '', '', { db: env.fx.db });
    const project = db.getProject(env.pid, { db: env.fx.db });
    await board.startIntoDoing(project, db.getBoardCard(cid, { db: env.fx.db }),
      '', false, false, false, '', { db: env.fx.db });
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, '');
    assert.equal(board.cardJson(db.getBoardCard(cid, { db: env.fx.db }), {},
      { db: env.fx.db }).lang, 'zh');
  } finally { env.close(); }
});

test('startCard 入口冻结（失败路径也已冻结，二次不覆盖）', async () => {
  const env = setup('task-lang-startcard');
  try {
    const cid = db.insertBoardCard(env.pid, '直起', '', '', { db: env.fx.db });
    // 退场族（kimi）⇒ startCard 在起会话前必抛 RETIRED_MSG；冻结点仍在入口先写
    env.fx.db.prepare("UPDATE projects SET agent_path='kimi' WHERE id=?").run(env.pid);
    const project = db.getProject(env.pid, { db: env.fx.db });
    await assert.rejects(board.startCard(project, db.getBoardCard(cid, { db: env.fx.db }),
      '', 'en', { db: env.fx.db }));
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
    await assert.rejects(board.startCard(project, db.getBoardCard(cid, { db: env.fx.db }),
      '', 'zh', { db: env.fx.db }));
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('start 端点把 ctx.lang 传给 startIntoDoing（响应 400 但已冻结）', async () => {
  const env = setup('task-lang-card-http');
  try {
    const cid = db.insertBoardCard(env.pid, '端点起跑', '', '', { db: env.fx.db });
    const res = await call(env, `/api/projects/${env.pid}/board/cards/${cid}/start`, {
      method: 'POST', headers: { 'x-ts-lang': 'en' }, body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().card.id, cid);       // 入队路径：不真起会话
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
    const again = await call(env, `/api/projects/${env.pid}/board/cards/${cid}/start`, {
      method: 'POST', headers: { 'x-ts-lang': 'zh' }, body: {},
    });
    assert.equal(again.status, 200);
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

// --------------------------------------------------------------------------
// ⑥b 修复轮 1（F1/F2/F3）：所有带请求上下文的起跑入口都冻结，且冻结在门禁之后
// --------------------------------------------------------------------------
test('move 端点进 doing：ctx.lang 冻结卡片语言（payload 同值）', async () => {
  const env = setup('task-lang-card-move');
  try {
    const cid = db.insertBoardCard(env.pid, '拖进开发', '', '', { db: env.fx.db });
    const res = await call(env, `/api/projects/${env.pid}/board/cards/${cid}/move`, {
      method: 'POST', headers: { 'x-ts-lang': 'en' }, body: { column: 'doing' },
    });
    assert.equal(res.status, 200, res.text());
    assert.equal(res.json().card.id, cid);
    assert.equal(res.json().card.lang, 'en');      // 响应 payload 已按冻结值输出
    const row = db.getBoardCard(cid, { db: env.fx.db });
    assert.equal(row.column_key, 'doing');         // 排队路径：落 doing/queue 占位
    assert.equal(row.lang, 'en');                  // 库值已冻结
  } finally { env.close(); }
});

test('move 进 doing：二次带 zh 不覆盖已冻结的 en（先到先得）', async () => {
  const env = setup('task-lang-card-move-once');
  try {
    const cid = db.insertBoardCard(env.pid, '先到先得', '', '', { db: env.fx.db });
    db.setBoardCardLang(cid, 'en', { db: env.fx.db });
    const project = db.getProject(env.pid, { db: env.fx.db });
    const [cardDict, err] = await board.moveCard(project, cid, 'doing', '', null, false,
      'zh', { db: env.fx.db });
    assert.equal(err, null);
    assert.notEqual(cardDict, null);
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('doing→doing 强制运行手势冻结 lang（起跑失败也定格）', async () => {
  const env = setup('task-lang-card-force');
  try {
    const running = db.insertBoardCard(env.pid, 'RUN', '', '', { db: env.fx.db });
    db.updateBoardCard(running, false, { column_key: 'doing' }, { db: env.fx.db });
    const waiting = db.insertBoardCard(env.pid, 'WAIT', '', '', { db: env.fx.db });
    db.updateBoardCard(waiting, false,
      { column_key: 'doing', block_kind: 'queue' }, { db: env.fx.db });
    insertWait(env.fx.db, {
      projectId: env.pid, kind: 'card', targetId: running, state: 'running', seq: 1,
    });
    insertWait(env.fx.db, {
      projectId: env.pid, kind: 'card', targetId: waiting, state: 'waiting', seq: 2,
    });
    const project = db.getProject(env.pid, { db: env.fx.db });
    const [out, err] = await board.moveCard(project, waiting, 'doing', '', running, false,
      'en', { db: env.fx.db });
    // 测试进程没配驱动 ⇒ force 起跑必失败（语言在起跑前已冻结）
    assert.equal(out, null);
    assert.ok(err !== null && err !== undefined && err.error, 'force 起跑应返回硬错误');
    assert.equal(db.getBoardCard(waiting, { db: env.fx.db }).lang, 'en');
  } finally { env.close(); }
});

test('被父任务门禁拒绝的 move 不冻结语言（冻结在门禁之后）', async () => {
  const env = setup('task-lang-parent-gate');
  try {
    const parent = db.insertBoardCard(env.pid, 'P', '', '', { db: env.fx.db });
    db.updateBoardCard(parent, false, { column_key: 'doing' }, { db: env.fx.db });
    const child = db.insertBoardCard(env.pid, 'C', '', '', { db: env.fx.db });
    db.updateBoardCard(child, false, { parent_card_id: parent }, { db: env.fx.db });
    const project = db.getProject(env.pid, { db: env.fx.db });
    const [out, err] = await board.moveCard(project, child, 'doing', '', null, false,
      'en', { db: env.fx.db });
    assert.equal(out, null);
    assert.deepEqual(err, { blocked: 'parent-not-done' });
    assert.equal(db.getBoardCard(child, { db: env.fx.db }).lang, '');
  } finally { env.close(); }
});

test('worktree 合并回交端点冻结 ctx.lang（真 git 待合并分支）', async () => {
  const env = setup('task-lang-merge');
  const fxGit = gitRepo('task-lang-merge-git');
  try {
    // 另建一个真 git 项目：卡片指向仓库目录，ts/card-<id> 分支领先 main 一个提交
    const pid = insertProject(env.fx.db, {
      userId: 1, name: 'merge', projectDir: fxGit.repo, workDir: fxGit.dir,
    });
    const cid = db.insertBoardCard(pid, '合并回交', '', '', { db: env.fx.db });
    db.updateBoardCard(cid, false, {
      column_key: 'review', worktree: fxGit.repo, session_id: 'sid-1',
    }, { db: env.fx.db });
    fxGit.run(['checkout', '-q', '-b', `ts/card-${cid}`]);
    fs.writeFileSync(path.join(fxGit.repo, 'b.txt'), 'two\n');
    fxGit.run(['add', '.']);
    fxGit.run(['commit', '-q', '-m', 'ahead']);
    fxGit.run(['checkout', '-q', 'main']);

    const res = await call(env, `/api/projects/${pid}/board/cards/${cid}/worktree/merge`, {
      method: 'POST', headers: { 'x-ts-lang': 'en' }, body: {},
    });
    assert.equal(res.status, 200, res.text());
    assert.equal(res.json().card.id, cid);
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'en');
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).column_key, 'doing');
  } finally {
    fs.rmSync(fxGit.dir, { recursive: true, force: true });
    env.close();
  }
});

test('定时开工（watchOnce，无请求上下文）不冻结语言', async () => {
  const env = setup('task-lang-scheduled');
  const hooks = board.boardHooks();
  try {
    const cid = db.insertBoardCard(env.pid, '定时卡', '', '', { db: env.fx.db });
    db.updateBoardCard(cid, true, { scheduled_at: 1 }, { db: env.fx.db });
    // session 自动同步与本例无关（真实现会扫会话存储）：换成零副作用桩
    board.setBoardHooks({ syncSessions: () => [] });
    await board.watchOnce({ db: env.fx.db });
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, '');
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).column_key, 'doing');
  } finally {
    board.setBoardHooks({ syncSessions: hooks.syncSessions });
    env.close();
  }
});

test('队列拾起（dequeueStart，无请求上下文）不冻结语言', async () => {
  const env = setup('task-lang-dequeue');
  try {
    const cid = db.insertBoardCard(env.pid, '队列拾起', '', '', { db: env.fx.db });
    const project = db.getProject(env.pid, { db: env.fx.db });
    const ok = await board.dequeueStart(project, db.getBoardCard(cid, { db: env.fx.db }),
      { db: env.fx.db });
    // 没配驱动 ⇒ 起跑失败并回滚；语言仍保持未冻结
    assert.equal(ok, false);
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, '');
  } finally { env.close(); }
});

// --------------------------------------------------------------------------
// ⑦ payload：任务详情/列表与卡片对象新增规范化 lang
// --------------------------------------------------------------------------
test('taskJson / cardJson 暴露规范化 lang（未知值 → zh）', () => {
  const env = setup('task-lang-payload');
  try {
    const enId = db.insertTask(env.pid, {
      name: 'en', autoFix: 0, retest: '不复测', stopType: 'rounds', stopValue: '1',
      taskType: 'normal', lang: 'en',
    }, { db: env.fx.db });
    const weirdId = db.insertTask(env.pid, {
      name: 'weird', autoFix: 0, retest: '不复测', stopType: 'rounds', stopValue: '1',
      taskType: 'normal', lang: 'en-GB',
    }, { db: env.fx.db });
    assert.equal(taskJson(db.getTask(enId, { db: env.fx.db }), { db: env.fx.db }).lang, 'en');
    assert.equal(taskJson(db.getTask(weirdId, { db: env.fx.db }), { db: env.fx.db }).lang, 'zh');

    const cid = db.insertBoardCard(env.pid, 'payload', '', '', { db: env.fx.db });
    db.setBoardCardLang(cid, 'en', { db: env.fx.db });
    assert.equal(board.cardJson(db.getBoardCard(cid, { db: env.fx.db }), {},
      { db: env.fx.db }).lang, 'en');
    env.fx.db.prepare("UPDATE board_cards SET lang='en-US' WHERE id=?").run(cid);
    assert.equal(board.cardJson(db.getBoardCard(cid, { db: env.fx.db }), {},
      { db: env.fx.db }).lang, 'zh');
  } finally { env.close(); }
});

test('冻结语义：lang 不在任务/卡片 update 白名单', () => {
  const env = setup('task-lang-whitelist');
  try {
    assert.equal(db.TASK_UPDATE_FIELDS.has('lang'), false);
    assert.equal(db.BOARD_CARD_FIELDS.has('lang'), false);
    const tid = db.insertTask(env.pid, {
      name: 'w', autoFix: 0, retest: '不复测', stopType: 'rounds', stopValue: '1',
      taskType: 'normal', lang: 'zh',
    }, { db: env.fx.db });
    db.updateTask(tid, { lang: 'en' }, { db: env.fx.db });
    assert.equal(db.getTask(tid, { db: env.fx.db }).lang, 'zh');

    const cid = db.insertBoardCard(env.pid, 'w', '', '', { db: env.fx.db });
    db.setBoardCardLang(cid, 'zh', { db: env.fx.db });
    db.updateBoardCard(cid, true, { lang: 'en' }, { db: env.fx.db });
    assert.equal(db.getBoardCard(cid, { db: env.fx.db }).lang, 'zh');
  } finally { env.close(); }
});

// --------------------------------------------------------------------------
// ⑧ 飞书打回起跑：传已解析的收件人语言（R22）
// --------------------------------------------------------------------------
test('executeBoardAction reject 把收件人 lang 传给 startCard', async () => {
  const env = setup('task-lang-feishu');
  try {
    const cid = db.insertBoardCard(env.pid, '待审核卡', '', '', { db: env.fx.db });
    db.updateBoardCard(cid, false, { column_key: 'review' }, { db: env.fx.db });
    const calls = [];
    const options = {
      db: env.fx.db,
      lang: 'en',
      board: {
        async startCard(...args) {
          calls.push(args);
          return '/tmp/task-lang.log';
        },
      },
    };
    const text = await inbound.executeBoardAction(
      { user_id: 1 }, { action: 'reject', groups: [String(cid), '再改改'] },
      'ou_test', options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].id, cid);
    assert.equal(calls[0][2], '再改改');
    assert.equal(calls[0][3], 'en');             // 第 4 位 = 已解析的收件人语言
    assert.ok(text);
  } finally { env.close(); }
});
