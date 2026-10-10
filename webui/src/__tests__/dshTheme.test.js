// utils/dshTheme.js 单测：dsh 宿主明暗外观探测（读父文档 + 跟随 + 系统偏好回落）
// 插件形态下 TS SPA 以同源 iframe 嵌在 dsh 面板里，宿主把明暗开关写成
// <body data-ds-dark-theme>；本模块只做「读 + 订阅」，皮肤解析在 utils/skin.js。
import { describe, expect, it, vi } from 'vitest'

import {
  hostDocument, prefersDark, readHostDark, resolveDark, subscribeHostTheme,
} from '../utils/dshTheme'

// 造一个「宿主文档」替身：只用到 body.hasAttribute 与 MutationObserver 可观察的 body
function fakeDoc({ dark = null, body = true } = {}) {
  if (!body) return { body: null }
  const el = document.createElement('div')
  if (dark === true) el.setAttribute('data-ds-dark-theme', '')
  document.body.appendChild(el)
  return { body: el }
}

// 造一个 window 替身：只用到 matchMedia
function fakeWin({ systemDark = false, noMatchMedia = false } = {}) {
  if (noMatchMedia) return {}
  return { matchMedia: () => ({ matches: systemDark, addEventListener() {}, removeEventListener() {} }) }
}

describe('dshTheme', () => {
  it('readHostDark：带属性=true、不带=false、文档缺失/无 body=null(未知)', () => {
    expect(readHostDark(fakeDoc({ dark: true }))).toBe(true)
    expect(readHostDark(fakeDoc({ dark: false }))).toBe(false)
    expect(readHostDark(null)).toBeNull()
    expect(readHostDark(fakeDoc({ body: false }))).toBeNull()
  })

  it('hostDocument：无父窗口(独立形态)返回 null，读父文档抛异常也返回 null', () => {
    // jsdom 里 window.parent === window ⇒ 独立形态
    expect(hostDocument(window)).toBeNull()
    const boom = { get parent() { throw new Error('cross-origin') } }
    expect(hostDocument(boom)).toBeNull()
  })

  it('prefersDark：按 matchMedia 判定，缺 API/抛异常一律 false', () => {
    expect(prefersDark(fakeWin({ systemDark: true }))).toBe(true)
    expect(prefersDark(fakeWin({ systemDark: false }))).toBe(false)
    expect(prefersDark(fakeWin({ noMatchMedia: true }))).toBe(false)
    const boom = { get matchMedia() { throw new Error('nope') } }
    expect(prefersDark(boom)).toBe(false)
  })

  it('resolveDark：宿主已知则宿主优先（系统偏好不参与），宿主未知才回落系统偏好', () => {
    expect(resolveDark(fakeDoc({ dark: true }), fakeWin({ systemDark: false }))).toBe(true)
    expect(resolveDark(fakeDoc({ dark: false }), fakeWin({ systemDark: true }))).toBe(false)
    expect(resolveDark(null, fakeWin({ systemDark: true }))).toBe(true)
    expect(resolveDark(null, fakeWin({ systemDark: false }))).toBe(false)
  })

  it('subscribeHostTheme：宿主属性翻转即回调，退订后不再回调', async () => {
    const doc = fakeDoc({ dark: false })
    const win = fakeWin({ systemDark: false })
    const cb = vi.fn()
    const off = subscribeHostTheme(cb, doc, win)

    doc.body.setAttribute('data-ds-dark-theme', '')
    await new Promise((r) => setTimeout(r, 0))
    expect(cb).toHaveBeenLastCalledWith(true)

    doc.body.removeAttribute('data-ds-dark-theme')
    await new Promise((r) => setTimeout(r, 0))
    expect(cb).toHaveBeenLastCalledWith(false)

    off()
    const n = cb.mock.calls.length
    doc.body.setAttribute('data-ds-dark-theme', '')
    await new Promise((r) => setTimeout(r, 0))
    expect(cb.mock.calls.length).toBe(n) // 退订后静默
  })

  it('subscribeHostTheme：宿主未知时跟随系统偏好变化（matchMedia change）', () => {
    // 替身要忠实地 add/remove：生产侧在 change 时重新 resolveDark（不信事件载荷），
    // 且退订必须真的摘掉监听 —— 状态化 + 可摘除的替身才打得中这两条路径
    const listeners = new Set()
    const mql = {
      matches: false,
      addEventListener: (_t, fn) => { listeners.add(fn) },
      removeEventListener: (_t, fn) => { listeners.delete(fn) },
    }
    const fire = () => { for (const fn of [...listeners]) fn({ matches: mql.matches }) }
    const win = { matchMedia: () => mql }
    const cb = vi.fn()
    const off = subscribeHostTheme(cb, null, win)
    expect(listeners.size).toBe(1)

    mql.matches = true
    fire()
    expect(cb).toHaveBeenLastCalledWith(true)

    off()
    expect(listeners.size).toBe(0) // 退订摘掉系统监听
    mql.matches = false
    fire()
    expect(cb).toHaveBeenLastCalledWith(true) // 不再回调
  })

  it('subscribeHostTheme：无宿主且无 matchMedia 时不抛异常，退订函数可安全调用', () => {
    const off = subscribeHostTheme(() => {}, null, {})
    expect(() => off()).not.toThrow()
  })
})
