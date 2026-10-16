/**
 * Node 后端认证基元（`auth.py` 的对应物，M1 地基）。
 *
 * 口径是**需求约定，不得自创**（与 auth.py 逐字对齐）：
 *   - 新写入的密码：无盐 MD5（32 位小写 hex）——注册/后台重置/改密都走它；
 *   - 存量/种子账号：PBKDF2-HMAC-SHA256，10 万轮、16 字节随机盐（盐以 **hex 字符串**存库，
 *     哈希为 32 字节 → 64 位 hex）；
 *   - `verifyPassword` 按**哈希长度**双格式兼容（32 位 = MD5，否则 PBKDF2），并做常量时间比对。
 *
 * 为什么返回形态与 Python 的元组不同：JS 没有元组，`hashPassword` 返回 `{ hash, salt }`
 * 对象（Python 是 `(hash, salt)` 二元组）；`md5Password` 只返回哈希串（Python 的
 * `md5_password` 返回 `(hash, "")`，空盐是常量，单独返回没有信息量）。
 *
 * M6.9 追加会话面四件：`SESSION_TTL` / `COOKIE_NAME` / `sessionExpiry` / `LoginLimiter`
 * （见文件末尾；cookie 头的解析与 Set-Cookie 生成在 `cookie.js`）。
 *
 * 零 npm 依赖：只用 node:crypto。本模块不依赖 db.js（模块图与 Python 侧一致：
 * db.py 单向 import auth）。
 */
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** PBKDF2 轮数（对齐 auth.py:PBKDF2_ITER） */
export const PBKDF2_ITER = 100000;
/** 随机盐字节数（对齐 auth.py：os.urandom(16) → 库里存 32 位 hex） */
export const SALT_BYTES = 16;
/** PBKDF2 派生结果字节数（sha256 摘要长度；hex 后 64 位，即「非 MD5 格式」的判据） */
export const PBKDF2_KEYLEN = 32;
/** 会话 token 字节数（对齐 auth.py:new_token 的 secrets.token_hex(32) → 64 位 hex） */
export const TOKEN_BYTES = 32;
/** 会话有效期（秒）：7 天。对齐 auth.py:SESSION_TTL —— 也是 Set-Cookie 的 Max-Age */
export const SESSION_TTL = 7 * 24 * 3600;
/** 会话 cookie 名。对齐 auth.py:COOKIE_NAME（cookie **名**比较是精确的，见 cookie.js） */
export const COOKIE_NAME = 'ts_session';

/**
 * 无盐 MD5 密码哈希（32 位小写 hex）。
 * 对齐 `auth.md5_password(password)[0]`：`hashlib.md5(password.encode("utf-8")).hexdigest()`。
 * @param {string} password 明文口令（UTF-8）
 * @returns {string} 32 位小写 hex
 */
export function md5Password(password) {
  if (typeof password !== 'string') {
    // Python 侧对非 str 会 AttributeError；这里显式抛错，绝不把 null 静默哈希成 "null"
    throw new TypeError('md5Password: password 必须是字符串');
  }
  return createHash('md5').update(password, 'utf8').digest('hex');
}

/**
 * PBKDF2-HMAC-SHA256 派生（HMAC 口令 + 盐 → hex）。私有：只经 hashPassword/verifyPassword 使用。
 * @param {string} password 明文口令（UTF-8）
 * @param {Buffer} salt 盐字节
 * @returns {string} 64 位小写 hex
 */
function pbkdf2Hex(password, salt) {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, PBKDF2_ITER, PBKDF2_KEYLEN, 'sha256')
    .toString('hex');
}

/**
 * 常量时间比较两个 hex 字符串（长度不等直接 false，防 timingSafeEqual 抛错）。
 * 对齐 `hmac.compare_digest` 的语义（长度不同返回 False 而非异常）。
 * @param {string} aHex
 * @param {string} bHex
 * @returns {boolean}
 */
function constantTimeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 生成 PBKDF2 密码哈希 + 随机盐（仅用于种子 admin 等存量账号）。
 * 对齐 `auth.hash_password(password)`：`(digest.hex(), os.urandom(16).hex())`。
 * @param {string} password 明文口令（UTF-8）
 * @returns {{hash: string, salt: string}} hash=64 位 hex，salt=32 位 hex
 */
export function hashPassword(password) {
  if (typeof password !== 'string') {
    throw new TypeError('hashPassword: password 必须是字符串');
  }
  const salt = randomBytes(SALT_BYTES);
  return { hash: pbkdf2Hex(password, salt), salt: salt.toString('hex') };
}

