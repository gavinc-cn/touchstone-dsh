/**
 * `builtin_assets.py`（808 行，仓库根）的 Node 对应物（M6-6 前置批次）。
 *
 * 平台内置资产的清单扫描与安装卸载（skill / dsh_plugin 两类）。HTTP 端点
 * （`GET /api/builtin-assets`、`POST /api/builtin-assets/<id>/(install|uninstall)`，
 * `server.py:1326`/`1085`）按 `AssetError.code` 分流（400/409/500），前端直接把
 * `message` 展示给用户，故**错误串逐字照抄**、四态口径逐行照搬。
 *
 * ── 导出名 ────────────────────────────────────────────────────────────────
 * 主名**照 Python 名**（`ext_dir`/`load_assets`/`asset_status`/`_safe_rel`/…），文件末尾
 * 再给一套**去掉下划线**的 camelCase 别名（`extDir`/`loadAssets`/`_safe_rel → safeRel`/…）。
 * 对拍器缺省把 `fn` 的 Python 名做 snake_case → camelCase 映射，而它的映射对下划线开头的
 * 名字给的是 `_safe_rel → SafeRel`，故用例对这些条显式写 `nodeFn`（与 `export_cases.json`
 * 对 `_norm` 的处理同形）。
 *
 * ── 与 Python 的形态差异（都在量具里显式对齐） ─────────────────────────────
 * ① **元组 → 数组**：`_find_canonical` 的 `(start, end)`、`_write_plugin_patch` /
 *    `_remove_plugin_patch` 的 `(action, patch_state)` 在 JS 侧就是数组（不用对象），
 *    值逐位严格比；探针的 `to_jsonable` 也把 tuple 转成 array，故**不需要** `shape` 适配。
 * ② **异常类**：`AssetError` 同名同形（`.message` / `.code`，缺省 400），故「两侧同抛」
 *    的对拍分支能比 `$kind`。`ValueError` / `UnicodeDecodeError` / `AttributeError` 三个
 *    只在「清单写坏 / 文件手改坏」时出现，也按 Python 类名建了同名 JS 类。
 * ③ **同步**：Python 全同步，本文件也全同步（无 Promise）。
 *
 * ── 读文件一律**严格 UTF-8**（与 Python `open(..., encoding="utf-8")` 同口径） ───
 * `fs.readFileSync(p, "utf8")` 会把非法字节**静默**换成 U+FFFD，而 Python 抛
 * `UnicodeDecodeError`。这不是小事：坏 patch 文件在 Python 侧直接报错；JS 侧若静默兜底，
 * 会把它判成 foreign/未注册，接下来的 `_atomic_write_bytes` 就会用一串 U+FFFD
 * **覆盖用户手写的配置**。故本文件所有读口都走 `decodeUtf8Strict`（`TextDecoder`
 * `fatal: true` + `ignoreBOM: true`——后者保证 BOM 与 Python 一样**留在文本里**，
 * 与 `lib.js` 的 `STRICT_UTF8` 同口径），并照文本模式做 **universal newlines**
 * 折行（`\r\n`/`\r` → `\n`，见 `toUniversalNewlines`）：CRLF 的 patch 文件在 Python 侧
 * 读出来是 LF、写回也是 LF，JS 若原样保留 `\r` 就会在标记块匹配与写回字节上分叉。
 *
 * ── 依赖 ─────────────────────────────────────────────────────────────────
 * `agents.js:SKILL_DIRS_BY_FAMILY`（skill 落点约定，照要求 import 不重写）与 `lib.js` 的
 * 六个 Python 语义小工具（`pyJoin`/`pySorted`/`pyStrip`/`pyIsAbs`/`realpathOrResolve`/
 * `PY_WS`）；其余 Python 语义（`bool`/`str`/`repr`/`dict.get`/`splitlines`/`rstrip`）在本
 * 文件内自足实现——`rag.js` 里有同名的私有实现，但它们没有导出，而为一个 `pyOr` 去 import
 * 整个 RAG 模块不划算。
 *
 * ── 已知的残余差异（原理性/未验；不要当 bug 修） ───────────────────────────
 *   - **整数值浮点**：`json.load` 的 `1.0` 与 `1` 在 JS 里都是 `1` ⇒ `repr` 从 `1.0`
 *     变 `1`（`plugin.config` 的标量、`id` 字段的 `!r` 文案会分叉）。与 `pyjson.js`
 *     文件头那条是同一类**不可消除**差异；夹具刻意避开整数值浮点。
 *   - **`repr(float)` 的指数档**：Python 在 `decpt > 16` 或 `< -4` 时切指数写法
 *     （`repr(1e16) == '1e+16'`），JS 的 `String(1e16)` 给 `'10000000000000000'`。
 *     量级 ≥1e16 或 <1e-4 的标量会分叉；`NaN`/`±Infinity` 已对齐（`nan`/`inf`/`-inf`）。
 *   - **`json.load` 的 `NaN`/`Infinity`**：CPython 默认接受，`JSON.parse` 不接受 ⇒
 *     含这两个字面量的清单 Python 能读、JS 判「解析失败」。夹具刻意避开。
 *   - **`UnicodeDecodeError` 的文案**：Python 带字节位置（`0xff in position 0`），
 *     `TextDecoder` 不带 ⇒ 本文件只对齐**类名**；文案不逐字。这条只在手改坏的文件上出现。
 *   - **无 `HOME` 的部署**：`os.path.expanduser` 退回 `pwd` 查库，JS 退回 `os.homedir()`。
 *   - **`os.path.realpath`**：用 `lib.js:realpathOrResolve`（真解析失败则 `resolve`），
 *     只在「不存在的路径且其已存在前缀里有符号链接」时分叉（`lib.js` 文件头同条）。
 *   - **`os.path.basename` 的尾斜杠**：Node 的 `path.basename('/a/b/')` 给 `'b'`、Python
 *     给 `''`。本模块的 `asset_dir` 都是 `readdir` 拼出来的，到不了这个形态。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILL_DIRS_BY_FAMILY } from './agents.js';
import { isI18nDisabled, localizable, normalizeLang, t } from './i18n.js';
import {
  PY_WS, isDir, isFile, pathExists, pyIsAbs, pyJoin, pySorted, pyStrip, realpathOrResolve,
} from './lib.js';

// --------------------------------------------------------------------------
// Python 语义小工具（真值 / str / repr / 文本行 / 严格 UTF-8）
// --------------------------------------------------------------------------

/**
 * Python `\s` 的展开形态取自 `lib.js:PY_WS`（`[ … ]` 形态）。
 *
 * `PY_SPACE`/`PY_STRIP_RE` 在 `lib.js` 里是模块私有的，只导出了包好方括号的 `PY_WS`；
 * 本文件还需要**反义类**（`\S`）与**只剥右侧**（`rstrip`）两种形态，故从 `PY_WS` 里取
 * 字符类正文。口径与 `lib.js` 的 `PY_SPACE` 完全同表（Python `str.isspace()`）。
 */
