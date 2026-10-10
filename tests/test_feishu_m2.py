# 飞书 M2 入站：feishu_bindings 绑定 / 意图解析 / 执行器（打桩网络，不触真实飞书）
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db
import board
import feishu
import feishu_conv

db.init_db()  # 测试库建表（幂等；conftest 已把 TOUCHSTONE_DB 指到临时库）


def test_binding_roundtrip_and_rebind():
    assert db.get_feishu_binding_by_open("ou_a") is None
    db.set_feishu_binding("ou_a", 1)
    row = db.get_feishu_binding_by_open("ou_a")
    assert row["user_id"] == 1 and row["default_project_id"] == 0
    assert db.get_feishu_binding_by_user(1)["open_id"] == "ou_a"
    # 同一用户换飞书号：旧 open_id 绑定自动清除（user_id UNIQUE 语义）
    db.set_feishu_binding("ou_b", 1)
    assert db.get_feishu_binding_by_open("ou_a") is None
    assert db.get_feishu_binding_by_open("ou_b")["user_id"] == 1
    db.set_feishu_default_project("ou_b", 7)
    assert db.get_feishu_binding_by_open("ou_b")["default_project_id"] == 7
    db.del_feishu_binding_by_open("ou_b")
    assert db.get_feishu_binding_by_open("ou_b") is None


def test_del_by_user():
    db.set_feishu_binding("ou_c", 2)
    db.del_feishu_binding_by_user(2)
    assert db.get_feishu_binding_by_open("ou_c") is None


# ---------- REST 客户端（requests 打桩，不触网；cfg=用户应用凭据） ----------

_CFG = {"app_id": "cli_x", "app_secret": "s"}


def test_tenant_token_cached(monkeypatch):
    calls = []

    class _R:
        def json(self):
            calls.append(1)
            return {"code": 0, "tenant_access_token": "T", "expire": 7200}

    monkeypatch.setattr(feishu.requests, "post", lambda *a, **k: _R())
    feishu._TOKEN_CACHE.clear()
    t1, t2 = feishu._tenant_token(_CFG), feishu._tenant_token(_CFG)
    assert t1 == t2 == "T" and len(calls) == 1            # 二次走缓存不重发
    feishu._tenant_token({"app_id": "cli_y", "app_secret": "s2"})
    assert len(calls) == 2                                # 不同应用 token 分桶缓存


def test_rest_send_reply_patch_shapes(monkeypatch):
    feishu._TOKEN_CACHE.update({"cli_x": {"token": "T", "expire": time.time() + 999}})
    captured = []

    def _fake_request(method, url, **kw):
        captured.append((method, url, kw))

        class _R:
            def json(self):
                return {"code": 0, "data": {"message_id": "om_1"}}

        return _R()

    monkeypatch.setattr(feishu.requests, "request", _fake_request)
    feishu.rest_send_text("ou_1", "hi", _CFG)
    m, url, kw = captured[-1]
    assert m == "POST" and "/im/v1/messages" in url
    assert kw["params"] == {"receive_id_type": "open_id"}
    assert kw["json"]["receive_id"] == "ou_1" and "text" in kw["json"]["content"]
    feishu.rest_reply("om_1", "yo", _CFG)
    assert captured[-1][0] == "POST" and "/im/v1/messages/om_1/reply" in captured[-1][1]
    feishu.rest_patch_text("om_1", "fixed", _CFG)
    assert captured[-1][0] == "PUT" and "/im/v1/messages/om_1" in captured[-1][1]


def test_rest_error_raises(monkeypatch):
    feishu._TOKEN_CACHE.update({"cli_x": {"token": "T", "expire": time.time() + 999}})

    def _fake_request(method, url, **kw):
        class _R:
            def json(self):
                return {"code": 99991663, "msg": "token 无效"}

        return _R()

    monkeypatch.setattr(feishu.requests, "request", _fake_request)
    try:
        feishu.rest_send_text("ou_1", "hi", _CFG)
        assert False, "应抛 FeishuRestError"
    except feishu.FeishuRestError as e:
        assert "99991663" in str(e)


def test_bot_open_id_cached(monkeypatch):
    feishu._TOKEN_CACHE.update({"cli_x": {"token": "T", "expire": time.time() + 999}})
    feishu._BOT_OPEN_ID.clear()
    calls = []

    def _fake_request(method, url, **kw):
        calls.append(url)

        class _R:
            def json(self):
                return {"code": 0, "bot": {"open_id": "ou_bot"}}

        return _R()

    monkeypatch.setattr(feishu.requests, "request", _fake_request)
    assert feishu.bot_open_id(_CFG) == "ou_bot"
    assert feishu.bot_open_id(_CFG) == "ou_bot"
    assert len(calls) == 1                                # 缓存生效只调一次
    assert feishu.bot_open_id({"app_id": "cli_y", "app_secret": "s2"}) == "ou_bot"
    assert len(calls) == 2                                # 不同应用缓存相互独立


# ---------- 入站消息主流程（SDK 未接，直调 handle_message_event） ----------

def _evt(mid="m1", text="帮助", chat_type="p2p", sender="ou_x", mentions=None,
         message_type="text"):
    return {"message_id": mid, "message_type": message_type,
            "content": json.dumps({"text": text}), "chat_type": chat_type,
            "mentions": mentions or [], "sender_open_id": sender}


def test_dedup_and_unbound_guidance(monkeypatch):
    replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append((mid, text)))
    monkeypatch.setattr(db, "get_feishu_binding_by_open", lambda oid: None)
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu.handle_message_event(_evt(text="随便说说"))
    feishu.handle_message_event(_evt(text="随便说说"))
    assert len(replies) == 1                              # 同 message_id 去重
    assert "绑定" in replies[0][1]


