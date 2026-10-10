// utils/sessionQa.js 单测（2026-10-09 批次：提问索引侧栏纳入 agent 问答）
//
// 覆盖三件事：
//   1. parseAskQuestions —— agent 提问工具 args（JSON 文本）→ 题干/选项（截断/非法不抛）
//   2. parseAskAnswer   —— ask_user_question 的 tool_result 文本 → answer/pending/error
//      （answer 的三种真实形态：selected 标签、custom 自由文本、两者并存；
//        error 来自 aborted / cancelled / [自动检查点] 三类实况字符串）
//   3. buildQuestionIndex —— entries → 用户提问 + agent 问答混排索引（callId 配对、按 seq 升序）
//
// 真数据出处：dsh 会话存储里 `tool/call`(name=ask_user_question) + 紧随的
// `tool/result`（文本形如 {"answers":[{"id":"reload","selected":["…"]}]}）；
// 会话里没有对应的 user/message 事件，答案只能从 tool_result 取（见
// doc_ai/spec/sess_dialog/会话详情对话框.md）。
import { describe, expect, it } from 'vitest'

import {
  ASK_PLACEHOLDER, buildQuestionIndex, parseAskAnswer, parseAskQuestions,
  questionLabel, questionTitle,
} from '../utils/sessionQa'

describe('sessionQa：parseAskQuestions 解析提问 args', () => {
  it('题干/选项 label/多选标志逐项取出（真数据形态）', () => {
    const args = JSON.stringify({
      questions: [{
        id: 'reload', header: '生效时机', multi_select: false,
        question: '要现在让改动生效吗？',
        options: [
          { label: '你自己在插件面板里关/开一次', description: '最稳' },
          { label: '先不生效，等会儿再说', description: '随时可重启' },
        ],
      }],
    })
    expect(parseAskQuestions(args)).toEqual([{
      id: 'reload', header: '生效时机', multiSelect: false,
      question: '要现在让改动生效吗？',
      options: ['你自己在插件面板里关/开一次', '先不生效，等会儿再说'],
    }])
  })

  it('多子题按序全量返回', () => {
    const args = JSON.stringify({ questions: [
      { id: 'a', header: '部署方式', question: '用哪种？', multi_select: false, options: [{ label: '蓝绿' }] },
      { id: 'b', header: '覆盖模块', question: '覆盖哪些？', multi_select: true, options: [{ label: '登录' }, { label: '支付' }] },
    ] })
    const qs = parseAskQuestions(args)
    expect(qs.map((q) => q.id)).toEqual(['a', 'b'])
    expect(qs[1].multiSelect).toBe(true)
    expect(qs[1].options).toEqual(['登录', '支付'])
  })

  it('args 被截断成非法 JSON / 缺 questions / 空值 → []（不抛，侧栏不因截断炸掉）', () => {
    expect(parseAskQuestions('{"questions": [{"id": "a", "quest')).toEqual([])
    expect(parseAskQuestions('{"foo": 1}')).toEqual([])
    expect(parseAskQuestions('')).toEqual([])
    expect(parseAskQuestions(undefined)).toEqual([])
    expect(parseAskQuestions(JSON.stringify({ questions: [] }))).toEqual([])
  })

  it('题目字段缺席时用空串兜底（不产出 undefined）', () => {
    const qs = parseAskQuestions(JSON.stringify({ questions: [{ id: 'x' }] }))
    expect(qs).toEqual([{ id: 'x', header: '', multiSelect: false, question: '', options: [] }])
  })
})

describe('sessionQa：parseAskAnswer 解析回答文本', () => {
  it('单选 selected → answer（取标签原文）', () => {
    expect(parseAskAnswer('{"answers":[{"id":"reload","selected":["你自己在插件面板里关/开一次"]}]}'))
      .toEqual({ kind: 'answer', text: '你自己在插件面板里关/开一次' })
  })

  it('单题多选 → 标签用「、」连接', () => {
    expect(parseAskAnswer('{"answers":[{"id":"cover","selected":["登录","支付","搜索"]}]}').text)
      .toBe('登录、支付、搜索')
  })

  it('多子题 → 逐题答案用「；」连接', () => {
    expect(parseAskAnswer('{"answers":[{"id":"restore","selected":["我现在代为还原（推荐）"]},{"id":"sigsegv","selected":["接着修（同一会话继续）"]}]}').text)
      .toBe('我现在代为还原（推荐）；接着修（同一会话继续）')
  })

  it('自由文本（「其他…」）→ custom 原文', () => {
    expect(parseAskAnswer('{"answers":[{"id":"title_follow_mode","selected":[],"custom":"修改一下需求, 卡片标题应该是主会话的第一次用户提问"}]}'))
      .toEqual({ kind: 'answer', text: '修改一下需求, 卡片标题应该是主会话的第一次用户提问' })
  })

  it('selected 与 custom 并存 → 「标签；自定义」', () => {
    expect(parseAskAnswer('{"answers":[{"id":"a","selected":["蓝绿"],"custom":"再加一条灰度"}]}').text)
      .toBe('蓝绿；再加一条灰度')
  })

  it('空文本/未定义/无 answers 的 JSON → pending（侧栏显示「等待回答…」占位）', () => {
    expect(parseAskAnswer('')).toEqual({ kind: 'pending', text: '' })
    expect(parseAskAnswer(undefined)).toEqual({ kind: 'pending', text: '' })
    expect(parseAskAnswer('   ')).toEqual({ kind: 'pending', text: '' })
    expect(parseAskAnswer('{"foo":1}')).toEqual({ kind: 'pending', text: '' })
    expect(parseAskAnswer('{"answers":[]}')).toEqual({ kind: 'pending', text: '' })
  })

  it('三类实况中断串 → error（aborted / cancelled / 自动检查点）', () => {
    for (const msg of [
      'Error: ask_user_question was aborted before the user answered',
      'Error: the user cancelled ask_user_question',
      'Error: [自动检查点] 本次会话还有 1 个文件未提交：\n  - doc_ai/INDEX.md',
    ]) {
      expect(parseAskAnswer(msg).kind).toBe('error')
    }
  })

  it('is_error 置位优先于文本形态 → error', () => {
    expect(parseAskAnswer('{"answers":[{"id":"a","selected":["x"]}]}', true).kind).toBe('error')
  })

  it('非 JSON 的普通文本 → 按回答原文呈现（宽容，不吞内容）', () => {
    expect(parseAskAnswer('用户答：随便')).toEqual({ kind: 'answer', text: '用户答：随便' })
  })
})

