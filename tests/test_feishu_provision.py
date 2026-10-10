# 飞书配置自动化（M5）：扫码建应用 / 应用配置补齐 / 配置自检。
# 全部用例显式打桩 requests / lark_oapi，断言零真实网络调用（仓库铁律）。
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
import feishu  # noqa: E402

db.init_db()  # 测试库建表（幂等；conftest 已把 TOUCHSTONE_DB 指到临时库）


# ---------- Task 1：配置清单常量 + 事件到达打点 + 环境总闸 ----------

def test_manifest_has_unique_tenant_scopes():
    """清单是 doctor / addons / config 三处共用的唯一真源：顺序、类型、去重都要钉住。"""
    names = [s[0] for s in feishu.REQUIRED_SCOPES]
    assert names == ["im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly",
                     "im:message:send_as_bot", "application:app_slash_command:read",
                     "application:app_slash_command:write"]
    assert all(t == "tenant" for _, t, _ in feishu.REQUIRED_SCOPES)
    assert all(desc for _, _, desc in feishu.REQUIRED_SCOPES)
    assert len(set(names)) == len(names)
    assert feishu.REQUIRED_EVENTS == (("im.message.receive_v1", "接收消息"),)
    assert feishu.REQUIRED_CALLBACKS == (("card.action.trigger", "卡片按钮回调"),)


def test_touch_event_records_timestamp():
    """事件到达打点：入站消息/卡片回调都会置位，doctor 据此判事件订阅是否真生效。"""
    feishu._LAST_EVENT_TS.pop(7, None)
    before = time.time()
    feishu._touch_event(7)
    assert before <= feishu._LAST_EVENT_TS[7] <= time.time()


def test_provision_enabled_env_switch(monkeypatch):
    """TS_FEISHU_PROVISION=0 关掉全部写操作（doctor/status 只读不受影响）。"""
    monkeypatch.delenv(feishu.PROVISION_ENV, raising=False)
    assert feishu.provision_enabled() is True
    monkeypatch.setenv(feishu.PROVISION_ENV, "0")
    assert feishu.provision_enabled() is False
    monkeypatch.setenv(feishu.PROVISION_ENV, "1")
    assert feishu.provision_enabled() is True


# ---------- Task 2：凭据快检 + 应用配置补齐 ----------

class _RestSpy:
    """打桩 feishu._rest：记录每次调用，可按 (method, 路径后缀) 指定失败。"""

    def __init__(self, fail=None, data=None):
        self.calls = []
        self.fail = dict(fail or {})
        self.data = dict(data or {})

    def __call__(self, method, path, *, params=None, json_body=None, cfg=None):
        self.calls.append((method, path, json_body))
        for key, exc in self.fail.items():
            if key in path and (key[0] if isinstance(key, tuple) else None) in (None, method):
                raise exc
        # 真实 _rest 的返回即飞书响应体本身（如 /bot/v3/info 的 bot 在**顶层**，
        # 没有 data 包裹——feishu.bot_open_id 同样读顶层，此处照真形状打桩）
        return {"code": 0, **self.data.get(path, {})}


_CREDS = {"app_id": "cli_x", "app_secret": "s"}


def _patch_creds(monkeypatch, cfg=None):
    """凭据来源打桩：默认给一份齐全凭据，传 {} 模拟未配置。"""
    monkeypatch.setattr(feishu, "user_config", lambda uid: dict(_CREDS if cfg is None else cfg))


def test_apply_patches_ability_and_config(monkeypatch):
    """补齐 = 先开机器人能力，再一次 config 把权限/长连接/事件/回调全带上。"""
    spy = _RestSpy()
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch)
    out = feishu.provision_apply(1)
    assert out["ok"] is True
    assert [s["key"] for s in out["steps"]] == ["ability", "config"]
    assert [s["ok"] for s in out["steps"]] == [True, True]
    assert spy.calls[0] == ("PATCH",
                            "/open-apis/application/v7/applications/cli_x/ability",
                            {"bot": {"enable": True}})
    method, path, body = spy.calls[1]
    assert (method, path) == ("PATCH", "/open-apis/application/v7/applications/cli_x/config")
    assert body["scope"] == {"add_scopes": [{"scope_name": n, "token_type": t}
                                            for n, t, _ in feishu.REQUIRED_SCOPES]}
    assert body["event"] == {"subscription_type": "websocket",
                             "add_events": ["im.message.receive_v1"]}
    assert body["callback"] == {"callback_type": "websocket",
                                "add_callbacks": ["card.action.trigger"]}


