// dsh 插件外壳语言行为（KB-14 / KB-15）：
//   外壳只读「有效语言镜像」ts_lang_eff（webui 侧写）优先 → 本地手动选择 ts_lang → 缺省 en；
//   外壳文案在渲染时求值，并在宿主页收到 storage 事件（另一标签页/iframe 内 SPA 切换语言）
//   时通知订阅者重渲染，面板打开期间切语言也能更新。
//
// 加载方式：src/client.js 是纯函数体（无 import/JSX，由 scripts/build.mjs 包装为模块
// factory），这里用 new Function 注入 fake React/window/document/localStorage 后求值，
// 并追加 return 暴露内部函数（只为测试；不改产物形态）。断言的是真实源码，不是另一份实现。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_PATH = path.resolve(HERE, '../src/client.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf8')

// 追加到源码末尾的取值出口：只引用实现里真实存在的标识符（缺一个就会 ReferenceError，
// 也算一种「源码结构没跑偏」的断言）。
const RETURN_EXPORTS = `
;return {
  LANG_KEY, LANG_EFF_KEY, DEFAULT_LANG, readLang, L,
  commandLabel, entryTitle, useLang, Toggle,
};
`

// ── 最小桩：localStorage / window / React hooks ─────────────────────────────
/** 造假 localStorage；throwRead=true 模拟隐私模式（所有读都抛错）。 */
function makeStorage(initial = {}, { throwRead = false } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(key) {
      if (throwRead) throw new Error('storage denied')
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
  }
}

/** 造假 window：只实现事件监听面（client.js 模块加载时挂一条 storage 监听）。 */
function makeWindow() {
  const listeners = []
  return {
    listeners,
    addEventListener(type, fn) { listeners.push({ type, fn }) },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    dispatch(type, event) {
      for (const l of [...listeners]) if (l.type === type) l.fn(event)
    },
    storageListeners() { return listeners.filter((l) => l.type === 'storage') },
  }
}

/** 最小 React：createElement + useState/useEffect/useRef（同一组件内 hook 顺序稳定）。 */
function makeMiniReact() {
  let index = 0
  const values = []
  const effects = []
  let pending = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}) }, children }
    },
    useState(initial) {
      const i = index++
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v }]
    },
    useRef(initial) {
      const i = index++
      if (!(i in values)) values[i] = { current: initial }
      return values[i]
    },
    useEffect(fn, deps) {
      const i = index++
      pending.push({ i, fn, deps })
    },
  }
  /** 渲染一个函数组件（测试里需要手动重渲染模拟 React 的订阅触达）。 */
  function render(Component, props) {
    index = 0
    pending = []
    const tree = Component(props || {})
    for (const slot of pending) {
      const prev = effects[slot.i]
      const changed = !prev || !slot.deps || slot.deps.length !== prev.deps.length
        || slot.deps.some((d, k) => d !== prev.deps[k])
      if (!changed) continue
      if (prev && prev.cleanup) prev.cleanup()
      const cleanup = slot.fn()
      effects[slot.i] = { deps: slot.deps || [], cleanup: typeof cleanup === 'function' ? cleanup : null }
    }
    return tree
  }
  return { React, render }
}

/** 在干净环境里求值真实源码；lang/eff 对应预置的 ts_lang / ts_lang_eff。 */
function load({ lang, eff, throwRead = false, open = false } = {}) {
  const initial = {}
  if (open) initial['ts.plugin.open'] = '1'
  if (lang !== undefined) initial.ts_lang = lang
  if (eff !== undefined) initial.ts_lang_eff = eff
  const storage = makeStorage(initial, { throwRead })
  const win = makeWindow()
  const mini = makeMiniReact()
  const factory = new Function(
    'React', 'window', 'document', 'localStorage', 'navigator',
    SRC + RETURN_EXPORTS,
  )
  const api = factory(mini.React, win, {}, storage, { userAgent: 'node-test' })
  return { api, mini, win, storage }
}

