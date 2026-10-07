// 看板回收站弹窗：删除卡片=软删除进这里；列表显示标题/原列/删除时间/Jira，
// 操作「还原」（回原列原位置）/「彻底删除」（确认后连带评论真删）/「清空回收站」（批量真删）。
// 数据：打开时拉取 + 操作后本地刷新；关闭时通知看板 reload（还原的卡重新上板）。
import { useState, useEffect } from 'react'
import { boardApi } from '../api'
import { toast } from '../utils/toast'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Undo2, Trash2 } from 'lucide-react'

// 列标题映射（回收站卡片显示原列）
const COL_LABEL = { todo: '待开发', doing: '正在开发', blocked: '阻塞', review: '待审核', done: '已完成' }

export default function BoardTrash({ project, onClose, onChanged }) {
  const projectId = project?.id
  const [cards, setCards] = useState([])   // 回收站卡片列表
  const [emptyBusy, setEmptyBusy] = useState(false)  // 清空请求进行中（防连点）

  async function load() {
    try {
      const r = await boardApi.trashList(projectId)
      setCards(r.cards || [])
    } catch (e) { toast(e.message) }
  }
  useEffect(() => { load() }, [projectId])

  async function restore(c) {
    try {
      await boardApi.restoreCard(projectId, c.id)
      toast(`已还原「${c.title || '未命名'}」`)
      await load(); onChanged?.()
    } catch (e) { toast(e.message) }
  }
  async function purge(c) {
    if (!window.confirm(`彻底删除「${c.title || '未命名'}」？评论一并删除，不可恢复。`)) return
    try {
      await boardApi.purgeCard(projectId, c.id)
      await load(); onChanged?.()
    } catch (e) { toast(e.message) }
  }
  async function empty() {
    if (emptyBusy) return
    if (!window.confirm(`清空回收站共 ${cards.length} 张卡片？全部彻底删除，不可恢复。`)) return
    setEmptyBusy(true)
    try {
      await boardApi.emptyTrash(projectId)
      setCards([]); toast('回收站已清空'); onChanged?.()
    } catch (e) { toast(e.message) } finally { setEmptyBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="modal board-trash-modal w-[52vw] max-h-[85vh] overflow-y-auto sm:max-w-[94vw]">
        <DialogHeader className="text-left">
          <DialogTitle className="text-sm">回收站（{cards.length}）</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-muted-foreground">
            删除的卡片仅移入回收站，可还原；这里的彻底删除不可恢复
          </span>
          <Button size="sm" variant="outline" disabled={!cards.length || emptyBusy}
            onClick={empty}><Trash2 /> 清空回收站</Button>
        </div>
        {cards.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">回收站是空的</div>
        ) : (
          <div className="flex flex-col gap-2">
            {cards.map((c) => (
              <div key={c.id} className="flex items-start gap-2 rounded border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm break-words">{c.title || '未命名'}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span className="bug-status pending">{COL_LABEL[c.column] || c.column}</span>
                    {c.jira_key && <span className="bug-status pending">{c.jira_key}</span>}
                    <span>删除于 {c.trashed_at?.replace('T', ' ') || ''}</span>
                  </div>
                </div>
                <Button size="sm" variant="outline" title="还原（回原列原位置）"
                  onClick={() => restore(c)}><Undo2 /> 还原</Button>
                <Button size="sm" variant="ghost" title="彻底删除（不可恢复）"
                  onClick={() => purge(c)}><Trash2 /></Button>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
