// 前端 i18n 运行时（零新依赖）：中文原文为 key，en 查 i18n/en.json 的 web 命名空间
//   产品口径：默认英文（DEFAULT_LANG='en'）；zh 侧无词典，t() 直接返回中文 key 本身并插值。
//   词表是单一真源（仓库根 i18n/en.json）：前端构建期 import，Node/Python 运行时同读一份。
//   语言选择落 localStorage ts_lang，<html lang> 同步（zh→zh-CN / en→en）；useI18n 用
//   useSyncExternalStore 订阅，切换语言即时全站重渲染；渲染前 initI18n() 应用避免首屏闪烁。
//   另把「当前有效语言」best-effort 镜像到 ts_lang_eff 供 dsh 插件外壳读取（镜像只写不读，
//   不是本 SPA 的语言真源；真源仍是 ts_lang → 瞬态账号偏好 → en）。
//   边界：缺失/畸形 en 词条回落中文 key 并记入 missingKeys；插值变量缺失保留 {name} 原样；
//   localStorage 不可用（隐私模式）时读写都静默回落默认语言，不抛错。
import { useSyncExternalStore } from 'react'
import dict from '@i18n/en.json'

// 可选语言：顺序即设置页展示顺序（默认英文排在首位）
export const LANGS = [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }]
// 缺省语言：产品拍板默认英文（存量中文用户升级后需手动切回中文）
export const DEFAULT_LANG = 'en'
// localStorage 键：本浏览器显式选择的语言（即时真源）
export const LANG_KEY = 'ts_lang'
// localStorage 键：当前「有效语言」镜像（含瞬态账号偏好），只给 dsh 插件外壳读。
// **不是**本 SPA 的第二真源：getLang()/parseLangPref 都不读它；镜像缺失/非法一律忽略。
export const LANG_EFF_KEY = 'ts_lang_eff'

// 语言订阅者集合：setLang / 跨标签页 storage 事件触发，useSyncExternalStore 据此重渲染
const listeners = new Set()
// 账号语言偏好的「临时采用」态：只在内存里生效，不写 localStorage；账号偏好因此在每次
// 登录时都能重新采用，直到用户手动选择（setLang 落本地并清掉此态）
let serverLang = null
// 账号偏好写回器（main.jsx 注册）：模块级单槽位；i18n 不 import api，避免 api→i18n 循环依赖
let langPersistor = null
// initI18n 是否已挂过订阅（幂等：重复调用不重复挂载）
let initialized = false
// 本会话触发过的缺失 en 词条（key → 次数）：缺失时回落中文键，供守卫统计覆盖率
const missing = new Map()
// 英文复数规则实例（只处理 one/other 两档，不引入完整 ICU）
const EN_PLURALS = new Intl.PluralRules('en')
// 插值占位符：{name}，name 仅限标识符形状（其余大括号原样保留）
const PLACEHOLDER = /\{([A-Za-z_][\w]*)\}/g

// 合法化语言：只认 LANGS 里的 id，非法值回落默认英文
function normalizeLang(lang) {
  return LANGS.some((l) => l.id === lang) ? lang : DEFAULT_LANG
}

// 把语言写到 <html lang>（zh 用 zh-CN；en 与静态 index.html 的 en 一致）
function applyHtmlLang(lang) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
}

// 通知订阅者（useI18n 据此重渲染）
function notify() {
  listeners.forEach((fn) => fn())
}

// best-effort 写「有效语言镜像」：写失败静默（隐私模式/配额/存储被禁）。
// 镜像只服务插件外壳，绝不能影响本 SPA 的语言读写与切换。
function mirrorLang(lang) {
  try {
    window.localStorage.setItem(LANG_EFF_KEY, lang)
  } catch { /* 静默：镜像只是外壳提示 */ }
}

// 订阅语言变化（useSyncExternalStore 用）：返回退订函数
function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// 插值 {name}：vars 里没有该键（或值不可用）时保留占位符原样，绝不抛错
function interpolate(text, vars) {
  if (typeof text !== 'string') return ''
  return text.replace(PLACEHOLDER, (m, name) => {
    if (!vars || typeof vars !== 'object' ||
        !Object.prototype.hasOwnProperty.call(vars, name)) {
      return m
    }
    const v = vars[name]
    return v === undefined || v === null ? m : String(v)
  })
}

// 英文复数取值：n=1 取 one，其余（含缺失/NaN/非有限值）取 other；缺失一侧回退另一侧。
// 返回原始值（可能是非字符串畸形值），由 entryText 统一做「非空字符串」校验。
function pickPlural(entry, vars) {
  const n = vars && typeof vars === 'object' ? Number(vars.n) : NaN
  const form = EN_PLURALS.select(n) === 'one' ? 'one' : 'other'
  const text = form === 'one' ? (entry.one ?? entry.other) : (entry.other ?? entry.one)
  return text
}

// 词典条目 → 可插值文本：合法 string 原样；plural 对象按英文规则取 one/other 且结果必须
// 是非空 string；其余（number/null/array/缺 one+other/值非 string）返回 null（由 t 回落）。
function entryText(entry, vars) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const text = pickPlural(entry, vars)
    if (typeof text === 'string' && text !== '') return text
  }
  return null
}

