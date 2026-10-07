# 飞书 M4 快捷指令（Slash Command）：注册/同步/清除（打桩 _rest，不触真实飞书）
# + 斜杠别名意图解析（与中文指令落到同一套 action/groups）
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db
import feishu

db.init_db()  # 测试库建表（幂等；conftest 已把 TOUCHSTONE_DB 指到临时库）

_CFG = {"app_id": "cli_slash", "app_secret": "s"}


class _FakeSlashApi:
    """打桩 feishu._rest：内存态指令表 + 调用记录。

    fail = {(method, command): FeishuRestError} 指定某次调用失败；POST 撞名（40000000）
    场景会把该指令先塞进远端表再抛错，模拟「差集竞态/用户手工已建」的真实状态。
    """

    def __init__(self, items=None, fail=None):
        self.items = [dict(i) for i in (items or [])]
        self.calls = []
        self.fail = dict(fail or {})

    def _desc_payload(self, desc, icon=None):
        """说明载荷归一（字符串 → {default_value,i18n}）；icon 只按 item 级存
        （线上实测：icon 放 description 内会被飞书忽略，见 feishu._slash_description）。"""
        d = desc if isinstance(desc, dict) else {"default_value": desc, "i18n": {"zh_cn": desc}}
        return d

    def __call__(self, method, path, *, params=None, json_body=None, cfg=None):
        self.calls.append((method, path, json_body))
        if path == feishu.SLASH_API:
            if method == "GET":
                return {"code": 0, "data": {"items": [dict(i) for i in self.items]}}
            if method == "POST":
                name = json_body["command"]
                entry = {"command_id": "", "command": name,
                         "description": self._desc_payload(json_body["description"]),
                         "icon": json_body.get("icon")}
                if ("POST", name) in self.fail:
                    # 撞名：远端其实已有该指令（先落表再抛错），驱动 sync 走「重取转更新」
                    entry["command_id"] = str(9000 + len(self.items))
                    self.items.append(entry)
                    raise self.fail[("POST", name)]
                cid = str(1000 + len(self.items))
                entry["command_id"] = cid
                self.items.append(entry)
                return {"code": 0, "data": {"command_id": cid}}
        if path.startswith(feishu.SLASH_API + "/"):
            cid = path.rsplit("/", 1)[1]
            hit = next((i for i in self.items if str(i["command_id"]) == cid), None)
            if hit is not None and (method, hit["command"]) in self.fail:
                raise self.fail[(method, hit["command"])]
            if method == "PATCH":
                hit["description"] = self._desc_payload(json_body["description"])
                hit["icon"] = json_body.get("icon")       # item 级图标：真机可回读
                return {"code": 0, "data": {}}
            if method == "DELETE":
                self.items = [i for i in self.items if str(i["command_id"]) != cid]
                return {"code": 0, "data": {}}
        raise AssertionError(f"未预期的飞书调用 {method} {path}")

    def methods(self):
        return [c[0] for c in self.calls]


def _use(monkeypatch, api, user_id=1):
    """装假 _rest 与假凭据（app_config 走用户配置，测试里直接兜底成 _CFG）。"""
    monkeypatch.setattr(feishu, "_rest", api)
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    return api


# ---------- 同步：新增 / 更新 / 已最新 ----------

def test_sync_creates_all_then_idempotent(monkeypatch):
    api = _use(monkeypatch, _FakeSlashApi())
    first = feishu.sync_slash_commands(1)
    assert first["ok"] is True
    assert first["created"] == list(feishu._SLASH_NAMES)   # 顺序即面板顺序
    assert first["updated"] == [] and first["kept"] == []
    assert api.methods().count("POST") == len(feishu.SLASH_COMMANDS)
    # 重复同步：全部 kept，不再发写请求（幂等，可反复点）
    api.calls.clear()
    second = feishu.sync_slash_commands(1)
    assert second == {"ok": True, "created": [], "updated": [], "kept": list(feishu._SLASH_NAMES),
                      "extra": [], "failed": [], "need_scope": False, "error": ""}
    assert "POST" not in api.methods() and "PATCH" not in api.methods()


