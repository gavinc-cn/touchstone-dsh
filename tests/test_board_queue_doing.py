# 排队卡进开发列：占位落 doing、runner 单态拾取（P4 仅 doing+queue，存量
# blocked+queue 由启动迁移归位）、拖离出队、recover 跳过
# （P4 起 _pick_locked 表驱动：拾取用例以 wait_items waiting 行播种，行即队列）
# v2b T2（裁决 R9）：续跑/手动恢复（review/blocked）= 前缀后插入（等待区最前，
# 原子变体 insert_card_after_prefix），todo 首次起跑落等待区末尾；
# parallel 空闲直起废除（一律入队走补位窗口 N=5）
# v2c T2（裁决 R11 双轨并单轨）：调序改队序（doing reorder_card → waitq.reposition，
# sort_order 保留为非 doing 列 manual 展示序）+ 拾取摘列序（column_order_lt 退役，
# 拾取唯一权威=wait_items seq）
import os, sys, threading, uuid, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board, db, runner, waitq


def setup_function(_fn):
    """每个用例前清空等待项/消息表（conftest 临时库；拾取种子行落真表）。"""
    _clean_waitq_tables()


def teardown_function(_fn):
    """用例后清表：不留 waiting 残行污染后续文件（行即队列，会话级共享临时库）。"""
    _clean_waitq_tables()


def _clean_waitq_tables():
    with db.connect() as conn:
        for t in ("wait_items", "chat_msgs"):
            conn.execute(f"DELETE FROM {t}")


def _card(**kw):
    base = {"id": 1, "project_id": 9, "title": "t", "description": "",
            "column_key": "doing", "sort_order": 1, "session_id": "",
            "sessions": "[]", "block_kind": "queue",
            "block_text": "排队等待：统一队列", "parent_card_id": None,
            "origin": "", "done_at": None, "trashed": 0, "trashed_at": None,
            "scheduled_at": None,
            "jira_key": "", "last_error": "", "last_error_at": None,
            "created_at": 0, "updated_at": 0}
    base.update(kw)
    return base


class _FakeConn:
    def __init__(self, fetchall=None):
        self._fetchall = fetchall or []
    def execute(self, *a, **k):
        return self
    def fetchone(self):
        return [0]
    def fetchall(self):
        return self._fetchall
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_enter_doing_queues_into_doing(monkeypatch):
    """serial 占用中开始（review 卡打回续改路径）：落列与入队统一走锁外
    waitq 单事务（P4 R6；v2b T2 起 review 续跑走原子变体
    insert_card_after_prefix=前缀后插入）——board 不再经 update_board_card
    落占位，submit_card 带 extra（打回意见随 meta 持久化）+ after_prefix 分流标记。"""
    calls = {"upd": [], "sub": [], "ec": []}
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls["upd"].append(kw))
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "serial"})
    monkeypatch.setattr(board.waitq, "insert_card_after_prefix",
                        lambda cid, pid, **kw: calls["ec"].append((cid, pid, kw)))

    def _fake_submit(cid, **kw):
        # 模拟 runner.submit_card 真实接线（v2b T2 分流）：after_prefix=True
        # 走原子变体（行+占位单事务），from_column 取此刻卡片行所在列
        calls["sub"].append((cid, kw))
        if kw.get("after_prefix"):
            board.waitq.insert_card_after_prefix(
                cid, 9, extra=kw.get("extra", ""), from_column="review")

    monkeypatch.setattr(board.runner, "INSTANCE",
                        type("R", (), {"submit_card":
                                       staticmethod(_fake_submit)})())
    card, err = board._enter_doing({"id": 9, "agent_path": ""},
                                   _card(id=5, column_key="review",
                                         block_kind=None),
                                   extra="改一下")
    assert err is None
    assert calls["upd"] == []                          # board 侧无占位写（单写归 waitq）
    assert calls["sub"] == [(5, {"extra": "改一下",
                                 "after_prefix": True})]   # 续跑分流透传
    assert calls["ec"] == [(5, 9, {"extra": "改一下",
                                   "from_column": "review"})]


