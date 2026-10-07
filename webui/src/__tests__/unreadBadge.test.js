// utils/unreadBadge.js 单测（2026-10-07 批次）：卡片「有更新」药丸的展示派生。
// 需求（用户原文）：**已完成队列不要显示「有更新」这个标识**。
// 口径：unread 字段（服务端权威）仍按「平台/agent 搬过列且用户未打开」置位，
// 本层只决定卡面渲不渲染——已完成列（done）一律不渲染，其余列照旧看 unread。
import { describe, expect, it } from 'vitest'

import { showUnreadBadge } from '../utils/unreadBadge'

describe('unreadBadge：已完成列不显示「有更新」', () => {
  it('done + unread=true ⇒ 不渲染', () => {
    expect(showUnreadBadge({ column: 'done', unread: true })).toBe(false)
  })

  it('其余四列 + unread=true ⇒ 渲染（todo / doing / blocked / review）', () => {
    for (const column of ['todo', 'doing', 'blocked', 'review']) {
      expect(showUnreadBadge({ column, unread: true })).toBe(true)
    }
  })

  it('无标记（false/0/undefined/null/空卡）⇒ 一律不渲染', () => {
    expect(showUnreadBadge({ column: 'review', unread: false })).toBe(false)
    expect(showUnreadBadge({ column: 'review', unread: 0 })).toBe(false)
    expect(showUnreadBadge({ column: 'review', unread: undefined })).toBe(false)
    expect(showUnreadBadge({ column: 'review', unread: null })).toBe(false)
    expect(showUnreadBadge({ column: 'done' })).toBe(false)
    expect(showUnreadBadge({})).toBe(false)
  })

  it('unread 为 1（DB 原值形态透传的退化输入）⇒ 仍按真值渲染', () => {
    expect(showUnreadBadge({ column: 'doing', unread: 1 })).toBe(true)
  })

  it('未知/缺失列按「显示」处理：只有确证是 done 才藏（防服务端新增列前滚击穿旧前端）', () => {
    expect(showUnreadBadge({ column: 'archived', unread: true })).toBe(true)
    expect(showUnreadBadge({ unread: true })).toBe(true)
  })
})
