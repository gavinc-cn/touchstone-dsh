#!/usr/bin/env python3
"""Task 12a：飞书 DM 出站本地化 —— Python 侧验收测试。

三组判据：
  ① **zh 逐字节保全**（硬红线）：无偏好用户（存量正常情形）与 `TS_I18N=0` 下，
     代表性 payload（提问卡 / 审批卡 / 多题点选卡 / 方案文档 / 多题指引与校验 /
     指令回执 / 绑定回执 / 对话层回执）的 UTF-8 sha256 与 HEAD（31d1dc7）**逐字节
     相同**（golden 由 `git show 31d1dc7:…` 的旧实现跑同一组 ctx 抓取，见
     task-12a-report.md §zh-golden）。
  ② **英文面**：绑定用户偏好 `{"v":"en"}` 时，卡头/按钮/回执/对话层文案为英文；
    飞书**指令词**（作答/同意/拒绝/默认项目…）按协议要求保留中文（否则用户照英文
     说明发指令会不识别），门禁只放行这批协议词。
  ③ **语言源语义（R22）**：无偏好 / 坏值 / 读库异常 ⇒ `zh`；`TS_I18N=0` ⇒ `zh`
     且**不读库**；同一动作内 DM 与 toast 同语言。
另含词条门禁：本模块所有 `i18n.t("api", …)` 的 key 必须在 `i18n/en.json` 的 `api`
命名空间存在，且占位符与中文 key 一致（`%d`/`%s` 老式模板除外：其英文用 `{n}`/
`{token}`，由 `_num_text`/`_str_text` 插值）。
"""
import ast
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

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend_py"
HAN = re.compile(r"[\u4e00-\u9fff]")
PLACEHOLDER = re.compile(r"\{([A-Za-z_]\w*)\}", re.ASCII)

# HEAD（31d1dc7）上同一组 ctx 的输出 sha256（生成脚本见报告 §zh-golden；勿手改）
GOLDEN = {
    "approval_card": "15ce9ac0da8637592c97f2056eed0f945c82f0cb0c492aabe36fe2e288df76fe",
    "binding_invalid_receipt": "01cf9e7693da84284af1398915df13e85615fe56a99c0e07ec6bbeea1df2d5fe",
    "conv_current_text": "1e83a8f71fc9d460c2bec053d6e880d50f39c25b04a8a24d5bf48d0ef112938a",
    "conv_projects_text_empty": "0dc773f7e3385c0de5836d4e4df12961deca4b89cae5c48a955cd1295a15d6d6",
    "conv_rel_time_just_now": "de6785d99e028971c6bfb19dc4f6d17d572d196038f7a5d904ffd4c29b148f5a",
    "instruction_bind_reply": "84010a0d9a54f4d0c55d960dc4fd749e20147b30a1c4e209d4f52df6797ed6d4",
    "instruction_unbind_reply": "f0772d6370cc0a047b8f66d7ee4051fe0b7345c8e8bc942119e30bcb8717d047",
    "multi_answer_help": "c4bbb506ec2d6ed1ec8fcbe1e70f97c1c236d8e1d0c8ebf45ee9d374869ae1a9",
    "multi_answers_err": "c7cc684cfdd722c3a20070df3f6824e6ece98f7a1491a2e155465365a365b63b",
    "multi_card": "a04301c696c1cd222d899b63ed61f755bda7826cf5c6c1cafa80d71267346d37",
    "multi_hint": "f3d95646d415d34e1b4d6508834530d5bb0ef3f9ce32eda9166aebd702e2a648",
    "plan_doc_md": "8f567d19c734e17d28954c2c08a3fd928ad43e042a2afec415d8060efb37d5c6",
    "plan_question_md": "ee0f3bfa84d1834c44a2330387ffd20040ef17a9fa4b453a52e22afab1bb7f69",
    "question_card": "d7831a0720879f39d5d83daa4819246fe84edbdd03e652a19918bfb62cd97782",
}

# 英文译文里允许保留的中文：飞书**指令词**（协议 token，不能译）+ 协议占位符
PROTOCOL_TOKENS = (
    "新建会话", "绑定会话", "解绑会话", "默认项目",
    "帮助", "接入", "绑定", "解绑", "当前", "项目", "会话", "状态", "卡片",
    "通过", "驳回", "作答", "同意", "拒绝",
    # 站点侧栏标签（英文文案里指向尚未翻译的站点 UI，属**完整预期片段**而非单字放行）
    "「设置」",
)

