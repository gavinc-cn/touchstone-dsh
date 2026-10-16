/**
 * 飞书**入站语义**（M7.5-R2）：`feishu.py:1577-2604` 的零依赖 Node 移植。
 *
 * Oracle = 仓库根 `feishu.py`（**未改动的 Python 真源**）：消息主流程、卡片回调主流程、
 * 规则意图表、绑定码消费、看板/任务动作、多选「逐题点选」暂存态、全部用户可见文案。
 * 每条实现上方的 `feishu.py:<行号>` 指 oracle 对应行；**与契约清单冲突时以源码为准**。
 *
 * ══ 一、调用面（谁调这里 / 这里调谁）══════════════════════════════════════════════════
 *   - `backend/lib/feishu.js` 的 `startInboundFor` / `startInboundAll`（M7 占位改写）→ 本文件；
 *   - `backend/lib/feishu_ws.js`（R1）的 `eventHandler` / `cardHandler` 收**合包后的 payload
 *     字节**⇒ 本文件自己做 `JSON.parse` 与「SDK 模型 → dict」的取值链（`parseEventPayload`）；
 *   - 复用 M7 既有件：`feishu.js` 的 `bindUser`/`multiAnswerHelp`/`NO_REMOTE_ANSWER_HINT`/
 *     `MQ_TTL`/`MQ_MAX_BUCKETS`（**不写第二份**）、`feishu_cfg.js` 的 `appConfig`/
 *     `inboundStatus`/`setInboundThread`、`feishu_rest.js` 的 rest 族、`db.js` 的飞书访问族、
 *     `board.js` 的 `interactionOfSid`/`answerInteraction`/`answerApproval`/`moveCard`/`startCard`、
 *     `feishu_slash.js` 的 `syncSlashCommands`、`feishu_provision.js` 的 `_LAST_EVENT_TS`。
 *
 * ══ 二、已登记的跨运行时差异（**不是等价物**，逐条写清）════════════════════════════════
 *  1. **依赖注入**（架构约定，M7 起）：Python 靠模块级全局互相调用（`rest_reply`/`db.*`/
 *     `board.*`），Node ESM 的 import 绑定不可打补丁 ⇒ 每个有外部副作用的函数末位多一个
 *     `options = {}`，可注入 `db`/`rest`/`board`/`conv`/`slash`/`feishu`/`cfg`/`now`/`log`/`env`/
 *     `wsClient`/`clientClass`/`wsLog`，**默认值是真模块**（产品路径不传 options）。
 *  2. **同步 → 异步**：oracle 整条入站链同步阻塞（跑在 SDK 事件循环线程里）；Node 侧
 *     `handleMessageEvent`/`onCardAction`/`executeIntent`/`answerByToken`/`decideApproval`/
 *     `executeBoardAction`/`answerMultiClick`/`dmText`/`onSlashPermAction`/`wsRun` 整链 async。
 *     **await 处一律保持 oracle 的串行顺序**（不许为了「性能」并发发起两个会改同一状态的 await）。
 *     `startInboundFor`/`startInboundAll` **保持同步**（对应 `saveUserConfig` 的
 *     `inbound_started` 是同步布尔）。
 *  3. **线程模型**：Python 每用户一条 daemon 线程（`threading.Thread(daemon=True)`，不阻塞进程
 *     退出）。Node 没有等价物，这里用一个**分离的 async 循环** + `feishu_cfg.js` 的注册表句柄
 *     （契约 `{isAlive(): boolean}`）表达：`alive` 在 `start()` 前置真、循环退出后置假，
 *     条目**残留不清理**（照 1608 注释，判死只靠 `is_alive()`）。差异：R1 的 WS 客户端内部
 *     用未 `unref()` 的 `setTimeout` 做重连退避 ⇒ **断网时重连循环会持有 Node 事件循环**
 *     （Python daemon 线程不会）——已登记为差异，未改 R1（写作用域外）。
 *  4. **锁**：`_MQ_LOCK`（2108）在单线程 Node 里是空操作；`mqPut/mqTake/mqPeek/mqDrop` 都是
 *     同步函数 ⇒ 临界区天然原子（比 oracle 更强，不是更弱）。两个 LRU 在 oracle 里也无锁。
 *  5. **`{e!r}` 的近似**：oracle 的 6 处 `{e!r}`（1712/1765/1782/1860/1881/1948）跨运行时
 *     不可能逐字对齐；本文件用 `errorRepr()` 实现 Python `repr(exc)` 的**近似**
 *     （`Name('message')` + Python 字符串 repr），异常类名取 JS 的 `e.name`（本文件自造的
 *     `AttributeError`/`ValueError`/`KeyError`/`TypeError` 与 `FeishuRestError` 同名可对齐）。
 *     **残余分叉**：Python 内建异常的消息文本、异常链、自定义异常类名无法对齐（见报告「未验」）。
 *  6. **`_WS_THREADS` 键类型**（1608 的字典键语义）：`7 != "7"` ⇒ 注册表键必须是**数值**；
 *     本文件所有入口都把 `userId` 当数值用（字符串会建出第二条连接，与 oracle 同风险）。
 *  7. **`int()`/`str()`/真值**：oracle 的 `int(str)`（截断、Unicode 数字、下划线）、
 *     `str(x)`（`True`/`['a']`/`{'a': 1}` 的 Python 形态）、`bool()`（`[]`/`{}`/`0`/`""` 全假、
 *     `nan` 为真）都在本文件用 `pyInt`/`pyStr`/`pyTruthy` 显式实现。**残余**：`json.loads`
 *     把 `2.0` 读成 float 而 `JSON.parse` 得到 number 2 ⇒ `str(2.0)=="2.0"` vs `"2"` 类分叉
 *     无法在 JS 侧恢复（信息在 parse 时就丢了）；整数值浮点的 `.0`、`<1e-4`/`≥1e16` 的
 *     定点-指数切换阈值同 `pyjson.js` 文件头已登记的偏差。
 *  8. **`str.replace` / 切片 / `len`**：Python 的 `str.replace` 替换**全部**出现、`s[:n]`/`len(s)`
 *     按**码点**计 —— 本文件用 `replaceAll` 与 `pySlice`/`pyLen`（`Array.from` 迭代码点），
 *     不用 JS 的 `replace`(首次) 与 `.slice`(UTF-16 码元)。
 *  9. **`_on_slash_perm_action` 归属**（契约清单 §3.3 的阻塞项）：它的唯一调用点是入站 1910、
 *     被调者 `_slash_summary`（1495-1503）的唯一调用点是它 1567 ⇒ 两者都归入站车道的调用面，
 *     且 `feishu_slash.js` 已冻结 ⇒ **在本文件内实现**（`onSlashPermAction`/`slashSummary`），
 *     不改 `feishu_slash.js`（只新增、不修改任何既有文件）。
 * 10. **R3 依赖**：`feishu_conv.js` 尚未落地。默认 `conv` 是**惰性动态 import** 的转发器
 *     （R3 落地后产品路径零改动即生效）；在此之前调用它会抛模块解析错误，被入站主流程的
 *     兜底 catch 吞成一行 `处理异常`（等价于 oracle 的同类异常分支）。
 *
 * ══ 三、Node 专有的测试缝（**不是 oracle 的一部分**）══════════════════════════════════
 *   `resetInboundState()` / `msgSeenSize()` / `evtSeenSize()` / `mqStageSize()` —— 只为单测
 *   能确定地构造与观察进程内态；产品路径不调用。
 */
import {
  MQ_MAX_BUCKETS, MQ_TTL, NO_REMOTE_ANSWER_HINT,
} from './feishu.js';
import { appConfig, inboundStatus, setInboundThread } from './feishu_cfg.js';
import { _LAST_EVENT_TS } from './feishu_provision.js';
import { FeishuRestError } from './feishu_rest.js';
import { PY_WS } from './lib.js';
import { FeishuWsClient } from './feishu_ws.js';
import * as boardMod from './board.js';
import * as dbMod from './db.js';
import * as feishuMod from './feishu.js';
import * as restMod from './feishu_rest.js';
import * as slashMod from './feishu_slash.js';

/** Python `\s` 的字符类**内部**源码（从 `lib.js:PY_WS` 反解，保证与 `lib.js` 同表） */
const PY_SPACE_SRC = PY_WS.slice(1, -1);
const PY_SPLIT_WS = new RegExp(`[${PY_SPACE_SRC}]+`, 'u');
const PY_SPLIT_WS_COMMA = new RegExp(`[${PY_SPACE_SRC},]+`, 'u');
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE_SRC}]+|[${PY_SPACE_SRC}]+$`, 'gu');
/** Python `\d` 的 Unicode 语义（`str` 模式的 `\d` = `\p{Nd}`） */
const ND_RE = /\p{Nd}/u;
const ND_PLUS = new RegExp('^\\p{Nd}+$', 'u');
/** `_multi_answer_parts` 的入口闸：`re.match(r"\s*\d+\s*:", token or "")` */
const MULTI_PARTS_GATE = new RegExp(`^[${PY_SPACE_SRC}]*\\p{Nd}+[${PY_SPACE_SRC}]*:`, 'u');
const MULTI_PARTS_TOKEN = new RegExp(
  `^(\\p{Nd}+)[${PY_SPACE_SRC}]*:[${PY_SPACE_SRC}]*([^\\n]*)$`, 'u');
/** `\d+(?:\s*,\s*\d+)*`（fullmatch）：`_multi_answers:2337` / `_answer_by_token:2411` */
const INDEX_CSV = new RegExp(
  `^\\p{Nd}+(?:[${PY_SPACE_SRC}]*,[${PY_SPACE_SRC}]*\\p{Nd}+)*$`, 'u');
const INDEX_CSV_SPLIT = new RegExp(`[${PY_SPACE_SRC}]*,[${PY_SPACE_SRC}]*`, 'u');

// --------------------------------------------------------------------------
// Python 值语义小工具（每一条都对着 CPython 行为写）
// --------------------------------------------------------------------------

/** Python `bool()`：`None`/`False`/`0`/`""`/空容器假；**`nan` 为真**（JS `Boolean(NaN)` 是假） */
function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isNaN(value) ? true : value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b`（JS 的 `||` 对 `[]`/`{}`/`"0"` 分叉 ⇒ 必须显式） */
function pyOr(a, b) {
  return pyTruthy(a) ? a : b;
}

/** Python 类型名（异常文案用；只覆盖 oracle 会出现的形态） */
function pyTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string': return 'str';
    case 'number': return Number.isInteger(value) ? 'int' : 'float';
    case 'boolean': return 'bool';
    case 'object': return 'dict';
    default: return typeof value;
  }
}

function attributeError(typeName, attr) {
  const e = new Error(`'${typeName}' object has no attribute '${attr}'`);
  e.name = 'AttributeError';
  return e;
}

function valueError(message) {
  const e = new Error(message);
  e.name = 'ValueError';
  return e;
}

