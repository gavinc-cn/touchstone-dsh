// stores/auth.js 单测：登录态读取/登录/登出（api 整体打桩）
// 覆盖：load 成功落身份、未登录（401）时静默降级为未登录态、login 后回读身份、
// logout 即使请求失败也清空本地态（保证前端不残留已登录假象）。
// 另覆盖首次登录强制改密标记 mustChangePassword（服务端 must_change_pw 透传）。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  authApi: { me: vi.fn(), login: vi.fn(), logout: vi.fn() },
}))

import { authApi } from '../api'

import { useAuthStore } from '../stores/auth'

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ username: '', isAdmin: false, mustChangePassword: false, loaded: false })
})

describe('useAuthStore', () => {
  it('load 成功：落用户名与管理员标记并置 loaded', async () => {
    authApi.me.mockResolvedValue({ username: 'alice', is_admin: true })
    await useAuthStore.getState().load()
    expect(useAuthStore.getState().username).toBe('alice')
    expect(useAuthStore.getState().isAdmin).toBe(true)
    expect(useAuthStore.getState().loaded).toBe(true)
  })

  it('load 成功：must_change_password 透传为 mustChangePassword 门控标记', async () => {
    authApi.me.mockResolvedValue({ username: 'admin', must_change_password: true })
    await useAuthStore.getState().load()
    expect(useAuthStore.getState().mustChangePassword).toBe(true)
  })

  it('load 失败（未登录/401）：静默降级为未登录态且不抛出', async () => {
    authApi.me.mockRejectedValue(new Error('unauthorized'))
    await expect(useAuthStore.getState().load()).resolves.toBeUndefined()
    expect(useAuthStore.getState().username).toBe('')
    expect(useAuthStore.getState().isAdmin).toBe(false)
    expect(useAuthStore.getState().mustChangePassword).toBe(false)
    expect(useAuthStore.getState().loaded).toBe(true)
  })

  it('login 先调接口再回读身份；logout 请求失败也清空本地态', async () => {
    authApi.login.mockResolvedValue(null)
    authApi.me.mockResolvedValue({ username: 'bob', is_admin: 0 })
    await useAuthStore.getState().login('bob', 'pw123456')
    expect(authApi.login).toHaveBeenCalledWith('bob', 'pw123456')
    expect(useAuthStore.getState().username).toBe('bob')
    expect(useAuthStore.getState().isAdmin).toBe(false)

    authApi.logout.mockRejectedValue(new Error('network'))
    await useAuthStore.getState().logout()
    expect(useAuthStore.getState().username).toBe('')
    expect(useAuthStore.getState().isAdmin).toBe(false)
  })

  it('logout 同时清掉强制改密标记（不残留下个会话的门控态）', async () => {
    authApi.me.mockResolvedValue({ username: 'admin', must_change_password: true })
    await useAuthStore.getState().load()
    expect(useAuthStore.getState().mustChangePassword).toBe(true)

    authApi.logout.mockResolvedValue(null)
    await useAuthStore.getState().logout()
    expect(useAuthStore.getState().mustChangePassword).toBe(false)
  })
})