def test_group_no_mention_silent(monkeypatch):
    replies = []
    monkeypatch.setattr(feishu, "rest_reply", lambda mid, t, cfg=None: replies.append(t))
    monkeypatch.setattr(feishu, "bot_open_id", lambda cfg=None: "ou_bot")
    monkeypatch.setattr(db, "get_feishu_binding_by_open", lambda oid: None)
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu.handle_message_event(_evt(chat_type="group", text="大家好",
                                     mentions=[{"key": "@_user_1", "open_id": "ou_o"}]))
    assert replies == []                                  # 未 @ 机器人：静默
    feishu.handle_message_event(_evt(mid="m2", chat_type="group", text="@_user_1 帮助",
                                     mentions=[{"key": "@_user_1", "open_id": "ou_bot"}]))
    assert replies and "绑定" in replies[0]               # @ 到但未绑定 → 引导


def test_bound_flow_unknown_text_routes(monkeypatch):
    replies = []
    monkeypatch.setattr(feishu, "rest_reply", lambda mid, t, cfg=None: replies.append(t))
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1,
                                     "default_project_id": 0})
    routed = []
    # 2026-10-08 通用对话（Task 3）：单聊未识别文本改走 feishu_conv.route_text
    # （投递给当前会话 / 无会话自动新建），不再直接回帮助；帮助只留给群聊与
    # TS_FEISHU_CONV=0（见 tests/test_feishu_conv.py 的群聊与开关用例）。
    monkeypatch.setattr(feishu_conv, "route_text",
                        lambda binding, text, cfg=None: routed.append(text) or "已投递到「会话」")
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu.handle_message_event(_evt(mid="m3", text="不认识的指令xyz"))
    assert routed == ["不认识的指令xyz"] and replies == ["已投递到「会话」"]
    feishu.handle_message_event(_evt(mid="m4", message_type="image", text=""))
    assert len(replies) == 2 and "暂不支持" in replies[1]  # 非文本：暂不支持


# ---------- 意图解析 / 绑定码 ----------

def test_rest_url_prefix_normalized(monkeypatch):
    """回归：_rest 路径规范化——调用方带/不带 /open-apis 前缀都恰好拼出一层。
    曾因调用方自带前缀 + _rest 再拼一层，请求打到 /open-apis/open-apis/... 恒 404
    （响应体纯文本 404 page not found），旧断言子串匹配未覆盖 URL 拼接而漏网。"""
    feishu._TOKEN_CACHE.update({"cli_x": {"token": "T", "expire": time.time() + 999}})
    urls = []

    def _fake_request(method, url, **kw):
        urls.append(url)

        class _R:
            def json(self):
                return {"code": 0}

        return _R()

    monkeypatch.setattr(feishu.requests, "request", _fake_request)
    feishu.rest_reply("om_1", "yo", _CFG)        # 调用方带前缀
    assert urls[-1] == "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply"
    feishu._rest("GET", "/open-apis/bot/v3/info", cfg=_CFG)   # 带前缀
    assert urls[-1] == "https://open.feishu.cn/open-apis/bot/v3/info"
    feishu._rest("GET", "im/v1/messages", cfg=_CFG)           # 不带前缀（防呆）
    assert urls[-1] == "https://open.feishu.cn/open-apis/im/v1/messages"


def test_unbound_bind_intent_reaches_bind(monkeypatch):
    """回归：未绑定者发「绑定 <码>」必须直达绑定逻辑。曾因绑定校验先于指令解析，
    「绑定 <码>」本身也被「尚未绑定」拦下——未绑定者永远无法绑定（死锁）。"""
    replies = []
    monkeypatch.setattr(feishu, "rest_reply", lambda mid, t, cfg=None: replies.append(t))
    monkeypatch.setattr(db, "get_feishu_binding_by_open", lambda oid: None)
    code = feishu.make_bind_code(9)
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu.handle_message_event(_evt(mid="mb1", text=f"绑定 {code}"))
    assert replies and "绑定成功" in replies[0]
    assert db.get_feishu_binding_by_user(9)["open_id"].startswith("ou_")
    # 已绑定后再发绑定指令 → 提示无需重复（不消耗新码）
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 9,
                                     "default_project_id": 0})
    feishu.handle_message_event(_evt(mid="mb2", text=f"绑定 {feishu.make_bind_code(9)}"))
    assert "已绑定" in replies[-1]
    db.del_feishu_binding_by_user(9)


def test_parse_intent_rules():
    assert feishu.parse_intent("帮助")["action"] == "help"
    assert feishu.parse_intent("绑定 AB12CD") == {"action": "bind", "groups": ["AB12CD"]}
    assert feishu.parse_intent("解绑")["action"] == "unbind"
    assert feishu.parse_intent("默认项目 demo_proj") == {"action": "default_project",
                                                         "groups": ["demo_proj"]}
    assert feishu.parse_intent("状态")["groups"] == [None]
    assert feishu.parse_intent("状态 cpp_try")["groups"] == ["cpp_try"]
    assert feishu.parse_intent("通过 42")["groups"] == ["42"]
    assert feishu.parse_intent("驳回 42 登录还是失败")["groups"] == ["42", "登录还是失败"]
    assert feishu.parse_intent("作答 7 2")["groups"] == ["7", "2"]
    assert feishu.parse_intent("作答 7 用 sqlite 即可")["groups"] == ["7", "用 sqlite 即可"]
    assert feishu.parse_intent("同意 42")["groups"] == ["42", None]
    assert feishu.parse_intent("同意 42 会话")["groups"] == ["42", "会话"]
    assert feishu.parse_intent("拒绝 42")["groups"] == ["42"]
    assert feishu.parse_intent("创建一个新任务吧") is None   # 未识别（M3 agent 兜底）


def test_bind_user_flow():
    db.del_feishu_binding_by_open("ou_1")
    feishu._BIND_CODES.clear()
    assert "无效" in feishu.bind_user("NOPE00", "ou_1")
    feishu._BIND_CODES["ABC123"] = (7, time.time() + 60)
    assert feishu.bind_user("abc123", "ou_1") is None       # 大小写兼容
    assert db.get_feishu_binding_by_open("ou_1")["user_id"] == 7


def test_bind_user_expired():
    feishu._BIND_CODES.clear()
    feishu._BIND_CODES["OLD1"] = (7, time.time() - 5)
    assert "过期" in feishu.bind_user("OLD1", "ou_9")


