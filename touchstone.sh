#!/usr/bin/env bash
# Touchstone 站点启停与测试脚本：start / stop / restart / status / build / test / test-full / test-ui
# start / restart 会先执行前端构建再启动（两步全按需：npm install 依赖指纹未变
# 则跳过，TS_FORCE_INSTALL=1 强制重装；npm run build 源码指纹未变化且 dist 在
# 则跳过，TS_FORCE_BUILD=1 强制重建），保证 webui/dist 与源码一致
# （dist 不入库，部署机需装 Node）
# 用法: ./touchstone.sh start|stop|restart|status|build|test|test-full|test-ui
# 监听: 默认 127.0.0.1:4601（仅本机）；环境变量 TS_PORT / TS_HOST 覆盖
#       （对外监听: TS_HOST=0.0.0.0）；server.py 绑定失败会自动 port+1 顺延
# 运行产物: .run/server.pid（PID 文件）、.run/server.log（追加写日志）、
#           .run/server.port（server.py 落盘的实际监听端口，探活与展示按它读取）
# 测试三档（2026-09-13 批次，细节见 tests/README.md）:
#   test      快层：后端单测 pytest（~2s）+ 前端单测 vitest（webui 配置后自动纳入）
#   test-full 快层 + 隔离实例 e2e 脚本（自起临时实例，无需站点，分钟级）
#   test-ui   Playwright e2e（需站点在跑；只探活提示，不自动重启站点）
# Python 解析: 默认 python3；项目环境不在默认 PATH 时用环境变量 TS_PYTHON 指定

set -u

# 固定到脚本所在目录，保证从任意路径调用都正确
cd "$(dirname "$0")" || exit 1

PORT="${TS_PORT:-4601}"
HOST="${TS_HOST:-127.0.0.1}"   # 监听地址: 默认仅本机回环, 对外监听显式 TS_HOST=0.0.0.0
RUN_DIR=".run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
PORT_FILE="$RUN_DIR/server.port"
PROBE_TIMEOUT=20   # 启动探活超时（秒；server 初始化含 feishu 入站连接可超 10s）
STOP_TIMEOUT=5     # SIGTERM 后等待退出的超时（秒）

# 站点启动与测试命令共用的 python：默认 python3；项目环境不在默认 PATH 时用 TS_PYTHON 指定
PY="${TS_PYTHON:-python3}"

# 打印用法并返回错误码
usage() {
    echo "用法: $0 {start|stop|restart|status|build|test|test-full|test-ui}" >&2
    exit 2
}

# 判断进程是否存活（参数: PID）
is_alive() {
    local pid="$1"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# 读取 PID 文件: 进程存活则输出 PID 并返回 0;
# 文件不存在或为残留(进程已死)则清理文件并返回 1
read_pid() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if is_alive "$pid"; then
        echo "$pid"
    else
        rm -f "$PID_FILE"
        return 1
    fi
}

# server.py 落盘的实际监听端口: 绑定失败自动顺延后与 PORT 不同, 探活与展示
# 须跟着新端口; 文件缺失/内容非法回退 PORT
actual_port() {
    local p
    p="$(cat "$PORT_FILE" 2>/dev/null)"
    case "$p" in
        ''|*[!0-9]*) echo "$PORT" ;;
        *)           echo "$p" ;;
    esac
}

# 探活: 对本地端口发 HTTP 请求, 收到任何响应(含 302/200)即视为服务在
probe() {
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$(actual_port)/"
}

# 运行依赖预检: 解释器须能导入 requirements.txt 声明的运行依赖, 缺失时秒级报错
# (否则 server 启动即崩, 要等 20s 探活超时才能从日志尾部看到 ModuleNotFoundError)
require_runtime_deps() {
    if ! "$PY" -c "import zstandard, requests, lark_oapi, psutil" >/dev/null 2>&1; then
        echo "错误: $PY 缺少运行依赖(zstandard / requests / lark_oapi / psutil)" >&2
        echo "先安装: $PY -m pip install -r requirements.txt" >&2
        echo "或指定项目环境启动: TS_PYTHON=<项目环境解释器> $0 start" >&2
        exit 1
    fi
}

