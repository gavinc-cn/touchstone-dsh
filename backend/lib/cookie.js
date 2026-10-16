/**
 * Cookie 头解析与 Set-Cookie 生成（`server.py` 会话面两处语义的对应物，M6.9 · R2）。
 *
 * ── 对应关系（逐行对照） ────────────────────────────────────────────────────────
 *   - `cookieToken(headers)`  ← `server.py:5249-5254` `_cookie_token`
 *       for part in self.headers.get("Cookie", "").split(";"):
 *           name, _, value = part.strip().partition("=")
 *           if name == auth.COOKIE_NAME: return value
 *   - `sessionCookie(token)`  ← `server.py:1511-1513`（登录）与 `server.py:1568-1570`（注册），
 *       两处写的是同一串：`ts_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
 *   - `clearSessionCookie()`  ← `server.py:1525-1526`（登出）：
 *       `ts_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
 *
 * ── 三个易错点（照抄 Python，别想当然） ──────────────────────────────────────────
 * 1. **`partition("=")` 按第一个 `=` 切**：`ts_session=a=b` 的值是 `a=b`；没有 `=` 时
 *    Python 的 partition 返回 `("ts_session", "", "")` ⇒ 值空串。
 * 2. **返回值可能是空串**：`ts_session=` 命中了但值是 `""`。Python 的 `_cookie_token` 返回
 *    `""`（不是 None），调用方 `_current_user` 里 `if not token: return None` 把空串按 falsy
 *    与「无 cookie」同路处理。本函数照抄这个形态：**命中返回字符串（可能是 `""`），
 *    未命中返回 `null`**；空串与 null 的区别一律由调用方按 falsy 统一处理。
 * 3. **头名大小写不敏感、cookie 名精确**：`self.headers.get` 是 `email.message.Message.get`
 *    （头名大小写不敏感，Node 的 `req.headers` 键统一小写），但 cookie **名**比较是
 *    `name == auth.COOKIE_NAME` 的**精确**比较 ⇒ `TS_SESSION=x` 不算命中。
 *    另：`part.strip()` 剥的是整段（含名字两侧），故 ` ts_session = x ` 的 name 是
 *    `"ts_session "`，同样不命中。
 *
 * 零 npm 依赖：只用 node 内建（复用 lib.js 的 `pyStrip` 以取得 Python `str.strip()` 的
 * Unicode 空白口径）。
 */
import { COOKIE_NAME, SESSION_TTL } from './auth.js';
import { pyStrip } from './lib.js';

/**
 * 从请求头里取会话 token。对齐 `server.py:_cookie_token`：
 * 逐段 `strip` → 按第一个 `=` 切 → 名字精确等于 `ts_session` 就返回其值（首个命中者胜）。
 *
 * 入参就是 Node 的 `req.headers`（键小写 `cookie`），同时兜住 `Cookie`/`COOKIE` 等写法
 * （对齐 Python `self.headers.get` 的头名大小写不敏感）。
 * @param {object|null|undefined} headers 请求头对象（缺失即视为没有 Cookie 头）
 * @returns {string|null} 命中返回其值（**可能是空串**，falsy）；未命中返回 null
 */
export function cookieToken(headers) {
  if (!headers || typeof headers !== 'object') return null;
  let raw = null;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'cookie') { raw = headers[key]; break; }
  }
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const text = pyStrip(part);
    const eq = text.indexOf('=');
    const name = eq === -1 ? text : text.slice(0, eq);
    const value = eq === -1 ? '' : text.slice(eq + 1);
    if (name === COOKIE_NAME) return value;
  }
  return null;
}

/**
 * 登录/注册响应的 Set-Cookie 值。对齐 `server.py:1511-1513`（属性顺序、空格逐字节照抄）：
 * `ts_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
 * @param {string} token `auth.newToken()` 的产物
 * @returns {string}
 */
export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

/**
 * 登出响应的 Set-Cookie 值（清 cookie）。对齐 `server.py:1525-1526`：
 * `ts_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
 * @returns {string}
 */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
