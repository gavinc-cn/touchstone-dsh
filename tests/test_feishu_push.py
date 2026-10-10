# feishu 出站：签名性质 / hook 选择 / 事件过滤与幂等入队（_send_one 打桩不发网络）
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db
import feishu

db.init_db()  # 测试库建表（幂等；conftest 已把 TOUCHSTONE_DB 指到临时库）


def _proj(pid=9):
    return {"id": pid, "user_id": 1, "name": "演示项目", "archived": 0}


def test_sign_stable_and_varies():
    a1, a2 = feishu.sign("s", "1000"), feishu.sign("s", "1000")
    assert a1 == a2 and a1 != feishu.sign("s", "2000") and a1 != feishu.sign("s2", "1000")
    assert len(a1) > 20  # base64 串


def test_hook_of_levels(monkeypatch):
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: None)
    assert feishu.hook_of(9) is None                        # 未绑定且所有者无用户配置：不推
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "sec",
        "events": "blocked_interaction", "enabled": 1})
    h = feishu.hook_of(9)
    assert h["target"] == "https://h" and h["events"] == {"blocked_interaction"}
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "", "enabled": 0})
    assert feishu.hook_of(9) is None                        # 显式关闭不回落用户配置
    # 未绑定 → 回落项目所有者的用户级配置（base_url/user_id 一并归属）
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"default_webhook": "https://d",
                                     "default_secret": "ds", "base_url": "http://t/"})
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: None)
    h = feishu.hook_of(9)
    assert h["target"] == "https://d" and h["base_url"] == "http://t"
    assert h["user_id"] == 1
    # 无绑定行 ⇒ 默认事件集（交互等待+任务失败，与设置页回显默认一致）；
    # 此前写死全事件（含卡片待审核）⇒ 界面显示「未勾选」而实际会推（2026-10-10 修）
    assert h["events"] == set(feishu.FEISHU_DEFAULT_EVENTS)
    # 项目有绑定行 → 按绑定行推送，base_url/user_id 仍取项目所有者
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "sec",
        "events": "task_failed", "enabled": 1})
    h = feishu.hook_of(9)
    assert h["target"] == "https://h" and h["base_url"] == "http://t"
    assert h["user_id"] == 1
    # 所有者关闭用户级总开关 → 回落拦截
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: None)
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"enabled": False, "default_webhook": "https://d"})
    assert feishu.hook_of(9) is None


def test_hook_of_fallback_keeps_project_events(monkeypatch):
    """绑定行有 enabled 但没填 webhook ⇒ 回落用户默认 webhook 时**事件仍按行内勾选**。

    此前回落分支写死 `set(FEISHU_EVENTS)`（三个全开）⇒ 项目里没勾「卡片待审核」
    也会推（2026-10-10 修「设置不生效」的次级缺陷）。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"default_webhook": "https://d", "base_url": ""})
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "", "webhook_secret": "",
        "events": "blocked_interaction", "enabled": 1})
    h = feishu.hook_of(9)
    assert h["target"] == "https://d"
    assert h["events"] == {"blocked_interaction"}


def test_notify_events_gate_levels(monkeypatch):
    """项目级事件闸门（群 webhook 与飞书单聊卡片共用，2026-10-10）：

    有绑定行 ⇒ enabled=0 空集（该项目全通道静默）、enabled=1 取行内勾选；
    无绑定行 ⇒ 默认集（交互等待+任务失败）且受项目所有者用户级总开关约束。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "blocked_interaction,task_failed,card_review", "enabled": 0})
    assert feishu.notify_events(9) == set()                  # 显式关闭：全静默
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "", "webhook_secret": "",
        "events": "task_failed", "enabled": 1})
    assert feishu.notify_events(9) == {"task_failed"}        # 按勾选；与有无 url 无关
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "", "enabled": 1})
    assert feishu.notify_events(9) == set()                  # 事件全不勾：空集
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: None)
    assert feishu.notify_events(9) == set(feishu.FEISHU_DEFAULT_EVENTS)
    monkeypatch.setattr(feishu, "user_config", lambda uid: {"enabled": False})
    assert feishu.notify_events(9) == set()                  # 无行 + 总开关关


