// P6 展示派生：queue_state 枚举 → 文案/样式 唯一映射（判定在服务端，前端只渲染）
//
// queue_state 八枚举（v2a T4 加 starting，裁决 R6；2026-09-25 加
// interaction_pending——提问挂起等作答，阻塞卡不再显示「会话运行中」#560；
// 服务端 board.QS_* / server._session_queue_state 下发，见
// doc_ai/spec/queue/排队与占用.md）：
//   idle           无等待无运行（不渲染徽标）
//   queued_serial  等串行位（本项目排队位次）
//   answer_pending 已收下待送达（answer 活跃行在场）
//   interaction_pending 提问挂起等作答（block_kind=interaction；等用户回答）
//   server_queued  服务端排队（dsh 宿主 inbox 排队行在场，仅板卡会话级）
//   foreign_busy   等外部会话（项目被外部同步会话占用）
//   starting       启动中（板卡已交 runner、会话未证实运行，启动宽限窗口）
//   running        运行中（平台在管 running 或会话实况 busy）
//
// 前端三处消费面：看板卡片徽标（BoardTab）/ 会话弹窗标题「队列」徽标（SessionModal）/
// 输入区占位文案（ComposerBar）——全部由本文件的映射函数出文案，不再拼条件。

// 八枚举文案（全站唯一出处；idle 空串 = 不渲染徽标）
export const QUEUE_STATE_LABEL = {
  idle: '',
  queued_serial: '排队中',
  answer_pending: '已作答·待送达',
  interaction_pending: '等待作答',
  server_queued: '服务端排队中',
  foreign_busy: '等外部会话',
  starting: '启动中',
  running: '会话运行中',
}

// 语义色名（两族徽标 class 的公共语义；族内 class 名差异由下方两张表吸收）
const CHIP_TONE = {
  running: 'run',
  starting: 'run',          // 启动中：运行族色板（判定序压排队态，c: 行已在运行前缀）
  interaction_pending: 'queued',  // 等待作答：等待族色板（同排队/待送达橙）
  queued_serial: 'queued',
  answer_pending: 'queued',   // 排队语义同 queued 色板
  server_queued: 'server',
  foreign_busy: 'foreign',
}

// 看板卡片徽标（.bug-status 族）：run/retest 为既有色板（theme.css:138-140），
// 等待类四态同走 retest 橙（卡片粒度的等待语义同色，不新增 class）
const BOARD_CHIP_CLASS = {
  run: 'bug-status run',
  queued: 'bug-status retest',
  server: 'bug-status retest',
  foreign: 'bug-status retest',
}

// 会话弹窗标题徽标（.sess-qstate 族）：run/queued 为既有色板
// （components.css:1018-1021），foreign/server 两枚为 P6 加法（components.css 新增）
const SESS_CHIP_CLASS = {
  run: 'sess-qstate run',
  queued: 'sess-qstate queued',
  server: 'sess-qstate server',
  foreign: 'sess-qstate foreign',
}

// queue_state → 徽标 class。family='board' → .bug-status 族（看板卡片徽标）；
// family='sess' → .sess-qstate 族（会话弹窗标题徽标）。
// idle/未知枚举/空值降级默认 class（防服务端新版枚举前滚击穿旧前端）
export function queueStateChipClass(state, family = 'board') {
  const tone = CHIP_TONE[state]
  if (!tone) return family === 'sess' ? 'sess-qstate' : 'bug-status pending'
  return (family === 'sess' ? SESS_CHIP_CLASS : BOARD_CHIP_CLASS)[tone]
}

// ComposerBar 输入区占位文案（现状三态文案平移 + foreign_busy 专属新文案）：
//   found=false          → 会话不可用（优先于一切分态）
//   foreign_busy         → 外部会话运行中（P6 新通道，board/task 各一版）
//   忙 + 可服务端排队（canQueue=caps.queue）→ 「立即注入」文案
//   忙 + 不可服务端排队   → 项目忙文案（board=投递 / task=发送）
//   空闲 + chatRunning    → 对话进行中文案（消息单元执行中）
//   其余                  → 默认文案；未知枚举按 idle 降级
// 「忙」= queue_state 非 idle 或 ctx.projectBusy（meta.project_busy）：后者覆盖
// 「本单元 idle + 项目被他单元占用」组合——会话级 queue_state 对本单元 idle 恒回 idle，
// 输入区排队预测需项目忙信号兜底（与 P6 前旧链 busy=taskRunning||projectBusy 一致；
// 服务端行为不变，消息照常进统一队列，此处只是预测性文案）
export function queueStatePlaceholder(state, ctx = {}) {
  const { found = true, board = false, canQueue = false, chatRunning = false,
          projectBusy = false } = ctx
  if (!found) return '会话不可用'
  if (state === 'foreign_busy') {
    return board ? '外部会话运行中：Enter 排队，空闲后自动投递'
                 : '外部会话运行中：Enter 排队，空闲后自动发送'
  }
  if (state === 'interaction_pending') {
    // 提问挂起（等用户作答）：徽标不亮「会话运行中」，占位文案同步换等待口径
    return board ? 'agent 等待你作答：回答上方提问，或 Enter 排队继续对话'
                 : 'agent 等待你作答：回答上方提问'
  }
  // 非空闲态（interaction_pending 已在上方分流）或项目被他单元占用都算「忙」
  //（idle/未知枚举 + 项目空闲 → false）
  const busy = !!CHIP_TONE[state] || projectBusy
  if (busy && canQueue) {
    return board ? '会话运行中：Enter 排队，排队行「立即注入」可插入当前轮'
                 : '任务运行中：Enter 排队，排队行「立即注入」可插入当前轮'
  }
  if (busy) {
    return board ? '项目忙：Enter 排队，空闲后自动投递'
                 : '项目忙：Enter 排队，空闲后自动发送'
  }
  if (chatRunning) return '对话进行中：Enter 排队，等当前轮结束发送'
  return '向该会话继续发消息…（Enter 发送，Shift+Enter 换行）'
}
