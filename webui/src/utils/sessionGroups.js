// 会话详情页「过程条目」整组折叠的纯派生（2026-10-10）
//
// 背景：dsh 会话里一次工具调用会解析成两条 entry（tool_call + tool_result），
// 加上夹在中间的 think，一轮里几十次调用就是几十条折叠标题行铺满整屏——真机上
// 647px 高度能塞 16 行，把用户提问与 agent 正文全挤出视口。
//
// 做法：把 entries 派生成「展示行」，把**连续 ≥2 条**的过程条目（think / tool_call /
// tool_result）收成一个 proc 组，组内条目仍各自折叠（默认态与改造前一致），
// 于是屏幕上「过程」只占一行摘要。单条不成组（如只落了一条思考、或结果还没回来的
// ask_user_question 调用）——保持改造前的渲染与跳转展开行为。
//
// 本模块只做纯派生（好单测）：分组、seq→行映射、摘要文案。
// 渲染与虚拟滚动记账在 components/SessionView.jsx（行即测量单元）。
//
// 行形状：
//   { key: 'r<首条seq>', seq: <首条 seq>, proc: bool, items: [entry, ...] }
// key 取组内首条 seq：组随事件流增长（think → +tool_call → +tool_result）时身份稳定，
// 展开态不丢；虚拟滚动的高度缓存也按该 key 记账。

/** 过程类条目 kind（会被收进 proc 组的类型） */
export const PROC_KINDS = ['think', 'tool_call', 'tool_result']

/** 摘要里工具名清单的字符预算（超出按段省略，防摘要行撑爆） */
const NAMES_BUDGET = 60

/** 是否过程条目 */
function isProc(e) {
  return !!e && PROC_KINDS.includes(e.kind)
}

/**
 * entries → 展示行
 * @param {Array} entries 会话条目（seq 升序的 append-only 数组）
 * @returns {{rows: Array, rowIndexOf: Map<number, number>}}
 *          rows = 展示行数组；rowIndexOf = 任意条目 seq → 所属行下标
 */
export function buildRows(entries) {
  const rows = []
  const rowIndexOf = new Map()
  const list = entries || []
  // 正在累积的过程段（连续过程条目）；遇到非过程条目或列表末尾时结算
  let run = []
  const flush = () => {
    if (!run.length) return
    if (run.length >= 2) {
      // ≥2 条：整段收成一个 proc 组行
      const idx = rows.length
      rows.push({ key: 'r' + run[0].seq, seq: run[0].seq, proc: true, items: run })
      for (const e of run) rowIndexOf.set(e.seq, idx)
    } else {
      // 单条：仍单独成行（改造前行为），跳转/展开语义不变
      const idx = rows.length
      rows.push({ key: 'r' + run[0].seq, seq: run[0].seq, proc: false, items: run })
      rowIndexOf.set(run[0].seq, idx)
    }
    run = []
  }
  for (const e of list) {
    if (isProc(e)) run.push(e)
    else { flush(); const idx = rows.length
      rows.push({ key: 'r' + e.seq, seq: e.seq, proc: false, items: [e] })
      rowIndexOf.set(e.seq, idx) }
  }
  flush()
  return { rows, rowIndexOf }
}

/**
 * 工具名顺序去重计数 → 段落数组（`bash` / `bash ×3`）
 * @param {Array<string>} names 按出现顺序的工具名
 * @returns {Array<string>}
 */
function nameSegments(names) {
  const order = []
  const count = new Map()
  for (const raw of names) {
    const n = String(raw || '').trim() || '工具'
    if (!count.has(n)) { count.set(n, 0); order.push(n) }
    count.set(n, count.get(n) + 1)
  }
  return order.map((n) => (count.get(n) > 1 ? `${n} ×${count.get(n)}` : n))
}

/**
 * proc 组摘要（组标题行文案与错误标记）
 * @param {Array} items 组内条目
 * @returns {{text: string, calls: number, thinks: number, errors: number}}
 *          text 形如 `工具 5 次 · skill, bash ×3 · 思考 2 段 · 错误 1 次`
 */
export function summarizeProc(items) {
  const list = items || []
  const calls = list.filter((e) => e.kind === 'tool_call')
  // 空正文的思考条目不渲染（Entry 对空思考返回 null），摘要同样不计数，避免虚报
  const thinks = list.filter((e) => e.kind === 'think' && String(e.text || '').trim()).length
  const results = list.filter((e) => e.kind === 'tool_result')
  const errors = results.filter((e) => e.is_error).length
  // 工具名优先取调用；只有结果没有调用（异常形态）时用结果里的名字兜底
  const src = calls.length ? calls : results
  const segs = nameSegments(src.map((e) => e.name))
  // 按段拼名称清单，超预算只留已装下的段并以「…」收尾
  const parts = []
  let used = 0
  for (const s of segs) {
    const add = (parts.length ? 2 : 0) + s.length
    if (parts.length && used + add > NAMES_BUDGET) { parts.push('…'); break }
    parts.push(s)
    used += add
  }
  const names = parts.join(', ')
  const chunks = []
  if (calls.length) chunks.push(`工具 ${calls.length} 次${names ? ` · ${names}` : ''}`)
  else if (names) chunks.push(names)     // 只有结果的异常形态：只出名称清单
  if (thinks) chunks.push(`思考 ${thinks} 段`)
  if (errors) chunks.push(`错误 ${errors} 次`)
  return { text: chunks.join(' · '), calls: calls.length, thinks, errors }
}
