#!/usr/bin/env python3
"""压测方案包（load case）解析与指标通道工具（task_type=stress 专用）。

职责：
- 方案包路径解析与四级回落（run.py → scenario.json → 存量 scenario_<id>.json → 缺失）；
- 方案资产读取（plan.md / 脚本源码 / charts.json 图表声明 / panel.html 存在性）；
- 图表声明校验（非法时整份回退内置默认面板，不阻断发压）；
- 指标行归一（旧快照行 → 规范样本，供旧任务继续出图）；
- 指标收尾行（summary）读取与脚本驱动的最小报告落盘。

约定（与 prompts._stress_doc 注入的模板一致，改动需同步 builtin_prompts）：
- 方案包目录 `<案例库根>/load/task_<id>/`，内含：
  plan.md（方案文档）、(scenario.json | run.py)（执行载体二选一）、
  charts.json（图表声明，可选）、panel.html（逃生舱，可选）；
- 指标通道 `<工作目录>/.web/task_<id>_metrics_<运行键>.jsonl`，一行一个 JSON 对象：
  · 样本行 {"ts","metric","value","type"(gauge|counter),"labels"}
  · meta 行 {"kind":"meta","ts",...}（目标/档位等上下文，可有可无）
  · summary 行 {"kind":"summary","ts","values":{KPI 名: 值}}（收尾，取最后一行）

2026-10-06 复压批次：压测的**一次发压运行**（load run）以运行键 `run_key`
（该次运行开始时刻 `YYYYmmdd_HHMMSS`）标识，日志/指标/快照/报告全部按它切分，
同一方案包可跑多次且互不覆盖。运行键为空 = 存量单文件布局，读侧回落用
（旧任务的 `task_<id>_metrics.jsonl` / `task_<id>_load.jsonl` / 分钟级报告名）。
"""

import json
import os
import time

import loadgen

# ---------- 方案包文件名与驱动类型 ----------

LOAD_DIR = "load"
# 运行键格式：一次发压运行的开始时刻（秒级），日志/指标/快照/报告都按它切分
RUN_KEY_FMT = "%Y%m%d_%H%M%S"
PLAN_NAME = "plan.md"
SCENARIO_NAME = "scenario.json"
SCRIPT_NAME = "run.py"
CHARTS_NAME = "charts.json"
HTML_NAME = "panel.html"

# 驱动类型：脚本 / 场景（平台调 loadgen CLI） / 存量场景（旧布局）
DRIVER_SCRIPT = "script"
DRIVER_SCENARIO = "scenario"
DRIVER_LEGACY = "legacy_scenario"

# 指标样本类型与面板类型（校验白名单）
SAMPLE_TYPES = ("gauge", "counter")
PANEL_TYPES = ("line", "bar", "stacked_bar", "donut", "stat", "table")
PANEL_WIDTHS = ("half", "full")
# 单个面板声明的序列/指标卡上限（防畸形声明把前端拖死）
MAX_PANELS = 24
MAX_SERIES = 12
MAX_STATS = 8
# 资产源码回传前端的上限（字节，超出截断并标注）
ASSET_TEXT_MAX = 200 * 1024

# 内置默认面板：case 未声明 charts.json（或声明非法）时使用，
# 口径与旧压测面板一致（RPS / 延迟分位 / 错误率 + KPI 卡 + 分接口表）。
DEFAULT_CHARTS = {
    "version": 1,
    "title": "压测指标",
    "panels": [
        {"id": "rps", "type": "line", "title": "吞吐 RPS", "width": "full",
         "series": [{"metric": "rps", "label": "总 RPS"}]},
        {"id": "lat", "type": "line", "title": "延迟分位 (ms)", "width": "half",
         "series": [{"metric": "lat.p50", "label": "P50"},
                    {"metric": "lat.p95", "label": "P95"},
                    {"metric": "lat.p99", "label": "P99"}]},
        {"id": "err", "type": "line", "title": "错误率 (%)", "width": "half",
         "series": [{"metric": "err.rate", "label": "错误率", "scale": 100}]},
        {"id": "kpi", "type": "stat", "title": "关键指标", "width": "full",
         "stats": [
             {"metric": "req.total", "label": "总请求", "agg": "last"},
             {"metric": "req.errors", "label": "错误数", "agg": "last"},
             {"metric": "lat.p95", "label": "P95 (ms)", "agg": "last"},
             {"metric": "err.rate", "label": "错误率 (%)", "agg": "last", "scale": 100},
         ]},
        {"id": "groups", "type": "table", "title": "分接口", "width": "full",
         "source": "series", "metric": "rps", "groupBy": "group"},
    ],
}


