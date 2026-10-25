// utils/bugStatus.js 单测：bug 报告状态归类（BugsTab 徽标与监控统计图共用的口径）
// 归类按 bug_report.md「状态」字段的正则命中：已拒绝 / 复测通过 / 已修复 / 已分析·
// 修复方案 / 待分析·复测未通过 / 其余待处理（pending）。
// 另含 2026-10-25 批次新增的**严重程度等级**纯函数（筛选/计数/样式类）：
// 后端下发 canonical 中文（高/中/低）或空串（未分级），未知值一律归「未分级」。
import { describe, expect, it } from 'vitest'

import {
  SEV_FILTER_ALL, SEV_HIGH, SEV_LOW, SEV_MEDIUM, SEV_NONE,
  bugStatusCls, filterBugsBySeverity, severityCls, severityCounts, severityKey,
} from '../utils/bugStatus'

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

describe('严重程度等级纯函数', () => {
  const bugs = [
    { severity: SEV_HIGH }, { severity: SEV_MEDIUM }, { severity: SEV_MEDIUM },
    { severity: SEV_LOW }, { severity: SEV_NONE }, { severity: '紧急' }, {},
  ]

  it('canonical 常量运行时值 = 后端下发的中文值（转义写法只影响源码书写）', () => {
    expect(SEV_HIGH).toBe('高')
    expect(SEV_MEDIUM).toBe('中')
    expect(SEV_LOW).toBe('低')
    expect(SEV_NONE).toBe('')
  })

  it('severityKey/severityCls：三档 canonical 直通，未知值归「未分级」', () => {
    expect(severityKey(SEV_HIGH)).toBe('高')
    expect(severityKey('紧急')).toBe('')
    expect(severityKey(undefined)).toBe('')
    expect(severityCls(SEV_HIGH)).toBe('high')
    expect(severityCls(SEV_MEDIUM)).toBe('medium')
    expect(severityCls(SEV_LOW)).toBe('low')
    expect(severityCls(SEV_NONE)).toBe('none')
    expect(severityCls('紧急')).toBe('none')
  })

  it('severityCounts：按四档 + all 汇总（未知/缺字段计入 none）', () => {
    expect(severityCounts(bugs)).toEqual({ all: 7, high: 1, medium: 2, low: 1, none: 3 })
    expect(severityCounts([])).toEqual({ all: 0, high: 0, medium: 0, low: 0, none: 0 })
    expect(severityCounts(undefined)).toEqual({ all: 0, high: 0, medium: 0, low: 0, none: 0 })
  })

  it('filterBugsBySeverity：all/四档筛选；all 也返回副本（不改原数组）', () => {
    expect(filterBugsBySeverity(bugs, SEV_FILTER_ALL).length).toBe(7)
    expect(filterBugsBySeverity(bugs, SEV_FILTER_ALL)).not.toBe(bugs)
    expect(filterBugsBySeverity(bugs, 'high').map((b) => b.severity)).toEqual(['高'])
    expect(filterBugsBySeverity(bugs, 'medium').length).toBe(2)
    expect(filterBugsBySeverity(bugs, 'low').length).toBe(1)
    expect(filterBugsBySeverity(bugs, 'none').map((b) => b.severity)).toEqual(['', '紧急', undefined])
    expect(filterBugsBySeverity(undefined, 'high')).toEqual([])
  })
})
