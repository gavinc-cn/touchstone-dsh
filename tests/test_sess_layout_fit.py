#!/usr/bin/env python3
"""会话详情窗「小分辨率窗口自适应」静态契约守卫（快层，2026-10-25 批次）。

用户报障原文：「会话详情页, 在分辨率比较小的时候会超出浏览器显示范围. 应该能够根据
浏览器框的大小动态调整.」

真机量测取证（1024×640 / 900×600 / 800×600，dsh 面板同源 iframe 里跑真数据）：

  1. **弹窗内容溢出**：`.sess-view` 是 shadcn DialogContent（grid）的 grid 子项，默认
     `min-width: auto` ⇒ 其 min-content 被「底栏控件行（`.sess-bottombar` nowrap，实测
     ~601px）+ 提问索引 240px」顶成 ~841px，而 75vw 弹窗内宽只有 728px（1024 视口）或
     558px（800 视口）⇒ 内容伸到弹窗右边界之外（`.sess-modal` 的 scrollWidth 889 >
     clientWidth 598/766），底栏「停止/发送」按钮被裁掉一半。
  2. **记忆尺寸超出视口**：`ts.sessW` 只存像素 {w,h} 且恢复时不夹取、窗口 resize 无监听
     ⇒ 大屏拖出来的 1500×900 在 1024×640 上恢复成 left=-238/top=-130（标题与关闭按钮
     整块在浏览器窗口外），这就是用户口中的「超出浏览器显示范围」。

修法契约（任一条被改回都会让小分辨率重新溢出/出屏，本文件只静态钉住、不跑浏览器）：

  A. 尺寸夹取（webui/src/utils/rzClamp.js 新文件 + hooks/useResizable.js 接线）：
     - 恢复记忆尺寸必须按当前视口夹取（loadSaved 调用 clampRzSize）；
     - 必须挂 window resize 监听并在卸载时摘掉，resize 时整框/尺寸重夹；
     - PAD/MIN_W/MIN_H 必须单源（useResizable 不再各写一份常量）。
  B. CSS（webui/src/styles/components.css，整体在 @layer legacy ⇒ 与 utilities 竞争要
     !important）：
     - `.sess-view` / `.sess-wrap` 必须 `min-width: 0`（grid/flex 子项可收缩，否则
       min-content 把内容顶出弹窗）；
     - `.sess-bottombar` 必须 `flex-wrap: wrap`（窄弹窗下控件折行，兜底不裁按钮）；
     - 底栏尾部按钮组 `.sess-endgroup` 必须 `margin-left: auto`（单行靠右；折行时整组
       仍贴右，不散落在新行左边）；
     - 默认尺寸 `.modal.sess-modal:not(.rz-drag)` 必须 `width: max(75vw, min(880px,96vw))`
       + `max-width: 96vw` + 左右 0/`margin-inline: auto` 居中（宽度不再固定 75vw，旧
       `calc(50% - 37.5vw)` 居中口径必须退场）；
     - **`!important` 尺寸规则必须限定 `:not(.rz-drag)`**：拖动/记忆尺寸由 useResizable
       的行内 width/height 驱动，若不排除会把用户拖出来的尺寸永久压回默认值（本条是
       本批最危险的回归点）。
  C. JSX（ComposerBar.jsx / SessionModal.jsx）：
     - 底栏「停止/发送」收进 `.sess-endgroup`（等价于原先 flex:1 占位，但折行时不散架）；
     - 默认宽度只有一个来源（CSS 的 max/min 规则），SessionModal 的 className 不再写死
       `w-[75vw]`（高度仍由 `h-[90vh]` 工具类给）。

运行：python3 -m pytest tests/test_sess_layout_fit.py -v（不需要浏览器/站点）
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS_PATH = os.path.join(ROOT, "webui", "src", "styles", "components.css")
HOOK_PATH = os.path.join(ROOT, "webui", "src", "hooks", "useResizable.js")
UTIL_PATH = os.path.join(ROOT, "webui", "src", "utils", "rzClamp.js")
COMPOSER_PATH = os.path.join(ROOT, "webui", "src", "components", "ComposerBar.jsx")
MODAL_PATH = os.path.join(ROOT, "webui", "src", "components", "SessionModal.jsx")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _blocks(text, selector):
    """取出 `selector { ... }` 的全部声明体（同一选择器可能被后文覆盖，需逐条判）。"""
    out = [m.group(1) for m in
           re.finditer(re.escape(selector) + r"\s*\{([^}]*)\}", text)]
    assert out, f"CSS 里找不到规则 {selector}"
    return out


def _block(text, selector):
    """取出 `selector { ... }` 的第一段声明体（无嵌套花括号场景足矣）。"""
    return _blocks(text, selector)[0]


def _rules(text):
    """列出 CSS 里的 (selector, body) 对（正则足够：本文件只有简单规则与 @media 嵌套）。"""
    return [(m.group(1).strip(), m.group(2)) for m in
            re.finditer(r"([^{}]+)\{([^{}]*)\}", text)]


# ============ A. 尺寸夹取：新 util + hook 接线 ============

def test_rz_clamp_util_exists_with_minimum_contract():
    assert os.path.isfile(UTIL_PATH), (
        "缺少 webui/src/utils/rzClamp.js —— 记忆尺寸/resize 的视口夹取必须落成纯函数"
        "（jsdom 单测见 webui/src/__tests__/rzClamp.test.js）")
    src = _read(UTIL_PATH)
    for name in ("rzViewportMax", "clampRzSize", "clampRzBox", "clampRzState",
                 "RZ_PAD", "RZ_MIN_W", "RZ_MIN_H"):
        assert name in src, f"rzClamp.js 缺导出 {name}"


def test_hook_imports_clamp_util_and_has_single_constant_source():
    src = _read(HOOK_PATH)
    assert "from '../utils/rzClamp'" in src, (
        "useResizable 必须从 utils/rzClamp 导入夹取函数（恢复/resize 两条路径共用出口）")
    assert "clampRzSize" in src and "clampRzBox" in src and "clampRzState" in src
    # 常量单源：PAD/MIN_W/MIN_H 不再在 hook 里各写一份（两份会漂移）
    for dead in ("const MIN_W = 400", "const MIN_H = 240", "const PAD = 8"):
        assert dead not in src, f"useResizable 不应再自写常量：{dead}"


def test_hook_restore_saved_size_is_clamped_by_viewport():
    src = _read(HOOK_PATH)
    m = re.search(r"function loadSaved\(.*?\n\}", src, re.S)
    assert m, "useResizable.js 里找不到 loadSaved 函数"
    body = m.group(0)
    assert "clampRzSize" in body, (
        "loadSaved 恢复记忆尺寸时必须按当前视口夹取——否则大屏拖出来的 1500×900 会在"
        "小窗口上原样恢复、弹窗跑到浏览器窗口外（就是本次用户报障）")


def test_hook_reclamps_on_window_resize():
    src = _read(HOOK_PATH)
    assert re.search(r"addEventListener\(\s*'resize'", src), (
        "useResizable 必须挂 window resize 监听（浏览器窗口/面板缩窄时把弹窗夹回视口内）")
    assert re.search(r"removeEventListener\(\s*'resize'", src), (
        "resize 监听必须在 effect 清理函数里摘掉（防重复挂载泄漏）")
    assert "clampRzBox" in src and "clampRzState" in src, (
        "resize 时应整框重夹（拖动过带 left/top）或按记忆偏好重夹（仅居中尺寸）")


# ============ B. CSS 契约 ============

def test_css_sess_view_and_wrap_can_shrink():
    css = _read(CSS_PATH)
    for sel in (".sess-view", ".sess-wrap"):
        assert any("min-width: 0" in b for b in _blocks(css, sel)), (
            f"{sel} 缺 min-width: 0 —— grid/flex 子项默认 min-width:auto，min-content"
            "（底栏控件行 ~601px + 提问索引 240px）会把内容顶出弹窗右边界")


def test_css_bottombar_wraps():
    body = _block(_read(CSS_PATH), ".sess-bottombar")
    assert "flex-wrap: wrap" in body, (
        ".sess-bottombar 必须 flex-wrap: wrap —— 窄弹窗下控件行放不下时折行兜底，"
        "而不是把「停止/发送」裁掉")
    assert "row-gap" in body, "折行后的行距（row-gap）必须显式给，否则两行挤在一起"


def test_css_endgroup_right_aligned():
    body = _block(_read(CSS_PATH), ".sess-endgroup")
    assert "margin-left: auto" in body, (
        ".sess-endgroup 必须 margin-left: auto（单行时靠右；折行时整组仍贴右）")
    assert "display: flex" in body


def test_css_modal_default_size_adapts_to_viewport():
    css = _read(CSS_PATH)
    sel = ".modal.sess-modal:not(.rz-drag)"
    body = _block(css, sel)
    assert "width: max(" in body and "min(" in body and "96vw" in body, (
        f"{sel} 的默认宽度必须是 max(75vw, min(880px, 96vw))：宽屏维持 75vw 观感，"
        "小视口让到 96vw 给内容留空间")
    assert "880px" in body, "小视口下弹窗宽度需按内容最小宽度给到 880px 量级"
    assert "max-width: 96vw" in body, "必须压过 DialogContent 的 sm:max-w-* 工具类封顶"
    assert "!important" in body, (
        "本文件在 @layer legacy（低于 utilities），不写 !important 压不住 DialogContent 的"
        " w-full / max-w-* 工具类")
    assert "margin-inline: auto" in body and "left: 0" in body and "right: 0" in body, (
        "宽度不再固定 75vw 后，calc(50% - 37.5vw) 的居中失效 ⇒ 必须左右贴边 + margin 自动居中")
    assert "top: 5vh" in body, "垂直定位维持原口径（5vh 顶边）"


def test_css_modal_size_important_scoped_out_of_drag_state():
    """!important 尺寸规则必须排除 .rz-drag，否则会压掉 useResizable 的行内拖拽尺寸。"""
    for sel, body in _rules(_read(CSS_PATH)):
        if ".modal.sess-modal" not in sel or "!important" not in body:
            continue
        if "width" not in body and "height" not in body:
            continue
        assert ":not(.rz-drag)" in sel, (
            f"`{sel}` 的 !important 尺寸会压过拖动/记忆尺寸的行内样式 —— 必须限定"
            " :not(.rz-drag)（本批最危险的回归点：用户拖出来的尺寸会被永久压回默认值）")


def test_css_modal_old_fixed_centering_retired():
    css = _read(CSS_PATH)
    assert "calc(50% - 37.5vw)" not in css, (
        "旧的固定 75vw 居中口径（calc(50% - 37.5vw)）必须退场——宽度已改为响应式 max/min，"
        "继续用它会让弹窗偏左")


# ============ C. JSX 契约 ============

def test_composer_bottombar_endgroup_holds_trailing_buttons():
    src = _read(COMPOSER_PATH)
    idx = src.index('className="sess-bottombar"')
    tail = src[idx: idx + 8000]
    assert 'className="sess-endgroup"' in tail, (
        "底栏尾部按钮（停止/发送）必须收进 .sess-endgroup（折行时整组贴右）")
    eg = tail[tail.index("sess-endgroup"):]
    assert "onClick={onSend}" in eg, "发送按钮必须在 .sess-endgroup 内"
    assert ("onStop" in eg) or ("onCancelQueue" in eg), (
        "停止/取消排队按钮必须在 .sess-endgroup 内")
    assert "style={{ flex: 1 }}" not in tail, (
        "底栏不应再用 flex:1 空 span 占位顶右 —— 折行后它会把尾部按钮留在新行左边；"
        "改用 .sess-endgroup 的 margin-left: auto")


def test_session_modal_default_width_single_source():
    src = _read(MODAL_PATH)
    assert "w-[75vw]" not in src, (
        "默认宽度必须只有一个来源（components.css 的 max/min 响应式规则）；className 里"
        "再写死 w-[75vw] 会让两处口径分裂（且优先级竞争难判）")
    assert "sess-modal" in src
    assert "h-[90vh]" in src, "默认高度仍由 h-[90vh] 工具类给（max-height 88vh 封顶）"
