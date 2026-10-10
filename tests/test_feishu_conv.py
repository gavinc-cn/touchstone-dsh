# 飞书通用对话：绑定态 / 路由 / 卡片 / 回调 / 回流（打桩网络与驱动，不触真实飞书）
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chat
import db
import dshevents
import dshdriver
import feishu
import feishu_conv
import runner
import waitq

db.init_db()  # 幂等；conftest 已把 TOUCHSTONE_DB 指到临时库


def test_cur_session_roundtrip():
    """写/清当前会话；换绑（同一用户换飞书号）不得继承旧会话。"""
    db.set_feishu_binding("ou_t1a", 101)
    db.set_feishu_cur_session("ou_t1a", 7, "session-abc", "标题")
    row = db.get_feishu_binding_by_open("ou_t1a")
    assert (row["cur_sid"], row["cur_project_id"], row["cur_title"]) == \
        ("session-abc", 7, "标题")
    assert row["cur_bound_at"]                       # 非空时间戳
    db.clear_feishu_cur_session("ou_t1a")
    row = db.get_feishu_binding_by_open("ou_t1a")
    assert row["cur_sid"] == "" and row["cur_project_id"] == 0
    db.set_feishu_cur_session("ou_t1a", 7, "session-abc", "标题")
    db.set_feishu_binding("ou_t1b", 101)             # 同用户换号 → 旧行删除、新行干净
    assert db.get_feishu_binding_by_open("ou_t1b")["cur_sid"] == ""


def test_cur_session_migration_idempotent():
    """四列在表里且默认值为空（迁移与建表两路都要有）。"""
    with db.connect() as conn:
        cols = {r["name"]: r for r in conn.execute("PRAGMA table_info(feishu_bindings)")}
    assert {"cur_sid", "cur_project_id", "cur_title", "cur_bound_at"} <= set(cols)
    db.set_feishu_binding("ou_t1c", 102)
    assert db.get_feishu_binding_by_open("ou_t1c")["cur_bound_at"] == ""


def test_cur_session_migration_alter_path(tmp_path, monkeypatch):
    """迁移的 ALTER 路：存量旧库（无四列）跑 init_db 后补列，存量行读回空默认值。

    线上库是「已存在 feishu_bindings 但无 cur_* 四列」的旧库——CREATE TABLE
    IF NOT EXISTS 不会改动它，四列只能由 migrate() 的 ALTER TABLE 补上；只测
    新建库路径（列来自建表语句）覆盖不到这条真实路径。
    """
    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(legacy)
    # 变更前的 feishu_bindings 原始 schema（四列不存在）
    conn.execute(
        "CREATE TABLE feishu_bindings ("
        " open_id            TEXT PRIMARY KEY,"
        " user_id            INTEGER NOT NULL UNIQUE,"
        " default_project_id INTEGER NOT NULL DEFAULT 0,"
        " bound_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))")
    conn.execute("INSERT INTO feishu_bindings(open_id, user_id, default_project_id)"
                 " VALUES('ou_legacy', 900, 5)")
    conn.commit()
    conn.close()

    # db.db_path() 在调用时读模块全局 DB_OVERRIDE ⇒ 重定向 connect() 到旧库
    monkeypatch.setattr(db, "DB_OVERRIDE", str(legacy))
    db.init_db()

    with db.connect() as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(feishu_bindings)")}
        assert {"cur_sid", "cur_project_id", "cur_title", "cur_bound_at"} <= cols
        row = c.execute("SELECT * FROM feishu_bindings WHERE open_id='ou_legacy'").fetchone()
    assert row["cur_sid"] == "" and row["cur_project_id"] == 0   # 存量行补空默认值
    assert row["cur_title"] == "" and row["cur_bound_at"] == ""
    assert row["default_project_id"] == 5                        # 原有列不受影响

    db.init_db()   # 再跑一遍：幂等，不重复补列、不毁数据
    with db.connect() as c:
        cols = [r["name"] for r in c.execute("PRAGMA table_info(feishu_bindings)")]
        assert cols.count("cur_sid") == 1
        assert c.execute("SELECT cur_sid FROM feishu_bindings WHERE open_id='ou_legacy'"
                         ).fetchone()["cur_sid"] == ""


def test_submit_pure_session_message_delivers(monkeypatch):
    """无 task/无 card 的消息走纯会话投递：直达 _dsh_send_now，不进 board。"""
    calls = []
    monkeypatch.setattr(runner, "INSTANCE", None)          # 同步执行路径
    monkeypatch.setattr(chat, "_dsh_send_now",
                        lambda project, sid, message, inject: calls.append(
                            (project["id"], sid, message, inject)))
    pid = db.insert_project(101, "p_pure", "/tmp/p_pure", "dsh-plugin:/x", "/tmp/p_pure")
    res = chat.submit(pid, "session-pure", "你好", family="dsh_plugin")
    assert calls == [(pid, "session-pure", "你好", False)]
    assert res["state"] == "done" and res["queued"] is False


def test_submit_extra_meta_lands_in_wait_row(monkeypatch):
    """extra_meta 随等待项行持久化（重启后回流仍知道这条消息来自飞书）。"""
    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    pid = db.insert_project(101, "p_meta", "/tmp/p_meta", "dsh-plugin:/x", "/tmp/p_meta")
    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    res = chat.submit(pid, "session-meta", "hi", family="dsh_plugin",
                      extra_meta={"feishu": {"open_id": "ou_x", "baseline": 3}})
    row = waitq.get_active(waitq.KIND_MSG, res["id"])
    meta = json.loads(row["meta"])
    assert meta["feishu"] == {"open_id": "ou_x", "baseline": 3}
    assert meta["family"] == "dsh_plugin"


# ---------- Task 3：通用对话骨架（指令 / 自由文本路由 / 当前·新建会话） ----------

def _mk_project(uid, name):
    """建项目并返回 id（名称同时作目录后缀，保证唯一）。"""
    return db.insert_project(uid, name, f"/tmp/{name}", "dsh-plugin:/x", f"/tmp/{name}")


def test_intent_rules_and_slash_commands():
    """新增 6 条规则可解析（中文 + /别名），斜杠清单同步登记。"""
    for text, action in (("当前", "current"), ("/current", "current"),
                         ("项目", "projects"), ("/projects", "projects"),
                         ("会话", "sessions"), ("/sessions", "sessions"),
                         ("新建会话 修登录", "new"), ("/new", "new"),
                         ("绑定会话 3", "use"), ("/use abc", "use"),
                         ("解绑会话", "leave"), ("/leave", "leave")):
        got = feishu.parse_intent(text)
        assert got and got["action"] == action, (text, got)
    names = {c for c, _, _ in feishu.SLASH_COMMANDS}
    assert {"current", "projects", "sessions", "new", "use", "leave"} <= names


def test_route_text_delivers_to_bound_session(monkeypatch):
    """有绑定时：投递给该会话并回执「已投递」，extra_meta 带 baseline。"""
    uid = 201
    pid = _mk_project(uid, "p_route")
    db.set_feishu_binding("ou_r1", uid)
    db.set_feishu_default_project("ou_r1", pid)
    db.set_feishu_cur_session("ou_r1", pid, "session-r1", "会话一")
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    monkeypatch.setattr(feishu_conv, "_baseline_of", lambda sid: 5)
    calls = []
    # feishu_conv 在函数内懒 import chat，故打桩 chat.submit 即可全局生效
    monkeypatch.setattr(chat, "submit",
                        lambda *a, **k: (calls.append((a, k)) or
                                         {"id": "m1", "state": "queued", "queued": True}))
    binding = db.get_feishu_binding_by_open("ou_r1")
    reply = feishu_conv.route_text(binding, "帮我看看登录")
    assert "已投递" in reply and "排队中" in reply
    args, kwargs = calls[0]
    assert args[0] == pid and args[1] == "session-r1" and args[2] == "帮我看看登录"
    assert kwargs["extra_meta"]["feishu"]["baseline"] == 5
    assert kwargs["extra_meta"]["feishu"]["open_id"] == "ou_r1"


def test_route_text_auto_new_when_unbound(monkeypatch):
    """无会话但有默认项目：自动新建并绑定，再投递。"""
    uid = 202
    pid = _mk_project(uid, "p_auto")
    db.set_feishu_binding("ou_r2", uid)
    db.set_feishu_default_project("ou_r2", pid)
    monkeypatch.setattr(feishu_conv, "_create_in_project",
                        lambda b, p, title: ("session-new", ""))
    monkeypatch.setattr(feishu_conv, "_baseline_of", lambda sid: 0)
    monkeypatch.setattr(chat, "submit", lambda *a, **k: {"id": "m2", "state": "queued",
                                                         "queued": False})
    reply = feishu_conv.route_text(db.get_feishu_binding_by_open("ou_r2"), "在吗")
    assert "已投递" in reply and "执行中" in reply
    assert db.get_feishu_binding_by_open("ou_r2")["cur_sid"] == "session-new"


