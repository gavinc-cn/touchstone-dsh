#!/usr/bin/env python3
"""Task 12d：站点设置面 doctor/provision/verify 数据文案按**请求语言**本地化。

判据（与 `backend/test/feishu-i18n-t12d.test.mjs` 镜像，双端共用同一组 golden）：
  ① **zh 逐字节保全**：无语言信号（= 老客户端/对拍器）时，doctor 八项、provision
     status/start/apply/publish/cancel、verify 的 payload 与改动前 HEAD（`789bf1c`）
     **逐字节相同**（golden 由改动前源码跑同一组确定性桩抓取，见报告）。
  ② **英文面（实际 payload，不数词条）**：同一组 ctx + 请求语言 `en` 后，label/detail/
     hint/error 为英文；`key`/`state`/`ok`/`version`/`app_id`/`supported`/`enabled`/
     `age_s` 等机器值逐点不变；en payload 无中文（飞书上游错误/机器人名等白名单见报告）。
  ③ **语言源 = 请求语言**：`X-TS-Lang` → `?lang=` → 用户偏好 → `zh`；`TS_I18N=0`
     ⇒ zh 且**零偏好读库**（计数桩 + 正对照）。
  ④ **双端同 ctx en payload sha256 相同**（`EN_GOLDEN`，Node 孪生断言同一组常量）。

全程离线：REST/DB 全部打桩或走隔离实例，绝不发真实飞书请求。
"""
import hashlib
import json
import os
import re
import sys
import types

import pytest

import db
import feishu
import i18n
import server
from serverfixture import Api, isolated_server  # noqa: F401

HAN = re.compile(r"[\u4e00-\u9fff]")
# 英文译文里允许保留的中文：飞书**指令词**（协议 token，R23 注册 schema 仍是中文）
PROTOCOL_TOKENS = ("接入", "绑定")

UID = 995001

# 改动前 HEAD（789bf1c）同 ctx 的 UTF-8 sha256（抓取脚本见报告；勿手改）
ZH_GOLDEN = {
    "doctor_no_creds": "06095f775a6168ebe69d580ac29496c9e319ae3140939ade653e254ee9fe33e5",
    "doctor_full": "0787252be88a7ebc7240f3fd5496d61e73309d0384215d1e642b1318d52a1643",
    "verify_ok": "d95566d95558c5618ca2cbfa667a9c163f6931e7a683225b5ae7749b30eedef1",
    "verify_warn": "5f33906ec30a2791ab0006b3e4d87bb4ca6c6f021335278ed040bcca9fc3fd1d",
    "verify_no_creds": "8d7caa9eef9a9bca0312a8f63148efc39489e711f5bd75f254d37a1265da9422",
    "apply_ok": "107517c13cebab6e60cb0b6a6db07e1602aad11e0f2f4e828e597c36d0139183",
    "apply_no_creds": "b4056b49d1a5618733477078c1b960ab44616ff58699369b7f33b336590f4b75",
    "apply_disabled": "01e8b96b2b6b67f90ff8990d250ce337985dda11f94eb45d9cb2e89c531af14c",
    "publish_ok": "85dc7373c41964a540490bb9aa9e2ccfc6f8f52d94f8a455cf8934d731fa9013",
    "publish_no_creds": "a6d387e6ea3fa1b0215d299c4b12acaf3d9fc4ccbc561180c6eddb571860a06b",
    "start_disabled": "636223b9be06c27e6c5156be09dc3d8e3406558af5c5dac6c2b54be33a012621",
    "start_unsupported": "26cb53c81ca9d36d554250b96303b5f730ecc2ebd734abfe14da70d839a08107",
    "status_idle": "f1e47375ba701b1051f83bdeeeea6179ff388478f7bafe5d8dbd249e5eb9ba57",
    "status_ttl": "783676d36f62d57ef8797bbef5db4b5d907e9154684a23344d301bee0008d1ee",
    "status_steps_ok": "180e4e1b8c4bd67559388efefc0d23f04a910f742bd5e7a503315205324a4325",
    "status_worker_error": "db60a0a243acc840a94988727c4b637e6cb72a1645d8b011d1a2026b4cf9b496",
    "status_partial_error": "cd9ffcfbb541f7c4115ee169d8fef33ec9d8da2e4d8cb1bdc31f5e68aac618e5",
    "status_no_creds_error": "87fba74bd6a29ef8c92b91ce8f222a957b20a78bb54d51dee8363e19b0d613ff",
    "cancel_none": "364394ecb9c5ec48f5155add5a7fed6bcbee66f7a08892b2f95f0faa1e335f6a",
}
# 同一组 ctx 的英文 payload sha256（Node 孪生测试断言同一组常量 ⇒ 两端逐字节相同）
EN_GOLDEN = {
    "doctor_no_creds": "81e8e3243e97306808761795baac8b2fb2e1b2e2d3c48016fd1aad32d91b02ba",
    "doctor_full": "5fcf3aa61e2403931fea116f304f0d99ca1a1f3194462cf2d139f38895ba5878",
    "verify_ok": "181c278a1a540eb6070c19e2d252de5501b5508f27c164d50da884006c83996a",
    "apply_ok": "64379a1b806b7a30a6a8bad746484eb4d70137718c8c59dda8c9a473b75656ad",
    "publish_ok": "85dc7373c41964a540490bb9aa9e2ccfc6f8f52d94f8a455cf8934d731fa9013",
    "status_idle": "f1e47375ba701b1051f83bdeeeea6179ff388478f7bafe5d8dbd249e5eb9ba57",
    "status_steps_ok": "9d8a7e584d662e6d4793096f9fe9202df37c9355bbff92676096887250c46427",
    "status_ttl": "2a5159fc66a12b866a063496f0b6ecbb39e1079372024bfaa28901d763cb2e6d",
    "cancel_none": "c5fa0de5c20032017ad5fb882914dfeb70f3a2961dffe03cf175ba08e7a194f5",
}

