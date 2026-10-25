/**
 * `backend/routes/board.js` 的 M5-4a 写端点单测（走**真路由表**：`makeContext` + `dispatch`）。
 *
 * 覆盖 8 条端点：建卡 2798 / 拖排 3041 / 回收站还原 3006 / 清空回收站 3031 / 标记已读 3069 /
 * 加评论 3295 / 删评论 3352 / 看板设置 3369（Python 行号见 `server.py`）。
 *
 * 为什么必须走真路由表而不是直接调 handler：
 *   - **分派顺序**：Python 的 do_POST/do_PATCH/do_DELETE 各是一条 if/elif 链，写端点与读端点
 *     在 `/board/*` 上有前缀重叠（`/board/cards/<id>` vs `/board/cards/<id>/viewed` 等），
 *     顺序错一条就会「POST 打到读端点」或 404；
 *   - **ctx 契约**：`ctx.ownedProject`（多用户隔离红线）与 `ctx.readBody` 的记忆化都在链路上；
 *   - **正文两种字节形态**：手写紧凑串（`{"ok":true}`）与 `json.dumps`（`{"ok": true}`）在这批
 *     端点里混用 —— 逐条断言**原始字节**，不 JSON.parse 之后再比（那会把差异抹平）。
 *
 * 期望值来源：`server.py` 对应 handler 逐行 + 真 Python 探针实测，不是读 Node 实现反推。
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertCard, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 假 res：捕获 status/headers/body 与 destroy */
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

/** 「像 IncomingMessage」的请求：有 headers + 一次性 body 流（`readJsonBody` 的调用面） */
function fakeReq(method, body, headers = {}) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = text.length
    ? { 'content-length': String(text.length), ...headers }
    : { ...headers };
  stream.method = method;
  return stream;
}

/** 一次夹具：临时库 + 一个项目（admin 所有）+ 另一个用户的项目（越权用） */
function setup(tag = 'board-route-write') {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, { userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir });
  fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES (?,?,?,?,?,?)').run(101, 'bob', 'x', '', 0, '2026-10-12 00:00:00');
  const pOther = insertProject(fx.db, {
    userId: 101, name: 'P-bob', projectDir: fx.dir, workDir: fx.dir,
  });
  const admin = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, pid, pOther, admin };
}

/** 走真路由表发一次请求 */
async function call(env, method, target, { body, user, headers = {} } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body, headers),
    res,
    db: env.db,
    user: user === undefined ? env.admin : user,
    path: target,
    search: '',
  });
  const hit = await dispatch(ctx);
  return {
    hit,
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

// --------------------------------------------------------------------------
// 建卡
// --------------------------------------------------------------------------

test('POST /board/cards：空标题也允许；落 todo 列尾；正文是卡 JSON（带空格口径）', async () => {
  const s = setup('create');
  const first = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`,
    { body: { title: '  第一张  ' } });
  assert.equal(first.json().title, '第一张');       // 两端 strip
  assert.equal(first.json().sort_order, 1);
  insertCard(s.db, s.pid, { title: 'existing', columnKey: 'todo' });
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`,
    { body: { title: '第二张', description: 'd', jira_key: 'J-1' } });
  assert.equal(r.status, 200);
  assert.equal(r.hit, true);
  const card = r.json();
  assert.equal(card.title, '第二张');
  assert.equal(card.column, 'todo');
  assert.equal(card.sort_order, 3);                 // 列尾 MAX+1（已两张：POST 一张 + 夹具一张）
  assert.equal(card.jira_key, 'J-1');
  assert.equal(r.text().includes('"column": "todo"'), true);   // pyJsonDumps 的 ", " 分隔

  const empty = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`, { body: {} });
  assert.equal(empty.status, 200);
  assert.equal(empty.json().title, '');             // 允许空标题建卡
  const num = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`,
    { body: { title: 123 } });
  assert.equal(num.json().title, '');               // 非字符串标题按缺失处理
  s.close();
});

