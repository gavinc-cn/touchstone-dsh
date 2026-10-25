/**
 * 共享解析/路径工具的**读侧子集**（`lib.py` + `server.py` 顶部文件系统小工具的对应物，M3 读路径）。
 *
 * ── 为什么只搬「读」的一半 ──────────────────────────────────────────────────────
 * `lib.py` 里还有一批**写**函数（`set_md_field`/`mark_cases_retest`/`ensure_gitignore`/
 * `git_log_changes` 等），它们服务的是任务收尾与建/改项目路径 —— 属 M4/M5/M6，搬进来只会
 * 让 M3 的只读边界变糊。本文件只放**纯读**：文本读、字段解析、status.md、用例目录定位、
 * bug 报告关联用例，以及 `server.py` 里那几个「路径 → 是否可读/是否越界」的函数
 * （`fs_roots`/`_within_root`/`resolve_project_file`/`read_text_preview`/`fs_browse`）。
 * 它们虽在 Python 侧写在 server.py（不在 lib.py），但都是**无状态纯函数**，按 M3 的分工
 * 收进本模块，路由文件只留「取参 → 调函数 → 定响应」。
 *
 * ── 逐点等价的口径（每条都对着 Python 源码核过） ─────────────────────────────────
 * 1. **正则**：Python `re` 与 JS `RegExp` 有三处会分叉，这里逐条抹平 ——
 *    ① `\s`：Python str 模式的 `\s` 是 Unicode 空白（含 `\x1c-\x1f`、`\x85`），而 JS 的 `\s`
 *       多含 `\ufeff`、少含那几个控制字符 ⇒ **一律展开成 `PY_WS` 字符类**（与 db.js 同表）；
 *    ② `.`：Python 的 `.` 只排除 `\n`，JS 还排除 `\r`/`U+2028`/`U+2029` ⇒ 一律写成 `[^\n]`；
 *    ③ `\d`：Python 的 `\d` 是 Unicode 十进制数字，JS 是 `[0-9]`。**这一条有意不抹平**：
 *       平台里的 `\d` 只出现在 FS 用例号、轮次号、日期型目录名上，全是 ASCII；改成 Unicode
 *       口径还得连 `int()` 一起改，收益为零、复杂度爆表。差异仅对「用阿拉伯数字命名的用例目录」
 *       成立，写在这里备案而不是静默。
 * 2. **文本模式换行**：Python `open(..., encoding="utf-8", errors="replace")` 默认做 universal
 *    newlines ⇒ `\r\n`/`\r` 都变 `\n`。**读文本一律走 `readText`（做这层转换）**；而
 *    `read_text_preview` 在 Python 侧是 `open(path, "rb")` ⇒ **不转换**，故预览正文按原字节解码。
 * 3. **`str.strip()` / `str.isdigit()` / `int(str)`**：分别按 Python 的空白集合、ASCII 数字、
 *    「可选符号 + 数字」实现（见 `pyStrip`/`pyIsDigits`/`pyIntOr`）。
 * 4. **`os.path`**：`join` 的「后段绝对路径覆盖前段」（`join('/a','/etc') == '/etc'`）与
 *    `path.join` 语义**不同**，用 `pyJoin`；`normpath` 在 POSIX 下保留开头两个斜杠
 *    （`//a/b` 不变），`path.normalize` 会压成一个 ⇒ 用 `pyNormpath`。
 * 5. **`os.stat().st_mtime`**：CPython 用 `sec + nsec*1e-9`（先说 `st_mtime_ns` 整除，
 *    不是 `ns/1e9`），实测 184/184 个真实文件的 repr 与 `pyMtimeFloat` 逐字符相同。
 *    本文件只做「ns → Python 等值浮点/int」这一层，缓存指纹见 `casescan.js`。
 *
 * 已知有意保留的差异（都不影响真实案例库，别当 bug 修）：
 *   - `\d` 按 ASCII（见上 ③）；
 *   - `readText` 的 UTF-8 坏字节替换粒度：Python `errors="replace"` 与 JS `Buffer.toString('utf8')`
 *     都按「最长可解码子串」各出一个 U+FFFD，实测常见坏字节序列一致；极端序列不保证逐字符相同；
 *   - `realpathOrResolve`：Python `os.path.realpath(strict=False)` 对**不存在**的路径也能解析
 *     （把能解析的前缀解掉、余下原样拼接），Node 的 `fs.realpathSync` 直接抛 ENOENT ⇒ 回落
 *     `path.resolve`。两者只在「不存在的路径**且**其已存在前缀里有符号链接」时分叉。
 *
 * 零 npm 依赖：只用 node:fs / node:path / node:url。
 *
 * **M6.9 追加（文件末尾）**：`normalizeProjectName` / `pathLastSegment` / `fsMkdir`
 * —— 前两个是纯函数，`fsMkdir` 是本文件第一个**写盘**函数（`server.py:fs_mkdir`：
 * 建一个子目录，写作用域严格限定在调用方给的已存在父目录下）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { messageVars } from './i18n.js';

// --------------------------------------------------------------------------
// Python 字符串语义的小工具
// --------------------------------------------------------------------------

/** Python `str.isspace()` 的字符集合（JS `\s` 多含 U+FEFF、少含 U+001C-U+001F/U+0085） */
const PY_SPACE = ' \t\n\v\f\r\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');

/** Python `\s` 的展开形态：直接嵌进正则源码用（与 db.js 的 PY_SPACE 同表） */
export const PY_WS = `[${PY_SPACE}]`;

/**
 * Python `str.strip()`（正则里 `\s` 的口径也以它为准）。
 * @param {unknown} value
 * @returns {string}
 */
export function pyStrip(value) {
  return String(value == null ? '' : value).replace(PY_STRIP_RE, '');
}

/**
 * 按 **码点** 比较两个字符串（Python `sorted()` 的口径）。
 *
 * 为什么不能直接 `<`：JS 的字符串比较按 UTF-16 码元，代理对（U+10000 以上）会被当成
 * 0xD800-0xDFFF 区间参与比较，与 Python 的码点序在「U+E000-U+FFFF vs 补充平面」这一对
 * 上正好反过来 —— 文件名字典序会与 Python 分叉。案例库里出现 emoji 目录时就会显形。
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 / 0 / 1
 */
