# 会话消息统一队列单测（2026-09-10；P3 起状态权威在 chat_msgs 表）：消息单元
# 挑选/取消/占用 + chat 消息登记状态机（submit 双写落表 / run_unit 权威状态机 /
# 执行体按行+快照重建）+ 看板评论投递排队化。除真实 Runner 用例外均为无网络
# 无进程的纯判定测试（fake runner 单例 / 裸实例 + monkeypatch）。
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

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


def _bare_runner():
    """裸 Runner 实例（不起 worker 线程，仅测队列判定）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    return r


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


def _proj():
    # model 列参与投递首选模型（会话模型失联自愈），按真实行补齐
    return {"id": 9, "agent_path": "dsh-plugin:/usr/bin/dsh", "project_dir": "/tmp/x",
            "model": ""}


def _stub_project(monkeypatch):
    """项目行现读打桩（执行体重建时 db.get_project；单测无真实项目行，P3 R2）。"""
    monkeypatch.setattr(chat.db, "get_project", lambda pid: _proj())


# ---------- runner 队列判定（P4 起表驱动：种子行在 wait_items，行即队列） ----------

def test_pick_msg_when_project_free():
    """项目空闲：消息单元被直接拾起。"""
    r = _bare_runner()
    waitq.msg_enqueue("m1", 9, "s-1", "hi")      # P3 权威在表：拾取读表
    r.submit_msg("m1", 9)
    assert r._pick_locked() == "m:m1"


def test_pick_msg_waits_while_project_busy():
    """同项目有任务在跑：消息单元留队等它结束（项目内串行）。占用表征=前缀行
    （拾取即 claim 行 starting；行即占位表征）。"""
    r = _bare_runner()
    waitq.msg_enqueue("m1", 9, "s-1", "hi")      # P3 权威在表：拾取读表
    r.submit_msg("m1", 9)
    ti = waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.claim(ti, "worker")                    # 他单元占项目（前缀行）
    assert r._pick_locked() is None
    waitq.cancel(waitq.KIND_TASK, 1, "测试收尾")
    assert r._pick_locked() == "m:m1"


def test_running_msg_blocks_project():
    """消息执行期间占运行位（行口径：拾取即 claim → starting 即占位表征）。"""
    r = _bare_runner()
    mi = waitq.msg_enqueue("m1", 9, "s-1", "hi")
    waitq.claim(mi, "worker")                    # 拾取即 claim（worker 同款）
    assert r.unit_busy(9) is True
    assert r.unit_busy(8) is False


def test_pick_msg_removed_when_cancelled():
    """权威取消后行消失即不再拾起（chat.cancel → waitq.cancel 落终态 +
    remove_msg 摘内存镜像）；真覆盖见 test_pick_locked_msg_reads_wait_row。"""
    r = _bare_runner()
    waitq.msg_enqueue("m1", 9, "s-1", "hi")      # P3 权威在表：拾取读表
    r.submit_msg("m1", 9)
    waitq.cancel(waitq.KIND_MSG, "m1", "测试")     # chat.cancel 的权威取消路径
    r.remove_msg("m1")                            # 内存镜像摘除（submit_msg 登记）
    assert r._pick_locked() is None


def test_pick_msg_respects_ext_row():
    """平台外占用（运行中的同步会话 = ext 行在场）同样留队：ext 行即前缀成员，
    调度侧不再有独立探针（R8 两处口径合一）。"""
    r = _bare_runner()
    sc = db.insert_board_card(9, "同步卡")
    waitq.insert_ext(9, sc, "s-ext")
    waitq.msg_enqueue("m1", 9, "s-1", "hi")      # P3 权威在表：拾取读表
    r.submit_msg("m1", 9)
    assert r._pick_locked() is None
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert r._pick_locked() == "m:m1"            # 外部行退场即放行


def test_unit_busy_counts_prefix_rows():
    """unit_busy（提交时判定「是否排队」）= 前缀行在场（行即成员，唯一来源；
    探针已退役——ext 行本身就是前缀成员）。"""
    r = _bare_runner()
    assert r.unit_busy(9) is False
    sc = db.insert_board_card(9, "同步卡")
    waitq.insert_ext(9, sc, "s-ext")             # ext 行即前缀成员
    assert r.unit_busy(9) is True
    assert r.unit_busy(8) is False
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert r.unit_busy(9) is False
    ci = waitq.enqueue(waitq.KIND_CARD, 5, 8)
    waitq.claim(ci, "worker")                    # 前缀行在场
    assert r.unit_busy(8) is True


def test_msg_waiting_flag():
    """msg_waiting：等待项 waiting 行即排队（P4 查表），行取消即否。"""
    r = _bare_runner()
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    assert r.msg_waiting("m1") is True
    waitq.cancel(waitq.KIND_MSG, "m1", "已取消")
    assert r.msg_waiting("m1") is False


# ---------- chat 消息登记状态机（P3：权威在 chat_msgs 表） ----------

def test_submit_queued_flag_and_state(monkeypatch):
    """提交时项目忙 → queued=true；执行前不投递，执行后行终态 done（权威在表）。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    ran = []
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: ran.append(1))
    rec = chat.submit(9, "s-1", "你好", task_id=3, family="dsh_plugin", model="")
    assert rec["queued"] is True and rec["state"] == chat.STATE_QUEUED
    assert calls["sub"] == [(rec["id"], 9, "s-1")]   # 单元带目标会话（会话归属判据）
    assert ran == []
    row = waitq.msg_get(rec["id"])                    # 行已落库（重启可恢复的事实源）
    assert row["state"] == chat.STATE_QUEUED and row["task_id"] == 3
    assert chat.state("s-1")["queued"] == 1
    assert chat.state("s-1")["msgs"][0]["text"] == "你好"
    chat.run_unit(rec["id"])
    assert ran == [1]
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_DONE
    assert chat.state("s-1")["queued"] == 0
    assert chat.state("s-1")["msgs"] == []     # done 不发前端


