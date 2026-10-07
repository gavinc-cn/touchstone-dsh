# 会话实况 busy：card_json/busy_map 合并与单会话 busy 判定（不触网络）；
# 外部条目 ext 行（v2d T4）：行读口/同步刷新/调和器节拍维护行（占位源）。
import os, sys, threading, time, uuid
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import json
import board
import db
import runner
import waitq

import pytest


@pytest.fixture(autouse=True)
def _clean_tables():
    """每例前后清等待项/消息表（conftest 临时库；ext 行落真表）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _row(**kw):
    base = {"id": 1, "project_id": 9, "title": "t", "description": "",
            "column_key": "doing", "sort_order": 1, "session_id": "s-1",
            "sessions": "[]", "block_kind": None, "block_text": "",
            "parent_card_id": None, "origin": "sync", "done_at": None,
            "trashed": 0, "trashed_at": None,
            "scheduled_at": None, "jira_key": "", "last_error": "",
            "last_error_at": None, "created_at": 0, "updated_at": 0}
    base.update(kw)
    return base


def test_card_json_busy_default_false():
    assert board.card_json(_row())["busy"] is False
    assert board.card_json(_row(), True, True)["busy"] is True


def test_board_payload_merges_busy(monkeypatch):
    monkeypatch.setattr(board, "web_busy_map",
                        lambda proj, running_map=None: {"s-1": True})
    monkeypatch.setattr(board.db, "get_project",
                        lambda pid: {"id": pid,
                                     "agent_path": "dsh-plugin:/usr/bin/dsh",
                                     "project_dir": "/tmp/x"})
    monkeypatch.setattr(board.db, "list_board_cards", lambda pid: [_row()])
    monkeypatch.setattr(board.db, "list_board_comments", lambda pid: [])
    monkeypatch.setattr(board, "settings_of", lambda pid: {})
    p = board.board_payload(9, running_map={})
    assert p["cards"][0]["busy"] is True
    assert p["cards"][0]["running"] is False


def test_board_payload_running_wins_over_busy_map(monkeypatch):
    monkeypatch.setattr(board, "web_busy_map",
                        lambda proj, running_map=None: {})
    monkeypatch.setattr(board.db, "get_project",
                        lambda pid: {"id": pid,
                                     "agent_path": "dsh-plugin:/usr/bin/dsh",
                                     "project_dir": "/tmp/x"})
    monkeypatch.setattr(board.db, "list_board_cards", lambda pid: [_row()])
    monkeypatch.setattr(board.db, "list_board_comments", lambda pid: [])
    monkeypatch.setattr(board, "settings_of", lambda pid: {})
    p = board.board_payload(9, running_map={1: True})
    assert p["cards"][0]["busy"] is True and p["cards"][0]["running"] is True


def test_web_session_busy_non_web_false(monkeypatch):
    monkeypatch.setattr(board, "_web_family", lambda p: None)
    assert board.web_session_busy({"project_dir": "/tmp/x", "agent_path": "k"},
                                  "s-1") is False


# ---------- 外部条目 ext 行（外部会话在跑 = 统一队列占位源，v2d T4） ----------
# 旧 `_SYNC_BUSY` 内存集合（doing+sync 卡实况 busy 的项目）已退场：占位源改读
# 「项目活跃 ext 行在场」（board.ext_active / waitq.active_ext，v3d 起仅供展示
# 派生），行即成员入运行前缀；调和器节拍（_iw_once）维护行、入队/恢复前
# _ext_refresh 同步刷新。

def _proj(pid=9):
    return {"id": pid, "agent_path": "dsh-plugin:/usr/bin/dsh",
            "project_dir": "/tmp/x", "archived": 0}


def _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="busy"):
    """真实项目行（探测全程打桩不触 REST）。"""
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"{name}-{uid}", f"/tmp/{name}-{uid}",
                            agent_path, f"/tmp/{name}-{uid}/work")
    return db.get_project(pid)


def _mk_card(pid, title, column="doing", sid="", origin="", block_kind=None):
    cid = db.insert_board_card(pid, title)
    db.update_board_card(cid, column_key=column, session_id=sid, origin=origin,
                         block_kind=block_kind)
    return cid


def _bare_tick_runner():
    """真实 card_finished/_pick_locked 的裸 runner 单例（无 worker 线程）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    r._procs, r._stop_requested = {}, set()
    return r


