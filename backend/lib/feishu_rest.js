/**
 * 飞书 REST 客户端（M7-R4；`feishu.py:1039-1183` 的对应物）。
 *
 * 逐点对齐 oracle（行号即 `feishu.py`）：
 *   - `FeishuRestError`(:1039) —— 带 `code` 字段（飞书业务码；拿不到业务码时为 `None`/`null`）；
 *   - `_TOKEN_CACHE`(:1049) / `tenantToken`(:1072 `_tenant_token`) —— 按 app_id 分桶缓存，
 *     过期前 5 分钟刷新（`expire = 取值时刻 + expire - 300`，**取值时刻在请求之前**）；
 *   - `_BOT_OPEN_ID`(:1050) / `botOpenId`(:1176 `bot_open_id`)；
 *   - `rest`(:1095 `_rest`) —— 统一鉴权、路径规范化、非 JSON/非 dict 重试 3 次；
 *   - `restSendText`/`restSendCard`/`restReply`/`restPatchText`(:1140-1173)。
 *
 * 四条**实测契约**（照抄，不许「顺手修正」）：
 *   ① `_rest` **只看 `body.code`，不看 HTTP 状态码** ⇒ HTTP 500 + 合法 JSON `{"code":0}`
 *      一样当成功返回（oracle 实测）。同理 HTTP 200 + `code!=0` 抛错。**代码里没有
 *      `resp.ok` / `resp.status` 判定**，`resp.status` 只出现在非 JSON 留痕文案里。
 *   ② 路径规范化（:1105-1107）：`path = "/" + path.lstrip("/")`，再判 `startswith("/open-apis")`
 *      ⇒ 调用方带不带前缀都恰好一层（历史上多拼一层打到 `/open-apis/open-apis/...`，
 *      网关返纯文本 404，异常被吞成「机器人毫无反应」）。
 *   ③ 非 JSON / 非 dict 响应 = 网关粘连/截断，往 stderr 留痕后**重试**，最多 3 次；
 *      3 次后抛 `FeishuRestError`，文案 `REST {method} {path} {err_hint}（已重试 3 次）`。
 *      `code != 0` 立即抛 `REST {path} code={code} {msg}`（**不重试**）。
 *   ④ token 请求体走 `pyJsonDumps`（Python `requests` 的 `json=` 序列化 = CPython 默认
 *      分隔符 `", "` / `": "`）⇒ 与 oracle 逐字节一致；超时 10s（:1083 硬编码）。
 *
 * 与 Python 的形态差异（有意，逐条登记）：
 *   - 全部函数 async（Node 无同步 HTTP）；返回 Promise。
 *   - `requests` → `globalThis.fetch`（调用时才取，便于测试替身/对拍缝）。**副作用**：
 *     真机请求头与会话形态与 requests 不同（undici 会自己加 `accept`/`accept-encoding`/
 *     `user-agent: undici`，requests 加 `User-Agent: python-requests/…`/`Accept-Encoding`）——
 *     属对拍计划 §四 R2 已登记的跨运行时差异，靠归一表处理，不在本文件里伪装。
 *   - 超时用 `AbortSignal.timeout(秒*1000)`。异常文案的 `{e}` 逐字不同（`token 请求失败: {e}`、
 *     `REST {method} {path} 失败: {e}` 的**外壳逐字相同**，内层报错文本是运行时自带的：
 *     `fetch failed` vs `[Errno 111] Connection refused`）——同样登记为已知分歧。
 *   - 响应体**读取**失败（`resp.text()` reject）：Python 侧 `r.json()` 内部的 OSError 会**穿透**
 *     `_rest`（不被包装），这里归进 `REST {method} {path} 失败: {e}` 桶（形状同连接失败，
 *     不谎称是「非 JSON 响应」）。已知分歧，未验。
 *   - 查询串自实现 `pyQuotePlus`（= `urllib.parse.quote_plus`，UTF-8 字节级、空格 `+`、
 *     `~` 不转义）；**不用** `URLSearchParams`（它把 `~` 编成 `%7E`，与 oracle 分叉）。
 *   - `str()` 口径：`None` → `'None'`、`True/False` → `'True'/'False'`（文案里逐字出现）。
 *
 * 零 npm 依赖（只用 `./pyjson.js`）。
 */
import { pyJsonDumps } from './pyjson.js';

/** 飞书开放平台 origin（`feishu.py:1081/1108` 硬编码；**无 env 覆盖点**，别加） */
export const FEISHU_HOST = 'https://open.feishu.cn';

/**
 * 开发者后台应用页 origin（`feishu.py:1511-1512` 的 `https://open.feishu.cn/app/{app_id}`）。
 * 与 `FEISHU_HOST` 是**同一字节串**：Python 没有这个常量（两处硬编码），这里收口成一个名字，
 * 给斜杠权限卡与后续 R5 供给族共用。若判断错：只影响 `FEISHU_DOMAIN` 这个名字的取值口径。
 */
