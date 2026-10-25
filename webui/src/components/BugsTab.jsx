import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '../stores/app'
import { bugApi, taskApi } from '../api'
import { toast } from '../utils/toast'
import { fmtTime, renderMd, stLabel } from '../utils/renderMd'
import { absToMedia, projectRoots } from '../utils/mediaText'
import { bugStatusLabel, caseStatusLabel, severityLabel } from '../utils/dataLabels'
import {
  BUG_FIXED, BUG_RETEST_PASS, CASE_FAIL, CASE_PASS, CASE_RETEST,
} from '../utils/taskEnums'
import { t, useI18n } from '../utils/i18n'
import SessionView from './SessionView'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { RefreshCw, Play, Square, RotateCcw, Wrench, Ban } from 'lucide-react'
import {
  SEV_FILTER_ALL, SEV_HIGH, SEV_LOW, SEV_MEDIUM, SEV_NONE,
  bugStatusCls, filterBugsBySeverity, severityCls, severityCounts,
} from '../utils/bugStatus'

// 复测通过（已闭环）与已拒绝（被用户否决）的报告调暗沉底，作为历史报告
const isBugHistory = (s) => /复测通过|已拒绝/.test(s || '')
function lastTaskCls(s) {
  if (s === 'running') return 'run'
  if (s === 'done') return 'pass'
  if (s === 'failed') return 'retest'
  return 'pending'
}
function caseStatusCls(s) {
  if (s === CASE_PASS) return 'pass'
  if (s === CASE_FAIL) return 'retest'
  if (s === CASE_RETEST) return 'run'
  return 'pending'
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// 修复任务终点选项（与后端 STAGE_MATRIX['fix'] 一致；机器值不翻译）
function fixEndOptions() {
  return [
    { v: 'analyze', label: t('报告分析') }, { v: 'fix', label: t('问题修复') },
    { v: 'deploy', label: t('重新部署') }, { v: 'retest', label: t('复测') },
  ]
}
// 复测范围选项（机器值 retest_only/deploy_retest/deploy_only 不翻译）
function retestScopeOptions() {
  return [
    { v: 'retest_only', label: t('仅复测（现状行为，不部署）') },
    { v: 'deploy_retest', label: t('重新部署 → 复测') },
    { v: 'deploy_only', label: t('仅重新部署（不复测）') },
  ]
}

export default function BugsTab({ project }) {
  // 订阅语言切换（lang 变化即重渲染；文案用模块级 t 按当前语言求值）
  useI18n()
  const projectId = project?.id
  const store = useAppStore()
  const bugs = store.bugs
  // 严重程度筛选（2026-10-25）：'all' = 全部；其余为高/中/低/未分级。
  // 排序由后端给出（历史沉底 → 高→中→低→未分级 → 时间倒序），前端只做筛选与计数。
  const [sevFilter, setSevFilter] = useState(SEV_FILTER_ALL)
  const [sevSaving, setSevSaving] = useState(false)

  const bugwrapEl = useRef(null)
  const [curBugDir, setCurBugDir] = useState(null)
  // curBugDir 的 ref 镜像: refreshFixPanel 由轮询闭包调用,
  // 直接读 state 会停滞在旧值, 导致首次选择 bug 后修复面板迟迟不加载
  const curBugDirRef = useRef(null)
  const [detail, setDetail] = useState(null)
  const [stab, setStab] = useState('report')
  // stab 的 ref 镜像: saveBugState 由轮询/reloadDetail 闭包调用, state 停滞在旧值,
  // 会把错误的子 tab 写入 localStorage, 导致刷新后恢复错 tab
  const stabRef = useRef('report')
  const [fixTaskId, setFixTaskId] = useState(null)
  const [fixTask, setFixTask] = useState(null)
  // 对话页展示的会话任务: 最近的 fix 或 reject(修例)任务; 与 fixTask 分开——
  // 修复弹窗的操作对象只能是 fix 任务, 不能把 reject 任务当修复任务重启
  const [chatTask, setChatTask] = useState(null)
  const [fixDraft, setFixDraft] = useState({ auto_commit: false })
  // 修复弹窗（修改意见）与拒绝弹窗（拒绝理由）；复测弹窗（范围三选一）
  const [fixDlg, setFixDlg] = useState(false)
  const [fixOpinion, setFixOpinion] = useState('')
  const [fixEnd, setFixEnd] = useState('fix')
  const [rejectDlg, setRejectDlg] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [retestDlg, setRetestDlg] = useState(false)
  const [retestScope, setRetestScope] = useState('retest_only')
  const FIX_ENDS = fixEndOptions()
  const RETEST_SCOPES = retestScopeOptions()
  // 模型已移到项目设置(项目弹窗), 修复任务创建时由服务端按项目模型回落
  // 用户是否手动改过控件(仅用于"不覆盖", 用 ref 避免轮询闭包读到旧 state);
  // 勾选即保存, 保存成功后清除对应 touched 标记
  const fixTouchedRef = useRef({ auto_commit: false })
  // 当前修复任务 id 的 ref 镜像: 轮询回调是旧闭包, 直接读 state 永远是启动时的 null
  const fixTaskIdRef = useRef(null)
  const restoreTriedRef = useRef(false)

  // bug 报告正文里的本地图片引用同样要改写（2026-10-16，与会话气泡同一套 absToMedia）：
  // 报告里的 `![截图](/opt/…/board_media/xxx/shot.png)` 原先原样进 `<img src>` ⇒ 浏览器按
  // 同源根拼成 http://<宿主>/opt/… ⇒ 404（复现截图看不见）
  const mdRoots = useMemo(() => projectRoots([project], projectId), [project, projectId])
  const mdHtml = useMemo(() => (detail
    ? { __html: renderMd(absToMedia(detail.content, projectId, { roots: mdRoots })) }
    : null), [detail, projectId, mdRoots])
  // 等级筛选 chips 的计数与当前可见列表（纯前端；后端列表已按 高→中→低→未分级 排好）
  const sevCounts = useMemo(() => severityCounts(bugs), [bugs])
  const shownBugs = useMemo(() => filterBugsBySeverity(bugs, sevFilter), [bugs, sevFilter])
  // 筛选 chips：全部 / 高 / 中 / 低 / 未分级（label 按当前语言求值，count 来自 sevCounts）
  const sevFilterChips = [
    { key: SEV_FILTER_ALL, cls: 'all', label: t('全部'), count: sevCounts.all },
    { key: SEV_HIGH, cls: 'high', label: severityLabel(t, SEV_HIGH), count: sevCounts.high },
    { key: SEV_MEDIUM, cls: 'medium', label: severityLabel(t, SEV_MEDIUM), count: sevCounts.medium },
    { key: SEV_LOW, cls: 'low', label: severityLabel(t, SEV_LOW), count: sevCounts.low },
    { key: SEV_NONE, cls: 'none', label: severityLabel(t, SEV_NONE), count: sevCounts.none },
  ]
  const fixRunning = fixTask?.status === 'running'
  const fixQueued = fixTask?.status === 'queued'
  const chatRunning = chatTask?.status === 'running'
  const chatQueued = chatTask?.status === 'queued'
  // 对话页状态行：修例任务无提交/部署/复测选项，只在修复任务上展示
  const chatStatusText = !chatTask ? t('尚无修复/修例任务')
    : t('任务「{name}」 {status} · 轮次 {round}', {
      name: chatTask?.name,
      status: stLabel(chatTask?.status),
      round: chatTask?.current_round,
    })
    + t(' · 会话 {sid}', { sid: chatTask?.session_id || t('（首轮后生成）') })
    + (chatTask?.task_type === 'fix'
      ? t(' · {commit}/{deploy}/{retest}', {
        commit: chatTask?.auto_commit ? t('自动提交') : t('不提交'),
        deploy: chatTask?.auto_deploy ? t('自动部署') : t('不部署'),
        retest: chatTask?.auto_retest ? t('自动复测') : t('不复测'),
      })
      : '')

  /* ---------- 状态保存与恢复 ---------- */
  function saveBugState() {
    if (!curBugDir || !projectId) return
    localStorage.setItem('ts_cur_bug', JSON.stringify({ proj: projectId, dir: curBugDir, stab: stabRef.current }))
  }
  async function selectBug(dir) {
    setCurBugDir(dir)
    curBugDirRef.current = dir
    setStab('report')
    stabRef.current = 'report'
    setFixTaskId(null)
    fixTaskIdRef.current = null
    setFixTask(null)
    setChatTask(null)
    setFixDraft({ auto_commit: false })
    fixTouchedRef.current = { auto_commit: false }
    await reloadDetail(dir)
  }
  async function reloadDetail(dir = curBugDir) {
    if (!dir || !projectId) return
    try {
      const b = await bugApi.get(projectId, dir)
      setDetail(b)
      await refreshFixPanel()
      saveBugState()
    } catch (e) {
      toast(e.message)
    }
  }
  // 改严重程度等级：写回 bug_report.md（后端按文件语言写「高」/`High`）→ 重读详情 +
  // 重取列表（排序会随之变化）。空值/未变化直接忽略（下拉里的「未分级」是只读占位）。
  async function changeSeverity(level) {
    if (!curBugDir || !projectId || sevSaving) return
    if (!level || level === (detail?.severity || '')) return
    setSevSaving(true)
    try {
      await bugApi.setSeverity(projectId, curBugDir, level)
      toast(t('严重程度已更新：{level}', { level: severityLabel(t, level) }))
      await Promise.all([reloadDetail(curBugDir), store.loadBugs()])
    } catch (e) {
      toast(e.message)
    } finally {
      setSevSaving(false)
    }
  }
  function openStab(name) {
    setStab(name)
    stabRef.current = name
    saveBugState()
  }

  /* ---------- 修复/修例任务 ---------- */
  async function refreshFixPanel() {
    // 读 ref: 轮询闭包调用的永远是旧函数, state 停滞在初值
    const bugDir = curBugDirRef.current
    if (!bugDir || !projectId) return
    try {
      const tasks = await taskApi.list(projectId)
      // 修复（fix）与修例（reject）任务的会话都在「对话」标签展示; 列表按创建时间
      // 倒序, [0] 即最近一个; fixTask 只跟踪 fix(修复弹窗的操作对象)
      const related = tasks.filter((x) => (x.task_type === 'fix' || x.task_type === 'reject') && (
        (() => { try { return JSON.parse(x.payload || '{}').bug_dir === bugDir } catch { return false } })()
      ))
      const chat = related[0] || null
      const fix = related.find((x) => x.task_type === 'fix') || null
      setChatTask(chat)
      const tid = fix ? fix.id : null
      setFixTask(fix)
      setFixTaskId(tid)
      fixTaskIdRef.current = tid
      if (fix) {
        // 用户输入过的控件不覆盖(保存成功后 touched 已清除, 服务端值随即同步回来)
        setFixDraft((d) => ({
          auto_commit: fixTouchedRef.current.auto_commit ? d.auto_commit : !!fix.auto_commit,
        }))
      }
    } catch { /* 忽略 */ }
  }

  // 修复任务 2s 轮询(仅修复 tab 打开时, 保持按钮/会话输入区状态新鲜)
  useEffect(() => {
    if (stab !== 'fix') return
    const timer = setInterval(() => { refreshFixPanel().catch(() => {}) }, 2000)
    return () => clearInterval(timer)
  }, [stab, curBugDir, projectId])
  // bug 详情 5s 轮询
  useEffect(() => {
    const timer = setInterval(() => { if (curBugDir) reloadDetail().catch(() => {}) }, 5000)
    return () => clearInterval(timer)
  }, [curBugDir, projectId])

  /* ---------- 操作 ---------- */
  function openRetestDlg() {
    if (!curBugDir) { toast(t('请先选择 bug 报告')); return }
    setRetestScope('retest_only')
    setRetestDlg(true)
  }
  async function submitRetestDlg() {
    try {
      await taskApi.create(projectId, {
        task_type: 'retest_bug', bug_dir: curBugDir, retest_scope: retestScope,
      })
      toast(t('复测任务已入队，可在「任务」标签页查看'))
      setRetestDlg(false)
      await store.loadTasks()
      await refreshFixPanel()
    } catch (e) { toast(e.message) }
  }
  // 报告页「修复」: 弹窗收集修改意见(可空)与任务终点——意见存任务 extra 字段, 作为
  // 「用户附加要求」附加到首轮 prompt; 无任务则创建入队, 已结束则先写入意见与
  // 起止阶段再重启重跑(重启从第一轮开始, 用完整首轮 prompt, 意见随之下达 agent)
  function openFixDlg() {
    if (!curBugDir) { toast(t('请先选择 bug 报告')); return }
    setFixOpinion(fixTask?.extra || '')
    setFixEnd(fixTask?.end_stage || 'fix')
    setFixDlg(true)
  }
  async function submitFixDlg() {
    const opinion = fixOpinion.trim()
    try {
      if (!fixTaskId) {
        await taskApi.create(projectId, {
          task_type: 'fix', bug_dir: curBugDir, end_stage: fixEnd,
          // 模型不在此指定: 服务端按项目模型回落(项目设置页配置)
          auto_commit: fixDraft.auto_commit,
          extra: opinion,
        })
        toast(t('修复任务已入队'))
      } else {
        if (fixRunning || fixQueued) { toast(t('任务运行中，请先停止再修复')); return }
        await taskApi.update(fixTaskId, {
          extra: opinion, auto_commit: fixDraft.auto_commit,
          start_stage: 'analyze', end_stage: fixEnd,
        })
        await taskApi.restart(fixTaskId)
        toast(t('修复任务已重启入队'))
      }
      setFixDlg(false)
      setFixOpinion('')
      await store.loadTasks()
      await refreshFixPanel()
      openStab('fix')
    } catch (e) { toast(e.message) }
  }
  // 报告页「拒绝」: 弹窗收集拒绝理由(必填)——平台标记报告「已拒绝」并把理由
  // 追加到报告「拒绝记录」小节, 同时创建修例任务(按理由修正关联用例 + 教训
  // 沉淀 PITFALLS.md); 修例会话同样在「对话」标签常驻展示
  async function submitRejectDlg() {
    const reason = rejectReason.trim()
    if (!reason) { toast(t('请填写拒绝理由')); return }
    try {
      await bugApi.reject(projectId, curBugDir, reason)
      toast(t('已标记拒绝，修例任务已入队'))
      setRejectDlg(false)
      setRejectReason('')
      await store.loadTasks()
      await reloadDetail()
      openStab('fix')
    } catch (e) { toast(e.message) }
  }
  // 修复选项勾选即保存: 自动提交开关实时写入任务行, 下次向 agent 发送指令
  // (下一轮提示词构建)即生效, 无需「应用设置」;
  // 修复任务未创建时暂存本地, 「修复」创建时随参数下发
  async function toggleFixOpt(key, val) {
    setFixDraft((d) => ({ ...d, [key]: val }))
    fixTouchedRef.current = { ...fixTouchedRef.current, [key]: true }
    if (!fixTaskIdRef.current) return
    try {
      await taskApi.update(fixTaskIdRef.current, { [key]: val })
      fixTouchedRef.current = { ...fixTouchedRef.current, [key]: false }
      toast(t('已保存，下次向 agent 发送指令时生效'))
      await refreshFixPanel()
    } catch (e) { toast(e.message) }
  }
  // 对话页的停止/重启作用于展示的会话任务(最近的 fix 或 reject)
  async function stopChat() {
    if (!chatTask) return
    try {
      await taskApi.stop(chatTask.id)
      toast(t('已请求停止'))
      setTimeout(() => refreshFixPanel().catch(() => {}), 800)
    } catch (e) { toast(e.message) }
  }
  async function restartChat() {
    if (!chatTask) { toast(t('尚无修复/修例任务')); return }
    if (chatRunning || chatQueued) { toast(t('任务运行中，请先停止再重启')); return }
    try {
      await taskApi.restart(chatTask.id)
      toast(t('任务已重启入队'))
      await refreshFixPanel()
    } catch (e) { toast(e.message) }
  }

  /* ---------- 左右分栏拖拽 ---------- */
  function startBugDrag(e) {
    if (e.button !== 0 || e.detail > 1) return
    const wrap = bugwrapEl.current
    const cw = parseInt(getComputedStyle(wrap).getPropertyValue('--bugw'), 10) || 400
    const x0 = e.clientX
    e.currentTarget.classList.add('drag')
    document.body.classList.add('resizing-x')
    const move = (ev) => wrap.style.setProperty('--bugw', clamp(cw + (ev.clientX - x0), 260, 760) + 'px')
    const up = () => {
      e.currentTarget.classList.remove('drag')
      document.body.classList.remove('resizing-x')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      localStorage.setItem('ts.bugw', getComputedStyle(wrap).getPropertyValue('--bugw'))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  function resetBugDrag() {
    bugwrapEl.current.style.removeProperty('--bugw')
    localStorage.removeItem('ts.bugw')
  }

  /* ---------- 生命周期 ---------- */
  useEffect(() => {
    try {
      const w = +localStorage.getItem('ts.bugw')
      if (w > 0) bugwrapEl.current.style.setProperty('--bugw', w + 'px')
    } catch { /* 忽略 */ }
  }, [])

  // 恢复刷新前选中的 bug 与子 tab(仅一次, 且用户已交互时跳过——避免覆盖正在查看的内容)
  useEffect(() => {
    if (restoreTriedRef.current || !projectId || !bugs.length) return
    // bugs 可能在用户已交互后才加载完成(如轮询刷新), 此时 curBugDirRef 非空, 不得再恢复覆盖用户操作
    if (curBugDirRef.current) {
      restoreTriedRef.current = true
      return
    }
    let rb = null
    try { rb = JSON.parse(localStorage.getItem('ts_cur_bug') || 'null') } catch { /* 忽略 */ }
    if (rb && rb.proj === projectId && bugs.some((b) => b.dir === rb.dir)) {
      restoreTriedRef.current = true
      selectBug(rb.dir).then(() => {
        const s = rb.stab === 'fix' ? 'fix' : 'report'
        setStab(s)
        stabRef.current = s
      })
    }
  }, [projectId, bugs])

  // 修复选项块(报告页常驻): 自动提交勾选即保存; 部署/复测归宿由修复弹窗的「任务终点」决定
  const fixOptsBlock = (
    <div className="fix-opts">
      <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer', color: 'var(--text)' }}>
        <input type="checkbox" checked={fixDraft.auto_commit}
          onChange={(e) => toggleFixOpt('auto_commit', e.target.checked)} />
        {t('自动提交（修复完成后 git commit，不 push）')}
      </label>
      <span className="hint">{t('部署/复测是否执行由「修复」弹窗中的任务终点决定（终点≥重新部署即部署、终点=复测即任务内复测）')}</span>
    </div>
  )

  return (
    <div className="bugs-tab">
      {project && (
        <div className="bugwrap" ref={bugwrapEl}>
          <div className="bug-left">
            <div className="bug-head">{t('Bug 报告')} <span className="dim">{bugs.length ? t('共 {n}', { n: bugs.length }) : ''}</span></div>
            {/* 等级筛选 chips：同时承担计数展示（全部 / 高 / 中 / 低 / 未分级） */}
            {!!bugs.length && (
              <div className="bug-sev-filter" title={t('按严重程度筛选')}>
                {sevFilterChips.map((chip) => (
                  <button key={chip.cls} type="button"
                    className={'bug-sev-chip ' + chip.cls + (sevFilter === chip.key ? ' on' : '')}
                    onClick={() => setSevFilter(chip.key)}>
                    {chip.label}
                    <b>{chip.count}</b>
                  </button>
                ))}
              </div>
            )}
            <div className="bug-list scroll">
              {!bugs.length && <div className="hint" style={{ padding: 12 }}>{t('暂无 bug 报告')}</div>}
              {!!bugs.length && !shownBugs.length && (
                <div className="hint" style={{ padding: 12 }}>{t('该等级暂无报告')}</div>
              )}
              {shownBugs.map((b) => (
                <div key={b.dir}
                  className={'bugitem' + (curBugDir === b.dir ? ' sel' : '')
                    + (isBugHistory(b.status) ? ' history' : '')}
                  title={/已拒绝/.test(b.status || '') ? t('已被拒绝的报告')
                    : /复测通过/.test(b.status || '') ? t('复测通过的历史报告') : undefined}
                  onClick={() => selectBug(b.dir)}>
                  <div className="bt">{b.title}</div>
                  <div className="bmeta">
                    <span className={'bug-status ' + bugStatusCls(b.status)}>{bugStatusLabel(t, b.status) || '—'}</span>
                    <span className={'bug-sev ' + severityCls(b.severity)}
                      title={t('严重程度')}>{severityLabel(t, b.severity)}</span>
                    {b.last_task && (
                      <span className={'bug-status ' + lastTaskCls(b.last_task.status)}>
                        {b.last_task.name} · {stLabel(b.last_task.status)}
                      </span>
                    )}
                    <span>{t('{n} 用例', { n: b.cases.length })}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="vsplit bug-split" onMouseDown={startBugDrag} onDoubleClick={resetBugDrag}></div>
          <div className="bug-right">
            {detail ? (
              <div className={'bug-content scroll' + (stab === 'fix' ? ' fix-mode' : '')}>
                <div className="head">
                  <h3>{detail.title}</h3>
                  <span className={'bug-status ' + bugStatusCls(detail.status)}>{bugStatusLabel(t, detail.status) || '—'}</span>
                  {/* 严重程度（2026-10-25）：显示即编辑——改动写回 bug_report.md，回执后刷新列表排序 */}
                  <label className="bug-sev-edit" title={t('修改严重程度')}>
                    <span>{t('严重程度')}</span>
                    <select className={'bug-sev-select ' + severityCls(detail.severity)}
                      value={detail.severity || SEV_NONE}
                      disabled={sevSaving}
                      onChange={(e) => changeSeverity(e.target.value)}>
                      {/* 未分级是只读占位：报告缺等级/无法识别时展示，后端不接受空值写回 */}
                      <option value={SEV_NONE} disabled>{severityLabel(t, SEV_NONE)}</option>
                      <option value={SEV_HIGH}>{severityLabel(t, SEV_HIGH)}</option>
                      <option value={SEV_MEDIUM}>{severityLabel(t, SEV_MEDIUM)}</option>
                      <option value={SEV_LOW}>{severityLabel(t, SEV_LOW)}</option>
                    </select>
                  </label>
                </div>
                <div className="mut">
                  bug_report/{detail.dir}
                  {detail.last_task && <> · {t('最近任务「{name}」:{status}', {
                    name: detail.last_task.name,
                    status: stLabel(detail.last_task.status),
                  })}</>}
                  · <Button variant="ghost" size="sm" className="inline-flex h-5 px-1.5 text-[calc(11px*var(--fs))]" onClick={() => reloadDetail()}>
                    <RefreshCw /> {t('刷新')}
                  </Button>
                </div>
                <div className="sub-tabs">
                  <span className={'sub-tab' + (stab === 'report' ? ' on' : '')} onClick={() => openStab('report')}>{t('报告')}</span>
                  <span className={'sub-tab' + (stab === 'fix' ? ' on' : '')} onClick={() => openStab('fix')}>{t('对话')}</span>
                </div>
                {stab === 'report' ? (
                  <>
                    <div className="ops">
                      {/* 已拒绝的报告不再提供复测/拒绝入口，修复仍可用（重新打开的处理路径） */}
                      {!/已拒绝/.test(detail.status || '') && (
                        <Button variant="outline" size="sm" onClick={openRetestDlg}>
                          <Play /> {t('复测')}
                        </Button>
                      )}
                      {/* 未修复完成(待分析/已分析/复测未通过/已拒绝)时直接提供修复入口 */}
                      {![BUG_RETEST_PASS, BUG_FIXED].some((s) => (detail.status || '').includes(s)) && (
                        <Button size="sm" onClick={openFixDlg}>
                          <Wrench /> {t('修复')}
                        </Button>
                      )}
                      {!/已拒绝/.test(detail.status || '') && (
                        <Button variant="outline" size="sm"
                          onClick={() => { setRejectReason(''); setRejectDlg(true) }}>
                          <Ban /> {t('拒绝')}
                        </Button>
                      )}
                      <span className="hint">{t('复测/修复/拒绝都会创建任务（固定一轮）执行；\n复测后若关联用例全部通过，bug 状态自动改为「已修复（复测通过）」；\n修复任务非复测终点完成时标记「修复完成，待复测」；\n拒绝会标记「已拒绝」并按理由修正关联用例；\n修复/修例过程在「对话」标签页实时查看')}</span>
                    </div>
                    {fixOptsBlock}
                    <div className="sec-title">{t('关联用例（{n}）', { n: detail.cases.length })}</div>
                    {detail.cases.length ? (
                      <Table className="text-xs">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="px-2">ID</TableHead>
                            <TableHead className="px-2">{t('名称')}</TableHead>
                            <TableHead className="px-2">{t('状态')}</TableHead>
                            <TableHead className="px-2">{t('最近执行')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.cases.map((c) => (
                            <TableRow key={c.id}>
                              <TableCell className="px-2 font-mono text-xs">{c.id}</TableCell>
                              <TableCell className="px-2">{c.name}</TableCell>
                              <TableCell className="px-2">
                                <span className={'bug-status ' + caseStatusCls(c.status)}>{caseStatusLabel(t, c.status) || '—'}</span>
                              </TableCell>
                              <TableCell className="px-2 font-mono text-xs">{fmtTime(c.last_run)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : <div className="hint">{t('未解析到关联用例')}</div>}
                    <div className="sec-title">{t('完整内容（bug_report.md）')}</div>
                    <div className="md-body" dangerouslySetInnerHTML={mdHtml}></div>
                  </>
                ) : (
                  <div className="fix-panel">
                    {/* 对话页只负责展示与管控(停止/重启); 修复/拒绝入口统一在报告页弹窗 */}
                    <div className="fix-controls">
                      {chatTask && (chatRunning || chatQueued) && (
                        <Button size="sm" variant="outline" onClick={stopChat}>
                          <Square /> {t('停止')}
                        </Button>
                      )}
                      {chatTask && ['stopped', 'failed', 'done', 'interrupted'].includes(chatTask?.status) && (
                        <Button size="sm" variant="outline" onClick={restartChat}>
                          <RotateCcw /> {t('重启任务')}
                        </Button>
                      )}
                      <span className="hint fix-status">{chatStatusText}</span>
                    </div>
                    {/* 修复/修例会话常驻内嵌(与任务列表的会话弹窗同一组件, SSE 实时更新;
                        内嵌版空间有限不显示提问索引侧边栏) */}
                    {chatTask ? (
                      <SessionView task={chatTask} withQBar={false} />
                    ) : (
                      <div className="sess-empty" style={{ flex: 1 }}>
                        {t('尚无修复/修例会话。在「报告」标签页点击「修复」或「拒绝」创建任务后，对话会在这里实时展示。')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="bug-empty">{t('← 选择左侧 bug 报告查看详情；修复 / 复测会创建任务并放入「任务」标签页执行')}</div>
            )}
          </div>
        </div>
      )}
      {/* 修复弹窗：修改意见(可空)随任务 extra 字段下达 agent */}
      <Dialog open={fixDlg} onOpenChange={setFixDlg}>
        <DialogContent className="modal">
          <DialogHeader className="text-left">
            <DialogTitle className="text-sm">{t('修复「{title}」', { title: detail?.title })}</DialogTitle>
          </DialogHeader>
          <div className="form-col">
            <label>{t('修改意见（可选）')}</label>
            <Textarea rows={4} value={fixOpinion}
              onChange={(e) => setFixOpinion(e.target.value)}
              placeholder={t('例如：只修第 3 节指出的空指针判断，不要动缓存层；留空则按报告推荐方案修复')} />
          </div>
          <div className="form-col">
            <label>{t('任务终点')}</label>
            <Select value={fixEnd} onValueChange={setFixEnd}>
              <SelectTrigger size="sm" className="min-w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FIX_ENDS.map((s) => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="hint" style={{ textAlign: 'left' }}>
              {t('起点=报告分析；终点=分析时标记「已分析」；终点≥重新部署时自动部署；终点=问题修复/重新部署时任务完成标记「修复完成，待复测」；终点=复测时任务内复测，全部用例通过标记「已修复（复测通过）」')}
            </span>
          </div>
          <DialogFooter className="flex-none">
            <Button onClick={submitFixDlg}>{fixTaskId ? t('重启修复') : t('开始修复')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 拒绝弹窗：理由必填; 平台标记「已拒绝」并创建修例任务 */}
      <Dialog open={rejectDlg} onOpenChange={setRejectDlg}>
        <DialogContent className="modal">
          <DialogHeader className="text-left">
            <DialogTitle className="text-sm">{t('拒绝「{title}」', { title: detail?.title })}</DialogTitle>
          </DialogHeader>
          <div className="form-col">
            <label>{t('拒绝理由（必填）')}</label>
            <Textarea rows={4} value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t('例如：误报——MCP 超时是环境抖动，不是协议实现问题')} />
            <span className="hint" style={{ textAlign: 'left' }}>
              {t('确认后报告标记为「已拒绝」并调暗沉底；平台将创建修例任务：按理由修正关联用例，\n并把教训记入案例库 PITFALLS.md，后续生成用例时避开同类误报')}
            </span>
          </div>
          <DialogFooter className="flex-none">
            <Button variant="destructive" onClick={submitRejectDlg}>{t('确认拒绝')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 复测弹窗：范围三选一（默认仅复测=现状行为） */}
      <Dialog open={retestDlg} onOpenChange={setRetestDlg}>
        <DialogContent className="modal">
          <DialogHeader className="text-left">
            <DialogTitle className="text-sm">{t('复测「{title}」', { title: detail?.title })}</DialogTitle>
          </DialogHeader>
          <div className="form-col">
            <label>{t('任务范围')}</label>
            <Select value={retestScope} onValueChange={setRetestScope}>
              <SelectTrigger size="sm" className="min-w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RETEST_SCOPES.map((s) => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="hint" style={{ textAlign: 'left' }}>
              {t('仅复测且关联用例全部已固化 verify.py 时走平台脚本复测；范围含重新部署时由 agent 先按项目部署说明部署再复测')}
            </span>
          </div>
          <DialogFooter className="flex-none">
            <Button onClick={submitRetestDlg}>{t('开始复测')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
