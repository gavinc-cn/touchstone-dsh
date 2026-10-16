/**
 * Touchstone session 解析层（Node 版）：`sessparse.py`（838 行）的逐字等价移植。
 *
 * 职责与 Python 侧完全一致：定位并解析 dsh（deepseek harness）会话存储
 * （`~/.dsh/sessions/<bucket>/<sid>/session[.v<N>].jsonl.zstd`，多帧 zstd 事件流），
 * 统一输出 entry 模型供 session 对话窗口渲染；另提供标题 / 首问 / 会话枚举 / 存在性
 * / 运行中会话探测 / 回退锚点等读口。
 *
 * **移植口径（为什么逐条对齐而不是「写个等价的」）**
 * - 这是双轨共存期（方案 §五）的读路径：Python 与 Node 两版同时跑，对拍器逐字段比。
 *   任何「顺手优化」都会变成对拍差异，故本文件**函数名、边界条件、缓存键、字段序**
 *   一律照抄 Python，连 `_trunc` 的码点口径、`_obj` 的坏 JSON 容错都一样。
 * - 与 Python 的**语义差异只有三处**（都在下方各自位置注明）：
 *   ① JS 字符串按 UTF-16 码元索引/计数，Python 按码点 ⇒ 截断与长度用码点扫描实现；
 *   ② Python 的 `str.strip()` 空白集 ≠ JS `trim()`（BOM / \x1c-\x1f / \x85）⇒ 自实现 `pyStrip`；
 *   ③ Python 的 `dict.get` 在非 dict 上抛 AttributeError（读口的 `except (OSError, ValueError)`
 *      **不吞**）⇒ `dget`/`orDict` 在非 dict 上抛 `PyTypeError`，由调用方按同一口径决定吞不吞。
 * - **zstd 解压**用已交付的 `backend/lib/zstd-frames.js`（多帧扫描 + 逐帧解压，`node:zlib`
 *   只解单帧）——那正是本模块的地基，不在这里重复实现（方案 R1b）。
 * - Python 侧 `_DEC_TLS`（每线程一个 `ZstdDecompressor`）是 SIGSEGV 的历史修复：Node 的
 *   `zstdDecompressSync` 是同步单线程调用，**没有**共享可变解压器对象，故本版无对应物。
 *
 * 已知且**有意保留**的边界差异（真会话文件里不会出现，仅记录以免被当成 bug 改）：
 * - JSON 数值：Python 区分 int/float（`1.0` 不算整数 token 计数），JS 统一是 number；
 *   超出 2^53 的整数（`seq`/`time` 不会这么大）会丢精度。
 * - `json.loads` 接受裸 `NaN`/`Infinity`，`JSON.parse` 拒绝（→ 该行按坏行跳过）。
 * - skippable zstd 帧：**两侧同口径跳过**（Python `decompressobj` 与 Node 扫描器都按 RFC 8878
 *   跳过；`tools/parity/zstd-run.mjs` 的 `skippable_middle` 变体实测同为 3 帧 / 67 B）。
 *   真机 464 个会话文件实测**零** skippable 帧。
 * - 路径/字符串比较：`pyStrCompare` 按码点序实现 Python 的 str 比较（仅非 BMP 字符上有别于 JS 码元序）。
 *
 * **半帧内容（曾与 Python 不一致，已在本文件内对齐，未改 `zstd-frames.js`）**：
 * 文件在某个完整帧内部被截断时，Python 的 `decompressobj().decompress()` 会把半帧里
 * **已完整解出的块内容**一并返回；`zstd-frames.decompressSessionFile` 的口径是「扫帧失败即停」，
 * 整个半帧（含已解出部分）都丢。该收尾逻辑已于 2026-10-11 **上移到 `zstd-frames.js`**
 * （`decompressFramePartial`，`finishFlush: Z_NO_FLUSH`），本文件直接调
 * `decompressSessionFile()` —— 六类坏样本实测与 Python 逐字节相等（对拍报告第四节）。
 *
 * **半截帧（头行）**：`_dsh_header` 与 `_dsh_decompressed` 一致地调用 `decompressFramePartial`
 * ——Python 的 `decompressobj()` 在截断处返回部分内容，本版同（真机头行都在第 1 帧第 1 行，
 * 该分支只在「首帧正被写」的窗口里起作用）。
 *
 * 导出面：与 Python 同名（含下划线的内部函数也**照名导出**，供单测与 `tools/parity` 探针
 * 直接调用；业务代码只用公开读口：`load` / `session_title` / `list_sessions` / `session_exists`
 * / `is_subagent` / `live_session_id` / `dsh_first_prompt` / `dsh_fork_boundary` 等）。
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { decompressFramePartial, decompressSessionFile, frameEnd } from './zstd-frames.js';

// ---------------------------------------------------------------- 常量与基础口径

/**
 * dsh 会话存储根（Python：`os.path.expanduser("~/.dsh/sessions")`）。
 * Python 侧是可 monkeypatch 的模块常量；Node 的 ESM 导出绑定不可从外部赋值，
 * 故这里用「内部 let + 读/写函数」：`dshSessionsRoot()` 读、`setSessionsRoot()` 写
 * （仅供单测与 `tools/parity/sess-run.mjs` 的快照目录使用，等价于 Python 测试里的
 * `monkeypatch.setattr(sessparse, "DSH_SESSIONS", …)`）。
 */
let DSH_SESSIONS = path.join(homedir(), '.dsh', 'sessions');

/** 当前会话存储根（默认 `~/.dsh/sessions`）。 */
export function dshSessionsRoot() {
  return DSH_SESSIONS;
}

/** 改写会话存储根（测试/对拍专用，绝对值化避免 cwd 参与解析）。 */
export function setSessionsRoot(root) {
  DSH_SESSIONS = path.resolve(String(root));
}

// session id / media id 白名单（防路径穿越）
// dsh 会话 id 为 session-<uuid>（新）或裸 <uuid>（早期/桌面端；目录名即 id）。
// 正则尾部 `\n?$`：Python `re` 的 `$` 匹配「串尾或末尾换行之前」，JS 的 `$` 只匹配串尾，
// 故显式补一个可选换行，保持两版接受集合一致（对齐 `SID_DSH_RE`/`MEDIA_DSH_RE` 的原始写法）。
export const SID_DSH_RE = /^(?:session-)?[0-9a-fA-F-]{8,36}\n?$/;
// dsh 附件 id（宿主 attachment 服务的不透明存储 id；平台只用它向驱动要字节）
export const MEDIA_DSH_RE = /^sha256:[a-f0-9]{64}\n?$/;

export const ARGS_MAX = 2000;    // tool_call args JSON 截断长度
export const OUT_MAX = 4000;     // tool_result 输出截断长度

