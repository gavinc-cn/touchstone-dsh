"""runner 统一队列单测：拾取/读口/恢复/影子壳退场门禁；兼 answer 单元权威路径
回归（P2 起）。
v3a 起：前缀/窗口读口切行（c: 行跨轮 running 存活，行即成员）。
v3d 起：「占用」概念退场——读口全行口径（card_holds/session_holds/project_busy
等第二表征 API 删除），用例改钉行口径断言。"""
import inspect
import json
import threading
import time
import uuid

import pytest

import db
import runner
import waitq


def _bare_runner():
    """裸 Runner（不起 worker 线程）：单测专用。

    用 Runner.__new__ + 手工字段（对齐 tests/test_board_queue_doing.py 既有做法）：
    真实 Runner() 的 worker 线程会与用例抢夺队列键、把注入的键拾取执行掉，
    断言随之漂移——测试必须无后台消费者。P5 起 `_running`/`_card_busy`/`_own_meta`
    退场（v3d 起占用表征=等待项行），P6 起 `_msgs`/`_msg_sid` 镜像亦退场（移交⑧），
    裸实例字段清单缩减为 `_cond/_procs/_stop_requested`（R14）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    r._procs = {}
    r._stop_requested = set()
    return r


def _mk_project(**over):
    """建一个隔离项目行（路径唯一，避免项目表约束冲突）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"wc-{uid}", f"/tmp/wc-{uid}", "/bin/true",
                             f"/tmp/wc-{uid}/work", **over)


def _mk_task(project_id, **over):
    """建一个任务行（表默认 status=queued；裸 Runner 下不会被拾取执行）。"""
    return db.insert_task(project_id, f"t-{uuid.uuid4().hex[:6]}", 0, "不复测",
                          "rounds", 1, **over)


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def test_shadow_shells_retired():
    """P5 R7 验收（负向断言）：影子期标识符在 runner 源码中零命中——比对器/
    影子线程/安全壳/内存占用簿记全部退场（队列权威=wait_items 行）。

    v3a 口径收紧（评审 Important-1 复核后重写）：内存占用簿记 `_running` 的判据
    改为「先卸掉合法 API 名 `enter_running` / `mark_running`，再做**裸子串**扫描」
    ——这两个 v3a/v2a 的合法入口名内嵌 `_running` 子串，而本断言本义是「`_running`
    这个标识符（`self._running` / `Runner._running` / `_running_map` 等一切含该
    子串的形态）不得再出现」。**不得**改用带 lookbehind 的边界正则：排除词字符与
    `.` 会把 `self._running` / `Runner._running` 这两种最可能的复现形态一起放过
    （评审实测 `runner.py` 现存命中全部来自 `enter_running`，说明该 lookbehind
    连合法调用与被禁标识符都区分不开）。"""
    src = inspect.getsource(runner)
    for token in ("_card_busy", "_own_meta", "shadow_diff",
                  "start_shadow_verifier", "_shadow_acquire", "_shadow(",
                  "_note_own", "_start_unit_locked"):
        assert token not in src, f"影子期残留: {token}"
    src_sans_legit = src.replace("enter_running", "").replace("mark_running", "")
    assert "_running" not in src_sans_legit, "影子期残留: _running"


def test_submit_task_writes_waiting_row_and_cancel():
    """P4 权威入队：submit 即插 waiting 行（行即队列，取代旧影子入队写）；cancel 落终态。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)
    r.submit(tid)
    assert waitq.get_active(waitq.KIND_TASK, tid)["state"] == "waiting"
    waitq.cancel(waitq.KIND_TASK, tid, "任务删除")
    assert waitq.get_active(waitq.KIND_TASK, tid) is None


def test_submit_remove_task_hooks_write_authority_rows():
    """submit→waiting，remove→cancelled（裸 Runner：无 worker 干扰；P4 全直调，
    remove 系断言行终态而非行消失）。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)
    r.submit(tid)
    assert waitq.get_active(waitq.KIND_TASK, tid)["state"] == "waiting"
    r.remove(tid)
    assert waitq.get_active(waitq.KIND_TASK, tid) is None
    with db.connect() as conn:                  # 终态行仍在表（cancelled，非删除）
        row = conn.execute(
            "SELECT state FROM wait_items WHERE kind='task' AND target_id=?",
            (str(tid),)).fetchone()
    assert row is not None and row["state"] == "cancelled"


def test_submit_card_and_msg_hooks():
    r = _bare_runner()
    pid = _mk_project()
    cid = db.insert_board_card(pid, "shadow 卡")
    r.submit_card(cid)
    assert waitq.get_active(waitq.KIND_CARD, cid)["project_id"] == pid
    # P3：msg 等待项的权威写入归 chat.submit（msg_enqueue 一个事务双写）；
    # submit_msg 只回填内存镜像并唤醒
    waitq.msg_enqueue("m1", pid, "s", "hi")
    r.submit_msg("m1", pid)
    row = waitq.get_active(waitq.KIND_MSG, "m1")
    assert row is not None and row["state"] == "waiting"
    r.remove_msg("m1")
    # remove_msg 只摘内存镜像（P3 起权威取消归 chat.cancel）：等待项行不动
    assert waitq.get_active(waitq.KIND_MSG, "m1")["state"] == "waiting"


