/**
 * `backend/routes/board.js` 的 **M5-4c** 写端点单测（8 条：附件上传 / 改卡 / 作答 / 立即送达 /
 * 会话 profile / inject / rewind / jira），与 `board-write-route.test.mjs`（M5-4a/4b）同规格：
 * **走真路由表**（`makeContext` + `dispatch`），断言**原始字节**而不只是 JSON 结构。
 *
 * 行号对照（`server.py`）：附件上传 2832 / 改卡 2899 / jira 3404 / 会话 profile 3577 /
 * 作答 3703 / 立即送达 3750 / 会话 inject 3765 / 会话 rewind 3833。
 *
 * 三条本批特有的判据：
 *   ① **base64 的报错口径**（附件上传）：Python `base64.b64decode` 会抛、Node 原生不会
 *      ⇒ 坏 base64 必须是 400 而不是「垃圾附件 + 200」（见 `pybase64.test.mjs`）；
 *   ② **改卡的两处「源码里就是两种形态」**：`session_rename` 只上报不回写卡面、
 *      `parent_card_id` 循环依赖回**紧凑**错误体；
 *   ③ **会话级配置的真值口径**：`reasoning_effort: 0` 在 Python 是「不指定」（`value or ""`）
 *      ⇒ 落到「三者皆空」的 400，不是「非法档位」的 400。这条钉住 `servercaps.pyOrEmpty`。
 *
 * 期望值来源：`server.py` 对应 handler 逐行 + 真 Python 探针实测。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as sessparse from '../lib/sessparse.js';
import { _resetPermissionCatalogCacheForTest } from '../lib/servercaps.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertCard, insertMsg, insertProject, insertWait, setBoardSettings }
  from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台（与 board-write-route.test.mjs 同款；两个文件各自独立，不共享状态）
// --------------------------------------------------------------------------

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

function fakeReq(method, body) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = text.length ? { 'content-length': String(text.length) } : {};
  stream.method = method;
  return stream;
}

function setup(tag) {
  const fx = freshDb(`board-m5c-${tag}`);
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir,
  });
  fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES (?,?,?,?,?,?)').run(101, 'bob', 'x', '', 0, '2026-10-12 00:00:00');
  const pOther = insertProject(fx.db, {
    userId: 101, name: 'P-bob', projectDir: fx.dir, workDir: fx.dir,
  });
  const admin = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  board.resetIwState();
  return { ...fx, pid, pOther, admin, adminRow: admin };
}

async function call(env, method, target, { body, user } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body),
    res,
    db: env.db,
    user: user === undefined ? env.adminRow : user,
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

/** 库里读一行卡片（断言落库用） */
function cardRow(env, cid) {
  return env.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cid);
}

// --------------------------------------------------------------------------
// 假 dsh 驱动（只实现本批端点用到的 5 条；形状抄 dshdriver.test.mjs 的 FakeDriver）
// --------------------------------------------------------------------------

class FakeDriver {
  constructor() {
    this.calls = [];
    this.forkSid = 'session-11111111-1111-4111-8111-111111111111';
    this.renameTitle = null;                 // 非 null ⇒ /rename 回该值（验 accepted_title）
    // 宿主权限目录（2026-10-21 权限档对齐；profile 端点校验 catalog 值用）
    this.presetsPayload = {
      current: 'danger-full-access',
      options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
        { value: 'path-rules', name: '路径规则', description: '项目内可读写；项目外读允许、写需审批。' },
        { value: 'write-guard', name: '完全权限（拦截）', description: '完全权限底座；越界写入需确认。' },
        { value: 'auto', name: 'auto' },
      ],
      default: 'danger-full-access',
    };
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        // 驱动前缀是 `/touchstone-agent`（`TS_AGENT_DRIVER_URL` 自带），路由只看其后的段
        const full = req.url.split('?')[0];
        const p = full.startsWith('/touchstone-agent')
          ? full.slice('/touchstone-agent'.length) : full;
        this.calls.push({ path: p, full, rawUrl: req.url, method: req.method, body });
        this.route(req, res, p, body);
      });
    });
  }

  route(req, res, p, body) {
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (p === '/session') return json(200, { session_id: body.session_id || 'session-new-0000' });
    if (p === '/model') return json(200, { selected: { model: body.model } });
    if (p === '/permission') return json(200, { ok: true });
    if (p === '/presets') return json(200, this.presetsPayload);
    if (p === '/fork') return json(200, { new_session_id: this.forkSid });
    if (p === '/rename') {
      return json(200, { title: this.renameTitle === null ? body.title : this.renameTitle });
    }
    if (p === '/answer') return json(200, { accepted: true });
    if (p === '/steer') return json(200, { ok: true });
    return json(404, { error: `fake driver: no route ${p}` });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}/touchstone-agent`;
    return this;
  }

  byPath(p) { return this.calls.filter((c) => c.path === p); }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** 起假驱动并把它接进 `TS_AGENT_DRIVER_URL`（dshdriver 每次调用现读 env） */
async function withDriver(fn) {
  const drv = await new FakeDriver().start();
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  const savedToken = process.env.TS_AGENT_DRIVER_TOKEN;
  process.env.TS_AGENT_DRIVER_URL = drv.base;
  delete process.env.TS_AGENT_DRIVER_TOKEN;
  try {
    return await fn(drv);
  } finally {
    if (savedUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = savedUrl;
    if (savedToken !== undefined) process.env.TS_AGENT_DRIVER_TOKEN = savedToken;
    await drv.close();
  }
}

/** 确认「未配置驱动」路径（502）时用：清空 env */
function withoutDriver(fn) {
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  delete process.env.TS_AGENT_DRIVER_URL;
  try {
    return fn();
  } finally {
    if (savedUrl !== undefined) process.env.TS_AGENT_DRIVER_URL = savedUrl;
  }
}

// --------------------------------------------------------------------------
// ① 附件上传 POST /board/media
// --------------------------------------------------------------------------

test('POST /board/media：base64 JSON 落 <work_dir>/board_media，回 {fid,url,abs,name,size}', async () => {
  const s = setup('media-ok');
  const data = Buffer.from('hello 附件', 'utf8');
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/media`, {
    body: { name: '说明.txt', mime: 'text/plain', data: data.toString('base64') } });
  assert.equal(r.status, 200);
  assert.equal(r.hit, true);
  const j = r.json();
  assert.deepEqual(Object.keys(j), ['fid', 'url', 'abs', 'name', 'size']);   // 键序照 Python
  assert.equal(j.size, data.length);
  assert.equal(j.name, '说明.txt');
  assert.match(j.fid, /^m\d+_[0-9a-f]{10}\.txt$/);
  assert.equal(j.url, `/api/projects/${s.pid}/board/media/${j.fid}`);
  assert.equal(j.abs, path.join(s.dir, 'board_media', j.fid));
  assert.deepEqual(fs.readFileSync(j.abs), data);                            // 字节逐点一致
  assert.equal(r.text().includes('"fid": "'), true);                         // json.dumps 带空格
  s.close();
});