/**
 * 校验口令（双格式兼容 + 常量时间比对）。对齐 `auth.verify_password`：
 *   - 口令非字符串（如 JSON null）→ false，不抛异常；
 *   - 哈希长度 32 → 按 MD5 验证；否则按 PBKDF2（盐 hex 解码失败/缺盐 → false）。
 * 盐必须是字符串：Python 侧 `bytes.fromhex(None)` 抛 TypeError 被吞掉判 False，这里同判据。
 * @param {string} password 明文口令
 * @param {string} passHash 库里的哈希（32 位 hex = MD5，64 位 hex = PBKDF2）
 * @param {string} saltHex 库里的盐（hex；MD5 格式为空串）
 * @returns {boolean}
 */
export function verifyPassword(password, passHash, saltHex) {
  if (typeof password !== 'string') return false;
  if (typeof passHash !== 'string') return false;
  if (passHash.length === 32) {
    return constantTimeEqualHex(md5Password(password), passHash);
  }
  if (typeof saltHex !== 'string') return false;
  let digestHex;
  try {
    digestHex = pbkdf2Hex(password, Buffer.from(saltHex, 'hex'));
  } catch {
    // 盐不可解码等异常一律判不匹配（对齐 Python 的 ValueError/TypeError 分支）
    return false;
  }
  return constantTimeEqualHex(digestHex, passHash);
}

/**
 * 新会话 token（64 位小写 hex）。对齐 `auth.new_token`：`secrets.token_hex(32)`。
 * @returns {string}
 */
export function newToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * 会话过期时间字符串（now + SESSION_TTL）。对齐 `auth.session_expiry`：
 * `time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + SESSION_TTL))`。
 *
 * 口径要点：
 *   - **本地时区**（`time.localtime`），不是 UTC、不是 ISO —— `toISOString()` 在这里是错的；
 *   - 定长 `YYYY-MM-DD HH:MM:SS`，词法序即时间序（db 层 `expires_at < now_str()` 直接按
 *     字符串比大小，见 db.getSession）；
 *   - 与 `db.nowStr()` **同口径**（同样的本地字段手拼）。为什么不直接 `import { nowStr }`：
 *     `db.js` 单向 `import` 本模块（seedAdmin 用 hashPassword），反向 import 会成环 ——
 *     模块图与 Python 侧一致（db.py → auth.py 单向）。
 * @returns {string}
 */
export function sessionExpiry() {
  const d = new Date(Date.now() + SESSION_TTL * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 每 IP 每分钟最多 10 次登录尝试的滑动窗口限流（内存态）。对齐 `auth.LoginLimiter`。
 *
 * 调用协议是**两步**，顺序不能动（`server.py:_api_login`）：
 *   `allow(ip)` → 查库/校验口令 → `record(ip)`
 * 且**无论成败都 record** ⇒ 失败尝试同样计数（这正是限流的意义）。
 *
 * 三个易错语义（照抄 Python，别"改进"）：
 *   1. `allow` **不写计数**，只「剪掉窗口外的旧时间戳 + 判数」；只调 `allow` 不调 `record`
 *      时永远放行。计数只在 `record` 里追加（追加的是 `record` 当下的时刻，不是 `allow`
 *      时捕获的 now）；
 *   2. `allow` **有副作用**：剪枝结果会写回该 ip 的记录（内存不涨、过期即归零）；
 *   3. 判据是**严格小于**：`now - t < window`，恰好等于窗口宽度的记录算过期。
 *
 * 与 Python 的差异（有意）：Python 用 `threading.Lock` 保护 `_records`，Node 单线程事件循环
 * 内同步执行、无并发交错 ⇒ 不加锁，语义等价。Python 是**进程级单例**
 * （`server.Handler.limiter = auth.LoginLimiter()`）；Node 侧本类只导出，单例由 server.js 持有
 * —— 本模块不建单例，避免单测与真实服务器共享状态。
 */
export class LoginLimiter {
  /**
   * @param {number} [maxAttempts=10] 窗口内允许的尝试次数（对齐 Python 缺省 10）
   * @param {number} [window=60] 滑动窗口宽度（秒；对齐 Python 缺省 60）
   */
  constructor(maxAttempts = 10, window = 60) {
    this.maxAttempts = maxAttempts;
    this.window = window;
    /** ip → 尝试时间戳（浮点秒）；对齐 Python `self._records` */
    this._records = new Map();
  }

  /**
   * 本次尝试是否放行（**会剪枝并写回**，不计数）。
   * @param {string} ip
   * @returns {boolean}
   */
  allow(ip) {
    const now = Date.now() / 1000;
    const records = (this._records.get(ip) || []).filter((t) => now - t < this.window);
    this._records.set(ip, records);
    return records.length < this.maxAttempts;
  }

  /**
   * 记一次尝试（追加当前时刻）。对齐 Python：`setdefault(ip, []).append(time.time())`。
   * @param {string} ip
   */
  record(ip) {
    const records = this._records.get(ip);
    if (records) records.push(Date.now() / 1000);
    else this._records.set(ip, [Date.now() / 1000]);
  }
}
