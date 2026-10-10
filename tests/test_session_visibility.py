# 会话可见性「就绪闸」单测（B/C/D 批次，2026-10-08）
#
# 背景（bug_report/20261008_1935）：插件热重载（disabled 翻转）后驱动实例重建、
# `/live` 短暂返回空表（旧插件不声明完整），旧实现把空快照当权威覆盖注册表，
# 于是「未知」被当成「空闲」——`board.recover()` 把**正在运行的卡**搬去待审核
# 且不自愈；而会话静默消失的 doing 卡又因调和器「未知即跳过」永滞开发列。
#
# 本批三处（设计见 plan/202610/20261008_2045_会话可见性就绪闸与调和器补口（BCD批）设计.md）：
#   B `dshevents`：空快照不清表 + `aligned()` 可信读口（在线且已对齐）；
#   C `board._recover_web_card`：未对齐 ⇒ 不搬列（未知 ≠ 空闲）；
#   D `board._iw_once`：在线且已对齐却查不到 sid ⇒ 会话已结束 → to_review。
import json, os, sys, threading, uuid
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board, db, dshevents, dshdriver, runner


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清等待项/消息表（conftest 临时库；_dequeue_card 会碰这两表）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _sess(sid, status="idle"):
    """一行 `/live` 会话快照（字段与 dshdriver.live 同形）。"""
    return {"session_id": sid, "status": status, "cwd": "/tmp/x", "task": "",
            "owned": False, "interaction": None, "last_turn_reason": None,
            "last_seq": 1, "permission": None}


def _hub(monkeypatch, live):
    """独立 EventHub 实例 + 打桩 `/live` 原始响应、`/archived`（不触网络）。

    `live` 是**原始响应 dict**（`{sessions: [...], complete?: bool}`）——与真客户端
    `dshdriver.live_snapshot()` 同形（2026-10-08 修正：`live()` 返回的是行表 list，
    `_align` 只能消费原始 dict，见「B 修正」一节）。
    """
    h = dshevents.EventHub()
    monkeypatch.setattr(dshevents.dshdriver, "live_snapshot", live)
    monkeypatch.setattr(dshevents.dshdriver, "archived", lambda: [])
    return h


# ---------- B：`_align()` 与 aligned() 读口 ----------

def test_align_nonempty_snapshot_trusted(monkeypatch):
    """非空快照（正常宿主）：覆盖注册表 + 宣称可信。"""
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a"), _sess("b")]})
    h._align()
    h._set_connected(True)
    assert set(h.snapshot()) == {"a", "b"}
    assert h.aligned() is True


def test_align_empty_snapshot_keeps_table_and_untrusted(monkeypatch):
    """插件热重载：`/live` 变空（旧插件不带 complete）⇒ **旧表保留**、不宣称可信。

    这是本批次的核心回归：旧实现 `self._sessions = fresh` 会把已知会话一次性抹掉，
    recover() 随即按「非 busy」把正在运行的卡搬去待审核。
    """
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a", status="running")]})
    h._align()
    h._set_connected(True)
    assert h.aligned() is True
    monkeypatch.setattr(dshevents.dshdriver, "live_snapshot", lambda: {"sessions": []})
    h._align()
    assert set(h.snapshot()) == {"a"}          # 表保留（宁可多等不可误放行）
    assert h.aligned() is False                # 但不得据此推断忙/闲


def test_align_empty_with_complete_declared_is_trusted(monkeypatch):
    """插件声明完整（A 批次后 `/live` 带 complete=true）：空表是权威空 ⇒ 清表且可信。"""
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a")]})
    h._align()
    h._set_connected(True)
    monkeypatch.setattr(dshevents.dshdriver, "live_snapshot",
                        lambda: {"sessions": [], "complete": True})
    h._align()
    assert h.snapshot() == {}
    assert h.aligned() is True


def test_align_failure_marks_untrusted_and_keeps_table(monkeypatch):
    """对齐请求失败：不动表、不宣称可信（不能确认 ≠ 已知为空）。"""
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a")]})
    h._align()
    h._set_connected(True)

    def _boom():
        raise RuntimeError("driver down")

    monkeypatch.setattr(dshevents.dshdriver, "live_snapshot", _boom)
    h._align()
    assert set(h.snapshot()) == {"a"}
    assert h.aligned() is False


def test_aligned_requires_connected(monkeypatch):
    """断连＝未知（不变量 1）：已对齐过也不算可信。"""
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a")]})
    h._align()
    h._set_connected(True)
    assert h.aligned() is True
    h._set_connected(False)
    assert h.aligned() is False


def test_stats_exposes_aligned(monkeypatch):
    """诊断口径：stats 增 aligned 字段（与 connected 联动）。"""
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a")]})
    h._align()
    h._set_connected(True)
    assert h.stats()["aligned"] is True
    h._set_connected(False)
    assert h.stats()["aligned"] is False


