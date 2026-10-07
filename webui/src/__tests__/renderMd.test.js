// utils/renderMd.js 单测：轻量 markdown → HTML（气泡/描述/评论共用的渲染器）
// 覆盖：HTML 转义（防注入）、标题与行内 code/bold、代码围栏、列表/引用/水平线、
// 表格、链接与图片的 URL 白名单（javascript: 等协议被过滤为纯文本）、空输入与状态常量。
import { describe, expect, it } from 'vitest'

import { renderMd, fmtTime, ST_LABEL } from '../utils/renderMd'

describe('renderMd', () => {
  it('段落渲染并转义 HTML 特殊字符', () => {
    expect(renderMd('a<b>&c')).toBe('<p>a&lt;b&gt;&amp;c</p>')
    expect(renderMd('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })

  it('标题只认 1-4 个 # 且 # 后必须有空格；行内 code 与 bold', () => {
    expect(renderMd('# 标题')).toBe('<h1>标题</h1>')
    expect(renderMd('#### 四级')).toBe('<h4>四级</h4>')
    expect(renderMd('##### 五级')).toBe('<p>##### 五级</p>') // 5 个 # 超范围，按段落
    expect(renderMd('#无空格')).toBe('<p>#无空格</p>')
    expect(renderMd('**粗** 与 `a<b`')).toBe('<p><b>粗</b> 与 <code>a&lt;b</code></p>')
  })

  it('代码围栏内容按文本处理（块级语法不解析）且转义 HTML', () => {
    expect(renderMd('```\n# 不是标题\n<b>\n```')).toBe('<pre><code># 不是标题\n&lt;b&gt;</code></pre>')
    expect(renderMd('```js\nlet a = 1;\n```')).toBe('<pre><code>let a = 1;</code></pre>') // 语言标记被丢弃
    expect(renderMd('```\nabc')).toBe('<pre><code>abc</code></pre>') // 未闭合围栏取到文末
  })

  it('无序列表、引用、水平线、空行跳过', () => {
    expect(renderMd('- a\n- **b**')).toBe('<ul><li>a</li><li><b>b</b></li></ul>')
    expect(renderMd('> 引用\n> 第二行')).toBe('<blockquote><p>引用</p><p>第二行</p></blockquote>')
    expect(renderMd('---')).toBe('<hr>')
    expect(renderMd('***')).toBe('<hr>')
    expect(renderMd('段落1\n\n段落2')).toBe('<p>段落1</p><p>段落2</p>')
  })

  it('有序列表：`1.` / `1)` 起头才算，正文里的数字句不被吞', () => {
    expect(renderMd('1. a\n2. **b**\n3. `c`')).toBe('<ol><li>a</li><li><b>b</b></li><li><code>c</code></li></ol>')
    expect(renderMd('1) a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>')
    // 数字后没有「. 或 ) + 空格」的不是列表（净买入 1.5 BTC / 2026. 10 这类句子）
    expect(renderMd('1.5 BTC')).toBe('<p>1.5 BTC</p>')
    expect(renderMd('2026. 10 月')).toBe('<p>2026. 10 月</p>')
    // 列表与后续段落互不干扰
    expect(renderMd('1. a\n\n段落')).toBe('<ol><li>a</li></ol><p>段落</p>')
  })

  it('表格需「表头 + 分隔行」才成立，单元格去空白并支持行内标记', () => {
    const src = '| A | B |\n|---|---|\n| 1 | **2** |\n| 3 | 4 |'
    expect(renderMd(src)).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>' +
      '<tr><td>1</td><td><b>2</b></td></tr><tr><td>3</td><td>4</td></tr></tbody></table>')
    expect(renderMd('| A | B |')).toBe('<p>| A | B |</p>') // 缺分隔行按普通段落
  })

  it('链接与图片按 URL 白名单渲染，javascript: 等协议降级为纯文本', () => {
    expect(renderMd('[文档](https://x.dev/a)')).toBe(
      '<p><a href="https://x.dev/a" target="_blank" rel="noreferrer">文档</a></p>')
    expect(renderMd('[带标题](https://x.dev "t")')).toBe(
      '<p><a href="https://x.dev" target="_blank" rel="noreferrer">带标题</a></p>')
    expect(renderMd('![图](/a/b.png)')).toBe(
      '<p><img class="md-img" src="/a/b.png" alt="图" loading="lazy"></p>')
    expect(renderMd('![d](data:image/png;base64,AAA)')).toContain('src="data:image/png;base64,AAA"')
    // 不在白名单的协议不生成链接/图片，原样文本（同时仍被 HTML 转义）
    expect(renderMd('[x](javascript:alert)')).toBe('<p>[x](javascript:alert)</p>')
    expect(renderMd('[x](vbscript:evil)')).toBe('<p>[x](vbscript:evil)</p>')
  })

  it('空输入返回空串；fmtTime 与状态标签常量', () => {
    expect(renderMd('')).toBe('')
    expect(renderMd(null)).toBe('')
    expect(renderMd(undefined)).toBe('')
    expect(fmtTime('')).toBe('—')
    expect(fmtTime('2026-09-13 10:00')).toBe('2026-09-13 10:00')
    expect(ST_LABEL.queued).toBe('排队中')
    expect(ST_LABEL.running).toBe('运行中')
    expect(ST_LABEL.done).toBe('已完成')
  })
})

// 路径链接化（opts.pathLinks）：会话详情页把回答里的文件路径渲染成可点链接，
// 其余调用方（看板描述/评论）不传该选项，渲染结果与旧版逐字符一致。
describe('renderMd pathLinks', () => {
  it('默认不链接化；开启后正文路径变 md-path 链接', () => {
    expect(renderMd('已更新 doc_ai/x.md')).toBe('<p>已更新 doc_ai/x.md</p>')
    expect(renderMd('已更新 doc_ai/x.md', { pathLinks: true })).toBe(
      '<p>已更新 <a class="md-path" data-path="doc_ai/x.md" ' +
      'title="点击预览：doc_ai/x.md">doc_ai/x.md</a></p>')
  })

  it('标题/列表/表格单元格同样链接化', () => {
    expect(renderMd('## 见 doc_ai/x.md', { pathLinks: true })).toContain('data-path="doc_ai/x.md"')
    expect(renderMd('- doc_ai/x.md', { pathLinks: true })).toContain('data-path="doc_ai/x.md"')
    expect(renderMd('| a |\n|---|\n| doc_ai/x.md |', { pathLinks: true }))
      .toContain('data-path="doc_ai/x.md"')
  })

  it('围栏代码块内不做路径链接化', () => {
    const h = renderMd('```\ncat doc_ai/x.md\n```', { pathLinks: true })
    expect(h).toBe('<pre><code>cat doc_ai/x.md</code></pre>')
  })

  it('内联 code 内的路径与裸文件名可点（属性访问不误伤）', () => {
    const h = renderMd('见 `doc_ai/x.md` 与 `verify.py` 与 `sys.path`', { pathLinks: true })
    expect(h).toContain('<code><a class="md-path" data-path="doc_ai/x.md"')
    expect(h).toContain('<a class="md-path" data-path="verify.py"')
    expect(h).toContain('<code>sys.path</code>')
  })

  it('既有链接/图片的 URL 不被路径链接化（不产生嵌套锚点）', () => {
    expect(renderMd('[文档](https://x.dev/a/b.md)', { pathLinks: true })).toBe(
      '<p><a href="https://x.dev/a/b.md" target="_blank" rel="noreferrer">文档</a></p>')
    expect(renderMd('![图](/a/b.png)', { pathLinks: true })).toBe(
      '<p><img class="md-img" src="/a/b.png" alt="图" loading="lazy"></p>')
    // 链接文本里的路径同样不重复链接化
    expect(renderMd('[doc_ai/x.md](https://x.dev)', { pathLinks: true })).toBe(
      '<p><a href="https://x.dev" target="_blank" rel="noreferrer">doc_ai/x.md</a></p>')
  })
})
