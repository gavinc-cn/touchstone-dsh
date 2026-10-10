// utils/sessionGroups.js 单测（2026-10-10 批次：会话详情页工具调用默认折起）
//
// 覆盖三件事：
//   1. buildRows      —— entries → 展示行（连续 ≥2 条「过程条目」合成一个 proc 组）
//   2. rowIndexOf     —— 任意条目 seq → 所属展示行下标（提问索引跳转落点用；目标可能落在组内）
//   3. summarizeProc  —— 组摘要文案（工具次数/名称去重保序带 ×N/思考段数/错误次数）+ 错误标记
//
// 真数据出处：dsh 会话存储的事件流解析出的 entry 模型（sessparse.py 头注释）：
//   user / assistant / think / tool_call{name,args,call_id} / tool_result{call_id,name,text,is_error,truncated}
// 这里按真实形态造数据：一次工具调用后紧跟它的结果，思考条目夹在中间。
import { describe, expect, it } from 'vitest'

import { buildRows, summarizeProc } from '../utils/sessionGroups'

/** 造一条 entry（只带被测逻辑关心的字段） */
function ent(seq, kind, extra = {}) {
  return { seq, kind, ...extra }
}
/** 造一条工具调用 + 其结果（真实会话里成对出现） */
function pair(seq, name, { error = false } = {}) {
  return [
    ent(seq, 'tool_call', { name, args: '{"a":1}', call_id: 'c' + seq }),
    ent(seq + 1, 'tool_result', { name, call_id: 'c' + seq, text: 'ok', is_error: error }),
  ]
}

describe('sessionGroups：buildRows 分组规则', () => {
  it('连续的过程条目（思考+调用+结果）合成一个 proc 行，seq 取组内首条', () => {
    const entries = [ent(0, 'think', { text: '想一下' }), ...pair(1, 'bash')]
    const { rows } = buildRows(entries)
    expect(rows).toHaveLength(1)
    expect(rows[0].proc).toBe(true)
    expect(rows[0].seq).toBe(0)
    expect(rows[0].items.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('单独一条过程条目不分组（保持现状：如思考单条、结果还没回来的调用）', () => {
    const entries = [ent(0, 'think', { text: '想一下' }), ent(1, 'user', { text: '你好' })]
    const { rows } = buildRows(entries)
    expect(rows.map((r) => [r.seq, r.proc, r.items.length]))
      .toEqual([[0, false, 1], [1, false, 1]])
  })

  it('助手正文打断分组：前后两段过程各自成组', () => {
    const entries = [
      ...pair(0, 'bash'),
      ent(2, 'assistant', { text: '看到结果了' }),
      ...pair(3, 'read_image'),
    ]
    const { rows } = buildRows(entries)
    expect(rows.map((r) => [r.seq, r.proc])).toEqual([[0, true], [2, false], [3, true]])
  })

  it('用户提问打断分组，且提问自身是单行', () => {
    const entries = [...pair(0, 'bash'), ent(2, 'user', { text: '继续' }), ...pair(3, 'bash')]
    const { rows } = buildRows(entries)
    expect(rows.map((r) => [r.seq, r.proc, r.items.length])).toEqual([[0, true, 2], [2, false, 1], [3, true, 2]])
  })

  it('组内全是思考条目也能成组（≥2 条即收）', () => {
    const entries = [ent(0, 'think', { text: 'a' }), ent(1, 'think', { text: 'b' })]
    const { rows } = buildRows(entries)
    expect(rows).toHaveLength(1)
    expect(rows[0].proc).toBe(true)
  })

  it('空列表 → 空行集与空映射（不抛）', () => {
    const { rows, rowIndexOf } = buildRows([])
    expect(rows).toEqual([])
    expect(rowIndexOf.size).toBe(0)
  })

  it('未识别的 kind（usage/error/divider 兜底分支）各自成单行并打断分组', () => {
    const entries = [...pair(0, 'bash'), ent(2, 'divider', { text: '压缩' }), ...pair(3, 'bash')]
    const { rows } = buildRows(entries)
    expect(rows.map((r) => [r.seq, r.proc])).toEqual([[0, true], [2, false], [3, true]])
  })
})

describe('sessionGroups：rowIndexOf 跳转映射', () => {
  it('组内任意条目 seq 都映射到该组行下标；单行条目映射自身', () => {
    const entries = [
      ...pair(0, 'bash'),                       // 行 0（proc 组：seq 0..1）
      ent(2, 'user', { text: '继续' }),          // 行 1
      ...pair(3, 'skill'),                      // 行 2（proc 组：seq 3..4）
    ]
    const { rowIndexOf } = buildRows(entries)
    expect([0, 1, 2, 3, 4].map((s) => rowIndexOf.get(s))).toEqual([0, 0, 1, 2, 2])
    expect(rowIndexOf.get(99)).toBeUndefined()
  })

  it('行 key 唯一（组随流增长时身份稳定：key 取组内首条 seq）', () => {
    const { rows } = buildRows([...pair(5, 'bash'), ent(7, 'user', { text: 'hi' })])
    const keys = rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['r5', 'r7'])
  })
})

describe('sessionGroups：summarizeProc 摘要与错误标记', () => {
  it('工具次数 + 名称去重保序带 ×N + 思考段数', () => {
    const items = [
      ent(0, 'think', { text: '想' }),
      ...pair(1, 'bash'),
      ...pair(3, 'bash'),
      ...pair(5, 'skill'),
    ]
    const s = summarizeProc(items)
    expect(s.text).toBe('工具 3 次 · bash ×2, skill · 思考 1 段')
    expect(s.calls).toBe(3)
    expect(s.thinks).toBe(1)
    expect(s.errors).toBe(0)
  })

  it('结果报错时进摘要并置错误标记（错误不被静默埋掉）', () => {
    const items = [...pair(0, 'bash', { error: true }), ...pair(2, 'bash')]
    const s = summarizeProc(items)
    expect(s.text).toBe('工具 2 次 · bash ×2 · 错误 1 次')
    expect(s.errors).toBe(1)
  })

  it('只有思考的组：只出思考段数', () => {
    const s = summarizeProc([ent(0, 'think', { text: 'a' }), ent(1, 'think', { text: 'b' })])
    expect(s.text).toBe('思考 2 段')
  })

  it('无正文的思考条目不计数（渲染层对空思考返回 null，摘要也不该虚报）', () => {
    const items = [ent(0, 'think', { text: '   ' }), ...pair(1, 'bash')]
    expect(summarizeProc(items).text).toBe('工具 1 次 · bash')
  })

  it('只有结果没有调用（异常形态）时用结果里的工具名兜底', () => {
    const items = [ent(0, 'tool_result', { name: 'bash', text: 'ok' }),
      ent(1, 'tool_result', { name: 'bash', text: 'ok2' })]
    expect(summarizeProc(items).text).toBe('bash ×2')
  })

  it('工具名过长时按段截断并加省略号（摘要行不撑爆）', () => {
    const items = [...pair(0, 'a'.repeat(30)), ...pair(2, 'b'.repeat(30)), ...pair(4, 'c'.repeat(30))]
    const s = summarizeProc(items)
    // 首个名称 30 字符已占满预算（60），后续段整体省略为「, …」
    expect(s.text).toBe('工具 3 次 · ' + 'a'.repeat(30) + ', …')
    expect(s.text.length).toBeLessThan(80)
  })

  it('工具名为空时用「工具」兜底', () => {
    const items = [ent(0, 'tool_call', { name: '' }), ent(1, 'tool_result', { text: 'ok' })]
    expect(summarizeProc(items).text).toBe('工具 1 次 · 工具')
  })
})
