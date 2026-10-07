# 作答排队（2026-09-13；v2b T1 起**一律入队**，裁决 R8）：不再判项目忙/闲，
# 作答/审批一律插「运行中最后一个条目后面」（insert_after_prefix=前缀后/等待区
# 最前）+ doing/queue 排队占位，补位启动时才由 worker 送达——闲时直送与
# _own_occupancy 直送旁路已删除（卡 391 自身占用豁免移入补位器 R5⑥，本文件
# test_own_session_msg_occupancy_still_delivers 端到端钉死）。
# P2 起权威在 wait_items（kind=answer 活跃行，meta 携带完整送达载荷、重启存活），
# 送达由 runner worker 统一队列驱动（执行体 board._deliver_answer_unit：
# 送达/退避/放弃自洽），「立即送达」= claim + 直投。
# （monkeypatch 底层，不触网络/不写库；wait_items/chat_msgs 用 conftest 临时库）
import json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import board
import db
import runner
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


def _proj():
    return {"id": 9, "project_dir": "/tmp/x",
            "agent_path": "dsh-plugin:/usr/bin/dsh"}


def _card(**kw):
    base = {"id": 1, "project_id": 9, "session_id": "s-1"}
    base.update(kw)
    return base


def _st(**kw):
    q = {"id": "q_0", "question": "选哪个？",
         "options": [{"id": "o1", "label": "A", "description": ""}],
         "multi_select": False, "allow_other": False}
    base = {"pending": True, "busy": True, "kind": "question",
            "qid": "Q-1", "wire": "q_0", "questions": [q], "options": q["options"],
            "multi_select": False, "allow_other": False,
            "answerable": True, "text": "选哪个？"}
    base.update(kw)
    return base


def _answers():
    return [{"wire": "q_0", "kind": "single", "option_id": "o1"}]


def _dsh_payload():
    """_answers() 送达时交给 dshdriver 的原生载荷（board._dsh_answers 目标形态）。"""
    return [{"id": "q_0", "selected": ["o1"]}]


def _seed(cid=1, pid=9):
    """种一条 waiting 权威 answer 行（meta 全载荷；取代旧内存态登记），
    返回等待项 id。"""
    return waitq.enqueue(waitq.KIND_ANSWER, cid, pid,
                         meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})


class _FakeRunner:
    """板卡侧调用面假体（记录 + remove_answer/submit_answer 等）。

    v3d 去占用后板卡不再读任何占位判据（行即表征），故假体只有记录职责；
    作答一律入队的判定由真实补位器（`_bare_picker`）另行钉死。"""
    def __init__(self):
        self.calls = []

    def remove_card(self, cid):
        self.calls.append(("remove", cid))

    def card_started(self, cid, pid, ext=None):
        self.calls.append(("start", cid, pid))

    def submit_answer(self, cid):
        self.calls.append(("submit_answer", cid))

    def remove_answer(self, cid):
        self.calls.append(("remove_answer", cid))


def _patch(monkeypatch, runner_obj):
    calls = {"answer": [], "upd": [], "clear": [], "cancel": [], "ph": []}
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: dict(_st()))
    monkeypatch.setattr(board, "_iw_clear", lambda sid: calls["clear"].append(sid))
    # 单族 dsh：送达走 dshdriver.answer_question（无 ensure_started——会话活在
    # dsh 宿主进程内，平台侧没有可拉起的服务）；返回 True = 受理
    monkeypatch.setattr(board.dshdriver, "answer_question",
                        lambda sid, qid, answers:
                        calls["answer"].append((sid, qid, answers)) or True)
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls["upd"].append((cid, kw)))
    # 占位投影单写记录（P4 R6：作答排队落占位走 set_card_wait_placeholder）
    monkeypatch.setattr(board.waitq, "set_card_wait_placeholder",
                        lambda cid, block_text="":
                        calls["ph"].append((cid, block_text)))
    monkeypatch.setattr(board.db, "get_project",
                        lambda pid: _proj() if pid == 9 else None)
    # waitq.cancel 记录包装（透传真实取消——重复作答替换等路径行为不变）：
    # P4 起 remove_card 退场，「防旧 c: 条目误发继续」的防御改走 waitq.cancel
    # （v2d T1 起带 states= 收窄行态——包装透传 kwargs）
    real_cancel = waitq.cancel
    monkeypatch.setattr(board.waitq, "cancel",
                        lambda kind, tid, reason="", **kw:
                        calls["cancel"].append((kind, tid))
                        or real_cancel(kind, tid, reason, **kw))
    monkeypatch.setattr(board.runner, "INSTANCE", runner_obj)
    return calls


def _bare_picker(monkeypatch, mode="serial"):
    """裸 Runner 补位判定（不起 worker 线程；字段清单对齐
    tests/test_runner_pick_prefix.py 的 _bare_runner）+ board.settings_of
    模式打桩（serial N=1 / parallel N=5）。"""
    monkeypatch.setattr(board, "settings_of",
                        lambda pid: {"mode": mode, "sort": {"doing": "manual"}})
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    r._procs = {}
    r._stop_requested = set()
    return r


