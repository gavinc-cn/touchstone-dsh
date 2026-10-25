// utils/i18n.js 单测：语言读写 + 词条查询
//   产品口径：默认英文（DEFAULT_LANG='en'）；zh 直接返回中文原文（无词典）；
//   en 查 i18n/en.json 的 web 命名空间，缺失回落中文键；插值 {name} 漏传变量时
//   保留占位符不抛错；localStorage 不可用（隐私模式）时读写均不得抛错。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  t, getLang, setLang, initI18n, missingKeys, DEFAULT_LANG, applyServerLang,
  registerLangPersistor, clearServerLang,
} from '../utils/i18n'
import { api } from '../api'

// 期望：zh 原样返回并插值；en 查表；缺失回落中文；漏传变量不抛错；localStorage 不可用不抛错
describe('i18n', () => {
  beforeEach(() => {
    // 重置模块级「服务端临时采用」状态：setLang 视为手动选择，会清掉采用态；
    // 再清 localStorage，回到「本浏览器从未选择过」的初态
    setLang(DEFAULT_LANG)
    localStorage.clear()
    document.documentElement.lang = ''
  })

  it('zh 返回中文原文并插值', () => {
    setLang('zh')
    expect(t('保存')).toBe('保存')
    expect(t('共 {n} 张卡片', { n: 3 })).toBe('共 3 张卡片')
  })

  it('en 查表，缺失回落中文', () => {
    setLang('en')
    expect(t('×')).toBe('×')            // 缺失条目原样回落中文键
    expect(t('保存')).toBe('Save')
    expect(t('这条词条不存在')).toBe('这条词条不存在')
  })

  it('插值变量缺失不抛错（保留占位）', () => {
    setLang('en')
    expect(t('共 {n} 张卡片', {})).toContain('{n}')
  })

  it('localStorage 不可用时不抛错并回落默认语言', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('denied') }
    try { expect(() => setLang('zh')).not.toThrow() } finally { Storage.prototype.setItem = orig }
    expect(getLang()).toBe(DEFAULT_LANG)
  })

  it('initI18n 写 html lang', () => {
    setLang('zh'); initI18n(); expect(document.documentElement.lang).toBe('zh-CN')
    setLang('en'); initI18n(); expect(document.documentElement.lang).toBe('en')
  })

  it('未设或非法的 ts_lang 回落到默认英文', () => {
    expect(getLang()).toBe(DEFAULT_LANG)
    localStorage.setItem('ts_lang', 'fr')
    expect(getLang()).toBe(DEFAULT_LANG)
    localStorage.setItem('ts_lang', 'zh')
    expect(getLang()).toBe('zh')
  })

  it('setLang 立即写 <html lang> 并落 localStorage', () => {
    setLang('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem('ts_lang')).toBe('zh')
    setLang('en')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('ts_lang')).toBe('en')
  })

  it('en 复数对象按 n 选 one/other', () => {
    setLang('en')
    expect(t('共 {n} 张卡片', { n: 1 })).toBe('1 card')
    expect(t('共 {n} 张卡片', { n: 3 })).toBe('3 cards')
  })

  it('T6 fix round 1：新复数词条 n=1 用单数；标点/空格词条按英文习惯输出', () => {
    setLang('en')
    expect(t(' 个', { n: 1 })).toBe(' commit')
    expect(t(' 个', { n: 3 })).toBe(' commits')
    expect(t('清空回收站共 {n} 张卡片？全部彻底删除，不可恢复。', { n: 1 })).toContain('(1 card)')
    expect(t('清空回收站共 {n} 张卡片？全部彻底删除，不可恢复。', { n: 3 })).toContain('(3 cards)')
    expect(t('工作树有 {n} 处未提交改动，交给 agent 时会先提交它们。', { n: 1 }))
      .toContain('1 uncommitted change;')
    expect(t('（主分支领先 {n} 个提交，需先同步）', { n: 1 })).toContain('1 commit ahead')
    expect(t('（主分支领先 {n} 个提交，需先同步）', { n: 3 })).toContain('3 commits ahead')
    expect(t('（本项目排队 {n} 个）', { n: 1 })).toContain('1 unit queued')
    expect(t('（{n} 字符）', { n: 1 })).toBe(' (1 char)')
    expect(t('（{n} 字符）', { n: 3 })).toBe(' (3 chars)')
    // 标点键：en 用半角括号/冒号，不再露出全角「（）：」
    expect(t('（{header}）：', { header: 'Scope' })).toBe(' (Scope): ')
    expect(t('：')).toBe(': ')
    // Cache 措辞统一为小写 “cache”（与同行的 messages / 37s 风格一致）
    expect(t('缓存 ')).toBe('cache ')
    expect(t('缓存 {n}', { n: '1.2k' })).toBe('cache 1.2k')
  })

  it('缺失 en 词条记入 missingKeys 且不重复', () => {
    setLang('en')
    const before = missingKeys()
    t('缺失词条甲'); t('缺失词条甲'); t('缺失词条乙')
    const after = missingKeys()
    expect(after.length).toBe(before.length + 2)
    expect(after).toContain('缺失词条甲')
    expect(after.filter((k) => k === '缺失词条甲')).toHaveLength(1)
  })

  it('applyServerLang 只在本地未设过时采用服务端偏好', () => {
    localStorage.clear(); applyServerLang('zh'); expect(getLang()).toBe('zh')
    localStorage.clear(); setLang('en'); applyServerLang('zh'); expect(getLang()).toBe('en')
  })

  it('applyServerLang 忽略非法值，存储不可用不抛错', () => {
    localStorage.clear()
    applyServerLang('fr'); applyServerLang(undefined); applyServerLang(null)
    expect(getLang()).toBe(DEFAULT_LANG)
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('denied') }
    try { expect(() => applyServerLang('zh')).not.toThrow() } finally { Storage.prototype.getItem = orig }
    expect(localStorage.getItem('ts_lang')).toBe(null)
  })

  it('applyServerLang 接受 {v} 对象形状（POST /api/prefs 只收对象值）', () => {
    localStorage.clear()
    applyServerLang({ v: 'zh' })
    expect(getLang()).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    applyServerLang({ v: 'en' })
    expect(getLang()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('applyServerLang 静默忽略畸形偏好值', () => {
    localStorage.clear()
    for (const bad of [{ v: 'fr' }, { v: 1 }, { v: null }, {}, [], 'fr', 42, true]) {
      applyServerLang(bad)
      expect(getLang()).toBe(DEFAULT_LANG)
    }
    expect(localStorage.getItem('ts_lang')).toBe(null)
  })

  it('applyServerLang 只临时采用：不写 ts_lang（仅同步镜像 ts_lang_eff），手动选择才落本地并覆盖', () => {
    localStorage.clear()
    applyServerLang('zh')
    expect(localStorage.getItem('ts_lang')).toBe(null)
    expect(getLang()).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')

    localStorage.clear()
    applyServerLang({ v: 'zh' })
    expect(localStorage.getItem('ts_lang')).toBe(null)
    expect(getLang()).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')

    // 手动选择落本地；此后账号偏好不再覆盖本浏览器
    setLang('en')
    expect(localStorage.getItem('ts_lang')).toBe('en')
    applyServerLang({ v: 'zh' })
    expect(getLang()).toBe('en')
  })
})

// 账号偏好写回：i18n 不直接依赖 api，由 main.jsx 经 registerLangPersistor 注入；
// 写回是 best-effort（同步抛错/异步 reject 都不得影响本地切换）。
describe('语言偏好写回账号（registerLangPersistor）', () => {
  beforeEach(() => {
    registerLangPersistor(null)
    localStorage.clear()
    document.documentElement.lang = ''
  })
  afterEach(() => { registerLangPersistor(null) })

  it('setLang 在落本地后回调写回器（传归一化后的语言）', () => {
    const calls = []
    registerLangPersistor((lang) => { calls.push([lang, localStorage.getItem('ts_lang')]) })
    setLang('zh')
    setLang('fr') // 非法值归一化为默认英文
    expect(calls).toEqual([['zh', 'zh'], [DEFAULT_LANG, DEFAULT_LANG]])
  })

  it('写回器同步抛错或异步 reject 都不影响本地切换', async () => {
    registerLangPersistor(() => { throw new Error('boom') })
    expect(() => setLang('zh')).not.toThrow()
    expect(localStorage.getItem('ts_lang')).toBe('zh')

    registerLangPersistor(() => Promise.reject(new Error('async boom')))
    expect(() => setLang('en')).not.toThrow()
    expect(localStorage.getItem('ts_lang')).toBe('en')
    // 让写回器的 reject 处理链跑完，确认没有未处理的 Promise 拒绝
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('只保留最后注册的写回器，且采用服务端偏好不回写', () => {
    const first = vi.fn()
    const second = vi.fn()
    registerLangPersistor(first)
    registerLangPersistor(second)
    applyServerLang('zh')
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    setLang('zh')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('zh')
  })
})

// API 请求头：语言偏好随每次 REST 请求上报（EventSource 带不了自定义头，SSE 另走 ?lang=）
describe('api 请求头 X-TS-Lang', () => {
  beforeEach(() => { localStorage.clear() })

  it('request 注入当前语言的 X-TS-Lang 头', async () => {
    setLang('zh')
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    vi.stubGlobal('fetch', fetchMock)
    try { await api.get('/api/ping') } finally { vi.unstubAllGlobals() }
    expect(fetchMock.mock.calls[0][1].headers['X-TS-Lang']).toBe('zh')
  })

  it('默认语言（en）同样带头', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    vi.stubGlobal('fetch', fetchMock)
    try { await api.post('/api/ping', { a: 1 }) } finally { vi.unstubAllGlobals() }
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'Content-Type': 'application/json', 'X-TS-Lang': 'en',
    })
  })
})

