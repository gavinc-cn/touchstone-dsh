#!/usr/bin/env python3
"""对拍探针（过渡期专用，Gate 2 删 Python 时一并删除）：在**同一个会话存储**上跑
Python `sessparse` 的读口，把结果 dump 成 JSON 供 Node 侧逐字段比对。

为什么需要它：Node 版 `backend/lib/sessparse.js` 的判据是「与 Python 逐字段相等」，
而只有真跑 Python 才能给出这个基准（`tools/parity/sess-run.mjs` 是调用方）。

用法：
    python3 tools/parity/probe/sessparse.py [--root <sessions 根>] [--request <json 文件>]
    缺省从 stdin 读一个 JSON 请求：
        {"root": "<可选，覆盖 sessparse.DSH_SESSIONS>", "ops": [{"op": "...", ...}, ...]}
    每个 op 输出一行 JSON：{"i": <序号>, "ok": true, "value": ...}
                     或 {"i": <序号>, "ok": false, "error_kind": "TypeError", "error": "..."}

`--root` 只改 `sessparse.DSH_SESSIONS`（等价于 Python 测试里的 monkeypatch），
用于把两侧指到同一份冻结快照（`~/.dsh/sessions` 一律只读，绝不写入）。

支持的 op（字段即 Python 函数的实参）：
    root / bucket{cwd} / exists{family,sid} / subagent{family,sid} / load{family,sid,agent,after}
    title{family,sid} / first_prompt{sid} / meta{sid} / list{family,cwd} / latest{cwd}
    live{family,cwd,since} / anchors{sid} / fork{sid,mid} / pick{sdir} / header{sid}
    scan_titles{sid} / trunc{text,limit} / prompt_tokens{usage} / obj{raw} / nonneg_int{value}
    archive_ids / cache_clear
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))))

import sessparse  # noqa: E402


def _path_of(sid):
    """会话 id → 事件流文件路径（找不到返回 None）。"""
    return sessparse._dsh_session_file(sid)


def _meta(sid):
    """内部 `_dsh_meta` 直读（标题 / 首问 / 全部标题事件 + 命中的文件），供逐字段对拍。"""
    path = _path_of(sid)
    if not path:
        return {"path": None, "title": "", "prompt": "", "titles": []}
    title, prompt, titles = sessparse._dsh_meta(path)
    return {"path": path, "title": title, "prompt": prompt, "titles": list(titles)}


def _header(sid):
    """头行（origin/delegationDepth 等）；无会话返回 {}。"""
    path = _path_of(sid)
    return sessparse._dsh_header(path) if path else {}


def _scan_titles(sid):
    """`_dsh_scan_titles`（全部标题事件）——与 `_dsh_meta` 独立走一遍，防缓存掩盖差异。"""
    path = _path_of(sid)
    return sessparse._dsh_scan_titles(sessparse._dsh_decompressed(path)) if path else []


def _fork_first(sid):
    """该会话首个提问锚点的 fork 边界（组合读口：anchors → fork_boundary）。"""
    anchors = sessparse.dsh_user_anchors(sid)
    return sessparse.dsh_fork_boundary(sid, anchors[0]["mid"]) if anchors else None


def _media(case, media_id):
    """`resolve_media` 的返回形态（字节级）：把 `dshdriver.media` 打桩成固定响应后调用。

    Python 侧 `resolve_media` 是同步的（Node 侧是 async，对拍器 await 一层即可，判据一致）：
    返回 `None` 或 `{len, sha256, ctype}`——二进制不进 JSON，用长度+摘要比。
    """
    import base64 as _b64
    orig = sessparse.dshdriver.media

    def _resp(data, ctype):
        return lambda aid: {"data": data, "content_type": ctype}

    try:
        if case == "ok":
            sessparse.dshdriver.media = _resp(_b64.b64encode(b"hello-media").decode(), "image/png")
        elif case == "empty":
            sessparse.dshdriver.media = _resp("", "image/png")
        elif case == "noreq":
            sessparse.dshdriver.media = lambda aid: {"data": _b64.b64encode(b"x").decode()}
        elif case == "badb64":
            sessparse.dshdriver.media = _resp("!!!!", "image/png")
        elif case == "throw":
            def boom(aid):
                raise sessparse.dshdriver.DshDriverError(404, "附件不存在")
            sessparse.dshdriver.media = boom
        else:
            return {"error_kind": "UnknownCase", "case": case}
        got = sessparse.resolve_media("dsh", "s", "main", media_id)
    finally:
        sessparse.dshdriver.media = orig
    if got is None:
        return None
    data, ctype = got
    return {"len": len(data), "sha256": hashlib.sha256(data).hexdigest(), "ctype": ctype}


def _decompressed_sha(path):
    """解压文本指纹（坏帧容错相位的判据）：码点数 / UTF-16 码元数（= JS `.length`）+ sha256。"""
    text = sessparse._dsh_decompressed(path)
    encoded = text.encode("utf-8")
    return {"len_cp": len(text),                              # Python len(str)：码点数
            "len_js": len(text.encode("utf-16-le")) // 2,      # JS String.length：UTF-16 码元数
            "sha256": hashlib.sha256(encoded).hexdigest()}


OPS = {
    "root": lambda o: sessparse.DSH_SESSIONS,
    "bucket": lambda o: sessparse.dsh_bucket(o.get("cwd")),
    "exists": lambda o: sessparse.session_exists(o["family"], o["sid"]),
    "subagent": lambda o: sessparse.is_subagent(o["family"], o["sid"]),
    "load": lambda o: sessparse.load(o["family"], o["sid"], o.get("agent"), o.get("after", 0)),
    "title": lambda o: sessparse.session_title(o["family"], o["sid"]),
    "first_prompt": lambda o: sessparse.dsh_first_prompt(o["sid"]),
    "meta": lambda o: _meta(o["sid"]),
    "header": lambda o: _header(o["sid"]),
    "scan_titles": lambda o: _scan_titles(o["sid"]),
    "fork_first": lambda o: _fork_first(o["sid"]),
    "media": lambda o: _media(o["case"], o["media_id"]),
    "decompressed_sha": lambda o: _decompressed_sha(o["path"]),
    "list": lambda o: sessparse.list_sessions(o["family"], o["cwd"]),
    "latest": lambda o: sessparse.dsh_latest_session(o["cwd"]),
    "live": lambda o: sessparse.live_session_id(o["family"], o["cwd"], o["since"]),
    "anchors": lambda o: sessparse.dsh_user_anchors(o["sid"]),
    "fork": lambda o: sessparse.dsh_fork_boundary(o["sid"], o.get("mid")),
    "pick": lambda o: sessparse._dsh_pick_file(o["sdir"]),
    "format_version": lambda o: sessparse._dsh_format_version(o["path"]),
    "trunc": lambda o: sessparse._trunc(o["text"], o["limit"]),
    "prompt_tokens": lambda o: sessparse._dsh_prompt_tokens(o.get("usage")),
    "obj": lambda o: sessparse._obj(o["raw"]),
    "nonneg_int": lambda o: sessparse._nonneg_int(o.get("value")),
    "line_at": lambda o: sessparse._line_at(o["text"], o["idx"]),
    "archive_ids": lambda o: sorted(sessparse._dsh_archived_ids()),
    "cache_clear": lambda o: (sessparse.cache_clear(), None)[1],
}


def main(argv):
    root = None
    request_path = None
    i = 1
    while i < len(argv):
        if argv[i] == "--root":
            i += 1
            root = argv[i]
        elif argv[i] == "--request":
            i += 1
            request_path = argv[i]
        else:
            print(f"未知参数: {argv[i]}", file=sys.stderr)
            return 2
        i += 1
    raw = open(request_path, encoding="utf-8").read() if request_path else sys.stdin.read()
    req = json.loads(raw)
    if root or req.get("root"):
        sessparse.DSH_SESSIONS = root or req["root"]
    for idx, op in enumerate(req.get("ops") or []):
        name = op.get("op")
        fn = OPS.get(name)
        if fn is None:
            print(json.dumps({"i": idx, "ok": False, "error_kind": "UnknownOp",
                              "error": f"未知 op: {name}"}, ensure_ascii=False), flush=True)
            continue
        try:
            value = fn(op)
        except Exception as e:  # noqa: BLE001 —— 探针要把异常形态如实带给对拍器
            print(json.dumps({"i": idx, "ok": False, "error_kind": type(e).__name__,
                              "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False), flush=True)
            continue
        print(json.dumps({"i": idx, "ok": True, "value": value}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