/** 可解析的会话族白名单（Python 侧是 tuple，此处冻结数组；退场族传入即被拒）。 */
export const FAMILIES = Object.freeze(['dsh']);

/** 解析缓存：Map<sid, Map<agent, {stamp, entries, totals, ctx}>>（Python：`{(sid, agent): …}`）。 */
const _CACHE = new Map();

/** 模拟 Python ValueError（读口的 `except (OSError, ValueError)` 会吞掉它）。 */
class PyValueError extends Error {}

/** 模拟 Python TypeError/AttributeError（读口**不吞**它，与 Python 的 except 子句一致）。 */
class PyTypeError extends Error {}

/**
 * 「预期内的降级原因」白名单（P8 评审）：文件读不到 / 数据坏 / zstd 坏帧 —— 这些在
 * Python 侧本来就走 `except (OSError, ValueError)` 静默降级，Node 侧同样静默。
 */
function isExpectedDegrade(error) {
  if (error instanceof PyValueError) return true;
  // 驱动错误（DshDriverError）：Python 的 `except (…, dshdriver.DshDriverError)` 面，
  // 「附件不存在（404）」是正常路径。鸭子类型判定，避免 sessparse 反向依赖 dshdriver
  // （M3 接线是调用方 `setMediaFetcher(dshdriver.media)` 注入，模块间不 import）
  if (error && error.name === 'DshDriverError') return true;
  const code = error && error.code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR'
    || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG'
    || code === 'ZSTD_error_prefix_unknown' || code === 'ZSTD_error_checksum_wrong'
    || code === 'ZSTD_error_corruption_detected' || code === 'Z_BUF_ERROR';
}

/**
 * 非预期异常先**留痕**再按读口语义降级（P8 评审：`load` 只重抛 PyTypeError、`resolve_media`
 * 裸 catch，会让「接线错了」（如把 async fetcher 塞给同步实现）静默变成 missing/404）。
 * 降级行为不变——只是不再无声：意外异常一律 `console.error('[sessparse] …')`。
 */
function noteDegrade(where, error) {
  if (isExpectedDegrade(error)) return;
  const name = (error && error.name) || 'Error';
  const msg = (error && error.message) || String(error);
  console.error(`[sessparse] ${where} 非预期异常，按读口语义降级：${name}: ${msg}`);
}

/**
 * Python 真值语义：`""`/`0`/`None`/`False`/空容器为假。
 * JS 的 `[]` 与 `{}` 是 truthy，直接用 `Boolean()` 会与 Python 分歧（如 `bool(msg.get("isError"))`）。
 */
function pyTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python `x or y`（真值口径见 `pyTruthy`）。 */
function pyOr(v, fallback) {
  return pyTruthy(v) ? v : fallback;
}

/** Python 的空白字符集（`str.isspace()` 为真的码点；与 JS `trim()` 的差异见模块头）。 */
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');

/**
 * Python `str.strip()`（无参）：只按 Python 的空白集剥两端。
 * 导出仅供单测/对拍（Node 独有助手，非 Python 同名函数）：差集是 `\x1c-\x1f`/`\x85`
 * 只 Python 剥、`\ufeff` 只 JS `trim()` 剥 —— 会话分析全靠它（`_parse_dsh`/`_dsh_header`/首问）。
 */
export function pyStrip(text) {
  return String(text).replace(PY_STRIP_RE, '');
}

/** 该 JSON 值是不是「普通对象」（Python 的 dict；数组/字符串/null/数字都不是）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Python `dict.get(key, default)`：obj 必须是 dict，否则抛异常。
 *
 * 为什么较真：会话存储是**外部输入**，`data.get("source")` 的 `source` 若是个字符串，
 * Python 会抛 AttributeError 一路冒到读口（`load` 的 except 只吞 OSError/ValueError），
 * 而 JS 里 `"abc".source` 只是 undefined ⇒ 静默继续。让 `dget` 在非 dict 上抛
 * `PyTypeError`，就把「坏输入」的表现对齐了。JSON 解析结果里不存在 undefined 值，
 * 故「键缺失」⟺ Python 的 None。
 */
function dget(obj, key, fallback = null) {
  if (!isPlainObject(obj)) throw new PyTypeError(`对非 dict 取键 "${key}"`);
  const v = obj[key];
  return v === undefined ? fallback : v;
}

/** Python `(x or {})`：假值→`{}`；真值但非 dict → 与随后 `.get` 同样炸。 */
function orDict(v) {
  if (!pyTruthy(v)) return {};
  if (!isPlainObject(v)) throw new PyTypeError('期望 dict，实际是 ' + (Array.isArray(v) ? 'list' : typeof v));
  return v;
}

/**
 * Python `str()`（仅覆盖 JSON 里会出现的类型）：
 * str→原样；bool→`True`/`False`；null→`None`；数字→十进制文本；容器→JSON 文本兜底
 * （Python 的 `str(dict)` 是 repr 形态，这里不逐字复刻——真会话里标题/媒体类型都是字符串）。
 */
function pyStr(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/** Python `int()` 的字符串分支：允许两端空白、正负号、下划线分隔（`int("1_0")==10`）。 */
const PY_INT_STR_RE = /^[+-]?\d(?:_?\d)*$/;

/**
 * Python `int(v)`：
 * number → 截断取整（`int(1.9)==1`、`int(-1.9)==-1`）；bool → 0/1；
 * str → 按整数解析（非法串抛 PyValueError，对应 Python 的 ValueError）；
 * 容器 → PyTypeError（对应 Python 的 TypeError）。
 */
function pyInt(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PyValueError(`int() 不接受 ${v}`);
    return Math.trunc(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = pyStrip(v);
    if (!PY_INT_STR_RE.test(s)) throw new PyValueError(`invalid literal for int(): ${JSON.stringify(v)}`);
    return Number(s.replaceAll('_', ''));
  }
  throw new PyTypeError(`int() 不接受 ${isPlainObject(v) || Array.isArray(v) ? 'dict/list' : typeof v}`);
}

/**
 * Python `for x in v` 的迭代口径（JSON 值）：
 * 数组→元素；字符串→逐字符；对象→键（字符串）；数字/布尔/null → TypeError（不可迭代）。
 * JS 直接 `for…of` 一个普通对象会抛「not iterable」，而 Python 会静默迭代键，故显式对齐。
 */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v;
  if (isPlainObject(v)) return Object.keys(v);
  throw new PyTypeError(`${typeof v} 不可迭代`);
}

/** Python `"\n".join(x for x in parts if x)`：只保留真值元素；非字符串元素抛 TypeError。 */
function joinTruthy(parts, sep = '\n') {
  const kept = [];
  for (const p of parts) {
    if (!pyTruthy(p)) continue;
    if (typeof p !== 'string') throw new PyTypeError('join 的元素不是 str');
    kept.push(p);
  }
  return kept.join(sep);
}

