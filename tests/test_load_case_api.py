#!/usr/bin/env python3
"""压测面板端点单测（隔离实例）：方案包资产 / 指标增量 / 逃生舱 CSP 头 / 越权。

覆盖 2026-09-19 压测面板重构批次新增与改造的端点：
- GET /api/tasks/<id>/load/case         方案包（plan.md / 载体源码 / 图表声明）
- GET /api/tasks/<id>/load/metrics      规范样本增量（新通道优先、旧快照归一兜底）
- GET /api/tasks/<id>/load_series       旧路径别名（同一实现）
- GET /api/tasks/<id>/load/custom_html  逃生舱（CSP sandbox allow-scripts）
- 多用户隔离：他人任务一律 404（_owned_task 红线）

任务只用于拿 id（端点按 id 读文件），故建完立即停止，避免 runner 真跑发压轮
（「停止 vs 补位器抢跑」的竞态兜底见 `_drop_runner_load_runs`）。
"""

import json
import os
import sqlite3
import time
import urllib.request

from serverfixture import isolated_server


def _write(path, text):
    """写文件（自动建父目录）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def _drop_runner_load_runs(srv, tid, quiet=0.6, timeout=10.0):
    """删净 runner 抢跑产生的发压运行行，删到「静默窗口内不再新增」为止。

    `_terminal_stress` 的已知竞态（其实现在文档里就写着「立刻停止不保证成功」）：任务
    可能在停止生效前已被补位器捡起，跑完 agent 轮后**照常进入发压轮**并落一条
    `kind='load'` 行（本文件里无方案包 ⇒ 该行 status=failed）。这条行的有无随机器快慢
    漂移（2026-10-06 实测：机器闲时必现、跑全量套件时偶现），会让 `/load/runs` 的条目数
    与复压的 `round_no`（= 已有发压行最大轮次 + 1）不再可控。本文件只测读侧与复压端点，
    故把运行集合收敛成用例自造的那几条；库里只有隔离实例的临时数据，删除无副作用。
    """
    deadline, last_hit = time.time() + timeout, 0.0
    conn = sqlite3.connect(srv.db_path)
    try:
        while time.time() < deadline:
            cur = conn.execute("DELETE FROM rounds WHERE task_id=? AND kind='load'", (tid,))
            conn.commit()
            if cur.rowcount:
                last_hit = time.time()
            elif time.time() - last_hit >= quiet:
                return
            time.sleep(0.2)
    finally:
        conn.close()


def _terminal_stress(srv, name):
    """建项目 + 压测任务并等到 runner 收手，返回 (project_id, task_id)。

    面板端点只按任务 id 读资产/指标文件，任务本身不必真跑；等终态是为了避免
    runner 的发压轮清空我们随后写入的指标文件（发压开始时会删旧产物）。
    「立刻停止」不保证成功（可能已进入轮次），故终态接受 stopped/failed/done；
    若真进了发压轮，其运行行由 `_drop_runner_load_runs` 清掉，运行集合回到可控。
    """
    pid = srv.create_project(srv.admin, name)
    code, d = srv.admin.json(f"/api/projects/{pid}/tasks", "POST",
                             {"task_type": "stress", "brief": "压测 http://127.0.0.1:1"})
    assert code == 200, d
    tid = d["id"]
    srv.admin.json(f"/api/tasks/{tid}/stop", "POST")
    assert srv.wait_until(
        lambda: srv.admin.json(f"/api/tasks/{tid}")[1].get("status")
        in ("stopped", "failed", "done"), timeout=60), "压测任务未收敛到终态"
    _drop_runner_load_runs(srv, tid)
    return pid, tid


def _case_dir(srv, tid):
    """方案包目录（案例库根 = <工作目录>/free_style）。"""
    return os.path.join(srv.work_dir, "free_style", "load", f"task_{tid}")


def test_load_case_assets(isolated_server):
    """方案包资产：方案文档 / 脚本源码 / 图表声明 / 逃生舱标记。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadcase-assets")
    cdir = _case_dir(srv, tid)
    _write(os.path.join(cdir, "plan.md"), "# 方案：下单压测\n\n目标 http://127.0.0.1:8080\n")
    _write(os.path.join(cdir, "run.py"), "import os\nprint(os.environ['TS_METRICS_FILE'])\n")
    _write(os.path.join(cdir, "charts.json"), json.dumps(
        {"version": 1, "title": "自定义",
         "panels": [{"id": "st", "type": "stacked_bar", "title": "委托状态",
                     "metric": "order.status", "groupBy": "status"}]}))
    _write(os.path.join(cdir, "panel.html"), "<html>自定义视图</html>")
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/case")
    assert code == 200, d
    assert d["found"] is True and d["driver"] == "script"
    assert d["plan_found"] is True and "下单压测" in d["plan_md"]
    assert d["script_name"] == "run.py" and "TS_METRICS_FILE" in d["script_text"]
    assert d["charts"]["panels"][0]["type"] == "stacked_bar"
    assert d["charts_error"] == "" and d["has_html"] is True
    assert "case_dir" not in d and "html_path" not in d       # 不回传本地路径


