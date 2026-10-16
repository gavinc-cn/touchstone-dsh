/**
 * 路由族：任务 / 轮次 / 对话 / 轮次日志（M3 读路径）+ 任务族写端点（M4.5）
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头；这里与 `server.py` 的
 * `_route_get` / `do_POST` / `do_PATCH` / `do_DELETE` if/elif 链同序：
 * `/api/projects/<id>/tasks` 在 `/api/tasks/<id>` 之前）：
 *   - `GET    /api/tasks`                        → 字面桩：`{"error":"task id required"}`
 *   - `GET    /api/projects/<id>/tasks`          → `_api_list_tasks`
 *   - `GET    /api/tasks/<id>`                   → `_api_get_task`（含 `_task_json` 派生字段）
 *   - `GET    /api/tasks/<id>/rounds`            → `_api_list_rounds`
 *   - `GET    /api/tasks/<id>/dialogue`          → `_api_task_dialogue`
 *   - `GET    /api/tasks/<id>/log`               → `_api_task_log`（轮次日志分段/全文）
 *   - `POST   /api/projects/<id>/tasks`          → `_api_create_task`(2592)
 *   - `POST   /api/tasks/<id>/(stop|restart)`    → `_api_task_action`(4089)
 *   - `POST   /api/tasks/<id>/continue`          → `_api_continue_task`(4109)
 *   - `PATCH  /api/tasks/<id>`                   → `_api_update_task`(4170)
 *   - `DELETE /api/tasks/<id>`                   → `_api_delete_task`(4155)
 *
 * 注意：`/api/tasks/<id>/session/*` 归 `./sessions.js`；`/load/*` 属 M6。
 * 压测读端点（load/case、load/metrics、load/runs、load_report、load/stream…）**不在 M3**。
 *
 * ── 三个必须解释清楚的口径（都是 Python 侧「照抄才不出错」的地方） ──────────────────
 * ① **`/api/tasks` 的响应体是硬编码紧凑 JSON**（Python `b'{"error":"task id required"}'`），
 *    不是 `json.dumps`（那会带 `": "` 空格）。故这里走 `ctx.text()` 原样发，保证字节一致。
 * ② **`tail` 解析失败 = 连接被掐断**：Python `int(parsed["tail"][0])` 抛 ValueError，从 `do_GET`
 *    一路冒到 socketserver ⇒ **不回任何响应、直接关连接**（探针实测：status=0/fetch failed）。
 *    Node 侧复刻这个可观察结果（`res.destroy()`），但**绝不抛**——抛出去会变成 unhandledRejection，
 *    默认直接把后端进程干掉，比 Python 严重一个量级。
 * ③ **`round` 只认「全 ASCII 数字」**（`str.isdigit()` 的 ASCII 子集，复用 `lib.js:pyIsDigits`）；
 *    其余一律按 0 查（→ 404 `log not found`）。Python 的 `isdigit()` 还认 Unicode 数字
 *    （`int('١٢')==12`）、`int('1_0')==10`，这两类**已知差异**记在文件尾注释里，正常前端不产生。
 * ④ 归属校验一律走 `ctx.ownedTask` / `ctx.ownedProject`（多用户隔离红线；两种失败都回
 *    `task not found` / `project not found`，与 Python `_api_get_task` 等的文案一致）。
 * ⑤ **写端点的三条硬口径**（M4.5，逐条都在下面注释到具体行）：
 *    - **读体的位置**：Python 在 `do_POST:1048` 统一读体 ⇒ 本文件每个 POST 处理器开头
 *      `await ctx.readBody()`；`PATCH` 在 Python `do_PATCH:1238` 读体，同样读；
 *      **`DELETE` 不读**（`do_DELETE` 全程没有 `_read_json()`）——不许图省事统一读。
 *    - **错误体的两种形态**：这 5 条端点的错误全部是硬编码字节串（
 *      `'{"error":"..."}'.encode("utf-8")`）⇒ 一律 `ctx.error`（紧凑）；成功体
 *      `b'{"ok":true}'` 是**紧凑字面量**（不是 `json.dumps`）⇒ `ctx.text`，而
 *      `_api_create_task` 的成功体走 `json.dumps` ⇒ `ctx.json`（带空格）。写错一个空格
 *      对拍就红，**不许"统一一下更整齐"**。
 *    - **Python 的 `str()` / 真值语义**：`str(body.get(...) or "")` 这类表达式在 Python 里
 *      是「真值判定 → str → strip」三步，JS 的 `String()`/`||` 在 `[]`/`{}`/`null` 上与它
 *      分叉，故本文件自带一组私有助手（`pyStr`/`pyTruthy`/`pyStripStr`/`pyStripBare`/
 *      `pyIntStrict`/`pyGet`/`pyHas`），口径与 `sessparse.js` 的同名私有助手一致。
 *      其中 `pyStripBare` 复刻「真值非字符串 ⇒ `.strip()` 抛 AttributeError」⇒ 由
 *      `dispatchSafely` 掐断该连接（不补响应），与 Python 只断一条连接同形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import * as chat from '../lib/chat.js';
import { deleteTask, getLogRound, getProject, getTask, insertTask, listRounds, listTasks,
  nowStr, updateTask } from '../lib/db.js';
import { jsonBody } from '../lib/http.js';
import * as loadcase from '../lib/loadcase.js';
import { py_field_str as pyFieldStr } from '../lib/loadgen.js';
import {
  bugCases, bugCasesScripted, isDir, isFile, pyIntOr, pyIsDigits, pyJoin, pyStrip, readText,
} from '../lib/lib.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import * as runner from '../lib/runner.js';
import { taskSessionChat } from './sessions.js';

// --------------------------------------------------------------------------
// 写口调用口径（M4.5 复核结论，**已知偏差**）
// 路由层给写口传 `{ db: ctx.db }`（与读口一致），代价是：`lib/db.js:withWriteDb` 在 `{db}`
// 在场时只 `fn(db)`、**不 BEGIN/COMMIT**（事务边界归调用方）⇒ 多语句写口（`db.delete_task`
// 的删轮次+删任务、`waitq.msg_enqueue` 的消息行+等待项行）在**进程崩溃的那一瞬**可能半提交；
// Python 侧每个写口都是 `with connect()` 一事务（db.py:1117-1119 / waitq.py:1195-1209）。
// 终态在正常路径下完全相同（M4.5 实例级对拍逐 op 比过落库 dump），差异只在崩溃窗口。
//
// **为什么现在不修**：`{db}` 在本库内部是「加入调用方事务」的既有惯用法（例：`waitq.cancelAllActive`
// 与 `_finish_all_ext` 先开一个事务、再循环调用 `cancel(..., {db: handle})`），把 `{db}` 改成
// 无条件 `BEGIN` 会立刻撞「cannot start a transaction within a transaction」。
// 正确修法是给 withWriteDb 加一个**独立**选项（如 `{db, tx: true}` = 在本句柄上开事务）、
// 逐个调用点判定语义，属 M5/M6 的重构项，已登记在 M4.5 实施记录 §六。
// --------------------------------------------------------------------------
import { effectiveModel } from '../lib/servercaps.js';
import { readDialogue, readLogTail, taskJson } from '../lib/taskjson.js';

/**
 * Python `int(text)` 的严格版（**读路径的 `tail` 用**）：解析失败返回 `null`（调用方据此
 * 复刻「掐断连接」）。只认「两侧 Python 空白 + 可选正负号 + ASCII 数字」，见文件头 ③。
 * 写路径（`continue` 的 `int()`，含 `int("1_0")==10`）用下面另一个 `pyIntStrict`。
 * @param {string} value
 * @returns {number|null}
 */
function pyIntOrNull(value) {
  const text = pyStrip(value);
  return /^[+-]?[0-9]+$/.test(text) ? Number(text) : null;
}

/**
 * 复刻 Python「异常冒到 socketserver ⇒ 关连接、不回响应」的可观察行为。
 * 见文件头 ②：不用 throw（那会变成未捕获拒绝并杀进程 —— 实测：`tail=abc` 会让整个后端退出）。
 * @param {object} ctx
 */
function abortLikePython(ctx) {
  ctx.res.destroy();
}

// ==========================================================================
// 写路径（M4.5）：任务族 5 条端点
//   POST   /api/projects/<id>/tasks       → _api_create_task(server.py:2592)
//   POST   /api/tasks/<id>/(stop|restart) → _api_task_action(4089)
//   POST   /api/tasks/<id>/continue       → _api_continue_task(4109)
//   PATCH  /api/tasks/<id>                → _api_update_task(4170)
//   DELETE /api/tasks/<id>                → _api_delete_task(4155)
// 常量/助手全部照 server.py 逐行移植；下面每个函数头都标了 Python 基准行号。
// ==========================================================================

