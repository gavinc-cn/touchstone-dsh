#!/usr/bin/env python3
"""平台内置资产的清单扫描与安装卸载（skill / dsh_plugin 两类）。

资产清单在平台仓库 `extensions/<资产目录>/asset.json`（清单根可用环境变量
`TS_EXT_DIR` 覆盖，供测试与自定义部署）；每个资产声明：类型、适用族、可安装目标
（用户级/项目级）与落盘文件。本模块负责扫描清单、按「类型 × 目标」推导落点、
判定安装状态与执行安装/卸载。

两类资产（P8，2026-10-04 补第二类）：

- **skill**：纯文件拷贝。落点＝该族技能目录（用户级 `~/.dsh/skills` 或项目级
  `<项目>/.dsh/skills`，取 `SKILL_DIRS_BY_FAMILY` 元组首个目录）。
- **dsh_plugin**：dsh 原生插件包（**手放型**——本机自研插件不在 npm 上、也不声明
  `dsh.bundle`，因此 `dsh plugin add` 这条路不适用，见下）。安装 = ① 把清单文件
  收敛到 `~/.dsh/profiles/node_modules/<package>/`；② 在 profile 的
  `<profiles>/<profile>/cordis.patch.yml` 里确保平台标记的 `insert:` 注册块
  （可选再写一条 `- id: <entry_id>` + `config:` 覆盖块）。只支持用户级（dsh 插件是
  **profile 级**资产，与项目无关）。web profile 声明 `dsh.profile.patchReload: live`
  时改 patch 文件即热生效，否则状态里标 `restart_required` 提示重启 dsh。

  为什么不用 `dsh plugin --profile <p> add`：该子命令只是 pnpm 转发（dsh 0.2.0-rc.2
  实测），它把包装进 `dependencies` 并（仅当包声明 `dsh.bundle` 时）追加进
  `dsh.profile.bundles`；而本机这类手写插件既未发布 registry 也没有 `dsh.bundle`，
  CLI 只会装成一个普通依赖、打一行 warning，插件并不会被加载。故平台走「拷包 +
  写注册行」这条与手工安装等价的路径，且完全离线。

状态四态（纯文件推导，不落库；dsh_plugin 另叠注册行状态）：
- absent    文件与注册行都不存在
- installed 文件齐、内容与仓库一致，且注册行在（未被 disabled）
- outdated  文件齐，但内容与仓库不一致（页面显示「可更新」）
- partial   只齐一半（文件缺 或 注册行缺）

安装语义 = 收敛到期望状态：文件按内容覆盖（一致则不动），注册行缺则补、在则不动，
重复安装幂等。

安全阀：
- 只允许写清单声明路径（绝对路径 / `..` 越界直接拒绝——清单是平台自带文件，
  但读写代码不做无谓信任）；
- dsh_plugin 的注册行**只动平台自己写的带标记块**，或与规范文本**逐字一致**的手工块；
  遇到用户自定义写法一律拒绝并说明原因（不猜、不覆盖用户手写配置）；
- 落盘走同目录临时文件 + os.replace 原子替换（保留既有文件权限位）；patch 文件同理。
"""

import hashlib
import json
import os
import re
import tempfile

import agents  # 复用 agent 族的 skill 目录约定（SKILL_DIRS_BY_FAMILY）

# 清单根：平台仓库 extensions/；TS_EXT_DIR 覆盖（测试与自定义部署）
DEFAULT_EXT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extensions")
MANIFEST_NAME = "asset.json"

# manifest 允许的资产类型与安装目标
ASSET_TYPES = ("skill", "dsh_plugin")
ASSET_TARGETS = ("user", "project")
# 资产适用族的展示名（族 -> 页面显示名）与类型展示名
FAMILY_LABELS = {"dsh_plugin": "dsh 插件"}
TYPE_LABELS = {"skill": "skill", "dsh_plugin": "dsh 插件"}
# dsh 插件资产：默认 profile 与注册块标记（写进 <profile>/cordis.patch.yml 的注释包围）
DSH_PROFILE_DEFAULT = "web"
PATCH_MARK_BEGIN = "# >>> touchstone-asset:{aid}"
PATCH_MARK_END = "# <<< touchstone-asset:{aid}"
# 包名（可带 scope）与 profile 名的字符白名单
_PKG_RE = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


