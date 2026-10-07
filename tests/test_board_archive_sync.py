# 看板「已完成」⇄ dsh 会话归档 双向同步（2026-10-05）
#
# 语义：卡片在 done ⟺ 卡片主会话在 dsh 归档集；done 卡的全部绑定会话都归档，
# 离开 done 全部取消归档。两个写者：平台移列（move_card/_enter_doing，归档先行、
# 失败硬回滚并 400）与 dsh 侧归档/取消归档（调和器按 dshevents 快照反向搬列）。
# 口径（用户确认）：会话不存在（宿主 410）→ 跳过该 sid 放行；其余失败 → 回滚 +
# 报错；存量 done 卡不回溯；外部取消归档（边沿 True→False）把 done 卡送回 review。
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board
import db
import waitq


@pytest.fixture(autouse=True)
def _clean_state():
    """每例前后清等待表与归档同步的进程内状态（conftest 临时库）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
        board._ARCHIVE_RETRY.clear()
        board._ARCH_SEEN.clear()
    _clean()
    yield
    _clean()


# ---------- 夹具：真实项目行 + 打桩归档面 ----------

def _mk_project(agent_path="dsh-plugin:/usr/bin/dsh"):
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"arch-{uid}", f"/tmp/arch-{uid}", agent_path,
                            f"/tmp/arch-{uid}/work")
    return db.get_project(pid)


def _mk_card(pid, title="卡", column="todo", sid="", sessions=None, origin=""):
    cid = db.insert_board_card(pid, title)
    db.update_board_card(cid, column_key=column, session_id=sid, origin=origin,
                         sessions=__import__("json").dumps(sessions or []))
    return cid


def _stub_archive(monkeypatch, fail=(), unknown=(), prior=None):
    """打桩归档面：返回调用记录 [(sid, archived)]。

    fail/unknown 为 sid 集合（fail 里出现 `"*"` 表示一律失败）；
    prior 为 dshevents 归档集快照（None=未知）。
    """
    calls = []

    def fake_call(sid, archived):
        calls.append((sid, archived))
        if sid in unknown:
            return "unknown"
        if "*" in fail or sid in fail:
            return "boom"
        return "ok"

    monkeypatch.setattr(board, "_archive_call", fake_call)
    monkeypatch.setattr(board.dshdriver, "configured", lambda: True)
    # 防御性停会话（move_card 非 doing 目标会 stop_card）也要打桩：驱动未配置时
    # `configured` 被打桩成 True，`dshdriver.cancel` 会拿空 URL 真发请求
    monkeypatch.setattr(board.dshdriver, "cancel",
                        lambda sid, keep_inbox=False: None)
    monkeypatch.setattr(board.dshevents, "archived_set",
                        lambda: None if prior is None else set(prior))
    return calls


def _stub_hub(monkeypatch, mapping):
    """打桩归档集读口：mapping = {sid: True/False/None}（None=未知）。"""
    monkeypatch.setattr(board.dshevents, "archived",
                        lambda sid: mapping.get(sid))
    monkeypatch.setattr(board.dshevents, "archived_set",
                        lambda: {s for s, v in mapping.items() if v is True})


def _stub_start(monkeypatch, log=None):
    """起会话面打桩（move_card→doing 会走到 start_card）。"""
    monkeypatch.setattr(board.runner, "INSTANCE", None)
    monkeypatch.setattr(board, "start_card",
                        lambda proj, card, extra="": (log.append("start")
                                                      if log is not None else None))
    monkeypatch.setattr(board.dshdriver, "cancel",
                        lambda sid, keep_inbox=False: None)


# ---------- 纯函数：绑定会话集合 ----------

def test_card_sids_main_first_dedup():
    """主会话在前、sessions 去重去空。"""
    card = {"session_id": "a", "sessions": '["b", "a", "", "c"]'}
    assert board._card_sids(card) == ["a", "b", "c"]
    assert board._card_sids({"session_id": "", "sessions": "[]"}) == []


# ---------- 正向：平台移列 → 归档/取消归档 ----------

def test_move_to_done_archives_all_bound_sessions(monkeypatch):
    """拖入「已完成」：主会话 + sessions 全部归档（先归档，成功才落列）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a", "b"])
    calls = _stub_archive(monkeypatch, prior=set())
    card, err = board.move_card(proj, cid, "done")
    assert err is None, err
    assert calls == [("a", True), ("b", True)]
    assert db.get_board_card(cid)["column_key"] == "done"