const PY_CLASS = PY_WS.slice(1, -1);
/** Python `\S`（任一非空白字符） */
const PY_NWS = `[^${PY_CLASS}]`;
/** Python `str.rstrip()` */
const PY_RSTRIP_RE = new RegExp(`${PY_WS}+$`);
/** Python `str.splitlines()` 的分隔集合（`\r\n` 算**一个**边界；比 `split("\n")` 多 8 个字符） */
const PY_SPLITLINES_RE = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;
/** `- id: X`（顶层）与 `disabled: true`（缩进）两条 —— Python 的 `\s`/`\S` 均按上表展开 */
const PATCH_ID_RE = new RegExp(`^-${PY_WS}*id:${PY_WS}*(${PY_NWS}+)${PY_WS}*$`);
const PATCH_DISABLED_RE = new RegExp(`^${PY_WS}+disabled:${PY_WS}*true${PY_WS}*$`);
const LEADING_WS_RE = new RegExp(`^${PY_WS}*`);

/**
 * Python `str.splitlines()`。
 *
 * ⚠ 不能直接用 `String.split`：JS 会给**尾部分隔符**补一个空元素
 * （`"a\n".split(/\n/) === ["a", ""]`），而 Python 的 `splitlines()` 不会
 * （`["a"]`）。这条差一个空行，会让 `_patch_set_enabled` 写出的 patch 多一个换行。
 * 另：`\r\n` 在 Python 里算**一个**边界，故正则里排在最前。
 */
function splitLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const out = s.split(PY_SPLITLINES_RE);
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** Python `str.rstrip()` */
function pyRstrip(value) {
  return String(value ?? '').replace(PY_RSTRIP_RE, '');
}

/** Python `bool(x)`（空串/空容器/0/None 假；JS 的 `[]`/`{}` 在 `||` 里是真，必须区分） */
function pyTruthy(value) {
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

/** Python `isinstance(x, dict)`（JSON 对象；数组/None/标量都不是） */
function isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** Python `str(x)`（容器走 repr；整数值浮点这条不可消除，见文件头） */
function pyStr(value) {
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

/** `dict.get`：非 dict 时照 Python 抛 `AttributeError`（`'list' object has no attribute 'get'`） */
function pyGet(obj, key) {
  if (!isDict(obj)) {
    throw new AttributeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(obj, key) ? obj[key] : null;
}

/** 严格 UTF-8 解码（`fatal` 抛错、`ignoreBOM` 让 BOM 与 Python 一样留在文本里） */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 字节 → 文本；非法 UTF-8 抛 `UnicodeDecodeError`（Python `open(..., encoding="utf-8")` 同） */
function decodeUtf8Strict(buf) {
  try {
    return STRICT_UTF8.decode(buf);
  } catch {
    throw new UnicodeDecodeError(
      "'utf-8' codec can't decode bytes: invalid utf-8 sequence（字节位置见 Python 侧）");
  }
}

/** 读整个文件 → 文本，**不吞任何错**（OSError 与 UnicodeDecodeError 都原样抛） */
function readTextStrict(filePath) {
  return toUniversalNewlines(decodeUtf8Strict(fs.readFileSync(filePath)));
}

/**
 * Python 文本模式的 **universal newlines**：`\r\n`/`\r` 一律折成 `\n`。
 *
 * `open(path, encoding="utf-8")` 的 `newline=None` 就是这么做的，而 `builtin_assets.py`
 * 的每个读口都走它（`json.load`、patch 文本、profile manifest）⇒ **CRLF 的 patch 文件**
 * 在 Python 侧读出来是 LF，再写回也是 LF（文件会「缩水」）；JS 若原样保留 `\r`，
 * 标记块匹配与写回字节都会分叉。故本文件的文件读口一律先折行再交给上层。
 */
function toUniversalNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** 读整个文件 → 文本，**只吞 OSError**（Python `open` 的 `except OSError` 分档） */
function readTextOrEmpty(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return '';
  }
  return toUniversalNewlines(decodeUtf8Strict(buf));
}

/** `os.path.expanduser` 的 POSIX 子集（只处理开头的 `~`；口径见文件头） */
function expandUser(p) {
  const s = String(p ?? '');
  if (!s.startsWith('~')) return s;
  let i = s.indexOf('/', 1);
  if (i === -1) i = s.length;
  if (i !== 1) return s;              // `~user` 形态：SKILL_DIRS_BY_FAMILY 里没有，不猜
  const home = Object.hasOwn(process.env, 'HOME') ? process.env.HOME : os.homedir();
  // CPython posixpath.expanduser：`userhome + path[1:]`（**不做 join**，HOME 的尾斜杠照留）
  return `${home}${s.slice(1)}`;
}

/** `tempfile.mkstemp` 的 8 字符表：`[a-zA-Z0-9_]` */
const MKSTEMP_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';

/** 8 字符随机名（只用于临时文件，不参与比对） */
function mkstempSuffix() {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += MKSTEMP_ALPHABET[bytes[i] % MKSTEMP_ALPHABET.length];
  return out;
}

// --------------------------------------------------------------------------
// 常量（`builtin_assets.py:53-68`）
// --------------------------------------------------------------------------

/** 清单根：平台仓库 `extensions/`（`TS_EXT_DIR` 覆盖，测试与自定义部署） */
export const DEFAULT_EXT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions');

/** 清单文件名 */
export const MANIFEST_NAME = 'asset.json';

/** manifest 允许的资产类型（Python 是 tuple，JS 用冻结数组） */
export const ASSET_TYPES = Object.freeze(['skill', 'dsh_plugin']);
/** manifest 允许的安装目标 */
export const ASSET_TARGETS = Object.freeze(['user', 'project']);
/** 资产适用族的展示名（族 → 页面显示名） */
export const FAMILY_LABELS = { dsh_plugin: 'dsh 插件' };
/** 类型展示名 */
export const TYPE_LABELS = { skill: 'skill', dsh_plugin: 'dsh 插件' };
/** dsh 插件资产的缺省 profile */
export const DSH_PROFILE_DEFAULT = 'web';
/** 平台标记块的起止注释（`{aid}` 占位同上 Python 的 `str.format`） */
export const PATCH_MARK_BEGIN = '# >>> touchstone-asset:{aid}';
export const PATCH_MARK_END = '# <<< touchstone-asset:{aid}';
/** 包名（可带 scope）与 profile 名的字符白名单 */
export const _PKG_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const _PROFILE_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** `PATCH_MARK_*.format(aid=…)` 的等价（函数式替换避开 `$` 的替换语义） */
function patchMarkBegin(aid) {
  return PATCH_MARK_BEGIN.replace('{aid}', () => aid);
}

function patchMarkEnd(aid) {
  return PATCH_MARK_END.replace('{aid}', () => aid);
}

/** `list(ASSET_TARGETS)` 的 Python repr（错误文案里逐字出现） */
const ASSET_TARGETS_REPR = `[${ASSET_TARGETS.map((t) => `'${t}'`).join(', ')}]`;

/** `str.strip('"\'')`（`_patch_disabled` 剥 id 两侧引号用） */
function stripQuotes(text) {
  return String(text).replace(/^["']+/, '').replace(/["']+$/, '');
}

// --------------------------------------------------------------------------
// 错误类（`builtin_assets.py:71-77` + `_safe_rel` 的 ValueError）
// --------------------------------------------------------------------------

/**
 * 资产操作错误（api 层转 400/500；`message` 按 `lang` 渲染，`i18nKey`/`i18nVars` 供响应层本地化）。
 *
 * 照 `backend/lib/rag.js` 已建立的「Python 异常类」风格：`name` 与 Python 的
 * `type(exc).__name__` 逐字相同，故对拍里「两侧同抛」的分支能比 `$kind`。
 */
export class AssetError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.name = 'AssetError';
    this.message = message;
    this.code = code;
  }
}

/** Python `ValueError`（`_safe_rel` 抛、`_load_manifest` 只 catch 它） */
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Python `UnicodeDecodeError`（`ValueError` 子类；这里只对齐类名，文案见文件头） */
export class UnicodeDecodeError extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'UnicodeDecodeError';
  }
}