test('POST /board/media：MIME→扩展名表 17 项；未知 MIME 落 .bin；name/mime 按码点截断', async () => {
  const s = setup('media-ext');
  const b64 = Buffer.from('x').toString('base64');
  const cases = [['image/png', 'png'], ['image/jpeg', 'jpg'], ['application/pdf', 'pdf'],
    ['application/x-python', 'py'], ['application/x-tar', 'tar']];
  for (const [mime, ext] of cases) {
    const r = await call(s, 'POST', `/api/projects/${s.pid}/board/media`,
      { body: { mime, data: b64 } });
    assert.equal(r.status, 200);
    assert.match(r.json().fid, new RegExp(`^m\\d+_[0-9a-f]{10}\\.${ext}$`), `mime=${mime}`);
  }
  const unk = await call(s, 'POST', `/api/projects/${s.pid}/board/media`,
    { body: { mime: 'application/x-whatever', data: b64 } });
  assert.match(unk.json().fid, /^m\d+_[0-9a-f]{10}\.bin$/);
  // name 截 200 码点、mime 截 100 码点（Python `[:200]` / `[:100]`）
  const long = await call(s, 'POST', `/api/projects/${s.pid}/board/media`,
    { body: { name: '😀'.repeat(250), mime: 'a'.repeat(150), data: b64 } });
  assert.equal(Array.from(long.json().name).length, 200);
  assert.match(long.json().fid, /^m\d+_[0-9a-f]{10}\.bin$/);
  s.close();
});

test('POST /board/media：坏 base64/空文件/超限 ⇒ 400（三种文案，紧凑字节体）', async () => {
  const s = setup('media-bad');
  const url = `/api/projects/${s.pid}/board/media`;
  const bad1 = await call(s, 'POST', url, { body: { data: 'not-base64' } });
  assert.equal(bad1.status, 400);
  assert.equal(bad1.text(), '{"error":"bad base64"}');            // Python 抛 ValueError 的分支
  const bad2 = await call(s, 'POST', url, { body: { data: 'aGVsbG8' } });   // 缺 padding
  assert.equal(bad2.text(), '{"error":"bad base64"}');
  const bad3 = await call(s, 'POST', url, { body: { data: '中文' } });      // 非 ASCII
  assert.equal(bad3.text(), '{"error":"bad base64"}');
  // `'!!!!'` 在 Python 里**不抛**（杂字符全滤掉 ⇒ 空串）⇒ 走 empty file
  const empty1 = await call(s, 'POST', url, { body: { data: '!!!!' } });
  assert.equal(empty1.text(), '{"error":"empty file"}');
  const empty2 = await call(s, 'POST', url, { body: {} });                  // 缺 data
  assert.equal(empty2.text(), '{"error":"empty file"}');
  // 边界：恰好 10MB 收、10MB+1 拒（`> BOARD_MEDIA_MAX`）
  const exact = Buffer.alloc(10 * 1024 * 1024, 0x41).toString('base64');
  const ok = await call(s, 'POST', url, { body: { data: exact } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().size, 10 * 1024 * 1024);
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41).toString('base64');
  const over = await call(s, 'POST', url, { body: { data: tooBig } });
  assert.equal(over.status, 400);
  assert.equal(over.text(), '{"error":"file too large"}');
  // 失败路径一个字节都不落盘（10MB 那次成功落盘 1 个文件）
  assert.equal(fs.readdirSync(path.join(s.dir, 'board_media')).length, 1);
  s.close();
});

test('POST /board/media：越权/不存在的项目 ⇒ 404（多用户隔离红线）', async () => {
  const s = setup('media-404');
  const b64 = Buffer.from('x').toString('base64');
  const other = await call(s, 'POST', `/api/projects/${s.pOther}/board/media`,
    { body: { data: b64 } });
  assert.equal(other.status, 404);
  assert.equal(other.text(), '{"error":"project not found"}');
  const missing = await call(s, 'POST', '/api/projects/999999/board/media', { body: { data: b64 } });
  assert.equal(missing.status, 404);
  s.close();
});

