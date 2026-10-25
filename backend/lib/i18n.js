/**
 * 后端 i18n 运行时（Node）——与 `backend_py/i18n.py` 同算法、同词典、同期望表。
 *
 * 口径（与前端 `webui/src/utils/i18n.js` 保持一致，只是多了 ns 维度与请求语言解析）：
 *   - 中文原文即 key：`zh` 直接对 key 插值返回，不查词典；
 *   - `en` 查 `<repo>/i18n/en.json` 的 `dict[ns][key]`；值是 string 直接用，是对象则按
 *     `Number(vars.n) === 1` 取 one，否则 other（只有 one/other 两档，不引入 ICU）；
 *   - 缺失 key / 缺失 ns / 词条类型非法一律回落插值后的中文 key，`t` 永不抛错；
 *   - 插值占位符为 `{name}`（仅标识符形状）；变量缺失或为 null 时保留占位符原样；
 *   - 语言解析 `resolveLang` 优先级：`X-TS-Lang` 头 → `?lang=` → `userPref` → `'zh'`，
 *     非法值跳过继续下一档；头名大小写不敏感，值接受 `zh|en` 及其大小写/地区变体
 *     （`ZH`、`zh-CN`、`zh_CN`、`en-US`… 均归一为 `zh`/`en`）；
 *   - 无任何语言信号时默认 `zh`（存量行为零变化：老客户端不带 `X-TS-Lang` 仍是中文）；
 *   - `TS_I18N=0` 是回滚开关：`t`/`resolveLang` 恒中文（`normalizeLang` 是纯函数不受影响）；
 *   - 词典文件只在首次用到时读一次并缓存；读不到/JSON 损坏时 warning 一次后降级为仅中文。
 *
 * 本文件只提供运行时，不含任何调用点（T10/T11/T12/T14 分别消费 api/prompt 词条）。
 * 零新依赖：只用 node:fs / node:path / node:url。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根定位：本文件在 <repo>/backend/lib/ 下，上溯两级（与 backend/lib/prompts.js 同一锚点风格）
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..');
// 词典唯一真源：<repo>/i18n/en.json（web/api/prompt 三个命名空间；Node 与 Python 同读一份）
const DICT_PATH = path.join(REPO_ROOT, 'i18n', 'en.json');

// 插值占位符：{name}，name 仅限标识符形状（其余大括号原样保留；\w 默认 ASCII，与 Python re.ASCII 对齐）
const PLACEHOLDER = /\{([A-Za-z_][\w]*)\}/g;
// 空词典哨兵：加载失败后缓存它，保证后续调用不再反复读盘/告警，同时恒走中文
const EMPTY_DICT = Object.freeze({});

// 词典缓存：null = 尚未读取；对象 = 已读取（失败时也写入 EMPTY_DICT）
let dictCache = null;
// 告警去重标记：一个进程只 warning 一次（resetCache 供测试重放）
let warned = false;

/**
 * 回滚开关：`TS_I18N=0` 时返回 true（t/resolveLang 恒中文）。
 * 每次调用都读环境变量，便于测试与运维在不重启进程时切换。
 */
function _isDisabled() {
  const raw = process.env.TS_I18N;
  return typeof raw === 'string' && raw.trim() === '0';
}

/**
 * 回滚开关的只读视图（供「先判开关、再决定是否读库」的调用方使用）。
 * `routes/index.js:requestLang` 用它跳过 `TS_I18N=0` 时的用户偏好查询。
 * @returns {boolean}
 */
export function isI18nDisabled() {
  return _isDisabled();
}

/**
 * 安全的自有属性判断：避免 `constructor`/原型链上的键被误当成词条。
 */
function _own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 把插值变量转成字符串（与 Python `_stringify` 同一口径）：
 *   - string 原样；boolean → "true"/"false"；
 *   - number → JS 原生最短 round-trip 表示（`1.0` → "1"、`1e21` → "1e+21"、
 *     NaN/Infinity/-Infinity 天然就是 "NaN"/"Infinity"/"-Infinity"）；
 *   - undefined/null 与其余类型（数组/对象/函数/异常/Proxy）→ 保留占位符（绝不 String(对象)）。
 * 本函数只做类型判断，不主动调用对象的 toString/valueOf，因此不会触发副作用。
 */
function _stringify(value, placeholder) {
  if (value === undefined || value === null) return placeholder;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return placeholder;
  }
}

