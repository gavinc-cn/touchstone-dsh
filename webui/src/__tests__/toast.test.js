// utils/toast.js 单测：轻量 toast（单例元素 + 自动消失）
// 覆盖：首次调用创建 .ts-toast 单例并加 show 类、重复调用复用同一元素并刷新计时器、
// 到期移除 show 类。模块内单例用 resetModules 逐例重置，避免跨例串状态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let toast

beforeEach(async () => {
  vi.resetModules() // 重置模块级单例元素
  document.body.innerHTML = ''
  vi.useFakeTimers()
  ;({ toast } = await import('../utils/toast'))
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('toast', () => {
  it('首次调用创建 .ts-toast 并显示；重复调用复用同一元素', () => {
    toast('已复制')
    const el = document.querySelector('.ts-toast')
    expect(el).not.toBeNull()
    expect(el.textContent).toBe('已复制')
    expect(el.classList.contains('show')).toBe(true)

    toast('第二条')
    expect(document.querySelectorAll('.ts-toast').length).toBe(1)
    expect(el.textContent).toBe('第二条')
  })

  it('默认 2500ms 后自动隐藏', () => {
    toast('t')
    const el = document.querySelector('.ts-toast')
    vi.advanceTimersByTime(2499)
    expect(el.classList.contains('show')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.classList.contains('show')).toBe(false)
  })

  it('连发时重置计时器（按最后一次起算）', () => {
    toast('a', 100)
    const el = document.querySelector('.ts-toast')
    vi.advanceTimersByTime(60)
    toast('b', 100) // 重置隐藏计时
    vi.advanceTimersByTime(60)
    expect(el.classList.contains('show')).toBe(true) // 距第二次仅 60ms
    vi.advanceTimersByTime(40)
    expect(el.classList.contains('show')).toBe(false) // 距第二次满 100ms
  })
})