/** Python `len(str)`：**码点**数（JS `.length` 是 UTF-16 码元数，遇代理对会多算）。 */
function cpLen(text) {
  if (typeof text !== 'string') throw new PyTypeError('len() 只接受 str');
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1;
    n += 1;
  }
  return n;
}

/** Python str 比较（码点序；JS 的 `<` 是码元序，仅非 BMP 字符上有别）。 */
function pyStrCompare(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const ca = x.value.codePointAt(0);
    const cb = y.value.codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

/** Python `os.stat` 的 stamp 载体：`(st_mtime_ns, st_size)`（bigint，避免 2^53 精度问题）。 */
function statStamp(p) {
  const st = fs.statSync(p, { bigint: true });
  return { ns: st.mtimeNs, size: st.size };
}

/** 两个 stamp 是否相等（Python：元组 `==`）。 */
function sameStamp(a, b) {
  return a.ns === b.ns && a.size === b.size;
}

/**
 * Python `os.path.getmtime()` 的**逐位等价**实现：照 CPython `_PyTime_AsSecondsDouble` 的
 * 口径 `double(秒) + double(纳秒) * 1e-9`。
 *
 * 为什么不用更短的 `stat.mtimeMs / 1000`（2026-10-11 实测，Node 22.19 与 24.20 同结论）：
 * 400 个**静止**真会话文件上，本公式与 Python `st_mtime` **400/400 逐位相等**，而
 * `mtimeMs / 1000` 是 **0/400**（mtimeMs 是整毫秒，亚毫秒部分直接丢）。`mtime` 会经
 * `list_sessions` 下发给看板并**参与跨语言对拍**，故保留位级口径。
 *
 * 边界语义只要求**同一侧自洽**：`live_session_id` 的 `mtime > since`、缓存 stamp 的
 * 「变没变」判定都不依赖跨语言位级相等；需要跨语言比边界时留 ≥1ms 余量即可。
 *
 * ⚠️ 造样本时的坑：**Node 22.19 的 `fs.utimesSync` 只到微秒**（`utimesSync(p, 1.000000001)`
 * 落盘成 `1000000000n`，Node 24 保留 `1000000001n`）——纳秒样本要用自然写入（内核给 ns）。
 */
function statMtime(p) {
  const st = fs.statSync(p, { bigint: true });
  return Number(st.mtimeNs / 1000000000n) + Number(st.mtimeNs % 1000000000n) * 1e-9;
}

// ---------------------------------------------------------------- 小工具（同 Python 段）

/** 超长文本截断（返回截断后的文本）。 */
export function _trunc(text, limit) {
  if (typeof text !== 'string') throw new PyTypeError('_trunc 只接受 str');
  if (text.length <= limit) return text;              // UTF-16 长度 ≤ limit ⇒ 码点数必然 ≤ limit
  // 按**码点**数走到 limit（Python `text[:limit]` 是码点切片；JS slice 是码元切片）
  let count = 0;
  let i = 0;
  while (i < text.length && count < limit) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1;
    i += 1;
    count += 1;
  }
  return i >= text.length ? text : text.slice(0, i);
}

/**
 * JSON 文本 → 对象或 null（非法 JSON / 非对象一律 null）。
 *
 * JSONL 行容错统一入口：会话存储里可能出现合法 JSON 但非对象的行（数字/字符串/数组），
 * 直接取键会炸掉整次解析。
 */
export function _obj(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  return isPlainObject(d) ? d : null;
}

/**
 * JSON 值 → 非负整数，其他（bool / 字符串 / 负数 / None / 小数）一律 null。
 *
 * token 计数与窗口大小都必须是干净的整数。注：Python 侧 `1.0` 是 float 不算整数，
 * JS 无法区分 `1.0`/`1`（模块头已记录的已知差异）。
 */
export function _nonneg_int(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * dsh `TokenUsage` → 本次请求的 **prompt 侧 token 数**（上下文占用分子）。
 *
 * 口径照抄 dsh `dsh-token-meter` 的 `pressureFrom`：
 * `inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)`＝「这一次请求送进模型的
 * 上下文有多大」。**不能**用 totalTokens：它含本次回复的输出 token，环会随回复长度越画越大。
 * inputTokens 缺失（老格式）退回 `totalTokens - outputTokens`；再取不到返回 null
 * （调用方保留上一槽位值）。
 */
export function _dsh_prompt_tokens(usage) {
  if (!isPlainObject(usage)) return null;
  const inp = _nonneg_int(usage.inputTokens);
  if (inp !== null) {
    return inp + (_nonneg_int(usage.cacheReadTokens) || 0) + (_nonneg_int(usage.cacheWriteTokens) || 0);
  }
  const total = _nonneg_int(usage.totalTokens);
  const out = _nonneg_int(usage.outputTokens);
  if (total !== null && out !== null && total >= out) return total - out;
  return null;
}

/**
 * entry 收集器：自动分配 seq 并累计 totals（Python `class _Entries`）。
 * `ctx` 两槽位与 `dshAnchors` 的语义见 Python 同名类。
 */
export function _Entries() {
  return {
    entries: [],
    // token/耗时汇总（API 契约字段）：dsh 事件流无 usage 汇总事件，恒为 0
    totals: { input: 0, output: 0, cache_read: 0, duration_ms: 0 },
    // 上下文占用两槽位（两个**独立 last-wins** 槽位）：used＝最新一次 usage 的 prompt 侧
    // token 数，max＝最新 `request/context` 的 contextWindow；null＝该槽位尚未出现过。
    ctx: { used: null, max: null },
    // dsh 回退锚点（仅 _parse_dsh 填充）：[(mid, eseq, text), …]
    dshAnchors: [],
  };
}

/** Python `_Entries.add()`：seq 自增 + time 取整 + 追加自定义字段。 */
function addEntry(col, kind, timeMs = 0, kw = {}) {
  col.entries.push({ seq: col.entries.length, kind, time: pyInt(pyOr(timeMs, 0)), ...kw });
}

// ---------------------------------------------------------------- dsh 解析

/**
 * 解压 dsh 会话文件（多帧 zstd），返回拼接的 JSONL 文本；完全不可读返回 ''。
 *
 * 容错分两跳，合起来与 Python `_dsh_decompressed` 的逐帧 `decompressobj()` **逐字节等价**：
 * 半帧收尾（「坏帧里已完整解出的块内容」）由 `zstd-frames.js` 统一负责：
 * `decompressSessionFile()` = 逐帧解压 + 坏帧处 `decompressFramePartial`
 * （`finishFlush: Z_NO_FLUSH`，与 Python `decompressobj()` 的部分输出逐字节同值）。
 * 纯垃圾 / 坏校验和取不到内容 ⇒ 与 Python 抛 `ZstdError` 时「本次结果整段丢弃」同效。
 *
 * 真机与手工样本实测（tools/parity/sess-run.mjs 第四节）：
 *   尾部垃圾 / 尾部半截帧 / 帧内截断 / 坏校验和帧 / 中间帧损坏 / skippable 帧 —— 六类样本
 *   的 sha256 与 Python 全部相等。
 */
export function _dsh_decompressed(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    return '';
  }
  // 坏帧处理（含「半帧里已解出的块内容」）已上移到 `zstd-frames.decompressSessionFile`
  // ——Python 语义属于「解压循环」那一层，放这里会让每个调用方各写一跳（2026-10-11 收口）。
  return decompressSessionFile(buf);
}

