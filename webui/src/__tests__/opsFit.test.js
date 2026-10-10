// utils/opsFit.js 单测（2026-10-10 批次「先收文字、后折行」）。
// jsdom 不做布局，所以这里用 defineProperty 伪造 scrollWidth/clientWidth——
// 顺带在 getter 里记录「读取那一刻」的 DOM 状态，用来钉住两个不变量：
//   ① 读取时整块看板处于量测态（关折行），否则量不到单行溢出量；
//   ② 读取时该行已退回文字态（摘掉上一轮的 is-compact），否则收档态会自我固化。
import { describe, expect, it } from 'vitest'

import { syncOpsFit, OPS_COMPACT_EPS } from '../utils/opsFit'

// 造一个「看板列容器 + N 个操作行」的 DOM；每行按给定溢出量配置 scrollWidth
function build(rows, log = null) {
  const root = document.createElement('div')
  root.className = 'board-cols'
  const els = rows.map(({ overflow, clientWidth = 200, preset = false }) => {
    const el = document.createElement('div')
    el.className = 'board-card-ops'
    if (preset) el.classList.add('is-compact')
    Object.defineProperty(el, 'clientWidth', { get: () => clientWidth, configurable: true })
    Object.defineProperty(el, 'scrollWidth', {
      configurable: true,
      get: () => {
        log?.push({
          measuring: root.classList.contains('board-ops-measure'),
          compact: el.classList.contains('is-compact'),
        })
        return clientWidth + overflow
      },
    })
    root.appendChild(el)
    return el
  })
  return { root, els }
}

describe('opsFit：操作行「先收文字、后折行」定档', () => {
  it('文字态放得下的行不收档，放不下的行收档（同一批里按行分别判定）', () => {
    const { root, els } = build([{ overflow: 0 }, { overflow: 55 }, { overflow: -30 }])
    const r = syncOpsFit(root)
    expect(r).toEqual({ total: 3, compacted: 1 })
    expect(els[0].classList.contains('is-compact')).toBe(false)
    expect(els[1].classList.contains('is-compact')).toBe(true)
    expect(els[2].classList.contains('is-compact')).toBe(false)
  })

  it('亚像素容差：溢出量不超过 OPS_COMPACT_EPS 不收档，超过才收', () => {
    const { root, els } = build([{ overflow: OPS_COMPACT_EPS }, { overflow: OPS_COMPACT_EPS + 1 }])
    syncOpsFit(root)
    expect(els[0].classList.contains('is-compact')).toBe(false)
    expect(els[1].classList.contains('is-compact')).toBe(true)
  })

  it('读取时处于量测态、且行已退回文字态（防收档自我固化），量完撤掉量测态', () => {
    const log = []
    const { root, els } = build([{ overflow: 12, preset: true }], log)
    syncOpsFit(root)
    expect(log).toEqual([{ measuring: true, compact: false }])  // 读取时：量测态 + 已复位
    expect(root.classList.contains('board-ops-measure')).toBe(false)
    expect(els[0].classList.contains('is-compact')).toBe(true)
  })

  it('尺寸变化后重新放得下 ⇒ 摘掉收档（可逆，不残留）', () => {
    const { root, els } = build([{ overflow: 12 }])
    syncOpsFit(root)
    expect(els[0].classList.contains('is-compact')).toBe(true)
    Object.defineProperty(els[0], 'scrollWidth', { get: () => 180, configurable: true })  // 列变宽/按钮变少
    const r = syncOpsFit(root)
    expect(r.compacted).toBe(0)
    expect(els[0].classList.contains('is-compact')).toBe(false)
  })

  it('没有操作行（空看板/无卡片）⇒ 原样返回且不留量测态', () => {
    const { root } = build([])
    expect(syncOpsFit(root)).toEqual({ total: 0, compacted: 0 })
    expect(root.classList.contains('board-ops-measure')).toBe(false)
  })

  it('root 为空/非元素 ⇒ 不抛错，空结果', () => {
    expect(syncOpsFit(null)).toEqual({ total: 0, compacted: 0 })
    expect(syncOpsFit(undefined)).toEqual({ total: 0, compacted: 0 })
    expect(syncOpsFit({})).toEqual({ total: 0, compacted: 0 })
  })
})
