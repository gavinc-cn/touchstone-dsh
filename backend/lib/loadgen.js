/**
 * `loadgen.py`（678 行，仓库根）的 Node 对应物（Node 后端 M6-5）。
 *
 * Touchstone 内置压测引擎：校验场景 JSON → 并发发压 → 秒级快照落盘 → 汇总报告（JSON+Markdown），
 * 外加规范指标通道 `MetricsWriter` 与 `run` 子命令（平台发压轮的统一脚本调用入口）。
 *
 * ── 导出名 ────────────────────────────────────────────────────────────────────
 * 主名**照 Python 名**（`validate_scenario`/`run_load`/`_pct_from_buckets`/…），文件末尾再给一套
 * camelCase 别名（`validateScenario`/`runLoad`/`_pctFromBuckets`/…）供 JS 调用方使用——与
 * `rag.js`（M6-3）同一约定。对拍用例的 `fn` 写 Python 名、`nodeFn` 写本文件的导出名。
 *
 * ── 与 Python 的**形态**差异（都已在调用方或量具里显式对齐） ───────────────────
 * ① **异步**：Python 用「每线程一条 `http.client` 连接」的阻塞模型，Node 的 I/O 只有异步形态
 *    ⇒ `run_load`/`_worker`/`_one_request`/`main`/`_cmd_run` 返回 Promise（`await` 同步值无害）。
 *    其余函数保持同步（纯算法/文件）。
 * ② **元组 → 数组**：`validate_scenario` 的 `(scenario, err)`、`write_report_files` 的
 *    `(json_path, md_path)` 在 JS 侧就是数组（不用对象），对拍无需 `shape` 适配。`_one_request`
 *    的 4 元组是**内部**约定（连接对象过不了 JSON 边界），用命名对象 `{conn, ok, bucket, err_cls}`。
 * ③ **`**kwargs` → 末位 options**：`MetricsWriter.sample(metric, value, *, type, labels, ts)`
 *    在 Node 侧是 `sample(metric, value, options = {})`；`gauge`/`counter` 的 `(metric, value,
 *    ts=None, **labels)` 在 Node 侧是 `gauge(metric, value, kwargs = {})`——末位对象**就是**那批
 *    关键字实参（`{ts, ...labels}`），既复刻 Python 的绑定语义，又不让 `ts` 有机会落进 labels
 *    （历史缺陷见 `bug_report/20261004_2040`，Python 侧靠独立形参修掉，这里靠显式解构）。
 *    `meta(**fields)` 同理：`meta(fields = {})`。
 *
 * ── 并发模型：Python 线程 + http.client ⇒ Node 异步 + keep-alive Agent ─────────
 * Python（`loadgen.py:414-421`）：每档位起 `conc` 个线程，每线程一条 `http.client` 连接
 * （keep-alive 复用，只有连接类错误才 `conn.close()` 后重建）。Node 的等价物：
 *   · 每档位起 `conc` 个**并发异步 worker**（在飞请求数 = `conc`，`Promise.all` 即 `t.join()`）；
 *   · 每 worker **独占一个 keep-alive Agent**（`maxSockets: 1, maxFreeSockets: 1`）——
 *     与「每线程一条连接」同构；连接类错误 `agent.destroy()` 后下轮重建；
 *   · 不用 `fetch`：它的连接生命周期不受控，延迟分桶（`_bucket_of`）与 `conn_err` 这一维
 *     会直接不可对齐（`loadgen.py:366-367·376-377·392·396-401`）。
 * 计时：`time.perf_counter()` → `process.hrtime.bigint()`（纳秒整数→毫秒）；
 * `time.time()` → `Date.now()/1000`；`time.sleep` → `setTimeout`。
 * 锁：`_Agg` 在 Python 里要 `threading.Lock`，Node 单线程事件循环下 `add`/`take_window`/
 * `copy_total` 全程同步无 `await`，天然原子（保留同名方法，语义一致）。
 *
 * ── 已登记的**残余差异**（原理性；不做粉饰，逐条给理由） ──────────────────────
 *   a. **整数值浮点的 JSON 文本**：Python 写 `1.0`，`pyjson.js` 写 `1`（JS 的 number 无 int/float
 *      之分，`pyjson.js` 文件头已列为不可消除）。影响快照/指标/报告的**文本**，不影响 JSON 值。
 *      对拍夹具刻意避开整数值浮点（与 `rag.json` 同法）。
 *   b. **JSON 解码错误文案**：CPython 是 `Expecting value: line 1 column 1 (char 0)`，V8 是
 *      `Unexpected token …`。分支一致（两侧都判「不是合法 JSON」），文案不同源。
 *   c. **`json.load` 接受 `NaN`/`Infinity`/`-Infinity`**（CPython 默认 `allow_nan=True`），
 *      `JSON.parse` 不接受 ⇒ 场景文件里出现这三个裸字面量时 Python 能解析、Node 判非法。
 *   d. **非 latin-1 的 body/header 值**：Python 的 `http.client` 一律按 **latin-1** 编码（`_encode`）
 *      ⇒ 非 latin-1 字符抛 `UnicodeEncodeError`，该异常顺着 `_worker` 逃逸、**线程静默死掉**
 *      （其余 worker 照跑）。Node 侧同样按 latin-1 编码、同样只让该 worker 退出（见 `_latin1`），
 *      但不复刻 Python 打到 stderr 的那段 traceback。
 *   e. **header 值含 CR/LF**：Python `putheader` 抛 `ValueError`（线程死掉），Node `http` 抛
 *      `ERR_INVALID_CHAR`。夹具不覆盖。
 *   f. **IDN 主机名**：`urlsplit().hostname` 只做小写化，`new URL()` 还会做 punycode ⇒
 *      `http://例え.jp/` 两侧 `_new_conn` 拿到的主机名不同（本模块只在 `validate_scenario`
 *      借用手写 urlsplit，见 `_urlsplit`，故不受影响；`_parse_base` 也走同一实现）。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { pyStrip } from './lib.js';
import { pyJsonDumps, pyJsonDumpsIndent } from './pyjson.js';
import {
  KeyError, ValueError, pyInt, pyRound, pyStr, pyTruthy,
} from './rag.js';

// 延迟分桶上界（ms）：耗时落入首个 >= 耗时的边界桶；超出入 "over"
export const LAT_BOUNDS = Object.freeze([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]);
// 场景字段取值范围（并发上限=平台线程模型容量边界）
export const MAX_CONC = 512;
export const MAX_STAGES = 8;
export const MAX_GROUPS = 16;
// 快速失败观察窗（秒）：第 10 秒回看累计，全部为连接类错误则中止
export const QUICK_FAIL_SECONDS = 10;
// 错误分类键（快照 err_breakdown / 报告错误分类使用）
export const ERR_CLASSES = Object.freeze(['4xx', '5xx', 'timeout', 'conn_err']);

/** 快速失败：目标服务不可达，发压中止（runner 据此把任务标 failed）。 */
export class QuickFailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuickFailError';
  }
}

/**
 * Python `str` 的 latin-1 编码错误（`http.client._encode`）——照 CPython 的 `UnicodeEncodeError`
 * 文案：`'latin-1' codec can't encode characters in position 0-1: ordinal not in range(256)`。
 *
 * 为什么要它：`_worker` 靠**这个类型**决定「该 worker 退出、其余照跑」（复刻 Python 的线程死亡）。
 */
export class UnicodeEncodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnicodeEncodeError';
  }
}

// --------------------------------------------------------------------------
// Node 侧共用小工具（Python 无对应物；loadcase.js 也 import，避免两份实现）
// --------------------------------------------------------------------------

/**
 * Python `dict.get(k[, d])`：**只有键不存在**才给默认值（键在但为 null 仍返回 null）。
 * 用 `hasOwnProperty` 而不是 `in`/直接取值：`constructor`/`toString` 这类键会撞原型链。
 */
