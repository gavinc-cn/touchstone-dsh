// session 对话弹窗: Dialog 壳 + SessionView(会话内容/续发消息, 与修复页内嵌版共用)
// 两种用法: task={任务行}(任务会话) / board={{projectId, sid, cid, title}}(看板卡片会话, 轮询增量)
// 默认占 75vw × 90vh（高度 9/10 屏幕）；尺寸随拖动记忆（ts.sessW，重开恢复宽高）
// 标题行右侧两枚徽标（顺序固定：卡片队列 → 统一队列）：
//   「卡片队列」= 卡片当前所在列（board 模式，随 2s 轮询跟随移列），
//   「队列」= 该会话所属单元（任务/卡片）在统一队列中的态；
//   数据均由 SessionView 从会话 meta 派生后经 onCardColumn / onUnitState 上报
import { useEffect, useState } from 'react'
import { useResizable } from '../hooks/useResizable'
import { QUEUE_STATE_LABEL, queueStateChipClass } from '../utils/queueBadge'
import { RzHandles } from './RzHandles'
import SessionView from './SessionView'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

// 卡片所在列徽标（看板列名，仅卡片会话）：键值同看板 payload 的 column
// （todo/doing/blocked/review/done）；未下发（''，任务会话/旧后端）不渲染
const COL_LABEL = { todo: '待开发', doing: '正在开发', blocked: '阻塞',
                    review: '待审核', done: '已完成' }

function CardColumnChip({ column }) {
  const label = COL_LABEL[column]
  if (!label) return null
  return (
    <span className="sess-colstate" title="卡片当前所在列（看板队列）">{label}</span>
  )
}

// 队列状态徽标（P6：state.kind = 服务端 queue_state 八枚举——v2a T4 加 starting，
// 2026-09-25 加 interaction_pending；判定在服务端、前端只渲染）：
//   running=会话运行中 / starting=启动中（板卡已交 runner、会话未证实运行）/
//   queued_serial=排队中·第N位 / answer_pending=已作答·待送达
//   （T1 解冻后 answer 态位次也是真实值，同样带「· 第 N 位」）/ server_queued=服务端排队中 /
//   interaction_pending=等待作答（agent 提问挂起等用户回答）/
//   foreign_busy=等外部会话 / idle=空闲；state 为空（meta 未下发）不渲染
const UNIT_STATE_TIP = {
  running: '该会话所属任务/卡片正在运行',
  starting: '卡片已交平台启动，等待会话证实运行（启动中）',
  answer_pending: '答案已被平台收下，等项目空闲送达',
  interaction_pending: 'agent 向用户提问挂起，等待作答',
  server_queued: '消息已在 agent 服务端队列排队',
  foreign_busy: '项目被外部同步会话占用，等其结束后按队列补位',
}

function UnitStateChip({ state }) {
  if (!state || !state.kind) return null
  const kind = state.kind
  const pos = state.pos || 0
  const total = state.total || 0
  if (kind === 'idle') {
    return (
      <span className="sess-qstate" title="不在统一队列中（既未排队也无运行中的单元）">
        <span className="dot"></span>空闲
      </span>
    )
  }
  // 位次仅 queued_serial/answer_pending 两态展示（pos/total 仍由 meta.unit_state 携带）
  const withPos = (kind === 'queued_serial' || kind === 'answer_pending') && pos > 0
  // 未知枚举降级显示原值 + 默认色（防服务端新版枚举前滚击穿旧前端）
  const label = QUEUE_STATE_LABEL[kind] || kind
  const tip = withPos
    ? `统一队列排队中：本项目前面还有 ${Math.max(0, pos - 1)} 个单元`
      + `（本项目排队 ${total} 个）`
    : (UNIT_STATE_TIP[kind] || '')
  return (
    <span className={queueStateChipClass(kind, 'sess')} title={tip}>
      <span className="dot"></span>{label}{withPos ? ` · 第 ${pos} 位` : ''}
    </span>
  )
}

export default function SessionModal({ task, board, onClose, onSwitchSession }) {
  const open = !!task || !!board
  const { rzOn, rzStyle, rzStart, rzDragStart, rzReset } = useResizable('ts.sessW')
  // 队列状态（SessionView 上报；关闭/未开时不展示，重开由会话数据重新填）
  const [unitState, setUnitState] = useState(null)
  // 卡片所在列（同上；board 模式，任务会话恒 ''）
  const [cardColumn, setCardColumn] = useState('')
  useEffect(() => { if (!open) { setUnitState(null); setCardColumn('') } }, [open])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        // grid-rows: DialogContent 是 grid 容器且弹窗固定 90vh——默认 align-content:stretch
        // 会把 标题行/会话行 两条 auto 轨均分多余空间，内容少时会话区被顶到弹窗中段；
        // 显式 auto + minmax(0,1fr) 让标题行只占内容高、会话区吃掉剩余空间顶格显示
        className={'modal modal-rz sess-modal w-[75vw] h-[90vh] sm:max-w-[94vw] grid-rows-[auto_minmax(0,1fr)]' + (rzOn ? ' rz-drag' : '')}
        style={{ ...rzStyle, marginTop: 0 }}
        showCloseButton={false}
      >
        <RzHandles start={rzStart} reset={rzReset} />
        <DialogHeader className="text-left">
          {/* 标题 + 两枚徽标同行：徽标作 DialogTitle 的兄弟节点（标题带拖拽调尺寸的
              mousedown，徽标放进去会误触拖拽）；「卡片队列」在前、「统一队列」在后 */}
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={rzDragStart}>
              会话 · {task?.name || board?.title || board?.sid}
            </DialogTitle>
            <CardColumnChip column={cardColumn} />
            <UnitStateChip state={unitState} />
          </div>
        </DialogHeader>
        {task && <SessionView task={task} onUnitState={setUnitState} />}
        {board && <SessionView board={board} onUnitState={setUnitState}
                              onCardColumn={setCardColumn} onPassed={onClose}
                              onSwitchSession={onSwitchSession} />}
      </DialogContent>
    </Dialog>
  )
}