# ---------- 作答排队：一律收下答案入权威行（v2b T1 起与项目忙闲无关） ----------

def test_answer_queued_when_project_busy(monkeypatch):
    """项目忙（行口径：项目有运行前缀行）：答案先收下不送达——权威行 waiting
    （meta 全载荷）、占位投影单写
    （P4 R6：set_card_wait_placeholder，board 不再经 update_board_card）、
    旧 c: 条目取消（P4 R10：waitq.cancel 防御）、内存键唤醒、交互缓存清理，
    is_answer_pending=True。v2b T1 起一律入队（忙闲不再分叉），本用例钉「项目
    已有前缀行在场时」的端到端形态。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    waitq.enqueue(waitq.KIND_CARD, 5, 9)               # 同项目前序运行行（项目忙）
    assert waitq.claim_by_target(waitq.KIND_CARD, 5, "worker") is True
    err = board.answer_interaction(_proj(), _card(), "Q-1", _answers())
    assert err is None
    assert calls["answer"] == []                       # 未送达
    row = waitq.get_active(waitq.KIND_ANSWER, 1)       # 权威行（重启可恢复的事实源）
    assert row is not None and row["state"] == "waiting"
    meta = json.loads(row["meta"])
    assert meta["sid"] == "s-1" and meta["qid"] == "Q-1"
    assert meta["answers"] == [{"wire": "q_0", "kind": "single", "option_id": "o1",
                                "option_ids": [], "text": ""}]
    assert (waitq.KIND_CARD, 1) in calls["cancel"]     # 防旧 c: 条目误发「继续」（P4 R10 口径）
    assert ("submit_answer", 1) in r.calls             # 内存键唤醒
    assert calls["clear"] == ["s-1"]
    assert calls["ph"] == [(1, "")]                    # 占位投影单写（R6）
    assert board.is_answer_pending(1) is True          # 现读表（waiting 命中）


def test_answer_queued_keeps_pending_when_column_write_fails(monkeypatch):
    """占位投影写入失败（如 sqlite 抖动，真实故障：卡 389 答案收下、列写入丢失，
    卡片滞留阻塞列让用户以为作答无效）：权威行先落不受影响（事实源），不向用户
    报错；卡列由送达执行体归位兜底（原 _iw_once 自愈分支已退场，裁决 R3）。"""
    r = _FakeRunner()
    _patch(monkeypatch, r)

    def boom(cid, block_text=""):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(board.waitq, "set_card_wait_placeholder", boom)
    err = board.answer_interaction(_proj(), _card(), "Q-1", _answers())
    assert err is None
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is not None
    assert board.is_answer_pending(1) is True


def test_answer_always_enqueues_when_idle(monkeypatch):
    """项目空闲也一律入队（v2b T1，裁决 R8：删闲时直送分支）——权威行
    waiting、doing/queue 占位投影、内存键唤醒（补位时机①）、交互缓存清理，
    **未送达**（补位启动时才由 worker 送达；断言翻转自原 test_answer_direct_when_idle）。
    位次几何：种 running 前缀行 + 既有 waiting 行，作答行 seq 落在二者之间
    （「运行中最后一个条目后面」=前缀后/等待区最前，insert_after_prefix）。"""
    r = _FakeRunner()                                # 项目空闲
    calls = _patch(monkeypatch, r)
    with db.connect() as conn:                       # 运行前缀行（seq=1.0）
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (9,'card','5','running',1.0,?,'{}')",
            (db.now_str(),))
    w = waitq.enqueue(waitq.KIND_CARD, 6, 9)         # 等待区既有行（seq=2.0）
    err = board.answer_interaction(_proj(), _card(), "Q-1", _answers())
    assert err is None
    assert calls["answer"] == []                     # 未送达（直送分支已删）
    row = waitq.get_active(waitq.KIND_ANSWER, 1)
    assert row is not None and row["state"] == "waiting"
    assert 1.0 < row["seq"] < waitq.get_item(w)["seq"]   # 前缀后、等待区最前
    assert calls["ph"] == [(1, "")]                  # doing/queue 占位投影
    assert (waitq.KIND_CARD, 1) in calls["cancel"]   # 防旧 c: 条目误发「继续」
    assert ("submit_answer", 1) in r.calls           # 内存键唤醒
    assert calls["clear"] == ["s-1"]
    assert board.is_answer_pending(1) is True


def test_answer_delivered_on_refill(monkeypatch):
    """入队后由 worker 补位拾起才送达（删直送后的唯一送达路径）：空闲作答 →
    行 waiting 未送达；worker 拾取（claim→starting）→ 执行体送达 → dsh 侧
    提问得到应答（answer_question 调用即送达事实，提问消失）、行 done、
    卡归位 doing、登记 c: 占用。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    assert board.answer_interaction(_proj(), _card(), "Q-1", _answers()) is None
    assert calls["answer"] == []                     # 入队时不送达
    row = waitq.get_active(waitq.KIND_ANSWER, 1)
    waitq.claim(row["id"], "worker")                 # 补位拾起
    board._deliver_answer_unit(1)                    # 执行体送达
    assert calls["answer"] == [("s-1", "Q-1", _dsh_payload())]   # dsh 侧提问已应答
    assert waitq.get_item(row["id"])["state"] == "done"
    (cid, kw), = calls["upd"]
    # mark_unread=False：作答送达是用户作答引发的回列，不置「有更新」标记（2026-10-07）
    assert cid == 1 and kw == {"column_key": "doing", "mark_unread": False,
                               "block_kind": None, "block_text": ""}
    assert ("start", 1, 9) in r.calls                # 恢复会话占住串行位


