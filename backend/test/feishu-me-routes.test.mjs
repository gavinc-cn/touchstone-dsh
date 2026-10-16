/**
 * 个人飞书族路由单测（M7-R3）：`backend/routes/feishu.js` 的 7 条 + `backend/lib/feishu.js`
 * 末尾追加的写入/绑定码/入站闸门面。
 *
 * ## 为什么要有这个文件（对拍 `cases-http/m7_feishu_me.json` 覆盖不到什么）
 * 实例级对拍只能打「同一串 HTTP 写请求 + 逐字节比」的档，本族有四类判据它表达不了：
 *   ① **随机正文**：`POST /api/me/feishu-bindcode` 的 200 档回的是 `secrets.choice` 生成的
 *      6 位码，A/B 两侧必然不同 ⇒ 对拍里只能留 401 档。码长、字符集、每次换码、TTL 与
 *      `bindUser` 的四种返回路径全在这里钉。
 *   ② **HTTP 不可达的库形态**：M7 里**没有任何端点能建 `feishu_bindings` 行**（唯一写口是
 *      M7.5 的 `bind_user`），也没有任何端点会往 `feishu_outbox` 入队（`push_event` 的调用方
 *      全在 runner/board 的旁路里，且 Node 侧那两条缝还没接线）⇒「已绑定档（码点打码 /
 *      `default_project` 无归属校验）」「投递记录档（字段恒序 / `ORDER BY id DESC LIMIT 50`
 *      硬编码 / `user_id=0` 遗留行不可见）」只能靠**直接 SQL 造行**。
 *   ③ **连接级语义**：`feishu_user_cfgs.json` 是合法 JSON 但**非对象**（`null`/`[]`/`123`）时，
 *      oracle 在 `cfg.get(...)` 上抛 `AttributeError` ⇒ **0 字节断连**。这个库形态只能手工改库
 *      才造得出，`dispatchSafely` 的 `res.destroy()` 是本用例的观测面。
 *   ④ **进程级闸门**：`must_change_pw=1` 的账号 GET/POST cfg ⇒ 403、**PATCH cfg 与
 *      DELETE feishu 无此闸**。这道闸在 `server.js`（不在 `dispatch` 里）⇒ 必须真起后端子进程、
 *      真用 cookie 登录才测得到；顺带把 `start_inbound_for` 的 **stderr 逐字文案**也在真进程上钉一次。
 *
 * ## 期望值来源（**不是**从 Node 实现反推）
 * `server.py:1734-1766`(cfg get/set) / `:1252`(PATCH 同函数) / `:2115-2141`(bindcode/me/delete) /
 * `:1808-1815`(outbox) / `:5203-5223`(强制改密闸) + `feishu.py:72`(user_config) /
 * `:1617-1653`(`start_inbound_for`) / `:2004-2060`(`make_bind_code`/`bind_user`) /
 * `:3152-3174`(`save_user_config`) + `db.py:1423-1445`/`:1541-1592`。
 * 打码口径与 Python `str()` 落库形态由计划文档 §1.8（oracle 逐字实测）固化。
 *
 * 两条隔离纪律：临时库（`freshDb`）+ 真 SQL 造行；**绝不**碰生产库（`freshDb` 已把
 * `TOUCHSTONE_DB` 指向夹具，漏传 options 也落不进生产库）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { md5Password } from '../lib/auth.js';
import * as feishu from '../lib/feishu.js';
import { inboundStatus } from '../lib/feishu_cfg.js';
import { dispatch, dispatchSafely, makeContext } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台（与 `feishu-hook-routes.test.mjs` 同款：只实现 lib/http.js 用到的四个方法）
// --------------------------------------------------------------------------

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

/** 请求桩：真 `Readable` + `content-length`；`raw` 给原始正文、`body` 给对象、都不给＝无体 */
function fakeReq(method, { body, raw } = {}) {
  let text = null;
  if (raw !== undefined) text = Buffer.from(raw, 'utf8');
  else if (body !== undefined) text = Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text === null ? [] : [text], { objectMode: false });
  stream.headers = text === null ? {} : { 'content-length': String(text.length) };
  stream.method = method;
  const readState = { ended: false };
  stream.on('end', () => { readState.ended = true; });
  return { stream, readState };
}

function makeCtx(env, method, target, { body, raw, user } = {}) {
  const { stream, readState } = fakeReq(method, { body, raw });
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: stream,
    res,
    db: env.db,
    user: user === undefined ? env.admin : user,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  return { ctx, cap, readState };
}

/** 发一次请求（走真路由表；处理器异常向外抛——测「掐断连接」那组用 callSafe） */
async function call(env, method, target, opts = {}) {
  const { ctx, cap, readState } = makeCtx(env, method, target, opts);
  const hit = await dispatch(ctx);
  const buf = Buffer.concat(cap.chunks);
  return {
    status: cap.status, headers: cap.headers, hit, readState,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

/** 走真兜底（`dispatchSafely`）：处理器抛错 ⇒ 只 `res.destroy()`，不抛给调用方 */
async function callSafe(env, method, target, opts = {}) {
  const { ctx, cap, readState } = makeCtx(env, method, target, opts);
  const errors = [];
  const hit = await dispatchSafely(ctx, { logger: { error: (m) => errors.push(String(m)) } });
  const buf = Buffer.concat(cap.chunks);
  return { status: cap.status, cap, hit, readState, errors, text: () => buf.toString('utf8') };
}

/** 一次请求 + 逐字节正文断言（本族判据的核心形态） */
async function expectBody(env, method, target, opts, status, expectedBody) {
  const r = await call(env, method, target, opts);
  assert.equal(r.status, status, `状态码：${r.text()}`);
  assert.equal(r.text(), expectedBody);
  assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
  return r;
}

// --------------------------------------------------------------------------
// 夹具
// --------------------------------------------------------------------------

/** 临时库 + 两个用户（admin=1 / bob=101）——绑定行/配置行走真 SQL，理由见文件头 ② */
function setup(tag) {
  const fx = freshDb(`fm-${tag}`);
  fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES (?,?,?,?,?,?)').run(101, 'bob', 'x', '', 0, '2026-10-12 00:00:00');
  return {
    ...fx,
    admin: fx.db.prepare('SELECT * FROM users WHERE id=1').get(),
    bob: fx.db.prepare('SELECT * FROM users WHERE id=101').get(),
  };
}

let seq = 0;
/** 直接插项目行（只关心 id/name/user_id；其余列给确定值，避免 NULL 干扰） */
function seedProject(env, opts = {}) {
  seq += 1;
  return insertProject(env.db, {
    userId: opts.userId === undefined ? 1 : opts.userId,
    name: opts.name === undefined ? `p${seq}` : opts.name,
    projectDir: `/tmp/pd-${seq}`,
  });
}

/** 直接写 `feishu_user_cfgs.json`（绕过写口：要造「手工改库」才有的形态） */
function setCfgRaw(env, userId, text) {
  env.db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?, ?)'
    + ' ON CONFLICT(user_id) DO UPDATE SET json=excluded.json').run(userId, text);
}
const cfgText = (env, userId = 1) => {
  const row = env.db.prepare('SELECT json FROM feishu_user_cfgs WHERE user_id=?').get(userId);
  return row === undefined ? undefined : row.json;
};
const cfgCount = (env) => env.db.prepare(
  'SELECT COUNT(*) AS n FROM feishu_user_cfgs').get().n;

