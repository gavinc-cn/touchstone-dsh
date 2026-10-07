// 首次登录强制改密门（2026-10-02）：
// 未设 TS_ADMIN_PASSWORD 时后端种子会随机生成一次性初始口令并置 must_change_pw=1，
// 该账号在改密前只能看到本页——路由守卫按 auth.mustChangePassword 拦截，后端同规则
// 兜底（除 /api/auth/me、/api/auth/change_password、/api/auth/logout 外一律 403）。
import { useState } from 'react'
import { useAuthStore } from '../stores/auth'
import { authApi } from '../api'
import { toast } from '../utils/toast'
import TouchstoneLogo from '../components/TouchstoneLogo.jsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Loader2, KeyRound } from 'lucide-react'

export default function ForcePasswordChange() {
  const auth = useAuthStore()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (busy) return
    setError('')
    // 前端先校验（与后端同规则：新密码至少 6 位），减少一次无谓请求
    if (newPw.length < 6) {
      setError('新密码至少 6 位')
      return
    }
    if (newPw !== newPw2) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await authApi.changePassword(oldPw, newPw)
      await auth.load() // me 回读 must_change_password=false → 路由守卫放行进入应用
      toast('密码已修改')
    } catch (e) {
      setError(e.message || '修改失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-[radial-gradient(1200px_600px_at_70%_-10%,var(--login-glow)_0%,var(--bg)_55%)] p-4">
      <Card className="w-[380px] shadow-xl">
        <CardHeader className="items-center gap-3 border-b border-border/60 pb-5">
          <div className="justify-self-center"><TouchstoneLogo size={40} /></div>
          <div className="text-center">
            <CardTitle className="flex items-center justify-center gap-2 font-serif text-lg">
              <KeyRound className="size-4 text-primary" /> 首次登录须修改密码
            </CardTitle>
            <CardDescription className="mt-1">
              账号 {auth.username} 仍在使用一次性初始口令
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="force-old-pw" className="text-xs text-muted-foreground">
              当前口令（启动横幅里的一次性口令）
            </Label>
            <Input id="force-old-pw" value={oldPw} type="password"
              onChange={(e) => setOldPw(e.target.value)}
              autoComplete="current-password" autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="force-new-pw" className="text-xs text-muted-foreground">
              新密码（至少 6 位）
            </Label>
            <Input id="force-new-pw" value={newPw} type="password"
              onChange={(e) => setNewPw(e.target.value)}
              autoComplete="new-password" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="force-new-pw2" className="text-xs text-muted-foreground">
              确认新密码
            </Label>
            <Input id="force-new-pw2" value={newPw2} type="password"
              onChange={(e) => setNewPw2(e.target.value)}
              autoComplete="new-password"
              onKeyUp={(e) => { if (e.key === 'Enter') submit() }} />
          </div>
          <div className="min-h-5 text-[calc(13px*var(--fs))] leading-5 text-destructive">{error}</div>
          <Button size="lg" className="w-full" disabled={busy} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            修改并进入
          </Button>
        </CardContent>
        <CardFooter className="flex-col items-center pt-0">
          <button type="button"
            className="text-sm text-primary underline-offset-4 hover:underline"
            onClick={() => auth.logout()}>
            退出登录
          </button>
        </CardFooter>
      </Card>
    </div>
  )
}
