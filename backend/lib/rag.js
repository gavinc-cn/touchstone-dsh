/**
 * `rag.py`（553 行，仓库根）的 Node 对应物（Node 后端 M6-3）。
 *
 * Touchstone 案例库语义检索（RAG）底座：API 嵌入（OpenAI 兼容 `/v1/embeddings`）+ 纯标准库
 * BM25 兜底 + RRF 混合排序。派生索引落 `<案例库根>/.live/`（`rag_index.jsonl` /
 * `similar.jsonl`），原子写、可随时重建；未配置（`~/.touchstone/rag.json` 不存在）时一切
 * 功能 no-op；任何检索故障静默降级，永不阻塞任务。
 *
 * ── 导出名 ────────────────────────────────────────────────────────────────────
 * 主名**照 Python 名**（`load_config`/`_bm25_search`/…），文件末尾再给一套 camelCase 别名
 * （`loadConfig`/`_bm25Search`/…）供 JS 调用方使用——`export-cases.js` 的 `--semantic` 分支
 * 已按 `rag.loadConfig()` / `await rag.retrieve(...)` 调用（该文件 M6-2 先落，契约在它那边）。
 * 对拍用例的 `fn` 写 Python 名、`nodeFn` 写本文件的导出名，逐条对齐、不靠命名巧合。
 *
 * ── 与 Python 的三处**形态**差异（都已在调用方或量具里显式对齐） ─────────────────
 * ① **异步**：Python 用同步 `urllib`，Node 的 `fetch` 只有异步形态 ⇒ `_post_embeddings` /
 *    `test_connection` / `refresh` / `retrieve_detail` / `retrieve` / `cmd_rebuild` /
 *    `cmd_search` / `main` 返回 Promise。`await` 一个同步值是无害的，故 `export-cases.js`
 *    的 `await rag.retrieve(...)` 两种形态都能用。**其余函数保持同步**（纯算法/文件）。
 * ② **元组 → 数组**：Python 的 `(rows, meta)` 在 JS 侧就是 `[rows, meta]`（不用对象），
 *    对拍无需 `shape` 适配。
 * ③ **错误类型**：Python 的 `ValueError`/`KeyError`/`AttributeError`/`OverflowError` 在本文件里
 *    有同名 JS 类（`constructor.name` 与 Python 的 `type(exc).__name__` 逐字相同），
 *    故「两侧同抛」的对拍分支能比 `$kind`；消息也逐字照抄（含中文文案）。
 * ④ **`scan_cases` 自带一份**（不 import `export-cases.js`）：那条 import 会与它的 TLA 入口
 *    构成异步模块环而死锁，详见 `scanCases` 的注释（含最小复现与「改回一行 import」的条件）。
 *
 * ── 逐点等价的口径（每条都对着 rag.py 核过） ─────────────────────────────────────
 * 1. **截断按码点**：`[:EMBED_TEXT_MAX]`(2000) / `[:4000]` / `[:200]` 是 Python 的
 *    「码点切片」。JS 的 `slice` 按 UTF-16 码元 —— emoji（代理对）落在边界上时，
 *    `slice` 会切出半个代理 ⇒ 用 `pySliceCodePoints`（迭代器按码点走）。
 * 2. **银行家舍入**：`round(s, 4)` 是 CPython 的「十进制正确舍入 + 半偶」。JS 的
 *    `Math.round`/`toFixed` 是半**上**入，且在 `0.15625` 这类**可精确表示**的十进制中点
 *    上真的会分叉 ⇒ 用 `pyRound`（BigInt 精确分解 double → 半偶 → 十进制串 → `Number`）。
 * 3. **`or` 的真值口径**：Python 的 `x or d` 用 `bool(x)`（空 list/dict/""/0/None 皆假），
 *    JS 的 `||` 里空数组/空对象是**真** ⇒ 用 `pyOr`（`pyTruthy` 照 Python 的 `bool()`）。
 * 4. **`json.dumps` 的两种形态**：
 *    - `_atomic_write_jsonl` / `cmd_rebuild` 的无缩进 `ensure_ascii=False` → `pyJsonDumps`；
 *    - `save_config` 的 `indent=2` → `pyJsonDumpsIndent(v, 2)`，末尾补 `"\n"` 照 `f.write("\n")`；
 *    - `_post_embeddings` 的请求体是 `json.dumps(...)` **默认**（`ensure_ascii=True`）——
 *      中文会被转成 `\uXXXX`、星平面字符转成**代理对**转义，分隔符 `", "` / `": "`。
 *      这在 `pyjson.js` 的口径之外（它只做 `ensure_ascii=False`），故本文件内实现
 *      `pyJsonDumpsAscii`（私有，仅用于请求体，测试里逐字节钉住）。
 * 5. **`str.splitlines()`**（`_load_index`/`_load_jsonl`）比分 `"\n"` 多切 8 个字符
 *    （`\v \f \x1c-\x1e \x85 \u2028 \u2029`）⇒ 用 `pySplitLines`（`read_text` 已先把
 *    `\r\n`/`\r` 折成 `\n`）。
 * 6. **`os.path`**：`join` 用 lib.js 的 `pyJoin`（后段绝对路径覆盖前段）、`relpath` 用
 *    `path.relative` + 「同路径给 `.`」（见私有 `scanCases`）；mtime 浮点用 `pyMtimeFloat`
 *    （CPython 是「秒 + 纳秒×1e-9」两次舍入，不是 `ns/1e9`）。
 * 7. **`int()`**：`_cfg_int` 与 `refresh` 的 `int(cfg.get("batch_size") or 16)` 都走 `pyInt`
 *    （bool → 0/1、float 向零截断、str 支持两侧空白与 `1_0` 下划线、非法串抛
 *    `invalid literal for int() with base 10: …`）。
 * 8. **排序**：`sorted(index)` / `sorted(v)`（RRF 的 via）用 `pyStrCompare`（Python 按**码点**，
 *    JS 默认按 UTF-16 码元，星平面字符上会分叉）；按分数降序的 `sort(..., reverse=True)`
 *    用「比较器取反」，保持相等元素的稳定次序（与 Python 同）。
 *
 * ── 已知的残余差异（原理性/未验；不要当 bug 修，见 M6-3 报告） ───────────────────
 *   - **`.live/*.jsonl` 里「整数值的浮点」字节不同**：`_norm([1,0])` 在 Python 是
 *     `[1.0, 0.0]`、JS 是 `[1, 0]`；`round(0.0,4)` 同理（Python 写 `0.0`、JS 写 `0`）。
 *     JS 的 number 没有 int/float 之分，`pyjson.js` 文件头已把这条列为不可消除；对拍夹具
 *     刻意避开整数值浮点（cosine 取非整数）以免用白名单掩盖它。
 *   - **`json.loads` 的 `NaN`/`Infinity`**：CPython 默认接受这三个字面量，`JSON.parse` 不接受
 *     ⇒ 坏索引行/坏配置里出现它们时，Python 会解析、JS 会当「损坏」跳过（索引可自愈）。
 *   - **`re.findall` 的 Unicode 数字**：`tokenize` 的 `[A-Za-z0-9_]` 是 ASCII 口径，两侧同；
 *     但 `pyInt` 只认 ASCII 数字（Python `int("١٢")` 能过）——与 lib.js 文件头 ③ 同一条备案。
 *   - **HTTP 错误文案**：urllib 是 `HTTP Error 401: Unauthorized`、`<urlopen error [Errno 111] …>`，
 *     fetch 是 `HTTP Error 401: …` / `fetch failed` ⇒ 网络失败分支的 `vec_error` 文案两侧不同
 *     （对拍刻意不让任何 op 真的发起请求；见用例 note）。
 *   - **BN25 求和次序**：Python `set(tokenize(query))` 的迭代序是哈希序（harness 固定
 *     `PYTHONHASHSEED=0` 也只是「确定」而不是「与 JS 插入序相同」）⇒ 一个文档被**多个不同
 *     查询词**命中时，浮点累加次序可能不同、末位可能分叉。对拍语料只用「单词查询 / 各命中
 *     不相交文档」的查询，避免把这件事用白名单盖掉。
 *   - **`pyLog` 与本地 libm 的 1 ULP 残余**：BM25 的 IDF 用 `pyLog`（正确舍入）。oracle 的
 *     `math.log` 是本地 libm 的实现，本身**并非**处处正确舍入 ⇒ n ≤ 2000 的可达参数里仍有
 *     1,915/2,001,000（0.096%）差 1 ULP（n ≤ 8 的小语料 0/36 全中）。这是两侧「同一个公式、
 *     两个 libm」的固有残差；影响限于「几乎同分」时的排序与逐位比，4 位小数的输出不受影响。
 *     要彻底消除只能照搬 glibc 的 log 算法（表 + 双 double），不划算；对拍用例把语料控制在
 *     n ≤ 8 并用已核对的参数钉住原始得分。
 *
 * 零 npm 依赖：只用 node:crypto / node:fs / node:os / node:path。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 案例库扫描：**单一实现**在 `export-cases.js`（M6-2 落地，本模块只 import）。
// 2026-10-13 M6-3 的一处收口：这里一度自带过一份私有副本——因为 export-cases.js 的 CLI 入口
// 曾是**顶层 await**，与本模块的静态反向 import 构成异步模块环而死锁（症状：--semantic
// 分支 Detected unsettled top-level await + exit 13）。入口改成 main().then(...) 后环消失，
// 私有副本删掉，改回下面这行 import（重复实现归零）。
import { scanCases } from './export-cases.js';
import { localizable, t } from './i18n.js';
import { pyJoin, pyMtimeFloat, pyStrCompare, pyStrip, readText } from './lib.js';
import { pyJsonDumps, pyJsonDumpsIndent } from './pyjson.js';

// 派生文件名（<案例库根>/.live/ 下，平台维护，agent 只读）
export const RAG_INDEX_NAME = 'rag_index.jsonl';
export const SIMILAR_NAME = 'similar.jsonl';
// 嵌入源文本截断长度（字符）；近邻条数；检索默认 top-k
export const EMBED_TEXT_MAX = 2000;
export const TOPK_SIMILAR = 5;
export const DEFAULT_K = 8;
// RRF 常数（标准 60）；融合前单路候选数；BM25 参数（标准值）
export const RRF_K = 60;
export const CAND_TOP = 20;
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
// BM25 内存缓存 TTL（秒），key=案例库根+扫描签名
export const CACHE_TTL = 1.0;
// 嵌入请求失败重试次数（加首次共 2 次尝试）
export const HTTP_RETRY = 1;
// 未显式配置时的缺省请求超时（秒）与嵌入批量大小（load_config 兜底 / 管理页保存校验同源）
export const DEF_TIMEOUT_S = 30;
export const DEF_BATCH_SIZE = 16;


// --------------------------------------------------------------------------
// Python 语义小工具（错误类 / 真值 / str() / 码点切片 / round / int / json）
// --------------------------------------------------------------------------

/**
 * Python `ValueError` 的同名 JS 类。
 *
 * 为什么要类名：对拍里「两侧同抛」的分支会逐字比 `$kind`（探针取 `type(exc).__name__`、
 * worker 取 `constructor.name`）——用裸 `Error` 会变成永久差异，只能靠白名单盖住。
 */
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Python `KeyError`（`str(exc)` 是**键的 repr**，如 `'dir'`） */
export class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}

