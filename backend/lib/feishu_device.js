/**
 * 飞书「扫码一键建应用」的 Device Flow 客户端（RFC 8628 + 飞书变体）——零 npm 依赖。
 *
 * 对应 oracle：`lark_oapi/scene/registration/__init__.py`（lark-oapi 1.7.3）的
 * `_SyncFlow`，被 `feishu.py:2957 _register_app_impl` 调起、由 `:3045 _provision_worker`
 * 在后台线程里跑。oracle 的 `register_app` **不是 SDK 魔法**：3 个表单 POST + 一个轮询循环，
 * 无签名无加密（`addons` 只是 gzip + base64url）。所以这里能把整条协议逐行搬过来。
 *
 * ══ 逐点对齐（行号即 `scene/registration/__init__.py`）══════════════════════════════
 *   - `_ENDPOINT = "/oauth/v1/app/registration"`(:14)、`_SDK_NAME = "python-sdk"`(:15)；
 *   - `run`(:273-325)：init → 校验 `supported_auth_methods` 含 `client_secret` → begin
 *     → 拼确认链接(`_build_qr_url`:177-187) → 轮询直到 `deadline`；
 *   - 轮询判定顺序 `_handle_poll_response`(:197-232)：**先成功 → 再域切换 → 再错误码**。
 *     这个顺序是语义的一部分：一个同时带 `client_id` 和 `error` 的响应算**成功**；
 *     一个同时带 `tenant_brand: "lark"` 和 `error: "access_denied"` 的响应算**切域**。
 *   - `slow_down` ⇒ `interval += 5`(:318-320)，改的是**循环外的变量** ⇒ 对后续每轮持续生效；
 *   - `domain_switched` ⇒ `self._base_url = self._lark_url`(:211) 且只切一次（`domain_switched`
 *     标志在 `_SyncFlow.run` 的循环外，:302/314-316）；
 *   - 超时 ⇒ `AppExpiredError("expired_token", "polling timed out")`(:324)；
 *   - 取消 ⇒ `_check_cancelled`(:269-271) 抛 `RegisterAppError("abort", "cancelled by caller")`。
 *
 * ══ 与 oracle 的**登记差异**（都不是偷懒，是运行时不同，且都可观测）══════════════════
 *  ① **网络层**：oracle 用 `requests.post`（同步阻塞），这里用 `globalThis.fetch`（异步）。
 *     报文形态逐字节对齐：`urlencode(data)` 的表单体 + `application/x-www-form-urlencoded`。
 *     **不传 `signal`**：oracle 没有超时/中断机制（取消靠 `cancel_event` 在**轮次之间**生效），
 *     加 abort 会多出一个 oracle 没有的失败面。单个 POST 挂死两侧都挂死，语义一致。
 *  ② **DEFLATE 码流不可逐字节**：`addons` 的 gzip 载荷用的是**运行时自带的 zlib**。
 *     Node v24 内置的是打过补丁的 `1.3.2.1-motley`，CPython 用的是 `1.3.2` ——
 *     同一输入下 `deflate` 的 LZ77 解析不同 ⇒ 压缩字节不同（本机实测：305 字节明文，
 *     CPython 164B / Node 168B raw deflate）。能逐字节对齐的是**它外面和里面**：
 *     gzip 容器头（`1f8b08 00 00000000 02`，mtime=0 + XFL=2）、以及**解压后的明文**
 *     （与 oracle `_normalize_addons` + `json.dumps(ensure_ascii=False, separators=(",",":"))`
 *     全等）。服务端吃的是明文 ⇒ 语义等价；但**不宣称码流逐字节相同**（已登记未验）。
 *     若将来要求码流也逐字节，得自带一个 deflate 实现，不在本批范围。
 *  ③ `resp.json()` 的容错口径：oracle `requests.json()` 在**非 JSON 响应**上抛
 *     `json.JSONDecodeError`（不是 dict）⇒ 上层 `_provision_worker` 折成 `str(e)`；
 *     这里折成空对象 ⇒ 走判定链后抛我们自己的 `RegisterAppError`。两端都**不静默成功**，
 *     但异常类名不同（已登记；假上游路径不会走到）。
 */

import { gzipSync } from 'node:zlib';