function pyGet(obj, key, fallback = null) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return fallback;
}

/**
 * Python `float(x)`：bool→1/0、str 走 Python 的空白/正负号/`1_0`/`inf`/`nan` 口径，
 * 其余类型抛 TypeError（照 `float()` 的 `(TypeError, ValueError)` 二分——`MetricsWriter.sample`
 * 就是靠它决定「丢弃样本」还是「抛给调用方」）。
 *
 * 已知残余：只认 ASCII 数字（Python 还认 Unicode 十进制数字，与 `lib.py:pyIsDigits` 同一条备案）。
 */
export function py_float(value) {
  if (typeof value === 'boolean') return value ? 1.0 : 0.0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = pyStrip(value);
    const m = /^([+-]?)(inf(?:inity)?|nan|(?:\d(?:_?\d)*)?(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d+)?)$/.exec(text.toLowerCase());
    if (!m || m[2] === '') {
      throw new ValueError(`could not convert string to float: ${_pyReprString(value)}`);
    }
    const body = m[2].replace(/_/g, '').toLowerCase();
    let out;
    if (body === 'inf' || body === 'infinity') out = Infinity;
    else if (body === 'nan') out = NaN;
    else out = Number(body);
    return m[1] === '-' ? -out : out;
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${_pyTypeName(value)}'`);
}

/** Python `repr(str)` 的可用子集（错误文案里用；`rag.js` 的同名助手是私有的） */
function _pyReprString(text) {
  let out = "'";
  for (const ch of String(text)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `${out}'`;
}

/** Python 类型名（只用于错误文案） */
function _pyTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(value) ? 'int' : 'float';
    case 'string': return 'str';
    case 'object': return 'dict';
    default: return typeof value;
  }
}

/**
 * Python `str(OSError)` 的 Node 还原：`[Errno 2] No such file or directory: '/p'`。
 *
 * 为什么必须做：`validate_scenario` / `load_charts` 把 OSError 文本直接拼进给用户看的
 * 错误说明里（`场景文件不存在或不可读: {e}`），文案不一致 ⇒ 对拍里这两条分支只能靠白名单
 * 盖住。errno→strerror 表按 Linux 的 `strerror(3)` 口径给（Node 的 `e.errno` 是负数）。
 */
const _ERRNO_TEXT = new Map([
  ['EPERM', [1, 'Operation not permitted']],
  ['ENOENT', [2, 'No such file or directory']],
  ['EIO', [5, 'Input/output error']],
  ['EBADF', [9, 'Bad file descriptor']],
  ['EACCES', [13, 'Permission denied']],
  ['EEXIST', [17, 'File exists']],
  ['ENOTDIR', [20, 'Not a directory']],
  ['EISDIR', [21, 'Is a directory']],
  ['EINVAL', [22, 'Invalid argument']],
  ['EMFILE', [24, 'Too many open files']],
  ['ENOSPC', [28, 'No space left on device']],
  ['EROFS', [30, 'Read-only file system']],
  ['ENAMETOOLONG', [36, 'File name too long']],
  ['ENOTEMPTY', [39, 'Directory not empty']],
  ['ELOOP', [40, 'Too many levels of symbolic links']],
]);

export function py_error_str(err, pathHint = null) {
  const code = err && err.code;
  const known = _ERRNO_TEXT.get(code);
  // Python 的 OSError 文本总带 open() 的**文件名**；Node 的部分错误（如目录读到一半的
  // `EISDIR ... read`）只有 syscall 没有 path ⇒ 用调用方给的路径兜底（少了它就与 oracle 分叉）
  const where0 = err && err.path !== undefined ? err.path : pathHint;
  const where = where0 !== undefined && where0 !== null ? `: '${where0}'` : '';
  if (!known) {
    const num = err && typeof err.errno === 'number' ? -err.errno : null;
    const text = (err && err.message) || String(err);
    return num === null ? text : `[Errno ${num}] ${text}${where}`;
  }
  return `[Errno ${known[0]}] ${known[1]}${where}`;
}

/** Node 的 fs 错误（带 code/syscall），与「解码/解析」类错误（ValueError）区分开 */
function _isOsError(err) {
  return Boolean(err) && typeof err.code === 'string' && typeof err.syscall === 'string';
}

/**
 * CPython `UnicodeDecodeError` 文案（utf-8）：`'utf-8' codec can't decode byte 0xff in position 0:
 * invalid start byte`。按 CPython 的 UTF-8 解码器逐段复刻「起始位置 + 区间 + 三种 reason」
 * （区间跨多字节时是 `bytes in position a-b`，单字节时是 `byte 0x…  in position a`）。
 */
function _utf8ErrorMessage(buf) {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    let need;
    let lo = 0x80;
    let hi = 0xBF;
    if (b >= 0xC2 && b <= 0xDF) need = 1;
    else if (b >= 0xE0 && b <= 0xEF) {
      need = 2;
      if (b === 0xE0) lo = 0xA0;
      else if (b === 0xED) hi = 0x9F;
    } else if (b >= 0xF0 && b <= 0xF4) {
      need = 3;
      if (b === 0xF0) lo = 0x90;
      else if (b === 0xF4) hi = 0x8F;
    } else {
      return { start: i, end: i, reason: 'invalid start byte' };
    }
    if (i + 1 >= n) return { start: i, end: n - 1, reason: 'unexpected end of data' };
    if (buf[i + 1] < lo || buf[i + 1] > hi) {
      return { start: i, end: i, reason: 'invalid continuation byte' };
    }
    for (let k = 2; k <= need; k += 1) {
      if (i + k >= n) return { start: i, end: n - 1, reason: 'unexpected end of data' };
      if (buf[i + k] < 0x80 || buf[i + k] > 0xBF) {
        return { start: i, end: i + k - 1, reason: 'invalid continuation byte' };
      }
    }
    i += need + 1;
  }
  return null;
}

/**
 * 读一个 JSON 文件（`open(path, encoding="utf-8")` + `json.load`）。
 *
 * 与 Python 的差异只保留两处**已登记**的残余：JSON 解码错误文案（b）、`NaN`/`Infinity`（c）。
 * 其它逐条对齐：严格 UTF-8（Python 默认 `errors=None`，非法字节抛 UnicodeDecodeError——
 * 那是 ValueError 子类）、**不剥 BOM**（`ignoreBOM: true`，Python 的 utf-8 编解码器保留 U+FEFF）。
 * 抛出的错误分两类：fs 错误（带 code/syscall，调用方按 OSError 处理）与 ValueError。
 */
