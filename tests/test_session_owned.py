#!/usr/bin/env python3
"""会话归属三态（`meta.owned`）与外部会话拒投文案收口（C 批 T8，2026-10-10）。

同一件事的两面——用户在会话窗里看到的东西：

1. **T8 下发**：`_api_board_session_messages` 增 `data["owned"]`，三态＝
   `True`（平台自持）/ `False`（外部会话，用户在 dsh GUI 直跑/接管）/ `None`
   （注册表未知：未连接 / 热重载后未对齐 / 没见过该 sid ⇒ 前端**按「池内」渲染**，
   与现状一致——「未知 ≠ 外部」是本批统一判定阶梯）。派生收口在 `server._session_owned`
   （与投递前置闸 `chat._external_preflight` 的阶梯逐条对齐）。
2. **T5 评审 Important 3**：任务会话端点 `_api_session_chat` 必须 catch
   `chat.DeliveryRefused`（`RuntimeError` 子类）并回 400 明确文案——否则前置闸的
   拒绝会逃逸成连接重置，用户拿到断连而不是「会话已结束，无法投递」这类文案。
   `dshdriver.DshDriverError` 同样是 RuntimeError 子类，故既有的 409/500 映射
   必须先命中（下面的同序守卫钉死这一点）。

本文件不起 HTTP（最小 handler 替身直接调端点方法 + 注册表读口打桩），毫秒级。
"""
import json
import os
import re

import chat
import dshdriver
import server


class _FakeHandler:
    """最小 handler 替身：只实现 `_api_session_chat` 依赖的两个成员。

    `_api_session_chat` 只读 `self._session_context`、写 `self._respond`（外加
    `chat`/`dshdriver` 两个模块级符号），故无需真 socket/鉴权链路即可直接调。
    """

    def __init__(self, ctx):
        self._ctx = ctx
        self.resp = []                  # [(code, body), ...] 记录响应，供断言

    def _session_context(self, task_id):
        return self._ctx

    def _respond(self, code, body, ctype=None):
        self.resp.append((code, body))

    _api_session_chat = server.Handler._api_session_chat


# (task, project, family)：会话 id 非空、族在可对话白名单内
_CTX = ({"id": 7, "session_id": "sess-t8", "model": ""},
        {"id": 3, "agent_path": "dsh-plugin:/tmp/dsh", "model": ""},
        "dsh_plugin")


def _handler():
    return _FakeHandler(_CTX)


def _error(h):
    """取首个响应的 (code, 中文错误文案)。"""
    code, body = h.resp[0]
    return code, json.loads(body.decode("utf-8"))["error"]


# ---------- ① 拒投文案收口（T5 评审 Important 3） ----------

def test_delivery_refused_maps_to_400(monkeypatch):
    """外部会话前置闸拒投（DeliveryRefused）⇒ 400 + 原样文案（不得逃逸成断连）。"""
    def _refuse(*_a, **_k):
        raise chat.DeliveryRefused("会话已结束，无法投递（宿主无活动 agent）")
    monkeypatch.setattr(chat, "start", _refuse)
    h = _handler()
    h._api_session_chat(7, {"message": "你好"})
    code, err = _error(h)
    assert code == 400
    assert err == "会话已结束，无法投递（宿主无活动 agent）"


def test_driver_error_409_keeps_409(monkeypatch):
    """同序守卫：DshDriverError 也是 RuntimeError 子类，既有的 409 映射必须先命中。"""
    def _busy(*_a, **_k):
        raise dshdriver.DshDriverError(409, "会话运行中")
    monkeypatch.setattr(chat, "start", _busy)
    h = _handler()
    h._api_session_chat(7, {"message": "你好"})
    assert _error(h) == (409, "会话运行中")


def test_driver_error_500_keeps_500(monkeypatch):
    """同序守卫：非 409 的驱动错误照旧 500（不被新兜底改成 400）。"""
    def _boom(*_a, **_k):
        raise dshdriver.DshDriverError(-2, "驱动不可达")
    monkeypatch.setattr(chat, "start", _boom)
    h = _handler()
    h._api_session_chat(7, {"message": "你好"})
    code, err = _error(h)
    assert code == 500
    assert err == "agent 调用失败: 驱动不可达"


def test_chat_ok_still_200(monkeypatch):
    """正常路径不受影响：200 + 队列/消息字段照旧。"""
    monkeypatch.setattr(chat, "start", lambda *_a, **_k: {
        "queued": True, "id": "m1", "state": "queued", "prompt_id": "p1"})
    h = _handler()
    h._api_session_chat(7, {"message": "你好"})
    code, body = h.resp[0]
    assert code == 200
    assert json.loads(body.decode("utf-8")) == {
        "ok": True, "queued": True, "msg_id": "m1", "state": "queued", "prompt_id": "p1"}