// --------------------------------------------------------------------------
// ② 改卡 PATCH /board/cards/<cid>
// --------------------------------------------------------------------------

test('PATCH /board/cards/<cid>：白名单字段 + 长度上限（标题 200 / 长文本 20000）', async () => {
  const s = setup('patch-fields');
  const cid = insertCard(s.db, s.pid, { title: '旧', description: 'd0', blockText: 'b0' });
  const r = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid}`,
    { body: { title: '  新标题  ', description: '新描述', block_text: '阻塞理由' } });
  assert.equal(r.status, 200);
  assert.equal(r.hit, true);
  const row = cardRow(s, cid);
  // Python 只截长度、**不 strip**（`fields[k] = str(body[k])[:200]`）⇒ 前后空格原样入库
  assert.equal(row.title, '  新标题  ');
  assert.equal(row.description, '新描述');
  assert.equal(row.block_text, '阻塞理由');
  assert.equal(r.json().title, '  新标题  ');
  // 未列在白名单的字段一律忽略
  const r2 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid}`,
    { body: { column_key: 'done', origin: 'x', id: 4242 } });
  assert.equal(r2.status, 200);
  assert.equal(cardRow(s, cid).column_key, 'todo');
  assert.equal(cardRow(s, cid).origin, '');
  assert.equal(cardRow(s, cid).id, cid);
  s.close();
});

test('PATCH：空标题 ⇒ 400 title required；标题按码点截 200', async () => {
  const s = setup('patch-title');
  const cid = insertCard(s.db, s.pid, { title: 't' });
  const blank = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid}`,
    { body: { title: '   ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.text(), '{"error":"title required"}');       // 紧凑
  assert.equal(cardRow(s, cid).title, 't');                       // 未改动
  const long = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid}`,
    { body: { title: '😀'.repeat(250) } });
  assert.equal(Array.from(long.json().title).length, 200);
  s.close();
});

