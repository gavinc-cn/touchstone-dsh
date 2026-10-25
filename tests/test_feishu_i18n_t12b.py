#!/usr/bin/env python3
"""Task 12b：飞书群推送/接入自检/媒体/看板指令/slash·help 本地化 —— Python 验收测试。

判据（与 `backend/test/feishu-i18n-t12b.test.mjs` 镜像，双端共用同一组 golden）：
  ① **zh 逐字节保全**：无偏好 / `TS_I18N=0` 时，代表性出站 payload（群推送文本与
     outbox payload / 接入卡 / 自检 DM / 看板指令回执 / 帮助回复 / slash 权限卡）的
     UTF-8 sha256 与改动前 HEAD（`cdf050f`）**逐字节相同**（golden 由改动前源码跑
     同一组 ctx 抓取，见 task-12b-report.md）。
  ② **英文面（实际 payload，不数词条）**：同一组 ctx + `lang='en'` 的渲染结果逐字
     断言，并与 Node 孪生**同一组 sha256**（`EN_GOLDEN`）对齐——两端同一 payload。
  ③ **语言源（R22）**：
     - 群/项目推送 = **项目所有者**（`project_lang(project_id)`）；
     - 接入卡/自检/媒体/看板/帮助/slash = **收件人（绑定用户）**；
     - 无偏好 / 坏值 / 读库异常 ⇒ `zh`；`TS_I18N=0` ⇒ `zh` 且**零偏好读库**。
  ④ **R23**：slash 指令**注册 schema** 保持中文（`SLASH_COMMANDS` 说明与
     `_slash_description` 的 `zh_cn` 不动），只本地化回复/帮助/权限卡。

全程离线：REST/DB 均以桩注入，绝不发真实飞书请求。
"""
import hashlib
import json
import pathlib
import re
import time

import pytest

import db
import feishu
import feishu_conv
import i18n

# 改动前 HEAD（cdf050f）同 ctx 的 UTF-8 sha256（抓取脚本见报告；勿手改）
ZH_GOLDEN = {
    "push_group": "ea77f449188f24b4ee37351c104ff2f0b717fd88831b13a418174f43a3009679",
    "push_payload": "88ffc2130423fdee230b5559f782b0384221a9db3cdd4572ec69be06aeb4b477",
    "setup_card": "815792f877b10a143eb3a6c152299a3e583b8487773dda9225520b3e7dd542bb",
    "doctor_msg": "88af92fae4dbf39bbf3abdd55c722510c4030f48e81400e9b885298da562b0f1",
    "board_card_detail": "4df5b967f149d8055ab899bcb558745977538db633f1cf5491883ecc74ded1ea",
    "help_reply": "8ce024e221ea301186e6f718dd0a1402c007c829090ae136feedab4ba5a585bc",
    "slash_perm_card": "576b947afa4d62a0dce7b4a23ad710699671c21b1834bc835c2d61337208633a",
}
# 同一组 ctx 的英文渲染 sha256（Node 孪生测试断言同一组常量 ⇒ 两端 payload 逐字节相同）
EN_GOLDEN = {
    "push_group": "39db043790eeac1966678f34cac3b7103429e2a464d16748241578f430caa1e2",
    "push_payload": "3af5c1513405cd067564dfd120f1db44d6e13458409c4e2b381c91a660000e2d",
    "setup_card": "78fdb8b2d871b39b29d1c3d4fcf655c8d64a254c98b5838ea5e0f3671e7ae3b0",
    "doctor_msg": "6cb26cd7092b126cfd7f39da71e0b55c49611dab0b1c50573d7bc134ff80a18e",
    "board_card_detail": "97a34a8de511e2fb61df8f5bffceda049fff6148c0d9f3240f9f2abe054e5283",
    "help_reply": "68893a059d5b8afeaec1a0fa81cf27f11eb395af87bb09fe28955d5e8e32d189",
    "slash_perm_card": "5563b42b600291a8595264abda962791069f7eb85d67e56dcae7426f2b7f64db",
}
# 修复轮：doctor「发送测试消息」DM 的 en sha256（Node 孪生断言同一常量）
EN_DOCTOR_PROBE_SHA = "431bff5f5264dbb635814cd90aabdf3ca8afea31e3abba8a5013296cf737c080"

HAN = re.compile(r"[\u4e00-\u9fff]")
# 英文译文里允许保留的中文：飞书**指令词**（协议 token；R23 注册 schema 仍是中文）
PROTOCOL_TOKENS = (
    "新建会话", "绑定会话", "解绑会话", "默认项目",
    "帮助", "接入", "绑定", "解绑", "当前", "项目", "会话", "状态", "卡片",
    "通过", "驳回", "作答", "同意", "拒绝", "「设置」",
)

