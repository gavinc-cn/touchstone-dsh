// 弹窗通过拖动边框调整大小(React hook 版)
// 用法:
//   const { rzOn, rzStyle, rzStart, rzReset } = useResizable('ts.sessW')  // 可选 key: 记忆尺寸
//   <div className={'modal' + (rzOn ? ' fixed' : '')} style={rzStyle}>
//     <i className="rz rz-n" onMouseDown={(e) => rzStart(e, 'n')} onDoubleClick={rzReset}></i>
//     ...
// 手柄 8 个方向: n / s / e / w / ne / nw / se / sw, 双击任一方向可复位默认尺寸
// persistKey 非空时: 移动/缩放结束把 {w,h} 写入 localStorage, 下次挂载恢复
// (恢复时只带尺寸不带位置, 弹窗仍居中; 双击复位同时清除记忆)
// 2026-10-25 小分辨率自适应:
//   ① 恢复记忆尺寸时按**当前视口**夹取（记忆只代表偏好，不能在小窗口上原样恢复成比
//      视口还大 —— 用户报「会话详情页…超出浏览器显示范围」）；
//   ② 挂 window resize 监听，视口变小（浏览器窗口/面板缩窄）时把弹窗自动夹回视口内；
//   两条路径与拖动路径共用 utils/rzClamp 的同一套边界口径（PAD/MIN_W/MIN_H 单源）。
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RZ_MIN_W as MIN_W, RZ_MIN_H as MIN_H, RZ_PAD as PAD,
  clampRzSize, clampRzBox, clampRzState,
} from '../utils/rzClamp'

const CURSOR = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', sw: 'nesw-resize',
}

function loadSaved(persistKey, persistH) {
  /* 从 localStorage 恢复 {w, h}（非法/过小返回 null）；persistH=false 时只恢复宽度。
     恢复时按**当前视口**夹取（clampRzSize）：记忆中存的是偏好像素尺寸，不是「合法渲染
     尺寸」——大屏拖出来的 1500×900 在 1024×640 窗口上必须缩到视口内再交给行内样式。 */
  if (!persistKey) return null
  try {
    const v = JSON.parse(localStorage.getItem(persistKey))
    if (v && +v.w >= MIN_W && (persistH ? +v.h >= MIN_H : true)) {
      const s = clampRzSize(+v.w, persistH ? +v.h : 0, window.innerWidth, window.innerHeight)
      return persistH ? { w: s.w, h: s.h } : { w: s.w }
    }
  } catch { /* 解析失败按未保存处理 */ }
  return null
}

