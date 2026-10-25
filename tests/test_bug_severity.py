#!/usr/bin/env python3
"""bug 报告严重程度等级（2026-10-25「测试报告等级划分」批次，Python 侧）。

双端镜像：Node 侧 `backend/test/casescan.test.mjs`（scan/排序）与
`backend/test/bug-severity.test.mjs`（端点）。覆盖：
  ① 归一口径 `lib.severity_level`：中文 canonical / 英文 High·Medium·Low（含大小写、
     空白）→ 中文；未知自定义值 → 空串（不猜译；双语共享表
     `tests/fixtures/bilingual/expected.json::severityLevels` 由
     `test_contract_bilingual` 双端同读，本文件只补 scan/端点层）；
  ② `scan_bugs` 每项带 `severity`（缺失/无法识别 → ""）；
  ③ `list_project_bugs` 排序：历史报告（复测通过/已拒绝）沉底 →
     高 → 中 → 低 → 未分级 → 同级保持时间倒序；
  ④ 端点：GET 列表/详情带 severity（英文报告 `High` → canonical `高`）；
     POST `.../bugs/<dir>/severity` 200 写回（中文报告写「高」/英文报告写 `High`）、
     非法值 400（`?lang=en` 返回英文文案）、报告不存在 404、项目越权/不存在 404。
"""
import json
import os

import pytest

import lib
import server
from serverfixture import isolated_server  # noqa: F401  （pytest 夹具，模块级共享）


# --------------------------------------------------------------------------
# ① / ② scan 层
# --------------------------------------------------------------------------