def test_apply_without_creds_makes_no_request(monkeypatch):
    """无凭据：零请求 + 中文说明（绝不拿空凭据打真实飞书）。"""
    spy = _RestSpy()
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch, {})
    out = feishu.provision_apply(1)
    assert out["ok"] is False and spy.calls == []
    assert "凭据" in out["error"]


def test_apply_refused_when_provision_disabled(monkeypatch):
    """总闸关闭：一个请求都不发。"""
    spy = _RestSpy()
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch)
    monkeypatch.setenv(feishu.PROVISION_ENV, "0")
    out = feishu.provision_apply(1)
    assert out["ok"] is False and spy.calls == []
    assert "已关闭" in out["error"] and feishu.PROVISION_ENV in out["error"]


def test_apply_reports_patch_scope_missing(monkeypatch):
    """缺 application:application:patch（99991640）：给精确引导，不吞成通用错误。"""
    spy = _RestSpy(fail={"ability": feishu.FeishuRestError("no perm", code=99991640)})
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch)
    out = feishu.provision_apply(1)
    assert out["ok"] is False and out["need_patch_scope"] is True
    assert "application:application:patch" in out["error"]
    assert [s["key"] for s in out["steps"]] == ["ability"]


def test_verify_credentials_ok_and_detail(monkeypatch):
    """快检两步：token 可取（_tenant_token）+ 机器人信息可读。"""
    spy = _RestSpy(data={"/open-apis/bot/v3/info":
                         {"bot": {"app_name": "Touchstone", "activate_status": 2}}})
    monkeypatch.setattr(feishu, "_rest", spy)
    monkeypatch.setattr(feishu, "_tenant_token", lambda cfg: "t-1")
    _patch_creds(monkeypatch)
    out = feishu.verify_credentials(1)
    assert out["ok"] is True and "Touchstone" in out["detail"]
    assert spy.calls == [("GET", "/open-apis/bot/v3/info", None)]


def test_verify_credentials_failure_and_no_creds(monkeypatch):
    """凭据错 → ok False + 原因；未配置 → 零请求。"""
    def boom(cfg):
        raise feishu.FeishuRestError("token 获取失败 code=10003", code=10003)
    monkeypatch.setattr(feishu, "_tenant_token", boom)
    _patch_creds(monkeypatch)
    out = feishu.verify_credentials(1)
    assert out["ok"] is False and "10003" in out["detail"]

    spy = _RestSpy()
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch, {})
    out = feishu.verify_credentials(1)
    assert out["ok"] is False and spy.calls == []
    assert "未配置" in out["detail"]


# ---------- Task 3：配置自检 doctor ----------

def _doctor_stubs(monkeypatch, *, cfg=None, token=None, bot=None, ws=True,
                  event_age=None, slash=None, bound=None, send=None):
    """doctor 各依赖的统一打桩：默认「全绿」，按需覆盖单项。"""
    _patch_creds(monkeypatch, cfg)
    monkeypatch.setattr(feishu, "inbound_status",
                        lambda uid: {"configured": cfg is not None, "thread": ws})
    if token is None:
        monkeypatch.setattr(feishu, "_tenant_token", lambda c: "t-1")
    else:
        monkeypatch.setattr(feishu, "_tenant_token", token)
    data = {} if bot is None else {"/open-apis/bot/v3/info": bot}
    spy = _RestSpy(data=data)
    monkeypatch.setattr(feishu, "_rest", spy)
    monkeypatch.setattr(feishu, "slash_status",
                        lambda uid: slash or {"configured": True, "need_scope": False,
                                              "error": "", "remote": [], "extra": [],
                                              "desired": []})
    monkeypatch.setattr(db, "get_feishu_binding_by_user", lambda uid: bound)
    if send is not None:
        monkeypatch.setattr(feishu, "rest_send_text", send)
    feishu._LAST_EVENT_TS.pop(1, None)
    if event_age is not None:
        feishu._LAST_EVENT_TS[1] = time.time() - event_age
    feishu._LAST_PROBE_TS.pop(1, None)
    return spy


def _item(out, key):
    return next(i for i in out["items"] if i["key"] == key)


