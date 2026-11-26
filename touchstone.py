#!/usr/bin/env python3
"""Touchstone 跨平台启停器：start / stop / restart / status / build / test / test-full / test-ui。

Windows 原生运行的首选入口（bash/nohup/kill 不可用），Linux 上与 touchstone.sh 等价
（touchstone.sh 保留为 Linux 惯用入口，两者命令面与运行产物一致：.run/server.pid、
.run/server.log）。用法:

    python3 touchstone.py start|stop|restart|status|build|test|test-full|test-ui
    # 独立站点后端缺省 node（backend/server.js）；TS_BACKEND=python 回退 backend_py/server.py
    # Windows: python touchstone.py 或 touchstone.cmd（后者自动解析 python → python3）

行为对齐 touchstone.sh:
- start / restart 先按需构建前端（npm install 按需：依赖指纹未变化则跳过，
  TS_FORCE_INSTALL=1 强制重装；npm run build 按需：源码指纹未变化且 dist 在
  则跳过，TS_FORCE_BUILD=1 强制重建；无 dist 则 server.py 直接退出），
  任一步失败即中止启动；
- 独立站点缺省 Node：start 前预检 node >= 22.19 + npm；TS_BACKEND=python 时做
  Python 运行依赖预检（zstandard/requests 顶层导入，缺失即启动崩）；
- 后台拉起 backend/server.js（缺省）或 backend_py/server.py（回退）：POSIX
  start_new_session 脱离本进程组、Windows
  DETACHED_PROCESS 脱离控制台，日志追加写 .run/server.log，env 注入
  PYTHONUTF8=1 统一子进程编码；
- stop 发 SIGTERM（Windows 无优雅终止信号，os.kill 即 TerminateProcess 强杀；
  托管的 kimi web / opencode serve 由 platcompat Job Object 随父进程终止），
  POSIX 超时后升级 SIGKILL；
- 监听默认 127.0.0.1:4601（仅本机），环境变量 TS_PORT / TS_HOST 覆盖
  （对外监听: TS_HOST=0.0.0.0）。

测试三档（2026-09-13 批次，细节见 tests/README.md）:
- test      快层：后端单测 pytest + 前端单测 vitest（webui 配置后自动纳入）；
- test-full 快层 + 隔离实例 e2e 脚本（自起临时实例，无需站点，分钟级）；
- test-ui   Playwright e2e（需站点在跑；只探活提示，不自动重启站点）。
测试解释器即本脚本解释器（sys.executable），请用项目 Python 环境运行 touchstone.py。
"""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
# Python 后端源码在 <仓库>/backend_py/（2026-10-19 起）：本启停器只 import 它的
# platcompat（进程/端口兼容层），先把该目录放进 sys.path（后端自身启动时脚本目录
# 本就自动在 sys.path 首位，无需此步）
sys.path.insert(0, os.path.join(ROOT, "backend_py"))
import platcompat  # noqa: E402 — 必须在 backend_py 入 sys.path 之后导入
PORT = int(os.environ.get("TS_PORT", "4601"))
HOST = os.environ.get("TS_HOST", "127.0.0.1")  # 监听地址: 默认仅本机回环, 对外监听显式 TS_HOST=0.0.0.0
# 站点后端选择：node（缺省，2026-11-26 起）| python（显式回退）
BACKEND = (os.environ.get("TS_BACKEND") or "node").strip()
# 可执行文件：TS_NODE / TS_NPM 可覆盖（Windows 上 node/npm 不一定在 PATH）
NODE = os.environ.get("TS_NODE") or "node"
NPM = os.environ.get("TS_NPM") or "npm"
RUN_DIR = os.environ.get("TOUCHSTONE_RUN_DIR") or os.path.join(ROOT, ".run")
PID_FILE = os.path.join(RUN_DIR, "server.pid")
LOG_FILE = os.path.join(RUN_DIR, "server.log")
PORT_FILE = os.path.join(RUN_DIR, "server.port")  # 后端落盘的实际监听端口
PROBE_TIMEOUT = 20   # 启动探活超时（秒；实测 server 拉起到可服务含 feishu 入站
                     # 连接等初始化可超 10s，留足余量）
STOP_TIMEOUT = 5     # SIGTERM 后等待退出的超时（秒）


