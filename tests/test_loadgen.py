#!/usr/bin/env python3
"""loadgen.py 单测（2026-09-13 批次）：场景校验、延迟分桶/分位近似、指标计算、
分组权重选择、报告生成与落盘。

零外部依赖：全部纯函数 / tmp_path 文件；不发真实请求（run_load/_worker 由
e2e 与真机使用场景覆盖，单测不涉网络）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import loadgen


def _scenario(**over):
    """最小合法场景（可按需覆盖字段）。"""
    sc = {
        "base_url": "http://127.0.0.1:8080",
        "name": "单测场景",
        "groups": [{"name": "首页", "path": "/"}],
        "stages": [{"conc": 2, "seconds": 5}],
    }
    sc.update(over)
    return sc


def _write(tmp_path, sc):
    p = tmp_path / "scenario.json"
    p.write_text(json.dumps(sc, ensure_ascii=False), encoding="utf-8")
    return str(p)


# ---------- validate_scenario ----------

def test_validate_scenario_ok_and_normalizes(tmp_path):
    """合法场景通过并规范化：method 大写、weight 补 1、timeout_ms 补默认。"""
    sc, err = loadgen.validate_scenario(_write(tmp_path, _scenario()))
    assert err is None and sc is not None
    g = sc["groups"][0]
    assert g["method"] == "GET" and g["weight"] == 1
    assert sc["timeout_ms"] == 10000


@pytest.mark.parametrize("name,sc,err_kw", [
    ("缺文件", None, "不存在"),
    ("顶层非对象", [1, 2], "JSON 对象"),
    ("base_url 带路径", _scenario(base_url="http://h/api"), "base_url"),
    ("base_url 带凭据", _scenario(base_url="http://u:p@h"), "base_url"),
    ("base_url 非 http", _scenario(base_url="ftp://h"), "base_url"),
    ("缺 name", _scenario(name="  "), "name"),
    ("groups 空", _scenario(groups=[]), "groups"),
    ("group 重名", _scenario(groups=[{"name": "a", "path": "/"},
                                     {"name": "a", "path": "/x"}]), "重复"),
    ("method 非法", _scenario(groups=[{"name": "a", "path": "/",
                                       "method": "FOO"}]), "method"),
    ("path 非斜杠开头", _scenario(groups=[{"name": "a", "path": "no"}]), "path"),
    ("headers 值非标量", _scenario(groups=[{"name": "a", "path": "/",
                                            "headers": {"X": {"a": 1}}}]),
     "标量"),
    ("weight 非正整数", _scenario(groups=[{"name": "a", "path": "/",
                                           "weight": 0}]), "weight"),
    ("body 非字符串", _scenario(groups=[{"name": "a", "path": "/",
                                         "body": {"k": 1}}]), "body"),
    ("stages 空", _scenario(stages=[]), "stages"),
    ("conc 超上限", _scenario(stages=[{"conc": loadgen.MAX_CONC + 1,
                                       "seconds": 5}]), "conc"),
    ("seconds 越界", _scenario(stages=[{"conc": 1, "seconds": 4}]), "seconds"),
    ("timeout_ms 越界", _scenario(timeout_ms=99), "timeout_ms"),
], ids=lambda v: v if isinstance(v, str) else "")
def test_validate_scenario_rejections(tmp_path, name, sc, err_kw):
    """各非法分支返回错误说明（部分关键字断言）。"""
    if sc is None:
        path = str(tmp_path / "nope.json")
    elif isinstance(sc, list):
        path = _write(tmp_path, sc)
    else:
        path = _write(tmp_path, sc)
    got, err = loadgen.validate_scenario(path)
    if name == "顶层非对象":
        # json.dump 一个 list 也可写；断言错误而非结果
        assert got is None and err and "JSON 对象" in err
        return
    assert got is None and err is not None and err_kw in err, err


def test_validate_scenario_bad_json(tmp_path):
    """非 JSON 文件报解析错误。"""
    p = tmp_path / "bad.json"
    p.write_text("{不是 json", encoding="utf-8")
    got, err = loadgen.validate_scenario(str(p))
    assert got is None and "JSON" in err


def test_validate_scenario_rejects_bad_port(tmp_path):
    """端口非法必须在校验期拦下（2026-09-19）：

    urlsplit 对 "host:abc" 不报错，端口要到取 .port 时才抛——若放过，工作线程会
    在建连接处静默死掉，产出「0 请求但正常结束」的假报告（e2e 实测踩到）。
    """
    for bad in ("http://127.0.0.1:abc", "http://127.0.0.1:70000", "http://127.0.0.1:1x"):
        path = _write(tmp_path, {"name": "x", "base_url": bad,
                                 "groups": [{"name": "g", "path": "/"}],
                                 "stages": [{"conc": 1, "seconds": 5}]})
        got, err = loadgen.validate_scenario(str(path))
        assert got is None and "端口非法" in err, (bad, err)
    # 合法端口不受影响（含省略端口的常见写法）
    ok = _write(tmp_path, {"name": "x", "base_url": "http://127.0.0.1:8080",
                           "groups": [{"name": "g", "path": "/"}],
                           "stages": [{"conc": 1, "seconds": 5}]})
    assert loadgen.validate_scenario(str(ok))[1] is None


# ---------- 分桶与分位近似 ----------

def test_bucket_of_boundaries():
    """分桶：首个 >= 耗时的边界值；超最大边界归 over。"""
    assert loadgen._bucket_of(0.5) == "1"
    assert loadgen._bucket_of(1) == "1"
    assert loadgen._bucket_of(3) == "5"
    assert loadgen._bucket_of(10000) == "10000"
    assert loadgen._bucket_of(10001) == "over"


def test_pct_from_buckets_single_and_cross():
    """分位近似：桶内按 [上一桶上界, 本桶上界] 均匀插值；跨桶累计插值。"""
    assert loadgen._pct_from_buckets({}, 50) is None
    # 10 个样本都落在 (50,100] 桶：中位按区间均匀取 75
    assert loadgen._pct_from_buckets({"100": 10}, 50) == 75.0
    # 5 个在 (50,100]、5 个在 (100,200]：P90 落在第二桶 80% 处 → 180
    assert loadgen._pct_from_buckets({"100": 5, "200": 5}, 90) == 180.0


def test_max_from_buckets():
    """max 近似：最大非空桶上界；over 桶按上边界；全空 None。"""
    assert loadgen._max_from_buckets({"100": 1}) == 100
    assert loadgen._max_from_buckets({"over": 2}) == loadgen.LAT_BOUNDS[-1]
    assert loadgen._max_from_buckets({}) is None


def test_metrics_math():
    """指标计算：错误率/平均 RPS/分位（桶内近似）/max/错误分类。"""
    stat = {"count": 10, "err": 2, "err_cls": {"4xx": 2}, "buckets": {"100": 8}}
    m = loadgen._metrics(stat, 2.0, peak_rps=3)
    assert m["total"] == 10 and m["errors"] == 2
    assert m["err_rate"] == 0.2 and m["rps_avg"] == 5.0
    assert m["p50"] == 75.0 and m["max"] == 100
    assert m["err_breakdown"] == {"4xx": 2} and m["rps_peak"] == 3.0


def test_metrics_zero_count():
    """零请求：错误率/平均 RPS 归零（不除零）。"""
    m = loadgen._metrics({"count": 0, "err": 0, "err_cls": {},
                          "buckets": {}}, 1.5)
    assert m["err_rate"] == 0.0 and m["rps_avg"] == 0.0
    assert m["p50"] is None and m["max"] is None


# ---------- 分组权重 ----------

def test_pick_group_weighted(monkeypatch):
    """加权选择：随机取值映射到对应组（边界：首组与末组）。"""
    groups = [{"name": "a", "weight": 1}, {"name": "b", "weight": 2}]
    monkeypatch.setattr(loadgen.random, "randrange", lambda n: 0)
    assert loadgen._pick_group(groups)["name"] == "a"
    monkeypatch.setattr(loadgen.random, "randrange", lambda n: 2)
    assert loadgen._pick_group(groups)["name"] == "b"


# ---------- 报告 ----------

def _report():
    return {
        "scenario": "单测场景", "base_url": "http://127.0.0.1:8080",
        "started_at": "2026-09-13 21:00:00", "duration_sec": 5,
        "overall": {"total": 100, "err_rate": 0.01, "rps_avg": 20.0,
                    "p50": 5.0, "p90": 10.0, "p99": 20.0, "max": 100,
                    "err_breakdown": {"4xx": 1}},
        "stages": [{"conc": 2, "seconds": 5, "rps_avg": 20.0, "err_rate": 0.01}],
        "groups": {"首页": {"total": 100, "err_rate": 0.01, "p50": 5.0,
                            "p90": 10.0, "p99": 20.0, "max": 100}},
    }


def test_fmt_errs_text():
    """错误分类短文本格式。"""
    assert loadgen._fmt_errs({"4xx": 1, "timeout": 2}) == \
        "4xx=1 5xx=0 超时=2 连接=0"


def test_report_md_contains_sections():
    """报告 markdown 含标题/总览/档位/分接口三张表关键行。"""
    md = loadgen._report_md(_report())
    assert "# 压测报告：单测场景" in md
    assert "## 总览" in md and "## 档位" in md and "## 分接口" in md
    assert "| 总请求 | 100 |" in md
    assert "| 首页 | 100 |" in md


def test_write_report_files(tmp_path):
    """报告落盘：json 可解析 + md 与内容一致（文件名含 task<id>）。"""
    json_path, md_path = loadgen.write_report_files(
        _report(), str(tmp_path / "reports"), 42)
    assert os.path.basename(json_path).startswith("task42_")
    with open(json_path, encoding="utf-8") as f:
        assert json.load(f)["scenario"] == "单测场景"
    with open(md_path, encoding="utf-8") as f:
        assert "# 压测报告：单测场景" in f.read()


# ---------- 规范指标通道（2026-09-19 压测面板重构批次） ----------

def _read_lines(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(ln) for ln in f if ln.strip()]


def test_metrics_writer_sample_forms(tmp_path):
    """三种行：gauge/counter 样本（带维度标签）+ meta + summary。"""
    path = str(tmp_path / "m.jsonl")
    w = loadgen.MetricsWriter(path)
    w.gauge("rps", 1234.5)
    w.counter("order.status", 120, status="已成交")
    w.sample("lat.p95", 42.1, ts=1700000000.5)
    w.meta(target="http://127.0.0.1:8080", case="下单", none_ignored=None)
    w.summary({"总请求": 100})
    w.close()
    lines = _read_lines(path)
    assert lines[0]["metric"] == "rps" and lines[0]["type"] == "gauge"
    assert lines[0]["value"] == 1234.5 and "labels" not in lines[0]
    assert lines[1]["type"] == "counter" and lines[1]["labels"] == {"status": "已成交"}
    assert lines[2]["ts"] == 1700000000.5
    assert lines[3]["kind"] == "meta" and lines[3]["target"].startswith("http")
    assert "none_ignored" not in lines[3]
    assert lines[4]["kind"] == "summary" and lines[4]["values"] == {"总请求": 100}


def test_metrics_writer_ts_is_not_a_label(tmp_path):
    """ts 是样本时间戳而非维度标签（真机缺陷回归：KPI 卡累计计数显示首秒值）。

    bug_report/20261004_2040：`gauge/counter` 旧签名 `(metric, value, **labels)` 没有
    ts 形参，`w.counter("req.total", …, ts=ts)` 会把 tick 时间戳写进 labels，同一 metric
    每秒成一条新序列，前端 matchSeries 取到最早那条 ⇒ 单值卡显示首秒累计值。
    """
    path = str(tmp_path / "m.jsonl")
    w = loadgen.MetricsWriter(path)
    w.counter("req.total", 42, ts=1700000000)
    w.gauge("rps", 1.0, group="a", ts=1700000001)
    w.close()
    lines = _read_lines(path)
    assert lines[0]["ts"] == 1700000000 and "labels" not in lines[0]
    assert lines[1]["ts"] == 1700000001 and lines[1]["labels"] == {"group": "a"}


def test_metrics_writer_drops_bad_input(tmp_path):
    """非法输入不抛异常、不落坏行（值非数字 / 类型非 gauge|counter / 标签非标量）。"""
    path = str(tmp_path / "m.jsonl")
    w = loadgen.MetricsWriter(path)
    w.gauge("a", "not-a-number")
    w.sample("b", 1, type="histogram")              # 非法类型 → 回落 gauge
    w.counter("c", 2, bad={"nested": 1}, ok=1)      # 嵌套标签被剔除、标量保留
    w.summary({"": 1})
    w.summary("不是 dict")
    w.close()
    lines = _read_lines(path)
    assert [ln["metric"] for ln in lines[:2]] == ["b", "c"]
    assert [ln["type"] for ln in lines[:2]] == ["gauge", "counter"]
    assert lines[1]["labels"] == {"ok": 1}
    assert lines[2]["values"] == {"": 1}
    assert len(lines) == 3


def test_metrics_writer_thread_safe(tmp_path):
    """多线程并发写：行数精确、每行都是完整 JSON（脚本多线程上报场景）。"""
    import threading
    path = str(tmp_path / "m.jsonl")
    w = loadgen.MetricsWriter(path)

    def work(tid):
        for i in range(50):
            w.counter("done", i, tid=tid)

    threads = [threading.Thread(target=work, args=(t,)) for t in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    w.close()
    lines = _read_lines(path)
    assert len(lines) == 400
    assert {ln["labels"]["tid"] for ln in lines} == set(range(8))


def test_metrics_writer_unwritable_path_silent(tmp_path):
    """通道不可写（目录不存在）时静默降级：压测主流程不该因指标落盘失败而中断。"""
    target = str(tmp_path / "no_such_dir" / "m.jsonl")
    w = loadgen.MetricsWriter(target)
    w.gauge("rps", 1)
    w.summary({"a": 1})
    w.close()
    assert not os.path.exists(target)


def test_emit_tick_canonical_metrics(tmp_path):
    """每秒样本口径：全局 rps/err.rate/延迟分位/conc + 分组序列 + 累计 counter。"""
    path = str(tmp_path / "m.jsonl")
    w = loadgen.MetricsWriter(path)
    win = {
        "__all__": {"count": 100, "err": 5, "err_cls": {}, "buckets": {"10": 95, "20": 5}},
        "下单": {"count": 60, "err": 3, "err_cls": {}, "buckets": {"10": 60}},
    }
    total = {"__all__": {"count": 300, "err": 12}, "下单": {"count": 180, "err": 7}}
    loadgen._emit_tick(w, 1700000000, 50, win, total)
    w.close()
    got = {(ln["metric"], (ln.get("labels") or {}).get("group")): ln
           for ln in _read_lines(path)}
    assert got[("rps", None)]["value"] == 100.0
    assert got[("err.rate", None)]["value"] == 0.05
    assert got[("conc", None)]["value"] == 50
    assert got[("lat.p50", None)]["value"] is not None
    assert got[("rps", "下单")]["value"] == 60.0
    assert got[("lat.p95", "下单")]["type"] == "gauge"
    assert got[("req.total", None)]["value"] == 300
    assert got[("req.total", None)]["type"] == "counter"
    assert got[("req.errors", None)]["value"] == 12
    # 累计 counter 的 ts 必须是样本时间戳，不得落成维度标签（否则每秒一条新序列）
    assert got[("req.total", None)]["ts"] == 1700000000
    assert "ts" not in (got[("req.total", None)].get("labels") or {})
    assert "ts" not in (got[("req.errors", None)].get("labels") or {})


# ---------- CLI（run 子命令：scenario 驱动的平台调用入口） ----------

def test_cli_run_rejects_bad_scenario(tmp_path, capsys):
    """场景非法 → 退出码 2 + stderr 原因（runner 据此把发压轮判 failed）。"""
    bad = tmp_path / "scenario.json"
    bad.write_text("{不是 JSON", encoding="utf-8")
    code = loadgen.main(["run", "--scenario", str(bad),
                         "--metrics", str(tmp_path / "m.jsonl")])
    assert code == 2 and "场景校验失败" in capsys.readouterr().err


def test_cli_run_writes_report_and_stdout(tmp_path, monkeypatch, capsys):
    """正常路径：调 run_load 后报告落盘（task<id> 命名）并把摘要打到 stdout。"""
    sc = tmp_path / "scenario.json"
    sc.write_text(json.dumps(_scenario()), encoding="utf-8")
    captured = {}

    def fake_run_load(scenario, *, log_path, snap_path, should_stop=None,
                      metrics_path=None):
        captured.update({"name": scenario["name"], "metrics": metrics_path,
                         "stop": should_stop is not None})
        return _report(), "LOAD 总请求=100"

    monkeypatch.setattr(loadgen, "run_load", fake_run_load)
    rep_dir = tmp_path / "report"
    code = loadgen.main(["run", "--scenario", str(sc),
                         "--metrics", str(tmp_path / "m.jsonl"),
                         "--stop-file", str(tmp_path / "s.stop"),
                         "--report-dir", str(rep_dir), "--task-id", "7"])
    assert code == 0
    assert captured["name"] == "单测场景" and captured["stop"] is True
    assert captured["metrics"].endswith("m.jsonl")
    names = os.listdir(rep_dir)
    assert any(n.startswith("task7_") and n.endswith(".json") for n in names)
    assert any(n.startswith("task7_") and n.endswith(".md") for n in names)
    assert "LOAD 总请求=100" in capsys.readouterr().out


def test_cli_run_quickfail_exit_code(tmp_path, monkeypatch, capsys):
    """快速失败 → 退出码 3（与普通异常的 4 区分开）。"""
    sc = tmp_path / "scenario.json"
    sc.write_text(json.dumps(_scenario()), encoding="utf-8")

    def boom(*a, **kw):
        raise loadgen.QuickFailError("目标服务可能不可达")

    monkeypatch.setattr(loadgen, "run_load", boom)
    code = loadgen.main(["run", "--scenario", str(sc),
                         "--metrics", str(tmp_path / "m.jsonl")])
    assert code == 3 and "不可达" in capsys.readouterr().err
