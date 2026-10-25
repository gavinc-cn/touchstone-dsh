/**
 * 路由族：鉴权与管理（M3 读路径 + M6-6 RAG 配置三条 + M6.9 账号/管理写八条）
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头；行号是 `server.py` 的）：
 *   - `POST   /api/auth/login`           → `_api_login`(1490)          **public**
 *   - `POST   /api/auth/register`        → `_api_register`(1541)       **public**
 *   - `POST   /api/auth/logout`          → `_api_logout`(1520)         （**不读体**）
 *   - `POST   /api/auth/change_password` → `_api_change_password`(1576)（handler 内**自己读体**）
 *   - `GET    /api/auth/me`              → `_api_me`（M1 在 server.js 里实现，M3 迁入本表）
 *   - `GET    /api/admin/users`          → `_api_admin_list_users`（仅 admin）
 *   - `POST   /api/admin/users`          → `_api_admin_create_user`(1627)
 *   - `POST   /api/admin/users/<n>`      → `_api_admin_update_user`(1650) ┐ 同一 handler：
 *   - `PATCH  /api/admin/users/<n>`      → 同上（`do_PATCH`:1252）        ┘ POST/PATCH 两条分派点
 *   - `DELETE /api/admin/users/<n>`      → `_api_admin_delete_user`(1685)
 *   - `POST   /api/admin/rag/test`       → `_api_admin_rag_test`(1079 分派 → 1896)
 *   - `GET    /api/admin/rag`            → `_api_admin_rag_get`(1324 分派 → 1855)
 *   - `PATCH  /api/admin/rag`            → `_api_admin_rag_set`(1256 分派 → 1874)
 *
 * **`public: true` 的含义**（只标 login/register）：Python `do_POST`(1027) 头两行就在
 * `if path.startswith("/api/"): user = self._current_user()` **之前**分派它们——未登录也必须
 * 能打（这正是「登录」的前提），且**不过强制改密闸**（闸在鉴权之后才调）。`server.js` 的公开
 * 端点分支按本标记现算名单（单一真相源），见 `./index.js:isPublicRoute`。
 *
 * **没有** `/api/rag*` 顶层族（2026-10-13 侦察实测）：RAG 只有这三条 admin 前缀端点；
 * `rag.py` 的 rebuild/search 是 CLI 子命令，不对应任何 HTTP。
 *
 * 注意 `_api_me` 不吃 `_require_admin`：任何已登录用户都能读自己的三字段。
 *
 * 字节形态（照 oracle，**逐处对照、不许统一**）：
 *   - 硬编码紧凑字节串 `b'{"error":...}'` ⇒ `ctx.error`（login/register/change_password/
 *     admin CRUD 的全部错误体、`user not found` 的 404）；成功体 `b'{"ok":true}'` ⇒ `ctx.text`；
 *   - `json.dumps(...)` 带空格 ⇒ `ctx.errorSpaced`（仅 RAG 三条的既有形态）或 `ctx.json`
 *     （login/register 的正文、`{"id": user_id}`）。
 */
import {
  LoginLimiter, md5Password, newToken, sessionExpiry, verifyPassword,
} from '../lib/auth.js';
import { clearSessionCookie, cookieToken, sessionCookie } from '../lib/cookie.js';
import * as dbmod from '../lib/db.js';
import { jsonBody } from '../lib/http.js';
import { pyStrip } from '../lib/lib.js';
import * as rag from '../lib/rag.js';

/** `_is_admin`：管理员判据**只有**用户名等于 `admin`（需求约定，勿改） */
function isAdmin(user) {
  return Boolean(user) && user.username === 'admin';
}

/** `_require_admin`：非管理员统一 403 `{"error":"仅管理员可操作"}` */
function requireAdmin(ctx) {
  if (isAdmin(ctx.user)) return true;
  ctx.error(403, '仅管理员可操作');
  return false;
}

/** `_user_admin_json`：管理页用户行（派生 `is_admin`，口令相关字段一律不下发） */
function userAdminJson(row) {
  return {
    id: row.id,
    username: row.username,
    created_at: row.created_at,
    is_admin: row.username === 'admin',
  };
}