export const FEISHU_DOMAIN = 'https://open.feishu.cn';

/** tenant_access_token 请求超时（秒；`feishu.py:1083` 硬编码 10） */
const TOKEN_TIMEOUT_S = 10;

/** `_rest` 网络异常外的重试次数（`feishu.py:1110` 的 `for attempt in (1, 2, 3)`） */
const REST_ATTEMPTS = 3;

/**
 * 飞书 REST 调用失败（token 获取 / 业务 code 非 0 / 网络异常 / 连续非 JSON 响应）。
 * `code` = 飞书业务码（99991640 缺权限、40000000 业务约束、40000031 图标非法……），
 * 网络异常/非 JSON 这类拿不到业务码的情形为 `null`（对齐 `feishu.py:1039-1046`）。
 */
export class FeishuRestError extends Error {
  /**
   * @param {string} message
   * @param {any} [code] 飞书业务码；缺省 `null`（Python `None`）
   */
  constructor(message, code = null) {
    super(message);
    this.name = 'FeishuRestError';
    this.code = code;
  }
}

/**
 * `app_id -> {token, expire}`（epoch 秒）。对齐 `feishu._TOKEN_CACHE`(feishu.py:1049)：
 * **模块级可变 dict**，导出是为了让测试/对拍能 `clear()` 做隔离（Python 侧同样可 poke）。
 * @type {Map<string, {token: string, expire: number}>}
 */
export const _TOKEN_CACHE = new Map();

/**
 * `app_id -> 机器人自身 open_id`。对齐 `feishu._BOT_OPEN_ID`(feishu.py:1050)，同上可清。
 * @type {Map<string, string|null>}
 */
export const _BOT_OPEN_ID = new Map();

/** Python `dict.get(k, d)`：键存在但值为 None 时返回 None（不是 d） */
function dictGet(dict, key, dflt = undefined) {
  return Object.hasOwn(dict, key) ? dict[key] : dflt;
}

/** Python 真值口径（`""`/`0`/`None`/`False`/空容器为假） */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `str(x)` 的可用子集（错误文案/查询串里逐字出现；浮点偏差见 pyjson.js 文件头） */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

/** Python `x == 0`：`False == 0`、`0.0 == 0` 都为真（`!==` 会把 `false` 误判成非 0） */
function pyEqZero(value) {
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'bigint') return value === 0n;
  return value === 0;
}

/** `urllib.parse.quote_plus`（UTF-8 字节级；空格 `+`；`A-Za-z0-9_.-~` 原样） */
function pyQuotePlus(value) {
  let out = '';
  for (const byte of Buffer.from(pyStr(value), 'utf8')) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f || byte === 0x2e
      || byte === 0x2d || byte === 0x7e) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x20) {
      out += '+';
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** `requests` 的 `params=` 编码（dict → `urlencode`；顺序即插入序） */
function encodeParams(params) {
  if (params === null || params === undefined) return '';
  const parts = [];
  for (const key of Object.keys(params)) {
    parts.push(`${pyQuotePlus(key)}=${pyQuotePlus(params[key])}`);
  }
  return parts.join('&');
}

/** Python `repr(bytes)` 的可用子集（非 JSON 留痕用：`b'...'`，非可打印/非 ASCII 走 `\xNN`） */
function pyBytesRepr(text, limit = 200) {
  const buf = Buffer.from(text, 'utf8').subarray(0, limit);
  let out = "b'";
  for (const byte of buf) {
    if (byte === 0x5c) out += '\\\\';
    else if (byte === 0x27) out += "\\'";
    else if (byte === 0x09) out += '\\t';
    else if (byte === 0x0a) out += '\\n';
    else if (byte === 0x0d) out += '\\r';
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += '\\x' + byte.toString(16).padStart(2, '0');
  }
  return out + "'";
}

/** Python `repr(str)` 的可用子集（非 dict 留痕用：单引号串；超 200 **字符**截断，同 oracle） */
function pyStrRepr(text, limit = 200) {
  const chars = Array.from(text).slice(0, limit);
  let out = "'";
  for (const ch of chars) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch.codePointAt(0) < 0x20) out += '\\x' + ch.codePointAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + "'";
}

/** 线程安全的 stderr 留痕（Python `print(..., file=sys.stderr, flush=True)`） */
function stderrLine(line) {
  process.stderr.write(`${line}\n`);
}

/** 异常 → 文案（Python `f"{e}"` = `str(e)`；`Error` 取 `.message`，其余 `String()`） */
function errText(error) {
  if (error instanceof Error) return error.message;
  return pyStr(error);
}