def test_module_aligned_wrapper_reads_hub(monkeypatch):
    """模块级 `dshevents.aligned()` 走单例（board 的调用面）。"""
    h = _hub(monkeypatch, lambda: {"sessions": [_sess("a")]})
    h._align()
    h._set_connected(True)
    monkeypatch.setattr(dshevents, "HUB", h)
    assert dshevents.aligned() is True


# ---------- B 修正：`_align` 必须走**真客户端契约**（2026-10-08 追加） ----------
#
# 实障（本轮实测取证）：`dshdriver.live()` 返回的是**行表（list）**，而 `_align` 旧写法
# `resp.get("sessions")` 把它当 dict ⇒ 只要 `/live` 非空就抛 AttributeError，被
# `except Exception` 吞掉后**永久停在「未对齐」**（`_set_aligned(False)` 后 return）：
# aligned() 恒 False ⇒ C 的 recover 闸永不搬列、D 的「缺席归位」永不触发——B/C/D 三处
# 在真机上等于全部失效（安全侧，但病根没治）。
# 取证实录（真客户端 + 真替身 HTTP 替身，1 条会话）：
#   dshdriver.live() 返回类型 = list；_align() 后 aligned() = False、注册表 = []
# 下面三例用**真客户端打真替身**把「客户端 ↔ 中枢」这条缝钉死（修前先红）。

def _real_driver(monkeypatch):
    """起真替身驱动并把真客户端 `dshdriver` 指过去（返回替身，调用方负责 stop）。"""
    from fakedriver import FakeDriver
    drv = FakeDriver().start()
    monkeypatch.setenv("TS_AGENT_DRIVER_URL", drv.url)
    monkeypatch.setenv("TS_AGENT_DRIVER_TOKEN", drv.token)
    return drv


def test_live_readers_contract(monkeypatch):
    """读口契约：`live()`=行表（历史调用点直接迭代），`live_snapshot()`=原始 dict。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.create(cwd="/tmp/x", task="t1")
        rows = dshdriver.live()
        snap = dshdriver.live_snapshot()
    finally:
        drv.stop()
    assert isinstance(rows, list) and len(rows) == 1
    assert isinstance(snap, dict) and snap.get("complete") is True
    assert [r["session_id"] for r in snap["sessions"]] == [r["session_id"] for r in rows]


def test_align_real_client_nonempty_snapshot(monkeypatch):
    """真客户端 + 非空 `/live` ⇒ 注册表覆盖 + 可信（旧写法在这一步就抛异常）。"""
    drv = _real_driver(monkeypatch)
    try:
        sess = drv.create(cwd="/tmp/real", task="t1")
        h = dshevents.EventHub()
        h._align()
        h._set_connected(True)
        assert set(h.snapshot()) == {sess.sid}
        assert h.snapshot()[sess.sid]["cwd"] == "/tmp/real"
        assert h.aligned() is True
    finally:
        drv.stop()


def test_align_real_client_empty_complete_trusted_then_old_plugin_untrusted(monkeypatch):
    """真客户端两条边界：新插件「零会话 + complete」=权威空；旧插件（无该字段）=未知。"""
    drv = _real_driver(monkeypatch)
    try:
        sess = drv.create(cwd="/tmp/real", task="t1")
        h = dshevents.EventHub()
        h._align()
        h._set_connected(True)
        assert set(h.snapshot()) == {sess.sid}
        # ① 新插件：会话真的没了（宿主空表 + 声明完整）⇒ 清表且可信（D 生效的前提）
        drv.sessions.pop(sess.sid, None)
        h._align()
        assert h.snapshot() == {} and h.aligned() is True
        # ② 旧插件（装机副本无 complete）：同样的空表不得当权威 —— 旧表保留、不置可信
        drv.create(cwd="/tmp/real", task="t2")
        h._align()
        assert len(h.snapshot()) == 1
        drv.live_complete = None
        drv.sessions.clear()
        h._align()
        assert len(h.snapshot()) == 1 and h.aligned() is False
    finally:
        drv.stop()


# ---------- C：recover 未对齐不搬列 ----------

def _mk_project(agent_path="dsh-plugin:/usr/bin/dsh"):
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"vis-{uid}", f"/tmp/vis-{uid}", agent_path,
                            f"/tmp/vis-{uid}/work")
    return db.get_project(pid)


def _mk_card(pid, column="doing", sid="", block_kind=None, origin=""):
    cid = db.insert_board_card(pid, "卡")
    db.update_board_card(cid, column_key=column, session_id=sid,
                         block_kind=block_kind, origin=origin,
                         sessions=json.dumps([sid] if sid else []))
    return cid


def test_recover_web_card_untrusted_keeps_column(monkeypatch):
    """未对齐（启动序在 dshevents.start() 之前 / 刚重载）：保留原列，不搬。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-1")
    monkeypatch.setattr(board.dshevents, "aligned", lambda: False)
    monkeypatch.setattr(board, "_web_busy", lambda *a, **k: False)
    board._recover_web_card(proj, db.get_board_card(cid))
    assert db.get_board_card(cid)["column_key"] == "doing"