# ---------- 路径解析 ----------

def new_run_key():
    """生成一次发压运行的运行键（开始时刻，秒级）。

    秒级足够：同一任务串行执行（同项目串行红线），不可能出现同秒两次运行。
    """
    return time.strftime(RUN_KEY_FMT)


def metrics_path(work_dir, task_id, run_key=""):
    """指标通道文件路径（规范样本；与 runner 写入约定一致）。

    run_key 非空 → 按运行切分（`task_<id>_metrics_<运行键>.jsonl`）；
    为空 → 存量单文件路径 `task_<id>_metrics.jsonl`（旧任务读侧回落）。
    """
    name = (f"task_{task_id}_metrics_{run_key}.jsonl" if run_key
            else f"task_{task_id}_metrics.jsonl")
    return os.path.join(work_dir, ".web", name)


def snapshot_path(work_dir, task_id, run_key=""):
    """旧快照文件路径（场景驱动的兼容产物，同样按运行切分）。"""
    name = (f"task_{task_id}_load_{run_key}.jsonl" if run_key
            else f"task_{task_id}_load.jsonl")
    return os.path.join(work_dir, ".web", name)


def legacy_snapshot_path(work_dir, task_id):
    """存量快照文件路径（旧任务；读侧归一后仍可出图）。"""
    return os.path.join(work_dir, ".web", f"task_{task_id}_load.jsonl")


def load_log_path(work_dir, task_id, run_key=""):
    """发压日志路径：按运行切分（每次运行一个文件），空运行键回落存量单文件。"""
    name = (f"task_{task_id}_load_{run_key}.log" if run_key
            else f"task_{task_id}_load.log")
    return os.path.join(work_dir, ".web", name)


def stop_file_path(work_dir, task_id):
    """停止标志文件路径（脚本驱动：出现即请脚本优雅收尾）。"""
    return os.path.join(work_dir, ".web", f"task_{task_id}_load.stop")


def report_dir(cases_root):
    """压测报告目录（json+md 落盘处）。"""
    return os.path.join(cases_root, LOAD_DIR, "report")


def report_stem(rep_dir, task_id, run_key):
    """报告文件主名（不带扩展名）：`task<id>_<运行键>`。"""
    return os.path.join(rep_dir, f"task{task_id}_{run_key}")


def parse_report_run_key(name, task_id):
    """报告文件名 → 运行键；无法解析（不属于该任务/名字畸形）返回 None。

    新布局 `task<id>_YYYYmmdd_HHMMSS.json`（15 位时间戳，秒级）；存量布局
    `task<id>_YYYYmmdd_HHMM.json`（13 位，分钟级，同分钟重跑会互相覆盖）。
    """
    prefix = f"task{task_id}_"
    if not name.startswith(prefix) or not name.endswith(".json"):
        return None
    key = name[len(prefix):-len(".json")]
    parts = key.split("_")
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
        return None
    if len(parts[0]) != 8 or len(parts[1]) not in (4, 6):
        return None
    return key