def _seed_bug(root, dir_name, text):
    d = os.path.join(str(root), dir_name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "bug_report.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def test_severity_level_zh_en_unknown():
    """归一：中文原样、英文大小写/空白不敏感、未知自定义值不猜译（返回空串）。"""
    assert lib.severity_level("高") == "高"
    assert lib.severity_level("High") == "高"
    assert lib.severity_level("  medium ") == "中"
    assert lib.severity_level("LOW") == "低"
    assert lib.severity_level("") == ""
    assert lib.severity_level("紧急") == ""
    assert lib.severity_level(None) == ""


def test_scan_bugs_carries_severity(tmp_path):
    """扫描结果每项带 canonical 等级；缺失/自定义值 → 空串（界面按「未分级」）。"""
    root = tmp_path / "bug_report"
    root.mkdir()
    _seed_bug(root, "20260101_0100_FS_zh", "# zh\n\n- **严重程度**: 高\n")
    _seed_bug(root, "20260101_0200_FS_en", "# en\n\n- **Severity**: Medium\n")
    _seed_bug(root, "20260101_0300_FS_none", "# none\n")
    _seed_bug(root, "20260101_0400_FS_custom", "# custom\n\n- **严重程度**: 紧急\n")
    bugs = {b["dir"]: b for b in server.scan_bugs(str(root))}
    assert bugs["20260101_0100_FS_zh"]["severity"] == "高"
    assert bugs["20260101_0200_FS_en"]["severity"] == "中"
    assert bugs["20260101_0300_FS_none"]["severity"] == ""
    assert bugs["20260101_0400_FS_custom"]["severity"] == ""


def test_list_project_bugs_sorted_by_severity(tmp_path, monkeypatch):
    """历史沉底 → 高→中→低→未分级；同级内保持扫描出的时间倒序（稳定排序）。"""
    root = tmp_path / "bug_report"
    root.mkdir()
    _seed_bug(root, "20260101_0000_FS_low_old", "# \n\n- **严重程度**: 低\n")
    _seed_bug(root, "20260101_0100_FS_high_new", "# \n\n- **严重程度**: 高\n")
    _seed_bug(root, "20260101_0200_FS_low_new", "# \n\n- **严重程度**: 低\n")
    _seed_bug(root, "20260101_0300_FS_none_new", "# 无等级\n")
    _seed_bug(root, "20260101_0400_FS_medium_new",
              "# \n\n- **状态**: 待分析\n- **严重程度**: 中\n")
    _seed_bug(root, "20260101_0500_FS_hist_pass",
              "# \n\n- **状态**: 复测通过\n- **严重程度**: 高\n")
    _seed_bug(root, "20260101_0600_FS_hist_reject",
              "# \n\n- **状态**: 已拒绝\n- **严重程度**: 中\n")
    monkeypatch.setattr(server.db, "list_tasks", lambda pid: [])
    bugs = server.list_project_bugs({"id": 1, "bug_dir": str(root)})
    assert [b["dir"] for b in bugs] == [
        "20260101_0100_FS_high_new",
        "20260101_0400_FS_medium_new",
        "20260101_0200_FS_low_new",      # 同级（低）内时间倒序：02:00 在 00:00 前
        "20260101_0000_FS_low_old",
        "20260101_0300_FS_none_new",     # 未分级在最后
        "20260101_0500_FS_hist_pass",    # 历史组：高在前
        "20260101_0600_FS_hist_reject",
    ]
    assert [b["severity"] for b in bugs] == ["高", "中", "低", "低", "", "高", "中"]


# --------------------------------------------------------------------------
# ④ 端点（隔离实例）
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def srv(isolated_server):
    """隔离实例 + 一个项目；bug_report 目录按需在各用例内 seed。"""
    isolated_server.pid = isolated_server.create_project(
        isolated_server.admin, "bug 等级契约项目")
    isolated_server.bug_root = os.path.join(isolated_server.work_dir, "bug_report")
    os.makedirs(isolated_server.bug_root, exist_ok=True)
    return isolated_server


def _bugdir(srv, name):
    return os.path.join(srv.bug_root, name)


def _list(srv):
    code, d = srv.admin.json(f"/api/projects/{srv.pid}/bugs")
    assert code == 200, d
    return d


def _post(srv, dir_name, body, suffix=""):
    return srv.admin.json(
        f"/api/projects/{srv.pid}/bugs/{dir_name}/severity{suffix}", "POST", body)


def test_get_list_and_detail_carry_severity(srv):
    """列表/详情都带 canonical 等级；英文报告 High 归一到 高；列表按等级排序。"""
    _seed_bug(srv.bug_root, "20260201_0100_FS_sev_none", "# 未分级\n\n- **状态**: 待分析\n")
    _seed_bug(srv.bug_root, "20260201_0200_FS_sev_high",
              "# 高\n\n- **状态**: 待分析\n- **严重程度**: 高\n")
    _seed_bug(srv.bug_root, "20260201_0300_FS_sev_en",
              "# en\n\n- **Status**: To analyze\n- **Severity**: Medium\n")
    bugs = _list(srv)
    by_dir = {b["dir"]: b for b in bugs}
    assert by_dir["20260201_0200_FS_sev_high"]["severity"] == "高"
    assert by_dir["20260201_0300_FS_sev_en"]["severity"] == "中"
    assert by_dir["20260201_0100_FS_sev_none"]["severity"] == ""
    dirs = [b["dir"] for b in bugs]
    assert dirs.index("20260201_0200_FS_sev_high") < dirs.index("20260201_0300_FS_sev_en"), dirs
    assert dirs.index("20260201_0300_FS_sev_en") < dirs.index("20260201_0100_FS_sev_none"), dirs

    code, detail = srv.admin.json(
        f"/api/projects/{srv.pid}/bugs/20260201_0300_FS_sev_en")
    assert code == 200, detail
    assert detail["severity"] == "中"


def test_post_severity_writes_zh_report(srv):
    """中文报告：写回 `- **严重程度**: 高`（中文 canonical）。"""
    name = "20260301_0100_FS_set_zh"
    _seed_bug(srv.bug_root, name, "# 写回\n\n- **状态**: 待分析\n- **严重程度**: 中\n")
    code, d = _post(srv, name, {"severity": "高"})
    assert code == 200 and d == {"ok": True, "severity": "高"}, d
    text = open(os.path.join(_bugdir(srv, name), "bug_report.md"), encoding="utf-8").read()
    assert "- **严重程度**: 高" in text
    assert {b["dir"]: b for b in _list(srv)}[name]["severity"] == "高"


def test_post_severity_writes_en_report(srv):
    """英文报告：写回 `- **Severity**: High`（按文件语言取英文值）。"""
    name = "20260301_0200_FS_set_en"
    _seed_bug(srv.bug_root, name,
              "# en write\n\n- **Status**: To analyze\n- **Severity**: Low\n")
    code, d = _post(srv, name, {"severity": "高"})
    assert code == 200 and d == {"ok": True, "severity": "高"}, d
    text = open(os.path.join(_bugdir(srv, name), "bug_report.md"), encoding="utf-8").read()
    assert "- **Severity**: High" in text
    assert "高" not in text.split("\n")[0]  # 标题未动


def test_post_severity_accepts_english_alias(srv):
    """入参兼容 high/medium/low（大小写不敏感），回执与落盘都是中文 canonical。"""
    name = "20260301_0300_FS_alias"
    _seed_bug(srv.bug_root, name, "# alias\n\n- **严重程度**: 高\n")
    code, d = _post(srv, name, {"severity": "medium"})
    assert code == 200 and d["severity"] == "中", d
    text = open(os.path.join(_bugdir(srv, name), "bug_report.md"), encoding="utf-8").read()
    assert "- **严重程度**: 中" in text


def test_post_severity_invalid_400_and_i18n(srv):
    """非法值 400（不静默丢弃）；`?lang=en` 时错误文案走英文词表。"""
    name = "20260301_0400_FS_bad"
    _seed_bug(srv.bug_root, name, "# bad\n\n- **严重程度**: 高\n")
    code, d = _post(srv, name, {"severity": "urgent"})
    assert code == 400 and "严重程度不合法" in d.get("error", ""), d
    code, d = _post(srv, name, {"severity": 123})
    assert code == 400, d
    code, d = _post(srv, name, {}, "?lang=en")
    assert code == 400 and d.get("error") == "Invalid severity (only High / Medium / Low allowed)", d
    # 失败不得改文件
    text = open(os.path.join(_bugdir(srv, name), "bug_report.md"), encoding="utf-8").read()
    assert "- **严重程度**: 高" in text


def test_post_severity_missing_bug_404(srv):
    code, d = _post(srv, "20260101_0000_FS_nope", {"severity": "高"})
    assert code == 404 and d.get("error") == "bug not found", d


def test_post_severity_unknown_project_404(srv):
    code, d = srv.admin.json(
        "/api/projects/999999/bugs/20260101_0000_FS_x/severity", "POST", {"severity": "高"})
    assert code == 404 and d.get("error") == "project not found", d