/** Python `dict.get(key[, default])`：键存在但值为 None ⇒ **返回 None**（不是 default） */
function dget(dict, key, dflt) {
  if (dict === null || dict === undefined || typeof dict !== 'object' || Array.isArray(dict)) {
    throw attributeError(pyTypeName(dict), 'get');
  }
  if (Object.hasOwn(dict, key)) return dict[key] === undefined ? null : dict[key];
  return dflt === undefined ? null : dflt;
}

/** Python 下标取值：缺键 ⇒ KeyError（对应 oracle 的 `intent["action"]` 这类写法） */
function requireKey(dict, key) {
  if (dict === null || dict === undefined || typeof dict !== 'object') {
    throw attributeError(pyTypeName(dict), key);
  }
  if (!Object.hasOwn(dict, key)) {
    const e = new Error(`'${key}'`);
    e.name = 'KeyError';
    throw e;
  }
  return dict[key] === undefined ? null : dict[key];
}

/** Python `str.strip()`——**非 str 抛 AttributeError**（`lib.js:pyStrip` 会静默 `String(v)`） */
function pyStripStrict(value) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), 'strip');
  return value.replace(PY_STRIP_RE, '');
}

/** Python `str.split()`（无参）：按 Python 空白集合切并丢空段 */
function pySplitWs(value) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), 'split');
  return value.split(PY_SPLIT_WS).filter((x) => x.length > 0);
}

/** Python 浮点 repr 的**近似**：整数形按 JS 最短表示；指数记法补到 ≥2 位并带显式符号 */
function pyNumRepr(value) {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Number.isInteger(value)) return Object.is(value, -0) ? '0' : String(value);
  return String(value).replace(/e([+-]?)(\d+)$/, (m, sign, digits) =>
    `e${sign === '-' ? '-' : '+'}${digits.padStart(2, '0')}`);
}

/** Python 字符串 repr（单引号优先；含 `'` 且不含 `"` 时改用双引号；控制符转义） */
function pyReprStr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/** Python `repr(value)`（容器走自己的 repr：`['a']` / `{'a': 1}`） */
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return pyReprStr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyNumRepr(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).map((k) => `${pyReprStr(k)}: ${pyRepr(value[k])}`).join(', ')}}`;
  }
  return String(value);
}

/** Python `str(value)`（容器 = repr；`None`/`True`/`False` 是 Python 字面形态） */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyNumRepr(value);
  return pyRepr(value);
}

/** `\p{Nd}` 字符的十进制数字值（Unicode 十进制数字块恒为连续 10 个码点） */
function ndValue(ch) {
  const cp = ch.codePointAt(0);
  let zero = cp;
  for (let i = 1; i <= 9 && zero > 0; i += 1) {
    if (!ND_RE.test(String.fromCodePoint(zero - 1))) break;
    zero -= 1;
  }
  return cp - zero;
}

/**
 * Python `int(value)`：**失败必须抛**（`Number("")===0` / `Number("abc")===NaN` 会静默改分支）。
 * 支持：bool、number（截断向零；`nan`/`inf` 抛）、字符串（可选符号 + `\p{Nd}` 数字 +
 * 数字间下划线，首尾 Python 空白）。
 */
function pyInt(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      throw valueError(`invalid literal for int() with base 10: '${pyStr(value)}'`);
    }
    if (!Number.isFinite(value)) throw valueError('cannot convert float infinity to integer');
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') {
    throw new TypeError('int() argument must be a string, a bytes-like object or a real number, '
      + `not '${pyTypeName(value)}'`);
  }
  const raw = pyStripStrict(value);
  let body = raw;
  let sign = 1;
  if (body.startsWith('+') || body.startsWith('-')) {
    if (body.startsWith('-')) sign = -1;
    body = body.slice(1);
  }
  if (body.length === 0) throw valueError(`invalid literal for int() with base 10: '${value}'`);
  let digits = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '_') {
      const prev = i > 0 ? body[i - 1] : '';
      const next = i + 1 < body.length ? body[i + 1] : '';
      if (prev === '' || next === '' || !ND_RE.test(prev) || !ND_RE.test(next)) {
        throw valueError(`invalid literal for int() with base 10: '${value}'`);
      }
      continue;
    }
    if (!ND_RE.test(ch)) throw valueError(`invalid literal for int() with base 10: '${value}'`);
    digits += String(ndValue(ch));
  }
  return sign * Number(digits);
}

/** Python `x in (None, "")` 的相等比较口径（`0`/`False` **不在**其中，2186/2190） */
function isNoneOrEmpty(value) {
  return value === null || value === undefined || value === '';
}

/** `Numeric_Type=Digit` 的上标/带圈形（`str.isdigit()` 比 `\p{Nd}` 宽的那部分） */
const DIGIT_EXTRA = /[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2473\u24ea\u24ff\u2776-\u2793]/u;

function pyIsDigit(value) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), 'isdigit');
  if (value.length === 0) return false;
  for (const ch of value) if (!ND_RE.test(ch) && !DIGIT_EXTRA.test(ch)) return false;
  return true;
}

/** Python `s[:n]`（按**码点**切，不是 UTF-16 码元） */
function pySlice(value, n) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), '__getitem__');
  const points = Array.from(value);
  return points.length <= n ? value : points.slice(0, n).join('');
}

/** Python `len(s)`（按码点计；非 str 抛 TypeError） */
function pyLen(value) {
  if (typeof value === 'string') return Array.from(value).length;
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  throw new TypeError(`object of type '${pyTypeName(value)}' has no len()`);
}

/** Python `dict(x)` 的浅拷贝口径（字符串/数字 ⇒ 抛，list-of-pairs ⇒ 接受） */
function pyDictCopy(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (Array.isArray(value)) {
    const out = {};
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw valueError('dictionary update sequence element has length != 2');
      }
      out[pair[0]] = pair[1];
    }
    return out;
  }
  if (typeof value === 'string') {
    throw valueError(`dictionary update sequence element #0 has length ${value.length}; 2 is required`);
  }
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/** Python `json.loads(text)`：非 str ⇒ TypeError（`JSON.parse(123)` 会静默成功） */
function pyJsonLoads(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`the JSON object must be str, bytes or bytearray, not ${pyTypeName(text)}`);
  }
  return JSON.parse(text);
}

/** Python `re.split(r"[\s,]+", s)` 的等价切分 */
function splitWsComma(value) {
  return value.split(PY_SPLIT_WS_COMMA).filter((x) => x.length > 0);
}

/**
 * Python 正则 → JS 正则的**逐字符**翻译（只做会分叉的四处）：
 * `\s`→PY_SPACE 类、`\S`→取反类、`\d`→`\p{Nd}`、`.`→`[^\n]`（Python 的 `.` 只排除 `\n`）。
 */
function pyPatternToJs(src) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      const nx = src[i + 1];
      i += 1;
      if (nx === 's') out += `[${PY_SPACE_SRC}]`;
      else if (nx === 'S') out += `[^${PY_SPACE_SRC}]`;
      else if (nx === 'd') out += '\\p{Nd}';
      else if (nx === 'D') out += '\\P{Nd}';
      else out += `\\${nx}`;
    } else if (ch === '.') out += '[^\\n]';
    else out += ch;
  }
  return out;
}

/** 异常 → Python `repr(e)` 的近似（见文件头差异 5） */
export function errorRepr(e) {
  if (e instanceof Error) {
    const name = typeof e.pyName === 'string' ? e.pyName : (e.name || 'Error');
    return `${name}(${pyReprStr(e.message === undefined ? String(e) : e.message)})`;
  }
  return pyRepr(e);
}

// --------------------------------------------------------------------------
// 依赖解析（末位 `options` 注入；默认值 = 真模块）
// --------------------------------------------------------------------------

/**
 * 默认日志口：`console.error(line)`（= 写 stderr 且补一个 `\n`，与
 * `print(..., file=sys.stderr, flush=True)` 同形）。用 `console.error` 而不是直接
 * `process.stderr.write` 的原因：仓库既有单测（`feishu-me-routes.test.mjs` 的
 * `captureStderr`）就是**打桩 `console.error`** 来抓这几行的。
 */
function defaultLog(line) {
  console.error(line);
}

/** `feishu_conv.js`（M7.5-R3）惰性转发器：R3 落地后产品路径零改动即生效（文件头差异 10） */
let convModulePromise = null;
function loadConvModule() {
  if (convModulePromise === null) convModulePromise = import('./feishu_conv.js');
  return convModulePromise;
}

function lazyConv() {
  const call = async (name, args) => {
    const mod = await loadConvModule();
    const fn = mod[name];
    if (typeof fn !== 'function') throw new TypeError(`feishu_conv.js 未导出 ${name}（M7.5-R3）`);
    return fn(...args);
  };
  return {
    enabled: (...a) => call('enabled', a),
    routeText: (...a) => call('routeText', a),
    convIntent: (...a) => call('convIntent', a),
    onCardAction: (...a) => call('onCardAction', a),
    setDefaultProject: (...a) => call('setDefaultProject', a),
    projectById: (...a) => call('projectById', a),
  };
}

/**
 * 依赖表：Python 的模块级全局（`db.*`/`rest_reply`/`board.*`/`feishu_conv.*`）的注入点。
 *
 * ⚠**`options.db` 不是模块槽**：仓库既有语义（`db.js`/`feishu.js`/`board.js` 全线）里
 * `options.db` = **node:sqlite 句柄**，会被逐层透传给 db.js 的数据访问函数。要替换整个
 * **db 模块**用 `options.dbmod`（Node 侧专属注入点，oracle 无对应物）。
 */
function dep(options = {}) {
  return {
    db: options.dbmod || dbMod,
    rest: options.rest || restMod,
    board: options.board || boardMod,
    conv: options.conv || lazyConv(),
    slash: options.slash || slashMod,
    feishu: options.feishu || feishuMod,
    now: options.now || (() => Date.now() / 1000),
    log: options.log || defaultLog,
    env: options.env || process.env,
  };
}

// ==========================================================================
// 用户可见常量（`feishu.py:1579-1606` / `1985-2003` / `2599-2603`）
// ==========================================================================

/**
 * 未识别文本 / `help` 意图 / 未知看板动作的兜底回复。
 * **源码 28 行、求值后 21 行**（1596+1597+1598 / 1600+1601 / 1604+1605 三处相邻字面量隐式
 * 拼接）——本常量按**求值后**形态书写，单测用 oracle 现算的 utf-8 sha256 锚住。
 */
