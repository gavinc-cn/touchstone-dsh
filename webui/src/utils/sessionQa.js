// 提问索引侧栏的数据派生（2026-10-09 批次）：会话弹窗左侧栏原只列「用户提问」
// （entries 里 kind==='user'），本模块把 agent 的 ask_user_question 提问及其回答
// 也折进同一条索引，供点击跳转（锚点=提问条 seq，跳转后展开提问卡与结果条）。
//
// dsh 会话存储真形态（只读；见 doc_ai/spec/sess_dialog/会话详情对话框.md）：
//   提问 = tool/call，name='ask_user_question'，args 是
//          {questions:[{id,header,question,multi_select,options:[{label,description}]}]}（1~4 题）
//   回答 = 紧随其后、callId 相同的 tool/result，文本三态：
//          {"answers":[{"id","selected":[标签],"custom"?:自由文本}]} / 无结果（未答）/
//          "Error: …"（实测三类：aborted、cancelled、[自动检查点] 未提交拦截）
//   **没有**对应的 user/message 事件 ⇒ 答案只能按 callId 从 tool_result 配对（已核 76 个真会话）。
//
// 本模块只做纯派生（无 React/无请求），供 SessionView 的 QuestionBar 消费并单测覆盖。

// agent 提问的工具名（比对时统一小写；dsh 侧恒为 snake_case）
export const ASK_TOOL = 'ask_user_question'

// ask 项无回答时的占位文案（侧栏 240px 窄栏，不渲染整段题目）
export const ASK_PLACEHOLDER = { pending: '等待回答…', error: '未作答（已中断）' }

