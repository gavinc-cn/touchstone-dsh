#!/usr/bin/env python3
"""Task 11：Python 错误响应按请求语言本地化 —— `self._error*` 单点收口的验收测试。

覆盖三件事（与 T10 的 `backend/test/i18n-ctx.test.mjs` 逐条镜像）：
  ① **字节形状不变**：无语言信号（老客户端/对拍器）时，紧凑 `{"error":"…"}` 与
     带空格 `{"error": "…"}` 两种正文逐字节保持中文原文；语言由 `X-TS-Lang` /
     `?lang=` / 用户偏好 / `TS_I18N=0` 决定，非法头值回落中文且不 500。
  ② **词条覆盖可验证**：静态扫描 `backend_py/server.py` 的 `self._error*` 写点与
     `backend_py/user_messages.py` 登记表里的 lib 用户可见文案，逐条要求
     `i18n/en.json` 的 `api` 命名空间有对应词条；缺一条即列出并失败。门禁还能抓
     「中文 f-string 直接进 _error」「_respond 直发错误体」「localizable 的 key 不是
     字面量」等绕过写法。
  ③ **翻译不破坏插值**：带 `{name}` 占位符的词条在中文侧还原原文、英文侧按同一
     占位符插值；lib 的 key+vars 载体（`i18n.message_vars`）与异常负载
     （`i18n.localizable`，含驱动 HTTP detail）都按请求语言整条渲染。

为什么端到端用例走**真隔离实例**（`serverfixture.IsolatedServer`）：本任务的价值就在
「单点收口」——如果测试绕过 Handler 直接调 `_respond`，就测不到「所有写点都真的经过
本地化」这件事。桩级用例（monkeypatch lib 返回值）只用于真实例难以构造的状态
（起跑忙拒绝、worktree 清理忙拒绝）。
"""
import ast
import json
import pathlib
import re
import sqlite3

import pytest

import i18n
import server
from serverfixture import Api, IsolatedServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend_py"
HAN = re.compile(r"[\u4e00-\u9fff]")
PLACEHOLDER = re.compile(r"\{([A-Za-z_]\w*)\}", re.ASCII)
JSON_CT = "application/json; charset=utf-8"


# --------------------------------------------------------------------------
# 请求桩：只实现 `_error*` 用到的 headers/path/_respond（不建真 socket）
# --------------------------------------------------------------------------
class FakeHandler(server.Handler):
    """`Handler` 的最小替身：不跑 `BaseHTTPRequestHandler.__init__`。

    只提供语言解析需要的 `headers`/`path`/`_request_user`，并把 `_respond` 的
    (code, body, content_type) 收进 `responses`。这样能精确断言**原始字节**。
    """

    def __init__(self, headers=None, path="/api/x", user=None):
        self.headers = dict(headers or {})
        self.path = path
        self._request_user = user
        self.responses = []

    def _respond(self, code, body, content_type, extra_headers=None):
        self.responses.append((code, body, content_type))

    def last(self):
        assert len(self.responses) == 1, f"期望恰好一次响应，实际 {self.responses}"
        return self.responses[0]


def render_compact(headers=None, message="key 非法", vars=None, user=None, path="/api/x"):
    handler = FakeHandler(headers=headers, user=user, path=path)
    handler._error(400, message, vars)
    return handler.last()


def render_spaced(headers=None, message="key 非法", vars=None, user=None, path="/api/x"):
    handler = FakeHandler(headers=headers, user=user, path=path)
    handler._error_spaced(400, message, vars)
    return handler.last()


# --------------------------------------------------------------------------
# ① 无语言信号：存量行为逐字节不变（对拍/老客户端不回归的硬判据）
# --------------------------------------------------------------------------

def test_no_signal_compact_body_is_byte_identical():
    code, body, ctype = render_compact()
    assert code == 400
    assert ctype == JSON_CT
    assert body == b'{"error":"key \xe9\x9d\x9e\xe6\xb3\x95"}'    # == b'{"error":"key 非法"}'
    assert body.decode("utf-8") == '{"error":"key 非法"}'


def test_no_signal_spaced_body_is_byte_identical():
    code, body, ctype = render_spaced(message="文件不存在或不可读")
    assert code == 400 and ctype == JSON_CT
    assert body == '{"error": "文件不存在或不可读"}'.encode("utf-8")


def test_compact_and_spaced_shapes_stay_distinct():
    compact = render_compact()[1].decode()
    spaced = render_spaced()[1].decode()
    assert compact.startswith('{"error":"') and '": "' not in compact
    assert spaced.startswith('{"error": "') and spaced.endswith('"}')


# --------------------------------------------------------------------------
# ② 语言解析：X-TS-Lang / 变体 / 非法值 / query / 回滚开关 / 用户偏好
# --------------------------------------------------------------------------

def test_x_ts_lang_en_renders_english_for_both_shapes():
    assert render_compact({"X-TS-Lang": "en"})[1] == '{"error":"Invalid key"}'.encode()
    assert render_spaced({"x-ts-lang": "EN"}, "请填写拒绝理由")[1] == \
        '{"error": "Please provide a rejection reason"}'.encode()


@pytest.mark.parametrize("headers,expected", [
    ({"X-TS-Lang": "zh-CN"}, "key 非法"),
    ({"X-TS-Lang": "en-US"}, "Invalid key"),
    ({"X-TS-Lang": "xx"}, "key 非法"),
    ({"X-TS-Lang": ""}, "key 非法"),
    ({"X-TS-Lang": "fr-FR"}, "key 非法"),
    ({}, "key 非法"),
])
def test_lang_variants_and_invalid_values(headers, expected):
    assert render_compact(headers)[1] == ('{"error":"%s"}' % expected).encode("utf-8")


def test_query_lang_beats_default_and_invalid_query_falls_back():
    assert render_compact(path="/api/x?lang=en")[1] == '{"error":"Invalid key"}'.encode()
    assert render_compact(path="/api/x?lang=xx")[1] == '{"error":"key 非法"}'.encode()


def test_ts_i18n_zero_forces_chinese(monkeypatch):
    monkeypatch.setenv("TS_I18N", "0")
    assert render_compact({"X-TS-Lang": "en"})[1] == '{"error":"key 非法"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"})[1] == '{"error": "key 非法"}'.encode()


