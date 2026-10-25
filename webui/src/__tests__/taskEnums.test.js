// utils/taskEnums.js 覆盖状态容错单测（T15 复审 F1）。
//
// 背景：英文版 INDEX 模板曾把展示列取值 `Covered` 写进 live.json 的
// `priorities.levels[].domains[].status`，而看板原来只做 `=== DOMAIN_COVERED` 精确比较，
// 导致覆盖计数静默归零。这里钉住读取端容错：中文 canonical 值（zh 数据）行为不变，
// 英文 `Covered`（大小写不敏感）也算已覆盖，其余取值一律不算。
import { describe, expect, it } from 'vitest'

import { DOMAIN_COVERED, isDomainCovered } from '../utils/taskEnums'

describe('isDomainCovered', () => {
  it('canonical 中文 `已覆盖`（含首尾空白）视为已覆盖：zh 数据行为不变', () => {
    expect(DOMAIN_COVERED).toBe('已覆盖')
    expect(isDomainCovered('已覆盖')).toBe(true)
    expect(isDomainCovered(' 已覆盖 ')).toBe(true)
    expect(isDomainCovered('已覆盖\n')).toBe(true)
  })

  it('英文 `Covered` 大小写不敏感也视为已覆盖（F1 防御）', () => {
    expect(isDomainCovered('Covered')).toBe(true)
    expect(isDomainCovered('covered')).toBe(true)
    expect(isDomainCovered('COVERED')).toBe(true)
    expect(isDomainCovered('  Covered\t')).toBe(true)
  })

  it('`Not covered` / 中文 `未覆盖` / 空值 / 未知值一律不算已覆盖', () => {
    expect(isDomainCovered('Not covered')).toBe(false)
    expect(isDomainCovered('not covered')).toBe(false)
    expect(isDomainCovered('未覆盖')).toBe(false)
    expect(isDomainCovered('')).toBe(false)
    expect(isDomainCovered('   ')).toBe(false)
    expect(isDomainCovered(undefined)).toBe(false)
    expect(isDomainCovered(null)).toBe(false)
    expect(isDomainCovered(1)).toBe(false)
    // 只认 canonical 全值（与 dataLabels 的精确匹配口径一致），不做前缀/模糊匹配
    expect(isDomainCovered('已覆盖（自定义）')).toBe(false)
  })
})
