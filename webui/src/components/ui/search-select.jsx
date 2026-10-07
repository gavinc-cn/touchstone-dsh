// 搜索式下拉（combobox）：输入框空时展示全部选项 + 右侧箭头，开始输入后实时过滤匹配项。
// 选中后回显 label，再次打开输入框转为搜索态（空 → 全量）。支持键盘 ↑↓ 移动、Enter 选中、Esc 关闭。
// 纯标准 React 自研（不引 radix popover/command，避免新增第三方依赖），样式对齐 shadcn Select：
// 面板用 bg-popover/text-popover-foreground/border/shadow-md，选项 hover/accent 高亮。
// options: [{ value, label, search? }]（search 为附加可搜索文本，如会话 sid/列名；匹配 label 与 search）
import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export default function SearchSelect({
  options = [], value, onChange, placeholder = '搜索…',
  emptyHint = '无匹配项', className, inputClassName,
}) {
  const [open, setOpen] = useState(false)   // 面板开合（打开时输入框为搜索态）
  const [query, setQuery] = useState('')    // 搜索关键字（大小写不敏感）
  const [hl, setHl] = useState(0)           // 键盘高亮项索引
  const wrapRef = useRef(null)              // 容器 ref：外部点击关闭判定
  const inputRef = useRef(null)

  const selected = options.find((o) => o.value === value) || null
  // 过滤：query 空 → 全量；否则匹配 label / search（转小写 includes）
  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter((o) => ((o.search || '') + ' ' + o.label).toLowerCase().includes(q))
    : options

  // 打开时挂外部 mousedown 监听：点容器外关闭（早于 click，与按钮区互不干扰）
  useEffect(() => {
    if (!open) return
    const h = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  // 输入变化重置高亮到首项
  useEffect(() => { setHl(0) }, [query, open])

  function toggle() {
    if (open) { setOpen(false); return }
    setQuery('')          // 打开转为搜索态：清空关键字（回显 label 不参与过滤）
    setOpen(true)
    inputRef.current?.focus()
  }
  function pick(o) {
    onChange(o.value)
    setOpen(false)
    setQuery('')
  }
  // 键盘导航：↑↓ 移动高亮、Enter 选中高亮项、Esc 关闭（输入态下不吞键，仅处理以上几个）
  function onKeyDown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) e.preventDefault()
    if (!open) { if (e.key === 'ArrowDown') toggle(); return }
    if (e.key === 'Escape') { setOpen(false); setQuery(''); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, filtered.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); return }
    if (e.key === 'Enter') { e.preventDefault(); if (filtered[hl]) pick(filtered[hl]); return }
  }

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <Input
        ref={inputRef}
        className={cn('pr-8', inputClassName)}
        value={open ? query : (selected ? selected.label : '')}
        placeholder={placeholder}
        onChange={(e) => { setOpen(true); setQuery(e.target.value) }}
        onFocus={() => { if (!open) setOpen(true) }}
        onKeyDown={onKeyDown}
        title={selected ? selected.label : undefined}
      />
      {/* 右侧箭头：切换面板（聚焦态下输入框已可打开，箭头为显式开关） */}
      <button type="button" tabIndex={-1}
        className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded hover:bg-accent"
        onClick={() => toggle()}>
        <ChevronDown className={cn('size-4 opacity-50 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto
          rounded-md border bg-popover text-popover-foreground p-1 shadow-md">
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyHint}</div>)}
          {filtered.map((o, i) => (
            <div key={o.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none',
                o.value === value && 'bg-accent text-accent-foreground',
                !(o.value === value) && (i === hl ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent'),
              )}
              onMouseEnter={() => setHl(i)}
              onClick={() => pick(o)}>
              <span className="flex-1 truncate">{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
