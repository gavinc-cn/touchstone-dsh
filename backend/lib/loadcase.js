/**
 * `loadcase.py`（558 行，仓库根）的 Node 对应物（Node 后端 M6-5）。
 *
 * 压测方案包（load case）解析与指标通道工具（task_type=stress 专用）：
 * - 方案包路径解析与四级回落（run.py → scenario.json → 存量 scenario_<id>.json → 缺失）；
 * - 方案资产读取（plan.md / 脚本源码 / charts.json 图表声明 / panel.html 存在性）；
 * - 图表声明校验（非法时整份回退内置默认面板，不阻断发压）；
 * - 指标行归一（旧快照行 → 规范样本，供旧任务继续出图）；
 * - 指标收尾行（summary）读取与脚本驱动的最小报告落盘。
 *
 * ── 导出名 ────────────────────────────────────────────────────────────────────
 * 主名**照 Python 名**（`validate_charts`/`load_charts`/`resolve`/…），文件末尾再给一套 camelCase
 * 别名供 JS 调用方使用（与 `rag.js`/`loadgen.js` 同一约定）。对拍用例的 `fn` 写 Python 名、
 * `nodeFn` 写本文件的导出名。
 *
 * ── 与 loadgen 的**共用**（硬约束） ──────────────────────────────────────────
 * `loadcase.py:467/471` 直接调 `loadgen._pct_from_buckets`；Node 侧同样只保留**一份**实现：
 * `_pct_from_buckets` 定义在 `loadgen.js`（`bisect` + 桶内线性插值 + `round(...,1)`），本文件
 * import 它，不另写一份。下面 import 的 `py_float`/`py_error_str`/`read_json_file`/`py_field_str`/
 * `strftime_local` 是 **Node 侧共用小工具**（Python 无对应物，都是「复刻 CPython 语义」的 shim）：
 * 放在 loadgen.js 是为了两文件共用一份实现，不重复造。
 *
 * ── 已登记的**残余差异**（原理性；不做粉饰，逐条给理由） ──────────────────────
 *   a. **整数值浮点的 JSON 文本**：`write_minimal_report` 落盘的 `indent=1` JSON 里，Python 写
 *      `1.0`、`pyjson.js` 写 `1`（`pyjson.js` 文件头已列为不可消除）。对拍夹具刻意避开整数值浮点。
 *   b. **JSON 解码错误文案**：CPython 的 `Expecting value: line 1 column 1 (char 0)` vs V8 的
 *      `Unexpected token …`——分支一致（两侧都判「不是合法 JSON」），文案不同源。
 *   c. `str.isdigit()` 用 `\p{Nd}\p{No}` 复刻（Python 的「十进制数字 + Digit 属性的 No」），
 *      长度按**码点**数；非 BMP 数字（U+1D7CE 段）与 Python 也一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { isFile, pyBasename, pyMtimeFloat, pyStrCompare, pyStrip } from './lib.js';
import { pyJsonDumpsIndent } from './pyjson.js';
import { ValueError, pyInt, pyStr, pyTruthy } from './rag.js';
import {
  _pct_from_buckets, py_error_str, py_field_str, py_float, read_json_file, strftime_local,
} from './loadgen.js';

// ---------- 方案包文件名与驱动类型 ----------

export const LOAD_DIR = 'load';
// 运行键格式：一次发压运行的开始时刻（秒级），日志/指标/快照/报告都按它切分
export const RUN_KEY_FMT = '%Y%m%d_%H%M%S';
export const PLAN_NAME = 'plan.md';
export const SCENARIO_NAME = 'scenario.json';
export const SCRIPT_NAME = 'run.py';
export const CHARTS_NAME = 'charts.json';
export const HTML_NAME = 'panel.html';

// 驱动类型：脚本 / 场景（平台调 loadgen CLI） / 存量场景（旧布局）
export const DRIVER_SCRIPT = 'script';
export const DRIVER_SCENARIO = 'scenario';
export const DRIVER_LEGACY = 'legacy_scenario';

// 指标样本类型与面板类型（校验白名单）
export const SAMPLE_TYPES = Object.freeze(['gauge', 'counter']);
export const PANEL_TYPES = Object.freeze(['line', 'bar', 'stacked_bar', 'donut', 'stat', 'table']);
export const PANEL_WIDTHS = Object.freeze(['half', 'full']);
// 单个面板声明的序列/指标卡上限（防畸形声明把前端拖死）
export const MAX_PANELS = 24;
export const MAX_SERIES = 12;
export const MAX_STATS = 8;
// 资产源码回传前端的上限（字节，超出截断并标注）
export const ASSET_TEXT_MAX = 200 * 1024;

/**
 * 内置默认面板：case 未声明 charts.json（或声明非法）时使用，
 * 口径与旧压测面板一致（RPS / 延迟分位 / 错误率 + KPI 卡 + 分接口表）。
 *
 * **回落时返回的就是这个对象本身**（Python `load_charts` 返回同一个 `DEFAULT_CHARTS`），
 * 调用方不要改它——要用请先 `structuredClone`。
 */