def test_enter_doing_idempotent_covers_queue_state():
    """幂等分支（P4 单态）：doing+queue 重按开始补一次入队自愈。"""
    calls = []
    orig = board.runner.INSTANCE
    class R:
        def submit_card(self, cid, **kw):
            calls.append((cid, kw))
    board.runner.INSTANCE = R()
    try:
        card, err = board._enter_doing(
            {"id": 9, "agent_path": ""}, _card(id=5), force=False)
        assert err is None and calls == [(5, {})]
    finally:
        board.runner.INSTANCE = orig


def test_pick_locked_accepts_single_queue_state(monkeypatch):
    """排队占位单态：doing+queue 可拾取；blocked+queue（存量形态）不可拾且
    行被 cancelled（占位失效，P4 单态化后该形态无人认领）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._running, r._card_busy = {}, {}
    holder = {"col": "doing"}
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(
            lambda cid: _card(id=cid, column_key=holder["col"]))})())
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    assert r._pick_locked() == "c:5"                   # doing+queue 可拾
    holder["col"] = "blocked"
    assert r._pick_locked() is None                    # blocked+queue 不可拾
    assert waitq.get_active(waitq.KIND_CARD, 5) is None   # 行被 cancelled（占位失效）


def test_pick_locked_drops_non_queue(monkeypatch):
    """卡片不在排队占位态（被 force 直起/拖走）：就地落 cancelled 并跳过。"""
    r = runner.Runner.__new__(runner.Runner)
    r._running, r._card_busy = {}, {}
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(
            lambda cid: _card(id=cid, block_kind=None))})())
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    assert r._pick_locked() is None
    assert waitq.get_active(waitq.KIND_CARD, 5) is None   # 无效单元就地终态化


def test_move_queue_card_to_blocked_skips_leave_doing(monkeypatch):
    """排队卡拖到阻塞：显式出队（上方 cancel_card_wait 行+占位原子取消）+ 不走
    容器迁移收口原语（排队占位卡无会话无工作区改动，`_leave_doing` 不参与）
    + 落 manual（v3b：原用例断言「不走让行提交检查」，让行动作已退场）。"""
    calls = {}
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.setdefault("upd", []).append(kw))
    monkeypatch.setattr(board.db, "connect", lambda: _FakeConn())
    monkeypatch.setattr(board, "is_answer_pending", lambda cid: False)  # 本例无答案分支（P2 读表）
    # v2a T4：queue_state 派生新增 starting 判据——同型桩掉（本例无启动分支）
    monkeypatch.setattr(board, "card_starting", lambda cid: False)
    monkeypatch.setattr(board, "_leave_doing",
                        lambda card, stop=True, reason="":
                        calls.setdefault("leave", []).append(card))
    # P4 单写：拖离取消走 waitq.cancel_card_wait（行+占位原子取消），记录调用
    monkeypatch.setattr(board.waitq, "cancel_card_wait",
                        lambda cid, reason="":
                        calls.setdefault("rm", []).append(cid) or True)
    monkeypatch.setattr(board.runner, "INSTANCE",
                        type("R", (), {"submit_card": staticmethod(lambda cid: None)})())
    out, err = board.move_card({"id": 9}, 5, "blocked", block_text="手动")
    assert err is None
    assert calls["rm"] == [5] and "leave" not in calls
    assert calls["upd"][0]["block_kind"] == "manual"


def test_dequeue_start_failure_returns_card_to_source_column(monkeypatch):
    """起跑失败：清占位 + 回 from_column 列（不再滞留 doing+queue，明示变更③）。"""
    calls = {}
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.update(kw))
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra: (_ for _ in ()).throw(RuntimeError("起不动")))
    monkeypatch.setattr(board.waitq, "get_active", lambda k, t: {
        "meta": '{"extra": "op", "from_column": "review"}'})
    monkeypatch.setattr(board, "_RUNS", {})
    assert board.dequeue_start({"id": 9}, _card(id=5)) is False
    assert calls["column_key"] == "review" and calls["block_kind"] is None


def test_migrate_normalizes_blocked_queue_placeholder(monkeypatch):
    """启动迁移（P4 单态化）：存量 blocked+queue 占位卡归位 doing+queue；
    重复迁移幂等（重复启动不重复改写）；迁移后单态拾取判定照常认领（语义对齐）。"""
    cid = db.insert_board_card(9, "存量占位卡")
    with db.connect() as conn:                     # 直造存量 ghost 形态（迁移前）
        conn.execute("UPDATE board_cards SET column_key='blocked',"
                     " block_kind='queue' WHERE id=?", (cid,))
    db.migrate()                                   # 一次性迁移
    card = db.get_board_card(cid)
    assert (card["column_key"], card["block_kind"]) == ("doing", "queue")
    db.migrate()                                   # 重复启动：幂等
    card = db.get_board_card(cid)
    assert (card["column_key"], card["block_kind"]) == ("doing", "queue")
    monkeypatch.setattr(runner, "db", db)          # 单态拾取判定认领迁移后形态
    r = runner.Runner.__new__(runner.Runner)
    r._running, r._card_busy = {}, {}
    waitq.enqueue(waitq.KIND_CARD, cid, 9)
    assert r._pick_locked() == f"c:{cid}"


def test_enter_doing_force_cancels_residual_queue_row(monkeypatch):
    """force 直起（回归面）：无条件清残留排队态（行+占位原子取消，不 gate
    INSTANCE——表存在即须清）后直起，防 worker 随后拾起与本次直起对撞。"""
    calls = {"cancel": [], "upd": [], "sc": []}
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls["upd"].append(kw))
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "serial"})
    monkeypatch.setattr(board.waitq, "cancel_card_wait",
                        lambda cid, reason="":
                        calls["cancel"].append((cid, reason)) or True)
    monkeypatch.setattr(board, "start_card",
                        lambda proj, card, extra="": calls["sc"].append(card["id"]))
    monkeypatch.setattr(board.runner, "INSTANCE", None)   # 缺位退化也照清
    card, err = board._enter_doing({"id": 9, "agent_path": ""}, _card(id=5),
                                   force=True)
    assert err is None
    assert calls["cancel"] == [(5, "force 直起")]         # 残留排队行无条件清
    assert calls["sc"] == [5]                             # 直起
    assert calls["upd"][0]["block_kind"] is None          # 落 doing 清排队态


def test_recover_skips_queue_placeholder(monkeypatch):
    """recover 对 doing+queue 占位卡不当作崩溃会话恢复（留在原位等重建入队）。"""
    rows = [_card(id=5), _card(id=6, block_kind=None)]
    calls = []
    monkeypatch.setattr(board.db, "connect",
                        lambda: _FakeConn(fetchall=rows))
    monkeypatch.setattr(board.db, "get_project", lambda pid: None)
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(cid))
    monkeypatch.setattr(board.runner, "INSTANCE", None)
    board.recover()
    assert calls == [6]              # queue 占位卡 5 不被恢复流转


def test_pick_locked_ext_row_gates(monkeypatch):
    """外部条目门禁（R8 两处口径合一）：ext 行即前缀成员——行在场留队且不摘除
    平台行，行退场即放行（调度侧不再有独立探针）。"""
    r = runner.Runner.__new__(runner.Runner)
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(
            lambda cid: _card(id=cid))})())
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    sc = db.insert_board_card(9, "同步卡")
    waitq.insert_ext(9, sc, "s-ext")
    assert r._pick_locked() is None          # 外部会话在跑：行占前缀，留队
    assert waitq.get_active(waitq.KIND_CARD, 5)["state"] == "waiting"   # 且不摘除
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert r._pick_locked() == "c:5"         # 外部会话结束：放行


def test_notify_busy_change_wakes_workers(monkeypatch):
    """运行前缀成员变化唤醒（接线冒烟：不抛异常即通过）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    r.notify_busy_change()                   # 空等 worker 被唤醒重挑（无异常即过）