def print_err(msg):
    """错误统一走 stderr。"""
    print(msg, file=sys.stderr)


def read_pid():
    """读 PID 文件：进程存活则返回 pid；文件缺失/进程已死清理残留并返回 None。"""
    try:
        with open(PID_FILE, encoding="utf-8") as f:
            pid = int((f.read() or "").strip() or 0)
    except (OSError, ValueError):
        return None
    if platcompat.pid_alive(pid):
        return pid
    try:
        os.remove(PID_FILE)
    except OSError:
        pass
    return None


def actual_port():
    """读 server.py 落盘的实际监听端口（绑定失败自动顺延后与 PORT 不同）；
    文件缺失/内容非法返回 None（调用方回退 PORT）。"""
    try:
        with open(PORT_FILE, encoding="utf-8") as f:
            return int((f.read() or "").strip() or 0)
    except (OSError, ValueError):
        return None


def probe_port(port):
    """对指定端口发 HTTP 请求：任何响应（含 302/401）即视为服务在。"""
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2)
        return True
    except urllib.error.HTTPError:
        return True   # 有 HTTP 响应即活（401 登录墙/302 跳转都算）
    except Exception:
        return False


def probe():
    """探活已在运行的实例：优先按 server.py 落盘的实际监听端口（server 绑定失败
    会自动 port+1 顺延，启动器须跟着探新端口），无落盘时回退 TS_PORT/默认端口。"""
    return probe_port(actual_port() or PORT)


def log_tail(n=10):
    """取日志尾部 n 行（启动失败时给用户排障）。"""
    try:
        with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return "（无日志）"


def precheck_deps():
    """运行依赖预检：zstandard/requests 为模块顶层导入，缺失则 server.py
    import 阶段即崩，提前给出可执行的修复命令。"""
    try:
        import requests   # noqa: F401
        import zstandard  # noqa: F401
    except ImportError as e:
        # 用当前解释器自己的路径提示（不写死 python3/python）: Windows 官方安装器只有
        # `python.exe`、Linux 惯例是 `python3`, 报用户机器上真正在跑的那个最不容易误导。
        py = sys.executable or "python"
        print_err(f"错误: 当前解释器缺少运行依赖（{e}），请先执行:")
        print_err(f"    {py} -m pip install -r backend_py/requirements.txt")
        sys.exit(1)


def find_npm():
    """定位 npm（TS_NPM 覆盖；Windows 下为 npm.cmd，shutil.which 按 PATHEXT 命中）。"""
    npm = shutil.which(NPM)
    if not npm:
        print_err("错误: 未找到 npm（前端构建需要 Node.js；用 TS_NPM=<路径> 指定）")
        sys.exit(1)
    return npm


def find_node():
    """定位 node（TS_NODE 覆盖；Windows 下为 node.exe）。"""
    node = shutil.which(NODE)
    if not node:
        print_err("错误: 未找到 node（独立站点默认 Node 后端；用 TS_NODE=<路径> 指定，"
                  "或 TS_BACKEND=python 回退）")
        sys.exit(1)
    return node


def require_node():
    """Node 运行依赖预检：可执行文件在 + 版本 >= 22.19（node:sqlite 的硬门槛）。

    缺依赖时在构建/启动前报错；否则后端 import 期才崩，用户只会看到一行 traceback。
    """
    node = find_node()
    try:
        out = subprocess.run([node, "-p", "process.versions.node"],
                             capture_output=True, text=True, timeout=5)
        ver = (out.stdout or "").strip()
        major, minor = (int(x) for x in ver.split(".")[:2])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print_err(f"错误: 无法读取 Node 版本（{NODE}）")
        sys.exit(1)
    if major < 22 or (major == 22 and minor < 19):
        print_err(f"错误: Node {ver} 低于 22.19（node:sqlite 需要）")
        print_err("升级 Node 到 22.19+，或用 TS_BACKEND=python 回退")
        sys.exit(1)
    find_npm()
    return node


# 安装指纹戳文件名（置于 webui/node_modules 下，随 node_modules 一起消失）
STAMP_NAME = ".touchstone-install-stamp"


