// 压测面板的 6 种图表渲染器（手写 SVG，零图表库依赖；配色走 CSS 变量）
//
// 数据来自 utils/loadMetrics 的纯函数层，本文件只负责「画」。声明式面板类型
// （line/bar/stacked_bar/donut/stat/table）与校验口径见后端 loadcase.validate_charts
// 与 builtin_prompts/free_style/templates/load_charts_template.md。
import {
  autoBucketSec, bucketize, downsample, formatValue, groupLatest, matchSeries,
  metricSeries, seriesPoints, statValue, timeSpan,
} from '../../utils/loadMetrics'

// 序列配色：平台语义色优先，超出部分用一组补充色循环
// 全走 CSS 变量（--seq-4/5/6 原先写死为浅色系，白底上会糊；见 styles/theme.css 皮肤块）
const COLORS = ['var(--run)', 'var(--retest)', 'var(--fail)', 'var(--pass)',
  'var(--fix)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)']

const W = 640
const H = 150
const PAD = { l: 48, r: 10, t: 10, b: 18 }
// 折线点数预算（超出按时间分桶聚合，保证长任务也能整段展示）
const MAX_LINE_POINTS = 600
// 堆叠柱的桶数上限（多了柱子看不清）
const MAX_STACK_BUCKETS = 40

/** 空态占位（无数据/指标未上报） */
function Empty({ text = '暂无数据（本轮尚未产生该指标）' }) {
  return <div className="lp-empty hint">{text}</div>
}

/** 折线/柱状共用的坐标换算 */
function makeScale(t0, t1, vmin, vmax) {
  const span = t1 - t0
  const vspan = vmax - vmin
  return {
    x: (t) => PAD.l + (span > 0 ? (t - t0) / span : 0.5) * (W - PAD.l - PAD.r),
    y: (v) => H - PAD.b - (vspan > 0 ? (v - vmin) / vspan : 0.5) * (H - PAD.t - PAD.b),
  }
}

/** 网格 + y 轴刻度（3 档）+ 当前值图例 */
function Axes({ scale, vmin, vmax }) {
  const ticks = [vmin, (vmin + vmax) / 2, vmax]
  return (
    <g>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={scale.y(v)} y2={scale.y(v)}
            stroke="var(--border)" strokeWidth="0.5" strokeDasharray="3 3" />
          <text x={PAD.l - 4} y={scale.y(v) + 3} textAnchor="end"
            style={{ fontSize: 9, fill: 'var(--dim)' }}>{formatValue(v)}</text>
        </g>
      ))}
    </g>
  )
}

