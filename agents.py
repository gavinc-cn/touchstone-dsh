#!/usr/bin/env python3
"""Touchstone 本机 AI CLI 扫描：供项目配置"智能体路径"下拉选择。

扫描顺序：PATH（shutil.which）→ 常见安装目录，找到即止；版本探测 --version 2s 超时。
"""

import glob
import os
import re
import shutil
import subprocess
import tempfile

# 支持的 agent 清单: (展示名, 可能的可执行名元组)。
# 2026-10-03（P7b 退场删除，B1）：产品入口收敛为 **dsh 插件形态**，kimi / opencode /
# claude / hermes 四个 CLI 条目不再扫描（对应族已删除）；dsh 可执行仍扫——它是
# 「插件·进程内」条目的 path/version 来源。
# 2026-10-04（B7）：扫描结果只剩「插件·进程内」一条（见 scan_agents），本表的展示名
# 自此仅作文档用，实际用于定位 dsh 可执行（PATH → 常见安装目录）。
AGENT_DEFS = (
    ("dsh（DeepSeek Harness）", ("dsh",)),
)

# 退场族的旧虚拟条目前缀（kimi web / opencode serve 驱动，P7b 删除）：扫描不再产出，
# 仅「存量 agent_path 的归族」仍要认出来 —— 归 RETIRED_FAMILY 由起跑处给明确报错。
LEGACY_WEB_PREFIXES = ("kimi-web:", "opencode-web:")

# 退场族标记（P7b，2026-10-03）：agent_path 仍是旧族可执行名或旧虚拟前缀时归此族。
# 存量库里的绑定由 migrate_p7b.py 改写（`dsh-plugin:<dsh 路径>` 或空串）；未改写前
# 起跑处据此返回 RETIRED_MSG，而不是静默按 dsh 跑（dsh 宿主里没有旧会话）或
# AttributeError（驱动模块已删）。
RETIRED_FAMILY = "retired"
RETIRED_MSG = "该智能体族已下线，请在项目设置里改绑 dsh 插件"

# dsh 插件驱动前缀（路线 A）：项目 agent_path 存 "dsh-plugin:" 表示走 **dsh 宿主进程内**
# 的 agent 运行时（dsh-plugin/lib/agent-driver.js 持有的会话池），不再 spawn
# `dsh --profile headless` 子进程。前缀后可跟任意提示串（如 dsh 可执行路径）但平台不使用：
# 驱动地址经环境变量 TS_AGENT_DRIVER_URL 下发（见 dshdriver.py），不依赖本机路径。
DSH_PLUGIN_PREFIX = "dsh-plugin:"

# 「插件·进程内」条目展示名（前端「智能体」下拉的唯一选项）。P7b B7（2026-10-04）
# 起由 scan_agents 直接产出为**唯一一条**，裸 dsh CLI 行不再返回（见 scan_agents docstring）。
PLUGIN_ENTRY_NAME = "dsh（插件·进程内）"

# PATH 之外常出现的安装目录（按已知部署习惯）
EXTRA_DIRS = [
    "/usr/local/bin",
    os.path.expanduser("~/.local/bin"),
    "/bin/versions/node",
    os.path.expanduser("~/.npm-global/bin"),
]
# Windows：npm 全局 shim（kimi.cmd / claude.cmd 等）所在目录
# （shutil.which 走 PATH 也能命中，此目录兜底 PATH 被裁剪的安装方式）
if os.name == "nt":
    _appdata = os.environ.get("APPDATA")
    if _appdata:
        EXTRA_DIRS.append(os.path.join(_appdata, "npm"))
# 递归进 versions 下各 node 版本的 bin/
VERSIONS_BIN_GLOB = "/bin/versions/node"
# conda/mamba 各虚拟环境的 bin 目录（glob 模式，覆盖常见安装位置；
# 如 hermes 常被装进某个 conda 环境的 bin/）
CONDA_ENV_BIN_GLOBS = [
    "/opt/miniconda3/envs/*/bin",
    "/opt/anaconda3/envs/*/bin",
    os.path.expanduser("~/miniconda3/envs/*/bin"),
    os.path.expanduser("~/anaconda3/envs/*/bin"),
]


