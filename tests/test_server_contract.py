#!/usr/bin/env python3
"""server 端点契约测试（2026-09-13 批次）：鉴权链 / 项目 / 任务 / 看板 / 回收站 /
prefs / SSE，用隔离实例（真实 HTTP + 真实库）验证对外行为契约。

与 e2e 的分工：本层只断言端点行为（状态码、校验分支、响应字段），不追求
跨进程时序保真（那由 tests/e2e_*.py 承担）。依赖 tests/serverfixture.py。

运行: python -m pytest tests/test_server_contract.py -v
"""
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest

from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入


@pytest.fixture(scope="module")
def srv(isolated_server):
    """隔离实例 + 一个基础项目（多数用例复用它）。"""
    isolated_server.pid = isolated_server.create_project(
        isolated_server.admin, "契约项目")
    return isolated_server


# ---------- 鉴权链 ----------

def test_anonymous_protected_endpoints_401(srv):
    """未登录访问受保护端点一律 401（端点族抽查）。"""
    anon = srv.client()
    for path in ("/api/projects", f"/api/projects/{srv.pid}",
                 f"/api/projects/{srv.pid}/board", "/api/admin/users"):
        code, _d = anon.json(path)
        assert code == 401, f"{path} 应 401，实际 {code}"


def test_login_wrong_password_401(srv):
    """错误密码登录 401（与未登录同码；错误信息不区分用户存在性）。"""
    anon = srv.client()
    code, d = anon.json("/api/auth/login", "POST",
                        {"username": "admin", "password": "wrong-pass"})
    assert code == 401 and "error" in d


def test_login_logout_cycle(srv):
    """登录 → 访问 200 → 登出 → 再访问 401（会话 cookie 失效）。"""
    api = srv.login("admin", srv.admin_pw)
    code, _d = api.json("/api/projects")
    assert code == 200
    code, _d = api.json("/api/auth/logout", "POST", {})
    assert code == 200
    code, _d = api.json("/api/projects")
    assert code == 401


def test_admin_only_endpoint_layering(srv):
    """admin 端点权限分层：普通用户 403，admin 200（先鉴权后权限）。"""
    srv.create_user("carol", "carol123")
    carol = srv.login("carol", "carol123")
    code, _d = carol.json("/api/admin/users")
    assert code == 403
    code, rows = srv.admin.json("/api/admin/users")
    assert code == 200 and any(u["username"] == "admin" for u in rows)


def test_create_user_and_login_as_new_user(srv):
    """admin 建用户 → 新用户可登录并只能看到自己的空项目列表。"""
    uid = srv.create_user("dave", "dave1234")
    assert isinstance(uid, int)
    dave = srv.login("dave", "dave1234")
    code, rows = dave.json("/api/projects")
    assert code == 200 and rows == []
    # 重名再建 → 400
    code, _d = srv.admin.json("/api/admin/users", "POST",
                              {"username": "dave", "password": "dave1234"})
    assert code == 400


# ---------- 项目生命周期 ----------

def test_project_crud_flow(srv):
    """项目：建 → 列表含 → 详情 → 改名生效。"""
    code, d = srv.admin.json("/api/projects", "POST",
                             {"name": "CRUD 项目", "project_dir": srv.proj_dir,
                              "agent_path": srv.agent_path, "work_dir": srv.work_dir})
    assert code == 200
    pid = d["id"]
    code, rows = srv.admin.json("/api/projects")
    assert code == 200 and any(p["id"] == pid for p in rows)
    code, p = srv.admin.json(f"/api/projects/{pid}")
    assert code == 200 and p["name"] == "CRUD 项目"
    code, p = srv.admin.json(f"/api/projects/{pid}", "PATCH", {"name": "改名后"})
    assert code == 200
    code, p = srv.admin.json(f"/api/projects/{pid}")
    assert p["name"] == "改名后"


