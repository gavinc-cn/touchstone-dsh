/**
 * 任务族写端点单测（M4.5）：`backend/routes/tasks.js` 的 5 条写端点 + `lib/db.js:insertTask`。
 *
 * 测试策略（为什么这么写）：
 *   - **走真路由表**：`routes/index.js` 的 `makeContext` + `dispatch`，分派顺序、`ctx.readBody`
 *     的记忆化、`ctx.ownedProject/ownedTask` 的越权文案都在链路上；
 *   - **真库真文件**：临时库（`m3fixture.freshDb`）+ 真案例库/bug 报告目录，`submit`/`resume`/
 *     `remove`/`stop` 都落到真 `wait_items` 行上（不是打桩计数）；
 *   - **真 Runner，但停闸**：`new Runner(true, {db})` 的执行循环停在启动闸后（永不拾取），
 *     于是「入队/占位/位次/取消」这些队列语义可确定观察，又不会撞上 M4.5 未移植的轮次执行体；
 *   - **期望值来源**：`server.py` 的 `_api_create_task`(2592) / `_api_task_action`(4089) /
 *     `_api_continue_task`(4109) / `_api_delete_task`(4155) / `_api_update_task`(4170) 与
 *     `db.py:insert_task`(1012) 逐行对照（不读 Node 实现反推），关键边界另用真 Python 站点复核。
 *
 * 覆盖的「一字节都不许差」的点：错误体一律紧凑（`ctx.error`）、`{"ok":true}` 是硬编码字面量、
 * `_api_create_task` 的成功体走 `json.dumps`（带空格）、DELETE 不读请求体、`pyStripBare`
 * 复刻的 AttributeError ⇒ 断连接。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as runner from '../lib/runner.js';
import { dispatch, dispatchSafely, makeContext } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/**
 * 造一个「像 IncomingMessage」的请求流。
 * `body === undefined` ⇒ 不带 Content-Length（`readJsonBody` 因此不读流，返回 `{}`）；
 * 给了 body 就同时给头与字节（对象按 JSON 序列化，字符串原样发）。
 */
function fakeReq({ method = 'GET', body = undefined } = {}) {
  const headers = {};
  let chunks = [];
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const buf = Buffer.from(text, 'utf8');
    headers['content-length'] = String(buf.length);
    chunks = [buf];
  }
  const stream = Readable.from(chunks, { objectMode: false });
  stream.headers = headers;
  stream.method = method;
  return stream;
}

/** 假 res：只用到 writeHead/end/destroy（与 `lib/http.js` 的调用面一致） */
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

/** 捕获 `console.log`（`runner.submit` 在项目忙时会打「任务排队等待」诊断行） */
function captureLogs(fn) {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

/** 造环境：临时库 + 两个用户各一个项目 + 真案例库目录 + 停闸 Runner */
function setup({ cases = ['FS0001_alpha', 'FS0002_beta'], projectModel = '' } = {}) {
  const fx = freshDb('task-write');
  const workDir = path.join(fx.dir, 'work');
  const casesRoot = path.join(workDir, 'free_style');
  const bugRoot = path.join(workDir, 'bug_report');
  fs.mkdirSync(casesRoot, { recursive: true });
  fs.mkdirSync(bugRoot, { recursive: true });
  for (const dir of cases) {
    fs.mkdirSync(path.join(casesRoot, dir), { recursive: true });
    fs.writeFileSync(path.join(casesRoot, dir, 'status.md'), '- **状态**: 通过\n');
  }
  const now = '2026-10-12 00:00:00';
  for (const [id, name] of [[101, 'alice'], [102, 'bob']]) {
    fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
      + ' VALUES (?,?,?,?,?,?)').run(id, name, 'x', '', 0, now);
  }
  const p1 = insertProject(fx.db, { userId: 101, name: 'P-alice', workDir });
  const p2 = insertProject(fx.db, { userId: 102, name: 'P-bob', workDir: fx.dir });
  if (projectModel) fx.db.prepare('UPDATE projects SET model=? WHERE id=?').run(projectModel, p1);
  const inst = new runner.Runner(true, { db: fx.db });        // bootGate=true ⇒ 永不拾取
  runner.setInstance(inst);
  return {
    ...fx,
    workDir,
    casesRoot,
    bugRoot,
    p1,
    p2,
    alice: { id: 101, username: 'alice' },
    bob: { id: 102, username: 'bob' },
    inst,
    close() {
      runner.setInstance(null);
      fx.close();
    },
  };
}

