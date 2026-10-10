// 看板卡片操作行「先收文字、后折行」定档（2026-10-10 二批）
//
// 需求口径（用户原文）：**优先去掉文字，然后才考虑折行**。
//   * 第①档：列宽放不下「带文字的按钮行」⇒ 该卡操作行收成纯图标（仍是单行）；
//   * 第②档：连图标都放不下 ⇒ 才落到 CSS 的 flex-wrap 折行兜底。
//
// 为什么由 JS 量、而不是 CSS 容器查询按列宽切一刀：
//   同一列里各卡按钮个数不同（3~6 个：开始/待审核/重开/通过/打回 + 详情/会话/删除…），
//   按列宽一刀切会把本来放得下的卡也收掉文字（实测 1800 宽视口：列宽 300.8px 时
//   「通过/打回」5 按钮行需要 276px、而「重开」4 按钮行只要 196px）。按**每张卡自己的
//   操作行**量才能「谁放不下谁收文字」。
//
// 量法：把整块看板临时置量测态（root 加 .board-ops-measure ⇒ CSS 关掉折行），此时
//   操作行的 scrollWidth - clientWidth 就是「文字全显时的单行溢出量」（>0 即放不下）。
//   量之前先把上一轮的 is-compact 全部摘掉——留着的话量到的是收档后的窄宽度，行会
//   永久卡在收档态（这是本模块唯一的状态陷阱）。
// 读写分三批：写①复位 → 写②量测态 → 读（一次性读齐，此后不再触发布局）→ 写③定档。
//   全程只强制一次布局，且都在 useLayoutEffect 内（绘制前完成，不会闪一帧）。

export const OPS_COMPACT_EPS = 1  // px：亚像素/取整容差，溢出不超过它的不算放不下

/**
 * 按「文字态单行放不放得下」给 root 内每个 .board-card-ops 定档（挂/摘 .is-compact）。
 * @param {Element|Document} root 看板列容器（.board-cols）
 * @returns {{total: number, compacted: number}} 量到的操作行数与其中收档的行数
 */
export function syncOpsFit(root) {
  const rows = root && typeof root.querySelectorAll === 'function'
    ? Array.from(root.querySelectorAll('.board-card-ops'))
    : []
  if (!rows.length) return { total: 0, compacted: 0 }
  rows.forEach((el) => el.classList.remove('is-compact'))   // 写①：退回文字态
  const measuring = root.classList && typeof root.classList.add === 'function'
  if (measuring) root.classList.add('board-ops-measure')   // 写②：量测态（关折行）
  const overflow = rows.map((el) => el.scrollWidth - el.clientWidth)  // 读：一次读齐
  let compacted = 0
  rows.forEach((el, i) => {                                // 写③：定档
    const compact = overflow[i] > OPS_COMPACT_EPS
    el.classList.toggle('is-compact', compact)
    if (compact) compacted += 1
  })
  if (measuring) root.classList.remove('board-ops-measure')
  return { total: rows.length, compacted }
}
