// 本平台附件引用的寻址归一（纯函数, 无副作用）
// 用途: 看板描述/评论、会话气泡、文档预览在渲染前, 把「本地引用」改写成浏览器可访问的
// 平台 URL, 使 renderMd 能渲染出缩略图(图片) / 文件链接(非图片):
//   ① 落盘绝对路径 abs —— server 落盘位置 <work_dir>/board_media/<fid>（看板新建框/会话
//      composer 写这种, agent 进程本机直读）;
//   ② 媒体端点裸路径 —— server 上传回包 url 字段 /api/projects/<pid>/board/media/<fid>
//      （看板详情编辑框写这种）。
//   ③ 项目根内的本地图片（2026-10-16 新增）—— agent 自己写的截图/示意图, 形如
//      `<项目目录|工作目录>/…/<任意名>.png`（含 `board_media/<批次>/` 这种子目录、非 fid
//      文件名）。这类引用原先一律原样保留 ⇒ 浏览器按同源根拼成 `http://<宿主>/<落盘路径>`
//      ⇒ 404（2026-10-16 用户报障「会话详情页里 agent 发的图都显示不出来」）; 现改写为
//      `…/file?path=<abs>&inline=1`（后端只放行位图扩展名、且必须落在项目根内, 越界 403）。
//      roots 由调用方从项目行取（见 projectRoots）; roots 拿不到时回落「路径含 /board_media/」
//      这一档——会话页首帧/项目列表未到时也不至于把图全丢。
// 为什么必须补同源根前缀: 独立形态同源根为 ''（裸 /api/... 即本站）, dsh 插件形态站点挂在
// /touchstone 前缀下（dsh-plugin 反代）, 裸 /api/... 会打到 dsh 宿主根（401/404）——附件
// chip 缩略图与已存 description 里的图片都不显示（2026-10-04 用户报障「粘贴图片无法显示」）。
// 安全红线: 只做**形态识别**, 不是安全边界——端点/包含判定（realpath）一律以后端为准;
// 前端只改写「本平台 fid 产物形态」「媒体端点裸路径」「项目根内或附件目录内的位图」,
// 其余引用(含任意路径/URL)一律原样保留。

// markdown 引用: 图片 ![alt](url) 或链接 [text](url), 捕获 url(不含空白与右括号)
const MEDIA_RE = /([!]?\[[^\]]*\]\()([^)\s]+)(\))/g
// fid 形态（与 server 上传端点一致）: m<13 位毫秒>_<10 位 hex>.<扩展名>
const FID = 'm\\d{13}_[0-9a-f]{10}\\.[A-Za-z0-9]{1,10}'
// 形态 ①: 以 / 开头的落盘绝对路径, 尾段为 /board_media/<fid>
const MEDIA_PATH_RE = new RegExp('^\\/.*\\/board_media\\/(' + FID + ')$')
// 形态 ②: 媒体端点裸路径 /api/projects/<pid>/board/media/<fid>（无同源根前缀）
const MEDIA_API_RE = new RegExp('^\\/api\\/projects\\/\\d+\\/board\\/media\\/(' + FID + ')$')
// 形态 ③: 位图扩展名白名单（与后端 `PROJECT_INLINE_IMAGE_TYPES` 同表; 刻意不含 svg ——
// 同源内联可执行脚本文档, 与 `raw=1` 一律附件下载的红线配套）
const IMG_PATH_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i
// 平台附件目录（roots 未知时的回落判据, 见文件头 ③）
const BOARD_MEDIA_SEG = '/board_media/'

// 同源根(api/index.js 同款): 独立='', dsh 插件='/touchstone'
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')

/** 媒体端点 URL 归一: 裸路径补同源根前缀, 其余（已是带前缀形态/非本平台端点/空值）原样返回。
 *  base 缺省取构建期同源根, 仅单测注入用。 */
export function mediaDisplayUrl(u, base = BASE) {
  const s = typeof u === 'string' ? u : ''
  return MEDIA_API_RE.test(s) ? base + s : s
}

/**
 * 项目根列表（`project_dir` / `work_dir`，去尾斜杠；缺项丢弃）。
 *
 * @param {{id?: any, project_dir?: string, work_dir?: string}[]} projects app store 的项目行
 * @param {any} pid 项目 id
 * @returns {string[]} 空数组 = 不知道该项目的根（调用方按「只认 board_media 形态」回落）
 */
export function projectRoots(projects, pid) {
  if (!Array.isArray(projects) || pid === undefined || pid === null || pid === '') return []
  const row = projects.find((p) => p && String(p.id) === String(pid))
  if (!row) return []
  return [row.project_dir, row.work_dir]
    .filter((r) => typeof r === 'string' && r.trim() !== '')
    .map((r) => r.replace(/[/\\]+$/, ''))
}

/** 路径是否落在某个根内（含根本身；调用前两侧都已去尾斜杠） */
function underRoot(u, roots) {
  for (const r of roots || []) {
    if (u === r || u.startsWith(r + '/')) return true
  }
  return false
}

/** 形态 ③ 判定: 本地绝对位图 + （在项目根内 或 落在附件目录里）⇒ `file?inline=1` 端点。
 *  不满足返回 ''（调用方原样保留引用）。 */
function inlineImageUrl(u, pid, base, roots) {
  if (!u.startsWith('/') || !IMG_PATH_RE.test(u)) return ''
  if (!underRoot(u, roots) && u.indexOf(BOARD_MEDIA_SEG) < 0) return ''
  return base + '/api/projects/' + pid + '/file?path=' + encodeURIComponent(u) + '&inline=1'
}

/** 第三参归一: 兼容旧签名（字符串 = base 注入缝）与新签名（`{base, roots}`）。 */
function normOpts(o) {
  if (typeof o === 'string') return { base: o, roots: null }
  if (o && typeof o === 'object') {
    return { base: typeof o.base === 'string' ? o.base : BASE, roots: o.roots || null }
  }
  return { base: BASE, roots: null }
}

/** 把文本里的本平台附件/项目内图片引用改写为「带同源根前缀的可访问 URL」。
 *  非本平台产物路径 / fid 形态不符 / 项目根外的引用一律原样保留（幂等：已是改写后形态
 *  不会再改）。三参两种写法：`absToMedia(text, pid, '/touchstone')`（旧：base 注入缝）
 *  或 `absToMedia(text, pid, {base, roots})`（新：roots = 项目根，见 projectRoots）。 */
export function absToMedia(text, pid, opts) {
  if (!text || !pid) return text || ''
  const { base, roots } = normOpts(opts)
  return String(text).replace(MEDIA_RE, (m, pre, url, post) => {
    const hit = MEDIA_PATH_RE.exec(url)
    // 形态 ①: 落盘绝对路径 → 本项目的媒体端点（pid 由调用方给出）
    if (hit) return pre + base + '/api/projects/' + pid + '/board/media/' + hit[1] + post
    // 形态 ②: 端点裸路径 → 仅补同源根前缀（pid 已是文本里那份, 不改写）
    const shown = mediaDisplayUrl(url, base)
    if (shown !== url) return pre + shown + post
    // 形态 ③: 项目根内/附件目录内的本地位图 → 项目文件内联档
    const inline = inlineImageUrl(url, pid, base, roots)
    return inline ? pre + inline + post : m
  })
}