def test_project_delete_needs_archive_and_confirm(srv):
    """删除双保险：未归档 400 → 归档 → confirm_name 不符 400 → 相符 200 可删。"""
    code, d = srv.admin.json("/api/projects", "POST",
                             {"name": "待删项目", "project_dir": srv.proj_dir,
                              "agent_path": srv.agent_path, "work_dir": srv.work_dir})
    pid = d["id"]
    code, _d = srv.admin.json(f"/api/projects/{pid}", "DELETE",
                              {"confirm_name": "待删项目"})
    assert code == 400, "未归档项目不应可删"
    code, _d = srv.admin.json(f"/api/projects/{pid}/archive", "POST", {})
    assert code == 200
    code, _d = srv.admin.json(f"/api/projects/{pid}", "DELETE",
                              {"confirm_name": "名字不对"})
    assert code == 400
    code, _d = srv.admin.json(f"/api/projects/{pid}", "DELETE",
                              {"confirm_name": "待删项目"})
    assert code == 200
    code, _d = srv.admin.json(f"/api/projects/{pid}")
    assert code == 404


def test_project_archive_and_unarchive(srv):
    """归档/恢复：POST archive → unarchive 均 200。"""
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/archive", "POST", {})
    assert code == 200
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/unarchive", "POST", {})
    assert code == 200


# ---------- 任务创建校验与生命周期 ----------

def _create_task(srv, body):
    return srv.admin.json(f"/api/projects/{srv.pid}/tasks", "POST", body)


def test_task_create_and_list(srv):
    """建任务成功路径：200 + 列表/详情可见。"""
    code, d = _create_task(srv, {"name": "契约任务", "task_type": "normal",
                                 "stop_type": "rounds", "stop_value": "1"})
    assert code == 200, d
    code, rows = srv.admin.json(f"/api/projects/{srv.pid}/tasks")
    assert code == 200 and any(t["id"] == d["id"] for t in rows)


@pytest.mark.parametrize("name,body", [
    ("task_type 非法", {"name": "x", "task_type": "nope"}),
    ("pipeline 禁止手建", {"name": "x", "task_type": "pipeline"}),
    ("regression 缺重跑指令", {"name": "x", "task_type": "regression"}),
    ("fix 缺 bug 报告", {"name": "x", "task_type": "fix"}),
    ("日期范围非法", {"name": "x", "task_type": "normal",
                      "date_from": "2026/09/01"}),
], ids=["bad-type", "pipeline", "regression-no-extra", "fix-no-bugdir",
        "bad-date"])
def test_task_create_validation_400(srv, name, body):
    """建任务校验分支一律 400（不落库）。"""
    code, d = _create_task(srv, body)
    assert code == 400, f"{name} 应 400，实际 {code} {d}"


def test_retest_bug_with_date_range_ok(srv):
    """复测任务带日期范围（无 bug 报告）可建：LLM 判影响面路径。"""
    code, d = _create_task(srv, {"name": "范围复测", "task_type": "retest_bug",
                                 "date_from": "2026-09-01", "date_to": "2026-09-10",
                                 "retest_scope": "retest_only"})
    assert code == 200, d


def test_pipeline_task_autocreated_for_late_end_stage(srv):
    """探索终点在「生成报告」之后：创建接口自动连带 pipeline 后段任务；终点=report 不连带。"""
    code, d = _create_task(srv, {"name": "带后段探索", "task_type": "normal",
                                 "stop_type": "rounds", "stop_value": "1",
                                 "end_stage": "fix"})
    assert code == 200, d
    assert d.get("pipeline_id"), "end_stage=fix 应连带创建后段任务"
    code, t = srv.admin.json(f"/api/tasks/{d['pipeline_id']}")
    assert code == 200 and t.get("task_type") == "pipeline"
    code, d2 = _create_task(srv, {"name": "普通探索", "task_type": "normal",
                                  "stop_type": "rounds", "stop_value": "1",
                                  "end_stage": "report"})
    assert code == 200 and d2.get("pipeline_id") is None


