#!/usr/bin/env python3
"""「飞书接入」卡的两个闸门：**规则**由 vitest 测，**调用点接线**由本守卫测（M9，2026-10-15）。

为什么要有第二道：`webui/src/__tests__/feishuProvision.test.js` 钉的是 `provisionGates()`
的 2×2 真值表（规则对不对），而**规则对不对 ≠ 按钮真的读了它**。M9 的变异实测说了话：
把「补齐应用配置」按钮的 `gates.writeDisabled` 改成 `gates.scanDisabled`（等于把
`supported` 的连坐装回去 —— 正是本次要修的那个用户可见缺陷），11 条 vitest **全绿**。
纯函数测的是规则，接线没人管 ⇒ 用静态守卫补，判据是「每个按钮的 disabled 表达式必须与
它自己的语义配对」。

为什么不上组件渲染测试：本仓约定 `doc_ai/spec/webui/前端结构与约定.md` 写明只覆盖
utils/stores 纯逻辑（未装 testing-library），需要 DOM 树/网络交互的组件留待立项。
静态守卫是这条约定下的可行解（同类先例：`tests/test_plugin_client_tokens.py` 的
「宿主 token 拼错不报错、必须静态钉住」）。

**解析口径（首版踩过的坑，写在这里防退化）**：不许用 `src.find('按钮文案')` 定位按钮 ——
同一段文案在说明文字（`:511` 的「点『扫码创建飞书应用』」）与注释（`:229`/`:444`）里都出现过，
首版因此把「说明文字」当成按钮、把注释当成文案判据，正跑就红。正确做法是**按 `<Button>` 块解析**：
块内取标签闭合 `>` 之后的文本作按钮名，块内 `disabled={…}`（花括号配平）作闸门表达式；
并只在这个卡（`ProvisionCard`）的区域内解析 —— 同一文件 `:735` 还有另一个「刷新状态」按钮
（绑定卡，`disabled={busy}`），不做区域限定就会误伤。

**负对照（本守卫不是恒绿机器）**，四条都实测过（见 M9 实施记录）：
① 「补齐应用配置」改吃 `gates.scanDisabled`；② 扫码改吃 `gates.writeDisabled`；
③ `disabled` 改回吃合成闸门 `disabled`；④ 文案里把 `lark-oapi` 那句加回来。
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANEL = os.path.join(ROOT, 'webui', 'src', 'components', 'settings', 'FeishuPanel.jsx')
UTIL = os.path.join(ROOT, 'webui', 'src', 'utils', 'feishuProvision.js')

# 按钮文案 → 该按钮 disabled 表达式里**必须**出现的闸门名。
# 语义：扫码是「写操作 + 依赖运行时能力」⇒ 两个闸门都要过；
#       补齐配置/提交发布是「纯写操作」⇒ 只看 enabled（**不许被 supported 连坐**）；
#       刷新状态是只读探测 ⇒ 不受任何能力/总开关闸门影响。
EXPECTED_GATES = {
    '扫码创建飞书应用': 'gates.scanDisabled',
    '补齐应用配置': 'gates.writeDisabled',
    '提交发布': 'gates.writeDisabled',
    '刷新状态': 'gates.refreshDisabled',
}


def read(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()


def strip_comment_lines(src):
    """去掉整行注释（`//` 开头、块注释里的 `*` 续行）—— 判「文案」时注释不算数。

    M9 首版把注释里的 `lark-oapi` 当成了产品文案 ⇒ 假红。行级过滤够用：本仓 JSX/JS
    里注释都独占整行，且不会把字符串里的 `//` 误删（那只影响行首恰好是 `//` 的字符串行）。
    """
    keep = []
    for line in src.splitlines():
        s = line.strip()
        if s.startswith('//') or s.startswith('*') or s.startswith('/*'):
            continue
        keep.append(line)
    return '\n'.join(keep)


def provision_card(src):
    """截出 `ProvisionCard` 这一个卡的区域（同文件还有别的卡带同名按钮）。"""
    start = src.index('function ProvisionCard(')
    m = re.search(r'\n(?=(?:function |const |export ))', src[start + 1:])
    end = start + 1 + (m.start() if m else len(src) - start - 1)
    return src[start:end]


def balanced_braces(src, open_idx):
    """`open_idx` 指向 `{`，返回配平后的表达式（不含最外层花括号）与右花括号后一位。"""
    depth = 0
    i = open_idx
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:i].strip(), i + 1
        i += 1
    raise AssertionError('花括号没配平（源文件被改坏了？）')


def parse_buttons(region):
    """按 `<Button …>标签</Button>` 块解析，返回 `[(按钮文案, disabled 表达式或 None)]`。

    标签取「标签闭合 `>` 之后到 `</Button>` 之前」的文本 —— 这样属性里的箭头函数 `=>`
    与模板串 `${…}` 都不会被误当成标签边界（首版的整标签正则正是死在这里）。
    """
    out = []
    for m in re.finditer(r'<Button\b', region):
        close = region.find('</Button>', m.end())
        if close < 0:
            continue
        block = region[m.start():close]
        label = block[block.rindex('>') + 1:].strip()
        expr = None
        d = block.find('disabled={')
        if d >= 0:
            expr, _ = balanced_braces(block, d + len('disabled={') - 1)
        out.append((label, expr))
    return out


def test_util_exports_both_gates():
    src = read(UTIL)
    assert re.search(r'export\s+function\s+provisionGates\b', src), \
        'utils/feishuProvision.js 必须导出 provisionGates（规则唯一真源）'
    assert re.search(r'export\s+function\s+provisionNotices\b', src), \
        'utils/feishuProvision.js 必须导出 provisionNotices（提示文案唯一真源）'


def test_each_button_reads_its_own_gate():
    buttons = dict(parse_buttons(provision_card(read(PANEL))))
    for label, gate in EXPECTED_GATES.items():
        assert label in buttons, (
            f'ProvisionCard 里找不到按钮「{label}」（改名了就要同步本守卫的期望表；'
            f'实际解析到：{sorted(buttons)}）')
        expr = buttons[label]
        assert expr is not None, f'「{label}」按钮没有 disabled 表达式'
        assert gate in expr, (
            f'「{label}」按钮的 disabled 表达式应为 {gate}，实际是 `{expr}`'
            '（M9 的缺陷就是这里把两个闸门混用 ⇒ 整卡不可操作）')
        assert 'supported' not in expr, (
            f'「{label}」按钮的 disabled 不许吃 `supported`（那是扫码能力闸门；'
            f'「补齐/发布」两个后端早已实现的动作不许被连坐）：实际 `{expr}`')
        assert 'busy' in expr, f'「{label}」按钮的 disabled 必须仍受 busy 影响（请求进行中不许再点）'


def test_scan_button_keeps_waiting_condition_at_call_site():
    """`state === 'waiting'` 由调用点自持：等待扫码期间「取消」走同一个 `run('cancel')`，
    若把它并进 `provisionGates` 再喂给整卡，取消按钮也会被锁死（M9 审计结论）。"""
    buttons = dict(parse_buttons(provision_card(read(PANEL))))
    expr = buttons['扫码创建飞书应用']
    assert "state === 'waiting'" in expr, \
        f'扫码按钮必须保留等待态禁用（取消按钮走同一 run()，不能并进纯函数）：实际 `{expr}`'


def test_no_merged_gate_and_no_stale_wording():
    card = strip_comment_lines(provision_card(read(PANEL)))
    assert '!st?.supported || !st?.enabled' not in card, \
        '合成闸门（!st?.supported || !st?.enabled）不许回来：它是整卡死掉的根因'
    assert '!st.supported &&' not in card and '!st.enabled &&' not in card, \
        '两条提示不许再写死在面板里，必须走 provisionNotices（文案唯一真源）'
    assert 'notices.map(' in card, '提示文案必须来自 notices（provisionNotices 的输出）'
    assert 'lark-oapi' not in card, (
        '面板文案不许再提 lark-oapi：Node 后端下根本没有这个 Python 包，'
        '该提示已改成后端无关表述（文案真源在 utils/feishuProvision.js）')


def test_stale_wording_is_gone_from_util_too():
    src = strip_comment_lines(read(UTIL))
    assert 'lark-oapi' not in src, 'utils/feishuProvision.js 的提示文案不许提 lark-oapi'
    # `!supported` 与 `!enabled` 的文案必须分开（语义不同，不许混用同一句）
    assert 'TS_FEISHU_PROVISION=0' in src, '总开关关闭的文案语义必须保留（与「能力不具备」分开）'
    assert '不具备' in src, '能力缺失的文案要说「不具备能力」，不能说成「已关闭」'