export const HELP_TEXT = 'Touchstone 指令（单聊可用）：\n'
  + '直接发普通文字 = 与当前会话对话（未绑定会在默认项目自动新建）。\n'
  + '· 帮助 — 本说明\n'
  + '· 绑定 <码> — 绑定站点账号（绑定码在站点侧栏「设置」→ 飞书设置 生成）\n'
  + '· 解绑 — 解除绑定\n'
  + '· 当前 — 查看默认项目与当前会话\n'
  + '· 项目 — 项目总览卡（点选即设为默认项目）\n'
  + '· 会话 — 默认项目最近活跃的 10 个会话（点选即绑定）\n'
  + '· 新建会话 [标题] — 在默认项目下新建并绑定\n'
  + '· 绑定会话 <序号|标题关键字|会话id前缀> — 绑定已有会话\n'
  + '· 解绑会话 — 只解绑会话，保留默认项目\n'
  + '· 默认项目 <项目名> — 设置默认项目\n'
  + '· 状态 [项目名] — 任务与看板摘要\n'
  + '· 卡片 <关键字> — 找卡片（id 前缀/标题包含）\n'
  + '· 通过 <卡片> — 待审核卡片完成审核\n'
  + '· 驳回 <卡片> <意见> — 打回继续开发\n'
  + '· 作答 <卡片> <选项序号|文字> — 回复 agent 提问'
  + '（多选逗号分隔：作答 7 1,3；文字=自定义回答。单题多选卡上勾选后'
  + '点「提交作答」即可，无需打字）\n'
  + '· 作答 <卡片> <题号:值 …> — 多子题一次答全'
  + '（如「作答 7 1:2 2:1 3:1,3」；多选写 1:2,3，自定义写 1:文字。'
  + '多子题卡可直接在卡片上逐题点选，点满自动送达，已点选的题不必重复给）\n'
  + '· 同意 <卡片> [会话] — 批准挂起的工具审批（「会话」=本会话内自动放行）\n'
  + '· 拒绝 <卡片> — 拒绝挂起的工具审批\n'
  + '· 快捷指令：输入框里打「/」可直接选 /status、/cards、/approve 等'
  + '（参数用法与上面对应中文指令一致）';

/**
 * 规则意图表（**顺序即优先级**，首个命中即返回）。**存 Python 原文**（与 oracle 的
 * `(action, pattern)` 元组同形，便于对拍）；匹配走 `INTENT_RES` 的翻译版。
 */
export const INTENT_RULES = Object.freeze([
  Object.freeze(['help', '^(?:帮助|help|/help)$']),
  Object.freeze(['bind', '^(?:绑定|/bind)\\s*([A-Za-z0-9]{4,8})$']),
  Object.freeze(['unbind', '^(?:解绑|/unbind)$']),
  Object.freeze(['default_project', '^(?:默认项目|/project)\\s+(\\S+)$']),
  Object.freeze(['current', '^(?:当前|/current)$']),
  Object.freeze(['projects', '^(?:项目|/projects)$']),
  Object.freeze(['sessions', '^(?:会话|/sessions)$']),
  Object.freeze(['new', '^(?:新建会话|/new)(?:\\s+(.+))?$']),
  Object.freeze(['use', '^(?:绑定会话|/use)\\s+(.+)$']),
  Object.freeze(['leave', '^(?:解绑会话|/leave)$']),
  Object.freeze(['status', '^(?:状态|/status)(?:\\s+(.+))?$']),
  Object.freeze(['card', '^(?:卡片|/cards?)\\s+(.+)$']),
  Object.freeze(['approve', '^(?:通过|/approve)\\s+(\\S+)$']),
  Object.freeze(['reject', '^(?:驳回|/reject)\\s+(\\S+)\\s+(.+)$']),
  Object.freeze(['answer', '^(?:作答|/answer)\\s+(\\S+)\\s+(.+)$']),
  Object.freeze(['agree', '^(?:同意|/agree)\\s+(\\S+)(?:\\s+(会话|session))?$']),
  Object.freeze(['deny', '^(?:拒绝|/deny)\\s+(\\S+)$']),
]);

/** `_INTENT_RULES` 的编译产物（oracle 每轮 `re.match(pat, t)` 都重编译，这里缓存一次） */
const INTENT_RES = INTENT_RULES.map(([action, pat]) =>
  [action, new RegExp(pyPatternToJs(pat), 'u')]);

/** `_COL_ORDER`（2599）：看板五列的**展示顺序**（`_board_summary` 的计数顺序即它） */
export const COL_ORDER = Object.freeze(['todo', 'doing', 'blocked', 'review', 'done']);
/** `_COL_LABELS`（2600-2601） */
export const COL_LABELS = Object.freeze({
  todo: '待开发', doing: '正在开发', blocked: '阻塞', review: '待审核', done: '已完成',
});
/** `_TASK_STATUS`（2602-2603） */
export const TASK_STATUS = Object.freeze({
  queued: '排队', running: '运行中', done: '已完成', failed: '失败', stopped: '已停止',
  interrupted: '中断',
});

/** `dict.get(k, k)` 形态的映射取值（键存在但值为 None 时 Python 回 None，这里照抄） */
function lookupLabel(table, key) {
  return Object.hasOwn(table, key) ? table[key] : key;
}

// ==========================================================================
// 进程内态（`feishu.py:1608-1614` / `2108-2109`）
// ==========================================================================

/** `_MSG_SEEN`（1609-1611）：message_id 去重 LRU，**最大 512**（`len > 512` 才淘汰） */
const MSG_SEEN = new Set();
/** `_EVT_SEEN`（1612-1614）：卡片回调 event_id 去重 LRU，同样是 512；两者互不影响 */
const EVT_SEEN = new Set();
const MSG_SEEN_MAX = 512;
const EVT_SEEN_MAX = 512;
/** `_MQ_STAGE`（2109）：`(卡号:int, qid:str) -> {n, vals:Map<no,val>, at}`（桶键见 `mqKey`） */
const MQ_STAGE = new Map();

/** LRU 记一条：命中 ⇒ true（**方向与直觉相反**：oracle 的调用点写作 `if ..._seen(x): return`） */
function seenPush(table, max, key) {
  if (table.has(key)) return true;
  table.add(key);
  if (table.size > max) {
    // Python: `set.discard(list.pop(0))` —— JS Set 的迭代序即插入序
    table.delete(table.values().next().value);
  }
  return false;
}

/** 卡片回调 event_id 去重（1617-1625）：`true`=重复 */
export function seenEvent(eid) {
  return seenPush(EVT_SEEN, EVT_SEEN_MAX, eid);
}

/** `message_id` 去重（1785-1793）：`true`=重复消息（飞书会重推） */
export function seenMessage(mid) {
  return seenPush(MSG_SEEN, MSG_SEEN_MAX, mid);
}

/** Node 专有测试缝：当前消息 LRU 长度（oracle 判据 `len > 512` ⇒ 稳态恰好 512） */
export function msgSeenSize() { return MSG_SEEN.size; }

/** Node 专有测试缝：事件 LRU 长度 */
export function evtSeenSize() { return EVT_SEEN.size; }

/** Node 专有测试缝：暂存桶数量（oracle 判据 `len > 64` ⇒ 稳态恰好 64） */
export function mqStageSize() { return MQ_STAGE.size; }

/** Node 专有测试缝：清空三个进程内态（产品路径不调用）——对齐 oracle 的「重启即丢」 */
export function resetInboundState() {
  MSG_SEEN.clear();
  EVT_SEEN.clear();
  MQ_STAGE.clear();
}

// ==========================================================================
// 意图解析（`feishu.py:2009-2016`）
// ==========================================================================

/**
 * 规则意图解析：未识别返回 `null`。
 * `t = (text or "").strip()`（2011）只剥首尾；`re.match` 逐条试表，**首个命中即返回**；
 * `groups` 是定长列表（未参与的捕获组是 `null`，不是 `""`）。
 */
export function parseIntent(text) {
  const t = pyStripStrict(pyOr(text, ''));
  for (const [action, re] of INTENT_RES) {
    const m = re.exec(t);
    if (m !== null) {
      return { action, groups: Array.from(m).slice(1).map((g) => (g === undefined ? null : g)) };
    }
  }
  return null;
}

// ==========================================================================
// toast / DM（`feishu.py:1865-1881` / `2202-2204`）
// ==========================================================================

/** `_toast`（2202-2204）：键序 `type → content`，kind 不校验 */
export function toast(kind, content) {
  return { toast: { type: kind, content } };
}

/**
 * `_toast_for`（1865-1873）：执行器回执 → 卡片 toast。
 * `ok = reply.startswith(("已收下", "✅"))`（元组 = OR）；`reply is None` ⇒ `null`；
 * **空串走 error 分支**（1868 只判 `is None`）。
 */
export function toastFor(reply) {
  if (reply === null || reply === undefined) return null;
  const ok = reply.startsWith('已收下') || reply.startsWith('✅');
  return {
    toast: {
      type: ok ? 'success' : 'error',
      content: ok ? '已收下，详情看机器人单聊' : '操作失败，详情看机器人单聊',
    },
  };
}

/** `_dm_text`（1876-1881）：DM 文本旁路发送，失败留痕不外抛 */
export async function dmText(openId, text, cfg, options = {}) {
  const d = dep(options);
  try {
    await d.rest.restSendText(openId, text, cfg);
  } catch (e) {
    d.log(`feishu inbound: DM 回执发送失败: ${errorRepr(e)}`);
  }
}

/** 卡片路径的未绑定引导（1916-1917/1924-1925：**「在单聊回复」**，区别于 1845 的「在这里回复」） */
const UNBOUND_DM_CARD = '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ '
  + '飞书设置，生成绑定码后在单聊回复「绑定 <码>」完成绑定';
/** 消息路径 / 权限卡路径的未绑定引导（1845-1846 与 1558-1559：**「在这里回复」**） */
const UNBOUND_DM_MSG = '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ '
  + '飞书设置，生成绑定码后在这里回复「绑定 <码>」完成绑定';

// ==========================================================================
// 多选暂存桶（`feishu.py:2096-2199`）
// ==========================================================================

/**
 * 桶键 = `(int(cid), str(qid or ""))`（2125/2141/2152/2159）。Python 的 tuple 键在 JS 里用
 * NUL 分隔的复合串表达（cid 是数字、qid 是字符串 ⇒ 无歧义；NUL 不可能是 qid 的合法组成）。
 */
function mqKey(cid, qid) {
  return `${pyStr(pyInt(cid))}\u0000${pyStr(pyOr(qid, ''))}`;
}

/**
 * `_mq_prune_locked`（2112-2118）：清过期（`now - at > 1800`，**严格 `>`**）+ 超量
 * （`len > 64` ⇒ 削到恰好 64；`min` 平局取**插入序**第一个）。
 * 调用方必须已持锁 —— Node 侧临界区由同步函数天然保证（文件头差异 4）。
 */
export function mqPruneLocked(now, options = {}) {
  dep(options);
  for (const [key, bucket] of [...MQ_STAGE.entries()]) {
    if (now - bucket.at > MQ_TTL) MQ_STAGE.delete(key);
  }
  while (MQ_STAGE.size > MQ_MAX_BUCKETS) {
    let oldest = null;
    let best = Infinity;
    for (const [key, bucket] of MQ_STAGE) {      // Python `min`：首个最小值（插入序）
      if (bucket.at < best) { best = bucket.at; oldest = key; }
    }
    MQ_STAGE.delete(oldest);
  }
}

/**
 * `_mq_put`（2121-2135）：写一题答案 → `[已答数, 总题数, 是否答满]`。
 * `now = time.time()` 一次取、复用于 prune 与 `bucket.at`（2124/2127/2133）；
 * 桶不存在**或题数不符即重建**（2129-2131：卡片可能已指向新提问，宁可重来不可串答）。
 */
