// 「压测日志」页：运行选择器（默认最新/正在跑）+ 实时图表 + 运行日志 + 压测报告
//
// 2026-10-06 复压批次：**一次发压 = 一次运行**（运行键 run_key）。顶部一个运行
// 选择器同时驱动三处：
//   图表  → LoadDashboard（run= 运行键；正在跑的那次走 SSE，历史运行全量拉取）
//   日志  → taskApi.log(taskId, 该运行的轮次号)（日志按运行独立落盘）
//   报告  → taskApi.loadReport(taskId, run)（每次运行一份，默认最新）
// 运行列表来自 /load/runs（登记运行 + 无运行行的「孤儿报告」，后者只读）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { taskApi } from '../api'
import { renderDoc } from '../utils/renderDoc'
import { toast } from '../utils/toast'
import { runLabel } from '../utils/loadRuns'
import LoadDashboard from './LoadDashboard'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const LOG_TAIL = 5000
const LOG_POLL_MS = 2000

/** 日志行着色（与任务日志页同规则，压测轮次日志观感一致） */
function logCls(line) {
  if (line.startsWith('### PROMPT')) return 'lp-prompt'
  if (line.startsWith('### CMD')) return 'lp-cmd'
  if (line.startsWith('### PID')) return 'lp-dim'
  if (/### 轮次\s*\d+\s*(开始|结束)/.test(line)) return 'lp-round'
  if (/STRESS_DONE|ROUND_DONE|LOAD 总请求/.test(line)) return 'lp-done'
  if (/Exception|Traceback|error|ERR|失败|超时|exit=-?\d+/.test(line)) return 'lp-err'
  if (line.startsWith('{')) return 'lp-json'
  return ''
}

export default function LoadLogTab({ task }) {
  const [runs, setRuns] = useState([])
  const [runKey, setRunKey] = useState('')      // 空串 = 跟随最新/正在跑
  const [tick, setTick] = useState(0)           // 手动刷新计数
  const [logText, setLogText] = useState('')
  const [report, setReport] = useState(null)
  const boxRef = useRef(null)
  const atBottom = useRef(true)
  const taskId = task?.id
  const running = task?.status === 'running'
  const endedAt = task?.ended_at

  // 运行列表：切任务 / 任务起止状态变化 / 手动刷新时重取；默认选最新一条
  useEffect(() => {
    if (!taskId) return undefined
    let dead = false
    taskApi.loadRuns(taskId).then((d) => {
      if (dead) return
      const list = d.runs || []
      setRuns(list)
      setRunKey((prev) => (list.some((r) => r.run_key === prev) ? prev
        : (list.length ? list[0].run_key : '')))
    }).catch(() => { if (!dead) setRuns([]) })
    return () => { dead = true }
  }, [taskId, running, endedAt, tick])

  const selIdx = runs.findIndex((r) => r.run_key === runKey)
  const sel = selIdx >= 0 ? runs[selIdx] : (runs[0] || null)
  const selKey = sel?.run_key || ''
  const live = sel?.status === 'running'       // 正在跑的那次运行 → SSE
  const roundNo = sel?.round_no || 0           // 有登记才有轮次行（孤儿报告没有）

  // 运行日志（按运行取：日志文件路径记在该运行自己的轮次行里）
  useEffect(() => {
    if (!taskId || !roundNo) { setLogText(''); return undefined }
    let dead = false
    const fetchLog = async () => {
      const box = boxRef.current
      atBottom.current = box
        ? box.scrollHeight - box.scrollTop - box.clientHeight < 60 : true
      try {
        const d = await taskApi.log(taskId, roundNo, LOG_TAIL)
        if (!dead) setLogText((prev) => (prev === d.log ? prev : d.log))
      } catch {
        if (!dead) setLogText('')
      }
    }
    fetchLog()
    const timer = setInterval(fetchLog, LOG_POLL_MS)
    return () => { dead = true; clearInterval(timer) }
  }, [taskId, roundNo, tick])

  useEffect(() => {
    const box = boxRef.current
    if (box && atBottom.current) box.scrollTop = box.scrollHeight
  }, [logText])

  // 报告：跟随所选运行；该运行还在跑时不拉（避免半成品）
  useEffect(() => {
    if (!taskId || live) { setReport(null); return undefined }
    let dead = false
    taskApi.loadReport(taskId, selKey)
      .then((d) => { if (!dead) setReport(d) })
      .catch(() => { if (!dead) setReport(null) })
    return () => { dead = true }
  }, [taskId, selKey, live, endedAt, tick])

  const logLines = useMemo(() => (logText ? logText.split('\n') : []), [logText])
  // 报告正文：文档级渲染（表格套横向滚动容器）；不摘抬头——报告页没有标题栏承接它
  const reportHtml = useMemo(
    () => (report?.found ? renderDoc(report.md).html : ''), [report])

  return (
    <div className="lp-log">
      <section className="lp-panel full">
        <div className="lp-panel-head">
          <h4>运行</h4>
          <span className="hint">每次发压是一次运行（报告 / 曲线 / 日志都按运行切分）</span>
          <span className="ml-auto flex items-center gap-2">
            <button type="button" className="lp-chip" title="刷新运行列表"
              onClick={() => setTick((n) => n + 1)}>↻ 刷新</button>
            {runs.length > 0 && (
              <Select value={selKey} onValueChange={setRunKey}>
                <SelectTrigger size="sm" className="h-7 min-w-[220px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runs.map((r, i) => (
                    <SelectItem key={r.run_key} value={r.run_key}>
                      {runLabel(r, i)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </span>
        </div>
        {!runs.length && (
          <div className="hint">
            {running ? '发压中…（运行列表稍后自动刷新）'
              : '暂无运行记录（发压结束后生成报告与曲线）'}
          </div>
        )}
        {sel && !sel.has_metrics && (
          <div className="hint lp-warn">该运行为存量报告（无曲线数据）；可查看下方报告。</div>
        )}
      </section>

      {(!sel || sel.has_metrics) && (
        <LoadDashboard task={task} run={selKey} live={live} />
      )}

      <section className="lp-panel full">
        <div className="lp-panel-head">
          <h4>运行日志</h4>
          {sel && (
            <span className="hint">
              {sel.registered ? `第 ${sel.round_no} 轮（发压）` : '存量运行无独立日志'}
            </span>
          )}
        </div>
        <div className="log lp-logbox" ref={boxRef}>
          {logLines.length ? logLines.map((line, i) => (
            <div key={i} className={'log-line ' + logCls(line)}>{line || '\u00a0'}</div>
          )) : <div className="hint">{roundNo ? '该运行暂无日志' : '该运行没有独立日志文件'}</div>}
        </div>
      </section>

      <section className="lp-panel full">
        <div className="lp-panel-head">
          <h4>压测报告</h4>
          {report?.found && (
            <span className="hint">
              {report.file}{report.run_key ? `（运行键 ${report.run_key}）` : ''}
            </span>
          )}
          {report?.found && (
            <button type="button" className="lp-chip ml-auto" title="复制报告文件名"
              onClick={() => {
                navigator.clipboard?.writeText(report.file || '')
                toast('已复制报告文件名')
              }}>复制文件名</button>
          )}
        </div>
        {report?.found ? (
          <div className="lp-report">
            <div className="md-body" dangerouslySetInnerHTML={{ __html: reportHtml }} />
          </div>
        ) : (
          <div className="hint">
            {live ? '发压中，结束后生成报告'
              : (sel ? '该运行暂无报告' : '暂无压测报告（发压结束或被停止后生成）')}
          </div>
        )}
      </section>
    </div>
  )
}
