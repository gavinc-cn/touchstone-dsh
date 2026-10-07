#!/usr/bin/env python3
"""loadcase.py 单测（2026-09-19 压测面板重构批次）：方案包解析（四级回落）、
图表声明校验与默认面板回退、指标行归一（新通道 / 旧快照两口径）、summary 读取
与脚本驱动最小报告落盘。

零外部依赖：全部纯函数与 tmp_path 文件，不起服务、不发请求。
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import loadcase


def _write(path, text):
    """写文件（自动建父目录）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


# ---------- 路径解析（四级回落） ----------

def test_resolve_script_wins_over_scenario(tmp_path):
    """run.py 与 scenario.json 同时存在时按脚本驱动（脚本表达力更强，优先执行）。"""
    root = str(tmp_path)
    cdir = loadcase.case_dir(root, 7)
    _write(os.path.join(cdir, "run.py"), "print(1)\n")
    _write(os.path.join(cdir, "scenario.json"), "{}\n")
    _write(os.path.join(cdir, "plan.md"), "# 方案\n")
    _write(os.path.join(cdir, "charts.json"), '{"panels":[]}')
    _write(os.path.join(cdir, "panel.html"), "<html></html>")
    info = loadcase.resolve(root, 7)
    assert info["driver"] == loadcase.DRIVER_SCRIPT
    assert info["script_path"] == os.path.join(cdir, "run.py")
    assert info["scenario_path"] is None
    assert info["plan_path"] == os.path.join(cdir, "plan.md")
    assert info["charts_path"] == os.path.join(cdir, "charts.json")
    assert info["html_path"] == os.path.join(cdir, "panel.html")


def test_resolve_scenario_without_script(tmp_path):
    """只有 scenario.json → 场景驱动，脚本路径为空。"""
    root = str(tmp_path)
    cdir = loadcase.case_dir(root, 8)
    _write(os.path.join(cdir, "scenario.json"), "{}\n")
    info = loadcase.resolve(root, 8)
    assert info["driver"] == loadcase.DRIVER_SCENARIO
    assert info["scenario_path"] == os.path.join(cdir, "scenario.json")
    assert info["script_path"] is None and info["plan_path"] is None


def test_resolve_legacy_layout(tmp_path):
    """存量布局 load/scenario_<id>.json → legacy_scenario（无需迁移）。"""
    root = str(tmp_path)
    legacy = _write(os.path.join(root, "load", "scenario_9.json"), "{}\n")
    info = loadcase.resolve(root, 9)
    assert info["driver"] == loadcase.DRIVER_LEGACY
    assert info["scenario_path"] == legacy


def test_resolve_missing(tmp_path):
    """三处都没有 → driver None（runner 据此把发压轮判 failed）。"""
    info = loadcase.resolve(str(tmp_path), 10)
    assert info["driver"] is None
    assert info["script_path"] is None and info["scenario_path"] is None


def test_path_helpers(tmp_path):
    """产物路径约定：指标/旧快照/停止文件落 .web，报告落案例库 load/report。"""
    wd, root = str(tmp_path / "wd"), str(tmp_path / "root")
    assert loadcase.metrics_path(wd, 3) == os.path.join(wd, ".web", "task_3_metrics.jsonl")
    assert loadcase.legacy_snapshot_path(wd, 3) == os.path.join(wd, ".web", "task_3_load.jsonl")
    assert loadcase.stop_file_path(wd, 3) == os.path.join(wd, ".web", "task_3_load.stop")
    assert loadcase.report_dir(root) == os.path.join(root, "load", "report")
    assert loadcase.case_dir(root, 3) == os.path.join(root, "load", "task_3")


# ---------- 图表声明校验 ----------

def _charts_ok():
    return {
        "version": 1, "title": "下单压测",
        "panels": [
            {"id": "rps", "type": "line", "title": "吞吐", "width": "full",
             "series": [{"metric": "rps", "label": "总"},
                        {"metric": "rps", "match": {"group": "下单"}, "label": "下单"}]},
            {"id": "st", "type": "stacked_bar", "metric": "order.status", "groupBy": "status"},
            {"id": "dn", "type": "donut", "metric": "order.type", "groupBy": "type"},
            {"id": "kpi", "type": "stat", "stats": [{"metric": "req.total", "agg": "last"}]},
            {"id": "tb", "type": "table", "source": "series", "metric": "rps", "groupBy": "group"},
        ],
    }


def test_validate_charts_ok_and_defaults():
    """合法声明：宽度/标题补默认值，match 与 scale 保留。"""
    charts, err = loadcase.validate_charts(_charts_ok())
    assert err is None
    assert charts["title"] == "下单压测"
    assert [p["id"] for p in charts["panels"]] == ["rps", "st", "dn", "kpi", "tb"]
    assert charts["panels"][0]["width"] == "full"
    assert charts["panels"][1]["width"] == "half"          # 未写 → half
    assert charts["panels"][1]["title"] == "st"            # 未写 → 用 id
    assert charts["panels"][0]["series"][1]["match"] == {"group": "下单"}


