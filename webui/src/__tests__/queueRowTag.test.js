// utils/queueRowTag.js 单测：会话输入区上方「排队消息行」的 tag 文案映射。
// 三路来源（P6 分离，渲染在 ComposerBar）：server=dsh 宿主 inbox 排队行 /
// running=平台消息单元已交给会话（等 turn 结束）/ 其余=平台排队中。
// 2026-10-22 用户报：running 行此前标「发送中」——消息其实已经交给 agent，
// 看着像还在发送；文案定稿改「已发送」。
import { beforeEach, describe, expect, it } from 'vitest'

import { queueRowTag } from '../utils/queueRowTag'

import { setLang } from '../utils/i18n'
// 文案断言按中文跑（zh 直接返回中文 key）
beforeEach(() => setLang('zh'))

describe('queueRowTag：排队消息行 tag 文案', () => {
  it('running = 已发送（消息已交给会话，等 turn 结束；不再叫「发送中」）', () => {
    expect(queueRowTag('running')).toBe('已发送')
  })

  it('server = 服务端排队（dsh 宿主 inbox 排队行，不可注入/不可取消）', () => {
    expect(queueRowTag('server')).toBe('服务端排队')
  })

  it('queued / pending / 未知状态 = 排队中（平台排队行与本地乐观 chip）', () => {
    expect(queueRowTag('queued')).toBe('排队中')
    expect(queueRowTag('pending')).toBe('排队中')
    expect(queueRowTag('')).toBe('排队中')
    expect(queueRowTag(undefined)).toBe('排队中')
  })
})
