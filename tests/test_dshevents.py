#!/usr/bin/env python3
"""dsh 状态事件中枢（`dshevents.EventHub`）单测：帧折叠、断连=未知、重连续传、
对齐快照与订阅唤醒——P4 事件化的核心不变量（方案 §3.4）。"""
import threading
import time

import dshevents
import dshdriver


def _hub(monkeypatch, frames=None, live_rows=None):
    """造一个已连接、喂了给定帧的 hub（不起线程），返回 (hub, feed)。"""
    hub = dshevents.EventHub()
    if live_rows is not None:
        monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": live_rows})
        hub._align()
    hub._set_connected(True)
    for frame in frames or []:
        hub._on_frame(frame)
    return hub


def _status_frame(sid, status, seq=1):
    return {"seq": seq, "type": "agent/status", "session_id": sid,
            "data": {"status": status}}


def test_fold_agent_status_and_turn(monkeypatch):
    """agent/status 与 turn/* 帧折叠成实时态；turn/end 记原因与会话事件 seq。"""
    hub = _hub(monkeypatch, [
        _status_frame("s1", "running", 1),
        {"seq": 2, "type": "turn/start", "session_id": "s1", "data": {"event_seq": 7}},
        {"seq": 3, "type": "turn/end", "session_id": "s1",
         "data": {"reason": "completed", "event_seq": 9}},
    ])
    item = hub.get("s1")
    assert item["status"] == "idle"                 # 轮次收口即闲
    assert item["last_turn_reason"] == "completed"
    assert item["last_seq"] == 9                    # turn 归属基线的 seq
    assert hub.stats()["last_seq"] == 3             # 全局状态帧序号
    assert hub.stats()["frames"] == 3


def test_fold_usage_and_model(monkeypatch):
    """`usage` 与 `driver/model` 帧折叠（P6：ctx 圈与会话模型的零轮询数据源）。"""
    hub = _hub(monkeypatch, [
        {"seq": 1, "type": "driver/attached", "session_id": "s1",
         "data": {"owned": True, "model": {"provider": "p", "model": "m"}}},
        {"seq": 2, "type": "usage", "session_id": "s1",
         "data": {"input": 7, "output": 3, "total": 10, "cache_read": 0}},
        {"seq": 3, "type": "driver/model", "session_id": "s1",
         "data": {"provider": "q", "model": "w"}},
    ])
    item = hub.get("s1")
    assert item["model"] == {"provider": "q", "model": "w"}      # 后到者覆盖
    assert item["usage"]["total"] == 10 and item["usage"]["output"] == 3
    # 对齐（/live 无这两个字段）不清掉已学到的值
    monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": [
        {"session_id": "s1", "status": "idle", "owned": True}]})
    hub._align()
    assert hub.get("s1")["usage"]["total"] == 10
    assert hub.get("s1")["model"]["model"] == "w"


def test_fold_permission_frame(monkeypatch):
    """`driver/permission` 帧折叠（2026-10-04 修「会话窗权限控件恒置灰」的数据源）。

    平台三档 mode（唯一能区分 yolo/auto 的来源）与宿主 preset 实况都要能折进注册表；
    `/live` 对齐时 preset 以快照为准、mode 保留平台记下的值（快照里带 mode 也认）。
    """
    hub = _hub(monkeypatch, [
        {"seq": 1, "type": "driver/attached", "session_id": "s1", "data": {"owned": True}},
        {"seq": 2, "type": "driver/permission", "session_id": "s1",
         "data": {"mode": "manual", "preset": "workspace-write"}},
    ])
    assert hub.get("s1")["permission"] == {"mode": "manual", "preset": "workspace-write"}
    # /live 不带 permission：保留已学到的值（与 usage/model 同口径）
    monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": [
        {"session_id": "s1", "status": "idle", "owned": True}]})
    hub._align()
    assert hub.get("s1")["permission"]["mode"] == "manual"
    # /live 带 permission（驱动新版本）：preset 以快照为准，mode 沿用平台记下的
    monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": [
        {"session_id": "s1", "status": "idle", "owned": True,
         "permission": {"mode": "", "preset": "danger-full-access"}}]})
    hub._align()
    assert hub.get("s1")["permission"] == {"mode": "manual",
                                          "preset": "danger-full-access"}
    # 两者皆空 → None（未知，绝不推断）
    assert dshevents._merge_permission({}, {}) is None