test('POST /board/cards：标题按**码点**截 200（UTF-16 码元截断会切出半个 emoji）', async () => {
  const s = setup('create-cp');
  const title = '😀'.repeat(201);
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`, { body: { title } });
  const got = r.json().title;
  assert.equal(Array.from(got).length, 200);
  assert.equal(got, '😀'.repeat(200));
  s.close();
});

test('POST /board/cards：description/jira_key 真值非字符串 ⇒ 复刻 Python 的断连（无响应）', async () => {
  const s = setup('create-badtype');
  const r1 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`,
    { body: { title: 't', description: 5 } });
  assert.equal(r1.destroyed, true);
  assert.equal(r1.status, null);                    // Python `5[:20000]` ⇒ TypeError ⇒ 不响应
  const r2 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`,
    { body: { title: 't', jira_key: ['x'] } });
  assert.equal(r2.destroyed, true);
  // 空串/0/false 等**假值**走 `or ""` 分支，正常建卡（不是断连）
  const r3 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards`,
    { body: { title: 't', description: 0, jira_key: false } });
  assert.equal(r3.status, 200);
  assert.equal(r3.json().description, '');
  s.close();
});

test('POST /board/cards：项目不存在/他人项目 ⇒ 404 project not found（隔离红线）', async () => {
  const s = setup('create-404');
  const r1 = await call(s, 'POST', '/api/projects/999999/board/cards', { body: { title: 'x' } });
  assert.equal(r1.status, 404);
  assert.equal(r1.text(), '{"error":"project not found"}');
  const r2 = await call(s, 'POST', `/api/projects/${s.pOther}/board/cards`, { body: {} });
  assert.equal(r2.status, 404);                     // bob 的项目，admin 不可见
  s.close();
});

// --------------------------------------------------------------------------
// 列内拖排
// --------------------------------------------------------------------------

