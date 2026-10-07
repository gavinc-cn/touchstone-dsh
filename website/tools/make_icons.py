#!/usr/bin/env python3
"""生成官网图标族：assets/favicon.svg、favicon.ico、assets/apple-touch-icon.png。

为什么要有这个脚本：站点图标浏览器是**自己去要**的（标签页、书签栏、历史记录、
手机「添加到主屏」），它必须作为文件躺在站点里，不能像页面元素那样按需生成。

为什么不能只丢一个 favicon.ico 了事：
    GitHub Pages 的项目站点挂在 /<仓库名>/ 子路径下，而浏览器「没写 link 时」的
    兜底请求打的是**源站根**——https://gavinc-cn.github.io/favicon.ico，不是页面
    所在目录。那个地址不属于本站，放文件也管不到。所以真正生效的是每个 HTML 里
    显式的 <link rel="icon">（正文四页 + 一个跳转壳，共五个文件）；根目录这份
    favicon.ico 只服务于 file:// 直接打开与老浏览器。

图形：与产品字标同一枚（webui/src/components/TouchstoneLogo.jsx，24 单位原稿）——
    圆角方块「试金石」+ 负形 T 刻痕。两处刻意的偏差，都是为小尺寸让路：
      1. 方块放大到几乎满画布：原稿四周留 25% 空白是为了跟文字并排；图标是独立
         方块，同样的留白等于把 16px 里的有效像素再砍掉一半。
      2. T 的笔画加粗 20%（原稿占方块 17.8% → 21%）：16px 下 2.8px 的笔画会被
         抗锯齿磨掉一层，加粗后才立得住。
    配色取站点设计 token（site.css 的 --star #E8B86D → --st-alloy #F2A65A 渐变、
    --night #0B1426 的 T）。原稿的 T 是负形（透出底层背景），图标这里改成实心：
    标签栏底色不归我们管，实心才能保证任何底色上都读得出来。

用法：
    python3 tools/make_icons.py            # 生成（覆盖同名文件）
    python3 tools/make_icons.py --check    # 只核对已落盘的文件是否与预期一致

依赖：SVG 部分是纯标准库；栅格化（.ico 与 apple-touch-icon）需要 Playwright +
    Chromium（pip install -r requirements-dev.txt && python3 -m playwright install chromium）。
    缺 Playwright 时脚本仍会写出 favicon.svg，并提示栅格文件未更新。

改了图形或配色后要重跑本脚本，否则三个文件会互相不一致（--check 能查出漂移）。
"""

import argparse
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_OUT = os.path.join(ROOT, "assets", "favicon.svg")
ICO_OUT = os.path.join(ROOT, "favicon.ico")
TOUCH_OUT = os.path.join(ROOT, "assets", "apple-touch-icon.png")

# 站点设计 token（与 assets/site.css 的 :root 一致；改色要两边一起改）
GRAD_FROM = "#E8B86D"   # --star
GRAD_TO = "#F2A65A"     # --st-alloy
INK = "#0B1426"         # --night

# 24 单位原稿几何（TouchstoneLogo.jsx 的路径逐值抄下来，免得靠读路径字符串猜）
SRC_BOX = 24.0          # 原稿画布
SRC_TILE = 18.0         # 方块边长（3..21）
SRC_RX = 5.6            # 方块圆角
SRC_T_W = 8.8           # T 总宽（7.6..16.4）
SRC_T_H = 11.2          # T 总高（6.6..17.8）
SRC_STROKE = 3.2        # T 笔画宽（横竖同宽：横 6.6..9.8 / 竖 10.4..13.6）
STROKE_GAIN = 1.2       # 图标里把笔画加粗到 120%

# .ico 里的尺寸：16 = 标签页，32 = 任务栏/书签，48 = 桌面快捷方式
ICO_SIZES = (16, 32, 48)
TOUCH_SIZE = 180        # iOS 主屏图标的标准边长


def _n(value):
    """把浮点数写成紧凑的 SVG 数值（去掉多余的零，避免生成结果随浮点尾巴抖动）。"""
    return f"{value:.2f}".rstrip("0").rstrip(".")


