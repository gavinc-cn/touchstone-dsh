// 界面文字亮度（全站文字梯度档位）: 按 <html> 的 data-bright 属性切换文字色梯
//   三档预设（原样/偏暗/更暗），点选即生效并持久化到 localStorage，刷新后保持；
//   入口在设置页「外观主题」分区。
//
// 为什么需要：深色画布上正文取 dsh 设计 token 的 label-primary(#f9fafb)，对 #151517
// 的对比度 17.45:1，远超 WCAG AAA 的 7:1，长时间阅读刺眼。dsh 宿主自己是靠一个
// dim-text 客户端插件把 label-primary/secondary/tertiary 各降一档（#f9fafb→#cfd3d6 …）
// 解决的——TS 面板要跟宿主对齐，且这个"压多少"应当由用户自己定，故做成档位。
//
// 与 styles 侧的契约（勿单改一侧）：
//   - theme.css 每套皮肤定义 --text-hi/--text-mid/--text-lo 三值（--text 缺省取 mid），
//     并按 [data-bright='normal'|'dimmer'] 覆盖 —— 「偏暗」档就是各皮肤块自身的取值；
//   - 只作用于**文字色梯**（正文 --text、次级 --muted-foreground、等宽块 --inset-text、
//     强调文字 --star-text）；不动状态色/背景/描边/品牌填充（--star 仍是品牌墨）；
//   - 只对深色皮肤有意义：dsh-light 三档同值，等价于不生效（与 dsh 宿主 dim-text 同口径：
//     浅色模式不动）。
const KEY = 'ts_bright'

// 档位定义：id 同时是 <html data-bright> 的取值（hint 要短，设置页三张卡并排显示）
export const BRIGHTNESSES = [
  { id: 'normal', label: '原样', hint: '出厂取值' },
  { id: 'dim', label: '偏暗', hint: '压一档（默认）' },
  { id: 'dimmer', label: '更暗', hint: '再压一档' },
]

// 缺省档：偏暗（用户诉求的默认观感；未存过偏好的浏览器按此显示）
export const DEFAULT_BRIGHTNESS = 'dim'

// 读取当前档位（非法/未设置回落偏暗）
export function getBrightness() {
  const v = localStorage.getItem(KEY)
  return BRIGHTNESSES.some((b) => b.id === v) ? v : DEFAULT_BRIGHTNESS
}

// 应用档位：写 <html data-bright>（CSS 按属性覆盖变量）并落 localStorage
export function applyBrightness(id) {
  const level = BRIGHTNESSES.some((b) => b.id === id) ? id : DEFAULT_BRIGHTNESS
  document.documentElement.dataset.bright = level
  try { localStorage.setItem(KEY, level) } catch { /* 隐私模式: 忽略 */ }
}

// 渲染前调用（main.jsx），避免首屏文字亮度闪烁
export function initBrightness() {
  applyBrightness(getBrightness())
}

// 档位 id → 展示名（设置页档位卡用；未知值原样返回）
export function brightnessLabel(id) {
  return BRIGHTNESSES.find((b) => b.id === id)?.label || id
}
