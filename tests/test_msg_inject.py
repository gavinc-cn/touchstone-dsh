# 会话消息「立即注入」单测（2026-09-14；P3 起互斥点改等待项 waitq.claim + 行
# msg_claim）：排队中的平台消息撤销排队、立即投递到会话当前上下文（不等统一
# 队列），含与 worker 的「单投递」串行、投递失败退回排队（等待项行 id 稳定，
# P3 R4），以及任务会话/看板评论的 meta 接线（family/comment_id 提交时快照）
# 与 server 端点（_inject_msg）的归属/族校验。全部无网络无进程（fake runner /
# 打桩）。
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import board
import chat
import db
import runner
import waitq


def setup_function(_fn):
    """每个用例前清空消息权威表与等待项（conftest 临时库；P3 起登记在表）。"""
    with db.connect() as conn:
        for t in ("chat_msgs", "wait_items"):
            conn.execute(f"DELETE FROM {t}")


def _fake_runner(busy=False):
    """假 runner 单例：记录 submit_msg/remove_msg 调用，unit_busy 按参数返回。"""
    calls = {"sub": [], "rm": []}

    class R:
        def unit_busy(self, pid):
            return busy

        def submit_msg(self, mid, pid, sid=""):
            calls["sub"].append((mid, pid, sid))

        def remove_msg(self, mid):
            calls["rm"].append(mid)

    return R(), calls


def _proj(agent="dsh-plugin:/usr/bin/dsh"):
    # model 列参与投递首选模型（会话模型失联自愈），按真实行补齐
    return {"id": 9, "agent_path": agent, "project_dir": "/tmp/x", "model": ""}


def _card():
    return {"id": 5, "session_id": "s-1", "title": "修复登录", "model": ""}


def _task():
    return {"id": 3, "session_id": "s-1", "model": "", "project_id": 9}


def _stub_project(monkeypatch):
    """项目行现读打桩（执行体/投递体重建时 db.get_project；P3 R2 快照语义）。"""
    monkeypatch.setattr(chat.db, "get_project", lambda pid: _proj())


# ---------- chat.inject_now 状态机（互斥点＝等待项 claim + 行 msg_claim） ----------

def test_inject_refused_when_not_in_queue(monkeypatch):
    """被拒三态：行不存在 / 族不支持（meta.family != dsh_plugin） / 已被拾起。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    try:
        chat.inject_now("nope")
        raise AssertionError("应抛 InjectRefused")
    except chat.InjectRefused:
        pass
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: None)   # 拾起路径打桩
    _stub_project(monkeypatch)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="retired")   # 退场族
    try:
        chat.inject_now(rec["id"])
        raise AssertionError("应抛 InjectRefused")
    except chat.InjectRefused as e:
        assert "不支持" in str(e)
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_QUEUED
    rec2 = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    chat.run_unit(rec2["id"])                                     # 已被拾起（running）
    try:
        chat.inject_now(rec2["id"])
        raise AssertionError("应抛 InjectRefused")
    except chat.InjectRefused as e:
        assert "不在排队中" in str(e)


def test_inject_success_dequeues_and_marks_done(monkeypatch):
    """注入成功：出队（不再等统一队列）→ 投递体执行 → 行 done，排队 chip 消失。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    seen = []
    monkeypatch.setattr(chat, "_inject_send",
                        lambda *a, **kw: seen.append("inject"))
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert rec["queued"] is True
    assert chat.state("s-1")["queued"] == 1
    chat.inject_now(rec["id"])
    assert seen == ["inject"]                 # 走注入投递体，不跑队列执行体
    assert calls["rm"] == [rec["id"]]         # 从统一队列摘除
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_DONE
    assert chat.state("s-1")["msgs"] == []    # 前端排队行随下轮轮询消失
    assert chat.live_of_sid("s-1") is False


