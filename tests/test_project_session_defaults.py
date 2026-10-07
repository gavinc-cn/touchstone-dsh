#!/usr/bin/env python3
"""项目级会话默认值（思考等级 / 权限档）单测 + 隔离实例端到端（2026-10-04 批次）。

覆盖：
A. 纯单测（零外部依赖）
  1. projects 表新列（reasoning_effort / permission_mode）：建表/迁移/读写回路；
  2. 取值归一 server.normalize_effort / normalize_permission_mode（白名单，非法回 None）；
  3. dshdriver.apply_session_defaults：三档 → 宿主 preset 映射、思考等级下发、
     **best-effort**（非法值/驱动异常都不抛，只回告警文本）；
  4. dshevents.session_effort / session_permission_mode 读口（含 preset 反查）；
  5. server._dsh_plugin_models 透传模型目录的 efforts / default_effort（老插件缺字段时为空）。
B. 隔离实例（真实 server.py + 假 driver；见 tests/serverfixture.py）
  6. 项目端点回显与校验（非法档位 400、非法权限档 400、PATCH 保持存量）；
  7. /api/agents/models 带上每个模型的档位与默认档；
  8. 看板卡起会话：项目默认（思考等级 + 权限档）**真的下发到驱动**
     （假 driver 记到 `/model` 带 reasoning_effort、`/permission` 带 preset+mode）；
  9. 会话窗「思考等级」：卡片 profile 端点只改等级也能下发（model 留空）；会话 meta
     回读 sessionEffort（driver/model 状态帧 → dshevents）；
 10. 任务会话：起轮按项目默认下发思考等级，**不下发权限档**（任务侧无审批作答面）；
     任务 session profile 端点只收 reasoning_effort（model/permission_mode 400）。
"""
import json

import pytest

import db
import dshevents
import dshdriver
import server
from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入


# ---------- A. 纯单测 ----------

def test_project_columns_roundtrip():
    """建项目带两个新列 → get_project 回读 → update 改写（含清空回默认）。"""
    pid = db.insert_project(1, "pt-defaults-rt", "/tmp/pt-rt", "dsh-plugin:/tmp/dsh",
                            "/tmp/pt-rt/.touchstone",
                            reasoning_effort="high", permission_mode="manual")
    row = db.get_project(pid)
    assert row["reasoning_effort"] == "high"
    assert row["permission_mode"] == "manual"
    db.update_project(pid, "pt-defaults-rt", "/tmp/pt-rt", "dsh-plugin:/tmp/dsh",
                      "/tmp/pt-rt/.touchstone",
                      reasoning_effort="", permission_mode="yolo")
    row = db.get_project(pid)
    assert row["reasoning_effort"] == "" and row["permission_mode"] == "yolo"


def test_project_migration_adds_default_columns():
    """旧库（projects 无新列）走 init_db 迁移：补两列、存量行取空串默认。"""
    with db.connect() as conn:
        conn.execute("DROP TABLE IF EXISTS projects")
        conn.execute("""CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            name TEXT NOT NULL, project_dir TEXT NOT NULL,
            agent_path TEXT NOT NULL DEFAULT '', work_dir TEXT NOT NULL,
            bug_dir TEXT NOT NULL, guide_text TEXT NOT NULL DEFAULT '',
            commit_spec TEXT NOT NULL DEFAULT '', deploy_spec TEXT NOT NULL DEFAULT '',
            env_label TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL)""")
        conn.execute("INSERT INTO projects(name, project_dir, work_dir, bug_dir, created_at)"
                     " VALUES('legacy','/tmp/legacy','/tmp/legacy/.ts','/tmp/legacy/bugs','x')")
    db.init_db()
    conn = db.connect()
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(projects)")}
        assert {"reasoning_effort", "permission_mode"} <= cols
        row = conn.execute("SELECT * FROM projects WHERE name='legacy'").fetchone()
    finally:
        conn.close()
    assert row["reasoning_effort"] == "" and row["permission_mode"] == ""
    # 迁移后新列可写（写入路径不依赖列顺序）
    db.update_project(row["id"], "legacy", "/tmp/legacy", "", "/tmp/legacy/.ts",
                      reasoning_effort="low", permission_mode="auto")
    assert db.get_project(row["id"])["permission_mode"] == "auto"
    with db.connect() as c2:
        c2.execute("DELETE FROM projects WHERE name='legacy'")


def test_row_opt_tolerates_missing_column():
    """db.row_opt：缺列/None 回落默认值（起会话路径读新列不该 KeyError）。"""
    assert db.row_opt({"a": 1}, "a") == 1
    assert db.row_opt({"a": None}, "a", "x") == "x"
    assert db.row_opt({}, "reasoning_effort") == ""
    assert db.row_opt(None, "reasoning_effort") == ""


