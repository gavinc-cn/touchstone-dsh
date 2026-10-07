import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from 'react'
import { useLiveStore } from '../stores/live'
import { bugStatusCls } from '../utils/bugStatus'

/* ============ 常量 ============ */
const PHASES = [
  ['retest', 'R', '复测'], ['angle', '1', '角度'], ['scan', '2', '盘点'], ['generate', '3', '生成'],
  ['review', '4', '判重'], ['execute', '5', '执行'], ['cluster', '6', '聚类'], ['analyze', '7', '分析'],
  ['fix', '7b', '修复'], ['wrapup', '8', '收尾'],
]
const ST_CLASS = { '通过': 'pass', '失败': 'fail', '需要复测': 'retest', '跳过': 'skip', '未执行': 'pending' }
const EV_META = {
  round_start: ['轮次', 'ev-round'], phase: ['阶段', 'ev-phase'],
  proposal: ['提案', ''], reject: ['拒绝', 'ev-reject'],
  case_start: ['开始', ''], case_pass: ['通过', 'ev-pass'], case_fail: ['失败', 'ev-fail'], case_skip: ['跳过', ''],
  bug_new: ['新Bug', 'ev-bug'], bug_append: ['补证据', 'ev-bug'],
  analyze_done: ['分析', 'ev-fix'], fix_done: ['修复', 'ev-fix'], note: ['备注', ''],
}
const FILTER_MAP = {
  all: null,
  fail: (e) => e.type === 'case_fail' || e.type === 'bug_new',
  case: (e) => e.type.startsWith('case_'),
  phase: (e) => e.type === 'phase' || e.type === 'round_start',
  bug: (e) => e.type === 'bug_new' || e.type === 'bug_append' || e.type === 'analyze_done' || e.type === 'fix_done',
}
const FILTER_LABEL = { all: '全部', fail: '失败', case: '用例', phase: '阶段', bug: 'Bug' }
const FILTERS = ['all', 'fail', 'case', 'phase', 'bug']
/* ============ 图表注册表 ============ */
// 3 个槽位可放的图与切换顺序(‹ › 沿此数组循环); CHART_META 提供各图标题
const CHART_ORDER = ['status', 'module', 'trend', 'bug', 'funnel']
const CHART_META = {
  status: { title: '案例库状态' }, module: { title: '模块通过率' }, trend: { title: '轮次趋势' },
  bug: { title: 'Bug 统计' }, funnel: { title: '产出漏斗' },
}
// Bug 统计图的行定义: [bugStatusCls 类, 展示名, 颜色]（颜色均为 theme.css 已定义变量）
const BUG_ROWS = [
  ['pending', '待处理', 'var(--dim)'],
  ['run', '已出方案', 'var(--run)'],
  ['retest', '待分析/复测未过', 'var(--retest)'],
  ['fix', '已修复', 'var(--fix)'],
  ['pass', '复测通过', 'var(--pass)'],
  ['reject', '已拒绝', 'var(--dim)'],
]
const SLOTS_KEY = 'ts.chartSlots'
// 从 localStorage 恢复槽位: 长度 3、id 全部合法且互不重复才采用, 否则回退默认布局
function loadSlots() {
  try {
    const saved = JSON.parse(localStorage.getItem(SLOTS_KEY) || 'null')
    if (Array.isArray(saved) && saved.length === 3
      && saved.every((id) => CHART_ORDER.includes(id)) && new Set(saved).size === 3) return saved
  } catch { /* 忽略坏数据 */ }
  return ['status', 'module', 'trend']
}
const SIZE_KEYS = { tree: 'ts.treeW', side: 'ts.sideW', chartsH: 'ts.chartsH', c1: 'ts.c1w', c2: 'ts.c2w' }
const DRAG = { tree: 'tree', side: 'side', chartsH: 'chartsH', c1: 'c1', c2: 'c2' }

