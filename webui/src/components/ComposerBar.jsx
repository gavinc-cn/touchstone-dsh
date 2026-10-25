// 会话输入区(纯展示受控组件): 排队消息行 + 附件 chips 行 + 输入框 + 底栏 + SlashMenu 挂载
// - 不持有业务 state: 全部数据/回调由 SessionView 透传, 本组件只做展示与转发
// - 附件 chips 是输入框 markdown 文本的「可视投影」: value 仍保留 ![名](abs)/[名](abs)
//   (agent 本机直读协议不变), 渲染时按 value.includes(a.md) 过滤(用户删改文本使片段消失时
//   chip 自动消失), × 移除仅删输入框文本, 不动磁盘文件
// - 底栏 .sess-bottombar: 「+」/权限档/模型下拉/思考等级/上下文圈圈/发送-停止 一行
// props: value/onChange(textarea 受控), atts/onRemoveAtt(附件 chips),
//        uploading/inputLocked/caps/meta(门控与 placeholder; meta 含 family/ctx/sessionModel/permission),
//        chatRunning/taskRunning/queuedN/board/sending(发送-停止按钮分态; 忙/运行中=「排队」),
//        stopDisabled(外部会话「停止」置灰, C 批 T8: 轮次归 dsh GUI, 平台停不了;
//         仅置灰不隐藏——用户看得见按钮在、但停不了),
//        permMode/permOpts/modelSel/modelOpts/onSetModel/onSetPermission/effortSel/effortOpts/onSetEffort
//        (会话级配置四控件, Task 4 + 2026-10-04 思考等级;
//        权限档位动态跟随 DSH 宿主权限目录（permOpts=宿主目录 options，来自
//        /api/agents/presets；空=目录不可用，降级为 chip 只读展示）;
//        taskActive=任务会话窗口（2026-10-24 任务会话对齐卡片：权限档/模型下拉不再仅限
//        看板卡，板卡与任务窗口同口径可交互，见 utils/permission.sessionControls）;
//        思考等级选项=该模型支持档位，来自 /api/agents/models 的 efforts，空则用内置档位表),
//        queueRows/injecting/onInject(排队消息行 + 「立即注入」按钮: 平台队列行
//         msgId=撤销排队立即投递当前上下文; dsh 宿主 inbox 行只展示、无按钮),
//        cancelling/onCancelQueuedRow/onCancelQueue(2026-10-17「取消排队」：
//         行内「取消」= 只撤那一条并把原文放回输入框；底部按钮在「有排队消息且无运行轮次」
//         时走 onCancelQueue（纯平台侧取消，不碰轮次）——此前它与「停止」共用一次点击，
//         没有运行轮次时会被停止链路判成失败、消息撤不掉),
//        answerPending/deliveringAnswer/onDeliverAnswer(已作答·待送达行 + 「立即送达」),
//        slashOpen/slashQuery/slashItems/onSlashSelect/onSlashClose/onSlashDisabled(SlashMenu 透传),
//        onPasteFiles/onDropFiles/onUploadFiles(附件上传), taRef(textarea ref, 供 SessionView autoGrow)
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Send, Square, Plus, FileText, X, Zap } from 'lucide-react'
import SlashMenu from './SlashMenu'
import { queueStatePlaceholder } from '../utils/queueBadge'
import { queueRowTag } from '../utils/queueRowTag'
import { cancellableRow } from '../utils/queueRestore'
import { canonicalPermission, permissionDesc, permissionItems, permissionLabel, sessionControls }
  from '../utils/permission'
import { useI18n } from '../utils/i18n'

/** token 数 → 紧凑文本(32876 → 32.9k), 用于圈圈 tooltip 展示上下文用量 */
function fmtTok(n) {
  const v = +n || 0
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(v)
}

