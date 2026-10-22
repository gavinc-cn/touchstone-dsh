/**
 * Touchstone 的 dsh 插件进程内 agent 驱动客户端（`dshdriver.py` 771 行的 Node 对应物，M2）。
 *
 * 单族世界（与 Python 侧同）：本模块**不拉起任何进程**——dsh 插件
 * （`dsh-plugin/lib/agent-driver.js`，权威契约）跑在 dsh 宿主 Node 进程内，把平台任务映射成
 * 进程内常驻 agent 会话，并把会话事件经 SSE **推**回本进程。连接信息由插件经子进程环境变量
 * 下发：`TS_AGENT_DRIVER_URL` / `TS_AGENT_DRIVER_TOKEN`（独立形态下两者皆空 ⇒ 驱动不可用）。
 *
 * 零 npm 依赖：HTTP 用内建 `fetch`，SSE 消费复用 `backend/lib/sse.js`（**不重复实现**，
 * 该文件是 `_stream_events` 的对应物，含 stop 唤醒/空闲超时/对端关闭三条坑的处置）。
 *
 * ── Python 名 ↔ Node 名（导出面；Node 侧一律 camelCase） ──────────────────────────────
 *   URL_ENV / TOKEN_ENV                    同名
 *   driver_url() / configured()            driverUrl() / configured()
 *   _headers()                             authHeaders()
 *   _split_url()                           splitDriverUrl()   （三元组 → {host,port,basePath}）
 *   _request(...)                          request(...)       （timeout 秒 → timeoutMs 毫秒）
 *   health / available / live_snapshot     health / available / liveSnapshot
 *   live / status / media / models         live / status / media / models
 *   presets / archived                     presets / archived
 *     （`presets` 的 `session_id` 可空：空 ⇒ 取宿主全局权限目录、不带查询串）
 *   create_session / resume_session        createSession / resumeSession
 *   ensure_session / prompt / steer        ensureSession / prompt / steer
 *   cancel / dispose / compact / fork      cancel / dispose / compact / fork
 *   rename / set_model / set_permission    rename / setModel / setPermission
 *   answer_approval / answer_question      answerApproval / answerQuestion
 *   archive / unarchive / watch_session    archive / unarchive / watchSession
 *   apply_session_defaults                 applySessionDefaults
 *   split_model                            splitModel
 *   turn_exit_code(reason)                 turnExitCode(reason)
 *   parse_stream_line / parse_sse_*        parseStreamLine / parseSseBlock（再导出 sse.js）
 *   feed_into / stream / state_stream      feedInto / stream / stateStream
 *   TurnWaiter.wait_turn(timeout)          TurnWaiter.wait(timeoutMs)
 *   LEGACY_PERMISSION_ALIASES / BUILTIN_PERMISSION_LABELS_ZH / BUILTIN_PERMISSION_LABELS_EN /
 *   BUILTIN_PERMISSION_DESCRIPTIONS / permissionOption / EFFORT_LEVELS /
 *   ARCHIVE_UNKNOWN_SESSION / WATCH_UNSUPPORTED / TURN_END / INTERACTION / REQUEST_TIMEOUT /
 *   HEALTH_TIMEOUT / STREAM_IDLE_TIMEOUT / WATCH_TIMEOUT    全部同名同值/同义（秒级常量保持
 *   Python 数值；`permission_option` 在 Node 侧为 `permissionOption`）
 *   _stop_watcher / STOP_WATCH_INTERVAL    由 sse.js 的 STOP_WATCH_INTERVAL_MS 承担（再导出）
 *
 * ── 与 Python 的语义差异（逐条，均为形态差异而非行为差异） ────────────────────────────
 *   ① **异步**：Python 同步阻塞，Node 全部返回 Promise ⇒ 调用方必须 `await`（含
 *      `applySessionDefaults`：Python 同步顺序下发，Node 顺序 await 同一顺序）。
 *   ② **超时口径**：Python 是「秒」位置参数；Node 一律毫秒，走末位 opts 字段 `timeoutMs`
 *      （`stream/stateStream` 用 `idleTimeoutMs`，与 sse.js 一致）。秒级常量仍同名导出，
 *      便于逐条对照：`REQUEST_TIMEOUT=120 / HEALTH_TIMEOUT=5 / STREAM_IDLE_TIMEOUT=90 /
 *      WATCH_TIMEOUT=2`。
 *   ③ **错误**：`DshDriverError` 的 `code` + 中文 `message` 与 Python 一致；Python 读
 *      `err.args[0]` 的判据（board 的 `_answer_question_gone` 等）在 Node 侧改读 `err.code`。
 *   ④ **`TurnWaiter`**：Python 是 `threading.Event/Condition` 阻塞原语；Node 改为
 *      Promise/回调式（`feed()` / `fail()` / `wait(timeoutMs) → Promise<结果>`），
 *      **状态字段与返回值口径逐条保留**（含 interaction 的 consume-on-read）。
 *   ⑤ **URL 编码**：查询串按 Python `urllib.parse.quote` 口径实现（`quoteBase`/`quoteQuery`）——
 *      `/status`·`/presets` 是 `quote(sid)`（`safe='/'`：斜杠不编码），`/media?id=` 是
 *      `quote(id, safe="")`（斜杠也编码），且补齐 JS `encodeURIComponent` 不转义的 `!'()*`。
 *      两种写法对端解码后语义相同，这是为了与 Python **逐字节可比**。
 *   ⑥ **`request`** 的网络/超时异常都映射 `-2`（Python 的 `URLError/OSError` 同口径），
 *      消息文案按 Node 侧措辞（`驱动不可达: …`）；状态码 ≥400 映射该状态码，正文 `error`
 *      字段优先作消息、否则 `驱动返回 HTTP <code>`——与 Python 逐条一致。
 *   ⑦ 宽容读：Python 对非 dict 响应取 `.get()` 会 AttributeError，Node 返回空表/空串
 *      （`live()` / `archived()` / `liveSnapshot()` 等读口）。**写路径不宽容**：`/session`
 *      回执缺 `session_id` 时 Python 直接下标抛 KeyError（响亮失败），Node 同样抛
 *      `DshDriverError(-2, '驱动响应缺少 session_id')`（见 `requireSessionId`）——绝不把
 *      `undefined`/空值放给 M4/M5 写库或塞进下一个请求体。
 *   ⑧ **请求体字节口径**：`request` 的正文用 `pyJsonDumps`（M1 的 `backend/lib/pyjson.js`，
 *      与 CPython `json.dumps(..., ensure_ascii=False)` 逐字节一致，分隔符 `", "` / `": "`），
 *      而非 `JSON.stringify` 的紧凑形态 ⇒ 两版后端的请求体在对拍里可直接逐字节比。
 *      **代价**：`pyJsonDumps` 对 `undefined`/函数/symbol/非普通对象一律抛 TypeError
 *      （`JSON.stringify` 会静默丢 `undefined` 键）——这与 Python 侧「无对应物即抛」一致，
 *      属于有意的响亮失败；本模块自建的载荷全部是普通对象 + 已显式设值的字符串/布尔/整数。
 *
 * 红线：令牌不落任何日志；驱动端点仅回环可达（插件侧同时校验来源地址与令牌）。
 */