def test_validate_charts_stat_single_metric_form():
    """单值卡也接受单 metric 写法（归一为 stats 数组）。"""
    charts, err = loadcase.validate_charts(
        {"panels": [{"id": "a", "type": "stat", "metric": "lat.p95",
                     "label": "P95", "agg": "avg", "unit": "ms"}]})
    assert err is None
    item = charts["panels"][0]["stats"][0]
    assert item == {"metric": "lat.p95", "label": "P95", "agg": "avg", "unit": "ms"}


def test_validate_charts_line_scale_kept():
    """折线 scale 保留（错误率 0~1 乘 100 展示）。"""
    charts, err = loadcase.validate_charts(
        {"panels": [{"id": "e", "type": "line",
                     "series": [{"metric": "err.rate", "scale": 100}]}]})
    assert err is None and charts["panels"][0]["series"][0]["scale"] == 100.0


def test_validate_charts_rejects_bad_shapes():
    """非法声明逐个判错（调用方回退默认面板）。"""
    cases = [
        ([], "顶层必须是 JSON 对象"),
        ({"panels": []}, "1~24"),
        ({"panels": [{"id": "a", "type": "unknown"}]}, "type 非法"),
        ({"panels": [{"type": "line", "series": [{"metric": "a"}]}]}, "id 必填"),
        ({"panels": [{"id": "a", "type": "line", "series": [{"metric": "a"}]},
                     {"id": "a", "type": "line", "series": [{"metric": "b"}]}]}, "id 重复"),
        ({"panels": [{"id": "a", "type": "line", "series": []}]}, "series"),
        ({"panels": [{"id": "a", "type": "line", "series": [{}]}]}, "metric 必填"),
        ({"panels": [{"id": "a", "type": "line", "width": "wide",
                      "series": [{"metric": "a"}]}]}, "width 非法"),
        ({"panels": [{"id": "a", "type": "stacked_bar", "metric": "x"}]}, "groupBy 必填"),
        ({"panels": [{"id": "a", "type": "stat", "stats": [{"metric": "x", "agg": "p99"}]}]},
         "agg 非法"),
        ({"panels": [{"id": "a", "type": "table", "source": "raw"}]}, "source 非法"),
        ({"panels": [{"id": "a", "type": "table", "source": "series"}]}, "metric 必填"),
        ({"panels": [{"id": "a", "type": "bar"}]}, "metric 必填"),
    ]
    for obj, needle in cases:
        charts, err = loadcase.validate_charts(obj)
        assert charts is None and needle in err, (obj, err)


def test_validate_charts_limits():
    """条目数越界判非法（防畸形声明拖死前端）。"""
    many = {"panels": [{"id": f"p{i}", "type": "line", "series": [{"metric": "m"}]}
                       for i in range(loadcase.MAX_PANELS + 1)]}
    assert "1~24" in loadcase.validate_charts(many)[1]
    lots = {"panels": [{"id": "a", "type": "line",
                        "series": [{"metric": f"m{i}"}
                                   for i in range(loadcase.MAX_SERIES + 1)]}]}
    assert "series" in loadcase.validate_charts(lots)[1]


def test_load_charts_fallbacks(tmp_path):
    """缺文件 / 坏 JSON / 校验不过 → 一律回退默认面板并给出原因。"""
    charts, err = loadcase.load_charts(None)
    assert charts is loadcase.DEFAULT_CHARTS and err == ""
    bad = _write(os.path.join(str(tmp_path), "charts.json"), "{不是 JSON")
    charts, err = loadcase.load_charts(bad)
    assert charts is loadcase.DEFAULT_CHARTS and "不是合法 JSON" in err
    wrong = _write(os.path.join(str(tmp_path), "c2.json"),
                   json.dumps({"panels": [{"id": "a", "type": "nope"}]}))
    charts, err = loadcase.load_charts(wrong)
    assert charts is loadcase.DEFAULT_CHARTS and "type 非法" in err
    good = _write(os.path.join(str(tmp_path), "c3.json"), json.dumps(_charts_ok()))
    charts, err = loadcase.load_charts(good)
    assert err == "" and charts["panels"][0]["id"] == "rps"


def test_default_charts_shape():
    """默认面板：RPS/延迟分位/错误率三线 + KPI 卡 + 分接口表（与旧面板口径一致）。"""
    ids = [p["id"] for p in loadcase.DEFAULT_CHARTS["panels"]]
    assert ids == ["rps", "lat", "err", "kpi", "groups"]
    metrics = {s["metric"] for p in loadcase.DEFAULT_CHARTS["panels"]
               if p["type"] == "line" for s in p["series"]}
    assert {"rps", "lat.p50", "lat.p95", "lat.p99", "err.rate"} <= metrics


