// utils/media.js 单测：占位图拦截判定（isPlaceholderImage）
// 背景：剪贴板里的极小 PNG（1x1 透明、2x2 纯色，tmp_*.png 等来源应用给的占位图）
// 曾在看板描述、会话 composer 与快速添加框无感知贴出空白附件；上传前按
// 「PNG 魔数 + IHDR 宽高均 ≤ 4」拦截（2026-09-19 起由「仅 1x1」放宽）。
// 覆盖分支：命中（含边界）/ 正常尺寸 / 非 PNG 与非图片类型 / 头部字节不足 / 读取异常。
import { describe, expect, it } from 'vitest'

import { isPlaceholderImage } from '../utils/media'

// 构造最小 PNG 头部 24 字节：8 字节魔数 + IHDR 长度(4) + 'IHDR'(4) + 宽(4) + 高(4)
// （宽高按大端写入，正是实现里 head[16..19]/head[20..23] 读取的位置）
function pngHeader(width, height) {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // PNG 魔数
  b.set([0x00, 0x00, 0x00, 0x0d], 8) // IHDR 数据长度 13
  b.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  const dv = new DataView(b.buffer)
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  return b
}

function pngFile(width, height, type = 'image/png') {
  return new File([pngHeader(width, height)], 'shot.png', { type })
}

describe('isPlaceholderImage', () => {
  it('极小尺寸 PNG 判为占位图（1x1 与 2x2 两代实测占位图）', async () => {
    expect(await isPlaceholderImage(pngFile(1, 1))).toBe(true) // 1x1 透明（2026-09-06 实测）
    expect(await isPlaceholderImage(pngFile(2, 2))).toBe(true) // 2x2 纯色（2026-09-19 实测）
    expect(await isPlaceholderImage(pngFile(1, 2))).toBe(true) // 极扁/极窄同样按占位图拦
  })

  it('尺寸边界：宽高均 ≤ 4 拦，超过即放行', async () => {
    expect(await isPlaceholderImage(pngFile(4, 4))).toBe(true)
    expect(await isPlaceholderImage(pngFile(5, 5))).toBe(false)
    expect(await isPlaceholderImage(pngFile(4, 5))).toBe(false) // 仅一维超限即放行
  })

  it('正常尺寸的 PNG 不判占位图', async () => {
    expect(await isPlaceholderImage(pngFile(16, 16))).toBe(false) // e2e 会话上传用例用的 16x16
    expect(await isPlaceholderImage(pngFile(1920, 1080))).toBe(false)
  })

  it('非 PNG 魔数或非图片类型一律不判占位图', async () => {
    // JPEG 魔数（ff d8 ff e0）但声明 image/jpeg
    const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Uint8Array(20)])],
      'a.jpg', { type: 'image/jpeg' })
    expect(await isPlaceholderImage(jpeg)).toBe(false)
    // PNG 字节但类型不是 image/*
    expect(await isPlaceholderImage(new File([pngHeader(1, 1)], 'a.bin', { type: 'application/octet-stream' }))).toBe(false)
    // 无 type（老浏览器/自定义构造）
    expect(await isPlaceholderImage({ type: '', slice: () => ({}) })).toBe(false)
  })

  it('头部字节不足 24 时放行（无法读出 IHDR 尺寸）', async () => {
    const short = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(await isPlaceholderImage(new File([short], 'tiny.png', { type: 'image/png' }))).toBe(false)
  })

  it('读取失败不拦（照常上传，由既有错误提示兜底）', async () => {
    const broken = { type: 'image/png', slice: () => { throw new Error('read failed') } }
    expect(await isPlaceholderImage(broken)).toBe(false)
  })
})