/** Python `AttributeError`（`dict.get` 用在非 dict 上；`_plugin_restart_required` 会撞到） */
export class AttributeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttributeError';
  }
}

// --------------------------------------------------------------------------
// 路径与清单
// --------------------------------------------------------------------------

/** 资产清单根目录（`TS_EXT_DIR` 覆盖，默认仓库 `extensions/`）。 */
export function ext_dir() {
  return path.resolve(process.env.TS_EXT_DIR || DEFAULT_EXT_DIR);
}

/** 把 HOME 前缀缩写为 `~`（回显用，避免泄漏服务进程家目录结构）。 */
export function display_path(p) {
  const home = expandUser('~');
  const s = String(p ?? '');
  if (home && s.startsWith(home + path.sep)) return `~${s.slice(home.length)}`;
  return s;
}

/** 文件内容 sha256；读不到返回空串（调用方按「不存在/不可读」处理）。 */
export function _sha256(p) {
  const h = createHash('sha256');
  try {
    h.update(fs.readFileSync(p));
  } catch {
    return '';
  }
  return h.digest('hex');
}

/** 同目录临时文件 + `rename` 原子写（保留既有文件权限位）。 */
export function _atomic_write_bytes(filePath, data) {
  const p = String(filePath);
  const d = path.dirname(p) || '.';
  fs.mkdirSync(d, { recursive: true });
  let mode = null;
  try {
    mode = fs.statSync(p).mode & 0o777;
  } catch {
    mode = null;
  }
  let fd = null;
  let tmp = '';
  try {
    // mkstemp：同目录、`wx`（已存在即换名重试）、0600 起步（未给 mode 时新文件就留 0600）
    for (let attempt = 0; ; attempt++) {
      tmp = path.join(d, `.tf-asset-${mkstempSuffix()}`);
      try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        break;
      } catch (e) {
        if (e && e.code === 'EEXIST' && attempt < 100) continue;
        throw e;
      }
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.closeSync(fd);
    fd = null;
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, p);
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* 没建成 / 已被 rename 掉 */ }
    throw e;
  }
}

/**
 * 清单非法统一异常（白名单校验失败 = 开发者错误，不放行）。
 *
 * 外层模板 `资产清单非法（{name}）：{why}` 登记为 api key（响应层按请求语言渲染）；
 * `why` 是开发者诊断（固定中文 + 动态 repr/OSError 原文），**不翻**（Ruling R-A4）。
 * `.message` 仍是渲染后的中文，旧日志/测试口径不变。
 */
export function _manifest_error(asset_dir, why) {
  const name = path.basename(asset_dir);
  return localizable(
    new AssetError(`资产清单非法（${name}）：${why}`, 500),
    '资产清单非法（{name}）：{why}', { name, why });
}

/** 校验清单内相对路径：非空、非绝对、无 `..` 段（防越界写）。 */
export function _safe_rel(rel, what) {
  if (typeof rel !== 'string' || !pyStrip(rel)) {
    throw new ValueError(`${what} 必须是非空字符串`);
  }
  const r = pyStrip(rel);
  if (pyIsAbs(r) || /^[A-Za-z]:[\\/]/.test(r)) {
    throw new ValueError(`${what} 必须是相对路径：${rel}`);
  }
  const parts = r.split(/[\\/]+/);
  if (parts.some((x) => x === '..')) {
    throw new ValueError(`${what} 不允许 .. 越界：${rel}`);
  }
  return r;
}

/** YAML 标量渲染（只放行 str/bool/int/float；复杂结构直接报清单错误）。 */
export function _scalar_str(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    return pyRepr(value);               // 指数档的残余差异见文件头
  }
  if (typeof value === 'string') {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return null;
}