def test_sync_payload_shape_and_update(monkeypatch):
    api = _use(monkeypatch, _FakeSlashApi(items=[
        {"command_id": "77", "command": "status",
         "description": {"default_value": "旧说明", "i18n": {"zh_cn": "旧说明"}}},
    ]))
    out = feishu.sync_slash_commands(1)
    assert out["updated"] == ["status"] and out["ok"] is True
    # 创建载荷：command 名 + 中文说明 + 图标（icon 按官方创建示例放在 description 内）
    post = next(c for c in api.calls if c[0] == "POST")
    body = post[2]
    assert body["command"] in feishu._SLASH_NAMES
    assert body["description"]["i18n"]["zh_cn"] == body["description"]["default_value"]
    assert body["icon"]["icon_key"]                                # 图标走 item 级（实测生效）
    assert "icon" not in body["description"]                       # 放 description 内会被忽略
    # 更新载荷：PATCH 到 command_id，且带上 TS 清单里的说明
    patch = next(c for c in api.calls if c[0] == "PATCH")
    assert patch[1] == f"{feishu.SLASH_API}/77"
    assert patch[2]["description"]["default_value"] == dict(
        (c, d) for c, d, _ in feishu.SLASH_COMMANDS)["status"]


def test_sync_never_touches_other_commands(monkeypatch):
    """用户应用里的其他指令：只报告不删除（TS 不管别人的指令）。"""
    api = _use(monkeypatch, _FakeSlashApi(items=[
        {"command_id": "1", "command": "other_tool",
         "description": {"default_value": "别人的", "i18n": {"zh_cn": "别人的"}}},
    ]))
    out = feishu.sync_slash_commands(1)
    assert out["extra"] == ["other_tool"]
    assert "DELETE" not in api.methods()
    assert any(i["command"] == "other_tool" for i in api.items)


def test_sync_create_conflict_falls_back_to_update(monkeypatch):
    """创建撞名（40000000）：重取列表按 command_id 转更新，重复点也收敛而非报错。"""
    err = feishu.FeishuRestError("REST code=40000000 command already exists", code=40000000)
    api = _use(monkeypatch, _FakeSlashApi(fail={("POST", "help"): err}))
    out = feishu.sync_slash_commands(1)
    assert out["ok"] is True
    assert "help" in out["updated"] and "help" not in out["failed"]
    assert "PATCH" in api.methods()


def test_sync_permission_error_gives_actionable_hint(monkeypatch):
    """缺权限（99991640）：不抛异常，转「加 scope + 重新发版」的中文引导。"""
    err = feishu.FeishuRestError("REST code=99991640 lacks permission", code=99991640)
    _use(monkeypatch, _GetFailApi(err))
    out = feishu.sync_slash_commands(1)
    assert out["ok"] is False
    assert "application:app_slash_command" in out["error"]
    status = feishu.slash_status(1)
    assert status["error"] == out["error"] and status["remote"] == []
    assert len(status["desired"]) == len(feishu.SLASH_COMMANDS)


class _GetFailApi(_FakeSlashApi):
    """GET 列表即失败（权限/网络）的最小桩。"""

    def __init__(self, err):
        super().__init__()
        self.err = err

    def __call__(self, method, path, *, params=None, json_body=None, cfg=None):
        self.calls.append((method, path, json_body))
        raise self.err


# ---------- 清除：只删 TS 自己的 ----------

def test_clear_only_removes_ts_commands(monkeypatch):
    items = [{"command_id": "1", "command": "help",
              "description": {"default_value": "查看可用指令", "i18n": {"zh_cn": "查看可用指令"},
                              "icon": {"icon_key": "skill_outlined"}}},
             {"command_id": "2", "command": "other_tool",
              "description": {"default_value": "别人的", "i18n": {"zh_cn": "别人的"}}}]
    api = _use(monkeypatch, _FakeSlashApi(items=items))
    out = feishu.clear_slash_commands(1)
    assert out["ok"] is True and out["deleted"] == ["help"]
    assert out["extra"] == ["other_tool"]
    assert [i["command"] for i in api.items] == ["other_tool"]     # 别人的指令原样保留


# ---------- 凭据缺失：不触网、给引导 ----------

@pytest.mark.parametrize("fn", ["sync_slash_commands", "clear_slash_commands"])
def test_no_credentials(monkeypatch, fn):
    api = _use(monkeypatch, _FakeSlashApi())
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    out = getattr(feishu, fn)(1)
    assert out["ok"] is False and "应用凭据" in out["error"]
    assert api.calls == []                                        # 没凭据不发请求
    status = feishu.slash_status(1)
    assert status["configured"] is False and "应用凭据" in status["error"]


# ---------- 斜杠别名意图：与中文指令同一套 action/groups ----------