ZH_PUSH_CTX = {
    "card_id": 7, "title": "登录接口调试", "kind": "question",
    "question": "用哪个方案？", "options": ["方案甲", "方案乙"],
    "multi_select": False, "allow_other": False, "answerable": True,
    "questions_count": 1,
}
EN_PUSH_CTX = {
    "card_id": 7, "title": "Login API", "kind": "question",
    "question": "Which plan?", "options": ["Plan A", "Plan B"],
    "multi_select": False, "allow_other": False, "answerable": True,
    "questions_count": 1,
}
# 多子题 / 审批推送的 en 渲染（T12b 修复轮补的 golden；Node 孪生断言同一组 sha256）
EN_MULTI_PUSH_CTX = {
    "card_id": 12, "title": "Multi-question card", "kind": "question",
    "answerable": True,
    "questions": [
        {"header": "Plan", "question": "Which plan?",
         "options": [{"label": "Plan A", "description": "faster"},
                     {"label": "Plan B"}]},
        {"header": "Scope", "question": "Which scope?",
         "options": ["Small", "Large"], "multi_select": True,
         "allow_other": True},
    ],
}
EN_APPROVAL_PUSH_CTX = {"card_id": 9, "title": "Approval card",
                        "kind": "approval", "tool": "Bash",
                        "action": "run tests", "input": "npm test"}
EN_MULTI_PUSH_SHA = "61c5ab10a6c5a0f04e8da275b10dd3a2e1240e4d862fb8b83fc773447ea815da"
EN_APPROVAL_PUSH_SHA = "dacdf313e9796fad67e8871051b67f0d9e9a118ec336a462d93901f670fd60d7"
ZH_BOARD = ({"name": "对拍项目"},
            {"id": 9, "title": "待审卡片", "column_key": "blocked",
             "block_text": "等依赖", "last_error": "timeout"})
EN_BOARD = ({"name": "Demo"},
            {"id": 9, "title": "Pending card", "column_key": "blocked",
             "block_text": "waiting on dep", "last_error": "timeout"})
DOCTOR_ZH = {
    "summary": {"ok": 3, "fail": 1, "warn": 0, "skip": 4},
    "items": [
        {"key": "creds", "label": "应用凭据", "state": "fail",
         "detail": "未配置", "hint": "去设置页保存"},
        {"key": "token", "label": "token", "state": "ok", "detail": "ok",
         "hint": ""},
    ],
}
DOCTOR_EN = {
    "summary": {"ok": 3, "fail": 1, "warn": 0, "skip": 4},
    "items": [
        {"key": "creds", "label": "App credentials", "state": "fail",
         "detail": "not configured", "hint": "save them on the settings page"},
        {"key": "token", "label": "token", "state": "ok", "detail": "ok",
         "hint": ""},
    ],
}

UID = 992001          # 语言源/接线用例（高段避免与其它用例撞库）
UID_OWNER = 992002    # 群推送的项目所有者
BINDING = {"open_id": "ou_t12b", "user_id": UID, "cur_sid": "", "cur_title": "",
           "cur_bound_at": "", "cur_project_id": 0, "default_project_id": 0}


def sha_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha_obj(obj):
    return hashlib.sha256(
        json.dumps(obj, ensure_ascii=False).encode("utf-8")).hexdigest()


def assert_no_chinese(text, extra=()):
    """英文文案里除协议指令词外不得出现中文（防「词条缺失静默回落中文」）。"""
    cleaned = text
    for token in sorted(set(PROTOCOL_TOKENS) | set(extra), key=len, reverse=True):
        cleaned = cleaned.replace(token, "")
    assert not HAN.search(cleaned), f"英文面仍含中文: {text!r}"


@pytest.fixture()
def clean_prefs():
    def _wipe():
        with db.connect() as conn:
            conn.execute("DELETE FROM user_prefs WHERE user_id IN (?, ?)",
                         (UID, UID_OWNER))
    _wipe()
    yield
    _wipe()


def _set_lang(user_id, value):
    db.set_user_pref(user_id, 0, "lang", value)


def _fake_project(monkeypatch, name):
    monkeypatch.setattr(feishu.db, "get_project",
                        lambda pid: {"id": 1, "name": name} if pid == 1 else None)


def _push_text(monkeypatch, ctx, name, lang):
    _fake_project(monkeypatch, name)
    return feishu._render("blocked_interaction", ctx, 1, "https://ts.example", lang)


def _doctor_text(monkeypatch, lang):
    monkeypatch.setattr(feishu, "doctor", lambda uid, send_probe=False: (
        DOCTOR_ZH if lang == "zh" else DOCTOR_EN))
    captured = []
    monkeypatch.setattr(feishu, "_dm_text",
                        lambda oid, text, cfg: captured.append(text))
    feishu._setup_slow_action(1, "ou_x", "doctor", None, lang)
    assert len(captured) == 1, captured
    return captured[0]


def _payloads(monkeypatch, lang):
    """七类代表性 payload（中文语境用中文数据；英文语境用 ASCII 数据）。"""
    zh = lang == "zh"
    push = _push_text(monkeypatch, ZH_PUSH_CTX if zh else EN_PUSH_CTX,
                      "对拍项目" if zh else "Demo", lang)
    return {
        "push_group": push,
        "push_payload": feishu._payload(push),
        "setup_card": feishu.setup_card(1, "cli_new", "cli_old", "nonce1234",
                                        lang),
        "doctor_msg": _doctor_text(monkeypatch, lang),
        "board_card_detail": feishu._card_detail(*(ZH_BOARD if zh else EN_BOARD),
                                                 lang),
        "help_reply": feishu.help_text(lang),
        "slash_perm_card": feishu.slash_perm_card("cli_x", 7, lang),
    }


