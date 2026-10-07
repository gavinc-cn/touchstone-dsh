// utils/queueBadge.js 单测（P6 展示派生 + v2a T4 starting 枚举 + 2026-09-25
// interaction_pending 枚举）：queue_state 八枚举 → 文案/徽标 class/占位文案全格
// 断言 + 未知枚举降级（防服务端新版枚举前滚击穿旧前端）。
// 判定逻辑在服务端（board.queue_state_of / server._session_queue_state），本层只验映射表。
import { describe, expect, it } from 'vitest'

import {
  QUEUE_STATE_LABEL, queueStateChipClass, queueStatePlaceholder,
} from '../utils/queueBadge'

describe('queueBadge：QUEUE_STATE_LABEL 八枚举文案定稿', () => {
  it('七态文案 + interaction_pending 等待作答 + idle 空串（空串 = 不渲染徽标）', () => {
    expect(QUEUE_STATE_LABEL).toEqual({
      idle: '',
      queued_serial: '排队中',
      answer_pending: '已作答·待送达',
      interaction_pending: '等待作答',
      server_queued: '服务端排队中',
      foreign_busy: '等外部会话',
      starting: '启动中',
      running: '会话运行中',
    })
  })
})

describe('queueBadge：queueStateChipClass 徽标色 class 映射', () => {
  it('board 族（.bug-status）：running/starting→run，五枚等待态→retest 色板', () => {
    expect(queueStateChipClass('running', 'board')).toBe('bug-status run')
    expect(queueStateChipClass('starting', 'board')).toBe('bug-status run')
    expect(queueStateChipClass('queued_serial', 'board')).toBe('bug-status retest')
    expect(queueStateChipClass('answer_pending', 'board')).toBe('bug-status retest')
    expect(queueStateChipClass('interaction_pending', 'board')).toBe('bug-status retest')
    expect(queueStateChipClass('server_queued', 'board')).toBe('bug-status retest')
    expect(queueStateChipClass('foreign_busy', 'board')).toBe('bug-status retest')
  })

  it('sess 族（.sess-qstate）：run/queued 复用既有色板，starting→run，foreign/server 为新色 class', () => {
    expect(queueStateChipClass('running', 'sess')).toBe('sess-qstate run')
    expect(queueStateChipClass('starting', 'sess')).toBe('sess-qstate run')
    expect(queueStateChipClass('queued_serial', 'sess')).toBe('sess-qstate queued')
    expect(queueStateChipClass('answer_pending', 'sess')).toBe('sess-qstate queued')
    expect(queueStateChipClass('interaction_pending', 'sess')).toBe('sess-qstate queued')
    expect(queueStateChipClass('foreign_busy', 'sess')).toBe('sess-qstate foreign')
    expect(queueStateChipClass('server_queued', 'sess')).toBe('sess-qstate server')
  })

  it('idle/未知枚举/空值降级默认 class（防枚举前滚击穿）', () => {
    expect(queueStateChipClass('idle', 'sess')).toBe('sess-qstate')
    expect(queueStateChipClass('future_state', 'sess')).toBe('sess-qstate')
    expect(queueStateChipClass('', 'sess')).toBe('sess-qstate')
    expect(queueStateChipClass(undefined, 'sess')).toBe('sess-qstate')
    expect(queueStateChipClass('idle', 'board')).toBe('bug-status pending')
    expect(queueStateChipClass('future_state', 'board')).toBe('bug-status pending')
  })
})

