// 压测运行（load run）展示辅助：状态标签与运行选择器文案。
//
// 2026-10-06 复压批次：一次发压 = 一次运行（运行键 run_key），运行列表来自
// `/api/tasks/<id>/load/runs`（登记运行 + 无运行行的「孤儿报告」）。面板的运行
// 选择器与报告标题共用这里的规则。纯函数，便于单测；文案用 t() 在调用时求值。
import { t } from './i18n'

/** 运行状态 → 展示标签；未知状态码返回空串（由调用方原样回显，与旧行为一致） */
export function runStatusLabel(status) {
  if (status === 'running') return t('进行中')
  if (status === 'done') return t('成功')
  if (status === 'failed') return t('失败')
  if (status === 'stopped') return t('已停止')
  if (status === 'interrupted') return t('被中断')
  if (status === 'unknown') return t('历史（未登记）')
  return ''
}

/**
 * 运行项 → 选择器文案：`运行 #k · 时间 · 状态`。
 * - 只对已登记的运行编号（孤儿报告没有轮次行，标「历史报告」）；
 * - 时间优先用运行行的开始时间，缺失时回落到运行键（YYYYmmdd_HHMMSS）。
 */
export function runLabel(r, idx) {
  const when = (r?.started_at || '').slice(5, 16) || (r?.run_key || '').replace('_', ' ')
  const no = r?.registered ? t('运行 #{n}', { n: idx + 1 }) : t('历史报告')
  const status = runStatusLabel(r?.status) || r?.status || t('未知')
  return t('{no} · {when} · {status}', { no, when, status })
}

/** 运行项 → 一句话摘要（KPI 预览用；无 KPI 返回空串） */
export function runKpiText(r) {
  const kpi = r?.kpi || {}
  return Object.keys(kpi).slice(0, 4).map((k) => `${k}=${kpi[k]}`).join('  ')
}