class AssetError(Exception):
    """资产操作错误（api 层转 400/500；message 为面向用户的中文原因）。"""

    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


# ---------- 路径与清单 ----------


def ext_dir():
    """资产清单根目录（TS_EXT_DIR 覆盖，默认仓库 extensions/）。"""
    return os.path.abspath(os.environ.get("TS_EXT_DIR") or DEFAULT_EXT_DIR)


def display_path(path):
    """把 HOME 前缀缩写为 ~（回显用，避免泄漏服务进程家目录结构）。"""
    home = os.path.expanduser("~")
    if home and path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


def _sha256(path):
    """文件内容 sha256；读不到返回空串（调用方按「不存在/不可读」处理）。"""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def _atomic_write_bytes(path, data):
    """同目录临时文件 + os.replace 原子写（保留既有文件权限位）。"""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    mode = None
    if os.path.exists(path):
        try:
            mode = os.stat(path).st_mode & 0o777
        except OSError:
            mode = None
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tf-asset-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _manifest_error(asset_dir, why):
    """清单非法统一异常（白名单校验失败 = 开发者错误，不放行）。"""
    return AssetError(f"资产清单非法（{os.path.basename(asset_dir)}）：{why}", 500)


def _safe_rel(rel, what):
    """校验清单内相对路径：非空、非绝对、无 .. 段（防越界写）。"""
    if not isinstance(rel, str) or not rel.strip():
        raise ValueError(f"{what} 必须是非空字符串")
    r = rel.strip()
    if os.path.isabs(r) or re.match(r"^[A-Za-z]:[\\/]", r):
        raise ValueError(f"{what} 必须是相对路径：{rel}")
    parts = re.split(r"[\\/]+", r)
    if any(p == ".." for p in parts):
        raise ValueError(f"{what} 不允许 .. 越界：{rel}")
    return r