FROZEN_TIME = 1000.0


def sha_obj(obj):
    return hashlib.sha256(
        json.dumps(obj, ensure_ascii=False).encode("utf-8")).hexdigest()


def sha_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def assert_no_chinese(value, extra=()):
    """英文 payload 里除协议指令词/白名单外不得出现中文。"""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    cleaned = text
    for token in sorted(set(PROTOCOL_TOKENS) | set(extra), key=len, reverse=True):
        cleaned = cleaned.replace(token, "")
    assert not HAN.search(cleaned), f"英文面仍含中文: {text!r}"


def _clear_state():
    feishu._PROVISION.clear()
    feishu._LAST_EVENT_TS.clear()
    feishu._LAST_PROBE_TS.clear()


def _frozen_time():
    return types.SimpleNamespace(time=lambda: FROZEN_TIME)


def _stub_env(monkeypatch, *, cfg=None, thread=False, thread_app="",
              bot_name="Bot", activate=2, slash=None, binding=None,
              webhook=""):
    """doctor/verify 共用的确定性桩（零真实网络）。"""
    full = {"app_id": "cli_x", "app_secret": "s", "default_webhook": webhook}
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: dict(cfg if cfg is not None else full))
    monkeypatch.setattr(feishu, "inbound_status",
                        lambda uid: {"configured": bool(cfg), "thread": thread})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: thread_app)
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user",
                        lambda uid: binding)
    monkeypatch.setattr(feishu, "time", _frozen_time())

    class Rest:
        def __call__(self, method, path, *, params=None, json_body=None, cfg=None):
            return {"code": 0, "bot": {"app_name": bot_name,
                                       "activate_status": activate}}

    monkeypatch.setattr(feishu, "rest", None, raising=False)
    monkeypatch.setattr(feishu, "_rest", Rest())
    monkeypatch.setattr(feishu, "_tenant_token", lambda c: "tok")
    return slash


def _slash(monkeypatch, need_scope=False, error="", lang_out=None):
    calls = []

    def stub(uid, lang="zh"):
        calls.append(lang)
        out_error = error
        if out_error:
            out_error = i18n.t("api", out_error, lang)
        if lang_out is not None:
            lang_out.append(lang)
        return {"configured": True, "need_scope": need_scope,
                "error": out_error, "desired": [], "remote": [], "extra": []}

    monkeypatch.setattr(feishu, "slash_status", stub)
    return calls


# ---------------------------------------------------------------------------
# 确定性场景（与 Node 测试同名同 ctx）
# ---------------------------------------------------------------------------

def _doctor_no_creds(monkeypatch):
    _clear_state()
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    monkeypatch.setattr(feishu, "inbound_status",
                        lambda uid: {"configured": False, "thread": False})
    monkeypatch.setattr(feishu, "inbound_thread_app_id", lambda uid: "")
    monkeypatch.setattr(feishu.db, "get_feishu_binding_by_user", lambda uid: None)
    return feishu.doctor(UID)