def test_make_bind_code():
    feishu._BIND_CODES.clear()
    code = feishu.make_bind_code(7)
    assert len(code) == 6 and feishu._BIND_CODES[code][0] == 7


# ---------- 执行器（board/db 打桩，不触网） ----------

def _binding(uid=1, openid="ou_x", dp=0):
    return {"open_id": openid, "user_id": uid, "default_project_id": dp}


def _proj(pid, name, uid=1):
    return {"id": pid, "user_id": uid, "name": name, "archived": 0}


def _card(cid, pid, title, col="doing", bk=None, bt="", sid="s-1"):
    return {"id": cid, "project_id": pid, "title": title, "column_key": col,
            "block_kind": bk, "block_text": bt, "session_id": sid}


def _patch_projects(monkeypatch, projects):
    monkeypatch.setattr(db, "list_projects", lambda uid: projects)


def test_resolve_project_branches(monkeypatch):
    ps = [_proj(1, "demo_proj"), _proj(2, "touchstone")]
    _patch_projects(monkeypatch, ps)
    # 显式项目名
    p, err = feishu._resolve_project(_binding(), "demo_proj")
    assert p["id"] == 1 and err == ""
    # 默认项目
    p, err = feishu._resolve_project(_binding(dp=2), None)
    assert p["id"] == 2 and err == ""
    # 用户唯一项目
    p, err = feishu._resolve_project(_binding(), None)
    assert err != ""                                     # 两个项目且无默认 → 要求指定
    _patch_projects(monkeypatch, ps[:1])
    p, err = feishu._resolve_project(_binding(), None)
    assert p["id"] == 1                                  # 唯一项目自动定位
    # 不存在的项目
    _patch_projects(monkeypatch, ps)
    p, err = feishu._resolve_project(_binding(), "不存在")
    assert p is None and "不在你的项目列表" in err


def test_find_cards_isolation_and_match(monkeypatch):
    ps = [_proj(1, "demo_proj"), _proj(2, "touchstone")]
    _patch_projects(monkeypatch, ps)
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(42, 2, "支付修复")]
                        if pid == 2 else [_card(10, 1, "登录鉴权")])
    hits = feishu._find_cards(1, "42")
    assert [(c["id"]) for _, c in hits] == [42]          # 跨用户项目找卡
    assert all(p["user_id"] == 1 for p, _ in hits)       # 只在用户自己的项目里找
    assert len(feishu._find_cards(1, "登录")) == 1       # 标题包含
    assert feishu._find_cards(1, "不存在的卡") == []


def test_execute_approve(monkeypatch):
    ps = [_proj(2, "touchstone")]
    _patch_projects(monkeypatch, ps)
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(42, 2, "支付修复", col="review")])
    moved = []
    monkeypatch.setattr(board, "move_card",
                        lambda project, cid, target, block_text="":
                        (moved.append((project["id"], cid, target)) or ({}, None)))
    r = feishu.execute_intent(_binding(), {"action": "approve", "groups": ["42"]}, "ou_x")
    assert moved == [(2, 42, "done")] and "通过" in r


def test_execute_approve_worktree_merge_pending(monkeypatch):
    """独立 worktree 卡有待合并提交（2026-10-07 批次）：飞书侧没有弹框，不替用户选
    「交给 agent 合并 / 仅通过」——回中文引导去网页看板操作，卡片列不变。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(42, 2, "支付修复", col="review")])
    monkeypatch.setattr(board, "move_card",
                        lambda project, cid, target, block_text="", merge_ack=False:
                        ({}, {"merge_pending": {"ahead": 3, "branch": "ts/card-42",
                                                "target": "master"}}))
    r = feishu.execute_intent(_binding(), {"action": "approve", "groups": ["42"]}, "ou_x")
    assert "3 个提交" in r and "ts/card-42" in r and "网页看板" in r


def test_execute_approve_requires_review(monkeypatch):
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(42, 2, "支付修复", col="doing")])
    r = feishu.execute_intent(_binding(), {"action": "approve", "groups": ["42"]}, "ou_x")
    assert "待审核" in r                                 # 非 review 卡拒绝


def test_execute_answer(monkeypatch):
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked", bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "qid": "Q-1", "answerable": True,
        "questions": [{"id": "q_0", "question": "选场景？",
                       "options": [{"id": "opt_a", "label": "A"},
                                   {"id": "opt_b", "label": "B"}]}]})
    answered = []

    def _fake_answer(proj, card, qid, answers):
        answered.append((qid, answers))
        return None

    monkeypatch.setattr(board, "answer_interaction", _fake_answer)
    r = feishu.execute_intent(_binding(), {"action": "answer", "groups": ["7", "2"]},
                              "ou_x")
    assert answered == [("Q-1", [{"wire": "q_0", "kind": "single",
                                  "option_id": "opt_b"}])]
    assert "已收下" in r and "B" in r      # 文案随 v2b 一律入队（c948d6a）：已收下≠已送达


def test_execute_answer_multi_question_needs_per_question_syntax(monkeypatch):
    """多子题提问：裸序号不构成逐题答案（作答须一次给全）——回语法指引且不提交。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked", bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "qid": "Q-1", "answerable": True,
        "questions": [{"id": "q_0", "options": [{"id": "opt_a", "label": "A"}]},
                      {"id": "q_1", "options": [{"id": "opt_b", "label": "B"}]}]})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer", "groups": ["7", "1"]},
                              "ou_x")
    assert called == []
    assert "1:<选项序号>" in r and "2:<选项序号>" in r


# ---------- 多子题逐题作答（「题号:值」一条指令一次给全，2026-10-06 第二档） ----------

_QS_3 = [
    {"id": "third_party", "header": "第三方", "allow_other": True,
     "options": [{"id": "l1", "label": "保持原名"}, {"id": "l2", "label": "全改"}]},
    {"id": "credentials", "header": "凭据", "allow_other": True,
     "options": [{"id": "c1", "label": "保持"}, {"id": "c2", "label": "改"}]},
    {"id": "compat", "header": "兼容", "multi_select": True, "allow_other": True,
     "options": [{"id": "k1", "label": "硬切"}, {"id": "k2", "label": "回退"},
                 {"id": "k3", "label": "告警"}]}]


