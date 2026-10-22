#!/usr/bin/env node
/**
 * 飞书通用对话（会话对话层）—— `feishu_conv.py:1-920` 的零依赖 Node 移植
 * （48 个模块级函数 + `_Card` 类 + 31 个模块级常量）。
 *
 * 职责：把「单聊里的自由文本」变成「某个 dsh 会话的一条消息」，并把会话跑完的答复推回
 * 飞书 DM；另外提供 `项目`/`会话` 两张交互卡片与 `t=dp`/`t=ss` 两个卡片回调。
 *
 * ══ 依赖方向（硬约束，照 `feishu_conv.py:5-6`）═══════════════════════════════════
 * 模块级可 import `db`/`sessparse`/`dshdriver`/`dshevents`/`agents`/`waitq`/`chat`
 * （Node 侧另加 `feishu_rest`/`feishu_cfg`/`pyjson`/`lib`，与 R1/R2 的既有分层一致）；
 * Python 里 `chat`/`feishu` 走函数内懒 import 是为了躲 `feishu → runner → chat` 的环——
 * Node 侧实测 `chat.js` 的静态依赖图里**没有任何模块**回头 import `feishu.js`（只有
 * `feishu_inbound.js` 会），故 `chat` 可以静态 import；唯一保留懒 import 的是
 * `feishu_inbound.js`（只为 `conv_intent` 的未知动作兜底取 `HELP_TEXT`，那条分支在生产
 * 路径上不可达：`execute_intent` 的 action 白名单是硬编码的六条）。
 *
 * ══ 与 oracle 的三处结构性差异（都是**必须**的，不是选择）════════════════════════
 * A. **整链 async**：`chat.submit` / `restSendCard` / `restSendText` / `dshdriver.*` 在
 *    Node 侧全是 async（Python 是同步阻塞）⇒ `routeText`/`convIntent`/`onCardAction`/
 *    `newSession`/`createInProject`/`sendCard`/`dm` 整链 async；`await` 的位置照抄 oracle
 *    的**串行**次序（baseline 先于 submit、建会话先于重申绑定、DM 先于 toast）。
 *    纯读/纯写 DB 的（`currentText`/`projectsCard`/`sessionsCard`/`bindSession`/
 *    `setDefaultProject`/`projectById`/`useByToken`/`start`）保持**同步**，形状与 oracle 同。
 * B. **`_Card` 的别名不可枚举**：Python 是 `dict` 子类 + `__getitem__` 特判，Node 没有
 *    dict 子类 ⇒ 真实三键对象（`schema`/`header`/`body`）+ `Object.defineProperty` 的
 *    **不可枚举**读口 `elements`。不可枚举是关键：`Object.keys`/`pyJsonDumps` 都不带它，
 *    发出去的卡片 JSON 里没有顶层 `elements`（否则体积翻倍 + 未知字段被飞书拒收）。
 * C. **`options` 末位注入**（R2/M7 的既有约定）：`options.dbmod` 是 **db 模块**替换口
 *    （`options.db` 是 sqlite 句柄，会被透传给 db.js，**不是**模块槽）；另有
 *    `rest`/`chat`/`feishu`（`appConfig`）/`sessparse`/`dshdriver`/`dshevents`/`agents`/
 *    `waitq`/`cfg`/`now`/`log`/`env`。默认值一律真模块 ⇒ 产品路径零改动。
 *    `now()`（秒）是本移植新增的**行为中性**注入点（oracle 直接 `time.time()`），
 *    供用例钉 `_LAST_LIST` 的 TTL 与缺省标题；不传时等价于 `Date.now()/1000`。
 *
 * ══ 逐字复现的三条优先级（照契约清单 §0.3）═══════════════════════════════════════
 * ① 发回飞书的字节：文本走 `restSendText`，卡片走 `restSendCard` 的
 *    `content: pyJsonDumps(card)` ⇒ **卡片构建的键序就是字节序**；
 * ② 日志分流：`_trace` 走 **stderr**（`options.log`，默认 `console.error`），
 *    `notifyMsgDone` 的 yielded 分支走 **stdout**（`console.log`）——两条流不一样；
 * ③ 状态迁移与顺序：`feishu_bindings` 四列指针、`wait_items.meta` 的 `feishu` 载荷、
 *    `_LAST_LIST` 内存态，以及**哪些分支先 return**（长度闸先于一切；卡片未被受理才补文本）。
 *
 * 未验清单（真飞书行为、真线程并发、`{e!r}` 的完整 repr 面、多用户 loop 等）见
 * M7.5-R3 实施报告，不藏在注释里。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { agentFamily } from './agents.js';
import * as chatMod from './chat.js';
import * as dbMod from './db.js';
import * as dshdriverMod from './dshdriver.js';
import * as dsheventsMod from './dshevents.js';
import * as cfgMod from './feishu_cfg.js';
import * as restMod from './feishu_rest.js';
import { PY_WS } from './lib.js';
import { pyJsonDumps } from './pyjson.js';
import * as sessparseMod from './sessparse.js';
import * as waitqMod from './waitq.js';

// ==========================================================================
// 模块级常量（`feishu_conv.py:20-50`，逐字）
// ==========================================================================

/** `CONV_ENV`(`:20`)：`"0"` 关闭（回到「未识别文本回帮助」） */
export const CONV_ENV = 'TS_FEISHU_CONV';
/** `CARD_MAX_BYTES`(`:21`)：卡片 JSON 体积预算 */
export const CARD_MAX_BYTES = 8000;
/** `PROJECTS_MAX`(`:22`)：总览卡最多列的项目数 */
export const PROJECTS_MAX = 20;
/** `PROJECTS_FALLBACK`(`:23`)：超预算时第二轮降级的项目数 */
export const PROJECTS_FALLBACK = 10;
/** `PROJECT_NAME_MAX`(`:24`)：卡片里项目名的展示上限 */
export const PROJECT_NAME_MAX = 200;
/** `SESSIONS_MAX`(`:25`)：列表卡最多列的会话数 */
export const SESSIONS_MAX = 10;
/** `LIST_TTL`(`:26`)：「绑定会话 <序号>」列表记忆有效期（秒） */
export const LIST_TTL = 1800;
/** `REPLY_MAX_CHARS`(`:27`)：答复回流截断长度 */
export const REPLY_MAX_CHARS = 3000;
/**
 * `_LAST_LIST`(`:28`)：`open_id -> [ts, [sid, ...]]`（列表卡的序号记忆；不进库、重启即失）。
 * Python 是模块级 dict，Node 用 Map（键是 open_id 字符串）；导出仅供用例与诊断。
 */
export const _LAST_LIST = new Map();

/** `DRIVER_NEEDED`(`:31`) */
export const DRIVER_NEEDED = '飞书通用对话需要 dsh 插件形态（独立形态的站点没有进程内 agent 驱动）';
/** `NO_DEFAULT_GUIDE`(`:32`) */
export const NO_DEFAULT_GUIDE = '请先设置默认项目（回复「默认项目 <项目名>」，或发「项目」在卡片上点选）';
/** `NO_PROJECTS_GUIDE`(`:33`) */
export const NO_PROJECTS_GUIDE = '你还没有项目，请先到站点创建';
/** `STALE_NOTE`(`:34`) */
export const STALE_NOTE = '（此前绑定的会话已不存在，已解除绑定）';
/** `UNBIND_NOTE`(`:35`) */
export const UNBIND_NOTE = '已解除此前绑定的会话（下次发消息将在新项目自动新建）';
/** `PROJECTS_MORE_FMT`(`:36`)：`%d` 走 Python `%` 格式化口径 */
export const PROJECTS_MORE_FMT = '另有 %d 个项目，回复「默认项目 <项目名>」精确设置';
/** `PROJECTS_TEXT_HINT`(`:37`)：卡片发不出时的文本兜底 */
export const PROJECTS_TEXT_HINT = '在卡片可用前，可用『默认项目 <项目名>』设置';
/** `SESSIONS_TEXT_HINT`(`:38`) */
export const SESSIONS_TEXT_HINT = '可用『绑定会话 <序号|标题关键字|会话id前缀>』绑定';
/** `TITLE_FMT`(`:39`)：新建会话的缺省标题（本地时间，零填充） */
export const TITLE_FMT = '飞书对话 %m-%d %H:%M';
/** `SESSION_GONE`(`:40`) */
export const SESSION_GONE = '该会话已不存在（可能被删除或归档清理），发「会话」刷新列表';
/** `SESSION_EMPTY`(`:41-42`，源码两段隐式拼接，无空格无换行) */
export const SESSION_EMPTY = '该默认项目下还没有会话——直接发一句话就会自动新建，'
  + '或回复「新建会话 <标题>」';
/** `SESSION_STALE`(`:43`) */
export const SESSION_STALE = '列表记忆已过期或序号越界，先发「会话」刷新最近 10 条，再回复「绑定会话 <序号>」';
/** `SESSION_MISS_FMT`(`:44`) */
export const SESSION_MISS_FMT = '没找到匹配「%s」的会话，发「会话」看最近 10 条';
/** `SESSION_MULTI_FMT`(`:45`，含真实换行) */
export const SESSION_MULTI_FMT = '「%s」匹配到多个会话，回复更精确的关键字：\n%s';
/**
 * `SESSION_FAIL_TEXTS`(`:47`)：`bind_session` 的失败回执（`t=ss` 回调据此选 toast 类型）。
 * Python 是元组且成员是同一对象引用；判定是**值相等**（`reply in SESSION_FAIL_TEXTS`）
 * ⇒ Node 用数组 + `includes` 值语义等价。
 */