def test_fold_inbox_queue_rows(monkeypatch):
    """`driver/inbox` 帧折叠成排队行快照（P6 #21：会话窗的「宿主排队行」数据源）。"""
    hub = _hub(monkeypatch, [
        {"seq": 1, "type": "driver/inbox", "session_id": "s1",
         "data": {"items": [{"id": "a", "text": "一"}, {"id": "b", "text": "二"}]}},
    ])
    assert [m["text"] for m in hub.get("s1")["inbox"]] == ["一", "二"]
    hub._on_frame({"seq": 2, "type": "driver/inbox", "session_id": "s1",
                   "data": {"items": [{"id": "b", "text": "二"}]}})
    assert [m["id"] for m in hub.get("s1")["inbox"]] == ["b"]      # 整表覆盖
    monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": [
        {"session_id": "s1", "status": "idle", "owned": True}]})
    hub._align()
    assert [m["id"] for m in hub.get("s1")["inbox"]] == ["b"]      # 对齐不清值


def test_fold_interaction_attach_detach_disposed(monkeypatch):
    """interaction/attached/detached/disposed 帧的注册表语义。"""
    hub = _hub(monkeypatch, [
        {"seq": 1, "type": "session/created", "session_id": "s1", "data": {"cwd": "/tmp/p"}},
        {"seq": 2, "type": "driver/attached", "session_id": "s1",
         "data": {"cwd": "/tmp/p", "task": "card-1", "owned": True}},
        {"seq": 3, "type": "driver/interaction", "session_id": "s1",
         "data": {"state": "asked", "interaction": {"kind": "question", "call_id": "c1"}}},
    ])
    item = hub.get("s1")
    assert item["owned"] is True and item["task"] == "card-1" and item["cwd"] == "/tmp/p"
    assert item["interaction"]["call_id"] == "c1"
    hub._on_frame({"seq": 4, "type": "driver/interaction", "session_id": "s1",
                   "data": {"state": "decided", "outcome": "allowed-once"}})
    assert hub.get("s1")["interaction"] is None
    hub._on_frame({"seq": 5, "type": "driver/detached", "session_id": "s1", "data": {}})
    assert hub.get("s1")["owned"] is False
    hub._on_frame({"seq": 6, "type": "session/disposed", "session_id": "s1", "data": {}})
    assert hub.get("s1") is None                    # 会话消失：读口回未知


def test_disconnected_means_unknown(monkeypatch):
    """断连 ⇒ 一切状态读口返回 None（绝不推断空闲），恢复后照常可读。"""
    hub = _hub(monkeypatch, [_status_frame("s1", "running", 1)])
    assert hub.get("s1")["status"] == "running"
    hub._set_connected(False)
    assert hub.get("s1") is None
    assert hub.snapshot() == {}
    hub._set_connected(True)
    assert hub.get("s1")["status"] == "running"     # 注册表仍在，只是断连期间不可读


def test_fold_archived_frame_and_unknown_on_disconnect(monkeypatch):
    """归档集（2026-10-05）：`driver/archived` 整表覆盖；断连 ⇒ 归档态归「未知」
    （None）——看板据此不动作，绝不把读不到当成「未归档」。"""
    hub = _hub(monkeypatch, [
        {"seq": 1, "type": "driver/archived", "session_id": "",
         "data": {"archived": ["s1"]}},
    ])
    assert hub.archived("s1") is True
    assert hub.archived("s2") is False              # 已知归档集里没有=明确未归档
    assert hub.archived("") is None                 # 空 sid=未知
    assert hub.archived_set() == {"s1"}
    # 整表覆盖（取消归档 s1、归档 s2/s3）
    hub._on_frame({"seq": 2, "type": "driver/archived", "session_id": "",
                   "data": {"archived": ["s2", "s3"]}})
    assert hub.archived("s1") is False and hub.archived("s2") is True
    assert hub.stats()["archived"] == 2
    hub._set_connected(False)
    assert hub.archived("s2") is None and hub.archived_set() is None
    assert hub.stats()["archived"] is None