/** Python `AttributeError`（`'int' object has no attribute 'strip'` 这类） */
export class AttributeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttributeError';
  }
}

/** Python `OverflowError`（`int(inf)` 走这条；`_cfg_int` 只 catch `(TypeError, ValueError)`） */
export class OverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OverflowError';
  }
}

/** Python `IndexError` */
export class IndexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexError';
  }
}

/** Python `bool(x)`：空串/空容器/0/None 假；JS 的 `[]`/`{}` 在 `||` 里是真，必须区分 */
export function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  switch (typeof value) {
    case 'boolean': return value;
    case 'number': return value !== 0 && !Number.isNaN(value);
    case 'string': return value !== '';
    case 'object':
      return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
    default: return true;
  }
}

/** Python `x or d` */
function pyOr(value, fallback) {
  return pyTruthy(value) ? value : fallback;
}

/** Python 类型名（只用于错误文案；int/float 在 JS 里已不可分，按是否整数猜） */
function pyTypeName(value) {
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

/** Python `repr(str)` 的可用子集（单引号、转义反斜杠/引号/控制字符） */
function pyReprString(text) {
  let out = "'";
  for (const ch of String(text)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f) {
      out += `\\x${ch.codePointAt(0).toString(16).padStart(2, '0')}`;
    } else out += ch;
  }
  return `${out}'`;
}

/**
 * Python `str(x)`：`None`→`"None"`、`True`→`"True"`、容器走 repr。
 *
 * 浮点整数值（`1.0`）在 JS 里就是 `1` ⇒ 输出 `"1"`（`pyjson.js` 文件头同一条不可消除差异）。
 */
export function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const items = Object.keys(value).map((k) => `${pyRepr(k)}: ${pyRepr(value[k])}`);
    return `{${items.join(', ')}}`;
  }
  throw new TypeError(`str() 不支持 ${typeof value}`);
}

/** Python `repr(x)` 的可用子集（str 走 repr 规则，其余用 `pyStr`） */
function pyRepr(value) {
  if (typeof value === 'string') return pyReprString(value);
  return pyStr(value);
}

/**
 * Python `x.strip()`（非 str 抛 AttributeError，照 Python）。
 *
 * 空白集合走 lib.js 的 `pyStrip`（`\s` 口径已与 Python 对齐：含 `\x1c-\x1f`/`\x85`、
 * 不含 U+FEFF）——`int(str)` 的前后空白、`save_config` 的字段规整都用它。
 */
function pyStrStrip(value) {
  if (typeof value !== 'string') {
    throw new AttributeError(`'${pyTypeName(value)}' object has no attribute 'strip'`);
  }
  return pyStrip(value);
}