/** 会话事件流文件名（glob `session*.jsonl.zstd`；`[\s\S]` 对应 fnmatch 的 `.` 可跨行）。 */
const SESSION_FILE_RE = /^session[\s\S]*\.jsonl\.zstd$/;

/** 在一个会话目录里挑事件流文件：`session*.jsonl.zstd` 中版本号最大者，无则 null。 */
export function _dsh_pick_file(sdir) {
  let names;
  try {
    names = fs.readdirSync(sdir);          // Python glob：目录不存在/不是目录 → 空
  } catch {
    return null;
  }
  const hits = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;    // Python glob 的 `*` 不匹配隐藏项
    if (!SESSION_FILE_RE.test(name)) continue;
    const p = path.join(sdir, name);
    hits.push([_dsh_format_version(p), p]);
  }
  if (!hits.length) return null;
  // Python `max([(版本, 路径)])`：先比版本号，再比路径（str 比较=码点序）
  let best = hits[0];
  for (const hit of hits) {
    if (hit[0] > best[0] || (hit[0] === best[0] && pyStrCompare(hit[1], best[1]) > 0)) best = hit;
  }
  return best[1];                          // 版本号大者优先（同目录一般只有一个）
}

/**
 * 按会话 id 跨工作区 bucket 定位 zstd 会话文件（返回路径或 null）。
 *
 * id 形态两代并存：`session-<uuid>` 与裸 `<uuid>`（绝大多数是子代理会话）。
 * 文件名也带格式版本（`session.v4.jsonl.zstd` / `.v3` / 无版本）——**只认无版本名会让
 * v3/v4 会话全部 found=false**，故按通配匹配、版本号最大者优先。
 */
export function _dsh_session_file(sid) {
  if (!SID_DSH_RE.test(sid || '')) return null;
  let buckets;
  try {
    buckets = fs.readdirSync(DSH_SESSIONS);   // Python glob：根不存在 → 空
  } catch {
    return null;
  }
  const hits = [];
  for (const bucket of buckets) {
    if (bucket.startsWith('.')) continue;
    const sdir = path.join(DSH_SESSIONS, bucket, sid);
    let names;
    try {
      names = fs.readdirSync(sdir);
    } catch {
      continue;                              // 不是目录/不存在：glob 不产出该分支
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (!SESSION_FILE_RE.test(name)) continue;
      const p = path.join(sdir, name);
      hits.push([_dsh_format_version(p), p]);
    }
  }
  if (!hits.length) return null;
  let best = hits[0];
  for (const hit of hits) {
    if (hit[0] > best[0] || (hit[0] === best[0] && pyStrCompare(hit[1], best[1]) > 0)) best = hit;
  }
  return best[1];
}

/** 从会话文件名解析格式版本（无版本号记 0，保证「有版本 > 无版本」）。 */
export function _dsh_format_version(p) {
  const m = /session\.v(\d+)\.jsonl\.zstd$/.exec(path.basename(p));
  return m ? Number(m[1]) : 0;
}

// dsh 会话**头行**缓存：Map<path, {stamp, header}>。头行承载 origin/delegationDepth/cwd，
// 是判「子代理会话」的唯一可靠依据（目录名不是判据，见 is_subagent）。
const _DSH_HEADER_CACHE = new Map();
const _DSH_HEADER_FRAMES = 4;   // 头行最多向前找几帧（真机 304 个会话全在第 1 帧第 1 行）

/**
 * 读 dsh 会话**头行**（`{"type":"session","id":…,"origin":…,"delegationDepth":…}`），
 * 读不到/无头行返回 {}（老样本与异常一律降级为空）。
 *
 * 只解前 `_DSH_HEADER_FRAMES` 帧即停（头行就是第 1 帧第 1 行）——枚举 300+ 会话时
 * 不该付整段解压的代价。这里直接调 `zstd-frames.frameEnd` 定位单帧后逐帧解压，
 * 与 Python 的 `decompressobj()` 逐帧语义一致（不能用 `decompressFrames`：那会解全量）。
 * 按 (mtime_ns, size) 缓存：会话只追加，stamp 变即失效重读。
 */
export function _dsh_header(p) {
  let stamp;
  try {
    stamp = statStamp(p);
  } catch {
    return {};
  }
  const hit = _DSH_HEADER_CACHE.get(p);
  if (hit && sameStamp(hit.stamp, stamp)) return hit.header;
  let rest;
  try {
    rest = fs.readFileSync(p);
  } catch {
    return {};
  }
  let header = {};
  for (let i = 0; i < _DSH_HEADER_FRAMES; i += 1) {
    if (!rest.length) break;
    let text = '';
    let end = null;
    try {
      end = frameEnd(rest, 0);
      text = zstdDecompressSync(rest.subarray(0, end)).toString('utf8');
    } catch {
      // 半截帧/坏帧：Python 的 `decompressobj().decompress()` 在截断处**不抛错**，返回已解出的
      // 部分内容（头行若在其中就能读到）。故这里也尽力取一部分；真取不到才算「未知」（=主会话）。
      text = decompressFramePartial(end === null ? rest : rest.subarray(0, end)).toString('utf8');
      if (!text) break;
    }
    if (end === null) {
      // 半帧之后没有「下一帧」可续：解析完这一跳即收工
      for (const rawLine of text.split('\n')) {
        const line = pyStrip(rawLine);
        if (!line) continue;
        const d = _obj(line);
        if (d !== null && dget(d, 'type') === 'session') { header = d; break; }
      }
      break;
    }
    rest = rest.subarray(end);              // 余量即下一帧（逐帧解压，同 _dsh_decompressed）
    for (const rawLine of text.split('\n')) {
      const line = pyStrip(rawLine);
      if (!line) continue;
      const d = _obj(line);
      if (d !== null && dget(d, 'type') === 'session') {
        header = d;
        break;
      }
    }
    if (pyTruthy(header)) break;
  }
  _DSH_HEADER_CACHE.set(p, { stamp, header });
  return header;
}

