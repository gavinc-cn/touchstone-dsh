// utils/mediaText.js 单测：本平台附件引用的寻址归一（markdown 渲染 + chip 缩略图共用）
// 语义：
//   ① `absToMedia`——markdown 引用里以 / 开头且尾段为 /board_media/<fid> 的落盘绝对路径
//      改写为媒体端点 URL；已是端点裸路径（/api/projects/<pid>/board/media/<fid>，看板详情
//      编辑框粘贴形态）也补上同源根前缀；其余引用原样保留。
//   ② `mediaDisplayUrl`——端点裸路径补同源根前缀（chip 缩略图直接用 server 回包 url）。
// 同源根（BASE）：独立形态=''（改写结果与旧行为逐字符一致）、dsh 插件形态='/touchstone'
// ——插件下裸 /api/... 打到 dsh 宿主根 401，图片不显示（2026-10-04 用户报障）。
// 安全红线：不以任意路径/URL 当媒体渲染——非本平台产物、fid 形态不符的都不动。
import { describe, expect, it } from 'vitest'

import { absToMedia, mediaDisplayUrl } from '../utils/mediaText'

const FID = 'm1757000000000_abcdef1234.png' // m<13 位毫秒>_<10 位 hex>.<ext>
const PLUGIN_BASE = '/touchstone'           // dsh 插件形态同源根

describe('absToMedia', () => {
  it('图片与链接引用中的落盘绝对路径改写为项目媒体端点', () => {
    expect(absToMedia(`![图](/srv/work/.touchstone/board_media/${FID})`, 7))
      .toBe(`![图](/api/projects/7/board/media/${FID})`)
    expect(absToMedia(`[report](/w/board_media/${FID})`, 7))
      .toBe(`[report](/api/projects/7/board/media/${FID})`)
  })

  it('非本平台产物路径与 fid 形态不符的引用原样保留', () => {
    expect(absToMedia('![a](/tmp/a.png)', 7)).toBe('![a](/tmp/a.png)')
    expect(absToMedia(`![a](/w/board_media/${FID.toUpperCase()})`, 7))
      .toBe(`![a](/w/board_media/${FID.toUpperCase()})`) // 大写 hex 不符 fid 形态
    expect(absToMedia('![a](/w/board_media/m123_abcdef1234.png)', 7))
      .toBe('![a](/w/board_media/m123_abcdef1234.png)') // 毫秒位数不足
    expect(absToMedia(`见 /w/board_media/${FID}`, 7))
      .toBe(`见 /w/board_media/${FID}`) // 裸路径非 markdown 引用，不改写
    // 平台端点 URL 自身（独立形态 BASE=''）不动——改写幂等
    expect(absToMedia(`![a](/api/projects/7/board/media/${FID})`, 7))
      .toBe(`![a](/api/projects/7/board/media/${FID})`)
  })

  it('空文本 / 缺项目 id 直接返回，多引用一次性全部改写', () => {
    expect(absToMedia('', 7)).toBe('')
    expect(absToMedia(null, 7)).toBe('')
    expect(absToMedia(`![a](/w/board_media/${FID})`, 0)).toBe(`![a](/w/board_media/${FID})`)
    const two = `![1](/w/board_media/${FID}) 和 ![2](/y/board_media/m1757000000001_0123456789.jpg)`
    expect(absToMedia(two, 3)).toBe(
      '![1](/api/projects/3/board/media/m1757000000000_abcdef1234.png)' +
      ' 和 ![2](/api/projects/3/board/media/m1757000000001_0123456789.jpg)')
  })

  it('插件形态（同源根 /touchstone）：两种形态都补前缀', () => {
    // ① 落盘绝对路径（看板新建框/会话 composer 写这种）
    expect(absToMedia(`![图](/opt/proj/.touchstone/board_media/${FID})`, 9, PLUGIN_BASE))
      .toBe(`![图](${PLUGIN_BASE}/api/projects/9/board/media/${FID})`)
    // ② 端点裸路径（看板详情编辑框粘贴的存量形态）——补前缀后缩略图才取得到
    expect(absToMedia(`![图](/api/projects/9/board/media/${FID})`, 9, PLUGIN_BASE))
      .toBe(`![图](${PLUGIN_BASE}/api/projects/9/board/media/${FID})`)
    // 已是带前缀形态：幂等不再叠加
    expect(absToMedia(`![图](${PLUGIN_BASE}/api/projects/9/board/media/${FID})`, 9, PLUGIN_BASE))
      .toBe(`![图](${PLUGIN_BASE}/api/projects/9/board/media/${FID})`)
    // 非本平台端点（fid 形态不符）不动
    expect(absToMedia('![a](/api/projects/9/board/media/not-a-fid.png)', 9, PLUGIN_BASE))
      .toBe('![a](/api/projects/9/board/media/not-a-fid.png)')
  })
})

describe('mediaDisplayUrl', () => {
  it('端点裸路径补同源根前缀（chip 缩略图直接用 server 回包 url）', () => {
    expect(mediaDisplayUrl(`/api/projects/9/board/media/${FID}`, PLUGIN_BASE))
      .toBe(`${PLUGIN_BASE}/api/projects/9/board/media/${FID}`)
    // 独立形态同源根=''：逐字符不变
    expect(mediaDisplayUrl(`/api/projects/9/board/media/${FID}`, ''))
      .toBe(`/api/projects/9/board/media/${FID}`)
  })

  it('已是带前缀形态 / 非本平台端点 / 空值原样返回', () => {
    expect(mediaDisplayUrl(`${PLUGIN_BASE}/api/projects/9/board/media/${FID}`, PLUGIN_BASE))
      .toBe(`${PLUGIN_BASE}/api/projects/9/board/media/${FID}`)
    expect(mediaDisplayUrl('/assets/a.png', PLUGIN_BASE)).toBe('/assets/a.png')
    expect(mediaDisplayUrl(`/api/projects/9/board/media/${FID}`, PLUGIN_BASE))
      .not.toBe(`/api/projects/9/board/media/${FID}`) // 防呆：确实改写了
    expect(mediaDisplayUrl('', PLUGIN_BASE)).toBe('')
    expect(mediaDisplayUrl(null, PLUGIN_BASE)).toBe('')
    expect(mediaDisplayUrl(undefined, PLUGIN_BASE)).toBe('')
  })
})
