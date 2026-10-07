// 压测面板：左侧 = 项目全部压测任务（task_type=stress）列表；右侧 = 两标签页
//   「压测方案」文档/载体/图表声明 · 「压测日志」运行选择 + 实时图表 + 日志 + 报告
// 列表数据源 = store.tasks（AppShell 5s 轮询）；方案标记（有方案文档/有脚本/有面板）
// 由各任务的方案包元信息轻量拉取（loadCase meta=1），按 (id, status) 缓存，不随轮询抖动。
//
// 2026-10-06 复压批次：右侧头部新增动作区（压测面板是复压的唯一入口）
//   复压  跳过 agent，用现有方案包再压一次（终态可用；入统一队列，同项目串行）
//   停止  既有 stop（stop 文件 → 宽限 → 杀进程树）
//   诊断  把最近一次运行的现场发给该任务会话，让 agent 判断/改方案
//   重启  清运行记录、从第 1 轮重跑（agent 重新出方案）——语义与「复压」不同
import { useState, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../stores/app'
import { taskApi } from '../api'
import { ST_LABEL, fmtTime } from '../utils/renderMd'
import { toast } from '../utils/toast'
import { Button } from './ui/button'
import LoadPlanTab from './LoadPlanTab'
import LoadLogTab from './LoadLogTab'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs'

// 可复压/可重启的终态（运行中或排队中一律拒绝，与后端门禁一致）
const TERMINAL = ['done', 'failed', 'stopped', 'interrupted']

export default function StressTab() {
  const store = useAppStore()
  const project = store.currentProject
  // 当前项目的压测任务（新建在前）；useMemo 防每次渲染新数组导致选中项 effect 抖动
  const list = useMemo(() => store.tasks
    .filter((t) => t.project_id === project?.id && t.task_type === 'stress')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [store.tasks, project?.id])
  const [selId, setSelId] = useState(null)
  const [tab, setTab] = useState('plan')
  const [meta, setMeta] = useState({})   // task_id -> {found, driver, plan_found, has_html}
  const metaRef = useRef({})             // 已请求过的 (id, status) 键，防重复拉
  const [runs, setRuns] = useState([])   // 选中任务的运行列表（头部计数/门禁用）
  const [act, setAct] = useState('')     // 进行中的动作（防连点）

  const sel = list.find((t) => t.id === selId) || null
  const selStatus = sel?.status
  const terminal = TERMINAL.includes(selStatus)
  const busyStatus = selStatus === 'running' || selStatus === 'queued'
  const runCount = runs.filter((r) => r.registered).length

  // 选中任务的运行列表（状态变化/轮询/动作后重取）
  useEffect(() => {
    if (!selId) { setRuns([]); return undefined }
    let dead = false
    taskApi.loadRuns(selId)
      .then((d) => { if (!dead) setRuns(d.runs || []) })
      .catch(() => { if (!dead) setRuns([]) })
    return () => { dead = true }
  }, [selId, selStatus, act])

  /** 统一的动作调用：置忙 → 请求 → toast / 失败提示（结束后刷新列表） */
  async function runAction(kind) {
    if (!sel) return
    setAct(kind)
    try {
      if (kind === 'rerun') await taskApi.loadRerun(sel.id)
      else if (kind === 'stop') await taskApi.stop(sel.id)
      else if (kind === 'diagnose') await taskApi.loadDiagnose(sel.id)
      else if (kind === 'restart') await taskApi.restart(sel.id)
      toast({
        rerun: '已入队复压（同一方案再压一次），等待执行',
        stop: '已请求停止',
        diagnose: '已把运行现场发给 agent（项目忙时排队）',
        restart: '已清空运行记录并重启（从第 1 轮重跑）',
      }[kind])
    } catch (e) {
      toast(e.message)
    } finally {
      setAct('')
    }
  }

  function doRerun() {
    if (!window.confirm(`用现有方案包再压一次「${sel.name}」？\n（跳过 agent 出方案，直接发压并生成新一份报告/曲线）`)) return
    runAction('rerun')
  }

  function doRestart() {
    if (!window.confirm(`重启「${sel.name}」将清空全部运行记录，从第 1 轮重跑（agent 重新出方案）。\n历史报告文件仍留在 load/report/ 目录。继续？`)) return
    runAction('restart')
  }


  // 默认选中最新一条；选中项被删除后回落到第一条
  useEffect(() => {
    if (!list.length) { setSelId(null); return }
    if (!list.some((t) => t.id === selId)) setSelId(list[0].id)
  }, [list, selId])

  // 列表项方案标记：状态变化时才重新拉（跑完会新产出方案包）
  useEffect(() => {
    const todo = list.filter((t) => {
      const key = `${t.id}:${t.status}`
      return !metaRef.current[key]
    })
    if (!todo.length) return
    todo.forEach((t) => { metaRef.current[`${t.id}:${t.status}`] = true })
    Promise.all(todo.map((t) => taskApi.loadCaseMeta(t.id)
      .then((d) => [t.id, d]).catch(() => [t.id, null])))
      .then((pairs) => {
        setMeta((prev) => {
          const next = { ...prev }
          pairs.forEach(([id, d]) => { if (d) next[id] = d })
          return next
        })
      })
  }, [list])

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左侧压测任务列表 */}
      <aside className="flex w-[300px] flex-none flex-col border-r border-border">
        <div className="flex-none px-3 pt-3 pb-1 font-mono text-[calc(10px*var(--fs))] uppercase tracking-[0.14em] text-muted-foreground">
          压测任务（{list.length}）
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {list.map((t) => {
            const m = meta[t.id]
            return (
              <button key={t.id} type="button"
                className={'load-item' + (selId === t.id ? ' on' : '')}
                onClick={() => setSelId(t.id)}>
                <div className="truncate text-[calc(13px*var(--fs))] font-semibold" title={t.name}>{t.name}</div>
                <div className="mt-1.5 flex items-center gap-1.5 text-[calc(11px*var(--fs))] text-muted-foreground">
                  <span className={'badge st-' + t.status}><span className="dot"></span>{ST_LABEL[t.status] || t.status}</span>
                  <span>轮 {t.current_round}</span>
                  <span className="ml-auto">{fmtTime(t.created_at)}</span>
                </div>
                {m && (
                  <div className="lp-marks">
                    {m.plan_found && <span className="lp-chip sm">方案 ✓</span>}
                    {m.driver === 'script' && <span className="lp-chip sm">脚本</span>}
                    {m.driver === 'scenario' && <span className="lp-chip sm">场景</span>}
                    {m.driver === 'legacy_scenario' && <span className="lp-chip sm">存量场景</span>}
                    {!m.found && <span className="lp-chip sm off">无方案</span>}
                    {m.has_html && <span className="lp-chip sm">自定义视图</span>}
                  </div>
                )}
                {t.error && (
                  <div className="mt-1 truncate text-[calc(11px*var(--fs))]" style={{ color: 'var(--fail)' }} title={t.error}>{t.error}</div>
                )}
              </button>
            )
          })}
          {!list.length && (
            <div className="p-2 text-xs leading-relaxed text-muted-foreground">
              暂无压测任务。在「测试任务」页新建类型为「压力测试」的任务（填写压测说明）后，会自动显示在这里。
            </div>
          )}
        </div>
      </aside>

      {/* 右侧：压测方案 / 压测日志两标签页 */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!sel ? (
          <div className="mt-16 text-center text-sm text-muted-foreground">
            ← 从左侧选择一个压测任务查看方案与指标
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none flex-wrap items-center gap-2 px-4 pt-3">
              <h3 className="m-0 font-serif text-[calc(15px*var(--fs))] font-semibold">{sel.name}</h3>
              <span className={'badge st-' + sel.status}><span className="dot"></span>{ST_LABEL[sel.status] || sel.status}</span>
              <span className="lp-chip sm">已跑 {runCount} 次</span>
              <TabsList className="ml-2 h-8">
                <TabsTrigger value="plan" className="px-3">压测方案</TabsTrigger>
                <TabsTrigger value="log" className="px-3">压测日志</TabsTrigger>
              </TabsList>
              <span className="ml-auto font-mono text-[calc(11px*var(--fs))] text-muted-foreground">
                创建 {fmtTime(sel.created_at)}{sel.started_at ? ` · 开始 ${fmtTime(sel.started_at)}` : ''}{sel.ended_at ? ` · 结束 ${fmtTime(sel.ended_at)}` : ''}
              </span>
            </div>

            {/* 动作区：压测面板是复压的唯一入口（语义区分复压 / 重启 / 诊断） */}
            <div className="flex flex-none flex-wrap items-center gap-2 px-4 pt-2">
              <Button size="sm" variant="outline" disabled={!terminal || !!act}
                title="跳过 agent，用现有方案包再压一次（生成新一份报告与曲线）"
                onClick={doRerun}>复压</Button>
              {busyStatus && (
                <Button size="sm" variant="outline" disabled={!!act}
                  title="停止当前运行（先落 stop 文件，宽限 10s 后杀进程树）"
                  onClick={() => runAction('stop')}>停止</Button>
              )}
              <Button size="sm" variant="outline" disabled={!sel.session_id || busyStatus || !!act}
                title={sel.session_id
                  ? '把最近一次运行的现场（退出码/指标摘要/日志尾）发给该任务的 agent 会话'
                  : '会话尚未生成（首轮执行后才有）'}
                onClick={() => runAction('diagnose')}>诊断</Button>
              <Button size="sm" variant="outline" disabled={!terminal || !!act}
                title="清空运行记录，从第 1 轮重跑（agent 重新出方案）——与「复压」不同"
                onClick={doRestart}>重启（换方案）</Button>
              {act && <span className="hint">处理中…</span>}
              {!terminal && busyStatus && (
                <span className="hint">运行中：结束后可复压 / 诊断 / 重启</span>
              )}
            </div>
            {sel.error && (
              <div className="px-4 pt-1 text-xs" style={{ color: 'var(--fail)' }}>错误：{sel.error}</div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <TabsContent value="plan"><LoadPlanTab task={sel} /></TabsContent>
              <TabsContent value="log"><LoadLogTab task={sel} /></TabsContent>
            </div>
          </Tabs>
        )}
      </section>
    </div>
  )
}