/** Device Flow 端点（registration/__init__.py:14） */
export const DEVICE_ENDPOINT = '/oauth/v1/app/registration';
/** `source` 的 SDK 名（:15）；oracle 的 `_register_app_impl`(**不传** source) ⇒ 取裸 `"python-sdk"` */
export const SOURCE_SDK_NAME = 'python-sdk';
/** 飞书主域（`register_app(domain=...)` 缺省，:392） */
export const FEISHU_DOMAIN = 'https://accounts.feishu.cn';
/** Lark 主域（`register_app(lark_domain=...)` 缺省，:393）；`tenant_brand == "lark"` 时切过去 */
export const LARK_DOMAIN = 'https://accounts.larksuite.com';
/** `begin_res.get("interval", 5)`（:294） */
export const DEFAULT_INTERVAL_S = 5;
/** `begin_res.get("expires_in", 600)`（:295） */
export const DEFAULT_EXPIRES_IN_S = 600;
/** `slow_down` 的步进（`interval += 5`，:319；RFC 8628 §3.5 的 MUST） */
export const SLOW_DOWN_STEP_S = 5;
/** oracle 要求 lark-oapi ≥ 1.5.5（`feishu.py:2932 _REGISTER_MIN_VERSION`），仅作文案/溯源用 */
export const LARK_MIN_VERSION = '1.5.5';

/** 平台所需权限清单——**唯一真源**（与 `feishu.py:1263-1269` 逐字相同，含 token 类型） */
export const DEVICE_REQUIRED_SCOPES = Object.freeze([
  Object.freeze(['im:message.p2p_msg:readonly', 'tenant']),
  Object.freeze(['im:message.group_at_msg:readonly', 'tenant']),
  Object.freeze(['im:message:send_as_bot', 'tenant']),
  Object.freeze(['application:app_slash_command:read', 'tenant']),
  Object.freeze(['application:app_slash_command:write', 'tenant']),
]);
/** 事件清单（`feishu.py:1270`） */
export const DEVICE_REQUIRED_EVENTS = Object.freeze(['im.message.receive_v1']);
/** 回调清单（`feishu.py:1271`） */
export const DEVICE_REQUIRED_CALLBACKS = Object.freeze(['card.action.trigger']);

/**
 * `feishu._provision_addons()`(feishu.py:2972-2982)：**创建时**就把清单带上，
 * 绕开 `application:application:patch` 冷启动；`preset=False` = 不要官方智能体模板。
 * 返回的键序（preset/scopes/events/callbacks）即 JSON 里的键序，不许动。
 */
export function _provisionAddons() {
  return {
    preset: false,
    scopes: {
      tenant: DEVICE_REQUIRED_SCOPES.filter(([, t]) => t === 'tenant').map(([n]) => n),
    },
    events: { items: { tenant: [...DEVICE_REQUIRED_EVENTS] } },
    callbacks: { items: [...DEVICE_REQUIRED_CALLBACKS] },
  };
}

/**
 * `_normalize_addons`(:41-105) 的可用子集 + `json.dumps(..., ensure_ascii=False,
 * separators=(",", ":"))`(:109)。契约里的 addons 由本模块自己生成（结构固定），
 * 故这里只做**键序固定**的紧凑序列化，不重写整套校验（不合法结构由上游 `_provisionAddons` 保证）。
 * @param {object} [addons]
 * @returns {string} UTF-8 明文 JSON
 */
export function _addonsPayload(addons) {
  return JSON.stringify(addons === undefined ? _provisionAddons() : addons);
}

/**
 * `_encode_addons`(:108-112)：JSON → gzip(mtime=0) → urlsafe base64 → 去掉尾部 `=`。
 *
 * `level: 9` 是照抄 `gzip.compress` 的缺省 `compresslevel=9`（gzip.py）；`mtime: 0`
 * 照抄调用点显式传的 `mtime=0` ⇒ 同一输入两次编码**逐字节相同**（否则 gzip 头会写墙钟时间）。
 * 码流本身与 CPython 不同（见文件头②），但容器头与解压后明文可逐字节对拍。
 * @param {object} [addons]
 * @returns {string} base64url，无 `=` 补位
 */
export function _encodeAddons(addons) {
  const compressed = gzipSync(Buffer.from(_addonsPayload(addons), 'utf8'), { mtime: 0, level: 9 });
  return compressed.toString('base64url');
}