/**
 * 头行 → 是否子代理会话：`origin=subagent` 为主判据，`delegationDepth>0` 兜底。
 *
 * 两个判据都留，是防 dsh 后续只写其一（真机实测两集合严格互斥）。
 */
export function _header_subagent(header) {
  if (pyStr(pyOr(dget(header, 'origin'), '')) === 'subagent') return true;
  try {
    return pyInt(pyOr(dget(header, 'delegationDepth'), 0)) > 0;
  } catch (error) {
    if (error instanceof PyTypeError || error instanceof PyValueError) return false;
    throw error;
  }
}

/**
 * 该会话是否 dsh **子代理会话**（主会话派生的调研/审计子代理，非用户会话）。
 *
 * 子代理会话与主会话同 bucket、同格式，只能靠头行区分（**目录名不是判据**——真机裸 uuid
 * 目录 82 个里 73 个是子代理，另 9 个是老主会话）。族不在白名单 / 存储不存在 / 头行缺失
 * 一律 false（未知按主会话处理——占用判定宁多等不可误放行）。
 */
export function is_subagent(family, sid) {
  if (!FAMILIES.includes(family)) return false;
  let p;
  try {
    p = _dsh_session_file(sid);
  } catch (error) {
    noteDegrade('is_subagent', error);
    return false;
  }
  return p ? _header_subagent(_dsh_header(p)) : false;
}

/**
 * 工作区路径 → dsh 会话 bucket 目录。
 * 实测命名：路径斜杠换 '-'，首尾各补 '-'，如 /srv/myproj → --srv-myproj--。
 */
export function dsh_bucket(cwd) {
  return path.join(DSH_SESSIONS, `-${(cwd || '').replace(/\/+$/, '').replaceAll('/', '-')}--`);
}

/**
 * 取工作区 bucket 下最新的会话 id（按事件流文件 mtime 的启发式）。
 * 目录名两代并存（session-<uuid> / 裸 <uuid>），故按 `*` 通配 + 事件流文件判存在。
 */
export function dsh_latest_session(cwd) {
  let names;
  try {
    names = fs.readdirSync(dsh_bucket(cwd));
  } catch {
    return '';
  }
  let best = '';
  let bestMt = 0.0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const zfile = _dsh_pick_file(path.join(dsh_bucket(cwd), name));
    if (!zfile) continue;
    let mt;
    try {
      mt = statMtime(zfile);
    } catch {
      continue;
    }
    if (mt > bestMt) {
      best = name;
      bestMt = mt;
    }
  }
  return best;
}

// path -> {stamp, title, prompt, titles}：当前标题、首问与全部标题事件同源同缓存——
// 三者都要全量解压会话文件，一次扫描一起取（30s 同步节拍里同一文件只解压一次）。
const _DSH_TITLE_CACHE = new Map();

/**
 * 取 text 中 idx 所在的那一行（不含换行符）。
 *
 * find 定位 + 切一行，避免为找一处事件把上千行文本 split 成全量列表。
 */
