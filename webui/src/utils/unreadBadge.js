// 卡面「有更新」药丸的展示派生（2026-10-07 批次）
//
// 需求（用户原文）：**已完成队列不要显示「有更新」这个标识**。
//
// 语义分工（本文件只做展示判定，不改服务端置位口径）：
//   - `board_cards.unread`（服务端权威，spec/board §49）= 「平台/agent 替你搬了列，
//     而你还打开过这张卡」；置位/清除全在服务端（`db.update_board_card(mark_unread=)`
//     / `db.mark_card_viewed`），前端只渲染。
//   - 「已完成」列是终态归档列：卡进这里（dsh 归档同步、点「通过」…）再飘「有更新」
//     对用户只是噪音——那是「有新状态要你处理」的信号，已完成列没有要处理的东西。
//     ⇒ done 列一律不渲染，字段本身照常保留（卡若从 done 再离开，例如 dsh 侧取消归档
//     回「待审核」，标记仍会照旧显示，无需数据迁移）。
//
// 唯一消费面：BoardTab 卡面徽标行（打开详情/点卡上按钮的清标记逻辑不进这里）。

// 不渲染「有更新」药丸的列（只有确证是已完成列才藏：服务端将来新增列时，
// 未知列按「显示」处理，宁可多显示也不静默丢信号）
const NO_BADGE_COLUMNS = new Set(['done'])

/**
 * 卡面是否渲染「有更新」药丸。
 *
 * @param {object} card 看板卡片（服务端 card_json 透传：`unread` 布尔 + `column` 列 key）
 * @returns {boolean} true=渲染药丸；false=不渲染（无标记，或卡在「已完成」列）
 */
export function showUnreadBadge(card) {
  return !!card?.unread && !NO_BADGE_COLUMNS.has(card.column)
}
