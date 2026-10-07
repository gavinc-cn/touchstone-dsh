#!/usr/bin/env python3
"""agents.py 单测（2026-09-13 批次）：agent 归族、skill 目录扫描与 frontmatter
解析、scan_agents 虚拟条目追加。

零外部依赖：真实安装目录不触碰——skill 扫描全部在 tmp_path 内构造，
scan_agents 用 monkeypatch 打桩 which/search/version 探测。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import agents


# ---------- agent_family ----------

@pytest.mark.parametrize("path,expected", [
    ("dsh-plugin:/usr/bin/dsh", "dsh_plugin"),        # 插件前缀优先于 basename
    # 2026-10-03（路线 A P1）：默认族由 kimi 改为 dsh_plugin——产品入口收敛为
    # dsh 插件形态，未配置/未知 agent_path 都按 dsh_plugin 处置（方案 §七 D1/D2）
    ("", "dsh_plugin"),
    ("/usr/bin/unknown", "dsh_plugin"),               # 未知回退 dsh_plugin 默认策略
    # P7b（2026-10-03）：kimi/opencode/claude/hermes/deepseek(dsh CLI) 五族退场，
    # 旧可执行名与 kimi-web:/opencode-web: 旧虚拟前缀一律归 RETIRED_FAMILY（起跑报错）
    ("/usr/bin/kimi", "retired"),
    ("kimi-web:/usr/bin/kimi", "retired"),            # 旧虚拟前缀优先于 basename 判定
    ("opencode-web:/usr/bin/opencode", "retired"),
    ("/opt/bin/opencode", "retired"),
    ("/opt/bin/claude", "retired"),
    ("/opt/bin/hermes", "retired"),
    ("/opt/bin/deepseek-harness", "retired"),
    ("/usr/bin/dsh", "retired"),                      # dsh CLI（headless）已退场
])
def test_agent_family_mapping(path, expected):
    """归族：dsh-plugin 前缀→dsh_plugin；空/未知路径→dsh_plugin 默认族；
    五族旧可执行名与旧虚拟前缀→retired（与 agents.agent_family 现实现一致）。"""
    assert agents.agent_family(path) == expected


def test_skill_dirs_dsh_plugin_shares_agents_skills():
    """dsh_plugin 的 skill 目录：dsh 私有根 + `.agents/skills`（与 dsh-skill-filesystem
    实测扫描根一致）；表已收敛为仅此一族（产品只剩 dsh 插件形态）。"""
    user_dirs, proj_dirs = agents.SKILL_DIRS_BY_FAMILY["dsh_plugin"]
    assert "~/.agents/skills" in user_dirs and "~/.dsh/skills" in user_dirs
    assert ".agents/skills" in proj_dirs and ".dsh/skills" in proj_dirs
    assert set(agents.SKILL_DIRS_BY_FAMILY) == {"dsh_plugin"}
    assert agents.scan_skills("/opt/bin/dsh", "/tmp") == []


# ---------- SKILL.md 解析 ----------

def test_parse_skill_md_frontmatter(tmp_path):
    """frontmatter 正常解析出 name/description。"""
    p = tmp_path / "SKILL.md"
    p.write_text("---\nname: my-skill\ndescription: 做某事\n---\n\n正文\n",
                 encoding="utf-8")
    assert agents._parse_skill_md(str(p), "fallback") == ("my-skill", "做某事")


def test_parse_skill_md_defaults(tmp_path):
    """缺 name 用调用方 fallback；缺 description 为空串。"""
    p = tmp_path / "SKILL.md"
    p.write_text("---\ndescription: 只有描述\n---\n", encoding="utf-8")
    assert agents._parse_skill_md(str(p), "dir_name") == ("dir_name", "只有描述")
    p2 = tmp_path / "SKILL2.md"
    p2.write_text("---\nname: only-name\n---\n", encoding="utf-8")
    assert agents._parse_skill_md(str(p2), "x") == ("only-name", "")


def test_parse_skill_md_no_frontmatter_falls_back_to_head(tmp_path):
    """无 frontmatter 时退化为头部全文搜索（容错）。"""
    p = tmp_path / "SKILL.md"
    p.write_text("# 标题\nname: head-name\n", encoding="utf-8")
    assert agents._parse_skill_md(str(p), "fb") == ("head-name", "")


def test_parse_skill_md_description_truncated(tmp_path):
    """description 截断到 200 字符（避免撑爆下拉）。"""
    p = tmp_path / "SKILL.md"
    p.write_text("---\nname: t\ndescription: " + "x" * 300 + "\n---\n",
                 encoding="utf-8")
    _name, desc = agents._parse_skill_md(str(p), "fb")
    assert len(desc) == 200


def test_parse_skill_md_unreadable_returns_none(tmp_path):
    """文件不存在返回 None（调用方跳过该条）。"""
    assert agents._parse_skill_md(str(tmp_path / "nope.md"), "fb") is None


# ---------- skill 目录扫描 ----------

def _mk_skill(dirpath, name=None, desc=""):
    """在指定目录下放一个 SKILL.md。"""
    os.makedirs(dirpath, exist_ok=True)
    head = f"---\nname: {name}\n" if name else "---\n"
    with open(os.path.join(dirpath, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(head + (f"description: {desc}\n" if desc else "") + "---\n")


def test_scan_skill_dir_depth_limit(tmp_path):
    """扫描深度上限 2：第 2 层的 SKILL.md 收，第 3 层的不收。"""
    root = str(tmp_path / "skills")
    _mk_skill(os.path.join(root, "top"), "top")            # rel=1
    _mk_skill(os.path.join(root, "cat", "mid"), "mid")     # rel=2
    _mk_skill(os.path.join(root, "a", "b", "deep"), "deep")  # rel=3 → 超出
    got = agents._scan_skill_dir(root, "user")
    names = sorted(s["name"] for s in got)
    assert names == ["mid", "top"]
    assert all(s["source"] == "user" for s in got)


def test_scan_skill_dir_missing_root(tmp_path):
    """目录不存在返回空列表（不抛异常）。"""
    assert agents._scan_skill_dir(str(tmp_path / "nope"), "user") == []
    assert agents._scan_skill_dir("", "user") == []


# ---------- scan_skills（用户级 + 项目级合并） ----------

def test_scan_skills_empty_agent_path():
    """空 agent_path 返回空列表。"""
    assert agents.scan_skills("") == []
    assert agents.scan_skills("   ") == []


def test_scan_skills_dsh_has_no_dirs(tmp_path):
    """CLI 形态 dsh 已退场（归 retired），本表无该族条目：恒返回空。"""
    assert agents.scan_skills("/opt/bin/dsh", str(tmp_path)) == []


def test_scan_skills_merge_and_project_override(tmp_path, monkeypatch):
    """用户级 + 项目级合并；同名项目级覆盖用户级；结果按 name 排序。"""
    user_root = tmp_path / "user_skills"
    _mk_skill(str(user_root / "alpha"), "alpha", "用户版 alpha")
    _mk_skill(str(user_root / "beta"), "beta", "用户版 beta")
    proj_dir = tmp_path / "proj"
    _mk_skill(str(proj_dir / ".agents" / "skills" / "alpha"), "alpha",
              "项目版 alpha")
    monkeypatch.setitem(agents.SKILL_DIRS_BY_FAMILY, "dsh_plugin",
                        ((str(user_root),), (".agents/skills",)))
    rows = agents.scan_skills("dsh-plugin:/opt/bin/dsh", str(proj_dir))
    assert [s["name"] for s in rows] == ["alpha", "beta"]
    by = {s["name"]: s for s in rows}
    assert by["alpha"]["description"] == "项目版 alpha"   # 项目级覆盖
    assert by["alpha"]["source"] == "project"
    assert by["beta"]["source"] == "user"


# ---------- scan_agents（产品入口单条目） ----------

def test_scan_agents_single_plugin_entry(monkeypatch):
    """P7b B7（2026-10-04）：扫描面收敛为**只回一条**产品入口「dsh（插件·进程内）」
    （`dsh-plugin:` 前缀，path/version 取自扫到的 dsh 可执行）。

    裸 dsh CLI 行**不再返回**：它属退场族（basename == "dsh" → `retired`，起跑报
    `RETIRED_MSG`），列进「智能体」下拉是纯误选陷阱（用户报告「同一个 dsh 出现两条」）。
    """
    found = {"/opt/bin/dsh"}
    monkeypatch.setattr(agents.shutil, "which",
                        lambda b: next((p for p in found
                                        if os.path.basename(p) == b), None))
    monkeypatch.setattr(agents, "_search_extra", lambda name: None)
    monkeypatch.setattr(agents, "_probe_version", lambda p: "v-test")
    rows = agents.scan_agents()
    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == agents.PLUGIN_ENTRY_NAME == "dsh（插件·进程内）"
    assert row["path"] == "dsh-plugin:/opt/bin/dsh"
    assert row["version"] == "v-test" and row["found"] is True
    assert agents.agent_family(row["path"]) == "dsh_plugin"
    # 已退场族的条目彻底消失（旧 web·serve 虚拟条目 + 裸 dsh CLI 行）
    assert not [r for r in rows if not r["path"].startswith("dsh-plugin:")]
    assert not [r for r in rows if "web·实时" in r["name"] or "serve·实时" in r["name"]]
    # 裸 dsh 可执行仍归退场族（正是不该出现在下拉里的理由）
    assert agents.agent_family("/opt/bin/dsh") == agents.RETIRED_FAMILY


def test_scan_agents_no_entries_when_dsh_missing(monkeypatch):
    """dsh 未找到时仍回**同一条**found=False 条目（下拉不出现裸 dsh、也不出现别的族）。"""
    monkeypatch.setattr(agents.shutil, "which", lambda b: None)
    monkeypatch.setattr(agents, "_search_extra", lambda name: None)
    rows = agents.scan_agents()
    assert [r["name"] for r in rows] == ["dsh（插件·进程内）"]
    assert rows[0]["found"] is False
    assert rows[0]["path"] == "" and rows[0]["version"] == ""
