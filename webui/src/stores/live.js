// 实时状态 store(zustand): SSE 驱动增量更新, 30s 全量快照兜底。与旧 pinia 版行为一致
import { create } from 'zustand'
import { stateApi } from '../api'

// EventSource/定时器为模块级单例, 跨组件共享(同一项目只有一个连接)
let es = null
let snapshotTimer = null
let projId = null

// 内容未变的 section 保留旧引用: 否则每次 SSE 推送都使下游 useMemo/selector 连锁失效,
// 整棵用例树等昂贵渲染被反复重算(stringify 比较的开销远低于 DOM 重建)
function keepRef(prev, next) {
  if (prev == null || next == null || prev === next) return next
  try {
    return JSON.stringify(next) === JSON.stringify(prev) ? prev : next
  } catch { return next }
}

function apply(state, set) {
  const cur = useLiveStore.getState()
  set({
    project: state.project || cur.project,
    live: keepRef(cur.live, state.live),
    library: keepRef(cur.library, state.library),
    bugs: keepRef(cur.bugs, state.bugs || []),
    rounds: keepRef(cur.rounds, state.rounds || []),
    updatedAt: state.generated_at || '',
  })
}

export const useLiveStore = create((set, get) => ({
  connected: false,
  project: null,
  live: null,
  library: null,
  bugs: [],
  rounds: [],
  updatedAt: '',

  connect: async (projectId) => {
    // 已有连接且项目相同则不重建
    if (es && projId === projectId) return
    get().disconnect()
    projId = projectId
    es = stateApi.stream(projectId)
    es.onopen = () => set({ connected: true })
    es.onerror = () => set({ connected: false })
    es.onmessage = (e) => {
      try {
        const state = JSON.parse(e.data)
        if (state.error) return
        apply(state, set)
      } catch { /* 忽略坏帧 */ }
    }
    // 30s 快照兜底(断线漏事件)
    snapshotTimer = setInterval(() => get().fetchSnapshot(), 30000)
    await get().fetchSnapshot()
  },

  fetchSnapshot: async () => {
    try {
      const state = await stateApi.state(projId)
      if (state && !state.error) apply(state, set)
    } catch { /* 忽略 */ }
  },

  disconnect: () => {
    if (es) { es.close(); es = null }
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null }
    projId = null
    set({ connected: false })
  },
}))

