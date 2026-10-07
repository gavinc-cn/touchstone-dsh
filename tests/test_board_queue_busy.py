# 占位感知排队（2026-09-06 修订，2026-09-07 补外部占位；v2b T2 起
# parallel 直起废除一律入队）：占位中排队；外部直跑会话（web 族）经 ext 行成为
# 统一队列占位源（外部不受影响照常立即起，平台单元排队等它结束，拾起判据=补位器
# 前缀成员（ext 行即成员，v3d 起探针退役）；v2d T4 前的 `_SYNC_BUSY` 内存集合已退场）；
# v3b 起「容器迁移
# = 出队」——卡离开正在开发容器即行收口（落阻塞无条件出队，停会话与否只看路径），
# 不再有独立让行动作与 origin/has_run 判据；payload 活动任务；占位读口
# （unit_busy/_card_unit_active/同 sid m: 行）与出队点四场景全部对拍行口径
import os, sys, threading, uuid
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board, db, runner, waitq


def _card(**kw):
    base = {"id": 1, "project_id": 9, "title": "t", "description": "",
            "column_key": "doing", "sort_order": 1, "session_id": "",
            "sessions": "[]", "block_kind": None,
            "block_text": "", "parent_card_id": None,
            "origin": "", "done_at": None, "trashed": 0, "trashed_at": None,
            "scheduled_at": None,
            "jira_key": "", "last_error": "", "last_error_at": None,
            "created_at": 0, "updated_at": 0}
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _clean_tables():
    """每例前后清等待项/消息表（conftest 临时库；行口径用例种子行落真表）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _mk_project():
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"wc-{uid}", f"/tmp/wc-{uid}", "/bin/true",
                             f"/tmp/wc-{uid}/work")


def _row_instance():
    """真实行方法的裸单例（无 worker 线程）：card_started/card_finished 直操
    等待项行——出队场景回归的占位判定的真源。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    r._procs = {}
    r._stop_requested = set()
    return r


def _fake_runner():
    """构造带调用记录的假 runner 单例（记录 submit/remove/start/fin 调用）。"""
    calls = {"sub": [], "rm": [], "start": [], "fin": [], "notify": 0}

    class R:
        def submit_card(self, cid, **kw):
            calls["sub"].append(cid)
        def remove_card(self, cid):
            calls["rm"].append(cid)
        def card_started(self, cid, pid, ext=None):
            calls["start"].append(cid)
        def card_finished(self, cid, reason=""):
            calls["fin"].append(cid)
        def notify_busy_change(self):
            calls["notify"] += 1
    return R(), calls