def test_sort_order_no_longer_affects_pick(monkeypatch):
    """单轨断言（v2c T2，裁决 R11）：拾取唯一权威=队序（wait_items seq）——
    sort_order 与队序相反也不影响拾取（列序挑先 column_order_lt 已退场；
    本例翻转自 test_pick_locked_card_follows_column_order，旧口径按列内
    顺序挑 c:2）。"""
    CARDS = {1: _card(id=1, sort_order=2), 2: _card(id=2, sort_order=1)}
    monkeypatch.setattr(board, "settings_of",
                        lambda pid: {"sort": {"doing": "manual"}})
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(lambda cid: CARDS.get(cid))})())
    r = runner.Runner.__new__(runner.Runner)
    waitq.enqueue(waitq.KIND_CARD, 1, 9)   # seq 序=入队顺序 1 先 2 后；sort_order 2 在前
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    assert r._pick_locked() == "c:1"   # 队序唯一权威：卡 1 先跑（sort_order 不参与）
    waitq.claim_by_target(waitq.KIND_CARD, 1, "测试")   # 模拟 worker 拾取
    # starting 行计入运行前缀——serial 窗口 1 已满，卡 2 留队（v2a T3 R5④）
    assert r._pick_locked() is None
    waitq.finish_by_target(waitq.KIND_CARD, 1)          # 起跑收口：行落 done 出前缀
    assert r._pick_locked() == "c:2"   # 剩卡 2


