#!/usr/bin/env python3
"""项目级会话默认值（思考等级 / 权限档）单测 + 隔离实例端到端（2026-10-04 批次）。

2026-10-21（权限档对齐 DSH 宿主目录）后：`permission_mode` 的值域＝宿主 preset catalog
（read-only / workspace-write / danger-full-access / path-rules / write-guard / auto …），
旧三档 manual/yolo 只作 API 兼容别名、旧库数据由 §4 迁移归一。

覆盖：
A. 纯单测（零外部依赖）
  1. projects 表新列（reasoning_effort / permission_mode）：建表/迁移/读写回路；
  2. 旧三档值数据迁移（manual/yolo/auto → preset key，幂等）；
  3. 取值归一 server.normalize_permission_mode（别名/目录值/existing 直通/非法回 None）；
  4. dshdriver.apply_session_defaults：preset 直达（**不带 mode**）、思考等级下发、
     **best-effort**（驱动异常/空白值都不抛，只回告警文本）；
  5. dshevents.session_effort / session_permission_mode 读口（preset 优先、旧 mode 兜底）；
  6. server._dsh_plugin_models 透传模型目录的 efforts / default_effort（老插件缺字段时为空）。
B. 隔离实例（真实 server.py + 假 driver；见 tests/serverfixture.py）
  7. 项目端点回显与校验（manual→canonical 落库、目录档直存、非法 400、PATCH 保持存量）；
  8. GET /api/agents/presets（宿主目录两态与标签/default_label 映射）；
  9. /api/agents/models 带上每个模型的档位与默认档；
 10. 看板卡起会话：项目默认（思考等级 + 权限档）**真的下发到驱动**（假 driver 记到
     `/model` 带 reasoning_effort、`/permission` 带 preset 且不带 mode）；
 11. 会话窗「思考等级」：卡片 profile 端点只改等级也能下发（model 留空）；会话 meta
     回读 sessionEffort（driver/model 状态帧 → dshevents）；
 12. 会话窗「权限」：接受宿主目录档、manual canonical、未知档 400 文案、meta 回显 preset；
 13. 任务会话：起轮按项目默认下发思考等级，**不下发权限档**（任务侧无审批作答面）；
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
    """建项目带两个新列 → get_project 回读 → update 改写（含清空回默认）。

    2026-10-21 起 permission_mode 存宿主 preset key（旧 manual/yolo 由 API 层别名
    与数据迁移归一，DB 层不再出现三档旧值）。
    """
    pid = db.insert_project(1, "pt-defaults-rt", "/tmp/pt-rt", "dsh-plugin:/tmp/dsh",
                            "/tmp/pt-rt/.touchstone",
                            reasoning_effort="high", permission_mode="workspace-write")
    row = db.get_project(pid)
    assert row["reasoning_effort"] == "high"
    assert row["permission_mode"] == "workspace-write"
    db.update_project(pid, "pt-defaults-rt", "/tmp/pt-rt", "dsh-plugin:/tmp/dsh",
                      "/tmp/pt-rt/.touchstone",
                      reasoning_effort="", permission_mode="danger-full-access")
    row = db.get_project(pid)
    assert row["reasoning_effort"] == "" and row["permission_mode"] == "danger-full-access"


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
                      reasoning_effort="low", permission_mode="danger-full-access")
    assert db.get_project(row["id"])["permission_mode"] == "danger-full-access"
    with db.connect() as c2:
        c2.execute("DELETE FROM projects WHERE name='legacy'")


def test_permission_mode_migration_normalizes_legacy_values():
    """§4 数据迁移：旧三档 manual/yolo/auto 在迁移入口执行后归一为宿主 preset key
    （manual→workspace-write、yolo/auto→danger-full-access），且重复跑幂等。"""
    # 迁移步骤必须存在于声明式清单（Lead 负责 db.py；缺了这里先红，防静默漏做）
    assert "2026-10-21_projects_permission_mode_presets" in [s["id"] for s in db.MIGRATIONS]
    cases = [("mig-manual", "manual", "workspace-write"),
             ("mig-yolo", "yolo", "danger-full-access"),
             ("mig-auto", "auto", "danger-full-access"),
             ("mig-preset", "path-rules", "path-rules")]   # 新档值原样（迁移不误伤）
    pids = {}
    for name, mode, _want in cases:
        with db.connect() as conn:
            conn.execute("DELETE FROM projects WHERE name=?", (name,))
        pids[name] = db.insert_project(1, name, "/tmp/mig-perm", "dsh-plugin:/tmp/dsh",
                                       "/tmp/mig-perm/.ts",
                                       reasoning_effort="", permission_mode=mode)
    try:
        db.init_db()                                  # 迁移入口（幂等：init_db 可重复跑）
        for name, _mode, want in cases:
            assert db.get_project(pids[name])["permission_mode"] == want, name
        # 再跑一次迁移清单：值不变（幂等；守卫不再命中时该步不执行）
        db.run_declared_migrations()
        for name, _mode, want in cases:
            assert db.get_project(pids[name])["permission_mode"] == want, name
    finally:
        with db.connect() as conn:
            conn.execute("DELETE FROM projects WHERE name LIKE 'mig-%'")


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


@pytest.mark.parametrize("raw,existing,expected", [
    ("", "", ""), (None, "", ""), ("  ", "", ""),
    # 旧三档 API 兼容别名：manual→workspace-write、yolo→danger-full-access；
    # auto 不再走旧别名（只有宿主目录里确实有 auto 档时才被接受，见下）
    ("manual", "", "workspace-write"), ("manual", "manual", "workspace-write"),
    ("yolo", "", "danger-full-access"),
    # 内置三档产品档（从未取到宿主目录时也认——内置集合兜底）
    ("read-only", "", "read-only"),
    ("workspace-write", "", "workspace-write"),
    ("danger-full-access", "", "danger-full-access"),
    # auto 不在内置兜底集合里 ⇒ 目录未取到时判非法（§5.3 歧义裁决）
    ("auto", "", None),
    # 自定义档（path-rules 等）目录未取到 ⇒ 非法；但 PATCH 未变值（v == existing）直通，
    # 防止目录暂不可用把存量值判非法
    ("path-rules", "", None),
    ("path-rules", "path-rules", "path-rules"),
    ("write-guard", "write-guard", "write-guard"),
    # 拼写错误/未知值一律非法
    ("bogus", "", None), ("HIGH", "", None),
])
def test_normalize_permission_mode(raw, existing, expected):
    """§5.3 项目级 permission_mode 归一（目录未取到时按内置三档兜底 + existing 直通）。"""
    assert server.normalize_permission_mode(raw, existing) == expected


def test_normalize_permission_mode_uses_host_catalog(monkeypatch):
    """取到宿主目录后，目录里的自定义档（path-rules/write-guard/auto）全部可写；
    目录是唯一真源——不在目录里的值仍判非法。"""
    monkeypatch.setattr(server, "_PERMISSION_CATALOG_VALUES",
                        {"read-only", "workspace-write", "danger-full-access",
                         "path-rules", "write-guard", "auto"})
    for v in ("path-rules", "write-guard", "auto", "read-only"):
        assert server.normalize_permission_mode(v) == v
    assert server.normalize_permission_mode("bogus") is None


def test_apply_session_defaults_maps_and_calls(monkeypatch):
    """§5.6 权限档 → 宿主 preset 直达（**不再传 mode**）+ 思考等级下发。

    manual/yolo 是旧三档 API 兼容别名（映射到 preset），auto/path-rules 等新档值原样
    作为宿主 preset 下发；思考等级/模型/provider 透传不变。
    """
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
    assert ("perm", "sid-1", "workspace-write", None) in calls       # 不带 mode
    assert ("model", "sid-1", "m1", "p1", "high") in calls
    # auto 原样＝宿主 auto 档（不是旧三档 auto 语义）；path-rules 等自定义档直通
    calls.clear()
    dshdriver.apply_session_defaults("sid-1", permission_mode="auto")
    assert calls == [("perm", "sid-1", "auto", None)]
    calls.clear()
    dshdriver.apply_session_defaults("sid-1", permission_mode="path-rules")
    assert calls == [("perm", "sid-1", "path-rules", None)]
    calls.clear()
    dshdriver.apply_session_defaults("sid-1", permission_mode="yolo")
    assert calls == [("perm", "sid-1", "danger-full-access", None)]


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
    # 空白值：归一后为空 ⇒ 不调用驱动，只告警（本函数不做目录校验——非目录值只有到
    # set_permission 才会被驱动拒绝，见 §5.6）
    called = []
    monkeypatch.setattr(dshdriver, "set_permission",
                        lambda *a, **k: called.append(1))
    monkeypatch.setattr(dshdriver, "set_model", lambda *a, **k: called.append(1))
    warns = dshdriver.apply_session_defaults("sid-2", reasoning_effort="ultra",
                                             permission_mode="   ")
    assert called == [] and len(warns) == 2
    assert any("非法" in w for w in warns)
    # 全空：什么都不做、无告警
    assert dshdriver.apply_session_defaults("sid-2") == []


def test_dshevents_session_readers():
    """思考等级/权限档读口：model.reasoningEffort 直取；权限 **preset 优先**
    （宿主实况，任意档原样返回），旧 mode 只在缺 preset 时兜底映射。

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
        dshevents.HUB._sessions["s-legacy-mode"] = {
            "session_id": "s-legacy-mode", "model": {},
            "permission": {"mode": "manual", "preset": ""}}
        dshevents.HUB._sessions["s-empty"] = {"session_id": "s-empty"}
    try:
        assert dshevents.session_effort("s-eff") == "high"
        # preset 优先：同帧里的旧 mode=auto 不影响回显（宿主实况 danger-full-access）
        assert dshevents.session_permission_mode("s-eff") == "danger-full-access"
        assert dshevents.session_permission_mode("s-perm-only") == "workspace-write"
        # 旧插件旧帧只有 mode：展示兜底映射（只读，不是写入路径）
        assert dshevents.session_permission_mode("s-legacy-mode") == "workspace-write"
        assert dshevents.session_effort("s-perm-only") == ""
        assert dshevents.session_effort("s-empty") == ""
        assert dshevents.session_permission_mode("s-empty") == ""
        assert dshevents.session_effort("不存在") == ""
        assert dshevents.session_permission_mode("不存在") == ""
    finally:
        with dshevents.HUB._cond:
            for sid in ("s-eff", "s-perm-only", "s-legacy-mode", "s-empty"):
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
    """项目端点：两个新字段回显/更新；旧三档别名归一为宿主 preset key；目录里的
    自定义档可存；非法档位或权限档 400（不静默丢弃）。"""
    srv = isolated_server
    # 前端打开项目弹窗会先拉权限目录；这里先拉一次让服务端「已知档位值集合」就绪
    # （path-rules/auto 等自定义档必须来自宿主目录，§5.3）
    code, cat = srv.admin.json("/api/agents/presets")
    assert code == 200 and cat["available"], cat
    pid = srv.create_project(srv.admin, "defaults-api", reasoning_effort="high",
                             permission_mode="manual")
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert code == 200, d
    # 旧值 manual → canonical workspace-write（API 别名，§5.3）
    assert d["reasoning_effort"] == "high" and d["permission_mode"] == "workspace-write"
    # PATCH：只带 permission_mode 时思考等级保持存量；旧值 yolo → danger-full-access
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"permission_mode": "yolo"})
    assert code == 200, d
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert d["reasoning_effort"] == "high" and d["permission_mode"] == "danger-full-access"
    # 目录里的档位（含自定义档）直存
    for preset in ("read-only", "path-rules", "write-guard", "auto"):
        code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH",
                                 {"permission_mode": preset})
        assert code == 200, (preset, d)
        assert srv.admin.json(f"/api/projects/{pid}")[1]["permission_mode"] == preset
    # 非法值：400（不是静默丢弃）
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"reasoning_effort": "ultra"})
    assert code == 400 and "非法" in d["error"]
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"permission_mode": "bogus"})
    assert code == 400 and "非法" in d["error"]
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert d["reasoning_effort"] == "high" and d["permission_mode"] == "auto"  # 未被改坏
    # PATCH 不带 permission_mode ⇒ 保持存量
    code, d = srv.admin.json(f"/api/projects/{pid}", "PATCH",
                             {"reasoning_effort": "low"})
    assert code == 200, d
    code, d = srv.admin.json(f"/api/projects/{pid}")
    assert d["reasoning_effort"] == "low" and d["permission_mode"] == "auto"