export function mqPut(cid, qid, n, no, val, options = {}) {
  const d = dep(options);
  const now = d.now();
  const key = mqKey(cid, qid);
  mqPruneLocked(now, options);
  let bucket = MQ_STAGE.get(key);
  const total = pyInt(n);
  if (bucket === undefined || bucket.n !== total) {
    bucket = { n: total, vals: new Map(), at: now };
    MQ_STAGE.set(key, bucket);
  }
  bucket.vals.set(pyInt(no), pyStr(val));
  bucket.at = now;
  const done = bucket.vals.size;
  return [done, total, done >= total];
}

/**
 * `_mq_take`（2138-2146）：取走并清空 → `[[题号, 题值], …]`（题号**数值升序**）。
 * ⚠**先 pop 再判题数**（2143-2144）⇒ 题数不符时桶已被销毁；**不看 TTL**（390 行的陷阱）。
 */
export function mqTake(cid, qid, n, options = {}) {
  dep(options);
  const key = mqKey(cid, qid);
  const bucket = MQ_STAGE.get(key);
  MQ_STAGE.delete(key);
  if (bucket === undefined || bucket.n !== pyInt(n)) return [];
  return [...bucket.vals.keys()].sort((a, b) => a - b).map((no) => [no, bucket.vals.get(no)]);
}

/**
 * `_mq_peek`（2149-2153）：只读已暂存答案（浅拷贝、不改动暂存、不刷 `at`、不判 TTL）。
 * 形态差异：Python 返回 `dict[int, str]`，JS 无 int 键字典 ⇒ 返回**数值串为键的普通对象**；
 * 范围内的唯一消费者（`_answer_by_token` 的多子题合并）会转回 number 并按数值升序排。
 */
export function mqPeek(cid, qid, options = {}) {
  dep(options);
  const bucket = MQ_STAGE.get(mqKey(cid, qid));
  if (bucket === undefined) return {};
  const out = {};
  for (const [no, val] of bucket.vals) out[no] = val;
  return out;
}

/** `_mq_drop`（2156-2159）：丢弃该提问的暂存（不存在时静默） */
export function mqDrop(cid, qid, options = {}) {
  dep(options);
  MQ_STAGE.delete(mqKey(cid, qid));
  return undefined;
}

/**
 * `_multi_click_index`（2162-2199）：飞书回调 → 所选选项**序号**列表（1 起）；取不到 `null`。
 * 三条来源：① `multi` 时 `action.form_value[<组件 name>]`（数组 / 字符串按空白逗号切）→ 兜底
 * `action.options`；② 非 `multi` 时 `action.option`（标量或数组）；③ 兜底 `action.value.i`。
 * 任一元素不过 `\d+` 即**整体**返回 `null`；`re.fullmatch` 走 `\p{Nd}`（Python `\d` 的 Unicode 语义）。
 */
export function multiClickIndex(action, multi, name) {
  let vals = null;
  if (pyTruthy(multi)) {
    const raw = dget(pyOr(dget(action, 'form_value'), {}), name);
    if (Array.isArray(raw) && raw.length > 0) vals = raw.map(pyStr);
    else if (typeof raw === 'string' && pyTruthy(pyStripStrict(raw))) {
      vals = splitWsComma(pyStripStrict(raw));
    }
    if (vals === null) {                       // 兼容别种回传形态（2178-2181）
      const alt = dget(action, 'options');
      if (Array.isArray(alt) && alt.length > 0) vals = alt.map(pyStr);
    }
  } else {
    const raw = dget(action, 'option');
    if (Array.isArray(raw) && raw.length > 0) vals = raw.map(pyStr);
    else if (!isNoneOrEmpty(raw)) vals = [pyStr(raw)];   // `raw not in (None, "")`：0/False 放过
  }
  if (vals === null) {
    const one = dget(pyOr(dget(action, 'value'), {}), 'i');
    if (!isNoneOrEmpty(one)) vals = [pyStr(one)];
  }
  if (!pyTruthy(vals)) return null;
  const out = [];
  for (const v of vals) {
    if (!ND_PLUS.test(v)) return null;
    out.push(pyInt(v));
  }
  return out;
}

// ==========================================================================
// 多子题作答载荷（`feishu.py:2276-2359`）
// ==========================================================================

/**
 * `_multi_answer_parts`（2276-2296）：`1:2 2:1 3:3` → `[[题号, 题值], …]`；非多题形态 `null`。
 * 入口闸只锚开头（`re.match`）；切词用无参 `split()`；不以 `<数字>:` 开头的 token
 * **续接到上一题**（含空格）；题号可重复（本函数不查重）。
 */
export function multiAnswerParts(token) {
  if (!MULTI_PARTS_GATE.test(pyOr(token, ''))) return null;
  const parts = [];
  let cur = null;
  for (const tok of pySplitWs(pyStr(token))) {
    const m = MULTI_PARTS_TOKEN.exec(tok);
    if (m !== null) {
      cur = [pyInt(m[1]), m[2]];
      parts.push(cur);
    } else if (cur !== null) {
      cur[1] = `${cur[1]} ${tok}`.trim();
    } else {
      return null;
    }
  }
  return parts.length > 0 ? parts.map(([no, val]) => [no, val]) : null;
}

/**
 * `_multi_answers`（2309-2359）：逐题值 → `board.answer_interaction` 的 answers 载荷。
 * 返回 `[answers, err]`；**err 非空即 answers 为 `null`**（不提交半份）。阶段一归一/查重/缺题，
 * 阶段二按**题号升序**逐题造载荷（`wire` 走 `str()`，序号形态不去重）。
 */
export function multiAnswers(qs, parts) {
  const n = qs.length;
  const seen = new Map();
  for (const [no, val] of parts) {
    if (no < 1 || no > n) return [null, `题号 ${no} 无效（本提问共 ${n} 题）`];
    if (seen.has(no)) return [null, `第 ${no} 题重复作答`];
    seen.set(no, pyStripStrict(pyOr(val, '')));
  }
  const missing = [];
  for (let i = 1; i <= n; i += 1) if (!seen.has(i)) missing.push(i);
  if (missing.length > 0) {
    const heads = missing.map((i) =>
      `第 ${i} 题（${pyOr(dget(pyOr(qs[i - 1], {}), 'header'), '未命名')}）`).join('、');
    return [null, `还差 ${heads} 未作答，请一次答全 ${n} 题`];
  }
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const q = pyOr(qs[i - 1], {});
    const val = seen.get(i);
    const wire = pyStr(pyOr(dget(q, 'id'), `q_${i - 1}`));
    const opts = pyOr(dget(q, 'options'), []);
    const multi = pyTruthy(dget(q, 'multi_select'));
    if (INDEX_CSV.test(val)) {                              // 序号形态（单个/逗号多选）
      if (!pyTruthy(opts)) return [null, `第 ${i} 题没有选项，请直接写回答文字`];
      const idxs = val.split(INDEX_CSV_SPLIT).map(pyInt);
      if (idxs.some((x) => x < 1 || x > opts.length)) {
        return [null, opts.length > 1
          ? `第 ${i} 题选项序号无效（共 ${opts.length} 个选项）`
          : `第 ${i} 题只有一个选项，序号填 1`];
      }
      if (idxs.length > 1 && !multi) return [null, `第 ${i} 题为单选，请只给一个序号`];
      const ids = idxs.map((x) => pyStr(pyOr(dget(pyOr(opts[x - 1], {}), 'id'), '')));
      if (ids.length > 1) out.push({ wire, kind: 'multi', option_ids: ids });
      else out.push({ wire, kind: 'single', option_id: ids[0] });
      continue;
    }
    if (!pyTruthy(val)) return [null, `第 ${i} 题未作答`];
    if (pyLen(val) > 2000) return [null, `第 ${i} 题自定义输入过长（限 2000 字）`];
    if (!pyTruthy(dget(q, 'allow_other', true))) {
      return [null, `第 ${i} 题不支持自定义输入，请给选项序号`];
    }
    out.push({ wire, kind: 'other', text: val });
  }
  return [out, ''];
}

// ==========================================================================
// 找卡 / 项目定位 / 详情 / 摘要（`feishu.py:2082-2093` / `2523-2596`）
// ==========================================================================

/** `_find_cards`（2548-2560）：纯数字按 id 前缀，否则标题包含；命中序 = 项目 id + 列 + 列内序 */
export async function findCards(userId, key, options = {}) {
  const d = dep(options);
  const hits = [];
  for (const p of d.db.listProjects(userId, options)) {
    for (const c of d.db.listBoardCards(dget(p, 'id'), options)) {
      const row = { ...c };
      if (pyIsDigit(key)) {
        if (pyStr(row.id).startsWith(key)) hits.push([p, row]);
      } else if (pyOr(row.title, '').includes(key)) {
        hits.push([p, row]);
      }
    }
  }
  return hits;
}

/**
 * `_find_user_card`（2082-2093）：找卡并消歧 → `[project, card]` 或 `[null, 错误文案]`。
 * 成功时第二项是**空串**（2093）⇒ 调用方必须用 `is None` 判（本文件两处都判 `null`）。
 */
export async function findUserCard(userId, key, options = {}) {
  const hits = await findCards(userId, key, options);
  if (hits.length === 0) {
    return [null, `没有找到匹配「${pyStr(key)}」的卡片（仅搜你自己的项目；支持 id 前缀/标题包含）`];
  }
  if (hits.length > 1) {
    const lines = ['匹配到多张卡，请用更精确的 id 或关键字：'];
    for (const [p, c] of hits.slice(0, 6)) {          // 最多 6 条
      lines.push(`· #${c.id} [${p.name}] ${pySlice(pyOr(c.title, ''), 30)}`);
    }
    return [null, lines.join('\n')];
  }
  return [hits[0], ''];
}

/** `_card_detail`（2563-2574）：列位/阻塞原因/最近错误，末尾一行固定引导（`%s` 五次同值） */
export function cardDetail(p, c) {
  const lines = [
    `卡片 #${c.id} [${p.name}] ${pySlice(pyOr(c.title, ''), 40)}`,
    `状态：${lookupLabel(COL_LABELS, c.column_key)}`,
  ];
  if (c.column_key === 'blocked') {
    lines.push(`阻塞原因：${pyOr(pyOr(dget(c, 'block_text'), dget(c, 'block_kind')), '未知')}`);
  }
  if (pyTruthy(dget(c, 'last_error'))) lines.push(`最近错误：${pySlice(c.last_error, 120)}`);
  lines.push('回复「作答 %s <选项序号|文字>」回复提问；「同意 %s」/「拒绝 %s」'
    .concat('处理审批；「通过 %s」完成审核；「驳回 %s 意见」打回')
    .replaceAll('%s', pyStr(c.id)));
  return lines.join('\n');
}

