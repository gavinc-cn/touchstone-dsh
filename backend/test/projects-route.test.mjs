/**
 * `backend/routes/projects.js` 路由级单测（node --test，零依赖）。
 *
 * **走真分派链**：每个用例都经 `makeContext()` + `dispatch()`（= `routes/index.js` 的整张表），
 * 而不是直接调 handler。理由：这张表的最大风险是**顺序**（字面路径在前、正则链在后、
 * `dup_check` 不能被 `(\d+)` 先吃掉、`bugs/<dir>` 不能盖住 `bugs`），只有走真分派才测得到。
 *
 * 响应用一个「记账桩」`res` 收：记 status/headers/正文，**并记 `writeHead` 次数**——因为
 * Python 的 `_resolve_project` 在「?project= 指向越权项目」时**不发 404、只回落**，
 * 若实现里误用了会写响应的 `ctx.ownedProject`，就会出现「先 404 再 200」两次 writeHead；
 * 这条正是本文件里最该被钉死的判据（普通断言看不出来：客户端只看到第一个响应）。
 *
 * 数据都在临时库 + mkdtemp 目录里造，不碰生产库/真实案例库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { makeContext, dispatch } from '../routes/index.js';
import { freshDb, insertCard, insertProject } from './m3fixture.mjs';

/** 建临时目录 */
function tmpDir(tag = 'ts-projroute-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** 写文件（自动建父目录） */
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/**
 * 响应桩（只实现 `lib/http.js` 与 SSE 写口用到的那几个方法）。
 * @param {{failAfterWrite?: number, closeAfterFirstWrite?: boolean}} [opts]
 *   `failAfterWrite`：第 N+1 次 `write()` 起返回 false（模拟写失败）；
 *   `closeAfterFirstWrite`：首帧写出后触发一次 `close` 事件（模拟客户端拿到首帧即断开）。
 */
function makeRes({ failAfterWrite = Number.POSITIVE_INFINITY, closeAfterFirstWrite = false } = {}) {
  const state = { writeHeads: 0, status: 0, headers: {}, chunks: [], writes: 0, ended: false };
  const listeners = new Map();
  const emit = (name) => {
    for (const fn of listeners.get(name) || []) fn();
  };
  return {
    state,
    writeHead(status, headers) {
      state.writeHeads += 1;
      state.status = status;
      state.headers = { ...(headers || {}) };
    },
    write(chunk) {
      state.writes += 1;
      const ok = state.writes <= failAfterWrite;
      if (ok) state.chunks.push(Buffer.from(chunk));
      if (closeAfterFirstWrite && state.writes === 1) emit('close');
      return ok;
    },
    end(chunk) {
      state.ended = true;
      if (chunk !== undefined && chunk !== null) state.chunks.push(Buffer.from(chunk));
    },
    flushHeaders() {},
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return this;
    },
  };
}

/**
 * 发一次 GET（走真路由表）。
 * @returns {Promise<{status:number, headers:object, body:string, json:any,
 *                    writeHeads:number, ended:boolean, hit:boolean}>}
 */
async function get(handle, user, target, opts = {}) {
  const idx = target.indexOf('?');
  const pathname = idx < 0 ? target : target.slice(0, idx);
  const search = idx < 0 ? '' : target.slice(idx + 1);
  const res = makeRes(opts);
  const ctx = makeContext({
    req: { method: 'GET' }, res, db: handle, user, path: pathname, search,
  });
  const hit = await dispatch(ctx);
  const body = Buffer.concat(res.state.chunks).toString('utf8');
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return {
    status: res.state.status,
    headers: res.state.headers,
    body,
    json,
    writeHeads: res.state.writeHeads,
    ended: res.state.ended,
    hit,
  };
}

/** 读种子 admin 行（信任头等价的就是它） */
function adminUser(handle) {
  return handle.prepare("SELECT * FROM users WHERE username='admin'").get();
}