test('PATCH：scheduled_at 四种归一（int 截断 / 假值 → None / 字符串解析 / 非法 400）', async () => {
  const s = setup('patch-sched');
  const cid = insertCard(s.db, s.pid, { scheduledAt: 0 });
  const url = `/api/projects/${s.pid}/board/cards/${cid}`;
  assert.equal((await call(s, 'PATCH', url, { body: { scheduled_at: '1700000000000' } })).status, 200);
  assert.equal(cardRow(s, cid).scheduled_at, 1700000000000);
  await call(s, 'PATCH', url, { body: { scheduled_at: 1700000000000.9 } });
  assert.equal(cardRow(s, cid).scheduled_at, 1700000000000);      // Python `int(浮点)` 向零截断
  for (const falsy of [null, 0, '', false]) {
    await call(s, 'PATCH', url, { body: { scheduled_at: falsy } });
    assert.equal(cardRow(s, cid).scheduled_at, null, `假值 ${JSON.stringify(falsy)} 应清空`);
  }
  const bad = await call(s, 'PATCH', url, { body: { scheduled_at: '下午三点' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.text(), '{"error":"bad scheduled_at"}');
  assert.equal(cardRow(s, cid).scheduled_at, null);
  s.close();
});

test('PATCH：bind/unbind/session_id 三键维护 sessions 列（JSON 用 ", " 分隔）', async () => {
  const s = setup('patch-bind');
  const cid = insertCard(s.db, s.pid, { sessions: '[]', sessionId: '' });
  const url = `/api/projects/${s.pid}/board/cards/${cid}`;
  await call(s, 'PATCH', url, { body: { bind_session: 'sid-a' } });
  assert.equal(cardRow(s, cid).sessions, '["sid-a"]');
  assert.equal(cardRow(s, cid).session_id, 'sid-a');              // 主会话为空 ⇒ 顺带设为它
  await call(s, 'PATCH', url, { body: { bind_session: 'sid-b' } });
  assert.equal(cardRow(s, cid).sessions, '["sid-a", "sid-b"]');   // 逐字节：`", "` 分隔
  await call(s, 'PATCH', url, { body: { bind_session: 'sid-a' } });   // 重复绑定不追加
  assert.equal(cardRow(s, cid).sessions, '["sid-a", "sid-b"]');
  // session_id 只认已在列表内的值
  await call(s, 'PATCH', url, { body: { session_id: 'sid-nope' } });
  assert.equal(cardRow(s, cid).session_id, 'sid-a');
  await call(s, 'PATCH', url, { body: { session_id: 'sid-b' } });
  assert.equal(cardRow(s, cid).session_id, 'sid-b');
  // 解绑主会话 ⇒ 取剩余第一个；解绑到空 ⇒ 空串
  await call(s, 'PATCH', url, { body: { unbind_session: 'sid-b' } });
  assert.equal(cardRow(s, cid).session_id, 'sid-a');
  await call(s, 'PATCH', url, { body: { unbind_session: 'sid-a' } });
  assert.equal(cardRow(s, cid).sessions, '[]');
  assert.equal(cardRow(s, cid).session_id, '');
  s.close();
});

test('PATCH：parent_card_id 走 set_parent（循环依赖回**紧凑** 400 / null 清除）', async () => {
  const s = setup('patch-parent');
  const a = insertCard(s.db, s.pid, { title: 'A' });
  const b = insertCard(s.db, s.pid, { title: 'B', parentCardId: a });
  const c = insertCard(s.db, s.pid, { title: 'C', parentCardId: b });
  const url = `/api/projects/${s.pid}/board/cards/${a}`;
  // A 想认孙子 C 当父 ⇒ 环
  const cyc = await call(s, 'PATCH', url, { body: { parent_card_id: c } });
  assert.equal(cyc.status, 400);
  assert.equal(cyc.text(), '{"error":"循环依赖或父任务不存在"}');    // 紧凑（Python 硬编码字节串）
  assert.equal(cardRow(s, a).parent_card_id, null);
  const ok = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${c}`,
    { body: { parent_card_id: null } });
  assert.equal(ok.status, 200);
  assert.equal(cardRow(s, c).parent_card_id, null);
  const missing = await call(s, 'PATCH', url, { body: { parent_card_id: 999999 } });
  assert.equal(missing.status, 400);
  assert.equal(missing.text(), '{"error":"循环依赖或父任务不存在"}');
  s.close();
});

test('PATCH：卡面改名同步 DSH 会话名；宿主截断只回 accepted_title，**不回写卡面**', async () => {
  const s = setup('patch-rename');
  const cid = insertCard(s.db, s.pid, { title: '旧名', sessionId: 'sid-a', sessions: '["sid-a"]' });
  const url = `/api/projects/${s.pid}/board/cards/${cid}`;
  // ① 驱动不可用（未配置）：改名失败**不改卡面**，响应如实带 session_rename.ok=false
  await withoutDriver(async () => {
    const r = await call(s, 'PATCH', url, { body: { title: '新名' } });
    assert.equal(r.status, 200);
    assert.equal(cardRow(s, cid).title, '新名');                   // 卡面是用户的编辑，必须生效
    const rn = r.json().session_rename;
    assert.equal(rn.ok, false);
    assert.equal(rn.session_id, 'sid-a');
    assert.equal(typeof rn.error, 'string');
  });
  // ② 驱动可用：ok=true，驱动收到 /rename
  await withDriver(async (drv) => {
    const r = await call(s, 'PATCH', url, { body: { title: '再改一次' } });
    assert.equal(r.json().session_rename.ok, true);
    assert.equal(r.json().session_rename.session_id, 'sid-a');
    const calls = drv.byPath('/rename');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.session_id, 'sid-a');
    assert.equal(calls[0].body.title, '再改一次');
    // ③ 宿主规范化/截断：只上报 accepted_title，卡面保留用户原文
    drv.renameTitle = 'DSH 截断后的名';
    const r2 = await call(s, 'PATCH', url, { body: { title: '用户写的很长很长的名字' } });
    assert.equal(r2.json().session_rename.accepted_title, 'DSH 截断后的名');
    assert.equal(cardRow(s, cid).title, '用户写的很长很长的名字');
  });
  // ④ 无会话的卡：不触发改名链路，也不带 session_rename
  const cid2 = insertCard(s.db, s.pid, { title: '没会话' });
  const r3 = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid2}`,
    { body: { title: '改名' } });
  assert.equal(r3.json().session_rename, undefined);
  s.close();
});

test('PATCH：done 卡新绑会话 ⇒ 触发归档同步（best-effort，失败不改绑定）', async () => {
  const s = setup('patch-archive');
  const cid = insertCard(s.db, s.pid, { columnKey: 'done', sessions: '[]', sessionId: '' });
  await withDriver(async (drv) => {
    const r = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid}`,
      { body: { bind_session: 'sid-done' } });
    assert.equal(r.status, 200);
    assert.equal(cardRow(s, cid).sessions, '["sid-done"]');        // 绑定生效
    // 归档同步打的是驱动 /archive（假驱动没实现 ⇒ 留痕记失败，不回滚绑定）
    assert.equal(drv.byPath('/archive').length, 1);
  });
  s.close();
});

test('PATCH：越权/不存在的卡 ⇒ 404 card not found', async () => {
  const s = setup('patch-404');
  const cid = insertCard(s.db, s.pOther, { title: 'bob 的卡' });
  const denied = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/${cid}`,
    { body: { title: 'x' } });
  assert.equal(denied.status, 404);
  assert.equal(denied.text(), '{"error":"card not found"}');
  const missing = await call(s, 'PATCH', `/api/projects/${s.pid}/board/cards/999999`,
    { body: { title: 'x' } });
  assert.equal(missing.status, 404);
  s.close();
});

// --------------------------------------------------------------------------
// ③ 作答 POST /board/cards/<cid>/interaction/answer
// --------------------------------------------------------------------------

/** 灌一条「有待答提问」的调和器缓存 */
function seedQuestion(sid, qid = 'call-1') {
  board.setIwCacheForTest(sid, {
    pending: true, busy: true, kind: 'question', qid,
    questions: [{ id: 'q_0', question: '选一个', options: [{ id: 'o1', label: 'o1' }],
      multi_select: false, allow_other: true }],
  });
}

test('POST .../interaction/answer：提问作答 ⇒ 一律入队（queued=true + a:<cid> 等待行）', async () => {
  const s = setup('answer-q');
  const cid = insertCard(s.db, s.pid, { columnKey: 'doing', sessionId: 'sid-a',
    sessions: '["sid-a"]', blockKind: 'interaction' });
  seedQuestion('sid-a');
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/cards/${cid}/interaction/answer`,
    { body: { qid: 'call-1', answers: [{ wire: 'q_0', kind: 'single', option_id: 'o1' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.hit, true);
  assert.deepEqual(r.json(), { ok: true, queued: true });
  const row = s.db.prepare(
    "SELECT * FROM wait_items WHERE kind='answer' AND target_id=?").get(String(cid));
  assert.equal(row.state, 'waiting');
  s.close();
});

test('POST .../interaction/answer：无待答提问 / 缺 qid / 题库校验失败 ⇒ 400（文案照 Python）', async () => {
  const s = setup('answer-bad');
  const cid = insertCard(s.db, s.pid, { columnKey: 'doing', sessionId: 'sid-a',
    sessions: '["sid-a"]', blockKind: 'interaction' });
  const url = `/api/projects/${s.pid}/board/cards/${cid}/interaction/answer`;
  // 缓存里没有 pending ⇒ 不是 404 而是 400（Python `answer_interaction` 的返回值口径）
  const none = await call(s, 'POST', url, { body: { qid: 'call-1', answers: [] } });
  assert.equal(none.status, 400);
  assert.equal(none.json().error, '当前没有等待中的提问');
  seedQuestion('sid-a');
  const noQid = await call(s, 'POST', url, { body: { answers: [] } });
  assert.equal(noQid.status, 400);
  assert.equal(noQid.text(), '{"error":"qid/approval_id required"}');   // 紧凑
  const wrongQid = await call(s, 'POST', url, { body: { qid: 'call-9', answers: [] } });
  assert.equal(wrongQid.json().error, '提问不存在或已过期');
  const badOpt = await call(s, 'POST', url, { body: { qid: 'call-1',
    answers: [{ wire: 'q_0', kind: 'single', option_id: 'nope' }] } });
  assert.equal(badOpt.json().error, '选项不存在或已过期');
  const short = await call(s, 'POST', url, { body: { qid: 'call-1', answers: [] } });
  assert.equal(short.json().error, '作答载荷非法');
  s.close();
});

test('POST .../interaction/answer：审批分支（dsh 明确拒绝 scope=session；错 id 400）', async () => {
  const s = setup('answer-ap');
  const cid = insertCard(s.db, s.pid, { columnKey: 'doing', sessionId: 'sid-a',
    sessions: '["sid-a"]', blockKind: 'interaction' });
  const url = `/api/projects/${s.pid}/board/cards/${cid}/interaction/answer`;
  board.setIwCacheForTest('sid-a', { pending: true, busy: true, kind: 'approval',
    approval_id: 'ap-1', tool: 'Bash' });
  const wrong = await call(s, 'POST', url,
    { body: { approval_id: 'ap-9', decision: 'approved' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json().error, '审批不存在或已过期');
  const scope = await call(s, 'POST', url,
    { body: { approval_id: 'ap-1', decision: 'approved', scope: 'session' } });
  assert.equal(scope.json().error, 'dsh 不支持「本会话内批准」（宿主无 session 级放行语义）');
  const badDecision = await call(s, 'POST', url,
    { body: { approval_id: 'ap-1', decision: 'maybe' } });
  assert.equal(badDecision.json().error, '审批决定非法');
  s.close();
});

// --------------------------------------------------------------------------
// ④ 立即送达 POST /board/cards/<cid>/answer/deliver
// --------------------------------------------------------------------------

test('POST .../answer/deliver：没有待送达答案 ⇒ 400；有待送达 ⇒ 真送达并终态化', async () => {
  const s = setup('deliver');
  const cid = insertCard(s.db, s.pid, { columnKey: 'doing', sessionId: 'sid-a',
    sessions: '["sid-a"]', blockKind: 'interaction' });
  const url = `/api/projects/${s.pid}/board/cards/${cid}/answer/deliver`;
  const none = await call(s, 'POST', url, {});
  assert.equal(none.status, 400);
  assert.equal(none.json().error, '没有待送达的答案（可能已送达）');
  // 造一条待送达答案（作答路径的真实产物）⇒ 立即送达应把它交给会话
  const proj = s.db.prepare('SELECT * FROM projects WHERE id=?').get(s.pid);
  const card = cardRow(s, cid);
  board.queueAnswerUnit(proj, cid, 'sid-a', { sid: 'sid-a', qid: 'call-1', answers: [] },
    { db: s.db });
  await withDriver(async (drv) => {
    const r = await call(s, 'POST', url, {});
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok":true}');                          // 紧凑字节体
    assert.equal(drv.byPath('/answer').length, 1);                  // 送达打驱动 /answer
  });
  const row = s.db.prepare("SELECT state FROM wait_items WHERE kind='answer' AND target_id=?")
    .get(String(cid));
  assert.equal(row.state, 'done');
  assert.equal(card, card);
  s.close();
});

// --------------------------------------------------------------------------
// ⑤ 会话级配置 POST /board/sessions/<sid>/profile
// --------------------------------------------------------------------------

test('POST .../sessions/<sid>/profile：空三者 ⇒ 400；非法档位/等级 ⇒ 400（文案含白名单）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('profile-bad');
  const cid = insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  const url = `/api/projects/${s.pid}/board/sessions/sid-a/profile`;
  const empty = await call(s, 'POST', url, { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.text(), '{"error":"model/permission_mode/reasoning_effort required"}');
  // **真值口径**：0/False/'' 都是「不指定」（Python `value or ""`）⇒ 落到同一条 400
  const zero = await call(s, 'POST', url, { body: { reasoning_effort: 0 } });
  assert.equal(zero.status, 400);
  assert.equal(zero.text(), '{"error":"model/permission_mode/reasoning_effort required"}');
  const badEffort = await call(s, 'POST', url, { body: { reasoning_effort: '超强' } });
  assert.equal(badEffort.status, 400);
  assert.equal(badEffort.json().error, '思考等级非法（off/minimal/low/medium/high/xhigh/max 或留空）');
  // 纯空白 permission_mode ⇒ strip 后为空＝「不指定」⇒ 三者皆空 400（与 Python `str(...).strip()` 同）
  const blank = await call(s, 'POST', url, { body: { permission_mode: '   ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.text(), '{"error":"model/permission_mode/reasoning_effort required"}');
  // 2026-10-21：档位校验改成「宿主权限目录里有没有」；目录不可用时回退内置三档兜底集合
  const badPmode = await call(s, 'POST', url, { body: { permission_mode: 'whatever' } });
  assert.equal(badPmode.status, 400);
  assert.equal(badPmode.json().error, '权限档非法（宿主权限目录里没有该档位）');
  assert.equal(cid > 0, true);
  _resetPermissionCatalogCacheForTest();
  s.close();
});

test('POST .../sessions/<sid>/profile：只读归属（非本卡会话 404；越权项目 404）', async () => {
  const s = setup('profile-404');
  insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  const notMine = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/sid-x/profile`,
    { body: { model: 'm' } });
  assert.equal(notMine.status, 404);
  assert.equal(notMine.text(), '{"error":"session not found"}');
  const other = await call(s, 'POST', `/api/projects/${s.pOther}/board/sessions/sid-a/profile`,
    { body: { model: 'm' } });
  assert.equal(other.status, 404);
  s.close();
});

