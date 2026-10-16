/**
 * M6.9 账号/管理写端点单测：**8 条端点 + cookie 会话分支 + 登录限流**。
 *
 * 判据的来源是 `server.py`（逐行对照，不是读 Node 实现反推）：
 *   - `_api_login`(1490) / `_api_logout`(1520) / `_api_register`(1541) /
 *     `_api_change_password`(1576)；
 *   - `_api_admin_create_user`(1627) / `_api_admin_update_user`(1650) /
 *     `_api_admin_delete_user`(1685)；
 *   - `_current_user`(5240) / `_cookie_token`(5249) / `_trusted_admin_request`(5218)；
 *   - `_pw_str`(568) / `_req_str`(577) / `USERNAME_RE`(567)。
 *
 * 为什么这些用例必须写完（本批最容易错的三类）：
 *   ① **错误体的空格口径**：Python 同一份源码里并存「硬编码紧凑字节串」与 `json.dumps`
 *      （带空格）两种错误体。账号族**全部是紧凑体**，写成 `ctx.errorSpaced` 每个点差 1 字节。
 *      故这里断言的是 `Buffer.toString()` 的**完整正文**，不是只看状态码。
 *   ② **readBody 的时机**：`logout` 不读体、`change_password` handler 内自己读体
 *      （`routes/index.js` 的旧注释把两者都写成「不读体」，本批已订正）。不读体的后果是
 *      确定性的：新口令恒空 ⇒ 一律 400「新密码至少 6 位」。用 `req.readableFlowing`
 *      （null = 无人消费；true = 有消费者）把「读没读」直接钉住。
 *   ③ **限流的时机**：`allow(ip)` 在读体与口令校验**之前**、`record(ip)` 在查库之后且
 *      **无论成败都记**。写反了会让「正确口令也被限流」这条失效（暴力破解防线消失）。
 *
 * 测试台说明：`currentUser` 是 `server.js` 内部的闭包（`server.js` 顶层 `await main()`，
 * 不可 import）⇒ cookie 会话分支的判据写成「`cookieToken` + `getSession` + `getUserById`
 * 三步组合」的等价单测（见本文件末尾），真实接线由实例级 `http-run` 覆盖。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { LoginLimiter } from '../lib/auth.js';
import { cookieToken } from '../lib/cookie.js';
import * as dbmod from '../lib/db.js';
import { dispatch, isPublicRoute, makeContext } from '../routes/index.js';
import { makeLoginHandler, pwStr, reqStr } from '../routes/admin.js';
import { freshDb } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 独立算 MD5（不借道 lib/auth.js：避免「用实现证实现」） */
const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');
/** `YYYY-MM-DD HH:MM:SS` 本地时间（与 `db.nowStr()`/`auth.sessionExpiry` 同口径，独立手拼） */
function localStamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 假 req（写法同 `write-base.test.mjs`）+ 可选 `socket.remoteAddress`（限流按 ip 分桶用） */
function fakeReq(headers = {}, body = '', ip) {
  const chunks = body === '' ? [] : [Buffer.from(String(body), 'utf8')];
  const stream = Readable.from(chunks, { objectMode: false });
  stream.headers = headers;
  if (ip !== undefined) stream.socket = { remoteAddress: ip };
  return stream;
}

/** 假 res：捕获状态码/响应头/**正文 Buffer**（判据是字节，不是「跑通」） */
function fakeRes() {
  const cap = { status: null, headers: null, body: null };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) {
        cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
      },
    },
  };
}

/**
 * 造一个 ctx（body 给对象即自动 JSON 化 + 补 Content-Length；`body: null` = 无请求体）。
 * `ip` 走 `req.socket.remoteAddress`（登录限流的维度）。
 */
function makeCtx({ db, user = null, method = 'POST', path = '/api/x', body = null,
  headers = {}, ip, trusted = false }) {
  const raw = body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...headers };
  if (raw !== '') h['content-length'] = String(Buffer.byteLength(raw, 'utf8'));
  const req = fakeReq(h, raw, ip);
  req.method = method;
  const { res, cap } = fakeRes();
  const ctx = makeContext({ req, res, db, user, path, search: '', trusted });
  return { ctx, cap, req };
}

/** 走 ROUTES 表分派（连路由表/正则/方法匹配一起验） */
async function runRoute(spec) {
  const { ctx, cap, req } = makeCtx(spec);
  const hit = await dispatch(ctx);
  assert.equal(hit, true, `路由表未命中 ${spec.method || 'POST'} ${spec.path}`);
  return { ctx, cap, req };
}

/** 直调 handler（注入限流器等需要绕开模块级单例的场合） */
async function runHandler(handler, spec) {
  const { ctx, cap, req } = makeCtx(spec);
  await handler(ctx);
  return { ctx, cap, req };
}

/** 夹具：临时库（真启动序建库）+ 真 SQL 造用户 */
async function useFixture(tag, body) {
  const fx = freshDb(`auth-${tag}`);
  try {
    await body(fx);
  } finally {
    fx.close();
  }
}