def deps_fingerprint(webui):
    """webui 依赖清单指纹：package.json + package-lock.json 字节顺序拼接的 md5。

    与 touchstone.sh 的 `cat 清单 | md5sum` 管道同算法（戳文件两启动器互通）；
    清单文件缺失按存在者拼接，全部缺失返回空串。"""
    parts = []
    for name in ("package.json", "package-lock.json"):
        try:
            with open(os.path.join(webui, name), "rb") as f:
                parts.append(f.read())
        except OSError:
            continue
    if not parts:
        return ""
    return hashlib.md5(b"".join(parts)).hexdigest()


def npm_install_needed(webui):
    """是否需要执行 npm install：TS_FORCE_INSTALL=1 强制重装、node_modules
    或指纹戳缺失、清单指纹与戳不一致（依赖变更）时需要，否则跳过。"""
    if os.environ.get("TS_FORCE_INSTALL") == "1":
        return True
    if not os.path.isdir(os.path.join(webui, "node_modules")):
        return True
    stamp = os.path.join(webui, "node_modules", STAMP_NAME)
    if not os.path.isfile(stamp):
        return True
    try:
        with open(stamp, encoding="utf-8") as f:
            recorded = f.read().strip()
    except OSError:
        return True
    return recorded != deps_fingerprint(webui)


def write_install_stamp(webui):
    """npm install 成功后记录当前依赖指纹（临时文件 + os.replace 原子落盘）。"""
    stamp = os.path.join(webui, "node_modules", STAMP_NAME)
    tmp = stamp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(deps_fingerprint(webui))
    os.replace(tmp, stamp)


# 构建指纹戳文件名（置于 webui/dist 下，随 dist 一起消失——删 dist 即自然重建）
BUILD_STAMP_NAME = ".touchstone-build-stamp"

# 构建指纹的顶层配置文件（src 树之外参与 vite build 的输入；存在才算入）
BUILD_EXTRA_FILES = ("components.json", "index.html", "package.json",
                     "vite.config.js")