export function _line_at(text, idx) {
  const start = text.lastIndexOf('\n', idx - 1) + 1;   // Python rfind("\n", 0, idx)
  const end = text.indexOf('\n', idx);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/**
 * 全部 `session/title` 事件的标题，按文件顺序（无事件返回 []）。
 *
 * **末枚即 DSH 当前标题**（dsh 对同一会话会写多枚：先 fallback 截断句、再由 LLM 标题覆盖、
 * 用户显式改名再追加；GUI 侧栏显示 last-wins 的那一枚）。平台侧一律取同一口径；
 * `list_sessions` 另把整串下发给看板，用于判定「卡面标题是否仍是平台自动写入的形态」。
 *
 * 逐次 find + **整行 JSON 校验**：非事件行里出现同名字符串（坏行/别处文本）一律跳过；
 * 空标题事件跳过（dsh 不会写空标题，真出现时按「不表态」处理）。
 */
export function _dsh_scan_titles(text) {
  const out = [];
  let pos = 0;
  for (;;) {
    const idx = text.indexOf('"session/title"', pos);
    if (idx < 0) return out;
    pos = idx + 1;
    const d = _obj(_line_at(text, idx));
    if (d === null || dget(d, 'type') !== 'session/title') continue;
    const title = pyStr(pyOr(dget(orDict(dget(d, 'data')), 'title'), ''));
    if (title) out.push(title);
  }
}

/**
 * 主会话第一条真实用户提问的原文（可多行；无返回 ''）。
 *
 * 判定与会话窗口的 user entry 同口径：`user/message` 且 `source.kind == "user"`
 * （系统注入的 plugin / agent-instructions 消息被过滤）；文本块按换行拼接、**原样保留
 * 内部换行**。只有图片没有文本的提问返回 `[图片]`。「第一条」按**文件顺序**取。
 */
export function _dsh_scan_prompt(text) {
  let pos = 0;
  for (;;) {
    const idx = text.indexOf('"user/message"', pos);
    if (idx < 0) return '';
    pos = idx + 1;
    const d = _obj(_line_at(text, idx));
    if (d === null || dget(d, 'type') !== 'user/message') continue;   // 别处出现同名字符串：跳过
    const data = orDict(dget(d, 'data'));
    if (dget(orDict(dget(data, 'source')), 'kind', '') !== 'user') continue;   // 系统注入消息
    const blocks = [];
    for (const b of pyIter(pyOr(dget(data, 'content'), []))) {
      if (isPlainObject(b)) blocks.push(b);
    }
    const texts = [];
    for (const b of blocks) {
      if (dget(b, 'type') === 'text') texts.push(dget(b, 'text', ''));
    }
    const body = pyStrip(joinTruthy(texts, '\n'));
    if (body) return body;
    if (blocks.some((b) => dget(b, 'type') === 'image')) return '[图片]';
    // 既无文本也无图片：不是有效提问
  }
}

/**
 * 一次解压取出 {title, prompt, titles}，按文件 stamp 缓存。
 *
 * - title = `titles` 的**末枚**（last-wins = dsh GUI 侧栏显示的标题）；
 * - prompt = 看板 sync 卡描述（首问全文）的数据源；
 * - titles（全部标题事件）= 看板 sync 卡据此判定「卡面标题是否仍是平台自动写入的形态」。
 */
export function _dsh_meta(p) {
  let stamp;
  try {
    stamp = statStamp(p);
  } catch {
    return { title: '', prompt: '', titles: [] };
  }
  const hit = _DSH_TITLE_CACHE.get(p);
  if (hit && sameStamp(hit.stamp, stamp)) {
    return { title: hit.title, prompt: hit.prompt, titles: hit.titles };
  }
  const text = _dsh_decompressed(p);
  const titles = _dsh_scan_titles(text);
  const title = titles.length ? titles[titles.length - 1] : '';
  const prompt = _dsh_scan_prompt(text);
  _DSH_TITLE_CACHE.set(p, { stamp, title, prompt, titles });
  return { title, prompt, titles };
}

/** 读取 dsh 会话当前标题（最后一枚 session/title 事件），无/不可读返回 ''。 */
export function dsh_title(sid) {
  const p = _dsh_session_file(sid);
  return p ? _dsh_meta(p).title : '';
}

/** 读取主会话第一条真实用户提问的原文（可多行），无/不可读返回 ''。 */
export function dsh_first_prompt(sid) {
  const p = _dsh_session_file(sid);
  return p ? _dsh_meta(p).prompt : '';
}

/**
 * 解析 dsh 会话（解压后的 JSONL 事件流）。
 *
 * 关注事件：user/message（仅 source.kind=user 的真实输入，过滤系统注入）、
 * assistant/message（content 块 reasoning/text）、tool/call、tool/result。
 * 无 usage 汇总事件，totals 记 0；ctx 两槽位见 `_dsh_prompt_tokens` 与 `request/context`。
 */
export function _parse_dsh(p) {
  const col = _Entries();
  const toolNames = new Map();   // callId -> 工具名（回填 tool_result）
  for (const rawLine of _dsh_decompressed(p).split('\n')) {
    const line = pyStrip(rawLine);
    if (!line) continue;
    const d = _obj(line);
    if (d === null) continue;
    const t = dget(d, 'type');
    const tm = pyInt(pyOr(dget(d, 'time'), 0));
    const data = orDict(dget(d, 'data'));
    if (t === 'user/message') {
      if (dget(orDict(dget(data, 'source')), 'kind', '') !== 'user') continue;
      const texts = [];
      const images = [];
      for (const b of pyIter(pyOr(dget(data, 'content'), []))) {
        if (!isPlainObject(b)) continue;
        if (dget(b, 'type') === 'text') {
          texts.push(dget(b, 'text', ''));
        } else if (dget(b, 'type') === 'image') {
          // 图片附件：只记 attachmentId（字节由宿主 attachment 服务持有，平台经驱动 /media 取）
          const aid = pyStr(pyOr(dget(orDict(dget(b, 'attachment')), 'attachmentId'), ''));
          if (aid) images.push({ media: aid });
        }
      }
      const text = pyStrip(joinTruthy(texts, '\n'));
      if (text || images.length) {
        // ese=会话事件 seq（dsh 每条事件自带单调 seq），mid 用 `e<ese>` 合成：
        // 会话窗的「回退」按钮需要 mid 才显示，回退时再用 mid 换算 fork 边界
        const ese = pyInt(pyOr(dget(d, 'seq'), 0));
        const mid = `e${ese}`;
        col.dshAnchors.push([mid, ese, text || '[图片]']);
        addEntry(col, 'user', tm, { text, images, mid, eseq: ese });
      }
    } else if (t === 'assistant/message') {
      for (const b of pyIter(pyOr(dget(orDict(dget(data, 'message')), 'content'), []))) {
        if (!isPlainObject(b)) continue;
        if (dget(b, 'type') === 'reasoning') addEntry(col, 'think', tm, { text: dget(b, 'text', '') });
        else if (dget(b, 'type') === 'text') addEntry(col, 'assistant', tm, { text: dget(b, 'text', '') });
      }
      // 上下文占用分子：每次模型调用结算的 prompt 侧 token 数，last-wins
      // （无 usage 的中断消息不参与，槽位保留上一次可用的值）
      const used = _dsh_prompt_tokens(dget(data, 'usage'));
      if (used !== null) col.ctx.used = used;
    } else if (t === 'request/context') {
      // 上下文占用分母：宿主为该路由解析出的上下文窗口（last-wins）。
      // 0/缺失一律忽略——窗口必须为正才有意义。
      const win = _nonneg_int(dget(data, 'contextWindow'));
      if (win) col.ctx.max = win;
    } else if (t === 'tool/call') {
      const cid = dget(data, 'callId', '');
      toolNames.set(cid, dget(data, 'name', ''));
      addEntry(col, 'tool_call', tm, {
        name: dget(data, 'name', ''),
        args: _trunc(pyOr(dget(data, 'arguments', ''), ''), ARGS_MAX),
        call_id: cid,
      });
    } else if (t === 'tool/result') {
      const msg = orDict(dget(data, 'message'));
      let cid = pyOr(dget(orDict(dget(msg, 'source')), 'callId', ''), dget(msg, 'toolCallId', ''));
      const texts = [];
      for (const b of pyIter(pyOr(dget(msg, 'content'), []))) {
        if (!isPlainObject(b)) continue;
        // v4 实况：message.content 直接是 [{type:"text",text:…}]；
        // 另兼容早期/迁移形态：再嵌一层 {type:"tool-result",content:[{text}]}
        if (dget(b, 'type') === 'text') {
          texts.push(dget(b, 'text', ''));
        } else if (dget(b, 'type') === 'tool-result') {
          cid = cid || dget(b, 'toolCallId', '');
          for (const c of pyIter(pyOr(dget(b, 'content'), []))) {
            if (isPlainObject(c) && dget(c, 'type') === 'text') texts.push(dget(c, 'text', ''));
          }
        }
      }
      const out = joinTruthy(texts, '\n');
      addEntry(col, 'tool_result', tm, {
        call_id: cid,
        name: toolNames.has(cid) ? toolNames.get(cid) : '',
        text: _trunc(out, OUT_MAX),
        is_error: pyTruthy(dget(msg, 'isError')),
        truncated: cpLen(out) > OUT_MAX,
      });
    }
  }
  return col;
}

// ------------------------------------------------ 回退边界 / 运行中会话探测

/**
 * 把「回退到某条提问之前」换算成宿主 `session.fork` 的 `atSeq`。
 *
 * dsh **没有原地 undo**：等价实现是把该提问**之前**的历史复制成新会话。`atSeq` 是
 * inclusive 的，故取该提问事件 seq 的**前一个**（`max(0, ese - 1)`）。
 * 提问不在会话里/会话不可读/mid 为空 → null。
 */
export function dsh_fork_boundary(sid, mid) {
  if (!pyTruthy(mid)) return null;
  const p = _dsh_session_file(sid);
  if (p === null) return null;
  let col;
  try {
    col = _parse_dsh(p);
  } catch (error) {
    if (error instanceof PyTypeError) throw error;   // Python 只吞 OSError/ValueError
    noteDegrade('dsh_fork_boundary', error);
    return null;
  }
  for (const [anchorMid, ese] of col.dshAnchors) {
    if (anchorMid === mid) return Math.max(0, pyInt(ese) - 1);
  }
  return null;
}

/** 该 dsh 会话的真实用户提问锚点 `[{mid, eseq, text}]`（测试与诊断用）。 */
export function dsh_user_anchors(sid) {
  const p = _dsh_session_file(sid);
  if (p === null) return [];
  let col;
  try {
    col = _parse_dsh(p);
  } catch (error) {
    if (error instanceof PyTypeError) throw error;
    noteDegrade('dsh_user_anchors', error);
    return [];
  }
  return col.dshAnchors.map(([m, e, t]) => ({ mid: m, eseq: e, text: t }));
}

/**
 * dsh 运行中探测：工作区 bucket 下 mtime 晚于 since 的最新会话目录。
 * mtime 取事件流文件（目录 mtime 不随写入变化，且文件名带格式版本）。
 */
export function _live_dsh(cwd, since) {
  let names;
  try {
    names = fs.readdirSync(dsh_bucket(cwd));
  } catch {
    return '';
  }
  let best = '';
  let bestMt = 0.0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const zfile = _dsh_pick_file(path.join(dsh_bucket(cwd), name));
    if (!zfile) continue;
    let mt;
    try {
      mt = statMtime(zfile);
    } catch {
      continue;
    }
    if (mt > since && mt > bestMt) {
      best = name;
      bestMt = mt;
    }
  }
  return best;
}