def mark_svg(box, inset):
    """生成一枚图标的 SVG 文本。

    box   —— viewBox 边长（正方形）
    inset —— 方块四周留白（0 = 满画布）。apple-touch 用 0：iOS 自己会套圆角
             遮罩，图里再留白就会被套两层；favicon 用 1，给抗锯齿留一格余量。
    """
    tile = box - 2 * inset
    scale = tile / SRC_TILE                     # 原稿 → 目标画布的放大倍数
    rx = SRC_RX / SRC_TILE * tile               # 圆角按原稿比例缩放（原稿 31%）
    cx = cy = box / 2.0

    w = SRC_T_W * scale                         # T 外框保持原稿比例
    h = SRC_T_H * scale
    stroke = SRC_STROKE * scale * STROKE_GAIN   # 只有笔画加粗

    left, right = cx - w / 2, cx + w / 2
    top, bottom = cy - h / 2, cy + h / 2
    bar_bottom = top + stroke                   # 横画下沿 = 竖画起点
    stem_l, stem_r = cx - stroke / 2, cx + stroke / 2

    rect = (f'<rect x="{_n(inset)}" y="{_n(inset)}" width="{_n(tile)}" '
            f'height="{_n(tile)}" rx="{_n(rx)}" fill="url(#tsGrad)"/>')
    t_path = (f'M{_n(left)} {_n(top)}H{_n(right)}V{_n(bar_bottom)}H{_n(stem_r)}'
              f'V{_n(bottom)}H{_n(stem_l)}V{_n(bar_bottom)}H{_n(left)}Z')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {_n(box)} {_n(box)}" width="{_n(box)}" height="{_n(box)}">\n'
        '  <defs>\n'
        '    <linearGradient id="tsGrad" x1="0" y1="1" x2="1" y2="0">\n'
        f'      <stop offset="0" stop-color="{GRAD_FROM}"/>\n'
        f'      <stop offset="1" stop-color="{GRAD_TO}"/>\n'
        '    </linearGradient>\n'
        '  </defs>\n'
        f'  {rect}\n'
        f'  <path fill="{INK}" d="{t_path}"/>\n'
        '</svg>\n'
    )


def build_ico(entries):
    """把若干 PNG 打包成 .ico（Vista 起支持 PNG 压缩条目，浏览器与 Windows 都认）。

    entries —— [(边长, PNG 字节), ...]，按尺寸升序
    """
    count = len(entries)
    header = struct.pack("<HHH", 0, 1, count)   # 0=图标, 1=ICO 类型, 数量
    offset = 6 + 16 * count                     # 目录项之后就是图像数据
    directory, blobs = b"", b""
    for size, data in entries:
        # 目录项边长字段是 1 字节：256 记 0；色深固定 32 位带 alpha
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + directory + blobs


def png_size(path):
    """只读 PNG 的 IHDR 拿宽高（不引第三方库）；失败返回 None。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def ico_sizes(path):
    """读 .ico 目录，返回里面登记的尺寸列表；失败返回 None。"""
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except OSError:
        return None
    if len(blob) < 6:
        return None
    reserved, kind, count = struct.unpack("<HHH", blob[:6])
    if reserved != 0 or kind != 1 or len(blob) < 6 + 16 * count:
        return None
    out = []
    for i in range(count):
        w, h = blob[6 + 16 * i], blob[6 + 16 * i + 1]
        out.append(256 if w == 0 else w)
    return out


def render_rasters():
    """用 Playwright + Chromium 把 SVG 栅格化成 .ico 与 apple-touch-icon。

    Chromium 缺位时返回中文原因串（调用方提示用户），不抛异常。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return "未安装 Playwright：pip install -r requirements-dev.txt"

    # 每个尺寸单独 set_content，让 Chromium 按目标像素栅格化（缩放大图会糊）
    jobs = [(size, mark_svg(32, 1), True) for size in ICO_SIZES]      # 透明背景
    jobs.append((TOUCH_SIZE, mark_svg(32, 0), False))                 # 满幅不透明

    shots = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for size, svg, transparent in jobs:
                page = browser.new_page(viewport={"width": size, "height": size})
                page.set_content(
                    "<style>html,body{margin:0;padding:0;background:transparent}</style>"
                    # 内联 SVG 直接用目标像素做宽高，避免浏览器做二次缩放
                    + svg.replace('width="32" height="32"',
                                  f'width="{size}" height="{size}"')
                )
                shots.append((size, page.screenshot(omit_background=transparent)))
                page.close()
            browser.close()
    except Exception as exc:  # noqa: BLE001 —— 渲染失败只报告，不让脚本整体崩
        return f"Chromium 渲染失败：{exc}"

    ico_bytes = build_ico(shots[:len(ICO_SIZES)])
    _write_bytes(ICO_OUT, ico_bytes)
    _write_bytes(TOUCH_OUT, shots[-1][1])
    print(f"  写入 {os.path.relpath(ICO_OUT, ROOT)}"
          f"（{len(ico_bytes) / 1024:.1f} KB，含 "
          + "/".join(str(s) for s in ICO_SIZES) + " 三档）")
    print(f"  写入 {os.path.relpath(TOUCH_OUT, ROOT)}"
          f"（{len(shots[-1][1]) / 1024:.1f} KB，{TOUCH_SIZE}×{TOUCH_SIZE}）")
    return None


