import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/app'
import { projectApi, taskApi } from '../api'
import { toast } from '../utils/toast'
import { fmtTime, stLabel } from '../utils/renderMd'
import { RETEST_ALL_FAILED, RETEST_NONE, RETEST_RANGE, retestLabel } from '../utils/taskEnums'
import { t, useI18n } from '../utils/i18n'
import { permissionLabel } from '../utils/permission'
import { useResizable } from '../hooks/useResizable'
import { RzHandles } from './RzHandles'
import SessionModal from './SessionModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Pencil, Save, X, Plus, Square, RotateCcw, RefreshCw, ChevronUp, ChevronDown, MessagesSquare, StepForward, Trash2 } from 'lucide-react'

// 停止条件说明（按存档类型取值；t 在调用时求值）
function stopHint(kind) {
  if (kind === 'rounds') return t('达到轮数后自动停止（每轮由 agent 执行一次内置测试流程）')
  if (kind === 'bugs') return t('案例库新增 bug_report 数达到后自动停止')
  if (kind === 'deadline') return t('到达截止时间后结束本轮并停止（日历点选日期与时间）')
  if (kind === 'duration') return t('运行达到设定时长后停止（每轮结束后检查；一轮进行中不打断）')
  return ''
}

// 可「重启」的终态（压测任务额外放开 done，见列表与详情里的重启按钮）
const RESTARTABLE = ['stopped', 'failed', 'interrupted']

// 新建/继续弹窗的默认表单值
const NT_DEFAULT = {
  name: '', task_type: 'normal', brief: '', end_stage: 'report',
  auto_fix: false, retest: RETEST_NONE,
  stop_type: 'rounds', stop_value: 1, deadline_date: '', deadline_time: '23:59',
  dur_value: 30, dur_unit: 'min', extra: '',
  date_from: '', date_to: '',   // 提交日期范围（复测必填/探索选填）
}

/** 弹窗表单 → 提交用 stop_value；非法输入返回 {err} */
function buildStopValue(f) {
  if (f.stop_type === 'deadline') {
    if (!f.deadline_date) return { err: t('请选择截止日期') }
    return { value: f.deadline_date + 'T' + (f.deadline_time || '23:59') }
  }
  if (f.stop_type === 'duration') {
    if (!f.dur_value || f.dur_value <= 0) return { err: t('请填写时长') }
    return { value: String(Math.round(f.dur_value * ({ min: 60, hour: 3600, day: 86400 }[f.dur_unit]))) }
  }
  if (!f.stop_value) return { err: t('请填写停止条件') }
  return { value: String(f.stop_value) }
}

/** 任务停止条件 → 弹窗表单字段（「继续」回填用）。
 * 轮数/bug 数在续跑语义下指「再跑/再增」的数量，回填默认 1 而非旧累计值；
 * deadline/duration 是绝对语义，直接解析回填。 */
function stopToForm(task) {
  const f = { stop_type: task.stop_type || 'rounds', stop_value: 1,
              deadline_date: '', deadline_time: '23:59', dur_value: 30, dur_unit: 'min' }
  if (f.stop_type === 'deadline') {
    const [d, tm] = String(task.stop_value || '').split('T')
    f.deadline_date = d || ''
    f.deadline_time = tm || '23:59'
  } else if (f.stop_type === 'duration') {
    const s = +task.stop_value || 0
    if (s % 86400 === 0 && s) { f.dur_value = s / 86400; f.dur_unit = 'day' }
    else if (s % 3600 === 0 && s) { f.dur_value = s / 3600; f.dur_unit = 'hour' }
    else { f.dur_value = Math.max(1, Math.round(s / 60)); f.dur_unit = 'min' }
  }
  return f
}

/** 任务详情「权限」行文案（2026-10-24 任务会话对齐卡片）：
 *  任务级 permission 为空＝跟随项目默认；非空走宿主目录 label → 内置中文名 → 原值映射。 */
function permissionLabelFor(options, value) {
  return value ? permissionLabel(options, value) : t('跟随项目默认')
}

// 任务类型 → 展示名（机器值不翻译，只映射展示）
function taskTypeLabel(v) {
  if (v === 'normal') return t('探索')
  if (v === 'fix') return t('修复')
  if (v === 'retest_bug') return t('复测')
  if (v === 'script_retest') return t('脚本复测')
  if (v === 'stress') return t('压测')
  if (v === 'regression') return t('回归')
  if (v === 'pipeline') return t('后段')
  if (v === 'reject') return t('修例')
  return v
}
// 生命周期阶段（与后端 STAGES/STAGE_LABELS 一致）与各类型可选终点（与 STAGE_MATRIX 一致）
function lifecycleStages() {
  return [
    { v: 'gen_case', label: t('测试用例生成') }, { v: 'execute', label: t('测试') },
    { v: 'report', label: t('生成报告') }, { v: 'analyze', label: t('报告分析') },
    { v: 'fix', label: t('问题修复') }, { v: 'deploy', label: t('重新部署') }, { v: 'retest', label: t('复测') },
  ]
}
function stageLabel(v) {
  const hit = lifecycleStages().find((s) => s.v === v)
  return hit ? hit.label : ''
}
// 停止条件类型 → 展示名
function stopTypeLabel(v) {
  if (v === 'rounds') return t('执行轮数')
  if (v === 'bugs') return t('累计新 bug')
  if (v === 'deadline') return t('截止时间')
  if (v === 'duration') return t('持续时长')
  return v
}

