# sync 卡标题/描述口径（2026-10-10 改）：标题 = **DSH 当前会话标题**（最后一枚
# session/title 事件，与 dsh GUI 侧栏 last-wins 一致）、描述 = 主会话第一次用户
# 提问**全文**。本文件钉：建卡口径、DSH 标题自动更新（LLM 标题落盘）后的同步、
# 旧口径存量卡回填、用户手工改名/描述不被覆盖、非主会话不参与、回落链
# （无标题事件→首问首行→sid 短码）、截断上限、幂等。
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

def test_new_card_takes_session_title_and_full_prompt(monkeypatch):
    """新建 sync 卡：标题 = DSH 当前会话标题（末枚 session/title 事件）、
    描述 = 首问全文（含首行；不再按「首行=标题」切分）。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "dsh 生成的标题", "mtime": 0,
                          "titles": ["【任务描述】帮我看下这个", "dsh 生成的标题"],
                          "first_prompt": "帮我看下这个报错\n栈信息在下面\n第三行"}])
    created = board.sync_sessions(proj)
    assert len(created) == 1
    c = db.get_board_card(created[0])
    assert c["title"] == "dsh 生成的标题"
    assert c["description"] == "帮我看下这个报错\n栈信息在下面\n第三行"
    assert c["origin"] == "sync" and c["session_id"] == SID


def test_new_card_falls_back_to_prompt_first_line_without_title(monkeypatch):
    """回落链一档：会话还没有任何标题事件（dsh 标题未落盘）时取首问首行；
    标题事件落盘后由同步拍改写成 DSH 标题（见标题更新用例）。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "", "titles": [], "mtime": 0,
                          "first_prompt": "首行提问\n细节行"}])
    created = board.sync_sessions(proj)
    c = db.get_board_card(created[0])
    assert c["title"] == "首行提问" and c["description"] == "首行提问\n细节行"


def test_session_title_update_propagates_to_card(monkeypatch):
    """**本需求的钉子**：DSH 侧标题自动更新（兜底截断句 → LLM 标题）后，
    TS 卡标题跟着更新（不再停在旧标题）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="【任务描述】DSH侧会话标题自", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "DSH会话标题自动更新到TS侧",
                          "titles": ["【任务描述】DSH侧会话标题自",
                                     "DSH会话标题自动更新到TS侧"],
                          "mtime": 0,
                          "first_prompt": "【任务描述】DSH侧会话标题自动更新的时候\n其余"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["title"] == "DSH会话标题自动更新到TS侧"


def test_card_created_before_llm_title_is_updated(monkeypatch):
    """建卡窗口：建卡时只有兜底标题（卡标题=旧的首枚标题事件），之后 LLM 标题
    才追加进事件流 —— 卡面标题仍属自动写入形态（命中标题事件历史）⇒ 更新。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="【任务描述】帮我看下这个", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "报错排查", "mtime": 0,
                          "titles": ["【任务描述】帮我看下这个", "报错排查"],
                          "first_prompt": "帮我看下这个报错"}])
    board.sync_sessions(proj)
    c = db.get_board_card(cid)
    assert c["title"] == "报错排查" and c["description"] == "帮我看下这个报错"


