/**
 * 项目写族单测（M6.9）：`POST /api/projects`、`PATCH|DELETE /api/projects/<id>`、
 * `POST /api/projects/<id>/(archive|unarchive)`、`POST /api/prefs`、`POST /api/fs/mkdir`。
 *
 * 期望值全部来自 `server.py`（`_api_create_project` 2212 / `_api_update_project` 2268 /
 * `_api_delete_project` 2321 / `_api_fs_mkdir` 2357 / `_api_archive_project` 2462 /
 * `_api_prefs_set` 2497），不是读 Node 实现反推；`[Errno …]` 两档文案另有本机
 * `python3` 实测（见对应用例的注释）。
 *
 * 三条只有路由级/实例级才测得到的判据，本文件逐条钉住：
 *  ① **逐字节正文**：成功体 `{"id": 4}` / `{"ok":true}` / `{"name": "x", "path": "…"}` 与
 *     400/404 的**两种空格形态**（`{"error":"…"}` 紧凑 vs `{"error": "…"}` 带空格）都断言
 *     `Buffer.toString()`，不只看状态码；
 *  ② **读体的时机**：`DELETE` 在归档闸之前**不许读体**（未归档 400 档）、`PATCH` 在
 *     `ownedProject` 之前**必须读体**（404 档也要读掉）。用「请求流的 `end` 有没有触发」
 *     当探针——`readBody()` 一旦消费，暂停态的 Readable 会走完并触发 `end`；没消费则永不触发；
 *  ③ **真目录副作用**：建/改项目必须真建 `work_dir` + `free_style` + `bug_report`
 *     （`fs.statSync().isDirectory()`），失败档**一条行都不许落**。
 *
 * 走真分派链（`makeContext()` + `dispatch()`，与 `projects-route.test.mjs` 同款）：本族新增了
 * 4 条同前缀的 POST/PATCH/DELETE 正则，路由表顺序错一条就会静默走到别的分支，只有真分派测得到。
 *
 * ⚠️ **`fs/mkdir` 的「结尾空格」档**：`name: "x "` 在两侧都是 **200**（`name.strip()` 先归整，
 * 之后 `rstrip(". ")` 只对结尾的 `.` 生效）。本机实测（作为 oracle 证据）：
 *   `python3 -c "import server,tempfile;print(server.fs_mkdir(tempfile.mkdtemp(),'x '))"`
 *   ⇒ `({'name': 'x', 'path': '…/x'}, None)`
 * 用例 `mkdir：'x ' 结尾空格先 strip ⇒ 200` 把这个真值钉住（对拍用例里若有相反的期望，是
 * 用例侧写错了，不是实现）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { pyJsonDumps } from '../lib/pyjson.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertTask } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 响应桩：记 status/headers/正文（`lib/http.js` 的调用面只有 writeHead/end/write/destroy） */
function fakeRes() {
  const cap = { status: 0, headers: null, chunks: [], destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      write(chunk) { cap.chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) cap.chunks.push(Buffer.from(chunk));
      },
      destroy() { cap.destroyed = true; },
    },
  };
}

/**
 * 请求桩：真 `Readable` + `content-length`（`lib/http.js:readJsonBody` 只认这两样）。
 * `readState` 是「体有没有被消费」的探针：`end` 只有在流被读空后才触发，而**只挂 `end`
 * 监听不会让暂停态的流开始流动**——所以它精确对应「handler 有没有调 `ctx.readBody()`」。
 */
function fakeReq(method, body) {
  const text = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text === null ? [] : [text], { objectMode: false });
  stream.headers = text === null ? {} : { 'content-length': String(text.length) };
  stream.method = method;
  const readState = { ended: false };
  stream.on('end', () => { readState.ended = true; });
  return { stream, readState };
}

/**
 * 发一次写请求（走真路由表）。
 * @returns {Promise<{status:number, headers:object, hit:boolean, readState:object,
 *                    text:Function, json:Function}>}
 */