/** 插一个已知口令的用户（返回行；`mustChange` = 置一次性口令标记） */
function addUser(fx, username, password, { mustChange = 0 } = {}) {
  const id = dbmod.insertUser(username, md5(password), '', { db: fx.db });
  if (mustChange) fx.db.prepare('UPDATE users SET must_change_pw=1 WHERE id=?').run(id);
  return dbmod.getUserById(fx.db, id);
}

/** 库里的会话行（判「真建了/真删了」，不看响应自称） */
const sessions = (fx) => fx.db.prepare('SELECT * FROM sessions ORDER BY token').all();

// --------------------------------------------------------------------------
// 入参规范化：`_pw_str` / `_req_str`
// --------------------------------------------------------------------------

test('pwStr/reqStr：只有字符串照收，null/数字/数组/对象/布尔/undefined 一律空串', () => {
  for (const helper of [pwStr, reqStr]) {
    assert.equal(helper('abc'), 'abc');
    assert.equal(helper(''), '');
    assert.equal(helper('中文口令'), '中文口令');
    for (const value of [null, undefined, 0, 1, -1, 3.5, true, false, [], ['a'], {}, { a: 1 }]) {
      assert.equal(helper(value), '', `输入 ${JSON.stringify(value) ?? 'undefined'}`);
    }
  }
});

// --------------------------------------------------------------------------
// 登录：`_api_login`(1490)
// --------------------------------------------------------------------------