/** Python `str.splitlines()`（比 `split("\n")` 多 8 个分隔字符；`read_text` 已折过 `\r`） */
function pySplitLines(text) {
  const s = String(text);
  if (s === '') return [];
  return s.split(/[\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
}

/** Python `len(x)`（str 按码点） */
function pyLen(value) {
  if (typeof value === 'string') return [...value].length;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  throw new TypeError(`object of type '${pyTypeName(value)}' has no len()`);
}

/**
 * Python 字符串切片 `text[:n]`（**按码点**）。
 *
 * `n < 0` 照 Python：丢弃末尾 `|n|` 个码点。非 str 抛 TypeError（Python 是
 * `'int' object is not subscriptable`）——本模块只对 str 用。
 */
export function pySliceCodePoints(text, n) {
  if (typeof text !== 'string') {
    throw new TypeError(`'${pyTypeName(text)}' object is not subscriptable`);
  }
  const chars = Array.from(text);
  const end = n < 0 ? Math.max(0, chars.length + n) : Math.min(chars.length, n);
  return chars.slice(0, end).join('');
}

/**
 * CPython `round(x, n)`（n ≥ 0）：**对 double 的精确十进制值**做半偶舍入，再取最近 double。
 *
 * 为什么不能用 `toFixed`：`(0.15625).toFixed(4)` = `"0.1563"`（半上入），而 Python 给
 * `0.1562`（半偶）——`0.15625` 是可精确表示的二进制小数，这个分叉在真实分数上会遇到。
 * 实现：拆出 `x = m·2^e` 的精确整数表示 → 乘 `10^n` 做精确整数除法 → 余数比 `2r` 与除数
 * （相等时看商是否为偶数）→ 十进制串交给 `Number()`（正确舍入，等价 CPython 的 strtod）。
 */
export function pyRound(value, digits) {
  if (typeof value !== 'number') return value;          // Python round(int, n) 仍是 int
  if (!Number.isFinite(value)) return value;            // round(nan)=nan、round(inf)=inf
  if (!Number.isInteger(digits)) throw new TypeError('ndigits 须为整数');
  const n = digits;
  const neg = value < 0;
  const ax = Math.abs(value);
  if (ax === 0) return value;                           // ±0.0 原样（含 -0.0）
  if (n < 0) {
    // Python 允许负 ndigits（按 10^|n| 位舍入）；本模块未用到，显式抛错而非静默给错值。
    throw new RangeError('pyRound: 只实现 ndigits >= 0（rag.py 只用 round(s, 4)）');
  }
  // 精确分解 ax = m · 2^e（m 为整数 BigInt，e 为整数）
  let m = ax;
  let e = 0;
  while (!Number.isInteger(m)) { m *= 2; e -= 1; }
  let num = BigInt(m);
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den = 1n << BigInt(-e);
  num *= 10n ** BigInt(n);
  let q = num / den;
  const r = num % den;
  const twice = 2n * r;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  const digitsText = q.toString();
  const padded = digitsText.length <= n ? `0.${'0'.repeat(n - digitsText.length)}${digitsText}`
    : `${digitsText.slice(0, digitsText.length - n)}.${digitsText.slice(digitsText.length - n)}`;
  const out = Number(padded);
  return neg ? -out : out;
}

/**
 * Python `int(x)`：bool→0/1、float 向零截断（NaN/±inf 抛）、str 支持两侧空白与 `1_0`。
 *
 * 已知残余：只认 ASCII 数字（Python 还认 Unicode 十进制数字）。
 */
export function pyInt(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(value)) {
      throw new OverflowError(`cannot convert float ${value > 0 ? 'infinity' : '-infinity'} to integer`);
    }
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const text = pyStrStrip(value);
    const m = /^([+-]?)([0-9]+(?:_[0-9]+)*)$/.exec(text);
    if (!m) {
      throw new ValueError(`invalid literal for int() with base 10: ${pyReprString(value)}`);
    }
    const digits = m[2].replace(/_/g, '');
    const n = Number(`${m[1]}${digits}`);
    return m[1] === '-' ? -n : n;
  }
  throw new TypeError('int() argument must be a string, a bytes-like object or a real number, '
    + `not '${pyTypeName(value)}'`);
}

/** Python `dict.get(k[, d])`：只有**键不存在**才给默认值（键在但为 None 仍返回 None） */
function pyGet(value, key, fallback = undefined) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttributeError(`'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** Python `d[k]`（键不存在抛 `KeyError`，消息是键的 repr） */
function pyGetItem(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`'${pyTypeName(value)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(value, key)) throw new KeyError(pyRepr(key));
  return value[key];
}

/** Python `seq[i]`（list 越界抛 IndexError、dict 缺键抛 KeyError） */
function pyIndex(seq, i) {
  if (Array.isArray(seq)) {
    if (!Number.isInteger(i) || i < 0 || i >= seq.length) {
      throw new IndexError('list index out of range');
    }
    return seq[i];
  }
  if (seq !== null && typeof seq === 'object') return pyGetItem(seq, i);
  throw new TypeError(`'${pyTypeName(seq)}' object is not subscriptable`);
}

/** Python `list(x or [])`：str → 码点列表、dict → 键列表、falsy → 空表 */
function pyListOf(value) {
  if (!pyTruthy(value)) return [];
  if (typeof value === 'string') return Array.from(value);
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'object') return Object.keys(value);
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/** Python `json.dumps` 默认形态（`ensure_ascii=True`）——只用于嵌入请求体 */
export function pyJsonDumpsAscii(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return asciiString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pyJsonDumps(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumpsAscii).join(', ')}]`;
  if (typeof value === 'object') {
    const items = Object.keys(value).map((k) => `${asciiString(k)}: ${pyJsonDumpsAscii(value[k])}`);
    return `{${items.join(', ')}}`;
  }
  throw new TypeError(`pyJsonDumpsAscii: 不能序列化 ${typeof value}`);
}

/** 控制字符转义表（与 CPython `py_encode_basestring_ascii` 相同的命名转义） */
const ASCII_NAMED_ESCAPES = new Map([
  ['"', '\\"'], ['\\', '\\\\'], ['\b', '\\b'], ['\f', '\\f'], ['\n', '\\n'], ['\r', '\\r'],
  ['\t', '\\t'],
]);

/** 单个字符串的 `ensure_ascii=True` 编码（≥ U+007F 一律 `\uXXXX`，星平面拆代理对） */
function asciiString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const named = ASCII_NAMED_ESCAPES.get(ch);
    if (named !== undefined) {
      out += named;
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp > 0x7e) {
      if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, '0')}`;
      else {
        const v = cp - 0x10000;
        out += `\\u${(0xd800 + (v >> 10)).toString(16).padStart(4, '0')}`;
        out += `\\u${(0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    if (cp < 0x20) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

/** Python 的 `x < y`（类型不可比时抛 TypeError，与 `sorted` 的行为同） */
function pyLess(a, b) {
  const na = typeof a === 'boolean' ? Number(a) : a;
  const nb = typeof b === 'boolean' ? Number(b) : b;
  if (typeof na === 'number' && typeof nb === 'number') return na < nb;
  if (typeof na === 'string' && typeof nb === 'string') return pyStrCompare(na, nb) < 0;
  throw new TypeError(`'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** Python `sorted(items, key=...)`（稳定；排序键不可比时抛 TypeError，同 Python） */
function pySortBy(items, keyFn) {
  return [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (pyLess(ka, kb)) return -1;
    if (pyLess(kb, ka)) return 1;
    return 0;
  });
}

/** Python `sorted(x, key=..., reverse=True)` 的稳定降序（比较器取反，**不是**升序再反转） */
function pySortByDesc(items, keyFn) {
  return [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (pyLess(ka, kb)) return 1;
    if (pyLess(kb, ka)) return -1;
    return 0;
  });
}