def test_task_stop(srv):
    """停任务：200 且终态落 stopped/done（不悬挂在 running）。"""
    code, d = _create_task(srv, {"name": "待停任务", "task_type": "normal",
                                 "stop_type": "rounds", "stop_value": "6"})
    assert code == 200
    tid = d["id"]
    code, _d = srv.admin.json(f"/api/tasks/{tid}/stop", "POST", {})
    assert code == 200
    ok = srv.wait_until(
        lambda: srv.admin.json(f"/api/tasks/{tid}")[1].get("status")
        in ("stopped", "done"), timeout=30)
    assert ok, srv.admin.json(f"/api/tasks/{tid}")[1]


def test_task_restart_gate(srv):
    """restart 状态门禁（评审 F2）：running/queued 重启 → 400（防 starting 行
    （claimed 已被 starting 吸收，v2a T1）被 enqueue 幂等复用、旧跑 finally
    落 done 后任务 queued 无行的幽灵）；停止后重启 → 照常 200。"""
    code, d = _create_task(srv, {"name": "重启门禁任务", "task_type": "normal",
                                 "stop_type": "rounds", "stop_value": "50"})
    assert code == 200
    tid = d["id"]
    ok = srv.wait_until(
        lambda: srv.admin.json(f"/api/tasks/{tid}")[1].get("status") == "running",
        timeout=30)
    assert ok, srv.admin.json(f"/api/tasks/{tid}")[1]
    code, d2 = srv.admin.json(f"/api/tasks/{tid}/restart", "POST", {})
    assert code == 400 and "请先停止" in d2.get("error", ""), (code, d2)
    code, _d = srv.admin.json(f"/api/tasks/{tid}/stop", "POST", {})
    assert code == 200
    ok = srv.wait_until(
        lambda: srv.admin.json(f"/api/tasks/{tid}")[1].get("status") == "stopped",
        timeout=30)
    assert ok, srv.admin.json(f"/api/tasks/{tid}")[1]
    code, _d = srv.admin.json(f"/api/tasks/{tid}/restart", "POST", {})
    assert code == 200


# ---------- 看板卡片与回收站 ----------

def test_board_card_crud(srv):
    """卡片：建（200 含 id）→ 看板可见 → 改标题生效 → 空标题 400。"""
    code, d = srv.admin.json(f"/api/projects/{srv.pid}/board/cards", "POST",
                             {"title": "契约卡"})
    assert code == 200 and isinstance(d.get("id"), int)
    cid = d["id"]
    code, bd = srv.admin.json(f"/api/projects/{srv.pid}/board")
    assert code == 200 and any(c["id"] == cid for c in bd.get("cards", []))
    code, c = srv.admin.json(f"/api/projects/{srv.pid}/board/cards/{cid}", "PATCH",
                             {"title": "改过的卡"})
    assert code == 200 and c.get("title") == "改过的卡"
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/board/cards/{cid}", "PATCH",
                              {"title": "   "})
    assert code == 400


def test_board_trash_flow(srv):
    """回收站全流程：软删 → 看板不可见/回收站可见 → 还原 → 彻底删除。"""
    code, d = srv.admin.json(f"/api/projects/{srv.pid}/board/cards", "POST",
                             {"title": "回收站卡"})
    cid = d["id"]
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/board/cards/{cid}", "DELETE")
    assert code == 200
    code, bd = srv.admin.json(f"/api/projects/{srv.pid}/board")
    assert all(c["id"] != cid for c in bd.get("cards", []))
    code, tr = srv.admin.json(f"/api/projects/{srv.pid}/board/trash")
    assert code == 200 and any(c["id"] == cid for c in tr.get("cards", []))
    code, _d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/trash/{cid}/restore", "POST", {})
    assert code == 200
    code, bd = srv.admin.json(f"/api/projects/{srv.pid}/board")
    assert any(c["id"] == cid for c in bd.get("cards", []))
    # 未删除的卡不允许 restore / purge（400）
    code, _d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/trash/{cid}/restore", "POST", {})
    assert code == 400
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/board/trash/{cid}", "DELETE")
    assert code == 400


