/**
 * `backend/routes/tasks.js` + `backend/lib/taskjson.js` 单测（node --test，零依赖）。
 *
 * 测试策略（为什么这么写）：
 *   - **走真路由表**：用 `routes/index.js` 的 `makeContext` + `dispatch` 组合一次请求，
 *     只伪造 `req`/`res`/db —— 分派顺序、`ctx.q` 的 parse_qs 口径、`ctx.ownedTask` 的
 *     多用户隔离红线都在链路上，不是「直接调 handler」能覆盖的；
 *   - **真库真文件**：临时目录里用 `db.initDb()` 建真 schema、插真行、写真日志文件，
 *     覆盖 `new_cases` 的案例库扫描（StateCache）与日志端点的文件分支；
 *   - **派生逻辑单独喂**：`taskJson`/`readDialogue`/`readLogTail` 直接喂合成行/合成日志，
 *     把「缺列老行」「6000 码点截断」「尾随换行」这些边界钉死；
 *   - 期望值的来源：**Python 探针实测**（`/tmp/ts_m3/probe.mjs`，同一 fixture 跑 Python 与
 *     Node 后逐字节比对），不是读代码猜的。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { StateCache } from '../lib/casescan.js';
import * as db from '../lib/db.js';
import * as sessparse from '../lib/sessparse.js';
import { DIALOGUE_TEXT_LIMIT, readDialogue, readLogTail, taskJson } from '../lib/taskjson.js';
import { dispatch, makeContext } from '../routes/index.js';

/** `_task_json` 的 29 个键，**顺序照抄 server.py:2533**（响应体走 pyJsonDumps，顺序即字节） */
const TASK_JSON_KEYS = [
  'id', 'project_id', 'name', 'auto_fix', 'retest', 'stop_type', 'stop_value', 'task_type',
  'payload', 'start_stage', 'end_stage', 'date_from', 'date_to', 'extra', 'model', 'permission',
  'auto_commit', 'auto_deploy', 'auto_retest', 'new_cases', 'status', 'session_id',
  'session_title', 'current_round', 'new_bugs', 'lang', 'created_at', 'started_at',
  'ended_at', 'error',
];

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 假 res：捕获 status/headers/body 与 destroy（`lib/http.js` 只用到 writeHead/end） */
function fakeRes() {
  const cap = { status: null, headers: null, body: null, destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) { cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'); },
      destroy() { cap.destroyed = true; },
    },
  };
}