/** 造一个项目 + 真实存在的项目目录/工作目录（案例库与 bug 目录一并建好） */
function makeProject(fx, opts = {}) {
  const {
    userId = 1, name = 'p', withCases = true, withBugs = true, projectDir = null, workDir = null,
  } = opts;
  const base = tmpDir('ts-projroute-data-');
  const pdir = projectDir || path.join(base, 'proj');
  const wdir = workDir || path.join(base, 'work');
  fs.mkdirSync(pdir, { recursive: true });
  fs.mkdirSync(wdir, { recursive: true });
  if (withCases) fs.mkdirSync(path.join(wdir, 'free_style'), { recursive: true });
  if (withBugs) fs.mkdirSync(path.join(wdir, 'bug_report'), { recursive: true });
  const id = insertProject(fx.db, { userId, name, projectDir: pdir, workDir: wdir });
  return { id, projectDir: pdir, workDir: wdir, casesRoot: path.join(wdir, 'free_style'), bugRoot: path.join(wdir, 'bug_report') };
}

// --------------------------------------------------------------------------
// 项目列表 / 详情
// --------------------------------------------------------------------------

test('/api/projects：只回本人项目（id 升序）+ board_counts 三列计数 + archived 布尔', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p1 = makeProject(fx, { name: 'p1' });
    const p2 = makeProject(fx, { name: 'p2' });
    const other = makeProject(fx, { userId: 99, name: 'other' });
    insertCard(fx.db, p1.id, { columnKey: 'doing' });
    insertCard(fx.db, p1.id, { columnKey: 'doing' });
    insertCard(fx.db, p1.id, { columnKey: 'blocked' });
    insertCard(fx.db, p1.id, { columnKey: 'review' });
    insertCard(fx.db, p1.id, { columnKey: 'todo' });                 // 不计入三列
    insertCard(fx.db, p1.id, { columnKey: 'doing', trashed: 1 });    // 回收站不计
    fx.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(p2.id);

    const r = await get(fx.db, me, '/api/projects');
    assert.equal(r.status, 200);
    assert.equal(r.hit, true);
    assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(r.json.map((p) => p.id), [p1.id, p2.id]);
    assert.deepEqual(r.json[0].board_counts, { doing: 2, blocked: 1, review: 1 });
    assert.deepEqual(r.json[1].board_counts, { doing: 0, blocked: 0, review: 0 });
    assert.equal(r.json[1].archived, true);
    assert.equal(r.json[0].archived, false);
    // 键集合（`_project_json` 的 20 键 + board_counts；`cases_root` **不在**其中——那是读取层
    // 派生给内部用的，Python 的 `_project_json` 只挑名取键，故不下发），字段名保持 snake_case
    assert.deepEqual(Object.keys(r.json[0]).sort(), [
      'agent_path', 'archived', 'board_counts', 'bug_dir', 'commit_spec',
      'created_at', 'deploy_spec', 'env_label', 'guide_text', 'id', 'model', 'name',
      'permission_mode', 'project_dir', 'reasoning_effort', 'skill_cases', 'skill_commit',
      'skill_deploy', 'skill_test', 'skill_understand', 'work_dir',
    ].sort());
    assert.equal(r.json[0].bug_dir, p1.bugRoot);                     // 读取层派生（bug_dir 列已废弃）
    assert.equal(r.json[0].cases_root, undefined);                   // 派生键不下发（见上）
    void other;
  } finally {
    fx.close();
  }
});

