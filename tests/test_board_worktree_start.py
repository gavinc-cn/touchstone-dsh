# 看板卡片「独立 worktree 起跑」单测（2026-10-06 批次）：
# 不入统一队列（无 wait_items 行）、会话 cwd 取 worktree 路径、已有会话拒绝切
# worktree（D10）、父依赖门禁、起会话失败回滚、recover 不补建队列行、
# card_json 下发 worktree、cleanup 清标记、老库迁移补列。
# 设计：doc_ai/plan/202610/20261006_0115_看板卡片独立worktree执行（开始按钮下拉+免排队）.md
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board
import db
import waitq


def _mk_project(tmp_path):
    """造一个绑定 dsh 插件族的项目行（agent_path 用 dsh-plugin 前缀，族判定即通过）。"""
    name = "wt_" + uuid.uuid4().hex[:10]
    repo = tmp_path / name / "repo"
    work = tmp_path / name / "work"
    repo.mkdir(parents=True)
    work.mkdir(parents=True)
    pid = db.insert_project(1, name, str(repo), "dsh-plugin:/usr/bin/dsh", str(work))
    return db.get_project(pid)


def _mk_card(project_id, **fields):
    cid = db.insert_board_card(project_id, "wt 卡")
    if fields:
        db.update_board_card(cid, **fields)
    return db.get_board_card(cid)


def _stub_start(monkeypatch, tmp_path, calls):
    """打桩 start_card（不碰 dsh 驱动）与 append_log，记录 (卡 id, 会话 cwd)。"""
    def _fake_start(project, card, extra=""):
        calls["start"] = (card["id"], board.card_workspace(project, card))
        return str(tmp_path / "fake.log")
    monkeypatch.setattr(board, "start_card", _fake_start)
    monkeypatch.setattr(board.runner, "append_log", lambda *a, **k: None)


def test_worktree_start_no_queue_row(tmp_path, monkeypatch):
    """worktree 直起：卡落 doing、写 worktree 路径、**不落 wait_items 行**、
    会话 cwd = worktree 路径（plan D1/D7）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"])
    wt = str(tmp_path / "wts" / ("card_%d" % card["id"]))
    calls = {}
    monkeypatch.setattr(board.worktree, "create", lambda p, cid: (wt, "ts/card-%d" % cid, ""))
    _stub_start(monkeypatch, tmp_path, calls)

    card_dict, err = board.start_into_doing(proj, card, "", False, True)
    assert err is None and card_dict is not None
    assert card_dict["worktree"] == wt and card_dict["column"] == "doing"
    cur = db.get_board_card(card["id"])
    assert cur["column_key"] == "doing" and cur["worktree"] == wt
    assert waitq.get_active(waitq.KIND_CARD, card["id"]) is None   # 不入队 = 不占运行位
    assert calls["start"] == (card["id"], wt)                      # cwd 是 worktree，不是 project_dir


def test_worktree_card_resume_reuses_worktree(tmp_path, monkeypatch):
    """已标记 worktree 的卡（打回续改/重试）：不传 worktree 参也自动走 worktree 路径，
    复用同一路径、仍不入队（plan D3）。"""
    proj = _mk_project(tmp_path)
    wt = str(tmp_path / "wts" / "card_reuse")
    card = _mk_card(proj["id"], column_key="review", worktree=wt)
    seen = {}
    monkeypatch.setattr(board.worktree, "create",
                        lambda p, cid: (seen.setdefault("cid", cid) and None) or (wt, "ts/card-%d" % cid, ""))
    calls = {}
    _stub_start(monkeypatch, tmp_path, calls)

    card_dict, err = board.start_into_doing(proj, card, "打回意见")
    assert err is None and seen["cid"] == card["id"]
    assert card_dict["worktree"] == wt and card_dict["column"] == "doing"
    assert waitq.get_active(waitq.KIND_CARD, card["id"]) is None
    assert calls["start"] == (card["id"], wt)


def test_worktree_start_rejects_card_with_session(tmp_path, monkeypatch):
    """D10：卡片已有主会话（当初在 project_dir 起的）不允许切 worktree——
    dsh 的 resume 不校验 cwd，硬切会造成「平台以为在 worktree、agent 在主仓库」。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], session_id="session-abc")
    monkeypatch.setattr(board.worktree, "create",
                        lambda p, cid: (_ for _ in ()).throw(AssertionError("不应创建")))

    card_dict, err = board.start_into_doing(proj, card, "", False, True)
    assert card_dict is None and "已有主会话" in err["error"]
    assert db.get_board_card(card["id"])["column_key"] == "todo"


def test_worktree_start_parent_dependency_blocked(tmp_path, monkeypatch):
    """worktree 只免排队、不免父依赖（与排队路径同口径）。"""
    proj = _mk_project(tmp_path)
    parent = _mk_card(proj["id"])                       # 父卡仍在 todo
    child = _mk_card(proj["id"], parent_card_id=parent["id"])
    monkeypatch.setattr(board.worktree, "create",
                        lambda p, cid: (_ for _ in ()).throw(AssertionError("不应创建")))
    card_dict, err = board.start_into_doing(proj, child, "", False, True)
    assert card_dict is None and err == {"blocked": "parent-not-done"}
    assert db.get_board_card(child["id"])["column_key"] == "todo"


