# 飞书接入操作卡片（M11，2026-10-17）：换凭据免重启 + DM 卡片按钮。
#
# 契约面：① `setup_card` 是**纯函数**（入参 ⇒ 确定 JSON，两侧后端逐字节对拍，
# 见 tools/parity/cases-mod/feishu_setup_card.json）；② `stop/restart_inbound_for`
# 用真 event loop 的合成线程验证「停得掉、再起得来」（不连真网关）；③ 动作分发按
# open_id→binding + nonce 双复核，文案逐字钉住（node 侧同文案）。
# 全部用例零真实网络：REST/DM/线程入口一律打桩。
import asyncio
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
import feishu  # noqa: E402

db.init_db()  # 测试库建表（幂等；conftest 已把 TOUCHSTONE_DB 指到临时库）

_CFG = {"app_id": "cli_old", "app_secret": "sec_old"}
_BOUND = {"open_id": "ou_1", "user_id": 1}


def _clear_ws():
    feishu._WS_THREADS.clear()
    feishu._WS_APP_ID.clear()
    feishu._WS_CLIENTS.clear()


# ---------- 卡片 JSON（纯函数，逐字节契约） ----------

def test_setup_card_switching_shape():
    """换应用形态：橙色标题、状态行两个 app、唯一 primary 是「换用新应用」。"""
    card = feishu.setup_card(1, "cli_new", "cli_old", "nonce1234")
    assert card["schema"] == "2.0"
    assert card["header"] == {"title": {"tag": "plain_text", "content": "🔁 飞书应用已变更"},
                              "template": "orange"}
    els = card["body"]["elements"]
    assert els[0] == {"tag": "markdown", "content":
                      "**当前应用**：`cli_new`\n**入站长连接**：运行中 · 绑在 `cli_old`"}
    assert "检测到应用凭据已换为 `cli_new`" in els[1]["content"]
    assert "长连接还绑在旧应用 `cli_old` 上" in els[1]["content"]
    buttons = [e for e in els if e["tag"] == "button"]
    assert [b["text"]["content"] for b in buttons] == [
        "🔁 换用新应用", "🔑 生成绑定码", "🩺 配置自检", "🧩 补齐配置", "🚀 提交发布"]
    assert [b["type"] for b in buttons] == ["primary", "default", "default", "default", "default"]
    # 所有按钮共用一个 value 形状 {t=fs, a=动作, u=用户id, n=nonce}
    assert [b["behaviors"][0]["value"] for b in buttons] == [
        {"t": "fs", "a": "switch", "u": 1, "n": "nonce1234"},
        {"t": "fs", "a": "bindcode", "u": 1, "n": "nonce1234"},
        {"t": "fs", "a": "doctor", "u": 1, "n": "nonce1234"},
        {"t": "fs", "a": "apply", "u": 1, "n": "nonce1234"},
        {"t": "fs", "a": "publish", "u": 1, "n": "nonce1234"}]
    assert all(b["behaviors"][0]["type"] == "callback" for b in buttons)
    assert els[-1] == {"tag": "markdown", "content": "卡片 10 分钟内有效；过期后发「接入」重新获取。"}


def test_setup_card_normal_shape_and_empty_states():
    """同应用形态：蓝色标题、primary 是「重连入站」；空 app/未运行各有一档文案。"""
    card = feishu.setup_card(2, "cli_x", "cli_x", "n0")
    assert card["header"]["title"]["content"] == "🛠 飞书接入操作"
    assert card["header"]["template"] == "blue"
    els = card["body"]["elements"]
    assert els[0]["content"] == "**当前应用**：`cli_x`\n**入站长连接**：运行中 · 绑在 `cli_x`"
    first_btn = [e for e in els if e["tag"] == "button"][0]
    assert first_btn["text"]["content"] == "🔄 重连入站"
    assert first_btn["behaviors"][0]["value"] == {"t": "fs", "a": "restart", "u": 2, "n": "n0"}
    # 未配置应用 + 连接未运行：状态行给两档兜底文案（不出现空反引号）
    empty = feishu.setup_card("9", "", "", "nn")
    assert empty["body"]["elements"][0]["content"] == \
        "**当前应用**：（未配置）\n**入站长连接**：未运行"
    assert empty["header"]["title"]["content"] == "🛠 飞书接入操作"
    assert empty["body"]["elements"][2]["behaviors"][0]["value"]["u"] == 9


