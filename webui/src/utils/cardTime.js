// 卡面「最后更新时间」的展示派生（2026-10-10 批次）
//
// 需求（用户原文）：**看板卡片上应该显示一个最后更新时间**。
//
// 口径（与用户确认）：
//   - 时间源 = 服务端 `card.updated_at_ts`（毫秒 epoch，由 `board.card_ts_ms` 从
//     `board_cards.updated_at` 按**服务器本地时间**换算）。语义 = 「这张卡片行最后
//     一次被改写的时刻」（改名/改描述/搬列/排队态变化/平台收尾搬列…）；
//     **agent 在会话里持续干活不刷它**（会话活动时间是另一回事，界面上由「运行中」
//     徽标与卡内会话窗承担）。
//   - 为什么下发 epoch 而不是让前端解析 `updated_at` 串：库里存的是服务器本地时间、
//     无时区标记（本容器=UTC，浏览器=+8）。前端若直接 `new Date('2026-10-10 21:46:41')`
//     会按浏览器本地解析 ⇒ 整整差 8 小时。epoch 是唯一无歧义的形态，前端再按**浏览器
//     本地时区**渲染绝对时间、按差值算相对时间。
//   - 形态（用户拍板）：卡面显示相对时间（「3 分钟前」），悬浮 title 显示精确到秒。
//     相对时间会随看板既有刷新一起走（SSE 事件唤醒 + 60s 兜底重取 ⇒ 重渲染即重算），
//     故本模块不引入任何定时器。
//
// 与 `unreadBadge.js`（「有更新」药丸）同为「卡面展示派生」薄层：服务端给事实，
// 本层只决定怎么显示。

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 是否是可用的时间戳（毫秒 epoch）。JSON 里缺失/坏值是 `null`，字符串（或旧前端
 * 直接塞库里的 `updated_at` 串）一律不受理——宁可少显示，也不显示错时间。
 *
 * @param {*} ts 毫秒 epoch
 * @returns {boolean}
 */
function usable(ts) {
  return typeof ts === 'number' && Number.isFinite(ts)
}

/**
 * 相对时间文案（卡面小字）。分档：刚刚 / N 分钟前 / N 小时前 / N 天前 / 绝对日期。
 * 满 7 天后改用绝对日期（`MM-DD`，跨年带年份）——「37 天前」这类文案读起来毫无信息量。
 *
 * @param {number} ts 毫秒 epoch
 * @param {number} [now] 当前时刻（毫秒 epoch，缺省取本机时钟；单测注入用）
 * @param {Function} t 翻译函数（useI18n 的 t；**必传**——本函数带 {n} 插值，identity
 *   兜底会把占位符原样漏给界面；render 时传 t 即可即时切换语言）
 * @returns {string} 文案；时间戳不可用 ⇒ `''`（调用方据此不渲染）
 */
export function timeAgo(ts, now = Date.now(), t) {
  if (!usable(ts) || !usable(now)) return ''
  const diff = now - ts
  if (diff < MIN) return t('刚刚')       // 含未来时间：两端时钟有偏差时按「刚刚」，不出负数
  if (diff < HOUR) return t('{n} 分钟前', { n: Math.floor(diff / MIN) })
  if (diff < DAY) return t('{n} 小时前', { n: Math.floor(diff / HOUR) })
  if (diff < WEEK) return t('{n} 天前', { n: Math.floor(diff / DAY) })
  // 7 天以上：按浏览器本地时区取日期；同年省掉年份（看板上绝大多数是这个尺度）
  const d = new Date(ts)
  const n = new Date(now)
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

/**
 * 精确时刻文案（悬浮 title 用）：`YYYY-MM-DD HH:mm:ss`，**浏览器本地时区**。
 *
 * @param {number} ts 毫秒 epoch
 * @returns {string} 文案；时间戳不可用 ⇒ `''`
 */
export function fmtFull(ts) {
  if (!usable(ts)) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 卡面相对时间文案（`card.updated_at_ts` 缺失/坏值 ⇒ `''`）。
 *
 * @param {object} card 看板卡片（服务端 card_json 透传）
 * @param {number} [now] 当前时刻（毫秒 epoch，单测注入用）
 * @param {Function} t 翻译函数（**必传**，转交 timeAgo 做 {n} 插值）
 * @returns {string}
 */
export function cardTimeLabel(card, now = Date.now(), t) {
  return timeAgo(card?.updated_at_ts, now, t)
}

/**
 * 卡面悬浮提示文案：「最后更新：<精确时刻>」；时间戳不可用 ⇒ `''`（不挂空 title）。
 *
 * @param {object} card 看板卡片
 * @param {Function} t 翻译函数（**必传**，用于 {time} 插值）
 * @returns {string}
 */
export function cardTimeTitle(card, t) {
  const s = fmtFull(card?.updated_at_ts)
  return s ? t('最后更新：{time}', { time: s }) : ''
}
