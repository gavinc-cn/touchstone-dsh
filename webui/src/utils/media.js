// 媒体占位图检测：粘贴/拖入的「图片」可能是来源应用给的极小占位图
// （聊天工具未加载完的原图、截图工具异常时会往剪贴板放 1x1 透明 PNG 或 2x2 纯色 PNG），
// 上传前跳过并提示，避免用户无感知贴出空白附件（2026-09-19 由「仅 1x1」放宽到极小尺寸：
// 2x2 一代占位图会漏过拦截，静默变成一条只有空附件的消息）。
// 判定：PNG 魔数（89 50 4e 47 0d 0a 1a 0a）且 IHDR 宽高均 ≤ PLACEHOLDER_MAX_PX；
// 非 PNG 一律不算占位（真截图/配图远大于该阈值，误拦风险可忽略）。
const PLACEHOLDER_MAX_PX = 4

export async function isPlaceholderImage(file) {
  try {
    if (!(file.type || '').startsWith('image/')) return false
    const head = new Uint8Array(await file.slice(0, 24).arrayBuffer())
    if (head.length < 24) return false
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (png.some((v, i) => head[i] !== v)) return false
    const w = (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19]
    const h = (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23]
    return w <= PLACEHOLDER_MAX_PX && h <= PLACEHOLDER_MAX_PX
  } catch { return false }  // 读取失败不拦：照常上传，由既有错误提示兜底
}