test('POST /board/reorder：card_id 缺失/非法 ⇒ 400 紧凑正文；成功 ⇒ 紧凑 {"ok":true}', async () => {
  const s = setup('reorder');
  const a = insertCard(s.db, s.pid, { title: 'A', columnKey: 'review', sortOrder: 1 });
  const b = insertCard(s.db, s.pid, { title: 'B', columnKey: 'review', sortOrder: 2 });
  s.db.prepare('INSERT OR REPLACE INTO board_settings(project_id, json) VALUES(?,?)')
    .run(s.pid, JSON.stringify({ sort: { review: 'manual' } }));

  const miss = await call(s, 'POST', `/api/projects/${s.pid}/board/reorder`, { body: {} });
  assert.equal(miss.status, 400);
  assert.equal(miss.text(), '{"error":"card_id required"}');   // 无空格
  const bad = await call(s, 'POST', `/api/projects/${s.pid}/board/reorder`,
    { body: { card_id: 'abc' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.text(), '{"error":"card_id required"}');

  const ok = await call(s, 'POST', `/api/projects/${s.pid}/board/reorder`,
    { body: { card_id: b, before_id: a } });
  assert.equal(ok.status, 200);
  assert.equal(ok.text(), '{"ok":true}');
  const rowB = s.db.prepare('SELECT sort_order FROM board_cards WHERE id=?').get(b);
  assert.equal(rowB.sort_order, 1);                 // b 排到 a 之前
  s.close();
});

test('POST /board/reorder：非 manual 列 ⇒ 400 带空格正文（json.dumps 口径）', async () => {
  const s = setup('reorder-mode');
  const a = insertCard(s.db, s.pid, { title: 'A', columnKey: 'review' });
  // 缺省 sort 五列里 review='manual'（board.py:52 SETTINGS_DEFAULT）⇒ 先改成非 manual 档
  s.db.prepare('INSERT OR REPLACE INTO board_settings(project_id, json) VALUES(?,?)')
    .run(s.pid, JSON.stringify({ sort: { review: 'updated_desc' } }));
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/reorder`,
    { body: { card_id: a, before_id: null } });
  assert.equal(r.status, 400);
  assert.equal(r.text(), '{"error": "当前列排序方案非手动，不可拖排"}');   // 带空格
  s.close();
});

// --------------------------------------------------------------------------
// 回收站
// --------------------------------------------------------------------------

test('POST /board/trash/<cid>/restore 与 /board/trash/empty', async () => {
  const s = setup('trash');
  const live = insertCard(s.db, s.pid, { title: 'L', columnKey: 'todo' });
  const dead = insertCard(s.db, s.pid, { title: 'D', columnKey: 'todo', trashed: 1, trashedAt: '2026-10-11 00:00:00' });
  const bad = await call(s, 'POST', `/api/projects/${s.pid}/board/trash/${live}/restore`);
  assert.equal(bad.status, 400);
  assert.equal(bad.text(), '{"error":"card not in trash"}');

  const ok = await call(s, 'POST', `/api/projects/${s.pid}/board/trash/${dead}/restore`);
  assert.equal(ok.status, 200);
  assert.equal(ok.text(), '{"ok":true}');
  assert.equal(s.db.prepare('SELECT trashed FROM board_cards WHERE id=?').get(dead).trashed, 0);

  const dead2 = insertCard(s.db, s.pid, { title: 'D2', columnKey: 'todo', trashed: 1, trashedAt: '2026-10-11 00:00:00' });
  const empty = await call(s, 'POST', `/api/projects/${s.pid}/board/trash/empty`);
  assert.equal(empty.status, 200);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM board_cards WHERE id=?').get(dead2).n, 0);
  s.close();
});

test('POST /board/trash/<cid>/restore：卡片不存在/他人项目 ⇒ 404 card not found', async () => {
  const s = setup('trash-404');
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/trash/999999/restore`);
  assert.equal(r.status, 404);
  assert.equal(r.text(), '{"error":"card not found"}');
  const foreign = insertCard(s.db, s.pOther, { title: 'X', trashed: 1 });
  const r2 = await call(s, 'POST', `/api/projects/${s.pid}/board/trash/${foreign}/restore`);
  assert.equal(r2.status, 404);
  s.close();
});

// --------------------------------------------------------------------------
// 标记已读
// --------------------------------------------------------------------------

test('POST /board/cards/<cid>/viewed：changed 反映本次是否真清了标记', async () => {
  const s = setup('viewed');
  const c = insertCard(s.db, s.pid, { title: 'U', unread: 1 });
  const r1 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/viewed`);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json(), { ok: true, unread: false, changed: true });
  const r2 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/viewed`);
  assert.deepEqual(r2.json(), { ok: true, unread: false, changed: false });
  assert.equal(s.db.prepare('SELECT unread FROM board_cards WHERE id=?').get(c).unread, 0);
  s.close();
});

// --------------------------------------------------------------------------
// 评论
// --------------------------------------------------------------------------

test('POST /board/cards/<cid>/comments：空文本 400；正常回评论 JSON；text 非字符串 ⇒ 断连', async () => {
  const s = setup('comment');
  const c = insertCard(s.db, s.pid, { title: 'C' });
  const empty = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/comments`,
    { body: { text: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.text(), '{"error":"text required"}');

  const ok = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/comments`,
    { body: { text: '  你好  ' } });
  assert.equal(ok.status, 200);
  const row = ok.json();
  assert.equal(row.card_id, c);
  assert.equal(row.text, '你好');                    // 两端 strip
  assert.equal(row.sent, false);
  assert.deepEqual(Object.keys(row),
    ['id', 'card_id', 'text', 'sent', 'session_id', 'sent_text', 'created_at']);

  const bad = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/comments`,
    { body: { text: 5 } });
  assert.equal(bad.destroyed, true);                // Python `5.strip()` ⇒ AttributeError ⇒ 断连
  s.close();
});

test('DELETE /board/cards/<cid>/comments/<comid>：不存在 404；存在即删；跨卡 id 拒绝', async () => {
  const s = setup('comment-del');
  const c1 = insertCard(s.db, s.pid, { title: 'C1' });
  const c2 = insertCard(s.db, s.pid, { title: 'C2' });
  const info = s.db.prepare('INSERT INTO board_comments(card_id, text, created_at)'
    + ' VALUES(?,?,?)').run(c2, '在 C2 上', '2026-10-11 00:00:00');
  const comid = Number(info.lastInsertRowid);

  const miss = await call(s, 'DELETE', `/api/projects/${s.pid}/board/cards/${c1}/comments/999999`);
  assert.equal(miss.status, 404);
  assert.equal(miss.text(), '{"error":"comment not found"}');
  // 评论 id 存在但属于另一张卡 ⇒ 同样 404（防跨卡删除）
  const cross = await call(s, 'DELETE', `/api/projects/${s.pid}/board/cards/${c1}/comments/${comid}`);
  assert.equal(cross.status, 404);

  const ok = await call(s, 'DELETE', `/api/projects/${s.pid}/board/cards/${c2}/comments/${comid}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.text(), '{"ok":true}');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM board_comments WHERE id=?').get(comid).n, 0);
  s.close();
});

