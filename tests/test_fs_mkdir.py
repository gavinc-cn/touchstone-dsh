#!/usr/bin/env python3
"""目录选择对话框「新建文件夹」单测（POST /api/fs/mkdir + server.fs_mkdir）。

新建/编辑项目弹窗的目录选择对话框支持在当前浏览目录下新建文件夹（后端建真实目录，
前端随后进入该目录）。契约：

- 成功返回 `{name, path}`，新目录随目录浏览端点（GET /api/fs/browse）可见；
- 名称只接受单级目录名：空名 / 含路径分隔符 / `.` / `..` / 结尾点或空格 一律 400；
- 父目录须存在（根视角 path 为空即 400）；同名文件或目录已存在一律 400（不覆盖、不静默复用）；
- 未登录 401（与其余 /api/* 同一鉴权链）。

运行: python -m pytest tests/test_fs_mkdir.py -v
"""
import os

from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入


# ---------- 纯函数层（名称与父目录校验） ----------

def test_fs_mkdir_name_validation(tmp_path):
    """非法名称一律拒绝且不落盘：空名/全空白 / . / .. / 分隔符 / 结尾点。"""
    import server

    for name in ("", "   ", ".", "..", "a/b", "a\\b", "x.", "\tx.\n", "..尾点.."):
        data, err = server.fs_mkdir(str(tmp_path), name)
        assert data is None, f"名称 {name!r} 应被拒绝"
        assert err, f"名称 {name!r} 拒绝时须给出原因"
    assert os.listdir(tmp_path) == [], "校验失败不应产生任何目录/文件"


def test_fs_mkdir_name_trim(tmp_path):
    """名称两端空白按 strip 归整（与前端输入框 .trim() 一致），不做拒绝。"""
    import server

    data, err = server.fs_mkdir(str(tmp_path), "  带空白名  ")
    assert err is None and data["name"] == "带空白名", (data, err)
    assert os.path.isdir(data["path"])


def test_fs_mkdir_parent_validation(tmp_path):
    """父目录校验：空路径 / 不存在 / 指向普通文件 一律拒绝；合法目录可连续新建。"""
    import server

    afile = tmp_path / "afile"
    afile.write_text("x", encoding="utf-8")
    for parent in ("", "   ", str(tmp_path / "nope"), str(afile)):
        data, err = server.fs_mkdir(parent, "sub")
        assert data is None and err, f"父目录 {parent!r} 应被拒绝"

    data, err = server.fs_mkdir(str(tmp_path), "中文名")
    assert err is None and data["name"] == "中文名", (data, err)
    assert os.path.isdir(data["path"]) and data["path"] == os.path.join(str(tmp_path), "中文名")
    # 同名（目录）与同名（文件）都算占用，第二次起 400
    _d, err2 = server.fs_mkdir(str(tmp_path), "中文名")
    assert _d is None and "已存在" in err2
    _d, err3 = server.fs_mkdir(str(tmp_path), "afile")
    assert _d is None and "已存在" in err3


# ---------- HTTP 端点层（隔离实例） ----------

def test_mkdir_requires_auth(isolated_server):
    """未登录 401（新建目录不豁免鉴权）。"""
    code, d = isolated_server.client().json(
        "/api/fs/mkdir", "POST", {"path": isolated_server.proj_dir, "name": "anon"})
    assert code == 401, d
    assert not os.path.exists(os.path.join(isolated_server.proj_dir, "anon"))


def test_mkdir_creates_and_browse_shows_it(isolated_server):
    """建目录成功：磁盘出现该目录、浏览端点可见、重名再建 400。"""
    srv = isolated_server
    code, d = srv.admin.json("/api/fs/mkdir", "POST",
                             {"path": srv.proj_dir, "name": "新建的项目x"})
    assert code == 200, d
    assert d["name"] == "新建的项目x" and d["path"] == os.path.join(srv.proj_dir, "新建的项目x")
    assert os.path.isdir(d["path"])

    code, b = srv.admin.json(f"/api/fs/browse?path={srv.proj_dir}")
    assert code == 200, b
    assert any(x["name"] == "新建的项目x" for x in b["dirs"]), b["dirs"]

    code, d2 = srv.admin.json("/api/fs/mkdir", "POST",
                              {"path": srv.proj_dir, "name": "新建的项目x"})
    assert code == 400 and "已存在" in d2["error"], d2


def test_mkdir_route_validation_400(isolated_server):
    """非法请求一律 400 且带中文原因：根视角（path 空）/ 父目录不存在 / 名称带分隔符。"""
    srv = isolated_server
    cases = [
        ("", "sub"),                                        # 根视角：未进入具体目录
        (os.path.join(srv.proj_dir, "没有这个目录"), "sub"),     # 父目录不存在
        (srv.proj_dir, "../逃逸"),                            # 名称含分隔符（防穿越）
    ]
    for path, name in cases:
        code, d = srv.admin.json("/api/fs/mkdir", "POST", {"path": path, "name": name})
        assert code == 400 and d["error"], (path, name, d)
    assert not os.path.exists(os.path.join(os.path.dirname(srv.proj_dir), "逃逸"))