def _search_extra(name):
    """在扩展目录中查找 name 可执行文件，返回路径或 None。"""
    candidates = []
    for d in EXTRA_DIRS:
        if not os.path.isdir(d):
            continue
        if d == VERSIONS_BIN_GLOB:
            for ver in os.listdir(d):
                candidates.append(os.path.join(d, ver, "bin", name))
        else:
            candidates.append(os.path.join(d, name))
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    # conda/mamba 虚拟环境 bin：glob 展开各环境目录后逐个匹配
    for pat in CONDA_ENV_BIN_GLOBS:
        for bindir in sorted(glob.glob(pat)):
            p = os.path.join(bindir, name)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
    return None


def _probe_version(path):
    """运行 --version（2s 超时），失败返回空串。
    cwd 用系统临时目录（跨平台；原写死 /tmp 在 Windows 不存在会静默失败）。"""
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace",
                             timeout=2, cwd=tempfile.gettempdir())
        text = (out.stdout or out.stderr).strip().splitlines()
        return text[0][:120] if text else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def scan_agents():
    """扫描本机 dsh 可执行，返回**产品入口单条目** [{name, path, version, found}]。

    P7b B1 起扫描只认 dsh；**B7（2026-10-04）再收敛为只回一条**「dsh（插件·进程内）」
    （`path = dsh-plugin:<dsh 路径>`，进程内会话池：多轮续接/插话/实时事件流）。

    为什么仍要定位 dsh 可执行：该条目的 path（前缀后的提示串）与 version 都取自它
    （`--version` 探测）；但**裸 dsh CLI 行不再返回给前端**——它属退场族
    （`agent_family` 对 basename == "dsh" 判 `retired`，起跑处必报 `RETIRED_MSG`），
    列进「智能体」下拉就是纯误选陷阱（用户 2026-10-04 报告「同一个 dsh 出现两条」）。

    dsh 未找到时返回同名的 `found=False` 条目（前端显示「dsh（插件·进程内）未找到」），
    保持「下拉里有且只有这一条」的读侧不变量。
    """
    path = ""
    for _name, bins in AGENT_DEFS:
        for b in bins:
            path = shutil.which(b) or _search_extra(b)
            if path:
                break
        if path:
            break
    return [{"name": PLUGIN_ENTRY_NAME,
             "path": DSH_PLUGIN_PREFIX + path if path else "",
             "version": _probe_version(path) if path else "",
             "found": bool(path)}]


def agent_family(agent_path):
    """归族：只可能返回 `"dsh_plugin"`（可跑）或 `RETIRED_FAMILY`（退场族，起跑处报错）。

    - `dsh-plugin:` 前缀 → `dsh_plugin`：产品唯一入口（dsh 宿主进程内 agent 运行时，
      见 dshdriver.py）。前缀判定必须先于 basename——该串不是有效可执行路径；
    - 空 `agent_path`（db 默认 `''`）与未知可执行名 → `dsh_plugin`：2026-10-03 起
      默认族由 kimi 改为 dsh 插件（产品入口收敛）；
    - kimi / opencode / claude / hermes / deepseek(dsh CLI) 旧可执行名，以及
      `kimi-web:` / `opencode-web:` 两个旧虚拟前缀 → `RETIRED_FAMILY`（P7b 删除的
      五族，2026-10-03）。存量项目由 `migrate_p7b.py` 改写 agent_path；未改写的
      项目在起跑处得到 `RETIRED_MSG` 明确提示。
    """
    ap = (agent_path or "").strip()
    if ap.startswith(DSH_PLUGIN_PREFIX):
        return "dsh_plugin"
    if ap.startswith(LEGACY_WEB_PREFIXES):
        return RETIRED_FAMILY            # kimi-web: / opencode-web:（旧虚拟条目）
    name = os.path.basename(ap).lower()
    if any(h in name for h in ("kimi", "opencode", "claude", "hermes", "deepseek")):
        return RETIRED_FAMILY            # 旧 CLI 族可执行名
    if name == "dsh":
        # dsh CLI（--profile headless）已退场：只保留插件形态（每轮独立会话、无续接）
        return RETIRED_FAMILY
    # 空 agent_path（db 默认 ''）与未知可执行名的默认族：本项目已收敛为「产品入口
    # 只有 dsh 插件形态」（2026-10-03 方案 §七 D1/D2），故默认走 dsh_plugin；
    # 要跑其他族须在项目里显式选。此前默认 "kimi"，会让未配置项目静默按 kimi 跑。
    return "dsh_plugin"


