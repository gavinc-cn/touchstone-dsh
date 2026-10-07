#!/usr/bin/env python3
"""项目文件预览端点单测（GET /api/projects/<pid>/file）。

会话详情页把 agent 回答里出现的路径渲染成可点链接，点击经该端点读取内容预览：
- 只读；路径必须落在本项目「项目目录 / 工作目录」两个根内（realpath 包含判定，防穿越）
- 多用户隔离：非本人项目一律 404（_owned_project 红线）
- 文本预览 256KB 截断；二进制只标记不返回内容；raw=1 返回原文（text/plain + nosniff）
"""

import os

from serverfixture import isolated_server

PNG_1PX = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 32


def write(path, data, mode="wb"):
    """写文件（自动建父目录），data 为 str 时按 UTF-8 编码。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(data, str) and "b" in mode:
        data = data.encode("utf-8")
    with open(path, mode) as f:
        f.write(data)
    return path


def test_preview_relative_path_in_project_dir(isolated_server):
    """项目目录内的相对路径：返回文本内容与元信息。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-rel")
    write(os.path.join(srv.proj_dir, "docs", "a.md"), "# 标题\n正文\n")
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=docs/a.md")
    assert code == 200, d
    assert d["text"] == "# 标题\n正文\n"
    assert d["name"] == "a.md" and d["ext"] == "md"
    assert d["rel"] == "docs/a.md" and d["root"] == "project"
    assert d["binary"] is False and d["truncated"] is False
    assert d["size"] == len("# 标题\n正文\n".encode("utf-8"))
    assert d["path"] == os.path.realpath(os.path.join(srv.proj_dir, "docs", "a.md"))


def test_preview_absolute_and_work_dir(isolated_server):
    """绝对路径与工作目录（案例库）相对路径；项目目录优先。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-work")
    case = write(os.path.join(srv.work_dir, "free_style", "FS001_demo", "case.md"), "用例\n")
    # 工作目录内相对路径（agent 视角的案例库路径）
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=free_style/FS001_demo/case.md")
    assert code == 200, d
    assert d["root"] == "work" and d["rel"] == "free_style/FS001_demo/case.md"
    # 绝对路径
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path={case}")
    assert code == 200, d and d["root"] == "work"
    # 两侧同名时项目目录优先（与 agent CLI 的 cwd=project_dir 一致）
    write(os.path.join(srv.proj_dir, "same.md"), "项目目录版\n")
    write(os.path.join(srv.work_dir, "same.md"), "工作目录版\n")
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=same.md")
    assert code == 200 and d["text"] == "项目目录版\n", d


def test_preview_rejects_outside_roots(isolated_server):
    """越界（含目录穿越）一律 403，不泄漏根外内容。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-outside")
    secret = write(os.path.join(srv.sandbox, "secret.md"), "越界内容\n")
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path={secret}")
    assert code == 403, d
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=../secret.md")
    assert code == 403, d
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=docs/../../secret.md")
    assert code == 403, d


def test_preview_missing_dir_and_empty(isolated_server):
    """不存在 404、目录 400、缺 path 400。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-bad")
    write(os.path.join(srv.proj_dir, "docs", "a.md"), "x\n")
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=docs/none.md")
    assert code == 404, d
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=docs")
    assert code == 400 and "目录" in d["error"], d
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=")
    assert code == 400 and d["error"], d


def test_preview_binary_and_truncated(isolated_server):
    """二进制（含 NUL）只标记不给内容；超限文本截断并给标记。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-bin")
    write(os.path.join(srv.proj_dir, "img.png"), PNG_1PX)
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=img.png")
    assert code == 200 and d["binary"] is True and d["text"] == "", d
    big = "行\n" * (200 * 1024)              # ~400KB 文本
    write(os.path.join(srv.proj_dir, "big.txt"), big)
    code, d = srv.admin.json(f"/api/projects/{pid}/file?path=big.txt")
    assert code == 200 and d["truncated"] is True, d
    assert 0 < len(d["text"].encode("utf-8")) <= 256 * 1024
    assert d["binary"] is False and d["size"] == len(big.encode("utf-8"))


def test_preview_raw_headers(isolated_server):
    """raw=1：文本按 text/plain + nosniff 返回原文；二进制走附件下载。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-raw")
    # 故意用 .html 验证：即使内容是 HTML 也按纯文本下发（防同源 XSS）
    write(os.path.join(srv.proj_dir, "page.html"), "<script>alert(1)</script>\n")
    url = f"{srv.base}/api/projects/{pid}/file?path=page.html&raw=1"
    with srv.admin.opener.open(url, timeout=30) as r:
        body = r.read().decode("utf-8")
        assert r.status == 200
        assert r.headers.get("Content-Type").startswith("text/plain")
        assert r.headers.get("X-Content-Type-Options") == "nosniff"
        assert "attachment" not in (r.headers.get("Content-Disposition") or "")
    assert body == "<script>alert(1)</script>\n"
    # 二进制：附件下载 + octet-stream
    write(os.path.join(srv.proj_dir, "img.png"), PNG_1PX)
    url = f"{srv.base}/api/projects/{pid}/file?path=img.png&raw=1"
    with srv.admin.opener.open(url, timeout=30) as r:
        assert r.headers.get("Content-Type") == "application/octet-stream"
        assert "attachment" in r.headers.get("Content-Disposition")
        assert r.read() == PNG_1PX


def test_preview_isolation_and_auth(isolated_server):
    """他人项目 404（多用户隔离）；未登录 401。"""
    srv = isolated_server
    pid = srv.create_project(srv.admin, "preview-iso")
    write(os.path.join(srv.proj_dir, "docs", "a.md"), "admin 的文件\n")
    srv.create_user("preview_user", "pw123456")
    other = srv.login("preview_user", "pw123456")
    code, d = other.json(f"/api/projects/{pid}/file?path=docs/a.md")
    assert code == 404, d
    anon = srv.client()
    code, d = anon.json(f"/api/projects/{pid}/file?path=docs/a.md")
    assert code == 401, d
