// 看板卡片详情弹窗：标题/描述一体编辑（第一行=标题，其余=描述，保存时拆分 PATCH）/
// 定时 / 相关会话（行点击直接打开会话详情）/ 绑定已有会话下拉（shadcn Select，含已绑定/已归档标记）/
// 父任务依赖 / 重试提交 / 评论区。描述支持粘贴/拖入图片与文件（上传为附件，markdown 图片/链接）。
// 弹窗壳与 SessionModal 同款（modal-rz 可拖拽缩放，宽度记忆 ts.boardW）；
// 高度随内容自适应（最高 90vh），会话查看复用 SessionModal 的 board 模式。
import { useState, useEffect, useMemo, useRef } from 'react'
import { boardApi } from '../api'
import { toast } from '../utils/toast'
import { renderMd } from '../utils/renderMd'
import { absToMedia } from '../utils/mediaText'
import { isPlaceholderImage } from '../utils/media'
import { useResizable } from '../hooks/useResizable'
import { RzHandles } from './RzHandles'
import SessionModal from './SessionModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import SearchSelect from '@/components/ui/search-select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Send, Trash2, Copy, Shrink, CopyPlus, GitFork } from 'lucide-react'

const MEDIA_MAX = 10 * 1024 * 1024  // 附件单文件上限（与后端一致）

