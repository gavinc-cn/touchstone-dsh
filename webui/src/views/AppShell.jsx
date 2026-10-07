import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/auth'
import { useAppStore } from '../stores/app'
import { projectApi, prefsApi } from '../api'
import { toast } from '../utils/toast'
import { useResizable } from '../hooks/useResizable'
import TasksTab from '../components/TasksTab.jsx'
import MonitorTab from '../components/MonitorTab.jsx'
import BugsTab from '../components/BugsTab.jsx'
import BoardTab from '../components/BoardTab.jsx'
import StressTab from '../components/StressTab.jsx'
import { PERM_OPTS } from '../components/ComposerBar'
import { effortChoices } from '../utils/sessionEffort'
import { RzHandles } from '../components/RzHandles'
import TouchstoneLogo from '../components/TouchstoneLogo.jsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Plus, Pencil, LogOut, Menu, Settings, ShieldUser, RefreshCw, Archive, ArchiveRestore, Trash2, FolderOpen, FolderPlus, ArrowUp, EyeOff, X } from 'lucide-react'

const DUP_LABEL = { project_dir: '项目目录', work_dir: '工作目录' }

// 主标签页定义（顺序 = 默认顺序；key 与 user_prefs 存储约定，勿改）
const TABS = [
  { key: 'board', label: '开发看板' },
  { key: 'tasks', label: '测试任务' },
  { key: 'stress', label: '压测面板' },
  { key: 'monitor', label: '监控面板' },
  { key: 'bugs', label: 'Bug 报告' },
]
const TAB_KEYS = TABS.map((t) => t.key)
const TAB_LABEL = Object.fromEntries(TABS.map((t) => [t.key, t.label]))

// 标签页布局规范化：未知 key 丢弃、缺失 key 按默认序补尾、hidden 只留合法 key
// （服务端 prefs 可能落后于前端版本——增删标签页后仍能正确恢复）
function normTabCfg(cfg) {
  const order = (Array.isArray(cfg?.order) ? cfg.order : []).filter((k) => TAB_KEYS.includes(k))
  for (const k of TAB_KEYS) if (!order.includes(k)) order.push(k)
  const hidden = (Array.isArray(cfg?.hidden) ? cfg.hidden : []).filter((k) => TAB_KEYS.includes(k))
  return { order, hidden }
}

// 取路径最后一段（项目名称留空时自动命名）: / 与 \ 均按分隔符处理(跨 Windows/Linux),
// 忽略尾部分隔符与纯盘符段(如 "D:"), 与后端 path_last_segment 行为一致
function pathLastSeg(p) {
  const segs = (p || '').split(/[\\/]+/).filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) if (!/^[A-Za-z]:$/.test(segs[i])) return segs[i]
  return ''
}

// ---- 侧栏宽度（拖右缘手柄调整, 本浏览器记忆, 与 ts.sessW/ts.bugw 同一命名风格） ----
const SIDE_W_KEY = 'ts.sidebarW'
const SIDE_W_MIN = 180
const SIDE_W_MAX = 480
const SIDE_W_DEF = 230

// 读取记忆的侧栏宽度（非法/未设置回落默认 230）
function loadSideW() {
  const v = parseInt(localStorage.getItem(SIDE_W_KEY), 10)
  return Number.isFinite(v) ? Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, v)) : SIDE_W_DEF
}