def test_pick_locked_card_keeps_fifo_when_order_matches(monkeypatch):
    """列内顺序与队序一致（默认情形）时维持 FIFO 拾取，行为不变（v2c T2
    兼容断言：单轨后 sort_order 不再参与，seq 序=入队序即 FIFO）。"""
    CARDS = {1: _card(id=1, sort_order=1), 2: _card(id=2, sort_order=2)}
    monkeypatch.setattr(board, "settings_of",
                        lambda pid: {"sort": {"doing": "manual"}})
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(lambda cid: CARDS.get(cid))})())
    r = runner.Runner.__new__(runner.Runner)
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    assert r._pick_locked() == "c:1"   # FIFO


def test_pick_locked_foreign_card_keeps_fifo(monkeypatch):
    """单轨（v2c T2，裁决 R11）：同项目按队序拾取；他项目卡片维持队列 FIFO
    相对次序（翻转自 test_pick_locked_card_column_order_with_foreign_card——
    旧口径同项目按列内顺序挑 c:2，单轨后按 seq 挑 c:1）。"""
    CARDS = {1: _card(id=1, sort_order=2), 2: _card(id=2, sort_order=1),
             3: _card(id=3, project_id=8, sort_order=2)}
    monkeypatch.setattr(board, "settings_of",
                        lambda pid: {"sort": {"doing": "manual"}})
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(lambda cid: CARDS.get(cid))})())
    r = runner.Runner.__new__(runner.Runner)
    waitq.enqueue(waitq.KIND_CARD, 1, 9)   # seq 序=入队顺序；行 project 随卡（生产不变量）
    waitq.enqueue(waitq.KIND_CARD, 3, 8)
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    assert r._pick_locked() == "c:1"   # 单轨：项目9 队首=seq 最小=卡 1
    waitq.claim_by_target(waitq.KIND_CARD, 1, "测试")   # 模拟 worker 拾取
    assert r._pick_locked() == "c:3"   # 项目9 窗口满：项目8 的卡3 原队列位拾起
    # c:1 行仍 starting（前缀成员）→ 项目9 队首卡 2 留队；他项目不受影响
    assert r._pick_locked() == "c:3"
    waitq.claim_by_target(waitq.KIND_CARD, 3, "测试")
    waitq.finish_by_target(waitq.KIND_CARD, 1)          # 起跑收口：行落 done 出前缀
    assert r._pick_locked() == "c:2"


def test_enter_doing_refreshes_ext_before_enqueue(monkeypatch):
    """入队前同步刷新外部条目（ext 行对账，闭合外部会话刚起、调和器未巡到的
    窗口；v2d T4 由原 _sync_busy_refresh 职责移交）。"""
    calls = []
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: None)
    monkeypatch.setattr(board, "settings_of", lambda pid: {"mode": "serial"})
    monkeypatch.setattr(board, "_ext_refresh",
                        lambda proj: calls.append(("refresh", proj["id"])) or False)
    monkeypatch.setattr(board.runner, "INSTANCE",
                        type("R", (), {"submit_card": staticmethod(
                            lambda cid, **kw: calls.append(("submit", cid))),
                            "notify_busy_change": staticmethod(
                                lambda: calls.append(("notify", None))),
                            "remove_card": staticmethod(lambda cid: None)})())
    board._enter_doing({"id": 9, "agent_path": ""},
                       _card(id=5, column_key="todo", block_kind=None))
    assert calls == [("refresh", 9), ("submit", 5)]   # 刷新先于入队
    # 刷新有变化时额外唤醒补位（时机①）；无变化不叫（上面 False 已验）
    calls.clear()
    monkeypatch.setattr(board, "_ext_refresh",
                        lambda proj: calls.append(("refresh", proj["id"])) or True)
    board._enter_doing({"id": 9, "agent_path": ""},
                       _card(id=6, column_key="todo", block_kind=None))
    assert calls == [("refresh", 9), ("notify", None), ("submit", 6)]


