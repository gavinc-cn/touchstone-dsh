#!/usr/bin/env python3
"""任务会话对齐卡片会话（2026-10-24 批次）：让行 / 权限 / 模型 / 交互 / compact。

计划：doc_ai/plan/202610/20261024_1148_任务会话对齐卡片会话设计与实施计划.md §3/§4。

覆盖：
A. waitq 让行与 runner 等待循环
  - `_wait_turn_end_dsh`：interaction 事件/5s tick 探测 → starting↔suspended；
    suspension 让出串行位（unit_busy/_pick_locked 不受阻）；turn 结束/停止/异常
    finally 恢复行态（不残留 suspended）；
  - `_run_round_dshplugin` 权限链：会话实况 → tasks.permission → projects.permission_mode，
    与 effort 合并成一次 `apply_session_defaults`（best-effort）。
B. server 任务侧能力（handler 替身直调，不起 HTTP）
  - `_api_task_session_profile`：model/permission 即时下发 + 回写 tasks 行 + 三键回执 +
    校验顺序/文案/状态码；
  - `_api_task_session_compact`：成功体 `{ok,started}`、busy/族/无会话/驱动异常口径；
  - `_session_payload` 新键 interaction/permission/sessionModel/queue/owned +
    queue_state interaction_pending；
  - `_task_interaction_pending`/`_task_json`：任务列表「等待作答」徽标。
C. 隔离实例端到端（真实 server.py + 假 driver）
  - 任务轮起轮真的下发权限档（project 默认 → /permission preset，不带 mode）。
"""
import json
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import board
import db
import dshdriver
import runner
import server
import waitq
from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入


# ---------- 公共替身/夹具 ----------

def _clean_all():
    with db.connect() as conn:
        for t in ("wait_items", "chat_msgs", "rounds", "tasks", "board_cards"):
            conn.execute(f"DELETE FROM {t}")


@pytest.fixture(autouse=True)
def _clean_tables():
    """本文件用例自建真库行：前后清空（隔离实例用例共用同一临时库）。"""
    _clean_all()
    yield
    _clean_all()


def _bare_runner():
    """裸 Runner（不起 worker 线程）：让行/权限链单测只需锁与停止集合。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    r._procs = {}
    r._stop_requested = set()
    return r


def _mk_project(agent_path="dsh-plugin:/bin/true", **over):
    uid = f"{time.time_ns()}_{threading.get_ident()}"
    kw = {"work_dir": f"/tmp/align-{uid}/work"}
    kw.update(over)
    return db.insert_project(0, f"align-{uid}", f"/tmp/align-{uid}", agent_path, **kw)


class _Waiter:
    """TurnWaiter 替身：按脚本返回 wait_turn 事件（不碰远端）。"""

    def __init__(self, events, exit_code=0, reason="completed"):
        self.events = list(events)
        self.started = True
        self.exit_code = exit_code
        self.turn_reason = reason
        self.error = ""

    def wait_turn(self, timeout=None):
        if self.events:
            return self.events.pop(0)
        return "timeout"


def _seed_task_row(tid, pid, state="starting"):
    """seed 一条 t: 活跃行（claim 后即 starting；state 可白盒指定）。"""
    waitq.enqueue(waitq.KIND_TASK, tid, pid)
    waitq.claim_by_target(waitq.KIND_TASK, tid, "worker")
    if state != "starting":
        with db.connect() as conn:
            conn.execute("UPDATE wait_items SET state=? WHERE kind='task'"
                         " AND target_id=?", (state, str(tid)))


def _task_state(tid):
    row = waitq.get_active(waitq.KIND_TASK, tid)
    return row["state"] if row is not None else ""


# ---------- A1. runner 等待循环：探测 → 让行/恢复 ----------

def test_wait_turn_suspends_and_resumes_on_probe(monkeypatch, tmp_path):
    """interaction 事件让行、后续 tick 探测到已答恢复：两行日志逐字、行态往返
    starting↔suspended、force 刷新探测缓存（_iw_clear）。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "让行任务", 0, "不复测", "rounds", "1")
    _seed_task_row(tid, pid)
    task = {"id": tid, "session_id": ""}
    project = {"id": pid, "project_dir": "/tmp/x"}
    r = _bare_runner()
    probe_results = [{"pending": True}, {"pending": True}, {"pending": False}]
    probe_calls = []
    cleared = []

    def _probe(family, proj, sid):
        probe_calls.append((family, sid))
        return probe_results.pop(0) if probe_results else {"pending": False}

    monkeypatch.setattr(board, "interaction_probe", _probe)
    monkeypatch.setattr(board, "_iw_clear", lambda sid: cleared.append(sid))
    log = tmp_path / "round.log"
    waiter = _Waiter(["interaction", "timeout", "timeout", "turn_end"])
    exit_code = r._wait_turn_end_dsh(project, task, "sid-1", waiter, str(log))
    text = log.read_text(encoding="utf-8")
    assert exit_code == 0
    # interaction 事件那次先清缓存再探（避免 5s TTL 里的 pending=false）
    assert cleared == ["sid-1"]
    assert len(probe_calls) == 3
    assert text.count("### 等待用户作答（提问/审批）：让出项目串行位") == 1
    assert text.count("### 作答已收：恢复项目串行位") == 1
    # turn_end 收尾：行已恢复 starting（finally 不残留 suspended）
    assert _task_state(tid) == "starting"