// 状态列排序优先级(排队→运行→完成→停止→失败→中断)
const STATUS_ORDER = { queued: 0, running: 1, done: 2, stopped: 3, failed: 4, interrupted: 5 }
// 任务列表列定义(操作列不可排序)
function taskListCols() {
  return [
    { k: 'name', label: t('任务') },
    { k: 'status', label: t('状态') },
    { k: 'round', label: t('轮次'), cls: 'num' },
    { k: 'bugs', label: t('新bug'), cls: 'num' },
    { k: 'created', label: t('创建') },
    { k: 'ended', label: t('结束') },
  ]
}

/** 停止条件值 → 可读文本 */
function stopText(task) {
  const v = task.stop_value || ''
  if (task.stop_type === 'rounds') return t('执行 {n} 轮', { n: v })
  if (task.stop_type === 'bugs') return t('累计新 bug ≥ {n}', { n: v })
  if (task.stop_type === 'deadline') return t('截止 {time}', { time: String(v).replace('T', ' ') })
  if (task.stop_type === 'duration') return t('持续 {dur}', { dur: fmtSecs(v) })
  return task.stop_type
}
/** 秒数 → 天/小时/分钟/秒 */
function fmtSecs(s) {
  const n = +s
  if (!n || n <= 0) return String(s || '')
  if (n % 86400 === 0) return t('{n} 天', { n: n / 86400 })
  if (n % 3600 === 0) return t('{n} 小时', { n: n / 3600 })
  if (n % 60 === 0) return t('{n} 分钟', { n: n / 60 })
  return t('{n} 秒', { n })
}