@pytest.mark.parametrize("raw,expected", [
    ("", ""), (None, ""), ("  ", ""), ("off", "off"), ("high", "high"), ("xhigh", "xhigh"),
    ("ultra", None), ("HIGH", None),
])
def test_normalize_effort(raw, expected):
    assert server.normalize_effort(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("", ""), (None, ""), ("manual", "manual"), ("yolo", "yolo"), ("auto", "auto"),
    ("danger-full-access", None), ("read-only", None),
])
def test_normalize_permission_mode(raw, expected):
    assert server.normalize_permission_mode(raw) == expected


def test_apply_session_defaults_maps_and_calls(monkeypatch):
    """权限档 → 宿主 preset 映射 + 思考等级下发（含 model/provider 透传）。"""
    calls = []
    monkeypatch.setattr(dshdriver, "set_permission",
                        lambda sid, preset, mode=None: calls.append(("perm", sid, preset, mode)))
    monkeypatch.setattr(dshdriver, "set_model",
                        lambda sid, model, provider="", reasoning_effort="":
                        calls.append(("model", sid, model, provider, reasoning_effort)))
    warns = dshdriver.apply_session_defaults(
        "sid-1", model="m1", provider="p1",
        reasoning_effort="high", permission_mode="manual")
    assert warns == []
    assert ("perm", "sid-1", "workspace-write", "manual") in calls
    assert ("model", "sid-1", "m1", "p1", "high") in calls
    # yolo/auto 同落 danger-full-access（语义近似映射，mode 区分二者）
    calls.clear()
    dshdriver.apply_session_defaults("sid-1", permission_mode="auto")
    assert calls == [("perm", "sid-1", "danger-full-access", "auto")]


def test_apply_session_defaults_best_effort(monkeypatch):
    """非法值/驱动异常一律只回告警（起会话不因一个配置项失败），且告警即时落 log。"""
    def _boom(*a, **k):
        raise dshdriver.DshDriverError(-2, "驱动不可达")
    monkeypatch.setattr(dshdriver, "set_permission", _boom)
    monkeypatch.setattr(dshdriver, "set_model", _boom)
    seen = []
    warns = dshdriver.apply_session_defaults(
        "sid-2", model="m", reasoning_effort="max", permission_mode="manual",
        log=seen.append)
    assert len(warns) == 2 and len(seen) == 2
    assert any("权限档 manual 未生效" in w for w in warns)
    assert any("思考等级 max 未生效" in w for w in warns)
    # 非法值：不调用驱动，只告警
    called = []
    monkeypatch.setattr(dshdriver, "set_model", lambda *a, **k: called.append(1))
    warns = dshdriver.apply_session_defaults("sid-2", reasoning_effort="ultra",
                                             permission_mode="ninja")
    assert called == [] and len(warns) == 2
    # 全空：什么都不做、无告警
    assert dshdriver.apply_session_defaults("sid-2") == []


def test_dshevents_session_readers():
    """思考等级/权限档读口：model.reasoningEffort 直取；权限 mode 优先、preset 反查兜底。

    注意 `EventHub.get` 的不变量「断连=未知」：未连接时一律 None（读口也得是空），
    故用例里显式把 `_connected` 置真。
    """
    with dshevents.HUB._cond:                       # 直接注入注册表（不启订阅线程）
        was_connected = dshevents.HUB._connected
        dshevents.HUB._connected = True
        dshevents.HUB._sessions["s-eff"] = {
            "session_id": "s-eff", "model": {"provider": "p", "model": "m",
                                             "reasoningEffort": "high"},
            "permission": {"mode": "auto", "preset": "danger-full-access"}}
        dshevents.HUB._sessions["s-perm-only"] = {
            "session_id": "s-perm-only", "model": {},
            "permission": {"mode": "", "preset": "workspace-write"}}
        dshevents.HUB._sessions["s-empty"] = {"session_id": "s-empty"}
    try:
        assert dshevents.session_effort("s-eff") == "high"
        assert dshevents.session_permission_mode("s-eff") == "auto"
        # 没记过 mode：按宿主 preset 反查（workspace-write → manual）
        assert dshevents.session_permission_mode("s-perm-only") == "manual"
        assert dshevents.session_effort("s-perm-only") == ""
        assert dshevents.session_effort("s-empty") == ""
        assert dshevents.session_permission_mode("s-empty") == ""
        assert dshevents.session_effort("不存在") == ""
    finally:
        with dshevents.HUB._cond:
            for sid in ("s-eff", "s-perm-only", "s-empty"):
                dshevents.HUB._sessions.pop(sid, None)
            dshevents.HUB._connected = was_connected