test('/api/projects/<id>：本人 200（含 board_counts）、他人 404、不存在 404', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const mine = makeProject(fx, { name: 'mine' });
    const other = makeProject(fx, { userId: 99, name: 'other' });
    insertCard(fx.db, mine.id, { columnKey: 'doing' });

    const ok = await get(fx.db, me, `/api/projects/${mine.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.id, mine.id);
    assert.deepEqual(ok.json.board_counts, { doing: 1, blocked: 0, review: 0 });

    const foreign = await get(fx.db, me, `/api/projects/${other.id}`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, { error: 'project not found' });
    // 正文形态也是判据：Python 硬编码 `b'{"error":"project not found"}'` ⇒ **冒号后无空格**，
    // 这两种形态（硬编码 vs json.dumps）在 Python 侧并存，Node 侧必须逐点跟住
    assert.equal(foreign.body, '{"error":"project not found"}');

    const missing = await get(fx.db, me, '/api/projects/999999');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'project not found' });

    // `dup_check` 是字面路径，不能被 `(\d+)` 正则先吃掉（路由顺序判据）
    const dup = await get(fx.db, me, '/api/projects/dup_check');
    assert.equal(dup.status, 200);
    assert.deepEqual(dup.json, []);
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// dup_check
// --------------------------------------------------------------------------

test('/api/projects/dup_check：normpath 归一、跨用户可见、exclude 排除、未知用户回落', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p1 = makeProject(fx, { name: 'p1' });
    const p2 = makeProject(fx, { name: 'p2', userId: 99 });
    // 造一个「项目存在但用户行没了」的孤儿项目（username 回落「未知」）
    const orphan = makeProject(fx, { name: 'orphan', userId: 4242 });
    // 尾部斜杠 + `.` 段都要被 normpath 吃掉 ⇒ 仍命中库里存的原值
    const r = await get(fx.db, me,
      `/api/projects/dup_check?project_dir=${encodeURIComponent(`${p1.projectDir}/./`)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, [{
      field: 'project_dir', value: `${p1.projectDir}/./`, project_id: p1.id,
      project_name: 'p1', username: 'admin',
    }]);

    const w = await get(fx.db, me,
      `/api/projects/dup_check?work_dir=${encodeURIComponent(p2.workDir)}`);
    assert.deepEqual(w.json.map((d) => [d.field, d.project_id, d.username]),
      [['work_dir', p2.id, '未知']]);

    const both = await get(fx.db, me,
      `/api/projects/dup_check?project_dir=${encodeURIComponent(p1.projectDir)}`
      + `&work_dir=${encodeURIComponent(orphan.workDir)}&exclude=${p1.id}`);
    assert.deepEqual(both.json.map((d) => [d.field, d.project_id]),
      [['work_dir', orphan.id]]);

    const none = await get(fx.db, me, '/api/projects/dup_check?project_dir=/no/such/dir');
    assert.deepEqual(none.json, []);

    // `exclude` 非数字：Python `isdigit()` 为假 ⇒ 不排除（且不报错）
    const badExclude = await get(fx.db, me,
      `/api/projects/dup_check?project_dir=${encodeURIComponent(p1.projectDir)}&exclude=abc`);
    assert.deepEqual(badExclude.json.map((d) => d.project_id), [p1.id]);
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// fs/browse
// --------------------------------------------------------------------------

test('/api/fs/browse：200 子目录列表 / 400 目录不存在或不可读', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    fs.mkdirSync(path.join(p.workDir, 'zzz'));
    fs.mkdirSync(path.join(p.workDir, 'aaa'));
    const ok = await get(fx.db, me, `/api/fs/browse?path=${encodeURIComponent(p.workDir)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.platform, process.platform === 'darwin' ? 'macos' : 'linux');
    assert.deepEqual(ok.json.dirs.map((d) => d.name), ['aaa', 'bug_report', 'free_style', 'zzz']);
    assert.equal(ok.json.parent, path.dirname(fs.realpathSync(p.workDir)));

    const roots = await get(fx.db, me, '/api/fs/browse');
    assert.equal(roots.status, 200);
    assert.deepEqual(roots.json.roots, ['/']);
    assert.equal(roots.json.parent, null);   // 根视角自身无处可上

    // 2026-10-22 卡 1044：文件系统根（盘符根 / "/"）的 parent 是空串 ⇒ 前端「上级」进根视角
    const atRoot = await get(fx.db, me, `/api/fs/browse?path=${encodeURIComponent('/')}`);
    assert.equal(atRoot.status, 200);
    assert.equal(atRoot.json.path, '/');
    assert.equal(atRoot.json.parent, '');

    const bad = await get(fx.db, me, '/api/fs/browse?path=/no/such/dir/xyz');
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: '目录不存在或不可读' });
    // Python 侧这条走 `json.dumps({"error": ...})` ⇒ 冒号后**有**空格（与硬编码 404 那批相反）
    assert.equal(bad.body, '{"error": "目录不存在或不可读"}');
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// prefs
// --------------------------------------------------------------------------

test('/api/prefs：全局 0 / 本人项目 / 非数字回落 0 / 他人项目 404', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const mine = makeProject(fx);
    const other = makeProject(fx, { userId: 99 });
    const put = fx.db.prepare(
      'INSERT INTO user_prefs(user_id, project_id, key, value, updated_at) VALUES(?,?,?,?,?)');
    put.run(me.id, mine.id, 'board_filter', '{"cols":["doing"]}', '2026-10-11 00:00:00');
    put.run(me.id, 0, 'theme', '"dark"', '2026-10-11 00:00:00');
    put.run(me.id, other.id, 'leak', '"x"', '2026-10-11 00:00:00');

    const global = await get(fx.db, me, '/api/prefs');
    assert.deepEqual(global.json, { prefs: { theme: 'dark' } });
    const proj = await get(fx.db, me, `/api/prefs?project_id=${mine.id}`);
    assert.deepEqual(proj.json, { prefs: { board_filter: { cols: ['doing'] } } });
    const bad = await get(fx.db, me, '/api/prefs?project_id=abc');
    assert.equal(bad.status, 200);
    assert.deepEqual(bad.json, { prefs: { theme: 'dark' } });        // pid 回落 0
    const foreign = await get(fx.db, me, `/api/prefs?project_id=${other.id}`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, { error: 'project not found' });
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// state / stream
// --------------------------------------------------------------------------

test('/api/state：聚合状态 + project 段；越权 id 回落首个项目且**只写一次响应**', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const mine = makeProject(fx);
    const other = makeProject(fx, { userId: 99 });
    write(path.join(mine.casesRoot, 'FS0001_a', 'status.md'), '- **状态**: 通过\n');
    write(path.join(mine.casesRoot, 'INDEX.md'), '# x\n\n> 说明\n');
    write(path.join(mine.casesRoot, 'ROUNDS.md'), '| 第 1 轮 | 2026-08-22 | 全部 | 冒烟 | （3 条） | 1 |\n');
    write(path.join(mine.bugRoot, '20260901_0001_FS_b', 'bug_report.md'), '- **状态**: 待修复\n');
    write(path.join(mine.workDir, '.live', 'live.json'), '{"task_id": 3}');

    const r = await get(fx.db, me, `/api/state?project=${mine.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.writeHeads, 1);
    assert.deepEqual(Object.keys(r.json),
      ['generated_at', 'live', 'live_mtime', 'library', 'bugs', 'rounds', 'project']);
    assert.deepEqual(r.json.live, { task_id: 3 });
    assert.equal(typeof r.json.live_mtime, 'number');
    assert.deepEqual(r.json.library.stats,
      { total: 1, passed: 1, failed: 0, retest: 0, skipped: 0, pending: 0 });
    assert.equal(r.json.project.id, mine.id);
    assert.equal(r.json.project.board_counts, undefined);            // `_project_json` 不带计数
    assert.equal(r.json.bugs.length, 1);
    assert.equal(r.json.rounds.length, 1);

    // 越权/不存在的 ?project ⇒ 不 404，回落当前用户第一个项目（Python `_resolve_project`）
    const fallback = await get(fx.db, me, `/api/state?project=${other.id}`);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.writeHeads, 1, '不得先发 404 再发 200');
    assert.equal(fallback.json.project.id, mine.id);

    const missing = await get(fx.db, me, '/api/state?project=999999');
    assert.equal(missing.status, 200);
    assert.equal(missing.writeHeads, 1);
    assert.equal(missing.json.project.id, mine.id);

    // 默认（无 ?project）⇒ 首个项目
    const dflt = await get(fx.db, me, '/api/state');
    assert.equal(dflt.json.project.id, mine.id);

    // 非数字 ?project ⇒ 不查库，直接回落
    const nonDigit = await get(fx.db, me, '/api/state?project=abc');
    assert.equal(nonDigit.json.project.id, mine.id);
  } finally {
    fx.close();
  }
});

