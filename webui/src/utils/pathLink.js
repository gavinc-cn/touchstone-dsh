// 会话正文里的文件路径识别：把 agent 回答中出现的路径渲染成可点链接（点击弹出预览）
// 背景：回答里常写「已更新 doc_ai/spec/foo.md」，用户希望直接点开看内容。
// 取舍：宁可漏识别不可误伤——误判会产出打不开的链接（点击报错），漏识别只是维持纯文本。
//
// 形态规则：
// - token = 空白分隔的一段文本；HTML 标记字符（< > "）先把 token 切断，故
//   `<b>doc_ai/x.md</b>` 里的路径仍能被单独识别
// - 剥掉包裹标点（引号/括号/反引号/句末标点）后再校验，剥掉的部分原样回填
// - 末段须像文件名「名字.扩展名」，扩展名以字母开头（挡掉 1.2 / v1.2.3 这类版本号）
// - 正文模式：必须含目录分隔符 / \ 或盘符开头——裸文件名在正文里噪声太多
//   （Node.js、sys.path、React.js），只在引号/反引号包裹的场景（bare 模式）才认
// - bare 模式（内联 code）：额外认裸文件名，但扩展名须在 KNOWN_EXT 白名单内，
//   否则 `sys.path`、`os.environ` 这类属性访问会被误判成文件
// 不处理：URL(://)、目录（以 / 结尾）、通配符与 shell 语法 token
//
// 输出：`<a class="md-path" data-path="…" title="点击预览：…">原文</a>`
// （token 已排除引号与尖括号，属性值无需再转义；路径里的 &amp; 等实体浏览器会解码）

// 一段非空白文本；排除 HTML 标记字符、控制占位符（renderMd 用 \u0000/\u0001 占位）
// 与中日文标点——中文正文里路径常紧跟「，」「（」等且不加空格，必须在这里切开
const TOKEN_RE = /[^\s\u0000\u0001<>"，。、；：！？（）〔〕【】「」『』《》〈〉…—～·“”‘’]+/g
// 首尾包裹标点（括号/引号/反引号/句末标点），剥掉后原样回填
const LEAD_RE = /^[([{`'*“「『【（〔〈《]+/
// 尾随标点 + 「:行号[:列号]」后缀（agent 常写 file.md:42 / file.md:12:3），同样回填
const TAIL_RE = /(?::\d+(?::\d+)?|[)\]}`'*.,;:!?。，、；：！？…’”」』）】〕〉》])+$/
// 通配符/shell 语法/赋值等噪声字符（反斜杠是 Windows 分隔符、分号可能是 HTML 实体
// `&amp;` 的一部分，均不在此列）
const BAD_RE = /[()[\]{}*?=,!#$%^|`]/
// 末段文件名：名字.扩展名（扩展名以字母开头、总长 ≤10）
const SEG_RE = /^[^/\\\s]*\.[A-Za-z][A-Za-z0-9]{0,9}$/
// bare 模式的已知文件扩展名白名单（文档/代码/配置/数据/媒体）
const KNOWN_EXT = new Set([
  'md', 'markdown', 'txt', 'rst', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css',
  'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'sql', 'go', 'rs', 'java', 'kt',
  'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'lua', 'pl', 'r', 'jl',
  'lock', 'patch', 'diff', 'ipynb', 'pdf', 'zip', 'tar', 'gz', 'tgz', '7z',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'mp4', 'mov', 'mp3',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'db', 'sqlite', 'wasm', 'map',
])

/** 末段扩展名（小写，不含点）；无点返回空串 */
function extOf(seg) {
  return seg.slice(seg.lastIndexOf('.') + 1).toLowerCase()
}

/** core 是否为可识别文件路径（正文模式；bare=引号内模式，允许裸文件名走白名单） */
function isFilePath(core, bare) {
  if (!core || core.indexOf('://') >= 0) return false
  if (BAD_RE.test(core)) return false
  const seg = core.split(/[/\\]/).pop()
  if (!SEG_RE.test(seg)) return false
  const hasSep = /[/\\]/.test(core)
  if (hasSep) return true
  if (/^[A-Za-z]:/.test(core)) return true               // 盘符相对路径 C:x.md（少见但合法）
  return bare && KNOWN_EXT.has(extOf(seg))               // 裸文件名：仅 bare 模式 + 白名单
}

/** 生成路径链接标记（data-path 供点击时取原始路径） */
function anchor(p) {
  return `<a class="md-path" data-path="${p}" title="点击预览：${p}">${p}</a>`
}

/**
 * 把文本里的文件路径替换成可点链接标记，其余原样返回。
 * @param {string} text 已 HTML 转义的正文（renderMd 内部管线）
 * @param {{bare?: boolean}} [opts] bare=true 时额外识别白名单内的裸文件名（内联 code 用）
 * @returns {string} 替换后的 HTML 片段
 */
export function linkifyPaths(text, opts) {
  const bare = !!(opts && opts.bare)
  return String(text == null ? '' : text).replace(TOKEN_RE, (tok) => {
    const lead = (tok.match(LEAD_RE) || [''])[0]
    const rest = tok.slice(lead.length)
    const tail = (rest.match(TAIL_RE) || [''])[0]
    const core = rest.slice(0, rest.length - tail.length)
    if (!isFilePath(core, bare)) return tok
    return lead + anchor(core) + tail
  })
}
