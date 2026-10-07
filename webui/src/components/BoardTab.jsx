// 看板 tab：五列（待开发/正在开发/阻塞/待审核/已完成）+ 自定义指针拖拽移列
// （6px 阈值：先按下再轻微移动不触发拖拽，避免误吞点击——单击稳定打开详情/编辑标题；
// 拖起后 ghost 克隆浮起跟手、悬停实时腾位预览、松手从落点飞入槽位、拖空/Esc 飞回原列）。
// 数据：组件内 state + **服务端事件唤醒**（P4 事件化：SSE `hello`/`refresh` → 去抖重取，
// 60s 兜底；tab 未激活时 Radix 卸载本组件，连接自动关闭）。
// 移列/开始统一走后端仲裁：父任务未完成 → 弹确认框；queue → 落「正在开发」列排队占位（P4 起单态 doing+queue，队序即展示序）。
import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, Fragment } from 'react'
import { boardApi, prefsApi, projectApi } from '../api'
import { toast } from '../utils/toast'
import { QUEUE_STATE_LABEL, queueStateChipClass } from '../utils/queueBadge'
import { ST_LABEL } from '../utils/renderMd'
import { findSlashToken } from '../utils/slashToken'
import { isPlaceholderImage } from '../utils/media'
import { mediaDisplayUrl } from '../utils/mediaText'
import { openSessionInDsh } from '../lib/dshHost'
import { useDshHostCaps } from '../hooks/useDshHost'
import BoardDetail from './BoardDetail.jsx'
import BoardTrash from './BoardTrash.jsx'
import SessionModal from './SessionModal'
import SlashMenu from './SlashMenu'
import ActionMenu from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Play, Trash2, Check, Undo2, ArrowRight, Plus, Settings, MessageSquare, FileText, Maximize2, ExternalLink, X } from 'lucide-react'

const DRAG_THRESHOLD = 6  // 拖拽触发阈值（px）：低于该位移视为点击
const MEDIA_MAX = 10 * 1024 * 1024  // 卡片附件单文件上限（与后端 board/media、描述编辑框一致）

// 任务类型标签（测试任务上板徽标用；与 TasksTab 保持一致）
const TASK_TYPE_LABEL = { normal: '探索', fix: '修复', retest_bug: '复测', script_retest: '脚本复测', stress: '压测', regression: '回归', pipeline: '后段', reject: '修例' }
// 任务条目上映列（v2c T4，裁决 R16；v2 §2.1【已定】列映射）：进行中→doing、
// 失败/中断/停止→review、完成→done（服务端 payload 条目标 column 字段）
const TASK_COLS = new Set(['doing', 'review', 'done'])
// 任务条目状态徽标色（.bug-status 族；读 DB status 口径保留，specQ §7 注记）：
// running/queued/done 专色，failed/interrupted/stopped 同走 retest 橙（失败族）
const TASK_ST_CLASS = { running: 'run', queued: 'pending', done: 'pass' }
// 每列过滤方案：all=全部（开发卡+测试任务）dev=仅开发卡 test=仅测试任务（按 用户+项目 记忆）
const FILTER_OPTIONS = [['all', '全部'], ['dev', '仅开发'], ['test', '仅测试']]

const COLUMNS = [
  { key: 'todo', label: '待开发' },
  { key: 'doing', label: '正在开发' },
  { key: 'blocked', label: '阻塞' },
  { key: 'review', label: '待审核' },
  { key: 'done', label: '已完成' },
]
// 列排序方案选项（entered_desc 仅已完成列——进入时间新→旧）
const SORT_BASE = [['manual', '手动'], ['created_desc', '创建新→旧'], ['updated_desc', '更新新→旧'], ['title', '标题']]
const SORT_OPTIONS = (col) => col === 'done'
  ? [['entered_desc', '进入新→旧'], ...SORT_BASE]
  : SORT_BASE
const MODE_LABEL = { serial: '串行', parallel: '并行' }

// doing 列分区与三手势（v2 §2.4；v2c T3 接线，服务端 _doing_gesture 为仲裁权威）：
// 视觉分区=queue_state running/starting（含 sync 外部运行卡——v2c→v2d 接口：
// ext 条目落前缀区展示）；
// 手势判定对齐服务端行权威（fix round 1/2，F2）：等待区=
// block_kind==='queue' 且非 answer_pending——P4 单写不变量「占位在⟺c: 等待行
// 在」，与服务端 _waiting_cards_above 只数 c: WAITING 行同口径（仅 m: 行排队
// 的 msg_queued 卡、a: 行占位卡都不算等待卡——徽标同为 queued_serial/answer_
// pending 是展示枚举，不作手势依据）；运行位=非 answer_pending 且
// （card.running（平台在管 _RUNS）或 queue_state starting（c: 行 starting））——
// 剔除 busy 派生的外部运行（sync/外部 busy 卡无 c: 行，服务端按无手势 no-op，
// 同口径不触发）；answer_pending 再排除（fix round 2）：真实待送达卡
// （_queue_answer_unit 产出：a: 行+占位、c: 行已防御性取消）在待送达窗口
// running=true，但服务端 get_active(KIND_CARD)=None 一律 no-op——排除后回
// zone none 与服务端对齐（fix-round-1 含 running 会把 force/停止确认框说成
// 谎）；双形态卡（c: 行在+a: 行在）随之同落 none=死手势安全侧（根治需
// card_json 下发 c: 行派生字段——v2 批次 ext 口径未落地该字段，归 v2 批次
// 终审/后续任务，v2d 收口轮记账：本轮零前端改动）
const isRunZone = (c) => c.queue_state === 'running' || c.queue_state === 'starting'
const isRunGesture = (c) => !c.answer_pending
  && (!!c.running || c.queue_state === 'starting')
const isWaitGesture = (c) => c.block_kind === 'queue' && !c.answer_pending