def test_user_pref_fallback_and_header_precedence(monkeypatch):
    """无显式信号才读 user_prefs；读一次后同请求复用；头/query 命中不读库。"""
    calls = []

    def fake_prefs(user_id, project_id):
        calls.append((user_id, project_id))
        return {"lang": {"v": "en"}}

    monkeypatch.setattr(server.db, "get_user_prefs", fake_prefs)
    user = {"id": 7}

    # 无头：偏好 en
    assert render_spaced(user=user, message="文件不存在或不可读")[1] == \
        '{"error": "File does not exist or is not readable"}'.encode()
    assert calls == [(7, 0)]

    # 同请求多次取语言只解析一次（两次错误响应共用 Handler 实例缓存）
    handler = FakeHandler(user=user)
    handler._error(400, "key 非法")
    handler._error_spaced(404, "文件不存在或不可读")
    assert len(handler.responses) == 2
    handler.responses.clear()
    assert len(calls) == 2, "第二条错误响应不应再读一次 user_prefs"

    # 显式头压过偏好，且不读库
    calls.clear()
    assert render_spaced({"X-TS-Lang": "zh"}, "文件不存在或不可读",
                         user=user)[1] == '{"error": "文件不存在或不可读"}'.encode()
    assert calls == []

    # query 压过偏好，且不读库
    assert render_compact(path="/api/x?lang=en")[1] == '{"error":"Invalid key"}'.encode()
    calls.clear()
    assert render_compact({"X-TS-Lang": "en"})[1] == '{"error":"Invalid key"}'.encode()
    assert calls == []


def test_ts_i18n_zero_does_not_read_prefs(monkeypatch):
    calls = []
    monkeypatch.setattr(server.db, "get_user_prefs",
                        lambda *a: calls.append(a) or {"lang": {"v": "en"}})
    monkeypatch.setenv("TS_I18N", "0")
    assert render_compact(user={"id": 1})[1] == '{"error":"key 非法"}'.encode()
    assert calls == []


def test_pref_read_failure_falls_back_to_chinese(monkeypatch):
    def boom(*_a):
        raise RuntimeError("db is down")

    monkeypatch.setattr(server.db, "get_user_prefs", boom)
    assert render_compact(user={"id": 1})[1] == '{"error":"key 非法"}'.encode()


# --------------------------------------------------------------------------
# ③ 词条缺失回落 / 占位符插值 / key+vars 三种载体
# --------------------------------------------------------------------------

def test_missing_entry_falls_back_to_chinese_not_empty():
    assert render_compact({"X-TS-Lang": "en"}, "该动态文案没有英文词条")[1] == \
        '{"error":"该动态文案没有英文词条"}'.encode()


def test_placeholder_entry_renders_both_languages():
    assert render_spaced(None, "未知资产：{id}", {"id": "foo"})[1] == \
        '{"error": "未知资产：foo"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"}, "未知资产：{id}", {"id": "foo"})[1] == \
        '{"error": "Unknown asset: foo"}'.encode()


def test_message_vars_carrier_renders_both_languages():
    carrier = i18n.message_vars("工作目录不可用: {detail}", {"detail": "disk full"})
    assert render_spaced(None, carrier)[1] == '{"error": "工作目录不可用: disk full"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"}, carrier)[1] == \
        '{"error": "Work directory unavailable: disk full"}'.encode()


def test_localizable_error_renders_both_languages():
    err = i18n.localizable(RuntimeError("会话启动失败: boom"),
                           "会话启动失败: {detail}", {"detail": "boom"})
    assert str(err) == "会话启动失败: boom", "抛错路径的 .message 必须仍是渲染后中文"
    assert render_spaced(None, err)[1] == '{"error": "会话启动失败: boom"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"}, err)[1] == \
        '{"error": "Session startup failed: boom"}'.encode()


def test_driver_detail_key_preserves_detail_and_wraps_in_english():
    """T10 fix round 2 的驱动 detail 契约（Python 镜像）：中文只输出 detail，英文带包装。"""
    err = i18n.localizable(server.dshdriver.DshDriverError(500, "宿主崩了"),
                           "{driver_detail}", {"driver_detail": "宿主崩了", "status": 500})
    assert render_spaced(None, err)[1] == '{"error": "宿主崩了"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"}, err)[1] == \
        '{"error": "Driver returned HTTP 500: 宿主崩了"}'.encode()


def test_dshdriver_http_error_detail_survives_real_request(monkeypatch):
    """真 `dshdriver._request`：驱动 500 的 JSON detail 进入 i18n_key/vars，中英各一份。

    对应 T10 fix round 2 的驱动 detail 回归（`{driver_detail}` 单占位符 key）：
    中文只输出 detail 本身（旧 `str(e)` 口径），英文包装出状态与 detail。
    """
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    import dshdriver

    class _Driver(BaseHTTPRequestHandler):
        def do_GET(self):                       # noqa: N802 —— http.server 约定
            body = json.dumps({"error": "宿主崩了"}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    upstream = HTTPServer(("127.0.0.1", 0), _Driver)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("TS_AGENT_DRIVER_URL",
                       f"http://127.0.0.1:{upstream.server_address[1]}")
    try:
        with pytest.raises(dshdriver.DshDriverError) as caught:
            dshdriver.health()
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=5)
    err = caught.value
    assert str(err) == "宿主崩了", "抛错路径的 message 仍是旧中文（detail 原文）"
    assert err.i18n_key == "{driver_detail}"
    assert err.i18n_vars == {"driver_detail": "宿主崩了", "status": 500}
    assert render_spaced(None, err)[1] == '{"error": "宿主崩了"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"}, err)[1] == \
        '{"error": "Driver returned HTTP 500: 宿主崩了"}'.encode()


