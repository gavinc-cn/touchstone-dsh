#!/usr/bin/env python3
"""lib.py 单测（2026-09-13 批次）：案例库/bug 报告解析、状态改写、用例定位、
运行目录与 .gitignore 维护、固化判定、git 摘录。

零外部依赖：git 用例在 tmp_path 的一次性仓库内真跑（不碰项目仓库），
其余全部文件系统隔离（tmp_path）。
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lib


def _write(path, text):
    """建父目录并写入文件（测试数据构造）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _mk_case(root, sub, cid, name, status="未执行", verify=False):
    """造一个用例目录（status.md 必建，verify.py 可选=固化标记）。"""
    d = os.path.join(root, sub, f"{cid}_{name}")
    _write(os.path.join(d, "status.md"), f"- **状态**: {status}\n")
    if verify:
        _write(os.path.join(d, "verify.py"), "print('ok')\n")
    return d


# ---------- 字段解析与状态归一 ----------

def test_parse_fields_variants():
    """`- **字段**: 值`、无前缀与全角冒号变体均能解析。"""
    text = "- **状态**: 失败\n**原因**：超时\n\n其他正文"
    f = lib.parse_fields(text)
    assert f["状态"] == "失败" and f["原因"] == "超时"


def test_norm_status_default_and_first_item():
    """状态归一化：空→未执行；模板多选项取第一项。"""
    assert lib.norm_status("") == "未执行"
    assert lib.norm_status("通过 / 失败 / 跳过") == "通过"


def test_parse_status_md_fields(tmp_path):
    """status.md 解析出状态/时间/轮次等字段（缺字段给空串）。"""
    d = _mk_case(str(tmp_path), "m", "FS0001", "登录")
    sp = os.path.join(d, "status.md")
    _write(sp, "- **状态**: 需要复测\n- **最近执行时间**: 2026-09-01\n"
               "- **执行轮次**: 3\n")
    r = lib.parse_status_md(sp)
    assert r["status"] == "需要复测" and r["last_run"] == "2026-09-01"
    assert r["round"] == "3" and r["fail_reason"] == ""


# ---------- 状态改写 ----------

def test_set_md_field_rewrites_existing_line(tmp_path):
    """已有字段行被改写，其他内容与 `- ` 前缀保留。"""
    p = str(tmp_path / "status.md")
    _write(p, "# 标题\n\n- **状态**: 未执行\n- **执行轮次**: 1\n")
    assert lib.set_md_field(p, "状态", "通过") is True
    text = open(p, encoding="utf-8").read()
    assert "- **状态**: 通过" in text and "- **执行轮次**: 1" in text


def test_set_md_field_appends_when_missing(tmp_path):
    """字段缺失时在文末追加一行。"""
    p = str(tmp_path / "status.md")
    _write(p, "# 标题\n")
    assert lib.set_md_field(p, "状态", "需要复测") is True
    assert "**状态**: 需要复测" in open(p, encoding="utf-8").read()


def test_set_md_field_missing_file_returns_false(tmp_path):
    """文件不存在返回 False（不抛异常）。"""
    assert lib.set_md_field(str(tmp_path / "nope.md"), "状态", "x") is False


# ---------- 用例定位 ----------

def test_find_case_dirs_locates_and_skips_hidden(tmp_path):
    """按 id 定位用例目录；隐藏目录（. 前缀）内的同名用例不参与。"""
    root = str(tmp_path / "free_style")
    _mk_case(root, "mod_a", "FS0001", "甲")
    _mk_case(root, "mod_b", "FS0002", "乙")
    _mk_case(root, ".trash", "FS0003", "隐藏")
    got = lib.find_case_dirs(root, ["FS0001", "FS0003", "FS9999"])
    assert [cid for cid, _ in got] == ["FS0001"]


def test_find_case_dirs_empty_inputs(tmp_path):
    """空集合 / 不存在根目录均返回 []。"""
    assert lib.find_case_dirs(str(tmp_path), []) == []
    assert lib.find_case_dirs(str(tmp_path / "nope"), ["FS0001"]) == []


def test_mark_cases_retest(tmp_path):
    """复测标记：命中用例状态改为「需要复测」并返回 id 列表。"""
    root = str(tmp_path / "free_style")
    _mk_case(root, "m", "FS0001", "甲")
    assert lib.mark_cases_retest(root, ["FS0001"]) == ["FS0001"]
    sp = os.path.join(root, "m", "FS0001_甲", "status.md")
    assert lib.parse_status_md(sp)["status"] == "需要复测"


def test_cases_all_passed(tmp_path):
    """全通过判定：全部「通过」才 True；空集合 False；定位不到算未通过。"""
    root = str(tmp_path / "free_style")
    _mk_case(root, "m", "FS0001", "甲", status="通过")
    _mk_case(root, "m", "FS0002", "乙", status="通过")
    assert lib.cases_all_passed(root, ["FS0001", "FS0002"]) is True
    _mk_case(root, "m", "FS0003", "丙", status="失败")
    assert lib.cases_all_passed(root, ["FS0001", "FS0003"]) is False
    assert lib.cases_all_passed(root, []) is False
    assert lib.cases_all_passed(root, ["FS9999"]) is False