def test_empty_session_not_projected_until_first_prompt(monkeypatch):
    """A 类闸（2026-10-09）：会话一个字都还没有（首问/标题皆空）⇒ **不建卡**。

    取代旧口径「先落 sid 短码兜底、首问到了再补齐」——看板不再出现
    `session-xxxx` 占位卡；首问落盘后的下一个节拍才建卡，标题口径直接正确。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "", "titles": [], "mtime": 0,
                          "first_prompt": ""}])
    assert board.sync_sessions(proj) == []                     # 空会话不投影
    _patch(monkeypatch, [{"sid": SID, "title": "", "titles": [], "mtime": 0,
                          "first_prompt": "真实首问\n其余内容"}])
    created = board.sync_sessions(proj)                        # 首问落盘 → 建卡
    assert len(created) == 1
    c = db.get_board_card(created[0])
    assert c["title"] == "真实首问" and c["description"] == "真实首问\n其余内容"
    assert c["session_id"] == SID and c["origin"] == "sync"
    assert board.sync_sessions(proj) == []                     # 不重复建卡


def test_title_only_session_still_projected(monkeypatch):
    """A 类闸的边界：只有会话标题事件、首问未落盘（dsh 自动标题已生成）时照建——
    标题取会话标题、描述留空，回落链保留（首问后到仍由 `_sync_card_follow` 补齐）。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "dsh 生成的标题",
                          "titles": ["dsh 生成的标题"], "mtime": 0,
                          "first_prompt": ""}])
    created = board.sync_sessions(proj)
    assert len(created) == 1
    c = db.get_board_card(created[0])
    assert c["title"] == "dsh 生成的标题" and c["description"] == ""


def test_platform_owned_task_session_not_projected(monkeypatch):
    """B 类闸（2026-10-09）：平台自己的任务会话（`tasks.session_id`）不再被当成
    「外部直跑会话」重复投影成卡——实测 gtrade 项目 7 张压测/任务会话卡即此，
    任务侧本就有入口（任务详情/日志）。"""
    proj = _mk_project()
    tid = db.insert_task(proj["id"], "压测任务", 0, "不复测", "rounds", "1")
    db.update_task(tid, session_id=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "", "mtime": 0,
                          "first_prompt": "压测任务（第 1 步/共 2 步）：\n细节"}])
    assert board.sync_sessions(proj) == []


def test_feishu_bound_session_not_projected(monkeypatch):
    """B 类闸的另一来源：飞书通用对话当前绑定的会话（`feishu_bindings.cur_sid`）
    在飞书侧已有入口，同样不重复投影。"""
    proj = _mk_project()
    db.set_feishu_binding("ou_sync_test", 0, proj["id"])
    db.set_feishu_cur_session("ou_sync_test", proj["id"], SID)
    _patch(monkeypatch, [{"sid": SID, "title": "", "mtime": 0,
                          "first_prompt": "飞书里说的话\n其余"}])
    assert board.sync_sessions(proj) == []


def test_misbuilt_cards_swept_once(monkeypatch):
    """存量误建卡收口（2026-10-09）：**占位形态**（标题=空 或 sid 短码）的平台自持
    会话卡与空会话卡按「每项目一轮 + 软删可还原」口径收进回收站；用户在回收站
    **还原**后同一进程内不再被反复软删（尊重显式操作，口径同子代理卡收口）。"""
    proj = _mk_project()
    pid = proj["id"]
    tid = db.insert_task(pid, "压测任务", 0, "不复测", "rounds", "1")
    db.update_task(tid, session_id=SID)                        # 平台自持会话
    owned_card = _mk_card(pid, title=SID[:12], sid=SID)        # B 类（sid 命中 tasks）
    empty_card = _mk_card(pid, title=SID2[:12], sid=SID2)      # A 类（空会话）
    _patch(monkeypatch, [
        {"sid": SID, "title": "任务首问", "mtime": 0, "first_prompt": "任务首问\n其余"},
        {"sid": SID2, "title": "", "mtime": 0, "first_prompt": ""},
    ])
    board.sync_sessions(proj)
    assert db.get_board_card(owned_card)["trashed"] == 1
    assert db.get_board_card(empty_card)["trashed"] == 1
    db.restore_board_card(empty_card)                          # 用户显式还原
    board.sync_sessions(proj)
    assert db.get_board_card(empty_card)["trashed"] == 0