def test_align_reads_archive_set(monkeypatch):
    """(重)连对齐除 `/live` 外再取一次 `/archived`（补断连期间的归档/取消归档）；
    取不到时保持「未知」——旧插件没这端点也不得推断成「未归档」。"""
    monkeypatch.setattr(dshdriver, "archived", lambda: ["s1", "s9"])
    hub = _hub(monkeypatch, live_rows=[{"session_id": "s1", "status": "idle"}])
    assert hub.archived("s1") is True and hub.archived("s9") is True
    assert hub.archived("s2") is False

    def boom():
        raise dshdriver.DshDriverError(404, "未知驱动端点 /archived")
    monkeypatch.setattr(dshdriver, "archived", boom)
    hub2 = _hub(monkeypatch, live_rows=[{"session_id": "s1", "status": "idle"}])
    assert hub2.archived("s1") is None


def test_align_replaces_registry(monkeypatch):
    """`/live` 对齐：以插件视角覆盖注册表（补断连期间的增删）。"""
    hub = _hub(monkeypatch, live_rows=[
        {"session_id": "s1", "status": "running", "owned": True, "cwd": "/a",
         "task": "t1", "last_turn_reason": "completed", "last_seq": 5},
        {"session_id": "s2", "status": "idle", "owned": False, "cwd": "/b"},
    ])
    assert set(hub.snapshot()) == {"s1", "s2"}
    assert hub.get("s1")["last_seq"] == 5
    assert hub.get("s2")["owned"] is False
    # 会话结束后再对齐：已消失的会话从注册表移除
    monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": [
        {"session_id": "s2", "status": "idle", "owned": False}]})
    hub._align()
    assert set(hub.snapshot()) == {"s2"}


def test_align_failure_keeps_registry(monkeypatch):
    """对齐失败（驱动不可达）不清空注册表——宁可留旧值，不可误判空闲。"""
    hub = _hub(monkeypatch, [_status_frame("s1", "running", 1)])

    def boom():
        raise dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(dshdriver, "live", boom)
    hub._align()
    assert hub.get("s1")["status"] == "running"


def test_wait_wakes_on_change_and_subscribers(monkeypatch):
    """wait() 在变更时立即返回；subscribe 回调收到原始帧。"""
    hub = _hub(monkeypatch)
    seen = []
    hub.subscribe(lambda f: seen.append(f["type"]))
    assert hub.wait(0.05) is False                  # 无变更：超时返回 False
    threading.Timer(0.05, lambda: hub._on_frame(_status_frame("s1", "running", 1))).start()
    assert hub.wait(2.0) is True
    assert seen == ["agent/status"]


def test_subscriber_exception_does_not_break_consumption(monkeypatch):
    hub = _hub(monkeypatch)
    hub.subscribe(lambda f: (_ for _ in ()).throw(RuntimeError("boom")))
    hub._on_frame(_status_frame("s1", "running", 1))   # 不抛
    assert hub.get("s1")["status"] == "running"


def test_start_skipped_when_not_configured(monkeypatch):
    """独立形态（未下发驱动地址）：不起线程、不连接，读口恒未知。"""
    monkeypatch.setattr(dshdriver, "configured", lambda: False)
    hub = dshevents.EventHub()
    assert hub.start() is False
    assert hub.connected() is False and hub.get("s1") is None


