import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { useAuthStore } from './stores/auth'
import { initSkin } from './utils/skin'
import { initFontScale } from './utils/fontScale'
import { initBrightness } from './utils/brightness'
import { initDshHost } from './lib/dshHost'
import { restoreLastRoute } from './lib/lastRoute'
import './styles/index.css' // Tailwind v4 + shadcn tokens, 置于最前: layer 机制下自定义样式始终可覆盖
import './styles/theme.css'
import './styles/components.css'

initSkin() // 渲染前应用皮肤(data-skin), 避免闪烁
initFontScale() // 渲染前应用字体大小(--fs 乘数), 避免字号闪烁
initBrightness() // 渲染前应用文字亮度档(data-bright), 避免首屏文字亮度跳变
initDshHost() // 启动 dsh 宿主桥(探针): 面板形态拿到能力位后卡片才出现「在 dsh 打开」按钮

// 与旧实现一致: 路由守卫依赖 auth.load() 结果, 渲染前先完成
useAuthStore.getState().load().finally(() => {
  restoreLastRoute() // 路由记忆: 停在入口页时回到上次所在页面(深链/书签优先, 不覆盖)
  createRoot(document.getElementById('app')).render(
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'}>
      <App />
    </BrowserRouter>,
  )
})