/** `_board_summary`（2577-2596）：任务计数 + 逐任务点名（不截条数）+ 五列计数 + 阻塞卡（≤5） */
export async function boardSummary(p, options = {}) {
  const d = dep(options);
  const tasks = pyOr(d.db.listTasks(dget(p, 'id'), options), []);
  const nRun = tasks.filter((t) => t.status === 'running').length;
  const nQue = tasks.filter((t) => t.status === 'queued').length;
  const lines = [`[${p.name}] 任务：运行中 ${nRun} / 排队 ${nQue}（共 ${tasks.length}）`];
  for (const t of tasks) {
    if (t.status === 'running' || t.status === 'queued') {
      lines.push(`· #${t.id} ${pySlice(t.name, 30)}（${lookupLabel(TASK_STATUS, t.status)}）`);
    }
  }
  const cards = d.db.listBoardCards(dget(p, 'id'), options).map((c) => ({ ...c }));
  const byCol = {};
  for (const c of cards) {
    byCol[c.column_key] = (Object.hasOwn(byCol, c.column_key) ? byCol[c.column_key] : 0) + 1;
  }
  lines.push('看板：' + COL_ORDER.map((k) =>
    `${lookupLabel(COL_LABELS, k)}${Object.hasOwn(byCol, k) ? byCol[k] : 0}`).join(' '));
  const blocked = cards.filter((c) => c.column_key === 'blocked');
  for (const c of blocked.slice(0, 5)) {
    lines.push(`⛔ #${c.id} ${pySlice(pyOr(c.title, ''), 30)}`
      + `（${pyOr(pyOr(dget(c, 'block_text'), dget(c, 'block_kind')), '')}）`);
  }
  return lines.join('\n');
}

/**
 * `_resolve_project`（2523-2545）：显式名（精确 → 唯一包含）→ 默认项目 → 用户唯一项目 →
 * 报错列可选（**最多 8 个**、`、` 连接）。返回 `[project, ""]` 或 `[null, 错误文案]`。
 */
export async function resolveProject(binding, name, options = {}) {
  const d = dep(options);
  const userId = requireKey(binding, 'user_id');
  const projects = d.db.listProjects(userId, options);
  if (pyTruthy(name)) {
    for (const p of projects) if (p.name === name) return [p, ''];
    const hits = projects.filter((p) => p.name.includes(name));
    if (hits.length === 1) return [hits[0], ''];
    return [null, `项目「${pyStr(name)}」不在你的项目列表`];
  }
  if (pyTruthy(requireKey(binding, 'default_project_id'))) {
    for (const p of projects) {
      if (p.id === binding.default_project_id) return [p, ''];
    }
  }
  if (projects.length === 1) return [projects[0], ''];
  if (projects.length === 0) return [null, '你还没有项目，请先到站点创建'];
  return [null, '请指明项目（回复「状态 项目名」），可选：'
    + projects.slice(0, 8).map((p) => p.name).join('、')];
}

/** `_set_default_project`（2062-2079）：`project_id` 非 0 按 id，否则按名（精确 → 唯一包含） */
export async function setDefaultProject(binding, name, projectId = 0, options = {}) {
  const d = dep(options);
  if (pyTruthy(projectId)) {
    const project = await d.conv.projectById(binding, projectId, options);
    if (project === null || project === undefined) return '项目不在你的项目列表';
    // 必须走 R3 的同一个 set_default_project（换项目自动清当前会话在该函数内，2064-2065）
    return await d.conv.setDefaultProject(binding, project, options);
  }
  const userId = requireKey(binding, 'user_id');
  const projects = d.db.listProjects(userId, options);
  for (const p of projects) {
    if (p.name === name) return await d.conv.setDefaultProject(binding, p, options);
  }
  const hits = projects.filter((p) => p.name.includes(name));
  if (hits.length === 1) return await d.conv.setDefaultProject(binding, hits[0], options);
  // ⚠歧义（≥2 命中）与零命中**同一文案**（与 `_resolve_project` 的「列可选」不同）
  return `项目「${pyStr(name)}」不在你的项目列表`;
}

// ==========================================================================
// 作答与审批（`feishu.py:2207-2468`）—— 文本指令与卡片按钮**共用**
// ==========================================================================

/** `_answer_by_token`（2362-2448）：作答单题/多题提问，返回回执文案（恒非 None） */
export async function answerByToken(p, c, token, options = {}) {
  const d = dep(options);
  const st = d.board.interactionOfSid(pyOr(c.session_id, ''));
  if (!pyTruthy(st) || !pyTruthy(dget(st, 'pending'))) {
    return `卡片 #${c.id} 当前没有等待中的提问`;
  }
  if (dget(st, 'kind') === 'approval') {
    return `该等待是工具审批，请回复「同意 ${c.id}」或「拒绝 ${c.id}」`;
  }
  if (!pyTruthy(dget(st, 'answerable'))) return NO_REMOTE_ANSWER_HINT;
  const qs = pyOr(dget(st, 'questions'), []);      // 单题分支**不过滤假值**（2378/2406）
  if (qs.length > 1) {
    let parts = multiAnswerParts(token);
    const staged = mqPeek(c.id, dget(st, 'qid'), options);   // 同一个 st 快照（2381/2397/2398）
    if (parts === null) {
      if (!pyTruthy(staged)) return d.feishu.multiAnswerHelp(c.id, qs);   // 复用 M7 实现（2384）
      parts = Object.entries(staged).map(([k, v]) => [Number(k), v])
        .sort((a, b) => a[0] - b[0]);
    } else {
      const nos = parts.map(([no]) => no);
      const dupAt = nos.findIndex((x) => nos.filter((y) => y === x).length > 1);
      if (dupAt >= 0) return `第 ${nos[dupAt]} 题重复作答`;
      const merged = new Map(Object.entries(staged).map(([k, v]) => [Number(k), v]));
      for (const [no, val] of parts) merged.set(no, val);          // 文本值覆盖暂存值
      parts = [...merged.entries()].sort((a, b) => a[0] - b[0]);
    }
    const [answers, err] = multiAnswers(qs, parts);
    if (pyTruthy(err)) return err;                    // ⚠多题分支的 err **无前缀**（2396）
    const err2 = await d.board.answerInteraction(p, c, dget(st, 'qid'), answers, options);
    mqDrop(c.id, dget(st, 'qid'), options);           // 提交后被消费（成功与否都清，2398）
    if (pyTruthy(err2)) return `作答失败：${err2}`;
    return `已收下：卡片 #${c.id} ${answers.length} 道作答，排队送达中`;
  }
  if (multiAnswerParts(token) !== null) {
    // 单题收到「1:2」这类逐题语法：明确纠正，别当自由文本提交（2402-2405）
    return `该提问只有一道题，请回复「作答 ${c.id} <选项序号>」`
      + `或「作答 ${c.id} <文字>」`;
  }
  const q0 = qs.length > 0 ? qs[0] : {};
  const opts = pyOr(pyOr(dget(q0, 'options'), null), pyOr(dget(st, 'options'), []));  // 两级兜底
  const wire = pyOr(dget(q0, 'id'), 'q_0');          // ⚠**无 str()**（2408），与 2334 不一致
  const optList = opts.map((o, i) => `${i + 1})${dget(pyOr(o, {}), 'label', '')}`).join(' / ');
  if (INDEX_CSV.test(token)) {
    const idxs = token.split(INDEX_CSV_SPLIT).map(pyInt);
    if (idxs.some((i) => i < 1 || i > opts.length)) {
      return pyTruthy(opts) ? `选项序号无效，可回复：${optList}` : '该提问没有可选选项';
    }
    if (idxs.length === 1) {
      const opt = opts[idxs[0] - 1];
      const err = await d.board.answerInteraction(p, c, dget(st, 'qid'),
        [{ wire, kind: 'single', option_id: dget(pyOr(opt, {}), 'id') }], options);
      if (pyTruthy(err)) return `作答失败：${err}`;
      return `已收下：卡片 #${c.id} 选择「${dget(pyOr(opt, {}), 'label', '')}」，排队送达中`;
    }
    if (!pyTruthy(dget(q0, 'multi_select'))) return '该问题不支持多选，请回复单个选项序号';
    const chosen = idxs.map((i) => opts[i - 1]);
    const err = await d.board.answerInteraction(p, c, dget(st, 'qid'),
      [{ wire, kind: 'multi', option_ids: chosen.map((o) => dget(pyOr(o, {}), 'id')) }], options);
    if (pyTruthy(err)) return `作答失败：${err}`;
    const labels = chosen.map((o) => dget(pyOr(o, {}), 'label', '')).join('、');
    return `已收下：卡片 #${c.id} 多选「${labels}」，排队送达中`;
  }
  if (!pyTruthy(dget(q0, 'allow_other'))) {          // 文本形态：须题目 allow_other（2437）
    if (pyTruthy(opts)) return `该问题不支持自定义输入，可回复选项序号：${optList}`;
    return '该提问无选项且不支持自定义输入，请到站点会话窗口处理';
  }
  if (pyLen(token) > 2000) return '输入内容过长（限 2000 字）';
  const err = await d.board.answerInteraction(p, c, dget(st, 'qid'),
    [{ wire, kind: 'other', text: token }], options);
  if (pyTruthy(err)) return `作答失败：${err}`;
  return `已收下：卡片 #${c.id} 自定义回答，排队送达中`;
}

/**
 * `_answer_multi_click`（2207-2273）：多选类点选（多子题逐题点选 / 单题多选 mini 表单）。
 * 返回 `[DM 回执文案 or "", toast]`——**toast 恒有**，未答满时 DM 是空串。
 * 校验一律读 `interaction_of_sid` 的**当前**服务端值；`st.get("qid")` 在三处复用**同一个快照**。
 */
