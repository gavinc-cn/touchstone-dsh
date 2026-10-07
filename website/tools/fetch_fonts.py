#!/usr/bin/env python3
"""按页面实际用字生成自托管字体子集（Touchstone 官网）。

为什么要有这个脚本：官网不引入任何构建工具，字体也必须离线可用，所以
不能靠 <link> 引 Google Fonts。做法是「先把页面用到的字符全扫出来，再让
Google Fonts 按 text= 精确切片」，得到只含这些字的 woff2，落到
assets/fonts/ 下，由 site.css 的 @font-face 引用。

用法：
    python3 tools/fetch_fonts.py            # 生成（覆盖同名文件）
    python3 tools/fetch_fonts.py --measure  # 只报告每个字体的切片体积，不落盘

注意：改了 index.html / zh.html 的文案后要重跑本脚本，否则新增的字会
回落到系统字体（site.css 的字体栈里留了 PingFang SC / Microsoft YaHei 兜底）。
"""

import argparse
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 扫哪些页面 = 承载正文的四页（英文首页 / 中文页 / 中英 Demo）。
# en.html 自 2026-10-07 起是**跳转壳**（0 秒转到站点根，正文只剩一行兜底链接），
# 有意不入列表：实测它的 31 个用字全部是这四页的子集 ⇒ 改壳的文案不必重跑本脚本。
PAGES = ("index.html", "zh.html", "demo.html", "en-demo.html")
# 在线 Demo 的界面文案集中在字典里（ui.js 只是渲染器，不含可见文案），
# 所以额外扫这份 js 的**字符串字面量**：注释里的中文不算（先剥注释再取引号内容）。
JS_SOURCES = ("assets/demo/i18n.js",)
OUT_DIR = os.path.join(ROOT, "assets", "fonts")

# (输出文件名, Google 家族与轴, 权重, 是否中文字族)
# 中文只用「展示体（宋体）」自托管：标题字数少、切片小；正文中文交给系统字体，
# 避免为了让正文好看而背上 1MB 级的 CJK 子集。
FACES = (
    ("noto-serif-sc-900.woff2", "Noto+Serif+SC:wght@900", 900, True),
    ("noto-serif-sc-700.woff2", "Noto+Serif+SC:wght@700", 700, True),
    ("noto-sans-sc-400.woff2", "Noto+Sans+SC:wght@400", 400, True),
    ("noto-sans-sc-500.woff2", "Noto+Sans+SC:wght@500", 500, True),
    ("noto-sans-sc-700.woff2", "Noto+Sans+SC:wght@700", 700, True),
    ("fraunces-900.woff2", "Fraunces:opsz,wght@144,900", 900, False),
    ("plex-sans-400.woff2", "IBM+Plex+Sans:wght@400", 400, False),
    ("plex-sans-500.woff2", "IBM+Plex+Sans:wght@500", 500, False),
    ("plex-sans-600.woff2", "IBM+Plex+Sans:wght@600", 600, False),
    ("jetbrains-mono-400.woff2", "JetBrains+Mono:wght@400", 400, False),
    ("jetbrains-mono-700.woff2", "JetBrains+Mono:wght@700", 700, False),
)

# 单次 text= 请求的编码长度上限：实测（2026-10-07）超过 ~6550 个百分号编码字符后，
# Google Fonts 会放弃「精确子集」改回上百个 unicode-range 切片，脚本只能拿到第一个
# 切片（2.7KB，等于整份子集做废）。留足余量取 4500，超了就分批请求 + 本地合并。
REQ_BUDGET = 4500

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

TAG_RE = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
ANY_TAG_RE = re.compile(r"<[^>]+>")
ENT_RE = re.compile(r"&(?:[a-zA-Z]+|#\d+);")
# 切片里只保留会用到的可见字符与中西文标点，丢弃纯排版符号
SKIP = set(" \t\r\n")