def _stub_multi_question(monkeypatch, qs):
    """多子题提问的交互缓存打桩（card 7 blocked/interaction）。
    连暂存一起清：点选暂存是模块级内存态，不清会跨用例污染。"""
    _mq_reset()
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked",
                                           bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "qid": "Q-1", "answerable": True, "kind": "question",
        "questions": qs})


def _spy_answer(monkeypatch):
    """记录 answer_interaction 的入参（不真入队）。"""
    answered = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda proj, card, qid, answers:
                        answered.append((qid, answers)) or None)
    return answered


def test_execute_answer_multi_questions_batch(monkeypatch):
    """多子题一次答全：逐题 record（单选/单选/多选）整批提交。"""
    _stub_multi_question(monkeypatch, _QS_3)
    answered = _spy_answer(monkeypatch)
    r = feishu.execute_intent(_binding(),
                              {"action": "answer", "groups": ["7", "1:1 2:2 3:1,3"]},
                              "ou_x")
    assert answered == [("Q-1", [
        {"wire": "third_party", "kind": "single", "option_id": "l1"},
        {"wire": "credentials", "kind": "single", "option_id": "c2"},
        {"wire": "compat", "kind": "multi", "option_ids": ["k1", "k3"]}])]
    assert "已收下" in r and "3 道作答" in r


def test_execute_answer_multi_questions_free_text_with_space(monkeypatch):
    """题值可含空格（后续非「数字:」token 续接到该题）→ other 形态。"""
    _stub_multi_question(monkeypatch, _QS_3)
    answered = _spy_answer(monkeypatch)
    feishu.execute_intent(
        _binding(),
        {"action": "answer",
         "groups": ["7", "1:1 2:2 3:用 sqlite 就行"]}, "ou_x")
    assert answered[0][1][2] == {"wire": "compat", "kind": "other",
                                 "text": "用 sqlite 就行"}


def test_execute_answer_multi_questions_missing(monkeypatch):
    """缺题不提交：回执点名所缺题（整批语义，不落地半份答案）。"""
    _stub_multi_question(monkeypatch, _QS_3)
    answered = _spy_answer(monkeypatch)
    r = feishu.execute_intent(_binding(), {"action": "answer", "groups": ["7", "1:1"]},
                              "ou_x")
    assert answered == []
    assert "还差" in r and "第 2 题" in r and "第 3 题" in r


def test_execute_answer_multi_questions_invalid(monkeypatch):
    """题号越界 / 重复作答 / 单选给多序号：各自回执且不提交。"""
    _stub_multi_question(monkeypatch, _QS_3)
    answered = _spy_answer(monkeypatch)
    r1 = feishu.execute_intent(_binding(),
                               {"action": "answer", "groups": ["7", "4:1 2:1 3:1"]},
                               "ou_x")
    assert answered == [] and "题号 4 无效" in r1
    r2 = feishu.execute_intent(
        _binding(), {"action": "answer", "groups": ["7", "1:1 1:2 2:1 3:1"]}, "ou_x")
    assert answered == [] and "重复" in r2
    r3 = feishu.execute_intent(
        _binding(), {"action": "answer", "groups": ["7", "1:1,2 2:1 3:1"]}, "ou_x")
    assert answered == [] and "单选" in r3


def test_execute_answer_multi_questions_merges_staged_clicks(monkeypatch):
    """文本指令与卡片点选**可混用**：已点选暂存的题不必在指令里重复给，
    文本只补没点的题，齐了才整批送达（仍不落地半份答案）。"""
    _stub_multi_question(monkeypatch, _QS_3)
    answered = _spy_answer(monkeypatch)
    feishu._MQ_STAGE[(7, "Q-1")] = {"n": 3, "vals": {1: "1", 3: "1,3"}, "at": 9e9}
    r = feishu.execute_intent(_binding(),
                              {"action": "answer", "groups": ["7", "2:2"]}, "ou_x")
    assert answered == [("Q-1", [
        {"wire": "third_party", "kind": "single", "option_id": "l1"},
        {"wire": "credentials", "kind": "single", "option_id": "c2"},
        {"wire": "compat", "kind": "multi", "option_ids": ["k1", "k3"]}])]
    assert "已收下" in r and feishu._MQ_STAGE == {}     # 提交后清桶


def test_execute_answer_multi_questions_staged_only_not_enough(monkeypatch):
    """只点了一半又没给文本：回语法指引且不提交（缺项即未答的整批语义不变）。"""
    _stub_multi_question(monkeypatch, _QS_3)
    answered = _spy_answer(monkeypatch)
    feishu._MQ_STAGE[(7, "Q-1")] = {"n": 3, "vals": {1: "1"}, "at": 9e9}
    r = feishu.execute_intent(_binding(),
                              {"action": "answer", "groups": ["7", "3:1"]}, "ou_x")
    assert answered == []
    assert "还差" in r and "第 2 题" in r
    feishu._MQ_STAGE.clear()


def test_execute_answer_single_question_rejects_per_question_syntax(monkeypatch):
    """单题提问收到「1:2」逐题语法：明确纠正，不当自由文本提交。"""
    _stub_question(monkeypatch, {"id": "q_0", "allow_other": True,
                                 "options": [{"id": "opt_a", "label": "A"}]})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer", "groups": ["7", "1:1"]},
                              "ou_x")
    assert called == [] and "只有一道题" in r


def test_execute_status_summary(monkeypatch):
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_tasks", lambda pid: [
        {"id": 5, "name": "探索", "status": "running", "task_type": "normal"},
        {"id": 6, "name": "回归", "status": "queued", "task_type": "regression"}])
    monkeypatch.setattr(db, "list_board_cards", lambda pid: [
        _card(10, 2, "登录鉴权", col="blocked", bk="interaction", bt="选场景？"),
        _card(11, 2, "支付", col="done")])
    r = feishu.execute_intent(_binding(), {"action": "status", "groups": [None]}, "ou_x")
    assert "touchstone" in r and "运行中 1" in r and "排队 1" in r
    assert "#10 登录鉴权" in r and "选场景？" in r        # 阻塞卡带原因
    assert "#5 探索" in r                                # 运行任务点名