def _tick(monkeypatch, proj, by_sid, runs=None):
    """跑一轮调和器节拍（项目列表收敛到本测试项目；会话实况按 sid 打桩）。"""
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
    monkeypatch.setattr(board, "_iw_interaction",
                        lambda fam, p, sid, busy_hint=None: by_sid.get(sid))
    monkeypatch.setattr(board, "_RUNS", runs or {})
    inst = _bare_tick_runner()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    board._iw_once()
    return inst


def test_ext_active_reads_active_rows():
    """行读口=项目活跃 ext 行在场（旧 _SYNC_BUSY 集合的等价承接；v3d 起仅供展示派生，
    调度侧不再有探针）。"""
    proj = _mk_project()
    pid = proj["id"]
    assert board.ext_active(pid) is False
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    waitq.insert_ext(pid, sc, "s-1")
    assert board.ext_active(pid) is True
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert board.ext_active(pid) is False


def test_ext_refresh_busy_idle_unknown(monkeypatch):
    """同步刷新（入队/恢复前）：busy→建行 True / idle→收口 True / 探测不明
    （EventHub 未连接=未知）→None（未知不改动，宁可多等不可误放行）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s-1": {"session_id": "s-1", "status": "running",
                "cwd": proj["project_dir"]}})
    assert board._ext_refresh(proj) is True
    assert [r["target_id"] for r in waitq.active_ext_items(pid)] == [str(sc)]
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s-1": {"session_id": "s-1", "status": "idle",
                "cwd": proj["project_dir"]}})
    assert board._ext_refresh(proj) is True          # 行收口（有变化）
    assert waitq.active_ext_items(pid) == []

    monkeypatch.setattr(board.dshevents, "connected", lambda: False)
    assert board._ext_refresh(proj) is None          # 未知：未改动


def test_ext_refresh_candidate_scope(monkeypatch):
    """建行对象域：非终态列、非挂起 interaction、有会话、平台不持有——不满足者
    即使实况 busy 也不建行（todo/done 列、挂起卡、无会话卡）；绑在排除列上的
    会话不算「未建卡」（不触发投影）。"""
    proj = _mk_project()
    pid = proj["id"]
    c_doing = _mk_card(pid, "doing 同步卡", sid="s-doing", origin="sync")
    _mk_card(pid, "todo 卡", column="todo", sid="s-todo", origin="sync")
    _mk_card(pid, "done 卡", column="done", sid="s-done", origin="sync")
    _mk_card(pid, "挂起卡", column="blocked", sid="s-susp", origin="sync",
             block_kind="interaction")
    _mk_card(pid, "无会话卡", column="doing")
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        s: {"session_id": s, "status": "running", "cwd": proj["project_dir"]}
        for s in ("s-doing", "s-todo", "s-done", "s-susp")})
    assert board._ext_refresh(proj) is True
    assert [r["target_id"] for r in waitq.active_ext_items(pid)] == [str(c_doing)]
    # 会话集合口径（2026-09-27 探测域收窄）：排除列（todo/done/挂起 interaction）
    # 卡的会话只进 bound、不进 desired（候选域外）也不算 unbound（未建卡面），
    # 探测结果不影响任何输出
    desired, hold, unbound, unknown = board._ext_candidates(
        proj, db.list_board_cards(pid))
    assert desired == {c_doing: "s-doing"}
    assert (hold, unbound, unknown) == (set(), set(), set())


def test_ext_refresh_cli_family_no_rows(monkeypatch):
    """CLI 族无精确 busy 信号：不建行、不枚举（豁免面③沿用）。"""
    proj = _mk_project(agent_path="/usr/bin/kimi", name="busycli")
    listed = []
    monkeypatch.setattr(board.sessparse, "list_sessions",
                        lambda *a, **k: listed.append(a) or [])
    assert board._ext_refresh(proj) is False
    assert listed == [] and board.ext_active(proj["id"]) is False


def test_iw_once_creates_ext_and_notifies(monkeypatch):
    """调和器：实况 busy 的外部会话卡建 ext 行（入场即 running）并唤醒 runner。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}})
    rows = waitq.active_ext_items(pid)
    assert len(rows) == 1 and rows[0]["state"] == "running"
    assert rows[0]["target_id"] == str(sc)
    assert board.ext_active(pid) is True
    # 幂等：再来一轮不重复建行
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}})
    assert len(waitq.active_ext_items(pid)) == 1