// --------------------------------------------------------------------------
// 看板设置
// --------------------------------------------------------------------------

test('PATCH /board/settings：半合法字段合并、非法整份拒绝、返回合并后设置', async () => {
  const s = setup('settings');
  const r0 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/settings`, { body: {} });
  assert.equal(r0.status, 200);
  assert.equal(r0.json().mode, 'serial');                       // 缺省档

  const r1 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/settings`,
    { body: { mode: 'parallel', sync_sessions: false, jira: { url: 'u', token: 123 },
      sort: { review: 'manual' } } });
  assert.equal(r1.status, 200);
  const got = r1.json();
  assert.equal(got.mode, 'parallel');
  assert.equal(got.sync_sessions, false);
  assert.equal(got.jira.url, 'u');
  assert.equal(got.jira.token, '123');                          // str(123) ⇒ '123'
  assert.equal(got.sort.review, 'manual');
  assert.equal(got.sort.todo, 'manual');                        // 未给的列保留缺省

  const bad1 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/settings`,
    { body: { sort: { review: 'nope' } } });
  assert.equal(bad1.status, 400);
  assert.equal(bad1.text(), '{"error":"bad sort"}');
  const bad2 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/settings`,
    { body: { sort: { review: 'entered_desc' } } });             // entered_desc 仅 done 列
  assert.equal(bad2.status, 400);
  const bad3 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/settings`,
    { body: { sort: { nope: 'manual' } } });
  assert.equal(bad3.status, 400);
  const bad4 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/settings`,
    { body: { mode: 'readonly-parallel' } });                    // 已删档：静默忽略
  assert.equal(bad4.status, 200);
  assert.equal(bad4.json().mode, 'parallel');                    // 保持上一次落库值
  s.close();
});

test('PATCH /board/settings：项目不存在/他人项目 ⇒ 404', async () => {
  const s = setup('settings-404');
  const r = await call(s, 'PATCH', `/api/projects/${s.pOther}/board/settings`, { body: {} });
  assert.equal(r.status, 404);
  assert.equal(r.text(), '{"error":"project not found"}');
  s.close();
});

// --------------------------------------------------------------------------
// M5-4b：卡动作 / 删卡 / 投递评论 / compact·fork / worktree
// --------------------------------------------------------------------------