export default function BoardTab({ project }) {
  const projectId = project?.id
  const dshCaps = useDshHostCaps()                   // dsh 宿主能力（面板形态才非空；决定「在 dsh 打开」按钮显隐）
  const [data, setData] = useState(null)          // {cards, comments, settings}
  const [selId, setSelId] = useState(null)        // 详情面板卡片 id
  const [dragOver, setDragOver] = useState(null)  // 拖拽悬停列
  const [query, setQuery] = useState('')          // 搜索词：非空时全看板只显示匹配卡
  // 每列过滤方案 {colKey: 'all'|'dev'|'test'}：all=全部 dev=仅开发卡 test=仅测试任务
  const [filters, setFilters] = useState({})
  const [sessTask, setSessTask] = useState(null)  // 点击任务条目打开的会话弹窗（task 模式）
  // 打回意见 / 依赖确认 两个弹窗
  const [rejectFor, setRejectFor] = useState(null)
  const [rejectText, setRejectText] = useState('')
  const [depFor, setDepFor] = useState(null)      // {cardId, action:'start'|'move', column?}
  // 「在新 worktree 中开始」（独立工作树起跑）相关：
  const [wtPrev, setWtPrev] = useState({})        // 预览缓存 {cardId: {supported,reason,path,branch}}（菜单打开时取）
  const [wtFor, setWtFor] = useState(null)        // 二次确认弹窗 {card, preview?}（preview 拿不到则路径/分支行不显示）
  const wtPrevRef = useRef({})                    // 预览镜像：异步回填时读最新（防闭包过期）
  const [settingsOpen, setSettingsOpen] = useState(false)  // 看板设置弹窗开关
  const [trashOpen, setTrashOpen] = useState(false)        // 回收站弹窗开关
  const [sessFor, setSessFor] = useState(null)        // 主会话直达弹窗 {sid, cid, title}（SessionModal board 模式）
  // 标题行内编辑（单击标题进入；Enter/失焦保存，Esc 取消；编辑期间照常可点其他卡片）
  const [editId, setEditId] = useState(null)      // 正在编辑标题的卡片 id
  const [editTitle, setEditTitle] = useState('')
  const editIdRef = useRef(null)                  // 镜像 editId，防 Enter 后 blur 双触发重复保存
  // 自定义指针拖拽状态（阈值判定；不用 HTML5 draggable，避免轻微移动吞掉 click）
  const [dragId, setDragId] = useState(null)      // 拖拽中的卡片 id（置灰跟随）
  const dragRef = useRef(null)                    // {id, sx, sy, on}
  const suppressClickRef = useRef(false)          // 拖拽结束后吞掉紧随的 click
  const cardsRef = useRef([])                     // cards 镜像：窗口级事件处理器读取最新列表
  const dataRef = useRef(null)                    // data 镜像：拖拽回退/落点计算读最新
  const flipSnap = useRef(null)                   // FLIP：状态变化前的全卡位置快照
  const refreshTimerRef = useRef(null)            // SSE refresh 去抖定时器（P4 事件化）
  const startCardsRef = useRef(null)              // 拖拽开始时的 cards（拖空/Esc 回退）
  const previewRef = useRef(null)                 // 拖拽当前预览落点 {col, index}
  const ghostRef = useRef(null)                   // ghost DOM + 抓取偏移 {el, dx, dy}
  const origColumnRef = useRef(null)              // 拖拽开始时卡片所在列（判定用）

  async function reload() {
    if (!projectId) return
    if (dragRef.current?.on) return  // 拖拽进行中不轮询，防覆盖本地预览态
    try {
      flipSnap.current = snapshotRects()  // 轮询/他端改动引起的换位也有动画
      setData(await boardApi.get(projectId))
    } catch (e) { toast(e.message) }
  }
  useEffect(() => {
    setData(null); setSelId(null); setSessFor(null); setQuery(''); setSessTask(null)
    setWtFor(null); setWtPrev({}); wtPrevRef.current = {}   // 换项目清空 worktree 预览缓存
    reload()
    // 列过滤方案按 用户+项目 记忆（user_prefs，key=board_filters）；失败回落全显
    prefsApi.get(projectId).then((r) => setFilters(r.prefs?.board_filters || {})).catch(() => {})
    // P4 事件化（2026-10-03）：数据源由「5s 轮询」改为**服务端事件唤醒**——
    // SSE 收到 hello（连接就绪）/refresh（卡片写路径或本会话 dsh 状态帧）才重取，
    // 300ms 合并抖动；60s 兜底一次（SSE 静默失效/事件丢失的最后防线，不是状态轮询）。
    // 拖拽中 reload 自带跳过，拖拽结束后的下一次事件或兜底会补上。
    let es = null
    const scheduleReload = () => {
      if (refreshTimerRef.current) return
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null
        reload()
      }, 300)
    }
    try {
      es = boardApi.stream(projectId)
      es.addEventListener('hello', scheduleReload)
      es.addEventListener('refresh', scheduleReload)
      // 断线由 EventSource 自动重连（重连后照常先收 hello），无需手工处理 onerror
    } catch { /* 环境不支持 EventSource：退回 60s 兜底 */ }
    const t = setInterval(reload, 60000)
    return () => {
      clearInterval(t)
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null }
      try { es?.close() } catch { /* 已关闭 */ }
    }
  }, [projectId])

  // 切换某列过滤方案：本地生效 + 落服务端（失败静默，过滤记忆尽力而为）
  function changeFilter(col, v) {
    setFilters((prev) => {
      const next = { ...prev, [col]: v }
      prefsApi.set(projectId, 'board_filters', next).catch(() => {})
      return next
    })
  }

  const cards = useMemo(() => data?.cards || [], [data])
  cardsRef.current = cards
  dataRef.current = data
  /* ---------- FLIP：快照→反向贴回→过渡归零（跨列飞行/列内重排/排序切换/回退共用） ---------- */
  function snapshotRects() {
    const m = new Map()
    document.querySelectorAll('.board-card[data-card-id]').forEach((el) => {
      m.set(el.dataset.cardId, el.getBoundingClientRect())
    })
    return m
  }
  useLayoutEffect(() => {
    const snap = flipSnap.current
    flipSnap.current = null
    if (!snap) return
    for (const [id, r] of snap) {
      const el = document.querySelector(`[data-card-id="${id}"]`)
      if (!el) continue
      const nr = el.getBoundingClientRect()
      const dx = r.left - nr.left
      const dy = r.top - nr.top
      if (!dx && !dy) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      el.getBoundingClientRect() // 强制 reflow：初始 transform 生效后再开过渡
      el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      el.style.transform = ''
    }
  })
  const selCard = cards.find((c) => c.id === selId) || null
  const commentsOf = (cid) => (data?.comments || []).filter((m) => m.card_id === cid)

  /* ---------- 移列 / 拖排：乐观更新先行（动画即时），失败 toast+reload 对齐 ---------- */
  // 本地把卡放到目标列第 index 张之前（index 超界=列尾）；仅改内存，不发请求
  function localPlace(cards, cardId, col, index) {
    const card = cards.find((c) => c.id === cardId)
    if (!card) return cards
    const rest = cards.filter((c) => c.id !== cardId)
    const inCol = rest.filter((c) => c.column === col)
    const anchor = inCol[Math.min(Math.max(index, 0), inCol.length)]
    const placed = { ...card, column: col }
    if (!anchor) return [...rest, placed]
    const at = rest.findIndex((c) => c.id === anchor.id)
    return [...rest.slice(0, at), placed, ...rest.slice(at)]
  }
  function optimisticMove(card, col, index = Infinity) {
    setData((d) => !d ? d : { ...d, cards: localPlace(d.cards, card.id, col, index) })
  }
  async function requestMove(card, column, block_text, beforeId = null) {
    try {
      const r = await boardApi.moveCard(projectId, card.id, column, block_text, beforeId)
      if (r.blocked === 'parent-not-done') {
        await reload()
        setDepFor({ cardId: card.id, action: 'move', column })
        return
      }
      await reload()
    } catch (e) { toast(e.message); await reload() }
  }
  async function requestReorder(cardId, beforeId) {
    try { await boardApi.reorderCard(projectId, cardId, beforeId); await reload() }
    catch (e) { toast(e.message); await reload() }
  }
  async function doMove(card, column, block_text) {
    flipSnap.current = snapshotRects()  // 按钮移列：从原位飞往新列
    optimisticMove(card, column)
    await requestMove(card, column, block_text)
  }
  // 切换列排序方案（逐列合并上报；reload 前快照让整列重排有动画）
  async function changeSort(col, mode) {
    try {
      await boardApi.updateSettings(projectId, { sort: { [col]: mode } })
      await reload()
    } catch (e) { toast(e.message) }
  }
  // 开始开发：worktree=true 时由平台新建独立 git worktree 执行该卡（不进项目开发队列，
  // 立即可跑，故不会出现「排队中」落列）；父依赖门禁与入队路径与主按钮完全一致
  async function doStart(card, opinion, force, worktree) {
    try {
      const r = await boardApi.startCard(projectId, card.id, opinion, force, worktree)
      if (r.blocked === 'parent-not-done') {
        // 记下本次是否 worktree 起跑：拦截弹窗的「强制开始」要保留同一语义，
        // 否则用户在 worktree 确认框里点强制会被悄悄改成主仓库起跑
        setDepFor({ cardId: card.id, action: 'start', worktree: !!worktree })
        return
      }
      // 两条成功提示互斥：worktree 起跑不入队，正常起跑落 doing/queue 才提示排队
      if (worktree) toast('已在独立 worktree 中开始')
      else if (r.card?.column === 'blocked') toast('已加入统一队列排队')
      await reload()
    } catch (e) { toast(e.message) }
  }
  // worktree 预览（GET .../cards/<cid>/worktree，只读不落盘）：菜单打开/二次确认时取一次并缓存。
  // 语义：supported===false 置灰并显示中文 reason；**请求失败也置灰**——旧后端
  // （改完前端但没重启站点）没有该端点，若按「未知」放行，用户点了会走到旧 start
  // 端点把 worktree=true 静默忽略、卡片其实起在主仓库（新前端还会误报「已在独立
  // worktree 中开始」）。宁可先置灰并说明「需重启站点」，也不做静默错误降级。
  async function loadWorktreePreview(cardId) {
    let p
    try {
      p = await boardApi.worktreePreview(projectId, cardId)
    } catch (e) {
      p = { supported: false, reason: '无法获取 worktree 预览（后端未重启或接口不可用）' }
    }
    wtPrevRef.current = { ...wtPrevRef.current, [cardId]: p }
    setWtPrev(wtPrevRef.current)
    return p
  }
  // 菜单项置灰原因（空串=可选）：① 已有主会话（后端 D10：会话在 project_dir 建过，切 worktree
  // 会造成「平台以为在工作树、agent 实际在主仓库」的静默背离）；② 预览 supported=false（含取数失败）
  function worktreeBlockReason(card) {
    if (card.session_id) return '该卡片已有主会话，不能切换到独立 worktree'
    const p = wtPrev[card.id]
    if (p && p.supported === false) return p.reason || '当前项目不支持独立 worktree'
    return ''
  }
  // 打开「在新 worktree 中开始」二次确认框：先按缓存渲染（路径/分支可能暂缺），
  // 再补取一次预览回填（取不到就不显示路径/分支两行，仍可继续）
  async function openWorktreeConfirm(card) {
    setWtFor({ card, preview: wtPrevRef.current[card.id] || null })
    const p = await loadWorktreePreview(card.id)
    if (p) setWtFor((s) => (s && s.card.id === card.id ? { ...s, preview: p } : s))
  }
  // 「立即送达」已作答·待送达的答案（answer_pending 卡片操作行）：
  // 不等项目空闲，直接把答案交给等待中的会话；送达后卡片解除排队占位
  async function doDeliverAnswer(card) {
    try {
      await boardApi.deliverAnswer(projectId, card.id)
      toast('已送达答案')
      await reload()
    } catch (e) { toast(e.message) }
  }
  // 等待区卡停止入口（v2b T3，R9：任意队列中卡可停止→待审核）：
  // 后端取消排队（c: 等待行）并落待审核；同端点对运行中会话为停止
  async function doStop(card) {
    try { await boardApi.stopCard(projectId, card.id); await reload() }
    catch (e) { toast(e.message) }
  }
  // 依赖确认框点「强制开始」：start 动作经 force=true 透传后端跳过父依赖与排队；
  // move 动作不支持 force，维持原样（仅提示，不强制放行）
  async function removeCard(card) {
    try {
      await boardApi.removeCard(projectId, card.id)
      setSelId(null)
      toast('已移入回收站（可从回收站还原）')
      await reload()
    } catch (e) { toast(e.message) }
  }
  // doStart 镜像：窗口级指针处理器在首渲染闭包里固定，经 ref 取最新实现
  const doStartRef = useRef(doStart); doStartRef.current = doStart

  /* ---------- 标题行内编辑 ---------- */
  function startEdit(card) {
    editIdRef.current = card.id
    setEditId(card.id)
    setEditTitle(card.title)
  }
  function cancelEdit() {
    editIdRef.current = null
    setEditId(null)
  }
  async function saveTitle(card) {
    if (editIdRef.current !== card.id) return  // 已取消/已保存（Enter 后 blur 会再触发一次）
    const t = editTitle.trim()
    editIdRef.current = null
    setEditId(null)
    if (!t || t === card.title) return          // 空标题/未改动：不请求，直接退出编辑
    try { await boardApi.updateCard(projectId, card.id, { title: t }); await reload() }
    catch (e) { toast(e.message) }
  }

  // 窗口级拖拽处理器经 ref 取最新实现（防重渲染闭包过期）
  const beginDragRef = useRef(beginDrag); beginDragRef.current = beginDrag
  const moveGhostRef = useRef(moveGhost); moveGhostRef.current = moveGhost
  const previewToRef = useRef(previewTo); previewToRef.current = previewTo
  const finishDragRef = useRef(finishDrag); finishDragRef.current = finishDrag
  const requestMoveRef = useRef(requestMove); requestMoveRef.current = requestMove
  const requestReorderRef = useRef(requestReorder); requestReorderRef.current = requestReorder
  const sortModeOfRef = useRef(sortModeOf); sortModeOfRef.current = sortModeOf
  const onDragKeyRef = useRef(null)  // Esc 取消：beginDrag 挂、finishDrag 摘

  /* ---------- 自定义指针拖拽（6px 阈值防吞点击）----------
     拖起=原卡转 drag-gap 空隙 + ghost 克隆浮起跟手；悬停=实时预览落点
     （其他卡 FLIP 让位）；松手=从 ghost 位置飞进槽位；拖空/Esc=飞回原列。 */
  const onCardPointerDown = useCallback((e, card) => {
    if (e.button !== 0) return
    if (e.target.closest('button, a, input, textarea, select')) return
    dragRef.current = { id: card.id, sx: e.clientX, sy: e.clientY, on: false }
    suppressClickRef.current = false
    window.addEventListener('pointermove', onCardPointerMove)
    window.addEventListener('pointerup', onCardPointerUp)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // 指针落点 → {列key, 列内插入 index, 列内卡 DOM id 序（不含拖拽中的卡）}：
  // 按列内卡片中线判定。domIds 供 finishDrag 反查落点邻卡——doing 列分区
  // 重组序与 payload 下发序可能分叉（answer_pending 双形态卡等），索引只认
  // DOM 序，杜绝双序错位（fix round 1，F1）
  function dropTarget(x, y, dragCardId) {
    const colEl = document.elementFromPoint(x, y)?.closest?.('.board-col')
    if (!colEl) return null
    const col = colEl.dataset.col
    const els = [...colEl.querySelectorAll('.board-card')]
      .filter((el) => el.dataset.cardId !== String(dragCardId))
    let index = els.length
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) { index = i; break }
    }
    return { col, index, domIds: els.map((el) => el.dataset.cardId) }
  }

  // 列排序模式（Task 8 前恒 manual 兜底；settings.sort 下发后自动生效）
  function sortModeOf(col) {
    return dataRef.current?.settings?.sort?.[col] || (col === 'done' ? 'entered_desc' : 'manual')
  }

  // 按列排序方案整理展示顺序（manual=后端 sort_order 原序；时间为字符串可直接字典序比较）
  function sortList(list, col) {
    const mode = sortModeOf(col)
    if (mode === 'manual') return list
    const s = [...list]
    if (mode === 'created_desc') s.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    else if (mode === 'updated_desc') s.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    else if (mode === 'title') s.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'))
    else if (mode === 'entered_desc') s.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''))
    return s
  }

  // 搜索匹配：标题/描述/jira_key 大小写不敏感子串；空词全匹配
  function matchCard(c) {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (c.title || '').toLowerCase().includes(q)
      || (c.description || '').toLowerCase().includes(q)
      || (c.jira_key || '').toLowerCase().includes(q)
  }

  // 拖拽开始：记回退快照与原列，建 ghost（克隆卡片浮起跟手）
  function beginDrag(cardId, e) {
    const card = cardsRef.current.find((c) => c.id === cardId)
    origColumnRef.current = card?.column || null
    startCardsRef.current = dataRef.current?.cards || null
    previewRef.current = null
    const el = document.querySelector(`[data-card-id="${cardId}"]`)
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ghost = el.cloneNode(true)
    ghost.className = ghost.className.replace(' drag-gap', '') + ' board-ghost'
    Object.assign(ghost.style, {
      position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', margin: '0', zIndex: 999,
      pointerEvents: 'none', opacity: '0.95',
      transform: 'scale(1.04) rotate(1.5deg)',
      boxShadow: '0 16px 32px rgba(0,0,0,.28)',
      transition: 'none',
    })
    document.body.appendChild(ghost)
    ghostRef.current = { el: ghost, dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    onDragKeyRef.current = (ev) => {
      // Esc 取消：须同时清 dragRef，让后续 pointermove/pointerup 全部空转
      // （否则松手时会按当前落点二次 finishDrag，把已取消的拖拽再提交成 move/start）
      if (ev.key === 'Escape') { suppressClickRef.current = true; dragRef.current = null; finishDragRef.current(cardId, -1, -1) }
    }
    window.addEventListener('keydown', onDragKeyRef.current)
  }

  function moveGhost(e) {
    const g = ghostRef.current
    if (!g) return
    g.el.style.left = e.clientX - g.dx + 'px'
    g.el.style.top = e.clientY - g.dy + 'px'
  }

  // 悬停落点变化 → 本地实时预览（不发请求，其他卡让位有 FLIP 动画）
  function previewTo(card, t) {
    const cur = previewRef.current
    if (cur && cur.col === t.col && cur.index === t.index) return
    const sameCol = t.col === card.column
    if (sameCol && t.col !== 'doing' && sortModeOf(t.col) !== 'manual') return  // 非 manual 列禁列内拖排预览；doing 列队序即展示序不限排序方案（v2c T3）
    previewRef.current = t
    setDragOver(t.col)
    flipSnap.current = snapshotRects()
    optimisticMove(card, t.col,
      !sameCol && sortModeOf(t.col) !== 'manual' ? Infinity : t.index)
  }

  // 借 ref 固定窗口级处理器（组件重渲染不换函数，避免重复挂载）
  const onCardPointerMove = useRef((e) => {
    const d = dragRef.current
    if (!d) return
    if (!d.on) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return
      d.on = true
      beginDragRef.current(d.id, e)
      setDragId(d.id)
    }
    moveGhostRef.current(e)
    const card = cardsRef.current.find((c) => c.id === d.id)
    if (!card) return
    const t = dropTarget(e.clientX, e.clientY, d.id)
    if (t) previewToRef.current(card, t)
  }).current

  function finishDrag(cardId, x, y) {
    const g = ghostRef.current
    ghostRef.current = null
    const ghostRect = g ? g.el.getBoundingClientRect() : null
    g?.el.remove()
    const t = dropTarget(x, y, cardId)
    const snap = snapshotRects()
    if (ghostRect) snap.set(String(cardId), ghostRect)  // 该卡「变化前位置」以 ghost 为准
    flipSnap.current = snap
    const start = startCardsRef.current
    startCardsRef.current = null
    previewRef.current = null
    setDragId(null)
    setDragOver(null)
    const card = (dataRef.current?.cards || []).find((c) => c.id === cardId)
    if (!card) { reload(); return }
    const origCol = origColumnRef.current
    origColumnRef.current = null
    if (!t) {  // 拖空 / Esc：回退本地预览（该卡从 ghost 位置飞回原位）
      if (start) setData((d0) => d0 && { ...d0, cards: start })
      return
    }
    if (t.col === 'doing' && origCol !== 'doing') {  // 拖入 doing = 开始开发（回退预览走原 doStart 门禁）
      if (start) setData((d0) => d0 && { ...d0, cards: start })
      doStartRef.current(card)
      return
    }
    if (t.col === origCol) {
      if (t.col === 'doing') {
        // doing 同列：三手势分流（v2 §2.4；v2c T3 接线——服务端 _doing_gesture
        // 为仲裁权威；确认框沿用 ⚡ window.confirm 先例，v2 §4 已定 2；T2 起
        // doing 列 requestReorder 退役，调序/force/停止统一走 move 的
        // before_id 语义）。落点邻卡按 DOM 分区序反查（fix round 1，F1：
        // t.domIds 与 dropTarget 的 index 同源——payload 下发序与分区渲染序
        // 可能分叉，answer_pending 双形态卡等场景下按 payload 序取邻卡会错位）
        const byId = new Map((dataRef.current?.cards || []).map((c) => [String(c.id), c]))
        const others = (t.domIds || []).map((id) => byId.get(id)).filter(Boolean)
        const beforeCard = others[t.index] ?? null      // 落点后第一张卡（undefined=列尾）
        const zone = !beforeCard ? 'waiting'            // 列尾=等待区区尾（同服务端）
          : isRunGesture(beforeCard) ? 'prefix'
          : isWaitGesture(beforeCard) ? 'waiting'
          : 'none'                                      // 非队列卡（sync/idle/answer 占位）
        let action = null   // 'force' | 'stop' | 'reorder' | null(no-op)
        if (isWaitGesture(card) && zone === 'prefix') {
          action = 'force'                              // 手势① 上跨运行位=强制运行
        } else if (isRunGesture(card) && zone === 'waiting'
                   && others.slice(0, t.index).filter(isWaitGesture).length > 0) {
          action = 'stop'                               // 手势② 拖到等待卡后面=停止当前任务
                                                      // （严格判定与服务端一致：落点上方
                                                      //  须有等待卡，否则=运行位尾 no-op）
        } else if (isWaitGesture(card) && zone === 'waiting') {
          action = 'reorder'                            // 手势③ 等待区内部调序（无确认）
        }
        if (action === 'force'
            && !window.confirm('强制运行：立即启动该卡片（落哪算哪）？')) action = null
        if (action === 'stop'
            && !window.confirm('停止当前任务？停止后卡片进入待审核。')) action = null
        if (!action) {
          // 运行位互拖 / 非队列卡互拖 / 确认取消：本地预览回弹原位，无请求
          if (start) setData((d0) => d0 && { ...d0, cards: start })
          return
        }
        requestMoveRef.current(card, 'doing', undefined, beforeCard?.id ?? null)
        return
      }
      // 其余列同列 manual 拖排（预览态已是结果，提交 reorder 即可）
      if (sortModeOfRef.current(t.col) !== 'manual') return  // 非 manual 列内拖拽禁用：静默无效（ghost 飞回即放回原处）
      const others = (dataRef.current?.cards || []).filter((c) => c.column === t.col && c.id !== cardId)
      requestReorderRef.current(cardId, others[t.index]?.id ?? null)
      return
    }
    // 跨列：目标列 manual 时支持插入指定位置（before_id=落点后第一张卡，null=列尾）；
    // 非 manual 不传 before_id（后端忽略落列尾，显示由排序方案决定）
    let beforeId = null
    if (sortModeOfRef.current(t.col) === 'manual') {
      const others = (dataRef.current?.cards || []).filter((c) => c.column === t.col && c.id !== cardId)
      beforeId = others[t.index]?.id ?? null
    }
    requestMoveRef.current(card, t.col, undefined, beforeId)  // 跨列：本地已预览，直接提交 move
  }

  const onCardPointerUp = useRef((e) => {
    const d = dragRef.current
    dragRef.current = null
    window.removeEventListener('pointermove', onCardPointerMove)
    window.removeEventListener('pointerup', onCardPointerUp)
    if (onDragKeyRef.current) { window.removeEventListener('keydown', onDragKeyRef.current); onDragKeyRef.current = null }
    if (!d || !d.on) return
    suppressClickRef.current = true  // 拖拽后的 click 不再打开详情
    finishDragRef.current(d.id, e.clientX, e.clientY)
  }).current
  // 点击：拖拽刚结束（suppressClickRef）时吞掉；标题区在其自身 onClick 中自行处理
  function onClickCard(card) {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    openCard(card)
  }
  // 打开卡片详情（点击卡面正文 / 详情按钮两个入口共用）：
  // 卡片带「有更新」标记（card.unread，平台/agent 改过列且用户还没打开过）时，
  // 打开即视为已查看——先乐观清本地标记（免标记在重取前闪一下），再通知服务端
  // （不 await：失败也不打断打开；服务端写成功后经 SSE 触发重取对齐）
  function openCard(card) {
    setSelId(card.id)
    if (!card.unread) return
    setData((d) => !d ? d
      : { ...d, cards: d.cards.map((c) => (c.id === card.id ? { ...c, unread: false } : c)) })
    boardApi.markViewed(projectId, card.id).catch(() => {})
  }

  if (!projectId) return null
  const archived = !!project?.archived
  const agentMissing = !project?.agent_path

  return (
    <div className="board-tab">
      {/* 工具行：模式徽标 + 设置入口 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">开发看板</span>
        <span className="bug-status pending">{MODE_LABEL[data?.settings?.mode] || '串行'}</span>
        <span className="flex-1"></span>
        <Input className="board-search" placeholder="搜索卡片（标题/描述/Jira）"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
          <Settings /> 设置
        </Button>
        <Button size="sm" variant="outline" title="回收站（删除的卡片可还原）"
          onClick={() => setTrashOpen(true)}>
          <Trash2 /> 回收站
        </Button>
      </div>
      <div className="board-cols">
        {COLUMNS.map((col) => {
          const flt = filters[col.key] || 'all'
          // 测试任务条目三列上映（v2c T4，裁决 R16）：doing/review/done 按服务端
          // 条目 column 字段分列（旧后端不下发 column 时按 doing 归组兜底）；
          // flt==='dev' 时任务隐藏、==='test' 时卡片隐藏（仅测试任务）
          const taskList = (TASK_COLS.has(col.key) && flt !== 'dev')
            ? (data?.active_tasks || []).filter((t) => (t.column || 'doing') === col.key)
            : []
          const colCards = flt !== 'test' ? cards.filter((c) => c.column === col.key && matchCard(c)) : []
          // doing 列：服务端下发即队序（sortList 对 doing 列停用，v2c T2/T3——
          // 队序即展示序），按 isRunZone 分运行位区/等待区两区渲染（稳定分组：
          // 组内相对序保持下发队序；其余列维持列排序方案）
          const list = col.key === 'doing' ? colCards : sortList(colCards, col.key)
          const runList = col.key === 'doing' ? list.filter(isRunZone) : []
          const waitList = col.key === 'doing' ? list.filter((c) => !isRunZone(c)) : []
          const zoned = col.key === 'doing' ? [...runList, ...waitList] : list
          const waitStart = runList.length > 0 && waitList.length > 0 ? runList.length : -1
          return (
            <div key={col.key}
              data-col={col.key}
              className={'board-col' + (dragOver === col.key ? ' dragover' : '')}>
              <div className="board-col-head">
                {col.label}
                {/* 列统计口径=看板卡片（v2 §4 已定 3，裁决 R16：不含测试任务） */}
                <span className="board-col-count">{list.length}</span>
                <select className="board-col-sort" title="列表过滤：开发任务=卡片，测试任务=平台测试任务"
                  value={flt}
                  onChange={(e) => changeFilter(col.key, e.target.value)}>
                  {FILTER_OPTIONS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
                {/* doing 列隐藏排序下拉（v2c 单轨：队序即展示序，sortList 对该列停用——选了也不生效）；其余列照常 */}
                {col.key !== 'doing' && (
                <select className="board-col-sort" title="列内排序方案"
                  value={sortModeOf(col.key)}
                  onChange={(e) => changeSort(col.key, e.target.value)}>
                  {SORT_OPTIONS(col.key).map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
                )}
              </div>
              <div className="board-col-body">
                {/* 测试任务条目（只读：不可拖、无操作行；有会话的点击开任务会话弹窗） */}
                {taskList.map((t) => (
                  <div key={'task-' + t.id}
                    className={'board-task' + (t.session_id ? ' has-session' : '')}
                    title={t.session_id ? '测试任务 · 点击查看会话' : '测试任务（尚无会话）'}
                    onClick={() => { if (t.session_id) setSessTask(t) }}>
                    <div className="board-card-title" style={{ cursor: 'default' }}
                      onClick={(e) => e.stopPropagation()}>
                      {t.name}
                    </div>
                    <div className="board-card-badges">
                      {/* 任务 id：卡片 id 同款展示（「任务 #96」），便于在任务日志/会话/bug 报告里对上号 */}
                      <span className="board-card-id" title="测试任务 id">任务 #{t.id}</span>
                      {/* 状态徽标读 DB status（specQ §7 注记保留：不经 queue_state 派生） */}
                      <span className={'bug-status ' + (TASK_ST_CLASS[t.status] || 'retest')}>
                        测试·{ST_LABEL[t.status] || t.status}
                      </span>
                      <span className="bug-status pending">{TASK_TYPE_LABEL[t.task_type] || t.task_type}</span>
                      {t.current_round > 0 && <span className="bug-status pending">轮 {t.current_round}</span>}
                    </div>
                    {t.error && <div className="board-card-err">{t.error}</div>}
                  </div>
                ))}
                {zoned.map((card, zi) => (
                  <Fragment key={card.id}>
                    {zi === waitStart && (
                      // 运行位区/等待区分隔线（v2 §2.4 分区；线上=运行位区、线下=等待区按队列顺序）
                      <div className="board-runzone"><span>等待区 · 按队列顺序</span></div>
                    )}
                  <div
                    data-card-id={card.id}
                    className={`board-card col-${card.column}` + (dragId === card.id ? ' drag-gap' : '')}
                    onPointerDown={(e) => onCardPointerDown(e, card)}
                    onClick={() => onClickCard(card)}>
                    <CardText card={card}
                      editing={editId === card.id} editTitle={editTitle}
                      onStartEdit={startEdit} onSaveTitle={saveTitle}
                      onEditChange={setEditTitle} onCancelEdit={cancelEdit} />
                    <div className="board-card-badges">
                      {/* 「有更新」标记（card.unread，服务端权威）：平台/agent 改过卡片状态
                          （会话结束→待审核、提问→阻塞、归档同步→已完成…）而用户还没打开过
                          这张卡 ⇒ 打标记；打开卡片详情即清（openCard → markViewed）。
                          用户自己拖列/开始/停止造成的列变化不置位（服务端 mark_unread=False） */}
                      {card.unread && (
                        <span className="board-card-new"
                          title="状态有更新，打开卡片后标记消失">有更新</span>)}
                      {/* 卡片 id（与详情弹窗标题行同款 #N）：日志/会话/bug 报告里说「卡 345」时可直接对上号 */}
                      <span className="board-card-id" title="卡片 id">#{card.id}</span>
                      {/* 队列态徽标＝服务端 queue_state 单枚举派生（P6，前端不拼条件；
                          判定序与互斥不变量见 doc_ai/spec/queue/排队与占用.md）。
                          未知枚举降级不渲染（防服务端新版枚举前滚击穿旧前端）。
                          操作行仍直读契约字段（answer_pending/block_kind，裁决 R1） */}
                      {!!QUEUE_STATE_LABEL[card.queue_state] && (
                        <span className={queueStateChipClass(card.queue_state)}>
                          {QUEUE_STATE_LABEL[card.queue_state]}</span>)}
                      {/* 独立 worktree 卡（card.worktree 非空即该卡跑在独立工作树）：悬浮看完整路径 */}
                      {card.worktree ? (
                        <span className="bug-status pending" title={card.worktree}>🌿 worktree</span>) : null}
                      {card.scheduled_at ? <span className="bug-status pending">⏰ {new Date(card.scheduled_at).toLocaleString()}</span> : null}
                      {card.parent_card_id ? <span className="bug-status pending">🔗 依赖 #{card.parent_card_id}</span> : null}
                      {card.block_kind === 'interaction' && (
                        <span className="bug-status interaction" title="agent 等待用户回答，回复后自动恢复">
                          🤔 {card.block_text || '等待回答'}</span>)}
                      {card.block_kind === 'manual' && <span className="bug-status retest">{card.block_text || '手动阻塞'}</span>}
                      {card.origin === 'sync' && <span className="bug-status pending">同步</span>}
                      {card.jira_key && <span className="bug-status pending">{card.jira_key}</span>}
                    </div>
                    {card.last_error && <div className="board-card-err">{card.last_error}</div>}
                    <div className="board-card-ops" onClick={(e) => {
                      // 仅按钮（含图标）点击不冒泡，避免误开详情；行内空白区域照常冒泡开详情
                      if (e.target.closest('button')) e.stopPropagation()
                    }}>
                      {card.column === 'todo' && (
                        // 分裂按钮：主按钮行为不变（统一队列排队开始），右侧 ▾ 另有
                        // 「🌿 在新 worktree 中开始」（平台新建独立工作树、立即执行不入队）
                        <div className="board-split">
                          <Button size="sm" variant="outline" disabled={archived || agentMissing}
                            title={archived ? '项目已归档' : agentMissing ? '未配置智能体' : ''}
                            onClick={() => doStart(card)}><Play /> 开始</Button>
                          <ActionMenu align="end"
                            trigger={
                              <Button size="sm" variant="outline" disabled={archived || agentMissing}
                                title={archived ? '项目已归档'
                                  : agentMissing ? '未配置智能体' : '更多开始方式'}
                                onClick={() => loadWorktreePreview(card.id)}>▾</Button>
                            }
                            items={[
                              { key: 'queue', label: '开始（入队排队）', onSelect: () => doStart(card) },
                              { key: 'worktree', label: '🌿 在新 worktree 中开始',
                                disabled: !!worktreeBlockReason(card),
                                title: worktreeBlockReason(card) || undefined,
                                onSelect: () => openWorktreeConfirm(card) },
                            ]} />
                        </div>)}
                      {card.column === 'doing' && !card.running && card.block_kind !== 'queue' && (
                        <Button size="sm" variant="outline" onClick={() => doMove(card, 'review')}><ArrowRight /> 待审核</Button>)}
                      {card.column === 'blocked' && (
                        <Button size="sm" variant="outline" disabled={archived || agentMissing}
                          onClick={() => doStart(card)}><Play /> 重试</Button>)}
                      {/* 已作答·待送达：立即送达答案（不等项目空闲）——此时排队主体
                          是答案，「⚡强制」（起新会话）语义不符，故改为送达入口 */}
                      {card.answer_pending && (
                        <Button size="sm" variant="ghost"
                          title="不等项目空闲，立即把答案送达等待中的会话"
                          onClick={() => doDeliverAnswer(card)}>⚡ 送达</Button>)}
                      {/* 排队中卡片的强制入口：跳过队列立即开始（用户自担风险）；
                          已作答·待送达的卡不显示（答案排队走上方「送达」） */}
                      {card.block_kind === 'queue' && !card.answer_pending && (
                        <Button size="sm" variant="ghost" title="跳过队列立即开始（用户自担风险）"
                          disabled={archived || agentMissing}
                          onClick={async () => {
                            if (!window.confirm('强制开始将跳过队列立即执行，可能与在跑任务冲突，继续？')) return
                            await doStart(card, undefined, true)
                          }}>⚡ 强制</Button>)}
                      {/* 等待区卡停止入口（v2b T3）：取消排队并移入待审核；
                          对已作答·待送达卡同显（停止即放弃待送达答案，后端一并取消） */}
                      {card.block_kind === 'queue' && (
                        <Button size="sm" variant="ghost" title="取消排队并移入待审核"
                          onClick={() => doStop(card)}>停止</Button>)}
                      {card.column === 'review' && (<>
                        <Button size="sm" variant="outline" onClick={() => doMove(card, 'done')}><Check /> 通过</Button>
                        <Button size="sm" variant="outline" onClick={() => { setRejectFor(card); setRejectText('') }}><Undo2 /> 打回</Button>
                      </>)}
                      {card.column === 'done' && (
                        <Button size="sm" variant="outline" onClick={() => doMove(card, 'todo')}><Undo2 /> 重开</Button>)}
                      {/* 卡片详情显式入口（与点击卡片正文同语义）：正文点击要过拖拽阈值判定，
                          卡片被编辑标题/拖拽占位时不稳，给按钮一个确定入口 */}
                      <Button size="sm" variant="ghost" title="打开卡片详情"
                        onClick={() => openCard(card)}><Maximize2 /></Button>
                      <Button size="sm" variant="ghost" title="删除卡片" onClick={() => removeCard(card)}><Trash2 /></Button>
                      {/* 主会话直达：一键打开卡片主会话（SessionModal board 模式）；尚无会话时禁用 */}
                      <Button size="sm" variant="ghost"
                        title={card.session_id ? '进入主会话' : '尚无会话'}
                        disabled={!card.session_id}
                        onClick={() => setSessFor({ sid: card.session_id, cid: card.id, column: card.column, title: card.title || '未命名' })}>
                        <MessageSquare /></Button>
                      {/* 在 dsh 界面打开主会话（仅 dsh 插件面板形态渲染；独立 web 形态宿主桥
                          不应答 caps，按钮不存在）：宿主半收请求后调 uiWorkspace.openSession
                          并在 dsh 主界面显示该会话，同时关掉全屏面板 */}
                      {!!dshCaps?.openSession && (
                        <Button size="sm" variant="ghost"
                          title={card.session_id ? '在 dsh 界面打开该卡片主会话' : '尚无会话'}
                          disabled={!card.session_id}
                          onClick={() => openSessionInDsh(card.session_id)}><ExternalLink /></Button>)}
                    </div>
                  </div>
                  </Fragment>
                ))}
              </div>
              {col.key === 'todo' && (
                // 建卡：描述带上快速添加框内粘贴的附件（有附件时随建卡一起落库）
                // autoStart（Ctrl+Enter）：建卡后紧接着走 start 端点入统一队列排队——
                // 新建卡 from_column=todo 的服务端语义=落等待区末尾，卡片随即落「正在开发」
                // 列显示排队中徽标，轮到才起会话；入队失败不清卡（卡片仍在待开发，可手动点开始）
                <QuickAdd disabled={archived} project={project} onAdd={async (title, description, autoStart) => {
                  let card = null
                  try { card = await boardApi.createCard(projectId, { title, description }) }
                  catch (e) { toast(e.message); return }
                  if (autoStart && card?.id) {
                    try { await boardApi.startCard(projectId, card.id); toast('已进入开发队列排队') }
                    catch (e) { toast(e.message) }
                  }
                  await reload()
                }} />
              )}
            </div>
          )
        })}
      </div>
      {selCard && (
        <BoardDetail project={project} card={selCard} comments={commentsOf(selCard.id)}
          onClose={() => setSelId(null)} reload={reload} />
      )}
      {/* 卡片主会话直达弹窗（board 模式，与详情内会话查看同款；开详情时互不冲突） */}
      {sessFor && (
        <SessionModal board={{ projectId, ...sessFor }} onClose={() => setSessFor(null)}
          onSwitchSession={(sid) => setSessFor((s) => (s ? { ...s, sid } : s))} />
      )}
      {/* 测试任务会话弹窗（task 模式）：点击「正在开发」列任务条目打开 */}
      {sessTask && (
        <SessionModal task={sessTask} onClose={() => setSessTask(null)} />
      )}
      {/* 打回意见 */}
      <Dialog open={!!rejectFor} onOpenChange={(v) => !v && setRejectFor(null)}>
        <DialogContent className="modal">
          <DialogHeader><DialogTitle>打回「{rejectFor?.title}」</DialogTitle></DialogHeader>
          <Textarea rows={4} placeholder="修改意见（将随会话续发改进）" value={rejectText}
            onChange={(e) => setRejectText(e.target.value)} />
          <DialogFooter>
            <Button onClick={async () => { const c = rejectFor; setRejectFor(null); await doStart(c, rejectText) }}>确认打回</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 父任务未完成拦截：提示先完成父任务/解除依赖；start 动作可「强制开始」自担风险跳过，move 不支持强制 */}
      <Dialog open={!!depFor} onOpenChange={(v) => !v && setDepFor(null)}>
        <DialogContent className="modal">
          <DialogHeader><DialogTitle>父任务尚未完成</DialogTitle></DialogHeader>
          <p className="hint">该卡片有未完成的父任务依赖。建议先完成父任务，或在详情面板解除依赖后再开始。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepFor(null)}>取消</Button>
            {/* #10 修复：move 分支不支持 force（后端无此语义），强制开始按钮仅 start 动作渲染；
                move 分支只留「取消」关闭对话框 */}
            {depFor?.action === 'start' && (
              <Button onClick={async () => {
                const d = depFor; setDepFor(null)
                // worktree 起跑被父依赖拦下后强制开始：沿用同一 worktree 语义
                // （force 只跳依赖/排队，不改「在哪棵工作树里跑」）
                await doStart(cards.find((c) => c.id === d.cardId), undefined, true, d.worktree)
              }}>强制开始（自担风险）</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 「在新 worktree 中开始」二次确认：明示将新建独立工作树（路径/分支）+ 该卡立即执行、
          不与项目队列互斥（可能与项目内其他任务并发，风险自担）；预览取不到时后两行不显示 */}
      <Dialog open={!!wtFor} onOpenChange={(v) => !v && setWtFor(null)}>
        <DialogContent className="modal">
          <DialogHeader><DialogTitle>在新 worktree 中开始</DialogTitle></DialogHeader>
          <p className="hint">
            将为该卡片新建独立 git worktree，会话在独立工作树中执行，主仓库不受影响。
          </p>
          {wtFor?.preview?.path && (
            <p className="hint break-all">路径：<span className="font-mono">{wtFor.preview.path}</span></p>)}
          {wtFor?.preview?.branch && (
            <p className="hint">分支：<span className="font-mono">{wtFor.preview.branch}</span></p>)}
          <p className="hint font-semibold">
            该卡将立即执行，不与项目队列互斥，可能与项目内其他任务并发。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWtFor(null)}>取消</Button>
            <Button onClick={async () => {
              const w = wtFor; setWtFor(null)
              await doStart(w.card, undefined, false, true)
            }}>开始</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 看板设置弹窗：并行模式 + Jira */}
      <BoardSettings open={settingsOpen} onClose={() => setSettingsOpen(false)}
        projectId={projectId} settings={data?.settings} reload={reload} />
      {/* 回收站弹窗：删除的卡片（软删除）在此还原/彻底删除/清空；关闭时回刷看板 */}
      {trashOpen && <BoardTrash project={project} onClose={() => setTrashOpen(false)}
        onChanged={() => reload()} />}
    </div>
  )
}