export const DEFAULT_CHARTS = {
  version: 1,
  title: '压测指标',
  panels: [
    {
      id: 'rps',
      type: 'line',
      title: '吞吐 RPS',
      width: 'full',
      series: [{ metric: 'rps', label: '总 RPS' }],
    },
    {
      id: 'lat',
      type: 'line',
      title: '延迟分位 (ms)',
      width: 'half',
      series: [
        { metric: 'lat.p50', label: 'P50' },
        { metric: 'lat.p95', label: 'P95' },
        { metric: 'lat.p99', label: 'P99' },
      ],
    },
    {
      id: 'err',
      type: 'line',
      title: '错误率 (%)',
      width: 'half',
      series: [{ metric: 'err.rate', label: '错误率', scale: 100 }],
    },
    {
      id: 'kpi',
      type: 'stat',
      title: '关键指标',
      width: 'full',
      stats: [
        { metric: 'req.total', label: '总请求', agg: 'last' },
        { metric: 'req.errors', label: '错误数', agg: 'last' },
        { metric: 'lat.p95', label: 'P95 (ms)', agg: 'last' },
        {
          metric: 'err.rate', label: '错误率 (%)', agg: 'last', scale: 100,
        },
      ],
    },
    {
      id: 'groups',
      type: 'table',
      title: '分接口',
      width: 'full',
      source: 'series',
      metric: 'rps',
      groupBy: 'group',
    },
  ],
};

// ---------- 路径解析 ----------

/**
 * 生成一次发压运行的运行键（开始时刻，秒级）。
 *
 * 秒级足够：同一任务串行执行（同项目串行红线），不可能出现同秒两次运行。
 */
export function new_run_key() {
  return strftime_local(new Date(), RUN_KEY_FMT);
}

/**
 * 指标通道文件路径（规范样本；与 runner 写入约定一致）。
 *
 * run_key 非空 → 按运行切分（`task_<id>_metrics_<运行键>.jsonl`）；
 * 为空 → 存量单文件路径 `task_<id>_metrics.jsonl`（旧任务读侧回落）。
 */
export function metrics_path(work_dir, task_id, run_key = '') {
  const name = run_key
    ? `task_${task_id}_metrics_${run_key}.jsonl`
    : `task_${task_id}_metrics.jsonl`;
  return path.join(String(work_dir), '.web', name);
}

/** 旧快照文件路径（场景驱动的兼容产物，同样按运行切分） */
export function snapshot_path(work_dir, task_id, run_key = '') {
  const name = run_key ? `task_${task_id}_load_${run_key}.jsonl` : `task_${task_id}_load.jsonl`;
  return path.join(String(work_dir), '.web', name);
}

/** 存量快照文件路径（旧任务；读侧归一后仍可出图） */
export function legacy_snapshot_path(work_dir, task_id) {
  return path.join(String(work_dir), '.web', `task_${task_id}_load.jsonl`);
}

/** 发压日志路径：按运行切分（每次运行一个文件），空运行键回落存量单文件 */
export function load_log_path(work_dir, task_id, run_key = '') {
  const name = run_key ? `task_${task_id}_load_${run_key}.log` : `task_${task_id}_load.log`;
  return path.join(String(work_dir), '.web', name);
}