test('POST /board/cards/<cid>/(move|stop)：move 走门禁、stop 无运行时报 stopped=false', async () => {
  const s = setup('card-action');
  const c = insertCard(s.db, s.pid, { title: 'A', columnKey: 'todo' });
  const mv = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/move`,
    { body: { column: 'blocked', block_text: '等上游' } });
  assert.equal(mv.status, 200);
  assert.equal(mv.json().card.column, 'blocked');
  assert.equal(s.db.prepare('SELECT block_kind FROM board_cards WHERE id=?').get(c).block_kind,
    'manual');

  const st = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/stop`, { body: {} });
  assert.equal(st.status, 200);
  assert.deepEqual(st.json(), { ok: true, stopped: false });   // 没有在跑的会话 ⇒ 未停到

  const bad = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/999999/move`,
    { body: { column: 'todo' } });
  assert.equal(bad.status, 404);
  assert.equal(bad.text(), '{"error":"card not found"}');
  s.close();
});

test('POST /board/cards/<cid>/move：非法列 / doing→todo 硬错误走 400 带空格正文', async () => {
  const s = setup('card-action-400');
  const c = insertCard(s.db, s.pid, { title: 'A', columnKey: 'doing' });
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/move`,
    { body: { column: 'todo' } });
  assert.equal(r.status, 400);
  assert.equal(r.text(), '{"error": "doing 不可直接拖回 todo"}');
  const r2 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/move`,
    { body: { column: 'nope' } });
  assert.equal(r2.status, 400);
  assert.equal(r2.text(), '{"error": "bad column"}');
  s.close();
});

test('POST /board/cards/<cid>/start：归档项目 400；doing 非排队卡 400（当前状态不可开始）', async () => {
  const s = setup('card-start');
  const c = insertCard(s.db, s.pid, { title: 'A', columnKey: 'doing' });
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/start`, { body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.text(), '{"error":"当前状态不可开始"}');

  s.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(s.pid);
  const r2 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/start`, { body: {} });
  assert.equal(r2.status, 400);
  assert.equal(r2.text(), '{"error":"项目已归档"}');
  s.close();
});

test('DELETE /board/cards/<cid>：软删（trashed=1）+ 幂等清平台侧残留', async () => {
  const s = setup('card-delete');
  const c = insertCard(s.db, s.pid, { title: 'A', columnKey: 'done' });
  const r = await call(s, 'DELETE', `/api/projects/${s.pid}/board/cards/${c}`);
  assert.equal(r.status, 200);
  assert.equal(r.text(), '{"ok":true,"trashed":true}');
  const row = s.db.prepare('SELECT trashed, trashed_at FROM board_cards WHERE id=?').get(c);
  assert.equal(row.trashed, 1);
  assert.equal(row.trashed_at !== null, true);
  s.close();
});

test('DELETE /board/trash/<cid>：未在回收站 400；在回收站则真删（连带评论）', async () => {
  const s = setup('trash-purge');
  const live = insertCard(s.db, s.pid, { title: 'L' });
  const dead = insertCard(s.db, s.pid, { title: 'D', trashed: 1, trashedAt: '2026-10-11 00:00:00' });
  s.db.prepare('INSERT INTO board_comments(card_id, text, created_at) VALUES(?,?,?)')
    .run(dead, 'x', '2026-10-11 00:00:00');
  const bad = await call(s, 'DELETE', `/api/projects/${s.pid}/board/trash/${live}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.text(), '{"error":"card not in trash"}');
  const ok = await call(s, 'DELETE', `/api/projects/${s.pid}/board/trash/${dead}`);
  assert.equal(ok.status, 200);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM board_cards WHERE id=?').get(dead).n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM board_comments WHERE card_id=?')
    .get(dead).n, 0);
  s.close();
});

test('POST /board/cards/<cid>/comments/<comid>/send：评论不存在 404；存在的卡无会话 ⇒ 400', async () => {
  const s = setup('comment-send');
  const c = insertCard(s.db, s.pid, { title: 'C' });   // 无 session_id
  const info = s.db.prepare('INSERT INTO board_comments(card_id, text, created_at) VALUES(?,?,?)')
    .run(c, '发我', '2026-10-11 00:00:00');
  const comid = Number(info.lastInsertRowid);
  const miss = await call(s, 'POST',
    `/api/projects/${s.pid}/board/cards/${c}/comments/999999/send`, { body: {} });
  assert.equal(miss.status, 404);
  assert.equal(miss.text(), '{"error":"comment not found"}');
  const noSid = await call(s, 'POST',
    `/api/projects/${s.pid}/board/cards/${c}/comments/${comid}/send`, { body: {} });
  assert.equal(noSid.status, 400);                    // 无主会话 ⇒ deliverComment 业务拒绝
  assert.equal(noSid.text().startsWith('{"error": "'), true);   // 带空格形态
  s.close();
});