/** Python `str(x or "")`（标量面；api_base/model 这类表单字段都是字符串） */
function pyStrOrEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : '';
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : '';
  return String(value);
}

/** 真值判定（`body.get(x)` 直接进 Python `if`；`{}`/`[]` 为假） */
function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return Object.keys(value).length > 0;
}

// --------------------------------------------------------------------------
// 账号族写端点（M6.9）的入参规范化与共用件
// --------------------------------------------------------------------------

/**
 * `server.py:_pw_str`(568)：密码入参规范化——**只有字符串照收**，其余（JSON null、数字、
 * 数组、对象）一律当空串。oracle 的理由：`data.get("password")` 显式传 null 时默认值不生效，
 * None 会一路传进 `.encode/.len` 崩掉（无响应断连），故统一收口。
 *
 * 导出仅供单测钉住口径（`tools/parity/endpoints.mjs` 只按 `method`/`path`/`re`/`handler`
 * 解析本文件，多一个导出不影响端点差集）。
 * @param {unknown} value
 * @returns {string}
 */
export function pwStr(value) { return typeof value === 'string' ? value : ''; }

/** `server.py:_req_str`(577)：请求字段字符串规范化，口径与 `pwStr` **逐字相同**（同一个洞） */
export function reqStr(value) { return typeof value === 'string' ? value : ''; }

/** `server.py:USERNAME_RE`(567)：2-32 位字母/数字/下划线/点/横杠 */
const USERNAME_RE = /^[A-Za-z0-9_.\-]{2,32}$/;

/**
 * Python `len(str)`：按**码点**计数。
 * 为什么不能写 `text.length`：JS 的 `.length` 数 UTF-16 码元，代理对（emoji 等）算 2，
 * 而 Python 的 emoji 算 1 ⇒ 4 个 emoji 的口令在 Python 是 4 位（不足 6 ⇒ 400），
 * 用 `.length` 会算成 8 位而放行。中文 BMP 字符两边一致，但口径按码点才是逐字对齐。
 */
function pyLen(text) { return [...text].length; }

/**
 * `sqlite3.IntegrityError` 判据 —— 与 `lib/waitq.js:214` 那个**未导出**的 `isIntegrityError`
 * 同口径（该函数没导出、且本批不许改 waitq.js，故在此重写一份；口径若漂移以 waitq.js 为准）。
 *
 * Python `except sqlite3.IntegrityError` 吃的是**整个约束族**（UNIQUE / NOT NULL …），
 * 不只是唯一索引；node:sqlite 对应 `SQLITE_CONSTRAINT`（主码 19）⇒ `errcode & 0xff === 19`。
 * @param {unknown} error
 * @returns {boolean}
 */
function isIntegrityError(error) {
  return Boolean(error) && error.code === 'ERR_SQLITE_ERROR'
    && (Number(error.errcode) & 0xff) === 19;
}

/**
 * 登录限流器 —— **进程级单例**，= `server.py:Handler.limiter = auth.LoginLimiter()`（类属性）。
 *
 * 为什么必须模块级：Python 把 limiter 挂在 Handler **类**上 ⇒ 同一进程的所有请求共享同一份
 * 「ip → 尝试时间戳」计数。若挂在 ctx 上或每次 new，判据就从「每 IP 每分钟 10 次」变成
 * 「每请求 10 次」——限流形同不存在，而这是暴力破解的唯一防线。
 *
 * 不放 server.js 的理由：门禁状态归路由族自己持有（server.js 只管时序）；单测要独立窗口时
 * 用 `makeLoginHandler({ limiter })` 注入，绝不改这个单例。
 */
const LOGIN_LIMITER = new LoginLimiter();

/**
 * 登录 handler 的可注入构造（单测用独立窗口/独立 ip）。
 * 生产路由走缺省（模块级单例），见 `LOGIN_LIMITER`。
 * @param {{limiter?: object}} [options]
 * @returns {(ctx: object) => Promise<void>}
 */
export function makeLoginHandler({ limiter = LOGIN_LIMITER } = {}) {
  return (ctx) => loginHandler(ctx, limiter);
}