// 行内标题编辑框高度上限（px）：超长标题超过后转框内滚动，防把卡片撑爆
const TITLE_EDIT_MAX_H = 240

// 卡片「标题+内容」行数上限：合计最多显示 6 行，超出截断（末尾省略号）。
// 标题按自身换行最多 clamp 6 行（CSS）；内容行数 = 6 - 标题实际显示行数
// （标题 1 行 → 内容最多 5 行；标题占满 6 行 → 内容隐藏）。
// 标题行数 = 测量其渲染高度 ÷ 行高（CSS 定 line-height 1.5，行高确定可算）；
// 标题已被 CSS clamp 到 6 行，测出的高度即「实际显示行数」，无需测自然行数。
// ResizeObserver 跟随列宽变化重测（换行数随宽度变化，如窗口缩放/列宽拖动）。
function CardText({ card, editing, editTitle, onStartEdit, onSaveTitle, onEditChange, onCancelEdit }) {
  const titleRef = useRef(null)
  const taRef = useRef(null)                     // 行内编辑框（textarea：宽度固定、文字自动折行）
  const [descLines, setDescLines] = useState(5)  // 首帧按标题 1 行估，写在布局后按实测修正
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 19.5
      setDescLines(Math.max(0, 6 - Math.round(el.getBoundingClientRect().height / lh)))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    }
  }, [card.title, editing])  // 标题变化/进出编辑态后重测；宽度变化由 ResizeObserver 兜底
  // 编辑框自动增高：文字折行/增行后按 scrollHeight 撑高（宽度不变，长标题折行整体可见）；
  // 先置 auto 再读才能收缩；scrollHeight 不含边框，(offsetHeight-clientHeight) 即 border 高度，
  // 补上避免边框像素差把内容顶出竖直滚动条。
  const autoGrow = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const h = ta.scrollHeight + (ta.offsetHeight - ta.clientHeight)
    ta.style.height = Math.min(h, TITLE_EDIT_MAX_H) + 'px'
  }, [])
  useLayoutEffect(() => {
    if (editing) autoGrow()   // 进入编辑：长标题一次折行到位（初值直出正确高度）
  }, [editing, autoGrow])
  if (editing) {
    return (
      <>
        <Textarea ref={taRef} rows={1} value={editTitle} autoFocus
          className="board-card-title-input min-h-0 resize-none px-1 py-0 text-[calc(13px*var(--fs))] font-semibold leading-[1.5] break-all"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { onEditChange(e.target.value); autoGrow() }}
          onKeyDown={(e) => {
            // 回车保存（输入法组词中的回车不拦截，留给选字上屏）；Esc 取消
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onSaveTitle(card) }
            else if (e.key === 'Escape') onCancelEdit()
          }}
          onBlur={() => onSaveTitle(card)} />
        {card.description && descLines > 0 && (
          <div className="board-card-desc" style={{ WebkitLineClamp: descLines }}>{card.description}</div>
        )}
      </>
    )
  }
  return (
    <>
      <div ref={titleRef} className="board-card-title" title="单击编辑标题"
        onClick={(e) => { e.stopPropagation(); onStartEdit(card) }}>
        {card.title || <span className="board-card-title-empty">未命名</span>}
      </div>
      {card.description && descLines > 0 && (
        <div className="board-card-desc" style={{ WebkitLineClamp: descLines }}>{card.description}</div>
      )}
    </>
  )
}

