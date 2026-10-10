import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/auth'
import { authApi } from '../api'
import TouchstoneLogo from '../components/TouchstoneLogo.jsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Loader2 } from 'lucide-react'

export default function Login() {
  const navigate = useNavigate()
  const auth = useAuthStore()

  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [regUsername, setRegUsername] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regPassword2, setRegPassword2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function switchMode() {
    setMode(mode === 'login' ? 'reg' : 'login')
    setError('')
  }

  async function submit() {
    if (busy) return
    setError('')
    const isReg = mode === 'reg'
    if (isReg && regPassword !== regPassword2) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      if (isReg) {
        await authApi.register(regUsername, regPassword) // 注册成功后端已种会话 cookie
        await auth.load()
      } else {
        await auth.login(username, password)
      }
      navigate('/app')
    } catch (e) {
      setError(e.message || (isReg ? '注册失败' : '登录失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-[radial-gradient(1200px_600px_at_70%_-10%,var(--login-glow)_0%,var(--bg)_55%)] p-4">
      <Card className="w-[360px] shadow-xl">
        <CardHeader className="items-center gap-3 border-b border-border/60 pb-5">
          {/* Logo 徽标(CardHeader 为 grid, 需 justify-self-center 水平居中) */}
          <div className="justify-self-center"><TouchstoneLogo size={40} /></div>
          <div className="text-center">
            <CardTitle className="font-serif text-lg">
              {mode === 'login' ? 'Touchstone' : '注册用户'}
            </CardTitle>
            <CardDescription className="mt-1">
              Free-style testing · Execution &amp; monitoring
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {mode === 'login' ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="login-username" className="text-xs text-muted-foreground">用户名</Label>
                <Input id="login-username" value={username}
                  onChange={(e) => setUsername(e.target.value.trim())}
                  autoComplete="username" placeholder="请输入用户名" autoFocus />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="login-password" className="text-xs text-muted-foreground">密码</Label>
                <Input id="login-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} type="password"
                  autoComplete="current-password" placeholder="请输入密码"
                  onKeyUp={(e) => { if (e.key === 'Enter') submit() }} />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="reg-username" className="text-xs text-muted-foreground">用户名</Label>
                <Input id="reg-username" value={regUsername}
                  onChange={(e) => setRegUsername(e.target.value.trim())}
                  autoComplete="username" autoFocus />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="reg-password" className="text-xs text-muted-foreground">密码</Label>
                <Input id="reg-password" value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)} type="password"
                  autoComplete="new-password" placeholder="至少 6 位" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="reg-password2" className="text-xs text-muted-foreground">确认密码</Label>
                <Input id="reg-password2" value={regPassword2}
                  onChange={(e) => setRegPassword2(e.target.value)} type="password"
                  autoComplete="new-password"
                  onKeyUp={(e) => { if (e.key === 'Enter') submit() }} />
              </div>
            </>
          )}
          {/* 错误信息占位: 有错误时换行提示 */}
          <div className="min-h-5 text-[calc(13px*var(--fs))] leading-5 text-destructive">{error}</div>
          <Button size="lg" className="w-full" disabled={busy} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {mode === 'login' ? '登 录' : '注 册'}
          </Button>
        </CardContent>
        <CardFooter className="flex-col items-center gap-3 pt-0">
          <button type="button"
            className="text-sm text-[var(--run)] underline-offset-4 hover:underline"
            onClick={switchMode}>
            {mode === 'login' ? '没有账号？注册新用户' : '已有账号？返回登录'}
          </button>
          {mode === 'login' && (
            <p className="text-xs text-muted-foreground">
              请输入账号密码登录；登录后可在右上角修改密码
            </p>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}