def test_load_case_fallbacks(isolated_server):
    """方案缺失 → found=False 且仍给默认面板；图表非法 → 回退默认 + 记录原因。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadcase-fallback")
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/case")
    assert code == 200 and d["found"] is False
    assert d["plan_md"] == "" and d["script_name"] == ""
    assert [p["id"] for p in d["charts"]["panels"]][:2] == ["rps", "lat"]
    _write(os.path.join(_case_dir(srv, tid), "charts.json"), "{坏 JSON")
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/case")
    assert code == 200 and d["charts_error"] and d["charts"]["panels"]


def test_load_metrics_incremental(isolated_server):
    """指标增量：after 分页推进、next 语义稳定、坏行跳过；旧路径别名同实现。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadmetrics")
    path = os.path.join(srv.work_dir, ".web", f"task_{tid}_metrics.jsonl")
    _write(path, "\n".join([
        json.dumps({"kind": "meta", "target": "http://127.0.0.1:8080"}, ensure_ascii=False),
        json.dumps({"ts": 1.0, "metric": "rps", "value": 100, "type": "gauge"}),
        "{半行坏行",
        json.dumps({"ts": 2.0, "metric": "order.status", "value": 3,
                    "type": "counter", "labels": {"status": "已成交"}}, ensure_ascii=False),
    ]) + "\n")
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=0")
    assert code == 200 and d["next"] == 4
    kinds = [s.get("kind") or s.get("metric") for s in d["samples"]]
    assert kinds == ["meta", "rps", "order.status"]
    assert d["samples"][2]["labels"] == {"status": "已成交"}
    code, d2 = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=2")
    assert d2["next"] == 4 and [s.get("metric") for s in d2["samples"]] == ["order.status"]
    # 未增长：next 不推进（前端可轮询）
    code, d3 = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=4")
    assert d3["samples"] == [] and d3["next"] == 4
    # 旧路径别名
    code, d4 = srv.admin.json(f"/api/tasks/{tid}/load_series?after=2")
    assert code == 200 and [s.get("metric") for s in d4["samples"]] == ["order.status"]


def test_load_metrics_legacy_snapshot_normalized(isolated_server):
    """旧任务（只有旧快照文件）读侧归一：一条旧行出多条规范样本。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadmetrics-legacy")
    _write(os.path.join(srv.work_dir, ".web", f"task_{tid}_load.jsonl"), json.dumps(
        {"ts": 1700000000, "stage": 1, "conc": 10, "rps": 50.0, "err": 2,
         "groups": {"首页": {"rps": 50.0, "err": 2, "lat": {"10": 50}}}}) + "\n")
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=0")
    assert code == 200 and d["next"] == 1
    by_metric = {s["metric"] for s in d["samples"]}
    assert {"rps", "err.rate", "conc", "lat.p50"} <= by_metric
    assert any(s.get("labels", {}).get("group") == "首页" for s in d["samples"])


def test_load_custom_html_sandbox_header(isolated_server):
    """逃生舱：返回 HTML 且强制 CSP sandbox（不透明源，拿不到 cookie/API）；缺失 404。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadhtml")
    code, _ = srv.admin.json(f"/api/tasks/{tid}/load/custom_html")
    assert code == 404
    _write(os.path.join(_case_dir(srv, tid), "panel.html"), "<html>自定义</html>")
    req = urllib.request.Request(
        f"{srv.base}/api/tasks/{tid}/load/custom_html")
    with srv.admin.opener.open(req, timeout=30) as r:   # 复用已登录会话的 cookie
        assert r.status == 200
        assert r.headers["Content-Security-Policy"] == "sandbox allow-scripts"
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        assert "text/html" in r.headers["Content-Type"]
        assert "自定义" in r.read().decode("utf-8")