export function read_json_file(filePath) {
  const buf = fs.readFileSync(filePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    const info = _utf8ErrorMessage(buf) || { start: 0, end: 0, reason: 'invalid start byte' };
    const where = info.start === info.end
      ? `byte 0x${buf[info.start].toString(16).padStart(2, '0')} in position ${info.start}`
      : `bytes in position ${info.start}-${info.end}`;
    throw new ValueError(`'utf-8' codec can't decode ${where}: ${info.reason}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ValueError(e && e.message !== undefined ? e.message : String(e));
  }
}

/** Python `time.strftime(fmt, time.localtime(when))` 的可用子集（%Y %m %d %H %M %S %%） */
export function strftime_local(date, fmt) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const table = {
    Y: String(date.getFullYear()),
    m: pad(date.getMonth() + 1),
    d: pad(date.getDate()),
    H: pad(date.getHours()),
    M: pad(date.getMinutes()),
    S: pad(date.getSeconds()),
  };
  return String(fmt).replace(/%([YmdHMS%])/g, (whole, ch) => (ch === '%' ? '%' : table[ch]));
}

/** Python `str(float)` / f-string 里的浮点渲染（`0.0`→`"0.0"`、`12.5`→`"12.5"`） */
function _pyFloatStr(value) {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  return String(value);
}

/**
 * f-string 里任意值的渲染（`None`→`"None"`、整数值浮点→`"1.0"`，其余同 `pyStr`）。
 *
 * 为什么必须单列：Python 的 f-string 对 float 走 `repr`（`0.0` → `"0.0"`），而 JS 的 `` `${0}` ``
 * 是 `"0"`；报告/摘要里的 RPS、分位数、时长都是这条路径。
 */
export function py_field_str(value) {
  if (typeof value === 'number') return _pyFloatStr(value);
  return pyStr(value);
}

/**
 * f-string 里的 **int 型**字段（`max`）：`None`→`"None"`，其余按整数字面量渲染。
 *
 * 为什么要和 `py_field_str` 分开：JS 的 number 分不出 int/float，而 `py_field_str` 按
 * **float** 渲染（整数值补 `.0`）——那对 `round()` 的产物是对的（Python 侧拿到的是 float，
 * `f"{2.0}"` 就是 `"2.0"`），对 `_max_from_buckets` 的 `int(b)` 产物是错的（Python 是
 * `"50"`，补成 `"50.0"` 就与 oracle 分叉）。故按字段的**已知类型**选渲染器。
 */
function _pyIntFieldStr(value) {
  if (value === null || value === undefined) return 'None';
  return String(value);
}

/**
 * f-string 的 `{x:.1f}` / `{x:.2f}`：CPython 的定点格式对 double 的**精确十进制值**做半偶舍入，
 * JS 的 `toFixed` 是半**上**入 ⇒ `format(1.25, ".1f")` 是 `"1.2"` 而 `(1.25).toFixed(1)` 是
 * `"1.3"`。错误率 = `round(err/count, 4) * 100` 恰好会踩到 `x.x5`（如 10/800 → 1.25%），
 * 故这里先 `pyRound`（与 CPython 同语义）再补位。
 */
function _pyFixed(value, digits) {
  return pyRound(value, digits).toFixed(digits);
}

// --------------------------------------------------------------------------
// urlsplit / 端口（**手写**：Node 的 `new URL()` 语义与 Python 不同，见文件头）
// --------------------------------------------------------------------------

/** Python `urlsplit()` 的结构部分（scheme/netloc/path/query/fragment） */
function _urlsplit(rawUrl) {
  // CPython 先删掉 URL 里的 \t\r\n（_UNSAFE_URL_BYTES_TO_REMOVE），再按「scheme → # → ?」切
  let url = String(rawUrl).replace(/[\t\r\n]/g, '');
  let scheme = '';
  let fragment = '';
  let query = '';
  let netloc = '';
  let text = url;
  const colon = text.indexOf(':');
  if (colon > 0 && /^[\x00-\x7f]$/.test(text[0]) && /[A-Za-z]/.test(text[0])) {
    const head = text.slice(0, colon);
    if (/^[A-Za-z0-9+.-]*$/.test(head)) {
      scheme = head.toLowerCase();
      text = text.slice(colon + 1);
    }
  }
  const hash = text.indexOf('#');
  if (hash >= 0) { fragment = text.slice(hash + 1); text = text.slice(0, hash); }
  const qm = text.indexOf('?');
  if (qm >= 0) { query = text.slice(qm + 1); text = text.slice(0, qm); }
  if (text.startsWith('//')) {
    const rest = text.slice(2);
    const slash = rest.indexOf('/');
    netloc = slash >= 0 ? rest.slice(0, slash) : rest;
    text = slash >= 0 ? rest.slice(slash) : '';
    if ((netloc.includes('[') && !netloc.includes(']'))
        || (netloc.includes(']') && !netloc.includes('['))) {
      throw new ValueError('Invalid IPv6 URL');       // 照 CPython：urlsplit 直接抛
    }
  }
  url = text;
  return { scheme, netloc, path: url, query, fragment };
}

/**
 * Python `urlsplit(...)._hostinfo` + `hostname`/`username`/`port` 三个属性。
 *
 * `port` 的判定照 CPython 3.12（`urllib/parse.py` 的 `port` property）：
 * `port.isdigit() and port.isascii()` 才 `int()`，否则 `ValueError`；再判 `0 <= port <= 65535`。
 * 空端口（`http://h:`）不算错（`None`）。
 */
function _pyHostInfo(parts) {
  const netloc = parts.netloc;
  const at = netloc.lastIndexOf('@');
  const haveInfo = at >= 0;
  const userinfo = haveInfo ? netloc.slice(0, at) : '';
  const hostinfo = haveInfo ? netloc.slice(at + 1) : netloc;
  const username = haveInfo ? userinfo.split(':')[0] : null;

  let hostname;
  let port;
  const openBr = hostinfo.indexOf('[');
  if (openBr >= 0) {
    const bracketed = hostinfo.slice(openBr + 1);
    const closeBr = bracketed.indexOf(']');
    hostname = closeBr >= 0 ? bracketed.slice(0, closeBr) : bracketed;
    const after = closeBr >= 0 ? bracketed.slice(closeBr + 1) : '';
    port = after.startsWith(':') ? after.slice(1) : '';
  } else {
    const c = hostinfo.indexOf(':');
    hostname = c >= 0 ? hostinfo.slice(0, c) : hostinfo;
    port = c >= 0 ? hostinfo.slice(c + 1) : '';
  }
  if (!port) port = null;
  // hostname：空 → None；否则小写（zone 段保留大小写，照 CPython）
  let hostOut = null;
  if (hostname) {
    const pct = hostname.indexOf('%');
    hostOut = pct >= 0
      ? hostname.slice(0, pct).toLowerCase() + hostname.slice(pct)
      : hostname.toLowerCase();
  }
  return { username, hostname: hostOut, port };
}

/** `urlsplit(base)` 的常用取用口（`.port` 的访问即这里抛 ValueError，照 Python 的惰性抛） */
function _parse_base(baseUrl) {
  const parts = _urlsplit(baseUrl);
  const info = _pyHostInfo(parts);
  let port = null;
  if (info.port !== null) {
    if (!/^[0-9]+$/.test(info.port)) {
      throw new ValueError(`Port could not be cast to integer value as ${_pyReprString(info.port)}`);
    }
    port = Number(info.port);
    if (!(port >= 0 && port <= 65535)) throw new ValueError('Port out of range 0-65535');
  }
  return {
    scheme: parts.scheme,
    hostname: info.hostname,
    username: info.username,
    path: parts.path,
    query: parts.query,
    fragment: parts.fragment,
    port,
  };
}

// --------------------------------------------------------------------------
// 场景校验
// --------------------------------------------------------------------------

/**
 * 校验压测场景 JSON 文件。返回 `[scenario, null]` 或 `[null, 错误说明]`。
 *
 * 校验通过时对 scenario 做规范化（method 转大写、补默认 timeout_ms），调用方（runner）拿到的
 * 即可直接发压的对象。规则与设计文档 §4 一致。
 */
export function validate_scenario(scenarioPath) {
  let sc;
  try {
    sc = read_json_file(scenarioPath);
  } catch (e) {
    // 照 Python 的 `except OSError` / `except ValueError` 两条：其它异常照原样往外抛
    if (e instanceof ValueError) {
      return [null, `场景不是合法 JSON: ${e && e.message !== undefined ? e.message : e}`];
    }
    if (_isOsError(e)) return [null, `场景文件不存在或不可读: ${py_error_str(e, scenarioPath)}`];
    throw e;
  }
  if (!(sc !== null && typeof sc === 'object' && !Array.isArray(sc))) {
    return [null, '场景顶层必须是 JSON 对象'];
  }
  const base = pyStrip(pyStr(pyGet(sc, 'base_url', '')));
  const u = _urlsplit(base);
  const info = _pyHostInfo(u);
  // 只接受 host[:port] 形式：带路径/query/fragment 时前缀会被引擎静默丢弃，压错目标；
  // user:pass@ 的凭据同样会被引擎静默丢弃（产出「看似正常」的报告），username 非空即拒绝
  if (!(u.scheme === 'http' || u.scheme === 'https') || !info.hostname
      || pyTruthy(info.username) || !(u.path === '' || u.path === '/')
      || pyTruthy(u.query) || pyTruthy(u.fragment)) {
    return [null, 'base_url 必须是 http(s)://host[:port] 形式（不支持 user:pass@，鉴权走 headers）'];
  }
  try {
    // 端口非法（非数字/越界）访问时才抛：提前判掉，否则工作线程会在
    // 建连接处静默死掉，产出「0 请求但正常结束」的假报告（loadgen.py:75-78）
    if (info.port !== null) {
      if (!/^[0-9]+$/.test(info.port)) {
        throw new ValueError(`Port could not be cast to integer value as ${_pyReprString(info.port)}`);
      }
      const p = Number(info.port);
      if (!(p >= 0 && p <= 65535)) throw new ValueError('Port out of range 0-65535');
    }
  } catch {
    return [null, 'base_url 端口非法（必须是 1~65535 的整数）'];
  }
  sc.base_url = base;
  if (!pyStrip(pyStr(pyGet(sc, 'name', '')))) {
    return [null, '缺少 name（场景名）'];
  }
  const groups = pyGet(sc, 'groups', null);
  if (!Array.isArray(groups) || !(groups.length >= 1 && groups.length <= MAX_GROUPS)) {
    return [null, `groups 必须是 1~${MAX_GROUPS} 个的数组`];
  }
  const seen = new Set();
  for (const g of groups) {
    if (!(g !== null && typeof g === 'object' && !Array.isArray(g))) {
      return [null, 'groups 元素必须是对象'];
    }
    const name = pyStrip(pyStr(pyGet(g, 'name', '')));
    if (!name) return [null, 'groups[].name 不能为空'];
    if (seen.has(name)) return [null, `groups[].name 重复: ${name}`];
    seen.add(name);
    g.name = name;
    g.method = pyStr(pyGet(g, 'method', 'GET')).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(g.method)) {
      return [null, `${name}: method 非法`];
    }
    const pathText = pyStrip(pyStr(pyGet(g, 'path', '')));
    if (!pathText.startsWith('/')) return [null, `${name}: path 必须以 / 开头`];
    g.path = pathText;
    const headers = pyGet(g, 'headers', {});
    if (!(headers !== null && typeof headers === 'object' && !Array.isArray(headers))) {
      return [null, `${name}: headers 必须是对象`];
    }
    // 值必须是标量：嵌套对象传给 http.client 会抛 TypeError 使工作线程静默死亡
    for (const v of Object.values(headers)) {
      const scalar = typeof v === 'string' || typeof v === 'number';
      if (typeof v === 'boolean' || !scalar) {
        return [null, `${name}: headers 的值必须是标量`];
      }
    }
    const w = pyGet(g, 'weight', 1);
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1) {
      return [null, `${name}: weight 必须是 >=1 的整数`];
    }
    g.weight = w;      // 缺省时补默认值写回，否则 run_load 的 _pick_group 会 KeyError
    if (Object.prototype.hasOwnProperty.call(g, 'body') && typeof g.body !== 'string') {
      return [null, `${name}: body 必须是字符串`];
    }
  }
  const stages = pyGet(sc, 'stages', null);
  if (!Array.isArray(stages) || !(stages.length >= 1 && stages.length <= MAX_STAGES)) {
    return [null, `stages 必须是 1~${MAX_STAGES} 档的数组`];
  }
  for (const s of stages) {
    if (!(s !== null && typeof s === 'object' && !Array.isArray(s))) {
      return [null, 'stages 元素必须是对象'];
    }
    const c = pyGet(s, 'conc', null);
    const sec = pyGet(s, 'seconds', null);
    if (typeof c !== 'number' || !Number.isInteger(c) || !(c >= 1 && c <= MAX_CONC)) {
      return [null, `conc 必须是 1~${MAX_CONC} 的整数（平台容量边界）`];
    }
    if (typeof sec !== 'number' || !Number.isInteger(sec) || !(sec >= 5 && sec <= 3600)) {
      return [null, 'seconds 必须是 5~3600 的整数'];
    }
  }
  const t = pyGet(sc, 'timeout_ms', 10000);
  if (typeof t !== 'number' || !Number.isInteger(t) || !(t >= 100 && t <= 60000)) {
    return [null, 'timeout_ms 必须是 100~60000 的整数'];
  }
  sc.timeout_ms = t;
  return [sc, null];
}

// --------------------------------------------------------------------------
// 分桶与统计
// --------------------------------------------------------------------------

/** 耗时（ms）→ 分桶键：首个 >= 耗时的边界值字符串；超出归 "over"（`bisect.bisect_left`） */
export function _bucket_of(ms) {
  let lo = 0;
  let hi = LAT_BOUNDS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (LAT_BOUNDS[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo < LAT_BOUNDS.length ? String(LAT_BOUNDS[lo]) : 'over';
}

/** 分桶累计 + 桶内线性插值取分位数（ms）；无成功请求返回 None */
export function _pct_from_buckets(buckets, pct) {
  let total = 0;
  for (const v of Object.values(buckets)) total += v;
  if (!pyTruthy(total)) return null;
  const target = total * pct / 100.0;
  let cum = 0;
  let prevUpper = 0;
  for (const b of [...LAT_BOUNDS.map(String), 'over']) {
    const c = pyGet(buckets, b, 0);
    if (pyTruthy(c) && cum + c >= target) {
      const upper = b === 'over' ? LAT_BOUNDS[LAT_BOUNDS.length - 1] : Number(b);
      const frac = (target - cum) / c;
      return pyRound(prevUpper + (upper - prevUpper) * frac, 1);
    }
    cum += c;
    prevUpper = b === 'over' ? LAT_BOUNDS[LAT_BOUNDS.length - 1] : Number(b);
  }
  return null;
}

/** max 近似：最大非空桶的上界（引擎不存逐请求样本，接受近似） */
export function _max_from_buckets(buckets) {
  const keys = [...LAT_BOUNDS.map(String), 'over'];
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const b = keys[i];
    if (pyTruthy(pyGet(buckets, b, 0))) {
      return b === 'over' ? LAT_BOUNDS[LAT_BOUNDS.length - 1] : Number(b);
    }
  }
  return null;
}

/** 从一组累计计数算指标 dict（分位数由分桶插值近似） */
export function _metrics(stat, duration_s, peak_rps = null) {
  const m = {
    total: stat.count,
    errors: stat.err,
    err_rate: pyTruthy(stat.count) ? pyRound(stat.err / stat.count, 4) : 0.0,
    rps_avg: duration_s > 0 ? pyRound(stat.count / duration_s, 2) : 0.0,
    err_breakdown: { ...stat.err_cls },
    p50: _pct_from_buckets(stat.buckets, 50),
    p90: _pct_from_buckets(stat.buckets, 90),
    p99: _pct_from_buckets(stat.buckets, 99),
    max: _max_from_buckets(stat.buckets),
  };
  if (peak_rps !== null) m.rps_peak = pyRound(peak_rps, 2);
  return m;
}

/**
 * 线程安全计数器：累计（报告用）+ 当秒窗口（快照用）。
 *
 * 结构：`{组名 或 "__all__": {"count", "err", "err_cls", "buckets"}}`；
 * 延迟分桶只收成功请求，错误按 4xx/5xx/timeout/conn_err 分类计数。
 *
 * Node 侧无锁：`add`/`take_window`/`copy_total` 全程同步（不含 `await`），单线程事件循环下
 * 天然原子——Python 的 `threading.Lock` 在这里没有对应物，也没有必要。
 */
export class _Agg {
  constructor(groupNames) {
    const keys = [...groupNames, '__all__'];
    this.total = {};
    this.window = {};
    for (const k of keys) {
      this.total[k] = _Agg._new_group();
      this.window[k] = _Agg._new_group();
    }
  }

  static _new_group() {
    const errCls = {};
    for (const k of ERR_CLASSES) errCls[k] = 0;
    const buckets = {};
    for (const b of [...LAT_BOUNDS, 'over']) buckets[String(b)] = 0;
    return { count: 0, err: 0, err_cls: errCls, buckets };
  }

  /** 记一次请求结果（成功带分桶键，失败带错误分类），累计+当秒窗口各记一次 */
  add(group, ok, bucket = null, errCls = null) {
    for (const tgt of [this.total, this.window]) {
      for (const key of [group, '__all__']) {
        if (!Object.prototype.hasOwnProperty.call(tgt, key)) {
          throw new KeyError(_pyReprString(key));      // Python：tgt[key] → KeyError
        }
        const g = tgt[key];
        g.count += 1;
        if (ok) {
          if (!Object.prototype.hasOwnProperty.call(g.buckets, bucket)) {
            throw new KeyError(_pyReprString(bucket));
          }
          g.buckets[bucket] += 1;
        } else {
          g.err += 1;
          if (!Object.prototype.hasOwnProperty.call(g.err_cls, errCls)) {
            throw new KeyError(_pyReprString(errCls));
          }
          g.err_cls[errCls] += 1;
        }
      }
    }
  }

  /** 原子取走当秒窗口并换新，返回窗口快照 dict */
  take_window() {
    const win = this.window;
    const fresh = {};
    for (const k of Object.keys(win)) fresh[k] = _Agg._new_group();
    this.window = fresh;
    return win;
  }

  /** 累计计数的深拷贝（阶段差值/最终报告用） */
  copy_total() {
    const out = {};
    for (const [k, v] of Object.entries(this.total)) {
      out[k] = {
        count: v.count, err: v.err, err_cls: { ...v.err_cls }, buckets: { ...v.buckets },
      };
    }
    return out;
  }
}

// --------------------------------------------------------------------------
// 规范指标通道
// --------------------------------------------------------------------------

/**
 * 规范化指标通道写入器（一行一样本，逐行 flush）。
 *
 * 契约（与解析侧 `loadcase.normalize_line` 一致）：
 * - `sample(metric, value, options)`：point 样本，`gauge`=瞬时值 / `counter`=单调递增累计值；
 * - `meta(fields)`：上下文行（目标地址、档位等），可省略；
 * - `summary(values)`：收尾 KPI 字典，取最后一条。
 *
 * 通道不可写时静默降级——指标落盘失败不该中断压测本身。（Python 用 `threading.Lock`；
 * Node 单线程下 `fs.writeSync` 本身就是一次完整的写，无需锁。）
 */
export class MetricsWriter {
  constructor(filePath) {
    this.path = filePath;
    this._f = null;
    try {
      this._f = fs.openSync(filePath, 'a');          // Python: open(path, "ab")
    } catch {
      this._f = null;
    }
  }

  /** 关闭底层文件（幂等；重复调用安全） */
  close() {
    if (this._f !== null) {
      try {
        fs.closeSync(this._f);
      } catch { /* 照 Python：吞 OSError */ }
      this._f = null;
    }
  }

  /** 写一行 JSON（失败静默，通道是尽力而为的附属产物） */
  _write(obj) {
    if (this._f === null) return;
    try {
      fs.writeSync(this._f, Buffer.from(`${pyJsonDumps(obj)}\n`, 'utf8'));
    } catch { /* 照 Python：吞 OSError */ }
  }

  /** 标签归一：只保留标量值并统一键为字符串（与校验/解析口径一致） */
  static _norm_labels(labels) {
    const out = {};
    for (const [k, v] of Object.entries(pyTruthy(labels) ? labels : {})) {
      const scalar = typeof v === 'string' || typeof v === 'number';
      if (typeof v === 'boolean' || !scalar) continue;
      out[pyStr(k)] = v;
    }
    return out;
  }

  /**
   * 写一条样本；value 非数字或 type 非法时丢弃（不抛异常给压测主流程）。
   *
   * `options` = Python 的关键字形参 `(type="gauge", labels=None, ts=None)`；`ts` 非 None 时按
   * `float(ts)` 转（**这一步的异常照 Python 往外抛**，因为它不在丢弃分支里）。
   */
  sample(metric, value, options = {}) {
    let type = pyGet(options, 'type', 'gauge');
    if (!(type === 'gauge' || type === 'counter')) type = 'gauge';
    let val;
    try {
      val = py_float(value);
    } catch (e) {
      if (e instanceof TypeError || e instanceof ValueError) return;
      throw e;
    }
    const tsRaw = pyGet(options, 'ts', null);
    const obj = {
      ts: tsRaw !== null ? py_float(tsRaw) : Date.now() / 1000,
      metric: pyStr(metric),
      value: val,
      type,
    };
    const lb = MetricsWriter._norm_labels(pyGet(options, 'labels', null));
    if (pyTruthy(lb)) obj.labels = lb;
    this._write(obj);
  }

  /**
   * 瞬时值样本（标签以末位对象给出，如 `w.gauge("rps", 10, {group: "下单"})`）。
   *
   * `ts` 是**样本时间戳**（缺省取写入时刻），不是标签——末位对象的 `ts` 键被显式解构掉，
   * 绝不会落进 labels（历史缺陷：签名缺 ts 时 `w.gauge(..., ts=t)` 会把 t 写成维度，
   * 见 bug_report/20261004_2040）。Python 是 `(metric, value, ts=None, **labels)`。
   */
  gauge(metric, value, kwargs = {}) {
    const { ts = null, ...labels } = kwargs ?? {};
    this.sample(metric, value, { type: 'gauge', labels, ts });
  }

  /** 累计计数样本（值须单调不减，如委托数/总请求数）；`ts` 语义同 gauge */
  counter(metric, value, kwargs = {}) {
    const { ts = null, ...labels } = kwargs ?? {};
    this.sample(metric, value, { type: 'counter', labels, ts });
  }

  /** 写一条 meta 上下文行（None 值字段丢弃） */
  meta(fields = {}) {
    const obj = { kind: 'meta', ts: Date.now() / 1000 };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v !== null && v !== undefined) obj[k] = v;
    }
    this._write(obj);
  }

  /** 写收尾 KPI 行（values 必须是 dict；空白/非 dict 忽略） */
  summary(values) {
    if (!(values !== null && typeof values === 'object' && !Array.isArray(values))
        || Object.keys(values).length === 0) {
      return;
    }
    const out = {};
    for (const [k, v] of Object.entries(values)) out[pyStr(k)] = v;
    this._write({ kind: 'summary', ts: Date.now() / 1000, values: out });
  }
}

