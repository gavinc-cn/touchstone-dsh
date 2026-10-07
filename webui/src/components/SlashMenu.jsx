// / 指令 + skill 菜单（复刻 kimi code web 的深色浮动面板）
// props: open(是否显示) query(/ 后的过滤串) items([{key,label,desc,type,run?,dis?}])
//        onSelect(item) onClose() onDisabled(item)
// dis:true = 置灰项(常显): 灰显 + not-allowed 光标; 点击/回车 → onDisabled(it)(SessionView toast);
//   键盘 ↑↓ 跳过置灰项(高亮只落在可执行项上); 非置灰项选中行为不变: onSelect(item)
// 键盘: ↑↓ 移动, Enter 选中, Esc 关闭; 鼠标点击选中; 子串过滤(指令名/技能名)
import { useEffect, useRef, useState } from 'react'

export default function SlashMenu({ open, query, items, onSelect, onClose, onDisabled }) {
  const [idx, setIdx] = useState(0)
  const listRef = useRef(null)

  // 过滤: 置灰项常显(不随 query 剔出), 可执行项按指令名/技能名 query 子串过滤(大小写不敏感)
  const filtered = (items || []).filter((it) =>
    it.dis || !query || (it.key || '').toLowerCase().includes(query.toLowerCase()))
  // 键盘可选项: 跳过 dis 置灰项(↑↓ 只在这些项之间移动)
  const selectable = filtered.filter((it) => !it.dis)
  useEffect(() => {
    // 打开/过滤变化: 高亮重置到第一个可选项(全置灰时落 0, 键盘输入被 selectable 空挡拦截)
    const i = filtered.findIndex((it) => !it.dis)
    setIdx(i >= 0 ? i : 0)
  }, [query, open])
  // 高亮项滚动进视口(键盘移动/过滤变化时)
  useEffect(() => {
    if (listRef.current) listRef.current.scrollIntoView({ block: 'nearest' })
  }, [idx, filtered])
  // 从当前高亮出发按方向找下一个可选项(跳过 dis; 越界环绕; 无可选项时原地不动)
  function nextSel(i, delta) {
    if (!selectable.length) return i
    for (let step = 1; step <= filtered.length; step++) {
      const j = (i + delta * step + filtered.length) % filtered.length
      if (!filtered[j]?.dis) return j
    }
    return i
  }
  // Esc 关闭; ↑↓/Enter 选择。capture 阶段监听 + stopPropagation:
  // 菜单打开时拦截 Enter, 避免 textarea 自身的 Enter 发送逻辑抢先触发; 关闭时不拦截
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.isComposing) return   // 中文输入法组词中的回车不拦截
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (!selectable.length) return
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation(); setIdx((i) => nextSel(i, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation(); setIdx((i) => nextSel(i, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation()
        const it = filtered[idx]
        if (!it) return
        if (it.dis) onDisabled?.(it)   // 置灰项(鼠标悬停落位): 与点击一致, 回调提示
        else onSelect(it)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, selectable, idx, onSelect, onClose, onDisabled])

  if (!open) return null
  return (
    <div className="sess-slashmenu">
      {filtered.length === 0 ? (
        <div className="sess-slash-empty">无匹配项</div>
      ) : filtered.map((it, i) => (
        <button key={it.key} type="button" ref={i === idx ? listRef : undefined}
          className={'sess-slash-item' + (i === idx ? ' on' : '') + (it.dis ? ' dis' : '')}
          onMouseEnter={() => setIdx(i)}
          onClick={() => { if (it.dis) onDisabled?.(it); else onSelect(it) }}>
          <span className="sess-slash-key">{it.key || it.label}</span>
          <span className="sess-slash-desc">{it.desc}</span>
          {it.type === 'cmd' && <span className="sess-slash-tag">命令</span>}
          {it.type === 'skill' && <span className="sess-slash-tag">skill</span>}
        </button>
      ))}
    </div>
  )
}
