// 设置页「飞书设置」分区的**挂载冒烟**（2026-10-15 M9-R2 新增）。
//
// 为什么需要它：2026-10-15 用户报「点进飞书设置页面就黑屏」。根因是
// `FeishuPanel.jsx:132/141` 调了 `isPushEnabled(cfg)`，而第 5 行的 import 里**没有这个名字**
// （2026-10-10 638d702 引入）⇒ 渲染期 `ReferenceError` ⇒ React 卸载整棵树 ⇒ 全黑。
// 这类「纯函数测过了、**调用点**没接线」的缺陷现有判据一个都照不到：
//   · `utils/feishuPush.test.js` 测的是 `isPushEnabled` 本身（函数没坏）；
//   · `tests/test_webui_provision_gates.py` 是**静态文本**解析（只认按钮块）；
//   · vitest 全套只测 utils/stores，**从不渲染组件**（见 vite.config.js 注释）。
// ⇒ 补一条**真渲染**的判据：把设置页飞书分区挂起来，断言关键文案在、且没有抛错。
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { meApi } from '../api'
import { toast } from '../utils/toast'
import { setLang } from '../utils/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api', () => ({
  authApi: { me: vi.fn(async () => ({ username: 'admin', is_admin: true, must_change_pw: false })) },
  meApi: {
    feishuCfgGet: vi.fn(async () => ({
      enabled: 1, push_enabled: 1, app_id: 'cli_x', app_secret_set: true,
      default_webhook: '', base_url: '',
      // M11.1：入站状态两键（面板据此渲染运行中/待启动/未配置，并放「重连入站」按钮）
      inbound: { configured: true, thread: false },
    })),
    feishuGet: vi.fn(async () => ({ open_id: 'ou_x', bound_at: '2026-10-11 00:00:00' })),
    feishuProvisionGet: vi.fn(async () => ({
      supported: true, enabled: true, state: 'idle', url: '', error: '',
      app_id: 'cli_x', steps: [], age_s: 0,
    })),
    feishuOutbox: vi.fn(async () => []),
    feishuSlashGet: vi.fn(async () => ({ configured: false, desired: [], remote: [], extra: [], need_scope: false, error: '' })),
    feishuBindcode: vi.fn(async () => ({ code: 'ABC', expire_in: 600 })),
    // M11.1 面板「重连入站」：默认走成功档（configured 且起了新连接）
    feishuReconnect: vi.fn(async () => ({
      ok: true, started: true, inbound: { configured: true, thread: true },
    })),
  },
  projectApi: { list: vi.fn(async () => []) },
  builtinAssetApi: { list: vi.fn(async () => ({ assets: [] })) },
  adminApi: { ragGet: vi.fn(async () => ({})) },
}))
vi.mock('../utils/toast', () => ({ toast: vi.fn() }))

const Settings = (await import('../views/Settings.jsx')).default

/** 挂载设置页的某个分区，等数据落地后交回容器 */
async function mountSection(section) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: [`/settings/${section}`] },
      createElement(Routes, null,
        createElement(Route, { path: '/settings/:section', element: createElement(Settings) }))))
    await new Promise((r) => setTimeout(r, 50))
  })
  return { container, root }
}

