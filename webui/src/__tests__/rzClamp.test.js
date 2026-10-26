// utils/rzClamp.js 单测（2026-10-25 批次「会话详情页小分辨率自适应」）。
//
// 用户报障原文：「会话详情页, 在分辨率比较小的时候会超出浏览器显示范围. 应该能够根据
// 浏览器框的大小动态调整.」
//
// 真机实测（1024×640 视口 + localStorage ts.sessW={w:1500,h:900}）恢复出来的弹窗是
// left=-238 / top=-130 / 1500×900：标题行与右上角关闭按钮整块在浏览器窗口外。根因=
// 尺寸记忆只存像素 {w,h}，恢复时按原样写进行内样式、不看当前视口，窗口 resize 也没人管。
//
// 这些用例钉住纯函数契约（useResizable 的记忆恢复/resize 两条路径共用同一出口）：
//   1. 记忆尺寸放得下 ⇒ 原样；比视口大 ⇒ 夹到视口内（两侧留 PAD）；
//   2. 夹取带拖动下限（MIN_W/MIN_H），极小视口下不产生负数/零尺寸；
//   3. 带位置（拖过/移动过）⇒ 整框夹取：尺寸先夹，再把 left/top 收回视口；
//   4. 只有尺寸（居中显示）⇒ 只夹尺寸，不凭空造 left/top（否则会从居中变成贴边）；
//   5. 非法入参（NaN/undefined）⇒ 兜底为下限，不把 NaN 写进样式。
import { describe, expect, it } from 'vitest'

import {
  RZ_PAD, RZ_MIN_W, RZ_MIN_H,
  rzViewportMax, clampRzSize, clampRzBox, clampRzState,
} from '../utils/rzClamp'

describe('rzClamp：弹窗尺寸/位置按当前视口动态夹取', () => {
  it('视口最大可用尺寸 = 视口扣掉两侧间距', () => {
    expect(rzViewportMax(1024, 640)).toEqual({ w: 1024 - RZ_PAD * 2, h: 640 - RZ_PAD * 2 })
    expect(RZ_PAD).toBe(8)
  })

  it('视口比拖动下限还小时，最大尺寸不跌破下限（保证控件可用）', () => {
    expect(rzViewportMax(300, 200)).toEqual({ w: RZ_MIN_W, h: RZ_MIN_H })
  })

  it('记忆尺寸比视口大 ⇒ 夹到视口内（用户报障的 1500×900 @1024×640 场景）', () => {
    expect(clampRzSize(1500, 900, 1024, 640)).toEqual({ w: 1008, h: 624 })
  })

  it('记忆尺寸放得下 ⇒ 原样返回', () => {
    expect(clampRzSize(900, 600, 1280, 720)).toEqual({ w: 900, h: 600 })
  })

  it('尺寸小于拖动下限 ⇒ 抬到下限', () => {
    expect(clampRzSize(120, 80, 1280, 720)).toEqual({ w: RZ_MIN_W, h: RZ_MIN_H })
  })

  it('非法尺寸（NaN/undefined）⇒ 兜底为下限，不把 NaN 写进行内样式', () => {
    expect(clampRzSize(NaN, undefined, 1024, 640)).toEqual({ w: RZ_MIN_W, h: RZ_MIN_H })
  })

  it('整框在视口内 ⇒ 原样不动', () => {
    expect(clampRzBox({ left: 100, top: 100, w: 800, h: 500 }, 1024, 640))
      .toEqual({ left: 100, top: 100, w: 800, h: 500 })
  })

  it('整框超视口 ⇒ 先夹尺寸，再把 left/top 收回视口（左上角不跑出屏幕）', () => {
    // 真机基线：恢复 1500×900 且 calc 居中算出的负坐标
    expect(clampRzBox({ left: -238, top: -130, w: 1500, h: 900 }, 1024, 640))
      .toEqual({ left: RZ_PAD, top: RZ_PAD, w: 1008, h: 624 })
  })

  it('右下越界 ⇒ 只把 left/top 往回收，尺寸不变', () => {
    expect(clampRzBox({ left: 300, top: 300, w: 800, h: 500 }, 1024, 640))
      .toEqual({ left: 216, top: 132, w: 800, h: 500 })
  })

  it('只有尺寸（居中记忆）⇒ 只夹尺寸，不凭空造 left/top', () => {
    expect(clampRzState({ w: 1500, h: 900 }, 1024, 640)).toEqual({ w: 1008, h: 624 })
  })

  it('只记忆宽度（persistH=false）⇒ 只夹宽度且不冒出 h', () => {
    expect(clampRzState({ w: 1500 }, 1024, 640)).toEqual({ w: 1008 })
  })

  it('带位置的 state ⇒ 走整框夹取分支', () => {
    expect(clampRzState({ left: -10, top: -10, w: 500, h: 300 }, 1024, 640))
      .toEqual({ left: RZ_PAD, top: RZ_PAD, w: 500, h: 300 })
  })

  it('空 state ⇒ 原样返回 null（未拖过/未记忆，弹窗走 CSS 默认尺寸）', () => {
    expect(clampRzState(null, 1024, 640)).toBe(null)
    expect(clampRzState(undefined, 1024, 640)).toBe(undefined)
  })
})
