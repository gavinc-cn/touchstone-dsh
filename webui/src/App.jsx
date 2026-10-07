import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Login from './views/Login.jsx'
import AppShell from './views/AppShell.jsx'
import Admin from './views/Admin.jsx'
import Settings from './views/Settings.jsx'
import TaskLogPage from './views/TaskLogPage.jsx'
import ForcePasswordChange from './views/ForcePasswordChange.jsx'
import { useAuthStore } from './stores/auth'
import { writeLastRoute } from './lib/lastRoute'

// 路由守卫: 未登录访问受保护页 → /login; 已登录访问 /login → /app; 非 admin 访问 /admin → /app;
// 持一次性初始口令（must_change_pw）→ 只渲染强制改密门, 改完才进应用（后端同规则兜底 403）
function RequireAuth({ children }) {
  const username = useAuthStore((s) => s.username)
  const mustChangePassword = useAuthStore((s) => s.mustChangePassword)
  if (!username) return <Navigate to="/login" replace />
  if (mustChangePassword) return <ForcePasswordChange />
  return children
}

function RequireAdmin({ children }) {
  const username = useAuthStore((s) => s.username)
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const mustChangePassword = useAuthStore((s) => s.mustChangePassword)
  if (!username) return <Navigate to="/login" replace />
  if (mustChangePassword) return <ForcePasswordChange />
  if (!isAdmin) return <Navigate to="/app" replace />
  return children
}

function LoginGate({ children }) {
  const username = useAuthStore((s) => s.username)
  if (username) return <Navigate to="/app" replace />
  return children
}

export default function App() {
  const location = useLocation()
  // 路由记忆: 每换一页把「当前页面」记进 localStorage —— dsh 面板重建 iframe（宿主页刷新/
  // 重开）或独立形态重开时，就能回到用户切走前那一页（见 lib/lastRoute.js）。
  useEffect(() => {
    writeLastRoute(location.pathname, location.search)
  }, [location.pathname, location.search])
  return (
    <Routes>
      <Route path="/login" element={<LoginGate><Login /></LoginGate>} />
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>} />
      <Route path="/monitor" element={<RequireAuth><AppShell /></RequireAuth>} />
      <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
      {/* 设置页: 分区列表 + 内容（/settings/<分区>；分区键与旧路由 /settings/rag、/settings/feishu 兼容） */}
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="/settings/:section" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="/log" element={<RequireAuth><TaskLogPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  )
}