def _hashes(payloads):
    return {
        "push_group": sha_text(payloads["push_group"]),
        "push_payload": sha_text(payloads["push_payload"]),
        "setup_card": sha_obj(payloads["setup_card"]),
        "doctor_msg": sha_text(payloads["doctor_msg"]),
        "board_card_detail": sha_text(payloads["board_card_detail"]),
        "help_reply": sha_text(payloads["help_reply"]),
        "slash_perm_card": sha_obj(payloads["slash_perm_card"]),
    }


# ---------------------------------------------------------------------------
# ① zh 逐字节保全（无偏好 = 存量正常情形；TS_I18N=0 = 回滚开关）
# ---------------------------------------------------------------------------

def test_zh_payloads_byte_identical_to_head_without_pref(clean_prefs, monkeypatch):
    """无偏好用户：七类代表 payload 的 sha256 与改动前 HEAD 相同。"""
    assert feishu.user_lang(UID) == "zh"
    assert _hashes(_payloads(monkeypatch, "zh")) == ZH_GOLDEN


def test_event_meta_titles_have_api_entries():
    """三类事件标题（_EVENT_META 的运行时取值）都在 api 词条里（AST 门禁扫不到）。"""
    api = json.loads((pathlib.Path(__file__).resolve().parent.parent
                      / "i18n" / "en.json").read_text(encoding="utf-8"))["api"]
    for _, (title, _) in feishu._EVENT_META.items():
        assert title in api, title


def test_ts_i18n_off_forces_zh_and_zero_pref_reads(clean_prefs, monkeypatch):
    """`TS_I18N=0`：即使库里有 en 偏好也恒中文，且**零读库**（不只偏好读）。

    偏好桩**返回 en 而不抛错**（审查教训：一碰就抛会被 `user_lang` 的兜底吞掉，
    分辨不出「没读」与「读了但异常」）；断言真实调用次数为 0。
    另外把 `db.connect` 换成「记一笔就炸」：任何**别的**读库路径（绑定行/项目行/
    设置）也会立刻打红——覆盖审查「只数 get_user_prefs 不够」的要求。
    """
    _set_lang(UID, {"v": "en"})
    monkeypatch.setenv("TS_I18N", "0")
    pref_calls = []
    monkeypatch.setattr(
        db, "get_user_prefs",
        lambda uid, pid: pref_calls.append((uid, pid)) or {"lang": {"v": "en"}})
    all_reads = []

    def _counting_connect(*args, **kwargs):
        all_reads.append((args, kwargs))
        raise AssertionError("TS_I18N=0 时不应有任何读库")

    monkeypatch.setattr(db, "connect", _counting_connect)
    assert feishu.user_lang(UID) == "zh"
    assert feishu.project_lang(42) == "zh"
    assert pref_calls == [], f"TS_I18N=0 仍读偏好: {pref_calls}"
    assert _hashes(_payloads(monkeypatch, "zh")) == ZH_GOLDEN
    assert pref_calls == [], f"出站 builder 读了偏好: {pref_calls}"
    assert all_reads == [], f"出站 builder 读库: {all_reads}"

    # 入口级（真实语言解析点）：帮助回复、接入卡回调、媒体回执
    replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append(text))
    # R26 结转（T12c）：绑定行读口**本身**也要计数。旧版这里只换成「不抛错的桩」，
    # 于是 `_media_hint_lang` 若在 `TS_I18N` 判定之前读绑定行，`all_reads` 仍然为空
    # （桩不经过 `db.connect`）⇒ 零读库断言**不可 RED**。现在把这条读口变成判据：
    # 媒体早退档必须一次绑定行都不读；帮助/接入回执的正常身份读各保留 1 次（旧版同款）。
    binding_calls = []

    def _counting_binding(oid):
        binding_calls.append(oid)
        return dict(BINDING, open_id=oid)

    monkeypatch.setattr(db, "get_feishu_binding_by_open", _counting_binding)
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu.handle_message_event({
        "message_id": "m-t12b-zero", "chat_type": "p2p",
        "message_type": "text", "content": json.dumps({"text": "帮助"}),
        "sender_open_id": "ou_t12b"})
    assert replies == [feishu.HELP_TEXT]
    assert binding_calls == ["ou_t12b"], f"帮助入口的身份读次数变了: {binding_calls}"

    # 只判「接入卡回调」这一段：上一段已单独断言帮助入口的 1 次读
    binding_calls.clear()
    feishu._SETUP_NONCES.clear()
    try:
        feishu._SETUP_NONCES["n-zero"] = (UID, time.time() + 60)
        monkeypatch.setattr(feishu, "app_config",
                            lambda uid: {"app_id": "cli_x", "app_secret": "s"})
        monkeypatch.setattr(feishu, "restart_inbound_for", lambda uid: True)
        toast = feishu._on_setup_card_action(
            "ou_t12b", {"t": "fs", "a": "restart", "u": UID, "n": "n-zero"}, None)
        assert toast == {"toast": {"type": "success", "content": "已重连"}}
        # 接入卡回调也按「身份 open_id→binding」解析一次（与帮助入口同款）；
        # 旧版这里在 clear 前不断言，注释里的「各 1 次」没有被判据钉住。
        assert binding_calls == ["ou_t12b"], \
            f"接入卡回调的身份读次数变了: {binding_calls}"
    finally:
        feishu._SETUP_NONCES.clear()

    media_replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: media_replies.append(text))
    monkeypatch.setenv(feishu.MEDIA_ENV, "0")
    binding_calls.clear()          # 只判媒体早退档这一段
    feishu._handle_media_message(
        {"message_id": "m-zero-media", "message_type": "image",
         "content": json.dumps({"image_key": "img"}),
         "sender_open_id": "ou_t12b"}, None)
    assert media_replies == [feishu.MEDIA_TYPE_HINT]
    assert binding_calls == [], \
        f"TS_I18N=0 媒体早退档仍读绑定行: {binding_calls}"
    assert pref_calls == [], f"入口路径仍读偏好: {pref_calls}"
    assert all_reads == [], f"入口路径仍读库: {all_reads}"
    i18n.reset_cache()