/**
 * Python `urllib.parse.quote_plus` 的**逐字节**等价物（`_build_qr_url` 里 `urlencode(params,
 * doseq=True)` 用的就是它）。三个必须显式处理的点：
 *   1. 安全集是 `ALWAYS_SAFE + " "`：`A-Za-z0-9_.-~` **和空格**；空格编成 `+`（不是 `%20`）；
 *   2. `encodeURIComponent` 的**不编码**集更大（多放行 `! ' ( ) *`）⇒ 必须补编；
 *   3. 十六进制**大写**。
 * @param {string} text
 * @returns {string}
 */
export function _quotePlus(text) {
  return encodeURIComponent(String(text))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** `_quotePlus` 的逆：`unquote_plus` 形态——先 `+` 还原空格再 percent-decode */
function unquotePlus(text) {
  const plus = String(text).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;   // 非法转义：Python 亦不抛（`unquote` 保留原样）
  }
}

/**
 * `urlparse` 的可用子集（RFC 3986 的 `scheme://netloc/path;params?query#fragment`）。
 * 只要求能**原样还原**本次要处理的 `verification_uri_complete`（HTTPS + query）。
 */
function splitUri(uri) {
  const text = String(uri);
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/
    .exec(text);
  if (m === null) return { prefix: '', query: '' };
  const scheme = m[1] === undefined ? '' : `${m[1]}:`;
  const netloc = m[2] === undefined ? '' : `//${m[2]}`;
  const path = m[3] || '';
  const query = m[4] === undefined ? '' : m[4];
  const fragment = m[5] === undefined ? '' : `#${m[5]}`;
  return { prefix: `${scheme}${netloc}${path}`, query, fragment };
}

/**
 * `parse_qs`(:179) 的可用子集。语义必须照抄的两点：
 *   1. **空值被丢弃**（`keep_blank_values=False` 是缺省）⇒ `a=` / 裸 `a` 整个键都不出现；
 *   2. 同名键按出现顺序聚成 list（`doseq=True` 再按序展开）⇒ 顺序**可还原**。
 * @returns {Map<string, string[]>}
 */
function parseQuery(query) {
  const out = new Map();
  if (!query) return out;
  for (const piece of String(query).split('&')) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    const rawKey = eq === -1 ? piece : piece.slice(0, eq);
    const rawVal = eq === -1 ? '' : piece.slice(eq + 1);
    if (rawVal === '') continue;                       // ① 丢空值
    const key = unquotePlus(rawKey);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(unquotePlus(rawVal));            // ② 同名聚 list
  }
  return out;
}

/**
 * `_build_qr_url`(177-187)：保留原 URI 的查询串，另加 `from=sdk` / `tp=sdk` /
 * `source=...` / `addons=<编码清单>`，再按 `urlencode(params, doseq=True)` 重编码。
 *
 * 键序 = `params` 的 dict 插入序：**原查询串的键在前**（`parse_qs` 建的），
 * 新键按 oracle 的赋值序追加（`from` → `tp` → `source` → `addons`；`app_preset` 未用）。
 * @param {string} uri `begin_res["verification_uri_complete"]`
 * @param {{addons?: object|null, source?: string|null}} [opts]
 *        `addons` 传 `null` ≡ oracle 的 `self._addons is None`（不带该键）；
 *        `source` 是**可覆盖入口**（oracle 的 `register_app(source=...)`），缺省 `null`
 *        ⇒ 裸 `"python-sdk"`。oracle 的 `_register_app_impl` 正是缺省调用。
 * @returns {string}
 */
export function _buildQrUrl(uri, opts = {}) {
  const { prefix, query, fragment } = splitUri(uri);
  const params = parseQuery(query);
  params.set('from', ['sdk']);
  params.set('tp', ['sdk']);
  const source = opts.source === undefined ? null : opts.source;
  params.set('source', [source ? `${SOURCE_SDK_NAME}/${source}` : SOURCE_SDK_NAME]);
  const addons = opts.addons === undefined ? _provisionAddons() : opts.addons;
  if (addons !== null) params.set('addons', [_encodeAddons(addons)]);
  const parts = [];
  for (const [key, values] of params) {
    for (const value of values) parts.push(`${_quotePlus(key)}=${_quotePlus(value)}`);
  }
  return `${prefix}${parts.length ? `?${parts.join('&')}` : ''}${fragment}`;
}

/** `data.get("supported_auth_methods") or []`(:278)：非数组一律当空 */
export function supportedAuthMethods(body) {
  const raw = body === null || typeof body !== 'object' ? undefined : body.supported_auth_methods;
  return Array.isArray(raw) ? raw : [];
}