def test_wait_turn_turn_end_resumes_row_silently(monkeypatch, tmp_path):
    """让行后 turn 直接结束（作答在宿主侧完成/宿主放弃等）：finally 恢复行态——
    不残留 suspended（否则下一轮 t: 行不占串行位），恢复动作不写「作答已收」日志。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "让行后结束", 0, "不复测", "rounds", "1")
    _seed_task_row(tid, pid)
    task = {"id": tid, "session_id": ""}
    r = _bare_runner()
    monkeypatch.setattr(board, "interaction_probe", lambda *a: {"pending": True})
    monkeypatch.setattr(board, "_iw_clear", lambda sid: None)
    log = tmp_path / "round.log"
    waiter = _Waiter(["interaction", "turn_end"])
    assert r._wait_turn_end_dsh({"id": pid}, task, "sid-1", waiter, str(log)) == 0
    text = log.read_text(encoding="utf-8")
    assert "让出项目串行位" in text
    assert "作答已收" not in text
    assert _task_state(tid) == "starting"          # finally 恢复


def test_wait_turn_probe_unknown_keeps_state(monkeypatch, tmp_path):
    """探测返回 None（中枢断连/未知）⇒ 保持现状、不猜：既不 suspend 也不 resume。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "未知探测", 0, "不复测", "rounds", "1")
    _seed_task_row(tid, pid)
    task = {"id": tid, "session_id": ""}
    r = _bare_runner()
    calls = {"n": 0}

    def _probe(*a):
        calls["n"] += 1
        return None
    monkeypatch.setattr(board, "interaction_probe", _probe)
    monkeypatch.setattr(board, "_iw_clear", lambda sid: None)
    log = tmp_path / "round.log"
    waiter = _Waiter(["interaction", "timeout", "turn_end"])
    assert r._wait_turn_end_dsh({"id": pid}, task, "sid-1", waiter, str(log)) == 0
    assert calls["n"] >= 2
    assert _task_state(tid) == "starting"          # 全程未挂起
    assert "让出项目串行位" not in log.read_text(encoding="utf-8")


