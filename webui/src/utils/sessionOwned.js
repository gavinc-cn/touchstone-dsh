// 会话归属（`meta.owned`）的前端派生（C 批 T8，2026-10-10）。
//
// 三态口径（与后端下发 `server._session_owned`、投递前置闸 `chat._external_preflight`
// 的判定阶梯逐条对齐）：
//   true        = 平台自持（驱动池内会话）：平台的停止/中断本来有效，渲染同现状；
//   false       = 外部会话（用户在 dsh GUI 里直跑/接管）：轮次由 dsh GUI 持有，
//                 平台的停止/中断对它无效 ⇒ 顶部提示条 + 「停止」按钮置灰；
//   null/未下发 = 注册表未知（未连接 / 热重载后未对齐 / 没见过该 sid）⇒ **按池内
//                 渲染**，与现状一致——「未知 ≠ 外部」是本批统一判定阶梯，绝不据
//                 未知反向推断成外部会话（那会误提示、还误停用仍在平台池内的会话）。
//
// 纯函数层：只做「值 → 文案 / 布尔」的派生，不碰 DOM、不读 store，便于单测
// （本仓前端测试全是纯函数层，见 src/__tests__/）。

/** 外部会话提示条文案（仅 `owned === false` 时渲染；必须含「外部会话」字样） */
export const OWNED_EXTERNAL_HINT =
  '外部会话：本会话由 dsh GUI 直接运行（不是平台启动的），平台的停止/中断对它无效；'
  + '你仍可发消息，消息按平台队列投递。'

/**
 * 提示条文案：外部会话给提示；池内与注册表未知一律返回空串（调用方按空串不渲染）。
 *
 * @param {boolean|null|undefined} owned 会话 meta 的 owned 三态
 * @returns {string} 提示文案，或空串（不渲染提示条）
 */
export function ownedHint(owned) {
  return owned === false ? OWNED_EXTERNAL_HINT : ''
}

/**
 * 「停止」按钮可否使用：只有**确凿的**外部会话（`owned === false`）不可用（置灰）；
 * 池内（true）与注册表未知（null/undefined，含未下发该字段的任务会话端点）照旧可用。
 *
 * @param {boolean|null|undefined} owned 会话 meta 的 owned 三态
 * @returns {boolean} true=可停（照现状），false=置灰
 */
export function canStop(owned) {
  return owned !== false
}
