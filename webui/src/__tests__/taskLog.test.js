// lib/taskLog.js 单测：任务轮次日志入口的打开目标（插件形态面板内导航 / 独立形态新标签页）。
//
// 回归的是 2026-10-27 修复的两条形态性缺陷：
//   ① 独立/插件两档都必须拼对 BASE —— 插件形态旧实现 `window.open('/log?…')` 落到 dsh 宿主根
//      404；现口径插件形态改为面板内 router 导航（路由是 basename 相对的 /log?…），
//      独立形态新标签页 href 必须带 BASE（本档为 ''）。
//   ② dsh 桌面端宿主页 origin 是 `dsh://app/`：旧实现相对地址被解析成 dsh://app/log…
//      被桌面壳拦掉（点了没反应）；面板内导航不经过 window.open，天然不受影响。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isPluginBuild, logHref, logOpenTarget, logRoute, markLogReturn, takeLogReturn,
} from '../lib/taskLog'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('独立 web 形态（BASE_URL=/）', () => {
  it('路由是 basename 相对的 /log?task..&round..', () => {
    expect(isPluginBuild()).toBe(false)
    expect(logRoute(5, 2)).toBe('/log?task=5&round=2')
  })

  it('新标签页 href 就是路由（独立形态 BASE 为空，不会多拼前缀）', () => {
    expect(logHref(5, 2)).toBe('/log?task=5&round=2')
    expect(logOpenTarget(5, 2)).toEqual({ kind: 'new-tab', href: '/log?task=5&round=2' })
  })

  it('旧口径的 404 路径不会被拼出来（回归：不得是 dsh 宿主根的 /log）', () => {
    const href = logHref(138, 1)
    expect(new URL(href, 'http://127.0.0.1:3080/app').pathname).toBe('/log')
    expect(new URL(logHref(138, 1), 'http://127.0.0.1:3080/touchstone/app').pathname).toBe('/log')
  })
})

describe('dsh 插件形态（BASE_URL=/touchstone/）', () => {
  beforeEach(() => {
    vi.stubEnv('BASE_URL', '/touchstone/')
  })

  it('打开目标改为面板内导航（不依赖 window.open，桌面端 dsh:// 拦截不再相关）', () => {
    expect(isPluginBuild()).toBe(true)
    expect(logOpenTarget(138, 1)).toEqual({
      kind: 'navigate',
      to: '/log?task=138&round=1',   // basename 相对：BrowserRouter 自带 /touchstone 前缀
    })
  })

  it('新标签页兜底 href 补了 BASE（万一以后又走新窗口通道也是对的）', () => {
    expect(logHref(138, 1)).toBe('/touchstone/log?task=138&round=1')
    // 在 dsh 宿主根与桌面自定义 scheme 两种 base 下解析，都必须落在 /touchstone 前缀内
    expect(new URL(logHref(138, 1), 'http://127.0.0.1:3080/touchstone/app').pathname)
      .toBe('/touchstone/log')
    expect(new URL(logHref(138, 1), 'dsh://app/').pathname).toBe('/touchstone/log')
  })
})

describe('markLogReturn / takeLogReturn（返回后恢复详情展开的一次性记忆）', () => {
  it('记一次、取一次，取后即清（避免回到别的页面时误展开）', () => {
    markLogReturn(138)
    expect(takeLogReturn()).toBe(138)
    expect(takeLogReturn()).toBe(0)
  })

  it('覆盖写只保留最后一次；非法值归零', () => {
    markLogReturn(1)
    markLogReturn(2)
    expect(takeLogReturn()).toBe(2)
    markLogReturn('abc')
    expect(takeLogReturn()).toBe(0)
  })
})