def test_dshdriver_non_string_http_detail_is_stringified(monkeypatch):
    """驱动返回非字符串 `error`（对象）时按 JS `String()` 口径转换，不泄漏占位符。

    旧实现把对象 detail 直接塞进 `{driver_detail}` vars；i18n 插值对对象保留占位符，
    用户会看到字面量 `{driver_detail}`。Node `httpErrorDetail` 对非字符串 detail 走
    `String()` coercion，Python 侧镜像为 `i18n.js_string`（普通对象 → "[object Object]"）。
    """
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    import dshdriver

    class _Driver(BaseHTTPRequestHandler):
        def do_GET(self):                       # noqa: N802 —— http.server 约定
            body = json.dumps({"error": {"code": 7}}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    upstream = HTTPServer(("127.0.0.1", 0), _Driver)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("TS_AGENT_DRIVER_URL",
                       f"http://127.0.0.1:{upstream.server_address[1]}")
    try:
        with pytest.raises(dshdriver.DshDriverError) as caught:
            dshdriver.health()
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=5)
    err = caught.value
    assert str(err) == "[object Object]", "对象 detail 应先转成字符串再进异常"
    assert err.i18n_vars["driver_detail"] == "[object Object]"
    assert render_spaced(None, err)[1] == '{"error": "[object Object]"}'.encode()
    assert render_spaced({"X-TS-Lang": "en"}, err)[1] == \
        '{"error": "Driver returned HTTP 500: [object Object]"}'.encode()


def test_dshdriver_idle_timeout_float_keeps_old_zh_rendering(monkeypatch):
    """`idle_timeout=1.0` 的中文渲染必须仍是旧的 "1.0"（不是 JS 数字口径的 "1"）。

    旧 f-string `f"…{idle_timeout}s…"` 对 float 输出 "1.0"；无头请求（对拍/老客户端）
    必须逐字节不变，故 `{seconds}` 变量在进 i18n 插值前先按 `str()` 预格式化。
    """
    import socket

    import dshdriver

    class _Resp:
        status = 200

        def read1(self, _n):
            raise socket.timeout("timed out")

        def close(self):
            pass

    class _Conn:
        sock = None

        def __init__(self, *_args, **_kwargs):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            return _Resp()

        def close(self):
            pass

    monkeypatch.setenv(dshdriver.URL_ENV, "http://127.0.0.1:1")
    monkeypatch.setattr(dshdriver.http.client, "HTTPConnection", _Conn)
    with pytest.raises(dshdriver.DshDriverError) as caught:
        dshdriver.stream("sid", lambda _frame: None, idle_timeout=1.0)
    err = caught.value
    assert ">1.0s" in str(err), "异常 message（日志口径）应仍是旧的 1.0"
    assert render_spaced(None, err)[1] == \
        '{"error": "事件流空闲超时（>1.0s 无数据）"}'.encode(), \
        "无头中文必须逐字节保持旧的 1.0 形态"


def test_non_string_message_uses_js_string_coercion():
    """非字符串 message 按 Node `String(message)` 强制转换（T10 ⑤ 的 Python 镜像）。

    Node 的 `localize` 对非字符串 message 原样返回，最终由 `respondError` /
    `respondErrorSpaced` 的 `String(message)` 转换：null → "null"、布尔 →
    "true"/"false"、数字 → JS 最短表示（1.0 → "1"）、数组 → 逗号连接（null 元素为空
    串）、普通对象 → "[object Object]"、带 toString 的对象用其返回值。
    """
    class _Custom:
        def __str__(self):
            return "对象"

    cases = [
        (123, "123"),
        (1.0, "1"),
        (None, "null"),
        (True, "true"),
        (False, "false"),
        ([1, None, 2], "1,,2"),
        ({"a": 1}, "[object Object]"),
        (_Custom(), "对象"),
    ]
    for message, expected in cases:
        assert render_compact({"X-TS-Lang": "en"}, message)[1] == \
            ('{"error":"%s"}' % expected).encode("utf-8"), message


# --------------------------------------------------------------------------
# ④ 端点级（桩）：起跑忙 / worktree 清理忙 / 投递拒 / 注入拒 / 拖排 / 移列
#    —— 这些状态在真实例里要么需要并行时序、要么要驱动配合；用 monkeypatch
#    只替身「lib 的返回值/异常」这一层，端点本身与 _error* 仍走真代码。
# --------------------------------------------------------------------------
def _board_endpoint(headers=None):
    handler = FakeHandler(headers=headers, path="/api/projects/1/board/cards/2/start")
    row = {"id": 1, "archived": False, "project_dir": "/tmp/p", "work_dir": "/tmp/w"}
    card = {"id": 2, "column_key": "review", "block_kind": None}
    handler._board_owned = lambda project_id, card_id: (row, card)
    handler._owned_project = lambda project_id: row
    return handler, row, card


def test_endpoint_board_reorder_non_manual_english(monkeypatch):
    handler, _row, _card = _board_endpoint({"X-TS-Lang": "en"})
    monkeypatch.setattr(server.board, "reorder_card",
                        lambda *a, **k: "当前列排序方案非手动，不可拖排")
    handler._api_board_reorder(1, {"card_id": 2, "before_id": None})
    assert handler.last()[:2] == (400,
        '{"error": "This column does not use manual ordering, so drag reordering is unavailable"}'
        .encode())


def test_endpoint_board_move_doing_to_todo_english(monkeypatch):
    handler, _row, _card = _board_endpoint({"X-TS-Lang": "en"})
    monkeypatch.setattr(server.board, "move_card",
                        lambda *a, **k: (None, {"error": "doing 不可直接拖回 todo"}))
    handler._api_board_card_action(1, 2, "move", {"column": "todo"})
    assert handler.last()[:2] == (400, b'{"error": "A card cannot be dragged directly from doing back to todo"}')


def test_endpoint_board_start_busy_english(monkeypatch):
    handler, _row, _card = _board_endpoint({"X-TS-Lang": "en"})
    monkeypatch.setattr(server.board, "start_into_doing",
                        lambda *a, **k: (None, {"error": "会话运行中，请等待完成或先停止"}))
    handler._api_board_card_action(1, 2, "start", {})
    assert handler.last()[:2] == (400,
        b'{"error": "The session is running; wait for it to finish or stop it first"}')