test('登录成功：正文逐字节（带空格）+ Set-Cookie 整串 + 头顺序 + 会话落库', async () => {
  await useFixture('login-ok', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456');
    const { cap } = await runHandler(makeLoginHandler({ limiter: new LoginLimiter() }), {
      db: fx.db, body: { username: 'alice', password: 'pw123456' },
    });
    assert.equal(cap.status, 200);
    const raw = cap.body.toString('utf8');
    const parsed = JSON.parse(raw);
    assert.match(parsed.token, /^[0-9a-f]{64}$/, '64 位小写 hex（auth.new_token）');
    assert.deepEqual(Object.keys(parsed), ['token', 'username', 'must_change_password']);
    assert.equal(parsed.username, 'alice');
    assert.equal(parsed.must_change_password, false);
    // 正文逐字节：json.dumps(..., ensure_ascii=False) 的分隔符是 ", " / ": "
    assert.equal(raw, `{"token": "${parsed.token}", "username": "alice",`
      + ' "must_change_password": false}');
    // Set-Cookie 整串（属性顺序、空格、Max-Age=604800 = auth.SESSION_TTL 逐字节照抄）
    assert.equal(cap.headers['Set-Cookie'],
      `ts_session=${parsed.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    // 手工发送的四件头与顺序（Python `_api_login` 1552-1560 的 send_header 次序）
    assert.deepEqual(Object.keys(cap.headers),
      ['Set-Cookie', 'Content-Type', 'Content-Length', 'Cache-Control']);
    assert.equal(cap.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(cap.headers['Content-Length'], String(Buffer.byteLength(raw, 'utf8')));
    assert.equal(cap.headers['Cache-Control'], 'no-store');
    const rows = sessions(fx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, parsed.token);
    assert.equal(rows[0].user_id, alice.id);
  });
});

test('登录成功：must_change_pw=1 ⇒ must_change_password: true（bool(row["must_change_pw"])）', async () => {
  await useFixture('login-mcp', async (fx) => {
    addUser(fx, 'seed1', 'pw123456', { mustChange: 1 });
    const { cap } = await runHandler(makeLoginHandler({ limiter: new LoginLimiter() }), {
      db: fx.db, body: { username: 'seed1', password: 'pw123456' },
    });
    const raw = cap.body.toString('utf8');
    const parsed = JSON.parse(raw);
    assert.equal(raw, `{"token": "${parsed.token}", "username": "seed1",`
      + ' "must_change_password": true}');
  });
});

test('登录失败：用户不存在与口令错误**同一紧凑 401 体**（不泄露用户是否存在）', async () => {
  await useFixture('login-bad', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    for (const body of [
      { username: 'alice', password: 'wrong-pass' },
      { username: 'nobody', password: 'pw123456' },
    ]) {
      const { cap } = await runHandler(makeLoginHandler({ limiter: new LoginLimiter() }), {
        db: fx.db, body,
      });
      assert.equal(cap.status, 401);
      assert.equal(cap.body.toString('utf8'), '{"error":"用户名或密码错误"}');   // 紧凑，无空格
      assert.equal(cap.headers['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(cap.headers['Cache-Control'], 'no-store');
      assert.equal(sessions(fx).length, 0, '失败登录不许建会话');
    }
  });
});

test('登录：非字符串 password（null/数字/数组/对象）经 _pw_str 折空串 ⇒ 401，不是 500', async () => {
  await useFixture('login-nonstr', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    for (const password of [null, 123456, ['pw123456'], { v: 'pw123456' }]) {
      const { cap } = await runHandler(makeLoginHandler({ limiter: new LoginLimiter() }), {
        db: fx.db, body: { username: 'alice', password },
      });
      assert.equal(cap.status, 401, `password=${JSON.stringify(password)}`);
      assert.equal(cap.body.toString('utf8'), '{"error":"用户名或密码错误"}');
    }
  });
});

test('登录限流：第 11 次 429，**正确口令也 429**（allow 在口令校验之前）', async () => {
  await useFixture('login-limit', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    const limiter = new LoginLimiter();            // 10 次 / 60 秒（auth.LoginLimiter 缺省）
    const handler = makeLoginHandler({ limiter });
    for (let i = 1; i <= 10; i += 1) {
      const { cap } = await runHandler(handler, {
        db: fx.db, ip: '10.0.0.1', body: { username: 'alice', password: `wrong-${i}` },
      });
      assert.equal(cap.status, 401, `第 ${i} 次仍在窗口内 ⇒ 401`);
    }
    const { cap } = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.1', body: { username: 'alice', password: 'wrong-11' },
    });
    assert.equal(cap.status, 429);
    assert.equal(cap.body.toString('utf8'), '{"error":"尝试过于频繁，请稍后再试"}');   // 紧凑
    // ★ 判据核心：正确口令也 429 ⇒ 限流在门禁位置，不是「失败计数到阈值才拦」
    const correct = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.1', body: { username: 'alice', password: 'pw123456' },
    });
    assert.equal(correct.cap.status, 429);
    assert.equal(sessions(fx).length, 0, '被限流的正确口令不许建会话');
  });
});

test('登录限流：被限流时**不读请求体**（allow 在读体之前，照 oracle 行序）', async () => {
  await useFixture('login-limit-body', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    const handler = makeLoginHandler({ limiter: new LoginLimiter(0, 60) });   // 一次都不放行
    const { cap, req } = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.2', body: { username: 'alice', password: 'pw123456' },
    });
    assert.equal(cap.status, 429);
    assert.equal(req.readableFlowing, null, '被拦时请求体不该被消费（Python 同理）');
  });
});

test('登录限流：滑动窗口过期后恢复（小窗口注入式构造）', async () => {
  await useFixture('login-window', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    const handler = makeLoginHandler({ limiter: new LoginLimiter(1, 0.05) });  // 1 次 / 50ms
    const first = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.3', body: { username: 'alice', password: 'wrong' },
    });
    assert.equal(first.cap.status, 401);
    const second = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.3', body: { username: 'alice', password: 'wrong' },
    });
    assert.equal(second.cap.status, 429);
    await sleep(80);                                     // 窗口（50ms）过期 ⇒ 记录被剪掉
    const third = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.3', body: { username: 'alice', password: 'pw123456' },
    });
    assert.equal(third.cap.status, 200);
  });
});

test('登录限流：按 ip 分桶（一个 ip 被限不牵连另一个）', async () => {
  await useFixture('login-bucket', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    const handler = makeLoginHandler({ limiter: new LoginLimiter(1, 60) });
    assert.equal((await runHandler(handler, {
      db: fx.db, ip: '10.0.0.4', body: { username: 'alice', password: 'wrong' },
    })).cap.status, 401);
    assert.equal((await runHandler(handler, {
      db: fx.db, ip: '10.0.0.4', body: { username: 'alice', password: 'pw123456' },
    })).cap.status, 429);
    assert.equal((await runHandler(handler, {
      db: fx.db, ip: '10.0.0.5', body: { username: 'alice', password: 'pw123456' },
    })).cap.status, 200, '另一个 ip 的窗口是独立的');
  });
});

test('登录限流：路由表缺省 handler 用**模块级单例**（跨请求共享计数，= Handler.limiter 类属性）', async () => {
  await useFixture('login-singleton', async (fx) => {
    addUser(fx, 'alice', 'pw123456');
    const ip = '192.0.2.10';                       // 专用 ip：污染只限于这个桶
    for (let i = 1; i <= 10; i += 1) {
      const { cap } = await runRoute({
        db: fx.db, ip, path: '/api/auth/login',
        body: { username: 'alice', password: `wrong-${i}` },
      });
      assert.equal(cap.status, 401, `第 ${i} 次`);
    }
    const { cap } = await runRoute({
      db: fx.db, ip, path: '/api/auth/login',
      body: { username: 'alice', password: 'pw123456' },
    });
    assert.equal(cap.status, 429, '第 11 次必须 429——计数跨请求保留即单例的证据');
  });
});

// --------------------------------------------------------------------------
// 注册：`_api_register`(1541)
// --------------------------------------------------------------------------

test('注册成功：正文**只有两个键** + Set-Cookie + MD5/空盐落库 + 自动登录建会话', async () => {
  await useFixture('register-ok', async (fx) => {
    const { cap } = await runRoute({
      db: fx.db, path: '/api/auth/register',
      body: { username: 'newbie', password: 'pw123456' },
    });
    assert.equal(cap.status, 200);
    const raw = cap.body.toString('utf8');
    const parsed = JSON.parse(raw);
    assert.match(parsed.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(parsed), ['token', 'username']);   // **没有** must_change_password
    assert.equal(raw, `{"token": "${parsed.token}", "username": "newbie"}`);
    assert.equal(cap.headers['Set-Cookie'],
      `ts_session=${parsed.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    const row = dbmod.getUserByName(fx.db, 'newbie');
    assert.equal(row.pass_hash, md5('pw123456'), '需求约定：无盐 MD5');
    assert.equal(row.salt, '', 'md5_password 的盐恒为空串');
    assert.equal(row.must_change_pw, 0);
    const rows = sessions(fx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, row.id);
  });
});

test('注册：用户名非法（1 位 / 33 位 / 中文 / 数组 / 缺键）⇒ 400 同一文案', async () => {
  await useFixture('register-badname', async (fx) => {
    const cases = [
      { username: 'x', password: 'pw123456' },
      { username: 'a'.repeat(33), password: 'pw123456' },
      { username: '带中文', password: 'pw123456' },
      { username: ['a', 'b'], password: 'pw123456' },
      { password: 'pw123456' },
    ];
    for (const body of cases) {
      const { cap } = await runRoute({ db: fx.db, path: '/api/auth/register', body });
      assert.equal(cap.status, 400, JSON.stringify(body));
      assert.equal(cap.body.toString('utf8'), '{"error":"用户名须为 2-32 位字母数字或 _ . -"}');
    }
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, '失败不许落行');
  });
});

test('注册：口令不足 6 位 ⇒ 400（长度按**码点**数：3 个 emoji 是 3 位，不是 6）', async () => {
  await useFixture('register-shortpw', async (fx) => {
    for (const password of ['12345', '😀😀😀', null, 123456]) {
      const { cap } = await runRoute({
        db: fx.db, path: '/api/auth/register', body: { username: 'newbie9', password },
      });
      assert.equal(cap.status, 400, `password=${JSON.stringify(password)}`);
      assert.equal(cap.body.toString('utf8'), '{"error":"密码至少 6 位"}');
    }
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  });
});

test('注册：重名 ⇒ 400「用户名已存在」（IntegrityError 翻译，不是 500）且不落第二行', async () => {
  await useFixture('register-dup', async (fx) => {
    addUser(fx, 'newbie', 'pw123456');
    const { cap } = await runRoute({
      db: fx.db, path: '/api/auth/register',
      body: { username: 'newbie', password: 'another-pw' },
    });
    assert.equal(cap.status, 400);
    assert.equal(cap.body.toString('utf8'), '{"error":"用户名已存在"}');
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);  // admin + newbie
    assert.equal(sessions(fx).length, 0);
  });
});

