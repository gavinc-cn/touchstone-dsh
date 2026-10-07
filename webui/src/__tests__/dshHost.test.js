// lib/dshHost.js 单测：dsh 插件面板 ↔ 内嵌 SPA 的宿主桥（探针/能力应答/打开会话）
// 覆盖：独立形态不探测且能力为空；面板形态发探针、折叠同源应答；异源/异类型消息忽略；
// openSessionInDsh 只在能力位可用且会话 id 非空时发消息（返回布尔语义）。
// 协议常量与宿主半 dsh-plugin/src/client.js 逐字一致（那边由
// dsh-plugin/scripts/dev-check-bridge.mjs 用真实产物自检）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PARENT_PROP = 'parent'
const nativeParent = window.parent

/** 按用例重新加载模块：started/caps 是模块级单例，必须隔离（顺带覆盖 init 幂等）。 */
async function loadBridge({ framed }) {
  vi.resetModules()
  const parent = framed ? { postMessage: vi.fn() } : window
  Object.defineProperty(window, PARENT_PROP, { value: parent, configurable: true })
  const mod = await import('../lib/dshHost')
  return { mod, parent }
}

/** 派发一条同源 message 事件（默认就是宿主的能力应答）。 */
function dispatchMessage(data, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent('message', { data, origin }))
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  Object.defineProperty(window, PARENT_PROP, { value: nativeParent, configurable: true })
})

describe('dshHost 宿主桥', () => {
  it('独立形态（window.parent === window）：不发探针、能力为空、打开请求直接拒绝', async () => {
    const postSpy = vi.spyOn(window, 'postMessage')
    const { mod } = await loadBridge({ framed: false })
    mod.initDshHost()
    expect(postSpy).not.toHaveBeenCalled() // 没有父窗口可探：一条消息都不发
    expect(mod.getDshHostCaps()).toBe(null)
    expect(mod.openSessionInDsh('sess-1')).toBe(false)
    expect(postSpy).not.toHaveBeenCalled()
    postSpy.mockRestore()
  })

  it('面板形态：initDshHost 向父窗口发探针，同源能力应答折叠进 caps 并通知订阅者', async () => {
    const { mod, parent } = await loadBridge({ framed: true })
    const seen = []
    const off = mod.subscribeDshHost((caps) => seen.push(caps))

    mod.initDshHost()
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: 'touchstone:host-probe' }, window.location.origin)

    dispatchMessage({ type: 'touchstone:host-caps', caps: { openSession: true } })
    expect(mod.getDshHostCaps()).toEqual({ openSession: true })
    expect(seen).toEqual([{ openSession: true }])

    off()
    dispatchMessage({ type: 'touchstone:host-caps', caps: {} })
    expect(seen).toHaveLength(1) // 退订后不再回调
    expect(mod.getDshHostCaps()).toEqual({}) // 但快照照常更新（宿主能力位可变化）
  })

  it('异源 / 异类型 / 非对象消息一律忽略（caps 保持 null）', async () => {
    const { mod } = await loadBridge({ framed: true })
    mod.initDshHost()
    dispatchMessage({ type: 'touchstone:host-caps', caps: { openSession: true } }, 'http://evil.test')
    dispatchMessage({ type: 'other-plugin:hello' })
    dispatchMessage(null)
    dispatchMessage('touchstone:host-caps')
    expect(mod.getDshHostCaps()).toBe(null)
  })

  it('openSessionInDsh：能力位可用 + 会话 id 非空才发请求；其余情况返回 false 且不发消息', async () => {
    const { mod, parent } = await loadBridge({ framed: true })
    mod.initDshHost()
    parent.postMessage.mockClear()

    expect(mod.openSessionInDsh('sess-1')).toBe(false) // 还没拿到 caps
    dispatchMessage({ type: 'touchstone:host-caps', caps: { openSession: false } })
    expect(mod.openSessionInDsh('sess-1')).toBe(false) // 宿主在但能力位 false
    expect(parent.postMessage).not.toHaveBeenCalled()

    dispatchMessage({ type: 'touchstone:host-caps', caps: { openSession: true } })
    expect(mod.openSessionInDsh('')).toBe(false)     // 无主会话
    expect(mod.openSessionInDsh(null)).toBe(false)
    expect(mod.openSessionInDsh('sess-1')).toBe(true)
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: 'touchstone:open-session', sid: 'sess-1' }, window.location.origin)
  })

  it('initDshHost 幂等：重复调用不重复挂监听/重复发探针', async () => {
    const { mod, parent } = await loadBridge({ framed: true })
    mod.initDshHost()
    mod.initDshHost()
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    // 只挂了一条 message 监听：一次应答只触发一次订阅回调
    const seen = []
    mod.subscribeDshHost((caps) => seen.push(caps))
    dispatchMessage({ type: 'touchstone:host-caps', caps: { openSession: true } })
    expect(seen).toHaveLength(1)
  })
})
