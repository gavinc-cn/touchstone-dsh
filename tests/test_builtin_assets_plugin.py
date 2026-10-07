#!/usr/bin/env python3
"""内置 **dsh 插件**资产（builtin_assets.py 的第二类资产，P8 2026-10-04）单测。

覆盖：清单校验（plugin 段必填 / targets 只能 user / config 只允许标量 / requires 包名）、
落点推导（`<profiles>/node_modules/<package>`）、注册行写入与四态合成、幂等重装、
卸载（含空目录收敛）、以及三条安全阀——foreign 注册行只报告不改、disabled 行由安装重新
启用、profile 不存在直接报错。

隔离方式：`TS_DSH_PROFILES` 指临时 profiles 根（**绝不碰真实 ~/.dsh**），
`TS_EXT_DIR` 指临时清单根。手放型插件的真实形态与约束见模块 docstring 与
`doc_ai/spec/assets/内置资产安装.md`。
"""
import json
import os
import shutil
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import builtin_assets as ba  # noqa: E402


# ---------- 夹具 ----------


@pytest.fixture
def profiles(tmp_path, monkeypatch):
    """临时 dsh profiles 根：web profile（patchReload: live）+ 祖先 node_modules 软链位。

    `@deepseek-ai/dsh-llm` 用空目录占位（只校验可解析性，不加载）。
    """
    root = tmp_path / "profiles"
    (root / "web").mkdir(parents=True)
    (root / "web" / "package.json").write_text(json.dumps(
        {"name": "dsh-profile-web", "private": True,
         "dsh": {"profile": {"bundles": ["x"], "patchReload": "live"}}}), encoding="utf-8")
    llm = root / "node_modules" / "@deepseek-ai" / "dsh-llm"
    llm.mkdir(parents=True)
    (llm / "package.json").write_text('{"name": "@deepseek-ai/dsh-llm"}', encoding="utf-8")
    monkeypatch.setenv("TS_DSH_PROFILES", str(root))
    return root


def plugin_manifest(**over):
    """合成 dsh_plugin 清单（可被 over 覆盖任意字段/子段）。"""
    m = {
        "id": "demo-plugin", "name": "演示插件", "type": "dsh_plugin",
        "family": "dsh_plugin", "description": "演示用",
        "targets": ["user"],
        "plugin": {"package": "@scope/demo-plugin", "entry_id": "demo-plugin",
                   "profile": "web", "requires": ["@deepseek-ai/dsh-llm"]},
        "files": [{"from": "pkg/index.mjs", "to": "lib/index.mjs"},
                  {"from": "pkg/package.json", "to": "package.json"}],
    }
    for key, val in over.items():
        if isinstance(val, dict) and isinstance(m.get(key), dict):
            m[key] = {**m[key], **val}
        else:
            m[key] = val
    return m


def write_asset(ext_root, manifest=None, files=None):
    """写一个合成 dsh_plugin 资产目录并返回它。"""
    d = ext_root / "demo"
    d.mkdir(parents=True, exist_ok=True)
    (d / "pkg" / "lib").mkdir(parents=True, exist_ok=True)
    payload = files or {"pkg/index.mjs": "export const name = 'demo-plugin'\n",
                        "pkg/package.json": '{"name": "@scope/demo-plugin"}\n'}
    for rel, content in payload.items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    (d / "asset.json").write_text(json.dumps(manifest or plugin_manifest()),
                                  encoding="utf-8")
    return d


def load_one(ext_root, monkeypatch, manifest=None, files=None):
    """写合成资产 → TS_EXT_DIR 指过去 → 返回清单对象。"""
    write_asset(ext_root, manifest, files)
    monkeypatch.setenv("TS_EXT_DIR", str(ext_root))
    return ba.load_assets()[0]


def patch_text(profiles, name="web"):
    return (profiles / name / "cordis.patch.yml").read_text(encoding="utf-8")


def set_patch(profiles, text, name="web"):
    (profiles / name / "cordis.patch.yml").write_text(text, encoding="utf-8")


# ---------- 清单校验 ----------


def test_manifest_requires_plugin_section(tmp_path, monkeypatch):
    """type=dsh_plugin 必须声明 plugin 段；package/profile 走白名单校验。"""
    write_asset(tmp_path, plugin_manifest(plugin={"package": None}))
    monkeypatch.setenv("TS_EXT_DIR", str(tmp_path))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "plugin.package 非法" in str(ei.value)


def test_manifest_plugin_package_and_profile_whitelist(tmp_path, monkeypatch):
    """package 越界（`../evil`）与 profile 非法（含 `/`）都报清单错误，不放行。"""
    write_asset(tmp_path, plugin_manifest(plugin={"package": "../evil"}))
    monkeypatch.setenv("TS_EXT_DIR", str(tmp_path))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "plugin.package 非法" in str(ei.value)
    write_asset(tmp_path, plugin_manifest(plugin={"package": "@scope/demo", "profile": "a/b"}))
    with pytest.raises(ba.AssetError) as ei2:
        ba.load_assets()
    assert "plugin.profile 非法" in str(ei2.value)


