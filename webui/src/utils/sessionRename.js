// 卡面改名 → DSH 会话名同步的提示派生（2026-10-10 批次）
//
// 需求（用户）：TS 侧改看板卡标题时，DSH 侧的会话名也应跟着改；反过来会话名也能同步回卡面。
// 服务端在 `PATCH /api/projects/<pid>/board/cards/<cid>` 的响应里带 `session_rename`：
//   - `{ok: true, session_id}`                —— 两边都改成功（不打扰用户）；
//   - `{ok: true, accepted_title}`            —— 宿主规范化/截断了标题，卡面已被回写成该值；
//   - `{ok: false, error}`                    —— 卡面已改、DSH 未同步（池外会话宿主已结束、
//                                                驱动未配置、插件过旧…），必须如实告诉用户。
// 本模块只做「要不要提示、提示什么」的纯函数派生（便于单测），调用方负责 toast。

/**
 * 卡面改名的同步结果 → 提示文案（无提示返回空串）。
 *
 * @param {object|null} res - PATCH 卡片的响应体（可能不带 session_rename）。
 * @returns {string} 空串＝不提示；否则为给用户看的一句话。
 */
export function sessionRenameNotice(res) {
  const info = res && res.session_rename
  if (!info) return ''
  if (info.ok === false) {
    return `卡名已改；DSH 会话名未同步：${info.error || '未知原因'}`
  }
  if (info.accepted_title) {
    return `DSH 侧标题被截断为「${info.accepted_title}」（卡面保留原文）`
  }
  return ''
}