def test_iw_once_pending_sync_card_not_busy_source(monkeypatch):
    """挂起等待回答的卡不算占用源（出队语义：卡离开开发容器即行收口，队列继续
    执行下一个，豁免面②）：已落阻塞列的行收口；同行未及搬列（pending 已探到）
    也不建行。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}})
    assert len(waitq.active_ext_items(pid)) == 1
    db.update_board_card(sc, column_key="blocked", block_kind="interaction")
    r = {"pending": True, "busy": True, "qid": "q_0", "question": "?",
         "options": None, "answerable": True, "text": "?"}
    _tick(monkeypatch, proj, {"s-1": r})
    assert waitq.active_ext_items(pid) == [] and board.ext_active(pid) is False
    # 另一张卡：仍 doing 但本轮已探到挂起 → 不建行
    proj2 = _mk_project(name="busy2")
    _mk_card(proj2["id"], "挂起中卡", sid="s-2", origin="sync")
    _tick(monkeypatch, proj2, {"s-2": r})
    assert waitq.active_ext_items(proj2["id"]) == []


def test_iw_once_rest_failure_keeps_ext_row(monkeypatch):
    """探测失败（REST 异常）保留既有行：宁可多等不放行；无行也不凭空建行。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}})
    assert len(waitq.active_ext_items(pid)) == 1
    _tick(monkeypatch, proj, {"s-1": None})            # r None=探测不可用
    assert [r["target_id"] for r in waitq.active_ext_items(pid)] == [str(sc)]
    assert board.ext_active(pid) is True
    proj2 = _mk_project(name="busy3")
    _mk_card(proj2["id"], "未知卡", sid="s-9", origin="sync")
    _tick(monkeypatch, proj2, {"s-9": None})
    assert waitq.active_ext_items(proj2["id"]) == []    # 未知 ≠ busy


def test_iw_once_platform_card_holder_no_ext(monkeypatch):
    """平台持有者（在管条目）在场不建行：平台单元自有 c: 行占位，
    防 ext:/c: 前缀双计。"""
    proj = _mk_project()
    pid = proj["id"]
    cid = _mk_card(pid, "平台在管卡", sid="s-p")
    _tick(monkeypatch, proj, {"s-p": {"pending": False, "busy": True}},
          runs={cid: {"proc": None, "sid": "s-p"}})
    assert waitq.active_ext_items(pid) == []
    assert board.ext_active(pid) is False


# ---------- 会话三态判定（2026-09-19 运行判定收口·先行） ----------

def test_session_state_non_web_or_no_sid_unknown(monkeypatch):
    proj = {"project_dir": "/tmp/x", "agent_path": "kimi"}
    monkeypatch.setattr(board, "_web_family", lambda p: None)
    assert board.session_state(proj, "s-1") == board.STATE_UNKNOWN
    monkeypatch.setattr(board, "_web_family", lambda p: "dsh_plugin")
    assert board.session_state(proj, "") == board.STATE_UNKNOWN


