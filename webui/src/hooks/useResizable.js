// 弹窗通过拖动边框调整大小(React hook 版)
// 用法:
//   const { rzOn, rzStyle, rzStart, rzReset } = useResizable('ts.sessW')  // 可选 key: 记忆尺寸
//   <div className={'modal' + (rzOn ? ' fixed' : '')} style={rzStyle}>
//     <i className="rz rz-n" onMouseDown={(e) => rzStart(e, 'n')} onDoubleClick={rzReset}></i>
//     ...
// 手柄 8 个方向: n / s / e / w / ne / nw / se / sw, 双击任一方向可复位默认尺寸
// persistKey 非空时: 移动/缩放结束把 {w,h} 写入 localStorage, 下次挂载恢复
// (恢复时只带尺寸不带位置, 弹窗仍居中; 双击复位同时清除记忆)
import { useCallback, useRef, useState } from 'react'

const MIN_W = 400   // 最小宽度
const MIN_H = 240   // 最小高度
const PAD = 8       // 距视口边缘最小间距
const CURSOR = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', sw: 'nesw-resize',
}

function loadSaved(persistKey, persistH) {
  /* 从 localStorage 恢复 {w, h}（非法/过小返回 null）；persistH=false 时只恢复宽度。 */
  if (!persistKey) return null
  try {
    const v = JSON.parse(localStorage.getItem(persistKey))
    if (v && +v.w >= MIN_W && (persistH ? +v.h >= MIN_H : true)) {
      return persistH ? { w: +v.w, h: +v.h } : { w: +v.w }
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

  const start = useCallback((e, dir) => {
    const el = e.currentTarget.closest('.modal')
    if (!el) return
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
