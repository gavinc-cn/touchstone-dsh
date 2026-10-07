# 交互作答（提问 kinds / 多子题整批提交 / 审批）+ 任务会话按需探测单测
# （monkeypatch 底层，不触网络）
# 覆盖：board.answer_interaction 与 answer_approval 的白名单校验与成功路径
#       （含漏题拒绝）——任务侧伪卡（无 id）直送 dshdriver，断言平台载荷→
#       dsh 原生形态（_dsh_answers）的组装；board.interaction_probe 的 TTL
#       复用与失败保留旧值。
# 注（v2b T1）：看板卡路径作答/审批一律入队（覆盖在 tests/test_answer_queue.py）；
#       本文件成功路径走任务侧伪卡（无 id）直送，专钉白名单校验与载荷组装。
# 注（P7b 单族化）：dsh 侧的载荷转换与 _iw_interaction 富字段解析覆盖在
#       tests/test_dsh_plugin.py（原 kimiweb REST 层用例已随驱动模块删除）。
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import board


def _proj():
    return {"id": 9, "project_dir": "/tmp/x",
            "agent_path": "dsh-plugin:/usr/bin/dsh"}


def _card(**kw):
    base = {"id": 1, "project_id": 9, "session_id": "s-1"}
    base.update(kw)
    return base


def _q(qid="q_0", **kw):
    """单题视图（board._iw_interaction 的 questions[] 形态；默认单选题两选项）。"""
    base = {"id": qid, "question": "选哪个？", "header": "", "body": "",
            "options": [{"id": "o1", "label": "A", "description": "da"},
                        {"id": "o2", "label": "B", "description": ""}],
            "multi_select": False, "allow_other": False,
            "other_label": "", "other_description": ""}
    base.update(kw)
    return base


def _st(questions=None, **kw):
    """交互缓存条目（默认单题 _q()；平面字段取首题，供旧消费方兼容断言）。"""
    qs = questions if questions is not None else [_q()]
    base = {"pending": True, "busy": True, "kind": "question",
            "qid": "Q-1", "wire": qs[0]["id"], "questions": qs,
            "options": qs[0]["options"],
            "multi_select": qs[0]["multi_select"],
            "allow_other": qs[0]["allow_other"],
            "answerable": True, "text": "选哪个？"}
    base.update(kw)
    return base


def _patch_answer(monkeypatch, st):
    """装订交互缓存 / _iw_clear 与 dshdriver.answer_question 记录器。"""
    calls = []
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: dict(st))
    monkeypatch.setattr(board, "_iw_clear", lambda sid: None)
    monkeypatch.setattr(board.dshdriver, "answer_question",
                        lambda sid, qid, answers:
                        calls.append((sid, qid, answers)) or True)
    return calls


# ---------- board：作答白名单 ----------

def _ans(wire="q_0", **kw):
    """作答条目（默认：wire 题单选 o1）。"""
    base = {"wire": wire, "kind": "single", "option_id": "o1"}
    base.update(kw)
    return base


# 任务侧伪卡（无 id）：v2b T1 起看板卡路径一律入队，成功路径直送断言走任务侧
_TASK_CARD = {"session_id": "s-1"}


def test_answer_interaction_rejects_stale_qid(monkeypatch):
    calls = _patch_answer(monkeypatch, _st())
    assert board.answer_interaction(_proj(), _card(), "OTHER", [_ans()]) \
        == "提问不存在或已过期"
    assert calls == []


def test_answer_interaction_rejects_unknown_option(monkeypatch):
    calls = _patch_answer(monkeypatch, _st())
    err = board.answer_interaction(_proj(), _card(), "Q-1",
                                   [_ans(option_id="nope")])
    assert err == "选项不存在或已过期"
    assert calls == []


def test_answer_interaction_kind_capability_guard(monkeypatch):
    _patch_answer(monkeypatch, _st())            # 单选、不允许自定义输入
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans(kind="multi", option_ids=["o1"])]) \
        == "该问题不支持多选"
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans(kind="other", text="x")]) \
        == "该问题不支持自定义输入"
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans(kind="video")]) == "作答形态非法"


def test_answer_interaction_other_text_guard(monkeypatch):
    _patch_answer(monkeypatch, _st([_q(allow_other=True)]))
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans(kind="other", text="  ")]) == "请输入内容"
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans(kind="other", text="x" * 2001)]) == "输入内容过长"


def test_answer_interaction_success_passes_wire_and_kind(monkeypatch):
    calls = _patch_answer(monkeypatch, _st([_q("q_1", allow_other=True)]))
    assert board.answer_interaction(_proj(), _TASK_CARD, "Q-1",
                                    [{"wire": "q_1", "kind": "other",
                                      "text": " 你好 "}]) is None
    assert calls == [("s-1", "Q-1", [{"id": "q_1", "selected": [],
                                      "custom": "你好"}])]   # dsh 原生载荷


def test_answer_interaction_multi_requires_selection(monkeypatch):
    _patch_answer(monkeypatch, _st([_q(multi_select=True)]))
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans(kind="multi", option_ids=[])]) == "未选择任何选项"
    calls = _patch_answer(monkeypatch, _st([_q(multi_select=True)]))
    assert board.answer_interaction(_proj(), _TASK_CARD, "Q-1",
                                    [_ans(kind="multi", option_ids=["o1", "o2"])]) is None
    assert calls[0][2][0]["selected"] == ["o1", "o2"]