def test_route_text_no_default_project_guides(monkeypatch):
    """无默认项目且多项目：回引导文案，不投递。"""
    uid = 203
    _mk_project(uid, "p_g1")
    _mk_project(uid, "p_g2")
    db.set_feishu_binding("ou_r3", uid)
    monkeypatch.setattr(chat, "submit", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("不应投递")))
    reply = feishu_conv.route_text(db.get_feishu_binding_by_open("ou_r3"), "你好")
    assert "默认项目" in reply


def test_route_text_stale_session_unbinds_and_notes(monkeypatch):
    """绑定会话已消失：自动解绑 + 提示，然后按「无会话」路径处理。"""
    uid = 204
    pid = _mk_project(uid, "p_stale")
    db.set_feishu_binding("ou_r4", uid)
    db.set_feishu_default_project("ou_r4", pid)
    db.set_feishu_cur_session("ou_r4", pid, "session-gone", "旧会话")
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: False)
    monkeypatch.setattr(feishu_conv, "_create_in_project",
                        lambda b, p, title: ("session-fresh", ""))
    monkeypatch.setattr(feishu_conv, "_baseline_of", lambda sid: 0)
    monkeypatch.setattr(chat, "submit", lambda *a, **k: {"id": "m4", "state": "queued",
                                                         "queued": False})
    reply = feishu_conv.route_text(db.get_feishu_binding_by_open("ou_r4"), "继续")
    assert "已不存在" in reply and "已解除绑定" in reply


def test_route_text_driver_unavailable(monkeypatch):
    """dsh 驱动不可用（独立形态）：中文引导，不抛异常。"""
    uid = 205
    pid = _mk_project(uid, "p_nodrv")
    db.set_feishu_binding("ou_r5", uid)
    db.set_feishu_default_project("ou_r5", pid)
    monkeypatch.setattr(feishu_conv, "_create_in_project",
                        lambda b, p, title: ("", "该功能需要 dsh 插件形态"))
    reply = feishu_conv.route_text(db.get_feishu_binding_by_open("ou_r5"), "在吗")
    assert "dsh 插件形态" in reply


def test_create_in_project_driver_gate(monkeypatch):
    """驱动闸直测：configured()=False ⇒ 中文引导 + 绝不调 create_session。"""
    uid = 208
    pid = _mk_project(uid, "p_gate")
    db.set_feishu_binding("ou_r8", uid)
    db.set_feishu_default_project("ou_r8", pid)
    created = []
    monkeypatch.setattr(dshdriver, "configured", lambda: False)
    monkeypatch.setattr(dshdriver, "create_session",
                        lambda *a, **k: created.append((a, k)) or "session-never")
    binding = db.get_feishu_binding_by_open("ou_r8")
    sid, err = feishu_conv._create_in_project(binding, db.get_project(pid), "标题")
    assert sid == "" and created == []           # 闸在 create_session 之前
    assert err == "飞书通用对话需要 dsh 插件形态（独立形态的站点没有进程内 agent 驱动）"
    assert db.get_feishu_binding_by_open("ou_r8")["cur_sid"] == ""   # 失败不写绑定


def test_create_in_project_applies_project_model(monkeypatch):
    """项目级模型必须**在建会话时**下发（回归：模型此前只喂 apply_session_defaults，
    而它仅在 reasoning_effort 非空时才调 set_model ⇒ 只配模型的项目被静默丢弃，
    飞书会话跑在宿主默认模型上）。口径对齐看板 `board._start_web`：先 split_model，
    再把裸模型 id + provider 交给 create_session。
    """
    uid = 211
    pid = db.insert_project(uid, "p_model", "/tmp/p_model", "dsh-plugin:/x",
                            "/tmp/p_model", model="prov/m1")
    db.set_feishu_binding("ou_r11", uid)
    db.set_feishu_default_project("ou_r11", pid)
    created, defaults, renamed, bound = [], [], [], []
    monkeypatch.setattr(dshdriver, "configured", lambda: True)
    # 记录器用 dshdriver.create_session 的真实签名：钉住「建会话即带模型」契约，
    # 位置/关键字两种调用形态都能被如实记录
    monkeypatch.setattr(dshdriver, "create_session",
                        lambda cwd, task="", model="", provider="":
                        created.append({"cwd": cwd, "task": task,
                                        "model": model, "provider": provider})
                        or "session-model")
    monkeypatch.setattr(dshdriver, "apply_session_defaults",
                        lambda *a, **k: defaults.append((a, k)) or [])
    monkeypatch.setattr(dshdriver, "rename", lambda sid, t: renamed.append((sid, t)))
    monkeypatch.setattr(db, "set_feishu_cur_session", lambda *a: bound.append(a))
    sid, err = feishu_conv._create_in_project(
        db.get_feishu_binding_by_open("ou_r11"), db.get_project(pid), "标题")
    assert (sid, err) == ("session-model", "")
    # split_model 契约：`prov/m1` 拆成 model=m1 + provider=prov 并在建会话时下发
    assert created == [{"cwd": "/tmp/p_model", "task": "标题",
                        "model": "m1", "provider": "prov"}]
    assert len(defaults) == 1                        # 思考等级 / 权限档路径保持原样
    assert renamed == [("session-model", "标题")]
    assert bound == [("ou_r11", pid, "session-model", "标题")]   # 成功路径写绑定


def test_current_text_shows_project_and_session():
    """「当前」回执：默认项目 + 当前会话 + 未绑定时的说明。"""
    uid = 206
    pid = _mk_project(uid, "p_cur")
    db.set_feishu_binding("ou_r6", uid)
    db.set_feishu_default_project("ou_r6", pid)
    binding = db.get_feishu_binding_by_open("ou_r6")
    assert "p_cur" in feishu_conv.current_text(binding)
    assert "未绑定会话" in feishu_conv.current_text(binding)
    db.set_feishu_cur_session("ou_r6", pid, "session-cur", "会话甲")
    text = feishu_conv.current_text(db.get_feishu_binding_by_open("ou_r6"))
    assert "会话甲" in text and "session-cur"[:12] in text


def test_new_session_creates_binds_and_receipts(monkeypatch):
    """「新建会话 标题」：默认项目下建会话、成功路径写绑定、回执写明项目与看板副作用。"""
    uid = 209
    pid = _mk_project(uid, "p_ns")
    db.set_feishu_binding("ou_r9", uid)
    db.set_feishu_default_project("ou_r9", pid)
    created, renamed = [], []
    monkeypatch.setattr(dshdriver, "configured", lambda: True)
    monkeypatch.setattr(dshdriver, "create_session",
                        lambda cwd, task="", **k: created.append((cwd, task)) or "session-ns")
    monkeypatch.setattr(dshdriver, "apply_session_defaults", lambda *a, **k: [])
    monkeypatch.setattr(dshdriver, "rename", lambda sid, t: renamed.append((sid, t)))
    reply = feishu_conv.new_session(db.get_feishu_binding_by_open("ou_r9"), "修登录")
    assert created == [("/tmp/p_ns", "修登录")]              # 建在项目目录、标题即参数
    assert renamed == [("session-ns", "修登录")]             # rename 同步标题
    row = db.get_feishu_binding_by_open("ou_r9")
    assert (row["cur_sid"], row["cur_project_id"], row["cur_title"]) == \
        ("session-ns", pid, "修登录")
    assert "已新建并绑定「修登录」" in reply and "p_ns" in reply and "sync 卡" in reply


def test_conv_intent_current_and_new(monkeypatch):
    """执行器分派：「当前」回绑定态回执，「新建会话」落到新建路径。"""
    uid = 210
    pid = _mk_project(uid, "p_ci")
    db.set_feishu_binding("ou_r10", uid)
    db.set_feishu_default_project("ou_r10", pid)
    binding = db.get_feishu_binding_by_open("ou_r10")
    monkeypatch.setattr(feishu_conv, "_create_in_project",
                        lambda b, p, title: ("session-ci", ""))
    assert feishu_conv.conv_intent(binding, "current", [None], "ou_r10") == \
        feishu_conv.current_text(binding)
    assert "已新建并绑定" in feishu_conv.conv_intent(binding, "new", ["ci 标题"], "ou_r10")


def test_free_text_group_keeps_help(monkeypatch):
    """群聊里的未识别文本仍回帮助，绝不落会话。"""
    uid = 207
    _mk_project(uid, "p_group")
    db.set_feishu_binding("ou_r7", uid)
    sent, routed = [], []
    monkeypatch.setattr(feishu, "bot_open_id", lambda cfg: "ou_bot")
    monkeypatch.setattr(feishu, "rest_reply", lambda mid, text, cfg: sent.append(text))
    monkeypatch.setattr(feishu_conv, "route_text",
                        lambda *a, **k: routed.append(1) or "x")
    evt = {"message_id": "om_g1", "chat_type": "group", "message_type": "text",
           "sender_open_id": "ou_r7", "content": json.dumps({"text": "@_user_1 随便聊聊"}),
           "mentions": [{"key": "@_user_1", "open_id": "ou_bot"}]}
    feishu.handle_message_event(evt, cfg={"app_id": "cli_x", "app_secret": "s"})
    assert routed == [] and sent == [feishu.HELP_TEXT]


