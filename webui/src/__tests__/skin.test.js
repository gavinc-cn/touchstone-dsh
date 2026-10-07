// utils/skin.js 单测：皮肤（<html data-skin>）读写与切换
// getSkin 对非法/缺失 localStorage 值回落默认 starlight；applySkin 同时写 dataset 与
// localStorage；initSkin 在渲染前按持久化值应用（避免主题闪烁）。
import { beforeEach, describe, expect, it } from 'vitest'

import { SKINS, applySkin, getSkin, initSkin, nextSkin, skinLabel } from '../utils/skin'

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.skin
})

describe('skin', () => {
  it('getSkin：无持久值时默认 starlight，合法值回读，非法值回落', () => {
    expect(getSkin()).toBe('starlight')
    localStorage.setItem('ts_skin', 'classic')
    expect(getSkin()).toBe('classic')
    localStorage.setItem('ts_skin', 'no-such-skin')
    expect(getSkin()).toBe('starlight')
  })

  it('applySkin 写 data-skin 与 localStorage；initSkin 按持久化值应用', () => {
    applySkin('classic')
    expect(document.documentElement.dataset.skin).toBe('classic')
    expect(localStorage.getItem('ts_skin')).toBe('classic')

    delete document.documentElement.dataset.skin
    initSkin()
    expect(document.documentElement.dataset.skin).toBe('classic') // 刷新后保持

    localStorage.clear()
    initSkin()
    expect(document.documentElement.dataset.skin).toBe('starlight') // 清空后回落默认
  })

  it('nextSkin 循环切换（非法当前值从首项开始）、skinLabel 回落 id、SKINS 带色样', () => {
    expect(nextSkin('starlight')).toBe('classic')
    expect(nextSkin('classic')).toBe('starlight')
    expect(nextSkin('no-such-skin')).toBe('starlight')
    expect(skinLabel('classic')).toBe('经典蓝')
    expect(skinLabel('no-such-skin')).toBe('no-such-skin')
    expect(SKINS.map((s) => s.id)).toEqual(['starlight', 'classic'])
    expect(SKINS.every((s) => s.preview.length === 2 && s.label)).toBe(true) // 设置页色样两格
  })
})