def test_load_endpoints_isolated_by_owner(isolated_server):
    """多用户隔离：他人项目的压测任务一律 404（含新增端点）。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadcase-owner")
    _write(os.path.join(_case_dir(srv, tid), "plan.md"), "# 私密方案\n")
    srv.create_user("loadcase-other", "pw123456")
    other = srv.login("loadcase-other", "pw123456")
    for path in (f"/api/tasks/{tid}/load/case", f"/api/tasks/{tid}/load/metrics",
                 f"/api/tasks/{tid}/load/custom_html", f"/api/tasks/{tid}/load_report"):
        code, d = other.json(path)
        assert code == 404, (path, code)
    assert other.json(f"/api/tasks/{tid}/load/case")[1]["error"] == "task not found"


# ---------- 复压与运行历史（2026-10-06 批次） ----------

def _insert_load_round(srv, tid, round_no, run_key, log_path="", status="done"):
    """直接往隔离实例库里插一条发压运行行（kind='load'）。

    平台侧写口是 runner._run_load_phase；这里为读侧用例造数据，省去真发压。
    与 server 子进程并发写同一 SQLite：任务已终态、无写入竞态。
    """
    conn = sqlite3.connect(srv.db_path)
    try:
        cur = conn.execute(
            "INSERT INTO rounds(task_id, round_no, status, log_path, started_at,"
            " ended_at, summary, kind, run_key)"
            " VALUES(?,?,?,?,?,?,?, 'load', ?)",
            (tid, round_no, status, log_path, "2026-10-06 14:00:00",
             "2026-10-06 14:01:00", "LOAD 结果=完成", run_key))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def test_load_runs_and_run_scoped_reads(isolated_server):
    """运行列表与按运行选读：登记运行 + 孤儿报告，?run= 不串到最新一次。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadruns")
    web = os.path.join(srv.work_dir, ".web")
    rep = os.path.join(srv.work_dir, "free_style", "load", "report")
    keys = ["20261006_140000", "20261006_150000"]
    for i, k in enumerate(keys, start=2):
        _write(os.path.join(web, f"task_{tid}_metrics_{k}.jsonl"), json.dumps(
            {"ts": float(i), "metric": "rps", "value": float(i * 10),
             "type": "gauge"}) + "\n")
        _write(os.path.join(rep, f"task{tid}_{k}.json"), json.dumps(
            {"summary": {"总请求": i}}, ensure_ascii=False))
        _write(os.path.join(rep, f"task{tid}_{k}.md"), f"# 报告 {k}\n")
        _write(os.path.join(web, f"task_{tid}_load_{k}.log"), f"### 压测开始 运行键={k}\n")
        _insert_load_round(srv, tid, i, k,
                           log_path=os.path.join(web, f"task_{tid}_load_{k}.log"))
    # 孤儿报告：存量分钟级命名、无运行行
    _write(os.path.join(rep, f"task{tid}_20260101_0000.json"),
           json.dumps({"summary": {"总请求": 99}}, ensure_ascii=False))

    code, d = srv.admin.json(f"/api/tasks/{tid}/load/runs")
    runs = d["runs"]
    assert code == 200 and len(runs) == 3, runs
    assert runs[0]["run_key"] == keys[1] and runs[0]["registered"] is True
    assert runs[0]["round_no"] == 3 and runs[0]["status"] == "done"
    assert runs[0]["has_report"] and runs[0]["has_metrics"]
    assert runs[0]["kpi"] == {"总请求": 3}
    orphan = [r for r in runs if not r["registered"]]
    assert len(orphan) == 1 and orphan[0]["run_key"] == "20260101_0000"
    assert orphan[0]["legacy"] is True and orphan[0]["has_report"] is True
    assert orphan[0]["has_metrics"] is False

    # 指标按运行选读：指定运行取该运行的曲线，缺省取最新
    code, m = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=0&run={keys[0]}")
    assert [s["value"] for s in m["samples"] if s["metric"] == "rps"] == [20.0]
    code, m2 = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=0")
    assert [s["value"] for s in m2["samples"] if s["metric"] == "rps"] == [30.0]
    # 未登记的运行键 → 空样本（不回落最新，避免看错曲线）
    code, m3 = srv.admin.json(
        f"/api/tasks/{tid}/load/metrics?after=0&run=19700101_000000")
    assert code == 200 and m3["samples"] == []

    # 报告按运行选读（含孤儿报告）
    code, r1 = srv.admin.json(f"/api/tasks/{tid}/load_report?run={keys[0]}")
    assert r1["found"] and r1["file"] == f"task{tid}_{keys[0]}.json"
    assert r1["run_key"] == keys[0]
    code, r2 = srv.admin.json(f"/api/tasks/{tid}/load_report?run=20260101_0000")
    assert r2["found"] and r2["run_key"] == "20260101_0000"
    assert "99" in (r2["md"] or "") or r2["report"].get("summary") == {"总请求": 99}
    code, r3 = srv.admin.json(f"/api/tasks/{tid}/load_report?run=19700101_000000")
    assert code == 404


