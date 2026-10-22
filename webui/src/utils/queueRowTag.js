// 会话输入区上方「排队消息行」的 tag 文案 —— 全站唯一出处（渲染在 ComposerBar）
//
// 行来源三路（P6 起按来源/状态分离文案，此前三路同显「排队中」）：
//   server   dsh 宿主 inbox 排队行（meta.queue）：agent 侧收下排队，
//            平台没有 msg_id ⇒ 只展示，不可注入/不可取消
//   running  平台消息单元已交给会话（正在执行，等这一轮 turn 结束）：
//            **已发送 ≠ 还在发**；不可注入/不可取消
//   其余     queued（平台排队行）/ pending（本地乐观 chip）：排队中，
//            可「立即注入」/「取消」（均受能力位与来源门控）
//
// 2026-10-22 用户报：running 行标「发送中」读起来像「消息还在发送」，实际早已
// 交给 agent、只是这一轮还没结束 ⇒ running 文案定稿「已发送」。
export function queueRowTag(state) {
  if (state === 'server') return '服务端排队'
  if (state === 'running') return '已发送'
  return '排队中'
}
