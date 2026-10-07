#!/usr/bin/env python3
"""进程内变更总线与看板 SSE 端点（P4 前端事件化）。

覆盖：总线语义（单调序号 / 超时返回原值 / 变化立即唤醒）、db 写路径发信号、
SSE 端点（hello + refresh 帧 + dsh 帧按绑定会话过滤）。
"""
import io
import json
import threading
import time
import uuid

import db
import dshevents
import localbus
import server


def _mk_project(name="ev"):
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"{name}-{uid}", f"/tmp/{name}-{uid}",
                            "dsh-plugin:/usr/bin/dsh", f"/tmp/{name}-{uid}/work")
    return db.get_project(pid)


# ---------- 总线语义 ----------

def test_bus_seq_and_wait():
    """序号单调；无变化时 wait 超时返回原值；有变化时立即返回新值。"""
    bus = localbus.ChangeBus()
    topic = ("board", 7)
    assert bus.seq(topic) == 0
    assert bus.wait(topic, 0, 0.05) == 0          # 超时：序号不变（调用方据此发 keepalive）
    bus.publish(topic)
    bus.publish(topic)
    assert bus.seq(topic) == 2
    assert bus.wait(topic, 0, 0.05) == 2          # 落后即立刻返回（不等待）
    threading.Timer(0.05, lambda: bus.publish(topic)).start()
    started = time.monotonic()
    assert bus.wait(topic, 2, 2.0) == 3           # 被唤醒
    assert time.monotonic() - started < 1.5


def test_bus_topic_isolation_and_board_topic():
    """不同项目的 topic 互不唤醒；board_topic 归一成 int。"""
    bus = localbus.ChangeBus()
    bus.publish(localbus.board_topic("9"))
    assert bus.seq(("board", 9)) == 1
    assert bus.seq(("board", 8)) == 0
    assert bus.wait(("board", 8), 0, 0.05) == 0


def test_bus_publish_never_raises(monkeypatch):
    """发布路径吞异常（通知失败绝不影响业务写）。"""
    bus = localbus.ChangeBus()

    class _Boom:
        def __enter__(self):
            raise RuntimeError("lock 坏了")
        def __exit__(self, *a):
            return False
    monkeypatch.setattr(bus, "_cond", _Boom())
    bus.publish(("board", 1))                     # 不抛


# ---------- db 写路径发信号 ----------

def test_db_card_writes_publish_board_signal():
    """卡片增/改/删/回收站/还原都发本项目信号（前端据此重取）。"""
    proj = _mk_project()
    pid = proj["id"]
    topic = localbus.board_topic(pid)
    base = localbus.seq(topic)

    cid = db.insert_board_card(pid, "卡")
    assert localbus.seq(topic) == base + 1        # 新建

    db.update_board_card(cid, column_key="doing")
    assert localbus.seq(topic) == base + 2        # 改列

    db.trash_board_card(cid)
    assert localbus.seq(topic) == base + 3        # 回收站
    db.restore_board_card(cid)
    assert localbus.seq(topic) == base + 4        # 还原
    db.purge_board_card(cid)
    assert localbus.seq(topic) == base + 5        # 真删

    # 项目隔离：别的项目的卡片写只动自己的 topic
    other = _mk_project(name="ev2")
    assert localbus.seq(localbus.board_topic(other["id"])) == 0
    db.insert_board_card(other["id"], "别的卡")
    assert localbus.seq(localbus.board_topic(other["id"])) == 1
    assert localbus.seq(topic) == base + 5            # 本项目不受影响


# ---------- SSE 端点 ----------

class _WFile:
    """假 wfile：记录**每次写尝试**（attempts）+ 累计落盘字节（buf）。

    允许 limit 次写，之后任何写都抛 BrokenPipeError（模拟客户端断连 →
    SSE handler 收尾退出）。记「尝试」而非只记落盘字节，让断言不受 keepalive
    与断连时机影响（确定性）。
    """

    def __init__(self, limit):
        self.buf = b""
        self.attempts = []
        self.limit = limit

    def write(self, data):
        self.attempts.append(data)
        if len(self.attempts) > self.limit:
            raise BrokenPipeError("客户端已断开")
        self.buf += data

    def flush(self):
        pass


class _FakeHandler:
    def __init__(self, wfile):
        self.wfile = wfile
        self.status = None
        self.headers = []

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.headers.append((k, v))

    def end_headers(self):
        pass

    def _respond(self, code, body=b"", ctype=""):
        self.status = code

    def _owned_project(self, pid):
        return db.get_project(pid)

    def _board_owns_sid(self, row, sid):
        """真实语义的简化版（本项目卡片会话并集）——供会话流端点用。"""
        for c in db.list_board_cards(row["id"]):
            if sid in json.loads(c["sessions"] or "[]") or c["session_id"] == sid:
                return c
        return None