/** 任务类型合法值（`server.py:TASK_TYPES`(498)）。`pipeline` 也在集合里，随后单独拒手工创建 */
const TASK_TYPES = new Set([
  'normal', 'fix', 'retest_bug', 'reject', 'script_retest', 'stress', 'regression', 'pipeline',
]);

/** 生命周期阶段 key（有序，index 即先后；`server.py:STAGES`(504)） */
const STAGES = ['gen_case', 'execute', 'report', 'analyze', 'fix', 'deploy', 'retest'];

/**
 * 类型 × 阶段矩阵（`server.py:STAGE_MATRIX`(512)）：start=固定起点，default=终点缺省，
 * ends=可选终点集合（空=不涉及终点选择）。Python 用元组，这里用数组（`includes` 等价 `in`）。
 */
const STAGE_MATRIX = {
  normal: {
    start: 'gen_case',
    default: 'report',
    ends: ['gen_case', 'execute', 'report', 'analyze', 'fix', 'deploy', 'retest'],
  },
  regression: {
    start: 'execute',
    default: 'report',
    ends: ['execute', 'report', 'analyze', 'fix', 'deploy', 'retest'],
  },
  stress: { start: '', default: '', ends: [] },
  fix: { start: 'analyze', default: 'fix', ends: ['analyze', 'fix', 'deploy', 'retest'] },
  retest_bug: { start: '', default: '', ends: [] },
  reject: { start: '', default: '', ends: [] },
  script_retest: { start: '', default: '', ends: [] },
  pipeline: { start: 'analyze', default: '', ends: [] },
};

/** 复测范围三选一 → `[start_stage, end_stage]`（`server.py:RETEST_SCOPES`(528)） */
const RETEST_SCOPES = {
  retest_only: ['retest', 'retest'],
  deploy_retest: ['deploy', 'retest'],
  deploy_only: ['deploy', 'deploy'],
};

/**
 * 提交日期范围格式：`YYYY-MM-DD`（`server.py:DATE_RE`）。
 *
 * **`\d` 必须是 Unicode 面**（`\p{Nd}`）：Python 的 `re` 默认 Unicode，阿拉伯-印度数字写的
 * 日期也能过这道 regex，只有到了双侧比较的 `time.strptime` 才失败（见 `normDateRange`）。
 * 用 `[0-9]` 会把「单侧 Unicode 日期」从 200 变成 400（真 Python 站点对拍实测抓到的差异）。
 */
const DATE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;

/**
 * bug 报告目录名时间戳前缀（`server.py:BUG_DIR_RE`(120)）：`20260822_2027_FS_描述`。
 * `\d` 同样取 Unicode 面（与 `DATE_RE` 同理由：Python 的 `re` 默认 Unicode）。
 */
const BUG_DIR_RE = /^\p{Nd}{8}_\p{Nd}{4}_(.+)$/u;

/** 停止条件类型（Python 三处都是元组成员判定） */
const STOP_TYPES = ['rounds', 'bugs', 'deadline', 'duration'];

// ---------- Python 语义助手（本文件私有；口径与 sessparse.js 的同名私有助手一致） ----------

/** Python 真值：`""`/`0`/`None`/`False`/空容器为假（JS 的 `[]`/`{}` 是 truthy，必须显式收口） */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Python `str()`（只覆盖 JSON 里会出现的类型）：str→原样；bool→`True`/`False`；
 * null→`None`；数字→十进制文本；容器→JSON 文本兜底。
 *
 * 容器的兜底与 Python 的 `repr` 形态（`['a']` / `{'k': 1}`）**不逐字一致**——真请求里这些
 * 位置都是字符串，容器只可能来自手写调用/对拍构造；已知差异记在文件尾。
 * `str(None)=='None'` 这条**必须**对（`stop_value: null` 会真的把 `'None'` 落进库，
 * 见下面 `_api_create_task` 的 stop_value 一行）。
 */
function pyStr(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Python `dict.get(key, dflt)`：键存在但值为 null 时**不**回落 dflt（与 Python 同） */
function pyGet(obj, key, dflt = '') {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

/** Python `key in dict`：只看自有键（避免 `'toString' in body` 这种 JS 原型链陷阱） */
function pyHas(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Python `str(x or "")`（x 取自请求体；无 strip） */
function pyStrOrEmpty(value) {
  return pyStr(pyTruthy(value) ? value : '');
}

/** Python `str(x or "").strip()`（`str()` 永不抛） */
function pyStripStr(value) {
  return pyStrip(pyStrOrEmpty(value));
}

/**
 * Python `(x or "").strip()` —— **没有** `str()` 包裹的那种写法。
 *
 * 真值但非字符串时 Python 抛 `AttributeError`（`5 .strip()`），一路冒到 socketserver
 * ⇒ **该连接不回响应、直接断**。这里同形抛错，由 `dispatchSafely` 收口成 `res.destroy()`
 * （与文件头 ② 的 `abortLikePython` 同一可观察结果）。受影响的三个位置：
 * `create_task` 的 `bug_dir` / `reason` / `name`（`server.py:2642/2653/2666`）。
 */
function pyStripBare(value) {
  if (!pyTruthy(value)) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`AttributeError: '${Array.isArray(value) ? 'list' : typeof value}'`
      + " object has no attribute 'strip'");
  }
  return pyStrip(value);
}

/** Python `str.strip("/")`：剥掉两端的全部 `/`（`create_task` 的 bug_dir 归一） */
function pyStripSlashes(value) {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Python `int(x)` 字符串分支的字符面（ASCII 数字 + 单个下划线分隔；见 `pyIntStrict`） */
const PY_INT_STR_RE = /^[+-]?[0-9](?:_?[0-9])*$/;

/**
 * Python `int(x)` 的严格版（**写路径用**）：非法值抛错（调用方按 ValueError 收口）。
 *
 * 为什么不能用 `Number.parseInt`：`parseInt('12px')` 给 12（Python 抛 ValueError）；
 * 也不能用 `Number()`：`Number('')` 给 0。接受面逐条对齐 CPython：两侧 Python 空白、
 * 可选正负号、数字间可有**单个**下划线（`int("1_0")==10`、`int("1__0")` 抛）。
 * 已知残余差异：Unicode 数字（`int("١٢")==12`）本实现不认（全仓口径，见文件尾）。
 * @param {unknown} value
 * @returns {number}
 */
function pyIntStrict(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`int() 不接受 ${value}`);
    return Math.trunc(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = pyStrip(value);
  if (!PY_INT_STR_RE.test(text)) {
    throw new TypeError(`invalid literal for int() with base 10: ${JSON.stringify(text)}`);
  }
  return Number(text.replaceAll('_', ''));
}

/** Python 集合成员判定的可哈希性：dict/list 不可哈希（`x in <set>` 在那里会抛 TypeError） */
function isHashable(value) {
  return !(value !== null && typeof value === 'object');
}

/**
 * `time.strptime(text, "%Y-%m-%d")` 的可比较值（`YYYYMMDD` 整数）；失败返回 `null`
 * （= Python 抛 ValueError）。
 *
 * 为什么不能只比字符串字典序：`2026-13-01` / `2026-02-30` / `0000-01-01` 都能过格式正则，
 * 但 `_strptime` 会做**日历校验**（年 1..9999、月 1..12、日不超当月长度、闰年 2 月 29）
 * 并抛 ValueError ⇒ 端点回 400。只比字典序会把这些全放行（真 Python 站点对拍实测抓到）。
 * 非 ASCII 数字同理（`_strptime` 吃不下 Nd 数字，实测 `٢٠٢٦-٠١-٠١` 抛 ValueError）。
 */
function pyStrtimeDate(text) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) return null;
  return year * 10000 + month * 100 + day;
}

/**
 * `server.py:_norm_date_range`(536)：校验日期范围，返回 `[from, to, err]`。
 *
 * 三个 err 文案（bad date_from / bad date_to / from > to / bad date）不出响应体
 * （调用方统一回「日期范围非法」），故这里只保留「有没有错」的语义。
 *
 * 两条容易写错的语义（都照 Python 写）：
 *   - **strptime 只在双侧都有值时执行**：单侧的 `2026-13-01`（越界月）Python 是放行的，
 *     原样落库；双侧才做日历校验；
 *   - 比较在双侧 ASCII 且日历合法后进行（`pyStrtimeDate` 已把日期折成可比整数）。
 */
function normDateRange(dateFrom, dateTo) {
  if (dateFrom && !DATE_RE.test(dateFrom)) return ['', '', 'bad date_from'];
  if (dateTo && !DATE_RE.test(dateTo)) return ['', '', 'bad date_to'];
  if (dateFrom && dateTo) {
    const fromValue = pyStrtimeDate(dateFrom);
    const toValue = pyStrtimeDate(dateTo);
    if (fromValue === null || toValue === null) return ['', '', 'bad date'];
    if (fromValue > toValue) return ['', '', 'from > to'];
  }
  return [dateFrom, dateTo, ''];
}

