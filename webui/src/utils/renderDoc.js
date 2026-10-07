// 文档级 markdown 渲染（utils/renderDoc.js）
//
// renderMd 只做「行 → HTML」，不知道文档结构；方案页/报告页需要的是「文档」：
//   1. 表格包一层横向滚动容器（5 列表格在窄面板里必须能横滚，不能把面板撑破）；
//   2. 标题加锚点 id + 拆出章节序号（`## 3. 加压模型` → 金色序号 `3` + 正文标题），
//      同时产出目录条目（outline），供左侧导引轨做滚动定位；
//   3. 抽取「抬头」（首个 h1 作文档标题 + 紧随其后的键值列表作元信息行）——
//      压测方案模板规定 plan.md 开头就是「- 目标服务：… / - 执行载体：…」这种块。
//
// 抽取是「宽进严出」的：形状不符（缺 h1、抬头里有一项不是键值、只有 1 项）就原样留在
// 正文里，绝不丢内容；没有 DOMParser 的环境（SSR/旧测试环境）退回纯 renderMd 结果。
import { renderMd } from './renderMd'

/** 章节序号：`1` / `1.2` / `3.` / `4)` 开头才算（后随至少一个空格）；
 *  限 1~2 位是防「2026. 10 月计划」这类以年份开头的标题被拆号 */
const SEC_NO = /^(\d{1,2}(?:\.\d{1,2})*)[.)、]?\s+/
/** 抬头键值：`- 目标服务：xxx` / `- 执行载体: xxx`（键 ≤24 字，不含冒号） */
const META_KV = /^([^：:]{1,24})[：:]\s*(.*)$/

/** 取元素内第一个文本节点（标题/表格单元格可能含行内标记，序号只可能落在首个文本节点上） */
function firstTextNode(root) {
  const w = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */)
  return w.nextNode()
}

/**
 * 把「文档标题 + 抬头键值块」从正文里摘出来。
 *
 * 只认「正文第一个元素是 h1」且「紧跟其后的第一个元素是 ul，且每一项都形如 键：值」，
 * 且至少 2 项——全部满足才摘；否则只摘 h1（作页面标题用），抬头原样留在正文。
 * 注意：探测阶段只读不改——形状不符时正文必须逐字不变（先改后判会把键名吃掉）。
 * 返回 { title, meta: [{k, v}] }。
 */
function pickHeader(root) {
  const h1 = root.querySelector('h1')
  if (!h1) return { title: '', meta: [] }
  const title = h1.textContent.trim()
  h1.remove()
  const first = root.firstElementChild
  if (!first || first.tagName !== 'UL') return { title, meta: [] }
  const hits = []
  for (const li of [...first.children]) {
    const t = firstTextNode(li)
    if (!t) return { title, meta: [] }
    const m = t.data.match(META_KV)
    if (!m) return { title, meta: [] }
    hits.push([t, m])
  }
  if (hits.length < 2) return { title, meta: [] }
  const meta = hits.map(([t, m]) => {
    t.data = m[2]                    // 值留在原位（其中的 <code> 等行内标记得以保留）
    return { k: m[1].trim(), v: t.parentElement.innerHTML }
  })
  first.remove()
  return { title, meta }
}

/**
 * 文档级渲染。
 *
 * @param {string} src markdown 源文
 * @param {{extractHeader?: boolean}} [opts] extractHeader=true 时摘出标题与抬头（方案页用；
 *   报告页保持 false，抬头留在正文里，避免内容被搬走而页面不展示）。
 * @returns {{html: string, title: string, meta: {k: string, v: string}[], outline: {id, level, no, text}[]}}
 */
export function renderDoc(src, opts) {
  const opt = opts || {}
  const md = String(src || '')
  const raw = renderMd(md)
  if (typeof DOMParser === 'undefined') {
    return { html: raw, title: '', meta: [], outline: [] }
  }
  const d = new DOMParser().parseFromString('<body>' + raw + '</body>', 'text/html')
  const root = d.body

  // 1) 表格：包横向滚动容器（CSS 无法给裸 table 套壳，只能在这里做）
  for (const t of [...root.querySelectorAll('table')]) {
    const wrap = d.createElement('div')
    wrap.className = 'md-table-wrap'
    t.replaceWith(wrap)
    wrap.appendChild(t)
  }

  // 2) 抬头（仅方案页需要）：先摘，标题不进目录（它由页面标题栏承担）
  let title = ''
  let meta = []
  if (opt.extractHeader) {
    const picked = pickHeader(root)
    title = picked.title
    meta = picked.meta
  }

  // 3) 标题：锚点 id + 序号拆分 + 目录
  const outline = []
  root.querySelectorAll('h1, h2, h3, h4').forEach((h, i) => {
    const id = 'md-h-' + i
    h.id = id
    let no = ''
    const t = firstTextNode(h)
    if (t) {
      const m = t.data.match(SEC_NO)
      if (m) {
        no = m[1]
        t.data = t.data.slice(m[0].length)   // 序号从文本里摘掉，改由金色标注承担
      }
    }
    const text = h.textContent.trim()
    if (no) {
      const span = d.createElement('span')
      span.className = 'md-sec-no'
      span.textContent = no
      h.insertBefore(span, h.firstChild)
    }
    outline.push({ id, level: Number(h.tagName.slice(1)), no, text })
  })

  return { html: root.innerHTML, title, meta, outline }
}
