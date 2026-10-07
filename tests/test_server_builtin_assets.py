#!/usr/bin/env python3
"""内置 skill 资产端点契约测试（隔离实例，真实 HTTP + 真实文件系统）：

/api/builtin-assets 的鉴权分层（401 / 非 admin 用户级写 403 / 跨用户项目 404）、
清单元信息与状态回读、安装/卸载真实落盘（项目级写沙箱项目目录）、参数与未知资产
错误口径。

沙箱清单根 TS_EXT_DIR = 仓库 extensions 的拷贝 + 一个合成 skill 资产（仓库当前
零资产，项目级链路用合成资产覆盖）。依赖 tests/serverfixture.py。
"""
import json
import os
import shutil
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from serverfixture import IsolatedServer  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_EXT = os.path.join(ROOT, "extensions")

SKILL_MD = "---\nname: demo-skill\ndescription: 隔离测试用 skill\n---\n\n演示内容\n"


@pytest.fixture(scope="module")
def srv(tmp_path_factory):
    """隔离实例：清单根指向沙箱（仓库 extensions 拷贝 + 合成 skill 资产）。"""
    base = tmp_path_factory.mktemp("builtin_assets")
    ext = base / "extensions"
    shutil.copytree(REPO_EXT, ext)
    sk = ext / "demo-skill"
    sk.mkdir()
    (sk / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (sk / "asset.json").write_text(json.dumps({
        "id": "demo-skill", "name": "演示 skill", "type": "skill",
        "family": "dsh_plugin", "description": "隔离测试用",
        "targets": ["user", "project"],
        "files": [{"from": "SKILL.md", "to": "demo-skill/SKILL.md"}],
    }, ensure_ascii=False), encoding="utf-8")
    s = IsolatedServer(extra_env={"TS_EXT_DIR": str(ext)})
    s.start()
    try:
        yield s
    finally:
        s.stop()


def asset_of(d, asset_id):
    return next(a for a in d["assets"] if a["id"] == asset_id)


def test_anonymous_401(srv):
    """未登录：列表与安装/卸载一律 401。"""
    anon = srv.client()
    for path, method in (("/api/builtin-assets", "GET"),
                         ("/api/builtin-assets/demo-skill/install", "POST"),
                         ("/api/builtin-assets/demo-skill/uninstall", "POST")):
        code, _d = anon.json(path, method, {"target": "user"} if method == "POST" else None)
        assert code == 401


def test_non_admin_read_only_then_403(srv):
    """普通用户：用户级读放开但 can_install=False，写操作 403。"""
    srv.create_user("asset_u1", "pass123456")
    api = srv.login("asset_u1", "pass123456")
    code, d = api.json("/api/builtin-assets?target=user")
    assert code == 200 and d["can_install"] is False
    code, d = api.json("/api/builtin-assets/demo-skill/install", "POST", {"target": "user"})
    assert code == 403 and "仅管理员" in d["error"]
    code, _d = api.json("/api/builtin-assets/demo-skill/uninstall", "POST", {"target": "user"})
    assert code == 403


def test_project_target_requires_own_project(srv):
    """项目级：非所有者一律 404（含 admin 不是所有者的情况）；缺 project_id 400。"""
    pid = srv.create_project(srv.admin, "assets_p1")
    srv.create_user("asset_u2", "pass123456")
    other = srv.login("asset_u2", "pass123456")
    # 非所有者（含未指定项目）
    code, _d = srv.admin.json(f"/api/builtin-assets?target=project&project_id={pid + 999}")
    assert code == 404
    code, _d = other.json(f"/api/builtin-assets?target=project&project_id={pid}")
    assert code == 404
    code, _d = other.json("/api/builtin-assets/demo-skill/install", "POST",
                          {"target": "project", "project_id": pid})
    assert code == 404
    # 参数错误
    code, d = srv.admin.json("/api/builtin-assets?target=project")
    assert code == 400 and "project_id" in d["error"]
    code, d = srv.admin.json("/api/builtin-assets?target=nope")
    assert code == 400 and "target" in d["error"]


def test_project_level_skill_install(srv):
    """项目级 skill 链路：装到项目目录 .dsh/skills（沙箱项目目录下真实落盘）。"""
    pid = srv.create_project(srv.admin, "assets_p3")
    code, d = srv.admin.json(f"/api/builtin-assets?target=project&project_id={pid}")
    a = asset_of(d, "demo-skill")
    assert a["supported"] is True and a["state"] == "absent"
    code, r = srv.admin.json("/api/builtin-assets/demo-skill/install", "POST",
                             {"target": "project", "project_id": pid})
    assert code == 200 and r["state"] == "installed"
    dst = os.path.join(srv.proj_dir, ".dsh", "skills", "demo-skill", "SKILL.md")
    assert os.path.isfile(dst)
    with open(dst, encoding="utf-8") as f:
        assert f.read() == SKILL_MD
    code, d = srv.admin.json(f"/api/builtin-assets?target=project&project_id={pid}")
    assert asset_of(d, "demo-skill")["state"] == "installed"
    code, r = srv.admin.json("/api/builtin-assets/demo-skill/uninstall", "POST",
                             {"target": "project", "project_id": pid})
    assert code == 200 and r["state"] == "absent" and not os.path.exists(dst)


def test_unknown_asset_404(srv):
    """未知资产 id：安装/卸载 404。"""
    for action in ("install", "uninstall"):
        code, d = srv.admin.json(f"/api/builtin-assets/nope-{action}/{action}", "POST",
                                 {"target": "user"})
        assert code == 404 and "未知资产" in d["error"]


# ---------- dsh 插件资产（P8）：API 全链路（沙箱 profiles，绝不碰真实 ~/.dsh） ----------


@pytest.fixture(scope="module")
def srv_plugin(tmp_path_factory):
    """隔离实例 + 沙箱 dsh profiles：合成 dsh_plugin 资产走 install/uninstall 全链路。

    `TS_DSH_PROFILES` 指沙箱 profiles（web profile 声明 patchReload: live +
    `@deepseek-ai/dsh-llm` 占位），故注册行与包目录都落在临时目录里。
    """
    base = tmp_path_factory.mktemp("builtin_plugin")
    ext = base / "extensions"
    d = ext / "demo-plugin"
    (d / "pkg" / "lib").mkdir(parents=True)
    (d / "pkg" / "lib" / "index.mjs").write_text("export const name = 'demo-plugin'\n",
                                                 encoding="utf-8")
    (d / "pkg" / "package.json").write_text('{"name": "@scope/demo-plugin"}', encoding="utf-8")
    (d / "asset.json").write_text(json.dumps({
        "id": "demo-plugin", "name": "演示 dsh 插件", "type": "dsh_plugin",
        "family": "dsh_plugin", "description": "隔离测试用",
        "targets": ["user"],
        "plugin": {"package": "@scope/demo-plugin", "entry_id": "demo-plugin",
                   "profile": "web", "requires": ["@deepseek-ai/dsh-llm"]},
        "files": [{"from": "pkg/lib/index.mjs", "to": "lib/index.mjs"},
                  {"from": "pkg/package.json", "to": "package.json"}],
    }, ensure_ascii=False), encoding="utf-8")
    profiles = base / "profiles"
    (profiles / "web").mkdir(parents=True)
    (profiles / "web" / "package.json").write_text(json.dumps(
        {"dsh": {"profile": {"bundles": [], "patchReload": "live"}}}), encoding="utf-8")
    llm = profiles / "node_modules" / "@deepseek-ai" / "dsh-llm"
    llm.mkdir(parents=True)
    (llm / "package.json").write_text('{"name": "@deepseek-ai/dsh-llm"}', encoding="utf-8")
    s = IsolatedServer(extra_env={"TS_EXT_DIR": str(ext), "TS_DSH_PROFILES": str(profiles)})
    s.start()
    try:
        s.profiles = profiles
        yield s
    finally:
        s.stop()


def test_plugin_asset_api_roundtrip(srv_plugin):
    """dsh 插件资产：列表带 plugin 段 → 安装（拷包 + 写注册行）→ 状态 installed → 卸载收干净。"""
    srv, profiles = srv_plugin, srv_plugin.profiles
    code, d = srv.admin.json("/api/builtin-assets?target=user")
    a = asset_of(d, "demo-plugin")
    assert code == 200 and a["type"] == "dsh_plugin" and a["type_label"] == "dsh 插件"
    assert a["state"] == "absent" and a["supported"] is True
    assert a["plugin"]["patch_mode"] == "" and a["plugin"]["restart_required"] is False
    assert a["plugin"]["requires_ok"] is True

    code, r = srv.admin.json("/api/builtin-assets/demo-plugin/install", "POST",
                             {"target": "user"})
    assert code == 200 and r["state"] == "installed" and r["patch_action"] == "added"
    pkg = profiles / "node_modules" / "@scope" / "demo-plugin"
    assert (pkg / "lib" / "index.mjs").is_file()
    patch = profiles / "web" / "cordis.patch.yml"
    text = patch.read_text(encoding="utf-8")
    assert "# >>> touchstone-asset:demo-plugin" in text and 'name: "@scope/demo-plugin"' in text

    code, d = srv.admin.json("/api/builtin-assets?target=user")
    a = asset_of(d, "demo-plugin")
    assert a["state"] == "installed" and a["plugin"]["patch_mode"] == "marked"

    # 项目级目标对 dsh 插件不适用：如实回 supported=False + 原因（前端据此置灰）
    pid = srv.create_project(srv.admin, "assets_plugin_p1")
    code, d = srv.admin.json(f"/api/builtin-assets?target=project&project_id={pid}")
    a = asset_of(d, "demo-plugin")
    assert a["supported"] is False and "只支持用户级" in a["reason"]

    code, r = srv.admin.json("/api/builtin-assets/demo-plugin/uninstall", "POST",
                             {"target": "user"})
    assert code == 200 and r["state"] == "absent" and r["patch_action"] == "removed"
    assert not pkg.exists() and patch.read_text(encoding="utf-8").strip() == ""