def test_run_reconnects_with_since_and_backoff(monkeypatch):
    """重连：带 `since=last_seq` 续传、退避后重试；断连期间读口为未知。"""
    hub = dshevents.EventHub()
    since_seen = []
    monkeypatch.setattr(dshdriver, "configured", lambda: True)
    monkeypatch.setattr(dshdriver, "live", lambda: {"sessions": []})
    monkeypatch.setattr(dshevents, "RECONNECT_MIN", 0.01)
    monkeypatch.setattr(dshevents, "RECONNECT_MAX", 0.02)

    def fake_stream(on_frame, since=0, stop=None, idle_timeout=None):
        since_seen.append(since)
        if len(since_seen) == 1:
            on_frame(_status_frame("s1", "running", 5))
            raise dshdriver.DshDriverError(-2, "链路断")
        hub._stop = True                            # 第二次进入：本轮结束后收尾
        return (0, since)

    monkeypatch.setattr(dshdriver, "state_stream", fake_stream)
    assert hub.start() is True
    deadline = time.time() + 3
    while time.time() < deadline and len(since_seen) < 2:
        time.sleep(0.02)
    hub.stop()
    assert since_seen[0] == 0
    assert since_seen[1] == 5                       # 续传基准 = 已消费的最大 seq
    assert hub.connected() is False                 # 停止后回到未知
    assert hub.stats()["reconnects"] >= 1


def test_module_singleton_helpers(monkeypatch):
    """模块级单例包装（server.py 用的那组函数）语义一致且不误连。"""
    monkeypatch.setattr(dshdriver, "configured", lambda: False)
    assert dshevents.start() is False
    assert dshevents.connected() is False
    assert dshevents.get("s1") is None
    assert dshevents.snapshot() == {}
    assert dshevents.archived("s1") is None          # 未连接=未知（不推断未归档）
    assert dshevents.archived_set() is None
    assert dshevents.wait(0.01) is False
    assert dshevents.stats()["frames"] == 0
    dshevents.stop(timeout=0.1)                     # 幂等、无异常


# ---------- P4 接线：「零轮询」红线 ----------

def test_board_has_no_driver_state_reads():
    """P4 红线（可执行断言）：board 不得再有逐会话/周期性的驱动状态读。

    「静置期对 dsh 请求数 = 0」靠这条守住——有人把 `/status` 或 `/live` 读口
    加回调和器路径，这里立刻红。允许的驱动调用只剩**动作类**端点
    （prompt/steer/cancel/answer/approval/compact/fork/rename/model/permission）。
    """
    import io
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = io.open(os.path.join(root, "board.py"), encoding="utf-8").read()
    assert "dshdriver.status(" not in src, "board 又出现了逐会话 /status 读口（P4 红线）"
    assert "dshdriver.live(" not in src, "board 又出现了周期 /live 读口（P4 红线）"


def test_idle_no_driver_requests(monkeypatch):
    """P7a 运行时验收（可执行版）：整实例静置期对驱动的请求数 = 0。

    与上面的源码级红线互补——这条真的起隔离实例（真 server.py + 假 driver），
    等 EventHub 连上后记录请求计数，静置 12s 再比：`/status`、`/live` 一律不得
    增长（长连 `/events` 只应出现 1 次=单连接）。有人把轮询读口加回任何路径，
    这条会红。验收口径见 plan/202610/20261003_0657 §6.2。
    """
    from serverfixture import IsolatedServer
    srv = IsolatedServer(sleep="1")
    try:
        srv.start()
        # 状态流建连 = EventHub 已消费（假 driver 的 /events 计数即连接数）
        up = IsolatedServer.wait_until(
            lambda: srv.driver.stats().get("/events", 0) >= 1, timeout=30)
        assert up, "EventHub 未在 30s 内连上状态流（/events 无连接）"
        before = srv.driver.stats()
        time.sleep(12)
        after = srv.driver.stats()
        delta = {k: after.get(k, 0) - before.get(k, 0) for k in
                 set(before) | set(after)}
        assert delta.get("/status", 0) == 0, f"静置期出现逐会话 /status 轮询: {delta}"
        assert delta.get("/live", 0) == 0, f"静置期出现 /live 轮询: {delta}"
        assert delta.get("/archived", 0) == 0, \
            f"静置期出现归档集轮询（只允许(重)连各一次对齐）: {delta}"
        assert after.get("/events", 0) == 1, \
            f"状态流应只有一条长连（单连接消费），实际 {after.get('/events')}"
    finally:
        srv.stop()
