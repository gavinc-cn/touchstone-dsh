#!/usr/bin/env python3
"""独立 git worktree 支撑（看板卡片「在新 worktree 中开始」，2026-10-06 批次）。

设计出处：`doc_ai/plan/202610/20261006_0115_看板卡片独立worktree执行（开始按钮下拉+免排队）.md`
（下称 plan）。本模块只做「路径推导 + git 调用 + 结果归一」，不碰数据库与队列：

- **路径**（plan D4）：`<work_dir>/worktrees/card_<id>`；若该路径落在 git 仓库内部
  （work_dir 在项目目录内的项目，例如 `proj` 的 `work_dir=/opt/proj/.touchstone`），
  回退为 `<project_dir 的父目录>/.touchstone-worktrees/<项目名>_card_<id>`
  ——worktree 不得建在仓库内部（嵌套工作树会污染主仓库状态）。
- **分支**（plan D5）：`ts/card-<id>`，确定性命名、一卡一分支，无需新增 DB 列。
- **git 调用约定**（plan §3.3）：一律 `git -C <目录> ...`（与 `lib.git_log_changes`
  同款写法），**不设 `GIT_DIR`/`GIT_WORK_TREE`**——这两个变量由外部环境决定，
  平台擅自改写会与用户仓库的既有配置打架（本项目自身就是 9p 映射 worktree 的特例，
  见根 `AGENTS.md`）；git 非 0 退出一律把 stderr 截断成可读错误串上抛。
- **跨平台指针归一**（plan D-§2.5）：git 默认在 worktree 的 `.git` 文件与
  `<repo>/.git/worktrees/<name>/gitdir` 里写**绝对路径**；Linux 建的 worktree 在
  Windows git 下不可用、反之亦然。本模块在创建后把两处指针改写为相对路径
  （两端都能解析），改写后立即用 git 复验，失败即回滚为 git 原样——best-effort，
  绝不因「指针美化」把可用的工作树改坏。

对外函数返回 `(值, 错误串)` 或 dict，全部**不抛异常**（调用方按错误串回 400），
唯一例外是进程级异常（内存/权限以外的意外），由调用方兜底。
"""

import os
import re
import subprocess

# git 命令超时（秒）：创建/删除工作树可能要拷贝大量文件，给足；查询类很快
GIT_TIMEOUT = 60
GIT_WRITE_TIMEOUT = 300

# 工作树落点目录名（平台自有目录下）与仓库内回退目录名
WT_DIRNAME = "worktrees"
FALLBACK_DIRNAME = ".touchstone-worktrees"

# 分支名前缀（D5）
BRANCH_PREFIX = "ts/card-"

# 错误串截断长度（回给前端/日志用，避免把整段 git 输出贴出来）
_ERR_MAX = 300

# Windows 盘符绝对路径（`D:/x`、`D:\x`）：Linux 的 os.path.isabs 不认，需自行识别
_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")

# worktree `.git` 文件内容形如 `gitdir: <路径>`
_GITFILE_RE = re.compile(r"^\s*gitdir:\s*(.+?)\s*$")


def branch_for(card_id):
    """卡片对应的 worktree 分支名（确定性命名，D5）。"""
    return f"{BRANCH_PREFIX}{int(card_id)}"


def _norm(path):
    """路径归一化用于「是否在仓库内」比较（Linux 下 normcase 为恒等，Windows 折大小写）。"""
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def _inside(child, parent):
    """child 是否位于 parent 目录内部（含相等不算「内部」，便于判 work_dir==project_dir）。"""
    c, p = _norm(child), _norm(parent)
    return c != p and c.startswith(p.rstrip(os.sep) + os.sep)


def worktree_path(project, card_id, repo_root=""):
    """推导卡片 worktree 落点（plan D4；纯字符串推导，不落盘）。

    repo_root 非空时按「不得落在仓库内部」判定（git 顶层可能与 project_dir 不同，
    例如 project_dir 只是仓库的一个子目录）；空则退化为按 project_dir 判定。
    """
    project_dir = (project["project_dir"] or "").strip()
    work_dir = (project["work_dir"] or "").strip() or project_dir
    name = os.path.basename(os.path.normpath(project_dir).rstrip("/\\")) or "project"
    cand = os.path.join(work_dir, WT_DIRNAME, f"card_{int(card_id)}")
    contain = repo_root or project_dir
    if contain and _inside(cand, contain):
        parent = os.path.dirname(os.path.normpath(os.path.abspath(project_dir)))
        cand = os.path.join(parent, FALLBACK_DIRNAME, f"{name}_card_{int(card_id)}")
    return os.path.normpath(cand)


