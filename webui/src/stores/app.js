// 项目/任务/bug 数据 store(zustand): 与旧 pinia 版行为一致
import { create } from 'zustand'
import { projectApi, taskApi, bugApi } from '../api'

export const useAppStore = create((set, get) => ({
  projects: [],
  currentProject: null,
  tasks: [],
  bugs: [],
  loading: { projects: false, tasks: false, bugs: false },

  loadProjects: async () => {
    set((s) => ({ loading: { ...s.loading, projects: true } }))
    try { set({ projects: await projectApi.list() }) }
    finally { set((s) => ({ loading: { ...s.loading, projects: false } })) }
  },

  selectProject: async (id) => {
    const p = get().projects.find((x) => x.id === id) || null
    set({ currentProject: p })
    if (p) await Promise.all([get().loadTasks(), get().loadBugs()])
  },

  refreshProject: async () => {
    const cp = get().currentProject
    if (!cp) return
    const p = await projectApi.get(cp.id)
    set((s) => ({
      currentProject: p,
      projects: s.projects.map((x) => (x.id === p.id ? p : x)),
    }))
  },

  loadTasks: async () => {
    const cp = get().currentProject
    if (!cp) return
    set((s) => ({ loading: { ...s.loading, tasks: true } }))
    try { set({ tasks: await taskApi.list(cp.id) }) }
    finally { set((s) => ({ loading: { ...s.loading, tasks: false } })) }
  },

  loadBugs: async () => {
    const cp = get().currentProject
    if (!cp) return
    set((s) => ({ loading: { ...s.loading, bugs: true } }))
    try { set({ bugs: await bugApi.list(cp.id) }) }
    finally { set((s) => ({ loading: { ...s.loading, bugs: false } })) }
  },

  createProject: async (body) => {
    const r = await projectApi.create(body)
    await get().loadProjects()
    return r
  },

  updateProject: async (id, body) => {
    await projectApi.update(id, body)
    await get().refreshProject()
    await get().loadProjects()
  },

  // 删除项目（仅归档项目; body 带 confirm_name 供后端校验）;
  // 磁盘上的案例库/bug 报告文件不删, 由用户手动清理
  deleteProject: async (id, body) => {
    await projectApi.remove(id, body)
    if (get().currentProject?.id === id) set({ currentProject: null })
    await get().loadProjects()
  },

  // 归档/恢复项目：刷新列表；若操作的是当前项目，同步刷新头部徽标与按钮状态
  archiveProject: async (id, archived) => {
    await projectApi[archived ? 'archive' : 'unarchive'](id)
    await get().loadProjects()
    if (get().currentProject?.id === id) await get().refreshProject()
  },
}))

