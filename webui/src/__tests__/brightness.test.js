// utils/brightness.js 单测：文字亮度档位（<html data-bright>）读写与应用
//   getBrightness 对非法/缺失 localStorage 值回落偏暗；applyBrightness 同时写 data-bright
//   与 localStorage；initBrightness 在渲染前按持久化值应用（避免首屏文字亮度跳变）。
//
// 另含一段**CSS 取值静态守卫**（本批的核心诉求是"正文别太白"，光靠 JS 单测证明不了）：
//   - dsh-dark 的「偏暗」档正文必须等于 dsh 宿主 dim-text 插件的实况值 #cfd3d6；
//   - 三套深色皮肤都定义了 --text-hi/mid/lo 且 --text 取 mid；
//   - 浅色皮肤三档同值、且不写 [data-bright] 覆盖块（与宿主"浅色不动"同口径）；
//   - 品牌墨 --star 不再被当文字色用（文字侧一律 --star-text）。
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  BRIGHTNESSES, DEFAULT_BRIGHTNESS, applyBrightness, brightnessLabel, getBrightness, initBrightness,
} from '../utils/brightness'

// 静态守卫要读真实 CSS 文件（vitest 的 cwd = webui/，见 vitest 配置的 root）
const css = (rel) => readFileSync(path.resolve(process.cwd(), 'src/styles', rel), 'utf8')
const THEME_CSS = css('theme.css')
const COMPONENTS_CSS = css('components.css')
const INDEX_CSS = css('index.css')

/** 取某选择器的声明块（theme.css 里皮肤块都是单层大括号，够用）。 */
function block(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = THEME_CSS.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.bright
})