def test_ts_i18n_off_project_lang_skips_project_row(monkeypatch):
    """`TS_I18N=0` 时 `project_lang` 在**读项目行之前**短路（群推送零读库）。"""
    monkeypatch.setenv("TS_I18N", "0")
    calls = []

    def boom(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("TS_I18N=0 时不应读库")

    monkeypatch.setattr(db, "get_project", boom)
    try:
        assert feishu.project_lang(42) == "zh"
    finally:
        i18n.reset_cache()
    assert calls == []


# ---------------------------------------------------------------------------
# ② 英文面（实际 payload + 双端同 sha）
# ---------------------------------------------------------------------------

def test_english_payloads_match_twin_golden(clean_prefs, monkeypatch):
    """同一 ctx 的 en 渲染：逐字断言代表行 + sha256 与 Node 孪生同常量。"""
    payloads = _payloads(monkeypatch, "en")
    push = payloads["push_group"]
    assert push.startswith("🤔 Card awaiting reply [Demo]\nCard #7 Login API\n")
    assert "agent question: Which plan?" in push
    assert "Reply 「作答 7 <option index>」 in Feishu to answer with an option" \
        in push
    assert push.endswith("Details: https://ts.example")

    card = payloads["setup_card"]
    assert card["header"]["title"]["content"] == "🔁 Feishu app changed"
    buttons = [e["text"]["content"] for e in card["body"]["elements"]
               if e.get("tag") == "button"]
    assert buttons == ["🔁 Switch to new app", "🔑 Generate bind code",
                       "🩺 Run self-check", "🧩 Apply config", "🚀 Publish"]
    assert "**Current app**: `cli_new`" in \
        card["body"]["elements"][0]["content"]
    assert "Running · bound to `cli_old`" in card["body"]["elements"][0]["content"]

    assert payloads["doctor_msg"] == (
        "🩺 Configuration self-check: ok 3 / fail 1 / warn 0 / skip 4\n"
        "· App credentials: not configured (save them on the settings page)")
    assert payloads["board_card_detail"] == (
        "Card #9 [Demo] Pending card\n"
        "Status: Blocked\n"
        "Blocked reason: waiting on dep\n"
        "Last error: timeout\n"
        "Reply 「作答 9 <option index|text>」 to answer; 「同意 9」/「拒绝 9」 "
        "for approvals; 「通过 9」 to approve; 「驳回 9 <comment>」 to send back")
    assert payloads["help_reply"].startswith("Touchstone commands (DM only):\n")
    assert "· 帮助 — this help" in payloads["help_reply"]
    assert payloads["slash_perm_card"]["header"]["title"]["content"] == \
        "🔑 Slash command permission required"
    assert _hashes(payloads) == EN_GOLDEN


def test_english_surface_has_no_fallback_chinese(clean_prefs, monkeypatch):
    """代表性英文面：除协议指令词外无中文（防缺词条静默回落）。"""
    payloads = _payloads(monkeypatch, "en")
    assert_no_chinese(payloads["push_group"])
    assert_no_chinese(json.dumps(payloads["setup_card"], ensure_ascii=False))
    assert_no_chinese(payloads["doctor_msg"])
    assert_no_chinese(payloads["board_card_detail"])
    assert_no_chinese(payloads["help_reply"])
    assert_no_chinese(json.dumps(payloads["slash_perm_card"],
                                 ensure_ascii=False))


# ---------------------------------------------------------------------------
# ③ 语言源接线（R22）
# ---------------------------------------------------------------------------

def test_push_uses_project_owner_language(clean_prefs, monkeypatch):
    """群/项目推送按项目所有者偏好（en），无偏好所有者 zh（逐字节 golden）。"""
    _set_lang(UID_OWNER, {"v": "en"})
    pid_en = db.insert_project(UID_OWNER, "proj-owner-en", "/tmp/t12b-own-en",
                               "dsh-plugin:/x", "/tmp/t12b-own-en")
    pid_zh = db.insert_project(UID, "proj-owner-zh", "/tmp/t12b-own-zh",
                               "dsh-plugin:/x", "/tmp/t12b-own-zh")
    sent = []
    monkeypatch.setattr(feishu, "hook_of", lambda project_id: {
        "target": "http://hook", "secret": "", "events": {"blocked_interaction"},
        "base_url": "https://ts.example", "user_id": UID_OWNER})
    monkeypatch.setattr(feishu.db, "feishu_outbox_push",
                        lambda *a, **kw: sent.append((a, kw)))
    try:
        feishu.push_event(pid_en, "blocked_interaction", EN_PUSH_CTX)
        text_en = json.loads(sent[-1][0][2])["content"]["text"]
        assert text_en.startswith("🤔 Card awaiting reply [proj-owner-en]")
        assert_no_chinese(text_en)
        # 控制线：无偏好所有者 ⇒ zh（与 golden 同一渲染器）
        feishu.push_event(pid_zh, "blocked_interaction", ZH_PUSH_CTX)
        text_zh = json.loads(sent[-1][0][2])["content"]["text"]
        assert text_zh.startswith("🤔 卡片等待回复 [proj-owner-zh]")
        assert "agent 提问：" in text_zh
    finally:
        db.delete_project(pid_en)
        db.delete_project(pid_zh)


def test_recipient_language_wiring(clean_prefs, monkeypatch):
    """接入卡/权限卡/看板/媒体/帮助均按**收件人（绑定用户）**偏好解析一次。"""
    _set_lang(UID, {"v": "en"})
    cards = []
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user",
                        lambda uid: dict(BINDING, open_id="ou_t12b"))
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: dict(BINDING, open_id=oid))
    monkeypatch.setattr(feishu, "inbound_status",
                        lambda uid: {"configured": True, "thread": True})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "cli_old")
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, card, cfg: cards.append(card))
    feishu._SETUP_NONCES.clear()
    assert feishu.send_setup_card(UID) == (True, "")
    assert cards[-1]["header"]["title"]["content"] == "🔁 Feishu app changed"
    assert feishu.send_slash_perm_card(UID) == (True, "")
    assert cards[-1]["header"]["title"]["content"] == \
        "🔑 Slash command permission required"

    # slash 权限卡回调：DM 与 toast 同语言；失败诊断也随收件人语言（T12b 修复轮）
    sent_text = []
    sync_calls = []
    monkeypatch.setattr(feishu, "_dm_text",
                        lambda oid, text, cfg: sent_text.append(text))
    monkeypatch.setattr(feishu, "sync_slash_commands",
                        lambda uid, lang="zh": sync_calls.append((uid, lang)) or {
                            "ok": True, "created": ["a"], "updated": [],
                            "kept": ["b"], "failed": []})
    toast = feishu._on_slash_perm_action("ou_t12b", {"u": UID}, None)
    assert sync_calls == [(UID, "en")]
    assert toast == {"toast": {"type": "success", "content": "Registration complete"}}
    assert sent_text[-1].startswith(
        "✅ Slash command registration complete: Created 1, updated 0, "
        "already up to date 1")
    assert_no_chinese(sent_text[-1])

    # 看板「状态」：入口解析一次、向下传
    pid = db.insert_project(UID, "proj-en-board", "/tmp/t12b-board",
                            "dsh-plugin:/x", "/tmp/t12b-board")
    binding = dict(BINDING, default_project_id=pid)
    try:
        reply = feishu.execute_intent(binding, {"action": "status",
                                                "groups": [None]}, "ou_t12b",
                                      None, feishu.user_lang(UID))
        assert reply.startswith("[proj-en-board] Tasks: running 0 / queued 0")
        assert "Board: To Do 0 In progress 0 Blocked 0 In review 0 Done 0" in reply
        assert_no_chinese(reply)
    finally:
        db.delete_project(pid)

    # 媒体回执（功能关闭档）按收件人语言
    replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append(text))
    monkeypatch.setenv(feishu.MEDIA_ENV, "0")
    feishu._handle_media_message(
        {"message_id": "m-en-media", "message_type": "image",
         "content": json.dumps({"image_key": "img"}),
         "sender_open_id": "ou_t12b"}, None)
    assert replies == ["This message type is not supported yet; send a text command"]
    assert_no_chinese(replies[0])

    # 帮助回复：入口一次解析
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu.handle_message_event({
        "message_id": "m-en-help", "chat_type": "p2p", "message_type": "text",
        "content": json.dumps({"text": "帮助"}), "sender_open_id": "ou_t12b"})
    assert replies[-1].startswith("Touchstone commands (DM only):")