export function pyStrCompare(a, b) {
  const ia = String(a)[Symbol.iterator]();
  const ib = String(b)[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) {
      if (x.done && y.done) return 0;
      return x.done ? -1 : 1;
    }
    const ca = x.value.codePointAt(0);
    const cb = y.value.codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

/** Python `sorted(list)` 的等价（码点序 + 稳定） */
export function pySorted(values) {
  return [...values].sort(pyStrCompare);
}

/** Python `sorted(list, reverse=True)`：**不是**「升序再反转」——相等元素的相对次序仍保持 */
export function pySortedReverse(values) {
  return [...values].sort((a, b) => pyStrCompare(b, a));
}

/**
 * Python `str.isdigit()` 的 ASCII 子集（只认 `[0-9]`，见文件头 ③）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function pyIsDigits(value) {
  return /^[0-9]+$/.test(String(value == null ? '' : value));
}

/**
 * Python `int(str)` 的容错版：解析失败返回 `fallback`（对齐 `try: int(x) except ValueError`）。
 *
 * 接受「两侧 Python 空白 + 可选正负号 + ASCII 数字」（`int(' -8 ')` = -8、
 * `int('8.0')` 抛 ValueError ⇒ fallback）。空串与只有符号的串同样落 fallback。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function pyIntOr(value, fallback) {
  const text = pyStrip(value);
  if (!/^[+-]?[0-9]+$/.test(text)) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * CPython `_PyTime_AsSecondsDouble`：`st_mtime_ns` → `st_mtime`（float 秒）。
 *
 * 为什么不能写 `Number(ns) / 1e9`：那是「一次除法一次舍入」，CPython 是
 * 「秒部分 + 纳秒部分×1e-9」（两次舍入），两者在约一半的真实时间戳上差 1 ULP
 * （实测 184 个文件里 58 个的 repr 不同）——而 `live_mtime` 是要进 JSON 响应体的。
 * @param {bigint} ns `st_mtime_ns`
 * @returns {number}
 */
export function pyMtimeFloat(ns) {
  const sec = ns / 1000000000n;
  const rem = ns % 1000000000n;
  return Number(sec) + Number(rem) * 1e-9;
}

/**
 * `int(os.path.getmtime(path))`：CPython 先算 float 再 `int()`（向零截断）。
 * @param {bigint} ns `st_mtime_ns`
 * @returns {number}
 */
export function pyMtimeInt(ns) {
  return Math.trunc(pyMtimeFloat(ns));
}

// --------------------------------------------------------------------------
// 路径（os.path 的逐点等价子集）
// --------------------------------------------------------------------------

/**
 * `os.path.join`（POSIX 口径）：后段是绝对路径时**覆盖**前面全部段。
 *
 * 为什么不能用 `path.join`：`path.join('/a/b', '/etc')` = `/a/b/etc`（Node 只拼接），
 * 而 Python 给 `/etc`。`_api_get_bug` 的 `os.path.join(row["bug_dir"], bug_dir)` 正是
 * 这个形态（`bugs/%2Ftmp` 会命中），用错就是行为分叉。
 * @param {...(string|null|undefined)} parts
 * @returns {string}
 */
export function pyJoin(...parts) {
  let out = '';
  for (const raw of parts) {
    const part = String(raw == null ? '' : raw);
    if (part.startsWith('/')) out = part;
    else if (out === '' || out.endsWith('/')) out += part;
    else out += `/${part}`;
  }
  return out;
}

/**
 * `posixpath.normpath`（POSIX 口径）：折叠 `.`/`//`、解析 `..`、**保留开头两个斜杠**。
 * @param {string} value
 * @returns {string}
 */
export function pyNormpath(value) {
  const p = String(value == null ? '' : value);
  if (p === '') return '.';
  let initialSlashes = p.startsWith('/');
  if (initialSlashes && p.startsWith('//') && !p.startsWith('///')) initialSlashes = 2;
  const out = [];
  for (const comp of p.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initialSlashes && out.length === 0) || out[out.length - 1] === '..') {
      out.push(comp);
    } else if (out.length) {
      out.pop();
    }
  }
  let joined = out.join('/');
  if (initialSlashes) joined = `${'/'.repeat(initialSlashes)}${joined}`;
  return joined || '.';
}

/** `os.path.isabs`：POSIX 只看开头是不是 `/`（Windows 分支交给 path.isAbsolute） */
export function pyIsAbs(value) {
  return path.isAbsolute(String(value == null ? '' : value));
}

/**
 * `os.path.realpath(strict=False)` 的可用近似：能解析就真解析，不存在则 `path.resolve`。
 * 差异见文件头「已知有意保留的差异」。
 * @param {string} value
 * @returns {string}
 */
