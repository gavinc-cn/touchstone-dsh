# 会话详情页停止按钮：board.stop_card 对外部同步卡（web 族、平台 _RUNS 无记录）
# 的兜底停止（2026-09-09 修复）——此前 _RUNS 无记录即 no-op，但会话端点 running
# 判定含 web 实况 busy，停止按钮照常显示、点击无效
# v2b T3（裁决 R9）：等待区卡停止入口——doing/queue 卡 stop 取消排队落待审核
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board
import db
import waitq


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清 waitq 两表（本文件 v2b T3 起种子真实等待行；conftest 临时库）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


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


def _proj(**kw):
    base = {"id": 9, "agent_path": "", "project_dir": "/tmp/p", "work_dir": "/tmp/w"}
    base.update(kw)
    return base


def test_stop_card_no_run_retired_family_false(monkeypatch):
    """退场族项目（旧 kimi CLI 路径）无平台记录：`_web_family` 为 None ⇒ 无停止
    通道，保持返回 False，不误报已停、不触 dsh 驱动。"""
    calls = {"cancel": []}
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(id=cid))
    monkeypatch.setattr(board.db, "get_project",
                        lambda pid: _proj(agent_path="/usr/bin/kimi"))
    monkeypatch.setattr(board.dshdriver, "cancel",
                        lambda sid, keep_inbox=False: calls["cancel"].append(sid))
    assert board.stop_card(1) is False
    assert calls["cancel"] == []


def test_stop_card_no_run_card_missing_false(monkeypatch):
    """卡片已不存在（如软删后竞态）→ False，不抛。"""
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: None)
    assert board.stop_card(1) is False


def test_stop_card_platform_cli_still_killpg(monkeypatch):
    """防御分支：`_RUNS` 条目带 proc（历史 CLI 形态残留/异常注入）仍走进程组
    终止，不受兜底影响；单族化后正常条目恒为 proc=None（web 驱动），此分支
    只作兜底保留。"""
    calls = {"kill": []}

    class Proc:
        pid = 123
        def poll(self):
            return None

    monkeypatch.setattr(board, "_RUNS", {5: {"proc": Proc()}})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda pid, sig: calls["kill"].append((pid, sig)))
    assert board.stop_card(5) is True
    assert calls["kill"] == [(123, board.signal.SIGTERM)]


# ---------- P7a 缺陷 A：dsh 兜底只走驱动 cancel（不再落本地服务） ----------

def test_stop_card_no_run_dsh_aborts_without_local_service(monkeypatch):
    """dsh 卡（_RUNS 无记录、有会话）停止：只走 dshdriver.cancel。

    P7a 缺陷 A 回归钉：原先 dsh 卡会被当 opencode 会话落本地服务兜底，把
    `dsh-plugin:<路径>` 当 opencode 可执行文件 spawn → FileNotFoundError 打穿
    HTTP handler（卡片「通过」/拖列 502）；单族化后平台侧已无本地服务可拉
    （两族 web 驱动模块随族退场），唯一停止通道就是驱动 cancel。"""
    calls = {"cancel": []}
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(
        id=cid, origin="sync", session_id="s-dsh"))
    monkeypatch.setattr(board.db, "get_project", lambda pid: _proj(
        agent_path="dsh-plugin:/opt/dsh"))
    monkeypatch.setattr(board.dshdriver, "cancel",
                        lambda sid, keep_inbox=False: calls["cancel"].append(sid))
    assert board.stop_card(7) is True
    assert calls["cancel"] == ["s-dsh"]


def test_stop_card_no_run_dsh_abort_error_false(monkeypatch):
    """dsh 兜底 abort 的驱动异常（宿主不可达/会话不存在）→ False，不外抛。"""
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card(
        id=cid, session_id="s-dsh"))
    monkeypatch.setattr(board.db, "get_project", lambda pid: _proj(
        agent_path="dsh-plugin:/x/dsh"))
    monkeypatch.setattr(board.dshdriver, "cancel",
                        lambda sid, keep_inbox=False:
                        (_ for _ in ()).throw(board.dshdriver.DshDriverError(404, "gone")))
    assert board.stop_card(8) is False


# ---------- P7a 缺陷 D：dsh 短轮 / 起跑窗口停止不必空等 90s ----------

def _dsh_run(**kw):
    rec = {"proc": None, "sid": "s-dsh", "family": "dsh_plugin",
           "project_dir": "/tmp/p", "started_at": int(time.time() * 1000),
           "seen_busy": False, "aborted": False,
           "turn_baseline": ("completed", 3), "log_path": ""}
    rec.update(kw)
    return rec


def test_watch_runs_once_dsh_short_turn_finishes_without_grace(monkeypatch):
    """hub 已知且 turn 已推进基线（短轮漏观测 busy）→ 本拍即收尾，
    不等 _STARTING_TIMEOUT_S 宽限（P7a 缺陷 D）。"""
    rec = _dsh_run()
    finished = []
    monkeypatch.setattr(board, "_RUNS", {11: rec})
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "idle", "last_seq": 9,
                                     "last_turn_reason": "completed"})
    monkeypatch.setattr(board, "_finish_run", lambda cid, r: finished.append(cid))
    board._watch_runs_once()
    assert finished == [11]
    assert 11 not in board._RUNS