def test_dm_card_respects_project_gate(monkeypatch):
    """飞书单聊交互卡片必须受项目闸门约束（2026-10-10 修实障）：

    用户报障「项目推送绑定全部不勾选，仍然持续收到推送」——根因是 `_dm_interaction_card`
    只查账号绑定 + 应用凭据，不看项目 enabled/events，也不看用户级总开关。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_feishu_binding_by_user",
                        lambda uid: {"open_id": "ou_x", "user_id": uid})
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "sec"})
    sent = []
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, card, cfg: sent.append(card))
    card = {"id": 7, "title": "探针卡"}
    inter = {"kind": "question", "question": "继续吗", "options": [],
             "answerable": True, "qid": "call_1"}
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "", "webhook_secret": "",
        "events": "", "enabled": 0})
    feishu.card_blocked(9, card, inter)
    assert sent == []                                        # 项目关闭 ⇒ 不发卡片
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "", "webhook_secret": "",
        "events": "blocked_interaction", "enabled": 1})
    feishu.card_blocked(9, card, inter)
    assert len(sent) == 1                                    # 开启且勾了交互等待 ⇒ 发
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "", "webhook_secret": "",
        "events": "task_failed", "enabled": 1})
    feishu.card_blocked(9, card, inter)
    assert len(sent) == 1                                    # 没勾交互等待 ⇒ 不发
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: None)   # 无行 ⇒ 默认集含它
    monkeypatch.setattr(feishu, "user_config", lambda uid: {"enabled": False})
    feishu.card_blocked(9, card, inter)
    assert len(sent) == 1                                    # 无行 + 总开关关 ⇒ 不发


def test_push_event_filters_and_enqueues(monkeypatch):
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "sec",
        "events": "task_failed", "enabled": 1})
    seen = []
    monkeypatch.setattr(db, "feishu_outbox_push",
                        lambda t, s, p, k="", user_id=0:
                        seen.append((t, s, p, k, user_id)) or 1)
    feishu.push_event(9, "card_review", {"card_id": 1})     # events 不含 → 不入队
    assert seen == []
    feishu.push_event(9, "task_failed", {"task_id": 5, "name": "探索",
                                         "type": "normal",
                                         "error": "第 1 轮退出码 1", "skipped_n": 1})
    assert len(seen) == 1
    target, secret, payload, dedup, user_id = seen[0]
    assert target == "https://h" and secret == "sec"
    assert "❌ 任务失败 [演示项目]" in payload
    assert "pipeline 后段 1 条已连带跳过" in payload
    assert "sec" not in payload                             # 凭据不入文案
    assert dedup == "task_failed:9:5"                       # 默认 dedup: kind:proj:task
    assert user_id == 1                                     # 投递记录归属项目所有者


def test_card_blocked_push_and_dedup_key(monkeypatch):
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "blocked_interaction", "enabled": 1})
    seen = []
    monkeypatch.setattr(db, "feishu_outbox_push",
                        lambda t, s, p, k="", user_id=0: seen.append(k))
    card = {"id": 7, "title": "登录鉴权"}
    feishu.card_blocked(9, card, {"question": "选场景？", "qid": "q_1",
                                  "answerable": True,
                                  "options": [{"text": "A"}, {"text": "B"}]})
    assert seen == ["card:7:interaction:q_1"]               # qid 进 dedup 防同题重推


def test_card_blocked_accepts_sqlite_row(monkeypatch):
    """生产形态：board._iw_apply 传入的是 db.get_board_card 的 **sqlite3.Row**
    （Row 无 .get()）——card_blocked 的 ctx 构建曾在此 AttributeError，被调和器
    `except Exception: pass` 吞掉：阻塞/出队照常、飞书推送与 DM 卡片每次静默
    丢失（实障 2026-09-28：卡 610/612/613/614 四次提问零推送，outbox 零入队）。
    测试用 Row 复现生产形态，锁死修复。"""
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT 7 AS id, '登录鉴权' AS title, 9 AS project_id").fetchone()
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "blocked_interaction", "enabled": 1})
    seen, dm = [], []
    monkeypatch.setattr(db, "feishu_outbox_push",
                        lambda t, s, p, k="", user_id=0: seen.append(k) or 1)
    monkeypatch.setattr(feishu, "_dm_interaction_card",
                        lambda pid, ctx: dm.append(ctx))
    feishu.card_blocked(9, row, {"question": "选场景？", "qid": "q_1",
                                 "kind": "question", "answerable": True,
                                 "options": [{"id": "a", "label": "A"}]})
    assert seen == ["card:7:interaction:q_1"]               # 入队不再被吞
    assert dm and dm[0]["card_id"] == 7                     # DM 卡片路径可达


def test_card_review_accepts_sqlite_row(monkeypatch):
    """card_review 同样接收 Row（board.py 列归位处），title 取值不得再炸。"""
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT 8 AS id, '部署脚本' AS title, 9 AS project_id").fetchone()
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "card_review", "enabled": 1})
    seen = []
    monkeypatch.setattr(db, "feishu_outbox_push",
                        lambda t, s, p, k="", user_id=0: seen.append(k) or 1)
    feishu.card_review(9, row)
    assert seen == ["card_review:9:8"]


def test_render_blocked_interaction(monkeypatch):
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 7, "title": "登录鉴权", "question": "选场景？",
                           "options": ["A", "B"],
                           "answerable": True},
                          9, "http://t/")
    assert "🤔 卡片等待回复 [演示项目]" in text
    assert "agent 提问：选场景？" in text and "  1) A" in text
    assert "详情：http://t" in text and "sec" not in text


def test_card_blocked_ctx_and_payload(monkeypatch):
    """card_blocked payload：选项取 label（旧代码取不存在的 text 字段，推送选项
    恒空白）、answerable 提问带「作答 <卡号> …」指令指引与自由文本提示。"""
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: {
        "project_id": pid, "webhook_url": "https://h", "webhook_secret": "",
        "events": "blocked_interaction", "enabled": 1})
    seen = []
    monkeypatch.setattr(db, "feishu_outbox_push",
                        lambda t, s, p, k="", user_id=0: seen.append(p) or 1)
    card = {"id": 7, "title": "登录鉴权"}
    feishu.card_blocked(9, card, {
        "question": "选场景？", "qid": "q_1", "kind": "question",
        "answerable": True, "multi_select": False, "allow_other": True,
        "options": [{"id": "a", "label": "方案A", "description": "d"}]})
    payload = seen[0]
    assert "方案A" in payload                        # label 取值（旧代码恒空白）
    assert "作答 7" in payload                       # 飞书直接作答的指令指引
    assert "自定义" in payload                       # allow_other 自由文本提示


def test_render_blocked_interaction_answer_guidance(monkeypatch):
    """answerable 单选提问：指引飞书回复「作答 <卡号> <序号>」，不再只引导站点。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 7, "title": "登录鉴权", "question": "选场景？",
                           "options": ["A", "B"], "answerable": True,
                           "kind": "question"},
                          9, "http://t/")
    assert "作答 7" in text and "不支持远程作答" not in text
    assert "详情：http://t" in text