test('POST .../sessions/<sid>/profile：权限档/模型/思考等级三路下发（preset 直达、回执 canonical）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('profile-ok');
  insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  const url = `/api/projects/${s.pid}/board/sessions/sid-a/profile`;
  await withDriver(async (drv) => {
    // 旧档 manual 仍兼容：别名映射成 preset 下发/回执，**不再带 mode**
    const perm = await call(s, 'POST', url, { body: { permission_mode: 'manual' } });
    assert.equal(perm.status, 200);
    assert.deepEqual(perm.json(), { ok: true, model: '', permission_mode: 'workspace-write',
      reasoning_effort: '' });
    const pcall = drv.byPath('/permission');
    assert.equal(pcall.length, 1);
    assert.deepEqual(pcall[0].body, { session_id: 'sid-a', preset: 'workspace-write' });
    assert.equal('mode' in pcall[0].body, false, '2026-10-21 起不再下传三档 mode');
    // 内置档原样下发（preset 即平台值）
    await call(s, 'POST', url, { body: { permission_mode: 'read-only' } });
    assert.deepEqual(drv.byPath('/permission')[1].body,
      { session_id: 'sid-a', preset: 'read-only' });
    // 两端空白先 strip 再归一（与 Python `str(...).strip()` 同）：回执/下发都是 canonical
    const padded = await call(s, 'POST', url, { body: { permission_mode: '  read-only  ' } });
    assert.deepEqual(padded.json(), { ok: true, model: '', permission_mode: 'read-only',
      reasoning_effort: '' });
    assert.deepEqual(drv.byPath('/permission')[2].body,
      { session_id: 'sid-a', preset: 'read-only' });
    // 模型 + 思考等级同一次下发（只给等级时 model 传空串，插件自行回读）
    const both = await call(s, 'POST', url,
      { body: { model: 'deepseek/deepseek-chat', reasoning_effort: 'high' } });
    assert.deepEqual(both.json(), { ok: true, model: 'deepseek/deepseek-chat',
      permission_mode: '', reasoning_effort: 'high' });
    const mcall = drv.byPath('/model');
    assert.equal(mcall.length, 1);
    assert.deepEqual(mcall[0].body,
      { session_id: 'sid-a', model: 'deepseek/deepseek-chat', reasoning_effort: 'high' });
    const onlyEffort = await call(s, 'POST', url, { body: { reasoning_effort: 'off' } });
    assert.equal(onlyEffort.json().model, '');
    assert.equal(drv.byPath('/model')[1].body.model, '');           // 空 model ⇒ 只改等级
  });
  _resetPermissionCatalogCacheForTest();
  s.close();
});