/**
 * `server.py:_resolve_stages`(553)：按类型解析 `[startStage, endStage, err]`。
 * `ends` 为空（stress/reject/script_retest/pipeline/retest_bug）⇒ `['', '', null]`。
 */
function resolveStages(taskType, body) {
  const spec = STAGE_MATRIX[taskType] || {};
  if (!spec.ends || spec.ends.length === 0) return ['', '', null];
  const end = pyStripStr(pyGet(body, 'end_stage', undefined)) || spec.default;
  if (!spec.ends.includes(end)) return ['', '', 'end_stage 非法'];
  return [spec.start, end, null];
}

/**
 * `_api_create_task`(server.py:2592)：创建任务（含 pipeline 连带创建）。
 *
 * 逐点照抄清单（顺序**就是**语义，别重排）：
 *   1. 归属 → 404；task_type 合法性（`pipeline` 此时仍算合法）；
 *   2. 日期范围 → retest_scope（仅 retest_bug）/ STAGE_MATRIX 终点（其余类型）；
 *   3. 拒手工创建 pipeline → regression 必填 extra；
 *   4. fix/retest_bug/reject/script_retest 绑定 bug 报告（retest_bug 带日期范围可不绑定；
 *      reject 还必填 reason；retest_only 且用例全固化 ⇒ 自动改走 script_retest）；
 *   5. 名称推导（前缀 + bug 目录描述 / 日期范围 / 类型名 + now_str）；
 *   6. stop_type 校验 → stress 覆写 payload/停止条件；
 *   7. auto_* 与 fix 的终点推导 → cases_base（`state_cache.get` 包 try/except → 0）；
 *   8. insert_task → submit →（终点在 report 之后时）连带 pipeline 行 + 第二次 submit。
 *
 * `runner.INSTANCE` 为 null 时**不静默 no-op**：直接让它抛（= Python 的 AttributeError），
 * 由 `dispatchSafely` 掐断这一条连接；此时任务行已落库（与 Python 的写序逐点同）。
 * @param {object} ctx
 * @param {number} projectId
 */
async function apiCreateTask(ctx, projectId) {
  const body = await ctx.readBody();               // Python do_POST:1048 统一读体
  const project = ctx.ownedProject(projectId);
  if (project === null) return;                    // 已回 404 project not found

  // task_type 合法性：Python `task_type not in TASK_TYPES` 是**集合**成员判定，不可哈希值
  // （list/dict）在那里抛 TypeError ⇒ 断连接；这里复刻同一可观察结果。
  const taskTypeRaw = pyGet(body, 'task_type', 'normal');
  if (!TASK_TYPES.has(taskTypeRaw)) {
    if (!isHashable(taskTypeRaw)) {
      ctx.res.destroy();
      return;
    }
    ctx.error(400, 'task_type 非法');
    return;
  }
  let taskType = taskTypeRaw;

  // 提交日期范围（复测/探索可选）：YYYY-MM-DD；首轮 prompt 注入该范围内 git 提交与变更文件
  const dateFrom0 = pyStripStr(pyGet(body, 'date_from', ''));
  const dateTo0 = pyStripStr(pyGet(body, 'date_to', ''));
  const [dateFrom, dateTo, dateErr] = normDateRange(dateFrom0, dateTo0);
  if (dateErr) {
    ctx.error(400, '日期范围非法');
    return;
  }

  // 阶段范围解析：复测来自 retest_scope 三选一（缺省 retest_only），其余按 STAGE_MATRIX 校验终点
  let startStage = '';
  let endStage = '';
  let scope = '';
  if (taskType === 'retest_bug') {
    const scopeRaw = pyGet(body, 'retest_scope', null);      // 无缺省 ⇒ None，再 `or "retest_only"`
    scope = pyStrip(pyStr(pyTruthy(scopeRaw) ? scopeRaw : 'retest_only'));
    if (!Object.prototype.hasOwnProperty.call(RETEST_SCOPES, scope)) {
      ctx.error(400, 'retest_scope 非法');
      return;
    }
    [startStage, endStage] = RETEST_SCOPES[scope];
  } else {
    const [start, end, err] = resolveStages(taskType, body);
    if (err) {
      ctx.error(400, 'end_stage 非法');
      return;
    }
    startStage = start;
    endStage = end;
  }

  // pipeline 为平台自动创建的后段任务，不接受外部直接创建
  if (taskType === 'pipeline') {
    ctx.error(400, 'pipeline 为平台自动创建的后段任务，不支持手动创建');
    return;
  }

  // 回归任务：重跑指令（extra）必填 —— agent 按指令决定重跑哪些用例
  if (taskType === 'regression' && !pyStripStr(pyGet(body, 'extra', ''))) {
    ctx.error(400, '请填写重跑指令');
    return;
  }

  // fix / retest_bug / reject / script_retest 绑定一枚 bug 报告（目录名），固定只跑一轮；
  // retest_bug 带日期范围时不绑定报告（无报告复测，LLM 判影响面）
  let payload = '';
  let bugDir = '';
  if (['fix', 'retest_bug', 'reject', 'script_retest'].includes(taskType)) {
    bugDir = pyStripSlashes(pyStripBare(pyGet(body, 'bug_dir', undefined)));
    if (!bugDir && taskType === 'retest_bug' && (dateFrom || dateTo)) {
      // 日期范围复测：无需 bug 报告
    } else if (!bugDir || !isDir(pyJoin(project.bug_dir, bugDir))) {
      ctx.error(400, 'bug 报告目录不存在');
      return;
    } else {
      const payloadObj = { bug_dir: bugDir };
      if (taskType === 'reject') {
        // 拒绝理由随任务固化：修例 prompt 的依据，重启重跑仍携带
        const reason = pyStripBare(pyGet(body, 'reason', undefined));
        if (!reason) {
          ctx.error(400, '请填写拒绝理由');
          return;
        }
        payloadObj.reason = reason;
      }
      payload = pyJsonDumps(payloadObj);          // = json.dumps(..., ensure_ascii=False)
      // 复测自动选型：仅「仅复测」范围且关联用例全部已固化（各有 verify.py）时改走脚本复测
      if (taskType === 'retest_bug' && scope === 'retest_only') {
        const { ids } = bugCases(pyJoin(project.bug_dir, bugDir));
        if (bugCasesScripted(project.cases_root, ids)) taskType = 'script_retest';
      }
    }
  }

  let name = pyStripBare(pyGet(body, 'name', undefined));
  if (!name && ['fix', 'retest_bug', 'reject', 'script_retest'].includes(taskType)) {
    const prefix = {
      fix: '修复 ', retest_bug: '复测 ', reject: '修例 ', script_retest: '脚本复测 ',
    }[taskType];
    if (bugDir) {
      const m = BUG_DIR_RE.exec(bugDir);
      name = prefix + (m ? m[1] : bugDir);
    } else {
      name = `${prefix}${dateFrom || '最早'}..${dateTo || '现在'}`;
    }
  }
  if (!name && taskType === 'stress') name = `压测 ${nowStr()}`;
  if (!name && taskType === 'regression') name = `回归 ${nowStr()}`;
  if (!name) name = `任务 ${nowStr()}`;

  let stopType = pyGet(body, 'stop_type', 'rounds');
  let stopValue = pyStr(pyGet(body, 'stop_value', '1'));   // 注意：没有 `or ""`，null ⇒ 'None'
  if (!STOP_TYPES.includes(stopType)) {
    ctx.error(400, 'stop_type 非法');
    return;
  }
  // 压测任务：压测说明入 payload；轮次条件固定 1 轮 agent（发压轮由平台直接追加）
  if (taskType === 'stress') {
    payload = pyJsonDumps({ brief: pyStripStr(pyGet(body, 'brief', '')) });
    stopType = 'rounds';
    stopValue = '1';
  }
  const autoFix = pyTruthy(pyGet(body, 'auto_fix', false));
  const retest = pyGet(body, 'retest', '不复测');
  const extra = pyStrOrEmpty(pyGet(body, 'extra', ''));
  // 模型回落链：任务显式指定 > 项目级模型 > ''（CLI 默认模型）；创建这一刻固化进任务行
  const model = pyStripStr(pyGet(body, 'model', '')) || pyStripStr(project.model);
  const permission = pyStripStr(pyGet(body, 'permission', ''));
  const autoCommit = pyTruthy(pyGet(body, 'auto_commit', false));
  let autoDeploy = pyTruthy(pyGet(body, 'auto_deploy', false));
  let autoRetest = pyTruthy(pyGet(body, 'auto_retest', false));
  if (taskType === 'fix') {
    // 修复任务：部署勾选由终点推导（终点含部署/复测即需要部署）；auto_retest 恒 0
    autoDeploy = endStage === 'deploy' || endStage === 'retest';
    autoRetest = 0;
  }

  // 记录创建时的案例库总数，作为该任务新增案例数的基线。**try/except 必须保留**：
  // Python 把 `state_cache.get(...)` 整段包在 `except Exception` 里 —— 案例库扫描的任何
  // 异常（权限、坏目录、缓存实现抛错）都不该让「建任务」这步失败，宁可以 0 为基线。
  let casesBase = 0;
  try {
    const state = ctx.stateCache.get(project.id, project.cases_root, project.bug_dir,
      project.work_dir);
    casesBase = state.library.stats.total ?? 0;   // Python `.get("total", 0)`
  } catch {
    casesBase = 0;
  }

  const taskId = insertTask(projectId, {
    name,
    autoFix,
    retest,
    stopType,
    stopValue,
    taskType,
    payload,
    extra,
    model,
    permission,
    autoCommit,
    autoDeploy,
    autoRetest,
    casesBase,
    startStage,
    endStage,
    dateFrom,
    dateTo,
  }, { db: ctx.db });
  runner.INSTANCE.submit(taskId);

  // 探索/回归终点在「生成报告」之后：连带创建后段任务（单轮，报告分析→终点），
  // 同项目 FIFO 保证其排在前段之后执行。注意 `STAGES.index(end_stage)` 只在类型短路
  // 通过后求值（stress 等 end_stage 为空，Python 若求值会 ValueError）。
  let pipelineId = null;
  if ((taskType === 'normal' || taskType === 'regression')
      && STAGES.indexOf(endStage) > STAGES.indexOf('report')) {
    pipelineId = insertTask(projectId, {
      name: `${name}·后段`,
      autoFix: 0,
      retest: '不复测',
      stopType: 'rounds',
      stopValue: '1',
      taskType: 'pipeline',
      payload: pyJsonDumps({ parent_task_id: taskId }),
      startStage: 'analyze',
      endStage,
    }, { db: ctx.db });
    runner.INSTANCE.submit(pipelineId);
  }

  // 成功体走 json.dumps（带空格），与 Python 逐字节同
  ctx.json(200, { id: taskId, pipeline_id: pipelineId });
}