def test_claim_unit_and_terminal_by_key():
    """P4 全类直调的权威互斥点：_claim_unit 拾取 → starting；finish → 终态。"""
    pid = _mk_project()
    tid = _mk_task(pid)
    waitq.enqueue(waitq.KIND_TASK, tid, pid)               # waiting（submit 同款权威行）
    assert runner._claim_unit(f"t:{tid}") is True
    assert waitq.get_active(waitq.KIND_TASK, tid)["state"] == "starting"
    waitq.finish_by_target(waitq.KIND_TASK, tid)
    assert waitq.get_active(waitq.KIND_TASK, tid) is None


def test_card_started_finished_row_roundtrip():
    """v3d 行口径：card_started=把 c: 行置 running（**不**落 done——行跨轮存活
    构成运行前缀，占用=行在场）；重复调用幂等（行态/证据不动）；
    card_finished 收口行落 done（会话结束即出队）。"""
    r = _bare_runner()
    pid = _mk_project()
    cid = db.insert_board_card(pid, "shadow 卡")
    r.submit_card(cid)
    runner._claim_unit(f"c:{cid}")                         # worker 拾取 → starting
    assert r.card_started(cid, pid) is True                # 起跑证实：行置 running
    assert r.card_started(cid, pid) is True                # 幂等（行态不动）
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "running"   # 行跨轮存活（旧口径此处落 done）
    r.card_finished(cid)                                   # 会话结束：行终态
    assert waitq.get_active(waitq.KIND_CARD, cid) is None
    assert waitq.get_item(row["id"])["state"] == "done"


def test_card_started_reopens_terminal_row_and_creates_missing():
    """v3a enter_running 矩阵（card_started 统一入口）：无活跃行 → 建行直置
    running（送达恢复 / 阻塞解除归位 / recover 重建形态）；行已终态（落阻塞/
    停止/移列等出队路径）→ 复用同一行（同 id、同 seq）重开 running。
    两条路径都不得插第二行（活跃唯一索引 (kind,target_id) 覆盖 running）。"""
    r = _bare_runner()
    pid = _mk_project()
    # ① 终态行在场（出队形态）→ 复用同一行重开 running
    cid = db.insert_board_card(pid, "恢复卡")
    waitq.enqueue_card(cid, pid)
    wid = waitq.get_active(waitq.KIND_CARD, cid)["id"]
    seq_old = waitq.get_item(wid)["seq"]
    waitq.cancel_card_wait(cid, "落阻塞丢排队")            # 出队：行 cancelled
    assert r.card_started(cid, pid) is True                # 送达恢复起跑证实
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "running"
    assert row["id"] == wid and row["seq"] == seq_old      # 同 id 同 seq（不新插行）
    # ② 无任何行（阻塞解除归位形态）→ 建行直置 running
    cid2 = db.insert_board_card(pid, "归位卡")
    assert r.card_started(cid2, pid) is True
    row2 = waitq.get_active(waitq.KIND_CARD, cid2)
    assert row2 is not None and row2["state"] == "running"
    with db.connect() as conn:                             # 同键活跃行恒唯一
        n = conn.execute(
            "SELECT COUNT(*) n FROM wait_items WHERE kind='card' AND target_id=?"
            " AND state IN ('waiting','starting','running','finishing')",
            (str(cid2),)).fetchone()["n"]
    assert n == 1


def test_worker_pick_claims_row_and_terminal_at_boundary(monkeypatch):
    """端到端：真实 worker 拾取 → 行 starting（claim 锁内直调，F2 结构保证，
    行即占用表征）；轮边界 finally 行落终态。"""
    r = runner.Runner()                     # 真实 worker（daemon；conftest 每例还原 INSTANCE）
    monkeypatch.setattr(runner, "INSTANCE", r)
    pid = _mk_project()
    tid = _mk_task(pid)
    release = threading.Event()

    def _fake_process(self, task_id):       # 打桩：拾取后挂住，不跑真实轮次
        row = waitq.get_active(waitq.KIND_TASK, task_id)
        assert row is not None and row["state"] == "starting"   # 行即占用表征
        release.wait(5)

    monkeypatch.setattr(runner.Runner, "_process_task", _fake_process)
    r.submit(tid)
    deadline = time.time() + 5
    while time.time() < deadline:
        row = waitq.get_active(waitq.KIND_TASK, tid)
        if row is not None and row["state"] == "starting":
            break
        time.sleep(0.05)
    assert waitq.get_active(waitq.KIND_TASK, tid)["state"] == "starting"
    release.set()
    deadline = time.time() + 5
    while time.time() < deadline and waitq.get_active(waitq.KIND_TASK, tid) is not None:
        time.sleep(0.05)
    assert waitq.get_active(waitq.KIND_TASK, tid) is None   # 等待项落终态