/** `errors.py`：`RegisterAppError(code, description)`，`str(e)` = `"{code}: {description}"` */
export class RegisterAppError extends Error {
  constructor(code, description) {
    super(`${code}: ${description}`);
    this.name = 'RegisterAppError';
    this.code = code;
    this.description = description;
  }
}

/** `AppAccessDeniedError(RegisterAppError)`（errors.py） */
export class AppAccessDeniedError extends RegisterAppError {
  constructor(code, description) {
    super(code, description);
    this.name = 'AppAccessDeniedError';
  }
}

/** `AppExpiredError(RegisterAppError)`（errors.py） */
export class AppExpiredError extends RegisterAppError {
  constructor(code, description) {
    super(code, description);
    this.name = 'AppExpiredError';
  }
}

/**
 * `threading.Event` 的可用子集（只要 `is_set` / `set`；`_check_cancelled`(:270) 只读 `is_set`）。
 * 别名一并给上，方便与其它移植文件里的线程态写法互认。
 */
export function createCancelEvent() {
  let flag = false;
  return {
    set() { flag = true; },
    clear() { flag = false; },
    isSet() { return flag; },
    is_set() { return flag; },
    isSet_() { return flag; },
    get cancelled() { return flag; },
  };
}

/** 真时钟（ms → s，与 `time.monotonic()` 同为单位语义） */
function defaultNow() {
  return Date.now() / 1000;
}

/** 真睡觉 */
function defaultSleep(seconds) {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(0, seconds) * 1000); });
}

/** `time.sleep` 的可注入版本（单测用假时钟；生产走真 `setTimeout`） */
function sleepOf(proc, seconds) {
  return (proc && proc.sleep ? proc.sleep : defaultSleep)(seconds);
}

/**
 * 一次 Device Flow 的可注入依赖：
 *   - `now` / `sleep`：时钟替身（单测用假时钟 ⇒ `expires_in` 兜底与 `slow_down` 间隔变成确定性读数）；
 *   - `defaults`：覆盖 `begin` 响应的字段（仅测试用；协议本身不接受外部缺省）。
 * `fetch` **不走这里**：oracle 直接调 `requests.post`，等价地这里直接调 `globalThis.fetch`
 * 于**调用时**取（替身测试才能生效，也才能与 `tools/parity` 的 fetch 观测口一致）。
 */
function defaultProc() {
  return { now: defaultNow, sleep: defaultSleep, defaults: null };
}

function asProc(proc) {
  const base = defaultProc();
  return {
    now: proc && typeof proc.now === 'function' ? proc.now : base.now,
    sleep: proc && typeof proc.sleep === 'function' ? proc.sleep : base.sleep,
    defaults: proc && proc.defaults ? proc.defaults : null,
  };
}

/**
 * 造一条 Device Flow（`_SyncFlow` + `register_app` 的等价物）。
 * @param {{now?: () => number, sleep?: (s: number) => Promise<void>, defaults?: object}} [proc]
 * @param {{addons?: object|null, source?: string|null, cancelEvent?: object|null,
 *          onQrCode?: Function|null, onStatusChange?: Function|null,
 *          domain?: string, larkDomain?: string}} [opts]
 */