export default function AppShell() {
  const navigate = useNavigate()
  const auth = useAuthStore()
  const store = useAppStore()

  const [tab, setTab] = useState(localStorage.getItem('ts_cur_tab') || 'board')
  // 标签页布局（顺序+隐藏）：按 用户+项目 存服务端 user_prefs（key=tabs），换浏览器不丢
  const [tabCfg, setTabCfg] = useState(null)
  const [hiddenOpen, setHiddenOpen] = useState(false)   // 隐藏标签恢复下拉
  const [dragKey, setDragKey] = useState(null)          // 拖动中的标签 key（置灰跟随）
  const tabCfgRef = useRef(null)                        // tabCfg 镜像：拖拽结束落库读最新
  tabCfgRef.current = tabCfg
  const suppressTabClick = useRef(false)                // 拖动结束后吞掉紧随的 click（防误切页）
  const tabDragRef = useRef(null)                       // {key, sx, on}
  const [projModal, setProjModal] = useState(false)
  const [editId, setEditId] = useState(null)
  const [agents, setAgents] = useState([])
  const [dupModal, setDupModal] = useState(false)
  const [dups, setDups] = useState([])
  const [pendingBody, setPendingBody] = useState(null)
  // 侧栏项目列表视图: false=未归档项目 true=已归档项目（归档只隐藏不删除）
  const [showArchived, setShowArchived] = useState(false)
  // 侧栏「菜单」开合(该菜单只收管理/登出; 其余项已并入「设置」页)
  const [setOpen, setSetOpen] = useState(false)
  const [pf, setPf] = useState({ name: '', project_dir: '', agent_path: '', work_dir: '', env_label: '', guide_text: '', model: '', reasoning_effort: '', permission_mode: '', skill_understand: '', skill_deploy: '', skill_commit: '', skill_test: '', skill_cases: '' })
  // 当前智能体已配置的模型列表(agents/models API), 随 agent_path 变化重新拉取
  const [modelOpts, setModelOpts] = useState({ models: [], default: '' })
  // 当前智能体可用的 skill 列表(agents/skills API), 随 agent_path / project_dir 变化重新拉取
  const [skillOpts, setSkillOpts] = useState([])
  // 目录选择弹窗(服务端目录浏览 API): 当前浏览数据 + 加载中标记 + 回填目标字段(project_dir/work_dir)
  const [dirModal, setDirModal] = useState(false)
  const [dirData, setDirData] = useState(null)
  const [dirBusy, setDirBusy] = useState(false)
  const [dirTarget, setDirTarget] = useState('project_dir')
  // 目录选择弹窗内「新建文件夹」行: 是否展开 + 输入名称 + 提交中
  const [dirNewOpen, setDirNewOpen] = useState(false)
  const [dirNewName, setDirNewName] = useState('')
  const [dirNewBusy, setDirNewBusy] = useState(false)
  // 项目删除确认弹窗(仅归档项目): 删除目标 + 用户输入的确认名称
  const [delTarget, setDelTarget] = useState(null)
  const [delName, setDelName] = useState('')
  const { rzOn, rzStyle, rzStart, rzDragStart, rzReset } = useResizable()
  const { rzOn: dupRzOn, rzStyle: dupRzStyle, rzDragStart: dupDragStart, rzReset: dupRzReset } = useResizable()
  const { rzOn: dirRzOn, rzStyle: dirRzStyle, rzDragStart: dirDragStart, rzReset: dirRzReset } = useResizable()
  const { rzOn: delRzOn, rzStyle: delRzStyle, rzDragStart: delDragStart, rzReset: delRzReset } = useResizable()
  const refreshTimer = useRef(null)

  // ---- 侧栏个性化: 项目列表拖拽排序 + 侧栏宽度拖拽 ----
  // 项目顺序: 用户级全局偏好(user_prefs, project_id=0, key=proj_order), 换浏览器不丢;
  // 数组为全量项目 id 顺序(新项目未入库时按服务端相对序补尾, 思路与 normTabCfg 一致)
  const [projOrder, setProjOrder] = useState([])
  const projOrderRef = useRef([])        // 镜像: 拖拽悬停换序/落库读最新(闭包内不读 state)
  projOrderRef.current = projOrder
  const [dragProjId, setDragProjId] = useState(null)  // 拖动中的项目 id(虚框置灰)
  const suppressProjClick = useRef(false)             // 拖动结束后吞掉紧随的 click(防误选项目)
  const projDragRef = useRef(null)                    // {id, sx, sy, on}
  // 侧栏宽度: 本浏览器记忆(localStorage ts.sidebarW)
  const [sideW, setSideW] = useState(loadSideW)
  const sideWRef = useRef(sideW)         // 镜像: 拖拽结束落 localStorage 读最新
  sideWRef.current = sideW

  // 按已存顺序排列项目（未入库的 id 经 Infinity 排尾并保持服务端相对序; JS sort 稳定）
  function orderedProjects(list) {
    const order = projOrderRef.current
    if (!order.length) return list
    const idx = new Map(order.map((id, i) => [id, i]))
    return [...list].sort((a, b) => (idx.has(a.id) ? idx.get(a.id) : Infinity)
      - (idx.has(b.id) ? idx.get(b.id) : Infinity))
  }

  // 把某视图（按 archived 过滤后）的新顺序并回全量顺序：全量序里该视图的 id 子序列
  // 被替换为新序，其余项目（另一视图/新增未入库）的相对位置不变；同步写镜像 ref
  function applyProjOrder(newVisIds) {
    const all = useAppStore.getState().projects.map((p) => p.id)
    const saved = projOrderRef.current.filter((id) => all.includes(id))
    const full = [...saved, ...all.filter((id) => !saved.includes(id))]
    const visSet = new Set(newVisIds)
    const out = []
    let vi = 0
    for (const id of full) out.push(visSet.has(id) ? newVisIds[vi++] : id)
    projOrderRef.current = out
    setProjOrder(out)
    return out
  }

  // 项目行指针拖拽（与标签页拖动同款交互）: 6px 阈值起拖（防轻微位移吞点击），
  // 悬停其他行即实时换序（本地预览），松手一次性落库；行内按钮（归档/删除）不发起拖拽
  function onProjPointerDown(e, id) {
    if (e.button !== 0 || e.target.closest('button')) return
    const d = { id, sx: e.clientX, sy: e.clientY, on: false }
    projDragRef.current = d
    const move = (ev) => {
      if (!projDragRef.current) return
      if (!d.on) {
        if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 6) return
        d.on = true
        suppressProjClick.current = true
        setDragProjId(d.id)
        document.body.classList.add('projlist-dragging')
      }
      const over = +document.elementFromPoint(ev.clientX, ev.clientY)
        ?.closest?.('[data-proj-id]')?.dataset?.projId
      if (!over || over === d.id) return
      const vis = orderedProjects(useAppStore.getState().projects)
        .filter((p) => !!p.archived === showArchived).map((p) => p.id)
      const from = vis.indexOf(d.id)
      const to = vis.indexOf(over)
      if (from < 0 || to < 0) return
      vis.splice(to, 0, ...vis.splice(from, 1))
      applyProjOrder(vis)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('projlist-dragging')
      projDragRef.current = null
      setDragProjId(null)
      if (d.on) prefsApi.set(0, 'proj_order', { order: projOrderRef.current }).catch(() => {})
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 挂载时拉取用户级全局偏好（项目顺序, project_id=0 跨项目）; 失败/为空回落服务端默认序
  useEffect(() => {
    let dead = false
    prefsApi.get(0).then((r) => {
      if (dead) return
      const order = (Array.isArray(r.prefs?.proj_order?.order) ? r.prefs.proj_order.order : [])
        .map(Number).filter(Number.isFinite)
      if (order.length) setProjOrder(order)
    }).catch(() => {})
    return () => { dead = true }
  }, [])

  // 侧栏宽度拖拽: 右缘 .vsplit 手柄, 180–480px; 松手落 localStorage, 双击手柄复位
  function onSideSplitDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = sideWRef.current
    document.body.classList.add('resizing-x')
    const move = (ev) => setSideW(Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, w0 + ev.clientX - x0)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-x')
      try { localStorage.setItem(SIDE_W_KEY, String(sideWRef.current)) } catch { /* 隐私模式: 忽略 */ }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 双击手柄: 复位默认宽度并清除记忆
  function resetSideW() {
    setSideW(SIDE_W_DEF)
    try { localStorage.removeItem(SIDE_W_KEY) } catch { /* 忽略 */ }
  }

  function openTab(name) {
    // 拖动标签结束后的 click 不切换（Radix Trigger 仍会触发 onValueChange）
    if (suppressTabClick.current) { suppressTabClick.current = false; return }
    setTab(name)
    localStorage.setItem('ts_cur_tab', name)
  }

  // 当前项目可见的标签 key 序（prefs 未加载完成时回落默认全可见）
  function visibleKeysOf(cfg) {
    return cfg.order.filter((k) => !cfg.hidden.includes(k))
  }

  // 布局变更统一出口：本地即时生效 + 落服务端 prefs（失败静默，布局记忆尽力而为）
  function saveTabCfg(next) {
    setTabCfg(next)
    const pid = store.currentProject?.id
    if (pid) prefsApi.set(pid, 'tabs', next).catch(() => {})
  }

  // 切换项目时拉取该 用户+项目 的标签页布局（404/失败保持默认布局）
  useEffect(() => {
    const pid = store.currentProject?.id
    if (!pid) return
    let dead = false
    prefsApi.get(pid).then((r) => { if (!dead) setTabCfg(normTabCfg(r.prefs?.tabs)) }).catch(() => {})
    setHiddenOpen(false)
    return () => { dead = true }
  }, [store.currentProject?.id])

  // 激活标签被隐藏（或布局载入后不含当前页）时回落到第一个可见标签
  const cfgNow = tabCfg || normTabCfg(null)
  const visibleKeys = visibleKeysOf(cfgNow)
  useEffect(() => {
    if (visibleKeys.length && !visibleKeys.includes(tab)) {
      setTab(visibleKeys[0])
      localStorage.setItem('ts_cur_tab', visibleKeys[0])
    }
  }, [tabCfg])  // 仅布局变化时校验（tab 本身变化必然可见）

  // 标签拖动排序：6px 阈值判定（防轻微位移吞点击）；拖动中悬停到其他标签上
  // 即实时交换顺序（本地预览），松手一次性落库
  function onTabPointerDown(e, key) {
    if (e.button !== 0) return
    const d = { key, sx: e.clientX, on: false }
    tabDragRef.current = d
    const move = (ev) => {
      if (!tabDragRef.current) return
      if (!d.on) {
        if (Math.hypot(ev.clientX - d.sx, ev.clientY) < 6) return
        d.on = true
        suppressTabClick.current = true
        setDragKey(d.key)
        document.body.classList.add('tabbar-dragging')
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY)
        ?.closest?.('[data-tab-key]')?.dataset?.tabKey
      if (!over || over === d.key) return
      setTabCfg((prev) => {
        const cur = normTabCfg(prev)
        const order = [...cur.order]
        const from = order.indexOf(d.key)
        const to = order.indexOf(over)
        if (from < 0 || to < 0) return prev
        order.splice(to, 0, ...order.splice(from, 1))
        return { ...cur, order }
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('tabbar-dragging')
      tabDragRef.current = null
      setDragKey(null)
      if (d.on) {
        const latest = normTabCfg(tabCfgRef.current)   // 镜像 ref 读最新布局落库
        saveTabCfg(latest)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 隐藏标签：从当前项目布局 hidden 中登记；关掉的是激活页则切到第一个可见页
  function hideTab(key) {
    const cur = normTabCfg(tabCfg)
    const next = { ...cur, hidden: [...cur.hidden, key] }
    saveTabCfg(next)
    const vis = visibleKeysOf(next)
    if ((tab === key || !vis.includes(tab)) && vis.length) {
      setTab(vis[0])
      localStorage.setItem('ts_cur_tab', vis[0])
    }
  }

  // 恢复隐藏标签：移出 hidden 并直达该页（恢复即用）；下拉保持打开便于连续恢复
  function restoreTab(key) {
    const cur = normTabCfg(tabCfg)
    saveTabCfg({ ...cur, hidden: cur.hidden.filter((k) => k !== key) })
    setTab(key)
    localStorage.setItem('ts_cur_tab', key)
  }

  function selectProject(id) {
    store.selectProject(id)
    localStorage.setItem('ts_cur_project', id)
  }

  async function scanAgents() {
    try {
      setAgents(await projectApi.agents())
    } catch {
      setAgents([])
    }
  }

  // 拉取当前智能体已配置的模型列表; 拉取成功且列表非空时, 清掉不在列表中的现值
  // (模型值口径=provider/模型 id, 引用已下线/旧格式的模型名会让起会话失败);
  // 列表为空(扫描失败/无模型目录)时保留现值防误清 —— 与 loadAgentSkills 同口径
  async function loadAgentModels(agentPath) {
    try {
      const opts = await projectApi.agentModels(agentPath)
      setModelOpts(opts)
      const names = new Set((opts.models || []).map((m) => m.name))
      if (names.size) {
        setPf((prev) => (prev.model && !names.has(prev.model) ? { ...prev, model: '' } : prev))
      }
    } catch {
      setModelOpts({ models: [], default: '' })
    }
  }

  // 拉取当前智能体可用的 skill 列表; 拉取成功且列表非空时, 清除已不在列表中的
  // 选中值(引用不存在的 skill 会误导 agent); 列表为空(扫描失败/dsh)时保留现值防误清
  async function loadAgentSkills(agentPath, projectDir) {
    try {
      const r = await projectApi.agentSkills(agentPath, projectDir)
      const skills = r.skills || []
      setSkillOpts(skills)
      if (skills.length) {
        const names = new Set(skills.map((s) => s.name))
        setPf((prev) => ({
          ...prev,
          skill_understand: names.has(prev.skill_understand) ? prev.skill_understand : '',
          skill_deploy: names.has(prev.skill_deploy) ? prev.skill_deploy : '',
          skill_commit: names.has(prev.skill_commit) ? prev.skill_commit : '',
          skill_test: names.has(prev.skill_test) ? prev.skill_test : '',
          skill_cases: names.has(prev.skill_cases) ? prev.skill_cases : '',
        }))
      }
    } catch {
      setSkillOpts([])
    }
  }

  function openProjectModal(p) {
    setEditId(p ? p.id : null)
    setPf({
      name: p?.name || '',
      project_dir: p?.project_dir || '',
      agent_path: p?.agent_path || '',
      work_dir: p?.work_dir || '',
      env_label: p?.env_label || '',
      guide_text: p?.guide_text || '',
      model: p?.model || '',
      // 项目级会话默认值（2026-10-04）：思考等级 / 权限档（''=不指定）
      reasoning_effort: p?.reasoning_effort || '',
      permission_mode: p?.permission_mode || '',
      skill_understand: p?.skill_understand || '',
      skill_deploy: p?.skill_deploy || '',
      skill_commit: p?.skill_commit || '',
      skill_test: p?.skill_test || '',
      skill_cases: p?.skill_cases || '',
    })
    rzReset()
    setProjModal(true)
    scanAgents()
    loadAgentModels(p?.agent_path || '')
    loadAgentSkills(p?.agent_path || '', p?.project_dir || '')
  }

  async function saveProject() {
    const body = { ...pf }
    // 项目名称留空: 自动取项目路径最后一段作为名称(后端有同逻辑兜底)
    if (!body.name) body.name = pathLastSeg(body.project_dir)
    if (!body.name) { toast('请填写项目名称'); return }
    try {
      const dupList = await projectApi.dupCheck({ project_dir: body.project_dir || '', work_dir: body.work_dir || '', exclude: editId })
      if (dupList.length) {
        setDups(dupList)
        setPendingBody(body)
        setDupModal(true)
        return
      }
      await submitProject(body)
    } catch (e) { toast(e.message) }
  }

  async function confirmDup() {
    setDupModal(false)
    if (pendingBody) {
      const b = pendingBody
      setPendingBody(null)
      await submitProject(b)
    }
  }

  async function submitProject(body) {
    try {
      const st = useAppStore.getState()
      if (editId) await st.updateProject(editId, body)
      else {
        const r = await st.createProject(body)
        await useAppStore.getState().selectProject(r.id)
      }
      setProjModal(false)
      toast(editId ? '已保存' : '项目已创建')
    } catch (e) { toast(e.message) }
  }

  // 归档/恢复项目（store 内完成刷新: 列表 + 当前项目状态）
  async function archiveProject(p, archived) {
    try {
      await useAppStore.getState().archiveProject(p.id, archived)
      toast(archived ? '项目已归档' : '项目已恢复')
    } catch (e) { toast(e.message) }
  }

  // 项目目录输入: 名称留空时自动取路径最后一段作为项目名称(用户已填名称则不覆盖)
  function onProjectDirChange(v) {
    const next = { ...pf, project_dir: v }
    if (!pf.name.trim()) next.name = pathLastSeg(v)
    setPf(next)
  }

  // 打开目录选择弹窗: 以已填的对应目录为起点(为空则由后端返回根列表视角)
  function openDirModal(target) {
    setDirTarget(target)
    setDirModal(true)
    setDirNewOpen(false)
    setDirNewName('')
    browseDir(pf[target])
  }

  // 浏览服务端目录(path 为空时后端返回根列表; Windows 盘符/Linux 单根由后端平台适配)
  async function browseDir(path) {
    setDirBusy(true)
    try {
      setDirData(await projectApi.fsBrowse(path))
    } catch (e) {
      toast(e.message)
    } finally {
      setDirBusy(false)
    }
  }

  // 进入目录(列表项/上级/刷新): 收起「新建文件夹」行并加载该目录
  function navDir(path) {
    setDirNewOpen(false)
    setDirNewName('')
    browseDir(path)
  }

  // 在当前浏览的目录下新建文件夹: 成功后直接进入新目录(便于紧接着「选择此目录」;
  // 目录多时新条目也可能被列表上限截掉, 进入即所见即所得)
  async function createDir() {
    const name = dirNewName.trim()
    if (!name) return
    setDirNewBusy(true)
    try {
      const d = await projectApi.fsMkdir(dirData?.path || '', name)
      toast(`已新建文件夹：${d?.name || name}`)
      navDir(d?.path || dirData?.path || '')
    } catch (e) {
      toast(e.message)
    } finally {
      setDirNewBusy(false)
    }
  }

  // 选中当前浏览的目录回填目标字段(项目目录在名称留空时同步自动填充)
  function pickDir() {
    if (!dirData?.path) return
    if (dirTarget === 'project_dir') onProjectDirChange(dirData.path)
    if (dirTarget === 'project_dir') loadAgentSkills(pf.agent_path, dirData.path)
    else setPf({ ...pf, [dirTarget]: dirData.path })
    setDirModal(false)
  }

  // 打开删除确认弹窗(仅归档项目): 需手动输入项目名称且完全一致才能提交
  function openDelModal(p) {
    setDelTarget(p)
    setDelName('')
    delRzReset()
  }

  // 确认删除项目: 仅删项目/任务/轮次记录, 磁盘上的案例与 bug 报告文件由用户手动清理
  async function confirmDeleteProject() {
    if (!delTarget) return
    try {
      await useAppStore.getState().deleteProject(delTarget.id, { confirm_name: delName })
      toast('项目已删除；案例文件与 bug 报告文件已保留，请自行手动清理')
      setDelTarget(null)
    } catch (e) { toast(e.message) }
  }

  // 改密/主题/飞书/RAG 配置均已迁至设置页（/settings），侧栏只保留「设置」与「菜单」两个入口

  async function logout() {
    await auth.logout()
    navigate('/login')
  }

  useEffect(() => {
    store.loadProjects()
    // 与旧实现一致: 5s 轮询任务与 bug 状态; 项目列表同刷(侧栏看板三列数量保持新鲜)
    refreshTimer.current = setInterval(() => {
      const st = useAppStore.getState()
      st.loadProjects().catch(() => {})
      if (st.currentProject) {
        st.loadTasks().catch(() => {})
        st.loadBugs().catch(() => {})
      }
    }, 5000)
    return () => clearInterval(refreshTimer.current)
  }, [])

  // 项目列表加载完成后自动选中项目(F5 恢复上次选择)
  const projects = useAppStore((s) => s.projects)
  const initDone = useRef(false)
  useEffect(() => {
    if (initDone.current || !projects.length) return
    initDone.current = true
    const st = useAppStore.getState()
    const saved = +localStorage.getItem('ts_cur_project') || 0
    // 回退优先选未归档项目, 全部已归档时才选第一个(避免一进来就落在归档项目上)
    const fallback = st.projects.find((x) => !x.archived) || st.projects[0]
    const pid = st.projects.find((x) => x.id === saved) ? saved : fallback.id
    st.selectProject(pid)
    const savedTab = localStorage.getItem('ts_cur_tab')
    if (TAB_KEYS.includes(savedTab)) setTab(savedTab)
  }, [projects])

  // 侧栏当前视图可见的项目（后端一次返回全量含 archived 标记, 前端按视图过滤;
  // 顺序按用户拖拽排序偏好 user_prefs proj_order 排列）
  const visibleProjects = orderedProjects(store.projects).filter((p) => !!p.archived === showArchived)

  // ---- 项目弹窗「模型」控件的展示口径（2026-10-03 修订）----
  // 值(name) = `provider/模型 id`（下传宿主用 id），显示 = `provider/显示名`（宿主目录口径）。
  //   modelExplicit：现值命中列表 = 用户显式选择（正常色）；否则为推定展示（暗色）
  //   推定顺序：智能体默认(default) → 列表第一项；都没有 → 哨兵「默认」
  //   不再为「不在列表的现值」补兜底项——该值已由 loadAgentModels 清空（同 skill 下拉口径）
  const modelList = modelOpts.models || []
  const modelExplicit = !!pf.model && modelList.some((m) => m.name === pf.model)
  const modelFallback = modelList.length
    ? (modelOpts.default ? '__default__' : modelList[0].name)
    : '__default__'
  const modelValue = modelExplicit ? pf.model : modelFallback
  // 默认项文案：按 default 值在列表里查显示名（避免「默认（provider/id）」与
  // 列表项「provider/显示名」看起来像两个不同模型）
  const modelDefaultItem = modelList.find((m) => m.name === modelOpts.default)
  const modelDefaultText = modelDefaultItem
    ? (modelDefaultItem.display_name || modelDefaultItem.name)
    : (modelOpts.default || '智能体默认')
  // ---- 项目弹窗「思考等级」选项（2026-10-04）----
  // 按当前（推定）模型从宿主模型目录取该模型支持的档位；模型未知/目录无档位信息时
  // 回落内置档位表（工具内部处理，fromCatalog=false 时列表项括注 id 提醒非目录来源）
  const effortModel = modelExplicit
    ? pf.model
    : (modelValue === '__default__' ? modelOpts.default : modelValue)
  const effortOpts = effortChoices(modelOpts, effortModel)

  return (
    <div className="flex h-svh">
      {/* 左侧边栏（宽度可拖右缘手柄调整, 双击复位） */}
      <aside style={{ width: sideW + 'px' }} className="flex flex-none flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 font-serif font-semibold">
          <TouchstoneLogo size={22} />
          <span>Touchstone</span>
        </div>
        <div className="flex items-center justify-between px-4 pt-3 pb-1 font-mono text-[calc(10px*var(--fs))] uppercase tracking-[0.14em] text-muted-foreground">
          <span>{showArchived ? '已归档项目' : '项目列表'}</span>
          <button type="button" title={showArchived ? '返回项目列表' : '查看已归档项目'}
            className="rounded p-0.5 hover:text-foreground"
            onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {visibleProjects.map((p) => (
            <div key={p.id} data-proj-id={p.id}
              className={'proj-item cursor-pointer select-none rounded-lg border px-2.5 py-2 transition-colors ' +
                (store.currentProject?.id === p.id
                  ? 'border-primary/60 bg-accent'
                  : 'border-transparent hover:bg-accent/60') +
                (p.archived ? ' opacity-60' : '') +
                (dragProjId === p.id ? ' proj-dragging' : '')}
              onPointerDown={(e) => onProjPointerDown(e, p.id)}
              onClick={() => {
                // 拖动排序结束后的 click 不切换项目（防拖完误选）
                if (suppressProjClick.current) { suppressProjClick.current = false; return }
                selectProject(p.id)
              }}>
              <div className="flex items-center gap-1">
                <div className={'flex-1 truncate text-sm font-semibold ' + (store.currentProject?.id === p.id ? 'text-[var(--tab-active)]' : '')}>{p.name}</div>
                {/* 归档/恢复入口: 阻止冒泡, 避免触发卡片选中 */}
                <button type="button" title={p.archived ? '恢复项目' : '归档项目'}
                  className="flex-none rounded p-1 text-muted-foreground hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); archiveProject(p, !p.archived) }}>
                  {p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                </button>
                {/* 删除入口仅归档项目提供: 需弹窗输入项目名确认 */}
                {p.archived && (
                  <button type="button" title="删除项目"
                    className="flex-none rounded p-1 text-muted-foreground hover:text-[var(--fail, #dc2626)]"
                    onClick={(e) => { e.stopPropagation(); openDelModal(p) }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div className="truncate font-mono text-[calc(11px*var(--fs))] text-muted-foreground">{p.project_dir}</div>
              {/* 看板三列数量（正在开发/阻塞/待审核）：来自后端 board_counts, 颜色与看板列一致 */}
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[calc(10px*var(--fs))] text-muted-foreground">
                <span>正在开发 <b className="font-semibold text-[var(--run)]">{p.board_counts?.doing ?? 0}</b></span>
                <span>阻塞 <b className="font-semibold text-[var(--fail)]">{p.board_counts?.blocked ?? 0}</b></span>
                <span>待审核 <b className="font-semibold text-[var(--retest)]">{p.board_counts?.review ?? 0}</b></span>
              </div>
            </div>
          ))}
          {!visibleProjects.length && <div className="p-2 text-xs text-muted-foreground">{showArchived ? '暂无已归档项目' : '暂无项目'}</div>}
        </div>
        <div className="flex items-center gap-1 border-t border-border px-2.5 py-2">
          <span className="mr-auto truncate text-xs text-muted-foreground">{auth.username}</span>
          {/* 设置: 独立页面(左侧分区列表 + 右侧内容), 主题/改密/飞书/RAG 全在该页 */}
          <Button variant="ghost" size="sm" title="站点设置" onClick={() => navigate('/settings')}>
            <Settings /> 设置
          </Button>
          {/* 菜单: 只保留 管理 / 登出 两项(自绘下拉, 无新增依赖) */}
          <div className="sets-wrap">
            <Button variant="ghost" size="sm" onClick={() => setSetOpen((v) => !v)}>
              <Menu /> 菜单
            </Button>
            {setOpen && (
              <>
                <div className="sets-mask" onClick={() => setSetOpen(false)}></div>
                <div className="sets-menu">
                  {auth.isAdmin && (
                    <button type="button" onClick={() => { setSetOpen(false); navigate('/admin') }}>
                      <ShieldUser /> 管理
                    </button>
                  )}
                  <button type="button" className="danger" onClick={logout}>
                    <LogOut /> 登出
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* 侧栏宽度拖拽手柄: 拖动改宽(180–480px), 双击复位 230px */}
      <div className="vsplit side-split" title="拖动调整侧栏宽度，双击复位"
        onMouseDown={onSideSplitDown} onDoubleClick={resetSideW}></div>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-3 border-b border-border bg-card px-4 py-2">
          <h2 className="m-0 truncate font-serif text-[calc(15px*var(--fs))] font-semibold">
            {store.currentProject?.name || '— 未选择项目'}
          </h2>
          {store.currentProject?.archived && (
            <span className="flex-none rounded-full border border-border px-2 py-0.5 text-[calc(10px*var(--fs))] text-muted-foreground">已归档</span>
          )}
          <div className="flex-1"></div>
          <Button size="sm" onClick={() => openProjectModal()}>
            <Plus /> 添加项目
          </Button>
          {store.currentProject && (
            <Button size="sm" variant="outline" onClick={() => openProjectModal(store.currentProject)}>
              <Pencil /> 编辑项目
            </Button>
          )}
          {store.currentProject && (
            <Button size="sm" variant="outline"
              title="归档后从项目列表默认隐藏，可在侧栏「已归档项目」视图中恢复"
              onClick={() => archiveProject(store.currentProject, !store.currentProject.archived)}>
              {store.currentProject.archived ? <ArchiveRestore /> : <Archive />}
              {store.currentProject.archived ? '恢复项目' : '归档项目'}
            </Button>
          )}
        </div>
        {/* bikeops 流光分割线: 头部与内容区之间的 aurora → star 渐变 */}
        <hr className="aurora-line" />
        <div className="flex min-h-0 flex-1 flex-col">
          {store.currentProject ? (
            <Tabs value={tab} onValueChange={openTab} className="flex min-h-0 flex-1 flex-col">
              {/* 标签栏：顺序/隐藏按 用户+项目 记忆；拖动排序（6px 阈值）、hover 出 × 隐藏、
                  右侧按钮恢复隐藏页；TabsContent 必须 min-h-0, 否则会被内容撑高无法滚动 */}
              <div className="flex flex-none items-center border-b border-border pr-2">
                <TabsList className="w-fit justify-start rounded-none border-none bg-transparent px-2 py-0">
                  {visibleKeys.map((k) => (
                    <TabsTrigger key={k} value={k} data-tab-key={k}
                      className={'tabbar-trigger pr-5 data-[state=active]:text-[var(--tab-active)]' + (dragKey === k ? ' tabbar-dragging' : '')}
                      onPointerDown={(e) => onTabPointerDown(e, k)}>
                      {TAB_LABEL[k]}
                      <span className="tabbar-hide" title="隐藏此标签页（可点右侧按钮恢复）"
                        onClick={(e) => { e.stopPropagation(); hideTab(k) }}
                        onPointerDown={(e) => e.stopPropagation()}>
                        <X className="size-2.5" />
                      </span>
                    </TabsTrigger>
                  ))}
                  {!visibleKeys.length && (
                    <span className="px-3 py-2 text-xs text-muted-foreground">标签页已全部隐藏</span>
                  )}
                </TabsList>
                <div className="ml-auto"></div>
                <div className="sets-wrap">
                  <Button variant="ghost" size="sm" title="显示/恢复隐藏的标签页"
                    onClick={() => setHiddenOpen((v) => !v)}>
                    <EyeOff />
                    {cfgNow.hidden.length ? `隐藏 ${cfgNow.hidden.length}` : '标签页'}
                  </Button>
                  {hiddenOpen && (
                    <>
                      <div className="sets-mask" onClick={() => setHiddenOpen(false)}></div>
                      <div className="sets-menu drop-down">
                        {!cfgNow.hidden.length && (
                          <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            没有隐藏的标签页。
                            <br />把鼠标悬停到标签上点 × 即可隐藏。
                          </div>
                        )}
                        {cfgNow.hidden.map((k) => (
                          <button key={k} type="button" onClick={() => restoreTab(k)}>
                            <EyeOff /> {TAB_LABEL[k]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              {/* TabsContent 本身必须是 flex 容器: 子级(tasks-tab 等)依赖 flex:1 撑满并内部滚动; 顺序与 Trigger 对齐 */}
              <TabsContent value="board" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <BoardTab project={store.currentProject} />
              </TabsContent>
              <TabsContent value="tasks" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <TasksTab onCreated={(type) => { if (type === 'stress') openTab('stress') }} />
              </TabsContent>
              <TabsContent value="stress" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <StressTab />
              </TabsContent>
              <TabsContent value="monitor" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <MonitorTab project={store.currentProject} />
              </TabsContent>
              <TabsContent value="bugs" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <BugsTab project={store.currentProject} />
              </TabsContent>
            </Tabs>
          ) : (
            <div className="mt-20 text-center text-sm text-muted-foreground">
              ← 选择一个项目，或点击"添加项目"创建
            </div>
          )}
        </div>
      </main>

      {/* 添加/编辑项目弹窗: 保留自定义拖拽 (modal/modal-rz + 8 方向手柄) */}
      <Dialog open={projModal} onOpenChange={setProjModal}>
        <DialogContent
          className={'modal modal-rz' + (rzOn ? ' rz-drag' : '')}
          style={{ ...rzStyle, marginTop: 0 }}
          showCloseButton={false}
        >
          <RzHandles start={rzStart} reset={rzReset} />
          <DialogHeader className="text-left">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={rzDragStart}>
              {editId ? '编辑项目' : '添加项目'}
            </DialogTitle>
          </DialogHeader>
          <div className="modal-scroll overflow-y-auto">
            <div className="form-row"><label>项目名称</label>
              <Input value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value.trim() })} placeholder="如 my-project" /></div>
            <div className="form-row"><label>项目目录</label>
              <Input value={pf.project_dir} onChange={(e) => onProjectDirChange(e.target.value.trim())}
                onBlur={() => loadAgentSkills(pf.agent_path, pf.project_dir)}
                placeholder="/path/to/your/project" />
              <Button variant="outline" size="sm" onClick={() => openDirModal('project_dir')} title="浏览服务端目录并选择">
                <FolderOpen /> 浏览
              </Button></div>
            <div className="form-row">
              <label>智能体</label>
              {/* Radix Select 不接受空字符串 value, 用手动哨兵值 __manual__ 表示"手动填写路径" */}
              <Select value={pf.agent_path || '__manual__'}
                onValueChange={(v) => {
                  const ap = (v === '__manual__' || v === '__missing__') ? '' : v
                  setPf({ ...pf, agent_path: ap })
                  loadAgentModels(ap)  // 智能体切换后模型列表随之刷新
                  loadAgentSkills(ap, pf.project_dir)  // 智能体切换后技能列表随之刷新
                }}>
                <SelectTrigger className="min-w-[200px] flex-1">
                  <SelectValue placeholder="手动填写路径" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__manual__">手动填写路径</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.path || a.name} value={a.found ? a.path : '__missing__'}>
                      {a.found ? `${a.name} · ${a.version || a.path}` : `${a.name} 未找到`}
                    </SelectItem>
                  ))}
                  {/* 现值兜底项：绑定路径不在扫描结果里（P7b 之前的存量旧族绑定，如 kimi-web:/
                      裸 dsh 可执行）时补一条只读项——否则 Radix Select 找不到匹配项，触发器会
                      退化成占位符「手动填写路径」，看着像这个项目没绑智能体 */}
                  {(() => {
                    const cur = (pf.agent_path || '').trim()
                    if (!cur || agents.some((a) => a.found && a.path === cur)) return null
                    return (
                      <SelectItem value={cur}>
                        {cur.startsWith('dsh-plugin:')
                          ? `dsh（插件·进程内） ${cur.slice(11)}`
                          : `${cur}（当前绑定）`}
                      </SelectItem>
                    )
                  })()}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={scanAgents} title="重新扫描本机 CLI">
                <RefreshCw /> 扫描
              </Button>
            </div>
            <div className="hint" style={{ margin: '-4px 0 8px 110px' }}>智能体只有「dsh（插件·进程内）」一个入口：无需额外参数，模型取自宿主 ~/.dsh/settings.yaml（也可在此显式指定）；kimi/opencode/claude/hermes 旧族与 dsh CLI（裸 dsh 可执行）均已退场，存量旧绑定起跑会报「该智能体族已下线」，请改绑本入口</div>
            <div className="form-row">
              <label title="当前智能体已配置的模型；保存后新创建的任务（含修复/复测）默认使用该模型，已建任务不受影响">模型</label>
              {/* 智能体有模型列表(dsh 插件族: 宿主 /models 目录)时渲染下拉选择(无搜索过滤);
                  无列表(空/退场/未知路径、驱动不可用或扫描失败)时退回自由输入, 保留手填能力 */}
              {modelList.length ? (
                <Select value={modelValue}
                  onValueChange={(v) => setPf({ ...pf, model: v === '__default__' ? '' : v })}>
                  {/* 非用户显式选择（暗色）= 展示推定值（智能体默认/列表第一项） */}
                  <SelectTrigger className={'min-w-[200px] flex-1' + (modelExplicit ? '' : ' text-muted-foreground')}
                    title={modelExplicit ? '' : '尚未显式选择：暗色显示的是当前智能体的默认模型（留空即用默认）'}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* 哨兵项=留空用智能体默认模型(Radix Select 不允许空串值, 用 __default__ 代理) */}
                    <SelectItem value="__default__">
                      {modelOpts.default ? `默认（${modelDefaultText}）` : '默认（智能体默认）'}
                    </SelectItem>
                    {modelList.map((m) => (
                      <SelectItem key={m.name} value={m.name}>{m.display_name || m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input className="max-w-[240px]"
                  placeholder={modelOpts.default ? `默认（${modelDefaultText}）` : '默认（智能体默认）'}
                  value={pf.model} onChange={(e) => setPf({ ...pf, model: e.target.value.trim() })} />
              )}
            </div>
            <div className="hint" style={{ margin: '-4px 0 8px 110px' }}>留空用智能体默认模型；设置后从下一条任务开始生效</div>
            {/* 思考等级（2026-10-04）：与「模型」同层——会话的默认 dsh reasoningEffort。
                选项按当前（推定）模型从宿主模型目录取（只列该模型支持的档位；目录不可用
                时回落内置档位表）；留空＝智能体默认档。 */}
            <div className="form-row">
              <label title="项目内会话的默认思考等级（dsh reasoningEffort）；留空用智能体默认档">思考等级</label>
              <Select value={pf.reasoning_effort || '__default__'}
                onValueChange={(v) => setPf({ ...pf, reasoning_effort: v === '__default__' ? '' : v })}>
                <SelectTrigger className={'min-w-[200px] flex-1' + (pf.reasoning_effort ? '' : ' text-muted-foreground')}
                  title={pf.reasoning_effort ? '' : '尚未显式选择：暗色显示的是智能体默认档（留空即用默认）'}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* 哨兵项=留空用智能体默认档（Radix Select 不允许空串值） */}
                  <SelectItem value="__default__">
                    {effortOpts.defaultEffort
                      ? `默认（${(effortOpts.options.find((o) => o.value === effortOpts.defaultEffort) || {}).label || effortOpts.defaultEffort}）`
                      : '默认（智能体默认）'}
                  </SelectItem>
                  {/* 现值兜底项：档位来自宿主目录，换了模型/老插件可能不在当前选项里 */}
                  {pf.reasoning_effort && !effortOpts.options.some((o) => o.value === pf.reasoning_effort) && (
                    <SelectItem value={pf.reasoning_effort}>{pf.reasoning_effort}</SelectItem>
                  )}
                  {effortOpts.options.map((o) => (
                    <SelectItem key={o.value} value={o.value} title={o.title}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="hint" style={{ margin: '-4px 0 8px 110px' }}>思考等级：列表来自当前模型的可用档位；留空用智能体默认；设置后新起的会话（含任务与看板卡）按此档运行</div>
            {/* 权限档（2026-10-04）：项目内**看板卡片会话**的默认权限档（三档语义近似映射见
                server.DSH_PERMISSION_PRESETS）；任务会话暂不适用（无审批作答面，manual 会挂起）。 */}
            <div className="form-row">
              <label title="项目内看板卡片会话的默认权限档；留空用宿主默认（完全访问）">权限</label>
              <Select value={pf.permission_mode || '__default__'}
                onValueChange={(v) => setPf({ ...pf, permission_mode: v === '__default__' ? '' : v })}>
                <SelectTrigger className={'min-w-[200px] flex-1' + (pf.permission_mode ? '' : ' text-muted-foreground')}
                  title={pf.permission_mode ? '' : '尚未显式选择：暗色显示的是宿主默认档（留空即用默认）'}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">默认（宿主默认）</SelectItem>
                  {PERM_OPTS.map((o) => (
                    <SelectItem key={o.value} value={o.value} title={o.desc}>
                      <span className="sess-perm-item">
                        <span className="sess-perm-label">{o.label}</span>
                        <span className="sess-perm-desc">{o.desc}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="hint" style={{ margin: '-4px 0 8px 110px' }}>权限：项目内新起的看板卡片会话按此档运行（逐条确认＝平台接管审批代答）；任务会话暂不支持权限档</div>
            <div className="form-row"><label title="理解/分析项目时优先使用的 skill，注入每类任务首轮提示词">理解项目</label>
              <Select value={pf.skill_understand || '__none__'}
                onValueChange={(v) => setPf({ ...pf, skill_understand: v === '__none__' ? '' : v })}>
                <SelectTrigger className="min-w-[200px] flex-1"><SelectValue placeholder="不指定" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不指定</SelectItem>
                  {skillOpts.map((s) => (
                    <SelectItem key={`u-${s.name}`} value={s.name} title={s.description}>
                      {s.name}{s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="form-row"><label title="修复任务自动部署=开时使用的 skill">部署项目</label>
              <Select value={pf.skill_deploy || '__none__'}
                onValueChange={(v) => setPf({ ...pf, skill_deploy: v === '__none__' ? '' : v })}>
                <SelectTrigger className="min-w-[200px] flex-1"><SelectValue placeholder="不指定" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不指定</SelectItem>
                  {skillOpts.map((s) => (
                    <SelectItem key={`d-${s.name}`} value={s.name} title={s.description}>
                      {s.name}{s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="form-row"><label title="修复任务自动提交=开时使用的 skill">提交项目</label>
              <Select value={pf.skill_commit || '__none__'}
                onValueChange={(v) => setPf({ ...pf, skill_commit: v === '__none__' ? '' : v })}>
                <SelectTrigger className="min-w-[200px] flex-1"><SelectValue placeholder="不指定" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不指定</SelectItem>
                  {skillOpts.map((s) => (
                    <SelectItem key={`c-${s.name}`} value={s.name} title={s.description}>
                      {s.name}{s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="form-row"><label title="测试本项目时优先使用的 skill，注入每类任务首轮提示词">测试项目</label>
              <Select value={pf.skill_test || '__none__'}
                onValueChange={(v) => setPf({ ...pf, skill_test: v === '__none__' ? '' : v })}>
                <SelectTrigger className="min-w-[200px] flex-1"><SelectValue placeholder="不指定" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不指定</SelectItem>
                  {skillOpts.map((s) => (
                    <SelectItem key={`t-${s.name}`} value={s.name} title={s.description}>
                      {s.name}{s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="form-row"><label title="生成用例时遵循的命名/结构/登记规范 skill，注入每类任务首轮提示词">用例规范</label>
              <Select value={pf.skill_cases || '__none__'}
                onValueChange={(v) => setPf({ ...pf, skill_cases: v === '__none__' ? '' : v })}>
                <SelectTrigger className="min-w-[200px] flex-1"><SelectValue placeholder="不指定" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不指定</SelectItem>
                  {skillOpts.map((s) => (
                    <SelectItem key={`cs-${s.name}`} value={s.name} title={s.description}>
                      {s.name}{s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="hint" style={{ margin: '-4px 0 8px 110px' }}>选项来自当前智能体可用的 skill（dsh 无 skill 机制恒为空）；理解/测试项目/用例规范项注入每类任务首轮，部署/提交项仅注入修复任务的对应条款（自动提交/部署=开时）</div>
            <div className="form-row"><label>工作目录</label>
              <Input value={pf.work_dir} onChange={(e) => setPf({ ...pf, work_dir: e.target.value.trim() })} placeholder="默认 &lt;项目目录&gt;/.touchstone；其下自动生成案例库 free_style 与 bug 报告 bug_report" />
              <Button variant="outline" size="sm" onClick={() => openDirModal('work_dir')} title="浏览服务端目录并选择">
                <FolderOpen /> 浏览
              </Button></div>
            <div className="form-row"><label>环境标签</label>
              <Input value={pf.env_label} onChange={(e) => setPf({ ...pf, env_label: e.target.value.trim() })} placeholder="如 test4 / sitA1，测试、修复、部署针对的环境" /></div>
            <div className="form-col">
              <Label className="text-xs text-muted-foreground">项目附加提示词</Label>
              <Textarea value={pf.guide_text} onChange={(e) => setPf({ ...pf, guide_text: e.target.value })} rows={3} className="min-h-0"
                placeholder="填写如何理解项目 / 如何写 git commit message / 如何部署项目 等信息；内容会加入每个任务的提示词"></Textarea>
            </div>
          </div>
          <DialogFooter className="flex-none">
            <Button variant="outline" onClick={() => setProjModal(false)}>取消</Button>
            <Button onClick={saveProject}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 目录重复提醒弹窗 */}
      <Dialog open={dupModal} onOpenChange={setDupModal}>
        <DialogContent
          className={'modal modal-rz' + (dupRzOn ? ' rz-drag' : '')}
          style={{ ...dupRzStyle, marginTop: 0 }}
          showCloseButton={false}
        >
          <RzHandles start={rzStart} reset={rzReset} />
          <DialogHeader className="text-left">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={dupDragStart}>目录重复提醒</DialogTitle>
          </DialogHeader>
          {dups.map((d, i) => (
            <div className="dup-item" key={i}>
              <b>{DUP_LABEL[d.field] || d.field}</b> {d.value}
              <span className="dup-owner">被「{d.username} / {d.project_name}」使用</span>
            </div>
          ))}
          <div className="hint" style={{ textAlign: 'left', margin: '6px 0 0' }}>重复的目录可能与其他项目的案例库/报告互相干扰，确认仍要保存？</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupModal(false)}>返回修改</Button>
            <Button onClick={confirmDup}>仍然保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 目录选择弹窗(服务端目录浏览): Windows 盘符/Linux 单根由后端 roots 适配, 前端不判断系统;
          宽度随内容扩展(modal-dir, 见 components.css): 长路径不再把工具栏/底栏按钮挤出弹窗被裁掉 */}
      <Dialog open={dirModal} onOpenChange={setDirModal}>
        <DialogContent
          className={'modal modal-rz modal-dir' + (dirRzOn ? ' rz-drag' : '')}
          style={{ ...dirRzStyle, marginTop: 0 }}
          showCloseButton={false}
        >
          <RzHandles start={rzStart} reset={dirRzReset} />
          <DialogHeader className="text-left">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={dirDragStart}>
              选择目录
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={dirData?.path || ''}>
              {dirData?.path || '（选择根目录）'}
            </span>
            <Button variant="outline" size="sm" disabled={dirBusy || !dirData?.parent}
              onClick={() => navDir(dirData.parent)}>
              <ArrowUp /> 上级
            </Button>
            <Button variant="outline" size="sm" disabled={dirBusy}
              onClick={() => navDir(dirData?.path || '')}>
              <RefreshCw /> 刷新
            </Button>
            <Button variant="outline" size="sm" disabled={dirBusy || !dirData?.path}
              onClick={() => { setDirNewOpen(!dirNewOpen); setDirNewName('') }}
              title={dirData?.path ? `在 ${dirData.path} 下新建文件夹` : '请先进入一个目录'}>
              <FolderPlus /> 新建文件夹
            </Button>
          </div>
          {/* 新建文件夹行(内联展开, 常驻于工具栏下方): Enter 或「创建」提交, 成功后直接进入新目录 */}
          {dirNewOpen && (
            <div className="flex items-center gap-1.5">
              <Input autoFocus value={dirNewName} disabled={dirNewBusy}
                onChange={(e) => setDirNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createDir() }}
                placeholder="新文件夹名称（在当前目录下创建）" />
              <Button size="sm" disabled={dirNewBusy || !dirNewName.trim()} onClick={createDir}>
                {dirNewBusy ? '创建中…' : '创建'}
              </Button>
              <Button variant="outline" size="sm" disabled={dirNewBusy}
                onClick={() => { setDirNewOpen(false); setDirNewName('') }}>
                取消
              </Button>
            </div>
          )}
          <div className="modal-scroll max-h-[50vh] min-h-[120px] overflow-y-auto rounded-md border border-border p-1">
            {dirBusy && <div className="p-2 text-xs text-muted-foreground">加载中…</div>}
            {!dirBusy && !(dirData?.dirs || []).length && (
              <div className="p-2 text-xs text-muted-foreground">无子目录</div>
            )}
            {!dirBusy && (dirData?.dirs || []).map((d) => (
              <button key={d.path} type="button"
                className="block w-full truncate rounded px-2 py-1 text-left font-mono text-sm hover:bg-accent"
                title={d.path}
                onClick={() => navDir(d.path)}>
                {d.name}
              </button>
            ))}
          </div>
          <DialogFooter className="flex-none">
            <Button variant="outline" onClick={() => setDirModal(false)}>取消</Button>
            <Button disabled={dirBusy || !dirData?.path} onClick={pickDir}>选择此目录</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除项目确认弹窗(仅归档项目): 手动输入项目名称一致才能删除;
          案例文件与 bug 报告文件不自动删除, 由用户手动清理 */}
      <Dialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }}>
        <DialogContent
          className={'modal modal-rz' + (delRzOn ? ' rz-drag' : '')}
          style={{ ...delRzStyle, marginTop: 0 }}
          showCloseButton={false}
        >
          <RzHandles start={rzStart} reset={delRzReset} />
          <DialogHeader className="text-left">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={delDragStart}>
              删除项目
            </DialogTitle>
          </DialogHeader>
          {delTarget && (
            <div className="space-y-1 text-sm">
              <div><span className="text-muted-foreground">项目名称：</span><b>{delTarget.name}</b></div>
              <div className="truncate font-mono text-xs text-muted-foreground">{delTarget.project_dir}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">工作目录：{delTarget.work_dir}</div>
            </div>
          )}
          <div className="form-row"><label>输入项目名称确认</label>
            <Input value={delName} onChange={(e) => setDelName(e.target.value)}
              placeholder={delTarget?.name || ''} /></div>
          <div className="hint" style={{ textAlign: 'left', margin: '0' }}>
            将删除项目及其全部任务与轮次记录，不可恢复。磁盘上的案例文件与 bug 报告文件不会删除，请自行手动清理。
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelTarget(null)}>取消</Button>
            <Button variant="destructive" disabled={!delTarget || delName !== delTarget.name}
              onClick={confirmDeleteProject}>
              确定删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