export default function TasksTab({ onCreated } = {}) {
  // 订阅语言切换（lang 变化即重渲染，文案用模块级 t 按当前语言求值）
  useI18n()
  const store = useAppStore()
  const project = store.currentProject

  const [nt, setNt] = useState(NT_DEFAULT)
  const [showNew, setShowNew] = useState(false)
  // 弹窗模式: null=新建任务; 否则为「继续」的目标任务(共用同一弹窗, 续跑当前 session)
  const [dlgTask, setDlgTask] = useState(null)
  const [guideEdit, setGuideEdit] = useState(false)
  const [guideDraft, setGuideDraft] = useState('')
  // 列表排序: sortKey=列k(null 不排序), sortDir=1 升序/-1 降序
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState(1)
  // 行内折叠详情: openId 为展开的任务 id, detail 为其完整数据
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [rounds, setRounds] = useState([])
  // session 对话窗口: 打开的任务 id(行数据从 store 实时取, 保证状态新鲜)
  const [sessTaskId, setSessTaskId] = useState(null)
  const sessTask = store.tasks.find((x) => x.id === sessTaskId) || null
  const { rzOn, rzStyle, rzStart, rzDragStart, rzReset } = useResizable()
  // 搜索关键字: 匹配任务名称 / session id（大小写不敏感）
  const [kw, setKw] = useState('')
  // 宿主权限目录（2026-10-24 任务会话对齐卡片）：任务详情「权限」行存的是宿主 preset key，
  // 用目录 label 显示中文名；目录不可用（驱动未配置/拉取失败）时 permissionLabel 回退
  // 内置中文名，不阻塞列表/详情（任务级空值＝跟随项目默认）。
  const [permOpts, setPermOpts] = useState([])
  useEffect(() => {
    let stopped = false
    projectApi.agentPresets()
      .then((r) => { if (!stopped) setPermOpts((r && Array.isArray(r.options)) ? r.options : []) })
      .catch(() => { if (!stopped) setPermOpts([]) })
    return () => { stopped = true }
  }, [])

  // 终点选项由生命周期阶段派生（排除 gen_case 的类型 = 回归）
  const stages = lifecycleStages()
  const endOptions = {
    normal: stages,
    regression: stages.filter((s) => s.v !== 'gen_case'),
  }
  const cols = taskListCols()

  // 当前项目的任务(AppShell 已按项目加载 store.tasks)
  const tasks = store.tasks.filter((task) => task.project_id === project?.id)

  // 按关键字过滤（名称 / 会话标题 / session id 子串匹配）
  const filteredTasks = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return tasks
    return tasks.filter((task) =>
      (task.name || '').toLowerCase().includes(k) ||
      (task.session_title || '').toLowerCase().includes(k) ||
      (task.session_id || '').toLowerCase().includes(k))
  }, [tasks, kw])

  // 按当前排序列重排任务(稳定排序; 同值保持原相对顺序)
  const sortedTasks = useMemo(() => {
    if (!sortKey) return filteredTasks
    const val = (task) => {
      switch (sortKey) {
        case 'status': return STATUS_ORDER[task.status] ?? 99   // 未知状态排最后
        case 'round': return task.current_round ?? 0
        case 'bugs': return task.new_bugs ?? 0
        case 'created': return task.created_at || ''
        case 'ended': return task.ended_at || ''                // 空(未结束)排最后
        default: return task.name || ''
      }
    }
    return [...tasks].sort((a, b) => {
      const va = val(a), vb = val(b)
      if (va === vb) return 0
      if (va === '' || va == null) return 1                  // 空值始终沉底
      if (vb === '' || vb == null) return -1
      return va < vb ? -sortDir : sortDir
    })
  }, [filteredTasks, sortKey, sortDir])

  // 点击表头: 首次升序, 再点降序, 第三次还原默认顺序
  function toggleSort(k) {
    if (sortKey !== k) { setSortKey(k); setSortDir(1) }
    else if (sortDir === 1) { setSortDir(-1) }
    else { setSortKey(null); setSortDir(1) }
  }

  async function saveGuide() {
    try {
      await store.updateProject(project.id, { guide_text: guideDraft })
      setGuideEdit(false)
      toast(t('项目提示词已保存'))
    } catch (e) { toast(e.message) }
  }

  async function submitTaskDlg() {
    // 回归任务重跑指令必填（agent 按指令决定重跑哪些用例）
    if (!dlgTask && nt.task_type === 'regression' && !nt.extra.trim()) {
      toast(t('请填写重跑指令')); return
    }
    // 复测（按提交范围）：必填日期范围（LLM 判断范围内提交影响的用例）
    if (!dlgTask && nt.task_type === 'retest_bug' && !nt.date_from && !nt.date_to) {
      toast(t('复测任务需填写提交日期范围')); return
    }
    if (nt.date_from && nt.date_to && nt.date_from > nt.date_to) {
      toast(t('日期范围不正确：起始晚于结束')); return
    }
    // 新建压测任务: 停止条件控件已隐藏, 跳过校验（nt 跨弹窗开关持久, 残留的 deadline/duration
    // 空值会 toast 拦截且用户看不到出错控件）; 后端按 stress 强制 rounds/1, 提交体仍带 stop_type 由服务端覆盖
    const sv = (!dlgTask && nt.task_type === 'stress') ? { value: '1' } : buildStopValue(nt)
    if (sv.err) { toast(sv.err); return }
    // 模型不在此指定: 由服务端按项目模型回落(项目设置页配置)
    const body = {
      name: nt.name, task_type: nt.task_type, brief: nt.brief.trim(),
      end_stage: nt.end_stage || undefined,
      auto_fix: nt.auto_fix, retest: nt.retest,
      stop_type: nt.stop_type, stop_value: sv.value, extra: nt.extra.trim(),
      date_from: nt.date_from || undefined, date_to: nt.date_to || undefined,
    }
    try {
      if (dlgTask) {
        await taskApi.continue(dlgTask.id, body)
        toast(t('已入队，接着原会话续跑'))
      } else {
        await taskApi.create(project.id, body)
        toast(t('任务已入队'))
        // 压测任务建好即切到「压测面板」（用户约定：添加压测用例后就显示在该面板）
        if (nt.task_type === 'stress') onCreated?.('stress')
      }
      setNt({ ...nt, name: '', brief: '', extra: '' })
      setShowNew(false)
      setDlgTask(null)
      await store.loadTasks()
    } catch (e) { toast(e.message) }
  }

  async function deleteTask(task) {
    if (!window.confirm(t('确认删除任务「{name}」？\n轮次记录一并删除（日志文件保留在磁盘），该操作不可恢复。', { name: task.name }))) return
    try {
      await taskApi.remove(task.id)
      toast(t('任务已删除'))
      if (openId === task.id) closeDetail()
      if (sessTaskId === task.id) setSessTaskId(null)
      await store.loadTasks()
    } catch (e) { toast(e.message) }
  }

  async function taskAction(id, op) {
    try {
      await taskApi[op](id)
      toast(op === 'stop' ? t('已请求停止') : t('已清空轮次重启入队（从第一轮重跑）'))
      await store.loadTasks()
      if (openId === id) await refetchDetail(id)
    } catch (e) { toast(e.message) }
  }

  /** 点击任务行：展开/收起行内详情 */
  async function toggleTask(id) {
    if (openId === id) { closeDetail(); return }
    try {
      const d = await taskApi.get(id)
      setDetail(d)
      setOpenId(id)
      await loadRounds(id)
    } catch (e) {
      toast(e.message)
    }
  }

  /** 刷新当前展开任务的详情 */
  async function refetchDetail(id) {
    try {
      setDetail(await taskApi.get(id))
      await loadRounds(id)
    } catch (e) { toast(e.message) }
  }

  async function loadRounds(id) {
    setRounds(await taskApi.rounds(id))
  }

  /** 新标签页打开某轮日志（独立日志页 /log） */
  function openLog(taskId, roundNo) {
    window.open(`/log?task=${taskId}&round=${roundNo}`, '_blank')
  }

  // 新建模式打开弹窗(模型不在此选择, 由服务端按项目设置回落)。
  // 整表单重置为默认值：防止上次弹窗残留的压测类型/停止条件等字段带进新建
  // （「继续」路径不受影响——openContinue 自行按目标任务整表回填）
  function openNewTask() {
    setNt({ ...NT_DEFAULT })
    setDlgTask(null)   // 新建模式
    setShowNew(true)
  }

  /** 打开「继续」弹窗：与新建同一表单，按目标任务回填参数 */
  function openContinue(task) {
    const f = stopToForm(task)
    setNt({
      name: task.name, task_type: task.task_type || 'normal', brief: '',
      end_stage: task.end_stage || '',
      auto_fix: !!task.auto_fix, retest: task.retest || RETEST_NONE,
      stop_type: f.stop_type, stop_value: f.stop_value,
      deadline_date: f.deadline_date, deadline_time: f.deadline_time,
      dur_value: f.dur_value, dur_unit: f.dur_unit,
      extra: task.extra || '',
    })
    setDlgTask(task)
    setShowNew(true)
  }

  function closeDetail() {
    setOpenId(null)
    setDetail(null)
    setRounds([])
  }

  return (
    <div className="tasks-tab scroll">
      {/* 项目信息 */}
      {project && (
        <div className="card">
          <h3>{t('项目信息')}</h3>
          <div className="kv"><span className="k">{t('项目目录')}</span><span className="v">{project.project_dir}</span></div>
          <div className="kv"><span className="k">{t('智能体')}</span><span className="v">
            {(project.agent_path || '').startsWith('dsh-plugin:')
              ? t('dsh（插件·进程内） {path}', { path: project.agent_path.slice(11) })
              : project.agent_path || t('(未设置)')}
          </span></div>
          <div className="kv"><span className="k">{t('模型')}</span><span className="v">{project.model || t('(智能体默认)')}</span></div>
          <div className="kv"><span className="k">{t('工作目录')}</span><span className="v">{project.work_dir}</span></div>
          <div className="kv"><span className="k">{t('环境标签')}</span><span className="v">{project.env_label || t('(未设置)')}</span></div>
          <div className="guide-block">
            <div className="guide-head">
              <span className="text-xs font-semibold text-muted-foreground">{t('项目附加提示词')}</span>
              <span className="hint">{t('编辑后保存；内容会加入每个任务的提示词')}</span>
              <span className="spacer"></span>
              {!guideEdit ? (
                <Button variant="outline" size="sm" onClick={() => { setGuideDraft(project.guide_text || ''); setGuideEdit(true) }}>
                  <Pencil /> {t('编辑')}
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={saveGuide}><Save /> {t('保存')}</Button>
                  <Button variant="outline" size="sm" onClick={() => setGuideEdit(false)}><X /> {t('取消')}</Button>
                </>
              )}
            </div>
            {!guideEdit ? (
              <div className={'guide-read' + (project.guide_text ? '' : ' empty')}>
                {project.guide_text || t('未填写项目附加提示词。点击「编辑」填写如何理解项目、如何写 git commit message、如何部署项目的 skill 或相关信息；内容会加入每个任务的提示词。')}
              </div>
            ) : (
              <Textarea value={guideDraft} onChange={(e) => setGuideDraft(e.target.value)} rows={4}
                placeholder={t('填写如何理解项目、如何写 git commit message、如何部署项目的 skill 或相关信息…')}></Textarea>
            )}
          </div>
        </div>
      )}

      {/* 任务列表(行内折叠详情) */}
      {project && (
        <div className="card">
          <h3 className="card-title-row">{t('任务列表')}
            <span className="spacer"></span>
            <Input className="h-8 w-[240px]" placeholder={t('搜索任务名称 / session id')}
              value={kw} onChange={(e) => setKw(e.target.value)} />
            <Button size="sm" className="ml-2" onClick={openNewTask}><Plus /> {t('新建任务')}</Button>
          </h3>
          {!tasks.length ? <div className="hint">{t('暂无任务，点击右上角「新建任务」创建')}</div>
            : !filteredTasks.length ? <div className="hint">{t('没有匹配「{kw}」的任务', { kw: kw.trim() })}</div> : (
            <div className="tl">
              <div className="tl-head tl-grid">
                {cols.map((c) => (
                  <span key={c.k} className={'th-sort' + (c.cls ? ' ' + c.cls : '') + (sortKey === c.k ? ' on' : '')}
                    onClick={() => toggleSort(c.k)} title={t('点击排序：升序 → 降序 → 还原')}>
                    {c.label}
                    {sortKey === c.k && (sortDir === 1
                      ? <ChevronUp className="inline h-3 w-3" />
                      : <ChevronDown className="inline h-3 w-3" />)}
                  </span>
                ))}
                <span className="tl-ops">{t('操作')}</span>
              </div>
              {sortedTasks.map((task) => (
                <div key={task.id}>
                  <div className={'tl-row tl-grid' + (openId === task.id ? ' open' : '')}
                    onClick={() => toggleTask(task.id)} title={openId === task.id ? t('收起详情') : t('点击查看详情')}>
                    <div className="tl-name">
                      {task.name}
                      {task.task_type !== 'normal' && (
                        <span className="badge st-running" style={{ verticalAlign: -2 }}>
                          {taskTypeLabel(task.task_type)}
                        </span>
                      )}
                      {task.task_type === 'fix' && (task.auto_commit || task.auto_deploy || task.auto_retest) && (
                        <span className="badge st-stopped" style={{ verticalAlign: -2 }}>
                          {task.auto_commit ? t('自动提交') : ''}{task.auto_commit && task.auto_deploy ? '/' : ''}{task.auto_deploy ? t('自动部署') : ''}{task.auto_deploy && task.auto_retest ? '/' : ''}{task.auto_retest ? t('自动复测') : ''}
                        </span>
                      )}
                      {/* 等待作答徽标（2026-10-24 任务会话对齐卡片）：列表行
                          interaction_pending=任务会话正挂起等用户作答（agent 提问/审批）。
                          后端只对 status=running 的任务探测，前端只按字段渲染。 */}
                      {task.interaction_pending && (
                        <span className="badge st-retest" style={{ verticalAlign: -2 }}
                          title={t('agent 向用户提问挂起，等待作答')}>
                          {t('等待作答')}
                        </span>
                      )}
                      {task.error && <div className="tl-err">{task.error}</div>}
                    </div>
                    <div><span className={'badge st-' + task.status}><span className="dot"></span>{stLabel(task.status)}</span></div>
                    <div className="mono num">{task.current_round}</div>
                    <div className="mono num">{task.new_bugs}</div>
                    <div className="mono">{fmtTime(task.created_at)}</div>
                    <div className="mono">{fmtTime(task.ended_at)}</div>
                    <div className="tl-ops">
                      <Button variant="outline" size="sm" className="px-2"
                        title={t('会话（查看原始对话内容，可直接在会话中继续对话）')}
                        onClick={(e) => { e.stopPropagation(); setSessTaskId(task.id) }}>
                        <MessagesSquare />
                      </Button>
                      {(task.status === 'running' || task.status === 'queued') && (
                        <Button variant="outline" size="sm"
                          onClick={(e) => { e.stopPropagation(); taskAction(task.id, 'stop') }}>
                          <Square /> {t('停止')}
                        </Button>
                      )}
                      {task.task_type !== 'stress' && ['stopped', 'failed', 'interrupted', 'done'].includes(task.status) && (
                        <Button variant="outline" size="sm"
                          title={t('继续：修改参数后接着当前会话续跑（不新建会话、不清空轮次）')}
                          onClick={(e) => { e.stopPropagation(); openContinue(task) }}>
                          <StepForward /> {t('继续')}
                        </Button>
                      )}
                      {/* 压测任务 done 后仍给「重启」入口（复压入口在压测面板；此处只是任务管理视角） */}
                      {(RESTARTABLE.includes(task.status)
                        || (task.task_type === 'stress' && task.status === 'done')) && (
                        <Button variant="outline" size="sm"
                          onClick={(e) => { e.stopPropagation(); taskAction(task.id, 'restart') }}>
                          <RotateCcw /> {t('重启')}
                        </Button>
                      )}
                      {task.status !== 'running' && (
                        <Button variant="outline" size="sm" className="px-2"
                          title={t('删除任务（轮次记录一并删除，不可恢复）')}
                          onClick={(e) => { e.stopPropagation(); deleteTask(task) }}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* 行内详情 */}
                  {openId === task.id && detail && (
                    <div className="tl-detail">
                      <div className="tl-detail-head">
                        <b>{t('任务详情')}</b><span className="dim">{t('「{name}」', { name: detail.name })}</span>
                        <span className="spacer"></span>
                        <Button variant="outline" size="sm" className="h-6 px-2 text-[calc(11px*var(--fs))]"
                          onClick={() => refetchDetail(task.id)}>
                          <RefreshCw /> {t('刷新')}
                        </Button>
                        <Button variant="outline" size="sm" className="h-6 px-2 text-[calc(11px*var(--fs))]"
                          onClick={closeDetail}>
                          <X /> {t('收起')}
                        </Button>
                      </div>

                      {/* 创建时参数 */}
                      <div className="detail-grid">
                        <div className="kv"><span className="k">{t('状态')}</span><span className="v"><span className={'badge st-' + detail.status}><span className="dot"></span>{stLabel(detail.status)}</span></span></div>
                        <div className="kv"><span className="k">{t('任务类型')}</span><span className="v">{taskTypeLabel(detail.task_type)}</span></div>
                        <div className="kv"><span className="k">{t('阶段范围')}</span><span className="v">{detail.start_stage ? `${stageLabel(detail.start_stage)} → ${stageLabel(detail.end_stage) || detail.end_stage}` : t('（按类型默认）')}</span></div>
                        {detail.task_type === 'pipeline' && (
                          <div className="kv"><span className="k">{t('前段任务')}</span><span className="v">#{(() => { try { return JSON.parse(detail.payload || '{}').parent_task_id || '?' } catch (e) { return '?' } })()}</span></div>
                        )}
                        <div className="kv"><span className="k">{t('停止条件')}</span><span className="v">{stopTypeLabel(detail.stop_type)} · {stopText(detail)}</span></div>
                        <div className="kv"><span className="k">{t('自动修复')}</span><span className="v">{detail.auto_fix ? t('开') : t('关')}</span></div>
                        <div className="kv"><span className="k">{t('复测')}</span><span className="v">{detail.retest ? retestLabel(detail.retest) : t('不复测')}</span></div>
                        <div className="kv"><span className="k">{t('模型')}</span><span className="v">{detail.model || t('（默认）')}</span></div>
                        {/* 权限档（2026-10-24 任务会话对齐卡片）：任务级 preset key 用宿主目录
                            label 显示中文名；空＝跟随项目默认（权限链：会话实况 → tasks.permission
                            → projects.permission_mode，会话窗切换会回写任务级默认） */}
                        <div className="kv"><span className="k">{t('权限')}</span><span className="v">{permissionLabelFor(permOpts, detail.permission)}</span></div>
                        <div className="kv"><span className="k">{t('自动提交')}</span><span className="v">{detail.auto_commit ? t('开') : t('关')}</span></div>
                        <div className="kv"><span className="k">{t('自动部署')}</span><span className="v">{detail.auto_deploy ? t('开') : t('关')}</span></div>
                        <div className="kv"><span className="k">{t('自动复测')}</span><span className="v">{detail.auto_retest ? t('开') : t('关')}</span></div>
                        <div className="kv"><span className="k">{t('会话 ID')}</span><span className="v">{detail.session_id || t('（首轮后生成）')}</span></div>
                        {detail.session_title && (
                          <div className="kv"><span className="k">{t('会话标题')}</span><span className="v">{detail.session_title}</span></div>
                        )}
                        <div className="kv"><span className="k">{t('创建时间')}</span><span className="v">{fmtTime(detail.created_at)}</span></div>
                        <div className="kv"><span className="k">{t('开始时间')}</span><span className="v">{fmtTime(detail.started_at)}</span></div>
                        <div className="kv"><span className="k">{t('结束时间')}</span><span className="v">{fmtTime(detail.ended_at)}</span></div>
                        <div className="kv"><span className="k">{t('当前轮次')}</span><span className="v">{detail.current_round}</span></div>
                        <div className="kv"><span className="k">{t('新增案例')}</span><span className="v" style={{ color: 'var(--pass)' }}>+{detail.new_cases ?? 0}</span></div>
                        <div className="kv"><span className="k">{t('新增 bug')}</span><span className="v">{detail.new_bugs}</span></div>
                      </div>
                      {detail.error && (
                        <div className="detail-err">{t('错误：{msg}', { msg: detail.error })}</div>
                      )}
                      {detail.extra && (
                        <div className="kv" style={{ marginTop: 8 }}>
                          <span className="k">{t('其他要求')}</span>
                          <span className="v" style={{ fontFamily: 'inherit', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{detail.extra}</span>
                        </div>
                      )}

                      {(RESTARTABLE.includes(detail.status)
                        || (detail.task_type === 'stress' && detail.status === 'done')) && (
                        <div className="form-row" style={{ marginTop: 8 }}>
                          <Button variant="outline" size="sm" onClick={() => taskAction(detail.id, 'restart')}>
                            <RotateCcw /> {t('重启任务（清空轮次，从第一轮重跑）')}
                          </Button>
                        </div>
                      )}

                      <Table className="mt-2.5 text-xs">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="px-2">{t('轮次')}</TableHead>
                            <TableHead className="px-2">{t('状态')}</TableHead>
                            <TableHead className="px-2">{t('退出码')}</TableHead>
                            <TableHead className="px-2">{t('开始')}</TableHead>
                            <TableHead className="px-2">{t('结束')}</TableHead>
                            <TableHead className="px-2">{t('日志')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rounds.map((r) => (
                            <TableRow key={r.round_no} className="cursor-pointer" title={t('新标签页查看日志')}
                              onClick={() => openLog(detail.id, r.round_no)}>
                              <TableCell className="px-2">{r.round_no}</TableCell>
                              <TableCell className="px-2">{r.status}</TableCell>
                              <TableCell className="px-2 font-mono">{r.exit_code == null ? '—' : r.exit_code}</TableCell>
                              <TableCell className="px-2 font-mono text-xs">{fmtTime(r.started_at)}</TableCell>
                              <TableCell className="px-2 font-mono text-xs">{fmtTime(r.ended_at)}</TableCell>
                              <TableCell className="px-2 text-[var(--star-text)]">{t('查看日志')}</TableCell>
                            </TableRow>
                          ))}
                          {!rounds.length && (
                            <TableRow><TableCell colSpan={6} className="px-2 text-muted-foreground">{t('尚未执行轮次')}</TableCell></TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 新建/继续任务弹窗: 保留自定义拖拽; 模型不在此选择, 跟随项目设置 */}
      {project && (
        <Dialog open={showNew} onOpenChange={(v) => { setShowNew(v); if (!v) setDlgTask(null) }}>
          <DialogContent
            className={'modal modal-rz' + (rzOn ? ' rz-drag' : '')}
            style={{ ...rzStyle, marginTop: 0 }}
            showCloseButton={false}
          >
            <RzHandles start={rzStart} reset={rzReset} />
            <DialogHeader className="text-left">
              <DialogTitle className="cursor-move select-none text-sm" onMouseDown={rzDragStart}>
                {dlgTask ? t('继续任务「{name}」', { name: dlgTask.name }) : t('新建任务')}
              </DialogTitle>
            </DialogHeader>
            {dlgTask && (
              <div className="hint" style={{ textAlign: 'left', margin: '0 0 8px' }}>
                {t('接着当前会话继续执行（不新建会话、历史轮次保留）；停止条件中的轮数/bug 数指「再跑/再增」的数量')}
              </div>
            )}
            <div className="modal-scroll overflow-y-auto">
              <div className="form-row"><label>{t('任务名称')}</label>
                <Input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value.trim() })} placeholder={t('留空自动命名')} /></div>
              {!dlgTask && (
                <div className="form-row"><label>{t('任务类型')}</label>
                  <Select value={nt.task_type} onValueChange={(v) => setNt((prev) => {
                    const next = { ...prev, task_type: v }
                    // 切换类型后：残留终点不在新类型可选终点集时回落缺省 report（两种类型缺省均为 report）
                    const opts = endOptions[v]
                    if (opts && !opts.some((s) => s.v === next.end_stage)) next.end_stage = 'report'
                    return next
                  })}>
                    <SelectTrigger size="sm" className="min-w-[120px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">{t('探索')}</SelectItem>
                      <SelectItem value="regression">{t('回归')}</SelectItem>
                      <SelectItem value="retest_bug">{t('复测（按提交范围）')}</SelectItem>
                      <SelectItem value="stress">{t('压力测试')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* 提交日期范围：复测必填（无报告复测，LLM 判断受影响用例）/ 探索选填（优先相关用例） */}
              {!dlgTask && (nt.task_type === 'retest_bug' || nt.task_type === 'normal') && (
                <div className="form-row"><label>{t('提交日期范围')}</label>
                  <Input type="date" className="h-8 w-auto" value={nt.date_from}
                    onChange={(e) => setNt({ ...nt, date_from: e.target.value })} />
                  <span className="hint">{t('至')}</span>
                  <Input type="date" className="h-8 w-auto" value={nt.date_to}
                    onChange={(e) => setNt({ ...nt, date_to: e.target.value })} />
                  <span className="hint">{nt.task_type === 'retest_bug'
                    ? t('LLM 分析范围内提交影响的用例并执行复测（必填）')
                    : t('本轮优先设计/执行与该范围提交相关的用例（选填）')}</span>
                </div>
              )}
              {!dlgTask && endOptions[nt.task_type] && (
                <div className="form-row"><label>{t('任务终点')}</label>
                  <Select value={nt.end_stage} onValueChange={(v) => setNt({ ...nt, end_stage: v })}>
                    <SelectTrigger size="sm" className="min-w-[120px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {endOptions[nt.task_type].map((s) => (
                        <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="hint">{t('任务执行到该阶段为止；终点在「生成报告」之后会自动追加一个后段任务')}</span>
                </div>
              )}
              {dlgTask && endOptions[nt.task_type] && (
                <div className="form-row"><label>{t('任务终点')}</label>
                  <span className="hint">{stageLabel(nt.end_stage) || t('（按类型默认）')}</span>
                </div>
              )}
              {nt.task_type === 'stress' && (
                <>
                  <div className="hint" style={{ textAlign: 'left', margin: '0 0 8px' }}>
                    {t('压测任务固定两步：第 1 轮 agent 生成压测场景 → 平台自动发压并出报告；生命周期：测试 → 生成报告。不支持「继续」，重启=重跑。')}
                  </div>
                  <div className="form-col">
                    <Label className="text-xs text-muted-foreground" style={{ marginBottom: 2 }}>
                      {t('压测说明（目标服务地址、关注接口、并发/时长期望）')}
                    </Label>
                    <Textarea value={nt.brief} onChange={(e) => setNt({ ...nt, brief: e.target.value })} rows={4}
                      placeholder={t('例如：目标 http://127.0.0.1:8080，压 /api/order 下单与 /api/order/123 查询，按 10→50→100 并发各 1 分钟')}></Textarea>
                  </div>
                </>
              )}
              {!dlgTask && (nt.task_type === 'normal' || nt.task_type === 'regression') && (
                <div className="form-row">
                  <label title={t('测试任务行为：测试中发现的 bug 由 agent 自动修复代码')}>{t('自动修复 bug')}</label>
                  <input type="checkbox" checked={nt.auto_fix} onChange={(e) => setNt({ ...nt, auto_fix: e.target.checked })} />
                  <label style={{ marginLeft: 14 }}>{t('复测')}</label>
                  <Select value={nt.retest} onValueChange={(v) => setNt({ ...nt, retest: v })}>
                    <SelectTrigger size="sm" className="min-w-[130px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={RETEST_NONE}>{t('不复测')}</SelectItem>
                      <SelectItem value={RETEST_ALL_FAILED}>{t('全部失败用例')}</SelectItem>
                      <SelectItem value={RETEST_RANGE}>{t('指定范围复测')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {nt.task_type !== 'stress' && (
                <div className="form-row">
                  <label>{t('停止条件')}</label>
                  <Select value={nt.stop_type} onValueChange={(v) => setNt({ ...nt, stop_type: v })}>
                    <SelectTrigger size="sm" className="min-w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rounds">{t('执行轮数')}</SelectItem>
                      <SelectItem value="bugs">{t('累计新 bug 数')}</SelectItem>
                      <SelectItem value="deadline">{t('截止时间')}</SelectItem>
                      <SelectItem value="duration">{t('持续时长')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {(nt.stop_type === 'rounds' || nt.stop_type === 'bugs') && (
                    <Input type="number" min="1" className="h-8 w-[90px]"
                      value={nt.stop_value}
                      onChange={(e) => setNt({ ...nt, stop_value: e.target.value === '' ? '' : +e.target.value })} />
                  )}
                  {nt.stop_type === 'deadline' && (
                    <span className="flex items-center gap-1.5">
                      <Input type="date" className="h-8 w-auto" value={nt.deadline_date} onChange={(e) => setNt({ ...nt, deadline_date: e.target.value })} />
                      <Input type="time" className="h-8 w-[110px]" value={nt.deadline_time} onChange={(e) => setNt({ ...nt, deadline_time: e.target.value })} />
                    </span>
                  )}
                  {nt.stop_type === 'duration' && (
                    <span className="flex items-center gap-1.5">
                      <Input type="number" min="1" className="h-8 w-[90px]" value={nt.dur_value}
                        onChange={(e) => setNt({ ...nt, dur_value: e.target.value === '' ? '' : +e.target.value })} />
                      <Select value={nt.dur_unit} onValueChange={(v) => setNt({ ...nt, dur_unit: v })}>
                        <SelectTrigger size="sm" className="min-w-[70px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="min">{t('分钟')}</SelectItem>
                          <SelectItem value="hour">{t('小时')}</SelectItem>
                          <SelectItem value="day">{t('天')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </span>
                  )}
                  <span className="hint">{stopHint(nt.stop_type)}</span>
                </div>
              )}
              <div className="form-col">
                <Label className="text-xs text-muted-foreground" style={{ marginBottom: 2 }}>
                  {!dlgTask && nt.task_type === 'regression'
                    ? t('重跑指令（必填：描述要重跑的范围，如模块 / 用例 ID / 变更说明）')
                    : t('其他要求（选填，原样传给 agent）')}
                </Label>
                <Textarea value={nt.extra} onChange={(e) => setNt({ ...nt, extra: e.target.value })} rows={3}
                  placeholder={!dlgTask && nt.task_type === 'regression'
                    ? t('例如：重跑登录模块全部用例；或：本次变更涉及订单接口，重跑 ORD-003、ORD-004')
                    : t('自由填写，例如：本轮优先测试订单模块；只读代码，不要提出修复方案；执行前先阅读 src/X 目录……')}></Textarea>
              </div>
            </div>
            <DialogFooter className="flex-none">
              <Button variant="outline" onClick={() => { setShowNew(false); setDlgTask(null) }}>{t('取消')}</Button>
              <Button onClick={submitTaskDlg}>{dlgTask ? t('继续执行') : t('开始任务')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* session 对话窗口(查看原始对话 + 续发消息) */}
      {sessTask && (
        <SessionModal task={sessTask} onClose={() => setSessTaskId(null)} />
      )}
    </div>
  )
}