def test_manifest_entry_id_defaults_to_package_tail(tmp_path, monkeypatch):
    """entry_id 缺省取包名末段（`@scope/demo` → `demo`）。"""
    a = load_one(tmp_path / "ext", monkeypatch,
                 plugin_manifest(plugin={"entry_id": None, "package": "@scope/demo"}))
    assert a["plugin"]["entry_id"] == "demo"


def test_manifest_rejects_project_target(tmp_path, monkeypatch):
    """dsh 插件是 profile 级资产：targets 声明 project 直接报清单错误（不静默忽略）。"""
    write_asset(tmp_path, plugin_manifest(targets=["user", "project"]))
    monkeypatch.setenv("TS_EXT_DIR", str(tmp_path))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "只支持用户级" in str(ei.value)


def test_manifest_config_scalars_only(tmp_path, monkeypatch):
    """plugin.config 只接受标量（复杂结构会被原样写进 YAML 而写坏 patch，故直接拒绝）。"""
    write_asset(tmp_path, plugin_manifest(
        plugin={"config": {"paths": ["/a", "/b"]}}))
    monkeypatch.setenv("TS_EXT_DIR", str(tmp_path))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "只支持字符串/布尔/数字" in str(ei.value)


def test_manifest_requires_package_names(tmp_path, monkeypatch):
    """plugin.requires 必须是包名数组（用于装前诊断能否解析）。"""
    write_asset(tmp_path, plugin_manifest(plugin={"requires": ["not a pkg!"]}))
    monkeypatch.setenv("TS_EXT_DIR", str(tmp_path))
    with pytest.raises(ba.AssetError) as ei:
        ba.load_assets()
    assert "requires" in str(ei.value)


# ---------- 安装 / 状态 / 幂等 ----------


def test_install_writes_package_and_patch(profiles, tmp_path, monkeypatch):
    """安装 = 文件收敛到 <profiles>/node_modules/<pkg> + 写带标记的注册块；状态 installed。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    r = ba.install(a, "user")
    root = profiles / "node_modules" / "@scope" / "demo-plugin"
    assert (root / "lib" / "index.mjs").read_text(encoding="utf-8").startswith("export const")
    assert (root / "package.json").is_file()
    assert r["patch_action"] == "added" and r["state"] == "installed"
    assert r["restart_required"] is False                 # web profile 声明 patchReload: live
    text = patch_text(profiles)
    assert "# >>> touchstone-asset:demo-plugin" in text
    assert "- insert:" in text and 'name: "@scope/demo-plugin"' in text
    assert "# <<< touchstone-asset:demo-plugin" in text
    st = ba.asset_json(a, "user")
    assert st["state"] == "installed" and st["plugin"]["patch_mode"] == "marked"
    assert st["plugin"]["registered"] is True and st["plugin"]["disabled"] is False
    assert st["plugin"]["requires_ok"] is True           # 夹具里 @deepseek-ai/dsh-llm 可解析
    # 幂等：再装一次不重写文件、不动 patch
    r2 = ba.install(a, "user")
    assert r2["files_written"] == [] and r2["patch_action"] == "kept"
    assert r2["state"] == "installed"


def test_install_appends_to_existing_patch(profiles, tmp_path, monkeypatch):
    """patch 文件已有内容（含别人手写的块）时只追加，不改动既有行。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    set_patch(profiles, "# 别人的配置\n- id: touchstone\n  disabled: false\n")
    ba.install(a, "user")
    text = patch_text(profiles)
    assert text.startswith("# 别人的配置\n- id: touchstone\n  disabled: false\n")
    assert text.rstrip().endswith("# <<< touchstone-asset:demo-plugin")


def test_config_block_written_when_declared(profiles, tmp_path, monkeypatch):
    """plugin.config（扁平标量）写独立覆盖块：`- id: X` + config + disabled: false。"""
    a = load_one(tmp_path / "ext", monkeypatch, plugin_manifest(plugin={
        "config": {"paths": "/tmp/x", "verbose": True, "retries": 3}}))
    ba.install(a, "user")
    text = patch_text(profiles)
    assert "# >>> touchstone-asset:demo-plugin.config" in text
    assert "- id: demo-plugin\n  config:\n" in text
    assert '    paths: "/tmp/x"\n' in text
    assert "    verbose: true\n" in text
    assert "    retries: 3\n" in text
    assert "  disabled: false\n" in text


def test_status_partial_when_patch_missing(profiles, tmp_path, monkeypatch):
    """文件装上了但注册行没写（或被人删掉）→ partial（需修复），不是 installed。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    ba.install(a, "user")
    set_patch(profiles, "# 手工清空了注册行\n")
    st = ba.asset_json(a, "user")
    assert st["state"] == "partial" and st["plugin"]["registered"] is False


def test_status_outdated_when_file_differs(profiles, tmp_path, monkeypatch):
    """实体文件被本地改过（内容与仓库不一致）→ outdated（页面显示「可更新」）。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    ba.install(a, "user")
    (profiles / "node_modules" / "@scope" / "demo-plugin" / "lib" / "index.mjs") \
        .write_text("// 本地改过\n", encoding="utf-8")
    assert ba.asset_json(a, "user")["state"] == "outdated"