describe('dsh 插件外壳：有效语言镜像与响应式文案', () => {
  it('readLang：ts_lang_eff 优先 → ts_lang → 缺省 en；非法值逐级忽略', () => {
    assert.equal(load({ eff: 'zh', lang: 'en' }).api.readLang(), 'zh')
    assert.equal(load({ eff: 'en', lang: 'zh' }).api.readLang(), 'en')
    assert.equal(load({ eff: 'zh' }).api.readLang(), 'zh')
    assert.equal(load({ eff: 'fr', lang: 'zh' }).api.readLang(), 'zh')
    assert.equal(load({ eff: 'ZH', lang: 'en' }).api.readLang(), 'en')
    assert.equal(load({ lang: 'zh' }).api.readLang(), 'zh')
    assert.equal(load({ lang: 'fr' }).api.readLang(), 'en')
    assert.equal(load({}).api.readLang(), 'en')
  })

  it('readLang：localStorage 读取抛错时回落缺省 en', () => {
    assert.equal(load({ lang: 'zh', throwRead: true }).api.readLang(), 'en')
  })

  it('键名与 webui 逐字一致（ts_lang / ts_lang_eff）', () => {
    const { api } = load()
    assert.equal(api.LANG_KEY, 'ts_lang')
    assert.equal(api.LANG_EFF_KEY, 'ts_lang_eff')
    assert.equal(api.DEFAULT_LANG, 'en')
  })

  it('commandLabel()/entryTitle() 在调用时按当前语言求值', () => {
    assert.equal(load({}).api.commandLabel(), 'Open/Close Touchstone Panel')
    assert.equal(load({ lang: 'zh' }).api.commandLabel(), '打开/关闭 Touchstone 面板')
    assert.equal(load({ eff: 'zh' }).api.commandLabel(), '打开/关闭 Touchstone 面板')
    assert.equal(load({}).api.entryTitle(), 'Touchstone Test Platform (Alt+T to toggle)')
    assert.equal(load({ lang: 'zh' }).api.entryTitle(), 'Touchstone 测试平台（Alt+T 开关）')
    // 镜像优先于本地旧值
    assert.equal(load({ eff: 'zh', lang: 'en' }).api.entryTitle(), 'Touchstone 测试平台（Alt+T 开关）')
  })

  it('模块只挂一条 storage 监听；ts_lang / ts_lang_eff / key=null 通知订阅者', () => {
    const env = load({ lang: 'en' })
    assert.equal(env.win.storageListeners().length, 1)

    const Probe = () => env.api.useLang()
    assert.equal(env.mini.render(Probe), 'en')

    env.storage.setItem('ts_lang_eff', 'zh')
    env.win.dispatch('storage', { key: 'ts_lang_eff' })
    assert.equal(env.mini.render(Probe), 'zh')

    env.storage.removeItem('ts_lang_eff')
    env.storage.setItem('ts_lang', 'en')
    env.win.dispatch('storage', { key: 'ts_lang' })
    assert.equal(env.mini.render(Probe), 'en')

    env.storage.setItem('ts_lang_eff', 'zh')
    env.win.dispatch('storage', { key: null })
    assert.equal(env.mini.render(Probe), 'zh')
  })

  it('无关 storage 键不通知订阅者（订阅状态保持旧值）', () => {
    const env = load({ lang: 'en' })
    const Probe = () => env.api.useLang()
    assert.equal(env.mini.render(Probe), 'en')
    // 存储值变了、但事件不是语言键：订阅者不应被唤醒，重渲染仍读旧状态
    env.storage.setItem('ts_lang', 'zh')
    env.win.dispatch('storage', { key: 'ts.plugin.open' })
    assert.equal(env.mini.render(Probe), 'en')
  })

  it('Toggle 的 title/aria 与展开态文案随语言镜像更新（无需宿主刷新）', () => {
    const env = load({ lang: 'en', open: true })
    const en = env.mini.render(env.api.Toggle, { wide: true })
    assert.equal(en.props.title, 'Touchstone Test Platform (Alt+T to toggle)')
    assert.equal(en.props['aria-label'], en.props.title)
    assert.equal(en.children[1].children[0], 'Close Touchstone')

    env.storage.setItem('ts_lang_eff', 'zh')
    env.win.dispatch('storage', { key: 'ts_lang_eff' })
    const zh = env.mini.render(env.api.Toggle, { wide: true })
    assert.equal(zh.props.title, 'Touchstone 测试平台（Alt+T 开关）')
    assert.equal(zh.props['aria-label'], zh.props.title)
    assert.equal(zh.children[1].children[0], '关闭 Touchstone')
  })
})