def build_fingerprint(webui):
    """webui 构建源码指纹：src 树全部文件 + 顶层构建配置，按 webui 相对路径
    排序后以「路径 + 换行 + 文件字节」顺序拼接的 md5 hex。

    与 touchstone.sh 的 find/sort/while 管道同算法（戳文件两启动器互通）；
    src 与顶层配置全缺返回空串。"""
    files = []
    src = os.path.join(webui, "src")
    for dirpath, _dirnames, filenames in os.walk(src):
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), webui)
            files.append(rel.replace(os.sep, "/"))
    for name in BUILD_EXTRA_FILES:
        if os.path.isfile(os.path.join(webui, name)):
            files.append(name)
    if not files:
        return ""
    files.sort()
    h = hashlib.md5()
    for rel in files:
        h.update(rel.encode("utf-8") + b"\n")
        with open(os.path.join(webui, rel), "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    return h.hexdigest()


def build_needed(webui):
    """是否需要执行 npm run build：TS_FORCE_BUILD=1 强制重建、dist/index.html
    缺失、npm install 待执行（依赖变更/强制重装/目录缺失，旧 dist 不再可信）、
    源码指纹与戳不一致（前端源码变更）时需要，否则跳过。"""
    if os.environ.get("TS_FORCE_BUILD") == "1":
        return True
    if not os.path.isfile(os.path.join(webui, "dist", "index.html")):
        return True
    if npm_install_needed(webui):
        return True
    stamp = os.path.join(webui, "dist", BUILD_STAMP_NAME)
    if not os.path.isfile(stamp):
        return True
    try:
        with open(stamp, encoding="utf-8") as f:
            recorded = f.read().strip()
    except OSError:
        return True
    return recorded != build_fingerprint(webui)


def write_build_stamp(webui):
    """npm run build 成功后记录当前源码指纹（临时文件 + os.replace 原子落盘）。"""
    stamp = os.path.join(webui, "dist", BUILD_STAMP_NAME)
    tmp = stamp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(build_fingerprint(webui))
    os.replace(tmp, stamp)


def cmd_build():
    """前端构建：npm install（按需——依赖指纹未变则跳过，TS_FORCE_INSTALL=1
    强制重装）+ npm run build（按需——源码指纹未变且 dist 在则跳过，
    TS_FORCE_BUILD=1 强制重建），任一步失败即退出。"""
    npm = find_npm()
    webui = os.path.join(ROOT, "webui")
    if npm_install_needed(webui):
        print("==> npm install")
        r = subprocess.run([npm, "install"], cwd=webui)
        if r.returncode != 0:
            print_err("错误: npm install 失败")
            sys.exit(1)
        write_install_stamp(webui)
    else:
        print("==> npm install（跳过: 依赖未变化, TS_FORCE_INSTALL=1 可强制重装）")
    if build_needed(webui):
        print("==> npm run build")
        r = subprocess.run([npm, "run", "build"], cwd=webui)
        if r.returncode != 0:
            print_err("错误: npm run build 失败")
            sys.exit(1)
        if not os.path.isfile(os.path.join(webui, "dist", "index.html")):
            print_err("错误: 构建完成但未找到 webui/dist/index.html")
            sys.exit(1)
        write_build_stamp(webui)
    else:
        print("==> npm run build（跳过: 前端源码未变化, TS_FORCE_BUILD=1 可强制重建）")
    print("构建完成: webui/dist")


def start_port_taken():
    """start 前置占用检查：只探本次要绑定的配置端口（TS_PORT/默认 4601）。

    不能读 PORT_FILE：它记录的是**已运行实例**的实际端口（Python 绑定失败会顺延，
    插件后端的随机端口也可能落在这里），拿它探活会把别的实例误判成本端口被占。
    2026-11-26 实录：插件后端把 43555 写进 .run/server.port，独立站点 start 误报
    「端口 43555 已被占用」，实际 4601 空闲。"""
    return probe_port(PORT)


def cmd_start():
    """启动：已运行则幂等返回；端口被占（无 PID 文件）报错；否则构建 + 拉起 +
    探活等待。server 以脱离本进程的方式后台运行，日志追加写 .run/server.log。"""
    pid = read_pid()
    if pid:
        print(f"已在运行 (PID {pid}, 端口 {PORT})")
        return
    if start_port_taken():
        print_err(f"错误: 端口 {PORT} 已被占用(可能是手动启动的服务, "
                  f"未找到 PID 文件 {PID_FILE})")
        sys.exit(1)
    if BACKEND not in ("node", "python"):
        print_err(f"错误: TS_BACKEND 只支持 node / python（当前: {BACKEND}）")
        sys.exit(1)
    if BACKEND == "python":
        precheck_deps()
    else:
        require_node()
    cmd_build()
    os.makedirs(RUN_DIR, exist_ok=True)
    # 清掉上一实例/插件形态留下的端口标记：启动等待探活只认本实例随后写入的值
    try:
        os.remove(PORT_FILE)
    except OSError:
        pass
    if BACKEND == "python":
        cmd = [sys.executable, os.path.join(ROOT, "backend_py", "server.py"),
               "--port", str(PORT), "--host", HOST]
    else:
        # 独立站点不传 --trust-internal-user / --parent-watch：
        # 前者是 admin 后门（只允许插件反代），后者是 dsh 子进程的父死感知。
        cmd = [find_node(), os.path.join(ROOT, "backend", "server.js"),
               "--port", str(PORT), "--host", HOST,
               "--web-dir", os.path.join(ROOT, "webui", "dist")]
    env = dict(os.environ, PYTHONUTF8="1")  # 统一 server 及其子进程的文本编码
    with open(LOG_FILE, "ab") as logf:
        if platcompat.IS_WINDOWS:
            # DETACHED_PROCESS：脱离控制台（stdout 已重定向到日志文件）；
            # CREATE_NEW_PROCESS_GROUP：与本控制台 Ctrl+C 隔离
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=logf, stderr=subprocess.STDOUT,
                creationflags=subprocess.DETACHED_PROCESS
                | subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=logf, stderr=subprocess.STDOUT,
                start_new_session=True)
    with open(PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(proc.pid))
    waited = 0
    while not probe():
        # 进程已死（端口被占/启动崩溃/Node 版本不满足）时立即报错，
        # 不白等满 PROBE_TIMEOUT 才从日志里看到原因。
        if proc.poll() is not None:
            print_err(f"错误: 后端启动后立即退出 (exit={proc.returncode}), 日志尾部:")
            print_err(log_tail())
            try:
                os.remove(PID_FILE)
            except OSError:
                pass
            sys.exit(1)
        time.sleep(1)
        waited += 1
        if waited >= PROBE_TIMEOUT:
            print_err(f"错误: 启动探活超时({PROBE_TIMEOUT}s), 日志尾部:")
            print_err(log_tail())
            try:
                os.remove(PID_FILE)
            except OSError:
                pass
            sys.exit(1)
    sport = actual_port() or PORT  # server 可能已自动顺延，展示实际端口
    print(f"已启动 (PID {proc.pid}, 端口 {sport})")
    print(f"访问: http://127.0.0.1:{sport}/  日志: {os.path.relpath(LOG_FILE, ROOT)}")


