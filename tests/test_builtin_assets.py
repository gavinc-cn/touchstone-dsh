#!/usr/bin/env python3
"""平台内置 skill 资产（builtin_assets.py）单测：清单校验（含 hook 类型与 register
声明被拒）、四态判定、安装幂等、落点推导、卸载只清自己、越界与目标不支持安全阀。

隔离方式：HOME 指临时目录（用户级 skill 落 $HOME/.dsh/skills），TS_EXT_DIR 指
临时清单根（合成资产，不碰仓库真实资产与真实 HOME）。
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import builtin_assets as ba  # noqa: E402

SKILL_MD = "---\nname: demo-skill\ndescription: 演示\n---\n\n正文\n"


# ---------- 夹具 ----------


@pytest.fixture
def home(tmp_path, monkeypatch):
    """临时 HOME（用户级 skill 目录落在这里）。"""
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def write_ext(root, name, manifest, files=None):
    """在临时清单根写一个资产目录（manifest dict + 文件内容表）。"""
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    for rel, content in (files or {}).items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    (d / "asset.json").write_text(json.dumps(manifest), encoding="utf-8")
    return d


def demo_skill_manifest(files=None):
    """合成 skill 清单（family 取唯一在册的 dsh_plugin）。"""
    return {
        "id": "demo-skill", "name": "演示 skill", "type": "skill",
        "family": "dsh_plugin", "description": "演示用",
        "targets": ["user", "project"],
        "files": files or [{"from": "SKILL.md", "to": "demo-skill/SKILL.md"}],
    }


def load_one(root, monkeypatch, files=None, manifest=None):
    """写一个合成资产并加载为清单对象（多数用例的起手式）。"""
    write_ext(root, "sk", manifest or demo_skill_manifest(), files or {"SKILL.md": SKILL_MD})
    monkeypatch.setenv("TS_EXT_DIR", str(root))
    return ba.load_assets()[0]


# ---------- 清单加载与校验 ----------


@pytest.mark.parametrize("bad,why", [
    ({"id": "demo-skill", "type": "skill", "family": "nope", "targets": ["user"],
      "files": [{"from": "SKILL.md", "to": "SKILL.md"}]}, "family"),
    ({"id": "demo-skill", "type": "skill", "family": "kimi", "targets": ["user"],
      "files": [{"from": "SKILL.md", "to": "SKILL.md"}]}, "family"),
    ({"id": "demo-skill", "type": "skill", "family": "dsh_plugin", "targets": [],
      "files": [{"from": "SKILL.md", "to": "SKILL.md"}]}, "targets"),
    ({"id": "demo-skill", "type": "skill", "family": "dsh_plugin", "targets": ["user"],
      "files": [{"from": "SKILL.md", "to": "../evil.md"}]}, ".."),
    ({"id": "demo-skill", "type": "skill", "family": "dsh_plugin", "targets": ["user"],
      "files": [{"from": "SKILL.md", "to": "/tmp/evil.md"}]}, "绝对路径"),
    (demo_skill_manifest() | {"id": "Bad Id"}, "id"),
    (demo_skill_manifest() | {"type": "hook"}, "type"),
])
def test_load_manifest_rejects(tmp_path, monkeypatch, bad, why):
    """非法清单直接报错（不静默跳过）：family/targets/越界路径/id/type 非 skill。"""
    root = tmp_path / "ext"
    write_ext(root, "bad", bad, {"SKILL.md": SKILL_MD})
    monkeypatch.setenv("TS_EXT_DIR", str(root))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "资产清单非法" in ei.value.message


def test_manifest_rejects_hook_type(tmp_path, monkeypatch):
    """hook 类型清单直接报「type 必须是 skill」（hook 机制已随族退场，不静默忽略）。"""
    root = tmp_path / "ext"
    write_ext(root, "bad", {"id": "demo-hook", "name": "演示 hook", "type": "hook",
                            "family": "dsh_plugin", "targets": ["user"],
                            "files": [{"from": "hook.py", "to": "hook.py"}]},
              {"hook.py": "print('x')\n"})
    monkeypatch.setenv("TS_EXT_DIR", str(root))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "资产清单非法" in ei.value.message
    assert "type 必须是 skill" in ei.value.message


def test_manifest_rejects_register(tmp_path, monkeypatch):
    """skill 清单声明 register（hook 时代的配置文件注册）直接报错，不静默忽略。"""
    root = tmp_path / "ext"
    m = demo_skill_manifest() | {"register": {
        "kind": "kimi_hooks_toml",
        "entries": [{"event": "Stop", "command": "{python} {file:SKILL.md}"}]}}
    write_ext(root, "bad", m, {"SKILL.md": SKILL_MD})
    monkeypatch.setenv("TS_EXT_DIR", str(root))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "资产清单非法" in ei.value.message
    assert "register" in ei.value.message


def test_load_manifest_missing_file_rejected(tmp_path, monkeypatch):
    """清单声明的文件不存在 → 报错（防装出半截资产）。"""
    root = tmp_path / "ext"
    write_ext(root, "bad", demo_skill_manifest(
        [{"from": "missing.md", "to": "demo-skill/missing.md"}]), {})
    monkeypatch.setenv("TS_EXT_DIR", str(root))
    with pytest.raises(ba.AssetError):
        ba.load_assets()


def test_list_assets_bad_target():
    """target 非枚举值 → 400。"""
    with pytest.raises(ba.AssetError) as ei:
        ba.list_assets("user2")
    assert ei.value.code == 400


# ---------- 状态与安装 ----------


def test_status_and_install_user_level(home, tmp_path, monkeypatch):
    """隔离环境：未安装 → 安装 → 已安装（文件落 ~/.dsh/skills/demo-skill/SKILL.md）。"""
    asset = load_one(tmp_path / "ext", monkeypatch)

    st = ba.asset_status(asset, "user")
    assert st["state"] == "absent" and st["supported"] is True
    assert st["root"] == "~/.dsh/skills"
    assert [f["exists"] for f in st["files"]] == [False]

    r = ba.install(asset, "user")
    assert r["ok"] and r["state"] == "installed"
    dst = home / ".dsh" / "skills" / "demo-skill" / "SKILL.md"
    assert dst.read_text(encoding="utf-8") == SKILL_MD
    assert r["files_written"] == [ba.display_path(str(dst))]

    st = ba.asset_status(asset, "user")
    assert st["state"] == "installed" and st["files"][0]["same"] is True


def test_install_idempotent(home, tmp_path, monkeypatch):
    """重复安装：内容已收敛 → 不重写文件（mtime 不变）。"""
    asset = load_one(tmp_path / "ext", monkeypatch)
    ba.install(asset, "user")
    dst = home / ".dsh" / "skills" / "demo-skill" / "SKILL.md"
    before = dst.stat().st_mtime_ns
    r = ba.install(asset, "user")
    assert r["state"] == "installed" and r["files_written"] == []
    assert dst.stat().st_mtime_ns == before


def test_install_updates_divergent_copy(home, tmp_path, monkeypatch):
    """已装文件被改动 → 状态 outdated（可更新），安装后内容追平仓库并回到 installed。"""
    asset = load_one(tmp_path / "ext", monkeypatch)
    ba.install(asset, "user")
    dst = home / ".dsh" / "skills" / "demo-skill" / "SKILL.md"
    dst.write_text("本地改过\n", encoding="utf-8")
    assert ba.asset_status(asset, "user")["state"] == "outdated"
    r = ba.install(asset, "user")
    assert r["state"] == "installed"
    assert dst.read_text(encoding="utf-8") == SKILL_MD
    assert r["files_written"] == [ba.display_path(str(dst))]


def test_status_partial_then_repair(home, tmp_path, monkeypatch):
    """多文件资产只装上一部分 → partial（需修复）；再装一次收敛回 installed。"""
    m = demo_skill_manifest([{"from": "SKILL.md", "to": "demo-skill/SKILL.md"},
                             {"from": "extra.md", "to": "demo-skill/extra.md"}])
    asset = load_one(tmp_path / "ext", monkeypatch,
                     {"SKILL.md": SKILL_MD, "extra.md": "附加\n"}, m)
    ba.install(asset, "user")
    (home / ".dsh" / "skills" / "demo-skill" / "extra.md").unlink()
    assert ba.asset_status(asset, "user")["state"] == "partial"
    assert ba.install(asset, "user")["state"] == "installed"


def test_uninstall_removes_only_own(home, tmp_path, monkeypatch):
    """卸载只清自己的文件：同目录下他人的 skill 原样保留，状态回到 absent。"""
    asset = load_one(tmp_path / "ext", monkeypatch)
    ba.install(asset, "user")
    skills = home / ".dsh" / "skills"
    other = skills / "other-skill" / "SKILL.md"
    other.parent.mkdir(parents=True, exist_ok=True)
    other.write_text("别人的 skill\n", encoding="utf-8")
    dst = skills / "demo-skill" / "SKILL.md"
    r = ba.uninstall(asset, "user")
    assert r["state"] == "absent" and not dst.exists()
    assert r["files_deleted"] == [ba.display_path(str(dst))]
    assert other.read_text(encoding="utf-8") == "别人的 skill\n"


# ---------- 项目级与落点 ----------


def test_skill_project_and_user_roots(home, tmp_path, monkeypatch):
    """skill 两级落点：用户级 ~/.dsh/skills、项目级 <项目目录>/.dsh/skills。"""
    asset = load_one(tmp_path / "ext", monkeypatch)
    proj = home / "proj"
    proj.mkdir()
    assert ba.install_root(asset, "user") == str(home / ".dsh" / "skills")
    assert ba.install_root(asset, "project", str(proj)) == str(proj / ".dsh" / "skills")
    ba.install(asset, "project", str(proj))
    assert (proj / ".dsh" / "skills" / "demo-skill" / "SKILL.md").exists()
    assert ba.asset_status(asset, "project", str(proj))["state"] == "installed"
    # 未指定项目目录 / 项目目录不存在
    assert ba.install_root(asset, "project", "") is None
    with pytest.raises(ba.AssetError):
        ba.install(asset, "project", str(home / "nope"))


def test_target_not_supported_reason(home, tmp_path, monkeypatch):
    """清单只声明用户级时：项目级 supported=False 并给出中文原因，安装被拒。"""
    asset = load_one(tmp_path / "ext", monkeypatch,
                     manifest=demo_skill_manifest() | {"targets": ["user"]})
    proj = home / "proj"
    proj.mkdir()
    assert ba.install_root(asset, "project", str(proj)) is None
    st = ba.asset_status(asset, "project", str(proj))
    assert st["supported"] is False and "只支持用户级安装" in st["reason"]
    with pytest.raises(ba.AssetError):
        ba.install(asset, "project", str(proj))


def test_asset_json_skill_shape(home, tmp_path, monkeypatch):
    """对外 JSON：skill 清单元信息 + 四态明细，不含已退役的注册字段。"""
    asset = load_one(tmp_path / "ext", monkeypatch)
    a = ba.asset_json(asset, "user")
    assert a["id"] == "demo-skill" and a["type"] == "skill"
    assert a["family"] == "dsh_plugin" and a["family_label"] == "dsh 插件"
    assert a["root"] == "~/.dsh/skills" and a["state"] == "absent"
    assert a["files"] == [{"to": "demo-skill/SKILL.md",
                           "path": "~/.dsh/skills/demo-skill/SKILL.md",
                           "exists": False, "same": False}]
    assert "registration" not in a


# ---------- 安全阀 ----------


def test_install_path_escape_rejected(tmp_path, monkeypatch):
    """手工构造越界 to（绕过清单校验）→ 安装与状态一律拒绝，不落盘。"""
    root = tmp_path / "ext"
    write_ext(root, "sk", demo_skill_manifest(), {"SKILL.md": SKILL_MD})
    monkeypatch.setenv("TS_EXT_DIR", str(root))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    asset = ba.load_assets()[0]
    asset["files"] = [{"from": "SKILL.md", "to": "../evil.md"}]
    with pytest.raises(ba.AssetError) as ei:
        ba.install(asset, "user")
    assert ei.value.code == 500
    assert not (tmp_path / "home" / ".dsh" / "evil.md").exists()
    with pytest.raises(ba.AssetError):
        ba.asset_status(asset, "user")


def test_display_path_abbrev(home):
    """回显路径把 HOME 前缀缩写为 ~（不外泄服务进程家目录）。"""
    assert ba.display_path(str(home / ".dsh" / "skills")) == "~/.dsh/skills"
    assert ba.display_path("/opt/other/x") == "/opt/other/x"
