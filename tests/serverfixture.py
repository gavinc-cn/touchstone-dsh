#!/usr/bin/env python3
"""隔离实例服务夹具（2026-09-13 批次）：提炼自 e2e_chat_queue.py 的隔离实例模式。

在临时沙箱（临时库 / 运行目录 / 项目目录 / 工作目录 / 假 agent）中以随机端口
拉起真实 server.py，提供已登录 admin 的 HTTP 客户端。供 server 契约、多用户
越权等 HTTP 级测试使用；实例不触碰真实 ~/.touchstone 库与 .run 端口标记。

**2026-10-03（路线 A P7a）**：产品口径收敛为「只有 dsh 插件族」，故替身从「假
CLI agent」换成 **假 driver**（`tests/fakedriver.py`，实现 `/touchstone-agent`
契约的进程内 HTTP 服务）——平台侧 runner/board/chat/dshevents 全部走真实驱动
路径，不再依赖任何 CLI 族。夹具仍保留 `call_mark()`（`CALL {json}` 行）与
`TS_E2E_SLEEP` 语义，既有断言零改动。

用法（pytest 层，module 级共享，测试数据自行唯一命名）:

    from serverfixture import isolated_server

    def test_xxx(isolated_server):
        code, d = isolated_server.admin.json("/api/projects")
        assert code == 200

需要全新实例的用例可自行构造 IsolatedServer()（同进程多实例，端口互不冲突）。
"""

import http.cookiejar
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fakedriver import FakeDriver      # noqa: E402 — 与夹具同目录的测试资产

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 插件形态免登信任头（与 server.TRUST_USER_HEADER / 薄壳 TRUST_HEADER 逐字一致）
TRUST_HEADER = "X-TS-Internal-User"


def free_port():
    """向内核申请一个空闲端口（bind 0 后立即释放，供隔离实例使用）。"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_port(port, timeout=30):
    """等待端口进入监听（隔离实例启动探活）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