def test_load_rerun_gating_and_run(isolated_server):
    """复压端到端：门禁（非压测 400 / 排队中 400）→ 真发压 → 新运行行 + 新报告。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loadrerun")
    # 非压测任务：拒绝
    code, d = srv.admin.json(f"/api/projects/{pid}/tasks", "POST",
                             {"task_type": "normal", "name": "普通任务"})
    assert code == 200, d
    nid = d["id"]
    srv.admin.json(f"/api/tasks/{nid}/stop", "POST")
    code, d = srv.admin.json(f"/api/tasks/{nid}/load/rerun", "POST")
    assert code == 400 and "仅压测任务" in d["error"], d

    # 方案包：极简 run.py（写一条样本 + summary 后正常退出）
    _write(os.path.join(_case_dir(srv, tid), "run.py"), "\n".join([
        "import json, os",
        "p = os.environ['TS_METRICS_FILE']",
        "with open(p, 'a', encoding='utf-8') as f:",
        "    f.write(json.dumps({'kind': 'meta', 'target': 'e2e'}) + chr(10))",
        "    f.write(json.dumps({'ts': 1.0, 'metric': 'rps', 'value': 42.0,"
        " 'type': 'gauge'}) + chr(10))",
        "    f.write(json.dumps({'kind': 'summary', 'ts': 2.0,"
        " 'values': {'结果': '完成', '总请求': 7}}, ensure_ascii=False) + chr(10))",
        "print('fake load done')",
        "",
    ]))
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/rerun", "POST")
    assert code == 200 and d.get("ok") is True, d
    code, d2 = srv.admin.json(f"/api/tasks/{tid}/load/rerun", "POST")
    assert code == 400, d2                        # 已排队/运行中，二次复压被拒
    assert srv.wait_until(
        lambda: srv.admin.json(f"/api/tasks/{tid}")[1].get("status")
        not in ("running", "queued"), timeout=90), "复压未收敛到终态"
    code, task = srv.admin.json(f"/api/tasks/{tid}")
    assert task["status"] == "done", (task.get("error"), task.get("status"))

    code, rounds = srv.admin.json(f"/api/tasks/{tid}/rounds")
    loads = [r for r in rounds if r["kind"] == "load"]
    assert len(loads) == 1 and loads[0]["round_no"] == 2, rounds
    run_key = loads[0]["run_key"]
    assert run_key and loads[0]["status"] == "done"
    # 该运行的日志独立成文件（不再与其它运行混在一个 task_<id>_load.log 里）
    assert loads[0]["log_path"].endswith(f"task_{tid}_load_{run_key}.log")

    code, runs = srv.admin.json(f"/api/tasks/{tid}/load/runs")
    assert len(runs["runs"]) == 1 and runs["runs"][0]["run_key"] == run_key
    assert runs["runs"][0]["has_report"] and runs["runs"][0]["has_metrics"]

    code, m = srv.admin.json(f"/api/tasks/{tid}/load/metrics?after=0&run={run_key}")
    assert [s["value"] for s in m["samples"] if s.get("metric") == "rps"] == [42.0]
    code, rep = srv.admin.json(f"/api/tasks/{tid}/load_report?run={run_key}")
    assert rep["found"] and rep["file"] == f"task{tid}_{run_key}.json"
    assert rep["report"]["summary"]["总请求"] == 7
    # 复压不改 agent 轮次计数（仍是第 1 轮出方案）
    assert task["current_round"] == 1


def test_load_diagnose_requires_session(isolated_server):
    """诊断：把现场发给任务会话；无会话时 409；非本人任务 404。"""
    srv = isolated_server
    pid, tid = _terminal_stress(srv, "loaddiag")
    # 有会话：现场文本组装 + 走既有会话消息通道投递（假 driver 会收下）
    code, task = srv.admin.json(f"/api/tasks/{tid}")
    assert task.get("session_id"), "压测任务首轮后应产出会话"
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/diagnose", "POST")
    assert code == 200 and d.get("ok") is True, d
    # 无会话（清掉 session_id 模拟「首轮尚未跑出会话」）→ 409，文案与对话接口一致
    conn = sqlite3.connect(srv.db_path)
    try:
        conn.execute("UPDATE tasks SET session_id='' WHERE id=?", (tid,))
        conn.commit()
    finally:
        conn.close()
    code, d = srv.admin.json(f"/api/tasks/{tid}/load/diagnose", "POST")
    assert code == 409 and "会话尚未生成" in d["error"], d
    # 越权：他人项目任务一律 404
    srv.create_user("loaddiag-other", "pw123456")
    other = srv.login("loaddiag-other", "pw123456")
    code, _ = other.json(f"/api/tasks/{tid}/load/diagnose", "POST")
    assert code == 404
