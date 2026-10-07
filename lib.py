#!/usr/bin/env python3
"""Touchstone 案例库/bug 报告共享解析与状态改写工具。

server.py（状态聚合）与 runner.py（任务收尾判定）共用：
- 解析 status.md / bug_report.md 的 `**字段**: 值` 行
- 按唯一 id（FS0001）定位案例目录
- 改写 案例状态（需要复测）与 bug 报告状态（已修复等）
"""

import os
import re
import subprocess

# 用例文件夹名：FS0004_用例名称
CASE_DIR_RE = re.compile(r"^(FS\d{4})_(.+)$")
# status.md / bug_report.md 字段行：'- **状态**: 失败' 或 '**状态**: 已分析，待修复'
FIELD_RE = re.compile(r"^\s*(?:-\s*)?\*\*(.+?)\*\*\s*[:：]\s*(.*)$", re.M)
# bug_report.md 中的关联用例编号
FS_ID_RE = re.compile(r"FS\d{4}")


def read_text(path):
    """读文本文件，失败返回空串。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def parse_fields(text):
    """把 '- **字段**: 值' 列表解析成 dict。"""
    return {m.group(1).strip(): m.group(2).strip() for m in FIELD_RE.finditer(text)}


def norm_status(value):
    """状态字段归一化：模板未填写时是 '未执行 / 通过 / ...'，取第一项。"""
    if not value:
        return "未执行"
    return value.split("/")[0].strip()


def parse_status_md(path):
    """解析用例 status.md，返回状态/失败原因等字段。"""
    fields = parse_fields(read_text(path))
    return {
        "status": norm_status(fields.get("状态", "")),
        "last_run": fields.get("最近执行时间", ""),
        "round": fields.get("执行轮次", ""),
        "fail_reason": fields.get("失败原因", ""),
        "bug_report": fields.get("关联 bug_report", ""),
        "summary": fields.get("结果摘要", ""),
    }


def set_md_field(path, field, value):
    """改写 md 中 `**field**: 值`（含 '- **field**' 前缀形式）一行。

    行不存在时在文末追加 '- **field**: 值'。返回是否命中已有行。
    """
    text = read_text(path)
    if not text:
        return False
    # 只匹配目标字段的行；保留原行前缀（'- ' 或 ''）
    pattern = re.compile(r"^(\s*(?:-\s*)?\*\*" + re.escape(field) + r"\*\*\s*[:：]\s*).*$",
                         re.M)
    new_line = r"\g<1>" + value
    if pattern.search(text):
        text = pattern.sub(new_line, text)
    else:
        text = text.rstrip("\n") + f"\n\n- **{field}**: {value}\n"
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return True
    except OSError:
        return False


def find_case_dirs(root, case_ids):
    """在案例库根目录下按唯一 id 定位 case 目录。

    返回 [(case_id, 绝对目录路径)]；未找到的 id 不进结果。
    """
    found = {}
    want = set(case_ids)
    if not want or not os.path.isdir(root):
        return []
    for dirpath, dirnames, _ in os.walk(root):
        # 跳过实时运行状态等隐藏目录
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in dirnames:
            m = CASE_DIR_RE.match(name)
            if m and m.group(1) in want:
                found[m.group(1)] = os.path.join(dirpath, name)
                want.discard(m.group(1))
                if not want:
                    return sorted(found.items())
    return sorted(found.items())


def mark_cases_retest(root, case_ids):
    """把关联 case 的 status.md 状态改为「需要复测」（复测任务开始前调用）。"""
    paths = []
    for cid, d in find_case_dirs(root, case_ids):
        sp = os.path.join(d, "status.md")
        if set_md_field(sp, "状态", "需要复测"):
            paths.append(cid)
    return paths


def cases_all_passed(root, case_ids):
    """判定关联 case 是否全部「通过」。找不到 status.md 的 case 视为未通过。"""
    if not case_ids:
        return False
    dirs = find_case_dirs(root, case_ids)
    # 有 id 定位不到目录时视为未通过：否则「找不到」会被静默忽略，
    # 剩余找到的用例全通过即误判整体通过（bug 报告引用不存在/改名案例的场景）
    if len(dirs) != len(set(case_ids)):
        return False
    for cid, d in dirs:
        if parse_status_md(os.path.join(d, "status.md"))["status"] != "通过":
            return False
    return True


def bug_cases(bug_dir_path):
    """读 bug 报告全文并提取关联 case id（去重排序）。

    返回 (content, case_ids)。
    """
    report = read_text(os.path.join(bug_dir_path, "bug_report.md"))
    ids = sorted(set(FS_ID_RE.findall(report)))
    return report, ids


# 运行期机器产物目录名：统一挂 <工作目录> 下（案例库目录只保留纯案例内容）。
# 工作目录缺省为 <项目目录>/.touchstone（见 server.py 项目创建），用户可配置到任意位置，
# 运行时文件（日志/live 状态/看板附件）全部跟随工作目录，不落项目目录。
# board_media 为看板卡片附件（描述粘贴图片/文件）存储目录
RUNTIME_DIR_NAMES = (".web", ".live", "board_media")


def runtime_dir(work_dir, name):
    """返回 <工作目录>/<name>：运行期机器产物目录（日志 / live 状态）。"""
    return os.path.join(work_dir, name)


def ensure_runtime_dirs(work_dir):
    """确保 <工作目录> 下运行产物目录（.web/.live/board_media）就绪，并幂等维护 .gitignore。

    - 建 <工作目录>/.web、.live、board_media（已存在则跳过）
    - <工作目录>/.gitignore 缺少对应忽略项时在文末追加，已有内容
      （含用户手写的其他规则）一律不动
    - 目录/gitignore 写不进去时不抛错：后续日志写入自然报启动失败
    """
    for name in RUNTIME_DIR_NAMES:
        try:
            os.makedirs(runtime_dir(work_dir, name), exist_ok=True)
        except OSError:
            pass
    gi = os.path.join(work_dir, ".gitignore")
    try:
        text = read_text(gi)
        lines = {ln.strip() for ln in text.splitlines()}
        missing = [name + "/" for name in RUNTIME_DIR_NAMES if name + "/" not in lines]
        if missing:
            with open(gi, "a", encoding="utf-8") as f:
                if text and not text.endswith("\n"):
                    f.write("\n")
                f.write("\n".join(missing) + "\n")
    except OSError:
        pass


# 已固化复测脚本文件名：用例目录内存在该文件即视为已固化（文件即事实，无登记表）
VERIFY_SCRIPT_NAME = "verify.py"


def bug_cases_scripted(cases_root, case_ids):
    """判定用例集合是否全部已固化（每个用例目录内都有 verify.py）。

    全部固化且用例数 > 0 时返回 True；任一未固化 / 有 id 定位不到目录 /
    用例集合为空时返回 False（调用方据此回落 agent 复测路径）。
    """
    dirs = find_case_dirs(cases_root, case_ids)
    if not dirs or len(dirs) != len(set(case_ids)):
        return False
    return all(os.path.isfile(os.path.join(d, VERIFY_SCRIPT_NAME)) for _, d in dirs)


def ensure_gitignore(base_dir, entry):
    """在 base_dir/.gitignore 幂等追加一行忽略项（案例库内机器产物目录用）。

    与 ensure_runtime_dirs 的 .gitignore 维护同构：已有内容（含用户手写
    规则）一律不动；base_dir 不存在时顺带创建；写不进去不抛错。
    """
    try:
        os.makedirs(base_dir, exist_ok=True)
    except OSError:
        return
    gi = os.path.join(base_dir, ".gitignore")
    text = read_text(gi)
    if entry in {ln.strip() for ln in text.splitlines()}:
        return
    try:
        with open(gi, "a", encoding="utf-8") as f:
            if text and not text.endswith("\n"):
                f.write("\n")
            f.write(entry + "\n")
    except OSError:
        pass


def git_log_changes(project_dir, date_from="", date_to="", limit=100):
    """摘录日期范围（YYYY-MM-DD，空=不限）内的 git 提交与变更文件。

    返回 {"ok": True, "commits": ["短hash 日期 作者 标题", ...],
          "files": [去重变更文件相对路径, ...]}；非 git 仓库/git 不可用/
    无提交返回 {"ok": False, "error": "..."}（调用方静默降级）。
    每个提交块以 \\x00 分隔（文件名不会含 NUL），块首行为提交头。
    """
    cmd = ["git", "-C", project_dir, "-c", "core.quotepath=false", "log",
           "--pretty=format:%x00%h %ad %an %s", "--date=short", "--name-only"]
    if date_from:
        cmd += ["--since=" + date_from + " 00:00:00"]
    if date_to:
        cmd += ["--until=" + date_to + " 23:59:59"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=20)
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "error": f"git 不可用: {e}"}
    if out.returncode != 0:
        return {"ok": False, "error": (out.stderr or "").strip()[:300]}
    commits, files = [], []
    for blk in out.stdout.split("\x00"):
        lines = [ln for ln in blk.splitlines() if ln.strip()]
        if not lines:
            continue
        commits.append(lines[0])
        files.extend(lines[1:])
    commits = commits[:limit]
    return {"ok": True, "commits": commits, "files": sorted(set(files))}