def _write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def _write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def do_generate():
    """重新生成三个图标文件。"""
    svg = mark_svg(32, 1)
    _write_text(SVG_OUT, svg)
    print(f"  写入 {os.path.relpath(SVG_OUT, ROOT)}（矢量，{len(svg)} 字节）")

    problem = render_rasters()
    if problem:
        print(f"  !! 栅格文件未更新：{problem}", file=sys.stderr)
        return 1
    return 0


def do_check():
    """核对已落盘的文件：SVG 逐字节比，栅格文件只比尺寸（不重渲染）。

    PNG 字节会随 Chromium 版本变化，比字节只会误报；尺寸与存在性才是真信号。
    """
    ok = True
    expect_svg = mark_svg(32, 1)
    if not os.path.exists(SVG_OUT):
        print(f"缺失 {os.path.relpath(SVG_OUT, ROOT)}")
        ok = False
    else:
        with open(SVG_OUT, encoding="utf-8") as fh:
            got = fh.read()
        if got == expect_svg:
            print(f"OK   {os.path.relpath(SVG_OUT, ROOT)} 与生成器一致")
        else:
            print(f"漂移 {os.path.relpath(SVG_OUT, ROOT)} 与生成器不一致"
                  "（改过图形/配色后要重跑 make_icons.py）")
            ok = False

    if not os.path.exists(ICO_OUT):
        print(f"缺失 {os.path.relpath(ICO_OUT, ROOT)}")
        ok = False
    else:
        got_sizes = ico_sizes(ICO_OUT)
        if got_sizes == list(ICO_SIZES):
            print(f"OK   {os.path.relpath(ICO_OUT, ROOT)} 尺寸 "
                  + "/".join(str(s) for s in got_sizes))
        else:
            print(f"异常 {os.path.relpath(ICO_OUT, ROOT)} 尺寸登记为 "
                  f"{got_sizes}，期望 {list(ICO_SIZES)}")
            ok = False

    if not os.path.exists(TOUCH_OUT):
        print(f"缺失 {os.path.relpath(TOUCH_OUT, ROOT)}")
        ok = False
    else:
        size = png_size(TOUCH_OUT)
        if size == (TOUCH_SIZE, TOUCH_SIZE):
            print(f"OK   {os.path.relpath(TOUCH_OUT, ROOT)} {size[0]}×{size[1]}")
        else:
            print(f"异常 {os.path.relpath(TOUCH_OUT, ROOT)} 实际 {size}，"
                  f"期望 ({TOUCH_SIZE}, {TOUCH_SIZE})")
            ok = False
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser(
        description="生成官网图标族（favicon.svg / favicon.ico / apple-touch-icon.png）")
    parser.add_argument("--check", action="store_true",
                        help="只核对已落盘的文件，不重新生成")
    args = parser.parse_args()
    if args.check:
        return do_check()
    return do_generate()


if __name__ == "__main__":
    sys.exit(main())