def list_reports(cases_root, task_id):
    """列出该任务的全部报告（按运行键倒序，新的在前）。

    返回 [{run_key, json_path, md_path, mtime, legacy}]：legacy=True 表示存量
    分钟级命名（无法与运行行一一对应，读侧按「历史（未登记）」处理）。
    """
    rep_dir = report_dir(cases_root)
    out = []
    try:
        names = os.listdir(rep_dir)
    except OSError:
        return out
    for name in names:
        run_key = parse_report_run_key(name, task_id)
        if run_key is None:
            continue
        json_path = os.path.join(rep_dir, name)
        md_path = json_path[:-5] + ".md"
        try:
            mtime = os.path.getmtime(json_path)
        except OSError:
            mtime = 0.0
        out.append({"run_key": run_key, "json_path": json_path,
                    "md_path": md_path if os.path.isfile(md_path) else "",
                    "mtime": mtime,
                    "legacy": len(run_key.split("_")[1]) == 4,
                    "has_md": os.path.isfile(md_path)})
    out.sort(key=lambda r: (r["run_key"], r["mtime"]), reverse=True)
    return out


def case_dir(cases_root, task_id):
    """方案包目录 `<案例库根>/load/task_<id>/`。"""
    return os.path.join(cases_root, LOAD_DIR, f"task_{task_id}")


def resolve(cases_root, task_id):
    """解析压测方案包，返回驱动类型与各资产路径（四级回落）。

    1. `load/task_<id>/run.py`       → script（自定义脚本，平台托管执行）
    2. `load/task_<id>/scenario.json` → scenario（平台调 loadgen CLI）
    3. `load/scenario_<id>.json`      → legacy_scenario（2026-09 前的旧布局）
    4. 都没有                         → driver=None（发压轮判失败）

    返回 dict：driver / case_dir / plan_path / script_path / scenario_path /
    charts_path / html_path（不存在时对应值为 None）。
    """
    cdir = case_dir(cases_root, task_id)
    script = os.path.join(cdir, SCRIPT_NAME)
    scenario = os.path.join(cdir, SCENARIO_NAME)
    legacy = os.path.join(cases_root, LOAD_DIR, f"scenario_{task_id}.json")
    plan = os.path.join(cdir, PLAN_NAME)
    charts = os.path.join(cdir, CHARTS_NAME)
    html = os.path.join(cdir, HTML_NAME)
    if os.path.isfile(script):
        driver = DRIVER_SCRIPT
    elif os.path.isfile(scenario):
        driver = DRIVER_SCENARIO
    elif os.path.isfile(legacy):
        driver = DRIVER_LEGACY
    else:
        driver = None
    return {
        "driver": driver,
        "case_dir": cdir,
        "plan_path": plan if os.path.isfile(plan) else None,
        "script_path": script if driver == DRIVER_SCRIPT else None,
        "scenario_path": (scenario if driver == DRIVER_SCENARIO
                          else legacy if driver == DRIVER_LEGACY else None),
        "charts_path": charts if os.path.isfile(charts) else None,
        "html_path": html if os.path.isfile(html) else None,
    }


# ---------- 资产读取与图表声明校验 ----------

