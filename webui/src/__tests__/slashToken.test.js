// utils/slashToken.js 单测：会话输入框 `/` 指令 token 探测（findSlashToken）
// 语义：token = 光标向左到行首/最近空白之间的连续非空白文本，且以 '/' 开头；
// 返回 { start, text } | null（start 含 '/' 的下标）。行中「文字 /」即触发，
// 但普通斜杠（URL、路径 a/b）不触发——避免误弹指令菜单。
import { describe, expect, it } from 'vitest'

import { findSlashToken } from '../utils/slashToken'

// 默认把光标放在末尾（正常输入态），指定 caret 时模拟光标停在 token 中部
const at = (input, caret = input.length) => findSlashToken(input, caret)

describe('findSlashToken', () => {
  it('行首的 `/` 触发，start 为 0', () => {
    expect(at('/')).toEqual({ start: 0, text: '/' })
    expect(at('/compact')).toEqual({ start: 0, text: '/compact' })
  })

  it('行中空白后的 `/命令` 触发，光标在 token 中部只取前缀', () => {
    expect(at('请帮我看 /comp')).toEqual({ start: 5, text: '/comp' })
    // 光标停在第 8 位（/co 之后），token 前缀即查询词
    expect(at('请帮我看 /comp', 8)).toEqual({ start: 5, text: '/co' })
  })

  it('`/` 前不是行首或空白时不触发（URL、路径里的斜杠）', () => {
    expect(at('a/b')).toBeNull()
    expect(at('https://x.dev/a')).toBeNull()
    expect(at('看http://x.dev')).toBeNull()
  })

  it('token 已闭合（后面又输入了空白与文字）时不触发', () => {
    expect(at('/stop 然后')).toBeNull()
    expect(at('文字 /cmd 参数')).toBeNull()
  })

  it('空输入、光标在行首、换行后触发等边界', () => {
    expect(at('')).toBeNull()
    expect(at('/abc', 0)).toBeNull() // 光标在 '/' 之前
    // 换行属空白：第二行行首的 '/' 触发，start 指向该行 '/' 的下标
    expect(at('第一行\n/')).toEqual({ start: 4, text: '/' })
  })
})