def test_runner_unit_busy_counts_prefix_rows():
    """unit_busy：任一**前缀行**即忙（串行窗口——行即成员，唯一来源；
    v3d 起无第二来源与探针）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition(threading.Lock())
    assert r.unit_busy(9) is False
    i = waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.claim(i, "worker")                            # 他项目也种一行对照
    j = waitq.enqueue(waitq.KIND_CARD, 5, 8)
    waitq.claim(j, "worker")
    assert r.unit_busy(9) is True                       # 前缀行在场
    assert r.unit_busy(8) is True
    waitq.cancel(waitq.KIND_TASK, 1, "测试收尾")
    assert r.unit_busy(9) is False                      # 行退场即空闲（他项目不受影响）
    assert r.unit_busy(8) is True


def test_enter_doing_parallel_busy_queues(monkeypatch):
    """parallel 模式 + 项目占用中（统一队列在跑单元）：仍排队而非直起——P4 起
    占位/入队归 waitq.enqueue_card 单事务，board 侧不再经 update_board_card 落占位。"""
    fake, calls = _fake_runner()
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.setdefault("upd", []).append(kw))
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "parallel"})
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    monkeypatch.setattr(board, "start_card",
                        lambda proj, card, extra="": calls.setdefault("sc", []).append(card["id"]))
    card, err = board._enter_doing({"id": 9, "agent_path": ""}, _card(id=5, column_key="todo"))
    assert err is None
    assert "upd" not in calls                          # board 未写卡片字段（占位归 enqueue_card 事务，R6 单写）
    assert calls["sub"] == [5] and "sc" not in calls   # 排队而非起会话


def test_parallel_review_card_queues(monkeypatch):
    """parallel 直起废除（v2b T2，裁决 R9/R5）：parallel 项目空闲也一律入队
    走补位窗口（N=5），不再直起——505-507 直起分支与 559-568「I2 修复」
    免租约直起段删除（断言翻转自原 test_enter_doing_parallel_idle_direct_start：
    直起→入队）。parallel 模式 review 续跑卡同样只入队不起会话。"""
    fake, calls = _fake_runner()
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.setdefault("upd", []).append(kw))
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "parallel"})
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    monkeypatch.setattr(board, "start_card",
                        lambda proj, card, extra="": calls.setdefault("sc", []).append(card["id"]))
    card, err = board._enter_doing({"id": 9, "agent_path": ""},
                                   _card(id=5, column_key="review"))
    assert err is None
    assert calls["sub"] == [5] and "sc" not in calls   # 入队不直起
    assert calls["start"] == []                        # 无起跑登记（直起段已删）


def test_enter_doing_parallel_ext_busy_queues(monkeypatch):
    """parallel 模式 + 外部条目占用（ext 行在场）：同样排队——可控的平台单元让
    不可控的外部会话先行（2026-09-07 语义修订；v2d T4 探针体由 _SYNC_BUSY
    集合改读「项目活跃 ext 行在场」，排队语义不变）。"""
    fake, calls = _fake_runner()
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.setdefault("upd", []).append(kw))
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "parallel"})
    # 项目 9 有活跃 ext 行（外部会话在跑）：入队前刷新把它算进拾起判据
    monkeypatch.setattr(board, "_ext_refresh", lambda proj: True)
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    monkeypatch.setattr(board, "start_card",
                        lambda proj, card, extra="": calls.setdefault("sc", []).append(card["id"]))
    card, err = board._enter_doing({"id": 9, "agent_path": ""},
                                   _card(id=5, column_key="review"))
    assert err is None
    assert calls["sub"] == [5] and "sc" not in calls   # 排队等外部会话结束


def test_leave_doing_stop_false_dequeues_only(monkeypatch):
    """容器迁移原语 stop=False（交互挂起自动落阻塞）：只出队行收口——不停会话
    （abort 会清掉等待中的 pending 提问）、不提交任何改动（2026-09-13 起提交由
    外部 hook 扩展负责）。"""
    calls = {"stop": [], "rel": [], "cancel": []}
    monkeypatch.setattr(board, "stop_card", lambda cid: calls["stop"].append(cid))
    monkeypatch.setattr(board, "finish",
                        lambda key, reason="", **kw:
                        calls["rel"].append((key, reason)))
    monkeypatch.setattr(board.waitq, "cancel_card_wait",
                        lambda cid, reason="":
                        calls["cancel"].append((cid, reason)) or True)
    board._leave_doing(_card(id=5), stop=False, reason="出队-交互阻塞")
    assert calls["stop"] == []                              # 不停会话
    assert calls["cancel"] == [(5, "出队-交互阻塞")]          # 无活跃行：清占位投影（no-op）
    assert calls["rel"] == [("c:5", "出队-交互阻塞")]         # 行收口经唯一收尾点


def test_leave_doing_stop_true_stops_then_dequeues(monkeypatch):
    """容器迁移原语 stop=True（手动拖入阻塞 / 拖离开发列 / 删除）：先停会话再
    出队行收口（无提交检查；停会话内含取消排队消息 / 放弃待送达答案）。"""
    calls = {"stop": [], "rel": []}
    monkeypatch.setattr(board, "stop_card", lambda cid: calls["stop"].append(cid))
    monkeypatch.setattr(board, "finish",
                        lambda key, reason="", **kw:
                        calls["rel"].append((key, reason)))
    board._leave_doing(_card(id=5), reason="出队-拖入阻塞")
    assert calls["stop"] == [5] and calls["rel"] == [("c:5", "出队-拖入阻塞")]


def test_iw_apply_block_dequeues_unconditionally(monkeypatch):
    """调和器 block 动作（v3b）：落阻塞容器 ⇒ **无条件**出队行收口——不再看
    origin / _has_active_run（旧口径只对 sync 卡 ∨ 在管运行卡让行）。stop=False：
    挂起等待答复工不得 abort（abort 会清掉 pending 提问）。"""
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "block")
    monkeypatch.setattr(board.db, "get_board_card",
                        lambda cid: _card(id=cid, origin="sync" if cid == 5 else ""))
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **kw: None)
    monkeypatch.setattr(board.feishu, "card_blocked", lambda *a, **k: None)
    leaved = []
    monkeypatch.setattr(board, "_leave_doing",
                        lambda card, stop=True, reason="":
                        leaved.append((card["id"], stop, reason)))
    r = {"pending": True, "busy": True, "text": "q?"}
    board._iw_apply("dsh_plugin", _card(id=5, origin="sync"), "block", r)   # sync 卡
    board._iw_apply("dsh_plugin", _card(id=6, origin=""), "block", r)       # 平台自建卡
    assert leaved == [(5, False, "出队-交互阻塞"), (6, False, "出队-交互阻塞")]


def test_iw_apply_block_platform_running_dequeues_row(monkeypatch):
    """平台自建卡在管运行（running 行、无 _RUNS 条目）落阻塞：
    同样出队——行收口（I1：无活跃 c: 行），同项目队首立即可补位（卡 546 场景
    白盒底板，队首补位断言见 test_blocked_card_no_longer_holds_queue_head）。"""
    pid = _mk_project()
    cid = db.insert_board_card(pid, "在管卡")
    db.update_board_card(cid, column_key="doing")
    inst = _row_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    waitq.insert_card_force_start(cid, pid)
    waitq.mark_running(waitq.KIND_CARD, cid)
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "block")
    monkeypatch.setattr(board.feishu, "card_blocked", lambda *a, **k: None)
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)   # 无在管条目也照收
    board._iw_apply("dsh_plugin", db.get_board_card(cid), "block",
                    {"pending": True, "busy": True, "text": "q?"})
    assert waitq.get_active(waitq.KIND_CARD, cid) is None       # 行收口（I1）
    cur = db.get_board_card(cid)
    assert (cur["column_key"], cur["block_kind"]) == ("blocked", "interaction")


def test_blocked_card_no_longer_holds_queue_head(monkeypatch):
    """回归锚点（卡 546 场景，v3b）：一张卡在 running 行在场时落阻塞容器，随后
    同项目队首必须可被补位启动——`_pick_locked()` 返回队首键，且该卡已无活跃
    c: 行（I1：卡不在正在开发容器 ⇒ 无活跃 c: 行）。旧口径下运行行仍在场、
    项目运行位被占，排队单元干等（实障根因：阻塞列卡压住队首）。"""
    pid = _mk_project()
    cid = db.insert_board_card(pid, "卡546")
    db.update_board_card(cid, column_key="doing")
    head = db.insert_board_card(pid, "队首卡")
    waitq.enqueue_card(head, pid)                  # 队首等待单元（doing/queue 占位）
    inst = _row_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    waitq.insert_card_force_start(cid, pid)        # 起跑证实：行 running 跨轮存活
    waitq.mark_running(waitq.KIND_CARD, cid)
    assert inst._pick_locked() is None             # 出队前：前缀满，队首留队
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "block")
    monkeypatch.setattr(board.feishu, "card_blocked", lambda *a, **k: None)
    monkeypatch.setattr(board, "_has_active_run", lambda c: False)
    board._iw_apply("dsh_plugin", db.get_board_card(cid), "block",
                    {"pending": True, "busy": True, "text": "q?"})
    assert waitq.get_active(waitq.KIND_CARD, cid) is None   # I1：无活跃 c: 行
    assert inst._pick_locked() == f"c:{head}"               # 队首可补位（不压队首）


def test_card_unit_active_reads_row():
    """`board._card_unit_active`：本卡活跃非等待行在场（行即持有者，不另造判据）。"""
    waitq.enter_running(waitq.KIND_CARD, 5, 9)
    assert board._card_unit_active(5) is True
    assert board._card_unit_active(6) is False
    waitq.finish_by_target(waitq.KIND_CARD, 5)
    assert board._card_unit_active(5) is False


def test_runner_session_holds():
    """session_holds：运行前缀里是否有本会话自己的消息单元（作答豁免判据，
    2026-09-19 死锁修复；行口径——同 sid 的运行中 m: 行，sid 反查 chat_msgs）。

    本会话命中的运行中 m: 行为真；别的会话 / 无 sid / 他项目按同口径判定——
    否则作答会借道解锁本项目正在跑的无关单元。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition(threading.Lock())
    waitq.msg_enqueue("m7", 9, "s-1", "hi")              # 本会话消息单元
    waitq.claim_by_target(waitq.KIND_MSG, "m7", "worker")
    waitq.msg_enqueue("m8", 9, "s-2", "hi")              # 别的会话（同项目）
    waitq.claim_by_target(waitq.KIND_MSG, "m8", "worker")
    waitq.msg_enqueue("m9", 8, "s-1", "hi")              # 同 sid 他项目
    waitq.claim_by_target(waitq.KIND_MSG, "m9", "worker")
    assert r.session_holds(9, "s-1") is True
    assert r.session_holds(9, "s-2") is True             # 同项目别会话各自命中
    assert r.session_holds(8, "s-1") is True             # 他项目按本项目口径判定
    assert r.session_holds(9, "s-9") is False            # 无此会话
    assert r.session_holds(9, "") is False               # 无 sid
    # 单元结束（行退场）：不再算本会话占位
    waitq.finish_by_target(waitq.KIND_MSG, "m7")
    assert r.session_holds(9, "s-1") is False