/** 直接插绑定行（M7 无 HTTP 写口，见文件头 ②） */
function seedBinding(env, opts = {}) {
  env.db.prepare('INSERT INTO feishu_bindings(open_id, user_id, default_project_id, bound_at,'
    + " cur_sid, cur_project_id, cur_title, cur_bound_at) VALUES(?,?,?,'2026-10-12 00:00:00',"
    + " '',0,'','')").run(opts.openId, opts.userId === undefined ? 1 : opts.userId,
    opts.defaultProjectId === undefined ? 0 : opts.defaultProjectId);
}
const bindingCount = (env) => env.db.prepare(
  'SELECT COUNT(*) AS n FROM feishu_bindings').get().n;

/** 直接插投递行（M7 无 HTTP 入队口，见文件头 ②） */
function seedOutbox(env, opts = {}) {
  const info = env.db.prepare(
    'INSERT INTO feishu_outbox(user_id, target, secret, payload, status, retries, next_at,'
    + ' dedup_key, last_error, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(opts.userId === undefined ? 1 : opts.userId, opts.target, opts.secret || '',
    opts.payload || '{}', opts.status || 'failed', opts.retries === undefined ? 0 : opts.retries,
    opts.nextAt === undefined ? 0 : opts.nextAt, opts.dedupKey || '',
    opts.lastError === undefined ? '' : opts.lastError,
    opts.createdAt || '2026-10-11 00:00:00');
  return Number(info.lastInsertRowid);
}

/** 临时 web 目录（起真后端用：server.js 缺 index.html 会直接退出） */
function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-fm-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body></body></html>\n');
  return dir;
}

/** 抓 `console.error`（`startInboundFor` 的 stderr 契约在 Node 侧就是它） */
function captureStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
  try {
    const out = fn();
    return { out, lines };
  } finally {
    console.error = real;
  }
}

/** 同上，但被测函数是异步的（`saveUserConfig` 会真调 `verifyCredentials`） */
async function captureStderrAsync(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
  try {
    const out = await fn();
    return { out, lines };
  } finally {
    console.error = real;
  }
}

const OK_SPACED = '{"ok": true, "inbound_started": false, "verify": null}';
const OK_TIGHT = '{"ok":true}';
const CFG_DEFAULT = '{"enabled": true, "push_enabled": true, "default_webhook": "",'
  + ' "has_default_secret": false, "base_url": "", "app_id": "", "has_app_secret": false,'
  + ' "inbound": {"configured": false, "thread": false}}';

// ==========================================================================
// ① GET /api/me/feishu-cfg —— 八键、键序、缺键按 true、打码码点
// ==========================================================================

test('GET cfg 无行：八键逐字节（键序 = Python dict 字面量，开关缺键按 true，inbound 两键）',
  async (t) => {
    const env = setup('cfg-default');
    t.after(() => env.close());
    const r = await expectBody(env, 'GET', '/api/me/feishu-cfg', {}, 200, CFG_DEFAULT);
    assert.equal(r.hit, true);
    assert.equal(r.readState.ended, false, 'GET 全程不读体（oracle `_api_me_feishu_cfg_get` 无 _read_json）');
    assert.equal(cfgCount(env), 0, '读不建行');
  });

test('GET cfg：`cfg.get(k, True)` 的缺键口径 —— 缺键 true、键在但假值 false、非空串一律 true',
  async (t) => {
    const env = setup('cfg-truthy');
    t.after(() => env.close());
    const enabledOf = async () => (await call(env, 'GET', '/api/me/feishu-cfg')).json().enabled;
    const pushOf = async () => (await call(env, 'GET', '/api/me/feishu-cfg')).json().push_enabled;
    // 缺键 ⇒ true（存量配置零迁移）
    setCfgRaw(env, 1, '{}');
    assert.equal(await enabledOf(), true);
    assert.equal(await pushOf(), true);
    // 键存在但是假值 ⇒ false（`dict.get(k, True)` 只在**缺键**时给默认）
    for (const falsy of ['0', '0.0', 'false', 'null', '""', '[]', '{}']) {
      setCfgRaw(env, 1, `{"enabled": ${falsy}}`);
      assert.equal(await enabledOf(), false, `enabled=${falsy} 应为 false`);
    }
    // 非空字符串一律真（`"0"`/`"false"` 都是真——JS `Boolean("0")` 同，但 `[]`/`{}` 不同）
    for (const truthy of ['"0"', '"false"', '" "', '1', 'true', '[0]', '{"a":null}']) {
      setCfgRaw(env, 1, `{"enabled": ${truthy}}`);
      assert.equal(await enabledOf(), true, `enabled=${truthy} 应为 true`);
    }
    // push_enabled 与 enabled 是两个独立键，互不影响
    setCfgRaw(env, 1, '{"enabled": 0}');
    assert.equal(await pushOf(), true);
    setCfgRaw(env, 1, '{"push_enabled": 0}');
    assert.equal(await enabledOf(), true);
  });