# ---------- 作答意图增强（自由文本 / 多选）与审批远程同意/拒绝 ----------

def _stub_question(monkeypatch, q0):
    """单题提问的交互缓存打桩（card 7 blocked/interaction）。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked",
                                           bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "qid": "Q-1", "answerable": True, "kind": "question",
        "questions": [q0]})


def test_execute_answer_free_text(monkeypatch):
    """非序号文本 + allow_other → other 形态提交自定义回答。"""
    _stub_question(monkeypatch, {"id": "q_0", "allow_other": True,
                                 "options": [{"id": "opt_a", "label": "A"}]})
    answered = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda proj, card, qid, answers:
                        answered.append((qid, answers)) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "用 sqlite 就行"]}, "ou_x")
    assert answered == [("Q-1", [{"wire": "q_0", "kind": "other",
                                  "text": "用 sqlite 就行"}])]
    assert "已收下" in r


def test_execute_answer_multi_select(monkeypatch):
    """逗号多序号 + multi_select → multi 形态提交 option_ids。"""
    _stub_question(monkeypatch, {"id": "q_0", "multi_select": True,
                                 "options": [{"id": "a", "label": "A"},
                                             {"id": "b", "label": "B"},
                                             {"id": "c", "label": "C"}]})
    answered = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda proj, card, qid, answers:
                        answered.append((qid, answers)) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "1,3"]}, "ou_x")
    assert answered == [("Q-1", [{"wire": "q_0", "kind": "multi",
                                  "option_ids": ["a", "c"]}])]
    assert "已收下" in r and "A" in r and "C" in r


def test_execute_answer_multi_index_on_single_select_rejected(monkeypatch):
    """单选题回多序号：拒绝并提示（不提交）。"""
    _stub_question(monkeypatch, {"id": "q_0",
                                 "options": [{"id": "a", "label": "A"},
                                             {"id": "b", "label": "B"}]})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "1,2"]}, "ou_x")
    assert called == [] and "多选" in r


def test_execute_answer_text_requires_allow_other(monkeypatch):
    """不允许自定义输入的选题：文本作答拒绝，回列选项序号。"""
    _stub_question(monkeypatch, {"id": "q_0", "allow_other": False,
                                 "options": [{"id": "opt_a", "label": "A"}]})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "自由发挥"]}, "ou_x")
    assert called == [] and "序号" in r


def test_execute_answer_index_out_of_range(monkeypatch):
    """越界序号：报错并回列可选序号。"""
    _stub_question(monkeypatch, {"id": "q_0",
                                 "options": [{"id": "opt_a", "label": "A"},
                                             {"id": "opt_b", "label": "B"}]})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "5"]}, "ou_x")
    assert called == [] and "序号无效" in r and "2)B" in r


def test_execute_answer_approval_kind_hints_agree(monkeypatch):
    """审批等待收到「作答」：引导改用「同意/拒绝 卡号」（不再落到 board 报错）。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked",
                                           bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "kind": "approval", "approval_id": "AP-1",
        "answerable": True})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "1"]}, "ou_x")
    assert called == [] and "同意 7" in r and "拒绝 7" in r


def test_execute_answer_not_answerable(monkeypatch):
    """不可远程作答（会话非平台自持）：引导去 dsh 会话窗口（站点会话窗也答不了）。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked",
                                           bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "kind": "", "answerable": False})
    called = []
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(), {"action": "answer",
                                           "groups": ["7", "1"]}, "ou_x")
    assert called == [] and "dsh 会话窗口作答" in r and "站点会话窗口" not in r


def test_execute_agree_and_deny(monkeypatch):
    """同意/拒绝审批：decision/scope 映射（会话尾缀→scope=session）。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked",
                                           bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "kind": "approval", "approval_id": "AP-1",
        "answerable": True})
    calls = []
    monkeypatch.setattr(board, "answer_approval",
                        lambda proj, card, aid, decision, scope="":
                        calls.append((aid, decision, scope)) or None)
    r = feishu.execute_intent(_binding(),
                              {"action": "agree", "groups": ["7", None]}, "ou_x")
    assert calls == [("AP-1", "approved", "")] and "已批准" in r
    r = feishu.execute_intent(_binding(),
                              {"action": "agree", "groups": ["7", "会话"]}, "ou_x")
    assert calls[-1] == ("AP-1", "approved", "session") and "会话内" in r
    r = feishu.execute_intent(_binding(),
                              {"action": "deny", "groups": ["7"]}, "ou_x")
    assert calls[-1] == ("AP-1", "rejected", "") and "已拒绝" in r


def test_execute_agree_requires_approval_pending(monkeypatch):
    """非审批等待（如提问）收到「同意」：拒绝并引导正确指令。"""
    _patch_projects(monkeypatch, [_proj(2, "touchstone")])
    monkeypatch.setattr(db, "list_board_cards",
                        lambda pid: [_card(7, 2, "登录鉴权", col="blocked",
                                           bk="interaction")])
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: {
        "pending": True, "qid": "Q-1", "kind": "question", "answerable": True,
        "questions": [{"id": "q_0", "options": [{"id": "opt_a", "label": "A"}]}]})
    called = []
    monkeypatch.setattr(board, "answer_approval",
                        lambda *a, **k: called.append(a) or None)
    r = feishu.execute_intent(_binding(),
                              {"action": "agree", "groups": ["7", None]}, "ou_x")
    assert called == [] and "审批" in r and "作答 7" in r


def test_help_text_documents_new_intents():
    assert "同意" in feishu.HELP_TEXT and "拒绝" in feishu.HELP_TEXT
    assert "作答" in feishu.HELP_TEXT
    # L1（2026-10-07）：多子题「题号:值」语法与卡片点选必须写进帮助文案——
    # 第二档实现了语法却没写指令集，用户无从发现（实障：用户反馈「没有实现」）
    assert "题号:值" in feishu.HELP_TEXT and "1:2" in feishu.HELP_TEXT
    assert "卡片上逐题点选" in feishu.HELP_TEXT