export default function BoardDetail({ project, card, comments, onClose, reload }) {
  const projectId = project.id
  const [editing, setEditing] = useState(false)
  // draft 为「标题/描述一体文本」：第一行=标题，其余=描述（保存时拆分 PATCH）
  const [draft, setDraft] = useState(card.title + '\n' + (card.description || ''))
  const [schedule, setSchedule] = useState('')   // datetime-local 值（未触碰时回显 card.scheduled_at）
  const [bindSid, setBindSid] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [forking, setForking] = useState(false)     // 压缩并新建进行中（后端压缩+建会话，可能 10~90s）
  const [forkingSess, setForkingSess] = useState(false)  // fork 会话进行中（完整复制，服务端拷贝历史）
  const [viewSid, setViewSid] = useState(null)   // 会话查看弹窗（SessionModal board 模式）
  const [uploading, setUploading] = useState(false)  // 附件上传中（粘贴/拖入）
  const [removingWt, setRemovingWt] = useState(false)  // 独立 worktree 清理进行中（防连点）
  const draftRef = useRef(null)                  // 描述编辑框 ref（附件插入光标处用）
  // 宽度记忆 ts.boardW（高度保持随内容自适应，不记忆）
  const { rzOn, rzStyle, rzStart, rzDragStart, rzReset } = useResizable('ts.boardW', false)

  // 卡片切换/轮询刷新时同步草稿（编辑中不覆盖用户输入）
  useEffect(() => {
    if (!editing) setDraft(card.title + '\n' + (card.description || ''))
  }, [card.title, card.description, editing])
  // 切卡时清掉与本卡绑定的局部输入态（定时回显/绑定框/评论草稿/会话弹窗），防串卡
  useEffect(() => {
    setEditing(false); setSchedule(''); setBindSid(''); setCommentDraft(''); setViewSid(null)
  }, [card.id])

  // 描述渲染: 附件 abs 引用(如 ![名](/srv/proj/.../board_media/m...png))先经 absToMedia
  // 改写为项目媒体端点 URL, 再由 renderMd 渲染缩略图/文件链接(与会话气泡同方案)
  const descHtml = useMemo(() => ({
    __html: renderMd(absToMedia(card.description || '*（无描述）*', projectId)),
  }), [card.description, projectId])
  // 父任务候选：排除自己（后代由后端 set_parent 拦截，前端仅做基本过滤）
  const [allCards, setAllCards] = useState([])
  const [boardCaps, setBoardCaps] = useState(null)   // 看板能力声明(按项目 agent 族, 后端下发)
  const [sessTitles, setSessTitles] = useState({})   // 会话标题 {sid: 标题}（可能为空串，行内兜底 sid）
  const [availSess, setAvailSess] = useState([])     // 工作区已有会话（绑定下拉；bound=已绑定）
  useEffect(() => {
    boardApi.get(projectId).then((d) => {
      setAllCards(d.cards || [])
      setBoardCaps(d.capabilities || null)
      setSessTitles(d.session_titles || {})
    }).catch(() => {})
    // 会话列表随卡片更新一并刷新（绑定/解绑后 bound 标志及时反映到下拉）
    boardApi.listSessions(projectId).then((d) => setAvailSess(d.sessions || [])).catch(() => {})
  }, [projectId, card.id, card.updated_at])

  async function save(patch) {
    try { await boardApi.updateCard(projectId, card.id, patch); await reload() }
    catch (e) { toast(e.message) }
  }
  // 一体文本拆分保存：第一行=标题（空则取「未命名」，截 200），其余=描述
  async function saveDesc() {
    const nl = draft.indexOf('\n')
    const title = (nl < 0 ? draft : draft.slice(0, nl)).trim() || '未命名'
    const description = nl < 0 ? '' : draft.slice(nl + 1)
    await save({ title: title.slice(0, 200), description })
    setEditing(false)
  }
  async function saveSchedule(v) {
    setSchedule(v)
    await save({ scheduled_at: v ? new Date(v).getTime() : 0 })
  }
  async function addComment(send) {
    const text = commentDraft.trim()
    if (!text) return
    try {
      const c = await boardApi.addComment(projectId, card.id, text)
      setCommentDraft('')
      if (send) await boardApi.sendComment(projectId, card.id, c.id)
      await reload()
    } catch (e) { toast(e.message); await reload() }
  }

  /* ---------- 描述粘贴/拖入图片与文件 ---------- */
  // 读取文件 → base64 上传 → 插入 markdown（图片 ![name](url) / 文件 [name](url)），
  // 插入点见下：描述区按光标、标题行/未聚焦追加到末尾
  async function uploadFiles(files) {
    const list = Array.from(files || [])
    if (!list.length || uploading) return
    for (const f of list) {
      if (f.size > MEDIA_MAX) { toast(`附件过大（>10MB）：${f.name}`); continue }
      // 占位图拦截（1x1/2x2 一类极小图，见 utils/media.js）：来源应用没给有效截图，跳过并提示
      if (await isPlaceholderImage(f)) {
        toast(`已跳过占位图（极小尺寸）：${f.name}（剪贴板里不是有效截图，请重新截图或改用「+」选文件）`)
        continue
      }
      setUploading(true)
      try {
        const data = await new Promise((res, rej) => {
          const fr = new FileReader()
          fr.onload = () => res(String(fr.result || '').split(',')[1] || '')
          fr.onerror = () => rej(new Error('文件读取失败'))
          fr.readAsDataURL(f)
        })
        const r = await boardApi.uploadMedia(projectId,
          { name: f.name, mime: f.type || 'application/octet-stream', data })
        const md = (f.type || '').startsWith('image/')
          ? `![${f.name}](${r.url})`
          : `[${f.name}](${r.url})`
        // 插入位置：光标在描述区（首行之后）→ 插到光标处；光标在首行（标题行）或编辑框未聚焦 →
        // 追加到末尾。标题按纯文本渲染（卡片标题/列表标题），markdown 引用落进标题只会显示成
        // 一串不可读文本，故一律让附件落到描述区。
        const ta = draftRef.current
        const focused = !!ta && document.activeElement === ta
        const caret = focused ? (ta.selectionStart ?? ta.value.length) : -1
        const firstNl = focused ? (ta.value || '').indexOf('\n') : -1
        const inDesc = focused && firstNl >= 0 && caret > firstNl
        setDraft((prev) => (inDesc
          ? prev.slice(0, caret) + md + prev.slice(ta.selectionEnd ?? caret)
          : (prev ? prev + '\n' : '') + md + '\n'))
        toast(inDesc || !focused ? `已粘贴附件：${f.name}`
          : `标题不支持图片，已附加到描述区：${f.name}`)
      } catch (e) { toast(e.message || '附件上传失败') }
      finally { setUploading(false) }
    }
  }
  function onPasteFiles(e) {
    const items = Array.from(e.clipboardData?.items || [])
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile()).filter(Boolean)
    if (!files.length) return
    e.preventDefault()  // 有文件时不落文本，全走上传通道
    uploadFiles(files)
  }
  function onDropFiles(e) {
    const files = Array.from(e.dataTransfer?.files || [])
    if (!files.length) return
    e.preventDefault()
    uploadFiles(files)
  }

  /* ---------- 独立 worktree 清理 ---------- */
  // 删除该卡的独立 git worktree（后端只删目录，分支保留）：会话运行中 409、
  // 工作树有未提交改动 400、非 worktree 卡 400，均按后端 error 文案 toast；
  // 成功后 reload 让看板重取（card.worktree 清空 → 本区块自动消失）
  async function removeWorktree() {
    if (removingWt) return
    const ok = window.confirm(
      `确认清理该独立 worktree？\n\n${card.worktree}\n\n` +
      '仅在工作树无未提交改动且会话未运行时才能清理（分支保留，不自动删除）。')
    if (!ok) return
    setRemovingWt(true)
    try {
      await boardApi.removeWorktree(projectId, card.id)
      toast('已清理 worktree')
      await reload()
    } catch (e) { toast(e.message) }
    finally { setRemovingWt(false) }
  }

  // 不可投递的族隐藏投递按钮: 按看板 capabilities.chat 判定(后端按 agent 族下发);
  // 未加载到时按当前唯一族 dsh 兜底(不投递=只保存评论; 运行中投递由后端 409/400 提示)
  const isDsh = boardCaps ? !boardCaps.chat : true

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className={'modal modal-rz board-detail-modal w-[52vw] h-auto max-h-[90vh] sm:max-w-[94vw] overflow-y-auto' + (rzOn ? ' rz-drag' : '')}
        style={{ ...rzStyle, marginTop: 0 }}
        showCloseButton={false}
      >
        <RzHandles start={rzStart} reset={rzReset} />
        <DialogHeader className="text-left">
          <DialogTitle className="cursor-move select-none text-sm break-words" onMouseDown={rzDragStart}>
            #{card.id} {card.title || '未命名'}
          </DialogTitle>
        </DialogHeader>
        <div className="board-detail">
          {/* 📝 标题 / 描述（一体编辑：第一行=标题，其余=描述） */}
          <div className="board-sec">
            <div className="board-sec-t">📝 标题 / 描述
              {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>✏ 编辑</Button>}
            </div>
            {editing ? (<>
              <div className="hint">第一行为标题，其余为描述；支持粘贴/拖入图片与文件（存为附件，10MB 内）；Ctrl+Enter 保存</div>
              <Textarea ref={draftRef} rows={10} value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={onPasteFiles} onDrop={onDropFiles}
                onKeyDown={(e) => {
                  // Ctrl+Enter 保存（与「保存」按钮同逻辑；防止直接换行）
                  if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault()
                    if (!uploading) saveDesc()
                  }
                }}
                placeholder={'第一行为标题（空则显示「未命名」），其余为描述…'} />
              <div className="mt-1 flex gap-2">
                <Button size="sm" onClick={saveDesc} disabled={uploading}>
                  {uploading ? '附件上传中…' : '保存'}</Button>
                <Button size="sm" variant="outline"
                  onClick={() => { setEditing(false); setDraft(card.title + '\n' + (card.description || '')) }}>取消</Button>
              </div>
            </>) : <div className="md-body" dangerouslySetInnerHTML={descHtml}></div>}
          </div>

          {/* ⏰ 定时（仅 todo 列可设） */}
          {card.column === 'todo' && (
            <div className="board-sec">
              <div className="board-sec-t">⏰ 定时开工</div>
              <Input type="datetime-local"
                value={schedule || (card.scheduled_at ? toLocalInput(card.scheduled_at) : '')}
                onChange={(e) => saveSchedule(e.target.value)} />
              <div className="hint">到点自动进入「正在开发」（受串行门禁约束）</div>
            </div>
          )}

          {/* 🌿 独立 worktree（「在新 worktree 中开始」起跑的卡）：只读展示路径与分支 +
              清理入口（后端判据：会话运行中 409 / 工作树有未提交改动 400；平台不自动删分支） */}
          {card.worktree && (
            <div className="board-sec">
              <div className="board-sec-t">🌿 独立 worktree
                <Button size="sm" variant="ghost" disabled={removingWt}
                  title="删除该独立工作树目录（会话运行中或工作树有未提交改动时会被后端拒绝）"
                  onClick={removeWorktree}>{removingWt ? '清理中…' : '清理 worktree'}</Button>
              </div>
              <div className="hint break-all" title={card.worktree}>
                <span className="font-mono">{card.worktree}</span>（分支 ts/card-{card.id}）
              </div>
            </div>
          )}

          {/* 💬 相关会话（行显示标题，单击行即打开会话详情；按钮区独立不触发行点击） */}
          <div className="board-sec">
            <div className="board-sec-t">💬 相关会话</div>
            {(card.sessions || []).map((sid) => (
              <div key={sid}
                className="flex items-center gap-1 py-0.5 text-xs cursor-pointer hover:bg-accent/40 rounded px-1 -mx-1"
                title={`点击查看会话 ${sid}`}
                onClick={() => setViewSid(sid)}>
                <span className="flex-1 min-w-0 truncate">
                  {sessTitles[sid] || <span className="font-mono">{sid}</span>}
                </span>
                {sessTitles[sid] && <span className="font-mono text-muted-foreground">{sid.slice(0, 8)}</span>}
                {sid === card.session_id && <span className="bug-status pass">主</span>}
                <Button size="sm" variant="ghost" title="复制 id"
                  onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(sid); toast('已复制') }}><Copy /></Button>
                {sid !== card.session_id && (
                  <Button size="sm" variant="ghost" title="设为主会话"
                    onClick={(e) => { e.stopPropagation(); save({ session_id: sid }) }}>设主</Button>)}
                <Button size="sm" variant="ghost" title="解绑"
                  onClick={(e) => { e.stopPropagation(); save({ unbind_session: sid }) }}>✂</Button>
                {boardCaps?.compact && (
                  <Button size="sm" variant="ghost" title="compact 压缩会话上下文"
                    onClick={async (e) => {
                      e.stopPropagation()
                      try { await boardApi.compact(projectId, card.id, sid); toast('compact 已触发') }
                      catch (e2) { toast(e2.message) }
                    }}><Shrink /></Button>)}
                {boardCaps?.fork && (
                  <Button size="sm" variant="ghost" disabled={forking}
                    title="压缩并新建：压缩会话内容并新建会话（新会话只含压缩摘要、无历史轮次，原会话保留）"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (forking) return
                      setForking(true)
                      try {
                        const r = await boardApi.forkCompact(projectId, card.id, sid)
                        toast('已新建会话并注入压缩内容')
                        await save({ bind_session: r.new_sid })
                      } catch (e2) { toast(e2.message) }
                      finally { setForking(false) }
                    }}>{forking ? '压缩中…' : <CopyPlus />}</Button>)}
                {boardCaps?.fork && (
                  <Button size="sm" variant="ghost" disabled={forkingSess}
                    title="fork 会话：完整复制为新会话（历史/上下文全量保留）并加入卡片会话列表（不改变主会话，需要时点「设主」）"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (forkingSess) return
                      setForkingSess(true)
                      try {
                        const r = await boardApi.forkSession(projectId, card.id, sid)
                        toast('已 fork 新会话并加入卡片会话列表')
                        await save({ bind_session: r.new_sid })
                      } catch (e2) { toast(e2.message) }
                      finally { setForkingSess(false) }
                    }}>{forkingSess ? 'fork 中…' : <GitFork />}</Button>)}
                <Button size="sm" variant="ghost" title="查看会话"
                  onClick={(e) => { e.stopPropagation(); setViewSid(sid) }}>🔍</Button>
              </div>
            ))}
            {/* 绑定已有会话：搜索下拉（空输入=全部会话，输入即过滤标题/sid，可搜索或直接粘贴 sid），含已绑定/已归档标记 */}
            <div className="mt-1 flex gap-1">
              <SearchSelect className="flex-1" placeholder="搜索或选择已有会话…"
                emptyHint="工作区暂无会话"
                options={availSess.map((s) => ({
                  value: s.sid,
                  label: `${s.title || s.sid.slice(0, 12)}（${new Date(s.mtime * 1000).toLocaleString()}）` +
                    (s.bound ? ' [已绑定]' : '') + (s.archived ? ' [已归档]' : ''),
                  search: s.sid,
                }))}
                value={bindSid} onChange={setBindSid} />
              <Button size="sm" variant="outline" disabled={!bindSid.trim()}
                onClick={async () => { await save({ bind_session: bindSid.trim() }); setBindSid('') }}>绑定</Button>
            </div>
          </div>

          {/* 🔗 父任务依赖（搜索下拉：空输入=全部卡片，输入即过滤标题/列名） */}
          <div className="board-sec">
            <div className="board-sec-t">🔗 父任务依赖</div>
            <SearchSelect placeholder="选择父任务卡片…"
              emptyHint="没有匹配的卡片"
              options={[{ value: '', label: '（无依赖）' }].concat(
                allCards.filter((c) => c.id !== card.id).map((c) => ({
                  value: String(c.id),
                  label: `#${c.id} ${c.title || '未命名'}（${c.column}）`,
                  search: c.title || '',
                })))}
              value={card.parent_card_id ? String(card.parent_card_id) : ''}
              onChange={(v) => save({ parent_card_id: v ? +v : null })} />
            {allCards.filter((c) => c.id !== card.id).length === 0 && (
              <div className="hint">暂无其他卡片可作为父任务</div>)}
          </div>

          {/* 💭 评论区（Ctrl+Enter 仅保存；➤ 保存并投递主会话） */}
          <div className="board-sec">
            <div className="board-sec-t">💭 评论</div>
            {(comments || []).map((m) => (
              <div key={m.id} className="py-1 text-xs">
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">{m.created_at}</span>
                  {m.sent && <span className="bug-status pass">✓ 已投递</span>}
                  <span className="flex-1"></span>
                  {!m.sent && !isDsh && (
                    <Button size="sm" variant="ghost" title="投递到主会话"
                      onClick={async () => {
                        try { await boardApi.sendComment(projectId, card.id, m.id); await reload() }
                        catch (e) { toast(e.message) }
                      }}><Send /></Button>)}
                  <Button size="sm" variant="ghost" title="删除"
                    onClick={async () => { try { await boardApi.removeComment(projectId, card.id, m.id); await reload() } catch (e) { toast(e.message) } }}><Trash2 /></Button>
                </div>
                {/* 评论由纯文本改为 markdown 渲染(描述同方案): 附件 abs 引用经 absToMedia 改写
                    为项目媒体端点 URL, renderMd 渲染缩略图/文件链接; 多行段落语义与 pre-wrap 不同属预期 */}
                <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMd(absToMedia(m.text, projectId)) }}></div>
              </div>
            ))}
            <Textarea rows={3} placeholder={isDsh ? '评论（dsh 不支持投递，仅保存）' : '评论（Ctrl+Enter 保存）'}
              value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) addComment(false) }} />
            <div className="mt-1 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => addComment(false)}>保存</Button>
              {!isDsh && (
                <Button size="sm" onClick={() => addComment(true)}
                  disabled={!card.session_id} title={card.session_id ? '' : '尚无会话，请先开始开发'}>
                  <Send /> 保存并投递
                </Button>)}
            </div>
          </div>
        </div>

        {/* 会话查看：复用任务会话弹窗的 board 模式（轮询增量 + capabilities 门控输入区） */}
        {/* column 透传：会话窗「通过」按钮按卡片所在列显隐（正在开发/待审核） */}
        <SessionModal
          board={viewSid ? { projectId, sid: viewSid, cid: card.id, column: card.column,
                             title: card.title } : null}
          onSwitchSession={setViewSid}
          onClose={() => setViewSid(null)} />
      </DialogContent>
    </Dialog>
  )
}

// datetime-local 输入框值（本地时区 YYYY-MM-DDTHH:mm）
function toLocalInput(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