/** 是不是「Python 的 OSError」：Node 的 fs 错误都带 `code` */
function isFsError(exc) {
  return Boolean(exc && typeof exc === 'object' && typeof exc.code === 'string');
}

// --------------------------------------------------------------------------
// 配置 IO
// --------------------------------------------------------------------------

/** `rag.json` 路径：环境变量 `TS_RAG_CONFIG` 覆盖，默认 `~/.touchstone/rag.json`。 */
export function config_path() {
  return process.env.TS_RAG_CONFIG || path.join(os.homedir(), '.touchstone', 'rag.json');
}

/**
 * 读 RAG 配置；文件不存在/解析失败/关键字段缺失返回 `null`（=RAG 未启用）。
 *
 * `api_key` 仅存于返回 dict（内存），调用方不得写入日志或任何落盘内容。
 */
export function load_config() {
  const raw = readText(config_path());
  if (!raw) return null;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!(cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)
    && pyTruthy(pyGet(cfg, 'api_base')) && pyTruthy(pyGet(cfg, 'api_key'))
    && pyTruthy(pyGet(cfg, 'model')))) {
    return null;
  }
  if (!Object.hasOwn(cfg, 'timeout_s')) cfg.timeout_s = DEF_TIMEOUT_S;
  if (!Object.hasOwn(cfg, 'batch_size')) cfg.batch_size = DEF_BATCH_SIZE;
  return cfg;
}

/**
 * 读 rag.json 原始 dict（不校验关键字段），文件缺失/解析失败/非 dict 返回 `null`。
 *
 * 供管理页回显：`load_config` 校验失败（半填配置）时页面上仍要能展示已填字段值。
 */
export function raw_config() {
  const raw = readText(config_path());
  if (!raw) return null;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  return cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
}

/**
 * 配置整数字段规整：None/空串→默认值；非法或越界抛 ValueError（上限防误填拖垮请求）。
 *
 * `lang` 只决定 `.message` 语种（t 的 key 仍是中文原文）；`i18nKey/i18nVars` 照旧
 * 附加，供响应层/`test_connection` 按请求语言重渲染——zh 侧与旧模板逐字节相同。
 */
export function _cfg_int(value, def, upper, name, lang = 'zh') {
  if (value === null || value === undefined || value === '') return def;
  let n;
  try {
    n = pyInt(value);
  } catch (exc) {
    if (exc instanceof TypeError || exc instanceof ValueError) {
      throw localizable(new ValueError(t('api', '{name} 须为正整数', lang, { name })),
        '{name} 须为正整数', { name });
    }
    throw exc;
  }
  if (n < 1 || n > upper) {
    throw localizable(
      new ValueError(t('api', '{name} 须在 1~{upper} 之间', lang, { name, upper })),
      '{name} 须在 1~{upper} 之间', { name, upper });
  }
  return n;
}

/**
 * 校验并原子写入 rag.json（0600 权限——文件含 api_key 明文）。
 *
 * 关键字段缺失/非法抛 ValueError，由管理页端点转 400；`api_base` 须 http(s) 开头。
 */
export function save_config(cfg) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new AttributeError(`'${pyTypeName(cfg)}' object has no attribute 'get'`);
  }
  const api_base = pyStrStrip(pyStr(pyOr(pyGet(cfg, 'api_base'), ''))).replace(/\/+$/, '');
  const api_key = pyStrStrip(pyStr(pyOr(pyGet(cfg, 'api_key'), '')));
  const model = pyStrStrip(pyStr(pyOr(pyGet(cfg, 'model'), '')));
  const lower = api_base.toLowerCase();
  if (!(lower.startsWith('http://') || lower.startsWith('https://'))) {
    throw new ValueError(
      'api_base 须为 http(s):// 开头的 OpenAI 兼容服务地址（含 /v1，不含 /embeddings）');
  }
  if (!api_key) throw new ValueError('api_key 不能为空');
  if (!model) throw new ValueError('model 不能为空（须为嵌入模型，非对话模型）');
  const target = config_path();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    api_base,
    api_key,
    model,
    timeout_s: _cfg_int(pyGet(cfg, 'timeout_s'), DEF_TIMEOUT_S, 300, 'timeout_s'),
    batch_size: _cfg_int(pyGet(cfg, 'batch_size'), DEF_BATCH_SIZE, 256, 'batch_size'),
  };
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${pyJsonDumpsIndent(payload, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  // 收紧权限到属主可读写（api_key 明文）；Windows 无 POSIX 权限位，此调用在该平台
  // 不报错也无实际效果，机密性依赖 %USERPROFILE% 的默认 ACL
  fs.chmodSync(target, 0o600);
}

/** 停用 RAG：删除 rag.json（存在才删）。返回是否实际删除了文件。 */
export function disable() {
  try {
    fs.unlinkSync(config_path());
    return true;
  } catch (exc) {
    if (exc && exc.code === 'ENOENT') return false;
    throw exc;
  }
}

/**
 * 配置连通性探测：按给定配置发一次单文本嵌入请求（管理页「测试连接」用）。
 *
 * 返回 `{ok: true, dim}` 或 `{ok: false, error}`，绝不抛出；error 文本不含 api_key。
 * `lang` 只影响我们自己的固定模板；网络/鉴权/解析原文按诊断原样返回（登记边界）。
 * **异步**（见文件头 ①）。
 */
export async function test_connection(cfg, lang = 'zh') {
  try {
    const probe = {
      api_base: pyStrStrip(pyStr(pyOr(pyGet(cfg, 'api_base'), ''))),
      model: pyStrStrip(pyStr(pyOr(pyGet(cfg, 'model'), ''))),
      api_key: pyStrStrip(pyStr(pyOr(pyGet(cfg, 'api_key'), ''))),
    };
    if (!(probe.api_base && probe.model && probe.api_key)) {
      throw new ValueError(
        t('api', 'api_base / model / api_key 尚未填写完整', lang));
    }
    probe.timeout_s = _cfg_int(pyGet(cfg, 'timeout_s'), DEF_TIMEOUT_S, 300,
      'timeout_s', lang);
    probe.batch_size = _cfg_int(pyGet(cfg, 'batch_size'), DEF_BATCH_SIZE, 256,
      'batch_size', lang);
    const vecs = await _post_embeddings(probe, ['ping']);
    return { ok: true, dim: vecs.length && pyTruthy(vecs[0]) ? pyLen(vecs[0]) : 0 };
  } catch (exc) {  // 网络/鉴权/响应形态异常统一转为可展示文本
    // 我们自己的固定模板带 i18nKey（含 _cfg_int/_post_embeddings）→ 按请求语言重渲染；
    // 其余动态异常（HTTP/鉴权/JSON 原文）原样返回，不翻译。
    if (exc !== null && typeof exc === 'object' && typeof exc.i18nKey === 'string') {
      return { ok: false, error: t('api', exc.i18nKey, lang, exc.i18nVars || undefined) };
    }
    const text = exc && exc.message !== undefined ? String(exc.message) : String(exc);
    return { ok: false, error: text || (exc && exc.constructor ? exc.constructor.name : 'Error') };
  }
}

/**
 * 嵌入源文本 = 用例相对目录路径 + case.md 原文（截断**码点**）。
 *
 * 不含 status——相似度只反映「测的是什么」，不随通过/失败漂移。
 */
export function embedding_text(root, rec) {
  const rel = pyGetItem(rec, 'dir');
  const body = readText(pyJoin(root, rel, 'case.md'));
  return pySliceCodePoints(`${String(rel).replace(/\\/g, '/')}\n${body}`, EMBED_TEXT_MAX);
}

/** 嵌入内容指纹：文本+模型 双因子 sha256，索引差量判定与模型变更重建的依据。 */
export function text_hash(text, model) {
  return createHash('sha256').update(`${model}\n${text}`, 'utf8').digest('hex');
}

/**
 * 调 OpenAI 兼容 `/v1/embeddings` 批量嵌入。
 *
 * 返回与 texts 等长同序的向量列表（按响应 `index` 字段还原顺序）；响应缺 data/条数不符
 * （HTTP 200+error 体）/网络/解析失败一律抛异常（重试 1 次），绝不静默返回可能错位的向量。
 * **异步**（见文件头 ①）。
 */
export async function _post_embeddings(cfg, texts) {
  const url = `${pyGetItem(cfg, 'api_base').replace(/\/+$/, '')}/embeddings`;
  const body = pyJsonDumpsAscii({ model: pyGetItem(cfg, 'model'), input: texts });
  const timeoutMs = Number(pyGetItem(cfg, 'timeout_s')) * 1000;
  for (let attempt = 0; attempt <= HTTP_RETRY; attempt += 1) {
    try {
      const controller = new AbortController();
      // 固定模板：附加 i18nKey 供 test_connection 按请求语言渲染，zh 不变
      const timer = setTimeout(() => controller.abort(
        localizable(new Error('embeddings 请求超时'), 'embeddings 请求超时')), timeoutMs);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pyGetItem(cfg, 'api_key')}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`HTTP Error ${resp.status}: ${resp.statusText}`);
      const raw = Buffer.from(await resp.arrayBuffer()).toString('utf8');
      const data = JSON.parse(raw);
      let items = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? pyGet(data, 'data') : null;
      if (!Array.isArray(items)) {
        throw localizable(new ValueError('embeddings 响应缺 data'),
          'embeddings 响应缺 data');
      }
      items = pySortBy(items, (d) => pyGet(d, 'index', 0));
      if (items.length !== texts.length) {
        throw localizable(new ValueError('embeddings 返回条数不符'),
          'embeddings 返回条数不符');
      }
      return items.map((item) => pyGetItem(item, 'embedding'));
    } catch (exc) {  // HTTP/超时/解析失败统一计数重试
      if (attempt >= HTTP_RETRY) throw exc;
    }
  }
  return [];   // 不可达（HTTP_RETRY >= 0 时最后一次必抛）；仅为让控制流闭合
}

