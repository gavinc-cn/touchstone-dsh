import { useState, useMemo } from 'react'
import { useAppStore } from '../stores/app'
import { taskApi } from '../api'
import { toast } from '../utils/toast'
import { ST_LABEL, fmtTime } from '../utils/renderMd'
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

const STOP_HINT = {
  rounds: '达到轮数后自动停止（每轮由 agent 执行一次内置测试流程）',
  bugs: '案例库新增 bug_report 数达到后自动停止',
  deadline: '到达截止时间后结束本轮并停止（日历点选日期与时间）',
  duration: '运行达到设定时长后停止（每轮结束后检查；一轮进行中不打断）',
}

// 可「重启」的终态（压测任务额外放开 done，见列表与详情里的重启按钮）
const RESTARTABLE = ['stopped', 'failed', 'interrupted']

// 新建/继续弹窗的默认表单值
const NT_DEFAULT = {
  name: '', task_type: 'normal', brief: '', end_stage: 'report',
  auto_fix: false, retest: '不复测',
  stop_type: 'rounds', stop_value: 1, deadline_date: '', deadline_time: '23:59',
  dur_value: 30, dur_unit: 'min', extra: '',
  date_from: '', date_to: '',   // 提交日期范围（复测必填/探索选填）
}

/** 弹窗表单 → 提交用 stop_value；非法输入返回 {err} */
function buildStopValue(f) {
  if (f.stop_type === 'deadline') {
    if (!f.deadline_date) return { err: '请选择截止日期' }
    return { value: f.deadline_date + 'T' + (f.deadline_time || '23:59') }
  }
  if (f.stop_type === 'duration') {
    if (!f.dur_value || f.dur_value <= 0) return { err: '请填写时长' }
    return { value: String(Math.round(f.dur_value * ({ min: 60, hour: 3600, day: 86400 }[f.dur_unit]))) }
  }
  if (!f.stop_value) return { err: '请填写停止条件' }
  return { value: String(f.stop_value) }
}

/** 任务停止条件 → 弹窗表单字段（「继续」回填用）。
 * 轮数/bug 数在续跑语义下指「再跑/再增」的数量，回填默认 1 而非旧累计值；
 * deadline/duration 是绝对语义，直接解析回填。 */
function stopToForm(t) {
  const f = { stop_type: t.stop_type || 'rounds', stop_value: 1,
              deadline_date: '', deadline_time: '23:59', dur_value: 30, dur_unit: 'min' }
  if (f.stop_type === 'deadline') {
    const [d, tm] = String(t.stop_value || '').split('T')
    f.deadline_date = d || ''
    f.deadline_time = tm || '23:59'
  } else if (f.stop_type === 'duration') {
    const s = +t.stop_value || 0
    if (s % 86400 === 0 && s) { f.dur_value = s / 86400; f.dur_unit = 'day' }
    else if (s % 3600 === 0 && s) { f.dur_value = s / 3600; f.dur_unit = 'hour' }
    else { f.dur_value = Math.max(1, Math.round(s / 60)); f.dur_unit = 'min' }
  }
  return f
}

const TASK_TYPE_LABEL = { normal: '探索', fix: '修复', retest_bug: '复测', script_retest: '脚本复测', stress: '压测', regression: '回归', pipeline: '后段', reject: '修例' }
// 生命周期阶段（与后端 STAGES/STAGE_LABELS 一致）与各类型可选终点（与 STAGE_MATRIX 一致）
const STAGES = [
  { v: 'gen_case', label: '测试用例生成' }, { v: 'execute', label: '测试' },
  { v: 'report', label: '生成报告' }, { v: 'analyze', label: '报告分析' },
  { v: 'fix', label: '问题修复' }, { v: 'deploy', label: '重新部署' }, { v: 'retest', label: '复测' },
]
const END_OPTIONS = {
  normal: STAGES,
  regression: STAGES.filter((s) => s.v !== 'gen_case'),
}
const stageLabel = (v) => (STAGES.find((s) => s.v === v) || {}).label || ''
const STOP_TYPE_LABEL = { rounds: '执行轮数', bugs: '累计新 bug', deadline: '截止时间', duration: '持续时长' }