def test_setup_card_is_pure_and_deterministic():
    """同一入参 ⇒ 同一 JSON；用户/应用/nonce 变则对应字段变（没有隐藏状态）。"""
    a = feishu.setup_card(3, "cli_a", "cli_b", "n1")
    b = feishu.setup_card(3, "cli_a", "cli_b", "n1")
    assert a == b
    c = feishu.setup_card(4, "cli_a", "cli_b", "n1")
    assert c["body"]["elements"][2]["behaviors"][0]["value"]["u"] == 4
    d = feishu.setup_card(3, "cli_a", "cli_b", "n2")
    assert d["body"]["elements"][2]["behaviors"][0]["value"]["n"] == "n2"
    e = feishu.setup_card(3, "cli_a", "cli_a", "n1")
    assert e["body"]["elements"][2]["behaviors"][0]["value"]["a"] == "restart"


# ---------- nonce（内存态 10 分钟、绑定用户） ----------

def test_setup_nonce_ttl_binding_and_pruning(monkeypatch):
    """nonce 绑定 user_id；过期项在下次生成时清掉；TTL 常量是 10 分钟。"""
    assert feishu._SETUP_NONCE_TTL == 600
    feishu._SETUP_NONCES.clear()
    try:
        n1 = feishu._setup_nonce(1)
        assert len(n1) == 16 and n1 in feishu._SETUP_NONCES
        uid, exp = feishu._SETUP_NONCES[n1]
        assert uid == 1 and 590 < exp - time.time() <= 600
        # 人为过期 + 再生成：过期项被清、新项在
        feishu._SETUP_NONCES[n1] = (1, time.time() - 1)
        n2 = feishu._setup_nonce(2)
        assert n1 not in feishu._SETUP_NONCES and n2 in feishu._SETUP_NONCES
        assert feishu._SETUP_NONCES[n2][0] == 2
    finally:
        feishu._SETUP_NONCES.clear()


# ---------- 动作分发：身份 + nonce 双复核 ----------

class _Recorder:
    """按调用顺序记录 (名字, 参数)；动作分发的「顺序」本身就是判据（先取码再重连）。"""

    def __init__(self):
        self.calls = []

    def __call__(self, name, *args):
        self.calls.append((name,) + args)
        return None


def test_on_setup_card_action_unbound(monkeypatch):
    """未绑定点卡片：DM 引导 + error toast（与 t=sc/t=dp 同款文案）。"""
    sent = []
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_open", lambda oid: None)
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append((oid, text)))
    out = feishu._on_setup_card_action("ou_x", {"t": "fs", "a": "restart", "u": 1, "n": "x"},
                                       _CFG)
    assert out == {"toast": {"type": "error", "content": "尚未绑定站点账号"}}
    assert sent and "尚未绑定 Touchstone 账号" in sent[0][1]


def test_on_setup_card_action_rejects_wrong_account_and_stale_nonce(monkeypatch):
    """防串号：卡片里的 u ≠ 点击者绑定用户 ⇒ 拒；nonce 缺失/过期/属别人 ⇒ 拒。"""
    sent = []
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1})
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append(text))
    feishu._SETUP_NONCES.clear()
    try:
        out = feishu._on_setup_card_action(
            "ou_1", {"t": "fs", "a": "restart", "u": 2, "n": "whatever"}, _CFG)
        assert out == {"toast": {"type": "error", "content": "该卡片不属于当前账号"}}
        # 不存在的 nonce
        out = feishu._on_setup_card_action(
            "ou_1", {"t": "fs", "a": "restart", "u": 1, "n": "missing"}, _CFG)
        assert out == {"toast": {"type": "error", "content": "卡片已失效，发「接入」重新获取"}}
        # 别人名下的 nonce
        feishu._SETUP_NONCES["n-other"] = (2, time.time() + 600)
        out = feishu._on_setup_card_action(
            "ou_1", {"t": "fs", "a": "restart", "u": 1, "n": "n-other"}, _CFG)
        assert out == {"toast": {"type": "error", "content": "卡片已失效，发「接入」重新获取"}}
        # 过期
        feishu._SETUP_NONCES["n-old"] = (1, time.time() - 1)
        out = feishu._on_setup_card_action(
            "ou_1", {"t": "fs", "a": "restart", "u": 1, "n": "n-old"}, _CFG)
        assert out == {"toast": {"type": "error", "content": "卡片已过期，发「接入」重新获取"}}
        assert "n-old" not in feishu._SETUP_NONCES
        assert sent == []
    finally:
        feishu._SETUP_NONCES.clear()