def test_sweep_never_touches_real_titled_cards(monkeypatch):
    """**误删回归钉子**（2026-10-09 真机实障）：判据输入被污染（会话枚举把有内容的
    会话读成空壳 ⇒ A 类"成立"）时，**卡面已有真实标题**的卡也不得被收口——卡面
    标题是卡自身的证据。首版缺这道硬闸，真机首跑在三个项目误删 13 张真实卡
    （918「现在TS作为DSH的插件…」、697/709 等，事后复算判据全不成立）。"""
    proj = _mk_project()
    pid = proj["id"]
    keep = _mk_card(pid, title="现在TS作为DSH的插件, UI风格应与DSH一致.", sid=SID)
    placeholder = _mk_card(pid, title=SID2[:12], sid=SID2)
    _patch(monkeypatch, [                                      # 两条输入都被污染
        {"sid": SID, "title": "", "mtime": 0, "first_prompt": ""},
        {"sid": SID2, "title": "", "mtime": 0, "first_prompt": ""},
    ])
    board.sync_sessions(proj)
    assert db.get_board_card(keep)["trashed"] == 0             # 真实标题 ⇒ 永不自动收口
    assert db.get_board_card(placeholder)["trashed"] == 1       # 占位卡照收


def test_sweep_never_touches_real_titled_task_cards(monkeypatch):
    """同一道硬闸对 B 类同样生效：sid 命中 tasks/飞书登记、但卡面已是真实标题
    （如任务提示词首行）时不自动收口——**宁漏不误删**，漏下的交用户自己删。"""
    proj = _mk_project()
    tid = db.insert_task(proj["id"], "压测任务", 0, "不复测", "rounds", "1")
    db.update_task(tid, session_id=SID)
    keep = _mk_card(proj["id"], title="压测任务（第 1 步/共 2 步）：", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "任务首问", "mtime": 0,
                          "first_prompt": "压测任务（第 1 步/共 2 步）：\n细节"}])
    board.sync_sessions(proj)
    assert db.get_board_card(keep)["trashed"] == 0


# ------------------------------------------------------------ 存量卡回填

def test_legacy_card_title_backfilled(monkeypatch):
    """旧口径存量卡（标题=旧代码写入的标题事件文本 / 首问首行）在首个同步拍回填成
    「DSH 当前标题 + 首问全文」——标题命中标题事件历史即视为自动写入形态。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="旧截断标题", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "新标题", "mtime": 0,
                          "titles": ["旧截断标题", "新标题"],
                          "first_prompt": "完整首问第一行\n细节行"}])
    board.sync_sessions(proj)
    c = db.get_board_card(cid)
    assert c["title"] == "新标题"
    assert c["description"] == "完整首问第一行\n细节行"


def test_legacy_prompt_line_title_backfilled(monkeypatch):
    """旧口径存量卡的另一形态：标题=首问首行（§48 口径，2026-10-07~10-10 写入）
    同样被回填成 DSH 当前标题（自动形态含首问首行）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="完整首问第一行", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "LLM 标题", "mtime": 0,
                          "titles": ["完整首问第一行", "LLM 标题"],
                          "first_prompt": "完整首问第一行\n细节行"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["title"] == "LLM 标题"


