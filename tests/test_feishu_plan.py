# 作答方案（M6）单测：卡内折叠摘要 + 完整方案飞书云文档。
#
# 背景（2026-10-10 用户报障）：飞书作答卡片上只有题面（question 截断 500）与选项，
# agent 的方案/回答（末条 assistant 文本，实测 0–3217 字）与思考（think，实测
# 122–18965 字）一个字都不发 ⇒ 用户"仅凭选项无法决策"。本批把方案送进飞书：
# 卡内折叠面板给摘要、完整方案建飞书云文档并把链接放卡上。
#
# 本文件全部不触网：sessparse.load 与 feishu._rest 都是桩。
import json

import pytest

import feishu
import sessparse


# ---------- 桩与工具 ----------

@pytest.fixture(autouse=True)
def _clean_plan_docs():
    """建文档去重表是进程内状态：逐用例清空，免用例间串味。"""
    feishu._PLAN_DOCS.clear()
    yield
    feishu._PLAN_DOCS.clear()


def _stub_session(monkeypatch, entries, found=True):
    """把 sessparse.load 换成固定 entries（feishu 内是函数内懒 import，
    打模块属性即可拦到）。"""
    monkeypatch.setattr(sessparse, "load",
                        lambda family, sid, agent, after=0: {
                            "found": found, "agents": [], "agent": agent,
                            "entries": entries, "total": len(entries),
                            "totals": {}})


def _entries(*items):
    """[("assistant", "文本") | ("think", "文本") | ("tool_call", "", "ask_user_question")]"""
    out = []
    for i, it in enumerate(items):
        e = {"seq": i, "kind": it[0], "text": it[1], "time": 0}
        if len(it) > 2:
            e["name"] = it[2]
        out.append(e)
    return out


def _stub_dm(monkeypatch, card=None, inter=None, cfg=True, binding=True):
    """`_dm_interaction_card` 的最低依赖面（不触网的桩），返回已发卡片列表。"""
    import db
    monkeypatch.setattr(feishu, "notify_events",
                        lambda pid: {"blocked_interaction"})
    monkeypatch.setattr(db, "get_project", lambda pid: {"id": pid, "name": "演示项目",
                                                        "user_id": 1})
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_feishu_binding_by_user",
                        lambda uid: ({"open_id": "ou_x", "user_id": uid}
                                     if binding else None))
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: ({"app_id": "cli_x", "app_secret": "sec"}
                                     if cfg else None))
    sent = []
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, c, cfg_: sent.append(c))
    return sent


def _plan_ctx(**over):
    ctx = {"card_id": 949, "title": "看板评论投递去前缀", "kind": "question",
           "qid": "call_1", "session_id": "session-abc",
           "question": "是否按此实施？", "options": ["A", "B"],
           "answerable": True, "questions_count": 1}
    ctx.update(over)
    return ctx


# ---------- ① 方案取数：会话转录 → assistant / think ----------

def test_session_texts_takes_texts_before_last_ask(monkeypatch):
    """取「最后一次 ask_user_question 之前」的末条 assistant 与末条 think：
    多轮提问时只取当前这次提问的上下文（更早的回答不算方案）。"""
    _stub_session(monkeypatch, _entries(
        ("user", "任务"), ("assistant", "第一轮的说明"), ("think", "第一轮思考"),
        ("tool_call", "", "ask_user_question"), ("tool_result", "答1"),
        ("assistant", "第二轮的方案"), ("think", "第二轮思考"),
        ("tool_call", "", "ask_user_question"), ("tool_result", "答2")))
    assert feishu._plan_session_texts("session-abc") == {
        "assistant": "第二轮的方案", "think": "第二轮思考"}


def test_session_texts_falls_back_to_tail_without_ask(monkeypatch):
    """转录里还没有该 tool_call（落盘滞后/旧会话）：回落整段末尾，语义相同。"""
    _stub_session(monkeypatch, _entries(
        ("user", "任务"), ("assistant", "方案"), ("think", "思考")))
    assert feishu._plan_session_texts("session-abc") == {
        "assistant": "方案", "think": "思考"}


def test_session_texts_empty_on_missing_or_error(monkeypatch):
    """无 sid / 会话不可读 / 解析异常 ⇒ 空文本，绝不抛（方案取数失败不影响发卡）。"""
    assert feishu._plan_session_texts("") == {"assistant": "", "think": ""}
    _stub_session(monkeypatch, [], found=False)
    assert feishu._plan_session_texts("session-abc") == {"assistant": "",
                                                         "think": ""}

    def _boom(*a, **k):
        raise OSError("坏文件")

    monkeypatch.setattr(sessparse, "load", _boom)
    assert feishu._plan_session_texts("session-abc") == {"assistant": "",
                                                         "think": ""}