def test_submit_immediate_flag(monkeypatch):
    """项目空闲：queued=false（worker 会立刻拾起）。"""
    fake, _calls = _fake_runner(busy=False)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert rec["queued"] is False
    assert rec["state"] == chat.STATE_QUEUED


def test_run_unit_error_recorded(monkeypatch):
    """执行体异常落 error（下发前端提示），不上抛。"""
    fake, _calls = _fake_runner(busy=False)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)

    def boom(*a, **kw):
        raise RuntimeError("会话运行中，稍后重试")

    monkeypatch.setattr(chat, "_send_now", boom)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    chat.run_unit(rec["id"])
    row = waitq.msg_get(rec["id"])
    assert row["state"] == chat.STATE_ERROR and "稍后重试" in row["error"]
    msgs = chat.state("s-1")["msgs"]
    assert [m["state"] for m in msgs] == [chat.STATE_ERROR] and msgs[0]["error"]


def test_cancel_queued_by_sid(monkeypatch):
    """按会话取消排队：行 cancelled（权威守卫仲裁）并出队（幂等）。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert chat.cancel_queued(sid="s-1") == 1
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_CANCELLED
    assert calls["rm"] == [rec["id"]]
    assert chat.cancel_queued(sid="s-1") == 0


def test_cancel_queued_by_card(monkeypatch):
    """按卡片取消排队（看板 stop_card 路径）。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    rec = chat.submit(9, "s-1", "hi", card_id=5, family="dsh_plugin")
    assert chat.cancel_queued(card_id=5) == 1
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_CANCELLED
    assert calls["rm"] == [rec["id"]]