/**
 * 插值 `{name}`：变量缺失/null/undefined/对象等一律保留占位符原样，绝不抛错。
 * 逐个变量 try/catch：Proxy 的 get 陷阱、getter 抛错都只影响当前占位符。
 */
function _interpolate(text, vars) {
  if (typeof text !== 'string') return '';
  try {
    return text.replace(PLACEHOLDER, (match, name) => {
      try {
        if (vars === null || typeof vars !== 'object' || !_own(vars, name)) return match;
        return _stringify(vars[name], match);
      } catch {
        return match;
      }
    });
  } catch {
    // 理论上不可达：replace 本身异常时退回原文，保证 t() 永不抛错
    return text;
  }
}

/**
 * 十进制字面量：两端共用的复数 n 解析口径。
 * 只认十进制，避免 JS `Number('0x10') === 16` 与 Python `float('0x10')` 抛错这类分叉；
 * `''`/`'abc'`/布尔/数组/对象/null/undefined 一律视为非法（→ other）。
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 复数 n 归一（与 Python `_to_plural_number` 同一口径）：
 * number 原样；string 去首尾空白后按十进制解析；其余类型一律 NaN（非法 → other）。
 */
function _toPluralNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || !DECIMAL_RE.test(text)) return NaN;
    return Number(text);
  }
  return NaN;
}

/**
 * 从复数词条取文案：n 恰好等于 1 取 one，否则 other（含非法/缺失）；
 * 首选缺失时回退另一档，两档都不是字符串则返回 undefined（由调用方回落中文 key）。
 */
function _pluralText(entry, vars) {
  let n = NaN;
  try {
    n = vars !== null && typeof vars === 'object' ? _toPluralNumber(vars.n) : NaN;
  } catch {
    n = NaN;
  }
  const one = n === 1;
  const primary = one ? entry.one : entry.other;
  const fallback = one ? entry.other : entry.one;
  if (typeof primary === 'string') return primary;
  if (typeof fallback === 'string') return fallback;
  return undefined;
}

/**
 * 词典加载失败时告警一次（带目标路径与原因），后续失败静默。
 */
function _warnOnce(target, err) {
  if (warned) return;
  warned = true;
  const detail = err && err.message ? err.message : String(err);
  console.warn(`[i18n] 词典加载失败，已降级为仅中文: ${target}: ${detail}`);
}

/**
 * 读取并缓存词典。
 *
 * @param {string=} dictPath 测试钩子：显式路径（缺省读 <repo>/i18n/en.json）。
 *   显式传参会绕过「已缓存」短路，便于单测换词典；不传时进程内只读一次。
 * @returns {object} 词典对象；读取/解析失败返回空对象（并已警告一次）。
 */
export function loadDict(dictPath) {
  if (dictPath === undefined && dictCache !== null) return dictCache;
  const target = dictPath === undefined ? DICT_PATH : dictPath;
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('词典根节点必须是对象');
    }
    dictCache = parsed;
  } catch (err) {
    _warnOnce(target, err);
    dictCache = EMPTY_DICT;
  }
  return dictCache;
}

/**
 * 清空词典缓存与告警标记（测试钩子；生产无需调用）。
 */
export function resetCache() {
  dictCache = null;
  warned = false;
}

/**
 * 语言归一：接受大小写/地区变体（`ZH`、`zh-CN`、`zh_CN`、`en-US`…），返回 `zh`/`en`；
 * 其余（含非字符串）返回 null。纯函数，不受 `TS_I18N` 影响。
 */
export function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(/[-_]/, 1)[0];
  return base === 'zh' || base === 'en' ? base : null;
}

/**
 * 取头值：兼容普通对象、Headers/Map（按 entries 大小写不敏感遍历）与数组值。
 * 注意 Map.get 区分大小写，所以不能只靠 get：先 entries 遍历，再 get，最后普通对象键。
 */
function _headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return undefined;
  const lowered = name.toLowerCase();
  if (typeof headers.entries === 'function') {
    try {
      for (const [key, value] of headers.entries()) {
        if (typeof key === 'string' && key.toLowerCase() === lowered) return value;
      }
    } catch {
      // 非标准 entries：继续按 get/普通对象键匹配
    }
  }
  if (typeof headers.get === 'function') {
    try {
      const value = headers.get(name);
      if (value !== undefined && value !== null) return value;
    } catch {
      // 非标准 get：继续按普通对象键匹配
    }
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) return headers[key];
  }
  return undefined;
}

/**
 * 取查询参数 `lang`：接受 URLSearchParams、字符串（`lang=en` / `?lang=en`）或普通对象。
 */