test('注册：用户名两侧空白被 strip（`_req_str(...).strip()`），回包用 strip 后的名字', async () => {
  await useFixture('register-strip', async (fx) => {
    const { cap } = await runRoute({
      db: fx.db, path: '/api/auth/register',
      body: { username: '  newbie2  ', password: 'pw123456' },
    });
    assert.equal(cap.status, 200);
    const parsed = JSON.parse(cap.body.toString('utf8'));
    assert.equal(parsed.username, 'newbie2');
    assert.notEqual(dbmod.getUserByName(fx.db, 'newbie2'), null);
  });
});

// --------------------------------------------------------------------------
// 登出：`_api_logout`(1520)
// --------------------------------------------------------------------------

test('登出：删会话行 + 清 cookie 整串 + 紧凑 {"ok":true} + **不读请求体**', async () => {
  await useFixture('logout', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456');
    const token = 'b'.repeat(64);
    dbmod.createSession(fx.db, alice.id, token, localStamp(Date.now() + 3600_000));
    const { cap, req } = await runRoute({
      db: fx.db, path: '/api/auth/logout', body: { unused: true },
      headers: { cookie: `ts_session=${token}` },
    });
    assert.equal(cap.status, 200);
    assert.equal(cap.body.toString('utf8'), '{"ok":true}');      // 紧凑硬编码字节串
    assert.equal(cap.headers['Set-Cookie'],
      'ts_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    assert.deepEqual(Object.keys(cap.headers),
      ['Set-Cookie', 'Content-Type', 'Content-Length', 'Cache-Control']);
    assert.equal(sessions(fx).length, 0, '会话行必须真删掉（登出的唯一判据）');
    assert.equal(req.readableFlowing, null, 'logout 不读体（Python 该 handler 没有 _read_json）');
  });
});

test('登出：无 cookie / 空值 ts_session / 不存在的 token ⇒ 仍 200（delete_session(null) 删 0 行）', async () => {
  await useFixture('logout-none', async (fx) => {
    for (const headers of [{}, { cookie: 'ts_session=' }, { cookie: 'ts_session=deadbeef' }]) {
      const { cap } = await runRoute({ db: fx.db, path: '/api/auth/logout', headers });
      assert.equal(cap.status, 200, JSON.stringify(headers));
      assert.equal(cap.body.toString('utf8'), '{"ok":true}');
    }
  });
});

// --------------------------------------------------------------------------
// 改密：`_api_change_password`(1576)
// --------------------------------------------------------------------------