def test_board_media_upload_and_get(srv):
    """卡片附件：base64 上传 → fid 读取回原字节；坏 fid/坏 base64/空文件 400。"""
    import base64
    payload = base64.b64encode(b"hello-media").decode()
    code, d = srv.admin.json(f"/api/projects/{srv.pid}/board/media", "POST",
                             {"name": "t.txt", "mime": "text/plain", "data": payload})
    assert code == 200 and d.get("fid"), d
    fid = d["fid"]
    # 复用登录 cookie 读取（匿名读同一 URL 应 401）
    req = urllib.request.Request(f"{srv.base}/api/projects/{srv.pid}/board/media/{fid}")
    with srv.admin.opener.open(req, timeout=10) as r:
        assert r.status == 200 and r.read() == b"hello-media"
    anon = srv.client()
    code, _d = anon(f"/api/projects/{srv.pid}/board/media/{fid}")
    assert code == 401
    # 坏 fid 格式 → 400（防路径穿越白名单：只放行 m<ms>_<hex10>.<ext>）
    code, _d = srv.admin(f"/api/projects/{srv.pid}/board/media/not-a-fid.png")
    assert code == 400
    # 坏 base64 / 空文件 → 400
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/board/media", "POST",
                              {"name": "x", "data": "!!not-base64!!"})
    assert code == 400
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/board/media", "POST",
                              {"name": "x", "data": ""})
    assert code == 400


def test_board_session_media_route(srv):
    """看板卡片会话图片端点（board 会话窗无 taskId，图片此前恒为 [图片] 占位）：
    匿名 401；缺 sid 400；sid 不归属本项目任一卡片 → 404 session not found；
    归属卡片 + 不可解析 media id → 404 media not found（区分于路由缺失的
    裸 not found）。图片字节解析由 sessparse 单测覆盖（resolve_media）。"""
    import urllib.parse
    wpid = srv.create_project(srv.admin, "会话图契约项目",
                              agent_path="dsh-plugin:" + srv.agent_path)
    code, c = srv.admin.json(f"/api/projects/{wpid}/board/cards", "POST",
                             {"title": "会话图卡"})
    assert code == 200 and c.get("id")
    cid = c["id"]
    sid = "session_11111111-2222-3333-4444-555555555555"
    code, _d = srv.admin.json(f"/api/projects/{wpid}/board/cards/{cid}", "PATCH",
                              {"bind_session": sid})
    assert code == 200
    base = f"/api/projects/{wpid}/board/session/media/f_bogus"
    # 归属卡片 + 坏 media id：路由可达、resolve 落空
    code, d = srv.admin.json(f"{base}?sid={urllib.parse.quote(sid)}&agent=main")
    assert code == 404 and d.get("error") == "media not found", d
    # sid 不归属本项目 → 会话不存在（防跨项目读任意会话）
    code, d = srv.admin.json(
        f"{base}?sid=session_99999999-3333-3333-3333-333333333333&agent=main")
    assert code == 404 and d.get("error") == "session not found"
    # 缺 sid → 400；匿名 → 401
    code, _d = srv.admin.json(base)
    assert code == 400
    anon = srv.client()
    code, _d = anon(f"{base}?sid={sid}&agent=main")
    assert code == 401


# ---------- user prefs ----------

