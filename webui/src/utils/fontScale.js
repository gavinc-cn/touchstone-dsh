// 界面字体大小（全站文字缩放）: 按 <html> 上的 CSS 变量 --fs 乘数缩放全部文字
//   四档预设（小/标准/大/特大），点选即生效并持久化到 localStorage，刷新后保持；
//   入口在设置页「外观主题」分区。只缩字号不动间距/图标（布局尺寸仍是固定 px/rem），
//   因此不影响看板拖拽、弹窗拖动改尺寸等自绘坐标计算。
// 实现约定（与 styles 侧联动，勿单改一侧）：
//   - index.css :root 定义 --fs 默认 1；
//   - Tailwind 字号 token（@theme inline 的 --text-*）与 theme/components.css 里
//     全部 font-size 声明均写成 calc(N * var(--fs))，行高/间距随文字自然回流。
const KEY = 'ts_fs'

// 档位定义：value 为 --fs 乘数（1 = 出厂字号）
export const FONT_SCALES = [
  { value: 0.9, label: '小' },
  { value: 1, label: '标准' },
  { value: 1.15, label: '大' },
  { value: 1.3, label: '特大' },
]

// 读取当前档位（非法/未设置回落标准 1）
export function getFontScale() {
  const v = parseFloat(localStorage.getItem(KEY))
  return FONT_SCALES.some((s) => s.value === v) ? v : 1
}

// 应用档位：写 <html> 内联 --fs（优先于 :root 默认值）并落 localStorage
export function applyFontScale(value) {
  document.documentElement.style.setProperty('--fs', String(value))
  try { localStorage.setItem(KEY, String(value)) } catch { /* 隐私模式: 忽略 */ }
}

// 渲染前调用（main.jsx），避免首屏字号闪烁
export function initFontScale() {
  applyFontScale(getFontScale())
}
