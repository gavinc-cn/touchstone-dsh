# 再进「正在开发」的续跑提示词：有可续接主会话 → 只发「继续」
# （2026-09-11 用户约定：从阻塞/待审核/已完成再进开发列不重发原任务）
# 2026-09-14 用户约定：全量首轮提示词不区分任务标题与描述——标题并入【任务描述】
# 2026-09-23 用户约定：全量首轮提示词去掉【约定】（提问/审批前先提交）段
# 2026-09-29 用户约定：全量首轮提示词去掉尾部「请完成上述开发任务。」
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board


def _card(**kw):
    base = {"id": 9101, "project_id": 9, "title": "标题", "description": "描述",
            "column_key": "blocked", "sort_order": 1, "session_id": "", "sessions": "[]",
            "block_kind": "manual", "block_text": "", "parent_card_id": None,
            "origin": "", "done_at": None, "trashed": 0, "trashed_at": None,
            "scheduled_at": None, "jira_key": "", "last_error": "", "last_error_at": None,
            "model": "", "created_at": 0, "updated_at": 0}
    base.update(kw)
    return base


PROJ = {"id": 9, "project_dir": "/repo", "work_dir": "/repo/.touchstone",
        "agent_path": "/usr/bin/kimi", "model": "", "skill_commit": ""}


def test_build_continue_prompt_bare():
    """无附加意见：裸「继续」，不含原任务标题/描述/首轮约定。"""
    p = board.build_continue_prompt()
    assert p == "继续"


def test_build_continue_prompt_keeps_opinion():
    """打回意见随行注入（否则用户修改要求会丢）。"""
    p = board.build_continue_prompt("第三列样式不对")
    assert p.startswith("继续")
    assert "【修改意见】第三列样式不对" in p
    assert "请按修改意见继续完善。" in p


def test_build_start_prompt_choices():
    """选择规则：有可续接主会话（sid 非空）→ 续跑；否则（首跑/无会话）→ 全量。"""
    proj = PROJ
    # 需求列 + 待开发列有会话（重开/回滚重试）：一律只发「继续」
    for col in ("blocked", "review", "done", "doing", "todo"):
        p = board.build_start_prompt(proj, _card(column_key=col, session_id="s-1"), "", "s-1")
        assert p == "继续", col
    # 无可续接会话（首跑；dsh 等不可 resume 族 sid 传空串）：全量
    p = board.build_start_prompt(proj, _card(column_key="blocked"), "", "")
    assert "【任务描述】标题\n\n描述" in p and "【约定】" not in p
    # 打回意见在续跑提示词里随行
    p = board.build_start_prompt(proj, _card(column_key="review", session_id="s-1"),
                                 "改标题", "s-1")
    assert p.startswith("继续") and "【修改意见】改标题" in p and "【任务描述】" not in p


def test_build_task_prompt_merges_title_into_description():
    """标题并入【任务描述】（2026-09-14 用户约定：发任务不区分标题与描述）。

    - 标题+描述：空行分隔同段，不再出现【任务标题】行
    - 空标题 / 卡面占位「未命名」：不参与拼接，只留描述
    - 仅标题：描述段即标题；首尾空白（描述常以换行开头）先 strip
    """
    p = board.build_task_prompt(PROJ, _card(title="标题", description="描述"))
    assert p.startswith("【任务描述】标题\n\n描述\n【工作目录】")
    assert "【任务标题】" not in p
    assert p.count("【任务描述】") == 1

    for t in ("", "未命名"):
        p = board.build_task_prompt(PROJ, _card(title=t, description="描述"))
        assert p.startswith("【任务描述】描述\n"), t
        assert "未命名" not in p, t

    p = board.build_task_prompt(PROJ, _card(title="标题", description=""))
    assert p.startswith("【任务描述】标题\n")

    p = board.build_task_prompt(PROJ, _card(title="标题", description="\n描述\n"))
    assert p.startswith("【任务描述】标题\n\n描述\n")   # 首尾空白 strip 后拼接

    p = board.build_task_prompt(PROJ, _card(title="", description=""))
    assert p.startswith("【任务描述】（无）\n")