import { pyJsonDumps } from './pyjson.js';
import { SseError, sseUrl, streamEvents } from './sse.js';

// SSE 消费本体的再导出：`dshdriver.parse_stream_line` / `streamEvents` 等在原模块里的位置
export {
  SseError,
  STOP_WATCH_INTERVAL_MS,
  parseSseBlock,
  parseStreamLine,
  sseUrl,
  streamEvents,
} from './sse.js';

// ---------- 常量 ----------

/** 由 dsh 插件注入的驱动连接信息（独立形态下两者皆空 → 驱动不可用） */
export const URL_ENV = 'TS_AGENT_DRIVER_URL';
export const TOKEN_ENV = 'TS_AGENT_DRIVER_TOKEN';

/** 普通请求超时（秒）：建/恢复会话要加载持久化日志，给足余量 */
export const REQUEST_TIMEOUT = 120;
/** 探活超时（秒）：health 必须秒级返回，用于「驱动是否可用」的快速判定 */
export const HEALTH_TIMEOUT = 5;
/** SSE 空闲超时（秒）：插件每 15s 发一帧 keepalive 注释，超过该值视为链路僵死 */
export const STREAM_IDLE_TIMEOUT = 90;
/** 看管声明超时（秒）：`/watch` 是驱动侧纯内存写，投递前置闸在 HTTP 线程上同步调它 */
export const WATCH_TIMEOUT = 2;
/**
 * stop 唤醒粒度（秒，仅作 Python 名字对照）：Python 用它驱动旁路看门线程
 * `_stop_watcher`；Node 侧的等价物是 `sse.js` 的 `STOP_WATCH_INTERVAL_MS`（250ms，已再导出），
 * 本常量不再被任何代码读取。
 */
export const STOP_WATCH_INTERVAL = 0.25;

/** 未配置驱动的统一文案（Python `_request`/`_stream_events` 逐字相同） */
const UNCONFIGURED_MESSAGE = '未配置 dsh agent 驱动（非插件形态或插件未下发驱动地址）';

/** 各类请求的毫秒超时（与 Python 各调用点的秒值一一对应） */
const HEALTH_TIMEOUT_MS = HEALTH_TIMEOUT * 1000;
const LIVE_TIMEOUT_MS = 10000;          // live_snapshot(timeout=10)
const STATUS_TIMEOUT_MS = 15000;        // status() 的 15
const SHORT_TIMEOUT_MS = 30000;         // media/models/presets/answer/approval/permission/archive
const DISPOSE_TIMEOUT_MS = 60000;       // dispose 的 60
const MODEL_TIMEOUT_MS = 60000;         // set_model 的 60
const FORK_TIMEOUT_MS = 60000;          // fork 的 60
const WATCH_TIMEOUT_MS = WATCH_TIMEOUT * 1000;

// ---------- 错误 ----------

/**
 * 驱动/会话调用失败。`code` 为 HTTP 状态码或负值（-1=未配置 / -2=网络/链路异常）。
 *
 * 与 Python `DshDriverError` 的对应：Python 的 `args = (code, message)` 二元组约定，在
 * Node 侧由 `code` + `message` 两个属性承载（既有判据 `err.args[0]` → `err.code`）；
 * `String(err)` / `err.message` 一律是**纯中文消息**（不会出现元组串）。
 */
export class DshDriverError extends Error {
  /**
   * @param {number} code HTTP 状态码，或 -1（未配置）/ -2（网络/链路异常）
   * @param {string} message 中文消息（可直接进日志/给用户）
   */
  constructor(code, message) {
    super(message);
    this.name = 'DshDriverError';
    this.code = code;
  }

  /**
   * `String(err)` 一律是**纯消息**（不出现 `DshDriverError: ` 前缀）。
   *
   * 对齐 Python 的 `__str__` 覆写：平台侧日志大量是 `f"…：{e}"` 形态，移植到 Node 的模板串
   * `${err}` 会走 `toString()`；不覆写就会多出一截类名，日志口径与 Python 不一致。
   */
  toString() {
    return String(this.message);
  }
}

// ---------- 连接与配置 ----------

/** 驱动前缀地址（未配置返回空串）。对齐 `driver_url()`：trim + 去尾部 `/` */
export function driverUrl() {
  return String(process.env[URL_ENV] || '').trim().replace(/\/+$/, '');
}

/** 本进程是否运行在 dsh 插件形态下（插件已下发驱动地址）。对齐 `configured()` */
export function configured() {
  return Boolean(driverUrl());
}

/**
 * 统一请求头（对齐 `_headers()`）：驱动令牌走自定义头（不回显、不落日志）。
 * 每次调用现取环境变量（与 Python 同口径，测试可运行中改 env）。
 */
export function authHeaders() {
  const token = process.env[TOKEN_ENV] || '';
  const head = {
    'content-type': 'application/json; charset=utf-8',
    accept: 'application/json',
  };
  if (token) head['x-ts-driver-token'] = token;
  return head;
}

/**
 * 把驱动地址拆成 `{host, port, basePath}`（对齐 `_split_url()`；Python 返回三元组）。
 *
 * 只接受 `http:`（驱动在宿主进程内、仅回环，无 TLS）；未配置/协议不符/无 host 一律抛
 * `DshDriverError(-1, '驱动地址不可用: …')`。
 *
 * @returns {{host: string, port: number, basePath: string}}
 */
export function splitDriverUrl() {
  const raw = driverUrl();
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || parsed.protocol !== 'http:' || !parsed.hostname) {
    throw new DshDriverError(-1, `驱动地址不可用: ${raw || '(空)'}`);
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 80,
    basePath: parsed.pathname.replace(/\/+$/, ''),
  };
}

/** 毫秒 → 人类可读（日志/错误文案用）：整秒显示 `120s`，否则 `150ms` */
function msLabel(timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms)) return '∞';
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** `since` 归一成整数（对齐 Python 的 `int(since)`；坏值按 0） */
function toSeq(since) {
  const n = Number(since);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 从错误响应正文里取 `{"error": "…"}`（取不到返回空串，走通用文案） */
function httpErrorDetail(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // 非 JSON 正文：detail 为空，调用方用「驱动返回 HTTP <code>」
  }
  return '';
}

/** 传输层失败 → `DshDriverError(-2, …)`；`aborted` 表示是我们自己的超时定时器掐的 */
function transportError(error, aborted, timeoutMs) {
  if (aborted) {
    return new DshDriverError(-2, `驱动不可达: 请求超时（>${msLabel(timeoutMs)} 无响应）`);
  }
  const detail = error && error.message ? error.message : String(error);
  return new DshDriverError(-2, `驱动不可达: ${detail}`);
}

// ---------- HTTP 客户端 ----------

