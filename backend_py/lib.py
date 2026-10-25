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


# ---------------------------------------------------------------------------
# 机器契约双语别名表（T14；设计 §5.4）
#
# 机器契约 = status.md / case.md / bug_report.md 的字段名与状态值。英文模板只换 IO 层
# 写法，**内部 canonical 永远是现有中文常量**（消费方一行不用改）；解析时先归一到中文，
# 写回时再按文件已有语言翻回去。
#
# `_FIELD_ALIASES`：字段名（中文 canonical 或英文写法）→ 中文 canonical 键；中文键映射
# 到自身，保证存量中文文件解析逐字段不变。T15 的英文模板字段名取 `_FIELD_EN` 右列。
# `_STATUS_ALIASES`：状态值（中文 canonical 或英文写法）→ 中文 canonical 值；英文写法
# 覆盖 T15 模板与平台/webui 既有英文（dataLabels.js），ASCII 大小写不敏感。
# 两份表在 backend/lib/lib.js 有逐字镜像；任何一端改表都要同步另一端。
# ---------------------------------------------------------------------------

_FIELD_ALIASES = {
    # status.md
    "状态": "状态",
    "Status": "状态",
    "最近执行时间": "最近执行时间",
    "Last run time": "最近执行时间",
    "Last run": "最近执行时间",
    "执行环境": "执行环境",
    "Execution environment": "执行环境",
    "执行轮次": "执行轮次",
    "Round": "执行轮次",
    "Execution round": "执行轮次",
    "失败原因": "失败原因",
    "Failure reason": "失败原因",
    "关联 bug_report": "关联 bug_report",
    "Related bug_report": "关联 bug_report",
    "Related bug report": "关联 bug_report",
    "结果摘要": "结果摘要",
    "Result summary": "结果摘要",
    # case.md
    "用例 ID": "用例 ID",
    "Case ID": "用例 ID",
    "接口": "接口",
    "Interface": "接口",
    "分类": "分类",
    "Category": "分类",
    "所属模块/功能": "所属模块/功能",
    "Module / Function": "所属模块/功能",
    "Module/Function": "所属模块/功能",
    "测试目标": "测试目标",
    "Test objective": "测试目标",
    "Test goal": "测试目标",
    "依据代码": "依据代码",
    "Code reference": "依据代码",
    "脚本": "脚本",
    "Script": "脚本",
    "测试方法": "测试方法",
    "Test method": "测试方法",
    "输入参数": "输入参数",
    "Input parameters": "输入参数",
    "预期输出": "预期输出",
    "Expected output": "预期输出",
    "输出获取方式": "输出获取方式",
    "Output retrieval": "输出获取方式",
    "验证逻辑": "验证逻辑",
    "Verification logic": "验证逻辑",
    "备注": "备注",
    "Note": "备注",
    # bug_report.md
    "严重程度": "严重程度",
    "Severity": "严重程度",
    "报告时间": "报告时间",
    "Reported at": "报告时间",
    "Report time": "报告时间",
    "错误签名": "错误签名",
    "Error signature": "错误签名",
    "用例名称": "用例名称",
    "Case name": "用例名称",
}

# 中文 canonical 字段名 → 写回英文文件时优先使用的英文键（set_md_field 用；与上表互补）
_FIELD_EN = {
    "状态": "Status",
    "最近执行时间": "Last run time",
    "执行环境": "Execution environment",
    "执行轮次": "Round",
    "失败原因": "Failure reason",
    "关联 bug_report": "Related bug_report",
    "结果摘要": "Result summary",
    "用例 ID": "Case ID",
    "接口": "Interface",
    "分类": "Category",
    "所属模块/功能": "Module / Function",
    "测试目标": "Test objective",
    "依据代码": "Code reference",
    "脚本": "Script",
    "测试方法": "Test method",
    "输入参数": "Input parameters",
    "预期输出": "Expected output",
    "输出获取方式": "Output retrieval",
    "验证逻辑": "Verification logic",
    "备注": "Note",
    "严重程度": "Severity",
    "报告时间": "Reported at",
    "错误签名": "Error signature",
    "用例名称": "Case name",
}

