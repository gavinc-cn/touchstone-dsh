# 飞书配置自动化端点契约（隔离实例，HTTP 级）。
#
# 本文件只钉「路由 + 参数校验 + 无凭据路径」——隔离实例里没有飞书凭据，自检的
# creds 项必然 fail，且整条路径**零网络请求**（真发 token / 发布等动作由
# tests/test_feishu_provision.py 打桩覆盖，绝不在这里打真实飞书接口）。
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serverfixture import isolated_server  # noqa: F401  （pytest 夹具，模块级共享）


def test_provision_status_idle(isolated_server):
    """新实例未配置：能力可用、总闸开、状态 idle、无链接。"""
    code, d = isolated_server.admin.json("/api/me/feishu/provision")
    assert code == 200
    assert d["supported"] is True and d["enabled"] is True
    assert d["state"] == "idle" and d["url"] == "" and d["steps"] == []


def test_provision_action_validation(isolated_server):
    """非法 action → 400；空流程取消 → 200 + 中文说明（不 500）。"""
    code, d = isolated_server.admin.json("/api/me/feishu/provision", "POST",
                                        {"action": "bogus"})
    assert code == 400 and "action" in d["error"]
    code, d = isolated_server.admin.json("/api/me/feishu/provision", "POST",
                                        {"action": "cancel"})
    assert code == 200 and d["ok"] is False and "没有进行中" in d["error"]


def test_provision_apply_without_creds(isolated_server):
    """补齐配置：无凭据时零请求 + 中文引导（绝不拿空凭据打真实飞书）。"""
    code, d = isolated_server.admin.json("/api/me/feishu/provision", "POST",
                                        {"action": "apply"})
    assert code == 200 and d["ok"] is False and "凭据" in d["error"]


def test_doctor_without_creds(isolated_server):
    """自检八项齐全，首项 creds fail、其余 skip。"""
    code, d = isolated_server.admin.json("/api/me/feishu/doctor", "POST", {})
    assert code == 200
    assert [i["key"] for i in d["items"]] == [
        "creds", "token", "bot", "inbound_ws", "inbound_event",
        "slash_scope", "send_scope", "webhook"]
    assert d["items"][0]["state"] == "fail"
    assert d["summary"]["fail"] == 1 and d["summary"]["skip"] >= 5


def test_cfg_save_without_creds_keeps_verify_null(isolated_server):
    """保存配置（未动凭据）：沿用既有响应 + verify=null（不触发任何探测请求）。"""
    code, d = isolated_server.admin.json("/api/me/feishu-cfg", "PATCH", {"enabled": True})
    assert code == 200 and d["ok"] is True and d["verify"] is None
    assert d["inbound_started"] is False


def test_provision_status_reports_configured_app(isolated_server):
    """已存应用（只存 app_id 不存 secret ⇒ 不触发快检，零网络）时 status 必须回出它：
    否则前端按 `force: !!st.app_id` 判二次确认，「扫码换应用」对已有应用的用户走不通
    （复阅 Critical 的 HTTP 级钉子；站点重启后 _PROVISION 内存态清空即此形态）。"""
    code, d = isolated_server.admin.json("/api/me/feishu-cfg", "PATCH",
                                        {"app_id": "cli_cfg_only"})
    assert code == 200 and d["verify"] is None
    code, st = isolated_server.admin.json("/api/me/feishu/provision")
    assert code == 200 and st["state"] == "idle" and st["app_id"] == "cli_cfg_only"