def _git(args, cwd, timeout=GIT_TIMEOUT):
    """跑一条 git 命令，返回 (returncode, stdout, stderr摘要)。

    git 不可用（未安装/不可执行）按 returncode=-1 归一，错误串统一文案——
    调用方只需判 rc != 0。不抛异常（超时同样归一）。
    """
    cmd = ["git", "-C", cwd] + list(args)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return -1, "", f"git 不可用: {e}"
    err = (p.stderr or "").strip()
    return p.returncode, p.stdout or "", err[:_ERR_MAX]


def repo_root(project_dir):
    """项目目录所属 git 仓库顶层；非仓库/git 不可用返回 (None, 错误串)。

    项目目录只是仓库子目录时返回真正的顶层——`git worktree add` 必须在顶层执行，
    否则工作树会挂到子目录语义上（git 会拒绝）。
    """
    d = (project_dir or "").strip()
    if not d:
        return None, "项目目录为空"
    if not os.path.isdir(d):
        return None, f"项目目录不存在: {d}"
    rc, out, err = _git(["rev-parse", "--show-toplevel"], d)
    if rc != 0 or not out.strip():
        return None, (err or "项目目录不是 git 仓库")
    return out.strip().splitlines()[0].strip(), ""


def preview(project, card_id):
    """预览（**不落盘**）：{ok, error, path, branch, exists, root}。

    `ok=False` 表示该项目不能建 worktree（非 git 仓库等），error 为中文原因；
    `exists=True` 表示目标路径已存在（前端可据此提示「将复用」）。
    """
    project_dir = (project["project_dir"] or "").strip()
    root, err = repo_root(project_dir)
    if err:
        return {"ok": False, "error": f"项目目录不是 git 仓库（{err}）",
                "path": "", "branch": branch_for(card_id), "exists": False,
                "root": ""}
    path = worktree_path(project, card_id, root)
    return {"ok": True, "error": "", "path": path,
            "branch": branch_for(card_id), "exists": os.path.isdir(path),
            "root": root}


def _readable_worktree(path, branch):
    """path 是否已是可用的、检出指定分支的 git 工作树（复用判据）。"""
    if not os.path.isdir(path):
        return False
    rc, out, _ = _git(["rev-parse", "--is-inside-work-tree"], path)
    if rc != 0 or out.strip() != "true":
        return False
    rc, out, _ = _git(["rev-parse", "--abbrev-ref", "HEAD"], path)
    return rc == 0 and out.strip() == branch


def _relpath(target, start):
    """相对路径（统一用 `/` 分隔：git 指针文件两端平台都认正斜杠）。"""
    return os.path.relpath(target, start).replace(os.sep, "/")


def _write_text(path, text):
    """原子写文本文件（同目录临时文件 + os.replace，避免中断留半个文件）。"""
    tmp = path + ".tmp_tswt"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def _normalize_pointers(path):
    """把 worktree 的两处指针改写为**相对路径**（见模块 docstring 末条）。

    改写对象：
      ① `<worktree>/.git`                    内容 `gitdir: <repo>/.git/worktrees/<name>`
      ② `<repo>/.git/worktrees/<name>/gitdir` 内容 `<worktree 绝对路径>`
    步骤：读原文 → 算出相对形式 → 写入 → **用 git 复验**（`rev-parse --show-toplevel`
    能解析）→ 失败把两处原文写回。任何读取失败/已被改成相对路径都直接返回（不动）。
    """
    gitfile = os.path.join(path, ".git")
    try:
        with open(gitfile, encoding="utf-8") as f:
            gitfile_text = f.read()
    except OSError:
        return
    m = _GITFILE_RE.match(gitfile_text.splitlines()[0] if gitfile_text else "")
    if not m:
        return
    admin = m.group(1)
    # 已是相对路径（含 Windows 盘符形态的精确识别）则不动
    if not (os.path.isabs(admin) or _DRIVE_RE.match(admin)):
        return
    admin_abs = os.path.normpath(admin)
    gd_file = os.path.join(admin_abs, "gitdir")
    try:
        with open(gd_file, encoding="utf-8") as f:
            gd_text = f.read()
    except OSError:
        return
    new_gitfile = f"gitdir: {_relpath(admin_abs, path)}\n"
    new_gd = _relpath(os.path.normpath(path), admin_abs) + "\n"
    try:
        _write_text(gitfile, new_gitfile)
        _write_text(gd_file, new_gd)
    except OSError:
        return
    rc, _, _ = _git(["rev-parse", "--show-toplevel"], path)
    if rc == 0:
        return
    # 复验失败：回滚（宁可留绝对指针也不能把可用工作树改坏）
    try:
        _write_text(gitfile, gitfile_text)
        _write_text(gd_file, gd_text)
    except OSError:
        pass