export function makeDeviceFlow(proc, opts = {}) {
  const p = asProc(proc);
  const addons = opts.addons === undefined ? _provisionAddons() : opts.addons;
  const source = opts.source === undefined ? null : opts.source;
  const cancelEvent = opts.cancelEvent === undefined ? null : opts.cancelEvent;
  const onQrCode = opts.onQrCode || null;
  const onStatusChange = opts.onStatusChange || null;
  const feishuDomain = opts.domain || FEISHU_DOMAIN;
  const larkDomain = opts.larkDomain || LARK_DOMAIN;
  const state = { baseUrl: feishuDomain };

  /** `_check_cancelled`(:269-271) */
  function checkCancelled() {
    const set = cancelEvent !== null && cancelEvent !== undefined
      && (typeof cancelEvent.is_set === 'function' ? cancelEvent.is_set()
        : typeof cancelEvent.isSet === 'function' ? cancelEvent.isSet()
          : Boolean(cancelEvent.cancelled));
    if (set) throw new RegisterAppError('abort', 'cancelled by caller');
  }

  /** `_notify_status`(:189-195)：只有给了 interval 才带该键 */
  function notifyStatus(status, interval) {
    if (onStatusChange === null) return;
    const info = { status };
    if (interval !== undefined && interval !== null) info.interval = interval;
    onStatusChange(info);
  }

  /** `_SyncFlow._post`(:261-267)：表单 POST，`urlencode(data)` + 表单 Content-Type */
  async function post(data) {
    const response = await globalThis.fetch(`${state.baseUrl}${DEVICE_ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    });
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;                     // 见文件头③
    }
    return parsed === null || typeof parsed !== 'object' ? {} : parsed;
  }

  /** `_handle_poll_response`(:197-232)。判定**顺序**是语义：成功 → 域切换 → 错误码 */
  function handlePollResponse(data, domainSwitched) {
    if (data.client_id && data.client_secret) {
      const result = { client_id: data.client_id, client_secret: data.client_secret };
      if (data.user_info) result.user_info = data.user_info;      // `if data.get("user_info")`
      return { action: 'success', result };
    }
    const userInfo = data.user_info || {};
    if (userInfo.tenant_brand === 'lark' && !domainSwitched) {    // 严格 `== "lark"`
      state.baseUrl = larkDomain;
      notifyStatus('domain_switched');
      return { action: 'domain_switched', result: null };
    }
    const error = data.error === undefined || data.error === null ? '' : data.error;
    const errorDesc = data.error_description === undefined || data.error_description === null
      ? '' : data.error_description;
    if (error === 'authorization_pending') {
      notifyStatus('polling');
      return { action: 'pending', result: null };
    }
    if (error === 'slow_down') return { action: 'slow_down', result: null };
    if (error === 'access_denied') throw new AppAccessDeniedError(error, errorDesc);
    if (error === 'expired_token') throw new AppExpiredError(error, errorDesc);
    throw new RegisterAppError(error, errorDesc);
  }

  /** `_SyncFlow.run`(:273-325) */
  async function run() {
    checkCancelled();                                   // :274

    // init（:277-283）
    const initRes = await post({ action: 'init' });
    const methods = supportedAuthMethods(initRes);
    if (!methods.includes('client_secret')) {
      throw new RegisterAppError('unsupported_auth_method',
        'client_secret not in supported_auth_methods');
    }

    // begin（:286-298）
    const beginRaw = await post({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
    const beginRes = p.defaults ? { ...p.defaults, ...beginRaw } : beginRaw;
    const deviceCode = beginRes.device_code;
    const interval0 = beginRes.interval === undefined ? DEFAULT_INTERVAL_S : beginRes.interval;
    const expireIn = beginRes.expires_in === undefined ? DEFAULT_EXPIRES_IN_S : beginRes.expires_in;
    const qrUrl = _buildQrUrl(beginRes.verification_uri_complete, { addons, source });
    if (onQrCode !== null) onQrCode({ url: qrUrl, expire_in: expireIn });

    // poll（:301-324）
    let interval = interval0;
    const deadline = p.now() + expireIn;
    let domainSwitched = false;
    while (p.now() < deadline) {
      checkCancelled();                                 // :305
      const pollRes = await post({ action: 'poll', device_code: deviceCode });
      const { action, result } = handlePollResponse(pollRes, domainSwitched);
      if (action === 'success') return result;
      if (action === 'domain_switched') {
        domainSwitched = true;
        continue;                                       // 切域当轮不吃 sleep（:314-316）
      }
      if (action === 'slow_down') {
        interval += SLOW_DOWN_STEP_S;                    // :319（对后续每轮持续生效）
        notifyStatus('slow_down', interval);
      }
      await sleepOf(p, interval);                        // :322
    }
    throw new AppExpiredError('expired_token', 'polling timed out');   // :324
  }

  return { run, state, checkCancelled, post, handlePollResponse, notifyStatus };
}

/**
 * `lark_oapi.register_app` 的等价入口（:387-411）：建一条流程并跑到底。
 * @param {{addons?: object|null, source?: string|null, cancelEvent?: object|null,
 *          onQrCode?: Function|null, onStatusChange?: Function|null,
 *          domain?: string, larkDomain?: string}} [opts]
 * @param {{now?: Function, sleep?: Function, defaults?: object}} [proc]
 * @returns {Promise<{client_id: string, client_secret: string, user_info?: object}>}
 */
export function registerApp(opts = {}, proc) {
  return makeDeviceFlow(proc, opts).run();
}