def test_bindcode_action_texts(monkeypatch):
    """「生成绑定码」：发新码 + 两条使用指引（未绑定 / 换绑先解绑）。"""
    sent = []
    monkeypatch.setattr(feishu, "make_bind_code", lambda uid: "AB12CD")
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append((oid, text, cfg)))
    toast, text = feishu._setup_bindcode(1)
    assert toast == {"toast": {"type": "success", "content": "绑定码已私聊发你"}}
    assert text == ("🔑 新的绑定码：AB12CD（10 分钟内有效）\n"
                    "· 未绑定：在本机器人单聊回复「绑定 <码>」\n"
                    "· 已绑定换号：先发「解绑」，再发「绑定 <码>」")


def test_restart_action_ok_and_fail_texts(monkeypatch):
    """「重连入站」：成功/失败两条文案 + toast；凭据缺失不调重连。"""
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    monkeypatch.setattr(feishu, "restart_inbound_for", lambda uid: True)
    toast, text = feishu._setup_restart(1)
    assert toast == {"toast": {"type": "success", "content": "已重连"}}
    assert text == "🔄 已用当前应用 `cli_old` 重新建立长连接。"
    monkeypatch.setattr(feishu, "restart_inbound_for", lambda uid: False)
    toast, text = feishu._setup_restart(1)
    assert toast == {"toast": {"type": "error", "content": "重连失败，看私聊"}}
    assert text == "❌ 重连失败：旧连接未在超时内退出，稍后再点一次；仍不行请重启站点。"
    calls = []
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    monkeypatch.setattr(feishu, "restart_inbound_for",
                        lambda uid: calls.append(uid) or True)
    toast, text = feishu._setup_restart(1)
    assert calls == [] and toast["toast"]["type"] == "error"
    assert text.startswith("❌ 应用凭据未配置")


def test_switch_action_gets_code_before_restart(monkeypatch):
    """「换用新应用」顺序：先 DM 绑定码（旧应用凭据）→ 再停旧起新；成功后不再补 DM。"""
    rec = _Recorder()

    def _send(oid, text, cfg):
        rec("dm", oid, text, cfg["app_id"])

    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_new", "app_secret": "sec_new"})
    monkeypatch.setattr(feishu, "make_bind_code", lambda uid: "NEW123")
    monkeypatch.setattr(feishu, "rest_send_text", _send)
    monkeypatch.setattr(feishu, "restart_inbound_for",
                        lambda uid: rec("restart", uid) or True)
    toast, text = feishu._setup_switch(1, "ou_1", _CFG)
    assert rec.calls == [
        ("dm", "ou_1", "🔁 已切换到新应用 `cli_new`。\n"
                       "**新的绑定码：NEW123**（10 分钟内有效）\n"
                       "本（旧）机器人的连接马上断开；请到新机器人单聊里回复：\n"
                       "绑定 NEW123", "cli_old"),
        ("restart", 1)]
    assert toast == {"toast": {"type": "success", "content": "已切换，去新机器人绑定"}}
    assert text == ""       # 码已单独 DM 过，不再重复


def test_switch_action_aborts_when_code_dm_fails(monkeypatch):
    """码发不出去就不动连接（否则用户既进不去新机器人、旧机器人也断了）。"""
    rec = _Recorder()
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_new", "app_secret": "sec_new"})
    monkeypatch.setattr(feishu, "make_bind_code", lambda uid: "NEW123")
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda oid, text, cfg: (_ for _ in ()).throw(
                            feishu.FeishuRestError("send failed code=230001", code=230001)))
    monkeypatch.setattr(feishu, "restart_inbound_for",
                        lambda uid: rec("restart", uid) or True)
    toast, text = feishu._setup_switch(1, "ou_1", _CFG)
    assert rec.calls == []
    assert toast["toast"]["type"] == "error"
    assert text.startswith("❌ 绑定码没能发进本会话")
    assert "重连未执行" in text


def test_switch_action_same_app_only_reconnects(monkeypatch):
    """只换了 secret（同一 app_id）：不生成绑定码，直接重连。"""
    rec = _Recorder()
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    monkeypatch.setattr(feishu, "rest_send_text",
                        lambda *a: rec("dm"))
    monkeypatch.setattr(feishu, "make_bind_code", lambda uid: "NOPE")
    monkeypatch.setattr(feishu, "restart_inbound_for",
                        lambda uid: rec("restart", uid) or True)
    toast, text = feishu._setup_switch(1, "ou_1", _CFG)
    assert rec.calls == [("restart", 1)]
    assert text == "🔄 已用当前应用 `cli_old` 重新建立长连接，绑定关系不变。"


