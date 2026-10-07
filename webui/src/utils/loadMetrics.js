// 压测指标 → 面板数据（纯函数，vitest 覆盖；面板组件只做绘制）
//
// 样本形状（规范指标通道，见 doc_ai/spec/loadgen/压测任务与报告.md）：
//   { ts: 秒, metric: '名称', value: 数值, type: 'gauge'|'counter', labels: {维度: 值} }
// 两种类型语义：
//   gauge   瞬时值（吞吐/延迟分位/并发）
//   counter 单调递增累计值（委托数/总请求…）——展示时换算成窗口增量或速率
//
// 设计约定（与图表声明模板一致，改动需同步 builtin_prompts/.../load_charts_template.md）：
//   line/bar(by=time)  counter 画「速率」或「每桶增量」；gauge 画原值
//   stacked_bar        counter 画每桶增量（堆叠）；gauge 画每桶均值
//   donut              一律用各分组的最新累计值（占比语义）
//   stat               按 agg（last/avg/max/min/sum）取值，counter 的 last=最新累计值

// 单序列点数上限（前端环形截断）：指标通道 1Hz×多序列，超限按最旧丢弃
export const MAX_POINTS_PER_SERIES = 1200

/** 序列稳定键：metric + 排序后的 labels（labels 顺序不影响归属） */
export function seriesKey(metric, labels) {
  const keys = Object.keys(labels || {}).sort()
  return metric + '|' + keys.map((k) => `${k}=${labels[k]}`).join(',')
}

/**
 * 指标缓冲：按序列键累积样本，超上限丢最旧。
 * @param {number} maxPoints 单序列点数上限
 */
export function createStore(maxPoints = MAX_POINTS_PER_SERIES) {
  const byKey = new Map()
  return {
    /** 追加一条样本（非样本行/坏值忽略）；返回是否写入 */
    add(sample) {
      if (!sample || typeof sample.metric !== 'string') return false
      const value = Number(sample.value)
      if (!Number.isFinite(value)) return false
      const ts = Number(sample.ts)
      const key = seriesKey(sample.metric, sample.labels)
      let s = byKey.get(key)
      if (!s) {
        s = { key, metric: sample.metric, labels: sample.labels || {},
              type: sample.type === 'counter' ? 'counter' : 'gauge', points: [] }
        byKey.set(key, s)
      }
      s.points.push([Number.isFinite(ts) ? ts : Date.now() / 1000, value])
      if (s.points.length > maxPoints) s.points.shift()
      return true
    },
    /** 全部序列（浅拷贝数组，元素为内部对象，仅供只读消费） */
    list() { return [...byKey.values()] },
    size() { return byKey.size },
    clear() { byKey.clear() },
  }
}

/** labels 子集匹配：match 的每个键值都必须相等（match 为空视为匹配） */
export function matchLabels(labels, match) {
  if (!match) return true
  const lb = labels || {}
  return Object.entries(match).every(([k, v]) => String(lb[k]) === String(v))
}

/**
 * 选出目标序列。
 * - 给了 match：labels 含 match 全部键值的第一条；
 * - 没给 match：优先返回无 labels 的「全局序列」，其次按 key 排序的第一条。
 */
export function matchSeries(store, metric, match) {
  const all = store.list().filter((s) => s.metric === metric)
  if (!all.length) return null
  if (match) return all.find((s) => matchLabels(s.labels, match)) || null
  const bare = all.find((s) => !Object.keys(s.labels).length)
  if (bare) return bare
  return all.sort((a, b) => a.key.localeCompare(b.key))[0]
}

/** 同一 metric 下所有序列（table/stacked/donut 用） */
export function metricSeries(store, metric) {
  return store.list().filter((s) => s.metric === metric && Object.keys(s.labels).length)
}

/**
 * 序列 → 绘图点 [[t, v]]。
 * gauge 取原值；counter 取相邻增量（可选再除以 Δt 换算成每秒速率）。
 * @param {object} series 序列对象
 * @param {{scale?: number, rate?: boolean}} opts scale=数值放大（如错误率×100）
 */