async function call(env, method, target, { body, user } = {}) {
  const { stream, readState } = fakeReq(method, body);
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: stream,
    res,
    db: env.db,
    user: user === undefined ? env.admin : user,
    path: target.split('?')[0],
    // `search` 是去掉 `?` 的那一段（与 `server.js` 同口径）
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  const buf = Buffer.concat(cap.chunks);
  return {
    status: cap.status,
    headers: cap.headers,
    hit,
    readState,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

/** 一条写请求 + 逐字节正文断言（对拍判据的核心形态） */
async function expectBody(env, method, target, opts, status, expectedBody) {
  const r = await call(env, method, target, opts);
  assert.equal(r.status, status, `状态码：${r.text()}`);
  assert.equal(r.text(), expectedBody);
  assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
  return r;
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ts-pw-${tag}-`));
}

/** 夹具：临时库 + 两个用户（种子 admin=1 / bob=101）+ 一个数据根目录 */
function setup(tag) {
  const fx = freshDb(`pw-${tag}`);
  fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES (?,?,?,?,?,?)').run(101, 'bob', 'x', '', 0, '2026-10-12 00:00:00');
  return {
    ...fx,
    admin: fx.db.prepare('SELECT * FROM users WHERE id=1').get(),
    bob: fx.db.prepare('SELECT * FROM users WHERE id=101').get(),
    dat: tmpDir(tag),
  };
}

let seq = 0;
/** 直接用真 SQL 插项目行（不用 m3fixture.insertProject：这里要把 16 列都摆成确定值） */
function seedProject(env, opts = {}) {
  const {
    userId = 1, name = 'p', projectDir = null, workDir = null,
    agentPath = 'dsh-plugin:/usr/local/bin/dsh', guideText = '指南',
    commitSpec = '旧提交规范', deploySpec = '旧部署规范', envLabel = 'dev', model = 'm0',
    skillUnderstand = '', skillDeploy = '', skillCommit = '', skillTest = '',
    skillCases = '', reasoningEffort = '', permissionMode = '', archived = 0,
  } = opts;
  seq += 1;
  const pdir = projectDir === null ? path.join(env.dat, `pd-${seq}`) : projectDir;
  const wdir = workDir === null ? path.join(env.dat, `wd-${seq}`) : workDir;
  const info = env.db.prepare(
    'INSERT INTO projects(user_id, name, project_dir, agent_path, work_dir, bug_dir,'
    + ' guide_text, commit_spec, deploy_spec, env_label, model,'
    + ' skill_understand, skill_deploy, skill_commit, skill_test, skill_cases,'
    + ' reasoning_effort, permission_mode, created_at, archived)'
    + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(userId, name, pdir, agentPath, wdir, '', guideText, commitSpec, deploySpec, envLabel,
    model, skillUnderstand, skillDeploy, skillCommit, skillTest, skillCases,
    reasoningEffort, permissionMode, '2026-10-12 00:00:00', archived);
  return Number(info.lastInsertRowid);
}

const projectRow = (env, id) => env.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
const countOf = (env, table) => env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const isDirNow = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

// --------------------------------------------------------------------------
// POST /api/projects —— 建项目
// --------------------------------------------------------------------------

test('建项目：只给 project_dir ⇒ 名称取末段 + work_dir 派生 .touchstone + 三目录真被创建', async (t) => {
  const env = setup('create-min');
  t.after(() => env.close());
  const pdir = path.join(env.dat, 'newproj');
  const r = await call(env, 'POST', '/api/projects', { body: { project_dir: pdir } });
  assert.equal(r.status, 200);
  const id = r.json().id;
  // 成功体是 json.dumps 口径（键值对带空格），且只有一个键
  assert.equal(r.text(), `{"id": ${id}}`);
  const row = projectRow(env, id);
  assert.equal(row.name, 'newproj');                       // path_last_segment
  assert.equal(row.project_dir, pdir);
  assert.equal(row.agent_path, '');
  assert.equal(row.work_dir, path.join(pdir, '.touchstone'));
  assert.equal(row.bug_dir, '');                           // 列已废弃，恒空串
  assert.equal(row.commit_spec, '');                       // 建项目恒传空串
  assert.equal(row.deploy_spec, '');
  assert.equal(row.user_id, 1);
  // 三个目录真实落盘（`os.makedirs(exist_ok=True)` 三连）
  for (const d of [row.work_dir,
    path.join(row.work_dir, 'free_style'), path.join(row.work_dir, 'bug_report')]) {
    assert.ok(isDirNow(d), d);
  }
});

test('建项目：name 为空/纯空白 ⇒ 同样取 project_dir 末段；work_dir 显式给出时不派生', async (t) => {
  const env = setup('create-name');
  t.after(() => env.close());
  const pdir = path.join(env.dat, 'a', 'b');           // 末尾无分隔符也取 b
  const wdir = path.join(env.dat, 'mywork');
  const r = await call(env, 'POST', '/api/projects', {
    body: { name: '   ', project_dir: pdir, work_dir: wdir },
  });
  assert.equal(r.status, 200);
  const row = projectRow(env, r.json().id);
  assert.equal(row.name, 'b');
  assert.equal(row.work_dir, wdir);
  assert.ok(isDirNow(path.join(wdir, 'free_style')));
});

test('建项目：14 个字段全给 ⇒ 逐列落库（skill_test/skill_cases 必须传下去）', async (t) => {
  const env = setup('create-full');
  t.after(() => env.close());
  const pdir = path.join(env.dat, 'p2d');
  const wdir = path.join(env.dat, 'p2w');
  const r = await call(env, 'POST', '/api/projects', {
    body: {
      name: '显式项目', project_dir: pdir, work_dir: wdir, agent_path: 'dsh-plugin:test',
      guide_text: '指南', env_label: 'dev', model: 'm1',
      skill_understand: 'su', skill_deploy: 'sd', skill_commit: 'sc',
      skill_test: 'st', skill_cases: 'scs',
      reasoning_effort: 'high', permission_mode: 'yolo',
    },
  });
  assert.equal(r.status, 200);
  const row = projectRow(env, r.json().id);
  assert.deepEqual({
    name: row.name, project_dir: row.project_dir, work_dir: row.work_dir,
    agent_path: row.agent_path, guide_text: row.guide_text, env_label: row.env_label,
    model: row.model, skill_understand: row.skill_understand, skill_deploy: row.skill_deploy,
    skill_commit: row.skill_commit, skill_test: row.skill_test, skill_cases: row.skill_cases,
    reasoning_effort: row.reasoning_effort, permission_mode: row.permission_mode,
    commit_spec: row.commit_spec, deploy_spec: row.deploy_spec,
  }, {
    name: '显式项目', project_dir: pdir, work_dir: wdir, agent_path: 'dsh-plugin:test',
    guide_text: '指南', env_label: 'dev', model: 'm1',
    skill_understand: 'su', skill_deploy: 'sd', skill_commit: 'sc',
    skill_test: 'st', skill_cases: 'scs',
    reasoning_effort: 'high', permission_mode: 'yolo',
    commit_spec: '', deploy_spec: '',
  });
});

test('建项目：重名 ⇒ 400 带空格 + 不落行（`项目名已存在`）', async (t) => {
  const env = setup('create-dup');
  t.after(() => env.close());
  await call(env, 'POST', '/api/projects', {
    body: { name: '撞名', project_dir: path.join(env.dat, 'd1') },
  });
  const r = await expectBody(env, 'POST', '/api/projects',
    { body: { name: '撞名', project_dir: path.join(env.dat, 'd2') } },
    400, '{"error": "项目名已存在"}');
  assert.equal(r.hit, true);
  assert.equal(countOf(env, 'projects'), 1);
});

test('建项目：reasoning_effort/permission_mode 非法 ⇒ 400 带空格、不落行、不建目录', async (t) => {
  const env = setup('create-bad-effort');
  t.after(() => env.close());
  const pdir = path.join(env.dat, 'nope-effort');
  await expectBody(env, 'POST', '/api/projects',
    { body: { name: 'x', project_dir: pdir, reasoning_effort: 'bogus' } },
    400, '{"error": "思考等级或权限档非法"}');
  await expectBody(env, 'POST', '/api/projects',
    { body: { name: 'x', project_dir: pdir, permission_mode: 'bogus' } },
    400, '{"error": "思考等级或权限档非法"}');
  assert.equal(countOf(env, 'projects'), 0);
  assert.equal(fs.existsSync(pdir), false, '400 发生在 makedirs 之前');
});

test('建项目：work_dir 是已存在的普通文件 ⇒ 400（`[Errno 17] File exists: …` 逐字节）', async (t) => {
  const env = setup('create-occ');
  t.after(() => env.close());
  const occ = path.join(env.dat, 'occupied-file');
  fs.writeFileSync(occ, 'x');
  // oracle 实测：`python3 -c "import os,tempfile;…"` ⇒ FileExistsError errno=17
  //                          str(e) = `[Errno 17] File exists: '<path>'`
  const r = await expectBody(env, 'POST', '/api/projects',
    { body: { name: '占位项目', project_dir: path.join(env.dat, 'occ'), work_dir: occ } },
    400, `{"error": "工作目录不可用: [Errno 17] File exists: '${occ}'"}`);
  assert.equal(r.hit, true);
  assert.equal(countOf(env, 'projects'), 0, '目录建不出来 ⇒ 一条行都不许落');
});

test('建项目：work_dir 在普通文件**下面** ⇒ 400 `[Errno 20] Not a directory`', async (t) => {
  const env = setup('create-notdir');
  t.after(() => env.close());
  const occ = path.join(env.dat, 'afile');
  fs.writeFileSync(occ, 'x');
  const target = path.join(occ, 'sub');
  await expectBody(env, 'POST', '/api/projects',
    { body: { name: 'x', project_dir: path.join(env.dat, 'occ2'), work_dir: target } },
    400, `{"error": "工作目录不可用: [Errno 20] Not a directory: '${target}'"}`);
  assert.equal(countOf(env, 'projects'), 0);
});

test('建项目：派生子目录 free_style 是普通文件 ⇒ 400 且路径是**失败的那一条**', async (t) => {
  const env = setup('create-derived');
  t.after(() => env.close());
  const wdir = path.join(env.dat, 'wfile');
  fs.mkdirSync(wdir, { recursive: true });
  const clash = path.join(wdir, 'free_style');
  fs.writeFileSync(clash, 'x');
  await expectBody(env, 'POST', '/api/projects',
    { body: { name: 'x', project_dir: path.join(env.dat, 'occ3'), work_dir: wdir } },
    400, `{"error": "工作目录不可用: [Errno 17] File exists: '${clash}'"}`);
  assert.equal(countOf(env, 'projects'), 0);
});

test('建项目：project_dir 缺省 ⇒ os.homedir()（HOME 指到夹具，不碰真 home）', async (t) => {
  const env = setup('create-home');
  t.after(() => env.close());
  const home = path.join(env.dat, 'fakehome');
  fs.mkdirSync(home, { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;                       // os.homedir() 与 os.path.expanduser("~") 同源
  try {
    const r = await call(env, 'POST', '/api/projects', { body: {} });
    assert.equal(r.status, 200);
    const row = projectRow(env, r.json().id);
    assert.equal(row.project_dir, home);
    assert.equal(row.name, 'fakehome');          // path_last_segment(home)
    assert.equal(row.work_dir, path.join(home, '.touchstone'));
    assert.ok(isDirNow(path.join(home, '.touchstone', 'bug_report')));
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  }
});

test('建项目：project_dir 真值非字符串 ⇒ 抛 AttributeError（Python 5 .strip() 同形，连接被掐断）', async (t) => {
  const env = setup('create-attr');
  t.after(() => env.close());
  await assert.rejects(
    () => call(env, 'POST', '/api/projects', { body: { project_dir: 5 } }),
    /AttributeError: 'number' object has no attribute 'strip'/,
  );
  assert.equal(countOf(env, 'projects'), 0);
});

// --------------------------------------------------------------------------
// PATCH /api/projects/<id> —— 改项目
// --------------------------------------------------------------------------

test('改项目：改名 + 换 work_dir ⇒ 200 `{"ok":true}`、新派生目录真建、未带键保持存量', async (t) => {
  const env = setup('patch-move');
  t.after(() => env.close());
  const pid = seedProject(env, {
    name: '旧名', skillTest: 'st0', skillCases: 'scs0', model: 'm0', reasoningEffort: 'low',
  });
  const newWork = path.join(env.dat, 'moved');
  const r = await expectBody(env, 'PATCH', `/api/projects/${pid}`,
    { body: { name: '新名', work_dir: newWork, reasoning_effort: 'max' } },
    200, '{"ok":true}');
  assert.equal(r.hit, true);
  const row = projectRow(env, pid);
  assert.equal(row.name, '新名');
  assert.equal(row.work_dir, newWork);
  assert.equal(row.reasoning_effort, 'max');
  assert.equal(row.permission_mode, '');              // 未带键 = 存量（不是被清空）
  assert.equal(row.skill_test, 'st0');
  assert.equal(row.skill_cases, 'scs0');
  assert.equal(row.model, 'm0');
  assert.equal(row.commit_spec, '旧提交规范');         // 两列保留存量、不接受更新
  assert.equal(row.deploy_spec, '旧部署规范');
  assert.ok(isDirNow(newWork), '新 work_dir');
  assert.ok(isDirNow(path.join(newWork, 'free_style')));
  assert.ok(isDirNow(path.join(newWork, 'bug_report')));
});

test('改项目：name 未带 ⇒ 从**新** project_dir 末段派生；agent_path 未带保持存量', async (t) => {
  const env = setup('patch-derive');
  t.after(() => env.close());
  const pid = seedProject(env, { name: '旧名', agentPath: 'dsh-plugin:keep' });
  const newDir = path.join(env.dat, 'renamed-dir');
  await expectBody(env, 'PATCH', `/api/projects/${pid}`, { body: { project_dir: newDir } },
    200, '{"ok":true}');
  const row = projectRow(env, pid);
  assert.equal(row.project_dir, newDir);
  assert.equal(row.name, 'renamed-dir');
  assert.equal(row.agent_path, 'dsh-plugin:keep');
});

test('改项目：改成同用户另一个项目名 ⇒ 400 带空格（约束冲突走 IntegrityError 判据）', async (t) => {
  const env = setup('patch-dup');
  t.after(() => env.close());
  seedProject(env, { name: 'A' });
  const pb = seedProject(env, { name: 'B' });
  await expectBody(env, 'PATCH', `/api/projects/${pb}`, { body: { name: 'A' } },
    400, '{"error": "项目名已存在"}');
  assert.equal(projectRow(env, pb).name, 'B', '400 后原行不动');
});

test('改项目：非法 reasoning_effort / permission_mode ⇒ 400 带空格且不改进存量', async (t) => {
  const env = setup('patch-bad');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'p', reasoningEffort: 'low', permissionMode: 'auto' });
  await expectBody(env, 'PATCH', `/api/projects/${pid}`, { body: { reasoning_effort: 'bogus' } },
    400, '{"error": "思考等级或权限档非法"}');
  await expectBody(env, 'PATCH', `/api/projects/${pid}`, { body: { permission_mode: 'bogus' } },
    400, '{"error": "思考等级或权限档非法"}');
  const row = projectRow(env, pid);
  assert.equal(row.reasoning_effort, 'low');
  assert.equal(row.permission_mode, 'auto');
});

test('改项目：不存在的项目 ⇒ 404 紧凑，且**体已被读掉**（Python 在调用 handler 前读体）', async (t) => {
  const env = setup('patch-404');
  t.after(() => env.close());
  const r = await expectBody(env, 'PATCH', '/api/projects/999999', { body: { name: 'x' } },
    404, '{"error":"project not found"}');
  assert.equal(r.readState.ended, true, 'PATCH 的 404 档也必须消费请求体');
});

test('改项目：work_dir 未变更 ⇒ 不做 makedirs（存量指向普通文件也 200）；变更到普通文件下 ⇒ 400', async (t) => {
  const env = setup('patch-same-work');
  t.after(() => env.close());
  const occ = path.join(env.dat, 'stored-file');
  fs.writeFileSync(occ, 'x');
  const pid = seedProject(env, { name: 'p', workDir: occ });   // 存量本身就是普通文件
  await expectBody(env, 'PATCH', `/api/projects/${pid}`,
    { body: { work_dir: occ, name: 'p2' } }, 200, '{"ok":true}');
  const target = path.join(occ, 'sub');
  await expectBody(env, 'PATCH', `/api/projects/${pid}`, { body: { work_dir: target } },
    400, `{"error": "工作目录不可用: [Errno 20] Not a directory: '${target}'"}`);
  assert.equal(projectRow(env, pid).work_dir, occ, '400 后 work_dir 不被改写');
});

// --------------------------------------------------------------------------
// DELETE /api/projects/<id> —— 删项目（仅已归档 + confirm_name 双保险）
// --------------------------------------------------------------------------

test('删项目：未归档 ⇒ 400 带空格、**不读体**、行还在', async (t) => {
  const env = setup('del-unarchived');
  t.after(() => env.close());
  const pid = seedProject(env, { name: '未归档' });
  const r = await expectBody(env, 'DELETE', `/api/projects/${pid}`,
    { body: { confirm_name: '未归档' } }, 400, '{"error": "仅已归档的项目可删除，请先归档"}');
  assert.equal(r.readState.ended, false, '读体发生在归档闸之后（时机是契约）');
  assert.equal(projectRow(env, pid).id, pid);
});

test('删项目：已归档但 confirm_name 不符 ⇒ 400 带空格、行还在（此时体已读掉）', async (t) => {
  const env = setup('del-wrongname');
  t.after(() => env.close());
  const pid = seedProject(env, { name: '归档项目', archived: 1 });
  const r = await expectBody(env, 'DELETE', `/api/projects/${pid}`,
    { body: { confirm_name: '错名' } }, 400, '{"error": "确认名称与项目名不一致"}');
  assert.equal(r.readState.ended, true);
  assert.equal(projectRow(env, pid).id, pid);
});

test('删项目：confirm_name 前后空白被 strip、成功 ⇒ 200 + 级联删 tasks/rounds', async (t) => {
  const env = setup('del-ok');
  t.after(() => env.close());
  const pid = seedProject(env, { name: '待删项目', archived: 1 });
  const other = seedProject(env, { name: '别人的', userId: 101 });
  const tid = insertTask(env.db, pid, { name: 't1' });
  env.db.prepare('INSERT INTO rounds(task_id, round_no, status, started_at) VALUES(?,?,?,?)')
    .run(tid, 1, 'done', '2026-10-12 00:00:00');
  const keepTid = insertTask(env.db, other, { name: 'keep' });
  await expectBody(env, 'DELETE', `/api/projects/${pid}`,
    { body: { confirm_name: '  待删项目  ' } }, 200, '{"ok":true}');
  assert.equal(projectRow(env, pid), undefined);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id=?').get(pid).n, 0);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE task_id=?').get(tid).n, 0);
  // 别人的项目毫发无损（多用户隔离）
  assert.equal(projectRow(env, other).name, '别人的');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id=?').get(keepTid).n, 1);
});

test('删项目：不存在 ⇒ 404（在归档闸之前，且不读体）', async (t) => {
  const env = setup('del-404');
  t.after(() => env.close());
  const r = await expectBody(env, 'DELETE', '/api/projects/999999',
    { body: { confirm_name: 'x' } }, 404, '{"error":"project not found"}');
  assert.equal(r.readState.ended, false);
});

test('删项目：他人项目 ⇒ 同一 404 文案（不泄露存在性）', async (t) => {
  const env = setup('del-foreign');
  t.after(() => env.close());
  const foreign = seedProject(env, { name: 'B 的', userId: 101, archived: 1 });
  const r = await call(env, 'DELETE', `/api/projects/${foreign}`,
    { body: { confirm_name: 'B 的' } });
  assert.equal(r.status, 404);
  assert.equal(r.text(), '{"error":"project not found"}');
  assert.equal(projectRow(env, foreign).id, foreign);
});

// --------------------------------------------------------------------------
// POST /api/projects/<id>/(archive|unarchive)
// --------------------------------------------------------------------------

test('归档端点：archive 写 1 / unarchive 写 0（一条正则两个分支，body 都是 {"ok":true}）', async (t) => {
  const env = setup('archive');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'p', archived: 0 });
  await expectBody(env, 'POST', `/api/projects/${pid}/unarchive`, {}, 200, '{"ok":true}');
  assert.equal(projectRow(env, pid).archived, 0, 'unarchive 幂等');
  await expectBody(env, 'POST', `/api/projects/${pid}/archive`, {}, 200, '{"ok":true}');
  assert.equal(projectRow(env, pid).archived, 1);
  await expectBody(env, 'POST', `/api/projects/${pid}/unarchive`, {}, 200, '{"ok":true}');
  assert.equal(projectRow(env, pid).archived, 0);
});

test('归档端点：不存在/他人项目 ⇒ 404 紧凑 `project not found`', async (t) => {
  const env = setup('archive-404');
  t.after(() => env.close());
  const foreign = seedProject(env, { name: 'B 的', userId: 101 });
  for (const target of ['/api/projects/999999/archive', `/api/projects/${foreign}/archive`,
    `/api/projects/${foreign}/unarchive`]) {
    const r = await expectBody(env, 'POST', target, {}, 404, '{"error":"project not found"}');
    assert.equal(r.hit, true);
  }
  assert.equal(projectRow(env, foreign).archived, 0);
});

// --------------------------------------------------------------------------
// POST /api/prefs —— UI 偏好写
// --------------------------------------------------------------------------

test('prefs：key 白名单 `[a-z_]{1,64}`（空/大写/连字符/空格/65 字符 ⇒ 400 紧凑；64 字符 ⇒ 200）', async (t) => {
  const env = setup('prefs-key');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'p' });
  for (const key of ['', 'Bad-Key', 'k-1', 'k k', '中', 'a'.repeat(65)]) {
    await expectBody(env, 'POST', '/api/prefs', { body: { project_id: pid, key, value: {} } },
      400, '{"error":"key 非法"}');
  }
  await expectBody(env, 'POST', '/api/prefs',
    { body: { project_id: pid, key: 'a'.repeat(64), value: {} } }, 200, '{"ok":true}');
  assert.equal(countOf(env, 'user_prefs'), 1);
});

test('prefs：key 先 strip 再判（" k " ⇒ 合法，落库键是 k）', async (t) => {
  const env = setup('prefs-strip');
  t.after(() => env.close());
  await expectBody(env, 'POST', '/api/prefs', { body: { key: ' k ', value: {} } },
    200, '{"ok":true}');
  const row = env.db.prepare('SELECT * FROM user_prefs').get();
  assert.equal(row.key, 'k');
  assert.equal(row.project_id, 0);
});

test('prefs：value 必须是对象且 ≤16384 字符（字符串/数组/null/>16KB ⇒ 400；恰好 16384 ⇒ 200）', async (t) => {
  const env = setup('prefs-value');
  t.after(() => env.close());
  for (const value of ['not-an-object', [1, 2], null, 5, { v: 'x'.repeat(20001) }]) {
    await expectBody(env, 'POST', '/api/prefs', { body: { key: 'k', value } },
      400, '{"error":"value 非法"}');
  }
  assert.equal(countOf(env, 'user_prefs'), 0);
  // 边界：序列化后**恰好** 16384 字符（判据是 `> 16384`）⇒ 200
  const v = { v: 'x'.repeat(16375) };
  assert.equal([...pyJsonDumps(v)].length, 16384);
  await expectBody(env, 'POST', '/api/prefs', { body: { key: 'edge', value: v } },
    200, '{"ok":true}');
});

test('prefs：`project_id` 非数字/缺键折 0、数值串折成项目（"2" ⇒ 2，不是 400）', async (t) => {
  const env = setup('prefs-pid');
  t.after(() => env.close());
  seedProject(env, { name: 'p1' });
  const pid = seedProject(env, { name: 'p2' });          // 全新库 ⇒ 第二个项目就是 id=2
  assert.equal(pid, 2);
  await expectBody(env, 'POST', '/api/prefs',
    { body: { project_id: 'abc', key: 'global', value: { x: 1 } } }, 200, '{"ok":true}');
  await expectBody(env, 'POST', '/api/prefs', { body: { key: 'no_project_key', value: {} } },
    200, '{"ok":true}');
  await expectBody(env, 'POST', '/api/prefs',
    { body: { project_id: String(pid), key: 'scoped', value: {} } }, 200, '{"ok":true}');
  const rows = env.db.prepare('SELECT key, project_id FROM user_prefs ORDER BY key').all();
  assert.deepEqual(rows.map((r) => [r.key, r.project_id]),
    [['global', 0], ['no_project_key', 0], ['scoped', pid]]);
});

test('prefs：不存在的项目/他人项目 ⇒ 404 紧凑且不落行', async (t) => {
  const env = setup('prefs-404');
  t.after(() => env.close());
  const foreign = seedProject(env, { name: 'B 的', userId: 101 });
  await expectBody(env, 'POST', '/api/prefs',
    { body: { project_id: 999999, key: 'k', value: {} } }, 404, '{"error":"project not found"}');
  await expectBody(env, 'POST', '/api/prefs',
    { body: { project_id: foreign, key: 'k', value: {} } }, 404, '{"error":"project not found"}');
  assert.equal(countOf(env, 'user_prefs'), 0);
});

test('prefs：成功 ⇒ 200；value 落库文本按 pyjson 口径（中文不转义、", "/": " 分隔）', async (t) => {
  const env = setup('prefs-ok');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'p' });
  await expectBody(env, 'POST', '/api/prefs',
    { body: { project_id: pid, key: 'layout', value: { tabs: ['a', 'b'], 标题: '中文' } } },
    200, '{"ok":true}');
  const row = env.db.prepare('SELECT * FROM user_prefs').get();
  assert.equal(row.user_id, 1);
  assert.equal(row.project_id, pid);
  assert.equal(row.key, 'layout');
  assert.equal(row.value, '{"tabs": ["a", "b"], "标题": "中文"}');
});

// --------------------------------------------------------------------------
// POST /api/fs/mkdir
// --------------------------------------------------------------------------

test('fs/mkdir：成功 ⇒ 200 `{"name": …, "path": <realpath>}`（json.dumps 口径）+ 目录真存在', async (t) => {
  const env = setup('mkdir-ok');
  t.after(() => env.close());
  const r = await call(env, 'POST', '/api/fs/mkdir', { body: { path: env.dat, name: '新目录' } });
  assert.equal(r.status, 200);
  const rp = fs.realpathSync(path.join(env.dat, '新目录'));
  assert.equal(r.text(), `{"name": "新目录", "path": ${JSON.stringify(rp)}}`);
  assert.equal(r.json().path, rp);
  assert.ok(isDirNow(rp));
});

test("fs/mkdir：`x ` 结尾空格先 strip ⇒ 200（oracle 实测：Python 也回 200 `{'name':'x'}`）", async (t) => {
  const env = setup('mkdir-trailing-space');
  t.after(() => env.close());
  const r = await call(env, 'POST', '/api/fs/mkdir', { body: { path: env.dat, name: 'x ' } });
  assert.equal(r.status, 200, r.text());
  assert.equal(r.json().name, 'x');
  assert.ok(isDirNow(path.join(env.dat, 'x')));
});

test('fs/mkdir：七档 400 的中文文案逐字节（带空格错误体）', async (t) => {
  const env = setup('mkdir-400');
  t.after(() => env.close());
  const dir = path.join(env.dat, 'd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'occupied'), 'x');
  const cases = [
    // [body, 期望正文]
    [{ path: dir, name: '' }, '{"error": "文件夹名称不能为空"}'],
    [{ path: dir, name: '   ' }, '{"error": "文件夹名称不能为空"}'],
    [{ path: dir, name: '.' }, '{"error": "文件夹名称不能包含路径分隔符，也不能是 . 或 .."}'],
    [{ path: dir, name: '..' }, '{"error": "文件夹名称不能包含路径分隔符，也不能是 . 或 .."}'],
    [{ path: dir, name: 'a/b' }, '{"error": "文件夹名称不能包含路径分隔符，也不能是 . 或 .."}'],
    [{ path: dir, name: 'a\\b' }, '{"error": "文件夹名称不能包含路径分隔符，也不能是 . 或 .."}'],
    [{ path: dir, name: 'x.' }, '{"error": "文件夹名称不能以点或空格结尾"}'],
    [{ path: path.join(env.dat, 'nope'), name: 'd' },
      '{"error": "请先进入一个存在的目录再新建文件夹"}'],
    [{ path: '', name: 'd' }, '{"error": "请先进入一个存在的目录再新建文件夹"}'],
    [{ path: dir, name: 'occupied' }, '{"error": "同名文件或目录已存在"}'],
    [{ path: env.dat, name: 'd' }, '{"error": "同名文件或目录已存在"}'],   // 同名**目录**
  ];
  for (const [body, expected] of cases) {
    const r = await expectBody(env, 'POST', '/api/fs/mkdir', { body }, 400, expected);
    assert.equal(r.hit, true);
  }
});

// --------------------------------------------------------------------------
// 路由表口径（顺序 = 匹配顺序）
// --------------------------------------------------------------------------

test('路由表：四条新 POST 正则互不吃掉（archive/unarchive/reject 各走各的分支）', async (t) => {
  const env = setup('routes');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'p', archived: 0 });
  // archive 与 unarchive 是同一条正则的两个分支：状态码相同但落库值相反
  await call(env, 'POST', `/api/projects/${pid}/archive`, {});
  assert.equal(projectRow(env, pid).archived, 1);
  // reject 端点（M6-6）不该被 archive 那条吃掉：bug 目录不存在 ⇒ 404 bug not found
  const r = await call(env, 'POST', `/api/projects/${pid}/bugs/nope/reject`, { body: {} });
  assert.equal(r.status, 404);
  assert.equal(r.text(), '{"error":"bug not found"}');
});