test('/api/state：当前用户一个项目都没有 ⇒ 200 {"error":"no project"}', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    makeProject(fx, { userId: 99 });                                 // 只有别人的项目
    const r = await get(fx.db, me, '/api/state');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { error: 'no project' });
    const r2 = await get(fx.db, me, '/api/stream');
    assert.equal(r2.status, 200);
    assert.equal(r2.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(r2.body, 'data: {"error":"no project"}\n\n');
    assert.equal(r2.ended, true);
  } finally {
    fx.close();
  }
});

test('/api/stream：首拍推一帧 data（客户端断开即收尾，不挂死）', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const mine = makeProject(fx);
    write(path.join(mine.casesRoot, 'FS0001_a', 'status.md'), '- **状态**: 通过\n');
    const r = await get(fx.db, me, `/api/stream?project=${mine.id}`, { closeAfterFirstWrite: true });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.headers['X-Accel-Buffering'], undefined);         // /api/stream 不带头（看板两条才带）
    assert.ok(r.body.startsWith('data: '));
    assert.ok(r.body.endsWith('\n\n'));
    const payload = JSON.parse(r.body.slice('data: '.length).trim());
    assert.equal(payload.project.id, mine.id);
    assert.equal(payload.library.stats.total, 1);
    assert.equal(r.writeHeads, 1);
    assert.equal(r.ended, true);
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// 项目文件预览 / raw
// --------------------------------------------------------------------------

