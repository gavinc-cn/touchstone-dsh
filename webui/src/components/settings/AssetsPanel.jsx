import { useState, useEffect, useRef } from 'react'
import { builtinAssetApi, projectApi } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { toast } from '../../utils/toast'
import { useI18n } from '../../utils/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import SearchSelect from '@/components/ui/search-select'
import { Boxes, Download, Trash2 } from 'lucide-react'

// 内置资产安装面板（设置页「内置资产」分区，2026-09-23；2026-10-03 P7b-B3 去 hook；
// 2026-10-04 P8 增 dsh 插件类）：
// 平台仓库 extensions/*/asset.json 声明的资产，两类：
// ① skill —— 一键装到「用户级」（服务进程 HOME 的技能目录，如 ~/.dsh/skills，影响本机
//    所有项目，仅管理员可写）或「项目级」（所选项目目录，如 <项目>/.dsh/skills，仅项目
//    所有者）；
// ② dsh_plugin —— dsh 原生插件（手放型：拷进 dsh profile 的 node_modules + 在
//    <profile>/cordis.patch.yml 写注册行），只支持用户级（profile 级资产，与项目无关）。
// 后端安装语义 = 收敛到清单期望状态（文件按内容覆盖），状态四态
// absent / installed / outdated / partial 由服务端推导（dsh 插件另叠注册行状态：
// 注册行缺失/被 dsh 面板停用 ⇒ partial）。
// （kimi hook 资产的 config.toml [[hooks]] 注册半边已随族退场删除；dsh 插件的注册行走
// plugin 段的 insert 行。）

// 状态四态的标签与动作：值是 (t) => 文案 的取值函数——t 在渲染时求值，
// 切换语言即时重渲染（模块级 t() 会定格在导入时的语言）
const STATE_META = {
  absent: { label: (t) => t('未安装'), cls: 'none', action: (t) => t('安装') },
  installed: { label: (t) => t('已安装'), cls: 'ok', action: (t) => t('重新安装') },
  outdated: { label: (t) => t('可更新'), cls: 'warn', action: (t) => t('更新') },
  partial: { label: (t) => t('需修复'), cls: 'bad', action: (t) => t('修复') },
}

// dsh 插件注册行状态文案（服务端 plugin.patch_mode）：同样是 (t) => 文案
const PATCH_MODE_TEXT = {
  marked: (t) => t('平台注册（可整块卸载）'),
  canonical: (t) => t('手工注册（文本规范，平台可代管）'),
  foreign: (t) => t('自定义写法（平台只报告、不改动）'),
  '': (t) => t('未注册'),
}