def test_session_inject_route_and_validation(srv):
    """平台排队消息「立即注入」端点（board/task 两路）：会话归属不符 404、
    任务尚无会话 409（族门禁 400 由单测 test_msg_inject 覆盖；成功路径需真实
    dsh 宿主会话，由单测与真机走查覆盖）。"""
    # dsh-plugin 前缀项目：会话不属于本项目任一卡片 → 404（不触达注入执行体）
    wpid = srv.create_project(srv.admin, "注入契约项目",
                              agent_path="dsh-plugin:" + srv.agent_path)
    code, _d = srv.admin.json(
        f"/api/projects/{wpid}/board/sessions/s-bogus/inject", "POST", {"msg_id": "m1"})
    assert code == 404
    # 任务路：任务不存在 404；任务尚无会话（首轮未跑）409
    code, _d = srv.admin.json("/api/tasks/999999/session/chat/inject", "POST",
                              {"msg_id": "m1"})
    assert code == 404
    code, t = srv.admin.json(f"/api/projects/{wpid}/tasks", "POST",
                             {"name": "注入契约任务", "task_type": "normal",
                              "stop_type": "rounds", "stop_value": "1"})
    assert code == 200, t
    # 「尚无会话」这一前置要确定成立：任务创建后 runner 可能已在跑首轮，轮末会写入
    # session_id（原实现靠「创建后立刻请求」抢时间窗，满载下会闪断）。故先等任务到终态
    # （不再有写 session_id 的路径），再清空该列，断言才是稳定的。
    assert srv.wait_until(
        lambda: srv.admin.json(f"/api/tasks/{t['id']}")[1].get("status")
        not in ("running", "queued"), timeout=60), "任务未收敛到终态"
    conn = sqlite3.connect(srv.db_path)
    try:
        conn.execute("UPDATE tasks SET session_id='' WHERE id=?", (t["id"],))
        conn.commit()
    finally:
        conn.close()
    code, d = srv.admin.json(f"/api/tasks/{t['id']}/session/chat/inject", "POST",
                             {"msg_id": "m1"})
    assert code == 409 and "会话尚未生成" in d["error"]


def test_board_deliver_answer_route(srv):
    """「立即送达」端点（作答待送达）：无待送达答案时 400（路由/鉴权/归属校验链），
    成功路径由单测与真机走查覆盖（需真实 kimi web 提问）。"""
    code, c = srv.admin.json(f"/api/projects/{srv.pid}/board/cards", "POST",
                             {"title": "送达契约卡"})
    assert code == 200, c
    code, d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/cards/{c['id']}/answer/deliver", "POST", {})
    assert code == 400 and "待送达" in d["error"]
    code, _d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/cards/999999/answer/deliver", "POST", {})
    assert code == 404                       # 卡片不存在/不属本项目


def test_session_rewind_route_and_validation(srv):
    """会话回退端点（board/task 两路）：会话归属 404、提问不在会话 409；
    已退场族（存量 kimi-web 前缀项目）→ 400「该 agent 族不支持会话回退」
    （P7b-B3 删掉 kimi 原地 undo 路径后，回退只剩 dsh 的按边界 fork）。
    成功路径需真机会话，由单测与真机走查覆盖）。"""
    # dsh 项目：会话已归属某卡片（过归属校验）→ 该提问在本会话里对不上 → 409
    code, c = srv.admin.json(f"/api/projects/{srv.pid}/board/cards", "POST",
                             {"title": "回退契约卡"})
    assert code == 200, c
    code, _d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/cards/{c['id']}", "PATCH",
        {"bind_session": "s-local"})
    assert code == 200
    code, d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/sessions/s-local/rewind", "POST", {"mid": "m1"})
    assert code == 409 and "刷新后重试" in d["error"]
    # 已退场族项目：会话不属于本项目任一卡片 → 404（不触达回退执行体）
    wpid = srv.create_project(srv.admin, "回退契约项目",
                              agent_path="kimi-web:" + srv.agent_path)
    code, _d = srv.admin.json(
        f"/api/projects/{wpid}/board/sessions/s-bogus/rewind", "POST", {"mid": "m1"})
    assert code == 404
    # 会话归属卡片但族已下线 → 400（不再有 kimi 原地 undo 回退路径）
    code, c2 = srv.admin.json(f"/api/projects/{wpid}/board/cards", "POST",
                              {"title": "回退契约卡二"})
    assert code == 200, c2
    code, _d = srv.admin.json(
        f"/api/projects/{wpid}/board/cards/{c2['id']}", "PATCH",
        {"bind_session": "s-bogus"})
    assert code == 200
    code, d = srv.admin.json(
        f"/api/projects/{wpid}/board/sessions/s-bogus/rewind", "POST", {"mid": "m1"})
    assert code == 400 and "不支持会话回退" in d["error"]
    # 任务路：任务不存在 404；任务尚无会话（首轮未跑）409
    code, _d = srv.admin.json("/api/tasks/999999/session/rewind", "POST", {"mid": "m1"})
    assert code == 404
    code, t = srv.admin.json(f"/api/projects/{wpid}/tasks", "POST",
                             {"name": "回退契约任务", "task_type": "normal",
                              "stop_type": "rounds", "stop_value": "1"})
    assert code == 200, t
    code, d = srv.admin.json(f"/api/tasks/{t['id']}/session/rewind", "POST",
                             {"mid": "m1"})
    assert code == 409 and "会话尚未生成" in d["error"]


