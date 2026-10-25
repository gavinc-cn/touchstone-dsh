// 未翻译中文串扫描器（零依赖、可复现）：统计 webui/src 里「含汉字但没包在 t(...) 实参里」
// 的待翻译文案，供中英双语迁移做覆盖率棘轮守卫（T5–T7 每迁一批，基线只许下调）。
// 覆盖两类，均计入 unwrapped 总量，并分别给 literals / jsxText 计数（便于按类设棘轮）：
// - literal：字符串字面量（单引号 / 双引号 / 模板串）与 JSX 标签属性里的字符串；
// - jsx：JSX 正文文本节点（<span>保存</span> 里标签之间的文本）。
//
// 词法口径（单趟词法；注释 / 字符串 / JSX 正文分开识别，互不串味）：
// - 注释（行注释 // 与块注释 /* */）只在 JS 代码与 JSX 表达式里生效，替换为空格且保留
//   换行；字符串、模板串、JSX 正文里的 // 与 /* 都是普通字符（glob 不再吞正文）；
// - 模板串 `${...}` 表达式里的内容不算本串文本，表达式内部若还有字面量，按它自己的
//   位置单独判定；
// - 正则字面量只在「可以期待表达式」的位置识别并整段跳过：字符类里的 CJK 标点是解析
//   数据，不是文案；表达式位置 = 起点、return 等关键字之后、( , = : [ ! & | ? { } ;
//   之后与 => 之后；汉字等非 ASCII 字符之后一律不是正则（`是/否` 里的 / 是普通斜杠）；
// - 字面量内容至少含一个汉字（U+3400–4DBF / U+4E00–9FFF / U+F900–FAFF）才算；
//   单独的 CJK 标点（「、」「；」「：」）不计——它们是分隔符，包 t() 没有意义；
// - 向左跳过空白后紧邻 `t(` 即算已包装；`t` 必须是独立标识符，`notify(` / `format(` /
//   `obj.t(` 这类不算（否则「notify('已保存')」会被漏计）；
// - 跳过 __tests__/、*.test.js(x)、utils/i18n.js（它用中文当 key，本来就没有待翻译文案）
//   以及 IGNORE_PATHS（「中文是解析数据」的文件，Task 6 起按需收录）。
//
// jsx 判定口径（保守启发式）：
// - 词法器跟踪 JSX 标签/正文状态：标签之间的正文按文本处理（引号、//、/*、汉字后的 /
//   都不会触发注释/字符串/正则词法）；标签属性里的字符串照常按 literal 计；
// - 正文含 `{...}` 插值（如「保存 {n} 张」）、裸 > 或 } 时整段跳过（宁可漏计也不误报）；
// - 正文允许换行（多行 JSX 文本），行列取正文首个非空白字符。
//
// 已知限制：
// - `\uXXXX` / `\u{XXXX}` 转义写法的汉字不还原（本项目中文均直接书写，出现转义时需
//   人工确认）；
// - JSX 正文含 `{...}` 插值时整段跳过：插值两侧的中文片段（如「保存 {n} 张」的「保存」
//   与「张」）不计，需人工确认；
// - JSX/正则起点用「表达式位置」启发式而非完整语法分析：畸形 JSX、`}` 后紧跟 `<标识符`
//   的比较写法等边角情况可能漏计；
// - 不认 `i18n.t(` / `obj.t(` 与别名导入的 t，只认裸 `t(`。
//
// 导出：
// - scanSource(code)：纯函数，供单测与工具复用；
// - scanProject(rootDir)：递归扫描 rootDir（默认 webui/src），文件路径相对该目录；
// - scanWrappedKeys(code)：纯函数，提取 t('…') 字面量键（含标点/非汉字的键）；
// - scanProjectWrappedKeys(rootDir)：项目级 t('…') 字面量键全集（词表覆盖率守卫用）；
// - listSourceFiles(rootDir)：参与扫描的源文件清单（相对 posix 路径，棘轮自检用）；
// - SRC_DIR：CLI/scanProject 的默认扫描根（webui/src 的绝对路径，棘轮钉根用）；
// - IGNORE_PATHS：整文件排除清单（相对 webui/src 的 posix 路径）；
// - DOCUMENTED_EXCEPTIONS：文档化例外清单（文件 + 原文 + 理由，逐条精确匹配）；
// CLI 入口在本文件末尾：node webui/scripts/i18n-scan.mjs [--json]。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 扫描根：本文件位于 webui/scripts/，源码根是同级 ../src（与 cwd 无关，结果稳定）
// 导出供棘轮测试钉住「CLI 实际扫的就是 webui/src」——扫描根被收窄时测试必须失败。
export const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

