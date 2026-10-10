#!/usr/bin/env python3
"""看板卡片操作行「窄屏自适应」静态契约守卫（快层，2026-10-10 批次）。

背景（真机 bug）：`.board-card-ops` 是 flex 默认 `nowrap` 且无 `flex-wrap`，而 shadcn
`Button` 基类带 `shrink-0` + `whitespace-nowrap` ⇒ 窄列下按钮既不换行也不压缩，直接被
卡片裁掉（用户截图：待审核卡的「通过/打回」+ 图标按钮出卡）。修法分三层，任一层被改回
都会让窄屏重新出卡，而这类改动**不报错、不变红**，只能静态钉住：

  1. CSS 层（webui/src/styles/components.css）：
     - `.board-card-ops` 必须 `flex-wrap: wrap`（折行）+ `row-gap`（行间距）；
     - 必须存在容器查询（`@container bcol`）内的 `.board-opbtn` 收窄规则 —— 该规则必须
       落在容器查询块**内部**（在块外会无条件生效，宽列也把文字藏掉）；
     - `.board-oplabel`（文字）/ `.board-opwide`（宽列图标）/ `.board-opicon`（窄列图标）
       三件套齐备且默认 `display:none` 的是窄列图标；
     - 列头 `.board-col-head` 必须 `flex-wrap`，`.board-col-label` 必须 `nowrap`
       （否则列名被压成逐字竖排「待/开/发」）。
  2. JSX 层（webui/src/components/BoardTab.jsx）：
     - 两个助手组件 `OpsTextButton` / `OpsIconButton` 存在，且带文字按钮内部是
       「board-opwide + board-opicon + board-oplabel」三个兄弟节点；
     - 窄屏只剩图标形态时必须有 `aria-label`（读屏可识别）；
     - 删除按钮（title="删除卡片"）必须排在操作行 JSX 的**最后**（用户要求；且在
       `.board-opbtn` 之外不得再出现 `margin-left: auto` 之类的贴右写法）。

运行：python3 -m pytest tests/test_board_ops_layout.py -v（不需要浏览器/站点）
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS_PATH = os.path.join(ROOT, "webui", "src", "styles", "components.css")
JSX_PATH = os.path.join(ROOT, "webui", "src", "components", "BoardTab.jsx")


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


def _any_block_has(text, selector, needle):
    """该选择器的**任一条**规则含 needle（缺省定义 + 本次新增覆盖行分开写时用）。"""
    return any(needle in b for b in _blocks(text, selector))


def _strip_block(text, selector):
    """删除 `selector { ... }` 整段（用于「某规则不得出现在块外」的断言）。"""
    return re.sub(re.escape(selector) + r"\s*\{[^}]*\}", "", text)


def _container_block(css, name="bcol"):
    """取出 `@container <name> (…){ … }` 的整段（含内部规则）。"""
    m = re.search(r"@container\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", css)
    assert m, f"CSS 里找不到 @container {name} 容器查询"
    start = m.end() - 1
    depth = 0
    for i in range(start, len(css)):
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
            if depth == 0:
                return css[m.start():i + 1]
    raise AssertionError("@container 块未闭合")


# ---------- CSS 层 ----------

def test_卡片操作行允许折行():
    """flex-wrap: wrap + row-gap：窄列折行而不是溢出被裁（本次 bug 的根因修复）。"""
    css = _read(CSS_PATH)
    decl = _block(css, ".board-card-ops")
    assert "flex-wrap: wrap" in decl, ".board-card-ops 必须 flex-wrap: wrap（否则窄列出卡）"
    assert re.search(r"row-gap:\s*4px", decl), ".board-card-ops 需要 row-gap（折行后的行间距）"
    assert re.search(r"(^|;)\s*display:\s*flex", decl), ".board-card-ops 仍是 flex 容器"


def test_列宽容器查询存在且按钮收窄规则在其内部():
    """阈值判定必须用容器查询（按列宽），且收窄规则只能写在容器查询块内。"""
    css = _read(CSS_PATH)
    assert re.search(r"\.board-col\s*\{[^}]*container-type:\s*inline-size", css), \
        ".board-col 需要 container-type: inline-size（按列宽判定）"
    block = _container_block(css, "bcol")
    assert re.search(r"max-width:\s*\d+px", block), "容器查询需要 max-width 阈值"
    # 阈值必须与实施记录一致（240px：列宽 > 240 保留文字、≤ 240 收起）
    m = re.search(r"max-width:\s*(\d+)px", block)
    assert 200 <= int(m.group(1)) <= 280, \
        f"收起文字的列宽阈值 {m.group(1)}px 超出合理区间（真机量测区间 229~241）"
    for needed in (".board-card-ops .board-opbtn {", ".board-oplabel",
                   ".board-opwide", ".board-opicon"):
        assert needed in block, f"容器查询里缺少 {needed} 的收窄规则"
    # 反向断言：这些收窄规则不得出现在容器查询块之外（否则宽列也把文字藏了）
    outside = css.replace(block, "")
    for sel in (".board-card-ops .board-opbtn .board-oplabel",
                ".board-card-ops .board-opbtn .board-opicon",
                ".board-card-ops .board-opbtn .board-opwide"):
        assert sel not in outside, f"{sel} 出现在容器查询之外（会无条件生效）"


def test_图标与文字三件套的默认可见性():
    """默认（宽列）：文字与宽列图标可见、窄列图标隐藏 —— 三者缺一都会让某一档少东西。"""
    css = _read(CSS_PATH)
    assert "white-space: nowrap" in _block(css, ".board-oplabel")
    assert "inline-flex" in _block(css, ".board-opwide")
    assert re.search(r"display:\s*none", _block(css, ".board-opicon")), \
        ".board-opicon 默认必须隐藏（只在窄列显示）"


def test_列头换行且标签不缩():
    """列头：flex-wrap（下拉落第二行）+ 标签 nowrap + 不收缩（防逐字竖排/横向溢出）。"""
    css = _read(CSS_PATH)
    assert _any_block_has(css, ".board-col-head", "flex-wrap: wrap"), \
        ".board-col-head 必须 flex-wrap（窄列下拉落第二行，否则横向溢出/标签竖排）"
    assert _any_block_has(css, ".board-col-label", "white-space: nowrap"), \
        ".board-col-label 必须 nowrap（防逐字竖排）"
    assert _any_block_has(css, ".board-col-label", "flex: 0 0 auto"), \
        ".board-col-label 必须不收缩（flex: 0 0 auto），否则仍会被压成竖排"


# ---------- JSX 层 ----------

def _ops_row_jsx():
    """取出卡片操作行 JSX（`.board-card-ops` div 起、到操作行闭合 div 止）。"""
    jsx = _read(JSX_PATH)
    m = re.search(r'<div className="board-card-ops"[\s\S]*?\n                    </div>', jsx)
    assert m, "找不到卡片操作行 JSX"
    return m.group(0)


def test_两个操作按钮助手组件存在且结构正确():
    jsx = _read(JSX_PATH)
    assert "function OpsTextButton(" in jsx, "缺少 OpsTextButton 助手组件"
    assert "function OpsIconButton(" in jsx, "缺少 OpsIconButton 助手组件"
    # 带文字按钮内部必须是三个兄弟节点（包 svg 会让 Button 的 [&_svg]:size-4 失配）
    for cls in ("board-opwide", "board-opicon", "board-oplabel"):
        assert f'<span className="{cls}">' in jsx, f"OpsTextButton 缺少 <span className=\"{cls}\">"
    assert "aria-label={label}" in jsx, "OpsTextButton 必须给 aria-label（窄屏只剩图标时读屏可识别）"


def test_操作行按钮都走助手组件且带_opbtn_类():
    """操作行里不得再有裸 <Button>（裸按钮既不会折行收窄也不带文字收纳结构）。"""
    row = _ops_row_jsx()
    assert "OpsTextButton" in row and "OpsIconButton" in row
    assert "<Button" not in row, "操作行里仍有裸 <Button>，应改用 OpsTextButton/OpsIconButton"


def test_删除按钮排在操作行末位():
    """用户要求：删除按钮放最后一个（窄列折行时它落在末尾，与其它按钮有区隔）。"""
    row = _ops_row_jsx()
    idx_del = row.find('title="删除卡片"')
    assert idx_del >= 0, "操作行里找不到删除按钮"
    css = _read(CSS_PATH)
    # 删除按钮之后不得再出现其它按钮的渲染（“打开卡片详情/进入主会话/在 dsh 界面打开”）
    tail = row[idx_del:]
    for later in ('title="打开卡片详情"', 'title={card.session_id ? \'进入主会话\'',
                  '在 dsh 界面打开该卡片主会话'):
        assert later not in tail, f"删除按钮之后仍渲染了「{later}」，应放在最后"
    assert "margin-left: auto" not in row, "删除按钮不得用 marginLeft auto（实测会把它顶到单独一行）"
    for decl in re.findall(r"\.board-(?:card-ops|opbtn|oplabel|opicon|opwide)[^{]*\{([^}]*)\}", css):
        assert "margin-left: auto" not in decl, \
            "操作行/操作按钮规则里不得出现 margin-left:auto（会把删除按钮顶到单独一行）"
    assert ".board-delbtn" not in css, \
        "不再需要 .board-delbtn（删除按钮靠 JSX 排在末位，不加贴右样式）"