/**
 * 把当秒窗口 + 累计计数写成一屏规范样本（口径与默认面板/模板一致）。
 *
 * 全局：rps / err.rate / lat.p50|p90|p99 / conc + 累计 req.total / req.errors；
 * 分接口：rps / err.rate / lat.p95，带 labels={"group": 组名}。
 */
export function _emit_tick(w, ts, conc, win, total) {
  const allw = win.__all__;
  const count = py_float(allw.count);
  w.sample('rps', count, { ts });
  w.sample('err.rate', pyTruthy(count) ? allw.err / count : 0.0, { ts });
  w.sample('conc', pyInt(conc), { ts });
  for (const pct of [50, 90, 99]) {
    const val = _pct_from_buckets(allw.buckets, pct);
    if (val !== null) w.sample(`lat.p${pct}`, val, { ts });
  }
  for (const [name, g] of Object.entries(win)) {
    if (name === '__all__') continue;
    const gCount = py_float(g.count);
    w.sample('rps', gCount, { labels: { group: name }, ts });
    w.sample('err.rate', pyTruthy(gCount) ? g.err / gCount : 0.0, { labels: { group: name }, ts });
    const gP95 = _pct_from_buckets(g.buckets, 95);
    if (gP95 !== null) w.sample('lat.p95', gP95, { labels: { group: name }, ts });
  }
  const tAll = total.__all__;
  w.counter('req.total', tAll.count, { ts });
  w.counter('req.errors', tAll.err, { ts });
}