/* ============ 工具 ============ */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const stCls = (s) => ST_CLASS[s] || 'pending'
const parseTs = (s) => { const d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? null : d }
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60)
  return (h ? h + 'h' : '') + (m ? m + 'm' : '') + (s % 60) + 's'
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export default function MonitorTab({ project }) {
  const projectId = project?.id
  // 不订阅整个 store(每次推送都会重渲染); connect/disconnect 走 getState() 取稳定 action
  const connected = useLiveStore((s) => s.connected)
  const liveState = useLiveStore((s) => s.live)
  const library = useLiveStore((s) => s.library)
  const bugs = useLiveStore((s) => s.bugs)
  const rounds = useLiveStore((s) => s.rounds)
  const updatedAt = useLiveStore((s) => s.updatedAt)

  /* ============ 响应式引用 ============ */
  const rootEl = useRef(null)
  const treeEl = useRef(null)
  const feedEl = useRef(null)
  const chartsEl = useRef(null)
  const elapsedEl = useRef(null)

  const [selectedCase, setSelectedCase] = useState(null)
  const [filter, setFilter] = useState('all')
  const [autoScroll, setAutoScroll] = useState(true)
  // 图表槽位: 每格显示哪张图, localStorage 记忆(与拖拽尺寸记忆同级)
  const [slots, setSlots] = useState(loadSlots)
  // 沿注册表循环切换第 idx 格的图表, 跳过其他格已占用的图; 选择写回 localStorage
  function switchChart(idx, dir) {
    setSlots((prev) => {
      const used = new Set(prev.filter((_, i) => i !== idx))
      let id = prev[idx]
      do {
        id = CHART_ORDER[(CHART_ORDER.indexOf(id) + dir + CHART_ORDER.length) % CHART_ORDER.length]
      } while (used.has(id))
      const next = [...prev]
      next[idx] = id
      localStorage.setItem(SLOTS_KEY, JSON.stringify(next))
      return next
    })
  }
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [staleText, setStaleText] = useState('')
  // 非渲染状态用 ref
  const caseIndexRef = useRef({})
  const runStartRef = useRef(null)
  const liveAgeSecRef = useRef(null)
  // 事件流增量渲染状态
  const feedRenderedRef = useRef(0)
  const feedFirstKeyRef = useRef('')
  const feedFilterRef = useRef('all')
  const caseRestoreDoneRef = useRef(false)

  const running = !!(liveState && liveState.phase && liveState.phase !== 'done' && liveState.phase !== 'idle')
  const phaseIdx = PHASES.findIndex((p) => p[0] === liveState?.phase)
  const phaseDone = liveState?.phase === 'done'
  const runState = !liveState
    ? { cls: 'idle', text: '空闲（未在运行）' }
    : liveState.phase === 'done'
      ? { cls: 'done', text: '本轮运行已结束' }
      : { cls: 'running', text: liveState.phase_label || liveState.phase || '运行中' }
  const stopCondText = (() => {
    const sc = liveState?.stop_condition
    if (!sc?.label) return ''
    return '停止条件: ' + sc.label +
      (sc.new_bugs != null ? ' · 新Bug ' + sc.new_bugs : '') +
      (sc.target_bugs != null ? '/' + sc.target_bugs : '')
  })()
  const connCls = connected ? '' : 'down'

  /* ============ 用例树 ============ */
  function countCases(node) { let n = node.cases.length; for (const c of node.children) n += countCases(c); return n }
  // 整树 HTML 只随 库/折叠/选中/当前用例 重建; liveState 其他字段(事件流等)变化不再触发整树重算
  const curCaseId = liveState?.current_case?.id
  const treeHtml = useMemo(() => {
    const lib = library
    if (!lib) return { __html: '' }
    function renderNode(node) {
      let html = ''
      for (const c of node.cases) {
        caseIndexRef.current[c.id] = c
        const isRunning = curCaseId === c.id
        const cls = stCls(c.status)
        html += `<div class="case${selectedCase === c.id ? ' selected' : ''}${isRunning ? ' running' : ''}" data-id="${c.id}" title="${esc(c.point || c.name)}">`
          + `<span class="dot ${isRunning ? '' : cls}"></span><span class="cid">${c.id}</span><span class="cname">${esc(c.name)}</span></div>`
      }
      for (const ch of node.children) {
        const open = collapsed.has(ch.path) ? '' : ' open'
        html += `<details data-path="${esc(ch.path)}"${open}><summary><span class="arrow">▶</span><span>${esc(ch.name)}</span><span class="fcount">${countCases(ch)}</span>${ch.desc ? `<span class="fdesc">${esc(ch.desc)}</span>` : ''}</summary><div class="folder-body">${renderNode(ch)}</div></details>`
      }
      return html
    }
    const html = lib.tree.children.length || lib.tree.cases.length
      ? renderNode(lib.tree)
      : '<div class="empty">案例库为空——运行测试任务生成用例后在此展示。</div>'
    return { __html: html }
  }, [library, collapsed, selectedCase, curCaseId])

  function collectPaths(node) {
    const paths = []
    for (const ch of node.children) {
      paths.push(ch.path)
      paths.push(...collectPaths(ch))
    }
    return paths
  }
  function expandAllTree() { setCollapsed(new Set()) }
  function collapseAllTree() {
    const lib = library
    if (!lib) return
    setCollapsed(new Set(collectPaths(lib.tree)))
  }

  function onTreeClick(e) {
    const row = e.target.closest('.case')
    if (!row) return
    const id = row.dataset.id
    setSelectedCase((prev) => {
      const next = prev === id ? null : id
      if (next) {
        localStorage.setItem('ts_monitor_pick', JSON.stringify({ proj: projectId, id: next }))
      } else {
        localStorage.removeItem('ts_monitor_pick')
      }
      return next
    })
  }
  // details toggle 事件(原生, 不冒泡到 React 合成事件体系, 直接绑容器)
  useEffect(() => {
    const el = treeEl.current
    if (!el) return
    const onToggle = (e) => {
      const d = e.target
      if (d.tagName === 'DETAILS' && d.dataset.path) {
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (d.open) next.delete(d.dataset.path)
          else next.add(d.dataset.path)
          return next
        })
      }
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [])

  /* ============ 事件流(增量渲染) ============ */
  function payloadHtml(e) {
    if (!e.request && !e.response) return ''
    return `<details class="payload"><summary>请求 / 返回</summary>`
      + (e.request ? `<div class="plabel">请求</div><pre>${esc(e.request)}</pre>` : '')
      + (e.response ? `<div class="plabel">返回</div><pre>${esc(e.response)}</pre>` : '') + '</details>'
  }
  function evHtml(e) {
    const meta = EV_META[e.type] || ['事件', '']
    return `<div class="ev ${meta[1]}"><span class="ts">${esc(e.ts || '')}</span><span class="badge">${meta[0]}</span>`
      + (e.case_id ? `<span class="cid">${e.case_id}</span>` : '')
      + `<span class="msg">${esc(e.message || '')}</span>${payloadHtml(e)}</div>`
  }
  function emptyFeedHtml() {
    return '<div id="feed-empty">' + (liveState
      ? '（当前筛选下暂无事件）'
      : '当前没有运行中的测试。<br>在会话中开启实时监控后，运行期间的事件会实时出现在这里。') + '</div>'
  }
  function renderFeed() {
    const evts = liveState?.events || []
    const pred = FILTER_MAP[filter]
    const list = pred ? evts.filter(pred) : evts
    const firstKey = list.length ? JSON.stringify(list[0]) : ''
    const f = feedEl.current
    if (!f) return
    if (filter !== feedFilterRef.current || firstKey !== feedFirstKeyRef.current || list.length < feedRenderedRef.current) {
      feedFilterRef.current = filter
      feedFirstKeyRef.current = firstKey
      f.innerHTML = list.length ? list.map(evHtml).join('') : emptyFeedHtml()
      feedRenderedRef.current = list.length
    } else if (list.length > feedRenderedRef.current) {
      if (feedRenderedRef.current === 0) f.innerHTML = ''
      f.insertAdjacentHTML('beforeend', list.slice(feedRenderedRef.current).map(evHtml).join(''))
      feedRenderedRef.current = list.length
    }
    if (autoScroll) f.scrollTop = f.scrollHeight
  }
  // 库/实时/轮次/筛选变化时重绘事件流
  useEffect(() => {
    renderFeed()
    restoreCasePick()
  }, [filter, library, liveState, rounds])

  /* ============ 图表 ============ */
  function aggStatus(node) {
    const a = { pass: 0, fail: 0, retest: 0, pending: 0, total: 0 }
    ;(function walk(n) {
      for (const c of n.cases) {
        let k = stCls(c.status)
        if (k === 'skip') k = 'pending'
        a[k] = (a[k] || 0) + 1
        a.total++
      }
      for (const ch of n.children) walk(ch)
    })(node)
    return a
  }
  const chartStatus = useMemo(() => {
    const s = library?.stats
    if (!s) return { sub: '', body: '' }
    const total = s.total
    const passRate = total ? Math.round(s.passed / total * 100) : 0
    const segs = [['通过', s.passed, 'var(--pass)'], ['失败', s.failed, 'var(--fail)'],
      ['需复测', s.retest, 'var(--retest)'], ['未执行', s.pending + s.skipped, 'var(--dim)']]
    let acc = 0
    // 环形: 段间留 1.5% 空隙(圆帽), 视觉上让每段独立可读
    const circles = segs.filter((g) => g[1] > 0).map((g) => {
      const frac = total ? g[1] / total * 100 : 0
      const dash = Math.max(0, frac - 1.5)
      const el = `<circle cx="21" cy="21" r="15.915" fill="none" stroke="${g[2]}" stroke-width="6" pathLength="100" stroke-linecap="round" stroke-dasharray="${dash} ${100 - dash}" stroke-dashoffset="${25 - acc}"/>`
      acc += frac
      return el
    }).join('')
    return { sub: `通过率 <b class="hl-pass">${passRate}%</b>`
      , body: `<div class="cbody">`
        + (total ? `<svg viewBox="0 0 42 42" class="donut">${circles}`
          + `<text x="21" y="19.5" class="dnum" text-anchor="middle">${total}</text>`
          + `<text x="21" y="26" class="dsub" text-anchor="middle">用例</text></svg>`
          + `<div class="dlegend">${segs.map((g) => `<div class="li"><span class="sw" style="background:${g[2]}"></span>${g[0]}<span class="lm">${g[1]}</span><span class="pct">${total ? Math.round(g[1] / total * 100) : 0}%</span></div>`).join('')}</div>`
          : '<div class="empty">案例库为空</div>')
        + `</div>` }
  }, [library])
  const chartModule = useMemo(() => {
    const lib = library
    if (!lib) return { sub: '', body: '' }
    let level = lib.tree
    while (level.children.length === 1 && !level.cases.length && level.children[0].children.length) level = level.children[0]
    const rows = level.children.map((ch) => ({ name: ch.name, a: aggStatus(ch) })).filter((r) => r.a.total > 0)
    if (level.cases.length) rows.push({ name: '(根目录)', a: aggStatus({ cases: level.cases, children: [] }) })
    rows.sort((x, y) => y.a.total - x.a.total)
    return { sub: `${rows.length} 个分类`
      , body: `<div class="cbody">`
        + (rows.length ? `<div class="mbars">${rows.map((r) => {
          const t = r.a.total
          const pct = t ? Math.round(r.a.pass / t * 100) : 0
          const seg = (k, cls) => r.a[k] ? `<div class="seg ${cls}" style="width:${r.a[k] / t * 100}%"></div>` : ''
          return `<div class="mbar-row"><span class="mbar-label" title="${esc(r.name)}">${esc(r.name)}</span>`
            + `<div class="mbar-track"><div class="mbar-inner">${seg('pass', 'pass')}${seg('fail', 'fail')}${seg('retest', 'retest')}${seg('pending', 'pending')}</div></div>`
            + `<span class="mbar-num" title="通过/总数"><b class="hl-pass">${r.a.pass}</b><em>/${t}</em><i class="pctn">${pct}%</i></span></div>`
        }).join('')}</div>`
          : '<div class="empty">案例库为空</div>')
        + `</div><div class="mlegend"><span><span class="sw" style="background:var(--pass)"></span>通过</span>`
        + `<span><span class="sw" style="background:var(--fail)"></span>失败</span>`
        + `<span><span class="sw" style="background:var(--retest)"></span>需复测</span>`
        + `<span><span class="sw" style="background:var(--dim)"></span>未执行</span></div>` }
  }, [library])
  const chartTrend = useMemo(() => {
    const rs = rounds || []
    if (!rs.length) return { sub: '', body: '<div class="cbody"><div class="empty">暂无轮次记录</div></div>' }
    const W = 340, H = 126, padT = 30, padB = 20, padL = 22
    const max = Math.max(1, ...rs.map((r) => r.passed + r.failed))
    const slot = (W - padL) / rs.length
    const bw = Math.min(34, slot * 0.52)
    const base = H - padB
    const hmax = H - padT - padB
    // 横向网格 + 左侧 y 刻度(0 / half / max)
    let grid = ''
    for (let i = 0; i <= 2; i++) {
      const gy = base - hmax * (i / 2)
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - 2}" y2="${gy}" class="t-grid"/>`
      grid += `<text x="${padL - 5}" y="${gy + 2.5}" class="t-ytick" text-anchor="end">${Math.round(max * i / 2)}</text>`
    }
    let bars = ''
    rs.forEach((r, i) => {
      const x = Math.round(padL + i * slot + (slot - bw) / 2)
      const cx = Math.round(padL + i * slot + slot / 2)
      const ph = Math.round(r.passed / max * hmax)
      const fh = Math.round(r.failed / max * hmax)
      if (ph) bars += `<rect x="${x}" y="${base - ph}" width="${bw}" height="${ph}" fill="url(#grad-pass)" rx="2"><title>第 ${r.round} 轮 通过 ${r.passed}</title></rect>`
      if (fh) bars += `<rect x="${x}" y="${base - ph - fh}" width="${bw}" height="${fh}" fill="url(#grad-fail)" rx="2"><title>第 ${r.round} 轮 失败 ${r.failed}</title></rect>`
      const exec = r.passed + r.failed
      const ty = base - ph - fh
      if (r.new_bugs > 0) bars += `<text x="${cx}" y="${ty - 16}" class="t-bug" text-anchor="middle">+${r.new_bugs}bug</text>`
      if (exec > 0) bars += `<text x="${cx}" y="${ty - 6}" class="t-val" text-anchor="middle">${exec}</text>`
      bars += `<text x="${cx}" y="${H - 5}" class="t-lab" text-anchor="middle">R${r.round}</text>`
    })
    return { sub: `绿通过 / 红失败 · 黄字=新建Bug`
      , body: `<div class="cbody"><svg viewBox="0 0 ${W} ${H}" class="trend" preserveAspectRatio="xMidYMid meet">`
        + `<defs>`
        + `<linearGradient id="grad-pass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--grad-pass-1)"/><stop offset="1" stop-color="var(--grad-pass-2)"/></linearGradient>`
        + `<linearGradient id="grad-fail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--grad-fail-1)"/><stop offset="1" stop-color="var(--grad-fail-2)"/></linearGradient>`
        + `</defs>`
        + `<line x1="${padL}" y1="${base}" x2="${W - 2}" y2="${base}" class="t-axis"/>${grid}${bars}</svg></div>` }
  }, [rounds])
  /* Bug 统计图: 按状态分类横向条形, 分类口径与 BugsTab 的 bugStatusCls 一致 */
  const chartBug = useMemo(() => {
    const list = bugs || []
    if (!list.length) return { sub: '', body: '<div class="cbody"><div class="empty">暂无 bug 报告</div></div>' }
    const counts = {}
    for (const b of list) {
      const k = bugStatusCls(b.status)
      counts[k] = (counts[k] || 0) + 1
    }
    const max = Math.max(1, ...BUG_ROWS.map((r) => counts[r[0]] || 0))
    const rows = BUG_ROWS.filter((r) => counts[r[0]] > 0).map(([k, label, color]) =>
      `<div class="mbar-row"><span class="mbar-label" title="${label}">${label}</span>`
      + `<div class="mbar-track"><div class="bbar" style="width:${counts[k] / max * 100}%;background:${color}"></div></div>`
      + `<span class="mbar-num"><b>${counts[k]}</b><i class="pctn">${Math.round(counts[k] / list.length * 100)}%</i></span></div>`
    ).join('')
    return { sub: `共 <b>${list.length}</b> 个`, body: `<div class="cbody"><div class="mbars">${rows}</div></div>` }
  }, [bugs])
  /* 产出漏斗图: live.stats 的 提案→入库→执行→通过 四级; 右列为 数量 · 对上一级转化率 */
  const chartFunnel = useMemo(() => {
    const st = liveState?.stats
    if (!st || (st.proposed == null && st.accepted == null && st.executed == null)) {
      return { sub: '', body: '<div class="cbody"><div class="empty">暂无运行统计</div></div>' }
    }
    const lv = [['提案', st.proposed], ['入库', st.accepted], ['执行', st.executed], ['通过', st.passed]]
    const max = Math.max(1, ...lv.map((x) => x[1] || 0))
    let prev = null
    const rows = lv.map(([label, v]) => {
      const rate = (prev != null && prev > 0 && v != null) ? Math.round(v / prev * 100) + '%' : '—'
      prev = v
      return `<div class="frow"><span class="fl">${label}</span>`
        + `<div class="ftrack"><div class="fbar" style="width:${v ? Math.round(v / max * 100) : 0}%"></div></div>`
        + `<span class="fr">${v == null ? '—' : v} · ${rate}</span></div>`
    }).join('')
    // 自动修复开启且本轮有修复统计时, 追加 已修复/失败数 一行(黄色系)
    let fixRow = ''
    if (liveState?.options?.auto_fix && st.fixed != null) {
      const base = Math.max(1, st.failed || 0)
      fixRow = `<div class="frow fixbar"><span class="fl">已修复</span>`
        + `<div class="ftrack"><div class="fbar" style="width:${Math.round((st.fixed || 0) / base * 100)}%"></div></div>`
        + `<span class="fr">${st.fixed} / ${st.failed ?? 0}</span></div>`
    }
    return { sub: st.rejected > 0 ? `拒绝 <b>${st.rejected}</b>` : ''
      , body: `<div class="cbody"><div class="funnel">${rows}${fixRow}</div></div>` }
  }, [liveState])
  // id → {sub, body}; h4 标题来自 CHART_META, 图体经 .cwrap 注入
  const chartsMap = { status: chartStatus, module: chartModule, trend: chartTrend, bug: chartBug, funnel: chartFunnel }

  /* ============ 案例库统计 chip ============ */
  const libStatsHtml = useMemo(() => {
    const s = library?.stats
    if (!s) return null
    return { __html: `<span class="chip"><span class="dot pass"></span><b>${s.passed}</b></span>`
      + `<span class="chip"><span class="dot fail"></span><b>${s.failed}</b></span>`
      + `<span class="chip"><span class="dot retest"></span><b>${s.retest}</b></span>`
      + `<span class="chip"><span class="dot pending"></span><b>${s.pending + s.skipped}</b></span>`
      + `<span class="chip">共 <b>${s.total}</b></span>` }
  }, [library])

  /* ============ 用例详情 ============ */
  function lastPayload(caseId) {
    const evts = liveState?.events || []
    for (let i = evts.length - 1; i >= 0; i--) {
      const e = evts[i]
      if (e.case_id === caseId && (e.request || e.response)) return e
    }
    return null
  }
  const detailHtml = useMemo(() => {
    const l = liveState
    const id = selectedCase || (l?.current_case?.id)
    const c = id ? caseIndexRef.current[id] : null
    const isRunning = !!(l && l.current_case?.id === id && l.phase !== 'done')
    const ev = id ? lastPayload(id) : null
    if (!id) return { __html: '<h3>用例详情</h3><div class="empty">点击左侧用例查看详情；运行中默认显示当前用例。</div>' }
    const c2 = c || (l && l.current_case)
    const status = isRunning ? '执行中' : (c ? c.status : '')
    const bugLink = c && c.bug_report && c.bug_report !== '无' ? c.bug_report : ''
    let html = '<h3>用例详情' + (selectedCase ? '' : '（当前执行）') + '</h3>'
      + `<div class="kv"><span class="k">ID</span><span class="v mono">${esc(id)}</span></div>`
      + `<div class="kv"><span class="k">名称</span><span class="v">${esc(c ? c.name : (c2 && c2.name) || '')}</span></div>`
      + (c && c.point ? `<div class="kv"><span class="k">测试点</span><span class="v">${esc(c.point)}</span></div>` : '')
      + `<div class="kv"><span class="k">状态</span><span class="v"><span class="badge-st ${isRunning ? 'run' : stCls(status)}">${esc(status || '—')}</span></span></div>`
      + (c && c.fail_reason ? `<div class="kv"><span class="k">失败原因</span><span class="v">${esc(c.fail_reason)}</span></div>` : '')
      + (c && c.summary ? `<div class="kv"><span class="k">结果摘要</span><span class="v">${esc(c.summary)}</span></div>` : '')
      + (c && c.last_run ? `<div class="kv"><span class="k">最近执行</span><span class="v mono">${esc(c.last_run)}</span></div>` : '')
      + (bugLink ? `<div class="kv"><span class="k">bug_report</span><span class="v mono">${esc(bugLink)}</span></div>` : '')
    if (ev) {
      html += `<div class="plabel">请求</div><pre>${esc(ev.request || '（无记录）')}</pre>`
        + `<div class="plabel">返回</div><pre>${esc(ev.response || '（无记录）')}</pre>`
    }
    return { __html: html }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCase, liveState])

  const statsHtml = useMemo(() => {
    const st = liveState?.stats
    return { __html: st
      ? `本轮: 提案 <b>${st.proposed ?? '—'}</b> · 入库 <b>${st.accepted ?? '—'}</b> · 拒绝 <b>${st.rejected ?? '—'}</b>`
      + ` · 已执行 <b>${st.executed ?? '—'}</b> · 通过 <b style="color:var(--pass)">${st.passed ?? 0}</b>`
      + ` · 失败 <b style="color:var(--fail)">${st.failed ?? 0}</b> · 跳过 <b>${st.skipped ?? 0}</b>`
      + ` · 新建Bug <b style="color:var(--fail)">${st.new_bug_reports ?? 0}</b>`
      + (st.fixed != null && liveState?.options?.auto_fix ? ` · 已修复 <b style="color:var(--fix)">${st.fixed}</b>` : '')
      : '案例库统计见左侧。' }
  }, [liveState])

  // 功能分级测试进度(先核心后细节的推进进度): live.json 无 priorities 字段时返回 null, 整条不渲染
  const prioHtml = useMemo(() => {
    const levels = liveState?.priorities?.levels
    if (!Array.isArray(levels) || !levels.length) return null
    const rows = levels.map((lv) => {
      const doms = Array.isArray(lv.domains) ? lv.domains : []
      const total = doms.length
      const covered = doms.filter((d) => d.status === '已覆盖').length
      const pct = total ? Math.round(covered / total * 100) : 0
      const chips = doms.map((d) =>
        `<span class="pchip${d.status === '已覆盖' ? ' ok' : ''}" title="${esc(d.name)}：${esc(d.status || '未覆盖')}">${esc(d.name)}</span>`
      ).join('')
      return `<div class="prio-row"><span class="prio-level">${esc(lv.level || '')}</span>`
        + `<span class="prio-label">${esc(lv.label || '')}</span>`
        + `<span class="prio-track"><span class="prio-in" style="width:${pct}%"></span></span>`
        + `<span class="prio-num">${covered}<em>/${total}</em></span>`
        + `<span class="prio-chips">${chips}</span></div>`
    }).join('')
    return { __html: '<div class="prio-title">测试进度（按功能分级）</div>' + rows }
  }, [liveState])

  /* ============ 分栏拖拽 ============ */
  // 三个图表用 fr 比例布局(--c1-fr/--c2-fr/--c3-fr): 侧栏宽度变化时 fr 自动等比缩放;
  // 拖动图表间分隔条时, 被拖列吸收增量, 其余列按当前比例分摊, 三张图始终协同变化
  const SIZE_DEF = { tree: 300, side: 370, chartsH: 176, chartRatio: [1, 1.15, 1.35] }
  const CHART_MIN_RATIO = 0.22   // 单张图最小占比, 防止拖没了
  function getChartRatio() {
    const cs = getComputedStyle(chartsEl.current)
    const p1 = parseFloat(cs.getPropertyValue('--c1-fr')) || SIZE_DEF.chartRatio[0]
    const p2 = parseFloat(cs.getPropertyValue('--c2-fr')) || SIZE_DEF.chartRatio[1]
    const p3 = parseFloat(cs.getPropertyValue('--c3-fr')) || SIZE_DEF.chartRatio[2]
    const sum = p1 + p2 + p3
    return [p1 / sum, p2 / sum, p3 / sum]
  }
  function setChartRatio(p) {
    const el = chartsEl.current
    el.style.setProperty('--c1-fr', p[0] + 'fr')
    el.style.setProperty('--c2-fr', p[1] + 'fr')
    el.style.setProperty('--c3-fr', p[2] + 'fr')
  }
  function startDrag(e, which) {
    if (e.button !== 0 || e.detail > 1) return
    const main = rootEl.current.querySelector('.m-main')
    const charts = chartsEl.current
    if (!main || !charts) return
    const getSize = () => {
      if (which === 'tree') return parseInt(getComputedStyle(main).getPropertyValue('--tree-w'), 10) || SIZE_DEF.tree
      if (which === 'side') return parseInt(getComputedStyle(main).getPropertyValue('--side-w'), 10) || SIZE_DEF.side
      if (which === 'chartsH') return charts.getBoundingClientRect().height || SIZE_DEF.chartsH
      return 0
    }
    const setSize = (v) => {
      if (which === 'tree') main.style.setProperty('--tree-w', clamp(v, 180, 600) + 'px')
      else if (which === 'side') main.style.setProperty('--side-w', clamp(v, 260, 720) + 'px')
      else if (which === 'chartsH') charts.style.height = clamp(v, 150, 520) + 'px'
    }
    const s0 = getSize()
    const p0 = (which === 'chartsH') ? e.clientY : e.clientX
    const invert = which === 'side'
    const isY = which === 'chartsH'
    const isChart = which === 'c1' || which === 'c2'
    const p0r = isChart ? getChartRatio() : null  // 图表比例拖动起始值
    const hEl = e.currentTarget
    hEl.classList.add('drag')
    document.body.classList.add(isY ? 'resizing-y' : 'resizing-x')
    const move = (ev) => {
      let d = (isY ? ev.clientY : ev.clientX) - p0
      if (invert) d = -d
      if (isChart) {
        // 图表间分隔条: 增量换算为占比变化, 被拖列吸收, 其余列按比例分摊
        const p = [...p0r]
        const idx = which === 'c1' ? 0 : 1
        const other = [0, 1, 2].filter((i) => i !== idx)
        const w = charts.getBoundingClientRect().width
        const delta = d / Math.max(1, w)
        let v = p[idx] + delta
        v = clamp(v, CHART_MIN_RATIO, 1 - 2 * CHART_MIN_RATIO)
        const rest = 1 - v
        const base = 1 - p[idx]
        if (base > 0.0001) {
          p[idx] = v
          p[other[0]] = p[other[0]] / base * rest
          p[other[1]] = p[other[1]] / base * rest
        }
        setChartRatio(p)
      } else {
        setSize(s0 + d)
      }
    }
    const up = () => {
      hEl.classList.remove('drag')
      document.body.classList.remove('resizing-x', 'resizing-y')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      if (isChart) {
        localStorage.setItem(SIZE_KEYS.c1, JSON.stringify(getChartRatio()))
      } else {
        localStorage.setItem(SIZE_KEYS[which], String(Math.round(getSize())))
      }
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  function resetDrag(which) {
    const main = rootEl.current.querySelector('.m-main')
    const charts = chartsEl.current
    if (which === 'tree') main.style.removeProperty('--tree-w')
    else if (which === 'side') main.style.removeProperty('--side-w')
    else if (which === 'chartsH') charts.style.height = ''
    else {
      charts.style.removeProperty('--c1-fr')
      charts.style.removeProperty('--c2-fr')
      charts.style.removeProperty('--c3-fr')
    }
    localStorage.removeItem(SIZE_KEYS[which])
  }
  function restoreSizes() {
    const main = rootEl.current.querySelector('.m-main')
    const charts = chartsEl.current
    if (!main || !charts) return
    try {
      const t = +localStorage.getItem(SIZE_KEYS.tree)
      if (t > 0) main.style.setProperty('--tree-w', t + 'px')
      const s = +localStorage.getItem(SIZE_KEYS.side)
      if (s > 0) main.style.setProperty('--side-w', s + 'px')
      const c = +localStorage.getItem(SIZE_KEYS.chartsH)
      if (c > 0) charts.style.height = c + 'px'
      const rr = JSON.parse(localStorage.getItem(SIZE_KEYS.c1) || 'null')
      if (Array.isArray(rr) && rr.length === 3) setChartRatio(rr)
    } catch { /* 忽略 */ }
  }

  /* ============ 恢复刷新前选中的用例 ============ */
  function restoreCasePick() {
    if (caseRestoreDoneRef.current) return
    try {
      const p = JSON.parse(localStorage.getItem('ts_monitor_pick') || 'null')
      if (p && p.proj === projectId && caseIndexRef.current[p.id]) {
        setSelectedCase(p.id)
        caseRestoreDoneRef.current = true
      }
    } catch { /* 忽略 */ }
  }

  /* ============ 每秒 tick: 已运行时长 + 状态文件未更新提示 ============ */
  function tickElapsed() {
    const liveNow = useLiveStore.getState().live
    liveAgeSecRef.current = (liveNow?.live_mtime != null) ? Date.now() / 1000 - liveNow.live_mtime : null
    if (runStartRef.current && elapsedEl.current) {
      elapsedEl.current.textContent = '已运行 ' + fmtDur(Date.now() - runStartRef.current.getTime())
    }
    const isRunning = liveNow && liveNow.phase && liveNow.phase !== 'done' && liveNow.phase !== 'idle'
    if (liveAgeSecRef.current != null && isRunning && liveAgeSecRef.current > 30) {
      setStaleText('状态文件 ' + Math.round(liveAgeSecRef.current) + 's 未更新')
    } else {
      setStaleText('')
    }
  }

  /* ============ 生命周期 ============ */
  useEffect(() => {
    restoreSizes()
    const t = setInterval(tickElapsed, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (projectId) useLiveStore.getState().connect(projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
  useEffect(() => () => { useLiveStore.getState().disconnect() }, [])
  // 首次拿到运行时间后固定 runStart(与旧实现一致: 只初始化一次)
  useEffect(() => {
    if (runStartRef.current == null && liveState?.run_started_at) {
      runStartRef.current = parseTs(liveState.run_started_at)
    }
  }, [liveState])

  return (
    <div className="monitor-tab" ref={rootEl}>
      <header className="m-head">
        <div className="logo"><span className={'pulse' + (running ? ' on' : '')}></span>Free-Style 测试监控<span style={{ color: 'var(--dim)' }}> · {project?.name}</span></div>
        <span className={'pill ' + runState.cls}>{runState.text}</span>
        {liveState?.round != null && <span className="pill mono">{'第 ' + liveState.round + ' 轮'}</span>}
        {runStartRef.current && <span className="pill mono" ref={elapsedEl}></span>}
        {stopCondText && <span className="pill">{stopCondText}</span>}
        {liveState?.options && <span className="pill">{'自动修复: ' + (liveState.options.auto_fix ? '开' : '关')}</span>}
        {liveState?.options && <span className="pill">{'复测: ' + (liveState.options.retest || '不复测')}</span>}
        <div className="spacer"></div>
        {staleText && <span className="pill warn">{staleText}</span>}
        <span className={connCls} title="与监控服务器的连接状态"></span>
      </header>
      <nav className="phases">
        {PHASES.map((p, i) => (
          <span key={p[0]} className={'step' + (phaseDone || i < phaseIdx ? ' done' : '') + (!phaseDone && i === phaseIdx ? ' active' : '')}>
            <span className="no">{p[1]}</span>{p[2]}
          </span>
        ))}
      </nav>
      <div className="m-main">
        <aside className="tree-panel">
          <div className="panel-head">案例库 <span className="lib-stats" dangerouslySetInnerHTML={libStatsHtml || undefined}></span>
            <div className="spacer"></div>
            <div className="tree-tools">
              <span className="tbtn" onClick={expandAllTree}>全部展开</span>
              <span className="tbtn" onClick={collapseAllTree}>全部折叠</span>
            </div>
          </div>
          <div className="panel-body" ref={treeEl} onClick={onTreeClick} dangerouslySetInnerHTML={treeHtml}></div>
        </aside>
        <div className="vsplit" onMouseDown={(e) => startDrag(e, DRAG.tree)} onDoubleClick={() => resetDrag(DRAG.tree)}></div>
        <section className="feed-panel">
          <div className="charts" ref={chartsEl}>
            {slots.map((cid, i) => {
              const chart = chartsMap[cid]
              return (
                <Fragment key={cid}>
                  {i > 0 && (
                    <div className="vsplit" onMouseDown={(e) => startDrag(e, i === 1 ? DRAG.c1 : DRAG.c2)}
                      onDoubleClick={() => resetDrag(i === 1 ? DRAG.c1 : DRAG.c2)}></div>
                  )}
                  <div className="chart">
                    <h4>
                      <span className="t">{CHART_META[cid].title}</span>
                      <span className="sub" dangerouslySetInnerHTML={{ __html: chart.sub || '' }}></span>
                      <span className="bswitch">
                        <span className="swbtn" title="上一张图" onClick={() => switchChart(i, -1)}>‹</span>
                        <span className="swbtn" title="下一张图" onClick={() => switchChart(i, 1)}>›</span>
                      </span>
                    </h4>
                    <div className="cwrap" dangerouslySetInnerHTML={{ __html: chart.body }}></div>
                  </div>
                </Fragment>
              )
            })}
          </div>
          <div className="hsplit" onMouseDown={(e) => startDrag(e, DRAG.chartsH)} onDoubleClick={() => resetDrag(DRAG.chartsH)}></div>
          <div className="panel-head">
            实时事件流
            <div className="feed-tools">
              {FILTERS.map((f) => (
                <span key={f} className={'chip fchip' + (filter === f ? ' on' : '')} data-f={f} onClick={() => setFilter(f)}>{FILTER_LABEL[f]}</span>
              ))}
            </div>
            <div className="spacer"></div>
            <label className="chip fchip on" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} style={{ verticalAlign: -1 }} /> 自动滚动
            </label>
          </div>
          <div className="feed" ref={feedEl}></div>
        </section>
        <div className="vsplit" onMouseDown={(e) => startDrag(e, DRAG.side)} onDoubleClick={() => resetDrag(DRAG.side)}></div>
        <aside className="side-panel" dangerouslySetInnerHTML={detailHtml}></aside>
      </div>
      {prioHtml && <section className="prio-bar" dangerouslySetInnerHTML={prioHtml}></section>}
      <footer className="statusbar">
        <span dangerouslySetInnerHTML={statsHtml}></span>
        <div className="spacer"></div>
        <span>{'数据更新于 ' + (updatedAt || '—')}</span>
      </footer>
    </div>
  )
}