export async function answerMultiClick(p, c, value, action, options = {}) {
  const d = dep(options);
  const st = d.board.interactionOfSid(pyOr(c.session_id, ''));
  if (!pyTruthy(st) || !pyTruthy(dget(st, 'pending'))) {
    return [`卡片 #${c.id} 当前没有等待中的提问`, toast('error', '提问已结束')];
  }
  if (dget(st, 'kind') !== 'question') {
    return [`卡片 #${c.id} 当前等待的不是提问，请回复「同意 ${c.id}」或「拒绝 ${c.id}」`,
      toast('error', '该等待是审批')];
  }
  if (!pyTruthy(dget(st, 'answerable'))) {
    return [NO_REMOTE_ANSWER_HINT, toast('error', '请到 dsh 会话窗口作答')];
  }
  const qs = pyOr(dget(st, 'questions'), []).filter((q) => pyTruthy(q));   // 过滤假值题（2227）
  const n = qs.length;
  if (n < 1) return [`卡片 #${c.id} 当前没有等待中的提问`, toast('error', '提问已结束')];
  if (n === 1 && !pyTruthy(dget(pyOr(qs[0], {}), 'multi_select'))) {
    return [`该提问是单选题，请用卡片上的选项按钮，或回复「作答 ${c.id} <选项序号>」`,
      toast('error', '单题单选请用按钮')];
  }
  let no = 0;
  try {
    no = pyInt(dget(value, 'n'));
  } catch (e) {
    // oracle `except (TypeError, ValueError): no = 0`（2235-2238）
    if (e instanceof TypeError || (e instanceof Error && e.name === 'ValueError')) no = 0;
    else throw e;
  }
  if (no < 1 || no > n) {
    return ['题号无效（卡片可能已过期），请重新作答', toast('error', '题号无效')];
  }
  const q = pyOr(qs[no - 1], {});
  const opts = pyOr(dget(q, 'options'), []);
  if (!pyTruthy(opts)) {
    return [`第 ${no} 题没有选项，请回复「作答 ${c.id} ${no}:<文字>」`,
      toast('error', '该题请写文字')];
  }
  const idxs = multiClickIndex(action, pyTruthy(dget(q, 'multi_select')), `mq${c.id}_${no}`);
  if (idxs === null) {
    return [`没收到你选的选项，请改用「作答 ${c.id} ${no}:<选项序号>」`,
      toast('error', '未收到选项，请看单聊')];
  }
  if (idxs.some((i) => i < 1 || i > opts.length)) {
    return [`第 ${no} 题选项序号无效（共 ${opts.length} 个选项）`, toast('error', '选项无效')];
  }
  if (idxs.length > 1 && !pyTruthy(dget(q, 'multi_select'))) {
    return [`第 ${no} 题为单选，请只选一项`, toast('error', '单选只能选一项')];
  }
  // 与文本指令同一形态：去重 + 升序 + 半角逗号无空格（2257）
  const val = [...new Set(idxs)].sort((a, b) => a - b).map((i) => pyStr(i)).join(',');
  const [done, total, ready] = mqPut(c.id, dget(st, 'qid'), n, no, val, options);
  if (!ready) {
    return ['', toast('success', `已记下第 ${no} 题（${done}/${total}）`)];  // 全角括号 + 半角斜杠
  }
  const parts = mqTake(c.id, dget(st, 'qid'), n, options);
  if (parts.length < n) {
    // 极端竞态（取走前被 TTL 清掉/并发取走）：不提交半份，让用户重选（2262-2265）
    return ['作答未提交（暂存已过期），请重新逐题选择', toast('error', '暂存过期，请重选')];
  }
  const [answers, err] = multiAnswers(qs, parts);
  if (pyTruthy(err)) return [`作答未提交：${err}`, toast('error', '作答未提交')];
  const err2 = await d.board.answerInteraction(p, c, dget(st, 'qid'), answers, options);
  if (pyTruthy(err2)) return [`作答失败：${err2}`, toast('error', '作答失败')];
  return [`已收下：卡片 #${c.id} ${answers.length} 道作答，排队送达中`,
    toast('success', `${answers.length} 题已答完，已送达`)];
}

/** `_decide_approval`（2451-2468）：审批决定（文本与卡片按钮共用）；`decision` 不校验 */
export async function decideApproval(p, c, decision, scope, options = {}) {
  const d = dep(options);
  const st = d.board.interactionOfSid(pyOr(c.session_id, ''));
  if (!pyTruthy(st) || !pyTruthy(dget(st, 'pending')) || dget(st, 'kind') !== 'approval') {
    return `卡片 #${c.id} 当前没有等待中的审批（提问类请回复「作答 ${c.id} <选项序号|文字>」）`;
  }
  const aid = pyStr(pyOr(dget(st, 'approval_id'), ''));
  if (!pyTruthy(aid)) return '审批不存在或已过期，请到站点会话窗口处理';
  const err = await d.board.answerApproval(p, c, aid, decision, scope, options);
  if (pyTruthy(err)) return `审批失败：${err}`;
  const verb = decision === 'approved' ? '已批准' : '已拒绝';
  const tail = scope === 'session' ? '（本会话内同类调用自动放行）' : '';
  return `✅ 卡片 #${c.id} 审批${verb}${tail}，排队送达中`;
}

// ==========================================================================
// 看板动作（`feishu.py:2471-2520`）
// ==========================================================================

/**
 * `_execute_board_action`（2471-2520）：状态/找卡/通过/驳回/作答/同意/拒绝。
 * `board.move_card` 的 err 是 **dict**（`{"error"|"blocked"|"merge_pending"}`）；
 * `board.start_card` **只捕 RuntimeError**（2510）——Node 侧对应 `Error`（board.js 只抛 Error）。
 */
export async function executeBoardAction(binding, intent, senderOpenId, options = {}) {
  const d = dep(options);
  const action = requireKey(intent, 'action');      // 2477 在 try 之外 ⇒ 缺键穿透
  const g = requireKey(intent, 'groups');
  const userId = requireKey(binding, 'user_id');
  if (action === 'status') {
    const [p, err] = await resolveProject(binding, g[0], options);
    if (p === null || p === undefined) return err;
    return await boardSummary(p, options);
  }
  const key = pyStripStrict(g.length > 0 ? g[0] : '');
  const [found, err] = await findUserCard(userId, key, options);
  if (found === null || found === undefined) return err;
  const [p, c] = found;
  if (action === 'card') return cardDetail(p, c);
  if (action === 'approve') {
    if (c.column_key !== 'review') {
      return `卡片 #${c.id} 不在「待审核」列（当前 ${c.column_key}），无法通过`;
    }
    const [, moveErr] = await d.board.moveCard(p, c.id, 'done', '', null, false, options);
    if (pyTruthy(moveErr)) {
      if (Object.hasOwn(moveErr, 'merge_pending')) {
        const mp = pyOr(dget(moveErr, 'merge_pending'), {});
        return `卡片 #${pyStr(c.id)} 还有 ${pyStr(dget(mp, 'ahead', 0))} 个提交没回流主分支`
          + `（${pyStr(dget(mp, 'branch', ''))} → ${pyStr(dget(mp, 'target', ''))}）；`
          + '请在网页看板上点「通过」，选择「交给 agent 合并」或「仅通过（不合并）」';
      }
      return '审核失败：' + pyStr(pyOr(pyOr(dget(moveErr, 'error'), dget(moveErr, 'blocked')),
        '门禁拦截'));
    }
    return `✅ 卡片 #${c.id} ${pySlice(pyOr(c.title, ''), 30)} 已审核通过`;
  }
  if (action === 'reject') {
    if (c.column_key !== 'review') {
      return `卡片 #${c.id} 不在「待审核」列（当前 ${c.column_key}），无法驳回`;
    }
    try {
      await d.board.startCard(p, c, pyOr(g[1], ''), options);
    } catch (e) {
      if (e instanceof Error) return `打回失败：${e.message}`;   // Python `str(RuntimeError)`
      throw e;
    }
    return `↩️ 卡片 #${c.id} 已打回继续开发，打回意见将注入 agent`;
  }
  if (action === 'answer') return await answerByToken(p, c, pyStripStrict(pyOr(g[1], '')), options);
  if (action === 'agree' || action === 'deny') {
    const decision = action === 'agree' ? 'approved' : 'rejected';
    const scope = (action === 'agree' && (g.length > 1 ? g[1] : '') === '会话') ? 'session' : '';
    return await decideApproval(p, c, decision, scope, options);
  }
  return HELP_TEXT;
}

// ==========================================================================
// 意图执行（`feishu.py:2038-2059`）
// ==========================================================================

/**
 * `execute_intent`（2038-2059）：按绑定身份执行意图；返回回复文案（**空串 = 不回复**）。
 * `action, g = intent["action"], intent["groups"]` 在 `try` **之外**（2042）⇒ 缺键穿透；
 * 异常映射**顺序敏感**：先 `FeishuRestError` 后宽泛 Exception。
 */
export async function executeIntent(binding, intent, senderOpenId, cfg = null, options = {}) {
  const d = dep(options);
  const action = requireKey(intent, 'action');
  const g = requireKey(intent, 'groups');
  try {
    if (action === 'help') return HELP_TEXT;
    if (action === 'bind') return '当前账号已绑定，无需重复绑定';     // 第二道（2047）
    if (action === 'unbind') {
      d.db.delFeishuBindingByOpen(senderOpenId, options);
      return '已解绑。重新绑定请到站点生成新的绑定码';
    }
    if (action === 'default_project') {
      return await setDefaultProject(binding, pyOr(g[0], ''), 0, options);
    }
    if (['current', 'projects', 'sessions', 'new', 'use', 'leave'].includes(action)) {
      return await d.conv.convIntent(binding, action, g, senderOpenId, cfg, options);
    }
    return await executeBoardAction(binding, intent, senderOpenId, options);
  } catch (e) {
    if (e instanceof FeishuRestError) return '飞书接口调用失败，请稍后重试';
    return '指令执行失败，请稍后重试';
  }
}

// ==========================================================================
// 消息入站主流程（`feishu.py:1769-1860`）
// ==========================================================================

/** SDK 事件载荷 → 普通对象（Buffer/字符串都收；R1 的 handler 给的是**字节**） */
function parseEventPayload(payload) {
  if (Buffer.isBuffer(payload)) return JSON.parse(payload.toString('utf8'));
  if (typeof payload === 'string') return JSON.parse(payload);
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    throw new TypeError('事件载荷既不是字节也不是对象');
  }
  return payload;
}

/**
 * `_on_message_event`（1769-1782）：SDK `P2ImMessageReceiveV1` → 统一 6 键 dict → 主流程。
 * 键序与 1776-1780 一致；`mentions[].open_id` 缺省是 **`None`**（1774，与 `_card_sdk_to_dict`
 * 的 `""` 相反）；异常全吞并打 1782 那行。
 * 形态差异：oracle 入参是 SDK 模型对象（属性链），本移植收**已解析的普通对象/字节**
 * （R1 给字节）——属性链断链仍照 oracle 抛 AttributeError。
 */
export async function onMessageEvent(payload, cfg, options = {}) {
  const d = dep(options);
  try {
    const data = parseEventPayload(payload);
    const event = dget(data, 'event');
    if (!pyTruthy(event)) throw attributeError('NoneType', 'message');
    const msg = dget(event, 'message');
    if (!pyTruthy(msg)) throw attributeError('NoneType', 'mentions');
    const mentions = pyOr(dget(msg, 'mentions'), []).map((m) => {
      const id = pyTruthy(m) ? dget(m, 'id') : null;
      return { key: dget(m, 'key'), open_id: pyTruthy(id) ? dget(id, 'open_id') : null };
    });
    const sender = dget(pyOr(dget(event, 'sender'), {}), 'sender_id');
    if (!pyTruthy(sender)) throw attributeError('NoneType', 'open_id');
    await handleMessageEvent({
      message_id: dget(msg, 'message_id'),
      message_type: dget(msg, 'message_type'),
      content: dget(msg, 'content'),
      chat_type: dget(msg, 'chat_type'),
      mentions,
      sender_open_id: dget(sender, 'open_id'),
    }, cfg, options);
  } catch (e) {
    d.log(`feishu inbound: 事件解析异常: ${errorRepr(e)}`);
  }
}