def test_board_stream_hello_refresh_and_dsh_filter(monkeypatch):
    """SSE：hello 即发；本项目卡片写路径 → refresh；dsh 帧只认本项目绑定的会话。"""
    proj = _mk_project()
    pid = proj["id"]
    cid = db.insert_board_card(pid, "在跑卡")
    db.update_board_card(cid, column_key="doing", session_id="session-a")

    captured = {}
    real_subscribe = dshevents.subscribe

    def fake_subscribe(cb):
        captured["cb"] = cb                       # 捕获 dsh 帧回调，手工驱动
        return cb
    monkeypatch.setattr(server.dshevents, "subscribe", fake_subscribe)
    monkeypatch.setattr(server.dshevents, "unsubscribe", lambda cb: None)

    # limit=2：hello + 首个 refresh 落盘；第三次写（第二个 refresh）触发断连收尾
    wfile = _WFile(limit=2)
    handler = _FakeHandler(wfile)
    thread = threading.Thread(
        target=server.Handler._api_board_stream, args=(handler, pid), daemon=True)
    thread.start()
    time.sleep(0.3)

    # ① 本项目卡片写路径 → 信号 → refresh
    db.update_board_card(cid, title="改名")
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and len(wfile.attempts) < 2:
        time.sleep(0.02)
    assert len(wfile.attempts) == 2, wfile.attempts      # hello + refresh
    # ② 非本项目会话的 dsh 帧：被过滤，不产生任何写
    captured["cb"]({"type": "agent/status", "session_id": "session-other",
                    "data": {"status": "running"}})
    time.sleep(0.3)
    assert len(wfile.attempts) == 2, "非绑定会话的帧不该触发 refresh"
    # ③ 本项目绑定会话的 dsh 帧：发信号 → 第二次 refresh → 写超限 → 线程收尾
    captured["cb"]({"type": "agent/status", "session_id": "session-a",
                    "data": {"status": "running"}})
    thread.join(timeout=3)
    assert not thread.is_alive(), "SSE 端点未在客户端断开后收尾"

    kinds = [a.split(b"\n", 1)[0] for a in wfile.attempts]
    assert kinds == [b"event: hello", b"event: refresh", b"event: refresh"], kinds
    assert handler.status == 200
    assert ("Content-Type", "text/event-stream; charset=utf-8") in handler.headers
    assert json.loads(wfile.buf.split(b"data: ", 1)[1].split(b"\n", 1)[0])["project_id"] == pid


def test_session_stream_hello_and_refresh(monkeypatch):
    """会话流：hello 即发（带 events 标记）；该 sid 的状态帧 → refresh；别的 sid 不发。"""
    proj = _mk_project()
    pid = proj["id"]
    cid = db.insert_board_card(pid, "在跑卡")
    db.update_board_card(cid, column_key="doing", session_id="session-a")

    captured = {}

    def fake_subscribe(cb):
        captured["cb"] = cb
        return cb
    monkeypatch.setattr(server.dshevents, "subscribe", fake_subscribe)
    monkeypatch.setattr(server.dshevents, "unsubscribe", lambda cb: None)
    # keepalive 等待缩短（真实现 15s）：让「写 keepalive → 断连收尾」在测试里立刻发生
    real_wait = localbus.wait
    monkeypatch.setattr(server.localbus, "wait",
                        lambda topic, since, timeout: real_wait(topic, since, 0.2))

    def refresh_count():
        return sum(1 for a in wfile.attempts if a.startswith(b"event: refresh"))

    wfile = _WFile(limit=50)                      # 先不断连；收尾时再置 limit 逼线程退出
    handler = _FakeHandler(wfile)
    thread = threading.Thread(
        target=server.Handler._api_board_session_stream,
        args=(handler, pid, "session-a"), daemon=True)
    thread.start()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not any(
            a.startswith(b"event: hello") for a in wfile.attempts):
        time.sleep(0.02)
    assert refresh_count() == 0, wfile.attempts          # hello 阶段无 refresh

    # 别的会话的帧：不发信号
    captured["cb"]({"type": "transcript", "session_id": "session-b",
                    "data": {"event_seq": 3}})
    time.sleep(0.3)
    assert refresh_count() == 0, "别的会话的帧不该唤醒本连接"
    # 本会话的帧（逐条消息 transcript）→ refresh
    captured["cb"]({"type": "transcript", "session_id": "session-a",
                    "data": {"event_seq": 4, "kind": "assistant/message"}})
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and refresh_count() == 0:
        time.sleep(0.02)
    assert refresh_count() == 1, wfile.attempts

    wfile.limit = len(wfile.attempts)              # 下一次写（keepalive）即断连
    thread.join(timeout=3)
    assert not thread.is_alive(), "会话流未在客户端断开后收尾"

    hello = [a for a in wfile.attempts if a.startswith(b"event: hello")][0]
    payload = json.loads(hello.split(b"data: ", 1)[1].split(b"\n", 1)[0])
    assert payload["session_id"] == "session-a" and payload["events"] is True


def test_session_stream_rejects_unbound_sid(monkeypatch):
    """sid 不属于本项目卡片 → 404（防经会话端点读任意会话）。"""
    proj = _mk_project()
    wfile = _WFile(limit=1)
    handler = _FakeHandler(wfile)
    server.Handler._api_board_session_stream(handler, proj["id"], "session-x")
    assert handler.status == 404 and wfile.attempts == []


def test_board_stream_rejects_foreign_project(monkeypatch):
    """非本项目（越权）→ 404，且不进入长连接循环。"""
    proj = _mk_project()
    wfile = _WFile(limit=1)
    handler = _FakeHandler(wfile)
    handler._owned_project = lambda pid: None         # 模拟 _owned_project 判负
    server.Handler._api_board_stream(handler, proj["id"])
    assert handler.status == 404 and wfile.buf == b""