def test_slash_alias_intents_match_chinese():
    pairs = [("帮助", "/help"), ("解绑", "/unbind")]
    for zh, slash in pairs:
        assert feishu.parse_intent(slash) == feishu.parse_intent(zh)
    assert feishu.parse_intent("/bind AB12CD") == {"action": "bind", "groups": ["AB12CD"]}
    assert feishu.parse_intent("/project demo_proj")["groups"] == ["demo_proj"]
    assert feishu.parse_intent("/status")["groups"] == [None]
    assert feishu.parse_intent("/status cpp_try")["groups"] == ["cpp_try"]
    assert feishu.parse_intent("状态 cpp_try")["groups"] == ["cpp_try"]
    assert feishu.parse_intent("/cards 42")["groups"] == ["42"]
    assert feishu.parse_intent("/card 42")["groups"] == ["42"]     # 单复数都认
    assert feishu.parse_intent("/approve 42")["groups"] == ["42"]
    assert feishu.parse_intent("/reject 42 登录还是失败")["groups"] == ["42", "登录还是失败"]
    assert feishu.parse_intent("/answer 7 1,3")["groups"] == ["7", "1,3"]
    assert feishu.parse_intent("/agree 42")["groups"] == ["42", None]
    assert feishu.parse_intent("/agree 42 session")["groups"] == ["42", "session"]
    assert feishu.parse_intent("/deny 42")["groups"] == ["42"]
    assert feishu.parse_intent("/unknown") is None


def test_registered_commands_cover_all_alias_rules():
    """注册的斜杠指令名必须与意图规则里的 /别名 一致（漏一个就是死入口）。"""
    names = set(feishu._SLASH_NAMES)
    for alias in ("/help", "/bind", "/unbind", "/project", "/status",
                  "/cards", "/approve", "/reject", "/answer", "/agree", "/deny"):
        assert alias.lstrip("/") in names, f"{alias} 未注册"
    assert len(names) == len(feishu.SLASH_COMMANDS)               # 无重名
    for _, desc, icon in feishu.SLASH_COMMANDS:
        assert desc and icon


# ---------- 缺权限：need_scope 标记 + 飞书权限引导卡片 + 卡片上确认后重试 ----------

def test_missing_scope_sets_need_scope_flag(monkeypatch):
    """99991640 除了给中文引导，还要打 need_scope 标记——页面/后端据此发权限卡片。"""
    err = feishu.FeishuRestError("REST code=99991640 lacks permission", code=99991640)
    _use(monkeypatch, _GetFailApi(err))
    assert feishu.sync_slash_commands(1)["need_scope"] is True
    assert feishu.clear_slash_commands(1)["need_scope"] is True
    assert feishu.slash_status(1)["need_scope"] is True


def test_perm_card_shape():
    """权限卡片：说明缺哪个 scope、给开发者后台链接与菜单路径、按钮带身份与动作（t=sc）。"""
    card = feishu.slash_perm_card("cli_abc", 7)
    assert card["schema"] == "2.0"
    assert "应用指令" in card["header"]["title"]["content"]
    md = card["body"]["elements"][0]["content"]
    assert "application:app_slash_command:read" in md
    assert "application:app_slash_command:write" in md
    # 只给应用详情页根 URL（深链路由官方文档未给，不猜）；菜单路径写清楚
    assert "https://open.feishu.cn/app/cli_abc" in md
    assert "/auth" not in md
    assert "权限管理" in md and "版本管理与发布" in md
    btn = card["body"]["elements"][1]
    assert btn["tag"] == "button"
    assert btn["behaviors"][0]["type"] == "callback"
    assert btn["behaviors"][0]["value"] == {"t": "sc", "a": "retry", "u": 7}


def test_send_perm_card_requires_binding_and_creds(monkeypatch):
    sent = []
    monkeypatch.setattr(feishu, "rest_send_card",
                        lambda oid, card, cfg: sent.append((oid, card)))
    monkeypatch.setattr(feishu, "app_config", lambda uid: dict(_CFG))
    monkeypatch.setattr(db, "get_feishu_binding_by_user", lambda uid: None)
    ok, err = feishu.send_slash_perm_card(1)
    assert ok is False and "绑定" in err and sent == []             # 未绑定：不发、给引导
    monkeypatch.setattr(db, "get_feishu_binding_by_user",
                        lambda uid: {"open_id": "ou_me", "user_id": uid})
    ok, err = feishu.send_slash_perm_card(1)
    assert ok is True and err == "" and sent[0][0] == "ou_me"
    monkeypatch.setattr(feishu, "app_config", lambda uid: None)
    ok, err = feishu.send_slash_perm_card(1)
    assert ok is False and "应用凭据" in err


def _card_action(open_id, value, event_id="ev-sc-1"):
    return {"header": {"event_id": event_id},
            "event": {"operator": {"open_id": open_id},
                      "action": {"tag": "button", "value": value}}}