# ---------- 手工注册 / 停用 / foreign ----------


def test_canonical_manual_registration_recognized(profiles, tmp_path, monkeypatch):
    """手工按规范文本注册过（无平台标记）→ 视为已注册（mode=canonical），可被平台卸载。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    ba.install(a, "user")
    set_patch(profiles, '- insert:\n    - id: demo-plugin\n      name: "@scope/demo-plugin"\n')
    st = ba.asset_json(a, "user")
    assert st["state"] == "installed" and st["plugin"]["patch_mode"] == "canonical"
    r = ba.uninstall(a, "user")
    assert r["patch_action"] == "removed"
    assert patch_text(profiles).strip() == ""
    assert not (profiles / "node_modules" / "@scope" / "demo-plugin").exists()
    assert not (profiles / "node_modules" / "@scope").exists()   # 空 scope 目录一并收敛


def test_disabled_row_is_reenabled_by_install(profiles, tmp_path, monkeypatch):
    """被 dsh 面板停用（顶层 `- id: X` + disabled: true）→ 状态 partial，安装重新启用。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    ba.install(a, "user")
    set_patch(profiles, patch_text(profiles) + "\n- id: demo-plugin\n  disabled: true\n")
    st = ba.asset_json(a, "user")
    assert st["state"] == "partial" and st["plugin"]["disabled"] is True
    ba.install(a, "user")
    assert "disabled: true" not in patch_text(profiles)
    st2 = ba.asset_json(a, "user")
    assert st2["state"] == "installed" and st2["plugin"]["disabled"] is False


def test_foreign_registration_never_touched(profiles, tmp_path, monkeypatch):
    """用户自定义写法的注册行：状态照实（registered），但安装/卸载都拒绝改动它。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    ba.install(a, "user")
    custom = '- insert:\n    - id: demo-plugin\n      name: "@scope/demo-plugin"\n      config:\n        x: 1\n'
    set_patch(profiles, custom)
    st = ba.asset_json(a, "user")
    assert st["plugin"]["patch_mode"] == "foreign" and st["plugin"]["registered"] is True
    with pytest.raises(ba.AssetError) as ei:
        ba.uninstall(a, "user")
    assert ei.value.code == 409 and "自定义写法" in str(ei.value)
    assert patch_text(profiles) == custom                    # 一个字节都没动
    # 文件也不该被删（拒绝发生在删文件之前）
    assert (profiles / "node_modules" / "@scope" / "demo-plugin" / "package.json").is_file()


# ---------- 环境与目标边界 ----------


def test_requires_missing_reported(profiles, tmp_path, monkeypatch):
    """依赖解析不到（新机器上没建 dsh 包链接）→ requires_ok=False（只报告，不阻断安装）。"""
    shutil.rmtree(profiles / "node_modules" / "@deepseek-ai")
    a = load_one(tmp_path / "ext", monkeypatch)
    r = ba.install(a, "user")
    assert r["state"] == "installed"                          # 装了（文件与注册行都对）
    st = ba.asset_json(a, "user")
    assert st["plugin"]["requires_ok"] is False
    assert st["plugin"]["requires"] == [{"spec": "@deepseek-ai/dsh-llm", "ok": False, "path": ""}]


def test_restart_required_without_patch_reload(tmp_path, monkeypatch):
    """profile 未声明 patchReload: live → 标 restart_required（页面提示重启 dsh 生效）。"""
    root = tmp_path / "profiles"
    (root / "web").mkdir(parents=True)
    (root / "web" / "package.json").write_text(
        json.dumps({"dsh": {"profile": {"bundles": []}}}), encoding="utf-8")
    monkeypatch.setenv("TS_DSH_PROFILES", str(root))
    a = load_one(tmp_path / "ext", monkeypatch)
    ba.install(a, "user")
    assert ba.asset_json(a, "user")["plugin"]["restart_required"] is True


def test_install_requires_existing_profile(tmp_path, monkeypatch):
    """profile 目录不存在（写进去也不会被加载）→ 明确报错，不静默造目录、不留半残状态。"""
    root = tmp_path / "profiles"
    root.mkdir()
    monkeypatch.setenv("TS_DSH_PROFILES", str(root))
    a = load_one(tmp_path / "ext", monkeypatch)
    with pytest.raises(ba.AssetError) as ei:
        ba.install(a, "user")
    assert "未找到 dsh profile" in str(ei.value)
    # 前置检查在拷文件之前：包目录没被建出来（否则面板显示 partial，用户还得先修一次）
    assert not (root / "node_modules").exists()


def test_project_target_unsupported_reason(profiles, tmp_path, monkeypatch):
    """项目级目标对 dsh 插件不适用：supported=False + 明确原因（前端据此置灰）。"""
    a = load_one(tmp_path / "ext", monkeypatch)
    st = ba.asset_json(a, "project", str(tmp_path))
    assert st["supported"] is False
    assert "只支持用户级" in st["reason"]
    assert st["state"] == "absent"
