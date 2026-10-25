#!/usr/bin/env python3
"""Task 3（KB-02）：内置资产残余中文路径（manifest 500 / 200 reason / `{targets}`）。

覆盖（与 `backend/test/i18n-assets.test.mjs` 逐条镜像）：
  ① manifest 500：只翻外层 `资产清单非法（{name}）：{why}`；`{why}` 保持中文
     （Ruling R-A4，开发者诊断边界），zh 逐字节为旧串；
  ② 200 列表 `assets[].reason`：由 lang 从 `list_assets` → `asset_json` → `asset_status`
     → `_unsupported_reason` 下沉，三键复用；zh 逐字节为旧串；
  ③ `{targets}` 标签：新增 `用户级`/`项目级` 两键，en 分隔符 `, `、zh `、`；
  ④ install/uninstall：lang 透传到 `_unsupported_error` 与结果里的 `asset`（reason）。
     注意：install/uninstall 成功响应的 `asset.reason` 结构上恒为空串（同目标必
     supported=True），en 形状在 HTTP 层一并钉住；非空 reason 的 en 渲染由 lib 层覆盖。
"""
import json
import pathlib
import shutil

import pytest

import builtin_assets as ba
import i18n
from serverfixture import Api, IsolatedServer

ROOT = pathlib.Path(__file__).resolve().parent.parent

USER_ONLY = {"id": "user-only-skill", "name": "仅用户级技能", "type": "skill",
             "family": "dsh_plugin", "description": "", "targets": ["user"],
             "plugin": None, "files": [], "dir": "/tmp/x"}
BOTH = {"id": "demo-skill", "name": "演示技能", "type": "skill",
        "family": "dsh_plugin", "description": "", "targets": ["user", "project"],
        "plugin": None, "files": [], "dir": "/tmp/x"}
PLUGIN = {"id": "demo-plugin", "name": "演示插件", "type": "dsh_plugin",
          "family": "dsh_plugin", "description": "",
          # dsh_plugin 的合法清单只允许 ["user"]；这里按 parity 用例的合成形态
          # 声明双目标，专门覆盖 `_unsupported_error` 的 dsh_plugin 分支
          "targets": ["user", "project"],
          "plugin": {"package": "@scope/demo-plugin", "entry_id": "demo-plugin",
                     "profile": "web", "config": {}, "requires": []},
          "files": [], "dir": "/tmp/x"}

REASON_EN = "This asset can only be installed at the user-level tier"
REASON_EN_BOTH = ("This asset can only be installed at the "
                  "user-level, project-level tier")


# --------------------------------------------------------------------------
# 夹具：隔离实例 + 合成清单根（绝不碰仓库 extensions / 真实 HOME）
# --------------------------------------------------------------------------

SKILL_MD = "---\nname: demo-skill\ndescription: 隔离测试用\n---\n\n演示内容\n"


def _write_skill(root, dir_name, manifest):
    d = root / dir_name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (d / "asset.json").write_text(json.dumps(manifest, ensure_ascii=False),
                                  encoding="utf-8")


@pytest.fixture(scope="module")
def srv(tmp_path_factory):
    base = tmp_path_factory.mktemp("i18n_assets")
    ext = base / "extensions"
    ext.mkdir()
    _write_skill(ext, "user-only-skill", {
        "id": "user-only-skill", "name": "仅用户级技能", "type": "skill",
        "family": "dsh_plugin", "description": "",
        "targets": ["user"],
        "files": [{"from": "SKILL.md", "to": "user-only-skill/SKILL.md"}],
    })
    _write_skill(ext, "demo-skill", {
        "id": "demo-skill", "name": "演示技能", "type": "skill",
        "family": "dsh_plugin", "description": "",
        "targets": ["user", "project"],
        "files": [{"from": "SKILL.md", "to": "demo-skill/SKILL.md"}],
    })
    home = base / "home"
    home.mkdir()
    instance = IsolatedServer(extra_env={"TS_EXT_DIR": str(ext), "HOME": str(home)})
    try:
        instance.start()
        instance.ext_dir = str(ext)
        yield instance
    finally:
        instance.stop()


