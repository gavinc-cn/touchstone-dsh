import { useState, useEffect, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { taskApi } from '../api'
import { ST_LABEL } from '../utils/renderMd'
import TouchstoneLogo from '../components/TouchstoneLogo'
import LoadDashboard from '../components/LoadDashboard'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ArrowDownToLine } from 'lucide-react'

/** 日志行着色分类（沿用原任务详情内联面板的规则） */
function logCls(line) {
  if (line.startsWith('### PROMPT')) return 'lp-prompt'
  if (line.startsWith('### CMD')) return 'lp-cmd'
  if (line.startsWith('### PID')) return 'lp-dim'
  if (line.startsWith('### COMPACT')) return 'lp-compact'
  if (/### 轮次\s*\d+\s*(开始|结束)/.test(line)) return 'lp-round'
  if (/ROUND_DONE|FIX_DONE|RETEST_SUMMARY|STRESS_DONE/.test(line)) return 'lp-done'
  if (/Exception|Traceback|error|ERR|失败|超时|exit=-?\d+/.test(line)) return 'lp-err'
  if (line.startsWith('{')) return 'lp-json'
  return ''
}

// 单轮日志拉取行数上限（与服务端 tail 上限一致）
const LOG_TAIL = 5000

// 独立日志页: 由任务详情「查看日志」以新标签页打开, URL 形如 /log?task=<id>&round=<n>
export default function TaskLogPage() {
  const [params, setParams] = useSearchParams()
  const taskId = +(params.get('task') || 0)
  const round = +(params.get('round') || 0)

  const [task, setTask] = useState(null)
  const [rounds, setRounds] = useState([])
  const [logText, setLogText] = useState('')
  const [noLog, setNoLog] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const logBox = useRef(null)
  const atBottomRef = useRef(true)
  const logLines = useMemo(() => (logText ? logText.split('\n') : []), [logText])

  // 任务与轮次列表: 进入页面及切换轮次时加载（顺带刷新任务状态徽标）
  useEffect(() => {
    if (!taskId) { setLoadErr('缺少 task 参数'); return }
    let stopped = false
    ;(async () => {
      try {
        const [t, rs] = await Promise.all([taskApi.get(taskId), taskApi.rounds(taskId)])
        if (stopped) return
        setTask(t)
        setRounds(rs)
        // 轮次参数缺失或越界时回落到最后一轮
        if (rs.length && !rs.some((r) => r.round_no === round)) {
          setParams({ task: String(taskId), round: String(rs[rs.length - 1].round_no) }, { replace: true })
        }
      } catch (e) { if (!stopped) setLoadErr(e.message) }
    })()
    return () => { stopped = true }
  }, [taskId, round]) // eslint-disable-line react-hooks/exhaustive-deps

  // 浏览器标签页标题（离开页面时还原）
  useEffect(() => {
    document.title = task ? `日志 · ${task.name}` : '任务日志'
    return () => { document.title = 'Touchstone' }
  }, [task])

  // 日志轮询: 2s 刷新, 若本来在底部则跟随滚动（逻辑与原任务详情内联面板一致）
  useEffect(() => {
    if (!taskId || !round) return undefined
    let timer = null
    let stopped = false
    const fetchLog = async () => {
      const box = logBox.current
      atBottomRef.current = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 60 : true
      try {
        const d = await taskApi.log(taskId, round, LOG_TAIL)
        if (stopped) return
        setNoLog(false)
        setLogText((prev) => (prev === d.log ? prev : d.log))
      } catch {
        // 轮次尚无日志文件(未结束/未写盘)时按空态展示, 不视为错误
        if (!stopped) { setNoLog(true); setLogText('') }
      }
    }
    fetchLog()
    timer = setInterval(fetchLog, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [taskId, round])

  // 日志文本更新后执行滚动跟随
  useEffect(() => {
    const box = logBox.current
    if (box && atBottomRef.current) box.scrollTop = box.scrollHeight
  }, [logText])

  /** 手动回到底部并恢复自动跟随 */
  function scrollToBottom() {
    atBottomRef.current = true
    const box = logBox.current
    if (box) box.scrollTop = box.scrollHeight
  }

  return (
    <div className="log-page">
      <div className="log-page-head">
        <TouchstoneLogo size={20} />
        <span className="t">任务日志</span>
        {task && <span className="dim">「{task.name}」</span>}
        {task && <span className={'badge st-' + task.status}><span className="dot"></span>{ST_LABEL[task.status] || task.status}</span>}
        <span className="spacer"></span>
        {rounds.length > 0 && (
          <Select value={String(round)} onValueChange={(v) => setParams({ task: String(taskId), round: v })}>
            <SelectTrigger size="sm" className="h-7 min-w-[90px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rounds.map((r) => (
                <SelectItem key={r.round_no} value={String(r.round_no)}>第 {r.round_no} 轮</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="hint">{logLines.length} 行 · 2s 自动刷新 · 在底部时自动跟随</span>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
          title="回到底部并恢复自动跟随" onClick={scrollToBottom}>
          <ArrowDownToLine /> 底部
        </Button>
      </div>
      {task?.task_type === 'stress' && <LoadDashboard task={task} />}
      <div className="log-page-body">
        {loadErr ? (
          <div className="hint" style={{ margin: 'auto' }}>加载失败：{loadErr}</div>
        ) : noLog ? (
          <div className="hint" style={{ margin: 'auto' }}>该轮暂无日志</div>
        ) : (
          <div className="log" ref={logBox}>
            {logLines.map((line, i) => (
              <div key={i} className={'log-line ' + logCls(line)}>{line || '\u00a0'}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