export const SESSION_FAIL_TEXTS = [NO_DEFAULT_GUIDE, SESSION_GONE];
/** `SESSION_NAME_MAX`(`:48`)：会话名在卡片里的展示上限 */
export const SESSION_NAME_MAX = 60;
/** `MESSAGE_TOO_LONG`(`:49-50`，两段隐式拼接) */
export const MESSAGE_TOO_LONG = '消息过长（单条上限 %d 字）：请把长内容作为附件/文件发送，'
  + '或拆成几条短消息再发';

// ==========================================================================
// Python 值语义小工具（每条对着 CPython 行为写；`feishu_inbound.js` 里的同型助手
// 是**模块私有**的，R3 不许改那个文件 ⇒ 本文件自带一份，见契约清单 §8-D8）
// ==========================================================================

const PY_STRIP_RE = new RegExp(`^${PY_WS}+|${PY_WS}+$`, 'g');
/** Python 行边界（`str.splitlines()` 的切分点；`\r\n` 是一个边界） */
const PY_LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
/** `Numeric_Type=Digit` 的上标/带圈形（`str.isdigit()` 比 `\p{Nd}` 宽的那部分） */
const ND = /\p{Nd}/u;
const DIGIT_EXTRA = /[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2473\u24ea\u24ff\u2776-\u2793]/u;

/** Python `bool()`：`None`/`False`/`0`/`""`/空容器假；`nan` 为真 */
function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isNaN(value) ? true : value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b`（JS `||` 对 `[]`/`{}`/`"0"` 分叉 ⇒ 必须显式） */
function pyOr(a, b) {
  return pyTruthy(a) ? a : b;
}

/** Python `str(value)`（容器 = repr；`None`/`True`/`False` 是 Python 字面形态） */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyNumRepr(value);
  if (typeof value === 'bigint') return value.toString();
  return pyRepr(value);
}

/** Python 浮点 repr 的近似（整数形按 JS 最短表示） */
function pyNumRepr(value) {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Number.isInteger(value)) return Object.is(value, -0) ? '0' : String(value);
  return String(value);
}

/** Python 字符串 repr（单引号优先；含 `'` 且不含 `"` 时改用双引号） */
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

/** Python `repr(value)`（容器走自己的 repr） */
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

/** Python 类型名（异常文案用） */
function pyTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string': return 'str';
    case 'number': return Number.isInteger(value) ? 'int' : 'float';
    case 'boolean': return 'bool';
    case 'bigint': return 'int';
    case 'object': return 'dict';
    default: return typeof value;
  }
}

function makePyError(name, message) {
  const e = new Error(message);
  e.pyName = name;
  return e;
}

function attributeError(typeName, attr) {
  return makePyError('AttributeError', `'${typeName}' object has no attribute '${attr}'`);
}

function valueError(message) {
  return makePyError('ValueError', message);
}

/** Python `dict.get(key[, default])`：键存在但值为 None ⇒ **返回 None**（不是 default） */
function dget(dict, key, dflt) {
  if (dict === null || dict === undefined || typeof dict !== 'object' || Array.isArray(dict)) {
    throw attributeError(pyTypeName(dict), 'get');
  }
  if (Object.hasOwn(dict, key)) return dict[key] === undefined ? null : dict[key];
  return dflt === undefined ? null : dflt;
}

/** Python 下标取值：缺键 ⇒ KeyError（对应 oracle 的 `binding["open_id"]` 这类写法） */
function requireKey(dict, key) {
  if (dict === null || dict === undefined || typeof dict !== 'object') {
    throw attributeError(pyTypeName(dict), key);
  }
  if (!Object.hasOwn(dict, key)) throw makePyError('KeyError', `'${key}'`);
  return dict[key] === undefined ? null : dict[key];
}

/** Python `str.strip()`——**非 str 抛 AttributeError**（`lib.js:pyStrip` 会静默 `String(v)`） */
function pyStrStrip(value) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), 'strip');
  return value.replace(PY_STRIP_RE, '');
}

/** `s.splitlines()[0]`（首行；调用点已先 strip，故不会拿到空串） */
function pyFirstLine(value) {
  return value.split(PY_LINE_BREAK_RE)[0];
}

/** Python `s[:n]`（按**码点**切，不是 UTF-16 码元） */
function pySlice(value, n) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), '__getitem__');
  const points = Array.from(value);
  return points.length <= n ? value : points.slice(0, n).join('');
}

/** Python `len(s)`（按**码点**计，不是 UTF-16 码元） */
function pyLen(value) {
  if (typeof value === 'string') return Array.from(value).length;
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  throw new TypeError(`object of type '${pyTypeName(value)}' has no len()`);
}