def test_legacy_description_migrated_to_full_prompt(monkeypatch):
    """旧口径描述（首问除首行）在同步拍被刷成首问全文；已等于全文时不再写（幂等）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="LLM 标题", description="细节行", sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "LLM 标题", "mtime": 0,
                          "titles": ["LLM 标题"],
                          "first_prompt": "完整首问第一行\n细节行"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["description"] == "完整首问第一行\n细节行"
    board.sync_sessions(proj)                                  # 第二拍不产生写
    first = db.get_board_card(cid)
    board.sync_sessions(proj)
    assert first == db.get_board_card(cid)


def test_manual_rename_and_description_not_overwritten(monkeypatch):
    """用户手工改过卡名（不属任何自动写入形态）⇒ 标题与描述都不再自动覆盖；
    描述非空（用户写的）⇒ 只补标题、不动描述。"""
    proj = _mk_project()
    renamed = _mk_card(proj["id"], title="我改的名字", sid=SID)
    kept = _mk_card(proj["id"], title=SID2[:12], description="用户写的描述", sid=SID2)
    _patch(monkeypatch, [
        {"sid": SID, "title": "会话标题", "titles": ["会话标题"], "mtime": 0,
         "first_prompt": "首行\n其余"},
        {"sid": SID2, "title": "会话标题", "titles": ["会话标题"], "mtime": 0,
         "first_prompt": "首行\n其余"},
    ])
    board.sync_sessions(proj)
    assert db.get_board_card(renamed)["title"] == "我改的名字"
    assert db.get_board_card(renamed)["description"] == ""
    c = db.get_board_card(kept)
    assert c["title"] == "会话标题" and c["description"] == "用户写的描述"


def test_non_main_session_does_not_drive_title(monkeypatch):
    """只有主会话驱动卡面：卡片 sessions 并集里的子会话（fork 出的）不参与。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="旧截断标题", sid=SID, sessions=[SID, SID2])
    _patch(monkeypatch, [{"sid": SID2, "title": "子会话标题", "titles": ["子会话标题"],
                          "mtime": 0, "first_prompt": "子会话首问\n其余"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["title"] == "旧截断标题"


def test_follow_is_idempotent(monkeypatch):
    """补齐是幂等的：第二拍不再产生写（标题已是 DSH 标题、描述已是首问全文）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title=SID[:12], sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "会话标题", "titles": ["会话标题"],
                          "mtime": 0, "first_prompt": "首行\n其余"}])
    board.sync_sessions(proj)
    first = db.get_board_card(cid)
    assert first["title"] == "会话标题" and first["description"] == "首行\n其余"
    board.sync_sessions(proj)
    second = db.get_board_card(cid)
    assert first == second


def test_single_line_prompt_description_is_whole_prompt(monkeypatch):
    """单行首问：描述 = 该行全文（不再留空——描述口径是「首问全文」）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title=SID[:12], sid=SID)
    _patch(monkeypatch, [{"sid": SID, "title": "单行标题", "titles": ["单行标题"],
                          "mtime": 0, "first_prompt": "只有一行的首问"}])
    board.sync_sessions(proj)
    c = db.get_board_card(cid)
    assert c["title"] == "单行标题" and c["description"] == "只有一行的首问"


def test_platform_card_untouched(monkeypatch):
    """非 sync 卡（人工卡 / 平台任务卡）一律不动标题——本口径只服务 sync 卡。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="人工卡标题", sid=SID, origin="")
    _patch(monkeypatch, [{"sid": SID, "title": "会话标题", "titles": ["会话标题"],
                          "mtime": 0, "first_prompt": "首行\n其余"}])
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["title"] == "人工卡标题"


def test_list_sessions_item_without_prompt_and_titles_keys(monkeypatch):
    """防回归：list_sessions 桩缺 first_prompt / titles 键时（旧测试桩形态）不炸——
    标题取会话标题、描述不写。"""
    proj = _mk_project()
    _patch(monkeypatch, [{"sid": SID, "title": "会话标题", "mtime": 0}])
    created = board.sync_sessions(proj)
    assert len(created) == 1
    c = db.get_board_card(created[0])
    assert c["title"] == "会话标题" and c["description"] == ""


# -------------------------------------------------- 存量子代理卡收口（2026-10-07）

# 真机子代理会话样本（卡 872/873 绑定的两个只读子代理会话，裸 uuid 目录名）
SUB_SID = "27f8d546-b8b9-4b70-bf5d-0d401aeadbe4"


def test_sync_trashes_legacy_subagent_card(monkeypatch):
    """存量子代理卡收口：历史版本按子代理会话建过卡（实测 72 张、70 张永留「待审核」
    ——子代理不会被归档、存储也不会被删，归档与「存储被删→done」两条规则都够不着），
    新口径的枚举已过滤子代理会话（不再建新卡），存量卡由本拍**软删进回收站**
    （可还原；不删会话文件、列与位置保留）。范围只限 origin='sync' 自动卡：用户
    自建卡即便绑了子代理会话也不碰；已在「已完成」的子代理卡同样收口。"""
    proj = _mk_project()
    review = _mk_card(proj["id"], title="你是只读调研员", column="review", sid=SUB_SID)
    done = _mk_card(proj["id"], title="已完成的子代理卡", column="done", sid=SUB_SID)
    manual = _mk_card(proj["id"], title="手工卡", column="review", sid=SUB_SID, origin="")
    _patch(monkeypatch, [])                 # 枚举已过滤子代理会话：items 里没有它
    monkeypatch.setattr(board.sessparse, "is_subagent", lambda fam, s: s == SUB_SID)
    board.sync_sessions(proj)
    assert db.get_board_card(review)["trashed"] == 1
    assert db.get_board_card(review)["column_key"] == "review"   # 软删：原位待还原
    assert db.get_board_card(done)["trashed"] == 1
    assert db.get_board_card(manual)["trashed"] == 0             # 用户自建卡不碰


MAIN_SID = "session-cccc1111-2222-3333-4444-555555555555"


def _mk_session_file(cwd, sid, origin="", title="会话标题"):
    """真实 dsh 会话存储样本（多帧 zstd，每帧 JSONL 多行）：头行 + 标题帧。
    子代理样本带 origin/delegationDepth/parentSession（真机会话头三件套）。"""
    import zstandard
    header = {"type": "session", "version": 4, "id": sid, "cwd": cwd}
    if origin:
        header["origin"] = origin
        header["delegationDepth"] = 1
        header["parentSession"] = MAIN_SID
    frames = [[header], [{"type": "session/title", "seq": 1, "time": 1,
                          "data": {"title": title}}]]
    path = os.path.join(board.sessparse.dsh_bucket(cwd), sid, "session.v4.jsonl.zstd")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    comp = zstandard.ZstdCompressor()
    blob = b"".join(
        comp.compress("".join(json.dumps(r, ensure_ascii=False) + "\n"
                              for r in frame).encode("utf-8"))
        for frame in frames)
    with open(path, "wb") as f:
        f.write(blob)
    return path


def test_sync_sessions_skips_subagent_storage(monkeypatch, tmp_path):
    """真实会话存储路径（不打桩）走完整链路：项目 bucket 里的子代理会话不建卡、
    主会话照常建卡——覆盖「会话头 origin → list_sessions 过滤 → sync_sessions 建卡」
    三段，防哪一段被单独改回去（单测的打桩桩面看不到这条缝）。"""
    import sessparse
    monkeypatch.setattr(sessparse, "DSH_SESSIONS", str(tmp_path / "dsh" / "sessions"))
    monkeypatch.setattr(sessparse, "_DSH_HEADER_CACHE", {})
    monkeypatch.setattr(sessparse, "_DSH_TITLE_CACHE", {})
    monkeypatch.setattr(sessparse, "_ARCHIVE_CACHE", {"key": None, "ids": frozenset()})
    proj = _mk_project()
    _mk_session_file(proj["project_dir"], MAIN_SID, origin="")
    _mk_session_file(proj["project_dir"], SUB_SID, origin="subagent")
    monkeypatch.setattr(board, "_sync_session_busy", lambda *a, **k: False)
    created = board.sync_sessions(proj)
    assert [db.get_board_card(c)["session_id"] for c in created] == [MAIN_SID]


def test_sync_subagent_sweep_respects_restore(monkeypatch):
    """收口每项目只跑一轮（A 之后不会再产生子代理卡）：用户把卡从回收站**还原**后，
    同一进程内不再被反复软删（尊重显式操作；进程重启后重跑一轮，幂等）。"""
    proj = _mk_project()
    cid = _mk_card(proj["id"], title="子代理卡", column="review", sid=SUB_SID)
    _patch(monkeypatch, [])
    monkeypatch.setattr(board.sessparse, "is_subagent", lambda fam, s: s == SUB_SID)
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["trashed"] == 1
    db.restore_board_card(cid)               # 用户显式还原
    board.sync_sessions(proj)
    assert db.get_board_card(cid)["trashed"] == 0