def test_conv_disabled_falls_back_to_help(monkeypatch):
    """TS_FEISHU_CONV=0：未识别文本回帮助，路由不被调用。

    回滚开关的验收钉子：关掉通用对话必须回到「未识别 → 帮助」的老路
    （feishu.py:1337-1343 的三元闸），且**一个字节都不进 route_text**
    ——只断 reply 文案不断「是否调用」的话，关不掉投递副作用（会话照建、
    消息照投），开关就名存实亡。
    """
    uid = 601
    _mk_project(uid, "p_off")
    db.set_feishu_binding("ou_off", uid)
    sent, routed = [], []
    monkeypatch.setenv(feishu_conv.CONV_ENV, "0")
    monkeypatch.setattr(feishu, "rest_reply", lambda mid, text, cfg: sent.append(text))
    monkeypatch.setattr(feishu_conv, "route_text", lambda *a, **k: routed.append(1) or "x")
    evt = {"message_id": "om_off1", "chat_type": "p2p", "message_type": "text",
           "sender_open_id": "ou_off", "content": json.dumps({"text": "随便聊聊"})}
    feishu.handle_message_event(evt, cfg={"app_id": "cli_x", "app_secret": "s"})
    assert routed == [] and sent == [feishu.HELP_TEXT]


# ---------- Task 4：项目总览卡与 t=dp 回调（卡片回调全程不触网） ----------

def test_projects_card_shape_and_budget(monkeypatch):
    """总览卡：每项目一块 + 根级下拉（value=项目id）+ 计数行；JSON 不超预算。"""
    uid = 301
    db.set_feishu_binding("ou_c1", uid)
    pids = [_mk_project(uid, f"p_card{i}") for i in range(3)]
    db.set_feishu_default_project("ou_c1", pids[-1])
    db.insert_board_card(pids[0], "卡片甲")       # 看板计数有据可查
    binding = db.get_feishu_binding_by_open("ou_c1")
    card = feishu_conv.projects_card(binding)
    els = card["elements"]
    md = "\n".join(e.get("content", "") for e in els if e.get("tag") == "markdown")
    assert "p_card0" in md and "任务" in md and "看板" in md and "队列" in md
    sel = [e for e in els if e.get("tag") == "select_static"][0]
    assert {o["value"] for o in sel["options"]} == {str(p) for p in pids}
    assert sel["behaviors"][0]["value"]["t"] == "dp"
    assert sel["behaviors"][0]["value"]["u"] == uid
    assert len(json.dumps(card, ensure_ascii=False)) <= feishu_conv.CARD_MAX_BYTES


def test_projects_card_truncates_over_limit(monkeypatch):
    """项目超过 20 个：只列 20 个 + 追加文本引导，卡片仍不超预算。"""
    uid = 302
    db.set_feishu_binding("ou_c2", uid)
    for i in range(25):
        _mk_project(uid, f"p_many{i:02d}")
    card = feishu_conv.projects_card(db.get_feishu_binding_by_open("ou_c2"))
    sel = [e for e in card["elements"] if e.get("tag") == "select_static"][0]
    assert len(sel["options"]) == feishu_conv.PROJECTS_MAX
    md = "\n".join(e.get("content", "") for e in card["elements"]
                   if e.get("tag") == "markdown")
    assert "另有 5 个项目" in md
    assert len(json.dumps(card, ensure_ascii=False)) <= feishu_conv.CARD_MAX_BYTES


def test_dp_callback_sets_default_and_unbinds(monkeypatch):
    """t=dp：设默认项目；跨项目时自动解绑当前会话并说明。"""
    uid = 303
    p1 = _mk_project(uid, "p_dp1")
    p2 = _mk_project(uid, "p_dp2")
    db.set_feishu_binding("ou_c3", uid)
    db.set_feishu_default_project("ou_c3", p1)
    db.set_feishu_cur_session("ou_c3", p1, "session-dp", "旧会话")
    binding = db.get_feishu_binding_by_open("ou_c3")
    toast = feishu_conv.on_card_action("ou_c3", binding,
                                       {"t": "dp", "u": uid},
                                       {"option": str(p2)}, {})
    assert db.get_feishu_binding_by_open("ou_c3")["default_project_id"] == p2
    assert db.get_feishu_binding_by_open("ou_c3")["cur_sid"] == ""      # 自动解绑
    assert toast and toast["toast"]["type"] == "success"


def test_dp_callback_rejects_foreign_user_and_project(monkeypatch):
    """u 不符 / 项目不属本人：拒绝且无写副作用。"""
    uid = 304
    p1 = _mk_project(uid, "p_dp3")
    db.set_feishu_binding("ou_c4", uid)
    binding = db.get_feishu_binding_by_open("ou_c4")
    before = binding["default_project_id"]
    assert feishu_conv.on_card_action("ou_c4", binding, {"t": "dp", "u": uid + 1},
                                      {"option": str(p1)}, {})["toast"]["type"] == "error"
    assert feishu_conv.on_card_action("ou_c4", binding, {"t": "dp", "u": uid},
                                      {"option": "999999"}, {})["toast"]["type"] == "error"
    assert db.get_feishu_binding_by_open("ou_c4")["default_project_id"] == before


def test_projects_intent_sends_card_and_text_fallback(monkeypatch):
    """「项目」指令：有项目 ⇒ 发总览卡且不再回文本；无项目 ⇒ 回引导文本（不静默）。"""
    uid = 305
    db.set_feishu_binding("ou_c5", uid)
    _mk_project(uid, "p_intent")
    sent = []
    monkeypatch.setattr(feishu_conv, "send_card",
                        lambda oid, card, cfg: sent.append((oid, card)) or True)
    binding = db.get_feishu_binding_by_open("ou_c5")
    assert feishu_conv.conv_intent(binding, "projects", [None], "ou_c5", {}) == ""
    assert sent and sent[0][0] == "ou_c5"
    assert [e for e in sent[0][1]["elements"] if e.get("tag") == "select_static"]
    # 无项目用户：projects_card 返回 None ⇒ 回文本
    db.set_feishu_binding("ou_c5b", 306)
    b2 = db.get_feishu_binding_by_open("ou_c5b")
    assert feishu_conv.conv_intent(b2, "projects", [None], "ou_c5b", {}) == \
        "你还没有项目，请先到站点创建"


def test_projects_intent_text_fallback_when_card_send_fails(monkeypatch):
    """卡片发不出去（send_card 返回 False）：绝不静默——回项目纯文本清单 + 文本设置指引。

    卡片是「项目」指令的默认回执（成功路径返回空串、由 execute_intent 见空串不发）；
    飞书拒收/凭据缺失时若不回文本，用户发「项目」就一个字都收不到。
    """
    uid = 320
    db.set_feishu_binding("ou_c20", uid)
    _mk_project(uid, "p_fb1")
    _mk_project(uid, "p_fb2")
    monkeypatch.setattr(feishu_conv, "send_card", lambda oid, card, cfg: False)
    reply = feishu_conv.conv_intent(db.get_feishu_binding_by_open("ou_c20"),
                                    "projects", [None], "ou_c20", {})
    assert reply                                       # 有回执，不静默
    assert "p_fb1" in reply and "p_fb2" in reply        # 项目清单以文本形式仍可达
    assert "默认项目" in reply                          # 可执行的兜底指引


def test_dm_and_card_send_credential_gate(monkeypatch, capsys):
    """凭据闸（控制者裁决 F1）：缺 app_id/app_secret 时 _dm / send_card 只留痕返回，
    绝不发网络请求——卡片回执与卡片发送的单测都走到这里。"""
    dm_calls, card_calls = [], []
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: dm_calls.append((oid, text)))
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, card, cfg: card_calls.append((oid, card)))
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)   # 库里也没有凭据
    feishu_conv._dm("ou_gate", "回执", {})
    feishu_conv._dm("ou_gate", "回执")                            # cfg 缺省 ⇒ 现取（None）
    feishu_conv.send_card("ou_gate", {"schema": "2.0"}, {})
    assert dm_calls == [] and card_calls == []
    assert "凭据缺失" in capsys.readouterr().err
    # 凭据齐备才真的发（打桩函数记录，全程不触网）
    cfg = {"app_id": "cli_x", "app_secret": "s"}
    feishu_conv._dm("ou_gate", "回执", cfg)
    feishu_conv.send_card("ou_gate", {"schema": "2.0"}, cfg)
    assert len(dm_calls) == 1 and len(card_calls) == 1