// --------------------------------------------------------------------------
// 发压
// --------------------------------------------------------------------------

/**
 * Python `str.encode("latin-1")`：非 latin-1 字符抛 `UnicodeEncodeError`（照 `http.client._encode`）。
 *
 * 为什么必须按 latin-1 而不是 utf-8：`http.client` 对 str body / str header 值一律走
 * `_encode(...) = data.encode("latin-1")`（RFC 2616 §3.7.1 的默认字符集），utf-8 会在线上
 * 发出**不同的字节**；非 latin-1 字符则是 Python 抛 `UnicodeEncodeError`、线程死掉。
 * 文案照 CPython：单个字符 `character in position N`，连续多个 `characters in position a-b`。
 */
function _latin1(text) {
  const s = String(text);
  let start = -1;
  for (let i = 0; i <= s.length; i += 1) {
    const bad = i < s.length && s.charCodeAt(i) > 0xff;
    if (bad && start < 0) start = i;
    if (!bad && start >= 0) {
      const span = i - 1 === start ? `character in position ${start}`
        : `characters in position ${start}-${i - 1}`;
      throw new UnicodeEncodeError(`'latin-1' codec can't encode ${span}: `
        + 'ordinal not in range(256)');
    }
  }
  return Buffer.from(s, 'latin1');
}