// 状态列排序优先级(排队→运行→完成→停止→失败→中断)
const STATUS_ORDER = { queued: 0, running: 1, done: 2, stopped: 3, failed: 4, interrupted: 5 }
// 任务列表列定义(操作列不可排序)
const TL_COLS = [
  { k: 'name', label: '任务' },
  { k: 'status', label: '状态' },
  { k: 'round', label: '轮次', cls: 'num' },
  { k: 'bugs', label: '新bug', cls: 'num' },
  { k: 'created', label: '创建' },
  { k: 'ended', label: '结束' },
]

/** 停止条件值 → 可读文本 */
function stopText(t) {
  const v = t.stop_value || ''
  if (t.stop_type === 'rounds') return `执行 ${v} 轮`
  if (t.stop_type === 'bugs') return `累计新 bug ≥ ${v}`
  if (t.stop_type === 'deadline') return `截止 ${String(v).replace('T', ' ')}`
  if (t.stop_type === 'duration') return `持续 ${fmtSecs(v)}`
  return t.stop_type
}
/** 秒数 → 天/小时/分钟/秒 */
function fmtSecs(s) {
  const n = +s
  if (!n || n <= 0) return String(s || '')
  if (n % 86400 === 0) return n / 86400 + ' 天'
  if (n % 3600 === 0) return n / 3600 + ' 小时'
  if (n % 60 === 0) return n / 60 + ' 分钟'
  return n + ' 秒'
}

