/**
 * 案例库扫描聚合（`server.py` 顶部「扫描层文件缓存 → StateCache」那一段的 Node 对应物，M3 读路径）。
 *
 * 职责：把一个项目的**文件系统**（`<工作目录>/free_style` 案例树、`<工作目录>/bug_report` 报告、
 * `<工作目录>/.live/live.json` 运行状态）聚合成 `/api/state`、`/api/stream`、
 * `/api/projects/<id>/bugs` 三个端点要的形状。Python 侧这些函数写在 server.py（不在 lib.py），
 * 本模块按同一分工照搬。
 *
 * ── 为什么要有按 mtime 的文件缓存 ────────────────────────────────────────────────
 * `/api/stream` 每 0.5s 聚合一次全量状态；若每拍都重新读盘解析，一个几百用例的案例库就会把
 * CPU 烧光。`cachedFile` 以 `(mtime_ns, size)` 为戳缓存 `loader(path)` 的结果：文件没被改写
 * 就直接命中（runner 写入会改 mtime，缓存自动失效）。**删掉的文件不缓存**（stat 失败时顺手
 * 把旧条目弹掉），避免残留条目把「文件已删」读成「文件还在」。
 *
 * ── StateCache 的两条不变量（照抄 Python，破坏任何一条都会让 SSE 语义变形） ─────────
 * ① **TTL 1.0s 内返回同一个对象**（不是深拷贝）：`_api_state`/`_stream` 会往返回的 state 上写
 *    `state["project"]`，Python 也是就地改缓存对象。拷贝一份会让每拍都当「内容变了」。
 * ② **指纹在构建时算好、且剔除 `generated_at`**：SSE 每拍只做字符串比较，不再全量 dumps；
 *    `generated_at` 每秒都在变，留在指纹里会把「无变化」读成「一直在变」⇒ 每拍都推帧。
 *    `project` 段在构建之后才写入，故它**不在**缓存指纹里——调用方（`_stream`）自己把它
 *    追加进去再比（见 `routes/projects.js`）。
 *
 * ── 已知有意保留的差异（不影响真实案例库） ───────────────────────────────────────
 *   - `task["payload"]` 坏 JSON：Python 只 catch ValueError（`json.loads` 失败），若 payload 是
 *     「合法 JSON 但不是对象」（如 `[1]`），`.get("bug_dir")` 会 AttributeError 把端点打成 500。
 *     Node 侧**降级成「不匹配」继续扫**（一个坏行不该让整个 bug 列表 500）。正常库两者一致。
 *   - `\d` 按 ASCII（见 lib.js 文件头 ③）。
 *
 * 零 npm 依赖：只用 node:fs；JSON 序列化走 pyjson.js（与 Python 逐字节一致）。
 */
import fs from 'node:fs';

import { listTasks, nowStr } from './db.js';
import { pyJsonDumps } from './pyjson.js';
import {
  CASE_DIR_RE, FS_ID_RE, PY_WS, isDir, isFile, parseFields, parseStatusMd, pyBasename, pyJoin,
  pyMtimeFloat, pySorted, pySortedReverse, pyStrip, pyStrCompare, readText, runtimeDir,
  severityLevel,
} from './lib.js';

// --------------------------------------------------------------------------
// 正则（逐条对齐 server.py 顶部；口径见 lib.js 文件头）
// --------------------------------------------------------------------------