def test_submit_failure_is_authority_error(monkeypatch):
    """P4 权威口径（影子壳退场）：入队写表失败即业务失败，submit 原样上抛。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)

    def _boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(waitq, "enqueue", _boom)
    with pytest.raises(RuntimeError):
        r.submit(tid)                                # 不再吞异常（失败即业务失败）


def test_recover_keeps_rows_for_reconcile_and_closes_dead(monkeypatch):
    """P4/v3c：recover 不清占位，残留**行**由随后的
    reconcile_units 按证据裁活：任务终态 = 可证死 → 行收口；queued=新生窗口
    （评审 Important-1）判 unknown 保留；waiting 行存活（P4 变更②）不受影响。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)                      # status queued
    rid_t = waitq.enqueue(waitq.KIND_TASK, tid, pid)
    cid = db.insert_board_card(pid, "recover 卡")
    # not_before 钉远期：套件遗留野 worker 拾取免疫（本例只验行存活+行裁活）
    waitq.enqueue(waitq.KIND_CARD, cid, pid, not_before=time.time() + 3600)

    r.recover()

    assert waitq.get_item(rid_t)["state"] == "waiting"     # recover 不清行（R5：对账接棒）
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "waiting"   # waiting 行存活（变更②）

    monkeypatch.setattr(runner, "INSTANCE", r)
    runner.reconcile_units()                     # board.recover 之后的启动对账（R5 顺序）
    assert waitq.get_active(waitq.KIND_TASK, tid) is not None   # queued=新生窗口 → 不裁
    db.update_task(tid, status="interrupted")    # recover 对 running 任务的打断形态
    runner.reconcile_units()
    assert waitq.get_active(waitq.KIND_TASK, tid) is None       # 可证死（任务终态）→ 收口
    meta = json.loads(waitq.get_item(rid_t)["meta"])
    assert meta["cancel_reason"] == "启动对账：可证明失效"        # reason 标签逐字保留


def test_start_unit_selfcheck_first_tick_grace(monkeypatch):
    """自检线程首轮宽限（P5 T4 接线口径；v3c 行版命名）：先睡一个周期再首查
    ——启动对账（reconcile_units）刚收尾无需立即复查，且给拾取→行置 running/
    证据落行毫秒窗让路；min_age 透传 enforce（行年龄豁免）；
    managed（平台在管豁免判据）每拍注入（v3c 修复轮 Important-2 接线）；
    stop 事件可终止线程。"""
    calls = []
    stop = threading.Event()

    def _fake_selfcheck_units(probe=None, min_age=0.0, managed=None):
        calls.append((min_age, managed))
        return []

    import board                # 函数内 import：与产品侧同款防循环口径
    monkeypatch.setattr(waitq, "selfcheck_units", _fake_selfcheck_units)
    monkeypatch.setattr(runner, "INSTANCE", _bare_runner())
    runner.start_unit_selfcheck(interval=0.2, min_age=7.0, stop=stop)
    try:
        time.sleep(0.05)                         # 不足一个周期：首轮未查（宽限）
        assert calls == []
        deadline = time.time() + 10              # 并发重负载下线程调度可延迟（3s 曾偶发）
        while not calls and time.time() < deadline:
            time.sleep(0.02)
        # 首查带 min_age 透传 + managed 判据=board.unit_managed（在管不越权收口）
        assert calls and all(a == 7.0 and m is board.unit_managed
                             for a, m in calls)
    finally:
        stop.set()