// 有效语言镜像 ts_lang_eff：只给插件外壳读的「当前有效语言」，**不是**本 SPA 的第二真源
//   （真源仍是 ts_lang → 本次页面加载瞬态采纳的账号偏好 → en）。镜像只做 best-effort：
//   localStorage 写失败静默，读镜像/非法镜像值一律忽略。
describe('有效语言镜像 ts_lang_eff 与 clearServerLang', () => {
  beforeEach(() => {
    setLang(DEFAULT_LANG)
    localStorage.clear()
    document.documentElement.lang = ''
  })

  it('setLang 落 ts_lang 成功后同步镜像', () => {
    setLang('zh')
    expect(localStorage.getItem('ts_lang')).toBe('zh')
    expect(localStorage.getItem('ts_lang_eff')).toBe('zh')
    setLang('en')
    expect(localStorage.getItem('ts_lang')).toBe('en')
    expect(localStorage.getItem('ts_lang_eff')).toBe('en')
  })

  it('applyServerLang 采用账号偏好后写镜像，但不写 ts_lang', () => {
    localStorage.clear()
    applyServerLang({ v: 'zh' })
    expect(localStorage.getItem('ts_lang')).toBe(null)
    expect(localStorage.getItem('ts_lang_eff')).toBe('zh')
    expect(getLang()).toBe('zh')
  })

  it('applyServerLang 未采用（本地已有选择）时不动镜像', () => {
    localStorage.clear()
    setLang('en')
    applyServerLang('zh')
    expect(getLang()).toBe('en')
    expect(localStorage.getItem('ts_lang_eff')).toBe('en')
  })

  it('initI18n 首屏把镜像置为当前有效语言', () => {
    localStorage.clear()
    initI18n()
    expect(localStorage.getItem('ts_lang_eff')).toBe(DEFAULT_LANG)
    setLang('zh')
    localStorage.removeItem('ts_lang_eff')
    initI18n() // 幂等重入也必须重刷镜像（首屏兜底）
    expect(localStorage.getItem('ts_lang_eff')).toBe('zh')
  })

  it('clearServerLang：有 ts_lang 时清内存偏好但保留本地语言，镜像跟随', () => {
    localStorage.clear()
    applyServerLang('zh') // 本次页面加载临时采用账号偏好（无本地选择）
    localStorage.setItem('ts_lang', 'zh') // 另一标签页落本地选择，本页内存偏好仍在
    clearServerLang()
    expect(getLang()).toBe('zh')
    expect(localStorage.getItem('ts_lang')).toBe('zh')
    expect(localStorage.getItem('ts_lang_eff')).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('clearServerLang：无 ts_lang 时回默认英文并镜像 en', () => {
    localStorage.clear()
    applyServerLang('zh')
    expect(getLang()).toBe('zh')
    clearServerLang()
    expect(getLang()).toBe(DEFAULT_LANG)
    expect(localStorage.getItem('ts_lang')).toBe(null)
    expect(localStorage.getItem('ts_lang_eff')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('镜像键不是第二真源：单独存在或非法值都不影响 getLang', () => {
    localStorage.clear()
    localStorage.setItem('ts_lang_eff', 'zh') // 只有镜像 ⇒ 不认
    expect(getLang()).toBe(DEFAULT_LANG)
    localStorage.setItem('ts_lang', 'en')
    localStorage.setItem('ts_lang_eff', 'fr') // 非法镜像值 ⇒ 忽略
    expect(getLang()).toBe('en')
    localStorage.removeItem('ts_lang')
    expect(getLang()).toBe(DEFAULT_LANG)
    applyServerLang('zh') // 账号偏好仍按原链（与镜像无关）
    expect(getLang()).toBe('zh')
  })

  it('镜像写失败（localStorage 拒绝写镜像键）静默，不影响 setLang/clearServerLang', () => {
    localStorage.clear()
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === 'ts_lang_eff') throw new Error('denied')
      return orig.call(this, key, value)
    }
    try {
      expect(() => setLang('zh')).not.toThrow()
      expect(localStorage.getItem('ts_lang')).toBe('zh')
      expect(() => clearServerLang()).not.toThrow()
    } finally {
      Storage.prototype.setItem = orig
    }
    expect(getLang()).toBe('zh')
  })
})