test('改密成功：**必须读体**（新口令生效）+ must_change_pw 清 0 + 紧凑 {"ok":true}', async () => {
  await useFixture('chpw-ok', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456', { mustChange: 1 });
    const { cap, req } = await runRoute({
      db: fx.db, user: alice, path: '/api/auth/change_password',
      body: { old_password: 'pw123456', new_password: 'pw654321' },
    });
    assert.equal(cap.status, 200);
    assert.equal(cap.body.toString('utf8'), '{"ok":true}');
    assert.equal(req.readableFlowing, true, 'handler 内部自己读体（server.py:1578）');
    const row = dbmod.getUserById(fx.db, alice.id);
    assert.equal(row.pass_hash, md5('pw654321'), '改密真的换了哈希');
    assert.equal(row.salt, '');
    assert.equal(row.must_change_pw, 0, 'db.change_password 顺带清强制改密标记');
  });
});

test('改密：原口令错 ⇒ 400「原密码错误」（紧凑），哈希不变', async () => {
  await useFixture('chpw-wrong', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456');
    const { cap } = await runRoute({
      db: fx.db, user: alice, path: '/api/auth/change_password',
      body: { old_password: 'not-the-password', new_password: 'pw654321' },
    });
    assert.equal(cap.status, 400);
    assert.equal(cap.body.toString('utf8'), '{"error":"原密码错误"}');
    assert.equal(dbmod.getUserById(fx.db, alice.id).pass_hash, md5('pw123456'));
  });
});

test('改密：新口令不足 6 位（含 5 位 ASCII 与 3 个 emoji 的码点口径）⇒ 400，且在校验原口令之后', async () => {
  await useFixture('chpw-short', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456');
    for (const newPw of ['12345', '😀😀😀', null]) {
      const { cap } = await runRoute({
        db: fx.db, user: alice, path: '/api/auth/change_password',
        body: { old_password: 'pw123456', new_password: newPw },
      });
      assert.equal(cap.status, 400, `new=${JSON.stringify(newPw)}`);
      assert.equal(cap.body.toString('utf8'), '{"error":"新密码至少 6 位"}');
    }
    assert.equal(dbmod.getUserById(fx.db, alice.id).pass_hash, md5('pw123456'));
  });
});

test('改密：免登信任头（ctx.trusted）下**不校验原口令**（插件形态免锁死口径）', async () => {
  await useFixture('chpw-trusted', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456', { mustChange: 1 });
    const { cap } = await runRoute({
      db: fx.db, user: alice, trusted: true, path: '/api/auth/change_password',
      body: { old_password: '', new_password: 'pw654321' },
    });
    assert.equal(cap.status, 200);
    assert.equal(dbmod.getUserById(fx.db, alice.id).pass_hash, md5('pw654321'));
    assert.equal(dbmod.getUserById(fx.db, alice.id).must_change_pw, 0);
  });
});

test('改密：**新口令真的能登录、旧口令真的失效**（防「改密只是回了个 200」）', async () => {
  await useFixture('chpw-relogin', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456');
    const handler = makeLoginHandler({ limiter: new LoginLimiter() });
    const changed = await runRoute({
      db: fx.db, user: alice, path: '/api/auth/change_password',
      body: { old_password: 'pw123456', new_password: 'pw654321' },
    });
    assert.equal(changed.cap.status, 200);
    const fresh = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.9', body: { username: 'alice', password: 'pw654321' },
    });
    assert.equal(fresh.cap.status, 200);
    const dead = await runHandler(handler, {
      db: fx.db, ip: '10.0.0.9', body: { username: 'alice', password: 'pw123456' },
    });
    assert.equal(dead.cap.status, 401);
  });
});

test('makeContext：trusted 缺省 false，显式传入透传（server.js 用 hasTrustHeader 传它）', async () => {
  await useFixture('ctx-trusted', async (fx) => {
    assert.equal(makeCtx({ db: fx.db }).ctx.trusted, false);
    assert.equal(makeCtx({ db: fx.db, trusted: true }).ctx.trusted, true);
  });
});

// --------------------------------------------------------------------------
// 管理端建号：`_api_admin_create_user`(1627)
// --------------------------------------------------------------------------

test('建号：admin ⇒ 200 {"id": 2}（**带空格**）+ MD5/空盐落库 + 不自动建会话', async () => {
  await useFixture('admin-create', async (fx) => {
    const { cap } = await runRoute({
      db: fx.db, user: dbmod.getUserByName(fx.db, 'admin'), path: '/api/admin/users',
      body: { username: 'byadmin', password: 'pw123456' },
    });
    assert.equal(cap.status, 200);
    assert.equal(cap.body.toString('utf8'), '{"id": 2}');       // json.dumps ⇒ 冒号后带空格
    assert.equal(cap.headers['Content-Type'], 'application/json; charset=utf-8');
    const row = dbmod.getUserByName(fx.db, 'byadmin');
    assert.equal(row.id, 2);
    assert.equal(row.pass_hash, md5('pw123456'));
    assert.equal(row.salt, '');
    assert.equal(sessions(fx).length, 0, '建号不登录');
  });
});