def test_bug_cases_extract_ids(tmp_path):
    """bug_report.md 关联用例 id 去重排序提取（无报告时为空）。"""
    d = str(tmp_path / "bug")
    _write(os.path.join(d, "bug_report.md"),
           "涉及 FS0003 与 FS0001，另 FS0003 重复")
    content, ids = lib.bug_cases(d)
    assert ids == ["FS0001", "FS0003"] and "FS0003" in content
    _content, ids2 = lib.bug_cases(str(tmp_path / "nope"))
    assert ids2 == []


# ---------- 固化判定（script_retest 选型依据） ----------

def test_bug_cases_scripted_all_scripted(tmp_path):
    """全部用例都有 verify.py 才 True；空集合/定位不到为 False（回落 agent 复测）。"""
    root = str(tmp_path / "free_style")
    _mk_case(root, "m", "FS0001", "甲", verify=True)
    _mk_case(root, "m", "FS0002", "乙", verify=True)
    assert lib.bug_cases_scripted(root, ["FS0001", "FS0002"]) is True
    _mk_case(root, "m", "FS0003", "丙", verify=False)
    assert lib.bug_cases_scripted(root, ["FS0001", "FS0003"]) is False
    assert lib.bug_cases_scripted(root, []) is False
    assert lib.bug_cases_scripted(root, ["FS0001", "FS9999"]) is False


# ---------- 运行目录与 .gitignore 维护 ----------

def test_ensure_runtime_dirs_creates_and_gitignores(tmp_path):
    """运行目录创建 + .gitignore 幂等追加（用户已有内容保留、不重复）。"""
    wd = str(tmp_path / "work")
    os.makedirs(wd)
    _write(os.path.join(wd, ".gitignore"), "user_rule/\n")
    lib.ensure_runtime_dirs(wd)
    for name in lib.RUNTIME_DIR_NAMES:
        assert os.path.isdir(os.path.join(wd, name))
    text = open(os.path.join(wd, ".gitignore"), encoding="utf-8").read()
    assert "user_rule/" in text
    for name in lib.RUNTIME_DIR_NAMES:
        assert name + "/" in text
    lib.ensure_runtime_dirs(wd)   # 幂等
    text2 = open(os.path.join(wd, ".gitignore"), encoding="utf-8").read()
    assert text2.count(".web/") == 1


def test_ensure_runtime_dirs_creates_gitignore_when_absent(tmp_path):
    """.gitignore 不存在时会新建并写入忽略项。"""
    wd = str(tmp_path / "work2")
    lib.ensure_runtime_dirs(wd)
    text = open(os.path.join(wd, ".gitignore"), encoding="utf-8").read()
    assert ".web/" in text and ".live/" in text and "board_media/" in text


def test_ensure_gitignore_idempotent(tmp_path):
    """ensure_gitignore：缺失新建、重复调用不重复追加。"""
    d = str(tmp_path / "cases")
    lib.ensure_gitignore(d, ".live/")
    lib.ensure_gitignore(d, ".live/")
    text = open(os.path.join(d, ".gitignore"), encoding="utf-8").read()
    assert text.count(".live/") == 1


# ---------- git 摘录（tmp 一次性仓库真跑） ----------

def _git(repo, *args, env=None):
    """在测试仓库执行 git（身份内联，不依赖全局配置；env 用于固定提交日期）。"""
    e = dict(os.environ)
    if env:
        e.update(env)
    subprocess.run(["git", "-C", repo, "-c", "user.email=t@t",
                    "-c", "user.name=t", *args],
                   check=True, capture_output=True, text=True, env=e)


def test_git_log_changes_returns_commits_and_files(tmp_path):
    """git 仓库内：提交与变更文件（去重排序）；日期范围过滤按提交日期生效。"""
    repo = str(tmp_path / "repo")
    os.makedirs(repo)
    _git(repo, "init", "-q")
    _write(os.path.join(repo, "a.txt"), "1")
    _git(repo, "add", "a.txt")
    _git(repo, "commit", "-q", "-m", "add a",
         env={"GIT_AUTHOR_DATE": "2026-08-01T12:00:00",
              "GIT_COMMITTER_DATE": "2026-08-01T12:00:00"})
    _write(os.path.join(repo, "b.txt"), "2")
    _git(repo, "add", "b.txt")
    _git(repo, "commit", "-q", "-m", "add b",
         env={"GIT_AUTHOR_DATE": "2026-09-01T12:00:00",
              "GIT_COMMITTER_DATE": "2026-09-01T12:00:00"})
    r = lib.git_log_changes(repo)
    assert r["ok"] is True and len(r["commits"]) == 2
    assert r["files"] == ["a.txt", "b.txt"]
    # 范围过滤（固定提交日期，避免依赖"未来日期"的近似解析行为）：
    # since 只含 9 月提交；until 只含 8 月提交
    r2 = lib.git_log_changes(repo, date_from="2026-08-15")
    assert r2["ok"] is True and len(r2["commits"]) == 1
    assert "add b" in r2["commits"][0]
    r3 = lib.git_log_changes(repo, date_to="2026-08-15")
    assert r3["ok"] is True and len(r3["commits"]) == 1
    assert "add a" in r3["commits"][0]


def test_git_log_changes_non_repo_degrades(tmp_path):
    """非 git 目录：ok=False 携带 error（调用方静默降级），不抛异常。"""
    r = lib.git_log_changes(str(tmp_path))
    assert r["ok"] is False and r["error"]
