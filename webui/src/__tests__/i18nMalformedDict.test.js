// t() 畸形词典值防御（KB-44）：
//   真实 i18n/en.json 由守卫保证形状，但运行时仍要对坏词条兜底——number/null/array/
//   缺 one+other/one·other 不是字符串时，绝不能渲染空串，而是回落中文 key 插值并像
//   缺失词条一样记入 missingKeys()（守卫据此发现坏词条）。
//   用 vi.mock 在 alias 解析层注入畸形词表（只 mock 本用例，不碰真实词表）。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@i18n/en.json', () => ({
  default: {
    web: {
      // 合法词条：string 与 plural 对象都必须保持原行为
      '保存': 'Save',
      '共 {n} 张卡片': { one: '1 card', other: '{n} cards' },
      // 畸形词条（各种形状）
      '数字词条 {n}': 42,
      '空值词条': null,
      '数组词条': ['a', 'b'],
      '缺复数词条 {n}': {},
      '值非字符串复数词条 {n}': { one: 1, other: 2 },
      '半串复数词条 {n}': { one: 'single {n}', other: 7 },
    },
  },
}))

// 注意：必须在 vi.mock 之后 import，i18n 运行时才会拿到上面的假词典
import { t, setLang, missingKeys, DEFAULT_LANG } from '../utils/i18n'

describe('t() 畸形词典值防御', () => {
  beforeEach(() => {
    setLang('en') // 显式英文：走 en 词典分支
  })

  it('合法 string / plural 词条照常返回英文', () => {
    expect(t('保存')).toBe('Save')
    expect(t('共 {n} 张卡片', { n: 1 })).toBe('1 card')
    expect(t('共 {n} 张卡片', { n: 3 })).toBe('3 cards')
    expect(missingKeys()).not.toContain('保存')
    expect(missingKeys()).not.toContain('共 {n} 张卡片')
  })

  it('畸形词条回落中文 key 插值（非空串）并记入 missingKeys', () => {
    const cases = [
      ['数字词条 {n}', { n: 7 }, '数字词条 7'],
      ['空值词条', undefined, '空值词条'],
      ['数组词条', undefined, '数组词条'],
      ['缺复数词条 {n}', { n: 2 }, '缺复数词条 2'],
      ['值非字符串复数词条 {n}', { n: 1 }, '值非字符串复数词条 1'],
    ]
    for (const [key, vars, expected] of cases) {
      const out = t(key, vars)
      expect(out).toBe(expected)
      expect(typeof out).toBe('string')
      expect(out.length).toBeGreaterThan(0)
      expect(missingKeys()).toContain(key)
    }
  })

  it('plural 逐形式校验：当前形式是合法字符串才采用，否则回落', () => {
    expect(t('半串复数词条 {n}', { n: 1 })).toBe('single 1')
    expect(t('半串复数词条 {n}', { n: 3 })).toBe('半串复数词条 3')
    expect(missingKeys()).toContain('半串复数词条 {n}')
  })

  it('zh 分支不受畸形值影响：返回中文 key 插值且不新增 missing', () => {
    setLang('zh')
    const before = missingKeys().length
    expect(t('数字词条 {n}', { n: 2 })).toBe('数字词条 2')
    expect(t('缺复数词条 {n}', { n: 2 })).toBe('缺复数词条 2')
    expect(missingKeys().length).toBe(before)
    expect(DEFAULT_LANG).toBe('en')
  })
})
