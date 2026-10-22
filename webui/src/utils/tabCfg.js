// 主标签页配置：默认顺序 + 布局规范化的唯一出处（2026-10-22 批次：压测面板默认排到最后）
//
// 布局 {order, hidden, v} 按 用户+项目 存服务端 user_prefs（key=tabs，prefsApi）。
// 「当前激活页」仍存 localStorage `ts_cur_tab`，不在这里。
//
// v = 布局格式版本（缺省/存量数据按 1 处理）。v1 的默认序是
// 开发看板/测试任务/压测面板/监控面板/Bug 报告；v2 把压测面板挪到末位。
// 存量 v1 布局若仍是 v1 默认序（用户从没拖过序，常见于只隐藏/恢复过标签的旧数据），
// normTabCfg 会一次性按 v2 默认序呈现；用户自定义过的顺序一律不动。v>=2 的布局不再
// 迁移，避免覆盖用户之后主动把压测面板拖回旧位置的选择。

export const TAB_CFG_VER = 2

// 主标签页定义（顺序 = 默认顺序；key 与 user_prefs 存储约定，勿改）
export const TABS = [
  { key: 'board', label: '开发看板' },
  { key: 'tasks', label: '测试任务' },
  { key: 'monitor', label: '监控面板' },
  { key: 'bugs', label: 'Bug 报告' },
  { key: 'stress', label: '压测面板' },
]
export const TAB_KEYS = TABS.map((t) => t.key)
export const TAB_LABEL = Object.fromEntries(TABS.map((t) => [t.key, t.label]))

// v1 旧默认序（压测面板在第三位）：只用于存量布局迁移判定，勿再作为默认序使用
export const LEGACY_DEFAULT_ORDER = ['board', 'tasks', 'stress', 'monitor', 'bugs']

function sameOrder(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

// 标签页布局规范化：未知 key 丢弃、缺失 key 按默认序补尾、hidden 只留合法 key、
// v1 旧默认序一次性迁移为 v2 默认序（服务端 prefs 可能落后于前端版本——
// 增删标签页、调整默认序后仍能正确恢复）
export function normTabCfg(cfg) {
  let order = (Array.isArray(cfg?.order) ? cfg.order : []).filter((k) => TAB_KEYS.includes(k))
  for (const k of TAB_KEYS) if (!order.includes(k)) order.push(k)
  const hidden = (Array.isArray(cfg?.hidden) ? cfg.hidden : []).filter((k) => TAB_KEYS.includes(k))
  const ver = Number.isInteger(cfg?.v) ? cfg.v : 1
  // 旧默认序视为「未自定义」⇒ 迁到新默认序（压测面板置末）；自定义序不碰
  if (ver < TAB_CFG_VER && sameOrder(order, LEGACY_DEFAULT_ORDER)) order = [...TAB_KEYS]
  return { order, hidden, v: TAB_CFG_VER }
}
