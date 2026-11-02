// InteractionCard：Ctrl+Enter 提交提问（2026-11-01）
//
// 需求：agent 提问在 TS 会话窗里可用 Ctrl+Enter 提交；**全部子题都作答之后**才生效
// （缺一题都不提交，与「提交」按钮的 canSubmit 同一判据）。
//
// 为什么用组件真渲染：键盘接线是组件行为（window 捕获监听 + 拦截 composer 的 Enter 发送），
// 纯函数单测照不到接线本身（同 interactionCardReadonly.test.jsx 的教训：2026-10-15
// FeishuPanel 黑屏＝调用点/挂载缺陷，纯函数全绿也没用）。
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionCard } from '../components/SessionView'
import { setLang } from '../utils/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const OPT_A = { id: 'o1', label: '选项 A' }
const OPT_B = { id: 'o2', label: '选项 B' }

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

/** 可作答的提问载荷（Ctrl+Enter 只在这条路径上有意义） */
function questionData(over = {}) {
  return {
    pending: true,
    kind: 'question',
    answerable: true,
    qid: 'call_q1',
    questions: [question()],
    ...over,
  }
}

let root = null
let host = null
let answer = null

/** 挂载 InteractionCard；answer=提交桩（断言载荷用） */
async function mount(data) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  answer = vi.fn(async () => {})
  await act(async () => { root.render(createElement(InteractionCard, { data, answer })) })
  return host
}

/** 点第 n 个 radio（React 的 radio onChange 走 click 事件） */
async function pickRadio(node, n = 0) {
  const input = node.querySelectorAll('input[type="radio"]')[n]
  await act(async () => { input.click() })
  return input
}

/** 派发 Ctrl+Enter；返回事件对象（可断言 defaultPrevented 证明已拦截） */
async function pressCtrlEnter(target = document.body) {
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
  })
  await act(async () => { target.dispatchEvent(ev) })
  return ev
}

/** 点按钮文案匹配的第一个按钮（多题翻页用） */
async function clickButton(node, text) {
  const btn = [...node.querySelectorAll('button')]
    .find((b) => (b.textContent || '').includes(text))
  expect(btn, `找不到按钮：${text}`).toBeTruthy()
  await act(async () => { btn.click() })
}

beforeEach(() => {
  setLang('zh')
  document.body.innerHTML = ''
  answer = null
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

describe('InteractionCard：Ctrl+Enter 提交提问', () => {
  it('全部子题答完后 Ctrl+Enter 提交（并拦截事件，避免 composer 同时发送）', async () => {
    const node = await mount(questionData())
    await pickRadio(node, 0)
    const ev = await pressCtrlEnter()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith({
      qid: 'call_q1',
      answers: [{ wire: 'scope', kind: 'single', option_id: 'o1' }],
    })
    expect(ev.defaultPrevented).toBe(true)
  })

  it('一题都没答时 Ctrl+Enter 不提交', async () => {
    await mount(questionData())
    await pressCtrlEnter()
    expect(answer).not.toHaveBeenCalled()
  })

  it('多题只答了一题时 Ctrl+Enter 不提交，答满后才提交', async () => {
    const node = await mount(questionData({
      questions: [
        question({ id: 'q1', header: '第一题' }),
        question({ id: 'q2', header: '第二题' }),
      ],
    }))
    await pickRadio(node, 0)          // 只答当前页的第 1 题
    await pressCtrlEnter()
    expect(answer).not.toHaveBeenCalled()
    await clickButton(node, '下一题')
    await pickRadio(node, 1)          // 第 2 题选 B
    await pressCtrlEnter()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer.mock.calls[0][0]).toEqual({
      qid: 'call_q1',
      answers: [
        { wire: 'q1', kind: 'single', option_id: 'o1' },
        { wire: 'q2', kind: 'single', option_id: 'o2' },
      ],
    })
  })

  it('焦点在「其他…」输入框里时 Ctrl+Enter 也提交自定义答案', async () => {
    const node = await mount(questionData({
      questions: [question({ allow_other: true, other_label: '自定义范围' })],
    }))
    const other = node.querySelector('.sess-iopt-input')
    expect(other).toBeTruthy()
    // 受控 input：用原生 setter + input 事件让 React 收到键入
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(other, '只改前端')
      other.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { other.focus() })
    await pressCtrlEnter(other)
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer.mock.calls[0][0]).toEqual({
      qid: 'call_q1',
      answers: [{ wire: 'scope', kind: 'other', text: '只改前端' }],
    })
  })

  it('拦截后事件不再冒泡（composer 的 Enter 发送不会双发）', async () => {
    const node = await mount(questionData())
    await pickRadio(node, 0)
    const seen = vi.fn()
    document.addEventListener('keydown', seen)          // 冒泡相：模拟 React 根上的发送处理
    try {
      await pressCtrlEnter()
    } finally {
      document.removeEventListener('keydown', seen)
    }
    expect(answer).toHaveBeenCalledTimes(1)
    expect(seen).not.toHaveBeenCalled()
  })

  it('卡片最小化后 Ctrl+Enter 仍可提交（答满时）', async () => {
    const node = await mount(questionData())
    await pickRadio(node, 0)
    const minBtn = node.querySelector('.sess-interaction-min')
    expect(minBtn).toBeTruthy()
    await act(async () => { minBtn.click() })
    expect(node.querySelector('.sess-interaction-bar')).toBeTruthy()
    await pressCtrlEnter()
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('普通 Enter 不提交（不劫持 composer 的发送键）', async () => {
    const node = await mount(questionData())
    await pickRadio(node, 0)
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { document.body.dispatchEvent(ev) })
    expect(answer).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('不可作答（answerable=false）时不响应 Ctrl+Enter', async () => {
    await mount(questionData({ answerable: false }))
    await pressCtrlEnter()
    expect(answer).not.toHaveBeenCalled()
  })

  it('审批卡不响应 Ctrl+Enter（仍走三个按钮）', async () => {
    await mount({
      pending: true, kind: 'approval', answerable: true,
      approval_id: 'ap-1', tool: 'bash', action: 'bash', input: 'rm -rf build',
    })
    await pressCtrlEnter()
    expect(answer).not.toHaveBeenCalled()
  })

  it('卸载后监听移除（不把按键残留给下一个卡片）', async () => {
    const node = await mount(questionData())
    await pickRadio(node, 0)
    act(() => root.unmount())
    root = null
    await pressCtrlEnter()
    expect(answer).not.toHaveBeenCalled()
  })
})