# ---------- 资产读取 ----------

def test_read_assets_script_package(tmp_path):
    """脚本方案包：方案文档 + 脚本源码 + 图表声明 + 逃生舱标记齐备。"""
    root = str(tmp_path)
    cdir = loadcase.case_dir(root, 11)
    _write(os.path.join(cdir, "plan.md"), "# 压测方案\n")
    _write(os.path.join(cdir, "run.py"), "print('load')\n")
    _write(os.path.join(cdir, "charts.json"), json.dumps(_charts_ok()))
    _write(os.path.join(cdir, "panel.html"), "<html>自定义</html>")
    a = loadcase.read_assets(root, 11)
    assert a["found"] is True and a["driver"] == "script"
    assert a["plan_md"] == "# 压测方案\n" and a["plan_found"] is True
    assert a["script_name"] == "run.py" and "print('load')" in a["script_text"]
    assert a["charts"]["panels"][0]["id"] == "rps" and a["charts_error"] == ""
    assert a["has_html"] is True


def test_read_assets_legacy_and_charts_error(tmp_path):
    """存量场景：脚本位展示场景文件名；图表声明非法时回退默认并带原因。"""
    root = str(tmp_path)
    _write(os.path.join(root, "load", "scenario_12.json"), '{"name":"旧场景"}\n')
    _write(os.path.join(loadcase.case_dir(root, 12), "charts.json"), "{坏的")
    a = loadcase.read_assets(root, 12)
    assert a["driver"] == "legacy_scenario"
    assert a["script_name"] == "scenario_12.json" and "旧场景" in a["script_text"]
    assert a["plan_md"] == "" and a["plan_found"] is False
    assert a["charts"] is loadcase.DEFAULT_CHARTS and a["charts_error"]


def test_read_assets_missing(tmp_path):
    """方案包缺失：found=False，图表仍给默认面板（面板不至于空白）。"""
    a = loadcase.read_assets(str(tmp_path), 13)
    assert a["found"] is False and a["driver"] == ""
    assert a["charts"] is loadcase.DEFAULT_CHARTS


# ---------- 指标行归一 ----------

def test_normalize_new_sample_and_control_lines():
    """新格式：样本原样透传，meta/summary 原样返回，坏输入返回空列表。"""
    s = {"ts": 1.5, "metric": "rps", "value": 10, "type": "gauge", "labels": {"group": "a"}}
    assert loadcase.normalize_line(s) == [s]
    meta = {"kind": "meta", "target": "http://x"}
    assert loadcase.normalize_line(meta) == [meta]
    assert loadcase.normalize_line({"kind": "summary", "values": {"a": 1}}) != []
    assert loadcase.normalize_line({"foo": 1}) == []
    assert loadcase.normalize_line("不是对象") == []


def test_normalize_legacy_snapshot_line():
    """旧快照行 → 规范样本：全局 RPS/错误率/并发/分位 + 分组序列（口径同旧前端）。"""
    line = {"ts": 1700000000, "stage": 2, "conc": 50, "rps": 100.0, "err": 5,
            "groups": {
                "下单": {"rps": 60.0, "err": 3, "lat": {"10": 50, "20": 10}},
                "查询": {"rps": 40.0, "err": 2, "lat": {"5": 40}},
            }}
    out = loadcase.normalize_line(line)
    got = {(s["metric"], tuple(sorted((s.get("labels") or {}).items()))): s["value"]
           for s in out}
    assert got[("rps", ())] == 100.0
    assert got[("err.rate", ())] == 0.05
    assert got[("conc", ())] == 50
    assert got[("rps", (("group", "下单"),))] == 60.0
    assert got[("err.rate", (("group", "下单"),))] == 0.05
    assert ("lat.p95", (("group", "下单"),)) in got      # 分桶插值近似
    assert ("lat.p50", ()) in got and ("lat.p99", ()) in got
    assert all(s["ts"] == 1700000000 for s in out)


def test_normalize_legacy_zero_rps_no_division_error():
    """空窗口（当秒无请求）：错误率按 0 处理，不出现除零。"""
    out = loadcase.normalize_line({"ts": 1, "conc": 0, "rps": 0, "err": 0, "groups": {}})
    rates = [s["value"] for s in out if s["metric"] == "err.rate"]
    assert rates == [0.0]


# ---------- summary 与脚本驱动报告 ----------

