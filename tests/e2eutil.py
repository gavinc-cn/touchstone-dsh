#!/usr/bin/env python3
"""Playwright e2e 语言钉桩助手（2026-10-22 i18n 批次）。

产品默认语言已改为 English（`webui/src/utils/i18n.js` 的 `DEFAULT_LANG='en'`），
而既有 e2e 脚本全部按中文文案定位 UI。这里在页面首个文档创建前把
`localStorage.ts_lang` 钉成 `zh`，使默认英文上线后整套既有 e2e 仍按中文界面跑；
将来需要验证英文界面的用例显式传 `lang='en'` 即可。

用法：

    from e2eutil import new_page

    pg = new_page(b)                       # 中文界面（既有 e2e 默认）
    pg = new_page(b, lang='en')            # 英文界面
    pg = new_page(b, viewport={'width': 1600, 'height': 900})   # 透传 context 选项

注意：
- 必须在 `page.goto()` **之前**调用 —— `add_init_script` 只对其后创建的文档生效；
- localStorage 在隐私模式/受限上下文可能抛错，钉桩脚本自带 try/catch，
  失败不阻塞页面打开（届时用例按中文定位失败，会自然暴露语言不符）；
- `browser` 可以是 Browser（`new_page` 快捷方式支持 viewport 等 context 选项，
  经 `**kwargs` 透传）或 BrowserContext（后者不接受额外参数）。
"""


def new_page(browser, lang: str = "zh", **kwargs):
    """新建页面并把界面语言钉到 lang（默认中文），返回 page。"""
    page = browser.new_page(**kwargs)
    page.add_init_script(
        "try{localStorage.setItem('ts_lang','%s')}catch(e){}" % lang)
    return page
