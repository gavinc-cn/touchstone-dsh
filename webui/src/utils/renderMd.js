// 轻量 markdown 渲染(无外部依赖)
// 支持: 代码围栏/表格/标题/水平线/无序列表/引用/行内 code/bold/链接/图片
// opts.pathLinks(可选): 把正文里的文件路径渲染成可点链接(md-path), 见 utils/pathLink.js
import { linkifyPaths } from './pathLink'

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// URL 白名单：仅允许相对路径(/开头)、http(s)/mailto/tel/data 协议，防 javascript: 等注入
function safeUrl(u) {
  const x = String(u || '').trim()
  return /^(\/|https?:\/\/|mailto:|tel:|data:image\/)/i.test(x) ? x : ''
}

function mdInline(s, opt) {
  const pathLinks = !!(opt && opt.pathLinks)
  let x = esc(s)
  const codes = []
  const marks = []   // 既有 markdown 链接/图片：先摘出，避免路径正则误伤其中的 URL/链接文本
  x = x.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
  if (pathLinks) x = x.replace(/!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/g,
    (m) => { marks.push(m); return '\u0001' + (marks.length - 1) + '\u0001' })
  x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  // 路径链接化（在链接/图片还原之前：URL 与 HTML 属性不会被误伤）
  if (pathLinks) x = linkifyPaths(x)
  if (marks.length) x = x.replace(/\u0001(\d+)\u0001/g, (m, i) => marks[+i])
  // 图片 ![](url) / 链接 [text](url)（URL 白名单过滤；空 URL 原样文本）
  x = x.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, alt, url) => { const u = safeUrl(url); return u ? `<img class="md-img" src="${u}" alt="${esc(alt)}" loading="lazy">` : esc(m) })
  x = x.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, text, url) => { const u = safeUrl(url); return u ? `<a href="${u}" target="_blank" rel="noreferrer">${text}</a>` : esc(m) })
  // 内联 code 还原（开启 pathLinks 时, code 内容额外识别裸文件名）
  x = x.replace(/\u0000(\d+)\u0000/g, (m, i) =>
    '<code>' + (pathLinks ? linkifyPaths(codes[+i], { bare: true }) : codes[+i]) + '</code>')
  return x
}

const mdTableRow = (s) => String(s).trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

export function renderMd(src, opts) {
  const opt = opts || {}
  const lines = String(src || '').split('\n')
  let html = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      // 代码块保持原样（不做路径链接化：块内多命令/粘贴内容，链接化收益低噪声高）
      html += '<pre><code>' + buf.map((l) => mdInline(l)).join('\n') + '</code></pre>'
      continue
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      const head = mdTableRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(mdTableRow(lines[i])); i++ }
      html += '<table><thead><tr>' + head.map((c) => '<th>' + mdInline(c, opt) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c, opt) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
      continue
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/)
    if (hm) { html += '<h' + hm[1].length + '>' + mdInline(hm[2], opt) + '</h' + hm[1].length + '>'; i++; continue }
    if (/^\s*(?:---|\*\*\*)\s*$/.test(line)) { html += '<hr>'; i++; continue }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(mdInline(lines[i].replace(/^\s*[-*]\s+/, ''), opt)); i++ }
      html += '<ul>' + items.map((x) => '<li>' + x + '</li>').join('') + '</ul>'
      continue
    }
    // 有序列表：`1. xxx` / `1) xxx`（压测方案的「图表设计」「复现步骤」大量使用）。
    // 只认「1~2 位数字 + . 或 ) + 至少一个空格」：`1.5 BTC`、`2026. 10` 这类句子不会被误吞。
    if (/^\s*\d{1,2}[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d{1,2}[.)]\s+/.test(lines[i])) {
        items.push(mdInline(lines[i].replace(/^\s*\d{1,2}[.)]\s+/, ''), opt))
        i++
      }
      html += '<ol>' + items.map((x) => '<li>' + x + '</li>').join('') + '</ol>'
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      html += '<blockquote>' + buf.map((x) => '<p>' + mdInline(x, opt) + '</p>').join('') + '</blockquote>'
      continue
    }
    if (line.trim() === '') { i++; continue }
    html += '<p>' + mdInline(line, opt) + '</p>'
    i++
  }
  return html
}

export function fmtTime(s) { return s || '—' }

export const ST_LABEL = {
  queued: '排队中', running: '运行中', done: '已完成',
  stopped: '已停止', failed: '失败', interrupted: '中断',
}

