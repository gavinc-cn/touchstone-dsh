/**
 * 任务族派生逻辑（`server.py:_task_json` / `_session_title` + `runner.py:read_dialogue` /
 * `read_log_tail` 的 Node 对应物，M3 读路径）。
 *
 * 为什么单独一层：`_task_json` 有 29 个字段，其中三个是**派生**的 —— `new_cases` 要走案例库
 * 扫描（StateCache）、`model` 走 `effectiveModel`、`session_title` 走 dsh 会话存储；日志端点
 * 还要把轮次日志解析成对话条目。这些都不属于「鉴权/取数/回响应」的路由职责，单独放一层才能
 * 脱离 HTTP 单测（`backend/test/tasks-route.test.mjs` 直接喂行对象/日志文件）。
 *
 * 归属说明：`read_dialogue` / `read_log_tail` 在 Python 里住在 `runner.py`；Node 侧 B 族的
 * `lib/runner.js` 目前只有队列读函数（M3 只搬了看板/队列需要的那些）。任务族不能因此停摆，
 * 故这两个函数落在这里，**并在文件头显式记录**：若 B 族把 runner 的两个日志读函数收编过去，
 * 本文件应改为复用，避免两份实现。
 *
 * 逐点对齐的细节（都是「看着一样其实不一样」的坑）：
 *   - 日志行切分是 Python **文本模式 universal newlines**（`readlines()` 把 `\r`/`\r\n` 也算换行）
 *     ⇒ 复用 `lib.js:readText()`（已做归一），不是 `split('\n')` 硬切；
 *   - `read_log_tail(path, limit)` 的 `limit` 走 Python 切片语义 `[-limit:]`：`0` = 全文、
 *     负数 = 丢掉开头 |limit| 行（实测探针确认）；
 *   - `### PROMPT ` 后面的内容按 JSON 解析，解析失败**保留原文**（不是跳过该行）；
 *   - 工具结果按 6000 **码点**截断（Python `len`/切片按码点；JS 的 UTF-16 长度会把 emoji 算两个，
 *     截断还可能劈开代理对 ⇒ 用 `Array.from` 按码点切）；
 *   - `x or default` 用 Python 真值集合（`[]`/`{}` 是假值，JS 里是真值）⇒ 见 `pyOr`。
 *
 * 已知有意放宽（只影响**坏日志/坏行**，正常库不出现；比 Python 更稳）：
 *   Python 在 `obj["tool_calls"][i]["function"]` 不是 dict 时抛 AttributeError，会把整个
 *   `/dialogue` 打成 500（连接被关）。Node 侧按「缺字段取默认」降级继续 —— 一行坏日志不该让
 *   整个对话流不可读。这类差异在正常 fixture 上不可见。
 */
import { agentFamily } from './agents.js';
import { getProject } from './db.js';
import { taskLang } from './i18n.js';
import { isFile, readText } from './lib.js';
import { dsh_title as dshTitle } from './sessparse.js';
import { effectiveModel, sessFamily } from './servercaps.js';

/** 工具结果/助手摘要单条可返回的最大码点数（对齐 `runner.DIALOGUE_TEXT_LIMIT`） */
export const DIALOGUE_TEXT_LIMIT = 6000;
/**
 * 单条对话条目中 JSON 内容「按长度直接截断」时保留的码点数（对齐 `runner.DIALOGUE_RAW_LIMIT`）。
 * M3 的六个读端点用不到它；它属于 `runner.summary_entry_text()`（前端折叠摘要）——那一处随
 * 会话/看板族移植时用这个常量，别在调用点写死 1200。
 */
export const DIALOGUE_RAW_LIMIT = 1200;

/**
 * Python `d.get(key, fallback)`：键**存在**就取键值（哪怕值是 null），否则取默认。
 * 不能用 `obj[key] ?? fallback`（那会把显式 null 也折成默认）。
 * @param {object} obj
 * @param {string} key
 * @param {any} fallback
 * @returns {any}
 */
function pyGet(obj, key, fallback) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/**
 * Python `value or fallback` 的真值口径：`None/False/0/''/[]/{}` 都是假值。
 * JS 里 `[]` 与 `{}` 是真值，直接写 `||` 会在「空数组内容」上分叉。
 * @param {any} value
 * @param {any} fallback
 * @returns {any}
 */
function pyOr(value, fallback) {
  if (value === null || value === undefined || value === false || value === '' || value === 0) {
    return fallback;
  }
  if (Array.isArray(value) && value.length === 0) return fallback;
  if (typeof value === 'object' && Object.keys(value).length === 0) return fallback;
  return value;
}

/**
 * Python `len(s)` / `s[:limit]` 的**码点**口径（JS 按 UTF-16 码元会把代理对算成 2 个）。
 * @param {any} value 字符串或数组（Python 的 str/list 都可切片）
 * @param {number} limit
 * @returns {{length: number, sliced: any}}
 */
function pySlice(value, limit) {
  if (Array.isArray(value)) return { length: value.length, sliced: value.slice(0, limit) };
  const chars = Array.from(String(value));
  return { length: chars.length, sliced: chars.slice(0, limit).join('') };
}