/** INDEX.md 用例行：`| FS0001 | 名称 | 测试点 | 状态 | 关联 bug |`（`re.M` + finditer） */
const CASE_ROW_RE = new RegExp(
  `^\\|${PY_WS}*(FS\\d{4})${PY_WS}*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, 'gm');

/** INDEX.md 目录说明行：`> 一句话说明`（`DESC_RE.search`，只取第一处） */
const DESC_RE = new RegExp(`^>${PY_WS}*([^\\n]+)$`, 'm');

/** bug 报告目录名：`20260829_0635_FS_cli_config_load` → 标题取第三个下划线之后 */
const BUG_DIR_RE = /^\d{8}_\d{4}_([^\n]+)$/;

/** ROUNDS.md 角度覆盖表行：`| 第 1 轮 | 时间 | 阅读范围 | 角度 | FS0001~FS0015（15 条） | 2 |` */
const ROUND_ROW_RE = new RegExp(
  `^\\|${PY_WS}*第${PY_WS}*(\\d+)${PY_WS}*轮${PY_WS}*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|`
  + `${PY_WS}*(\\d+)${PY_WS}*\\|`, 'gm');

/** ROUNDS.md 轮次明细小节标题：`### 第 1 轮（2026-08-22）` */
const ROUND_SEC_RE = new RegExp(`^###${PY_WS}*第${PY_WS}*(\\d+)${PY_WS}*轮[^\\n]*$`, 'gm');

/**
 * 明细小节执行统计：`通过 16 / 失败 0 / 跳过 0`（中文原语法零 churn）；英文
 * `Passed/Failed/Skipped` 同义：pass/fail/skip + 可选 ed，大小写不敏感，英文分支允许
 * 一个可选冒号。捕获组 1/2/3 不变；接受集合与 `server.EXEC_STAT_RE` 逐字一致
 * （共享用例表 `tests/fixtures/bilingual/rounds_stats_cases.json`）。
 */
export const EXEC_STAT_RE = new RegExp(
  `(?:通过|pass(?:ed)?${PY_WS}*[:：]?)${PY_WS}*(\\d+)${PY_WS}*/${PY_WS}*`
  + `(?:失败|fail(?:ed)?${PY_WS}*[:：]?)${PY_WS}*(\\d+)(?:${PY_WS}*/${PY_WS}*`
  + `(?:跳过|skip(?:ped)?${PY_WS}*[:：]?)${PY_WS}*(\\d+))?`, 'i');

/** 角度表「入库用例数」：`（15 条）` */
const CASES_COUNT_RE = new RegExp(`（${PY_WS}*(\\d+)${PY_WS}*条${PY_WS}*）`);

/**
 * `re.finditer` 的等价迭代器：新建一个带 `g` 的副本再 matchAll。
 *
 * 为什么不直接用模块级正则 `exec`：`g` 正则的 `lastIndex` 会跨调用残留，第二次解析同一段
 * 文本会从上次位置继续 —— 这种 bug 只在「同一进程里第二次调用」才显形，单测很容易漏。
 * @param {RegExp} re
 * @param {string} text
 * @returns {IterableIterator<RegExpMatchArray>}
 */
function* iterMatches(re, text) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  yield* String(text).matchAll(rx);
}

// --------------------------------------------------------------------------
// 扫描层文件缓存
// --------------------------------------------------------------------------

/** 文件缓存：`path -> [(mtime_ns, size), 解析结果]`（进程内，与 Python `_FILE_CACHE` 同） */
const FILE_CACHE = new Map();

/**
 * `cached_file`：按 `(mtime_ns, size)` 缓存 `loader(path)` 的结果；stat 失败（文件不存在）
 * 时不缓存并顺手弹掉旧条目。
 *
 * 用 `statSync(..., { bigint: true })` 取 `mtimeNs`（纳秒 BigInt）而不是 `mtimeMs`（浮点毫秒）：
 * Python 的戳是 `st_mtime_ns`，同一毫秒内的两次写入在 Python 侧能区分、在 `mtimeMs` 侧不能，
 * 那会让「刚写过的文件读回旧内容」这种最难查的缓存 bug 只出现在 Node 版。
 * @param {string} filePath
 * @param {(p: string) => any} loader
 * @returns {any}
 */
export function cachedFile(filePath, loader) {
  const target = String(filePath);
  let stamp;
  try {
    const st = fs.statSync(target, { bigint: true });
    stamp = [st.mtimeNs, st.size];
  } catch {
    FILE_CACHE.delete(target);
    return loader(target);
  }
  const hit = FILE_CACHE.get(target);
  if (hit && hit[0][0] === stamp[0] && hit[0][1] === stamp[1]) return hit[1];
  const value = loader(target);
  FILE_CACHE.set(target, [stamp, value]);
  return value;
}

/** 当前缓存条目数（单测诊断用；Python 侧无此函数，不影响端点行为） */
export function fileCacheSize() {
  return FILE_CACHE.size;
}

/** 清空文件缓存（单测隔离用；Python 侧无此函数，不影响端点行为） */
export function clearFileCache() {
  FILE_CACHE.clear();
}

// --------------------------------------------------------------------------
// 案例树
// --------------------------------------------------------------------------

/**
 * `parse_index_cases`：从 INDEX.md 表格解析 `id -> [名称, 测试点]`。
 * 索引里的名称/测试点比目录名更准确；名称为空或 `—` 的行整条忽略，测试点为 `—` 时置空串。
 * @param {string} text
 * @returns {Record<string, [string, string]>}
 */
