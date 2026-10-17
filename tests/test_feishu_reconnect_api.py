# 设置页面板「重连入站」端点契约（隔离实例，HTTP 级）——`POST /api/me/feishu/reconnect`（M11.1）。
#
# 本文件只钉「路由 + 鉴权 + 无凭据路径」：隔离实例里没有飞书凭据、也没有入站线程，
# `restart_inbound_for` 落在「停：注册表没有线程 ⇒ False；起：凭据不全 ⇒ 打一行 stderr 后
# False」的**确定性路径**上——零网络请求、零线程（对拍 `cases-http/m11_feishu_reconnect.json`
# 与本文件同一边界，见那里的 why）。
#
# 有凭据时「真停旧连接 → 用当前库里的新凭据起新」由单元级用例覆盖：
# `tests/test_feishu_setup_card.py::test_stop_inbound_for_stops_a_real_loop` 与
# `::test_restart_inbound_for_uses_current_credentials`（合成真 event loop，不碰真网关）。
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from serverfixture import isolated_server  # noqa: F401  （pytest 夹具，模块级共享）

RECONNECT = "/api/me/feishu/reconnect"
# oracle `json.dumps(..., ensure_ascii=False)` 的**带空格**形态（`: ` 分隔）；键序 =
# ok / started / inbound，inbound 内 = configured / thread（inbound_status 只许两键）。
NOREL_CREDS_BODY = ('{"ok": true, "started": false, '
                    '"inbound": {"configured": false, "thread": false}}')


def test_reconnect_requires_login(isolated_server):
    """未登录 ⇒ 401 紧凑体（鉴权在 `do_POST` 的 `/api/` 段，先于路径分派）。"""
    anon = isolated_server.client()
    code, txt = anon(RECONNECT, "POST", {})
    assert code == 401
    assert txt == '{"error":"unauthorized"}'


def test_reconnect_without_creds_body_and_shape(isolated_server):
    """无凭据 + 无线程档：200 且正文**逐字节**（空格、键序、两键 inbound 一起钉死）。

    `started=false` 是诚实值（本次没有起新连接）；`inbound.configured=false` 让面板能区分
    「没配置」与「配置了但没起来」两种未成功原因。
    """
    code, txt = isolated_server.admin(RECONNECT, "POST", {})
    assert code == 200
    assert txt == NOREL_CREDS_BODY


def test_reconnect_is_idempotent_and_read_only(isolated_server):
    """重复点按钮：两次逐字节同体（幂等）；且**不写库**——`feishu_user_cfgs` 仍零行。

    空体 POST 也不建配置行：本端点只做「停旧/起新」读操作，不碰用户配置（配置写口只有
    `POST|PATCH /api/me/feishu-cfg`）。库断言独立于响应，见 `cases-http` 的同名 dbAsserts。
    """
    first = isolated_server.admin(RECONNECT, "POST", {})
    second = isolated_server.admin(RECONNECT, "POST", {})
    assert first == second == (200, NOREL_CREDS_BODY)
    conn = sqlite3.connect(isolated_server.db_path)
    try:
        n = conn.execute("SELECT COUNT(*) FROM feishu_user_cfgs").fetchone()[0]
    finally:
        conn.close()
    assert n == 0
