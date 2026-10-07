// 轻量下拉菜单（自绘，零新依赖；路线对齐同目录 search-select.jsx 的「不引 radix popover」约定）。
//
// 为什么必须 createPortal 到 document.body：看板列内容区 `.board-col-body`
// 是 `overflow-y: auto` 的滚动容器（webui/src/styles/components.css），卡片内的
// 绝对定位菜单会被该容器裁掉（卡片自身还有 `position: relative` 与拖拽裁剪上下文）；
// portal 后菜单脱离裁剪祖先，再按 getBoundingClientRect() 用 fixed 定位跟住触发元素。
// 为什么自绘而不引第三方：ui/ 目录没有 dropdown-menu 组件、package.json 也没有
// @radix-ui/react-dropdown-menu，项目约定不新增 npm 依赖，本组件只用到 React + cn。
//
// 交互：点触发元素开合；点菜单外 mousedown 关闭；Esc 关闭并把焦点还给触发元素；
// 页面滚动 / 窗口 resize 关闭（fixed 坐标会与触发元素错位，直接关掉最稳）；打开时焦点进菜单。
//
// props:
//   trigger  ReactNode——点击开合的触发元素（本组件只在外层包一层 inline-flex，不改其样式）
//   items    [{ key, label, icon?, disabled?, title?, onSelect }]
//            disabled 项不触发 onSelect（并显示 title 说明原因，鼠标悬浮可见）
//   align    'end'（默认，右对齐触发元素右缘）| 'start'（左对齐左缘）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

const MENU_GAP = 4    // 菜单与触发元素的垂直间距（px）
const MENU_EDGE = 8   // 菜单与视口边缘的最小留白（px）

export default function ActionMenu({ trigger, items = [], align = 'end' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)  // {left, top} 视口坐标；null=已打开但尚未测量（先隐藏再摆位，防闪跳）
  const trigRef = useRef(null)          // 触发元素外层 span（取 rect / 判定「点触发」不算外部）
  const menuRef = useRef(null)          // 菜单根（外部点击判定、尺寸测量、焦点落点）

  // 关闭菜单；restoreFocus=true（Esc 路径）把焦点还给触发元素，鼠标路径不抢焦点
  function close(restoreFocus = false) {
    setOpen(false)
    setPos(null)
    if (restoreFocus) trigRef.current?.querySelector('button')?.focus()
  }

  // 打开期间挂全局监听：外部 mousedown 关闭 / Esc 关闭 / 滚动或 resize 关闭
  // （scroll 用捕获阶段，才能收到 .board-col-body 这类内层滚动容器的滚动事件）
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target)) return
      if (trigRef.current?.contains(e.target)) return  // 点触发交给 click 分支开合，避免「关两次」
      close()
    }
    const onKey = (e) => { if (e.key === 'Escape') close(true) }
    const onShift = () => close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onShift, true)
    window.addEventListener('resize', onShift)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onShift, true)
      window.removeEventListener('resize', onShift)
    }
  }, [open])

  // 打开后（菜单已挂载）测量尺寸再摆位：默认右对齐触发元素右缘、下方 4px；
  // 下方空间不足且上方更宽裕时向上翻；左右都夹在视口内（防溢出屏幕）
  useLayoutEffect(() => {
    if (!open) return
    const t = trigRef.current?.getBoundingClientRect()
    if (!t) return
    const w = menuRef.current?.offsetWidth || 0
    const h = menuRef.current?.offsetHeight || 0
    let left = align === 'start' ? t.left : t.right - w
    left = Math.max(MENU_EDGE, Math.min(left, window.innerWidth - w - MENU_EDGE))
    let top = t.bottom + MENU_GAP
    if (h && top + h > window.innerHeight - MENU_EDGE && t.top - MENU_GAP - h >= MENU_EDGE) {
      top = t.top - MENU_GAP - h
    }
    setPos({ left, top })
    menuRef.current?.focus()      // 打开时焦点移到菜单（Esc/键盘操作可达）
  }, [open, align])

  return (
    <>
      {/* 触发元素外包一层 inline-flex：只为拿 rect 与判定归属，不改变按钮自身样式 */}
      <span ref={trigRef} className="inline-flex"
        onClick={() => (open ? close() : setOpen(true))}>
        {trigger}
      </span>
      {open && createPortal(
        <div ref={menuRef} role="menu" tabIndex={-1}
          style={{
            position: 'fixed',
            left: pos ? pos.left : -9999,
            top: pos ? pos.top : -9999,
            visibility: pos ? 'visible' : 'hidden',  // 首帧未测量：先隐藏防在旧位置闪现
          }}
          className="z-50 min-w-[176px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          {items.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">无可选项</div>)}
          {items.map((it) => (
            // disabled 项：button 置 disabled 保证 click 不触发；title 挂在外层 div 上
            // （禁用控件不派发鼠标事件，靠祖先的 title 才能显示原因提示）
            <div key={it.key} title={it.disabled ? it.title : undefined}>
              <button type="button" role="menuitem" disabled={!!it.disabled}
                aria-disabled={it.disabled || undefined}
                title={it.disabled ? undefined : it.title}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm select-none',
                  it.disabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'cursor-pointer hover:bg-accent hover:text-accent-foreground',
                )}
                onClick={() => {
                  if (it.disabled) return   // 双保险：disabled 项绝不触发 onSelect
                  close()
                  it.onSelect?.()
                }}>
                {it.icon && <span className="shrink-0">{it.icon}</span>}
                <span className="flex-1 truncate">{it.label}</span>
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