# ---------- ② 卡内摘要 ----------

def test_inline_prefers_assistant(monkeypatch):
    """assistant 够长（≥ _PLAN_THINK_MIN）：只给回答，不掺思考。"""
    md = feishu._plan_inline_markdown(_plan_ctx(), {
        "assistant": "方案：改 board.py 的 deliver_comment。" * 20, "think": "内心戏"})
    assert "方案：改 board.py" in md and "内心戏" not in md


def test_inline_falls_back_to_think_when_assistant_short():
    """assistant 过短（实测常见：只有一句"我给一份方案"）⇒ 补 think 摘录，
    否则卡上等于没有方案（卡 949 就是这形态：assistant=100 字、think=3513 字）。"""
    md = feishu._plan_inline_markdown(_plan_ctx(), {
        "assistant": "我给一份简短方案，你确认后再动手。",
        "think": "现状取证：前缀唯一构造点在 board.py:2029 ……"})
    assert "我给一份简短方案" in md and "现状取证" in md


def test_inline_capped_and_empty_when_no_plan():
    """超上限截断并提示看文档；完全没方案时返回空串（调用方据此不挂面板）。"""
    md = feishu._plan_inline_markdown(_plan_ctx(), {"assistant": "字" * 5000,
                                                    "think": ""})
    assert len(md) <= feishu._PLAN_INLINE_MAX + 40
    assert "截断" in md
    assert feishu._plan_inline_markdown(_plan_ctx(), {"assistant": "",
                                                      "think": ""}) == ""


# ---------- ③ 文档正文（**不截断**：卡片截断掉的全文在这里） ----------

def test_doc_markdown_keeps_full_question_and_options():
    q_long = "问" * 800                      # 卡片按 _Q_TEXT_MAX=500 截断
    ctx = _plan_ctx(questions=[{
        "id": "q_0", "header": "方案确认", "question": q_long, "body": "补充说明",
        "options": [{"id": "a", "label": "按方案实施",
                     "description": "彻底去前缀"},
                    {"id": "b", "label": "保留 raw 形参", "description": "改动最小"}],
        "multi_select": False, "allow_other": True, "other_label": "其他"}])
    md = feishu._plan_doc_markdown(ctx, {"assistant": "回答正文", "think": ""},
                                   "演示项目")
    assert q_long in md                                   # 全文，不截断
    assert "按方案实施" in md and "彻底去前缀" in md and "保留 raw 形参" in md
    assert "回答正文" in md and "演示项目" in md
    assert "作答 949" in md                               # 文档内给作答指令
    assert "## agent 的思考摘录" not in md                  # 回答够长 ⇒ 不附思考


def test_doc_markdown_appends_think_excerpt_when_assistant_short():
    ctx = _plan_ctx(questions=[{"id": "q_0", "question": "选哪个？",
                                "options": [{"id": "a", "label": "A"}],
                                "multi_select": False, "allow_other": False}])
    md = feishu._plan_doc_markdown(ctx, {"assistant": "见上", "think": "详细推理"},
                                   "p")
    assert "## agent 的思考摘录" in md and "详细推理" in md


def test_doc_markdown_flat_fallback():
    """旧调用面/测试替身只给平面字段（question + 字符串选项）时也能组出正文。"""
    md = feishu._plan_doc_markdown(_plan_ctx(options=["甲", "乙"]),
                                   {"assistant": "", "think": ""}, "p")
    assert "是否按此实施？" in md and "甲" in md and "乙" in md


# ---------- ④ 卡片：折叠面板 + 文档链接 ----------

def test_build_card_adds_plan_panel_before_question():
    """有方案 ⇒ 题面前先给折叠面板（默认展开，用户先读方案再决策）+ 文档链接。"""
    card = feishu._build_interaction_card(
        _plan_ctx(plan_inline="**方案**：删掉 raw 形参",
                  plan_doc_url="https://my.feishu.cn/docx/ABC"), "演示项目")
    els = card["body"]["elements"]
    panel = els[0]
    assert panel["tag"] == "collapsible_panel" and panel["expanded"] is True
    assert panel["header"]["title"]["content"]
    assert panel["elements"][0]["tag"] == "markdown"
    assert "删掉 raw 形参" in panel["elements"][0]["content"]
    assert any("https://my.feishu.cn/docx/ABC" in (e.get("content") or "")
               for e in els)
    # 题面与选项仍在（面板只是**追加**信息，不改原有作答控件）
    assert any("是否按此实施？" in (e.get("content") or "") for e in els)