test('GET cfg：has_* 是 bool(原值)（`" "` ⇒ true、`""`/`null`/`0` ⇒ false）；base_url/app_id 不打码',
  async (t) => {
    const env = setup('cfg-bools');
    t.after(() => env.close());
    setCfgRaw(env, 1, JSON.stringify({
      default_secret: ' ', app_secret: '  x  ',
      base_url: 'b'.repeat(200), app_id: 'c'.repeat(200),
    }));
    const j = (await call(env, 'GET', '/api/me/feishu-cfg')).json();
    assert.equal(j.has_default_secret, true, 'bool(" ") 是 true（不是 strip() 后再判）');
    assert.equal(j.has_app_secret, true);
    assert.equal(j.base_url, 'b'.repeat(200), 'base_url 不打码');
    assert.equal(j.app_id, 'c'.repeat(200), 'app_id 不打码（非密可回显）');
    for (const [stored, want] of [['""', false], ['null', false], ['0', false], ['" "', true]]) {
      setCfgRaw(env, 1, `{"default_secret": ${stored}, "app_secret": ${stored}}`);
      const row = (await call(env, 'GET', '/api/me/feishu-cfg')).json();
      assert.equal(row.has_default_secret, want, `default_secret=${stored}`);
      assert.equal(row.has_app_secret, want, `app_secret=${stored}`);
    }
  });

test('GET cfg：default_webhook 打码是**码点**口径（48 原样 / 49 ⇒ 前 48 码点 + …）',
  async (t) => {
    const env = setup('cfg-mask');
    t.after(() => env.close());
    const PREFIX = 'https://open.feishu.cn/open-apis/bot/v2/hook/';   // 45 ASCII
    const w48 = `${PREFIX}aa\u{1F600}`;      // 45+2+1 = 48 码点（UTF-16 是 49 ⇒ 用 length 会误判）
    const w49 = `${PREFIX}aaa\u{1F600}`;     // 49 码点
    setCfgRaw(env, 1, JSON.stringify({ default_webhook: w48 }));
    assert.equal((await call(env, 'GET', '/api/me/feishu-cfg')).json().default_webhook, w48,
      '48 码点原样回显');
    setCfgRaw(env, 1, JSON.stringify({ default_webhook: w49 }));
    assert.equal((await call(env, 'GET', '/api/me/feishu-cfg')).json().default_webhook,
      `${PREFIX}aaa\u2026`, '49 码点 ⇒ 前 48 码点 + …（切点在 emoji 之前，不留半个代理对）');
    // 空值口径：`if not url: return ""`（`""`/`null`/`0` 都回空串）
    for (const stored of ['""', 'null', '0']) {
      setCfgRaw(env, 1, `{"default_webhook": ${stored}}`);
      assert.equal((await call(env, 'GET', '/api/me/feishu-cfg')).json().default_webhook, '');
    }
  });

// ==========================================================================
// ② POST / PATCH /api/me/feishu-cfg —— 同一处理函数 + Python str() 落库
// ==========================================================================

test('POST cfg：五键走 `str(v or "").strip()` ⇒ Python repr 落库（容器不能用 JSON.stringify）',
  async (t) => {
    const env = setup('cfg-str');
    t.after(() => env.close());
    await expectBody(env, 'POST', '/api/me/feishu-cfg', {
      body: {
        default_webhook: true, default_secret: ['a'], base_url: { a: 1 },
        app_id: 1.5, app_secret: 0,
      },
    }, 200, OK_SPACED);
    // 五个键的落库字节：`True` / `['a']` / `{'a': 1}` / `1.5` / `''`（键序 = `save_user_config`
    // 的 for 循环序；`json.dumps` 的 `", "`/`": "` 分隔符由 db.js:pyJsonDumps 保证）。
    // 注意 `app_secret` 是**假值** ⇒ 落空串 ⇒ `app_config` 为 None ⇒ `verify` 恒 null（零网络）：
    // 只要 app_id 与 app_secret 同时为真就会真打 open.feishu.cn（那条路径不在本用例内）。
    assert.equal(cfgText(env, 1),
      '{"default_webhook": "True", "default_secret": "[\'a\']", "base_url": "{\'a\': 1}",'
      + ' "app_id": "1.5", "app_secret": ""}');
  });

test('POST cfg：单键强转矩阵（真值/假值/首尾空白/清除；容器一律 Python repr）', async (t) => {
  const env = setup('cfg-str2');
  t.after(() => env.close());
  const cases = [
    ['default_webhook', true, 'True'],
    ['default_webhook', false, ''],
    ['default_webhook', 0, ''],
    ['default_webhook', null, ''],
    ['default_webhook', ['a'], "['a']"],
    ['default_webhook', [1, 'a'], "[1, 'a']"],
    ['default_webhook', { a: 1 }, "{'a': 1}"],
    ['default_webhook', '  pad  ', 'pad'],
    ['base_url', '  https://x/  ', 'https://x/'],
    ['app_id', 123, '123'],
    ['app_id', 1.5, '1.5'],
    ['app_secret', [], ''],
    ['app_secret', { a: null }, "{'a': None}"],
  ];
  for (const [key, given, expected] of cases) {
    setCfgRaw(env, 1, '{}');                      // 每档从空配置起，避免上一档的键混进来
    await call(env, 'POST', '/api/me/feishu-cfg', { body: { [key]: given } });
    const text = cfgText(env, 1);
    assert.equal(JSON.parse(text)[key], expected,
      `${key}=${JSON.stringify(given)} 落库：${text}`);
    // 落库文本必须是**带空格的 json.dumps 形态**（不是 JSON.stringify 的紧凑形态）
    assert.ok(text.includes(`"${key}": ${JSON.stringify(expected)}`),
      `落库文本形态不对：${text}`);
  }
  // 容器形态的**反例**：库里绝不能出现 JSON.stringify 的 `["a"]` / `{"a":1}`
  assert.ok(cfgText(env, 1).includes('"app_secret": "{\'a\': None}"'));
  assert.ok(!cfgText(env, 1).includes('"app_secret": "{\\"a\\":null}"'),
    '不许用 JSON.stringify 兜底（连 null→None 的 Python 口径也要对）');
});

