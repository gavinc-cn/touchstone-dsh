#!/usr/bin/env python3
"""对拍探针：用 Python 侧 zstandard **逐帧**解压 dsh 会话文件，输出可比对的指纹。

过渡期专用（Gate 2 删 Python 时一并删除）：它的存在意义就是「Node 的多帧扫描器与 Python
`decompressobj()` 是否逐帧一致」——单靠 Node 自己无法证明这一点。

口径与 `sessparse._dsh_decompressed` **逐字一致**（逐帧 `decompressobj()` + `unused_data`，
坏帧即停保留前序），这样比出来的差异才等于「解析行为差异」，而不是探针自己的口径差。

用法：python3 tools/parity/probe/zstd_frames.py <文件> [<文件> ...]
输出：每行一个 JSON（stdout），字段：
    path / lens（每帧解压字节数）/ frames / sha256（拼接结果）/ text_len / text_sha256
"""
import hashlib
import json
import sys

import zstandard


def probe(path):
    """逐帧解压一个文件，返回指纹 dict（读不到文件时 ok=False）。"""
    try:
        with open(path, "rb") as f:
            buf = f.read()
    except OSError as e:
        return {"path": path, "ok": False, "error": f"{type(e).__name__}: {e}"}
    dec = zstandard.ZstdDecompressor()
    chunks, lens = [], []
    rest = buf
    while rest:
        obj = dec.decompressobj()
        try:
            out = obj.decompress(rest)
        except zstandard.ZstdError as e:
            return {"path": path, "ok": True, "lens": lens, "frames": len(lens),
                    "sha256": hashlib.sha256(b"".join(chunks)).hexdigest(),
                    "text_cp": len(b"".join(chunks).decode("utf-8", errors="replace")),
                    "text_bytes": len(b"".join(chunks).decode("utf-8", errors="replace")
                                      .encode("utf-8")),
                    "text_sha256": hashlib.sha256(
                        b"".join(chunks).decode("utf-8", errors="replace").encode("utf-8")
                    ).hexdigest(),
                    "stopped": f"ZstdError: {e}"}
        chunks.append(out)
        lens.append(len(out))
        nxt = obj.unused_data
        if not nxt or len(nxt) >= len(rest):
            break
        rest = nxt
    blob = b"".join(chunks)
    text = blob.decode("utf-8", errors="replace")
    encoded = text.encode("utf-8")
    # 两个可比口径：**码点**数（Python `len(str)`）与 **UTF-8 字节**数（Node 的 `.length` 是
    # UTF-16 码元，遇非 BMP 字符会比码点多 —— 直接拿它比是量具自己的单位 bug，实测踩过）。
    return {"path": path, "ok": True, "lens": lens, "frames": len(lens),
            "sha256": hashlib.sha256(blob).hexdigest(),
            "text_cp": len(text), "text_bytes": len(encoded),
            "text_sha256": hashlib.sha256(encoded).hexdigest(), "stopped": ""}


def main(argv):
    for path in argv[1:]:
        print(json.dumps(probe(path), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