def _doctor_full(monkeypatch, data_lang=None):
    _clear_state()
    feishu._LAST_EVENT_TS[UID] = FROZEN_TIME - 10
    try:
        _stub_env(monkeypatch, thread=True, thread_app="cli_x",
                  binding={"open_id": "ou_x", "user_id": UID},
                  webhook="https://example.com/hook")
        _slash(monkeypatch)
        if data_lang is None:
            return feishu.doctor(UID)
        return feishu.doctor(UID, data_lang=data_lang)
    finally:
        _clear_state()


def _doctor_warn(monkeypatch, data_lang=None):
    _clear_state()
    feishu._LAST_EVENT_TS[UID] = FROZEN_TIME - 900
    sent = []
    try:
        _stub_env(monkeypatch, thread=True, thread_app="cli_old", activate=1,
                  binding={"open_id": "ou_x", "user_id": UID})
        _slash(monkeypatch, need_scope=True, error=feishu._SLASH_PERM_HINT)
        monkeypatch.setattr(feishu, "rest_send_text",
                            lambda oid, text, cfg: sent.append(text))
        monkeypatch.setattr(feishu, "user_lang", lambda uid: "zh")
        if data_lang is None:
            out = feishu.doctor(UID, send_probe=True)
        else:
            out = feishu.doctor(UID, send_probe=True, data_lang=data_lang)
        return out, sent
    finally:
        _clear_state()


def _verify_ok(monkeypatch, lang=None):
    _stub_env(monkeypatch)
    return (feishu.verify_credentials(UID) if lang is None
            else feishu.verify_credentials(UID, lang))


def _verify_warn(monkeypatch, lang=None):
    _stub_env(monkeypatch, activate=1)
    return (feishu.verify_credentials(UID) if lang is None
            else feishu.verify_credentials(UID, lang))