def test_endpoint_board_worktree_cleanup_busy_english(monkeypatch):
    handler, _row, _card = _board_endpoint({"X-TS-Lang": "en"})
    monkeypatch.setattr(server.board, "cleanup_card_worktree",
                        lambda *a, **k: (False, "会话运行中，请先停止卡片再清理 worktree"))
    handler._api_board_card_worktree_cleanup(1, 2)
    # running_map 为空 ⇒ 走 lib 的忙拒绝（400）；消息与 409 分支同一词条
    assert handler.last()[:2] == (400,
        b'{"error": "The session is running; stop the card before cleaning up the worktree"}')


def test_endpoint_chat_delivery_refused_english(monkeypatch):
    handler, _row, _card = _board_endpoint({"X-TS-Lang": "en"})
    monkeypatch.setattr(server.db, "list_board_comments",
                        lambda pid: [{"id": 5, "card_id": 2}])

    def refused(*_a, **_k):
        raise server.chat.DeliveryRefused("会话已结束，无法投递（宿主无活动 agent）")

    monkeypatch.setattr(server.board, "deliver_comment", refused)
    handler._api_board_send_comment(1, 2, 5, {})
    assert handler.last()[:2] == (400,
        b'{"error": "The session has ended and cannot receive deliveries (no active agent in the host)"}')


def test_endpoint_chat_inject_refused_english(monkeypatch):
    handler = FakeHandler(headers={"X-TS-Lang": "en"},
                          path="/api/tasks/3/session/chat/inject")
    project = {"id": 1, "agent_path": ""}
    monkeypatch.setattr(server.runner, "agent_family", lambda _p: "dsh_plugin")
    monkeypatch.setattr(server.chat, "msg_info",
                        lambda _m: {"id": "m-run", "sid": "s1", "project_id": 1,
                                    "task_id": 3})

    def refused(_mid):
        raise server.chat.InjectRefused("该消息已不在排队中（可能已开始发送）")

    monkeypatch.setattr(server.chat, "inject_now", refused)
    handler._inject_msg(project, "s1", {"msg_id": "m-run"}, task_id=3)
    assert handler.last()[:2] == (400,
        b'{"error": "The message is no longer queued (it may have started sending)"}')


# --------------------------------------------------------------------------
# ⑤ 端点级（真隔离实例）：无头中文逐字节 / 英文翻译 / 偏好 / 回滚开关
# --------------------------------------------------------------------------
@pytest.fixture(scope="module")
def srv():
    instance = IsolatedServer()
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _new_client(srv, headers=None):
    """带自定义头并已登录 admin 的客户端（prefs 用例之外都用 srv.admin）。"""
    api = Api(srv.base, headers=headers)
    code, d = api.json("/api/auth/login", "POST",
                       {"username": "admin", "password": srv.admin_pw})
    assert code == 200, f"登录失败: {code} {d}"
    return api


def test_endpoint_no_header_bytes_compact_and_spaced(srv):
    # 紧凑：GET /api/projects/<不存在> ⇒ _owned_project 的 project not found
    api = srv.admin
    code, text = api("/api/projects/999999")
    assert code == 404
    assert text == '{"error":"project not found"}'
    # 带空格：fs/mkdir 名称为空
    code, text = api("/api/fs/mkdir", "POST", {"path": srv.proj_dir, "name": ""})
    assert code == 400
    assert text == '{"error": "文件夹名称不能为空"}'


def test_endpoint_en_mode_for_fs_mkdir_and_project_file(srv):
    en = _new_client(srv, {"X-TS-Lang": "en"})
    code, text = en("/api/fs/mkdir", "POST", {"path": srv.proj_dir, "name": ""})
    assert (code, text) == (400, '{"error": "Folder name cannot be empty"}')

    # OSError 的 detail 保留（key+vars：`新建失败：{detail}` / `Failed to create: {detail}`）
    code, text = en("/api/fs/mkdir", "POST",
                    {"path": srv.proj_dir, "name": "x" * 300})
    assert code == 400
    assert text.startswith('{"error": "Failed to create: '), text

    # 项目文件缺失：404 带空格
    pid = srv.create_project(srv.admin, "i18n-file")
    code, text = en(f"/api/projects/{pid}/file?path=missing.txt")
    assert (code, text) == (404, '{"error": "File does not exist or is not readable"}')
    code, text = srv.admin(f"/api/projects/{pid}/file?path=missing.txt")
    assert (code, text) == (404, '{"error": "文件不存在或不可读"}')


def test_endpoint_zh_variant_and_invalid_header_stay_chinese(srv):
    for value, expected in [("zh-CN", "文件夹名称不能为空"),
                            ("fr-FR", "文件夹名称不能为空"),
                            ("", "文件夹名称不能为空")]:
        api = _new_client(srv, {"X-TS-Lang": value})
        code, text = api("/api/fs/mkdir", "POST", {"path": srv.proj_dir, "name": ""})
        assert (code, text) == (400, '{"error": "%s"}' % expected)


def test_endpoint_user_pref_fallback_and_header_precedence(srv):
    """user_prefs(project_id=0,key='lang',value={"v":"en"}) ⇒ 无头请求回英文。"""
    api = srv.admin
    try:
        code, _d = api.json("/api/prefs", "POST",
                            {"project_id": 0, "key": "lang", "value": {"v": "en"}})
        assert code == 200
        code, text = api("/api/fs/mkdir", "POST", {"path": srv.proj_dir, "name": ""})
        assert (code, text) == (400, '{"error": "Folder name cannot be empty"}')
        # 显式 zh 头压过偏好
        api.headers["X-TS-Lang"] = "zh"
        code, text = api("/api/fs/mkdir", "POST", {"path": srv.proj_dir, "name": ""})
        assert (code, text) == (400, '{"error": "文件夹名称不能为空"}')
    finally:
        api.headers.pop("X-TS-Lang", None)
        api.json("/api/prefs", "POST",
                 {"project_id": 0, "key": "lang", "value": {"v": "zh"}})


def test_endpoint_ts_i18n_zero_rollback_switch():
    """独立实例设 TS_I18N=0：即使带 en 头也恒中文（回滚开关）。"""
    instance = IsolatedServer(extra_env={"TS_I18N": "0"})
    try:
        instance.start()
        en = _new_client(instance, {"X-TS-Lang": "en"})
        code, text = en("/api/fs/mkdir", "POST",
                        {"path": instance.proj_dir, "name": ""})
        assert (code, text) == (400, '{"error": "文件夹名称不能为空"}')
    finally:
        instance.stop()