def _scalar_str(value):
    """YAML 标量渲染（只放行 str/bool/int/float；复杂结构直接报清单错误）。

    注册行的 `config:` 覆盖块由平台生成，故**不做 YAML 转义魔法**：只接受单行标量，
    字符串一律双引号包裹并转义反斜杠/双引号（避免冒号、井号被读成结构）。
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return repr(value)
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return None


def _plugin_spec(asset_dir, raw):
    """校验并规范化 dsh_plugin 资产的 `plugin` 段。

    必填 `package`（npm 包名，可带 scope）；可选 `entry_id`（patch 行的 id，缺省取包名
    最后一段）、`profile`（目标 profile，缺省 web）、`config`（扁平标量映射，写覆盖块）。
    """
    if not isinstance(raw, dict):
        raise _manifest_error(asset_dir, "type=dsh_plugin 必须声明 plugin 对象")
    pkg = str(raw.get("package") or "").strip()
    if not _PKG_RE.match(pkg):
        raise _manifest_error(asset_dir, f"plugin.package 非法：{raw.get('package')!r}")
    entry = str(raw.get("entry_id") or pkg.split("/")[-1]).strip()
    if not _PROFILE_RE.match(entry):
        raise _manifest_error(asset_dir, f"plugin.entry_id 非法：{entry!r}")
    profile = str(raw.get("profile") or DSH_PROFILE_DEFAULT).strip()
    if not _PROFILE_RE.match(profile):
        raise _manifest_error(asset_dir, f"plugin.profile 非法：{profile!r}")
    cfg = raw.get("config")
    norm_cfg = {}
    if cfg is not None:
        if not isinstance(cfg, dict):
            raise _manifest_error(asset_dir, "plugin.config 必须是对象")
        for key, val in cfg.items():
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_.-]*$", str(key)):
                raise _manifest_error(asset_dir, f"plugin.config 键非法：{key!r}")
            if _scalar_str(val) is None:
                raise _manifest_error(
                    asset_dir,
                    f"plugin.config[{key}] 只支持字符串/布尔/数字（复杂结构请手工写 patch）")
            norm_cfg[str(key)] = val
    req = raw.get("requires") or []
    if not isinstance(req, list) or any(not _PKG_RE.match(str(s or "").strip()) for s in req):
        raise _manifest_error(asset_dir, "plugin.requires 必须是包名数组（如 @deepseek-ai/dsh-llm）")
    return {"package": pkg, "entry_id": entry, "profile": profile, "config": norm_cfg,
            "requires": [str(s).strip() for s in req]}


def _load_manifest(asset_dir):
    """读取并校验单个 asset.json，返回规范化资产 dict；非法抛 AssetError。"""
    path = os.path.join(asset_dir, MANIFEST_NAME)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise _manifest_error(asset_dir, f"读取/解析失败（{e}）")
    if not isinstance(raw, dict):
        raise _manifest_error(asset_dir, "顶层必须是 JSON 对象")
    aid = str(raw.get("id") or "").strip()
    if not re.match(r"^[a-z0-9][a-z0-9._-]*$", aid):
        raise _manifest_error(asset_dir, f"id 非法：{raw.get('id')!r}")
    atype = str(raw.get("type") or "").strip()
    if atype not in ASSET_TYPES:
        raise _manifest_error(asset_dir, f"type 必须是 {'/'.join(ASSET_TYPES)}：{atype!r}")
    family = str(raw.get("family") or "").strip()
    if family not in agents.SKILL_DIRS_BY_FAMILY:
        raise _manifest_error(asset_dir, f"family 未知：{family!r}")
    targets = raw.get("targets")
    if not isinstance(targets, list) or not targets or \
            any(t not in ASSET_TARGETS for t in targets):
        raise _manifest_error(asset_dir, f"targets 必须是 {list(ASSET_TARGETS)} 的非空子集")
    targets = list(dict.fromkeys(targets))
    plugin = None
    if atype == "dsh_plugin":
        plugin = _plugin_spec(asset_dir, raw.get("plugin"))
        # dsh 插件是 **profile 级**资产：装进 dsh home 下的 node_modules + profile patch，
        # 与「哪个项目」无关，故只支持用户级目标（声明 project 直接报清单错误，不静默忽略）
        if targets != ["user"]:
            raise _manifest_error(
                asset_dir, "type=dsh_plugin 只支持用户级（targets 只能是 [\"user\"]）")
    files = raw.get("files")
    if not isinstance(files, list) or not files:
        raise _manifest_error(asset_dir, "files 必须是非空数组")
    norm_files = []
    for item in files:
        if not isinstance(item, dict):
            raise _manifest_error(asset_dir, "files 元素必须是 {from, to} 对象")
        try:
            src = _safe_rel(item.get("from"), "files[].from")
            dst = _safe_rel(item.get("to"), "files[].to")
        except ValueError as e:
            raise _manifest_error(asset_dir, str(e))
        if not os.path.isfile(os.path.join(asset_dir, src)):
            raise _manifest_error(asset_dir, f"清单文件不存在：{src}")
        norm_files.append({"from": src, "to": dst})
    # 注册机制（hook 时代的 config.toml 写入）已随族退役：声明即报错，不静默忽略
    # （dsh 插件的注册走 plugin 段的 patch 行，不用这个旧字段）
    if raw.get("register") is not None:
        raise _manifest_error(asset_dir, "不支持 register 声明（skill 资产无需注册）")
    return {
        "id": aid, "name": str(raw.get("name") or aid), "type": atype,
        "family": family, "description": str(raw.get("description") or ""),
        "targets": targets, "files": norm_files, "plugin": plugin,
        "dir": asset_dir,
    }


def load_assets():
    """扫描清单根下所有 extensions/*/asset.json，返回资产列表（非法的直接报错）。

    非法的清单不静默跳过——它只可能来自平台自身或自定义 TS_EXT_DIR，属开发者错误，
    查询接口按 error 回显，避免「资产莫名消失」。
    """
    root = ext_dir()
    if not os.path.isdir(root):
        return []
    assets = []
    ids = set()
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isfile(os.path.join(d, MANIFEST_NAME)):
            continue
        asset = _load_manifest(d)
        if asset["id"] in ids:
            raise _manifest_error(d, f"id 重复：{asset['id']}")
        ids.add(asset["id"])
        assets.append(asset)
    return assets


def get_asset(asset_id):
    """按 id 取资产；不存在返回 None。"""
    for a in load_assets():
        if a["id"] == asset_id:
            return a
    return None


# ---------- 落点推导 ----------


def _skill_root(family, target, project_dir):
    """skill 落点根：该族首个用户级目录 / 项目级相对目录（约定见 agents 模块）。"""
    user_dirs, proj_dirs = agents.SKILL_DIRS_BY_FAMILY.get(family, ((), ()))
    if target == "user":
        return os.path.expanduser(user_dirs[0]) if user_dirs else None
    if not project_dir:
        return None
    return os.path.join(project_dir, proj_dirs[0]) if proj_dirs else None


def dsh_profiles_dir():
    """dsh 的 profiles 根：`TS_DSH_PROFILES` 覆盖 → `DSH_HOME` → `~/.dsh`（后接 profiles）。"""
    env = os.environ.get("TS_DSH_PROFILES")
    if env:
        return os.path.abspath(env)
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(os.path.abspath(home), "profiles")


def plugin_package_root(asset):
    """dsh 插件包实体落点：`<profiles>/node_modules/<package>`（scope 按 npm 目录布局展开）。

    放**祖先** node_modules（而非 `<profile>/node_modules`）是本机既有约定：Node 的
    祖先查找照样解析得到，且同一份实体对所有 profile 可见（gavinc 系列插件即如此）。
    """
    return os.path.join(dsh_profiles_dir(), "node_modules",
                        *asset["plugin"]["package"].split("/"))


def plugin_patch_path(asset):
    """注册行落点：`<profiles>/<profile>/cordis.patch.yml`。

    注意**不是** `<profile>/cordis.yml`——那个文件每次 dsh 启动都被重写为空表，往里写
    状态会丢（dsh 自身的 loader tree write-back 机制）。
    """
    return os.path.join(dsh_profiles_dir(), asset["plugin"]["profile"], "cordis.patch.yml")


def plugin_patch_blocks(asset):
    """平台规范块文本列表（插入顺序即写入顺序）：注入块 + 可选 config 覆盖块。

    每块自带 `# >>> touchstone-asset:<id>` / `# <<<` 注释包围，卸载时按标记整块删除
    （注释在 YAML 里合法，dsh 自己的 patch 文件里也有大量注释行）。
    """
    p, aid = asset["plugin"], asset["id"]
    blocks = ["\n".join([PATCH_MARK_BEGIN.format(aid=aid),
                         "- insert:",
                         f"    - id: {p['entry_id']}",
                         f'      name: "{p["package"]}"',
                         PATCH_MARK_END.format(aid=aid)])]
    if p["config"]:
        lines = [PATCH_MARK_BEGIN.format(aid=aid + ".config"),
                 f"- id: {p['entry_id']}",
                 "  config:"]
        lines += [f"    {k}: {_scalar_str(v)}" for k, v in p["config"].items()]
        lines += ["  disabled: false", PATCH_MARK_END.format(aid=aid + ".config")]
        blocks.append("\n".join(lines))
    return blocks


def _canonical_lines(asset):
    """规范注入块的 3 行（逐行比对用；行尾空白已剥）。"""
    p = asset["plugin"]
    return ["- insert:", f"    - id: {p['entry_id']}", f'      name: "{p["package"]}"']


def _find_canonical(text, asset):
    """找「规范注入块」的起止行号 [start, end)，找不到返回 None。

    必须逐行精确匹配且**下一行不是同一 insert 项内的更深缩进字段**——否则用户自定义写法
    （如在本块后面又加了 `config:`）会被子串匹配误判成规范块，卸载时截断用户的配置。
    """
    lines = text.splitlines()
    want = _canonical_lines(asset)
    for i in range(0, len(lines) - 2):
        if [ln.rstrip() for ln in lines[i:i + 3]] != want:
            continue
        nxt = lines[i + 3] if i + 3 < len(lines) else ""
        if nxt.startswith("    "):        # 同项还有字段 → 不是规范块（属自定义写法）
            continue
        return i, i + 3
    return None


def _patch_disabled(text, entry_id):
    """该条目是否在 patch 里被显式停用（dsh 面板停用会追加顶层 `- id: X` + `disabled: true`）。

    只认**顶层**（列 0）的 `- id:` 行：注入块内部那行是缩进的，不会误命中。
    """
    cur = None
    for line in text.splitlines():
        m = re.match(r"^-\s*id:\s*(\S+)\s*$", line)
        if m:
            cur = m.group(1).strip('"\'')
            continue
        if line.startswith("- "):
            cur = None
            continue
        if cur == entry_id and re.match(r"^\s+disabled:\s*true\s*$", line):
            return True
    return False


def plugin_patch_state(asset):
    """注册行状态（读 patch 文件，纯推导）：

    - `mode="marked"`    平台写的带标记块（可安全整块删）
    - `mode="canonical"` 手工注册但文本与规范逐字一致（可安全删）
    - `mode="foreign"`   同名条目存在但写法自定义（**只报告、绝不改**）
    - `mode=""`          未注册
    """
    path = plugin_patch_path(asset)
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        text = ""
    aid = asset["id"]
    if PATCH_MARK_BEGIN.format(aid=aid) in text:
        mode = "marked"
    elif _find_canonical(text, asset) is not None:
        mode = "canonical"
    elif asset["plugin"]["package"] in text:
        mode = "foreign"
    else:
        mode = ""
    return {"path": path, "exists": bool(text), "mode": mode,
            "registered": mode != "",
            "disabled": bool(text) and _patch_disabled(text, asset["plugin"]["entry_id"])}


def _patch_foreign_error(asset, patch):
    """遇到用户自定义注册写法时的统一拒绝原因（安装/卸载共用）。"""
    return AssetError(
        f"「{asset['name']}」在 {display_path(patch['path'])} 里已有自定义写法的注册行，"
        f"平台不覆盖、也不删除用户手写的 patch 配置；请先手工移除该条目再试", 409)


def install_root(asset, target, project_dir=""):
    """推导该资产在指定目标下的落点根；不支持返回 None。"""
    if target not in asset["targets"]:
        return None
    if asset["type"] == "dsh_plugin":
        # dsh 插件是 profile 级资产：只支持用户级（落 dsh home 下的 node_modules）
        return plugin_package_root(asset) if target == "user" else None
    return _skill_root(asset["family"], target, project_dir)


def _unsupported_reason(asset, target):
    """资产在目标下不可安装的用户可读原因。"""
    if target not in asset["targets"]:
        return ("该资产只支持" +
                "、".join("用户级" if t == "user" else "项目级" for t in asset["targets"]) +
                "安装")
    if asset["type"] == "dsh_plugin":
        return "dsh 插件资产只支持用户级（装进 dsh profile，与项目无关）"
    return f"该资产（{asset['family']}）暂不支持此目标的安装"


def _installed_files(asset, root):
    """清单文件在该落点根下的安装信息列表。"""
    out = []
    for f in asset["files"]:
        dst = os.path.join(root, f["to"])
        # 双保险：解析后的目标必须落在落点根内（清单已校验相对路径，此处仍复核）
        base = os.path.realpath(root)
        real = os.path.realpath(dst)
        if not (real == base or real.startswith(base + os.sep)):
            raise AssetError(f"安装路径越界：{f['to']}", 500)
        src_hash = _sha256(os.path.join(asset["dir"], f["from"]))
        dst_hash = _sha256(dst)
        out.append({"to": f["to"], "path": dst, "exists": bool(dst_hash),
                    "same": bool(dst_hash) and dst_hash == src_hash})
    return out


# ---------- 状态 / 安装 / 卸载 ----------


def asset_status(asset, target, project_dir=""):
    """判定资产在指定目标下的状态，返回含明细的 dict（详情见模块 docstring）。

    skill：纯文件四态。dsh_plugin：文件态与注册行态**合成**——文件齐且内容一致、
    注册行在且未被停用，才算 installed；只齐一半（文件缺 / 注册行缺 / 被停用）判 partial。
    """
    root = install_root(asset, target, project_dir)
    supported = root is not None
    files = _installed_files(asset, root) if supported else []
    patch = plugin_patch_state(asset) if (supported and asset["type"] == "dsh_plugin") else None
    state = "absent"
    if supported:
        any_exists = any(f["exists"] for f in files)
        file_ok = bool(files) and all(f["exists"] for f in files)
        file_same = file_ok and all(f["same"] for f in files)
        if patch is None:
            if not any_exists:
                state = "absent"
            elif file_same:
                state = "installed"
            elif file_ok:
                state = "outdated"
            else:
                state = "partial"
        else:
            usable = patch["registered"] and not patch["disabled"]
            if not any_exists and not patch["registered"]:
                state = "absent"
            elif file_same and usable:
                state = "installed"
            elif file_ok and usable:
                state = "outdated"
            else:
                state = "partial"
    return {"supported": supported,
            "reason": "" if supported else _unsupported_reason(asset, target),
            "root": display_path(root) if supported else "",
            "state": state, "files": files, "patch": patch}


def _plugin_requires_state(asset):
    """插件的运行时依赖解析状态（只读诊断，不写任何链接）。

    手放型插件的包目录在 `<profiles>/node_modules` 下，它 `import '@deepseek-ai/dsh-llm'`
    这类 dsh 自带包时，靠的是**同一祖先目录**里指向 dsh 安装的软链（本机既有约定）。
    新机器上这些链接可能没建/指向旧版本 → 插件装了但加载即报模块解析失败。故这里按
    Node 的祖先查找规则做一次纯文件检查，把「解析不到」提前暴露给用户（见 `requires`）。
    """
    root = plugin_package_root(asset)
    out = []
    for spec in asset["plugin"].get("requires") or []:
        found = _node_resolve(spec, root)
        out.append({"spec": spec, "ok": bool(found), "path": display_path(found) if found else ""})
    return out


def _node_resolve(spec, start_dir):
    """按 Node 祖先查找规则判断从 start_dir 能否解析到 spec；返回命中目录或空串。

    纯文件检查（不跑 node）：`<祖先>/node_modules/<spec>/package.json` 存在即可——
    断链的软链因 os.path.exists 跟随解析而为 False，正是我们要暴露的情况。
    """
    cur = os.path.abspath(start_dir)
    while True:
        cand = os.path.join(cur, "node_modules", *spec.split("/"))
        if os.path.exists(os.path.join(cand, "package.json")):
            return cand
        parent = os.path.dirname(cur)
        if parent == cur:
            return ""
        cur = parent


def _plugin_restart_required(asset):
    """装/卸后是否需要重启 dsh：profile 的 package.json 声明 `patchReload: live` 才热生效。

    读不到 profile manifest（不存在/坏 JSON）按「需要重启」处理——不猜（宁可多提示一次）。
    """
    manifest = os.path.join(dsh_profiles_dir(), asset["plugin"]["profile"], "package.json")
    try:
        with open(manifest, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return True
    prof = ((data.get("dsh") or {}).get("profile") or {}) if isinstance(data, dict) else {}
    return str(prof.get("patchReload") or "") != "live"


def asset_json(asset, target, project_dir=""):
    """资产的对外 JSON（清单元信息 + 目标下的状态明细）。"""
    st = asset_status(asset, target, project_dir)
    out = {"id": asset["id"], "name": asset["name"], "type": asset["type"],
           "type_label": TYPE_LABELS.get(asset["type"], asset["type"]),
           "family": asset["family"],
           "family_label": FAMILY_LABELS.get(asset["family"], asset["family"]),
           "description": asset["description"], "targets": asset["targets"],
           "supported": st["supported"], "reason": st["reason"],
           "state": st["state"], "root": st["root"],
           "files": [{"to": f["to"], "path": display_path(f["path"]),
                      "exists": f["exists"], "same": f["same"]} for f in st["files"]]}
    if st["patch"] is not None:
        requires = _plugin_requires_state(asset)
        out["plugin"] = {
            "package": asset["plugin"]["package"],
            "entry_id": asset["plugin"]["entry_id"],
            "profile": asset["plugin"]["profile"],
            "patch_path": display_path(st["patch"]["path"]),
            "patch_mode": st["patch"]["mode"],
            "registered": st["patch"]["registered"],
            "disabled": st["patch"]["disabled"],
            "restart_required": _plugin_restart_required(asset),
            "requires": requires,
            "requires_ok": all(r["ok"] for r in requires),
        }
    return out


def list_assets(target, project_dir=""):
    """目标下的资产清单（含状态）；target 非法抛 AssetError(400)。"""
    if target not in ASSET_TARGETS:
        raise AssetError(f"target 必须是 {'/'.join(ASSET_TARGETS)}")
    return [asset_json(a, target, project_dir) for a in load_assets()]


def _require_profile(asset):
    """dsh 插件安装的前置检查：目标 profile 目录必须存在（不存在则装了也不会被加载）。"""
    prof_dir = os.path.dirname(plugin_patch_path(asset))
    if not os.path.isdir(prof_dir):
        raise AssetError(f"未找到 dsh profile「{asset['plugin']['profile']}」："
                         f"{display_path(prof_dir)}")


def _write_plugin_patch(asset):
    """确保注册块在 patch 里且处于启用态（幂等）：返回 (action, patch_state)。

    - 已注册且未停用（平台标记块 / 与规范逐行一致的手工块）→ 不动，`action="kept"`；
    - 已注册但被停用（dsh 面板写的顶层 `- id: X` + `disabled: true`）→ 就地翻回 false，
      `action="enabled"`（这一行是 dsh 自己生成的结构化开关，不是用户手写配置）；
    - 自定义写法（foreign）→ 拒绝（不覆盖用户手写配置）；
    - 未注册 → 追加平台标记块（profile 目录不存在则报错——没这个 profile 装了也不加载）。
    """
    patch = plugin_patch_state(asset)
    if patch["mode"] == "foreign":
        raise _patch_foreign_error(asset, patch)
    if patch["mode"] in ("marked", "canonical"):
        if not patch["disabled"]:
            return "kept", patch
        path = patch["path"]
        with open(path, encoding="utf-8") as f:
            text = f.read()
        _atomic_write_bytes(path, _patch_set_enabled(
            text, asset["plugin"]["entry_id"]).encode("utf-8"))
        return "enabled", plugin_patch_state(asset)
    path = patch["path"]
    _require_profile(asset)
    old = ""
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            old = f.read()
    text = old
    if text and not text.endswith("\n"):
        text += "\n"
    if text and not text.endswith("\n\n"):
        text += "\n"
    text += "\n".join(plugin_patch_blocks(asset)) + "\n"
    _atomic_write_bytes(path, text.encode("utf-8"))
    return "added", plugin_patch_state(asset)


def _patch_set_enabled(text, entry_id):
    """把该条目顶层 `- id: <entry_id>` 行下的 `disabled:` 改成 false（找不到则原样返回）。

    只动这一行：dsh 面板的 `writePluginEnabled` 写的就是这个形状（顶层 `- id:` + 缩进
    `disabled: true`），改它是**重新启用插件**，不是覆盖用户自定义配置。
    """
    lines = text.splitlines()
    cur = None
    for i, line in enumerate(lines):
        m = re.match(r"^-\s*id:\s*(\S+)\s*$", line)
        if m:
            cur = m.group(1).strip('"\'')
            continue
        if line.startswith("- "):
            cur = None
            continue
        if cur == entry_id and re.match(r"^\s+disabled:\s*true\s*$", line):
            indent = line[:len(line) - len(line.lstrip())]
            lines[i] = f"{indent}disabled: false"
            out = "\n".join(lines)
            return out + "\n" if text.endswith("\n") else out
    return text


def _strip_marked_blocks(text, aid):
    """删掉平台标记块（含可选 config 块）与其留下的多余空行。"""
    begins = {PATCH_MARK_BEGIN.format(aid=aid),
              PATCH_MARK_BEGIN.format(aid=aid + ".config")}
    ends = {PATCH_MARK_END.format(aid=aid),
            PATCH_MARK_END.format(aid=aid + ".config")}
    out, skip = [], False
    for line in text.splitlines():
        s = line.strip()
        if s in begins:
            skip = True
            continue
        if s in ends:
            skip = False
            continue
        if not skip:
            out.append(line)
    res = re.sub(r"\n{3,}", "\n\n", "\n".join(out))
    if res and not res.endswith("\n"):
        res += "\n"
    return res


def _remove_plugin_patch(asset):
    """移除注册块（幂等）：返回 (action, patch_state)。foreign 一律拒绝。"""
    patch = plugin_patch_state(asset)
    if patch["mode"] == "foreign":
        raise _patch_foreign_error(asset, patch)
    if patch["mode"] == "":
        return "absent", patch
    path = patch["path"]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if patch["mode"] == "marked":
        new = _strip_marked_blocks(text, asset["id"])
    else:
        span = _find_canonical(text, asset)
        lines = text.splitlines()
        kept = lines[:span[0]] + lines[span[1]:]
        new = re.sub(r"\n{3,}", "\n\n", "\n".join(kept))
        if new and not new.endswith("\n"):
            new += "\n"
    _atomic_write_bytes(path, new.encode("utf-8"))
    return "removed", plugin_patch_state(asset)


def _prune_empty_dirs(path, stop_at):
    """删空目录：先自底向上清 path 子树里的空目录，再逐级上删空父目录（到 stop_at 为止）。

    非空目录一律 rmdir 失败即停（不递归删别人的文件）；stop_at 自身永不删。
    """
    cur = os.path.abspath(path)
    stop = os.path.abspath(stop_at)
    if os.path.isdir(cur):
        for dirpath, _dirnames, _files in os.walk(cur, topdown=False):
            try:
                os.rmdir(dirpath)              # 空则删；非空抛 OSError → 跳过
            except OSError:
                pass
    while cur.startswith(stop + os.sep) and cur != stop:
        try:
            os.rmdir(cur)
        except FileNotFoundError:
            pass                               # 子树里已被删掉 → 继续往上收敛空父目录
        except OSError:
            return                             # 非空（还有别人的文件）→ 停
        cur = os.path.dirname(cur)


def install(asset, target, project_dir=""):
    """安装/更新/修复资产（收敛到期望状态），返回结果 dict。"""
    root = install_root(asset, target, project_dir)
    if root is None:
        raise AssetError(_unsupported_reason(asset, target))
    if target == "project":
        if not project_dir or not os.path.isdir(project_dir):
            raise AssetError("项目目录不存在")
    if asset["type"] == "dsh_plugin":
        # 前置检查放在拷文件之前：profile 不存在时直接报错，不留下「包已拷、注册行没写」
        # 的半残状态（那种状态面板会显示 partial，用户还得先修一次）
        _require_profile(asset)
    # 落盘：内容一致则不动，其余原子覆盖
    written = []
    for f in asset["files"]:
        dst = os.path.join(root, f["to"])
        base = os.path.realpath(root)
        real = os.path.realpath(dst)
        if not (real == base or real.startswith(base + os.sep)):
            raise AssetError(f"安装路径越界：{f['to']}", 500)
        src = os.path.join(asset["dir"], f["from"])
        with open(src, "rb") as fh:
            data = fh.read()
        if _sha256(dst) == _sha256(src):
            continue
        _atomic_write_bytes(dst, data)
        written.append(display_path(dst))
    patch_action = ""
    if asset["type"] == "dsh_plugin":
        patch_action, _patch = _write_plugin_patch(asset)
    st = asset_status(asset, target, project_dir)
    return {"ok": True, "state": st["state"], "files_written": written,
            "patch_action": patch_action,
            "restart_required": (_plugin_restart_required(asset)
                                 if asset["type"] == "dsh_plugin" else False),
            "asset": asset_json(asset, target, project_dir)}


def uninstall(asset, target, project_dir=""):
    """卸载资产：只删除清单内文件（别人的文件一律不动），返回结果 dict。

    dsh_plugin 另删**平台写的注册块**（或与规范逐字一致的手工块）；包目录清空后连空
    目录一起收掉（含 scope 目录，只收到 profiles 根为止）。
    """
    root = install_root(asset, target, project_dir)
    if root is None:
        raise AssetError(_unsupported_reason(asset, target))
    # dsh 插件：先判注册行——foreign（用户自定义写法）时**在删任何文件之前**拒绝，
    # 免得出现「包文件已删、注册行还在」的半残状态
    patch = plugin_patch_state(asset) if asset["type"] == "dsh_plugin" else None
    if patch is not None and patch["mode"] == "foreign":
        raise _patch_foreign_error(asset, patch)
    files = _installed_files(asset, root)
    deleted = []
    for f in files:
        if os.path.isfile(f["path"]):
            try:
                os.unlink(f["path"])
            except OSError as e:
                raise AssetError(f"删除失败：{display_path(f['path'])}（{e}）", 500)
            deleted.append(display_path(f["path"]))
    patch_action = ""
    if patch is not None:
        patch_action, _p = _remove_plugin_patch(asset)
        _prune_empty_dirs(root, dsh_profiles_dir())
    st = asset_status(asset, target, project_dir)
    return {"ok": True, "state": st["state"], "files_deleted": deleted,
            "patch_action": patch_action,
            "restart_required": (_plugin_restart_required(asset)
                                 if asset["type"] == "dsh_plugin" else False),
            "asset": asset_json(asset, target, project_dir)}
