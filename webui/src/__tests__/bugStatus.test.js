// utils/bugStatus.js 单测：bug 报告状态归类（BugsTab 徽标与监控统计图共用的口径）
// 归类按 bug_report.md「状态」字段的正则命中：已拒绝 / 复测通过 / 已修复 / 已分析·
// 修复方案 / 待分析·复测未通过 / 其余待处理（pending）。
import { describe, expect, it } from 'vitest'

import { bugStatusCls } from '../utils/bugStatus'

describe('bugStatusCls', () => {
  it('六类状态各自归类', () => {
    expect(bugStatusCls('已拒绝（误报，非缺陷）')).toBe('reject')
    expect(bugStatusCls('复测通过')).toBe('pass')
    expect(bugStatusCls('已修复（未验证）')).toBe('fix')
    expect(bugStatusCls('已分析，待修复')).toBe('run')
    expect(bugStatusCls('待分析')).toBe('retest')
    expect(bugStatusCls('复测未通过，需继续排查')).toBe('retest')
    expect(bugStatusCls('')).toBe('pending') // 状态字段缺失/未入库
    expect(bugStatusCls(undefined)).toBe('pending')
  })

  it('报告字段文本（带前缀）也能命中，判定与字段位置无关', () => {
    expect(bugStatusCls('- **状态**: 已分析，给出修复方案')).toBe('run')
    expect(bugStatusCls('状态：已修复（未验证）')).toBe('fix')
  })
})