/** 停止标志文件路径（脚本驱动：出现即请脚本优雅收尾） */
export function stop_file_path(work_dir, task_id) {
  return path.join(String(work_dir), '.web', `task_${task_id}_load.stop`);
}

/** 压测报告目录（json+md 落盘处） */
export function report_dir(cases_root) {
  return path.join(String(cases_root), LOAD_DIR, 'report');
}

/** 报告文件主名（不带扩展名）：`task<id>_<运行键>` */
export function report_stem(rep_dir, task_id, run_key) {
  return path.join(String(rep_dir), `task${task_id}_${run_key}`);
}

// Python `str.isdigit()`：Unicode「十进制数字（Nd）+ Digit 属性的 No」
const PY_DIGITS_RE = /^[\p{Nd}\p{No}]+$/u;

/**
 * 报告文件名 → 运行键；无法解析（不属于该任务/名字畸形）返回 null。
 *
 * 新布局 `task<id>_YYYYmmdd_HHMMSS.json`（15 位时间戳，秒级）；存量布局
 * `task<id>_YYYYmmdd_HHMM.json`（13 位，分钟级，同分钟重跑会互相覆盖）。
 */
export function parse_report_run_key(name, task_id) {
  const prefix = `task${task_id}_`;
  const text = String(name);
  if (!text.startsWith(prefix) || !text.endsWith('.json')) return null;
  const key = text.slice(prefix.length, text.length - '.json'.length);
  const parts = key.split('_');
  if (parts.length !== 2 || !PY_DIGITS_RE.test(parts[0]) || !PY_DIGITS_RE.test(parts[1])) {
    return null;
  }
  if ([...parts[0]].length !== 8 || ![4, 6].includes([...parts[1]].length)) return null;
  return key;
}

/**
 * 列出该任务的全部报告（按运行键倒序，新的在前）。
 *
 * 返回 `[{run_key, json_path, md_path, mtime, legacy, has_md}]`：legacy=true 表示存量分钟级
 * 命名（无法与运行行一一对应，读侧按「历史（未登记）」处理）。
 */
export function list_reports(cases_root, task_id) {
  const repDir = report_dir(cases_root);
  const out = [];
  let names;
  try {
    names = fs.readdirSync(repDir);
  } catch {
    return out;                                   // 照 Python：OSError → 空表
  }
  for (const name of names) {
    const runKey = parse_report_run_key(name, task_id);
    if (runKey === null) continue;
    const jsonPath = path.join(repDir, name);
    const mdPath = `${jsonPath.slice(0, jsonPath.length - 5)}.md`;
    let mtime = 0.0;
    try {
      mtime = pyMtimeFloat(fs.statSync(jsonPath, { bigint: true }).mtimeNs);
    } catch {
      mtime = 0.0;
    }
    out.push({
      run_key: runKey,
      json_path: jsonPath,
      md_path: isFile(mdPath) ? mdPath : '',
      mtime,
      legacy: [...runKey.split('_')[1]].length === 4,
      has_md: isFile(mdPath),
    });
  }
  // Python: out.sort(key=lambda r: (r["run_key"], r["mtime"]), reverse=True)
  out.sort((a, b) => {
    const c = pyStrCompare(a.run_key, b.run_key);
    if (c !== 0) return -c;
    return b.mtime - a.mtime;
  });
  return out;
}

/** 方案包目录 `<案例库根>/load/task_<id>/` */
export function case_dir(cases_root, task_id) {
  return path.join(String(cases_root), LOAD_DIR, `task_${task_id}`);
}

/**
 * 解析压测方案包，返回驱动类型与各资产路径（四级回落）。
 *
 * 1. `load/task_<id>/run.py`       → script（自定义脚本，平台托管执行）
 * 2. `load/task_<id>/scenario.json` → scenario（平台调 loadgen CLI）
 * 3. `load/scenario_<id>.json`      → legacy_scenario（2026-09 前的旧布局）
 * 4. 都没有                         → driver=None（发压轮判失败）
 *
 * 返回 dict：driver / case_dir / plan_path / script_path / scenario_path /
 * charts_path / html_path（不存在时对应值为 null）。
 */
