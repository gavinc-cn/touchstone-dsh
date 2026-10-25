// InteractionCard 只读展示（2026-10-25，原 plan `20261008_0635` 的 T6）：不可作答时不得再把
// 选项内容整块隐藏。
//
// 复现的实障（#906）：外部直跑会话的提问在 TS 会话窗只剩题头 + 一排题号进度点
// （`.sess-inav-dot`），选项 label/description 与「提交」整块不渲染。根因是组件把
// 「选项内容的展示」与「作答控件的可用性」绑在同一个 `data.answerable` 门控上。
//
// 为什么用**组件真渲染**而不是纯函数单测：本缺陷是「调用点把展示与能力绑死」的接线缺陷，
// 纯函数再全也照不到（同 2026-10-15 FeishuPanel 黑屏的教训，见 feishuPanelMount.test.jsx）。
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionCard } from '../components/SessionView'
import { setLang } from '../utils/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 引导文案 = 本轮新增 i18n 词条（zh 下 t() 原样返回中文 key）
const HINT = '本次等待不支持在此作答，请在 dsh 会话窗口处理'

const OPT_A = { id: 'o1', label: '最小可行', description: '只做 Linux 侧' }
const OPT_B = { id: 'o2', label: '完整方案', description: '含 Windows 与文档' }

/** 单题（可覆写字段） */
function question(over = {}) {
  return {
    id: 'scope',
    header: '确认范围',
    question: '按哪个范围实施？',
    body: '',
    options: [OPT_A, OPT_B],
    multi_select: false,
    allow_other: false,
    ...over,
  }
}

/** 提问交互载荷（默认不可作答） */
function questionData(over = {}) {
  return {
    pending: true,
    kind: 'question',
    answerable: false,
    qid: 'call_q1',
    questions: [question()],
    ...over,
  }
}

/** 审批交互载荷 */
function approvalData(over = {}) {
  return {
    pending: true,
    kind: 'approval',
    answerable: false,
    approval_id: 'ap-1',
    tool: 'bash',
    action: 'bash',
    input: 'rm -rf build',
    ...over,
  }
}

let root = null
let host = null

/** 挂载 InteractionCard（answer 注入桩；组件内部只在点击时调用） */
async function mount(data) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const answer = vi.fn(async () => {})
  await act(async () => { root.render(createElement(InteractionCard, { data, answer })) })
  return host
}

/** 可点按钮文案（去掉首尾空白，便于按「提交 / 批准」精确断言） */
function buttonTexts(node) {
  return [...node.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
}

beforeEach(() => {
  setLang('zh')
  document.body.innerHTML = ''
})

afterEach(() => {
  if (root) {
    act(() => root.unmount())
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
})

describe('InteractionCard：不可作答时只读展示（#906 回归）', () => {
  it('单题不可作答：选项 label/description 可见、无任何输入控件、无「提交」、有引导', async () => {
    const node = await mount(questionData())
    const text = node.textContent || ''
    // ① 内容不丢（缺陷本体）：label + description 都在
    expect(text).toContain('最小可行')
    expect(text).toContain('只做 Linux 侧')
    expect(text).toContain('完整方案')
    expect(text).toContain('含 Windows 与文档')
    // ② 只读形态：只读列表在，且没有任何 input / 「提交」按钮
    expect(node.querySelector('.sess-interaction-list.ro')).not.toBeNull()
    expect(node.querySelectorAll('input')).toHaveLength(0)
    expect(buttonTexts(node)).not.toContain('提交')
    // ③ 引导文案（替代原来的空白/误导）
    expect(node.querySelector('.sess-interaction-hint.ro')).not.toBeNull()
    expect(text).toContain(HINT)
  })

  it('多题不可作答：翻页点保留、当前题只读选项可见、无提交、有引导', async () => {
    const node = await mount(questionData({
      questions: [
        question(),
        question({ id: 'method', header: '实现方式', question: '怎么实现？', options: [OPT_A] }),
      ],
    }))
    // 多题仍可翻页（否则第二个子题完全看不到）
    expect(node.querySelectorAll('.sess-inav-dot')).toHaveLength(2)
    expect(node.textContent || '').toContain('最小可行')
    expect(node.textContent || '').toContain(HINT)
    expect(buttonTexts(node)).not.toContain('提交')
    // 翻到第二题：仍应只读展示该题选项（覆盖「逐题」而非「只画首题」）
    const dots = node.querySelectorAll('.sess-inav-dot')
    await act(async () => {
      dots[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(node.textContent || '').toContain('怎么实现？')
    expect(node.textContent || '').toContain('最小可行')
    expect(node.querySelectorAll('input')).toHaveLength(0)
  })

  it('「其他…」只读行：出 label/description，不出文本输入框', async () => {
    const node = await mount(questionData({
      questions: [question({ allow_other: true, other_label: '自定义范围', other_description: '自由填写' })],
    }))
    const text = node.textContent || ''
    expect(text).toContain('自定义范围')
    expect(text).toContain('自由填写')
    expect(node.querySelector('.sess-iopt-input')).toBeNull()
    expect(node.querySelectorAll('input')).toHaveLength(0)
  })

  it('可作答路径原样：有选项控件与「提交」、无新引导（回归护栏）', async () => {
    const node = await mount(questionData({ answerable: true }))
    const text = node.textContent || ''
    // 既有控件都在：2 个 radio + 提交按钮
    expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(buttonTexts(node)).toContain('提交')
    expect(text).toContain('选择后点「提交」')
    // 新引导不得出现在可作答路径
    expect(node.querySelector('.sess-interaction-hint.ro')).toBeNull()
    expect(text).not.toContain(HINT)
  })
})

describe('InteractionCard：审批不可作答时补引导（不出死按钮）', () => {
  it('审批不可作答：内容可见、无审批按钮、有引导', async () => {
    const node = await mount(approvalData())
    const text = node.textContent || ''
    expect(text).toContain('rm -rf build')
    expect(node.querySelector('.sess-interaction-opts')).toBeNull()
    for (const label of ['批准', '本会话内批准', '拒绝']) {
      expect(buttonTexts(node)).not.toContain(label)
    }
    expect(text).toContain(HINT)
  })

  it('审批可作答：三按钮可见、无新引导（回归护栏）', async () => {
    const node = await mount(approvalData({ answerable: true }))
    const labels = buttonTexts(node)
    expect(labels).toContain('批准')
    expect(labels).toContain('本会话内批准')
    expect(labels).toContain('拒绝')
    expect((node.textContent || '')).not.toContain(HINT)
  })
})