def test_slow_action_doctor_dm_summary(monkeypatch):
    """慢动作「配置自检」：摘要行 + 只列 fail/warn 项（ok 项不刷屏）。"""
    sent = []
    monkeypatch.setattr(feishu, "doctor", lambda uid: {
        "items": [
            {"key": "creds", "label": "应用凭据", "state": "ok", "detail": "已配置", "hint": ""},
            {"key": "token", "label": "凭据有效性", "state": "fail", "detail": "code=10003",
             "hint": "检查 App ID / Secret"},
            {"key": "webhook", "label": "默认推送 Webhook", "state": "warn",
             "detail": "未配置", "hint": "去群机器人拿 Webhook"},
        ],
        "summary": {"ok": 1, "fail": 1, "warn": 1, "skip": 0},
    })
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append((oid, text)))
    feishu._setup_slow_action(1, "ou_1", "doctor", _CFG)
    assert sent == [("ou_1", "🩺 配置自检：ok 1 / fail 1 / warn 1 / skip 0\n"
                              "· 凭据有效性：code=10003（检查 App ID / Secret）\n"
                              "· 默认推送 Webhook：未配置（去群机器人拿 Webhook）")]


def test_slow_action_apply_and_publish_texts(monkeypatch):
    """慢动作「补齐配置 / 提交发布」的成功与失败文案。"""
    sent = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append(text))
    monkeypatch.setattr(feishu, "provision_apply",
                        lambda uid: {"ok": True, "steps": [], "error": "", "need_patch_scope": False})
    feishu._setup_slow_action(1, "ou_1", "apply", _CFG)
    assert sent[-1].startswith("🧩 配置补齐成功")
    monkeypatch.setattr(feishu, "provision_apply",
                        lambda uid: {"ok": False, "steps": [], "need_patch_scope": True,
                                     "error": "应用缺少权限"})
    feishu._setup_slow_action(1, "ou_1", "apply", _CFG)
    assert sent[-1] == "❌ 配置补齐失败：应用缺少权限"
    monkeypatch.setattr(feishu, "provision_publish",
                        lambda uid: {"ok": True, "version": "1.0.4", "version_id": "v1",
                                     "need_patch_scope": False, "error": ""})
    feishu._setup_slow_action(1, "ou_1", "publish", _CFG)
    assert sent[-1] == "🚀 已提交发布版本 1.0.4；仍需租户管理员审批后线上生效。"
    monkeypatch.setattr(feishu, "provision_publish",
                        lambda uid: {"ok": False, "version": "", "version_id": "",
                                     "need_patch_scope": False, "error": "发布失败: boom"})
    feishu._setup_slow_action(1, "ou_1", "publish", _CFG)
    assert sent[-1] == "❌ 提交发布失败：发布失败: boom"


# ---------- 发卡入口：主动（接入）/ 自动（换应用） ----------

def test_send_setup_card_returns_human_errors(monkeypatch):
    """发卡失败的两种正常情形（未配凭据 / 未绑定）给中文文案，不抛异常。"""
    feishu._SETUP_NONCES.clear()
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    assert feishu.send_setup_card(1) == (
        False, "未配置应用凭据（App ID / App Secret），先保存配置再发卡片")
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: None)
    assert feishu.send_setup_card(1) == (
        False, "尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复「绑定 <码>」")
    assert feishu._SETUP_NONCES == {}


def test_send_setup_card_ok_registers_nonce_and_uses_connection_cfg(monkeypatch):
    """发卡成功：nonce 登记到该用户；卡片状态行取「配置 app / 线程 app」；凭据用传入的 cfg。"""
    feishu._SETUP_NONCES.clear()
    calls = []
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_new", "app_secret": "s"})
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: dict(_BOUND))
    monkeypatch.setattr(feishu, "inbound_status", lambda uid: {"configured": True, "thread": True})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "cli_old")
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, card, cfg: calls.append((oid, card, cfg)))
    try:
        assert feishu.send_setup_card(1, _CFG) == (True, "")
        oid, card, cfg = calls[0]
        assert oid == "ou_1" and cfg == _CFG
        assert card["header"]["title"]["content"] == "🔁 飞书应用已变更"
        nonce = card["body"]["elements"][2]["behaviors"][0]["value"]["n"]
        assert feishu._SETUP_NONCES[nonce][0] == 1
    finally:
        feishu._SETUP_NONCES.clear()