# 各 agent 族的 skill 目录约定（2026-08-31 从各 CLI 安装产物与本机磁盘实况验证，勿凭记忆改）：
# 族 -> (用户级目录元组, 项目级相对目录元组)，SKILL.md 位于各目录的子目录下。
# 产品只剩 dsh 插件一族：`dsh-skill-filesystem` 实测扫描 `<project>/.agents/skills`
# （project-agents）与 `~/.agents/skills`（user-agents），另有 dsh 私有根
# `<project>/.dsh/skills` 与 `~/.dsh/skills`；四者一并扫，与 dsh 侧技能面板看到的一致。
# `builtin_assets` 的清单校验与本表判 `family`，落点取各元组首个目录。
SKILL_DIRS_BY_FAMILY = {
    "dsh_plugin": (("~/.dsh/skills", "~/.agents/skills"),
                   (".dsh/skills", ".agents/skills")),
}
# SKILL.md 相对扫描根的最大目录深度：2 层（分类/技能名，如 <类>/<名>/SKILL.md）
SKILL_WALK_MAX_DEPTH = 2
# SKILL.md frontmatter 的 name/description 行解析（简单 key: value，足够通用格式）
_SKILL_FRONT_RE = re.compile(r"\A---\s*\n(.*?)\n---", re.S)
_SKILL_NAME_RE = re.compile(r"^name:[ \t]*(.+)$", re.M)
_SKILL_DESC_RE = re.compile(r"^description:[ \t]*(.+)$", re.M)
# description 截断长度（避免超长描述撑爆下拉）
_SKILL_DESC_LIMIT = 200


def _parse_skill_md(path, fallback_name):
    """解析一个 SKILL.md 的 frontmatter，返回 (name, description)。

    name 缺省用所在目录名；description 缺省空串（截断到 _SKILL_DESC_LIMIT）；
    文件读失败返回 None，调用方跳过该条。
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(4096)
    except OSError:
        return None
    m = _SKILL_FRONT_RE.match(head)
    body = m.group(1) if m else head  # 无 frontmatter 时退化为头部全文（容错）
    nm = _SKILL_NAME_RE.search(body)
    dm = _SKILL_DESC_RE.search(body)
    return (nm.group(1).strip() if nm else fallback_name,
            dm.group(1).strip()[:_SKILL_DESC_LIMIT] if dm else "")


def _scan_skill_dir(root, source):
    """扫描一个 skill 根目录（深度受限），返回 [{name, description, source}]。

    目录不存在/不可读返回空列表；深度按相对根的目录层数限制
    （SKILL.md 最深位于第 SKILL_WALK_MAX_DEPTH 层）。
    """
    skills = []
    if not root or not os.path.isdir(root):
        return skills
    base_depth = root.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        rel = dirpath.rstrip(os.sep).count(os.sep) - base_depth
        # 只在深度未达上限前继续下钻（SKILL.md 允许出现在 rel <= MAX_DEPTH 层）
        dirnames[:] = [d for d in dirnames if rel < SKILL_WALK_MAX_DEPTH]
        if "SKILL.md" not in filenames:
            continue
        parsed = _parse_skill_md(os.path.join(dirpath, "SKILL.md"),
                                 os.path.basename(dirpath.rstrip(os.sep)))
        if parsed:
            skills.append({"name": parsed[0], "description": parsed[1],
                           "source": source})
    return skills


def scan_skills(agent_path, project_dir=""):
    """列出指定 agent CLI 可用的 skill（用户级 + 项目级），供项目能力下拉。

    目录约定见 SKILL_DIRS_BY_FAMILY（dsh 插件族四目录）；同名 skill 项目级覆盖
    用户级；agent_path 为空（未配置）返回空列表，无目录约定的族返回空。
    返回 [{name, description, source}]，按 name 排序；纯文件扫描不做缓存。
    """
    ap = (agent_path or "").strip()
    if not ap:
        return []
    family = agent_family(ap)
    user_dirs, proj_dirs = SKILL_DIRS_BY_FAMILY.get(family, ((), ()))
    found = {}
    for d in user_dirs:
        for s in _scan_skill_dir(os.path.expanduser(d), "user"):
            found.setdefault(s["name"], s)
    pd = (project_dir or "").strip()
    if pd:
        for d in proj_dirs:
            for s in _scan_skill_dir(os.path.join(pd, d), "project"):
                found[s["name"]] = s  # 项目级覆盖用户级
    return sorted(found.values(), key=lambda s: s["name"])