def test_endpoint_driver_http_detail_in_both_languages(srv):
    """驱动 HTTP 错误的 detail 在中文/en 都保留（T10 fix round 2 的 Python 镜像）。"""
    pid = srv.create_project(srv.admin, "i18n-driver")
    # 幽灵会话：驱动 /model 回 404 {"error":"session not found"}
    code, text = srv.admin(f"/api/projects/{pid}/board/cards", "POST",
                           {"title": "c"})
    assert code == 200
    cid = json.loads(text)["id"]
    code, _d = srv.admin(f"/api/projects/{pid}/board/cards/{cid}", "PATCH",
                         {"bind_session": "ghost-session"})
    assert code == 200
    path = f"/api/projects/{pid}/board/sessions/ghost-session/profile"
    # 中文：旧版 str(e) 就是 detail 本身（不额外加「驱动返回 HTTP …」前缀）
    code, text = srv.admin(path, "POST", {"model": "m"})
    assert (code, text) == (502, '{"error": "session not found"}')
    # 英文：包装 + 状态 + detail 全保留
    en = _new_client(srv, {"X-TS-Lang": "en"})
    code, text = en(path, "POST", {"model": "m"})
    assert (code, text) == (502, '{"error": "Driver returned HTTP 404: session not found"}')


def test_endpoint_stale_question_english(srv):
    pid = srv.create_project(srv.admin, "i18n-answer")
    code, text = srv.admin(f"/api/projects/{pid}/board/cards", "POST",
                           {"title": "c"})
    cid = json.loads(text)["id"]
    srv.admin(f"/api/projects/{pid}/board/cards/{cid}", "PATCH",
              {"bind_session": "ghost-q"})
    path = f"/api/projects/{pid}/board/cards/{cid}/interaction/answer"
    code, text = srv.admin(path, "POST", {"qid": "stale", "answers": [{"wire": "q_0"}]})
    assert (code, text) == (400, '{"error": "当前没有等待中的提问"}')
    en = _new_client(srv, {"X-TS-Lang": "en"})
    code, text = en(path, "POST", {"qid": "stale", "answers": [{"wire": "q_0"}]})
    assert (code, text) == (400, '{"error": "There is no pending question"}')


def test_endpoint_inject_refused_english(srv):
    """真链路：chat_msgs 行 state=running ⇒ InjectRefused ⇒ 400 英文。"""
    pid = srv.create_project(srv.admin, "i18n-inject")
    code, text = srv.admin(f"/api/projects/{pid}/board/cards", "POST",
                           {"title": "c"})
    cid = json.loads(text)["id"]
    sid = "session-inject"
    srv.admin(f"/api/projects/{pid}/board/cards/{cid}", "PATCH",
              {"bind_session": sid})
    _sql(srv, "INSERT INTO chat_msgs(id, project_id, sid, card_id, message, state,"
              " created_at) VALUES(?,?,?,?,?,?,?)",
         ("m-run", pid, sid, cid, "hi", "running", 1))
    path = f"/api/projects/{pid}/board/sessions/{sid}/inject"
    code, text = srv.admin(path, "POST", {"msg_id": "m-run"})
    assert (code, text) == (400, '{"error": "该消息已不在排队中（可能已开始发送）"}')
    en = _new_client(srv, {"X-TS-Lang": "en"})
    code, text = en(path, "POST", {"msg_id": "m-run"})
    assert (code, text) == \
        (400, '{"error": "The message is no longer queued (it may have started sending)"}')


def test_endpoint_board_reorder_and_move_real_chain(srv):
    """真 DB 链路：非 manual 列拖排 + doing→todo 硬错误，中英各一份。"""
    pid = srv.create_project(srv.admin, "i18n-board")
    code, text = srv.admin(f"/api/projects/{pid}/board/cards", "POST",
                           {"title": "c"})
    cid = json.loads(text)["id"]
    # done 列默认 entered_desc（非 manual）⇒ 拖排 400
    _sql(srv, "UPDATE board_cards SET column_key='done' WHERE id=?", (cid,))
    en = _new_client(srv, {"X-TS-Lang": "en"})
    reorder = f"/api/projects/{pid}/board/reorder"
    code, text = srv.admin(reorder, "POST", {"card_id": cid, "before_id": None})
    assert (code, text) == (400, '{"error": "当前列排序方案非手动，不可拖排"}')
    code, text = en(reorder, "POST", {"card_id": cid, "before_id": None})
    assert (code, text) == (400, '{"error": "This column does not use manual ordering, '
                                 'so drag reordering is unavailable"}')

    # doing → todo 硬错误（先改列；move 在出队前就拒绝，不碰会话）
    _sql(srv, "UPDATE board_cards SET column_key='doing', block_kind='queue' WHERE id=?",
         (cid,))
    move = f"/api/projects/{pid}/board/cards/{cid}/move"
    code, text = srv.admin(move, "POST", {"column": "todo"})
    assert (code, text) == (400, '{"error": "doing 不可直接拖回 todo"}')
    code, text = en(move, "POST", {"column": "todo"})
    assert (code, text) == (400, '{"error": "A card cannot be dragged directly from doing back to todo"}')


