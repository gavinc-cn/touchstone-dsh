# 「取消排队」端点单测（`mode=cancel_queue`；2026-10-17）——与 Node 半的
# `backend/test/queue-cancel-route.test.mjs` 同形（同一批判据、同一批响应字节形态）。
#
# 背景（用户报障）：会话窗「取消排队」按钮原先借用停止链路（stop_card / chat.stop），
# 停止回执只说明**轮次**有没有被打断：没有在跑的轮次时驱动 404 ⇒ stopped=false ⇒ 前端
# 弹「该会话未在运行或无法停止」并提前 return，于是消息其实已被取消、界面却仍显示
# 「排队中」且文字不回输入框。本批把「取消排队」拆成独立的平台侧动作（不碰轮次），并把
# 被取消消息的**全文**回带给前端回填输入框。
#
# 不起 HTTP（照 tests/test_session_owned.py 的「最小 handler 替身直接调端点方法」模式），
# 毫秒级；库走 conftest 的临时库，不碰生产库。
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board
import chat
import db
import server
import waitq


@pytest.fixture(autouse=True)
def _clean_tables():
    """每例前后清 waitq 两表（本文件直接种 chat_msgs 行）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("chat_msgs", "wait_items", "tasks", "board_cards", "projects"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


class _FakeHandler:
    """最小 handler 替身：只实现被测端点依赖的成员（不起 socket/鉴权链）。"""

    def __init__(self, ctx=None, owned=None):
        self._ctx = ctx
        self._owned = owned
        self.resp = []                  # [(code, body_bytes), ...]

    def _session_context(self, task_id):
        return self._ctx

    def _board_owned(self, project_id, card_id=None):
        return self._owned

    def _respond(self, code, body, ctype=None):
        self.resp.append((code, body))

    _api_session_chat_stop = server.Handler._api_session_chat_stop
    _api_cancel_queue = server.Handler._api_cancel_queue
    _api_board_card_action = server.Handler._api_board_card_action


def _seed_msg(msg_id, *, sid, project_id=9, task_id=None, card_id=None,
              message="hi", state="queued", created_at=1):
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO chat_msgs(id, project_id, sid, task_id, card_id, message, state,"
            " error, inject, created_at, started_at, ended_at)"
            " VALUES(?,?,?,?,?,?,?,'',0,?,NULL,NULL)",
            (msg_id, project_id, sid, task_id, card_id, message, state, created_at))


def _seed_task(task_id=7, sid="sess-cq", project_id=9):
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO tasks(id, project_id, name, task_type, status, current_round,"
            " session_id, error, created_at) VALUES(?,?,'t','normal','queued',1,?,'',"
            " '2026-10-17 00:00:00')", (task_id, project_id, sid))


def _json_resp(h, idx=0):
    code, body = h.resp[idx]
    return code, json.loads(body.decode("utf-8")), body.decode("utf-8")


# ---------- ① 任务端点 ----------

def test_task_stop_default_unchanged(monkeypatch):
    """不带 mode ⇒ 旧语义（停止）+ 紧凑字节串 `{"ok":true}` 一字不变（旧前端不破）。"""
    _seed_task()
    seen = []
    monkeypatch.setattr(chat, "stop", lambda sid: seen.append(sid))
    h = _FakeHandler(({"id": 7, "session_id": "sess-cq"}, None, "dsh_plugin"))
    h._api_session_chat_stop(7, None)
    code, _obj, text = _json_resp(h)
    assert (code, text) == (200, '{"ok":true}')
    assert seen == ["sess-cq"]


def test_task_cancel_queue_returns_full_text(monkeypatch):
    """mode=cancel_queue ⇒ 只取消排队、回带全文（json.dumps 形态：带空格、中文原样）。"""
    _seed_task()
    long_text = "长" * 200
    _seed_msg("m-1", sid="sess-cq", task_id=7, message=long_text, created_at=1)
    _seed_msg("m-2", sid="sess-cq", task_id=7, message="第二条", created_at=2)
    _seed_msg("m-3", sid="sess-cq", task_id=7, message="跑着的", state="running", created_at=3)
    stopped = []
    monkeypatch.setattr(chat, "stop", lambda sid: stopped.append(sid))
    h = _FakeHandler(({"id": 7, "session_id": "sess-cq"}, None, "dsh_plugin"))
    h._api_session_chat_stop(7, {"mode": "cancel_queue"})
    code, obj, text = _json_resp(h)
    assert code == 200
    assert obj == {"ok": True, "cancelled": 2,
                   "msgs": [{"id": "m-1", "text": long_text},
                            {"id": "m-2", "text": "第二条"}]}
    assert text.startswith('{"ok": true, "cancelled": 2, "msgs": [{"id": "m-1"')
    assert "长" in text                                  # ensure_ascii=False：中文原样
    assert stopped == []                                 # 取消排队不碰轮次
    assert waitq.msg_get("m-1")["state"] == chat.STATE_CANCELLED
    assert waitq.msg_get("m-3")["state"] == chat.STATE_RUNNING


def test_task_cancel_queue_msg_id_scope(monkeypatch):
    """msg_id 单条口径 + 归属判定（别的任务的消息 ⇒ 同一个 404 文案，不细分）。"""
    _seed_task()
    _seed_task(task_id=8, sid="sess-other")
    _seed_msg("m-a", sid="sess-cq", task_id=7, message="A", created_at=1)
    _seed_msg("m-b", sid="sess-cq", task_id=7, message="B", created_at=2)
    _seed_msg("m-c", sid="sess-other", task_id=8, message="C", created_at=3)

    h = _FakeHandler(({"id": 7, "session_id": "sess-cq"}, None, "dsh_plugin"))
    h._api_session_chat_stop(7, {"mode": "cancel_queue", "msg_id": "m-b"})
    code, obj, _text = _json_resp(h)
    assert (code, obj) == (200, {"ok": True, "cancelled": 1,
                                 "msgs": [{"id": "m-b", "text": "B"}]})
    assert waitq.msg_get("m-a")["state"] == chat.STATE_QUEUED      # 不牵连同会话其它行

    h2 = _FakeHandler(({"id": 7, "session_id": "sess-cq"}, None, "dsh_plugin"))
    h2._api_session_chat_stop(7, {"mode": "cancel_queue", "msg_id": "m-c"})
    code, obj, text = _json_resp(h2)
    assert (code, obj["error"]) == (404, "消息不存在或不在该会话下")
    assert text == '{"error": "消息不存在或不在该会话下"}'
    assert waitq.msg_get("m-c")["state"] == chat.STATE_QUEUED      # 越权消息不动

    h3 = _FakeHandler(({"id": 7, "session_id": "sess-cq"}, None, "dsh_plugin"))
    h3._api_session_chat_stop(7, {"mode": "cancel_queue", "msg_id": "不存在"})
    assert _json_resp(h3)[0] == 404


def test_task_cancel_queue_zero_is_not_error():
    """cancelled=0 不是错误（消息已被 worker 抢走执行 / 已被别的路径取消 / 队列本就空）。"""
    _seed_task()
    _seed_msg("m-r", sid="sess-cq", task_id=7, message="已开跑", state="running")
    h = _FakeHandler(({"id": 7, "session_id": "sess-cq"}, None, "dsh_plugin"))
    h._api_session_chat_stop(7, {"mode": "cancel_queue", "msg_id": "m-r"})
    code, obj, _text = _json_resp(h)
    assert (code, obj) == (200, {"ok": True, "cancelled": 0, "msgs": []})
    assert waitq.msg_get("m-r")["state"] == chat.STATE_RUNNING


def test_task_unknown_task_still_404():
    """任务不存在 ⇒ 仍 404 紧凑体（mode 不影响前置校验顺序）。"""
    h = _FakeHandler((None, None, None))
    h._api_session_chat_stop(999, {"mode": "cancel_queue"})
    code, _obj, text = _json_resp(h)
    assert (code, text) == (404, '{"error":"task not found"}')


# ---------- ② 看板端点 ----------

def _board_owned(project_id=9, card_id=5):
    row = {"id": project_id, "agent_path": "dsh-plugin:/tmp/dsh", "project_dir": "/tmp/p"}
    card = {"id": card_id, "project_id": project_id, "title": "t", "description": "",
            "column_key": "blocked", "sort_order": 1, "session_id": "", "sessions": "[]",
            "block_kind": None, "block_text": "", "parent_card_id": None, "origin": "",
            "done_at": None, "trashed": 0, "trashed_at": None, "scheduled_at": None,
            "jira_key": "", "last_error": "", "last_error_at": None,
            "created_at": 0, "updated_at": 0}
    return row, card


def test_board_stop_default_unchanged(monkeypatch):
    """不带 mode ⇒ 原样停止，响应 `{"ok": true, "stopped": …}` 一字不变。"""
    calls = []
    monkeypatch.setattr(board, "stop_card", lambda cid: calls.append(cid) or False)
    h = _FakeHandler(owned=_board_owned())
    h._api_board_card_action(9, 5, "stop", {})
    code, _obj, text = _json_resp(h)
    assert (code, text) == (200, '{"ok": true, "stopped": false}')
    assert calls == [5]


def test_board_cancel_queue_by_card(monkeypatch):
    """mode=cancel_queue ⇒ 按卡取消（不碰轮次：stop_card 一次都不调）。"""
    _seed_msg("b-1", sid="s1", card_id=5, message="甲", created_at=1)
    _seed_msg("b-2", sid="s2", card_id=5, message="乙", created_at=2)
    _seed_msg("b-3", sid="s3", card_id=6, message="丙", created_at=3)
    calls = []
    monkeypatch.setattr(board, "stop_card", lambda cid: calls.append(cid) or False)
    h = _FakeHandler(owned=_board_owned())
    h._api_board_card_action(9, 5, "stop", {"mode": "cancel_queue"})
    code, obj, text = _json_resp(h)
    assert (code, obj) == (200, {"ok": True, "cancelled": 2,
                                 "msgs": [{"id": "b-1", "text": "甲"},
                                          {"id": "b-2", "text": "乙"}]})
    assert text == '{"ok": true, "cancelled": 2, "msgs": [{"id": "b-1", "text": "甲"}, {"id": "b-2", "text": "乙"}]}'
    assert calls == []
    assert waitq.msg_get("b-3")["state"] == chat.STATE_QUEUED      # 别人卡的排队消息不动


def test_board_cancel_queue_msg_id_alien_card_404(monkeypatch):
    """看板路径的单条口径：别的卡的消息 ⇒ 404（与任务路径同一文案）。"""
    _seed_msg("b-4", sid="s4", card_id=6, message="丙")
    h = _FakeHandler(owned=_board_owned())
    h._api_board_card_action(9, 5, "stop", {"mode": "cancel_queue", "msg_id": "b-4"})
    code, obj, _text = _json_resp(h)
    assert (code, obj["error"]) == (404, "消息不存在或不在该会话下")

    h2 = _FakeHandler(owned=_board_owned())
    h2._api_board_card_action(9, 5, "stop", {"mode": "cancel_queue", "msg_id": "b-4"})
    assert _json_resp(h2)[0] == 404


def test_board_cancel_queue_own_msg(monkeypatch):
    """看板路径的单条口径：本卡消息可取消（排队行行内「取消」的落点）。"""
    _seed_msg("b-5", sid="s5", card_id=5, message="单条")
    h = _FakeHandler(owned=_board_owned())
    h._api_board_card_action(9, 5, "stop", {"mode": "cancel_queue", "msg_id": "b-5"})
    code, obj, _text = _json_resp(h)
    assert (code, obj) == (200, {"ok": True, "cancelled": 1,
                                 "msgs": [{"id": "b-5", "text": "单条"}]})
    assert waitq.msg_get("b-5")["state"] == chat.STATE_CANCELLED