def cmd_stop():
    """停止：POSIX SIGTERM 宽限 STOP_TIMEOUT 秒后升级 SIGKILL；Windows 直接
    TerminateProcess（无优雅信号）。server 强杀后其托管实例由 Job Object
    （platcompat.keep_with_parent）随内核终止，无孤儿残留。"""
    pid = read_pid()
    if not pid:
        print("未运行")
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass  # 已死：走下方等待/清理
    waited = 0
    while platcompat.pid_alive(pid) and waited < STOP_TIMEOUT:
        time.sleep(1)
        waited += 1
    if platcompat.pid_alive(pid):
        if not platcompat.IS_WINDOWS:  # Windows os.kill 即强杀，无升级空间
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        print(f"进程未响应 SIGTERM, 已强制终止 (PID {pid})")
        time.sleep(0.5)  # 等内核回收进程, 避免 restart 立即 start 撞上垂死进程
    else:
        print(f"已停止 (PID {pid})")
    try:
        os.remove(PID_FILE)
    except OSError:
        pass
    try:
        os.remove(PORT_FILE)  # 实际端口标记随实例一起清理
    except OSError:
        pass


def cmd_status():
    """运行状态：PID 文件有效且进程存活即运行中。"""
    pid = read_pid()
    if pid:
        print(f"运行中 (PID {pid}, 端口 {actual_port() or PORT})")
    else:
        print("已停止")


# ---------- 测试三档（2026-09-13 批次） ----------


def require_pytest():
    """pytest 可用性预检：本解释器（sys.executable，测试即用它）缺 pytest 时
    给出可执行的修复提示，避免难懂的 import 报错。"""
    try:
        import pytest  # noqa: F401
    except ImportError:
        print_err(f"错误: 当前解释器无法导入 pytest（{sys.executable}）")
        print_err("请用项目 Python 环境运行 touchstone.py（如 conda my_pyenv）")
        sys.exit(1)


# vitest 包入口（前端单测直连它，不经 node_modules/.bin 的 bin 链接；原因见下）
VITEST_ENTRY = os.path.join("node_modules", "vitest", "vitest.mjs")


def frontend_test_ready():
    """前端单测存在性：webui 配了 test script、且 vitest 包入口在（node_modules 已装）才跑。

    探测**包入口文件**而非只看 node_modules 目录：本仓库 webui/node_modules 是从
    Windows 侧拷贝进来的，npm 建的 bin 符号链接被展平成同名文件拷贝
    （`.bin/vitest` 内容就是 `vitest.mjs`），其相对导入 `./dist/cli.js` 从 `.bin/`
    解析必然 ERR_MODULE_NOT_FOUND —— 入口在即前端单测环境可用。
    """
    if not os.path.isfile(os.path.join(ROOT, "webui", VITEST_ENTRY)):
        return False
    pkg = os.path.join(ROOT, "webui", "package.json")
    try:
        with open(pkg, encoding="utf-8") as f:
            return "test" in (json.load(f).get("scripts") or {})
    except (OSError, ValueError):
        return False