// 「中文是解析数据而非文案」的文件清单：相对 webui/src 的 posix 路径，整文件排除。
// 口径（Task 6 起）：只收录**内容解析/协议**文件——CJK 只出现在注释、正则字符类或
// 协议常量里，不参与界面展示；含真实展示文案的文件不得整文件忽略（应 t() 迁移）。
// 逐个核对结论：
//   - utils/media.js     占位图检测：CJK 只在注释里（无待翻译文案）
//   - utils/mediaText.js 附件引用寻址：CJK 只在注释/正则里（无待翻译文案）
//   - utils/slashToken.js / 指令 token 探测：CJK 只在注释里（无待翻译文案）
//   - lib/dshHost.js     dsh 宿主桥协议：CJK 只在注释/协议说明里（无待翻译文案）
// 注：utils/pathLink.js 曾列在候选清单，但核对后其 CJK 是链接 title（真实展示文案），
// 已改为 t() 迁移而不是忽略；其余解析型 CJK 标点本来就不计入（扫描器跳过正则）。
export const IGNORE_PATHS = [
  'utils/media.js',
  'utils/mediaText.js',
  'utils/slashToken.js',
  'lib/dshHost.js',
]

// 文档化例外：**确属不该翻译**的文案，按（文件 + 原文）精确匹配，从计数里剔除并单独
// 汇报（JSON 的 exceptions 数组 + 人工输出末尾列出理由），不计入 unwrapped。
//
// 收录口径（很窄，评审时逐条核对）：
//   - 文案本身就要求保持原文，包 t() 反而会破坏语义；
//   - 能用 t() 表达的一律迁移，**不得**用本机制逃避扫描（它不是 IGNORE_PATHS 的替代品）。
// 匹配是精确的（同文件同原文），且同一条目必须真的命中——命中数会在 JSON 里体现，
// 棘轮测试断言例外清单逐条等于本常量，防止「悄悄多一个例外」或「例外失效后无人发现」。
export const DOCUMENTED_EXCEPTIONS = [
  {
    file: 'views/Settings.jsx',
    text: '中文',
    reason: '语言分区的语言自称：中文 / English 各以自己的语言显示，不随界面语言翻译（与 English 对称）',
  },
]

// 恒跳过：i18n 运行时自身（中文原文即 key）；测试目录/用例另有规则
const SELF_PATH = 'utils/i18n.js'
// 用例文件：*.test.js / *.test.jsx
const TEST_FILE_RE = /\.test\.(js|jsx)$/
// 待扫扩展名：只认 js/jsx（mjs/cjs 不参与）
const SOURCE_FILE_RE = /\.(js|jsx)$/
// 汉字：扩展 A + 基本区 + 兼容区（CJK 标点、全角标点不在此列）
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
// 正则字面量可以跟在这些关键字后面（return /re/），其余标识符/数字后面是除号
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
])
// 这些 ASCII 标点之后可以合法期待一个表达式，因而可能是正则或 JSX 的起点
const EXPR_START_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';'])
// 人工可读输出展示的文件数
const TOP_FILES = 20

// 标识符字符（含 $ 与数字）：用于「上一个显著字符」判定
function isIdChar(c) {
  return /[A-Za-z0-9_$]/.test(c)
}