// --------------------------------------------------------------------------
// 分词与 BM25（纯标准库兜底检索，永远可用）
// --------------------------------------------------------------------------

/** ASCII/数字/下划线段（照 `WORD_RE`；`\d` 口径见文件头「残余差异」） */
const WORD_RE = /[A-Za-z0-9_]+/g;
/** CJK 连续段（照 `CJK_RE`；区间在 BMP，JS 码元遍历与 Python 码点等价） */
const CJK_RE = /[\u4e00-\u9fff]+/g;

/**
 * 查询/文档统一分词：ASCII/数字下划线段小写词；CJK 连续段字符 bigram（单字保底）。
 *
 * 「登录失败」→ `[登录, 录失, 失败]`。非 str 的真值入参照 Python 抛 TypeError。
 */
export function tokenize(text) {
  const raw = pyOr(text, '');
  if (typeof raw !== 'string') {
    throw new TypeError(`expected string or bytes-like object, got '${pyTypeName(raw)}'`);
  }
  const tokens = [];
  for (const m of raw.matchAll(WORD_RE)) tokens.push(m[0].toLowerCase());
  for (const m of raw.matchAll(CJK_RE)) {
    const seg = m[0];
    if (seg.length === 1) tokens.push(seg);
    else {
      for (let i = 0; i < seg.length - 1; i += 1) tokens.push(seg[i] + seg[i + 1]);
    }
  }
  return tokens;
}

/**
 * 扫描签名 = `(用例数, 全库最大 mtime)`：BM25 缓存与差量刷新的失效判定。
 *
 * 返回值照 Python 元组形态给**数组** `[count, latest]`。mtime 覆盖用例目录与 case.md。
 */
export function _scan_signature(root) {
  let count = 0;
  let latest = 0.0;
  for (const rec of scanCases(root)) {
    count += 1;
    for (const p of [pyJoin(root, rec.dir), pyJoin(root, rec.dir, 'case.md')]) {
      try {
        latest = Math.max(latest, pyMtimeFloat(fs.statSync(p, { bigint: true }).mtimeNs));
      } catch {
        /* OSError → pass */
      }
    }
  }
  return [count, latest];
}

/** 由语料文本列表构建 BM25 内存倒排（词 → {文档序号: 词频}）。 */
export function _bm25_build(texts) {
  const inv = {};
  const doc_len = [];
  for (let i = 0; i < texts.length; i += 1) {
    const toks = tokenize(texts[i]);
    doc_len.push(toks.length);
    for (const t of toks) {
      if (!Object.hasOwn(inv, t)) inv[t] = {};
      const postings = inv[t];
      postings[i] = (postings[i] || 0) + 1;
    }
  }
  const total = doc_len.reduce((acc, v) => acc + v, 0);
  return {
    inv,
    doc_len,
    n: texts.length,
    avgdl: doc_len.length ? total / doc_len.length : 0.0,
  };
}

/**
 * CPython `math.log(x)`（正确舍入的 libm 对数）。
 *
 * **为什么不能直接用 `Math.log`**：V8 的 `Math.log` 是 fdlibm 移植（误差 < 1 ULP，**不保证**
 * 正确舍入），而 oracle 侧是这个环境里 Python 的 `math.log`（=系统 libm 的 `log`，已用
 * ctypes 对拍 2,001,000 个可达参数确认逐位相同）。在 BM25 的 IDF 可达参数
 * `1 + (n-df+0.5)/(df+0.5)` 上实测（n ≤ 2000 全枚举 2,001,000 个参数）：
 *   - `Math.log` 有 **150,065 个（7.5%）**与 oracle 差 1 ULP；
 *   - 本函数只有 **1,915 个（0.096%）**差 1 ULP，且 **n ≤ 8 的小语料 36 个参数全中**。
 * 这 1 ULP 会渗进每个 BM25 得分 ⇒ 直接比原始浮点时会红，且「几乎同分」的两个文档排序
 * 可能与 Python 相反。故这里自己算一个**正确舍入**的 log（比 V8 的实现少 78 倍分歧，
 * 且小语料上完全一致）。
 *
 * 实现（不依赖任何浮点库的误差假设）：把 double 精确拆成 `M·2^E` → 归约到 `m' = M/2^k ∈ [1,2)`
 * → `ln(x) = ln(m') + (E+k)·ln2`，其中 `ln(m') = 2·atanh((m'-1)/(m'+1))` 的级数、以及 `ln2`
 * 本身，都在 **256 位 BigInt 定点**下算（ratio 用整数除法取整、逐项截断，总误差 ≪ 2^-200），
 * 最后按 **round-half-even** 精确舍入到 53 位有效数字并直接拼 IEEE 位模式（不经二次浮点运算）。
 * 该函数只被 `_bm25_search` 调用（每个查询词一次），性能不是问题。
 *
 * 域行为照 CPython：`log(0)`/`log(负数)` 抛 `ValueError: math domain error`、
 * `log(nan)=nan`、`log(inf)=inf`。
 */