export function parseIndexCases(text) {
  const result = {};
  for (const m of iterMatches(CASE_ROW_RE, text)) {
    const name = pyStrip(m[2]);
    const point = pyStrip(m[3]);
    if (name && name !== '—') result[m[1]] = [name, point === '—' ? '' : point];
  }
  return result;
}

/**
 * `scan_dir`：递归扫描案例库目录，生成嵌套树（分类目录 -> children / cases）。
 * 跳过隐藏目录（如 `.live`）；用例目录（`FS0004_名称` 且有 status.md）进 `cases`，
 * 非用例目录递归成 `children`，`FS` 前缀但缺 status.md 的目录**两者都不进**（照抄 Python）。
 * @param {string} dirPath 绝对目录
 * @param {string} rel 相对路径（根为 `.`，逐层 `./子目录` 形态，与 Python `os.path.join` 同形）
 * @returns {object}
 */
export function scanDir(dirPath, rel) {
  const node = { name: pyBasename(dirPath), path: rel, desc: '', children: [], cases: [] };
  let indexCases = {};
  const indexText = cachedFile(pyJoin(dirPath, 'INDEX.md'), readText);
  if (indexText) {
    const m = DESC_RE.exec(indexText);
    if (m) node.desc = pyStrip(m[1]);
    indexCases = parseIndexCases(indexText);
  }
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return node;                                  // 目录不可读：返回已解析出的 desc，不抛
  }
  for (const entry of pySorted(entries)) {
    if (entry.startsWith('.')) continue;
    const full = pyJoin(dirPath, entry);
    if (!isDir(full)) continue;
    const m = CASE_DIR_RE.exec(entry);
    if (m && isFile(pyJoin(full, 'status.md'))) {
      const item = { id: m[1], name: m[2], point: '', relpath: pyJoin(rel, entry) };
      Object.assign(item, cachedFile(pyJoin(full, 'status.md'), parseStatusMd));
      if (Object.hasOwn(indexCases, m[1])) {
        [item.name, item.point] = indexCases[m[1]];
      }
      node.cases.push(item);
    } else if (!m) {
      node.children.push(scanDir(full, pyJoin(rel, entry)));
    }
  }
  return node;
}

/**
 * `collect_stats`：递归统计各状态用例数（就地累加并返回同一个 stats 对象）。
 * 状态映射：通过/失败/需要复测/跳过 各归一键，其余（含未执行）计入 pending。
 * @param {object} node
 * @param {{total: number, passed: number, failed: number, retest: number,
 *          skipped: number, pending: number}} stats
 * @returns {object} 同一个 stats
 */
export function collectStats(node, stats) {
  for (const item of node.cases) {
    stats.total += 1;
    const key = { 通过: 'passed', 失败: 'failed', 需要复测: 'retest', 跳过: 'skipped' }[item.status];
    stats[key || 'pending'] += 1;
  }
  for (const child of node.children) collectStats(child, stats);
  return stats;
}

// --------------------------------------------------------------------------
// bug 报告
// --------------------------------------------------------------------------

/**
 * `scan_bugs`：扫描 bug_report 目录下测试任务生成的报告（目录名含 `_FS_`），
 * 按目录名倒序，最多 50 条。
 *
 * `severity` = 报告「严重程度」等级归一到中文 canonical（高/中/低）；缺失或无法识别的
 * 自定义值给空串（前端按「未分级」展示）。原文字段值不被改写（`severityLevel` 只读）。
 * @param {string} bugDir
 * @returns {Array<{dir: string, title: string, status: string, severity: string,
 *                  cases: string[]}>}
 */
export function scanBugs(bugDir) {
  const bugs = [];
  let entries;
  try {
    entries = pySortedReverse(fs.readdirSync(bugDir));
  } catch {
    return bugs;                                  // 目录不存在/不可读：空列表（不抛）
  }
  for (const entry of entries) {
    if (!entry.includes('_FS_')) continue;
    const full = pyJoin(bugDir, entry);
    if (!isDir(full)) continue;
    const report = cachedFile(pyJoin(full, 'bug_report.md'), readText);
    const fields = parseFields(report);
    const m = BUG_DIR_RE.exec(entry);
    bugs.push({
      dir: entry,
      title: m ? m[1] : entry,
      status: fields['状态'] || '',
      severity: severityLevel(fields['严重程度']),
      cases: pySorted(new Set(report.match(FS_ID_RE) || [])).slice(0, 20),
    });
    if (bugs.length >= 50) break;
  }
  return bugs;
}

