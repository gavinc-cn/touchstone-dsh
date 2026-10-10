// utils/sessionRename.js 单测（2026-10-10 批次）：卡面改名 → DSH 会话名同步的提示文案。
//
// 服务端契约（`PATCH /api/projects/<pid>/board/cards/<cid>` 带 title）：
//   成功且标题被宿主接受 ⇒ 响应 **不带** `session_rename`（或 ok=true 且无 accepted_title）；
//   失败（池外会话宿主已结束 / 驱动未配置 / 插件过旧）⇒ `session_rename.ok=false` + `error`；
//   宿主规范化/截断标题 ⇒ `session_rename.accepted_title`（卡面已被回写成该值）。
// 本层只决定「要不要提示、提示什么」，不改任何状态。
import { describe, expect, it } from 'vitest'

import { sessionRenameNotice } from '../utils/sessionRename'

describe('sessionRenameNotice：改名同步的提示派生', () => {
  it('无 session_rename（未触发同步）⇒ 不提示', () => {
    expect(sessionRenameNotice({ id: 1, title: '卡' })).toBe('')
    expect(sessionRenameNotice(null)).toBe('')
    expect(sessionRenameNotice(undefined)).toBe('')
  })

  it('成功且无截断 ⇒ 不提示（正常路径不打扰）', () => {
    expect(sessionRenameNotice({ session_rename: { ok: true, session_id: 's1' } })).toBe('')
  })

  it('失败 ⇒ 提示卡名已改 + 原因', () => {
    const msg = sessionRenameNotice({
      session_rename: { ok: false, session_id: 's1', error: '会话已结束（宿主无活动 agent）: s1' },
    })
    expect(msg).toContain('卡名已改')
    expect(msg).toContain('会话已结束')
  })

  it('失败但无原因 ⇒ 用兜底文案（不出现 undefined）', () => {
    const msg = sessionRenameNotice({ session_rename: { ok: false } })
    expect(msg).toContain('卡名已改')
    expect(msg).not.toContain('undefined')
    expect(msg).toContain('未知原因')
  })

  it('标题被宿主截断 ⇒ 提示截断值且明示卡面保留原文（不回写）', () => {
    const msg = sessionRenameNotice({
      session_rename: { ok: true, session_id: 's1', accepted_title: '很长很长' },
    })
    expect(msg).toContain('很长很长')
    expect(msg).toContain('截断')
    expect(msg).toContain('卡面保留原文')
  })
})