export function pyLog(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (!(x > 0)) throw new ValueError('math domain error');
  const P = 256;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const raw = view.getBigUint64(0);
  const expBits = Number((raw >> 52n) & 0x7ffn);
  let M;
  let E;
  if (expBits === 0) {
    M = raw & ((1n << 52n) - 1n);          // 次正规
    E = -1074;
  } else {
    M = (raw & ((1n << 52n) - 1n)) | (1n << 52n);
    E = expBits - 1075;
  }
  const k = M.toString(2).length - 1;      // M ∈ [2^k, 2^(k+1))
  const twoK = 1n << BigInt(k);
  const num = M - twoK;
  const den = M + twoK;                    // f = num/den ∈ [0, 1/3]
  const shift = BigInt(P);
  let sum = 0n;
  if (num !== 0n) {
    let term = (num << shift) / den;
    sum = term;
    const f2 = (term * term) >> shift;
    for (let i = 1n; term !== 0n; i += 1n) {
      term = (term * f2) >> shift;
      if (term === 0n) break;
      sum += term / (2n * i + 1n);
    }
  }
  const total = 2n * sum + BigInt(E + k) * ln2Fixed(P);
  return fixedToDouble(total, P);
}

/** `ln2` 的 P 位定点值（`2·atanh(1/3)` 级数，结果缓存） */
function ln2Fixed(P) {
  if (ln2Fixed.cache !== null && ln2Fixed.cacheP === P) return ln2Fixed.cache;
  const scale = 1n << BigInt(P);
  let term = scale / 3n;
  let sum = term;
  const f2 = (term * term) >> BigInt(P);
  for (let i = 1n; ; i += 1n) {
    term = (term * f2) >> BigInt(P);
    if (term === 0n) break;
    sum += term / (2n * i + 1n);
  }
  ln2Fixed.cache = 2n * sum;
  ln2Fixed.cacheP = P;
  return ln2Fixed.cache;
}
ln2Fixed.cache = null;
ln2Fixed.cacheP = 0;

/** 定点值（`value / 2^P`）→ 最近 double（半偶；直接拼 IEEE 位，避免二次舍入） */
function fixedToDouble(value, P) {
  if (value === 0n) return 0;
  const neg = value < 0n;
  const a = neg ? -value : value;
  const bits = a.toString(2).length;
  let e = bits - 1 - P;                    // |value/2^P| ∈ [2^e, 2^(e+1))
  let sh = BigInt(bits - 53);
  let m;
  if (sh >= 0n) {
    m = a >> sh;
    const rem = a - (m << sh);
    const half = 1n << (sh - 1n);
    if (rem > half || (rem === half && (m & 1n) === 1n)) m += 1n;
    if (m === (1n << 53n)) {
      m >>= 1n;
      e += 1;
    }
  } else {
    m = a << -sh;                          // 有效位不足 53 位：左移补零（本模块不可达）
  }
  const out = new DataView(new ArrayBuffer(8));
  out.setBigUint64(0, (BigInt(e + 1023) << 52n) | (m - (1n << 52n)));
  return neg ? -out.getFloat64(0) : out.getFloat64(0);
}

/**
 * BM25 打分（k1/b 标准值 + 概率 IDF），返回 `[[文档序号, 得分], …]` 降序前 top。
 *
 * `set(tokenize(query))` 的**去重**照 Python；但迭代次序 JS 是插入序、Python 是哈希序
 * （见文件头「残余差异」）——同一文档被多个查询词命中时浮点累加次序可能不同，用例需避开。
 */
export function _bm25_search(idx, query, top) {
  const scores = new Map();
  const n = pyGetItem(idx, 'n');
  const avgdl = pyOr(pyGetItem(idx, 'avgdl'), 1.0);
  const seen = new Set();
  for (const t of tokenize(query)) {
    if (seen.has(t)) continue;
    seen.add(t);
    const postings = pyOr(pyGet(pyGetItem(idx, 'inv'), t), null);
    if (!postings) continue;
    const keys = Object.keys(postings);
    const idf = pyLog(1.0 + (n - keys.length + 0.5) / (keys.length + 0.5));
    for (const key of keys) {
      const i = Number(key);
      const tf = postings[key];
      const dl = pyIndex(pyGetItem(idx, 'doc_len'), i) || 1;
      const gain = tf * (BM25_K1 + 1)
        / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));
      scores.set(i, (scores.has(i) ? scores.get(i) : 0.0) + idf * gain);
    }
  }
  return pySortByDesc([...scores.entries()], (kv) => kv[1]).slice(0, top);
}

/** BM25 内存缓存（进程级单例；签名+TTL 双重失效，同 server.StateCache 风格） */
const _BM25_CACHE = { root: null, sig: null, at: 0.0, idx: null };

/** 带缓存的 BM25 索引：案例库未变且 1s 内直接复用，重建 <100ms（百级库）。 */
export function _bm25_cached(root, texts) {
  const sig = _scan_signature(root);
  const now = Date.now() / 1000;
  const cache = _BM25_CACHE;
  const sameSig = cache.sig !== null && cache.sig !== undefined
    && cache.sig[0] === sig[0] && cache.sig[1] === sig[1];
  if (cache.root === root && sameSig && now - (cache.at || 0.0) < CACHE_TTL) return cache.idx;
  const idx = _bm25_build(texts);
  cache.root = root;
  cache.sig = sig;
  cache.at = now;
  cache.idx = idx;
  return idx;
}

// --------------------------------------------------------------------------
// 派生文件读写与差量刷新
// --------------------------------------------------------------------------

/** `<root>/.live/rag_index.jsonl` */
export function _index_path(root) {
  return pyJoin(root, '.live', RAG_INDEX_NAME);
}

/** `<root>/.live/similar.jsonl` */
export function _similar_path(root) {
  return pyJoin(root, '.live', SIMILAR_NAME);
}

/** 原子写 jsonl（tmp + rename），读方永远看到完整旧文件或完整新文件。 */
export function _atomic_write_jsonl(target, rows) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  let body = '';
  for (const row of rows) body += `${pyJsonDumps(row)}\n`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, target);
}

/** 读 rag_index.jsonl → `{id: 行}`；文件缺失/行损坏按缺失处理（重建自愈）。 */
export function _load_index(root) {
  const out = {};
  for (const raw of pySplitLines(readText(_index_path(root)))) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec !== null && typeof rec === 'object' && !Array.isArray(rec)
      && pyTruthy(pyGet(rec, 'id'))) {
      out[pyGet(rec, 'id')] = rec;
    }
  }
  return out;
}

/** 读通用 jsonl 文件为行 dict 列表（CLI 展示与测试用）。 */
export function _load_jsonl(target) {
  const out = [];
  for (const raw of pySplitLines(readText(target))) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ValueError → pass */
    }
  }
  return out;
}

/** 向量 L2 归一化（零向量安全），归一化后点积即余弦。 */
export function _norm(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  let n = Math.sqrt(sum);
  if (n === 0) n = 1.0;
  const out = [];
  for (const x of vec) out.push(x / n);
  return out;
}

