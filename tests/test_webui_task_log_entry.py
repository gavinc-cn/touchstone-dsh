#!/usr/bin/env python3
"""任务日志入口静态守卫：插件形态面板内导航 + 独立形态新标签页带 BASE（2026-10-27 修复）。

背景：任务详情轮次表「查看日志」旧实现是裸 `window.open('/log?task=…&round=…')`，
两档形态都坏（详见 `doc_ai/bug_report/20261027_0745_任务日志入口插件与桌面端打不开/`）：
  - dsh 插件形态（BASE=/touchstone/）：根相对 /log 落到 dsh 宿主根 ⇒ 404；
  - dsh 桌面端：宿主页 origin 是 dsh://app/（桌面壳自定义 scheme），相对地址被解析成
    dsh://app/log…，桌面壳的窗口 open handler 只放行 http(s) 给系统浏览器、其余 deny
    ⇒ 点了没有任何反应。
修复口径：插件形态在面板 SPA 内 navigate（router basename 自带前缀，不依赖新窗口）；
独立形态保留新标签页但 URL 必须补 BASE。前端单测 `webui/src/__tests__/taskLog.test.js`
测纯函数，本文件是源码级接线守卫（防「函数还在、接线又被改回裸 window.open」这一类回归）
+ 无中文文案/词表漏登记检查。

运行：`pytest tests/test_webui_task_log_entry.py -q`（快层自动收集，零外部依赖）。
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS_TAB = os.path.join(ROOT, "webui", "src", "components", "TasksTab.jsx")
LOG_PAGE = os.path.join(ROOT, "webui", "src", "views", "TaskLogPage.jsx")
TASK_LOG_LIB = os.path.join(ROOT, "webui", "src", "lib", "taskLog.js")
EN_JSON = os.path.join(ROOT, "i18n", "en.json")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# ── 判定小工具（真实源码与负向对照夹具共用，保证「守卫能失败」）────────────────

#: 旧缺陷形态：window.open 的实参是裸根相对 /log（或以 /log 开头的模板串）。
_BARE_LOG_OPEN = re.compile(r"window\.open\(\s*[`'\"]/log")


def bare_log_window_open(src):
    """源码里是否还存在「裸根相对 /log 的 window.open」（旧缺陷形态）。"""
    return bool(_BARE_LOG_OPEN.search(src))


def plugin_navigate_wired(src):
    """插件形态分支是否走 router navigate（而不是 window.open）。"""
    return ("logOpenTarget(" in src and "navigate(target.to)" in src
            and "markLogReturn(" in src)


# ── 源码接线 ──────────────────────────────────────────────────────────────────


def test_tasks_tab_no_bare_log_window_open():
    """任务列表不得再出现裸 `window.open('/log…')`（两档形态都会坏的旧实现）。"""
    src = read(TASKS_TAB)
    assert "window.open(`/log" not in src       # 旧实现原样（模板串形态）
    assert not bare_log_window_open(src), "TasksTab 仍存在裸根相对 /log 的 window.open"


def test_tasks_tab_uses_shared_task_log_target():
    """「查看日志」必须经 lib/taskLog.js 的 logOpenTarget 决策，不许自己拼 URL。"""
    src = read(TASKS_TAB)
    assert "import { logOpenTarget, markLogReturn, takeLogReturn } from '../lib/taskLog'" in src
    assert "const target = logOpenTarget(taskId, roundNo)" in src
    # 插件形态：router 导航（不依赖新窗口，桌面端 dsh:// scheme 拦截不到它）
    assert "navigate(target.to)" in src
    # 独立形态：新标签页，URL 取带 BASE 的 href（不许再写字面量 '/log?…'）
    assert "window.open(target.href, '_blank')" in src
    assert plugin_navigate_wired(src)


def test_tasks_tab_restores_expanded_detail_after_return():
    """面板内导航返回后恢复原任务详情展开（跨路由 mount 的一次性记忆）。"""
    src = read(TASKS_TAB)
    assert "takeLogReturn()" in src
    assert "toggleTask(tid)" in src
    # 必须是一次性：用 ref 收口，避免每次 tasks 变化都重开详情
    assert "logReturnDone" in src and "logReturnId" in src


def test_log_page_back_button_only_in_plugin_build():
    """日志页在插件形态给「返回任务列表」；独立形态（新标签页）不渲染。"""
    src = read(LOG_PAGE)
    assert "import { isPluginBuild } from '../lib/taskLog'" in src
    assert "{isPluginBuild() && (" in src
    assert "返回任务列表" in src
    # 返回语义：恒回主页面（replace 不留 /log 历史条目；项目/标签页由 AppShell 恢复、
    # 任务详情展开由 TasksTab 的返回记忆恢复；深链直达同样回 /app）。
    assert "navigate('/app', { replace: true })" in src
    # 插件形态轮次切换只改查询串，用 replace 不堆历史（独立形态保持 push）
    assert "replace: isPluginBuild()" in src


def test_task_log_lib_base_and_target_branches():
    """lib/taskLog.js：BASE 从 BASE_URL 取（不硬编码前缀），两档目标分支齐全。"""
    src = read(TASK_LOG_LIB)
    assert "import.meta.env.BASE_URL" in src          # 与 api/index.js、lastRoute.js 同口径
    assert "replace(/\\/+$/, '')" in src              # 去尾斜杠
    assert "export function isPluginBuild()" in src
    assert "kind: 'navigate'" in src and "kind: 'new-tab'" in src
    assert "encodeURIComponent(taskId)" in src and "encodeURIComponent(roundNo)" in src
    # 不得把 /touchstone 写死进代码（它是构建期 BASE_URL 的值，不是源码常量）。注释里
    # 出现该前缀是正常的文档说明，先剥掉块注释与行注释再查。
    code_only = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    code_only = re.sub(r"//[^\n]*", "", code_only)
    assert "'/touchstone" not in code_only and '"/touchstone' not in code_only


def test_i18n_key_registered():
    """新增的「返回任务列表」词条必须在唯一词表 i18n/en.json 的 web 命名空间登记。"""
    with open(EN_JSON, encoding="utf-8") as f:
        web = json.load(f).get("web", {})
    assert "返回任务列表" in web
    assert web["返回任务列表"].strip() == "Back to task list"


# ── 守卫自证：旧缺陷形态必须被判红（负向对照，不依赖真实文件）──────────────────


def test_guard_detects_old_buggy_shape():
    """负向对照：旧实现的两种写法都必须被 bare_log_window_open 判红（守卫能失败）。"""
    old_template = "window.open(`/log?task=${taskId}&round=${roundNo}`, '_blank')"
    old_literal = "window.open('/log?task=' + (t.id ?? ''), '_blank')"
    assert bare_log_window_open(old_template)
    assert bare_log_window_open(old_literal)
    fixed = "window.open(target.href, '_blank')"
    assert not bare_log_window_open(fixed)


def test_guard_detects_missing_plugin_navigate():
    """负向对照：只改 URL 不走 navigate（桌面端仍点不开）必须判红。"""
    half_fixed = ("const target = logOpenTarget(taskId, roundNo)\n"
                  "window.open(target.href, '_blank')\n")
    assert not plugin_navigate_wired(half_fixed)
