#!/usr/bin/env python3
"""Task 4（KB-01）：嵌套 `{detail}` 的可翻子集（外层固定键 + 内层 DshDriverError）。

外层 5 条固定键（`agent 调用失败` / `回退失败` / `compact 失败` / `注入失败` /
`会话启动失败`）在 en 下应把内层 `DshDriverError` 的 `i18n_key`/`i18n_vars` 一起渲染，
zh 路径仍用内层 `.message` 原文（逐字节不变）。lib 层 5 个 HTTP-only 函数
（`_start_web`/`deliver_comment`/`compact_session`/`fork_compact_session`/`fork_session`）
由端点把请求语言透传后，返回的 key+vars 载体在 en 下同样是英文 detail。

与 `backend/test/i18n-nested-detail.test.mjs` 逐条镜像。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import board
import i18n
import server


class FakeHandler(server.Handler):
    """只实现 `_error*` 用到的 headers/path/_respond（同 tests/test_i18n_api.py 的最小替身）。"""

    def __init__(self, headers=None, path="/api/x"):
        self.headers = dict(headers or {})
        self.path = path
        self.responses = []

    def _respond(self, code, body, content_type, extra_headers=None):
        self.responses.append((code, body, content_type))

    def last(self):
        assert len(self.responses) == 1, f"期望恰好一次响应，实际 {self.responses}"
        return self.responses[0]


def driver_error(detail="驱动炸了", status=500):
    """构造带 i18n 载荷的 `DshDriverError`（与 `dshdriver._request` 的 HTTP 分支同形）。"""
    err = server.dshdriver.DshDriverError(status, detail)
    return i18n.localizable(err, "{driver_detail}",
                            {"driver_detail": detail, "status": status})


def render_compact(headers, message, vars=None):
    handler = FakeHandler(headers=headers)
    handler._error(400, message, vars)
    return handler.last()


# --------------------------------------------------------------------------
# ① detail 载体本身：zh 用 .message，en 按内层 key 渲染；无 key 保持动态原文
# --------------------------------------------------------------------------

def test_detail_text_zh_and_en():
    err = driver_error()
    assert i18n.detail_text(err) == "驱动炸了"                     # == str(err)
    assert i18n.detail_text(err, "zh") == "驱动炸了"
    assert i18n.detail_text(err, "en") == "Driver returned HTTP 500: 驱动炸了"
    # 无 i18n_key 的动态异常：en 也保持原文（KB-37 口径）
    plain = OSError("disk full")
    assert i18n.detail_text(plain, "en") == "disk full"
    # 未知语言归一为 zh
    assert i18n.detail_text(err, "fr-FR") == "驱动炸了"


def test_error_outer_keys_english_with_inner_driver_detail():
    """5 条外层键 + 内层驱动 detail：zh 逐字节旧串 / en 内外层同语言。"""
    cases = [
        ("agent 调用失败: {detail}", "agent 调用失败: 驱动炸了",
         "Agent call failed: Driver returned HTTP 500: 驱动炸了"),
        ("回退失败：{detail}", "回退失败：驱动炸了",
         "Rewind failed: Driver returned HTTP 500: 驱动炸了"),
        ("compact 失败: {detail}", "compact 失败: 驱动炸了",
         "Compact failed: Driver returned HTTP 500: 驱动炸了"),
        ("注入失败：{detail}", "注入失败：驱动炸了",
         "Injection failed: Driver returned HTTP 500: 驱动炸了"),
        ("会话启动失败: {detail}", "会话启动失败: 驱动炸了",
         "Session startup failed: Driver returned HTTP 500: 驱动炸了"),
    ]
    err = driver_error()
    for key, zh, en in cases:
        carrier = {"detail": i18n.detail_text(err, "zh")}
        code, body, _ = render_compact(None, key, carrier)
        assert code == 400 and body.decode("utf-8") == '{"error":"%s"}' % zh
        carrier_en = {"detail": i18n.detail_text(err, "en")}
        code, body, _ = render_compact({"X-TS-Lang": "en"}, key, carrier_en)
        assert code == 400 and body.decode("utf-8") == '{"error":"%s"}' % en


# --------------------------------------------------------------------------
# ② 路由层站点：sink 到真 `_error*` 的完整响应体
# --------------------------------------------------------------------------

def _board_endpoint(headers):
    handler = FakeHandler(headers=headers, path="/api/projects/1/board/cards/2/start")
    row = {"id": 1, "archived": False, "project_dir": "/tmp/p", "work_dir": "/tmp/w"}
    card = {"id": 2, "column_key": "review", "block_kind": None, "session_id": "sid"}
    handler._board_owned = lambda project_id, card_id: (row, card)
    handler._owned_project = lambda project_id: row
    return handler, row, card


def test_route_board_send_comment_agent_failure(monkeypatch):
    handler, _row, _card = _board_endpoint({"X-TS-Lang": "en"})
    monkeypatch.setattr(server.db, "list_board_comments",
                        lambda pid: [{"id": 5, "card_id": 2}])

    def boom(*_a, **_k):
        raise driver_error()

    monkeypatch.setattr(server.board, "deliver_comment", boom)
    handler._api_board_send_comment(1, 2, 5, {})
    assert handler.last()[:2] == (500,
        b'{"error": "Agent call failed: Driver returned HTTP 500: \xe9\xa9\xb1\xe5\x8a\xa8'
        b'\xe7\x82\xb8\xe4\xba\x86"}')

    # zh：内层仍按 .message 原文（旧字节）
    zh = _board_endpoint(None)[0]
    monkeypatch.setattr(server.board, "deliver_comment", boom)
    monkeypatch.setattr(server.db, "list_board_comments",
                        lambda pid: [{"id": 5, "card_id": 2}])
    zh._api_board_send_comment(1, 2, 5, {})
    assert zh.last()[:2] == (500, '{"error": "agent 调用失败: 驱动炸了"}'.encode())


def test_route_rewind_failure(monkeypatch):
    handler = FakeHandler(headers={"X-TS-Lang": "en"},
                          path="/api/projects/1/board/sessions/sid/rewind")
    project = {"id": 1, "agent_path": "dsh-plugin:/x", "project_dir": "/tmp/p"}
    monkeypatch.setattr(server.runner, "agent_family", lambda _p: "dsh_plugin")
    monkeypatch.setattr(server.sessparse, "dsh_fork_boundary", lambda _sid, _mid: 42)
    monkeypatch.setattr(server.dshdriver, "fork", lambda *_a, **_k: (_ for _ in ()).throw(
        driver_error()))
    handler._rewind_session(project, "sid", {"mid": "m1"})
    assert handler.last()[:2] == (502,
        '{"error": "Rewind failed: Driver returned HTTP 500: 驱动炸了"}'.encode())


def test_route_task_session_compact_failure(monkeypatch):
    handler = FakeHandler(headers={"X-TS-Lang": "en"}, path="/api/tasks/3/session/compact")
    task = {"id": 3, "session_id": "sid", "status": "idle"}
    monkeypatch.setattr(handler, "_session_context",
                        lambda _tid: (task, {"id": 1}, "dsh_plugin"))
    monkeypatch.setattr(server.dshdriver, "compact",
                        lambda _sid: (_ for _ in ()).throw(driver_error()))
    handler._api_task_session_compact(3, {})
    assert handler.last()[:2] == (400,
        '{"error": "Compact failed: Driver returned HTTP 500: 驱动炸了"}'.encode())

    # zh 字节不变
    zh = FakeHandler(headers=None, path="/api/tasks/3/session/compact")
    zh._session_context = lambda _tid: (task, {"id": 1}, "dsh_plugin")
    zh._api_task_session_compact(3, {})
    assert zh.last()[:2] == (400, '{"error": "compact 失败: 驱动炸了"}'.encode())


def test_route_inject_failure(monkeypatch):
    handler = FakeHandler(headers={"X-TS-Lang": "en"},
                          path="/api/tasks/3/session/chat/inject")
    project = {"id": 1, "agent_path": ""}
    monkeypatch.setattr(server.runner, "agent_family", lambda _p: "dsh_plugin")
    monkeypatch.setattr(server.chat, "msg_info",
                        lambda _m: {"id": "m-run", "sid": "s1", "project_id": 1,
                                    "task_id": 3})
    monkeypatch.setattr(server.chat, "inject_now",
                        lambda _mid: (_ for _ in ()).throw(driver_error()))
    handler._inject_msg(project, "s1", {"msg_id": "m-run"}, task_id=3)
    assert handler.last()[:2] == (502,
        '{"error": "Injection failed: Driver returned HTTP 500: 驱动炸了"}'.encode())


# --------------------------------------------------------------------------
# ③ lib 层 5 个 HTTP-only 函数：lang 透传后 key+vars 载体已按 en 渲染
# --------------------------------------------------------------------------

def test_start_web_localizes_detail(monkeypatch, tmp_path):
    proj = {"id": 1, "project_dir": str(tmp_path), "work_dir": str(tmp_path),
            "agent_path": "dsh-plugin:/x", "model": ""}
    card = {"id": 1, "session_id": "", "model": "", "title": "c",
            "description": "", "column_key": "todo"}
    monkeypatch.setattr(server.dshdriver, "split_model", lambda m: ("", ""))
    monkeypatch.setattr(server.dshdriver, "create_session",
                        lambda *_a, **_k: (_ for _ in ()).throw(driver_error()))
    monkeypatch.setattr(board.lib, "ensure_runtime_dirs", lambda *_a, **_k: None)
    monkeypatch.setattr(board.runner, "append_log", lambda *_a, **_k: None)
    with pytest.raises(RuntimeError) as caught:
        board._start_web(proj, card, "dsh_plugin", lang="en")
    err = caught.value
    assert str(err) == "会话启动失败: 驱动炸了"                     # .message 旧中文
    assert err.i18n_vars["detail"] == "Driver returned HTTP 500: 驱动炸了"
    handler = FakeHandler(headers={"X-TS-Lang": "en"})
    handler._error_spaced(400, i18n.message_vars(err.i18n_key, err.i18n_vars))
    assert handler.last()[:2] == (400,
        '{"error": "Session startup failed: Driver returned HTTP 500: 驱动炸了"}'
        .encode("utf-8"))


def test_compact_session_localizes_detail(monkeypatch):
    proj = {"id": 1, "agent_path": "dsh-plugin:/x"}
    card = {"id": 1, "session_id": "sid", "sessions": "[]"}
    monkeypatch.setattr(board, "_ensure_card_session", lambda *_a, **_k: True)
    monkeypatch.setattr(server.dshdriver, "compact",
                        lambda _sid: (_ for _ in ()).throw(driver_error()))
    with pytest.raises(RuntimeError) as caught:
        board.compact_session(proj, card, "sid", lang="en")
    err = caught.value
    assert str(err) == "compact 失败: 驱动炸了"
    assert err.i18n_vars["detail"] == "Driver returned HTTP 500: 驱动炸了"


def test_fork_compact_and_fork_localize_detail(monkeypatch):
    proj = {"id": 1, "agent_path": "dsh-plugin:/x", "project_dir": "/tmp/p"}
    card = {"id": 1, "session_id": "sid", "sessions": "[]", "title": "c"}
    monkeypatch.setattr(server.dshdriver, "fork",
                        lambda *_a, **_k: (_ for _ in ()).throw(driver_error()))
    for fn, zh_msg in ((board.fork_compact_session, "压缩新建失败: 驱动炸了"),
                       (board.fork_session, "fork 失败: 驱动炸了")):
        with pytest.raises(RuntimeError) as caught:
            fn(proj, card, "sid", lang="en")
        err = caught.value
        assert str(err) == zh_msg
        assert err.i18n_vars["detail"] == "Driver returned HTTP 500: 驱动炸了"


def test_deliver_comment_localizes_detail(monkeypatch):
    proj = {"id": 1, "agent_path": "dsh-plugin:/x", "project_dir": "/tmp/p",
            "work_dir": "/tmp/w", "model": ""}
    card = {"id": 1, "session_id": "sid", "model": "", "title": "c"}
    comment = {"id": 5, "text": "hi"}
    monkeypatch.setattr(board, "_web_family", lambda _p: "dsh_plugin")
    monkeypatch.setattr(board.runner, "INSTANCE", None)
    monkeypatch.setattr(board, "_ensure_card_session", lambda *_a, **_k: True)
    monkeypatch.setattr(board, "_web_send",
                        lambda *_a, **_k: (_ for _ in ()).throw(driver_error()))
    with pytest.raises(RuntimeError) as caught:
        board.deliver_comment(proj, card, comment, lang="en")
    err = caught.value
    assert str(err) == "评论投递失败: 驱动炸了"                     # .message 旧中文
    assert err.i18n_vars["detail"] == "Driver returned HTTP 500: 驱动炸了"