def cmd_test():
    """快层：后端单测（pytest）+ 前端单测（vitest，存在则跑）。"""
    require_pytest()
    print("==> 后端单测 (pytest tests/)")
    r = subprocess.run([sys.executable, "-m", "pytest", "tests/", "-q"], cwd=ROOT)
    if r.returncode != 0:
        sys.exit(r.returncode)
    if frontend_test_ready():
        # 直连 vitest 包入口，不经 node_modules/.bin：bin 链接在本仓库会被展平成
        # 同名文件拷贝（相对导入从 .bin/ 解析必失败）；与 package.json 里
        # dev/build 直连 node_modules/vite/bin/vite.js 同一路数，且与 touchstone.sh 对齐
        print("==> 前端单测 (vitest)")
        r = subprocess.run([find_node(), VITEST_ENTRY, "run"],
                           cwd=os.path.join(ROOT, "webui"))
        if r.returncode != 0:
            sys.exit(r.returncode)
    else:
        print("(跳过前端单测: webui 无 test script 或 vitest 未安装)")


def cmd_test_full():
    """快层 + 隔离实例 e2e 脚本（自起临时实例，无需站点）。

    e2e 脚本不随公开发布分发：缺失的脚本打印提示后跳过，一个都不在时整档
    跳过并提示；私有开发仓里脚本齐全，行为不变。
    """
    cmd_test()
    if not os.path.isfile(os.path.join(ROOT, "webui", "dist", "index.html")):
        print_err("错误: 缺少 webui/dist（隔离实例 server 需要静态页），"
                  "先执行 python touchstone.py build")
        sys.exit(1)
    ran = 0
    for name in ("e2e_board_continue.py", "e2e_board_stream.py", "e2e_chat_queue.py",
                 "e2e_unit_state.py", "e2e_stress_case.py", "e2e_board_archive.py",
                 "e2e_board_worktree.py", "e2e_ext_stale_recovery.py",
                 "e2e_subagent_no_occupancy.py"):
        script = os.path.join(ROOT, "tests", name)
        if not os.path.isfile(script):
            print(f"(跳过: 未随附 tests/{name})")
            continue
        print(f"==> 隔离实例 e2e: tests/{name}")
        r = subprocess.run([sys.executable, script], cwd=ROOT)
        if r.returncode != 0:
            sys.exit(r.returncode)
        ran += 1
    if ran == 0:
        print("(本仓未随附隔离实例 e2e 脚本，该档已跳过)")


def cmd_test_ui():
    """Playwright e2e（需站点在跑；只探活提示，不自动重启站点以免打断正在
    使用的环境）。站点实际端口取自 .run/server.port，经 TS_BASE 传给用例。

    只收集实际存在的 e2e 文件（公开仓不带 e2e 脚本）：一个都没有时提示并跳过该档。
    """
    require_pytest()
    if not probe():
        print_err("错误: 站点未运行（本档需要运行中的站点，e2e 会操作真实数据）")
        print_err("先执行 python touchstone.py start（改了代码用 restart 加载最新代码）后重试")
        sys.exit(1)
    base = f"http://127.0.0.1:{actual_port() or PORT}"
    files = [f"tests/{name}" for name in
             ("e2e_board_enhance.py", "e2e_board_quickadd_skill.py",
              "e2e_board_unread.py",
              "e2e_session_dialog.py", "e2e_session_scroll.py",
              "e2e_personalize.py", "e2e_project_dialog.py",
              "e2e_settings.py", "e2e_tabbar.py")
             if os.path.isfile(os.path.join(ROOT, "tests", name))]
    if not files:
        print("(本仓未随附 Playwright e2e 脚本，该档已跳过)")
        return
    print(f"==> Playwright e2e (站点 {base})")
    env = dict(os.environ, TS_BASE=base)
    r = subprocess.run([sys.executable, "-m", "pytest", *files, "-v"],
                       cwd=ROOT, env=env)
    if r.returncode != 0:
        sys.exit(r.returncode)


def main():
    actions = {"start": cmd_start, "stop": cmd_stop, "restart": None,
               "status": cmd_status, "build": cmd_build,
               "test": cmd_test, "test-full": cmd_test_full, "test-ui": cmd_test_ui}
    act = sys.argv[1] if len(sys.argv) > 1 else ""
    if act == "restart":
        cmd_stop()
        cmd_start()
    elif act in actions:
        actions[act]()
    else:
        print_err(f"用法: {os.path.basename(sys.argv[0])} "
                  "{start|stop|restart|status|build|test|test-full|test-ui}")
        sys.exit(2)


if __name__ == "__main__":
    main()