# ---------- ② owned 三态下发 ----------

def _registry(monkeypatch, st, aligned=True):
    """把注册表读口桩成「给定条目 + 对齐态」（`dshevents.get`/`aligned` 读口）。"""
    monkeypatch.setattr(server.dshevents, "get", lambda _sid: st)
    monkeypatch.setattr(server.dshevents, "aligned", lambda: aligned)


def test_owned_true_for_platform_session(monkeypatch):
    """平台自持（驱动池内）会话 ⇒ True：前端照现状渲染（无提示、停止可用）。"""
    _registry(monkeypatch, {"owned": True})
    assert server._session_owned("s1") is True


def test_owned_false_for_external_session(monkeypatch):
    """外部会话（dsh GUI 直跑/接管，owned=false）⇒ False：前端提示 + 停止置灰。"""
    _registry(monkeypatch, {"owned": False})
    assert server._session_owned("s1") is False


def test_owned_none_when_registry_unknown(monkeypatch):
    """注册表没有该会话（未连接/没见过）⇒ None＝未知，前端按「池内」渲染。"""
    _registry(monkeypatch, None)
    assert server._session_owned("s1") is None


def test_owned_none_when_snapshot_not_aligned(monkeypatch):
    """快照未对齐（热重载后 /live 空表）⇒ None：不可信快照绝不判成外部会话。"""
    _registry(monkeypatch, {"owned": False}, aligned=False)
    assert server._session_owned("s1") is None


# ---------- ③ 前端断链静态守卫：board 轮询重建 meta 必须原样带过 owned ----------

SESSION_VIEW = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "webui", "src", "components", "SessionView.jsx")


def _strip_line_comments(text):
    """去掉整行 `//` 注释（本仓 JSX 注释均为整行式），防注释里的字样冒充代码。

    与 tests/test_plugin_client_tokens.py 的静态守卫同一范式（先例：那里对
    `dsh-plugin/src/client.js` 做 token 引用静态断言）。
    """
    return "\n".join("" if ln.lstrip().startswith("//") else ln for ln in text.split("\n"))


def _board_meta_rebuild_body():
    """取 board 轮询 tick 里重建 meta 的 `setMeta((prev) => ({ … }))` 对象内部文本。

    锚点＝tick 内唯一一处 `boardApi.sessionMessages(boardPid, boardSid, …)` 调用；
    从锚点往后第一个 `setMeta((prev) => ({` 起按花括号配平截到配对的 `}`。定位不到
    一律返回 None，由调用方 FAIL——口径失效必须响，绝不静默放行。
    """
    with open(SESSION_VIEW, encoding="utf-8") as fh:
        src = _strip_line_comments(fh.read())
    m = re.search(r"boardApi\.sessionMessages\(boardPid,\s*boardSid,", src)
    if not m:
        return None
    start = src.find("setMeta((prev) => ({", m.end())
    if start < 0:
        return None
    open_idx = src.index("{", start)
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:i]
    return None


def test_board_meta_rebuild_keeps_owned():
    """board 轮询用显式白名单重建 meta，`owned` 必须在这份白名单里。

    断链场景（2026-10-10 评审 Critical）：后端 `data["owned"]` 已下发、纯函数
    `ownedHint`/`canStop` 与前端单测都正确，但 board 模式的 meta **只**来自这份
    白名单（任务模式走 SSE `meta` 事件，而任务端点不下发 owned）——白名单漏一个键，
    `meta.owned` 恒为 undefined ⇒ 提示条永不渲染、「停止」永不置灰，`SessionView`
    的消费与 `ComposerBar` 的 disabled 全成死代码。故静态钉住：键名逐字 `owned`、
    取值来源 `d.owned`（与后端下发的键一致，不得改名）。
    """
    body = _board_meta_rebuild_body()
    assert body is not None, (
        f"口径失效：在 {SESSION_VIEW} 里定位不到 board 轮询的 meta 重建对象"
        "（锚点 boardApi.sessionMessages(boardPid, boardSid, …) 之后应紧跟 "
        "setMeta((prev) => ({ … }))）")
    assert "found: d.found" in body, (
        "口径失效：截到的对象不是 board 轮询的 meta 重建对象（缺少既有键 found: d.found）")
    assert re.search(r"\bowned\s*:\s*d\.owned\b", body), (
        "board 轮询重建 meta 时漏掉了 owned（键须逐字为 owned、取值 d.owned）——"
        "后端下发的 owned 到不了前端，外部会话提示条与「停止」置灰全是死代码。\n"
        f"实际重建对象：\n{body.strip()}")
