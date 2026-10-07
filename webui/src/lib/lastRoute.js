// 上次所在页面记忆（路由级）—— 「切到 dsh 界面再回来，回到切走前的页面」的 SPA 半边。
//
// 两个消费方（键名 **逐字一致**，两侧改动必须同步）：
//   ① 插件宿主半 dsh-plugin/src/client.js 的 panelEntry()：面板 iframe 首次挂载时按本键
//      拼 iframe src —— 覆盖「dsh 宿主页刷新/重开」这一档（那时 iframe 必须重建）；
//   ② 本模块的 restoreLastRoute()：SPA 自己在入口页启动时改址到记忆页（独立形态刷新、
//      或宿主半没拿到记忆值时的兜底）。
// 面板开合之间的保真由「面板保活」负责（iframe 常驻，不清文档），本模块只管跨文档重启。
//
// 落盘口径 = **绝对浏览器路径**（含 base：插件形态 /touchstone/settings/rag，独立形态
// /settings/rag）—— 宿主半要拿它直接当 iframe src，SPA 侧要拿它直接 replaceState。
// 注意 react-router 的 useLocation().pathname 是 **basename 相对**的（/settings/rag），
// 故写入时统一补上 base（2026-10-07 真机踩过：漏补会让宿主半认不出前缀、SPA 自己改址
// 还会跳出插件前缀）。
//
// 只记「主页面」路由：/login（登录页不该被记住）与 /log（任务日志是 window.open 出来的
// 旁路新标签页，记住它会让面板下次一开就跳到日志页）一律跳过。

/** localStorage 键（宿主半 client.js 的 ROUTE_KEY 同值）。 */
export const LAST_ROUTE_KEY = 'ts.last_route'

/** 可记忆的路由首段白名单（与 App.jsx 的路由表对齐；改路由时同步这里）。 */
const ROUTE_HEADS = ['', 'app', 'monitor', 'admin', 'settings']

/** 应用基路径（独立形态 ''，dsh 插件形态 '/touchstone'；与 main.jsx 的 basename 同口径）。 */
function basePath() {
  return (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
}

/**
 * 取浏览器路径在应用内的路由部分（剥掉 base；已是路由形式则原样返回）。
 * @param pathname - window.location.pathname 或 useLocation().pathname。
 * @returns 形如 '/settings/rag' 的路由路径。
 */
function toRoute(pathname) {
  const base = basePath()
  if (base && pathname.startsWith(base + '/')) return pathname.slice(base.length)
  if (base && pathname === base) return '/'
  return pathname
}

/**
 * 路由路径 → 绝对浏览器路径（补 base；已带 base 的输入保持原样）。
 * @param pathname - useLocation().pathname（basename 相对）。
 * @returns 形如 '/touchstone/settings/rag' 的浏览器路径。
 */
function toBrowserPath(pathname) {
  const route = toRoute(pathname)
  return basePath() + (route.startsWith('/') ? route : '/' + route)
}

/**
 * 浏览器路径是否是「应用入口页」（根或 /app；含 base）。
 * 只在入口页上恢复记忆 —— 用户手输/书签的深链优先，不被记忆覆盖。
 * @param pathname - window.location.pathname；search 一并算入口（入口页不该带查询串）。
 */
function isEntry(pathname, search) {
  const base = basePath()
  const entry = base ? [base + '/', base + '/app'] : ['/', '/app']
  return entry.includes(pathname) && !search
}

/**
 * 记下当前页面（App 的路由监听每换一页调用一次）。
 * @param pathname - useLocation().pathname（basename 相对，如 '/settings/rag'）。
 * @param search - useLocation().search（含 '?'，无则为 ''）。
 */
export function writeLastRoute(pathname, search = '') {
  try {
    if (!pathname) return
    const route = toRoute(pathname)
    if (route === '/login' || route === '/log') return // 登录页 / 旁路日志页不记
    localStorage.setItem(LAST_ROUTE_KEY, basePath() + route + (search || ''))
  } catch { /* 隐私模式等场景忽略 */ }
}

/**
 * 读回记忆的页面（脏值一律当没有).
 * @returns 形如 '/touchstone/settings/rag' 的浏览器路径；无效/无记忆返回 ''。
 */
export function readLastRoute() {
  try {
    const raw = localStorage.getItem(LAST_ROUTE_KEY) || ''
    if (!raw.startsWith('/')) return '' // 只认绝对路径
    const base = basePath()
    if (base && !(raw === base || raw.startsWith(base + '/'))) return '' // 必须在本应用 base 下
    const [pathname, search = ''] = raw.split('?')
    const head = toRoute(pathname).split('/')[1] || ''
    if (!ROUTE_HEADS.includes(head)) return '' // 非本应用路由（脏值/异前缀）不当记忆用
    return raw
  } catch { return '' }
}

/**
 * 启动时恢复上次页面：仅当当前停在应用入口页（且与记忆不同）时改址，返回改址后的路径。
 * 深链/书签（已是具体页面）一律不动；改址用 replaceState，不污染浏览器历史。
 * @returns 恢复到的路径；未恢复返回 ''。
 */
export function restoreLastRoute() {
  const saved = readLastRoute()
  if (!saved) return ''
  const { pathname, search } = window.location
  if (pathname + search === saved) return '' // 已经在记忆页上（正常刷新 / 宿主半已按记忆建 iframe）
  if (!isEntry(pathname, search)) return ''
  window.history.replaceState(null, '', saved)
  return saved
}
