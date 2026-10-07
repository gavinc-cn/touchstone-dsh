#!/usr/bin/env bash
# Touchstone dsh 插件安装（幂等, 可重复执行）:
#  1) 前置检查 dist-plugin 构建产物（缺失时尝试 npm run build:plugin）
#  2) dsh plugin add 本仓库 dsh-plugin 包（file: 协议＝打包拷贝进 ~/.dsh/profiles/<profile>/node_modules）
#  3) 把包名选进 profile 的 dsh.profile.bundles（scripts/select-bundle.mjs, 幂等）
#  4) 提示重启 dsh web / 在侧栏 Plugins 面板里开关
#
# 为什么第 3 步是「选 bundle」而不是「手写 patch insert」（2026-10-02 变更）:
#   组合行已随包下发（包内 cordis.patch.yml, 由 package.json 的 dsh.bundle.patch 指向）——
#   只有这样 dsh 的 Plugins 面板才会把该行渲染成可开关的开关（dsh-plugin-manager 的
#   declaredRows(): 包未声明 dsh.bundle.patch 时 rows 为空, 手写 insert 进 profile patch
#   在面板里既没有行也没有开关）。旧的「向 profile cordis.patch.yml 追加 insert」已废弃;
#   存量 profile 若还留着那条 insert, 请手工删除（同 id 两行会让面板行开关锁成 unaddressable）。
#
# 机器相关配置（repoDir / pythonPath）不由本脚本写入, 而是在 profile 的 cordis.patch.yml 里覆盖
# （覆盖是整键替换; 缺 repoDir 时薄壳只 warn 并跳过启动）:
#   - id: touchstone
#     config:
#       repoDir: <Touchstone 仓库根>
#       pythonPath: <解释器>
# 环境变量: TS_DSH_PROFILE(默认 web) / TS_DSH_PYTHON(显式指定解释器, 优先)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${TS_DSH_PROFILE:-web}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"

# 解释器探测链（2026-10-02 去硬编码，原写死某个 conda 环境的解释器绝对路径）:
#   TS_DSH_PYTHON / TS_PYTHON 显式指定 → 常见 conda 环境 → PATH 上的 python3 → 报错;
#   conda/PATH 候选里优先「能导入运行依赖（zstandard/requests）」的那个, 避免选中
#   同机其他缺依赖的环境; 全都不满足时回落到首个存在的解释器。
_depline() { "$1" -c 'import zstandard, requests' >/dev/null 2>&1; }

pick_python() {
  local cand fallback=""
  for cand in "${TS_DSH_PYTHON:-}" "${TS_PYTHON:-}"; do
    [[ -n "$cand" && -x "$cand" ]] && { echo "$cand"; return 0; }
  done
  for cand in "$HOME"/{mini,ana}conda3/envs/*/bin/python3 \
              /opt/{mini,ana}conda3/envs/*/bin/python3 \
              "$(command -v python3 || true)"; do
    [[ -n "$cand" && -x "$cand" ]] || continue
    [[ -n "$fallback" ]] || fallback="$cand"
    _depline "$cand" && { echo "$cand"; return 0; }
  done
  [[ -n "$fallback" ]] && { echo "$fallback"; return 0; }
  return 1
}
PYTHON_PATH="$(pick_python)" || {
  echo "错误: 未找到可用的 python3；请用 TS_DSH_PYTHON=/path/to/python3 显式指定" >&2
  exit 1
}

[[ -d "$PROFILE_DIR" ]] || { echo "错误: profile 不存在: $PROFILE_DIR（先用 dsh web 初始化）"; exit 1; }
if [[ ! -f "$REPO_DIR/webui/dist-plugin/index.html" ]]; then
  echo "dist-plugin 缺失, 尝试构建..."
  (cd "$REPO_DIR/webui" && npm run build:plugin) \
    || { echo "错误: 自动构建失败（先: cd webui && npm install && npm run build:plugin）"; exit 1; }
fi

# 1) 插件包安装（dsh plugin 转发 pnpm; 本机 pnpm 未直装时经 corepack 提供）
#    file: 协议=打包拷贝为真实目录（裸路径会被 pnpm 以 link: 符号链接接入, 与 kanban 形态不符）
command -v pnpm >/dev/null 2>&1 || corepack enable pnpm
dsh plugin --profile "$PROFILE" add "file:$REPO_DIR/dsh-plugin"

# 2) 选 bundle（幂等）: 包名进 dsh.profile.bundles, 否则包内 cordis.patch.yml 这一层不会被加载。
#    用 node 改 JSON（node 是 dsh 自身硬依赖; Windows git-bash 下也有）, 写法与 dsh 的
#    writeProfileManifest 一致（2 空格 JSON + 尾换行）。
node "$REPO_DIR/dsh-plugin/scripts/select-bundle.mjs" "$PROFILE_DIR/package.json"

echo "完成。重启 dsh web 生效（package.json 变更 dsh-hmr 也会热重载）;"
echo "之后侧栏 Plugins 面板里会出现 Touchstone 卡片与该行开关。"
echo "若插件要指向本机仓库, 在 $PROFILE_DIR/cordis.patch.yml 里加:"
echo "  - id: touchstone"
echo "    config: { repoDir: $REPO_DIR, pythonPath: $PYTHON_PATH }"