def test_agents_presets_endpoint(isolated_server):
    """GET /api/agents/presets（§5.2）：登录即可读；选项/标签/描述/默认档全部来自
    宿主目录（内置档中文产品名、自定义档宿主 name/description、auto 产品名）。"""
    srv = isolated_server
    code, d = srv.admin.json("/api/agents/presets")
    assert code == 200, d
    assert d["available"] is True
    assert [o["value"] for o in d["options"]] == [
        "read-only", "workspace-write", "danger-full-access",
        "path-rules", "write-guard", "auto"]
    by = {o["value"]: o for o in d["options"]}
    assert by["read-only"]["label"] == "仅可查看"
    assert by["workspace-write"]["label"] == "工作区内修改"
    assert by["danger-full-access"]["label"] == "完全权限"
    assert by["path-rules"]["label"] == "路径规则"
    assert by["write-guard"]["label"] == "完全权限（拦截）"
    assert by["auto"]["label"] == "自动审查（实验）"
    assert d["default"] == "danger-full-access"
    assert d["default_label"] == "完全权限"


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
    """看板卡起会话（§5.6）：项目默认思考等级 + 权限档下发到驱动（effort 走 /model、
    权限走 /permission 的 **preset 直达、不带 mode**；旧 manual 已归一为 workspace-write）。"""
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
    # /permission：manual 归一为 workspace-write，且**不再随写下发旧 mode**
    perms = _calls(srv, "/permission", sid)
    assert perms and perms[-1]["preset"] == "workspace-write"
    assert perms[-1]["mode"] == ""
    # 会话 meta 回读 preset 实况（driver/permission 帧 → dshevents）与卡片运行的日志行
    code, d = srv.admin.json(f"/api/projects/{pid}/board/session/messages?sid={sid}")
    assert code == 200 and d["sessionEffort"] == "high"
    assert d["permission"] == "workspace-write"
    log = open(_board_log(srv, cid), encoding="utf-8", errors="replace").read()
    assert "会话默认值 effort=high permission=workspace-write" in log


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