describe('brightness', () => {
  it('getBrightness：无持久值回落偏暗，合法值回读，非法值回落', () => {
    expect(getBrightness()).toBe('dim')
    localStorage.setItem('ts_bright', 'normal')
    expect(getBrightness()).toBe('normal')
    localStorage.setItem('ts_bright', 'dimmer')
    expect(getBrightness()).toBe('dimmer')
    localStorage.setItem('ts_bright', 'no-such-level')
    expect(getBrightness()).toBe('dim')
  })

  it('applyBrightness 写 <html data-bright> 与 localStorage；initBrightness 按持久化值应用', () => {
    applyBrightness('normal')
    expect(document.documentElement.dataset.bright).toBe('normal')
    expect(localStorage.getItem('ts_bright')).toBe('normal')

    delete document.documentElement.dataset.bright
    initBrightness()
    expect(document.documentElement.dataset.bright).toBe('normal') // 刷新后保持

    localStorage.clear()
    initBrightness()
    expect(document.documentElement.dataset.bright).toBe('dim') // 清空后回落偏暗

    applyBrightness('bogus') // 非法入参按缺省档落盘
    expect(document.documentElement.dataset.bright).toBe('dim')
    expect(localStorage.getItem('ts_bright')).toBe('dim')
  })

  it('BRIGHTNESSES 三档（原样/偏暗/更暗），缺省档是偏暗', () => {
    expect(BRIGHTNESSES.map((b) => b.id)).toEqual(['normal', 'dim', 'dimmer'])
    expect(BRIGHTNESSES.map((b) => b.label)).toEqual(['原样', '偏暗', '更暗'])
    expect(DEFAULT_BRIGHTNESS).toBe('dim')
    expect(brightnessLabel('dim')).toBe('偏暗')
    expect(brightnessLabel('nope')).toBe('nope')
  })

  it('CSS 守卫：三套深色皮肤都有文字梯三值，--text 取偏暗档', () => {
    const skins = { starlight: ':root', classic: ":root[data-skin='classic']", 'dsh-dark': ":root[data-skin='dsh-dark']" }
    for (const [name, sel] of Object.entries(skins)) {
      const css = block(sel)
      expect(css, `${name} 缺 --text-hi`).toMatch(/--text-hi:\s*#[0-9a-f]{6}/i)
      expect(css, `${name} 缺 --text-mid`).toMatch(/--text-mid:\s*#[0-9a-f]{6}/i)
      expect(css, `${name} 缺 --text-lo`).toMatch(/--text-lo:\s*#[0-9a-f]{6}/i)
      expect(css, `${name} 的 --text 应取 mid`).toMatch(/--text:\s*var\(--text-mid\)/)
      expect(css, `${name} 缺 --star-text`).toMatch(/--star-text:/)
    }
  })

  it('CSS 守卫：dsh-dark 偏暗档正文 = 宿主 dim-text 实况值，且强调文字比正文亮一档', () => {
    const css = block(":root[data-skin='dsh-dark']")
    expect(css).toMatch(/--text-hi:\s*#f9fafb/)
    expect(css).toMatch(/--text-mid:\s*#cfd3d6/)
    expect(css).toMatch(/--text-lo:\s*#adb2b8/)
    expect(css).toMatch(/--star-text:\s*#e1e5ee/)
    // 强调文字走 --star-text，品牌墨 --star 不再被当文字色
    expect(css).toMatch(/--tab-active:\s*var\(--star-text\)/)
    expect(css).toMatch(/--admin-badge:\s*var\(--star-text\)/)
    // 「偏暗」档的文字色都不再取近白（hi 档才允许是 #f9fafb，供用户选回原样）
    expect(css).not.toMatch(/--text-mid:\s*#f9fafb/)
    expect(css).not.toMatch(/--text-lo:\s*#f9fafb/)
    expect(css).not.toMatch(/--star-text:\s*#f9fafb/)
  })

  it('CSS 守卫：normal/dimmer 两档覆盖块齐备，浅色皮肤不写覆盖块', () => {
    expect(block(":root[data-skin='dsh-dark'][data-bright='normal']")).toMatch(/--text:\s*var\(--text-hi\)/)
    expect(block(":root[data-skin='dsh-dark'][data-bright='dimmer']")).toMatch(/--text:\s*var\(--text-lo\)/)
    expect(block(":root[data-skin='starlight'][data-bright='normal']")).toMatch(/--text:\s*var\(--text-hi\)/)
    expect(block(":root[data-skin='classic'][data-bright='dimmer']")).toMatch(/--text:\s*var\(--text-lo\)/)
    // dsh-light 三档同值 ⇒ 不该有 [data-bright] 覆盖块（与 dsh 宿主 dim-text 的浅色不动同口径）
    expect(THEME_CSS).not.toMatch(/data-skin='dsh-light'\]\[data-bright/)
    const light = block(":root[data-skin='dsh-light']")
    expect(light).toMatch(/--text-hi:\s*#0f1115; --text-mid:\s*#0f1115; --text-lo:\s*#0f1115/)
  })

  it('CSS 守卫：品牌墨 --star 只用于边框/填充/装饰，不再当文字色', () => {
    // 文字侧的强调色一律 --star-text；--star 仍可出现于 border-color/outline/background/gradient
    // （负向后顾排除 border-left-color 这类复合属性名）
    const starAsText = /(?<![\w-])color:\s*var\(--star\)\s*;/
    expect(COMPONENTS_CSS).not.toMatch(starAsText)
    expect(THEME_CSS).not.toMatch(starAsText)
  })

  it('CSS 守卫：次级文字的档位覆盖写在 index.css（无层样式会盖过 theme.css 的 @layer legacy）', () => {
    expect(INDEX_CSS).toMatch(
      /\[data-skin='dsh-dark'\]\[data-bright='dimmer'\]\s*\{[^}]*--muted-foreground:\s*#979da6/)
    // theme.css 的档位覆盖块里不该声明 --muted-foreground（放那边会被 index.css 压掉，静默失效）
    expect(block(":root[data-skin='dsh-dark'][data-bright='normal']")).not.toMatch(/--muted-foreground/)
    expect(block(":root[data-skin='dsh-dark'][data-bright='dimmer']")).not.toMatch(/--muted-foreground/)
  })
})
