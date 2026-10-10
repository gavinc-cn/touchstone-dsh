// utils/feishuHook.js 单测：项目推送绑定的保存体构造、单项目/批量分派与回执文案。
// 关键不变量（2026-10-10「统一设置所有项目」批次）：
// - webhook/secret 留空 ⇒ **不带键**（后端缺省=不改 ⇒ 各项目保留原值）
// - 事件空数组照常下发（= 把事件全关掉，而不是"没改"）
// - applyAll 时不带 pid（批量端点写的是本人全部未归档项目）
import { describe, expect, it } from 'vitest'

import { applyResultText, buildHookBody, hookSaveRequest } from '../utils/feishuHook'

describe('buildHookBody', () => {
  it('enabled/events 恒下发，webhook 带值才下发（留空=保持各项目原值）', () => {
    const hook = { enabled: false, events: ['blocked_interaction'] }
    expect(buildHookBody(hook, {})).toEqual({
      enabled: false, events: ['blocked_interaction'],
    })
    expect(buildHookBody(hook, { webhook_url: '   ' })).toEqual({
      enabled: false, events: ['blocked_interaction'],
    })
    expect(buildHookBody(hook, { webhook_url: ' https://h/x ', webhook_secret: 'sec' }))
      .toEqual({
        enabled: false, events: ['blocked_interaction'],
        webhook_url: 'https://h/x', webhook_secret: 'sec',
      })
  })

  it('事件全不勾时下发空数组（表示关闭全部事件，而非"未修改"）', () => {
    expect(buildHookBody({ enabled: true, events: [] }, {})).toEqual({
      enabled: true, events: [],
    })
  })

  it('hook 缺省（加载中/空态）时按关闭+空事件兜底，不抛异常', () => {
    expect(buildHookBody(null, null)).toEqual({ enabled: false, events: [] })
  })
})

describe('hookSaveRequest', () => {
  it('未勾选批量 ⇒ 单项目请求（带 pid）', () => {
    const r = hookSaveRequest(false, 126, { enabled: true, events: ['task_failed'] }, {})
    expect(r.kind).toBe('one')
    expect(r.pid).toBe(126)
    expect(r.body.events).toEqual(['task_failed'])
  })

  it('勾选批量 ⇒ 批量请求（不带 pid，正文与单项目同口径）', () => {
    const r = hookSaveRequest(true, 126, { enabled: true, events: ['task_failed'] },
                              { webhook_url: 'https://h/y' })
    expect(r.kind).toBe('all')
    expect(r.pid).toBeUndefined()
    expect(r.body).toEqual({
      enabled: true, events: ['task_failed'], webhook_url: 'https://h/y',
    })
  })
})

describe('applyResultText', () => {
  it('列出写入项目数；有归档跳过时一并说明', () => {
    expect(applyResultText({ updated: 5, archived_skipped: 0 })).toBe('已应用到 5 个项目')
    expect(applyResultText({ updated: 5, archived_skipped: 2 }))
      .toBe('已应用到 5 个项目（跳过 2 个已归档）')
  })

  it('字段缺失/脏值时按 0 兜底，不出现 undefined', () => {
    expect(applyResultText(null)).toBe('已应用到 0 个项目')
    expect(applyResultText({})).toBe('已应用到 0 个项目')
  })
})