/**
 * `_api_task_action`(server.py:4089)：stop / restart。
 *
 * `stop` 无状态门禁（运行中/排队中都允许）；`restart` 在 running/queued 时 400
 * （running 行整程 starting、queued 且无活跃行=永不拾取的幽灵，重启只会更乱）。
 */
async function apiTaskAction(ctx, taskId, action) {
  await ctx.readBody();                            // 本端点不用 body，但 Python 已把体读掉
  const row = ctx.ownedTask(taskId);
  if (row === null) return;                        // 已回 404 task not found
  if (action === 'stop') {
    // Node 的 stop 是 async（要 await 驱动的远端 cancel），漏 await 会让「停」变成竞态
    await runner.INSTANCE.stop(taskId);
  } else if (row.status === 'running' || row.status === 'queued') {
    ctx.error(400, '任务运行中或排队中，请先停止');
    return;
  } else {
    runner.INSTANCE.restart(taskId);
  }
  // 成功体是硬编码紧凑字节串（不是 json.dumps）⇒ ctx.text，不能用 ctx.json
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_continue_task`(server.py:4109)：继续任务（改参数后接着当前 session 续跑）。
 *
 * 与 restart 的区别：保留 session_id / current_round / 轮次记录，下一轮用完整首轮
 * 提示词（fresh_prompt=1）。停止条件的轮数/bug 数按「再跑 N 轮 / 再增 V 个」理解，
 * **折算为从当前进度起算的绝对值**；deadline/duration 本身即绝对语义，直接透传。
 */
async function apiContinueTask(ctx, taskId) {
  const body = await ctx.readBody();               // Python do_POST:1048 统一读体
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const rowType = row.task_type || 'normal';
  if (rowType === 'stress' || rowType === 'pipeline') {
    ctx.error(400, '该任务类型不支持继续（重启可从第一轮重跑）');
    return;
  }
  if (row.status === 'running' || row.status === 'queued') {
    ctx.error(400, '任务运行中或排队中，请先停止');
    return;
  }
  const stopType = pyGet(body, 'stop_type', row.stop_type);
  if (!STOP_TYPES.includes(stopType)) {
    ctx.error(400, 'stop_type 非法');
    return;
  }
  // `str(body.get("stop_value", row["stop_value"]) or "").strip()`：键存在但 null ⇒ ''
  let stopValue = pyStrip(pyStrOrEmpty(pyGet(body, 'stop_value', row.stop_value)));
  try {
    if (stopType === 'rounds') {
      stopValue = String(pyIntStrict(row.current_round || 0) + pyIntStrict(stopValue || '1'));
    } else if (stopType === 'bugs') {
      stopValue = String(pyIntStrict(row.new_bugs || 0) + pyIntStrict(stopValue || '1'));
    }
  } catch {
    // Python `except ValueError`（int() 解析失败）⇒ 400；TypeError 一并收（同一可观察）
    ctx.error(400, 'stop_value 非法');
    return;
  }
  const name = pyStripStr(pyGet(body, 'name', row.name)) || row.name;
  const retestRaw = pyGet(body, 'retest', row.retest);
  const extraRaw = pyGet(body, 'extra', row.extra);
  // 字段顺序 = Python kwargs 顺序（dict 保序 ⇒ SQL 列序可比），且全部在 update_task 白名单内
  updateTask(taskId, {
    name,
    auto_fix: pyTruthy(pyGet(body, 'auto_fix', row.auto_fix)) ? 1 : 0,
    retest: pyStr(pyTruthy(retestRaw) ? retestRaw : row.retest),
    stop_type: stopType,
    stop_value: stopValue,
    extra: pyStr(pyTruthy(extraRaw) ? extraRaw : ''),
    fresh_prompt: 1,
  }, { db: ctx.db });
  runner.INSTANCE.resume(taskId);
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_update_task`(server.py:4170)：更新任务运行参数（改动需重启任务生效）。
 *
 * 逐字段 `if "x" in body` 判定 —— **不是**「取到就用」：缺省的键一律不碰，
 * 空 body ⇒ 一条 UPDATE 都不发（Python `if fields:` 同）。八个字段的写入顺序照抄 Python。
 */
async function apiUpdateTask(ctx, taskId) {
  const body = await ctx.readBody();               // Python do_PATCH:1238 读体
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const fields = {};
  if (pyHas(body, 'model')) fields.model = pyStripStr(pyGet(body, 'model', ''));
  if (pyHas(body, 'permission')) fields.permission = pyStripStr(pyGet(body, 'permission', ''));
  if (pyHas(body, 'auto_commit')) fields.auto_commit = pyTruthy(body.auto_commit) ? 1 : 0;
  if (pyHas(body, 'auto_deploy')) fields.auto_deploy = pyTruthy(body.auto_deploy) ? 1 : 0;
  if (pyHas(body, 'auto_retest')) fields.auto_retest = pyTruthy(body.auto_retest) ? 1 : 0;
  if (pyHas(body, 'extra')) fields.extra = pyStrOrEmpty(pyGet(body, 'extra', ''));
  if (pyHas(body, 'start_stage')) {
    const val = pyStripStr(pyGet(body, 'start_stage', ''));
    if (val && !STAGES.includes(val)) {
      ctx.error(400, 'start_stage 非法');
      return;                                      // 已解析的 fields 一并丢弃（Python 同）
    }
    fields.start_stage = val;
  }
  if (pyHas(body, 'end_stage')) {
    const val = pyStripStr(pyGet(body, 'end_stage', ''));
    if (val && !STAGES.includes(val)) {
      ctx.error(400, 'end_stage 非法');
      return;
    }
    fields.end_stage = val;
  }
  if (Object.keys(fields).length > 0) updateTask(taskId, fields, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_delete_task`(server.py:4155)：删除任务（运行中拒绝；排队中先从队列移除）。
 *
 * **不读体**：Python `do_DELETE` 全程没有 `_read_json()`（与 POST/PATCH 的差别是硬口径）。
 * 顺序也是语义：先 `runner.remove`（取消等待项）再 `db.delete_task`（删行 + 轮次行）。
 */
async function apiDeleteTask(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  if (row.status === 'running') {
    ctx.error(400, '任务运行中，请先停止再删除');
    return;
  }
  runner.INSTANCE.remove(taskId);
  deleteTask(taskId, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

// ==========================================================================
// 压测（load）族 9 条端点（M6-6）：server.py 4256-4740
//   GET  /api/tasks/<id>/load_series      → `_api_load_metrics` 的旧路径别名（1442，无 UI 调用）
//   GET  /api/tasks/<id>/load/case        → `_api_load_case`(4418)
//   GET  /api/tasks/<id>/load/metrics     → `_api_load_metrics`(4373)
//   GET  /api/tasks/<id>/load/runs        → `_api_load_runs`(4521)
//   GET  /api/tasks/<id>/load/custom_html → `_api_load_custom_html`(4441)
//   GET  /api/tasks/<id>/load_report      → `_api_load_report`(4470)
//   GET  /api/tasks/<id>/load/stream      → `_api_load_stream`(4670)
//   POST /api/tasks/<id>/load/rerun       → `_api_load_rerun`(4592)
//   POST /api/tasks/<id>/load/diagnose    → `_api_load_diagnose`(4616)（复用 session/chat 的组装体）
//
// 三处**同一族里两种字节形态混排**（照 oracle，不许"统一一下更整齐"）：
//   ① 失败体一律硬编码紧凑：`b'{"error":"task not found"}'`(4377/4428/4599…)、
//      `b'{"error":"run not found"}'`(4514)、`b'{"error":"custom view not found"}'`(4450)、
//      `{"error":"仅压测任务支持复压"}`(4603) ⇒ `ctx.error` / `ctx.text`；
//   ② `load_report` 的 `b'{"found":false}'`(4518) 与 `rerun` 的**成功体** `b'{"ok":true}'`(4613)
//      都是硬编码紧凑 ⇒ `ctx.text`；
//   ③ 其余成功体走 `json.dumps(..., ensure_ascii=False)`（4414/4438/4508/4556/4700）⇒ `ctx.json`。
//
// `load/stream` **不是** `ctx.sse` 的命名帧形态：头部只有 Content-Type + Cache-Control
// （无 `X-Accel-Buffering`，见 lib/http.js 的 `accelBuffering` 缺省 false）、帧是裸
// `id: <行号>\ndata: <样本>\n\n`、结束补 `data: {"done":true}\n\n`，并读请求头
// `Last-Event-ID` 做断线续传（首连只回放最后 20000 行）。故这里用 `ctx.sse({}).raw()` 直写。
// ==========================================================================

/** `LOAD_STREAM_REPLAY_MAX`（server.py:492）：首连只回放最后 20000 行 */
const LOAD_STREAM_REPLAY_MAX = 20000;

/** `pyJsonLoads` 的哨兵串（与 `prompts.js` / `db.js` 同一算法：只换字符串之外的字面量） */
const PY_JSON_NAN = '\u0000py-json:NaN\u0000';
const PY_JSON_INF = '\u0000py-json:Infinity\u0000';
const PY_JSON_NEG_INF = '\u0000py-json:-Infinity\u0000';

/** 把源码里**字符串之外**的 `NaN`/`Infinity`/`-Infinity` 换成哨兵串；一处都没换返回 null */
function patchPyJsonSpecials(src) {
  let out = '';
  let changed = false;
  let inString = false;
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue; }
    if (src.startsWith('-Infinity', i)) {
      out += JSON.stringify(PY_JSON_NEG_INF); i += 9; changed = true; continue;
    }
    if (src.startsWith('Infinity', i)) {
      out += JSON.stringify(PY_JSON_INF); i += 8; changed = true; continue;
    }
    if (src.startsWith('NaN', i)) {
      out += JSON.stringify(PY_JSON_NAN); i += 3; changed = true; continue;
    }
    out += ch;
    i += 1;
  }
  return changed ? out : null;
}

/**
 * CPython `json.loads()` 的读侧对应物（压测指标行/报告 JSON 用）。
 *
 * 与 `JSON.parse` 的两处可观察差异：① Python 认裸 `NaN`/`Infinity`/`-Infinity`
 * （`json.loads` 的 `parse_constant` 缺省放行），JS 的 `JSON.parse` 直接抛；
 * ② 失败时都当 ValueError 处理（调用方按「坏行跳过」/「坏文件返回 {}」收口）。
 * 严格解析失败且源码里真的含这三个字面量时才走哨兵替换（与 `prompts.js` 同法）。
 */
function pyJsonLoads(src) {
  try {
    return JSON.parse(src);
  } catch (strictError) {
    const patched = patchPyJsonSpecials(src);
    if (patched === null) throw strictError;
    return JSON.parse(patched, (key, value) => {
      if (value === PY_JSON_NAN) return NaN;
      if (value === PY_JSON_INF) return Infinity;
      if (value === PY_JSON_NEG_INF) return -Infinity;
      return value;
    });
  }
}

/**
 * `JSON.parse` 的 reviver 带 `context.source`（Node ≥21 的 JSON.parse source text access，
 * 本机 24 实测可用）⇒ 能区分「JSON 里写的是 `1190` 还是 `1190.0`」，即 Python 的
 * **int 与 float**。诊断文案的 `f"{k}={v}"` 两者渲染不同（`1190` vs `0.0`），
 * 而 JS 的 number 分不出——故这里把两者分别包成 `PyInt` / `PyFloat` 盒子，
 * 只给诊断文案的渲染器看（不参与任何算术）。
 */
class PyInt {
  constructor(value) { this.value = value; }
}

/** 同 `PyInt`：JSON 原文带 `.`/`e` 的数字在 Python 里是 float（整数值也渲染成 `x.0`） */
class PyFloat {
  constructor(value) { this.value = value; }
}

/** 该 reviver 的第二参（按 JSON 原文分 int/float；其余原样） */
function pyTypedReviver(key, value, context) {
  if (typeof value !== 'number') return value;
  const src = context && typeof context.source === 'string' ? context.source : '';
  if (/^[+-]?\d+$/.test(src)) return new PyInt(value);
  return new PyFloat(value);
}

/** 与 `pyJsonLoads` 同，但保留 int/float 之别（诊断文案专用；哨兵路径不保留 int 之别） */
function pyJsonLoadsTyped(src) {
  try {
    return JSON.parse(src, pyTypedReviver);
  } catch (strictError) {
    const patched = patchPyJsonSpecials(src);
    if (patched === null) throw strictError;
    return JSON.parse(patched);
  }
}

/**
 * Python `open(path, encoding="utf-8", errors="replace")` 的**行迭代**对应物：
 * 通用换行（`\r\n`/`\r` → `\n`），且**末尾换行不产生额外空行**。
 * （`String.split("\n")` 会多出最后那个空元素——指标行号会因此整体偏移。）
 */
function pyReadLines(filePath) {
  const text = fs.readFileSync(String(filePath)).toString('utf8');
  const norm = text.replace(/\r\n|\r/g, '\n');
  if (norm === '') return [];
  const lines = norm.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** `_load_run_row`(4268)：显式运行键 → 正在跑的 load 行 → 最新一条 load 行；无则 null */
function loadRunRow(row, run, ctx) {
  const rows = listRounds(row.id, { db: ctx.db }).filter((r) => r.kind === 'load');
  if (run) {
    for (const r of rows) if (r.run_key === run) return r;
    return null;
  }
  for (const r of rows) if (r.status === 'running') return r;
  return rows.length ? rows[rows.length - 1] : null;
}

/** `_load_run_paths`(4288)：按运行行推导（日志, 指标, 报告主名）+ 两级回落 */
function loadRunPaths(row, runRow, ctx) {
  const project = getProject(row.project_id, { db: ctx.db });
  const taskId = row.id;
  const workDir = project.work_dir;
  const repDir = loadcase.report_dir(project.cases_root);
  const runKey = runRow !== null && runRow !== undefined ? runRow.run_key : '';
  const logPath = (runRow !== null && runRow !== undefined && runRow.log_path)
    ? runRow.log_path
    : loadcase.load_log_path(workDir, taskId, runKey);
  let metrics = loadcase.metrics_path(workDir, taskId, runKey);
  if (runKey && !isFile(metrics)) {
    const legacy = loadcase.metrics_path(workDir, taskId);
    if (isFile(legacy)) metrics = legacy;
  }
  let stem;
  if (runKey) {
    stem = loadcase.report_stem(repDir, taskId, runKey);
  } else {
    let newest = null;
    for (const rep of loadcase.list_reports(project.cases_root, taskId)) {
      newest = rep.json_path.slice(0, -5);
      break;                                   // list_reports 已按运行键倒序
    }
    stem = newest || loadcase.report_stem(repDir, taskId, '');
  }
  return { log_path: logPath, metrics, stem };
}

/** `_load_metrics_source`(4316)：指标读侧数据源 `(路径, 是否旧快照)` */
function loadMetricsSource(row, run, ctx) {
  const project = getProject(row.project_id, { db: ctx.db });
  const runRow = loadRunRow(row, run, ctx);
  if (run && runRow === null) {
    // 孤儿/未知运行键：按该键推导路径（不回落到「最新一次运行」）
    return [loadcase.metrics_path(project.work_dir, row.id, run), false];
  }
  const { metrics } = loadRunPaths(row, runRow, ctx);
  if (isFile(metrics)) return [metrics, false];
  const legacy = loadcase.legacy_snapshot_path(project.work_dir, row.id);
  if (isFile(legacy)) return [legacy, true];
  return [metrics, false];
}

/** `_normalize_raw`(4338)：指标文件一行（bytes）→ 规范样本列表（坏行返回空列表） */
function normalizeRaw(raw) {
  let obj;
  try {
    obj = pyJsonLoads(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return [];
  }
  return loadcase.normalize_line(obj);
}

/**
 * `_scan_metrics`(4347)：定位回放起点 `[起始字节偏移, 起始 0-based 行号]`。
 * `after` 优先，`tail` 只保留最后 tail 行的起点。二进制按 `\n` 分行（末行无换行也算一行）。
 */
function scanMetrics(filePath, after = 0, tail = 0) {
  if (!filePath || (after <= 0 && tail <= 0)) return [0, 0];
  const starts = tail ? [] : null;
  let offset = 0;
  let no = 0;
  let buf;
  try {
    buf = fs.readFileSync(String(filePath));
  } catch {
    return [0, 0];                             // 照 Python：OSError → (0, 0)
  }
  let idx = 0;
  while (idx < buf.length) {
    if (after && no === after) return [offset, no];
    if (starts !== null) {
      starts.push([offset, no]);
      if (starts.length > tail) starts.shift();      // collections.deque(maxlen=tail)
    }
    const nl = buf.indexOf(0x0a, idx);
    const end = nl === -1 ? buf.length : nl + 1;
    offset += end - idx;
    no += 1;
    idx = end;
  }
  if (starts !== null && starts.length) return starts[0];
  return [offset, no];
}

/** `_report_kpi`(4558)：报告 JSON 的轻量 KPI（前 6 项）；坏文件返回 {} */
function reportKpi(jsonPath) {
  let obj;
  try {
    obj = pyJsonLoads(readText(jsonPath) || '{}');
  } catch {
    return {};
  }
  const summary = (obj !== null && typeof obj === 'object' && !Array.isArray(obj))
    ? obj.summary : null;
  if (!(summary !== null && typeof summary === 'object' && !Array.isArray(summary))) return {};
  return Object.fromEntries(Object.entries(summary).slice(0, 6));
}

/** `_run_item`(4569)：一条已登记运行 → 运行列表项（键序即 Python dict 字面量序） */
function runItem(row, project, roundRow) {
  const runKey = roundRow.run_key;
  const repDir = loadcase.report_dir(project.cases_root);
  const stem = loadcase.report_stem(repDir, row.id, runKey);
  return {
    run_key: runKey,
    round_no: round_row_no(roundRow),
    status: roundRow.status,
    started_at: roundRow.started_at || '',
    ended_at: roundRow.ended_at || '',
    exit_code: roundRow.exit_code === undefined ? null : roundRow.exit_code,
    summary_text: roundRow.summary || '',
    kpi: reportKpi(`${stem}.json`),
    has_report: isFile(`${stem}.json`),
    has_metrics: isFile(loadcase.metrics_path(project.work_dir, row.id, runKey)),
    registered: true,
    legacy: false,
    mtime: 0.0,
    is_current: roundRow.status === 'running',
  };
}

/** sqlite 行的 `round_no`（列 NOT NULL；null 也照原样回） */
function round_row_no(roundRow) {
  return roundRow.round_no === undefined ? null : roundRow.round_no;
}

/** `_api_load_metrics`(4373)：`?after=N` 增量 + `?limit=` 限条；`?run=` 指定历史运行 */
function apiLoadMetrics(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;                    // 已回 404 task not found
  let after = pyIntOrNull(ctx.q('after', '0'));
  if (after === null) after = 0;               // int() 抛 ValueError ⇒ 0
  after = Math.max(0, after);
  let limit = pyIntOrNull(ctx.q('limit', '20000'));
  if (limit === null) limit = 20000;
  limit = Math.min(Math.max(1, limit), 50000);
  const [metricsPath] = loadMetricsSource(row, ctx.q('run', ''), ctx);
  const samples = [];
  let lastNo = after - 1;
  let lines = null;
  try {
    lines = pyReadLines(metricsPath);
  } catch {
    lines = null;                              // 文件尚不存在 ⇒ 空列表
  }
  if (lines !== null) {
    for (let i = 0; i < lines.length; i += 1) {
      if (i < after) continue;
      const line = pyStrip(lines[i]);
      if (line) {
        let obj = null;
        try {
          obj = pyJsonLoads(line);
        } catch {
          obj = null;                          // 半行/坏行：跳过但行号照常推进
        }
        if (obj !== null) for (const s of loadcase.normalize_line(obj)) samples.push(s);
      }
      lastNo = i;
      if (samples.length >= limit) break;
    }
  }
  ctx.json(200, { samples, next: lastNo + 1 });
}

/** `_api_load_case`(4418)：方案包资产（`?meta=1` 只回轻量标记） */
function apiLoadCase(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const project = getProject(row.project_id, { db: ctx.db });
  const assets = loadcase.read_assets(project.cases_root, taskId);
  delete assets.case_dir;
  delete assets.html_path;
  const charts = pyTruthy(assets.charts) ? assets.charts : {};
  assets.panels = (pyTruthy(charts.panels) ? charts.panels : []).length;
  if (pyTruthy(ctx.q('meta', ''))) {
    delete assets.plan_md;
    delete assets.script_text;
  }
  ctx.json(200, assets);
}

/** `_api_load_custom_html`(4441)：逃生舱 panel.html（CSP sandbox + nosniff 两头） */
function apiLoadCustomHtml(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const project = getProject(row.project_id, { db: ctx.db });
  const target = loadcase.resolve(project.cases_root, taskId).html_path;
  if (!target) {
    ctx.error(404, 'custom view not found');   // 硬编码紧凑
    return;
  }
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    ctx.error(404, 'custom view unreadable');  // 硬编码紧凑
    return;
  }
  ctx.text(200, body, 'text/html; charset=utf-8', {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox allow-scripts',
  });
}

/** `_api_load_report`(4470)：报告 JSON + Markdown 全文（`?run=` 指定历史运行） */
function apiLoadReport(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const run = ctx.q('run', '');
  const runRow = loadRunRow(row, run, ctx);
  const project = getProject(row.project_id, { db: ctx.db });
  const repDir = loadcase.report_dir(project.cases_root);
  let stem;
  if (run && runRow === null) {
    // 孤儿报告：按运行键直接找文件，找不到才 404（registered=false）
    stem = loadcase.report_stem(repDir, taskId, run);
  } else {
    stem = loadRunPaths(row, runRow, ctx).stem;
  }
  let found = `${stem}.json`;
  if (!isFile(found) && !run) {
    // 存量任务：报告可能仍是分钟级命名，取目录里最新一份
    try {
      const cands = fs.readdirSync(repDir)
        .filter((n) => n.startsWith(`task${taskId}_`) && n.endsWith('.json'))
        .map((n) => path.join(repDir, n));
      let best = '';
      let bestM = -Infinity;
      for (const cand of cands) {
        const m = fs.statSync(cand).mtimeMs;
        if (m > bestM) { bestM = m; best = cand; }   // Python max()：并列取先出现者
      }
      found = best;
    } catch {
      found = '';
    }
  }
  if (run && !isFile(found)) {
    ctx.error(404, 'run not found');           // 硬编码紧凑
    return;
  }
  if (!found || !isFile(found)) {
    ctx.text(200, '{"found":false}', 'application/json; charset=utf-8');
    return;
  }
  let report;
  try {
    report = pyJsonLoads(readText(found) || '{}');
  } catch {
    report = {};
  }
  const md = readText(`${found.slice(0, -5)}.md`);
  ctx.json(200, {
    found: true,
    report,
    md,
    run_key: runRow !== null ? runRow.run_key : run,
    file: path.basename(found),
  });
}

/** `_api_load_runs`(4521)：运行列表（rounds 里 kind='load' 的行 + 报告目录里的孤儿报告） */
function apiLoadRuns(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const project = getProject(row.project_id, { db: ctx.db });
  const workDir = project.work_dir;
  const runs = [];
  const seen = new Set();
  for (const r of listRounds(taskId, { db: ctx.db })) {
    if (r.kind !== 'load') continue;
    seen.add(r.run_key);
    runs.push(runItem(row, project, r));
  }
  for (const rep of loadcase.list_reports(project.cases_root, taskId)) {
    if (seen.has(rep.run_key)) continue;
    runs.push({
      run_key: rep.run_key,
      round_no: null,
      status: 'unknown',
      started_at: '',
      ended_at: '',
      exit_code: null,
      summary_text: '',
      kpi: reportKpi(rep.json_path),
      has_report: true,
      has_metrics: isFile(loadcase.metrics_path(workDir, taskId, rep.run_key)),
      registered: false,
      legacy: Boolean(rep.legacy),
      mtime: rep.mtime,
    });
  }
  // Python `runs.sort(key=..., reverse=True)`：稳定排序，同键保持原相对序
  runs.sort((a, b) => pyStrCompareDesc(a.run_key, b.run_key));
  ctx.json(200, { runs });
}

/** 运行键倒序比较（ASCII 数字+下划线，直接按码点；相等返回 0 以保稳定） */
function pyStrCompareDesc(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  return x < y ? 1 : -1;
}

/** `_api_load_rerun`(4592)：复压（门禁同 restart；入队走统一队列） */
async function apiLoadRerun(ctx, taskId) {
  await ctx.readBody();                        // Python 在 do_POST:1048 统一读体
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  if ((row.task_type || 'normal') !== 'stress') {
    ctx.text(400, '{"error":"仅压测任务支持复压"}', 'application/json; charset=utf-8');
    return;
  }
  if (row.status === 'running' || row.status === 'queued') {
    ctx.text(400, '{"error":"任务运行中或排队中，请先停止"}', 'application/json; charset=utf-8');
    return;
  }
  runner.INSTANCE.rerunLoad(taskId);
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');   // 成功体也是硬编码紧凑
}

/**
 * `_read_summary_entries`：`loadcase.read_summary` 的**保留 int/float 之别**的兄弟。
 *
 * 为什么不能直接用 `loadcase.read_summary`：Python 的 `f"{k}={v}"` 对 int 与 float
 * 渲染不同（真实样本里 `受理委托=1190`、`错误率=0.0` 同时存在），而 JS 的 number 分不出
 * 二者 ⇒ 用带 `context.source` 的 reviver 读回数字 token 原文（见 `PyInt`）。
 * 其余语义逐条照 `read_summary`：流式扫描、取**最后一条** summary 行、异常整体吞掉。
 */
function readSummaryEntries(filePath) {
  let found = [];
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(65536);
  let carry = '';
  const eat = (line) => {
    const raw = pyStrip(line);
    if (!raw || !raw.includes('"summary"')) return;
    let obj;
    try {
      obj = pyJsonLoadsTyped(raw);
    } catch {
      return;
    }
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj) && obj.kind === 'summary') {
      const vals = obj.values;
      if (vals !== null && typeof vals === 'object' && !Array.isArray(vals)) {
        found = Object.entries(vals);
      }
    }
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      carry += decoder.write(buf.subarray(0, n));
      let idx;
      while ((idx = carry.indexOf('\n')) >= 0) {
        eat(carry.slice(0, idx));
        carry = carry.slice(idx + 1);
      }
    }
    carry += decoder.end();
    if (carry) eat(carry);
  } catch (e) {
    if (e && typeof e.code === 'string') return [];     // 读中途 OSError：照 Python 整体吞掉
    throw e;
  } finally {
    try {
      fs.closeSync(fd);
    } catch { /* 已关 */ }
  }
  return found;
}

/** Python f-string 的 `{value}`：int 走十进制、float 走 repr、容器走 pyStr 兜底 */
function pyFstringValue(value) {
  if (value instanceof PyInt) return String(value.value);
  if (value instanceof PyFloat) return pyFieldStr(value.value);
  if (typeof value === 'number') return pyFieldStr(value);
  return pyStr(value);
}

/**
 * Python f-string 里**已知是 int** 的列（`rounds.round_no` 是 INTEGER 列，不是 JSON 数字）：
 * `None` → `"None"`，其余十进制。
 *
 * 为什么不能复用 `pyFstringValue`：那里按「float repr」渲染数值（整数值补 `.0`），
 * 对 JSON 里的浮点是**对的**，对 sqlite 的整数列会渲染成 `3.0`（M6-6 单测实测抓出）。
 */
function pyIntText(value) {
  return value === null || value === undefined ? 'None' : String(value);
}

/** `_load_diagnose_text`(4632)：组装诊断消息（截断日志尾；供 `_api_load_diagnose` 使用） */
function loadDiagnoseText(row, ctx) {
  const project = getProject(row.project_id, { db: ctx.db });
  const taskId = row.id;
  const runRow = loadRunRow(row, '', ctx);
  const paths = loadRunPaths(row, runRow, ctx);
  const kase = loadcase.resolve(project.cases_root, taskId);
  const kpi = readSummaryEntries(paths.metrics);
  const kpiText = kpi.slice(0, 12).map(([k, v]) => `${k}=${pyFstringValue(v)}`).join('、')
    || '（无收尾 KPI）';
  let head;
  if (runRow !== null) {
    const exitCode = runRow.exit_code === null || runRow.exit_code === undefined
      ? '—' : String(runRow.exit_code);
    head = `【压测运行现场】任务 #${taskId}「${row.name}」\n`
      + `- 最近一次运行：运行键 ${runRow.run_key}`
      + `（轮次 ${pyIntText(runRow.round_no)}）状态 ${runRow.status}`
      + ` 退出码 ${exitCode}\n`
      + `- 开始 ${runRow.started_at || '—'} · 结束 ${runRow.ended_at || '—'}\n`;
  } else {
    head = `【压测运行现场】任务 #${taskId}「${row.name}」\n`
      + '- 该任务尚无运行记录（存量任务）\n';
  }
  const files = [];
  for (const [name, p] of [['run.py', kase.script_path], ['scenario.json', kase.scenario_path],
    ['charts.json', kase.charts_path], ['panel.html', kase.html_path]]) {
    if (p && isFile(p)) files.push(`${name}(${fs.statSync(p).size}B)`);
  }
  const body = head
    + `- 方案包：${kase.case_dir}（${files.join('、') || '空'}）\n`
    + `- 指标摘要：${kpiText}\n`
    + `- 日志尾（${path.basename(paths.log_path)}）：\n`
    + '```\n'
    + pySliceCodePoints(pyStrip(readLogTail(paths.log_path, 60) || '') || '（无日志）', 6000)
    + '\n```\n'
    + '请判断这次发压是否正常、方案包（run.py / charts.json / plan.md）'
    + '是否需要修正；如需修正请直接改方案包文件，改完告诉我「已改好」，'
    + '我会在压测面板点「复压」再跑一次。**不要自己执行压测脚本**'
    + '（发压必须由平台托管，才能被停止/超时保护并留下运行记录）。';
  return pySliceCodePoints(body, chat.MESSAGE_MAX);
}

/** Python `text[:n]`（按**码点**切片，不是 UTF-16 码元 —— emoji 上会差一个字符） */
function pySliceCodePoints(text, n) {
  const chars = Array.from(String(text));
  return chars.length <= n ? String(text) : chars.slice(0, n).join('');
}

/**
 * `_api_load_diagnose`(4616)：把最近一次运行的执行现场发给该任务的 agent 会话。
 * 复用 `POST /api/tasks/<id>/session/chat` 的既有路径（进统一队列的 `m:` 单元），
 * 故这里只组装文本；调度/会话校验/错误文案全部沿用对话接口。
 */
async function apiLoadDiagnose(ctx, taskId) {
  await ctx.readBody();                        // Python 在 do_POST:1048 统一读体
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const text = loadDiagnoseText(row, ctx);
  // Python 传给 `_api_session_chat` 的是**合成 body**（`{"message": text}`），不是请求体
  await taskSessionChat(ctx, taskId, { message: text });
}

/** `_api_load_stream`(4670)：压测指标 SSE（裸 id:/data: 帧 + Last-Event-ID 续传） */
async function apiLoadStream(ctx, taskId) {
  const row = ctx.ownedTask(taskId);
  if (row === null) return;
  const run = ctx.q('run', '');
  const [metricsPath] = loadMetricsSource(row, run, ctx);
  const runRow = loadRunRow(row, run, ctx);
  const live = runRow !== null && runRow.status === 'running';
  const sse = ctx.sse({});                     // 只有 Content-Type + Cache-Control
  let seen = 0;
  try {
    seen = pyIntStrict(String(ctx.req.headers['last-event-id'] ?? '') || '0');
  } catch {
    seen = 0;                                  // int() 抛 ValueError ⇒ 0
  }
  // 断线续传：从 seen 行之后续推；首连：只回放最后一段
  let [offset, no] = scanMetrics(metricsPath, Math.max(0, seen),
    seen > 0 ? 0 : LOAD_STREAM_REPLAY_MAX);
  for (;;) {
    try {
      if (fs.statSync(metricsPath).size < offset) { offset = 0; no = 0; }   // 轮转/清空
    } catch { /* 文件不存在：保持 */ }
    let chunk = null;
    try {
      chunk = fs.readFileSync(metricsPath);
    } catch {
      chunk = null;
    }
    if (chunk !== null) {
      const buf = offset > 0 ? chunk.subarray(offset) : chunk;
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) {
        const data = buf.subarray(0, nl);       // 半行留在文件里下轮再读
        offset += data.length + 1;
        let start = 0;
        for (let i = 0; i <= data.length; i += 1) {
          if (i !== data.length && data[i] !== 0x0a) continue;
          const line = data.subarray(start, i);
          start = i + 1;
          if (!ASCII_NONSPACE_RE.test(line.toString('latin1'))) continue;   // bytes.strip() 空行
          no += 1;
          for (const sample of normalizeRaw(line)) {
            sse.raw(`id: ${no}\ndata: ${jsonBody(sample)}\n\n`);
          }
        }
      }
    }
    const task = getTask(taskId, { db: ctx.db });
    if (task === null || !live || task.status !== 'running') {
      sse.raw('data: {"done":true}\n\n');
      sse.end();
      return;
    }
    // Python 靠写已断开的 socket 抛 BrokenPipe 退出本轮循环；Node 的 res.write 不抛
    // ⇒ 显式看这两个标志（否则客户端断开后循环会一直空转到任务结束）。
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    await sleepMs(1000);
  }
}

