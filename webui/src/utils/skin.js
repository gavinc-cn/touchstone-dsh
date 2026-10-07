// 皮肤切换: 两套主题按 <html data-skin="..."> 作用域切换 CSS 变量
//   starlight —— 星夜金(bikeops 运营后台风), 默认
//   classic   —— 经典蓝(原 GitHub 暗色板)
// 选择持久化到 localStorage, 刷新后保持; 入口在设置页「外观主题」分区
const KEY = 'ts_skin'

// preview: 设置页选择卡上的两格色样(面板底/主色), 取值与 theme.css 对应皮肤变量一致
export const SKINS = [
  { id: 'starlight', label: '星夜金', preview: ['#141E36', '#E8B86D'] },
  { id: 'classic', label: '经典蓝', preview: ['#151b23', '#58a6ff'] },
]

export function getSkin() {
  const v = localStorage.getItem(KEY)
  return SKINS.some((s) => s.id === v) ? v : 'starlight'
}

export function applySkin(id) {
  document.documentElement.dataset.skin = id
  localStorage.setItem(KEY, id)
}

// 渲染前调用, 避免主题闪烁
export function initSkin() {
  applySkin(getSkin())
}

export function nextSkin(cur) {
  const i = SKINS.findIndex((s) => s.id === cur)
  return SKINS[(i + 1) % SKINS.length].id
}

export function skinLabel(id) {
  return SKINS.find((s) => s.id === id)?.label || id
}