test('POST/PATCH cfg：同一处理函数（成功体同形）；两个开关走 Python bool()（`"0"`⇒1、`[]`⇒0）',
  async (t) => {
    const env = setup('cfg-same');
    t.after(() => env.close());
    // PATCH 与 POST 逐字节同形（唯一实测差异＝PATCH 不跳强制改密闸，那条在 server.js，e2e 里钉）
    await expectBody(env, 'POST', '/api/me/feishu-cfg', { body: {} }, 200, OK_SPACED);
    await expectBody(env, 'PATCH', '/api/me/feishu-cfg', { body: {} }, 200, OK_SPACED);
    // 开关真值矩阵：写库落 1/0（不是 true/false）。键序 = `save_user_config` 里两条 `if`
    // 的先后（`push_enabled` 在前）——已存在的键保位，新键追加在尾部。
    await call(env, 'POST', '/api/me/feishu-cfg', { body: { enabled: '0', push_enabled: [] } });
    assert.equal(cfgText(env, 1), '{"push_enabled": 0, "enabled": 1}');
    await call(env, 'PATCH', '/api/me/feishu-cfg', { body: { enabled: false, push_enabled: 'x' } });
    assert.equal(cfgText(env, 1), '{"push_enabled": 1, "enabled": 0}');
  });

test('POST cfg：缺省=不改 / 显式空串=清除（含「键序在首写时定下、此后不再变」）', async (t) => {
  const env = setup('cfg-nochange');
  t.after(() => env.close());
  await call(env, 'POST', '/api/me/feishu-cfg', {
    body: { default_webhook: 'https://x/hook/keep', base_url: 'https://x' },
  });
  const after1 = cfgText(env, 1);
  assert.equal(after1, '{"default_webhook": "https://x/hook/keep", "base_url": "https://x"}');
  // 只带开关：五个字符串键一个字节都不动（`enabled` 是新键 ⇒ 追加在尾部）
  await call(env, 'POST', '/api/me/feishu-cfg', { body: { enabled: true } });
  assert.equal(cfgText(env, 1), '{"default_webhook": "https://x/hook/keep",'
    + ' "base_url": "https://x", "enabled": 1}');
  // 显式空串=清除（此时键仍在，值变空串——与「删键」在回显上同形、在库文本上不同）
  await call(env, 'POST', '/api/me/feishu-cfg', { body: { default_webhook: '' } });
  assert.equal(cfgText(env, 1), '{"default_webhook": "", "base_url": "https://x", "enabled": 1}');
  // 非法键被静默忽略（Python 只认白名单里的五个 + 两个开关）
  await call(env, 'POST', '/api/me/feishu-cfg', { body: { nope: 'x', default_webhook: 'y' } });
  assert.equal(cfgText(env, 1), '{"default_webhook": "y", "base_url": "https://x", "enabled": 1}');
});

test('POST cfg：非文字体/坏 JSON/无体一律按 `{}`（`_read_json` 口径）⇒ 只建行、不改字段',
  async (t) => {
    const env = setup('cfg-body');
    t.after(() => env.close());
    await call(env, 'POST', '/api/me/feishu-cfg', { body: { default_webhook: 'https://x/keep' } });
    const before = cfgText(env, 1);
    for (const opts of [{ raw: '{bad' }, { raw: '[1,2]' }, { raw: '"x"' }, { raw: 'null' }, {}]) {
      const r = await call(env, 'POST', '/api/me/feishu-cfg', opts);
      assert.equal(r.status, 200, JSON.stringify(opts));
      assert.equal(r.text(), OK_SPACED);
    }
    assert.equal(cfgText(env, 1), before, '非文字体不许改任何字段');
    assert.equal(cfgCount(env), 1);
  });

// ==========================================================================
// ③ 合法 JSON 但非对象的 cfg 行 ⇒ 0 字节断连（照抄 oracle 的 AttributeError）
// ==========================================================================

test('cfg 行是合法 JSON 但非对象：GET/POST 都掐断连接（oracle 抛 Attr/TypeError ⇒ 无响应）',
  async (t) => {
    const env = setup('cfg-nondict');
    t.after(() => env.close());
    for (const stored of ['null', '[]', '123', '"x"']) {
      setCfgRaw(env, 1, stored);
      for (const method of ['GET', 'POST', 'PATCH']) {
        const r = await callSafe(env, method, '/api/me/feishu-cfg',
          method === 'GET' ? {} : { body: {} });
        assert.equal(r.cap.status, 0, `${method} cfg 在 json=${stored} 时不许发响应`);
        assert.equal(r.cap.destroyed, true, `${method} cfg 在 json=${stored} 时应掐断连接`);
        assert.equal(r.text(), '');
      }
    }
    // 反例：**坏 JSON / 空串**走安全默认（`db.get_feishu_user_cfg` 的 ValueError 分支 ⇒ `{}`）
    for (const stored of ['', '{bad', 'not json']) {
      setCfgRaw(env, 1, stored);
      const r = await call(env, 'GET', '/api/me/feishu-cfg');
      assert.equal(r.status, 200, `json=${JSON.stringify(stored)} 应走安全默认`);
      assert.equal(r.text(), CFG_DEFAULT);
    }
  });

// ==========================================================================
// ④ GET / DELETE /api/me/feishu —— 绑定状态（码点打码 / default_project 无归属校验）
// ==========================================================================

test('GET me 无绑定行：正文只有 bound 一个键（不是「有键但空串」）', async (t) => {
  const env = setup('me-unbound');
  t.after(() => env.close());
  const r = await expectBody(env, 'GET', '/api/me/feishu', {}, 200, '{"bound": false}');
  assert.equal(r.readState.ended, false);
});

test('GET me 已绑定：open_id 码点打码；default_project 取他人项目名（**无归属校验，照抄**）',
  async (t) => {
    const env = setup('me-bound');
    t.after(() => env.close());
    const bobProj = seedProject(env, { userId: 101, name: 'bob的项目（不属于 admin）' });
    // 绑定行：admin(1) → 7 码点 open_id（emoji 落在第 5 位 ⇒ 按 UTF-16 切会切出半个代理对）
    seedBinding(env, { openId: 'ou_a\u{1F600}xy', userId: 1, defaultProjectId: bobProj });
    const r = await call(env, 'GET', '/api/me/feishu');
    assert.equal(r.status, 200);
    assert.equal(r.text(), `{"bound": true, "open_id": "ou_a\u{1F600}x\u2026",`
      + ` "default_project": "bob的项目（不属于 admin）"}`);
    // 6 码点及以下原样回显
    env.db.prepare('UPDATE feishu_bindings SET open_id=? WHERE user_id=1').run('ou_abc');
    assert.equal((await call(env, 'GET', '/api/me/feishu')).json().open_id, 'ou_abc');
    // default_project_id=0 ⇒ 不回显名（空串），且不建任何项目
    env.db.prepare('UPDATE feishu_bindings SET default_project_id=0 WHERE user_id=1').run();
    assert.equal((await call(env, 'GET', '/api/me/feishu')).json().default_project, '');
    // 指向**不存在**的项目 ⇒ 空串（`db.get_project` 回 None）
    env.db.prepare('UPDATE feishu_bindings SET default_project_id=99999 WHERE user_id=1').run();
    assert.equal((await call(env, 'GET', '/api/me/feishu')).json().default_project, '');
  });

