// utils/feishuProvision.js 单测：「飞书接入（扫码一键配置）」卡闸门拆细（M9，2026-10-15）。
// 关键不变量：`supported`（本机后端有没有「扫码建应用」能力）与 `enabled`（配置自动化总开关
// TS_FEISHU_PROVISION）是**两个正交闸门**——
//   supported=false 只该关掉「扫码创建飞书应用」这一个入口，
//   不许连坐「补齐应用配置」「提交发布」这两个后端早已实现的动作（曾经整卡不可操作）。
// 「刷新状态」是只读探测，只受 busy（组件本地状态）影响，不受任何能力闸门影响。
import { beforeEach, describe, expect, it } from 'vitest'

import { provisionGates, provisionNotices, provisionQrUrl } from '../utils/feishuProvision'

import { setLang } from '../utils/i18n'
// 文案断言按中文跑（zh 直接返回中文 key）
beforeEach(() => setLang('zh'))

describe('provisionGates：supported × enabled 2×2', () => {
  it('① supported=true / enabled=true：三个按钮都可用', () => {
    expect(provisionGates({ supported: true, enabled: true })).toEqual({
      supported: true,
      enabled: true,
      scanDisabled: false,
      writeDisabled: false,
      refreshDisabled: false,
    })
  })

  it('② supported=false / enabled=true（Node 后端恒 false 的真机场景）：只关扫码，不连坐写操作', () => {
    const g = provisionGates({ supported: false, enabled: true })
    expect(g.scanDisabled).toBe(true)
    expect(g.writeDisabled).toBe(false) // 回归红线：曾被 supported 连坐成 true ⇒ 整卡不可操作
    expect(g.refreshDisabled).toBe(false)
  })

  it('③ supported=true / enabled=false：总开关关掉写操作（扫码也是写操作）', () => {
    const g = provisionGates({ supported: true, enabled: false })
    expect(g.scanDisabled).toBe(true)
    expect(g.writeDisabled).toBe(true)
    expect(g.refreshDisabled).toBe(false)
  })

  it('④ supported=false / enabled=false：两个闸门都关，刷新状态仍可用', () => {
    const g = provisionGates({ supported: false, enabled: false })
    expect(g.scanDisabled).toBe(true)
    expect(g.writeDisabled).toBe(true)
    expect(g.refreshDisabled).toBe(false)
  })
})

describe('provisionGates：脏输入兜底', () => {
  it('st=null/undefined（加载中）按"能力未知⇒不可用"兜底，刷新状态仍不禁', () => {
    for (const st of [null, undefined]) {
      expect(provisionGates(st)).toEqual({
        supported: false,
        enabled: false,
        scanDisabled: true,
        writeDisabled: true,
        refreshDisabled: false,
      })
    }
  })

  it('字段缺失/脏值按 false 兜底，不抛异常也不出现 undefined', () => {
    expect(provisionGates({})).toMatchObject({ supported: false, enabled: false, scanDisabled: true, writeDisabled: true })
    // 只有 supported 一个键时：写操作不被 supported 连坐（enabled 缺省=false 才关）
    expect(provisionGates({ supported: true }).writeDisabled).toBe(true)
    expect(provisionGates({ enabled: true }).writeDisabled).toBe(false)
  })
})

describe('provisionNotices：提示文案', () => {
  it('!supported 的提示后端无关：不提 lark-oapi，且说清"还剩什么能用"', () => {
    const notices = provisionNotices({ supported: false, enabled: true })
    expect(notices).toHaveLength(1)
    const [n] = notices
    expect(n.key).toBe('unsupported')
    expect(n.tone).toBe('warn')
    expect(n.text).not.toMatch(/lark-oapi/i)
    expect(n.text).toContain('不具备') // 说"能力不具备"，不说"已关闭"
    expect(n.text).not.toContain('TS_FEISHU_PROVISION') // 那是总开关的文案，不是能力缺失的文案
    expect(n.text).toContain('补齐应用配置') // 引导到仍然可用的动作
    expect(n.text).toContain('App ID') // 手工填凭据的退路
  })

  it('!supported 且 !enabled 时不再承诺"补齐应用配置"可用（避免与总开关文案打架）', () => {
    const notices = provisionNotices({ supported: false, enabled: false })
    expect(notices.map((n) => n.key)).toEqual(['unsupported', 'disabled'])
    expect(notices[0].text).not.toContain('补齐应用配置')
  })

  it('!enabled 提示保持既有语义（TS_FEISHU_PROVISION=0 关闭写操作）', () => {
    const notices = provisionNotices({ supported: true, enabled: false })
    expect(notices).toHaveLength(1)
    expect(notices[0].key).toBe('disabled')
    expect(notices[0].tone).toBe('closed')
    expect(notices[0].text).toContain('TS_FEISHU_PROVISION=0')
    expect(notices[0].text).toContain('写操作不可用')
  })

  it('supported=false 不被说成"已关闭"：两种提示的 key/tone 各自独立', () => {
    const onlyUnsupported = provisionNotices({ supported: false, enabled: true })
    expect(onlyUnsupported.map((n) => n.key)).toEqual(['unsupported'])
    expect(onlyUnsupported.some((n) => n.tone === 'closed')).toBe(false)
  })

  it('能力与开关都正常时无任何提示', () => {
    expect(provisionNotices({ supported: true, enabled: true })).toEqual([])
    expect(provisionNotices(null)).toHaveLength(2) // 加载中：两条都没定论，但都不崩
  })
})

// provisionQrUrl：二维码链接的**双形态**读取（2026-10-15 M9-R2）。
// 后端 `provision_status()["url"]` 两版都返回**对象**（oracle 原样存 SDK 回调的 dict），
// 直接渲染会显示 [object Object]；这里钉住「两种形态都取得到链接、坏形态不崩」。
describe('provisionQrUrl：对象 / 字符串两条形态都要能用', () => {
  const link = 'https://accounts.feishu.cn/qrcode?device_code=DC-1&from=sdk'

  it('oracle 口径（对象 {url, expire_in}）⇒ 取到字符串链接', () => {
    expect(provisionQrUrl({ state: 'waiting', url: { url: link, expire_in: 600 } })).toBe(link)
  })

  it('字符串形态（历史响应 / 将来回退）⇒ 原样返回', () => {
    expect(provisionQrUrl({ state: 'waiting', url: link })).toBe(link)
  })

  it('负对照：空对象 / 空串 / null / 缺字段 / 非字符串 url ⇒ 回空串（不是 [object Object]）', () => {
    expect(provisionQrUrl({ url: {} })).toBe('')
    expect(provisionQrUrl({ url: '' })).toBe('')
    expect(provisionQrUrl({ url: null })).toBe('')
    expect(provisionQrUrl({})).toBe('')
    expect(provisionQrUrl(null)).toBe('')
    expect(provisionQrUrl({ url: { url: 42 } })).toBe('')
    expect(provisionQrUrl({ url: 42 })).toBe('')
  })
})