/**
 * `bug_last_task`：在任务列表中找该 bug 最近的 fix/retest_bug/reject/script_retest 任务。
 *
 * `tasks` 已按创建时间倒序（`db.list_tasks` 的 `id DESC`），故**第一个命中即为最近**。
 * payload 解析失败的行跳过（Python `except ValueError: continue`）；payload 不是对象的行
 * 同样跳过（Python 侧会 AttributeError，见文件头「已知有意保留的差异」）。
 * @param {object[]} tasks
 * @param {string} bugDir
 * @returns {{id: number, task_type: string, name: string, status: string, created_at: string}|null}
 */
export function bugLastTask(tasks, bugDir) {
  const wanted = new Set(['fix', 'retest_bug', 'script_retest', 'reject']);
  for (const t of tasks) {
    if (!wanted.has(t.task_type)) continue;
    let payload;
    try {
      payload = JSON.parse(t.payload || '{}');
    } catch {
      continue;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (payload.bug_dir === bugDir) {
      return { id: t.id, task_type: t.task_type, name: t.name, status: t.status, created_at: t.created_at };
    }
  }
  return null;
}

/**
 * `list_project_bugs`：bug 列表 = 扫描结果 + 每个 bug 最近的修复/复测/修例任务信息。
 *
 * 排序（2026-10-25 等级划分批次）：复测通过（已闭环）与已拒绝（被用户否决）的报告照旧沉到
 * 列表末尾作为历史报告；其余按严重程度 高 → 中 → 低 → 未分级，同等级内保持扫描出的目录名
 * 倒序（JS `Array#sort` 稳定，与 Python `list.sort` 同序；历史报告组内同样按等级）。
 * @param {object} project 项目行（需 `bug_dir`/`id`）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 数据层读口选项
 * @returns {object[]}
 */
export function listProjectBugs(project, options = {}) {
  const bugs = scanBugs(project.bug_dir);
  const tasks = listTasks(project.id, options);
  for (const b of bugs) b.last_task = bugLastTask(tasks, b.dir);
  bugs.sort((a, b) => (closedRank(a) - closedRank(b))
    || (severityRank(a.severity) - severityRank(b.severity)));
  return bugs;
}

/** 历史报告判据：状态里出现「复测通过」或「已拒绝」（`re.search` ⇒ 任意位置命中） */
function closedRank(bug) {
  return /复测通过|已拒绝/.test(bug.status || '') ? 1 : 0;
}

/**
 * bug 等级排序权重：高 → 中 → 低 → 未分级（缺失/无法识别）。与 `server.py` 的
 * `SEVERITY_RANK` / `severity_rank` 逐字镜像。
 */
const SEVERITY_RANK = { 高: 0, 中: 1, 低: 2 };

/** 等级 → 排序权重（高 0 / 中 1 / 低 2 / 未分级 3） */
function severityRank(severity) {
  return Object.hasOwn(SEVERITY_RANK, severity || '')
    ? SEVERITY_RANK[severity]
    : Object.keys(SEVERITY_RANK).length;
}

// --------------------------------------------------------------------------
// ROUNDS.md / live.json / 聚合
// --------------------------------------------------------------------------

/**
 * `parse_rounds`：解析 ROUNDS.md —— 角度表取 轮次/时间/角度/入库数/新bug，
 * 明细小节（`### 第 N 轮` 到下一小节之间）补 通过/失败/跳过。
 * @param {string} root 案例库根
 * @returns {object[]}
 */
export function parseRounds(root) {
  const text = cachedFile(pyJoin(root, 'ROUNDS.md'), readText);
  if (!text) return [];
  const detail = new Map();
  const secs = [...iterMatches(ROUND_SEC_RE, text)];
  for (let i = 0; i < secs.length; i += 1) {
    const m = secs[i];
    const end = i + 1 < secs.length ? secs[i + 1].index : text.length;
    const em = EXEC_STAT_RE.exec(text.slice(m.index + m[0].length, end));
    if (em) {
      detail.set(Number(m[1]), {
        passed: Number(em[1]),
        failed: Number(em[2]),
        skipped: Number(em[3] || 0),
      });
    }
  }
  const rounds = [];
  for (const m of iterMatches(ROUND_ROW_RE, text)) {
    const no = Number(m[1]);
    const cm = CASES_COUNT_RE.exec(m[5]);
    const item = {
      round: no,
      time: pyStrip(m[2]),
      angle: pyStrip(m[4]),
      cases: cm ? Number(cm[1]) : 0,
      new_bugs: Number(m[6]),
      passed: 0,
      failed: 0,
      skipped: 0,
    };
    Object.assign(item, detail.get(no) || {});
    rounds.push(item);
  }
  return rounds;
}

/**
 * `load_live`：读取运行状态文件 `<工作目录>/.live/live.json`。
 * 不存在或解析失败返回 `{live: null, mtime: null}`（Python 返回 `(None, None)`）。
 * @param {string} workDir
 * @returns {{live: any, mtime: number|null}}
 */
export function loadLive(workDir) {
  const file = pyJoin(runtimeDir(workDir, '.live'), 'live.json');
  try {
    const live = JSON.parse(fs.readFileSync(file, 'utf8'));
    const st = fs.statSync(file, { bigint: true });
    return { live, mtime: pyMtimeFloat(st.mtimeNs) };
  } catch {
    return { live: null, mtime: null };
  }
}

/**
 * `build_state`：聚合一次完整的 UI 状态。
 * @param {string} root 案例库根（扫案例树/ROUNDS.md）
 * @param {string} bugDir bug 报告目录
 * @param {string} workDir 工作目录（读 `.live/live.json`）
 * @returns {object}
 */
export function buildState(root, bugDir, workDir) {
  const tree = scanDir(root, '.');
  const stats = collectStats(tree, {
    total: 0, passed: 0, failed: 0, retest: 0, skipped: 0, pending: 0,
  });
  const { live, mtime } = loadLive(workDir);
  return {
    generated_at: nowStr(),
    live,
    live_mtime: mtime,
    library: { tree, stats },
    bugs: scanBugs(bugDir),
    rounds: parseRounds(root),
  };
}

/**
 * CPython `json.dumps(obj, ensure_ascii=False, sort_keys=True)` 的对应物
 * （sort_keys 逐层递归排序 dict 键，键按码点序 —— 见 lib.js 的 pyStrCompare）。
 * @param {any} value
 * @returns {string}
 */
export function pyJsonDumpsSorted(value) {
  return pyJsonDumps(sortKeysDeep(value));
}

/**
 * 递归把普通对象的键按码点序重排（数组保持原序）。
 * @param {any} value
 * @returns {any}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort(pyStrCompare)) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * `StateCache`：按项目缓存聚合状态（TTL 1s），SSE 0.5s 轮询时避免反复扫盘。
 *
 * 与 Python 的唯一实现差异：Python 用 `threading.Lock` 保护缓存，Node 侧 `get()` 里没有
 * 任何 `await`（`buildState` 全同步）⇒ 单线程事件循环里不存在交错，锁是多余的。
 * 构造参数 `now` 是**测试缝**（注入假时钟验证 TTL），生产路径不传（用墙钟秒）。
 */
export class StateCache {
  /**
   * @param {{ttl?: number, now?: () => number}} [opts] ttl 单位秒（对齐 Python `ttl=1.0`）
   */
  constructor({ ttl = 1.0, now = () => Date.now() / 1000 } = {}) {
    this.ttl = ttl;
    this._now = now;
    /** @type {Map<number, {ts: number, state: object, fingerprint: string}>} */
    this._cache = new Map();
  }

  /**
   * 取该项目状态：TTL 内直接返回**同一对象**；否则重建并连同指纹一起缓存。
   * @param {number} projectId
   * @param {string} root 案例库根
   * @param {string} bugDir bug 报告目录
   * @param {string} workDir 工作目录
   * @returns {object}
   */
  get(projectId, root, bugDir, workDir) {
    const hit = this._cache.get(projectId);
    if (hit && this._now() - hit.ts < this.ttl) return hit.state;
    const state = buildState(root, bugDir, workDir);
    const fingerprint = pyJsonDumpsSorted(
      Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'generated_at')));
    this._cache.set(projectId, { ts: this._now(), state, fingerprint });
    return state;
  }

  /**
   * 该项目缓存状态的**构建时**指纹；紧随 `get()` 调用一定存在（无则 null）。
   * @param {number} projectId
   * @returns {string|null}
   */
  fingerprint(projectId) {
    const hit = this._cache.get(projectId);
    return hit ? hit.fingerprint : null;
  }

  /** 清空缓存（单测隔离用；Python 侧无此方法，不影响端点行为） */
  clear() {
    this._cache.clear();
  }
}