/** 校验并规范化 dsh_plugin 资产的 `plugin` 段。 */
export function _plugin_spec(asset_dir, raw) {
  if (!isDict(raw)) {
    throw _manifest_error(asset_dir, 'type=dsh_plugin 必须声明 plugin 对象');
  }
  const pkg = pyStrip(pyStr(pyOr(raw.package, '')));
  if (!_PKG_RE.test(pkg)) {
    // `!r` 取的是**原值**（不是 `or` 之后的），故用 `??` 而不是 `pyOr`
    throw _manifest_error(asset_dir, `plugin.package 非法：${pyRepr(raw.package ?? null)}`);
  }
  const pkgParts = pkg.split('/');
  const entry = pyStrip(pyStr(pyOr(raw.entry_id, pkgParts[pkgParts.length - 1])));
  if (!_PROFILE_RE.test(entry)) {
    throw _manifest_error(asset_dir, `plugin.entry_id 非法：${pyRepr(entry)}`);
  }
  const profile = pyStrip(pyStr(pyOr(raw.profile, DSH_PROFILE_DEFAULT)));
  if (!_PROFILE_RE.test(profile)) {
    throw _manifest_error(asset_dir, `plugin.profile 非法：${pyRepr(profile)}`);
  }
  const cfg = raw.config ?? null;
  const norm_cfg = {};
  if (cfg !== null) {
    if (!isDict(cfg)) throw _manifest_error(asset_dir, 'plugin.config 必须是对象');
    for (const [key, val] of Object.entries(cfg)) {
      // 注意：Python `re` 的 `$` 允许「串尾单个 \n」前匹配，JS 不带 m 时不认 ⇒ 补 `(?:\n)?`
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*(?:\n)?$/.test(key)) {
        throw _manifest_error(asset_dir, `plugin.config 键非法：${pyRepr(key)}`);
      }
      if (_scalar_str(val) === null) {
        throw _manifest_error(
          asset_dir, `plugin.config[${key}] 只支持字符串/布尔/数字（复杂结构请手工写 patch）`);
      }
      norm_cfg[key] = val;
    }
  }
  const req = pyOr(raw.requires ?? null, []);
  if (!Array.isArray(req) || req.some((s) => !_PKG_RE.test(pyStrip(pyStr(pyOr(s, '')))))) {
    throw _manifest_error(asset_dir, 'plugin.requires 必须是包名数组（如 @deepseek-ai/dsh-llm）');
  }
  return {
    package: pkg,
    entry_id: entry,
    profile,
    config: norm_cfg,
    requires: req.map((s) => pyStrip(pyStr(s))),
  };
}

/** 读取并校验单个 `asset.json`，返回规范化资产 dict；非法抛 `AssetError`。 */
export function _load_manifest(asset_dir) {
  const p = pyJoin(asset_dir, MANIFEST_NAME);
  let raw;
  try {
    // Python 的 `except (OSError, ValueError)`：读失败、解码失败（UnicodeDecodeError 是
    // ValueError 子类）、JSON 解析失败三种都归这条（三者的**文案**两侧本就不同，见文件头）
    raw = JSON.parse(readTextStrict(p));
  } catch (e) {
    throw _manifest_error(
      asset_dir, `读取/解析失败（${e && e.message !== undefined ? e.message : e}）`);
  }
  if (!isDict(raw)) {
    throw _manifest_error(asset_dir, '顶层必须是 JSON 对象');
  }
  const aid = pyStrip(pyStr(pyOr(raw.id, '')));
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(aid)) {
    throw _manifest_error(asset_dir, `id 非法：${pyRepr(raw.id ?? null)}`);
  }
  const atype = pyStrip(pyStr(pyOr(raw.type, '')));
  if (!ASSET_TYPES.includes(atype)) {
    throw _manifest_error(asset_dir, `type 必须是 ${ASSET_TYPES.join('/')}：${pyRepr(atype)}`);
  }
  const family = pyStrip(pyStr(pyOr(raw.family, '')));
  // `family not in SKILL_DIRS_BY_FAMILY` 必须用 hasOwn：`'constructor' in {}` 为真，
  // 而 Python 的 dict 没有原型链上的这种假成员
  if (!Object.hasOwn(SKILL_DIRS_BY_FAMILY, family)) {
    throw _manifest_error(asset_dir, `family 未知：${pyRepr(family)}`);
  }
  let targets = raw.targets ?? null;
  if (!Array.isArray(targets) || !targets.length
      || targets.some((t) => !ASSET_TARGETS.includes(t))) {
    throw _manifest_error(asset_dir, `targets 必须是 ${ASSET_TARGETS_REPR} 的非空子集`);
  }
  targets = [...new Set(targets)];
  let plugin = null;
  if (atype === 'dsh_plugin') {
    plugin = _plugin_spec(asset_dir, raw.plugin ?? null);
    // dsh 插件是 **profile 级**资产：装进 dsh home 下的 node_modules + profile patch，
    // 与「哪个项目」无关，故只支持用户级目标（声明 project 直接报清单错误，不静默忽略）
    if (!(targets.length === 1 && targets[0] === 'user')) {
      throw _manifest_error(
        asset_dir, 'type=dsh_plugin 只支持用户级（targets 只能是 ["user"]）');
    }
  }
  const files = raw.files ?? null;
  if (!Array.isArray(files) || !files.length) {
    throw _manifest_error(asset_dir, 'files 必须是非空数组');
  }
  const norm_files = [];
  for (const item of files) {
    if (!isDict(item)) {
      throw _manifest_error(asset_dir, 'files 元素必须是 {from, to} 对象');
    }
    let src;
    let dst;
    try {
      src = _safe_rel(item.from, 'files[].from');
      dst = _safe_rel(item.to, 'files[].to');
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      throw _manifest_error(asset_dir, String(e.message));
    }
    if (!isFile(pyJoin(asset_dir, src))) {
      throw _manifest_error(asset_dir, `清单文件不存在：${src}`);
    }
    norm_files.push({ from: src, to: dst });
  }
  // 注册机制（hook 时代的 config.toml 写入）已随族退役：声明即报错，不静默忽略
  // （dsh 插件的注册走 plugin 段的 patch 行，不用这个旧字段）
  if (raw.register !== undefined && raw.register !== null) {
    throw _manifest_error(asset_dir, '不支持 register 声明（skill 资产无需注册）');
  }
  return {
    id: aid,
    name: pyStr(pyOr(raw.name, aid)),
    type: atype,
    family,
    description: pyStr(pyOr(raw.description, '')),
    targets,
    files: norm_files,
    plugin,
    dir: asset_dir,
  };
}

