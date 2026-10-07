// lib/lastRoute.js 单测：路由记忆（「切到 dsh 界面再回来回到上次页面」的 SPA 半边）
// 覆盖：换页即记；登录页/旁路日志页不记；脏值（相对路径/异前缀/未知路由/插件根）读回为空；
// 启动恢复只在「停在入口页」时改址（深链/书签优先），且已在记忆页上时不动作。
// 键名 ts.last_route 与插件宿主半 dsh-plugin/src/client.js 的 ROUTE_KEY **逐字一致**
// （宿主半由 dsh-plugin/scripts/dev-check-bridge.mjs 用真实产物自检）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAST_ROUTE_KEY, readLastRoute, restoreLastRoute, writeLastRoute } from '../lib/lastRoute'

// 测试环境 BASE_URL='/'（vite 非 plugin 档），即 basePath()='' —— 路径不带 /touchstone 前缀
beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeLastRoute / readLastRoute', () => {
  it('换页即记：路径 + 查询串原样存下', () => {
    writeLastRoute('/settings/rag')
    expect(localStorage.getItem(LAST_ROUTE_KEY)).toBe('/settings/rag')
    expect(readLastRoute()).toBe('/settings/rag')

    writeLastRoute('/app', '?pid=3')
    expect(readLastRoute()).toBe('/app?pid=3')
  })

  it('登录页与旁路日志页不记（/log 是 window.open 出来的新标签页）', () => {
    writeLastRoute('/login')
    expect(readLastRoute()).toBe('')
    writeLastRoute('/log', '?task=5&round=2')
    expect(readLastRoute()).toBe('')
  })

  it('空路径/异常存储：静默忽略，不影响页面', () => {
    expect(() => writeLastRoute('')).not.toThrow()
    expect(readLastRoute()).toBe('')
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => writeLastRoute('/settings')).not.toThrow()
    spy.mockRestore()
  })

  it('脏值一律当没有：相对路径 / 未知路由 / 空串', () => {
    for (const raw of ['settings/rag', '/unknown/route', '/log?task=1', '', 'http://evil.test/x']) {
      localStorage.setItem(LAST_ROUTE_KEY, raw)
      expect(readLastRoute()).toBe('')
    }
  })

  it('白名单内的路由种类都能读回（app/monitor/admin/settings/根）', () => {
    for (const raw of ['/app', '/monitor', '/admin', '/settings', '/settings/appearance', '/']) {
      localStorage.setItem(LAST_ROUTE_KEY, raw)
      expect(readLastRoute()).toBe(raw)
    }
  })
})

describe('dsh 插件形态（BASE_URL=/touchstone/，2026-10-07 真机踩坑回归）', () => {
  // 真机实测：react-router 的 useLocation().pathname 是 **basename 相对**的（/settings/appearance），
  // 而宿主半要拿记忆值直接当 iframe src、SPA 自己要用它 replaceState —— 落盘必须是绝对路径。
  beforeEach(() => {
    vi.stubEnv('BASE_URL', '/touchstone/')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('写入时补 base（宿主半拿到的就是可用作 iframe src 的绝对路径）', () => {
    writeLastRoute('/settings/appearance')
    expect(localStorage.getItem(LAST_ROUTE_KEY)).toBe('/touchstone/settings/appearance')
    expect(readLastRoute()).toBe('/touchstone/settings/appearance')
  })

  it('已带 base 的输入不重复补；查询串照旧保留', () => {
    writeLastRoute('/touchstone/app', '?pid=3')
    expect(readLastRoute()).toBe('/touchstone/app?pid=3')
  })

  it('异前缀 / 插件根之外的路由读回为空（宿主半另有前缀校验）', () => {
    for (const raw of ['/other/app', 'settings/appearance', '/touchstone/unknown']) {
      localStorage.setItem(LAST_ROUTE_KEY, raw)
      expect(readLastRoute()).toBe('')
    }
  })

  it('恢复用绝对路径改址（不会跳出 /touchstone 前缀）', () => {
    writeLastRoute('/settings/appearance')
    window.history.replaceState(null, '', '/touchstone/app')
    expect(restoreLastRoute()).toBe('/touchstone/settings/appearance')
    expect(window.location.pathname).toBe('/touchstone/settings/appearance')
  })
})

describe('restoreLastRoute', () => {
  it('停在入口页（/ 或 /app）时改址到记忆页，用 replaceState 不留历史', () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    writeLastRoute('/settings/appearance')
    window.history.replaceState(null, '', '/app')
    replace.mockClear()
    expect(restoreLastRoute()).toBe('/settings/appearance')
    expect(window.location.pathname).toBe('/settings/appearance')
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('深链/书签优先：已经是具体页面时不动', () => {
    writeLastRoute('/settings/appearance')
    window.history.replaceState(null, '', '/settings/feishu')
    expect(restoreLastRoute()).toBe('')
    expect(window.location.pathname).toBe('/settings/feishu')
  })

  it('已停在记忆页上（刷新 / 宿主半已按记忆建 iframe）时不动作', () => {
    writeLastRoute('/settings/appearance')
    window.history.replaceState(null, '', '/settings/appearance')
    const replace = vi.spyOn(window.history, 'replaceState')
    expect(restoreLastRoute()).toBe('')
    expect(replace).not.toHaveBeenCalled()
  })

  it('没有记忆时什么都不做', () => {
    window.history.replaceState(null, '', '/app')
    expect(restoreLastRoute()).toBe('')
    expect(window.location.pathname).toBe('/app')
  })
})
