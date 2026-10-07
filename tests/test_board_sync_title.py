# sync 卡标题/描述口径（2026-10-07）：取「主会话第一次用户提问」——首问原文的
# 首行进标题、其余行进描述（与手工建卡 QuickAdd「首行=标题、其余行=描述」同约定）。
# 本文件钉：建卡口径、首问晚到时的补齐、旧口径存量卡回填、用户手工改名/描述不被
# 覆盖、非主会话不参与、首行溢出并入描述、截断上限。
# 会话枚举一律打桩（不读真实 ~/.dsh/sessions），DB 走 conftest 的临时库。
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import board, db

SID = "session-aaaa1111-2222-3333-4444-555555555555"
SID2 = "session-bbbb1111-2222-3333-4444-555555555555"


def _mk_project(name="synctitle"):
    """真实项目行：dsh-plugin 前缀 = 唯一可跑族（sync_sessions 的族判定入口）。"""
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"{name}-{uid}", f"/tmp/{name}-{uid}",
                            "dsh-plugin:/usr/bin/dsh", f"/tmp/{name}-{uid}/work")
    return db.get_project(pid)


def _mk_card(pid, title="", description="", column="doing", sid="", origin="sync",
             sessions=None):
    """建卡（默认按 sync 卡形态：origin=sync + 主会话绑定）。"""
    cid = db.insert_board_card(pid, title, description)
    db.update_board_card(cid, column_key=column, session_id=sid, origin=origin,
                         sessions=json.dumps(sessions if sessions is not None
                                             else ([sid] if sid else [])))
    return cid


def _patch(monkeypatch, items):
    """打桩：会话枚举 + busy 判定 + 会话存在性（都不碰真实文件系统）。"""
    monkeypatch.setattr(board.sessparse, "list_sessions", lambda fam, d: items)
    monkeypatch.setattr(board.sessparse, "session_exists", lambda fam, s: True)
    monkeypatch.setattr(board, "_sync_session_busy", lambda *a, **k: False)


# ------------------------------------------------------------ 纯函数口径

def test_split_first_prompt_lines_and_caps():
    """首问切分：首行→标题、其余行→描述；首行超 SYNC_TITLE_MAX 的溢出并入描述开头
    （不丢内容）；描述超 SYNC_DESC_MAX 截断补省略号；空原文两者都空。"""
    assert board._split_first_prompt("") == ("", "")
    assert board._split_first_prompt("   \n  ") == ("", "")
    assert board._split_first_prompt("单行提问") == ("单行提问", "")
    assert board._split_first_prompt("首行\n第二行\n第三行") == ("首行", "第二行\n第三行")
    long_first = "甲" * (board.SYNC_TITLE_MAX + 30)
    title, desc = board._split_first_prompt(long_first + "\n尾行")
    assert title == "甲" * board.SYNC_TITLE_MAX
    assert desc == "甲" * 30 + "\n尾行"
    _, desc = board._split_first_prompt("标题\n" + "乙" * (board.SYNC_DESC_MAX + 10))
    assert desc.endswith("…") and len(desc) == board.SYNC_DESC_MAX + 1


# ------------------------------------------------------------ 建卡口径

def test_new_card_takes_first_prompt_lines(monkeypatch):
    """新建 sync 卡：标题 = 首问首行、描述 = 其余行（不再用会话号/会话标题）。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "dsh 生成的标题", "mtime": 0,
                          "first_prompt": "帮我看下这个报错\n栈信息在下面\n第三行"}])
    created = board.sync_sessions(proj)
    assert len(created) == 1
    c = db.get_board_card(created[0])
    assert c["title"] == "帮我看下这个报错"
    assert c["description"] == "栈信息在下面\n第三行"
    assert c["origin"] == "sync" and c["session_id"] == SID


def test_new_card_without_prompt_falls_back_then_backfills(monkeypatch):
    """建卡时首问还没落盘（会话目录先建、提问后到的真实竞态）：先落 sid 短码兜底，
    首问到达后的下一拍补齐标题与描述。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "", "mtime": 0, "first_prompt": ""}])
    created = board.sync_sessions(proj)
    assert len(created) == 1
    cid = created[0]
    assert db.get_board_card(cid)["title"] == SID[:12]        # 兜底，非会话号需求
    _patch(monkeypatch, [{"sid": SID, "title": "", "mtime": 0,
                          "first_prompt": "真实首问\n其余内容"}])
    assert board.sync_sessions(proj) == []                     # 不重复建卡
    c = db.get_board_card(cid)
    assert c["title"] == "真实首问" and c["description"] == "其余内容"