/**
 * 登录/注册/登出的成功响应（**手工发**，不是 `ctx.json`）。
 *
 * 为什么：Python 这三处也没走 `_respond`（`_api_login`1552-1560、`_api_register`1562-1570、
 * `_api_logout`1522-1530），而是手工 `send_header`——为的是把 Set-Cookie 发在正文之前。
 * 这里四件头与**顺序**逐字照抄：Set-Cookie → Content-Type → Content-Length →
 * Cache-Control: no-store（`respond()` 会把 extraHeaders 排在最后：语义等价、原始字节序不同；
 * 判据是逐字节等价，故不借道它）。
 * @param {object} res node:http ServerResponse（或同形状桩）
 * @param {Buffer|string} body 正文（调用方按 Python 口径序列化好）
 * @param {string} cookie Set-Cookie 整串
 */
function respondSessionJson(res, body, cookie) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(200, {
    'Set-Cookie': cookie,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  });
  try {
    res.end(buf);
  } catch {
    // 客户端提前断开：与 `lib/http.js:respond` 同口径吞掉（Python 吞 BrokenPipe）
  }
}

// --------------------------------------------------------------------------
// 账号族写端点（M6.9）：login / register / logout / change_password
// --------------------------------------------------------------------------

/**
 * `_api_login`(1490)：公开端点（鉴权之前分派）。顺序**逐条**照 oracle：
 *   `limiter.allow(ip)`（在读体**之前**，被拦就直接 429、连体都不读）→ 读体 → 查库 →
 *   `limiter.record(ip)`（**无论成败都记**，失败尝试同样计数）→ 校验口令 → 建会话 → 手工发响应。
 */
async function loginHandler(ctx, limiter) {
  // Python `self.client_address[0]` 恒有值；Node 的 socket 在测试桩里可能缺席 ⇒ 回落空串
  const ip = ctx.req?.socket?.remoteAddress ?? '';
  if (!limiter.allow(ip)) {
    // 紧凑体（Python 硬编码字节串 `{"error":"尝试过于频繁，请稍后再试"}`）
    ctx.error(429, '尝试过于频繁，请稍后再试');
    return;
  }
  const body = await ctx.readBody();
  // Python `data.get("username", "")`：缺键/显式 null/非字符串都经 `_req_str` 折成空串
  const username = reqStr(body.username);
  const password = pwStr(body.password);
  const row = dbmod.getUserByName(ctx.db, username);
  limiter.record(ip);                       // ★ 在查库之后、判口令之前（照 oracle 行序）
  if (row === null || !verifyPassword(password, row.pass_hash, row.salt)) {
    // 用户不存在与口令错误**同一状态码同一文案**（不泄露用户是否存在）
    ctx.error(401, '用户名或密码错误');
    return;
  }
  const token = newToken();
  dbmod.createSession(ctx.db, row.id, token, sessionExpiry());
  respondSessionJson(ctx.res, jsonBody({
    token,
    username: row.username,
    must_change_password: Boolean(row.must_change_pw),
  }), sessionCookie(token));
}

/**
 * `_api_register`(1541)：公开端点。三道 400（用户名格式 / 口令长度 / 重名）顺序照 oracle；
 * 成功即自动登录（建会话 + 下发同一个 cookie），正文**只有** `token`/`username` 两个键。
 */
async function registerHandler(ctx) {
  const body = await ctx.readBody();
  const username = pyStrip(reqStr(body.username));    // `_req_str(...).strip()`
  const password = pwStr(body.password);
  if (!USERNAME_RE.test(username)) {
    ctx.error(400, '用户名须为 2-32 位字母数字或 _ . -');
    return;
  }
  if (pyLen(password) < 6) {
    ctx.error(400, '密码至少 6 位');
    return;
  }
  // `auth.md5_password` 的盐**恒为空串**（PBKDF2 那条路只在种子 admin 上用）
  let userId;
  try {
    userId = dbmod.insertUser(username, md5Password(password), '', { db: ctx.db });
  } catch (error) {
    if (isIntegrityError(error)) {
      ctx.error(400, '用户名已存在');
      return;
    }
    throw error;
  }
  const token = newToken();
  dbmod.createSession(ctx.db, userId, token, sessionExpiry());
  respondSessionJson(ctx.res, jsonBody({ token, username }), sessionCookie(token));
}