def test_answer_interaction_multi_question_submits_all(monkeypatch):
    """多子题一次提交全部：按题目顺序组装，wire=每题 id（q_0/q_1…）。"""
    calls = _patch_answer(monkeypatch,
                          _st([_q("q_0"), _q("q_1", allow_other=True)]))
    assert board.answer_interaction(_proj(), _TASK_CARD, "Q-1", [
        {"wire": "q_0", "kind": "single", "option_id": "o2"},
        {"wire": "q_1", "kind": "other", "text": "自定义"}]) is None
    assert calls == [("s-1", "Q-1", [
        {"id": "q_0", "selected": ["o2"]},
        {"id": "q_1", "selected": [], "custom": "自定义"}])]


def test_answer_interaction_multi_question_requires_every_item(monkeypatch):
    """漏题即拒绝（dsh 侧 answers 缺项=未答）——旧实现只交首题、其余被忽略的回归护栏。"""
    calls = _patch_answer(monkeypatch, _st([_q("q_0"), _q("q_1")]))
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans("q_0")]) == "请回答全部问题"
    assert calls == []


def test_answer_interaction_rejects_unknown_wire_and_bad_payload(monkeypatch):
    calls = _patch_answer(monkeypatch, _st([_q("q_0")]))
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    [_ans("q_9")]) == "题目不存在或已过期"
    assert board.answer_interaction(_proj(), _card(), "Q-1", []) == "作答载荷非法"
    assert board.answer_interaction(_proj(), _card(), "Q-1",
                                    {"wire": "q_0"}) == "作答载荷非法"
    assert calls == []


# ---------- board：审批应答 ----------

def _patch_approval(monkeypatch, st):
    calls = []
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: dict(st))
    monkeypatch.setattr(board, "_iw_clear", lambda sid: None)
    monkeypatch.setattr(board.dshdriver, "answer_approval",
                        lambda sid, aid, outcome: calls.append((sid, aid, outcome)))
    return calls


def test_answer_approval_whitelist_and_success(monkeypatch):
    calls = _patch_approval(monkeypatch, _st(kind="approval", qid=None,
                                             approval_id="A-1"))
    assert board.answer_approval(_proj(), _card(), "OTHER", "approved") \
        == "审批不存在或已过期"
    assert board.answer_approval(_proj(), _card(), "A-1", "maybe") == "审批决定非法"
    assert board.answer_approval(_proj(), _card(), "A-1", "approved",
                                 scope="all") == "审批范围非法"
    # scope=session：dsh 无「本会话内批准」语义 → 明确拒绝且不投递
    assert board.answer_approval(_proj(), _TASK_CARD, "A-1", "approved",
                                 scope="session") == \
        "dsh 不支持「本会话内批准」（宿主无 session 级放行语义）"
    assert board.answer_approval(_proj(), _TASK_CARD, "A-1", "approved") is None
    assert board.answer_approval(_proj(), _TASK_CARD, "A-1", "rejected") is None
    assert calls == [("s-1", "A-1", "allowed-once"),     # approved→allowed-once
                     ("s-1", "A-1", "rejected")]


def test_answer_approval_rejects_question_state(monkeypatch):
    calls = _patch_approval(monkeypatch, _st())   # 缓存是提问态
    assert board.answer_approval(_proj(), _card(), "A-1", "approved") \
        == "当前等待的不是审批"
    assert calls == []


# ---------- board：任务会话按需探测 ----------

def test_interaction_probe_reuses_cache_within_ttl(monkeypatch):
    board._IW_CACHE.clear()
    probes = []
    monkeypatch.setattr(board, "_iw_interaction",
                        lambda fam, proj, sid, busy_hint=None:
                        probes.append(sid) or {"pending": False, "busy": False})
    board.interaction_probe("dsh_plugin", _proj(), "s-1")
    board.interaction_probe("dsh_plugin", _proj(), "s-1")
    assert probes == ["s-1"]                     # TTL 内不重探
    assert board._IW_CACHE["s-1"]["ts"] > 0


def test_interaction_probe_refresh_after_ttl(monkeypatch):
    board._IW_CACHE.clear()
    probes = []
    monkeypatch.setattr(board, "_iw_interaction",
                        lambda fam, proj, sid, busy_hint=None:
                        probes.append(sid) or {"pending": False, "busy": False})
    board.interaction_probe("dsh_plugin", _proj(), "s-1")
    board._IW_CACHE["s-1"]["ts"] -= 6000         # 拨老越过 5s TTL
    board.interaction_probe("dsh_plugin", _proj(), "s-1")
    assert probes == ["s-1", "s-1"]


def test_interaction_probe_failure_keeps_old(monkeypatch):
    board._IW_CACHE.clear()
    monkeypatch.setattr(board, "_iw_interaction", lambda *a, **k: None)
    board._IW_CACHE["s-1"] = {"pending": True, "kind": "question", "ts": 0}
    r = board.interaction_probe("dsh_plugin", _proj(), "s-1")
    assert r["pending"] is True                  # 失败保留旧值，不清展示/白名单