def test_render_blocked_interaction_multi_and_other(monkeypatch):
    """多选题提示逗号多选（作答 7 1,3），allow_other 提示自定义文字作答。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 7, "title": "t", "question": "选哪些？",
                           "options": ["A", "B", "C"], "answerable": True,
                           "kind": "question", "multi_select": True,
                           "allow_other": True},
                          9, "")
    assert "作答 7 1,3" in text and "自定义" in text


def test_render_blocked_interaction_multi_sub_questions(monkeypatch):
    """多子题提问（仅有计数、无逐题明细）：给出「题号:序号」逐题作答指引。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 7, "title": "t", "question": "q？",
                           "options": ["A"], "answerable": True,
                           "kind": "question", "questions_count": 2},
                          9, "")
    assert "2 道子题" in text
    assert "作答 7 1:<选项序号> 2:<选项序号>" in text


def test_render_blocked_interaction_lists_all_sub_questions(monkeypatch):
    """多子题群文本：逐题列出题面与选项（旧实现只渲染首题 q0、其余子题不可见）
    + 整批语义下仍引导站点逐题作答。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 806, "title": "session-1512",
                           "kind": "question", "question": "第一题？",
                           "options": ["A"], "answerable": True,
                           "questions_count": 2,
                           "questions": [
                               {"id": "q_0", "header": "甲", "question": "第一题？",
                                "options": [{"id": "a", "label": "A",
                                             "description": "说明A"}],
                                "allow_other": True, "other_label": "其他"},
                               {"id": "q_1", "header": "乙", "question": "第二题？",
                                "options": [{"id": "b", "label": "B"}],
                                "multi_select": True}]},
                          9, "http://t/")
    assert "agent 提问（共 2 题）：" in text
    assert "【1/2 甲】第一题？" in text
    assert "【2/2 乙】第二题？" in text                   # 第 2 题不再丢失
    assert "  1) A" in text and "     说明A" in text      # 选项与描述次行
    assert "（多选）" in text
    assert "2 道子题" in text
    assert "作答 806 1:<选项序号> 2:<选项序号>" in text     # 逐题作答语法


def test_render_blocked_interaction_sub_questions_not_answerable(monkeypatch):
    """不可远程作答的多子题：仍逐题展示，末行引导回 dsh 会话窗口。

    站点会话窗此时同样不出作答控件（webui SessionView 按 answerable 门控），
    故**不得**再出现「请到站点会话窗口处理」（2026-10-07 文案纠偏）。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 806, "title": "t", "kind": "question",
                           "question": "第一题？", "options": ["A"],
                           "answerable": False, "questions_count": 2,
                           "questions": [
                               {"id": "q_0", "question": "第一题？",
                                "options": [{"id": "a", "label": "A"}]},
                               {"id": "q_1", "question": "第二题？",
                                "options": [{"id": "b", "label": "B"}]}]},
                          9, "")
    assert "第一题？" in text and "第二题？" in text
    assert "不支持远程作答" in text and "dsh 会话窗口作答" in text
    assert "站点会话窗口" not in text