def create(project, card_id):
    """创建（或复用）卡片的独立 worktree；返回 (path, branch, err)。

    幂等语义（plan §3.5）：
    - 路径已是可用工作树且检出目标分支 → 直接复用（打回续改/失败重按开始走这条）；
    - 路径不存在（用户手删）→ 重新创建：分支已存在则检出该分支（保留既往提交），
      否则 `-b` 新建；
    - 报错一律返回中文错误串，调用方按 400 回给前端。
    """
    project_dir = (project["project_dir"] or "").strip()
    root, err = repo_root(project_dir)
    if err:
        return "", "", f"无法创建 worktree：项目目录不是 git 仓库（{err}）"
    path = worktree_path(project, card_id, root)
    branch = branch_for(card_id)
    if _readable_worktree(path, branch):
        return path, branch, ""
    if os.path.exists(path):
        # 路径被占（文件/非本卡的工作树）：不擅自删用户目录，明确报错交用户处理
        return "", "", f"worktree 路径已存在且不可复用：{path}"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError as e:
        return "", "", f"无法创建 worktree 目录：{e}"
    rc, _, _ = _git(["rev-parse", "--verify", "--quiet",
                     f"refs/heads/{branch}"], root)
    if rc == 0:
        # 分支已存在（用户删过工作树目录、分支留着）：检出既有分支，保留既往提交
        args = ["worktree", "add", path, branch]
    else:
        args = ["worktree", "add", path, "-b", branch]
    rc, out, err = _git(args, root, timeout=GIT_WRITE_TIMEOUT)
    if rc != 0:
        # 目标目录不存在但 git 侧仍有注册残留（用户删过目录）：prune 后重试一次
        rc2, _, _ = _git(["worktree", "prune"], root)
        if rc2 == 0:
            rc, out, err = _git(args, root, timeout=GIT_WRITE_TIMEOUT)
    if rc != 0:
        return "", "", f"git worktree add 失败：{(err or out or '未知原因').strip()[:_ERR_MAX]}"
    _normalize_pointers(path)
    return path, branch, ""


def status(project, card):
    """卡片工作树的改动状态：{ok, error, path, branch, dirty, exists}。

    dirty 判据 = `git status --porcelain` 有输出（含未跟踪文件）——与 plan D8 的
    「只在干净时清理」同口径。
    """
    path = (card["worktree"] or "").strip()
    branch = branch_for(card["id"])
    if not path:
        return {"ok": False, "error": "该卡片没有独立 worktree", "path": "",
                "branch": branch, "dirty": False, "exists": False}
    if not os.path.isdir(path):
        return {"ok": False, "error": "worktree 目录不存在", "path": path,
                "branch": branch, "dirty": False, "exists": False}
    rc, out, err = _git(["status", "--porcelain"], path)
    if rc != 0:
        return {"ok": False, "error": f"无法读取工作树状态：{err}",
                "path": path, "branch": branch, "dirty": False, "exists": True}
    return {"ok": True, "error": "", "path": path, "branch": branch,
            "dirty": bool(out.strip()), "exists": True}


def remove(project, card):
    """清理卡片 worktree（plan D8：**只在干净时**、绝不用 `--force`）；返回 (ok, err)。

    只 `git worktree remove`；**不删分支**（分支里的提交可能还没回流，删了要 reflog
    才找得回；清理分支交用户在 git 侧自行决定）。
    """
    path = (card["worktree"] or "").strip()
    if not path:
        return False, "该卡片没有独立 worktree"
    if not os.path.isdir(path):
        return False, "worktree 目录不存在"
    st = status(project, card)
    if not st["ok"]:
        return False, st["error"]
    if st["dirty"]:
        return False, "工作树有未提交改动，请先提交或清理后再移除"
    root, err = repo_root(project["project_dir"])
    if err:
        return False, f"项目目录不是 git 仓库（{err}）"
    rc, out, err = _git(["worktree", "remove", path], root, timeout=GIT_WRITE_TIMEOUT)
    if rc != 0:
        return False, f"git worktree remove 失败：{(err or out or '未知原因').strip()[:_ERR_MAX]}"
    return True, ""