/**
 * Python `f.readlines()` 的等价：按 `\n` 切分，**每行带结尾换行**，且结尾换行不产生额外空行。
 *
 * 为什么不能用 `text.split('\n')`：文件以换行结尾时它会多出一个 `''` 元素，
 * `[-limit:]` 的窗口就整体错一位（实测：`tail=5` 少回一行 —— 对拍里是正文哈希差异）。
 * @param {string} text 已归一换行的文本（见 `lib.js:readText`）
 * @returns {string[]}
 */
function pyReadLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const idx = text.indexOf('\n', start);
    if (idx < 0) break;
    lines.push(text.slice(start, idx + 1));      // 行尾换行跟着行走（同 Python readlines）
    start = idx + 1;
  }
  if (start < text.length) lines.push(text.slice(start));   // 末行无换行
  return lines;
}

/**
 * `runner.read_dialogue(rounds)`：把多轮日志解析成结构化对话条目。
 *
 * 识别内容（与 Python 逐条对应）：
 *   - `### PROMPT <json>` → `{kind:'user'}`（JSON 解析失败则原样当文本）
 *   - `{"role":"assistant"}` → `{kind:'assistant', text, tool_calls:[{name,args}]}`
 *   - `{"role":"tool"}` → `{kind:'tool_result', tool_call_id, text(截断), truncated, tool_calls:[]}`
 *   - `{"role":"meta","type":"session.resume_hint"}` → `{kind:'meta', text: session_id}`
 *
 * @param {object[]} rounds `db.list_rounds()` 的行（按 round_no 升序；本函数再按 round_no 排一次，
 *   与 Python 的 `sorted(rounds, key=...)` 同形 —— JS 的 `sort` 默认按字符串比，必须给数值比较器）
 * @returns {object[]} 条目数组，按日志出现顺序
 */