/** Python `float(value)`（失败抛 ValueError/TypeError，与 oracle 的 except 面一致） */
function pyFloat(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') {
    throw new TypeError(`float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
  }
  const raw = pyStrStrip(value);
  if (raw === '') throw valueError("could not convert string to float: ''");
  const lowered = raw.toLowerCase().replace(/^[+-]/, '');
  if (lowered === 'nan') return raw.startsWith('-') ? -NaN : NaN;   // eslint-disable-line no-self-compare
  if (lowered === 'inf' || lowered === 'infinity') {
    return raw.startsWith('-') ? -Infinity : Infinity;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) throw valueError(`could not convert string to float: ${pyReprStr(value)}`);
  return n;
}

/** `\p{Nd}` 字符的十进制数字值（Unicode 十进制数字块恒为连续 10 个码点） */
function ndValue(ch) {
  const cp = ch.codePointAt(0);
  let zero = cp;
  for (let i = 1; i <= 9 && zero > 0; i += 1) {
    if (!ND.test(String.fromCodePoint(zero - 1))) break;
    zero -= 1;
  }
  return cp - zero;
}

/**
 * Python `int(value)`：**失败必须抛**（`Number("")===0` / `Number("abc")===NaN` 会静默改分支）。
 * 支持 bool、number（截断向零；`nan`/`inf` 抛）、字符串（可选符号 + `\p{Nd}` 数字 +
 * 数字间单个下划线，首尾 Python 空白）。
 *
 * 为什么不用 `lib.js:pyIntOr`：它只解析字符串形态（数字 `3.7` 会给 fallback），而 oracle 的
 * `int()` 三种入参都要；`_selected_project_id`/`set_default_project` 还要「失败即抛」的那一支。
 */
function pyIntStrict(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      throw valueError(`invalid literal for int() with base 10: '${pyNumRepr(value)}'`);
    }
    if (!Number.isFinite(value)) throw valueError('cannot convert float infinity to integer');
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') {
    throw new TypeError('int() argument must be a string, a bytes-like object or a real number, '
      + `not '${pyTypeName(value)}'`);
  }
  const raw = pyStrStrip(value);
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
      if (prev === '' || next === '' || !ND.test(prev) || !ND.test(next)) {
        throw valueError(`invalid literal for int() with base 10: '${value}'`);
      }
      continue;
    }
    if (!ND.test(ch)) throw valueError(`invalid literal for int() with base 10: '${value}'`);
    digits += String(ndValue(ch));
  }
  return sign * Number(digits);
}

/** Python `str.isdigit()`（Nd + Digit 类；`"²"` 为真而 `int("²")` 会抛 —— oracle 的原样边角） */
function pyIsDigit(value) {
  if (typeof value !== 'string') throw attributeError(pyTypeName(value), 'isdigit');
  if (value.length === 0) return false;
  for (const ch of value) if (!ND.test(ch) && !DIGIT_EXTRA.test(ch)) return false;
  return true;
}

/**
 * Python `%` 单占位符格式化的等价物（本模块只用 `%d`/`%s`）。
 * **不许用 `String.replace`**：替换串里的 `$&`/`$'`/`$1` 会被当成替换模式（`%` 没有这回事）。
 */
function fmtSlot(template, slot, value) {
  const i = template.indexOf(slot);
  if (i < 0) return template;
  return template.slice(0, i) + value + template.slice(i + slot.length);
}

/** Python `"%d" % n`（入参已保证是 int） */
function fmtD(template, n) {
  return fmtSlot(template, '%d', pyStr(n));
}

/** Python `"%s" % value`（单参数） */
function fmtS(template, value) {
  return fmtSlot(template, '%s', value);
}

/** Python `"%s … %s" % (a, b)`（两参数，按出现次序；`SESSION_MULTI_FMT` 用） */
function fmtS2(template, a, b) {
  const first = template.indexOf('%s');
  if (first < 0) return template;
  const second = template.indexOf('%s', first + 2);
  if (second < 0) return template;
  return template.slice(0, first) + a + template.slice(first + 2, second) + b
    + template.slice(second + 2);
}

/** 异常 → 文本（`str(e)` 口径：`Error` 取 message，不带类名前缀；与 `board.js:1845` 同） */
function errText(err) {
  if (err === null || err === undefined) return '';
  if (err instanceof Error) return String(err.message ?? err);
  return pyStr(err);
}

/** 异常 → Python `repr(e)` 的近似（`{e!r}` 留痕用；`pyName` 优先，照 `feishu_inbound.js:363`） */
function errorRepr(e) {
  if (e instanceof Error) {
    const name = typeof e.pyName === 'string' ? e.pyName : (e.name || 'Error');
    return `${name}(${pyReprStr(e.message === undefined ? String(e) : e.message)})`;
  }
  return pyRepr(e);
}

// ==========================================================================
// 依赖解析（末位 `options` 注入；默认值 = 真模块）
// ==========================================================================

/** 默认日志口：`console.error(line)`（= stderr + `\n`，与 `print(..., file=sys.stderr)` 同形） */
function defaultLog(line) {
  console.error(line);
}

/** 默认时钟（秒；`time.time()` 口径）。`options.now` 可注入 ⇒ 测 TTL / 缺省标题 */
function defaultNow() {
  return Date.now() / 1000;
}

/**
 * 依赖表。⚠`options.db` 是 **sqlite 句柄**（透传给 db.js），**不是**模块槽——
 * 要替换整个 db 模块用 `options.dbmod`（与 `feishu_inbound.js:416` 同一约定）。
 */
function deps(options = {}) {
  return {
    db: options.dbmod || dbMod,
    sessparse: options.sessparse || sessparseMod,
    dshdriver: options.dshdriver || dshdriverMod,
    dshevents: options.dshevents || dsheventsMod,
    agents: options.agents || { agentFamily },
    waitq: options.waitq || waitqMod,
    rest: options.rest || restMod,
    cfg: options.cfg || cfgMod,
    chat: options.chat || chatMod,
    now: options.now || defaultNow,
    log: options.log || defaultLog,
    env: options.env || process.env,
  };
}

/** `app_config(user_id)`：`options.feishu`（feishu 模块替身）优先，否则 `feishu_cfg.appConfig` */
function appConfigOf(options, userId) {
  if (options.feishu && typeof options.feishu.appConfig === 'function') {
    return options.feishu.appConfig(userId, options);
  }
  return cfgMod.appConfig(userId, options);
}

// ==========================================================================
// 开关与小工具（`feishu_conv.py:53-55` / `:716-737` / `:918-920`）
// ==========================================================================

/**
 * 通用对话总开关（默认开；`TS_FEISHU_CONV=0` 关闭）。
 *
 * **精确语义**：只有 `strip()` 后**恰好等于 `"0"`** 才关——`"0 "`/`" 0"` 关，
 * `"00"`/`"0.0"`/`"false"`/`"FALSE"`/`"no"`/`""`/未设置**全开**。
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function enabled(options = {}) {
  const env = deps(options).env || {};
  return pyStrStrip(pyOr(env[CONV_ENV], '')) !== '0';
}

/**
 * binding 字段容错读取（`feishu_conv.py:726-732`）：生产是 sqlite3.Row、用例里可能是普通
 * dict，少键一律按缺省值处理。
 *
 * ⚠**不许写成 `binding[key] ?? default`**：SQLite NULL 列在 Python 侧是 `None`（**不是**缺键），
 * 本函数会原样返回 `None`；`??` 会把 `null` 换成 default。判据是「键存在与否」。
 */
function bindingValue(binding, key, dflt = '') {
  if (binding === null || binding === undefined) return dflt;
  if (typeof binding !== 'object') return dflt;
  if (Array.isArray(binding)) return binding[key] === undefined ? dflt : binding[key];
  if (!Object.hasOwn(binding, key)) return dflt;
  return binding[key] === undefined ? null : binding[key];
}

/** 项目名展示截断（`feishu_conv.py:721-723`）：`str(name or "")[:PROJECT_NAME_MAX]`（码点） */
function clipName(name) {
  return pySlice(pyStr(pyOr(name, '')), PROJECT_NAME_MAX);
}

/** 应用凭据是否齐备（`feishu_conv.py:716-718`）：`bool(cfg) and bool(app_id) and bool(app_secret)` */
function hasCreds(cfg) {
  if (!pyTruthy(cfg)) return false;
  return pyTruthy(dget(cfg, 'app_id')) && pyTruthy(dget(cfg, 'app_secret'));
}

/** stderr 留痕（`feishu_conv.py:918-920`）：前缀逐字 `feishu_conv: ` */
function trace(text, options = {}) {
  deps(options).log(`feishu_conv: ${text}`);
}

// ==========================================================================
// 卡片对象族（`feishu_conv.py:194-216`）
// ==========================================================================

/**
 * 卡片对象（`_Card`，`feishu_conv.py:194-205`）：元素按飞书 schema 2.0 放在 `body.elements`；
 * `card.elements` 是**只读别名**，指向同一列表（便于调用方/用例按元素遍历）。
 *
 * 别名只在读口生效：`pyJsonDumps` 走真实键（`Object.keys` 不带不可枚举属性），发出去的 JSON
 * 里没有顶层 `elements`——既不多占体积预算，也不会因未知字段被飞书拒收。
 */
function makeCard(header, elements) {
  const card = { schema: '2.0', header, body: { elements } };
  Object.defineProperty(card, 'elements', {
    get() { return this.body.elements; },
    enumerable: false,
    configurable: true,
  });
  return card;
}

/**
 * 卡片实际发出的体积（字节）：与 `rest_send_card` **同一序列化口径**
 * （`feishu_rest.js:350` 用 `pyJsonDumps(card)`）——用 `JSON.stringify` 会少算 `", "`/`": "`
 * 与转义差异，体积闸会在临界卡上分叉。
 */
function cardBytes(card) {
  return Buffer.byteLength(pyJsonDumps(card), 'utf8');
}

// ==========================================================================
// 项目总览族（`feishu_conv.py:187-340`）
// ==========================================================================

/** 该绑定用户的全部项目（多用户隔离：只查本人；`binding["user_id"]` 直接下标） */
function projectsOf(binding, options = {}) {
  const d = deps(options);
  return d.db.listProjects(requireKey(binding, 'user_id'), options);
}

/**
 * 按 id 在**本人**的项目里定位（`feishu_conv.py:740-749`）：不存在/非本人项目一律 None。
 * `int(pid or 0)` 失败**吞成 None**（与本文件多数 `int()` 路径不同）。
 */
export function projectById(binding, pid, options = {}) {
  let want;
  try {
    want = pyIntStrict(pyOr(pid, 0));
  } catch (e) {
    if (e instanceof TypeError || (e && e.pyName === 'ValueError')) return null;
    throw e;
  }
  for (const p of projectsOf(binding, options)) {
    if (p.id === want) return p;
  }
  return null;
}

/** 单聊默认项目行（`feishu_conv.py:752-754`）；`default_project_id` 走**直接下标** */
function defaultProject(binding, options = {}) {
  return projectById(binding, requireKey(binding, 'default_project_id'), options);
}

/**
 * 项目定位（`feishu_conv.py:757-769`，口径同 `feishu._resolve_project`）：
 * 默认项目 → 用户唯一项目 → `[None, 文案]`；报错分支列出可选项目名（顿号、最多 8 个）。
 * @returns {[object|null, string]}
 */
function locateProject(binding, options = {}) {
  const project = defaultProject(binding, options);
  if (project !== null) return [project, ''];
  const owned = projectsOf(binding, options);
  if (owned.length === 1) return [owned[0], ''];
  if (owned.length === 0) return [null, NO_PROJECTS_GUIDE];
  return [null, '请指明项目（回复「默认项目 <项目名>」），可选：'
    + owned.slice(0, 8).map((p) => p.name).join('、')];
}

/**
 * 看板五列卡片数（`feishu_conv.py:328-340`）：doing/blocked/review 走批量口，
 * todo/done 该口**不返回**（实测只有三列）⇒ 由 `list_board_cards` 现算补齐，
 * 补齐值**无条件覆盖**（日后该口扩到五列也不会重复计）。
 */
function boardCounts(pid, options = {}) {
  const d = deps(options);
  const counts = { todo: 0, doing: 0, blocked: 0, review: 0, done: 0 };
  const many = pyOr(d.db.boardCountsMany([pid], options)[pid], {});
  for (const key of Object.keys(many)) counts[key] = many[key];
  const tail = { todo: 0, done: 0 };
  for (const card of d.db.listBoardCards(pid, options)) {
    const key = pyStr(pyOr(card.column_key, ''));
    if (Object.hasOwn(tail, key)) tail[key] += 1;
  }
  counts.todo = tail.todo;
  counts.done = tail.done;
  return counts;
}

/** 单项目计数行（`feishu_conv.py:300-325`，逐字） */
function countsLine(project, options = {}) {
  const d = deps(options);
  const pid = project.id;
  let running = 0;
  let queued = 0;
  for (const t of d.db.listTasks(pid, options)) {
    const status = pyStr(pyOr(t.status, ''));
    if (status === 'running') running += 1;
    else if (status === 'queued') queued += 1;
  }
  const board = boardCounts(pid, options);
  const kinds = {
    [d.waitq.KIND_CARD]: 0, [d.waitq.KIND_MSG]: 0, [d.waitq.KIND_ANSWER]: 0, [d.waitq.KIND_EXT]: 0,
  };
  for (const it of d.waitq.activeItems(pid, options)) {
    const kind = pyStr(pyOr(it.kind, ''));
    if (Object.hasOwn(kinds, kind)) kinds[kind] += 1;
  }
  return `任务 运行 ${running}/排队 ${queued} · 看板 待开发 ${board.todo}/开发中 ${board.doing}`
    + `/阻塞 ${board.blocked}/待审核 ${board.review}/已完成 ${board.done} · `
    + `队列 卡 ${kinds[d.waitq.KIND_CARD]}/消息 ${kinds[d.waitq.KIND_MSG]}`
    + `/作答 ${kinds[d.waitq.KIND_ANSWER]}/外部 ${kinds[d.waitq.KIND_EXT]}`;
}

/** 默认项目置顶、其余按 id 升序（`feishu_conv.py:236-237` 的 `sorted(key=...)`） */
function orderedProjects(projects, defaultId) {
  return projects.slice().sort((a, b) => {
    const ka = pyIntStrict(a.id) === defaultId ? 0 : 1;
    const kb = pyIntStrict(b.id) === defaultId ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return pyIntStrict(a.id) - pyIntStrict(b.id);
  });
}

/**
 * 总览卡根级元素（`feishu_conv.py:259-276`）：每项目一块 markdown（`**名称** ✅/💬` [+ 计数行]），
 * 有项目没列全时补一行文本引导，末尾是**唯一**的根级下拉控件（option.value = 项目 id）。
 */
function projectsElements(binding, rows, counts, shown, withCounts) {
  const els = [];
  rows.slice(0, shown).forEach((row, i) => {
    const [, name, marks] = row;
    const head = `**${name}**` + (marks.length ? ` ${marks.join(' ')}` : '');
    els.push({ tag: 'markdown', content: head + (withCounts ? `\n${counts[i]}` : '') });
  });
  const extra = rows.length - shown;
  if (extra > 0) els.push({ tag: 'markdown', content: fmtD(PROJECTS_MORE_FMT, extra) });
  els.push({
    tag: 'select_static',
    name: 'ts_projects',
    placeholder: { tag: 'plain_text', content: '选择项目设为默认' },
    options: rows.slice(0, shown).map(([pid, name]) => ({
      text: { tag: 'plain_text', content: pySlice(name, 24) }, value: pyStr(pid),
    })),
    behaviors: [{ type: 'callback', value: { t: 'dp', u: requireKey(binding, 'user_id') } }],
  });
  return els;
}

/**
 * 项目总览卡（`feishu_conv.py:219-256`）：无项目返回 `null`（调用方回文本引导）。
 *
 * 体积三道闸（飞书对超限卡片整条拒收）：① 最多列 `PROJECTS_MAX`；② 仍超 ⇒ 删计数行；
 * ③ 仍超 ⇒ 项目数降到 `PROJECTS_FALLBACK` 再逐次折半（至少留 1 个）。降级 ②③ 都**不恢复**
 * 计数行；`counts` 按全量算好，降级只裁展示条数。
 */
function projectsCard(binding, options = {}) {
  const projects = projectsOf(binding, options);
  if (!projects.length) return null;
  const def = defaultProject(binding, options);
  const defaultId = def ? pyIntStrict(def.id) : 0;
  let curPid = pyIntStrict(pyOr(bindingValue(binding, 'cur_project_id', 0), 0));
  if (!pyTruthy(pyStrStrip(pyStr(pyOr(bindingValue(binding, 'cur_sid', ''), ''))))) {
    curPid = 0;      // 会话指针为空时 cur_project_id 无意义（不标 💬）
  }
  const ordered = orderedProjects(projects, defaultId);
  const rows = ordered.map((p) => {
    const pid = pyIntStrict(p.id);
    const marks = [];
    if (pid === defaultId) marks.push('✅');
    if (pyTruthy(curPid) && pid === curPid) marks.push('💬');
    return [pid, clipName(p.name), marks];
  });
  const counts = ordered.slice(0, PROJECTS_MAX).map((p) => countsLine(p, options));
  const title = def ? clipName(def.name) : '未设置';
  const header = {
    title: { tag: 'plain_text', content: `项目总览（默认：${title}）` },
    template: 'orange',
  };
  const total = rows.length;
  let shown = Math.min(total, PROJECTS_MAX);
  let card = makeCard(header, projectsElements(binding, rows, counts, shown, true));
  if (cardBytes(card) > CARD_MAX_BYTES) {                       // 降级 ②：删计数行
    card = makeCard(header, projectsElements(binding, rows, counts, shown, false));
  }
  let limit = PROJECTS_FALLBACK;                                // 降级 ③：收缩项目数
  while (cardBytes(card) > CARD_MAX_BYTES && shown > 1) {
    shown = Math.min(shown, limit);
    card = makeCard(header, projectsElements(binding, rows, counts, shown, false));
    limit = Math.max(1, Math.floor(limit / 2));
  }
  return card;
}

/**
 * 总览卡的**纯文本兜底**（`feishu_conv.py:279-297`）：卡片未被受理时用。
 * 排序与卡片一致；项目名同样过 `clipName`；文本没有 8000 字节预算问题 ⇒ 不降级、不裁条数。
 */
function projectsText(binding, options = {}) {
  const projects = projectsOf(binding, options);
  if (!projects.length) return NO_PROJECTS_GUIDE;
  const def = defaultProject(binding, options);
  const defaultId = def ? pyIntStrict(def.id) : 0;
  const lines = ['项目列表：'];
  for (const p of orderedProjects(projects, defaultId)) {
    const mark = pyIntStrict(p.id) === defaultId ? ' ✅默认' : '';
    lines.push(`· ${clipName(p.name)}${mark}`);
  }
  lines.push(PROJECTS_TEXT_HINT);
  return lines.join('\n');
}

// ==========================================================================
// 默认项目与卡片回调（`feishu_conv.py:343-423`）
// ==========================================================================

/**
 * 设默认项目（卡片 `t=dp` 与文本指令共用同一段写路径），返回回执文案。
 *
 * 跨项目**自动解绑**（会话是项目目录下的实体，留着跨项目投递会打到错误的工作目录）；
 * 换项目同时作废「会话列表卡」的序号记忆（`_LAST_LIST` 是**某个项目下**的顺序）。
 * 同项目重复设置：库照写、会话与记忆都不动。
 *
 * `int()` 失败**不 try**（照 oracle）：由调用方 `execute_intent` 的 `except Exception` 兜住。
 */
export function setDefaultProject(binding, project, options = {}) {
  const d = deps(options);
  const openId = requireKey(binding, 'open_id');
  const changed = pyIntStrict(pyOr(bindingValue(binding, 'default_project_id', 0), 0))
    !== pyIntStrict(project.id);
  d.db.setFeishuDefaultProject(openId, project.id, options);
  if (changed) _LAST_LIST.delete(openId);
  let reply = `默认项目已设为「${project.name}」`;
  const sid = pyStrStrip(pyStr(pyOr(bindingValue(binding, 'cur_sid', ''), '')));
  if (pyTruthy(sid)
    && pyIntStrict(pyOr(bindingValue(binding, 'cur_project_id', 0), 0)) !== pyIntStrict(project.id)) {
    d.db.clearFeishuCurSession(openId, options);
    reply += `\n${UNBIND_NOTE}`;
  }
  return reply;
}

/**
 * 通用对话卡片回调（`feishu_conv.py:366-398`）：`t=dp` 项目总览 / `t=ss` 会话列表 →
 * 返回 toast；未知 `t` 返回 `null`（交给飞书兜底，不更新卡片）。
 *
 * 写操作前两道归属复核（多用户隔离）：卡片 `value.u` == 点击者 `user_id`（防串号），且所选
 * 项目 ∈ `list_projects(user_id)`；`t=ss` 的会话归属由 `bindSession` 复验**本项目会话桶**兜住。
 * `sender` 未用（open_id 从 binding 取），保留以固定回调签名。
 */
export async function onCardAction(sender, binding, value, action, cfg = null, options = {}) {
  const v = pyOr(value, {});
  const a = pyOr(action, {});
  if (pyStr(pyOr(dget(v, 'u'), '')) !== pyStr(requireKey(binding, 'user_id'))) {
    return { toast: { type: 'error', content: '这张卡片不属于当前账号' } };
  }
  if (pyStr(pyOr(dget(v, 't'), '')) === 'dp') {
    const project = projectById(binding, selectedProjectId(a), options);
    if (project === null) return { toast: { type: 'error', content: '项目不在你的列表里' } };
    const reply = setDefaultProject(binding, project, options);
    await dm(requireKey(binding, 'open_id'), reply, cfg, 0, options);
    return { toast: { type: 'success', content: '已设为默认项目' } };
  }
  if (pyStr(pyOr(dget(v, 't'), '')) === 'ss') {
    const sid = selectedSession(a);
    if (!pyTruthy(sid)) return { toast: { type: 'error', content: '没有取到要绑定的会话' } };
    const reply = bindSession(binding, sid, '', options);
    await dm(requireKey(binding, 'open_id'), reply, cfg, 0, options);   // 完整回执走私聊
    if (reply === SESSION_GONE) {
      return { toast: { type: 'error', content: '会话已不存在，发「会话」刷新列表' } };
    }
    if (SESSION_FAIL_TEXTS.includes(reply)) {
      return { toast: { type: 'error', content: '绑定失败' } };
    }
    return { toast: { type: 'success', content: '已绑定该会话' } };
  }
  void sender;      // oracle 留形参以固定回调签名；open_id 一律从 binding 取
  return null;
}

/**
 * 下拉回调里被选中的项目 id（`feishu_conv.py:401-412`）：`action.option`（str 或 list，
 * 取首个）→ 兜底 `action.value.i`；非数字返回 `0`（0 不是合法项目 id ⇒ 定位必然失败）。
 */
function selectedProjectId(action) {
  let raw = dget(pyOr(action, {}), 'option');
  if (Array.isArray(raw)) raw = raw.length ? raw[0] : '';
  if (raw === null || raw === undefined || raw === '') {
    raw = dget(pyOr(dget(pyOr(action, {}), 'value'), {}), 'i');
  }
  try {
    return pyIntStrict(pyStrStrip(pyStr(raw)));
  } catch (e) {
    if (e instanceof TypeError || (e && e.pyName === 'ValueError')) return 0;
    throw e;
  }
}

/** 下拉回调里被选中的会话 id（`feishu_conv.py:415-423`）：取不到返回 `""`（绝不无依据绑定） */
function selectedSession(action) {
  let raw = dget(pyOr(action, {}), 'option');
  if (Array.isArray(raw)) raw = raw.length ? raw[0] : '';
  if (raw === null || raw === undefined || raw === '') {
    raw = dget(pyOr(dget(pyOr(action, {}), 'value'), {}), 'i');
  }
  return pyStrStrip(pyStr(pyOr(raw, '')));
}

// ==========================================================================
// 发送闸与凭据（`feishu_conv.py:676-718`）
// ==========================================================================

/**
 * 给绑定用户发交互卡片（`项目`/`会话` 指令用）：返回 `true` = 飞书已受理。
 *
 * 凭据不全只留痕返回 `false`（与 `_dm` 同闸——绝不用空凭据去打真实接口）；异常同样只留痕
 * 返回 `false`（卡片发不出不该让指令执行本身失败）。调用方据此决定是否补发**文本兜底**。
 */
async function sendCard(openId, card, cfg, options = {}) {
  const d = deps(options);
  if (!hasCreds(cfg)) {
    trace(`卡片跳过（应用凭据缺失）open_id=${pySlice(pyStr(openId), 12)}`, options);
    return false;
  }
  try {
    await d.rest.restSendCard(openId, card, cfg);
  } catch (e) {
    trace(`卡片发送失败: ${errorRepr(e)}`, options);
    return false;
  }
  return true;
}

/**
 * 给绑定用户发 DM 文本（卡片回执 / 答复回流共用）。
 *
 * **凭据前置闸**：`cfg` 缺 `app_id`/`app_secret` 时只留痕返回，绝不发网络请求；
 * `cfg` 为假值（`None`/`{}`/`0`）时现取 `app_config(user_id or 0)`。不返回任何值。
 */
async function dm(openId, text, cfg = null, userId = 0, options = {}) {
  const d = deps(options);
  const useCfg = pyTruthy(cfg) ? cfg : appConfigOf(options, pyOr(userId, 0));
  if (!hasCreds(useCfg)) {
    trace(`DM 跳过（应用凭据缺失）open_id=${pySlice(pyStr(openId), 12)}`, options);
    return;
  }
  try {
    await d.rest.restSendText(openId, text, useCfg);
  } catch (e) {
    trace(`DM 发送失败: ${errorRepr(e)}`, options);
  }
}

// ==========================================================================
// 会话列表族、绑定 / 解绑（`feishu_conv.py:426-673`）
// ==========================================================================

/** 会话展示名（`feishu_conv.py:503-511`）：标题 → 首问**首行** → sid 短码，截 SESSION_NAME_MAX */
function sessionName(item) {
  let name = pyStrStrip(pyStr(pyOr(dget(item, 'title'), '')));
  if (!name) {
    const prompt = pyStrStrip(pyStr(pyOr(dget(item, 'first_prompt'), '')));
    name = prompt ? pyStrStrip(pyFirstLine(prompt)) : '';
  }
  if (!name) name = pySlice(pyStr(pyOr(dget(item, 'sid'), '')), 12);
  return pySlice(name, SESSION_NAME_MAX);
}

/**
 * 相对活跃时间（`feishu_conv.py:565-580`）：刚刚 / N 分钟前 / N 小时前 / N 天前
 * （脏值/零/负值/未来一律「刚刚」；`%d` 是 `int(delta // N)`）。
 */
function relTime(mtime, options = {}) {
  const d = deps(options);
  let ts;
  try {
    ts = pyFloat(mtime);
  } catch (e) {
    if (e instanceof TypeError || (e && e.pyName === 'ValueError')) return '刚刚';
    throw e;
  }
  if (ts <= 0) return '刚刚';
  const delta = d.now() - ts;
  if (delta < 60) return '刚刚';
  if (delta < 3600) return fmtD('%d 分钟前', Math.floor(delta / 60));
  if (delta < 86400) return fmtD('%d 小时前', Math.floor(delta / 3600));
  return fmtD('%d 天前', Math.floor(delta / 86400));
}

/**
 * 会话是否正在跑 turn（仅展示用，`feishu_conv.py:548-562`）。
 *
 * 读口＝`dshevents` 的进程内注册表（**零请求**）：列表卡在入站线程里同步构建，逐会话打驱动
 * `/status`（15s 超时 × 最多 SESSIONS_MAX 条）会把入站线程整条卡住。未连接中枢/未见过该会话
 * ⇒ `get` 返回 None ⇒ **不标**（未知 ≠ 空闲）；任何异常同样按「不标」处理。
 */
function sessionBusy(sid, options = {}) {
  const d = deps(options);
  try {
    const st = d.dshevents.get(sid);
    return pyTruthy(st) && dget(st, 'status') === 'running';
  } catch (e) {
    trace(`会话忙闲探测失败 sid=${pySlice(pyStr(sid), 12)}: ${errorRepr(e)}`, options);
    return false;
  }
}

/**
 * 单行 markdown（`feishu_conv.py:484-500`）：`**序号. 名称** · 相对时间 · 状态标`。
 * 状态标顺序固定：🏃 运行中 → 📦 已归档 → ✅ 当前（`" · "` 连接；无标记时整段为空）。
 */
function sessionRow(index, item, curSid, options = {}) {
  const marks = [];
  if (sessionBusy(item.sid, options)) marks.push('🏃 运行中');
  if (pyTruthy(dget(item, 'archived'))) marks.push('📦 已归档');
  if (pyStr(item.sid) === pyStr(pyOr(curSid, ''))) marks.push('✅ 当前');
  const content = `**${fmtD('%d', index)}. ${sessionName(item)}** · ${relTime(dget(item, 'mtime'), options)}`
    + (marks.length ? ` · ${marks.join(' ')}` : '');
  return { tag: 'markdown', content };
}

/** 列表卡根级元素（`feishu_conv.py:470-481`）：`rows[:shown]` + **唯一**根级下拉 */
function sessionsElements(rows, items, shown, userId) {
  const els = rows.slice(0, shown);
  els.push({
    tag: 'select_static',
    name: 'ts_sessions',
    placeholder: { tag: 'plain_text', content: '选择要绑定的会话' },
    options: items.slice(0, shown).map((it) => ({
      text: { tag: 'plain_text', content: pySlice(sessionName(it), 24) },
      value: pyStr(it.sid),
    })),
    behaviors: [{ type: 'callback', value: { t: 'ss', u: userId } }],
  });
  return els;
}

/** 登记本次列表卡的会话顺序（`feishu_conv.py:540-545`）；写前清理过期桶（严格 `>`） */
function rememberList(openId, sids, options = {}) {
  const d = deps(options);
  const now = d.now();
  for (const key of [..._LAST_LIST.keys()]) {
    const entry = _LAST_LIST.get(key);
    if (now - entry[0] > LIST_TTL) _LAST_LIST.delete(key);
  }
  _LAST_LIST.set(openId, [now, sids.map((s) => pyStr(s))]);
}

/**
 * 会话列表卡（`feishu_conv.py:434-467`）：无默认项目返回 `null`；零会话返回**有卡片无控件**
 * （一块引导 markdown，同时登记空表——序号必然越界）。
 *
 * 数据源已按 mtime 倒序（`sessparse.list_sessions`），取前 `SESSIONS_MAX`；登记条数与卡片实际
 * 列出的条数**始终一致**（体积降级后同步收缩，防序号错位）。行内容只算一次：降级只裁条数。
 */
function sessionsCard(binding, options = {}) {
  const d = deps(options);
  const project = defaultProject(binding, options);
  if (project === null) return null;
  const items = d.sessparse.list_sessions('dsh', project.project_dir).slice(0, SESSIONS_MAX);
  const openId = requireKey(binding, 'open_id');
  const header = {
    title: { tag: 'plain_text', content: `会话列表（默认：${clipName(project.name)}）` },
    template: 'blue',
  };
  if (!items.length) {
    rememberList(openId, [], options);
    return makeCard(header, [{ tag: 'markdown', content: SESSION_EMPTY }]);
  }
  const curSid = pyStrStrip(pyStr(pyOr(bindingValue(binding, 'cur_sid', ''), '')));
  const rows = items.map((it, i) => sessionRow(i + 1, it, curSid, options));
  let shown = items.length;
  let card = makeCard(header, sessionsElements(rows, items, shown, requireKey(binding, 'user_id')));
  let limit = Math.floor(shown / 2);
  while (cardBytes(card) > CARD_MAX_BYTES && shown > 1) {
    shown = Math.min(shown, limit);
    card = makeCard(header, sessionsElements(rows, items, shown, requireKey(binding, 'user_id')));
    limit = Math.max(1, Math.floor(limit / 2));
  }
  rememberList(openId, items.slice(0, shown).map((it) => it.sid), options);
  return card;
}

/**
 * 列表卡的**纯文本兜底**（`feishu_conv.py:514-537`）：序号取自 `_LAST_LIST[open_id]`
 * （`sessions_card` 刚登记的那份：与卡片下拉严格同序，且已随体积降级同步收缩）；
 * 记忆缺失（理论不可达）才现取一份。标题按 sid 从当前会话集**回查**（第二次读盘）。
 */
function sessionsText(binding, options = {}) {
  const entry = _LAST_LIST.get(requireKey(binding, 'open_id'));
  const sids = entry
    ? entry[1].map((s) => pyStr(s))
    : projectSessions(binding, options).slice(0, SESSIONS_MAX).map((it) => pyStr(it.sid));
  if (!sids.length) return SESSION_EMPTY;
  const bySid = new Map(projectSessions(binding, options).map((it) => [pyStr(it.sid), it]));
  const project = defaultProject(binding, options);
  const lines = [project ? `「${clipName(project.name)}」最近会话：` : '最近会话：'];
  sids.forEach((sid, i) => {
    const item = bySid.get(sid) || { sid };
    lines.push(`${i + 1}. ${sessionName(item)}（${pySlice(sid, 12)}）`);
  });
  lines.push(SESSIONS_TEXT_HINT);
  return lines.join('\n');
}

/**
 * 会话绑定用到的项目（`feishu_conv.py:583-593`）：默认项目 → 当前会话所属项目（按
 * `cur_project_id` 还原）→ None。两处都过 `projectById`，非本人项目一律 None（多用户隔离）。
 */
function sessionProject(binding, options = {}) {
  let project = defaultProject(binding, options);
  if (project === null) {
    project = projectById(binding, bindingValue(binding, 'cur_project_id', 0), options);
  }
  return project;
}

/**
 * `sessionProject` 下的会话列表（`feishu_conv.py:596-603`）；项目缺失/读不到返回 `[]`。
 * 同时是 `bindSession` 的**归属校验数据源**。
 */
function projectSessions(binding, options = {}) {
  const d = deps(options);
  const project = sessionProject(binding, options);
  if (project === null) return [];
  return d.sessparse.list_sessions('dsh', project.project_dir);
}

/**
 * 绑定会话（`t=ss` 回调与「绑定会话 …」文本兜底共用），返回回执文案。
 *
 * **所有「选中一个 sid 写绑定」的路径都必须走这里**，写前做一次项目归属复验：sid 必须落在
 * **该项目 `project_dir` 的会话桶**内，判据是 `list_sessions` 的结果集（**不拿 sid 直接开文件**
 * ——`session_exists` 是跨 bucket 的纯路径存在性，验不出「这个 sid 属不属于当前项目」）。
 * 复验不过**一个字都不写**。返回文案命中 `SESSION_FAIL_TEXTS` 即表示没写绑定。
 *
 * 唯一不经此处的写路径是**新建**会话（`createInProject`）。
 */
function bindSession(binding, sid, title = '', options = {}) {
  const d = deps(options);
  const want = pyStrStrip(pyStr(pyOr(sid, '')));
  const project = sessionProject(binding, options);
  if (project === null) return NO_DEFAULT_GUIDE;
  const known = new Set(projectSessions(binding, options).map((it) => pyStr(it.sid)));
  if (!known.has(want)) return SESSION_GONE;
  const finalTitle = pyStrStrip(pyStr(pyOr(title, ''))) || d.sessparse.session_title('dsh', want);
  d.db.setFeishuCurSession(requireKey(binding, 'open_id'), project.id, want, finalTitle, options);
  return `已绑定「${finalTitle || pySlice(want, 12)}」（项目：${project.name}），`
    + '接下来发消息都进这个会话';
}

/**
 * 文本兜底绑定（`feishu_conv.py:636-662`，「绑定会话 <序号|标题关键字|会话id前缀>」）。
 *
 * 三分支：① 纯数字 ⇒ 上一张列表卡的序号（`_LAST_LIST`，TTL `LIST_TTL`；过期/越界只回引导，
 * **绝不瞎猜「第 1 条」**）；② 标题包含唯一命中 ⇒ 绑定，多命中回候选（最多 8 条，不猜）；
 * ③ sid **前缀**唯一命中 ⇒ 绑定（`startswith` 不是 `in`）。都不中 ⇒ 引导发「会话」。
 */
function useByToken(binding, token, options = {}) {
  const d = deps(options);
  const want = pyStrStrip(pyStr(pyOr(token, '')));
  if (!want) return SESSION_STALE;
  if (pyIsDigit(want)) {
    const entry = _LAST_LIST.get(requireKey(binding, 'open_id'));
    const idx = pyIntStrict(want) - 1;
    if (!pyTruthy(entry) || (d.now() - entry[0]) > LIST_TTL || !(idx >= 0 && idx < entry[1].length)) {
      return SESSION_STALE;
    }
    return bindSession(binding, entry[1][idx], '', options);
  }
  const items = projectSessions(binding, options);
  let hits = items.filter((it) => pyStr(pyOr(dget(it, 'title'), '')).includes(want));
  if (!hits.length) {
    hits = items.filter((it) => pyStr(pyOr(dget(it, 'sid'), '')).startsWith(want));
  }
  if (hits.length === 1) {
    return bindSession(binding, hits[0].sid, pyOr(dget(hits[0], 'title'), ''), options);
  }
  if (hits.length > 1) {
    const body = hits.slice(0, 8)
      .map((it) => `· ${sessionName(it)}（${pySlice(pyStr(it.sid), 12)}）`).join('\n');
    return fmtS2(SESSION_MULTI_FMT, want, body);
  }
  return fmtS(SESSION_MISS_FMT, want);
}

/** 「解绑会话」（`feishu_conv.py:665-673`）：只清当前会话绑定（默认项目原样保留） */
function leaveSession(binding, options = {}) {
  const d = deps(options);
  const sid = pyStrStrip(pyStr(pyOr(bindingValue(binding, 'cur_sid', ''), '')));
  if (!pyTruthy(sid)) return '当前未绑定会话';
  const project = defaultProject(binding, options);
  const name = project !== null ? project.name : '未设置';
  d.db.clearFeishuCurSession(requireKey(binding, 'open_id'), options);
  return `已解绑当前会话（默认项目保持为「${name}」），下次发消息将自动新建`;
}

// ==========================================================================
// 建会话 / 当前回执 / 新建会话（`feishu_conv.py:58-88` / `:772-814`）
// ==========================================================================

/**
 * 「当前」回执（`feishu_conv.py:58-74`）：默认项目 + 当前会话四要素（标题 / sid 前 12 位 /
 * 绑定时间 / 所属项目）；未绑定会话时明说「未绑定会话，发消息将自动新建」。
 */
function currentText(binding, options = {}) {
  const project = defaultProject(binding, options);
  const lines = [`默认项目：${project ? project.name : '未设置'}`];
  const sid = pyStrStrip(pyOr(requireKey(binding, 'cur_sid'), ''));
  if (!pyTruthy(sid)) {
    lines.push('当前会话：未绑定会话，发消息将自动新建');
    return lines.join('\n');
  }
  const title = pyStrStrip(pyOr(requireKey(binding, 'cur_title'), '')) || pySlice(sid, 12);
  lines.push(`当前会话：${title}（${pySlice(sid, 12)}）`);
  const boundAt = pyStrStrip(pyOr(requireKey(binding, 'cur_bound_at'), ''));
  if (pyTruthy(boundAt)) lines.push(`绑定时间：${boundAt}`);
  const owner = projectById(binding, requireKey(binding, 'cur_project_id'), options);
  lines.push(`所属项目：${owner ? owner.name : '（项目已不在你的列表）'}`);
  return lines.join('\n');
}

/** 投递前条目基线（`feishu_conv.py:809-814`）：回流按 `after=baseline` 只取本轮新增（异常回落 0） */
function baselineOf(sid, options = {}) {
  const d = deps(options);
  try {
    const data = d.sessparse.load('dsh', sid, 'main', 0);
    return pyIntStrict(pyOr(dget(data, 'total', 0), 0));
  } catch (e) {
    return 0;
  }
}

/**
 * 在项目目录下新建 dsh 会话并写「当前会话」绑定（`feishu_conv.py:772-806`）。
 * @returns {Promise<[string, string]>} `[sid, err]`，err 非空 = 失败（失败路径一律不写绑定）
 */
async function createInProject(binding, project, title, options = {}) {
  const d = deps(options);
  if (!pyTruthy(d.dshdriver.configured())) return ['', DRIVER_NEEDED];
  const finalTitle = pyStrStrip(pyOr(title, '')) || newTitle(options);
  // 项目级模型必须在**建会话时**下传：宿主 `/session` 不拆 `provider/id` 前缀，故先
  // `splitModel` 拆成 provider + 裸 id；只喂 applySessionDefaults 会漏（它仅在
  // reasoning_effort 非空时才调 set_model）⇒ 只配模型的项目会静默跑在宿主默认模型上。
  const [modelProvider, modelId] = d.dshdriver.splitModel(pyStr(pyOr(project.model, '')));
  let sid;
  try {
    sid = await d.dshdriver.createSession(project.project_dir, finalTitle, modelId, modelProvider);
  } catch (e) {
    trace(`新建会话失败 project=${project.id}: ${errorRepr(e)}`, options);
    return ['', `新建会话失败：${errText(e)}`];
  }
  try {
    await d.dshdriver.applySessionDefaults(
      sid, modelId, modelProvider,
      pyStrStrip(pyStr(pyOr(project.reasoning_effort, ''))),
      pyStrStrip(pyStr(pyOr(project.permission_mode, ''))),
      (text) => trace(text, options),
    );
  } catch (e) {
    trace(`会话默认值下发失败 sid=${sid}: ${errorRepr(e)}`, options);     // 只留痕，不阻断
  }
  try {
    await d.dshdriver.rename(sid, finalTitle);
  } catch (e) {
    trace(`会话改名失败 sid=${sid}: ${errorRepr(e)}`, options);           // 只留痕，不阻断
  }
  d.db.setFeishuCurSession(requireKey(binding, 'open_id'), project.id, sid, finalTitle, options);
  return [sid, ''];
}

/** 新建会话的缺省标题（`feishu_conv.py:913-915`）：本地时间 `飞书对话 %m-%d %H:%M`（零填充） */
function newTitle(options = {}) {
  const dt = new Date(deps(options).now() * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `飞书对话 ${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} `
    + `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/**
 * 「新建会话 [标题]」（`feishu_conv.py:77-88`）：默认项目下新建 dsh 会话并绑定，回执写明项目
 * 与看板副作用（新会话落在 `project_dir`，看板 `sync_sessions` 会自动建一张 sync 卡，不占运行位）。
 */
async function newSession(binding, title = '', options = {}) {
  const [project, err] = locateProject(binding, options);
  if (project === null) return err;
  const finalTitle = pyStrStrip(pyOr(title, '')) || newTitle(options);
  const [sid, createErr] = await createInProject(binding, project, finalTitle, options);
  if (pyTruthy(createErr)) return createErr;
  void sid;
  return `已新建并绑定「${finalTitle}」（项目：${project.name}），接下来发消息都进这个会话；`
    + '它也会出现在看板（sync 卡，不占运行位）';
}

// ==========================================================================
// 截图存盘（`feishu_conv.py:92-127`，2026-10-22 截图批次）
// ==========================================================================

/**
 * 截图落盘目录（`feishu_conv.py:92-100` 的 `_media_dir`）：
 * `<project.work_dir or <project.project_dir>/.touchstone>/board_media`——与
 * `server.py` 看板附件上传**同一表达式**，现有媒体端点与前端 `absToMedia` 才能直接识别。
 */
function mediaDirOf(project) {
  const base = project.work_dir || path.join(project.project_dir, '.touchstone');
  return path.join(base, 'board_media');
}

/**
 * 存图 + 组投递文案（`feishu_conv.py:103-127` 的 `_store_images`，契约 §3.5/§3.6）。
 *
 * 文件名 `fid = m<毫秒时间戳>_<10 位 hex>.<ext>`（与看板附件同款正则
 * `^m\d+_[0-9a-f]{10}\.[A-Za-z0-9]{1,10}$` ⇒ 现有媒体端点直接可用）；展示名
 * `飞书截图<序号>.<ext>`（序号 1 起）。文案：
 * ```
 * header = MEDIA_HEADER_FMT % len(images) + (MEDIA_HEADER_NOTE if not text else "")
 * block  = header + "：\n" + "\n".join("![飞书截图<k>.<ext>](/abs/path)")
 * composed = (text + "\n\n" + block) if text else block
 * ```
 * 常量表在 `feishu_inbound.js`（= Python `feishu.py` 的 `MEDIA_*`），这里**懒 import**
 * 取用：`feishu_conv → feishu_inbound` 的静态导入会与入站侧的回调互相牵连（本文件唯一
 * 保留的静态导入方向仍是「只向下」），而存图路径不在文字路径上 ⇒ 懒加载零成本。
 * 失败口径：Python 捕 `OSError`；Node 没有 OSError 类（fs 错误是带 `code` 的 `Error`）
 * ⇒ 这里捕 `mkdirSync`/`writeFileSync` 的全部异常，统一折成 `MEDIA_SAVE_FAIL_PREFIX+原因`。
 * @param {object} project 目标项目行（`work_dir`/`project_dir` 来自 db.project_view）
 * @param {string} text 原消息文字（可能为空串）
 * @param {object[]} images 元素 `{data: Buffer, mime: string}`
 * @returns {Promise<[string, string]>} `[composed, ""]` 成功 / `["", MEDIA_SAVE_FAIL_PREFIX+原因]`
 */
async function storeImages(project, text, images) {
  const media = await import('./feishu_inbound.js');
  const mdir = mediaDirOf(project);
  const lines = [];
  try {
    fs.mkdirSync(mdir, { recursive: true });
    for (let k = 1; k <= images.length; k += 1) {
      const img = images[k - 1] || {};
      const data = img.data || Buffer.alloc(0);
      const mime = pyStr(img.mime || 'application/octet-stream');
      const ext = Object.hasOwn(media.MEDIA_MIME_EXT, mime) ? media.MEDIA_MIME_EXT[mime] : 'bin';
      // Python `f"m{int(time.time() * 1000)}_{secrets.token_hex(5)}.{ext}"`
      const fid = `m${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${ext}`;
      const abs = path.join(mdir, fid);
      fs.writeFileSync(abs, data);
      lines.push(`![飞书截图${k}.${ext}](${abs})`);
    }
  } catch (e) {
    return ['', media.MEDIA_SAVE_FAIL_PREFIX + errText(e)];
  }
  const header = media.MEDIA_HEADER_FMT.replace('%d', pyStr(images.length))
    + (pyTruthy(text) ? '' : media.MEDIA_HEADER_NOTE);
  const block = `${header}：\n${lines.join('\n')}`;
  return [pyTruthy(text) ? `${text}\n\n${block}` : block, ''];
}

// ==========================================================================
// R3 主入口：单聊自由文本路由（`feishu_conv.py:91-148`）
// ==========================================================================

/**
 * 单聊自由文本路由（四分支）：有会话直投 → 无会话按默认项目自动新建 → 投递 → 引导。
 *
 * 0. **长度闸**：超 `chat.MESSAGE_MAX`（与站点 `POST …/messages` 同一常量）⇒ 直接回中文回执
 *    并给两条出路（改发文件/附件、或拆成几条），**什么都不提交**（最先 return，不读库、不建会话）；
 * 1. 有 `cur_sid` 且项目仍归本人、会话仍存在 ⇒ 直接投递；失效（会话被删/归档清理/项目易主）
 *    ⇒ 自动解绑 + 留痕提示，再按「无会话」处理；
 * 2. 无会话 ⇒ 默认项目（回落到用户唯一项目）下自动新建并绑定，再投递；
 * 3. 投递走 `chat.submit`（统一队列 `m:` 行），`extraMeta` 带 `baseline` 供答复回流只取本轮新增；
 * 4. 无默认项目（多项目未指定 / 无项目）⇒ 回引导文案 + **项目总览卡**（点选即设默认）。
 *
 * ⚠**`note` 两处拼接形态不同**：`:125` 用 `"\n" + note`、`:148` 用 `+ note` 直贴——照抄，别「统一」。
 *
 * 截图支持（2026-10-22，`feishu_conv.py:128-135`）：第 5 参 `images` 非空表示本次消息带图
 * （元素 `{data: Buffer, mime: string}`），在**目标项目解析成功之后**（无项目仍回引导、
 * 不落盘）存进该项目 `board_media/` 并按契约 §3.6 组 `composed`（原文字 + 空行 + header +
 * markdown 绝对路径）再投递；存盘失败回 `MEDIA_SAVE_FAIL_PREFIX+原因` 且**不投递**。
 * 既有文字路径（`images` 为 `null`/`[]`）一个字节不变。
 *
 * @param {object} binding `feishu_bindings` 行（四列指针）
 * @param {string} text 已剥 @ 且非空的文本（主流程保证；媒体路径可能为空串）
 * @param {object|null} cfg 应用凭据（可为假值 ⇒ 发送闸只留痕）
 * @param {object} [options] 依赖注入（见文件头差异 C）
 * @param {object[]|null} [images] 入站图片载荷（`{data, mime}`），追加在末位 ⇒ 既有调用点零改动
 * @returns {Promise<string>} 回飞书的文本（**唯一直接调用点**：`feishu_inbound.js` 的
 *   `handleMessageEvent`，条件「单聊 + 意图未识别 + 总开关开」）
 */
export async function routeText(binding, text, cfg = null, options = {}, images = null) {
  const d = deps(options);
  if (pyLen(pyOr(text, '')) > d.chat.MESSAGE_MAX) {
    return fmtD(MESSAGE_TOO_LONG, d.chat.MESSAGE_MAX);
  }
  const openId = requireKey(binding, 'open_id');
  let note = '';
  let sid = pyStrStrip(pyOr(requireKey(binding, 'cur_sid'), ''));
  let title = pyStrStrip(pyOr(requireKey(binding, 'cur_title'), ''));
  let project = null;
  if (pyTruthy(sid)) {
    project = projectById(binding, requireKey(binding, 'cur_project_id'), options);
    if (project === null || !pyTruthy(d.sessparse.session_exists('dsh', sid))) {
      d.db.clearFeishuCurSession(openId, options);
      sid = '';
      title = '';
      project = null;
      note = STALE_NOTE;
    }
  }
  if (!pyTruthy(sid)) {
    const located = locateProject(binding, options);
    project = located[0];
    // 设计 §3.4 分支 4：无项目时 projects_card 为 None，只回文案，绝不给一张空卡；
    // 卡片发送走凭据闸，缺凭据只留痕（返回值**故意丢弃**：这一档没有文本兜底）
    if (project === null) {
      const card = projectsCard(binding, options);
      if (card !== null) await sendCard(openId, card, cfg, options);
      return NO_DEFAULT_GUIDE + (pyTruthy(note) ? `\n${note}` : '');
    }
    title = newTitle(options);
    const created = await createInProject(binding, project, title, options);
    sid = created[0];
    if (pyTruthy(created[1])) return created[1] + (pyTruthy(note) ? `\n${note}` : '');
    // 创建路径内已写绑定；这里**重申**一次（幂等）：路由侧不依赖创建函数的副作用
    // ——「这条消息投到哪个会话」必须与库里的绑定指针一致（第二次写会刷新 cur_bound_at）
    d.db.setFeishuCurSession(openId, project.id, sid, title, options);
  }
  if (!pyTruthy(title)) title = pySlice(sid, 12);
  let composed = text;
  if (pyTruthy(images)) {
    // 目标项目已解析成功 ⇒ 才落盘（无项目分支在上面已返回，不产生孤儿文件）
    const stored = await storeImages(project, pyOr(text, ''), images);
    composed = stored[0];
    if (pyTruthy(stored[1])) return stored[1] + (pyTruthy(note) ? `\n${note}` : '');
  }
  const baseline = baselineOf(sid, options);
  let res;
  try {
    res = await d.chat.submit(project.id, sid, composed, {
      ...options,
      family: d.agents.agentFamily(project.agent_path),
      extraMeta: {
        feishu: {
          open_id: openId,
          user_id: requireKey(binding, 'user_id'),
          project_id: project.id,
          baseline,
          title,
        },
      },
    });
  } catch (e) {
    trace(`投递失败 sid=${sid}: ${errorRepr(e)}`, options);
    return `投递失败：${errText(e)}` + (pyTruthy(note) ? `\n${note}` : '');
  }
  if (pyTruthy(images)) {
    // 真机核对日志（契约 §3.2）：投递成功才打，sid/project 只在此层可知（stderr）
    d.log(`[feishu] 截图 ${images.length} 张已存 board_media 并投递 sid=${sid}`
      + `（project=${project.id}）`);
  }
  const state = pyTruthy(res.queued) ? '排队中' : '执行中';
  return `已投递到「${title}」（${state}），跑完把答复发回这里` + note;
}

// ==========================================================================
// 指令执行器（`feishu_conv.py:151-184`）
// ==========================================================================

/**
 * 六条新指令的执行器（`feishu.execute_intent` 分派进来）。
 *
 * `current`/`new`/`use`/`leave` 回文本；`projects`/`sessions` 发对应卡片（**卡片即回执**，
 * 返回空串 ⇒ 调用方不另发文本；卡片没被受理才走文本兜底）；未知动作兜底回帮助（不静默、不留白）。
 * `senderOpenId` 未用（形参只为对齐 `feishu.execute_intent` 的调用形状）。
 *
 * @returns {Promise<string>} 回复文案（**空串 = 不回复**）
 */
export async function convIntent(binding, action, groups, senderOpenId, cfg = null, options = {}) {
  const g = pyOr(groups, []);
  if (action === 'current') return currentText(binding, options);
  if (action === 'projects') {
    const card = projectsCard(binding, options);
    if (card === null) return NO_PROJECTS_GUIDE;
    if (!await sendCard(requireKey(binding, 'open_id'), card, cfg, options)) {
      return projectsText(binding, options);      // 卡片没被受理 ⇒ 文本兜底，绝不静默
    }
    return '';      // 卡片即回执，不另发文本（execute_intent 见空串不发）
  }
  if (action === 'sessions') {
    const card = sessionsCard(binding, options);
    if (card === null) return NO_DEFAULT_GUIDE;
    if (!await sendCard(requireKey(binding, 'open_id'), card, cfg, options)) {
      return sessionsText(binding, options);      // 同上：卡片没被受理 ⇒ 文本兜底
    }
    return '';
  }
  if (action === 'new') {
    const first = g.length ? g[0] : null;
    return newSession(binding, pyStrStrip(pyOr(first, '')), options);
  }
  if (action === 'use') return useByToken(binding, g.length ? g[0] : '', options);
  if (action === 'leave') return leaveSession(binding, options);
  // 未知动作兜底回帮助（生产路径不可达：`execute_intent` 的 action 白名单硬编码六条）。
  // `HELP_TEXT` 在 `feishu_inbound.js`（R2）；懒 import 躲开
  // `feishu_conv → feishu_inbound → feishu → feishu_conv` 的静态环。
  const inbound = await import('./feishu_inbound.js');
  void senderOpenId;
  return inbound.HELP_TEXT;
}

// ==========================================================================
// 答复回流（`feishu_conv.py:817-915`）
// ==========================================================================

/**
 * 注册消息终态钩子（`feishu.start_notifier` 调用；幂等）。
 *
 * 钩子是**单一注册位**（`chat.setMsgDoneHook` 后注册覆盖先注册），重复调用等价于再注册一次
 * ——无副作用、不叠加。**这是本模块唯一的接线点，漏掉则回流全哑且无任何报错**
 * （`feishu.py:2669-2670` 原话）：必须在端口绑定之前、且早于投递线程。
 *
 * Node 差异：注册的是**绑定了本次 `options` 的闭包**（oracle 注册的是模块函数、靠模块全局取
 * 依赖）——`chat.fireMsgDone` 只传 `(msgId, state)`，没有 options 位，故依赖必须在注册时定格。
 * @returns {void}
 */
export function start(options = {}) {
  const chat = deps(options).chat;
  chat.setMsgDoneHook((msgId, state) => notifyMsgDone(msgId, state, options));
}

/**
 * 消息单元终态 → 把本轮答复推回飞书（`feishu_conv.py:835-866`；非飞书来源直接返回）。
 *
 * state 三态：`yielded`＝turn 挂起等作答，**不推**（作答链路自己会回卡/回执）；`error`＝推失败
 * 回执（带 `chat_msgs.error` 摘要）；`done`＝抽 baseline 之后的新增 assistant 文本推出。
 * 任何异常都不外抛（钩子是旁路）——Python 侧靠 `chat._fire_msg_done` 的 except 兜，
 * Node 侧 `chat.fireMsgDone` 同样兜同步抛与 thenable 拒绝（本函数是 async）。
 */
export async function notifyMsgDone(msgId, state, options = {}) {
  const d = deps(options);
  const meta = pyOr(dget(pyOr(d.waitq.msgMeta(msgId, options), {}), 'feishu'), {});
  if (!pyTruthy(meta)) return;
  const openId = pyOr(dget(meta, 'open_id'), '');
  if (!pyTruthy(openId)) return;
  if (!bindingCurrent(openId, dget(meta, 'user_id'), options)) {
    trace(`答复跳过（绑定已变更）open_id=${pySlice(pyStr(openId), 12)}`, options);
    return;
  }
  if (state === 'yielded') {
    // **stdout**（不是 _trace 的 stderr！），前缀带方括号
    console.log(`[feishu_conv] 会话挂起等作答，不推答复：${msgId}`);
    return;
  }
  if (state === 'error') {
    const row = d.waitq.msgGet(msgId, options);
    const err = pySlice(pyOr(row !== null && row !== undefined ? row.error : '', ''), 200);
    await dm(openId, `本轮执行失败：${pyOr(err, '未知原因')}（可在站点会话窗查看详情）`,
      null, dget(meta, 'user_id'), options);
    return;
  }
  const row = d.waitq.msgGet(msgId, options);
  const sid = pyOr(row !== null && row !== undefined ? row.sid : '', '');
  const reply = clipReply(replyOf(sid, pyIntStrict(pyOr(dget(meta, 'baseline'), 0)), options));
  if (pyTruthy(reply)) await dm(openId, reply, null, dget(meta, 'user_id'), options);
}

/**
 * 推送前的绑定归属复核（`feishu_conv.py:869-884`）：open_id 当前仍有绑定行、且其 `user_id`
 * 与载荷一致。载荷里的 `open_id` 是**提交那一刻**定格的；用户提交后可能解绑或改绑他人——
 * 答复含会话正文，只能送给提交者本人。库读写异常一律按「复核不过」处理：宁可不推，绝不误推。
 */
function bindingCurrent(openId, userId, options = {}) {
  const d = deps(options);
  let row;
  try {
    row = d.db.getFeishuBindingByOpen(openId, options);
  } catch (e) {
    trace(`绑定复核失败 open_id=${pySlice(pyStr(openId), 12)}: ${errorRepr(e)}`, options);
    return false;
  }
  if (row === null || row === undefined) return false;
  return pyStr(row.user_id) === pyStr(userId);
}

/**
 * 取该会话 `baseline` 之后的新增 assistant 文本（`feishu_conv.py:887-902`）。
 * 只拼 assistant（think 是草稿、tool_* 是过程，都不是给用户的答复）；双换行连接、纯空白片段
 * 丢弃；异常返回空串。
 */
function replyOf(sid, baseline, options = {}) {
  const d = deps(options);
  let data;
  try {
    data = d.sessparse.load('dsh', sid, 'main', baseline);
  } catch (e) {
    return '';
  }
  if (!pyTruthy(dget(data, 'found'))) return '';
  const parts = pyOr(dget(data, 'entries'), [])
    .filter((e) => dget(e, 'kind') === 'assistant')
    .map((e) => pyOr(dget(e, 'text'), ''));
  return parts.filter((p) => pyTruthy(pyStrStrip(pyStr(p)))).join('\n\n');
}

/** 答复截断（`feishu_conv.py:905-910`）：超 `REPLY_MAX_CHARS` 保留首段并附站点指引（码点口径） */
function clipReply(text) {
  const value = pyStrStrip(pyOr(text, ''));
  if (pyLen(value) <= REPLY_MAX_CHARS) return value;
  return pySlice(value, REPLY_MAX_CHARS - 200)
    + '\n……（内容过长已截断，完整内容见站点会话窗 / 看板）';
}

// ==========================================================================
// 导出面：冻结接口 7 个（R2 的 `d.conv.*` 调用点）+ 常量 + 用例读口
// ==========================================================================

// `feishu_inbound.js` 的惰性转发器按这 7 个名字取（名字/位置参数签错一位就断链）：
//   enabled(options) / routeText(binding, text, cfg, options[, images]) /
//   convIntent(binding, action, groups, senderOpenId, cfg, options) /
//   onCardAction(sender, binding, value, action, cfg, options) /
//   setDefaultProject(binding, project, options) / projectById(binding, projectId, options) /
//   start(options)   —— 全部可 async，调用方都 await。
// 2026-10-22 截图批次：`routeText` 末位追加第 5 参 `images`（既有调用点零改动）。

/** 用例/诊断读口（Python 私有名 → Node `_` 前缀别名，与 R2 的 `_parse_intent` 同风格） */
export const _card = makeCard;
export const _card_bytes = cardBytes;
export const _projects_card = projectsCard;
export const _projects_elements = projectsElements;
export const _projects_text = projectsText;
export const _sessions_card = sessionsCard;
export const _sessions_text = sessionsText;
export const _session_row = sessionRow;
export const _session_name = sessionName;
export const _rel_time = relTime;
export const _session_busy = sessionBusy;
export const _counts_line = countsLine;
export const _board_counts = boardCounts;
export const _remember_list = rememberList;
export const _project_sessions = projectSessions;
export const _session_project = sessionProject;
export const _bind_session = bindSession;
export const _use_by_token = useByToken;
export const _leave_session = leaveSession;
export const _locate_project = locateProject;
export const _default_project = defaultProject;
export const _projects_of = projectsOf;
export const _create_in_project = createInProject;
export const _baseline_of = baselineOf;
export const _clip_name = clipName;
export const _clip_reply = clipReply;
export const _reply_of = replyOf;
export const _binding_value = bindingValue;
export const _has_creds = hasCreds;
export const _selected_project_id = selectedProjectId;
export const _selected_session = selectedSession;
export const _send_card = sendCard;
export const _dm = dm;
export const _new_title = newTitle;
export const _trace = trace;
export const _notify_msg_done = notifyMsgDone;
export const _new_session = newSession;
export const _current_text = currentText;
