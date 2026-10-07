// utils/renderDoc.js 单测：文档级 markdown 渲染
// 覆盖：表格横向滚动容器、标题锚点 id 与目录、章节序号拆分（金色标注）、
// 抬头抽取（首个 h1 = 文档标题 + 紧随其后的键值列表 = 元信息行）与「形状不符就不摘」的
// 兜底（绝不丢正文）、report 页不开 extractHeader 时正文原样。
import { describe, expect, it } from 'vitest'

import { renderDoc } from '../utils/renderDoc'

const PLAN = [
  '# 压测方案：下单接口',
  '',
  '- 目标服务：http://127.0.0.1:8080',
  '- 执行载体：`run.py`',
  '- 生成时间：2026-10-06 01:10 UTC',
  '',
  '## 1. 目标与范围',
  '',
  '正文带 `code`。',
  '',
  '| 接口 | 方法 |',
  '|------|------|',
  '| 下单 | POST |',
  '',
  '### 1.1 子节',
].join('\n')

describe('renderDoc 抬头抽取（方案页）', () => {
  const doc = renderDoc(PLAN, { extractHeader: true })

  it('首个 h1 作文档标题，且不再留在正文里', () => {
    expect(doc.title).toBe('压测方案：下单接口')
    expect(doc.html).not.toContain('<h1')
    expect(doc.html).not.toContain('压测方案：下单接口')
  })

  it('紧随其后的键值列表摘成元信息行，值里的行内标记保留', () => {
    expect(doc.meta).toEqual([
      { k: '目标服务', v: 'http://127.0.0.1:8080' },
      { k: '执行载体', v: '<code>run.py</code>' },
      { k: '生成时间', v: '2026-10-06 01:10 UTC' },
    ])
    expect(doc.html).not.toContain('目标服务')
    expect(doc.html).toContain('正文带 <code>code</code>')
  })

  it('标题带锚点 id，序号拆成 .md-sec-no，目录按文档顺序给出层级与正文', () => {
    expect(doc.html).toContain('id="md-h-0"')
    expect(doc.html).toContain('<span class="md-sec-no">1</span>目标与范围')
    expect(doc.outline).toEqual([
      { id: 'md-h-0', level: 2, no: '1', text: '目标与范围' },
      { id: 'md-h-1', level: 3, no: '1.1', text: '子节' },
    ])
  })

  it('表格套横向滚动容器（窄面板里横滚，不撑破面板）', () => {
    expect(doc.html).toContain('<div class="md-table-wrap"><table>')
    expect(doc.html.match(/md-table-wrap/g)).toHaveLength(1)
  })
})

describe('renderDoc 兜底', () => {
  it('抬头形状不符（有项不是键值）→ 标题照摘，列表原样留在正文', () => {
    const doc = renderDoc('# 标题\n\n- 目标服务：x\n- 这一项没有冒号\n', { extractHeader: true })
    expect(doc.title).toBe('标题')
    expect(doc.meta).toEqual([])
    expect(doc.html).toContain('目标服务：x')
    expect(doc.html).toContain('这一项没有冒号')
  })

  it('只有 1 项键值不算抬头；没有 h1 时标题为空、正文全留', () => {
    const one = renderDoc('# 标题\n\n- 目标服务：x\n', { extractHeader: true })
    expect(one.meta).toEqual([])
    expect(one.html).toContain('目标服务：x')
    const noH1 = renderDoc('## 1. 小节\n\n正文', { extractHeader: true })
    expect(noH1.title).toBe('')
    expect(noH1.html).toContain('小节')
  })

  it('不开 extractHeader（报告页）时标题与抬头都留在正文', () => {
    const doc = renderDoc(PLAN)
    expect(doc.title).toBe('')
    expect(doc.meta).toEqual([])
    expect(doc.html).toContain('>压测方案：下单接口</h1>')   // h1 保留（只多一个锚点 id）
    expect(doc.html).toContain('目标服务')
  })

  it('空输入与无标题行都不炸', () => {
    expect(renderDoc('')).toEqual({ html: '', title: '', meta: [], outline: [] })
    const p = renderDoc('一段普通文字', { extractHeader: true })
    expect(p.html).toBe('<p>一段普通文字</p>')
    expect(p.outline).toEqual([])
  })
})
