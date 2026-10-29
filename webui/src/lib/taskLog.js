// 任务轮次日志入口（任务详情轮次表「查看日志」）的打开目标与返回记忆。
//
// 背景（2026-10-27 修复，用户复报 2026-10-02 的旧 bug 并补了桌面端现象）：
//   旧实现是 `window.open('/log?task=…&round=…', '_blank')`，在两档形态下都坏：
//   ① dsh 插件形态（BASE=/touchstone/）：根相对 /log 落到 **dsh 宿主根** ⇒ 404「找不到网页」；
//   ② dsh 桌面端：宿主页 origin 是桌面壳的自定义 scheme（上游 apps/desktop/src/main.ts：
//      applicationUrl = `dsh://app/`，窗口 open handler 只把 http(s) 交给系统浏览器、
//      其余一律 `{action:'deny'}`）⇒ window.open(相对地址) 解析成 dsh://app/log…，
//      既不开浏览器也不开窗口，点了完全没反应（「按钮无法点开」）。
//   现口径：插件形态（BASE≠'/'）**在面板 SPA 内用 router 导航**（basename 由 BrowserRouter
//   自带，web / 桌面两档同一条路径，不依赖新窗口）；独立 web 形态保持新标签页，URL 必须补
//   BASE。BASE 取值与 `api/index.js`、`lib/lastRoute.js` 同口径（BASE_URL 去尾斜杠）。
//
// 另含「返回后恢复任务详情展开」的一次性记忆：面板内导航会卸载 TasksTab，模块级变量在同
// 文档内跨路由 mount 存活（宿主页刷新/iframe 重建后自然丢失，退回未展开是正确兜底）。

/** 日志页路由（与 App.jsx 的 <Route path="/log" …> 对齐）。 */
const LOG_ROUTE = '/log'

/** 应用基路径（独立形态 ''，dsh 插件形态 '/touchstone'；与 main.jsx 的 basename 同口径）。 */
function basePath() {
  return (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
}

/** 是否 dsh 插件形态构建（base=/touchstone/）。 */
export function isPluginBuild() {
  return basePath() !== ''
}

/**
 * 应用内日志路由（react-router basename 相对）：`/log?task=..&round=..`。
 * @param taskId - 任务 id。
 * @param roundNo - 轮次号。
 */
export function logRoute(taskId, roundNo) {
  return `${LOG_ROUTE}?task=${encodeURIComponent(taskId)}&round=${encodeURIComponent(roundNo)}`
}

/**
 * 浏览器绝对路径（含 BASE）：插件形态 `/touchstone/log?…`，独立形态 `/log?…`。
 * 只给「新标签页」通道用（window.open 传相对地址会被宿主 scheme/前缀吃掉）。
 */
export function logHref(taskId, roundNo) {
  return basePath() + logRoute(taskId, roundNo)
}

/**
 * 「查看日志」的打开目标（纯函数，便于单测两档形态）：
 *   {kind:'navigate', to}   —— 插件形态：面板内路由导航；
 *   {kind:'new-tab', href}  —— 独立形态：新标签页（href 已补 BASE）。
 */
export function logOpenTarget(taskId, roundNo) {
  return isPluginBuild()
    ? { kind: 'navigate', to: logRoute(taskId, roundNo) }
    : { kind: 'new-tab', href: logHref(taskId, roundNo) }
}

// ── 返回后恢复任务详情展开（跨路由 mount 的一次性记忆）─────────────────────────
let pendingReturnTaskId = 0

/** 记下「从哪个任务跳去日志页的」，供面板内导航返回时恢复展开。 */
export function markLogReturn(taskId) {
  pendingReturnTaskId = Number(taskId) || 0
}

/** 取走一次性记忆（读后即清；无记忆返回 0）。 */
export function takeLogReturn() {
  const id = pendingReturnTaskId
  pendingReturnTaskId = 0
  return id
}