export function resolve(cases_root, task_id) {
  const cdir = case_dir(cases_root, task_id);
  const script = path.join(cdir, SCRIPT_NAME);
  const scenario = path.join(cdir, SCENARIO_NAME);
  const legacy = path.join(String(cases_root), LOAD_DIR, `scenario_${task_id}.json`);
  const plan = path.join(cdir, PLAN_NAME);
  const charts = path.join(cdir, CHARTS_NAME);
  const html = path.join(cdir, HTML_NAME);
  let driver;
  if (isFile(script)) driver = DRIVER_SCRIPT;
  else if (isFile(scenario)) driver = DRIVER_SCENARIO;
  else if (isFile(legacy)) driver = DRIVER_LEGACY;
  else driver = null;
  return {
    driver,
    case_dir: cdir,
    plan_path: isFile(plan) ? plan : null,
    script_path: driver === DRIVER_SCRIPT ? script : null,
    scenario_path: driver === DRIVER_SCENARIO
      ? scenario
      : (driver === DRIVER_LEGACY ? legacy : null),
    charts_path: isFile(charts) ? charts : null,
    html_path: isFile(html) ? html : null,
  };
}

// ---------- 资产读取与图表声明校验 ----------

/**
 * 读文本文件并按 ASSET_TEXT_MAX 截断（读不到返回空串）。
 *
 * 逐条对齐 `open(path, encoding="utf-8", errors="replace")` + `f.read(MAX+1)`：
 * 只读 `(MAX+1)*4` 字节（UTF-8 每字符至多 4 字节，够 MAX+1 个**码点**）、通用换行
 * （`\r\n`/`\r` → `\n`，Python 的 newline=None 同）、按码点切片。
 */
export function _read_text_capped(file_path) {
  let buf;
  try {
    const fd = fs.openSync(file_path, 'r');
    try {
      const cap = (ASSET_TEXT_MAX + 1) * 4;
      const tmp = Buffer.allocUnsafe(cap);
      const n = fs.readSync(fd, tmp, 0, cap, 0);
      buf = tmp.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';                                    // 照 Python：吞 OSError（含 IsADirectoryError）
  }
  const text = buf.toString('utf8').replace(/\r\n?/g, '\n');
  const chars = [...text];
  if (chars.length > ASSET_TEXT_MAX) {
    return `${chars.slice(0, ASSET_TEXT_MAX).join('')}\n\n…（内容过长已截断）`;
  }
  return text;
}

/** 校验折线面板的 series 数组；返回 `[规范化的 series, 错误说明]` */
export function _validate_series(series, err_prefix) {
  if (!Array.isArray(series) || !(series.length >= 1 && series.length <= MAX_SERIES)) {
    return [null, `${err_prefix}.series 必须是 1~${MAX_SERIES} 项数组`];
  }
  const out = [];
  for (const s of series) {
    if (!(s !== null && typeof s === 'object' && !Array.isArray(s))
        || !pyStrip(pyStr(_get(s, 'metric', '')))) {
      return [null, `${err_prefix}.series[].metric 必填`];
    }
    const item = { metric: pyStrip(pyStr(s.metric)) };
    if (pyTruthy(_get(s, 'label', null))) item.label = pyStr(s.label);
    const match = _get(s, 'match', null);
    if (match !== null) {
      if (!(typeof match === 'object' && !Array.isArray(match))) {
        return [null, `${err_prefix}.series[].match 必须是对象`];
      }
      const kept = {};
      for (const [k, v] of Object.entries(match)) {
        const scalar = typeof v === 'string' || typeof v === 'number';
        if (typeof v === 'boolean' || !scalar) continue;
        kept[pyStr(k)] = v;
      }
      item.match = kept;
    }
    if (_isScalarNum(_get(s, 'scale', null))) item.scale = py_float(s.scale);
    out.push(item);
  }
  return [out, null];
}

/** Python `isinstance(x, (int, float)) and not isinstance(x, bool)` */
function _isScalarNum(value) {
  return typeof value === 'number';
}

/** Python `dict.get(k[, d])`（只有键不存在才给默认值；防原型链上的同名键） */
function _get(obj, key, fallback = null) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return fallback;
}

