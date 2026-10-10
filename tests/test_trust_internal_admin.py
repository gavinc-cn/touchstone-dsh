#!/usr/bin/env python3
"""插件形态鉴权：免登信任头与空口令种子（2026-10-08 批次）。

背景：插件形态面板经薄壳反代注入 `X-TS-Internal-User: admin` 即免登 admin，而
`server.py` 的「首次登录强制改密」门对两条认证路径一视同仁——首装随机一次性口令
只打印在启动横幅里（薄壳曾整段丢弃），用户既不知道口令、又过不了闸 ⇒ 平台锁死，
只能出库改 users 表。本档把三条口径钉死：

  ① 免登信任头路径**跳过**强制改密门（存量库 must_change_pw=1 在插件形态不再锁死）；
  ② 免登路径下改密**不校验原口令**（原口令是随机一次性口令，用户不可能知道；
     信任头本就等价 admin，不新增权限面）；
  ③ 非信任头路径的门**照旧**（不因为①把闸整体拆掉）。

另有一条插件形态种子链路：`TS_ADMIN_PASSWORDLESS=1` → 空口令 admin、不强制改密，
用户设置了密码就按设置的来（见 tests/test_seed_admin.py 的单测）。
"""
import re
import time

from serverfixture import IsolatedServer


def _banner_password(srv, timeout=10):
    """从启动横幅提取一次性口令（横幅是唯一出口，服务端不留明文）。"""
    deadline = time.time() + timeout
    log = ""
    while time.time() < deadline:
        log = srv.server_log()
        m = re.search(r"一次性初始口令：(\S+?)[，;]", log)
        if m:
            return m.group(1)
        time.sleep(0.1)
    raise AssertionError(f"启动横幅未打印一次性口令:\n{log[-1000:]}")


def test_trust_header_bypasses_forced_change_and_resets_password():
    """插件形态（存量库 must_change_pw=1）：免登可直用 + 免原口令设新密码。"""
    srv = IsolatedServer(seed_random_pw=True, trust_internal=True)
    try:
        srv.start()
        trust = srv.trust
        code, d = trust.json("/api/auth/me")
        assert code == 200 and d["must_change_password"] is True, (code, d)
        # ① 门不拦免登路径（修复前这里是 403「请先修改初始口令」）
        code, d = trust.json("/api/projects")
        assert code == 200, (code, d)
        # ② 免登路径改密不校验原口令（用户不可能知道随机一次性口令）
        code, d = trust.json("/api/auth/change_password", "POST",
                             {"old_password": "", "new_password": "panel-set-pw-9"})
        assert code == 200, (code, d)
        code, d = trust.json("/api/auth/me")
        assert code == 200 and d["must_change_password"] is False, (code, d)
        # 设了密码就按密码：非信任头（口令登录）路径可用
        cli = srv.login("admin", "panel-set-pw-9")
        code, d = cli.json("/api/projects")
        assert code == 200, (code, d)
    finally:
        srv.stop()


def test_non_trust_client_still_gated():
    """③ 对照组：同实例上不带信任头的会话仍被强制改密门拦住（闸没被整体拆掉）。"""
    srv = IsolatedServer(seed_random_pw=True, trust_internal=True)
    try:
        srv.start()
        pw = _banner_password(srv)
        cli = srv.client()
        code, d = cli.json("/api/projects")
        assert code == 401, (code, d)              # 未登录：通用鉴权
        code, d = cli.json("/api/auth/login", "POST",
                           {"username": "admin", "password": pw})
        assert code == 200 and d["must_change_password"] is True, (code, d)
        code, d = cli.json("/api/projects")
        assert code == 403 and "初始口令" in d.get("error", ""), (code, d)
    finally:
        srv.stop()


def test_passwordless_seed_serves_plugin_mode():
    """插件形态种子链路：`TS_ADMIN_PASSWORDLESS=1` → 空口令 admin、不强制改密。"""
    srv = IsolatedServer(seed_random_pw=True,
                         extra_env={"TS_ADMIN_PASSWORDLESS": "1"})
    try:
        srv.start()
        cli = srv.login("admin", "")               # 空口令即可登录
        code, d = cli.json("/api/auth/me")
        assert code == 200 and d["must_change_password"] is False, (code, d)
        code, d = cli.json("/api/projects")
        assert code == 200, (code, d)
        # 用户设置了密码就按设置的来
        code, d = cli.json("/api/auth/change_password", "POST",
                           {"old_password": "", "new_password": "my-new-pw-1"})
        assert code == 200, (code, d)
        code, d = srv.login("admin", "my-new-pw-1").json("/api/projects")
        assert code == 200, (code, d)
    finally:
        srv.stop()