def _doctor_stubs(monkeypatch):
    """doctor 走到「发测试消息」所需的最小离线桩（凭据/机器人/slash 全不触网）。"""
    cfg = {"app_id": "cli_probe", "app_secret": "s"}
    monkeypatch.setattr(feishu, "user_config", lambda uid: dict(cfg))
    monkeypatch.setattr(feishu, "_tenant_token", lambda c: "t")
    monkeypatch.setattr(feishu, "_rest", lambda method, path, **kw: {
        "bot": {"activate_status": 2, "app_name": "Bot"}})
    monkeypatch.setattr(feishu, "slash_status", lambda uid, lang="zh": {
        "configured": True, "desired": [], "remote": [], "extra": [],
        "need_scope": False, "error": ""})
    monkeypatch.setattr(feishu, "inbound_status",
                        lambda uid: {"configured": True, "thread": True})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "cli_probe")
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user",
                        lambda uid: {"open_id": "ou_t12b", "user_id": uid})
    sent = []
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: sent.append((oid, text)))
    return sent


def test_doctor_probe_dm_uses_recipient_language(clean_prefs, monkeypatch):
    """自检「发送测试消息」的 DM = 收件人语言（T12b 修复项；入口级，不是 builder）。

    en 全英文；zh 逐字节等于旧文案。另钉住「不探测 ⇒ 不读偏好」：不真发消息时
    语言解析必须延后（零新增读库）。
    """
    sent = _doctor_stubs(monkeypatch)
    feishu._LAST_PROBE_TS.pop(UID, None)
    try:
        _set_lang(UID, {"v": "en"})
        out = feishu.doctor(UID, send_probe=True)
        assert out["summary"]["fail"] == 0
        assert sent == [("ou_t12b",
                         "🔍 Touchstone config self-check: if you received this "
                         "message, the “send messages” permission is enabled.")]
        assert sha_text(sent[0][1]) == EN_DOCTOR_PROBE_SHA
        assert_no_chinese(sent[0][1])

        # zh 控制线：无偏好用户的消息逐字节等于旧文案
        _set_lang(UID, {"v": "zh"})
        feishu._LAST_PROBE_TS.pop(UID, None)
        feishu.doctor(UID, send_probe=True)
        assert sent[-1][1] == (
            "🔍 Touchstone 配置自检：收到这条消息说明「发消息」权限已开通。")

        # 不探测 ⇒ 不解析语言（偏好读计数为 0）
        pref_calls = []
        monkeypatch.setattr(
            db, "get_user_prefs",
            lambda uid, pid: pref_calls.append((uid, pid)) or {"lang": {"v": "en"}})
        feishu._LAST_PROBE_TS.pop(UID, None)
        feishu.doctor(UID, send_probe=False)
        assert pref_calls == [], f"未发消息却读了偏好: {pref_calls}"
    finally:
        feishu._LAST_PROBE_TS.pop(UID, None)