def test_worktree_start_failure_keeps_marker_and_rolls_column(tmp_path, monkeypatch):
    """起会话失败：回原列 + 透出错误；worktree 标记保留（重按开始即复用，不留无主工作树）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"])
    wt = str(tmp_path / "wts" / "card_fail")
    monkeypatch.setattr(board.worktree, "create", lambda p, cid: (wt, "ts/card-1", ""))

    def _boom(project, c, extra=""):
        raise RuntimeError("会话启动失败: 驱动不可用")
    monkeypatch.setattr(board, "start_card", _boom)

    card_dict, err = board.start_into_doing(proj, card, "", False, True)
    assert card_dict is None and "会话启动失败" in err["error"]
    cur = db.get_board_card(card["id"])
    assert cur["column_key"] == "todo" and cur["worktree"] == wt
    assert waitq.get_active(waitq.KIND_CARD, card["id"]) is None


def test_worktree_create_error_returns_400_payload(tmp_path, monkeypatch):
    """worktree 创建失败（非 git 仓库等）：列不动、不建会话、错误原样透出。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"])
    monkeypatch.setattr(board.worktree, "create",
                        lambda p, cid: ("", "", "无法创建 worktree：项目目录不是 git 仓库"))
    monkeypatch.setattr(board, "start_card",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("不应起会话")))
    card_dict, err = board.start_into_doing(proj, card, "", False, True)
    assert card_dict is None and "不是 git 仓库" in err["error"]
    assert db.get_board_card(card["id"])["column_key"] == "todo"


def test_recover_skips_worktree_card_row_rebuild(tmp_path, monkeypatch):
    """recover 对在管的 worktree 卡**不补建 c: 行**（否则重启后凭空占回运行位），
    普通在管卡照旧 card_started 补行。"""
    proj = _mk_project(tmp_path)
    wt_card = _mk_card(proj["id"], column_key="doing", worktree="/tmp/wt-recover")
    plain = _mk_card(proj["id"], column_key="doing")

    def _fake_recover_web(p, r):
        board._RUNS[r["id"]] = {"proc": None, "sid": "s-%d" % r["id"],
                                "family": "dsh_plugin", "project_dir": "/x",
                                "started_at": 0, "seen_busy": True, "aborted": False,
                                "turn_baseline": None, "log_path": "/tmp/l"}
    monkeypatch.setattr(board, "_recover_web_card", _fake_recover_web)
    monkeypatch.setattr(board, "_recover_ext_rows", lambda queued: False)
    started = []

    class _FakeRunner:
        def card_started(self, cid, pid, ext=None):
            started.append(cid)
            return True
        def notify_busy_change(self):
            pass
        def submit_card(self, cid, **kw):
            pass
    monkeypatch.setattr(board.runner, "INSTANCE", _FakeRunner())

    board.recover()
    assert wt_card["id"] not in started        # worktree 卡不补行
    assert plain["id"] in started              # 普通卡照旧


def test_card_json_exposes_worktree(tmp_path):
    """card_json 下发 worktree 字段（前端 🌿 徽标/详情行的数据源）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], worktree="/tmp/wt-json")
    d = board.card_json(db.get_board_card(card["id"]))
    assert d["worktree"] == "/tmp/wt-json"
    plain = board.card_json(db.get_board_card(_mk_card(proj["id"])["id"]))
    assert plain["worktree"] == ""             # 普通卡空串（不引入 None 分歧）


def test_cleanup_card_worktree_clears_marker(tmp_path, monkeypatch):
    """清理成功即清卡片 worktree 标记（该卡回到普通模式）；运行中由 server 409 拦。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], worktree="/tmp/wt-clean")
    monkeypatch.setattr(board.worktree, "remove", lambda p, c: (True, ""))
    ok, err = board.cleanup_card_worktree(proj, db.get_board_card(card["id"]))
    assert ok and err == ""
    assert db.get_board_card(card["id"])["worktree"] == ""


def test_worktree_preview_gates(tmp_path, monkeypatch):
    """预览：普通 todo 卡 supported；已有会话的卡 supported=False（中文原因）；
    非 git 仓库透传 worktree.preview 的错误。"""
    proj = _mk_project(tmp_path)
    plain = _mk_card(proj["id"])
    monkeypatch.setattr(board.worktree, "preview",
                        lambda p, cid: {"ok": True, "error": "",
                                        "path": "/tmp/wt-pv", "branch": "ts/card-%d" % cid,
                                        "exists": False, "root": "/tmp"})
    pv = board.worktree_preview(proj, plain)
    assert pv["supported"] is True and pv["path"] == "/tmp/wt-pv"
    assert pv["branch"] == "ts/card-%d" % plain["id"]

    with_sess = _mk_card(proj["id"], session_id="session-x")
    pv2 = board.worktree_preview(proj, db.get_board_card(with_sess["id"]))
    assert pv2["supported"] is False and "已有主会话" in pv2["reason"]

    marked = _mk_card(proj["id"], worktree="/tmp/wt-marked")
    pv3 = board.worktree_preview(proj, db.get_board_card(marked["id"]))
    assert pv3["supported"] is False and pv3["path"] == "/tmp/wt-marked"


def test_migrate_adds_worktree_column_for_old_db(tmp_path, monkeypatch):
    """老库兼容：不带 worktree 列的 board_cards 由 db.migrate() 幂等补列
    （读 `row['worktree']` 不再 IndexError）。"""
    monkeypatch.setattr(db, "DB_OVERRIDE", str(tmp_path / "old.db"))
    db.init_db()
    with db.connect() as conn:
        conn.execute("ALTER TABLE board_cards DROP COLUMN worktree")
    db.migrate()
    with db.connect() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(board_cards)")}
    assert "worktree" in cols
