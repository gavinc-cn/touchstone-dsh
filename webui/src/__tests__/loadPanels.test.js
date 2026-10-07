// 压测指标纯函数层单测（utils/loadMetrics.js）：序列键/匹配、counter 增量与速率、
// 时间分桶、抽稀、分组末值、单值卡聚合、格式化。
// 这些函数决定面板上「看到什么数」，是压测面板重构里唯一值得逐条钉住的逻辑。
import { describe, expect, it } from 'vitest'
import {
  autoBucketSec, bucketize, createStore, downsample, formatValue, groupLatest,
  matchLabels, matchSeries, metricSeries, seriesKey, seriesPoints, statValue,
  timeSpan,
} from '../utils/loadMetrics'

const GAUGE = (ts, metric, value, labels) => ({ ts, metric, value, type: 'gauge', labels })
const CTR = (ts, metric, value, labels) => ({ ts, metric, value, type: 'counter', labels })

describe('序列键与匹配', () => {
  it('labels 顺序不影响归属，空 labels 与分组序列分开', () => {
    expect(seriesKey('rps', { b: 2, a: 1 })).toBe(seriesKey('rps', { a: 1, b: 2 }))
    expect(seriesKey('rps', {})).toBe('rps|')
    expect(seriesKey('rps', { group: '下单' })).toBe('rps|group=下单')
  })

  it('matchLabels 按子集匹配（缺键/多键都不算匹配）', () => {
    expect(matchLabels({ group: '下单', x: 1 }, { group: '下单' })).toBe(true)
    expect(matchLabels({ x: 1 }, { group: '下单' })).toBe(false)
    expect(matchLabels({}, null)).toBe(true)
  })

  it('matchSeries：给了 match 取对应序列；没给优先取无标签的全局序列', () => {
    const s = createStore()
    s.add(GAUGE(1, 'rps', 10))
    s.add(GAUGE(1, 'rps', 5, { group: '查询' }))
    s.add(GAUGE(1, 'rps', 7, { group: '下单' }))
    expect(matchSeries(s, 'rps', { group: '下单' }).labels.group).toBe('下单')
    expect(matchSeries(s, 'rps').labels).toEqual({})
    expect(matchSeries(s, 'nope')).toBe(null)
    // 无全局序列时按 key 排序取第一条，保证同一份数据每次渲染一致
    const only = createStore()
    only.add(GAUGE(1, 'rps', 5, { group: '查询' }))
    only.add(GAUGE(1, 'rps', 7, { group: '下单' }))
    expect(matchSeries(only, 'rps').labels.group).toBe('下单')
  })

  it('metricSeries 只返回带维度的序列（堆叠/环图/表格用）', () => {
    const s = createStore()
    s.add(CTR(1, 'order.status', 1, { status: '已成交' }))
    s.add(CTR(1, 'order.status', 2))
    expect(metricSeries(s, 'order.status').length).toBe(1)
  })
})

describe('store：写入与上限', () => {
  it('忽略坏样本；超上限丢最旧', () => {
    const s = createStore(3)
    expect(s.add(null)).toBe(false)
    expect(s.add({ metric: 'x', value: 'NaN' })).toBe(false)
    for (let i = 1; i <= 5; i += 1) s.add(GAUGE(i, 'rps', i))
    const series = s.list()[0]
    expect(series.points).toEqual([[3, 3], [4, 4], [5, 5]])
    expect(s.size()).toBe(1)
  })
})

describe('counter 换算（增量 / 速率）', () => {
  it('gauge 原值直出；counter 出相邻增量', () => {
    const g = { type: 'gauge', points: [[1, 10], [2, 20]] }
    const c = { type: 'counter', points: [[1, 100], [3, 140]] }
    expect(seriesPoints(g)).toEqual([[1, 10], [2, 20]])
    expect(seriesPoints(c)).toEqual([[3, 40]])
  })

  it('rate=true 除以 Δt；scale 放大（错误率×100 展示）', () => {
    const c = { type: 'counter', points: [[1, 100], [3, 140]] }
    expect(seriesPoints(c, { rate: true })).toEqual([[3, 20]])
    const g = { type: 'gauge', points: [[1, 0.0123]] }
    expect(seriesPoints(g, { scale: 100 })[0][1]).toBeCloseTo(1.23, 6)
  })

  it('Δt<=0 或回退的计数点被跳过（重启/乱序不产生负速率）', () => {
    const c = { type: 'counter', points: [[5, 10], [5, 20], [4, 30]] }
    expect(seriesPoints(c)).toEqual([])
  })
})

describe('时间分桶与抽稀', () => {
  const pts = [[0, 1], [1, 3], [2, 5], [3, 7], [4, 9]]

  it('last/avg/sum 三种桶内聚合', () => {
    expect(bucketize(pts, 2, 'last')).toEqual([[0, 3], [2, 7], [4, 9]])
    expect(bucketize(pts, 2, 'sum')).toEqual([[0, 4], [2, 12], [4, 9]])
    expect(bucketize(pts, 2, 'avg')).toEqual([[0, 2], [2, 6], [4, 9]])
  })

  it('桶宽为 0 时分桶原样返回；autoBucketSec 把跨度压到目标桶数', () => {
    expect(bucketize(pts, 0)).toEqual(pts)
    expect(autoBucketSec(0)).toBe(1)
    expect(autoBucketSec(6000, 600)).toBe(10)
  })

  it('抽稀保留首末点且不超过上限', () => {
    const many = Array.from({ length: 1000 }, (_, i) => [i, i])
    const out = downsample(many, 100)
    expect(out.length).toBeLessThanOrEqual(101)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]).toEqual([999, 999])
    expect(downsample(pts, 100)).toEqual(pts)
  })

  it('timeSpan 为空返回 0', () => {
    expect(timeSpan([pts])).toBe(4)
    expect(timeSpan([[], []])).toBe(0)
  })
})

describe('分组末值与单值卡', () => {
  it('groupLatest 取各分组最新累计值并降序', () => {
    const s = createStore()
    s.add(CTR(1, 'order.status', 3, { status: '已成交' }))
    s.add(CTR(2, 'order.status', 9, { status: '已成交' }))
    s.add(CTR(2, 'order.status', 1, { status: '已撤销' }))
    expect(groupLatest(s, 'order.status', 'status')).toEqual([
      { label: '已成交', value: 9, labels: { status: '已成交' } },
      { label: '已撤销', value: 1, labels: { status: '已撤销' } },
    ])
  })

  it('statValue 各聚合口径；空序列返回 null', () => {
    const s = { type: 'gauge', points: [[1, 2], [2, 4], [3, 10]] }
    expect(statValue(s, 'last')).toBe(10)
    expect(statValue(s, 'avg')).toBeCloseTo(16 / 3, 6)
    expect(statValue(s, 'max')).toBe(10)
    expect(statValue(s, 'min')).toBe(2)
    expect(statValue(s, 'sum')).toBe(16)
    expect(statValue(s, 'last', 100)).toBe(1000)
    expect(statValue({ points: [] }, 'last')).toBe(null)
    expect(statValue(null)).toBe(null)
  })
})

describe('数值格式化', () => {
  it('按量级取精度、大数千分位、非法值给破折号', () => {
    expect(formatValue(null)).toBe('—')
    expect(formatValue(0)).toBe('0')
    expect(formatValue(0.0123)).toBe('0.012')
    expect(formatValue(12.345)).toBe('12.3')
    expect(formatValue(1234.5)).toBe('1,235')
    expect(formatValue(1.5, 3)).toBe('1.500')
  })
})
