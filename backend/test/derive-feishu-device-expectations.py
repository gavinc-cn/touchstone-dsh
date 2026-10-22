#!/usr/bin/env python3
"""期望值**出处**脚本（不是测试，不被收集）：驱动真 oracle 的 `_SyncFlow` 打轨迹。

为什么需要它：`backend/test/feishu-device.test.mjs` 里那些常量（确认链接、addons 明文、
错误对象形态、slow_down 间隔序列……）如果靠手抄，就变成「我对 oracle 的转述」而不是
「oracle 的行为」。本脚本**实例化真的 `lark_oapi.scene.registration._SyncFlow`**，
只替换两处非决定性依赖：
  - `_post` → 脚本化响应序列（记录每次请求体，这就是 `urlencode(data)` 的输入）；
  - `time.sleep` → no-op（否则 slow_down 用例要睡几十秒）。

跑法（本机 oracle 解释器，装了 lark-oapi 1.7.3）：

    /opt/miniconda3/envs/my_pyenv/bin/python3 \
        backend/test/derive-feishu-device-expectations.py

输出即 `feishu-device.test.mjs` 顶部注释所引的轨迹。改协议实现后重跑本脚本，
把新读数抄回测试 —— 这是两侧保持同步的唯一入口。

注：本文件在 `backend/test/` 下但不叫 `test_*.py`，且 pytest.ini 的 `testpaths = tests`
已把收集根钉死在 `tests/`，故**不会被 pytest 收集**。
"""
import json
import sys

try:
    from lark_oapi.scene.registration import _SyncFlow, _encode_addons, _normalize_addons
except ImportError as exc:  # pragma: no cover - 环境不对时给一句人话
    sys.exit(f"需要能 import lark_oapi 的解释器（本机：/opt/miniconda3/envs/my_pyenv/bin/python3）：{exc}")

# 与 Node 侧 REQUIRED_SCOPES/EVENTS/CALLBACKS（feishu.py:1263-1271）逐字相同
# 2026-10-22 飞书截图批次：末尾追加 `im:message:readonly`（下载消息中的图片资源所需）
ADDONS = {
    "preset": False,
    "scopes": {"tenant": ["im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly",
                          "im:message:send_as_bot", "application:app_slash_command:read",
                          "application:app_slash_command:write",
                          "im:message:readonly"]},
    "events": {"items": {"tenant": ["im.message.receive_v1"]}},
    "callbacks": {"items": ["card.action.trigger"]},
}

# 键序 device_code/verification_uri/user_code/expires_in（照抄飞书真链路形态）
VERIFICATION_URI = ("https://accounts.feishu.cn/qrcode?device_code=DC-abc123"
                    "&verification_uri=https%3A%2F%2Faccounts.feishu.cn%2Fverify"
                    "&user_code=WDJB-MJHT&expires_in=600")

INIT_OK = {"supported_auth_methods": ["client_secret", "something_else"]}
BEGIN_OK = {"device_code": "DC-abc123", "interval": 5, "expires_in": 600,
            "verification_uri_complete": VERIFICATION_URI}

CASES = {
    "happy": [INIT_OK, BEGIN_OK, {"error": "authorization_pending"},
              {"client_id": "cli_new", "client_secret": "sec-new"}],
    "slow_down": [INIT_OK, BEGIN_OK, {"error": "slow_down"},
                  {"error": "authorization_pending"},
                  {"client_id": "cli_new", "client_secret": "sec-new"}],
    "domain_switch": [INIT_OK, BEGIN_OK, {"user_info": {"tenant_brand": "lark"}},
                      {"client_id": "cli_new", "client_secret": "sec-new"}],
    "access_denied": [INIT_OK, BEGIN_OK, {"error": "access_denied",
                                          "error_description": "user said no"}],
    "expired_token": [INIT_OK, BEGIN_OK, {"error": "expired_token",
                                          "error_description": "code expired"}],
    "other_error": [INIT_OK, BEGIN_OK, {"error": "weird", "error_description": "desc"}],
    "bad_auth": [{"supported_auth_methods": ["something_else"]}],
    "success_with_user_info": [INIT_OK, BEGIN_OK,
                               {"client_id": "cli_new", "client_secret": "sec-new",
                                "user_info": {"open_id": "ou_1"}}],
}


class _Cancel:
    def __init__(self):
        self.flag = False

    def is_set(self):
        return self.flag

    def set(self):
        self.flag = True


def drive(responses):
    posted, qr, status = [], [], []
    it = iter(responses)

    class Flow(_SyncFlow):
        def _post(self, data):
            posted.append(data)
            return next(it)

    flow = Flow(on_qr_code=lambda info: qr.append(info),
                on_status_change=lambda info: status.append(info),
                source=None, cancel_event=_Cancel(),
                domain="https://accounts.feishu.cn",
                lark_domain="https://accounts.larksuite.com",
                addons=ADDONS)
    import lark_oapi.scene.registration as reg
    real_sleep = reg.time.sleep
    reg.time.sleep = lambda _s: None
    try:
        out, err = flow.run(), None
    except Exception as e:  # noqa: BLE001 - 轨迹要的就是异常形态
        out, err = None, "%s|%s" % (type(e).__name__, e)
    finally:
        reg.time.sleep = real_sleep
    return {"posted": posted, "qr": qr, "status": status, "out": out, "err": err,
            "base_url": flow._base_url}


def main():
    trace = {name: drive(resps) for name, resps in CASES.items()}
    trace["_addons_encoded"] = _encode_addons(ADDONS)
    trace["_addons_payload"] = json.dumps(_normalize_addons(ADDONS),
                                          ensure_ascii=False, separators=(",", ":"))
    print(json.dumps(trace, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