/** 建临时环境：真库（initDb）+ 真工作目录（案例库/日志） */
function setup({ cases = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tasks-route-'));
  const dbPath = path.join(root, 'ts.db');
  db.initDb({ dbPath, env: { TS_ADMIN_PASSWORDLESS: '1' } });
  const handle = db.openDb(dbPath);
  const workDir = path.join(root, 'work');
  fs.mkdirSync(path.join(workDir, '.web'), { recursive: true });
  const casesRoot = path.join(workDir, 'free_style');
  fs.mkdirSync(casesRoot, { recursive: true });
  if (cases) {
    // 用例 = `FS\d{4}_名称` 目录 **且** 内有 status.md（见 casescan.js:scanDir）
    for (const [dir, status] of [['FS0001_alpha', '通过'], ['FS0002_beta', '失败']]) {
      fs.mkdirSync(path.join(casesRoot, dir), { recursive: true });
      fs.writeFileSync(path.join(casesRoot, dir, 'status.md'), `- **状态**: ${status}\n`);
    }
  }
  handle.prepare('INSERT INTO users(username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES(?,?,?,?,?)').run('bob', 'x', '', 0, '2026-01-01 00:00:00');
  const bob = handle.prepare('SELECT id FROM users WHERE username=?').get('bob').id;
  const insertProject = handle.prepare('INSERT INTO projects(user_id, name, project_dir,'
    + ' agent_path, work_dir, bug_dir, created_at) VALUES(?,?,?,?,?,?,?)');
  insertProject.run(1, 'P1', path.join(root, 'p1'), 'dsh-plugin:/usr/bin/dsh', workDir, '',
    '2026-01-01 00:00:00');
  const p1 = handle.prepare('SELECT id FROM projects WHERE name=?').get('P1').id;
  insertProject.run(bob, 'P2', path.join(root, 'p2'), '', path.join(root, 'p2work'), '',
    '2026-01-01 00:00:00');
  const p2 = handle.prepare('SELECT id FROM projects WHERE name=?').get('P2').id;
  return {
    root, handle, dbPath, workDir, casesRoot, p1, p2, bob,
    admin: db.getUserByName(handle, 'admin'),
    close() { handle.close(); },
  };
}

/** 插一行任务（缺省值覆盖「所有列都在 + 全空」的常态，over 覆盖个案） */
function addTask(env, projectId, over = {}) {
  const row = {
    project_id: projectId, name: '任务', auto_fix: 0, retest: '不复测', stop_type: 'rounds',
    stop_value: '1', task_type: 'normal', start_stage: '', end_stage: '', payload: '', extra: '',
    status: 'done', session_id: '', model: '', permission: 'manual', auto_commit: 0,
    auto_deploy: 0, auto_retest: 0, cases_base: 0, current_round: 0, new_bugs: 0,
    date_from: '', date_to: '', created_at: '2026-01-01 00:00:00', started_at: null,
    ended_at: null, error: '', ...over,
  };
  const keys = Object.keys(row);
  const info = env.handle.prepare(`INSERT INTO tasks(${keys.join(',')})`
    + ` VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

/** 插一行轮次 */
function addRound(env, taskId, roundNo, logPath, over = {}) {
  const row = {
    task_id: taskId, round_no: roundNo, status: 'done', exit_code: 0, log_path: logPath,
    started_at: '2026-01-01 00:00:00', ended_at: null, summary: '', kind: 'agent', run_key: '',
    ...over,
  };
  const keys = Object.keys(row);
  const info = env.handle.prepare(`INSERT INTO rounds(${keys.join(',')})`
    + ` VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

/** 写一个日志文件，返回路径 */
function writeLog(env, name, text) {
  const p = path.join(env.workDir, '.web', name);
  fs.writeFileSync(p, text);
  return p;
}

/** 走真路由表发一次请求（method 缺省 GET；user 缺省 admin） */
async function call(env, target, { search = '', user, method = 'GET' } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: { method },
    res,
    db: env.handle,
    user: user === undefined ? env.admin : user,
    path: target,
    search,
  });
  const hit = await dispatch(ctx);
  return { hit, ...cap, json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))) };
}

/** 造一份含四类条目的日志 */
function dialogueLogText() {
  return [
    '### PROMPT {"text": "做个任务"}',
    '### PROMPT 不是 JSON 的原文',
    '{"role": "assistant", "content": "好的", "tool_calls": [{"function": {"name": "bash", "arguments": "{\\"cmd\\":\\"ls\\"}"}}]}',
    '{"role": "tool", "tool_call_id": "call_1", "content": "工具输出"}',
    '{"role": "meta", "type": "session.resume_hint", "session_id": "sid-abc"}',
    '不是 JSON 的普通行',
    '{坏 JSON',
    '{"role": "system", "content": "忽略我"}',
    '',
  ].join('\n');
}

// --------------------------------------------------------------------------
// ① 桩端点
// --------------------------------------------------------------------------