def test_build_card_shape_unchanged_without_plan():
    """回归：没有方案字段时卡片形状与既有断言一致（首元素仍是题面）。"""
    card = feishu._build_interaction_card(_plan_ctx(), "演示项目")
    els = card["body"]["elements"]
    assert els[0]["tag"] == "markdown"
    assert "是否按此实施？" in els[0]["content"]
    assert not any(e.get("tag") == "collapsible_panel" for e in els)


# ---------- ⑤ 建文档：调用序与失败兜底 ----------

def _stub_rest(monkeypatch, calls, fail_on=None):
    """_rest 桩：按 path 记账并回飞书形状的响应。"""
    def _rest(method, path, *, params=None, json_body=None, cfg=None, timeout=None):
        calls.append({"method": method, "path": path, "params": params,
                      "body": json_body, "timeout": timeout})
        if fail_on and fail_on in path:
            raise feishu.FeishuRestError(f"REST {path} code=99991672 缺权限",
                                         code=99991672)
        if path.endswith("/docx/v1/documents"):
            return {"data": {"document": {"document_id": "DOC1"}}}
        if "/metas/batch_query" in path:
            return {"data": {"metas": [{"url": "https://my.feishu.cn/docx/DOC1"}]}}
        return {"data": {}}
    monkeypatch.setattr(feishu, "_rest", _rest)


def test_docx_create_follows_recipe(monkeypatch):
    """建文档五步（实测配方）：建 → 写块 → 组织内可读 → 加协作者 → 取链接。
    少了「组织内可读」这步用户就打不开（文档默认归应用所有）。"""
    calls = []
    _stub_rest(monkeypatch, calls)
    url = feishu._docx_create("标题", "# 头\n\n正文\n- 项", {"app_id": "a"}, "ou_x")
    assert url == "https://my.feishu.cn/docx/DOC1"
    paths = [c["path"] for c in calls]
    assert paths[0].endswith("/docx/v1/documents")
    assert any("/documents/DOC1/blocks/DOC1/children" in p for p in paths)
    pub = [c for c in calls if p_("/permissions/DOC1/public", c)][0]
    assert pub["body"]["link_share_entity"] == "tenant_readable"
    member = [c for c in calls if "/permissions/DOC1/members" in c["path"]][0]
    assert member["body"]["member_id"] == "ou_x"
    meta = [c for c in calls if "/metas/batch_query" in c["path"]][0]
    assert meta["body"]["request_docs"][0]["doc_token"] == "DOC1"
    assert meta["body"].get("with_url") is True   # 漏 with_url 会静默回空串（实测）


def p_(frag, call):
    return frag in call["path"]


def test_docx_create_fails_fast_on_missing_scope(monkeypatch):
    """缺 docx 权限：第一步就抛（不继续无谓调用），由上层兜底成"卡照发、无链接"。"""
    calls = []
    _stub_rest(monkeypatch, calls, fail_on="/docx/v1/documents")
    with pytest.raises(feishu.FeishuRestError):
        feishu._docx_create("标题", "正文", {"app_id": "a"}, "ou_x")
    assert len(calls) == 1


def test_docx_create_tolerates_member_grant_failure(monkeypatch):
    """加协作者失败（如 open_id 属别的应用）不影响出链接：链接分享已可读。"""
    calls = []
    _stub_rest(monkeypatch, calls, fail_on="/permissions/DOC1/members")
    url = feishu._docx_create("标题", "正文", {"app_id": "a"}, "ou_x")
    assert url == "https://my.feishu.cn/docx/DOC1"


# ---------- ⑥ 接线：_dm_interaction_card ----------

def test_dm_card_attaches_plan_and_doc(monkeypatch):
    """提问卡：转录里的方案进卡内摘要，完整方案建文档、链接进卡。"""
    _stub_session(monkeypatch, _entries(
        ("user", "任务"), ("assistant", "我给一份方案"), ("think", "现状取证与取舍"),
        ("tool_call", "", "ask_user_question")))
    calls = []
    _stub_rest(monkeypatch, calls)
    sent = _stub_dm(monkeypatch)
    ctx = _plan_ctx()
    feishu._dm_interaction_card(9, ctx)
    assert ctx["plan_inline"] and "现状取证" in ctx["plan_inline"]
    assert ctx["plan_doc_url"] == "https://my.feishu.cn/docx/DOC1"
    assert len(sent) == 1
    panel = sent[0]["body"]["elements"][0]
    assert panel["tag"] == "collapsible_panel"
    assert any("DOC1" in json.dumps(e, ensure_ascii=False)
               for e in sent[0]["body"]["elements"])