def test_setup_card_rest_failure_english_and_zh_unchanged(clean_prefs, monkeypatch):
    """`send_setup_card` 的 REST 失败：en 去掉内层中文前缀；zh 保持历史双前缀字节。

    审查实测 en 输出曾是 `Failed to send the card: 卡片发送失败：boom`（外层英文
    包装 + 内层中文前缀）。修复后 en 内层只留诊断，词条/外层文案不变。
    """
    _set_lang(UID, {"v": "en"})
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user",
                        lambda uid: dict(BINDING, open_id="ou_t12b"))
    monkeypatch.setattr(feishu, "inbound_status",
                        lambda uid: {"configured": True, "thread": False})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "")
    monkeypatch.setattr(
        feishu, "rest_send_card",
        lambda oid, card, cfg: (_ for _ in ()).throw(
            feishu.FeishuRestError("send failed code=230001", 230001)))
    feishu._SETUP_NONCES.clear()
    assert feishu.send_setup_card(UID) == (False, "send failed code=230001")

    replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append(text))
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: dict(BINDING, open_id=oid))

    def _setup(mid):
        feishu._MSG_SEEN.clear()
        feishu._MSG_SEEN_SET.clear()
        feishu.handle_message_event({
            "message_id": mid, "chat_type": "p2p", "message_type": "text",
            "content": json.dumps({"text": "接入"}),
            "sender_open_id": "ou_t12b"})
        return replies[-1]

    en = _setup("m-en-setup-fail")
    assert en == "Failed to send the card: send failed code=230001"
    assert_no_chinese(en)

    # zh 控制线：历史形态是「内层前缀 + 外层前缀」两次（存量 Node 用例也钉着它）
    _set_lang(UID, {"v": "zh"})
    zh = _setup("m-zh-setup-fail")
    assert zh == "卡片发送失败：卡片发送失败：send failed code=230001"


def test_slash_retry_failure_dm_english(clean_prefs, monkeypatch):
    """权限卡「重试注册」失败 DM：`slash_error_hint` 诊断随收件人语言（T12b 修复项）。

    zh 控制线证明默认路径逐字未变（设置页/对拍走默认 `lang="zh"`）。
    """
    err = feishu.FeishuRestError("REST /app_slash_commands code=99991672", 99991672)
    _set_lang(UID, {"v": "en"})
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: dict(BINDING, open_id=oid))
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "list_slash_commands",
                        lambda cfg: (_ for _ in ()).throw(err))
    sent = []
    monkeypatch.setattr(feishu, "_dm_text",
                        lambda oid, text, cfg: sent.append(text))
    out = feishu._on_slash_perm_action("ou_t12b", {"u": UID}, None)
    assert out == {"toast": {"type": "error",
                             "content": "Still unsuccessful; see the DM reply"}}
    assert sent[-1].startswith(
        "❌ Still unsuccessful: The app lacks the “app slash command” permission:")
    assert "Permission management" in sent[-1]
    assert_no_chinese(sent[-1])

    # zh 默认路径：三个业务码的引导逐字不变（设置页数据面仍走默认 zh）
    assert feishu.slash_error_hint(err) == feishu._SLASH_PERM_HINT
    assert feishu.slash_error_hint(err, "zh") == feishu._SLASH_PERM_HINT
    zh_out = feishu.sync_slash_commands(UID)
    assert zh_out["error"] == feishu._SLASH_PERM_HINT
    assert zh_out["need_scope"] is True
    # 另两个固定引导：en 无中文、zh 返回原串
    for code, hint in ((40000031, feishu._SLASH_ICON_HINT),
                       (99992402, feishu._SLASH_PARAM_HINT)):
        e = feishu.FeishuRestError("x", code)
        assert feishu.slash_error_hint(e, "zh") == hint
        assert_no_chinese(feishu.slash_error_hint(e, "en"))