# 中文 canonical 字段名集合（文件主语言判定用）
_FIELD_ZH_NAMES = frozenset(k for k, v in _FIELD_ALIASES.items() if k == v)

_STATUS_ALIASES = {
    # 中文 canonical → 自身（存量中文文件零变化）
    "未执行": "未执行",
    "通过": "通过",
    "失败": "失败",
    "跳过": "跳过",
    "需要复测": "需要复测",
    "待分析": "待分析",
    "已分析，待修复": "已分析，待修复",
    "已修复（未验证）": "已修复（未验证）",
    "复测通过": "复测通过",
    "已拒绝": "已拒绝",
    "已分析": "已分析",
    "已修复（复测通过）": "已修复（复测通过）",
    "复测未通过": "复测未通过",
    "修复完成，待复测": "修复完成，待复测",
    "已修复": "已修复",
    # 英文 → 中文 canonical（Case / status.md）
    "Not run": "未执行",
    "Not started": "未执行",
    "Pass": "通过",
    "Passed": "通过",
    "Fail": "失败",
    "Failed": "失败",
    "Skip": "跳过",
    "Skipped": "跳过",
    "Need retest": "需要复测",
    "Needs retest": "需要复测",
    "Retest": "需要复测",
    "Retest needed": "需要复测",
    "Pending retest": "需要复测",
    # 英文 → 中文 canonical（bug_report.md；与 webui/src/utils/dataLabels.js 既有英文对齐）
    "To analyze": "待分析",
    "Analyzed, to fix": "已分析，待修复",
    "Analyzed, pending fix": "已分析，待修复",
    "Analyzed, to be fixed": "已分析，待修复",
    "Fixed (unverified)": "已修复（未验证）",
    "Retest passed": "复测通过",
    "Rejected": "已拒绝",
    "Rejected (false positive, not a defect)": "已拒绝",
    "Rejected (false positive)": "已拒绝",
    "Analyzed": "已分析",
    "Fixed (retest passed)": "已修复（复测通过）",
    "Retest failed": "复测未通过",
    "Fix complete, pending retest": "修复完成，待复测",
    "Fixed": "已修复",
}

# ---------------------------------------------------------------------------
# bug 报告「严重程度」等级（2026-10-25 测试报告等级划分批次）
#
# 等级是报告模板里的固定枚举（bug_report_template.md: 高 / 中 / 低；英文模板
# bug_report_template.en.md: High / Medium / Low），也是产品侧「分级展示/筛选/排序」
# 的唯一分类口径。**中文 canonical 仍是内部值**（与状态字段同口径）：解析时英文写法
# 归一到中文；写回时按目标文件语言取 zh/en 写法。无法识别的自定义值不猜译 ——
# `severity_level()` 返回空串（界面显示「未分级」），报告正文原样不动。
# 与 backend/lib/lib.js 的表逐字镜像；任何一端改表都要同步另一端。
# ---------------------------------------------------------------------------
SEVERITY_LEVELS = ("高", "中", "低")

_SEVERITY_ALIASES = {
    # 中文 canonical → 自身（存量中文文件零变化）
    "高": "高",
    "中": "中",
    "低": "低",
    # 英文 → 中文 canonical（bug_report_template.en.md 的固定枚举；与 i18n/en.json 一致）
    "High": "高",
    "Medium": "中",
    "Low": "低",
}

# ASCII 大小写不敏感索引（"High"/"high" 都认；中文键不参与）
_SEVERITY_ALIASES_LOWER = {k.lower(): v for k, v in _SEVERITY_ALIASES.items() if k.isascii()}

# 中文 canonical 等级 → 写回英文文件时的英文写法（set_md_field 用）
_SEVERITY_EN = {"高": "High", "中": "Medium", "低": "Low"}


def severity_level(value):
    """严重程度值 → 中文 canonical 等级（高/中/低）；无法识别返回空串。

    精确匹配优先，其次 ASCII 大小写不敏感（`High`/`high`）；不做前缀/模糊匹配 ——
    未知自定义值不猜译（返回 ""，由调用方按「未分级」处理，文件内容原样不动）。
    """
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    mapped = _SEVERITY_ALIASES.get(text)
    if mapped is not None:
        return mapped
    return _SEVERITY_ALIASES_LOWER.get(text.lower(), "")