export default function ComposerBar({ value, onChange, atts, onRemoveAtt, uploading, inputLocked,
    caps, meta, onSend, onStop, stopDisabled, chatRunning, taskRunning,
    queuedN, board, taskActive, sending,
    permMode, permOpts, modelSel, modelOpts, onSetModel, onSetPermission,
    effortSel, effortOpts, onSetEffort,
    queueRows, injecting, onInject,
    cancelling, onCancelQueuedRow, onCancelQueue,
    answerPending, deliveringAnswer, onDeliverAnswer,
    slashOpen, slashQuery, slashItems, onSlashSelect, onSlashClose, onSlashDisabled,
    onPasteFiles, onDropFiles, onUploadFiles, taRef }) {
  const { t } = useI18n()
  const fileRef = useRef(null)        // 「+」按钮触发的隐藏 file input
  /* ---------- 底栏三控件(Task 4)派生 ---------- */
  // 可交互判定（2026-10-03 起全部按能力位，不再按族名硬编码）：
  //   profile    能力位 = 会话级**模型**切换（唯一族 dsh_plugin 为 True）
  //   permission 能力位 = 权限档切换（dsh_plugin 为 True；档位列表动态跟随 DSH 宿主
  //     权限目录 /api/agents/presets，目录不可用/为空 ⇒ 降级为 chip 只读展示）
  // 2026-10-24 任务会话对齐卡片：两枚下拉从 `board &&` 放开为「看板卡 **或** 任务窗口」，
  // 判定收口 utils/permission.sessionControls（纯函数，有单测）
  const { modelInteractive, permInteractive } =
    sessionControls({ board, taskActive, caps, permOpts })
  // 思考等级（2026-10-04）：档位属会话请求参数，看板卡与**任务会话**都可交互
  // （任务侧端点 POST /api/tasks/<id>/session/profile 与本批的权限档/模型走同一端点）
  const effortInteractive = !!caps?.profile && !!(effortOpts?.options || []).length
  // 权限档文案/置灰: permMode 未回读(meta.permission 未到)或不可交互；
  // 档位名走展示层映射（目录 label → 内置中文名 → 原值），旧值 manual/yolo 由
  // canonicalPermission 在显示层兜底（后端已返回 preset key，旧帧才可能见到旧值）
  const permText = permissionLabel(permOpts, permMode)
  const permDesc = permissionDesc(permOpts, permMode)
  // 收起态 title = 命中档位的描述（无描述回退档位名；未回读提示读取中）
  const permTitle = !permMode ? t('权限模式读取中…')
    : (permDesc ? t('权限：{label}（{desc}）', { label: permText, desc: permDesc })
      : t('权限：{label}', { label: permText }))
  // 思考等级展示值: 回读值(meta.sessionEffort/乐观选择) → 空=该模型默认档（宿主有默认
  // 档时括注出来，如「默认（最高）」）——与 dsh 自己的控件同口径（显示生效档位）
  const effortVal = effortSel || meta?.sessionEffort || ''
  const effortOpt = (effortOpts?.options || []).find((o) => o.value === effortVal) || null
  const effortDefaultLabel = effortOpts?.defaultEffort
    ? (((effortOpts.options || []).find((o) => o.value === effortOpts.defaultEffort) || {}).label
       || effortOpts.defaultEffort)
    : ''
  // 展示文案与哨兵解耦：默认模型只是展示文本，选择值走固定 '__default__'
  const effortTextLabel = effortOpt?.label
    || (effortDefaultLabel ? t('默认（{name}）', { name: effortDefaultLabel }) : t('默认'))
  // 模型展示值: 乐观选择 → meta 回读模型 → 项目默认 → 兜底文本(radix Select 值必须落在选项内)
  const modelText = modelSel || meta?.sessionModel || modelOpts?.default || ''
  const modelVal = modelText || '__default__'
  // 置灰 chip 的展示语义与迁移前一致：只显示会话回读模型（meta.sessionModel），
  // 缺回读才兜底「默认模型」；不沿用下拉框的乐观选择/项目默认（那只是选项值语义）
  const modelLabel = meta?.sessionModel || t('默认模型')
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
    projectBusy }, t)
  // 停止按钮：有排队消息=取消排队；会话运行中=停止当前对话（board 恒显示；
  // 有 queue 能力的族在任务运行中不显示——那是任务级停止，走任务列表的停止按钮）
  const canStop = (queuedN || 0) > 0 || (chatRunning && (board || !(caps.queue && taskRunning)))
  // 按钮文案（两种语义共用一个按钮）：有排队消息且当前无运行 turn ⇒「取消排队」
  const cancelMode = (queuedN || 0) > 0 && !chatRunning
  const stopLabel = cancelMode ? t('取消排队') : t('停止')
  // 两个语义的**分派点**（2026-10-17）：文案为「取消排队」时点击走纯平台侧取消动作
  // （onCancelQueue），不再借用停止链路——没有在跑的轮次时停止回执必是 stopped=false，
  // 用户拿到「该会话未在运行或无法停止」而排队消息其实已被取消（用户报障）。
  // 文案为「停止」时语义不变（打断当前轮），停止的排队副作用按既有计划另批拆开。
  const cancelOnly = cancelMode && !!onCancelQueue
  // 外部会话置灰（C 批 T8）：轮次归 dsh GUI 持有，平台的停止/中断对它无效——文案为
  // 「停止」时置灰（仅置灰不隐藏，用户看得见按钮在、但停不了）；「取消排队」是平台侧
  // 动作（撤销 m: 行，不碰 dsh 侧轮次），对外部会话照常有效，不连坐
  const stopGreyed = !!stopDisabled && !cancelMode
  return (
    <div className="sess-composer">
      {/* 已作答·待送达行（2026-09-14，board 卡片会话）：答案已被平台收下、等项目
          空闲送达——与排队消息行同款呈现，带「立即送达」按钮（不等空闲直接交给
          等待中的会话；送达成功后随下轮轮询消失） */}
      {answerPending && (
        <div className="sess-queue">
          <div className="sess-queue-row" title={t('答案已提交，等项目空闲送达')}>
            <span className="sess-queue-tag on">{t('待送达')}</span>
            <span className="sess-queue-text">{t('已作答，等待送达（项目忙，空闲后自动送达）')}</span>
            <Button size="sm" variant="outline" className="sess-queue-btn"
              disabled={deliveringAnswer}
              title={t('立即送达：不等项目空闲，立即把答案交给等待中的会话')}
              onClick={onDeliverAnswer}>
              <Zap className="h-3 w-3" /> {t('立即送达')}
            </Button>
          </div>
        </div>
      )}
      {/* 排队消息列表（2026-09-10）：逐行带「立即注入」按钮——
          平台统一队列行（msgId，项目忙时排队的消息）：撤销排队立即投递到会话
          当前上下文，不再等项目空闲（已发送的行已在执行，不可注入）。
          dsh 宿主 inbox 排队行（meta.queue）无平台 msg_id，只展示、无按钮。
          P6 起行 tag 文案分离来源：服务端队列行「服务端排队」、平台队列行「排队中」、
          执行中行「已发送」（此前三路同显「排队中」，服务端/平台排队不区分；
          文案唯一出处 utils/queueRowTag，2026-10-22 由「发送中」改定）*/}
      {queueRows.length > 0 && (
        <div className="sess-queue">
          {queueRows.map((q) => {
            // 可注入：平台排队行（msgId 且未在执行）
            const canInject = caps.steer && q.msgId && q.state !== 'running'
            // 可取消（2026-10-17）：平台排队行且未开始执行——行内「取消」只撤这一条，
            // 并把原文放回输入框（dsh 宿主 inbox 行与「已发送」行撤不掉）
            const canCancel = !!onCancelQueuedRow && cancellableRow(q)
            return (
              <div key={q.key} className="sess-queue-row" title={q.text}>
                <span className={'sess-queue-tag' + (q.state === 'server' ? ' on' : '')}>
                  {queueRowTag(q.state)}
                </span>
                <span className="sess-queue-text">
                  {q.text.slice(0, 60)}{q.text.length > 60 ? '…' : ''}
                </span>
                {canInject && (
                  <Button size="sm" variant="outline" className="sess-queue-btn"
                    disabled={injecting === q.key}
                    title={t('立即注入：不等队列，直接投递到会话当前上下文')}
                    onClick={() => onInject(q)}>
                    <Zap className="h-3 w-3" /> {t('立即注入')}
                  </Button>
                )}
                {canCancel && (
                  <Button size="sm" variant="outline" className="sess-queue-btn"
                    disabled={cancelling === q.key}
                    title={t('取消这条排队消息：撤销排队，并把原文放回输入框')}
                    onClick={() => onCancelQueuedRow(q)}>
                    <X className="h-3 w-3" /> {t('取消')}
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
              <button type="button" className="sess-chip-x" title={t('移除附件')}
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
        <Button variant="ghost" size="icon" className="sess-attach" title={t('添加附件（粘贴/拖入亦可）')}
          disabled={uploading || inputLocked}
          onClick={() => fileRef.current?.click()}>
          <Plus className="h-4 w-4" />
        </Button>
        {/* 2026-09-19 移除底栏「立即注入」勾选框：发送一律先排队，运行中要插话
            走排队行的「立即注入」按钮（用户报该勾选框多余） */}
        {/* 权限档（2026-10-21 起动态跟随 DSH 宿主权限目录 /api/agents/presets：
            档位列表/顺序/标签/描述与宿主一致，内置档中文名由展示层映射（utils/permission）；
            下发的值是宿主 preset key（read-only/workspace-write/danger-full-access/...）；
            可交互=board+caps.permission+目录非空（目录为空降级为右侧 chip），
            置灰=meta 未回读（permMode=null）或不可交互 */}
        {permInteractive ? (
          <Select value={canonicalPermission(permMode) || undefined} onValueChange={onSetPermission}
            disabled={!permMode}>
            <SelectTrigger size="sm" className="h-8 max-w-[130px] px-2 text-xs gap-1"
              title={permTitle}>
              {/* 收起态只显示档位名：Radix 默认把选中项内容（含描述）portal 进触发器，
                  显式给 SelectValue children 覆盖；描述仅在展开列表内显示 */}
              <SelectValue className="sess-ctl-value" placeholder={t('权限')}>{permText}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {/* 选项=宿主目录 + 现值兜底项（utils/permission.permissionItems） */}
              {permissionItems(permOpts, permMode).map((o) => (
                <SelectItem key={o.value} value={o.value} title={o.description || undefined}>
                  <span className="sess-perm-item">
                    <span className="sess-perm-label">{o.label}</span>
                    {/* 宿主没给描述（如内置档/旧插件）时只显示档位名，不渲染空行 */}
                    {o.description ? <span className="sess-perm-desc">{o.description}</span> : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="sess-chip" title={t('权限模式（会话级）')}>{permText}</span>
        )}
        {/* 模型选择: 可交互=chip 样式下拉(选项=项目 agent 模型列表 /api/agents/models;
            现值不在列表时补当前项兜底, 未知模型=disabled「默认模型」占位);
            置灰=不渲染下拉, 仅展示模型名文本(meta.sessionModel 或兜底「默认模型」) */}
        {modelInteractive ? (
          <Select value={modelVal} onValueChange={onSetModel}>
            <SelectTrigger size="sm" className="h-8 max-w-[180px] px-2 text-xs gap-1"
              title={t('切换会话模型（即时生效）')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelVal === '__default__' && <SelectItem value="__default__" disabled>{t('默认模型')}</SelectItem>}
              {modelVal !== '__default__' && !(modelOpts?.models || []).some((m) => m.name === modelVal) && (
                <SelectItem value={modelVal}>{modelVal}</SelectItem>
              )}
              {(modelOpts?.models || []).map((m) => (
                <SelectItem key={m.name} value={m.name}>{m.display_name || m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="sess-chip" title={t('当前会话模型')}>{modelLabel}</span>
        )}
        {/* 思考等级（2026-10-04）：选项=当前模型支持的档位（/api/agents/models 的
            efforts，缺省用内置档位表）；可交互=有 profile 能力位（看板卡与任务会话都开，
            任务侧只开这一项）；「默认」项按模型选择同款哨兵置灰——默认档不可点选，
            只作展示（当前档位即模型默认时就显示它）。切换即时生效（驱动 /model）。 */}
        {effortInteractive ? (
          <Select value={effortVal || '__default__'} onValueChange={onSetEffort}>
            <SelectTrigger size="sm" className="h-8 max-w-[130px] px-2 text-xs gap-1"
              title={t('切换会话思考等级（即时生效）')}>
              <SelectValue className="sess-ctl-value" placeholder={t('思考等级')}>{effortTextLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {/* 默认档哨兵：Radix Select 不允许空串值；置灰（与模型下拉的「默认模型」同款） */}
              <SelectItem value="__default__" disabled>
                {effortDefaultLabel ? t('默认（{name}）', { name: effortDefaultLabel }) : t('默认')}
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
          <span className="sess-chip" title={t('思考等级（会话级）')}>{effortTextLabel}</span>
        )}
        {/* 上下文圈圈: 当前上下文占用比例(整数 %), 缺失 → 0% 灰环(仅底轨) */}
        <svg className="sess-ring" viewBox="0 0 18 18" width="18" height="18"
          title={ctx ? t('上下文 {used} / {max}（{pct}%）', {
            used: fmtTok(ctx.used), max: fmtTok(ctx.max), pct: ctxPct }) : t('暂无上下文用量数据')}>
          <title>{ctx ? t('上下文 {used} / {max}（{pct}%）', {
            used: fmtTok(ctx.used), max: fmtTok(ctx.max), pct: ctxPct }) : t('暂无上下文用量数据')}</title>
          <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" strokeWidth="2" />
          {ctxPct > 0 && (
            <circle cx="9" cy="9" r="7" fill="none" stroke="var(--run)" strokeWidth="2"
              strokeLinecap="round" strokeDasharray={`${(ctxPct / 100) * ringC} ${ringC}`}
              transform="rotate(-90 9 9)" />
          )}
          <text x="9" y="9" dominantBaseline="central" textAnchor="middle">{ctxPct}</text>
        </svg>
        <span style={{ flex: 1 }}></span>
        {/* 停止/取消排队（有排队消息或会话运行中；两者可并存——停止不影响继续排队发送）；
            外部会话（stopGreyed）仍显示按钮但置灰：那是 dsh GUI 持有的轮次，平台停不了 */}
        {canStop && (
          <Button variant="outline" size="sm" title={cancelOnly
              ? t('取消排队：撤销本会话全部排队消息，并把原文放回输入框（不打断当前轮次）')
              : t('停止当前对话（打断当前轮次）')}
            onClick={cancelOnly ? onCancelQueue : onStop}
            disabled={cancelOnly ? cancelling === '__all__' : stopGreyed}>
            <Square /> {stopLabel}
          </Button>
        )}
        <Button size="sm" onClick={onSend}
          disabled={!value.trim() || sending || inputLocked}>
          <Send /> {queueMode ? t('排队') : t('发送')}
        </Button>
      </div>
    </div>
  )
}