def test_answer_own_card_hold_still_enqueues(monkeypatch):
    """本卡 c: 活跃行在场（出队残留形态）也一律入队——豁免不在作答分支（旧
    _own_occupancy 直送旁路已删），而在补位器（R5⑥/R7 本卡判据）：入队后
    _pick_locked 对本卡 c: 活跃行折抵前缀，a: 行照常可拾。"""
    r = _FakeRunner()                                # 项目被前序单元占着（见注释）
    calls = _patch(monkeypatch, r)
    err = board.answer_interaction(_proj(), _card(), "Q-1", _answers())
    assert err is None
    assert calls["answer"] == []                     # 不再直送
    row = waitq.get_active(waitq.KIND_ANSWER, 1)
    assert row is not None and row["state"] == "waiting"
    picker = _bare_picker(monkeypatch)
    # 本卡会话占着运行位（跨轮持有形态=活跃 c: 行，行即表征）
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    assert waitq.claim_by_target(waitq.KIND_CARD, 1, "worker") is True
    assert picker._pick_locked() == "a:1"            # 自身占位折抵 → 可启动


def test_own_session_msg_occupancy_still_delivers(monkeypatch):
    """卡 391 回归（R5⑥ 端到端，一律入队后此路径成为主路径）：同会话 m:
    运行单元占位下作答照常入队，补位器豁免（同 sid 的活跃 m: 行 → 该占位不计
    前缀）使 a: 行可拾、执行体送达解锁。

    实障卡 391：平台消息单元（用户在会话窗发的「grill-me」）占着项目运行位等
    turn 结束，而 turn 正挂在提问上——作答入队后若被该占位挡住即三方互等
    （答案等单元结束、单元等 turn 结束、turn 等答案）。全链路：作答入队 →
    m: 行 starting（chat_msgs.sid=s-1）→ _pick_locked 放行 a: → claim →
    执行体送达 → 行 done。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    assert board.answer_interaction(_proj(), _card(), "Q-1", _answers()) is None
    assert calls["answer"] == []                     # 入队不直送（旁路已删）
    row = waitq.get_active(waitq.KIND_ANSWER, 1)
    assert row is not None and row["state"] == "waiting"
    # 同会话 m: 运行单元占位（行 starting + chat_msgs.sid=s-1，同键去重）
    picker = _bare_picker(monkeypatch)
    waitq.msg_enqueue("m1", 9, "s-1", "grill-me")
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET state='starting'"
                     " WHERE kind='msg' AND target_id='m1'")
    assert picker._pick_locked() == "a:1"            # 豁免放行（防死锁唯一闸）
    waitq.claim(row["id"], "worker")
    board._deliver_answer_unit(1)                    # worker 执行体
    assert calls["answer"]                           # 送达解锁
    assert waitq.get_item(row["id"])["state"] == "done"


def test_answer_queued_when_other_session_message_unit_holds(monkeypatch):
    """占位者是**别的会话**的消息单元：仍是真排队（不能借道解锁别的会话）
    ——作答照常入队，补位器不豁免（sid 不匹配），a: 行留队不拾。
    占位表征=前缀**行**（m: 行 starting），折抵判据读 chat_msgs.sid。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    err = board.answer_interaction(_proj(), _card(), "Q-1", _answers())
    assert err is None
    assert calls["answer"] == []
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is not None   # 权威行 waiting
    picker = _bare_picker(monkeypatch)
    waitq.msg_enqueue("m9", 9, "s-99", "别的会话")               # 别会话占位（前缀行）
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET state='starting'"
                     " WHERE kind='msg' AND target_id='m9'")
    assert picker._pick_locked() is None             # 不豁免：前缀窗口已满留队