# zh golden 用与抓取脚本（HEAD 31d1dc7）**完全相同**的 ctx（数据是中文，不译）
ZH_QUESTION_CTX = {
    "card_id": 7, "title": "登录鉴权", "kind": "question",
    "question": "选哪个场景？", "options": ["A 场景", "B 场景"], "answerable": True,
    "multi_select": False, "allow_other": False, "questions_count": 1,
}
ZH_APPROVAL_CTX = {
    "card_id": 12, "title": "改配置", "kind": "approval", "answerable": False,
    "action": "run_command", "tool": "bash", "input": "ls -la /tmp",
}
ZH_MULTI_CTX = {
    "card_id": 21, "title": "多题", "kind": "question", "answerable": True,
    "questions": [
        {"header": "范围", "question": "选哪个？", "options": ["红", "绿", "蓝"],
         "multi_select": False},
        {"header": "补充", "question": "还要什么？", "options": ["甲", "乙"],
         "multi_select": True, "allow_other": True, "other_label": "其他"},
    ],
}
ZH_PLAN_CTX = dict(ZH_QUESTION_CTX, session_id="sess-1",
                   plan_doc_url="https://x/doc")

# 英文面用 ASCII 数据（数据不译，CJK 门禁只针对包装文案）
QUESTION_CTX = {
    "card_id": 7, "title": "Login auth", "kind": "question",
    "question": "Which scenario?", "options": ["Scenario A", "Scenario B"],
    "answerable": True, "multi_select": False, "allow_other": False,
    "questions_count": 1,
}
APPROVAL_CTX = {
    "card_id": 12, "title": "Change config", "kind": "approval",
    "answerable": False, "action": "run_command", "tool": "bash",
    "input": "ls -la /tmp",
}
MULTI_CTX = {
    "card_id": 21, "title": "Multi", "kind": "question", "answerable": True,
    "questions": [
        {"header": "Scope", "question": "Which one?", "options": ["Red", "Green"],
         "multi_select": False},
        {"header": "Extra", "question": "Anything else?", "options": ["A", "B"],
         "multi_select": True, "allow_other": True, "other_label": "Other"},
    ],
}
PLAN_CTX = dict(QUESTION_CTX, session_id="sess-1", plan_doc_url="https://x/doc")
BINDING = {"open_id": "ou_t12a", "user_id": 990001, "cur_sid": "", "cur_title": "",
           "cur_bound_at": "", "cur_project_id": 0, "default_project_id": 0}

# 测试用高段 user_id，避免与其它用例的库内容互扰
UID = 990001
UID_EN = 990002


def sha_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha_obj(obj):
    return hashlib.sha256(
        json.dumps(obj, ensure_ascii=False).encode("utf-8")).hexdigest()


def assert_no_chinese(text, extra=()):
    """英文文案里除协议指令词外不得出现中文（防「英文面漏译」假绿）。"""
    cleaned = text
    for token in sorted(set(PROTOCOL_TOKENS) | set(extra), key=len, reverse=True):
        cleaned = cleaned.replace(token, "")
    assert not HAN.search(cleaned), f"英文面仍含中文: {text!r}"


@pytest.fixture()
def clean_prefs():
    """用例前后清掉本文件用的高段 user_id 偏好（共享临时库，勿污染其它用例）。"""
    def _wipe():
        with db.connect() as conn:
            conn.execute("DELETE FROM user_prefs WHERE user_id IN (?, ?)", (UID, UID_EN))

    _wipe()
    yield
    _wipe()


def _set_lang(user_id, value):
    db.set_user_pref(user_id, 0, "lang", value)


# ---------------------------------------------------------------------------
# ① zh 逐字节保全（无偏好 = 存量正常情形；TS_I18N=0 = 回滚开关）
# ---------------------------------------------------------------------------