def test_multi_question_and_approval_push_english_twin_sha(monkeypatch):
    """多子题 / 审批推送的 en 渲染（T12b 修复轮补 golden；Node 孪生断言同一 sha256）。"""
    multi = _push_text(monkeypatch, EN_MULTI_PUSH_CTX, "Demo", "en")
    approval = _push_text(monkeypatch, EN_APPROVAL_PUSH_CTX, "Demo", "en")
    assert sha_text(multi) == EN_MULTI_PUSH_SHA
    assert sha_text(approval) == EN_APPROVAL_PUSH_SHA
    assert multi.startswith(
        "🤔 Card awaiting reply [Demo]\nCard #12 Multi-question card\n"
        "agent questions (2 in total):")
    assert "[1/2 Plan]Which plan?" in multi
    assert "[2/2 Scope]Which scope?" in multi
    assert "(Multi-select; Custom: Other)" in multi
    assert "This question has 2 sub-questions" in multi
    assert_no_chinese(multi)
    assert approval == (
        "🤔 Card awaiting reply [Demo]\nCard #9 Approval card\n"
        "Approval request: run tests\nTool: Bash\nInput: npm test\n"
        "Reply 「同意 9」 in Feishu to approve, 「拒绝 9」 to reject; "
        "「同意 9 会话」 auto-approves similar calls in this session\n"
        "Details: https://ts.example")
    assert_no_chinese(approval)


def test_no_pref_bad_pref_db_error_fall_back_to_zh(clean_prefs, monkeypatch):
    """无偏好 / 坏值 / 读库异常 ⇒ 帮助与接入卡回执均为中文（且不抛错）。"""
    replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append(text))
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: dict(BINDING, open_id=oid))

    def _help(mid):
        feishu._MSG_SEEN.clear()
        feishu._MSG_SEEN_SET.clear()
        feishu.handle_message_event({
            "message_id": mid, "chat_type": "p2p", "message_type": "text",
            "content": json.dumps({"text": "帮助"}),
            "sender_open_id": "ou_t12b"})
        return replies[-1]

    assert _help("m-pref-none") == feishu.HELP_TEXT
    for bad in ({"v": "fr"}, {"v": ""}, "en", {"v": ["en"]}):
        db.set_user_pref(UID, 0, "lang", bad)
        assert _help(f"m-pref-bad-{str(bad)[:6]}") == feishu.HELP_TEXT

    def boom(uid, pid):
        raise RuntimeError("db down")

    monkeypatch.setattr(db, "get_user_prefs", boom)
    assert _help("m-pref-err") == feishu.HELP_TEXT


def test_media_receipts_and_composition_english(clean_prefs, monkeypatch, tmp_path):
    """媒体面（T12b 残留）：失败回执 + 截图 markdown/header 按收件人语言。"""
    _set_lang(UID, {"v": "en"})
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: dict(BINDING, open_id=oid))
    monkeypatch.setattr(feishu, "media_enabled", lambda: True)
    monkeypatch.setattr(feishu_conv, "enabled", lambda: True)
    replies = []
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append(text))
    monkeypatch.setattr(feishu, "_download_image", lambda *a, **kw: (
        _ for _ in ()).throw(feishu.MediaTooLarge("x")))
    feishu._handle_media_message(
        {"message_id": "m-en-too-big", "message_type": "image",
         "content": json.dumps({"image_key": "img"}),
         "sender_open_id": "ou_t12b"}, None)
    assert replies == ["Screenshot receive failed: Image too large (10MB per "
                       "image); compress it and send it again"]
    assert_no_chinese(replies[0])

    composed, err = feishu_conv._store_images(
        {"work_dir": str(tmp_path)}, "look",
        [{"data": b"\x89PNG", "mime": "image/png"}], "en")
    assert err == ""
    assert composed.startswith(
        "look\n\n[Feishu screenshot] The user sent 1 screenshot(s) from Feishu: \n")
    assert "![Feishu screenshot 1.png](" in composed
    assert_no_chinese(composed.split("![")[0])


# ---------------------------------------------------------------------------
# ④ R23：slash 注册 schema 保持中文
# ---------------------------------------------------------------------------

def test_slash_registration_schema_stays_chinese_r23(monkeypatch):
    """17 条注册说明与 `_slash_description` 的 zh_cn 一字不改（只回复/帮助本地化）。"""
    expected = [
        "查看可用指令", "绑定站点账号：/bind 绑定码", "解除站点账号绑定",
        "设置默认项目：/project 项目名", "查看默认项目与当前会话",
        "项目总览卡：点选设为默认项目", "默认项目最近会话：点选绑定",
        "在默认项目下新建会话并绑定：/new [标题]",
        "绑定已有会话：/use 序号|关键字|会话id前缀", "解绑当前会话（保留默认项目）",
        "查看任务与看板摘要：/status [项目名]",
        "查找卡片：/cards 关键字（id 前缀 / 标题包含）",
        "通过待审核卡片：/approve 卡片", "驳回卡片继续开发：/reject 卡片 意见",
        "回复 agent 提问：/answer 卡片 选项序号|文字",
        "批准挂起的工具审批：/agree 卡片 [session]",
        "拒绝挂起的工具审批：/deny 卡片",
    ]
    assert [d for _, d, _ in feishu.SLASH_COMMANDS] == expected
    for _, desc, _ in feishu.SLASH_COMMANDS:
        assert HAN.search(desc), desc
        assert feishu._slash_description(desc) == (
            {"default_value": desc, "i18n": {"zh_cn": desc}})
    # 设置页读取口的 desired 清单（T12d 数据面）同样是中文
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    desired = feishu.slash_status(1)["desired"]
    assert [d["description"] for d in desired] == expected
    # 英文帮助仍保留中文指令词（照英文说明发得出来）
    en_help = feishu.help_text("en")
    for token in ("帮助", "接入", "绑定", "解绑", "当前", "项目", "会话",
                  "新建会话", "绑定会话", "解绑会话", "默认项目", "状态",
                  "卡片", "通过", "驳回", "作答", "同意", "拒绝"):
        assert token in en_help, token