def test_recover_refreshes_ext_before_requeue(monkeypatch):
    """recover 重建入队前刷新外部条目（ext 行重启映射；重启后首个调和 tick 前的
    竞态窗口）——实况在→行保持、不在→收口，变化即唤醒补位。"""
    monkeypatch.setattr(board.db, "connect", lambda: _FakeConn())
    monkeypatch.setattr(board.db, "get_project",
                        lambda pid: {"id": pid, "name": "p",
                                     "project_dir": "/tmp/x",
                                     "agent_path": "dsh-plugin:/x"})
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: None)
    monkeypatch.setattr(board.db, "list_queued_board_cards",
                        lambda: [_card(id=5)])
    monkeypatch.setattr(board.waitq, "get_active",
                        lambda k, t: None)   # 对账存在性检查桩掉（FakeConn 会被
                                             # waitq 读侧共用，fetchone 恒真值）
    monkeypatch.setattr(board.waitq, "active_ext_items",
                        lambda pid=None: [{"project_id": 9, "target_id": "5"}])
    calls = []
    monkeypatch.setattr(board, "_ext_refresh",
                        lambda proj: calls.append(("refresh", proj["id"])) or True)
    monkeypatch.setattr(board.runner, "INSTANCE",
                        type("R", (), {"card_started": staticmethod(
                            lambda cid, pid: None),
                            "notify_busy_change": staticmethod(
                                lambda: calls.append(("notify", None))),
                            "submit_card": staticmethod(
                            lambda cid: calls.append(("submit", cid)))})())
    board.recover()
    assert calls == [("refresh", 9), ("notify", None), ("submit", 5)]


# ---------- v2b T2：续跑=前缀后插入（R9）；parallel 直起废除 ----------

def _t2_project():
    """真实项目行（settings_of 读库落默认 serial；agent_path 空串=非 web 族，
    _ext_refresh 直接 False 不触 REST）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"t2-{uid}", f"/tmp/t2-{uid}", "",
                             f"/tmp/t2-{uid}/work")


def _bare_instance():
    """真实 submit_card/unit_state 的裸 runner 单例（无 worker 线程）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    return r


def test_review_card_start_inserts_after_prefix(monkeypatch):
    """续跑=前缀后插入（v2b T2，裁决 R9）：review 卡 start 落「运行中最后一个
    条目后面」=等待区最前（pos=前缀长度+1），不再落等待区末尾；行+占位
    同事务（原子变体 insert_card_after_prefix，v2a 终审契约）。"""
    pid = _t2_project()
    cid_run = db.insert_board_card(pid, "在跑卡")
    cid_wait = db.insert_board_card(pid, "等待卡")
    cid = db.insert_board_card(pid, "续跑卡")
    db.update_board_card(cid, column_key="review")
    with db.connect() as conn:                       # 运行前缀行（seq=1.0）
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,'card',?,'running',1.0,?,'{}')",
            (pid, str(cid_run), db.now_str()))
    waitq.enqueue_card(cid_wait, pid)                # 等待区既有行（seq=2.0）
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    card, err = board._enter_doing({"id": pid, "agent_path": ""},
                                   db.get_board_card(cid))
    assert err is None
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "waiting"
    assert 1.0 < row["seq"] < waitq.get_active(
        waitq.KIND_CARD, cid_wait)["seq"]            # 前缀后、等待区最前
    assert db.get_board_card(cid)["block_kind"] == "queue"   # 占位同事务在场
    st = board.runner.INSTANCE.unit_state(f"c:{cid}", pid)
    assert st == {"state": "queued", "pos": 2, "total": 3}   # pos=前缀长度(1)+1