def _zh_outputs(monkeypatch):
    # 方案文档含「当前时间」一行：冻结它，golden 才可复算
    monkeypatch.setattr(feishu, "_beijing_now", lambda: "2026-10-23 12:00")
    return {
        "question_card": sha_obj(
            feishu._build_interaction_card(ZH_QUESTION_CTX, "演示项目")),
        "approval_card": sha_obj(
            feishu._build_interaction_card(ZH_APPROVAL_CTX, "演示项目")),
        "multi_card": sha_obj(
            feishu._build_interaction_card(ZH_MULTI_CTX, "演示项目")),
        "plan_doc_md": sha_text(feishu._plan_doc_markdown(
            ZH_PLAN_CTX, {"assistant": "先做 A 再做 B"}, "演示项目")),
        "plan_question_md": sha_text(feishu._plan_question_md(ZH_PLAN_CTX)),
        "multi_hint": sha_text(feishu._multi_click_hint(
            21, ZH_MULTI_CTX["questions"], [1], [2])),
        "multi_answer_help": sha_text(feishu._multi_answer_help(
            21, ZH_MULTI_CTX["questions"])),
        "multi_answers_err": sha_text(feishu._multi_answers(
            ZH_MULTI_CTX["questions"], [(1, "9")])[1]),
        "instruction_bind_reply": sha_text(feishu.execute_intent(
            BINDING, {"action": "bind", "groups": []}, "ou_t12a")),
        "instruction_unbind_reply": sha_text(feishu.execute_intent(
            BINDING, {"action": "unbind", "groups": []}, "ou_t12a")),
        "binding_invalid_receipt": sha_text(feishu.bind_user("ZZZZZZ", "ou_t12a")),
        "conv_current_text": sha_text(feishu_conv.current_text(BINDING)),
        "conv_projects_text_empty": sha_text(feishu_conv._projects_text(BINDING)),
        "conv_rel_time_just_now": sha_text(feishu_conv._rel_time(0)),
    }


def test_zh_payloads_byte_identical_to_head_without_pref(clean_prefs, monkeypatch):
    """无偏好用户（存量正常情形）：所有代表性 payload 逐字节等于 HEAD golden。"""
    assert feishu.user_lang(UID) == "zh"
    outputs = _zh_outputs(monkeypatch)
    assert outputs == GOLDEN, {
        name: (GOLDEN[name], outputs[name])
        for name in GOLDEN if outputs[name] != GOLDEN[name]
    }


def test_ts_i18n_off_forces_zh_and_skips_db(clean_prefs, monkeypatch):
    """`TS_I18N=0`：即使库里偏好 en 也恒中文，且**不读偏好表**。"""
    _set_lang(UID, {"v": "en"})
    monkeypatch.setenv("TS_I18N", "0")
    calls = []
    real = db.get_user_prefs
    monkeypatch.setattr(db, "get_user_prefs",
                        lambda uid, pid: calls.append((uid, pid)) or real(uid, pid))
    assert feishu.user_lang(UID) == "zh"
    assert calls == [], "TS_I18N=0 时不应读用户偏好"
    assert _zh_outputs(monkeypatch) == GOLDEN
    i18n.reset_cache()


def test_ts_i18n_off_english_pref_renders_chinese_card(clean_prefs, monkeypatch):
    """`TS_I18N=0` 下显式 lang='en' 也被 t() 压回中文（回滚开关的兜底）。"""
    _set_lang(UID, {"v": "en"})
    monkeypatch.setenv("TS_I18N", "0")
    assert feishu._build_interaction_card(ZH_QUESTION_CTX, "演示项目", "en")[
        "header"]["title"]["content"] == "🤔 卡片等待回复 [演示项目]"
    i18n.reset_cache()


def test_missing_and_bad_pref_fall_back_to_zh(clean_prefs):
    """无偏好行 / 坏值（fr、裸字符串、None）一律 zh。"""
    assert feishu.user_lang(UID) == "zh"
    for bad in ({"v": "fr"}, {"v": ""}, "en", None, 123, {"v": ["en"]}):
        _set_lang(UID, bad)
        assert feishu.user_lang(UID) == "zh", bad


