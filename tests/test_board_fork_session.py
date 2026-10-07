# 看板卡片会话 fork：board.fork_session（dsh_plugin 单族，2026-10-03 单族化）
# —— 经 dshdriver.fork 完整复制源会话为新会话（历史/上下文全量保留），再把
# 新会话 ensure_session 进驱动池并改名「<卡标题>（fork）」；新 sid 由 server
# 端点经 bind_session 仅追加进卡片会话列表（不设主）。
# 与 fork_compact_session（压缩并新建）相对：fork 不压缩、原样复制。
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board


def _card(**kw):
    base = {"id": 1, "project_id": 9, "title": "卡片标题", "description": "",
            "column_key": "doing", "sort_order": 1, "session_id": "s-main",
            "sessions": '["s-main", "s-2"]', "block_kind": None,
            "block_text": "", "parent_card_id": None,
            "origin": "", "done_at": None, "trashed": 0, "trashed_at": None,
            "scheduled_at": None,
            "jira_key": "", "last_error": "", "last_error_at": None,
            "created_at": 0, "updated_at": 0}
    base.update(kw)
    return base


def _proj(**kw):
    base = {"id": 9, "agent_path": "dsh-plugin:/usr/bin/dsh",
            "project_dir": "/tmp/p", "work_dir": "/tmp/w", "model": ""}
    base.update(kw)
    return base


def _stub_dsh(monkeypatch, new_sid="s-new"):
    """打桩 dsh 驱动：fork 回执新 sid，ensure_session / rename 记录调用。"""
    calls = {"fork": [], "ensure": [], "rename": []}
    monkeypatch.setattr(board.dshdriver, "fork",
                        lambda sid: (calls["fork"].append(sid)
                                     or {"new_session_id": new_sid}))
    monkeypatch.setattr(board.dshdriver, "ensure_session",
                        lambda sid, **kw: calls["ensure"].append((sid, kw)))
    monkeypatch.setattr(board.dshdriver, "rename",
                        lambda sid, title: calls["rename"].append((sid, title)))
    return calls


def test_fork_session_ok_title_and_return(monkeypatch):
    """正常 fork：返回新 sid；源 sid 原样透传驱动 fork；新会话 ensure 进驱动池
    （同 cwd / 卡任务名）并改名「<卡标题>（fork）」。"""
    calls = _stub_dsh(monkeypatch)
    new_sid = board.fork_session(_proj(), _card(), "s-2")
    assert new_sid == "s-new"
    assert calls["fork"] == ["s-2"]
    assert calls["ensure"] == [("s-new", {"cwd": "/tmp/p", "task": "card-1"})]
    assert calls["rename"] == [("s-new", "卡片标题（fork）")]


def test_fork_session_ok_main_sid(monkeypatch):
    """sid 等于主 session_id（不在 sessions 清单内）也算属于该卡片。"""
    calls = _stub_dsh(monkeypatch)
    card = _card(sessions='["s-2"]', session_id="s-main")
    assert board.fork_session(_proj(), card, "s-main") == "s-new"
    assert calls["fork"] == ["s-main"]


def test_fork_session_ok_empty_title(monkeypatch):
    """卡片无标题：不发起改名（rename 只对 strip 后非空标题调用）。"""
    calls = _stub_dsh(monkeypatch)
    assert board.fork_session(_proj(), _card(title="  "), "s-2") == "s-new"
    assert calls["rename"] == []


def test_fork_session_sid_not_belong(monkeypatch):
    """sid 既不在 sessions 清单也不是主会话 → 拒绝，不触驱动。"""
    calls = _stub_dsh(monkeypatch)
    with pytest.raises(RuntimeError, match="会话不属于该卡片"):
        board.fork_session(_proj(), _card(), "s-x")
    assert calls["fork"] == []
    assert calls["ensure"] == []


def test_fork_session_retired_family_rejected(monkeypatch):
    """退场族项目（旧 kimi CLI 路径）→ 报「族已下线，请改绑 dsh 插件」，不触驱动。

    单族化后族门禁只剩 dsh_plugin 一档：非 dsh 即退场族项目，fork/compact 入口
    与起会话入口统一给 `agents.RETIRED_MSG`（B0 防呆口径）。
    """
    calls = _stub_dsh(monkeypatch)
    with pytest.raises(RuntimeError, match="该智能体族已下线"):
        board.fork_session(_proj(agent_path="/usr/bin/kimi"), _card(), "s-2")
    assert calls["fork"] == []
    assert calls["ensure"] == []


def test_fork_session_other_error_wrapped(monkeypatch):
    """驱动异常（如源会话已不存在 404）→ 包成「fork 失败: ...」，不触后续步骤。"""
    calls = _stub_dsh(monkeypatch)
    monkeypatch.setattr(board.dshdriver, "fork",
                        lambda sid: (_ for _ in ()).throw(
                            board.dshdriver.DshDriverError(404, "session not found")))
    with pytest.raises(RuntimeError, match="fork 失败"):
        board.fork_session(_proj(), _card(), "s-2")
    assert calls["ensure"] == []
