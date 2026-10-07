import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '../stores/auth'
import { authApi } from '../api'
import { toast } from '../utils/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Boxes, Brain, Check, KeyRound, Link2, LogOut, Palette } from 'lucide-react'
import { SKINS, applySkin, getSkin } from '../utils/skin'
import { FONT_SCALES, applyFontScale, getFontScale } from '../utils/fontScale'
import RagPanel from '../components/settings/RagPanel.jsx'
import FeishuPanel from '../components/settings/FeishuPanel.jsx'
import AssetsPanel from '../components/settings/AssetsPanel.jsx'

// 设置分区定义：左侧列表按此顺序渲染，key 同时是 URL 段（/settings/<key>，可深链/分享）
// admin=true 的分区仅管理员可见（RAG 配置是机器级全局配置，影响所有用户的任务；
// P7b B2：原「Agent 设置」分区是 kimi web 实例参数，随族退场删除——dsh 由 profile 自管）
// assets（内置资产）对所有用户可见——用户级安装写机器上的技能目录（写操作仅 admin，
// 普通用户只读），项目级安装写自己项目的目录，权限在服务端按目标分别把关
// （P7b B3：hook 半边随族退场，只剩 skill 资产）
const SECTIONS = [
  { key: 'appearance', label: '外观主题', icon: Palette, admin: false },
  { key: 'password', label: '修改密码', icon: KeyRound, admin: false },
  { key: 'feishu', label: '飞书设置', icon: Link2, admin: false },
  { key: 'assets', label: '内置资产', icon: Boxes, admin: false },
  { key: 'rag', label: 'RAG 检索配置', icon: Brain, admin: true },
]

// 设置页（侧栏「设置」进入的独立页面）：左侧分区列表 + 右侧分区内容
export default function Settings() {
  const navigate = useNavigate()
  const params = useParams()
  const auth = useAuthStore()

  const sections = SECTIONS.filter((s) => !s.admin || auth.isAdmin)
  // 非法分区段（含非管理员手输 rag）回落第一个可见分区，并由下方 effect 改写 URL
  const cur = sections.find((s) => s.key === params.section) || sections[0]

  useEffect(() => {
    if (params.section !== cur.key) navigate(`/settings/${cur.key}`, { replace: true })
  }, [params.section, cur.key]) // eslint-disable-line react-hooks/exhaustive-deps

  async function logout() {
    await auth.logout()
    navigate('/login')
  }

  return (
    <div className="flex h-svh flex-col">
      <header className="flex flex-none items-center gap-3 border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-2.5 font-semibold">
          <div className="ts-logo ts-mark size-6 rounded-md text-[calc(11px*var(--fs))]">
            TS
          </div>
          设置
        </div>
        <span className="ml-auto text-sm text-muted-foreground">{auth.username}</span>
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut /> 登出
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左列：分区列表（当前分区在 URL 上，刷新/回退保持停留位置，超高内部滚动）
            + 左下角固定的「返回项目」入口 */}
        <div className="sets-page-side">
          <nav className="sets-page-nav">
            {sections.map((s) => (
              <button key={s.key} type="button"
                className={s.key === cur.key ? 'active' : ''}
                onClick={() => navigate(`/settings/${s.key}`)}>
                <s.icon /> {s.label}
              </button>
            ))}
          </nav>
          <div className="sets-page-foot">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app')}>
              <ArrowLeft /> 返回项目
            </Button>
          </div>
        </div>

        <main className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {cur.key === 'appearance' && <AppearanceSection />}
          {cur.key === 'password' && <PasswordSection />}
          {cur.key === 'feishu' && <FeishuPanel />}
          {cur.key === 'assets' && <AssetsPanel />}
          {cur.key === 'rag' && <RagPanel />}
        </main>
      </div>
    </div>
  )
}

// 外观：皮肤选择 + 字体大小（点选即生效并持久化到本浏览器，与后端无关）
function AppearanceSection() {
  const [skin, setSkin] = useState(getSkin())
  const [fs, setFs] = useState(getFontScale())

  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Palette className="size-4 text-primary" /> 外观主题
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">
          选择界面配色与字体大小，点选即生效，记录在本浏览器（localStorage），不影响其他用户。
        </div>
        <div className="grid grid-cols-2 gap-3">
          {SKINS.map((s) => (
            <button key={s.id} type="button"
              className={'skin-pick' + (skin === s.id ? ' active' : '')}
              onClick={() => { applySkin(s.id); setSkin(s.id) }}>
              <span className="sw">
                {s.preview.map((c) => <i key={c} style={{ background: c }} />)}
              </span>
              <span>{s.label}</span>
              {skin === s.id && <Check className="ml-auto size-3.5 text-[var(--star)]" />}
            </button>
          ))}
        </div>
        {/* 字体大小: 全站文字按档位缩放(utils/fontScale.js 写 <html> 的 --fs), 预览字按各档倍数放大 */}
        <div className="grid grid-cols-4 gap-3">
          {FONT_SCALES.map((s) => (
            <button key={s.value} type="button"
              className={'fs-pick' + (fs === s.value ? ' active' : '')}
              onClick={() => { applyFontScale(s.value); setFs(s.value) }}>
              <span className="sample" style={{ fontSize: `calc(13px * ${s.value})` }}>字A</span>
              <span>{s.label}</span>
              {fs === s.value && <Check className="ml-auto size-3.5 text-[var(--star)]" />}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// 修改密码：原密码 + 新密码（后端校验原密码正确性与新密码长度，错误经 toast 提示）
function PasswordSection() {
  const [pw, setPw] = useState({ old: '', new: '' })
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await authApi.changePassword(pw.old, pw.new)
      toast('密码已修改')
      setPw({ old: '', new: '' })
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <KeyRound className="size-4 text-primary" /> 修改密码
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">原密码</Label>
          <Input type="password" value={pw.old}
            onChange={(e) => setPw({ ...pw, old: e.target.value })} />
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">新密码（至少 6 位）</Label>
          <Input type="password" value={pw.new}
            onChange={(e) => setPw({ ...pw, new: e.target.value })} />
        </div>
        <Button variant="outline" disabled={busy} onClick={save}>保存</Button>
      </CardContent>
    </Card>
  )
}