/** 扫描清单根下所有 `extensions/<目录>/asset.json`，返回资产列表（非法的直接报错）。 */
export function load_assets() {
  const root = ext_dir();
  if (!isDir(root)) return [];
  const assets = [];
  const ids = new Set();
  for (const name of pySorted(fs.readdirSync(root))) {
    const d = pyJoin(root, name);
    if (!isFile(pyJoin(d, MANIFEST_NAME))) continue;
    const asset = _load_manifest(d);
    if (ids.has(asset.id)) {
      throw _manifest_error(d, `id 重复：${asset.id}`);
    }
    ids.add(asset.id);
    assets.push(asset);
  }
  return assets;
}

/** 按 id 取资产；不存在返回 `None`。 */
export function get_asset(asset_id) {
  for (const a of load_assets()) {
    if (a.id === asset_id) return a;
  }
  return null;
}

// --------------------------------------------------------------------------
// 落点推导
// --------------------------------------------------------------------------

/** skill 落点根：该族首个用户级目录 / 项目级相对目录（约定见 agents 模块）。 */
export function _skill_root(family, target, project_dir) {
  const [user_dirs, proj_dirs] = SKILL_DIRS_BY_FAMILY[family] || [[], []];
  if (target === 'user') {
    return user_dirs.length ? expandUser(user_dirs[0]) : null;
  }
  if (!pyTruthy(project_dir)) return null;
  return proj_dirs.length ? pyJoin(project_dir, proj_dirs[0]) : null;
}

/** dsh 的 profiles 根：`TS_DSH_PROFILES` 覆盖 → `DSH_HOME` → `~/.dsh`（后接 profiles）。 */
export function dsh_profiles_dir() {
  const env = process.env.TS_DSH_PROFILES;
  if (pyTruthy(env)) return path.resolve(env);
  const home = process.env.DSH_HOME || pyJoin(expandUser('~'), '.dsh');
  return pyJoin(path.resolve(home), 'profiles');
}

/** dsh 插件包实体落点：`<profiles>/node_modules/<package>`（scope 按 npm 目录布局展开）。 */
export function plugin_package_root(asset) {
  return pyJoin(dsh_profiles_dir(), 'node_modules', ...asset.plugin.package.split('/'));
}

/** 注册行落点：`<profiles>/<profile>/cordis.patch.yml`（**不是** `cordis.yml`）。 */
export function plugin_patch_path(asset) {
  return pyJoin(dsh_profiles_dir(), asset.plugin.profile, 'cordis.patch.yml');
}

/** 平台规范块文本列表（插入顺序即写入顺序）：注入块 + 可选 config 覆盖块。 */
export function plugin_patch_blocks(asset) {
  const p = asset.plugin;
  const aid = asset.id;
  const blocks = [[
    patchMarkBegin(aid),
    '- insert:',
    `    - id: ${p.entry_id}`,
    `      name: "${p.package}"`,
    patchMarkEnd(aid),
  ].join('\n')];
  if (pyTruthy(p.config)) {
    const lines = [
      patchMarkBegin(`${aid}.config`),
      `- id: ${p.entry_id}`,
      '  config:',
    ];
    for (const [k, v] of Object.entries(p.config)) lines.push(`    ${k}: ${_scalar_str(v)}`);
    lines.push('  disabled: false', patchMarkEnd(`${aid}.config`));
    blocks.push(lines.join('\n'));
  }
  return blocks;
}

/** 规范注入块的 3 行（逐行比对用；行尾空白已剥）。 */
export function _canonical_lines(asset) {
  const p = asset.plugin;
  return ['- insert:', `    - id: ${p.entry_id}`, `      name: "${p.package}"`];
}

/** 找「规范注入块」的起止行号 `[start, end)`，找不到返回 `None`。 */
export function _find_canonical(text, asset) {
  const lines = splitLines(text);
  const want = _canonical_lines(asset);
  for (let i = 0; i < lines.length - 2; i++) {
    const got = [pyRstrip(lines[i]), pyRstrip(lines[i + 1]), pyRstrip(lines[i + 2])];
    if (got.some((v, n) => v !== want[n])) continue;
    // 必须逐行精确匹配且**下一行不是同一 insert 项内的更深缩进字段**——否则用户自定义写法
    // （如在本块后面又加了 `config:`）会被子串匹配误判成规范块，卸载时截断用户的配置。
    const nxt = i + 3 < lines.length ? lines[i + 3] : '';
    if (nxt.startsWith('    ')) continue;
    return [i, i + 3];
  }
  return null;
}

/** 该条目是否在 patch 里被显式停用（dsh 面板停用会追加顶层 `- id: X` + `disabled: true`）。 */
export function _patch_disabled(text, entry_id) {
  let cur = null;
  for (const line of splitLines(text)) {
    const m = PATCH_ID_RE.exec(line);
    if (m) {
      // 只认**顶层**（列 0）的 `- id:` 行：注入块内部那行是缩进的，不会误命中
      cur = stripQuotes(m[1]);
      continue;
    }
    if (line.startsWith('- ')) {
      cur = null;
      continue;
    }
    if (cur === entry_id && PATCH_DISABLED_RE.test(line)) return true;
  }
  return false;
}

/** 注册行状态（读 patch 文件，纯推导）：`marked` / `canonical` / `foreign` / `""`。 */
export function plugin_patch_state(asset) {
  const p = plugin_patch_path(asset);
  // OSError（不存在/是目录/权限）→ 与 Python 同：空文本；解码失败不吞（UnicodeDecodeError
  // 在 Python 里不是 OSError，会一路上抛）
  const text = readTextOrEmpty(p);
  const aid = asset.id;
  let mode;
  if (text.includes(patchMarkBegin(aid))) mode = 'marked';
  else if (_find_canonical(text, asset) !== null) mode = 'canonical';
  else if (text.includes(asset.plugin.package)) mode = 'foreign';
  else mode = '';
  return {
    path: p,
    exists: pyTruthy(text),
    mode,
    registered: mode !== '',
    disabled: pyTruthy(text) && _patch_disabled(text, asset.plugin.entry_id),
  };
}

/** 遇到用户自定义注册写法时的统一拒绝原因（安装/卸载共用）。 */
export function _patch_foreign_error(asset, patch) {
  const where = display_path(patch.path);
  return localizable(new AssetError(
    `「${asset.name}」在 ${where} 里已有自定义写法的注册行，`
    + '平台不覆盖、也不删除用户手写的 patch 配置；请先手工移除该条目再试', 409),
  '「{name}」在 {path} 里已有自定义写法的注册行，'
  + '平台不覆盖、也不删除用户手写的 patch 配置；请先手工移除该条目再试',
  { name: asset.name, path: where });
}