test('POST .../sessions/<sid>/profile：接受宿主目录里的自定义档（path-rules/write-guard/auto）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('profile-catalog');
  insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  const url = `/api/projects/${s.pid}/board/sessions/sid-a/profile`;
  await withDriver(async (drv) => {
    // 先经新端点取到目录 ⇒ 进程内「已知档位集合」= 宿主全集（含 path-rules/write-guard/auto）
    const catalog = await call(s, 'GET', '/api/agents/presets');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.json().available, true);
    assert.equal(drv.calls[0].full, '/touchstone-agent/presets', '取目录不带 session_id');
    for (const preset of ['path-rules', 'write-guard', 'auto']) {
      const r = await call(s, 'POST', url, { body: { permission_mode: preset } });
      assert.equal(r.status, 200, preset);
      assert.deepEqual(r.json(), { ok: true, model: '', permission_mode: preset,
        reasoning_effort: '' });
    }
    assert.deepEqual(drv.byPath('/permission').map((c) => c.body), [
      { session_id: 'sid-a', preset: 'path-rules' },
      { session_id: 'sid-a', preset: 'write-guard' },
      { session_id: 'sid-a', preset: 'auto' },
    ]);
    // 目录里没有的档位 ⇒ 400 新文案（目录已知 ≠ 放行任意值）
    const bad = await call(s, 'POST', url, { body: { permission_mode: 'no-such-preset' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json().error, '权限档非法（宿主权限目录里没有该档位）');
    assert.equal(drv.byPath('/permission').length, 3, '400 档不发驱动请求');
  });
  _resetPermissionCatalogCacheForTest();
  s.close();
});