/** 发一次请求；`safe=true` 走 `dispatchSafely`（异常 ⇒ 只断连接，不冒到测试） */
async function call(env, target, {
  method = 'GET', body, user, stateCache, safe = false,
} = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq({ method, body }),
    res,
    db: env.db,
    user: user === undefined ? env.alice : user,
    path: target,
    search: '',
    ...(stateCache === undefined ? {} : { stateCache }),
  });
  const hit = safe
    ? await captureLogs(() => dispatchSafely(ctx, { logger: { error: () => {} } }))
    : await captureLogs(() => dispatch(ctx));
  return {
    hit,
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

/** 插一行任务（缺省覆盖「任务行常态」，over 覆盖个案）；返回 id */
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
  const info = env.db.prepare(`INSERT INTO tasks(${keys.join(',')})`
    + ` VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

/** 插一行轮次 */
function addRound(env, taskId, roundNo) {
  env.db.prepare('INSERT INTO rounds(task_id, round_no, status, log_path, started_at)'
    + " VALUES(?,?,'done','',?)").run(taskId, roundNo, '2026-01-01 00:00:00');
}

/** 取任务行 */
function taskRow(env, taskId) {
  return env.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
}

/** 取某任务的等待项行（全部状态，按 id 升序） */
function waitRows(env, taskId) {
  return env.db.prepare("SELECT * FROM wait_items WHERE kind='task' AND target_id=? ORDER BY id")
    .all(String(taskId));
}

/** 造一个 bug 报告目录（`<bug_root>/<name>/bug_report.md`），返回目录名 */
function addBugDir(env, name, reportText = '- 关联用例：FS0001\n- **状态**: 待修复\n') {
  const dir = path.join(env.bugRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bug_report.md'), reportText);
  return name;
}

// --------------------------------------------------------------------------
// ① POST /api/projects/<pid>/tasks —— 普通任务
// --------------------------------------------------------------------------

test('create：普通任务成功 —— 19 列 + 响应体（带空格 json.dumps）+ 真入队行', async () => {
  const env = setup();
  try {
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal', name: '我的任务' },
    });
    assert.equal(r.hit, true);
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
    // 成功体走 json.dumps ⇒ `": "` 带空格；pipeline_id 为 null 也要落到正文里
    assert.equal(r.text(), '{"id": 1, "pipeline_id": null}');
    const row = taskRow(env, 1);
    assert.deepEqual({
      project_id: row.project_id, name: row.name, auto_fix: row.auto_fix, retest: row.retest,
      stop_type: row.stop_type, stop_value: row.stop_value, task_type: row.task_type,
      start_stage: row.start_stage, end_stage: row.end_stage, payload: row.payload,
      extra: row.extra, model: row.model, permission: row.permission,
      auto_commit: row.auto_commit, auto_deploy: row.auto_deploy, auto_retest: row.auto_retest,
      cases_base: row.cases_base, date_from: row.date_from, date_to: row.date_to,
      status: row.status,
    }, {
      project_id: env.p1, name: '我的任务', auto_fix: 0, retest: '不复测',
      stop_type: 'rounds', stop_value: '1', task_type: 'normal',
      start_stage: 'gen_case',                    // STAGE_MATRIX.normal.start
      end_stage: 'report',                        // 缺省终点
      payload: '', extra: '', model: '', permission: '',
      auto_commit: 0, auto_deploy: 0, auto_retest: 0,
      cases_base: 2,                              // 创建时案例库总数（FS0001/FS0002）
      date_from: '', date_to: '', status: 'queued',
    });
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const waits = waitRows(env, 1);
    assert.equal(waits.length, 1);
    assert.equal(waits[0].state, 'waiting');
    assert.equal(waits[0].project_id, env.p1);
  } finally {
    env.close();
  }
});

test('create：项目级模型回落（任务显式 > 项目 > 空串）', async () => {
  const env = setup({ projectModel: 'proj-model' });
  try {
    await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal' },
    });
    assert.equal(taskRow(env, 1).model, 'proj-model', '未显式指定 ⇒ 项目级模型固化进任务行');
    await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal', model: '  task-model  ' },
    });
    assert.equal(taskRow(env, 2).model, 'task-model', '显式指定优先且 strip');
  } finally {
    env.close();
  }
});

test('create：normal 终点在 report 之后 ⇒ 连带 pipeline 后段任务 + 第二次 submit', async () => {
  const env = setup();
  try {
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal', name: '探索A', end_stage: 'fix' },
    });
    assert.equal(r.text(), '{"id": 1, "pipeline_id": 2}');
    const main = taskRow(env, 1);
    assert.equal(main.end_stage, 'fix');
    const pipe = taskRow(env, 2);
    assert.deepEqual({
      project_id: pipe.project_id, name: pipe.name, auto_fix: pipe.auto_fix,
      retest: pipe.retest, stop_type: pipe.stop_type, stop_value: pipe.stop_value,
      task_type: pipe.task_type, start_stage: pipe.start_stage, end_stage: pipe.end_stage,
      payload: pipe.payload, status: pipe.status,
    }, {
      project_id: env.p1, name: '探索A·后段', auto_fix: 0, retest: '不复测',
      stop_type: 'rounds', stop_value: '1', task_type: 'pipeline',
      start_stage: 'analyze', end_stage: 'fix',
      payload: '{"parent_task_id": 1}',           // json.dumps 带空格、键序固定
      status: 'queued',
    });
    const waits = env.db.prepare("SELECT * FROM wait_items WHERE kind='task' ORDER BY seq").all();
    assert.deepEqual(waits.map((w) => [w.target_id, w.state]), [['1', 'waiting'], ['2', 'waiting']]);
  } finally {
    env.close();
  }
});

test('create：终点 = report（或不晚于 report）不连带 pipeline', async () => {
  const env = setup();
  try {
    for (const [i, end] of [['1', undefined], ['2', 'report'], ['3', 'gen_case'], ['4', 'execute']]) {
      const r = await call(env, `/api/projects/${env.p1}/tasks`, {
        method: 'POST', body: { task_type: 'normal', name: `T${i}`, end_stage: end },
      });
      assert.equal(r.json().pipeline_id, null, `end_stage=${end} 不该连带`);
    }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 4);
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ② create：参数校验（错误体一律紧凑字节串）
// --------------------------------------------------------------------------

test('create：非法 task_type / 非法 end_stage / 手工建 pipeline（文案逐字）', async () => {
  const env = setup();
  try {
    const bad = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'nope' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.text(), '{"error":"task_type 非法"}');

    const badEnd = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'fix', end_stage: 'bogus' },
    });
    assert.equal(badEnd.status, 400);
    assert.equal(badEnd.text(), '{"error":"end_stage 非法"}');

    const pipe = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'pipeline' },
    });
    assert.equal(pipe.status, 400);
    assert.equal(pipe.text(),
      '{"error":"pipeline 为平台自动创建的后段任务，不支持手动创建"}');

    // 只读类型（stress/reject/...）的 ends 为空 ⇒ end_stage 传什么都不校验
    const stress = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'stress', end_stage: 'bogus' },
    });
    assert.equal(stress.status, 200, 'stress 不做终点校验（STAGE_MATRIX.ends 为空）');
    assert.equal(taskRow(env, stress.json().id).end_stage, '');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, '失败分支不落行');
  } finally {
    env.close();
  }
});

test('create：stress 覆写 payload/停止条件；name 缺省 = `压测 <now_str>`', async () => {
  const env = setup();
  try {
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST',
      body: { task_type: 'stress', brief: '  压一下登录  ', stop_type: 'bugs', stop_value: '9' },
    });
    assert.equal(r.status, 200);
    const row = taskRow(env, r.json().id);
    assert.equal(row.payload, '{"brief": "压一下登录"}');
    assert.equal(row.stop_type, 'rounds', '压测固定 1 轮 agent');
    assert.equal(row.stop_value, '1');
    assert.match(row.name, /^压测 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(row.start_stage, '');
  } finally {
    env.close();
  }
});

test('create：regression 必填 extra；name 缺省 = `回归 <now_str>`', async () => {
  const env = setup();
  try {
    const bad = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'regression' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.text(), '{"error":"请填写重跑指令"}');
    const blank = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'regression', extra: '   ' },
    });
    assert.equal(blank.status, 400, '空白 extra 等同没填（Python .strip() 后判空）');

    const ok = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'regression', extra: '重跑登录' },
    });
    const row = taskRow(env, ok.json().id);
    assert.equal(row.extra, '重跑登录');
    assert.equal(row.start_stage, 'execute');
    assert.equal(row.end_stage, 'report');
    assert.match(row.name, /^回归 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  } finally {
    env.close();
  }
});

test('create：日期范围校验（格式 / 反向 / 双侧日历校验 / 单侧放行）', async () => {
  const env = setup();
  try {
    // 400 组：格式不符、反向、双侧时的日历越界（= Python `time.strptime` 的 ValueError）
    for (const body of [
      { task_type: 'normal', date_from: '2026-1-1' },
      { task_type: 'normal', date_to: '20260101' },
      { task_type: 'normal', date_from: '2026-02-02', date_to: '2026-02-01' },
      { task_type: 'normal', date_from: '2026-13-01', date_to: '2026-12-31' },
      { task_type: 'normal', date_from: '2026-01-01', date_to: '2026-02-30' },
      { task_type: 'normal', date_from: '0000-01-01', date_to: '2026-01-01' },
      { task_type: 'normal', date_from: '2023-02-29', date_to: '2026-01-01' },
      { task_type: 'normal', date_from: '٢٠٢٦-٠١-٠١', date_to: '2026-01-01' },
    ]) {
      const r = await call(env, `/api/projects/${env.p1}/tasks`, { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.text(), '{"error":"日期范围非法"}');
    }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, '失败不落行');

    // 200 组：**单侧**日期只过格式正则，不做日历校验（Python 的 strptime 只在双侧调用）
    const cases = [
      ['2026-13-01', ''],                     // 越界月：单侧放行
      ['٢٠٢٦-٠١-٠١', ''],                     // Unicode Nd 数字：单侧放行（正则 \d 是 Unicode 面）
      ['2024-02-29', '2024-03-01'],           // 闰年合法
    ];
    for (const [from, to] of cases) {
      const r = await call(env, `/api/projects/${env.p1}/tasks`, {
        method: 'POST', body: { task_type: 'normal', date_from: from, date_to: to },
      });
      assert.equal(r.status, 200, `${from}..${to}`);
      const row = taskRow(env, r.json().id);
      assert.equal(row.date_from, from, '原样落库（不归一）');
      assert.equal(row.date_to, to);
    }
  } finally {
    env.close();
  }
});

test('create：stop_type 非法 ⇒ 400（且早于 stress 覆写）', async () => {
  const env = setup();
  try {
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal', stop_type: 'forever' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.text(), '{"error":"stop_type 非法"}');
  } finally {
    env.close();
  }
});

test('create：不可哈希的 task_type ⇒ 断连接（复刻 Python set 成员判定的 TypeError）', async () => {
  const env = setup();
  try {
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: ['normal'] },
    });
    assert.equal(r.destroyed, true);
    assert.equal(r.status, null, '掐断即不回任何响应');
  } finally {
    env.close();
  }
});

test('create：真值非字符串的 bug_dir/name/reason ⇒ AttributeError ⇒ 断连接', async () => {
  const env = setup();
  addBugDir(env, '20260101_0000_FS_x');
  try {
    for (const body of [
      { task_type: 'fix', bug_dir: 123 },
      { task_type: 'reject', bug_dir: '20260101_0000_FS_x', reason: 7 },
      { task_type: 'normal', name: { a: 1 } },
    ]) {
      const r = await call(env, `/api/projects/${env.p1}/tasks`, { method: 'POST', body, safe: true });
      assert.equal(r.destroyed, true, JSON.stringify(body));
      assert.equal(r.status, null);
    }
    // 假值非字符串走 `or ""` 短路：0/false/null 都不抛（Python 的 `x or ""` 同）
    const zero = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'fix', bug_dir: '' },
    });
    assert.equal(zero.status, 400, '空 bug_dir ⇒ 目录不存在（不是断连接）');
    assert.equal(zero.text(), '{"error":"bug 报告目录不存在"}');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ③ create：bug 报告绑定 / 命名 / 复测选型
// --------------------------------------------------------------------------

test('create：fix 绑定 bug 报告（payload/命名/部署推导）', async () => {
  const env = setup();
  addBugDir(env, '20260101_0000_FS_login_fail');
  try {
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'fix', bug_dir: '/20260101_0000_FS_login_fail/' },
    });
    const row = taskRow(env, r.json().id);
    assert.equal(row.payload, '{"bug_dir": "20260101_0000_FS_login_fail"}', 'bugs_dir 两端 / 被 strip');
    assert.equal(row.name, '修复 FS_login_fail', 'BUG_DIR_RE 取时间戳之后的部分');
    assert.equal(row.start_stage, 'analyze');
    assert.equal(row.end_stage, 'fix');
    assert.equal(row.auto_deploy, 0, '终点 fix ⇒ 不部署');
    assert.equal(row.auto_retest, 0);

    const dep = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'fix', bug_dir: '20260101_0000_FS_login_fail', end_stage: 'retest' },
    });
    const depRow = taskRow(env, dep.json().id);
    assert.equal(depRow.auto_deploy, 1, '终点 retest ⇒ 需要部署');
    assert.equal(depRow.auto_retest, 0);
    assert.equal(depRow.end_stage, 'retest');
  } finally {
    env.close();
  }
});

test('create：bug 报告目录不存在 / reject 缺理由 ⇒ 400；目录名不匹配 BUG_DIR_RE 时用原串', async () => {
  const env = setup();
  addBugDir(env, 'no_timestamp_dir');
  try {
    const missing = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'fix', bug_dir: '20260101_0000_FS_ghost' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.text(), '{"error":"bug 报告目录不存在"}');

    const noDir = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'reject' },
    });
    assert.equal(noDir.text(), '{"error":"bug 报告目录不存在"}');

    const noReason = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'reject', bug_dir: 'no_timestamp_dir' },
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.text(), '{"error":"请填写拒绝理由"}');

    const ok = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST',
      body: { task_type: 'reject', bug_dir: 'no_timestamp_dir', reason: '  误报  ' },
    });
    const row = taskRow(env, ok.json().id);
    assert.equal(row.payload, '{"bug_dir": "no_timestamp_dir", "reason": "误报"}');
    assert.equal(row.name, '修例 no_timestamp_dir', '不匹配 BUG_DIR_RE ⇒ 用目录原串');

    // 显式 name 优先于前缀推导
    const named = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST',
      body: { task_type: 'fix', bug_dir: 'no_timestamp_dir', name: '  自定义  ' },
    });
    assert.equal(taskRow(env, named.json().id).name, '自定义');
  } finally {
    env.close();
  }
});

test('create：retest_bug 的三种 retest_scope 与「带日期范围可不绑报告」', async () => {
  const env = setup();
  addBugDir(env, '20260101_0000_FS_r');
  try {
    const scopes = {
      retest_only: ['retest', 'retest'],
      deploy_retest: ['deploy', 'retest'],
      deploy_only: ['deploy', 'deploy'],
    };
    let i = 1;
    for (const [scope, [start, end]] of Object.entries(scopes)) {
      const r = await call(env, `/api/projects/${env.p1}/tasks`, {
        method: 'POST', body: { task_type: 'retest_bug', bug_dir: '20260101_0000_FS_r', retest_scope: scope },
      });
      const row = taskRow(env, r.json().id);
      assert.equal(row.start_stage, start, scope);
      assert.equal(row.end_stage, end, scope);
      assert.equal(row.name, '复测 FS_r');
      i += 1;
    }
    assert.equal(i, 4);

    const bad = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'retest_bug', retest_scope: 'nope' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.text(), '{"error":"retest_scope 非法"}');

    // 日期范围复测：无报告也可建（name 用日期范围拼）
    const ranged = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST',
      body: { task_type: 'retest_bug', date_from: '2026-01-01', date_to: '2026-02-01' },
    });
    const row = taskRow(env, ranged.json().id);
    assert.equal(row.payload, '');
    assert.equal(row.name, '复测 2026-01-01..2026-02-01');
    assert.equal(row.date_from, '2026-01-01');
    assert.equal(row.date_to, '2026-02-01');
    assert.equal(row.start_stage, 'retest');

    // 只有单侧日期也走「不绑报告」分支（Python `(date_from or date_to)`）
    const half = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'retest_bug', date_from: '2026-03-01' },
    });
    assert.equal(taskRow(env, half.json().id).name, '复测 2026-03-01..现在');
  } finally {
    env.close();
  }
});

test('create：retest_only 且关联用例全固化 ⇒ 自动改走 script_retest', async () => {
  const env = setup();
  addBugDir(env, '20260101_0000_FS_sel', '- 关联用例：FS0001\n');
  try {
    // FS0001 未固化（无 verify.py）⇒ 保持 retest_bug
    const plain = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'retest_bug', bug_dir: '20260101_0000_FS_sel' },
    });
    assert.equal(taskRow(env, plain.json().id).task_type, 'retest_bug');
    assert.equal(taskRow(env, plain.json().id).name, '复测 FS_sel');

    // 固化后 ⇒ script_retest（命名前缀随之变成「脚本复测 」）
    fs.writeFileSync(path.join(env.casesRoot, 'FS0001_alpha', 'verify.py'), 'pass\n');
    const scripted = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'retest_bug', bug_dir: '20260101_0000_FS_sel' },
    });
    const row = taskRow(env, scripted.json().id);
    assert.equal(row.task_type, 'script_retest');
    assert.equal(row.name, '脚本复测 FS_sel');
    assert.equal(row.payload, '{"bug_dir": "20260101_0000_FS_sel"}');

    // 用例 id 定位不到目录（报告里写了 FS9999）⇒ 不固化
    addBugDir(env, '20260101_0000_FS_ghost', '- 关联用例：FS9999\n');
    const ghost = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'retest_bug', bug_dir: '20260101_0000_FS_ghost' },
    });
    assert.equal(taskRow(env, ghost.json().id).task_type, 'retest_bug');

    // 非 retest_only 范围不选型（部署要 agent 执行）
    const dep = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST',
      body: { task_type: 'retest_bug', bug_dir: '20260101_0000_FS_sel', retest_scope: 'deploy_retest' },
    });
    assert.equal(taskRow(env, dep.json().id).task_type, 'retest_bug');
  } finally {
    env.close();
  }
});

test('create：cases_base 取值 —— 扫描异常按 0（Python 的 try/except 必须保留）', async () => {
  const env = setup();
  try {
    const throwing = { get() { throw new Error('scan boom'); } };
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal' }, stateCache: throwing,
    });
    assert.equal(r.status, 200, '扫描异常不该让建任务失败');
    assert.equal(taskRow(env, r.json().id).cases_base, 0);
  } finally {
    env.close();
  }
});

test('create：越权/不存在的项目一律 404 project not found 且不落行', async () => {
  const env = setup();
  try {
    for (const [target, user] of [
      [`/api/projects/${env.p2}/tasks`, env.alice],
      ['/api/projects/999999/tasks', env.alice],
    ]) {
      const r = await call(env, target, { method: 'POST', body: { task_type: 'normal' }, user });
      assert.equal(r.status, 404);
      assert.equal(r.text(), '{"error":"project not found"}');
    }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM wait_items').get().n, 0);
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ④ POST /api/tasks/<id>/(stop|restart)
// --------------------------------------------------------------------------

test('stop：排队中 ⇒ 取消等待行 + stopped + ended_at', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { name: '排队的', status: 'queued' });
    env.db.prepare("INSERT INTO wait_items(project_id, kind, target_id, state, seq, created_at)"
      + " VALUES(?,?,?,'waiting',1,?)").run(env.p1, 'task', String(tid), '2026-01-01 00:00:00');
    const r = await call(env, `/api/tasks/${tid}/stop`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok":true}', '成功体是硬编码紧凑字节串');
    const row = taskRow(env, tid);
    assert.equal(row.status, 'stopped');
    assert.match(row.ended_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const waits = waitRows(env, tid);
    assert.equal(waits[0].state, 'cancelled');
    assert.match(waits[0].meta, /"cancel_reason": "用户停止"/);
  } finally {
    env.close();
  }
});

test('stop：运行中 ⇒ 只登记停止请求（行态与任务态留给轮边界收口）', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { name: '跑着的', status: 'running' });
    env.db.prepare("INSERT INTO wait_items(project_id, kind, target_id, state, seq, created_at)"
      + " VALUES(?,?,?,'running',1,?)").run(env.p1, 'task', String(tid), '2026-01-01 00:00:00');
    const r = await call(env, `/api/tasks/${tid}/stop`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(taskRow(env, tid).status, 'running', '运行中任务不在这里落终态');
    assert.equal(waitRows(env, tid)[0].state, 'running', 'starting/running 行不被 cancel');
  } finally {
    env.close();
  }
});

test('restart：running/queued ⇒ 400 同款文案；终态任务 ⇒ 清轮次重排队', async () => {
  const env = setup();
  try {
    const running = addTask(env, env.p1, { status: 'running' });
    const queued = addTask(env, env.p1, { status: 'queued' });
    for (const tid of [running, queued]) {
      const r = await call(env, `/api/tasks/${tid}/restart`, { method: 'POST' });
      assert.equal(r.status, 400);
      assert.equal(r.text(), '{"error":"任务运行中或排队中，请先停止"}');
    }
    const done = addTask(env, env.p1, {
      status: 'failed', current_round: 3, new_bugs: 2, error: '炸了',
      ended_at: '2026-01-02 00:00:00', session_id: 'sid-x',
    });
    addRound(env, done, 1);
    addRound(env, done, 2);
    const r = await call(env, `/api/tasks/${done}/restart`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok":true}');
    const row = taskRow(env, done);
    assert.equal(row.status, 'queued');
    assert.equal(row.current_round, 0);
    assert.equal(row.new_bugs, 0);
    assert.equal(row.error, '');
    assert.equal(row.ended_at, null);
    assert.equal(row.session_id, 'sid-x', 'restart 不换会话');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE task_id=?')
      .get(done).n, 0, '轮次记录清空');
    assert.equal(waitRows(env, done)[0].state, 'waiting');
  } finally {
    env.close();
  }
});

test('stop/restart：任务不存在 / 越权 ⇒ 404 task not found', async () => {
  const env = setup();
  try {
    const foreign = addTask(env, env.p2, { status: 'queued' });
    for (const target of [`/api/tasks/${foreign}/stop`, `/api/tasks/${foreign}/restart`,
      '/api/tasks/999999/stop']) {
      const r = await call(env, target, { method: 'POST' });
      assert.equal(r.status, 404, target);
      assert.equal(r.text(), '{"error":"task not found"}');
    }
    // 非 stop|restart 的动作不命中本端点（落到调用方的 404）
    const other = await call(env, `/api/tasks/${foreign}/pause`, { method: 'POST' });
    assert.equal(other.hit, false);
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑤ POST /api/tasks/<id>/continue
// --------------------------------------------------------------------------

test('continue：stress / pipeline 不支持；running/queued 先停', async () => {
  const env = setup();
  try {
    const stress = addTask(env, env.p1, { task_type: 'stress' });
    const pipe = addTask(env, env.p1, { task_type: 'pipeline' });
    for (const tid of [stress, pipe]) {
      const r = await call(env, `/api/tasks/${tid}/continue`, { method: 'POST' });
      assert.equal(r.status, 400);
      assert.equal(r.text(), '{"error":"该任务类型不支持继续（重启可从第一轮重跑）"}');
    }
    for (const status of ['running', 'queued']) {
      const tid = addTask(env, env.p1, { status });
      const r = await call(env, `/api/tasks/${tid}/continue`, { method: 'POST' });
      assert.equal(r.status, 400);
      assert.equal(r.text(), '{"error":"任务运行中或排队中，请先停止"}');
    }
  } finally {
    env.close();
  }
});

test('continue：rounds/bugs 折算绝对值（含 int("1_0")/空白/null 边界）', async () => {
  const env = setup();
  try {
    const rounds = addTask(env, env.p1, { status: 'done', current_round: 2, stop_value: '2' });
    // 每次 continue 成功后任务变 queued（再 continue 会撞「先停止」门禁），
    // 故每轮之间把它按「又跑完了」复位 —— 这也顺带钉住门禁本身。
    const finishAgain = () => env.db.prepare("UPDATE tasks SET status='done' WHERE id=?")
      .run(rounds);
    const r1 = await call(env, `/api/tasks/${rounds}/continue`, { method: 'POST', body: {} });
    assert.equal(r1.status, 200);
    assert.equal(taskRow(env, rounds).stop_value, '4', '2（当前轮）+ 2（行内 stop_value）');
    finishAgain();
    const r2 = await call(env, `/api/tasks/${rounds}/continue`, {
      method: 'POST', body: { stop_value: '  3  ' },
    });
    assert.equal(r2.status, 200);
    assert.equal(taskRow(env, rounds).stop_value, '5', '2 + 3（strip 后仍可解析）');
    finishAgain();
    const r3 = await call(env, `/api/tasks/${rounds}/continue`, {
      method: 'POST', body: { stop_value: '1_0' },
    });
    assert.equal(r3.status, 200);
    assert.equal(taskRow(env, rounds).stop_value, '12', 'Python int("1_0")==10');
    finishAgain();
    const r4 = await call(env, `/api/tasks/${rounds}/continue`, {
      method: 'POST', body: { stop_value: null },
    });
    assert.equal(r4.status, 200);
    assert.equal(taskRow(env, rounds).stop_value, '3', 'null ⇒ `or ""` ⇒ 按缺省 1 折算');

    const bugs = addTask(env, env.p1, { status: 'done', new_bugs: 4, stop_type: 'bugs' });
    const rb = await call(env, `/api/tasks/${bugs}/continue`, {
      method: 'POST', body: { stop_value: '2' },
    });
    assert.equal(rb.status, 200);
    assert.equal(taskRow(env, bugs).stop_value, '6');

    // deadline/duration 是绝对语义，直接透传（不做 int()）
    const dl = addTask(env, env.p1, { status: 'done', stop_type: 'deadline', stop_value: 'x' });
    const rd = await call(env, `/api/tasks/${dl}/continue`, {
      method: 'POST', body: { stop_value: '  2026-12-31 23:59  ' },
    });
    assert.equal(rd.status, 200);
    assert.equal(taskRow(env, dl).stop_value, '2026-12-31 23:59');
  } finally {
    env.close();
  }
});

test('continue：stop_type 非法 / stop_value 不可解析 ⇒ 400；body 可只带 stop_type', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { status: 'done', current_round: 1 });
    const badType = await call(env, `/api/tasks/${tid}/continue`, {
      method: 'POST', body: { stop_type: 'nope' },
    });
    assert.equal(badType.status, 400);
    assert.equal(badType.text(), '{"error":"stop_type 非法"}');

    const badValue = await call(env, `/api/tasks/${tid}/continue`, {
      method: 'POST', body: { stop_value: 'abc' },
    });
    assert.equal(badValue.status, 400);
    assert.equal(badValue.text(), '{"error":"stop_value 非法"}');
    assert.equal(taskRow(env, tid).status, 'done', '失败分支不改行');

    // 只传 stop_type=bugs ⇒ stop_value 回落行内值（默认 '1'）
    const onlyType = await call(env, `/api/tasks/${tid}/continue`, {
      method: 'POST', body: { stop_type: 'bugs' },
    });
    assert.equal(onlyType.status, 200);
    assert.equal(taskRow(env, tid).stop_value, '1', 'new_bugs=0 + 行内 stop_value(1)');
  } finally {
    env.close();
  }
});

test('continue：字段更新（name/auto_fix/retest/extra/fresh_prompt）+ 真续跑入队', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, {
      status: 'stopped', name: '老名字', retest: '复测', extra: '老要求', auto_fix: 0,
      current_round: 5, session_id: 'sid-keep',
    });
    const r = await call(env, `/api/tasks/${tid}/continue`, {
      method: 'POST',
      body: { name: '  新名字 ', auto_fix: 1, retest: '不复测', extra: '新要求', stop_value: '2' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok":true}');
    const row = taskRow(env, tid);
    assert.equal(row.name, '新名字');
    assert.equal(row.auto_fix, 1);
    assert.equal(row.retest, '不复测');
    assert.equal(row.extra, '新要求');
    assert.equal(row.fresh_prompt, 1, '续跑下一轮用完整首轮提示词');
    assert.equal(row.stop_value, '7', '5 + 2');
    assert.equal(row.current_round, 5, '轮次计数保留');
    assert.equal(row.session_id, 'sid-keep', '会话保留');
    assert.equal(row.status, 'queued', 'resume 置 queued');
    assert.equal(row.ended_at, null);
    assert.equal(waitRows(env, tid)[0].state, 'waiting');

    // 缺省回落行内值；`name` 给空白 ⇒ 用行内 name
    const tid2 = addTask(env, env.p1, {
      status: 'stopped', name: '行内名', retest: '复测', extra: '行内要求', current_round: 1,
    });
    await call(env, `/api/tasks/${tid2}/continue`, { method: 'POST', body: { name: '   ' } });
    const row2 = taskRow(env, tid2);
    assert.equal(row2.name, '行内名');
    assert.equal(row2.retest, '复测');
    assert.equal(row2.extra, '行内要求');
    assert.equal(row2.stop_value, '2', '1 + 1');
    assert.equal(row2.auto_fix, 0);
  } finally {
    env.close();
  }
});

test('continue：越权/不存在 ⇒ 404', async () => {
  const env = setup();
  try {
    const foreign = addTask(env, env.p2, { status: 'done' });
    const r = await call(env, `/api/tasks/${foreign}/continue`, { method: 'POST' });
    assert.equal(r.status, 404);
    assert.equal(r.text(), '{"error":"task not found"}');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑥ PATCH /api/tasks/<id>
// --------------------------------------------------------------------------

test('PATCH：八个字段一次全改（含 auto_* 真值口径与空串语义）', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { model: 'old-m', permission: 'manual', extra: 'old' });
    const r = await call(env, `/api/tasks/${tid}`, {
      method: 'PATCH',
      body: {
        model: ' new-m ', permission: 'yolo', auto_commit: 1, auto_deploy: 'yes',
        auto_retest: 0, extra: '新要求', start_stage: 'analyze', end_stage: 'retest',
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok":true}');
    const row = taskRow(env, tid);
    assert.equal(row.model, 'new-m');
    assert.equal(row.permission, 'yolo');
    assert.equal(row.auto_commit, 1);
    assert.equal(row.auto_deploy, 1, '字符串 "yes" 在 Python 里是真值');
    assert.equal(row.auto_retest, 0);
    assert.equal(row.extra, '新要求');
    assert.equal(row.start_stage, 'analyze');
    assert.equal(row.end_stage, 'retest');
  } finally {
    env.close();
  }
});

test('PATCH：Python 真值/str 边界（[]/{}/null/0）', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { model: 'old', permission: 'manual', auto_commit: 1 });
    await call(env, `/api/tasks/${tid}`, {
      method: 'PATCH',
      body: { model: null, permission: [], auto_commit: [], auto_deploy: {}, auto_retest: '' },
    });
    const row = taskRow(env, tid);
    assert.equal(row.model, '', 'str(None or "") ⇒ 空串');
    assert.equal(row.permission, '', 'str([] or "") ⇒ 空串（Python 空 list 为假）');
    assert.equal(row.auto_commit, 0, 'bool([]) ⇒ False');
    assert.equal(row.auto_deploy, 0, 'bool({}) ⇒ False');
    assert.equal(row.auto_retest, 0, 'bool("") ⇒ False');
  } finally {
    env.close();
  }
});

test('PATCH：空 body / 全未知字段 ⇒ 200 且一行都不改', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { name: '原样', model: 'keep', extra: 'keep' });
    const before = { ...taskRow(env, tid) };
    for (const body of [{}, { unknown: 'x' }, { task_type: 'stress', status: 'done' }]) {
      const r = await call(env, `/api/tasks/${tid}`, { method: 'PATCH', body });
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(r.text(), '{"ok":true}');
    }
    assert.deepEqual({ ...taskRow(env, tid) }, before, '白名单外字段静默忽略、空字段集不发 UPDATE');
  } finally {
    env.close();
  }
});

test('PATCH：start_stage/end_stage 非法 ⇒ 400 且同请求内的其它字段也不生效', async () => {
  const env = setup();
  try {
    const tid = addTask(env, env.p1, { model: 'old', start_stage: 'analyze' });
    const badStart = await call(env, `/api/tasks/${tid}`, {
      method: 'PATCH', body: { model: 'new', start_stage: 'nope' },
    });
    assert.equal(badStart.status, 400);
    assert.equal(badStart.text(), '{"error":"start_stage 非法"}');
    assert.equal(taskRow(env, tid).model, 'old', '400 前不落任何字段');

    const badEnd = await call(env, `/api/tasks/${tid}`, {
      method: 'PATCH', body: { end_stage: 'nope' },
    });
    assert.equal(badEnd.status, 400);
    assert.equal(badEnd.text(), '{"error":"end_stage 非法"}');

    // 空串是合法的「不涉及阶段」（Python `if val and val not in STAGES`）
    const blank = await call(env, `/api/tasks/${tid}`, {
      method: 'PATCH', body: { start_stage: '', end_stage: 'report' },
    });
    assert.equal(blank.status, 200);
    assert.equal(taskRow(env, tid).start_stage, '');
    assert.equal(taskRow(env, tid).end_stage, 'report');
  } finally {
    env.close();
  }
});

test('PATCH：越权/不存在 ⇒ 404', async () => {
  const env = setup();
  try {
    const foreign = addTask(env, env.p2, {});
    const r = await call(env, `/api/tasks/${foreign}`, { method: 'PATCH', body: { model: 'x' } });
    assert.equal(r.status, 404);
    assert.equal(r.text(), '{"error":"task not found"}');
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑦ DELETE /api/tasks/<id>
// --------------------------------------------------------------------------

test('DELETE：running ⇒ 400；queued ⇒ 取消等待行并删任务与轮次', async () => {
  const env = setup();
  try {
    const running = addTask(env, env.p1, { status: 'running' });
    const r0 = await call(env, `/api/tasks/${running}`, { method: 'DELETE' });
    assert.equal(r0.status, 400);
    assert.equal(r0.text(), '{"error":"任务运行中，请先停止再删除"}');
    assert.notEqual(taskRow(env, running), undefined, '运行中的行必须还在');

    const queued = addTask(env, env.p1, { status: 'queued' });
    addRound(env, queued, 1);
    env.db.prepare("INSERT INTO wait_items(project_id, kind, target_id, state, seq, created_at)"
      + " VALUES(?,?,?,'waiting',1,?)").run(env.p1, 'task', String(queued), '2026-01-01 00:00:00');
    const r1 = await call(env, `/api/tasks/${queued}`, { method: 'DELETE' });
    assert.equal(r1.status, 200);
    assert.equal(r1.text(), '{"ok":true}');
    assert.equal(taskRow(env, queued), undefined);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE task_id=?')
      .get(queued).n, 0);
    const waits = waitRows(env, queued);
    assert.equal(waits.length, 1, '等待行不删、落终态');
    assert.equal(waits[0].state, 'cancelled');
    assert.match(waits[0].meta, /"cancel_reason": "任务删除"/);
  } finally {
    env.close();
  }
});

test('DELETE：终态任务（无等待行）也删得掉；越权/不存在 ⇒ 404', async () => {
  const env = setup();
  try {
    const done = addTask(env, env.p1, { status: 'done' });
    const r = await call(env, `/api/tasks/${done}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(taskRow(env, done), undefined);

    const foreign = addTask(env, env.p2, { status: 'queued' });
    const r2 = await call(env, `/api/tasks/${foreign}`, { method: 'DELETE' });
    assert.equal(r2.status, 404);
    assert.equal(r2.text(), '{"error":"task not found"}');
    assert.notEqual(taskRow(env, foreign), undefined);
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑧ db.insertTask —— 与 db.py:insert_task(1012) 逐点对齐
// --------------------------------------------------------------------------

test('db.insertTask：20 字段 + now_str 落库、缺省值、返回值是 number', () => {
  const env = setup();
  try {
    const id = db.insertTask(env.p1, {
      name: 't', autoFix: 1, retest: '复测', stopType: 'bugs', stopValue: '9',
      taskType: 'fix', payload: '{"a": 1}', extra: 'e', model: 'm', permission: 'yolo',
      autoCommit: 1, autoDeploy: 1, autoRetest: 1, casesBase: 3,
      startStage: 'analyze', endStage: 'fix', dateFrom: '2026-01-01', dateTo: '2026-02-01',
    }, { db: env.db });
    assert.equal(typeof id, 'number');
    const row = taskRow(env, id);
    assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'created_at' && k !== 'id')), {
      project_id: env.p1, name: 't', auto_fix: 1, retest: '复测', stop_type: 'bugs',
      stop_value: '9', task_type: 'fix', start_stage: 'analyze', end_stage: 'fix',
      payload: '{"a": 1}', extra: 'e', status: 'queued', session_id: '', model: 'm',
      permission: 'yolo', auto_commit: 1, auto_deploy: 1, auto_retest: 1, cases_base: 3,
      fresh_prompt: 0, current_round: 0, new_bugs: 0, date_from: '2026-01-01',
      date_to: '2026-02-01', load_rerun: 0, lang: 'zh', started_at: null, ended_at: null,
      error: '',
    });
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 缺省：task_type='normal'、其余文本空串、auto_* = 0、cases_base = 0
    // 注意 retest/stop_type/stop_value 在 db.py 里**没有缺省**（必填位置参数），这里同
    const base = { retest: '不复测', stopType: 'rounds', stopValue: '1' };
    const id2 = db.insertTask(env.p1, { name: 'n2', ...base }, { db: env.db });
    const row2 = taskRow(env, id2);
    assert.equal(row2.task_type, 'normal');
    assert.equal(row2.payload, '');
    assert.equal(row2.start_stage, '');
    assert.equal(row2.cases_base, 0);
    assert.equal(row2.lang, 'zh', 'T13：lang 缺省 zh（与 db.py:insert_task 同缺省）');
    // 显式 lang 原样落库（创建冻结口由调用点负责传已解析的请求语言）
    assert.equal(taskRow(env, db.insertTask(env.p1,
      { name: 'n2-en', lang: 'en', ...base }, { db: env.db })).lang, 'en');

    // int(cases_base or 0)：''/None/[] ⇒ 0；数字串按 int() 解析
    for (const [name, casesBase] of [['n3', ''], ['n4', []], ['n4b', null]]) {
      assert.equal(taskRow(env, db.insertTask(env.p1, { name, casesBase, ...base },
        { db: env.db })).cases_base, 0, `cases_base=${JSON.stringify(casesBase)}`);
    }
    assert.equal(taskRow(env, db.insertTask(env.p1, { name: 'n5', casesBase: '1_2', ...base },
      { db: env.db })).cases_base, 12);
    assert.throws(() => db.insertTask(env.p1, { name: 'n6', casesBase: 'abc', ...base },
      { db: env.db }), /invalid literal for int\(50\)|invalid literal for int/, '非法 cases_base 抛错（= Python ValueError）');
    // retest/stop_type/stop_value 必填：缺了就是 NOT NULL 违例（Python 是 TypeError，两者都响亮）
    assert.throws(() => db.insertTask(env.p1, { name: 'n7' }, { db: env.db }), /NOT NULL/);
  } finally {
    env.close();
  }
});