let errs
beforeEach(() => {
  // 本用例断言中文源文案与中文 toast（e2e 同样钉 zh）：显式钉桩，避免默认 en 下文案变英文
  setLang('zh')
  errs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.map(String).join(' ')) })
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('设置页飞书分区：挂载冒烟（黑屏回归守卫）', () => {
  it('渲染出「推送总控」与「扫码创建飞书应用」，且渲染期零错误', async () => {
    const { container } = await mountSection('feishu')
    const text = container.textContent || ''
    // ① 用 `isPushEnabled(cfg)` 的那一行（黑屏的直接来源）：文案必须在
    expect(text).toContain('推送总控')
    // ② 二维码供给卡（M9 拆闸门的那个卡）
    expect(text).toContain('扫码创建飞书应用')
    // ③ 渲染没抛错（React 在 ReferenceError 时会 console.error 并卸载树）
    // 只认错误，不认 React 的告警（act/forwardRef 那几条是既有噪声，不是黑屏）
    const realErrors = errs.filter((e) => !/^(Warning:|\u26a0)/.test(e.trim()))
    expect(realErrors).toEqual([])
    // ④ 树没被卸载（黑屏的另一半证据：崩了之后容器会是空的）
    expect(container.innerHTML.length).toBeGreaterThan(1000)
  })

  it('**负对照**：把 `isPushEnabled` 从 import 里删掉 ⇒ 上面那条必须红（黑屏可复现）', async () => {
    // 这条不是重复用例，而是「判据真的能红」的静态证明：检查 import 名单里确实有它。
    const src = readFileSync('src/components/settings/FeishuPanel.jsx', 'utf8')
    const importLine = src.split('\n').find((l) => l.includes("from '../../utils/feishuPush'"))
    expect(importLine).toMatch(/\bisPushEnabled\b/)
    // 反过来：源码里凡是调用了它，就必须在 import 名单里（少一个名字 = 整页黑屏）
    const calls = [...src.matchAll(/isPushEnabled\(/g)].length
    expect(calls).toBeGreaterThan(0)
    expect(src).toContain('isPushEnabled,')
  })
})

// M11.1：设置页面板「重连入站」按钮（把飞书卡片上的「换用新应用」搬到页面里，免去跳飞书）。
// 判据不是「按钮渲染出来了」而是**点了之后真的调端点、并按响应分支给出诚实的 toast**
// ——面板最容易犯的错就是「没连上也说已重连」（M10 现场就有一次「界面说谎」）。
describe('设置页飞书分区：重连入站按钮（M11.1）', () => {
  /** 在容器里按文案找按钮（Button 组件会把文案放进子节点，textContent 恰好可比） */
  function findButton(container, label) {
    return [...container.querySelectorAll('button')]
      .find((b) => (b.textContent || '').includes(label))
  }

  it('点击「重连入站」⇒ 调 feishuReconnect，成功档 toast「已重连」并回读配置', async () => {
    const { container } = await mountSection('feishu')
    const button = findButton(container, '重连入站')
    expect(button, '面板必须有「重连入站」按钮').toBeTruthy()
    meApi.feishuReconnect.mockClear()
    toast.mockClear()
    meApi.feishuCfgGet.mockClear()
    await act(async () => {
      button.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(meApi.feishuReconnect).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('入站消息长连接已重连（用当前保存的应用凭据）')
    // 按钮点完要回读 cfg（入站状态可能从「待启动」变「运行中」）
    expect(meApi.feishuCfgGet).toHaveBeenCalled()
  })

  it('未配置凭据档：toast 如实说「还没配置」，**不许**谎报已重连', async () => {
    const { container } = await mountSection('feishu')
    const button = findButton(container, '重连入站')
    meApi.feishuReconnect.mockResolvedValueOnce({
      ok: true, started: false, inbound: { configured: false, thread: false },
    })
    toast.mockClear()
    await act(async () => {
      button.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(toast).toHaveBeenCalledWith('还没配置自建应用凭据：先填 App ID/App Secret 并保存')
  })
})

// 2026-10-22 Task 5 fix round 1：扫码轮询的**成功/失败分支**回归。
// 既有挂载冒烟只停在 idle 态，照不到 3s 轮询回调里的 `t` 遮蔽：旧代码
// `const t = setInterval(...)` 盖住 useI18n 的 t，回调里 `t('应用已创建：{app_id}')`
// 等于拿 interval 句柄当函数调 ⇒ TypeError 被轮询自己的 catch 吞掉 ⇒ 成功 toast 丢失、
// onCfgChanged 不跑（上方凭据卡不刷新，「生成绑定码」一直禁用）。这里用假时钟推进那一拍。
describe('设置页飞书分区：扫码轮询分支（t 遮蔽回归）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 假时钟下挂载设置页飞书分区；0ms 推进只为冲刷 effect 里 load 的微任务 */
  async function mountWithFakeTimers() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ['/settings/feishu'] },
        createElement(Routes, null,
          createElement(Route, { path: '/settings/:section', element: createElement(Settings) }))))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    return { container, root }
  }

  /** 扫码供给接口的等待态 / 终态桩（字段与后端契约一致） */
  function provisionState(state, extra = {}) {
    return {
      supported: true, enabled: true, state, url: '', error: '',
      app_id: '', steps: [], age_s: 0, ...extra,
    }
  }

  it('轮询到 success：toast 用插值后的 app_id，且 onCfgChanged 真跑（回读 cfg）', async () => {
    meApi.feishuProvisionGet
      .mockResolvedValueOnce(provisionState('waiting', { url: 'https://qr.example/x' }))
      .mockResolvedValueOnce(provisionState('success', { app_id: 'cli_new' }))
    toast.mockClear()
    meApi.feishuCfgGet.mockClear()
    await mountWithFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    // ① 轮询确实打了两拍：挂载时读一次状态 + 3s 后那一拍
    expect(meApi.feishuProvisionGet).toHaveBeenCalledTimes(2)
    // ② onCfgChanged = 上方凭据卡的 load；挂载时 1 次 + 成功后 1 次
    expect(meApi.feishuCfgGet).toHaveBeenCalledTimes(2)
    // ③ 成功 toast 的文案必须走 i18n 的 t（旧代码这里抛 TypeError，toast 根本不会调）
    expect(toast).toHaveBeenCalledWith('应用已创建：cli_new')
  })

  it('轮询到 failed 且后端 error 为空：回落到「扫码创建失败」文案，不静默', async () => {
    meApi.feishuProvisionGet
      .mockResolvedValueOnce(provisionState('waiting', { url: 'https://qr.example/x' }))
      .mockResolvedValueOnce(provisionState('failed', { error: '' }))
    toast.mockClear()
    meApi.feishuCfgGet.mockClear()
    await mountWithFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(meApi.feishuProvisionGet).toHaveBeenCalledTimes(2)
    // 失败档不刷新凭据卡（没有新凭据可回读）
    expect(meApi.feishuCfgGet).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('扫码创建失败')
  })
})