def test_plugin_models_passthrough_efforts(monkeypatch):
    """模型目录：每模型带 efforts/default_effort；白名单外的档位 id 被丢弃。"""
    monkeypatch.setattr(dshdriver, "models", lambda: {
        "default": {"provider": "deepseek-official", "model": "deepseek-flash"},
        "groups": [{"id": "deepseek-official", "name": "官方", "models": [
            {"id": "deepseek-flash", "name": "DeepSeek-Flash",
             "efforts": [{"id": "off", "name": "Off"}, {"id": "low", "name": "Low"},
                         {"id": "max", "name": "Max"}, {"id": "ultra", "name": "Ultra"}],
             "default_effort": "max"},
            {"id": "plain", "name": "Plain"},
        ]}], "routable_providers": [], "failures": []})
    server._MODELS_CACHE.clear()
    r = server._dsh_plugin_models("dsh-plugin:/x")
    assert r["default"] == "deepseek-official/deepseek-flash"
    first, second = r["models"]
    assert first["name"] == "deepseek-official/deepseek-flash"
    assert [e["id"] for e in first["efforts"]] == ["off", "low", "max"]   # ultra 被白名单挡掉
    assert first["default_effort"] == "max"
    assert second["efforts"] == [] and second["default_effort"] == ""
    server._MODELS_CACHE.clear()


# ---------- B. 隔离实例（真实 server.py + 假 driver） ----------

def test_project_api_roundtrip_and_validation(isolated_server):
    """项目端点：两个新字段回显/更新；非法档位或权限档 400（不静默丢弃）。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "defaults-api", reasoning_effort="high",
                             permission_mode="manual")
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert code == 200, d
    assert d["reasoning_effort"] == "high" and d["permission_mode"] == "manual"
    # PATCH：只带 permission_mode 时思考等级保持存量
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"permission_mode": "yolo"})
    assert code == 200, d
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert d["reasoning_effort"] == "high" and d["permission_mode"] == "yolo"
    # 非法值：400（不是静默丢弃）
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"reasoning_effort": "ultra"})
    assert code == 400 and "非法" in d["error"]
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"permission_mode": "read-only"})
    assert code == 400 and "非法" in d["error"]
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert d["reasoning_effort"] == "high" and d["permission_mode"] == "yolo"   # 未被改坏


def test_agents_models_expose_efforts(isolated_server):
    """模型下拉数据源带上档位：flash 六档 + 默认 max；v4-pro 两档。"""
    srv = isolated_server
    code, d = srv.admin.json("/api/agents/models?agent_path="
                             + srv.agent_path)
    assert code == 200, d
    by = {m["name"]: m for m in d["models"]}
    flash = by["deepseek-official/deepseek-flash"]
    assert [e["id"] for e in flash["efforts"]] == ["minimal", "low", "medium", "high",
                                                   "xhigh", "max"]
    assert flash["default_effort"] == "max"
    assert [e["id"] for e in by["deepseek-official/deepseek-v4-pro"]["efforts"]] == ["low", "high"]


def _sid_of(srv, task):
    """从假 driver 标记里取某平台对象（card-<id>/task-<id>）的会话 id（取最新一条）。"""
    for row in reversed(_calls(srv, "/session")):
        if row.get("task") == task and row.get("sid"):
            return row["sid"]
    return ""


def _wait_session(srv, task, timeout=60):
    """等某平台对象的会话起来且已投出首轮 prompt，返回 sid。"""
    assert srv.wait_until(lambda: bool(_sid_of(srv, task)), timeout=timeout), \
        f"{task} 会话未起"
    sid = _sid_of(srv, task)
    assert srv.wait_until(
        lambda: any(r.get("sid") == sid for r in _calls(srv, "/prompt")), timeout=timeout), \
        f"{task} 首轮 prompt 未投出"
    return sid


def _start_card(srv, pid, title):
    """建卡 + 起会话，返回 (card_id, sid)；等驱动真收到该卡会话的首轮 prompt。

    注意标记文件是**模块级共享**的（同一个隔离实例），故按 `/session` 行的
    `task=card-<id>` 定位本次卡片的会话——不能取「第一条/最后一条 prompt」。
    """
    code, d = srv.admin.json(f"/api/projects/{pid}/board/cards", "POST",
                             {"title": title, "description": "默认值下发验证"})
    assert code == 200, d
    cid = d["id"]
    code, d = srv.admin.json(f"/api/projects/{pid}/board/cards/{cid}/start", "POST", {})
    assert code == 200, d
    return cid, _wait_session(srv, f"card-{cid}")


def _calls(srv, call, sid=""):
    """从假 driver 标记里取某类调用（可按 sid 过滤）。"""
    rows = []
    for line in srv.call_mark().splitlines():
        if not line.startswith("CALL "):
            continue
        row = json.loads(line[5:])
        if row.get("call") == call and (not sid or row.get("sid") == sid):
            rows.append(row)
    return rows


def test_board_card_start_applies_project_defaults(isolated_server):
    """看板卡起会话：项目默认思考等级 + 权限档下发到驱动（effort 走 /model、
    权限走 /permission，且三档 mode 一并下传供会话窗回显）。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "defaults-board",
                             model="deepseek-official/deepseek-flash",
                             reasoning_effort="high", permission_mode="manual")
    cid, sid = _start_card(srv, pid, "[e2e] 默认值下发")
    # /model（起会话路径传裸 id + provider 分开）：reasoning_effort=high
    models = _calls(srv, "/model", sid)
    assert models, "起会话未下发思考等级"
    assert models[-1]["reasoning_effort"] == "high"
    assert models[-1]["model"] == "deepseek-flash" and models[-1]["provider"] == "deepseek-official"
    # /permission：manual → workspace-write，mode=manual
    perms = _calls(srv, "/permission", sid)
    assert perms and perms[-1]["preset"] == "workspace-write" and perms[-1]["mode"] == "manual"
    # 会话 meta 回读（driver/model 帧 → dshevents）与卡片运行的日志行
    code, d = srv.admin.json(f"/api/projects/{pid}/board/session/messages?sid={sid}")
    assert code == 200 and d["sessionEffort"] == "high"
    assert d["permission"] == "manual"
    log = open(_board_log(srv, cid), encoding="utf-8", errors="replace").read()
    assert "会话默认值 effort=high permission=manual" in log