test('DELETE me：成功体是硬编码紧凑串 `{"ok":true}`（与同族 json.dumps 口径差 1 字节）',
  async (t) => {
    const env = setup('me-del');
    t.after(() => env.close());
    seedBinding(env, { openId: 'ou_del', userId: 1 });
    assert.equal(bindingCount(env), 1);
    await expectBody(env, 'DELETE', '/api/me/feishu', {}, 200, OK_TIGHT);
    assert.equal(bindingCount(env), 0, '解绑真的删了行');
    // 幂等：无行时照回同一个字节串（`del_feishu_binding_by_user` 删 0 行不报错）
    await expectBody(env, 'DELETE', '/api/me/feishu', {}, 200, OK_TIGHT);
    // bob 的解绑不碰 admin 的行（多用户隔离）
    seedBinding(env, { openId: 'ou_admin2', userId: 1 });
    await call(env, 'DELETE', '/api/me/feishu', { user: env.bob });
    assert.equal(bindingCount(env), 1);
  });

// ==========================================================================
// ⑤ POST /api/me/feishu-bindcode —— 6 位、字符集、每次换码、TTL 600
// ==========================================================================

test('bindcode：6 位、去易混字符集、每次换码、进程内存态（TTL 600s）', async (t) => {
  const env = setup('bindcode');
  t.after(() => { env.close(); feishu._BIND_CODES.clear(); });
  feishu._BIND_CODES.clear();
  assert.equal(feishu._BIND_ALPHABET, '23456789ABCDEFGHJKMNPQRSTUVWXYZ');
  assert.equal(feishu._BIND_TTL, 600);
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const r = await call(env, 'POST', '/api/me/feishu-bindcode');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
    const body = r.json();
    assert.deepEqual(Object.keys(body), ['code']);
    assert.match(body.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, body.code);
    assert.equal([...body.code].length, 6, '按码点恰好 6 位');
    // 无 TTL 回显（响应只有 code 一个键）
    assert.equal(body.code.includes('0') || body.code.includes('1') || body.code.includes('I')
      || body.code.includes('L') || body.code.includes('O'), false);
    seen.add(body.code);
    // 进程内存态：注册表里必须有它，且到期时刻 ≈ now + 600
    const item = feishu._BIND_CODES.get(body.code);
    assert.ok(Array.isArray(item), `_BIND_CODES 里应有 ${body.code}`);
    assert.equal(item[0], 1, '登录用户是 admin(1)');
    const ttl = item[1] - Date.now() / 1000;
    assert.ok(ttl > 590 && ttl <= 600, `TTL 应≈600s，实得 ${ttl}`);
  }
  // 20 次全不同：32^6 空间里撞号的概率 ~1e-8，且「每次换码」是 oracle 明写的语义
  assert.equal(seen.size, 20, '每次换码（新旧码不同，且旧码不从注册表移除）');
  assert.equal(feishu._BIND_CODES.size, 20, '换码不清理旧条目（Python 侧同形，靠 TTL 判死）');
  // 非 admin 用户拿到的码归属该用户
  const bobCode = (await call(env, 'POST', '/api/me/feishu-bindcode', { user: env.bob })).json().code;
  assert.equal(feishu._BIND_CODES.get(bobCode)[0], 101);
});

test('bindUser：四条返回路径（无效/已用过/过期/成功）—— 绑定码与 open_id 的配对写口', async (t) => {
  const env = setup('binduser');
  t.after(() => { env.close(); feishu._BIND_CODES.clear(); });
  feishu._BIND_CODES.clear();
  // ① 未知码
  assert.equal(feishu.bindUser('ZZZZZZ', 'ou_x', { db: env.db }), '绑定码无效或已被使用');
  assert.equal(feishu.bindUser('', 'ou_x', { db: env.db }), '绑定码无效或已被使用');
  assert.equal(feishu.bindUser(null, 'ou_x', { db: env.db }), '绑定码无效或已被使用');
  // ② 成功（大小写/空白归一：`(code or "").strip().upper()`）
  const code = feishu.makeBindCode(1);
  assert.equal(feishu.bindUser(`  ${code.toLowerCase()}  `, 'ou_bind_1', { db: env.db }), null);
  const row = env.db.prepare('SELECT * FROM feishu_bindings WHERE open_id=?').get('ou_bind_1');
  assert.equal(row.user_id, 1);
  assert.equal(row.default_project_id, 0);
  // ③ 用过的码 ⇒ 无效（pop 语义：校验失败也照样出表）
  assert.equal(feishu.bindUser(code, 'ou_bind_2', { db: env.db }), '绑定码无效或已被使用');
  assert.equal(bindingCount(env), 1, '失败路径不建行');
  // ④ 过期（直接改注册表里的到期时刻，不睡 600 秒）
  const stale = feishu.makeBindCode(101);
  feishu._BIND_CODES.set(stale, [101, Date.now() / 1000 - 1]);
  assert.equal(feishu.bindUser(stale, 'ou_bind_3', { db: env.db }),
    '绑定码已过期，请到站点重新生成');
  assert.equal(bindingCount(env), 1);
  // 换绑归零：同一 user_id 再绑另一个 open_id ⇒ 旧行先删（db.set_feishu_binding 语义）
  const code2 = feishu.makeBindCode(1);
  assert.equal(feishu.bindUser(code2, 'ou_bind_4', { db: env.db }), null);
  assert.equal(bindingCount(env), 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM feishu_bindings WHERE user_id=1')
    .get().n, 1);
});

// ==========================================================================
// ⑥ GET /api/me/feishu/outbox —— 字段恒序 / DESC / LIMIT 50 硬编码 / user_id=0 不可见
// ==========================================================================