# 不参与子集请求的字符区间：emoji / 杂项符号 / 几何图形 / 变体选择符 / 区域旗标。
# 两个原因：① 它们本来就不在中西文字族里，页面里靠系统 emoji 字体兜底；
# ② 实测（2026-10-07）text= 里混进这些码位时，Google Fonts 会转而返回上百个
#    unicode-range 切片（像普通 CJK 请求那样），脚本取到的第一个切片只有 2.7KB，
#    等于把整份子集做废。滤掉之后恢复成「一份精确子集」。
SKIP_RANGES = (
    (0x1F000, 0x1FAFF),   # emoji 与图形
    (0x2600, 0x27BF),     # ☰ ⚙ ✓ ✕ ★ 等杂项符号与装饰符
    (0x2B00, 0x2BFF),     # ⬛ ⭐ 等
    (0x2300, 0x23FF),     # ⌚ ⏰ 等技术符号
    (0x25A0, 0x25FF),     # ▾ ▶ ● 等几何图形（README 已约定这类符号一律用 CSS 画）
    (0xFE00, 0xFE0F),     # 变体选择符
    (0x1F1E6, 0x1F1FF),   # 区域旗标
)


def renderable(chars):
    """滤掉不参与子集请求的码位（emoji/符号），只留字库真能提供的字符。"""
    out = set()
    for c in chars:
        cp = ord(c)
        if any(lo <= cp <= hi for lo, hi in SKIP_RANGES):
            continue
        out.add(c)
    return out


def page_chars(path):
    """取出一个页面里所有会渲染的字符（含 title/aria/data-* 属性文本）。

    保守取值：把标签剥掉后剩下的全部字符都算进去，宁可多切几个字，
    也不要漏字导致页面上出现豆腐块。
    """
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    html = TAG_RE.sub(" ", html)          # script/style 整块丢掉
    html = ANY_TAG_RE.sub(" ", html)      # 其余标签剥掉，属性文本一并保留
    html = ENT_RE.sub(" ", html)
    return {c for c in html if c not in SKIP}


def js_chars(path):
    """取出一个 js 文件里会显示出来的字符：先剥注释，再只保留字符串字面量的内容。

    为什么不整份文件取值：代码标识符是 ASCII（加进去几乎不涨体积，但没必要），
    而注释里有成片中文，整份取值会白背几十 KB 的 CJK 子集。
    """
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)          # 块注释
    src = re.sub(r"(?m)^\s*//.*$", " ", src)                  # 整行注释
    chars = set()
    for m in re.finditer(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"", src):
        lit = m.group(1) if m.group(1) is not None else m.group(2)
        chars |= {c for c in lit if c not in SKIP}
    return chars


def collect(pages):
    chars = set()
    for name in pages:
        path = os.path.join(ROOT, name)
        if os.path.exists(path):
            chars |= page_chars(path)
    for name in JS_SOURCES:
        path = os.path.join(ROOT, name)
        if os.path.exists(path):
            chars |= js_chars(path)
    return chars


def css_for(spec, text):
    url = ("https://fonts.googleapis.com/css2?family=" + spec +
           "&text=" + urllib.parse.quote(text))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=40).read().decode("utf-8")


def woff2_url(css):
    m = re.search(r"url\((https://[^)]+\.woff2?[^)]*)\)", css)
    if not m:
        m = re.search(r"url\((https://[^)]+)\)", css)
    return m.group(1) if m else None


def encoded_len(text):
    """percent-编码后的长度（Google 的 text= 限制按编码后的 URL 长度算）。"""
    return len(urllib.parse.quote(text))


def fetch_subset(spec, text):
    """取一份精确子集的 woff2 字节；拿不到（或返回的是切片）返回 None。"""
    css = css_for(spec, text)
    if css.count("@font-face") != 1:      # >1 说明退回切片模式，不是精确子集
        return None
    url = woff2_url(css)
    if not url:
        return None
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=60).read()


def split_batches(chars):
    """按编码长度把字符集切成若干批，每批都不超过 REQ_BUDGET。"""
    batches, cur, size = [], [], 0
    for c in chars:
        n = encoded_len(c)
        if cur and size + n > REQ_BUDGET:
            batches.append(cur)
            cur, size = [], 0
        cur.append(c)
        size += n
    if cur:
        batches.append(cur)
    return batches


