/**
 * board_media 图片引用扫描（纯函数，无 I/O；2026-10-29）。
 *
 * 背景：飞书截图接收（`feishu_conv.route_text`）与站点会话窗附件（`SessionView`
 * 的 `uploadFiles`）都把图片写成**markdown 绝对路径**投递给会话，例如
 * `![飞书截图1.jpg](/opt/win/.../board_media/m1793262707125_ad0361f890.jpg)`。
 * TS 面板会把这段 markdown 改写成平台媒体 URL 再渲染，但 DSH 的用户气泡是纯文本
 * 渲染（`white-space: pre-wrap`），只认会话里的**原生 image 块** ⇒ 那边只剩链接。
 *
 * 本模块只回答「文本里哪些引用是平台自己的 board_media 位图、删掉它们之后正文
 * 长什么样」；读写文件、调附件服务、判断模型能力一律留给调用方（agent-driver）。
 *
 * 识别口径刻意保守（宁可不转，不误伤）：
 *   1. 只认 markdown 图片 `![alt](target)`，target 必须是**绝对路径**
 *      （POSIX `/`、Windows `C:\`、UNC `\\server`），URL/相对路径一律不动；
 *   2. target 必须含 `board_media/`（或 `\board_media\`）**路径段**；
 *   3. 文件名必须是平台 fid 形态 `m<13 位毫秒>_<10 位 hex>.<png|jpg|jpeg|gif|webp>`
 *      （与站点上传/飞书存图同一表达式；agent 自己写进 board_media 的任意名图片不转）；
 *   4. 围栏代码块与行内代码里的引用**不转**（那是用户贴的代码示例）；
 *   5. 同一路径重复出现只产出一张图（占位仍从正文删除）。
 *
 * 「全有或全无」：超过 `maxImages` 时返回 `images: []` + `reason:'overflow'`，
 * 调用方据此保持原文（绝不产出半截消息——一部分图变附件、一部分留 markdown）。
 */

/** 单条消息默认最多转几张（与宿主 attachments 的 maxImagesPerMessage 缺省同值） */
export const BOARD_MEDIA_MAX_IMAGES = 20

/** 平台附件文件名（与 server 上传 / 飞书存图同一表达式：m<13 位毫秒>_<10 位小写 hex>.<ext>） */
const FID_BASENAME_RE = /^m\d{13}_[0-9a-f]{10}\.(?:png|jpe?g|gif|webp)$/i
/** 路径段 board_media（两侧都接受 `/` 与 `\`，Windows 主机同样成立） */
const BOARD_MEDIA_SEG_RE = /[\\/]board_media[\\/]/i
/** 围栏：行首最多 3 空格，三反引号或三波浪号起（含 info string） */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/
/** markdown 图片：alt 不含换行/右方括号；target 允许尖括号包裹，止于右括号或换行 */
const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\n]+?)>?\s*\)/g
/** 绝对路径三形态（与主机平台解耦：测试在 Linux 上也要能识别 Windows 路径） */
const POSIX_ABS_RE = /^\//
const WIN_DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/
const UNC_ABS_RE = /^\\\\/
/** 任意 URL scheme（http:、file:、data: …）——除 Windows 盘符外一律不认 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * 是否「平台的 board_media 位图绝对路径」。
 *
 * @param {unknown} target - markdown 圆括号里的目标（可带尖括号）
 * @returns {boolean} 是则 true（只做形态判断，文件是否存在/是否真图由调用方查）
 */
export function isBoardMediaImageRef(target) {
  const t = String(target == null ? '' : target).trim()
  if (!t) return false
  const isDrive = WIN_DRIVE_ABS_RE.test(t)
  if (!isDrive && SCHEME_RE.test(t)) return false
  const isAbs = isDrive || POSIX_ABS_RE.test(t) || UNC_ABS_RE.test(t)
  if (!isAbs) return false
  if (!BOARD_MEDIA_SEG_RE.test(t)) return false
  return FID_BASENAME_RE.test(baseNameOf(t))
}

/** 平台路径的末段文件名（同时切 `/` 与 `\`，不在 Windows 上也能用）。 */
function baseNameOf(target) {
  const parts = String(target || '').split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/**
 * 把一行里的行内代码（成对反引号）替换成等长空格——让后续匹配看不见代码里的
 * 引用，同时**保持下标不变**（原文切片仍按同一位置取）。
 *
 * 未闭合的反引号按普通字符处理（CommonMark 同口径：只认成对）。
 *
 * @param {string} line - 单行原文
 * @returns {string} 等长的「可见文本」（行内代码处为空格）
 */
function maskInlineCode(line) {
  if (!line.includes('`')) return line
  const chars = line.split('')
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') { i += 1; continue }
    let n = 1
    while (line[i + n] === '`') n += 1
    const ticks = '`'.repeat(n)
    const close = line.indexOf(ticks, i + n)
    if (close < 0) { i += n; continue }   // 未闭合：原样保留
    for (let k = i; k < close + n; k += 1) chars[k] = ' '
    i = close + n
  }
  return chars.join('')
}