/** 校验单值卡面板的指标项（单 metric 形式归一为 stats 数组） */
export function _validate_stat_items(panel, err_prefix) {
  let raw = _get(panel, 'stats', null);
  if (raw === null) {
    if (!pyStrip(pyStr(_get(panel, 'metric', '')))) {
      return [null, `${err_prefix} 需要 metric 或 stats`];
    }
    raw = [{
      metric: panel.metric,
      label: _get(panel, 'label', null),
      agg: _get(panel, 'agg', null),
      unit: _get(panel, 'unit', null),
      scale: _get(panel, 'scale', null),
    }];
  }
  if (!Array.isArray(raw) || !(raw.length >= 1 && raw.length <= MAX_STATS)) {
    return [null, `${err_prefix}.stats 必须是 1~${MAX_STATS} 项数组`];
  }
  const out = [];
  for (const it of raw) {
    if (!(it !== null && typeof it === 'object' && !Array.isArray(it))
        || !pyStrip(pyStr(_get(it, 'metric', '')))) {
      return [null, `${err_prefix}.stats[].metric 必填`];
    }
    const item = {
      metric: pyStrip(pyStr(it.metric)),
      label: pyStr(pyTruthy(_get(it, 'label', null)) ? it.label : it.metric),
    };
    const agg = pyStr(pyTruthy(_get(it, 'agg', null)) ? it.agg : 'last');
    if (!['last', 'avg', 'max', 'min', 'sum'].includes(agg)) {
      return [null, `${err_prefix}.stats[].agg 非法: ${agg}`];
    }
    item.agg = agg;
    for (const key of ['unit', 'hint']) {
      if (pyTruthy(_get(it, key, null))) item[key] = pyStr(it[key]);
    }
    if (_isScalarNum(_get(it, 'scale', null))) item.scale = py_float(it.scale);
    out.push(item);
  }
  return [out, null];
}

/**
 * 校验图表声明 charts.json；返回 `[规范化 charts, null]` 或 `[null, 错误说明]`。
 *
 * 规则从宽但足够严：类型/必填字段/条目数越界即整份判非法（调用方回退默认面板），
 * 单个面板的可选字段缺失一律补默认值，避免前端再做一层容错。
 */
