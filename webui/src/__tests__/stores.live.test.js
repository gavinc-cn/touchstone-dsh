// stores/live.js 单测：SSE 驱动实时状态（stateApi 打桩，EventSource 用假对象驱动）
// 覆盖：connect 建连与首帧快照、同项目重复 connect 不重建（切项目先关旧连接）、
// onmessage 应用新状态且「内容未变的 section 保留旧引用」（防下游 useMemo 连锁失效）、
// 坏帧/error 帧忽略、disconnect 置未连接且可重连、fetchSnapshot 失败静默。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  stateApi: { stream: vi.fn(), state: vi.fn() },
}))

import { stateApi } from '../api'

import { useLiveStore } from '../stores/live'

// 假 EventSource：用例直接驱动 onopen/onerror/onmessage
function fakeEs() {
  return { onopen: null, onerror: null, onmessage: null, close: vi.fn() }
}

const SNAPSHOT = {
  project: { id: 1, name: 'p' },
  live: { cases: 1 },
  library: { a: 1 },
  bugs: [{ dir: 'b1' }],
  rounds: [{ round: 1 }],
  generated_at: '2026-09-13T10:00:00',
}

beforeEach(() => {
  vi.clearAllMocks()
  useLiveStore.getState().disconnect() // 清模块内连接单例（es/projId）
  useLiveStore.setState({
    connected: false, project: null, live: null, library: null,
    bugs: [], rounds: [], updatedAt: '',
  })
})

afterEach(() => {
  useLiveStore.getState().disconnect() // 清 30s 快照定时器，避免跨例泄漏
})

describe('useLiveStore', () => {
  it('connect 建连并应用首帧快照；onopen/onerror 切换 connected', async () => {
    const es = fakeEs()
    stateApi.stream.mockReturnValue(es)
    stateApi.state.mockResolvedValue(SNAPSHOT)

    await useLiveStore.getState().connect(1)
    expect(stateApi.stream).toHaveBeenCalledWith(1)
    expect(stateApi.state).toHaveBeenCalledWith(1) // 首帧快照兜底
    expect(useLiveStore.getState().project).toEqual({ id: 1, name: 'p' })
    expect(useLiveStore.getState().live).toEqual({ cases: 1 })
    expect(useLiveStore.getState().updatedAt).toBe('2026-09-13T10:00:00')

    es.onopen()
    expect(useLiveStore.getState().connected).toBe(true)
    es.onerror()
    expect(useLiveStore.getState().connected).toBe(false)
  })

  it('同项目重复 connect 不重建连接；切项目先关旧连接再建新连接', async () => {
    const es1 = fakeEs()
    const es2 = fakeEs()
    stateApi.stream.mockReturnValueOnce(es1).mockReturnValueOnce(es2)
    stateApi.state.mockResolvedValue(SNAPSHOT)

    await useLiveStore.getState().connect(1)
    await useLiveStore.getState().connect(1)
    expect(stateApi.stream).toHaveBeenCalledTimes(1) // 复用已有连接

    await useLiveStore.getState().connect(2)
    expect(es1.close).toHaveBeenCalled()
    expect(stateApi.stream).toHaveBeenCalledTimes(2)
    expect(stateApi.stream).toHaveBeenLastCalledWith(2)
  })

  it('onmessage 应用新状态；内容未变的 section 保留旧引用；坏帧与 error 帧忽略', async () => {
    const es = fakeEs()
    stateApi.stream.mockReturnValue(es)
    stateApi.state.mockResolvedValue(SNAPSHOT)
    await useLiveStore.getState().connect(1)

    const live0 = useLiveStore.getState().live
    const library0 = useLiveStore.getState().library

    // 内容相同的新对象帧：引用保持（否则下游 useMemo/selector 连锁失效）
    es.onmessage({ data: JSON.stringify({ live: { cases: 1 }, library: { a: 1 } }) })
    expect(useLiveStore.getState().live).toBe(live0)
    expect(useLiveStore.getState().library).toBe(library0)

    // 内容变化：换新引用与新值
    es.onmessage({ data: JSON.stringify({ live: { cases: 2 } }) })
    expect(useLiveStore.getState().live).toEqual({ cases: 2 })
    expect(useLiveStore.getState().live).not.toBe(live0)

    // 坏帧（非 JSON）与 error 帧：忽略，状态保持
    es.onmessage({ data: 'not-json' })
    es.onmessage({ data: JSON.stringify({ error: 'boom' }) })
    expect(useLiveStore.getState().live).toEqual({ cases: 2 })
  })

  it('disconnect 关连接置未连接、可重连同项目；fetchSnapshot 失败静默', async () => {
    const es = fakeEs()
    stateApi.stream.mockReturnValue(es)
    stateApi.state.mockResolvedValue(SNAPSHOT)
    await useLiveStore.getState().connect(1)

    useLiveStore.getState().disconnect()
    expect(es.close).toHaveBeenCalled()
    expect(useLiveStore.getState().connected).toBe(false)

    await useLiveStore.getState().connect(1) // projId 已清，重建连接
    expect(stateApi.stream).toHaveBeenCalledTimes(2)

    stateApi.state.mockRejectedValue(new Error('net down'))
    await expect(useLiveStore.getState().fetchSnapshot()).resolves.toBeUndefined()
    expect(useLiveStore.getState().live).toEqual({ cases: 1 }) // 保留上一次快照
  })
})