export default function AssetsPanel() {
  const auth = useAuthStore()
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  const [target, setTarget] = useState('user')   // user（本机用户级）| project（项目级）
  const [projects, setProjects] = useState([])
  const [pid, setPid] = useState(null)
  const [data, setData] = useState(null)         // 服务端回显 {target, project_id, can_install, assets}
  const [busy, setBusy] = useState('')           // `${assetId}:install|uninstall`
  const seqRef = useRef(0)                       // 响应序号：快速切目标时丢弃过期回包

  // 项目列表（项目级目标的下拉）：只拉一次，默认选中第一个未归档项目
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

  async function load() {
    const seq = ++seqRef.current
    try {
      const d = await builtinAssetApi.list(target, pid)
      if (seq === seqRef.current) setData(d)
    } catch (e) {
      if (seq === seqRef.current) toast(e.message)
    }
  }

  // 切目标 / 切项目即重拉（先清空防旧目标数据串档）
  useEffect(() => {
    setData(null)
    if (target === 'project' && !pid) return
    load()
  }, [target, pid]) // eslint-disable-line react-hooks/exhaustive-deps

  // 安装（含更新/修复）/ 卸载：成功后重拉状态；失败原因由服务端 error 文本 toast
  async function act(a, kind) {
    setBusy(`${a.id}:${kind}`)
    try {
      const r = kind === 'install'
        ? await builtinAssetApi.install(a.id, target, pid)
        : await builtinAssetApi.uninstall(a.id, target, pid)
      if (kind === 'uninstall') {
        toast(t('已卸载「{name}」', { name: a.name }))
      } else if (r.state === 'installed') {
        // dsh 插件装/卸后是否需要重启 dsh：web profile 声明 patchReload: live，改注册行
        // 即热生效；没有该声明的 profile 只能重启（服务端 restart_required）——
        // 文案不能一律说「对之后新起的会话生效」，那对插件是错的
        toast(r.restart_required
          ? t('已安装「{name}」，需重启 dsh 生效', { name: a.name })
          : (a.type === 'dsh_plugin'
            ? t('已安装「{name}」，注册行已写入（热生效）', { name: a.name })
            : t('已安装「{name}」，对之后新起的 agent 会话生效', { name: a.name })))
      } else {
        toast(t('「{name}」安装后状态：{state}', {
          name: a.name,
          state: STATE_META[r.state] ? STATE_META[r.state].label(t) : r.state,
        }))
      }
      await load()
    } catch (e) {
      toast(e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <Card className="max-w-2xl gap-4 py-4">
        <CardHeader className="px-5 pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Boxes className="size-4 text-[var(--star-text)]" /> {t('内置资产')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-5">
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t('安装平台内置资产（清单 = 仓库')} <span className="font-mono">extensions/*/asset.json</span>{t('），两类：')}
            <span className="font-mono">skill</span>{t('（技能文件）与')}
            <span className="font-mono">dsh_plugin</span>{t('（dsh 原生插件：拷进 dsh profile 的 node_modules 并写入')} <span className="font-mono">cordis.patch.yml</span> {t('注册行，仅用户级）。用户级写服务进程 HOME（如')} <span className="font-mono">~/.dsh/skills</span>
            {t('、')}<span className="font-mono">~/.dsh/profiles</span>{t('），影响本机所有项目、仅管理员可操作；项目级写所选项目目录（如')} <span className="font-mono">{t('<项目>/.dsh/skills')}</span>{t('），仅项目所有者可操作。安装 = 收敛到清单期望状态（已装的会按内容更新）。')}
          </div>
          <div className="ext-seg">
            <button type="button" className={target === 'user' ? 'active' : ''}
              onClick={() => setTarget('user')}>{t('用户级（本机）')}</button>
            <button type="button" className={target === 'project' ? 'active' : ''}
              onClick={() => setTarget('project')}>{t('项目级（所选项目）')}</button>
          </div>
          {target === 'project' && (
            projects.length > 0 ? (
              <div style={{ maxWidth: 320 }}>
                <SearchSelect
                  options={projects.map((p) => ({
                    value: p.id,
                    label: p.name + (p.archived ? t('（已归档）') : ''),
                    search: p.project_dir,
                  }))}
                  value={pid} onChange={setPid} placeholder={t('选择项目')} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {t('还没有项目：先在项目页创建项目，再回来装项目级资产。')}
              </div>
            )
          )}
          {target === 'user' && !auth.isAdmin && (
            <div className="text-xs text-destructive">
              {t('用户级安装会写入本机 agent 配置、影响所有项目，仅管理员可操作——此处对你只读。')}
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.assets.map((a) => (
        <AssetCard key={a.id} a={a} target={target} canInstall={data.can_install}
          busy={busy} onAct={act} />
      ))}
      {data && data.assets.length === 0 && (
        <Card className="max-w-2xl py-4">
          <CardContent className="px-5 text-xs text-muted-foreground">
            {t('该目标下暂无可安装的内置资产。')}
          </CardContent>
        </Card>
      )}
      {!data && (
        <Card className="max-w-2xl py-4">
          <CardContent className="px-5 text-xs text-muted-foreground">
            {target === 'project' && !pid ? t('请先选择项目。') : t('加载中…')}
          </CardContent>
        </Card>
      )}
    </>
  )
}

// 单个资产卡：名称 + 类型/适用族/状态徽标 + 描述 + 落点明细 + 安装/卸载按钮
function AssetCard({ a, target, canInstall, busy, onAct }) {
  // 文案取 t()：切换语言即时重渲染
  const { t } = useI18n()
  const st = STATE_META[a.state] || STATE_META.absent
  const blocked = !a.supported || !canInstall
  const installing = busy === `${a.id}:install`
  const uninstalling = busy === `${a.id}:uninstall`

  function uninstall() {
    const what = a.type === 'dsh_plugin'
      ? t('会删除插件包文件与平台写的注册行（用户自定义写法的注册行一律不动，遇到会拒绝并说明）。')
      : t('会删除平台安装进技能目录的文件（用户手工放的同名文件不动）。')
    if (!window.confirm(t('确认卸载「{name}」？', { name: a.name }) + '\n' + what)) return
    onAct(a, 'uninstall')
  }

  return (
    <Card className="max-w-2xl gap-3 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {a.name}
          <span className="ext-kind">{a.type_label || a.type}</span>
          {/* 族标签与类型标签同义时（dsh_plugin 只有一族）不重复渲染 */}
          {a.family_label && a.family_label !== (a.type_label || a.type) && (
            <span className="ext-kind">{a.family_label}</span>
          )}
          <span className={'ext-state ' + st.cls}>{st.label(t)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">{a.description}</div>

        {a.files.map((f) => (
          <div key={f.to} className="ext-path">
            {f.path}{f.exists ? (f.same ? '' : t('（内容与仓库不一致）')) : t('（尚未安装）')}
          </div>
        ))}

        {/* dsh 插件：注册行明细（文件到位不等于生效——没注册行 / 被 dsh 面板停用都不生效） */}
        {a.plugin && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            <div className="ext-path">
              {a.plugin.patch_path}{t(' —— 注册行：')}
              {PATCH_MODE_TEXT[a.plugin.patch_mode] ? PATCH_MODE_TEXT[a.plugin.patch_mode](t) : a.plugin.patch_mode}
              {a.plugin.disabled ? t('（已被 dsh 面板停用，安装会重新启用）') : ''}
            </div>
            <div>
              {t('插件包')} <span className="font-mono">{a.plugin.package}</span> · profile{' '}
              <span className="font-mono">{a.plugin.profile}</span>
              {a.plugin.restart_required
                ? t(' · 该 profile 未开 patchReload，装完需重启 dsh 生效')
                : t(' · 改注册行即热生效')}
            </div>
            {!a.plugin.requires_ok && (
              <div className="text-destructive">
                {t('依赖解析不到：')}{(a.plugin.requires || []).filter((r) => !r.ok).map((r) => r.spec).join(t('、'))}
                {t('——dsh 自带包需在 profile 的 node_modules 里有对应链接（同目录软链），否则插件加载即报模块缺失。')}
              </div>
            )}
          </div>
        )}

        {!a.supported && <div className="text-xs text-destructive">{a.reason}</div>}
        {a.state === 'outdated' && (
          <div className="text-xs text-destructive">
            {t('已装文件与仓库版本不一致（可能被本地改过）：更新会用仓库版本覆盖，需要保留本地改动请先另存。')}
          </div>
        )}
        {a.supported && !canInstall && (
          <div className="text-xs text-destructive">
            {target === 'user' ? t('用户级安装仅管理员可操作，此处只读。') : t('你没有该项目的操作权限。')}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={blocked || !!busy} onClick={() => onAct(a, 'install')}>
            <Download /> {installing ? t('处理中…') : st.action(t)}
          </Button>
          <Button size="sm" variant="ghost" disabled={blocked || !!busy || a.state === 'absent'}
            onClick={uninstall} title={a.state === 'absent' ? t('尚未安装') : undefined}>
            <Trash2 /> {uninstalling ? t('卸载中…') : t('卸载')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
