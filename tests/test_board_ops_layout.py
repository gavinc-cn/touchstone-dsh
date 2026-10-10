#!/usr/bin/env python3
"""看板卡片操作行「窄屏自适应」静态契约守卫（快层，2026-10-10 批次）。

背景（真机 bug）：`.board-card-ops` 是 flex 默认 `nowrap` 且无 `flex-wrap`，而 shadcn
`Button` 基类带 `shrink-0` + `whitespace-nowrap` ⇒ 窄列下按钮既不换行也不压缩，直接被
卡片裁掉（用户截图：待审核卡的「通过/打回」+ 图标按钮出卡）。

空间不够时的优先级（用户二批口径原文「应该是优先去掉文字，然后才考虑折行」）：
  ① 去掉按钮文字（收成纯图标，仍是单行）→ ② 才允许折行。收档判定由 JS 按**每张卡自己的
  操作行**量测（webui/src/utils/opsFit.js），不是按列宽一刀切——同列各卡按钮 3~6 个，
  一刀切会把放得下的卡也收掉文字（实测 1800 视口：5 按钮行需 276px、4 按钮行只需 196px）。

这些约定**不报错、不变红**，只能静态钉住，任一条被改回都会让窄屏重新出卡/重新折行：

  1. CSS 层（webui/src/styles/components.css）：
     - `.board-card-ops` 必须 `flex-wrap: wrap`（第②档折行兜底）+ `row-gap`；
     - 量测态 `.board-ops-measure .board-card-ops` 必须 `flex-wrap: nowrap`（否则量不到
       「文字态单行溢出量」：行自己折了，scrollWidth 恒等于 clientWidth），且操作按钮的
       `transition-property` 必须排掉内边距/尺寸（Button 基类 transition-all 150ms：摘/挂
       .is-compact 会让内边距 6px↔12px 变成动画，同步读只读到动画起点——实测真值 276px
       读成 216px；过渡中间宽度还会让收档行短暂折行，实测 1100 档抓 26 张）；
     - 收档规则必须挂在 `.board-card-ops.is-compact` 下（默认不收档）；
     - 收档内边距必须 `!important`：本文件整体在 `@layer legacy`（低于 utilities），
       Button 的 `px-3`/`has-[>svg]:px-2.5` 在 utilities 层，层序压过选择器具体度——
       漏了这条实测收档按钮仍是 36~42px 宽（5 按钮行 208px）⇒ 220px 列照样折行；
     - 判定不得回到容器查询（`@container bcol` / `.board-col` 的 container-type 已删）。
  2. 量测层（webui/src/utils/opsFit.js）：
     - 量之前必须先把上一轮的 `.is-compact` 全部摘掉（留着就量到收档后的窄宽度，
       行会永久卡在收档态——本模块唯一的状态陷阱）；
     - 一次读齐（`scrollWidth - el.clientWidth`）后统一写结论，且有亚像素容差。
  3. JSX 层（webui/src/components/BoardTab.jsx）：
     - 两个助手组件 `OpsTextButton` / `OpsIconButton` 存在，且带文字按钮内部是
       「board-opwide + board-opicon + board-oplabel」三个兄弟节点；
     - 收档形态下必须有 `aria-label`（读屏可识别）；
     - 删除按钮（title="删除卡片"）必须排在操作行 JSX 的**最后**（用户要求；且在
       `.board-opbtn` 之外不得再出现 `margin-left: auto` 之类的贴右写法）；
     - `syncOpsFit` 必须在 `useLayoutEffect` 里按每次渲染重测，并挂 ResizeObserver
       兜住「不重渲染但列宽变了」（窗口缩放/侧栏开合）。

运行：python3 -m pytest tests/test_board_ops_layout.py -v（不需要浏览器/站点）
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS_PATH = os.path.join(ROOT, "webui", "src", "styles", "components.css")
JSX_PATH = os.path.join(ROOT, "webui", "src", "components", "BoardTab.jsx")
OPSFIT_PATH = os.path.join(ROOT, "webui", "src", "utils", "opsFit.js")


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


# ---------- CSS 层 ----------

def test_卡片操作行折行兜底仍在():
    """flex-wrap: wrap + row-gap：收文字后仍放得下才折行（第②档兜底，防溢出被裁）。"""
    css = _read(CSS_PATH)
    decl = _block(css, ".board-card-ops")
    assert "flex-wrap: wrap" in decl, ".board-card-ops 必须 flex-wrap: wrap（否则窄列出卡）"
    assert re.search(r"row-gap:\s*4px", decl), ".board-card-ops 需要 row-gap（折行后的行间距）"
    assert re.search(r"(^|;)\s*display:\s*flex", decl), ".board-card-ops 仍是 flex 容器"


def test_量测态关折行_else_量不出单行溢出量():
    """量测态：关掉折行才能从 scrollWidth 读到「文字态单行溢出量」。"""
    css = _read(CSS_PATH)
    decl = _block(css, ".board-ops-measure .board-card-ops")
    assert "flex-wrap: nowrap" in decl, \
        ".board-ops-measure .board-card-ops 必须 flex-wrap: nowrap（折行时 scrollWidth 恒等于 clientWidth）"


def test_操作按钮不过渡内边距_else_收档切换会出现中间宽度():
    """Button 基类带 transition-all(150ms)：内边距一旦参与过渡，摘/挂 .is-compact 都会
    产生中间宽度——实测 1100 视口收档行在过渡起点宽 208px > 可用 180px ⇒ 短暂折行
    （验收抓到 26 张），量测也会读到动画起点（1800 视口真值 276px 被读成 216px）。"""
    css = _read(CSS_PATH)
    decl = _block(css, ".board-card-ops .board-opbtn")
    assert "transition-property:" in decl and "!important" in decl, \
        "必须用 transition-property + !important 压过 utilities 层的 transition-all"
    assert "padding" not in decl and "all" not in decl.split("transition-property:")[1], \
        "过渡属性里不得含 padding/all（否则收档切换出现中间宽度：折行 + 量测读偏）"
    for color_prop in ("color", "background-color"):
        assert color_prop in decl, f"配色过渡应保留（{color_prop}），只排掉尺寸类属性"


def test_收档规则挂在_is_compact_下且不再按列宽一刀切():
    """收档由 JS 量测类驱动（每张卡自己的操作行），不得回到容器查询按列宽判定。"""
    css = _read(CSS_PATH)
    assert re.search(r"display:\s*none", _block(css, ".board-card-ops.is-compact .board-oplabel")), \
        "收档时必须隐藏文字（.board-card-ops.is-compact .board-oplabel）"
    assert re.search(r"display:\s*none", _block(css, ".board-card-ops.is-compact .board-opwide")), \
        "收档时必须隐藏宽列图标（否则图标重叠/占位变宽）"
    assert "inline-flex" in _block(css, ".board-card-ops.is-compact .board-opicon"), \
        "收档时必须显示窄列图标"
    # 判定口径：不再有列宽容器查询 / container-type（一刀切会把放得下的卡也收掉文字）
    assert "@container bcol" not in css, \
        "不得按列宽一刀切收文字（同列各卡按钮数不同）；判定归 utils/opsFit.js 按行量测"
    assert "container-type" not in css, "container-type 只服务已删除的列宽容器查询，一并清掉"


def test_收档内边距带_important_压过_utilities_层():
    """层序陷阱：本文件在 @layer legacy（低于 utilities），Button 的 px-3 会赢——
    收档内边距不加 !important 则按钮仍是 36~42px 宽，窄列照样折行。"""
    css = _read(CSS_PATH)
    assert "@layer legacy" in css, "components.css 预期整体落在 @layer legacy（本断言的前提）"
    decl = _block(css, ".board-card-ops.is-compact .board-opbtn")
    assert "padding-left: 6px !important" in decl and "padding-right: 6px !important" in decl, \
        "收档内边距必须 !important（否则压不过 utilities 层的 px-3 / has-[>svg]:px-2.5）"
    assert "gap: 0 !important" in decl, "收档时按钮内 gap 必须清零并带 !important"


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


# ---------- 量测层（utils/opsFit.js）+ BoardTab 接线 ----------

def test_opsFit_量前先复位再量_防收档自我固化():
    """顺序硬约束：摘掉上一轮的 is-compact → 一次读齐 → 写结论。
    漏了「先复位」会把收档后的窄宽度当成文字态宽度，行永久卡在收档态。"""
    js = _read(OPSFIT_PATH)
    assert "export function syncOpsFit" in js, "opsFit.js 必须导出 syncOpsFit"
    i_reset = js.find("classList.remove('is-compact')")
    i_read = js.find("el.scrollWidth - el.clientWidth")
    i_write = js.find("classList.toggle('is-compact'")
    assert i_reset >= 0, "量前必须把上一轮的 is-compact 全部摘掉（否则收档自我固化）"
    assert i_read >= 0, "必须按 scrollWidth - clientWidth 量单行溢出量"
    assert i_write >= 0, "必须按溢出量写 is-compact 结论"
    assert i_reset < i_read < i_write, "顺序必须是：复位 → 读（一次读齐）→ 写结论"


def test_opsFit_量测态类名与亚像素容差():
    js = _read(OPSFIT_PATH)
    assert "'board-ops-measure'" in js, \
        "量测态类名必须与 CSS 的 .board-ops-measure 一致（否则关不掉折行、量不出溢出量）"
    assert "export const OPS_COMPACT_EPS" in js, "亚像素容差要具名导出（可测/可调）"


def test_opsFit_单测覆盖复位陷阱与容差():
    """行为级断言在 webui/src/__tests__/opsFit.test.js（vitest，jsdom 伪造 scrollWidth）。"""
    test_path = os.path.join(ROOT, "webui", "src", "__tests__", "opsFit.test.js")
    assert os.path.exists(test_path), "缺少 opsFit 的 vitest 单测（复位陷阱/容差/可逆 都在那里钉）"
    t = _read(test_path)
    for key in ("is-compact", "board-ops-measure", "OPS_COMPACT_EPS"):
        assert key in t, f"opsFit 单测缺少对 {key} 的断言"


def test_BoardTab_按渲染重测并在列宽变化时兜底():
    jsx = _read(JSX_PATH)
    assert "import { syncOpsFit } from '../utils/opsFit'" in jsx, "BoardTab 未引入 syncOpsFit"
    assert 'className="board-cols" ref={colsRef}' in jsx, \
        ".board-cols 必须挂 colsRef（量测范围=整块看板）"
    assert re.search(r"useLayoutEffect\(\(\) => \{[\s\S]{0,400}?syncOpsFit\(root\)", jsx), \
        "syncOpsFit 必须在 useLayoutEffect 里调用（绘制前定档，不会闪一帧）"
    assert "new ResizeObserver(" in jsx and "syncOpsFit(colsRef.current)" in jsx, \
        "需要 ResizeObserver 兜住「不重渲染但列宽变了」（窗口缩放/侧栏开合）"