cmd_start() {
    # 已在运行(PID 文件有效)则直接返回
    if pid="$(read_pid)"; then
        echo "已在运行 (PID $pid, 端口 $(actual_port))"
        exit 0
    fi
    # 端口被占且无 PID 文件: 可能是手动启动的进程
    if probe; then
        echo "错误: 端口 $(actual_port) 已被占用(可能是手动启动的服务, 未找到 PID 文件 $PID_FILE)" >&2
        exit 1
    fi
    # 运行依赖预检放在构建之前: 缺依赖时不必等前端构建白跑
    require_runtime_deps
    # 前置构建前端: dist 不入库, 启动时重建保证与源码一致(部署机需 Node);
    # 任一步失败即中止启动(server.py 无 dist 会直接退出)
    cmd_build
    mkdir -p "$RUN_DIR"
    # nohup 后台启动(用 $PY, 兑现 TS_PYTHON 对 start 生效), 日志追加写
    nohup "$PY" server.py --port "$PORT" --host "$HOST" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    # 探活等待启动完成
    local waited=0
    while ! probe; do
        sleep 1
        waited=$((waited + 1))
        if [ "$waited" -ge "$PROBE_TIMEOUT" ]; then
            echo "错误: 启动探活超时(${PROBE_TIMEOUT}s), 日志尾部:" >&2
            tail -n 10 "$LOG_FILE" >&2
            rm -f "$PID_FILE"
            exit 1
        fi
    done
    echo "已启动 (PID $(cat "$PID_FILE"), 端口 $(actual_port))"
    echo "访问: http://127.0.0.1:$(actual_port)/  日志: $LOG_FILE"
}

cmd_stop() {
    # 注意用 return 而非 exit: restart 会先调用本函数, exit 会终止整个脚本
    if ! pid="$(read_pid)"; then
        echo "未运行"
        return 0
    fi
    kill "$pid" 2>/dev/null
    local waited=0
    while is_alive "$pid" && [ "$waited" -lt "$STOP_TIMEOUT" ]; do
        sleep 1
        waited=$((waited + 1))
    done
    if is_alive "$pid"; then
        kill -9 "$pid" 2>/dev/null
        echo "进程未响应 SIGTERM, 已 SIGKILL (PID $pid)"
        # 等内核回收进程, 避免 restart 立即 start 撞上垂死进程
        sleep 0.5
    else
        echo "已停止 (PID $pid)"
    fi
    rm -f "$PID_FILE"
    rm -f "$PORT_FILE"  # 实际端口标记随实例一起清理
}

cmd_status() {
    if pid="$(read_pid)"; then
        echo "运行中 (PID $pid, 端口 $(actual_port))"
    else
        echo "已停止"
    fi
}

# webui 安装指纹戳文件: 记录上次 npm install 成功时的依赖清单指纹
# (置于 node_modules 下, node_modules 被删时戳随之消失, 下次自然重装)
NPM_STAMP_FILE="webui/node_modules/.touchstone-install-stamp"

# webui 依赖清单指纹: package.json + package-lock.json 字节顺序拼接的 md5
# (与 touchstone.py 的 deps_fingerprint 同算法, 戳文件两启动器互通;
# 清单全缺返回空串, 与 py 侧行为一致)
webui_deps_fingerprint() {
    if [ ! -f webui/package.json ] && [ ! -f webui/package-lock.json ]; then
        echo ""
        return
    fi
    cat webui/package.json webui/package-lock.json 2>/dev/null | md5sum | cut -d' ' -f1
}

# 是否需要 npm install: TS_FORCE_INSTALL=1 强制 / node_modules 缺失 /
# 指纹戳缺失或不一致(依赖变更)时需要(返回 0), 否则跳过
npm_install_needed() {
    [ "${TS_FORCE_INSTALL:-0}" = "1" ] && return 0
    [ -d webui/node_modules ] || return 0
    [ -f "$NPM_STAMP_FILE" ] || return 0
    [ "$(cat "$NPM_STAMP_FILE" 2>/dev/null)" != "$(webui_deps_fingerprint)" ]
}