def test_wait_turn_stop_after_suspend_restores_row(monkeypatch, tmp_path):
    """让行中收到停止：cancel turn 返回 130，finally 把行恢复 starting → worker
    finally 按 failed/done 正常收口（不留下 suspended 僵尸行）。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "让行中停止", 0, "不复测", "rounds", "1")
    db.update_task(tid, status="running")
    _seed_task_row(tid, pid)
    task = {"id": tid, "session_id": ""}
    r = _bare_runner()
    r._stop_requested.add(tid)
    monkeypatch.setattr(board, "interaction_probe", lambda *a: {"pending": True})
    monkeypatch.setattr(board, "_iw_clear", lambda sid: None)
    monkeypatch.setattr(dshdriver, "cancel", lambda sid: {"ok": True})
    log = tmp_path / "round.log"
    waiter = _Waiter(["interaction", "timeout"])
    assert r._wait_turn_end_dsh({"id": pid}, task, "sid-1", waiter, str(log)) == 130
    assert _task_state(tid) == "starting"
    # worker finally 正常收口（suspended 门禁已扩）
    assert waitq.finish_by_target(waitq.KIND_TASK, tid, waitq.STATE_FAILED, "停止") is True
    assert _task_state(tid) == ""


def test_suspend_frees_project_serial_slot(monkeypatch):
    """让行 = 行态表达：t:A suspended 时同项目排队 t:B 可被拾取（A 不占前缀窗口），
    且 unit_busy 回 False——后续单元不必等 A 作答。"""
    pid = _mk_project()
    tid_a = db.insert_task(pid, "A等作答", 0, "不复测", "rounds", "1")
    tid_b = db.insert_task(pid, "B排队", 0, "不复测", "rounds", "1")
    _seed_task_row(tid_a, pid)
    waitq.enqueue(waitq.KIND_TASK, tid_b, pid)
    r = _bare_runner()
    assert r._pick_locked() is None                 # A 占前缀（serial N=1）→ B 留队
    assert waitq.suspend(waitq.KIND_TASK, tid_a) is True
    assert r.unit_busy(pid) is False                # 让行不占串行位
    assert r._pick_locked() == f"t:{tid_b}"         # B 可先跑
    assert waitq.resume(waitq.KIND_TASK, tid_a) is True
    assert r.unit_busy(pid) is True                 # 恢复后重新占位


# ---------- A2. 每轮权限链 ----------

def _round_stubs(monkeypatch, sid="sid-round"):
    """把 _run_round_dshplugin 的驱动/会话副作用全部打桩，返回记录容器。"""
    seen = {"defaults": [], "log": ""}
    monkeypatch.setattr(dshdriver, "available", lambda: True)
    monkeypatch.setattr(dshdriver, "ensure_session", lambda *a, **k: sid)
    monkeypatch.setattr(dshdriver, "status", lambda s: {"last_seq": 0})
    monkeypatch.setattr(dshdriver, "prompt", lambda s, text: {"ok": True})
    monkeypatch.setattr(runner, "_dsh_stream_worker", lambda *a, **k: None)
    monkeypatch.setattr(runner.Runner, "_wait_turn_end_dsh", lambda *a: 0)
    monkeypatch.setattr(dshdriver, "apply_session_defaults",
                        lambda s, **kw: seen["defaults"].append((s, kw)) or [])
    return seen


def test_run_round_permission_chain_uses_task_then_project(monkeypatch, tmp_path):
    """每轮权限链：会话实况 → tasks.permission → projects.permission_mode；
    与 effort 合并成**一次** apply_session_defaults（best-effort 日志一行）。"""
    pid = _mk_project(work_dir=str(tmp_path / "work"), permission_mode="read-only")
    tid = db.insert_task(pid, "权限链", 0, "不复测", "rounds", "1",
                         permission="workspace-write")
    task = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    seen = _round_stubs(monkeypatch)
    monkeypatch.setattr(runner.dshevents, "session_permission_mode", lambda sid: "")
    monkeypatch.setattr(runner.dshevents, "session_effort", lambda sid: "")
    r = _bare_runner()
    exit_code, sid = r._run_round_dshplugin(project, task, 1)
    assert exit_code == 0 and sid == "sid-round"
    assert len(seen["defaults"]) == 1
    _sid, kw = seen["defaults"][0]
    # tasks.permission 覆盖项目默认
    assert kw["permission_mode"] == "workspace-write"
    assert kw["reasoning_effort"] == ""
    log_path = db.list_rounds(tid)[-1]["log_path"]
    log = open(log_path, encoding="utf-8", errors="replace").read()
    assert "### 会话默认值 effort=(默认) permission=workspace-write" in log


def test_run_round_permission_session_state_wins(monkeypatch, tmp_path):
    """会话实时态（dshevents preset）优先级最高（用户在会话窗切过的档跨轮存活）。"""
    pid = _mk_project(work_dir=str(tmp_path / "work"), permission_mode="read-only")
    tid = db.insert_task(pid, "会话态优先", 0, "不复测", "rounds", "1",
                         permission="workspace-write")
    task = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    seen = _round_stubs(monkeypatch)
    monkeypatch.setattr(runner.dshevents, "session_permission_mode",
                        lambda sid: "path-rules")
    monkeypatch.setattr(runner.dshevents, "session_effort", lambda sid: "high")
    r = _bare_runner()
    assert r._run_round_dshplugin(project, task, 1)[0] == 0
    _sid, kw = seen["defaults"][0]
    assert kw["permission_mode"] == "path-rules" and kw["reasoning_effort"] == "high"


def test_run_round_permission_falls_back_to_project(monkeypatch, tmp_path):
    """tasks.permission 为空 ⇒ 回落 projects.permission_mode；全空则不下发（不调用）。"""
    pid = _mk_project(work_dir=str(tmp_path / "work"), permission_mode="danger-full-access")
    tid = db.insert_task(pid, "项目默认", 0, "不复测", "rounds", "1")
    task = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    seen = _round_stubs(monkeypatch)
    monkeypatch.setattr(runner.dshevents, "session_permission_mode", lambda sid: "")
    monkeypatch.setattr(runner.dshevents, "session_effort", lambda sid: "")
    r = _bare_runner()
    assert r._run_round_dshplugin(project, task, 1)[0] == 0
    _sid, kw = seen["defaults"][0]
    assert kw["permission_mode"] == "danger-full-access"
    # 全空：apply_session_defaults 不被调用
    pid2 = _mk_project(work_dir=str(tmp_path / "work2"))
    tid2 = db.insert_task(pid2, "全空", 0, "不复测", "rounds", "1")
    seen["defaults"].clear()
    r._run_round_dshplugin(dict(db.get_project(pid2)), dict(db.get_task(tid2)), 1)
    assert seen["defaults"] == []


# ---------- B. server 任务侧端点（handler 替身） ----------

class _TaskHandler:
    """任务侧端点最小 handler 替身：只实现被调用的成员（同 test_dsh_plugin 先例）。"""

    _request_lang = server.Handler._request_lang
    _localize_error = server.Handler._localize_error
    _error = server.Handler._error
    _error_spaced = server.Handler._error_spaced

    def __init__(self, task=None, project=None, family="dsh_plugin"):
        self.resp = []
        self.headers = {}
        self._task = task
        self._project = project
        self._family = family

    def _session_context(self, task_id):
        return self._task, self._project, self._family

    def _respond(self, code, body, ctype=None):
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (AttributeError, ValueError):
            parsed = body
        self.resp.append((code, parsed))


def _task_env(monkeypatch, sid="sid-task", permission="", model=""):
    """建真实项目+任务行（含 sid），返回 (task, project, handler)。"""
    pid = _mk_project(permission_mode="read-only")
    tid = db.insert_task(pid, "端点任务", 0, "不复测", "rounds", "1",
                         permission=permission, model=model)
    db.update_task(tid, status="running", session_id=sid)
    task = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    monkeypatch.setattr(server, "_permission_catalog_values",
                        lambda: {"read-only", "workspace-write", "danger-full-access",
                                 "path-rules", "auto"})
    return task, project, _TaskHandler(task, project)


def test_task_profile_permission_and_model(monkeypatch):
    """任务 profile：permission_mode 校验+即时 set_permission（不带 mode）+ 回写
    tasks.permission；model 即时 set_model + 回写 tasks.model；回执恒三键。"""
    task, project, h = _task_env(monkeypatch)
    seen = []
    monkeypatch.setattr(server.dshdriver, "set_permission",
                        lambda sid, preset, mode=None:
                        seen.append(("perm", sid, preset, mode)) or {})
    monkeypatch.setattr(server.dshdriver, "set_model",
                        lambda sid, model, **kw:
                        seen.append(("model", sid, model, kw)) or {})
    server.Handler._api_task_session_profile(
        h, task["id"], {"permission_mode": "manual",
                        "model": "deepseek-official/deepseek-v4-pro"})
    code, body = h.resp[-1]
    assert code == 200
    assert body == {"ok": True, "model": "deepseek-official/deepseek-v4-pro",
                    "permission_mode": "workspace-write", "reasoning_effort": ""}
    assert ("perm", "sid-task", "workspace-write", None) in seen
    # 与看板 profile 同款：set_model 恒带 reasoning_effort（空串=不改档位）
    assert ("model", "sid-task", "deepseek-official/deepseek-v4-pro",
            {"reasoning_effort": ""}) in seen
    row = db.get_task(task["id"])
    assert row["permission"] == "workspace-write"
    assert row["model"] == "deepseek-official/deepseek-v4-pro"
    # 目录里的自定义档直通 + 只改思考等级（model 传空串，由插件回读当前模型）
    seen.clear()
    server.Handler._api_task_session_profile(
        h, task["id"], {"permission_mode": "path-rules", "reasoning_effort": "low"})
    code, body = h.resp[-1]
    assert code == 200 and body["permission_mode"] == "path-rules"
    assert ("perm", "sid-task", "path-rules", None) in seen
    assert ("model", "sid-task", "", {"reasoning_effort": "low"}) in seen


def test_task_profile_validation_order_and_texts(monkeypatch):
    """参数非法 400 → 族 400 → 无会话 409 → 驱动 502（文案复用看板 profile）。"""
    task, project, h = _task_env(monkeypatch)
    # 空体
    server.Handler._api_task_session_profile(h, task["id"], {})
    assert h.resp[-1][0] == 400 and h.resp[-1][1]["error"] == \
        "model/permission_mode/reasoning_effort required"
    # 非法思考等级
    server.Handler._api_task_session_profile(h, task["id"], {"reasoning_effort": "ultra"})
    assert h.resp[-1][0] == 400 and "思考等级非法" in h.resp[-1][1]["error"]
    # 非法权限档（目录/内置兜底集合外）
    server.Handler._api_task_session_profile(h, task["id"], {"permission_mode": "bogus"})
    assert h.resp[-1][0] == 400 and h.resp[-1][1]["error"] == \
        "权限档非法（宿主权限目录里没有该档位）"
    # 族不符（参数先校验通过）
    h2 = _TaskHandler(task, project, family="/usr/bin/kimi")
    server.Handler._api_task_session_profile(h2, task["id"], {"reasoning_effort": "low"})
    assert h2.resp[-1][0] == 400 and "不支持会话级配置" in h2.resp[-1][1]["error"]
    # 无会话 409（handler 替身返回的行与库同步）
    db.update_task(task["id"], session_id="")
    h._task = dict(db.get_task(task["id"]))
    server.Handler._api_task_session_profile(h, task["id"], {"reasoning_effort": "low"})
    assert h.resp[-1][0] == 409 and "会话尚未生成" in h.resp[-1][1]["error"]
    # 驱动异常 502，且不写回任务行
    db.update_task(task["id"], session_id="sid-task", permission="")
    h._task = dict(db.get_task(task["id"]))

    def _boom(*a, **k):
        raise dshdriver.DshDriverError(-2, "驱动不可达")
    monkeypatch.setattr(server.dshdriver, "set_permission", _boom)
    server.Handler._api_task_session_profile(h, task["id"], {"permission_mode": "read-only"})
    assert h.resp[-1][0] == 502 and "驱动不可达" in h.resp[-1][1]["error"]
    assert db.get_task(task["id"])["permission"] == ""


def test_task_compact_endpoint(monkeypatch):
    """任务 compact：成功 `{ok:true,started:true}`；busy 409、族 400、无会话 409、
    驱动异常 400（文案 `compact 失败: …`）。"""
    task, project, h = _task_env(monkeypatch)
    calls = []
    monkeypatch.setattr(server.dshdriver, "compact", lambda sid: calls.append(sid) or {})
    task2 = dict(db.get_task(task["id"]))
    task2["status"] = "done"
    h._task = task2
    server.Handler._api_task_session_compact(h, task2["id"], {})
    assert h.resp[-1] == (200, {"ok": True, "started": True})
    assert calls == ["sid-task"]
    # busy（任务轮在跑，含等作答挂起）409
    h._task = dict(db.get_task(task["id"]))
    server.Handler._api_task_session_compact(h, task["id"], {})
    assert h.resp[-1][0] == 409 and h.resp[-1][1]["error"] == "会话运行中，稍后再试"
    # 族不支持 400
    h2 = _TaskHandler(dict(db.get_task(task["id"])), project, family="/usr/bin/kimi")
    server.Handler._api_task_session_compact(h2, task["id"], {})
    assert h2.resp[-1][0] == 400
    # 无会话 409
    task3 = dict(db.get_task(task["id"]))
    task3["status"] = "done"
    task3["session_id"] = ""
    h._task = task3
    server.Handler._api_task_session_compact(h, task["id"], {})
    assert h.resp[-1][0] == 409 and "会话尚未生成" in h.resp[-1][1]["error"]

    def _boom(sid):
        raise dshdriver.DshDriverError(404, "会话不在驱动池中")
    monkeypatch.setattr(server.dshdriver, "compact", _boom)
    h._task = dict(db.get_task(task["id"]))
    h._task["status"] = "done"
    server.Handler._api_task_session_compact(h, task["id"], {})
    assert h.resp[-1][0] == 400 and \
        h.resp[-1][1]["error"].startswith("compact 失败: 会话不在驱动池中")


def test_session_payload_task_alignment_keys(monkeypatch):
    """任务会话 meta（§3.3）：interaction/permission/sessionModel/queue/owned 五键 +
    queue_state interaction_pending；permission/sessionModel 缺省不下发。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "payload 任务", 0, "不复测", "rounds", "1")
    db.update_task(tid, status="running", session_id="sid-payload")
    task = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    monkeypatch.setattr(server.sessparse, "load",
                        lambda family, sid, agent, after: {"found": True, "entries": []})
    monkeypatch.setattr(server.sessparse, "cache_clear", lambda: None)
    monkeypatch.setattr(server, "effective_model", lambda tid_, m: "m")
    monkeypatch.setattr(server.chat, "state", lambda sid: {})
    monkeypatch.setattr(server, "_project_busy", lambda pid_: False)
    monkeypatch.setattr(server, "_unit_state", lambda pid_, key: {"state": "running"})
    monkeypatch.setattr(server, "_session_owned", lambda sid: False)
    monkeypatch.setattr(server.dshevents, "get",
                        lambda sid: {"permission": {"mode": "", "preset": "path-rules"},
                                     "model": {"provider": "p", "model": "v4"},
                                     "inbox": [{"id": "i1", "text": "排队一"}]})
    monkeypatch.setattr(server.dshevents, "session_effort", lambda sid: "high")
    mark = {"pending": True, "kind": "approval", "approval_id": "ap-1",
            "answerable": True, "text": "请求审批"}
    monkeypatch.setattr(server.board, "interaction_probe",
                        lambda family, proj, sid: dict(mark))
    body = server.Handler._session_payload(None, task, project, "dsh_plugin", "main", 0)
    assert body["interaction"] == mark
    assert body["permission"] == "path-rules"
    assert body["sessionModel"] == "p/v4"
    assert body["queue"] == [{"id": "i1", "text": "排队一"}]
    assert body["owned"] is False
    assert body["sessionEffort"] == "high"
    # 判定序：server_queued（宿主 inbox 行在场）压 interaction_pending（R2/R10 既有序）
    assert body["queue_state"] == "server_queued"
    # 清空 inbox 只剩挂起 ⇒ interaction_pending（任务侧首次出现该枚举）
    monkeypatch.setattr(server.dshevents, "get",
                        lambda sid: {"inbox": [],
                                     "permission": {"mode": "", "preset": ""},
                                     "model": None})
    body3 = server.Handler._session_payload(None, task, project, "dsh_plugin", "main", 0)
    assert body3["queue"] == [] and body3["interaction"] is not None
    assert body3["queue_state"] == "interaction_pending"
    # 缺省：无 permission/sessionModel、无 queue、无挂起 → unit_state=running
    monkeypatch.setattr(server.dshevents, "get", lambda sid: {"inbox": []})
    monkeypatch.setattr(server.board, "interaction_probe", lambda *a: None)
    body2 = server.Handler._session_payload(None, task, project, "dsh_plugin", "main", 0)
    assert "permission" not in body2 and "sessionModel" not in body2
    assert body2["interaction"] is None and body2["queue"] == []
    assert body2["queue_state"] == "running"