def test_read_summary_takes_last_and_missing(tmp_path):
    """summary 取最后一行；文件缺失/无 summary 返回空 dict。"""
    path = os.path.join(str(tmp_path), "m.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"ts":1,"metric":"rps","value":1,"type":"gauge"}\n')
        f.write('{"kind":"summary","values":{"总请求":10}}\n')
        f.write('{"kind":"summary","values":{"总请求":99,"P95":12.5}}\n')
        f.write("{坏行\n")
    assert loadcase.read_summary(path) == {"总请求": 99, "P95": 12.5}
    assert loadcase.read_summary(os.path.join(str(tmp_path), "none.jsonl")) == {}


def test_summarize_values_keeps_load_prefix():
    """轮次摘要文本保持 LOAD 前缀（飞书通知与列表摘要依赖）。"""
    assert loadcase.summarize_values({}) == "LOAD 无指标数据"
    text = loadcase.summarize_values({"总请求": 10})
    assert text.startswith("LOAD ") and "总请求=10" in text


def test_write_minimal_report(tmp_path):
    """脚本驱动报告：json 含 summary，md 出 KPI 表；无指标时给提示而非空表。"""
    rep_dir = str(tmp_path / "report")
    payload = {"case": "task_5", "driver": "run.py", "started_at": "2026-09-19 10:00:00",
               "duration_sec": 61, "stopped": False, "summary": {"总请求": 1200}}
    json_path, md_path = loadcase.write_minimal_report(payload, rep_dir, 5)
    assert os.path.basename(json_path).startswith("task5_")
    with open(json_path, encoding="utf-8") as f:
        assert json.load(f)["summary"] == {"总请求": 1200}
    with open(md_path, encoding="utf-8") as f:
        md = f.read()
    assert "# 压测报告：task_5" in md and "| 总请求 | 1200 |" in md
    _, md2 = loadcase.write_minimal_report(
        {**payload, "summary": {}, "stopped": True}, rep_dir, 6)
    with open(md2, encoding="utf-8") as f:
        assert "未上报收尾指标" in f.read()


# ---------- 运行级产物路径（2026-10-06 复压批次） ----------

def test_run_keyed_paths(tmp_path):
    """运行键非空 → 产物按运行切分；空键 → 存量单文件路径（读侧回落用）。"""
    work = str(tmp_path)
    assert loadcase.metrics_path(work, 7).endswith("task_7_metrics.jsonl")
    assert loadcase.metrics_path(work, 7, "20261006_140000").endswith(
        "task_7_metrics_20261006_140000.jsonl")
    assert loadcase.load_log_path(work, 7).endswith("task_7_load.log")
    assert loadcase.load_log_path(work, 7, "20261006_140000").endswith(
        "task_7_load_20261006_140000.log")
    assert loadcase.snapshot_path(work, 7, "20261006_140000").endswith(
        "task_7_load_20261006_140000.jsonl")
    assert loadcase.legacy_snapshot_path(work, 7).endswith("task_7_load.jsonl")
    key = loadcase.new_run_key()
    assert len(key) == 15 and key.count("_") == 1


def test_list_reports_new_and_legacy(tmp_path):
    """报告列表：新秒级与存量分钟级命名都能列出并区分 legacy；不串到别的任务。"""
    root = str(tmp_path)
    rep = loadcase.report_dir(root)
    for name in ("task7_20261006_140000.json", "task7_20261006_140000.md",
                 "task7_20261006_0117.json", "task71_20261006_140000.json",
                 "task7_bad.json"):
        _write(os.path.join(rep, name), "{}")
    by_key = {r["run_key"]: r for r in loadcase.list_reports(root, 7)}
    assert set(by_key) == {"20261006_140000", "20261006_0117"}
    assert by_key["20261006_140000"]["legacy"] is False
    assert by_key["20261006_140000"]["has_md"] is True
    assert by_key["20261006_0117"]["legacy"] is True
    assert loadcase.parse_report_run_key("task71_20261006_140000.json", 7) is None
    assert loadcase.parse_report_run_key("task7_bad.json", 7) is None
    assert loadcase.parse_report_run_key("task7_20261006140000.json", 7) is None


def test_write_minimal_report_run_key(tmp_path):
    """最小报告按运行键命名；空运行键回落分钟级（存量路径与单测用）。"""
    rep_dir = str(tmp_path / "report")
    payload = {"case": "task_7", "driver": "run.py", "started_at": "2026-10-06 14:15:00",
               "duration_sec": 30, "stopped": False, "summary": {}}
    j, m = loadcase.write_minimal_report(payload, rep_dir, 7,
                                         run_key="20261006_141500")
    assert os.path.basename(j) == "task7_20261006_141500.json"
    assert os.path.basename(m) == "task7_20261006_141500.md"
    j2, _ = loadcase.write_minimal_report(payload, rep_dir, 7)
    assert os.path.basename(j2) != "task7_20261006_141500.json"
    assert len(os.path.basename(j2)) == len("task7_20261006_1415.json")