# 构建指纹戳文件: 记录上次 npm run build 成功时的前端源码指纹
# (置于 webui/dist 下, dist 被删时戳随之消失, 下次自然重建)
BUILD_STAMP_FILE="webui/dist/.touchstone-build-stamp"

# webui 构建源码指纹: src 树全部文件 + 顶层构建配置(components.json/index.html/
# package.json/vite.config.js, 存在才算入), 按 webui 相对路径排序后以「路径行 +
# 文件字节」顺序拼接的 md5 (与 touchstone.py 的 build_fingerprint 同算法, 戳文件
# 两启动器互通; 全缺返回空串, 与 py 侧行为一致)
webui_build_fingerprint() {
    local files f
    # 文件清单在 webui 内收集(子壳 cd 只影响 $() 内部), 缺 webui 视为空串
    if ! files="$(cd webui 2>/dev/null && {
        [ -d src ] && find src -type f
        for f in components.json index.html package.json vite.config.js; do
            [ -f "$f" ] && printf '%s\n' "$f"
        done
    } | LC_ALL=C sort)"; then
        echo ""
        return
    fi
    [ -n "$files" ] || { echo ""; return; }
    # 路径行 + 内容字节的拼接同样必须在 webui 内 cat(相对路径), 再整体 md5
    (
        cd webui || exit 1
        printf '%s\n' "$files" | while IFS= read -r f; do
            printf '%s\n' "$f"
            cat "$f"
        done
    ) | md5sum | cut -d' ' -f1
}

# 是否需要 npm run build: TS_FORCE_BUILD=1 强制 / dist 缺失 / npm install 将执行
# (依赖变更/强制重装/目录缺失, 旧 dist 不再可信) / 源码指纹戳缺失或不一致
# (前端源码变更)时需要(返回 0), 否则跳过
build_needed() {
    [ "${TS_FORCE_BUILD:-0}" = "1" ] && return 0
    [ -f webui/dist/index.html ] || return 0
    npm_install_needed && return 0
    [ -f "$BUILD_STAMP_FILE" ] || return 0
    [ "$(cat "$BUILD_STAMP_FILE" 2>/dev/null)" != "$(webui_build_fingerprint)" ]
}

cmd_build() {
    # 前端构建: npm install 按需(依赖指纹未变则跳过) + npm run build 按需
    # (源码指纹未变且 dist 在则跳过), 任一步失败即停
    if npm_install_needed; then
        echo "==> npm install"
        (cd webui && npm install) || { echo "错误: npm install 失败" >&2; exit 1; }
        webui_deps_fingerprint > "$NPM_STAMP_FILE"
    else
        echo "==> npm install（跳过: 依赖未变化, TS_FORCE_INSTALL=1 可强制重装）"
    fi
    if build_needed; then
        echo "==> npm run build"
        (cd webui && npm run build) || { echo "错误: npm run build 失败" >&2; exit 1; }
        # 产物校验: dist 缺 index.html 视为构建无效
        if [ ! -f "webui/dist/index.html" ]; then
            echo "错误: 构建完成但未找到 webui/dist/index.html" >&2
            exit 1
        fi
        webui_build_fingerprint > "$BUILD_STAMP_FILE"
    else
        echo "==> npm run build（跳过: 前端源码未变化, TS_FORCE_BUILD=1 可强制重建）"
    fi
    echo "构建完成: webui/dist"
}

# ---------- 测试三档（2026-09-13 批次） ----------

# pytest 可用性预检: 不可用时给出可执行的修复提示(避免难懂的 import 报错)
require_pytest() {
    if ! "$PY" -c "import pytest" >/dev/null 2>&1; then
        echo "错误: $PY 无法导入 pytest" >&2
        echo "请使用项目 Python 环境(如 conda activate my_pyenv), 或用 TS_PYTHON 指定解释器" >&2
        exit 1
    fi
}