def test_task_interaction_pending_list_flag(monkeypatch):
    """任务列表行 interaction_pending：仅 running 任务探（TTL 复用 interaction_probe），
    其余状态/无会话/族不符/探测异常一律 False（徽标为展示增强，不阻断列表）。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "列表徽标", 0, "不复测", "rounds", "1")
    db.update_task(tid, status="running", session_id="sid-list")
    row = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    calls = []
    monkeypatch.setattr(server.board, "interaction_probe",
                        lambda family, proj, sid:
                        calls.append((family, sid)) or {"pending": True})
    h2 = _TaskHandler()
    h2._task_interaction_pending = lambda r, p: server.Handler._task_interaction_pending(
        h2, r, p)
    assert h2._task_interaction_pending(row, project) is True
    assert calls == [("dsh_plugin", "sid-list")]
    # queued 任务不探
    db.update_task(tid, status="queued")
    row2 = dict(db.get_task(tid))
    assert h2._task_interaction_pending(row2, project) is False
    assert len(calls) == 1
    # running 但探测异常 → False（不抛）
    db.update_task(tid, status="running")
    row3 = dict(db.get_task(tid))

    def _boom(*a):
        raise RuntimeError("probe boom")
    monkeypatch.setattr(server.board, "interaction_probe", _boom)
    assert h2._task_interaction_pending(row3, project) is False


def test_task_json_carries_interaction_pending(monkeypatch):
    """`_task_json`（列表与单任务共用）携带 interaction_pending。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "json 徽标", 0, "不复测", "rounds", "1")
    db.update_task(tid, status="running", session_id="sid-j")
    row = dict(db.get_task(tid))
    project = dict(db.get_project(pid))
    monkeypatch.setattr(server, "effective_model", lambda tid_, m: "m")
    monkeypatch.setattr(server.board, "interaction_probe",
                        lambda *a: {"pending": True})

    class _Cache:
        def get(self, *a, **k):
            return {"library": {"stats": {"total": 0}}}

    h = _TaskHandler()
    h.state_cache = _Cache()
    h._task_interaction_pending = lambda r, p: server.Handler._task_interaction_pending(
        h, r, p)
    h._session_title = lambda r: ""
    data = server.Handler._task_json(h, row)
    assert data["interaction_pending"] is True
    assert data["permission"] == ""


