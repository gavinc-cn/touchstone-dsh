# 「通过」时的 worktree 合并交接单测（2026-10-07 批次）：
# ① move 的待合并闸——有提交 ⇒ {"merge_pending"} 且列不动；merge_ack / 无提交 /
#    非 worktree 卡 / 工作树读不到 ⇒ 照旧直接进「已完成」；
# ② handoff——平台只投递不执行：worktree 卡走统一队列（c: 行 + doing/queue 占位，
#    meta.extra 带合并指令）、无主会话或无待合并提交报 400；
# ③ 指令原文直发（不套打回意见的「【修改意见】…继续完善」壳）＋ 该轮会话仍在
#    工作树里跑（cwd=worktree 路径，合并命令上下文正确）。
# 设计：doc_ai/plan/202610/20261007_1620_看板通过时worktree改动回流（交给agent合并）.md
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board
import db
import waitq


def _mk_project(tmp_path):
    """造一个绑定 dsh 插件族的项目行（agent_path 用 dsh-plugin 前缀，族判定即通过）。"""
    name = "wtm_" + uuid.uuid4().hex[:10]
    repo = tmp_path / name / "repo"
    work = tmp_path / name / "work"
    repo.mkdir(parents=True)
    work.mkdir(parents=True)
    pid = db.insert_project(1, name, str(repo), "dsh-plugin:/usr/bin/dsh", str(work))
    return db.get_project(pid)


def _mk_card(project_id, **fields):
    cid = db.insert_board_card(project_id, "wt 合并卡")
    if fields:
        db.update_board_card(cid, **fields)
    return db.get_board_card(cid)


def _stub_status(monkeypatch, calls=None, **over):
    """打桩 worktree.merge_status（不碰真 git），返回该桩下发的判定 dict。"""
    st = {"ok": True, "error": "", "path": "/tmp/wt/card_x", "branch": "ts/card-x",
          "target": "master", "exists": True, "branch_exists": True,
          "dirty": False, "dirty_count": 0, "ahead": 2, "behind": 0}
    st.update(over)

    def _fake(project, card):
        if calls is not None:
            calls.append(card["id"])
        return dict(st)

    monkeypatch.setattr(board.worktree, "merge_status", _fake)
    return st


class _FakeRunner:
    """假 runner 单例：submit_card 照真实接线写 waitq 行+占位（不起 worker 线程）。

    真接线见 runner.Runner.submit_card——after_prefix=True 走
    `waitq.insert_card_after_prefix`（review 卡插等待区最前），单事务写行 + 占位。
    """

    def __init__(self):
        self.calls = []

    def submit_card(self, card_id, extra="", from_column="", after_prefix=False):
        # 与 runner.Runner.submit_card 同款：from_column 缺省取**此刻**卡片所在列
        # （占位写之前读，即续跑前的原列）
        card = db.get_board_card(card_id)
        from_col = from_column or card["column_key"]
        self.calls.append({"card_id": card_id, "extra": extra,
                           "from_column": from_col, "after_prefix": after_prefix})
        waitq.insert_card_after_prefix(card_id, card["project_id"], extra=extra,
                                       from_column=from_col)

    def notify_busy_change(self):
        pass

    def remove_answer(self, card_id):
        pass


# ---------- ① move 的待合并闸 ----------