def test_endpoint_chat_delivery_refused_english_real(monkeypatch):
    """真链路：外部会话（宿主无活 agent）⇒ DeliveryRefused ⇒ 400 英文。

    外部会话必须**在 dshevents 对齐之前**已在驱动快照里（dshevents 只在连接建立时
    做一次 `/live` 权威对齐），故给 `FakeDriver.__init__` 预置一条 unknown 外部会话
    后另起一个隔离实例。
    """
    from fakedriver import FakeDriver

    orig_init = FakeDriver.__init__

    def seeded_init(self, *args, **kwargs):
        orig_init(self, *args, **kwargs)
        self.external["ext-dead-1"] = {"sid": "ext-dead-1", "cwd": "",
                                       "status": "unknown", "interaction": None}

    monkeypatch.setattr(FakeDriver, "__init__", seeded_init)
    instance = IsolatedServer()
    try:
        instance.start()
        pid = instance.create_project(instance.admin, "i18n-deliver")
        code, text = instance.admin(f"/api/projects/{pid}/board/cards", "POST",
                                    {"title": "c"})
        cid = json.loads(text)["id"]
        sid = "ext-dead-1"
        instance.admin(f"/api/projects/{pid}/board/cards/{cid}", "PATCH",
                       {"bind_session": sid})

        def _aligned():
            code, d = instance.admin.json(
                f"/api/projects/{pid}/board/session/messages?sid={sid}")
            return code == 200 and d.get("owned") is False

        assert instance.wait_until(_aligned, timeout=20, interval=0.5), "dshevents 未对齐"
        code, text = instance.admin(f"/api/projects/{pid}/board/cards/{cid}/comments",
                                    "POST", {"text": "hi"})
        comment_id = json.loads(text)["id"]
        send = f"/api/projects/{pid}/board/cards/{cid}/comments/{comment_id}/send"
        code, text = instance.admin(send, "POST", {})
        assert (code, text) == (400, '{"error": "会话已结束，无法投递（宿主无活动 agent）"}')
        en = _new_client(instance, {"X-TS-Lang": "en"})
        code, text = en(send, "POST", {})
        assert (code, text) == (400, '{"error": "The session has ended and cannot receive '
                                     'deliveries (no active agent in the host)"}')
    finally:
        instance.stop()


def _sql(srv, statement, params=()):
    """直接改隔离实例的库（测试造状态；服务端每次操作自开连接，改完即见）。"""
    conn = sqlite3.connect(srv.db_path, timeout=10)
    try:
        conn.execute(statement, params)
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# ⑥ 覆盖门禁：所有中文错误文案都有 api 词条（缺失时逐条列出）
#
# 两道门禁（镜像 T10 审查 Minor 2 加固后）：
#   ① server.py：`self._error/_error_spaced` 的 message 只接受「精确词条 key /
#      `{占位符}` key / 同文件中文常量 / 已知透传名（err/e/exc/message/msg）」；
#      表达式里夹中文字面量、中文 f-string 直接进 helper、`_respond` 直发错误体
#      一律判失败；
#   ② lib 层：按 `backend_py/user_messages.py` 的登记表扫描类/函数里的用户可见文案，
#      并校验 `i18n.localizable()/message_vars()` 的 key 是字面量、占位符在 vars 里。
# --------------------------------------------------------------------------
def _is_i18n_call(node):
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr in ("message_vars", "localizable")
            and isinstance(node.func.value, ast.Name) and node.func.value.id == "i18n")


def _walk_pruned(node):
    """遍历 AST，但不进入 message_vars/localizable 的实参子树（其 key 单独校验）。"""
    yield node
    if _is_i18n_call(node):
        return
    for child in ast.iter_child_nodes(node):
        yield from _walk_pruned(child)


def _wrapped_key_arg(call):
    return call.args[1] if call.func.attr == "localizable" else call.args[0]


def _wrapped_vars_arg(call):
    if call.func.attr == "localizable":
        return call.args[2] if len(call.args) > 2 else None
    return call.args[1] if len(call.args) > 1 else None


def _literal(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


class _Coverage:
    def __init__(self):
        self.required = {}
        self.problems = []

    def require(self, key, where):
        if not isinstance(key, str) or not HAN.search(key):
            return
        self.required.setdefault(key, set()).add(where)

    def scan_wrappers(self, node, rel):
        for sub in ast.walk(node):
            if not _is_i18n_call(sub):
                continue
            where = f"{rel}:{sub.lineno}（{sub.func.attr}）"
            key_node = _wrapped_key_arg(sub)
            source = ast.dump(key_node)
            # 允许的变量直传（与 Node 门禁同口径）：异常自带的 i18n_key 桥
            # （board 的 userErrText 镜像：message_vars(e.i18n_key, e.i18n_vars)），
            # 其词条已由 localizable() 调用点的字面量校验覆盖。
            if isinstance(key_node, ast.Attribute) and key_node.attr == "i18n_key":
                continue
            key = _literal(key_node)
            if key is None:
                self.problems.append(f"{where}：词条 key 必须是精确中文字符串字面量")
                continue
            self.require(key, where)
            holders = sorted(set(PLACEHOLDER.findall(key)))
            var_node = _wrapped_vars_arg(sub)
            if not holders:
                continue
            if not isinstance(var_node, ast.Dict):
                if var_node is not None:
                    self.problems.append(f"{where}：词条 {key!r} 含占位符，但 vars 不是字典字面量")
                continue
            var_keys = {k.value for k in var_node.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)}
            for holder in holders:
                if holder not in var_keys:
                    self.problems.append(
                        f"{where}：词条 {key!r} 的占位符 {{{holder}}} 在 vars 里找不到")

    def scan_statements(self, expr, rel, where):
        if expr is None:
            return
        self.scan_wrappers(expr, rel)
        for sub in _walk_pruned(expr):
            if isinstance(sub, ast.JoinedStr):
                tmpl = "".join(v.value if isinstance(v, ast.Constant) else "{x}"
                               for v in sub.values)
                if HAN.search(tmpl):
                    self.problems.append(
                        f"{rel}:{sub.lineno}：raise/return 里的 f-string 文案含中文插值，"
                        f"请改用 i18n.message_vars/localizable（原文：{tmpl[:60]}）")
                continue
            if isinstance(sub, ast.Constant) and isinstance(sub.value, str) \
                    and HAN.search(sub.value):
                self.require(sub.value, where)