# ASCII 大小写不敏感索引（"Pass"/"pass" 都认；中文键不参与，避免改变中文匹配语义）
_STATUS_ALIASES_LOWER = {k.lower(): v for k, v in _STATUS_ALIASES.items() if k.isascii()}

# 中文 canonical 状态值 → 写回英文文件时的英文写法（set_md_field 用）
_STATUS_EN = {
    "未执行": "Not run",
    "通过": "Pass",
    "失败": "Failed",
    "跳过": "Skipped",
    "需要复测": "Needs retest",
    "待分析": "To analyze",
    "已分析，待修复": "Analyzed, to fix",
    "已修复（未验证）": "Fixed (unverified)",
    "复测通过": "Retest passed",
    "已拒绝": "Rejected",
    "已分析": "Analyzed",
    "已修复（复测通过）": "Fixed (retest passed)",
    "复测未通过": "Retest failed",
    "修复完成，待复测": "Fix complete, pending retest",
    "已修复": "Fixed",
}


def _canonical_field(name):
    """字段名 → 内部中文 canonical 键；未登记字段名原样返回（不丢字段）。"""
    return _FIELD_ALIASES.get(name, name)


def _canonical_status_value(value):
    """状态值 → 中文 canonical；中文 canonical 原样返回；未知值原样返回（不丢）。

    精确匹配优先，其次 ASCII 大小写不敏感（`Pass`/`pass`）；不做前缀/模糊匹配，
    免得把未知自定义状态误判成平台枚举。
    """
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return value
    mapped = _STATUS_ALIASES.get(text)
    if mapped is not None:
        return mapped
    mapped = _STATUS_ALIASES_LOWER.get(text.lower())
    return mapped if mapped is not None else value


def parse_fields(text):
    """把 '- **字段**: 值' 列表解析成 dict（键统一为内部中文 canonical）。

    - 英文/中文字段名都识别，归一到中文 canonical 键（同键混写时后者覆盖前者）；
    - `状态` 字段的英文枚举值归一到中文 canonical（中文/未知值原样）；
    - 其他字段的值不做任何翻译（用例正文按任务语言书写，原样透传）。
    """
    fields = {}
    for m in FIELD_RE.finditer(text):
        key = _canonical_field(m.group(1).strip())
        value = m.group(2).strip()
        if key == "状态":
            value = _canonical_status_value(value)
        fields[key] = value
    return fields


def norm_status(value):
    """状态字段归一化：模板未填写时是 '未执行 / 通过 / ...'，取第一项。

    第一段再经 `_STATUS_ALIASES` 归一（英文 `Not run / Pass / ...` 同样取第一项并
    映射回中文 canonical）；未知值保留第一段原文，不丢失。
    """
    if not value:
        return "未执行"
    return _canonical_status_value(value.split("/")[0].strip())


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


def _field_lang(text):
    """文件主语言：按已登记字段行的语言计数（英文写法 vs 中文 canonical），平局按 zh。"""
    zh = en = 0
    for m in FIELD_RE.finditer(text):
        name = m.group(1).strip()
        if name in _FIELD_ZH_NAMES:
            zh += 1
        elif _FIELD_ALIASES.get(name) in _FIELD_ZH_NAMES:
            en += 1
    return "en" if en > zh else "zh"


def _target_field_lang(text, canonical):
    """目标字段的写回语言与实际字段名。

    优先级：目标字段只在英文写法里出现 → en；只在中文写法里出现 → zh；
    两边都有 / 都不存在（混写或缺失）→ 文件主语言 `_field_lang`（平局按 zh）。
    英文侧返回文件里实际使用的写法（保留作者用词），字段缺失时用 `_FIELD_EN` 的规范英文键。
    """
    zh_hit = en_hit = False
    en_name = ""
    for m in FIELD_RE.finditer(text):
        name = m.group(1).strip()
        if name == canonical:
            zh_hit = True
        elif _FIELD_ALIASES.get(name) == canonical:
            en_hit = True
            en_name = name
    if en_hit and not zh_hit:
        return "en", en_name
    if zh_hit and not en_hit:
        return "zh", canonical
    if _field_lang(text) == "en":
        return "en", en_name or _FIELD_EN.get(canonical, canonical)
    return "zh", canonical