export function realpathOrResolve(value) {
  const p = String(value == null ? '' : value);
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `os.path.isdir`（跟随符号链接；出错一律 false，与 Python 的 `except OSError → False` 同） */
export function isDir(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/** `os.path.isfile`（跟随符号链接；出错 false） */
export function isFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

/** `os.path.exists`（跟随符号链接；出错 false） */
export function pathExists(value) {
  try {
    fs.statSync(value);
    return true;
  } catch {
    return false;
  }
}

/** `os.path.basename`（尾部分隔符忽略；空串 → 空串） */
export function pyBasename(value) {
  return path.basename(String(value == null ? '' : value));
}

/** `os.path.dirname`（根目录返回自身，与 Python 同） */
export function pyDirname(value) {
  return path.dirname(String(value == null ? '' : value));
}

/** `os.path.getsize`（出错抛，与 Python 同：调用方按 OSError 分档） */
export function pathSize(value) {
  return fs.statSync(value).size;
}

/**
 * `os.path.relpath(path, start)` 的 POSIX 等价。
 * 两处口径差：Node 的 `path.relative` 在同路径时给空串（Python 给 `.`）；`start` 为空串时
 * Python 会抛 ValueError（调用方 `_api_project_file` 已用 `if root_dir else path` 挡掉）。
 * @param {string} target
 * @param {string} start
 * @returns {string}
 */
export function pyRelpath(target, start) {
  const rel = path.relative(String(start), String(target));
  return rel === '' ? '.' : rel;
}

// --------------------------------------------------------------------------
// 文本读与字段解析（lib.py 读侧）
// --------------------------------------------------------------------------

/**
 * `lib.read_text`：读 UTF-8 文本，失败返回空串；**并按 Python 文本模式做 universal newlines**。
 * 末尾 `\r\n`/`\r` 全变 `\n` —— 这条直接影响 bug 报告全文（`content`）与 INDEX/ROUNDS 解析，
 * 是「看起来一样但其实不一样」的典型坑（Windows 上生成的文件会整篇带 `\r`）。
 * @param {string} filePath
 * @returns {string}
 */
export function readText(filePath) {
  let text;
  try {
    text = fs.readFileSync(String(filePath), 'utf8');
  } catch {
    return '';                     // Python 只吞 OSError（含 IsADirectoryError）
  }
  return text.replace(/\r\n?/g, '\n');
}

/** status.md / bug_report.md 字段行：`- **状态**: 失败` 或 `**状态**: 已分析，待修复` */
const FIELD_RE = new RegExp(`^${PY_WS}*(?:-${PY_WS}*)?\\*\\*([^\\n]+?)\\*\\*${PY_WS}*[:：]${PY_WS}*([^\\n]*)$`, 'gm');

/** bug_report.md 里的关联用例编号（`FS0001`） */
export const FS_ID_RE = /FS\d{4}/g;

// --------------------------------------------------------------------------
// 机器契约双语别名表（T14；设计 §5.4）
//
// 机器契约 = status.md / case.md / bug_report.md 的字段名与状态值。英文模板只换 IO 层
// 写法，**内部 canonical 永远是现有中文常量**（消费方一行不用改）；解析时先归一到中文，
// 写回时再按文件已有语言翻回去。
//
// FIELD_ALIASES：字段名（中文 canonical 或英文写法）→ 中文 canonical 键；中文键映射到自身，
// 保证存量中文文件解析逐字段不变。T15 的英文模板字段名取 FIELD_EN 右列。
// STATUS_ALIASES：状态值（中文 canonical 或英文写法）→ 中文 canonical 值；英文写法覆盖
// T15 模板与平台/webui 既有英文（dataLabels.js），ASCII 大小写不敏感。
// 两份表在 backend_py/lib.py 有逐字镜像；任何一端改表都要同步另一端。
// --------------------------------------------------------------------------

const FIELD_ALIASES = {
  // status.md
  状态: '状态',
  Status: '状态',
  最近执行时间: '最近执行时间',
  'Last run time': '最近执行时间',
  'Last run': '最近执行时间',
  执行环境: '执行环境',
  'Execution environment': '执行环境',
  执行轮次: '执行轮次',
  Round: '执行轮次',
  'Execution round': '执行轮次',
  失败原因: '失败原因',
  'Failure reason': '失败原因',
  '关联 bug_report': '关联 bug_report',
  'Related bug_report': '关联 bug_report',
  'Related bug report': '关联 bug_report',
  结果摘要: '结果摘要',
  'Result summary': '结果摘要',
  // case.md
  '用例 ID': '用例 ID',
  'Case ID': '用例 ID',
  接口: '接口',
  Interface: '接口',
  分类: '分类',
  Category: '分类',
  '所属模块/功能': '所属模块/功能',
  'Module / Function': '所属模块/功能',
  'Module/Function': '所属模块/功能',
  测试目标: '测试目标',
  'Test objective': '测试目标',
  'Test goal': '测试目标',
  依据代码: '依据代码',
  'Code reference': '依据代码',
  脚本: '脚本',
  Script: '脚本',
  测试方法: '测试方法',
  'Test method': '测试方法',
  输入参数: '输入参数',
  'Input parameters': '输入参数',
  预期输出: '预期输出',
  'Expected output': '预期输出',
  输出获取方式: '输出获取方式',
  'Output retrieval': '输出获取方式',
  验证逻辑: '验证逻辑',
  'Verification logic': '验证逻辑',
  备注: '备注',
  Note: '备注',
  // bug_report.md
  严重程度: '严重程度',
  Severity: '严重程度',
  报告时间: '报告时间',
  'Reported at': '报告时间',
  'Report time': '报告时间',
  错误签名: '错误签名',
  'Error signature': '错误签名',
  用例名称: '用例名称',
  'Case name': '用例名称',
};

/** 中文 canonical 字段名 → 写回英文文件时优先使用的英文键（set_md_field 用；与上表互补） */
const FIELD_EN = {
  状态: 'Status',
  最近执行时间: 'Last run time',
  执行环境: 'Execution environment',
  执行轮次: 'Round',
  失败原因: 'Failure reason',
  '关联 bug_report': 'Related bug_report',
  结果摘要: 'Result summary',
  '用例 ID': 'Case ID',
  接口: 'Interface',
  分类: 'Category',
  '所属模块/功能': 'Module / Function',
  测试目标: 'Test objective',
  依据代码: 'Code reference',
  脚本: 'Script',
  测试方法: 'Test method',
  输入参数: 'Input parameters',
  预期输出: 'Expected output',
  输出获取方式: 'Output retrieval',
  验证逻辑: 'Verification logic',
  备注: 'Note',
  严重程度: 'Severity',
  报告时间: 'Reported at',
  错误签名: 'Error signature',
  用例名称: 'Case name',
};

/** 中文 canonical 字段名集合（文件主语言判定用） */
const FIELD_ZH_NAMES = new Set(
  Object.keys(FIELD_ALIASES).filter((k) => FIELD_ALIASES[k] === k));

const STATUS_ALIASES = {
  // 中文 canonical → 自身（存量中文文件零变化）
  未执行: '未执行',
  通过: '通过',
  失败: '失败',
  跳过: '跳过',
  需要复测: '需要复测',
  待分析: '待分析',
  '已分析，待修复': '已分析，待修复',
  '已修复（未验证）': '已修复（未验证）',
  复测通过: '复测通过',
  已拒绝: '已拒绝',
  已分析: '已分析',
  '已修复（复测通过）': '已修复（复测通过）',
  复测未通过: '复测未通过',
  '修复完成，待复测': '修复完成，待复测',
  已修复: '已修复',
  // 英文 → 中文 canonical（Case / status.md）
  'Not run': '未执行',
  'Not started': '未执行',
  Pass: '通过',
  Passed: '通过',
  Fail: '失败',
  Failed: '失败',
  Skip: '跳过',
  Skipped: '跳过',
  'Need retest': '需要复测',
  'Needs retest': '需要复测',
  Retest: '需要复测',
  'Retest needed': '需要复测',
  'Pending retest': '需要复测',
  // 英文 → 中文 canonical（bug_report.md；与 webui/src/utils/dataLabels.js 既有英文对齐）
  'To analyze': '待分析',
  'Analyzed, to fix': '已分析，待修复',
  'Analyzed, pending fix': '已分析，待修复',
  'Analyzed, to be fixed': '已分析，待修复',
  'Fixed (unverified)': '已修复（未验证）',
  'Retest passed': '复测通过',
  Rejected: '已拒绝',
  'Rejected (false positive, not a defect)': '已拒绝',
  'Rejected (false positive)': '已拒绝',
  Analyzed: '已分析',
  'Fixed (retest passed)': '已修复（复测通过）',
  'Retest failed': '复测未通过',
  'Fix complete, pending retest': '修复完成，待复测',
  Fixed: '已修复',
};

/** ASCII 大小写不敏感索引（`Pass`/`pass` 都认；中文键不参与，避免改变中文匹配语义） */
const STATUS_ALIASES_LOWER = Object.create(null);
for (const [key, value] of Object.entries(STATUS_ALIASES)) {
  if (/^[\x00-\x7f]*$/.test(key)) STATUS_ALIASES_LOWER[key.toLowerCase()] = value;
}

/** 中文 canonical 状态值 → 写回英文文件时的英文写法（set_md_field 用） */
const STATUS_EN = {
  未执行: 'Not run',
  通过: 'Pass',
  失败: 'Failed',
  跳过: 'Skipped',
  需要复测: 'Needs retest',
  待分析: 'To analyze',
  '已分析，待修复': 'Analyzed, to fix',
  '已修复（未验证）': 'Fixed (unverified)',
  复测通过: 'Retest passed',
  已拒绝: 'Rejected',
  已分析: 'Analyzed',
  '已修复（复测通过）': 'Fixed (retest passed)',
  复测未通过: 'Retest failed',
  '修复完成，待复测': 'Fix complete, pending retest',
  已修复: 'Fixed',
};

// ---------------------------------------------------------------------------
// bug 报告「严重程度」等级（2026-10-25 测试报告等级划分批次）
//
// 等级是报告模板里的固定枚举（bug_report_template.md: 高 / 中 / 低；英文模板
// bug_report_template.en.md: High / Medium / Low），也是产品侧「分级展示/筛选/排序」
// 的唯一分类口径。**中文 canonical 仍是内部值**（与状态字段同口径）：解析时英文写法
// 归一到中文；写回时按目标文件语言取 zh/en 写法。无法识别的自定义值不猜译 ——
// `severityLevel()` 返回空串（界面显示「未分级」），报告正文原样不动。
// 与 backend_py/lib.py 的表逐字镜像；任何一端改表都要同步另一端。
// ---------------------------------------------------------------------------
export const SEVERITY_LEVELS = ['高', '中', '低'];

const SEVERITY_ALIASES = {
  // 中文 canonical → 自身（存量中文文件零变化）
  高: '高',
  中: '中',
  低: '低',
  // 英文 → 中文 canonical（bug_report_template.en.md 的固定枚举；与 i18n/en.json 一致）
  High: '高',
  Medium: '中',
  Low: '低',
};

/** ASCII 大小写不敏感索引（`High`/`high` 都认；中文键不参与） */
const SEVERITY_ALIASES_LOWER = Object.create(null);
for (const [key, value] of Object.entries(SEVERITY_ALIASES)) {
  if (/^[\x00-\x7f]*$/.test(key)) SEVERITY_ALIASES_LOWER[key.toLowerCase()] = value;
}

/** 中文 canonical 等级 → 写回英文文件时的英文写法（set_md_field 用） */
const SEVERITY_EN = { 高: 'High', 中: 'Medium', 低: 'Low' };

/**
 * `lib.severity_level`：严重程度值 → 中文 canonical 等级（高/中/低）；无法识别返回空串。
 *
 * 精确匹配优先，其次 ASCII 大小写不敏感（`High`/`high`）；不做前缀/模糊匹配 ——
 * 未知自定义值不猜译（返回 ''，由调用方按「未分级」处理，文件内容原样不动）。
 * @param {unknown} value
 * @returns {string}
 */
export function severityLevel(value) {
  if (typeof value !== 'string') return '';
  const text = pyStrip(value);
  if (!text) return '';
  if (Object.hasOwn(SEVERITY_ALIASES, text)) return SEVERITY_ALIASES[text];
  const lowered = text.toLowerCase();
  return Object.hasOwn(SEVERITY_ALIASES_LOWER, lowered) ? SEVERITY_ALIASES_LOWER[lowered] : '';
}

/** 严重程度值按目标语言写回：先归一到中文 canonical，再取 zh/en 写法；未知值原样。 */
function severityValueInLang(value, lang) {
  const canonical = severityLevel(value);
  if (Object.hasOwn(SEVERITY_EN, canonical)) {
    return lang === 'en' ? SEVERITY_EN[canonical] : canonical;
  }
  return value;
}

/** 字段名 → 内部中文 canonical 键；未登记字段名原样返回（不丢字段） */
function canonicalField(name) {
  return Object.hasOwn(FIELD_ALIASES, name) ? FIELD_ALIASES[name] : name;
}

/**
 * 状态值 → 中文 canonical；中文 canonical 原样返回；未知值原样返回（不丢）。
 *
 * 精确匹配优先，其次 ASCII 大小写不敏感（`Pass`/`pass`）；不做前缀/模糊匹配，免得把
 * 未知自定义状态误判成平台枚举。
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalStatusValue(value) {
  if (typeof value !== 'string') return value;
  const text = pyStrip(value);
  if (!text) return value;
  if (Object.hasOwn(STATUS_ALIASES, text)) return STATUS_ALIASES[text];
  const lowered = text.toLowerCase();
  return Object.hasOwn(STATUS_ALIASES_LOWER, lowered) ? STATUS_ALIASES_LOWER[lowered] : value;
}

/**
 * `lib.parse_fields`：把 `- **字段**: 值` 列表解析成对象（键统一为内部中文 canonical）。
 *
 * - 英文/中文字段名都识别，归一到中文 canonical 键（同键混写时后者覆盖前者）；
 * - `状态` 字段的英文枚举值归一到中文 canonical（中文/未知值原样）；
 * - 其他字段的值不做任何翻译（用例正文按任务语言书写，原样透传）。
 * 键值都按 Python `str.strip()` 归整；同名键后者覆盖前者（Python dict 赋值同）。
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseFields(text) {
  const out = {};
  for (const m of String(text == null ? '' : text).matchAll(FIELD_RE)) {
    const key = canonicalField(pyStrip(m[1]));
    let value = pyStrip(m[2]);
    if (key === '状态') value = canonicalStatusValue(value);
    out[key] = value;
  }
  return out;
}

/**
 * `lib.norm_status`：状态字段归一化（模板未填写时是 `未执行 / 通过 / ...`，取第一项）。
 *
 * 第一段再经 `STATUS_ALIASES` 归一（英文 `Not run / Pass / ...` 同样取第一项并映射回
 * 中文 canonical）；未知值保留第一段原文，不丢失。
 * @param {unknown} value
 * @returns {string}
 */
export function normStatus(value) {
  const text = value == null ? '' : String(value);
  if (!text) return '未执行';
  return canonicalStatusValue(pyStrip(text.split('/')[0]));
}

/**
 * `lib.parse_status_md`：解析用例 status.md（键序与 Python 返回的 dict 一致）。
 * @param {string} filePath
 * @returns {{status: string, last_run: string, round: string, fail_reason: string,
 *            bug_report: string, summary: string}}
 */
export function parseStatusMd(filePath) {
  const fields = parseFields(readText(filePath));
  return {
    status: normStatus(fields['状态']),
    last_run: fields['最近执行时间'] || '',
    round: fields['执行轮次'] || '',
    fail_reason: fields['失败原因'] || '',
    bug_report: fields['关联 bug_report'] || '',
    summary: fields['结果摘要'] || '',
  };
}

/** 用例目录名：`FS0004_用例名称`（`^...$` 锚定，故 `FS0004_x_y` 也匹配、`FS0004` 单独不匹配） */
export const CASE_DIR_RE = new RegExp(`^(FS\\d{4})_([^\\n]+)$`);

/**
 * `lib.find_case_dirs`：在案例库根下按唯一 id 定位用例目录。
 *
 * `os.walk` 的三条语义逐条对齐：① 跳过隐藏目录（含**不深入**）；② 符号链接目录进
 * 「dirnames」参与用例目录匹配但**不深入**（`followlinks=False`）；③ 找齐 `case_ids`
 * 立即收工。返回按 `id` 升序（Python `sorted(dict.items())` 的元组序 = id 序）。
 * @param {string} root 案例库根
 * @param {string[]} caseIds
 * @returns {Array<[string, string]>} `[[caseId, 绝对目录], ...]`
 */
export function findCaseDirs(root, caseIds) {
  const want = new Set(caseIds || []);
  const found = new Map();
  if (want.size === 0 || !isDir(root)) return [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 先按 os.walk 的 dirnames 语义筛一遍（隐藏项剔除；符号链接保留但不深入）
    const dirs = entries.filter((ent) => {
      if (ent.name.startsWith('.')) return false;
      if (ent.isDirectory()) return true;
      return ent.isSymbolicLink() && isDir(pyJoin(dir, ent.name));
    });
    for (const ent of dirs) {
      const m = CASE_DIR_RE.exec(ent.name);
      if (!m || !want.has(m[1])) continue;
      found.set(m[1], pyJoin(dir, ent.name));
      want.delete(m[1]);
      if (want.size === 0) return;              // Python 找齐即 return（不再递归）
    }
    for (const ent of dirs) {
      if (want.size === 0) return;
      if (ent.isDirectory()) walk(pyJoin(dir, ent.name));
    }
  };

  walk(String(root));
  return [...found.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * `lib.bug_cases`：读 bug 报告全文并提取关联 case id（去重、码点升序）。
 * @param {string} bugDirPath
 * @returns {{content: string, ids: string[]}}
 */
export function bugCases(bugDirPath) {
  const content = readText(pyJoin(bugDirPath, 'bug_report.md'));
  const ids = pySorted(new Set(content.match(FS_ID_RE) || []));
  return { content, ids };
}

/**
 * `lib.runtime_dir`：运行期机器产物目录（`<工作目录>/<name>`）。
 * @param {string} workDir
 * @param {string} name
 * @returns {string}
 */
export function runtimeDir(workDir, name) {
  return pyJoin(workDir, name);
}

/** 运行产物目录名（对齐 `lib.py:RUNTIME_DIR_NAMES`；顺序即 .gitignore 追加序） */
export const RUNTIME_DIR_NAMES = Object.freeze(['.web', '.live', 'board_media']);

/**
 * `lib.ensure_runtime_dirs`：确保 `<工作目录>` 下运行产物目录就绪，并**幂等**维护
 * `.gitignore`（缺哪条补哪条；已有内容——含用户手写的其他规则——一律不动）。
 *
 * 三个刻意的等价点（照 Python）：
 *  - 目录建不出来 / `.gitignore` 写不进去**都不抛错**（后续日志写入自然报启动失败）；
 *  - `.gitignore` 判存在用**整行 strip 后**的集合比对（`"  .web/  "` 也算已有）；
 *  - 追加前若原文非空且**不以换行结尾**，先补一个换行（免把两条规则粘成一行）。
 *
 * @param {string} workDir
 */
export function ensureRuntimeDirs(workDir) {
  for (const name of RUNTIME_DIR_NAMES) {
    try {
      fs.mkdirSync(runtimeDir(workDir, name), { recursive: true });
    } catch { /* 建不出来不抛：与 Python 同（后续写入自然失败） */ }
  }
  const gi = pyJoin(workDir, '.gitignore');
  try {
    const text = readText(gi);
    const lines = new Set(text.split('\n').map((ln) => ln.trim()));
    const missing = RUNTIME_DIR_NAMES.filter((name) => !lines.has(`${name}/`));
    if (missing.length) {
      const head = text && !text.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(gi, `${head}${missing.map((n) => `${n}/`).join('\n')}\n`, 'utf8');
    }
  } catch { /* 读不到/写不进不抛：与 Python 同 */ }
}

// --------------------------------------------------------------------------
// 目录浏览与项目文件读取（server.py 的同名函数）
// --------------------------------------------------------------------------

/** 目录浏览 API 单目录子目录数上限：防超大目录拖垮响应（对齐 `server.py:FS_BROWSE_LIMIT`） */
export const FS_BROWSE_LIMIT = 500;

/** 项目文件预览读取上限：超出只给前 256KB 并置 truncated（对齐 `server.py:FILE_PREVIEW_MAX`） */
export const FILE_PREVIEW_MAX = 256 * 1024;

/** 原文下载上限：超过拒绝（对齐 `server.py:FILE_RAW_MAX`） */
export const FILE_RAW_MAX = 32 * 1024 * 1024;

/**
 * `fs_roots`：按服务端平台返回目录浏览的根路径列表。
 * Windows 逐盘符 A:~Z: 探测实际存在的盘符根；Linux/macOS 单根 `/`。
 * @returns {string[]}
 */
export function fsRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let i = 0; i < 26; i += 1) {
      const letter = String.fromCharCode(65 + i);
      if (pathExists(`${letter}:\\`)) roots.push(`${letter}:\\`);
    }
    return roots.length ? roots : ['C:\\'];
  }
  return ['/'];
}

/** `os.path.normcase`（POSIX 恒等；Windows 转反斜杠并小写） */
function normcase(value) {
  const text = String(value);
  return process.platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text;
}

/**
 * `_within_root`：path 是否等于 root 或位于 root 之内（调用前双方均须 realpath 规范化）。
 * @param {string} value
 * @param {string} root
 * @returns {boolean}
 */
export function withinRoot(value, root) {
  const p = String(value == null ? '' : value);
  const r = String(root == null ? '' : root);
  if (!p || !r) return false;
  const np = normcase(p);
  const nr = normcase(r.replace(/[/\\]+$/, ''));
  return np === nr || np.startsWith(`${nr}${path.sep}`);
}

/** 浏览器平台名（对齐 Python：`os.name == "nt"` → windows，darwin → macos，其余 linux） */
function platformName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/**
 * `fs_browse`：列出一个目录下的子目录（不含文件），供前端目录选择对话框浏览。
 *
 * 返回 `platform/roots/path/parent/dirs`；`rawPath` 为空时是根视角（dirs 即根列表）；
 * 目录不存在或不可读返回 `null`（调用方 400）。条目用 **stat 跟随符号链接**判定目录
 * （Python `entry.is_dir()` 的默认行为），坏条目跳过而不中断整个列举。
 *
 * `parent` 三态（2026-10-22，卡 1044「目录选择支持选盘符」，与 `server.py:fs_browse` 逐点对齐）：
 *   - 普通字符串：上级目录；
 *   - 空串 `''`：当前是**文件系统根**（Windows 盘符根如 `D:\` / POSIX 根 `/`）⇒ 前端「上级」
 *     进入根视角（Windows = 盘符列表「此电脑」），从盘符内部也能切到别的盘 / 选盘符；
 *   - `null`：当前就是根视角（盘符/根列表），无处可上。
 * @param {string} rawPath
 * @returns {{platform: string, roots: string[], path: string, parent: string|null,
 *            dirs: Array<{name: string, path: string}>}|null}
 */
export function fsBrowse(rawPath) {
  const platform = platformName();
  const roots = fsRoots();
  if (!pyStrip(rawPath)) {
    return { platform, roots, path: '', parent: null, dirs: roots.map((r) => ({ name: r, path: r })) };
  }
  const dirPath = realpathOrResolve(rawPath);
  if (!isDir(dirPath)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = [];
  for (const ent of entries) {
    try {
      const full = pyJoin(dirPath, ent.name);
      // Python `entry.is_dir()` 跟随符号链接且可能抛 OSError（无权限/已失效）⇒ 跳过该条目
      if (ent.isDirectory() || (ent.isSymbolicLink() && isDir(full))) {
        dirs.push({ name: ent.name, path: full });
      }
    } catch {
      continue;
    }
    if (dirs.length >= FS_BROWSE_LIMIT) break;
  }
  dirs.sort((a, b) => pyStrCompare(a.name, b.name));
  let parent = pyDirname(dirPath);
  if (parent === dirPath) parent = '';       // 文件系统根 ⇒「上级」进根视角（盘符/根列表）
  return { platform, roots, path: dirPath, parent, dirs };
}

/**
 * `resolve_project_file`：把会话里出现的路径解析为项目范围内可读的文件（越界不读）。
 *
 * 解析规则（与 agent CLI 的 cwd=project_dir 一致）：绝对路径原样规范化；相对路径先按
 * `<项目目录>`、再按 `<工作目录>` 拼接；两侧都存在时项目目录优先。
 *
 * @param {object} project 项目行（需 `project_dir` / `work_dir`）
 * @param {string} rawPath 原始路径（会话里出现的形态）
 * @returns {{path: string|null, rootKey: ''|'project'|'work',
 *            err: ''|'empty'|'outside'|'dir'|'missing'}}
 *   `err='outside'` 表示落在两个根之外（含 `../` 穿越与任意系统路径），调用方一律 403。
 */
export function resolveProjectFile(project, rawPath) {
  const raw = pyStrip(rawPath);
  if (!raw) return { path: null, rootKey: '', err: 'empty' };
  const roots = [];
  for (const [key, value] of [['project', project.project_dir], ['work', project.work_dir]]) {
    const dir = pyStrip(value);
    if (dir) roots.push([key, realpathOrResolve(dir)]);
  }
  const candidates = [];
  if (pyIsAbs(raw)) {
    candidates.push([null, realpathOrResolve(raw)]);
  } else {
    for (const [key, root] of roots) candidates.push([key, realpathOrResolve(pyJoin(root, raw))]);
  }
  const inside = candidates.filter(([, p]) => roots.some(([, root]) => withinRoot(p, root)));
  const outside = candidates
    .filter(([key, p]) => !inside.some(([k, q]) => k === key && q === p))
    .map(([, p]) => p);
  for (const cand of inside) {
    let [key, p] = cand;
    if (isFile(p)) {
      // 绝对路径命中时归属按「包含它的根」判定（file 视图里显示相对路径要用 root_key）
      if (key === null) {
        const hit = roots.find(([, root]) => withinRoot(p, root));
        key = hit ? hit[0] : '';
      }
      return { path: p, rootKey: key, err: '' };
    }
  }
  for (const [key, p] of inside) {
    if (pathExists(p)) return { path: p, rootKey: key || '', err: 'dir' };
  }
  if (inside.length) return { path: inside[0][1], rootKey: '', err: 'missing' };
  return { path: outside.length ? outside[0] : raw, rootKey: '', err: 'outside' };
}

/** 严格 UTF-8 解码（`ignoreBOM: true`：Node 的 TextDecoder 默认**吃掉**开头 BOM，Python 不会） */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * `read_text_preview`：读文件前 `limit` 字节并按 UTF-8 解码。
 *
 * 二进制判定：含 NUL 字节，或非 UTF-8（**截断切断多字节字符时先退 1~3 字节重试**，
 * 否则「刚好切在半个汉字上」会被误判成二进制）；二进制不返回内容。
 * 注意本函数读的是**原始字节**（Python 侧 `open(path,"rb")`）⇒ 不做换行转换。
 * @param {string} filePath
 * @param {number} [limit]
 * @returns {{text: string, size: number, truncated: boolean, binary: boolean}}
 */
export function readTextPreview(filePath, limit = FILE_PREVIEW_MAX) {
  const size = pathSize(filePath);                 // 抛 OSError ⇒ 调用方按 404 处理
  const fd = fs.openSync(filePath, 'r');
  let data;
  try {
    const buf = Buffer.allocUnsafe(limit + 1);
    const n = fs.readSync(fd, buf, 0, limit + 1, 0);
    data = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  const truncated = data.length > limit;
  if (truncated) data = data.subarray(0, limit);
  if (data.includes(0)) return { text: '', size, truncated, binary: true };
  try {
    return { text: STRICT_UTF8.decode(data), size, truncated, binary: false };
  } catch {
    if (truncated) {
      for (const drop of [1, 2, 3]) {
        try {
          const cut = data.subarray(0, Math.max(0, data.length - drop));
          return { text: STRICT_UTF8.decode(cut), size, truncated, binary: false };
        } catch {
          continue;
        }
      }
    }
    return { text: '', size, truncated, binary: true };
  }
}

// --------------------------------------------------------------------------
// git 摘录（`lib.git_log_changes`，M6-4 随 prompts.js 一起落地）
// --------------------------------------------------------------------------

/**
 * Python `str.splitlines()` 的切分点：比 `split("\n")` 多切 `\v \f \x1c-\x1e \x85 \u2028 \u2029`
 * （`\r\n`/`\r` 已被下面的 universal-newlines 折成 `\n`，这里只需覆盖其余八个）。
 *
 * 为什么值得单独一条：`git log --pretty=… --name-only` 的每个提交块都走它切行，
 * 一条含 `\x0b` 的提交标题在两版下会切成不同的行数 ⇒ 提交行/文件行错位。
 */
const PY_SPLITLINES_RE = /\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/;

/**
 * Python `text[:n]` 的**码点**切片。
 *
 * 为什么 lib.js 自带一份而不 import rag.js 的 `pySliceCodePoints`：rag.js **import 本文件**
 * （用 `pyJoin`/`readText`/…），反向 import 会成环。两处实现同一语义，各自的文件头已互相备案。
 */
function sliceCodePoints(text, n) {
  const cps = Array.from(String(text));
  return cps.slice(0, n).join('');
}

/**
 * `lib.git_log_changes`：摘录日期范围（`YYYY-MM-DD`，空=不限）内的 git 提交与变更文件。
 *
 * 逐点对齐 `lib.py:215-244`：
 *  ① 命令与参数顺序逐字照抄（`-C`/`-c core.quotepath=false`/`--pretty=format:%x00%h %ad %an %s`/
 *     `--date=short`/`--name-only`；`--since`/`--until` 只在非空时追加，且补 ` 00:00:00`/` 23:59:59`）；
 *  ② 返回 `{ok: true, commits, files}` / `{ok: false, error}`——**非 git 仓库/git 不可用/无提交
 *     一律 `ok:false` 静默降级**，不抛异常（`prompts._date_range_ctx` 据此给降级文案）；
 *  ③ 提交块以 `\x00` 分隔（文件名不会含 NUL），块首行是提交头、其余行是变更文件；
 *     空块（连续 NUL / 尾部 NUL）与「只含空白的行」跳过；
 *  ④ `files` 去重后按**码点**升序（`pyStrCompare`：JS 默认的 UTF-16 码元序在星平面字符上会分叉）；
 *  ⑤ `commits[:limit]` 截断的是**提交条数**，与 `files` 无关；
 *  ⑥ `stderr` 先按 Python `str.strip()` 裁、再按**码点**截 300；
 *  ⑦ stdout 按文本模式读 ⇒ 与 `readText` 同一条 universal-newlines 折行（Python `text=True` 的行为）。
 *
 * 已知残余差异（备案，不修）：
 *  - `git` 不在 PATH 时 Python 给 `git 不可用: [Errno 2] No such file or directory: 'git'`、
 *    Node 给 `git 不可用: spawnSync git ENOENT`——两侧**都降级**但文案不同；该分支不进对拍判据
 *    （真跑 git 拿不到这个形态，除非把 PATH 清空）。
 *  - `timeout=20s` 的超时文案同理（Python `Command '…' timed out after 20 seconds`）。
 *
 * @param {string} projectDir 项目目录（`git -C` 的目标）
 * @param {string} [dateFrom] `YYYY-MM-DD`，空=不限
 * @param {string} [dateTo] `YYYY-MM-DD`，空=不限
 * @param {number} [limit] 提交条数上限（默认 100，照 Python）
 * @returns {{ok: true, commits: string[], files: string[]} | {ok: false, error: string}}
 */
export function gitLogChanges(projectDir, dateFrom = '', dateTo = '', limit = 100) {
  const cmd = ['-C', String(projectDir), '-c', 'core.quotepath=false', 'log',
    '--pretty=format:%x00%h %ad %an %s', '--date=short', '--name-only'];
  if (dateFrom) cmd.push(`--since=${dateFrom} 00:00:00`);
  if (dateTo) cmd.push(`--until=${dateTo} 23:59:59`);
  // 不传 env：继承本进程环境（照 subprocess.run 的缺省）——harness 的 GIT_ENV 与单测里
  // 放在 PATH 前端的「假 git」都靠这条继承生效。
  const p = spawnSync('git', cmd, { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  if (p.error) return { ok: false, error: `git 不可用: ${p.error.message}` };
  if (p.status !== 0) return { ok: false, error: sliceCodePoints(pyStrip(p.stderr ?? ''), 300) };
  const stdout = String(p.stdout ?? '').replace(/\r\n?/g, '\n');   // 见 ⑦
  const commits = [];
  const files = [];
  for (const blk of stdout.split('\x00')) {
    const lines = blk.split(PY_SPLITLINES_RE).filter((ln) => pyStrip(ln) !== '');
    if (!lines.length) continue;
    commits.push(lines[0]);
    for (const ln of lines.slice(1)) files.push(ln);
  }
  return { ok: true, commits: commits.slice(0, limit), files: pySorted(new Set(files)) };
}

/**
 * `lib.git_recent_commits`：摘录最近 `limit` 条提交（提交时间倒序，**逐条保留变更文件归属**）。
 *
 * 逐点对齐 `lib.py:git_recent_commits`：
 *  ① 命令：`log -n <limit> --pretty=format:%x00%h%x09%ad%x09%s --date=short --name-only`
 *     —— 块首行用 **TAB** 分隔 hash/日期/标题（标题含空格，不能按空格切）；
 *  ② 返回 `{ok:true, commits:[{hash,date,subject,files[]}]}`；
 *     非 git/失败一律 `{ok:false,error}` 静默降级（调用方 `prompts` 给降级文案）；
 *  ③ 每个提交块以 `\x00` 分隔；块首行形态异常（少于 3 段）整块跳过，不产半条记录；
 *  ④ 同一提交内重复文件名只留一次（按首次出现顺序）；空块/纯空白行跳过；
 *  ⑤ stdout 按文本模式读（`\r\n`→`\n`），stderr 按 Python `strip()` 裁、码点截 300；
 *  ⑥ `limit` 直接以字符串进 `-n`（生产/对拍都传整数；Python 侧 `int(limit)` 对整数同值）。
 *
 * 与 `gitLogChanges` 的区别：不看日期范围、按条数取最近提交，且不把文件摊平
 * ——探索任务要按「功能」聚类最近改动，必须知道每个文件是哪次提交改的。
 *
 * @param {string} projectDir 项目目录（`git -C` 的目标）
 * @param {number} [limit] 提交条数上限（默认 30）
 * @returns {{ok: true, commits: {hash: string, date: string, subject: string, files: string[]}[]}
 *   | {ok: false, error: string}}
 */
export function gitRecentCommits(projectDir, limit = 30) {
  const cmd = ['-C', String(projectDir), '-c', 'core.quotepath=false', 'log',
    '-n', String(limit),
    '--pretty=format:%x00%h%x09%ad%x09%s', '--date=short', '--name-only'];
  // 不传 env：继承本进程环境（照 subprocess.run 的缺省）——对拍的固定 GIT_ENV 靠这条继承生效。
  const p = spawnSync('git', cmd, { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  if (p.error) return { ok: false, error: `git 不可用: ${p.error.message}` };
  if (p.status !== 0) return { ok: false, error: sliceCodePoints(pyStrip(p.stderr ?? ''), 300) };
  const stdout = String(p.stdout ?? '').replace(/\r\n?/g, '\n');
  const commits = [];
  for (const blk of stdout.split('\x00')) {
    const lines = blk.split(PY_SPLITLINES_RE).filter((ln) => pyStrip(ln) !== '');
    if (!lines.length) continue;
    const parts = lines[0].split('\t');
    if (parts.length < 3) continue;    // 头部形态异常：整块跳过
    const files = [];
    for (const ln of lines.slice(1)) {
      if (!files.includes(ln)) files.push(ln);
    }
    commits.push({ hash: parts[0], date: parts[1], subject: parts.slice(2).join('\t'), files });
  }
  return { ok: true, commits };
}

// --------------------------------------------------------------------------
// 案例库写口与固化判定（`lib.py:50-109 / 176-212`，M6-6 接线前补齐）
//
// 为什么要补齐：`runner` 的轮次执行体（复测前置标记 / 收尾判通过）与
// `POST /api/projects/<pid>/bugs/<dir>/reject`（改 bug 报告状态）都要用这几个口；
// 此前 `tasks.js` 里有一份就地私有的 `bug_cases_scripted`（其注释自认「M6 落地后应换成
// lib 的导出」），本批归位。
// --------------------------------------------------------------------------

/** 已固化复测脚本文件名（`lib.py:177`）：用例目录内存在该文件即视为已固化（文件即事实，无登记表） */
export const VERIFY_SCRIPT_NAME = 'verify.py';

/** 正则元字符转义（`re.escape` 的等价物，只覆盖本文件用到的 `**字段**` 形态） */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 文件主语言：按已登记字段行的语言计数（英文写法 vs 中文 canonical），平局按 zh。 */
function fieldLang(text) {
  let zh = 0;
  let en = 0;
  for (const m of String(text).matchAll(FIELD_RE)) {
    const name = pyStrip(m[1]);
    if (FIELD_ZH_NAMES.has(name)) {
      zh += 1;
    } else if (Object.hasOwn(FIELD_ALIASES, name) && FIELD_ZH_NAMES.has(FIELD_ALIASES[name])) {
      en += 1;
    }
  }
  return en > zh ? 'en' : 'zh';
}

/**
 * 目标字段的写回语言与实际字段名。
 *
 * 优先级：目标字段只在英文写法里出现 → en；只在中文写法里出现 → zh；两边都有 / 都不存在
 * （混写或缺失）→ 文件主语言 `fieldLang`（平局按 zh）。英文侧返回文件里实际使用的写法
 * （保留作者用词），字段缺失时用 `FIELD_EN` 的规范英文键。
 * @param {string} text
 * @param {string} canonical 中文 canonical 字段名
 * @returns {[('zh'|'en'), string]} `[语言, 实际写回的字段名]`
 */
function targetFieldLang(text, canonical) {
  let zhHit = false;
  let enHit = false;
  let enName = '';
  for (const m of String(text).matchAll(FIELD_RE)) {
    const name = pyStrip(m[1]);
    if (name === canonical) {
      zhHit = true;
    } else if (Object.hasOwn(FIELD_ALIASES, name) && FIELD_ALIASES[name] === canonical) {
      enHit = true;
      enName = name;
    }
  }
  if (enHit && !zhHit) return ['en', enName];
  if (zhHit && !enHit) return ['zh', canonical];
  if (fieldLang(text) === 'en') return ['en', enName || FIELD_EN[canonical] || canonical];
  return ['zh', canonical];
}

/** 状态值按目标语言写回：先归一到中文 canonical，再取 zh/en 写法；未知值原样。 */
function statusValueInLang(value, lang) {
  const canonical = canonicalStatusValue(value);
  if (Object.hasOwn(STATUS_EN, canonical)) {
    return lang === 'en' ? STATUS_EN[canonical] : canonical;
  }
  return value;
}

/**
 * `lib.set_md_field`：改写 md 里所有 `- **字段**: 值` 同名字段行；行不存在时在文末追加。
 *
 * 字段名先经 `FIELD_ALIASES` 归一到内部中文 canonical；写回语言跟随**目标字段已有写法**
 * （英文行 → 英文键 + 英文值；中文行 → 中文键 + 中文值）。目标字段缺失或中英两种
 * 写法并存时跟随文件主语言（`fieldLang`，平局按 zh）。只有 `状态` 与 `严重程度` 两个
 * 字段的值做语言换算（其他字段值原样写入：时间/环境标签/摘要等）。行不存在时按目标语言
 * 在文末追加。保留原行前缀/格式/编码/换行。返回是否写入成功（文件不存在/读空返回 false）。
 *
 * 多行同名字段全替换（`g` + 回调）与 Python `pattern.sub` 一致（KB-20）。
 * 与 Python 的唯一形态差异（**实际不可达**，备案）：Python 的 `pattern.sub(new_line, text)`
 * 会把替换串里的 `\1` 当组引用解释；这里用回调（`prefix + value`），值里的反斜杠是字面量。
 * 本口的值只有状态/严重程度/时间/环境标签/摘要，且状态值与等级值均不含反斜杠，故无分叉。
 */
export function setMdField(filePath, field, value) {
  const text = readText(filePath);
  if (!text) return false;
  const canonical = Object.hasOwn(FIELD_ALIASES, field) ? FIELD_ALIASES[field] : field;
  const [lang, writeField] = targetFieldLang(text, canonical);
  let writeValue = value;
  if (canonical === '状态' && typeof value === 'string') {
    writeValue = statusValueInLang(value, lang);
  } else if (canonical === '严重程度' && typeof value === 'string') {
    writeValue = severityValueInLang(value, lang);
  }
  const pattern = new RegExp(
    `^(\\s*(?:-\\s*)?\\*\\*${escapeRegExp(writeField)}\\*\\*\\s*[:：]\\s*).*$`, 'gm',
  );
  const out = pattern.test(text)
    ? text.replace(pattern, (matched, prefix) => prefix + String(writeValue))
    : `${text.replace(/\n+$/, '')}\n\n- **${writeField}**: ${writeValue}\n`;
  try {
    fs.writeFileSync(filePath, out, 'utf8');
    return true;
  } catch {
    return false;      // 写不进去不抛（照 Python `except OSError`）
  }
}

/**
 * `lib.mark_cases_retest`：把关联 case 的 `status.md` 状态改成「需要复测」（复测任务开始前调）。
 * 返回**改成功**的 case id 列表（找不到目录/写不进去的 id 不进结果）。
 */
export function markCasesRetest(root, caseIds) {
  const paths = [];
  for (const [cid, dir] of findCaseDirs(root, caseIds)) {
    if (setMdField(pyJoin(dir, 'status.md'), '状态', '需要复测')) paths.push(cid);
  }
  return paths;
}

/**
 * `lib.cases_all_passed`：关联 case 是否**全部**「通过」。
 *
 * 有 id 定位不到目录时视为未通过（`lib.py:117-120` 的理由：否则「找不到」被静默忽略，
 * 剩下找到的全通过就会误判整体通过——bug 报告引用不存在/改名案例的场景）。
 */
export function casesAllPassed(root, caseIds) {
  if (!caseIds || caseIds.length === 0) return false;
  const dirs = findCaseDirs(root, caseIds);
  if (dirs.length !== new Set(caseIds).size) return false;
  for (const [, dir] of dirs) {
    if (parseStatusMd(pyJoin(dir, 'status.md')).status !== '通过') return false;
  }
  return true;
}

/**
 * `lib.bug_cases_scripted`：用例集合是否**全部已固化**（每个用例目录里都有 `verify.py`）。
 *
 * 全部固化且用例数 > 0 才 True；任一未固化 / 有 id 定位不到目录 / 集合为空 ⇒ False
 * （调用方回落 agent 复测路径）。`verify.py` 是**目录**不算固化（`os.path.isfile` 口径）。
 */
export function bugCasesScripted(casesRoot, caseIds) {
  const dirs = findCaseDirs(casesRoot, caseIds);
  if (dirs.length === 0 || dirs.length !== new Set(caseIds).size) return false;
  return dirs.every(([, dir]) => isFile(pyJoin(dir, VERIFY_SCRIPT_NAME)));
}

/**
 * `lib.ensure_gitignore(base_dir, entry)`：在 `<base_dir>/.gitignore` 幂等追加一行忽略项。
 *
 * 与 `ensureRuntimeDirs` 的 .gitignore 维护同构：已有内容（含用户手写规则）一律不动；
 * `base_dir` 不存在时顺带创建；写不进去不抛错。
 */
export function ensureGitignore(baseDir, entry) {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch {
    return;
  }
  const gi = pyJoin(baseDir, '.gitignore');
  const text = readText(gi);
  const lines = new Set(text.split(/\r\n|\r|\n|\u2028|\u2029/).map((ln) => ln.trim()));
  if (lines.has(String(entry))) return;
  try {
    const head = text && !text.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gi, `${head}${entry}\n`, 'utf8');
  } catch { /* 写不进不抛：与 Python 同 */ }
}

// --------------------------------------------------------------------------
// M6.9：项目命名 / 目录新建（server.py 的三个纯函数）
// --------------------------------------------------------------------------

/**
 * Python `bool(x)` 的真值口径，用于 `(value or "")`。
 *
 * 为什么不直接写 `value || ''`：JS 的 `[]`/`{}` 是**真**，而 Python 的空 list/dict 是假
 * （`normalize_project_name({})` 在 Python 给 `"project"`、在错实现下给 `"[object Object]"`）。
 * 与 `rag.js:pyTruthy` 同表；这里**不 import 它**是模块图原因：`rag.js` 已经
 * `import ... from './lib.js'`，反向 import 会成环（db.js / builtin-assets.js 也是各自私有的
 * 同款小函数，属既有约定）。
 * 注：`NaN` 在 Python 里是真（`float('nan')`），本函数按 JS 口径判假 —— 差异只在「直接传
 * NaN」时成立，JSON 解不出 NaN，路由入参不可能走到。
 * @param {unknown} value
 * @returns {boolean}
 */
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

/** Python `(value or "")`：假值一律回落空串（其余原样返回，类型不变） */
function pyOrEmpty(value) {
  return pyTruthy(value) ? value : '';
}

/**
 * `normalize_project_name(name)`：项目名规范化——去两端空白、斜杠防路径穿越。
 * 对齐 `server.py:815`：`(name or "").strip().replace("/", "_").replace("\\", "_")`，
 * 结果为空则回落 `"project"`。空值/假值（`0`/`False`/`[]`/`{}`）走 Python 的 `or ""`。
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeProjectName(name) {
  const text = pyStrip(pyOrEmpty(name));
  return text.replace(/\//g, '_').replace(/\\/g, '_') || 'project';
}

/**
 * `path_last_segment(path)`：取路径最后一段（项目名称留空时的自动命名来源）。
 * 对齐 `server.py:825`：先 `(path or "").strip()`，再按 `/` 与 `\` 的**连续串**切分
 * （`re.split(r"[\\/]+", ...)`，空段滤掉），从尾往前找第一个**非纯盘符段**
 * （`re.fullmatch(r"[A-Za-z]:", seg)` 的形态，如 `D:`）；找不到返回空串。
 * @param {unknown} pathValue
 * @returns {string}
 */
export function pathLastSegment(pathValue) {
  const text = pyStrip(pyOrEmpty(pathValue));
  const segs = text.split(/[\\/]+/).filter((s) => s !== '');
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (!/^[A-Za-z]:$/.test(segs[i])) return segs[i];
  }
  return '';
}

/**
 * `fs_mkdir(raw_path, raw_name)`：在指定目录下新建一个子目录（目录选择对话框「新建文件夹」）。
 * 对齐 `server.py:968`，返回**二元组** `[data, err]`：
 *   - 成功 `[{name, path}, null]`；`path` 是新目录的绝对路径（realpath）
 *   - 失败 `[null, 原因]`——直接展示给用户，故文案逐字照抄 Python（中文）。
 *     固定文案是**字符串**（本身即词条 key）；`新建失败：<OS 原因>` 是**插值文案**，
 *     返回 `messageVars('新建失败：{detail}', {detail})` 的 `{message, vars}` 对象
 *     （T10 R18 契约；路由层原样交给 `ctx.errorSpaced` 按请求语言渲染）。
 *
 * 逐条对齐的判据（顺序也照抄，先父目录后名称）：
 *   1. 父目录：`(raw_path or "").strip()` 为空、或 `realpath` 后不是目录 ⇒ 拒；
 *   2. 名称：`(raw_name or "").strip()`；空 ⇒ 拒；
 *   3. 名称是 `.`/`..`、含 `/` 或 `\`、含 NUL ⇒ 拒；
 *   4. `name != name.rstrip(". ")`（结尾是点或空格，任意组合）⇒ 拒 —— Windows 会截掉结尾
 *      点/空格，跨平台统一拒绝。注：结尾**空白**已被上面 `strip()` 吃掉，所以这条实际只对
 *      结尾的 `.` 生效（`"x "` → `"x"` 合法）；
 *   5. `os.path.lexists(target)`：**存在即可、不看类型、不跟随符号链接** ⇒ Node 用 `lstatSync`
 *      （`fs.existsSync` 会漏掉悬空符号链接，与 Python 分叉）；不覆盖、不静默复用；
 *   6. `os.mkdir(target)`，`OSError` ⇒ `"新建失败：<原因>"`。
 *
 * ── 与 Python 的差异（如实登记，别当 bug 修） ────────────────────────────────────
 *   - **`OSError` 的原因文案不可能逐字节相同**：Python `e.strerror` 是 errno 的英文文案
 *     （如 `File name too long` / `Permission denied`），Node 的 fs 错误**没有 `strerror`
 *     字段**（实测 `err.strerror === undefined`，只有 `errno`/`code`/`syscall`/`path`），
 *     其 `err.message` 形如 `ENAMETOOLONG: name too long, mkdir '/tmp/x/y'`。这里用
 *     `err.message`（不硬编假文案），故该分支只保证前缀 `新建失败：` 相同；
 *   - `os.path.realpath` 的符号链接展开：存在路径上 `realpathSync` 与 Python 等价
 *     （父目录是符号链接时会落到真身并返回解析后的路径）；`realpathOrResolve` 对**不存在**
 *     路径的近似差异见本文件头「已知有意保留的差异」。
 * @param {unknown} rawPath 父目录（可为前端传来的相对/带尾斜杠形态）
 * @param {unknown} rawName 新目录名（单级）
 * @returns {[{name: string, path: string}|null, string|{message: string, vars: object|null}|null]}
 */
export function fsMkdir(rawPath, rawName) {
  let parent = pyStrip(pyOrEmpty(rawPath));
  if (!parent || !isDir(realpathOrResolve(parent))) {
    return [null, '请先进入一个存在的目录再新建文件夹'];
  }
  parent = realpathOrResolve(parent);
  const name = pyStrip(pyOrEmpty(rawName));
  if (!name) return [null, '文件夹名称不能为空'];
  if (name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\x00')) {
    return [null, '文件夹名称不能包含路径分隔符，也不能是 . 或 ..'];
  }
  if (name !== name.replace(/[. ]+$/, '')) {   // str.rstrip(". ")：结尾点/空格一律拒
    return [null, '文件夹名称不能以点或空格结尾'];
  }
  const target = pyJoin(parent, name);
  try {
    fs.lstatSync(target);                      // os.path.lexists：悬空符号链接也算存在
    return [null, '同名文件或目录已存在'];
  } catch { /* 不存在 ⇒ 继续创建 */ }
  try {
    fs.mkdirSync(target);
  } catch (e) {                                // 无写权限/名称过长等，回给用户看原因
    const detail = e && e.message ? e.message : e;
    return [null, messageVars('新建失败：{detail}', { detail })];
  }
  return [{ name, path: realpathOrResolve(target) }, null];
}

/**
 * 飞书回显掩码：`server.py:1727 _mask_webhook` 的逐字复刻。
 *
 * Python 原式 `return url if len(url) <= 48 else url[:48] + "…"`——**口径是码点不是
 * UTF-16 单元**（`len()` 数的是 str 的字符）。实测边界（M7 侦察，oracle 逐字测）：
 * 47 ASCII + 1 emoji（码点 48）⇒ **不打码**；48 ASCII + 1 emoji（码点 49）⇒ 打码；
 * 50 个中文 ⇒ 前 48 字 + `…`。用 `String.length` 会在代理对处差 1。
 * 空值口径照抄 `if not url: return ""`（`""`/`null`/`undefined`/`0` 都回空串）。
 *
 * 用处：`GET /api/me/feishu-cfg` 的 `default_webhook`、`GET /api/me/feishu/outbox`
 * 的 `target`、`GET /api/projects/<n>/feishu-hook` 的 `webhook_url`（三处同一函数）。
 * @param {unknown} url
 * @returns {string}
 */
export function maskWebhook(url) {
  if (!url) return '';
  const text = String(url);
  const codePoints = Array.from(text);
  return codePoints.length <= 48 ? text : codePoints.slice(0, 48).join('') + '…';
}

/**
 * 飞书绑定号掩码：`server.py:2129` 的内联式 `oid[:6] + "…" if len(oid) > 6 else oid`。
 * 同样按**码点**切（实测：8 码点中文 ⇒ 前 6 字 + `…`；`""` 原样回空串）。
 * @param {unknown} openId
 * @returns {string}
 */
export function maskOpenId(openId) {
  const text = openId == null ? '' : String(openId);
  const codePoints = Array.from(text);
  return codePoints.length > 6 ? codePoints.slice(0, 6).join('') + '…' : text;
}