def test_perm_card_button_retries_sync(monkeypatch):
    """卡片上「我已开通，重试注册」：重跑同步、DM 回报、toast 成功。"""
    api = _use(monkeypatch, _FakeSlashApi())
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1,
                                     "default_project_id": 0})
    dms = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: dms.append(text))
    ret = feishu._on_card_action(_card_action("ou_me", {"t": "sc", "a": "retry", "u": 1}),
                                 dict(_CFG))
    assert ret["toast"]["type"] == "success"
    assert len(api.items) == len(feishu.SLASH_COMMANDS)            # 11 条全建
    assert dms and "注册完成" in dms[0] and "新增 11" in dms[0]


def test_perm_card_button_rejects_other_user(monkeypatch):
    """防串号：卡片 value 里的 u 与点击者绑定的 user_id 不一致 → 拒绝、不发写请求。"""
    api = _use(monkeypatch, _FakeSlashApi())
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1,
                                     "default_project_id": 0})
    dms = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: dms.append(text))
    ret = feishu._on_card_action(_card_action("ou_other", {"t": "sc", "a": "retry", "u": 999},
                                              event_id="ev-sc-2"), dict(_CFG))
    assert ret["toast"]["type"] == "error"
    assert api.calls == [] and dms == []


def test_perm_card_button_unbound_guides_binding(monkeypatch):
    api = _use(monkeypatch, _FakeSlashApi())
    monkeypatch.setattr(db, "get_feishu_binding_by_open", lambda oid: None)
    dms = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: dms.append(text))
    ret = feishu._on_card_action(_card_action("ou_none", {"t": "sc", "a": "retry", "u": 1},
                                              event_id="ev-sc-3"), dict(_CFG))
    assert ret["toast"]["type"] == "error"
    assert dms and "绑定" in dms[0] and api.calls == []


def test_perm_card_button_still_blocked_reports_next_step(monkeypatch):
    """点确认后权限仍未生效：DM 里要说明「确认已发版、稍等再点」，不能只说失败。"""
    err = feishu.FeishuRestError("REST code=99991640 lacks permission", code=99991640)
    _use(monkeypatch, _GetFailApi(err))
    monkeypatch.setattr(db, "get_feishu_binding_by_open",
                        lambda oid: {"open_id": oid, "user_id": 1,
                                     "default_project_id": 0})
    dms = []
    monkeypatch.setattr(feishu, "_dm_text", lambda oid, text, cfg: dms.append(text))
    ret = feishu._on_card_action(_card_action("ou_me", {"t": "sc", "a": "retry", "u": 1},
                                              event_id="ev-sc-4"), dict(_CFG))
    assert ret["toast"]["type"] == "error"
    assert "创建版本发布" in dms[0] and "再点一次" in dms[0]


def test_sync_self_heals_default_icons_then_idempotent(monkeypatch):
    """线上实证的图标语义：描述一致但图标是默认值（历史上 icon 放 description 内被忽略）
    ⇒ 第一次同步补更新（自愈），第二次同步零写请求（幂等）。"""
    remote = [{"command_id": str(i), "command": c,
               "description": {"default_value": d, "i18n": {"zh_cn": d}},
               "icon": {"icon_key": "skill_outlined"}}          # 飞书回读的默认图标
              for i, (c, d, _) in enumerate(feishu.SLASH_COMMANDS)]
    api = _use(monkeypatch, _FakeSlashApi(items=remote))
    first = feishu.sync_slash_commands(1)
    # 只有 help 的目标图标就是默认值 ⇒ 它是 kept，其余 10 条补图标
    assert first["ok"] is True and first["kept"] == ["help"]
    assert first["updated"] == [c for c in feishu._SLASH_NAMES if c != "help"]
    api.calls.clear()
    second = feishu.sync_slash_commands(1)
    assert second["kept"] == list(feishu._SLASH_NAMES) and second["updated"] == []
    assert "PATCH" not in api.methods() and "POST" not in api.methods()


def test_update_payload_carries_icon_at_item_level(monkeypatch):
    """PATCH 的 icon 走 item 级（真机取证：item 级生效、description 内被忽略）。"""
    api = _use(monkeypatch, _FakeSlashApi(items=[
        {"command_id": "55", "command": "status",
         "description": {"default_value": "旧说明", "i18n": {"zh_cn": "旧说明"}}}]))
    feishu.sync_slash_commands(1)
    patch = next(c for c in api.calls if c[0] == "PATCH")
    assert patch[1] == f"{feishu.SLASH_API}/55"
    assert patch[2]["icon"]["icon_key"] == dict(
        (c, i) for c, _, i in feishu.SLASH_COMMANDS)["status"]
    assert "icon" not in patch[2]["description"]
