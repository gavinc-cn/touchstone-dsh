#!/usr/bin/env python3
"""P7a 缺陷 E/F 回归钉（2026-10-03）。

E（会话存储缺失时任务会话 SSE 线程 KeyError）：`_session_payload` 在
  `sessparse.load` 返回 `{"found": False, ...}`（会话未落盘 / 被删 / 归档 /
  尚未探到会话）时**不带 total 键**，而 SSE 循环原实现写
  `elif payload["total"] < after:` 直接下标 → 第二拍（sid 稳定后）KeyError，
  SSE 处理线程异常断开。修法：`found=false` 路径按「无增量」处理
  （`total_now = payload.get("total")`，None 即不参与 total 回退比较）。

F（启动竞态：worker 先于 runner.recover() claim `a:` 行）：worker 线程在
  `runner.Runner()` 构造（server.py 模块导入期）即就绪，会先于 main 里的
  `runner.recover()` 拾取上一实例遗留的 waiting `a:` 行（state→starting）；
  recover 的 `return_to_waiting` 遂把它放回 waiting 并**清掉 not_before**，
  与在途投递竞态——同一失败打两条「第 1 次」日志、retries 双增（实测 2），
  「m:/a: 存活 N 条」存活横幅也因 n_alive=0 随机消失。修法：启动闸
  （`Runner(boot_gate=True)` → 对账跑完 `release_boot_gate()` 放行 worker）。

（用 conftest 临时库；wait_items/chat_msgs 每例前后清空，对齐
tests/test_answer_queue.py 的种子写法。）
"""
import json
import os
import sys
import threading
import time
import uuid

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import board
import db
import runner
import server
import waitq


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清空 waitq 相关表（conftest 临时库）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _mk_project(name="p7a-def"):
    """建一个真实项目行（dsh 插件族：P7a 的主形态）。"""
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"{name}-{uid}", f"/tmp/{name}-{uid}",
                            "dsh-plugin:/usr/bin/dsh", f"/tmp/{name}-{uid}/work")
    return db.get_project(pid)


def _mk_task(pid, sid="", model="test-model"):
    """建一个**终态**任务行（不参与 runner.recover 的 queued 补建，保持用例静场），
    返回任务行；sid 非空时写入 session_id。"""
    tid = db.insert_task(pid, "P7a 会话", 0, 0, "rounds", 1, model=model)
    db.update_task(tid, status="done", ended_at=db.now_str(),
                   **({"session_id": sid} if sid else {}))
    return db.get_task(tid)


# ---------- 缺陷 E：任务会话 SSE 端点的 found:false 路径 ----------

class _StopStream(Exception):
    """测试哨兵：让 SSE 循环跑到第 N 拍后退出（产品路径不会抛它）。"""


class _WFile:
    """SSE 写出假体：逐次记录写出的字节（对齐 tests/test_localbus.py 的做法）。"""

    def __init__(self):
        self.attempts = []

    def write(self, data):
        self.attempts.append(data)

    def flush(self):
        pass


class _FakeTaskHandler:
    """任务会话 SSE 处理器的免 socket 假体：只有 wfile/headers/状态与鉴权是桩，
    `_session_payload` / `_task_since` 直借真实实现（免 socket 跑真链路）。"""

    _session_payload = server.Handler._session_payload   # 真实 payload 组装
    _task_since = server.Handler._task_since             # 真实任务起始时间

    def __init__(self, wfile, task):
        self.wfile = wfile
        self.headers = {}
        self.status = None
        self._task = task

    def send_response(self, code):
        self.status = code

    def send_header(self, _k, _v):
        pass

    def end_headers(self):
        pass

    def _owned_task(self, _task_id):
        return self._task

    def _session_context(self, task_id):
        """真实语义（server.Handler._session_context）：任务行 + 项目行 + agent 归族。"""
        task = self._owned_task(task_id)
        proj = db.get_project(task["project_id"])
        return task, proj, runner.agent_family(proj["agent_path"])


def _install_tick_stop(monkeypatch, server_mod, stop_after):
    """把 server 的 `time.sleep` 换成「调用线程第 N 次调用即抛 _StopStream」的桩。

    仅对本线程生效（其它后台线程的 sleep 原样透传，避免全局打桩污染），且不真等
    0.75s——SSE 循环拍数在测试里即刻推进。
    """
    real_sleep = time.sleep
    me = threading.current_thread()
    state = {"n": 0}

    def fake_sleep(sec):
        if threading.current_thread() is not me:
            return real_sleep(sec)
        state["n"] += 1
        if state["n"] >= stop_after:
            raise _StopStream()
        return real_sleep(0)

    monkeypatch.setattr(server_mod.time, "sleep", fake_sleep)
    return state