def test_db_error_falls_back_to_zh_without_crash(clean_prefs, monkeypatch):
    """读偏好抛异常 ⇒ zh，且绝不向调用方抛错。"""
    def boom(user_id, project_id):
        raise RuntimeError("db down")

    monkeypatch.setattr(db, "get_user_prefs", boom)
    assert feishu.user_lang(UID) == "zh"
    # 出站卡片也照常构建（中文），异常不外溢
    assert feishu._build_interaction_card(ZH_QUESTION_CTX, "演示项目")["header"][
        "title"]["content"] == "🤔 卡片等待回复 [演示项目]"


def test_user_lang_reads_lang_pref(clean_prefs):
    """合法偏好（含大小写/地区变体）归一为 en。"""
    _set_lang(UID, {"v": "en"})
    assert feishu.user_lang(UID) == "en"
    _set_lang(UID, {"v": "EN-us"})
    assert feishu.user_lang(UID) == "en"


def test_project_lang_uses_project_owner(clean_prefs):
    """群/项目推送按项目所有者偏好解析；项目不存在 ⇒ zh。"""
    _set_lang(UID, {"v": "en"})
    assert feishu.project_lang(0) == "zh"
    # 用 db 桩验证「取项目 user_id 再查偏好」这条链路
    monkey = pytest.MonkeyPatch()
    monkey.setattr(db, "get_project", lambda pid: {"id": pid, "user_id": UID})
    try:
        assert feishu.project_lang(42) == "en"
    finally:
        monkey.undo()