/** 推导该资产在指定目标下的落点根；不支持返回 `None`。 */
export function install_root(asset, target, project_dir = '') {
  if (!asset.targets.includes(target)) return null;
  if (asset.type === 'dsh_plugin') {
    // dsh 插件是 profile 级资产：只支持用户级（落 dsh home 下的 node_modules）
    return target === 'user' ? plugin_package_root(asset) : null;
  }
  return _skill_root(asset.family, target, project_dir);
}

/** 资产在目标下不可安装的原因（key+vars）；`reason` 字段与异常共用同一份真相源。 */
function unsupportedInfo(asset, target, lang = 'zh') {
  if (!asset.targets.includes(target)) {
    // TS_I18N=0 回滚时 t() 恒中文 ⇒ 分隔符也必须回落 `、`，否则拼出「用户级, 项目级」
    const sep = normalizeLang(lang) === 'en' && !isI18nDisabled() ? ', ' : '、';
    return {
      key: '该资产只支持{targets}安装',
      vars: {
        targets: asset.targets
          .map((x) => t('api', x === 'user' ? '用户级' : '项目级', lang))
          .join(sep),
      },
    };
  }
  if (asset.type === 'dsh_plugin') {
    return { key: 'dsh 插件资产只支持用户级（装进 dsh profile，与项目无关）', vars: null };
  }
  return { key: '该资产（{family}）暂不支持此目标的安装', vars: { family: asset.family } };
}

/** 资产在目标下不可安装的用户可读原因（按 `lang` 渲染；payload 的 reason 字段用）。 */
export function _unsupported_reason(asset, target, lang = 'zh') {
  const info = unsupportedInfo(asset, target, lang);
  return t('api', info.key, lang, info.vars);
}

/** 不可安装原因的**异常**形态：`.message` 按 lang 渲染，`i18nKey/.i18nVars` 供响应层本地化。 */
function unsupportedError(asset, target, lang = 'zh') {
  const info = unsupportedInfo(asset, target, lang);
  return localizable(new AssetError(_unsupported_reason(asset, target, lang)),
    info.key, info.vars);
}