test('/api/projects/<id>/file：项目目录优先 + 工作目录回落 + 各字段（含 rel/ext/mtime）', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    write(path.join(p.projectDir, 'README.md'), '# 项目\n');
    write(path.join(p.projectDir, 'both.txt'), 'from-project');
    write(path.join(p.workDir, 'both.txt'), 'from-work');
    write(path.join(p.casesRoot, 'INDEX.md'), 'index\n');

    const rel = await get(fx.db, me, `/api/projects/${p.id}/file?path=README.md`);
    assert.equal(rel.status, 200);
    assert.deepEqual(Object.keys(rel.json), [
      'path', 'rel', 'root', 'name', 'ext', 'size', 'mtime', 'text', 'truncated', 'binary',
    ]);
    assert.equal(rel.json.path, fs.realpathSync(path.join(p.projectDir, 'README.md')));
    assert.equal(rel.json.rel, 'README.md');
    assert.equal(rel.json.root, 'project');
    assert.equal(rel.json.name, 'README.md');
    assert.equal(rel.json.ext, 'md');
    assert.equal(rel.json.size, 9);                       // '# 项目\n' = 1+1+3+3+1 字节
    assert.equal(rel.json.text, '# 项目\n');
    assert.equal(rel.json.truncated, false);
    assert.equal(rel.json.binary, false);
    const st = fs.statSync(rel.json.path, { bigint: true });
    assert.equal(rel.json.mtime, Math.trunc(Number(st.mtimeNs / 1000000000n)
      + Number(st.mtimeNs % 1000000000n) * 1e-9));

    // 两侧同名 ⇒ 项目目录优先；项目目录没有 ⇒ 落工作目录（rel 相对工作目录）
    const both = await get(fx.db, me, `/api/projects/${p.id}/file?path=both.txt`);
    assert.equal(both.json.text, 'from-project');
    assert.equal(both.json.root, 'project');
    const work = await get(fx.db, me, `/api/projects/${p.id}/file?path=free_style/INDEX.md`);
    assert.equal(work.json.root, 'work');
    assert.equal(work.json.rel, 'free_style/INDEX.md');
    assert.equal(work.json.text, 'index\n');

    // 绝对路径命中工作目录
    const abs = await get(fx.db, me,
      `/api/projects/${p.id}/file?path=${encodeURIComponent(path.join(p.casesRoot, 'INDEX.md'))}`);
    assert.equal(abs.json.root, 'work');
    assert.equal(abs.json.rel, 'free_style/INDEX.md');
  } finally {
    fx.close();
  }
});