/** JSON 文本 → 对象或 null（非法 JSON / 非对象一律 null，截断的 args 不炸调用方）。 */
function _obj(text) {
  try {
    const o = JSON.parse(text)
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/** 该 entry 是否是 agent 提问的工具调用（工具名大小写不敏感）。 */
function _isAsk(e) {
  return String((e && e.name) || '').toLowerCase() === ASK_TOOL
}

/**
 * 解析 agent 提问的工具 args（JSON 文本）。
 *
 * args 在 sessparse 侧按 ARGS_MAX 截断，可能不是合法 JSON → 返回 []，调用方按
 * 「无题目信息」降级（只显示 agent 提问 + 回答），绝不抛异常。
 * 返回 [{id, header, question, multiSelect, options:[label…]}]，字段缺失用空串/空数组兜底。
 */
export function parseAskQuestions(args) {
  const o = _obj(args)
  const list = o && Array.isArray(o.questions) ? o.questions : []
  return list.filter((q) => q && typeof q === 'object').map((q) => ({
    id: String(q.id == null ? '' : q.id),
    header: String(q.header == null ? '' : q.header),
    multiSelect: !!q.multi_select,
    question: String(q.question == null ? '' : q.question),
    options: (Array.isArray(q.options) ? q.options : [])
      .filter((op) => op && typeof op === 'object' && op.label != null)
      .map((op) => String(op.label)),
  }))
}

/**
 * 解析 ask_user_question 的 tool_result 文本 → {kind, text}。
 *
 * kind：'answer'（用户答了，text=答案原文）|'pending'（尚无回答）|'error'（被中断）。
 * 答案拼装口径：同一子题的多选标签用「、」连接，选项与自定义文本用「；」连接，
 * 多子题之间也用「；」（侧栏只做 60 字摘要，精确对应关系看正文卡片）。
 * isError 置位（或文本以 `Error:` 开头）优先判中断——实况有 aborted / cancelled /
 * [自动检查点] 三种，均非用户作答，不能当答案展示。
 */
export function parseAskAnswer(text, isError = false) {
  const raw = String(text == null ? '' : text).trim()
  if (isError || raw.startsWith('Error:')) return { kind: 'error', text: '' }
  if (!raw) return { kind: 'pending', text: '' }
  const o = _obj(raw)
  if (!o || !Array.isArray(o.answers)) {
    // 合法/疑似 JSON 但没有 answers（形态未知）→ 不敢当答案展示，回落占位；
    // 非 JSON 的普通文本按答案原文呈现（宽容：宁可原样显示也不吞内容）
    const jsonish = raw.startsWith('{') || raw.startsWith('[')
    return jsonish ? { kind: 'pending', text: '' } : { kind: 'answer', text: raw }
  }
  const parts = []
  for (const a of o.answers) {
    if (!a || typeof a !== 'object') continue
    const sel = (Array.isArray(a.selected) ? a.selected : [])
      .map((x) => String(x)).filter((x) => x.trim())
    const custom = String(a.custom == null ? '' : a.custom).trim()
    if (sel.length && custom) parts.push(sel.join('、') + '；' + custom)
    else if (sel.length) parts.push(sel.join('、'))
    else if (custom) parts.push(custom)
  }
  const out = parts.join('；').trim()
  return out ? { kind: 'answer', text: out } : { kind: 'pending', text: '' }
}

/**
 * entries（sessparse 的会话条目流）→ 提问索引条目数组（按 seq 升序，单遍 O(n)）。
 *
 * 条目形状：{key, seq, kind:'user'|'ask', text, ansSeq, state, ask}
 *   user：seq=该用户消息（原规则：kind==='user' 且文本 trim 后非空），ansSeq=null，state='user'
 *   ask ：seq=提问那条（跳转锚点），ansSeq=配对的回答条 seq（未答=null），
 *         state='answered'|'pending'|'error'，ask=解析出的题目列表（供悬浮提示）
 * entries 本身按 seq 递增（sessparse 保证），故不额外排序。
 */
export function buildQuestionIndex(entries) {
  const list = Array.isArray(entries) ? entries : []
  // 一遍建结果索引：callId → tool_result（结果恒在提问之后，但按 Map 取与顺序无关）
  const results = new Map()
  for (const e of list) {
    if (e && e.kind === 'tool_result' && e.call_id) results.set(e.call_id, e)
  }
  const out = []
  for (const e of list) {
    if (!e) continue
    if (e.kind === 'user') {
      const text = String(e.text || '').trim()
      if (text) {
        out.push({ key: 'u:' + e.seq, seq: e.seq, kind: 'user', text,
                   ansSeq: null, state: 'user', ask: [] })
      }
    } else if (e.kind === 'tool_call' && _isAsk(e)) {
      const res = e.call_id ? results.get(e.call_id) : null
      const parsed = parseAskAnswer(res && res.text, !!(res && res.is_error))
      // state 是侧栏口径（answered/pending/error），parseAskAnswer 的 kind 是
      // 文本口径（answer/pending/error）：answer 在这里落到 answered
      out.push({ key: 'a:' + e.seq, seq: e.seq, kind: 'ask',
                 text: parsed.text, ansSeq: res ? res.seq : null,
                 state: res ? (parsed.kind === 'answer' ? 'answered' : parsed.kind) : 'pending',
                 ask: parseAskQuestions(e.args) })
    }
  }
  return out
}

/** 侧栏条目显示文案：user=提问原文；ask 已答=回答，未答/中断=占位文案。 */
export function questionLabel(q) {
  if (!q) return ''
  if (q.kind !== 'ask') return q.text || ''
  return q.state === 'answered' ? (q.text || '')
    : (ASK_PLACEHOLDER[q.state] || ASK_PLACEHOLDER.pending)
}

/** 悬浮提示：user 保持原文（与旧行为一致）；ask = 「agent 提问：题目…」+ 回答/占位。 */
export function questionTitle(q) {
  if (!q || q.kind !== 'ask') return (q && q.text) || ''
  const parts = (q.ask || [])
    .map((x) => (x.header ? x.header + '：' : '') + (x.question || ''))
    .filter(Boolean)
  const base = parts.length ? 'agent 提问：' + parts.join(' / ') : 'agent 提问'
  const tail = q.state === 'answered' ? '回答：' + q.text
    : (ASK_PLACEHOLDER[q.state] || ASK_PLACEHOLDER.pending)
  return base + '\n' + tail
}