/** 折线：多序列，counter 按速率画（每秒增量） */
export function LinePanel({ panel, store }) {
  const items = (panel.series || []).map((spec, i) => {
    const s = matchSeries(store, spec.metric, spec.match)
    const raw = s ? seriesPoints(s, { scale: spec.scale, rate: s.type === 'counter' }) : []
    const bucket = autoBucketSec(timeSpan([raw]), MAX_LINE_POINTS)
    return {
      label: spec.label || spec.metric,
      color: COLORS[i % COLORS.length],
      points: downsample(bucketize(raw, bucket, s && s.type === 'gauge' ? 'last' : 'sum'),
        MAX_LINE_POINTS),
      suffix: s && s.type === 'counter' ? '/s' : '',
    }
  })
  const all = items.flatMap((it) => it.points)
  if (!all.length) return <Empty />
  const ts = all.map((p) => p[0])
  const vs = all.map((p) => p[1])
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)]
  const vmax = Math.max(...vs, 0)
  const vmin = Math.min(...vs, 0)
  const scale = makeScale(t0, t1, vmin, vmax)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="lp-svg">
        <Axes scale={scale} vmin={vmin} vmax={vmax} />
        {items.map((it) => (
          <polyline key={it.label} fill="none" strokeWidth="1.6" stroke={it.color}
            points={it.points.map(([t, v]) => `${scale.x(t)},${scale.y(v)}`).join(' ')} />
        ))}
      </svg>
      <div className="lp-legend">
        {items.map((it) => (
          <span key={it.label}>
            <i style={{ background: it.color }} />{it.label}{it.suffix}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 柱状：by=time 按时间分桶；by=label 按维度末值 */
export function BarPanel({ panel, store }) {
  if (panel.by === 'label' || (!panel.by && panel.groupBy)) {
    const rows = groupLatest(store, panel.metric, panel.groupBy)
    if (!rows.length) return <Empty />
    const vmax = Math.max(...rows.map((r) => r.value), 1)
    return (
      <div className="lp-bars">
        {rows.map((r, i) => (
          <div key={r.label} className="lp-bar-row">
            <span className="lb" title={r.label}>{r.label}</span>
            <span className="lt"><i style={{ width: `${(r.value / vmax) * 100}%`,
              background: COLORS[i % COLORS.length] }} /></span>
            <span className="lv">{formatValue(r.value, panel.precision)}</span>
          </div>
        ))}
      </div>
    )
  }
  const s = matchSeries(store, panel.metric)
  if (!s) return <Empty />
  const rate = s.type === 'counter'
  const raw = seriesPoints(s, { scale: panel.scale, rate })
  const bucket = autoBucketSec(timeSpan([raw]), MAX_LINE_POINTS / 4)
  const points = bucketize(raw, bucket, rate ? 'sum' : 'avg')
  if (!points.length) return <Empty />
  const ts = points.map((p) => p[0])
  const vs = points.map((p) => p[1])
  const scale = makeScale(Math.min(...ts), Math.max(...ts), 0, Math.max(...vs, 1))
  const bw = Math.max(1, (W - PAD.l - PAD.r) / points.length * 0.7)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lp-svg">
      <Axes scale={scale} vmin={0} vmax={Math.max(...vs, 1)} />
      {points.map(([t, v]) => (
        <rect key={t} x={scale.x(t) - bw / 2} y={scale.y(v)} width={bw}
          height={H - PAD.b - scale.y(v)} fill={COLORS[0]} opacity="0.85" />
      ))}
    </svg>
  )
}

/** 堆叠柱：按维度分组、按时间分桶堆叠（counter 用桶内增量，gauge 用桶内均值） */
export function StackedBarPanel({ panel, store }) {
  const groups = metricSeries(store, panel.metric)
    .map((s) => ({
      label: String(s.labels?.[panel.groupBy] ?? Object.values(s.labels)[0] ?? '?'),
      type: s.type,
      points: seriesPoints(s, { rate: false }),
    }))
  const withData = groups.filter((g) => g.points.length)
  if (!withData.length) return <Empty />
  const span = timeSpan(withData.map((g) => g.points))
  const bucket = Math.max(autoBucketSec(span, MAX_STACK_BUCKETS), 1)
  // 各组的桶序列（counter 取增量、gauge 取均值）——按桶时间对齐后纵向堆叠
  const buckets = new Map()
  withData.forEach((g) => {
    bucketize(g.points, bucket, g.type === 'counter' ? 'sum' : 'avg').forEach(([t, v]) => {
      if (!buckets.has(t)) buckets.set(t, {})
      buckets.get(t)[g.label] = v
    })
  })
  const times = [...buckets.keys()].sort((a, b) => a - b)
  const totals = times.map((t) => Object.values(buckets.get(t)).reduce((a, b) => a + b, 0))
  const vmax = Math.max(...totals, 1)
  const labels = withData.map((g) => g.label)
  const bw = Math.max(1, (W - PAD.l - PAD.r) / times.length * 0.7)
  const x = (t) => PAD.l + ((t - times[0]) / (Math.max(times[times.length - 1] - times[0], 1)))
    * (W - PAD.l - PAD.r)
  const y = (v) => H - PAD.b - (v / vmax) * (H - PAD.t - PAD.b)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="lp-svg">
        <Axes scale={{ x, y }} vmin={0} vmax={vmax} />
        {times.map((t) => {
          let acc = 0
          return (
            <g key={t}>
              {labels.map((lb, i) => {
                const v = buckets.get(t)[lb] || 0
                const y0 = y(acc)
                acc += v
                const y1 = y(acc)
                return v > 0 ? (
                  <rect key={lb} x={x(t) - bw / 2} y={y1} width={bw} height={y0 - y1}
                    fill={COLORS[i % COLORS.length]} opacity="0.9" />
                ) : null
              })}
            </g>
          )
        })}
      </svg>
      <div className="lp-legend">
        {labels.map((lb, i) => (
          <span key={lb}><i style={{ background: COLORS[i % COLORS.length] }} />{lb}</span>
        ))}
      </div>
    </div>
  )
}

/** 环图：各分组的最新累计值占比 */
export function DonutPanel({ panel, store }) {
  const rows = groupLatest(store, panel.metric, panel.groupBy)
  const total = rows.reduce((a, r) => a + Math.max(r.value, 0), 0)
  if (!rows.length || total <= 0) return <Empty />
  const R = 52
  const C = 2 * Math.PI * R
  let acc = 0
  return (
    <div className="lp-donut">
      <svg viewBox="0 0 140 140" className="lp-donut-svg">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--border)" strokeWidth="18" />
        {rows.map((r, i) => {
          const frac = Math.max(r.value, 0) / total
          const dash = `${frac * C} ${C}`
          const offset = -acc * C
          acc += frac
          return (
            <circle key={r.label} cx="70" cy="70" r={R} fill="none"
              stroke={COLORS[i % COLORS.length]} strokeWidth="18"
              strokeDasharray={dash} strokeDashoffset={offset}
              transform="rotate(-90 70 70)" />
          )
        })}
        <text x="70" y="74" textAnchor="middle" style={{ fontSize: 15, fill: 'var(--foreground)' }}>
          {formatValue(total)}
        </text>
      </svg>
      <div className="lp-legend col">
        {rows.map((r, i) => (
          <span key={r.label}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            {r.label} <b>{formatValue(r.value)}</b>
            <em>{((r.value / total) * 100).toFixed(1)}%</em>
          </span>
        ))}
      </div>
    </div>
  )
}