def test_project_lang_ts_i18n_off_skips_db(monkeypatch):
    """Minor 2 回归：`TS_I18N=0` 时 `project_lang` 必须在**读项目行之前**短路。

    审查口径（R22）：开关关闭 ⇒ 恒 zh 且不读库。此前实现先 `db.get_project` 再经
    `user_lang` 短路——偏好没读，但项目行读了，与 Node 修复后行为不一致。
    """
    monkeypatch.setenv("TS_I18N", "0")
    calls = []

    def boom(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("TS_I18N=0 时不应读库")

    monkeypatch.setattr(db, "get_project", boom)
    monkeypatch.setattr(db, "get_user_prefs", boom)
    try:
        assert feishu.project_lang(42) == "zh"
    finally:
        i18n.reset_cache()
    assert calls == [], f"TS_I18N=0 仍发生读库调用: {calls}"


# ---------------------------------------------------------------------------
# ② 英文面（绑定用户偏好 en）
# ---------------------------------------------------------------------------

def test_question_card_english(clean_prefs):
    _set_lang(UID, {"v": "en"})
    card = feishu._build_interaction_card(QUESTION_CTX, "Demo", "en")
    title = card["header"]["title"]["content"]
    assert title == "🤔 Card awaiting reply [Demo]"
    flat = json.dumps(card, ensure_ascii=False)
    assert "agent question" in flat and "Card #7 Login auth" in flat
    assert "Submit answer" not in flat        # 单选卡没有提交按钮
    assert_no_chinese(flat)


def test_approval_card_english(clean_prefs):
    card = feishu._build_interaction_card(APPROVAL_CTX, "Demo", "en")
    flat = json.dumps(card, ensure_ascii=False)
    assert "**Approval request**: run_command" in flat
    assert "Tool: bash" in flat and "Input: ls -la /tmp" in flat
    labels = [e["text"]["content"] for e in card["body"]["elements"]
              if e.get("tag") == "button"]
    assert labels == ["✅ Approve", "🔁 Approve for this session", "⛔ Reject"]
    assert_no_chinese(flat)


def test_multi_question_card_english(clean_prefs):
    card = feishu._build_interaction_card(MULTI_CTX, "Demo", "en")
    flat = json.dumps(card, ensure_ascii=False)
    assert "**agent questions (2 in total)**" in flat
    assert "1/2 Scope" in flat and "2/2 Extra" in flat
    assert "Multi-select" in flat and "Custom: Other" in flat
    assert "Please select (multi-select)" in flat
    assert_no_chinese(flat)


def test_plan_markdown_english(clean_prefs):
    md = feishu._plan_doc_markdown(PLAN_CTX, {"assistant": "Do A then B"}, "Demo",
                                   "en")
    assert md.startswith("# Card 7 · agent plan and questions")
    assert "- Project: Demo" in md and "- Card: Login auth" in md
    assert "## agent plan / answer" in md and "## Questions (full text)" in md
    assert "## How to answer" in md
    assert_no_chinese(md)


def test_instruction_and_binding_receipts_english(clean_prefs):
    _set_lang(UID, {"v": "en"})
    assert feishu.execute_intent(
        BINDING, {"action": "bind", "groups": []}, "ou_t12a", None, "en") == \
        "This account is already bound; no need to bind again"
    assert feishu.execute_intent(
        BINDING, {"action": "unbind", "groups": []}, "ou_t12a", None, "en") == \
        "Unbound. To bind again, generate a new bind code on the site"
    # 无效绑定码没有身份可依 ⇒ 中文兜底（R22）
    assert feishu.bind_user("ZZZZZZ", "ou_t12a") == "绑定码无效或已被使用"
    # 过期绑定码知道码所属用户 ⇒ 该用户的英文
    feishu._BIND_CODES["EXPZZZ"] = (UID, time.time() - 1)
    expired = feishu.bind_user("EXPZZZ", "ou_t12a")
    assert expired == "The bind code has expired; generate a new one on the site"
    assert_no_chinese(expired)


def test_action_helpers_english(clean_prefs):
    err = feishu._multi_answers(MULTI_CTX["questions"], [(1, "9"), (2, "1")],
                                "en")[1]
    assert err == "Invalid option index for question 1 (2 options)"
    assert_no_chinese(err)
    hint = feishu._multi_click_hint(21, MULTI_CTX["questions"], [1], [2], "en")
    assert "Select each question; once all 2 are answered" in hint
    assert "Question 2 is multi-select" in hint
    assert_no_chinese(hint)
    toast = feishu._toast_for("✅ Received: card #21 custom answer", "en")
    assert toast == {"toast": {"type": "success",
                               "content": "✅ Received; see the bot DM for details"}}
    assert_no_chinese(json.dumps(toast, ensure_ascii=False))
    err_toast = feishu._toast_for("选项无效", "en")
    assert err_toast["toast"]["type"] == "error"
    assert err_toast["toast"]["content"] == "Operation failed; see the bot DM " \
                                           "for details"


def test_default_project_receipt_uses_recipient_language(clean_prefs):
    """Important 1 回归：文本指令「默认项目 <名>」的回执按收件人语言。

    修复前 `execute_intent` 不把 `lang` 传进 `_set_default_project`，三次
    `feishu_conv.set_default_project` 都吃默认 "zh"——en 用户会收到中文回执（Node 早已
    返回英文）。en/zh 两条 payload 在此逐字钉住（双端同一字符串，见 Node 镜像用例）。
    """
    _set_lang(UID, {"v": "en"})
    pid = db.insert_project(UID, "proj-en", "/tmp/t12a-dp",
                            "dsh-plugin:/usr/bin/dsh", "/tmp/t12a-dp")
    intent = {"action": "default_project", "groups": ["proj-en"]}
    try:
        reply = feishu.execute_intent(dict(BINDING), intent, "ou_t12a", None, "en")
        assert reply == 'Default project set to "proj-en"'
        assert_no_chinese(reply)
        # zh 控制线（无偏好存量用户）：与 HEAD 逐字相同
        assert feishu.execute_intent(dict(BINDING), intent, "ou_t12a", None,
                                     "zh") == "默认项目已设为「proj-en」"
        # 未知项目：修复前 Python f-string 恒中文；现在也跟随收件人语言
        err = feishu.execute_intent(dict(BINDING), {"action": "default_project",
                                                    "groups": ["nope"]},
                                    "ou_t12a", None, "en")
        assert err == 'Project "nope" is not in your project list'
        assert_no_chinese(err)
        # 按 id 路径（卡片 t=dp 与文本指令共用同一写口）同样跟随显式 lang
        assert feishu._set_default_project(dict(BINDING), "", project_id=999999,
                                           lang="en") == \
            "The project is not in your project list"
    finally:
        db.delete_project(pid)


def test_plan_doc_button_labels_match_english_ui(clean_prefs):
    """Minor 1 回归：英文指引里的按钮名必须与英文按钮实际标签一致。

    实际按钮：多选 mini 表单 = `Submit answer`；多子题表单 = `Submit question {i}`。
    此前英文指引仍写「提交作答」/「提交第 {i} 题」（中文按钮名）。
    """
    md = feishu._plan_doc_markdown(PLAN_CTX, {"assistant": "Do A"}, "Demo", "en")
    assert 'tap "Submit answer"' in md
    assert "提交" not in md
    hint = feishu._multi_click_hint(21, MULTI_CTX["questions"], [1], [2], "en")
    assert 'tap "Submit question 2"' in hint
    assert_no_chinese(md)
    assert_no_chinese(hint)


def test_clip_reply_and_days_plural_english(clean_prefs):
    """Important 2 的 Python 孪生 + Minor 7 复数：截断后缀/天前计数走词典。

    Python 侧本就把 lang 传进 `_clip_reply`；本用例把两端同一 payload 钉住，防止
    Node 再漏传（Node 用例见 `backend/test/feishu-i18n.test.mjs` 的同名断言）。
    """
    suffix_en = ("\n…… (content too long and truncated; "
                 "see the site session window / board for the full text)")
    clipped = feishu_conv._clip_reply("x" * (feishu_conv.REPLY_MAX_CHARS + 1), "en")
    assert clipped.endswith(suffix_en)
    assert_no_chinese(clipped)
    # zh 控制线：与 HEAD 逐字相同
    assert feishu_conv._clip_reply(
        "x" * (feishu_conv.REPLY_MAX_CHARS + 1), "zh").endswith(
            "\n……（内容过长已截断，完整内容见站点会话窗 / 看板）")
    # 「1 天前」不能说成「1 days ago」：api 词条用复数形状，双端同口径
    now = time.time()
    assert feishu_conv._rel_time(now - 86400 - 10, "en") == "1 day ago"
    assert feishu_conv._rel_time(now - 2 * 86400 - 10, "en") == "2 days ago"
    assert feishu_conv._rel_time(now - 86400 - 10, "zh") == "1 天前"


def test_conversation_layer_english(clean_prefs):
    _set_lang(UID, {"v": "en"})
    binding = dict(BINDING)
    text = feishu_conv.current_text(binding, "en")
    assert text == "Default project: not set\n" \
                   "Current session: none bound; sending a message will create one"
    assert_no_chinese(text)
    rel = feishu_conv._rel_time(0, "en")
    assert rel == "just now"
    text = feishu_conv.leave_session(binding, "en")
    assert text == "No session is currently bound"
    assert_no_chinese(text)
    # 多题作答语法回执（action 面）英文
    help_text = feishu._multi_answer_help(21, MULTI_CTX["questions"], "en")
    assert "sub-questions" in help_text
    assert_no_chinese(help_text)


def test_english_surface_has_no_fallback_chinese(clean_prefs):
    """代表性英文面：除协议指令词外无中文（防词条缺失静默回落中文）。"""
    _set_lang(UID, {"v": "en"})
    i18n.reset_cache()
    surfaces = [
        json.dumps(feishu._build_interaction_card(QUESTION_CTX, "Demo", "en"),
                   ensure_ascii=False),
        json.dumps(feishu._build_interaction_card(APPROVAL_CTX, "Demo", "en"),
                   ensure_ascii=False),
        json.dumps(feishu._build_interaction_card(MULTI_CTX, "Demo", "en"),
                   ensure_ascii=False),
        feishu._plan_doc_markdown(PLAN_CTX, {"assistant": "Do A"}, "Demo", "en"),
        feishu_conv.current_text(BINDING, "en"),
        feishu.execute_intent(BINDING, {"action": "unbind", "groups": []},
                              "ou_t12a", None, "en"),
    ]
    for surface in surfaces:
        assert_no_chinese(surface)


# ---------------------------------------------------------------------------
# ③ 词条门禁：本模块所有 t('api', …) 的 key 必须在 en.json 的 api 命名空间
# ---------------------------------------------------------------------------

LOCALIZERS = {"_text": 0, "_num_text": 0, "_str_text": 0}


def _iter_localized_keys(path):
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    module_consts = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            try:
                module_consts[node.targets[0].id] = ast.literal_eval(node.value)
            except Exception:
                pass
    found = []

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.loop_vars = {}

        def visit_For(self, node):
            saved = dict(self.loop_vars)
            try:
                it = ast.literal_eval(node.iter)
            except Exception:
                it = None
            targets = []
            if isinstance(node.target, ast.Name):
                targets = [node.target.id]
            elif isinstance(node.target, (ast.Tuple, ast.List)) and node.target.elts \
                    and all(isinstance(e, ast.Name) for e in node.target.elts):
                # 解构循环（`for label, act, style in (("✅ 批准", …), …)`）：按列
                # 展开到各变量，否则 `i18n.t("api", label, lang)` 的 key 全部漏门禁。
                targets = [e.id for e in node.target.elts]
            if targets and isinstance(it, (list, tuple)):
                expanded = {name: set() for name in targets}
                for item in it:
                    if isinstance(item, str) and len(targets) == 1:
                        expanded[targets[0]].add(item)
                    elif isinstance(item, (list, tuple)) and len(item) == len(targets):
                        for name, value in zip(targets, item):
                            if isinstance(value, str):
                                expanded[name].add(value)
                for name, vals in expanded.items():
                    if vals:
                        self.loop_vars[name] = vals
            self.generic_visit(node)
            self.loop_vars = saved

        def visit_Call(self, node):
            fn = node.func
            idx = None
            if (isinstance(fn, ast.Attribute) and fn.attr == "t"
                    and isinstance(fn.value, ast.Name) and fn.value.id == "i18n"):
                idx = 1
            elif isinstance(fn, ast.Name) and fn.id in LOCALIZERS:
                idx = LOCALIZERS[fn.id]
            if idx is not None and len(node.args) > idx:
                arg = node.args[idx]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    found.append(arg.value)
                elif isinstance(arg, ast.Name):
                    if arg.id in module_consts and isinstance(
                            module_consts[arg.id], str):
                        found.append(module_consts[arg.id])
                    elif arg.id in self.loop_vars:
                        found.extend(self.loop_vars[arg.id])
                elif isinstance(arg, ast.IfExp):
                    for branch in (arg.body, arg.orelse):
                        if isinstance(branch, ast.Constant) and isinstance(
                                branch.value, str):
                            found.append(branch.value)
            self.generic_visit(node)

    Visitor().visit(tree)
    return found


def test_all_localized_keys_exist_in_api_dict():
    api = json.loads((ROOT / "i18n" / "en.json").read_text(encoding="utf-8"))["api"]
    keys = []
    for name in ("feishu.py", "feishu_conv.py"):
        keys.extend(_iter_localized_keys(BACKEND / name))
    assert keys, "未提取到任何本地化 key（扫描逻辑失效）"
    # 解构循环的三个审批按钮 key 必须真的进集合（Minor 4：此前 Visitor 只认 Name 目标，
    # `for label, act, style in (...)` 整段漏扫，按钮缺词条也能全绿）。
    for button_key in ("✅ 批准", "🔁 会话内批准", "⛔ 拒绝"):
        assert button_key in keys, f"AST 门禁漏掉循环解构 key: {button_key}"
    missing = sorted({k for k in keys if k not in api})
    assert not missing, f"缺少 api 词条: {missing}"
    # 占位符契约：英文译文与中文 key 的占位符集合一致（%d/%s 老式模板除外；
    # 复数词条 {"one": …, "other": …} 逐档比）
    bad = []
    for key in sorted(set(keys)):
        if "%" in key:
            continue
        entry = api[key]
        values = [entry] if isinstance(entry, str) else [
            v for v in entry.values() if isinstance(v, str)]
        want = set(PLACEHOLDER.findall(key))
        got = set().union(*(PLACEHOLDER.findall(v) for v in values))
        if not values or want != got:
            bad.append((key, sorted(want), sorted(got)))
    assert not bad, f"占位符不一致: {bad}"


# 未绑定引导的 en 词条**刻意保留但当前不可达**（R22：无身份可依 ⇒ 恒 zh；源码写点见
# `feishu.py:2407/2417` 的 `i18n.t("api", _UNBOUND_DM_CARD, "zh")`）。保留是为了：
# ① AST 门禁仍能钉住这两个中文源串的占位符/词条存在；② 未来若给未绑定路径补身份，
# 译文已就位。不是漏译，也不是活文案——T12a 审查 Minor 8 的登记项。
ALWAYS_ZH_UNBOUND_KEYS = (
    "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，生成绑定码后在这里回复「绑定 <码>」完成绑定",
    "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，生成绑定码后在单聊回复「绑定 <码>」完成绑定",
)


def test_always_zh_unbound_keys_documented():
    """Minor 8：两条不可达 en 词条必须仍存在（被门禁扫描），并明确只用于 zh 兜底。"""
    api = json.loads((ROOT / "i18n" / "en.json").read_text(encoding="utf-8"))["api"]
    for key in ALWAYS_ZH_UNBOUND_KEYS:
        assert key in api, f"不可达指引词条被误删（AST 门禁会失明）: {key}"
    assert feishu.UNBOUND_DM_MSG == ALWAYS_ZH_UNBOUND_KEYS[0]
    assert feishu._UNBOUND_DM_CARD == ALWAYS_ZH_UNBOUND_KEYS[1]


# ---------------------------------------------------------------------------
# ④ 接线补测：同一动作内 DM 回执与 toast 同语言；绑定回执用收件人语言
# ---------------------------------------------------------------------------

def test_approval_receipt_and_toast_same_language(monkeypatch):
    """审批成功回执（en）与 toast 同语言；成功前缀仍命中 ✅（toast.success）。"""
    import board

    monkeypatch.setattr(board, "interaction_of_sid",
                        lambda sid: {"pending": True, "kind": "approval",
                                     "approval_id": "a1"})
    monkeypatch.setattr(board, "answer_approval",
                        lambda p, c, aid, decision, scope: None)
    p, c = {"id": 1}, {"id": 5, "session_id": "s1"}
    reply = feishu._decide_approval(p, c, "approved", "session", "en")
    assert reply == ("✅ Card #5 approved, with similar calls in this session "
                     "auto-approved; queued for delivery")
    # 无会话范围：verb 与分号之间的空格由英文模板显式给出（词条不再自带前导空格）
    reply_plain = feishu._decide_approval(p, c, "approved", "", "en")
    assert reply_plain == "✅ Card #5 approved; queued for delivery"
    assert feishu._decide_approval(p, c, "rejected", "", "en") == \
        "✅ Card #5 rejected; queued for delivery"
    assert feishu._decide_approval(p, c, "approved", "session", "zh") == \
        "✅ 卡片 #5 审批已批准（本会话内同类调用自动放行），排队送达中"
    toast = feishu._toast_for(reply, "en")
    assert toast["toast"]["type"] == "success"
    assert toast["toast"]["content"] == "✅ Received; see the bot DM for details"
    assert_no_chinese(reply)


def test_bind_receipt_uses_recipient_language(monkeypatch, clean_prefs):
    """入口接线：绑定成功后回执按**新绑定用户**偏好（en）；TS_I18N=0 时回中文。"""
    replies = []
    state = {"bound": False}
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg=None: replies.append(text))
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda open_id: ({"open_id": open_id, "user_id": UID}
                                         if state["bound"] else None))
    monkeypatch.setattr(db, "set_feishu_binding",
                        lambda open_id, user_id: state.update(bound=True))
    _set_lang(UID, {"v": "en"})
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu._BIND_CODES["GOOD12"] = (UID, time.time() + 60)
    feishu.handle_message_event({
        "message_id": "m-t12a-bind", "chat_type": "p2p", "message_type": "text",
        "content": json.dumps({"text": "绑定 GOOD12"}), "sender_open_id": "ou_bind",
    })
    assert replies[-1] == ("Bound successfully; send 「帮助」 to see the available "
                           "commands")
    assert_no_chinese(replies[-1])
    # 回滚开关：同一条路径回中文（重新走「未绑定 → 绑定成功」分支）
    state["bound"] = False
    monkeypatch.setenv("TS_I18N", "0")
    i18n.reset_cache()
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu._BIND_CODES["GOOD34"] = (UID, time.time() + 60)
    feishu.handle_message_event({
        "message_id": "m-t12a-bind2", "chat_type": "p2p", "message_type": "text",
        "content": json.dumps({"text": "绑定 GOOD34"}), "sender_open_id": "ou_bind",
    })
    assert replies[-1] == "绑定成功，发「帮助」查看可用指令"
