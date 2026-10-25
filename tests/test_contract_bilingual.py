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
- `set_md_field` 多行同名字段：与 Node 同为全替换（KB-20）；
- `ROUNDS.md` 执行统计行：zh 原语法零 churn、en 同义写法接受（共享 `rounds_stats_cases.json`，
  KB-21），以及英文统计行经 `server.parse_rounds` 的端到端解析；
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


def _load_json(name):
    with open(os.path.join(BASE, name), encoding="utf-8") as f:
        return json.load(f)


# ROUNDS.md 执行统计行的共享用例表：Python / Node 读同一份（唯一语法真源）。
# `passed == null` ⇒ 整条不匹配；`skipped == null` ⇒ 可选的跳过段缺失（组 3 无值）。
ROUNDS_STATS = _load_json("rounds_stats_cases.json")


@pytest.fixture(scope="module")
def server_mod():
    """延迟导入 server.py：导入即构造 boot_gate Runner 单例，只给 ROUNDS 用例用。"""
    import server
    return server


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


@pytest.mark.parametrize("case", EXPECTED["severityLevels"], ids=[
    "empty" if not c["input"] else c["input"] for c in EXPECTED["severityLevels"]
])
def test_severity_level_aliases(case):
    """严重程度等级归一：中文 canonical 原样、英文（含大小写/空白）→ 中文 canonical、
    无法识别的自定义值 → 空串（不猜译，界面按「未分级」处理）。"""
    assert lib.severity_level(case["input"]) == case["expected"]


def test_severity_field_value_not_canonicalized_by_parse_fields():
    """`parse_fields` 只归一**状态**值：严重程度值原样透传（英文文件是 `High`）——等级
    归一发生在 scan/detail 展示层（`severity_level`），不改双语解析契约的存量行为。"""
    assert lib.parse_fields(_read("en/bug_report.md"))["严重程度"] == "High"
    assert lib.severity_level("High") == "高"


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


# ---------- ROUNDS.md 执行统计行：双端共享用例表（KB-21） ----------

@pytest.mark.parametrize("case", ROUNDS_STATS, ids=[
    "case-%d" % i for i in range(len(ROUNDS_STATS))])
def test_exec_stat_re_bilingual_acceptance(case, server_mod):
    """共享用例表是唯一语法真源：中文原语法零 churn（`通过：16` 仍不匹配），
    英文 pass/passed、fail/failed、skip/skipped 大小写不敏感且允许可选冒号。"""
    m = server_mod.EXEC_STAT_RE.search(case["line"])
    if case["passed"] is None:
        assert m is None, "不应匹配: %r" % case["line"]
        return
    assert m is not None, "应匹配: %r" % case["line"]
    assert int(m.group(1)) == case["passed"], case["line"]
    assert int(m.group(2)) == case["failed"], case["line"]
    skipped = None if m.group(3) is None else int(m.group(3))
    assert skipped == case["skipped"], case["line"]


def test_parse_rounds_english_stats(tmp_path, server_mod):
    """端到端：`### 第 1 轮` 小节 + 英文统计行 + 角度表行 → 与 Node parseRounds 同值。"""
    shutil.copyfile(os.path.join(BASE, "rounds_en.md"),
                    os.path.join(str(tmp_path), "ROUNDS.md"))
    assert server_mod.parse_rounds(str(tmp_path)) == [{
        "round": 1,
        "time": "2026-10-24 10:00",
        "angle": "边界",
        "cases": 5,
        "new_bugs": 1,
        "passed": 16,
        "failed": 0,
        "skipped": 2,
    }]