def test_board_payload_active_tasks(monkeypatch):
    """payload 任务条目（v2c T4，裁决 R16 翻转）：doing=queued/running（运行中
    在前、排队按创建序，现状不回归）；终态按列映射上映（done→done 列）——
    原「终态任务从看板消失」口径废止。"""
    monkeypatch.setattr(board.db, "get_project", lambda pid: {"id": pid})
    monkeypatch.setattr(board, "web_busy_map",
                        lambda proj, running_map=None: {})
    monkeypatch.setattr(board.db, "list_board_cards", lambda pid: [])
    monkeypatch.setattr(board.db, "list_board_comments", lambda pid: [])
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "serial"})
    rows = [{"id": 3, "project_id": 9, "name": "旧排队", "task_type": "stress",
             "status": "queued", "current_round": 0, "session_id": "", "error": "",
             "created_at": "2026-09-06 01:00:00", "started_at": None,
             "ended_at": None},
            {"id": 2, "project_id": 9, "name": "在跑", "task_type": "normal",
             "status": "running", "current_round": 1, "session_id": "s9", "error": "",
             "created_at": "2026-09-06 00:00:00", "started_at": "2026-09-06 00:01:00",
             "ended_at": None},
            {"id": 1, "project_id": 9, "name": "已完", "task_type": "normal",
             "status": "done", "current_round": 2, "session_id": "s8", "error": "",
             "created_at": "2026-09-05 00:00:00", "started_at": None,
             "ended_at": "2026-09-05 03:00:00"},
            {"id": 4, "project_id": 9, "name": "新排队", "task_type": "normal",
             "status": "queued", "current_round": 0, "session_id": "", "error": "",
             "created_at": "2026-09-06 02:00:00", "started_at": None,
             "ended_at": None}]
    monkeypatch.setattr(board.db, "list_tasks", lambda pid: rows)
    data = board.board_payload(9)
    assert [t["id"] for t in data["active_tasks"]
            if t["column"] == "doing"] == [2, 3, 4]   # doing 列现状不回归
    assert all(t["status"] in ("queued", "running") for t in data["active_tasks"]
               if t["column"] == "doing")
    assert [t["id"] for t in data["active_tasks"]
            if t["column"] == "done"] == [1]         # 终态上映（R16：完成→done 列）


