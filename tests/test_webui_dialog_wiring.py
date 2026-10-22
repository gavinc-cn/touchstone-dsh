#!/usr/bin/env python3
"""弹窗「拖边框调大小」的接线守卫：每个弹窗的缩放手柄必须与它自己的尺寸状态同源。

背景（2026-10-21 用户报）：选择目录弹窗拖边框改不了大小，拖动时实际被缩放的是**背后的
编辑项目弹窗**。根因不是 CSS，而是接线：AppShell 把每个弹窗拆成各自一份 `useResizable()`
（`rz*` / `dupRz*` / `dirRz*` / `delRz*`），但 `RzHandles` 的 `start` 还指着项目弹窗的
`rzStart` ⇒ 手柄读的是 A 弹窗的 rect，却写进 B 弹窗的 state。类名/样式读 `dirRzOn/dirRzStyle`
不受影响，所以「看起来只是不能缩放」，实际是「缩放了别的弹窗」。

为什么用静态守卫：本仓未装 testing-library（约定只覆盖 utils/stores 纯逻辑，见
`doc_ai/spec/webui/前端结构与约定.md`），而 vitest 也测不到「A 弹窗的手柄写进了 B 弹窗的
hook」这类跨组件接线。同类先例：`tests/test_webui_provision_gates.py`（规则由 vitest 测、
调用点接线由静态守卫钉）、`tests/test_plugin_client_tokens.py`。

判据（对每个 `<DialogContent>` 内含 `<RzHandles>` 的弹窗块）：
  1. `start={X}` 必须等于该块 `style={{ ...<Y> }}` 里 Y 的「同族 start」：
     `Y = rzStyle` → `X = rzStart`；`Y = dirRzStyle` → `X = dirRzStart`；
  2. `reset={Z}` 同理（`rzReset` / `dirRzReset` …）；
  3. 类名里的 `rz-drag` 开关必须是同族 `rzOn`（`dirRzStyle` ↔ `dirRzOn`）；
  4. 标题栏拖动 `onMouseDown` 必须是同族 `rzDragStart`（`dirRzStart` 的手柄 + `rzDragStart`
     的标题 = 双份状态，拖动标题同样会错弹窗）；
  5. 这些名字必须真的来自同一文件里的 `useResizable()` 解构（防止手滑写个不存在的变量）。

另有一条针对「拖动时选中背后页面文字」的守卫：`useResizable.start` 的 mousedown 必须
`e.preventDefault()`（与标题栏拖动同口径）——手柄是透明条，不拦默认动作就会起选区。

负对照（guard 不是恒绿机器）：见 `test_negative_control_wrong_start_is_caught` /
`test_negative_control_missing_prevent_default_is_caught`——把旧接线/删掉 preventDefault
喂给同一套解析，必须报错。
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 含可缩放弹窗的源文件（新增弹窗改到这里；漏文件则守卫覆盖不到，属已知边界）
RESIZABLE_FILES = [
    os.path.join(ROOT, 'webui', 'src', 'views', 'AppShell.jsx'),
    os.path.join(ROOT, 'webui', 'src', 'views', 'Admin.jsx'),
    os.path.join(ROOT, 'webui', 'src', 'components', 'TasksTab.jsx'),
    os.path.join(ROOT, 'webui', 'src', 'components', 'SessionModal.jsx'),
    os.path.join(ROOT, 'webui', 'src', 'components', 'BoardDetail.jsx'),
]
HOOK = os.path.join(ROOT, 'webui', 'src', 'hooks', 'useResizable.js')


def read(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()


def hook_locals(src):
    """收集 `const { … } = useResizable(…)` 里绑定的本地变量名（支持 `rzStart: dirRzStart` 别名）。"""
    names = set()
    for m in re.finditer(r'=\s*useResizable\(', src):
        start = src.rfind('const {', 0, m.start())
        if start < 0:
            continue
        close = src.find('}', start)
        if close < 0 or close > m.start():
            continue
        body = src[start + len('const {'):close]
        for item in body.split(','):
            item = item.strip()
            if not item:
                continue
            names.add(item.split(':')[-1].strip())
    return names


def dialog_blocks(src):
    """按 `<RzHandles …>` 切出所在 `<DialogContent …>…</DialogContent>` 块（含 RzHandles）。"""
    blocks = []
    for m in re.finditer(r'<RzHandles\b[^>]*>', src):
        open_at = src.rfind('<DialogContent', 0, m.start())
        close_at = src.find('</DialogContent>', m.end())
        if open_at < 0 or close_at < 0:
            continue
        blocks.append(src[open_at:close_at])
    return blocks


def scan(src):
    """返回接线问题列表（空 = 全部同源）。每项形如 `dirRzStyle: start=rzStart 期望 dirRzStart`。"""
    problems = []
    locals_ = hook_locals(src)
    for block in dialog_blocks(src):
        style = re.search(r'style=\{\{\s*\.\.\.(\w+)', block)
        start = re.search(r'<RzHandles\b[^>]*\bstart=\{(\w+)\}', block)
        if not style or not start:
            problems.append(f'弹窗块缺 style 或 RzHandles start：{block[:80]!r}')
            continue
        family = style.group(1)
        # 命名两种：默认弹窗是 `rzStyle`（小写 rz），带前缀的是 `dirRzStyle`/`addRzStyle`…
        # 标题拖动名历史上两种写法都有（AppShell 的 `dupDragStart`、Admin 的 `addRzDragStart`），
        # 判据只要求「同族」——前缀一致即可，不强求中间有 Rz。
        if family == 'rzStyle':
            expected = {'start': 'rzStart', 'reset': 'rzReset', 'on': 'rzOn',
                        'drag': ['rzDragStart']}
        elif family.endswith('RzStyle') and len(family) > len('RzStyle'):
            prefix = family[:-len('RzStyle')]      # 'dup' | 'dir' | 'del' | 'add'
            expected = {'start': prefix + 'RzStart', 'reset': prefix + 'RzReset',
                        'on': prefix + 'RzOn',
                        'drag': [prefix + 'RzDragStart', prefix + 'DragStart']}
        else:
            problems.append(f'style 变量命名不是 rzStyle/*RzStyle：{family}')
            continue
        got_start = start.group(1)
        if got_start != expected['start']:
            problems.append(f'{family}: handle start={got_start}，应为 {expected["start"]}'
                            '（否则拖 A 弹窗边框会缩放 B 弹窗）')
        reset = re.search(r'<RzHandles\b[^>]*\breset=\{(\w+)\}', block)
        if reset and reset.group(1) != expected['reset']:
            problems.append(f'{family}: handle reset={reset.group(1)}，应为 {expected["reset"]}')
        if not re.search(r'\b' + re.escape(expected['on']) + r'\b', block):
            problems.append(f'{family}: 类名 rz-drag 未读同族开关 {expected["on"]}')
        for got in re.findall(r'onMouseDown=\{(\w+)\}', block):
            if got not in expected['drag']:
                problems.append(f'{family}: 标题拖动 onMouseDown={got}，应为同族 '
                                + '/'.join(expected['drag']))
            elif got not in locals_:
                problems.append(f'{got} 未从 useResizable() 解构出来（标题拖动用了不存在的名字）')
        for name in ('start', 'reset'):
            if expected[name] not in locals_:
                problems.append(f'{expected[name]} 未从 useResizable() 解构出来'
                                f'（{name} 用了不存在的名字）')
    return problems


def balanced_braces(src, open_idx):
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:i], i + 1
    raise AssertionError('花括号没配平（源文件被改坏了？）')


def start_callback(src):
    """截出 `const start = useCallback(…, […])` 的函数体（配平花括号，含箭头函数体）。"""
    at = src.index('const start = useCallback(')
    body_open = src.index('{', at + len('const start = useCallback(') - 1)
    body, _ = balanced_braces(src, body_open)
    return body


def start_selection_problems(src):
    """`useResizable.start` 的防选区判据（返回问题列表；负对照也走这一份，避免守卫只测到半截）。"""
    body = start_callback(src)
    problems = []
    if 'e.preventDefault()' not in body:
        problems.append('useResizable.start 缺少 e.preventDefault()'
                        '（拖出弹窗外会起页面文字选区，与标题栏拖动同口径）')
    if 'e.button !== 0' not in body:
        problems.append('useResizable.start 未忽略非左键（与标题栏拖动同口径）')
    return problems


# ---------- 正向守卫 ----------

def test_every_resizable_dialog_wires_its_own_handles():
    for path in RESIZABLE_FILES:
        problems = scan(read(path))
        assert not problems, f'{os.path.basename(path)} 弹窗缩放接线不同源：\n  ' + '\n  '.join(problems)


def test_every_resizable_dialog_was_covered():
    """守卫自检：五类已知弹窗的 style 家族都在（漏文件/漏弹窗时提醒，而不是静默变绿）。"""
    found = set()
    for path in RESIZABLE_FILES:
        for m in re.finditer(r'style=\{\{\s*\.\.\.(\w*[Rr]zStyle)', read(path)):
            found.add(m.group(1))
    expected = {'rzStyle', 'dupRzStyle', 'dirRzStyle', 'delRzStyle', 'addRzStyle'}
    assert expected <= found, f'这些弹窗的缩放接线未被守卫覆盖：{expected - found}'


def test_resize_handle_mousedown_prevents_text_selection():
    """手柄 mousedown 必须 preventDefault：否则拖出弹窗外会起页面文字选区（用户报的症状之一）。"""
    problems = start_selection_problems(read(HOOK))
    assert not problems, '\n'.join(problems)


# ---------- 负对照（确保守卫抓得住这两个真缺陷） ----------

def test_negative_control_wrong_start_is_caught():
    """把旧 bug 原样复刻：目录弹窗手柄指回项目弹窗的 rzStart ⇒ 守卫必须报错。"""
    src = read(RESIZABLE_FILES[0])
    buggy = src.replace('<RzHandles start={dirRzStart} reset={dirRzReset} />',
                        '<RzHandles start={rzStart} reset={dirRzReset} />')
    assert buggy != src, '负对照失效：AppShell 里找不到目录弹窗的 RzHandles 行'
    problems = scan(buggy)
    assert any('dirRzStyle' in p and 'start=rzStart' in p for p in problems), problems


def test_negative_control_missing_prevent_default_is_caught():
    """删掉 start 里的 preventDefault ⇒ 守卫必须报错。"""
    src = read(HOOK)
    buggy = src.replace('    e.preventDefault()\n', '', 1)
    assert buggy != src, '负对照失效：useResizable.start 里找不到 e.preventDefault()'
    problems = start_selection_problems(buggy)
    assert any('preventDefault' in p for p in problems), problems