def test_todo_card_start_lands_tail(monkeypatch):
    """todo 新卡首次起跑落等待区末尾（R9 新建口径，现行语义不变）——续跑的
    前缀后插入不影响新建落尾。"""
    pid = _t2_project()
    cid_wait = db.insert_board_card(pid, "先排卡")
    cid = db.insert_board_card(pid, "新卡")
    waitq.enqueue_card(cid_wait, pid)                # 等待区既有行（seq=1.0）
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    card, err = board._enter_doing({"id": pid, "agent_path": ""},
                                   db.get_board_card(cid))
    assert err is None
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "waiting"
    assert row["seq"] > waitq.get_active(waitq.KIND_CARD, cid_wait)["seq"]  # 落尾
    st = board.runner.INSTANCE.unit_state(f"c:{cid}", pid)
    assert st == {"state": "queued", "pos": 2, "total": 2}


def test_continue_prompt_unchanged():
    """起跑提示词不变（v2b T2 不动 build_start_prompt sid 分支）：有可续接主
    会话（sid 非空）→ 仅「继续」（extra 注入修改意见）；无 sid → 全量首轮。"""
    proj = {"project_dir": "/tmp/x"}
    card = {"title": "卡", "description": "描述"}
    assert board.build_start_prompt(proj, card, sid="s-1") == "继续"
    p = board.build_start_prompt(proj, card, extra="改一下", sid="s-1")
    assert p.startswith("继续") and "【修改意见】改一下" in p
    assert "【任务描述】" in board.build_start_prompt(proj, card)


# ---------- v2b T4：force = 插入前缀尾 + 立即启动（落表，R12） ----------

def test_force_start_lands_in_prefix(monkeypatch):
    """force 落表（v2b T4，裁决 R12）：插入前缀尾（=等待区最前）+ 直入 starting
    （单事务 out-of-band，不经 worker 拾取）；起跑证实 → running 留队构成运行
    前缀（位次计入「前面还有几个」，行口径 R7）；行即占位表征（无第二来源）；
    会话结束（card_finished）行终态化（不泄漏占前缀）。"""
    pid = _t2_project()
    cid_wait = db.insert_board_card(pid, "排队卡")
    cid = db.insert_board_card(pid, "force 卡")
    waitq.enqueue_card(cid_wait, pid)                # 等待区既有行（seq=1.0）
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board, "start_card", lambda p, c, extra="": None)
    monkeypatch.setattr(board, "run_pid", lambda c: 4321)   # CLI proc 在手
    card, err = board._enter_doing({"id": pid, "agent_path": ""},
                                   db.get_board_card(cid), force=True)
    assert err is None
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "running"   # 落表：证实运行
    assert row["seq"] < waitq.get_active(
        waitq.KIND_CARD, cid_wait)["seq"]            # 前缀尾=等待区最前
    ev = json.loads(row["evidence"])
    assert ev["reason"] == "force 直起"
    assert ev["pid"] == 4321   # CLI 判据（R11④ 与 worker 起跑同款）：供重启对账裁活
    st = inst.unit_state(f"c:{cid_wait}", pid)            # 位次计入前缀
    assert st == {"state": "queued", "pos": 2, "total": 2}
    members = inst._prefix_members(waitq.active_items())   # 前缀成员=行（唯一来源）
    assert members.get(pid) == {f"c:{cid}"}
    inst.card_finished(cid, reason="测试收尾")            # 会话结束：行终态化
    assert waitq.get_item(row["id"])["state"] == "done"
    assert waitq.get_active(waitq.KIND_CARD, cid) is None


def test_prefix_full_after_force_no_refill(monkeypatch):
    """force 叠加后新入队卡不补位（serial N=1：行 running 即前缀=1
    ≥ N——force 起跑占住运行位）。"""
    pid = _t2_project()
    cid = db.insert_board_card(pid, "force 卡")
    cid2 = db.insert_board_card(pid, "新卡")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board, "start_card", lambda p, c, extra="": None)
    board._enter_doing({"id": pid, "agent_path": ""},
                       db.get_board_card(cid), force=True)
    waitq.enqueue_card(cid2, pid)                    # 新卡入队落尾
    picker = runner.Runner.__new__(runner.Runner)    # 裸补位器（真库读行）
    picker._lock = threading.Lock()
    picker._cond = threading.Condition(picker._lock)
    picker._procs, picker._stop_requested = {}, set()
    assert picker._pick_locked() is None             # 前缀已满：不补位
    assert waitq.get_active(waitq.KIND_CARD, cid2)["state"] == "waiting"
    inst.card_finished(cid, reason="测试收尾")       # 清理：不泄漏到后续用例