def _board_log(srv, cid):
    """看板会话日志路径（<工作目录>/.web/board_<cid>_*.log，取最新）。"""
    import glob
    import os
    hits = sorted(glob.glob(os.path.join(srv.work_dir, ".web", f"board_{cid}_*.log")))
    assert hits, f"未找到卡片会话日志: {cid}"
    return hits[-1]


def test_board_session_profile_reasoning_effort(isolated_server):
    """会话窗「思考等级」：只改等级（model 留空）也要下发；非法值 400。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "defaults-effort")
    cid, sid = _start_card(srv, pid, "[e2e] 会话级思考等级")
    code, d = srv.admin.json(
        f"/api/projects/{pid}/board/sessions/{sid}/profile", "POST",
        {"reasoning_effort": "low"})
    assert code == 200, d
    rows = _calls(srv, "/model", sid)
    assert rows and rows[-1]["reasoning_effort"] == "low"
    assert rows[-1]["model"] == ""            # 只改等级：不重设模型
    code, d = srv.admin.json(
        f"/api/projects/{pid}/board/sessions/{sid}/profile", "POST",
        {"reasoning_effort": "ultra"})
    assert code == 400 and "思考等级非法" in d["error"]
    code, d = srv.admin.json(
        f"/api/projects/{pid}/board/sessions/{sid}/profile", "POST", {})
    assert code == 400                                 # 三者皆空仍拒绝


def test_task_round_applies_effort_not_permission(isolated_server):
    """任务会话：起轮按项目默认下发思考等级；权限档不下发（无审批作答面）；
    任务 session profile 端点只收 reasoning_effort。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "defaults-task", reasoning_effort="medium",
                             permission_mode="manual")
    code, d = srv.admin.json(f"/api/projects/{pid}/tasks", "POST",
                             {"name": "默认值任务", "task_type": "normal",
                              "stop_type": "rounds", "stop_value": "1"})
    assert code == 200, d
    tid = d["id"]
    sid = _wait_session(srv, f"task-{tid}", timeout=90)
    models = _calls(srv, "/model", sid)
    assert models and models[-1]["reasoning_effort"] == "medium"
    assert not _calls(srv, "/permission", sid), "任务会话不应下发权限档"
    # 会话窗改思考等级（任务侧端点）
    code, d = srv.admin.json(f"/api/tasks/{tid}/session/profile", "POST",
                             {"reasoning_effort": "xhigh"})
    assert code == 200, d
    assert _calls(srv, "/model", sid)[-1]["reasoning_effort"] == "xhigh"
    code, d = srv.admin.json(f"/api/tasks/{tid}/session/profile", "POST",
                             {"reasoning_effort": "ultra"})
    assert code == 400 and "思考等级非法" in d["error"]
    # 任务会话不支持模型/权限档（显式拒绝，不静默）
    code, d = srv.admin.json(f"/api/tasks/{tid}/session/profile", "POST",
                             {"permission_mode": "manual"})
    assert code == 400 and "permission_mode" in d["error"]
    code, d = srv.admin.json(f"/api/tasks/{tid}/session/profile", "POST",
                             {"model": "deepseek-official/deepseek-flash"})
    assert code == 400 and "model" in d["error"]