test('outbox：字段恒序 id,status,retries,last_error,created_at,target；target 打码（码点）',
  async (t) => {
    const env = setup('outbox-shape');
    t.after(() => env.close());
    const PREFIX = 'https://open.feishu.cn/open-apis/bot/v2/hook/';
    seedOutbox(env, { userId: 1, target: `${PREFIX}aaa\u{1F600}`, status: 'failed', retries: 2,
      lastError: 'boom', createdAt: '2026-10-11 00:00:00' });
    seedOutbox(env, { userId: 1, target: 'https://short.example.com/hook', status: 'pending',
      retries: 0, lastError: '', createdAt: '2026-10-11 00:00:01' });
    const r = await call(env, 'GET', '/api/me/feishu/outbox');
    assert.equal(r.status, 200);
    // 正文是**数组**、且对象键序与 server.py:1811 的 dict 字面量逐字相同（json.dumps 保插入序）
    assert.equal(r.text(), '[{"id": 2, "status": "pending", "retries": 0, "last_error": "",'
      + ' "created_at": "2026-10-11 00:00:01", "target": "https://short.example.com/hook"},'
      + ` {"id": 1, "status": "failed", "retries": 2, "last_error": "boom",`
      + ' "created_at": "2026-10-11 00:00:00",'
      + ` "target": "${PREFIX}aaa\u2026"}]`);
    assert.deepEqual(Object.keys(r.json()[0]),
      ['id', 'status', 'retries', 'last_error', 'created_at', 'target']);
  });

test('outbox：`?limit=1` 静默忽略（LIMIT 50 硬编码）+ `user_id=0` 遗留行不可见 + DESC',
  async (t) => {
    const env = setup('outbox-limit');
    t.after(() => env.close());
    for (let i = 0; i < 55; i += 1) {
      seedOutbox(env, { userId: 1, target: `https://x/${i}`, status: 'failed', retries: i,
        createdAt: '2026-10-11 00:00:00' });
    }
    // 遗留行（user_id=0）拿到**全场最大 id** ⇒ 若过滤失效，它会排在第一位，一眼可见
    const legacyId = seedOutbox(env, { userId: 0, target: 'https://legacy.example.com/hook' });
    const base = (await call(env, 'GET', '/api/me/feishu/outbox')).json();
    assert.equal(base.length, 50, '硬编码 LIMIT 50');
    assert.deepEqual(base.map((r) => r.id), Array.from({ length: 50 }, (_, i) => 55 - i));
    assert.ok(!base.some((r) => r.id === legacyId), 'user_id=0 的行对任何用户不可见');
    assert.ok(!JSON.stringify(base).includes('legacy.example.com'));
    // `?limit=1` / `?limit=100` 都被静默忽略（`_api_me_feishu_outbox` 压根没读 parsed）
    for (const qs of ['?limit=1', '?limit=100', '?user_id=0', '?limit=abc']) {
      const r = await call(env, 'GET', `/api/me/feishu/outbox${qs}`);
      assert.equal(r.text(), (await call(env, 'GET', '/api/me/feishu/outbox')).text(), qs);
    }
    // 分派不看 query（`self.path.split("?",1)[0]`）
    const hit = await call(env, 'GET', '/api/me/feishu/outbox?limit=1');
    assert.equal(hit.hit, true);
  });

// ==========================================================================
// ⑦ startInboundFor / inboundStatus —— M7 的边界（闸门 + 注册表 + stderr，不建线程）
// ==========================================================================

test('startInboundFor 凭据缺失：打印 oracle **逐字** stderr 行并回 false（不伪造成 true）',
  async (t) => {
    const env = setup('inbound-missing');
    t.after(() => env.close());
    const { out, lines } = captureStderr(() => feishu.startInboundFor(1, { db: env.db }));
    assert.equal(out, false);
    assert.deepEqual(lines, ['feishu inbound: 用户 1 应用凭据缺失，长连接未启动']);
    // 半填凭据（只有 app_id）同样算缺失（`app_config` 要求两件齐全）
    setCfgRaw(env, 1, '{"app_id": "cli_x"}');
    const half = captureStderr(() => feishu.startInboundFor(1, { db: env.db }));
    assert.equal(half.out, false);
    assert.deepEqual(half.lines, ['feishu inbound: 用户 1 应用凭据缺失，长连接未启动']);
    // 用户 0（项目被删的回落）同形，文案里的 id 是**用户 id**不是用户名
    const zero = captureStderr(() => feishu.startInboundFor(0, { db: env.db }));
    assert.equal(zero.out, false);
    assert.deepEqual(zero.lines, ['feishu inbound: 用户 0 应用凭据缺失，长连接未启动']);
  });