# ---------- DM 交互卡片点击回调（card.action.trigger） ----------

def _card_evt(eid="ev1", open_id="ou_x", value=None):
    """card.action.trigger 载荷（schema 2.0 回调体，ws 与 HTTP 同构）。"""
    return {"schema": "2.0", "header": {"event_id": eid,
                                        "event_type": "card.action.trigger"},
            "event": {"operator": {"open_id": open_id},
                      "action": {"tag": "button", "value": value or {}}}}


def _stub_card_env(monkeypatch, answer=None, approval=None):
    """卡片回调环境：绑定/找卡/交互缓存打桩，收 rest_send_text 与两个执行器。
    连点选暂存一起清（模块级内存态，跨用例隔离）。"""
    _mq_reset()
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1,
                                     "default_project_id": 2})
    monkeypatch.setattr(feishu, "_find_user_card",
                        lambda uid, key: ((_proj(2, "touchstone"),
                                           _card(7, 2, "登录鉴权", col="blocked",
                                                 bk="interaction")), ""))
    sent, calls = [], {"answer": [], "approval": []}
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg=None: sent.append(text))
    if answer is not None:
        monkeypatch.setattr(board, "interaction_of_sid", answer)
        monkeypatch.setattr(board, "answer_interaction",
                            lambda proj, card, qid, a:
                            calls["answer"].append((qid, a)) or None)
    if approval is not None:
        monkeypatch.setattr(board, "interaction_of_sid", approval)
        monkeypatch.setattr(board, "answer_approval",
                            lambda proj, card, aid, d, scope="":
                            calls["approval"].append((aid, d, scope)) or None)
    return sent, calls


def test_card_action_answer_click(monkeypatch):
    """选项按钮：t=a + 序号 → 与文本指令同一条作答路径，回执 DM 文本 + 成功 toast。"""
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: {
        "pending": True, "qid": "Q-1", "kind": "question", "answerable": True,
        "questions": [{"id": "q_0", "options": [{"id": "opt_a", "label": "A"},
                                                {"id": "opt_b", "label": "B"}]}]})
    toast = feishu._on_card_action(
        _card_evt(value={"t": "a", "c": 7, "i": 2}), _CFG)
    assert calls["answer"] == [("Q-1", [{"wire": "q_0", "kind": "single",
                                         "option_id": "opt_b"}])]
    assert sent and "已收下" in sent[-1]
    assert toast and toast["toast"]["type"] == "success"


def test_card_action_approval_clicks(monkeypatch):
    """审批三按钮：p/s/d → decision/scope 映射（与文本指令同路径）。"""
    st = lambda sid: {"pending": True, "kind": "approval",
                      "approval_id": "AP-1", "answerable": True}
    for t, want in (("p", ("AP-1", "approved", "")),
                    ("s", ("AP-1", "approved", "session")),
                    ("d", ("AP-1", "rejected", ""))):
        sent, calls = _stub_card_env(monkeypatch, approval=st)
        toast = feishu._on_card_action(
            _card_evt(eid=f"ev_{t}", value={"t": t, "c": 7}), _CFG)
        assert calls["approval"] == [want], t
        assert toast["toast"]["type"] == "success"


def test_card_action_unbound(monkeypatch):
    """未绑定点击：DM 引导绑定文案，不触执行器。"""
    monkeypatch.setattr(db, "get_feishu_binding_by_open", lambda oid: None)
    sent, calls = [], {"answer": [], "approval": []}
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg=None: sent.append(text))
    monkeypatch.setattr(board, "answer_interaction",
                        lambda *a, **k: calls["answer"].append(a) or None)
    toast = feishu._on_card_action(
        _card_evt(eid="ev_unbound", open_id="ou_none",
                  value={"t": "a", "c": 7, "i": 1}), _CFG)
    assert calls["answer"] == [] and sent and "绑定" in sent[-1]
    assert toast["toast"]["type"] == "error"


def test_card_action_dedup(monkeypatch):
    """同一 event_id 重推（飞书会重试）：执行器只跑一次。"""
    sent, calls = _stub_card_env(monkeypatch, approval=lambda sid: {
        "pending": True, "kind": "approval", "approval_id": "AP-1"})
    feishu._EVT_SEEN.clear()
    feishu._EVT_SEEN_SET.clear()
    evt = _card_evt(eid="ev_dup", value={"t": "p", "c": 7})
    feishu._on_card_action(evt, _CFG)
    feishu._on_card_action(evt, _CFG)
    assert len(calls["approval"]) == 1


def test_card_sdk_model_to_dict(monkeypatch):
    """SDK P2CardActionTrigger 模型（长连接 event 帧的真实入口）→ dict →
    _on_card_action 全链路：选项按钮作答成功。"""
    pytest.importorskip("lark_oapi")
    from lark_oapi.event.dispatcher_handler import P2CardActionTrigger
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: {
        "pending": True, "qid": "Q-1", "kind": "question", "answerable": True,
        "questions": [{"id": "q_0", "options": [{"id": "opt_a", "label": "A"}]}]})
    sdk_evt = P2CardActionTrigger({
        "header": {"event_id": "ev_sdk1"},
        "event": {"operator": {"open_id": "ou_x"},
                  "action": {"tag": "button",
                             "value": {"t": "a", "c": 7, "i": 1}}}})
    toast = feishu._on_card_action(feishu._card_sdk_to_dict(sdk_evt), _CFG)
    assert calls["answer"] == [("Q-1", [{"wire": "q_0", "kind": "single",
                                         "option_id": "opt_a"}])]
    assert toast["toast"]["type"] == "success" and sent


def test_card_action_stale_interaction(monkeypatch):
    """提问已不在等待（过期/已答）：错误 toast + DM 文本说明。"""
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: None)
    toast = feishu._on_card_action(
        _card_evt(value={"t": "a", "c": 7, "i": 1}), _CFG)
    assert calls["answer"] == []
    assert toast["toast"]["type"] == "error"
    assert sent and "等待" in sent[-1]