export function seriesPoints(series, opts = {}) {
  const scale = Number(opts.scale) || 1
  const pts = series.points
  if (series.type !== 'counter') return pts.map(([t, v]) => [t, v * scale])
  const out = []
  for (let i = 1; i < pts.length; i += 1) {
    const dt = pts[i][0] - pts[i - 1][0]
    if (dt <= 0) continue
    const delta = pts[i][1] - pts[i - 1][1]
    out.push([pts[i][0], (opts.rate ? delta / dt : delta) * scale])
  }
  return out
}

/**
 * 时间分桶：把点集压到 bucketSec 宽的桶里（面板点数预算）。
 * @param {Array<[number, number]>} points
 * @param {number} bucketSec 桶宽（秒）
 * @param {'last'|'avg'|'sum'} mode 桶内聚合方式
 */
export function bucketize(points, bucketSec, mode = 'last') {
  if (!points.length || bucketSec <= 0) return points.slice()
  const buckets = new Map()
  points.forEach(([t, v]) => {
    const b = Math.floor(t / bucketSec) * bucketSec
    const cur = buckets.get(b)
    if (!cur) buckets.set(b, { t: b, sum: v, n: 1, last: v })
    else { cur.sum += v; cur.n += 1; cur.last = v }
  })
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => {
    if (mode === 'avg') return [t, b.sum / b.n]
    if (mode === 'sum') return [t, b.sum]
    return [t, b.last]
  })
}

/** 抽稀：点数超过 max 时按等间隔取样（保留首末点） */
export function downsample(points, max = 600) {
  if (points.length <= max) return points
  const step = points.length / max
  const out = []
  for (let i = 0; i < max; i += 1) out.push(points[Math.floor(i * step)])
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** 各分组的最新累计值（donut / 概览用）：[{label, value, labels}] */
export function groupLatest(store, metric, groupBy) {
  const out = []
  store.list().filter((s) => s.metric === metric).forEach((s) => {
    if (!s.points.length) return
    const label = groupBy ? s.labels?.[groupBy] : (Object.values(s.labels || {})[0] ?? '全部')
    out.push({ label: String(label ?? '全部'), value: s.points[s.points.length - 1][1],
               labels: s.labels || {} })
  })
  return out.sort((a, b) => b.value - a.value)
}

/**
 * 单值卡取值。
 * @param {object} series 序列
 * @param {'last'|'avg'|'max'|'min'|'sum'} agg
 */
export function statValue(series, agg = 'last', scale = 1) {
  if (!series || !series.points.length) return null
  const vals = series.points.map(([, v]) => v)
  let v
  if (agg === 'avg') v = vals.reduce((a, b) => a + b, 0) / vals.length
  else if (agg === 'max') v = Math.max(...vals)
  else if (agg === 'min') v = Math.min(...vals)
  else if (agg === 'sum') v = vals.reduce((a, b) => a + b, 0)
  else v = vals[vals.length - 1]
  return v * (Number(scale) || 1)
}

/** 数值展示：按量级取精度 + 千分位（大数不显示无意义小数） */
export function formatValue(v, precision) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (precision !== undefined && precision !== null && precision !== '') {
    return Number(v).toFixed(Number(precision))
  }
  const abs = Math.abs(v)
  if (abs >= 1000) return Math.round(v).toLocaleString('en-US')
  if (abs >= 10) return v.toFixed(1)
  if (abs >= 1) return v.toFixed(2)
  if (abs === 0) return '0'
  return v.toFixed(3)
}

/** 折线/柱状的时间跨度（秒），空集合返回 0 */
export function timeSpan(pointsList) {
  let lo = Infinity
  let hi = -Infinity
  pointsList.forEach((pts) => pts.forEach(([t]) => {
    if (t < lo) lo = t
    if (t > hi) hi = t
  }))
  return hi > lo ? hi - lo : 0
}

/** 自动桶宽：把区间压到 target 个桶以内（最小 1 秒） */
export function autoBucketSec(spanSec, target = 600) {
  if (!spanSec || spanSec <= 0) return 1
  return Math.max(1, Math.ceil(spanSec / target))
}
