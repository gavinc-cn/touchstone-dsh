# deliver_comment 投递原文单测（2026-10-10 去前缀）：web 分支 monkeypatch，不触网络
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board


def _proj():
    # model 列参与投递首选模型（会话模型失联自愈），按真实行补齐
    return {"id": 9, "agent_path": "dsh-plugin:/usr/bin/dsh",
            "project_dir": "/tmp/x", "model": ""}


def _card():
    return {"id": 5, "session_id": "s-1", "title": "修复登录", "model": ""}


def _cmt():
    return {"id": 77, "text": "直接改吧"}


def _patch(monkeypatch, sent):
    monkeypatch.setattr(board, "_web_family", lambda p: "dsh_plugin")
    # 单族投递唯一出口（board._deliver_now → _web_send → chat.dsh_send；打桩面在此）
    monkeypatch.setattr(board, "_web_send",
                        lambda fam, p, sid, text, model="", inject=False:
                        sent.setdefault("t", text))
    monkeypatch.setattr(board.db, "update_board_comment",
                        lambda mid, **kw: sent.setdefault("kw", kw))


def test_delivers_plain_text_without_prefix(monkeypatch):
    """评论投递（评论区「保存并投递」/「投递」路径，不再传 raw）：会话收到纯原文，
    sent_text 同落原文——看板评论投递一律不带【看板评论】任务前缀。"""
    sent = {}
    _patch(monkeypatch, sent)
    board.deliver_comment(_proj(), _card(), _cmt())
    assert sent["t"] == "直接改吧"
    assert sent["kw"]["sent_text"] == "直接改吧"


def test_raw_parameter_is_gone(monkeypatch):
    """`raw` 形参随前缀一并退场（结构钉子）：再按旧签名传 raw 属调用方错误，
    防止「无实际作用的开关」被重新加回来。"""
    sent = {}
    _patch(monkeypatch, sent)
    try:
        board.deliver_comment(_proj(), _card(), _cmt(), raw=True)
        raise AssertionError("raw 形参应已删除")
    except TypeError:
        pass
    assert sent == {}