/** bytes.strip() 的「非空白」判据（ASCII 空白集；**不含** U+00A0 等 Unicode 空白） */
const ASCII_NONSPACE_RE = /[^\t\n\v\f\r ]/;

/** 毫秒睡眠（`time.sleep(1.0)` 的异步对应物） */
function sleepMs(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export const routes = [
  {
    method: 'GET',
    path: '/api/tasks',
    handler: (ctx) => {
      // ② 硬编码紧凑 JSON（Python 原文），见文件头 ①
      ctx.text(200, '{"error":"task id required"}', 'application/json; charset=utf-8');
    },
  },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/tasks$/,
    handler: (ctx, m) => {
      const projectId = Number(m[1]);
      if (ctx.ownedProject(projectId) === null) return;      // 已回 404 project not found
      const rows = listTasks(projectId, { db: ctx.db });
      ctx.json(200, rows.map((row) => taskJson(row, { db: ctx.db, stateCache: ctx.stateCache })));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)$/,
    handler: (ctx, m) => {
      const row = ctx.ownedTask(Number(m[1]));
      if (row === null) return;                              // 已回 404 task not found
      ctx.json(200, taskJson(row, { db: ctx.db, stateCache: ctx.stateCache }));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/rounds$/,
    handler: (ctx, m) => {
      const taskId = Number(m[1]);
      if (ctx.ownedTask(taskId) === null) return;
      ctx.json(200, listRounds(taskId, { db: ctx.db }));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/dialogue$/,
    handler: (ctx, m) => {
      const taskId = Number(m[1]);
      const row = ctx.ownedTask(taskId);
      if (row === null) return;
      const entries = readDialogue(listRounds(taskId, { db: ctx.db }));
      ctx.json(200, {
        task_id: taskId,
        model: effectiveModel(taskId, row.model, { db: ctx.db }),
        permission: row.permission === undefined ? null : row.permission,
        entries,
      });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/log$/,
    handler: (ctx, m) => {
      const taskId = Number(m[1]);
      if (ctx.ownedTask(taskId) === null) return;
      const roundRaw = ctx.q('round', '0');
      const tailRaw = ctx.q('tail', '300');
      const tailNum = pyIntOrNull(tailRaw);
      if (tailNum === null) {
        // Python int() 抛 ValueError ⇒ 连接被关（见文件头 ②）
        abortLikePython(ctx);
        return;
      }
      const tail = Math.min(tailNum, 5000);                  // Python min(int, 5000)
      const roundNo = pyIsDigits(roundRaw) ? pyIntOr(roundRaw, 0) : 0;
      const row = getLogRound(taskId, roundNo, { db: ctx.db });
      if (row === null) {
        ctx.error(404, 'log not found');
        return;
      }
      const content = row.log_path && isFile(row.log_path)
        ? readLogTail(row.log_path, tail)
        : '';
      // round 原样回显查询串（Python 回的就是字符串，不是 int）
      ctx.json(200, { round: roundRaw, log: content });
    },
  },
  // ---------- 压测（load）族（M6-6；顺序照 `_route_get` 1442-1466） ----------
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load_series$/,
    handler: (ctx, m) => apiLoadMetrics(ctx, Number(m[1])),   // 旧路径别名（无 UI 调用）
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load\/case$/,
    handler: (ctx, m) => apiLoadCase(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load\/metrics$/,
    handler: (ctx, m) => apiLoadMetrics(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load\/runs$/,
    handler: (ctx, m) => apiLoadRuns(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load\/custom_html$/,
    handler: (ctx, m) => apiLoadCustomHtml(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load_report$/,
    handler: (ctx, m) => apiLoadReport(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/load\/stream$/,
    handler: (ctx, m) => apiLoadStream(ctx, Number(m[1])),
  },
  // ---------- 写路径（顺序照 Python do_POST / do_PATCH / do_DELETE 里的先后） ----------
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/tasks$/,
    handler: async (ctx, m) => apiCreateTask(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/load\/rerun$/,
    handler: (ctx, m) => apiLoadRerun(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/load\/diagnose$/,
    handler: (ctx, m) => apiLoadDiagnose(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/(stop|restart)$/,
    handler: async (ctx, m) => apiTaskAction(ctx, Number(m[1]), m[2]),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/continue$/,
    handler: async (ctx, m) => apiContinueTask(ctx, Number(m[1])),
  },
  {
    method: 'PATCH',
    re: /^\/api\/tasks\/(\d+)$/,
    handler: async (ctx, m) => apiUpdateTask(ctx, Number(m[1])),
  },
  {
    method: 'DELETE',
    re: /^\/api\/tasks\/(\d+)$/,
    handler: async (ctx, m) => apiDeleteTask(ctx, Number(m[1])),
  },
];

// 已知差异（正常前端不产生，探针实测记录在案）：
//   - 读路径三条（不会由前端产生——`api/index.js` 传的是 `Number`；`lib.js:pyIsDigits` 已把
//     「ASCII 子集」定为全仓口径（C 族文件头 ③ 同款声明），不一致要么全仓一起改，要么都不改）：
//       · `tail=1_0`：Python `int()` 认下划线（=10）；这里 `pyIntOrNull` 不认 ⇒ 掐断连接（Python 200）。
//       · `round=١٢`（Unicode Nd 数字）：Python `int()` = 12 去查第 12 轮；这里按 0 查 ⇒ 404。
//       · `round=²`（isdigit() 为真但 int() 抛）：Python 掐断连接；这里按 0 查 ⇒ 404。
//   - 写路径两条（只影响手写调用/对拍构造，前端一律传字符串）：
//       · **`int()` 的 Unicode 数字**：Python `int("١٢")==12`，这里 `pyIntStrict` 只认 ASCII
//         ⇒ `continue` 的 `stop_value` 会从「折算成功」变成 400「stop_value 非法」；
//         （`date_from`/`date_to` 的 Unicode 面已对齐：格式正则用 `\p{Nd}`，双侧比较按
//         `time.strptime` 的日历校验复刻，见 `normDateRange`/`pyStrtimeDate`）
//       · **非字符串容器的 `str()`**：Python 是 repr 形态（`['a']` / `{'k': 1}`），这里按
//         JSON 文本兜底（`["a"]` / `{"k":1}`，见 `pyStr`）。`str(None)=='None'`、`str(True)=='True'`、
//         `str(1.5)=='1.5'` 这类**标量**形态已逐字对齐（`stop_value: null` ⇒ 落库 `'None'`）。
//   - 压测族（M6-6）三条，口径与上面同源（都属「Python `int()` 比全仓 ASCII 口径宽」）：
//       · `load/metrics?after=1_0`：Python `int("1_0")==10`（跳过前 10 行）；这里 `pyIntOrNull`
//         不认下划线 ⇒ 按 0 处理（回放全部）——与 `tail=1_0` 同一条已知差异；
//       · `load/metrics?after=١٢`（Unicode Nd）：Python 认（=12），这里按 0；
//       · `load/stream` 的 `Last-Event-ID: 1_0`：Python `int()` 认（=10），这里 `pyIntStrict`
//         认下划线（**这一处已对齐**）；Unicode 数字两者都落到 `ValueError`/异常 ⇒ 都按首连。
//   - `load/metrics` 的行迭代按**通用换行**（`\r\n`/`\r` → `\n`）复刻 Python 文本模式；
//     `load/stream` 则按**字节**切 `\n`（Python 侧开的也是 `"rb"`）——两处的换行口径**不同**，
//     这是 oracle 自己的形态，别统一。