export function useResizable(persistKey, persistH = true) {
  // rz: { left, top, w, h }(已拖动, 固定位置) 或 { w, h }(仅恢复尺寸, 仍居中) 或 null=默认尺寸
  const [rz, setRz] = useState(() => loadSaved(persistKey, persistH))
  const st = useRef(null)                 // { dir, sx, sy, left, top, w, h }
  const moveRef = useRef(null)

  const onMove = useCallback((e) => {
    const s = st.current
    if (!s) return
    const dx = e.clientX - s.sx
    const dy = e.clientY - s.sy
    let left = s.left, top = s.top, w = s.w, h = s.h
    if (s.dir === 'mv') {
      // 标题栏拖动: 仅移动位置, 整体保持在视口内
      const vw = window.innerWidth, vh = window.innerHeight
      left = Math.max(PAD, Math.min(s.left + dx, vw - PAD - w))
      top = Math.max(PAD, Math.min(s.top + dy, vh - PAD - h))
      setRz({ left, top, w, h })
      return
    }
    if (s.dir.includes('e')) w = s.w + dx
    if (s.dir.includes('s')) h = s.h + dy
    if (s.dir.includes('w')) { w = s.w - dx; left = s.left + dx }
    if (s.dir.includes('n')) { h = s.h - dy; top = s.top + dy }
    const vw = window.innerWidth, vh = window.innerHeight
    // 最小尺寸: 修正幅度与位移抵消, 保证对侧边缘不动
    if (w < MIN_W) { if (s.dir.includes('w')) left -= MIN_W - w; w = MIN_W }
    if (h < MIN_H) { if (s.dir.includes('n')) top -= MIN_H - h; h = MIN_H }
    if (left < PAD) { if (s.dir.includes('w')) w -= PAD - left; left = PAD }
    if (top < PAD) { if (s.dir.includes('n')) h -= PAD - top; top = PAD }
    if (left + w > vw - PAD) w = vw - PAD - left
    if (top + h > vh - PAD) h = vh - PAD - top
    setRz({ left, top, w, h })
  }, [])

  const onEnd = useCallback(() => {
    if (moveRef.current) {
      window.removeEventListener('mousemove', moveRef.current)
      window.removeEventListener('mouseup', onEnd)
      moveRef.current = null
    }
    document.body.style.cursor = ''
    // 结束(移动/缩放)时把最终尺寸写入 localStorage, 重开弹窗恢复
    if (persistKey) {
      setRz((cur) => {
        if (cur) {
          try {
            localStorage.setItem(persistKey, JSON.stringify(
              persistH ? { w: cur.w, h: cur.h } : { w: cur.w }))
          } catch { /* 配额/隐私模式: 忽略 */ }
        }
        return cur
      })
    }
  }, [persistKey, persistH])

  // 视口变化（浏览器窗口/面板缩窄）时自动重夹：开着的弹窗不能跑到浏览器窗口外。
  // - 拖过/移动过（带 left/top）⇒ 整框夹取（尺寸先夹、再把左上角收进视口）；
  // - 仅记忆尺寸（仍居中）⇒ 以 localStorage 里的偏好为基准重新夹取——窗口先变小再放大时
  //   能回弹到用户偏好尺寸，而不是永久停在缩小时的那一档。
  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      setRz((cur) => {
        if (!cur) return cur
        if (cur.left != null || cur.top != null) return clampRzBox(cur, vw, vh)
        return clampRzState(loadSaved(persistKey, persistH) || cur, vw, vh)
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [persistKey, persistH])

  const start = useCallback((e, dir) => {
    if (e.button !== 0) return
    const el = e.currentTarget.closest('.modal')
    if (!el) return
    // 阻止 mousedown 的默认「开始选区」动作: 边框手柄是透明条, 不拦的话拖到弹窗外会
    // 选中背后页面的文字(用户报「拖边框会选到背后的编辑项目页面」, 与标题栏拖动同口径)
    e.preventDefault()
    // 先停掉打开动画(zoom-in/enter 会覆盖定位导致取到的 rect 失真), 再读真实布局
    el.style.animation = 'none'
    el.style.transition = 'none'
    const r = el.getBoundingClientRect()
    st.current = { dir, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height }
    setRz({ left: r.left, top: r.top, w: r.width, h: r.height })
    moveRef.current = onMove
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    document.body.style.cursor = CURSOR[dir] || 'default'
  }, [onMove, onEnd])

  // 标题栏拖动: 按住弹窗顶部区域整体移动位置(与 resize 同一套位置状态)
  const dragStart = useCallback((e) => {
    if (e.button !== 0) return
    const el = e.currentTarget.closest('.modal')
    if (!el) return
    // 先停掉打开动画(zoom-in/enter 会覆盖定位导致取到的 rect 失真), 再读真实布局
    el.style.animation = 'none'
    el.style.transition = 'none'
    const r = el.getBoundingClientRect()
    st.current = { dir: 'mv', sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height }
    setRz({ left: r.left, top: r.top, w: r.width, h: r.height })
    moveRef.current = onMove
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    document.body.style.cursor = 'move'
    e.preventDefault()  // 阻止标题栏文本被选中
  }, [onMove, onEnd])

  // 复位为默认尺寸(还原为 CSS 里的初始样式); 带持久化 key 时一并清除记忆
  const reset = useCallback(() => {
    if (persistKey) {
      try { localStorage.removeItem(persistKey) } catch { /* 忽略 */ }
    }
    setRz(null)
  }, [persistKey])

  const rzOn = !!rz
  // transform:none 用于压掉 shadcn Dialog 的 translate(-50%,-50%) 居中偏移, 避免拖拽后位置漂移;
  // 仅恢复尺寸(无 left/top)时按尺寸重算居中(仅宽: 顶边沿用 CSS 定位; 宽高: 垂直也居中)
  const rzStyle = rz
    ? rz.left != null
      ? { left: rz.left + 'px', top: rz.top + 'px', width: rz.w + 'px', height: rz.h + 'px', transform: 'none' }
      : rz.h
        ? { left: `calc(50% - ${rz.w / 2}px)`, top: `calc(50% - ${rz.h / 2}px)`,
            width: rz.w + 'px', height: rz.h + 'px' }
        : { left: `calc(50% - ${rz.w / 2}px)`, width: rz.w + 'px' }
    : {}

  return { rzOn, rzStyle, rzStart: start, rzDragStart: dragStart, rzReset: reset }
}
