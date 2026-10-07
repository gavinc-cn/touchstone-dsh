// utils/fontScale.js 单测：字体大小档位（<html> 内联 --fs）读写与应用
// getFontScale 对非法/缺失 localStorage 值回落标准 1；applyFontScale 同时写内联
// CSS 变量与 localStorage；initFontScale 在渲染前按持久化值应用（避免字号闪烁）。
import { beforeEach, describe, expect, it } from 'vitest'

import { FONT_SCALES, applyFontScale, getFontScale, initFontScale } from '../utils/fontScale'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.style.removeProperty('--fs')
})

describe('fontScale', () => {
  it('getFontScale：无持久值时默认 1（标准），合法值回读，非法值回落', () => {
    expect(getFontScale()).toBe(1)
    localStorage.setItem('ts_fs', '1.15')
    expect(getFontScale()).toBe(1.15)
    localStorage.setItem('ts_fs', '9.9')
    expect(getFontScale()).toBe(1)
  })

  it('applyFontScale 写 <html> 内联 --fs 与 localStorage；initFontScale 按持久化值应用', () => {
    applyFontScale(1.3)
    expect(document.documentElement.style.getPropertyValue('--fs')).toBe('1.3')
    expect(localStorage.getItem('ts_fs')).toBe('1.3')

    document.documentElement.style.removeProperty('--fs')
    initFontScale()
    expect(document.documentElement.style.getPropertyValue('--fs')).toBe('1.3') // 刷新后保持

    localStorage.clear()
    initFontScale()
    expect(document.documentElement.style.getPropertyValue('--fs')).toBe('1') // 清空后回落标准
  })

  it('FONT_SCALES 四档（小/标准/大/特大），标准档为 1', () => {
    expect(FONT_SCALES.map((s) => s.label)).toEqual(['小', '标准', '大', '特大'])
    expect(FONT_SCALES.map((s) => s.value)).toEqual([0.9, 1, 1.15, 1.3])
    expect(FONT_SCALES.some((s) => s.value === 1)).toBe(true)
  })
})
