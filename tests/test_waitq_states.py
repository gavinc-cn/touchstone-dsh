"""wait_items 七枚举状态机单测（v2a T1，裁决 R3）：
waiting→starting→running→finishing→done/failed/cancelled；claimed 被 starting
吸收（存量行经 db.migrate 归一）；recover 按 §4.T1 映射表收口新状态。"""
import sqlite3
import threading
import time
import uuid

import pytest

import board
import db
import runner
import waitq


@pytest.fixture(autouse=True)
def _clean_state():
    """每例前后清空 waitq 两表 + 看板卡 + _RUNS：board.recover 按全表驱动，
    其他文件遗留的 doing 卡会被本套件的真实 recover 流转/补建，须清场隔离。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs", "board_cards"):
                conn.execute(f"DELETE FROM {t}")
        with board._runs_lock:
            board._RUNS.clear()
    _clean()
    yield
    _clean()


def _bare_runner():
    """裸 Runner（不起 worker 线程）：与 tests/test_waitq_shadow.py 同款做法——
    真实 Runner() 的 worker 线程会与用例抢夺队列行，断言随之漂移。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    r._procs = {}
    r._stop_requested = set()
    r._busy_probe = None
    return r


def _mk_project(agent_path="/bin/true", **over):
    """建一个隔离项目行（路径唯一，避免项目表约束冲突）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"ws-{uid}", f"/tmp/ws-{uid}", agent_path,
                             f"/tmp/ws-{uid}/work", **over)


def _mk_task(project_id, **over):
    """建一个任务行（表默认 status=queued；裸 Runner 下不会被拾取执行）。"""
    return db.insert_task(project_id, f"t-{uuid.uuid4().hex[:6]}", 0, "不复测",
                          "rounds", 1, **over)


def _wait_row(kind, target):
    """按 (kind,target) 取最新等待项行（含终态；无则 None）。"""
    with db.connect() as conn:
        return conn.execute(
            "SELECT * FROM wait_items WHERE kind=? AND target_id=?"
            " ORDER BY id DESC LIMIT 1", (kind, str(target))).fetchone()


def _set_wait_state(kind, target, state):
    """直改等待项行状态（白盒播种：造 running/finishing 等生产路径暂不可达的
    中间态——v2a T1 只落枚举与 recover 映射，起跑路径接线在后续任务）。"""
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET state=? WHERE kind=? AND target_id=?",
                     (state, kind, str(target)))


def test_claim_moves_waiting_to_starting():
    """claim 后行 state=starting（非 claimed；裁决 R3 目标态改名），rowcount
    互斥不变：已被抢的行再 claim 返回 False。"""
    i = waitq.enqueue(waitq.KIND_TASK, 2101, 1)
    assert waitq.claim(i, "worker-1") is True
    row = waitq.get_item(i)
    assert row["state"] == "starting"
    assert row["claimed_at"] is not None and row["claimed_by"] == "worker-1"
    assert waitq.claim(i, "worker-2") is False           # 互斥：非 waiting 不可拾
    assert waitq.get_item(i)["state"] == "starting"


def test_mark_running_and_finishing():
    """starting→running→finishing 迁移链；非法迁移（waiting→running 等）False。"""
    i = waitq.enqueue(waitq.KIND_CARD, 2102, 1)
    assert waitq.mark_running(waitq.KIND_CARD, 2102) is False    # waiting→running 非法
    assert waitq.mark_finishing(waitq.KIND_CARD, 2102) is False  # waiting→finishing 非法
    assert waitq.claim(i, "worker") is True                      # → starting
    assert waitq.mark_running(waitq.KIND_CARD, 2102) is True     # starting→running
    assert waitq.get_item(i)["state"] == "running"
    assert waitq.mark_running(waitq.KIND_CARD, 2102) is False    # 幂等守卫（非 starting）
    assert waitq.mark_finishing(waitq.KIND_CARD, 2102) is True   # running→finishing
    assert waitq.get_item(i)["state"] == "finishing"
    assert waitq.mark_done(i) is True                    # finishing 属活跃态可落终态
    assert waitq.mark_running(waitq.KIND_CARD, 2102) is False    # 终态后一切迁移拒绝
    assert waitq.mark_finishing(waitq.KIND_CARD, 2102) is False
    # starting→finishing 直达合法（收尾点入口不要求必经 running）
    waitq.enqueue(waitq.KIND_MSG, "m-fin", 1)
    waitq.claim_by_target(waitq.KIND_MSG, "m-fin", "worker")
    assert waitq.mark_finishing(waitq.KIND_MSG, "m-fin") is True
    assert _wait_row(waitq.KIND_MSG, "m-fin")["state"] == "finishing"


def test_enter_running_superset_of_mark_running():
    """v3a enter_running（行即条目）：mark_running 的超集——活跃行 waiting/
    starting/finishing → running（起跑证实升格）；已是 running 幂等 True；
    终态行（done/failed/cancelled）→ 复用同一行（同 id、同 seq）重开 running；
    无行 → 建行直置 running，位次=运行前缀尾/等待区最前（_after_prefix_seq
    几何，与 insert_after_prefix 同源）。任何路径都不得破坏活跃唯一索引。"""
    pid = 1
    with db.connect() as conn:                      # 前缀行（seq=1.0）
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at) VALUES (?,'card','9001','running',1.0,?)",
            (pid, db.now_str()))
    waitq.enqueue(waitq.KIND_CARD, 9002, pid, not_before=9e12)   # 等待行（seq=2.0）
    # ① 无行 → 建行直置 running（送达恢复 / 阻塞解除归位 / recover 重建形态）
    assert waitq.enter_running(waitq.KIND_CARD, 2104, pid) is True
    row = _wait_row(waitq.KIND_CARD, 2104)
    assert row["state"] == "running"
    assert 1.0 < row["seq"] < _wait_row(waitq.KIND_CARD, 9002)["seq"]   # 前缀尾
    assert waitq.enter_running(waitq.KIND_CARD, 2104, pid) is True      # 幂等（已 running）
    assert _wait_row(waitq.KIND_CARD, 2104)["id"] == row["id"]          # 不新插行
    # ② waiting → running（同 id 升格，不重排队）
    wid = waitq.enqueue(waitq.KIND_CARD, 2105, pid)
    assert waitq.enter_running(waitq.KIND_CARD, 2105, pid) is True
    assert _wait_row(waitq.KIND_CARD, 2105)["id"] == wid
    assert waitq.get_item(wid)["state"] == "running"
    # ③ starting / finishing → running（活跃行统一收拢到 running）
    for tgt in (2106, 2107):
        wi = waitq.enqueue(waitq.KIND_CARD, tgt, pid)
        assert waitq.claim(wi, "worker") is True                  # → starting
        if tgt == 2107:
            waitq.mark_finishing(waitq.KIND_CARD, tgt)            # → finishing
        assert waitq.enter_running(waitq.KIND_CARD, tgt, pid) is True
        assert waitq.get_item(wi)["state"] == "running"
    # ④ 终态行 → 复用同一行（同 id、同 seq）重开 running
    sid = waitq.enqueue(waitq.KIND_CARD, 2108, pid)
    waitq.claim(sid, "worker")
    waitq.mark_failed(sid, "起会话失败")                           # → failed 终态
    seq_old = waitq.get_item(sid)["seq"]
    assert waitq.enter_running(waitq.KIND_CARD, 2108, pid) is True
    row8 = _wait_row(waitq.KIND_CARD, 2108)
    assert (row8["id"], row8["seq"], row8["state"]) == (sid, seq_old, "running")
    with db.connect() as conn:                  # 活跃唯一索引未被撞破：同键活跃行恒唯一
        n = conn.execute(
            "SELECT COUNT(*) n FROM wait_items WHERE kind='card' AND target_id='2108'"
            " AND state IN ('waiting','starting','running','finishing')").fetchone()["n"]
    assert n == 1


def test_legacy_claimed_migrates_to_starting():
    """存量 claimed 行经 db.migrate 归一 starting；活跃唯一索引同步重建扩口径
    （旧形态 WHERE 只含 waiting/claimed）；迁移重复执行幂等零改写。"""
    with db.connect() as conn:
        # 造旧形态：旧口径唯一索引 + 一条 claimed 存量行
        conn.execute("DROP INDEX IF EXISTS idx_wait_active")
        conn.execute("CREATE UNIQUE INDEX idx_wait_active ON wait_items(kind, target_id)"
                     " WHERE state IN ('waiting','claimed')")
        conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                     " created_at) VALUES (1,'card','2103','claimed',1,"
                     " '2026-01-01 00:00:00')")
    db.migrate()
    row = _wait_row(waitq.KIND_CARD, 2103)
    assert row["state"] == "starting"                    # claimed → starting 归一
    with db.connect() as conn:
        sql = conn.execute("SELECT sql FROM sqlite_master"
                           " WHERE name='idx_wait_active'").fetchone()["sql"]
    assert "'starting'" in sql and "'claimed'" not in sql   # 索引口径已重建
    # 重建后索引覆盖新活跃态：starting 行在场拒第二活跃行（waiting 亦撞）
    with db.connect() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state,"
                         " seq, created_at) VALUES (1,'card','2103','waiting',2,"
                         " '2026-01-01 00:00:00')")
    db.migrate()                                         # 再跑一次：幂等不丢行不改写
    assert _wait_row(waitq.KIND_CARD, 2103)["state"] == "starting"
    with db.connect() as conn:
        sql2 = conn.execute("SELECT sql FROM sqlite_master"
                            " WHERE name='idx_wait_active'").fetchone()["sql"]
    assert sql2 == sql


def test_active_unique_index_spans_new_states():
    """活跃唯一索引覆盖四活跃态：同 (kind,target) 在 starting/running/finishing
    下均拒第二活跃行；enqueue 撞活跃行幂等复用既有 id；终态后可再插。"""
    for st in ("starting", "running", "finishing"):
        tgt = f"idx-{st}"
        wid = waitq.enqueue(waitq.KIND_CARD, tgt, 1)
        _set_wait_state(waitq.KIND_CARD, tgt, st)
        with db.connect() as conn:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO wait_items (project_id, kind, target_id,"
                             " state, seq, created_at) VALUES (1,'card',?,'waiting',9,"
                             " '2026-01-01 00:00:00')", (tgt,))
        assert waitq.enqueue(waitq.KIND_CARD, tgt, 1) == wid   # 幂等复用（不插新行）
        waitq.mark_done(wid)
        assert waitq.enqueue(waitq.KIND_CARD, tgt, 1) != wid   # 终态后可再插（新行）


def test_recover_matrix_new_states(monkeypatch):
    """recover 新映射矩阵（v2a §4.T1）：

    waiting 全类存活（对照）；starting/running/finishing 按类收口——
    t: 任务仍 queued→放回 waiting，否则 cancel（任务行 running 照旧 interrupted）；
    m: 等待项 failed + 消息行 error=服务重启中断（不重投）；a: 放回 waiting 重投；
    c: 交 board.recover 按实况——占位卡起跑窗口滞留 cancelled 并对账补建重新入队、
    无实况 running/finishing→failed+卡落 review、实况 busy→mark_running+重建占用。
    """
    r = _bare_runner()
    pid = _mk_project()                                  # 默认族项目（dsh_plugin）
    pid_web = _mk_project(agent_path="dsh-plugin:/bin/true")
    # —— t: 四形态 ——
    tid_q = _mk_task(pid)                                # 任务仍 queued + 行 starting
    waitq.enqueue(waitq.KIND_TASK, tid_q, pid)
    waitq.claim_by_target(waitq.KIND_TASK, tid_q, "worker")
    tid_r = _mk_task(pid)                                # running 任务 + 行 starting
    db.update_task(tid_r, status="running")
    waitq.enqueue(waitq.KIND_TASK, tid_r, pid)
    waitq.claim_by_target(waitq.KIND_TASK, tid_r, "worker")
    tid_run = _mk_task(pid)                              # running 任务 + 行 running
    db.update_task(tid_run, status="running")
    waitq.enqueue(waitq.KIND_TASK, tid_run, pid)
    _set_wait_state(waitq.KIND_TASK, tid_run, "running")
    tid_fin = _mk_task(pid)                              # running 任务 + 行 finishing
    db.update_task(tid_fin, status="running")
    waitq.enqueue(waitq.KIND_TASK, tid_fin, pid)
    _set_wait_state(waitq.KIND_TASK, tid_fin, "finishing")
    # —— m: starting / running ——
    waitq.msg_enqueue("ms", pid, "s-1", "起跑窗口中断")   # 消息 queued + 行 starting
    waitq.claim_by_target(waitq.KIND_MSG, "ms", "worker")
    waitq.msg_enqueue("mr", pid, "s-1", "运行中断")       # 消息 running + 行 running
    waitq.msg_claim("mr")
    _set_wait_state(waitq.KIND_MSG, "mr", "running")
    # —— a: starting / finishing ——
    cid_a1 = db.insert_board_card(pid, "作答卡1")
    waitq.enqueue(waitq.KIND_ANSWER, cid_a1, pid, meta={"sid": "s-1"})
    waitq.claim_by_target(waitq.KIND_ANSWER, cid_a1, "worker")
    cid_a2 = db.insert_board_card(pid, "作答卡2")
    waitq.enqueue(waitq.KIND_ANSWER, cid_a2, pid, meta={"sid": "s-1"})
    _set_wait_state(waitq.KIND_ANSWER, cid_a2, "finishing")
    # —— c: 四形态 ——
    c_ph = db.insert_board_card(pid, "占位卡")
    waitq.enqueue_card(c_ph, pid)                        # doing+queue 占位 + waiting 行
    waitq.claim_by_target(waitq.KIND_CARD, c_ph, "worker")   # 起跑窗口崩溃 → starting
    c_ph_old_row = _wait_row(waitq.KIND_CARD, c_ph)["id"]
    c_busy = db.insert_board_card(pid_web, "busy 卡")    # web 卡起跑窗口滞留 + 实况 busy
    db.update_board_card(c_busy, column_key="doing", session_id="s-busy")
    waitq.enqueue(waitq.KIND_CARD, c_busy, pid_web)
    waitq.claim_by_target(waitq.KIND_CARD, c_busy, "worker")
    c_idle = db.insert_board_card(pid_web, "idle 卡")    # web 卡 + 实况空闲
    db.update_board_card(c_idle, column_key="doing", session_id="s-idle")
    waitq.enqueue(waitq.KIND_CARD, c_idle, pid_web)
    waitq.claim_by_target(waitq.KIND_CARD, c_idle, "worker")
    c_cli = db.insert_board_card(pid, "CLI 卡")          # CLI 卡 + 行 running（无实况）
    db.update_board_card(c_cli, column_key="doing")
    waitq.enqueue(waitq.KIND_CARD, c_cli, pid)
    _set_wait_state(waitq.KIND_CARD, c_cli, "running")
    c_cli2 = db.insert_board_card(pid, "CLI 卡2")        # CLI 卡 + 行 finishing（无实况）
    db.update_board_card(c_cli2, column_key="doing")
    waitq.enqueue(waitq.KIND_CARD, c_cli2, pid)
    _set_wait_state(waitq.KIND_CARD, c_cli2, "finishing")
    # waiting 对照行（全类存活）
    tid_w = _mk_task(pid)
    waitq.enqueue(waitq.KIND_TASK, tid_w, pid)
    waitq.msg_enqueue("mw", pid, "s-1", "排队存活")
    cid_w = db.insert_board_card(pid, "存活作答卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid_w, pid, meta={"sid": "s-1"})
    # not_before 钉远期：套件遗留野 worker 拾取免疫（claim/收口不查该字段）
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET not_before=?", (time.time() + 3600,))
    # web 族实况探测打桩：仅 s-busy 在跑（驱动侧无本地子进程，无需 ensure 桩）
    monkeypatch.setattr(board, "_web_busy",
                        lambda family, pdir, sid: sid == "s-busy")
    # 就绪闸（2026-10-08 批次 C）：本用例模拟「中枢在线且快照可信」的恢复场景，
    # 故一并声明 aligned——不可信时 _recover_web_card 一律不搬列（未知 ≠ 空闲）。
    monkeypatch.setattr(board.dshevents, "aligned", lambda: True)
    mark_calls = []
    real_mark_running = waitq.mark_running
    monkeypatch.setattr(waitq, "mark_running",
                        lambda k, t: mark_calls.append((k, str(t)))
                        or real_mark_running(k, t))
    monkeypatch.setattr(runner, "INSTANCE", r)           # board.recover 重建段入口
    # 野 worker 免疫（口径同 test_waitq_shadow「放回的行断言前不可被拾取」）：
    # 本套件前面文件起的真实 Runner worker 线程共享同库轮询，recover 把行放回
    # waiting 时 not_before 归零 = 立即可拾，claim 挂起后放回的行在断言前恒定
    # （实测偶发：tid_q 被抢成 starting；recover/board.recover 自身不调 claim）
    monkeypatch.setattr(waitq, "claim", lambda item_id, claimer="": False)

    r.recover()                                          # 生产序：runner → board
    board.recover()

    # —— t: ——
    assert _wait_row(waitq.KIND_TASK, tid_q)["state"] == "waiting"     # 放回续跑
    assert _wait_row(waitq.KIND_TASK, tid_r)["state"] == "cancelled"
    assert _wait_row(waitq.KIND_TASK, tid_run)["state"] == "cancelled"  # running 同型
    assert _wait_row(waitq.KIND_TASK, tid_fin)["state"] == "cancelled"  # finishing 同 running
    assert db.get_task(tid_r)["status"] == "interrupted"               # 现状口径打断
    assert db.get_task(tid_run)["status"] == "interrupted"
    assert db.get_task(tid_fin)["status"] == "interrupted"
    assert db.get_task(tid_q)["status"] == "queued"
    # —— m: error 不重投 ——
    assert _wait_row(waitq.KIND_MSG, "ms")["state"] == "failed"
    assert _wait_row(waitq.KIND_MSG, "mr")["state"] == "failed"
    assert waitq.msg_get("ms")["state"] == "error"
    assert "服务重启中断" in waitq.msg_get("ms")["error"]
    assert waitq.msg_get("mr")["state"] == "error"
    # —— a: 放回 waiting 重投 ——
    assert _wait_row(waitq.KIND_ANSWER, cid_a1)["state"] == "waiting"
    assert _wait_row(waitq.KIND_ANSWER, cid_a2)["state"] == "waiting"   # finishing 同 running
    # —— c: ——
    row = _wait_row(waitq.KIND_CARD, c_ph)
    assert row["state"] == "waiting" and row["id"] != c_ph_old_row     # 对账补建重新入队
    with db.connect() as conn:                                         # 旧行 cancelled
        old = conn.execute("SELECT state FROM wait_items WHERE id=?",
                           (c_ph_old_row,)).fetchone()
    assert old["state"] == "cancelled"
    card = db.get_board_card(c_ph)                                     # 卡归位=留在占位
    assert (card["column_key"], card["block_kind"]) == ("doing", "queue")
    assert mark_calls == [(waitq.KIND_CARD, str(c_busy))]              # busy→mark_running
    # v3a：重建段 card_started 经 enter_running 保持/补回 running（行即条目，
    # 不再落 done——跨轮存活的运行成员由行承载；占位=行在场，无第二表征）
    assert _wait_row(waitq.KIND_CARD, c_busy)["state"] == "running"
    with board._runs_lock:
        assert c_busy in board._RUNS                                   # watch 条目重建
    assert db.get_board_card(c_busy)["column_key"] == "doing"          # 不归位 review
    assert _wait_row(waitq.KIND_CARD, c_idle)["state"] == "cancelled"  # 无实况 starting
    assert db.get_board_card(c_idle)["column_key"] == "review"         # 卡归位
    assert _wait_row(waitq.KIND_CARD, c_cli)["state"] == "failed"      # 无实况 running
    assert db.get_board_card(c_cli)["column_key"] == "review"
    assert _wait_row(waitq.KIND_CARD, c_cli2)["state"] == "failed"     # finishing 同 running
    assert db.get_board_card(c_cli2)["column_key"] == "review"
    # —— waiting 对照：全类存活不动 ——
    assert _wait_row(waitq.KIND_TASK, tid_w)["state"] == "waiting"
    assert _wait_row(waitq.KIND_MSG, "mw")["state"] == "waiting"
    assert _wait_row(waitq.KIND_ANSWER, cid_w)["state"] == "waiting"