// 单趟词法扫描：注释只在 JS 代码 / JSX 表达式里识别；字符串、模板串与 JSX 正文里的
// 引号、`//`、`/*` 都按普通字符处理。同时（a）把注释区替换成空格（保留换行与总长，
// 行号仍按原文算）、（b）收集字符串/模板字面量、（c）收集 JSX 正文文本节点。
// 返回 { stripped, literals, jsxTexts }。
// literals 每项：{ start, end, kind: 'str'|'tpl', content: 检测用文本, text: 展示用原文 }；
// jsxTexts 每项：{ start, text }（start = 正文首个非空白字符位置，text = 去掉首尾空白）。
function lex(code) {
  const n = code.length
  const out = code.split('')
  const literals = []
  const jsxTexts = []
  // 模板串帧：start=反引号位置，chunks=纯字面段落（不含 ${...} 表达式源码）
  const templates = []
  // 表达式帧（${...} 或 JSX 标签属性/正文里的 {...}）：depth=花括号深度，
  // returnState=闭合后要回到的状态（template / jsxTag / jsxText）
  const exprs = []
  // JSX 元素帧：depth=本区域内尚未闭合的元素数（自闭合元素不计）
  const jsxStack = []
  let state = 'code' // code | line | block | template | jsxTag | jsxText
  let prev = '' // 上一个显著字符（非空白）：判断 / 是正则还是除号
  let prevPos = -1 // 上一个显著字符的位置：判断 => 之后的表达式位置
  let prevWord = '' // 上一个标识符/数字整词：识别 return /re/ 这类关键字
  let tagPrev = '' // JSX 标签内上一个显著字符：识别自闭合 `/>`
  let textStart = 0 // 当前 JSX 正文区间起点
  let textSkip = false // 正文区间含插值或裸 >/} 时整段跳过（保守口径）
  let i = 0

  // 注释字符替换成空格（换行保留）
  const blank = (k) => {
    if (out[k] !== '\n') out[k] = ' '
  }

  // 读单/双引号字面量：同一行内没闭合就不算字面量（防 JSX 标签里的游离引号吞掉后续代码）
  function readQuoted(start, quote) {
    let j = start + 1
    let buf = ''
    while (j < n) {
      const c = code[j]
      if (c === '\n') return null
      if (c === '\\') {
        buf += c + (code[j + 1] ?? '')
        j += 2
        continue
      }
      if (c === quote) return { start, end: j, kind: 'str', content: buf, text: buf }
      buf += c
      j++
    }
    return null
  }

  // 正则字面量结束位置：同一行内找未转义、不在字符类里的 /；找不到返回 -1（按除号处理）
  function regexEnd(start) {
    let j = start + 1
    let inClass = false
    while (j < n) {
      const c = code[j]
      if (c === '\n') return -1
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) return j
      j++
    }
    return -1
  }

  // 是否处在「可以合法期待一个表达式」的位置：只有这里才可能开始正则或 JSX。
  // 允许位置 = 起点 / 表达式关键字之后 / ( , = : [ ! & | ? { } ; 之后 / => 之后；
  // 汉字等非 ASCII 字符之后一律不是（`是/否` 里的 / 是普通斜杠，不是正则）。
  function exprStart() {
    if (!prev) return true
    if (isIdChar(prev)) return REGEX_KEYWORDS.has(prevWord)
    if (prev.charCodeAt(0) > 0x7f) return false
    // 箭头函数 => 之后可以是正则/JSX；比较运算 > 之后按除号
    if (prev === '>') return prevPos > 0 && code[prevPos - 1] === '='
    return EXPR_START_PUNCT.has(prev)
  }

  // 进入 JSX 正文：标签 `>` 之后从 from 开始算一个新的正文区间
  function enterText(from) {
    state = 'jsxText'
    textStart = from
    textSkip = false
  }

  // 收尾一个 JSX 正文区间：没被插值/裸 >/} 打断且含汉字才记一条
  function flushText(end) {
    if (textSkip) return
    const raw = code.slice(textStart, end)
    if (!HAN_RE.test(raw)) return
    let k = textStart
    while (k < end && /\s/.test(code[k])) k++
    jsxTexts.push({ start: k, text: raw.trim() })
  }

  while (i < n) {
    const c = code[i]
    const d = code[i + 1]

    if (state === 'code') {
      // 注释：// 到行尾，/* */ 到闭合（注释内容一律清空，prev 不变）。
      // 调用点保证只有 JS 代码/表达式会走到这里，字符串/模板/JSX 正文不走本分支。
      if (c === '/' && d === '/') {
        blank(i)
        blank(i + 1)
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && d === '*') {
        blank(i)
        blank(i + 1)
        state = 'block'
        i += 2
        continue
      }
      // JSX 起点：只在表达式位置，且 < 后是标签名或片段结束符 >
      if (c === '<' && exprStart()) {
        const nx = code[i + 1]
        if (nx === '>' || (nx !== undefined && /[A-Za-z_$]/.test(nx))) {
          jsxStack.push({ depth: 0 })
          state = 'jsxTag'
          tagPrev = ''
          i++
          continue
        }
      }
      // 正则字面量：整段跳过（内容不是字符串字面量）
      if (c === '/' && exprStart()) {
        const end = regexEnd(i)
        if (end > 0) {
          i = end + 1
          while (i < n && isIdChar(code[i])) i++ // flags（gimsuy）
          prev = '/'
          prevPos = i - 1
          prevWord = ''
          continue
        }
      }
      // 引号串：一次读完（跨行非法，遇到换行即放弃）
      if (c === "'" || c === '"') {
        const lit = readQuoted(i, c)
        if (lit) {
          literals.push(lit)
          i = lit.end + 1
          prev = c
          prevPos = lit.end
          prevWord = ''
          continue
        }
        i++
        continue
      }
      // 模板串开头：压帧，进入模板字面段落状态
      if (c === '`') {
        templates.push({ start: i, chunks: '' })
        state = 'template'
        i++
        continue
      }
      // 表达式花括号（${...} / JSX {...}）：只数深度，归零即回到外层状态
      if (c === '{' && exprs.length) {
        exprs[exprs.length - 1].depth++
        prev = '{'
        prevPos = i
        prevWord = ''
        i++
        continue
      }
      if (c === '}' && exprs.length) {
        const frame = exprs[exprs.length - 1]
        frame.depth--
        if (frame.depth === 0) {
          exprs.pop()
          // 回到 JSX 正文时恢复该正文区间（插值可能内嵌 JSX，不能沿用内层的正文起点）
          if (frame.returnState === 'jsxText') {
            textStart = frame.textStart
            textSkip = frame.textSkip
          }
          state = frame.returnState
          prev = '}'
          prevPos = i
          prevWord = ''
          i++
          continue
        }
        prev = '}'
        prevPos = i
        prevWord = ''
        i++
        continue
      }
      // 标识符/数字整词：记录整词供关键字判定（exprStart）
      if (isIdChar(c)) {
        let j = i + 1
        while (j < n && isIdChar(code[j])) j++
        prevWord = code.slice(i, j)
        prev = code[j - 1]
        prevPos = j - 1
        i = j
        continue
      }
      if (!/\s/.test(c)) {
        prev = c
        prevPos = i
        prevWord = ''
      }
      i++
      continue
    }

    if (state === 'line') {
      if (c === '\n') state = 'code'
      else blank(i)
      i++
      continue
    }

    if (state === 'block') {
      if (c === '*' && d === '/') {
        blank(i)
        blank(i + 1)
        state = 'code'
        i += 2
        continue
      }
      blank(i)
      i++
      continue
    }

    // 模板字面段落：内容进本串；遇到 ${ 切表达式；遇到反引号收串
    if (state === 'template') {
      const frame = templates[templates.length - 1]
      if (c === '\\') {
        frame.chunks += code.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        templates.pop()
        literals.push({
          start: frame.start,
          end: i,
          kind: 'tpl',
          content: frame.chunks,
          text: code.slice(frame.start + 1, i),
        })
        state = 'code'
        prev = '`'
        prevPos = i
        prevWord = ''
        i++
        continue
      }
      if (c === '$' && d === '{') {
        exprs.push({ depth: 1, returnState: 'template' })
        state = 'code'
        prev = '{'
        prevPos = i + 1
        prevWord = ''
        i += 2
        continue
      }
      frame.chunks += c
      i++
      continue
    }

    // JSX 标签内部：属性字符串仍按 literal 收集（<span title="保存"> 要计一次），
    // 属性表达式 {...} 进入 JS 代码，`>` 结束标签（tagPrev 为 / 即自闭合）
    if (state === 'jsxTag') {
      if (c === "'" || c === '"') {
        const lit = readQuoted(i, c)
        if (lit) {
          literals.push(lit)
          i = lit.end + 1
          tagPrev = c
          continue
        }
        i++
        continue
      }
      if (c === '{') {
        exprs.push({ depth: 1, returnState: 'jsxTag' })
        state = 'code'
        prev = '{'
        prevPos = i
        prevWord = ''
        i++
        continue
      }
      if (c === '>') {
        const region = jsxStack[jsxStack.length - 1]
        if (tagPrev === '/') {
          // 自闭合：根元素结束后回代码；嵌套元素结束后回父正文
          if (region.depth === 0) {
            jsxStack.pop()
            state = 'code'
            prev = '>'
            prevPos = i
            prevWord = ''
          } else {
            enterText(i + 1)
          }
        } else {
          region.depth++
          enterText(i + 1)
        }
        i++
        continue
      }
      if (!/\s/.test(c)) tagPrev = c
      i++
      continue
    }

    // JSX 正文：引号、`//`、`/*`、汉字后的 `/` 都是正文，不进入注释/字符串/正则词法
    if (state === 'jsxText') {
      if (c === '<') {
        if (d === '/') {
          // 闭合标签：先收尾正文，再扫到 >（闭合标签不含属性）
          flushText(i)
          let j = i + 2
          while (j < n && code[j] !== '>') j++
          if (j >= n) {
            i = n
            continue
          }
          const region = jsxStack[jsxStack.length - 1]
          region.depth--
          if (region.depth === 0) {
            jsxStack.pop()
            state = 'code'
            prev = '>'
            prevPos = j
            prevWord = ''
          } else {
            enterText(j + 1)
          }
          i = j + 1
          continue
        }
        // 开标签（含片段 <>）：正文到此为止
        flushText(i)
        state = 'jsxTag'
        tagPrev = ''
        i++
        continue
      }
      // 正文里的 {...} 插值：本段正文整段跳过（保守口径），表达式内部仍正常词法扫描
      if (c === '{') {
        textSkip = true
        // 保存当前正文区间：表达式内若再嵌 JSX，返回后仍要按同一区间收尾
        exprs.push({ depth: 1, returnState: 'jsxText', textStart, textSkip })
        state = 'code'
        prev = '{'
        prevPos = i
        prevWord = ''
        i++
        continue
      }
      // 裸 > / } 在 JSX 正文里非法，按保守口径整段跳过
      if (c === '>' || c === '}') textSkip = true
      i++
      continue
    }

    // 不可达：state 只在上面六种取值
    i++
  }

  return { stripped: out.join(''), literals, jsxTexts }
}