/**
 * 向驱动端点发一次 JSON 请求，返回解析后的值（失败抛 `DshDriverError`）。
 *
 * 与 Python `_request` 逐条对齐：
 *   - 未配置 ⇒ `-1`；网络失败/超时 ⇒ `-2`；HTTP ≥400 ⇒ 该状态码，正文 `error` 字段优先；
 *   - 正文空 ⇒ `{}`；正文非 JSON ⇒ `-2 驱动响应不是 JSON: <前 200 字>`；
 *   - 请求体走 `pyJsonDumps`（对应 `json.dumps(..., ensure_ascii=False)`，**与 CPython 逐字节
 *     一致**：分隔符 `", "` / `": "`、非 ASCII 原样；不用 `JSON.stringify` 的紧凑形态）。
 *
 * @param {string} method HTTP 方法
 * @param {string} path 以 `/` 开头的端点路径（查询串调用方拼好）
 * @param {object|null} [payload] 请求体；null/undefined 表示无体（GET 用）
 * @param {number} [timeoutMs] 超时（毫秒）
 * @param {typeof fetch} [fetchImpl] 注入用（测试/特殊运行时）
 * @returns {Promise<any>}
 */
export async function request(method, path, payload = null, timeoutMs = REQUEST_TIMEOUT * 1000,
  fetchImpl = fetch) {
  if (!configured()) throw new DshDriverError(-1, UNCONFIGURED_MESSAGE);
  const init = { method, headers: authHeaders() };
  if (payload !== null && payload !== undefined) init.body = pyJsonDumps(payload);
  const controller = new AbortController();
  let aborted = false;
  const timer = setTimeout(() => {
    aborted = true;
    controller.abort();
  }, timeoutMs);
  init.signal = controller.signal;
  try {
    let response;
    try {
      response = await fetchImpl(driverUrl() + path, init);
    } catch (error) {
      throw transportError(error, aborted, timeoutMs);
    }
    if (response.status >= 400) {
      let raw = '';
      try {
        raw = await response.text();
      } catch {
        raw = '';                       // 错误响应正文读不到：退通用文案（对齐 Python 的 detail=''）
      }
      const detail = raw ? httpErrorDetail(raw) : '';
      throw new DshDriverError(response.status, detail || `驱动返回 HTTP ${response.status}`);
    }
    let raw;
    try {
      raw = await response.text();
    } catch (error) {
      throw transportError(error, aborted, timeoutMs);
    }
    if (raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new DshDriverError(-2, `驱动响应不是 JSON: ${raw.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 探活与状态 ----------

/**
 * 探活：返回 `{ok, live, ...}`；驱动未配置/不可达/未就绪一律抛错（调用方按需捕获）。
 * @param {{timeoutMs?: number}} [opts]
 */
export async function health({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return request('GET', '/health', null, timeoutMs);
}

/**
 * 驱动是否可用且 agents 服务已就绪（不抛异常的布尔口径，供族分派与 UI 判定）。
 * @param {{timeoutMs?: number}} [opts]
 */
export async function available({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  if (!configured()) return false;
  try {
    const resp = await health({ timeoutMs });
    return Boolean(resp && resp.ok);
  } catch (error) {
    if (error instanceof DshDriverError) return false;
    throw error;
  }
}

/**
 * `/live` 的**原始响应**：`{sessions: [...], complete?: bool}`。
 *
 * `complete`（A 批 2026-10-08 起真插件会上报）＝插件是否已枚举宿主已有会话：只有它为 true，
 * **空表**才具备「宿主里确实没有会话」的语义（见 dshevents 的 `_align`）。旧装机副本没有该
 * 字段 ⇒ 缺省按未声明处理（空表＝未知）。
 *
 * 单列一个读口的原因（Python 侧同）：`live()` 返回**行表**，而中枢对齐需要「行表 + 完整性
 * 声明」两件东西；把行表当 dict 取 `.sessions` 会让中枢永久「未对齐」。
 *
 * @param {{timeoutMs?: number}} [opts]
 */
export async function liveSnapshot({ timeoutMs = LIVE_TIMEOUT_MS } = {}) {
  return (await request('GET', '/live', null, timeoutMs)) || {};
}

/**
 * 当前可见会话表（含外部直跑会话）：替代逐会话 REST 探测的实时态来源。
 * 返回**行表数组**（历史契约）；需要完整性声明用 `liveSnapshot()`。
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<object[]>}
 */
export async function live(opts = {}) {
  const resp = await liveSnapshot(opts);
  const rows = resp !== null && typeof resp === 'object' ? resp.sessions : undefined;
  return Array.isArray(rows) ? rows.slice() : [];
}

/**
 * Python `urllib.parse.quote()` 的公共部分（`encodeURIComponent` + 补转义 `!'()*`）。
 *
 * 两处细节：Python 的 quote 会转义 `!'()*`（JS 的 `encodeURIComponent` 不转义）；Python 的
 * 「永不转义集」与 JS 相同（字母数字 + `_.-~`），故这一层等价。
 *
 * @param {unknown} value
 * @returns {string}
 */
function quoteBase(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Python `quote(v)`（默认 `safe='/'`：**斜杠不编码**）——`/status`·`/presets` 的查询串口径 */
function quoteQuery(value) {
  return quoteBase(value).replace(/%2F/g, '/');
}

/**
 * 单会话状态：`{status, last_seq, last_turn_reason, interaction, cwd, task, …}`。
 *
 * 查询串编码对齐 Python `quote(session_id)`（`safe='/'`）⇒ 与 Python 侧逐字节同形
 * （`/` 保持原样，`!'()*` 转义）。
 *
 * @param {string} sessionId
 */
export async function status(sessionId) {
  return request('GET', `/status?session_id=${quoteQuery(sessionId)}`, null, STATUS_TIMEOUT_MS);
}

/**
 * 读宿主图片附件字节（`GET /media?id=`；插件走 `attachments.imageHostPath`）。
 * 返回 `{content_type, bytes, data(base64)}`；附件不存在/引用非法 ⇒ `DshDriverError(404)`。
 *
 * 编码对齐 Python `quote(str(attachment_id), safe="")`：斜杠也编码（走 `quoteBase`）。
 *
 * @param {string} attachmentId
 */
export async function media(attachmentId) {
  return request('GET', `/media?id=${quoteBase(attachmentId)}`, null, SHORT_TIMEOUT_MS);
}

/**
 * 读宿主模型目录（`sessionController.modelCatalog`，插件缓存 60s）。
 * 返回 `{default:{provider,model}, groups:[…], routable_providers[], failures[]}`。
 */
export async function models() {
  return request('GET', '/models', null, SHORT_TIMEOUT_MS);
}

/**
 * 读会话可选权限 preset：`{current, options:[{value,name,description}], default}`。
 *
 * `sessionId` 为空（缺省/空串）⇒ **不带查询串**取宿主全局权限目录（不查会话池；2026-10-21
 * 权限档对齐后平台的唯一目录数据源）。带 sid 时查询串编码同 `status`
 * （Python `quote(str(session_id))`，`safe='/'`）。
 *
 * @param {string} [sessionId]
 */
export async function presets(sessionId = '') {
  if (!sessionId) return request('GET', '/presets', null, SHORT_TIMEOUT_MS);
  return request('GET', `/presets?session_id=${quoteQuery(sessionId)}`, null, SHORT_TIMEOUT_MS);
}

/**
 * 读宿主归档集整表（`ctx.workspaceRegistry.archivedSessionIds`）。
 * 返回会话 id 数组（宿主无归档 → 空数组）；驱动未配置/不可达抛 `DshDriverError`。
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<string[]>}
 */
export async function archived({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const resp = await request('GET', '/archived', null, timeoutMs);
  const rows = resp !== null && typeof resp === 'object' ? resp.archived : undefined;
  return Array.isArray(rows) ? rows.slice() : [];
}

// ---------- 会话生命周期 ----------

/**
 * 把平台侧模型值拆成 `[provider, model]`，供 `/session` 下传。
 *
 * 平台侧模型值统一是 `provider/模型 id`，而宿主只有 `/model` 端点会拆 `provider/model`——
 * `/session`（建/恢复会话）不拆，provider 前缀会被当成模型名的一部分。故走 `/session` 的
 * 两处调用点（runner 首轮建会话、board 卡片起会话）必须先经本函数拆开。
 *
 * 无前缀的存量值/裸模型名（如 `deepseek-flash`）返回 `provider=''`；空串原样返回
 * `['', '']`。对齐 `split_model`（Python 的 `partition('/')`）。
 *
 * @param {string} model
 * @returns {[string, string]}
 */
export function splitModel(model) {
  const s = String(model ?? '').trim();
  const idx = s.indexOf('/');
  if (idx > 0 && idx < s.length - 1) return [s.slice(0, idx), s.slice(idx + 1)];
  return ['', s];
}

/**
 * 校验 `/session`（建/恢复会话）回执并取出 session_id——**写路径不宽容**（评审 P7）。
 *
 * 为什么不能像读口那样宽容：Python 是 `_request(...)["session_id"]` **直接下标**，键缺失即抛
 * KeyError（响亮失败）；Node 若返回 `undefined`，这个假 sid 会一路传进 M4/M5（写库、拼进下一个
 * 请求体、当成会话标识做 cache key），表现为「看起来成功、后续行为错乱」。
 *
 * 判定比 Python 再收紧一格：除「键缺失/响应不是对象」外，`null`/空串/非字符串同样拒绝
 * （Python 只挡键缺失，空值会照样返回给调用方——那是同一类故障的下游放大器）。
 *
 * @param {unknown} resp `/session` 的 JSON 响应
 * @returns {string} 非空 session_id
 * @throws {DshDriverError} code `-2`，消息「驱动响应缺少 session_id」
 */
function requireSessionId(resp) {
  const sid = resp !== null && typeof resp === 'object' ? resp.session_id : undefined;
  if (typeof sid !== 'string' || sid === '') {
    throw new DshDriverError(-2, '驱动响应缺少 session_id');
  }
  return sid;
}

/**
 * 新建常驻会话（sid 由插件生成并回执），返回 session_id。
 *
 * 回执缺 `session_id` ⇒ 抛 `DshDriverError(-2, '驱动响应缺少 session_id')`（对齐 Python 直接
 * 下标取键的 KeyError：写路径绝不返回 `undefined` 假 sid）。
 *
 * @param {string} cwd 会话工作目录
 * @param {string} [task] 平台侧标识（任务 id / 卡 id，仅展示与日志）
 * @param {string} [model] 裸模型 id（`provider/model` 需先经 `splitModel`）
 * @param {string} [provider]
 * @returns {Promise<string>}
 */
export async function createSession(cwd, task = '', model = '', provider = '') {
  const payload = { cwd: cwd ?? '', task: task ?? '' };
  if (model) payload.model = model;
  if (provider) payload.provider = provider;
  return requireSessionId(await request('POST', '/session', payload));
}

/**
 * 恢复已持久化会话（消灭「headless 无 resume、每轮独立会话」），返回 session_id。
 *
 * 回执校验同 `createSession`（缺 `session_id` 抛 `DshDriverError(-2, …)`）。
 *
 * @param {string} sessionId
 * @param {string} [task]
 * @param {string} [cwd]
 * @param {string} [model]
 * @param {string} [provider]
 * @returns {Promise<string>}
 */
export async function resumeSession(sessionId, task = '', cwd = '', model = '', provider = '') {
  const payload = { session_id: sessionId, task: task ?? '', cwd: cwd ?? '' };
  if (model) payload.model = model;
  if (provider) payload.provider = provider;
  return requireSessionId(await request('POST', '/session', payload));
}

/**
 * 有 sid 则恢复、无则新建的统一入口（runner 首轮/续轮同一出口）。
 *
 * 两条回落链语义不变（有 sid ⇒ `resumeSession`，空 sid ⇒ `createSession`），`session_id`
 * 校验只在最终拿到 `/session` 回执时发生（见 `requireSessionId`）。
 *
 * @param {string} sessionId 空串/空值走新建分支
 * @param {string} cwd
 * @param {string} [task]
 * @param {string} [model]
 * @param {string} [provider]
 * @returns {Promise<string>}
 */
export async function ensureSession(sessionId, cwd, task = '', model = '', provider = '') {
  if (sessionId) return resumeSession(sessionId, task, cwd, model, provider);
  return createSession(cwd, task, model, provider);
}

/**
 * 投递一轮提示词（followup，立刻返回；轮次结束由 SSE 的 turn/end 帧判定）。
 * @param {string} sessionId
 * @param {string} text
 */
export async function prompt(sessionId, text) {
  return request('POST', '/prompt', { session_id: sessionId, prompt: text });
}

/**
 * 运行中插话（steer 到最近 step 边界；空闲则直接起一轮）。
 * @param {string} sessionId
 * @param {string} text
 */
export async function steer(sessionId, text) {
  return request('POST', '/steer', { session_id: sessionId, prompt: text });
}

/**
 * 优雅中断当前 turn（保留已流式交付的文本；keepInbox 连排队项一起保留）。
 * @param {string} sessionId
 * @param {boolean} [keepInbox]
 */
export async function cancel(sessionId, keepInbox = false) {
  return request('POST', '/cancel', { session_id: sessionId, keep_inbox: Boolean(keepInbox) });
}

/**
 * 释放常驻会话（停轮次 + 移出 registry/会话存储）。
 * @param {string} sessionId
 */
export async function dispose(sessionId) {
  return request('POST', '/dispose', { session_id: sessionId }, DISPOSE_TIMEOUT_MS);
}

/**
 * 触发宿主侧压缩（插件走 `/compact` 命令）。触发即返回（压缩在 dsh 进程内异步进行，
 * 要过一次模型）；真正的失败只落宿主日志——平台侧 compact 语义本就是「发起」。
 * @param {string} sessionId
 */
export async function compact(sessionId) {
  return request('POST', '/compact', { session_id: sessionId });
}

/**
 * 完整复制会话为新会话（宿主 `sessionController.fork`）。
 *
 * `atSeq` 给定时按该事件 seq 精确切分（缺省＝最近一个完整 turn 的前缀）；0/空值视为缺省
 * （对齐 Python 的 `if at_seq:`）。返回 `{new_session_id}`——新会话**不在**驱动池里：平台把
 * 它绑到卡片/任务后，下一轮 `/session` 带该 sid 走 resume 自然接进池。
 *
 * @param {string} sessionId
 * @param {number|null} [atSeq]
 */
export async function fork(sessionId, atSeq = null) {
  const payload = { session_id: sessionId };
  if (atSeq) payload.at_seq = Math.trunc(Number(atSeq));
  return request('POST', '/fork', payload, FORK_TIMEOUT_MS);
}

/**
 * 改会话标题（与 dsh 侧栏同一份标题）。返回 `{title, [external]}`——`title` 是**宿主接受值**
 * （可能被规范化/按 UTF-8 字节预算截断），调用方据此回写卡面可保证两侧逐字一致。
 *
 * `timeoutMs` 可缩短：卡面改名是 best-effort 的同步链路（`PATCH /board/cards/<cid>`），
 * 不能让驱动侧僵死把 HTTP worker 拖满默认 120s。
 *
 * @param {string} sessionId
 * @param {string} title
 * @param {{timeoutMs?: number}} [opts]
 */
export async function rename(sessionId, title, { timeoutMs = REQUEST_TIMEOUT * 1000 } = {}) {
  return request('POST', '/rename', { session_id: sessionId, title }, timeoutMs);
}

/**
 * 会话级模型切换（宿主 `sessionController.selectModel`）。
 *
 * `model` 支持 `provider/model` 写法（拆分在插件侧）；只给模型名时由插件沿用该 agent 当前的
 * provider。`model` 为空而 `reasoningEffort` 非空＝**只改思考等级**（插件从会话当前模型选择
 * 回读 provider/model）。返回 `{selected: {provider, model, reasoningEffort?}}`。
 *
 * @param {string} sessionId
 * @param {string} model
 * @param {string} [provider]
 * @param {string} [reasoningEffort]
 */
export async function setModel(sessionId, model, provider = '', reasoningEffort = '') {
  const payload = { session_id: sessionId, model };
  if (provider) payload.provider = provider;
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  return request('POST', '/model', payload, MODEL_TIMEOUT_MS);
}

// ---------- 审批代答 + 权限 preset ----------

/**
 * 旧平台三档 → 宿主 preset 的**兼容别名**（只用于旧库/旧请求的写入归一，不再是平台档位集合）。
 *
 * - `manual`（逐条确认）语义近似 workspace-write（sandbox=workspace-write + approval=ask；
 *   平台随即接管该会话审批代答）；
 * - `yolo`（自动通过）语义近似 danger-full-access（approval=never）。
 *
 * `auto` **不在别名表里**：DSH 宿主的 auto 是独立实验档（完全权限底座 + 逐调用模型审查），
 * 与旧平台「完全自主」并非同一物；旧 auto 语义已由 2026-10-21 数据迁移并入
 * danger-full-access，此后只有宿主目录里确实列出 auto 时才接受该值。
 *
 * 定义收在驱动模块：server/board/runner 起会话与校验都要做同一份归一。
 */
export const LEGACY_PERMISSION_ALIASES = Object.freeze({
  manual: 'workspace-write',
  yolo: 'danger-full-access',
});

/** 内置三档的中文产品名（与 DSH 客户端 `displayPermissionPreset` 同规则） */
export const BUILTIN_PERMISSION_LABELS_ZH = Object.freeze({
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: '自动审查（实验）',
});

/** 内置三档的英文默认名（镜像 DSH 客户端 `DEFAULT_PRESET_LABELS`；用于识别宿主上报的英文名） */
export const BUILTIN_PERMISSION_LABELS_EN = Object.freeze({
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full access',
});

/** 内置档/auto 的描述（TS 侧补充：DSH 下拉不显示描述；宿主给了 description 时宿主优先） */
export const BUILTIN_PERMISSION_DESCRIPTIONS = Object.freeze({
  'read-only': '只读运行；所有修改动作都需要审批。',
  'workspace-write': '可修改工作区与允许的临时目录；更宽的操作需要审批。',
  'danger-full-access': '不受沙箱限制，也不再弹审批。',
  auto: '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。',
});

/** kebab-case preset 名判据（DSH 下拉对自定义档名做 Title-Case 展示） */
export const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 逐词首字母大写（`some-preset` → `Some Preset`；镜像 DSH 客户端的 Title-Case 规则） */
function titleCaseWords(text) {
  return String(text).split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * 权限目录选项归一（纯函数，契约 §3；Python `permission_option` 的同义实现）。
 *
 * 返回 `{value, label, description}`；`value` 去空白后为空 ⇒ `{}`（调用方过滤）。
 *
 * label 规则（顺序敏感）：
 *   ① `value === 'auto'` ⇒ 中文产品名「自动审查（实验）」（DSH 客户端对 auto 恒用产品名）；
 *   ② 内置三档且 `name` ∈ {value, 英文默认名} ⇒ 对应中文产品名（宿主上报的 name 就是
 *      machine value，中文名由展示层映射）；
 *   ③ 否则 `name` 匹配 kebab ⇒ 逐词 Title-Case（镜像 DSH）；非 kebab ⇒ 原样用 name。
 * description：宿主给了就用宿主的；否则回退内置描述。
 *
 * 不认识的 value 也照常返回（label 走 name/Title-Case 规则），不报错 —— 宿主目录是唯一真源。
 *
 * @param {unknown} value 宿主 preset key
 * @param {unknown} [name] 宿主上报的显示名
 * @param {unknown} [description] 宿主上报的描述
 * @returns {{value: string, label: string, description: string}|{}}
 */
export function permissionOption(value, name = '', description = '') {
  const v = String(value ?? '').trim();
  if (!v) return {};
  // 契约：name = str(name or "")，空值回落 value（不 strip：kebab 判定按原样）
  const n = name ? String(name) : v;
  const desc = description ? String(description) : '';
  let label;
  if (v === 'auto') {
    // DSH 客户端对 auto 恒用产品名（宿主 name 即使是别的也不采）
    label = BUILTIN_PERMISSION_LABELS_ZH.auto;
  } else if (lookupOwn(BUILTIN_PERMISSION_LABELS_ZH, v)
      && (n === v || n === lookupOwn(BUILTIN_PERMISSION_LABELS_EN, v))) {
    label = BUILTIN_PERMISSION_LABELS_ZH[v];
  } else if (KEBAB_RE.test(n)) {
    label = titleCaseWords(n);
  } else {
    label = n;
  }
  return {
    value: v,
    label,
    description: desc || lookupOwn(BUILTIN_PERMISSION_DESCRIPTIONS, v),
  };
}

/** 思考等级（dsh 宿主 reasoningEffort）合法取值：pi-ai 的 ModelThinkingLevel 全集 */
export const EFFORT_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

/** 归档端点「会话不存在」的独立状态码（插件侧 `WorkspaceUnknownSessionError` 映射） */
export const ARCHIVE_UNKNOWN_SESSION = 410;
/** 旧插件没有 `/watch` 端点时的状态码（未知驱动端点，见插件 `_serve` 的兜底 404） */
export const WATCH_UNSUPPORTED = 404;

/** 取映射值（自身属性才认；挡下 `toString` 这类原型键，对齐 Python dict.get 的缺失语义） */
function lookupOwn(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
}

/** Python `repr()` 的字符串近似（日志文案里 `'manual'` 的单引号形态） */
function reprText(value) {
  return `'${String(value)}'`;
}

/**
 * 应答会话挂起的**审批**（宿主 `approval/request` waterfall 代答）。
 *
 * 前提：插件已认领该会话的审批（`POST /permission` 接管过，`/status.approval_held=true`），
 * 否则审批由 dsh GUI 作答，这里返回 409。`decision` 用 dsh 原生度：`allowed-once` /
 * `rejected` / `cancelled`。`approvalId` 取自 interaction 标记的 `id`（插件自生成 `ap-<n>`）。
 * 返回 `{outcome}`。
 *
 * @param {string} sessionId
 * @param {string} approvalId
 * @param {string} decision
 */
export async function answerApproval(sessionId, approvalId, decision) {
  return request('POST', '/approval', {
    session_id: sessionId, approval_id: approvalId, decision,
  }, SHORT_TIMEOUT_MS);
}

/**
 * 切换会话权限 preset（宿主 `permissionPresets.set`）并**把该会话的审批交给平台**。
 *
 * preset 名来自 `/presets` 的 options[].value（宿主目录是唯一真源，可为 path-rules 等自定义档）。
 * preset 的 approval=ask 时平台必须用 `answerApproval` 作答（插件据此认领 waterfall）；never 时
 * 瀑布不会被调用。
 *
 * `mode`（可选）＝旧平台三档 manual/yolo/auto：**2026-10-21 权限档对齐后平台不再传**（平台值
 * 就是 preset key，不再有多对一的档位需要额外记）；形参保留只为兼容旧调用方/旧测试。
 *
 * @param {string} sessionId
 * @param {string} preset 宿主 preset 名
 * @param {string|null} [mode] 旧平台三档（本批平台不再传）
 */
export async function setPermission(sessionId, preset, mode = null) {
  const body = { session_id: sessionId, preset };
  if (mode) body.mode = mode;
  return request('POST', '/permission', body, SHORT_TIMEOUT_MS);
}

/**
 * 回答会话挂起的提问（dsh 原生格式）。
 *
 * `answers` 为 `[{id: 题 id, selected: [选项标签…], custom: 自由文本}]`——插件侧转成
 * `ctx.userQuestions.answer(agent, callId, {answers})`，即 Web GUI 同一条作答通道。
 * `callId` 取自 `/live` 或 `/status` 的 interaction.call_id。返回布尔受理结果
 * （false = 问题已不存在/已答）。
 *
 * @param {string} sessionId
 * @param {string} callId
 * @param {object[]} answers
 * @returns {Promise<boolean>}
 */
export async function answerQuestion(sessionId, callId, answers) {
  const resp = await request('POST', '/answer', {
    session_id: sessionId, call_id: callId, answers,
  }, SHORT_TIMEOUT_MS);
  return Boolean(resp && resp.accepted);
}

// ---------- 会话归档 ----------

/**
 * 归档 / 取消归档一个会话（驱动 `POST /archive`，两条都幂等）。
 *
 * - `archived=true`：宿主归档该会话（`stopActivity: true`——平台拖入「已完成」时刚发过
 *   abort，异步生效前宿主可能仍认为有在跑的工作，带此开关避免竞态拒绝）；
 * - `archived=false`：取消归档（不校验会话是否存在，幂等）。
 *
 * 失败语义：会话不存在抛 `DshDriverError(ARCHIVE_UNKNOWN_SESSION, …)`（调用方按「无同步
 * 对象」跳过）；其余 HTTP/传输错误原样抛（调用方按硬失败回滚卡片列）。
 *
 * @param {string} sessionId
 * @param {boolean} [archived]
 * @param {{timeoutMs?: number}} [opts]
 */
export async function archive(sessionId, archived = true, { timeoutMs = SHORT_TIMEOUT_MS } = {}) {
  return request('POST', '/archive', {
    session_id: sessionId, archived: Boolean(archived),
  }, timeoutMs);
}

/**
 * 取消归档（`archive(sid, false)` 的同义封装，读侧语义更直白）。
 * @param {string} sessionId
 * @param {{timeoutMs?: number}} [opts]
 */
export async function unarchive(sessionId, opts = {}) {
  return archive(sessionId, false, opts);
}

// ---------- 看管声明（外部会话投递通道） ----------

/**
 * 声明 / 撤销「平台看管该会话」（驱动 `POST /watch`，幂等）。返回看管是否生效。
 *
 * 为什么需要：外部会话（用户在 dsh GUI 里直跑/接管、`/live` 里 `owned:false`）既不在驱动
 * 池、也没有平台持有者，驱动侧不可能靠「在不在池内」推断平台是否有意投递——**范围必须由
 * 平台显式划定**。平台只对确实要投递的会话声明看管；驱动据此放行 `/prompt`·`/steer`·
 * `/answer`·`/approval` 的池外分支。
 *
 * 幂等：回执给的是 `watched` 的**当前实际状态**（而非「这次有没有改动」），故本函数返回
 * `Boolean(resp.watched)`——调用方按「true 才算声明成功」处置。`on=false` 撤销。
 *
 * 失败语义：**异常照抛**（`DshDriverError`：旧插件 404 / 驱动不可达 / 令牌错），
 * 「是否吞异常降级」由调用方决定。
 *
 * @param {string} sessionId
 * @param {boolean} [on]
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function watchSession(sessionId, on = true, { timeoutMs = WATCH_TIMEOUT_MS } = {}) {
  const resp = await request('POST', '/watch', {
    session_id: sessionId, on: Boolean(on),
  }, timeoutMs);
  return Boolean(resp && resp.watched);
}

// ---------- 项目级默认值下发 ----------

/**
 * 把项目级默认（思考等级 / 权限档）应用到刚建或刚续的会话上（best-effort）。
 *
 * 起会话路径（board 起卡 / runner 起轮 / feishu 新建会话）在 create/resume 之后调本函数：
 * 项目里配了默认值就下发，没配就什么都不做（沿用宿主默认）。
 *
 * 为什么走 `/model`（selectModel）而不是建会话时塞 agentOptions：宿主对 reasoningEffort 的
 * 校验发生在**请求装配**时（模型不支持的档位直接抛 UNSUPPORTED_REASONING_EFFORT）——塞进
 * agentOptions 会让「档位与模型不匹配」变成整轮失败；走 `/model` 则同步返回错误，这里捕获后
 * 只记一行告警，会话照常跑（不因一个配置错误起不来）。
 *
 * **best-effort**：捕获 `DshDriverError`（Python 侧只捕这一类）并收集告警文本；返回告警列表
 * （空数组＝全部成功或无需应用）。调用方把告警写进会话日志。
 *
 * @param {string} sessionId
 * @param {string} [model] 会话当前模型（可为空：档位不变、仅改思考等级时由插件回读）
 * @param {string} [provider]
 * @param {string} [reasoningEffort] 空=不改；非 `EFFORT_LEVELS` 之一直接告警跳过
 * @param {string} [permissionMode] 权限档：宿主 preset key（兼容旧档 manual/yolo 别名），空=不改
 * @param {((text: string) => void)|null} [log] 可选日志回调，逐条即时落日志
 * @returns {Promise<string[]>} 告警文本列表（每条自带 `### ` 前缀与换行，与 Python 逐字同）
 */
export async function applySessionDefaults(sessionId, model = '', provider = '',
  reasoningEffort = '', permissionMode = '', log = null) {
  const warns = [];
  const warn = (text) => {
    warns.push(text);
    if (typeof log === 'function') {
      try {
        log(text);
      } catch {
        // 日志失败绝不影响起会话
      }
    }
  };
  if (permissionMode) {
    // 2026-10-21：项目里存的就是宿主 preset key（可能 manual/yolo 旧别名）⇒ 归一后
    // **直接下发 preset**，不再带旧三档 mode（宿主 auto 档原样下发）。
    // 与 Python 逐字同：先 strip，告警/失败文案用的是 strip 后的值。
    const value = String(permissionMode).trim();
    const preset = lookupOwn(LEGACY_PERMISSION_ALIASES, value) || value;
    if (!preset) {
      warn(`### 项目权限档 ${reprText(value)} 非法，已跳过（会话沿用宿主默认）\n`);
    } else {
      try {
        await setPermission(sessionId, preset);
      } catch (error) {
        if (error instanceof DshDriverError) {
          warn(`### 项目权限档 ${value} 未生效：${error.message}\n`);
        } else {
          throw error;
        }
      }
    }
  }
  if (reasoningEffort) {
    if (!EFFORT_LEVELS.includes(reasoningEffort)) {
      warn(`### 项目思考等级 ${reprText(reasoningEffort)} 非法，已跳过`
        + `（合法值：${EFFORT_LEVELS.join('/')}）\n`);
    } else {
      try {
        await setModel(sessionId, model, provider, reasoningEffort);
      } catch (error) {
        if (error instanceof DshDriverError) {
          warn(`### 项目思考等级 ${reasoningEffort} 未生效：${error.message}\n`);
        } else {
          throw error;
        }
      }
    }
  }
  return warns;
}

// ---------- 事件流（SSE；消费本体在 sse.js） ----------

/** 判定「本轮的 turn 结束」的帧类型 */
export const TURN_END = 'turn/end';
/** 判定「会话进入等人工输入（提问/审批）」的帧类型 */
export const INTERACTION = 'driver/interaction';

/**
 * `turn/end` 的 reason.kind → 平台轮次退出码（与旧 kimi_web 口径对齐）。
 * @param {string|null|undefined} reason
 * @returns {number} completed→0 / aborted→130 / 其他（含 null）→1
 */
export function turnExitCode(reason) {
  if (reason === 'completed') return 0;
  if (reason === 'aborted') return 130;
  return 1;
}

/**
 * 把 `stop` 归一成 `() => boolean`（对齐 Python 的 `stop()` 真值判定）：
 * 回调按真值收（`Boolean(stop())`）；AbortSignal 按其 `aborted` 收；其余 ⇒ 无停止探测。
 *
 * @param {(() => any)|AbortSignal|null|undefined} stop
 * @returns {(() => boolean)|null}
 */
function stopProbe(stop) {
  if (typeof stop === 'function') return () => Boolean(stop());
  if (stop !== null && typeof stop === 'object' && typeof stop.aborted === 'boolean') {
    return () => stop.aborted === true;
  }
  return null;
}

/**
 * **真** `AbortSignal` 的判据：`sse.js` 要对它 `addEventListener('abort', …)`，
 * 鸭子类型的普通对象（`{aborted: false}`）**不是** EventTarget。
 *
 * 这条判据是 2026-10-14 M6.5-R3 抓到的真缺陷的修复（当时现场：把 `{aborted:false}` 当停止信号
 * 传给 `feedInto`，整轮以 `### 事件流异常: signal.addEventListener is not a function` 收口、
 * 轮次被判失败）。原先这里与 `stopProbe` 共用「`typeof stop.aborted === 'boolean'`」这同一条松判据
 * ⇒ 普通对象被塞进 `fetch(..., {signal})`，而 `fetch`/`sse` 只认真 EventTarget。
 * 归一后的契约：**函数**与**鸭子 `{aborted}`** 都只当「停止探针」；只有真 AbortSignal 才额外
 * 充当立即中断信号。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isAbortSignal(value) {
  return value !== null && typeof value === 'object'
    && typeof value.addEventListener === 'function';
}

/**
 * SSE 消费的公共壳：拼请求头（驱动令牌 + `text/event-stream`）并把 `SseError` 翻译成
 * `DshDriverError`（Python 侧这一层本来就只有 `DshDriverError` 一种错误）。
 *
 * @param {string} url
 * @param {(frame: object) => void} onFrame
 * @param {object} opts
 * @returns {Promise<{frames:number,lastSeq:number,stopped:boolean}>}
 */
async function consumeEvents(url, onFrame, { since, stop, idleTimeoutMs, signal, fetchImpl }) {
  const opts = {
    headers: { ...authHeaders(), accept: 'text/event-stream' },
    since: toSeq(since),
    idleTimeoutMs,
  };
  if (typeof onFrame === 'function') opts.onFrame = onFrame;
  const probe = stopProbe(stop);
  if (probe) opts.stop = probe;
  if (isAbortSignal(stop)) {
    opts.signal = stop;                       // AbortSignal：立即中断（比 250ms 轮询更快）
  }
  if (signal) opts.signal = signal;
  if (fetchImpl) opts.fetchImpl = fetchImpl;
  try {
    return await streamEvents(url, opts);
  } catch (error) {
    if (error instanceof SseError) throw new DshDriverError(error.code, error.message);
    throw error;
  }
}

/**
 * 订阅**会话事件流**（阻塞直到 stop() 为真、链路结束或空闲超时）。
 *
 * - `onFrame(frame)`：每收到一帧调用一次（调用方在此落日志/唤醒等待者）；
 * - `stop`：可选回调（真值即主动断开，用于任务停止/超时收口）或 AbortSignal；
 * - `since`：从该 seq 之后开始（会话池 ring 补发），避免重连后重复消费历史帧；
 * - `idleTimeoutMs`：超过该时长没有任何字节（含 keepalive 注释）判定链路僵死并抛错。
 *
 * 返回 `{frames, lastSeq, stopped}`（Python 是 `(帧数, 最后 seq)` 二元组 + 主动断开不抛）。
 * 链路断开/超时抛 `DshDriverError`。
 *
 * @param {string} sessionId
 * @param {(frame: object) => void} onFrame
 * @param {{since?: number, stop?: any, idleTimeoutMs?: number, signal?: AbortSignal,
 *          fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{frames:number,lastSeq:number,stopped:boolean}>}
 */
export async function stream(sessionId, onFrame, {
  since = 0,
  stop = null,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT * 1000,
  signal = undefined,
  fetchImpl = undefined,
} = {}) {
  if (!configured()) throw new DshDriverError(-1, UNCONFIGURED_MESSAGE);
  splitDriverUrl();                           // 地址口径校验（对齐 Python 先 _split_url）
  const url = sseUrl(driverUrl(), '/events', {
    session_id: String(sessionId ?? ''),
    since: toSeq(since),
  });
  return consumeEvents(url, onFrame, { since, stop, idleTimeoutMs, signal, fetchImpl });
}

/**
 * 订阅**全局状态流**（`?scope=state`，P4 事件化；dshevents.EventHub 的唯一连接）。
 *
 * 帧形 `{seq, time, type, session_id, data}`，type ∈ `session/created|disposed`、
 * `driver/attached|detached`、`agent/status`、`turn/start|end`、`driver/interaction`。
 * 语义与 `stream()` 一致（since 续传、stop 主动断开、空闲超时判僵死）。
 *
 * 接口冻结（`dshevents.js` 会 import）：`stateStream(onFrame, {since, stop, idleTimeoutMs})`。
 *
 * @param {(frame: object) => void} onFrame
 * @param {{since?: number, stop?: any, idleTimeoutMs?: number, signal?: AbortSignal,
 *          fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{frames:number,lastSeq:number,stopped:boolean}>}
 */
export async function stateStream(onFrame, {
  since = 0,
  stop = null,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT * 1000,
  signal = undefined,
  fetchImpl = undefined,
} = {}) {
  if (!configured()) throw new DshDriverError(-1, UNCONFIGURED_MESSAGE);
  splitDriverUrl();
  const url = sseUrl(driverUrl(), '/events', { scope: 'state', since: toSeq(since) });
  return consumeEvents(url, onFrame, { since, stop, idleTimeoutMs, signal, fetchImpl });
}

/**
 * SSE 订阅体（runner / chat / board 共用）：把事件帧喂给 `TurnWaiter`。
 *
 * `onFrame` 为可选的额外处理（如 runner 把帧翻译成轮次日志行）；它抛异常不影响等待线程
 * ——日志写失败绝不能让轮次收口逻辑失联。链路异常在未主动断开时经 `waiter.fail()` 上抛
 * （等待方据此收口，而不是无限等）。
 *
 * 返回：正常收尾给流结果 `{frames,lastSeq,stopped}`，链路异常给 `null`（Python 无返回值，
 * 调用方一律忽略返回值，这里只多给一份可诊断信息）。
 *
 * @param {string} sessionId
 * @param {number} since
 * @param {TurnWaiter} waiter
 * @param {(() => any)|AbortSignal|null} stop
 * @param {((frame: object) => void)|null} [onFrame]
 * @returns {Promise<{frames:number,lastSeq:number,stopped:boolean}|null>}
 */
export async function feedInto(sessionId, since, waiter, stop, onFrame = null) {
  const handle = (frame) => {
    if (typeof onFrame === 'function') {
      try {
        onFrame(frame);
      } catch {
        // 落日志失败不致命：等待线程照常推进
      }
    }
    waiter.feed(frame);
  };
  try {
    return await stream(sessionId, handle, { since, stop });
  } catch (error) {
    const probe = stopProbe(stop);
    if (probe === null || !probe()) waiter.fail(String((error && error.message) || error));
    return null;
  }
}

// ---------- 轮次等待 ----------

/**
 * 一轮的事件收集器：在 SSE 回调里落日志、抓 `turn/end`、记录挂起交互。
 *
 * **形态差异（与 Python 唯一必要的一处）**：Python 用 `threading.Condition` 做阻塞等待
 * （`feed()` 由 SSE 线程调、`wait_turn()` 由轮次主线程调）；Node 是单线程事件循环，没有
 * 「另一个线程」可阻塞，故改为 **Promise 式**：
 *   - `feed(frame)` / `fail(message)` 同步更新状态并 settle 挂起的 `wait()`；
 *   - `wait(timeoutMs)` 返回 `Promise<'turn_end'|'interaction'|'error'|'timeout'>`。
 *
 * 语义逐条保留（与 Python `wait_turn` 同）：
 *   - 判定优先级 `exitCode → error → interaction`（有结论先返结论，链路错误优先于挂起交互）；
 *   - `interaction` 是 **consume-on-read**：返回 `'interaction'` 后即清零，调用方要么据此
 *     让位、要么记一行日志后继续等（同一轮内可能多次提问）；
 *   - `'timeout'` 只表示本地等待窗口到期（不代表远端异常）——超时后状态保留，可再次 `wait()`；
 *   - 多个并发等待者被同一次 `feed()` 唤醒时各自按当前状态取结论（interaction 只被一个取走）。
 *
 * 字段：`started`（是否见过 turn/start）、`exitCode`、`turnReason`、`interaction`、`error`。
 */
export class TurnWaiter {
  constructor() {
    this.started = false;                 // 是否见过 turn/start（判定「turn 压根没起来」）
    this.exitCode = null;                 // turn/end 换算出的退出码（null = 尚无结论）
    this.turnReason = null;
    this.interaction = null;              // 挂起等作答实况（consume-on-read：读后清零）
    this.error = null;                    // SSE 链路错误
    this._waiters = new Set();            // 挂起的 {resolve, timer}
  }

  /**
   * 处理一帧：更新状态（turn/start、turn/end、driver/interaction）并唤醒等待者。
   * @param {object} frame SSE 帧 `{seq, time, type, session_id, data}`
   */
  feed(frame) {
    const type = frame ? frame.type : undefined;
    if (type === 'turn/start') {
      this.started = true;
    } else if (type === TURN_END) {
      // dsh 的 cancel 落盘 reason=**null**（插件已按 aborted 归一）；装机副本可能是旧版，
      // null/缺失直落会让「用户主动中断」被判轮次失败（turnExitCode(null)=1）⇒ 这里兜底。
      const raw = (frame.data || {}).reason;
      let reason = raw !== null && typeof raw === 'object' ? raw.kind : raw;
      if (reason === undefined || reason === null) reason = 'aborted';
      this.turnReason = reason;
      this.exitCode = turnExitCode(reason);
    } else if (type === INTERACTION) {
      const data = frame.data || {};
      if (data.state === 'asked') {
        this.interaction = data.interaction;
        this.started = true;            // 提问意味着 turn 已在跑
      }
    }
    this._wake();
  }

  /**
   * 链路异常：落错误并唤醒等待者（`wait()` 返回 `'error'`）。
   * @param {string} message
   */
  fail(message) {
    this.error = message;
    this._wake();
  }

  /**
   * 等本轮结论，返回 `'turn_end' | 'interaction' | 'error' | 'timeout'`。
   *
   * @param {number|null} [timeoutMs] 本地等待窗口（毫秒）；null/省略 = 一直等（只可能被
   *   feed/fail 唤醒）。到期时先复核状态再判超时（对齐 Python「先查结论、再查剩余时间」）。
   * @returns {Promise<'turn_end'|'interaction'|'error'|'timeout'>}
   */
  wait(timeoutMs = null) {
    const immediate = this._take();
    if (immediate !== null) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          const value = this._take();
          this._settle(entry, value === null ? 'timeout' : value);
        }, Math.max(0, timeoutMs));
      }
      this._waiters.add(entry);
    });
  }

  /** 取当前可用的结论（按 exitCode → error → interaction 优先级；interaction 读后清零） */
  _take() {
    if (this.exitCode !== null) return 'turn_end';
    if (this.error) return 'error';
    if (this.interaction !== null) {
      this.interaction = null;
      return 'interaction';
    }
    return null;
  }

  /** 状态变化后：把已有结论发给每一个挂起的等待者（无结论的继续等自己的超时） */
  _wake() {
    if (this._waiters.size === 0) return;
    for (const entry of [...this._waiters]) {
      const value = this._take();
      if (value !== null) this._settle(entry, value);
    }
  }

  /** 结算一个等待者（幂等：定时器与 feed 同时到达时只有先到者生效） */
  _settle(entry, value) {
    if (!this._waiters.delete(entry)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(value);
  }
}