def test_answer_task_side_without_card_id_direct(monkeypatch):
    """任务侧（card 无 id）不参与排队：保持直送（specQ §5 边界不变）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    err = board.answer_interaction(_proj(), {"session_id": "s-1"}, "Q-1", _answers())
    assert err is None and calls["answer"]
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None


# ---------- 审批作答：同路入队（v2b T1 删恒直送） ----------

def _approval_st(**kw):
    base = {"pending": True, "busy": True, "kind": "approval",
            "approval_id": "A-1"}
    base.update(kw)
    return base


def test_approval_answer_enqueues(monkeypatch):
    """审批作答同路入队（v2b T1，裁决 R8：删恒直送）——空闲也入队：权威行
    waiting（approval 载荷，含平台决策映射出的 dsh outcome）、占位投影、内存键
    唤醒、清交互缓存，**未送达**；补位拾起后执行体按 meta 分发
    answer_approval(sid, approval_id, outcome) 送达，行 done。"""
    r = _FakeRunner()                                # 项目空闲
    calls = _patch(monkeypatch, r)
    monkeypatch.setattr(board, "interaction_of_sid",
                        lambda sid: _approval_st())
    sent = []
    monkeypatch.setattr(board.dshdriver, "answer_approval",
                        lambda sid, aid, outcome: sent.append((sid, aid, outcome)))
    # scope=session：dsh 无「本会话内批准」语义 → 明确拒绝、不入队
    assert board.answer_approval(_proj(), _card(), "A-1", "approved",
                                 scope="session") == \
        "dsh 不支持「本会话内批准」（宿主无 session 级放行语义）"
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None
    err = board.answer_approval(_proj(), _card(), "A-1", "approved")
    assert err is None
    assert sent == []                                # 未直送
    row = waitq.get_active(waitq.KIND_ANSWER, 1)
    assert row is not None and row["state"] == "waiting"
    assert json.loads(row["meta"]) == {"sid": "s-1", "approval_id": "A-1",
                                       "decision": "approved", "scope": "",
                                       "outcome": "allowed-once"}
    assert calls["ph"] == [(1, "")]                  # doing/queue 占位投影
    assert ("submit_answer", 1) in r.calls
    assert calls["clear"] == ["s-1"]
    waitq.claim(row["id"], "worker")                 # 补位拾起
    board._deliver_answer_unit(1)                    # 执行体按 approval 载荷分发
    assert sent == [("s-1", "A-1", "allowed-once")]  # outcome 三参直传
    assert waitq.get_item(row["id"])["state"] == "done"


def test_approval_task_side_stays_direct(monkeypatch):
    """任务侧（card 无 id）审批照旧直送（specQ §5 边界不变），不入权威行。"""
    r = _FakeRunner()
    _patch(monkeypatch, r)
    monkeypatch.setattr(board, "interaction_of_sid",
                        lambda sid: _approval_st())
    sent = []
    monkeypatch.setattr(board.dshdriver, "answer_approval",
                        lambda sid, aid, outcome: sent.append((sid, aid, outcome)))
    err = board.answer_approval(_proj(), {"session_id": "s-1"}, "A-1", "approved")
    assert err is None
    assert sent == [("s-1", "A-1", "allowed-once")]   # approved→allowed-once
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None


# ---------- 执行体：worker 拾取后的送达 / 退避 / 放弃（P2） ----------

def test_deliver_answer_unit_success_orders_done_before_start(monkeypatch):
    """执行体送达成功：mark_done → 列归位 → card_started（顺序统一，裁决 R4）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    real_done = waitq.mark_done
    monkeypatch.setattr(board.waitq, "mark_done",
                        lambda iid: r.calls.append(("done", iid)) or real_done(iid))
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 9,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    waitq.claim(i, "worker")                           # worker 拾取已 claim
    board._deliver_answer_unit(1)
    assert waitq.get_item(i)["state"] == "done"
    (cid, kw), = calls["upd"]
    # 同 test_answer_delivered_on_refill：送达回列不置「有更新」标记（2026-10-07）
    assert cid == 1 and kw == {"column_key": "doing", "mark_unread": False,
                               "block_kind": None, "block_text": ""}
    assert r.calls[-2:] == [("done", i), ("start", 1, 9)]   # done 先于占用登记


def test_backoff_retry_40405_unchanged(monkeypatch):
    """退避/重试/40405 分流逐字保留（v2b T1 不动执行体处置，裁决 R8）：
    _ANSWER_BACKOFF_S=30 / _ANSWER_MAX_RETRIES=3；送达失败前两次放回
    waiting（not_before 退避 + retries+1），第 3 次 mark_failed + 清占位
    （watcher 重探 pending、用户可重答）；「问题已不存在」（dsh 驱动 40405，
    沿用原 kimi envelope code / msg 含 not found）重试无意义——直接 failed、
    retries 不动。"""
    assert board._ANSWER_BACKOFF_S == 30.0
    assert board._ANSWER_MAX_RETRIES == 3
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)

    def boom(sid, qid, answers):
        raise board.dshdriver.DshDriverError(-2, "dsh 驱动不可达")

    monkeypatch.setattr(board.dshdriver, "answer_question", boom)
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 9,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    for n in (1, 2, 3):
        waitq.claim(i, "worker")
        board._deliver_answer_unit(1)
        row = waitq.get_item(i)
        if n < 3:
            assert row["state"] == "waiting" and row["retries"] == n
            assert row["not_before"] > time.time()      # 退避窗口
        else:
            assert row["state"] == "failed"
    (cid, kw), = calls["upd"]
    assert kw == {"block_kind": None, "block_text": ""}  # 放弃时清占位（列不动）

    def gone(sid, qid, answers):
        raise board.dshdriver.DshDriverError(40405, "question not found")

    monkeypatch.setattr(board.dshdriver, "answer_question", gone)
    i2 = waitq.enqueue(waitq.KIND_ANSWER, 2, 9,
                       meta={"sid": "s-2", "qid": "Q-2", "answers": _answers()})
    waitq.claim(i2, "worker")
    board._deliver_answer_unit(2)
    row2 = waitq.get_item(i2)
    assert row2["state"] == "failed" and row2["retries"] == 0   # 直 failed
    assert calls["upd"][-1] == (2, {"block_kind": None, "block_text": ""})