def test_inject_delivery_failure_requeues(monkeypatch):
    """投递失败：异常上抛（端点转 502），消息退回队尾不丢；等待项行 id 稳定（R4）。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)

    def boom(*a, **kw):
        raise RuntimeError("dsh 驱动调用失败: connect refused")

    monkeypatch.setattr(chat, "_inject_send", boom)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    wid = waitq.get_active(waitq.KIND_MSG, rec["id"])["id"]
    try:
        chat.inject_now(rec["id"])
        raise AssertionError("应上抛投递异常")
    except RuntimeError as e:
        assert "connect refused" in str(e)
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_QUEUED   # 退回排队
    wrow = waitq.get_active(waitq.KIND_MSG, rec["id"])
    assert wrow is not None and wrow["id"] == wid and wrow["state"] == "waiting"  # 行 id 稳定
    assert calls["rm"] == [rec["id"]]
    assert calls["sub"] == [(rec["id"], 9, "s-1"), (rec["id"], 9, "s-1")]  # 提交 + 退回重入队
    assert chat.state("s-1")["queued"] == 1


def test_inject_and_worker_single_delivery(monkeypatch):
    """注入与 worker 都先抢占（等待项 claim / 行 queued→running）：先抢到者
    执行，另一个让行。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    seen = []
    monkeypatch.setattr(chat, "_inject_send",
                        lambda *a, **kw: seen.append("inject"))
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: seen.append("run"))
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    chat.inject_now(rec["id"])       # 注入先抢到
    chat.run_unit(rec["id"])         # worker 后到：见非 queued 让行
    assert seen == ["inject"]
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_DONE


# ---------- 任务会话 / 看板评论的 meta 接线（family/comment_id 快照，P3 R1） ----------

def test_start_wires_inject_for_dsh_plugin(monkeypatch):
    """任务会话（dsh_plugin）：family 提交时定格进等待项 meta，排队消息可立即注入
    （注入 = 驱动 steer，走 chat.dsh_send(..., inject=True)）。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    steered = []
    monkeypatch.setattr(chat.dshdriver, "status", lambda sid: {})
    monkeypatch.setattr(chat.dshdriver, "steer",
                        lambda sid, text: steered.append((sid, text)))
    rec = chat.start(_task(), _proj(), "你好")
    assert rec["queued"] is True
    wrow = waitq.get_active(waitq.KIND_MSG, rec["id"])
    assert wrow is not None and chat._msg_meta(wrow)["family"] == "dsh_plugin"
    assert steered == []                       # 排队阶段不投递
    chat.inject_now(rec["id"])
    assert steered == [("s-1", "你好")]         # 注入路径强制 steer
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_DONE


def test_deliver_comment_wires_inject_for_dsh_plugin(monkeypatch):
    """看板评论（dsh_plugin，目标会话空闲 → 平台队列）：comment_id 随 meta 持久化，
    立即注入走 _deliver_now（steer 注入当前 turn，投递后即返回不等本轮结束）并回写
    sent_text。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    monkeypatch.setattr(board, "_web_family", lambda p: "dsh_plugin")
    sent = {}
    monkeypatch.setattr(board.db, "update_board_comment",
                        lambda mid, **kw: sent.setdefault("kw", kw))
    steered = []
    monkeypatch.setattr(board.dshdriver, "status", lambda sid: {})
    monkeypatch.setattr(board.dshdriver, "steer",
                        lambda sid, text: steered.append((sid, text)))
    rec = board.deliver_comment(_proj(), _card(), {"id": 77, "text": "直接改吧"}, raw=True)
    assert rec is not None
    wrow = waitq.get_active(waitq.KIND_MSG, rec["id"])
    assert wrow is not None and chat._msg_meta(wrow)["family"] == "dsh_plugin"
    assert chat._msg_meta(wrow)["comment_id"] == 77     # 终态写回定位载荷（R1）
    assert sent == {}                          # 排队阶段不投递
    chat.inject_now(rec["id"])
    assert sent["kw"]["sent_text"] == "直接改吧"
    assert steered == [("s-1", "直接改吧")]     # steer 注入当前轮


# ---------- server：_inject_msg（归属/族校验与状态码） ----------

def _fake_handler(calls):
    """仅实现 _respond 的假 handler（_inject_msg 只用到它）。"""
    return type("F", (), {"_respond": lambda self, code, body=b"", ctype="":
                          calls.append((code, body))})()