/** `sum(x*y for x, y in zip(a, b))`（zip 截断到较短者） */
export function _dot(a, b) {
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) total += a[i] * b[i];
  return total;
}

/**
 * 全库两两余弦取 top-5 近邻（向量均归一化，点积即余弦）。
 *
 * 行格式 `{"id","name","similar":[{"id","name","score"}]}`；`score` = `round(s, 4)`
 * （**半偶**，见文件头 2）。`scored.sort(reverse=True)` 按 `(score, id)` 元组降序 ⇒ 同分时
 * id 大者在前（与 Python 一致，且与 `set` 迭代序无关）。
 */
export function _similar_rows(index) {
  const ids = Object.keys(index).sort(pyStrCompare);
  const rows = [];
  for (const rid of ids) {
    const vec = pyOr(pyGet(pyGetItem(index, rid), 'vec'), []);
    const scored = [];
    for (const other of ids) {
      if (other === rid) continue;
      scored.push([_dot(vec, pyOr(pyGet(pyGetItem(index, other), 'vec'), [])), other]);
    }
    scored.sort((a, b) => {
      if (pyLess(a[0], b[0])) return 1;
      if (pyLess(b[0], a[0])) return -1;
      return pyStrCompare(b[1], a[1]);
    });
    rows.push({
      id: rid,
      name: pyGet(pyGetItem(index, rid), 'name', ''),
      similar: scored.slice(0, TOPK_SIMILAR).map(([s, other]) => ({
        id: other,
        name: pyGet(pyGetItem(index, other), 'name', ''),
        score: pyRound(s, 4),
      })),
    });
  }
  return rows;
}

/**
 * 索引增量维护：差量嵌入 + 近邻重算。RAG 未配置时 no-op（不产生任何文件）。
 *
 * 返回 `{enabled, embedded, total}`；存在 stale（索引不完整）时不动 similar.jsonl。
 * **异步**（`_post_embeddings` 是 Promise，见文件头 ①）。
 *
 * 照抄 Python 的一处**误导性日志**：`stale_left` 为空且本轮无变更、similar 已存在时，
 * 走的是 `elif log` 分支，会打出「RAG 索引不完整（待嵌 0 条）」——行为（不写盘）是对的，
 * 文案是错的，但既然是 oracle 就照搬（M6-3 报告已记）。
 */
export async function refresh(root, log = null) {
  const cfg = load_config();
  const records = scanCases(root);
  if (!cfg) return { enabled: false, embedded: 0, total: records.length };
  let index = _load_index(root);
  const rec_map = {};
  for (const rec of records) rec_map[pyGetItem(rec, 'id')] = rec;
  // 模型变更 → 全量重建（旧向量全部失配）
  if (Object.keys(index).length && Object.values(index).some((r) => pyGet(r, 'model') !== cfg.model)) {
    index = {};
  }
  const texts = {};
  const hashes = {};
  for (const rec of records) {
    const t = embedding_text(root, rec);
    texts[pyGetItem(rec, 'id')] = t;
    hashes[pyGetItem(rec, 'id')] = text_hash(t, cfg.model);
  }
  const stale = Object.keys(hashes).filter((rid) => !Object.hasOwn(index, rid)
    || pyGet(pyGetItem(index, rid), 'hash') !== hashes[rid]);
  let embedded = 0;
  const batch = Math.max(1, pyInt(pyOr(pyGet(cfg, 'batch_size'), 16)));
  for (let start = 0; start < stale.length; start += batch) {
    const part = stale.slice(start, start + batch);
    let vecs;
    try {
      vecs = await _post_embeddings(cfg, part.map((rid) => texts[rid]));
    } catch (exc) {
      // Python 的 `f"{exc}"` 是 `str(exc)`：**没有类名前缀**（`str(Error("x"))` 在 JS 里是
      // `"Error: x"`）⇒ 必须取 message，否则日志文案与 Python 差一个 `Error: `。
      if (log) {
        const reason = exc && exc.message !== undefined ? String(exc.message) : String(exc);
        log(`RAG 嵌入失败（保留旧索引，待嵌 ${stale.length - embedded} 条）：${reason}`);
      }
      break;
    }
    const n = Math.min(part.length, vecs.length);
    for (let j = 0; j < n; j += 1) {
      const rid = part[j];
      const vec = vecs[j];
      index[rid] = {
        id: rid,
        name: pyGetItem(rec_map[rid], 'name'),
        hash: hashes[rid],
        model: cfg.model,
        dim: pyLen(vec),
        vec: _norm(vec),
      };
      embedded += 1;
    }
  }
  // 逐出已删除用例
  const removed = Object.keys(index).filter((rid) => !Object.hasOwn(hashes, rid));
  for (const rid of removed) delete index[rid];
  if (embedded || removed.length) {
    _atomic_write_jsonl(_index_path(root),
      Object.values(index).sort((a, b) => pyStrCompare(pyGetItem(a, 'id'), pyGetItem(b, 'id'))));
  }
  // 索引完整（无 stale）才重算 similar，防止嵌入失败期间输出残缺近邻；
  // 且本轮无任何变更（无新嵌、无删除）且 similar.jsonl 已存在时直接跳过（零无用开销）。
  const stale_left = Object.keys(hashes).filter((rid) => !Object.hasOwn(index, rid)
    || pyGet(pyGetItem(index, rid), 'hash') !== hashes[rid]);
  if (!stale_left.length
    && (embedded || removed.length || !fs.existsSync(_similar_path(root)))) {
    _atomic_write_jsonl(_similar_path(root), _similar_rows(index));
  } else if (log) {
    log(`RAG 索引不完整（待嵌 ${stale_left.length} 条），本轮不更新 similar.jsonl`);
  }
  return { enabled: true, embedded, total: records.length };
}

// --------------------------------------------------------------------------
// 混合检索（RRF 融合 + 多级降级，永不抛出）
// --------------------------------------------------------------------------

/**
 * 倒数排名融合：`score = Σ 1/(RRF_K + rank)`；`via` 记录命中来源（**字典序**拼接）。
 *
 * `pools` 是普通对象（键序=池的插入序，照 Python dict 迭代序）；返回 `[[i, score, via], …]`。
 */
export function _rrf_merge(pools, k) {
  const agg = new Map();
  for (const name of Object.keys(pools)) {
    const hits = pools[name];
    for (let rank = 0; rank < hits.length; rank += 1) {
      const i = hits[rank][0];
      const cur = agg.get(i) || [0.0, new Set()];
      cur[0] += 1.0 / (RRF_K + rank + 1);
      cur[1].add(name);
      agg.set(i, cur);
    }
  }
  const out = [];
  for (const [i, [score, via]] of agg) {
    out.push([i, score, [...via].sort(pyStrCompare).join('+')]);
  }
  return pySortByDesc(out, (row) => row[1]).slice(0, k);
}

/** 最终兜底：`scan_cases` 字段 substring 关键词过滤（连 RAG 底座都异常时仍可用）。 */
export function _fallback(root, query, k) {
  const records = scanCases(root);
  const q = pyOr(query, '');
  if (typeof q !== 'string') {
    throw new AttributeError(`'${pyTypeName(q)}' object has no attribute 'strip'`);
  }
  const kw = pyStrStrip(q);
  let hits;
  if (kw) {
    hits = records.filter((r) => ['dir', 'name', 'interface', 'module']
      .some((f) => pyStr(pyOr(pyGet(r, f), '')).includes(kw)));
  } else {
    hits = [];
  }
  return hits.slice(0, k).map((r) => ({ ...r, score: 0.0, via: 'kw' }));
}