def test_deliver_answer_unit_row_gone_noop(monkeypatch):
    """claim 后行被取消（停卡/移列与拾取的窗口竞态）：执行体直接 return
    （无列写、无送达——不复活已取消的行）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 9,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    waitq.claim(i, "worker")
    waitq.cancel(waitq.KIND_ANSWER, 1, "测试取消")
    board._deliver_answer_unit(1)
    assert calls["answer"] == [] and calls["upd"] == []


def test_deliver_answer_unit_missing_project_cancels(monkeypatch):
    """项目不存在（行 project_id 悬空）：cancel 终态 + reason 落 meta，不留
    waiting 孤儿（原影子用例 test_answer_shadow_terminal_on_missing_project
    语义移此）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 999999,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    waitq.claim(i, "worker")
    board._deliver_answer_unit(1)
    row = waitq.get_item(i)
    assert row["state"] == "cancelled"
    assert json.loads(row["meta"])["cancel_reason"] == "项目不存在"
    assert calls["answer"] == []


# ---------- 展示态：已作答·待送达按「排队中」呈现（2026-09-14） ----------

def test_card_json_exposes_answer_pending():
    """卡片 payload 携带 answer_pending（前端据此显示「排队中」而非「会话运行中」）。"""
    cid = board.db.insert_board_card(9, "标题", "")
    row = board.db.get_board_card(cid)
    assert board.card_json(row)["answer_pending"] is False
    waitq.enqueue(waitq.KIND_ANSWER, cid, 9)
    assert board.card_json(row)["answer_pending"] is True


def test_unit_state_queued_for_pending_answer(monkeypatch):
    """会话详情「队列」徽标（P6 解冻，裁决 R4）：待送达卡片改按 a:<cid> 键求
    真实位次（P2 冻结覆盖 {"state":"queued","pos":0,"total":0} 到期）——种子一条
    前序 waiting 行则 pos=2/total=2；任务键与无待送达卡片不受影响。"""
    import server
    r = runner.Runner.__new__(runner.Runner)     # 裸 Runner：unit_state 仅需锁
    r._cond = threading.Condition(threading.Lock())
    monkeypatch.setattr(server.runner, "INSTANCE", r)
    assert server._unit_state(9, "c:1") == {"state": "idle", "pos": 0, "total": 0}
    waitq.enqueue(waitq.KIND_TASK, 77, 9)        # 前序 waiting 行（占位次 1）
    _seed()                                      # answer 行（cid=1，位次 2）
    assert server._unit_state(9, "c:1") == {"state": "queued", "pos": 2, "total": 2}
    assert server._unit_state(9, "t:1") == {"state": "idle", "pos": 0, "total": 0}


def test_board_session_running_pending_answer_false(monkeypatch):
    """会话端点运行态：待送达卡片不算运行（不点亮「工作中…」脉冲）；其余照常。"""
    import server
    monkeypatch.setattr(server.board, "running_map", lambda: {})
    monkeypatch.setattr(server.board, "web_session_busy", lambda proj, sid: True)
    assert server._board_session_running(1, _proj(), "s-1") is True
    waitq.enqueue(waitq.KIND_ANSWER, 1, 9)
    assert server._board_session_running(1, _proj(), "s-1") is False


# ---------- 「立即送达」：claim + 直投，不等项目空闲（2026-09-14） ----------

def test_deliver_now_approval_payload(monkeypatch):
    """立即送达对审批载荷同样直投（_answer_deliver 按 meta 分发；v2b T1 审批
    同路入队后的强制启动口径，裁决 R12「立即送达≡强制启动」）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    sent = []
    monkeypatch.setattr(board.dshdriver, "answer_approval",
                        lambda sid, aid, outcome: sent.append((sid, aid, outcome)))
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 9,
                      meta={"sid": "s-1", "approval_id": "A-1",
                            "decision": "rejected", "scope": "",
                            "outcome": "rejected"})
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is True and err == ""
    assert sent == [("s-1", "A-1", "rejected")]       # 审批分发直投（outcome 三参）
    assert calls["answer"] == []                      # 未走提问通道
    assert waitq.get_item(i)["state"] == "done"


def test_deliver_now_bypasses_busy(monkeypatch):
    """立即送达：项目仍被其他单元占用也照送（用户自担并发风险）——claim 权威行
    （互斥点）、直投送达、行落 done、清排队占位、登记卡片占用（防恢复的会话与
    后续入队单元并发）。claim+直投天然绕过 busy 判定，占位卡照常送达。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = _seed()
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is True and err == ""
    assert calls["answer"] == [("s-1", "Q-1", _dsh_payload())]
    assert waitq.get_item(i)["state"] == "done"        # 权威行终态
    assert board.is_answer_pending(1) is False
    assert ("start", 1, 9) in r.calls
    assert calls["upd"] and calls["upd"][0][1].get("block_kind") is None
    assert calls["upd"][0][1].get("column_key") == "doing"