export function validate_charts(obj) {
  if (!(obj !== null && typeof obj === 'object' && !Array.isArray(obj))) {
    return [null, 'charts.json 顶层必须是 JSON 对象'];
  }
  const panels = _get(obj, 'panels', null);
  if (!Array.isArray(panels) || !(panels.length >= 1 && panels.length <= MAX_PANELS)) {
    return [null, `panels 必须是 1~${MAX_PANELS} 项数组`];
  }
  const outPanels = [];
  const seen = new Set();
  for (let i = 0; i < panels.length; i += 1) {
    const p = panels[i];
    const tag = `panels[${i}]`;
    if (!(p !== null && typeof p === 'object' && !Array.isArray(p))) {
      return [null, `${tag} 必须是对象`];
    }
    const ptype = pyStrip(pyStr(_get(p, 'type', '')));
    if (!PANEL_TYPES.includes(ptype)) {
      return [null, `${tag}.type 非法: ${ptype || '(空)'}`];
    }
    const pid = pyStrip(pyStr(_get(p, 'id', '')));
    if (!pid) return [null, `${tag}.id 必填`];
    if (seen.has(pid)) return [null, `${tag}.id 重复: ${pid}`];
    seen.add(pid);
    const item = { id: pid, type: ptype, title: pyStr(pyTruthy(_get(p, 'title', null)) ? p.title : pid) };
    const width = pyStr(pyTruthy(_get(p, 'width', null)) ? p.width : 'half');
    if (!PANEL_WIDTHS.includes(width)) return [null, `${tag}.width 非法: ${width}`];
    item.width = width;
    if (pyTruthy(_get(p, 'hint', null))) item.hint = pyStr(p.hint);
    if (ptype === 'line' || ptype === 'bar') {
      if (ptype === 'line') {
        const [series, err] = _validate_series(_get(p, 'series', null), tag);
        if (err) return [null, err];
        item.series = series;
      } else {
        if (!pyStrip(pyStr(_get(p, 'metric', '')))) return [null, `${tag}.metric 必填`];
        item.metric = pyStrip(pyStr(p.metric));
        const by = pyStr(pyTruthy(_get(p, 'by', null)) ? p.by : 'time');
        if (!['time', 'label'].includes(by)) return [null, `${tag}.by 非法: ${by}`];
        item.by = by;
        if (pyTruthy(_get(p, 'groupBy', null))) item.groupBy = pyStr(p.groupBy);
      }
    } else if (ptype === 'stacked_bar' || ptype === 'donut') {
      if (!pyStrip(pyStr(_get(p, 'metric', '')))) return [null, `${tag}.metric 必填`];
      if (!pyStrip(pyStr(_get(p, 'groupBy', '')))) return [null, `${tag}.groupBy 必填`];
      item.metric = pyStrip(pyStr(p.metric));
      item.groupBy = pyStrip(pyStr(p.groupBy));
    } else if (ptype === 'stat') {
      const [stats, err] = _validate_stat_items(p, tag);
      if (err) return [null, err];
      item.stats = stats;
    } else if (ptype === 'table') {
      const src = pyStr(pyTruthy(_get(p, 'source', null)) ? p.source : 'series');
      if (!['series', 'summary'].includes(src)) return [null, `${tag}.source 非法: ${src}`];
      item.source = src;
      if (src === 'series' && !pyStrip(pyStr(_get(p, 'metric', '')))) {
        return [null, `${tag}.metric 必填（source=series）`];
      }
      if (pyTruthy(_get(p, 'metric', null))) item.metric = pyStrip(pyStr(p.metric));
      if (pyTruthy(_get(p, 'groupBy', null))) item.groupBy = pyStr(p.groupBy);
    }
    outPanels.push(item);
  }
  const charts = {
    version: 1,
    title: pyStr(pyTruthy(_get(obj, 'title', null)) ? obj.title : '压测指标'),
    panels: outPanels,
  };
  return [charts, null];
}

/**
 * 读取并校验图表声明；返回 `[charts, 错误说明]`。
 *
 * path 为空/读不到/JSON 非法/校验不过 → 一律回落 `DEFAULT_CHARTS`（**同一个对象**，
 * 照 Python 返回共享常量），并把原因放在第二个返回值（供任务日志记一行，不阻断发压）。
 */
export function load_charts(chart_path) {
  if (!pyTruthy(chart_path)) return [DEFAULT_CHARTS, ''];
  let obj;
  try {
    obj = read_json_file(chart_path);
  } catch (e) {
    if (e instanceof ValueError) {
      return [DEFAULT_CHARTS, `图表声明不是合法 JSON: ${e && e.message !== undefined ? e.message : e}`];
    }
    if (e && typeof e.code === 'string' && typeof e.syscall === 'string') {
      return [DEFAULT_CHARTS, `图表声明读取失败: ${py_error_str(e, chart_path)}`];
    }
    throw e;
  }
  const [charts, err] = validate_charts(obj);
  if (err) return [DEFAULT_CHARTS, err];
  return [charts, ''];
}

/**
 * 读取方案包资产（供面板「压测方案」页与图表渲染使用）。
 *
 * 返回 dict：found（是否有执行载体）/ driver / plan_md / plan_found /
 * script_name / script_text / charts / charts_error / has_html / case_dir / html_path。
 */
export function read_assets(cases_root, task_id) {
  const info = resolve(cases_root, task_id);
  const [charts, chartsErr] = load_charts(info.charts_path);
  let scriptName = '';
  let scriptText = '';
  if (info.script_path) {
    scriptName = SCRIPT_NAME;
    scriptText = _read_text_capped(info.script_path);
  } else if (info.scenario_path) {
    scriptName = pyBasename(info.scenario_path);
    scriptText = _read_text_capped(info.scenario_path);
  }
  const planMd = info.plan_path ? _read_text_capped(info.plan_path) : '';
  return {
    found: info.driver !== null,
    driver: info.driver || '',
    plan_md: planMd,
    plan_found: pyTruthy(planMd),
    script_name: scriptName,
    script_text: scriptText,
    charts,
    charts_error: chartsErr,
    has_html: pyTruthy(info.html_path),
    case_dir: info.case_dir,
    html_path: info.html_path,
  };
}