def test_set_default_project_shared_path_and_unbind_note(monkeypatch):
    """feishu._set_default_project 的按 id 路径（卡片共用写口）：跨项目解绑 + 附说明；
    同一项目不动当前会话；非本人项目拒绝。"""
    uid = 307
    p1 = _mk_project(uid, "p_txt1")
    p2 = _mk_project(uid, "p_txt2")
    db.set_feishu_binding("ou_c7", uid)
    db.set_feishu_default_project("ou_c7", p1)
    db.set_feishu_cur_session("ou_c7", p1, "session-t7", "旧会话")
    reply = feishu._set_default_project(db.get_feishu_binding_by_open("ou_c7"), "",
                                        project_id=p2)
    assert "p_txt2" in reply and "已解除此前绑定的会话" in reply
    assert db.get_feishu_binding_by_open("ou_c7")["cur_sid"] == ""
    # 按名路径（文本指令）共用同一段写路径：同项目 ⇒ 保留当前会话
    db.set_feishu_cur_session("ou_c7", p2, "session-t7b", "会话乙")
    reply = feishu._set_default_project(db.get_feishu_binding_by_open("ou_c7"), "p_txt2")
    assert "已解除" not in reply
    assert db.get_feishu_binding_by_open("ou_c7")["cur_sid"] == "session-t7b"
    # 非本人/不存在的 id：拒绝且不改库
    assert feishu._set_default_project(db.get_feishu_binding_by_open("ou_c7"), "",
                                       project_id=999999) == "项目不在你的项目列表"
    assert db.get_feishu_binding_by_open("ou_c7")["default_project_id"] == p2


def test_card_action_dispatch_dp_before_board_whitelist(monkeypatch):
    """t=dp 在既有看板动作白名单**之前**分流（未绑定的引导路径也在白名单之前）；
    既有看板动作路径不变（卡号缺失/未知动作照旧返回 None）。"""
    uid = 308
    p1 = _mk_project(uid, "p_disp")
    db.set_feishu_binding("ou_c8", uid)
    seen = []
    monkeypatch.setattr(feishu_conv, "on_card_action",
                        lambda *a: seen.append(a) or {"toast": {"type": "success",
                                                                "content": "x"}})
    data = {"header": {"event_id": "ev_dp_disp"},
            "event": {"operator": {"open_id": "ou_c8"},
                      "action": {"value": {"t": "dp", "u": uid}, "option": str(p1)}}}
    assert feishu._on_card_action(data, {})["toast"]["type"] == "success"
    assert len(seen) == 1 and seen[0][0] == "ou_c8" and seen[0][4] == {}
    # 未绑定者：DM 引导 + 错误 toast，不进通用对话回调
    monkeypatch.setattr(feishu, "rest_send_text", lambda oid, text, cfg: None)
    data2 = {"header": {"event_id": "ev_dp_unbound"},
             "event": {"operator": {"open_id": "ou_unbound_x"},
                       "action": {"value": {"t": "dp", "u": uid}, "option": str(p1)}}}
    assert feishu._on_card_action(data2, {})["toast"]["type"] == "error"
    assert len(seen) == 1
    # 既有看板卡片动作：白名单原样（缺卡号 / 未知动作都不分流）
    for eid, val in (("ev_board_noke", {"t": "a"}), ("ev_board_unknown", {"t": "zz"})):
        data3 = {"header": {"event_id": eid},
                 "event": {"operator": {"open_id": "ou_c8"},
                           "action": {"value": val}}}
        assert feishu._on_card_action(data3, {}) is None
    assert len(seen) == 1


def test_ss_callback_rejects_foreign_user(monkeypatch):
    """t=ss 防串号（取代 T4 的「延后」占位用例）：卡片 value.u 与点击者不符 ⇒
    错误 toast 且不写任何绑定。"""
    uid = 309
    pid = _mk_project(uid, "p_ss_foreign")
    db.set_feishu_binding("ou_c9", uid)
    db.set_feishu_default_project("ou_c9", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    binding = db.get_feishu_binding_by_open("ou_c9")
    toast = feishu_conv.on_card_action("ou_c9", binding, {"t": "ss", "u": uid + 1},
                                       {"option": "session-any"}, {})
    assert toast["toast"]["type"] == "error"
    assert db.get_feishu_binding_by_open("ou_c9")["cur_sid"] == ""


def test_projects_card_degrades_over_budget():
    """超预算降级（brief Step 3）：先删计数行、再收缩项目列表，结果仍在预算内。"""
    uid = 310
    db.set_feishu_binding("ou_c10", uid)
    for i in range(feishu_conv.PROJECTS_MAX):
        _mk_project(uid, "长" * 150 + f"{i:02d}")      # 超长项目名逼出降级
    card = feishu_conv.projects_card(db.get_feishu_binding_by_open("ou_c10"))
    sel = [e for e in card["elements"] if e.get("tag") == "select_static"][0]
    md = "\n".join(e.get("content", "") for e in card["elements"]
                   if e.get("tag") == "markdown")
    assert len(json.dumps(card, ensure_ascii=False)) <= feishu_conv.CARD_MAX_BYTES
    assert len(sel["options"]) == feishu_conv.PROJECTS_FALLBACK   # 第二轮降到 10 个
    assert "任务 运行" not in md                                  # 计数行已先行删除


# ---------- Task 5：会话列表卡、t=ss 回调与文本兜底（绑定 / 解绑） ----------

def _sess(sid, title, mtime, first_prompt="", archived=False):
    return {"sid": sid, "title": title, "first_prompt": first_prompt, "mtime": mtime,
            "archived": archived}


def test_sessions_card_shape_and_limit(monkeypatch):
    """列表卡：最多 10 条、每条一块、下拉 value=会话id、回调 t=ss。"""
    uid = 401
    pid = _mk_project(uid, "p_sess")
    db.set_feishu_binding("ou_s1", uid)
    db.set_feishu_default_project("ou_s1", pid)
    items = [_sess(f"session-{i:02d}", f"会话{i}", 1000 - i) for i in range(15)]
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: items)
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    card = feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s1"))
    sel = [e for e in card["elements"] if e.get("tag") == "select_static"][0]
    assert len(sel["options"]) == feishu_conv.SESSIONS_MAX
    assert [o["value"] for o in sel["options"]][:2] == ["session-00", "session-01"]
    assert sel["behaviors"][0]["value"]["t"] == "ss"
    assert db.get_feishu_binding_by_open("ou_s1")  # 只读不写
    assert feishu_conv._LAST_LIST["ou_s1"][1][:2] == ["session-00", "session-01"]


def test_ss_callback_binds_and_rejects_vanished(monkeypatch):
    """t=ss：绑定存在的会话；会话已消失则拒绝。"""
    uid = 402
    pid = _mk_project(uid, "p_sess2")
    db.set_feishu_binding("ou_s2", uid)
    db.set_feishu_default_project("ou_s2", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-ok", "会话OK", 1)])
    binding = db.get_feishu_binding_by_open("ou_s2")
    assert feishu_conv.on_card_action("ou_s2", binding, {"t": "ss", "u": uid},
                                      {"option": "session-ok"},
                                      {})["toast"]["type"] == "success"
    assert db.get_feishu_binding_by_open("ou_s2")["cur_sid"] == "session-ok"
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: False)
    assert feishu_conv.on_card_action("ou_s2", binding, {"t": "ss", "u": uid},
                                      {"option": "session-x"},
                                      {})["toast"]["type"] == "error"
    assert db.get_feishu_binding_by_open("ou_s2")["cur_sid"] == "session-ok"


def test_use_by_index_title_and_prefix(monkeypatch):
    """文本兜底：序号（用列表记忆）/ 标题包含 / sid 前缀。"""
    uid = 403
    pid = _mk_project(uid, "p_use")
    db.set_feishu_binding("ou_s3", uid)
    db.set_feishu_default_project("ou_s3", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-a1", "修登录", 3),
                                          _sess("session-b2", "写文档", 2)])
    # 会话行会按 `_session_busy` 出 🏃 标记：这里桩成「都不忙」，让断言只钉绑定行为
    # （读口是 dshevents，不触网；桩掉是为了不受进程中注册表实况影响）
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    binding = db.get_feishu_binding_by_open("ou_s3")
    feishu_conv.sessions_card(binding)                      # 产生 _LAST_LIST
    assert "已绑定" in feishu_conv.use_by_token(binding, "2")
    assert db.get_feishu_binding_by_open("ou_s3")["cur_sid"] == "session-b2"
    assert "已绑定" in feishu_conv.use_by_token(binding, "登录")
    assert db.get_feishu_binding_by_open("ou_s3")["cur_sid"] == "session-a1"
    assert "已绑定" in feishu_conv.use_by_token(binding, "session-b2")
    assert "已绑定" not in feishu_conv.use_by_token(binding, "不存在的东西")
    # 列表记忆过期/越界：回引导而不误绑
    feishu_conv._LAST_LIST.pop("ou_s3", None)
    assert "已绑定" not in feishu_conv.use_by_token(binding, "1")
    assert "会话" in feishu_conv.use_by_token(binding, "1")


