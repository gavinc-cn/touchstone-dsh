#!/usr/bin/env python3
"""生成 zstd 帧头**变体**语料（对拍扫描器的边界路径用；过渡期探针，Gate 2 一并删除）。

为什么需要：真会话文件只覆盖了 dsh 实际用到的写法（单段帧、无 checksum、无字典），而扫描器
要按规范解析 Frame_Header 的每一个宽度档。这里用 Python `zstandard` 造出各种组合，交给
`tools/parity/zstd-run.mjs` 与 Node 侧逐帧比对——「真文件没覆盖到的分支」也必须有证据。

用法：python3 tools/parity/probe/make_zstd_variants.py <输出目录>
产物：每个变体一个文件（名字即口径），外加一个 `manifest.json`（说明每个变体的期望帧数）。
"""
import json
import os
import sys

import zstandard

TEXTS = [
    "第一帧：中文 content\n",
    '{"a": 1, "b": [1, 2, 3], "c": "汉字"}\n',
    "第三帧" * 200 + "\n",
    "",
    "x" * 100000 + "\n",
]


def frames_bytes(compressor, texts):
    """按「一次追加一帧」逐帧压缩（dsh 的写法）"""
    return b"".join(compressor.compress(t.encode("utf-8")) for t in texts)


def variants(outdir):
    made = {}

    def write(name, blob, note):
        path = os.path.join(outdir, name)
        with open(path, "wb") as f:
            f.write(blob)
        made[name] = {"bytes": len(blob), "note": note}

    # ① 默认（单段帧、无 checksum、无 content-size）
    write("default.zstd", frames_bytes(zstandard.ZstdCompressor(), TEXTS),
          "默认参数，5 帧（dsh 的实际写法）")
    # ② 带 xxhash 校验和 ⇒ FHD 的 checksum 位 + 帧尾 4 字节
    write("checksum.zstd", frames_bytes(zstandard.ZstdCompressor(write_checksum=True), TEXTS),
          "每帧尾部带 4 字节 xxhash")
    # ③ 不写 content-size ⇒ FCS 宽度档变化
    write("no_content_size.zstd",
          frames_bytes(zstandard.ZstdCompressor(write_content_size=False), TEXTS),
          "Frame_Content_Size 缺省（另一档位）")
    # ④ 带字典 ⇒ Dictionary_ID 位（本机 python-zstandard 只支持训练字典带 id，宽度为 2 字节
    #    ⇒ 覆盖 dictFlag=2；dictFlag=3（4 字节 id）无 API 可造，扫描器里是同一条表达式，报告里注明）
    samples = [f'{{"type":"session/title","title":"样本 {i}"}}'.encode() for i in range(200)]
    trained = zstandard.train_dictionary(1024, samples, dict_id=0x1234)
    write("dict.zstd",
          frames_bytes(zstandard.ZstdCompressor(dict_data=trained), TEXTS),
          f"训练字典（dictID=0x{trained.dict_id():x}，dictFlag=2）")
    # ⑤ 高压缩等级（块类型/块数不同）+ 大窗口提示
    write("level22.zstd",
          frames_bytes(zstandard.ZstdCompressor(level=22), TEXTS),
          "最高压缩等级（块结构与默认不同）")
    # ⑥ skippable frame 夹在标准帧中间
    skip = (0x184D2A50).to_bytes(4, "little") + (11).to_bytes(4, "little") + b"skip-me-now"
    plain = zstandard.ZstdCompressor()
    blob = plain.compress(TEXTS[0].encode()) + skip + plain.compress(TEXTS[1].encode())
    write("skippable_middle.zstd", blob, "标准帧 + skippable 帧 + 标准帧")
    # ⑦ 尾部半截帧（模拟 dsh 边写边读）
    full = frames_bytes(zstandard.ZstdCompressor(), TEXTS[:2])
    write("truncated_tail.zstd", full + full[-13:], "尾部多出 13 字节半截帧")
    # ⑧ 空文件与纯垃圾
    write("empty.zstd", b"", "空文件")
    write("garbage.zstd", b"not zstd at all" * 3, "完全非 zstd")

    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"variants": made, "texts": TEXTS}, f, ensure_ascii=False, indent=2)
    return made


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    outdir = argv[1]
    os.makedirs(outdir, exist_ok=True)
    made = variants(outdir)
    for name, info in made.items():
        print(f"{name:26s} {info['bytes']:>9d} B  {info['note']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