export default function TasksTab({ onCreated } = {}) {
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

  // 当前项目的任务(AppShell 已按项目加载 store.tasks)
  const tasks = store.tasks.filter((t) => t.project_id === project?.id)

  // 按关键字过滤（名称 / 会话标题 / session id 子串匹配）
  const filteredTasks = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return tasks
    return tasks.filter((t) =>
      (t.name || '').toLowerCase().includes(k) ||
      (t.session_title || '').toLowerCase().includes(k) ||
      (t.session_id || '').toLowerCase().includes(k))
  }, [tasks, kw])

  // 按当前排序列重排任务(稳定排序; 同值保持原相对顺序)
  const sortedTasks = useMemo(() => {
    if (!sortKey) return filteredTasks
    const val = (t) => {
      switch (sortKey) {
        case 'status': return STATUS_ORDER[t.status] ?? 99   // 未知状态排最后
        case 'round': return t.current_round ?? 0
        case 'bugs': return t.new_bugs ?? 0
        case 'created': return t.created_at || ''
        case 'ended': return t.ended_at || ''                // 空(未结束)排最后
        default: return t.name || ''
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
      toast('项目提示词已保存')
    } catch (e) { toast(e.message) }
  }

  async function submitTaskDlg() {
    // 回归任务重跑指令必填（agent 按指令决定重跑哪些用例）
    if (!dlgTask && nt.task_type === 'regression' && !nt.extra.trim()) {
      toast('请填写重跑指令'); return
    }
    // 复测（按提交范围）：必填日期范围（LLM 判断范围内提交影响的用例）
    if (!dlgTask && nt.task_type === 'retest_bug' && !nt.date_from && !nt.date_to) {
      toast('复测任务需填写提交日期范围'); return
    }
    if (nt.date_from && nt.date_to && nt.date_from > nt.date_to) {
      toast('日期范围不正确：起始晚于结束'); return
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
        toast('已入队，接着原会话续跑')
      } else {
        await taskApi.create(project.id, body)
        toast('任务已入队')
        // 压测任务建好即切到「压测面板」（用户约定：添加压测用例后就显示在该面板）
        if (nt.task_type === 'stress') onCreated?.('stress')
      }
      setNt({ ...nt, name: '', brief: '', extra: '' })
      setShowNew(false)
      setDlgTask(null)
      await store.loadTasks()
    } catch (e) { toast(e.message) }
  }

  async function deleteTask(t) {
    if (!window.confirm(`确认删除任务「${t.name}」？\n轮次记录一并删除（日志文件保留在磁盘），该操作不可恢复。`)) return
    try {
      await taskApi.remove(t.id)
      toast('任务已删除')
      if (openId === t.id) closeDetail()
      if (sessTaskId === t.id) setSessTaskId(null)
      await store.loadTasks()
    } catch (e) { toast(e.message) }
  }

  async function taskAction(id, op) {
    try {
      await taskApi[op](id)
      toast(op === 'stop' ? '已请求停止' : '已清空轮次重启入队（从第一轮重跑）')
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
  function openContinue(t) {
    const f = stopToForm(t)
    setNt({
      name: t.name, task_type: t.task_type || 'normal', brief: '',
      end_stage: t.end_stage || '',
      auto_fix: !!t.auto_fix, retest: t.retest || '不复测',
      stop_type: f.stop_type, stop_value: f.stop_value,
      deadline_date: f.deadline_date, deadline_time: f.deadline_time,
      dur_value: f.dur_value, dur_unit: f.dur_unit,
      extra: t.extra || '',
    })
    setDlgTask(t)
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
          <h3>项目信息</h3>
          <div className="kv"><span className="k">项目目录</span><span className="v">{project.project_dir}</span></div>
          <div className="kv"><span className="k">智能体</span><span className="v">
            {(project.agent_path || '').startsWith('dsh-plugin:')
              ? `dsh（插件·进程内） ${project.agent_path.slice(11)}`
              : project.agent_path || '(未设置)'}
          </span></div>
          <div className="kv"><span className="k">模型</span><span className="v">{project.model || '(智能体默认)'}</span></div>
          <div className="kv"><span className="k">工作目录</span><span className="v">{project.work_dir}</span></div>
          <div className="kv"><span className="k">环境标签</span><span className="v">{project.env_label || '(未设置)'}</span></div>
          <div className="guide-block">
            <div className="guide-head">
              <span className="text-xs font-semibold text-muted-foreground">项目附加提示词</span>
              <span className="hint">编辑后保存；内容会加入每个任务的提示词</span>
              <span className="spacer"></span>
              {!guideEdit ? (
                <Button variant="outline" size="sm" onClick={() => { setGuideDraft(project.guide_text || ''); setGuideEdit(true) }}>
                  <Pencil /> 编辑
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={saveGuide}><Save /> 保存</Button>
                  <Button variant="outline" size="sm" onClick={() => setGuideEdit(false)}><X /> 取消</Button>
                </>
              )}
            </div>
            {!guideEdit ? (
              <div className={'guide-read' + (project.guide_text ? '' : ' empty')}>
                {project.guide_text || '未填写项目附加提示词。点击「编辑」填写如何理解项目、如何写 git commit message、如何部署项目的 skill 或相关信息；内容会加入每个任务的提示词。'}
              </div>
            ) : (
              <Textarea value={guideDraft} onChange={(e) => setGuideDraft(e.target.value)} rows={4}
                placeholder="填写如何理解项目、如何写 git commit message、如何部署项目的 skill 或相关信息…"></Textarea>
            )}
          </div>
        </div>
      )}

      {/* 任务列表(行内折叠详情) */}
      {project && (
        <div className="card">
          <h3 className="card-title-row">任务列表
            <span className="spacer"></span>
            <Input className="h-8 w-[240px]" placeholder="搜索任务名称 / session id"
              value={kw} onChange={(e) => setKw(e.target.value)} />
            <Button size="sm" className="ml-2" onClick={openNewTask}><Plus /> 新建任务</Button>
          </h3>
          {!tasks.length ? <div className="hint">暂无任务，点击右上角「新建任务」创建</div>
            : !filteredTasks.length ? <div className="hint">没有匹配「{kw.trim()}」的任务</div> : (
            <div className="tl">
              <div className="tl-head tl-grid">
                {TL_COLS.map((c) => (
                  <span key={c.k} className={'th-sort' + (c.cls ? ' ' + c.cls : '') + (sortKey === c.k ? ' on' : '')}
                    onClick={() => toggleSort(c.k)} title="点击排序：升序 → 降序 → 还原">
                    {c.label}
                    {sortKey === c.k && (sortDir === 1
                      ? <ChevronUp className="inline h-3 w-3" />
                      : <ChevronDown className="inline h-3 w-3" />)}
                  </span>
                ))}
                <span className="tl-ops">操作</span>
              </div>
              {sortedTasks.map((t) => (
                <div key={t.id}>
                  <div className={'tl-row tl-grid' + (openId === t.id ? ' open' : '')}
                    onClick={() => toggleTask(t.id)} title={openId === t.id ? '收起详情' : '点击查看详情'}>
                    <div className="tl-name">
                      {t.name}
                      {t.task_type !== 'normal' && (
                        <span className="badge st-running" style={{ verticalAlign: -2 }}>
                          {TASK_TYPE_LABEL[t.task_type] || t.task_type}
                        </span>
                      )}
                      {t.task_type === 'fix' && (t.auto_commit || t.auto_deploy || t.auto_retest) && (
                        <span className="badge st-stopped" style={{ verticalAlign: -2 }}>
                          {t.auto_commit ? '自动提交' : ''}{t.auto_commit && t.auto_deploy ? '/' : ''}{t.auto_deploy ? '自动部署' : ''}{t.auto_deploy && t.auto_retest ? '/' : ''}{t.auto_retest ? '自动复测' : ''}
                        </span>
                      )}
                      {t.error && <div className="tl-err">{t.error}</div>}
                    </div>
                    <div><span className={'badge st-' + t.status}><span className="dot"></span>{ST_LABEL[t.status] || t.status}</span></div>
                    <div className="mono num">{t.current_round}</div>
                    <div className="mono num">{t.new_bugs}</div>
                    <div className="mono">{fmtTime(t.created_at)}</div>
                    <div className="mono">{fmtTime(t.ended_at)}</div>
                    <div className="tl-ops">
                      <Button variant="outline" size="sm" className="px-2"
                        title="会话（查看原始对话内容，可直接在会话中继续对话）"
                        onClick={(e) => { e.stopPropagation(); setSessTaskId(t.id) }}>
                        <MessagesSquare />
                      </Button>
                      {(t.status === 'running' || t.status === 'queued') && (
                        <Button variant="outline" size="sm"
                          onClick={(e) => { e.stopPropagation(); taskAction(t.id, 'stop') }}>
                          <Square /> 停止
                        </Button>
                      )}
                      {t.task_type !== 'stress' && ['stopped', 'failed', 'interrupted', 'done'].includes(t.status) && (
                        <Button variant="outline" size="sm"
                          title="继续：修改参数后接着当前会话续跑（不新建会话、不清空轮次）"
                          onClick={(e) => { e.stopPropagation(); openContinue(t) }}>
                          <StepForward /> 继续
                        </Button>
                      )}
                      {/* 压测任务 done 后仍给「重启」入口（复压入口在压测面板；此处只是任务管理视角） */}
                      {(RESTARTABLE.includes(t.status)
                        || (t.task_type === 'stress' && t.status === 'done')) && (
                        <Button variant="outline" size="sm"
                          onClick={(e) => { e.stopPropagation(); taskAction(t.id, 'restart') }}>
                          <RotateCcw /> 重启
                        </Button>
                      )}
                      {t.status !== 'running' && (
                        <Button variant="outline" size="sm" className="px-2"
                          title="删除任务（轮次记录一并删除，不可恢复）"
                          onClick={(e) => { e.stopPropagation(); deleteTask(t) }}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* 行内详情 */}
                  {openId === t.id && detail && (
                    <div className="tl-detail">
                      <div className="tl-detail-head">
                        <b>任务详情</b><span className="dim">「{detail.name}」</span>
                        <span className="spacer"></span>
                        <Button variant="outline" size="sm" className="h-6 px-2 text-[calc(11px*var(--fs))]"
                          onClick={() => refetchDetail(t.id)}>
                          <RefreshCw /> 刷新
                        </Button>
                        <Button variant="outline" size="sm" className="h-6 px-2 text-[calc(11px*var(--fs))]"
                          onClick={closeDetail}>
                          <X /> 收起
                        </Button>
                      </div>

                      {/* 创建时参数 */}
                      <div className="detail-grid">
                        <div className="kv"><span className="k">状态</span><span className="v"><span className={'badge st-' + detail.status}><span className="dot"></span>{ST_LABEL[detail.status] || detail.status}</span></span></div>
                        <div className="kv"><span className="k">任务类型</span><span className="v">{TASK_TYPE_LABEL[detail.task_type] || detail.task_type}</span></div>
                        <div className="kv"><span className="k">阶段范围</span><span className="v">{detail.start_stage ? `${stageLabel(detail.start_stage)} → ${stageLabel(detail.end_stage) || detail.end_stage}` : '（按类型默认）'}</span></div>
                        {detail.task_type === 'pipeline' && (
                          <div className="kv"><span className="k">前段任务</span><span className="v">#{(() => { try { return JSON.parse(detail.payload || '{}').parent_task_id || '?' } catch (e) { return '?' } })()}</span></div>
                        )}
                        <div className="kv"><span className="k">停止条件</span><span className="v">{STOP_TYPE_LABEL[detail.stop_type] || detail.stop_type} · {stopText(detail)}</span></div>
                        <div className="kv"><span className="k">自动修复</span><span className="v">{detail.auto_fix ? '开' : '关'}</span></div>
                        <div className="kv"><span className="k">复测</span><span className="v">{detail.retest || '不复测'}</span></div>
                        <div className="kv"><span className="k">模型</span><span className="v">{detail.model || '（默认）'}</span></div>
                        <div className="kv"><span className="k">权限</span><span className="v">{detail.permission || '（CLI 默认）'}</span></div>
                        <div className="kv"><span className="k">自动提交</span><span className="v">{detail.auto_commit ? '开' : '关'}</span></div>
                        <div className="kv"><span className="k">自动部署</span><span className="v">{detail.auto_deploy ? '开' : '关'}</span></div>
                        <div className="kv"><span className="k">自动复测</span><span className="v">{detail.auto_retest ? '开' : '关'}</span></div>
                        <div className="kv"><span className="k">会话 ID</span><span className="v">{detail.session_id || '（首轮后生成）'}</span></div>
                        {detail.session_title && (
                          <div className="kv"><span className="k">会话标题</span><span className="v">{detail.session_title}</span></div>
                        )}
                        <div className="kv"><span className="k">创建时间</span><span className="v">{fmtTime(detail.created_at)}</span></div>
                        <div className="kv"><span className="k">开始时间</span><span className="v">{fmtTime(detail.started_at)}</span></div>
                        <div className="kv"><span className="k">结束时间</span><span className="v">{fmtTime(detail.ended_at)}</span></div>
                        <div className="kv"><span className="k">当前轮次</span><span className="v">{detail.current_round}</span></div>
                        <div className="kv"><span className="k">新增案例</span><span className="v" style={{ color: 'var(--pass)' }}>+{detail.new_cases ?? 0}</span></div>
                        <div className="kv"><span className="k">新增 bug</span><span className="v">{detail.new_bugs}</span></div>
                      </div>
                      {detail.error && (
                        <div className="detail-err">错误：{detail.error}</div>
                      )}
                      {detail.extra && (
                        <div className="kv" style={{ marginTop: 8 }}>
                          <span className="k">其他要求</span>
                          <span className="v" style={{ fontFamily: 'inherit', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{detail.extra}</span>
                        </div>
                      )}

                      {(RESTARTABLE.includes(detail.status)
                        || (detail.task_type === 'stress' && detail.status === 'done')) && (
                        <div className="form-row" style={{ marginTop: 8 }}>
                          <Button variant="outline" size="sm" onClick={() => taskAction(detail.id, 'restart')}>
                            <RotateCcw /> 重启任务（清空轮次，从第一轮重跑）
                          </Button>
                        </div>
                      )}

                      <Table className="mt-2.5 text-xs">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="px-2">轮次</TableHead>
                            <TableHead className="px-2">状态</TableHead>
                            <TableHead className="px-2">退出码</TableHead>
                            <TableHead className="px-2">开始</TableHead>
                            <TableHead className="px-2">结束</TableHead>
                            <TableHead className="px-2">日志</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rounds.map((r) => (
                            <TableRow key={r.round_no} className="cursor-pointer" title="新标签页查看日志"
                              onClick={() => openLog(detail.id, r.round_no)}>
                              <TableCell className="px-2">{r.round_no}</TableCell>
                              <TableCell className="px-2">{r.status}</TableCell>
                              <TableCell className="px-2 font-mono">{r.exit_code == null ? '—' : r.exit_code}</TableCell>
                              <TableCell className="px-2 font-mono text-xs">{fmtTime(r.started_at)}</TableCell>
                              <TableCell className="px-2 font-mono text-xs">{fmtTime(r.ended_at)}</TableCell>
                              <TableCell className="px-2 text-[var(--star-text)]">查看日志</TableCell>
                            </TableRow>
                          ))}
                          {!rounds.length && (
                            <TableRow><TableCell colSpan={6} className="px-2 text-muted-foreground">尚未执行轮次</TableCell></TableRow>
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
                {dlgTask ? `继续任务「${dlgTask.name}」` : '新建任务'}
              </DialogTitle>
            </DialogHeader>
            {dlgTask && (
              <div className="hint" style={{ textAlign: 'left', margin: '0 0 8px' }}>
                接着当前会话继续执行（不新建会话、历史轮次保留）；停止条件中的轮数/bug 数指「再跑/再增」的数量
              </div>
            )}
            <div className="modal-scroll overflow-y-auto">
              <div className="form-row"><label>任务名称</label>
                <Input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value.trim() })} placeholder="留空自动命名" /></div>
              {!dlgTask && (
                <div className="form-row"><label>任务类型</label>
                  <Select value={nt.task_type} onValueChange={(v) => setNt((prev) => {
                    const next = { ...prev, task_type: v }
                    // 切换类型后：残留终点不在新类型可选终点集时回落缺省 report（两种类型缺省均为 report）
                    const opts = END_OPTIONS[v]
                    if (opts && !opts.some((s) => s.v === next.end_stage)) next.end_stage = 'report'
                    return next
                  })}>
                    <SelectTrigger size="sm" className="min-w-[120px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">探索</SelectItem>
                      <SelectItem value="regression">回归</SelectItem>
                      <SelectItem value="retest_bug">复测（按提交范围）</SelectItem>
                      <SelectItem value="stress">压力测试</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* 提交日期范围：复测必填（无报告复测，LLM 判断受影响用例）/ 探索选填（优先相关用例） */}
              {!dlgTask && (nt.task_type === 'retest_bug' || nt.task_type === 'normal') && (
                <div className="form-row"><label>提交日期范围</label>
                  <Input type="date" className="h-8 w-auto" value={nt.date_from}
                    onChange={(e) => setNt({ ...nt, date_from: e.target.value })} />
                  <span className="hint">至</span>
                  <Input type="date" className="h-8 w-auto" value={nt.date_to}
                    onChange={(e) => setNt({ ...nt, date_to: e.target.value })} />
                  <span className="hint">{nt.task_type === 'retest_bug'
                    ? 'LLM 分析范围内提交影响的用例并执行复测（必填）'
                    : '本轮优先设计/执行与该范围提交相关的用例（选填）'}</span>
                </div>
              )}
              {!dlgTask && END_OPTIONS[nt.task_type] && (
                <div className="form-row"><label>任务终点</label>
                  <Select value={nt.end_stage} onValueChange={(v) => setNt({ ...nt, end_stage: v })}>
                    <SelectTrigger size="sm" className="min-w-[120px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {END_OPTIONS[nt.task_type].map((s) => (
                        <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="hint">任务执行到该阶段为止；终点在「生成报告」之后会自动追加一个后段任务</span>
                </div>
              )}
              {dlgTask && END_OPTIONS[nt.task_type] && (
                <div className="form-row"><label>任务终点</label>
                  <span className="hint">{stageLabel(nt.end_stage) || '（按类型默认）'}</span>
                </div>
              )}
              {nt.task_type === 'stress' && (
                <>
                  <div className="hint" style={{ textAlign: 'left', margin: '0 0 8px' }}>
                    压测任务固定两步：第 1 轮 agent 生成压测场景 → 平台自动发压并出报告；生命周期：测试 → 生成报告。不支持「继续」，重启=重跑。
                  </div>
                  <div className="form-col">
                    <Label className="text-xs text-muted-foreground" style={{ marginBottom: 2 }}>
                      压测说明（目标服务地址、关注接口、并发/时长期望）
                    </Label>
                    <Textarea value={nt.brief} onChange={(e) => setNt({ ...nt, brief: e.target.value })} rows={4}
                      placeholder="例如：目标 http://127.0.0.1:8080，压 /api/order 下单与 /api/order/123 查询，按 10→50→100 并发各 1 分钟"></Textarea>
                  </div>
                </>
              )}
              {!dlgTask && (nt.task_type === 'normal' || nt.task_type === 'regression') && (
                <div className="form-row">
                  <label title="测试任务行为：测试中发现的 bug 由 agent 自动修复代码">自动修复 bug</label>
                  <input type="checkbox" checked={nt.auto_fix} onChange={(e) => setNt({ ...nt, auto_fix: e.target.checked })} />
                  <label style={{ marginLeft: 14 }}>复测</label>
                  <Select value={nt.retest} onValueChange={(v) => setNt({ ...nt, retest: v })}>
                    <SelectTrigger size="sm" className="min-w-[130px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="不复测">不复测</SelectItem>
                      <SelectItem value="全部失败用例">全部失败用例</SelectItem>
                      <SelectItem value="指定范围复测">指定范围复测</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {nt.task_type !== 'stress' && (
                <div className="form-row">
                  <label>停止条件</label>
                  <Select value={nt.stop_type} onValueChange={(v) => setNt({ ...nt, stop_type: v })}>
                    <SelectTrigger size="sm" className="min-w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rounds">执行轮数</SelectItem>
                      <SelectItem value="bugs">累计新 bug 数</SelectItem>
                      <SelectItem value="deadline">截止时间</SelectItem>
                      <SelectItem value="duration">持续时长</SelectItem>
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
                          <SelectItem value="min">分钟</SelectItem>
                          <SelectItem value="hour">小时</SelectItem>
                          <SelectItem value="day">天</SelectItem>
                        </SelectContent>
                      </Select>
                    </span>
                  )}
                  <span className="hint">{STOP_HINT[nt.stop_type] || ''}</span>
                </div>
              )}
              <div className="form-col">
                <Label className="text-xs text-muted-foreground" style={{ marginBottom: 2 }}>
                  {!dlgTask && nt.task_type === 'regression'
                    ? '重跑指令（必填：描述要重跑的范围，如模块 / 用例 ID / 变更说明）'
                    : '其他要求（选填，原样传给 agent）'}
                </Label>
                <Textarea value={nt.extra} onChange={(e) => setNt({ ...nt, extra: e.target.value })} rows={3}
                  placeholder={!dlgTask && nt.task_type === 'regression'
                    ? '例如：重跑登录模块全部用例；或：本次变更涉及订单接口，重跑 ORD-003、ORD-004'
                    : '自由填写，例如：本轮优先测试订单模块；只读代码，不要提出修复方案；执行前先阅读 src/X 目录……'}></Textarea>
              </div>
            </div>
            <DialogFooter className="flex-none">
              <Button variant="outline" onClick={() => { setShowNew(false); setDlgTask(null) }}>取消</Button>
              <Button onClick={submitTaskDlg}>{dlgTask ? '继续执行' : '开始任务'}</Button>
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