// 字面量是否落在 t(...) 实参位置：向左跳过空白（注释已替换成空格）后紧邻 `t(`，
// 且 t 是独立标识符（notify(/format(/obj.t( 都不算）
function isWrapped(text, pos) {
  let k = pos - 1
  while (k >= 0 && /\s/.test(text[k])) k--
  if (k < 1 || text[k] !== '(') return false
  let t = k - 1
  while (t >= 0 && /\s/.test(text[t])) t--
  if (t < 0 || text[t] !== 't') return false
  const b = t - 1
  if (b < 0) return true
  return text[b] !== '.' && !isIdChar(text[b])
}

// 字面量是否是 t(...) 的**完整**键实参：闭合引号后跳过空白，只允许紧邻 `)` 或 `,`。
// 这样 t('a' + b) 这类动态拼接（键不是单一字面量）会被跳过，避免把半截串当词条。
function isWholeKeyArg(text, end) {
  let k = end + 1
  while (k < text.length && /\s/.test(text[k])) k++
  return text[k] === ')' || text[k] === ','
}

// 还原 JS 单/双引号字符串的转义序列：词表 key 里存的是真实字符（如换行），而词法层
// 保留的是源码原文（如 `\n` 两个字符），比对前必须按 JS 字符串语义解码。
// 只覆盖本项目会用到的形态；未知转义按 JS 语义退化为字符本身（`\q` → `q`）。
function decodeStringEscapes(text) {
  const s = String(text ?? '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') { out += c; continue }
    const d = s[i + 1]
    if (d === undefined) { out += '\\'; break }
    switch (d) {
      case 'n': out += '\n'; i++; break
      case 'r': out += '\r'; i++; break
      case 't': out += '\t'; i++; break
      case 'b': out += '\b'; i++; break
      case 'f': out += '\f'; i++; break
      case 'v': out += '\v'; i++; break
      case '0': out += '\0'; i++; break
      case 'x': {
        const hex = s.slice(i + 2, i + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 3 }
        else { out += 'x'; i++ }
        break
      }
      case 'u': {
        if (s[i + 2] === '{') {
          const close = s.indexOf('}', i + 3)
          const hex = close > 0 ? s.slice(i + 3, close) : ''
          if (/^[0-9a-fA-F]{1,6}$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i = close }
          else { out += 'u'; i++ }
        } else {
          const hex = s.slice(i + 2, i + 6)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5 }
          else { out += 'u'; i++ }
        }
        break
      }
      // 续行：反斜杠 + 换行整体消失（\r\n 与 \n 两种都认）
      case '\n': i++; break
      case '\r': i += s[i + 2] === '\n' ? 2 : 1; break
      default: out += d; i++
    }
  }
  return out
}