/**
 * 运行中会话探测：任务的 session_id 尚未入库时，按「工作区匹配 + 活动时间晚于 since」
 * 猜出正在写的会话 id，供 session 窗口在任务运行期间实时展示对话。
 *
 * 结果只用于展示，绝不写回任务行。无匹配 / 存储不存在 / 参数无效 / 族不在白名单返回 ''。
 */
export function live_session_id(family, cwd, since) {
  cwd = (cwd || '').replace(/\/+$/, '');
  if (!cwd || since <= 0 || !FAMILIES.includes(family)) return '';
  try {
    return _live_dsh(cwd, since);
  } catch (error) {
    if (error instanceof PyTypeError) throw error;
    noteDegrade('live_session_id', error);
    return '';
  }
}

// ---------------------------------------------------------------- 统一入口

/**
 * 加载并解析 dsh 会话，返回 messages 响应主体。
 *
 * 返回 `{found:true, agents, agent, entries, total, totals}` 或
 * `{found:false, reason:"missing"|"unsupported"}`。entries 为 seq >= after 的增量；
 * total 为全量条数（变小时客户端应重置重拉）。dsh 为单线会话（固定 main）。
 * 另在**分母（上下文窗口）已知**时附带 `ctx`（会话窗底栏占用圈的数据源）；窗口未知时**不带**该键。
 */
export function load(family, sid, agent, after = 0) {
  if (!FAMILIES.includes(family)) return { found: false, reason: 'unsupported' };
  const agentName = pyOr(agent, 'main');
  let zpath;
  let agents;
  let cache;
  try {
    zpath = _dsh_session_file(sid);
    if (zpath === null) return { found: false, reason: 'missing' };
    // dsh 为单线会话（无子 agent）：agents 形状与旧单线族逐字段一致
    agents = [{ id: 'main', type: 'main', parent: '' }];
    const stamp = statStamp(zpath);
    const byAgent = _CACHE.get(sid);
    cache = byAgent ? byAgent.get(agentName) : undefined;
    if (cache === undefined || !sameStamp(cache.stamp, stamp)) {
      const col = _parse_dsh(zpath);
      cache = { stamp, entries: col.entries, totals: col.totals, ctx: col.ctx };
      if (byAgent) byAgent.set(agentName, cache);
      else _CACHE.set(sid, new Map([[agentName, cache]]));
    }
  } catch (error) {
    if (error instanceof PyTypeError) throw error;   // Python 只吞 OSError/ValueError
    noteDegrade('load', error);
    return { found: false, reason: 'missing' };
  }
  const entries = cache.entries;
  after = Math.max(0, pyInt(pyOr(after, 0)));
  const out = {
    found: true,
    agents,
    agent: agentName,
    entries: entries.slice(after),
    total: entries.length,
    totals: cache.totals,
  };
  // 上下文占用：只在**分母已知**时下发；分子缺省 0（窗口已知但没有模型调用＝空上下文）
  if (cache.ctx.max) out.ctx = { used: cache.ctx.used || 0, max: cache.ctx.max };
  return out;
}

/**
 * 驱动 `/media` 取字节的函数（Node 侧注入口）。
 *
 * 注入的是 `backend/lib/dshdriver.js` 的 `media(attachmentId)` —— 它是 **async** 函数，
 * 返回 `{content_type, bytes, data(base64)}`（`DshDriverError(404)` 表示附件不存在）。
 * 本闸口接受同步或异步 fetcher：`resolve_media` 内部 `await`，两种都能接。
 */
let mediaFetcher = null;

/** 注入媒体取字节函数（M3 接线时 `setMediaFetcher(dshdriver.media)`；单测可注入桩）。 */
export function setMediaFetcher(fetcher) {
  mediaFetcher = fetcher;
}

/**
 * base64 解码（Python `base64.b64decode(s)` 的容错口径：先丢弃字母表外字符，再查 padding）。
 * JS `Buffer.from(s, 'base64')` 对坏串静默截断，会让「坏数据」看起来是「有数据」，
 * 故这里显式把关，把 binascii.Error 折算成 PyValueError（同被 resolve_media 吞掉）。
 */
function pyB64Decode(text) {
  const cleaned = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  if (cleaned.length % 4 !== 0) throw new PyValueError('Invalid base64-encoded string');
  return Buffer.from(cleaned, 'base64');
}

/**
 * 解析会话图片为 `[bytes, content_type]`；不存在或校验失败返回 null。**async**。
 *
 * dsh: media_id = sha256:<64hex>（宿主 attachment id）→ 驱动 `/media` 取字节；
 * 族不在白名单 / id 形态不符 / 驱动无数据 / 附件不存在一律 null，路由层据此落 404。
 *
 * ⚠️ **为什么是 async（M2 评审 P1，2026-10-11）**：Node 侧 `dshdriver.media()` 是 async，
 * 早期同步实现会把 Promise 当响应对象 ⇒ 每个附件**静默 404**，且被拒的 Promise 变成
 * unhandled rejection（Node 默认直接崩进程）。调用方必须 `await`；Python 侧同名函数是同步的，
 * 接线/对拍处 `await` 一层即可，判据不变。
 * 注：Python 返回 tuple，本版返回 `[Buffer, string]`（同一解构口径）。
 */