def test_maybe_send_switch_card_condition_matrix(monkeypatch):
    """自动换应用卡片：四道条件任一不满足 ⇒ 零请求；满足时用**旧凭据**发切换形态卡片。"""
    feishu._SETUP_NONCES.clear()
    calls = []
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, card, cfg: calls.append((oid, card, cfg)))
    # ① 应用没变
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    assert feishu.maybe_send_switch_card(1, _CFG) is False
    # ② 线程没在跑
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_new", "app_secret": "s"})
    monkeypatch.setattr(feishu, "inbound_status", lambda uid: {"configured": True, "thread": False})
    assert feishu.maybe_send_switch_card(1, _CFG) is False
    # ③ 线程绑的已经是新应用（无需切换）
    monkeypatch.setattr(feishu, "inbound_status", lambda uid: {"configured": True, "thread": True})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "cli_new")
    assert feishu.maybe_send_switch_card(1, _CFG) is False
    # ④ 没绑定行
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "cli_old")
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: None)
    assert feishu.maybe_send_switch_card(1, _CFG) is False
    assert calls == []
    # 全满足：用旧 cfg 发、卡片是切换形态
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: dict(_BOUND))
    try:
        assert feishu.maybe_send_switch_card(1, _CFG) is True
        oid, card, cfg = calls[0]
        assert oid == "ou_1" and cfg is _CFG
        assert card["header"]["title"]["content"] == "🔁 飞书应用已变更"
        assert card["body"]["elements"][0]["content"] == \
            "**当前应用**：`cli_new`\n**入站长连接**：运行中 · 绑在 `cli_old`"
    finally:
        feishu._SETUP_NONCES.clear()


def test_maybe_send_switch_card_never_raises(monkeypatch):
    """自动卡片故障不许反噬换凭据主流程：异常被吞、返回 False、stderr 留一行。"""
    monkeypatch.setattr(feishu, "app_config",
                        lambda uid: {"app_id": "cli_new", "app_secret": "s"})
    monkeypatch.setattr(feishu, "inbound_status", lambda uid: {"configured": True, "thread": True})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "cli_old")
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: dict(_BOUND))
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    assert feishu.maybe_send_switch_card(1, _CFG) is False


# ---------- 掉线重连：真 event loop 的合成线程（不连真网关） ----------

def _fake_ws_run(seen_apps):
    """与 `_ws_run` 同构的合成线程：注册 (client, loop) → 阻塞在 loop 里直到被停。"""
    def run(user_id, cfg):
        seen_apps.append(cfg["app_id"])
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        class _Client:
            _auto_reconnect = True

            def __init__(self):
                self.disconnected = False

            async def _disconnect(self):
                self.disconnected = True

        client = _Client()
        feishu._WS_CLIENTS[user_id] = (client, loop)
        try:
            loop.run_until_complete(asyncio.sleep(30))
        except asyncio.CancelledError:
            pass
        finally:
            feishu._WS_CLIENTS.pop(user_id, None)
            try:
                loop.close()
            except Exception:      # noqa: BLE001
                pass
    return run


