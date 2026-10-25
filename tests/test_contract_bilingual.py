#!/usr/bin/env python3
"""T14 机器契约双语解析器单测（Python 侧）。

机器契约 = `status.md` / `case.md` / `bug_report.md` 的字段名与状态值：
英文模板只允许换 IO 层写法，内部 canonical 永远是现有中文常量。本文件与
`backend/test/contract-bilingual.test.mjs` **读取同一组 fixture 与同一份 expected.json**
（`tests/fixtures/bilingual/`），两端任何语义分叉都会在同一行失败。

覆盖：
- zh 旧文件：解析结果 = 改前基线（expected.json 的 zh 档由改前 lib.py 真跑生成）；
- en 新文件：字段名归一到中文 canonical 键、状态值归一到中文 canonical 值；
- mixed 混写：同 canonical 键后者覆盖，两端一致；
- `set_md_field`：中文文件写中文、英文文件写英文键+英文值、混写跟随、字段缺失按文件主语言追加；
- 端到端：英文 status.md 经 `cases_all_passed` / `mark_cases_retest` 真实消费链路读回 canonical。
"""
import json
import os
import shutil
import sys

import pytest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO, "backend_py"))

import lib  # noqa: E402

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "bilingual")


def _expected():
    with open(os.path.join(BASE, "expected.json"), encoding="utf-8") as f:
        return json.load(f)


EXPECTED = _expected()


def _read(rel):
    with open(os.path.join(BASE, rel), encoding="utf-8") as f:
        return f.read()


# ---------- 解析：zh / en / mixed 三档 ----------

@pytest.mark.parametrize("rel", sorted(EXPECTED["parseStatus"]))
def test_parse_status_md_canonical(rel):
    """status.md 三档解析结果一致归一到中文 canonical（英文档不许漏读字段）。"""
    assert lib.parse_status_md(os.path.join(BASE, rel)) == EXPECTED["parseStatus"][rel]


@pytest.mark.parametrize("rel", sorted(EXPECTED["parseFields"]))
def test_parse_fields_canonical_keys(rel):
    """字段名归一到中文 canonical 键；混写时后者覆盖；英文状态值归一到中文。"""
    assert lib.parse_fields(_read(rel)) == EXPECTED["parseFields"][rel]


@pytest.mark.parametrize("case", EXPECTED["normStatus"], ids=[
    "empty" if not c["input"] else c["input"] for c in EXPECTED["normStatus"]
])
def test_norm_status_aliases(case):
    """状态值归一：多选项取第一段，英文（含大小写/多种写法）→ 中文 canonical，未知值不丢。"""
    assert lib.norm_status(case["input"]) == case["expected"]


def test_zh_parse_results_are_pre_change_baseline():
    """zh 档的期望值就是改前基线（生成脚本用改前 lib.py 逐字段核对过）——这里再钉住
    一个最容易回归的形态：中文多选项模板值取第一项、字段值原样。"""
    assert lib.parse_fields("- **状态**: 未执行 / 通过 / 失败\n") == {
        "状态": "未执行 / 通过 / 失败"}
    assert lib.norm_status("未执行 / 通过 / 失败") == "未执行"


# ---------- 写回：按文件已有语言 ----------

def _copy_fixture(tmp_path, rel):
    dst = os.path.join(str(tmp_path), os.path.basename(rel))
    shutil.copyfile(os.path.join(BASE, rel), dst)
    return dst


@pytest.mark.parametrize("case", EXPECTED["setMdField"], ids=[
    c["fixture"] + ":" + c["field"] for c in EXPECTED["setMdField"]])
def test_set_md_field_writes_file_language(tmp_path, case):
    """中文文件写中文行；英文文件写英文键+英文值；混写跟目标字段/文件主语言；缺失追加。"""
    path = _copy_fixture(tmp_path, case["fixture"]) if case["expectedText"] is not None \
        else os.path.join(str(tmp_path), case["fixture"])
    assert lib.set_md_field(path, case["field"], case["value"]) is case["expectedHit"]
    if case["expectedText"] is None:
        assert not os.path.exists(path)
        return
    with open(path, encoding="utf-8") as f:
        assert f.read() == case["expectedText"]


def test_set_md_field_missing_file_returns_false(tmp_path):
    """文件不存在：返回 False 且不创建文件（存量行为不变）。"""
    path = os.path.join(str(tmp_path), "nope.md")
    assert lib.set_md_field(path, "状态", "通过") is False
    assert not os.path.exists(path)


# ---------- 端到端：英文文件走真实消费链路 ----------

def test_english_status_md_flows_through_retest_and_pass_check(tmp_path):
    """英文 status.md → `cases_all_passed` 读回通过；`mark_cases_retest` 用英文键+英文值
    改写后仍能被 `parse_status_md` 读回「需要复测」（状态聚合/复测判定消费链路）。"""
    root = os.path.join(str(tmp_path), "free_style")
    case_dir = os.path.join(root, "mod_login", "FS0001_Login timeout")
    os.makedirs(case_dir)
    sp = os.path.join(case_dir, "status.md")
    with open(sp, "w", encoding="utf-8") as f:
        f.write("# FS0001 Status\n\n- **Status**: Pass\n- **Last run time**: 2026-10-01 10:00\n")

    assert lib.cases_all_passed(root, ["FS0001"]) is True
    assert lib.mark_cases_retest(root, ["FS0001"]) == ["FS0001"]

    with open(sp, encoding="utf-8") as f:
        text = f.read()
    assert "- **Status**: Needs retest" in text
    assert "- **状态**" not in text
    assert lib.parse_status_md(sp)["status"] == "需要复测"
    assert lib.cases_all_passed(root, ["FS0001"]) is False