def _module_constants(tree):
    out = {}

    def collect(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = collect(node.left), collect(node.right)
            return None if left is None or right is None else left + right
        return None

    for n in tree.body:
        if isinstance(n, ast.Assign):
            for target in n.targets:
                if isinstance(target, ast.Name):
                    value = collect(n.value)
                    if value is not None:
                        out[target.id] = value
    return out


def _unwrap_encode(node):
    """剥掉 `.encode(...)` 包装，返回内层表达式（无包装时原样返回）。

    旧写点有两种等价形态：裸字节串/字符串字面量，以及 `'…'.encode("utf-8")` /
    `json.dumps({...}).encode("utf-8")`。后者是 `ast.Call`（`func.value` 才是被包装
    的表达式），不能只看最外层，否则门禁会漏判（T11 fix round 1 审查 Important 1）。
    """
    while (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
           and node.func.attr == "encode"):
        node = node.func.value
    return node


def _scan_server(cov, src=None):
    rel = "backend_py/server.py"
    if src is None:
        src = (BACKEND / "server.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    consts = _module_constants(tree)
    for name, value in consts.items():
        if HAN.search(value):
            cov.require(value, f"{rel}（常量 {name}）")
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call) or not isinstance(n.func, ast.Attribute):
            continue
        is_self = isinstance(n.func.value, ast.Name) and n.func.value.id == "self"
        if not is_self:
            continue
        if n.func.attr in ("_error", "_error_spaced"):
            where = f"{rel}:{n.lineno}"
            if len(n.args) < 2:
                cov.problems.append(f"{where}：_error* 缺 message 实参")
                continue
            msg = n.args[1]
            cov.scan_wrappers(msg, rel)
            if isinstance(msg, ast.Constant) and isinstance(msg.value, str):
                cov.require(msg.value, where)
                continue
            if isinstance(msg, ast.JoinedStr):
                tmpl = "".join(v.value if isinstance(v, ast.Constant) else "{x}"
                               for v in msg.values)
                if HAN.search(tmpl):
                    cov.problems.append(
                        f"{where}：_error* 的 message 是含中文的 f-string，请改用 key+vars"
                        f"（原文：{tmpl[:60]}）")
                continue
            if isinstance(msg, ast.Call) and not _is_i18n_call(msg):
                # 已知透传：lib 返回的 {"error": ...} 取 error 字段（err.get('error')）。
                # 其余函数调用（如 self._error(400, helper())）无法静态校验，直接判失败。
                known_get = (isinstance(msg.func, ast.Attribute)
                             and msg.func.attr == "get"
                             and isinstance(msg.func.value, ast.Name)
                             and msg.func.value.id in ("err", "e", "exc", "message", "msg")
                             and len(msg.args) == 1
                             and _literal(msg.args[0]) == "error")
                if not known_get:
                    cov.problems.append(
                        f"{where}：错误文案来自函数调用，无法静态校验；请内联词条 key "
                        "或使用已知透传形式 err.get('error')")
            for sub in _walk_pruned(msg):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str) \
                        and HAN.search(sub.value):
                    cov.problems.append(
                        f"{where}：_error* 的 message 表达式里夹中文字面量，"
                        f"无法保证英文模式可用：{sub.value[:60]!r}")
            if isinstance(msg, ast.Name):
                if msg.id in consts and HAN.search(consts[msg.id]):
                    cov.require(consts[msg.id], f"{rel}（常量 {msg.id}）")
                elif msg.id not in ("err", "e", "exc", "message", "msg"):
                    cov.problems.append(
                        f"{where}：错误文案来自变量 {msg.id}，无法静态校验；"
                        "请内联词条 key 或使用已知透传名（err/e/exc/message/msg）")
        elif n.func.attr == "_respond" and len(n.args) >= 2:
            # 先剥掉 `.encode(...)` 包装，再判内层是错误 JSON 字面量 / json.dumps(...)
            body = _unwrap_encode(n.args[1])
            bad = False
            if isinstance(body, ast.Constant) and isinstance(body.value, (bytes, str)):
                raw = body.value.decode("utf-8", "replace") \
                    if isinstance(body.value, bytes) else body.value
                try:
                    obj = json.loads(raw)
                except ValueError:
                    obj = None
                bad = isinstance(obj, dict) and "error" in obj
            elif isinstance(body, ast.Call) and isinstance(body.func, ast.Attribute) \
                    and body.func.attr == "dumps" and isinstance(body.args[0], ast.Dict):
                bad = any(isinstance(k, ast.Constant) and k.value == "error"
                          for k in body.args[0].keys)
            if bad:
                cov.problems.append(
                    f"{rel}:{n.lineno}：错误体写在 _respond 里，请改走 self._error/_error_spaced")

    # 错误码消息表（函数内 messages = {code: "中文"}）：必须单独再走一遍 Assign。
    # 不能塞进上面的 Call 分支循环——那个循环对非 Call 节点 `continue`，Assign 永远
    # 不会被执行（T11 fix round 1 审查 Important 2：三个 _api_project_file 词条因此
    # 从未进入 required，删词条门禁仍绿）。
    for n in ast.walk(tree):
        if not isinstance(n, ast.Assign) or not isinstance(n.value, ast.Dict):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "messages" for t in n.targets):
            continue
        for value in n.value.values:
            if isinstance(value, ast.Tuple):
                for elt in value.elts:
                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str) \
                            and HAN.search(elt.value):
                        cov.require(elt.value, f"{rel}:{n.lineno}（messages 表）")


def _scan_lib(cov, sources):
    for fname, spec in sources.items():
        path = BACKEND / fname
        if not path.is_file():
            cov.problems.append(f"lib 登记表指向不存在的文件：{fname}")
            continue
        rel = f"backend_py/{fname}"
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src)
        consts = _module_constants(tree)
        # 模块内所有 localizable()/message_vars() 调用都要求词条（wrapper 子树被下面
        # 的剪枝遍历跳过，不能靠类/函数扫描兜底）
        cov.scan_wrappers(tree, rel)
        for cls in spec.get("classes", []):
            found = False
            for n in _walk_pruned(tree):
                if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                        and n.func.id == cls):
                    continue
                found = True
                for arg in n.args:
                    cov.scan_wrappers(arg, rel)
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        cov.require(arg.value, f"{rel}（{cls}）")
                    elif isinstance(arg, ast.JoinedStr):
                        tmpl = "".join(v.value if isinstance(v, ast.Constant) else "{x}"
                                       for v in arg.values)
                        if HAN.search(tmpl):
                            cov.problems.append(
                                f"{rel}:{arg.lineno}：{cls}() 的消息含中文 f-string 插值，"
                                "请改用 i18n.localizable（附加 i18n_key/i18n_vars）")
                    elif isinstance(arg, ast.Name) and arg.id in consts:
                        cov.require(consts[arg.id], f"{rel}（常量 {arg.id}）")
            if not found:
                cov.problems.append(f"{rel}：登记表里的类 {cls} 没有实例化点")
        for fn in spec.get("functions", []):
            found = None
            for n in ast.walk(tree):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == fn:
                    found = n
                    break
            if found is None:
                cov.problems.append(f"{rel}：登记表里的函数 {fn} 不存在（改名后请同步更新登记表）")
                continue
            for stmt in ast.walk(found):
                if isinstance(stmt, ast.Raise):
                    cov.scan_statements(stmt.exc, rel, f"{rel}（{fn}）")
                elif isinstance(stmt, ast.Return):
                    cov.scan_statements(stmt.value, rel, f"{rel}（{fn}）")
                elif isinstance(stmt, ast.Dict) and any(
                        isinstance(k, ast.Constant) and k.value == "error"
                        for k in stmt.keys):
                    for value in stmt.values:
                        if isinstance(value, ast.Constant) and isinstance(value.value, str) \
                                and HAN.search(value.value):
                            cov.require(value.value, f"{rel}（{fn}）")
        for cname in spec.get("constants", []):
            if cname not in consts:
                cov.problems.append(f"{rel}：登记表里的中文常量 {cname} 不存在或不是字面量")
            else:
                cov.require(consts[cname], f"{rel}（常量 {cname}）")
        for key in spec.get("keys", []):
            if key not in src:
                cov.problems.append(f"{rel}：登记表里的词条 {key!r} 在源码中找不到")
            cov.require(key, f"{rel}（登记词条）")


