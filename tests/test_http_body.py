#!/usr/bin/env python3
"""HTTP 请求体读取：**分块传输** + 空体守卫（2026-10-21 桌面端建项目事故回归）。

## 事故与根因（为什么这些用例必须存在）

DSH 桌面端的面板 iframe 走 `dsh-app://` 自定义协议：Electron 主进程的
`forwardWebRequest` 用 ReadableStream 重放请求体（`duplex:'half'`）⇒ 转出来的 POST
**只有 `Transfer-Encoding: chunked`、没有 `Content-Length`**（隔离 Electron 44 实测）。

旧 `_read_json` 只认 `Content-Length` ⇒ 请求体被静默当空：建项目回落到
`project_dir=~` / `name=家目录末段`（Windows 上就是用户名），第一次落了一条「家目录项目」，
之后每次空体请求都撞该项目的 `(user_id, name)` 唯一索引，而 `except sqlite3.IntegrityError`
把**任意**约束错都翻成「项目名已存在」⇒ 用户看到「明明没有这个项目却说已存在、无法添加」。
同一条读体路径覆盖所有写端点 ⇒ 桌面端面板的写操作（建项目/建任务/看板/作答…）整片失效。

## 本文件钉住的三件事

1. 分块请求体按 `Content-Length` 形态**等价解析**（含多块帧、跨多次读到达）；
2. 空体/无键请求体**不再兜底建项目**，而是 400 明确文案（且一条行都不落——不再产生撞名源）；
3. 只有 `(user_id, name)` 唯一索引冲突才叫「项目名已存在」；其他约束错照实上报（带 detail）。

注：`urllib` 发不出分块体，故这里用**原始 socket** 手写 HTTP/1.1 分块帧。
"""
import json
import os
import sqlite3
import socket

import pytest

from serverfixture import IsolatedServer, TRUST_HEADER

BODY_MISSING = "未收到项目信息（请求体为空或格式非法），请刷新页面后重试"
NAME_EXISTS = "项目名已存在"


@pytest.fixture(scope="module")
def srv():
    """插件形态隔离实例（免登信任头，供写端点直连）。"""
    s = IsolatedServer(trust_internal=True)
    s.start()
    try:
        yield s
    finally:
        s.stop()


def raw_request(srv, method, path, body=b"", *, chunked=False, chunk_size=7, extra_headers=None):
    """发一条原始 HTTP/1.1 请求，返回 (status, body_text)。

    `chunked=True` 时把 body 按 `chunk_size` 切成**多个真分块帧**发出（顺带覆盖
    「分块帧跨多次 rfile 读到达」这条路径）；否则发普通 Content-Length。
    """
    headers = {
        "Host": "127.0.0.1:%d" % srv.port,
        "Content-Type": "application/json",
        TRUST_HEADER: "admin",
        "Connection": "close",
    }
    headers.update(extra_headers or {})
    lines = ["%s %s HTTP/1.1" % (method, path)]
    lines += ["%s: %s" % (k, v) for k, v in headers.items()]
    if chunked:
        lines.append("Transfer-Encoding: chunked")
    else:
        lines.append("Content-Length: %d" % len(body))
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")
    if chunked:
        payload = b""
        step = max(1, chunk_size)
        for i in range(0, len(body), step):
            part = body[i:i + step]
            payload += b"%x\r\n" % len(part) + part + b"\r\n"
        payload += b"0\r\n\r\n"
    else:
        payload = body
    sock = socket.create_connection(("127.0.0.1", srv.port), timeout=20)
    try:
        sock.sendall(head + payload)
        received = b""
        while True:
            data = sock.recv(65536)
            if not data:
                break
            received += data
    finally:
        sock.close()
    head_raw, _, resp_body = received.partition(b"\r\n\r\n")
    status_line = head_raw.split(b"\r\n")[0].decode("utf-8", "replace")
    status = int(status_line.split(" ")[1])
    return status, resp_body.decode("utf-8", "replace")


