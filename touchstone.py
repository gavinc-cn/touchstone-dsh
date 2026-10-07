#!/usr/bin/env python3
"""Touchstone 跨平台启停器：start / stop / restart / status / build / test / test-full / test-ui。

Windows 原生运行的首选入口（bash/nohup/kill 不可用），Linux 上与 touchstone.sh 等价
（touchstone.sh 保留为 Linux 惯用入口，两者命令面与运行产物一致：.run/server.pid、
.run/server.log）。用法:

    python3 touchstone.py start|stop|restart|status|build|test|test-full|test-ui
    # Windows: python touchstone.py 或 touchstone.cmd

行为对齐 touchstone.sh:
- start / restart 先按需构建前端（npm install 按需：依赖指纹未变化则跳过，
  TS_FORCE_INSTALL=1 强制重装；npm run build 按需：源码指纹未变化且 dist 在
  则跳过，TS_FORCE_BUILD=1 强制重建；无 dist 则 server.py 直接退出），
  任一步失败即中止启动；
- start 前做运行依赖预检（zstandard/requests 顶层导入，缺失即启动崩）；
- 后台拉起 server.py：POSIX start_new_session 脱离本进程组、Windows
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

import platcompat

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("TS_PORT", "4601"))
HOST = os.environ.get("TS_HOST", "127.0.0.1")  # 监听地址: 默认仅本机回环, 对外监听显式 TS_HOST=0.0.0.0
RUN_DIR = os.path.join(ROOT, ".run")
PID_FILE = os.path.join(RUN_DIR, "server.pid")
LOG_FILE = os.path.join(RUN_DIR, "server.log")
PORT_FILE = os.path.join(RUN_DIR, "server.port")  # server.py 落盘的实际监听端口
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


def probe():
    """对本地端口发 HTTP 请求：任何响应（含 302/401）即视为服务在。

    端口优先取 server.py 落盘的实际监听端口（server 绑定失败会自动 port+1
    顺延，启动器须跟着探新端口），无落盘时回退 TS_PORT/默认端口。"""
    port = actual_port() or PORT
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2)
        return True
    except urllib.error.HTTPError:
        return True   # 有 HTTP 响应即活（401 登录墙/302 跳转都算）
    except Exception:
        return False


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
        print_err(f"错误: python3 缺少运行依赖（{e}），请先执行:")
        print_err("    python3 -m pip install -r requirements.txt")
        sys.exit(1)


def find_npm():
    """定位 npm（Windows 下为 npm.cmd，shutil.which 按 PATHEXT 命中）。"""
    npm = shutil.which("npm")
    if not npm:
        print_err("错误: 未找到 npm（前端构建需要 Node.js）")
        sys.exit(1)
    return npm


def find_node():
    """定位 node（跑 vitest 包入口用；Windows 下为 node.exe）。"""
    node = shutil.which("node")
    if not node:
        print_err("错误: 未找到 node（前端单测需要 Node.js）")
        sys.exit(1)
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


def cmd_start():
    """启动：已运行则幂等返回；端口被占（无 PID 文件）报错；否则构建 + 拉起 +
    探活等待。server 以脱离本进程的方式后台运行，日志追加写 .run/server.log。"""
    pid = read_pid()
    if pid:
        print(f"已在运行 (PID {pid}, 端口 {PORT})")
        return
    if probe():
        print_err(f"错误: 端口 {actual_port() or PORT} 已被占用(可能是手动启动的服务, "
                  f"未找到 PID 文件 {PID_FILE})")
        sys.exit(1)
    precheck_deps()
    cmd_build()
    os.makedirs(RUN_DIR, exist_ok=True)
    cmd = [sys.executable, os.path.join(ROOT, "server.py"),
           "--port", str(PORT), "--host", HOST]
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
                 "e2e_board_worktree.py"):
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