/**
 * `handle_message_event`（1796-1860）：**入站主干**。
 * 顺序即语义：去重先于一切（1805）→ 群聊 @ 判定（1810-1814，静默）→ 非文本（1815-1818）→
 * 取文本并剥 @ 占位符（1819-1827）→ **绑定指令先于绑定校验**（1837 在 1844 之前）→
 * 未识别文本分岔（1848-1855，群聊恒 HELP_TEXT）→ 执行（1856-1858，空串不回复）。
 * `cfg` 默认 `null`（1796 的 `cfg=None`）——`rest_reply` 会照 oracle 抛「应用未配置」。
 */
export async function handleMessageEvent(evt, cfg = null, options = {}) {
  const d = dep(options);
  try {
    const mid = dget(evt, 'message_id');
    if (!pyTruthy(mid) || seenMessage(mid)) return;
    d.log(`feishu inbound: 收到消息 chat_type=${pyStr(dget(evt, 'chat_type'))} `
      + `type=${pyStr(dget(evt, 'message_type'))} `
      + `sender=${pySlice(pyStr(pyOr(dget(evt, 'sender_open_id'), '')), 12)}`);
    if (dget(evt, 'chat_type') === 'group') {
      const bo = await d.rest.botOpenId(cfg);
      const mentions = pyOr(dget(evt, 'mentions'), []);
      if (!pyTruthy(bo) || !mentions.some((m) => dget(pyOr(m, {}), 'open_id') === bo)) return;
    }
    if (dget(evt, 'message_type') !== 'text') {
      if (dget(evt, 'chat_type') !== 'group') {
        await d.rest.restReply(mid, '暂不支持该消息类型，请发送文字指令', cfg);
      }
      return;
    }
    let content;
    try {
      content = pyJsonLoads(pyOr(dget(evt, 'content'), '{}'));
    } catch (e) {
      if (e instanceof SyntaxError) content = {};      // oracle: `except ValueError`（1821-1822）
      else throw e;
    }
    let text = pyStripStrict(pyOr(dget(content, 'text'), ''));
    for (const m of pyOr(dget(evt, 'mentions'), [])) {
      const key = dget(pyOr(m, {}), 'key');
      if (pyTruthy(key)) {
        if (typeof key !== 'string') throw new TypeError('replace() argument 1 must be str');
        text = pyStripStrict(text.replaceAll(key, ''));      // 全局替换 + 每次 strip（1824-1827）
      }
    }
    if (!pyTruthy(text)) return;
    const sender = pyOr(dget(evt, 'sender_open_id'), '');
    const binding = d.db.getFeishuBindingByOpen(sender, options);
    const intent = parseIntent(text);
    d.log(`feishu inbound: 文本=${pyReprStr(pySlice(text, 30))} `
      + `intent=${pyOr(dget(pyOr(intent, {}), 'action'), '-')}`);
    // 绑定指令先于绑定校验（1835-1843）：否则未绑定者永远绑不上（死锁）
    if (pyTruthy(intent) && dget(intent, 'action') === 'bind') {
      if (binding !== null && binding !== undefined) {
        await d.rest.restReply(mid, '当前账号已绑定，无需重复绑定（解绑后可重新绑定）', cfg);
        return;
      }
      const err = d.feishu.bindUser(dget(intent, 'groups')[0], sender, options);
      await d.rest.restReply(mid, (err === null || err === undefined)
        ? '绑定成功，发「帮助」查看可用指令' : err, cfg);
      return;
    }
    if (binding === null || binding === undefined) {
      await d.rest.restReply(mid, UNBOUND_DM_MSG, cfg);
      return;
    }
    if (intent === null) {
      let reply;
      if (dget(evt, 'chat_type') !== 'group' && pyTruthy(await d.conv.enabled(options))) {
        reply = await d.conv.routeText(binding, text, cfg, options);
      } else {
        reply = HELP_TEXT;         // 群聊保持原行为：不落会话（1853）
      }
      await d.rest.restReply(mid, reply, cfg);
      return;
    }
    const reply = await executeIntent(binding, intent, sender, cfg, options);
    if (pyTruthy(reply)) await d.rest.restReply(mid, reply, cfg);   // 空串不回复（1857）
  } catch (e) {
    d.log(`feishu inbound: 处理异常: ${errorRepr(e)}`);
  }
}

// ==========================================================================
// 卡片回调主流程（`feishu.py:1884-1978`）
// ==========================================================================

/**
 * `_card_sdk_to_dict`（1952-1978）：SDK `P2CardActionTrigger` 模型 → `_on_card_action` 的 dict。
 * 白名单只拷 7 键（`tag`/`name`/`form_value`/`input_value`/`option`/`options`/`checked`），
 * **仅当值 `is not None`**（`checked=False` 会被拷贝）；**`timezone` 不拷**；
 * `header`/`operator` 缺省是 **`""`**（1971/1974）。
 * 入参在本移植里是**已解析的普通对象**（R1 给字节 ⇒ `wsRun` 先 parse 再喂这里）。
 */
export function cardSdkToDict(data) {
  const header = dget(data, 'header');
  const event = dget(data, 'event');
  const operator = pyTruthy(event) ? dget(event, 'operator') : null;
  const action = pyTruthy(event) ? dget(event, 'action') : null;
  const actionD = { value: pyTruthy(action) ? pyOr(dget(action, 'value'), {}) : {} };
  if (pyTruthy(action)) {
    for (const k of ['tag', 'name', 'form_value', 'input_value', 'option', 'options', 'checked']) {
      const v = dget(action, k);
      if (v !== null && v !== undefined) actionD[k] = v;
    }
  }
  return {
    header: { event_id: pyTruthy(header) ? pyOr(dget(header, 'event_id'), '') : '' },
    event: {
      operator: { open_id: pyTruthy(operator) ? pyOr(dget(operator, 'open_id'), '') : '' },
      action: actionD,
    },
  };
}

/**
 * `_on_card_action`（1884-1949）：卡片点击回调主流程。
 * 顺序即语义：`event_id` 去重（1899-1901，**空 event_id 不去重**）→ `t=="sc"`（1909）→
 * `t in ("dp","ss")`（1913）→ 卡号白名单 `t in ("a","mq","p","s","d") and c`（1920）→
 * 绑定校验 → 找卡 → 按 `t` 分派。异常全吞（1947-1949）⇒ 返回 `null`（不更新卡片）。
 */
export async function onCardAction(data, cfg, options = {}) {
  const d = dep(options);
  try {
    const header = pyOr(dget(data, 'header'), {});
    const eventId = pyStr(pyOr(pyOr(dget(header, 'event_id'), dget(data, 'event_id')), ''));
    if (pyTruthy(eventId) && seenEvent(eventId)) return null;
    const event = pyOr(dget(data, 'event'), {});
    const sender = pyStr(pyOr(dget(pyOr(dget(event, 'operator'), {}), 'open_id'), ''));
    const action = pyOr(dget(event, 'action'), {});
    const value = pyDictCopy(pyOr(dget(action, 'value'), {}));
    const t = pyStr(pyOr(dget(value, 't'), ''));
    const key = pyStr(pyOr(dget(value, 'c'), ''));
    if (t === 'sc') return await onSlashPermAction(sender, value, cfg, options);
    if (t === 'dp' || t === 'ss') {
      const binding = d.db.getFeishuBindingByOpen(sender, options);
      if (binding === null || binding === undefined) {
        await dmText(sender, UNBOUND_DM_CARD, cfg, options);
        return toast('error', '尚未绑定站点账号');
      }
      return await d.conv.onCardAction(sender, binding, value, action, cfg, options);
    }
    if (!['a', 'mq', 'p', 's', 'd'].includes(t) || !pyTruthy(key)) return null;
    const binding = d.db.getFeishuBindingByOpen(sender, options);
    if (binding === null || binding === undefined) {
      await dmText(sender, UNBOUND_DM_CARD, cfg, options);
      return toast('error', '尚未绑定站点账号');
    }
    const [found, err] = await findUserCard(requireKey(binding, 'user_id'), key, options);
    if (found === null || found === undefined) {
      await dmText(sender, err, cfg, options);
      return toast('error', '没找到对应卡片');
    }
    const [p, c] = found;
    let reply;
    if (t === 'mq') {
      const [dm, replyToast] = await answerMultiClick(p, c, value, action, options);
      if (pyTruthy(dm)) await dmText(sender, dm, cfg, options);
      return replyToast;                 // 每次点击都回 toast（含进度）（1932-1937）
    }
    if (t === 'a') {
      reply = await answerByToken(p, c, pyStr(pyOr(dget(value, 'i'), '')), options);
    } else {
      const decision = (t === 'p' || t === 's') ? 'approved' : 'rejected';
      reply = await decideApproval(p, c, decision, t === 's' ? 'session' : '', options);
    }
    if (pyTruthy(reply)) await dmText(sender, reply, cfg, options);
    return toastFor(reply);
  } catch (e) {
    d.log(`feishu inbound: 卡片回调处理异常: ${errorRepr(e)}`);
    return null;
  }
}

// ==========================================================================
// 斜杠权限卡回调（`feishu.py:1495-1503` / `1553-1574`）—— 见文件头差异 9
// ==========================================================================

/** `_slash_summary`（1495-1503）：同步结果一句话摘要（DM 回执与设置页提示共用） */
export function slashSummary(out) {
  let s = `新增 ${pyLen(pyOr(dget(out, 'created'), []))}、`
    + `更新 ${pyLen(pyOr(dget(out, 'updated'), []))}、`
    + `已是最新 ${pyLen(pyOr(dget(out, 'kept'), []))}`;
  if (pyTruthy(dget(out, 'failed'))) s += `、失败 ${pyLen(dget(out, 'failed'))}`;
  return s;
}

/**
 * `_on_slash_perm_action`（1553-1574）：权限引导卡按钮回调 —— 复核身份（必须是该卡片指向的、
 * 已绑定的用户）→ 重跑 `sync_slash_commands` → DM 文本回执 + toast。
 */
export async function onSlashPermAction(sender, value, cfg, options = {}) {
  const d = dep(options);
  const binding = d.db.getFeishuBindingByOpen(sender, options);
  if (binding === null || binding === undefined) {
    await dmText(sender, UNBOUND_DM_MSG, cfg, options);
    return toast('error', '尚未绑定站点账号');
  }
  const userId = requireKey(binding, 'user_id');
  const uid = pyInt(pyOr(dget(value, 'u'), 0));
  if (pyTruthy(uid) && uid !== pyInt(userId)) {
    return toast('error', '该卡片不属于当前账号');       // 防串号（1562-1564）
  }
  const out = await d.slash.syncSlashCommands(userId, options);
  if (pyTruthy(dget(out, 'ok'))) {
    await dmText(sender, '✅ 快捷指令注册完成：' + slashSummary(out)
      + '\n约 5 分钟后在机器人私聊输入「/」即可看到（重启飞书客户端可加速）。', cfg, options);
    return toast('success', '注册完成');
  }
  let text = '❌ 仍未成功：' + pyOr(dget(out, 'error'), '未知错误');
  if (pyTruthy(dget(out, 'need_scope'))) {
    text += '\n看起来权限还没生效：确认已在权限管理里添加读+写并**创建版本发布**，'
      + '稍等约 1 分钟再点一次卡片上的按钮。';
  }
  await dmText(sender, text, cfg, options);
  return toast('error', '仍未成功，看私聊回复');
}