def _frames(wfile):
    """SSE 写出字节 → [(event 名, data 解析结果)]（心跳/注释行忽略）。"""
    out = []
    for chunk in wfile.attempts:
        for block in chunk.decode("utf-8").split("\n\n"):
            ev = data = None
            for line in block.split("\n"):
                if line.startswith("event: "):
                    ev = line[len("event: "):]
                elif line.startswith("data: "):
                    data = line[len("data: "):]
            if ev is not None:
                out.append((ev, json.loads(data) if data else None))
    return out


def _event(frames, name):
    """取第一个指定事件的 data（无则 None）。"""
    for ev, data in frames:
        if ev == name:
            return data
    return None


def test_task_session_stream_missing_storage_no_keyerror(monkeypatch):
    """E：会话存储缺失（`sessparse.load` → found:false/missing）时 SSE 循环不得
    KeyError——payload 无 total 键，按「无增量」处理，循环照常心跳/收尾。

    红（修前）：第二拍 `payload["total"]` 直接下标 → KeyError 打断处理线程。"""
    proj = _mk_project()
    task = _mk_task(proj["id"], sid="session-gone")
    monkeypatch.setattr(server.sessparse, "load",
                        lambda family, sid, agent, after:
                        {"found": False, "reason": "missing"})
    wfile = _WFile()
    handler = _FakeTaskHandler(wfile, task)
    ticks = _install_tick_stop(monkeypatch, server, stop_after=2)

    # 循环只有客户端断开才退出：测试用哨兵在第 2 拍 sleep 处收口；
    # 修前这里抛的是 KeyError（即缺陷），修后抛哨兵。
    with pytest.raises(_StopStream):
        server.Handler._api_session_stream(
            handler, task["id"], {"agent": ["main"], "after": ["0"]})

    assert ticks["n"] == 2, "SSE 循环未跑到第二拍（缺陷 E 的触发点）"
    assert handler.status == 200
    frames = _frames(wfile)
    meta = _event(frames, "meta")
    assert meta is not None and meta["found"] is False
    assert meta["reason"] == "missing"
    assert [f for f in frames if f[0] == "entries"] == []      # found:false 无增量


def test_task_session_stream_no_session_no_keyerror(monkeypatch):
    """E：任务尚无 session_id 且未探到运行中会话（no_session，payload 无 total 键）：
    **第一拍**即命中 total 比较分支也不得 KeyError（修前此处立即断开）。"""
    proj = _mk_project()
    task = _mk_task(proj["id"], sid="")
    monkeypatch.setattr(server.sessparse, "live_session_id",
                        lambda family, project_dir, since: None)
    wfile = _WFile()
    handler = _FakeTaskHandler(wfile, task)
    ticks = _install_tick_stop(monkeypatch, server, stop_after=2)

    with pytest.raises(_StopStream):
        server.Handler._api_session_stream(
            handler, task["id"], {"agent": ["main"], "after": ["0"]})

    assert ticks["n"] == 2
    assert handler.status == 200
    frames = _frames(wfile)
    meta = _event(frames, "meta")
    assert meta is not None and meta["found"] is False
    assert meta["reason"] == "no_session"
    assert [f for f in frames if f[0] == "entries"] == []


def test_task_session_stream_vanished_midstream_no_keyerror(monkeypatch):
    """E：增量游标非零（after=1）时会话中途消失（被删/归档）——不得 KeyError、
    不得把游标归零重发全量（按「无增量」静默继续，客户端凭 meta.found 呈现）。

    红（修前）：第二拍 found:false → `payload["total"]` KeyError。"""
    proj = _mk_project()
    task = _mk_task(proj["id"], sid="session-vanish")
    calls = {"n": 0}

    def fake_load(family, sid, agent, after):
        calls["n"] += 1
        if calls["n"] <= 2:            # 第一拍读两次（sid 切换 → 归零重取）
            return {"found": True, "agents": ["main"], "agent": "main",
                    "entries": [{"seq": 0, "role": "user", "text": "hi"}], "total": 1}
        return {"found": False, "reason": "missing"}

    monkeypatch.setattr(server.sessparse, "load", fake_load)
    wfile = _WFile()
    handler = _FakeTaskHandler(wfile, task)
    ticks = _install_tick_stop(monkeypatch, server, stop_after=3)

    with pytest.raises(_StopStream):
        server.Handler._api_session_stream(
            handler, task["id"], {"agent": ["main"], "after": ["0"]})

    assert ticks["n"] == 3
    frames = _frames(wfile)
    entries = [f for f in frames if f[0] == "entries"]
    assert len(entries) == 1, frames                     # 会话消失后不再重发全量
    assert entries[0][1]["total"] == 1
    assert frames[-1][0] == "meta" and frames[-1][1]["found"] is False


