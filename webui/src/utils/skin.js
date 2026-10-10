// 皮肤切换: 主题按 <html data-skin="..."> 作用域切换 CSS 变量
//   dsh-dark   —— DSH 深色(对齐 dsh 深色外观, 默认)
//   dsh-light  —— DSH 浅色(对齐 dsh 浅色外观)
//   starlight  —— 星夜金(bikeops 运营后台风)
//   classic    —— 经典蓝(原 GitHub 暗色板)
//
// 「选择」与「结果」分离(2026-10-09 起):
//   持久化的是**选择**——具体皮肤 id, 或 'auto'(跟随 DSH 宿主明暗);
//   落到 DOM 的 data-skin 恒为**具体皮肤**('auto' 先经 utils/dshTheme 解析)。
//   'auto' 只在插件形态(嵌在同源 iframe 面板里)最有意义: 宿主切明暗 → TS 面板跟着切;
//   独立形态下它等价于跟随系统偏好(见 dshTheme.resolveDark 的回落次序)。
//
// 未存过偏好时: 插件形态默认 'auto', 独立打开默认 'dsh-dark'。
// 选择持久化到 localStorage, 刷新后保持; 入口在设置页「外观主题」分区。
import { resolveDark, subscribeHostTheme } from './dshTheme'

const KEY = 'ts_skin'

/** 「跟随 DSH 宿主明暗」这个选择值(不是皮肤 id, 不参与 SKINS 循环)。 */
export const AUTO = 'auto'

/** 独立形态(不在宿主里)缺省皮肤。 */
const DEFAULT_SKIN = 'dsh-dark'

// 皮肤注册表: preview 是设置页选择卡上的两格色样(面板底/主色), 取值与 theme.css 对应皮肤变量一致
export const SKINS = [
  { id: 'dsh-dark', label: 'DSH 深色', preview: ['#1b1b1c', '#f9fafb'] },
  { id: 'dsh-light', label: 'DSH 浅色', preview: ['#f9fafb', '#0f1115'] },
  { id: 'starlight', label: '星夜金', preview: ['#141E36', '#E8B86D'] },
  { id: 'classic', label: '经典蓝', preview: ['#151b23', '#58a6ff'] },
]

/** 「跟随 DSH」选择卡的色样(浅色格 + 深色格, 表达「两套都会用到」)。 */
export const AUTO_PREVIEW = ['#f9fafb', '#151517']

/** 是否嵌在宿主窗口里(插件形态)。跨域读 window.top 会抛异常 ⇒ 按「在宿主里」处理。 */
function framed() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

/** 缺省选择: 插件形态跟随 DSH, 独立形态固定 DSH 深色。 */
function defaultChoice() {
  return framed() ? AUTO : DEFAULT_SKIN
}

/** 判断一个值是否为合法的「选择」(具体皮肤 id 或 auto)。 */
function isChoice(v) {
  return v === AUTO || SKINS.some((s) => s.id === v)
}

/**
 * 当前选择(未经解析): 持久化值合法则用它, 否则回落缺省。
 * @returns 皮肤 id 或 'auto'。
 */
export function currentChoice() {
  const v = localStorage.getItem(KEY)
  return isChoice(v) ? v : defaultChoice()
}

/**
 * 把「选择」解析成具体皮肤 id。
 * @param choice - 皮肤 id 或 'auto'。
 * @param dark - 宿主/系统的明暗判定, 缺省现场探测(仅 'auto' 用到)。
 * @returns SKINS 里的某个 id。
 */
export function resolveSkin(choice, dark = resolveDark()) {
  if (choice !== AUTO) return choice
  return dark ? 'dsh-dark' : 'dsh-light'
}

// 当前「跟随」订阅的退订函数(auto 档专用; null = 未订阅)
let unsubFollow = null

/** 把解析结果写到 <html data-skin>(不动 localStorage)。 */
function paint(choice) {
  document.documentElement.dataset.skin = resolveSkin(choice)
}

/** 按选择接管/释放「跟随宿主明暗」的订阅: auto 订阅一次, 其余退订。 */
function syncFollow(choice) {
  if (choice === AUTO) {
    if (unsubFollow) return // 已订阅: 幂等(initSkin 可被反复调用)
    unsubFollow = subscribeHostTheme(() => paint(AUTO))
    return
  }
  if (unsubFollow) {
    unsubFollow()
    unsubFollow = null
  }
}

/**
 * 应用一个选择: 写 <html data-skin>(解析后) + 落 localStorage(原始选择) + 同步跟随订阅。
 * @param id - 皮肤 id 或 'auto'; 非法值回落缺省选择。
 */
export function applySkin(id) {
  const choice = isChoice(id) ? id : defaultChoice()
  paint(choice)
  try { localStorage.setItem(KEY, choice) } catch { /* 隐私模式: 忽略 */ }
  syncFollow(choice)
}

/** 读取当前选择(非法/未设置回落缺省)。 */
export function getSkin() {
  return currentChoice()
}

// 渲染前调用(main.jsx), 避免主题闪烁; 选择为 auto 时同时挂上宿主明暗跟随
export function initSkin() {
  applySkin(getSkin())
}

/** 按注册表顺序取下一个皮肤 id(auto/非法值从首项开始)。 */
export function nextSkin(cur) {
  const i = SKINS.findIndex((s) => s.id === cur)
  return SKINS[(i + 1) % SKINS.length].id
}

/** 选择值 → 展示名(auto 有独立文案); 未知值原样返回 id。 */
export function skinLabel(id) {
  if (id === AUTO) return '跟随 DSH'
  return SKINS.find((s) => s.id === id)?.label || id
}