function _queryValue(query) {
  if (query === null || query === undefined) return undefined;
  if (typeof query === 'string') {
    const raw = query.startsWith('?') ? query.slice(1) : query;
    try {
      const value = new URLSearchParams(raw).get('lang');
      return value === null ? undefined : value;
    } catch {
      return undefined;
    }
  }
  if (typeof query.get === 'function') {
    try {
      const value = query.get('lang');
      if (value !== undefined && value !== null) return value;
    } catch {
      // 非标准 get：继续按普通对象键匹配
    }
  }
  if (typeof query === 'object' && _own(query, 'lang')) return query.lang;
  return undefined;
}

/**
 * 把候选值归一为语言：支持数组（取首项）、`{v: 'en'}`（账号偏好持久化形状）与裸字符串。
 */
function _coerceLang(value) {
  let candidate = Array.isArray(value) ? (value.length > 0 ? value[0] : null) : value;
  if (candidate !== null && typeof candidate === 'object' && _own(candidate, 'v')) {
    candidate = candidate.v;
  }
  return normalizeLang(candidate);
}

/**
 * 解析**显式**语言信号：`X-TS-Lang` 头 → `?lang=`；两档都没有合法值时返回 `null`。
 *
 * 为什么要与 userPref 拆开（T10 审查 Minor 3）：`routes/index.js:requestLang` 只有在
 * 头和 query 都缺席时才需要读库里的用户偏好。`resolveLang` 无法表达「没信号」（它把
 * 缺省折叠成 `'zh'`，与显式 `zh` 不可区分），所以单独暴露本函数供「先判信号、再决定
 * 是否读库」的调用方使用。`TS_I18N=0` 时返回 `null`（回滚开关下连偏好都不读）。
 *
 * 非法值跳过并继续下一档；任何畸形入参都回落 `null`（绝不抛错）。
 *
 * @param {{headers?: object, query?: URLSearchParams|string|object|null}=} opts
 * @returns {'zh'|'en'|null}
 */
export function resolveLangSignal(opts = {}) {
  if (_isDisabled()) return null;
  try {
    const source = opts !== null && typeof opts === 'object' ? opts : {};
    const headers = source.headers === undefined ? {} : source.headers;
    for (const raw of [_headerValue(headers, 'X-TS-Lang'), _queryValue(source.query)]) {
      const lang = _coerceLang(raw);
      if (lang !== null) return lang;
    }
  } catch {
    // 任何畸形入参（getter 抛错等）都按「无显式信号」处理
  }
  return null;
}

/**
 * 解析请求语言：`X-TS-Lang` 头 → `?lang=` → `userPref` → `'zh'`。
 * 非法值跳过并继续下一档；`TS_I18N=0` 时直接返回 `'zh'`；任何畸形入参都回落 `'zh'`。
 *
 * @param {{headers?: object, query?: URLSearchParams|string|object|null,
 *          userPref?: string|{v:string}|null}=} opts
 * @returns {'zh'|'en'}
 */
export function resolveLang(opts = {}) {
  if (_isDisabled()) return 'zh';
  const signal = resolveLangSignal(opts);
  if (signal !== null) return signal;
  try {
    const source = opts !== null && typeof opts === 'object' ? opts : {};
    const pref = _coerceLang(source.userPref);
    if (pref !== null) return pref;
  } catch {
    // 偏好 getter 抛错等：按缺省中文处理
  }
  return 'zh';
}

/**
 * 从任务/卡片行取 `lang` 原始值：缺失/非字符串 → `''`（读侧归一 zh）。
 * @param {object|null|undefined} row
 * @returns {string}
 */
function rowLang(row) {
  if (row === null || row === undefined) return '';
  let value;
  try {
    value = row.lang;
  } catch {
    return '';                       // getter 抛错：按「没有语言」处理
  }
  return typeof value === 'string' ? value : '';
}

/**
 * 任务语言（读侧规范化）：仅当 `lang` 去空白小写后恰好是 `en` 时返回 `'en'`，
 * 其余（`zh`/空串/缺失/未知值如 `en-US`）一律 `'zh'`。
 *
 * 与 `backend_py/i18n.py:task_lang` 逐字对应——**payload / prompts / runner 继承
 * 共用这一处口径**，不要在调用点各写一份判断。
 * @param {object|null|undefined} task
 * @returns {'zh'|'en'}
 */