test('GET /api/tasks：紧凑 JSON 桩（与 Python 硬编码体逐字节相同）', async () => {
  const env = setup();
  try {
    const r = await call(env, '/api/tasks');
    assert.equal(r.hit, true);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString('utf8'), '{"error":"task id required"}');
    assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(r.headers['Cache-Control'], 'no-store');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ② 任务列表 / 详情
// --------------------------------------------------------------------------

test('/api/projects/<id>/tasks：字段与顺序逐点对齐 _task_json，new_cases 走案例库扫描', async () => {
  const env = setup();
  try {
    const rich = addTask(env, env.p1, {
      name: '富字段任务', auto_fix: 1, retest: '复测', stop_type: 'bugs', stop_value: '3',
      task_type: 'retest_bug', start_stage: 'deploy', end_stage: 'retest',
      payload: '{"a":1}', extra: '额外要求', status: 'failed', model: 'explicit-m',
      permission: 'yolo', auto_commit: 1, auto_deploy: 0, auto_retest: 1, cases_base: 1,
      current_round: 2, new_bugs: 3, date_from: '2026-01-01', date_to: '2026-02-01',
      started_at: '2026-01-01 01:00:00', ended_at: '2026-01-01 02:00:00', error: 'oops',
    });
    const sid = addTask(env, env.p1, { name: '无阶段', cases_base: 5, session_id: '' });
    const r = await call(env, `/api/projects/${env.p1}/tasks`);
    assert.equal(r.status, 200);
    const list = r.json();
    assert.deepEqual(list.map((t) => t.id), [sid, rich], 'list_tasks 是 id 倒序');
    const t = list.find((x) => x.id === rich);
    assert.deepEqual(Object.keys(t), TASK_JSON_KEYS, '键集合与顺序都必须与 Python 一致');
    assert.equal(t.auto_fix, true);
    assert.equal(t.retest, '复测');
    assert.equal(t.start_stage, 'deploy');
    assert.equal(t.end_stage, 'retest');
    assert.equal(t.date_from, '2026-01-01');
    assert.equal(t.date_to, '2026-02-01');
    assert.equal(t.payload, '{"a":1}');
    assert.equal(t.extra, '额外要求');
    assert.equal(t.model, 'explicit-m');
    assert.equal(t.permission, 'yolo');
    assert.equal(t.auto_commit, true);
    assert.equal(t.auto_deploy, false);
    assert.equal(t.auto_retest, true);
    assert.equal(t.new_cases, 1, '2 个用例 − cases_base(1) = 1');
    assert.equal(t.current_round, 2);
    assert.equal(t.new_bugs, 3);
    assert.equal(t.lang, 'zh', 'T13：新增 lang（直插行取列默认 zh）');
    assert.equal(t.started_at, '2026-01-01 01:00:00');
    assert.equal(t.ended_at, '2026-01-01 02:00:00');
    assert.equal(t.error, 'oops');
    assert.equal(t.session_title, '', '空 session_id ⇒ 标题空串');
    const other = list.find((x) => x.id === sid);
    assert.equal(other.new_cases, 0, 'cases_base > 总数 ⇒ 归零（max(0, …)）');
    assert.equal(other.started_at, null, 'NULL 原样透出（不折成空串）');
  } finally {
    env.close();
  }
});

test('/api/tasks/<id>：session_title 走 dsh 会话标题（非 dsh 族/无会话/读失败都留空）', async () => {
  const env = setup();
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tasks-sess-'));
  const saved = sessparse.dshSessionsRoot();
  try {
    const sid = 'session-11111111-2222-3333-4444-555555555555';
    const dir = path.join(sessionsRoot, '--bucket--', sid);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: sid, cwd: '/tmp/x' }),
      JSON.stringify({ type: 'session/title', data: { title: '做压测' } }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(lines, 'utf8')));
    sessparse.setSessionsRoot(sessionsRoot);

    const withSid = addTask(env, env.p1, { name: '有会话', session_id: sid });
    const unknownSid = addTask(env, env.p1, { name: '会话不存在', session_id: 'session-99999999-9999-9999-9999-999999999999' });
    const r1 = await call(env, `/api/tasks/${withSid}`);
    assert.equal(r1.status, 200);
    assert.equal(r1.json().session_title, '做压测');
    const r2 = await call(env, `/api/tasks/${unknownSid}`);
    assert.equal(r2.json().session_title, '', '会话文件不存在 ⇒ 空串（不抛）');

    // 非 dsh 族：即使 sid 恰好存在也不读（Python `_sess_family(family) == "dsh"` 门）
    env.handle.prepare('UPDATE projects SET agent_path=? WHERE id=?').run('kimi', env.p1);
    const r3 = await call(env, `/api/tasks/${withSid}`);
    assert.equal(r3.json().session_title, '');
  } finally {
    sessparse.setSessionsRoot(saved);
    env.close();
  }
});

