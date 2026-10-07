// 逃生舱：case 自带 panel.html 的自定义视图（沙箱 iframe + postMessage 数据桥）
//
// 安全边界（与 server._api_load_custom_html 一致）：iframe 走 sandbox="allow-scripts"，
// 服务端另加 CSP `sandbox allow-scripts` —— 文档运行在不透明源里，拿不到站点 cookie
// 也读不到 /api 响应（无 CORS 头）。实时数据只能由父页 postMessage 推入：
// 载荷 { type:'ts.metrics', task, series:[{metric,labels,type,points:[[t,v],…]}] }。
// case 侧接收示例见 builtin_prompts/free_style/load_charts_template.md。
import { useEffect, useRef } from 'react'
import { taskApi } from '../api'

const PUSH_INTERVAL = 2000   // 数据推送节奏（逃生舱视图不追求秒级）
const MAX_SERIES = 40        // 单次推送的序列数上限
const MAX_POINTS = 300       // 单序列点数上限（够画趋势，也不至于撑爆 postMessage）

export default function LoadEscapeHatch({ task, store }) {
  const ref = useRef(null)
  const taskId = task?.id

  /** 把当前指标窗口推给 iframe（不透明源里只能靠这条通道拿数据） */
  function push() {
    const win = ref.current && ref.current.contentWindow
    if (!win) return
    const series = store.list().slice(0, MAX_SERIES).map((s) => ({
      metric: s.metric, labels: s.labels, type: s.type,
      points: s.points.slice(-MAX_POINTS),
    }))
    win.postMessage({ type: 'ts.metrics', task: taskId, series }, '*')
  }

  useEffect(() => {
    if (!taskId) return undefined
    const timer = setInterval(push, PUSH_INTERVAL)
    return () => clearInterval(timer)
  }, [taskId, store])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!taskId) return null
  return (
    <section className="lp-panel full lp-hatch">
      <div className="lp-panel-head">
        <h4>自定义视图（panel.html）</h4>
        <span className="hint">
          沙箱 iframe：读不到站点数据，只能消费 postMessage 推入的指标
        </span>
      </div>
      <iframe ref={ref} sandbox="allow-scripts" title="自定义压测视图"
        className="lp-hatch-frame" src={taskApi.loadCustomHtmlUrl(taskId)}
        onLoad={push} />
    </section>
  )
}