describe('sessionQa：buildQuestionIndex 混排索引', () => {
  const entries = [
    { seq: 0, kind: 'user', text: '  任务卡片919是啥?  ' },
    { seq: 1, kind: 'assistant', text: '……' },
    { seq: 2, kind: 'tool_call', name: 'ask_user_question', call_id: 'c1',
      args: JSON.stringify({ questions: [{ id: 'q', header: '生效时机', question: '要现在生效吗？', options: [{ label: 'A' }] }] }) },
    { seq: 3, kind: 'tool_result', name: 'ask_user_question', call_id: 'c1',
      text: '{"answers":[{"id":"q","selected":["A"]}]}' },
    { seq: 4, kind: 'tool_call', name: 'bash', call_id: 'c2', args: '{"command":"ls"}' },
    { seq: 5, kind: 'tool_result', name: 'bash', call_id: 'c2', text: 'a.txt' },
    { seq: 6, kind: 'user', text: '重启了' },
    { seq: 7, kind: 'user', text: '   ' },
  ]

  it('用户提问项保持原规则（trim 后非空才入列）', () => {
    const idx = buildQuestionIndex(entries)
    const users = idx.filter((q) => q.kind === 'user')
    expect(users.map((q) => [q.seq, q.text])).toEqual([[0, '任务卡片919是啥?'], [6, '重启了']])
    expect(users.every((q) => q.ansSeq == null && q.state === 'user')).toBe(true)
  })

  it('ask 项：锚点=提问条 seq，配对结果条 ansSeq，文字=用户回答', () => {
    const ask = buildQuestionIndex(entries).find((q) => q.kind === 'ask')
    expect(ask).toMatchObject({ seq: 2, ansSeq: 3, state: 'answered', text: 'A' })
    expect(ask.ask[0]).toMatchObject({ header: '生效时机', question: '要现在生效吗？' })
  })

  it('混排按 seq 升序（两类交错同在一条列表）', () => {
    expect(buildQuestionIndex(entries).map((q) => q.seq)).toEqual([0, 2, 6])
  })

  it('非 ask 的工具调用/结果不入选（callId 配对不误伤）', () => {
    const onlyBash = entries.filter((e) => e.seq >= 4 && e.seq <= 5)
    expect(buildQuestionIndex(onlyBash)).toEqual([])
  })

  it('结果缺席 → pending 占位；结果在但被中断 → error', () => {
    const noResult = buildQuestionIndex(entries.slice(0, 3))
    expect(noResult[1]).toMatchObject({ kind: 'ask', seq: 2, ansSeq: null, state: 'pending', text: '' })
    const aborted = buildQuestionIndex([
      entries[2],
      { seq: 3, kind: 'tool_result', name: 'ask_user_question', call_id: 'c1',
        text: 'Error: the user cancelled ask_user_question', is_error: true },
    ])
    expect(aborted[0]).toMatchObject({ kind: 'ask', state: 'error', text: '' })
  })

  it('工具名大小写不敏感；空 entries → []', () => {
    const up = buildQuestionIndex([{ seq: 0, kind: 'tool_call', name: 'Ask_User_Question', call_id: 'z', args: '{}' }])
    expect(up).toHaveLength(1)
    expect(buildQuestionIndex([])).toEqual([])
    expect(buildQuestionIndex(undefined)).toEqual([])
  })
})

describe('sessionQa：questionLabel / questionTitle 展示文案', () => {
  const askItem = {
    key: 'a:2', seq: 2, kind: 'ask', ansSeq: 3, state: 'answered', text: 'A',
    ask: [{ header: '生效时机', question: '要现在生效吗？', multiSelect: false, options: ['A'] }],
  }

  it('questionLabel：user 原文；ask 已答=回答；未答/中断=占位文案', () => {
    expect(questionLabel({ kind: 'user', text: '重启了' })).toBe('重启了')
    expect(questionLabel(askItem)).toBe('A')
    expect(questionLabel({ ...askItem, state: 'pending', text: '' })).toBe(ASK_PLACEHOLDER.pending)
    expect(questionLabel({ ...askItem, state: 'error', text: '' })).toBe(ASK_PLACEHOLDER.error)
  })

  it('questionTitle：user 原文不变；ask 带题目与回答（未答带占位说明）', () => {
    expect(questionTitle({ kind: 'user', text: '重启了' })).toBe('重启了')
    expect(questionTitle(askItem)).toBe('agent 提问：生效时机：要现在生效吗？\n回答：A')
    expect(questionTitle({ ...askItem, state: 'pending', text: '' }))
      .toBe('agent 提问：生效时机：要现在生效吗？\n等待回答…')
    expect(questionTitle({ ...askItem, state: 'error', text: '', ask: [] }))
      .toBe('agent 提问\n未作答（已中断）')
  })
})
