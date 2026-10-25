// 目录选择弹窗的「上级」与根视角文案（2026-10-22 卡 1044：目录选择支持选盘符）。
//
// 后端 GET /api/fs/browse 的 parent 是三态（2026-10-22 起）：
//   - 非空字符串：普通目录的上级目录；
//   - 空串：当前是文件系统根（Windows 盘符根如 `D:\` / POSIX 根 `/`）——「上级」进入根视角，
//     根视角在 Windows 下就是**盘符列表**（此电脑）、其它平台是文件系统根；
//   - null：当前就是根视角，无处可上（「上级」禁用）。
// 前端不判断操作系统：根列表 / 盘符标题只看后端下发的 platform 字段。
import { t } from './i18n'

/** 「上级」是否可点：只有 parent === null（已在根视角）才算到顶；空串「根 → 根视角」可点。 */
export function dirCanGoUp(data) {
  return !!data && data.parent != null
}

/** 路径行文本：有 path 时显示路径；根视角显示「此电脑（选择盘符）」/「根目录」。 */
export function dirPathText(data) {
  if (!data) return ''
  if (data.path) return data.path
  return data.platform === 'windows' ? t('此电脑（选择盘符）') : t('根目录')
}

/** 「上级」按钮 title：说明这一下会去上级目录还是返回盘符/根列表。 */
export function dirUpTitle(data) {
  if (!data) return t('上级目录')
  if (data.parent === '') return data.platform === 'windows' ? t('返回盘符列表') : t('返回根目录')
  return t('上级目录')
}

/** 根视角提示文案：Windows 上说明「点击盘符进入后即可选中盘符根目录」；其它平台为空。 */
export function dirRootHint(data) {
  if (!data || data.path) return ''
  return data.platform === 'windows'
    ? t('点击盘符进入后，可点「选择此目录」选中该盘符根目录')
    : ''
}