def test_move_out_of_done_unarchives_all(monkeypatch):
    """从「已完成」拖到待审核：全部绑定会话取消归档。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="done", sid="a", sessions=["a", "b"])
    calls = _stub_archive(monkeypatch, prior={"a", "b"})
    card, err = board.move_card(proj, cid, "review")
    assert err is None, err
    assert calls == [("a", False), ("b", False)]
    assert db.get_board_card(cid)["column_key"] == "review"


def test_move_done_to_doing_unarchives_before_start(monkeypatch):
    """已完成的卡拖回「正在开发」：先取消归档、再起会话（归档会挡模型步）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="done", sid="a", sessions=["a"])
    order = []

    def fake_call(sid, archived):
        order.append(("archive", sid, archived))
        return "ok"

    monkeypatch.setattr(board, "_archive_call", fake_call)
    monkeypatch.setattr(board.dshdriver, "configured", lambda: True)
    monkeypatch.setattr(board.dshevents, "archived_set", lambda: {"a"})
    _stub_start(monkeypatch, log=order)
    card, err = board._enter_doing(proj, db.get_board_card(cid))
    assert err is None, err
    assert order == [("archive", "a", False), "start"], order


def test_archive_failure_rolls_back_move_and_compensates(monkeypatch):
    """归档失败（非「会话不存在」）：本次移列整体放弃——列不变 + 已改动的补偿回滚。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a", "b"])
    calls = _stub_archive(monkeypatch, fail=("b",), prior=set())
    card, err = board.move_card(proj, cid, "done")
    assert card is None and err and "归档失败" in err["error"], err
    assert calls == [("a", True), ("b", True), ("a", False)]   # 补偿回滚 a
    cur = db.get_board_card(cid)
    assert cur["column_key"] == "review"                       # 列未动
    assert "归档失败" in (cur["last_error"] or "")


def test_unknown_session_skipped_and_card_moves(monkeypatch):
    """会话不存在（宿主 410）：跳过该 sid 放行移卡，记一行 last_error 提示。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a", "ghost"])
    calls = _stub_archive(monkeypatch, unknown=("ghost",), prior=set())
    card, err = board.move_card(proj, cid, "done")
    assert err is None, err
    assert calls == [("a", True), ("ghost", True)]
    cur = db.get_board_card(cid)
    assert cur["column_key"] == "done"
    assert "归档跳过" in (cur["last_error"] or "")


def test_already_archived_sid_not_called_again(monkeypatch):
    """归档集快照说已在目标态 → 不再打驱动（级联/重复移列的幂等省调用）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a", "b"])
    calls = _stub_archive(monkeypatch, prior={"a"})
    card, err = board.move_card(proj, cid, "done")
    assert err is None, err
    assert calls == [("b", True)]


def test_archive_sync_disabled_by_env(monkeypatch):
    """TS_ARCHIVE_SYNC=0：整条同步链关闭（移列照常，不触归档面）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a"])
    calls = _stub_archive(monkeypatch, prior=set())
    monkeypatch.setenv("TS_ARCHIVE_SYNC", "0")
    card, err = board.move_card(proj, cid, "done")
    assert err is None and calls == []
    assert db.get_board_card(cid)["column_key"] == "done"


def test_archive_sync_skipped_when_driver_absent(monkeypatch):
    """独立形态（无驱动）：归档面无动作，移列照常（用户不能因形态被挡住）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a"])
    calls = _stub_archive(monkeypatch, prior=set())
    monkeypatch.setattr(board.dshdriver, "configured", lambda: False)
    card, err = board.move_card(proj, cid, "done")
    assert err is None and calls == []


# ---------- 反向：dsh 归档 → 卡片进「已完成」 ----------

def _tick(monkeypatch, proj, by_sid=None):
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
    monkeypatch.setattr(board, "_iw_interaction",
                        lambda fam, p, sid, busy_hint=None: (by_sid or {}).get(sid))
    monkeypatch.setattr(board, "_RUNS", {})
    board._iw_once()


def test_reconcile_archived_main_moves_card_to_done_and_cascades(monkeypatch):
    """主会话已被 dsh 归档 ⇒ 卡片（review）进「已完成」，其余绑定会话级联归档。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a", "b"])
    calls = _stub_archive(monkeypatch, prior={"a"})
    _stub_hub(monkeypatch, {"a": True})
    _tick(monkeypatch, proj)
    assert db.get_board_card(cid)["column_key"] == "done"
    assert calls == [("b", True)]          # 主会话 a 已在归档集，跳过


