#!/usr/bin/env python3
"""目录浏览端点「上级到盘符/根列表」单测（2026-10-22 卡 1044「目录选择支持选盘符」）。

背景（用户报，Windows）：在盘符根（如 `D:\\`）时目录选择弹窗的「上级」按钮被禁用——
`fs_browse` 对文件系统根返回 `parent=None`，前端把 None 当成「已到顶」，于是从盘符内部
永远回不到盘符列表（此电脑），既选不了盘符也切不到别的盘。

契约（与 Node 侧 `backend/lib/lib.js:fsBrowse` 逐点对齐）：
- 根视角（`path` 为空）→ `path=""`、`parent=None`（无处可上），`dirs` 即 `roots`；
- 文件系统根（POSIX `/`，Windows 盘符根 `D:\\`）→ `path` 为 realpath、**`parent=""`**
  （空串 = 「上级」进根视角，前端据此启用按钮）；
- 普通目录 → `parent` 仍是上级目录字符串（不回归）。

运行: python -m pytest tests/test_fs_browse_root.py -v
"""
import os
import urllib.parse

from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入


# ---------- 纯函数层 ----------

def test_root_view_parent_none_and_dirs_are_roots():
    """根视角：parent=None（无处可上）、dirs 即后端 roots。"""
    import server

    data = server.fs_browse("")
    assert data["path"] == ""
    assert data["parent"] is None
    assert data["dirs"] == [{"name": r, "path": r} for r in server.fs_roots()]


def test_filesystem_root_parent_is_empty_string(tmp_path):
    """文件系统根（Linux "/"，Windows 各盘符根）：parent 为空串 ⇒「上级」进根视角。"""
    import server

    roots = server.fs_roots()
    assert roots, "根列表不应为空"
    for root in roots:
        data = server.fs_browse(root)
        assert data is not None, f"文件系统根 {root} 应可浏览"
        assert data["path"] == os.path.realpath(root)
        assert data["parent"] == "", f"文件系统根 {root} 的 parent 应是空串（进根视角）"

    # 普通目录的 parent 不回归成空串（仍是上级目录）
    sub = tmp_path / "sub"
    sub.mkdir()
    normal = server.fs_browse(str(sub))
    assert normal["parent"] == os.path.realpath(str(tmp_path))


# ---------- HTTP 端点层（隔离实例） ----------

def test_browse_endpoint_root_view_vs_filesystem_root(isolated_server):
    """端点口径：根视角 parent=null；文件系统根 parent=''；普通目录 parent=上级目录。"""
    srv = isolated_server
    code, d = srv.admin.json("/api/fs/browse")
    assert code == 200, d
    assert d["path"] == "" and d["parent"] is None, d
    assert d["dirs"] == [{"name": r, "path": r} for r in d["roots"]], d

    root = d["roots"][0]
    code, r = srv.admin.json(f"/api/fs/browse?path={urllib.parse.quote(root)}")
    assert code == 200, r
    assert r["path"] == os.path.realpath(root)
    assert r["parent"] == "", r

    code, p = srv.admin.json(f"/api/fs/browse?path={urllib.parse.quote(srv.proj_dir)}")
    assert code == 200, p
    assert p["parent"] == os.path.dirname(os.path.realpath(srv.proj_dir)), p