/** 按解析后的 base 建一条 keep-alive 连接（Python: `HTTPConnection/HTTPSConnection`） */
function _new_conn(base, timeout_s) {
  const mod = base.scheme === 'https' ? https : http;
  const port = pyTruthy(base.port) ? base.port : (base.scheme === 'https' ? 443 : 80);
  const agent = new mod.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  return {
    mod, agent, hostname: base.hostname, port, timeout_s, broken: false,
  };
}

/** 关掉一条连接（Python: `conn.close()`） */
function _close_conn(conn) {
  try {
    conn.agent.destroy();
  } catch { /* 已关 */ }
}

/**
 * 在给定连接上发一次请求，返回 `{conn, ok, bucket, err_cls}`。
 *
 * conn 传 null 或遇到连接类错误时返回 `conn: null`（调用方下轮重建连接）；
 * 响应体必须读掉（`res.resume()`），否则 keep-alive 连接无法复用（照 `resp.read()`）。
 *
 * 一处照抄 Python 的关键细节：**超时后连接留在「半开」状态**（Python 的 `HTTPConnection`
 * 停在 `_CS_REQ_SENT`，sock 未关），下一次 `request()` 抛 `CannotSendRequest`（HTTPException）
 * ⇒ 记一次 `conn_err` 再重建。不照抄的话，超时后的 err_breakdown 会比 oracle 少一次 conn_err。
 * Node 侧额外 destroy 掉那条 socket（Python 把它留到下次 `close()`）：只为不让悬挂 handle
 * 拖住进程退出，分类结果不变。
 */
function _one_request(base, conn, group, timeout_s) {
  if (conn === null) conn = _new_conn(base, timeout_s);
  else if (conn.broken) {
    _close_conn(conn);
    return Promise.resolve({
      conn: null, ok: false, bucket: null, err_cls: 'conn_err',
    });
  }
  const method = group.method;
  const reqPath = group.path;
  const withBody = !(method === 'GET' || method === 'HEAD');
  const body = withBody ? pyGet(group, 'body', null) : null;
  const headers = {};
  for (const [k, v] of Object.entries(pyGet(group, 'headers', null) ?? {})) {
    headers[k] = typeof v === 'string' ? _latin1(v) : pyStr(v);
  }
  let bodyBuf = null;
  if (body !== null && body !== undefined) bodyBuf = _latin1(body);

  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const connErr = () => {
      if (settled) return;         // 已结算（成功/4xx/5xx/超时）后的事件不再动连接
      _close_conn(conn);
      conn.broken = true;
      finish({
        conn: null, ok: false, bucket: null, err_cls: 'conn_err',
      });
    };
    let req;
    try {
      req = conn.mod.request({
        hostname: conn.hostname,
        port: conn.port,
        method,
        path: reqPath,
        headers,
        agent: conn.agent,
      }, (res) => {
        const status = res.statusCode;
        res.resume();                                  // 丢弃响应体（照 resp.read()）
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (status >= 200 && status < 400) {         // 3xx 视为成功（压测不跟随重定向）
            finish({
              conn, ok: true, bucket: _bucket_of(ms), err_cls: null,
            });
          } else {
            finish({
              conn, ok: false, bucket: null, err_cls: status < 500 ? '4xx' : '5xx',
            });
          }
        });
        res.on('aborted', connErr);
        res.on('error', connErr);
      });
    } catch (e) {
      connErr();
      return;
    }
    req.setTimeout(timeout_s * 1000, () => {
      if (settled) return;         // 响应已结算：这是 keep-alive 空闲 socket 的过期 timeout，不动它
      timedOut = true;
      // Python 超时后不关闭连接（留在 _CS_REQ_SENT）；这里只销毁 socket 释放 handle，
      // 并用 broken 标记让下一次请求产出同样的 conn_err。
      try {
        req.destroy();
      } catch { /* 已销毁 */ }
      conn.broken = true;
      finish({
        conn, ok: false, bucket: null, err_cls: 'timeout',
      });
    });
    req.on('error', (e) => {
      if (timedOut || settled) return;                 // 已按 timeout/响应结算
      connErr();
    });
    if (bodyBuf !== null) req.write(bodyBuf);
    req.end();
  });
}

/** 按 weight 加权随机选一组（权重越大被压得越多） */
export function _pick_group(groups) {
  let total = 0;
  for (const g of groups) total += g.weight;
  let x = Math.floor(Math.random() * total);           // Python: random.randrange(total)
  for (const g of groups) {
    x -= g.weight;
    if (x < 0) return g;
  }
  return groups[groups.length - 1];
}

/**
 * 单工作 worker：keep-alive 连接循环发请求，直到档位截止或 stop() 为真。
 *
 * `UnicodeEncodeError` 照 Python 的线程语义**只结束本 worker**（Python 里该异常顺着 `_worker`
 * 逃逸、线程静默死掉，`t.join()` 照样返回、其余 worker 照跑）。
 */
async function _worker(base, groups, timeout_s, deadline, agg, stop) {
  let conn = null;
  while (Date.now() / 1000 < deadline && !stop()) {
    const g = _pick_group(groups);
    let res;
    try {
      res = await _one_request(base, conn, g, timeout_s);      // eslint-disable-line no-await-in-loop
    } catch (e) {
      if (e instanceof UnicodeEncodeError) return;
      throw e;
    }
    conn = res.conn;
    agg.add(g.name, res.ok, res.bucket, res.err_cls);
  }
}

/** 追加文本到日志文件（utf-8，失败静默——日志是尽力而为的附属产物） */
function _append(filePath, text) {
  try {
    fs.appendFileSync(filePath, Buffer.from(text, 'utf8'));
  } catch { /* 照 Python：吞 OSError */ }
}

const _sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 执行压测（直到全部档位完成 / should_stop / 快速失败）。
 *
 * 返回 `[report, summary_line]`。快照每秒一行追加 snap_path（旧格式，保留）；metrics_path 非空
 * 时同步产出规范指标行（新前端读它），开头补 meta 行、收尾补 summary 行（快速失败/停止同样
 * 收尾）。人类可读进度每 10 秒追加 log_path。目标不可达抛 QuickFailError。
 *
 * `options` = Python 的关键字形参 `(log_path, snap_path, should_stop=None, metrics_path=None)`。
 * Node 侧是 async（见文件头 ①）。
 */