export async function resolve_media(family, sid, agent, mediaId) {
  if (!FAMILIES.includes(family)) return null;
  try {
    if (!MEDIA_DSH_RE.test(mediaId || '')) return null;
    if (mediaFetcher === null) return null;
    const resp = await mediaFetcher(mediaId);       // 同步 fetcher 直接返回对象；异步 fetcher 在此 await
    const data = pyB64Decode(pyOr(dget(resp, 'data'), ''));
    const ctype = pyStr(pyOr(dget(resp, 'content_type'), ''));
    return data.length && ctype ? [data, ctype] : null;
  } catch (error) {
    noteDegrade('resolve_media', error);            // 附件不存在/坏 base64 静默；其它留痕
    return null;
  }
}

/** 清空解析缓存（测试用）。注：与 Python 一致，只清 `_CACHE`，不动头行/标题/归档缓存。 */
export function cache_clear() {
  _CACHE.clear();
}

// -------------------------------------- 会话标题 / 按工作区枚举 / 存在性检查
// 供看板「绑定已有会话」下拉与「session 自动同步」共用；均为增强能力，
// 异常一律静默返回空（'' / [] / false），不打断主流程。

export const LIST_SESSIONS_LIMIT = 50;   // 按工作区枚举会话的条数上限（绑定下拉/自动同步共用）

// dsh 归档集读侧缓存：{key: {path, ns, size} | null, ids: Set}。
// 按 (path, mtime_ns, size) 失效——宿主每次归档/取消归档都整表重写 workspace.json。
const _ARCHIVE_CACHE = { key: null, ids: new Set() };

/**
 * 读 dsh 宿主归档集（`<dsh home>/storages/workspace.json` → `global.archivedSessionIds`）。
 *
 * 为什么读文件而不是问驱动：sessparse 是纯只读解析层，归档标记只服务展示/建卡归类，
 * 不该引入 HTTP 依赖与调用频次。文件缺失 / 坏 JSON / 无该键 / 无 global 段 → 空集
 * （= 全部未归档，即历史行为）；解析结果按 (mtime_ns, size) 缓存。
 */
export function _dsh_archived_ids() {
  const p = path.join(path.dirname(DSH_SESSIONS), 'storages', 'workspace.json');
  let st;
  try {
    st = fs.statSync(p, { bigint: true });
  } catch {
    return new Set();
  }
  const key = { path: p, ns: st.mtimeNs, size: st.size };
  if (_ARCHIVE_CACHE.key !== null && _ARCHIVE_CACHE.key.path === key.path
      && _ARCHIVE_CACHE.key.ns === key.ns && _ARCHIVE_CACHE.key.size === key.size) {
    return _ARCHIVE_CACHE.ids;
  }
  let ids = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    let raw = null;
    if (isPlainObject(data)) {
      const glob = data.global;
      if (isPlainObject(glob)) raw = glob.archivedSessionIds === undefined ? null : glob.archivedSessionIds;
      if (raw === null) raw = data.archivedSessionIds === undefined ? null : data.archivedSessionIds;  // 兼容顶层直挂
    }
    if (Array.isArray(raw)) {
      ids = new Set();
      for (const s of raw) {
        if (pyTruthy(s)) ids.add(pyStr(s));
      }
    }
  } catch {
    ids = new Set();                    // 读不到/坏文件：按未归档降级（绝不上抛）
  }
  _ARCHIVE_CACHE.key = key;
  _ARCHIVE_CACHE.ids = ids;
  return ids;
}

/**
 * 统一会话标题读取（异常静默返回 ''，标题只是展示增强，不打断主流程）。
 * dsh 标题取会话**当前**标题（末枚 `session/title` 事件，与 dsh GUI 侧栏一致）。
 */
export function session_title(family, sid) {
  if (!FAMILIES.includes(family)) return '';
  try {
    return dsh_title(sid);
  } catch (error) {
    noteDegrade('session_title', error);
    return '';
  }
}

/**
 * dsh：bucket 目录下枚举会话目录，mtime 取事件流文件；`archived` 取宿主归档集。
 *
 * 目录名两代并存、文件名带格式版本，故目录匹配与文件匹配都用通配。
 * **子代理会话不进列表**：判据取会话头行的 origin/delegationDepth（先判头行再解全量，
 * 省一次整段解压）。裸 uuid 目录**不代表**是子代理（真机 82 个里 73 个是子代理、
 * 9 个是老主会话）。归档只影响归档标记：会话目录仍在 bucket 里，列表照常枚举到它。
 */
export function _list_dsh(cwd) {
  const archived = _dsh_archived_ids();
  const out = [];
  const bucket = dsh_bucket(cwd);
  let names;
  try {
    names = fs.readdirSync(bucket);
  } catch {
    return out;                         // Python glob：bucket 不存在 → 空列表
  }
  for (const sid of names) {
    if (sid.startsWith('.')) continue;
    const sdir = path.join(bucket, sid);
    const zfile = _dsh_pick_file(sdir);
    if (!zfile) continue;
    let mtime;
    try {
      mtime = statMtime(zfile);
    } catch {
      continue;
    }
    if (_header_subagent(_dsh_header(zfile))) continue;   // 子代理会话
    // 一次解压同时取当前标题、首问与全部标题事件（同 stamp 缓存）
    const meta = _dsh_meta(zfile);
    out.push({
      sid,
      title: meta.title,
      titles: meta.titles.slice(),      // Python `list(titles)`：下发副本，不暴露缓存内数组
      first_prompt: meta.prompt,
      mtime,
      archived: archived.has(sid),
    });
  }
  return out;
}

/**
 * 按工作区枚举 dsh 会话 `[{sid, title, titles, first_prompt, mtime秒, archived}]`，
 * mtime 降序、上限 `LIST_SESSIONS_LIMIT`。
 *
 * 族不在白名单 / cwd 为空 / 异常一律静默返回 []（列表是增强能力）。
 */
export function list_sessions(family, cwd) {
  if (!FAMILIES.includes(family)) return [];
  cwd = (cwd || '').replace(/\/+$/, '');
  if (!cwd) return [];
  let items;
  try {
    items = _list_dsh(cwd);
  } catch (error) {
    noteDegrade('list_sessions', error);
    return [];
  }
  items.sort((a, b) => b.mtime - a.mtime);   // Python sort(reverse=True) 稳定：等值保持原序
  return items.slice(0, LIST_SESSIONS_LIMIT);
}

/**
 * 会话存储是否还在（sync 卡片「存储被删→done」判定用；不做内容解析，纯路径存在性）。
 * 族不在白名单返回 false。
 */
export function session_exists(family, sid) {
  if (!FAMILIES.includes(family)) return false;
  try {
    return Boolean(_dsh_session_file(sid));
  } catch (error) {
    noteDegrade('session_exists', error);
    return false;
  }
}
