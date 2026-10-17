// 「取消排队」后把消息原文放回输入框的纯函数（2026-10-17）。
//
// 用户报障的预期：「已经进入排队的消息无法取消……并且取消的消息应重新显示在输入框中」。
// 取消是用户的**撤销**动作——排队行消失的同时，文字必须原样回到输入框（否则用户要凭记忆
// 重打一遍）。这里只做文本合并这条纯逻辑，状态接线在 SessionView（可单测）。
//
// 三条边界（都是「别把用户的东西弄丢」）：
//   - 输入框为空 ⇒ 结果就是原文（不多一个换行）；
//   - 输入框已有未发送草稿 ⇒ 追加在**末尾**，不覆盖用户正在写的内容；
//   - 一次取消多条（底部「取消排队」批量）⇒ 按入队顺序连接，保持可读。
//
// ⚠ 回填的文本必须来自**服务端回带的全文**（`chat.cancel_queued_detail` /
// `chat.cancelQueuedDetail`）：排队行展示文本被截到 120 字（`msgsOfSid`），拿它回填
// 会把长消息静默截断。

/** 多段文本之间的分隔（草稿与还原文本之间、批量还原的每条之间） */
export const RESTORE_SEP = '\n\n'

/**
 * 排队行是否可取消：**平台队列行**（有 msgId）且还没开始执行。
 *
 * 三路来源里只有平台行能取消——`server`（dsh 宿主 inbox 排队行）在 dsh 侧，平台撤不掉；
 * `running`（发送中）已经交给会话，撤销不回来（后端原子守卫同样会拒）。
 * `pending`（乐观 chip）带 msgId，与服务端行同一条消息，照常可取消。
 *
 * @param {{msgId?: string, state?: string}} row queueRows 的一行
 * @returns {boolean}
 */
export function cancellableRow(row) {
  if (!row || !row.msgId) return false
  return row.state === 'queued' || row.state === 'pending'
}

/**
 * 合并回填文本：`texts` 按入队顺序，`prev` 为输入框现有内容（可为 null/空）。
 *
 * - `texts` 里的空串/纯空白段被丢弃（不让回填出多余空行）；
 * - `prev` 只剩空白时视作空（回填直接落原文，不留前导换行）；
 * - `prev` 有实质内容时先去掉**尾部空白**再连接（用户草稿末尾的换行不该叠成三行）。
 *
 * @param {string} prev 输入框现有内容
 * @param {string[]} texts 被取消消息的原文（服务端回带，按入队顺序）
 * @returns {string}
 */
export function mergeRestoreText(prev, texts) {
  const body = (texts || [])
    .map((t) => (t === null || t === undefined ? '' : String(t)))
    .filter((t) => t.trim() !== '')
  const cur = prev === null || prev === undefined ? '' : String(prev)
  if (!body.length) return cur
  const joined = body.join(RESTORE_SEP)
  if (!cur.trim()) return joined
  return cur.replace(/\s+$/, '') + RESTORE_SEP + joined
}

/**
 * 取消成功后的提示文案（单一出处，两种口径：批量 / 单条）。
 *
 * `cancelled=0` 不是错误（消息可能已被 worker 抢走执行，或已被别的路径取消）——如实说明，
 * 不假装成功（这正是原实现「停止回执 stopped:false 却提示成未运行/无法停止」的教训）。
 *
 * @param {number} count 本次真正取消的条数（服务端回带的 cancelled）
 * @param {boolean} single 是否单条取消（排队行行内按钮）
 * @returns {string}
 */
export function cancelQueueToast(count, single) {
  if (!count) return '消息已不在排队中（可能已开始发送）'
  if (single) return '已取消排队，原文已放回输入框'
  return `已取消 ${count} 条排队消息，原文已放回输入框`
}