// ---------- 指标行归一 ----------

/** 构造一条规范样本（值统一转 float，标签统一转 str→标量） */
export function _sample(ts, metric, value, mtype = 'gauge', labels = null) {
  const s = {
    ts, metric, value, type: mtype,
  };
  if (pyTruthy(labels)) {
    const out = {};
    for (const [k, v] of Object.entries(labels)) out[pyStr(k)] = v;
    s.labels = out;
  }
  return s;
}

/**
 * 旧快照行 → 规范样本列表。
 *
 * 旧行形如 `{"ts","stage","conc","rps","err","groups":{名:{"rps","err","lat"}}}`，
 * 只有当秒窗口计数与分组延迟分桶，没有逐请求样本：分位数沿用旧前端口径
 * （跨组合并分桶后插值近似，当秒窗口的 P95 抖动属正常）。
 */
export function _legacy_samples(obj) {
  const ts = pyTruthy(_get(obj, 'ts', null)) ? obj.ts : Math.trunc(Date.now() / 1000);
  const rps = py_float(pyTruthy(_get(obj, 'rps', null)) ? obj.rps : 0.0);
  const err = py_float(pyTruthy(_get(obj, 'err', null)) ? obj.err : 0.0);
  const out = [
    _sample(ts, 'rps', rps),
    _sample(ts, 'err.rate', pyTruthy(rps) ? err / rps : 0.0),
    _sample(ts, 'conc', pyInt(pyTruthy(_get(obj, 'conc', null)) ? obj.conc : 0)),
  ];
  const groups = pyTruthy(_get(obj, 'groups', null)) ? obj.groups : {};
  const merged = {};
  for (const [name, g] of Object.entries(groups)) {
    if (!(g !== null && typeof g === 'object' && !Array.isArray(g))) continue;
    const buckets = pyTruthy(_get(g, 'lat', null)) ? g.lat : {};
    for (const [b, c] of Object.entries(buckets)) {
      merged[b] = pyGetNum(merged, b) + c;
    }
    const gRps = py_float(pyTruthy(_get(g, 'rps', null)) ? g.rps : 0.0);
    const gErr = py_float(pyTruthy(_get(g, 'err', null)) ? g.err : 0.0);
    out.push(_sample(ts, 'rps', gRps, 'gauge', { group: name }));
    out.push(_sample(ts, 'err.rate', pyTruthy(gRps) ? gErr / gRps : 0.0, 'gauge', { group: name }));
    const p95 = _pct_from_buckets(buckets, 95);
    if (p95 !== null) out.push(_sample(ts, 'lat.p95', p95, 'gauge', { group: name }));
  }
  for (const pct of [50, 90, 99]) {
    const val = _pct_from_buckets(merged, pct);
    if (val !== null) out.push(_sample(ts, `lat.p${pct}`, val));
  }
  return out;
}

/** `merged.get(b, 0)`（累加器里的键一定是我们自己放的字符串） */
function pyGetNum(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : 0;
}

/**
 * 指标文件一行 → 规范样本列表（新格式原样透传，旧快照行映射）。
 *
 * 控制行（meta/summary）原样返回，由前端按 kind 分支处理；非 dict 返回空列表。
 */
export function normalize_line(obj) {
  if (!(obj !== null && typeof obj === 'object' && !Array.isArray(obj))) return [];
  const kind = _get(obj, 'kind', null);
  if (kind === 'meta' || kind === 'summary') return [obj];
  if (Object.prototype.hasOwnProperty.call(obj, 'metric')) return [obj];
  if (Object.prototype.hasOwnProperty.call(obj, 'rps')
      && Object.prototype.hasOwnProperty.call(obj, 'groups')) {
    return _legacy_samples(obj);
  }
  return [];
}

/**
 * 读取指标文件的最后一条 summary 行；无则返回 {}。
 *
 * 压测文件可能很大，按 64KiB 分块**流式**扫描（`StringDecoder` 处理跨块的多字节字符），
 * 不整体载入。
 */