def test_dm_card_dedups_doc_per_question(monkeypatch):
    """同一 (卡, 提问) 只建一次文档（调和器理论上每提问只调一次；这是重放保险）。"""
    feishu._PLAN_DOCS.clear()
    _stub_session(monkeypatch, _entries(("assistant", "方案"), ("think", "思考")))
    calls = []
    _stub_rest(monkeypatch, calls)
    _stub_dm(monkeypatch)
    feishu._dm_interaction_card(9, _plan_ctx())
    n1 = len([c for c in calls if c["path"].endswith("/docx/v1/documents")])
    feishu._dm_interaction_card(9, _plan_ctx())
    n2 = len([c for c in calls if c["path"].endswith("/docx/v1/documents")])
    assert (n1, n2) == (1, 1)


def test_dm_card_survives_doc_failure(monkeypatch):
    """建文档失败（缺权限/网络）：卡照发（有摘要、无链接），异常不外抛。"""
    feishu._PLAN_DOCS.clear()
    _stub_session(monkeypatch, _entries(("assistant", "方案正文"), ("think", "思考")))
    calls = []
    _stub_rest(monkeypatch, calls, fail_on="/docx/v1/documents")
    sent = _stub_dm(monkeypatch)
    ctx = _plan_ctx()
    feishu._dm_interaction_card(9, ctx)
    assert len(sent) == 1 and ctx.get("plan_doc_url") is None
    assert ctx["plan_inline"] and "方案正文" in ctx["plan_inline"]


def test_dm_card_skips_when_no_session_or_approval(monkeypatch):
    """无会话（取不到方案）与审批卡不建文档：不发无意义文档、不打扰用户。"""
    feishu._PLAN_DOCS.clear()
    _stub_session(monkeypatch, _entries(("assistant", "方案")))
    calls = []
    _stub_rest(monkeypatch, calls)
    _stub_dm(monkeypatch)
    feishu._dm_interaction_card(9, _plan_ctx(session_id=""))
    feishu._dm_interaction_card(9, _plan_ctx(kind="approval"))
    assert [c for c in calls if c["path"].endswith("/docx/v1/documents")] == []


def test_plan_env_switch_off(monkeypatch):
    """回滚阀 TS_FEISHU_PLAN=0：行为回到现状（不挂摘要、不建文档），卡照发。"""
    feishu._PLAN_DOCS.clear()
    monkeypatch.setenv("TS_FEISHU_PLAN", "0")
    _stub_session(monkeypatch, _entries(("assistant", "方案"), ("think", "思考")))
    calls = []
    _stub_rest(monkeypatch, calls)
    sent = _stub_dm(monkeypatch)
    ctx = _plan_ctx()
    feishu._dm_interaction_card(9, ctx)
    assert calls == [] and ctx.get("plan_inline") is None
    assert len(sent) == 1
    assert not any(e.get("tag") == "collapsible_panel"
                   for e in sent[0]["body"]["elements"])


# ---------- ⑦ markdown → 飞书文档块 ----------

def test_md_blocks_basic_shapes():
    """标题/列表/代码/分隔线各自成块；表格分隔行丢弃（飞书块不支持表格，
    留着只有噪声）；强调符号清理（docx text_run 不渲染 markdown）。"""
    blocks = feishu._md_blocks(
        "# 头\n## 二级\n- 项一\n1. 有序\n**加粗**正文\n\n---\n```\ncode\n```\n"
        "| a | b |\n| --- | --- |\n| 1 | 2 |")
    types = [b["block_type"] for b in blocks]
    assert types[0] == 3 and 4 in types and 12 in types and 13 in types
    assert 22 in types and 14 in types
    text = json.dumps(blocks, ensure_ascii=False)
    assert "**" not in text                       # 强调符已清理
    assert "--- | ---" not in text                # 表格分隔行已丢
    assert "| 1 | 2 |" in text                    # 数据行保留为纯文本


def test_md_blocks_splits_long_paragraph():
    """超长段落按上限切块（单块过长会被文档接口拒收）。"""
    blocks = feishu._md_blocks("字" * (feishu._MD_BLOCK_MAX * 2 + 5))
    assert all(len(b.get("text", {}).get("elements", [{}])[0]
                   .get("text_run", {}).get("content", ""))
               <= feishu._MD_BLOCK_MAX for b in blocks)
    assert len(blocks) >= 3