// --------------------------------------------------------------------------
// ⑨ 读体的位置口径（POST/PATCH 读、DELETE 不读）
// --------------------------------------------------------------------------

test('读体口径：POST 带无法解析的 Content-Length ⇒ 掐断；DELETE 根本不读体', async () => {
  const env = setup();
  try {
    // 正常 Content-Length：照常走通（对照组）
    const tid0 = addTask(env, env.p1, { status: 'done' });
    const ok = await call(env, `/api/tasks/${tid0}/stop`, { method: 'POST', body: { a: 1 } });
    assert.equal(ok.status, 200, '正常 Content-Length 当然没问题');

    const { res, cap } = fakeRes();
    const req = fakeReq({ method: 'POST', body: '{"a":1}' });
    req.headers['content-length'] = 'abc';
    const ctx = makeContext({
      req, res, db: env.db, user: env.alice, path: '/api/tasks/1/stop', search: '',
    });
    const hit = await captureLogs(() => dispatchSafely(ctx, { logger: { error: () => {} } }));
    assert.equal(hit, true);
    assert.equal(cap.destroyed, true);
    assert.equal(cap.status, null);

    // DELETE 不读体：带一个「坏 Content-Length」也照常 200（Python do_DELETE 不读体）
    const tid = addTask(env, env.p1, { status: 'done' });
    const { res: res2, cap: cap2 } = fakeRes();
    const req2 = fakeReq({ method: 'DELETE' });
    req2.headers['content-length'] = 'abc';
    const ctx2 = makeContext({
      req: req2, res: res2, db: env.db, user: env.alice, path: `/api/tasks/${tid}`, search: '',
    });
    await captureLogs(() => dispatch(ctx2));
    assert.equal(cap2.status, 200);
    assert.equal(cap2.body.toString('utf8'), '{"ok":true}');
  } finally {
    env.close();
  }
});