# ---------- 缺陷 F：启动闸（worker 不得先于启动对账拾取） ----------

def test_startup_gate_blocks_pick_until_recover_done(monkeypatch, capsys):
    """F：启动序钉死——`Runner(boot_gate=True)`（server.py 形态）的 worker 在对账
    跑完前不拾取遗留 waiting `a:` 行；recover 看到的是 waiting 行 ⇒ 不动
    not_before/retries、存活横幅计数正确；放行后 worker 才拾取。"""
    monkeypatch.setattr(runner.Runner, "_process_task", lambda self, tid: None)
    proj = _mk_project()
    pid = proj["id"]
    cid_pick = db.insert_board_card(pid, "闸门卡（可拾取）")
    cid_backoff = db.insert_board_card(pid, "闸门卡（退避中）")
    # ① 可立即拾取的 waiting a: 行（=上一实例遗留、未在退避的形态）
    rid_pick = waitq.enqueue(waitq.KIND_ANSWER, cid_pick, pid, not_before=0)
    # ② 退避中的 waiting a: 行（not_before 是送达退避写入的「最早可拾取时间」）
    nb_backoff = time.time() + 30
    rid_backoff = waitq.enqueue(waitq.KIND_ANSWER, cid_backoff, pid,
                                not_before=nb_backoff)
    delivered = []
    monkeypatch.setattr(board, "_deliver_answer_unit",
                        lambda cid: delivered.append(cid))

    r = runner.Runner(boot_gate=True)          # 与 server.py 同形态：构造即被闸住
    monkeypatch.setattr(runner, "INSTANCE", r)
    try:
        # —— 闸内（原竞态窗口）：worker 不得 claim 任何行、投递体不得被调用 ——
        time.sleep(1.0)
        assert waitq.get_item(rid_pick)["state"] == "waiting"
        assert waitq.get_item(rid_backoff)["state"] == "waiting"
        assert delivered == []

        # —— 启动对账：行仍 waiting ⇒ 只计入存活，不动 not_before/retries ——
        r.recover()
        row_pick, row_backoff = waitq.get_item(rid_pick), waitq.get_item(rid_backoff)
        assert (row_pick["state"], row_backoff["state"]) == ("waiting", "waiting")
        assert row_pick["not_before"] == 0
        assert (row_pick["retries"] or 0) == 0
        assert row_backoff["not_before"] == pytest.approx(nb_backoff)
        assert (row_backoff["retries"] or 0) == 0
        out = capsys.readouterr().out
        assert "waiting 等待项存活 2 条" in out, out
        assert "m:/a: 存活 2 条" in out, out        # 存活横幅不再随竞态消失

        # —— 放行：worker 才拾取（只拾可拾取那行；退避行受 not_before 保护）——
        r.release_boot_gate()
        deadline = time.time() + 5
        while time.time() < deadline and not delivered:
            time.sleep(0.05)
        assert delivered == [cid_pick], delivered
        assert waitq.get_item(rid_pick)["state"] == "starting"   # claim 即占位
        row_backoff = waitq.get_item(rid_backoff)
        assert row_backoff["state"] == "waiting"
        assert row_backoff["not_before"] == pytest.approx(nb_backoff)
    finally:
        # 本用例自建真实 worker：收尾静音其拾取入口，防遗留线程抢后续用例的行
        # （conftest 的「野 worker 免疫」只静音用例开始前已存在的实例）
        r._pick_locked = lambda: None
        with r._cond:
            r._cond.notify_all()


def test_release_boot_gate_bare_instance_safe():
    """F：裸实例（`Runner.__new__`，单测主力）无启动闸字段，放行调用是 no-op
    不抛；boot_gate=True 的实例初始在闸后，放行幂等。"""
    bare = runner.Runner.__new__(runner.Runner)
    runner.Runner.release_boot_gate(bare)              # 不抛
    assert not hasattr(bare, "_boot_gate")
    with_gate = runner.Runner(boot_gate=True)
    try:
        assert with_gate._boot_gate.is_set() is False  # 构造即在闸后
    finally:
        # 先静音拾取入口再放行（本用例只验闸语义，无需真拾取）
        with_gate._pick_locked = lambda: None
        with_gate.release_boot_gate()
        with_gate.release_boot_gate()                  # 幂等
        assert with_gate._boot_gate.is_set() is True
        with with_gate._cond:
            with_gate._cond.notify_all()