// todo 列底部快速添加框：回车或点「＋」建卡；多行 textarea 自动增高、超宽自动换行（Shift+回车换行）；
// 输入含换行时首行=卡片标题、其余行=卡片描述（2026-09-19）；
// 标题可为空（空卡在详情内编辑器补充）；输入 `/` 唤起 skill 菜单（与会话详情页同款 token 触发，
// 选中插入「使用 skill「名」」）——建卡后该文本随卡片首轮 prompt 交给 agent；
// 支持粘贴/拖入图片与文件（与详情「标题/描述」编辑框同款）：上传为卡片附件（board_media），
// 上传后即出缩略图 chips 预览，建卡时把附件 markdown 写进卡片描述（标题是纯文本，放不下图片）
function QuickAdd({ disabled, onAdd, project }) {
  const [v, setV] = useState('')
  const [atts, setAtts] = useState([])               // 附件登记 [{md,url,name,mime}]（建卡时并入描述）
  const [uploading, setUploading] = useState(false)  // 附件上传中（粘贴/拖入；期间不许建卡）
  const taRef = useRef(null)
  // `/` skill 菜单: caretPos = 光标位(供 token 探测, -1=未知按输入末尾);
  // slashDismissed = 菜单被 Esc/选中项关闭后的抑制态(下次输入/点击自动撤销);
  // 打开态为派生值: findSlashToken 命中且未抑制
  const [caretPos, setCaretPos] = useState(-1)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashItems, setSlashItems] = useState([])   // [{key,label,desc,type:'skill'}]

  // skills 数据: 项目 agent 能力扫描（与会话详情页同参: project_dir 优先, 无则回落 work_dir）
  useEffect(() => {
    if (!project?.agent_path) { setSlashItems([]); return undefined }
    let stopped = false
    projectApi.agentSkills(project.agent_path, project.project_dir || project.work_dir || '')
      .then((sk) => {
        if (stopped) return
        // 后端 /api/agents/skills 返回 {skills:[{name,description,source}]}; 兼容裸数组
        const list = Array.isArray(sk) ? sk : (sk?.skills || [])
        setSlashItems(list.map((x) => ({ key: x.name || x.id, label: x.name || x.id,
          desc: (x.description || x.summary || '').slice(0, 40), type: 'skill' })))
      })
      .catch(() => { /* skill 拉取失败: 只是没有菜单项, 建卡不受影响 */ })
    return () => { stopped = true }
  }, [project?.id, project?.agent_path, project?.project_dir, project?.work_dir])

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    // 先置 auto 再读 scrollHeight：删行时高度才能收缩；上限 120px，超出转内部滚动
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }

  /* ---------- 附件上传（粘贴/拖入共用，与卡片详情的描述编辑框同款） ---------- */
  // 读取文件 → base64 上传 → 登记为「待建卡附件」（chips 就地出缩略图）。
  // 建卡前卡片还不存在，故附件先留在本地 state，由 submit 随 createCard 的 description 落库；
  // 引用写落盘绝对路径 abs（agent 本机直读），浏览器渲染由 absToMedia 改写为媒体端点 URL；
  // chip 缩略图用 server 回包 url（裸 /api/... 路径）经 mediaDisplayUrl 补同源根前缀，
  // 否则插件形态（站点挂 /touchstone）下会打到 dsh 宿主根 401，图片不显示（2026-10-04 修）。
  async function uploadFiles(files) {
    const list = Array.from(files || [])
    if (!list.length || uploading) return
    const pid = project?.id
    if (!pid) return
    for (const f of list) {
      if (f.size > MEDIA_MAX) { toast(`附件过大（>10MB）：${f.name}`); continue }
      // 占位图拦截（1x1/2x2 一类极小图，见 utils/media.js）：与描述编辑框/会话 composer 同款
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
        const r = await boardApi.uploadMedia(pid,
          { name: f.name, mime: f.type || 'application/octet-stream', data })
        const md = (f.type || '').startsWith('image/')
          ? `![${f.name}](${r.abs || r.url})`
          : `[${f.name}](${r.abs || r.url})`
        setAtts((prev) => [...prev, { md, url: mediaDisplayUrl(r.url), name: f.name, mime: f.type }])
        toast(`已添加附件：${f.name}`)
      } catch (e) { toast(e.message || '附件上传失败') }
      finally { setUploading(false) }
    }
  }
  function onPasteFiles(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
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
  // 移除附件：只删本地登记（chip 消失），已落盘文件不动（建卡未提交前无引用）
  function removeAtt(md) { setAtts((prev) => prev.filter((a) => a.md !== md)) }

  // 光标位同步: 点击/键盘移动后重算 token(挂原生监听); 点击同时撤销菜单关闭态(用户重新编辑)
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return undefined
    const onCaret = () => setCaretPos(ta.selectionStart ?? 0)
    const onClick = () => { setCaretPos(ta.selectionStart ?? 0); setSlashDismissed(false) }
    ta.addEventListener('keyup', onCaret)
    ta.addEventListener('click', onClick)
    return () => { ta.removeEventListener('keyup', onCaret); ta.removeEventListener('click', onClick) }
  }, [])
  // token 触发: 由输入 + 光标位派生菜单打开态与 query; 光标未知时按输入末尾处理
  const slashToken = useMemo(() => findSlashToken(v, caretPos >= 0 ? caretPos : v.length),
    [v, caretPos])
  const slashOpen = slashToken != null && !slashDismissed
  const slashQuery = slashToken ? slashToken.text.slice(1) : ''
  // SlashMenu 选中: 仅作 token 替换(光标置于插入文本后), 建卡仍由用户回车/「＋」触发
  function onSlashSelect(it) {
    if (!slashToken) return
    const ins = `使用 skill「${it.label}」`
    setSlashDismissed(true)
    setV((prev) => prev.slice(0, slashToken.start) + ins
      + prev.slice(slashToken.start + slashToken.text.length))
    const pos = slashToken.start + ins.length
    setCaretPos(pos)
    // 程序化插入须等重渲染落盘: 光标落在插入文本末尾 + 高度按新内容增高
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) ta.selectionStart = ta.selectionEnd = pos
      autoGrow()
    })
  }

  // 提交拆分：输入含换行时首行=标题、其余行=描述（与详情一体编辑框 BoardDetail.saveDesc 同规则）；
  // 单行输入整段作标题（旧行为不变，描述仅附件）。标题行/正文各自 trim，正文前后的空行不落库。
  // autoStart：Ctrl+Enter 提交时为 true——建卡后由父组件接着入统一队列排队（按钮/普通回车不传）
  async function submit(autoStart = false) {
    if (uploading) return             // 附件还在上传：等 chips 出来后用户再提交
    const nl = v.indexOf('\n')
    const title = (nl < 0 ? v : v.slice(0, nl)).trim()
    const content = (nl < 0 ? '' : v.slice(nl + 1)).trim()
    const attsMd = atts.map((a) => a.md).join('\n\n')        // 附件 markdown 落卡片描述
    const description = [content, attsMd].filter(Boolean).join('\n\n')
    setV('')
    setAtts([])
    requestAnimationFrame(autoGrow)   // 清空后高度回落到初始单行
    await onAdd(title, description, autoStart)
  }
  return (
    <div className="board-add">
      <div className="flex-1 min-w-0">
        {/* 附件 chips 行（粘贴/拖入后即时预览，样式与会话输入区同款） */}
        {(atts.length > 0 || uploading) && (
          <div className="sess-attachrow">
            {uploading && <span className="sess-chip">附件上传中…</span>}
            {atts.map((a, i) => (
              <span key={a.md + i} className="sess-chip" title={a.name}>
                {(a.mime || '').startsWith('image/') && a.url
                  ? <img src={a.url} alt={a.name} />
                  : <FileText className="h-3.5 w-3.5" />}
                <span className="sess-chip-name">{a.name}</span>
                <button type="button" className="sess-chip-x" title="移除附件"
                  onClick={() => removeAtt(a.md)}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* .sess-slashwrap 是菜单的定位锚(相对定位): skill 菜单在输入框上方弹出, 与会话详情页同款 */}
        <div className="sess-slashwrap">
          <SlashMenu open={slashOpen} query={slashQuery} items={slashItems}
            onSelect={onSlashSelect} onClose={() => setSlashDismissed(true)} />
          <Textarea ref={taRef} rows={1} style={{ minHeight: 36 }} className="resize-none"
            placeholder="添加任务…（Enter 落待开发 / Ctrl+Enter 直接排队；可粘贴图片，可留空）"
            value={v} disabled={disabled}
            onChange={(e) => {
              setV(e.target.value)
              setCaretPos(e.target.selectionStart ?? e.target.value.length)
              setSlashDismissed(false)
              autoGrow()
            }}
            onPaste={onPasteFiles} onDrop={onDropFiles}
            onKeyDown={(e) => {
              // 回车建卡落「待开发」；Ctrl+回车建卡后直接入开发队列排队（修饰键只认 ctrlKey，
              // 与 BoardDetail 编辑态 Ctrl+Enter 保存同款）；Shift+回车换行；
              // 中文输入法组词中的回车不拦截（对齐 ComposerBar）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault(); submit(e.ctrlKey)
              }
            }} />
        </div>
      </div>
      {/* ＋ 按钮 = 普通回车语义（建卡落待开发）；排队入口只走 Ctrl+Enter */}
      <Button size="sm" variant="outline" disabled={disabled || uploading} onClick={() => submit()}><Plus /></Button>
    </div>
  )
}

// 看板设置弹窗：并行模式三档 + Jira 配置（测试连接/导入）
function BoardSettings({ open, onClose, projectId, settings, reload }) {
  const [mode, setMode] = useState('serial')
  const [jira, setJira] = useState({ url: '', user: '', token: '' })
  const [testing, setTesting] = useState(false)
  const [importing, setImporting] = useState(false)
  // 回填只在弹窗打开边沿执行一次（ref 守卫）：否则 BoardTab 5s 轮询使 settings 换新引用，
  // effect 反复重跑会把用户正在输入的 Jira 表单清空；关闭时复位以便下次打开重新回填
  const filledRef = useRef(false)
  useEffect(() => {
    if (open && !filledRef.current && settings) {
      filledRef.current = true
      setMode(settings.mode || 'serial')
      setJira(settings.jira || { url: '', user: '', token: '' })
    }
    if (!open) filledRef.current = false
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  async function saveMode(v) {
    setMode(v)
    try { await boardApi.updateSettings(projectId, { mode: v }); await reload() }
    catch (e) { toast(e.message) }
  }
  async function saveJira() {
    try { await boardApi.updateSettings(projectId, { jira }); toast('Jira 配置已保存'); await reload() }
    catch (e) { toast(e.message) }
  }
  async function testJira() {
    setTesting(true)
    try {
      const r = await boardApi.jiraTest(projectId, jira)
      toast(r.ok ? `连接成功：${r.name}` : `连接失败：${r.error}`)
    } catch (e) { toast(e.message) } finally { setTesting(false) }
  }
  async function doImport() {
    setImporting(true)
    try {
      const r = await boardApi.jiraImport(projectId)
      toast(`导入完成：新增 ${r.added}，跳过 ${r.skipped}`)
      await reload()
    } catch (e) { toast(e.message) } finally { setImporting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="modal w-[560px] sm:max-w-[92vw]">
        <DialogHeader><DialogTitle>看板设置</DialogTitle></DialogHeader>
        <div className="board-sec">
          <div className="board-sec-t">ℹ 并行模式</div>
          {[['serial', '串行：同时只跑一个任务'],
            ['parallel', '并行：最多 5 个并行（队列窗口）']].map(([v, label]) => (
            <label key={v} className="flex items-center gap-2 py-1 text-sm">
              <input type="radio" name="board-mode" checked={mode === v} onChange={() => saveMode(v)} />
              {label}
            </label>
          ))}
        </div>
        <div className="board-sec">
          <div className="board-sec-t">🐛 Jira</div>
          <div className="form-col gap-2">
            <Input placeholder="Jira 地址（如 https://xx.atlassian.net）" value={jira.url}
              onChange={(e) => setJira({ ...jira, url: e.target.value })} />
            <Input placeholder="用户名（邮箱）" value={jira.user}
              onChange={(e) => setJira({ ...jira, user: e.target.value })} />
            <Input placeholder="API token" type="password" value={jira.token}
              onChange={(e) => setJira({ ...jira, token: e.target.value })} />
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={saveJira}>保存配置</Button>
            <Button size="sm" variant="outline" disabled={testing} onClick={testJira}>测试连接</Button>
            <Button size="sm" disabled={importing} onClick={doImport}>导入我的待办</Button>
          </div>
          <div className="hint mt-1">导入 = 拉取「指派给我且未解决」的前 50 条建卡（按 key 去重）；凭据存服务端</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