// 行首偏移表：按原文（等长）建，供二进制查找行号
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

// 位置 → 1 基行号（二分）
function lineAt(starts, pos) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// 位置 → 1 基行列（行号二分，列号 = 位置 − 行首 + 1）
function locAt(starts, pos) {
  const line = lineAt(starts, pos)
  return { line, column: pos - starts[line - 1] + 1 }
}

// 扫描一段源码：返回 { wrapped: 已包装字面量文本[], unwrapped: [{line, column, text, kind}] }
// kind='literal' 为字符串字面量，kind='jsx' 为 JSX 正文文本节点；按 (line, column) 升序输出。
// 纯函数（不读文件、不依赖环境），单测直接喂源码字符串
export function scanSource(code) {
  const src = String(code ?? '')
  const { stripped, literals, jsxTexts } = lex(src)
  const starts = lineStarts(stripped)
  const wrapped = []
  const entries = []
  for (const lit of literals) {
    if (!HAN_RE.test(lit.content)) continue
    if (isWrapped(stripped, lit.start)) {
      wrapped.push(lit.text)
      continue
    }
    entries.push({ start: lit.start, text: lit.text, kind: 'literal' })
  }
  for (const hit of jsxTexts) {
    entries.push({ start: hit.start, text: hit.text, kind: 'jsx' })
  }
  // 按源码位置排序（等价于 line、column 升序）；同位置用 kind 兜底，保证输出确定
  entries.sort((a, b) => a.start - b.start || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  const unwrapped = entries.map((e) => ({ ...locAt(starts, e.start), text: e.text, kind: e.kind }))
  return { wrapped, unwrapped }
}

// 扫描一段源码里「已包装」的 t('…') 字面量键：不要求含汉字（标点键、纯符号键也收），
// 也不改变 scanSource 的既有口径（unwrapped / literals / jsxText 计数完全不受影响）。
// 返回 [{key, line, column}]，按源码位置升序；键已做 JS 转义还原（见 decodeStringEscapes）。
// 跳过：模板串（含 ${...}，无法静态比对）、t('a' + b) 动态拼接、空串。
export function scanWrappedKeys(code) {
  const src = String(code ?? '')
  const { stripped, literals } = lex(src)
  const starts = lineStarts(stripped)
  const out = []
  for (const lit of literals) {
    if (lit.kind !== 'str') continue
    if (!isWrapped(stripped, lit.start)) continue
    if (!isWholeKeyArg(stripped, lit.end)) continue
    const key = decodeStringEscapes(lit.content)
    if (!key) continue
    out.push({ key, ...locAt(starts, lit.start) })
  }
  return out
}

// 递归列出待扫文件（相对 rootDir 的 posix 路径）：目录/文件按码点序，保证输出确定。
// 导出供棘轮测试自检「扫描器是否真的扫到了文件」（防止清单意外变空导致的假绿）。
export function listSourceFiles(rootDir) {
  const rels = []
  // 深度优先遍历目录：目录/文件按码点序递归，跳过用例目录与排除清单
  const walk = (absDir, relDir) => {
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        // 用例目录整树跳过
        if (e.name === '__tests__') continue
        walk(path.join(absDir, e.name), rel)
        continue
      }
      if (!e.isFile()) continue
      if (!SOURCE_FILE_RE.test(e.name) || TEST_FILE_RE.test(e.name)) continue
      if (rel === SELF_PATH || IGNORE_PATHS.includes(rel)) continue
      rels.push(rel)
    }
  }
  walk(rootDir, '')
  return rels
}