def _read_text_capped(path):
    """读文本文件并按 ASSET_TEXT_MAX 截断（读不到返回空串）。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(ASSET_TEXT_MAX + 1)
    except OSError:
        return ""
    if len(text) > ASSET_TEXT_MAX:
        return text[:ASSET_TEXT_MAX] + "\n\n…（内容过长已截断）"
    return text


def _validate_series(series, err_prefix):
    """校验折线面板的 series 数组；返回 (规范化的 series, 错误说明)。"""
    if not isinstance(series, list) or not (1 <= len(series) <= MAX_SERIES):
        return None, f"{err_prefix}.series 必须是 1~{MAX_SERIES} 项数组"
    out = []
    for s in series:
        if not isinstance(s, dict) or not str(s.get("metric", "")).strip():
            return None, f"{err_prefix}.series[].metric 必填"
        item = {"metric": str(s["metric"]).strip()}
        if s.get("label"):
            item["label"] = str(s["label"])
        match = s.get("match")
        if match is not None:
            if not isinstance(match, dict):
                return None, f"{err_prefix}.series[].match 必须是对象"
            item["match"] = {str(k): v for k, v in match.items()
                             if isinstance(v, (str, int, float)) and not isinstance(v, bool)}
        if isinstance(s.get("scale"), (int, float)) and not isinstance(s["scale"], bool):
            item["scale"] = float(s["scale"])
        out.append(item)
    return out, None


def _validate_stat_items(panel, err_prefix):
    """校验单值卡面板的指标项（单 metric 形式归一为 stats 数组）。"""
    raw = panel.get("stats")
    if raw is None:
        if not str(panel.get("metric", "")).strip():
            return None, f"{err_prefix} 需要 metric 或 stats"
        raw = [{"metric": panel["metric"], "label": panel.get("label"),
                "agg": panel.get("agg"), "unit": panel.get("unit"),
                "scale": panel.get("scale")}]
    if not isinstance(raw, list) or not (1 <= len(raw) <= MAX_STATS):
        return None, f"{err_prefix}.stats 必须是 1~{MAX_STATS} 项数组"
    out = []
    for it in raw:
        if not isinstance(it, dict) or not str(it.get("metric", "")).strip():
            return None, f"{err_prefix}.stats[].metric 必填"
        item = {"metric": str(it["metric"]).strip(),
                "label": str(it.get("label") or it["metric"])}
        agg = str(it.get("agg") or "last")
        if agg not in ("last", "avg", "max", "min", "sum"):
            return None, f"{err_prefix}.stats[].agg 非法: {agg}"
        item["agg"] = agg
        for key in ("unit", "hint"):
            if it.get(key):
                item[key] = str(it[key])
        if isinstance(it.get("scale"), (int, float)) and not isinstance(it["scale"], bool):
            item["scale"] = float(it["scale"])
        out.append(item)
    return out, None


def validate_charts(obj):
    """校验图表声明 charts.json；返回 (规范化 charts, None) 或 (None, 错误说明)。

    规则从宽但足够严：类型/必填字段/条目数越界即整份判非法（调用方回退默认面板），
    单个面板的可选字段缺失一律补默认值，避免前端再做一层容错。
    """
    if not isinstance(obj, dict):
        return None, "charts.json 顶层必须是 JSON 对象"
    panels = obj.get("panels")
    if not isinstance(panels, list) or not (1 <= len(panels) <= MAX_PANELS):
        return None, f"panels 必须是 1~{MAX_PANELS} 项数组"
    out_panels, seen = [], set()
    for i, p in enumerate(panels):
        tag = f"panels[{i}]"
        if not isinstance(p, dict):
            return None, f"{tag} 必须是对象"
        ptype = str(p.get("type", "")).strip()
        if ptype not in PANEL_TYPES:
            return None, f"{tag}.type 非法: {ptype or '(空)'}"
        pid = str(p.get("id", "")).strip()
        if not pid:
            return None, f"{tag}.id 必填"
        if pid in seen:
            return None, f"{tag}.id 重复: {pid}"
        seen.add(pid)
        item = {"id": pid, "type": ptype,
                "title": str(p.get("title") or pid)}
        width = str(p.get("width") or "half")
        if width not in PANEL_WIDTHS:
            return None, f"{tag}.width 非法: {width}"
        item["width"] = width
        if p.get("hint"):
            item["hint"] = str(p["hint"])
        if ptype in ("line", "bar"):
            if ptype == "line":
                series, err = _validate_series(p.get("series"), tag)
                if err:
                    return None, err
                item["series"] = series
            else:
                if not str(p.get("metric", "")).strip():
                    return None, f"{tag}.metric 必填"
                item["metric"] = str(p["metric"]).strip()
                by = str(p.get("by") or "time")
                if by not in ("time", "label"):
                    return None, f"{tag}.by 非法: {by}"
                item["by"] = by
                if p.get("groupBy"):
                    item["groupBy"] = str(p["groupBy"])
        elif ptype in ("stacked_bar", "donut"):
            if not str(p.get("metric", "")).strip():
                return None, f"{tag}.metric 必填"
            if not str(p.get("groupBy", "")).strip():
                return None, f"{tag}.groupBy 必填"
            item["metric"] = str(p["metric"]).strip()
            item["groupBy"] = str(p["groupBy"]).strip()
        elif ptype == "stat":
            stats, err = _validate_stat_items(p, tag)
            if err:
                return None, err
            item["stats"] = stats
        elif ptype == "table":
            src = str(p.get("source") or "series")
            if src not in ("series", "summary"):
                return None, f"{tag}.source 非法: {src}"
            item["source"] = src
            if src == "series" and not str(p.get("metric", "")).strip():
                return None, f"{tag}.metric 必填（source=series）"
            if p.get("metric"):
                item["metric"] = str(p["metric"]).strip()
            if p.get("groupBy"):
                item["groupBy"] = str(p["groupBy"])
        out_panels.append(item)
    charts = {"version": 1, "title": str(obj.get("title") or "压测指标"),
              "panels": out_panels}
    return charts, None


def load_charts(path):
    """读取并校验图表声明；返回 (charts, 错误说明)。

    path 为空/读不到/JSON 非法/校验不过 → 一律回落 DEFAULT_CHARTS，
    并把原因放在第二个返回值（供任务日志记一行，不阻断发压）。
    """
    if not path:
        return DEFAULT_CHARTS, ""
    try:
        with open(path, encoding="utf-8") as f:
            obj = json.load(f)
    except OSError as e:
        return DEFAULT_CHARTS, f"图表声明读取失败: {e}"
    except ValueError as e:
        return DEFAULT_CHARTS, f"图表声明不是合法 JSON: {e}"
    charts, err = validate_charts(obj)
    if err:
        return DEFAULT_CHARTS, err
    return charts, ""


def read_assets(cases_root, task_id):
    """读取方案包资产（供面板「压测方案」页与图表渲染使用）。

    返回 dict：found（是否有执行载体）/ driver / plan_md / plan_found /
    script_name / script_text / charts / charts_error / has_html。
    """
    info = resolve(cases_root, task_id)
    charts, charts_err = load_charts(info["charts_path"])
    script_name, script_text = "", ""
    if info["script_path"]:
        script_name, script_text = SCRIPT_NAME, _read_text_capped(info["script_path"])
    elif info["scenario_path"]:
        script_name = os.path.basename(info["scenario_path"])
        script_text = _read_text_capped(info["scenario_path"])
    plan_md = _read_text_capped(info["plan_path"]) if info["plan_path"] else ""
    return {
        "found": info["driver"] is not None,
        "driver": info["driver"] or "",
        "plan_md": plan_md,
        "plan_found": bool(plan_md),
        "script_name": script_name,
        "script_text": script_text,
        "charts": charts,
        "charts_error": charts_err,
        "has_html": bool(info["html_path"]),
        "case_dir": info["case_dir"],
        "html_path": info["html_path"],
    }


# ---------- 指标行归一 ----------

def _sample(ts, metric, value, mtype="gauge", labels=None):
    """构造一条规范样本（值统一转 float，标签统一转 str→标量）。"""
    s = {"ts": ts, "metric": metric, "value": value, "type": mtype}
    if labels:
        s["labels"] = {str(k): v for k, v in labels.items()}
    return s


def _legacy_samples(obj):
    """旧快照行 → 规范样本列表。

    旧行形如 {"ts","stage","conc","rps","err","groups":{名:{"rps","err","lat"}}}，
    只有当秒窗口计数与分组延迟分桶，没有逐请求样本：分位数沿用旧前端口径
    （跨组合并分桶后插值近似，当秒窗口的 P95 抖动属正常）。
    """
    ts = obj.get("ts") or int(time.time())
    rps = float(obj.get("rps") or 0.0)
    err = float(obj.get("err") or 0.0)
    out = [
        _sample(ts, "rps", rps),
        _sample(ts, "err.rate", (err / rps) if rps else 0.0),
        _sample(ts, "conc", int(obj.get("conc") or 0)),
    ]
    groups = obj.get("groups") or {}
    merged = {}
    for name, g in groups.items():
        if not isinstance(g, dict):
            continue
        buckets = g.get("lat") or {}
        for b, c in buckets.items():
            merged[b] = merged.get(b, 0) + c
        g_rps = float(g.get("rps") or 0.0)
        g_err = float(g.get("err") or 0.0)
        out.append(_sample(ts, "rps", g_rps, labels={"group": name}))
        out.append(_sample(ts, "err.rate", (g_err / g_rps) if g_rps else 0.0,
                           labels={"group": name}))
        p95 = loadgen._pct_from_buckets(buckets, 95)
        if p95 is not None:
            out.append(_sample(ts, "lat.p95", p95, labels={"group": name}))
    for pct in (50, 90, 99):
        val = loadgen._pct_from_buckets(merged, pct)
        if val is not None:
            out.append(_sample(ts, f"lat.p{pct}", val))
    return out


def normalize_line(obj):
    """指标文件一行 → 规范样本列表（新格式原样透传，旧快照行映射）。

    控制行（meta/summary）原样返回，由前端按 kind 分支处理；非 dict 返回空列表。
    """
    if not isinstance(obj, dict):
        return []
    if obj.get("kind") in ("meta", "summary"):
        return [obj]
    if "metric" in obj:
        return [obj]
    if "rps" in obj and "groups" in obj:
        return _legacy_samples(obj)
    return []


def read_summary(path):
    """读取指标文件的最后一条 summary 行；无则返回 {}。

    压测文件可能很大，按行流式扫描而不整体载入。
    """
    found = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                raw = raw.strip()
                if not raw or '"summary"' not in raw:
                    continue
                try:
                    obj = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(obj, dict) and obj.get("kind") == "summary":
                    vals = obj.get("values")
                    if isinstance(vals, dict):
                        found = vals
    except OSError:
        return {}
    return found


# ---------- 脚本驱动的最小报告 ----------

def _minimal_md(report):
    """脚本驱动报告 Markdown：总览 KPI 表（无指标数据时给出提示）。"""
    lines = [f"# 压测报告：{report['case']}", "",
             f"- 驱动：自定义脚本（{report['driver']}）",
             f"- 开始：{report['started_at']} · 时长 {report['duration_sec']}s"
             + ("（用户停止，部分结果）" if report.get("stopped") else ""), ""]
    values = report.get("summary") or {}
    if values:
        lines += ["## 关键指标", "", "| 指标 | 值 |", "|---|---|"]
        for k, v in values.items():
            lines.append(f"| {k} | {v} |")
    else:
        lines += ["本次压测未上报收尾指标（summary 行缺失）；"
                  "实时曲线请见面板「压测日志」页。"]
    lines.append("")
    return "\n".join(lines)


def write_minimal_report(payload, rep_dir, task_id, run_key=""):
    """脚本驱动的报告落盘：<rep_dir>/task<id>_<运行键>.{json,md}。

    与 loadgen.write_report_files 同名同目录，读侧按运行键/最新取用，不区分驱动。
    run_key 为空时回落分钟级命名（存量路径与单测用）。返回 (json_path, md_path)。
    """
    os.makedirs(rep_dir, exist_ok=True)
    stem = report_stem(rep_dir, task_id, run_key or time.strftime("%Y%m%d_%H%M"))
    with open(stem + ".json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with open(stem + ".md", "w", encoding="utf-8") as f:
        f.write(_minimal_md(payload))
    return stem + ".json", stem + ".md"


def summarize_values(values):
    """summary values → 一行摘要文本（rounds.summary 用，保持 LOAD 前缀）。"""
    if not values:
        return "LOAD 无指标数据"
    parts = [f"LOAD {k}={v}" for k, v in list(values.items())[:8]]
    return " ".join(parts)
