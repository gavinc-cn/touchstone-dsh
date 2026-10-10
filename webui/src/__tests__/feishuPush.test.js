// utils/feishuPush.js 单测：设置页飞书区「推送总控」的取值/下发/状态文案。
// 关键不变量（2026-10-10「飞书推送总控 + 按类别开关」批次）：
// - 服务端没回 push_enabled（存量配置/旧后端）⇒ 按**开**处理，页面不能静默把用户停掉
// - push_enabled 与旧 enabled 是两个独立开关（后者只管默认 webhook 回落），互不牵连
// - 只有用户动过复选框才在保存时下发该键（缺省=不改，与卡内其他字段同口径）
import { describe, expect, it } from 'vitest'

import {
  buildCfgBody, isPushEnabled, pushStatusText, withPushEnabled,
} from '../utils/feishuPush'

describe('isPushEnabled', () => {
  it('缺键/undefined/null ⇒ 开（存量配置升级后行为不变）', () => {
    expect(isPushEnabled({})).toBe(true)
    expect(isPushEnabled({ app_id: 'cli_x' })).toBe(true)
    expect(isPushEnabled({ push_enabled: undefined })).toBe(true)
    expect(isPushEnabled({ push_enabled: null })).toBe(true)
    expect(isPushEnabled(null)).toBe(true)
  })

  it('显式假值 ⇒ 关（0 / false 两种写法都算）', () => {
    expect(isPushEnabled({ push_enabled: 0 })).toBe(false)
    expect(isPushEnabled({ push_enabled: false })).toBe(false)
  })

  it('与旧 enabled 互不牵连', () => {
    expect(isPushEnabled({ enabled: 0 })).toBe(true)         // 旧键关，新总控仍开
    expect(isPushEnabled({ enabled: 1, push_enabled: 0 })).toBe(false)
  })
})

describe('withPushEnabled', () => {
  it('不改动其他字段（含旧 enabled）', () => {
    const cfg = { enabled: 1, base_url: 'http://x', app_id: 'cli_x' }
    expect(withPushEnabled(cfg, false)).toEqual({
      enabled: 1, base_url: 'http://x', app_id: 'cli_x', push_enabled: 0,
    })
    expect(withPushEnabled(cfg, true).push_enabled).toBe(1)
  })

  it('cfg 为 null 时不炸', () => {
    expect(withPushEnabled(null, false)).toEqual({ push_enabled: 0 })
  })
})

describe('buildCfgBody', () => {
  it('总控键随保存下发（1/0 与后端 save_user_config 的布尔化口径一致）', () => {
    expect(buildCfgBody({ push_enabled: 0 }).push_enabled).toBe(false)
    expect(buildCfgBody({ push_enabled: 1 }).push_enabled).toBe(true)
  })

  it('同时带上旧 enabled 与其他字段（保存配置是整卡提交）', () => {
    const body = buildCfgBody({ enabled: 1, push_enabled: 0, base_url: ' http://x ',
                                app_id: ' cli_x ' })
    expect(body).toEqual({
      enabled: true, push_enabled: false, base_url: 'http://x', app_id: 'cli_x',
    })
  })

  it('cfg 为 null ⇒ 全默认（enabled 关、总控开），不抛异常', () => {
    expect(buildCfgBody(null)).toEqual({
      enabled: false, push_enabled: true, base_url: '', app_id: '',
    })
  })
})

describe('pushStatusText', () => {
  it('开/关两种文案，且点明「用户主动询问不受影响」', () => {
    expect(pushStatusText({ push_enabled: 1 })).toContain('推送中')
    const off = pushStatusText({ push_enabled: 0 })
    expect(off).toContain('已停止')
    expect(off).toContain('不受影响')
  })
})