export async function run_load(scenario, options = {}) {
  const logPath = pyGet(options, 'log_path', null);
  const snapPath = pyGet(options, 'snap_path', null);
  const shouldStop = pyGet(options, 'should_stop', null);
  const metricsPath = pyGet(options, 'metrics_path', null);
  const stop = shouldStop || (() => false);
  const base = _parse_base(scenario.base_url);
  const groups = scenario.groups;
  const timeoutS = scenario.timeout_ms / 1000.0;
  const agg = new _Agg(groups.map((g) => g.name));
  const started = Date.now() / 1000;
  let peakRps = 0.0;
  let aborted = false;                                 // 快速失败标志
  let done = false;                                    // 整个发压结束标志（通知 ticker 退出）
  const curStage = [0, 0];                             // 当前 [档位号, 并发数]（ticker 读）
  const stageStats = [];                               // 每档结束时的差值指标

  const snapFd = fs.openSync(snapPath, 'a');           // Python: open(snap_path, "ab")，失败即抛
  const w = pyTruthy(metricsPath) ? new MetricsWriter(metricsPath) : null;
  if (w) {
    w.meta({
      target: scenario.base_url,
      case: scenario.name,
      stages: scenario.stages.map((s) => ({ conc: s.conc, seconds: s.seconds })),
    });
  }

  /** 每秒：取走当秒窗口 → 快照行 + 规范指标行 + 每 10s 进度日志 + 快速失败判定 */
  const ticker = (async () => {
    let n = 0;
    const quick = { count: 0, err: 0, conn_like: 0 };
    while (!done) {
      await _sleep(1000.0);                            // eslint-disable-line no-await-in-loop
      if (done) break;
      const win = agg.take_window();
      const allw = win.__all__;
      n += 1;
      peakRps = Math.max(peakRps, py_float(allw.count));
      const now = Math.trunc(Date.now() / 1000);       // Python: int(time.time())
      const line = {
        ts: now,
        stage: curStage[0],
        conc: curStage[1],
        rps: py_float(allw.count),
        err: allw.err,
        groups: Object.fromEntries(Object.entries(win)
          .filter(([k]) => k !== '__all__')
          .map(([k, v]) => [k, { rps: py_float(v.count), err: v.err, lat: { ...v.buckets } }])),
      };
      try {
        fs.writeSync(snapFd, Buffer.from(`${pyJsonDumps(line)}\n`, 'utf8'));
      } catch { /* 照 Python：吞 OSError */ }
      if (w) _emit_tick(w, now, curStage[1], win, agg.copy_total());
      if (n % 10 === 0) {
        _append(logPath, `### 进度 t=${n}s 档${curStage[0]} RPS=${allw.count} 错误=${allw.err}\n`);
      }
      // 快速失败观察窗累计（连接超时/失败 视为「目标不可达」类）
      if (n <= QUICK_FAIL_SECONDS) {
        quick.count += allw.count;
        quick.err += allw.err;
        quick.conn_like += allw.err_cls.conn_err + allw.err_cls.timeout;
        if (n === QUICK_FAIL_SECONDS && quick.count > 0
            && quick.err === quick.count && quick.conn_like === quick.err) {
          aborted = true;
          done = true;
        }
      }
    }
  })();

  try {
    for (let i = 0; i < scenario.stages.length; i += 1) {
      const st = scenario.stages[i];
      if (stop() || aborted) break;
      curStage[0] = i + 1;
      curStage[1] = st.conc;
      const t0Copy = agg.copy_total();
      const deadline = Date.now() / 1000 + st.seconds;
      const workers = [];
      for (let k = 0; k < st.conc; k += 1) {
        // 挂一个兜底 catch：Python 的线程异常只打 traceback、run_load 照常返回；
        // 不吞掉的话 Promise.all 会把整轮发压判失败（那是**更响**但不等价的行为）。
        const p = _worker(base, groups, timeoutS, deadline, agg, () => stop() || aborted)
          .catch((e) => {
            process.stderr.write(`Exception in thread worker: ${e && e.message ? e.message : e}\n`);
          });
        workers.push(p);
      }
      await Promise.all(workers);                      // eslint-disable-line no-await-in-loop
      const dt = agg.copy_total();
      // 档位指标一律取当档差值（count/err/err_cls/buckets 逐键 dt − t0），
      // 否则多档位时各档分位数/错误分类会混入前档累计数据
      const t0a = t0Copy.__all__;
      const dta = dt.__all__;
      const deltaAll = {
        count: dta.count - t0a.count,
        err: dta.err - t0a.err,
        err_cls: Object.fromEntries(Object.keys(dta.err_cls)
          .map((k) => [k, dta.err_cls[k] - t0a.err_cls[k]])),
        buckets: Object.fromEntries(Object.keys(dta.buckets)
          .map((k) => [k, dta.buckets[k] - t0a.buckets[k]])),
      };
      stageStats.push({
        conc: st.conc, seconds: st.seconds, ..._metrics(deltaAll, st.seconds),
      });
    }
  } finally {
    done = true;
    await ticker;
    fs.closeSync(snapFd);
  }
  if (aborted) {
    if (w) {
      const t = agg.copy_total().__all__;
      w.summary({ 总请求: t.count, 错误数: t.err, 结果: '快速失败' });
      w.close();
    }
    throw new QuickFailError('快速失败：发压前 10 秒请求全部为连接超时/失败，'
      + '目标服务可能不可达');
  }

  const duration = Date.now() / 1000 - started;
  const total = agg.copy_total();
  const report = {
    scenario: scenario.name,
    base_url: scenario.base_url,
    started_at: strftime_local(new Date(started * 1000), '%Y-%m-%d %H:%M:%S'),
    duration_sec: pyRound(duration, 1),
    stopped: pyTruthy(stop()),
    stages: stageStats,
    overall: _metrics(total.__all__, duration, peakRps),
    groups: Object.fromEntries(groups.map((g) => [g.name, _metrics(total[g.name], duration)])),
  };
  const o = report.overall;
  const summaryLine = `LOAD 总请求=${o.total} 错误率=${_pyFixed(o.err_rate * 100, 1)}%`
    + ` P50=${py_field_str(o.p50)}ms P99=${py_field_str(o.p99)}ms 平均RPS=${py_field_str(o.rps_avg)}`
    + (report.stopped ? '（用户停止）' : '');
  if (w) {
    // 收尾 KPI：与 report.overall 同源，供面板单值卡与脚本驱动报告共用
    w.summary({
      总请求: o.total,
      错误率: `${_pyFixed(o.err_rate * 100, 2)}%`,
      平均RPS: o.rps_avg,
      峰值RPS: pyGet(o, 'rps_peak', 0),
      P50: o.p50,
      P90: o.p90,
      P99: o.p99,
    });
    w.close();
  }
  return [report, summaryLine];
}

// --------------------------------------------------------------------------
// 报告
// --------------------------------------------------------------------------

/** 错误分类 dict → "4xx=1 5xx=0 超时=2 连接=3" 形式的短文本 */
export function _fmt_errs(err_cls) {
  return `4xx=${pyGet(err_cls, '4xx', 0)} 5xx=${pyGet(err_cls, '5xx', 0)}`
    + ` 超时=${pyGet(err_cls, 'timeout', 0)} 连接=${pyGet(err_cls, 'conn_err', 0)}`;
}