def test_leave_session_keeps_default_project():
    """解绑会话不动默认项目；重复解绑给明确回执。"""
    uid = 404
    pid = _mk_project(uid, "p_leave")
    db.set_feishu_binding("ou_s4", uid)
    db.set_feishu_default_project("ou_s4", pid)
    db.set_feishu_cur_session("ou_s4", pid, "session-l", "会话L")
    binding = db.get_feishu_binding_by_open("ou_s4")
    assert "已解绑" in feishu_conv.leave_session(binding)
    row = db.get_feishu_binding_by_open("ou_s4")
    assert row["cur_sid"] == "" and row["default_project_id"] == pid
    assert "未绑定" in feishu_conv.leave_session(row)


def test_sessions_card_without_default_project_and_empty_bucket(monkeypatch):
    """无默认项目 ⇒ 卡片 None（指令层回「先设默认项目」文本）；零会话 ⇒ 有卡无控件。"""
    uid = 411
    pid = _mk_project(uid, "p_sess_none")
    db.set_feishu_binding("ou_s11", uid)
    binding = db.get_feishu_binding_by_open("ou_s11")
    assert feishu_conv.sessions_card(binding) is None
    assert feishu_conv.conv_intent(binding, "sessions", [None], "ou_s11", {}) == \
        feishu_conv.NO_DEFAULT_GUIDE
    db.set_feishu_default_project("ou_s11", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions", lambda fam, cwd: [])
    binding = db.get_feishu_binding_by_open("ou_s11")
    card = feishu_conv.sessions_card(binding)
    assert card is not None
    assert not [e for e in card["elements"] if e.get("tag") == "select_static"]
    md = "".join(e.get("content", "") for e in card["elements"] if e.get("tag") == "markdown")
    assert "还没有会话" in md and "新建会话" in md
    assert feishu_conv._LAST_LIST["ou_s11"][1] == []      # 空列表也登记（序号必然越界）


def test_sessions_card_marks_and_title_fallbacks(monkeypatch):
    """行内容：标题缺失回落首问首行（只取首行）再回落 sid 短码；🏃 / 📦 / ✅ 状态标。"""
    uid = 412
    pid = _mk_project(uid, "p_sess_mark")
    db.set_feishu_binding("ou_s12", uid)
    db.set_feishu_default_project("ou_s12", pid)
    db.set_feishu_cur_session("ou_s12", pid, "session-cur1", "当前会话")
    items = [_sess("session-cur1", "当前会话", 1000),
             _sess("session-fp01", "", 999, first_prompt="修一下登录\n第二行"),
             _sess("session-non1", "", 998, archived=True)]
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions", lambda fam, cwd: items)
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: sid == "session-cur1")
    card = feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s12"))
    md = [e.get("content", "") for e in card["elements"] if e.get("tag") == "markdown"]
    assert "**1. 当前会话**" in md[0] and "✅ 当前" in md[0] and "🏃 运行中" in md[0]
    assert "修一下登录" in md[1] and "第二行" not in md[1]
    assert "session-non1"[:12] in md[2] and "📦 已归档" in md[2]


def test_sessions_card_degrades_and_keeps_list_in_sync(monkeypatch):
    """超预算降级（防御路径）：收缩展示条数，且 _LAST_LIST 与实际选项一一对应（防序号错位）。

    正常口径下 SESSION_NAME_MAX 截断已足够把 10 条塞进预算（见上一条用例）；这里打桩
    放大单行体积逼出降级分支——日后若放宽截断或往行内加元素，这条路径就是兜底。
    """
    uid = 413
    pid = _mk_project(uid, "p_sess_big")
    db.set_feishu_binding("ou_s13", uid)
    db.set_feishu_default_project("ou_s13", pid)
    items = [_sess(f"session-{i:02d}", f"会话{i}", 1000 - i) for i in range(10)]
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions", lambda fam, cwd: items)
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    monkeypatch.setattr(feishu_conv, "_session_name", lambda item: "长" * 700)
    card = feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s13"))
    opts = [e for e in card["elements"] if e.get("tag") == "select_static"][0]["options"]
    assert feishu_conv._card_bytes(card) <= feishu_conv.CARD_MAX_BYTES
    assert len(opts) < feishu_conv.SESSIONS_MAX                 # 确实降级了
    assert [o["value"] for o in opts] == feishu_conv._LAST_LIST["ou_s13"][1]


