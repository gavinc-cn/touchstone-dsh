// utils/pathLink.js 单测：会话回答里的文件路径识别（点击后可预览文件）
// 覆盖：相对/绝对/Windows 路径、尾随标点剥离、URL 与目录不误伤、
// 裸文件名的 KNOWN_EXT 白名单（`sys.path` 之类属性访问不得被当成文件）。
import { describe, expect, it } from 'vitest'

import { linkifyPaths } from '../utils/pathLink'

/** 期望的链接标记（实现：class=md-path + data-path + title 提示） */
const A = (p, t = p) => `<a class="md-path" data-path="${p}" title="点击预览：${p}">${t}</a>`

describe('linkifyPaths', () => {
  it('正文里的相对路径变可点链接', () => {
    expect(linkifyPaths('已更新 doc_ai/spec/foo.md 并同步')).toBe(`已更新 ${A('doc_ai/spec/foo.md')} 并同步`)
  })

  it('绝对路径、./ ../ ~/ 前缀、盘符路径均可识别', () => {
    expect(linkifyPaths('看 /srv/proj/doc_ai/plan/x.md 吧'))
      .toBe(`看 ${A('/srv/proj/doc_ai/plan/x.md')} 吧`)
    expect(linkifyPaths('./run.sh 与 ../a/b.py')).toBe(`${A('./run.sh')} 与 ${A('../a/b.py')}`)
    expect(linkifyPaths('~/kimi/config.toml')).toBe(A('~/kimi/config.toml'))
    expect(linkifyPaths('D:\\proj\\src\\app.py')).toBe(A('D:\\proj\\src\\app.py'))
    expect(linkifyPaths('C:/proj/README.md')).toBe(A('C:/proj/README.md'))
  })

  it('尾随标点与包裹括号不吞进链接', () => {
    expect(linkifyPaths('见 doc_ai/x.md, 然后')).toBe(`见 ${A('doc_ai/x.md')}, 然后`)
    expect(linkifyPaths('见 doc_ai/x.md.')).toBe(`见 ${A('doc_ai/x.md')}.`)
    expect(linkifyPaths('（doc_ai/x.md）')).toBe(`（${A('doc_ai/x.md')}）`)
    expect(linkifyPaths('"doc_ai/x.md"')).toBe(`"${A('doc_ai/x.md')}"`)
    expect(linkifyPaths('`doc_ai/x.md`')).toBe(`\`${A('doc_ai/x.md')}\``)
    expect(linkifyPaths('已更新 doc_ai/spec/foo.md。')).toBe(`已更新 ${A('doc_ai/spec/foo.md')}。`)
  })

  it('中文标点紧邻路径也能切开（中文正文常见写法）', () => {
    expect(linkifyPaths('已更新 doc_ai/spec/demo.md，另有其它改动'))
      .toBe(`已更新 ${A('doc_ai/spec/demo.md')}，另有其它改动`)
    expect(linkifyPaths('见 doc_ai/x.md（新增）')).toBe(`见 ${A('doc_ai/x.md')}（新增）`)
    expect(linkifyPaths('doc_ai/x.md、doc_ai/y.md')).toBe(`${A('doc_ai/x.md')}、${A('doc_ai/y.md')}`)
    // 路径本身可含中文字符（分词只认标点）
    expect(linkifyPaths('doc_ai/测试报告/x.md')).toBe(A('doc_ai/测试报告/x.md'))
  })

  it('行号后缀（file.md:42 / file.md:12:3）不进链接', () => {
    expect(linkifyPaths('见 doc_ai/x.md:42 处')).toBe(`见 ${A('doc_ai/x.md')}:42 处`)
    expect(linkifyPaths('doc_ai/x.md:12:3')).toBe(`${A('doc_ai/x.md')}:12:3`)
    expect(linkifyPaths('见 doc_ai/x.md:42，改这里')).toBe(`见 ${A('doc_ai/x.md')}:42，改这里`)
  })

  it('URL、目录、无扩展名路径不识别', () => {
    expect(linkifyPaths('https://github.com/a/b/README.md')).toBe('https://github.com/a/b/README.md')
    expect(linkifyPaths('见 /srv/proj/doc_ai/')).toBe('见 /srv/proj/doc_ai/')
    expect(linkifyPaths('看 doc_ai/spec 目录')).toBe('看 doc_ai/spec 目录')
    expect(linkifyPaths('请求 /api/projects/1/board')).toBe('请求 /api/projects/1/board')
    expect(linkifyPaths('版本 v1.2 与 1.2.3')).toBe('版本 v1.2 与 1.2.3')
    expect(linkifyPaths('--out=doc/x.md')).toBe('--out=doc/x.md')
    expect(linkifyPaths('mod/*.py 全部')).toBe('mod/*.py 全部')
  })

  it('裸文件名只在 bare 模式识别，且扩展名须在已知清单内', () => {
    expect(linkifyPaths('见 main.py 文件')).toBe('见 main.py 文件')            // 正文不认裸文件名
    expect(linkifyPaths('见 main.py 文件', { bare: true })).toBe(`见 ${A('main.py')} 文件`)
    expect(linkifyPaths('README.md', { bare: true })).toBe(A('README.md'))
    expect(linkifyPaths('x.tar.gz', { bare: true })).toBe(A('x.tar.gz'))
    // 属性访问/版本号/未知扩展名不误伤
    expect(linkifyPaths('sys.path 与 os.environ', { bare: true })).toBe('sys.path 与 os.environ')
    expect(linkifyPaths('1.2.3', { bare: true })).toBe('1.2.3')
    expect(linkifyPaths('foo.weird', { bare: true })).toBe('foo.weird')
    // bare 模式下含分隔符的路径照常识别（不受白名单约束）
    expect(linkifyPaths('doc_ai/x.weird', { bare: true })).toBe(A('doc_ai/x.weird'))
  })

  it('一行多个路径分别链接，空输入安全返回', () => {
    expect(linkifyPaths('先 a/b.md 再 c/d.json'))
      .toBe(`先 ${A('a/b.md')} 再 ${A('c/d.json')}`)
    expect(linkifyPaths('')).toBe('')
    expect(linkifyPaths(null)).toBe('')
    expect(linkifyPaths(undefined)).toBe('')
    expect(linkifyPaths(123)).toBe('123')
  })

  it('不破坏 HTML 转义文本与相邻标记（加粗包裹的路径可点）', () => {
    expect(linkifyPaths('<b>doc_ai/x.md</b>')).toBe(`<b>${A('doc_ai/x.md')}</b>`)
    // 转义实体原样保留在属性里（浏览器解码后即原路径）
    expect(linkifyPaths('a&amp;b/c.md 与 a/b.md')).toBe(`${A('a&amp;b/c.md')} 与 ${A('a/b.md')}`)
    expect(linkifyPaths('&lt;doc_ai/x.md&gt;')).toBe('&lt;doc_ai/x.md&gt;')
    expect(linkifyPaths('<img src=x.png> 与 a/b.md')).toBe(`<img src=x.png> 与 ${A('a/b.md')}`)
  })

  it('占位符（内联 code / 既有链接）不被路径化', () => {
    expect(linkifyPaths('\u00000\u0000 与 doc_ai/x.md'))
      .toBe(`\u00000\u0000 与 ${A('doc_ai/x.md')}`)
  })
})
