// 会话输入区(纯展示受控组件): 排队消息行 + 附件 chips 行 + 输入框 + 底栏 + SlashMenu 挂载
// - 不持有业务 state: 全部数据/回调由 SessionView 透传, 本组件只做展示与转发
// - 附件 chips 是输入框 markdown 文本的「可视投影」: value 仍保留 ![名](abs)/[名](abs)
//   (agent 本机直读协议不变), 渲染时按 value.includes(a.md) 过滤(用户删改文本使片段消失时
//   chip 自动消失), × 移除仅删输入框文本, 不动磁盘文件
// - 底栏 .sess-bottombar: 「+」/权限档/模型下拉/思考等级/上下文圈圈/发送-停止 一行
// props: value/onChange(textarea 受控), atts/onRemoveAtt(附件 chips),
//        uploading/inputLocked/caps/meta(门控与 placeholder; meta 含 family/ctx/sessionModel/permission),
//        chatRunning/taskRunning/queuedN/board/sending(发送-停止按钮分态; 忙/运行中=「排队」),
//        permMode/modelSel/modelOpts/onSetModel/onSetPermission/effortSel/effortOpts/onSetEffort
//        (会话级配置四控件, Task 4 + 2026-10-04 思考等级;
//        权限三档 manual/yolo/auto；档位文案出处 kimi code，语义走服务端 DSH_PERMISSION_PRESETS 近似映射;
//        思考等级选项=该模型支持档位，来自 /api/agents/models 的 efforts，空则用内置档位表),
//        queueRows/injecting/onInject(排队消息行 + 「立即注入」按钮: 平台队列行
//         msgId=撤销排队立即投递当前上下文; dsh 宿主 inbox 行只展示、无按钮),
//        answerPending/deliveringAnswer/onDeliverAnswer(已作答·待送达行 + 「立即送达」),
//        slashOpen/slashQuery/slashItems/onSlashSelect/onSlashClose/onSlashDisabled(SlashMenu 透传),
//        onPasteFiles/onDropFiles/onUploadFiles(附件上传), taRef(textarea ref, 供 SessionView autoGrow)
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Send, Square, Plus, FileText, X, Zap } from 'lucide-react'
import SlashMenu from './SlashMenu'
import { queueStatePlaceholder } from '../utils/queueBadge'

/** 权限档选项（值 manual/yolo/auto + 标签与描述取自 kimi web 客户端同款文案
    ＝设计出处，见 kimi-code 仓库 i18n permission* 词条；服务端按
    DSH_PERMISSION_PRESETS 做语义近似映射，非逐项等价） */
export const PERM_OPTS = [
  { value: 'manual', label: '逐条确认', desc: '每个工具操作都需要你手动确认' },
  { value: 'yolo', label: '自动通过', desc: '自动批准工具操作，但遇到关键问题仍会询问' },
  { value: 'auto', label: '完全自主', desc: '完全自主运行，智能体自己做决定，不再询问' },
]

/** token 数 → 紧凑文本(32876 → 32.9k), 用于圈圈 tooltip 展示上下文用量 */
function fmtTok(n) {
  const v = +n || 0
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(v)
}