# ---------------------------------------------------------------------------
# ⑤ R26 结转（T12c）：apply/publish 慢动作 DM 的 en 入口级 + setup 内层整句 en
# ---------------------------------------------------------------------------

def test_setup_slow_apply_publish_dm_english_entry(clean_prefs, monkeypatch):
    """R26：`apply`/`publish` 慢动作结果 DM 的 en **入口级**文案（经按钮回调入口）。

    入口 `_on_setup_card_action` 按点击者偏好解析一次语言再交给后台慢动作；测试用
    同步 `Thread` 桩替掉 daemon 线程（不拼线程调度）。四个结果分支（apply/publish ×
    ok/fail）与「已收到」toast 逐一钉死；zh 控制线证明默认路径逐字节未变。
    """
    _set_lang(UID, {"v": "en"})
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: dict(BINDING, open_id=oid))
    sent = []
    monkeypatch.setattr(feishu, "_dm_text",
                        lambda oid, text, cfg: sent.append(text))
    out = {"apply": {"ok": True}, "publish": {"ok": True, "version": "1.2.3"}}
    monkeypatch.setattr(feishu, "provision_apply", lambda uid: out["apply"])
    monkeypatch.setattr(feishu, "provision_publish", lambda uid: out["publish"])

    class _SyncThread:
        def __init__(self, target=None, args=(), kwargs=None, **extra):
            self._target, self._args = target, args or ()

        def start(self):
            self._target(*self._args)

    monkeypatch.setattr(feishu.threading, "Thread", _SyncThread)
    feishu._SETUP_NONCES.clear()
    ok_toast = {
        "toast": {"type": "success",
                  "content": "Received; I will send the result to your DM shortly"}}
    try:

        def _click(action):
            nonce = f"n-{action}"
            feishu._SETUP_NONCES[nonce] = (UID, time.time() + 60)
            return feishu._on_setup_card_action(
                "ou_t12b", {"t": "fs", "a": action, "u": UID, "n": nonce}, None)

        assert _click("apply") == ok_toast
        assert sent[-1] == (
            "🧩 Configuration applied: bot ability / permissions / long-connection "
            "subscription / events / callbacks written (publish a new version for them "
            "to take effect).")
        assert _click("publish") == ok_toast
        assert sent[-1] == (
            "🚀 Submitted version 1.2.3 for publishing; a tenant admin must still "
            "approve it before it takes effect online.")
        out["apply"] = {"ok": False, "error": "boom"}
        out["publish"] = {"ok": False, "error": "boom"}
        # 失败分支同样先回「已收到」toast 再走慢动作（ACK 与结果无关）：
        # 旧版这里只调 _click 不断言，docstring 的「四个分支 + toast」有一半是空的。
        assert _click("apply") == ok_toast
        assert sent[-1] == "❌ Failed to apply configuration: boom"
        assert _click("publish") == ok_toast
        assert sent[-1] == "❌ Failed to submit for publishing: boom"
        assert_no_chinese("\n".join(sent))

        # zh 控制线：无偏好的默认路径逐字节等于旧文案
        _set_lang(UID, {"v": "zh"})
        out["apply"] = {"ok": True}
        assert _click("apply") == {
            "toast": {"type": "success",
                      "content": "已收到，结果稍后私聊发你"}}
        assert sent[-1] == (
            "🧩 配置补齐成功：机器人能力 / 权限 / 长连接订阅 / 事件 / "
            "回调已写入（需发布新版本生效）。")
    finally:
        feishu._SETUP_NONCES.clear()


def test_setup_card_inner_errors_english(clean_prefs, monkeypatch):
    """R26：`send_setup_card` 两条内层整句（未配凭据 / 未绑定）的 en 直接断言。

    此前只有 zh 用例钉住这两条（`tests/test_feishu_setup_card.py`）；修复轮把内层
    整句接上 `lang` 后，en 入口路径没有直接断言——本用例补上，并保留 zh 控制线。
    """
    _set_lang(UID, {"v": "en"})
    feishu._SETUP_NONCES.clear()
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    got = feishu.send_setup_card(UID)
    assert got == (
        False, "App credentials are not configured (App ID / App Secret); "
               "save them before sending the card")
    assert_no_chinese(got[1])

    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: None)
    got = feishu.send_setup_card(UID)
    assert got == (
        False, "No Feishu account is bound yet: generate a bind code on the "
               "settings page, then reply 「绑定 <code>」 in the bot DM")
    assert_no_chinese(got[1])

    # zh 控制线：默认路径逐字节不变
    _set_lang(UID, {"v": "zh"})
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    assert feishu.send_setup_card(UID) == (
        False, "未配置应用凭据（App ID / App Secret），先保存配置再发卡片")
    assert feishu._SETUP_NONCES == {}