def merge_woff2(parts):
    """把同一字族的多份子集合并成一份 woff2（需要 fontTools + brotli）。"""
    try:
        import io
        from fontTools.ttLib import TTFont
        from fontTools.merge import Merger
    except ImportError:
        return None
    try:
        merged = Merger().merge([io.BytesIO(p) for p in parts])
        merged.flavor = "woff2"
        buf = io.BytesIO()
        merged.save(buf)
        return buf.getvalue()
    except Exception as exc:                                  # noqa: BLE001
        print("      合并失败：%s" % exc, file=sys.stderr)
        return None


def fetch_face(spec, chars):
    """取一份字体的子集：能一次拿完就一次拿；超限则分批 + 合并。

    返回 (woff2 字节, 未覆盖的字符集合)。
    """
    ordered = sorted(chars)
    if encoded_len("".join(ordered)) <= REQ_BUDGET:
        data = fetch_subset(spec, "".join(ordered))
        return data, (set() if data else set(ordered))

    batches = split_batches(ordered)
    print("      ↳ 用字超出单次请求上限，分 %d 批请求后合并" % len(batches))
    parts, dropped = [], []
    for batch in batches:
        data = fetch_subset(spec, "".join(batch))
        if data is None:
            dropped.extend(batch)
        else:
            parts.append(data)
    if not parts:
        return None, set(ordered)
    if len(parts) == 1:
        return parts[0], set(dropped)
    merged = merge_woff2(parts)
    if merged is None:
        # 没有 fontTools/brotli 时退化为「只保留第一批」，并如实报出缺字
        print("      警告：缺 fontTools/brotli，合并未做，仅保留第一批；"
              "缺字会回落到系统字体", file=sys.stderr)
        return parts[0], set(ordered) - set(batches[0]) | set(dropped)
    return merged, set(dropped)


def check_coverage(path, chars):
    """核对子集是否覆盖给定字符集，返回缺失字符。fontTools 缺失时跳过检查。"""
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        return set()
    font = TTFont(path)
    cmap = set()
    for table in font["cmap"].tables:
        cmap |= set(table.cmap.keys())
    return {c for c in chars if ord(c) not in cmap}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", action="store_true", help="只测体积，不写文件")
    ap.add_argument("--verify", action="store_true", help="下载后核对字库是否覆盖页面用字")
    args = ap.parse_args()

    chars = collect(PAGES)
    skipped = chars - renderable(chars)
    chars = renderable(chars)
    text = "".join(sorted(chars))
    cjk = sum(1 for c in chars if ord(c) > 0x2E80)
    print("页面用字：%d 个（其中中日韩 %d 个）；另有 %d 个 emoji/符号不参与子集（走系统字体）"
          % (len(chars), cjk, len(skipped)))
    if len(text) > 2800:
        print("警告：用字过多，text= 请求可能被拒", file=sys.stderr)

    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    latin_chars = {c for c in chars if ord(c) < 0x2E80}
    for fname, spec, _weight, is_cjk in FACES:
        face_chars = chars if is_cjk else latin_chars
        try:
            data, missing = fetch_face(spec, face_chars)
        except Exception as exc:                      # noqa: BLE001 - 网络问题按行报告
            print("  %-26s 失败：%s" % (fname, exc), file=sys.stderr)
            continue
        if data is None:
            print("  %-26s 未取到 woff2（该字族可能不含这些字）" % fname)
            continue
        total += len(data)
        print("  %-26s %7.1f KB%s" % (fname, len(data) / 1024.0,
                                       "" if not missing else "（缺 %d 字，回落系统字体）" % len(missing)))
        if not args.measure:
            with open(os.path.join(OUT_DIR, fname), "wb") as fh:
                fh.write(data)
            if args.verify:
                absent = check_coverage(os.path.join(OUT_DIR, fname), face_chars)
                # 拉丁字族本来就不含中文，只对中日韩字族报缺字
                if absent and is_cjk:
                    print("      ↳ 缺 %d 个字符（该字族本就不含时可忽略）：%s"
                          % (len(absent), "".join(sorted(absent)[:12])))
    print("合计 %.1f KB" % (total / 1024.0), "(未落盘)" if args.measure else "→ assets/fonts/")


if __name__ == "__main__":
    main()
