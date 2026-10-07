import { useState, useEffect, useRef } from 'react'
import { builtinAssetApi, projectApi } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { toast } from '../../utils/toast'
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

const STATE_META = {
  absent: { label: '未安装', cls: 'none', action: '安装' },
  installed: { label: '已安装', cls: 'ok', action: '重新安装' },
  outdated: { label: '可更新', cls: 'warn', action: '更新' },
  partial: { label: '需修复', cls: 'bad', action: '修复' },
}

// dsh 插件注册行状态文案（服务端 plugin.patch_mode）
const PATCH_MODE_TEXT = {
  marked: '平台注册（可整块卸载）',
  canonical: '手工注册（文本规范，平台可代管）',
  foreign: '自定义写法（平台只报告、不改动）',
  '': '未注册',
}

export default function AssetsPanel() {
  const auth = useAuthStore()
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
        toast(`已卸载「${a.name}」`)
      } else if (r.state === 'installed') {
        // dsh 插件装/卸后是否需要重启 dsh：web profile 声明 patchReload: live，改注册行
        // 即热生效；没有该声明的 profile 只能重启（服务端 restart_required）——
        // 文案不能一律说「对之后新起的会话生效」，那对插件是错的
        toast(r.restart_required
          ? `已安装「${a.name}」，需重启 dsh 生效`
          : (a.type === 'dsh_plugin'
            ? `已安装「${a.name}」，注册行已写入（热生效）`
            : `已安装「${a.name}」，对之后新起的 agent 会话生效`))
      } else {
        toast(`「${a.name}」安装后状态：${(STATE_META[r.state] || {}).label || r.state}`)
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
            <Boxes className="size-4 text-primary" /> 内置资产
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-5">
          <div className="text-xs leading-relaxed text-muted-foreground">
            安装平台内置资产（清单 = 仓库 <span className="font-mono">extensions/*/asset.json</span>），
            两类：<span className="font-mono">skill</span>（技能文件）与
            <span className="font-mono">dsh_plugin</span>（dsh 原生插件：拷进 dsh profile 的
            node_modules 并写入 <span className="font-mono">cordis.patch.yml</span> 注册行，仅用户级）。
            用户级写服务进程 HOME（如 <span className="font-mono">~/.dsh/skills</span>、
            <span className="font-mono">~/.dsh/profiles</span>），影响本机所有项目、仅管理员可操作；
            项目级写所选项目目录（如 <span className="font-mono">&lt;项目&gt;/.dsh/skills</span>），仅项目所有者可操作。
            安装 = 收敛到清单期望状态（已装的会按内容更新）。
          </div>
          <div className="ext-seg">
            <button type="button" className={target === 'user' ? 'active' : ''}
              onClick={() => setTarget('user')}>用户级（本机）</button>
            <button type="button" className={target === 'project' ? 'active' : ''}
              onClick={() => setTarget('project')}>项目级（所选项目）</button>
          </div>
          {target === 'project' && (
            projects.length > 0 ? (
              <div style={{ maxWidth: 320 }}>
                <SearchSelect
                  options={projects.map((p) => ({
                    value: p.id,
                    label: p.name + (p.archived ? '（已归档）' : ''),
                    search: p.project_dir,
                  }))}
                  value={pid} onChange={setPid} placeholder="选择项目" />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                还没有项目：先在项目页创建项目，再回来装项目级资产。
              </div>
            )
          )}
          {target === 'user' && !auth.isAdmin && (
            <div className="text-xs text-destructive">
              用户级安装会写入本机 agent 配置、影响所有项目，仅管理员可操作——此处对你只读。
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
            该目标下暂无可安装的内置资产。
          </CardContent>
        </Card>
      )}
      {!data && (
        <Card className="max-w-2xl py-4">
          <CardContent className="px-5 text-xs text-muted-foreground">
            {target === 'project' && !pid ? '请先选择项目。' : '加载中…'}
          </CardContent>
        </Card>
      )}
    </>
  )
}

// 单个资产卡：名称 + 类型/适用族/状态徽标 + 描述 + 落点明细 + 安装/卸载按钮
function AssetCard({ a, target, canInstall, busy, onAct }) {
  const st = STATE_META[a.state] || STATE_META.absent
  const blocked = !a.supported || !canInstall
  const installing = busy === `${a.id}:install`
  const uninstalling = busy === `${a.id}:uninstall`

  function uninstall() {
    const what = a.type === 'dsh_plugin'
      ? `会删除插件包文件与平台写的注册行（用户自定义写法的注册行一律不动，遇到会拒绝并说明）。`
      : `会删除平台安装进技能目录的文件（用户手工放的同名文件不动）。`
    if (!window.confirm(`确认卸载「${a.name}」？\n${what}`)) return
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
          <span className={'ext-state ' + st.cls}>{st.label}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">{a.description}</div>

        {a.files.map((f) => (
          <div key={f.to} className="ext-path">
            {f.path}{f.exists ? (f.same ? '' : '（内容与仓库不一致）') : '（尚未安装）'}
          </div>
        ))}

        {/* dsh 插件：注册行明细（文件到位不等于生效——没注册行 / 被 dsh 面板停用都不生效） */}
        {a.plugin && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            <div className="ext-path">
              {a.plugin.patch_path} —— 注册行：
              {PATCH_MODE_TEXT[a.plugin.patch_mode] || a.plugin.patch_mode}
              {a.plugin.disabled ? '（已被 dsh 面板停用，安装会重新启用）' : ''}
            </div>
            <div>
              插件包 <span className="font-mono">{a.plugin.package}</span> · profile{' '}
              <span className="font-mono">{a.plugin.profile}</span>
              {a.plugin.restart_required ? ' · 该 profile 未开 patchReload，装完需重启 dsh 生效' : ' · 改注册行即热生效'}
            </div>
            {!a.plugin.requires_ok && (
              <div className="text-destructive">
                依赖解析不到：{(a.plugin.requires || []).filter((r) => !r.ok).map((r) => r.spec).join('、')}
                ——dsh 自带包需在 profile 的 node_modules 里有对应链接（同目录软链），否则插件加载即报模块缺失。
              </div>
            )}
          </div>
        )}

        {!a.supported && <div className="text-xs text-destructive">{a.reason}</div>}
        {a.state === 'outdated' && (
          <div className="text-xs text-destructive">
            已装文件与仓库版本不一致（可能被本地改过）：更新会用仓库版本覆盖，需要保留本地改动请先另存。
          </div>
        )}
        {a.supported && !canInstall && (
          <div className="text-xs text-destructive">
            {target === 'user' ? '用户级安装仅管理员可操作，此处只读。' : '你没有该项目的操作权限。'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={blocked || !!busy} onClick={() => onAct(a, 'install')}>
            <Download /> {installing ? '处理中…' : st.action}
          </Button>
          <Button size="sm" variant="ghost" disabled={blocked || !!busy || a.state === 'absent'}
            onClick={uninstall} title={a.state === 'absent' ? '尚未安装' : undefined}>
            <Trash2 /> {uninstalling ? '卸载中…' : '卸载'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
