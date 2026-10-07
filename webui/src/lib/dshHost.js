// dsh 宿主桥（浏览器侧）：Touchstone 在 dsh 插件形态下以**同源 iframe** 嵌在 dsh 的
// 全屏面板里（见 dsh-plugin/src/client.js 的 Panel），父窗口 = dsh 主界面，持有 dsh
// 客户端服务（uiWorkspace.openSession）。跨窗口不直连宿主全局（宿主半可能还没加载、
// 也不该暴露内部服务），统一走 postMessage 三条消息：
//   SPA → 宿主  { type: 'touchstone:host-probe' }                      探测宿主能力
//   宿主 → SPA  { type: 'touchstone:host-caps', caps: { openSession } } 应答（能力位）
//   SPA → 宿主  { type: 'touchstone:open-session', sid }                请求在 dsh 主界面打开会话
// 独立形态（touchstone.sh / 直接开浏览器标签页）没有宿主应答 ⇒ caps 恒为 null ⇒
// 相关按钮不渲染（不是「点了没反应」，见 BoardTab 的 dshCaps 判定）。
// 协议常量与宿主半（dsh-plugin/src/client.js）逐字一致，两侧改动必须同步。
const MSG_PROBE = 'touchstone:host-probe'
const MSG_CAPS = 'touchstone:host-caps'
const MSG_OPEN = 'touchstone:open-session'

// 宿主能力（null=未探测到宿主；{} 或 {openSession:false}=宿主在但该能力不可用）
let caps = null
// 桥是否已启动（幂等：main.jsx 启动一次；测试里反复 import 也不会重复挂监听）
let started = false
// 能力订阅者（React 侧经 hooks/useDshHost.js 的 useSyncExternalStore 接入）
const listeners = new Set()

/** 当前宿主能力快照（null=独立形态/宿主未应答）。 */
export function getDshHostCaps() {
  return caps
}

/** 订阅宿主能力变化；返回退订函数（useSyncExternalStore 的 subscribe 面）。 */
export function subscribeDshHost(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function setCaps(next) {
  caps = next
  // 订阅者异常只吞自己：一个组件报错不该拖垮其它组件的重渲染
  for (const fn of [...listeners]) {
    try { fn(caps) } catch { /* 忽略 */ }
  }
}

/** 是否嵌在同源父窗口里（独立形态下 window.parent === window）。 */
function framed() {
  return typeof window !== 'undefined' && !!window.parent && window.parent !== window
}

/**
 * 在当前卡片主会话上请求宿主「弹出到 dsh 主界面」。
 * @param sid - 会话 id（卡片主会话）。
 * @returns true=请求已发出（宿主将打开会话并关掉面板）；false=无宿主/无会话，调用方忽略即可。
 */
export function openSessionInDsh(sid) {
  if (!caps || !caps.openSession || !sid || !framed()) return false
  try {
    // targetOrigin 用自身 origin：面板 iframe 与 dsh 宿主同源（/touchstone 前缀反代同一站点）
    window.parent.postMessage({ type: MSG_OPEN, sid: String(sid) }, window.location.origin)
    return true
  } catch {
    return false // 跨域等异常：按「没发出去」处理，不抛给点击处理函数
  }
}

/** 启动宿主桥（幂等）：挂应答监听 + 向父窗口发一次探针。 */
export function initDshHost() {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('message', (e) => {
    // 只认同源 + 约定消息类型的应答；父窗口里还有别的插件消息，一律忽略
    if (e.origin !== window.location.origin) return
    const data = e.data || {}
    if (data.type !== MSG_CAPS) return
    setCaps(data.caps || {})
  })
  // 独立形态：没有宿主可探，caps 保持 null（不请求、不等待）
  if (!framed()) return
  try {
    window.parent.postMessage({ type: MSG_PROBE }, window.location.origin)
  } catch { /* 跨域父窗口等：按无宿主处理 */ }
}