def test_ss_callback_makes_no_rest_call_without_creds(monkeypatch, capsys):
    """t=ss 全路径不触网（控制者澄清 4）：DM 回执走凭据闸，缺凭据只留痕。

    修复轮补充：`bind_session` 改按**本项目会话集**（`list_sessions`）校验归属，
    故本用例必须给出该 sid 属于默认项目的会话集（否则是「不属于本项目」场景，
    绑定本就该被拒）——打桩同时保证用例不读真实 `~/.dsh/sessions`。
    """
    uid = 414
    pid = _mk_project(uid, "p_ss_net")
    db.set_feishu_binding("ou_s14", uid)
    db.set_feishu_default_project("ou_s14", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    monkeypatch.setattr(feishu_conv.sessparse, "session_title", lambda fam, sid: "会话NET")
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-net", "会话NET", 1)])
    calls = []
    monkeypatch.setattr(feishu, "rest_send_text", lambda *a, **k: calls.append(("text", a)))
    monkeypatch.setattr(feishu, "rest_send_card", lambda *a, **k: calls.append(("card", a)))
    toast = feishu_conv.on_card_action("ou_s14", db.get_feishu_binding_by_open("ou_s14"),
                                       {"t": "ss", "u": uid}, {"option": "session-net"}, {})
    assert toast["toast"]["type"] == "success"
    assert calls == []                                          # 零 REST 调用
    assert "凭据缺失" in capsys.readouterr().err
    row = db.get_feishu_binding_by_open("ou_s14")
    assert (row["cur_sid"], row["cur_title"]) == ("session-net", "会话NET")


def test_session_busy_reads_dshevents_and_swallows_errors(monkeypatch):
    """🏃 标记的数据源：`dshevents` 注册表的 status；未知/异常一律不标（仅展示，不断卡）。

    未连接与未知会话在 `dshevents.get` 都是 None（该中枢的不变量：断连=未知）——
    未知**不等于空闲**，故不显示任何标记，绝不替宿主下忙/闲断言。
    """
    monkeypatch.setattr(dshevents, "get", lambda sid: {"status": "running"})
    assert feishu_conv._session_busy("session-run") is True
    monkeypatch.setattr(dshevents, "get", lambda sid: {"status": "idle"})
    assert feishu_conv._session_busy("session-run") is False
    monkeypatch.setattr(dshevents, "get", lambda sid: None)       # 未连接 / 未见过该会话
    assert feishu_conv._session_busy("session-run") is False
    monkeypatch.setattr(dshevents, "get",
                        lambda sid: (_ for _ in ()).throw(RuntimeError("boom")))
    assert feishu_conv._session_busy("session-run") is False


def test_sessions_card_busy_marker_makes_no_driver_call(monkeypatch):
    """列表卡的 🏃 只读 `dshevents`（零请求）：构建卡片期间不碰 chat.dsh_busy / /status。

    卡片在飞书入站线程里同步构建，逐会话打驱动 `/status`（15s 超时 × 最多 10 条）
    会把入站线程卡住——本批把状态读口迁到进程内注册表正是为此。
    """
    uid = 424
    pid = _mk_project(uid, "p_busy_src")
    db.set_feishu_binding("ou_s24", uid)
    db.set_feishu_default_project("ou_s24", pid)
    items = [_sess("session-run", "跑着的", 1000),
             _sess("session-idle", "闲着的", 999),
             _sess("session-unknown", "没见过的", 998)]
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions", lambda fam, cwd: items)
    monkeypatch.setattr(dshevents, "get", lambda sid: {
        "session-run": {"status": "running"},
        "session-idle": {"status": "idle"},
    }.get(sid))
    calls = []
    monkeypatch.setattr(chat, "dsh_busy",
                        lambda sid: calls.append(("chat", sid)) or True)
    monkeypatch.setattr(dshdriver, "status",
                        lambda sid: calls.append(("driver", sid)) or {})
    card = feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s24"))
    md = [e.get("content", "") for e in card["elements"] if e.get("tag") == "markdown"]
    assert "🏃 运行中" in md[0]                     # running ⇒ 有标记
    assert "🏃" not in md[1] and "🏃" not in md[2]  # idle 与未知都不标
    assert calls == []                              # 构建卡片期间零忙闲探测调用


def test_rel_time_buckets():
    """相对活跃时间四档文案：刚刚 / N 分钟前 / N 小时前 / N 天前。"""
    now = time.time()
    assert feishu_conv._rel_time(now) == "刚刚"
    assert feishu_conv._rel_time(now - 59) == "刚刚"
    assert feishu_conv._rel_time(now - 3 * 60) == "3 分钟前"
    assert feishu_conv._rel_time(now - 5 * 3600) == "5 小时前"
    assert feishu_conv._rel_time(now - 3 * 86400) == "3 天前"


def test_conv_intent_sessions_use_leave(monkeypatch):
    """执行器分派：会话 ⇒ 发列表卡且不另发文本；绑定 ⇒ 文本兜底；解绑 ⇒ 清绑定留项目。"""
    uid = 415
    pid = _mk_project(uid, "p_ci5")
    db.set_feishu_binding("ou_s15", uid)
    db.set_feishu_default_project("ou_s15", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-a1", "修登录", 3)])
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    # 列表卡逐行出 🏃 标记：桩掉让断言只钉指令行为（读口是 dshevents，零请求；
    # 此前走 chat.dsh_busy → 驱动 /status，设了 TS_AGENT_DRIVER_URL 时真发 loopback）
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    sent = []
    monkeypatch.setattr(feishu_conv, "send_card",
                        lambda oid, card, cfg: sent.append((oid, card)) or True)
    binding = db.get_feishu_binding_by_open("ou_s15")
    assert feishu_conv.conv_intent(binding, "sessions", [None], "ou_s15", {}) == ""
    assert sent and sent[0][0] == "ou_s15"
    assert [e for e in sent[0][1]["elements"] if e.get("tag") == "select_static"]
    assert "已绑定" in feishu_conv.conv_intent(binding, "use", ["修登录"], "ou_s15", {})
    assert db.get_feishu_binding_by_open("ou_s15")["cur_sid"] == "session-a1"
    # 生产口径：每条消息都由 execute_intent 现取 binding（这里同样重取，不拿旧快照）
    binding = db.get_feishu_binding_by_open("ou_s15")
    assert "已解绑" in feishu_conv.conv_intent(binding, "leave", [None], "ou_s15", {})
    assert db.get_feishu_binding_by_open("ou_s15")["cur_sid"] == ""


def test_sessions_intent_text_fallback_when_card_send_fails(monkeypatch):
    """卡片发不出去（send_card 返回 False）：回会话纯文本清单 + 文本绑定指引，不静默。

    序号与卡片同锚（`_LAST_LIST`）：文本兜底里「1.」就是「绑定会话 1」能绑的那条，
    否则用户照文本发序号会绑到别的会话上。
    """
    uid = 422
    pid = _mk_project(uid, "p_fb_sess")
    db.set_feishu_binding("ou_s22", uid)
    db.set_feishu_default_project("ou_s22", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-f1", "修登录", 3)])
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    monkeypatch.setattr(feishu_conv, "send_card", lambda oid, card, cfg: False)
    binding = db.get_feishu_binding_by_open("ou_s22")
    reply = feishu_conv.conv_intent(binding, "sessions", [None], "ou_s22", {})
    assert reply                                        # 有回执，不静默
    assert "修登录" in reply and "1." in reply           # 会话清单以文本形式仍可达
    assert "绑定会话" in reply                           # 可执行的兜底指引
    assert feishu_conv._LAST_LIST["ou_s22"][1] == ["session-f1"]   # 序号锚一致
    assert "已绑定" in feishu_conv.use_by_token(binding, "1")      # 照文本发序号可用


def test_route_text_rejects_overlong_message(monkeypatch):
    """长度闸（口径同站点 `POST …/messages` 的 `chat.MESSAGE_MAX`）：超限不投递，回中文回执。

    飞书侧此前没有这道闸，一条超长消息会被原样塞进 `chat.submit`（站点路径有闸、
    飞书路径没有 ⇒ 同一份载荷两条入口两种行为）。
    """
    uid = 425
    pid = _mk_project(uid, "p_toolong")
    db.set_feishu_binding("ou_s25", uid)
    db.set_feishu_default_project("ou_s25", pid)
    db.set_feishu_cur_session("ou_s25", pid, "session-long", "会话L")
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    monkeypatch.setattr(chat, "submit",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("不应投递")))
    binding = db.get_feishu_binding_by_open("ou_s25")
    reply = feishu_conv.route_text(binding, "字" * (chat.MESSAGE_MAX + 1))
    assert str(chat.MESSAGE_MAX) in reply                # 点明上限（复用常量，不硬编码数字）
    assert "附件" in reply or "文件" in reply             # 给出路：改发文件/附件
    assert "拆" in reply                                 # 或拆成几条
    assert db.get_feishu_binding_by_open("ou_s25")["cur_sid"] == "session-long"  # 零副作用
    # 边界：正好等于上限照常投递（闸是 >，与站点路径逐字同口径）
    calls = []
    monkeypatch.setattr(chat, "submit",
                        lambda *a, **k: calls.append(a) or {"state": "queued", "queued": False})
    monkeypatch.setattr(feishu_conv, "_baseline_of", lambda sid: 0)
    assert "已投递" in feishu_conv.route_text(binding, "字" * chat.MESSAGE_MAX)
    assert len(calls) == 1


def test_route_text_no_default_project_sends_projects_card(monkeypatch):
    """设计 §3.4 分支 4（C3 从 T4 顺延到本任务）：无默认项目 ⇒ 引导文案 + 项目总览卡；
    无项目用户 projects_card 为 None ⇒ 只回文本、绝不发空卡。"""
    uid = 416
    _mk_project(uid, "p_c3a")
    _mk_project(uid, "p_c3b")
    db.set_feishu_binding("ou_s16", uid)
    sent = []
    monkeypatch.setattr(feishu_conv, "send_card",
                        lambda oid, card, cfg: sent.append((oid, card)))
    monkeypatch.setattr(chat, "submit", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("不应投递")))
    reply = feishu_conv.route_text(db.get_feishu_binding_by_open("ou_s16"), "你好")
    assert "默认项目" in reply
    assert sent and sent[0][0] == "ou_s16"
    assert [e for e in sent[0][1]["elements"] if e.get("tag") == "select_static"]
    db.set_feishu_binding("ou_s16b", 417)
    reply2 = feishu_conv.route_text(db.get_feishu_binding_by_open("ou_s16b"), "你好")
    assert reply2                                                 # 无项目也有文案，不静默
    assert len(sent) == 1                                         # 不发空卡


def test_default_project_switch_invalidates_list_memory(monkeypatch):
    """换默认项目 ⇒ 序号记忆作废（列表记忆属旧项目，防按序号把旧项目会话绑到新项目）。"""
    uid = 418
    p1 = _mk_project(uid, "p_switch1")
    p2 = _mk_project(uid, "p_switch2")
    db.set_feishu_binding("ou_s18", uid)
    db.set_feishu_default_project("ou_s18", p1)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-sw1", "旧项目会话", 3)])
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    # 同 test_use_by_index_title_and_prefix：桩掉 🏃 探测，断言只钉「换项目作废序号记忆」
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    binding = db.get_feishu_binding_by_open("ou_s18")
    feishu_conv.sessions_card(binding)                          # 产生 _LAST_LIST
    assert feishu_conv._LAST_LIST["ou_s18"][1] == ["session-sw1"]
    feishu_conv.set_default_project(binding, db.get_project(p2))
    assert "ou_s18" not in feishu_conv._LAST_LIST               # 换项目即作废
    assert "已绑定" not in feishu_conv.use_by_token(binding, "1")
    # 同项目重复设置不作废（用户只是重新确认默认项目）
    feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s18"))
    feishu_conv.set_default_project(db.get_feishu_binding_by_open("ou_s18"),
                                    db.get_project(p2))
    assert "ou_s18" in feishu_conv._LAST_LIST


def test_remember_list_purges_expired_buckets(monkeypatch):
    """列表记忆写入时清理过期桶（TTL LIST_TTL）：内存态不随用户数无界增长。"""
    uid = 419
    pid = _mk_project(uid, "p_purge")
    db.set_feishu_binding("ou_s19", uid)
    db.set_feishu_default_project("ou_s19", pid)
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-p1", "会话P", 5)])
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    feishu_conv._LAST_LIST["ou_stale"] = (time.time() - feishu_conv.LIST_TTL - 1, ["x"])
    card = feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s19"))
    assert card is not None
    assert "ou_stale" not in feishu_conv._LAST_LIST            # 过期桶被清理
    assert feishu_conv._LAST_LIST["ou_s19"][1] == ["session-p1"]


def test_bind_session_rejects_sid_outside_project_bucket(monkeypatch):
    """绑定必须校验 sid 落在**默认项目的会话桶**内（评审 F1 修复轮）。

    `sessparse.session_exists` 是跨 bucket 的纯路径存在性（`_dsh_session_file` 走
    `glob(DSH_SESSIONS/*/<sid>/…)`），与项目无关：只验它，一个存在于别项目的 sid
    也会绑成功，写出 `cur_sid` 与 `cur_project_id` 不一致的绑定态。这里
    `session_exists` 打桩为 True（伪造「存在」），而 `list_sessions` 的结果集**不含**
    该 sid ⇒ 必须回 `SESSION_GONE` 且一个字都不写（绑定保持原样）。
    """
    uid = 420
    _mk_project(uid, "p_cross_other")                  # 别项目（sid 的真实归属）
    p_def = _mk_project(uid, "p_cross_def")            # 默认项目
    db.set_feishu_binding("ou_s20", uid)
    db.set_feishu_default_project("ou_s20", p_def)
    db.set_feishu_cur_session("ou_s20", p_def, "session-b", "B 的会话")
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    # 默认项目的会话集里只有 session-b；session-a 属于 p_other（不在结果集内）
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-b", "B 的会话", 2)])
    binding = db.get_feishu_binding_by_open("ou_s20")
    assert feishu_conv.bind_session(binding, "session-a") == feishu_conv.SESSION_GONE
    row = db.get_feishu_binding_by_open("ou_s20")
    assert (row["cur_sid"], row["cur_project_id"]) == ("session-b", p_def)   # 零写入


def test_ss_callback_rejects_old_card_sid_after_project_switch(monkeypatch):
    """评审复现链（可达，无需伪造）：A 项目发「会话」卡 → 切默认项目到 B → 点**旧卡**。

    卡片是快照：`set_default_project` 能作废内存里的 `_LAST_LIST`，却收不回已经投递到
    飞书会话里的那张卡，它的 option value 仍是 A 的 sid；而 `session_exists` 对跨
    bucket 的 sid 依旧为真 ⇒ 只验存在就会写成 `cur_sid=A 的会话 + cur_project_id=B`
    （A 的会话占用 B 的项目运行位、回流归因错）。修复后必须回错误 toast 且零写入。
    """
    uid = 421
    pa = _mk_project(uid, "p_old_a")
    pb = _mk_project(uid, "p_old_b")
    db.set_feishu_binding("ou_s21", uid)
    db.set_feishu_default_project("ou_s21", pa)
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists",
                        lambda fam, sid: True)      # 跨 bucket 的「存在」：必须不够
    monkeypatch.setattr(feishu_conv.sessparse, "session_title", lambda fam, sid: "A 的会话")
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-a", "A 的会话", 3)])
    monkeypatch.setattr(feishu_conv, "_session_busy", lambda sid: False)
    card = feishu_conv.sessions_card(db.get_feishu_binding_by_open("ou_s21"))   # A 的卡
    old_option = [e for e in card["elements"]
                  if e.get("tag") == "select_static"][0]["options"][0]["value"]
    assert old_option == "session-a"
    # 切默认项目到 B：序号记忆作废，但旧卡的 option value 无法收回
    feishu_conv.set_default_project(db.get_feishu_binding_by_open("ou_s21"),
                                    db.get_project(pb))
    monkeypatch.setattr(feishu_conv.sessparse, "list_sessions",
                        lambda fam, cwd: [_sess("session-b", "B 的会话", 2)])
    binding = db.get_feishu_binding_by_open("ou_s21")
    toast = feishu_conv.on_card_action("ou_s21", binding, {"t": "ss", "u": uid},
                                       {"option": old_option}, {})
    assert toast["toast"]["type"] == "error"
    row = db.get_feishu_binding_by_open("ou_s21")
    assert (row["cur_sid"], row["cur_project_id"]) == ("", 0)     # 零写入