/** 报告 Markdown 文本：总览 + 档位 + 分接口三张表 */
export function _report_md(report) {
  const o = report.overall;
  const lines = [
    `# 压测报告：${report.scenario}`, '',
    `- 目标：${report.base_url}`,
    `- 开始：${report.started_at} · 时长 ${py_field_str(report.duration_sec)}s`
      + (pyTruthy(pyGet(report, 'stopped', null)) ? '（用户停止，部分结果）' : ''), '',
    '## 总览', '',
    '| 指标 | 值 |', '|---|---|',
    `| 总请求 | ${o.total} |`,
    `| 错误率 | ${_pyFixed(o.err_rate * 100, 2)}% |`,
    `| 平均 RPS | ${py_field_str(o.rps_avg)} |`,
    `| 峰值 RPS | ${py_field_str(pyGet(o, 'rps_peak', '-'))} |`,
    `| P50 / P90 / P99 | ${py_field_str(o.p50)} / ${py_field_str(o.p90)} / ${py_field_str(o.p99)} ms |`,
    `| max（近似） | ${_pyIntFieldStr(o.max)} ms |`,
    `| 错误分类 | ${_fmt_errs(o.err_breakdown)} |`, '',
    '## 档位', '',
    '| 并发 | 时长(s) | RPS | 错误率 |', '|---|---|---|---|',
  ];
  for (const s of report.stages) {
    lines.push(`| ${s.conc} | ${s.seconds} | ${py_field_str(s.rps_avg)} | ${_pyFixed(s.err_rate * 100, 2)}% |`);
  }
  lines.push('', '## 分接口', '',
    '| 接口 | 请求 | 错误率 | P50 | P90 | P99 | max |', '|---|---|---|---|---|---|---|');
  for (const [name, g] of Object.entries(report.groups)) {
    lines.push(`| ${name} | ${g.total} | ${_pyFixed(g.err_rate * 100, 2)}%`
      + ` | ${py_field_str(g.p50)} | ${py_field_str(g.p90)} | ${py_field_str(g.p99)} | ${_pyIntFieldStr(g.max)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 报告落盘：`<report_dir>/task<id>_<运行键>.{json,md}`。返回 `[json_path, md_path]`。
 *
 * 文件名只含 task id + 运行键（场景名可能含中文/特殊字符，不进文件名）；
 * 同任务重跑产生新运行键的文件，读侧按运行键/最新取用。
 * run_key 为空时回落分钟级命名（存量路径与单测用）。
 */
export function write_report_files(report, report_dir, task_id, run_key = '') {
  fs.mkdirSync(report_dir, { recursive: true });
  const stem = path.join(report_dir,
    `task${task_id}_${run_key || strftime_local(new Date(), '%Y%m%d_%H%M')}`);
  fs.writeFileSync(`${stem}.json`, pyJsonDumpsIndent(report, 1), 'utf8');
  fs.writeFileSync(`${stem}.md`, _report_md(report), 'utf8');
  return [`${stem}.json`, `${stem}.md`];
}

// --------------------------------------------------------------------------
// 命令行入口（平台发压轮的 scenario 驱动调用）
// --------------------------------------------------------------------------

const _DEVNULL = process.platform === 'win32' ? 'nul' : '/dev/null';

/**
 * run 子命令：校验场景 → 发压 → 报告落盘，返回进程退出码。
 *
 * 退出码 0=正常 / 2=场景非法 / 3=快速失败 / 4=其它异常（runner 据此判 failed）。
 * stdout 输出一行 LOAD 摘要（平台把它留在发压日志里），stderr 输出失败原因。
 */
export async function _cmd_run(args) {
  const [scenario, err] = validate_scenario(args.scenario);
  if (err) {
    process.stderr.write(`场景校验失败：${err}\n`);
    return 2;
  }
  const shouldStop = args.stop_file
    ? (() => fs.existsSync(args.stop_file))
    : null;
  let report;
  let summaryLine;
  try {
    [report, summaryLine] = await run_load(scenario, {
      log_path: args.log || _DEVNULL,
      snap_path: args.snapshot || _DEVNULL,
      should_stop: shouldStop,
      metrics_path: args.metrics || null,
    });
  } catch (e) {
    if (e instanceof QuickFailError) {
      process.stderr.write(`${e.message}\n`);
      return 3;
    }
    process.stderr.write(`发压异常：${e && e.message !== undefined ? e.message : e}\n`);
    return 4;
  }
  if (args.report_dir && args.task_id) {
    try {
      write_report_files(report, args.report_dir, args.task_id, args.run_key || '');
    } catch (e) {
      if (!_isOsError(e)) throw e;
      process.stderr.write(`报告写盘失败：${py_error_str(e)}\n`);
    }
  }
  process.stdout.write(`${summaryLine}\n`);
  return 0;
}

/** `run` 子命令的形参（argparse 的 `--flag value` / `--flag=value` 两种写法都认） */
const RUN_FLAGS = new Map([
  ['--scenario', 'scenario'],
  ['--metrics', 'metrics'],
  ['--snapshot', 'snapshot'],
  ['--log', 'log'],
  ['--stop-file', 'stop_file'],
  ['--report-dir', 'report_dir'],
  ['--task-id', 'task_id'],
  ['--run-key', 'run_key'],
]);

/**
 * 手写 argv 解析（Python 用 argparse）。
 *
 * 只复刻**对外行为**：`run` 子命令必填、`--scenario` 必填、未知参数报错，错误一律
 * stderr + 退出码 2（argparse 的 `usage:` 文案不逐字节复刻——那是帮助文本不是行为契约，
 * 对拍用例里两条 argparse 错误路径只钉退出码）。
 */
function _parseRunArgv(argv) {
  const out = {
    scenario: null, metrics: '', snapshot: '', log: '', stop_file: '',
    report_dir: '', task_id: 0, run_key: '',
  };
  const bad = (msg) => {
    process.stderr.write(`loadgen.js: error: ${msg}\n`);
    return null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    let key = argv[i];
    let value = null;
    const eq = key.indexOf('=');
    if (key.startsWith('--') && eq > 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key === '-h' || key === '--help') {
      process.stdout.write('usage: loadgen.js run --scenario SCENARIO [--metrics M] '
        + '[--snapshot S] [--log L] [--stop-file F] [--report-dir D] [--task-id N] [--run-key K]\n');
      return 'help';
    }
    const field = RUN_FLAGS.get(key);
    if (!field) return bad(`unrecognized arguments: ${argv[i]}`);
    if (value === null) {
      i += 1;
      if (i >= argv.length) return bad(`argument ${key}: expected one argument`);
      value = argv[i];
    }
    if (field === 'task_id') {
      if (!/^[+-]?[0-9]+$/.test(value)) return bad(`argument --task-id: invalid int value: '${value}'`);
      out.task_id = Number(value);
    } else {
      out[field] = value;
    }
  }
  if (out.scenario === null) return bad('the following arguments are required: --scenario');
  return out;
}

/**
 * 命令行入口：`node backend/lib/loadgen.js run --scenario … --metrics …`。
 * 返回退出码（照 Python 的 `sys.exit(main())`）。
 */
export async function main(argv = null) {
  const args = argv === null ? process.argv.slice(2) : argv;
  if (args.length === 0 || args[0] !== 'run') {
    process.stderr.write(`loadgen.js: error: the following arguments are required: cmd`
      + `（可用：run；收到 ${JSON.stringify(args[0] ?? null)}）\n`);
    return 2;
  }
  const parsed = _parseRunArgv(args.slice(1));
  if (parsed === null) return 2;
  if (parsed === 'help') return 0;
  return _cmd_run(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}

// --------------------------------------------------------------------------
// camelCase 别名（JS 调用方用；量具按 Python 名反射，用不到这一套）
// --------------------------------------------------------------------------

export {
  validate_scenario as validateScenario,
  write_report_files as writeReportFiles,
  run_load as runLoad,
  _cmd_run as _cmdRun,
  _bucket_of as _bucketOf,
  _pct_from_buckets as _pctFromBuckets,
  _max_from_buckets as _maxFromBuckets,
  _metrics as _metricsOf,
  _fmt_errs as _fmtErrs,
  _report_md as _reportMd,
  _pick_group as _pickGroup,
  _emit_tick as _emitTick,
};
