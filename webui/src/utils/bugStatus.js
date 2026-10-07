// bug 报告状态分类(按 bug_report.md「状态」字段的正则归类)
// 供 BugsTab 徽标与监控页 Bug 统计图共用, 保证两处口径一致
export function bugStatusCls(s) {
  if (/已拒绝/.test(s)) return 'reject'
  if (/复测通过/.test(s)) return 'pass'
  if (/已修复/.test(s)) return 'fix'
  if (/已分析/.test(s) || /修复方案/.test(s)) return 'run'
  if (/待分析/.test(s) || /复测未通过/.test(s)) return 'retest'
  return 'pending'
}
