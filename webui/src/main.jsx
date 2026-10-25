import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { prefsApi } from './api'
import { useAuthStore } from './stores/auth'
import { initSkin } from './utils/skin'
import { initFontScale } from './utils/fontScale'
import { initBrightness } from './utils/brightness'
import { initI18n, registerLangPersistor, applyServerLang } from './utils/i18n'
import { initDshHost } from './lib/dshHost'
import { restoreLastRoute } from './lib/lastRoute'
import './styles/index.css' // Tailwind v4 + shadcn tokens, 置于最前: layer 机制下自定义样式始终可覆盖
import './styles/theme.css'
import './styles/components.css'

initSkin() // 渲染前应用皮肤(data-skin), 避免闪烁
initFontScale() // 渲染前应用字体大小(--fs 乘数), 避免字号闪烁
initBrightness() // 渲染前应用文字亮度档(data-bright), 避免首屏文字亮度跳变
initI18n() // 渲染前应用语言(html lang), 避免首屏语言闪烁
// 手动切换语言时写回账号偏好（project_id=0 用户级，值形状 {v:'zh'|'en'}，POST /api/prefs
// 只收对象值）：未登录不写，避免登录页触发 401 跳转；写回失败静默，本地选择不受影响
registerLangPersistor((lang) => {
  if (!useAuthStore.getState().username) return
  prefsApi.set(0, 'lang', { v: lang }).catch(() => {})
})
initDshHost() // 启动 dsh 宿主桥(探针): 面板形态拿到能力位后卡片才出现「在 dsh 打开」按钮

// 与旧实现一致: 路由守卫依赖 auth.load() 结果, 渲染前先完成
useAuthStore.getState().load().finally(() => {
  // 账号语言偏好：每个页面加载（含 /settings/language、/admin、/log 等不经 AppShell 的
  // 独立路由/整页深链）都在登录后临时采用一次——此前只有 AppShell 拉 prefs，直链会按
  // 本地/默认语言渲染。best-effort 单次 fire-and-forget，失败静默；本地选择优先的语义由
  // applyServerLang 自身保证。渲染后进行时 notify 会触发订阅者重渲染，不阻塞首屏。
  if (useAuthStore.getState().username) {
    prefsApi.get(0).then((r) => applyServerLang(r.prefs?.lang)).catch(() => {})
  }
  restoreLastRoute() // 路由记忆: 停在入口页时回到上次所在页面(深链/书签优先, 不覆盖)
  createRoot(document.getElementById('app')).render(
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'}>
      <App />
    </BrowserRouter>,
  )
})