/** 清单文件在该落点根下的安装信息列表。 */
export function _installed_files(asset, root) {
  const out = [];
  for (const f of asset.files) {
    const dst = pyJoin(root, f.to);
    // 双保险：解析后的目标必须落在落点根内（清单已校验相对路径，此处仍复核）
    const base = realpathOrResolve(root);
    const real = realpathOrResolve(dst);
    if (!(real === base || real.startsWith(base + path.sep))) {
      throw localizable(new AssetError(`安装路径越界：${f.to}`, 500),
        '安装路径越界：{path}', { path: f.to });
    }
    const src_hash = _sha256(pyJoin(asset.dir, f.from));
    const dst_hash = _sha256(dst);
    out.push({
      to: f.to, path: dst, exists: pyTruthy(dst_hash),
      same: pyTruthy(dst_hash) && dst_hash === src_hash,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// 状态 / 安装 / 卸载
// --------------------------------------------------------------------------

/**
 * 判定资产在指定目标下的状态，返回含明细的 dict（详情见模块 docstring）。
 * 不支持的目标下 `reason` 按 `lang` 渲染（由 `_unsupported_reason` 下沉）。
 */
export function asset_status(asset, target, project_dir = '', lang = 'zh') {
  const root = install_root(asset, target, project_dir);
  const supported = root !== null;
  const files = supported ? _installed_files(asset, root) : [];
  const patch = (supported && asset.type === 'dsh_plugin') ? plugin_patch_state(asset) : null;
  let state = 'absent';
  if (supported) {
    const any_exists = files.some((f) => f.exists);
    const file_ok = files.length > 0 && files.every((f) => f.exists);
    const file_same = file_ok && files.every((f) => f.same);
    if (patch === null) {
      if (!any_exists) state = 'absent';
      else if (file_same) state = 'installed';
      else if (file_ok) state = 'outdated';
      else state = 'partial';
    } else {
      const usable = patch.registered && !patch.disabled;
      if (!any_exists && !patch.registered) state = 'absent';
      else if (file_same && usable) state = 'installed';
      else if (file_ok && usable) state = 'outdated';
      else state = 'partial';
    }
  }
  return {
    supported,
    reason: supported ? '' : _unsupported_reason(asset, target, lang),
    root: supported ? display_path(root) : '',
    state,
    files,
    patch,
  };
}

/** 插件的运行时依赖解析状态（只读诊断，不写任何链接）。 */
export function _plugin_requires_state(asset) {
  const root = plugin_package_root(asset);
  const out = [];
  for (const spec of pyOr(asset.plugin.requires, [])) {
    const found = _node_resolve(spec, root);
    out.push({ spec, ok: pyTruthy(found), path: found ? display_path(found) : '' });
  }
  return out;
}

/** 按 Node 祖先查找规则判断从 `start_dir` 能否解析到 `spec`；返回命中目录或空串。 */
export function _node_resolve(spec, start_dir) {
  let cur = path.resolve(start_dir);
  for (;;) {
    const cand = pyJoin(cur, 'node_modules', ...String(spec).split('/'));
    // 纯文件检查（不跑 node）：断链的软链因 statSync 跟随解析而为 false，正是要暴露的情况
    if (pathExists(pyJoin(cand, 'package.json'))) return cand;
    const parent = path.dirname(cur);
    if (parent === cur) return '';
    cur = parent;
  }
}

/** 装/卸后是否需要重启 dsh：profile 的 `package.json` 声明 `patchReload: live` 才热生效。 */
export function _plugin_restart_required(asset) {
  const manifest = pyJoin(dsh_profiles_dir(), asset.plugin.profile, 'package.json');
  let data;
  try {
    data = JSON.parse(readTextStrict(manifest));
  } catch {
    return true;                          // 读不到/坏 JSON/坏编码 → 按「需要重启」处理（不猜）
  }
  // Python：`((data.get("dsh") or {}).get("profile") or {}) if isinstance(data, dict) else {}`
  // —— `dsh` 非 dict 且**为真**时 `.get` 抛 AttributeError（`[]`/`{}` 是假值，不抛）
  const prof = isDict(data) ? pyOr(pyGet(pyOr(pyGet(data, 'dsh'), {}), 'profile'), {}) : {};
  return pyStr(pyOr(pyGet(prof, 'patchReload'), '')) !== 'live';
}

/** 资产的对外 JSON（清单元信息 + 目标下的状态明细；`reason` 按 lang 渲染）。 */
export function asset_json(asset, target, project_dir = '', lang = 'zh') {
  const st = asset_status(asset, target, project_dir, lang);
  const out = {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    type_label: Object.hasOwn(TYPE_LABELS, asset.type) ? TYPE_LABELS[asset.type] : asset.type,
    family: asset.family,
    family_label: Object.hasOwn(FAMILY_LABELS, asset.family)
      ? FAMILY_LABELS[asset.family] : asset.family,
    description: asset.description,
    targets: asset.targets,
    supported: st.supported,
    reason: st.reason,
    state: st.state,
    root: st.root,
    files: st.files.map((f) => ({
      to: f.to, path: display_path(f.path), exists: f.exists, same: f.same,
    })),
  };
  if (st.patch !== null) {
    const requires = _plugin_requires_state(asset);
    out.plugin = {
      package: asset.plugin.package,
      entry_id: asset.plugin.entry_id,
      profile: asset.plugin.profile,
      patch_path: display_path(st.patch.path),
      patch_mode: st.patch.mode,
      registered: st.patch.registered,
      disabled: st.patch.disabled,
      restart_required: _plugin_restart_required(asset),
      requires,
      requires_ok: requires.every((r) => r.ok),
    };
  }
  return out;
}

/** 目标下的资产清单（含状态）；`target` 非法抛 `AssetError(400)`。 */
export function list_assets(target, project_dir = '', lang = 'zh') {
  if (!ASSET_TARGETS.includes(target)) {
    const targets = ASSET_TARGETS.join('/');
    throw localizable(new AssetError(`target 必须是 ${targets}`),
      'target 必须是 {targets}', { targets });
  }
  return load_assets().map((a) => asset_json(a, target, project_dir, lang));
}

/** dsh 插件安装的前置检查：目标 profile 目录必须存在（不存在则装了也不会被加载）。 */
export function _require_profile(asset) {
  const prof_dir = path.dirname(plugin_patch_path(asset));
  if (!isDir(prof_dir)) {
    const where = display_path(prof_dir);
    throw localizable(new AssetError(
      `未找到 dsh profile「${asset.plugin.profile}」：${where}`),
    '未找到 dsh profile「{profile}」：{path}', { profile: asset.plugin.profile, path: where });
  }
}

/** 确保注册块在 patch 里且处于启用态（幂等）：返回 `[action, patch_state]`。 */
export function _write_plugin_patch(asset) {
  const patch = plugin_patch_state(asset);
  if (patch.mode === 'foreign') {
    throw _patch_foreign_error(asset, patch);
  }
  if (patch.mode === 'marked' || patch.mode === 'canonical') {
    if (!patch.disabled) return ['kept', patch];
    const p = patch.path;
    const text = readTextStrict(p);
    _atomic_write_bytes(p, Buffer.from(_patch_set_enabled(text, asset.plugin.entry_id), 'utf8'));
    return ['enabled', plugin_patch_state(asset)];
  }
  const p = patch.path;
  _require_profile(asset);
  let old = '';
  if (isFile(p)) old = readTextStrict(p);
  let text = old;
  if (text && !text.endsWith('\n')) text += '\n';
  if (text && !text.endsWith('\n\n')) text += '\n';
  text += `${plugin_patch_blocks(asset).join('\n')}\n`;
  _atomic_write_bytes(p, Buffer.from(text, 'utf8'));
  return ['added', plugin_patch_state(asset)];
}

/** 把该条目顶层 `- id: <entry_id>` 行下的 `disabled:` 改成 false（找不到则原样返回）。 */
export function _patch_set_enabled(text, entry_id) {
  const lines = splitLines(text);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = PATCH_ID_RE.exec(line);
    if (m) {
      cur = stripQuotes(m[1]);
      continue;
    }
    if (line.startsWith('- ')) {
      cur = null;
      continue;
    }
    if (cur === entry_id && PATCH_DISABLED_RE.test(line)) {
      const head = line.match(LEADING_WS_RE)[0];      // Python：line[:len(line)-len(line.lstrip())]
      lines[i] = `${head}disabled: false`;
      const out = lines.join('\n');
      return String(text).endsWith('\n') ? `${out}\n` : out;
    }
  }
  return text;
}

/** 删掉平台标记块（含可选 config 块）与其留下的多余空行。 */
export function _strip_marked_blocks(text, aid) {
  const begins = new Set([patchMarkBegin(aid), patchMarkBegin(`${aid}.config`)]);
  const ends = new Set([patchMarkEnd(aid), patchMarkEnd(`${aid}.config`)]);
  const out = [];
  let skip = false;
  for (const line of splitLines(text)) {
    const s = pyStrip(line);
    if (begins.has(s)) {
      skip = true;
      continue;
    }
    if (ends.has(s)) {
      skip = false;
      continue;
    }
    if (!skip) out.push(line);
  }
  let res = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (res && !res.endsWith('\n')) res += '\n';
  return res;
}

/** 移除注册块（幂等）：返回 `[action, patch_state]`。foreign 一律拒绝。 */
export function _remove_plugin_patch(asset) {
  const patch = plugin_patch_state(asset);
  if (patch.mode === 'foreign') {
    throw _patch_foreign_error(asset, patch);
  }
  if (patch.mode === '') return ['absent', patch];
  const p = patch.path;
  const text = readTextStrict(p);
  let neu;
  if (patch.mode === 'marked') {
    neu = _strip_marked_blocks(text, asset.id);
  } else {
    const span = _find_canonical(text, asset);
    const lines = splitLines(text);
    const kept = [...lines.slice(0, span[0]), ...lines.slice(span[1])];
    neu = kept.join('\n').replace(/\n{3,}/g, '\n\n');
    if (neu && !neu.endsWith('\n')) neu += '\n';
  }
  _atomic_write_bytes(p, Buffer.from(neu, 'utf8'));
  return ['removed', plugin_patch_state(asset)];
}

/** `os.walk(cur, topdown=False)` 的目录序列（不跟随符号链接、读不到就跳过） */
function walkDirsBottomUp(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) walkDirsBottomUp(path.join(root, ent.name), out);
  }
  out.push(root);
  return out;
}

/** 删空目录：先自底向上清子树里的空目录，再逐级上删空父目录（到 `stop_at` 为止）。 */
export function _prune_empty_dirs(p, stop_at) {
  let cur = path.resolve(p);
  const stop = path.resolve(stop_at);
  if (isDir(cur)) {
    for (const dirpath of walkDirsBottomUp(cur)) {
      try {
        fs.rmdirSync(dirpath);            // 空则删；非空抛 → 跳过（不递归删别人的文件）
      } catch { /* 与 Python 的 `except OSError: pass` 同 */ }
    }
  }
  while (cur.startsWith(stop + path.sep) && cur !== stop) {
    try {
      fs.rmdirSync(cur);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // 子树里已被删掉 → 继续往上收敛空父目录
      } else {
        return;                           // 非空（还有别人的文件）→ 停
      }
    }
    cur = path.dirname(cur);
  }
}