def test_force_failure_rolls_back_row(monkeypatch):
    """force 起跑失败：行 failed（error 落 meta）+ 卡回 from_column
    （dequeue_start 同款收口）——不留 starting 泄漏行占前缀。"""
    pid = _t2_project()
    cid = db.insert_board_card(pid, "force 卡")
    db.update_board_card(cid, column_key="review")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="": (_ for _ in ()).throw(
                            RuntimeError("起不动")))
    card, err = board._enter_doing({"id": pid, "agent_path": ""},
                                   db.get_board_card(cid), force=True)
    assert err == {"error": "起不动"}
    assert waitq.get_active(waitq.KIND_CARD, cid) is None   # 行已终态
    with db.connect() as conn:
        row = conn.execute("SELECT state, meta FROM wait_items"
                           " WHERE kind='card' AND target_id=?",
                           (str(cid),)).fetchone()
    assert row["state"] == "failed"
    assert json.loads(row["meta"])["error"] == "起不动"
    assert db.get_board_card(cid)["column_key"] == "review"  # 回 from_column


def test_worker_pick_failure_row_lands_failed_not_done(monkeypatch):
    """fix round 1（review Important-1）：worker 拾取起跑失败路径的行终态必须
    保持基线 **failed**——worker claim 后行=starting，dequeue_start 失败分支调
    card_finished("起跑失败回滚")（行收口仅限 **running** 态行，force/证实
    路径），不得抢先标 done 让 worker finally 的 finish FAILED 成 no-op。
    白盒全链：claim（starting）→ dequeue_start 失败 → card_finished →
    worker finally finish FAILED。"""
    pid = _t2_project()
    cid = db.insert_board_card(pid, "排队卡")
    db.update_board_card(cid, column_key="review")
    iid = waitq.enqueue_card(cid, pid, from_column="review")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="": (_ for _ in ()).throw(
                            RuntimeError("起不动")))
    # worker 拾取（同 _claim_and_start_locked：claim 原子迁移即占位）
    assert waitq.claim(iid, "worker") is True
    assert board.dequeue_start({"id": pid, "agent_path": ""},
                               db.get_board_card(cid)) is False
    # worker finally 同型（runner.py:1071-1073：card_ok False → failed）
    waitq.finish_by_target(waitq.KIND_CARD, cid,
                           waitq.STATE_FAILED, "起会话失败")
    row = waitq.get_item(iid)
    assert row["state"] == "failed"                # 基线终态（不得被翻成 done）
    assert json.loads(row["meta"])["error"] == "起会话失败"
    assert db.get_board_card(cid)["column_key"] == "review"   # 回 from_column


# ---------- v2c T2：双轨并单轨（调序改队序，裁决 R11） ----------

def test_reorder_writes_queue_position():
    """调序改队序（v2c T2，裁决 R11）：doing 列 reorder_card 改写 wait_items
    seq（waiting 行间重排），sort_order 不动；运行位行不参与（no-op 成功，
    展示层随 payload 队序回正、不刷错误）。"""
    pid = _t2_project()
    w1 = db.insert_board_card(pid, "等待卡1")
    w2 = db.insert_board_card(pid, "等待卡2")
    waitq.enqueue_card(w1, pid)                # waiting 行 seq=1.0 + doing/queue 占位
    waitq.enqueue_card(w2, pid)                # seq=2.0
    so1 = db.get_board_card(w1)["sort_order"]
    so2 = db.get_board_card(w2)["sort_order"]
    assert board.reorder_card(pid, w2, w1) is None
    row2 = waitq.get_active(waitq.KIND_CARD, w2)
    assert row2["seq"] < waitq.get_active(waitq.KIND_CARD, w1)["seq"]   # 队序已改
    assert row2["state"] == "waiting"            # 行状态不动
    assert db.get_board_card(w1)["sort_order"] == so1  # sort_order 不动
    assert db.get_board_card(w2)["sort_order"] == so2
    # 运行位行不参与：no-op 成功（force/停止手势归 move_card _doing_gesture）
    rid = db.insert_board_card(pid, "在跑卡")
    db.update_board_card(rid, column_key="doing")
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,'card',?,'running',0.5,?,'{}')",
            (pid, str(rid), db.now_str()))
    before = [(r["target_id"], r["seq"], r["state"])
              for r in waitq.active_items(pid)]
    assert board.reorder_card(pid, rid, w1) is None
    after = [(r["target_id"], r["seq"], r["state"])
             for r in waitq.active_items(pid)]
    assert after == before                             # 队序零变化