// 扫描项目：rootDir 默认 webui/src；返回 { unwrapped, literals, jsxText, files }
// files 每项 {file, line, column, text, kind}；unwrapped = literals + jsxText。
// files 顺序 = 文件名码点序 + (line, column) 升序（多行模板/JSX 正文也按起始位置稳定排序）
export function scanProject(rootDir = SRC_DIR) {
  const root = path.resolve(rootDir)
  const files = []
  for (const rel of listSourceFiles(root)) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const item of scanSource(code).unwrapped) {
      files.push({ file: rel, ...item })
    }
  }
  // 显式按 (file, line, column, kind) 排序：让上面的顺序声明由代码保证，而非遍历巧合
  files.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
  })
  // 文档化例外：按（文件 + 原文）精确剔除并单列（附理由），不参与 unwrapped/分项计数。
  // 匹配不到的条目不会出现在 exceptions 里——棘轮测试会据此发现「例外失效/悄悄新增」。
  const exceptions = []
  const kept = []
  for (const f of files) {
    const hit = DOCUMENTED_EXCEPTIONS.find((e) => e.file === f.file && e.text === f.text)
    if (hit) exceptions.push({ ...f, reason: hit.reason })
    else kept.push(f)
  }
  const literals = kept.filter((f) => f.kind === 'literal').length
  const jsxText = kept.length - literals
  return { unwrapped: kept.length, literals, jsxText, exceptions, files: kept }
}