# ------------------------------------------------------------ 存量卡回填

def test_legacy_card_title_backfilled(monkeypatch):
    """旧口径存量卡（标题=旧代码写入的会话标题事件文本）在首个同步拍回填成首问首行。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="旧截断标题", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "旧截断标题", "mtime": 0,
                          "first_prompt": "完整首问第一行\n细节行"}])
    board.sync_sessions(proj)
    c = db.get_board_card(cid)
    assert c["title"] == "完整首问第一行" and c["description"] == "细节行"


def test_manual_rename_and_description_not_overwritten(monkeypatch):
    """用户手工改过卡名（不属任何自动写入形态）⇒ 标题与描述都不再自动覆盖；
    描述非空（用户写的）⇒ 只补标题、不动描述。"""
    proj = _mk_project()
    renamed = _mk_card(proj["id"], title="我改的名字", sid=SID)
    kept = _mk_card(proj["id"], title=SID2[:12], description="用户写的描述", sid=SID2)
    _patch(monkeypatch, [
        {"sid": SID, "title": "会话标题", "mtime": 0, "first_prompt": "首行\n其余"},
        {"sid": SID2, "title": "会话标题", "mtime": 0, "first_prompt": "首行\n其余"},
    ])
    board.sync_sessions(proj)
    assert db.get_board_card(renamed)["title"] == "我改的名字"
    assert db.get_board_card(renamed)["description"] == ""
    c = db.get_board_card(kept)
    assert c["title"] == "首行" and c["description"] == "用户写的描述"


def test_non_main_session_does_not_drive_title(monkeypatch):
    """只有主会话的首问驱动卡面：卡片 sessions 并集里的子会话（fork 出的）不参与
    （对齐需求「主会话的第一次用户提问」）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="旧截断标题", sid=SID, sessions=[SID, SID2])
    _patch(monkeypatch, [{"sid": SID2, "title": "子会话标题", "mtime": 0,
                          "first_prompt": "子会话首问\n其余"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["title"] == "旧截断标题"


def test_follow_is_idempotent(monkeypatch):
    """补齐是幂等的：第二拍不再产生写（标题已是首问首行、描述已填）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title=SID[:12], sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "", "mtime": 0,
                          "first_prompt": "首行\n其余"}])
    board.sync_sessions(proj)
    first = db.get_board_card(cid)
    board.sync_sessions(proj)
    second = db.get_board_card(cid)
    assert first == second


def test_single_line_prompt_leaves_description_empty(monkeypatch):
    """单行首问：描述保持空（不写占位内容）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title=SID[:12], sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "", "mtime": 0,
                          "first_prompt": "只有一行的首问"}])
    board.sync_sessions(proj)
    c = db.get_board_card(cid)
    assert c["title"] == "只有一行的首问" and c["description"] == ""


def test_platform_card_untouched(monkeypatch):
    """非 sync 卡（人工卡 / 平台任务卡）一律不动标题——本口径只服务 sync 卡。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="人工卡标题", sid=SID, origin="")
    _patch(monkeypatch, [{"sid": SID, "title": "会话标题", "mtime": 0,
                          "first_prompt": "首行\n其余"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["title"] == "人工卡标题"


def test_list_sessions_item_without_first_prompt_key(monkeypatch):
    """防回归：list_sessions 桩不带 first_prompt 键时（旧测试桩形态）不炸，
    按旧口径回落会话标题。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "会话标题", "mtime": 0}])
    created = board.sync_sessions(proj)
    assert len(created) == 1
    assert db.get_board_card(created[0])["title"] == "会话标题"