test('startInboundFor 凭据齐全：M7.5 接线后**真拉起**（回 true）+ 幂等 + 注册表判活（M7 占位的 false 已作废）',
  async (t) => {
    const env = setup('inbound-ready');
    t.after(() => env.close());
    setCfgRaw(env, 1, '{"app_id": "cli_ready", "app_secret": "sec_ready"}');
    // inboundStatus：configured=true（凭据齐全）、thread=false（还没有人拉起过）
    assert.deepEqual(inboundStatus(1, { db: env.db }), { configured: true, thread: false });
    // 桩客户端：`clientClass` 是 R2 的注入点（Node 专有；产品路径不传 ⇒ 真 FeishuWsClient）。
    // 刻意**不碰网络**：真域名 + 假凭据会走 TLS，CI 离线时那条路不可重复（计划 §四 R1）。
    const built = [];
    class StubClient {
      constructor(opts) { built.push(opts); }
      async start() { /* 立刻返回：等价"线程跑完退出" */ }
    }
    const first = captureStderr(
      () => feishu.startInboundFor(1, { db: env.db, clientClass: StubClient }));
    assert.equal(first.out, true, 'M7.5 接线后凭据齐全必须真拉起并回 true');
    assert.deepEqual(first.lines, ['feishu inbound: 用户 1 连接长连接网关（app_id=cli_ready）…'],
      '连接行逐字（oracle 1760-1761，结尾是 U+2026）');
    assert.equal(built.length, 1, '必须构造了一个客户端');
    assert.equal(built[0].appId, 'cli_ready');
    assert.equal(built[0].appSecret, 'sec_ready');
    assert.equal(built[0].domain, undefined, '产品路径不传 domain（照 SDK ctor 默认官方域名）');
    assert.equal(built[0].autoReconnect, undefined, '同上：autoReconnect 走 R1 默认 true');
    // 幂等：线程还活着 ⇒ 第二次回 false 且**不新建**客户端（同步段内 alive 必为 true）
    assert.equal(feishu.startInboundFor(1, { db: env.db, clientClass: StubClient }), false);
    assert.equal(built.length, 1);
    assert.equal(inboundStatus(1, { db: env.db }).thread, true, '拉起后判活必须为 true');
    // 桩 start() 立刻 resolve ⇒ "线程"退出，判活转 false（= oracle 的 `is_alive()`）；
    // 这一步同时保证本用例**不把存活线程泄漏给后面的用例**（否则幂等短路会吃掉它们的 stderr 行）
    for (let i = 0; i < 200 && inboundStatus(1, { db: env.db }).thread; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(inboundStatus(1, { db: env.db }).thread, false, '线程退出后判活必须转 false');
  });

test('saveUserConfig：响应三键定序 + 凭据不全时 verify 恒 null、inbound_started 恒 false',
  async (t) => {
    const env = setup('savecfg');
    t.after(() => env.close());
    const { out, lines } = await captureStderrAsync(
      () => feishu.saveUserConfig(1, {}, { db: env.db }));
    assert.deepEqual(Object.keys(out), ['inbound_started', 'verify']);
    assert.equal(out.inbound_started, false);
    assert.equal(out.verify, null, 'app_config 为 None ⇒ 零请求、verify 恒 None');
    assert.deepEqual(lines, ['feishu inbound: 用户 1 应用凭据缺失，长连接未启动']);
    assert.equal(cfgText(env, 1), '{}', '空 body 也建行（内容为空 dict）');
    // 半填凭据仍不触发快检（`app_config` 两件齐全才算）
    const half = await feishu.saveUserConfig(1, { app_id: 'cli_x' }, { db: env.db });
    assert.equal(half.verify, null);
    assert.equal(half.inbound_started, false);
  });

// ==========================================================================
// ⑧ 真后端 e2e：强制改密闸（GET/POST 403、PATCH/DELETE 无闸）+ 真进程 stderr
// ==========================================================================

const SERVER_JS = path.resolve(import.meta.dirname, '..', 'server.js');
/** 强制改密用户的 id（与 `db.initDb` 种子的 admin=1 不撞） */
const MCPW_UID = 101;

/** 起真后端：预置「admin(1) + must_change_pw=1 的 pwuser(101) + 绑定行 + 投递行」 */
async function startRealBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-fm-e2e-'));
  const dbPath = path.join(dir, 'touchstone.db');
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const dbmod = await import('../lib/db.js');
  dbmod.initDb({ dbPath, env: { TS_ADMIN_PASSWORDLESS: '1' } });
  const handle = dbmod.openDb(dbPath);
  let bobProj;
  try {
    handle.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
      + ' VALUES (?,?,?,?,?,?)')
      .run(MCPW_UID, 'pwuser', md5Password('pw123456'), '', 1, '2026-10-12 00:00:00');
    bobProj = insertProject(handle, { userId: MCPW_UID, name: 'pwuser 的项目' });
    handle.prepare('INSERT INTO feishu_bindings(open_id, user_id, default_project_id, bound_at,'
      + " cur_sid, cur_project_id, cur_title, cur_bound_at)"
      + " VALUES(?,?,?,'2026-10-12 00:00:00','',0,'','')")
      .run('ou_a\u{1F600}xy', 1, bobProj);
    seedOutbox({ db: handle }, { userId: 1, target: 'https://x/1', status: 'failed',
      createdAt: '2026-10-11 00:00:00' });
    seedOutbox({ db: handle }, { userId: 1, target: 'https://x/2', status: 'failed',
      createdAt: '2026-10-11 00:00:02' });
    seedOutbox({ db: handle }, { userId: 0, target: 'https://legacy/3', status: 'failed',
      createdAt: '2026-10-11 00:00:03' });
  } finally {
    handle.close();
  }
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning', SERVER_JS,
    '--host', '127.0.0.1', '--port', '0', '--web-dir', makeWebDir(),
    '--trust-internal-user', '--parent-watch',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TOUCHSTONE_DB: dbPath, TOUCHSTONE_RUN_DIR: runDir,
      TS_ADMIN_PASSWORDLESS: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `10s 未见 TOUCHSTONE_LISTEN。stdout=${stdout} stderr=${stderr}`)), 10000);
    const tick = () => {
      const m = stdout.match(/^TOUCHSTONE_LISTEN (\d+)/m);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', tick);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`后端提前退出 code=${code} stderr=${stderr}`)); });
    tick();
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { base: `http://127.0.0.1:${port}`, child, stop, stdout: () => stdout, stderr: () => stderr };
}

let SRV = null;
/**
 * 本族每个写 cfg 的用例都会让 `startInboundFor` 打一行 stderr（oracle 也打）——那是**被断言
 * 的对象**（见 §⑦ 的 captureStderr 用例），不是测试噪声。故整文件把 `console.error` 收进数组
 * （证据不丢），`captureStderr*` 再临时接管；真后端的 banner/stderr 走子进程管道，不受影响。
 */
const STDERR_LOG = [];
const REAL_CONSOLE_ERROR = console.error;
before(() => { console.error = (...a) => { STDERR_LOG.push(a.map((x) => String(x)).join(' ')); }; });
before(async () => { SRV = await startRealBackend(); });
after(async () => { if (SRV) await SRV.stop(); console.error = REAL_CONSOLE_ERROR; });

/** 真 HTTP：`trust` 给免登信任头（= admin 全权），`cookie` 给会话 cookie（走强制改密闸） */
async function http(method, p, { trust = false, cookie = '', body } = {}) {
  const headers = {};
  if (trust) headers['x-ts-internal-user'] = 'admin';
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(SRV.base + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, res };
}