def test_live_of_sid_tracks_queue_and_run(monkeypatch):
    """live_of_sid：本会话有排队/执行中的消息即为真（看板调和器「消息驱动
    的会话」判定——消息排队时会话尚未 busy，仅凭 busy 会漏判），终态为假。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    seen = []
    assert chat.live_of_sid("s-1") is False          # 无消息

    def fake_send(*a, **kw):
        seen.append(chat.live_of_sid("s-1"))

    monkeypatch.setattr(chat, "_send_now", fake_send)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert chat.live_of_sid("s-1") is True           # 排队中已算在跑（查表）
    assert chat.live_of_sid("s-2") is False          # 仅按会话过滤
    assert chat.live_of_sid("") is False
    chat.run_unit(rec["id"])
    assert seen == [True]                            # 执行期间同样为真
    assert chat.live_of_sid("s-1") is False          # 结束即假


def test_submit_without_runner_runs_sync(monkeypatch):
    """runner 缺位（单测/独立脚本）：同步执行并保持既有返回值语义；行照常落表（R13）。"""
    monkeypatch.setattr(runner, "INSTANCE", None)
    _stub_project(monkeypatch)
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: None)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert rec["queued"] is False and rec["state"] == chat.STATE_DONE
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_DONE


def test_submit_sync_path_error_binds_and_records(monkeypatch):
    """F1 回归（fix round 1）：同步路径异常分支必须绑定 `as e`——执行体异常时
    error 落行（str(e)[:300]）且原异常原样上抛。805c88a 曾写成
    `except Exception:` 后引用 `str(e)`，参数求值即 NameError：msg_finish 不跑
    （消息行滞留 running）、端点看到 NameError 而非原始错误。"""
    monkeypatch.setattr(runner, "INSTANCE", None)
    _stub_project(monkeypatch)

    def boom(*a, **kw):
        raise RuntimeError("会话运行中，稍后重试")

    monkeypatch.setattr(chat, "_rebuild_run", lambda msg_id, meta=None: boom)
    with pytest.raises(RuntimeError, match="会话运行中，稍后重试"):
        chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    (row,) = waitq.msg_rows(sid="s-1")
    assert row["state"] == chat.STATE_ERROR
    assert row["error"] == "会话运行中，稍后重试"      # str(e)[:300] 落行（必带⑧）
    # P5 R13 收口：同步路径不写等待项（无拾取方，等待项只会成为孤儿行）——
    # 钉住「无 msg 等待项行」即收口后的正确语义（chat_msgs 行照常在上方断言）。
    assert waitq.get_active(waitq.KIND_MSG, row["id"]) is None


def test_stop_cancels_queued(monkeypatch):
    """停止入口：先取消排队消息（无 _CHATS 记录时返回 False 但排队已清）。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert chat.stop("s-1") is False
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_CANCELLED
    assert calls["rm"] == [rec["id"]]


# ---------- 看板评论投递排队化 ----------

def _card():
    return {"id": 5, "session_id": "s-1", "title": "修复登录", "model": ""}


def _cmt():
    return {"id": 77, "text": "直接改吧"}


def _patch_delivery(monkeypatch, sent):
    """评论投递路径打桩（单族 dsh：_deliver_now → chat.dsh_send → 驱动 prompt/steer）。"""
    monkeypatch.setattr(board, "_web_family", lambda p: "dsh_plugin")
    monkeypatch.setattr(board.dshdriver, "status", lambda sid: {})
    monkeypatch.setattr(board.dshdriver, "prompt",
                        lambda sid, text: sent.setdefault("t", text))
    monkeypatch.setattr(board.dshdriver, "steer",
                        lambda sid, text: sent.setdefault("t", text))
    monkeypatch.setattr(board.db, "update_board_comment",
                        lambda mid, **kw: sent.setdefault("kw", kw))
    # 会话结束等待此处不测（真实事件流要等 turn/end）：置空，只验证「排队 → 拾起 → 投递」
    monkeypatch.setattr(chat, "wait_web_busy", lambda *a, **kw: None)


def test_deliver_comment_queues_when_project_busy(monkeypatch):
    """项目忙（别的单元在跑）：评论排队，拾起后才真正投递（普通投递=followup）。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    sent = {}
    _patch_delivery(monkeypatch, sent)
    rec = board.deliver_comment(_proj(), _card(), _cmt())
    assert rec is not None and rec["queued"] is True
    assert sent == {}                      # 排队阶段不投递
    chat.run_unit(rec["id"])
    assert sent["t"] == "直接改吧"          # 拾起后投递原文（恒去前缀）
    assert sent["kw"]["sent_text"] == "直接改吧"


def test_deliver_comment_busy_session_enqueues_followup(monkeypatch):
    """目标会话自身在跑（dsh 侧 busy）：平台照常收下评论入统一队列，投递走
    followup——忙时由 dsh 排进 agent inbox，等同服务端排队，不拒绝。"""
    fake, calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    sent = {}
    _patch_delivery(monkeypatch, sent)
    rec = board.deliver_comment(_proj(), _card(), _cmt())
    assert rec is not None and rec["queued"] is True    # 不因会话忙走旁路
    assert calls["sub"] == [(rec["id"], 9, "s-1")]
    assert sent == {}                      # 排队阶段不投递
    chat.run_unit(rec["id"])
    assert sent["t"] == "直接改吧"          # 忙时排队交 dsh followup（inbox）承接


def test_deliver_comment_no_session_raises(monkeypatch):
    """无会话仍即时 400 语义（进队前的前置校验）。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    card = dict(_card(), session_id="")
    try:
        board.deliver_comment(_proj(), card, _cmt())
        raise AssertionError("应抛 RuntimeError")
    except RuntimeError as e:
        assert "尚无会话" in str(e)