def test_ext_refresh_status_none_is_unknown(monkeypatch):
    """探测不明（EventHub 未连接=未知）不再当空闲：刷新返回 None 且已建行保留
    （宁可多等不可误放行——旧 kimi status_cached None / `_sync_busy_merge`
    None 语义等价承接）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    waitq.insert_ext(pid, sc, "s-1")
    monkeypatch.setattr(board.dshevents, "connected", lambda: False)
    assert board._ext_refresh(proj) is None               # 未知
    assert [r["target_id"] for r in waitq.active_ext_items(pid)] == [str(sc)]


def test_holders_text_from_prefix_rows():
    """等待日志占位者文本（行口径）：项目运行前缀成员明细「key（evidence，Ns）」，
    空 → 「未知」；真实读口（`project_holder_details`）见 test_runner_evidence。"""
    class _New:
        def project_holder_details(self, pid):
            return [{"key": "c:7", "since": time.time() - 5,
                     "evidence": "卡片会话占用"}]

    t = runner.holders_text(_New(), 3)
    assert t.startswith("c:7（卡片会话占用，") and t.endswith("s）")


def test_holders_text_empty_is_unknown():
    class _Empty:
        def project_holder_details(self, pid):
            return []

    assert runner.holders_text(_Empty(), 3) == "未知"


def test_iw_once_touches_active_run_unit(monkeypatch):
    """平台在管运行卡每轮打**行**心跳（v3c：证据迁行，原 waitq.touch 切到
    waitq.touch_unit(KIND_CARD, cid, …)）；非在管卡不打。
    证据串统一 `busy=1(poll)`（v2d T2 fix 轮遗留 minor 收口：SSE 侧为
    `busy=1(sse)`，轮询侧原 `busy=True` 不同构）。
    本用例只钉**调用面**（打桩）；真实落行见下一例。
    **不要用 `monkeypatch.undo()` 还原桩**：它会连套件级「野 worker 静音」夹具
    （conftest `_mute_leaked_runner_picks`，与本用例共用同一 monkeypatch 实例）
    一并撤销——静音被撤的窗口里遗留 worker 会拾取共享临时库的行（实测致
    tests/test_runner_pick_prefix.py 的野 worker 回归钉偶发失败）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], "在管卡", sid="s-1")
    touched = []
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}},
          runs={cid: {"proc": None, "sid": "s-1", "family": "dsh_plugin"}})
    monkeypatch.setattr(board.waitq, "touch_unit",
                        lambda kind, target, ev="": touched.append(
                            (kind, target, ev)) or True)
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}},
          runs={cid: {"proc": None, "sid": "s-1", "family": "dsh_plugin"}})
    assert touched == [(waitq.KIND_CARD, cid, "busy=1(poll)")]
    # 非在管卡不打（无 _RUNS 条目）
    touched.clear()
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}})
    assert touched == []


def test_iw_once_heartbeat_lands_on_row(monkeypatch):
    """心跳真实落行（v3c 权威写点，与上例互补）：不打桩 `touch_unit`，
    调和节拍直接刷新在管卡活跃 c: 行的 last_seen + evidence（读库断言）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], "真实心跳卡", sid="s-1")
    rid = waitq.enqueue_card(cid, proj["id"])
    waitq.claim_by_target(waitq.KIND_CARD, cid, "worker")
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": True}},
          runs={cid: {"proc": None, "sid": "s-1", "family": "dsh_plugin"}})
    row = waitq.get_item(rid)
    assert row["last_seen"] > 0
    assert json.loads(row["evidence"])["evidence"] == "busy=1(poll)"
    first = row["last_seen"]
    _tick(monkeypatch, proj, {"s-1": {"pending": False, "busy": False}},
          runs={cid: {"proc": None, "sid": "s-1", "family": "dsh_plugin"}})
    row = waitq.get_item(rid)
    assert row["last_seen"] >= first                                     # 打点单调
    assert json.loads(row["evidence"])["evidence"] == "busy=0(poll)"     # 证据更新