def _mq_reset():
    """清多子题「卡片逐题点选」暂存（模块级内存态：用例间必须隔离，
    否则上一例的暂存会把下一例的缺题补齐，测试互相污染）。"""
    feishu._MQ_STAGE.clear()


def _two_question_state():
    return {"pending": True, "qid": "Q-1", "kind": "question", "answerable": True,
            "questions": [
                {"id": "q_0", "options": [{"id": "opt_a", "label": "A"},
                                          {"id": "opt_b", "label": "B"}]},
                {"id": "q_1", "multi_select": True, "allow_other": True,
                 "options": [{"id": "c1", "label": "C1"},
                             {"id": "c2", "label": "C2"}]}]}


def _mq_evt(eid, no, option=None, options=None, form=None, cid=7, tag="select_static"):
    """逐题点选回调载荷：behaviors 的 value 带 t=mq/c/n；所选值三路——
    单选根级下拉 `action.option`（官方《下拉选择-单选》回调示例）；
    多选走**单题 mini 表单**提交 → `action.form_value[<组件 name>]`（数组，
    官方《下拉选择-多选》回调示例）；`options` 仅为兼容别种回传形态保留。"""
    action = {"tag": tag, "value": {"t": "mq", "c": cid, "n": no}}
    if option is not None:
        action["option"] = option
    if options is not None:
        action["options"] = options
    if form is not None:
        action["form_value"] = form
    return {"schema": "2.0", "header": {"event_id": eid},
            "event": {"operator": {"open_id": "ou_x"}, "action": action}}


def test_card_action_multi_click_stages_then_submits(monkeypatch):
    """逐题点选：第 1 题只暂存（成功 toast 带进度，**不送达**），第 2 题点完
    整批一次提交（kimi answers 缺项即未答，逐题回调拼不了批）。
    第 2 题是**多选**，走单题 mini 表单提交（form_value 数组）。"""
    _mq_reset()
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: _two_question_state())
    t1 = feishu._on_card_action(_mq_evt("ev_mq1", 1, option="2"), _CFG)
    assert calls["answer"] == []                       # 未答满不提交
    assert t1["toast"]["type"] == "success" and "1/2" in t1["toast"]["content"]
    assert sent == []                                  # 未答满不发 DM（少噪音）
    t2 = feishu._on_card_action(
        _mq_evt("ev_mq2", 2, tag="button", form={"mq7_2": ["1", "2"]}), _CFG)
    assert calls["answer"] == [("Q-1", [
        {"wire": "q_0", "kind": "single", "option_id": "opt_b"},
        {"wire": "q_1", "kind": "multi", "option_ids": ["c1", "c2"]}])]
    assert t2["toast"]["type"] == "success"
    assert sent and "已收下" in sent[-1]
    assert feishu._MQ_STAGE == {}                      # 送达后清桶


def test_card_action_multi_click_reject_bad_payloads(monkeypatch):
    """异常载荷各自回执且**不提交**：没带 option（未知选了哪项）、序号越界、
    单选给多个、题号无效。"""
    _mq_reset()
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: _two_question_state())
    t = feishu._on_card_action(_mq_evt("ev_mq3", 1), _CFG)          # 无 option
    assert calls["answer"] == [] and t["toast"]["type"] == "error"
    assert sent and "没收到你选的选项" in sent[-1]
    t = feishu._on_card_action(_mq_evt("ev_mq4", 1, option="9"), _CFG)
    assert calls["answer"] == [] and "选项序号无效" in sent[-1]
    t = feishu._on_card_action(_mq_evt("ev_mq5", 1, option=["1", "2"]), _CFG)
    assert calls["answer"] == [] and "单选" in sent[-1]
    t = feishu._on_card_action(_mq_evt("ev_mq6", 5, option="1"), _CFG)
    assert calls["answer"] == [] and "题号无效" in sent[-1]
    assert feishu._MQ_STAGE == {}                      # 异常路径不留脏暂存


def test_card_action_multi_click_stale_or_unanswerable(monkeypatch):
    """提问已收口 / 不可远程作答：明确回执，不写暂存。"""
    _mq_reset()
    sent, _ = _stub_card_env(monkeypatch, answer=lambda sid: None)
    t = feishu._on_card_action(_mq_evt("ev_mq7", 1, option="1"), _CFG)
    assert t["toast"]["type"] == "error" and "没有等待中的提问" in sent[-1]
    sent2, _ = _stub_card_env(monkeypatch, answer=lambda sid: {
        "pending": True, "qid": "Q-1", "kind": "question", "answerable": False,
        "questions": _two_question_state()["questions"]})
    t = feishu._on_card_action(_mq_evt("ev_mq8", 1, option="1"), _CFG)
    assert t["toast"]["type"] == "error"
    assert sent2 and "不支持远程作答" in sent2[-1]
    assert feishu._MQ_STAGE == {}


def test_card_action_multi_click_multiselect_needs_form_value(monkeypatch):
    """多选提交帧缺组件值（form_value 里没有该题的 name）→ 回执点名改用文本指令，
    不提交也不写暂存（取不到选了哪几项时绝不猜）。"""
    _mq_reset()
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: _two_question_state())
    t = feishu._on_card_action(
        _mq_evt("ev_mq_fv", 2, tag="button", form={"别的组件": ["1"]}), _CFG)
    assert calls["answer"] == [] and t["toast"]["type"] == "error"
    assert sent and "没收到你选的选项" in sent[-1]
    assert feishu._MQ_STAGE == {}


def _one_multiselect_state():
    """单题多选提问（n=1）：卡片上是一个 mini 表单，回调 t=mq/n=1 即单题送达。"""
    return {"pending": True, "qid": "Q-1", "kind": "question", "answerable": True,
            "questions": [{"id": "q_0", "multi_select": True, "allow_other": True,
                           "options": [{"id": "m1", "label": "M1"},
                                       {"id": "m2", "label": "M2"},
                                       {"id": "m3", "label": "M3"}]}]}


