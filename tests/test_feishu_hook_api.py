# 项目推送绑定**批量应用**端点契约（隔离实例，HTTP 级）。
#
# 对应设置页「项目推送绑定 → 同时应用到我的全部项目」（2026-10-10，用户需求
# 「增加一个选项统一设置所有的项目」）。本文件只做 HTTP 契约与落库回读，
# 不发任何真实飞书请求（写库 ≠ 发送；推送闸门的行为由 tests/test_feishu_push.py
# 单测覆盖）。
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serverfixture import isolated_server  # noqa: F401  （pytest 夹具，模块级共享）


def _hook(api, pid):
    """读某项目的推送绑定（服务端回显口径：webhook 打码、secret 只回布尔）。"""
    code, d = api.json(f"/api/projects/{pid}/feishu-hook")
    assert code == 200, f"读绑定失败: {code} {d}"
    return d


def test_apply_all_covers_own_unarchived_projects(isolated_server):
    """批量应用：写本人全部未归档项目；归档项目不动；webhook 留空=保留各项目原值。"""
    srv = isolated_server
    a = srv.create_project(srv.admin, "hook_apply_a")
    b = srv.create_project(srv.admin, "hook_apply_b")
    c = srv.create_project(srv.admin, "hook_apply_archived")
    code, _ = srv.admin.json(f"/api/projects/{c}/archive", "POST")
    assert code == 200
    # 先给 b 单独配一个 webhook：批量时不带该键 ⇒ 必须保留 b 自己的值
    code, _ = srv.admin.json(f"/api/projects/{b}/feishu-hook", "PATCH",
                             {"enabled": True, "events": ["task_failed"],
                              "webhook_url": "https://open.feishu.cn/bot/v2/hook/keep-b"})
    assert code == 200
    code, d = srv.admin.json("/api/me/feishu-hook/apply", "POST",
                             {"enabled": False, "events": ["blocked_interaction"]})
    assert code == 200 and d["ok"] is True
    assert set(d["projects"]) == {"hook_apply_a", "hook_apply_b"}
    assert d["updated"] == 2 and d["archived_skipped"] >= 1
    ha = _hook(srv.admin, a)
    assert ha["enabled"] is False and ha["events"] == ["blocked_interaction"]
    hb = _hook(srv.admin, b)
    assert hb["enabled"] is False and hb["events"] == ["blocked_interaction"]
    assert "keep-b" in hb["webhook_url"]          # 留空 = 各项目保留原值
    assert hb["has_webhook_secret"] is False
    hc = _hook(srv.admin, c)
    assert hc["enabled"] is True                  # 归档项目未被写（默认回显）
    assert hc["events"] == ["blocked_interaction", "task_failed"]


def test_apply_all_writes_webhook_when_provided(isolated_server):
    """带 webhook 时批量下发同一个目标（真正「统一」）；secret 一并写入只回布尔。"""
    srv = isolated_server
    d1 = srv.create_project(srv.admin, "hook_apply_w1")
    d2 = srv.create_project(srv.admin, "hook_apply_w2")
    code, d = srv.admin.json("/api/me/feishu-hook/apply", "POST",
                             {"enabled": True, "events": ["blocked_interaction",
                                                          "task_failed"],
                              "webhook_url": "https://open.feishu.cn/bot/v2/hook/same",
                              "webhook_secret": "s3cret"})
    assert code == 200 and d["updated"] >= 2
    for pid in (d1, d2):
        h = _hook(srv.admin, pid)
        assert "hook/same" in h["webhook_url"]
        assert h["enabled"] is True and h["has_webhook_secret"] is True
        assert h["events"] == ["blocked_interaction", "task_failed"]


def test_apply_all_rejects_illegal_events(isolated_server):
    """events 白名单校验：非法事件 400（与单项目端点同口径），且不落库。"""
    code, d = isolated_server.admin.json("/api/me/feishu-hook/apply", "POST",
                                         {"enabled": True, "events": ["bogus"]})
    assert code == 400 and "events" in d["error"]


def test_apply_all_never_touches_other_users_projects(isolated_server):
    """多用户隔离：批量只写调用者**自己**的项目（别的用户的绑定一个字节都不动）。"""
    srv = isolated_server
    uid = srv.create_user("hookuser", "pw-hook-123")
    assert uid > 0
    other = srv.login("hookuser", "pw-hook-123")
    pid = srv.create_project(other, "hook_apply_other_user")
    code, _ = other.json(f"/api/projects/{pid}/feishu-hook", "PATCH",
                         {"enabled": True, "events": ["task_failed"],
                          "webhook_url": "https://open.feishu.cn/bot/v2/hook/other"})
    assert code == 200
    code, d = srv.admin.json("/api/me/feishu-hook/apply", "POST",
                             {"enabled": False, "events": []})
    assert code == 200 and d["ok"] is True
    assert "hook_apply_other_user" not in d["projects"]
    h = _hook(other, pid)
    assert h["enabled"] is True and h["events"] == ["task_failed"]
    assert "hook/other" in h["webhook_url"]