def test_deliver_now_claim_and_direct(monkeypatch):
    """立即送达 = claim + 直投：行 done、卡归位、card_started、remove_answer。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 9,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is True and err == ""
    assert waitq.get_item(i)["state"] == "done"
    assert calls["answer"] == [("s-1", "Q-1", _dsh_payload())]
    assert ("remove_answer", 1) in r.calls
    assert r.calls[-1] == ("start", 1, 9)


def test_deliver_now_rejects_when_worker_claimed(monkeypatch):
    """worker 已 claim（执行中）：立即送达拒绝（claim 互斥替代原 pop 互斥）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 9,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    waitq.claim(i, "worker")
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is False and err == "没有待送达的答案（可能已送达）"
    assert calls["answer"] == []


def test_deliver_now_no_pending_rejected():
    """无待送达答案：拒绝并给原因（重复点击 / 已由 worker 空闲送达）。"""
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is False and "没有待送达" in err


def test_deliver_now_failure_keeps_pending(monkeypatch):
    """立即送达失败：放回 waiting（retries 不动——手动失败不消耗重试额度）+
    内存键重入队（仍可由 worker 重试/送达），错误交调用方提示。"""
    r = _FakeRunner()
    _patch(monkeypatch, r)
    i = _seed()

    def boom(sid, qid, answers):
        raise board.dshdriver.DshDriverError(-1, "gone")

    monkeypatch.setattr(board.dshdriver, "answer_question", boom)
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is False and "gone" in err
    row = waitq.get_item(i)
    assert row["state"] == "waiting" and row["retries"] == 0
    assert json.loads(row["meta"])["sid"] == "s-1"
    assert board.is_answer_pending(1) is True
    assert ("submit_answer", 1) in r.calls


def test_deliver_now_question_gone_fails_fast(monkeypatch):
    """立即送达遇「问题已不存在」（40405 类，P4 必带①）：对齐执行体口径——
    立即 mark_failed + 清占位，不放回重入队（原口径会空转重试 3 次才放弃）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = _seed()

    def gone(sid, qid, answers):
        raise board.dshdriver.DshDriverError(40405, "question not found")

    monkeypatch.setattr(board.dshdriver, "answer_question", gone)
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is False and "回答失败" in err
    row = waitq.get_item(i)
    assert row["state"] == "failed" and row["retries"] == 0
    (cid, kw), = calls["upd"]
    assert kw == {"block_kind": None, "block_text": ""}   # 清占位（列不动）
    assert ("submit_answer", 1) not in r.calls            # 不重入队空转


def test_deliver_now_missing_project_cancels(monkeypatch):
    """立即送达遇项目不存在：cancel 终态 + reason 落 meta，拒绝并给原因
    （原影子用例 test_answer_shadow_terminal_on_missing_project_deliver_now
    语义移此——不留 waiting 孤儿）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    i = waitq.enqueue(waitq.KIND_ANSWER, 1, 999999,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is False and err == "项目不存在"
    row = waitq.get_item(i)
    assert row["state"] == "cancelled"
    assert json.loads(row["meta"])["cancel_reason"] == "项目不存在"
    assert calls["answer"] == []


def test_deliver_answer_endpoint_codes(monkeypatch):
    """server 端点：成功 200、被拒/失败 400（_board_owned 归属校验先行）。"""
    import server
    codes = []

    class H:
        def _board_owned(self, pid, cid):
            return {"id": pid}, {"id": cid}

        def _respond(self, code, body=b"", ctype=""):
            codes.append(code)

    monkeypatch.setattr(server.board, "deliver_pending_answer_now",
                        lambda cid: (True, ""))
    server.Handler._api_board_deliver_answer(H(), 9, 1)
    assert codes[-1] == 200
    monkeypatch.setattr(server.board, "deliver_pending_answer_now",
                        lambda cid: (False, "没有待送达的答案（可能已送达）"))
    server.Handler._api_board_deliver_answer(H(), 9, 1)
    assert codes[-1] == 400


def test_answer_endpoint_queued_true(monkeypatch):
    """server 看板作答端点响应语义（v2b T1）：看板卡路径作答一律入队，成功即
    queued=true（由 is_answer_pending 现读表派生）；任务侧端点照旧
    queued=false 直送边界不变。"""
    import server
    codes, bodies = [], []

    class H:
        def _board_owned(self, pid, cid):
            return {"id": pid, "agent_path": "dsh-plugin:/x"}, {"id": cid}

        def _respond(self, code, body=b"", ctype=""):
            codes.append(code)
            bodies.append(body)

    monkeypatch.setattr(server.runner, "agent_family", lambda p: "dsh_plugin")
    monkeypatch.setattr(server.board, "answer_interaction",
                        lambda proj, card, qid, answers: None)
    monkeypatch.setattr(server.board, "is_answer_pending", lambda cid: True)
    server.Handler._api_board_answer_interaction(
        H(), 9, 1, {"qid": "Q-1", "answers": [{"wire": "q_0"}]})
    assert codes[-1] == 200
    assert json.loads(bodies[-1]) == {"ok": True, "queued": True}


# ---------- 移列 / 停止取消待送达答案（2026-09-17；P2 权威 cancel） ----------

def test_stop_card_drops_pending_answer(monkeypatch):
    """停止卡片会话：同时取消该卡待送达的权威 answer 行 + 摘内存队列键
    （与「停会话先取消排队消息」同款）。覆盖停止按钮 / 删除 / 出队（容器迁移）
    等 stop_card 全路径——卡已停，迟到送达会唤醒已停会话、与用户意图相悖。"""
    cancelled = []
    r = _FakeRunner()
    monkeypatch.setattr(board.chat, "cancel_queued",
                        lambda card_id=None: cancelled.append(card_id))
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: None)  # 卡不存在：早退
    monkeypatch.setattr(board.runner, "INSTANCE", r)
    i = _seed()
    assert board.stop_card(1) is False
    assert cancelled == [1]
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None   # 权威行已取消
    row = waitq.get_item(i)
    assert row["state"] == "cancelled"
    assert json.loads(row["meta"])["cancel_reason"] == "停止/移列放弃"
    assert ("remove_answer", 1) in r.calls                  # 内存键摘除