def _wait_registered(uid, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        ent = feishu._WS_CLIENTS.get(uid)
        if ent is not None:
            return ent
        time.sleep(0.01)
    raise AssertionError("等候长连接线程登记超时")


def test_stop_inbound_for_stops_a_real_loop(monkeypatch):
    """停连接：关 ws（_disconnect 被调）→ 线程退出 → 注册表摘净；幂等再停返回 False。"""
    _clear_ws()
    seen = []
    monkeypatch.setattr(feishu, "_ws_run", _fake_ws_run(seen))
    monkeypatch.setattr(feishu, "user_config", lambda uid: dict(_CFG))
    try:
        assert feishu.start_inbound_for(1) is True
        client, _loop = _wait_registered(1)
        assert feishu.stop_inbound_for(1) is True
        assert not feishu._WS_THREADS[1].is_alive()
        assert client.disconnected is True             # ws 被显式关闭（不是进程退出带走）
        assert client._auto_reconnect is False          # 关掉自动重连才停得住
        assert 1 not in feishu._WS_CLIENTS
        assert feishu.stop_inbound_for(1) is False      # 幂等
    finally:
        _clear_ws()


def test_restart_inbound_for_uses_current_credentials(monkeypatch):
    """重连：停旧 → 用**当前库里的**凭据起新（app_id 序列旧→新），返回 True。"""
    _clear_ws()
    seen = []
    monkeypatch.setattr(feishu, "_ws_run", _fake_ws_run(seen))
    monkeypatch.setattr(feishu, "user_config", lambda uid: dict(_CFG))
    try:
        assert feishu.start_inbound_for(1) is True
        _wait_registered(1)
        assert feishu.inbound_thread_app_id(1) == "cli_old"
        monkeypatch.setattr(feishu, "user_config",
                            lambda uid: {"app_id": "cli_new", "app_secret": "sec_new"})
        assert feishu.restart_inbound_for(1) is True
        _wait_registered(1)
        deadline = time.time() + 3
        while time.time() < deadline and feishu.inbound_thread_app_id(1) != "cli_new":
            time.sleep(0.01)
        assert seen == ["cli_old", "cli_new"]
        assert feishu.inbound_thread_app_id(1) == "cli_new"
        assert feishu.inbound_status(1) == {"configured": True, "thread": True}
    finally:
        feishu.stop_inbound_for(1)
        _clear_ws()


# ---------- 触发面：「接入」指令 + t=fs 分发 ----------

def test_setup_intent_and_help_text():
    """「接入」是文本指令；帮助里可发现（22 行，含新行）。"""
    assert feishu.parse_intent("接入") == {"action": "setup", "groups": []}
    assert feishu.parse_intent("帮助")["action"] == "help"
    lines = feishu.HELP_TEXT.split("\n")
    assert len(lines) == 22
    assert "· 接入 — 飞书接入操作卡片（换应用/重连/绑定码/自检/补齐/发布）" in lines


def test_handle_message_setup_sends_card(monkeypatch):
    """单聊发「接入」：给绑定用户发卡片 + 回执文本（失败时回执带原因）。"""
    replies = []
    sent = []
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1})
    monkeypatch.setattr(feishu, "send_setup_card",
                        lambda uid, cfg: sent.append((uid, cfg)) or (True, ""))
    monkeypatch.setattr(feishu, "rest_reply",
                        lambda mid, text, cfg: replies.append(text))
    cfg = {"app_id": "cli_x", "app_secret": "s"}
    feishu.handle_message_event({
        "message_id": "om_setup_1", "message_type": "text",
        "content": '{"text": "接入"}', "chat_type": "p2p",
        "mentions": [], "sender_open_id": "ou_1"}, cfg)
    assert sent == [(1, cfg)]
    assert replies == ["🛠 已发送「飞书接入操作卡片」，请在卡片上操作。"]
    monkeypatch.setattr(feishu, "send_setup_card", lambda uid, cfg: (False, "boom"))
    feishu.handle_message_event({
        "message_id": "om_setup_2", "message_type": "text",
        "content": '{"text": "接入"}', "chat_type": "p2p",
        "mentions": [], "sender_open_id": "ou_1"}, cfg)
    assert replies[-1] == "卡片发送失败：boom"


def test_card_action_dispatch_routes_t_fs(monkeypatch):
    """`_on_card_action` 把 t=fs 分流到接入卡片处理器（看板 a/mq/p/s/d 路径不动）。"""
    sent = []
    feishu._EVT_SEEN.clear()
    feishu._SETUP_NONCES.clear()
    nonce = feishu._setup_nonce(1)
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1})
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    monkeypatch.setattr(feishu, "restart_inbound_for", lambda uid: True)
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: sent.append(text))
    try:
        data = {"header": {"event_id": "ev-fs-1"},
                "event": {"operator": {"open_id": "ou_1"},
                          "action": {"value": {"t": "fs", "a": "restart", "u": 1, "n": nonce}}}}
        out = feishu._on_card_action(data, _CFG)
        assert out == {"toast": {"type": "success", "content": "已重连"}}
        assert sent == ["🔄 已用当前应用 `cli_old` 重新建立长连接。"]
        # event_id 去重：同一事件重推不再执行第二次
        out2 = feishu._on_card_action(data, _CFG)
        assert out2 is None and len(sent) == 1
    finally:
        feishu._EVT_SEEN.clear()
        feishu._SETUP_NONCES.clear()