def test_doctor_bad_creds_no_network(monkeypatch):
    """无凭据：creds fail、其余项 skip，且零网络请求。"""
    spy = _doctor_stubs(monkeypatch, cfg={})
    out = feishu.doctor(1)
    assert [i["key"] for i in out["items"]] == [
        "creds", "token", "bot", "inbound_ws", "inbound_event",
        "slash_scope", "send_scope", "webhook"]
    assert _item(out, "creds")["state"] == "fail"
    assert _item(out, "token")["state"] == "skip"
    assert _item(out, "inbound_event")["state"] == "skip"   # 无凭据时不把「没收到事件」当告警
    assert spy.calls == []
    assert out["summary"]["fail"] == 1


def test_doctor_token_failure_skips_bot(monkeypatch):
    """凭据错（token 抛错）：token fail 且 hint 给查凭据方向，bot 项 skip。"""
    _doctor_stubs(monkeypatch, token=lambda c: (_ for _ in ()).throw(
        feishu.FeishuRestError("token 获取失败 code=10003", code=10003)))
    out = feishu.doctor(1)
    assert _item(out, "token")["state"] == "fail"
    assert "10003" in _item(out, "token")["detail"]
    assert _item(out, "bot")["state"] == "skip"


def test_doctor_all_green_with_fresh_event(monkeypatch):
    """全绿基线：凭据齐 + 连接在跑 + 最近收到过事件 + 斜杠权限在 + webhook 已配。"""
    spy = _doctor_stubs(monkeypatch,
                        cfg={"app_id": "cli_x", "app_secret": "s",
                             "default_webhook": "https://open.feishu.cn/x"},
                        bot={"bot": {"app_name": "Touchstone", "activate_status": 2}},
                        event_age=10)
    out = feishu.doctor(1)
    assert out["summary"]["fail"] == 0
    for key in ("creds", "token", "bot", "inbound_ws", "inbound_event", "slash_scope"):
        assert _item(out, key)["state"] == "ok", key
    assert "Touchstone" in _item(out, "bot")["detail"]
    assert spy.calls == [("GET", "/open-apis/bot/v3/info", None)]


def test_doctor_stale_event_warns(monkeypatch):
    """事件订阅：窗口内没收到过 → warn，并告诉用户「给机器人发一条消息」验证。"""
    _doctor_stubs(monkeypatch, bot={"bot": {"app_name": "T", "activate_status": 2}},
                  event_age=feishu.EVENT_FRESH_S + 60)
    out = feishu.doctor(1)
    assert _item(out, "inbound_event")["state"] == "warn"
    assert "发一条消息" in _item(out, "inbound_event")["hint"]


def test_doctor_slash_scope_fail_hint(monkeypatch):
    """缺斜杠权限：fail + hint 点名 app_slash_command（精确引导，不吞）。"""
    _doctor_stubs(monkeypatch, bot={"bot": {"app_name": "T", "activate_status": 2}},
                  slash={"configured": True, "need_scope": True,
                         "error": "缺权限", "remote": [], "extra": [], "desired": []})
    out = feishu.doctor(1)
    assert _item(out, "slash_scope")["state"] == "fail"
    assert "app_slash_command" in _item(out, "slash_scope")["hint"]


def test_doctor_send_probe_rate_limited(monkeypatch):
    """发消息探测：未请求则 skip；请求时发一条，60s 内重复请求不再发。"""
    sent = []
    _doctor_stubs(monkeypatch, bot={"bot": {"app_name": "T", "activate_status": 2}},
                  bound={"open_id": "ou_1", "user_id": 1},
                  send=lambda oid, text, cfg: sent.append((oid, text)))
    assert _item(feishu.doctor(1), "send_scope")["state"] == "skip"
    out = feishu.doctor(1, send_probe=True)
    assert _item(out, "send_scope")["state"] == "ok" and len(sent) == 1
    assert "自检" in sent[0][1]
    feishu.doctor(1, send_probe=True)
    assert len(sent) == 1


# ---------- Task 4：扫码建应用状态机 ----------

class _RegStub:
    """打桩 feishu._register_app_impl：可挂起（模拟等待用户扫码）、可失败。"""

    def __init__(self, url="https://accounts.feishu.cn/qr/abc", result=None,
                 exc=None, block=None):
        self.calls = []
        self.url = url
        self.result = {"client_id": "cli_new", "client_secret": "sec-new"} \
            if result is None else result
        self.exc = exc
        self.block = block

    def __call__(self, on_qr_code, on_status_change, cancel_event, addons):
        self.calls.append({"addons": addons, "cancel": cancel_event})
        on_qr_code(self.url)
        if self.block is not None:
            self.block.wait(3)
        if self.exc is not None:
            raise self.exc
        if cancel_event.is_set():
            raise RuntimeError("用户取消")
        return dict(self.result)