def test_chunked_create_project_parsed_like_content_length(srv):
    """分块请求体建项目 ⇒ 200 且落库的是请求体里的名字/目录（不是家目录兜底）。"""
    project_dir = os.path.join(srv.sandbox, "chunked-proj")
    body = json.dumps({"name": "分块项目", "project_dir": project_dir},
                      ensure_ascii=False).encode("utf-8")
    status, text = raw_request(srv, "POST", "/api/projects", body, chunked=True)
    assert status == 200, text
    project_id = json.loads(text)["id"]
    # 回读：名字/目录逐字来自请求体；派生目录真被创建（建目录在 insert 之前，同一条路径）
    code, rows = srv.trust.json("/api/projects")
    assert code == 200
    row = [r for r in rows if r["id"] == project_id][0]
    assert row["name"] == "分块项目"
    assert row["project_dir"] == project_dir
    assert os.path.isdir(os.path.join(project_dir, ".touchstone", "free_style"))
    assert os.path.isdir(os.path.join(project_dir, ".touchstone", "bug_report"))


def test_chunked_other_write_endpoint(srv):
    """分块读体是**全局**入口：另一个写端点（fs/mkdir）分块体同样生效。"""
    base = os.path.join(srv.sandbox, "mkdir-base")
    os.makedirs(base, exist_ok=True)
    body = json.dumps({"path": base, "name": "chunked-sub"},
                      ensure_ascii=False).encode("utf-8")
    status, text = raw_request(srv, "POST", "/api/fs/mkdir", body, chunked=True)
    assert status == 200, text
    assert json.loads(text) == {"name": "chunked-sub", "path": os.path.join(base, "chunked-sub")}
    assert os.path.isdir(os.path.join(base, "chunked-sub"))


def test_empty_body_create_project_refused_without_row(srv):
    """无体 / chunked 空对象建项目 ⇒ 400 明确文案，且**一条行都不落**（家目录兜底退场）。"""
    code, before = srv.trust.json("/api/projects")
    assert code == 200
    # ① Content-Length: 0（无体）
    status, text = raw_request(srv, "POST", "/api/projects", b"")
    assert status == 400, text
    assert json.loads(text) == {"error": BODY_MISSING}
    # ② chunked 空 JSON 对象（旧实现会回落到 homedir ⇒ 落一条「用户名项目」并成为撞名源）
    status, text = raw_request(srv, "POST", "/api/projects", b"{}", chunked=True)
    assert status == 400, text
    assert json.loads(text) == {"error": BODY_MISSING}
    code, after = srv.trust.json("/api/projects")
    assert code == 200
    assert len(after) == len(before), "空体守卫必须一条项目行都不落"


def test_duplicate_name_keeps_original_message(srv):
    """真重名仍是原文案（对拍契约不变）。"""
    project_dir = os.path.join(srv.sandbox, "dup-proj")
    body = json.dumps({"name": "重名项目", "project_dir": project_dir},
                      ensure_ascii=False).encode("utf-8")
    status, text = raw_request(srv, "POST", "/api/projects", body)
    assert status == 200, text
    status, text = raw_request(srv, "POST", "/api/projects", body)
    assert status == 400, text
    assert json.loads(text) == {"error": NAME_EXISTS}


def test_non_name_constraint_error_reported_truthfully(srv):
    """非重名约束错（触发器 RAISE ABORT）⇒ 照实上报，不再冒充「项目名已存在」。"""
    conn = sqlite3.connect(srv.db_path)
    try:
        conn.execute("CREATE TRIGGER block_projects BEFORE INSERT ON projects "
                     "BEGIN SELECT RAISE(ABORT, 'forced non-name constraint'); END;")
        conn.commit()
        body = json.dumps({"name": "撞触发器项目",
                           "project_dir": os.path.join(srv.sandbox, "trigger-proj")},
                          ensure_ascii=False).encode("utf-8")
        status, text = raw_request(srv, "POST", "/api/projects", body)
        assert status == 400, text
        assert json.loads(text) == {
            "error": "项目创建失败（数据库约束: forced non-name constraint）",
        }
    finally:
        conn.execute("DROP TRIGGER IF EXISTS block_projects")
        conn.commit()
        conn.close()
