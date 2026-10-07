// 压测运行展示辅助单测（2026-10-06 复压批次）：状态标签与选择器文案规则。
import { describe, expect, it } from 'vitest'
import { RUN_STATUS, runKpiText, runLabel } from '../utils/loadRuns'

describe('loadRuns 运行选择器文案', () => {
  it('已登记运行：编号 + 开始时间（MM-DD HH:MM）+ 状态', () => {
    const r = { registered: true, status: 'done', started_at: '2026-10-06 14:00:00',
                run_key: '20261006_140000' }
    expect(runLabel(r, 0)).toBe('运行 #1 · 10-06 14:00 · 成功')
    expect(runLabel(r, 2)).toBe('运行 #3 · 10-06 14:00 · 成功')
  })

  it('孤儿报告（未登记）：不编号，状态回落「历史（未登记）」', () => {
    const r = { registered: false, status: 'unknown', started_at: '',
                run_key: '20261006_0117' }
    expect(runLabel(r, 0)).toBe('历史报告 · 20261006 0117 · 历史（未登记）')
  })

  it('状态兜底：未知状态码原样显示，字段缺失不抛异常', () => {
    expect(RUN_STATUS.interrupted).toBe('被中断')
    expect(runLabel({ registered: true, status: 'weird' }, 0)).toContain('weird')
    expect(runLabel(undefined, 0)).toContain('未知')
  })

  it('KPI 预览：最多 4 项，键值逗号拼接；无 KPI 返回空串', () => {
    expect(runKpiText({ kpi: { a: 1, b: 2, c: 3, d: 4, e: 5 } })).toBe('a=1  b=2  c=3  d=4')
    expect(runKpiText({})).toBe('')
    expect(runKpiText(null)).toBe('')
  })
})
