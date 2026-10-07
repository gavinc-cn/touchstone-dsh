# board/runner 飞书钩子旁路调用（feishu 语义函数全部打桩，不触网络）
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board
import feishu


def _card(**kw):
    base = {"id": 3, "project_id": 9, "title": "t", "session_id": "s-1",
            "sessions": "[]", "column_key": "doing", "block_kind": None,
            "block_text": "", "origin": None, "worktree": None}
    base.update(kw)
    return base


def test_iw_apply_block_pushes(monkeypatch):
    calls = []
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card())
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **f: None)
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)
    monkeypatch.setattr(feishu, "card_blocked",
                        lambda pid, card, it: calls.append((pid, card["id"])))
    r = {"pending": True, "busy": True, "qid": "q_0", "question": "q?",
         "options": None, "answerable": True, "text": "q?"}
    board._iw_apply("dsh_plugin", _card(), "block", r)
    assert calls == [(9, 3)]


def test_iw_apply_recover_no_push(monkeypatch):
    calls = []
    monkeypatch.setattr(board.db, "get_board_card",
                        lambda cid: _card(column_key="blocked",
                                          block_kind="interaction"))
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **f: None)
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)
    monkeypatch.setattr(feishu, "card_blocked",
                        lambda pid, card, it: calls.append(pid))
    r = {"pending": False, "busy": True, "qid": None, "question": None,
         "options": None, "answerable": True, "text": ""}
    board._iw_apply("dsh_plugin", _card(), "recover", r)
    assert calls == []                                      # 恢复不推（防噪）


def test_finish_run_review_push(monkeypatch):
    calls = []
    monkeypatch.setattr(board, "_web_turn_error", lambda rec: "")
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: _card())
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **f: None)
    monkeypatch.setattr(feishu, "card_review",
                        lambda pid, card: calls.append((pid, card["id"])))
    rec = {"proc": None, "sid": "s-1", "log_path": "/tmp/nonexistent",
           "family": "dsh_plugin", "project_dir": "/tmp/x", "error": ""}
    board._finish_run(3, rec)
    assert calls == [(9, 3)]


def test_notify_task_failed(monkeypatch):
    import runner
    calls = []
    monkeypatch.setattr(runner.db, "get_task", lambda tid: {
        "id": tid, "project_id": 9, "name": "探索", "task_type": "normal"})
    monkeypatch.setattr(feishu, "task_failed",
                        lambda *a, **k: calls.append((a, k)))
    runner.notify_task_failed(5, "第 1 轮退出码 1", skipped_n=2)
    assert calls
    a, k = calls[0]
    assert a[:4] == (9, 5, "探索", "normal") and k["skipped_n"] == 2
    monkeypatch.setattr(runner.db, "get_task", lambda tid: None)
    runner.notify_task_failed(5, "x")                        # 任务已删不抛
    runner.notify_task_failed(5, "y")                        # feishu 异常自吞路径已测