export function taskLang(task) {
  return rowLang(task).trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

/**
 * 看板卡语言（读侧规范化）：语义与 `taskLang` 完全一致（同一 `lang` 列口径）。
 * @param {object|null|undefined} card
 * @returns {'zh'|'en'}
 */
export function cardLang(card) {
  return rowLang(card).trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

/**
 * 「词条 key + vars」的**普通返回值**载体（T10 R18 裁决的 lib 错误本地化契约）。
 *
 * 用途：`backend/lib/*` 里有些用户可见错误不是抛异常而是**返回字符串**（如
 * `answer_interaction` 的 `str|None`、`[null, {error}]` 元组）。带插值的文案不能先渲染
 * 再交给 `ctx.error*`（渲染后的 key 查不到词条），所以用本函数返回 `{message, vars}`：
 *   - `message` 是中文词条 key（可含 `{name}` 占位符，**不预渲染**）；
 *   - `vars` 是插值变量（无变量传 null）。
 * 路由层把该对象原样交给 `ctx.error(status, value)` / `ctx.errorSpaced(status, value)`
 * 即可按请求语言渲染；中文侧插值结果与旧文案逐字节相同。固定文案不需要它（字符串本身
 * 就是词条 key），保持原有字符串返回形态即可。
 *
 * @param {string} message 中文词条 key（`{name}` 占位符原样保留）
 * @param {object|null=} vars 插值变量
 * @returns {{message: string, vars: object|null}}
 */
export function messageVars(message, vars = null) {
  return { message, vars: vars === null || vars === undefined ? null : vars };
}

/**
 * 给**抛出的错误对象**附加本地化载荷（key+vars 契约的错误侧）。
 *
 * 与 `messageVars` 的区别：抛错路径的 `.message` 已被日志/`last_error` 等既有消费方
 * 使用，不能改成未渲染的 `{占位符}` key，否则日志口径会漂移。故本函数只附加两个字段：
 *   - `error.i18nKey`：中文词条 key（可含 `{name}`）；
 *   - `error.i18nVars`：插值变量（无变量为 null）。
 * `ctx.error*` 收到该错误对象时按 `i18nKey` 本地化；不经过响应层的日志仍用 `.message`
 * 的渲染后中文，保持原样。固定文案的错误（`.message` 本身就是词条 key）无需调用本函数。
 *
 * @template {Error} T
 * @param {T} error 错误对象（原样返回，便于 `throw localizable(new XxxError(...), ...)`）
 * @param {string} message 中文词条 key（`{name}` 占位符原样保留）
 * @param {object|null=} vars 插值变量
 * @returns {T}
 */
export function localizable(error, message, vars = null) {
  if (error !== null && typeof error === 'object') {
    error.i18nKey = message;
    error.i18nVars = vars === null || vars === undefined ? null : vars;
  }
  return error;
}

/**
 * 取文案：`zh`（或任何非法/缺省语言）返回插值后的中文 key；`en` 查 `dict[ns][key]`，
 * 缺失/类型非法回落插值后的中文 key。`TS_I18N=0` 恒中文。本函数永不抛错。
 *
 * @param {'web'|'api'|'prompt'|string} ns 命名空间
 * @param {string} key 中文原文（即词典 key）
 * @param {'zh'|'en'|string=} lang 语言（缺省 `zh`；接受大小写/地区变体）
 * @param {object=} vars 插值变量（如 `{n: 2, name: 'Ada'}`）
 * @returns {string}
 */
export function t(ns, key, lang = 'zh', vars) {
  let text;
  try {
    text = typeof key === 'string' ? key : String(key);
  } catch {
    text = '';
  }
  try {
    if (_isDisabled() || normalizeLang(lang) !== 'en') return _interpolate(text, vars);
    const table = loadDict();
    let entry;
    try {
      const bucket = _own(table, ns) ? table[ns] : undefined;
      entry = bucket !== null && typeof bucket === 'object' && !Array.isArray(bucket) &&
        _own(bucket, text) ? bucket[text] : undefined;
    } catch {
      entry = undefined;
    }
    if (typeof entry === 'string') return _interpolate(entry, vars);
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const plural = _pluralText(entry, vars);
      if (typeof plural === 'string') return _interpolate(plural, vars);
    }
  } catch {
    // 词典/插值出现任何意外都回落到中文 key（后端错误路径不能因 i18n 再抛错）
  }
  try {
    return _interpolate(text, vars);
  } catch {
    // 最终兜底也必须在 try/catch 内：任何情况下 t() 都返回字符串而不抛错
    return '';
  }
}