def _status_value_in_lang(value, lang):
    """状态值按目标语言写回：先归一到中文 canonical，再取 zh/en 写法；未知值原样。"""
    canonical = _canonical_status_value(value)
    if canonical in _STATUS_EN:
        return _STATUS_EN[canonical] if lang == "en" else canonical
    return value


def _severity_value_in_lang(value, lang):
    """严重程度值按目标语言写回：先归一到中文 canonical，再取 zh/en 写法；未知值原样。"""
    canonical = severity_level(value)
    if canonical in _SEVERITY_EN:
        return _SEVERITY_EN[canonical] if lang == "en" else canonical
    return value


def set_md_field(path, field, value):
    """改写 md 中 `**field**: 值`（含 '- **field**' 前缀形式）一行。

    字段名先经 `_FIELD_ALIASES` 归一到内部中文 canonical；写回语言跟随**目标字段已有
    写法**（英文行 → 英文键 + 英文值；中文行 → 中文键 + 中文值）。目标字段缺失或
    中英两种写法并存时跟随文件主语言（`_field_lang`，平局按 zh）。只有 `状态` 与
    `严重程度` 两个字段的值做语言换算（其他字段值原样写入：时间/环境标签/摘要等）。
    行不存在时按目标语言在文末追加。保留原行前缀/格式/编码/换行。返回是否写入成功
    （文件不存在/读空返回 False）。
    """
    text = read_text(path)
    if not text:
        return False
    canonical = _FIELD_ALIASES.get(field, field)
    lang, write_field = _target_field_lang(text, canonical)
    write_value = value
    if canonical == "状态" and isinstance(value, str):
        write_value = _status_value_in_lang(value, lang)
    elif canonical == "严重程度" and isinstance(value, str):
        write_value = _severity_value_in_lang(value, lang)
    # 只匹配目标字段的行；保留原行前缀（'- ' 或 ''）
    pattern = re.compile(r"^(\s*(?:-\s*)?\*\*" + re.escape(write_field) + r"\*\*\s*[:：]\s*).*$",
                         re.M)
    new_line = r"\g<1>" + write_value
    if pattern.search(text):
        text = pattern.sub(new_line, text)
    else:
        text = text.rstrip("\n") + f"\n\n- **{write_field}**: {write_value}\n"
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


def git_recent_commits(project_dir, limit=30):
    """摘录最近 limit 条 git 提交（提交时间倒序，逐条保留「提交 → 变更文件」归属）。

    返回 {"ok": True, "commits": [{"hash": 短hash, "date": "YYYY-MM-DD",
          "subject": 标题, "files": [本次提交的变更文件相对路径, ...]}, ...]}；
    非 git 仓库/git 不可用/空仓库返回 {"ok": False, "error": "..."}（调用方静默降级）。

    与 git_log_changes 的区别：不看日期范围、按条数取最近的提交，且不把文件摊平
    ——探索任务要按「功能」聚类最近改动，必须知道每个文件是哪次提交改的。
    提交块以 \\x00 分隔（文件名不会含 NUL），块首行是 TAB 分隔的 hash/日期/标题
    （标题里可能有空格，故用 TAB 而非空格分隔）。
    """
    cmd = ["git", "-C", project_dir, "-c", "core.quotepath=false", "log",
           "-n", str(int(limit)),
           "--pretty=format:%x00%h%x09%ad%x09%s", "--date=short", "--name-only"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=20)
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "error": f"git 不可用: {e}"}
    if out.returncode != 0:
        return {"ok": False, "error": (out.stderr or "").strip()[:300]}
    commits = []
    for blk in out.stdout.split("\x00"):
        lines = [ln for ln in blk.splitlines() if ln.strip()]
        if not lines:
            continue
        parts = lines[0].split("\t", 2)
        if len(parts) < 3:
            continue          # 头部形态异常：整块跳过，绝不产出半条记录
        files = []
        for ln in lines[1:]:
            if ln not in files:   # 同一提交内同名文件（重命名/多根路径）只留一次
                files.append(ln)
        commits.append({"hash": parts[0], "date": parts[1],
                        "subject": parts[2], "files": files})
    return {"ok": True, "commits": commits}