# ---------- 真实 Runner（worker 线程）端到端 ----------

def test_runner_worker_executes_msg_and_releases(monkeypatch):
    """真实 Runner：消息单元被 worker 拾起执行，执行期间占着运行位，结束即让出。"""
    r = runner.Runner()
    monkeypatch.setattr(runner, "INSTANCE", r)
    _stub_project(monkeypatch)
    entered = threading.Event()
    release = threading.Event()

    def fake_send(*a, **kw):
        entered.set()
        assert release.wait(5)

    monkeypatch.setattr(chat, "_send_now", fake_send)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert entered.wait(5)
    assert r.unit_busy(9) is True          # 执行期间占着运行位（行即表征）
    assert r.session_holds(9, "s-1") is True    # 占位者即本会话的消息单元（作答豁免判据）
    assert r.session_holds(9, "s-2") is False
    release.set()
    deadline = time.time() + 5
    while time.time() < deadline and waitq.msg_get(rec["id"])["state"] != chat.STATE_DONE:
        time.sleep(0.05)
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_DONE   # 终态权威在表
    while time.time() < deadline and r.unit_busy(9):
        time.sleep(0.05)
    assert r.unit_busy(9) is False
    assert r.session_holds(9, "s-1") is False   # 单元结束：行退场即不再命中


# ---------- 卡片「排队中」徽标：平台排队中的消息单元（2026-09-14） ----------