// ==========================================================================
// 入站长连接（`feishu.py:1628-1656` / `1659-1766`）
// ==========================================================================

/** 入站「线程」句柄：契约 `{isAlive(): boolean}`（`feishu_cfg.js:216` 的接缝） */
function makeInboundRunner(userId, cfg, options) {
  let alive = false;
  return {
    userId,
    cfg,
    isAlive: () => alive,
    /** 等价 `threading.Thread.start()`：登记在 `start()` **之前**（1643-1644） */
    start() {
      alive = true;
      void wsRun(userId, cfg, options)
        .catch((e) => {          // wsRun 自身已吞异常；这只是「线程入口绝不上抛」的兜底
          defaultLog(`feishu inbound: 用户 ${userId} 长连接异常退出: `
            + `${errorRepr(e)}（重启站点重试）`);
        })
        .finally(() => { alive = false; });
    },
  };
}

/**
 * `start_inbound_for`（1628-1645）：幂等拉起某用户的入站长连接；返回是否**新**启动。
 * 顺序：① 注册表判活短路（1634）→ ② `app_config` → ③ 缺失打 stderr 一行并回 false →
 * ④ 建「线程」→ ⑤ 登记 → ⑥ `start()`。**同步返回**（对应 `save_user_config` 的
 * `inbound_started` 是同步布尔）。
 * 已知分叉：oracle 只读一次 `app_config`；这里 `inboundStatus` 为算 `thread` 也读一次
 * （`feishu_cfg.js` 的既有接缝），故共两次**只读**查询（不可观测，登记于此）。
 */
export function startInboundFor(userId, options = {}) {
  const d = dep(options);
  if (inboundStatus(userId, options).thread) return false;       // ① 只信 is_alive()
  const cfg = appConfig(userId, options);                        // ②
  if (cfg === null || cfg === undefined) {                       // ③
    d.log(`feishu inbound: 用户 ${userId} 应用凭据缺失，长连接未启动`);
    return false;
  }
  const runner = makeInboundRunner(userId, cfg, options);        // ④
  setInboundThread(userId, runner);                              // ⑤（在 start 之前）
  runner.start();                                                // ⑥
  return true;
}

/**
 * `start_inbound_all`（1648-1656）：服务启动遍历全部用户配置，为凭据齐全者逐个拉起。
 * 顺序 = `db.list_feishu_user_cfgs()` 的行序（无 ORDER BY ⇒ 表扫描序）；返回新启动数。
 * 无 try/except ⇒ 任一用户抛异常即中断其余用户（半启动），本移植照抄。
 */
export function startInboundAll(options = {}) {
  const d = dep(options);
  let n = 0;
  for (const [userId, cfg] of d.db.listFeishuUserCfgs(options)) {
    if (pyTruthy(dget(cfg, 'app_id')) && pyTruthy(dget(cfg, 'app_secret'))) {
      if (startInboundFor(userId, options)) n += 1;
    }
  }
  return n;
}

/**
 * `_make_ws_client`（1659-1719）：构造支持卡片回调分派的 ws 客户端。
 * Node 侧这个职责由 R1 的 `FeishuWsClient` 承担（帧分发/合包/ACK 都在 R1）；本函数只做
 * **构造参数的对齐**：两个位置参数是 `cfg` 的**下标取值**（缺键 ⇒ KeyError，1717）、
 * 不传 `domain`（⇒ R1 默认官方域名）、不传 `autoReconnect`（⇒ R1 默认 true）；
 * `log_level` 缺省是 `ERROR`（1715-1716）⇒ 默认**静默**（契约 §4.1-3），
 * `TS_FEISHU_WS_DEBUG` 非空（**`"0"` 也算**，1752 的 `bool()`）时开 DEBUG 日志。
 */
export function makeWsClient(cfg, eventHandler, cardHandler, logLevel = null, options = {}) {
  dep(options);
  // 注入点：`clientClass`（类/factory）与 `wsClient`（同一形态的别名，供量具/单测直接替换）
  const Ctor = options.clientClass || options.wsClient || FeishuWsClient;
  const appId = requireKey(cfg, 'app_id');
  const appSecret = requireKey(cfg, 'app_secret');
  const verbose = (logLevel !== null && logLevel !== undefined)
    && (typeof logLevel === 'number' ? logLevel <= 10 : String(logLevel).toLowerCase() === 'debug');
  const log = options.wsLog || (verbose
    ? ((level, msg) => defaultLog(`feishu-ws ${level}: ${msg}`))
    : (() => {}));
  return new Ctor({
    appId: pyStr(appId), appSecret: pyStr(appSecret), eventHandler, cardHandler, log,
  });
}

/**
 * `_ws_run`（1722-1766）：ws 客户端线程主体，`start()` 阻塞到 `close()`。
 * 三处对齐：① 连接行（1760-1761，结尾是 **U+2026**）；② 两个 handler 入口都先
 * `_touch_event(userId)` 打点（1734/1740，写 `feishu_provision._LAST_EVENT_TS`）；
 * ③ 退出行（1765-1766，`{e!r}` 走 `errorRepr` 近似）。
 * **协议兜底路径**（1695-1713）：`cardHandler` 收字节 → `JSON.parse`（坏 JSON 静默 return）→
 * `_on_card_action(data, cfg)`，**返回值丢弃**（没有写回任何响应）；异常只留一行 stderr。
 * 事件帧路由：SDK 的 `register_p2_*` 按 `header.event_type` 分派（R1 只给一个 eventHandler）——
 * `im.message.receive_v1` → `onMessageEvent`（返回值被丢弃）；`card.action.trigger` →
 * `cardSdkToDict` + `onCardAction`（**返回值进 ACK data**，对应 callback processor 路的序列化）；
 * `im.message.message_read_v1` → 空实现（1745-1746，返回值 None）；**其余类型抛** —— 对应
 * `_processorMap` 查不到时的 `EventException("processor not found")`（`dispatcher_handler.py:173-181`），
 * 客户端 catch 后回 ACK `{"code": 500}`（不是 200，否则等于静默吞事件）。
 * 差异：oracle 的 `lark-oapi` 未安装分支（1729-1731）在 Node 侧不存在（R1 已落地）。
 */
export async function wsRun(userId, cfg, options = {}) {
  const d = dep(options);
  const touch = () => { _LAST_EVENT_TS.set(userId, d.now()); };
  const onEventPayload = async (payload) => {
    let data;
    try {
      data = parseEventPayload(payload);
    } catch (e) {
      d.log(`feishu inbound: 事件解析异常: ${errorRepr(e)}`);
      return null;
    }
    const header = pyOr(dget(data, 'header'), {});
    const type = pyOr(dget(header, 'event_type'), '');
    if (type === 'card.action.trigger') {
      touch();
      return await onCardAction(cardSdkToDict(data), cfg, options);
    }
    if (type === 'im.message.receive_v1') {
      touch();
      await onMessageEvent(data, cfg, options);
      return null;
    }
    if (type === 'im.message.message_read_v1') {
      // 已读回执：oracle 注册的是空 lambda（`feishu.py:1745-1746`）⇒ 返回值 None ⇒ ACK 只有
      // `{"code": 200}`；且 `_touch_event` 只打在消息/卡片两个 processor 里，回执**不打点**
      // （别"顺手"补上——doctor 的「订阅是否真生效」判据靠这个点数）。
      return null;
    }
    // 未注册类型：oracle 在 `_processorMap` 里查不到 ⇒ 抛 `EventException("processor not found,
    // type: …")`（`dispatcher_handler.py:173-181`）⇒ R1 客户端 catch 后回 ACK `{"code": 500}`
    // 且**不加 biz_rt**。这里若 `return null` 就变成 200 —— 飞书据此判定"已送达、不重推"，
    // 等于**静默吞掉一个事件**。（2026-10-15 与真 SDK 逐字节对拍时量出来的，见
    // `tools/parity/probe/ws_oracle_diff.py` 的 `om_fake_post_ping_*` 那条 ACK。）
    throw new Error(`processor not found, type: ${type}`);
  };
  const onCardPayload = (payload) => {
    let data;
    try {
      data = parseEventPayload(payload);            // 坏 JSON/坏字节：静默 return（1707-1708）
    } catch {
      return;
    }
    // 照 `_run_card_handler`：另起一路、返回值丢弃；异常只打 1712-1713 那行
    void onCardAction(data, cfg, options).catch((e) => {
      d.log(`feishu inbound: 卡片回调处理异常: ${errorRepr(e)}`);
    });
  };
  const wsDebug = pyTruthy(dget(d.env, 'TS_FEISHU_WS_DEBUG'));   // 非空即真（连 "0" 也算）
  const client = makeWsClient(cfg, onEventPayload, onCardPayload,
    wsDebug ? 'debug' : 'error', options);
  d.log(`feishu inbound: 用户 ${userId} 连接长连接网关（app_id=${requireKey(cfg, 'app_id')}）…`);
  try {
    await client.start();
  } catch (e) {
    d.log(`feishu inbound: 用户 ${userId} 长连接异常退出: ${errorRepr(e)}（重启站点重试）`);
  }
}

// --------------------------------------------------------------------------
// snake_case 别名（照 `board.js` 的 Python 名别名先例：零成本、便于对拍量具按 oracle 名发现）
// --------------------------------------------------------------------------
export const _HELP_TEXT = HELP_TEXT;
export const _INTENT_RULES = INTENT_RULES;
export const _seen_event = seenEvent;
export const _seen_message = seenMessage;
export const _toast = toast;
export const _toast_for = toastFor;
export const _dm_text = dmText;
export const _mq_prune_locked = mqPruneLocked;
export const _mq_put = mqPut;
export const _mq_take = mqTake;
export const _mq_peek = mqPeek;
export const _mq_drop = mqDrop;
export const _multi_click_index = multiClickIndex;
export const _multi_answer_parts = multiAnswerParts;
export const _multi_answers = multiAnswers;
export const _answer_by_token = answerByToken;
export const _answer_multi_click = answerMultiClick;
export const _decide_approval = decideApproval;
export const _execute_board_action = executeBoardAction;
export const _resolve_project = resolveProject;
export const _find_cards = findCards;
export const _find_user_card = findUserCard;
export const _card_detail = cardDetail;
export const _board_summary = boardSummary;
export const _set_default_project = setDefaultProject;
export const _parse_intent = parseIntent;
export const _handle_message_event = handleMessageEvent;
export const _execute_intent = executeIntent;
export const _on_message_event = onMessageEvent;
export const _on_card_action = onCardAction;
export const _card_sdk_to_dict = cardSdkToDict;
export const _on_slash_perm_action = onSlashPermAction;
export const _slash_summary = slashSummary;
export const _make_ws_client = makeWsClient;
export const _ws_run = wsRun;
export const _start_inbound_for = startInboundFor;
export const _start_inbound_all = startInboundAll;