test('/api/projects/<id>/file：empty/outside/dir/missing 四档与二进制、截断', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    fs.mkdirSync(path.join(p.projectDir, 'adir'));
    write(path.join(p.projectDir, 'big.txt'), 'x'.repeat(300 * 1024));
    write(path.join(p.projectDir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));

    const empty = await get(fx.db, me, `/api/projects/${p.id}/file?path=`);
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.json, { error: 'path 不能为空' });
    assert.equal(empty.body, '{"error": "path 不能为空"}');          // json.dumps 形态（带空格）
    const blank = await get(fx.db, me, `/api/projects/${p.id}/file?path=%20%20`);
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.json, { error: 'path 不能为空' });
    const outside = await get(fx.db, me, `/api/projects/${p.id}/file?path=%2Fetc%2Fhostname`);
    assert.equal(outside.status, 403);
    assert.deepEqual(outside.json, { error: '路径不在项目目录/工作目录范围内' });
    assert.equal(outside.body, '{"error": "路径不在项目目录/工作目录范围内"}');
    const dir = await get(fx.db, me, `/api/projects/${p.id}/file?path=adir`);
    assert.equal(dir.status, 400);
    assert.deepEqual(dir.json, { error: '该路径是目录，暂不支持预览' });
    const missing = await get(fx.db, me, `/api/projects/${p.id}/file?path=__nope__.txt`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: '文件不存在或不可读' });
    assert.equal(missing.body, '{"error": "文件不存在或不可读"}');

    const big = await get(fx.db, me, `/api/projects/${p.id}/file?path=big.txt`);
    assert.equal(big.json.truncated, true);
    assert.equal(big.json.text.length, 256 * 1024);
    assert.equal(big.json.size, 300 * 1024);
    assert.equal(big.json.binary, false);

    const bin = await get(fx.db, me, `/api/projects/${p.id}/file?path=bin.dat`);
    assert.equal(bin.json.binary, true);
    assert.equal(bin.json.text, '');
    assert.equal(bin.json.size, 5);

    // 他人项目：先过归属（404），不泄露路径存在性
    const other = makeProject(fx, { userId: 99 });
    const foreign = await get(fx.db, me, `/api/projects/${other.id}/file?path=README.md`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, { error: 'project not found' });
  } finally {
    fx.close();
  }
});

test('/api/projects/<id>/file?raw=1：文本 plain、二进制附件、超 32MiB 413、nosniff', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    const textFile = write(path.join(p.projectDir, 'r.txt'), 'hello\n');
    const binFile = write(path.join(p.projectDir, '图 像.dat'), Buffer.from([0x00, 0x01, 0x02]));

    const text = await get(fx.db, me, `/api/projects/${p.id}/file?path=r.txt&raw=1`);
    assert.equal(text.status, 200);
    assert.equal(text.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(text.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(text.headers['Cache-Control'], 'no-store');
    assert.equal(text.headers['Content-Length'], String(fs.statSync(textFile).size));
    assert.equal(text.body, 'hello\n');
    assert.equal(text.headers['Content-Disposition'], undefined);

    const bin = await get(fx.db, me,
      `/api/projects/${p.id}/file?path=${encodeURIComponent('图 像.dat')}&raw=1`);
    assert.equal(bin.status, 200);
    assert.equal(bin.headers['Content-Type'], 'application/octet-stream');
    // 非 ASCII 文件名：ASCII 兜底名 + RFC 5987 的 UTF-8 形态（Python `quote` 口径）
    assert.equal(bin.headers['Content-Disposition'],
      'attachment; filename="___.dat"; filename*=UTF-8\'\'%E5%9B%BE%20%E5%83%8F.dat');
    assert.deepEqual([...Buffer.from(bin.body, 'binary')], [0, 1, 2]);
    assert.equal(bin.headers['Content-Length'], String(fs.statSync(binFile).size));

    // 超 FILE_RAW_MAX(32MiB) ⇒ 413（用稀疏文件，秒级造出来）
    const huge = path.join(p.projectDir, 'huge.bin');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 33 * 1024 * 1024);
    const tooBig = await get(fx.db, me, `/api/projects/${p.id}/file?path=huge.bin&raw=1`);
    assert.equal(tooBig.status, 413);
    assert.deepEqual(tooBig.json, { error: '文件过大，无法按原文打开' });
    assert.equal(tooBig.body, '{"error": "文件过大，无法按原文打开"}');

    // raw 不认 0/false/其它值 ⇒ 走预览分支
    const notRaw = await get(fx.db, me, `/api/projects/${p.id}/file?path=r.txt&raw=0`);
    assert.equal(notRaw.status, 200);
    assert.equal(notRaw.json.text, 'hello\n');
  } finally {
    fx.close();
  }
});