test('建号：非 admin ⇒ 403「仅管理员可操作」（紧凑）且不落行；门禁在写库之前', async () => {
  await useFixture('admin-create-403', async (fx) => {
    const bob = addUser(fx, 'bob', 'pw123456');
    const { cap } = await runRoute({
      db: fx.db, user: bob, path: '/api/admin/users',
      body: { username: 'sneaky', password: 'pw123456' },
    });
    assert.equal(cap.status, 403);
    assert.equal(cap.body.toString('utf8'), '{"error":"仅管理员可操作"}');
    assert.equal(dbmod.getUserByName(fx.db, 'sneaky'), null);
  });
});

test('建号：三道 400 逐字节（用户名非法 / 口令太短 / 重名）', async () => {
  await useFixture('admin-create-400', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    addUser(fx, 'taken', 'pw123456');
    const cases = [
      [{ username: '带中文', password: 'pw123456' }, '{"error":"用户名须为 2-32 位字母数字或 _ . -"}'],
      [{ username: 'byadmin9', password: '12345' }, '{"error":"密码至少 6 位"}'],
      [{ username: 'taken', password: 'pw123456' }, '{"error":"用户名已存在"}'],
    ];
    for (const [body, expected] of cases) {
      const { cap } = await runRoute({ db: fx.db, user: admin, path: '/api/admin/users', body });
      assert.equal(cap.status, 400, JSON.stringify(body));
      assert.equal(cap.body.toString('utf8'), expected);
    }
  });
});

// --------------------------------------------------------------------------
// 管理端改号：`_api_admin_update_user`(1650)（POST 与 PATCH 同一 handler）
// --------------------------------------------------------------------------

test('改号：改名 ⇒ 200 紧凑 {"ok":true}，不传 password 时 hash/salt 保持存量', async () => {
  await useFixture('admin-update', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const bob = addUser(fx, 'bob', 'pw123456');
    const { cap } = await runRoute({
      db: fx.db, user: admin, method: 'PATCH', path: `/api/admin/users/${bob.id}`,
      body: { username: 'bob2' },
    });
    assert.equal(cap.status, 200);
    assert.equal(cap.body.toString('utf8'), '{"ok":true}');
    const row = dbmod.getUserById(fx.db, bob.id);
    assert.equal(row.username, 'bob2');
    assert.equal(row.pass_hash, md5('pw123456'), '空口令 = 保留存量哈希');
    assert.equal(row.salt, '');
  });
});

test('改号：**POST 与 PATCH 是同一个 handler**（oracle 两个分派点都指向 _api_admin_update_user）', async () => {
  await useFixture('admin-update-post', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const bob = addUser(fx, 'bob', 'pw123456');
    const viaPatch = await runRoute({
      db: fx.db, user: admin, method: 'PATCH', path: `/api/admin/users/${bob.id}`,
      body: { username: 'bob2' },
    });
    assert.equal(viaPatch.cap.body.toString('utf8'), '{"ok":true}');
    const viaPost = await runRoute({
      db: fx.db, user: admin, method: 'POST', path: `/api/admin/users/${bob.id}`,
      body: { username: 'bob3', password: 'pw654321' },
    });
    assert.equal(viaPost.cap.status, 200);
    assert.equal(viaPost.cap.body.toString('utf8'), '{"ok":true}');
    const row = dbmod.getUserById(fx.db, bob.id);
    assert.equal(row.username, 'bob3');
    assert.equal(row.pass_hash, md5('pw654321'), '带口令 ⇒ 换哈希');
  });
});

test('改号：用户名取存量（缺键 / 空串 / []）⇒ 200 幂等；`[]` 不许被当成空串误判 400', async () => {
  await useFixture('admin-update-keep', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const bob = addUser(fx, 'bob', 'pw123456');
    // Python `body.get("username") or row["username"]`：[] 在 Python 是**假值** ⇒ 取存量。
    // JS 的 `||` 会把 [] 当 truthy ⇒ 实现若不用 pyTruthy，这条会回 400。
    for (const body of [{}, { username: '' }, { username: [] }, { username: null }]) {
      const { cap } = await runRoute({
        db: fx.db, user: admin, method: 'PATCH', path: `/api/admin/users/${bob.id}`, body,
      });
      assert.equal(cap.status, 200, JSON.stringify(body));
      assert.equal(cap.body.toString('utf8'), '{"ok":true}');
      assert.equal(dbmod.getUserById(fx.db, bob.id).username, 'bob');
    }
  });
});

test('改号：404「user not found」紧凑体（行不存在时先于一切校验）', async () => {
  await useFixture('admin-update-404', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    for (const method of ['PATCH', 'POST']) {
      const { cap } = await runRoute({
        db: fx.db, user: admin, method, path: '/api/admin/users/999999', body: {},
      });
      assert.equal(cap.status, 404, method);
      assert.equal(cap.body.toString('utf8'), '{"error":"user not found"}');
    }
  });
});

