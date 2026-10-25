/**
 * Task 10：Node 错误响应按请求语言本地化 —— ctx 单点收口的验收测试。
 *
 * 覆盖三件事：
 *   ① **字节形状不变**：无语言信号（老客户端/对拍器）时，紧凑 `{"error":"…"}` 与
 *      带空格 `{"error": "…"}` 两种正文逐字节保持中文原文（`Content-Type`/`Content-Length`
 *      也一并断言）；语言由 `X-TS-Lang` / `?lang=` / 用户偏好 / `TS_I18N=0` 决定；
 *   ② **词条覆盖可验证**：静态扫描 `backend/routes/*.js` 与 `backend/server.js` 里所有
 *      「传给 ctx.error/ctx.errorSpaced 的中文文案」（含三元默认值、错误码消息表、常量），
 *      逐条要求 `i18n/en.json` 的 `api` 命名空间有对应词条，缺一条即列出并失败；
 *   ③ **翻译不破坏插值**：带 `{name}` 占位符的词条在中文侧还原原文、英文侧按同一占位符插值。
 *
 * 为什么走真 `makeContext()`/`dispatch()`：本任务的价值就在「单点收口」——如果测试绕过
 * ctx 直接调 `respondError`，就测不到「所有写点都真的经过本地化」这件事。路由用例因此
 * 用真路由表 + 临时库（m3fixture），不碰生产库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';

import { loadDict, resetCache } from '../lib/i18n.js';
import { LIB_USER_MESSAGE_SOURCES } from '../lib/user-messages.js';
import { dispatch, makeContext, respondMustChangePassword } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const ROUTES_DIR = path.join(REPO_ROOT, 'backend', 'routes');
const HAN = /[\u4e00-\u9fff]/;

let tmpRoot = '';
beforeEach(() => {
  delete process.env.TS_I18N;
  resetCache();
});
after(() => {
  delete process.env.TS_I18N;
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 临时目录（本文件内的项目目录/文件用例共用一棵，after 时整棵删掉） */
function tmpDir(tag) {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-i18n-ctx-'));
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 响应桩：只实现 `respond()` 用到的 writeHead/end。
 * `chunks` 保留原始字节，便于做「逐字节」断言而不是解析后的值比较。
 */
function makeRes() {
  const state = { status: 0, headers: {}, chunks: [], writeHeads: 0, ended: false };
  return {
    state,
    writeHead(status, headers) {
      state.writeHeads += 1;
      state.status = status;
      state.headers = { ...(headers || {}) };
    },
    end(chunk) {
      state.ended = true;
      if (chunk !== undefined && chunk !== null) state.chunks.push(Buffer.from(chunk));
    },
  };
}

/** 构造一次请求的 ctx（真 makeContext；`headers` 缺省 = 无语言信号） */
function newCtx({ headers = {}, user = null, db = null, target = '/api/x', method = 'GET' } = {}) {
  const idx = target.indexOf('?');
  const pathname = idx < 0 ? target : target.slice(0, idx);
  const search = idx < 0 ? '' : target.slice(idx + 1);
  const res = makeRes();
  const ctx = makeContext({
    req: { method, headers }, res, db, user, path: pathname, search, trusted: false,
  });
  return { ctx, res };
}

/** 取响应正文（UTF-8 字符串，断言对象是字节序列时另用 raw 比较） */
function bodyOf(res) {
  return Buffer.concat(res.state.chunks).toString('utf8');
}

/** 断言「状态码 + Content-Type + 正文逐字节」，并确认只写过一次响应头 */
function assertResponse(res, status, expectedBody) {
  const raw = Buffer.concat(res.state.chunks);
  assert.equal(res.state.status, status);
  assert.equal(res.state.writeHeads, 1);
  assert.equal(res.state.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.state.headers['Content-Length'], String(Buffer.byteLength(expectedBody)));
  assert.deepEqual(raw, Buffer.from(expectedBody, 'utf8'));
}

// --------------------------------------------------------------------------
// ① 无语言信号：存量行为逐字节不变（这是对拍/老客户端不回归的硬判据）
// --------------------------------------------------------------------------

test('无语言信号：紧凑错误体逐字节保持中文（含 Content-Type/Length）', () => {
  const { ctx, res } = newCtx();
  assert.equal(ctx.lang, 'zh');
  ctx.error(400, 'key 非法');
  assertResponse(res, 400, '{"error":"key 非法"}');
});

test('无语言信号：带空格错误体逐字节保持中文（含 Content-Type/Length）', () => {
  const { ctx, res } = newCtx();
  ctx.errorSpaced(400, 'key 非法');
  assertResponse(res, 400, '{"error": "key 非法"}');
});

// --------------------------------------------------------------------------
// ② 语言解析：X-TS-Lang / 变体 / 非法值 / 回滚开关
// --------------------------------------------------------------------------

test('X-TS-Lang: en：紧凑体与带空格体都输出英文', () => {
  const compact = newCtx({ headers: { 'X-TS-Lang': 'en' } });
  assert.equal(compact.ctx.lang, 'en');
  compact.ctx.error(400, 'key 非法');
  assertResponse(compact.res, 400, '{"error":"Invalid key"}');

  const spaced = newCtx({ headers: { 'x-ts-lang': 'EN' } });
  spaced.ctx.errorSpaced(400, '请填写拒绝理由');
  assertResponse(spaced.res, 400, '{"error": "Please provide a rejection reason"}');
});

test('X-TS-Lang 变体：zh-CN 归一中，en-US 归一英', () => {
  const zh = newCtx({ headers: { 'X-TS-Lang': 'zh-CN' } });
  zh.ctx.errorSpaced(400, 'key 非法');
  assertResponse(zh.res, 400, '{"error": "key 非法"}');

  const en = newCtx({ headers: { 'X-TS-Lang': 'en-US' } });
  en.ctx.error(400, 'key 非法');
  assertResponse(en.res, 400, '{"error":"Invalid key"}');
});

test('非法头值 / 畸形头值：不抛错且回落中文', () => {
  for (const value of ['xx', '', 'fr-FR', { toString() { throw new Error('boom'); } }]) {
    const { ctx, res } = newCtx({ headers: { 'X-TS-Lang': value } });
    assert.equal(ctx.lang, 'zh');
    ctx.errorSpaced(400, 'key 非法');
    assertResponse(res, 400, '{"error": "key 非法"}');
  }
});

test('?lang=en 生效；非法 ?lang 继续回落', () => {
  const en = newCtx({ target: '/api/x?lang=en' });
  en.ctx.error(400, 'key 非法');
  assertResponse(en.res, 400, '{"error":"Invalid key"}');

  const bad = newCtx({ target: '/api/x?lang=xx' });
  assert.equal(bad.ctx.lang, 'zh');
});

test('TS_I18N=0 时即使 X-TS-Lang: en 也恒中文（回滚开关）', () => {
  process.env.TS_I18N = '0';
  try {
    const { ctx, res } = newCtx({ headers: { 'X-TS-Lang': 'en' } });
    assert.equal(ctx.lang, 'zh');
    ctx.error(400, 'key 非法');
    assertResponse(res, 400, '{"error":"key 非法"}');
  } finally {
    delete process.env.TS_I18N;
  }
});

// --------------------------------------------------------------------------
// ③ 用户偏好兜底：user_prefs(project_id=0, key='lang', value={"v":"en"})
// --------------------------------------------------------------------------

test('无头时 userPref 兜底为英文；显式头仍优先于偏好', () => {
  const fx = freshDb('i18nctx-pref');
  try {
    const user = fx.db.prepare("SELECT * FROM users WHERE username='admin'").get();
    fx.db.prepare(
      'INSERT INTO user_prefs(user_id, project_id, key, value, updated_at) VALUES(?,?,?,?,?)',
    ).run(user.id, 0, 'lang', '{"v":"en"}', '2026-10-22 00:00:00');

    const byPref = newCtx({ user, db: fx.db });
    assert.equal(byPref.ctx.lang, 'en');
    byPref.ctx.errorSpaced(404, '文件不存在或不可读');
    assertResponse(byPref.res, 404, '{"error": "File does not exist or is not readable"}');

    const byHeader = newCtx({ user, db: fx.db, headers: { 'X-TS-Lang': 'zh' } });
    assert.equal(byHeader.ctx.lang, 'zh');
    byHeader.ctx.errorSpaced(404, '文件不存在或不可读');
    assertResponse(byHeader.res, 404, '{"error": "文件不存在或不可读"}');
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// ④ 真路由分派：404 端点的错误文案也按请求语言输出
// --------------------------------------------------------------------------

test('真分派 GET /api/projects/<id>/file：无头中文、en 英文（404 路由）', async () => {
  const fx = freshDb('i18nctx-route');
  try {
    const user = fx.db.prepare("SELECT * FROM users WHERE username='admin'").get();
    const projectDir = tmpDir('proj');
    const projectId = insertProject(fx.db, { userId: user.id, name: 'p', projectDir });
    const target = `/api/projects/${projectId}/file?path=missing.txt`;

    const zhReq = newCtx({ user, db: fx.db, target });
    assert.equal(await dispatch(zhReq.ctx), true);
    assertResponse(zhReq.res, 404, '{"error": "文件不存在或不可读"}');

    const enReq = newCtx({ user, db: fx.db, target, headers: { 'X-TS-Lang': 'en' } });
    assert.equal(await dispatch(enReq.ctx), true);
    assertResponse(enReq.res, 404, '{"error": "File does not exist or is not readable"}');
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// ⑤ 非字符串 message：保留 String(message) 强制转换语义
// --------------------------------------------------------------------------

test('非字符串 message 保持 String() 语义，且不受语言影响', () => {
  const cases = [
    [123, '{"error":"123"}'],
    [null, '{"error":"null"}'],
    [true, '{"error":"true"}'],
    [{ toString() { return '对象'; } }, '{"error":"对象"}'],
  ];
  for (const [message, expected] of cases) {
    const { ctx, res } = newCtx({ headers: { 'X-TS-Lang': 'en' } });
    ctx.error(400, message);
    assertResponse(res, 400, expected);
  }
});

// --------------------------------------------------------------------------
// ⑥ 带占位符词条：中文侧还原原文、英文侧同占位符插值
// --------------------------------------------------------------------------

test('占位符词条 {name}：中文复原原文、英文按同一变量插值', () => {
  const zh = newCtx();
  zh.ctx.errorSpaced(404, '未知资产：{id}', { id: 'foo' });
  assertResponse(zh.res, 404, '{"error": "未知资产：foo"}');

  const en = newCtx({ headers: { 'X-TS-Lang': 'en' } });
  en.ctx.errorSpaced(404, '未知资产：{id}', { id: 'foo' });
  assertResponse(en.res, 404, '{"error": "Unknown asset: foo"}');
});

test('en 但词条缺失：回落中文原文（绝不输出空串）', () => {
  const { ctx, res } = newCtx({ headers: { 'X-TS-Lang': 'en' } });
  ctx.error(400, '该动态文案没有英文词条');
  assertResponse(res, 400, '{"error":"该动态文案没有英文词条"}');
});

// --------------------------------------------------------------------------
// ⑧ requestLang 读库顺序（T10 审查 Minor 3）：显式信号命中 ⇒ 不读 user_prefs；
//    无显式信号才读一次；TS_I18N=0 连偏好都不读；成功请求零偏好查询。
// --------------------------------------------------------------------------

/**
 * 包一层真库句柄：只统计 `user_prefs` 的 prepare 次数（其余方法原样转发）。
 * 为什么数 SQL 而不是 spy 模块函数：ESM 命名空间只读，`dbmod.getUserPrefs` 无法替换；
 * 从 `db.prepare` 这个真实调用面数最贴近「到底读没读库」。
 */
function countedDb(db) {
  const stats = { prefReads: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          if (String(sql).includes('user_prefs')) stats.prefReads += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, stats };
}

/** 带 en 偏好的夹具用户（返回 user 行与计数 db） */
function prefEnFixture(tag) {
  const fx = freshDb(tag);
  const user = fx.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  fx.db.prepare(
    'INSERT INTO user_prefs(user_id, project_id, key, value, updated_at) VALUES(?,?,?,?,?)',
  ).run(user.id, 0, 'lang', '{"v":"en"}', '2026-10-22 00:00:00');
  const { db, stats } = countedDb(fx.db);
  return { fx, user, db, stats };
}

test('requestLang：头/query 命中 ⇒ 不读偏好；?lang= 压过偏好；同请求只解析一次', () => {
  const { fx, user, db, stats } = prefEnFixture('i18nctx-requestlang');
  try {
    const byHeader = newCtx({ user, db, headers: { 'X-TS-Lang': 'zh' } });
    assert.equal(byHeader.ctx.lang, 'zh');
    assert.equal(stats.prefReads, 0, '显式头命中不该读 user_prefs');

    const byQuery = newCtx({ user, db, target: '/api/x?lang=zh' });
    assert.equal(byQuery.ctx.lang, 'zh');
    assert.equal(stats.prefReads, 0, '显式 query 命中不该读 user_prefs');

    const byPref = newCtx({ user, db });
    assert.equal(byPref.ctx.lang, 'en');
    assert.equal(stats.prefReads, 1, '无显式信号才读一次偏好');

    const once = newCtx({ user, db });
    assert.equal(once.ctx.lang, 'en');
    assert.equal(once.ctx.lang, 'en');
    assert.equal(once.ctx.lang, 'en');
    assert.equal(stats.prefReads, 2, '同一请求的多次读只解析一次（相对上一次 +1）');
  } finally {
    fx.close();
  }
});

test('TS_I18N=0：即使有偏好也不读 user_prefs，恒中文', () => {
  const { fx, user, db, stats } = prefEnFixture('i18nctx-requestlang-off');
  process.env.TS_I18N = '0';
  try {
    const c = newCtx({ user, db });
    assert.equal(c.ctx.lang, 'zh');
    assert.equal(stats.prefReads, 0, '回滚开关下不读偏好');
  } finally {
    delete process.env.TS_I18N;
    fx.close();
  }
});

test('成功请求零偏好查询（惰性解析只在真需要语言时发生）', async () => {
  const { fx, user, db, stats } = prefEnFixture('i18nctx-requestlang-zero');
  try {
    // GET /api/projects 成功路径不读 ctx.lang；错误路径也不会被触发
    const req = newCtx({ user, db, target: '/api/projects' });
    assert.equal(await dispatch(req.ctx), true);
    assert.equal(req.res.state.status, 200);
    assert.equal(stats.prefReads, 0, '成功请求不该为语言多读一次 user_prefs');
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// ⑨ 强制改密 403（server.js:186 的响应半边）：语言口径与 ctx.error 完全一致
// --------------------------------------------------------------------------

test('强制改密 403：头/query/偏好/回滚开关四个维度与 ctx.error 同口径', () => {
  const { fx, user, db, stats } = prefEnFixture('i18nctx-forced-pw');
  const gated = { ...user, must_change_pw: 1 };
  try {
    const respond = ({ headers = {}, search = '' } = {}) => {
      const res = makeRes();
      respondMustChangePassword(res, { req: { headers }, db, user: gated, search });
      return bodyOf(res);
    };

    // 无显式信号 ⇒ 偏好 en
    assert.equal(respond(), '{"error":"Please change the initial password first"}');
    assert.equal(stats.prefReads, 1);
    // 头压过偏好，且不读库
    assert.equal(respond({ headers: { 'X-TS-Lang': 'zh' } }), '{"error":"请先修改初始口令"}');
    assert.equal(stats.prefReads, 1);
    // query 压过偏好，且不读库
    assert.equal(respond({ search: 'lang=en' }), '{"error":"Please change the initial password first"}');
    assert.equal(stats.prefReads, 1);
    // 回滚开关：即使头是 en 也中文，且不读库
    process.env.TS_I18N = '0';
    try {
      assert.equal(respond({ headers: { 'X-TS-Lang': 'en' } }), '{"error":"请先修改初始口令"}');
    } finally {
      delete process.env.TS_I18N;
    }
    assert.equal(stats.prefReads, 1);
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// ⑩ 两种错误体形状的其余边界：errorSpaced 的非字符串 coercion；三种 lib 值的字节形状
// --------------------------------------------------------------------------

test('errorSpaced 的非字符串 message 同样保持 String() 语义（带空格形状）', () => {
  const cases = [
    [123, '{"error": "123"}'],
    [null, '{"error": "null"}'],
    [true, '{"error": "true"}'],
    [{ toString() { return '对象'; } }, '{"error": "对象"}'],
  ];
  for (const [message, expected] of cases) {
    const { ctx, res } = newCtx({ headers: { 'X-TS-Lang': 'en' } });
    ctx.errorSpaced(400, message);
    assertResponse(res, 400, expected);
  }
});

test('key+vars 契约：messageVars 对象与带 i18nKey 的错误都按请求语言渲染', () => {
  const { ctx, res } = newCtx({ headers: { 'X-TS-Lang': 'en' } });
  ctx.errorSpaced(400, { message: '未知资产：{id}', vars: { id: 'foo' } });
  assertResponse(res, 400, '{"error": "Unknown asset: foo"}');

  const err = new Error('新建失败：disk full');
  err.i18nKey = '新建失败：{detail}';
  err.i18nVars = { detail: 'disk full' };
  const second = newCtx({ headers: { 'X-TS-Lang': 'en' } });
  second.ctx.errorSpaced(400, err);
  assertResponse(second.res, 400, '{"error": "Failed to create: disk full"}');
});

// --------------------------------------------------------------------------
// ⑦ 覆盖检查：所有中文错误文案都有 api 词条（缺失时逐条列出）
//
// 两道门禁（T10 审查 Minor 2 加固后）：
//   ① routes 层：只接受「精确词条 key / 同文件中文常量 / `{占位符}` key」三种实参形态；
//      表达式拼接、三元里夹中文字面量、helper 间接调用（`ctx.error(400, msg)`）、
//      `ctx['error']`、`ctx.json({error:'中文'})` 一律判失败；
//   ② lib 层：按 `lib/user-messages.js` 的登记表扫描类/函数里的用户可见文案，
//      逐条要求 api 词条（新增 lib 中文错误忘了补词条 ⇒ 红）。
// --------------------------------------------------------------------------

/**
 * 把注释替换为空格（保留换行与字符串内容，行号不变）。
 * 为什么要先遮注释：`ctx.error(...)` 的说明性注释里也出现同样字样，不遮会扫出假写点。
 */
function maskComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < src.length) {
        out += src[i];
        if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 `openIdx`（左括号下标）起做括号配对，返回顶层逗号切开的实参文本与右括号后一位 */
function parseCall(src, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  let cur = '';
  const args = [];
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      cur += ch;
      i += 1;
      while (i < src.length) {
        cur += src[i];
        if (src[i] === '\\') { cur += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if ('([{'.includes(ch)) { depth += 1; cur += ch; i += 1; continue; }
    if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) { args.push(cur.trim()); i += 1; break; }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; i += 1; continue; }
    cur += ch;
    i += 1;
  }
  return { args, end: i };
}

/** 解码单/双引号字符串字面量（词条只用到这几种转义；其余原样保留） */
function decodeLiteral(raw) {
  const body = raw.slice(1, -1);
  const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '`': '`' };
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const next = body[i + 1];
    if (next === undefined) { out += '\\'; break; }
    out += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
    i += 1;
  }
  return out;
}

/** 行号（1 基） */
function lineAt(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

/** `{name}` 占位符名集合（排序后拼串，便于比较） */
function placeholderNames(text) {
  return [...text.matchAll(/\{([A-Za-z_][\w]*)\}/g)].map((hit) => hit[1]).sort().join(',');
}

/**
 * 表达式 → 编译期可确定的字符串（单/双/无插值模板字面量，或它们的 `+` 拼接）。
 * 无法静态确定（含 `${}`、变量、调用）返回 null。
 */
function staticString(expr) {
  const text = String(expr || '').trim();
  if (text === '') return null;
  if (text.startsWith('`') && text.endsWith('`')) {
    return text.includes('${') ? null : decodeLiteral(text);
  }
  // 逐段解析：字面量 (+ 字面量)*
  let out = '';
  let i = 0;
  let needLiteral = true;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const ch = text[i];
    if (needLiteral) {
      if (ch !== '"' && ch !== "'") return null;
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === ch) { end += 1; break; }
        end += 1;
      }
      out += decodeLiteral(text.slice(i, end));
      i = end;
      needLiteral = false;
    } else {
      if (ch !== '+') return null;
      i += 1;
      needLiteral = true;
    }
  }
  return needLiteral ? null : out;
}

/** 表达式里出现的字符串字面量（含模板），返回 `{keys, dynamic}`：
 *  keys = 含中文且编译期可确定的文案；dynamic = 含 `${}` 且含中文的模板。 */
function keyLiteralsIn(expr) {
  const keys = [];
  const dynamic = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch !== '"' && ch !== "'" && ch !== '`') { i += 1; continue; }
    const quote = ch;
    let raw = ch;
    i += 1;
    while (i < expr.length) {
      raw += expr[i];
      if (expr[i] === '\\') { raw += expr[i + 1] || ''; i += 2; continue; }
      if (expr[i] === quote) { i += 1; break; }
      i += 1;
    }
    const value = decodeLiteral(raw);
    if (!HAN.test(value)) continue;
    if (quote === '`' && raw.includes('${')) { dynamic.push(value); continue; }
    keys.push(value);
  }
  return { keys, dynamic };
}

/** 把若干 [start,end) 区间替换为空格（保留换行），用于跳过 localizable/messageVars 的渲染串 */
function blankSpans(src, spans) {
  if (!spans.length) return src;
  const chars = [...src];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** 收集模块级中文字符串常量（支持字面量 `+` 拼接与其他已知常量的拼接） */
function collectConstants(src) {
  const out = new Map();
  const re = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\+|[\s])+);/g;
  for (const m of src.matchAll(re)) {
    const value = staticString(m[2]);
    if (value !== null && HAN.test(value)) out.set(m[1], value);
  }
  return out;
}

/** 找 `function name(` 的函数体 `{…}` 区间；找不到返回 null */
function functionBodyRange(src, name) {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let parens = 1;
  // 先跳过参数表（默认值里可能有 `{}`），再定位函数体左花括号
  while (i < src.length && parens > 0) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    i += 1;
  }
  while (i < src.length && src[i] !== '{') i += 1;
  if (i >= src.length) return null;
  const bodyStart = i;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return [bodyStart + 1, i];
    }
    i += 1;
  }
  return null;
}

/** 扫描函数体内 `throw …;` / `return …;` 的中文文案，登记词条或报写法问题 */
function scanStatements(body, where, requireKey, problems) {
  const statementRe = /\b(throw|return)\b([^;]*);/g;
  for (const m of body.matchAll(statementRe)) {
    const expr = m[2];
    if (!HAN.test(expr)) continue;
    const { keys, dynamic } = keyLiteralsIn(expr);
    for (const key of keys) requireKey(key, where);
    for (const raw of dynamic) {
      problems.push(`${where}：${m[1]} 语句里的模板文案含插值，请改用`
        + `「中文 {占位符} 词条 + messageVars/localizable」写法（原文：${raw.slice(0, 60)}）`);
    }
  }
}

/** 测试关键词条（缺失/英文残留/占位符不一致都进 report） */
function entryValues(api, key) {
  const entry = Object.prototype.hasOwnProperty.call(api, key) ? api[key] : undefined;
  if (typeof entry === 'string') return [entry];
  if (entry !== null && typeof entry === 'object') {
    return [entry.one, entry.other].filter((value) => typeof value === 'string');
  }
  return [];
}

test('覆盖检查：ctx.error/errorSpaced 的中文文案都有 api 词条', () => {
  resetCache();
  const dict = loadDict();
  const api = dict && typeof dict.api === 'object' && dict.api !== null ? dict.api : {};
  const required = new Map();   // key -> Set(file:line)
  const problems = [];

  /** 记录一条必须存在的词条 */
  const requireKey = (key, where) => {
    if (!HAN.test(key)) return;
    if (!required.has(key)) required.set(key, new Set());
    required.get(key).add(where);
  };

  // ── ① routes + server.js：错误写点的实参必须是「精确词条」 ────────────────
  const files = fs.readdirSync(ROUTES_DIR).filter((name) => name.endsWith('.js'))
    .sort().map((name) => path.join(ROUTES_DIR, name));
  files.push(path.join(REPO_ROOT, 'backend', 'server.js'));

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = maskComments(raw);
    const rel = path.relative(REPO_ROOT, file);
    const constants = collectConstants(src);
    // 中文字符串常量无论用没用到都要求词条（防止 `const BUSY=…` 这类二次收口绕过）
    for (const [name, value] of constants) {
      requireKey(value, `${rel}（常量 ${name}）`);
    }

    // `ctx['error']` / `ctx['errorSpaced']`：绕过单点写法，直接判失败
    for (const m of src.matchAll(/\bctx\s*\[\s*(['"])(error|errorSpaced)\1\s*\]/g)) {
      problems.push(`${rel}:${lineAt(src, m.index)}：请改用 ctx.error/ctx.errorSpaced`
        + '（方括号写法无法被覆盖门禁按单点扫描）');
    }

    // `ctx.json({ error: '中文…' })`：错误体没走 ctx.error，英文模式不会翻译
    for (const m of src.matchAll(/\bctx\.json\s*\(/g)) {
      const { args } = parseCall(src, m.index + m[0].length - 1);
      const body = args[1] || '';
      if (/"error"\s*:\s*['"]/.test(body) || /'error'\s*:\s*['"]/.test(body)
        || /\berror\s*:\s*['"]/.test(body)) {
        const { keys } = keyLiteralsIn(body);
        if (keys.length) {
          problems.push(`${rel}:${lineAt(src, m.index)}：错误体写在 ctx.json({error:…}) 里，`
            + '请改走 ctx.error 以启用本地化');
        }
      }
    }

    // 所有可能的错误写口（respondError 的 message 在第 3 个实参）
    const callRe = /\b(ctx\.(?:errorSpaced|error|text)|respondErrorSpaced|respondError)\s*\(/g;
    for (const m of src.matchAll(callRe)) {
      const { args } = parseCall(src, m.index + m[0].length - 1);
      const where = `${rel}:${lineAt(src, m.index)}`;
      if (m[1] === 'ctx.text') {
        const body = args[1] || '';
        const literal = staticString(body);
        if (literal !== null && literal.startsWith('{"error"') && HAN.test(literal)) {
          problems.push(`${where}：错误体写在 ctx.text 里，请改走 ctx.error 以启用本地化`);
        }
        continue;
      }
      const message = m[1].startsWith('respondError') ? (args[2] || '') : (args[1] || '');
      if (message === '') continue;

      // 形态 1：精确字符串字面量（含无插值模板）
      const literal = staticString(message);
      if (literal !== null && message.trim().startsWith('`') === false
        && !/^[A-Za-z_$][\w$]*$/.test(message.trim())) {
        requireKey(literal, where);
        continue;
      }

      // 形态 2：`t('api', '中文词条', …)`（server/index 的少数显式写点）
      const explicitT = /^t\(\s*(['"])api\1\s*,\s*(['"])((?:\\.|(?!\2).)*)\2/.exec(message.trim());
      if (explicitT) {
        requireKey(decodeLiteral(explicitT[2] + explicitT[3] + explicitT[2]), where);
        continue;
      }

      const ident = message.trim();
      // 形态 3：同文件中文常量
      if (/^[A-Za-z_$][\w$]*$/.test(ident) && constants.has(ident)) {
        requireKey(constants.get(ident), `${where}（常量 ${ident}）`);
        continue;
      }

      // 形态 4：动态透传（lib 的 err/e、`pyStrErr(e)` 等）：不得再夹中文字面量
      const { keys, dynamic } = keyLiteralsIn(message);
      if (dynamic.length || keys.length) {
        problems.push(`${where}：错误文案必须是精确词条 key（或同文件中文常量）；`
          + `表达式内夹中文字面量/模板插值无法保证英文模式可用：${message.slice(0, 120)}`);
        continue;
      }
      // helper 间接调用（`const fail=(ctx,msg)=>ctx.error(400,msg)`）：message 是裸变量且
      // 不是已知的动态透传名 ⇒ 门禁扫不到真正文案，判失败。
      if (/^[A-Za-z_$][\w$]*$/.test(ident)
        && !['err', 'e', 'error', 'ex', 'exc', 'se'].includes(ident)
        && rel !== path.join('backend', 'routes', 'index.js')) {
        problems.push(`${where}：错误文案来自变量 ${ident}，无法静态校验；`
          + '请内联词条 key 或用同文件常量（lib 错误请直接透传 err/e）');
      }
    }
  }

  // ── ② lib 层：按登记表扫描「类/函数里的用户可见文案」 ────────────────────
  const LIB_DIR = path.join(REPO_ROOT, 'backend', 'lib');
  for (const [fileName, spec] of Object.entries(LIB_USER_MESSAGE_SOURCES)) {
    const file = path.join(LIB_DIR, fileName);
    assert.ok(fs.existsSync(file), `lib 登记表指向不存在的文件：${fileName}`);
    const raw = fs.readFileSync(file, 'utf8');
    const src = maskComments(raw);
    const rel = path.relative(REPO_ROOT, file);
    const constants = collectConstants(src);

    // localizable()/messageVars() 的调用区间：内部渲染串不参与「类构造器字面量」扫描
    const wrapperSpans = [];
    const wrapperCalls = [];
    for (const name of ['localizable', 'messageVars']) {
      const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
      for (const m of src.matchAll(re)) {
        const openIdx = m.index + m[0].length - 1;
        const { args, end } = parseCall(src, openIdx);
        wrapperSpans.push([m.index, end]);
        wrapperCalls.push({ name, args, where: `${rel}:${lineAt(src, m.index)}` });
      }
    }
    for (const { name, args, where } of wrapperCalls) {
      const keyExpr = (name === 'localizable' ? (args[1] || '') : (args[0] || '')).trim();
      const key = staticString(keyExpr);
      if (key === null) {
        // 允许的变量直传：错误对象自带的 i18nKey（userErrText 桥）与 unsupportedInfo().key。
        // 其余动态 key 一律判失败（新增间接层必须显式登记，否则门禁不知道对应词条）。
        if (keyExpr === 'err.i18nKey' || keyExpr === 'info.key') continue;
        problems.push(`${where}：${name}() 的词条 key 必须是精确中文字符串字面量`
          + `（当前：${keyExpr.slice(0, 60)}）`);
        continue;
      }
      requireKey(key, where);
      const varsArg = name === 'localizable' ? (args[2] || '') : (args[1] || '');
      const holders = placeholderNames(key);
      if (holders !== '' && varsArg === '') {
        problems.push(`${where}：词条 ${JSON.stringify(key)} 含占位符，但 ${name}() 没有 vars 实参`);
      } else if (holders !== '') {
        for (const namePart of holders.split(',')) {
          if (!new RegExp(`\\b${namePart}\\b`).test(varsArg)) {
            problems.push(`${where}：词条 ${JSON.stringify(key)} 的占位符 {${namePart}} `
              + `在 vars 实参里找不到`);
          }
        }
      }
    }
    const scanSrc = blankSpans(src, wrapperSpans);

    // 类构造器：`new XxxError('中文…')`
    for (const className of spec.classes || []) {
      const re = new RegExp(`\\bnew\\s+${className}\\s*\\(`, 'g');
      for (const m of scanSrc.matchAll(re)) {
        const { args } = parseCall(scanSrc, m.index + m[0].length - 1);
        const where = `${rel}:${lineAt(scanSrc, m.index)}`;
        for (const arg of args) {
          if (!HAN.test(arg)) continue;
          const value = staticString(arg);
          if (value !== null) { requireKey(value, `${where}（new ${className}）`); continue; }
          const ident = arg.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(ident) && constants.has(ident)) {
            requireKey(constants.get(ident), `${where}（常量 ${ident}）`);
            continue;
          }
          problems.push(`${where}：new ${className}() 的消息必须用精确字面量`
            + '（带插值时请改用 localizable() 附加 i18nKey/i18nVars）');
        }
      }
    }

    // 函数体：throw / return 里的中文字面量
    for (const fnName of spec.functions || []) {
      const range = functionBodyRange(scanSrc, fnName);
      if (range === null) {
        problems.push(`${rel}：登记表里的函数 ${fnName} 不存在（改名后请同步更新登记表）`);
        continue;
      }
      const body = scanSrc.slice(range[0], range[1]);
      const whereBase = `${rel}（${fnName}）`;
      scanStatements(body, whereBase, requireKey, problems);
    }

    // 中文常量（如 LOST_SESSION_MSG / UNCONFIGURED_MESSAGE / RETIRED_MSG）
    for (const name of spec.constants || []) {
      if (!constants.has(name)) {
        problems.push(`${rel}：登记表里的中文常量 ${name} 不存在或不是字面量`);
        continue;
      }
      requireKey(constants.get(name), `${rel}（常量 ${name}）`);
    }

    // 变量形式的词条 key（unsupportedInfo 的 `.key`）：必须有词条，且源码里确实有该字面量
    for (const key of spec.keys || []) {
      if (!raw.includes(key)) {
        problems.push(`${rel}：登记表里的词条 ${JSON.stringify(key)} 在源码中找不到`);
      }
      requireKey(key, `${rel}（登记词条）`);
    }
  }

  // ── ③ 词条质量：必须存在、英文无中文、占位符一致 ────────────────────────
  const missing = [];
  for (const [key, wheres] of required) {
    const values = entryValues(api, key);
    if (values.length === 0) {
      missing.push(`  - ${JSON.stringify(key)}\n      写点: ${[...wheres].join(', ')}`);
      continue;
    }
    for (const value of values) {
      if (HAN.test(value)) {
        problems.push(`  - ${JSON.stringify(key)}：英文词条里仍有中文：${JSON.stringify(value)}`);
      }
      if (placeholderNames(value) !== placeholderNames(key)) {
        problems.push(`  - ${JSON.stringify(key)}：占位符不一致`
          + `（原文 ${placeholderNames(key)} / 译文 ${placeholderNames(value)}）`);
      }
    }
  }

  const report = [];
  if (missing.length) report.push(`缺少 api 词条（${missing.length} 条）：\n${missing.join('\n')}`);
  if (problems.length) report.push(`词条/写法问题（${problems.length} 条）：\n${problems.join('\n')}`);
  assert.deepEqual(report, [], `错误文案本地化覆盖检查失败：\n${report.join('\n\n')}`);
});
