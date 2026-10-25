import { useState, useEffect } from 'react'
import { meApi, projectApi } from '../../api'
import { toast } from '../../utils/toast'
import { applyResultText, hookSaveRequest } from '../../utils/feishuHook'
import { buildCfgBody, isPushEnabled, withPushEnabled, pushStatusText } from '../../utils/feishuPush'
import { provisionGates, provisionNotices, provisionQrUrl } from '../../utils/feishuProvision'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import SearchSelect from '@/components/ui/search-select'
import { Bell, Command, Link2, RefreshCw, Stethoscope, Wand2, Webhook } from 'lucide-react'
import { useI18n } from '../../utils/i18n'

// 项目推送绑定的事件开关（key 与后端 feishu.FEISHU_EVENTS 一致，数组顺序即渲染顺序；
// commit_failed 已于 2026-09-13 阻塞让行提交退场时随链路删除，勿再加回）。
// 第二项是 (t) => 文案 的取值函数：t 在渲染时求值，切换语言即时重渲染
const HOOK_EVENTS = [
  ['blocked_interaction', (t) => t('交互等待')],
  ['task_failed', (t) => t('任务失败')],
  ['card_review', (t) => t('卡片待审核')],
]

// 飞书设置面板（设置页「飞书设置」分区，所有用户）：每个用户配置自己的机器人——
// 应用凭据（入站长连接按用户各自拉起）+ 默认推送 webhook + 站点地址 + 项目推送绑定
// + 账号绑定 + 投递记录。
// secret 永不回显明文（服务端只回打码/布尔），输入框留空 = 保存时不下发该键（保持现有值）。
export default function FeishuPanel() {
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  // 用户配置回显（enabled/base_url/app_id 明文 + secret 布尔 + 本人入站连接状态）
  const [cfg, setCfg] = useState(null)
  const [input, setInput] = useState({ webhook_url: '', secret: '', app_secret: '' })
  const [busy, setBusy] = useState(false)
  // 入站重连按钮的进行中态（M11.1）：停旧连接最多要等一个收口超时，按钮期间防重复点
  const [reconnecting, setReconnecting] = useState(false)
  // 飞书账号绑定状态（open_id 打码 + 默认项目）与本次生成的绑定码（code）
  const [bind, setBind] = useState(null)
  const [outbox, setOutbox] = useState([])
  const [outboxOpen, setOutboxOpen] = useState(false)

  useEffect(() => {
    load()
    loadBind()
  }, [])

  async function load() {
    try {
      setCfg(await meApi.feishuCfgGet())
    } catch (e) { toast(e.message) }
  }

  // 入站重连（M11.1）：进程内「停旧长连接 → 用当前保存的凭据起新」。
  // 为什么保存之外还要这个按钮：保存走的 `start_inbound_for` 在旧线程还活着时**幂等短路**
  // （换应用后旧连接会一直绑着旧应用）；这个入口才真正换连接，等价于飞书卡片上的
  // 「换用新应用」，但不必离开设置页。
  async function reconnectInbound() {
    setReconnecting(true)
    try {
      const r = await meApi.feishuReconnect()
      if (r?.started) toast(t('入站消息长连接已重连（用当前保存的应用凭据）'))
      else if (!r?.inbound?.configured) toast(t('还没配置自建应用凭据：先填 App ID/App Secret 并保存'))
      else if (r?.inbound?.thread) toast(t('旧连接未能停下，本次没有重连：稍后重试或重启站点'))
      else toast(t('重连未能建立连接：点下方「配置自检」查看原因'))
      await load()
    } catch (e) { toast(e.message) } finally { setReconnecting(false) }
  }

  async function save() {
    setBusy(true)
    try {
      // 基础字段由 utils/feishuPush 统一构造（含推送总控 push_enabled）
      const body = buildCfgBody(cfg)
      // webhook/secret 未输入则不下发该键（后端语义：缺省=保持不变，空串=清除）
      if (input.webhook_url.trim()) body.default_webhook = input.webhook_url.trim()
      if (input.secret) body.default_secret = input.secret
      if (input.app_secret) body.app_secret = input.app_secret
      const r = await meApi.feishuCfgSet(body)
      setInput({ webhook_url: '', secret: '', app_secret: '' })
      // inbound_started=本用户入站长连接随之拉起（首次配置即时生效）；否则看是不是换了应用
      // —— M11（2026-10-17）起换应用**不再需要重启站点**：旧机器人私聊会收到「确认换用
      // 新应用」卡片，点一下由服务端「先发新绑定码、再用新应用重连」（见 feishu.py 的
      // stop_inbound_for/restart_inbound_for）。卡片没收到时在旧机器人发「接入」可重发。
      const switchedApp = Object.hasOwn(body, 'app_id') && body.app_id !== (cfg?.app_id || '')
      const base = r?.inbound_started
        ? t('飞书配置已保存，入站消息长连接已启动')
        : switchedApp
          ? t('飞书配置已保存；旧机器人私聊会收到「确认换用新应用」卡片，点一下完成切换（没收到就发「接入」重发）')
          : t('飞书配置已保存')
      // verify=服务端保存后立刻做的凭据快检（凭据不全时为 null，不探测）
      if (r?.verify && !r.verify.ok) {
        toast(t('{msg}；但凭据快检未通过：{detail}', { msg: base, detail: r.verify.detail }))
      } else if (r?.verify?.ok) {
        toast(t('{msg}；{detail}', { msg: base, detail: r.verify.detail }))
      }
      else toast(base)
      await load()
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  async function clearFeishuSecret() {
    try {
      await meApi.feishuCfgSet({ default_webhook: '', default_secret: '' })
      toast(t('已清除默认 Webhook 与签名密钥'))
      await load()
    } catch (e) { toast(e.message) }
  }

  async function toggleOutbox() {
    const next = !outboxOpen
    setOutboxOpen(next)
    if (next) {
      try { setOutbox(await meApi.feishuOutbox()) } catch (e) { toast(e.message) }
    }
  }

  async function loadBind() {
    try { setBind(await meApi.feishuGet()) } catch (e) { toast(e.message) }
  }

  async function genBindCode() {
    try {
      const r = await meApi.feishuBindcode()
      setBind((b) => ({ ...b, code: r.code }))
    } catch (e) { toast(e.message) }
  }

  async function refreshBind() {
    try {
      const r = await meApi.feishuGet()
      setBind(r)
      toast(r.bound
        ? t('飞书账号已绑定')
        : t('尚未检测到绑定：确认已在飞书私聊机器人发送「绑定 <码>」，且本应用凭据已配置'))
    } catch (e) { toast(e.message) }
  }

  async function unbindFe() {
    try {
      await meApi.feishuUnbind()
      toast(t('已解绑飞书账号'))
      loadBind()
    } catch (e) { toast(e.message) }
  }

  // 机器人应用凭据缺失：入站长连接不启动，飞书消息到不了平台，绑定码必然无效
  const credMissing = !(cfg?.app_id && cfg?.has_app_secret)

  return (
    <>
      {/* 机器人应用与推送配置（用户级，仅操作本人） */}
      <Card className="max-w-xl gap-4 py-4">
        <CardHeader className="px-5 pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bell className="size-4 text-[var(--star-text)]" /> {t('飞书机器人配置')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 px-5">
          {/* 推送总控（2026-10-10）：用户级一票否决——关掉后飞书不再收到**自动推送**
              （作答卡片/审批卡、群 webhook 事件）；用户主动询问、查询与对话答复不受影响。
              按下后需点「保存配置」生效，与卡内其他字段同一写口。 */}
          <div className="space-y-1.5">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={isPushEnabled(cfg)}
                onChange={(e) => setCfg(withPushEnabled(cfg, e.target.checked))} />
              <span>
                {t('推送总控：允许飞书接收自动推送')}
                <span className="text-xs text-muted-foreground">
                  {t('（关掉后飞书不再收到自动推送；你在飞书发指令的查询、会话对话的答复不受影响）')}
                </span>
              </span>
            </label>
            <div className={'text-xs ' + (isPushEnabled(cfg)
              ? 'text-muted-foreground' : 'text-[var(--star-text)]')}>
              {pushStatusText(cfg)}
            </div>
          </div>
          {/* 旧开关：语义比名称窄得多（只管未单独设置的项目回落默认 webhook 那条腿），
              文案必须写清，否则用户会把它当总控——2026-10-10 实障的观感来源 */}
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!cfg?.enabled}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
              {t('启用飞书推送（默认 webhook 回落）')}
            </label>
            <div className="hint" style={{ textAlign: 'left', margin: 0 }}>
              {t('只管「未单独设置推送绑定」的项目：它们回落下方默认 Webhook 并按默认事件推送；已单独设置推送绑定的项目由那张卡里的开关说了算，不受本项影响。')}
            </div>
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t('每个用户配置自己的飞书机器人：入站长连接按用户各自拉起，推送未绑定项目时回落项目所有者的默认 webhook。凭据（App Secret/签名密钥）仅存服务端，不回显。')}
          </div>
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">{t('应用 App ID（入站指令用）')}</Label>
              <Input value={cfg?.app_id || ''} onChange={(e) => setCfg({ ...cfg, app_id: e.target.value.trim() })}
                placeholder="cli_xxxx" />
            </div>
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">App Secret</Label>
              <Input type="password" value={input.app_secret} onChange={(e) => setInput({ ...input, app_secret: e.target.value })}
                placeholder={cfg?.has_app_secret ? t('已设置（留空保持不变）') : t('凭证与基础信息页复制')} />
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs" title={t('凭据齐全且连接线程已启动时，机器人才能接收飞书消息；连接失败细节看 server.log')}>
            <span>
              {t('入站长连接：')}{cfg?.inbound?.thread ? (
                <span className="text-[var(--star-text)]">{t('运行中')}</span>
              ) : cfg?.inbound?.configured ? (
                t('已配置，待启动（保存后自动连接；仍不启动就点右侧「重连入站」）')
              ) : (
                t('未配置（填写并保存后自动连接）')
              )}
            </span>
            <Button variant="ghost" type="button" disabled={busy || reconnecting}
              onClick={reconnectInbound}>
              {reconnecting ? t('重连中…') : t('重连入站')}
            </Button>
          </div>
          <div className="hint">{t('入站指令需：应用开通「机器人」能力 + 权限 im:message.p2p_msg:readonly / im:message.group_at_msg:readonly / im:message:send_as_bot（斜杠指令另需 application:app_slash_command:read|write）+ 事件订阅选「长连接」并添加 im.message.receive_v1、回调 card.action.trigger + 应用发布生效。**下方「飞书接入」卡可扫码建应用并自动配好这些**；Secret 保存后不回显（留空=保持现有值），首次配置保存后自动建立长连接；换应用后旧机器人私聊会收到「确认换用新应用」卡片（先发新绑定码再用新应用重连），没收到就在机器人发「接入」重新获取；也可以直接点上方「重连入站」（等价于卡片上的「换用新应用」，同样无需重启站点）。')}</div>
          <div className="grid gap-2">
            <Label className="text-xs text-muted-foreground">{t('默认推送 Webhook（未绑定项目的回落目标）')}</Label>
            <Input value={input.webhook_url} onChange={(e) => setInput({ ...input, webhook_url: e.target.value })}
              placeholder={cfg?.default_webhook
              ? t('已配置：{url}（留空保持不变）', { url: cfg.default_webhook })
              : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'} />
          </div>
          <div className="grid gap-2">
            <Label className="text-xs text-muted-foreground">{t('签名密钥（机器人开启签名校验时）')}</Label>
            <Input type="password" value={input.secret} onChange={(e) => setInput({ ...input, secret: e.target.value })}
              placeholder={cfg?.has_default_secret ? t('已设置（留空保持不变）') : t('可空')} />
          </div>
          <div className="grid gap-2">
            <Label className="text-xs text-muted-foreground">{t('站点访问地址（通知里附「详情」链接，可空）')}</Label>
            <div className="flex gap-2">
              <Input value={cfg?.base_url || ''} onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })}
                placeholder="http://192.0.2.10:4601" />
              <Button variant="ghost" type="button"
                onClick={() => setCfg({ ...cfg, base_url: window.location.origin })}>
                {t('用当前站点')}
              </Button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={save}>{t('保存配置')}</Button>
            <Button variant="ghost" onClick={clearFeishuSecret}>{t('清除默认 Webhook/密钥')}</Button>
            <Button variant="ghost" onClick={toggleOutbox}>{outboxOpen ? t('收起投递记录') : t('投递记录')}</Button>
          </div>
          {outboxOpen && (
            <div className="max-h-60 overflow-y-auto rounded border border-border/60 text-xs">
              {!outbox.length ? <div className="px-2 py-3 text-muted-foreground">{t('暂无投递记录')}</div> : outbox.map((r) => (
                <div key={r.id} className="border-b border-border/40 px-2 py-1.5 last:border-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={r.status === 'sent' ? 'secondary' : r.status === 'pending' ? 'outline' : 'destructive'}>{r.status}</Badge>
                    <span className="text-muted-foreground">{t('重试×{n}', { n: r.retries })}</span>
                    <span className="truncate font-mono">{r.target}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">{r.created_at}</span>
                  </div>
                  {r.last_error && <div className="truncate text-destructive" title={r.last_error}>{r.last_error}</div>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 飞书接入（M5）：扫码建应用 + 自动补齐配置 + 提交发布（全部由用户点击触发） */}
      <ProvisionCard onCfgChanged={load} />

      {/* 配置自检（M5）：八项体检，逐项给修复指引 */}
      <DoctorCard />

      {/* 项目推送绑定（原「编辑项目」弹窗内的飞书推送区迁入，2026-09-14） */}
      <ProjectHookCard />

      {/* 快捷指令（斜杠指令）：注册到飞书后，输入框打「/」即可从指令面板选择 */}
      <SlashCommandCard />

      {/* 飞书账号绑定：生成绑定码 → 飞书私聊机器人发「绑定 <码>」→ 刷新状态回读 */}
      <Card className="max-w-xl gap-4 py-4">
        <CardHeader className="px-5 pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Link2 className="size-4 text-[var(--star-text)]" /> {t('飞书账号绑定')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-5">
          {!bind ? (
            <div className="text-xs text-muted-foreground">{t('加载中…')}</div>
          ) : bind.bound ? (
            <div className="space-y-1.5 text-sm">
              <div>{t('已绑定飞书账号')} <span className="font-mono text-xs">{bind.open_id}</span></div>
              <div className="text-xs text-muted-foreground">
                {t('默认项目：{project}', {
                  project: bind.default_project || t('未设置（指令未指名项目时机器人会列出可选项目）'),
                })}
              </div>
              <div className="hint" style={{ textAlign: 'left', margin: '0' }}>
                {t('在飞书私聊机器人发「帮助」可查看支持的指令。')}
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              {credMissing && (
                <div className="rounded-md border border-border bg-accent/40 px-3 py-2 text-xs">
                  {t('注意：上方机器人应用凭据（App ID / App Secret）尚未配置，此刻飞书消息无法送达平台，绑定不会生效。请先填写并保存，再生成绑定码。')}
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                {t('绑定后可在飞书私聊机器人执行看板指令（开始卡片 / 审核通过 / 驳回 / 作答提问等）。')}
              </div>
              {bind.code ? (
                <>
                  <div className="rounded-md border border-border bg-accent/40 px-3 py-2 text-center">
                    <div className="font-mono text-2xl font-bold tracking-[0.3em]">{bind.code}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t('10 分钟内有效；重新生成会作废旧码')}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('打开飞书 → 私聊你配置的机器人 → 发送「绑定 {code}」→ 回来点「刷新状态」确认。',
                      { code: bind.code })}
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">{t('尚未绑定，点击下方「生成绑定码」开始。')}</div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {bind?.bound ? (
              <Button variant="destructive" onClick={unbindFe}>{t('解绑')}</Button>
            ) : bind?.code ? (
              <>
                <Button variant="outline" onClick={genBindCode}>{t('重新生成')}</Button>
                <Button variant="outline" onClick={refreshBind}><RefreshCw /> {t('刷新状态')}</Button>
              </>
            ) : (
              bind && (
                <Button onClick={genBindCode} disabled={credMissing}
                  title={credMissing ? t('先配置应用凭据，否则机器人收不到消息') : undefined}>
                  {t('生成绑定码')}
                </Button>
              )
            )}
          </div>
        </CardContent>
      </Card>
    </>
  )
}

// 项目推送绑定（原「编辑项目」弹窗内的飞书推送区迁入设置页，2026-09-14）：
// 每个项目可单独绑定推送群与事件开关（未绑定/未启用时回落上方本人的默认 webhook），
// webhook/secret 未编辑则保存时不下发该键（后端语义：缺省=保持不变、空串=清除）。
// 2026-10-10：① 这些开关同时管**群 webhook 与飞书单聊交互卡片**（此前单聊卡片旁路
// 发送、不受任何开关约束）；② 新增「同时应用到我的全部项目」批量写入（未归档项目）。
function ProjectHookCard() {
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  const [projects, setProjects] = useState([])   // 本人全部项目（含归档，label 标注）
  const [pid, setPid] = useState(null)           // 当前选中项目 id
  const [hook, setHook] = useState(null)         // 选中项目的推送绑定（webhook 打码回显）
  const [input, setInput] = useState({ webhook_url: '', webhook_secret: '' })
  const [applyAll, setApplyAll] = useState(false)  // 勾选=保存时写入本人全部未归档项目
  const [busy, setBusy] = useState(false)

  // 项目列表仅拉一次，默认选中第一个未归档项目（无项目时下拉为空态）
  useEffect(() => {
    let alive = true
    projectApi.list().then((list) => {
      if (!alive) return
      setProjects(list)
      const def = list.find((p) => !p.archived) || list[0]
      if (def) setPid(def.id)
    }).catch((e) => toast(e.message))
    return () => { alive = false }
  }, [])

  // 切换项目：清空待填输入并拉取该项目绑定；alive 守卫防快速切换时旧响应覆盖
  useEffect(() => {
    setInput({ webhook_url: '', webhook_secret: '' })
    if (!pid) { setHook(null); return }
    let alive = true
    projectApi.feishuHookGet(pid).then((r) => { if (alive) setHook(r) })
      .catch(() => { if (alive) setHook(null) })
    return () => { alive = false }
  }, [pid])

  async function save() {
    if (!pid || !hook) return
    setBusy(true)
    try {
      // 保存目标由 utils/feishuHook 统一构造（勾选批量则走 /api/me/feishu-hook/apply）
      const req = hookSaveRequest(applyAll, pid, hook, input)
      if (req.kind === 'all') {
        const r = await projectApi.feishuHookApplyAll(req.body)
        setInput({ webhook_url: '', webhook_secret: '' })
        toast(applyResultText(r))
      } else {
        await projectApi.feishuHookSet(req.pid, req.body)
        setInput({ webhook_url: '', webhook_secret: '' })
        toast(t('项目飞书推送配置已保存'))
      }
      projectApi.feishuHookGet(pid).then(setHook).catch(() => { /* 回显失败不报错，保存已生效 */ })
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  // 项目可搜索下拉选项（label 含归档标注，search 附项目目录便于按路径找项目）
  const options = projects.map((p) => ({
    value: p.id,
    label: p.name + (p.archived ? t('（已归档）') : ''),
    search: p.project_dir || '',
  }))
  // 批量应用的目标数量（已归档项目不参与，与后端 archived_skipped 同口径）
  const unarchivedCount = projects.filter((p) => !p.archived).length

  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Webhook className="size-4 text-[var(--star-text)]" /> {t('项目推送绑定')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">
          {t('每个项目可单独绑定推送群与事件开关；未绑定或未启用时回落上方的默认推送 Webhook。群 Webhook 消息与飞书单聊交互卡片共用这里的开关。')}
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">{t('项目')}</Label>
          <SearchSelect options={options} value={pid} onChange={setPid}
            placeholder={projects.length ? t('选择项目…') : t('暂无项目')}
            emptyHint={t('无匹配项目')} />
        </div>
        {!projects.length ? null : !hook ? (
          <div className="text-xs text-muted-foreground">{t('加载中…')}</div>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!hook.enabled}
                onChange={(e) => setHook({ ...hook, enabled: e.target.checked })} />
              {t('启用推送')}
            </label>
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">{t('群机器人 Webhook')}</Label>
              <Input value={input.webhook_url} onChange={(e) => setInput({ ...input, webhook_url: e.target.value })}
                placeholder={hook.webhook_url
                  ? t('已绑定：{url}（留空保持）', { url: hook.webhook_url })
                  : t('飞书群自定义机器人 Webhook URL')} />
            </div>
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">{t('签名密钥（机器人开启签名校验时）')}</Label>
              <Input type="password" value={input.webhook_secret} onChange={(e) => setInput({ ...input, webhook_secret: e.target.value })}
                placeholder={hook.has_webhook_secret ? t('已设置（留空保持不变）') : t('可空')} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {HOOK_EVENTS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={hook.events.includes(k)}
                    onChange={(e) => setHook({
                      ...hook,
                      events: e.target.checked
                        ? [...hook.events, k]
                        : hook.events.filter((x) => x !== k),
                    })} />
                  {label(t)}
                </label>
              ))}
            </div>
            <div className="hint">{t('交互等待 / 任务失败默认推送；卡片待审核默认关。Webhook 与签名密钥留空保存时不下发（保持现有值）。')}</div>
            <div className="hint">{t('以上开关同时管「群 Webhook 消息」与「飞书单聊交互卡片」：取消勾选「启用推送」后该项目不再推送，事件不勾的也不会推。')}</div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)} />
              {t('同时应用到我的全部项目（{n} 个未归档项目；已归档项目不动）', { n: unarchivedCount })}
            </label>
            <div>
              <Button variant="outline" disabled={busy} onClick={save}>
                {applyAll ? t('保存并应用到全部项目') : t('保存项目推送')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// 飞书接入（M5 配置自动化，2026-10-10）：把「开发者后台六步」压成一次扫码——
// 扫码创建应用（后端能力，创建时即预置权限/事件/回调）→ 自动起
// 长连接 → 自动补齐应用配置 → 可一键提交发布。所有写动作都由用户点击触发；
// 服务端 TS_FEISHU_PROVISION=0 可整体关闭。等待扫码期间 3s 轮询一次，完成即停。
// 两个闸门正交（M9，2026-10-15）：supported=本机后端有没有扫码建应用能力（只关扫码入口），
// enabled=配置自动化总开关（关全部写操作）；判定与文案见 utils/feishuProvision.js。
function ProvisionCard({ onCfgChanged }) {
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  const [st, setSt] = useState(null)         // {supported,enabled,state,url,error,app_id,steps}
  const [result, setResult] = useState(null) // apply / publish 的结果摘要
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setSt(await meApi.feishuProvisionGet()) } catch (e) { toast(e.message) }
  }
  useEffect(() => { load() }, [])

  // 等待扫码：3s 轮询，状态离开 waiting 即停并刷新上方凭据卡（凭据已自动入库）
  useEffect(() => {
    if (st?.state !== 'waiting') return undefined
    const timer = setInterval(async () => {
      try {
        const r = await meApi.feishuProvisionGet()
        setSt(r)
        if (r.state === 'success') {
          toast(t('应用已创建：{app_id}', { app_id: r.app_id }))
          onCfgChanged?.()
        } else if (r.state === 'failed') {
          toast(r.error || t('扫码创建失败'))
        }
      } catch (e) { /* 轮询失败不打扰用户，下一拍重试 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [st?.state])

  async function run(action, body, okMsg) {
    setBusy(true)
    try {
      const r = await meApi.feishuProvisionSet(action, body || {})
      if (action === 'start') {
        setSt((s) => ({ ...(s || {}), state: r.state, url: r.url, error: r.error }))
        if (!r.ok) toast(r.error || t('发起失败'))
      } else {
        setResult({ action, ...r })
        if (r.ok) toast(okMsg)
        else toast(r.error || t('操作失败'))
        await load()
      }
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  const state = st?.state || 'idle'
  // 两个闸门是正交的（M9 拆细，2026-10-15）：supported=本机后端能不能扫码建应用，
  // enabled=配置自动化总开关。曾经合成一个 disabled 喂给三个按钮 ⇒ supported 恒 false 时
  // 「补齐应用配置」「提交发布」被连坐禁掉，整卡不可操作。判定与文案见 utils/feishuProvision.js。
  const gates = provisionGates(st)
  const notices = provisionNotices(st)
  // 二维码链接：后端两版都是**对象**（oracle 原样存 SDK 回调的 dict，见 utils/feishuProvision.js），
  // 直接渲染 st.url 会显示 [object Object]。取值统一走 provisionQrUrl（双形态容错）。
  const qrUrl = provisionQrUrl(st)
  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wand2 className="size-4 text-[var(--star-text)]" /> {t('飞书接入（扫码一键配置）')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        {!st ? (
          <div className="text-xs text-muted-foreground">{t('加载中…')}</div>
        ) : (
          <>
            <div className="text-xs leading-relaxed text-muted-foreground">
              {t('没有应用也能开始：点「扫码创建飞书应用」→ 用手机飞书打开链接确认 → 平台自动拿到 App ID / Secret、建长连接，并自动开通所需权限、订阅事件与卡片回调。 发布新版本仍需企业管理员审批（或请管理员对该应用开「免审」）。')}
            </div>
            {notices.map((n) => (
              <div key={n.key} className={n.tone === 'closed' ? 'text-xs text-[var(--star-text)]' : 'text-xs text-destructive'}>
                {n.text}
              </div>
            ))}
            {state === 'waiting' && (
              <div className="rounded-md border border-border bg-accent/40 px-3 py-2 text-xs">
                <div>{t('等待你在飞书里确认（链接 10 分钟内有效）：')}</div>
                {qrUrl ? (
                  <div className="mt-1 break-all font-mono text-[11px]">{qrUrl}</div>
                ) : (
                  <div className="mt-1 text-muted-foreground">{t('正在获取确认链接…')}</div>
                )}
                <div className="mt-1 flex gap-2">
                  {qrUrl && (
                    <Button variant="ghost" size="sm"
                      onClick={() => { navigator.clipboard?.writeText(qrUrl); toast(t('链接已复制')) }}>
                      {t('复制链接')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => run('cancel')}>{t('取消')}</Button>
                </div>
              </div>
            )}
            {state === 'failed' && st.error && (
              <div className="text-xs text-destructive">{st.error}</div>
            )}
            {state === 'success' && (
              <div className="text-xs">
                {t('已接入应用')} <span className="font-mono">{st.app_id}</span>
                {st.error ? <div className="text-destructive">{st.error}</div> : null}
              </div>
            )}
            {!!(st.steps || []).length && (
              <div className="rounded border border-border/60 text-xs">
                {st.steps.map((s) => (
                  <div key={s.key} className="flex items-start gap-2 border-b border-border/40 px-2 py-1.5 last:border-0">
                    <span>{s.ok ? '✅' : '❌'}</span>
                    <span className="shrink-0">{s.label}</span>
                    <span className="truncate text-muted-foreground" title={s.detail}>{s.detail}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy || gates.scanDisabled || state === 'waiting'}
                onClick={() => {
                  if (st.app_id && !window.confirm(
                    t('当前已接入应用 {app_id}，重新扫码会换成新应用，继续？', { app_id: st.app_id }))) return
                  run('start', { force: !!st.app_id })
                }}>
                {t('扫码创建飞书应用')}
              </Button>
              <Button variant="ghost" disabled={busy || gates.writeDisabled}
                onClick={() => run('apply', {}, t('应用配置已补齐（发布后线上生效）'))}>
                {t('补齐应用配置')}
              </Button>
              <Button variant="ghost" disabled={busy || gates.writeDisabled}
                onClick={() => {
                  // 发布 = 向企业管理员提交一个待审版本，误点代价高：先确认
                  if (!window.confirm(t('把当前改动作为新版本提交给企业管理员审批？（发布后需管理员同意才线上生效）'))) return
                  run('publish', {}, t('已提交发布，等管理员审批'))
                }}>
                {t('提交发布')}
              </Button>
              <Button variant="ghost" disabled={busy || gates.refreshDisabled} onClick={load}>{t('刷新状态')}</Button>
            </div>
            {result?.action === 'publish' && result.ok && (
              <div className="text-xs text-muted-foreground">
                {t('已提交版本 {version}（version_id={vid}）；企业管理员审批通过后线上生效。',
                  { version: result.version, vid: result.version_id || '-' })}
              </div>
            )}
            <div className="hint">
              {t('「补齐应用配置」会写你飞书应用的权限/事件订阅/回调（需 application:application:patch 权限，缺权限会给出开通指引）；一键接入不需要它——扫码创建时已按平台清单预置。')}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// 配置自检（M5）：八项体检逐项给结论与修复指引。今天配错了只能翻日志，这里一眼看全。
// 「发送测试消息」会给已绑定的飞书账号发一条 DM（服务端 60s 频控），用来验证发消息权限。
const DOCTOR_MARKS = { ok: '✅', warn: '⚠️', fail: '❌', skip: '➖' }

function DoctorCard() {
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  const [items, setItems] = useState(null)
  const [summary, setSummary] = useState(null)
  const [probe, setProbe] = useState(false)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      const r = await meApi.feishuDoctor(probe)
      setItems(r.items || [])
      setSummary(r.summary || null)
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  // 刻意**不**在挂载时自动跑：自检会对真实飞书发只读请求（token/bot/斜杠），
  // 每次进设置页都静默打网络既慢又意外——由用户点「运行自检」触发。
  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Stethoscope className="size-4 text-[var(--star-text)]" /> {t('配置自检')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">
          {t('逐项检查「凭据/机器人能力/长连接/事件订阅/权限」，红色项按提示修即可。')}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} />
          {t('发送测试消息（验证「发消息」权限，会给你已绑定的飞书账号发一条 DM）')}
        </label>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={run}>{t('运行自检')}</Button>
          {!items && <span className="self-center text-xs text-muted-foreground">{t('点「运行自检」开始（会读取你应用的凭据与权限状态）')}</span>}
        </div>
        {items && (
          <div className="rounded border border-border/60 text-xs">
            {items.map((it) => (
              <div key={it.key} className="border-b border-border/40 px-2 py-1.5 last:border-0">
                <div className="flex items-start gap-2">
                  <span className="shrink-0">{DOCTOR_MARKS[it.state] || '•'}</span>
                  <span className="shrink-0">{it.label}</span>
                  <span className="text-muted-foreground">{it.detail}</span>
                </div>
                {it.hint ? <div className="mt-0.5 pl-6 text-muted-foreground">{t('提示：{hint}', { hint: it.hint })}</div> : null}
              </div>
            ))}
          </div>
        )}
        {summary && (
          <div className="text-xs text-muted-foreground">
            {t('汇总：通过 {ok}、待修 {fail}、提醒 {warn}、跳过 {skip}',
              { ok: summary.ok, fail: summary.fail, warn: summary.warn, skip: summary.skip })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// 快捷指令（Slash Command）：把平台指令注册到飞书，用户在机器人私聊输入框里打「/」时，
// 输入框上方弹出指令面板，选中后以「/名称 [参数]」文本发给机器人——入站仍走既有长连接，
// 由 feishu.parse_intent 的斜杠别名落到与中文指令同一套执行器（入站链路零分叉）。
// 同步只增改本平台自己的指令，绝不动用户应用里的其他指令；生效约 5 分钟 + 客户端约 3 分钟缓存。
function SlashCommandCard() {
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  const [data, setData] = useState(null)     // {configured, desired, remote, extra, error}
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // 上次同步/清除的结果摘要

  async function load() {
    try { setData(await meApi.feishuSlashGet()) } catch (e) { toast(e.message) }
  }

  useEffect(() => { load() }, [])

  async function run(action) {
    setBusy(true)
    try {
      const r = await meApi.feishuSlashSet(action)
      setResult({ action, ...r })
      if (action === 'notify') {
        if (r.ok) toast(t('权限引导卡片已发到你的飞书私聊，点卡片上的按钮即可重试注册'))
        else toast(r.error || t('卡片发送失败'))
      } else if (!r.ok) {
        toast(r.card_sent
          ? t('需要先开通权限：已把引导卡片发到你的飞书私聊')
          : (r.error || t('操作失败，请看卡片上的提示')))
      } else if (action === 'sync') {
        toast(t('同步完成：新增 {created}、更新 {updated}、已最新 {kept}', {
          created: r.created.length, updated: r.updated.length, kept: r.kept.length,
        }))
      } else {
        toast(t('已清除 {n} 条 TS 指令', { n: r.deleted.length }))
      }
      await load()
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  const remote = data?.remote || []
  const desired = data?.desired || []
  const registered = new Set(remote.map((r) => r.command))
  // 待同步 = 未注册，或说明/图标与平台清单不一致（同步即收敛）
  const stale = desired.filter((d) => {
    const r = remote.find((x) => x.command === d.command)
    return !r || r.description !== d.description || r.icon !== d.icon
  })

  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Command className="size-4 text-[var(--star-text)]" /> {t('快捷指令（输入框打「/」）')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">
          {t('把平台指令注册成飞书斜杠指令：机器人私聊里输入「/」即可从指令面板选 /status、/cards、/approve 等（选中后以「/名称 [参数]」发给机器人，用法与中文指令一致）。同步只增改本平台的指令，不影响你应用里的其他指令。')}
        </div>
        {!data ? (
          <div className="text-xs text-muted-foreground">{t('加载中…')}</div>
        ) : (
          <>
            {data.error && <div className="text-xs text-destructive">{data.error}</div>}
            {data.need_scope && (
              <div className="text-xs text-[var(--star-text)]">
                {t('缺「应用指令」权限：点「发飞书权限卡片」→ 你的飞书私聊会收到一张引导卡片，在上面点「我已开通，重试注册」即由后端重试（无需回站点手动重试）。')}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => run('sync')}>{t('注册 / 同步到飞书')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => run('notify')}>{t('发飞书权限卡片')}</Button>
              <Button variant="ghost" disabled={busy} onClick={load}>{t('刷新状态')}</Button>
              <Button variant="ghost" disabled={busy || !registered.size}
                onClick={() => {
                  if (window.confirm(t('删除飞书侧本平台的斜杠指令？（你应用里的其他指令不受影响）'))) run('clear')
                }}>
                {t('清除 TS 指令')}
              </Button>
            </div>
            <div className="text-xs">
              {t('已注册 {n} / {total} 条', { n: registered.size, total: desired.length })}
              {stale.length ? t('，待同步 {n} 条', { n: stale.length }) : t('，均已与平台一致')}
              {data.extra?.length ? t('；另有 {n} 条非 TS 指令（不会改动）', { n: data.extra.length }) : ''}
            </div>
            <div className="max-h-52 overflow-y-auto rounded border border-border/60 text-xs">
              {!desired.length ? <div className="px-2 py-3 text-muted-foreground">{t('暂无可注册指令')}</div> : desired.map((d) => (
                <div key={d.command} className="flex items-center gap-2 border-b border-border/40 px-2 py-1.5 last:border-0">
                  <Badge variant={registered.has(d.command) ? 'secondary' : 'outline'}>
                    {registered.has(d.command) ? t('已注册') : t('未注册')}
                  </Badge>
                  <span className="shrink-0 font-mono">/{d.command}</span>
                  <span className="truncate text-muted-foreground" title={d.description}>{d.description}</span>
                </div>
              ))}
            </div>
            {result && (
              <div className="text-xs text-muted-foreground">
                {result.action === 'sync'
                  ? t('上次同步：新增 {created}、更新 {updated}、已最新 {kept}', {
                    created: result.created?.length || 0,
                    updated: result.updated?.length || 0,
                    kept: result.kept?.length || 0,
                  })
                  : result.action === 'notify'
                    ? t('权限引导卡片已发送（去飞书私聊查看）')
                    : t('上次清除：删除 {n} 条', { n: result.deleted?.length || 0 })}
                {result.card_sent ? (
                  <div className="text-[var(--star-text)]">{t('已把权限引导卡片发到你的飞书私聊，点卡片上的「我已开通，重试注册」即自动重试')}</div>
                ) : null}
                {result.card_error ? <div className="text-destructive">{result.card_error}</div> : null}
                {result.failed?.length ? (
                  <div className="text-destructive" title={result.failed.join('\n')}>{result.failed[0]}</div>
                ) : null}
              </div>
            )}
            <div className="hint">
              {t('权限：应用需开通 application:app_slash_command:read / write 并**创建版本发布**才可用；缺权限时可点「发飞书权限卡片」，在飞书卡片上确认后自动重试。注册结果约 5 分钟同步到客户端（客户端另有约 3 分钟缓存，重启飞书客户端可加速）；PC 飞书需 7.70+、移动端 7.71+。')}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