def test_recover_web_card_aligned_idle_moves_review(monkeypatch):
    """反证（对照组）：已对齐且实况空闲 ⇒ 仍按原口径归位待审核。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-1")
    monkeypatch.setattr(board.dshevents, "aligned", lambda: True)
    monkeypatch.setattr(board, "_web_busy", lambda *a, **k: False)
    board._recover_web_card(proj, db.get_board_card(cid))
    assert db.get_board_card(cid)["column_key"] == "review"


def test_recover_web_card_aligned_busy_keeps_doing(monkeypatch):
    """已对齐 + busy：非 sync 卡重建 _RUNS 条目（原口径不变）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-1", origin="")
    monkeypatch.setattr(board.dshevents, "aligned", lambda: True)
    monkeypatch.setattr(board, "_web_busy", lambda *a, **k: True)
    runs = {}
    monkeypatch.setattr(board, "_RUNS", runs)
    board._recover_web_card(proj, db.get_board_card(cid))
    assert db.get_board_card(cid)["column_key"] == "doing"
    assert cid in runs and runs[cid]["sid"] == "s-1"


# ---------- D：调和器补「在线且已对齐却无此 sid ⇒ to_review」 ----------

class _CountingCond:
    """notify_all 计数的 Condition 包装（补位唤醒断言用，同 test_ext_entries）。"""
    def __init__(self):
        self._c = threading.Condition()
        self.notifies = 0

    def __enter__(self):
        return self._c.__enter__()

    def __exit__(self, *a):
        return self._c.__exit__(*a)

    def wait(self, timeout=None):
        return self._c.wait(timeout)

    def notify_all(self):
        self.notifies += 1
        self._c.notify_all()


def _bare_runner():
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = _CountingCond()
    r._procs, r._stop_requested = {}, set()
    return r


def _tick(monkeypatch, proj, by_sid=None, aligned=True, connected=True, runs=None):
    """跑一轮调和器：项目面收敛到本测试项目，会话实况按 sid 打桩。"""
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
    monkeypatch.setattr(board, "_iw_interaction",
                        lambda fam, p, sid, busy_hint=None: (by_sid or {}).get(sid))
    monkeypatch.setattr(board.dshevents, "connected", lambda: connected)
    monkeypatch.setattr(board.dshevents, "aligned", lambda: aligned)
    monkeypatch.setattr(board.dshevents, "archived", lambda sid: None)
    monkeypatch.setattr(board, "_RUNS", runs or {})
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_runner())
    board._iw_once()


def test_iw_once_absent_sid_aligned_moves_review(monkeypatch):
    """核心用例：中枢可信却查不到 sid ⇒ 会话已结束，doing 卡归位待审核。

    旧口径只对 ext 行收口、卡列不动 —— 卡 908/909/912/913 会话消失后永滞开发列。
    """
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-gone")
    _tick(monkeypatch, proj, by_sid={})          # 注册表里没有 s-gone
    assert db.get_board_card(cid)["column_key"] == "review"


def test_iw_once_absent_sid_untrusted_keeps_column(monkeypatch):
    """未对齐（刚重载 / 断连）：一律不动（未知 ≠ 会话已结束）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-gone")
    _tick(monkeypatch, proj, by_sid={}, aligned=False)
    assert db.get_board_card(cid)["column_key"] == "doing"
    _tick(monkeypatch, proj, by_sid={}, connected=False, aligned=False)
    assert db.get_board_card(cid)["column_key"] == "doing"


def test_iw_once_absent_sid_platform_holds_keeps_column(monkeypatch):
    """平台持有（在管运行条目）⇒ 列流转归 _finish_run，本规则不插手。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-gone")
    runs = {cid: {"proc": None, "sid": "s-gone", "seen_busy": True}}
    _tick(monkeypatch, proj, by_sid={}, runs=runs)
    assert db.get_board_card(cid)["column_key"] == "doing"


def test_iw_once_absent_sid_queue_placeholder_keeps_column(monkeypatch):
    """doing/queue 排队占位卡：只放行 block，忙闲一律不搬列（状态机原口径）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-gone", block_kind="queue")
    _tick(monkeypatch, proj, by_sid={})
    assert db.get_board_card(cid)["column_key"] == "doing"


def test_iw_once_present_idle_still_moves_review(monkeypatch):
    """对照组：sid 在场且空闲 ⇒ 原口径 doing→review 不变。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="doing", sid="s-1")
    _tick(monkeypatch, proj, by_sid={"s-1": {"pending": False, "busy": False}})
    assert db.get_board_card(cid)["column_key"] == "review"