/**
 * 一行里去掉若干 [start,end) 区间（从后往前删，下标不串位），再收掉残留双空格。
 *
 * @param {string} line - 原文
 * @param {{start:number,end:number}[]} spans - 要删除的区间（同一行内，可乱序）
 * @returns {string} 清理后的行（行尾空白去掉）
 */
function stripSpans(line, spans) {
  let out = line
  const sorted = [...spans].sort((a, b) => b.start - a.start)
  for (const s of sorted) out = out.slice(0, s.start) + out.slice(s.end)
  // 行首缩进原样保留（列表/缩进语义），只收行内「被删引用留下的」连续空白；
  // 中文正文没有空格，收成 1 个不会改变语义
  const lead = (/^[ \t]*/.exec(out) || [''])[0]
  return lead + out.slice(lead.length).replace(/[ \t]{2,}/g, ' ').trimEnd()
}

/**
 * 扫描消息文本里的平台图片引用。
 *
 * @param {string} text - 平台投递的原始消息文本
 * @param {number} [maxImages] - 单条最多几张（非法值回落 {@link BOARD_MEDIA_MAX_IMAGES}）
 * @returns {{kept: string, images: {path: string, name: string}[], reason: 'ok'|'none'|'overflow'}}
 *   - `images` 按首次出现顺序；`path` 为原文路径（不做规范化，交给调用方读盘）；
 *   - `name` 取 alt（空则文件末段）；
 *   - `kept` 为删掉这些引用后的正文（无引用时**逐字等于**入参）；
 *   - `reason='overflow'` 时 `images` 恒为空、`kept` 恒为原文（全有或全无）。
 */
export function scanBoardMediaImages(text, maxImages = BOARD_MEDIA_MAX_IMAGES) {
  const src = typeof text === 'string' ? text : ''
  if (!src || !/board_media/i.test(src)) return { kept: src, images: [], reason: 'none' }

  const limit = Number.isFinite(maxImages) && maxImages > 0
    ? Math.floor(maxImages) : BOARD_MEDIA_MAX_IMAGES
  const lines = src.split('\n')
  /** @type {{line:number,start:number,end:number,path:string,name:string}[]} */
  const refs = []
  let fence = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fm = FENCE_RE.exec(line)
    if (fm) {
      const marker = fm[1]
      const trailing = line.slice(fm[0].length)
      if (fence === null) {
        fence = marker                       // 开围栏（可带 info string）
      } else if (marker[0] === fence[0] && marker.length >= fence.length
                 && /^[ \t]*$/.test(trailing)) {
        fence = null                         // 闭围栏只能有空白（CommonMark）
      }
      continue
    }
    if (fence !== null) continue

    const masked = maskInlineCode(line)
    IMAGE_RE.lastIndex = 0
    let m
    while ((m = IMAGE_RE.exec(masked)) !== null) {
      const target = String(m[2] || '').trim()
      if (!isBoardMediaImageRef(target)) continue
      refs.push({
        line: i,
        start: m.index,
        end: m.index + m[0].length,
        path: target,
        name: (String(m[1] || '').trim()) || baseNameOf(target),
      })
    }
  }

  if (refs.length === 0) return { kept: src, images: [], reason: 'none' }

  // 去重（按路径首次出现），超限整体放弃
  const seen = new Set()
  const images = []
  for (const r of refs) {
    if (seen.has(r.path)) continue
    seen.add(r.path)
    images.push({ path: r.path, name: r.name })
  }
  if (images.length > limit) {
    return { kept: src, images: [], reason: 'overflow' }
  }

  const byLine = new Map()
  for (const r of refs) {
    if (!byLine.has(r.line)) byLine.set(r.line, [])
    byLine.get(r.line).push({ start: r.start, end: r.end })
  }
  const outLines = lines.map((line, i) => (
    byLine.has(i) ? stripSpans(line, byLine.get(i)) : line
  ))
  // 只去首尾空行与尾部空白；**首行缩进保留**（缩进列表/代码块的语义）
  const kept = outLines.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
  return { kept, images, reason: 'ok' }
}
