// 认证 store(zustand): 与旧 pinia 版行为一致
import { create } from 'zustand'
import { authApi } from '../api'

export const useAuthStore = create((set, get) => ({
  username: '',
  isAdmin: false,
  // 首次登录强制改密标记（服务端 must_change_pw）：为真时路由守卫只渲染改密门
  mustChangePassword: false,
  loaded: false,
  load: async () => {
    try {
      const me = await authApi.me()
      set({ username: me.username, isAdmin: !!me.is_admin,
            mustChangePassword: !!me.must_change_password, loaded: true })
    } catch {
      set({ username: '', mustChangePassword: false, loaded: true })
    }
  },
  login: async (username, password) => {
    await authApi.login(username, password)
    await get().load()
  },
  logout: async () => {
    try { await authApi.logout() } catch { /* 忽略 */ }
    set({ username: '', isAdmin: false, mustChangePassword: false })
  },
}))

