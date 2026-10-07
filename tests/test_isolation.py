#!/usr/bin/env python3
"""多用户隔离红线测试（越权防护，2026-09-13 批次）。

背景：AGENTS.md 把「所有按 project_id 进入的接口必须先过 _owned_project」列为
红线。本文件用隔离实例（真实 HTTP + 真实库 + 双用户）验证：非属主读写他人
资源一律 404、列表不泄露、越权写不落库，并以属主自身访问 200 反证接口完好。

依赖 tests/serverfixture.py（module 级隔离实例）。运行:
    python -m pytest tests/test_isolation.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest

from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入


@pytest.fixture(scope="module")
def env(isolated_server):
    """双用户 + 资源：alice 拥有项目/任务/卡片；bob 持自建项目（反证列表功能完好）。"""
    srv = isolated_server
    srv.create_user("alice", "alice123")
    srv.create_user("bob", "bob123456")
    alice = srv.login("alice", "alice123")
    bob = srv.login("bob", "bob123456")

    pid = srv.create_project(alice, "alice 的项目")
    code, t = alice.json(f"/api/projects/{pid}/tasks", "POST",
                         {"name": "alice 的任务", "task_type": "normal",
                          "stop_type": "rounds", "stop_value": "1"})
    assert code == 200, t
    tid = t["id"]
    code, c = alice.json(f"/api/projects/{pid}/board/cards", "POST",
                         {"title": "alice 的卡"})
    assert code == 200, c
    cid = c["id"]
    bob_proj_dir = srv.proj_dir + "-bob"
    os.makedirs(bob_proj_dir, exist_ok=True)
    bob_pid = srv.create_project(bob, "bob 的项目", project_dir=bob_proj_dir)
    return {"srv": srv, "alice": alice, "bob": bob, "pid": pid, "tid": tid,
            "cid": cid, "bob_pid": bob_pid}


# ---------- 越权读：一律 404 ----------

_CROSS_GET = [
    ("项目详情", "/api/projects/{pid}"),
    ("项目任务列表", "/api/projects/{pid}/tasks"),
    ("看板", "/api/projects/{pid}/board"),
    ("看板回收站", "/api/projects/{pid}/board/trash"),
    ("bug 列表", "/api/projects/{pid}/bugs"),
    ("项目媒体", "/api/projects/{pid}/board/media/nonexist.png"),
    ("任务详情", "/api/tasks/{tid}"),
    ("任务轮次", "/api/tasks/{tid}/rounds"),
    ("任务日志", "/api/tasks/{tid}/log"),
    ("任务会话消息", "/api/tasks/{tid}/session/messages"),
]


@pytest.mark.parametrize("name,route", _CROSS_GET, ids=[n for n, _ in _CROSS_GET])
def test_cross_user_read_404(env, name, route):
    """bob 读 alice 的资源一律 404（_owned_project / _owned_task 门槛）。"""
    code, _d = env["bob"](route.format(pid=env["pid"], tid=env["tid"]))
    assert code == 404, f"{name} 越权读应 404，实际 {code}"


# ---------- 越权写：一律 404 且无副作用 ----------

_CROSS_WRITE = [
    ("改项目名", "PATCH", "/api/projects/{pid}", {"name": "被改名"}),
    ("建任务", "POST", "/api/projects/{pid}/tasks",
     {"name": "越权任务", "task_type": "normal", "stop_type": "rounds",
      "stop_value": "1"}),
    ("停任务", "POST", "/api/tasks/{tid}/stop", {}),
    ("任务会话发消息", "POST", "/api/tasks/{tid}/session/chat", {"message": "越权消息"}),
    ("建卡片", "POST", "/api/projects/{pid}/board/cards", {"title": "越权卡"}),
    ("改卡片", "PATCH", "/api/projects/{pid}/board/cards/{cid}", {"title": "被改的卡"}),
    ("移卡片", "POST", "/api/projects/{pid}/board/cards/{cid}/move",
     {"column": "doing"}),
    ("卡片评论", "POST", "/api/projects/{pid}/board/cards/{cid}/comments",
     {"text": "越权评论"}),
    ("删卡片", "DELETE", "/api/projects/{pid}/board/cards/{cid}", None),
    ("删任务", "DELETE", "/api/tasks/{tid}", None),
]


@pytest.mark.parametrize("name,method,route,body", _CROSS_WRITE,
                         ids=[n for n, _, _, _ in _CROSS_WRITE])
def test_cross_user_write_404(env, name, method, route, body):
    """bob 写 alice 的资源一律 404（越权写不落库）。"""
    code, _d = env["bob"](
        route.format(pid=env["pid"], tid=env["tid"], cid=env["cid"]), method, body)
    assert code == 404, f"{name} 越权写应 404，实际 {code}"


def test_write_attempts_left_no_side_effect(env):
    """越权写被拒后 alice 侧数据原样：项目名/卡片标题/任务清单均未被改动。"""
    alice = env["alice"]
    code, p = alice.json(f"/api/projects/{env['pid']}")
    assert code == 200 and p["name"] == "alice 的项目", p
    code, bd = alice.json(f"/api/projects/{env['pid']}/board")
    assert code == 200
    cards = {c["id"]: c for c in bd.get("cards", [])}
    assert env["cid"] in cards, "alice 的卡片被越权删除"
    assert cards[env["cid"]]["title"] == "alice 的卡", "alice 的卡片标题被越权修改"
    code, rows = alice.json(f"/api/projects/{env['pid']}/tasks")
    assert code == 200
    names = [t["name"] for t in rows]
    assert "alice 的任务" in names and "越权任务" not in names


# ---------- 反向证明：属主访问正常 ----------

def test_owner_access_ok(env):
    """alice 访问自己的资源 200（证明 404 来自越权门槛而非接口损坏）。"""
    for route in ("/api/projects/{pid}", "/api/projects/{pid}/tasks",
                  "/api/projects/{pid}/board", "/api/tasks/{tid}"):
        code, _d = env["alice"](route.format(pid=env["pid"], tid=env["tid"]))
        assert code == 200, f"{route} 属主访问应 200，实际 {code}"


# ---------- 列表隔离 ----------

def test_project_list_isolated(env):
    """项目列表只含自己的项目（bob 能看到自建项目，alice 的不出现）。"""
    code, rows = env["bob"].json("/api/projects")
    assert code == 200
    names = [p["name"] for p in rows]
    assert "bob 的项目" in names
    assert "alice 的项目" not in names


def test_task_list_isolated(env):
    """任务列表按项目隔离：bob 自己项目列表正常且为空，alice 列表只含自己任务。"""
    code, rows = env["bob"].json(f"/api/projects/{env['bob_pid']}/tasks")
    assert code == 200 and rows == [], rows
    code, rows_a = env["alice"].json(f"/api/projects/{env['pid']}/tasks")
    assert code == 200
    assert [t["name"] for t in rows_a] == ["alice 的任务"]


# ---------- 匿名访问分层 ----------

def test_anonymous_gets_401(env):
    """未登录访问受保护端点 401（与越权 404 分层：先鉴权后归属）。"""
    anon = env["srv"].client()
    code, _d = anon.json("/api/projects")
    assert code == 401
    code, _d = anon.json(f"/api/projects/{env['pid']}")
    assert code == 401