def _verify_no_creds(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    return (feishu.verify_credentials(UID) if lang is None
            else feishu.verify_credentials(UID, lang))


def _verify_rest_fail(monkeypatch, lang=None):
    def boom(c):
        raise feishu.FeishuRestError("bad creds (10014)", code=10014)
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_tenant_token", boom)
    return (feishu.verify_credentials(UID) if lang is None
            else feishu.verify_credentials(UID, lang))


def _verify_exc(monkeypatch, lang=None):
    def boom(c):
        raise RuntimeError("boom")
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_tenant_token", boom)
    return (feishu.verify_credentials(UID) if lang is None
            else feishu.verify_credentials(UID, lang))


def _apply_ok(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    class Rest:
        def __call__(self, method, path, *, params=None, json_body=None, cfg=None):
            return {"code": 0}
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_rest", Rest())
    return (feishu.provision_apply(UID) if lang is None
            else feishu.provision_apply(UID, lang))


def _apply_no_creds(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    return (feishu.provision_apply(UID) if lang is None
            else feishu.provision_apply(UID, lang))


def _apply_disabled(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: False)
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    return (feishu.provision_apply(UID) if lang is None
            else feishu.provision_apply(UID, lang))


def _apply_ability_fail(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    def rest(method, path, *, params=None, json_body=None, cfg=None):
        if "ability" in path:
            raise feishu.FeishuRestError("no perm", code=99991640)
        return {"code": 0}
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_rest", rest)
    return (feishu.provision_apply(UID) if lang is None
            else feishu.provision_apply(UID, lang))


def _apply_config_fail(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    def rest(method, path, *, params=None, json_body=None, cfg=None):
        if "config" in path:
            raise feishu.FeishuRestError("config boom", code=1)
        return {"code": 0}
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_rest", rest)
    return (feishu.provision_apply(UID) if lang is None
            else feishu.provision_apply(UID, lang))


def _publish_ok(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    class Rest:
        def __call__(self, method, path, *, params=None, json_body=None, cfg=None):
            if method == "GET":
                return {"code": 0, "data": {"items": [{"version": "1.0.3"}]}}
            return {"code": 0, "data": {"version": "1.0.4", "version_id": "v1"}}
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_rest", Rest())
    return (feishu.provision_publish(UID) if lang is None
            else feishu.provision_publish(UID, lang=lang))


def _publish_no_creds(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    return (feishu.provision_publish(UID) if lang is None
            else feishu.provision_publish(UID, lang=lang))


def _publish_rest_fail(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    def rest(method, path, *, params=None, json_body=None, cfg=None):
        raise feishu.FeishuRestError("publish boom", code=1)
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_rest", rest)
    return (feishu.provision_publish(UID) if lang is None
            else feishu.provision_publish(UID, lang=lang))


def _publish_exc(monkeypatch, lang=None):
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    def rest(method, path, *, params=None, json_body=None, cfg=None):
        if method == "GET":
            raise RuntimeError("boom")
        return {"code": 0}
    monkeypatch.setattr(feishu, "user_config",
                        lambda uid: {"app_id": "cli_x", "app_secret": "s"})
    monkeypatch.setattr(feishu, "_rest", rest)
    return (feishu.provision_publish(UID) if lang is None
            else feishu.provision_publish(UID, lang=lang))


def _start_errors(monkeypatch, lang=None):
    out = {}
    creds = {"app_id": "cli_x", "app_secret": "s"}
    monkeypatch.setattr(feishu, "user_config", lambda uid: dict(creds))
    monkeypatch.setattr(feishu, "provision_enabled", lambda: False)
    monkeypatch.setattr(feishu, "provision_supported", lambda: True)
    out["disabled"] = (feishu.provision_start(UID) if lang is None
                        else feishu.provision_start(UID, lang=lang))
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    monkeypatch.setattr(feishu, "provision_supported", lambda: False)
    out["unsupported"] = (feishu.provision_start(UID) if lang is None
                             else feishu.provision_start(UID, lang=lang))
    monkeypatch.setattr(feishu, "provision_supported", lambda: True)
    out["configured"] = (feishu.provision_start(UID) if lang is None
                           else feishu.provision_start(UID, lang=lang))
    return out


def _status_cases(monkeypatch, lang=None):
    def status():
        return (feishu.provision_status(UID) if lang is None
                else feishu.provision_status(UID, lang))
    _clear_state()
    monkeypatch.setattr(feishu, "time", _frozen_time())
    monkeypatch.setattr(feishu, "provision_supported", lambda: True)
    monkeypatch.setattr(feishu, "provision_enabled", lambda: True)
    monkeypatch.setattr(feishu, "user_config", lambda uid: {})
    out = {"idle": status()}
    feishu._PROVISION[UID] = {"state": "waiting", "url": "", "error": "",
                              "app_id": "", "steps": [], "started_at": 0}
    out["ttl"] = status()
    feishu._PROVISION[UID] = {
        "state": "success", "url": "", "error": "", "app_id": "cli_x",
        "steps": [
            {"key": "ability", "label": "开启机器人能力", "ok": True,
             "detail": "已开启"},
            {"key": "config", "label": "权限 / 长连接订阅 / 事件 / 回调",
             "ok": True, "detail": "已写入（需发布新版本后生效）"},
        ], "started_at": 900}
    out["steps_ok"] = status()
    feishu._PROVISION[UID] = {
        "state": "failed", "url": "", "error": "扫码创建失败: boom",
        "app_id": "", "steps": [
            {"key": "ability", "label": "开启机器人能力", "ok": False,
             "detail": "no perm"}], "started_at": 900}
    out["worker_error"] = status()
    feishu._PROVISION[UID] = {
        "state": "success", "url": "", "app_id": "cli_x", "steps": [],
        "error": "应用已创建，但配置补齐未完成："
                 + feishu._PATCH_SCOPE_HINT,
        "started_at": 900}
    out["partial_error"] = status()
    feishu._PROVISION[UID] = {
        "state": "failed", "url": "", "app_id": "", "steps": [],
        "error": "扫码流程未返回应用凭据（可能超时或未确认），可重新发起",
        "started_at": 900}
    out["no_creds_error"] = status()
    _clear_state()
    return out


def _cancel_none(monkeypatch, lang=None):
    _clear_state()
    return (feishu.provision_cancel(UID) if lang is None
            else feishu.provision_cancel(UID, lang))


# ---------------------------------------------------------------------------
# ① zh 逐字节保全（无语言信号 = 存量行为）
# ---------------------------------------------------------------------------

def test_zh_payloads_byte_identical_to_head(monkeypatch):
    _clear_state()
    assert sha_obj(_doctor_no_creds(monkeypatch)) == ZH_GOLDEN["doctor_no_creds"]
    assert sha_obj(_doctor_full(monkeypatch)) == ZH_GOLDEN["doctor_full"]
    assert sha_obj(_verify_ok(monkeypatch)) == ZH_GOLDEN["verify_ok"]
    assert sha_obj(_verify_warn(monkeypatch)) == ZH_GOLDEN["verify_warn"]
    assert sha_obj(_verify_no_creds(monkeypatch)) == ZH_GOLDEN["verify_no_creds"]
    assert sha_obj(_apply_ok(monkeypatch)) == ZH_GOLDEN["apply_ok"]
    assert sha_obj(_apply_no_creds(monkeypatch)) == ZH_GOLDEN["apply_no_creds"]
    assert sha_obj(_apply_disabled(monkeypatch)) == ZH_GOLDEN["apply_disabled"]
    assert sha_obj(_publish_ok(monkeypatch)) == ZH_GOLDEN["publish_ok"]
    assert sha_obj(_publish_no_creds(monkeypatch)) == ZH_GOLDEN["publish_no_creds"]
    starts = _start_errors(monkeypatch)
    assert sha_obj(starts["disabled"]) == ZH_GOLDEN["start_disabled"]
    assert sha_obj(starts["unsupported"]) == ZH_GOLDEN["start_unsupported"]
    status = _status_cases(monkeypatch)
    for key in ("idle", "ttl", "steps_ok", "worker_error", "partial_error",
                "no_creds_error"):
        assert sha_obj(status[key]) == ZH_GOLDEN[f"status_{key}"], key
    assert sha_obj(_cancel_none(monkeypatch)) == ZH_GOLDEN["cancel_none"]


# ---------------------------------------------------------------------------
# ② 英文面：doctor 八项（label/detail/hint）+ 机器值不变
# ---------------------------------------------------------------------------

def test_en_doctor_full_english_and_machine_values(monkeypatch):
    zh = _doctor_full(monkeypatch)
    en = _doctor_full(monkeypatch, data_lang="en")
    assert [i["key"] for i in en["items"]] == [i["key"] for i in zh["items"]]
    assert [i["state"] for i in en["items"]] == [i["state"] for i in zh["items"]]
    assert en["summary"] == zh["summary"]
    assert [(i["label"], i["detail"], i["hint"]) for i in en["items"]] == [
        ("App credentials (App ID / App Secret)", "Configured", ""),
        ("Credential validity (tenant_access_token)",
         "Token obtained successfully", ""),
        ("Bot ability and activation status", "Bot (activate_status=2)", ""),
        ("Inbound long connection", "Connection thread is running", ""),
        ("Event subscription (a real message received)",
         "Event received 10 seconds ago", ""),
        ("Slash command permissions", "Permissions available", ""),
        ("Send-message permission (optional probe)",
         "Not probed (tick “Send a test message” and rerun the self-check)", ""),
        ("Default push webhook", "Configured", ""),
    ]
    assert_no_chinese(en)
    assert sha_obj(en) == EN_GOLDEN["doctor_full"]


def test_en_doctor_warn_hints_and_recipient_probe(monkeypatch):
    zh, _ = _doctor_warn(monkeypatch)
    en, sent = _doctor_warn(monkeypatch, data_lang="en")
    assert [i["key"] for i in en["items"]] == [i["key"] for i in zh["items"]]
    assert [i["state"] for i in en["items"]] == [i["state"] for i in zh["items"]]
    assert en["items"][2]["hint"] == (
        "App capabilities → add “Bot”, then publish it in version management "
        "and release for it to take effect")
    assert en["items"][3]["detail"] == (
        "The connection thread is still bound to cli_old "
        "(configuration changed to cli_x)")
    assert en["items"][4]["detail"] == "The last event was more than 5 minutes ago"
    assert en["items"][5]["detail"] == (
        "The app lacks the “app slash command” permission: in the Feishu "
        "developer console → Permission management, add "
        "application:app_slash_command:read and write, then create and publish "
        "a new version and retry")
    assert en["items"][7]["detail"] == (
        "Not configured (does not affect bot conversations; only "
        "blocking-event pushes)")
    assert_no_chinese(en)
    # R22：数据语言=请求语言，探针 DM 仍是**收件人**语言（此处桩成 zh）
    assert sent == ["🔍 Touchstone 配置自检：收到这条消息说明"
                    "「发消息」权限已开通。"]


# ---------------------------------------------------------------------------
# ③ 英文面：verify / apply / publish / start / cancel / status
# ---------------------------------------------------------------------------

def test_en_verify_variants(monkeypatch):
    assert _verify_ok(monkeypatch, "en") == {
        "ok": True, "detail": "Credentials are valid: bot Bot (Enabled)"}
    assert _verify_warn(monkeypatch, "en") == {
        "ok": True,
        "detail": "Credentials are valid: bot Bot (activation status=1; "
                  "the app may not be published or enabled)"}
    assert _verify_no_creds(monkeypatch, "en") == {
        "ok": False,
        "detail": "App credentials are not configured (App ID / App Secret)"}
    # 飞书上游错误原文透传（白名单：机器/诊断值，不翻译）
    assert _verify_rest_fail(monkeypatch, "en") == {
        "ok": False, "detail": "bad creds (10014)"}
    assert _verify_exc(monkeypatch, "en") == {
        "ok": False, "detail": "Probe failed: RuntimeError('boom')"}


def test_en_apply_variants(monkeypatch):
    assert _apply_ok(monkeypatch, "en")["steps"] == [
        {"key": "ability", "label": "Enable bot ability", "ok": True,
         "detail": "Enabled"},
        {"key": "config",
         "label": "Permissions / long-connection subscription / events / callbacks",
         "ok": True, "detail": "Written (publish a new version for it to take effect)"},
    ]
    assert _apply_no_creds(monkeypatch, "en")["error"] == (
        "App credentials are not configured (App ID / App Secret); "
        "save the credentials first")
    assert _apply_disabled(monkeypatch, "en")["error"] == (
        "Configuration automation is disabled (TS_FEISHU_PROVISION=0)")
    out = _apply_ability_fail(monkeypatch, "en")
    assert out["need_patch_scope"] is True
    assert out["error"].startswith(
        "The app lacks the “application:application:patch” permission:")
    assert out["steps"][0]["detail"] == "no perm"    # 上游原文透传
    assert_no_chinese(out)
    cfg_fail = _apply_config_fail(monkeypatch, "en")
    assert cfg_fail["error"] == "config boom"
    assert cfg_fail["steps"][-1]["detail"] == "config boom"


def test_en_publish_variants(monkeypatch):
    ok = _publish_ok(monkeypatch, "en")
    assert ok["version"] == "1.0.4" and ok["version_id"] == "v1"
    assert _publish_no_creds(monkeypatch, "en")["error"] == (
        "App credentials are not configured (App ID / App Secret); "
        "save the credentials first")
    assert _publish_rest_fail(monkeypatch, "en")["error"] == "publish boom"
    assert _publish_exc(monkeypatch, "en")["error"] == (
        "Publish failed: RuntimeError('boom')")


def test_en_start_and_cancel(monkeypatch):
    out = _start_errors(monkeypatch, "en")
    assert out["disabled"]["error"] == (
        "Configuration automation is disabled (TS_FEISHU_PROVISION=0)")
    assert out["unsupported"]["error"] == (
        "The local lark-oapi version is too old (register_app requires "
        "≥1.5.5); upgrade the dependency and retry")
    assert out["configured"]["error"] == (
        "App cli_x is already configured; confirm before replacing it and retry")
    assert _cancel_none(monkeypatch, "en")["error"] == (
        "No provisioning flow is in progress")


def test_en_status_steps_and_errors(monkeypatch):
    zh = _status_cases(monkeypatch)
    en = _status_cases(monkeypatch, "en")
    for key in zh:
        assert [k for k in en[key]] == [k for k in zh[key]], key
        for machine in ("supported", "enabled", "state", "app_id", "age_s"):
            assert en[key][machine] == zh[key][machine], (key, machine)
    assert en["ttl"]["error"] == (
        "The confirmation link has expired (it is valid for 10 minutes); "
        "start again")
    assert en["steps_ok"]["steps"] == [
        {"key": "ability", "label": "Enable bot ability", "ok": True,
         "detail": "Enabled"},
        {"key": "config",
         "label": "Permissions / long-connection subscription / events / callbacks",
         "ok": True, "detail": "Written (publish a new version for it to take effect)"},
    ]
    assert en["worker_error"]["error"] == "QR-code app creation failed: boom"
    assert en["worker_error"]["steps"][0]["detail"] == "no perm"
    assert en["partial_error"]["error"] == (
        "The app was created, but the configuration setup did not complete: "
        "The app lacks the “application:application:patch” permission: in the "
        "developer console → Permission management, add the permission and "
        "create a version release; or set the permission to auto-approve for "
        "the app and try again")
    assert en["no_creds_error"]["error"] == (
        "The QR-code flow did not return app credentials (it may have timed "
        "out or not been confirmed); start again")
    assert_no_chinese(en)
    assert sha_obj(en["idle"]) == EN_GOLDEN["status_idle"]
    assert sha_obj(en["ttl"]) == EN_GOLDEN["status_ttl"]
    assert sha_obj(en["steps_ok"]) == EN_GOLDEN["status_steps_ok"]


def test_ts_i18n_off_forces_zh_even_when_en_requested(monkeypatch):
    """`TS_I18N=0` 时即使函数收到 lang='en' 也恒 zh（回滚开关在 `t` 内部短路）。"""
    monkeypatch.setenv("TS_I18N", "0")
    assert sha_obj(_doctor_full(monkeypatch, "en")) == ZH_GOLDEN["doctor_full"]
    assert sha_obj(_verify_ok(monkeypatch, "en")) == ZH_GOLDEN["verify_ok"]
    assert sha_obj(_apply_ok(monkeypatch, "en")) == ZH_GOLDEN["apply_ok"]
    assert sha_obj(_status_cases(monkeypatch, "en")["ttl"]) == ZH_GOLDEN["status_ttl"]


def test_en_verify_apply_publish_cross_side_sha(monkeypatch):
    assert sha_obj(_verify_ok(monkeypatch, "en")) == EN_GOLDEN["verify_ok"]
    assert sha_obj(_apply_ok(monkeypatch, "en")) == EN_GOLDEN["apply_ok"]
    assert sha_obj(_publish_ok(monkeypatch, "en")) == EN_GOLDEN["publish_ok"]
    assert sha_obj(_cancel_none(monkeypatch, "en")) == EN_GOLDEN["cancel_none"]
    assert sha_obj(_doctor_no_creds_with_lang(monkeypatch, "en")) == \
        EN_GOLDEN["doctor_no_creds"]


def _doctor_no_creds_with_lang(monkeypatch, lang):
    out = _doctor_no_creds(monkeypatch)
    # doctor 的数据语言参数是 data_lang（lang 保留给 T12b 的探针 DM 语言）
    return feishu.doctor(UID, data_lang=lang)


# ---------------------------------------------------------------------------
# ④ 白名单：动态/上游值原样透传（只允许「值本身」是中文）
# ---------------------------------------------------------------------------

def test_en_dynamic_upstream_values_pass_through(monkeypatch):
    _stub_env(monkeypatch, bot_name="测试机器人")
    out = feishu.verify_credentials(UID, "en")
    assert out == {"ok": True,
                   "detail": "Credentials are valid: bot 测试机器人 (Enabled)"}
    assert_no_chinese(out, extra=("测试机器人",))
    upstream = _verify_rest_fail(monkeypatch, "en")
    assert upstream["detail"] == "bad creds (10014)"


# ---------------------------------------------------------------------------
# ⑤ HTTP 级：路由接线 / 无头字节 / en payload / 头与 query 优先级
# ---------------------------------------------------------------------------

def _lang_client(srv, headers=None):
    api = Api(srv.base, headers=headers)
    code, d = api.json("/api/auth/login", "POST",
                       {"username": "admin", "password": srv.admin_pw})
    assert code == 200, f"登录失败: {code} {d}"
    return api


def test_http_no_head_bytes_unchanged(isolated_server):
    srv = isolated_server
    code, text = srv.admin("/api/me/feishu/doctor", "POST", {})
    assert code == 200
    assert sha_text(text) == ZH_GOLDEN["doctor_no_creds"]
    code, text = srv.admin("/api/me/feishu/provision")
    assert code == 200
    assert sha_text(text) == ZH_GOLDEN["status_idle"]
    code, text = srv.admin("/api/me/feishu/provision", "POST", {"action": "cancel"})
    assert code == 200
    assert sha_text(text) == ZH_GOLDEN["cancel_none"]
    code, text = srv.admin("/api/me/feishu/provision", "POST", {"action": "apply"})
    assert code == 200
    assert sha_text(text) == ZH_GOLDEN["apply_no_creds"]
    code, text = srv.admin("/api/me/feishu/provision", "POST", {"action": "publish"})
    assert code == 200
    assert sha_text(text) == ZH_GOLDEN["publish_no_creds"]


def test_http_zh_header_bytes_unchanged(isolated_server):
    """显式 `X-TS-Lang: zh` 与无头同字节（兼容红线覆盖「zh 请求」这一档）。"""
    srv = isolated_server
    zh = _lang_client(srv, {"X-TS-Lang": "zh"})
    code, text = zh("/api/me/feishu/doctor", "POST", {})
    assert code == 200
    assert sha_text(text) == ZH_GOLDEN["doctor_no_creds"]
    code, text = zh("/api/me/feishu/provision")
    assert code == 200 and sha_text(text) == ZH_GOLDEN["status_idle"]
    code, text = zh("/api/me/feishu/provision", "POST", {"action": "cancel"})
    assert code == 200 and sha_text(text) == ZH_GOLDEN["cancel_none"]


def test_http_en_doctor_and_provision(isolated_server):
    srv = isolated_server
    en = _lang_client(srv, {"X-TS-Lang": "en"})
    code, text = en("/api/me/feishu/doctor", "POST", {})
    assert code == 200
    payload = json.loads(text)
    assert [i["key"] for i in payload["items"]] == [
        "creds", "token", "bot", "inbound_ws", "inbound_event",
        "slash_scope", "send_scope", "webhook"]
    assert payload["items"][0]["label"] == "App credentials (App ID / App Secret)"
    assert payload["items"][0]["detail"] == "Not configured"
    assert_no_chinese(payload)
    assert sha_text(text) == EN_GOLDEN["doctor_no_creds"]
    code, text = en("/api/me/feishu/provision")
    assert code == 200 and sha_text(text) == EN_GOLDEN["status_idle"]
    code, text = en("/api/me/feishu/provision", "POST", {"action": "cancel"})
    assert code == 200
    assert json.loads(text)["error"] == "No provisioning flow is in progress"
    code, text = en("/api/me/feishu/provision", "POST", {"action": "apply"})
    assert code == 200
    assert json.loads(text)["error"].startswith(
        "App credentials are not configured (App ID / App Secret); save")
    code, text = en("/api/me/feishu/provision", "POST", {"action": "publish"})
    assert code == 200
    assert json.loads(text)["error"].startswith(
        "App credentials are not configured (App ID / App Secret); save")


def test_http_lang_query_and_header_priority(isolated_server):
    srv = isolated_server
    plain = _lang_client(srv)
    code, text = plain("/api/me/feishu/provision?lang=en", "POST",
                       {"action": "cancel"})
    assert code == 200
    assert json.loads(text)["error"] == "No provisioning flow is in progress"
    # 头优先于 query（T10/T11 既有解析顺序）
    mixed = _lang_client(srv, {"X-TS-Lang": "zh"})
    code, text = mixed("/api/me/feishu/provision?lang=en", "POST",
                       {"action": "cancel"})
    assert code == 200
    assert json.loads(text)["error"] == "当前没有进行中的扫码流程"


# ---------------------------------------------------------------------------
# ⑥ TS_I18N=0：zh + 零偏好读库（计数桩 + 正对照）；handler 真的传请求语言
# ---------------------------------------------------------------------------

class _FakeHandler(server.Handler):
    """只提供语言解析与响应捕获（不跑 BaseHTTPRequestHandler.__init__）。"""

    def __init__(self, headers=None, path="/api/me/feishu/doctor", user=None):
        self.headers = dict(headers or {})
        self.path = path
        self._request_user = user
        self.responses = []

    def _current_user(self):
        return self._request_user

    def _respond(self, code, body, content_type, extra_headers=None):
        self.responses.append((code, body, content_type))


def _handler_user():
    return {"id": UID, "username": "u", "role": "admin"}


def test_ts_i18n_off_forces_zh_and_zero_pref_reads(monkeypatch):
    calls = []
    monkeypatch.setattr(feishu, "doctor",
                        lambda uid, send_probe=False, data_lang=None, lang=None:
                        calls.append(data_lang) or {"items": [],
                                                    "summary": {"ok": 0, "fail": 0,
                                                                "warn": 0, "skip": 0}})
    pref_calls = []

    def pref_stub(uid, pid):
        pref_calls.append((uid, pid))
        return {"lang": {"v": "en"}}

    monkeypatch.setattr(db, "get_user_prefs", pref_stub)
    monkeypatch.setenv("TS_I18N", "0")
    handler = _FakeHandler(headers={}, user=_handler_user())
    handler._api_me_feishu_doctor({})
    assert calls == ["zh"]
    assert pref_calls == [], f"TS_I18N=0 仍读了偏好: {pref_calls}"

    # 正对照：同一请求去掉回滚开关 ⇒ 读一次偏好并采纳 en
    monkeypatch.delenv("TS_I18N", raising=False)
    handler2 = _FakeHandler(headers={}, user=_handler_user())
    handler2._api_me_feishu_doctor({})
    assert calls[-1] == "en"
    assert pref_calls == [(UID, 0)]


def test_handlers_pass_request_language(monkeypatch):
    seen = {}
    monkeypatch.setattr(feishu, "provision_cancel",
                        lambda uid, lang=None: seen.update(cancel=lang)
                        or {"ok": False, "state": "idle", "error": ""})
    monkeypatch.setattr(feishu, "provision_status",
                        lambda uid, lang=None: seen.update(status=lang)
                        or {"supported": True, "enabled": True, "state": "idle",
                            "url": "", "error": "", "app_id": "", "steps": [],
                            "age_s": 0})
    monkeypatch.setattr(feishu, "save_user_config",
                        lambda uid, body, lang=None: seen.update(save=lang)
                        or {"inbound_started": False, "verify": None})
    handler = _FakeHandler(headers={"X-TS-Lang": "en"}, user=_handler_user())
    handler._api_me_feishu_provision_set({"action": "cancel"})
    handler._api_me_feishu_provision_get()
    handler._api_me_feishu_cfg_set({})
    assert seen == {"cancel": "en", "status": "en", "save": "en"}