/**
 * `_api_logout`(1520)：**不读请求体**（oracle 该 handler 全文没有 `_read_json`，
 * 且它在 do_POST 的读体那行**之前**分派）。token 可能为 `null`/空串 ⇒ `deleteSession`
 * 删 0 行（Python `db.delete_session(None)` 同）。
 */
function logoutHandler(ctx) {
  const token = cookieToken(ctx.req?.headers);
  dbmod.deleteSession(ctx.db, token);
  respondSessionJson(ctx.res, '{"ok":true}', clearSessionCookie());
}

/**
 * `_api_change_password`(1576)：已登录即可，**不要求 admin**。
 *
 * 两处必须照抄的细节：
 *   1. **handler 自己读体**（`data = self._read_json() or {}`，server.py:1578）——它在
 *      do_POST 里虽排在读体行之前分派，但体内自己读（与 logout 不同，见 `./index.js` 的
 *      `readBody` 注释）；不读 ⇒ 新口令恒空 ⇒ 一律 400「新密码至少 6 位」；
 *   2. **信任头（薄壳免登）下不校验原口令**：插件形态首装的随机一次性口令只印在启动横幅里，
 *      要求原口令等于把面板锁死；该头本就等价 admin 全权（`_current_user`），放行不新增权限面。
 */