// 读取当前语言：本地手动选择优先；从未选过时用账号偏好的临时采用态；都没有则默认英文
export function getLang() {
  try {
    const v = window.localStorage.getItem(LANG_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    return serverLang || DEFAULT_LANG
  }
  return serverLang || DEFAULT_LANG
}

// 切换语言（用户手动选择）：合法化 → 落 localStorage → 清掉账号偏好临时态 → 更新
// <html lang> → 同步有效语言镜像 → 通知订阅者 → best-effort 写回账号偏好。localStorage
// 不可用（隐私模式/存储被禁）时静默放弃本次切换，不抛错。
export function setLang(lang) {
  const next = normalizeLang(lang)
  try {
    window.localStorage.setItem(LANG_KEY, next)
  } catch {
    return
  }
  // 手动选择落本地后，本地值即唯一真源；账号偏好不再覆盖（下次登录也以本地为准）
  serverLang = null
  mirrorLang(next) // 外壳读的有效语言 = 当前生效语言
  applyHtmlLang(next)
  notify()
  // 写回账号偏好：best-effort，同步抛错/异步 reject 一律吞掉，绝不影响本地切换
  if (langPersistor) {
    try {
      const ret = langPersistor(next)
      if (ret && typeof ret.catch === 'function') ret.catch(() => {})
    } catch { /* 静默：写回失败不影响本地语言 */ }
  }
}

// 注册账号偏好写回器（main.jsx 在启动时调用一次）：模块级单槽位，传非函数即清空。
// i18n 自身不 import api（api 又 import getLang，避免循环依赖），写回时机由 setLang 决定。
export function registerLangPersistor(fn) {
  langPersistor = typeof fn === 'function' ? fn : null
}

// 解析账号语言偏好：兼容原始字符串 'zh'|'en'（旧形状）与 {v:'zh'|'en'}
// （POST /api/prefs 只收对象值，ruled 持久化形状即 {v:...}）；其余形状返回 null
function parseLangPref(pref) {
  if (pref === 'zh' || pref === 'en') return pref
  if (pref && typeof pref === 'object' && (pref.v === 'zh' || pref.v === 'en')) return pref.v
  return null
}

// 采用服务端保存的语言偏好（用户级 prefs.lang）：仅当本浏览器从未存过 ts_lang 时生效，
// 本地手动选择永远优先；pref 非法或读存储抛错（隐私模式）时静默忽略，不改变当前语言。
// 采用是「临时」的：只更新内存态、<html lang>、有效语言镜像与订阅者，不写 localStorage
// ——账号偏好因此能在每次登录时重新生效；用户手动点选才落本地并回写账号偏好。
export function applyServerLang(pref) {
  const lang = parseLangPref(pref)
  if (!lang) return
  try {
    if (window.localStorage.getItem(LANG_KEY) !== null) return
  } catch {
    return
  }
  serverLang = lang
  mirrorLang(lang) // 镜像的是「有效」语言：瞬态账号偏好也写进去，外壳才不会落后
  applyHtmlLang(lang)
  notify()
}

// 清掉本次页面加载临时采用的账号语言偏好（logout 时调用）：清内存态 → 重算镜像 →
// 重写 <html lang> → 通知订阅者。**不碰 ts_lang**：本浏览器的显式选择仍然保留，
// 这样同一页面换账号登录时不会继承上一账号的语言（除非本浏览器自己选过）。
export function clearServerLang() {
  serverLang = null
  const lang = getLang()
  mirrorLang(lang)
  applyHtmlLang(lang)
  notify()
}

// 渲染前调用（main.jsx）：写 <html lang> 与有效语言镜像，并挂上跨标签页同步订阅；
// 幂等（重复调用不重复挂监听；镜像每次都重刷，作为首屏兜底）。
export function initI18n() {
  const lang = getLang()
  applyHtmlLang(lang)
  mirrorLang(lang)
  if (initialized) return
  initialized = true
  // 另一个标签页改了 ts_lang（含 clear）时，本页同步 <html lang> 并重渲染
  window.addEventListener('storage', (e) => {
    if (e.key === LANG_KEY || e.key === LANG_EFF_KEY || e.key === null) {
      applyHtmlLang(getLang())
      notify()
    }
  })
}

// 词条查询：zh → 中文 key 插值；en → dict.web[key]（string 或 one/other 复数对象）；
// 缺失/畸形值回落中文 key 插值并计入 missingKeys（绝不渲染空串）。
export function t(key, vars) {
  const lang = getLang()
  if (lang === 'zh') return interpolate(key, vars)
  const web = dict.web || {}
  const entry = Object.prototype.hasOwnProperty.call(web, key) ? web[key] : undefined
  const text = entryText(entry, vars)
  if (text === null) {
    missing.set(key, (missing.get(key) || 0) + 1)
    return interpolate(key, vars)
  }
  return interpolate(text, vars)
}

// 卡片标题落库规范占位值：空标题保存时写库的字面量，必须与界面语言无关（en 界面保存也落中文
// 原文，保证同一张卡的标题不随 UI 语言漂移）。用 \u 转义书写等价于 '未命名'——扫描器不还原
// 转义，不会把这条**数据**误计成待翻译的界面文案（人工已核对，值即原文）。
export const UNTITLED_TITLE = '\u672a\u547d\u540d'

// 卡片标题的**显示**映射：落库规范占位「未命名」在英文界面显示 Untitled，其余标题原样返回。
// 只改显示层，不参与编辑草稿/入库值；zh 下 t('未命名') 逐字节返回中文原文（zh 零 churn）。
export function displayTitle(title) {
  return title && title !== UNTITLED_TITLE ? title : t('未命名')
}

// 当前语言 + 翻译函数（组件用）：语言切换时经 useSyncExternalStore 即时重渲染
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLang)
  return { t, lang }
}

// 本会话触发过的缺失 en 词条（去重）
export function missingKeys() {
  return Array.from(missing.keys())
}