test('/api/projects/<id>/file?inline=1：位图内联（无 attachment）、非位图 400、413、越界 403', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    // agent 产图的真实形态：工作区附件目录的子目录 + 任意文件名（不是 fid 形态）。
    // 字节用 ASCII + 一个 NUL（含 NUL ⇒ 预览档判 binary=true）：`get()` 的正文是 utf8 字符串，
    // 非 ASCII 二进制在这里不可逐字节断言（真 PNG 魔数的保真由 pytest 侧钉）。
    const PNG_BYTES = Buffer.from('PNGBYTES\u0000END', 'utf8');
    const png = write(path.join(p.workDir, 'board_media', 'batch', 'shot.png'), PNG_BYTES);
    const jpg = write(path.join(p.projectDir, 'shot.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const img = await get(fx.db, me,
      `/api/projects/${p.id}/file?path=${encodeURIComponent(png)}&inline=1`);
    assert.equal(img.status, 200);
    assert.equal(img.headers['Content-Type'], 'image/png');
    assert.equal(img.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(img.headers['Cache-Control'], 'no-store');
    // 内联档**不能**带 attachment —— 带了浏览器就不在 <img> 里渲染（等于没修）
    assert.equal(img.headers['Content-Disposition'], undefined);
    assert.equal(img.headers['Content-Length'], String(fs.statSync(png).size));
    assert.equal(img.body, PNG_BYTES.toString('utf8'));

    // 大写扩展名同档（`fileExt` 的 lower()）；工作目录相对路径也可寻址
    const upper = await get(fx.db, me, `/api/projects/${p.id}/file?path=shot.JPG&inline=1`);
    assert.equal(upper.status, 200);
    assert.equal(upper.headers['Content-Type'], 'image/jpeg');

    // 白名单是**位图**：html/svg/txt 一律 400（文案逐字，与 Python json.dumps 同口径带空格）
    write(path.join(p.projectDir, 'page.html'), '<script>alert(1)</script>');
    write(path.join(p.projectDir, 'pic.svg'), '<svg/>');
    for (const name of ['page.html', 'pic.svg', 'r.txt']) {
      if (name === 'r.txt') write(path.join(p.projectDir, 'r.txt'), 'hello\n');
      const bad = await get(fx.db, me, `/api/projects/${p.id}/file?path=${name}&inline=1`);
      assert.equal(bad.status, 400, name);
      assert.equal(bad.body, '{"error": "该类型不支持内联显示"}', name);
    }

    // 越界 403 / 缺失 404 / 目录 400：与预览档同一套 err 映射（inline 不改这三档）
    const outside = await get(fx.db, me, `/api/projects/${p.id}/file?path=../nope.png&inline=1`);
    assert.equal(outside.status, 403);
    const missing = await get(fx.db, me, `/api/projects/${p.id}/file?path=none.png&inline=1`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body, '{"error": "文件不存在或不可读"}');
    fs.mkdirSync(path.join(p.projectDir, 'pics'), { recursive: true });
    const dir = await get(fx.db, me, `/api/projects/${p.id}/file?path=pics&inline=1`);
    assert.equal(dir.status, 400);
    assert.equal(dir.json.error, '该路径是目录，暂不支持预览');

    // 超 FILE_RAW_MAX(32MiB) ⇒ 413（稀疏文件）
    const huge = path.join(p.projectDir, 'huge.png');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 33 * 1024 * 1024);
    const tooBig = await get(fx.db, me, `/api/projects/${p.id}/file?path=huge.png&inline=1`);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body, '{"error": "文件过大，无法内联显示"}');

    // 回归：不传 inline 时同一张图仍走 JSON 预览（binary=true），raw=1 仍是附件下载
    const preview = await get(fx.db, me, `/api/projects/${p.id}/file?path=${encodeURIComponent(png)}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.binary, true);
    const raw = await get(fx.db, me, `/api/projects/${p.id}/file?path=${encodeURIComponent(png)}&raw=1`);
    assert.equal(raw.headers['Content-Type'], 'application/octet-stream');
    assert.equal(raw.headers['Content-Disposition'].startsWith('attachment;'), true);
    void jpg;
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// bug 列表 / 详情
// --------------------------------------------------------------------------
test('/api/projects/<id>/bugs：扫描聚合 + 关联任务；详情含全文/关联用例/标题', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    write(path.join(p.bugRoot, '20260901_1010_FS_fix_me', 'bug_report.md'),
      '- **状态**: 待修复\n\n关联 FS0001 与 FS0002\n');
    write(path.join(p.bugRoot, '20260902_1111_FS_done', 'bug_report.md'),
      '- **状态**: 复测通过\n\n关联 FS0002\n');
    write(path.join(p.casesRoot, 'FS0001_a', 'status.md'),
      '- **状态**: 失败\n- **最近执行时间**: 2026-09-01 10:00\n- **失败原因**: 断言不符\n');
    write(path.join(p.casesRoot, 'FS0002_b', 'status.md'), '- **状态**: 通过\n');
    fx.db.prepare(
      'INSERT INTO tasks(project_id, name, task_type, status, current_round, session_id, error,'
      + ' payload, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(p.id, '修复任务', 'fix', 'done', 1, '', '', '{"bug_dir":"20260901_1010_FS_fix_me"}', '2026-09-03 00:00:00');

    const list = await get(fx.db, me, `/api/projects/${p.id}/bugs`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.map((b) => b.dir), ['20260901_1010_FS_fix_me', '20260902_1111_FS_done']);
    assert.equal(list.json[0].title, 'FS_fix_me');
    assert.deepEqual(list.json[0].cases, ['FS0001', 'FS0002']);
    assert.deepEqual(list.json[0].last_task,
      { id: 1, task_type: 'fix', name: '修复任务', status: 'done', created_at: '2026-09-03 00:00:00' });
    assert.equal(list.json[1].last_task, null);

    const detail = await get(fx.db, me, `/api/projects/${p.id}/bugs/20260901_1010_FS_fix_me`);
    assert.equal(detail.status, 200);
    assert.deepEqual(Object.keys(detail.json), ['dir', 'title', 'status', 'severity', 'cases', 'content', 'last_task']);
    assert.equal(detail.json.dir, '20260901_1010_FS_fix_me');
    assert.equal(detail.json.title, 'FS_fix_me');
    assert.equal(detail.json.status, '待修复');
    assert.equal(detail.json.content, '- **状态**: 待修复\n\n关联 FS0001 与 FS0002\n');
    assert.deepEqual(detail.json.cases, [
      { id: 'FS0001', name: 'a', status: '失败', last_run: '2026-09-01 10:00', fail_reason: '断言不符' },
      { id: 'FS0002', name: 'b', status: '通过', last_run: '', fail_reason: '' },
    ]);

    // `..` 段：Python `os.path.join` + `os.path.isdir` 会把它规范化掉 ⇒ bug_root 本身仍是目录
    // （这是 Python 侧既有行为，Node 侧照抄；`content` 取的是 bug_root/bug_report.md ⇒ 不存在 ⇒ 空）
    const dotdot = await get(fx.db, me, `/api/projects/${p.id}/bugs/20260901_1010_FS_fix_me%2F..`);
    assert.equal(dotdot.status, 200);
    assert.equal(dotdot.json.dir, '20260901_1010_FS_fix_me/..');
    assert.equal(dotdot.json.title, 'FS_fix_me/..');     // BUG_DIR_RE 只剥日期前缀
    assert.equal(dotdot.json.content, '');
    const missing = await get(fx.db, me, `/api/projects/${p.id}/bugs/__no_such__`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'bug not found' });
    assert.equal(missing.body, '{"error":"bug not found"}');          // 硬编码形态（无空格）

    // 项目不可见优先（多用户隔离）：他人项目 id ⇒ 404 project not found
    const other = makeProject(fx, { userId: 99 });
    const foreign = await get(fx.db, me, `/api/projects/${other.id}/bugs/whatever`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, { error: 'project not found' });
    const noProject = await get(fx.db, me, '/api/projects/999999/bugs/whatever');
    assert.deepEqual(noProject.json, { error: 'project not found' });
  } finally {
    fx.close();
  }
});

test('/api/projects/<id>/bugs/<dir>：bug_dir 段为绝对路径时按 os.path.join 覆盖（照抄 Python）', async () => {
  const fx = freshDb('route');
  try {
    const me = adminUser(fx.db);
    const p = makeProject(fx);
    // `bugs/%2Ftmp` → unquote 后是绝对路径；Python `os.path.join(bug_root, "/tmp") == "/tmp"`
    // ⇒ 只要 /tmp 是目录就 200（title 回显原串、content 取不到则空）。Node 侧必须同形。
    const r = await get(fx.db, me, `/api/projects/${p.id}/bugs/%2Ftmp`);
    assert.equal(r.status, 200);
    assert.equal(r.json.dir, '/tmp');
    assert.equal(r.json.title, '/tmp');
    assert.equal(r.json.status, '');
    assert.deepEqual(r.json.cases, []);
  } finally {
    fx.close();
  }
});