async function changePasswordHandler(ctx) {
  const user = ctx.user;
  const body = await ctx.readBody();
  const oldPw = pwStr(body.old_password);
  const newPw = pwStr(body.new_password);
  if (!ctx.trusted && !verifyPassword(oldPw, user.pass_hash, user.salt)) {
    ctx.error(400, '原密码错误');
    return;
  }
  if (pyLen(newPw) < 6) {
    ctx.error(400, '新密码至少 6 位');
    return;
  }
  // `db.change_password` 顺带把 must_change_pw 清 0（改密后强制改密闸自然放行）
  dbmod.changePassword(user.id, md5Password(newPw), '', { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

// --------------------------------------------------------------------------
// 管理端用户 CRUD（M6.9）：POST /api/admin/users + POST/PATCH/DELETE /api/admin/users/<n>
// --------------------------------------------------------------------------

/**
 * `_api_admin_create_user`(1627)：与注册同一三道 400（用户名/口令长度/重名）。
 * 读体在门禁**之前**（Python 是 do_POST:1048 先读体、再分派进本 handler）——
 * 顺序影响「非数字 Content-Length」这类请求：Python 在读体处就断连，不会走到 403。
 */
async function adminCreateUser(ctx) {
  const body = await ctx.readBody();
  if (!requireAdmin(ctx)) return;
  const username = pyStrip(reqStr(body.username));
  const password = pwStr(body.password);
  if (!USERNAME_RE.test(username)) {
    ctx.error(400, '用户名须为 2-32 位字母数字或 _ . -');
    return;
  }
  if (pyLen(password) < 6) {
    ctx.error(400, '密码至少 6 位');
    return;
  }
  let userId;
  try {
    userId = dbmod.insertUser(username, md5Password(password), '', { db: ctx.db });
  } catch (error) {
    if (isIntegrityError(error)) {
      ctx.error(400, '用户名已存在');
      return;
    }
    throw error;
  }
  ctx.json(200, { id: userId });     // `json.dumps({"id": user_id})` ⇒ **带空格**
}

/**
 * `_api_admin_update_user`(1650)：POST 与 PATCH **共用**（oracle 两个分派点都指向它）。
 * admin 账号禁止改名（防止后台管理入口丢失）；`password` 缺省/空串 ⇒ 保留存量 hash/salt。
 */
async function adminUpdateUser(ctx, userId) {
  const body = await ctx.readBody();
  if (!requireAdmin(ctx)) return;
  const row = dbmod.getUserById(ctx.db, userId);
  if (row === null) {
    ctx.error(404, 'user not found');            // 紧凑体（Python 硬编码字节串）
    return;
  }
  // Python `_req_str(body.get("username") or row["username"])`：`or` 是 **Python 真值**判定
  // （None/""/0/[]/{} 都取存量）。JS 的 `||` 会把 `[]`/`{}` 当 truthy ⇒ 必须走 pyTruthy，
  // 否则 `{"username": []}` 会变成空串 ⇒ 误回 400（Python 是取存量 ⇒ 200）。
  const username = pyStrip(reqStr(pyTruthy(body.username) ? body.username : row.username));
  if (row.username === 'admin' && username !== 'admin') {
    ctx.error(400, '管理员账号不允许改名');
    return;
  }
  if (!USERNAME_RE.test(username)) {
    ctx.error(400, '用户名须为 2-32 位字母数字或 _ . -');
    return;
  }
  const newPw = pwStr(body.password);
  let passHash = row.pass_hash;
  let salt = row.salt;
  if (newPw !== '') {
    if (pyLen(newPw) < 6) {
      ctx.error(400, '密码至少 6 位');            // 带了口令但太短 ⇒ 不静默忽略
      return;
    }
    passHash = md5Password(newPw);
    salt = '';
  }
  try {
    dbmod.updateUser(userId, username, passHash, salt, { db: ctx.db });
  } catch (error) {
    if (isIntegrityError(error)) {
      ctx.error(400, '用户名已存在');
      return;
    }
    throw error;
  }
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_admin_delete_user`(1685)：admin 账号与当前登录用户不可删除；成功连带删其会话行。
 * **不读体**（照 `do_DELETE`:1266——Python 整条 DELETE 链没有 `_read_json`）。
 */
function adminDeleteUser(ctx, userId) {
  if (!requireAdmin(ctx)) return;
  const row = dbmod.getUserById(ctx.db, userId);
  if (row === null) {
    ctx.error(404, 'user not found');
    return;
  }
  if (row.username === 'admin') {
    ctx.error(400, '管理员账号不允许删除');
    return;
  }
  // Python 这里重取 `self._current_user()`；Node 的 ctx.user 就是鉴权段取好的同一行
  if (ctx.user.id === userId) {
    ctx.error(400, '不能删除当前登录用户');
    return;
  }
  dbmod.deleteUser(userId, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_admin_rag_get`(1855)：RAG 检索配置读取（仅管理员）。
 * api_key **打码回显**（永不回明文）；`configured` = 三关键字段齐备（当前是否已生效）。
 */
function adminRagGet(ctx) {
  if (!requireAdmin(ctx)) return;
  const raw = rag.raw_config() || {};
  const key = pyStrOrEmpty(raw.api_key);
  const masked = key.length >= 8 ? `****${key.slice(-4)}` : (key ? '****' : '');
  ctx.json(200, {
    configured: rag.load_config() !== null,
    config_path: rag.config_path(),
    api_base: pyStrOrEmpty(raw.api_base),
    model: pyStrOrEmpty(raw.model),
    has_api_key: Boolean(key),
    api_key_masked: masked,
    // Python `raw.get("timeout_s") or rag.DEF_TIMEOUT_S`（0/None 都回落缺省）
    timeout_s: pyTruthy(raw.timeout_s) ? raw.timeout_s : rag.DEF_TIMEOUT_S,
    batch_size: pyTruthy(raw.batch_size) ? raw.batch_size : rag.DEF_BATCH_SIZE,
  });
}

/**
 * `_api_admin_rag_set`(1874)：RAG 配置保存（仅管理员）。
 * api_key 留空 = 保持现有值；`clear=true` 停用（删配置）；校验失败 400 带原因；成功紧凑 `{"ok":true}`。
 */
async function adminRagSet(ctx) {
  const body = await ctx.readBody();
  if (!requireAdmin(ctx)) return;
  try {
    if (pyTruthy(body.clear)) {
      rag.disable();
    } else {
      let apiKey = pyStrOrEmpty(body.api_key).trim();
      if (!apiKey) apiKey = pyStrOrEmpty((rag.raw_config() || {}).api_key);   // 留空 = 沿用已存 key
      rag.save_config({
        api_base: body.api_base,
        model: body.model,
        api_key: apiKey,
        timeout_s: body.timeout_s,
        batch_size: body.batch_size,
      });
    }
  } catch (e) {
    if (e instanceof rag.ValueError) {
      ctx.errorSpaced(400, e);                  // Python `str(exc)`；key+vars 走 i18nKey
      return;
    }
    throw e;
  }
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_admin_rag_test`(1896)：按表单当前值发一次单文本嵌入探测，**不落盘**；
 * 结果恒 200（`ok=false` 时 error 供前端直接展示）。
 */
async function adminRagTest(ctx) {
  const body = await ctx.readBody();
  if (!requireAdmin(ctx)) return;
  let apiKey = pyStrOrEmpty(body.api_key).trim();
  if (!apiKey) apiKey = pyStrOrEmpty((rag.raw_config() || {}).api_key);
  const result = await rag.test_connection({
    api_base: body.api_base,
    model: body.model,
    api_key: apiKey,
    timeout_s: body.timeout_s,
    batch_size: body.batch_size,
  }, ctx.lang);
  ctx.json(200, result);
}

export const routes = [
  // ---------- 账号族写四条（M6.9）：顺序照 `server.py:do_POST` 的分派先后 ----------
  {
    method: 'POST',
    path: '/api/auth/login',
    /**
     * 公开：`do_POST`(1027) 在 `_current_user()` **之前**分派它——未登录也必须能登录。
     * 名单由 `./index.js:isPublicRoute` 从本标记现算（server.js 不写死字符串）。
     */
    public: true,
    handler: makeLoginHandler(),
  },
  {
    method: 'POST',
    path: '/api/auth/register',
    public: true,                                // 同上：注册也必须在鉴权之前（注册完即登录）
    handler: (ctx) => registerHandler(ctx),
  },
  {
    method: 'POST',
    path: '/api/auth/logout',                    // do_POST:1044（已登录；**不读体**）
    handler: (ctx) => logoutHandler(ctx),
  },
  {
    method: 'POST',
    path: '/api/auth/change_password',           // do_POST:1047（已登录；handler 内自己读体）
    handler: (ctx) => changePasswordHandler(ctx),
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    /**
     * 形状逐字对齐 `server.py:_api_me`：`{username, is_admin, must_change_password}`；
     * `must_change_password` 取该行的 `must_change_pw`（Python `bool(user["must_change_pw"])`）。
     */
    handler: (ctx) => {
      ctx.json(200, {
        username: ctx.user.username,
        is_admin: isAdmin(ctx.user),
        must_change_password: Boolean(ctx.user.must_change_pw),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/admin/users',
    /** 用户列表（仅管理员）。**不下发** pass_hash/salt 等字段（照抄 Python 的三字段 + is_admin）。 */
    handler: (ctx) => {
      if (!requireAdmin(ctx)) return;
      ctx.json(200, dbmod.listUsers({ db: ctx.db }).map(userAdminJson));
    },
  },
  // ---------- 管理端用户 CRUD 三条分派点（M6.9）：字面路径在正则链之前 ----------
  {
    method: 'POST',
    path: '/api/admin/users',                    // do_POST:1054
    handler: (ctx) => adminCreateUser(ctx),
  },
  {
    method: 'POST',
    re: /^\/api\/admin\/users\/(\d+)$/,          // do_POST:1075（**POST 也走改号**）
    handler: (ctx, m) => adminUpdateUser(ctx, Number(m[1])),
  },
  {
    method: 'PATCH',
    re: /^\/api\/admin\/users\/(\d+)$/,          // do_PATCH:1252（与 POST 同一 handler）
    handler: (ctx, m) => adminUpdateUser(ctx, Number(m[1])),
  },
  {
    method: 'DELETE',
    re: /^\/api\/admin\/users\/(\d+)$/,          // do_DELETE:1287（**不读体**）
    handler: (ctx, m) => adminDeleteUser(ctx, Number(m[1])),
  },
  // ---------- RAG 配置三条（M6-6）：顺序照 Python do_* 链里的先后 ----------
  {
    method: 'POST',
    path: '/api/admin/rag/test',                 // do_POST:1079
    handler: (ctx) => adminRagTest(ctx),
  },
  {
    method: 'GET',
    path: '/api/admin/rag',                      // _route_get:1324
    handler: (ctx) => adminRagGet(ctx),
  },
  {
    method: 'PATCH',
    path: '/api/admin/rag',                      // do_PATCH:1256
    handler: (ctx) => adminRagSet(ctx),
  },
];