def test_build_task_prompt_drops_commit_convention():
    """首轮提示词不再带【约定】（提问/审批前先提交本次会话改动）段。

    2026-09-23 用户约定：该段整段退场，与项目是否配置提交 skill（skill_commit）
    无关——提交契约不再由平台随首轮 prompt 下发给 agent。
    """
    for sk in ("", "commit-skill"):
        proj = dict(PROJ, skill_commit=sk)
        p = board.build_task_prompt(proj, _card())
        assert p.endswith("【工作目录】/repo"), sk
        assert "请完成上述开发任务。" not in p, sk
        for token in ("【约定】", "git push", "--AGENT--"):
            assert token not in p, (sk, token)
        # 附加段（打回意见）仍在尾随注入
        p = board.build_task_prompt(proj, _card(), extra="改标题")
        assert "【修改意见】改标题\n请按修改意见继续完善。" in p and "【约定】" not in p


def test_build_task_prompt_drops_tail_sentence():
    """首轮提示词不再带尾部的「请完成上述开发任务。」（2026-09-29 用户约定，卡 624）。

    首轮提示词到【工作目录】行收尾、不再补收束句；打回意见段的「请按修改意见
    继续完善。」是另一句，照旧保留（extra 段仍尾随注入）。
    """
    p = board.build_task_prompt(PROJ, _card())
    assert "请完成上述开发任务。" not in p
    assert p.endswith("【工作目录】/repo")

    p = board.build_task_prompt(PROJ, _card(), extra="改标题")
    assert "请完成上述开发任务。" not in p
    assert p.endswith("【修改意见】改标题\n请按修改意见继续完善。")


def _patch_dsh_env(monkeypatch, card, new_sid="new-sid"):
    """_start_web 的最小环境：假 dsh 驱动 + 日志/目录/库读写打桩。

    返回 calls（三个调用面记录）：create=[{cwd,task,model,provider}...] /
    resume=[(sid, kw)...] / sent=[(sid, text)...]——真实 prompt 文本只在 sent 里。
    """
    calls = {"create": [], "resume": [], "sent": []}

    def _create(cwd, task="", model="", provider=""):
        calls["create"].append({"cwd": cwd, "task": task,
                                "model": model, "provider": provider})
        return new_sid

    def _resume(sid, **kw):
        calls["resume"].append((sid, kw))
        return sid

    monkeypatch.setattr(board.dshdriver, "create_session", _create)
    monkeypatch.setattr(board.dshdriver, "resume_session", _resume)
    monkeypatch.setattr(board.chat, "dsh_send",
                        lambda sid, text, inject=False:
                        calls["sent"].append((sid, text)))
    monkeypatch.setattr(board, "_web_turn_baseline", lambda f, d, s: None)
    monkeypatch.setattr(board.lib, "ensure_runtime_dirs", lambda d: None)
    monkeypatch.setattr(board.lib, "runtime_dir", lambda *a: "/tmp/tf-test")
    monkeypatch.setattr(board.runner, "append_log", lambda *a, **k: None)
    monkeypatch.setattr(board.db, "update_board_card", lambda cid, **kw: None)
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: card)
    return calls


def test_start_web_resume_uses_continue(monkeypatch):
    """dsh 续接（待审核卡有主会话）：只发「继续」（不重发原任务），走 resume
    同一 sid——不新建会话。"""
    card = _card(id=9103, column_key="review", session_id="s-7")
    calls = _patch_dsh_env(monkeypatch, card)
    proj = dict(PROJ, agent_path="dsh-plugin:/usr/bin/dsh")
    try:
        board.start_card(proj, card)
        assert calls["create"] == []                   # 有可续会话：不新建
        assert calls["resume"] == [("s-7", {"cwd": "/repo", "task": "card-9103",
                                            "model": "", "provider": ""})]
        assert calls["sent"] == [("s-7", "继续")]
    finally:
        board._RUNS.pop(card["id"], None)


def test_start_web_new_session_full_prompt(monkeypatch):
    """dsh 无会话（阻塞列首跑）：建新会话并发全量首轮提示词（不 resume）。"""
    card = _card(id=9104, column_key="blocked", session_id="")
    calls = _patch_dsh_env(monkeypatch, card)
    proj = dict(PROJ, agent_path="dsh-plugin:/usr/bin/dsh")
    try:
        board.start_card(proj, card)
        assert calls["resume"] == []                   # 无可续会话：不 resume
        assert calls["create"] == [{"cwd": "/repo", "task": "card-9104",
                                    "model": "", "provider": ""}]
        assert len(calls["sent"]) == 1
        sid, text = calls["sent"][0]
        assert sid == "new-sid"
        assert "【任务描述】标题\n\n描述" in text and "【约定】" not in text
    finally:
        board._RUNS.pop(card["id"], None)