def _wait_state(user_id, state, timeout=3.0):
    """等后台线程把状态推进到目标态（测试期轮询，超时即断言失败）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if feishu.provision_status(user_id)["state"] == state:
            return feishu.provision_status(user_id)
        time.sleep(0.02)
    raise AssertionError(f"等待状态 {state} 超时：{feishu.provision_status(user_id)}")


def _reset_provision(uid=1):
    feishu._PROVISION.pop(uid, None)
    feishu._TOKEN_CACHE.clear()


def test_provision_start_success_writes_cfg_and_applies(monkeypatch):
    """成功路径：URL 落状态 → 凭据入库 → 起长连接 → 自动补齐配置（步骤如实回传）。"""
    _reset_provision()
    stub = _RegStub()
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    _patch_creds(monkeypatch, {})
    started = []
    monkeypatch.setattr(feishu, "start_inbound_for", lambda uid: started.append(uid) or True)
    monkeypatch.setattr(feishu, "provision_apply",
                        lambda uid: {"ok": True, "need_patch_scope": False, "error": "",
                                     "steps": [{"key": "ability", "label": "开启机器人能力",
                                                "ok": True, "detail": "已开启"}]})
    out = feishu.provision_start(1)
    assert out["ok"] is True and out["state"] == "waiting"
    st = _wait_state(1, "success")
    assert st["app_id"] == "cli_new" and st["url"] == stub.url
    assert [s["key"] for s in st["steps"]] == ["ability"]
    assert db.get_feishu_user_cfg(1)["app_id"] == "cli_new"
    assert db.get_feishu_user_cfg(1)["app_secret"] == "sec-new"
    assert started == [1]
    # addons：创建时就把清单带上（preset=False 走最小模板 + 我们声明的全部配置）
    addons = stub.calls[0]["addons"]
    assert addons["preset"] is False
    assert addons["scopes"]["tenant"] == [n for n, _, _ in feishu.REQUIRED_SCOPES]
    assert addons["events"]["items"]["tenant"] == ["im.message.receive_v1"]
    assert addons["callbacks"]["items"] == ["card.action.trigger"]


def test_provision_start_creates_new_flow_only_once(monkeypatch):
    """重复点击「扫码创建」不重复建流程（同一用户同时只跑一条）。"""
    _reset_provision()
    block = __import__("threading").Event()
    stub = _RegStub(block=block)
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    _patch_creds(monkeypatch, {})
    monkeypatch.setattr(feishu, "start_inbound_for", lambda uid: True)
    monkeypatch.setattr(feishu, "provision_apply",
                        lambda uid: {"ok": True, "steps": [], "error": "", "need_patch_scope": False})
    first = feishu.provision_start(1)
    second = feishu.provision_start(1)
    assert first["ok"] and second["ok"] and len(stub.calls) == 1
    block.set()
    _wait_state(1, "success")


def test_provision_start_rejects_existing_app_without_force(monkeypatch):
    """已有应用：默认拒绝（防误覆盖），force=True 才重开流程。"""
    _reset_provision()
    stub = _RegStub()
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    _patch_creds(monkeypatch, {"app_id": "cli_old", "app_secret": "old"})
    monkeypatch.setattr(feishu, "start_inbound_for", lambda uid: True)
    monkeypatch.setattr(feishu, "provision_apply",
                        lambda uid: {"ok": True, "steps": [], "error": "", "need_patch_scope": False})
    out = feishu.provision_start(1)
    assert out["ok"] is False and "cli_old" in out["error"] and stub.calls == []
    assert feishu.provision_start(1, force=True)["ok"] is True
    _wait_state(1, "success")


def test_provision_cancel_passes_cancel_event(monkeypatch):
    """取消：状态转 cancelled，且 SDK 侧收到 cancel_event（阻塞中的流程即刻退出）。"""
    _reset_provision()
    block = __import__("threading").Event()
    stub = _RegStub(block=block)
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    _patch_creds(monkeypatch, {})
    feishu.provision_start(1)
    out = feishu.provision_cancel(1)
    assert out["ok"] is True and out["state"] == "cancelled"
    assert stub.calls[0]["cancel"].is_set() is True
    block.set()
    time.sleep(0.1)
    assert feishu.provision_status(1)["state"] == "cancelled"


def test_provision_failure_records_error(monkeypatch):
    """SDK 抛错：状态 failed + 中文原因（不把异常丢给前端 500）。"""
    _reset_provision()
    stub = _RegStub(exc=RuntimeError("access_denied 用户拒绝"))
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    _patch_creds(monkeypatch, {})
    feishu.provision_start(1)
    st = _wait_state(1, "failed")
    assert "access_denied" in st["error"]


def test_provision_start_refused_when_disabled_or_unsupported(monkeypatch):
    """总闸关闭 / SDK 版本过低：都不启动流程，给中文说明。"""
    _reset_provision()
    stub = _RegStub()
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    _patch_creds(monkeypatch, {})
    monkeypatch.setenv(feishu.PROVISION_ENV, "0")
    out = feishu.provision_start(1)
    assert out["ok"] is False and "已关闭" in out["error"] and stub.calls == []
    monkeypatch.delenv(feishu.PROVISION_ENV)
    monkeypatch.setattr(feishu, "_lark_min_ok", lambda: False)
    assert feishu.provision_supported() is False
    out = feishu.provision_start(1)
    assert out["ok"] is False and "1.5.5" in out["error"] and stub.calls == []


def test_provision_supported_reads_metadata_without_importing_sdk():
    """能力判定只读包元数据：import lark_oapi 会拉起 ws 子模块的事件循环，不能碰。"""
    assert feishu._REGISTER_MIN_VERSION == (1, 5, 5)
    assert feishu.provision_supported() is True      # 本机 lark-oapi 1.7.3 ≥ 下限


# ---------- Task 5：提交发布 ----------

def test_publish_bumps_version_from_remote_list(monkeypatch):
    """版本号 = 远端最大版本补丁位 +1（1.0.3 / 1.0.10 → 1.0.11，不是字符串序）。"""
    spy = _RestSpy(data={
        feishu._APP_VERSIONS_API % "cli_x": {"data": {"items": [
            {"version": "1.0.3"}, {"version": "1.0.10"}, {"version": "坏版本"}]}},
        feishu._APP_PUBLISH_API % "cli_x": {"data": {"version_id": "v-1", "version": "1.0.11"}},
    })
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch)
    out = feishu.provision_publish(1)
    assert out["ok"] is True and out["version"] == "1.0.11" and out["version_id"] == "v-1"
    assert spy.calls[0] == ("GET", "/open-apis/application/v6/applications/cli_x/app_versions", None)
    method, path, body = spy.calls[1]
    assert (method, path) == ("POST", "/open-apis/application/v7/applications/cli_x/publish")
    assert body["version"] == "1.0.11"
    assert body["pc_default_ability"] == "bot" and body["mobile_default_ability"] == "bot"
    assert body["remark"] and body["changelog"]


def test_publish_defaults_and_explicit_version(monkeypatch):
    """远端没有版本 → 1.0.0；显式版本原样提交（不查版本列表）。"""
    spy = _RestSpy(data={feishu._APP_PUBLISH_API % "cli_x": {"data": {"version_id": "v-2"}}})
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch)
    assert feishu.provision_publish(1)["version"] == "1.0.0"
    spy.calls.clear()
    out = feishu.provision_publish(1, version="2.0.0")
    assert out["version"] == "2.0.0"
    assert len(spy.calls) == 1 and spy.calls[0][0] == "POST"


def test_publish_scope_and_gates(monkeypatch):
    """缺 patch 权限 → need_patch_scope；总闸关闭/无凭据 → 零请求。"""
    spy = _RestSpy(fail={"publish": feishu.FeishuRestError("no perm", code=99991640)})
    monkeypatch.setattr(feishu, "_rest", spy)
    _patch_creds(monkeypatch)
    out = feishu.provision_publish(1, version="1.0.0")
    assert out["ok"] is False and out["need_patch_scope"] is True
    assert "application:application:patch" in out["error"]

    spy.calls.clear()
    monkeypatch.setenv(feishu.PROVISION_ENV, "0")
    out = feishu.provision_publish(1, version="1.0.0")
    assert out["ok"] is False and spy.calls == [] and "已关闭" in out["error"]

    monkeypatch.delenv(feishu.PROVISION_ENV)
    _patch_creds(monkeypatch, {})
    out = feishu.provision_publish(1, version="1.0.0")
    assert out["ok"] is False and spy.calls == [] and "凭据" in out["error"]


# ---------- Task 6：保存配置（含凭据即时快检）----------

def test_save_user_config_verifies_when_creds_complete(monkeypatch):
    """凭据齐全：写库 + 起长连接 + 立刻快检（verify 随响应回给前端）。
    打桩 db 读写而不是 user_config——快检前的「凭据是否齐全」要读到刚写下的值。"""
    store = {}
    monkeypatch.setattr(db, "get_feishu_user_cfg", lambda uid: dict(store.get(uid, {})))
    monkeypatch.setattr(db, "set_feishu_user_cfg",
                        lambda uid, cfg: store.update({uid: dict(cfg)}))
    monkeypatch.setattr(feishu, "verify_credentials",
                        lambda uid: {"ok": True, "detail": "凭据可用"})
    monkeypatch.setattr(feishu, "start_inbound_for", lambda uid: True)
    out = feishu.save_user_config(1, {"app_id": "cli_a", "app_secret": "sec",
                                      "enabled": True, "base_url": " http://x "})
    assert out["verify"] == {"ok": True, "detail": "凭据可用"}
    assert out["inbound_started"] is True
    assert store[1]["app_id"] == "cli_a" and store[1]["base_url"] == "http://x"
    assert store[1]["enabled"] == 1


def test_save_user_config_skips_verify_without_creds(monkeypatch):
    """凭据不全：verify=null 且不调用快检（零请求）。"""
    monkeypatch.setattr(db, "get_feishu_user_cfg",
                        lambda uid: {"app_id": "", "app_secret": ""})
    monkeypatch.setattr(db, "set_feishu_user_cfg", lambda uid, cfg: None)
    called = []
    monkeypatch.setattr(feishu, "verify_credentials", lambda uid: called.append(uid))
    monkeypatch.setattr(feishu, "start_inbound_for", lambda uid: False)
    out = feishu.save_user_config(1, {"enabled": False})
    assert out == {"inbound_started": False, "verify": None} and called == []


# ---------- Task 7：CLI 子命令 ----------

def _argv(monkeypatch, *args):
    monkeypatch.setattr(sys, "argv", ["feishu.py", *args])


def test_cli_doctor_prints_items_and_exit_code(monkeypatch, capsys):
    """doctor：逐项打印 + 有 fail 即退出码 1（脚本可用退出码判成败）。"""
    _argv(monkeypatch, "doctor", "--user", "1")
    monkeypatch.setattr(feishu, "doctor", lambda uid, send_probe=False: {
        "items": [{"key": "creds", "label": "应用凭据", "state": "ok",
                   "detail": "已配置", "hint": ""},
                  {"key": "token", "label": "凭据有效性", "state": "fail",
                   "detail": "token 获取失败 code=10003", "hint": "核对 App ID/Secret"}],
        "summary": {"ok": 1, "fail": 1, "warn": 0, "skip": 0}})
    assert feishu._cli() == 1
    out = capsys.readouterr().out
    assert "凭据有效性" in out and "10003" in out and "核对 App ID/Secret" in out


def test_cli_resolves_single_user_and_reports_ambiguity(monkeypatch, capsys):
    """--user 缺省：库中恰一个用户时自动选中；多个用户时报错列出候选。"""
    seen = []
    monkeypatch.setattr(feishu, "doctor", lambda uid, send_probe=False:
                        seen.append(uid) or {"items": [], "summary": {}})
    monkeypatch.setattr(db, "list_users", lambda: [{"id": 5, "username": "solo"}])
    _argv(monkeypatch, "doctor")
    assert feishu._cli() == 0 and seen == [5]

    monkeypatch.setattr(db, "list_users",
                        lambda: [{"id": 1, "username": "a"}, {"id": 2, "username": "b"}])
    _argv(monkeypatch, "doctor")
    assert feishu._cli() == 1
    assert "--user" in capsys.readouterr().err


def test_cli_provision_prints_link_and_waits(monkeypatch, capsys):
    """provision：打印确认链接；等状态推进到成功即退出码 0（--no-wait 立即返回）。"""
    monkeypatch.setattr(feishu, "provision_start",
                        lambda uid, force=False: {"ok": True, "state": "waiting",
                                                  "url": "https://accounts.feishu.cn/qr/x",
                                                  "error": ""})
    states = [{"state": "waiting"}, {"state": "success", "app_id": "cli_new", "error": "",
                                     "steps": [{"key": "ability", "label": "开启机器人能力",
                                                "ok": True, "detail": "已开启"}]}]
    monkeypatch.setattr(feishu, "provision_status",
                        lambda uid: states.pop(0) if len(states) > 1 else states[0])
    monkeypatch.setattr(time, "sleep", lambda s: None)
    _argv(monkeypatch, "provision", "--user", "1")
    assert feishu._cli() == 0
    out = capsys.readouterr().out
    assert "https://accounts.feishu.cn/qr/x" in out and "cli_new" in out


# ---------- 终局复阅修复轮（Critical/Important）----------

def test_provision_start_is_atomic_under_concurrency(monkeypatch):
    """并发点两下「扫码创建」只许建一条流程：**「读状态→写状态」这一段必须串行**。
    复阅 P1：无锁时两线程都读到空状态 ⇒ 两条 Device Flow 同时开、各写各的凭据。
    判据取临界区里的可观测点（`app_config` 在状态读之后、状态写之前）——B 线程在
    A 持锁期间不得进入它，而不是靠 sleep 赌时序。"""
    import threading
    _reset_provision()
    block = threading.Event()
    stub = _RegStub(block=block)
    monkeypatch.setattr(feishu, "_register_app_impl", stub)
    entered = threading.Event()
    release = threading.Event()
    seen = []

    def gated_app_config(uid):
        seen.append(uid)
        if len(seen) == 1:
            entered.set()
            release.wait(3)        # A 停在临界区中间（状态已读、尚未写）
        return None                # 无凭据 ⇒ 不触发「已配置应用」拒绝分支

    monkeypatch.setattr(feishu, "app_config", gated_app_config)
    monkeypatch.setattr(feishu, "start_inbound_for", lambda uid: True)
    monkeypatch.setattr(feishu, "provision_apply",
                        lambda uid: {"ok": True, "steps": [], "error": "",
                                     "need_patch_scope": False})
    outs = []

    def go():
        outs.append(feishu.provision_start(1))

    a = threading.Thread(target=go)
    a.start()
    assert entered.wait(3), "A 未进入临界区"
    b = threading.Thread(target=go)
    b.start()
    time.sleep(0.3)                # 无锁时 B 早已进临界区；有锁则被挡在锁上
    assert len(seen) == 1, "B 线程在 A 持锁期间进了临界区（状态检查未串行化）"
    release.set()
    a.join(3)
    b.join(3)
    time.sleep(0.3)                # 给「第二个 worker」充分时间露出（无锁时会立刻调 SDK）
    assert len(stub.calls) == 1, "并发下重复建了流程"
    assert [o["ok"] for o in outs] == [True, True]
    block.set()
    _wait_state(1, "success")


def test_doctor_slash_probe_exception_degrades(monkeypatch):
    """斜杠项探测抛任何异常都降级为该项 fail —— doctor 承诺绝不外抛（复阅 P6：
    飞书返回形态意外时 `slash_status` 会漏出 AttributeError，HTTP 层 500）。"""
    _doctor_stubs(monkeypatch, bot={"bot": {"app_name": "T", "activate_status": 2}})
    monkeypatch.setattr(feishu, "slash_status",
                        lambda uid: (_ for _ in ()).throw(
                            AttributeError("'list' object has no attribute 'get'")))
    out = feishu.doctor(1)                      # 不得外抛
    assert _item(out, "slash_scope")["state"] == "fail"
    assert "list" in _item(out, "slash_scope")["detail"]


def test_provision_status_reports_configured_app(monkeypatch):
    """无在跑流程时，status 的 app_id 必须回落**用户配置里已接入的应用**：
    否则前端按 `force: !!st.app_id` 判二次确认 ⇒ 已有应用的用户永远发不出 force，
    「扫码换应用」死锁（复阅 Critical；站点重启后连扫码建过应用的用户也会掉进去）。"""
    _reset_provision()
    _patch_creds(monkeypatch, {"app_id": "cli_old", "app_secret": "s"})
    st = feishu.provision_status(1)
    assert st["state"] == "idle" and st["app_id"] == "cli_old"