/** 请求 init（Python `requests.request(..., headers={...}, json=..., timeout=...)` 的对位） */
function requestInit({ method, jsonBody, token, timeout }) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  // Python `json=None` ⇒ requests 不序列化请求体（≠ `json={}`）
  if (jsonBody !== null && jsonBody !== undefined) init.body = pyJsonDumps(jsonBody);
  if (timeout !== null && timeout !== undefined) init.signal = AbortSignal.timeout(timeout * 1000);
  return init;
}

/**
 * tenant_access_token（按 app_id 分桶缓存，过期前 5 分钟刷新）。
 * 对齐 `feishu._tenant_token`(feishu.py:1072-1092)。
 *
 * 失败口径：网络/解析失败 ⇒ `FeishuRestError('token 请求失败: {e}')`（code `null`）；
 * 业务码非 0 ⇒ `FeishuRestError('token 获取失败 code={code} {msg}', code)`（**不写缓存**）。
 * @param {{app_id?: string, app_secret?: string}} cfg
 * @returns {Promise<string>}
 */
export async function tenantToken(cfg) {
  const appId = (cfg && cfg.app_id) || '';
  const now = Date.now() / 1000;                       // Python `time.time()`（取值在请求之前）
  const cached = _TOKEN_CACHE.get(appId) || {};
  if (pyTruthy(cached.token) && now < dictGet(cached, 'expire', 0)) return cached.token;
  let out;
  try {
    const resp = await globalThis.fetch(
      `${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pyJsonDumps({
          app_id: appId,
          app_secret: dictGet(cfg || {}, 'app_secret', ''),
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_S * 1000),
      },
    );
    out = await resp.json();
  } catch (error) {
    throw new FeishuRestError(`token 请求失败: ${errText(error)}`);
  }
  if (!pyEqZero(dictGet(out, 'code'))) {
    throw new FeishuRestError(
      `token 获取失败 code=${pyStr(dictGet(out, 'code'))} ${pyStr(dictGet(out, 'msg', ''))}`,
      dictGet(out, 'code', null),
    );
  }
  if (!Object.hasOwn(out, 'tenant_access_token')) {
    // Python 这里是 `out["tenant_access_token"]` ⇒ KeyError（不是 FeishuRestError）
    throw new Error("KeyError: 'tenant_access_token'");
  }
  // 键存在但为 null 时 Python 抛 TypeError（`float + None`）；这里 null 折 0。
  // 不可达分支（真响应恒带 int），登记为已知分歧。
  _TOKEN_CACHE.set(appId, {
    token: out.tenant_access_token,
    expire: now + dictGet(out, 'expire', 7200) - 300,
  });
  return out.tenant_access_token;
}

/**
 * 飞书 REST 统一调用（按用户应用 cfg 鉴权）。对齐 `feishu._rest`(feishu.py:1095-1137)。
 *
 * 路径规范化：调用方带/不带 `/open-apis` 前缀均恰好拼出一层。业务码非 0 立即抛；
 * 非 JSON/非 dict 响应留痕原始字节后重试，最多 3 次。
 * @param {string} method HTTP 方法（Python 侧直传 requests）
 * @param {string} path 形如 `/open-apis/im/v1/messages` 或 `im/v1/messages`
 * @param {{params?: object, jsonBody?: any, cfg?: object, timeout?: number|null}} [options]
 *        `timeout` 秒；`null` = 不限时（Python `None`），缺省 10。
 * @returns {Promise<object>} 解析后的响应 dict（**不看 HTTP 状态码**，见文件头 ①）
 * @throws {FeishuRestError} cfg 缺失 / 网络异常 / 非 JSON 连续 3 次 / 业务码非 0
 */
export async function rest(method, path, { params, jsonBody, cfg, timeout = 10 } = {}) {
  if (cfg === null || cfg === undefined) {
    throw new FeishuRestError('应用未配置（app_id/app_secret 缺失）');
  }
  let norm = `/${String(path).replace(/^\/+/, '')}`;
  if (!norm.startsWith('/open-apis')) norm = `/open-apis${norm}`;
  const query = encodeParams(params);
  const url = `${FEISHU_HOST}${norm}${query ? `?${query}` : ''}`;
  let errHint = '';
  for (let attempt = 1; attempt <= REST_ATTEMPTS; attempt += 1) {
    // token 在 try 之外取：Python 侧 `_tenant_token` 抛的 FeishuRestError 不属
    // `except (OSError, ValueError)` ⇒ 穿透 `_rest`，这里同样不包装。
    const token = await tenantToken(cfg);
    let resp;
    try {
      resp = await globalThis.fetch(url, requestInit({ method, jsonBody, token, timeout }));
    } catch (error) {
      throw new FeishuRestError(`REST ${method} ${norm} 失败: ${errText(error)}`);
    }
    let raw;
    try {
      raw = await resp.text();
    } catch (error) {
      throw new FeishuRestError(`REST ${method} ${norm} 失败: ${errText(error)}`);
    }
    let out;
    try {
      out = JSON.parse(raw);
    } catch {
      stderrLine(`feishu rest: 非 JSON 响应(${attempt}/${REST_ATTEMPTS}) ${method} ${norm} `
        + `status=${resp.status} raw=${pyBytesRepr(raw)}`);
      errHint = `响应非 JSON status=${resp.status}`;
      continue;
    }
    if (out === null || typeof out !== 'object' || Array.isArray(out)) {
      stderrLine(`feishu rest: 非 dict 响应(${attempt}/${REST_ATTEMPTS}) ${method} ${norm} `
        + `raw=${pyStrRepr(raw)}`);
      errHint = '响应非对象';
      continue;
    }
    if (!pyEqZero(dictGet(out, 'code'))) {
      throw new FeishuRestError(
        `REST ${norm} code=${pyStr(dictGet(out, 'code'))} ${pyStr(dictGet(out, 'msg', ''))}`,
        dictGet(out, 'code', null),
      );
    }
    return out;
  }
  throw new FeishuRestError(`REST ${method} ${norm} ${errHint}（已重试 ${REST_ATTEMPTS} 次）`);
}

/**
 * 主动发单聊文本。对齐 `feishu.rest_send_text`(feishu.py:1140-1146)。
 * @param {string} openId 接收方在该应用下的 open_id
 * @param {string} text
 * @param {object} cfg 用户应用凭据
 * @returns {Promise<void>} Python 侧隐式 `None`
 */
export async function restSendText(openId, text, cfg) {
  await rest('POST', '/open-apis/im/v1/messages', {
    params: { receive_id_type: 'open_id' },
    jsonBody: {
      receive_id: openId,
      msg_type: 'text',
      content: pyJsonDumps({ text }),
    },
    cfg,
  });
}

/**
 * 主动发单聊交互卡片（schema 2.0 dict）。对齐 `feishu.rest_send_card`(feishu.py:1149-1157)：
 * `content` 直接传卡片 JSON 串；`{"data": …}` 包裹会被 230099 拒绝（2026-09-27 spike 实测）。
 * @param {string} openId
 * @param {object} card
 * @param {object} cfg
 * @returns {Promise<void>}
 */
export async function restSendCard(openId, card, cfg) {
  await rest('POST', '/open-apis/im/v1/messages', {
    params: { receive_id_type: 'open_id' },
    jsonBody: {
      receive_id: openId,
      msg_type: 'interactive',
      content: pyJsonDumps(card),
    },
    cfg,
  });
}

/**
 * 回复触发消息（带线程上下文）。对齐 `feishu.rest_reply`(feishu.py:1160-1165)。
 * @param {string} messageId
 * @param {string} text
 * @param {object} cfg
 * @returns {Promise<void>}
 */
export async function restReply(messageId, text, cfg) {
  await rest('POST', `/open-apis/im/v1/messages/${messageId}/reply`, {
    jsonBody: { msg_type: 'text', content: pyJsonDumps({ text }) },
    cfg,
  });
}

/**
 * 原地补丁 bot 已发消息（「占位-补丁」回执用）。对齐 `feishu.rest_patch_text`(feishu.py:1168-1173)：
 * 方法是 **PUT**（假上游路由表 PATCH/PUT 都收，见 `tools/parity/probe/fake_feishu.mjs`）。
 * @param {string} messageId
 * @param {string} text
 * @param {object} cfg
 * @returns {Promise<void>}
 */
export async function restPatchText(messageId, text, cfg) {
  await rest('PUT', `/open-apis/im/v1/messages/${messageId}`, {
    jsonBody: { msg_type: 'text', content: pyJsonDumps({ text }) },
    cfg,
  });
}

/**
 * 机器人自身 open_id（`/bot/v3/info`，按 app_id 缓存一次）。对齐 `feishu.bot_open_id`(feishu.py:1176-1183)。
 * 取不到时缓存 `null`（Python `None`）并原样返回。
 * @param {object} cfg
 * @returns {Promise<string|null>}
 */
export async function botOpenId(cfg) {
  const appId = (cfg && cfg.app_id) || '';
  if (pyTruthy(_BOT_OPEN_ID.get(appId))) return _BOT_OPEN_ID.get(appId);
  const out = await rest('GET', '/open-apis/bot/v3/info', { cfg });
  const bot = out.bot || {};
  _BOT_OPEN_ID.set(appId, dictGet(bot, 'open_id', null));
  return _BOT_OPEN_ID.get(appId);
}