def _en_client(srv):
    api = Api(srv.base, headers={"X-TS-Lang": "en"})
    code, d = api.json("/api/auth/login", "POST",
                       {"username": "admin", "password": srv.admin_pw})
    assert code == 200, f"登录失败: {code} {d}"
    return api


def _reason(text, asset_id):
    body = json.loads(text)
    return next(a["reason"] for a in body["assets"] if a["id"] == asset_id)


# --------------------------------------------------------------------------
# ①/③ lib 层：reason 与 targets 标签（含 zh golden）
# --------------------------------------------------------------------------

def test_unsupported_reason_en_and_zh_golden():
    # zh golden（实现前实测旧串）
    assert ba._unsupported_reason(USER_ONLY, "project") == "该资产只支持用户级安装"
    assert ba._unsupported_reason(BOTH, "nope") == "该资产只支持用户级、项目级安装"
    # en：复用既有 3 键 + 新增 用户级/项目级
    assert ba._unsupported_reason(USER_ONLY, "project", "en") == REASON_EN
    assert ba._unsupported_reason(BOTH, "nope", "en") == REASON_EN_BOTH
    assert ba._unsupported_reason(PLUGIN, "project", "en") == (
        "dsh plugin assets support only user-level installs "
        "(installed into the dsh profile, independent of projects)")
    third = {"id": "x", "type": "skill", "family": "nope",
             "targets": ["user", "project"], "plugin": None, "files": [],
             "dir": "/tmp/x"}
    assert ba._unsupported_reason(third, "project", "en") == (
        "This asset (nope) does not support installation at this target yet")


def test_targets_separator_falls_back_under_ts_i18n_rollback(monkeypatch):
    """TS_I18N=0 回滚：t() 恒中文 ⇒ 分隔符也必须回落 `、`（不拼「用户级, 项目级」）。"""
    monkeypatch.setenv("TS_I18N", "0")
    assert ba._unsupported_reason(BOTH, "nope", "en") == "该资产只支持用户级、项目级安装"


def test_asset_status_and_json_reason_lang_down():
    st = ba.asset_status(USER_ONLY, "project", "", "en")
    assert st["reason"] == REASON_EN and st["supported"] is False
    assert ba.asset_status(USER_ONLY, "project")["reason"] == "该资产只支持用户级安装"
    assert ba.asset_json(USER_ONLY, "project", "", lang="en")["reason"] == REASON_EN
    assert ba.asset_json(USER_ONLY, "project")["reason"] == "该资产只支持用户级安装"


def test_install_uninstall_unsupported_error_en(tmp_path):
    with pytest.raises(ba.AssetError) as ei:
        ba.install(USER_ONLY, "project", str(tmp_path), "en")
    assert str(ei.value) == REASON_EN
    assert ei.value.i18n_key == "该资产只支持{targets}安装"
    assert ei.value.i18n_vars == {"targets": "user-level"}

    with pytest.raises(ba.AssetError) as ei:
        ba.install(USER_ONLY, "project", str(tmp_path))
    assert str(ei.value) == "该资产只支持用户级安装"

    with pytest.raises(ba.AssetError) as ei:
        ba.uninstall(USER_ONLY, "project", str(tmp_path), "en")
    assert str(ei.value) == REASON_EN

    with pytest.raises(ba.AssetError) as ei:
        ba.uninstall(USER_ONLY, "project", str(tmp_path))
    assert str(ei.value) == "该资产只支持用户级安装"


# --------------------------------------------------------------------------
# ① lib 层：manifest 只翻外层（R-A4）
# --------------------------------------------------------------------------