test('runner.INSTANCE 为 null ⇒ 不静默 no-op（抛给 dispatchSafely，只断这一条连接）', async () => {
  const env = setup();
  try {
    runner.setInstance(null);
    const r = await call(env, `/api/projects/${env.p1}/tasks`, {
      method: 'POST', body: { task_type: 'normal' }, safe: true,
    });
    assert.equal(r.destroyed, true);
    assert.equal(r.status, null);
    // 任务行已经落库（Python 的写序：insert 之后才 submit）
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  } finally {
    env.close();
  }
});

test('load/rerun：非压测/运行中 ⇒ 400 紧凑字节（两处 ctx.text→ctx.error 转换不改形状）', async () => {
  const env = setup();
  try {
    const normal = addTask(env, env.p1, { task_type: 'normal' });
    const notStress = await call(env, `/api/tasks/${normal}/load/rerun`,
      { method: 'POST' });
    assert.equal(notStress.status, 400);
    assert.equal(notStress.text(), '{"error":"仅压测任务支持复压"}');

    const stress = addTask(env, env.p1, { task_type: 'stress', status: 'running' });
    const busy = await call(env, `/api/tasks/${stress}/load/rerun`, { method: 'POST' });
    assert.equal(busy.status, 400);
    assert.equal(busy.text(), '{"error":"任务运行中或排队中，请先停止"}');
  } finally {
    env.close();
  }
});