export default function ComposerBar({ value, onChange, atts, onRemoveAtt, uploading, inputLocked,
    caps, meta, onSend, onStop, chatRunning, taskRunning,
    queuedN, board, sending,
    permMode, modelSel, modelOpts, onSetModel, onSetPermission,
    effortSel, effortOpts, onSetEffort,
    queueRows, injecting, onInject,
    answerPending, deliveringAnswer, onDeliverAnswer,
    slashOpen, slashQuery, slashItems, onSlashSelect, onSlashClose, onSlashDisabled,
    onPasteFiles, onDropFiles, onUploadFiles, taRef }) {
  const fileRef = useRef(null)        // 「+」按钮触发的隐藏 file input
  /* ---------- 底栏三控件(Task 4)派生 ---------- */
  // 可交互判定（2026-10-03 起全部按能力位，不再按族名硬编码）：
  //   profile    能力位 = 会话级**模型**切换（唯一族 dsh_plugin 为 True）
  //   permission 能力位 = 权限档切换（dsh_plugin 为 True；三档经 server
  //     DSH_PERMISSION_PRESETS 近似映射到宿主 preset，非逐项等价）
  const modelInteractive = board && !!caps?.profile
  const permInteractive = board && !!caps?.permission
  // 思考等级（2026-10-04）：档位属会话请求参数，看板卡与**任务会话**都可交互
  // （任务侧端点 POST /api/tasks/<id>/session/profile 只开这一项；模型/权限档仍限看板卡）
  const effortInteractive = !!caps?.profile && !!(effortOpts?.options || []).length
  // 权限档文案/置灰: permMode 未回读(meta.permission 未到)或不可交互
  const permOpt = PERM_OPTS.find((o) => o.value === permMode) || null
  const permText = permOpt ? permOpt.label : '权限'
  // 思考等级展示值: 回读值(meta.sessionEffort/乐观选择) → 空=该模型默认档（宿主有默认
  // 档时括注出来，如「默认（最高）」）——与 dsh 自己的控件同口径（显示生效档位）
  const effortVal = effortSel || meta?.sessionEffort || ''
  const effortOpt = (effortOpts?.options || []).find((o) => o.value === effortVal) || null
  const effortDefaultLabel = effortOpts?.defaultEffort
    ? (((effortOpts.options || []).find((o) => o.value === effortOpts.defaultEffort) || {}).label
       || effortOpts.defaultEffort)
    : ''
  const effortText = effortOpt?.label
    || (effortDefaultLabel ? `默认（${effortDefaultLabel}）` : '默认')
  // 模型展示值: 乐观选择 → meta 回读模型 → 项目默认 → 兜底文本(radix Select 值必须落在选项内)
  const modelText = modelSel || meta?.sessionModel || modelOpts?.default || '默认模型'
  const modelVal = modelText === '默认模型' ? '__default__' : modelText
  // 上下文圈圈: ctx={used,max} 有效才按比例画进度弧, 缺失(后端未给 ctx/无数据) → 0% 灰环
  const ctx = meta?.ctx
  const ctxPct = ctx && +ctx.max > 0
    ? Math.min(100, Math.max(0, Math.round((+ctx.used / +ctx.max) * 100))) : 0
  const ringC = 2 * Math.PI * 7        // 圆环周长(r=7), strokeDasharray 基
  // 附件 chip 仅渲染 markdown 片段仍在输入框中的(与文本内容保持一致)
  const shown = (atts || []).filter((a) => value.includes(a.md))
  // 2026-09-10 排队语义：项目忙/任务运行中发出即排队（后端统一队列），不再锁输入——
  // 占位文案与发送按钮随之切「排队」；dsh 会话自身在跑时消息入宿主 inbox 排队（服务端排队插话）
  // （2026-09-19 起底栏「立即注入」勾选框已移除，注入改由排队行的按钮触发）。
  // P6 起分态改读服务端 meta.queue_state（busy 拼态删除；foreign_busy 有专属文案），
  // chatRunning/queuedN 为平台消息通道的补充信号（消息单元执行中/本地排队数）；
  // meta.project_busy 保留兜底：本单元 idle + 项目被他单元占用时（会话级 queue_state
  // 恒 idle）照常给出「排队」预测（评审 Important-1 修复，与 P6 前旧链一致）
  const qstate = meta?.queue_state || ''
  const projectBusy = !!meta?.project_busy
  const busy = (!!qstate && qstate !== 'idle') || projectBusy
  const queueMode = busy || chatRunning || (queuedN || 0) > 0
  const placeholder = queueStatePlaceholder(qstate, {
    found: !!meta?.found, board: !!board, canQueue: !!caps.queue, chatRunning,
    projectBusy })
  // 停止按钮：有排队消息=取消排队；会话运行中=停止当前对话（board 恒显示；
  // 有 queue 能力的族在任务运行中不显示——那是任务级停止，走任务列表的停止按钮）
  const canStop = (queuedN || 0) > 0 || (chatRunning && (board || !(caps.queue && taskRunning)))
  return (
    <div className="sess-composer">
      {/* 已作答·待送达行（2026-09-14，board 卡片会话）：答案已被平台收下、等项目
          空闲送达——与排队消息行同款呈现，带「立即送达」按钮（不等空闲直接交给
          等待中的会话；送达成功后随下轮轮询消失） */}
      {answerPending && (
        <div className="sess-queue">
          <div className="sess-queue-row" title="答案已提交，等项目空闲送达">
            <span className="sess-queue-tag on">待送达</span>
            <span className="sess-queue-text">已作答，等待送达（项目忙，空闲后自动送达）</span>
            <Button size="sm" variant="outline" className="sess-queue-btn"
              disabled={deliveringAnswer}
              title="立即送达：不等项目空闲，立即把答案交给等待中的会话"
              onClick={onDeliverAnswer}>
              <Zap className="h-3 w-3" /> 立即送达
            </Button>
          </div>
        </div>
      )}
      {/* 排队消息列表（2026-09-10）：逐行带「立即注入」按钮——
          平台统一队列行（msgId，项目忙时排队的消息）：撤销排队立即投递到会话
          当前上下文，不再等项目空闲（发送中的行已在执行，不可注入）。
          dsh 宿主 inbox 排队行（meta.queue）无平台 msg_id，只展示、无按钮。
          P6 起行 tag 文案分离来源：服务端队列行「服务端排队」、平台队列行「排队中」、
          执行中行「发送中」（此前三路同显「排队中」，服务端/平台排队不区分）*/}
      {queueRows.length > 0 && (
        <div className="sess-queue">
          {queueRows.map((q) => {
            // 可注入：平台排队行（msgId 且未在执行）
            const canInject = caps.steer && q.msgId && q.state !== 'running'
            return (
              <div key={q.key} className="sess-queue-row" title={q.text}>
                <span className={'sess-queue-tag' + (q.state === 'server' ? ' on' : '')}>
                  {q.state === 'server' ? '服务端排队'
                    : q.state === 'running' ? '发送中' : '排队中'}
                </span>
                <span className="sess-queue-text">
                  {q.text.slice(0, 60)}{q.text.length > 60 ? '…' : ''}
                </span>
                {canInject && (
                  <Button size="sm" variant="outline" className="sess-queue-btn"
                    disabled={injecting === q.key}
                    title="立即注入：不等队列，直接投递到会话当前上下文"
                    onClick={() => onInject(q)}>
                    <Zap className="h-3 w-3" /> 立即注入
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {/* 附件 chips 行(textarea 上方): 图片缩略图(url) / 文件 icon + 文件名 + × 移除 */}
      {shown.length > 0 && (
        <div className="sess-attachrow">
          {shown.map((a, i) => (
            <span key={a.md + i} className="sess-chip" title={a.name}>
              {(a.mime || '').startsWith('image/') && a.url
                ? <img src={a.url} alt={a.name} />
                : <FileText className="h-3.5 w-3.5" />}
              <span className="sess-chip-name">{a.name}</span>
              <button type="button" className="sess-chip-x" title="移除附件"
                onClick={() => onRemoveAtt(a.md)}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="sess-slashwrap">
        {/* open 由 SessionView 按 token(光标前 / 命令)派生, 此处不再叠加 startsWith('/') 门控
            (token 触发支持行中输入 /, 见 utils/slashToken.js) */}
        <SlashMenu open={slashOpen}
          query={slashQuery} items={slashItems}
          onSelect={onSlashSelect} onClose={onSlashClose}
          onDisabled={onSlashDisabled} />
        <textarea
          ref={taRef}
          className="sess-ta"
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault(); onSend()
            }
          }}
          onPaste={onPasteFiles} onDrop={onDropFiles}
          placeholder={placeholder}
          disabled={inputLocked}
        ></textarea>
      </div>
      {/* 底栏一行: 「+」/权限开关/模型下拉/上下文圈圈/发送-停止 */}
      <div className="sess-bottombar">
        {/* 「+」附加文件: 上传后光标处插入 markdown(图片/文件, 引用落盘绝对路径供 agent 直读) */}
        <input ref={fileRef} type="file" multiple className="hidden"
          onChange={(e) => { onUploadFiles(e.target.files); e.target.value = '' }} />
        <Button variant="ghost" size="icon" className="sess-attach" title="添加附件（粘贴/拖入亦可）"
          disabled={uploading || inputLocked}
          onClick={() => fileRef.current?.click()}>
          <Plus className="h-4 w-4" />
        </Button>
        {/* 2026-09-19 移除底栏「立即注入」勾选框：发送一律先排队，运行中要插话
            走排队行的「立即注入」按钮（用户报该勾选框多余） */}
        {/* 权限档（三档：逐条确认 manual / 自动通过 yolo / 完全自主 auto，
            标签与描述取自 kimi web 客户端同款文案＝设计出处；语义走 server
            DSH_PERMISSION_PRESETS 近似映射）；
            可交互=board+caps.permission，置灰=meta 未回读（permMode=null）或不可交互 */}
        {permInteractive ? (
          <Select value={permMode || undefined} onValueChange={onSetPermission}
            disabled={!permMode}>
            <SelectTrigger size="sm" className="h-8 max-w-[130px] px-2 text-xs gap-1"
              title={permOpt ? `权限：${permOpt.label}（${permOpt.desc}）` : '权限模式读取中…'}>
              {/* 收起态只显示档位名：Radix 默认把选中项内容（含描述）portal 进触发器，
                  显式给 SelectValue children 覆盖；描述仅在展开列表内显示（对齐 kimi code） */}
              <SelectValue className="sess-ctl-value" placeholder="权限">{permText}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PERM_OPTS.map((o) => (
                <SelectItem key={o.value} value={o.value} title={o.desc}>
                  <span className="sess-perm-item">
                    <span className="sess-perm-label">{o.label}</span>
                    <span className="sess-perm-desc">{o.desc}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="sess-chip" title="权限模式（会话级）">{permText}</span>
        )}
        {/* 模型选择: 可交互=chip 样式下拉(选项=项目 agent 模型列表 /api/agents/models;
            现值不在列表时补当前项兜底, 未知模型=disabled「默认模型」占位);
            置灰=不渲染下拉, 仅展示模型名文本(meta.sessionModel 或兜底「默认模型」) */}
        {modelInteractive ? (
          <Select value={modelVal} onValueChange={onSetModel}>
            <SelectTrigger size="sm" className="h-8 max-w-[180px] px-2 text-xs gap-1"
              title="切换会话模型（即时生效）">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelVal === '__default__' && <SelectItem value="__default__" disabled>默认模型</SelectItem>}
              {modelVal !== '__default__' && !(modelOpts?.models || []).some((m) => m.name === modelVal) && (
                <SelectItem value={modelVal}>{modelVal}</SelectItem>
              )}
              {(modelOpts?.models || []).map((m) => (
                <SelectItem key={m.name} value={m.name}>{m.display_name || m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="sess-chip" title="当前会话模型">{meta?.sessionModel || '默认模型'}</span>
        )}
        {/* 思考等级（2026-10-04）：选项=当前模型支持的档位（/api/agents/models 的
            efforts，缺省用内置档位表）；可交互=有 profile 能力位（看板卡与任务会话都开，
            任务侧只开这一项）；「默认」项按模型选择同款哨兵置灰——默认档不可点选，
            只作展示（当前档位即模型默认时就显示它）。切换即时生效（驱动 /model）。 */}
        {effortInteractive ? (
          <Select value={effortVal || '__default__'} onValueChange={onSetEffort}>
            <SelectTrigger size="sm" className="h-8 max-w-[130px] px-2 text-xs gap-1"
              title="切换会话思考等级（即时生效）">
              <SelectValue className="sess-ctl-value" placeholder="思考等级">{effortText}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {/* 默认档哨兵：Radix Select 不允许空串值；置灰（与模型下拉的「默认模型」同款） */}
              <SelectItem value="__default__" disabled>
                {effortDefaultLabel ? `默认（${effortDefaultLabel}）` : '默认'}
              </SelectItem>
              {/* 回读档位不在当前选项里（模型目录还没拉到/老插件）：补一条兜底项，防触发器空值 */}
              {effortVal && !effortOpt && (
                <SelectItem value={effortVal}>{effortVal}</SelectItem>
              )}
              {(effortOpts?.options || []).map((o) => (
                <SelectItem key={o.value} value={o.value} title={o.title}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="sess-chip" title="思考等级（会话级）">{effortText}</span>
        )}
        {/* 上下文圈圈: 当前上下文占用比例(整数 %), 缺失 → 0% 灰环(仅底轨) */}
        <svg className="sess-ring" viewBox="0 0 18 18" width="18" height="18"
          title={ctx ? `上下文 ${fmtTok(ctx.used)} / ${fmtTok(ctx.max)}（${ctxPct}%）` : '暂无上下文用量数据'}>
          <title>{ctx ? `上下文 ${fmtTok(ctx.used)} / ${fmtTok(ctx.max)}（${ctxPct}%）` : '暂无上下文用量数据'}</title>
          <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" strokeWidth="2" />
          {ctxPct > 0 && (
            <circle cx="9" cy="9" r="7" fill="none" stroke="var(--run)" strokeWidth="2"
              strokeLinecap="round" strokeDasharray={`${(ctxPct / 100) * ringC} ${ringC}`}
              transform="rotate(-90 9 9)" />
          )}
          <text x="9" y="9" dominantBaseline="central" textAnchor="middle">{ctxPct}</text>
        </svg>
        <span style={{ flex: 1 }}></span>
        {/* 停止/取消排队（有排队消息或会话运行中；两者可并存——停止不影响继续排队发送） */}
        {canStop && (
          <Button variant="outline" size="sm" onClick={onStop}>
            <Square /> {(queuedN || 0) > 0 && !chatRunning ? '取消排队' : '停止'}
          </Button>
        )}
        <Button size="sm" onClick={onSend}
          disabled={!value.trim() || sending || inputLocked}>
          <Send /> {queueMode ? '排队' : '发送'}
        </Button>
      </div>
    </div>
  )
}
