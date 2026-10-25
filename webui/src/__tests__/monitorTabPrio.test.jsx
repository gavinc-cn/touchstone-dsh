// MonitorTab「测试进度（按功能分级）」覆盖条渲染契约（KB-25 / T15 N2 覆盖缺口）。
//
// 为什么需要它：`isDomainCovered` 本身有纯函数单测（utils/taskEnums.test.js），但
// `MonitorTab.jsx:514`（覆盖计数）与 `:517`（chip class/title）两处**调用点**没有渲染断言。
// 纯函数被测过 ≠ 调用点接对了线——这正是 2026-10-15 飞书设置页黑屏那类缺陷的形状。
// 这里把 MonitorTab 真挂起来（不导出产品内部函数），用 live store 的 `priorities` 夹具钉住：
//   ① 覆盖计数文案（covered/total）与进度条宽度；
//   ② 每个功能域 chip 的 `ok` class 与 title（含空状态回落「未覆盖」）；
//   ③ 中英两种语言下 t() 都真的被消费（zh 回原文，en 查词表）。
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import MonitorTab from '../components/MonitorTab'
import { useLiveStore } from '../stores/live'
import { setLang } from '../utils/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 覆盖条夹具：一条分级里混合 canonical / 英文容错 / 未覆盖 / 未知状态，专门照 514/517 两处。
const PRIORITIES = {
  levels: [
    {
      level: 'P0',
      label: '核心',
      domains: [
        { name: '登录', status: '已覆盖' },       // canonical 中文
        { name: '支付', status: ' Covered ' },    // 英文容错值（isDomainCovered 接受）
        { name: '导出', status: '未覆盖' },
        { name: '分享', status: '' },             // 空状态 ⇒ title 回落「未覆盖」
        { name: '弹窗', status: '未知状态' },      // 未知值不猜译，原样进 title
      ],
    },
    {
      level: 'P1',
      label: '细节',
      domains: [{ name: '通知', status: '已覆盖' }],
    },
  ],
}

// title 里的状态是**后端原始值**（未知值不猜译；空值才走 t('未覆盖')）：
// 「 Covered 」的边界空白与「未覆盖」都原样进 title，只有空状态回落词表。
const CHIP_TITLES_ZH = [
  '登录：已覆盖',
  '支付： Covered ',
  '导出：未覆盖',
  '分享：未覆盖',
  '弹窗：未知状态',
  '通知：已覆盖',
]

let mounted = []

/** 挂载 MonitorTab（不传 project.id ⇒ 不连 SSE，只渲染 live store 里预置的状态） */
async function mountMonitor() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(MonitorTab, { project: { name: '演示项目' } }))
  })
  mounted.push({ root, container })
  return container
}

/** 取覆盖条里每个分级行的读数（计数 / 进度条 / chips） */
function readPrioBar(container) {
  const bar = container.querySelector('section.prio-bar')
  expect(bar, 'live.priorities 有 levels 时必须渲染覆盖条').not.toBeNull()
  return {
    title: bar.querySelector('.prio-title').textContent,
    nums: [...bar.querySelectorAll('.prio-num')].map((n) => n.textContent),
    widths: [...bar.querySelectorAll('.prio-in')].map((n) => n.style.width),
    chips: [...bar.querySelectorAll('.prio-chips .pchip')],
  }
}

beforeEach(() => {
  setLang('zh')
  // 只预置渲染需要的 live 字段：覆盖条之外的分支都走「无数据」路径
  useLiveStore.setState({
    live: { priorities: PRIORITIES },
    library: null,
    bugs: [],
    rounds: [],
    connected: false,
  })
})

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => { root.unmount() })
    container.remove()
  }
  mounted = []
  useLiveStore.setState({ live: null, library: null, bugs: [], rounds: [], connected: false })
  document.body.innerHTML = ''
})

describe('MonitorTab 功能分级覆盖条（KB-25）', () => {
  it('覆盖计数 = isDomainCovered 的命中数，进度条宽度按 covered/total', async () => {
    const container = await mountMonitor()
    const { title, nums, widths } = readPrioBar(container)
    expect(title).toBe('测试进度（按功能分级）')
    // 514 行：`covered` 必须把 canonical「已覆盖」与「 Covered 」都算上（2/5），
    // 未覆盖/空/未知状态一律不计；第二级独立计数（1/1）证明不是全局累加。
    expect(nums).toEqual(['2/5', '1/1'])
    expect(widths).toEqual(['40%', '100%'])
  })

  it('chip 的 ok class 与 title 严格按 isDomainCovered 判定（含空状态回落「未覆盖」）', async () => {
    const container = await mountMonitor()
    const { chips } = readPrioBar(container)
    // 517 行：命中覆盖才加 ` ok`；非覆盖只保留 `pchip`（class 是样式契约，不能多/少）
    expect(chips.map((c) => c.className)).toEqual([
      'pchip ok', 'pchip ok', 'pchip', 'pchip', 'pchip', 'pchip ok',
    ])
    // 517 行：title = 域名 + t('：') + (原始状态 || t('未覆盖'))
    expect(chips.map((c) => c.title)).toEqual(CHIP_TITLES_ZH)
    // chip 文本仍是域名本身（状态只进 title，不混进可见文案）
    expect(chips.map((c) => c.textContent)).toEqual(['登录', '支付', '导出', '分享', '弹窗', '通知'])
  })

  it('en 下 title 的分隔符与「未覆盖」走词表，ok 判定不受语言影响', async () => {
    setLang('en')
    const container = await mountMonitor()
    const { title, nums, chips } = readPrioBar(container)
    expect(title).toBe('Test progress (by functional tier)')
    // 覆盖计数是数据值（数字），切语言不变
    expect(nums).toEqual(['2/5', '1/1'])
    // 分隔符 en 词条 ': '；仅**空状态**回落 en 词条 Not covered——
    // 非空的原始状态是后端数据值，不翻译（「导出」的「未覆盖」原样保留）。
    expect(chips.map((c) => c.title)).toEqual([
      '登录: 已覆盖',
      '支付:  Covered ',
      '导出: 未覆盖',
      '分享: Not covered',
      '弹窗: 未知状态',
      '通知: 已覆盖',
    ])
    expect(chips.map((c) => c.className)).toEqual([
      'pchip ok', 'pchip ok', 'pchip', 'pchip', 'pchip', 'pchip ok',
    ])
  })
})
