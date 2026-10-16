/**
 * Python `json.dumps(obj, ensure_ascii=False)` 的 Node 对应物（M1，2026-10-11）。
 *
 * 为什么需要它：两版后端**开同一个库**，JSON 列的原始文本也是「数据」的一部分。Python 侧一律
 * `json.dumps(..., ensure_ascii=False)`（indent=None 时的默认分隔符 `", "` / `": "`），若 Node 侧
 * 用 `JSON.stringify`（紧凑 `,` / `:`），同一份逻辑数据的落库文本就会不同 —— 对拍里表现为
 * 「值一样、文本不一样」，只能靠白名单遮住，等于永久放弃这几列的逐字节可比性。
 * 本模块把这层口径补齐。首个使用点：`db.js` 的 `feishu_appsettings_bridge`（写
 * `feishu_user_cfgs.json`）；M3+ 的 `board_settings.json` / `user_prefs.value` /
 * `app_settings.json` / `wait_items.meta` / `tasks.payload` 等 JSON 写入点复用同一入口。
 *
 * 逐字符对齐 CPython 的部分（有测试向量钉住）：
 *   - 分隔符 `", "` 与 `": "`；空容器为 `{}` / `[]`；
 *   - 非 ASCII 原样输出（ensure_ascii=False）：中文、emoji 都不转义，也不拆代理对；
 *   - 转义集合与 CPython 相同：`"` `\` `\b` `\f` `\n` `\r` `\t`，其余 < U+0020 走 `\u00xx`
 *     （小写 hex）；DEL(U+007F)、U+2028/U+2029、`/`、`'` **不**转义（与 CPython 一致）；
 *   - `true` / `false` / `null`；数组；对象（键保持插入序，等价于 dict 保序）；
 *   - 整数（含负零以外的负数、0）：十进制原文逐字符相同（超过 2^53 请传 BigInt，见下）。
 *
 * **浮点的残余偏差（已知、原理上不可消除；如实记录，别当 bug 修）**：
 *   - Python 区分 int 与 float：`json.dumps({"x": 1.0})` → `{"x": 1.0}`，而 JS 的 `1.0` 就是 `1`，
 *     类型信息在 `JSON.parse` 时就丢了 ⇒ 本实现输出 `{"x": 1}`。**无法对齐**（信息不存在）；
 *   - 指数记法阈值不同：CPython repr 在 exp < -4 或 exp >= 16 时切指数，JS 在 exp < -7 或
 *     exp >= 21 时切 ⇒ `1e-05`(Py) vs `0.00001`(JS)、`1e+16`(Py) vs `10000000000000000`(JS)；
 *   - **指数补零**（2026-10-11 评审补记，与阈值无关的另一类）：两侧都落指数记法时，CPython 的
 *     指数至少两位补零、JS 不补 ⇒ `1e-07`(Py) vs `1e-7`(JS)、`1e-08`(Py) vs `1e-8`(JS)；
 *   - **≥1e21 的普通 number**（2026-10-11 评审补记）：两侧都切指数但形态可能不同，且「普通 number
 *     到这个量级已丢精度」这个理由对 1e21 这种**可精确表示**的值并不成立——所以别指望「整数一律
 *     逐字符相同」覆盖它；该量级请传 BigInt 或字符串；
 *   - `-0.0`：Python → `-0.0`，JS `String(-0)` → `0`；
 *   - 尾数两侧都是「最短往返」表示，故 1.5 / 0.1 / 3.141592653589793 这类一致；
 *   - NaN/Infinity：CPython 默认 `allow_nan=True`，输出 `NaN` / `Infinity` / `-Infinity`
 *     （严格 JSON 非法），本实现同样输出这三个字面量。
 *   结论：JSON 列里若出现**整数值的浮点**、`<1e-4` 或 `≥1e16` 量级的浮点，对拍仍会看到文本差异
 *   —— 那属于上述固有偏差；字符串/整数/布尔/null/嵌套结构一律逐字节一致。
 *
 * JS 专有值的边界（一律抛 TypeError，绝不静默写坏数据）：
 *   - `undefined` / 函数 / symbol：Python 侧无对应物（「没有值」请显式传 null）；
 *   - Date / Map / Set / 类实例：CPython 只认 dict/list/str/int/float/bool/None，同类对象抛 TypeError；
 *     本模块只接受**普通对象**（含 null 原型对象，如 node:sqlite 返回的行）；
 *   - 超过 2^53 的整数请传 BigInt：输出十进制原文，与 Python 任意精度 int 逐字符相同
 *     （普通 number 到这个量级已经丢精度，属调用方问题）。
 */