export function readDialogue(rounds) {
  const entries = [];
  const ordered = [...rounds].sort((a, b) => (
    a.round_no < b.round_no ? -1 : a.round_no > b.round_no ? 1 : 0));
  for (const round of ordered) {
    const logPath = round.log_path;
    if (!logPath || !isFile(logPath)) continue;
    const text = readText(logPath);       // OSError → ''（Python 的 except OSError → continue 同效）
    for (const rawLine of pyReadLines(text)) {
      const line = rawLine.replace(/\n+$/, '');         // 对齐 raw.rstrip("\n")
      if (line.startsWith('### PROMPT ')) {
        let prompt = line.slice('### PROMPT '.length);
        try {
          prompt = JSON.parse(prompt);
        } catch {
          // Python：json.loads 抛 ValueError 就保留原文（不是跳过这一行）
        }
        entries.push({ kind: 'user', round: round.round_no, text: prompt });
        continue;
      }
      if (!line.startsWith('{"role"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;                                       // Python：ValueError → continue
      }
      const role = pyGet(obj, 'role', null);
      if (role === 'meta') {
        if (pyGet(obj, 'type', null) === 'session.resume_hint') {
          entries.push({
            kind: 'meta', round: round.round_no, text: pyGet(obj, 'session_id', ''),
          });
        }
        continue;
      }
      if (role === 'assistant') {
        const toolCalls = [];
        const rawCalls = pyOr(pyGet(obj, 'tool_calls', null), []);
        if (Array.isArray(rawCalls)) {                  // 非数组是坏行：Python 会 AttributeError，这里降级
          for (const tc of rawCalls) {
            const fn = pyOr(pyGet(tc === null || typeof tc !== 'object' ? {} : tc, 'function', {}), {});
            toolCalls.push({
              name: pyGet(fn, 'name', ''),
              args: pyGet(fn, 'arguments', ''),
            });
          }
        }
        entries.push({
          kind: 'assistant',
          round: round.round_no,
          text: pyOr(pyGet(obj, 'content', ''), ''),
          tool_calls: toolCalls,
        });
        continue;
      }
      if (role === 'tool') {
        const content = pyOr(pyGet(obj, 'content', ''), '');
        const { length, sliced } = pySlice(content, DIALOGUE_TEXT_LIMIT);
        entries.push({
          kind: 'tool_result',
          round: round.round_no,
          tool_call_id: pyGet(obj, 'tool_call_id', ''),
          text: sliced,
          truncated: length > DIALOGUE_TEXT_LIMIT,
          tool_calls: [],
        });
      }
    }
  }
  return entries;
}

/**
 * `runner.read_log_tail(path, limit)`：读日志末尾 `limit` 行文本（编码容错）。
 *
 * 注意这是「读全文再取末尾 N 行」（Python 就是 `f.readlines()[-limit:]`），不是 seek 式 tail。
 * `limit` 的切片语义见文件头（0 = 全文、负数 = 丢开头）。
 * @param {string} filePath
 * @param {number} [limit]
 * @returns {string}
 */
export function readLogTail(filePath, limit = 200) {
  if (!filePath || !isFile(filePath)) return '';
  const text = readText(filePath);                      // OSError → ''（Python 同）
  // readlines() 口径见 pyReadLines；`slice(-limit)` 与 Python `[-limit:]` 同语义
  // （limit=0 ⇒ 全文；limit<0 ⇒ 丢掉开头 |limit| 行），两者都已用探针实测确认
  return pyReadLines(text).slice(-limit).join('');
}

/**
 * `_task_json` 的 `new_cases`：库内用例总数 − 创建时的基数（负数归零）。
 *
 * 依赖注入 `stateCache`（= `server.py:state_cache`，C 族的 `lib/casescan.js:StateCache`）：
 * 传进来的实例负责 1s TTL 与全量扫描。任何异常（含未注入/项目读不到）都折成 0 ——
 * 与 Python `_task_json` 里那圈 `try/except Exception: new_cases = 0` 逐点同形。
 * @param {object} row 任务行
 * @param {{db?: object, stateCache?: object}} [deps]
 * @returns {number}
 */
function newCases(row, { db, stateCache } = {}) {
  try {
    const project = getProject(pyGet(row, 'project_id', null), { db });
    if (!project) return 0;
    const state = stateCache.get(project.id, project.cases_root, project.bug_dir, project.work_dir);
    const total = state && state.library && state.library.stats ? state.library.stats.total : 0;
    // Python `int(row["cases_base"] or 0)`：非数字会抛 ValueError ⇒ 走 except（new_cases=0）；
    // `total` 不是数字时 `total - int(base)` 抛 TypeError ⇒ 同样归 0。JS 不抛，故显式判。
    const base = Number(pyOr(pyGet(row, 'cases_base', 0), 0));
    if (!Number.isFinite(base) || typeof total !== 'number' || !Number.isFinite(total)) return 0;
    return Math.max(0, Math.trunc(total) - Math.trunc(base));
  } catch {
    return 0;
  }
}

/**
 * `_session_title(row)`：任务会话标题（dsh 会话读宿主标题事件；无会话/非 dsh 族/读失败 → ''）。
 * @param {object} row 任务行
 * @param {{db?: object}} [deps]
 * @returns {string}
 */
export function sessionTitle(row, { db } = {}) {
  try {
    const sid = pyOr(pyGet(row, 'session_id', ''), '');
    if (!sid) return '';
    const project = getProject(pyGet(row, 'project_id', null), { db });
    if (!project) return '';
    const family = agentFamily(project.agent_path);
    if (sessFamily(family) === 'dsh') return dshTitle(sid);
  } catch {
    return '';                                          // Python：except Exception → ''
  }
  return '';
}

/**
 * `_task_json(row)`：任务 JSON（**字段与顺序逐字对齐 server.py:2533**，因为响应体走
 * `pyJsonDumps`，顺序不同就是字节差异；对拍里 `kind:'text'` 用例会直接抓出来）。
 *
 * 三个派生字段：`new_cases`（案例库扫描）、`model`（effectiveModel：显式 > 首轮日志 -m > dsh 默认）、
 * `session_title`（dsh 会话标题）。
 *
 * 缺列老行：Python 对「行里没这一列」会 IndexError（请求 500），但 `migrate()` 保证迁移后列必在
 * —— 这里对 `or "" / or 0` 那几列按空值降级、其余按 null 输出，属**有意的更稳行为**（单测覆盖）。
 * @param {object} row 任务行（`db.get_task` / `db.list_tasks`）
 * @param {{db?: object, stateCache?: object}} [deps]
 * @returns {object}
 */
export function taskJson(row, { db, stateCache } = {}) {
  const raw = (key) => (row[key] === undefined ? null : row[key]);
  const str0 = (key) => pyOr(row[key] === undefined ? null : row[key], '');
  return {
    id: raw('id'),
    project_id: raw('project_id'),
    name: raw('name'),
    auto_fix: Boolean(row.auto_fix),
    retest: raw('retest'),
    stop_type: raw('stop_type'),
    stop_value: raw('stop_value'),
    task_type: raw('task_type'),
    payload: raw('payload'),
    start_stage: str0('start_stage'),
    end_stage: str0('end_stage'),
    date_from: str0('date_from'),
    date_to: str0('date_to'),
    extra: raw('extra'),
    model: effectiveModel(row.id, row.model, { db }),
    permission: raw('permission'),
    auto_commit: Boolean(row.auto_commit),
    auto_deploy: Boolean(row.auto_deploy),
    auto_retest: Boolean(row.auto_retest),
    new_cases: newCases(row, { db, stateCache }),
    status: raw('status'),
    session_id: raw('session_id'),
    session_title: sessionTitle(row, { db }),
    current_round: raw('current_round'),
    new_bugs: raw('new_bugs'),
    // T13：任务语言（创建时冻结；读侧统一归一，未知/空值 → zh）。键序与
    // Python `_task_json` 逐字一致（响应体 json.dumps 后会对拍）。
    lang: taskLang(row),
    created_at: raw('created_at'),
    started_at: raw('started_at'),
    ended_at: raw('ended_at'),
    error: raw('error'),
  };
}