def _info(sid="s-1", project_id=9, task_id=3, state="queued"):
    return lambda mid: {"id": mid, "sid": sid, "project_id": project_id,
                        "task_id": task_id, "card_id": None, "state": state}


def test_inject_msg_rejects_other_families(monkeypatch):
    """无注入通道的族（退场 CLI 族）：400。

    注：dsh_plugin 自 2026-10-03 起已放行（见下例），P7b 单族化后非 dsh 族一律
    400（原 opencode_web 分支随该族退场删除）。"""
    import server
    calls = []
    server.Handler._inject_msg(_fake_handler(calls),
                               {"id": 9, "agent_path": "/usr/bin/kimi"}, "s-1",
                               {"msg_id": "m1"})
    assert calls[-1][0] == 400


def test_inject_msg_accepts_dsh_plugin(monkeypatch):
    """dsh_plugin 放行（路线 A P1 打通）：走平台统一队列的 chat.inject_now，
    不再 400；投递成功 200。"""
    import server
    calls, injected = [], []
    monkeypatch.setattr(server.chat, "msg_info", _info(state="queued"))
    monkeypatch.setattr(server.chat, "inject_now",
                        lambda mid: injected.append(mid))
    h = _fake_handler(calls)
    server.Handler._inject_msg(h, {"id": 9, "agent_path": "dsh-plugin:/usr/bin/dsh"},
                               "s-1", {"msg_id": "m1"})
    assert injected == ["m1"]
    assert calls[-1][0] == 200


def test_inject_msg_dsh_plugin_refused_returns_400(monkeypatch):
    """dsh 会话已空闲/轮次结束被拒（chat.InjectRefused）→ 400（不吞成 500）。"""
    import server
    calls = []
    monkeypatch.setattr(server.chat, "msg_info", _info(state="queued"))

    def _refuse(mid):
        raise server.chat.InjectRefused("轮次已结束")
    monkeypatch.setattr(server.chat, "inject_now", _refuse)
    server.Handler._inject_msg(_fake_handler(calls),
                               {"id": 9, "agent_path": "dsh-plugin:/usr/bin/dsh"},
                               "s-1", {"msg_id": "m1"})
    assert calls[-1][0] == 400


def test_inject_msg_ownership_and_codes(monkeypatch):
    """归属白名单（sid/project_id/task_id）→ 404；被拒 → 400；投递失败 → 502；
    成功 → 200。"""
    import server
    calls = []
    h = _fake_handler(calls)
    proj = {"id": 9, "agent_path": "dsh-plugin:/usr/bin/dsh"}
    # 记录不存在 / 不属于本会话 / 不属于本项目 / 任务归属不符：一律 404 不执行
    monkeypatch.setattr(server.chat, "msg_info", lambda mid: None)
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"})
    assert calls[-1][0] == 404
    monkeypatch.setattr(server.chat, "msg_info", _info(sid="other"))
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"})
    assert calls[-1][0] == 404
    monkeypatch.setattr(server.chat, "msg_info", _info(project_id=8))
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"})
    assert calls[-1][0] == 404
    monkeypatch.setattr(server.chat, "msg_info", _info(task_id=7))
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"}, task_id=3)
    assert calls[-1][0] == 404
    # 命中：注入成功 → 200
    injected = []
    monkeypatch.setattr(server.chat, "msg_info", _info())
    monkeypatch.setattr(server.chat, "inject_now", lambda mid: injected.append(mid))
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"}, task_id=3)
    assert calls[-1][0] == 200 and injected == ["m1"]

    # 被拒（已被 worker 拾起/不可注入）：400，消息仍在队列
    def refuse(mid):
        raise server.chat.InjectRefused("该消息已不在排队中（可能已开始发送）")

    monkeypatch.setattr(server.chat, "inject_now", refuse)
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"})
    assert calls[-1][0] == 400

    # 投递失败：502（消息已由 chat.inject_now 退回队尾）
    def boom(mid):
        raise RuntimeError("dsh 驱动调用失败")

    monkeypatch.setattr(server.chat, "inject_now", boom)
    server.Handler._inject_msg(h, proj, "s-1", {"msg_id": "m1"})
    assert calls[-1][0] == 502
