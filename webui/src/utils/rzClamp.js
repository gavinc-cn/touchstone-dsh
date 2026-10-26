// 弹窗（可拖拽调尺寸）的视口夹取纯函数 —— useResizable 的「记忆尺寸恢复」与
// 「窗口 resize」两条路径共用同一个出口（2026-10-25 小分辨率自适应）。
//
// 背景（用户报「会话详情页, 在分辨率比较小的时候会超出浏览器显示范围. 应该能够根据
// 浏览器框的大小动态调整.」）：
//   尺寸记忆（localStorage `ts.sessW` / `ts.boardW` 等）只存像素 {w,h}，弹窗重开时按原样
//   恢复。在大窗口上拖成大尺寸后，换小窗口（或 dsh 面板缩窄）重开，弹窗比视口还大、按
//   「居中」算出的 left/top 变成负坐标 —— 标题行与右上角关闭按钮整块跑到浏览器窗口外
//   （真机实测：1024×640 视口恢复 1500×900 ⇒ left=-238 / top=-130）。窗口开着时把浏览器
//   拖小同样没人管（行内 px 尺寸不会自己缩）。
//   这里把两条路径统一成「先量视口、再夹」的纯函数，useResizable 只负责接线。
//
// 约定：PAD / MIN_W / MIN_H 与拖动路径的夹取口径同源（拖动时 onMove 里的边界逻辑保持
//   原样，这里只负责「恢复」与「resize 重夹」，避免出现两套不一致的最小尺寸/边距）。

export const RZ_PAD = 8      // 距视口边缘的最小间距（与拖动时 onMove 的 PAD 一致）
export const RZ_MIN_W = 400  // 最小宽度（拖动下限；极小视口下也保证控件可用）
export const RZ_MIN_H = 240  // 最小高度（同上）

/** 数值归一：非法/缺省一律按 d 处理，绝不把 NaN 写进行内样式。 */
function num(v, d = 0) {
  const n = +v
  return Number.isFinite(n) ? n : d
}

/**
 * 视口内最大可用尺寸：两侧各留 PAD；极小视口下不跌破拖动下限（否则尺寸会是负数）。
 * @param {number} vw 视口宽（window.innerWidth）
 * @param {number} vh 视口高（window.innerHeight）
 * @returns {{w: number, h: number}}
 */
export function rzViewportMax(vw, vh) {
  return {
    w: Math.max(RZ_MIN_W, num(vw) - RZ_PAD * 2),
    h: Math.max(RZ_MIN_H, num(vh) - RZ_PAD * 2),
  }
}

/**
 * 尺寸夹取：不超过视口可用尺寸、不低于拖动下限。
 * @param {number} w 期望宽
 * @param {number} h 期望高
 * @param {number} vw 视口宽
 * @param {number} vh 视口高
 * @returns {{w: number, h: number}}
 */
export function clampRzSize(w, h, vw, vh) {
  const max = rzViewportMax(vw, vh)
  return {
    w: Math.min(Math.max(num(w), RZ_MIN_W), max.w),
    h: Math.min(Math.max(num(h), RZ_MIN_H), max.h),
  }
}

/**
 * 整框夹取（拖动过/带位置的状态）：先夹尺寸，再把 left/top 收进视口。
 * 尺寸顶满时贴 PAD 边（左上角优先可见，避免整框跑出屏幕）。
 * @param {{left?: number, top?: number, w: number, h: number}} box
 * @param {number} vw 视口宽
 * @param {number} vh 视口高
 * @returns {{left: number, top: number, w: number, h: number}}
 */
export function clampRzBox(box, vw, vh) {
  const b = box || {}
  const { w, h } = clampRzSize(b.w, b.h, vw, vh)
  const left = num(b.left, RZ_PAD)
  const top = num(b.top, RZ_PAD)
  const maxLeft = Math.max(RZ_PAD, num(vw) - RZ_PAD - w)
  const maxTop = Math.max(RZ_PAD, num(vh) - RZ_PAD - h)
  return {
    left: Math.min(Math.max(left, RZ_PAD), maxLeft),
    top: Math.min(Math.max(top, RZ_PAD), maxTop),
    w, h,
  }
}

/**
 * 夹取任意 useResizable 状态（形状约定：`{left,top,w,h}`=拖过/移动过；
 * `{w,h}`=仅恢复尺寸（仍按 CSS 居中）；`{w}`=只记忆宽度（高度由 CSS 决定））。
 * 只有尺寸时**不凭空造 left/top**——否则弹窗会从「居中」变成贴边。
 * @param {{left?: number, top?: number, w?: number, h?: number}|null|undefined} rz
 * @param {number} vw 视口宽
 * @param {number} vh 视口高
 * @returns {object|null|undefined} 同形状的夹取结果；空状态原样返回
 */
export function clampRzState(rz, vw, vh) {
  if (!rz) return rz
  if (rz.left != null || rz.top != null) return clampRzBox(rz, vw, vh)
  const s = clampRzSize(rz.w, rz.h, vw, vh)
  return rz.h != null ? { w: s.w, h: s.h } : { w: s.w }
}