def _entry_values(api, key):
    if key not in api:
        return []
    entry = api[key]
    if isinstance(entry, str):
        return [entry]
    if isinstance(entry, dict):
        return [v for v in entry.values() if isinstance(v, str)]
    return []


def test_coverage_every_chinese_error_has_api_entry():
    import user_messages

    cov = _Coverage()
    _scan_server(cov)
    _scan_lib(cov, user_messages.LIB_USER_MESSAGE_SOURCES)

    api = i18n.load_dict().get("api") or {}
    missing = []
    for key in sorted(cov.required):
        values = _entry_values(api, key)
        if not values:
            missing.append(f"  - {key!r}\n      写点: {', '.join(sorted(cov.required[key]))}")
            continue
        for value in values:
            if HAN.search(value):
                cov.problems.append(f"  - {key!r}：英文词条里仍有中文：{value!r}")
            if sorted(set(PLACEHOLDER.findall(value))) != \
                    sorted(set(PLACEHOLDER.findall(key))):
                cov.problems.append(
                    f"  - {key!r}：占位符不一致（原文 {PLACEHOLDER.findall(key)} / "
                    f"译文 {PLACEHOLDER.findall(value)}）")
    report = []
    if missing:
        report.append(f"缺少 api 词条（{len(missing)} 条）：\n" + "\n".join(missing))
    if cov.problems:
        report.append(f"词条/写法问题（{len(cov.problems)} 条）：\n" + "\n".join(cov.problems))
    assert report == [], "Python 错误文案本地化覆盖检查失败：\n" + "\n\n".join(report)


# --------------------------------------------------------------------------
# ⑥ 门禁自测：审查 fix round 1 的两个盲区 + Call 绕过
#    —— 用假 server.py 源码直接喂 _scan_server，不依赖真实文件（防止门禁又悄悄失明）
# --------------------------------------------------------------------------

def test_gate_flags_encode_wrapped_error_bodies():
    """审查 Important 1 回归：`.encode()` 包装的两种旧写点都必须被判失败。

    审查用假 server.py 探针验证旧门禁对这两形态 0 problems；修复后必须两条都报
    「错误体写在 _respond 里」。同时放一条正常的 200 响应，确认不是把 .encode 全判死。
    """
    probe = (
        "def probe(self):\n"
        "    self._respond(400, '{\"error\":\"中文\"}'.encode(\"utf-8\"), CT)\n"
        "    self._respond(400, json.dumps({\"error\": \"中文\"}).encode(\"utf-8\"), CT)\n"
        "    self._respond(200, json.dumps({\"ok\": True}).encode(\"utf-8\"), CT)\n"
    )
    cov = _Coverage()
    _scan_server(cov, probe)
    flagged = [p for p in cov.problems if "错误体写在 _respond 里" in p]
    assert len(flagged) == 2, cov.problems
    assert ":2" in flagged[0], flagged[0]
    assert ":3" in flagged[1], flagged[1]


def test_gate_requires_file_preview_message_table_keys():
    """审查 Important 2 回归：函数内 `messages = {...}` 的三个词条必须进入 required。"""
    cov = _Coverage()
    _scan_server(cov)
    for key in ("path 不能为空", "路径不在项目目录/工作目录范围内",
                "该路径是目录，暂不支持预览"):
        where = sorted(cov.required.get(key, ()))
        assert where, f"{key!r} 未进入 required（messages 表扫描又失效了）"
        assert any("messages 表" in item for item in where), where


def test_gate_is_red_when_file_preview_key_removed(monkeypatch):
    """审查 Important 2 的 RED 证据固化成用例：删掉词条，门禁必须报缺并带写点。"""
    api = dict(i18n.load_dict().get("api") or {})
    api.pop("path 不能为空", None)
    monkeypatch.setattr(i18n, "load_dict", lambda: {"api": api})
    with pytest.raises(AssertionError) as caught:
        test_coverage_every_chinese_error_has_api_entry()
    text = str(caught.value)
    assert "缺少 api 词条" in text, text
    assert "'path 不能为空'" in text, text
    assert "messages 表" in text, text


def test_gate_flags_arbitrary_call_message():
    """门禁不再放过 `self._error(400, helper())` 这类无法静态校验的函数调用文案。"""
    probe = (
        "def probe(self):\n"
        "    self._error(400, helper())\n"
    )
    cov = _Coverage()
    _scan_server(cov, probe)
    assert any("错误文案来自函数调用" in p for p in cov.problems), cov.problems


def test_server_fork_missing_id_message_has_api_entry():
    """审查 Cheap Minor：`fork 未返回新会话 id` 也要有英文词条（嵌套 detail 留给 T16）。"""
    api = i18n.load_dict().get("api") or {}
    assert api.get("fork 未返回新会话 id") == "Fork did not return a new session id"