describe('queueBadge：queueStatePlaceholder 输入区占位文案', () => {
  it('会话不可用（found=false）优先于一切分态', () => {
    expect(queueStatePlaceholder('running', { found: false })).toBe('会话不可用')
    expect(queueStatePlaceholder('idle', { found: false })).toBe('会话不可用')
  })

  it('running：可服务端排队（canQueue）走「立即注入」文案，否则项目忙文案', () => {
    expect(queueStatePlaceholder('running', { canQueue: true, board: true }))
      .toBe('会话运行中：Enter 排队，排队行「立即注入」可插入当前轮')
    expect(queueStatePlaceholder('running', { canQueue: true, board: false }))
      .toBe('任务运行中：Enter 排队，排队行「立即注入」可插入当前轮')
    expect(queueStatePlaceholder('running', { canQueue: false, board: true }))
      .toBe('项目忙：Enter 排队，空闲后自动投递')
    expect(queueStatePlaceholder('running', { canQueue: false, board: false }))
      .toBe('项目忙：Enter 排队，空闲后自动发送')
  })

  it('queued_serial/answer_pending/server_queued/starting 平移现状 busy 文案（启动中=忙）', () => {
    for (const s of ['queued_serial', 'answer_pending', 'server_queued', 'starting']) {
      expect(queueStatePlaceholder(s, { canQueue: true, board: true }))
        .toBe('会话运行中：Enter 排队，排队行「立即注入」可插入当前轮')
      expect(queueStatePlaceholder(s, { canQueue: true, board: false }))
        .toBe('任务运行中：Enter 排队，排队行「立即注入」可插入当前轮')
      expect(queueStatePlaceholder(s, { canQueue: false, board: true }))
        .toBe('项目忙：Enter 排队，空闲后自动投递')
      expect(queueStatePlaceholder(s, { canQueue: false, board: false }))
        .toBe('项目忙：Enter 排队，空闲后自动发送')
    }
  })

  it('interaction_pending 专属等待文案（2026-09-25，#560：提问挂起不再说「会话运行中」）', () => {
    expect(queueStatePlaceholder('interaction_pending', { board: true, canQueue: true }))
      .toBe('agent 等待你作答：回答上方提问，或 Enter 排队继续对话')
    expect(queueStatePlaceholder('interaction_pending', { board: true, canQueue: false }))
      .toBe('agent 等待你作答：回答上方提问，或 Enter 排队继续对话')
    expect(queueStatePlaceholder('interaction_pending', { board: false }))
      .toBe('agent 等待你作答：回答上方提问')
    // 专属文案优先于 project_busy 兜底（CHIP_TONE 仍算忙，但分流在先）
    expect(queueStatePlaceholder('interaction_pending', { projectBusy: true, board: true }))
      .toBe('agent 等待你作答：回答上方提问，或 Enter 排队继续对话')
  })

  it('foreign_busy 专属新文案（「等外部会话」通道，P6 明示行为变更）', () => {
    expect(queueStatePlaceholder('foreign_busy', { board: true, canQueue: true }))
      .toBe('外部会话运行中：Enter 排队，空闲后自动投递')
    expect(queueStatePlaceholder('foreign_busy', { board: false }))
      .toBe('外部会话运行中：Enter 排队，空闲后自动发送')
  })

  it('idle：chatRunning 走对话进行中文案，否则默认文案', () => {
    expect(queueStatePlaceholder('idle', { chatRunning: true }))
      .toBe('对话进行中：Enter 排队，等当前轮结束发送')
    expect(queueStatePlaceholder('idle', {}))
      .toBe('向该会话继续发消息…（Enter 发送，Shift+Enter 换行）')
    expect(queueStatePlaceholder('', {}))
      .toBe('向该会话继续发消息…（Enter 发送，Shift+Enter 换行）')
  })

  it('未知枚举按 idle 降级（默认文案，不击穿）', () => {
    expect(queueStatePlaceholder('future_state', {}))
      .toBe('向该会话继续发消息…（Enter 发送，Shift+Enter 换行）')
  })

  it('idle + project_busy（本单元空闲但项目被他单元占用）：恢复 P6 前旧链预测文案', () => {
    // 评审 Important-1 修复：会话级 queue_state 对本单元 idle 恒回 idle，
    // 输入区预测需消费 meta.project_busy——与旧链 busy=taskRunning||projectBusy 一致
    expect(queueStatePlaceholder('idle', { projectBusy: true, board: false }))
      .toBe('项目忙：Enter 排队，空闲后自动发送')
    expect(queueStatePlaceholder('idle', { projectBusy: true, board: true }))
      .toBe('项目忙：Enter 排队，空闲后自动投递')
    // 旧链一致：canQueue（caps.queue，唯一族 dsh_plugin）时项目忙同样走「立即注入」文案
    expect(queueStatePlaceholder('idle', { projectBusy: true, canQueue: true, board: false }))
      .toBe('任务运行中：Enter 排队，排队行「立即注入」可插入当前轮')
    expect(queueStatePlaceholder('idle', { projectBusy: true, canQueue: true, board: true }))
      .toBe('会话运行中：Enter 排队，排队行「立即注入」可插入当前轮')
    // 对照：idle + 项目非忙 → 默认「发送」文案不变（无回归）
    expect(queueStatePlaceholder('idle', { projectBusy: false }))
      .toBe('向该会话继续发消息…（Enter 发送，Shift+Enter 换行）')
    // foreign_busy 专属文案优先于 project_busy 兜底
    expect(queueStatePlaceholder('foreign_busy', { projectBusy: true, board: false }))
      .toBe('外部会话运行中：Enter 排队，空闲后自动发送')
  })
})
