#!/usr/bin/env python3
"""把 tools/og_card.html 渲成两张分享卡片图：assets/og-zh.png、assets/og-en.png。

为什么要有这个脚本：把官网链接粘进微信 / 飞书 / Slack / X / Telegram / Discord 时，
这些平台会来读页面 <head> 里的 og:image，把它当成链接预览的缩略图。它们**不认 SVG**，
所以卡片必须是一张栅格图；而卡片又要跟站点同一套字体、配色、看板形态，于是做法是
「HTML 模板 + 本地 Chromium 截屏」——不引任何设计工具，改字改色都在模板里改。

尺寸是硬约束：1200×630（1.91:1），这是各平台通用的链接预览比例；用别的比例会被
裁切或留白。所以脚本渲完会核对宽高，不对就报错退出。

用法：
    python3 tools/make_og.py            # 生成两张图（覆盖同名文件）
    python3 tools/make_og.py --check    # 只核对已落盘的两张图（存在 + 尺寸）
    python3 tools/make_og.py --open     # 生成后再把模板用浏览器打开一次，便于肉眼调版

依赖：Playwright + Chromium
    pip install -r requirements-dev.txt && python3 -m playwright install chromium

改了模板（文案 / 配色 / 排版）后要重跑本脚本，否则线上 og:image 还是旧图。
模板里的设计 token 与 assets/site.css 是同一批值，脚本每次都会先逐值核对，不一致
直接报错——防止「站点换了色，分享卡还是旧色」这种最难发现的不一致。
"""

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, "tools", "og_card.html")
CSS = os.path.join(ROOT, "assets", "site.css")

# (输出文件名, <html> 上要不要加 lang-en)
LANGS = (("og-zh.png", False), ("og-en.png", True))

OG_W, OG_H = 1200, 630          # 平台通用的链接预览尺寸
SIZE_LIMIT = 1_000_000          # 单张图的体积上限（各平台都在 5MB 以上，这里取严）

# 模板里抄过来的设计 token：必须与 site.css 的 :root 逐值一致。
# （字体栈不在核对范围：模板只引这张图用到的字重，故意省掉了系统兜底那一串。）
TOKENS = ("--night", "--midnight", "--cloud", "--star",
          "--ink-2", "--ink-3", "--rule", "--rule-soft")

ROOT_BLOCK = re.compile(r":root\s*\{(.*?)\}", re.S)
DECL = re.compile(r"(--[\w-]+)\s*:\s*([^;]+);")


def _norm(value):
    """把 CSS 值归一成可比形式：去空白、小写、0.5 → .5。

    两处写 `rgba(245, 241, 232, 0.72)` 与 `rgba(245,241,232,.72)` 是同一个颜色，
    核对要比「值」而不是比「写法」，否则每个 token 都会误报。
    """
    value = re.sub(r"\s+", "", value).lower()
    return re.sub(r"\b0\.(\d)", r".\1", value)


def _root_tokens(path):
    """读一份 CSS 里 :root 块的 token 表（值已归一）；找不到 :root 返回空字典。"""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    block = ROOT_BLOCK.search(text)
    if not block:
        return {}
    return {name: _norm(value) for name, value in DECL.findall(block.group(1))}


def check_tokens():
    """核对模板与 site.css 的 token。返回错误说明列表（空 = 一致）。"""
    site = _root_tokens(CSS)
    tpl = _root_tokens(TEMPLATE)
    problems = []
    for name in TOKENS:
        if name not in site:
            problems.append(f"site.css 里找不到 {name}")
        elif name not in tpl:
            problems.append(f"og_card.html 里找不到 {name}")
        elif site[name] != tpl[name]:
            problems.append(f"{name} 不一致：site.css={site[name]} / 模板={tpl[name]}")
    return problems


def png_size(path):
    """只读 PNG 的 IHDR 拿宽高（不引第三方库）；失败返回 None。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    import struct
    return struct.unpack(">II", head[16:24])


def render(open_after=False):
    """渲染两张卡片图。返回进程退出码。"""
    problems = check_tokens()
    if problems:
        print("设计 token 核对失败，拒绝出图：", file=sys.stderr)
        for item in problems:
            print(f"  - {item}", file=sys.stderr)
        return 1

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("未安装 Playwright：pip install -r requirements-dev.txt", file=sys.stderr)
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, is_en in LANGS:
            out = os.path.join(ROOT, "assets", name)
            page = browser.new_page(viewport={"width": OG_W, "height": OG_H})
            page.goto("file://" + TEMPLATE)
            if is_en:
                page.evaluate("document.documentElement.classList.add('lang-en')")
            # 等字体真正就位再截屏：否则会截到字体回落的中间态
            page.evaluate("() => document.fonts.ready")
            page.wait_for_timeout(150)
            page.screenshot(path=out)
            page.close()

            size = png_size(out)
            if size != (OG_W, OG_H):
                print(f"  !! {name} 尺寸 {size}，期望 {(OG_W, OG_H)}", file=sys.stderr)
                browser.close()
                return 1
            kb = os.path.getsize(out) / 1024
            flag = "（偏大，考虑改用 JPEG）" if os.path.getsize(out) > SIZE_LIMIT else ""
            print(f"  写入 assets/{name}（{size[0]}×{size[1]}，{kb:.0f} KB）{flag}")
        if open_after:
            page = browser.new_page(viewport={"width": OG_W, "height": OG_H})
            page.goto("file://" + TEMPLATE)
            page.pause()
        browser.close()
    return 0


def check_only():
    """核对已落盘的两张图：存在、尺寸、体积。"""
    ok = True
    for name, _ in LANGS:
        out = os.path.join(ROOT, "assets", name)
        if not os.path.exists(out):
            print(f"缺失 assets/{name}")
            ok = False
            continue
        size = png_size(out)
        if size != (OG_W, OG_H):
            print(f"异常 assets/{name} 尺寸 {size}，期望 {(OG_W, OG_H)}")
            ok = False
        else:
            print(f"OK   assets/{name} {size[0]}×{size[1]}，"
                  f"{os.path.getsize(out) / 1024:.0f} KB")
    problems = check_tokens()
    if problems:
        for item in problems:
            print(f"漂移 设计 token：{item}")
        ok = False
    else:
        print("OK   模板设计 token 与 site.css 一致")
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser(description="生成官网分享卡片图（og:image）")
    parser.add_argument("--check", action="store_true", help="只核对已落盘的图，不重渲染")
    parser.add_argument("--open", action="store_true",
                        help="生成后用浏览器打开模板（带 Playwright Inspector，便于调版）")
    args = parser.parse_args()
    if args.check:
        return check_only()
    return render(open_after=args.open)


if __name__ == "__main__":
    sys.exit(main())