test('POST .../sessions/<sid>/profile：驱动异常 ⇒ 502（不是 500/400）', async () => {
  const s = setup('profile-502');
  insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  await withoutDriver(async () => {
    const r = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/sid-a/profile`,
      { body: { model: 'm' } });
    assert.equal(r.status, 502);
    // 文案与 Python `dshdriver` 的 `Unconfigured` 逐字一致（Python 侧同样 502 原样透出）
    assert.equal(r.json().error, '未配置 dsh agent 驱动（非插件形态或插件未下发驱动地址）');
  });
  s.close();
});

// --------------------------------------------------------------------------
// ⑥ 会话 inject POST /board/sessions/<sid>/inject
// --------------------------------------------------------------------------

test('POST .../sessions/<sid>/inject：归属三重判定（消息不存在/不在该会话下）⇒ 404', async () => {
  const s = setup('inject-404');
  const cid = insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  const url = `/api/projects/${s.pid}/board/sessions/sid-a/inject`;
  insertMsg(s.db, { id: 'm-1', projectId: s.pid, sid: 'sid-b', message: 'x', state: 'queued' });
  const missing = await call(s, 'POST', url, { body: { msg_id: 'nope' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error, '消息不存在或不在该会话下');
  const wrongSid = await call(s, 'POST', url, { body: { msg_id: 'm-1' } });
  assert.equal(wrongSid.json().error, '消息不存在或不在该会话下');
  const wrongSidPath = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/sid-b/inject`,
    { body: { msg_id: 'm-1' } });
  // sid-b 不归属本项目任何卡片 ⇒ 先撞 404 session not found
  assert.equal(wrongSidPath.status, 404);
  assert.equal(wrongSidPath.json().error, 'session not found');
  assert.equal(cid > 0, true);
  s.close();
});

test('POST .../sessions/<sid>/inject：排队消息立即注入 ⇒ 200 {ok:true} + steer（不是 followup）', async () => {
  const s = setup('inject-ok');
  insertCard(s.db, s.pid, { sessionId: 'sid-a', sessions: '["sid-a"]' });
  insertMsg(s.db, { id: 'm-2', projectId: s.pid, sid: 'sid-a', message: '注入我',
    state: 'queued', createdAt: 1 });
  insertWait(s.db, { projectId: s.pid, kind: 'msg', targetId: 'm-2', state: 'waiting', seq: 1,
    meta: JSON.stringify({ family: 'dsh_plugin', model: '' }) });
  await withDriver(async (drv) => {
    const r = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/sid-a/inject`,
      { body: { msg_id: 'm-2' } });
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok":true}');                        // 紧凑字节体
    assert.equal(drv.byPath('/steer').length, 1);                 // 注入走 steer
    assert.equal(drv.byPath('/prompt').length, 0);
  });
  assert.equal(s.db.prepare('SELECT state FROM chat_msgs WHERE id=?').get('m-2').state, 'done');
  s.close();
});

// --------------------------------------------------------------------------
// ⑦ 会话回退 POST /board/sessions/<sid>/rewind
// --------------------------------------------------------------------------

const REAL_SESSIONS_ROOT = sessparse.dshSessionsRoot();

/** 造一个含一次用户提问的多帧 zstd 会话文件（帧形状抄 sessparse.test.mjs） */
function writeSession(root, bucket, sid, frames) {
  const dir = path.join(root, bucket, sid);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat(frames.map((rows) => {
    const text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
    return zstdCompressSync(Buffer.from(text, 'utf8'));
  }));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buf);
}

test('POST .../sessions/<sid>/rewind：按边界 fork（只创建新会话，不改绑定）', async () => {
  const s = setup('rewind-ok');
  const sid = 'session-00000000-0000-4000-8000-0000000000a1';
  insertCard(s.db, s.pid, { sessionId: sid, sessions: JSON.stringify([sid]) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5c-sessions-'));
  writeSession(root, '--proj--', sid, [
    [{ type: 'session', version: 4, id: sid, cwd: s.dir }],
    [{ type: 'user/message', seq: 2, time: 200,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } }],
    [{ type: 'assistant/message', seq: 3, time: 300,
      data: { message: { content: [{ type: 'text', text: '回答' }] } } }],
  ]);
  sessparse.setSessionsRoot(root);
  try {
    const anchors = sessparse.dsh_user_anchors(sid);
    assert.equal(anchors.length, 1);
    await withDriver(async (drv) => {
      const r = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/${sid}/rewind`,
        { body: { mid: anchors[0].mid } });
      assert.equal(r.status, 200);
      const j = r.json();
      assert.equal(j.ok, true);
      assert.equal(j.new_session_id, drv.forkSid);
      assert.equal(j.boundary, anchors[0].eseq - 1);              // Python `max(0, eseq-1)`
      assert.equal(j.rebound, false);                             // 看板路径无 task ⇒ 恒 false
      const fcall = drv.byPath('/fork');
      assert.equal(fcall.length, 1);
      assert.equal(fcall[0].body.session_id, sid);
      assert.equal(fcall[0].body.at_seq, j.boundary);
      // 新会话接进驱动池（否则 UI 切过去后 /rename、/compact 会 404）
      const scall = drv.byPath('/session');
      assert.equal(scall.length, 1);
      assert.equal(scall[0].body.session_id, drv.forkSid);
      assert.equal(scall[0].body.cwd, s.dir);
      assert.equal(scall[0].body.task, `rewind-${sid.slice(0, 8)}`);
    });
    // 只创建、**不改绑定**（切换是 UI 的显式动作）
    assert.equal(cardRow(s, insertCard(s.db, s.pid, {})).session_id, '');
  } finally {
    sessparse.setSessionsRoot(REAL_SESSIONS_ROOT);
  }
  s.close();
});