def test_reconcile_units_notifies_workers_on_close(monkeypatch):
    """对账收口串行位后唤醒 worker 补位（fix round 1，e2e_board_continue 阶段五
    停滞复盘）：recover 的 notify 先于对账，其间扫描见残留行（项目忙）回
    cond.wait() 的 worker 必须被再唤醒，否则排队单元停滞到下个外部事件；
    无收口则不多余唤醒。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)
    db.update_task(tid, status="interrupted")        # 终态 → 对账可证死
    waitq.enqueue(waitq.KIND_TASK, tid, pid)
    notified = []
    monkeypatch.setattr(r._cond, "notify_all", lambda: notified.append(1))
    monkeypatch.setattr(runner, "INSTANCE", r)
    runner.reconcile_units()
    assert notified                                    # 有收口 → 唤醒
    notified.clear()
    runner.reconcile_units()                           # 无收口 → 不再唤醒
    assert notified == []


def test_unit_selfcheck_notifies_on_close(monkeypatch):
    """自检收口串行位后同样唤醒 worker 补位（与 reconcile_units 同款口径）。"""
    stop = threading.Event()
    monkeypatch.setattr(waitq, "selfcheck_units",
                        lambda probe=None, min_age=0.0, managed=None:
                        ["自检收口可证死行: t:9"])
    r = _bare_runner()
    notified = []
    monkeypatch.setattr(r._cond, "notify_all", lambda: notified.append(1))
    monkeypatch.setattr(runner, "INSTANCE", r)
    runner.start_unit_selfcheck(interval=0.05, min_age=1.0, stop=stop)
    try:
        deadline = time.time() + 3
        while not notified and time.time() < deadline:
            time.sleep(0.02)
        assert notified                                # 首轮（宽限后）收口 → 唤醒
    finally:
        stop.set()


def test_submit_answer_wakes_and_remove_answer_leaves_row():
    """P4：submit_answer 只唤醒（行由调用方写入）；remove_answer 不碰行——
    权威取消归 board 的 waitq.cancel。"""
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_ANSWER, 501, 9)
    r.submit_answer(501)
    r.submit_answer(501)                         # 幂等：只唤醒，不动行
    assert waitq.get_active(waitq.KIND_ANSWER, 501)["state"] == "waiting"
    r.remove_answer(501)
    assert waitq.get_active(waitq.KIND_ANSWER, 501)["state"] == "waiting"   # 权威未动
    waitq.cancel(waitq.KIND_ANSWER, 501, "测试")
    assert waitq.get_active(waitq.KIND_ANSWER, 501) is None


def test_answer_row_legal_and_unit_state_running():
    """a: 执行期行合法（claim → starting）：unit_state 按**行态**报 running
    （活跃非等待行即运行上报）；行终态后回 idle（无第二表征可查）。"""
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_ANSWER, 888, 9)
    waitq.claim_by_target(waitq.KIND_ANSWER, 888, "worker")
    assert r.unit_state("a:888", 9) == {"state": "running", "pos": 0, "total": 0}
    waitq.mark_done(waitq.get_active(waitq.KIND_ANSWER, 888)["id"])
    assert r.unit_state("a:888", 9) == {"state": "idle", "pos": 0, "total": 0}


def test_pick_locked_answer_unit_rules():
    """a: 拾取三规则（行口径：占位判据=前缀**行**，折抵判据=本卡 c: 活跃行 /
    同 sid 的 m: 活跃行）：
    项目忙留队 / 占用者即本会话自身可拾（卡 391）/ 行消失不拾。"""
    r = _bare_runner()
    pid = _mk_project()
    cid = db.insert_board_card(pid, "答案卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid,
                  meta={"sid": "s-1", "qid": "q1", "answers": []})
    r.submit_answer(cid)
    ti = waitq.enqueue(waitq.KIND_TASK, 1, pid)             # 他单元占项目（前缀行）
    waitq.claim(ti, "worker")
    assert r._pick_locked() is None                         # 忙 → 留队
    waitq.msg_enqueue("m1", pid, "s-1", "hi")               # 占用者=本会话消息单元（行前缀）
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")   # 折抵判据读 chat_msgs.sid
    # v2a T3（裁决 R5⑥ 豁免合体）：豁免改「该占用不计入前缀」的选择性折抵——
    # 本会话 m: 占用折抵后真他主 t:1 仍占满 serial 窗口 → 留队（旧口径为二元
    # bypass 整体放行，断言翻转记录于 v2a T3 ledger）
    assert r._pick_locked() is None                          # 真他主在场：豁免不覆盖
    waitq.cancel(waitq.KIND_TASK, 1, "测试收尾")              # 真他主退场
    assert r._pick_locked() == f"a:{cid}"                    # 仅剩自身占用 → 放行（卡 391）
    waitq.cancel(waitq.KIND_ANSWER, cid, "测试")  # 行消失（停卡/移列取消）
    assert r._pick_locked() is None
    assert waitq.get_active(waitq.KIND_ANSWER, cid) is None   # 行已终态（行即队列，无键可摘）


def test_recover_preserves_answer_rows_and_reenqueues():
    """P2 行为变更：recover 不清 answer 行；starting 放回 waiting（必带③：计入
    重投计数）；活跃行即登记（P4 行即队列）。"""
    r = _bare_runner()
    pid = _mk_project()
    cid = db.insert_board_card(pid, "存活卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid,
                  meta={"sid": "s", "qid": "q", "answers": []})
    waitq.claim_by_target(waitq.KIND_ANSWER, cid, "worker")   # 模拟重启前执行中
    tid = _mk_task(pid)
    # t: 行直插且 not_before 钉远期：套件里前序用例遗留的真实 Runner worker 线程
    # 仍可能被唤醒拾取——本例只验行存活，钉远期即对野 worker 免疫
    waitq.enqueue(waitq.KIND_TASK, tid, pid, not_before=time.time() + 3600)
    r.recover()
    row = waitq.get_active(waitq.KIND_ANSWER, cid)
    assert row is not None and row["state"] == "waiting"      # 存活 + 放回
    assert waitq.get_active(waitq.KIND_TASK, tid)["state"] == "waiting"   # 任务行同样存活（变更①）


def test_answer_unit_claim_failure_skips_executor(monkeypatch):
    """拾取后 claim 失败（行被取消/直投抢走）：行未被本侧落终态、本侧不新建行。
    「执行体不被调用」由 test_answer_queue 的 claim 互斥用例覆盖。以 claim
    尝试计数定位拾取时点（行即队列，无内存键可轮询）；断言后取消行，终止
    worker 对 waiting 行的重拾循环。"""
    real_claim = waitq.claim_by_target
    attempts = []

    def _fake_claim(kind, t, claimer=""):
        if kind == waitq.KIND_ANSWER:
            attempts.append(t)
            return False
        return real_claim(kind, t, claimer)

    monkeypatch.setattr(runner.waitq, "claim_by_target", _fake_claim)
    r = runner.Runner()
    monkeypatch.setattr(runner, "INSTANCE", r)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "抢走卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid)
    r.submit_answer(cid)
    deadline = time.time() + 5
    while time.time() < deadline and not attempts:
        time.sleep(0.05)
    assert attempts                                        # worker 已拾取并尝试 claim
    row = waitq.get_active(waitq.KIND_ANSWER, cid)
    assert row is not None and row["state"] == "waiting"   # 行未被本侧落终态
    waitq.cancel(waitq.KIND_ANSWER, cid, "测试收尾")        # 停重拾循环（行保持 waiting 会反复重试）


def test_answer_unit_claim_exception_returns_false(monkeypatch):
    """P2 权威路径保护：claim_by_target 瞬时故障（如 sqlite 抖动）不得炸掉
    worker 线程——_claim_unit 捕获异常按 claim 失败处理（返回 False），行保持
    waiting 待下轮。"""
    real_claim = waitq.claim_by_target
    attempts = []

    def _boom(kind, t, claimer=""):
        if kind == waitq.KIND_ANSWER:
            attempts.append(t)
            raise RuntimeError("database is locked")
        return real_claim(kind, t, claimer)

    monkeypatch.setattr(runner.waitq, "claim_by_target", _boom)
    r = runner.Runner()
    monkeypatch.setattr(runner, "INSTANCE", r)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "抖动卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid)
    r.submit_answer(cid)
    deadline = time.time() + 5
    while time.time() < deadline and not attempts:
        time.sleep(0.05)
    assert attempts                                        # worker 已拾取并尝试 claim
    row = waitq.get_active(waitq.KIND_ANSWER, cid)
    assert row is not None and row["state"] == "waiting"   # 行未被本侧落终态
    waitq.cancel(waitq.KIND_ANSWER, cid, "测试收尾")        # 停重拾循环


def test_claim_and_start_locked_double_pick_loser_leaves_winner_intact():
    """F2 回归：同键双拾取竞态——claim 锁内先仲裁，落败方不触碰胜利者已置的
    行（行即表征）。

    旧内存登记形状下落败方回滚 `pop(key)` 会误删胜利者登记（项目位假空闲 →
    排队任务并发起跑）；行口径下回滚只触碰本 worker 的等待项行：胜利者行
    （id/state/seq）原样。白盒直调两次收口（生产锁形状，无线程）。"""
    r = _bare_runner()
    r._lock = threading.Lock()                   # 生产锁语义（非可重入，同 no-relock 用例）
    r._cond = threading.Condition(r._lock)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "双拾取卡")
    # not_before 钉远期：收口直调不查该字段（claim 照常），但对套件
    # 遗留野 worker 免疫——防行在断言前被抢拾执行
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid,
                  meta={"sid": "s-1", "qid": "q1", "answers": []},
                  not_before=time.time() + 3600)
    with r._cond:                                # 胜利者：claim 成功（行置 starting）
        assert r._claim_and_start_locked(f"a:{cid}") == pid
    winner = waitq.get_active(waitq.KIND_ANSWER, cid)
    with r._cond:                                # 落败者：行已 starting，claim 必败
        assert r._claim_and_start_locked(f"a:{cid}") is None
    after = waitq.get_active(waitq.KIND_ANSWER, cid)
    assert (after["id"], after["state"], after["seq"]) \
        == (winner["id"], winner["state"], winner["seq"])   # 胜利者行原样


def test_claim_and_start_locked_msg_row_and_sid():
    """F2 配套：m: 收口——claim 失败（被「立即注入」抢占）行仍 waiting；
    claim 成功行置 starting（项目来源=等待项行，与 a: 分支同构），
    项目定位于该行，会话归属读 chat_msgs.sid（session_holds 判据）。"""
    r = _bare_runner()
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    with db.connect() as conn:    # 钉远期：收口直调不查该字段，但对野 worker 免疫
        conn.execute("UPDATE wait_items SET not_before=?"
                     " WHERE kind='msg' AND target_id='m1'", (time.time() + 3600,))
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "inject-now")   # 被立即注入抢占
    with r._cond:
        assert r._claim_and_start_locked("m:m1") is None
    assert waitq.get_active(waitq.KIND_MSG, "m1")["state"] == "starting"   # 行未被本侧改写
    waitq.return_to_waiting(waitq.get_active(waitq.KIND_MSG, "m1")["id"])
    with r._cond:                                # 行回 waiting：claim 成功
        assert r._claim_and_start_locked("m:m1") == 9
    assert waitq.get_active(waitq.KIND_MSG, "m1")["state"] == "starting"
    assert r.session_holds(9, "s-1") is True     # sid 自 chat_msgs 行反查
    assert r.session_holds(9, "s-2") is False    # 别的会话不算自身占位


def test_pick_own_hold_via_card_row():
    """卡 391 防死锁闸（裁决 R5⑥/R7 行口径）：own-hold 豁免为「该占用不计入
    前缀」的选择性折抵——他主**前缀行**在场时本卡运行行折抵后窗口仍满 →
    留队；他主退场仅剩本卡行时 a: 照常可拾（无作答死锁回归）。裸 Runner 无野
    worker 面（autouse 夹具清表），不钉 not_before——钉远期
    反而被拾取退避跳过。"""
    r = _bare_runner()
    pid = _mk_project()
    cid = db.insert_board_card(pid, "force 卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid, meta={"sid": "s1"})
    ti = waitq.enqueue(waitq.KIND_TASK, 999, pid)           # 他主前缀行在场
    waitq.claim(ti, "worker")
    waitq.enqueue(waitq.KIND_CARD, cid, pid)                # 本卡运行行（force 直起形态）
    assert waitq.claim_by_target(waitq.KIND_CARD, cid, "force") is True
    assert r._pick_locked() is None                         # 选择性折抵：t:999 仍占窗
    waitq.cancel(waitq.KIND_TASK, 999, "测试收尾")            # 他主退场
    key = r._pick_locked()
    assert key == f"a:{cid}"                                # own-hold：本卡行折抵放行


def test_own_hold_full_chain_with_card_row():
    """Critical 回归（fix round 1；行口径重写）：own-hold 豁免命中的拾取必须
    真正走通——否则行放回 waiting → worker 无限热旋重拾，答案永不能经队列
    送达（卡 391 死锁以新形态复活）。全链路白盒：他主行先占 → 收敛为本卡
    c: 行（force 直起带待答 a:）→ a: waiting → 拾取豁免 → 收口走通（claim +
    行口径复判）→ 他主行退场、本卡行原样。"""
    r = _bare_runner()
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "收敛卡")
    # 可达时序：作答时点项目被他主占用（a: 排队入队）→ 随后占用收敛为本卡行
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid, meta={"sid": "s-1"})
    waitq.enqueue(waitq.KIND_CARD, cid, pid)            # 本卡行（force 直起落行形态）
    assert waitq.claim_by_target(waitq.KIND_CARD, cid, "force") is True
    with r._cond:
        assert r._pick_locked() == f"a:{cid}"           # own-hold 豁免放行
    # 钉远期（消理论 flake）：拾取验证后把行钉进退避窗口，对套件
    # 遗留野 worker 免疫（收口直调不查 not_before）
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET not_before=?"
                     " WHERE kind='answer' AND target_id=?",
                     (time.time() + 3600, str(cid)))
    with r._cond:
        assert r._claim_and_start_locked(f"a:{cid}") == pid   # 送达可达（旧形状此处 None→热旋）
    assert waitq.get_active(waitq.KIND_ANSWER, cid)["state"] == "starting"
    crow = waitq.get_active(waitq.KIND_CARD, cid)
    assert crow is not None and crow["state"] == "starting"   # 本卡行不受影响


def test_own_hold_full_chain_with_session_msg_row():
    """同上，收敛形态=本会话 m: 行（送达退避窗口内本会话消息单元起跑）：
    折抵判据（chat_msgs.sid 匹配）成立 → 行口径复判放行，m: 行不受影响。"""
    r = _bare_runner()
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "会话收敛卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid, meta={"sid": "s-1"},
                  not_before=time.time() + 3600)   # 钉远期防野 worker（收口直调不查）
    waitq.msg_enqueue("m1", pid, "s-1", "grill-me")   # 本会话消息单元占位（行）
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")
    with r._cond:
        assert r._claim_and_start_locked(f"a:{cid}") == pid
    assert waitq.get_active(waitq.KIND_ANSWER, cid)["state"] == "starting"
    assert waitq.get_active(waitq.KIND_MSG, "m1")["state"] == "starting"   # 本会话行原样


def test_own_hold_absent_true_heir_rolls_back():
    """对照守卫：a: 面对真他主**前缀行**（无本卡/本会话折抵面）时收口回滚
    （行放回 waiting、不登记任何第二表征）。"""
    r = _bare_runner()
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "真他主卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid, meta={"sid": "s-1"})
    ti = waitq.enqueue(waitq.KIND_TASK, 999, pid)       # 真他主前缀行（无折抵）
    waitq.claim(ti, "worker")
    with r._cond:
        assert r._claim_and_start_locked(f"a:{cid}") is None
    assert waitq.get_active(waitq.KIND_ANSWER, cid)["state"] == "waiting"


def test_claim_start_rollback_when_prefix_row_taken():
    """F2+R4（行口径）：claim 成功后行前缀已被占满（他主前缀行在先）→ 行
    放回 waiting（无第二表征需要回滚）。"""
    r = _bare_runner()
    pid = _mk_project()
    mid = "mtest1"
    waitq.enqueue(waitq.KIND_MSG, mid, pid, not_before=9e12)
    ci = waitq.enqueue(waitq.KIND_CARD, "other", pid)       # 他主前缀行先占
    waitq.claim(ci, "worker")
    with r._cond:                                           # 收口函数须持 _cond（内部 notify）
        got = r._claim_and_start_locked(f"m:{mid}")
    assert got is None
    assert waitq.get_active(waitq.KIND_MSG, mid)["state"] == "waiting"


def test_session_holds_reads_active_msg_row():
    """session_holds=「同 sid 的活跃 m: 行」（行口径，chat_msgs.sid 反查）：
    行在场/退场即判据翻转，无第二表征。"""
    r = _bare_runner()
    pid = _mk_project()
    waitq.msg_enqueue("m1", pid, "s-1", "hi")
    assert r.session_holds(pid, "s-1") is False              # waiting 行不算
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")
    assert r.session_holds(pid, "s-1") is True               # 运行中行=在占位
    assert r.session_holds(pid, "s-2") is False              # 别的会话不算
    assert r.session_holds(pid, "") is False                 # 无 sid 恒 False
    waitq.finish_by_target(waitq.KIND_MSG, "m1")
    assert r.session_holds(pid, "s-1") is False              # 行退场即空


def test_pick_locked_own_hold_no_relock_deadlock():
    """回归（2026-09-19）：_pick_locked 持 _cond 运行，a: 忙例外判定不得重入取锁。

    _worker 在 `with self._cond:` 内调 _pick_locked，而 __init__ 的 _cond 包的是
    普通 threading.Lock（非可重入）——busy 分支若经取锁的公共壳（如旧的
    card_holds/session_holds 外壳）即同线程二次取锁永久死锁。本例按生产锁语义
    （普通 Lock）复刻 _worker 的持锁调用形状：own-hold 场景（本会话消息单元
    行在场）必须照常拾出 a: 键，修复前此处永久挂起。"""
    r = _bare_runner()
    r._lock = threading.Lock()                   # 覆盖裸夹具默认 RLock：对齐生产锁语义
    r._cond = threading.Condition(r._lock)
    pid = _mk_project()
    cid = db.insert_board_card(pid, "锁形卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid, pid,
                  meta={"sid": "s-1", "qid": "q1", "answers": []})
    r.submit_answer(cid)
    # 占位者=本会话消息单元（行口径：m: 行 running + chat_msgs.sid=s-1）
    waitq.msg_enqueue("m1", pid, "s-1", "hi")
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")
    with r._cond:                                # 与 _worker 相同：持锁调 _pick_locked
        assert r._pick_locked() == f"a:{cid}"    # 修复前此处永久挂起


def test_pick_locked_msg_reads_wait_row():
    """m: 拾取读表（P3 权威；P4 行即队列）：waiting 可拾 / starting 留队（注入窗口）
    / 行消失不拾。"""
    r = _bare_runner()
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    assert r._pick_locked() == "m:m1"                # waiting 行可拾
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")
    assert r._pick_locked() is None                  # starting 留队（注入窗口同）
    waitq.cancel(waitq.KIND_MSG, "m1", "测试")
    assert r._pick_locked() is None                  # 行消失（终态）不在扫描集


def test_recover_preserves_waiting_msgs_and_fails_claimed():
    """P3 行为变更：waiting msg 行存活（P4 行即队列无键可建；P6 起
    `_msgs`/`_msg_sid` 镜像退场——读侧全查表，recover 无回填段）；starting
    记 error 不重投（msg 重发非幂等，R3）；任务行同样存活（P4 变更①）。"""
    r = _bare_runner()
    waitq.msg_enqueue("m1", 9, "s-1", "排队存活")
    waitq.msg_enqueue("m2", 9, "s-1", "执行中断")
    waitq.msg_claim("m2")
    waitq.claim_by_target(waitq.KIND_MSG, "m2", "worker")
    with db.connect() as conn:    # m1 not_before 钉远期：套件遗留野 worker 拾取免疫
        conn.execute("UPDATE wait_items SET not_before=?"
                     " WHERE kind='msg' AND target_id='m1'", (time.time() + 3600,))
    tid = _mk_task(9)
    r.submit(tid)
    r.recover()
    assert waitq.msg_get("m1")["state"] == "queued"      # 存活
    assert waitq.get_active(waitq.KIND_MSG, "m1")["state"] == "waiting"   # 行即队列
    row = waitq.msg_get("m2")
    assert row["state"] == "error" and "服务重启中断" in row["error"]
    assert waitq.get_active(waitq.KIND_MSG, "m2") is None   # 等待项 failed


def test_recover_preserves_waiting_task_and_card_rows(monkeypatch):
    """P4 行为变更①②：waiting t:/c: 行重启存活（任务续跑）；starting t: 行
    cancelled（t: 任务行照旧 interrupted）；queued 任务不再被打断。
    必带②：任务仍 queued 的 starting t: 行放回 waiting（claim↔置 running 崩溃
    滞留微窗口收口）。
    v2a T1：starting c: 行改交 board.recover 按实况收口（本例 c: 行为 waiting，
    不受改动面影响）。"""
    r = _bare_runner()
    pid = _mk_project()
    tid_q = _mk_task(pid)                       # queued：存活续跑
    tid_r = _mk_task(pid)
    db.update_task(tid_r, status="running")     # running：interrupted（现状口径）
    cid = db.insert_board_card(pid, "排队卡")
    tid_stuck = _mk_task(pid)                   # 必带②：claim 后、置 running 前崩溃
    # not_before 钉远期：套件里前序用例遗留的真实 Runner worker 线程仍在轮询
    # 共享库，会拾取 waiting 行并处理成 done——拾取判定对未到期行跳过，本例
    # 只验「recover 不清行」，钉远期即对野 worker 免疫（recover 不触碰该字段；
    # tid_r/tid_stuck 面内要 claim，claim 不查该字段故同样免疫）
    waitq.enqueue(waitq.KIND_TASK, tid_q, pid, not_before=time.time() + 3600)
    waitq.enqueue(waitq.KIND_CARD, cid, pid, not_before=time.time() + 3600)
    waitq.enqueue(waitq.KIND_TASK, tid_r, pid, not_before=time.time() + 3600)
    waitq.claim_by_target(waitq.KIND_TASK, tid_r, "worker")
    waitq.enqueue(waitq.KIND_TASK, tid_stuck, pid, not_before=time.time() + 3600)
    waitq.claim_by_target(waitq.KIND_TASK, tid_stuck, "worker")   # 行 starting、任务仍 queued
    # 必带②放回后 not_before 归零 = 立即可拾；套件遗留野 worker 可在断言前抢拾
    # （实测偶发）。recover 期间挂起 claim（本例不再依赖 claim：收口走
    # return_to_waiting/cancel）——放回的行在断言前不可被任何 worker 拾取。
    monkeypatch.setattr(waitq, "claim", lambda item_id, claimer="": False)
    r.recover()
    assert waitq.get_active(waitq.KIND_TASK, tid_q)["state"] == "waiting"   # 存活
    assert waitq.get_active(waitq.KIND_CARD, cid)["state"] == "waiting"
    assert db.get_task(tid_q)["status"] == "queued"      # 排队任务续跑（变更①）
    assert db.get_task(tid_r)["status"] == "interrupted" # 执行中断（不变⑤）
    assert waitq.get_active(waitq.KIND_TASK, tid_r) is None   # starting → cancelled
    row = waitq.get_active(waitq.KIND_TASK, tid_stuck)
    assert row is not None and row["state"] == "waiting"      # 必带②：放回续跑


def test_stop_running_task_leaves_claimed_row_for_round_boundary(monkeypatch):
    """stop 分流（评审修正 F1）：运行中任务的行整程 starting——stop 不得同步取消
    行、不得立即标 stopped、不得提前跳后段；走运行分支（_stop_requested + 杀
    进程），轮边界收口（等待项终态证据保持 done/failed 而非 cancelled，必带①）。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)
    # not_before 钉远期：claim 不查该字段（面内 claim 照常），但对套件遗留野
    # worker 免疫——防止行被抢拾执行成 done（本例断言行整程 starting）
    waitq.enqueue(waitq.KIND_TASK, tid, pid, not_before=time.time() + 3600)
    waitq.claim_by_target(waitq.KIND_TASK, tid, "worker")   # 拾取后整程 starting
    fake_proc = type("P", (), {"pid": 4242})()
    r._procs[tid] = fake_proc
    killed, skipped = [], []
    monkeypatch.setattr(runner.platcompat, "kill_tree",
                        lambda pid, sig: killed.append(pid))
    monkeypatch.setattr(r, "_skip_pipeline_children",
                        lambda tid, reason: skipped.append(tid))
    r.stop(tid)
    row = waitq.get_active(waitq.KIND_TASK, tid)
    assert row is not None and row["state"] == "starting"   # 行未被同步取消
    assert db.get_task(tid)["status"] == "queued"           # 未立即标 stopped
    assert skipped == []                                    # 未提前跳后段
    assert tid in r._stop_requested                         # 运行分支标记
    assert killed == [4242]                                 # 进程被杀