def test_move_away_drops_pending_answer(monkeypatch):
    """拖离开发列（含 doing/queue 占位卡直接落手动阻塞、不走 stop_card 的路径）：
    取消待送达权威行 + 摘内存键——迟到送达会唤醒已停会话，且送达归位会把卡搬回
    doing/queue 与用户拖拽意图打架。"""
    row = {"id": 1, "project_id": 9, "title": "t", "description": "",
           "column_key": "doing", "sort_order": 1, "session_id": "s-1",
           "sessions": "[]", "block_kind": "queue", "block_text": "",
           "parent_card_id": None, "origin": None, "done_at": None,
           "trashed": 0, "trashed_at": None, "scheduled_at": None,
           "jira_key": "", "last_error": "", "last_error_at": None,
           "created_at": "", "updated_at": ""}
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: dict(row))
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **kw: None)
    monkeypatch.setattr(board, "stop_card", lambda cid: None)
    monkeypatch.setattr(board, "finish", lambda key, reason="", **kw: None)
    r = _FakeRunner()
    monkeypatch.setattr(board.runner, "INSTANCE", r)
    i = _seed()
    board.move_card(_proj(), 1, "blocked")
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None   # 权威行已取消
    row_i = waitq.get_item(i)
    assert row_i["state"] == "cancelled"
    assert json.loads(row_i["meta"])["cancel_reason"] == "停止/移列放弃"
    assert ("remove_answer", 1) in r.calls                  # 内存键摘除


# ---------- 重复作答替换：改答必须胜出（2026-09-19 回归） ----------