export function read_summary(file_path) {
  let found = {};
  let fd;
  try {
    fd = fs.openSync(file_path, 'r');
  } catch {
    return {};                                    // 照 Python：OSError → {}
  }
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(65536);
  let carry = '';
  const eat = (line) => {
    const raw = pyStrip(line);
    if (!raw || !raw.includes('"summary"')) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;                                   // 照 Python：ValueError → 跳过该行
    }
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)
        && _get(obj, 'kind', null) === 'summary') {
      const vals = _get(obj, 'values', null);
      if (vals !== null && typeof vals === 'object' && !Array.isArray(vals)) found = vals;
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
    if (e && typeof e.code === 'string') return {};   // 读中途 OSError：照 Python 整体吞掉
    throw e;
  } finally {
    try {
      fs.closeSync(fd);
    } catch { /* 已关 */ }
  }
  return found;
}

// ---------- 脚本驱动的最小报告 ----------

/** 脚本驱动报告 Markdown：总览 KPI 表（无指标数据时给出提示） */
export function _minimal_md(report) {
  const lines = [`# 压测报告：${report.case}`, '',
    `- 驱动：自定义脚本（${report.driver}）`,
    `- 开始：${report.started_at} · 时长 ${py_field_str(report.duration_sec)}s`
      + (pyTruthy(_get(report, 'stopped', null)) ? '（用户停止，部分结果）' : ''), ''];
  const values = pyTruthy(_get(report, 'summary', null)) ? report.summary : {};
  if (pyTruthy(values)) {
    lines.push('## 关键指标', '', '| 指标 | 值 |', '|---|---|');
    for (const [k, v] of Object.entries(values)) lines.push(`| ${k} | ${py_field_str(v)} |`);
  } else {
    lines.push('本次压测未上报收尾指标（summary 行缺失）；实时曲线请见面板「压测日志」页。');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 脚本驱动的报告落盘：`<rep_dir>/task<id>_<运行键>.{json,md}`。
 *
 * 与 `loadgen.write_report_files` 同名同目录，读侧按运行键/最新取用，不区分驱动。
 * run_key 为空时回落分钟级命名（存量路径与单测用）。返回 `[json_path, md_path]`。
 */
export function write_minimal_report(payload, rep_dir, task_id, run_key = '') {
  fs.mkdirSync(rep_dir, { recursive: true });
  const stem = report_stem(rep_dir, task_id, run_key || strftime_local(new Date(), '%Y%m%d_%H%M'));
  fs.writeFileSync(`${stem}.json`, pyJsonDumpsIndent(payload, 1), 'utf8');
  fs.writeFileSync(`${stem}.md`, _minimal_md(payload), 'utf8');
  return [`${stem}.json`, `${stem}.md`];
}

/** summary values → 一行摘要文本（rounds.summary 用，保持 LOAD 前缀） */
export function summarize_values(values) {
  if (!pyTruthy(values)) return 'LOAD 无指标数据';
  const parts = Object.entries(values).slice(0, 8)
    .map(([k, v]) => `LOAD ${k}=${py_field_str(v)}`);
  return parts.join(' ');
}

// --------------------------------------------------------------------------
// camelCase 别名（JS 调用方用；量具按 Python 名反射，用不到这一套）
// --------------------------------------------------------------------------

export {
  new_run_key as newRunKey,
  metrics_path as metricsPath,
  snapshot_path as snapshotPath,
  legacy_snapshot_path as legacySnapshotPath,
  load_log_path as loadLogPath,
  stop_file_path as stopFilePath,
  report_dir as reportDir,
  report_stem as reportStem,
  parse_report_run_key as parseReportRunKey,
  list_reports as listReports,
  case_dir as caseDir,
  validate_charts as validateCharts,
  load_charts as loadCharts,
  read_assets as readAssets,
  normalize_line as normalizeLine,
  read_summary as readSummary,
  write_minimal_report as writeMinimalReport,
  summarize_values as summarizeValues,
  _read_text_capped as _readTextCapped,
  _validate_series as _validateSeries,
  _validate_stat_items as _validateStatItems,
  _legacy_samples as _legacySamples,
  _minimal_md as _minimalMd,
};