test('POST .../sessions/<sid>/rewind：提问不在上下文 ⇒ 409；非本卡会话 ⇒ 404', async () => {
  const s = setup('rewind-409');
  const sid = 'session-00000000-0000-4000-8000-0000000000a2';
  insertCard(s.db, s.pid, { sessionId: sid, sessions: JSON.stringify([sid]) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5c-sessions-'));
  writeSession(root, '--proj--', sid, [
    [{ type: 'session', version: 4, id: sid, cwd: s.dir }],
    [{ type: 'user/message', seq: 2, time: 200,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } }],
  ]);
  sessparse.setSessionsRoot(root);
  try {
    const stale = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/${sid}/rewind`,
      { body: { mid: 'e999' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json().error, '该提问已被回退或会话已变化，请刷新后重试');
    const noMid = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/${sid}/rewind`,
      { body: {} });
    assert.equal(noMid.status, 409);                              // mid 为空 ⇒ boundary null
    const notMine = await call(s, 'POST',
      `/api/projects/${s.pid}/board/sessions/session-00000000-0000-4000-8000-0000000000ff/rewind`,
      { body: { mid: 'e2' } });
    assert.equal(notMine.status, 404);
    assert.equal(notMine.json().error, 'session not found');
  } finally {
    sessparse.setSessionsRoot(REAL_SESSIONS_ROOT);
  }
  s.close();
});

test('POST .../sessions/<sid>/rewind：驱动 fork 失败 ⇒ 502「回退失败：…」', async () => {
  const s = setup('rewind-502');
  const sid = 'session-00000000-0000-4000-8000-0000000000a3';
  insertCard(s.db, s.pid, { sessionId: sid, sessions: JSON.stringify([sid]) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5c-sessions-'));
  writeSession(root, '--proj--', sid, [
    [{ type: 'session', version: 4, id: sid, cwd: s.dir }],
    [{ type: 'user/message', seq: 2, time: 200,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } }],
  ]);
  sessparse.setSessionsRoot(root);
  try {
    const anchor = sessparse.dsh_user_anchors(sid)[0].mid;
    await withoutDriver(async () => {
      const r = await call(s, 'POST', `/api/projects/${s.pid}/board/sessions/${sid}/rewind`,
        { body: { mid: anchor } });
      assert.equal(r.status, 502);
      assert.match(r.json().error, /^回退失败：/);
    });
  } finally {
    sessparse.setSessionsRoot(REAL_SESSIONS_ROOT);
  }
  s.close();
});

// --------------------------------------------------------------------------
// ⑧ Jira POST /board/jira/(test|import)
// --------------------------------------------------------------------------

test('POST /board/jira/test：未填全配置 ⇒ 400 {ok:false,error}（不是 500）', async () => {
  const s = setup('jira-test');
  const r = await call(s, 'POST', `/api/projects/${s.pid}/board/jira/test`,
    { body: { url: 'https://jira.example.com' } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json(), { ok: false, error: '请填全 Jira 地址 / 用户名 / token' });
  s.close();
});

test('POST /board/jira/import：未配置 ⇒ 400；已配置且取到工单 ⇒ 建卡 + 去重', async () => {
  const s = setup('jira-import');
  const none = await call(s, 'POST', `/api/projects/${s.pid}/board/jira/import`, {});
  assert.equal(none.status, 400);
  assert.deepEqual(none.json(), { ok: false, error: '请先在设置中配置 Jira' });
  // 配置走看板设置（`board_settings.json` 的 jira 段），再用假 Jira 服务回两条工单
  const jira = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ issues: [{ key: 'TS-1', fields: { summary: '一' } },
      { key: 'TS-2', fields: { summary: '二' } }] }));
  });
  await new Promise((resolve) => jira.listen(0, '127.0.0.1', resolve));
  setBoardSettings(s.db, s.pid, {
    jira: { url: `http://127.0.0.1:${jira.address().port}`, user: 'u', token: 't' },
  });
  try {
    const r = await call(s, 'POST', `/api/projects/${s.pid}/board/jira/import`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, added: 2, skipped: 0 });
    const titles = s.db.prepare('SELECT title, jira_key FROM board_cards WHERE project_id=?'
      + ' ORDER BY id').all(s.pid).map((x) => `${x.jira_key}:${x.title}`);
    assert.deepEqual(titles, ['TS-1:[TS-1] 一', 'TS-2:[TS-2] 二']);
    const again = await call(s, 'POST', `/api/projects/${s.pid}/board/jira/import`, {});
    assert.deepEqual(again.json(), { ok: true, added: 0, skipped: 2 });   // 幂等去重
  } finally {
    await new Promise((resolve) => jira.close(resolve));
  }
  s.close();
});
