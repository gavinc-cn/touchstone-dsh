// bug 报告状态与严重程度分类
// 供 BugsTab 徽标与监控页 Bug 统计图共用, 保证两处口径一致

// bug 报告状态分类(按 bug_report.md「状态」字段的正则归类)
export function bugStatusCls(s) {
  if (/已拒绝/.test(s)) return 'reject'
  if (/复测通过/.test(s)) return 'pass'
  if (/已修复/.test(s)) return 'fix'
  if (/已分析/.test(s) || /修复方案/.test(s)) return 'run'
  if (/待分析/.test(s) || /复测未通过/.test(s)) return 'retest'
  return 'pending'
}

// ---------------------------------------------------------------------------
// 严重程度等级（2026-10-25「测试报告等级划分」批次）
//
// 后端下发的 `severity` 已是**内部中文 canonical 值**（高/中/低；缺失或无法识别给空串，
// 英文报告的 High/Medium/Low 已在后端归一到中文）。canonical 中文值一律用 \uXXXX 转义
// 书写：扫描器只认源码里直接书写的中文，转义写法不会被计成「未翻译文案」，且运行时值与
// 持久化数据逐字一致（与 utils/dataLabels.js 的常量写法同口径）。
// ---------------------------------------------------------------------------
export const SEV_HIGH = '\u9ad8' // 高
export const SEV_MEDIUM = '\u4e2d' // 中
export const SEV_LOW = '\u4f4e' // 低
export const SEV_NONE = '' // 未分级（字段缺失/无法识别）

/** 等级筛选键：'all' = 全部；其余为 canonical 等级（高/中/低）或 SEV_NONE（未分级） */
export const SEV_FILTER_ALL = 'all'

/** 把后端值收敛到四个合法分类键（未知自定义值一律归「未分级」） */
export function severityKey(severity) {
  if (severity === SEV_HIGH || severity === SEV_MEDIUM || severity === SEV_LOW) return severity
  return SEV_NONE
}

/** 等级 → 徽标样式类（high/medium/low/none；CSS 见 theme.css `.bug-sev` 族） */
export function severityCls(severity) {
  const key = severityKey(severity)
  if (key === SEV_HIGH) return 'high'
  if (key === SEV_MEDIUM) return 'medium'
  if (key === SEV_LOW) return 'low'
  return 'none'
}

/**
 * 等级计数（筛选 chips 同时承担计数展示）：按四个分类键 + `all` 汇总。
 * @param {Array<{severity?: string}>} bugs
 * @returns {{all: number, high: number, medium: number, low: number, none: number}}
 */
export function severityCounts(bugs) {
  const out = { all: 0, high: 0, medium: 0, low: 0, none: 0 }
  for (const bug of bugs || []) {
    out.all += 1
    out[severityCls(bug && bug.severity)] += 1
  }
  return out
}

/**
 * 按等级筛选（纯前端，不动后端排序）：`all` 返回全部；其余按键匹配四个分类之一。
 * @param {Array<{severity?: string}>} bugs
 * @param {string} key `all` / `high` / `medium` / `low` / `none`
 * @returns {Array<{severity?: string}>} 新数组（all 也返回副本，调用方永不改原数组）
 */
export function filterBugsBySeverity(bugs, key) {
  const list = bugs || []
  if (key === SEV_FILTER_ALL) return list.slice()
  return list.filter((bug) => severityCls(bug && bug.severity) === key)
}