def test_queued_card_ids_only_counts_queued(monkeypatch):
    """queued_card_ids：仅「排队中」（尚未轮到执行）且带卡片 id 的消息计入——
    执行中/终态不计、任务侧消息（无卡片 id）天然排除；看板卡片「排队中」
    徽标的批量数据源。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    _patch_delivery(monkeypatch, {})
    rec_card = chat.submit(9, "s-1", "卡片消息", card_id=5, family="dsh_plugin")
    chat.submit(9, "s-1", "任务消息", task_id=3, family="dsh_plugin")
    assert chat.queued_card_ids() == {5}
    chat.run_unit(rec_card["id"])            # 拾起执行 → 不再算排队
    assert chat.queued_card_ids() == set()


def test_board_payload_card_msg_queued(monkeypatch):
    """board_payload：有排队消息单元的卡片带 msg_queued=true（前端据此显示
    「排队中」且不点亮「会话运行中」）；无排队消息不置位、执行结束后回落。"""
    fake, _calls = _fake_runner(busy=True)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    row = {"id": 7, "project_id": 9, "title": "t", "description": "",
           "column_key": "doing", "sort_order": 1, "session_id": "s-1",
           "sessions": "[]", "block_kind": None, "block_text": "",
           "parent_card_id": None, "origin": "", "done_at": None, "trashed": 0,
           "trashed_at": None, "scheduled_at": None, "jira_key": "",
           "last_error": "", "last_error_at": None, "created_at": 0, "updated_at": 0}
    monkeypatch.setattr(board.db, "get_project", lambda pid: {"id": pid})
    monkeypatch.setattr(board, "web_busy_map",
                        lambda proj, running_map=None: {})
    monkeypatch.setattr(board.db, "list_board_cards", lambda pid: [row])
    monkeypatch.setattr(board.db, "list_board_comments", lambda pid: [])
    monkeypatch.setattr(board.db, "list_tasks", lambda pid: [])
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "serial"})
    _patch_delivery(monkeypatch, {})

    assert board.board_payload(9)["cards"][0]["msg_queued"] is False
    assert board.board_payload(9)["cards"][0]["queue_state"] == "idle"  # P6 加法字段
    rec = chat.submit(9, "s-1", "hi", card_id=7)
    assert board.board_payload(9)["cards"][0]["msg_queued"] is True
    assert board.board_payload(9)["cards"][0]["queue_state"] == "queued_serial"
    chat.run_unit(rec["id"])
    assert board.board_payload(9)["cards"][0]["msg_queued"] is False
    assert board.board_payload(9)["cards"][0]["queue_state"] == "idle"


# ---------- m: 行挂起让位（2026-09-27：turn 等待作答时释放项目运行位） ----------

def test_wait_web_busy_yields_on_pending(monkeypatch):
    """dsh turn 挂在提问上（driver/interaction 帧）：wait_web_busy 返回
    STATE_YIELDED（让位）。"""
    monkeypatch.setattr(chat, "dsh_wait_turn",
                        lambda sid, since=None: chat.STATE_YIELDED)
    assert chat.wait_web_busy("/tmp/x", "s-1", "dsh_plugin") == chat.STATE_YIELDED


def test_wait_web_busy_no_yield_when_turn_completes(monkeypatch):
    """未挂起（turn/end 正常收口）：wait_web_busy 返回 None（不让位，占用由
    调用方释放）。"""
    monkeypatch.setattr(chat, "dsh_wait_turn", lambda sid, since=None: None)
    assert chat.wait_web_busy("/tmp/x", "s-1", "dsh_plugin") is None


def test_run_unit_yielded_marks_states(monkeypatch):
    """执行体返回 STATE_YIELDED：chat_msgs 落 yielded、等待项终态 done（释放
    运行位）、行证据「挂起让位」；live_of_sid 为假（调和器不再视作消息驱动）。"""
    fake, _calls = _fake_runner(busy=False)
    monkeypatch.setattr(runner, "INSTANCE", fake)
    _stub_project(monkeypatch)
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: chat.STATE_YIELDED)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    chat.run_unit(rec["id"])
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_YIELDED
    assert waitq.get_active(waitq.KIND_MSG, rec["id"]) is None
    assert chat.live_of_sid("s-1") is False
    with db.connect() as conn:
        row = conn.execute(
            "SELECT state, evidence FROM wait_items WHERE kind='msg' AND target_id=?",
            (rec["id"],)).fetchone()
    assert row["state"] == "done" and "挂起让位" in (row["evidence"] or "")


def test_submit_sync_path_yielded(monkeypatch):
    """同步路径（无 runner 单例）对称：执行体让位 → chat_msgs 落 yielded。"""
    monkeypatch.setattr(runner, "INSTANCE", None)
    _stub_project(monkeypatch)
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: chat.STATE_YIELDED)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    assert rec["queued"] is False and rec["state"] == chat.STATE_YIELDED
    assert waitq.msg_get(rec["id"])["state"] == chat.STATE_YIELDED


def test_msg_prune_reclaims_yielded(monkeypatch):
    """yielded 属终态：超过保留期被 msg_prune 回收（不成为永久残留）。"""
    monkeypatch.setattr(runner, "INSTANCE", None)
    _stub_project(monkeypatch)
    monkeypatch.setattr(chat, "_send_now", lambda *a, **kw: chat.STATE_YIELDED)
    rec = chat.submit(9, "s-1", "hi", task_id=3, family="dsh_plugin")
    with db.connect() as conn:
        conn.execute("UPDATE chat_msgs SET ended_at=? WHERE id=?",
                     (int(time.time() * 1000) - (chat.MSG_KEEP_SEC + 10) * 1000,
                      rec["id"]))
    waitq.msg_prune(chat.MSG_KEEP_SEC, chat.MSG_MAX)
    assert waitq.msg_get(rec["id"]) is None


def test_deliver_unit_propagates_yield(monkeypatch):
    """卡片评论投递路同样透传让位（board._deliver_unit → wait_web_busy 返回值）。"""
    monkeypatch.setattr(board, "_web_family", lambda proj: "dsh_plugin")
    monkeypatch.setattr(board, "_deliver_now", lambda *a, **kw: None)
    monkeypatch.setattr(chat, "wait_web_busy",
                        lambda d, sid, fam: chat.STATE_YIELDED)
    proj = {"id": 9, "project_dir": "/tmp/x"}
    card = {"id": 5, "session_id": "s-1", "model": ""}
    assert board._deliver_unit(proj, card, {"id": 1}, "文本", False) == \
        chat.STATE_YIELDED
