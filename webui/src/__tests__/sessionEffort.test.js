// 思考等级工具（前端）单测：档位来源优先级、排序、兜底与展示文本（2026-10-04；
// 2026-10-05 用户口径：档位名一律用原始字段值 off/minimal/.../max，不做中文映射）
import { describe, expect, it } from 'vitest'
import { EFFORT_ORDER, effortChoices, effortLabel, effortText } from '../utils/sessionEffort'

const CATALOG = {
  default: 'deepseek-official/deepseek-flash',
  models: [
    { name: 'deepseek-official/deepseek-flash', display_name: 'deepseek-official/DeepSeek-Flash',
      efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' },
        { id: 'xhigh', name: 'Xhigh' }, { id: 'max', name: 'Max' }],
      default_effort: 'max' },
    { name: 'deepseek-official/deepseek-v4-pro', display_name: 'deepseek-official/DeepSeek-V4-Pro',
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      default_effort: '' },
  ],
}

describe('effortChoices', () => {
  it('按当前模型取档位（只列该模型支持的）', () => {
    const r = effortChoices(CATALOG, 'deepseek-official/deepseek-v4-pro')
    expect(r.options.map((o) => o.value)).toEqual(['low', 'high'])
    expect(r.defaultEffort).toBe('')
    expect(r.fromCatalog).toBe(true)
    expect(r.options[1].label).toBe('high')
  })

  it('模型未定时取全列表并集，按升序排列', () => {
    const r = effortChoices(CATALOG, '')
    // 并集=目录里出现过的档位（本载荷无 off，故不含 off；不是无条件的内置全表）
    expect(r.options.map((o) => o.value)).toEqual(
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(r.fromCatalog).toBe(true)
  })

  it('值命中裸模型名（无 provider 前缀）也算命中该模型', () => {
    const r = effortChoices(CATALOG, 'deepseek-v4-pro')
    expect(r.options.map((o) => o.value)).toEqual(['low', 'high'])
  })

  it('目录没有档位信息（老插件）时回落内置全档表', () => {
    const r = effortChoices({ models: [{ name: 'p/m' }], default: 'p/m' }, 'p/m')
    expect(r.options.map((o) => o.value)).toEqual(EFFORT_ORDER)
    expect(r.fromCatalog).toBe(false)
  })

  it('目录为空（独立形态/驱动不可用）同样回落内置全档表', () => {
    expect(effortChoices(null, '').options.map((o) => o.value)).toEqual(EFFORT_ORDER)
  })

  it('off（不思考）是合法档位：目录给 off 时照列', () => {
    const r = effortChoices({ models: [{ name: 'p/m', efforts: [{ id: 'off' }, { id: 'high' }] }] }, 'p/m')
    expect(r.options.map((o) => o.value)).toEqual(['off', 'high'])
    expect(r.options[0].label).toBe('off')
  })

  it('宿主自定义档位（不在内置表）按原序追加在后', () => {
    const r = effortChoices({ models: [{ name: 'p/m', efforts: [{ id: 'ultra' }, { id: 'high' }] }] }, 'p/m')
    expect(r.options.map((o) => o.value)).toEqual(['high', 'ultra'])
  })
})

describe('effortLabel / effortText', () => {
  it('档位名一律用原始字段值（忽略宿主给的 display name）', () => {
    expect(effortLabel('max', 'Max')).toBe('max')     // 宿主 name 不采用
    expect(effortLabel('ultra', 'Ultra')).toBe('ultra')
    expect(effortLabel('')).toBe('')
  })

  it('空值展示为默认档（带宿主默认档时括注字段值）', () => {
    expect(effortText('')).toBe('默认')
    expect(effortText('', 'max')).toBe('默认（max）')
    expect(effortText('low')).toBe('low')
  })
})