def test_card_action_multi_click_single_multiselect_submits(monkeypatch):
    """单题多选 mini 表单提交（2026-10-07 第四档）：n=1 点满即送达——
    `form_value[组件 name]` 数组 → kind multi 的 option_ids（序号换当前白名单 id）。"""
    sent, calls = _stub_card_env(monkeypatch,
                                 answer=lambda sid: _one_multiselect_state())
    t = feishu._on_card_action(
        _mq_evt("ev_mq_s1", 1, tag="button", form={"mq7_1": ["1", "3"]}), _CFG)
    assert calls["answer"] == [("Q-1", [{"wire": "q_0", "kind": "multi",
                                         "option_ids": ["m1", "m3"]}])]
    assert t["toast"]["type"] == "success" and "已送达" in t["toast"]["content"]
    assert sent and "已收下" in sent[-1]
    assert feishu._MQ_STAGE == {}                      # 送达后清桶


def test_card_action_multi_click_single_select_rejected(monkeypatch):
    """单题单选没有 t=mq 控件（走 t=a 选项按钮）：收到即视为过期卡/伪造，明确纠正，
    不把单选点击当多选提交。"""
    _mq_reset()
    st = {"pending": True, "qid": "Q-1", "kind": "question", "answerable": True,
          "questions": [{"id": "q_0", "options": [{"id": "a", "label": "A"}]}]}
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: st)
    t = feishu._on_card_action(_mq_evt("ev_mq_s2", 1, option="1"), _CFG)
    assert calls["answer"] == [] and t["toast"]["type"] == "error"
    assert sent and "单选题" in sent[-1]


def test_card_action_multi_click_single_multiselect_needs_form_value(monkeypatch):
    """单题多选提交帧缺组件值：回执点名文本指令，不提交也不写暂存
    （取不到选了哪几项时绝不猜）。"""
    _mq_reset()
    sent, calls = _stub_card_env(monkeypatch,
                                 answer=lambda sid: _one_multiselect_state())
    t = feishu._on_card_action(
        _mq_evt("ev_mq_s3", 1, tag="button", form={"别的组件": ["1"]}), _CFG)
    assert calls["answer"] == [] and t["toast"]["type"] == "error"
    assert sent and "没收到你选的选项" in sent[-1]
    assert feishu._MQ_STAGE == {}


def test_card_action_multi_click_ignores_qid_change(monkeypatch):
    """暂存按 (卡号, qid) 分桶：提问换了 qid ⇒ 旧点选不参与新提问的整批送达
    （新 qid 下点一题仍不齐，不得把上一轮的点选拼进来）。"""
    _mq_reset()
    sent, calls = _stub_card_env(monkeypatch, answer=lambda sid: _two_question_state())
    t = feishu._on_card_action(_mq_evt("ev_mq9", 1, option="1"), _CFG)
    assert "1/2" in t["toast"]["content"] and calls["answer"] == []
    st = _two_question_state()
    st["qid"] = "Q-2"                                  # 新提问
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: st)
    t = feishu._on_card_action(
        _mq_evt("ev_mq10", 2, tag="button", form={"mq7_2": ["1"]}), _CFG)
    assert calls["answer"] == []                       # Q-2 桶只有第 2 题
    assert "1/2" in t["toast"]["content"]              # 进度按新桶算，不蹭旧桶
    assert not any("已收下" in s for s in sent)


def test_card_sdk_model_to_dict_carries_option():
    """SDK 模型 → dict：下拉所选值 option/options 一并透传（长连接上的点选入口）。"""
    pytest.importorskip("lark_oapi")
    from lark_oapi.event.dispatcher_handler import P2CardActionTrigger
    sdk_evt = P2CardActionTrigger({
        "header": {"event_id": "ev_sdk_opt"},
        "event": {"operator": {"open_id": "ou_x"},
                  "action": {"tag": "select_static", "option": "2",
                             "value": {"t": "mq", "c": 7, "n": 1}}}})
    d = feishu._card_sdk_to_dict(sdk_evt)
    assert d["event"]["action"]["option"] == "2"
    assert d["event"]["action"]["value"] == {"t": "mq", "c": 7, "n": 1}


def test_ws_frame_routing_card_and_event(monkeypatch):
    """ws 子类帧路由：CARD 帧进 card_handler（1.7.3 原版直接丢弃），EVENT 帧走
    原事件分发，均回写响应帧。"""
    pytest.importorskip("lark_oapi")
    import asyncio
    from lark_oapi.ws.pb.pbbp2_pb2 import Frame
    cards, events = [], []
    client = feishu._make_ws_client(
        {"app_id": "cli_x", "app_secret": "s"},
        event_handler=lambda data: events.append(data) or {},
        card_handler=lambda data: cards.append(data) or {"toast": {"type": "success"}})
    async def _fake_write(frame):
        client.wrote = getattr(client, "wrote", 0) + 1
    monkeypatch.setattr(client, "_write_message", _fake_write)

    def _frame(mtype, payload):
        f = Frame()
        f.SeqID, f.LogID, f.service, f.method = 1, 1, 1, 1  # proto 必填字段
        for k, v in (("type", mtype), ("message_id", "m1"),
                     ("trace_id", "t1"), ("sum", "1"), ("seq", "0")):
            h = f.headers.add()
            h.key, h.value = k, v
        f.payload = payload
        return f

    asyncio.run(client._handle_data_frame(
        _frame("card", json.dumps({"header": {"event_id": "e1"}}).encode())))
    assert len(cards) == 1 and client.wrote == 1       # CARD 进卡片 handler 并回帧

    class _FakeEventHandler:
        def _do_without_validation(self, pl):
            events.append(pl)
            return {}
    client._event_handler = _FakeEventHandler()
    asyncio.run(client._handle_data_frame(
        _frame("event", b'{"e": 1}')))
    assert len(events) == 1 and cards and not len(cards) > 1  # EVENT 走事件分发

    async def _boom(*a, **k):
        raise AssertionError("未知帧类型不应进任何 handler")
    asyncio.run(client._handle_data_frame(
        _frame("other", b"{}")))
    assert client.wrote == 2                           # 未知类型：仅父类兜底路径