/** 与 CPython `py_encode_basestring_ascii`/`escape` 相同的命名转义（其余 < U+0020 走 \u00xx） */
const STRING_ESCAPES = new Map([
  ['"', '\\"'],
  ['\\', '\\\\'],
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/**
 * 序列化成 CPython `json.dumps(obj, ensure_ascii=False)` 的默认形态。
 * @param {unknown} value 普通对象/数组/字符串/数字/布尔/null/BigInt（嵌套任意层）
 * @returns {string} JSON 文本
 * @throws {TypeError} 遇到 Python 侧不存在的类型（undefined/函数/symbol）或非普通对象（Date/Map/Set/类实例）
 */
export function pyJsonDumps(value) {
  return encodeValue(value);
}

/**
 * 序列化成 CPython `json.dumps(obj, ensure_ascii=False, indent=N)` 的形态（M6-2）。
 *
 * 与 `pyJsonDumps` 的差别只有**缩进与分隔符**（CPython 的规则：`indent` 非 None 时
 * `item_separator=','`、`key_separator=': '`，并在每个元素前换行 + 缩进 `indent*层`）：
 *   - 空容器仍是 `{}` / `[]`（CPython 对空容器不换行）；
 *   - 嵌套容器紧跟键值冒号后的同一行开始（`"a": {\n …`）；
 *   - 字符串/数字/布尔/null 的编码与无缩进版**共用同一段实现**（含 ensure_ascii=False、
 *     控制字符 `\u00xx`、浮点的已知偏差——见文件头）。
 *
 * 使用点：`export_cases.py:126`（`retest-candidates --json`）、`loadcase.py:547`、
 * `loadgen.py:618`（报告落盘的 `indent=1`）。
 *
 * @param {unknown} value
 * @param {number|string} indent 空格数（或自定义缩进串，照 CPython 允许字符串）
 * @returns {string}
 */
export function pyJsonDumpsIndent(value, indent = 1) {
  const pad = typeof indent === 'string' ? indent : ' '.repeat(Math.max(0, Number(indent) || 0));
  return encodeIndented(value, pad, 0);
}

/** 带层级的编码（缩进形态；其余规则与 `encodeValue` 逐条相同） */
function encodeIndented(value, pad, level) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return encodeNumber(value);
    case 'bigint':
      return value.toString();
    case 'string':
      return encodeString(value);
    case 'object': {
      const inner = pad.repeat(level + 1);
      const close = pad.repeat(level);
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const parts = value.map((item) => inner + encodeIndented(item, pad, level + 1));
        return `[\n${parts.join(',\n')}\n${close}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('pyJsonDumpsIndent: 只接受普通对象/数组'
          + '（Date、Map、Set、类实例在 Python 侧同样抛 TypeError）');
      }
      const keys = Object.keys(value);
      if (keys.length === 0) return '{}';
      const parts = keys.map((key) => inner + encodeString(key) + ': '
        + encodeIndented(value[key], pad, level + 1));
      return `{\n${parts.join(',\n')}\n${close}}`;
    }
    default:
      throw new TypeError(`pyJsonDumpsIndent: 不能序列化 ${typeof value}`
        + '（Python 侧同类对象抛 TypeError；缺值请显式传 null）');
  }
}

/**
 * 任意 JSON 值的编码分派。
 * @param {unknown} value
 * @returns {string}
 */
function encodeValue(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return encodeNumber(value);
    case 'bigint':
      return value.toString();
    case 'string':
      return encodeString(value);
    case 'object':
      return Array.isArray(value) ? encodeArray(value) : encodeObject(value);
    default:
      throw new TypeError(`pyJsonDumps: 不能序列化 ${typeof value}`
        + '（Python 侧同类对象抛 TypeError；缺值请显式传 null）');
  }
}

/**
 * 数字编码：NaN/±Infinity 用 Python 字面量，其余用 JS 最短往返表示（见文件头浮点偏差说明）。
 * @param {number} value
 * @returns {string}
 */
function encodeNumber(value) {
  if (Number.isNaN(value)) return 'NaN';          // CPython allow_nan=True
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return String(value);
}

/**
 * 字符串编码：按**码点**遍历（代理对不被拆开），转义集合与 CPython ensure_ascii=False 相同。
 * @param {string} value
 * @returns {string} 带引号的 JSON 字符串
 */
function encodeString(value) {
  let out = '"';
  for (const ch of value) {
    const escape = STRING_ESCAPES.get(ch);
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code < 0x20) {
      // 其余控制字符：\u00xx（小写 hex，与 CPython 一致）
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out + '"';
}

/**
 * 数组编码（元素间 `", "`）。稀疏数组的洞会走到 encodeValue(undefined) 并抛 TypeError。
 * @param {unknown[]} value
 * @returns {string}
 */
function encodeArray(value) {
  const parts = [];
  for (let i = 0; i < value.length; i += 1) parts.push(encodeValue(value[i]));
  return '[' + parts.join(', ') + ']';
}

/**
 * 对象编码（键保持插入序，`": "` 分隔，项间 `", "`）。
 * 只接受普通对象（Object.prototype 或 null 原型）：Date/Map/Set/类实例在 Python 侧同样不可序列化，
 * 与其静默写成 `{}` 不如在此抛错。
 * @param {object} value
 * @returns {string}
 */
function encodeObject(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('pyJsonDumps: 只接受普通对象/数组'
      + '（Date、Map、Set、类实例在 Python 侧同样抛 TypeError）');
  }
  const parts = [];
  for (const key of Object.keys(value)) {
    parts.push(encodeString(key) + ': ' + encodeValue(value[key]));
  }
  return '{' + parts.join(', ') + '}';
}
