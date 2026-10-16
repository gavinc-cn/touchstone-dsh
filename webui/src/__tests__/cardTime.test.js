// utils/cardTime.js 单测（2026-10-10 批次）：卡面「最后更新时间」的展示派生。
//
// 需求（用户原文）：**看板卡片上应该显示一个最后更新时间**。
// 口径（用户拍板 A）：时间源=服务端 `board_cards.updated_at`（卡片行最后被改写的时刻，
// 即「这张卡多久没被改动过」；agent 在会话里干活不刷它）——由后端换算成毫秒 epoch
// `updated_at_ts` 下发（服务器本地时间解释，见 board.card_ts_ms），前端只做展示。
//
// 本文件只测纯函数：相对时间分档、绝对时间格式、坏值降级。
// 与运行环境时区无关的写法：跨档/跨年用例都用 `new Date(ts)` 现算期望值。
import { describe, expect, it } from 'vitest'

import { cardTimeLabel, cardTimeTitle, fmtFull, timeAgo } from '../utils/cardTime'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T = Date.parse('2026-10-10T21:46:41Z')   // 基准时刻（毫秒 epoch）
const pad = (n) => String(n).padStart(2, '0')

describe('cardTime.timeAgo：相对时间分档', () => {
  it('60 秒内 ⇒ 刚刚（含恰好 0 秒）', () => {
    expect(timeAgo(T, T)).toBe('刚刚')
    expect(timeAgo(T, T + 59 * 1000)).toBe('刚刚')
  })

  it('恰好 60 秒 ⇒ 1 分钟前（档位左闭右开，不出现「0 分钟前」）', () => {
    expect(timeAgo(T, T + MIN)).toBe('1 分钟前')
    expect(timeAgo(T, T + 59 * MIN + 59 * 1000)).toBe('59 分钟前')
  })

  it('满 60 分钟 ⇒ N 小时前，直到 24 小时', () => {
    expect(timeAgo(T, T + HOUR)).toBe('1 小时前')
    expect(timeAgo(T, T + 23 * HOUR + 59 * MIN)).toBe('23 小时前')
  })

  it('满 24 小时 ⇒ N 天前，直到 7 天', () => {
    expect(timeAgo(T, T + DAY)).toBe('1 天前')
    expect(timeAgo(T, T + 7 * DAY - 1)).toBe('6 天前')
  })

  it('满 7 天 ⇒ 绝对日期 MM-DD（同年，按本地时区取日）', () => {
    const d = new Date(T)
    expect(timeAgo(T, T + 7 * DAY)).toBe(`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    // 同年内的更远时刻（T=2026-10-10，+60 天仍落 2026 年）同样只给月-日
    expect(timeAgo(T, T + 60 * DAY)).toBe(`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  })

  it('跨年（ts 与 now 不同年）⇒ 带年份 YYYY-MM-DD', () => {
    const d = new Date(T)
    expect(timeAgo(T, T + 400 * DAY)).toBe(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  })

  it('未来时间（两端时钟偏差）按「刚刚」处理，不出现负号', () => {
    expect(timeAgo(T + 10 * MIN, T)).toBe('刚刚')
  })

  it('缺失/非数值（null/undefined/NaN/字符串）⇒ 空串（调用方不渲染）', () => {
    expect(timeAgo(null, T)).toBe('')
    expect(timeAgo(undefined, T)).toBe('')
    expect(timeAgo(NaN, T)).toBe('')
    expect(timeAgo('2026-10-10 21:46:41', T)).toBe('')
    expect(timeAgo(Infinity, T)).toBe('')
  })
})

describe('cardTime.fmtFull：精确时间（悬浮提示用）', () => {
  it('格式为 YYYY-MM-DD HH:mm:ss（本地时区、补零）', () => {
    const s = fmtFull(T)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('本地时刻与时间戳同刻：原样解析回去等于原时刻（秒精度）', () => {
    const back = new Date(fmtFull(T).replace(' ', 'T')).getTime()
    expect(back).toBe(Math.floor(T / 1000) * 1000)
  })

  it('缺失/非数值 ⇒ 空串', () => {
    expect(fmtFull(null)).toBe('')
    expect(fmtFull(undefined)).toBe('')
    expect(fmtFull('x')).toBe('')
  })
})

describe('cardTime：卡片级封装（读服务端 updated_at_ts）', () => {
  it('cardTimeLabel 透传相对时间；无字段/坏值 ⇒ 空串', () => {
    expect(cardTimeLabel({ updated_at_ts: T }, T + 3 * MIN)).toBe('3 分钟前')
    expect(cardTimeLabel({ updated_at_ts: null }, T)).toBe('')
    expect(cardTimeLabel({}, T)).toBe('')
    expect(cardTimeLabel(null, T)).toBe('')
  })

  it('cardTimeTitle = 「最后更新：<精确时间>」；无字段 ⇒ 空串（不挂空 title）', () => {
    expect(cardTimeTitle({ updated_at_ts: T })).toBe(`最后更新：${fmtFull(T)}`)
    expect(cardTimeTitle({ updated_at_ts: null })).toBe('')
    expect(cardTimeTitle({})).toBe('')
    expect(cardTimeTitle(null)).toBe('')
  })
})