/** 单值卡：一行数字卡片（agg=last 的 counter 即最新累计值） */
export function StatPanel({ panel, store }) {
  const cards = (panel.stats || []).map((it) => {
    const s = matchSeries(store, it.metric, it.match)
    return { ...it, value: statValue(s, it.agg, it.scale) }
  })
  return (
    <div className="lp-stats">
      {cards.map((c) => (
        <div key={c.metric + (c.label || '')} className="lp-stat">
          <div className="k">{c.label || c.metric}</div>
          <div className="v">
            {formatValue(c.value, c.precision)}
            {c.unit ? <span className="u">{c.unit}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 表格：按维度列各分组的最新值（counter 追加一列每秒速率） */
export function TablePanel({ panel, store }) {
  const all = store.list().filter((s) => s.metric === panel.metric)
  if (!all.length) return <Empty />
  const key = panel.groupBy || null
  const rows = all.map((s) => {
    const last = s.points.length ? s.points[s.points.length - 1][1] : null
    const pts = seriesPoints(s, { rate: s.type === 'counter' })
    const rate = pts.length ? pts[pts.length - 1][1] : null
    const dim = key ? s.labels?.[key] : (Object.values(s.labels || {}).join(' / ') || '全部')
    return { dim: String(dim ?? '全部'), labels: s.labels || {}, last, rate,
             type: s.type }
  })
  const hasCounter = rows.some((r) => r.type === 'counter')
  return (
    <div className="lp-table-wrap">
      <table className="lp-table">
        <thead>
          <tr>
            <th>{key || '维度'}</th>
            <th style={{ textAlign: 'right' }}>最新值</th>
            {hasCounter && <th style={{ textAlign: 'right' }}>速率 /s</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.dim + JSON.stringify(r.labels)}>
              <td title={JSON.stringify(r.labels)}>{r.dim}</td>
              <td style={{ textAlign: 'right' }}>{formatValue(r.last)}</td>
              {hasCounter && <td style={{ textAlign: 'right' }}>{formatValue(r.rate)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 面板分发：type → 组件（未知类型给一行提示，不炸整页） */
export function PanelView({ panel, store }) {
  const props = { panel, store }
  if (panel.type === 'line') return <LinePanel {...props} />
  if (panel.type === 'bar') return <BarPanel {...props} />
  if (panel.type === 'stacked_bar') return <StackedBarPanel {...props} />
  if (panel.type === 'donut') return <DonutPanel {...props} />
  if (panel.type === 'stat') return <StatPanel {...props} />
  if (panel.type === 'table') return <TablePanel {...props} />
  return <Empty text={`未支持的面板类型：${panel.type}`} />
}