def test_retired_agent_endpoints_gone(srv):
    """P7b-B3 退场的端点一律 404（前端调用点同批删除）：
    `/api/admin/agent-cfg`（Kimi web 实例参数）与其 restart、`/api/cli/default_model`
    （kimi CLI 模型注册表回读）、board/task 两路 `/steer`（kimi 服务端队列 prompt 注入）。
    """
    code, _d = srv.admin.json("/api/admin/agent-cfg")
    assert code == 404
    code, _d = srv.admin.json("/api/admin/agent-cfg", "PATCH",
                              {"agent": "kimi_web", "clear": True})
    assert code == 404
    code, _d = srv.admin.json("/api/admin/agent-cfg/restart", "POST",
                              {"agent": "kimi_web"})
    assert code == 404
    code, _d = srv.admin.json("/api/cli/default_model")
    assert code == 404
    code, _d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/sessions/s-x/steer", "POST", {"prompt_id": "p1"})
    assert code == 404
    code, _d = srv.admin.json("/api/tasks/1/session/chat/steer", "POST",
                              {"prompt_id": "p1"})
    assert code == 404
    # 平台统一队列「立即注入」端点保留（dsh 用它）
    code, _d = srv.admin.json(
        f"/api/projects/{srv.pid}/board/sessions/s-x/inject", "POST", {"msg_id": "m1"})
    assert code in (404, 502) and code != 405


def test_prefs_roundtrip(srv):
    """UI 偏好：默认空对象 → 写入 → 回读一致（按 用户+项目 维度）。"""
    code, d = srv.admin.json(f"/api/prefs?project_id={srv.pid}")
    assert code == 200 and d.get("prefs") == {}
    code, _d = srv.admin.json("/api/prefs", "POST",
                              {"project_id": srv.pid, "key": "tabs_test",
                               "value": {"order": ["a", "b"], "hidden": []}})
    assert code == 200
    code, d = srv.admin.json(f"/api/prefs?project_id={srv.pid}")
    assert code == 200 and d["prefs"]["tabs_test"] == {"order": ["a", "b"],
                                                       "hidden": []}


# ---------- SSE ----------

def test_sse_stream_first_event(srv):
    """SSE /api/stream：登录后建连即得 text/event-stream 与首个 data 事件。"""
    req = urllib.request.Request(
        f"{srv.base}/api/stream?project_id={srv.pid}")
    with srv.admin.opener.open(req, timeout=10) as r:
        assert r.status == 200
        assert "text/event-stream" in r.headers.get("Content-Type", "")
        line = r.readline().decode("utf-8", errors="replace")
        assert line.startswith("data: "), f"首事件非 data 行: {line!r}"
    # 匿名建连 → 401（鉴权先于流建立）
    anon = srv.client()
    code, _d = anon(f"/api/stream?project_id={srv.pid}")
    assert code == 401
