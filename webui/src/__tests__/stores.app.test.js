// stores/app.js 单测：项目/任务/bug 状态流转（api 整体打桩，只验 store 逻辑）
// 覆盖：selectProject 命中/未命中、loadProjects 失败时 loading 复位、无当前项目时
// loadTasks/loadBugs 短路、deleteProject 清空当前项目、create/archive 后的回刷。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  projectApi: {
    list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
    remove: vi.fn(), archive: vi.fn(), unarchive: vi.fn(),
  },
  taskApi: { list: vi.fn() },
  bugApi: { list: vi.fn() },
}))

import { projectApi, taskApi, bugApi } from '../api'

import { useAppStore } from '../stores/app'

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    projects: [], currentProject: null, tasks: [], bugs: [],
    loading: { projects: false, tasks: false, bugs: false },
  })
})

describe('useAppStore', () => {
  it('selectProject 命中时拉取任务与 bug，未命中时清空且不发请求', async () => {
    useAppStore.setState({ projects: [{ id: 1 }, { id: 2 }] })
    taskApi.list.mockResolvedValue([{ id: 10 }])
    bugApi.list.mockResolvedValue([{ dir: '20260913_1000_FS_x' }])

    await useAppStore.getState().selectProject(2)
    expect(useAppStore.getState().currentProject).toEqual({ id: 2 })
    expect(taskApi.list).toHaveBeenCalledWith(2)
    expect(bugApi.list).toHaveBeenCalledWith(2)
    expect(useAppStore.getState().tasks).toEqual([{ id: 10 }])
    expect(useAppStore.getState().bugs).toEqual([{ dir: '20260913_1000_FS_x' }])

    await useAppStore.getState().selectProject(99)
    expect(useAppStore.getState().currentProject).toBeNull()
    expect(taskApi.list).toHaveBeenCalledTimes(1) // 未命中项目不触发加载
  })

  it('loadProjects 失败时抛出并复位 loading；无当前项目时 loadTasks/loadBugs 短路', async () => {
    projectApi.list.mockRejectedValue(new Error('boom'))
    await expect(useAppStore.getState().loadProjects()).rejects.toThrow('boom')
    expect(useAppStore.getState().loading.projects).toBe(false) // finally 复位，不留转圈

    projectApi.list.mockResolvedValue([{ id: 1 }])
    await useAppStore.getState().loadProjects()
    expect(useAppStore.getState().projects).toEqual([{ id: 1 }])

    await useAppStore.getState().loadTasks()
    await useAppStore.getState().loadBugs()
    expect(taskApi.list).not.toHaveBeenCalled()
    expect(bugApi.list).not.toHaveBeenCalled()
  })

  it('deleteProject 删除当前项目后清空 currentProject，删除他项目不动当前选中', async () => {
    useAppStore.setState({ currentProject: { id: 5 }, projects: [{ id: 5 }, { id: 6 }] })
    projectApi.remove.mockResolvedValue(null)
    projectApi.list.mockResolvedValue([{ id: 5 }])

    await useAppStore.getState().deleteProject(6, { confirm_name: 'other' })
    expect(projectApi.remove).toHaveBeenCalledWith(6, { confirm_name: 'other' })
    expect(useAppStore.getState().currentProject).toEqual({ id: 5 }) // 非当前项目不受影响

    projectApi.list.mockResolvedValue([])
    await useAppStore.getState().deleteProject(5, { confirm_name: 'p' })
    expect(useAppStore.getState().currentProject).toBeNull()
    expect(useAppStore.getState().projects).toEqual([])
  })

  it('createProject 后重拉列表；archiveProject 归档/恢复当前项目时刷新头部与列表', async () => {
    projectApi.create.mockResolvedValue({ id: 8 })
    projectApi.list.mockResolvedValue([{ id: 8 }])
    expect(await useAppStore.getState().createProject({ name: 'p' })).toEqual({ id: 8 })
    expect(useAppStore.getState().projects).toEqual([{ id: 8 }])

    useAppStore.setState({ currentProject: { id: 8, archived: false } })
    projectApi.archive.mockResolvedValue(null)
    projectApi.get.mockResolvedValue({ id: 8, archived: true })
    await useAppStore.getState().archiveProject(8, true)
    expect(projectApi.archive).toHaveBeenCalledWith(8)
    expect(useAppStore.getState().currentProject).toEqual({ id: 8, archived: true })

    projectApi.unarchive.mockResolvedValue(null)
    projectApi.get.mockResolvedValue({ id: 8, archived: false })
    await useAppStore.getState().archiveProject(8, false)
    expect(projectApi.unarchive).toHaveBeenCalledWith(8)
    expect(useAppStore.getState().currentProject.archived).toBe(false)
  })
})