def test_reconcile_archived_main_moves_todo_card(monkeypatch):
    """归档电平优先于终态守卫：todo 卡同样进「已完成」。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="todo", sid="a", sessions=["a"])
    _stub_archive(monkeypatch, prior={"a"})
    _stub_hub(monkeypatch, {"a": True})
    _tick(monkeypatch, proj)
    assert db.get_board_card(cid)["column_key"] == "done"


def test_reconcile_archived_unknown_no_action(monkeypatch):
    """归档态未知（中枢断连）：一律不动作——绝不把「读不到」当「未归档」。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a"])
    calls = _stub_archive(monkeypatch, prior=None)
    _stub_hub(monkeypatch, {"a": None})
    _tick(monkeypatch, proj, {"a": {"pending": False, "busy": False}})
    assert db.get_board_card(cid)["column_key"] == "review"
    assert calls == []


def test_reconcile_unarchive_edge_returns_done_card_to_review(monkeypatch):
    """外部「取消归档」（True→False 边沿）且卡在 done ⇒ 回「待审核」+ 级联取消归档。

    主会话 a 已不在归档集（就是这次取消归档的对象），其余 b 仍在 ⇒ 只对 b 补发
    取消归档（已到位的跳过，见 `_archive_card_sessions` 的已知态快照判据）。
    """
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="done", sid="a", sessions=["a", "b"])
    calls = _stub_archive(monkeypatch, prior={"b"})
    _stub_hub(monkeypatch, {"a": False, "b": True})
    board._ARCH_SEEN["a"] = True           # 上一轮观测到已归档
    _tick(monkeypatch, proj)
    assert db.get_board_card(cid)["column_key"] == "review"
    assert calls == [("b", False)]


def test_reconcile_unarchive_without_edge_keeps_done(monkeypatch):
    """无 True→False 边沿（首见即 False / 归档从未成功）不搬列——防归档失败被踢出。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="done", sid="a", sessions=["a"])
    calls = _stub_archive(monkeypatch, prior=set())
    _stub_hub(monkeypatch, {"a": False})
    board._ARCH_SEEN.pop("a", None)
    _tick(monkeypatch, proj)
    assert db.get_board_card(cid)["column_key"] == "done"
    assert calls == []


def test_reconcile_cascade_failure_goes_to_retry(monkeypatch):
    """级联归档失败（dsh 侧已改、回滚不了）：卡片仍进 done，失败 sid 进重试表。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="review", sid="a", sessions=["a", "b"])
    _stub_archive(monkeypatch, fail=("b",), prior={"a"})
    _stub_hub(monkeypatch, {"a": True})
    _tick(monkeypatch, proj)
    assert db.get_board_card(cid)["column_key"] == "done"
    assert "b" in board._ARCHIVE_RETRY


# ---------- 绑定会话到 done 卡（fork / bind_session） ----------

def test_archive_bound_session_on_done_card(monkeypatch):
    """done 卡新绑定会话 → 立即归档（I2 维护），非 done 卡 no-op。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="done", sid="a", sessions=["a"])
    calls = _stub_archive(monkeypatch, prior=set())
    board.archive_bound_session(db.get_board_card(cid), "fork-1")
    assert calls == [("fork-1", True)]
    cid2 = _mk_card(proj["id"], column="review", sid="z")
    board.archive_bound_session(db.get_board_card(cid2), "fork-2")
    assert calls == [("fork-1", True)]


def test_archive_bound_session_unknown_records_hint(monkeypatch):
    """done 卡绑定一个不存在的会话：跳过 + last_error 提示，不抛。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], column="done", sid="a", sessions=["a"])
    _stub_archive(monkeypatch, unknown=("ghost",), prior=set())
    board.archive_bound_session(db.get_board_card(cid), "ghost")
    assert "归档跳过" in (db.get_board_card(cid)["last_error"] or "")
    assert waitq.get_active(waitq.KIND_CARD, cid) is None
