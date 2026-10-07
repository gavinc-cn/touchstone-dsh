"""首次登录强制改密链路（2026-10-02 批次，隔离实例 HTTP 级）。

覆盖：未设 TS_ADMIN_PASSWORD 时服务端随机生成一次性口令 → 只在启动横幅打印一次 →
登录响应带 must_change_password → 未改密时白名单外 API 一律 403 → 改密成功后全量放行。
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from serverfixture import Api, IsolatedServer  # noqa: E402

# 启动横幅里的一次性口令片段（server._seed_hint 文案）
_BANNER_RE = re.compile(r"一次性初始口令：(\S+?)[，;]")


def _banner_password(srv, timeout=10):
    """从启动横幅提取一次性口令（横幅是唯一出口，服务端不留明文）。

    端口可用 ≠ 横幅已落盘：隔离子进程先 bind 再打印，故这里**轮询等待**
    （2026-10-03：全量跑时偶发「横幅未打印」竞态，单跑不复现）。
    """
    deadline = time.time() + timeout
    log = ""
    while time.time() < deadline:
        log = srv.server_log()
        m = _BANNER_RE.search(log)
        if m:
            return m.group(1)
        time.sleep(0.1)
    raise AssertionError(f"启动横幅未打印一次性口令:\n{log[-1000:]}")


def test_random_seed_prints_once_and_gates_until_changed():
    """随机种子 → 横幅取口令登录 → 未改密 403 → 改密后 200，且标记只在首登为真。"""
    srv = IsolatedServer(seed_random_pw=True)
    try:
        srv.start()
        pw = _banner_password(srv)
        assert len(pw) >= 12 and pw != "123456"

        api = Api(srv.base)
        code, d = api.json("/api/auth/login", "POST",
                           {"username": "admin", "password": pw})
        assert code == 200, d
        assert d["must_change_password"] is True

        # me 在白名单内：可读，且下发门控标记（前端据此渲染改密门）
        code, d = api.json("/api/auth/me")
        assert code == 200 and d["must_change_password"] is True, (code, d)

        # 白名单外的业务端点：未改密一律 403
        code, d = api.json("/api/projects")
        assert code == 403, (code, d)
        assert "初始口令" in d.get("error", ""), d

        # 改密（原口令=横幅口令）→ 标记清除 → 业务端点放行
        code, d = api.json("/api/auth/change_password", "POST",
                           {"old_password": pw, "new_password": "new-pw-123456"})
        assert code == 200, (code, d)
        code, d = api.json("/api/auth/me")
        assert d["must_change_password"] is False, d
        code, d = api.json("/api/projects")
        assert code == 200, (code, d)
    finally:
        srv.stop()


def test_env_password_seed_skips_gate():
    """显式设 TS_ADMIN_PASSWORD：不置强制改密标记，登录后业务端点直接可用。"""
    srv = IsolatedServer()          # 夹具默认注入随机初始口令（srv.admin_pw）
    try:
        srv.start()
        assert srv.admin is not None
        code, d = srv.admin.json("/api/auth/me")
        assert code == 200 and d["must_change_password"] is False, (code, d)
        code, d = srv.admin.json("/api/projects")
        assert code == 200, (code, d)
    finally:
        srv.stop()
