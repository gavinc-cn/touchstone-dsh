/**
 * `prompts.py`（666 行，仓库根）的 Node 对应物（Node 后端 M6-4）。
 *
 * Touchstone 每轮 prompt 模板：首轮携带完整约束（案例库根/bug_report 目录/阅读范围/选项/红线），
 * 常规测试轮再注入内置流程文档与文件模板（`builtin_prompts/free_style/`），续轮只发短 prompt。
 * 七类 `task_type` 决定首轮文案：normal / regression / stress / fix / retest_bug / reject / pipeline
 * （空值与未知类型回落 normal）。
 *
 * ── 导出名 ────────────────────────────────────────────────────────────────────
 * 主名**照 Python 名**（`first_round_prompt`/`_load_asset`/…，含私有函数的下划线前缀），文件末尾
 * 再给一套 camelCase 别名（`firstRoundPrompt`/…）供 JS 调用方使用——与 `rag.js`（M6-3）同一条
 * 约定。对拍用例的 `fn` 写 Python 名、`nodeFn` 逐条指向本文件的导出名，不靠命名巧合。
 *
 * ── 与 Python 的四处**形态**差异（都已在调用方或量具里显式对齐） ─────────────────
 * ① **异步**：`_semantic_order` 要调 `rag.retrieve_detail`（Node 侧只有异步的 `fetch`）⇒
 *    `_semantic_order` / `retest_range_prompt` / `retest_prompt` / `first_round_prompt`
 *    返回 Promise（其余函数保持同步）。`await` 一个同步值无害，对拍器（`mod-run.mjs`）对两侧
 *    都 `await fn(...)`，故这条不产生可观察差异；**但 JS 调用方必须 `await`**。
 * ② **元组 → 数组**：Python 的 `(目录名, 全文)` 在 JS 侧就是 `[目录名, 全文]`（不用对象），
 *    对拍无需 `shape` 适配；`None` 照旧 `null`。
 * ③ **错误类型**：`RuntimeError` / `NameError` 在本文件有同名 JS 类，`KeyError` / `ValueError` /
 *    `AttributeError` 复用 `rag.js` 的同名类（`constructor.name` 与 Python `type(exc).__name__`
 *    逐字相同），故「两侧同抛」的对拍分支能比 `$kind`；**消息也逐字照抄**（含中文文案与
 *    `tuple.index(x): x not in tuple`、`'list' object has no attribute 'get'` 这类 Python 原话）。
 * ④ **`_ASSET_DIR` 由 `import.meta.url` 推出**：Python 是
 *    `dirname(abspath(__file__)) + builtin_prompts/free_style`；本文件在 `backend/lib/` 下，
 *    故先上溯两级到仓库根再拼同样的两段。两侧最终指向**同一个真实目录**（`builtin_prompts/`
 *    不在 `backend/` 里），所以「资产缺失」的错误文案里那条绝对路径两侧逐字节相同。
 *
 * ── 逐点等价的口径（每条都对着 Python 源码核过） ─────────────────────────────────
 * 1. **`(x or "").strip()`**：一处不落地走 `stripOrEmpty`（`pyTruthy` 决定 `or`，`pyStrip` 是
 *    Python 的空白集合）——`env_label`/`guide_text`/`skill_*`/`extra`/`date_from`/`date_to`
 *    共十处，任何一处写成 JS 的 `||`/`.trim()` 都会在「空串 vs 全空白 vs None」上分叉。
 * 2. **真值判定**：`task["auto_fix"]`/`auto_commit`/`only_cases`/`bug_dirs`/`commits`/`files`
 *    一律 `pyTruthy`（JS 的 `[]`/`{}` 是真值，Python 是假值；`0`/`""`/None 同假）。
 * 3. **截断按码点**：`commits[:60]`/`files[:50]` 是**列表**切片（与 JS `slice` 同），而
 *    `(c['code_refs'] or '未填写')[:100]` 是**字符串**的码点切片 ⇒ `pySliceCodePoints`
 *    （JS `slice` 按 UTF-16 码元，会把边界上的 emoji 劈成半个代理对）。
 * 4. **`task[...]` / `project[...]` 取键**：走 `pyGetItem`（缺键抛 `KeyError`，消息是键的 repr），
 *    `.get(k, d)` 走 `pyGet`（键在但为 None **不**走默认值）。生产里 project/task 是
 *    `sqlite3.Row`（缺键是 `IndexError`），对拍/单测里是 dict——本文件按 **dict 口径**对齐，
 *    两者只在「字段缺失」时不同，而 prompt 只用 db 视图里必然存在的字段。
 * 5. **`json.loads(payload or "{}")`**：`_jsonLoads` 先严格解析，失败且源码里有
 *    `NaN`/`Infinity`/`-Infinity` 字面量时替换后重试（CPython 默认 `allow_nan=True`），
 *    仍失败抛 `SyntaxError`（= Python 的 `ValueError` 分支）。与 `db.js` 的私有 `pyJsonLoads`
 *    同一算法，但那份未导出，不能 import。
 * 6. **`flow.md` 与四份模板的拼接**：`"\n\n---\n\n"` 分隔线逐字节照抄，末尾再补一个 `"\n"`
 *    （`normal_prompt`）/ `_stress_doc` 的 `load_test.md` + 四份压测模板同理。
 * 7. **`STAGE_ORDER`**：Python 元组 → JS 冻结数组（对拍探针把元组摊成数组，形状本就一致）；
 *    `STAGE_ORDER.index(x)` 的 `ValueError` 与 `STAGE_LABELS[x]` 的 `KeyError` **照样抛**，
 *    不兜底（未知 `end_stage` 是调用方的错误，静默回落会把「拼错阶段名」变成「跑了错的阶段」）。
 *
 * ── oracle 的活缺陷（**照抄，不许顺手修好**） ───────────────────────────────────
 * `prompts.py:353` 在 `retest_prompt` 里写的是 `return retest_range_prompt(project, task, log)`，
 * 而该函数作用域内**没有** `log` ⇒ `retest_bug` 未绑定报告且带日期范围时必抛
 * `NameError: name 'log' is not defined`，日期范围复测的这条回落路径实际不可用。
 * `tests/test_prompts_build.py:414-425` 已把它固化成「记录不修」。本文件在**同一位置**抛同名
 * 同文案的 `NameError`（见 `retest_prompt`），对拍用例用 `expect:{expectOk:false}` 钉住。
 * 另外 `first_round_prompt` 的 `log` 形参在 oracle 里就是从始至终没用过的死参数（它没把 log
 * 转给 `retest_prompt`），本文件照旧保留该形参并同样不使用。
 *
 * ── 已知残余差异（备案，别当 bug 修） ───────────────────────────────────────────
 *  - **非字符串字段的 `strip()`**：`(x or "").strip()` 在 Python 里若 x 是非字符串真值
 *    （如 `5`）抛 `AttributeError: 'int' object has no attribute 'strip'`；JS 侧 `pyStrip`
 *    `String()` 化后返回 `"5"`。project/task 来自 sqlite 视图，这些列非 str 即 None，
 *    该形态在生产里不可达。
 *  - **非字符串元素的 `join`**：`'、'.join(only_cases)` / `"- {cid}：{d}"` 在 Python 里遇到
 *    非 str 元素抛 `TypeError`，JS 的 `Array.join` 会静默 `String()` 化。payload 里的
 *    `only_cases` 由平台写入用例 id 串，该形态不可达。
 *  - **`import.meta.url` 已解析符号链接**：Python 的 `abspath(__file__)` 不解符号链接，
 *    若仓库以符号链接路径 import，两版推出的资产目录字符串可能不同（本仓库无此形态）。
 *  - **f-string 里的 `None`**：Python `f"{x}"` 把 None 渲染成 `None`、JS 模板串渲染成 `null`。
 *    本文件插值的全部字段（task 的 `retest`/`id`/`end_stage`/`payload`/`extra`/`date_from`/
 *    `date_to` 与 project 的各路径列）在 `db.py` 的建表语句里都是 `TEXT/INTEGER NOT NULL`，
 *    None 不可达；真出现时两侧会分叉（届时按需引入 `pyStr` 口径）。
 *  - **`_semantic_order` 的 `via` 元素**：Python `"vec" in r.get("via", "")` 在 via 非 str 时抛
 *    TypeError、进而被外层 `except Exception` 吞成 `[]`；JS 侧 `String(...)` 化后照常判断。
 *    `rag.retrieve_detail` 的 `via` 恒为 str（`bm25`/`kw`/`vec`/`bm25+vec`），该形态不可达。
 *
 * 零 npm 依赖：只用 `node:path` / `node:url` 与本仓库内的 `lib.js` / `export-cases.js` /
 * `rag.js` / `i18n.js`。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `export_cases.scan_cases`（M6-2 已落）与 `lib` 的读侧子集（含 M6-4 新落的 `gitLogChanges`）
import { scanCases } from './export-cases.js';
import { t as i18nT, taskLang } from './i18n.js';
import { bugCases, findCaseDirs, gitLogChanges, gitRecentCommits, pyJoin, pyStrip, readText } from './lib.js';
// `rag` 的配置/检索入口（M6-3 已落）+ 它那套 Python 语义小工具（错误类/真值/码点切片）
import {
  AttributeError, KeyError, ValueError, change_query, load_config, pySliceCodePoints, pyTruthy,
  retrieve_detail,
} from './rag.js';

// --------------------------------------------------------------------------
// 产出语言指令（T14，设计 §5.2；与 backend_py/prompts.py 同文案）
// --------------------------------------------------------------------------

/**
 * 产出语言指令的中文原句（= i18n dictionary 的 key；`i18n/en.json` 的 prompt ns 存英文句）。
 *
 * 只放 prompt **头部**一段，包装文案保持中文（D5 精简版）：zh 任务只新增这一段，其余
 * 段落与改前逐字节一致；en 任务只换 directive 句。
 */
