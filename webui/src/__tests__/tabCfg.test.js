// utils/tabCfg.js 单测（2026-10-22 批次：压测面板默认排到最后）。
// 钉住三件事：
//   ① 默认序 = 开发看板/测试任务/监控面板/Bug 报告/压测面板（压测面板末位）；
//   ② v1 旧默认序（压测面板在第三位）的存量布局一次性迁移到新默认序，隐藏态原样保留；
//   ③ 用户自定义过的顺序（含迁到 v2 后主动把压测面板拖回旧位置）不被覆盖，
//      未知 key 丢弃、缺失 key 按新默认序补尾。
import { describe, expect, it } from 'vitest'

import {
  LEGACY_DEFAULT_ORDER, TAB_CFG_VER, TAB_KEYS, TAB_LABEL, normTabCfg,
} from '../utils/tabCfg'

const NEW_DEFAULT = ['board', 'tasks', 'monitor', 'bugs', 'stress']

describe('tabCfg：标签页默认顺序与布局规范化', () => {
  it('默认序把压测面板排在最后', () => {
    expect(TAB_KEYS).toEqual(NEW_DEFAULT)
    expect(TAB_LABEL.stress).toBe('压测面板')
  })

  it('无布局/坏布局时回落新默认序，全可见', () => {
    expect(normTabCfg(null)).toMatchObject({ order: NEW_DEFAULT, hidden: [] })
    expect(normTabCfg(undefined).order).toEqual(NEW_DEFAULT)
    expect(normTabCfg({ order: 'oops', hidden: null })).toMatchObject({
      order: NEW_DEFAULT, hidden: [],
    })
  })

  it('v1 旧默认序的存量布局迁移为新默认序', () => {
    const cfg = { order: [...LEGACY_DEFAULT_ORDER], hidden: [] }
    expect(normTabCfg(cfg).order).toEqual(NEW_DEFAULT)
  })

  it('迁移保留隐藏态（只改顺序，不动 hidden）', () => {
    const cfg = { order: [...LEGACY_DEFAULT_ORDER], hidden: ['bugs', 'monitor'] }
    expect(normTabCfg(cfg)).toMatchObject({
      order: NEW_DEFAULT, hidden: ['bugs', 'monitor'],
    })
  })

  it('用户自定义顺序原样保留（压测面板仍在中间也不动）', () => {
    const order = ['tasks', 'board', 'stress', 'monitor', 'bugs']
    expect(normTabCfg({ order, hidden: [] }).order).toEqual(order)
  })

  it('v2 布局里把压测面板拖回旧位置：不再被迁移覆盖', () => {
    const cfg = { order: [...LEGACY_DEFAULT_ORDER], hidden: [], v: TAB_CFG_VER }
    expect(normTabCfg(cfg).order).toEqual(LEGACY_DEFAULT_ORDER)
  })

  it('未知 key 丢弃、缺失 key 按新默认序补尾', () => {
    expect(normTabCfg({ order: ['bugs', 'ghost', 'board'], hidden: [] }).order)
      .toEqual(['bugs', 'board', 'tasks', 'monitor', 'stress'])
  })

  it('规范化幂等（迁移结果再规范化不变）', () => {
    const once = normTabCfg({ order: [...LEGACY_DEFAULT_ORDER], hidden: ['bugs'] })
    expect(normTabCfg(once)).toEqual(once)
  })
})