/**
 * 混合检索入口（带元数据版）：BM25 恒可用；配置了 RAG 则向量路并入 RRF 融合。
 *
 * 返回 `[rows, meta]`（照 Python 的 `(rows, meta)` 元组用数组表达）；`meta` 回答
 * 「这次检索到底用没用 RAG」。任何异常降级到关键词兜底，永不抛出。**异步**（文件头 ①）。
 */
export async function retrieve_detail(root, query, k = DEFAULT_K) {
  const meta = { configured: false, vec_ok: false, vec_error: null };
  try {
    try {
      await refresh(root);   // 惰性差量：案例库被其他任务更新过则先补索引（未配置 no-op）
    } catch {
      /* pass */
    }
    const records = scanCases(root);
    if (!records.length) return [[], meta];
    const texts = records.map((rec) => embedding_text(root, rec));
    const pools = { bm25: _bm25_search(_bm25_cached(root, texts), query, CAND_TOP) };
    const cfg = load_config();
    if (cfg) {
      meta.configured = true;
      try {
        const qvec = _norm((await _post_embeddings(cfg,
          [pySliceCodePoints(pyOr(query, ''), EMBED_TEXT_MAX)]))[0]);
        const index = _load_index(root);
        const vec_hits = [];
        records.forEach((rec, i) => {
          const item = pyGet(index, pyGetItem(rec, 'id'));
          if (item && pyTruthy(pyGet(item, 'vec'))) vec_hits.push([i, _dot(qvec, pyGet(item, 'vec'))]);
        });
        pools.vec = pySortByDesc(vec_hits, (row) => row[1]).slice(0, CAND_TOP);
        meta.vec_ok = true;
      } catch (exc) {
        // 嵌入失败：向量路缺席，BM25 结果照常返回；原因截断后记入 meta
        const text = exc && exc.message !== undefined ? String(exc.message) : String(exc);
        meta.vec_error = pySliceCodePoints(text
          || (exc && exc.constructor ? exc.constructor.name : 'Error'), 200);
      }
    }
    const merged = _rrf_merge(pools, k);
    return [merged.map(([i, s, via]) => ({ ...records[i], score: pyRound(s, 4), via })), meta];
  } catch {
    try {
      return [_fallback(root, query, k), meta];
    } catch {
      return [[], meta];   // 连兜底都异常（如案例库根不可读）时返回空，保证永不抛出
    }
  }
}

/** 混合检索入口（兼容壳）：只返回结果行；检索元数据见 `retrieve_detail`。 */
export async function retrieve(root, query, k = DEFAULT_K) {
  return (await retrieve_detail(root, query, k))[0];
}

/** `git_log_changes` 结果 → 检索 query：变更文件路径 + 提交摘录（截 4000 **码点**）。 */
export function change_query(log) {
  const parts = pyListOf(pyGet(log, 'files')).concat(pyListOf(pyGet(log, 'commits')));
  parts.forEach((p, i) => {
    if (typeof p !== 'string') {
      throw new TypeError(`sequence item ${i}: expected str instance, ${pyTypeName(p)} found`);
    }
  });
  return pySliceCodePoints(parts.join('\n'), 4000);
}

/** 强制全量重建：删索引文件使 refresh 全量 stale。 */
export async function cmd_rebuild(args) {
  try {
    fs.unlinkSync(_index_path(args.root));
  } catch (exc) {
    if (!isFsError(exc)) throw exc;
  }
  const stat = await refresh(args.root, (m) => process.stderr.write(`${m}\n`));
  process.stdout.write(`${pyJsonDumps(stat)}\n`);
  const similar = _load_jsonl(_similar_path(args.root));
  process.stdout.write(`similar.jsonl ${similar.length} 条\n`);
  return 0;
}

/** 检索试查：打印 top-k（`id [via] score 相对路径`）；向量路降级时 stderr 提示。 */
export async function cmd_search(args) {
  const [rows, meta] = await retrieve_detail(args.root, args.query, args.k);
  for (const r of rows) {
    process.stdout.write(`${r.id} [${r.via}] ${r.score} ${r.dir}\n`);
  }
  if (meta.configured && !meta.vec_ok) {
    process.stderr.write(`向量路失败，本次为纯 BM25 结果：${meta.vec_error}\n`);
  }
  return 0;
}

/**
 * CLI 主入口（退出码照 argparse：成功 0、用法错 2）。
 *
 * argparse 的 usage/help 文案**不逐字节复刻**（那是帮助文本，不是行为契约，与 M6-2 的
 * `export-cases.js` 同一条取舍）；对拍用例只用 `rebuild` 的退出码与 stdout。
 */
export async function main(argv = process.argv.slice(2)) {
  const usage = '用法：rag.py {rebuild,search} ...\n';
  const [cmd, ...rest] = argv;
  if (cmd === 'rebuild') {
    if (rest.length !== 1) {
      process.stderr.write(usage);
      process.stderr.write('rag.py: error: the following arguments are required: root\n');
      return 2;
    }
    return cmd_rebuild({ root: rest[0] });
  }
  if (cmd === 'search') {
    const args = { root: '', query: '', k: DEFAULT_K };
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--k') {
        const raw = rest[i + 1];
        i += 1;
        if (!/^[+-]?[0-9]+$/.test(String(raw))) {
          process.stderr.write(usage);
          process.stderr.write(`rag.py: error: argument --k: invalid int value: '${raw}'\n`);
          return 2;
        }
        args.k = Number(raw);
      } else positional.push(rest[i]);
    }
    if (positional.length !== 2) {
      process.stderr.write(usage);
      process.stderr.write('rag.py: error: the following arguments are required: root, query\n');
      return 2;
    }
    [args.root, args.query] = positional;
    return cmd_search(args);
  }
  process.stderr.write(usage);
  process.stderr.write('rag.py: error: the following arguments are required: cmd\n');
  return 2;
}

// --------------------------------------------------------------------------
// camelCase 别名（供 JS 调用方；对拍用例逐条用 nodeFn 指向**主名**，不依赖别名）
// --------------------------------------------------------------------------

export {
  config_path as configPath,
  load_config as loadConfig,
  raw_config as rawConfig,
  _cfg_int as _cfgInt,
  save_config as saveConfig,
  test_connection as testConnection,
  embedding_text as embeddingText,
  text_hash as textHash,
  _post_embeddings as _postEmbeddings,
  _scan_signature as _scanSignature,
  _bm25_build as _bm25Build,
  _bm25_search as _bm25Search,
  _bm25_cached as _bm25Cached,
  _index_path as _indexPath,
  _similar_path as _similarPath,
  _atomic_write_jsonl as _atomicWriteJsonl,
  _load_index as _loadIndex,
  _load_jsonl as _loadJsonl,
  _similar_rows as _similarRows,
  _rrf_merge as _rrfMerge,
  retrieve_detail as retrieveDetail,
  change_query as changeQuery,
  cmd_rebuild as cmdRebuild,
  cmd_search as cmdSearch,
};

// 直接执行时才跑（被 import 时不动）——`node backend/lib/rag.js rebuild <root>`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