# 前端单测存在性: webui 配了 test script、且 vitest 包入口在(即 node_modules 已装)才跑
# 探测包入口而非只看 node_modules 目录: 本仓库 node_modules 是从 Windows 侧拷贝来的,
# npm 建的 bin 符号链接被展平成同名文件拷贝(.bin/vitest 内容就是 vitest.mjs),
# 其相对导入 './dist/cli.js' 从 .bin/ 解析必失败 ERR_MODULE_NOT_FOUND
frontend_test_ready() {
    grep -q '"test"' webui/package.json 2>/dev/null \
        && [ -f webui/node_modules/vitest/vitest.mjs ]
}

# 快层: 后端单测 + 前端单测(存在则跑)
cmd_test() {
    require_pytest
    echo "==> 后端单测 (pytest tests/)"
    "$PY" -m pytest tests/ -q || exit 1
    if frontend_test_ready; then
        # 直连 vitest 包入口, 不经 node_modules/.bin 的 bin 链接(理由见 frontend_test_ready):
        # 与 package.json 里 dev/build 直连 node_modules/vite/bin/vite.js 同一路数
        echo "==> 前端单测 (vitest)"
        (cd webui && node node_modules/vitest/vitest.mjs run) || exit 1
    else
        echo "(跳过前端单测: webui 无 test script 或 vitest 未安装)"
    fi
}

# 快层 + 隔离实例 e2e 脚本(自起临时实例, 无需站点)
# e2e 脚本不随公开发布分发: 缺失的脚本打印提示后跳过, 一个都不在时整档跳过并提示
cmd_test_full() {
    cmd_test
    if [ ! -f webui/dist/index.html ]; then
        echo "错误: 缺少 webui/dist(隔离实例 server 需要静态页), 先执行 ./touchstone.sh build" >&2
        exit 1
    fi
    local f ran=0
    for f in tests/e2e_board_continue.py tests/e2e_board_stream.py tests/e2e_chat_queue.py tests/e2e_unit_state.py tests/e2e_stress_case.py tests/e2e_board_archive.py tests/e2e_board_worktree.py tests/e2e_ext_stale_recovery.py tests/e2e_subagent_no_occupancy.py; do
        if [ ! -f "$f" ]; then
            echo "(跳过: 未随附 $f)"
            continue
        fi
        echo "==> 隔离实例 e2e: $f"
        "$PY" "$f" || exit 1
        ran=$((ran + 1))
    done
    if [ "$ran" -eq 0 ]; then
        echo "(本仓未随附隔离实例 e2e 脚本, 该档已跳过)"
    fi
    return 0
}

# Playwright e2e(需站点在跑; 只探活提示, 不自动重启站点以免打断正在使用的环境)
cmd_test_ui() {
    require_pytest
    if ! probe; then
        echo "错误: 站点未运行(本档需要运行中的站点, e2e 会操作真实数据)" >&2
        echo "先执行 ./touchstone.sh start(改了代码用 restart 加载最新代码)后重试" >&2
        exit 1
    fi
    local base="http://127.0.0.1:$(actual_port)"
    # 只收集实际存在的 e2e 文件(公开仓不带 e2e 脚本): 一个都没有时提示并跳过该档
    local files="" f
    for f in tests/e2e_board_enhance.py tests/e2e_board_quickadd_skill.py \
             tests/e2e_board_unread.py \
             tests/e2e_session_dialog.py tests/e2e_session_scroll.py \
             tests/e2e_personalize.py tests/e2e_project_dialog.py \
             tests/e2e_settings.py tests/e2e_tabbar.py; do
        [ -f "$f" ] && files="$files $f"
    done
    if [ -z "$files" ]; then
        echo "(本仓未随附 Playwright e2e 脚本, 该档已跳过)"
        return 0
    fi
    echo "==> Playwright e2e (站点 $base)"
    TS_BASE="$base" "$PY" -m pytest $files -v
}

case "${1:-}" in
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_stop; cmd_start ;;
    status)    cmd_status ;;
    build)     cmd_build ;;
    test)      cmd_test ;;
    test-full) cmd_test_full ;;
    test-ui)   cmd_test_ui ;;
    *)         usage ;;
esac