def test_move_to_done_returns_merge_pending(tmp_path, monkeypatch):
    """worktree 卡有待合并提交：move 到 done 回 {"merge_pending": {...}} 且**列不动**
    （与父任务拦截同款「HTTP 200 + 结构化 payload」协议，前端弹合并交接框）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review", worktree="/tmp/wt/card_x")
    _stub_status(monkeypatch, ahead=3, behind=1, dirty=True, dirty_count=2,
                 branch="ts/card-%d" % card["id"])
    card_dict, err = board.move_card(proj, card["id"], "done")
    assert card_dict is None and err is not None
    pend = err["merge_pending"]
    assert pend["ahead"] == 3 and pend["behind"] == 1 and pend["target"] == "master"
    assert pend["branch"] == "ts/card-%d" % card["id"]
    assert pend["dirty"] is True and pend["dirty_count"] == 2 and pend["path"]
    assert db.get_board_card(card["id"])["column_key"] == "review"      # 列未变


def test_move_done_merge_ack_skips_gate(tmp_path, monkeypatch):
    """「仅通过（不合并）」：前端带 merge_ack=true 再来一次 ⇒ 跳过闸、正常进已完成
    （分支与工作树保留，平台不碰 git）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review", worktree="/tmp/wt/card_x")
    calls = []
    _stub_status(monkeypatch, calls=calls, ahead=3)
    card_dict, err = board.move_card(proj, card["id"], "done", merge_ack=True)
    assert err is None and card_dict is not None
    assert card_dict["column"] == "done"
    assert db.get_board_card(card["id"])["column_key"] == "done"
    assert calls == []          # 带 ack 时连判定都不做（少一次 git 调用）


def test_move_done_without_pending_commits(tmp_path, monkeypatch):
    """没有待合并提交：照旧直接完成（用户 2026-10-07 约定：不打扰用户）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review", worktree="/tmp/wt/card_x")
    _stub_status(monkeypatch, ahead=0)
    card_dict, err = board.move_card(proj, card["id"], "done")
    assert err is None and card_dict["column"] == "done"


def test_move_done_plain_card_never_probes_git(tmp_path, monkeypatch):
    """普通卡（无 worktree 标记）：一个 git 判定都不做，行为与既有完全一致。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review")
    calls = []
    _stub_status(monkeypatch, calls=calls, ahead=5)
    card_dict, err = board.move_card(proj, card["id"], "done")
    assert err is None and card_dict["column"] == "done"
    assert calls == []


def test_move_done_broken_worktree_does_not_block(tmp_path, monkeypatch):
    """工作树读不到（用户手删了目录等）：不拦「通过」——回 None（无待合并）按普通卡完成。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review", worktree="/tmp/wt/gone")
    _stub_status(monkeypatch, ok=False, error="worktree 目录不存在")
    card_dict, err = board.move_card(proj, card["id"], "done")
    assert err is None and card_dict["column"] == "done"


# ---------- ② handoff：交给 agent 合并 ----------


def test_handoff_requires_main_session(tmp_path, monkeypatch):
    """无主会话：没上下文可投递，400 报错且不入队。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review", worktree="/tmp/wt/card_x")
    _stub_status(monkeypatch, ahead=1)
    monkeypatch.setattr(board.runner, "INSTANCE", _FakeRunner())
    card_dict, err = board.handoff_worktree_merge(proj, card)
    assert card_dict is None and "尚无主会话" in err["error"]
    assert waitq.get_active(waitq.KIND_CARD, card["id"]) is None