def test_render_blocked_interaction_approval(monkeypatch):
    """审批等待：推送审批动作/工具/内容摘要，指引「同意/拒绝 <卡号>」（含会话档）。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 7, "title": "t", "kind": "approval",
                           "action": "run_command", "tool": "bash",
                           "input": "rm -rf build", "question": "请求审批：run_command",
                           "options": None, "answerable": True},
                          9, "")
    assert "审批请求：run_command" in text and "bash" in text
    assert "同意 7" in text and "拒绝 7" in text and "会话」" in text
    assert "agent 提问" not in text and "不支持远程作答" not in text


def test_render_blocked_interaction_not_answerable(monkeypatch):
    """不可远程作答（会话非平台自持）：引导去 dsh 会话窗口，不再指向站点。"""
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    text = feishu._render("blocked_interaction",
                          {"card_id": 7, "title": "t", "question": "q？",
                           "options": ["A"], "answerable": False, "kind": ""},
                          9, "")
    assert "dsh 会话窗口作答" in text and "站点会话窗口" not in text


def test_push_event_never_raises(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(db, "get_feishu_hook", _boom)
    feishu.push_event(9, "task_failed", {"task_id": 1})     # 任何异常吞掉不外抛


def test_send_one_signs_and_sends(monkeypatch):
    captured = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"code":0}'

    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    monkeypatch.setattr(feishu.urllib.request, "urlopen", _fake_urlopen)
    ok, err = feishu._send_one({"target": "https://h", "secret": "sec",
                                "payload": '{"msg_type":"text","content":{"text":"hi"}}',
                                "id": 1, "retries": 0})
    assert ok is True and err == ""
    assert captured["url"] == "https://h"
    assert captured["body"]["timestamp"] and captured["body"]["sign"]
    assert "sec" not in json.dumps(captured["body"])        # 密钥本体不出现在请求里


def test_send_one_failure_parsed(monkeypatch):
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"code":19021,"msg":"sign match fail"}'

    monkeypatch.setattr(feishu.urllib.request, "urlopen", lambda *a, **k: _Resp())
    ok, err = feishu._send_one({"target": "https://h", "secret": "bad",
                                "payload": "{}", "id": 1, "retries": 0})
    assert ok is False and "19021" in err


def test_send_one_invalid_url_returns_error():
    """坏 URL（如存量脏值 'admin'）：返回 (False, err) 而非抛异常。

    曾因 Request 构造在 try 块外，ValueError 直接外抛——daemon 兜底后该行
    永不被标记 failed，每秒被重取重抛、无限空转。"""
    ok, err = feishu._send_one({"target": "admin", "secret": "",
                                "payload": "{}", "id": 1, "retries": 0})
    assert ok is False and err


# ---------- DM 交互卡片构建（schema 2.0；按钮点击走新版卡片回调/长连接） ----------

def _btn_values(card):
    """提取卡片 elements 里全部 callback 按钮的 (显示文本, value)。"""
    out = []
    for el in card["body"]["elements"]:
        if el.get("tag") == "button":
            out.append((el["text"]["content"], el["behaviors"][0]["value"]))
    return out


def test_build_card_question_buttons():
    """单选提问：每选项一个作答按钮，value 精简键 t/c/i（序号回传时重读白名单）。"""
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "登录鉴权", "kind": "question",
        "question": "选场景？", "options": ["A", "B", "C"],
        "answerable": True, "multi_select": False, "allow_other": False,
        "questions_count": 1}, "演示项目")
    assert card["schema"] == "2.0"
    assert "选场景？" in card["body"]["elements"][0]["content"]
    btns = _btn_values(card)
    assert [(t, v) for t, v in btns] == [
        ("1) A", {"t": "a", "c": 7, "i": 1}),
        ("2) B", {"t": "a", "c": 7, "i": 2}),
        ("3) C", {"t": "a", "c": 7, "i": 3})]


def test_build_card_approval_buttons():
    """审批：批准/会话内批准/拒绝三按钮（t=p/s/d）。"""
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "t", "kind": "approval", "action": "run_command",
        "tool": "bash", "input": "ls", "question": "请求审批：run_command",
        "options": None, "answerable": True}, "演示项目")
    btns = _btn_values(card)
    assert [v["t"] for _, v in btns] == ["p", "s", "d"]
    assert all(v["c"] == 7 for _, v in btns)
    assert "run_command" in card["body"]["elements"][0]["content"]


def test_build_card_downgrades_no_answer_buttons():
    """不放「逐选项作答按钮」的三类：单题多选（改给 mini 表单，见
    `test_build_card_single_multiselect_form`）、多子题（改给逐题点选卡）、
    不可远程作答（只读 + dsh 会话窗口引导）。三者都不发 t=a 按钮，且都留文本指引兜底。"""
    base = {"card_id": 7, "title": "t", "kind": "question", "question": "q？",
            "options": ["A"], "answerable": True}
    card = feishu._build_interaction_card({**base, "multi_select": True,
                                           "allow_other": False,
                                           "questions_count": 1}, "p")
    assert _btn_values(card) == []
    assert any(e.get("tag") == "form" for e in card["body"]["elements"])
    assert "作答 7 1,3" in str(card["body"]["elements"])
    card = feishu._build_interaction_card({**base, "multi_select": False,
                                           "allow_other": False,
                                           "questions_count": 2}, "p")
    assert _btn_values(card) == [] and "子题" in str(card["body"]["elements"])
    card = feishu._build_interaction_card({**base, "kind": "", "answerable": False,
                                           "multi_select": False,
                                           "questions_count": 0}, "p")
    assert (_btn_values(card) == []
            and "dsh 会话窗口作答" in str(card["body"]["elements"]))


def _clicks_of(card):
    """卡片里全部可点选作答控件：根级 `select_static`（单选）+ 单题 mini 表单内的
    `multi_select_static`（飞书官方规定多选组件**只能内嵌表单容器**，故多选包一层 form）。"""
    out = []
    for el in card["body"]["elements"]:
        if el.get("tag") == "select_static":
            out.append(el)
        elif el.get("tag") == "form":
            out.extend(e for e in (el.get("elements") or [])
                       if e.get("tag") == "multi_select_static")
    return out


def test_build_card_multi_question_click_card():
    """可远程作答的多子题：发「逐题点选卡」——每题一块只读题面 + 一个可点控件：
    单选=**根级** `select_static`、多选=**单题 mini 表单**内 `multi_select_static`
    + 提交按钮（飞书规定多选只能内嵌表单容器）。两者 behaviors 都带 t=mq/c=卡号/n=题号，
    选项 value 取 1 起序号（回调按当前白名单换 option id）。
    2026-10-07 第三档：旧「整张多题表单卡」退场（form 元素 1000 字节硬限必被拒收）。"""
    ctx = {"card_id": 7, "title": "登录鉴权", "kind": "question",
           "question": "选场景？", "options": ["A"], "answerable": True,
           "multi_select": False, "allow_other": True, "questions_count": 2,
           "questions": [
               {"id": "q_0", "header": "场景", "question": "选场景？",
                "options": [{"id": "a", "label": "A"},
                            {"id": "b", "label": "B"}],
                "multi_select": False, "allow_other": True,
                "other_label": "其他场景"},
               {"id": "q_1", "question": "覆盖哪些模块？",
                "options": [{"id": "c", "label": "C"}],
                "multi_select": True, "allow_other": False}]}
    card = feishu._build_interaction_card(ctx, "演示项目")
    els = card["body"]["elements"]
    # 单选第 1 题：根级下拉
    sel = [e for e in els if e.get("tag") == "select_static"][0]
    assert sel["name"] == "mq7_1"
    assert sel["behaviors"][0] == {"type": "callback",
                                   "value": {"t": "mq", "c": 7, "n": 1}}
    assert [o["value"] for o in sel["options"]] == ["1", "2"]   # 序号编码（重读白名单）
    assert [o["text"]["content"] for o in sel["options"]] == ["A", "B"]
    # 多选第 2 题：单题 mini 表单（组件 + 提交按钮），按钮与组件同带 t=mq/c/n
    form = [e for e in els if e.get("tag") == "form"][0]
    assert form["name"] == "mqf7_2"
    msel = [e for e in form["elements"]
            if e.get("tag") == "multi_select_static"][0]
    assert msel["name"] == "mq7_2" and msel["options"][0]["value"] == "1"
    btn = [e for e in form["elements"] if e.get("tag") == "button"][0]
    assert btn["form_action_type"] == "submit"
    assert btn["behaviors"][0]["value"] == {"t": "mq", "c": 7, "n": 2}
    # 每个 form 只装一道题（不是旧「一张 form 装全部子题」）
    assert sum(1 for e in els if e.get("tag") == "form") == 1
    md = _card_md(card)
    assert "**1/2 场景**" in md and "**2/2 覆盖哪些模块？**" in md  # 逐题题面
    assert "（多选）" in md                                        # 能力标注
    assert "答满 2 题自动送达" in md                                # 点选指引
    assert "第 1 题请回复「作答 7 1:<值>」" in md                   # 自定义题补答语法
    assert _btn_values(card) == []                                 # 多题不发逐选项按钮


def test_build_card_multi_question_click_card_skips_question_without_options():
    """子题既无选项又不许自定义：该题不放置控件（无可选项），指引点名该题用文本作答；
    其余有选项的题照常可点选。"""
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "t", "kind": "question", "question": "q？",
        "options": [], "answerable": True, "multi_select": False,
        "allow_other": False, "questions_count": 2,
        "questions": [{"id": "q_0", "header": "甲", "question": "第一题？",
                       "options": [], "allow_other": False},
                      {"id": "q_1", "header": "乙", "question": "第二题？",
                       "options": [{"id": "b", "label": "B"}],
                       "allow_other": False}]}, "p")
    clicks = _clicks_of(card)
    assert len(clicks) == 1                                # 只第 2 题有控件
    assert clicks[0]["behaviors"][0]["value"]["n"] == 2
    md = _card_md(card)
    assert "第一题？" in md and "第二题？" in md            # 两题题面都在
    assert "第 1 题请回复「作答 7 1:<值>」" in md            # 无选项那题点名走文本


def test_build_card_multiselect_form_over_budget_falls_back_to_text():
    """多选 mini 表单超飞书 form 元素 1000 字节预算时**不发该组件**（发了必被
    `230099` 拒收导致整卡静默丢失），该题退回文本补答并在指引里点名。"""
    long_label = "选项" + "很长的说明" * 30            # 单选项 label 会被截到 100 字
    qs = [{"id": "q_0", "header": "甲", "question": "第一题？",
           "options": [{"id": "a", "label": "A"}], "allow_other": True},
          {"id": "q_1", "header": "乙", "question": "第二题？", "multi_select": True,
           "options": [{"id": f"o{i}", "label": long_label} for i in range(6)]}]
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "t", "kind": "question", "question": "q？",
        "options": [], "answerable": True, "multi_select": False,
        "allow_other": False, "questions_count": 2, "questions": qs}, "p")
    assert not any(e.get("tag") == "form" for e in card["body"]["elements"])
    assert len(_clicks_of(card)) == 1                 # 只剩第 1 题的单选下拉
    md = _card_md(card)
    assert "第 1、2 题请回复" in md                     # 两题都被点名（1 可自定义、2 放不下）
    assert "作答 7 1:<值> 2:<值>" in md


def _card_md(card):
    """卡片 body 里全部 markdown 元素内容拼接（文案断言用）。"""
    return "\n".join(el.get("content") or ""
                     for el in card["body"]["elements"]
                     if el.get("tag") == "markdown")


def test_build_card_multi_question_shows_all_questions():
    """不可远程作答的多子题：卡片**逐题完整展示**（题头/题面/选项/描述次行）——
    2026-10-06 前的实现只渲染首题 q0，其余子题在飞书上完全不可见
    （用户实障：agent 一次问 3 题，卡片上只见第 1 题）。"""
    card = feishu._build_interaction_card({
        "card_id": 806, "title": "session-1512", "kind": "question",
        "question": "第三方变量如何处理？", "options": ["保持原名（推荐）"],
        "answerable": False, "questions_count": 3,
        "questions": [
            {"id": "third_party", "header": "第三方/系统变量",
             "question": "第三方与系统约定的变量如何处理？",
             "options": [{"id": "l1", "label": "保持原名（推荐）",
                          "description": "容器与工具链消费，改名会破坏启动"},
                         {"id": "l2", "label": "全部强改为 GTRADE_ 前缀"}],
             "multi_select": False, "allow_other": True, "other_label": "其他"},
            {"id": "credentials", "header": "外部凭据变量",
             "question": "ANTHROPIC_API_KEY 与 GITHUB_TOKEN 是否改名？",
             "options": [{"id": "l1", "label": "保持原名（推荐）"}],
             "multi_select": False, "allow_other": False},
            {"id": "compat", "header": "旧名兼容策略",
             "question": "旧名是否保留兼容回退？",
             "options": [{"id": "l1", "label": "硬切（推荐）"},
                         {"id": "l2", "label": "保留旧名回退 + 弃用告警"}],
             "multi_select": True, "allow_other": False}]}, "demo_proj")
    md = _card_md(card)
    assert "共 3 题" in md
    assert "**1/3 第三方/系统变量**" in md
    assert "**2/3 外部凭据变量**" in md and "**3/3 旧名兼容策略**" in md
    # 三题题面全在（旧实现只有第 1 题的题面）
    assert "第三方与系统约定的变量如何处理？" in md
    assert "ANTHROPIC_API_KEY 与 GITHUB_TOKEN 是否改名？" in md
    assert "旧名是否保留兼容回退？" in md
    assert "容器与工具链消费，改名会破坏启动" in md     # 选项描述次行
    assert "（多选）" in md                            # 第 3 题多选标注
    assert "该等待不支持远程作答" in md                 # 不可作答 → 引导 dsh 会话窗
    assert "dsh 会话窗口作答" in md and "站点会话窗口" not in md
    assert _btn_values(card) == []                     # 不放逐选项按钮


def test_build_card_multi_question_unanswerable_stays_readonly():
    """不可远程作答（会话非平台自持）：只读逐题展示 + dsh 会话窗口引导，**不放下拉**
    ——放了也无人接收回调（answerable=false 时平台侧不会暂存/送达）。"""
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "t", "kind": "question", "question": "q？",
        "options": [], "answerable": False, "multi_select": False,
        "allow_other": False, "questions_count": 2,
        "questions": [{"id": "q_0", "header": "甲", "question": "第一题？",
                       "options": [{"id": "a", "label": "A"}],
                       "allow_other": True},
                      {"id": "q_1", "header": "乙", "question": "第二题？",
                       "options": [{"id": "b", "label": "B"}],
                       "allow_other": False}]}, "p")
    assert _clicks_of(card) == []
    md = _card_md(card)
    assert "第一题？" in md and "第二题？" in md
    assert "该等待不支持远程作答" in md and "dsh 会话窗口作答" in md


def test_build_card_long_multi_question_still_clickable():
    """超长多题（旧实现会撞飞书 form 1000 字节硬限而降级为只读）：单选走**根级**
    组件、无 form 体量限制 ⇒ 四题仍是可点选的逐题卡（题面全在、四个下拉齐全）。"""
    qs = [{"id": f"q_{i}", "header": f"第 {i} 题", "question": "y" * 200,
           "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"},
                       {"id": "c", "label": "C"}],
           "multi_select": False, "allow_other": True, "other_label": "其他"}
          for i in range(1, 5)]
    card = feishu._build_interaction_card({
        "card_id": 819, "title": "session-529f", "kind": "question",
        "question": qs[0]["question"], "options": ["A"],
        "answerable": True, "questions_count": 4, "questions": qs}, "demo_proj")
    md = _card_md(card)
    assert "**4/4 第 4 题**" in md                          # 四题全在
    assert len(_clicks_of(card)) == 4                       # 四个逐题下拉
    assert [s["behaviors"][0]["value"]["n"] for s in _clicks_of(card)] == [1, 2, 3, 4]
    assert not any(el.get("tag") == "form" for el in card["body"]["elements"])


def test_build_card_single_multiselect_form():
    """单题多选 + 可远程作答：卡片上给「单题 mini 表单」（多选组件按飞书规定只能
    内嵌表单容器，见 `_multi_select_form`），勾选后点「提交作答」即送达；不放 t=a
    选项按钮（按钮一次只表达一项，表达不了「N 选 M」）。
    2026-10-07 第四档：此前单题多选在飞书上无处可点，只有一条文字指令指引。"""
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "登录鉴权", "kind": "question",
        "question": "覆盖哪些模块？", "options": ["A", "B"],
        "answerable": True, "multi_select": True, "allow_other": False,
        "questions_count": 1}, "演示项目")
    assert _btn_values(card) == []                     # 无 t=a 选项按钮
    form = [e for e in card["body"]["elements"] if e.get("tag") == "form"][0]
    assert form["name"] == "mqf7_1"
    msel = [e for e in form["elements"]
            if e.get("tag") == "multi_select_static"][0]
    assert msel["name"] == "mq7_1"                     # 回调按该 name 取 form_value
    assert [o["value"] for o in msel["options"]] == ["1", "2"]   # 序号编码（重读白名单）
    assert [o["text"]["content"] for o in msel["options"]] == ["A", "B"]
    btn = [e for e in form["elements"] if e.get("tag") == "button"][0]
    assert btn["form_action_type"] == "submit"
    assert btn["text"]["content"] == "提交作答"
    assert btn["behaviors"][0]["value"] == {"t": "mq", "c": 7, "n": 1}
    md = _card_md(card)
    assert "覆盖哪些模块？" in md and "提交作答" in md
    assert "作答 7 1,3" in md                          # 文本指令兜底仍在


def test_build_card_single_multiselect_without_control_falls_back():
    """单题多选三种情形**不发控件**（发了要么被飞书拒收要么点不了），退回文本指引：
    表单超飞书 form 1000 字节硬限 / 该题没有选项 / 不可远程作答。"""
    long_label = "选项" + "很长的说明" * 30            # 单选项 label 截到 100 字（≈300 字节）
    base = {"card_id": 7, "title": "t", "kind": "question", "question": "多选？",
            "answerable": True, "multi_select": True, "allow_other": False,
            "questions_count": 1}
    for ctx, want in (({**base, "options": [long_label] * 4}, "作答 7 1,3"),
                      ({**base, "options": []}, "站点会话窗口"),
                      ({**base, "options": ["A"], "answerable": False},
                       "该等待不支持远程作答")):
        card = feishu._build_interaction_card(ctx, "p")
        assert not any(e.get("tag") == "form" for e in card["body"]["elements"]), want
        assert want in _card_md(card), want
    # 无选项但允许自定义：给文本作答指引（不点控件也能答）
    card = feishu._build_interaction_card(
        {**base, "options": [], "allow_other": True}, "p")
    assert "作答 7 <文字>" in _card_md(card)


def test_build_card_multi_question_hint_names_multiselect_submit():
    """多子题卡里发了多选 mini 表单的题要在指引里点名「勾选后点提交」——
    多选是两步操作，不点名容易被当成勾上就算答了（回调只在提交帧到达）。"""
    card = feishu._build_interaction_card({
        "card_id": 7, "title": "t", "kind": "question", "question": "q？",
        "options": ["A"], "answerable": True, "multi_select": False,
        "allow_other": False, "questions_count": 2,
        "questions": [{"id": "q_0", "header": "甲", "question": "第一题？",
                       "options": [{"id": "a", "label": "A"}],
                       "multi_select": False, "allow_other": False},
                      {"id": "q_1", "header": "乙", "question": "第二题？",
                       "options": [{"id": "b", "label": "B"}],
                       "multi_select": True, "allow_other": False}]}, "p")
    md = _card_md(card)
    assert "第 2 题是多选：勾选后点「提交第 2 题」" in md
    assert "第 1 题是多选" not in md                    # 单选那题不点名提交


def test_question_views_compat_and_clip():
    """逐题视图：兼容旧形态（纯字符串选项 / 非 dict 题）并做长度截断。"""
    views = feishu._question_views([{"question": "q", "options": ["A", None]},
                                    "非 dict 题目"])
    assert views[0]["options"][0]["label"] == "A"
    assert views[0]["options"][1]["label"] == ""
    assert views[1]["question"] == ""                   # 非 dict 题按空题兜底
    long_view = feishu._question_views(
        [{"question": "x" * (feishu._Q_TEXT_MAX + 50)}])
    assert long_view[0]["question"].endswith("…")
    assert len(long_view[0]["question"]) == feishu._Q_TEXT_MAX + 1


def test_card_blocked_ctx_carries_questions(monkeypatch):
    """card_blocked 把逐题视图（id/题面/选项/描述/能力）透传给 DM 卡片构建——
    多子题表单与逐题只读展示的共同数据来源。"""
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(db, "get_project", lambda pid: _proj())
    monkeypatch.setattr(db, "get_feishu_hook", lambda pid: None)   # 无 webhook：只验 ctx
    seen = {}
    monkeypatch.setattr(feishu, "_dm_interaction_card",
                        lambda pid, ctx: seen.update(ctx))
    feishu.card_blocked(9, {"id": 7, "title": "t"}, {
        "kind": "question", "qid": "Q-1", "answerable": True,
        "question": "选场景？", "options": [{"id": "a", "label": "A"}],
        "questions": [{"id": "q_0", "options": [{"id": "a", "label": "A",
                                                "description": "说明A"}],
                       "multi_select": False, "allow_other": True},
                      {"id": "q_1", "options": [{"id": "b", "label": "B"}],
                       "multi_select": True, "allow_other": False}]})
    assert [q["id"] for q in seen["questions"]] == ["q_0", "q_1"]
    assert seen["questions"][0]["allow_other"] is True
    assert seen["questions"][1]["multi_select"] is True
    assert seen["questions"][0]["options"][0]["label"] == "A"
    assert seen["questions"][0]["options"][0]["description"] == "说明A"  # 描述次行透传
    assert seen["questions"][1]["options"][0]["description"] == ""


def test_rest_send_card_shape(monkeypatch):
    """DM 卡片发送：msg_type=interactive，content 直接是卡片 JSON 串
    （2026-09-27 spike 实测：{"data": …} 包裹会被 230099 拒绝）。"""
    captured = {}
    monkeypatch.setattr(feishu, "_rest",
                        lambda method, path, **kw: captured.update(
                            method=method, path=path, **{"kw": kw}) or {})
    feishu.rest_send_card("ou_1", {"schema": "2.0", "body": {}}, {"app_id": "a"})
    assert captured["method"] == "POST" and "/im/v1/messages" in captured["path"]
    body = captured["kw"]["json_body"]
    assert body["msg_type"] == "interactive" and body["receive_id"] == "ou_1"
    assert json.loads(body["content"]) == {"schema": "2.0", "body": {}}


def test_send_one_and_mark_success(monkeypatch):
    oid = db.feishu_outbox_push("https://h", "", '{"msg_type":"text"}', "k:loop1")
    monkeypatch.setattr(feishu, "_send_one", lambda row: (True, ""))
    assert feishu._send_one_and_mark(db.feishu_outbox_due(time.time())[0]) is True
    assert db.feishu_outbox_due(time.time()) == []          # 成功 → sent 出队
    assert db.feishu_outbox_recent(5)[0]["status"] == "sent"
    assert db.feishu_outbox_recent(5)[0]["id"] == oid


def test_send_one_and_mark_retry_and_giveup(monkeypatch):
    oid = db.feishu_outbox_push("https://h", "", "{}", "k:loop2")
    monkeypatch.setattr(feishu, "_send_one", lambda row: (False, "code=19021 boom"))
    for i in range(len(feishu.RETRY_DELAYS)):               # 3 次失败 → pending 续期
        row = db.feishu_outbox_due(time.time() + 3600)[0]
        assert row["id"] == oid and feishu._send_one_and_mark(row) is False
        assert db.feishu_outbox_recent(5)[0]["retries"] == i + 1
    row = db.feishu_outbox_due(time.time() + 3600)[0]
    assert feishu._send_one_and_mark(row) is False          # 第 4 次 → failed 留痕
    rec = db.feishu_outbox_recent(5)[0]
    assert rec["status"] == "failed" and "19021" in rec["last_error"]
    assert db.feishu_outbox_due(time.time() + 3600) == []   # 不再重试