class Api:
    """标准库 HTTP 客户端（cookie 会话）；非 2xx 也返回响应体由调用方断言。

    headers 为额外请求头：插件形态的免登信任头（`X-TS-Internal-User: admin`）走这里。
    """

    def __init__(self, base, headers=None):
        self.base = base
        self.headers = dict(headers or {})
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def __call__(self, path, method="GET", body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={**self.headers,
                                              "Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8")

    def json(self, path, method="GET", body=None):
        """返回 (status_code, 解析后的 JSON；非 JSON 响应回落 {"_raw": 文本})。"""
        code, txt = self(path, method, body)
        try:
            return code, json.loads(txt)
        except ValueError:
            return code, {"_raw": txt}


class IsolatedServer:
    """临时沙箱中的真实 server.py 实例（随机端口 + 假 agent + 临时库）。

    extra_env 可追加/覆盖服务进程的环境变量（如把 HOME / TS_EXT_DIR 重定向到
    沙箱，隔离「内置资产安装」这类会写用户 HOME 的端点）。
    seed_random_pw=True 时不设 TS_ADMIN_PASSWORD（走随机一次性口令 + 强制改密链路），
    此时不自动登录，调用方从 server_log() 的启动横幅里取口令自行登录。
    trust_internal=True 按**插件形态**起（`--trust-internal-user`，仅回环）：请求带
    `X-TS-Internal-User: admin` 即免登 admin（`srv.trust` 客户端已带该头），同样不
    自动口令登录——用于验证「免登路径跳过强制改密门 / 存量库不再锁死」。
    """

    def __init__(self, sleep="1", extra_env=None, seed_random_pw=False,
                 trust_internal=False):
        self.sleep = sleep
        self.extra_env = dict(extra_env or {})   # 追加/覆盖给 server 子进程的环境变量
        self.seed_random_pw = seed_random_pw     # True=不设初始口令, 验证随机种子链路
        self.trust_internal = trust_internal     # True=按插件形态起（--trust-internal-user）
        # 隔离实例初始口令：每次实例化随机生成（不再固定弱口令；env 注入与登录夹具共用）
        self.admin_pw = secrets.token_urlsafe(9)
        self.sandbox = None
        self.port = None
        self.proc = None
        self.driver = None      # 假 driver（P7a：dsh_plugin 族的替身服务）
        self.admin = None       # 已登录 admin 的 Api（seed_random_pw/trust_internal 时为 None）
        self.trust = None       # 免登信任头客户端（trust_internal 时可用）
        self._logf = None

    # ---------- 生命周期 ----------

    def start(self):
        """建沙箱、写假 agent、拉起 server、等待监听、以 admin 登录。"""
        if not os.path.isfile(os.path.join(ROOT, "webui", "dist", "index.html")):
            pytest.skip("缺少 webui/dist（先执行 ./touchstone.sh build），跳过隔离实例测试")
        self.sandbox = tempfile.mkdtemp(prefix="tf_iso_")
        self.db_path = os.path.join(self.sandbox, "touchstone.db")
        self.proj_dir = os.path.join(self.sandbox, "proj")
        self.work_dir = os.path.join(self.sandbox, "work")
        self.mark = os.path.join(self.sandbox, "calls.log")
        os.makedirs(self.proj_dir)
        os.makedirs(self.work_dir)
        open(self.mark, "w").close()
        # 假 driver（P7a）：进程内 HTTP 服务，实现 /touchstone-agent 契约。
        # turn_ms 由 sleep（秒，字符串）换算——既有夹具用 sleep="1"/"4" 控制一轮时长。
        self.driver = FakeDriver(mark=self.mark,
                                 turn_ms=int(float(self.sleep) * 1000)).start()
        # 项目 agent_path 走 `dsh-plugin:` 虚拟条目（建项目不校验路径存在；
        # 仍落一个占位可执行文件，便于排查与人工核对）
        agent = os.path.join(self.sandbox, "dsh")
        with open(agent, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(agent, 0o755)
        self.agent_path = "dsh-plugin:" + agent
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        env = dict(
            os.environ,
            TOUCHSTONE_DB=self.db_path,
            # 隔离实例初始口令每次随机（self.admin_pw）：2026-10-02 起服务端在未设该
            # 变量时会随机生成一次性口令并要求首次登录改密，故必须显式给值才能免改密登录。
            # seed_random_pw=True 时反过来清空它（专门验证随机种子 + 强制改密链路）
            TS_ADMIN_PASSWORD="" if self.seed_random_pw else self.admin_pw,
            # 驱动连接信息：平台据此启用 dsh_plugin 族与 dshevents 全局状态流
            TS_AGENT_DRIVER_URL=self.driver.url,
            TS_AGENT_DRIVER_TOKEN=self.driver.token,
            TS_E2E_MARK=self.mark,
            TS_E2E_SLEEP=self.sleep,
            # 端口标记写 sandbox，不污染真实实例的 .run/server.port
            TOUCHSTONE_RUN_DIR=os.path.join(self.sandbox, "run"),
        )
        env.update(self.extra_env)
        self._logf = open(os.path.join(self.sandbox, "server.log"), "w", encoding="utf-8")
        args = [sys.executable, "server.py", "--port", str(self.port),
                "--web-dir", "webui/dist"]
        if self.trust_internal:
            # 插件形态：仅回环监听 + 免登信任头（server.py 侧硬校验 host 必须是回环）
            args += ["--host", "127.0.0.1", "--trust-internal-user"]
        self.proc = subprocess.Popen(
            args,
            cwd=ROOT, env=env, stdout=self._logf, stderr=subprocess.STDOUT,
            start_new_session=True)
        if not wait_port(self.port):
            self.stop()
            raise RuntimeError(f"隔离实例启动失败（见 {self.sandbox}/server.log）")
        if self.trust_internal:
            self.trust = Api(self.base, headers={TRUST_HEADER: "admin"})
        if self.seed_random_pw or self.trust_internal:
            # 随机种子/插件形态：口令在启动横幅里（或根本不需要），由调用方自行取用
            return self
        self.admin = Api(self.base)
        code, d = self.admin.json("/api/auth/login", "POST",
                                  {"username": "admin", "password": self.admin_pw})
        if code != 200:
            self.stop()
            raise RuntimeError(f"隔离实例 admin 登录失败: {code} {d}")
        return self

    def server_log(self):
        """读实例 stdout/stderr（沙箱 server.log）文本，供断言启动横幅等。"""
        path = os.path.join(self.sandbox, "server.log")
        if not os.path.isfile(path):
            return ""
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def stop(self):
        """杀进程组、停假 driver 并清理沙箱（幂等，可在 finally 中安全调用）。"""
        if self.proc is not None:
            try:
                os.killpg(os.getpgid(self.proc.pid), 15)
                self.proc.wait(timeout=10)
            except Exception:
                pass
        if self.driver is not None:
            try:
                self.driver.stop()
            except Exception:
                pass
            self.driver = None
        if self._logf is not None:
            try:
                self._logf.close()
            except Exception:
                pass
        if self.sandbox:
            shutil.rmtree(self.sandbox, ignore_errors=True)
        self.proc = None

    # ---------- 便捷操作 ----------

    def client(self):
        """新的未登录客户端。"""
        return Api(self.base)

    def login(self, username, password):
        """新建客户端并登录（断言登录成功）。"""
        api = Api(self.base)
        code, d = api.json("/api/auth/login", "POST",
                           {"username": username, "password": password})
        assert code == 200, f"登录失败: {code} {d}"
        return api

    def create_user(self, username, password):
        """经 admin 用户管理端点建普通用户（返回用户 id）。"""
        code, d = self.admin.json("/api/admin/users", "POST",
                                  {"username": username, "password": password})
        assert code == 200, f"建用户失败: {code} {d}"
        return d["id"]

    def create_project(self, api, name, project_dir=None, **extra):
        """以指定客户端建项目（默认用假 agent 与沙箱项目/工作目录）。"""
        payload = {"name": name, "project_dir": project_dir or self.proj_dir,
                   "agent_path": self.agent_path, "work_dir": self.work_dir}
        payload.update(extra)
        code, d = api.json("/api/projects", "POST", payload)
        assert code == 200, f"建项目失败: {code} {d}"
        return d["id"]

    def call_mark(self):
        """读假 driver 调用标记（断言驱动是否被真正调用/收到内容）。"""
        try:
            with open(self.mark, encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return ""

    def driver_ctl(self, path, body=None):
        """调假 driver 控制面（`/_ctl/*`）：制造挂起提问/审批、读请求计数等。

        body 为 None 走 GET（如 `/_ctl/stats`），否则 POST；返回解析后的 JSON。
        """
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.driver.url + path, data=data,
            method="POST" if data is not None else "GET",
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    @staticmethod
    def wait_until(fn, timeout=60, interval=0.5):
        """轮询等待条件成立（真实异步链路断言用）。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if fn():
                return True
            time.sleep(interval)
        return False


@pytest.fixture(scope="module")
def isolated_server():
    """模块级隔离实例：起停一次，供同文件全部用例共享（数据自行唯一命名）。"""
    srv = IsolatedServer()
    try:
        srv.start()
        yield srv
    finally:
        srv.stop()