def test_watch_runs_once_dsh_aborted_in_start_window_finishes(monkeypatch):
    """起跑窗口内被用户停止（aborted）+ hub 已知非 running → 立即收尾
    （原先要等满 90s 宽限，项目串行位白占 ~71s）。"""
    rec = _dsh_run(aborted=True)
    finished = []
    monkeypatch.setattr(board, "_RUNS", {12: rec})
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "idle", "last_seq": 3,
                                     "last_turn_reason": "completed"})
    monkeypatch.setattr(board, "_finish_run", lambda cid, r: finished.append(cid))
    board._watch_runs_once()
    assert finished == [12]


def test_watch_runs_once_dsh_hub_unknown_keeps_run(monkeypatch):
    """hub 断连（未知）⇒ 保持现状：绝不把「读不到」推断成「已结束」
    （dshevents 不变量；防掉线误收口占用行）。"""
    rec = _dsh_run()
    finished = []
    monkeypatch.setattr(board, "_RUNS", {13: rec})
    monkeypatch.setattr(board.dshevents, "get", lambda sid: None)
    monkeypatch.setattr(board, "_finish_run", lambda cid, r: finished.append(cid))
    board._watch_runs_once()
    assert finished == []
    assert 13 in board._RUNS


def test_watch_runs_once_dsh_turn_not_started_waits_grace(monkeypatch):
    """hub 已知但基线未变（turn 真没起来）→ 不进快路径，走原宽限/判负逻辑。"""
    rec = _dsh_run(turn_baseline=("completed", 9))
    finished = []
    monkeypatch.setattr(board, "_RUNS", {14: rec})
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "idle", "last_seq": 9,
                                     "last_turn_reason": "completed"})
    monkeypatch.setattr(board, "_finish_run", lambda cid, r: finished.append(cid))
    board._watch_runs_once()
    assert finished == []
    assert 14 in board._RUNS


# ---------- 等待区卡停止（v2b T3，R9：任意队列中卡可停止→待审核） ----------

def test_stop_queued_card_cancels_wait_and_reviews(monkeypatch):
    """doing/queue 卡 stop：出队收口（v3b 统一原语 `_dequeue_card`——c: 行即
    cancelled（reason=用户停止）+ 占位清除 + 归位待审核 + 补位唤醒）——无会话可停
    （不 abort 不 kill）；排队消息与待送达答案先取消（现行顺序保留并扩 c: 行）。"""
    pid = db.insert_project(0, "stop-q", "/tmp/stop-q", "/bin/true", "/tmp/stop-q/w")
    cid = db.insert_board_card(pid, "排队卡")
    iid = waitq.enqueue_card(cid, pid)                 # doing+queue 占位 + waiting 行
    i_ans = waitq.enqueue(waitq.KIND_ANSWER, cid, pid,
                          meta={"sid": "s-1", "qid": "Q-1", "answers": []})
    calls = {"cancel_queued": [], "remove_answer": [], "kill": [], "finish": []}
    monkeypatch.setattr(board.chat, "cancel_queued",
                        lambda card_id=None: calls["cancel_queued"].append(card_id))
    monkeypatch.setattr(board.runner, "INSTANCE",
                        type("R", (), {
                            "remove_answer": staticmethod(
                                lambda c: calls["remove_answer"].append(c)),
                            "card_finished": staticmethod(
                                lambda c, reason="":
                                calls["finish"].append((c, reason)))})())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda p, s: calls["kill"].append(p))
    assert board.stop_card(cid) is True
    assert calls["cancel_queued"] == [cid]             # 排队消息先取消（现行顺序）
    assert waitq.get_item(i_ans)["state"] == "cancelled"   # 待送达答案先取消
    assert calls["remove_answer"] == [cid]
    assert calls["kill"] == []                         # 无会话可停
    assert calls["finish"] == [(cid, "用户停止")]       # 行收口经唯一收尾点（v3b 出队原语）
    assert waitq.get_active(waitq.KIND_CARD, cid) is None  # c: 行已取消
    import json as _json
    assert _json.loads(waitq.get_item(iid)["meta"])["cancel_reason"] == "用户停止"
    card = db.get_board_card(cid)                      # 落待审核 + 占位清除
    assert (card["column_key"], card["block_kind"]) == ("review", None)
    assert card["block_text"] == ""


def test_stop_running_card_unchanged(monkeypatch):
    """运行中卡 stop 现行路径不动（非翻转护栏）：doing 无占位卡（_RUNS 有
    proc）→ 进程组终止；不触发等待区分支（无 c: 行取消、无列写），收尾→review
    仍归 _finish_run。"""
    pid = db.insert_project(0, "stop-run", "/tmp/stop-run", "/bin/true",
                            "/tmp/stop-run/w")
    cid = db.insert_board_card(pid, "在跑卡")
    db.update_board_card(cid, column_key="doing")
    calls = {"kill": [], "cancel_wait": []}

    class Proc:
        pid = 123
        def poll(self):
            return None

    monkeypatch.setattr(board, "_RUNS", {cid: {"proc": Proc()}})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda p, s: calls["kill"].append(p))
    monkeypatch.setattr(board.waitq, "cancel_card_wait",
                        lambda c, reason="": calls["cancel_wait"].append(c) or True)
    assert board.stop_card(cid) is True
    assert calls["kill"] == [123]
    assert calls["cancel_wait"] == []                  # 等待区分支未触发
    assert db.get_board_card(cid)["column_key"] == "doing"   # 列不动
