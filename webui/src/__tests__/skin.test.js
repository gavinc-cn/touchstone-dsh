// utils/skin.js 单测：皮肤（<html data-skin>）读写与切换 + 「跟随 DSH」档位解析
//
// 契约：
//   - 皮肤注册表 4 套：dsh-dark / dsh-light / starlight / classic（DSH 家族在前）
//   - 偏好值是「选择」而非「结果」：'auto' 表示跟随 DSH 宿主明暗，其余是具体皮肤 id
//   - 未存过偏好时：嵌在宿主里（插件形态）默认 'auto'，独立打开默认 'dsh-dark'
//   - applySkin 把**解析后**的具体皮肤写 data-skin，把**原始选择**写 localStorage
//   - 选择为 auto 时 initSkin 订阅宿主明暗变化并实时重应用
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 宿主明暗探测是外部边界：这里打桩，只验 skin.js 的解析与订阅接线
const theme = vi.hoisted(() => ({ dark: true, subs: new Set() }))
vi.mock('../utils/dshTheme', () => ({
  hostDocument: () => ({ body: null }),
  readHostDark: () => null,
  prefersDark: () => theme.dark,
  resolveDark: () => theme.dark,
  subscribeHostTheme: (cb) => { theme.subs.add(cb); return () => { theme.subs.delete(cb) } },
}))

const { AUTO, SKINS, applySkin, currentChoice, getSkin, initSkin, nextSkin, resolveSkin, skinLabel } =
  await import('../utils/skin')

/** 模拟宿主明暗翻转：改桩值并通知所有订阅者（与真实订阅契约一致）。 */
function flipHost(dark) {
  theme.dark = dark
  for (const cb of [...theme.subs]) cb(dark)
}

beforeEach(() => {
  // 先走真实 API 让模块释放上一用例可能残留的跟随订阅（不要越过模块去清桩里的 Set：
  // 模块内的 unsubFollow 与桩的 Set 必须同源，否则「已订阅」短路会让用例假绿/假红）
  applySkin('classic')
  localStorage.clear()
  delete document.documentElement.dataset.skin
  theme.dark = true
})

describe('skin', () => {
  it('getSkin：无持久值回落默认（测试环境非嵌入 ⇒ dsh-dark），合法值回读（含 auto），非法值回落', () => {
    expect(getSkin()).toBe('dsh-dark')
    localStorage.setItem('ts_skin', 'classic')
    expect(getSkin()).toBe('classic')
    localStorage.setItem('ts_skin', AUTO)
    expect(getSkin()).toBe(AUTO)
    localStorage.setItem('ts_skin', 'no-such-skin')
    expect(getSkin()).toBe('dsh-dark')
  })

  it('resolveSkin：auto 按宿主明暗解析到 dsh 两套皮肤，其余原样返回', () => {
    expect(resolveSkin(AUTO, true)).toBe('dsh-dark')
    expect(resolveSkin(AUTO, false)).toBe('dsh-light')
    expect(resolveSkin('classic', true)).toBe('classic')
    expect(resolveSkin('starlight', false)).toBe('starlight')
  })

  it('applySkin 写 data-skin(解析后) 与 localStorage(原始选择)；initSkin 按持久化值应用', () => {
    applySkin('classic')
    expect(document.documentElement.dataset.skin).toBe('classic')
    expect(localStorage.getItem('ts_skin')).toBe('classic')

    delete document.documentElement.dataset.skin
    initSkin()
    expect(document.documentElement.dataset.skin).toBe('classic') // 刷新后保持

    localStorage.clear()
    initSkin()
    expect(document.documentElement.dataset.skin).toBe('dsh-dark') // 清空后回落默认

    // auto 档：落库的是选择本身，落到 DOM 的是解析结果
    document.documentElement.dataset.skin = ''
    localStorage.setItem('ts_skin', AUTO)
    theme.dark = false
    initSkin()
    expect(localStorage.getItem('ts_skin')).toBe(AUTO)
    expect(document.documentElement.dataset.skin).toBe('dsh-light')
  })

  it('currentChoice：返回当前选择（auto 原样返回），非法值回落默认', () => {
    localStorage.setItem('ts_skin', AUTO)
    expect(currentChoice()).toBe(AUTO)
    localStorage.setItem('ts_skin', 'no-such-skin')
    expect(currentChoice()).toBe('dsh-dark')
  })

  it('选择 auto 时 initSkin 订阅宿主明暗：翻转即重应用皮肤，且不覆盖用户选择', () => {
    localStorage.setItem('ts_skin', AUTO)
    initSkin()
    expect(theme.subs.size).toBe(1)
    expect(document.documentElement.dataset.skin).toBe('dsh-dark')

    flipHost(false)
    expect(document.documentElement.dataset.skin).toBe('dsh-light')
    expect(localStorage.getItem('ts_skin')).toBe(AUTO) // 跟随不写回具体皮肤

    flipHost(true)
    expect(document.documentElement.dataset.skin).toBe('dsh-dark')
  })

  it('选择具体皮肤时 initSkin 不订阅（手动选择不接受宿主覆盖）', () => {
    localStorage.setItem('ts_skin', 'classic')
    initSkin()
    expect(theme.subs.size).toBe(0)
    expect(document.documentElement.dataset.skin).toBe('classic')
  })

  it('从 auto 切到具体皮肤会退订（不残留监听）', () => {
    localStorage.setItem('ts_skin', AUTO)
    initSkin()
    expect(theme.subs.size).toBe(1)
    applySkin('classic')
    expect(theme.subs.size).toBe(0)
    flipHost(false)
    expect(document.documentElement.dataset.skin).toBe('classic')
  })

  it('nextSkin 循环切换（非法当前值从首项开始）、skinLabel 回落 id、SKINS 带色样', () => {
    expect(nextSkin('dsh-dark')).toBe('dsh-light')
    expect(nextSkin('dsh-light')).toBe('starlight')
    expect(nextSkin('starlight')).toBe('classic')
    expect(nextSkin('classic')).toBe('dsh-dark') // 环回
    expect(nextSkin('no-such-skin')).toBe('dsh-dark')
    expect(skinLabel('classic')).toBe('经典蓝')
    expect(skinLabel('dsh-dark')).toBe('DSH 深色')
    expect(skinLabel('dsh-light')).toBe('DSH 浅色')
    expect(skinLabel(AUTO)).toBe('跟随 DSH')
    expect(skinLabel('no-such-skin')).toBe('no-such-skin')
    expect(SKINS.map((s) => s.id)).toEqual(['dsh-dark', 'dsh-light', 'starlight', 'classic'])
    expect(SKINS.every((s) => s.preview.length === 2 && s.label)).toBe(true) // 设置页色样两格
  })
})