# ---------- C. 隔离实例：任务轮真的下发权限档 ----------

def _calls(srv, call, sid=""):
    rows = []
    for line in srv.call_mark().splitlines():
        if not line.startswith("CALL "):
            continue
        row = json.loads(line[5:])
        if row.get("call") == call and (not sid or row.get("sid") == sid):
            rows.append(row)
    return rows


def test_task_round_applies_permission(isolated_server):
    """任务会话起轮：权限链真正下发到驱动（project 默认 → /permission preset，
    不带 mode），与思考等级同批应用；任务窗可切权限并回写任务行。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "align-task-perm",
                             permission_mode="manual")
    code, d = srv.admin.json(f"/api/projects/{pid}/tasks", "POST",
                             {"name": "任务会话权限", "task_type": "normal",
                              "stop_type": "rounds", "stop_value": "1"})
    assert code == 200, d
    tid = d["id"]
    # 等任务轮起会话并投出 prompt（假 driver 1s 一轮）
    assert srv.wait_until(
        lambda: any(r.get("sid") for r in _calls(srv, "/session")
                    if r.get("task") == f"task-{tid}"), timeout=60)
    sid = [r["sid"] for r in _calls(srv, "/session")
           if r.get("task") == f"task-{tid}"][-1]
    assert srv.wait_until(
        lambda: any(r.get("sid") == sid for r in _calls(srv, "/permission")),
        timeout=60), "任务轮未下发权限档"
    perms = _calls(srv, "/permission", sid)
    assert perms[-1]["preset"] == "workspace-write"        # manual 归一
    assert perms[-1]["mode"] == ""                          # 不再传旧 mode
    # 会话窗切权限（任务端点）：即时下发 + 回写 tasks 行
    assert srv.wait_until(lambda: srv.admin.json(f"/api/tasks/{tid}")[1]["status"]
                          in ("done", "failed"), timeout=60)
    code, body = srv.admin.json(f"/api/tasks/{tid}/session/profile", "POST",
                                {"permission_mode": "read-only",
                                 "model": "deepseek-official/deepseek-v4-pro"})
    assert code == 200, body
    assert body["permission_mode"] == "read-only"
    assert _calls(srv, "/permission", sid)[-1]["preset"] == "read-only"
    task_row = srv.admin.json(f"/api/tasks/{tid}")[1]
    assert task_row["permission"] == "read-only"
    # 任务列表行带 interaction_pending（无挂起时 False；字段恒在）
    code, rows = srv.admin.json(f"/api/projects/{pid}/tasks")
    assert code == 200
    assert rows[0]["interaction_pending"] is False
    # compact：任务已结束 → 成功触发（假 driver /compact）
    code, body = srv.admin.json(f"/api/tasks/{tid}/session/compact", "POST", {})
    assert code == 200, body
    assert body == {"ok": True, "started": True}
    assert _calls(srv, "/compact", sid), "任务 compact 未下发到驱动"


def test_runner_stop_does_not_cancel_suspended_row(monkeypatch):
    """`runner.stop` 对 suspended 行按「运行中」口径处置：不 cancel 行（终态证据交给
    worker finally 的 done/failed），只置停止标记 + cancel 宿主 turn（等价 running
    任务现状；suspended 行若被 cancel 会破坏「等作答让行」的证据链）。"""
    pid = _mk_project()
    tid = db.insert_task(pid, "让行中停止", 0, "不复测", "rounds", "1")
    db.update_task(tid, status="running", session_id="sid-stop")
    _seed_task_row(tid, pid)
    waitq.suspend(waitq.KIND_TASK, tid)
    r = _bare_runner()
    cancelled = []
    monkeypatch.setattr(dshdriver, "cancel",
                        lambda sid: cancelled.append(sid) or {"ok": True})
    r.stop(tid)
    assert tid in r._stop_requested
    assert cancelled == ["sid-stop"]          # 宿主 turn 被中断（运行中口径）
    assert _task_state(tid) == "suspended"    # 行不被 stop 直接 cancel（worker finally 收口）