// 扫描项目内全部 t('…') 字面量键：与 scanProject 共用同一份文件清单/跳过规则
// （__tests__、*.test.js(x)、utils/i18n.js、IGNORE_PATHS）。返回
// [{file, line, column, key}]，按 (file, line, column, key) 排序；供词表覆盖率守卫
// 逐键核对 i18n/en.json（含标点键——旧扫描器只数含汉字的串，看不到它们）。
export function scanProjectWrappedKeys(rootDir = SRC_DIR) {
  const root = path.resolve(rootDir)
  const out = []
  for (const rel of listSourceFiles(root)) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const item of scanWrappedKeys(code)) out.push({ file: rel, ...item })
  }
  out.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  return out
}

// 人工可读输出：总数 + 两种口径的分项 + 按文件 top 20（其余文件汇总一行）
function formatHuman(result) {
  const per = new Map()
  for (const f of result.files) per.set(f.file, (per.get(f.file) || 0) + 1)
  const rows = [...per.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )
  const top = rows.slice(0, TOP_FILES)
  const lines = [
    `未包装中文串: ${result.unwrapped} 处 / ${rows.length} 个文件` +
      `（字符串字面量 ${result.literals} + JSX 正文 ${result.jsxText}；路径相对 webui/src）`,
  ]
  if (rows.length > 0) {
    lines.push(`按文件 top ${Math.min(TOP_FILES, rows.length)}:`)
    lines.push(...top.map(([file, n]) => `  ${String(n).padStart(4)}  ${file}`))
    if (rows.length > top.length) {
      const rest = rows.slice(top.length).reduce((sum, r) => sum + r[1], 0)
      lines.push(`  其余 ${rows.length - top.length} 个文件共 ${rest} 处`)
    }
  }
  // 文档化例外单列（不计入上面的未翻译数），逐条给出原文与理由，便于评审
  if (result.exceptions.length) {
    lines.push(`文档化例外: ${result.exceptions.length} 处（不计入未翻译）:`)
    lines.push(...result.exceptions.map((e) =>
      `  ${e.file}:${e.line} ${JSON.stringify(e.text)} — ${e.reason}`))
  }
  lines.push('机器可读输出: --json')
  return lines.join('\n')
}

const USAGE = `用法: node webui/scripts/i18n-scan.mjs [--json]

扫描 webui/src 下未包在 t(...) 实参里的中文串：字符串字面量（literal）与
JSX 正文文本节点（jsx，含 {...} 插值的区间按保守口径跳过）。注释、正则、用例不计。
文档化例外（DOCUMENTED_EXCEPTIONS，逐条精确匹配）不计入计数，另列 exceptions。
  --json    输出 {"unwrapped": <number>, "literals": <number>, "jsxText": <number>,
                  "exceptions": [{file, line, column, text, kind, reason}...],
                  "files": [{file, line, column, text, kind}...]}
  -h,--help 显示本帮助
`

// CLI 入口：仅当被 node 直接执行时跑（被 import 时只导出函数，单测据此复用）
function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }
  const unknown = argv.filter((a) => a !== '--json')
  if (unknown.length) {
    process.stderr.write(`未知参数: ${unknown.join(' ')}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  const result = scanProject(SRC_DIR)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatHuman(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