const OUTPUT_LANG_DIRECTIVE = '用中文撰写所有产出（用例、报告、日志）。';

/**
 * prompt 头部的产出语言指令段（`【产出语言】…` + 分隔线）。
 *
 * 语言一律经 `taskLang`（兼容 db 行/dict；缺失/空/脏值 → zh），不在调用点直接读
 * `task.lang`。与 Python `_output_lang_head` 逐字节对应。
 * @param {object|null|undefined} task
 * @returns {string}
 */
function _output_lang_head(task) {
  return `【产出语言】${i18nT('prompt', OUTPUT_LANG_DIRECTIVE, taskLang(task))}\n\n---\n\n`;
}

// --------------------------------------------------------------------------
// Python 语义小工具（本文件私有；`rag.js` 有同名私有实现，各文件不互相 import 私有名）
// --------------------------------------------------------------------------

/** Python `RuntimeError`（内置资产缺失或为空） */
export class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

/** Python `NameError`（照抄 `prompts.py:353` 的活缺陷，见文件头） */
export class NameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NameError';
  }
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

/** Python `repr(str)` 的可用子集（单引号，转义反斜杠与单引号）——只用于 `KeyError` 文案 */
function pyReprString(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Python `x or fallback`（`bool(x)` 口径：空 list/dict/""/0/None 皆为假） */
function pyOr(value, fallback) {
  return pyTruthy(value) ? value : fallback;
}

/** Python `(x or "").strip()`——十处调用点共用这一条口径（见文件头 1） */
function stripOrEmpty(value) {
  return pyStrip(pyOr(value, ''));
}

/** Python `d.get(k[, d])`：只有**键不存在**才给默认值（键在但为 None 仍返回 None） */
function pyGet(value, key, fallback = undefined) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttributeError(`'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** Python `d[k]`（键不存在抛 `KeyError`，消息是键的 repr） */
function pyGetItem(value, key) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`'${pyTypeName(value)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(value, key)) throw new KeyError(pyReprString(key));
  return value[key];
}

/** `pyJsonLoads` 的哨兵串（同 `db.js`：只在这三个字面量出现处替换，反序列化后还原） */
const PY_JSON_NAN = '\u0000py-json:NaN\u0000';
const PY_JSON_INF = '\u0000py-json:Infinity\u0000';
const PY_JSON_NEG_INF = '\u0000py-json:-Infinity\u0000';

/**
 * 把源码里**字符串之外**的 `NaN`/`Infinity`/`-Infinity` 换成哨兵串（字符串里的同名文本不动）。
 * 一处都没换返回 `null`（没必要重试）。与 `db.js:patchPyJsonSpecials` 同一算法。
 */
function patchPyJsonSpecials(src) {
  let out = '';
  let changed = false;
  let inString = false;
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {                    // 转义对整体跳过，免得把 \" 当字符串结束
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (src.startsWith('-Infinity', i)) { out += JSON.stringify(PY_JSON_NEG_INF); i += 9; changed = true; continue; }
    if (src.startsWith('Infinity', i)) { out += JSON.stringify(PY_JSON_INF); i += 8; changed = true; continue; }
    if (src.startsWith('NaN', i)) { out += JSON.stringify(PY_JSON_NAN); i += 3; changed = true; continue; }
    out += ch;
    i += 1;
  }
  return changed ? out : null;
}

/**
 * CPython `json.loads()` 的读侧对应物（只补齐读路径可观察到的差异，见文件头 5）。
 *
 * 入参口径照抄 Python：只接受 str（Node 里另加 UTF-8 字节，Python 的 `json.loads` 也收 bytes）；
 * 其它类型抛 `TypeError`——`_task_payload` 只 catch `ValueError`，与 Python 一样让 TypeError 冒出去。
 */
function jsonLoads(text) {
  let src;
  if (typeof text === 'string') src = text;
  else if (text instanceof Uint8Array) src = new TextDecoder('utf-8').decode(text);
  else {
    throw new TypeError('the JSON object must be str, bytes or bytearray, not '
      + pyTypeName(text));
  }
  try {
    return JSON.parse(src);
  } catch (strictError) {
    const patched = patchPyJsonSpecials(src);
    if (patched === null) throw strictError;                 // = Python 的 ValueError 分支
    return JSON.parse(patched, (key, value) => {
      if (value === PY_JSON_NAN) return NaN;
      if (value === PY_JSON_INF) return Infinity;
      if (value === PY_JSON_NEG_INF) return -Infinity;
      return value;
    });
  }
}

// --------------------------------------------------------------------------
// 常量与内置资产（逐条对齐 prompts.py:25-36）
// --------------------------------------------------------------------------

/** 本文件所在目录 → 仓库根（`<repo>/backend/lib` 上溯两级；见文件头 ④） */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..');

/** 内置提示词资产目录：`builtin_prompts/free_style/`（流程文档 + 文件模板） */
export const _ASSET_DIR = pyJoin(REPO_ROOT, 'builtin_prompts', 'free_style');

/** 资产读取缓存（**进程内只读一次磁盘、永不失效**；键是 `"/".join(names)`） */
export const _ASSET_CACHE = new Map();

/**
 * 英文模板缺失的告警去重（每资产每进程只 warning 一次；键=英文资产逻辑名，如
 * `templates/status_template.md`）。只影响告警频次，不影响回落行为。
 */
export const _EN_ASSET_WARNED = new Set();

/**
 * 探索任务「最近变更优先」的取数口径（prompt 预算上限，**不是时间窗口**）：
 * 最近 N 条提交 + 每条提交最多列 M 个变更文件；功能聚类/新旧合并/按天倒序交给 agent。
 */
export const RECENT_COMMIT_LIMIT = 30;
export const RECENT_FILES_PER_COMMIT = 8;

/**
 * 生命周期阶段（与 `server.STAGES` / `runner.STAGES` / 前端 `STAGES` 保持一致；
 * prompts 不 import server 防循环依赖）。
 */
export const STAGE_ORDER = Object.freeze(['gen_case', 'execute', 'report', 'analyze', 'fix',
  'deploy', 'retest']);

/** 阶段 key → 中文名（键序照 Python dict 字面量） */
export const STAGE_LABELS = {
  gen_case: '测试用例生成',
  execute: '测试',
  report: '生成报告',
  analyze: '报告分析',
  fix: '问题修复',
  deploy: '重新部署',
  retest: '复测',
};

/** `STAGE_ORDER.index(x)`：不在表内抛 `ValueError`（Python 原话，照抄不兜底） */
function stageIndex(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  if (i < 0) throw new ValueError('tuple.index(x): x not in tuple');
  return i;
}

/** `STAGE_LABELS[x]`：键不存在抛 `KeyError`（消息是键的 repr，照抄不兜底） */
function stageLabel(stage) {
  if (!Object.hasOwn(STAGE_LABELS, stage)) throw new KeyError(pyReprString(stage));
  return STAGE_LABELS[stage];
}

/**
 * `prompts._load_asset`：读取 `builtin_prompts/free_style/` 下的内置提示词资产（带缓存）。
 *
 * names 为相对 `_ASSET_DIR` 的路径分段；文件**缺失或为空**时抛 `RuntimeError`——
 * 宁可任务失败留日志，也不给 agent 注入残缺流程。缓存键 `"/".join(names)`，
 * 命中即返回同一份字符串、不再碰磁盘（对拍/单测可据此钉住「只读一次」）。
 */
export function _load_asset(...names) {
  const key = names.join('/');
  if (!_ASSET_CACHE.has(key)) {
    const full = pyJoin(_ASSET_DIR, ...names);
    const text = readText(full);
    if (!text) throw new RuntimeError(`内置提示词资产缺失或为空: ${full}`);
    _ASSET_CACHE.set(key, text);
  }
  return _ASSET_CACHE.get(key);
}

/** 中文资产名 → 英文版文件名：`x.md` → `x.en.md`（无 .md 后缀时直接追加 `.en.md`）。 */
function _enAssetName(name) {
  return (name.endsWith('.md') ? name.slice(0, -3) : name) + '.en.md';
}

/**
 * `prompts._load_asset_lang`：按语言读取内置提示词资产（`en` 优先英文版，其余等同
 * `_load_asset`）。
 *
 * - `lang === 'en'`：先读 `<name>.en.md`（如 `templates/case_template.en.md`），存在即用；
 *   英文版缺失/为空时**回落中文版**并每资产 `console.warn` 一次（进程内只警告一次，
 *   绝不抛错——宁可给出中文模板，也不让整个任务失败）；
 * - `zh` 或其它（含 null/undefined/未知值）：**直接走旧的 `_load_asset`**，逐字节相同、
 *   零警告；
 * - 缓存键与中文区分：英文键为 `"en:" + names.join('/')`，不污染旧 `_ASSET_CACHE`
 *   的 zh 键语义（`names.join('/')`）。缺失回落的英文键不入缓存，下次仍会尝试读盘
 *   （文件一旦补上即生效），告警仍只出一次。
 * @param {string} lang
 * @param {...string} names 相对 `_ASSET_DIR` 的路径分段
 * @returns {string}
 */
export function _load_asset_lang(lang, ...names) {
  if (lang !== 'en') return _load_asset(...names);
  const key = `en:${names.join('/')}`;
  if (!_ASSET_CACHE.has(key)) {
    // `templates/case_template.md` → `templates/case_template.en.md`（.en 插在 .md 前）
    const enNames = [...names.slice(0, -1), _enAssetName(names[names.length - 1])];
    const enPath = pyJoin(_ASSET_DIR, ...enNames);
    const text = readText(enPath);
    if (!text) {
      if (!_EN_ASSET_WARNED.has(key)) {
        _EN_ASSET_WARNED.add(key);
        console.warn(`[prompts] 英文资产缺失或为空，已回落中文版: ${enPath}`);
      }
      return _load_asset(...names);
    }
    _ASSET_CACHE.set(key, text);
  }
  return _ASSET_CACHE.get(key);
}

/**
 * `prompts._free_style_doc`：拼接自由风格测试流程文档与全部文件模板（首轮 prompt 注入用）。
 *
 * 模板依次附在流程文档之后、用分隔线隔开；`flow.md` 末尾的「附带文件模板」一节与该
 * 拼接顺序一一对应。`lang` 只决定 4 份模板走中文版还是英文版（`_load_asset_lang`）：
 * `zh`（默认）与改前逐字节相同；`flow.md` 本身保持中文单份（D5），不参与语言选择。
 * @param {'zh'|'en'} [lang='zh']
 * @returns {string}
 */
export function _free_style_doc(lang = 'zh') {
  const parts = [_load_asset('flow.md')];
  for (const name of ['case_template.md', 'status_template.md', 'index_template.md',
    'bug_report_template.md']) {
    parts.push('\n\n---\n\n' + _load_asset_lang(lang, 'templates', name));
  }
  return parts.join('');
}

/**
 * `prompts.first_round_prompt`：构建首轮 prompt。project/task 为 db 视图（sqlite Row 或 dict）。
 *
 * 返回内容**最前**是产出语言指令段（`_output_lang_head`，按 `task.lang` 取 zh/en）：
 * 只在分派层注入这一次，各 builder 自身不拼该段（避免重复/漏加）。
 *
 * `log` 形参在 oracle 里就是**死参数**（没有转给 `retest_prompt`，见文件头「oracle 的活缺陷」），
 * 本文件照旧保留、照旧不用。返回 Promise（见文件头 ①）。
 */
export async function first_round_prompt(project, task, log = null) {
  void log;                                        // 照抄 oracle 的死参数（见 docstring）
  const taskType = pyOr(pyGetItem(task, 'task_type'), 'normal');
  let prompt;
  if (taskType === 'fix') {
    prompt = fix_prompt(project, task);
  } else if (taskType === 'retest_bug') {
    prompt = await retest_prompt(project, task);
  } else if (taskType === 'stress') {
    prompt = stress_prompt(project, task);
  } else if (taskType === 'regression') {
    prompt = regression_prompt(project, task);
  } else if (taskType === 'pipeline') {
    prompt = pipeline_prompt(project, task);
  } else if (taskType === 'reject') {
    prompt = reject_prompt(project, task);
  } else {
    prompt = normal_prompt(project, task);
  }
  // 阶段任务：要求 agent 按阶段推进更新 live.json 的 phase/phase_label（仅监控展示，
  // 平台不做硬依赖）；探索/压测的 phase 约定由现有流程文档/压测 prompt 承担
  if (['fix', 'retest_bug', 'pipeline', 'regression'].includes(taskType)) {
    prompt += ('\n---\n阶段进度上报（仅监控展示）：每完成/进入一个阶段，更新 '
      + `${pyGetItem(project, 'work_dir')}/.live/live.json 的 phase=done 或当前阶段 key、`
      + 'phase_label=当前阶段中文名。\n');
  }
  const extra = stripOrEmpty(pyGetItem(task, 'extra'));
  if (extra) {
    prompt += ('\n\n---\n用户附加要求（平台转达，务必遵守；如与上面约束冲突以本段为准）:\n'
      + extra + '\n');
  }
  return _output_lang_head(task) + prompt;
}

/**
 * `prompts._project_context`：项目配置的上下文段落：环境标签/项目附加提示词/能力 skill。
 *
 * 提交规范与部署说明已并入项目附加提示词（guide_text），不再单独注入；
 * 项目绑定能力 skill（skill_understand/skill_test/skill_cases）时在此追加注入行。
 * 所有任务类型（测试/修复/复测）的首轮 prompt 都附带，供 agent 理解项目；全空返回空串。
 */
export function _project_context(project) {
  const parts = [];
  const img = stripOrEmpty(pyGetItem(project, 'env_label'));
  if (img) {
    parts.push(`- 环境标签：${img}（测试/修复/部署针对该环境）`);
  }
  const guide = stripOrEmpty(pyGetItem(project, 'guide_text'));
  if (guide) {
    parts.push(`- 项目附加提示（如何理解项目/写 commit/部署等）：\n  ${guide}`);
  }
  let skill = stripOrEmpty(pyGetItem(project, 'skill_understand'));
  if (skill) {
    parts.push(`- 理解项目：优先使用 skill「${skill}」分析项目结构与约定`);
  }
  skill = stripOrEmpty(pyGetItem(project, 'skill_test'));
  if (skill) {
    parts.push(`- 测试项目：优先使用 skill「${skill}」了解本项目的测试方式`
      + '（启动/运行/环境/压测等要求）');
  }
  skill = stripOrEmpty(pyGetItem(project, 'skill_cases'));
  if (skill) {
    parts.push(`- 用例规范：生成用例时遵循 skill「${skill}」的用例命名/结构/登记规范`);
  }
  if (!parts.length) return '';
  return parts.join('\n');
}

/**
 * `prompts._date_range_ctx`：提交日期范围上下文段：范围说明 + 范围内 git 提交/变更文件摘录。
 *
 * task 带 date_from/date_to（YYYY-MM-DD，空=不限）时返回多行文本，无日期范围返回空串；
 * git 摘录失败时给范围说明并注明原因（`git_log_changes` 只降级不抛）。
 * 三分支：有提交/变更文件、范围内无提交（`ok` 但空）、摘录失败（`ok=False`）。
 */
export function _date_range_ctx(project, task) {
  const df = stripOrEmpty(pyGetItem(task, 'date_from'));
  const dt = stripOrEmpty(pyGetItem(task, 'date_to'));
  if (!(df || dt)) return '';
  const log = gitLogChanges(pyGetItem(project, 'project_dir'), df, dt);
  const lines = [`- 提交日期范围：${df || '最早'} .. ${dt || '现在'}（本任务优先覆盖该范围内提交）`];
  const commits = pyTruthy(pyGet(log, 'ok')) ? pyOr(pyGet(log, 'commits'), []) : [];
  const files = pyTruthy(pyGet(log, 'ok')) ? pyOr(pyGet(log, 'files'), []) : [];
  if (commits.length) {
    lines.push(`- 范围内提交（${commits.length} 条）：`);
    lines.push('  ' + commits.slice(0, 60).join('\n  '));
  }
  if (files.length) {
    const more = files.length > 50 ? ` …共 ${files.length} 个` : '';
    lines.push(`- 变更文件（${files.length} 个，去重）：`);
    lines.push('  ' + files.slice(0, 50).join('\n  ') + more);
  } else if (pyTruthy(pyGet(log, 'ok'))) {
    lines.push('- 该日期范围内没有提交（非 git 仓库或时间段无提交），按项目当前代码自行判断');
  } else {
    lines.push(`- git 摘录失败（${pyOr(pyGet(log, 'error'), '未知原因')}），按项目当前代码自行判断`);
  }
  return lines.join('\n') + '\n';
}

/**
 * `prompts._date_range_priority`：探索任务优先范围段——在普通探索约束里插入
 * 「先分析范围内提交、优先相关用例」；无日期范围（`_date_range_ctx` 返回空串）时整段不出现。
 */
export function _date_range_priority(project, task) {
  const ctx = _date_range_ctx(project, task);
  if (!ctx) return '';
  return ('- 优先范围：先按下方提交清单分析改动涉及的模块与文件，'
    + '本轮优先设计并执行与这些改动相关的用例；\n' + ctx);
}

/**
 * `prompts._render_recent_commits`：把最近提交渲染成「按提交日期倒序、按天分组」的清单。
 *
 * `commits` 为 `lib.gitRecentCommits` 的逐条记录（取数已按提交时间倒序）；同一提交的
 * 变更文件最多列 `RECENT_FILES_PER_COMMIT` 个，超出给「…共 N 个」提示——文件清单用于
 * agent 判断改动落在哪个功能上，不是全量 diff。
 */
function _render_recent_commits(commits) {
  const groups = new Map();
  for (const c of commits) {
    if (!groups.has(c.date)) groups.set(c.date, []);
    groups.get(c.date).push(c);
  }
  const lines = [`- 最近变更（按提交日期倒序，最多 ${RECENT_COMMIT_LIMIT} 条提交）：`];
  // 日期是 YYYY-MM-DD（ASCII）：字符串降序 = 日期倒序（排序对象与 Python 一致）
  for (const date of [...groups.keys()].sort().reverse()) {
    const items = groups.get(date);
    lines.push(`  【${date}】${items.length} 条提交：`);
    for (const c of items) {
      lines.push(`    - ${c.hash} ${c.subject}`);
      const files = pyOr(c.files, []);
      if (files.length) {
        const shown = files.slice(0, RECENT_FILES_PER_COMMIT).join('、');
        const more = files.length > RECENT_FILES_PER_COMMIT
          ? ` …共 ${files.length} 个` : '';
        lines.push(`      文件：${shown}${more}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * `prompts._recent_changes_priority`：探索任务优先范围段——显式日期范围优先，否则默认
 * 「最近变更优先（功能粒度）」。
 *
 * 规则句在任何情况下都注入（取不到提交清单时给可读降级文案），避免 agent 退回纯功能
 * 分级顺序；功能聚类/跨天合并/按功能最近改动日期倒序的细则见流程文档
 * 「最近变更与功能合并规则」一节。
 */
export function _recent_changes_priority(project, task) {
  const df = stripOrEmpty(pyGetItem(task, 'date_from'));
  const dt = stripOrEmpty(pyGetItem(task, 'date_to'));
  if (df || dt) return _date_range_priority(project, task);
  const head = ('- 优先范围（最近变更优先）：先按下方「最近变更」清单分析改动涉及的功能，'
    + '按功能聚类并合并同一功能的跨天改动，按功能最近改动日期倒序，'
    + '本轮优先生成并执行变更功能相关的用例；变更功能覆盖完后再按根 INDEX.md'
    + '「功能分级」推进（规则见流程文档「最近变更与功能合并规则」）；'
    + '清单被截断时可用 git log 自行补充。\n');
  const log = gitRecentCommits(pyGetItem(project, 'project_dir'), RECENT_COMMIT_LIMIT);
  const commits = pyTruthy(pyGet(log, 'ok')) ? pyOr(pyGet(log, 'commits'), []) : [];
  if (commits.length) return head + _render_recent_commits(commits);
  let reason;
  if (pyTruthy(pyGet(log, 'ok'))) {
    reason = '仓库没有提交记录';
  } else {
    reason = `git 摘录失败（${pyOr(pyGet(log, 'error'), '未知原因')}）`;
  }
  return head + (`- 最近变更：${reason}，请自行用 git log 等分析最近改动；`
    + '无法判断时按功能分级推进。\n');
}

/**
 * `prompts.normal_prompt`：常规测试轮（执行一轮自由风格探索测试，流程文档与模板由平台注入）。
 *
 * `end_stage` 收窄每轮范围：gen_case 只生成用例不执行；execute 执行回状态不写 bug 报告；
 * report 及以后（含空值）为现状完整行为。
 *
 * 注入的 4 份文件模板按 `taskLang(task)` 选择语言（en 任务用英文模板，缺失回落中文）；
 * 流程文档与约束块保持中文（D5）。语言一律经 `taskLang` 读，不在调用点直接读 `task.lang`。
 */
export function normal_prompt(project, task) {
  const autoFix = pyTruthy(pyGetItem(task, 'auto_fix')) ? '开' : '关';
  const end = pyOr(pyGetItem(task, 'end_stage'), 'report');
  let scope;
  if (end === 'gen_case') {
    scope = '- 任务终点=测试用例生成：每轮只按模板生成新用例并登记各级 INDEX/status，'
      + '严禁执行用例、严禁发起任何请求；\n';
  } else if (end === 'execute') {
    scope = '- 任务终点=测试：每轮生成新用例并执行，回写 status.md 与 execution 记录；'
      + '发现失败只记录用例状态，严禁写 bug 报告；\n';
  } else {
    scope = '';
  }
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `- 项目上下文：\n${ctx}\n` : '';
  const datePart = _recent_changes_priority(project, task);
  const head = (
    '执行一轮自由风格探索测试，严格按下方《流程文档》与《文件模板》执行，约束如下：\n'
    + `- 案例库根目录：${pyGetItem(project, 'cases_root')}（INDEX.md/ROUNDS.md 不存在则按附带模板初始化）\n`
    + `- bug_report 输出到：${pyGetItem(project, 'bug_dir')}\n`
    + `- 阅读范围：当前项目 ${pyGetItem(project, 'project_dir')}\n`
    + `- 误报教训：生成用例前必读 ${pyGetItem(project, 'cases_root')}/PITFALLS.md`
    + '（历史被用户否决的报告及原因），避开其中记录的误报模式；文件不存在则跳过\n'
    + `- 选项：自动修复=${autoFix}；复测=${pyGetItem(task, 'retest')}\n`
    + `${scope}`
    + `${datePart}`
    + `${ctxBlock}`
    + `- 停止条件：只执行这一轮；结束后写 ${pyGetItem(project, 'work_dir')}/.live/live.json 的 `
    + 'phase=done 并输出本轮摘要\n'
    + '- 项目红线：不编译、不部署、不 git 提交\n'
    + "- 最后用一行输出本轮摘要：'ROUND_DONE 轮次N 新增X通过Y失败Z新bug'\n"
  );
  return head + '\n---\n\n' + _free_style_doc(taskLang(task)) + '\n';
}

/**
 * `prompts._stress_doc`：拼接压测流程文档与方案包模板（stress 首轮 prompt 注入用）。
 *
 * 模板以 `---` 分隔线跟在流程文档后；顺序与 `load_test.md` 正文的引用一致
 * （方案文档 → 图表声明 → 场景 → INDEX）。`lang` 只决定 4 份模板走中文版还是英文版
 * （`_load_asset_lang`）：`zh`（默认）与改前逐字节相同；`load_test.md` 本身保持中文
 * 单份（D5），不参与语言选择。
 * @param {'zh'|'en'} [lang='zh']
 * @returns {string}
 */
export function _stress_doc(lang = 'zh') {
  const parts = [_load_asset('load_test.md')];
  for (const name of ['load_plan_template.md', 'load_charts_template.md',
    'load_scenario_template.md', 'load_index_template.md']) {
    parts.push('\n\n---\n\n' + _load_asset_lang(lang, 'templates', name));
  }
  return parts.join('');
}

/**
 * `prompts.stress_prompt`：压测任务首轮——生成压测方案包（方案文档 + 执行载体 + 图表声明）。
 *
 * 方案包固定落在 `<案例库根>/load/task_<任务id>/`（平台按任务 id 直接定位，不经 INDEX 解析）；
 * 用户压测说明（payload.brief）是目标地址与关注接口的权威来源。本轮只写文件不发请求。
 *
 * 注入的 4 份模板按 `taskLang(task)` 选语言（en 任务用英文模板，缺失回落中文）。
 */
export function stress_prompt(project, task) {
  const brief = pyOr(pyGet(_task_payload(task), 'brief', ''),
    '（未填写，按案例库与项目信息自行确定）');
  const cdir = `${pyGetItem(project, 'cases_root')}/load/task_${pyGetItem(task, 'id')}`;
  return (
    '压测任务（第 1 步/共 2 步，本轮只生成压测方案包，绝不发任何请求）：\n'
    + `- 方案包目录：${cdir}（本轮只允许在该目录内写文件）\n`
    + `- 压测说明（用户提供，目标服务地址与关注接口以它为准）：\n---\n${brief}\n---\n`
    + `- 案例库根目录：${pyGetItem(project, 'cases_root')}（用例记录了接口事实；说明未覆盖的`
    + `接口细节阅读 ${pyGetItem(project, 'project_dir')} 代码确认，不要臆造）\n`
    + `${_project_context(project)}`
    + '产出（格式见下方《压测流程文档》与各模板）：\n'
    + `1. ${cdir}/plan.md（必产）：压测方案文档，按《方案文档模板》写全`
    + '（目标/接口/加压模型/指标定义/通过标准）；\n'
    + `2. 执行载体二选一：简单 HTTP 压测写 ${cdir}/scenario.json（按《场景模板》，`
    + '字段与取值范围不符合会导致平台校验失败）；需要多协议/有状态链路/业务自定义'
    + `度量时写 ${cdir}/run.py（按《流程文档》的脚本契约，用 loadgen.MetricsWriter 上报指标）；\n`
    + `3. ${cdir}/charts.json（建议产）：按《图表声明模板》声明本次要看的图`
    + '（吞吐/延迟/错误率之外的业务量也一视同仁，如委托数、各状态分布）；\n'
    + `4. 同步更新 ${pyGetItem(project, 'cases_root')}/load/INDEX.md（不存在则按附带模板新建），`
    + '登记本方案一行；\n'
    + '要求：\n'
    + '- plan.md 必须是 **Markdown**：`#/##/###` 分节、`|` 管道表格、`-` 与 `1.` 列表、'
    + '反引号包代码与路径——平台「压测方案」页直接渲染它（标题/表格/列表/引用块都有排版），'
    + '空格对齐的伪表格与纯文本大段不会成表；开头一段「- 键：值」抬头会渲染成方案抬头栏；\n'
    + '- 指标命名与图表声明必须一致：charts.json 引用的每个 metric 都要真的上报；\n'
    + '- 红线：本轮严禁向任何地址发请求、不做压测、不启动/停止服务、不编译、'
    + '不部署、不 git 提交；不在方案包目录之外写文件；发压由平台在第 2 步自动执行；\n'
    + `- 写完文件后更新 ${pyGetItem(project, 'work_dir')}/.live/live.json 的 `
    + "phase=done，并输出一行摘要：'STRESS_DONE 方案要点（目标/驱动/面板数）'。"
  ) + '\n---\n\n' + _stress_doc(taskLang(task)) + '\n';
}

/**
 * `prompts.fix_prompt`：修复任务首轮——起点固定「报告分析」，按终点拼接 报告分析→(修复→部署→复测)。
 *
 * 未绑定 bug 报告（`_linked_bug` 返回 None）时回落常规探索；存量任务（无 end_stage）回落
 * 终点=问题修复。能力 skill 绑定（skill_commit/skill_deploy 非空时改写对应条款）原样保留；
 * 未知 `end_stage` 在 `STAGE_LABELS[end]` 上抛 `KeyError`（照抄，不兜底）。
 */
export function fix_prompt(project, task) {
  const bug = _linked_bug(project, task);
  if (bug === null) {
    return normal_prompt(project, task);
  }
  const [bugDirName, content] = bug;
  const end = pyOr(pyGetItem(task, 'end_stage'), 'fix');
  const autoCommit = pyTruthy(pyGetItem(task, 'auto_commit')) ? '开' : '关';
  const doDeploy = end === 'deploy' || end === 'retest';
  const doRetest = end === 'retest';
  // 复测选项行：终点=复测时注明复测在本任务内执行（平台不再另建复测任务）；
  // 终点<复测（仅分析/修复/部署）时只显示「自动复测=关」
  const retestOpt = doRetest
    ? '自动复测=开（复测在本任务内执行，平台不再另建复测任务）\n'
    : '自动复测=关\n';
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `\n- 项目上下文：\n${ctx}` : '';
  // 能力 skill 绑定：部署/提交仅在字段非空时改写对应要求文案；红线与开关语义不动
  const skillCommit = stripOrEmpty(pyGetItem(project, 'skill_commit'));
  const skillDeploy = stripOrEmpty(pyGetItem(project, 'skill_deploy'));
  let commitReq;
  if (skillCommit) {
    commitReq = ('修复完成后使用 skill「' + skillCommit + '」完成 git commit'
      + '（仅 add 本次改动的文件）；严禁 git push；'
      + '若 git 状态/权限不允许提交，在摘要中说明原因');
  } else {
    commitReq = ('修复完成后直接 git commit（仅 add 本次改动的文件，'
      + 'commit message 需符合项目附加提示词中的 git commit 规范）；'
      + '严禁 git push；若 git 状态/权限不允许提交，在摘要中说明原因');
  }
  const head = (
    `处理以下 bug 报告（任务范围：报告分析 → ${stageLabel(end)}），逐阶段执行：\n`
    + `- bug 报告目录：${pyGetItem(project, 'bug_dir')}/${bugDirName}/\n`
    + `- bug_report.md 全文：\n---\n${content}\n---\n`
    + `- 相关项目代码根：${pyGetItem(project, 'project_dir')}`
    + `${ctxBlock}\n`
    + `- 选项：自动提交=${autoCommit}；自动部署=${doDeploy ? '开' : '关'}；${retestOpt}`
    + '\n阶段一 报告分析：\n'
    + '1. 对照报告全文与项目代码核实问题是否成立、确认根因与触发条件；\n'
    + '2. 把结论写回该报告 bug_report.md 的「## 报告分析」小节'
    + '（是否成立/根因/涉及文件:行号/建议修复方向）。\n'
  );
  if (end === 'analyze') {
    return head + (
      '终点即报告分析：不修改项目代码、不部署、不 git 提交、不改报告其他小节；\n'
      + "最后用一行输出摘要：'FIX_DONE 已分析（结论要点）'。"
    );
  }
  const parts = [
    '\n阶段二 问题修复（修复=直接修改项目代码）：\n'
    + '1. 按报告推荐方案修复：直接修改项目代码（文件:行号 已在报告中给出）；\n'
    + '2. 自动提交=开：' + commitReq + '；\n'
    + '   自动提交=关：严禁执行任何形式的 git commit（含经远程/消息通道委托提交），'
    + '不应为验证修复而提交代码；\n',
  ];
  if (doDeploy) {
    let deployReq;
    if (skillDeploy) {
      deployReq = ('使用 skill「' + skillDeploy + '」自动部署到环境标签对应的'
        + '测试环境并重启服务，完成后给出验证结果；'
        + '部署失败要说明原因与已完成的步骤');
    } else {
      deployReq = ('按项目附加提示词中的部署说明（指定的部署 skill 或文字步骤）'
        + '自动部署到环境标签对应的测试环境并重启服务，完成后给出验证结果；'
        + '部署失败要说明原因与已完成的步骤');
    }
    parts.push(
      '\n阶段三 重新部署：\n'
      + '自动部署=开：' + deployReq + '；\n'
      + '   自动部署=关：严禁执行任何部署/重启服务操作（含经 SSH/消息通道执行），'
      + '如需部署仅给出命令让用户自行执行；\n');
  }
  if (doRetest) {
    parts.push(
      '\n阶段四 复测（本任务内执行）：\n'
      + '1. 重跑该报告关联的全部用例（按 case 文件执行），通过：status.md 状态改「通过」；'
      + '失败：改「失败」并写失败原因，失败证据追加到该报告 bug_report.md 的'
      + '「复测证据」小节；\n'
      + '2. 不改动案例库用例的断言与步骤；平台将按用例状态自动更新 bug 报告状态；\n');
  }
  let redline = ('红线：自动提交=关时严禁 git commit；不要 git push、不要编译 C++'
    + '（如需编译仅说明命令）、不要改动案例库与 bug 报告文件本身'
    + '（「报告分析」「复测证据」小节除外）');
  if (!doDeploy) {
    redline += '；严禁执行任何部署/重启服务操作';
  }
  parts.push(redline + "；\n最后用一行输出摘要：'FIX_DONE 方案要点（已提交:是/否 已部署:"
    + (doDeploy ? '是/否' : '否') + ' 已复测:' + (doRetest ? '是/否' : '否')
    + " 结果）'。");
  return head + parts.join('');
}

/**
 * `prompts.retest_prompt`：复测任务首轮——范围三选一：仅复测 / 重新部署→复测 / 仅重新部署。
 *
 * payload 带 only_cases 时只复核该子集（脚本复测失败升级）。存量任务（start/end 两列均空）
 * 回落「仅复测」；部署是否包含由起点列决定（start=deploy 才含部署），范围含部署时注入部署条款
 * （skill_deploy 非空时改用对应 skill）。未绑定 bug 报告时：带日期范围走 `retest_range_prompt`
 * （**oracle 在这里抛 NameError**，见文件头）、否则回落常规探索。返回 Promise（见文件头 ①）。
 */
export async function retest_prompt(project, task) {
  const bug = _linked_bug(project, task);
  if (bug === null) {
    // 未绑定 bug 报告：带日期范围的复测走 retest_range_prompt（无报告复测），
    // 否则回落常规探索（存量行为）。
    // prompts.py:353 的 `log` 在函数作用域内不存在 ⇒ 照抄抛 NameError（不许顺手修好）。
    if (pyTruthy(pyGetItem(task, 'date_from')) || pyTruthy(pyGetItem(task, 'date_to'))) {
      throw new NameError("name 'log' is not defined");
    }
    return normal_prompt(project, task);
  }
  const [bugDirName, content] = bug;
  const end = pyOr(pyGetItem(task, 'end_stage'), 'retest');
  // 部署是否包含由起点决定：仅复测=(retest,retest) 不含部署；重新部署→复测=(deploy,retest)
  // 含部署；存量行（两列均空）回落起点=retest，即现状「不部署直接复测」
  const start = pyOr(pyGetItem(task, 'start_stage'), 'retest');
  const deployFirst = start === 'deploy';
  let caseIds = bugCases(pyJoin(pyGetItem(project, 'bug_dir'), bugDirName)).ids;
  const onlyCases = pyOr(pyGet(_task_payload(task), 'only_cases'), [])
    .filter((c) => new Set(caseIds).has(c));
  if (onlyCases.length) {
    caseIds = onlyCases;
  }
  const caseDirs = findCaseDirs(pyGetItem(project, 'cases_root'), caseIds);
  if (!caseDirs.length) {
    return normal_prompt(project, task);
  }
  const caseLines = caseDirs.map(([cid, d]) => `- ${cid}：${d}`).join('\n');
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `- 项目上下文：\n${ctx}\n` : '';
  let onlyBlock = '';
  if (onlyCases.length) {
    onlyBlock = (
      '\n背景：平台已用各用例固化的 verify.py 脚本做过一轮复测，上述用例被脚本判定失败。\n'
      + '请逐个人工复核：确认为真回归 → 按要求 2 记失败并补证据；'
      + '判定脚本过期（接口/数据变化导致断言失效）→ 修正该用例 verify.py 后重跑，\n'
      + '并在 execution 记录中注明「脚本已修正」。\n'
    );
  }

  const deployBlock = () => {
    const skillDeploy = stripOrEmpty(pyGetItem(project, 'skill_deploy'));
    let body;
    if (skillDeploy) {
      body = `使用 skill「${skillDeploy}」部署到环境标签对应的测试环境并重启服务`;
    } else {
      body = ('按项目附加提示词中的部署说明（指定的部署 skill 或文字步骤）部署到'
        + '环境标签对应的测试环境并重启服务');
    }
    return ('阶段一 重新部署：\n' + body + '，完成后给出验证结果；'
      + '部署失败要说明原因与已完成的步骤，并按当前已部署状态继续后续阶段；\n');
  };

  if (end === 'deploy') {
    return (
      '对以下 bug 报告执行「仅重新部署」（唯一任务：只部署验证，不复测用例）：\n'
      + `- bug 报告目录：${pyGetItem(project, 'bug_dir')}/${bugDirName}/\n`
      + `- bug_report.md 全文：\n---\n${content}\n---\n`
      + `${ctxBlock}`
      + deployBlock()
      + '红线：不重跑用例、不生成新用例、不修改项目代码与案例库、不 git 提交；\n'
      + "最后用一行输出摘要：'RETEST_DONE 已部署（验证结果）'。"
    );
  }
  const deployPart = deployFirst ? deployBlock() : '';
  const redline = ('红线：不生成新用例、不补充新 bug 报告、不编译、不 git 提交'
    + (deployFirst ? '' : '、不部署')
    + '；平台会在任务结束时按用例状态自动更新 bug 报告状态');
  return (
    '复测以下 bug 报告关联的全部用例（唯一任务，不要生成新用例）：\n'
    + `- bug 报告目录：${pyGetItem(project, 'bug_dir')}/${bugDirName}/\n`
    + `- 关联用例（已在平台侧标记「需要复测」）：\n${caseLines}\n`
    + `${ctxBlock}${onlyBlock}`
    + deployPart
    + '要求：\n'
    + '1. 逐个用例按 case 文件（case.md/脚本）执行复测，记录每次请求与返回；\n'
    + '2. 通过：status.md 状态改「通过」；失败：改「失败」并写失败原因，'
    + '执行记录文件（execution_*.md）标注复测；\n'
    + '3. 失败的请求/返回证据追加到该 bug 报告 bug_report.md 的「复测证据」小节；\n'
    + `4. ${redline}；\n`
    + "5. 最后用一行输出摘要：'RETEST_SUMMARY 通过X失败Y'。"
  );
}

/**
 * `prompts._semantic_order`：日期范围复测首轮的语义候选 id 序（RAG 未配置/失败返回空，
 * 纯增量增强）。
 *
 * query 与 runner 粗筛兜底同源：变更文件 + 提交摘录（`rag.change_query`）。
 * `log` 可选任务日志回调：检索完成记一行统计（候选数 + via 分布），向量路失败降级 BM25 时
 * 附原因——任务日志可查「这次到底用没用 RAG」。**任何异常都吞掉返回 []**（照 Python 的
 * `except Exception`），故这条路径永不阻塞任务。返回 Promise（见文件头 ①）。
 */
export async function _semantic_order(project, task, log = null) {
  try {
    // RAG 未配置：不触发检索（retrieve 会走 BM25 兜底返回非空），保证行为与无 RAG 完全一致
    if (!load_config()) return [];
    const changes = gitLogChanges(pyGetItem(project, 'project_dir'),
      pyGetItem(task, 'date_from'), pyGetItem(task, 'date_to'));
    if (!pyTruthy(pyGet(changes, 'ok'))) return [];
    const [rows, meta] = await retrieve_detail(pyGetItem(project, 'cases_root'),
      change_query(changes), 15);
    if (log) {
      const nVec = rows.filter((r) => String(pyGet(r, 'via', '')).includes('vec')).length;
      let line = (`RAG 语义排序检索：候选 ${rows.length} 条`
        + `（bm25+vec ${nVec} / 仅bm25 ${rows.length - nVec}）`);
      if (pyTruthy(pyGet(meta, 'configured')) && !pyTruthy(pyGet(meta, 'vec_ok'))) {
        line += `；向量路失败已降级 BM25：${pyGet(meta, 'vec_error')}`;
      }
      log(line);
    }
    return rows.map((r) => pyGetItem(r, 'id'));
  } catch {
    return [];
  }
}

/**
 * `prompts.retest_range_prompt`：日期范围复测首轮——先按范围内提交判断受影响用例，再逐用例
 * 复测（无 bug 报告）。
 *
 * 适用范围：retest_bug 且任务带提交日期范围（date_from/date_to）、未绑定 bug 报告。
 * 要求 agent 以固定行「受影响用例：FS0001、FS0002」输出判断结果；用例清单按案例库扫描注入
 * （上限 150 条，含『依据代码』供影响面映射），超出部分省略。`log` 透传 `_semantic_order`。
 * 返回 Promise（见文件头 ①）。
 */
export async function retest_range_prompt(project, task, log = null) {
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `- 项目上下文：\n${ctx}\n` : '';
  let cases = scanCases(pyGetItem(project, 'cases_root'));
  const semIds = await _semantic_order(project, task, log);
  if (semIds.length) {
    const rank = new Map(semIds.map((cid, i) => [cid, i]));
    cases = [...cases].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : rank.size;
      const rb = rank.has(b.id) ? rank.get(b.id) : rank.size;
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);     // Python 元组比较的第二项（id 码点序）
    });
  }
  const truncated = cases.length > 150;
  const caseLines = cases.slice(0, 150).map((c) => {
    const refs = pyOr(c.code_refs, '未填写');
    return `- ${c.id} ${c.name}（依据代码：${pySliceCodePoints(refs, 100)}）`;
  }).join('\n') || '- （案例库暂无用例）';
  const only = pyOr(pyGet(_task_payload(task), 'only_cases'), []);
  let onlyNote;
  if (only.length) {
    onlyNote = (`\n背景：首轮已选出受影响的用例（${only.length} 条：${only.join('、')}），`
      + '本轮只复测该清单内的用例，不要再重复全库判断；\n');
  } else {
    onlyNote = (
      '\n要求 1：先按范围内提交计算影响面（提交改动文件 → 模块 → 用例『依据代码』'
      + '映射），只选取受影响的用例进入复测范围；\n'
      + "要求 2：判断完成后单独输出一行：'受影响用例：FS0001、FS0002'"
      + "（仅受影响用例 id、顿号分隔；无受影响用例输出'受影响用例：无'）；\n"
    );
  }
  const semNote = semIds.length ? `，前 ${Math.min(semIds.length, 150)} 条为语义检索相关候选` : '';
  return (
    '日期范围复测任务（唯一任务，不生成新用例、不写 bug 报告），约束如下：\n'
    + `- 提交日期范围：${pyOr(pyGetItem(task, 'date_from'), '最早')} .. ${pyOr(pyGetItem(task, 'date_to'), '现在')}\n`
    + `- 范围内提交与变更文件：\n${_date_range_ctx(project, task)}`
    + `- 案例库根目录：${pyGetItem(project, 'cases_root')}\n`
    + `- 用例清单（共 ${cases.length} 条`
    + `${truncated ? '，仅列前 150 条' : ''}${semNote}，`
    + `按『依据代码』映射影响面）：\n${caseLines}\n`
    + `${ctxBlock}${onlyNote}`
    + '复测执行要求：\n'
    + '1. 逐个受影响用例按 case 文件（case.md/脚本）执行复测，记录每次请求与返回；\n'
    + '2. 通过：status.md 状态改「通过」；失败：改「失败」并写失败原因，'
    + '执行记录文件（execution_*.md）标注复测；\n'
    + '3. 红线：不生成新用例、不补充 bug 报告、不编译、不部署、不 git 提交；\n'
    + "4. 最后用一行输出摘要：'RETEST_SUMMARY 通过X失败Y'。"
  );
}

/**
 * `prompts.reject_prompt`：修例任务——报告被用户拒绝，按拒绝理由修正关联用例并沉淀教训。
 *
 * 报告状态「已拒绝」与「拒绝记录」小节由平台在创建本任务前写入，agent 只负责案例库侧
 * （修正用例 + PITFALLS.md），不再动报告本身；未绑定报告时回落常规探索。
 */
export function reject_prompt(project, task) {
  const bug = _linked_bug(project, task);
  if (bug === null) {
    return normal_prompt(project, task);
  }
  const [bugDirName, content] = bug;
  const reason = _reject_reason(task);
  const caseDirs = findCaseDirs(pyGetItem(project, 'cases_root'),
    bugCases(pyJoin(pyGetItem(project, 'bug_dir'), bugDirName)).ids);
  const caseLines = caseDirs.map(([cid, d]) => `- ${cid}：${d}`).join('\n')
    || '（未解析到关联用例，跳过用例修正，只沉淀教训）';
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `- 项目上下文：\n${ctx}\n` : '';
  return (
    '以下 bug 报告已被用户拒绝（判定不成立/不接受）。唯一任务：根据拒绝理由'
    + '修正关联用例，并把教训沉淀到误报教训录，供后续生成用例时避开同类误报：\n'
    + `- bug 报告目录：${pyGetItem(project, 'bug_dir')}/${bugDirName}/\n`
    + `- bug_report.md 全文：\n---\n${content}\n---\n`
    + `- 用户拒绝理由（修例的根本依据）：\n---\n${reason}\n---\n`
    + `- 关联用例（case 目录）：\n${caseLines}\n`
    + `- 案例库根目录：${pyGetItem(project, 'cases_root')}\n`
    + `${ctxBlock}`
    + '要求：\n'
    + '1. 对照报告全文与拒绝理由，判断报告不被接受的原因'
    + '（误报/理解偏差/断言错误/环境问题等）；\n'
    + '2. 逐个检查关联用例：按理由修正错误的断言与预期；因误报而不成立的用例'
    + '直接删除（目录连同各级 INDEX.md 中的记录一并移除）；修改处在 case 文件中'
    + '注明「因报告被拒修正」；\n'
    + `3. 把教训追加到 ${pyGetItem(project, 'cases_root')}/PITFALLS.md（不存在则新建，`
    + '首行标题「# 误报教训录」），每条一行，格式：\n'
    + `   '- YYYY-MM-DD ${bugDirName}：一句话教训（拒绝理由摘要）'`
    + '（日期填当天）；\n'
    + '4. 红线：不生成新用例、不修改 bug 报告文件本身（平台已标记「已拒绝」）、'
    + '不编译、不部署、不 git 提交；\n'
    + "5. 最后用一行输出摘要：'REJECT_DONE 修正X删除Y 教训要点'。"
  );
}

/**
 * `prompts._task_payload`：解析任务 payload JSON；为空或非法时返回 `{}`。
 *
 * 只 catch JSON 解析失败（= Python 的 `ValueError`）；非 str/bytes 入参抛 `TypeError`、
 * 解析出的非 dict 值原样返回（调用方 `.get` 时才抛 `AttributeError`）——与 Python 一致。
 */
export function _task_payload(task) {
  try {
    return jsonLoads(pyOr(pyGetItem(task, 'payload'), '{}'));
  } catch (exc) {
    if (exc instanceof SyntaxError) return {};
    throw exc;
  }
}

/** `prompts._reject_reason`：从 payload 解析拒绝理由（创建 reject 任务时由平台写入）。 */
export function _reject_reason(task) {
  try {
    return pyOr(pyGet(jsonLoads(pyOr(pyGetItem(task, 'payload'), '{}')), 'reason', ''), '（未填写）');
  } catch (exc) {
    if (exc instanceof SyntaxError) return '（未填写）';
    throw exc;                                    // 非 dict 的 AttributeError 照 Python 冒出去
  }
}

/**
 * `prompts._linked_bug`：从 payload 解析关联 bug 报告，返回 `[目录名, bug_report.md 全文]`，
 * 无效返回 `null`（payload 无 bug_dir / 报告文件缺失或为空）。
 */
export function _linked_bug(project, task) {
  const bugDir = pyGet(_task_payload(task), 'bug_dir', '');
  if (!pyTruthy(bugDir)) return null;
  const dirPath = pyJoin(pyGetItem(project, 'bug_dir'), bugDir);
  const content = readText(pyJoin(dirPath, 'bug_report.md'));
  return content ? [bugDir, content] : null;
}

/**
 * `prompts.regression_prompt`：回归轮——按用户指令重跑存量用例（不生成新用例）。
 *
 * 指令存任务 extra（创建时必填），是选取重跑用例的唯一依据；终点=execute 时失败只回状态，
 * ≥report 时失败用例按流程写 bug 报告（不新建用例）。
 */
export function regression_prompt(project, task) {
  const end = pyOr(pyGetItem(task, 'end_stage'), 'report');
  const instruction = pyOr(stripOrEmpty(pyGetItem(task, 'extra')), '（未填写）');
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `- 项目上下文：\n${ctx}\n` : '';
  let scope;
  if (end === 'execute') {
    scope = '- 任务终点=测试：失败用例只回写状态与执行记录，严禁写 bug 报告；\n';
  } else {
    scope = ('- 任务终点含「生成报告」：失败用例除回写状态外，按流程文档为该失败'
      + '创建 bug 报告（关联该用例；不新建用例）；\n');
  }
  return (
    '执行一轮存量用例回归（唯一任务：重跑已有用例，严禁生成任何新用例），约束如下：\n'
    + `- 案例库根目录：${pyGetItem(project, 'cases_root')}（只读取，不登记新用例）\n`
    + `- 重跑范围指令（用户提供，选取要重跑用例的唯一依据）：\n---\n${instruction}\n---\n`
    + `- 阅读范围：当前项目 ${pyGetItem(project, 'project_dir')}\n`
    + `${ctxBlock}`
    + `${scope}`
    + '- 执行要求：逐个选中用例按 case 文件执行，回写 status.md 状态与执行记录'
    + '（execution_*.md）；\n'
    + '- 项目红线：不生成新用例、不修改用例的断言与步骤（仅状态/执行记录）、'
    + '不编译、不部署、不 git 提交；\n'
    + `- 停止条件：只执行这一轮；结束后更新 ${pyGetItem(project, 'work_dir')}/.live/live.json `
    + "phase=done 并输出一行摘要：'REGRESSION_DONE 重跑X通过Y失败Z'\n"
  );
}

/**
 * `prompts.pipeline_prompt`：后段任务首轮——对前段探索/回归产出的 bug 报告清单逐枚执行
 * 报告分析→终点。
 *
 * 清单由平台在任务启动时按「bug 目录时间戳 ≥ 前段任务 created_at」固化进
 * payload.bug_dirs；终点≥fix/部署/复测时追加对应阶段。未知 `end_stage` 在
 * `STAGE_ORDER.index` 上抛 `ValueError`（先于 `STAGE_LABELS[end]` 的 `KeyError`）。
 */
export function pipeline_prompt(project, task) {
  const end = pyOr(pyGetItem(task, 'end_stage'), 'report');
  let bugDirs;
  try {
    bugDirs = pyOr(pyGet(jsonLoads(pyOr(pyGetItem(task, 'payload'), '{}')), 'bug_dirs'), []);
  } catch (exc) {
    if (!(exc instanceof SyntaxError)) throw exc;
    bugDirs = [];
  }
  const listing = bugDirs.map((d) => `- ${pyGetItem(project, 'bug_dir')}/${d}/`).join('\n') || '（无）';
  const ctx = _project_context(project);
  const ctxBlock = ctx ? `- 项目上下文：\n${ctx}\n` : '';
  const steps = ['1. 逐枚阅读 bug 报告全文与项目代码，把核实结论写回该报告'
    + '「## 报告分析」小节（不改代码）；\n'];
  const doFix = stageIndex(end) >= stageIndex('fix');
  const doDeploy = stageIndex(end) >= stageIndex('deploy');
  const doRetest = stageIndex(end) >= stageIndex('retest');
  if (doFix) {
    steps.push('2. 对确认成立的问题逐枚修复（直接修改项目代码，按报告推荐方案）；\n');
  }
  if (doDeploy) {
    const skillDeploy = stripOrEmpty(pyGetItem(project, 'skill_deploy'));
    const deployBody = skillDeploy
      ? `使用 skill「${skillDeploy}」`
      : '按项目附加提示词中的部署说明';
    steps.push(`3. 全部修复完成后，${deployBody}重新部署到环境标签`
      + '对应的测试环境并重启服务，给出验证结果；\n');
  }
  if (doRetest) {
    steps.push('4. 逐枚重跑各报告关联用例（按 case 文件执行），回写 status.md，'
      + '失败证据追加到报告「复测证据」小节；平台将按用例状态更新各 bug 报告状态；\n');
  }
  const redline = ('红线：不生成新用例、不改用例断言与步骤、不 git 提交'
    + (doDeploy ? '' : '、不部署/重启服务') + '；\n');
  return (
    '后段任务：处理前一段探索/回归任务产出的全部 bug 报告（清单如下），'
    + `任务范围：报告分析 → ${stageLabel(end)}，逐枚按顺序执行：\n`
    + `${listing}\n`
    + `- 案例库根目录：${pyGetItem(project, 'cases_root')}（复测用例只执行不修改）\n`
    + `${ctxBlock}`
    + steps.join('') + redline
    + "最后用一行输出摘要：'PIPELINE_DONE 分析X修复Y部署:"
    + (doDeploy ? '是/否' : '否') + "复测通过Z失败W'。"
  );
}

/**
 * `prompts.next_round_prompt`：续轮短 prompt（同会话）——探索/回归分版（回归同样不生成新用例）。
 *
 * 头部同样注入产出语言指令（task=null 时按 zh）；compact 不是自然语言 prompt，保持
 * 字面 `/compact` 不变（见 `compact_prompt`）。
 */
export function next_round_prompt(round_no, task = null) {
  if (task != null && pyOr(pyGetItem(task, 'task_type'), 'normal') === 'regression') {
    const body = (
      `继续执行存量用例回归第 ${round_no} 轮：仍严禁生成任何新用例，按首轮`
      + '「重跑范围指令」继续选取未重跑的用例执行并回写状态，约束同首轮'
      + '（重跑指令、终点范围、红线）；只执行这一轮，结束后更新工作目录下 '
      + ".live/live.json phase=done 并输出 'REGRESSION_DONE 重跑X通过Y失败Z' 摘要行。"
    );
    return _output_lang_head(task) + body;
  }
  const body = (
    `继续执行自由风格探索测试第 ${round_no} 轮：换一个 ROUNDS.md 未记录过的`
    + '角度生成新 case；若首轮注入的「最近变更」功能组尚未覆盖完，继续优先覆盖'
    + '这些变更功能组（规则见首轮流程文档「最近变更与功能合并规则」），全部覆盖后'
    + '再按根 INDEX.md「功能分级」节从高优先级到低优先级推进'
    + '（高优先级功能域未覆盖时不选边界/异常类细节角度），'
    + '约束同首轮（案例库根目录、bug_report 目录、阅读范围、'
    + '选项、红线）；只执行这一轮，结束后更新工作目录下 .live/live.json phase=done '
    + "并输出 'ROUND_DONE ...' 摘要行。"
  );
  return _output_lang_head(task) + body;
}

/**
 * `prompts.compact_prompt`：轮次开始前的上下文压缩提示（kimi 支持，其余 agent 日志注明跳过）。
 *
 * 返回字面 slash 命令 `/compact`：T14 计划曾考虑在头部注入语言指令，但 slash 命令加自然
 * 语言前缀会破坏命令语义（agent/CLI 按首个 token 识别），且当前仓库**无生产调用方**
 * （仅测试钉住）。故保持命令本身不变；若未来接线，在调用方单独拼接指令段。
 */
export function compact_prompt() {
  return '/compact';
}

// --------------------------------------------------------------------------
// camelCase 别名（供 JS 调用方；对拍用例逐条用 nodeFn 指向**主名**，不依赖别名）
// --------------------------------------------------------------------------

export {
  _load_asset as loadAsset,
  _free_style_doc as freeStyleDoc,
  first_round_prompt as firstRoundPrompt,
  _project_context as projectContext,
  _date_range_ctx as dateRangeCtx,
  _date_range_priority as dateRangePriority,
  _recent_changes_priority as recentChangesPriority,
  normal_prompt as normalPrompt,
  _stress_doc as stressDoc,
  stress_prompt as stressPrompt,
  fix_prompt as fixPrompt,
  retest_prompt as retestPrompt,
  _semantic_order as semanticOrder,
  retest_range_prompt as retestRangePrompt,
  reject_prompt as rejectPrompt,
  _task_payload as taskPayload,
  _reject_reason as rejectReason,
  _linked_bug as linkedBug,
  regression_prompt as regressionPrompt,
  pipeline_prompt as pipelinePrompt,
  next_round_prompt as nextRoundPrompt,
  compact_prompt as compactPrompt,
};