test('e2e 强制改密闸：POST cfg ⇒ 403；**PATCH cfg 与 DELETE feishu 无此闸** ⇒ 200', async () => {
  const login = await http('POST', '/api/auth/login',
    { body: { username: 'pwuser', password: 'pw123456' } });
  assert.equal(login.status, 200, login.text);
  const cookie = (login.res.headers.getSetCookie()[0] || '').split(';')[0];
  assert.match(cookie, /^ts_session=[0-9a-f]{64}$/);
  // 信任头会**整体跳过**这道闸（`_must_change_pw_blocked` 的插件形态例外）⇒ 本组一律走 cookie
  const before = SRV.stderr();
  const post = await http('POST', '/api/me/feishu-cfg', { cookie, body: {} });
  assert.equal(post.status, 403, post.text);
  assert.equal(post.text, '{"error":"请先修改初始口令"}');
  // 非**普通对象**的 cfg 行都会掐断连接 ⇒ 这两个 403 也不该在 handler 里留痕
  assert.equal(SRV.stderr(), before, '403 发生在 handler 之前 ⇒ 不许打印 inbound stderr 行');
  // PATCH / DELETE 不带这道闸：请求**进得去 handler**（本用例的判据就是「进得去」）
  const patch = await http('PATCH', '/api/me/feishu-cfg', { cookie, body: {} });
  assert.equal(patch.status, 200, patch.text);
  assert.equal(patch.text, OK_SPACED);
  const del = await http('DELETE', '/api/me/feishu', { cookie });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.text, OK_TIGHT);
  // 真进程 stderr：`start_inbound_for` 那一行逐字（oracle `feishu.py:1639-1641`）
  const added = SRV.stderr().slice(before.length).split('\n')
    .filter((l) => l.includes('feishu inbound:'));
  assert.deepEqual(added, [`feishu inbound: 用户 ${MCPW_UID} 应用凭据缺失，长连接未启动`]);
});

/**
 * ⚠ **这条曾在 2026-10-14 抓到一条跨车道缺陷（已由 Lead 订正，留档）** ⚠
 *
 * oracle **本机隔离实例实测**（`server.py:1023` 的 `do_GET` 与 `:1040` 的 `do_POST` **都**调
 * `_must_change_pw_blocked`，而 `do_PATCH`(1227)/`do_DELETE`(1266) 只有 401 检查）：
 *
 *   GET    /api/me/feishu-cfg      -> 403 {"error":"请先修改初始口令"}
 *   POST   /api/me/feishu-cfg      -> 403 同上
 *   PATCH  /api/me/feishu-cfg      -> 200 {"ok": true, "inbound_started": false, "verify": null}
 *   POST   /api/me/feishu-bindcode -> 403
 *   GET    /api/me/feishu          -> 403
 *   DELETE /api/me/feishu          -> 200 {"ok":true}
 *   GET    /api/me/feishu/outbox   -> 403
 *
 * 当时 `backend/server.js` 只写了 `method === 'POST' && mustChangePwBlocked(...)`（注释还写
 * 「只在 do_POST 里调」——与 `server.py:1023` 不符）⇒ Node 侧**任何 `/api/*` 的 GET 都不设这道闸**，
 * 持一次性口令的账号可以直接 GET 全部读端点。Lead 收到实测证据后已把判据改成
 * `path.startsWith('/api/') && (method === 'GET' || method === 'POST')`；本用例现在钉的是
 * **oracle 的四方法矩阵**（GET/POST 403、PATCH/DELETE 200），覆盖三个 GET 端点。
 */
test('e2e 强制改密闸矩阵：GET（cfg/me/outbox）与 POST ⇒ 403；PATCH cfg 与 DELETE feishu ⇒ 200',
  async () => {
    const login = await http('POST', '/api/auth/login',
      { body: { username: 'pwuser', password: 'pw123456' } });
    const cookie = (login.res.headers.getSetCookie()[0] || '').split(';')[0];
    assert.match(cookie, /^ts_session=[0-9a-f]{64}$/);
    for (const p of ['/api/me/feishu-cfg', '/api/me/feishu', '/api/me/feishu/outbox']) {
      const r = await http('GET', p, { cookie });
      assert.equal(r.status, 403, `GET ${p}: ${r.text}`);
      assert.equal(r.text, '{"error":"请先修改初始口令"}');
    }
    const bindcode = await http('POST', '/api/me/feishu-bindcode', { cookie });
    assert.equal(bindcode.status, 403, bindcode.text);
    assert.equal(bindcode.text, '{"error":"请先修改初始口令"}');
    // PATCH / DELETE 不带这道闸：请求真的**进得去 handler**（判据就是「进得去 + 业务码」）
    const patch = await http('PATCH', '/api/me/feishu-cfg', { cookie, body: {} });
    assert.equal(patch.status, 200, patch.text);
    assert.equal(patch.text, OK_SPACED);
    const del = await http('DELETE', '/api/me/feishu', { cookie });
    assert.equal(del.status, 200, del.text);
    assert.equal(del.text, OK_TIGHT);
  });

test('e2e 七端点走真 HTTP：cfg 八键逐字节 / GET me 打码 / outbox 三条判据 / PUT 501', async () => {
  // GET cfg（admin，无配置行）：八键逐字节
  const cfg = await http('GET', '/api/me/feishu-cfg', { trust: true });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.text, CFG_DEFAULT);
  // GET me：绑定行是夹具里 seed 的（open_id 7 码点含 emoji、default_project 指向他人项目）
  const me = await http('GET', '/api/me/feishu', { trust: true });
  assert.equal(me.status, 200);
  assert.equal(me.text, '{"bound": true, "open_id": "ou_a\u{1F600}x\u2026",'
    + ' "default_project": "pwuser 的项目"}');
  // bindcode：200 档的形状（正文随机 ⇒ 对拍覆盖不到，这里钉）
  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await http('POST', '/api/me/feishu-bindcode', { trust: true });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.match(body.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    codes.push(body.code);
  }
  assert.equal(new Set(codes).size, 3);
  // outbox：DESC + `?limit=1` 静默忽略 + user_id=0 不可见（夹具里 legacy 行 id 最大）
  const box = await http('GET', '/api/me/feishu/outbox', { trust: true });
  assert.equal(box.status, 200);
  assert.equal(box.text, '[{"id": 2, "status": "failed", "retries": 0, "last_error": "",'
    + ' "created_at": "2026-10-11 00:00:02", "target": "https://x/2"},'
    + ' {"id": 1, "status": "failed", "retries": 0, "last_error": "",'
    + ' "created_at": "2026-10-11 00:00:00", "target": "https://x/1"}]');
  const boxLimit = await http('GET', '/api/me/feishu/outbox?limit=1', { trust: true });
  assert.equal(boxLimit.text, box.text, '`?limit=1` 必须被静默忽略');
  // PUT 未支持 ⇒ 501 + Python 标准 HTML 错误页（发生在鉴权之前）
  const put = await http('PUT', '/api/me/feishu-cfg', { trust: true, body: {} });
  assert.equal(put.status, 501);
  assert.match(put.text, /<title>Error response<\/title>/);
  assert.match(put.text, /Unsupported method \('PUT'\)\./);
});