def test_handoff_rejects_without_pending_commits(tmp_path, monkeypatch):
    """没有待合并提交：不该走交接（前端此时也不会弹框，后端同样拒绝）。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], column_key="review", worktree="/tmp/wt/card_x",
                    session_id="sid-1")
    _stub_status(monkeypatch, ahead=0)
    card_dict, err = board.handoff_worktree_merge(proj, card)
    assert card_dict is None and "没有待合并" in err["error"]


def test_handoff_queues_card_with_merge_instruction(tmp_path, monkeypatch):
    """交接成功：卡片落「正在开发」列排队占位 + 落 c: 行（**走统一队列**，
    `after_prefix=True` 插等待区最前），meta.extra 就是合并指令原文——
    worktree 卡平时免排队，这条路径显式排队（合并要动主仓库工作区，必须串行）。"""
    proj = _mk_project(tmp_path)
    wt = str(tmp_path / "wts" / "card_y")
    card = _mk_card(proj["id"], column_key="review", worktree=wt, session_id="sid-1")
    _stub_status(monkeypatch, ahead=2, behind=1, dirty_count=1, path=wt,
                 branch="ts/card-%d" % card["id"])
    fake = _FakeRunner()
    monkeypatch.setattr(board.runner, "INSTANCE", fake)

    card_dict, err = board.handoff_worktree_merge(proj, card)
    assert err is None and card_dict is not None
    assert card_dict["column"] == "doing" and card_dict["worktree"] == wt
    assert fake.calls and fake.calls[0]["after_prefix"] is True
    assert fake.calls[0]["from_column"] == "review"
    assert fake.calls[0]["extra"].startswith(board.MERGE_TASK_MARK)
    # 行 + 占位（真 waitq 写口）：卡在开发列显示「排队中」，且 extra 随 meta 持久化
    row = waitq.get_active(waitq.KIND_CARD, card["id"])
    assert row is not None and row["state"] == waitq.WAITING
    meta = board.json.loads(row["meta"])
    assert meta["extra"] == fake.calls[0]["extra"]
    assert meta["from_column"] == "review"
    cur = db.get_board_card(card["id"])
    assert cur["column_key"] == "doing" and cur["block_kind"] == "queue"


def test_merge_instruction_content(tmp_path, monkeypatch):
    """指令内容：写清工作树与主仓库两个路径、主分支名、待合并数与未提交改动；
    「先同步主分支、再尽量 ff 回流、不能 ff 才 merge、冲突自己解、不要 push」。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], worktree="/tmp/wt/card_7")
    st = _stub_status(monkeypatch, ahead=2, behind=1, dirty_count=3,
                      path="/tmp/wt/card_7", branch="ts/card-7", target="master")
    text = board.build_merge_instruction(proj, card, st)
    assert text.startswith(board.MERGE_TASK_MARK)
    assert "ts/card-7" in text and "master" in text
    assert "/tmp/wt/card_7" in text and proj["project_dir"] in text
    assert "2 个" in text and "3 处未提交改动" in text
    assert "git stash" not in text                      # 不许把改动藏起来绕过提交
    assert "merge --ff-only" in text and "不要 push" in text
    assert "merge --abort" in text                      # 解不了必须回退，不留半合并态


def test_handoff_prompt_is_raw_instruction(tmp_path, monkeypatch):
    """合并指令原文直发（不套「【修改意见】…请按修改意见继续完善」）——
    那是打回改代码的壳，混进合并任务会让 agent 跑偏；打回意见本身的壳不变。"""
    proj = _mk_project(tmp_path)
    card = _mk_card(proj["id"], worktree="/tmp/wt/card_8")
    st = _stub_status(monkeypatch, path="/tmp/wt/card_8", branch="ts/card-8")
    instr = board.build_merge_instruction(proj, card, st)
    assert board.build_start_prompt(proj, card, instr, "sid-1") == instr
    plain = board.build_start_prompt(proj, card, "把按钮颜色改一下", "sid-1")
    assert plain.startswith("继续\n【修改意见】") and "继续完善" in plain


def test_dequeue_after_handoff_runs_in_worktree(tmp_path, monkeypatch):
    """队列轮到该卡时的起跑：extra（合并指令）从 meta 里取回透传给会话，
    且 cwd 仍是该卡的工作树——agent 的 git 上下文与「通过」时判定的是同一棵树。"""
    proj = _mk_project(tmp_path)
    wt = str(tmp_path / "wts" / "card_z")
    card = _mk_card(proj["id"], column_key="review", worktree=wt, session_id="sid-1")
    _stub_status(monkeypatch, ahead=1, path=wt, branch="ts/card-%d" % card["id"])
    fake = _FakeRunner()
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    card_dict, err = board.handoff_worktree_merge(proj, card)
    assert err is None and card_dict["column"] == "doing"

    calls = {}

    def _fake_start(project, card, extra=""):
        calls["extra"] = extra
        calls["cwd"] = board.card_workspace(project, card)
        return str(tmp_path / "fake.log")

    monkeypatch.setattr(board, "start_card", _fake_start)
    monkeypatch.setattr(board.runner, "append_log", lambda *a, **k: None)
    assert board.dequeue_start(proj, db.get_board_card(card["id"])) is True
    assert calls["extra"].startswith(board.MERGE_TASK_MARK)
    assert calls["cwd"] == wt                       # 会话仍跑在独立工作树里
    assert db.get_board_card(card["id"])["column_key"] == "doing"