# ---------- Task 6：答复回流（终态钩子 + 抽取 + 截断推送） ----------
#
# 全程零网络：推送一律走 `feishu_conv._dm`，测试里同时打桩 `feishu.rest_send_text`
# （`_dm` 的实际出口）与 `feishu._dm_text`（双保险，防实现改走它），并给
# `feishu.app_config` 返回**齐备**凭据——F1 凭据闸要求 app_id + app_secret 同时存在，
# 只给 app_id 会被闸挡在 REST 之前（该闸由 T4 评审补入，晚于本任务 brief 成文）。

def test_msg_meta_reads_last_row():
    """msg_meta 读到最后一行 meta；无行/坏 JSON 均为 {}。"""
    assert waitq.msg_meta("no-such-msg") == {}
    pid = _mk_project(711, "p_msgmeta")
    mid = "m-meta-1"
    waitq.msg_enqueue(mid, pid, "session-meta", "hi",
                      meta={"family": "dsh_plugin", "feishu": {"open_id": "ou_m"}})
    assert waitq.msg_meta(mid)["feishu"] == {"open_id": "ou_m"}
    # 终态化后仍可读（state 无关：回流钩子跑在收口**之后**）
    waitq.finish_by_target(waitq.KIND_MSG, mid, waitq.STATE_DONE)
    assert waitq.msg_meta(mid)["feishu"] == {"open_id": "ou_m"}
    # 「最后一行」语义 + 坏 JSON 兜底（测试直写；生产写口唯一在 waitq）
    with db.connect() as conn:
        conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                     " created_at, meta) VALUES (?,?,?,'done',?,?,?)",
                     (pid, waitq.KIND_MSG, mid, 99.0, db.now_str(), "不是JSON"))
    assert waitq.msg_meta(mid) == {}


def test_notify_msg_done_pushes_reply(monkeypatch):
    """done：按 baseline 取新增 assistant 文本推回 DM（think/tool 忽略、超长截断）。"""
    uid = 501
    pid = _mk_project(uid, "p_reply")
    db.set_feishu_binding("ou_k1", uid)
    db.set_feishu_cur_session("ou_k1", pid, "session-k1", "会话K")
    sent = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append((oid, text)))
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: sent.append((oid, text)))
    monkeypatch.setattr(feishu, "app_config",
                        lambda u: {"app_id": "cli_x", "app_secret": "s"})

    class _FakeRunner:                       # 让 submit 走队列路径，写出等待项 meta
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    monkeypatch.setattr(feishu_conv, "_baseline_of", lambda sid: 2)
    res = chat.submit(pid, "session-k1", "问一句", family="dsh_plugin",
                      extra_meta={"feishu": {"open_id": "ou_k1", "user_id": uid,
                                             "project_id": pid, "baseline": 2,
                                             "title": "会话K"}})
    entries = [{"seq": 0, "kind": "user", "text": "问一句"},
               {"seq": 1, "kind": "user", "text": "旧"},
               {"seq": 2, "kind": "think", "text": "想想"},
               {"seq": 3, "kind": "assistant", "text": "答复一"},
               {"seq": 4, "kind": "tool_call", "name": "bash"},
               {"seq": 5, "kind": "assistant", "text": "答复二"}]
    monkeypatch.setattr(feishu_conv.sessparse, "load",
                        lambda fam, sid, agent, after=0: {"found": True,
                                                          "entries": entries[after:],
                                                          "total": len(entries)})
    feishu_conv.notify_msg_done(res["id"], "done")
    assert sent and sent[0][0] == "ou_k1"
    assert "答复一" in sent[0][1] and "答复二" in sent[0][1] and "想想" not in sent[0][1]


def test_notify_msg_done_rechecks_binding_before_push(monkeypatch, capsys):
    """推送前复核绑定归属（隐私）：提交时定格的 open_id 可能已被解绑或改绑给别的用户。

    三种情形：绑定行不存在 ⇒ 不推；绑定行存在但 `user_id` 与载荷不一致 ⇒ 不推
    （否则这本该给甲看的答复会送到接手该飞书号的新持有人手里）；两者一致 ⇒ 照常推。
    """
    uid = 504
    pid = _mk_project(uid, "p_rebind")
    sent = []
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: sent.append((oid, text)))
    monkeypatch.setattr(feishu, "app_config",
                        lambda u: {"app_id": "cli_x", "app_secret": "s"})

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())

    def _submit(open_id, user_id):
        return chat.submit(pid, f"s-{open_id}", "问一句", family="dsh_plugin",
                           extra_meta={"feishu": {"open_id": open_id, "user_id": user_id,
                                                  "project_id": pid, "baseline": 0,
                                                  "title": "会话R"}})["id"]

    # ① 绑定行不存在（提交后被解绑）：不推
    feishu_conv.notify_msg_done(_submit("ou_r_none", uid), "done")
    assert sent == []
    # ② 绑定行存在但已改绑给另一个 Touchstone 用户：不推（error 路同样受保护）
    db.set_feishu_binding("ou_r_other", uid + 1)
    feishu_conv.notify_msg_done(_submit("ou_r_other", uid), "error")
    assert sent == []
    assert capsys.readouterr().err.count("绑定已变更") == 2      # 两次都留痕说明原因
    # ③ 绑定一致：照常推
    db.set_feishu_binding("ou_r_ok", uid)
    monkeypatch.setattr(feishu_conv, "_reply_of", lambda sid, base: "答复正文")
    feishu_conv.notify_msg_done(_submit("ou_r_ok", uid), "done")
    assert sent == [("ou_r_ok", "答复正文")]


