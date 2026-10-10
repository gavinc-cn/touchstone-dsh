// 会话归属（外部会话提示条 / 「停止」置灰）纯函数单测（C 批 T8，2026-10-10）。
//
// 口径来源＝后端会话 meta 的三态 `owned`（server._session_owned）：
//   true        = 平台自持（驱动池内会话）→ 现状渲染；
//   false       = 外部会话（用户在 dsh GUI 里直跑/接管）→ 提示条 + 停止置灰；
//   null/未下发 = 注册表未知（未连接/未对齐/没见过该 sid）→ **按池内渲染**，
//                 与现状一致（未知 ≠ 外部：绝不据未知反向推断成外部会话）。
import { describe, expect, it } from 'vitest'
import { OWNED_EXTERNAL_HINT, canStop, ownedHint } from '../utils/sessionOwned'

describe('ownedHint（提示条文案）', () => {
  it('外部会话（owned=false）给提示：文案含「外部会话」并说明平台停不了它', () => {
    const t = ownedHint(false)
    expect(t).toContain('外部会话')
    expect(t).toContain('dsh GUI')          // 说清是谁在跑（不是平台启动的）
    expect(t).toContain('停止')             // 说清后果（停止/中断对它无效）
  })

  it('池内会话（owned=true）不提示', () => {
    expect(ownedHint(true)).toBe('')
  })

  it('注册表未知（null/undefined）不提示——未知 ≠ 外部，按池内渲染', () => {
    expect(ownedHint(null)).toBe('')
    expect(ownedHint(undefined)).toBe('')
    expect(ownedHint()).toBe('')
  })

  it('提示文案只有一处出处（常量即返回值，防两处措辞漂移）', () => {
    expect(ownedHint(false)).toBe(OWNED_EXTERNAL_HINT)
  })
})

describe('canStop（「停止」按钮可否点）', () => {
  it('外部会话不可停（按钮置灰）', () => {
    expect(canStop(false)).toBe(false)
  })

  it('池内会话可停（现状不变）', () => {
    expect(canStop(true)).toBe(true)
  })

  it('注册表未知按池内渲染：可停（与现状一致）', () => {
    expect(canStop(null)).toBe(true)
    expect(canStop(undefined)).toBe(true)
  })
})