test('taskJson：缺列老行不抛；派生字段（model/new_cases/标题）各有降级分支', () => {
  const env = setup({ cases: false });
  try {
    // 「缺列老行」：只有最老的列（migrate 之前的行对象形态）
    const oldRow = {
      id: 42, project_id: env.p1, name: 'old', auto_fix: 0, retest: '不复测',
      stop_type: 'rounds', stop_value: '1', created_at: '2026-01-01 00:00:00',
    };
    const out = taskJson(oldRow, { db: env.handle, stateCache: new StateCache() });
    assert.equal(out.task_type, null, '缺列 ⇒ null（Python 会 IndexError，这里降级）');
    assert.equal(out.start_stage, '', '`or ""` 的列缺列 ⇒ 空串');
    assert.equal(out.date_from, '');
    assert.equal(out.payload, null);
    assert.equal(out.auto_fix, false);
    assert.equal(out.new_cases, 0, '项目读不到案例库 ⇒ 0');
    assert.equal(out.session_title, '', '无 session_id ⇒ 空串');
    assert.equal(out.lang, 'zh', '缺 lang 列 ⇒ 读侧归一 zh（T13）');
    assert.deepEqual(Object.keys(out), TASK_JSON_KEYS);

    // new_cases 的三种降级：无 stateCache（= Python except 分支）、坏 cases_base、负数归零
    const row = { id: 1, project_id: env.p1, cases_base: 0, session_id: '', model: '' };
    assert.equal(taskJson(row, { db: env.handle }).new_cases, 0, '未注入 StateCache ⇒ 走 except 分支');
    assert.equal(taskJson({ ...row, cases_base: 'abc' }, { db: env.handle, stateCache: new StateCache() }).new_cases, 0);
    // 负数 base 是坏数据，但 Python `max(0, total - base)` 也会给出 0-(-5)=5 ⇒ 两侧同值
    assert.equal(taskJson({ ...row, cases_base: -5 }, { db: env.handle, stateCache: new StateCache() }).new_cases, 5);
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ③ 轮次 / 对话
// --------------------------------------------------------------------------

test('/api/tasks/<id>/rounds：按 round_no 升序回整行（含重复轮次号）', async () => {
  const env = setup();
  try {
    const task = addTask(env, env.p1);
    addRound(env, task, 2, writeLog(env, 'r2.log', 'x\n'));
    addRound(env, task, 1, writeLog(env, 'r1.log', 'y\n'));
    addRound(env, task, 1, writeLog(env, 'r1b.log', 'z\n'), { status: 'running' });
    const r = await call(env, `/api/tasks/${task}/rounds`);
    assert.equal(r.status, 200);
    const rows = r.json();
    assert.deepEqual(rows.map((x) => x.round_no), [1, 1, 2]);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'ended_at', 'exit_code', 'id', 'kind', 'log_path', 'round_no', 'run_key', 'started_at',
      'status', 'summary', 'task_id',
    ].sort());
  } finally {
    env.close();
  }
});

test('/api/tasks/<id>/dialogue：四类条目 + model 从严（显式 > 首轮日志 ### CMD -m > 默认）', async () => {
  const env = setup();
  try {
    // 第一轮日志带 `### CMD ... -m cli-model`（存量 CLI 轮次日志口径）
    const log1 = writeLog(env, 'task_9_round_1.log',
      `### CMD /usr/bin/agent -m cli-model --flag\n${dialogueLogText()}`);
    const task = addTask(env, env.p1, { model: '' });
    addRound(env, task, 1, log1);
    addRound(env, task, 2, path.join(env.workDir, '.web', '不存在.log'));
    const r = await call(env, `/api/tasks/${task}/dialogue`);
    assert.equal(r.status, 200);
    const body = r.json();
    assert.deepEqual(Object.keys(body), ['task_id', 'model', 'permission', 'entries']);
    assert.equal(body.task_id, task);
    assert.equal(body.model, 'cli-model', 'model 空 ⇒ 取首轮日志的 -m');
    assert.equal(body.permission, 'manual');
    const kinds = body.entries.map((e) => e.kind);
    assert.deepEqual(kinds, ['user', 'user', 'assistant', 'tool_result', 'meta']);
    assert.deepEqual(body.entries[0], { kind: 'user', round: 1, text: { text: '做个任务' } });
    assert.equal(body.entries[1].text, '不是 JSON 的原文', 'PROMPT 后不是 JSON ⇒ 保留原文');
    assert.deepEqual(body.entries[2].tool_calls,
      [{ name: 'bash', args: '{"cmd":"ls"}' }]);
    assert.equal(body.entries[3].tool_call_id, 'call_1');
    assert.equal(body.entries[3].truncated, false);
    assert.deepEqual(body.entries[3].tool_calls, []);
    assert.equal(body.entries[4].text, 'sid-abc');

    // 显式 model 优先于日志
    const t2 = addTask(env, env.p1, { model: 'explicit-m' });
    addRound(env, t2, 1, log1);
    assert.equal((await call(env, `/api/tasks/${t2}/dialogue`)).json().model, 'explicit-m');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ④ 日志端点
// --------------------------------------------------------------------------

test('/api/tasks/<id>/log：分段/全文/负 limit/上限 5000/空文件/轮次不存在', async () => {
  const env = setup();
  try {
    const longText = Array.from({ length: 6000 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const task = addTask(env, env.p1);
    addRound(env, task, 1, writeLog(env, 'long.log', longText));
    addRound(env, task, 2, '');
    addRound(env, task, 3, path.join(env.workDir, '.web', '缺失.log'));

    const full = await call(env, `/api/tasks/${task}/log`, { search: 'round=1&tail=300' });
    assert.equal(full.status, 200);
    assert.deepEqual(Object.keys(full.json()), ['round', 'log']);
    assert.equal(full.json().round, '1', 'round 回显查询串原文（字符串）');
    assert.equal(full.json().log.split('\n').length, 300 + 1, 'tail=300 取末 300 行（末尾含换行 → 多一个空段）');

    const tail5 = await call(env, `/api/tasks/${task}/log`, { search: 'round=1&tail=5' });
    assert.equal(tail5.json().log, 'line5996\nline5997\nline5998\nline5999\nline6000\n');
    const all = await call(env, `/api/tasks/${task}/log`, { search: 'round=1&tail=0' });
    assert.equal(all.json().log, longText, 'tail=0 ⇒ 全文（Python 切片 [-0:])');
    const neg = await call(env, `/api/tasks/${task}/log`, { search: 'round=1&tail=-1' });
    assert.equal(neg.json().log, longText.slice('line1\n'.length), 'tail=-1 ⇒ 丢掉开头 1 行');
    const capped = await call(env, `/api/tasks/${task}/log`, { search: 'round=1&tail=99999' });
    assert.equal(capped.json().log.split('\n').length, 5000 + 1, '上限 5000（min(int, 5000)）');

    // log_path 空 / 文件不存在 ⇒ 200 + 空正文（不是 404）
    for (const round of [2, 3]) {
      const r = await call(env, `/api/tasks/${task}/log`, { search: `round=${round}&tail=300` });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json(), { round: String(round), log: '' });
    }
    // 轮次不存在 ⇒ 404 log not found
    const missing = await call(env, `/api/tasks/${task}/log`, { search: 'round=99' });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json(), { error: 'log not found' });
    // round 非数字/缺省 ⇒ 按 0 查（不抛）
    for (const search of ['', 'round=&tail=5', 'round=abc&tail=5', 'round=-1&tail=5']) {
      const r = await call(env, `/api/tasks/${task}/log`, { search });
      assert.equal(r.status, 404);
      assert.deepEqual(r.json(), { error: 'log not found' });
    }
  } finally {
    env.close();
  }
});

test('/api/tasks/<id>/log：tail 不可解析 ⇒ 掐断连接（复刻 Python int() 抛错），不抛异常', async () => {
  const env = setup();
  try {
    const task = addTask(env, env.p1);
    addRound(env, task, 1, writeLog(env, 'a.log', 'x\n'));
    for (const search of ['round=1&tail=abc', 'round=1&tail=5.0', 'round=1&tail=1e3']) {
      const r = await call(env, `/api/tasks/${task}/log`, { search });
      assert.equal(r.destroyed, true, `${search} 应当掐断连接`);
      assert.equal(r.status, null, '掐断即不回任何响应');
      assert.equal(r.body, null);
    }
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑤ 多用户隔离
// --------------------------------------------------------------------------

test('隔离红线：他人项目的任务一律 404 `task not found`（不回 `project not found`）', async () => {
  const env = setup();
  try {
    const foreign = addTask(env, env.p2, { name: '别人的任务' });
    for (const target of [
      `/api/tasks/${foreign}`,
      `/api/tasks/${foreign}/rounds`,
      `/api/tasks/${foreign}/dialogue`,
    ]) {
      const r = await call(env, target);
      assert.equal(r.status, 404);
      assert.deepEqual(r.json(), { error: 'task not found' }, `${target} 的文案必须与「不存在」一致`);
    }
    const log = await call(env, `/api/tasks/${foreign}/log`, { search: 'round=1' });
    assert.equal(log.status, 404);
    assert.deepEqual(log.json(), { error: 'task not found' });
    // 不存在的任务同文案（不可分辨）
    const ghost = await call(env, '/api/tasks/999999');
    assert.equal(ghost.status, 404);
    assert.deepEqual(ghost.json(), { error: 'task not found' });
    // 他人项目 ⇒ project not found
    const proj = await call(env, `/api/projects/${env.p2}/tasks`);
    assert.equal(proj.status, 404);
    assert.deepEqual(proj.json(), { error: 'project not found' });
    const ghostProj = await call(env, '/api/projects/999999/tasks');
    assert.equal(ghostProj.status, 404);
    assert.deepEqual(ghostProj.json(), { error: 'project not found' });
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑥ 纯函数：readLogTail / readDialogue
// --------------------------------------------------------------------------

test('readLogTail：readlines 口径（尾随换行不多算一行）、limit 0/负/超界、\\r\\n 归一、坏路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tasks-tail-'));
  const nl = path.join(dir, 'nl.log');
  fs.writeFileSync(nl, 'a\nb\nc\n');
  const noNl = path.join(dir, 'nonl.log');
  fs.writeFileSync(noNl, 'a\nb\nc');
  const crlf = path.join(dir, 'crlf.log');
  fs.writeFileSync(crlf, 'a\r\nb\r\n');
  assert.equal(readLogTail(nl, 2), 'b\nc\n', '尾随换行不得少算/多算一行');
  assert.equal(readLogTail(nl, 0), 'a\nb\nc\n');
  assert.equal(readLogTail(nl, -1), 'b\nc\n');
  assert.equal(readLogTail(nl, 99), 'a\nb\nc\n');
  assert.equal(readLogTail(nl), 'a\nb\nc\n', '缺省 limit=200');
  assert.equal(readLogTail(noNl, 2), 'b\nc');
  assert.equal(readLogTail(crlf, 2), 'a\nb\n', 'Python 文本模式 universal newlines');
  assert.equal(readLogTail(path.join(dir, '缺失.log'), 5), '');
  assert.equal(readLogTail(dir, 5), '', '目录不是文件');
  assert.equal(readLogTail('', 5), '');
  assert.equal(readLogTail(null, 5), '');
});

test('readDialogue：坏行跳过、round 按数值序、缺文件跳过、工具结果按 6000 码点截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tasks-dlg-'));
  const emoji = '😀'.repeat(DIALOGUE_TEXT_LIMIT + 10);          // 每个 emoji 是 1 码点 / 2 码元
  const logPath = path.join(dir, 'r.log');
  fs.writeFileSync(logPath, [
    '### PROMPT "提示"',
    `{"role": "tool", "content": "${emoji}"}`,
    `{"role": "tool", "content": "${'x'.repeat(DIALOGUE_TEXT_LIMIT)}"}`,
    '{"role": "assistant"}',
  ].join('\n') + '\n');
  const rounds = [
    { round_no: 2, log_path: logPath },
    { round_no: 1, log_path: path.join(dir, '不存在.log') },
    { round_no: 3, log_path: '' },
  ];
  const entries = readDialogue(rounds);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((e) => e.kind), ['user', 'tool_result', 'tool_result', 'assistant']);
  assert.equal(entries[0].round, 2);
  assert.equal(entries[0].text, '提示');
  assert.equal(entries[1].truncated, true);
  assert.equal(Array.from(entries[1].text).length, DIALOGUE_TEXT_LIMIT,
    '按码点截断（JS 码元口径会只有 3000 个 emoji）');
  assert.equal(entries[2].truncated, false, '恰好等于上限不算截断（Python `len > LIMIT`）');
  assert.equal(entries[3].text, '', 'content 缺失 ⇒ 空串');
  assert.deepEqual(entries[3].tool_calls, []);
});

// --------------------------------------------------------------------------
// ⑦ new_cases 的扫描缓存
// --------------------------------------------------------------------------

test('new_cases：StateCache 复数项目复用同一实例（TTL 内命中同一对象）', async () => {
  const env = setup();
  try {
    const task = addTask(env, env.p1, { cases_base: 0 });
    const cache = new StateCache();
    const first = taskJson({ id: task, project_id: env.p1, cases_base: 0, session_id: '', model: '' },
      { db: env.handle, stateCache: cache });
    assert.equal(first.new_cases, 2);
    const state1 = cache.get(env.p1, env.casesRoot, path.join(env.workDir, 'bug_report'), env.workDir);
    const state2 = cache.get(env.p1, env.casesRoot, path.join(env.workDir, 'bug_report'), env.workDir);
    assert.equal(state1, state2, 'TTL 内返回同一个对象（对齐 StateCache 不变量①）');
    // 新增一个用例后（mtime 变化 + TTL 过期）计数跟上
    const fresh = new StateCache({ ttl: 0 });
    fs.mkdirSync(path.join(env.casesRoot, 'FS0003_gamma'), { recursive: true });
    fs.writeFileSync(path.join(env.casesRoot, 'FS0003_gamma', 'status.md'), '- **状态**: 通过\n');
    assert.equal(taskJson({ id: task, project_id: env.p1, cases_base: 0, session_id: '', model: '' },
      { db: env.handle, stateCache: fresh }).new_cases, 3);
  } finally {
    env.close();
  }
});