def test_reorder_doing_clamps_to_wait_zone_head():
    """落点收拢（v2c T2）：doing 调序 before_id 指向运行位卡 → 收拢到等待区
    最前（「排到最前」语义——force/停止手势归 move_card _doing_gesture，不在
    reorder 路径）；before_id 不在该列仍 400。"""
    pid = _t2_project()
    rid = db.insert_board_card(pid, "在跑卡")
    db.update_board_card(rid, column_key="doing")
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,'card',?,'running',1.0,?,'{}')",
            (pid, str(rid), db.now_str()))
    w1 = db.insert_board_card(pid, "等待卡1")
    w2 = db.insert_board_card(pid, "等待卡2")
    waitq.enqueue_card(w1, pid)                # seq=2.0
    waitq.enqueue_card(w2, pid)                # seq=3.0
    assert board.reorder_card(pid, w2, rid) is None    # before 运行卡 → 收拢区首
    order = [int(r["target_id"]) for r in waitq.active_items(pid)
             if r["kind"] == "card"]
    assert order == [rid, w2, w1]              # w2 排等待区最前（仍在运行位后）
    assert board.reorder_card(pid, w2, 999999) == "目标位置卡不在该列"


def test_non_doing_columns_reorder_unchanged():
    """非 doing 列调序现行语义不变（v2c T2，裁决 R11：sort_order 保留为非
    doing 列 manual 展示序）：todo manual 列仍整列重写 sort_order、不触碰
    wait_items；非 manual 的非 doing 列仍 400；doing 列 non-manual 放行
    （manual 限定解除，队序即展示序）。"""
    pid = _t2_project()
    c1 = db.insert_board_card(pid, "卡1")      # todo（默认 manual）
    c2 = db.insert_board_card(pid, "卡2")
    assert board.reorder_card(pid, c2, c1) is None
    assert db.get_board_card(c2)["sort_order"] < \
        db.get_board_card(c1)["sort_order"]    # sort_order 重写生效
    assert waitq.active_items(pid) == []       # 不触碰队列
    # 非 manual 的非 doing 列仍 400
    db.set_board_settings(pid, {"sort": {"review": "created_desc"}})
    db.update_board_card(c1, column_key="review")
    db.update_board_card(c2, column_key="review")
    assert board.reorder_card(pid, c2, c1) == "当前列排序方案非手动，不可拖排"
    # doing 列 non-manual 放行（manual 限定解除）
    db.set_board_settings(pid, {"sort": {"review": "created_desc",
                                         "doing": "created_desc"}})
    w1 = db.insert_board_card(pid, "等待卡1")
    w2 = db.insert_board_card(pid, "等待卡2")
    waitq.enqueue_card(w1, pid)
    waitq.enqueue_card(w2, pid)
    assert board.reorder_card(pid, w2, w1) is None   # 不再 400
    assert waitq.get_active(waitq.KIND_CARD, w2)["seq"] < \
        waitq.get_active(waitq.KIND_CARD, w1)["seq"]


def test_pick_follows_queue_order_after_reorder():
    """调序→拾取单链钉（v2c T2 简报清单项，T3 携带补落）：reorder_card 改队序
    后 _pick_locked 直接按新队首拾取（单链：reorder→pick，不重启不隔层）。"""
    pid = _t2_project()
    w1 = db.insert_board_card(pid, "等待卡1")
    w2 = db.insert_board_card(pid, "等待卡2")
    waitq.enqueue_card(w1, pid)                # seq=1.0：初始队首
    waitq.enqueue_card(w2, pid)                # seq=2.0
    r = runner.Runner.__new__(runner.Runner)
    assert r._pick_locked() == f"c:{w1}"       # 初始按入队序拾卡1
    assert board.reorder_card(pid, w2, w1) is None   # 调序：卡2 排到卡1 前
    assert r._pick_locked() == f"c:{w2}"       # 拾取顺序=新队序（单轨）