def test_stop_queued_task_cancels_row_and_marks_stopped(monkeypatch):
    """stop 分流回归：排队中任务（waiting 行）→ 行 cancelled + 立即 stopped +
    跳后段（现行为保持）。"""
    r = _bare_runner()
    pid = _mk_project()
    tid = _mk_task(pid)
    # not_before 钉远期：防套件遗留野 worker 抢拾（本例断言 stop 取消该行）
    waitq.enqueue(waitq.KIND_TASK, tid, pid, not_before=time.time() + 3600)
    skipped = []
    monkeypatch.setattr(r, "_skip_pipeline_children",
                        lambda tid, reason: skipped.append(tid))
    r.stop(tid)
    assert waitq.get_active(waitq.KIND_TASK, tid) is None   # 行取消（R9 仲裁）
    assert db.get_task(tid)["status"] == "stopped"          # 立即终态
    assert skipped == [tid]                                 # 后段同步跳过


def test_pick_locked_dirty_answer_target_cancelled():
    """a: 脏行（target 非数字）在自身占用例外解析处就地摘除，不炸 worker
    （评审 M3：对齐 recover 的防御姿态）。"""
    r = _bare_runner()
    ti = waitq.enqueue(waitq.KIND_TASK, 1, 9)      # 项目 9 忙（前缀行）→ 触发自身占用例外分支
    waitq.claim(ti, "worker")
    waitq.enqueue(waitq.KIND_ANSWER, "dirty", 9)   # 非数字 target（理论脏行）
    assert r._pick_locked() is None                          # 跳过且不抛
    assert waitq.get_active(waitq.KIND_ANSWER, "dirty") is None   # 行已摘除