/** 安装/更新/修复资产（收敛到期望状态），返回结果 dict。 */
export function install(asset, target, project_dir = '', lang = 'zh') {
  const root = install_root(asset, target, project_dir);
  if (root === null) {
    throw unsupportedError(asset, target, lang);
  }
  if (target === 'project') {
    if (!pyTruthy(project_dir) || !isDir(project_dir)) {
      throw new AssetError('项目目录不存在');
    }
  }
  if (asset.type === 'dsh_plugin') {
    // 前置检查放在拷文件之前：profile 不存在时直接报错，不留下「包已拷、注册行没写」
    // 的半残状态（那种状态面板会显示 partial，用户还得先修一次）
    _require_profile(asset);
  }
  // 落盘：内容一致则不动，其余原子覆盖
  const written = [];
  for (const f of asset.files) {
    const dst = pyJoin(root, f.to);
    const base = realpathOrResolve(root);
    const real = realpathOrResolve(dst);
    if (!(real === base || real.startsWith(base + path.sep))) {
      throw localizable(new AssetError(`安装路径越界：${f.to}`, 500),
        '安装路径越界：{path}', { path: f.to });
    }
    const src = pyJoin(asset.dir, f.from);
    const data = fs.readFileSync(src);
    if (_sha256(dst) === _sha256(src)) continue;
    _atomic_write_bytes(dst, data);
    written.push(display_path(dst));
  }
  let patch_action = '';
  if (asset.type === 'dsh_plugin') {
    patch_action = _write_plugin_patch(asset)[0];
  }
  const st = asset_status(asset, target, project_dir, lang);
  return {
    ok: true,
    state: st.state,
    files_written: written,
    patch_action,
    restart_required: asset.type === 'dsh_plugin' ? _plugin_restart_required(asset) : false,
    asset: asset_json(asset, target, project_dir, lang),
  };
}

/** 卸载资产：只删除清单内文件（别人的文件一律不动），返回结果 dict。 */
export function uninstall(asset, target, project_dir = '', lang = 'zh') {
  const root = install_root(asset, target, project_dir);
  if (root === null) {
    throw unsupportedError(asset, target, lang);
  }
  // dsh 插件：先判注册行——foreign（用户自定义写法）时**在删任何文件之前**拒绝，
  // 免得出现「包文件已删、注册行还在」的半残状态
  const patch = asset.type === 'dsh_plugin' ? plugin_patch_state(asset) : null;
  if (patch !== null && patch.mode === 'foreign') {
    throw _patch_foreign_error(asset, patch);
  }
  const files = _installed_files(asset, root);
  const deleted = [];
  for (const f of files) {
    if (isFile(f.path)) {
      try {
        fs.unlinkSync(f.path);
      } catch (e) {
        const where = display_path(f.path);
        const detail = e && e.message !== undefined ? e.message : e;
        throw localizable(new AssetError(`删除失败：${where}（${detail}）`, 500),
          '删除失败：{path}（{detail}）', { path: where, detail });
      }
      deleted.push(display_path(f.path));
    }
  }
  let patch_action = '';
  if (patch !== null) {
    patch_action = _remove_plugin_patch(asset)[0];
    _prune_empty_dirs(root, dsh_profiles_dir());
  }
  const st = asset_status(asset, target, project_dir, lang);
  return {
    ok: true,
    state: st.state,
    files_deleted: deleted,
    patch_action,
    restart_required: asset.type === 'dsh_plugin' ? _plugin_restart_required(asset) : false,
    asset: asset_json(asset, target, project_dir, lang),
  };
}

// --------------------------------------------------------------------------
// camelCase 别名（JS 调用方用；量具用例仍写 Python 名 + nodeFn）
// --------------------------------------------------------------------------

export const extDir = ext_dir;
export const displayPath = display_path;
export const sha256 = _sha256;
export const atomicWriteBytes = _atomic_write_bytes;
export const manifestError = _manifest_error;
export const safeRel = _safe_rel;
export const scalarStr = _scalar_str;
export const pluginSpec = _plugin_spec;
export const loadManifest = _load_manifest;
export const loadAssets = load_assets;
export const getAsset = get_asset;
export const skillRoot = _skill_root;
export const dshProfilesDir = dsh_profiles_dir;
export const pluginPackageRoot = plugin_package_root;
export const pluginPatchPath = plugin_patch_path;
export const pluginPatchBlocks = plugin_patch_blocks;
export const canonicalLines = _canonical_lines;
export const findCanonical = _find_canonical;
export const patchDisabled = _patch_disabled;
export const pluginPatchState = plugin_patch_state;
export const patchForeignError = _patch_foreign_error;
export const installRoot = install_root;
export const unsupportedReason = _unsupported_reason;
export const installedFiles = _installed_files;
export const assetStatus = asset_status;
export const pluginRequiresState = _plugin_requires_state;
export const nodeResolve = _node_resolve;
export const pluginRestartRequired = _plugin_restart_required;
export const assetJson = asset_json;
export const listAssets = list_assets;
export const requireProfile = _require_profile;
export const writePluginPatch = _write_plugin_patch;
export const patchSetEnabled = _patch_set_enabled;
export const stripMarkedBlocks = _strip_marked_blocks;
export const removePluginPatch = _remove_plugin_patch;
export const pruneEmptyDirs = _prune_empty_dirs;
