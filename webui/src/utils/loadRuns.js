// 压测运行（load run）展示辅助：状态标签与运行选择器文案。
//
// 2026-10-06 复压批次：一次发压 = 一次运行（运行键 run_key），运行列表来自
// `/api/tasks/<id>/load/runs`（登记运行 + 无运行行的「孤儿报告」）。面板的运行
// 选择器与报告标题共用这里的规则。纯函数，便于单测。

/** 运行状态 → 中文标签（未知/孤儿一律「历史（未登记）」） */
export const RUN_STATUS = {
  running: '进行中', done: '成功', failed: '失败', stopped: '已停止',
  interrupted: '被中断', unknown: '历史（未登记）',
}

/**
 * 运行项 → 选择器文案：`运行 #k · 时间 · 状态`。
 * - 只对已登记的运行编号（孤儿报告没有轮次行，标「历史报告」）；
 * - 时间优先用运行行的开始时间，缺失时回落到运行键（YYYYmmdd_HHMMSS）。
 */
export function runLabel(r, idx) {
  const when = (r?.started_at || '').slice(5, 16) || (r?.run_key || '').replace('_', ' ')
  const no = r?.registered ? `运行 #${idx + 1}` : '历史报告'
  return `${no} · ${when} · ${RUN_STATUS[r?.status] || r?.status || '未知'}`
}

/** 运行项 → 一句话摘要（KPI 预览用；无 KPI 返回空串） */
export function runKpiText(r) {
  const kpi = r?.kpi || {}
  return Object.keys(kpi).slice(0, 4).map((k) => `${k}=${kpi[k]}`).join('  ')
}