def test_answer_twice_busy_replaces_pending_payload(monkeypatch):
    """排队期间重复作答：后答胜出。排队分支的 enqueue 幂等语义是「同类同目标
    已有活跃行 → 复用既有行、不合入新 meta」，若不先取消既有活跃行就再次入队，
    改答会被静默吞掉、送达的仍是第一份（旧作答内存登记的整体覆盖 = 后答胜出）。
    busy 两次作答后：表中恰一条活跃 answer 行（旧行落 cancelled）、meta 载荷为
    第二份，submit_answer 两次补内存键（幂等）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    assert board.answer_interaction(_proj(), _card(), "Q-1", _answers()) is None
    first = waitq.get_active(waitq.KIND_ANSWER, 1)
    assert first is not None and first["state"] == "waiting"
    # 第二份答案改选 o2（扩缓存选项白名单），保证两次载荷可观测地不同
    st = _st()
    st["questions"][0]["options"].append({"id": "o2", "label": "B", "description": ""})
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: st)
    second = [{"wire": "q_0", "kind": "single", "option_id": "o2"}]
    assert board.answer_interaction(_proj(), _card(), "Q-1", second) is None
    assert calls["answer"] == []                       # 全程未直送（项目一直忙）
    rows = [x for x in waitq.active_items() if x["kind"] == waitq.KIND_ANSWER]
    assert len(rows) == 1                              # 恰一条活跃行（旧行已取消）
    assert rows[0]["id"] != first["id"]                # 全新入队，不是复用旧行
    old = waitq.get_item(first["id"])
    assert old["state"] == "cancelled"
    assert json.loads(old["meta"])["cancel_reason"] == "重复作答替换"
    meta = json.loads(rows[0]["meta"])
    assert meta["sid"] == "s-1" and meta["qid"] == "Q-1"
    assert meta["answers"] == [{"wire": "q_0", "kind": "single", "option_id": "o2",
                                "option_ids": [], "text": ""}]   # 后答胜出
    assert r.calls.count(("submit_answer", 1)) == 2    # 两次作答都补内存键（幂等）
    assert board.is_answer_pending(1) is True


def _row_backed_runner():
    """card_started/card_finished 绑定真实实现的假单例（其余保持假体记录）：
    送达/收尾的白盒需要真行写入，但不需要 worker 线程。"""
    r = _FakeRunner()
    r._cond = threading.Condition()
    r.card_started = lambda cid, pid, ext=None: \
        runner.Runner.card_started(r, cid, pid, ext=ext)
    r.card_finished = lambda cid, reason="": \
        runner.Runner.card_finished(r, cid, reason=reason)
    return r


def test_deliver_now_alongside_other_unit_prefix_row(monkeypatch):
    """R1：立即送达在真他主前缀行（t: 行）在场时照常起跑——送达恢复按行补回
    c: 行（占住运行位），他主行不被触碰（行口径下无「释放/误清」面）。"""
    r = _row_backed_runner()
    calls = _patch(monkeypatch, r)
    i = _seed()
    waitq.enqueue(waitq.KIND_TASK, 777, 9)              # 真他主前缀行在场
    assert waitq.claim_by_target(waitq.KIND_TASK, 777, "worker") is True
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is True and err == ""
    assert waitq.get_item(i)["state"] == "done"
    crow = waitq.get_active(waitq.KIND_CARD, 1)
    trow = waitq.get_active(waitq.KIND_TASK, 777)
    assert crow is not None and crow["state"] == "running"   # 恢复会话占住运行位
    assert trow is not None and trow["state"] == "starting"  # 他主行原样
    assert json.loads(crow["evidence"])["reason"] == "立即送达"
    r.card_finished(1, reason="测试收尾")               # 收尾只收本卡行
    assert waitq.get_active(waitq.KIND_CARD, 1) is None
    assert waitq.get_active(waitq.KIND_TASK, 777) is not None


def test_queue_deliver_success_restores_card_row(monkeypatch):
    """F1 回归（评审 Critical）：队列送达成功后必须补回 c: 行——worker 拾取时
    本单元只持 a: 行（送达期瞬态），若送达恢复不把卡行置 running，恢复会话全程
    不占运行位=串行破窗。主流路径全链路真行：出队释放 c: → 作答排队
    → 空闲送达 → c: 行 running、a: 行已终态。"""
    r = _row_backed_runner()                # 项目空闲（出队已释放 c: 行）
    _patch(monkeypatch, r)
    i = _seed()
    # 模拟 worker 路径（tests/test_waitq_shadow.py 白盒同型）：拾取即 claim
    # （a: 行 starting 即送达期占位表征）→ 执行体在 try 块内 → 行终态由执行体落
    waitq.claim(i, "worker")
    board._deliver_answer_unit(1)           # 执行体（worker try 块内）
    assert waitq.get_item(i)["state"] == "done"
    crow = waitq.get_active(waitq.KIND_CARD, 1)
    assert crow is not None and crow["state"] == "running"   # F1：恢复会话占住运行位
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None    # a: 行已终态
    assert json.loads(crow["evidence"])["reason"] == "送达恢复"
    r.card_finished(1, reason="测试收尾")    # 收尾只收本卡行
    assert waitq.get_active(waitq.KIND_CARD, 1) is None


def test_answer_row_lifetime_claim_to_done():
    """a: 行「拾取即在、终态即无」：claim → starting（送达期占位/占位读取面），
    mark_done → 无活跃行（送达窗口不靠第二表征）。"""
    i = _seed()
    assert waitq.claim(i, "worker") is True                     # 拾取
    row = waitq.get_active(waitq.KIND_ANSWER, 1)
    assert row is not None and row["state"] == "starting"       # 执行期在
    assert waitq.mark_done(i) is True
    assert waitq.get_active(waitq.KIND_ANSWER, 1) is None       # 终态即无
    assert waitq.get_item(i)["state"] == "done"


def test_deliver_now_keeps_prefix_position(monkeypatch):
    """立即送达≡强制启动（v2 §2.2【已定】，裁决 R12）：a: 行位次本已在前缀后
    （v2b T1 一律入队的插入点），claim+直投不改位次——行于原 seq（前缀后/
    等待区最前）落 done，恢复的 c: 行按行口径补回运行位（「立即送达」证据
    钉见 test_deliver_now_alongside_other_unit_prefix_row）。"""
    r = _FakeRunner()
    calls = _patch(monkeypatch, r)
    with db.connect() as conn:                       # 运行前缀行（seq=1.0）
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (9,'card','5','running',1.0,?,'{}')",
            (db.now_str(),))
    w = waitq.enqueue(waitq.KIND_CARD, 6, 9)         # 等待区行（seq=2.0）
    iid, seq0 = waitq.insert_after_prefix(
        waitq.KIND_ANSWER, 1, 9,
        meta={"sid": "s-1", "qid": "Q-1", "answers": _answers()})
    assert 1.0 < seq0 < waitq.get_item(w)["seq"]     # 入队位次=前缀后/等待区最前
    ok, err = board.deliver_pending_answer_now(1)
    assert ok is True and err == ""
    row = waitq.get_item(iid)
    assert row["state"] == "done" and row["seq"] == seq0   # 原位次收口不改序
    assert calls["answer"] == [("s-1", "Q-1", _dsh_payload())]
    assert ("start", 1, 9) in r.calls                # forced 登记不变