test('改号：admin 账号不许改名 ⇒ 400；改成 admin 自己（同名）不受此限', async () => {
  await useFixture('admin-update-admin', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const forbidden = await runRoute({
      db: fx.db, user: admin, method: 'PATCH', path: `/api/admin/users/${admin.id}`,
      body: { username: 'root' },
    });
    assert.equal(forbidden.cap.status, 400);
    assert.equal(forbidden.cap.body.toString('utf8'), '{"error":"管理员账号不允许改名"}');
    const same = await runRoute({
      db: fx.db, user: admin, method: 'PATCH', path: `/api/admin/users/${admin.id}`,
      body: { username: 'admin' },
    });
    assert.equal(same.cap.status, 200);
    assert.equal(dbmod.getUserByName(fx.db, 'admin').id, admin.id);
  });
});

test('改号：用户名非法 / 口令非空但太短 / 重名 ⇒ 三道 400 逐字节', async () => {
  await useFixture('admin-update-400', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const bob = addUser(fx, 'bob', 'pw123456');
    addUser(fx, 'taken', 'pw123456');
    const cases = [
      [{ username: '带中文' }, '{"error":"用户名须为 2-32 位字母数字或 _ . -"}'],
      [{ password: '12345' }, '{"error":"密码至少 6 位"}'],
      [{ password: '😀😀😀' }, '{"error":"密码至少 6 位"}'],
      [{ username: 'taken' }, '{"error":"用户名已存在"}'],
    ];
    for (const [patch, expected] of cases) {
      const { cap } = await runRoute({
        db: fx.db, user: admin, method: 'PATCH', path: `/api/admin/users/${bob.id}`, body: patch,
      });
      assert.equal(cap.status, 400, JSON.stringify(patch));
      assert.equal(cap.body.toString('utf8'), expected);
    }
    const row = dbmod.getUserById(fx.db, bob.id);
    assert.equal(row.username, 'bob');
    assert.equal(row.pass_hash, md5('pw123456'));
  });
});

test('改号：非 admin ⇒ 403（门禁先于 404/400）', async () => {
  await useFixture('admin-update-403', async (fx) => {
    const bob = addUser(fx, 'bob', 'pw123456');
    const { cap } = await runRoute({
      db: fx.db, user: bob, method: 'PATCH', path: '/api/admin/users/999999', body: {},
    });
    assert.equal(cap.status, 403);
    assert.equal(cap.body.toString('utf8'), '{"error":"仅管理员可操作"}');
  });
});

// --------------------------------------------------------------------------
// 管理端删号：`_api_admin_delete_user`(1685)
// --------------------------------------------------------------------------

test('删号：成功 ⇒ 200 紧凑 {"ok":true}，用户与其会话行一并删除', async () => {
  await useFixture('admin-delete', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const bob = addUser(fx, 'bob', 'pw123456');
    dbmod.createSession(fx.db, bob.id, 'c'.repeat(64), localStamp(Date.now() + 3600_000));
    assert.equal(sessions(fx).length, 1);
    const { cap } = await runRoute({
      db: fx.db, user: admin, method: 'DELETE', path: `/api/admin/users/${bob.id}`,
    });
    assert.equal(cap.status, 200);
    assert.equal(cap.body.toString('utf8'), '{"ok":true}');
    assert.equal(dbmod.getUserById(fx.db, bob.id), null);
    assert.equal(sessions(fx).length, 0, 'db.delete_user 连带删会话');
  });
});

test('删号：不存在的用户 ⇒ 404「user not found」紧凑体', async () => {
  await useFixture('admin-delete-404', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const { cap } = await runRoute({
      db: fx.db, user: admin, method: 'DELETE', path: '/api/admin/users/999999',
    });
    assert.equal(cap.status, 404);
    assert.equal(cap.body.toString('utf8'), '{"error":"user not found"}');
  });
});

test('删号：admin 账号 ⇒ 400「管理员账号不允许删除」', async () => {
  await useFixture('admin-delete-admin', async (fx) => {
    const admin = dbmod.getUserByName(fx.db, 'admin');
    const { cap } = await runRoute({
      db: fx.db, user: admin, method: 'DELETE', path: `/api/admin/users/${admin.id}`,
    });
    assert.equal(cap.status, 400);
    assert.equal(cap.body.toString('utf8'), '{"error":"管理员账号不允许删除"}');
    assert.notEqual(dbmod.getUserById(fx.db, admin.id), null);
  });
});

test('删号：不能删当前登录用户（构造「同一 id、库里已是普通名」的竞态现场）', async () => {
  await useFixture('admin-delete-self', async (fx) => {
    // 生产中该分支要「ctx.user 与目标行同 id 而目标行已不是 admin」的竞态才可达
    // （admin 那条门禁先命中）；这里直接构造现场，把 oracle 的第三条判据钉住。
    const bob = addUser(fx, 'bob', 'pw123456');
    const staleAdmin = { ...dbmod.getUserByName(fx.db, 'admin'), id: bob.id };
    const { cap } = await runRoute({
      db: fx.db, user: staleAdmin, method: 'DELETE', path: `/api/admin/users/${bob.id}`,
    });
    assert.equal(cap.status, 400);
    assert.equal(cap.body.toString('utf8'), '{"error":"不能删除当前登录用户"}');
    assert.notEqual(dbmod.getUserById(fx.db, bob.id), null);
  });
});