def test_notify_msg_done_yielded_and_error(monkeypatch):
    """yielded 不推答复；error 推失败摘要；非飞书来源完全不动。"""
    uid = 502
    pid = _mk_project(uid, "p_reply2")
    db.set_feishu_binding("ou_k2", uid)      # 推送前的绑定归属复核要求绑定行仍在
    sent = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append(text))
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: sent.append(text))
    monkeypatch.setattr(feishu, "app_config",
                        lambda u: {"app_id": "cli_x", "app_secret": "s"})

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    feishu_meta = {"feishu": {"open_id": "ou_k2", "user_id": uid, "project_id": pid,
                              "baseline": 0, "title": "会话Y"}}
    m1 = chat.submit(pid, "s1", "a", family="dsh_plugin", extra_meta=feishu_meta)["id"]
    feishu_conv.notify_msg_done(m1, "yielded")
    assert sent == []                       # 挂起等作答：交既有作答链路
    m2 = chat.submit(pid, "s2", "b", family="dsh_plugin", extra_meta=feishu_meta)["id"]
    feishu_conv.notify_msg_done(m2, "error")
    assert sent and "失败" in sent[0]
    m3 = chat.submit(pid, "s3", "c", family="dsh_plugin")["id"]     # 无 feishu meta
    feishu_conv.notify_msg_done(m3, "done")
    assert len(sent) == 1


def test_notify_msg_done_no_creds_skips_push(monkeypatch, capsys):
    """凭据缺失：回流只留痕、零网络（T4 的 F1 闸在回流路径同样生效）。"""
    uid = 503
    pid = _mk_project(uid, "p_reply3")
    db.set_feishu_binding("ou_nc", uid)      # 绑定一致，闸的位置在凭据而不是归属
    calls = []
    monkeypatch.setattr(feishu, "_dm_text",
                        lambda oid, text, cfg: calls.append((oid, text)))
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: calls.append((oid, text)))
    monkeypatch.setattr(feishu, "app_config", lambda u: None)      # 库里也没有凭据

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    res = chat.submit(pid, "s-nc", "嗨", family="dsh_plugin",
                      extra_meta={"feishu": {"open_id": "ou_nc", "user_id": uid,
                                             "baseline": 0}})
    feishu_conv.notify_msg_done(res["id"], "error")
    assert calls == []
    assert "凭据缺失" in capsys.readouterr().err


def test_reply_of_reads_after_baseline_and_tolerates_failure(monkeypatch):
    """_reply_of：只拼 assistant 文本、空串过滤；读会话异常/未找到一律回空串。"""
    monkeypatch.setattr(feishu_conv.sessparse, "load",
                        lambda fam, sid, agent, after=0: {
                            "found": True, "total": 3,
                            "entries": [{"kind": "assistant", "text": " 甲 "},
                                        {"kind": "tool_result", "text": "乙"},
                                        {"kind": "assistant", "text": "   "}]})
    assert feishu_conv._reply_of("sid-x", 0).strip() == "甲"   # 只拼 assistant，tool 忽略
    assert "乙" not in feishu_conv._reply_of("sid-x", 0)       # 纯空白项被丢弃
    monkeypatch.setattr(feishu_conv.sessparse, "load",
                        lambda fam, sid, agent, after=0: {"found": False, "entries": []})
    assert feishu_conv._reply_of("sid-x", 0) == ""
    monkeypatch.setattr(feishu_conv.sessparse, "load",
                        lambda fam, sid, agent, after=0: (_ for _ in ()).throw(OSError("坏会话")))
    assert feishu_conv._reply_of("sid-x", 0) == ""


def test_reply_of_truncates():
    """超长答复截断并附站点指引。"""
    long_text = "字" * (feishu_conv.REPLY_MAX_CHARS + 500)
    out = feishu_conv._clip_reply(long_text)          # 纯函数，直接测
    assert len(out) < feishu_conv.REPLY_MAX_CHARS + 100
    assert "完整内容" in out
    assert feishu_conv._clip_reply("  短答复  ") == "短答复"
    assert feishu_conv._clip_reply("") == ""


def test_fire_msg_done_noop_without_hook(capsys):
    """未注册钩子时 _fire_msg_done 是纯 no-op（既有行为零变化）。"""
    chat.set_msg_done_hook(None)
    chat._fire_msg_done("m-none", "done")
    assert capsys.readouterr().out == ""


def test_run_unit_fires_done_hook(monkeypatch):
    """接线钉子：run_unit 收口触发已注册终态钩子（done 与 yielded 两条路）。

    为什么必须单独钉：submit 的同步路径（无 runner 单例）不经 run_unit，
    钩子接线只在队列执行体里生效——不测这条，接线断了没人知道。"""
    seen = []
    pid = _mk_project(701, "p_hook")

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    monkeypatch.setattr(chat, "_rebuild_run", lambda msg_id, meta=None: (lambda: None))
    chat.set_msg_done_hook(lambda msg_id, state: seen.append(state))
    try:
        m1 = chat.submit(pid, "s-hook1", "x", family="dsh_plugin")["id"]
        chat.run_unit(m1)
        assert seen == ["done"], seen
        monkeypatch.setattr(chat, "_rebuild_run",
                            lambda msg_id, meta=None: (lambda: chat.STATE_YIELDED))
        m2 = chat.submit(pid, "s-hook2", "y", family="dsh_plugin")["id"]
        chat.run_unit(m2)
        assert seen == ["done", "yielded"], seen
    finally:
        chat.set_msg_done_hook(None)


def test_run_unit_fires_error_hook_on_rebuild_failure(monkeypatch):
    """重建失败（内层 except）：钩子收 error 一次，两条记录都落终态。"""
    seen = []
    pid = _mk_project(702, "p_hook_fail")

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    monkeypatch.setattr(chat, "_rebuild_run",
                        lambda msg_id, meta=None: (_ for _ in ()).throw(RuntimeError("坏载荷")))
    chat.set_msg_done_hook(lambda msg_id, state: seen.append(state))
    try:
        mid = chat.submit(pid, "s-hook-fail", "x", family="dsh_plugin")["id"]
        chat.run_unit(mid)
    finally:
        chat.set_msg_done_hook(None)
    assert seen == ["error"], seen
    assert waitq.msg_get(mid)["state"] == "error"
    assert waitq.get_active(waitq.KIND_MSG, mid) is None       # 等待项不悬挂


def test_run_unit_fires_error_hook_on_outer_failure(monkeypatch):
    """最外层异常（认领写库失败等）：同样触发一次 error 钩子且不抛出。"""
    seen = []
    pid = _mk_project(703, "p_hook_outer")

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    mid = chat.submit(pid, "s-hook-outer", "x", family="dsh_plugin")["id"]
    monkeypatch.setattr(chat.waitq, "msg_claim",
                        lambda msg_id: (_ for _ in ()).throw(sqlite3.OperationalError("库故障")))
    chat.set_msg_done_hook(lambda msg_id, state: seen.append(state))
    try:
        chat.run_unit(mid)                    # 不抛
    finally:
        chat.set_msg_done_hook(None)
    assert seen == ["error"], seen
    assert waitq.get_active(waitq.KIND_MSG, mid) is None       # 等待项已收口
    assert waitq.msg_get(mid)["state"] == "queued"             # 消息行由 selfcheck 兜底


def test_run_unit_hook_error_does_not_disturb_closure(monkeypatch, capsys):
    """钩子抛异常绝不影响队列收口（chat_msgs 与等待项照常落终态）。"""
    pid = _mk_project(704, "p_hook_boom")

    class _FakeRunner:
        def unit_busy(self, pid):
            return False

        def submit_msg(self, msg_id, pid, sid):
            pass

    monkeypatch.setattr(runner, "INSTANCE", _FakeRunner())
    monkeypatch.setattr(chat, "_rebuild_run", lambda msg_id, meta=None: (lambda: None))
    chat.set_msg_done_hook(lambda msg_id, state: (_ for _ in ()).throw(RuntimeError("boom")))
    try:
        mid = chat.submit(pid, "s-hook-boom", "x", family="dsh_plugin")["id"]
        chat.run_unit(mid)                    # 钩子异常被吞，收口照常
    finally:
        chat.set_msg_done_hook(None)
    assert waitq.msg_get(mid)["state"] == "done"
    assert waitq.get_active(waitq.KIND_MSG, mid) is None
    assert "终态钩子异常" in capsys.readouterr().out


def test_start_registers_hook_idempotently():
    """feishu_conv.start() 幂等注册终态钩子（重复调用不叠加、不报错）。"""
    try:
        feishu_conv.start()
        assert chat._MSG_DONE_HOOK is feishu_conv.notify_msg_done
        feishu_conv.start()                   # 幂等：再调一次仍是同一注册位
        assert chat._MSG_DONE_HOOK is feishu_conv.notify_msg_done
    finally:
        chat.set_msg_done_hook(None)


def test_start_notifier_wires_conv_hook(monkeypatch):
    """接线钉子：feishu.start_notifier() 必须调 feishu_conv.start()（缺则回流全哑）。"""
    calls = []
    monkeypatch.setattr(feishu, "_send_loop", lambda: None)   # 不真起投递循环
    monkeypatch.setattr(feishu, "_SENDER_STARTED", False)
    monkeypatch.setattr(feishu_conv, "start", lambda: calls.append("start"))
    feishu.start_notifier()
    feishu.start_notifier()                   # 幂等：线程标记已置位，不再重复注册
    assert calls == ["start"], calls
