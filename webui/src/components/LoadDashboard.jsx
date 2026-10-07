// 压测仪表盘：读方案包里的图表声明（charts.json）→ 订阅指标流 → 按声明渲染面板
//
// 数据流：进入面板先取 /load/case（声明 + 逃生舱标记），随后
//   - 正在跑的那次运行：SSE /load/stream 增量推规范样本，1s 节流重绘；
//   - 历史运行（已结束）：一次性分页拉全量（/load/metrics，单页 2 万条），跑完即终值。
// props.run = 运行键（空串 = 正在跑/最新一次运行）；props.live = 该运行是否正在跑。
// 面板点数的聚合/降采样都在 utils/loadMetrics 的纯函数里完成。
import { useEffect, useRef, useState } from 'react'
import { taskApi } from '../api'
import { createStore } from '../utils/loadMetrics'
import { PanelView } from './loadpanels/LoadPanels'
import LoadEscapeHatch from './LoadEscapeHatch'

const RENDER_INTERVAL = 1000   // 重绘节流（指标本身 1Hz 级，逐条重渲染没有意义）
const FETCH_LIMIT = 20000      // 全量拉取单页条数（与服务端上限一致）
const MAX_PAGES = 20           // 分页上限（防异常文件把浏览器拖死）

export default function LoadDashboard({ task, run = '', live }) {
  const [charts, setCharts] = useState(null)
  const [chartsError, setChartsError] = useState('')
  const [hasHtml, setHasHtml] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [, bump] = useState(0)
  const storeRef = useRef(createStore())
  const taskId = task?.id
  // 运行态：显式 live 优先（父组件按所选运行判定），否则按任务状态推
  const isLive = live === undefined ? (task?.status === 'running' && !run) : !!live

  // 面板声明：任务/运行切换（或重启后回到 running）时重取
  useEffect(() => {
    if (!taskId) return undefined
    let dead = false
    setLoading(true)
    setErr('')
    taskApi.loadCase(taskId).then((d) => {
      if (dead) return
      setCharts(d.charts || null)
      setChartsError(d.charts_error || '')
      setHasHtml(!!d.has_html)
      setLoading(false)
    }).catch((e) => { if (!dead) { setErr(e.message); setLoading(false) } })
    return () => { dead = true }
  }, [taskId, isLive])

  // 数据源：正在跑走 SSE 增量；历史运行分页全量（切运行/切任务都重置 store）
  useEffect(() => {
    if (!taskId || !charts) return undefined
    storeRef.current = createStore()
    bump((n) => n + 1)
    let dead = false
    const paint = () => { if (!dead) bump((n) => n + 1) }
    if (isLive) {
      const es = taskApi.loadStream(taskId, run)
      const flush = setInterval(paint, RENDER_INTERVAL)
      es.onmessage = (e) => {
        try {
          const obj = JSON.parse(e.data)
          if (obj.done) { es.close(); clearInterval(flush); paint(); return }
          storeRef.current.add(obj)
        } catch { /* 坏帧忽略 */ }
      }
      return () => { dead = true; es.close(); clearInterval(flush) }
    }
    ;(async () => {
      let after = 0
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const d = await taskApi.loadMetrics(taskId, after, FETCH_LIMIT, run)
        if (dead) return
        const samples = d.samples || []
        samples.forEach((s) => storeRef.current.add(s))
        if (!samples.length || d.next <= after) break
        after = d.next
      }
      paint()
    })().catch((e) => { if (!dead) setErr(e.message) })
    return () => { dead = true }
  }, [taskId, isLive, charts, run])

  const panels = charts?.panels || []
  return (
    <div className="lp-dash">
      {chartsError && (
        <div className="hint lp-warn">图表声明不合法，已回退默认面板：{chartsError}</div>
      )}
      {err && <div className="hint lp-warn">指标加载失败：{err}</div>}
      {loading && !panels.length ? (
        <div className="hint">正在读取方案包…</div>
      ) : (
        <div className="lp-grid">
          {panels.map((p) => (
            <section key={p.id} className={'lp-panel ' + (p.width === 'full' ? 'full' : 'half')}>
              <div className="lp-panel-head">
                <h4>{p.title}</h4>
                {p.hint && <span className="hint">{p.hint}</span>}
              </div>
              <PanelView panel={p} store={storeRef.current} />
            </section>
          ))}
        </div>
      )}
      {hasHtml && <LoadEscapeHatch task={task} store={storeRef.current} />}
    </div>
  )
}