def test_manifest_error_outer_en_why_frozen():
    err = ba._manifest_error("/tmp/zz-bad", "family 未知：'nope'")
    # zh golden：`.message` 逐字旧串
    assert str(err) == "资产清单非法（zz-bad）：family 未知：'nope'"
    assert err.code == 500
    assert err.i18n_key == "资产清单非法（{name}）：{why}"
    assert err.i18n_vars == {"name": "zz-bad", "why": "family 未知：'nope'"}
    # en：只翻外层，why 仍是中文（开发者诊断边界）
    assert i18n.t("api", err.i18n_key, "en", **err.i18n_vars) == (
        "Invalid asset manifest (zz-bad): family 未知：'nope'")


# --------------------------------------------------------------------------
# ②/③ 端点级：200 list reason + install 400 + manifest 500（zh 字节 golden）
# --------------------------------------------------------------------------

def test_http_list_reason_en_and_zh_bytes(srv):
    en = _en_client(srv)
    pid = srv.create_project(srv.admin, "i18n_assets_p1")
    path = f"/api/builtin-assets?target=project&project_id={pid}"

    code, text = srv.admin(path)
    assert code == 200
    assert _reason(text, "user-only-skill") == "该资产只支持用户级安装"
    # zh 字节 golden：reason 字段的序列化片段逐字节不变
    assert '"reason": "该资产只支持用户级安装"' in text

    code, text = en(path)
    assert code == 200
    assert _reason(text, "user-only-skill") == REASON_EN
    assert '"reason": "This asset can only be installed at the user-level tier"' in text


def test_http_install_400_targets_en_and_zh_bytes(srv):
    en = _en_client(srv)
    pid = srv.create_project(srv.admin, "i18n_assets_p2")
    body = {"target": "project", "project_id": pid}
    path = "/api/builtin-assets/user-only-skill/install"

    code, text = srv.admin(path, "POST", body)
    assert code == 400
    assert text == '{"error": "该资产只支持用户级安装"}'
    code, text = en(path, "POST", body)
    assert code == 400
    # 嵌套占位符渲染：en target 标签 + en 外层模板
    assert text == ('{"error": "This asset can only be installed at the '
                    'user-level tier"}')


def test_http_manifest_500_outer_en_why_zh(srv):
    en = _en_client(srv)
    ext = pathlib.Path(srv.ext_dir)
    bad = ext / "zz-bad"
    bad.mkdir()
    (bad / "asset.json").write_text(json.dumps({
        "id": "x", "type": "skill", "family": "nope",
        "targets": ["user"], "files": [],
    }), encoding="utf-8")
    try:
        code, text = srv.admin("/api/builtin-assets?target=user")
        assert code == 500
        # zh golden：外层与 why 均逐字旧串
        assert text == (
            '{"error": "资产清单非法（zz-bad）：'
            'family 未知：\'nope\'"}')
        code, text = en("/api/builtin-assets?target=user")
        assert code == 500
        assert text == (
            '{"error": "Invalid asset manifest (zz-bad): '
            'family 未知：\'nope\'"}')
    finally:
        shutil.rmtree(bad)


def test_http_install_uninstall_asset_reason_empty_in_en(srv):
    """成功档 `asset.reason` 结构上恒 `""`；en 请求的形状与 zh 相同（无中文）。"""
    en = _en_client(srv)
    pid = srv.create_project(srv.admin, "i18n_assets_p3")
    body = {"target": "project", "project_id": pid}

    code, text = en("/api/builtin-assets/demo-skill/install", "POST", body)
    assert code == 200
    payload = json.loads(text)
    assert payload["ok"] is True and payload["state"] == "installed"
    assert payload["asset"]["reason"] == ""

    code, text = en("/api/builtin-assets/demo-skill/uninstall", "POST", body)
    assert code == 200
    payload = json.loads(text)
    assert payload["ok"] is True and payload["state"] == "absent"
    assert payload["asset"]["reason"] == ""