test('POST /board/cards/<cid>/(compact|fork|fork-compact)：缺 sid 400 紧凑体；无运行不 409', async () => {
  const s = setup('session-op');
  const c = insertCard(s.db, s.pid, { title: 'C' });   // 无 session_id
  for (const op of ['compact', 'fork', 'fork-compact']) {
    const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/${op}`, { body: {} });
    assert.equal(r.status, 400, `${op} 应 400`);
    assert.equal(r.text(), '{"error":"sid required"}');
  }
  // 传了 sid 但卡上没有该会话 ⇒ 业务拒绝（RuntimeError ⇒ 400 带空格）
  const r2 = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/fork`,
    { body: { sid: 'nope' } });
  assert.equal(r2.status, 400);
  assert.equal(r2.text().startsWith('{"error": "'), true);
  s.close();
});

test('DELETE /board/cards/<cid>/worktree：无 worktree 标记 ⇒ 400（worktree.remove 的拒绝）', async () => {
  const s = setup('wt-cleanup');
  const c = insertCard(s.db, s.pid, { title: 'C' });
  const r = await call(s, 'DELETE', `/api/projects/${s.pid}/board/cards/${c}/worktree`);
  assert.equal(r.status, 400);
  assert.equal(r.text().startsWith('{"error": "'), true);
  s.close();
});

test('POST /board/cards/<cid>/worktree/merge：无主会话 ⇒ 400 中文原因', async () => {
  const s = setup('wt-merge');
  const c = insertCard(s.db, s.pid, { title: 'C' });
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${c}/worktree/merge`,
    { body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.text(), '{"error": "该卡片尚无主会话，无法交给 agent 合并"}');
  s.close();
});

// --------------------------------------------------------------------------
// 英文模式（T10 审查 Important 1）：lib 层错误文案端到端英文化
// --------------------------------------------------------------------------

test('X-TS-Lang: en：拖排/移列/开始/清理 worktree 的 lib 错误都是英文', async () => {
  const s = setup('i18n-en');
  try {
    // 拖排：非 manual 列
    const a = insertCard(s.db, s.pid, { title: 'A', columnKey: 'review' });
    s.db.prepare('INSERT OR REPLACE INTO board_settings(project_id, json) VALUES(?,?)')
      .run(s.pid, JSON.stringify({ sort: { review: 'updated_desc' } }));
    const reorder = await call(s, 'POST', `/api/projects/${s.pid}/board/reorder`,
      { body: { card_id: a, before_id: null }, headers: { 'X-TS-Lang': 'en' } });
    assert.equal(reorder.status, 400);
    assert.equal(reorder.text(),
      '{"error": "This column does not use manual ordering, so drag reordering is unavailable"}');

    // 移列：doing → todo 硬错误
    const doing = insertCard(s.db, s.pid, { title: 'D', columnKey: 'doing' });
    const move = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${doing}/move`,
      { body: { column: 'todo' }, headers: { 'X-TS-Lang': 'en' } });
    assert.equal(move.status, 400);
    assert.equal(move.text(), '{"error": "A card cannot be dragged directly from doing back to todo"}');

    // 开始：运行位在场（runningMap 有条目）⇒ 忙拒绝
    const busy = insertCard(s.db, s.pid, { title: 'B', columnKey: 'todo' });
    board.runRegistry.set(busy, { proc: null });
    const start = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${busy}/start`,
      { body: {}, headers: { 'X-TS-Lang': 'en' } });
    assert.equal(start.status, 400);
    assert.equal(start.text(),
      '{"error": "The session is running; wait for it to finish or stop it first"}');

    // 清理 worktree：运行中 ⇒ 409
    const cleanup = await call(s, 'DELETE', `/api/projects/${s.pid}/board/cards/${busy}/worktree`,
      { headers: { 'X-TS-Lang': 'en' } });
    assert.equal(cleanup.status, 409);
    assert.equal(cleanup.text(),
      '{"error": "The session is running; stop the card before cleaning up the worktree"}');
    board.runRegistry.delete(busy);

    // 无头请求仍是中文（对拍/老客户端红线）
    const zh = await call(s, 'POST', `/api/projects/${s.pid}/board/reorder`,
      { body: { card_id: a, before_id: null } });
    assert.equal(zh.text(), '{"error": "当前列排序方案非手动，不可拖排"}');
  } finally {
    s.close();
  }
});
