// 本平台附件引用的寻址归一（纯函数, 无副作用）
// 用途: 看板描述/评论/会话气泡在渲染前, 把附件的两种「引用形态」都改写成带同源根前缀的
// 项目媒体端点 URL, 使 renderMd 能渲染出缩略图(图片) / 文件链接(非图片):
//   ① 落盘绝对路径 abs —— server 落盘位置 <work_dir>/board_media/<fid>（看板新建框/会话
//      composer 写这种, agent 进程本机直读）;
//   ② 媒体端点裸路径 —— server 上传回包 url 字段 /api/projects/<pid>/board/media/<fid>
//      （看板详情编辑框写这种）。
// 为什么必须补前缀: 独立形态同源根为 ''（裸 /api/... 即本站）, dsh 插件形态站点挂在
// /touchstone 前缀下（dsh-plugin 反代）, 裸 /api/... 会打到 dsh 宿主根（401/404）——附件
// chip 缩略图与已存 description 里的图片都不显示（2026-10-04 用户报障「粘贴图片无法显示」）。
// 安全红线: 仅改写本平台上传产物路径形态（fid = m<13 位毫秒>_<10 位 hex>.<ext>, 与
// server._api_board_upload_media 一致）, 其余引用(含任意路径/URL)一律原样保留。

// markdown 引用: 图片 ![alt](url) 或链接 [text](url), 捕获 url(不含空白与右括号)
const MEDIA_RE = /([!]?\[[^\]]*\]\()([^)\s]+)(\))/g
// fid 形态（与 server 上传端点一致）: m<13 位毫秒>_<10 位 hex>.<扩展名>
const FID = 'm\\d{13}_[0-9a-f]{10}\\.[A-Za-z0-9]{1,10}'
// 形态 ①: 以 / 开头的落盘绝对路径, 尾段为 /board_media/<fid>
const MEDIA_PATH_RE = new RegExp('^\\/.*\\/board_media\\/(' + FID + ')$')
// 形态 ②: 媒体端点裸路径 /api/projects/<pid>/board/media/<fid>（无同源根前缀）
const MEDIA_API_RE = new RegExp('^\\/api\\/projects\\/\\d+\\/board\\/media\\/(' + FID + ')$')

// 同源根(api/index.js 同款): 独立='', dsh 插件='/touchstone'
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')

/** 媒体端点 URL 归一: 裸路径补同源根前缀, 其余（已是带前缀形态/非本平台端点/空值）原样返回。
 *  base 缺省取构建期同源根, 仅单测注入用。 */
export function mediaDisplayUrl(u, base = BASE) {
  const s = typeof u === 'string' ? u : ''
  return MEDIA_API_RE.test(s) ? base + s : s
}

/** 把文本里的本平台附件引用改写为「带同源根前缀的媒体端点 URL」。
 *  非本平台产物路径 / fid 形态不符的引用原样保留（幂等：已是带前缀形态不会再改）。
 *  base 缺省取构建期同源根, 仅单测注入用。 */
export function absToMedia(text, pid, base = BASE) {
  if (!text || !pid) return text || ''
  return String(text).replace(MEDIA_RE, (m, pre, url, post) => {
    const hit = MEDIA_PATH_RE.exec(url)
    // 形态 ①: 落盘绝对路径 → 本项目的媒体端点（pid 由调用方给出）
    if (hit) return pre + base + '/api/projects/' + pid + '/board/media/' + hit[1] + post
    // 形态 ②: 端点裸路径 → 仅补同源根前缀（pid 已是文本里那份, 不改写）
    const shown = mediaDisplayUrl(url, base)
    return shown === url ? m : pre + shown + post
  })
}