def test_force_direct_start_alongside_other_unit_row(monkeypatch):
    """R1/R5：force 直起在他主**前缀行**在场时照常落行起跑——行口径下没有
    「并存」概念（前缀行数可 > N 是正常态），他主行不被触碰。"""
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **kw: None)
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "parallel"})
    monkeypatch.setattr(board, "start_card", lambda proj, card, extra="": None)
    inst = _row_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    tid = waitq.enqueue(waitq.KIND_TASK, 999, 9)        # 他主前缀行在场
    waitq.claim(tid, "worker")
    card, err = board._enter_doing({"id": 9, "agent_path": ""},
                                   _card(id=5, column_key="todo"), force=True)
    assert err is None
    crow = waitq.get_active(waitq.KIND_CARD, 5)
    assert crow is not None and crow["state"] == "running"     # 本卡行已起跑
    assert json.loads(crow["evidence"])["reason"] == "force 直起"
    assert waitq.get_active(waitq.KIND_TASK, 999) is not None  # 他主行原样
    inst.card_finished(5, reason="测试收尾")
    assert waitq.get_active(waitq.KIND_CARD, 5) is None        # 只收本卡行
    assert waitq.get_active(waitq.KIND_TASK, 999) is not None


def test_dequeue_points_leave_no_active_rows(monkeypatch):
    """路线图门禁（v3b/v3d 口径）：删除/拖走/容器迁移两态/to_review 四场景出队后
    本卡不得留有活跃行（漏收口即项目运行位被占死）。"""
    pid = _mk_project()
    inst = _row_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)

    # ①删除：delete_card_cleanup
    cid = db.insert_board_card(pid, "删除卡")
    waitq.enter_running(waitq.KIND_CARD, cid, pid)
    board.delete_card_cleanup(cid)
    assert waitq.get_active(waitq.KIND_CARD, cid) is None, "删除场景泄漏"

    # ②拖走：move_card 出开发列（doing→review：stop_card + 移列出队）
    cid = db.insert_board_card(pid, "拖走卡")
    db.update_board_card(cid, column_key="doing")   # 模拟在管运行卡（src=doing 才有出队语义）
    waitq.enter_running(waitq.KIND_CARD, cid, pid)
    board.move_card({"id": pid, "project_dir": "/tmp/x", "agent_path": "/bin/true"},
                    cid, "review")
    assert waitq.get_active(waitq.KIND_CARD, cid) is None, "拖走场景泄漏"

    # ③容器迁移两态：stop=True（手动拖入阻塞）/ stop=False（交互挂起出队）
    for stop in (True, False):
        cid = db.insert_board_card(pid, f"出队卡-{stop}")
        waitq.enter_running(waitq.KIND_CARD, cid, pid)
        board._leave_doing(db.get_board_card(cid), stop=stop, reason="出队-测试")
        assert waitq.get_active(waitq.KIND_CARD, cid) is None, f"出队场景泄漏（stop={stop}）"

    # ④to_review：调和器归位即出队
    cid = db.insert_board_card(pid, "to_review 卡")
    waitq.enter_running(waitq.KIND_CARD, cid, pid)
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "to_review")
    monkeypatch.setattr(board.chat, "live_of_sid", lambda sid: False)
    board._iw_apply("dsh_plugin", db.get_board_card(cid), "to_review", {})
    assert waitq.get_active(waitq.KIND_CARD, cid) is None, "to_review 场景泄漏"