test('删号：非 admin ⇒ 403（先于 404 与 admin 账号判定）', async () => {
  await useFixture('admin-delete-403', async (fx) => {
    const bob = addUser(fx, 'bob', 'pw123456');
    const target = addUser(fx, 'carol', 'pw123456');
    const { cap } = await runRoute({
      db: fx.db, user: bob, method: 'DELETE', path: `/api/admin/users/${target.id}`,
    });
    assert.equal(cap.status, 403);
    assert.equal(cap.body.toString('utf8'), '{"error":"仅管理员可操作"}');
    assert.notEqual(dbmod.getUserById(fx.db, target.id), null);
  });
});

// --------------------------------------------------------------------------
// 公开端点标记与 cookie 会话分支
// --------------------------------------------------------------------------

test('isPublicRoute：只有 POST /api/auth/login|register 为真（名单从 ROUTES 派生）', () => {
  assert.equal(isPublicRoute('POST', '/api/auth/login'), true);
  assert.equal(isPublicRoute('post', '/api/auth/register'), true);      // 方法名大小写不敏感
  for (const [method, path] of [
    ['GET', '/api/auth/login'],                 // 方法不符 ⇒ 不是公开端点
    ['POST', '/api/auth/logout'],               // 已登录才可登出
    ['POST', '/api/auth/change_password'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/admin/users'],
    ['GET', '/api/admin/users'],
    ['POST', '/api/auth/login/'],               // 字面路径精确相等
    ['POST', '/api/auth/loginx'],
  ]) {
    assert.equal(isPublicRoute(method, path), false, `${method} ${path}`);
  }
});

test('登录/注册：ctx.user 为 null 也能跑（公开端点在鉴权之前分派）', async () => {
  await useFixture('public-null-user', async (fx) => {
    const ok = await runRoute({
      db: fx.db, user: null, path: '/api/auth/register',
      body: { username: 'newbie', password: 'pw123456' },
    });
    assert.equal(ok.cap.status, 200);
    const bad = await runRoute({
      db: fx.db, user: null, path: '/api/auth/login',
      body: { username: 'newbie', password: 'wrong' },
    });
    assert.equal(bad.cap.status, 401);
  });
});

test('cookie 会话分支 = _current_user 的三步组合（cookieToken → getSession → getUserById）', async () => {
  await useFixture('cookie-session', async (fx) => {
    const alice = addUser(fx, 'alice', 'pw123456');
    const token = 'd'.repeat(64);
    dbmod.createSession(fx.db, alice.id, token, localStamp(Date.now() + 3600_000));

    // ① cookie 解析（头名大小写不敏感、cookie 名精确）
    assert.equal(cookieToken({ cookie: `ts_session=${token}` }), token);
    assert.equal(cookieToken({ Cookie: `ts_session=${token}` }), token);   // Python headers 大小写不敏感
    assert.equal(cookieToken({ cookie: `x=1; ts_session=${token}; y=2` }), token);
    assert.equal(cookieToken({ cookie: 'TS_SESSION=x' }), null, 'cookie 名精确比较');
    assert.equal(cookieToken({ cookie: 'ts_session=' }), '', '命中但空值 ⇒ 空串（falsy）');
    assert.equal(cookieToken({}), null);
    assert.equal(cookieToken(undefined), null);

    // ② 三步组合（= server.js 的 currentUser cookie 分支；空串与 null 同处理）
    const resolve = (headers) => {
      const found = cookieToken(headers);
      if (!found) return null;                       // Python `if not token: return None`
      const row = dbmod.getSession(fx.db, found);
      if (!row) return null;
      return dbmod.getUserById(fx.db, row.user_id);
    };
    assert.equal(resolve({ cookie: `ts_session=${token}` }).id, alice.id);
    assert.equal(resolve({ cookie: 'ts_session=' }), null, '空 token ⇒ null');
    assert.equal(resolve({}), null, '无 cookie ⇒ null');
    assert.equal(resolve({ cookie: 'ts_session=nope' }), null, '不存在的 token ⇒ null');

    // ③ 过期会话 ⇒ null（判据在 db 层：expires_at < 本地 now 的字符串比较）
    const expired = 'e'.repeat(64);
    dbmod.createSession(fx.db, alice.id, expired, '2000-01-01 00:00:00');
    assert.equal(dbmod.getSession(fx.db, expired), null);
    assert.equal(resolve({ cookie: `ts_session=${expired}` }), null);

    // ④ 会话在、用户行被删 ⇒ null（Python `db.get_user_by_id` 回 None）
    const orphan = 'f'.repeat(64);
    const carol = addUser(fx, 'carol', 'pw123456');
    dbmod.createSession(fx.db, carol.id, orphan, localStamp(Date.now() + 3600_000));
    dbmod.deleteUser(carol.id, { db: fx.db });
    assert.equal(resolve({ cookie: `ts_session=${orphan}` }), null);
  });
});