def _meta_permission(srv, pid, sid):
    """会话 meta 的 `permission` 回显（读不到返回 None，供 wait_until 轮询）。"""
    code, d = srv.admin.json(f"/api/projects/{pid}/board/session/messages?sid={sid}")
    return d.get("permission") if code == 200 else None


def test_board_session_profile_permission_catalog(isolated_server):
    """会话窗「权限」（§5.4）：接受宿主目录里的档（含 path-rules 等自定义档）、
    manual/yolo 映射为 canonical preset 下发、回执 permission_mode=canonical、
    set_permission 不传 mode、meta 回显 preset；未知档 400 文案逐字一致。"""
    srv = isolated_server
    # 先拉目录：前端打开会话窗会拉（服务端「已知档位值集合」由此就绪）
    code, cat = srv.admin.json("/api/agents/presets")
    assert code == 200 and cat["available"], cat
    pid = srv.create_project(srv.admin, "defaults-perm")
    cid, sid = _start_card(srv, pid, "[e2e] 会话级权限档")
    url = f"/api/projects/{pid}/board/sessions/{sid}/profile"
    # 目录里的自定义档直通
    code, d = srv.admin.json(url, "POST", {"permission_mode": "path-rules"})
    assert code == 200, d
    assert d["permission_mode"] == "path-rules"
    perms = _calls(srv, "/permission", sid)
    assert perms[-1]["preset"] == "path-rules" and perms[-1]["mode"] == ""
    # 旧值 manual → canonical workspace-write（回执给真正下发的值，便于前端乐观回显）
    code, d = srv.admin.json(url, "POST", {"permission_mode": "manual"})
    assert code == 200 and d["permission_mode"] == "workspace-write"
    assert _calls(srv, "/permission", sid)[-1]["preset"] == "workspace-write"
    # auto 只有在宿主目录里确实有该档时才被接受（本机目录有）
    code, d = srv.admin.json(url, "POST", {"permission_mode": "auto"})
    assert code == 200 and d["permission_mode"] == "auto"
    # meta 回显 preset（driver/permission 帧 → dshevents 注册表）
    assert srv.wait_until(lambda: _meta_permission(srv, pid, sid) == "auto", timeout=10)
    # 未知档：400 + 逐字文案
    code, d = srv.admin.json(url, "POST", {"permission_mode": "bogus"})
    assert code == 400
    assert d["error"] == "权限档非法（宿主权限目录里没有该档位）"


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
