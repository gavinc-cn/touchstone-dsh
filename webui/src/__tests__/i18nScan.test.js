// 未翻译中文串扫描器单测 + 覆盖率 ratchet 守卫
//   口径：含汉字且不在 t(...) 实参位置的「字符串字面量」（literal）与「JSX 正文文本节点」
//   （jsx）都算未包装；注释里的中文不算；纯 ASCII 不算。
//   T7 起全仓迁移完成：基线归零（unwrapped/literals/jsxText 都必须是 0），另保留**文档化
//   例外**（文件 + 原文精确匹配，单列 exceptions 并附理由，不计入未翻译）。本测试同时守住
//   「扫描器没坏」——扫描根必须是 webui/src、待扫文件数钉死 81（T7 终态 80 + T8 新增
//   utils/dataLabels.js）、t() 键提取非空，防止扫描器返回空结果或扫描根被收窄后仍然假绿。
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOCUMENTED_EXCEPTIONS, IGNORE_PATHS, SRC_DIR as SCAN_SRC_DIR, listSourceFiles, scanProject,
  scanProjectWrappedKeys, scanSource,
} from '../../scripts/i18n-scan.mjs'

// webui/ 根：本测试位于 webui/src/__tests__/，上溯两级
const WEBUI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// needle 首次出现处的 1 基行列（测试断言用，避免手算列号）
function at(code, needle) {
  const idx = code.indexOf(needle)
  if (idx < 0) throw new Error(`fixture 缺少 ${needle}`)
  const lines = code.slice(0, idx).split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

// 单条扫描结果的完整期望形状：{line, column, text, kind}
function entry(code, needle, text, kind) {
  return { ...at(code, needle), text, kind }
}

describe('i18nScan.scanSource：字符串字面量', () => {
  it('裸中文字符串字面量算作未包装（literal，带行号/列号）', () => {
    const code = "const a = '保存'"
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toHaveLength(1)
    expect(r.unwrapped).toEqual([entry(code, "'保存'", '保存', 'literal')])
  })

  it('t(...) 实参里的中文串算作已包装', () => {
    const r = scanSource("const a = t('保存')")
    expect(r.wrapped).toEqual(['保存'])
    expect(r.unwrapped).toEqual([])
  })

  it('注释里的中文串被忽略（行注释与块注释）', () => {
    const r = scanSource("// 行注释：保存\n/* 块注释：删除 */\nconst a = 'save'")
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([])
  })

  it('纯 ASCII 字符串字面量不计数', () => {
    const r = scanSource("const a = 'save'; const b = `name`; const c = \"ok\"")
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([])
  })

  it('notify/format 里的中文串仍算未包装（t 必须是独立标识符）', () => {
    const code = "notify('已保存'); format('共 2 张')"
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toHaveLength(2)
    expect(r.unwrapped).toEqual([
      entry(code, "'已保存'", '已保存', 'literal'),
      entry(code, "'共 2 张'", '共 2 张', 'literal'),
    ])
  })
})

describe('i18nScan.scanSource：JSX 正文文本节点', () => {
  it('JSX 正文里的中文文本算作 jsx（与字面量并列计数）', () => {
    const code = 'const a = <span>保存</span>'
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toHaveLength(1)
    expect(r.unwrapped).toEqual([entry(code, '保存', '保存', 'jsx')])
  })

  it('JS 字符串/模板串里的 HTML 文本不算 jsx（不重复计数）', () => {
    const code = "const a = t('<div>请求</div>')\nconst b = `<div>保存</div>`"
    const r = scanSource(code)
    expect(r.wrapped).toEqual(['<div>请求</div>'])
    expect(r.unwrapped).toHaveLength(1)
    // 模板串里的 HTML 仍按字面量统计（kind=literal），绝不再算一次 jsx
    expect(r.unwrapped).toEqual([
      entry(code, '`<div>保存</div>`', '<div>保存</div>', 'literal'),
    ])
    expect(r.unwrapped.filter((e) => e.kind === 'jsx')).toHaveLength(0)
  })

  it('纯 ASCII 的 JSX 正文不计数', () => {
    const r = scanSource('const a = <span>Save</span>')
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([])
  })

  it('含 { } 的 JSX 正文按保守口径整段跳过', () => {
    const r = scanSource('const a = <span>保存 {n} 张</span>')
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([])
  })

  it('多行 JSX 正文取首个非空白字符的行列', () => {
    const code = 'const a = (\n  <div>\n    保存\n  </div>\n)'
    const r = scanSource(code)
    expect(r.unwrapped).toHaveLength(1)
    expect(r.unwrapped).toEqual([entry(code, '保存', '保存', 'jsx')])
  })

  it('字面量与 JSX 混排时按 (line, column) 排序', () => {
    const code = "const a = <span>保存</span>\nconst b = '删除'\nconst c = <b>取消</b>"
    const r = scanSource(code)
    expect(r.unwrapped).toHaveLength(3)
    expect(r.unwrapped.map((e) => [e.line, e.kind])).toEqual([
      [1, 'jsx'],
      [2, 'literal'],
      [3, 'jsx'],
    ])
    expect(r.unwrapped).toEqual([
      entry(code, '保存', '保存', 'jsx'),
      entry(code, "'删除'", '删除', 'literal'),
      entry(code, '取消', '取消', 'jsx'),
    ])
  })
})

describe('i18nScan.scanSource：注释/正则与 JSX 正文边界', () => {
  it('字符串里的 /* 不开启注释，其后的中文字面量照常计数', () => {
    // glob 出现在字符串里时，词法器的注释判定必须先认出引号串
    const code = "const p = 'extensions/*/asset.json'\nconst a = '保存'"
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([entry(code, "'保存'", '保存', 'literal')])
  })

  it('JSX 正文里的 /* 与后续标签按正文处理，不吞掉后面的中文正文', () => {
    // 对应 AssetsPanel.jsx 的真实布局：glob 在 JSX 正文里，前后都有中文正文
    const code =
      '<div>安装平台内置资产（清单 = 仓库 <span>extensions/*/asset.json</span>），两类：<span>技能文件</span></div>'
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([
      entry(code, '安装平台内置资产', '安装平台内置资产（清单 = 仓库', 'jsx'),
      entry(code, '），两类：', '），两类：', 'jsx'),
      entry(code, '技能文件', '技能文件', 'jsx'),
    ])
  })

  it('JSX 正文里的撇号/引号按文本处理，不再伪造出 literal', () => {
    const code = "<p>Don't 保存 'x' here</p>"
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([
      entry(code, "Don't 保存", "Don't 保存 'x' here", 'jsx'),
    ])
  })

  it('汉字后的 / 按除号处理，不吞掉后续 title 属性里的中文', () => {
    const code = '<div>是/否 <span title="保存">x</span></div>'
    const r = scanSource(code)
    expect(r.wrapped).toEqual([])
    expect(r.unwrapped).toEqual([
      entry(code, '是/否', '是/否', 'jsx'),
      entry(code, '"保存"', '保存', 'literal'),
    ])
  })
})

describe('i18nScan.IGNORE_PATHS：内容解析/协议文件整文件排除', () => {
  it('清单只含已核对的内容解析/协议文件（含真实展示文案的不得收录）', () => {
    expect(IGNORE_PATHS).toEqual([
      'utils/media.js',
      'utils/mediaText.js',
      'utils/slashToken.js',
      'lib/dshHost.js',
    ])
    // pathLink 的链接 title 是真实展示文案，已 t() 迁移，不得作为忽略项
    expect(IGNORE_PATHS).not.toContain('utils/pathLink.js')
  })

  it('忽略路径下的 CJK 不计入未包装（同一份 fixture，对照文件照常计数）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-ignore-'))
    try {
      fs.mkdirSync(path.join(root, 'utils'), { recursive: true })
      fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
      fs.writeFileSync(path.join(root, 'utils', 'media.js'), "export const a = '保存'\n")
      fs.writeFileSync(path.join(root, 'lib', 'dshHost.js'), "export const b = '删除'\n")
      fs.writeFileSync(path.join(root, 'utils', 'other.js'), "export const c = '取消'\n")
      const r = scanProject(root)
      expect(r.files.map((f) => f.file)).toEqual(['utils/other.js'])
      expect(r.files[0].text).toBe('取消')
      expect(r.unwrapped).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('i18nScan 文档化例外机制', () => {
  it('按（文件 + 原文）精确匹配：只剔除清单内的那一条，同原文的其它文件照常计数', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-exc-'))
    try {
      fs.mkdirSync(path.join(root, 'views'), { recursive: true })
      fs.mkdirSync(path.join(root, 'components'), { recursive: true })
      // 与 DOCUMENTED_EXCEPTIONS 的文件 + 原文一致 ⇒ 进 exceptions，不计数
      fs.writeFileSync(path.join(root, 'views', 'Settings.jsx'), "export const a = '中文'\n")
      // 同原文但不同文件 ⇒ 不是例外，必须仍计入未翻译
      fs.writeFileSync(path.join(root, 'components', 'Other.jsx'), "export const b = '中文'\n")
      const r = scanProject(root)
      expect(r.unwrapped).toBe(1)
      expect(r.literals).toBe(1)
      expect(r.files.map((f) => f.file)).toEqual(['components/Other.jsx'])
      expect(r.exceptions.map((e) => [e.file, e.text])).toEqual([['views/Settings.jsx', '中文']])
      expect(typeof r.exceptions[0].reason).toBe('string')
      expect(r.exceptions[0].reason.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('例外清单本身就是终态：只有已评审的 Settings 语言自称，且理由非空', () => {
    expect(DOCUMENTED_EXCEPTIONS).toHaveLength(1)
    expect(DOCUMENTED_EXCEPTIONS[0].file).toBe('views/Settings.jsx')
    expect(DOCUMENTED_EXCEPTIONS[0].text).toBe('中文')
    expect(DOCUMENTED_EXCEPTIONS[0].reason.length).toBeGreaterThan(10)
  })
})

describe('i18nScan 项目基线（零残留 ratchet）', () => {
  const SRC_DIR = path.join(WEBUI_DIR, 'src')

  it('扫描器自检：扫描根 = webui/src、待扫文件数恒定、t() 键提取非空（防扫描器坏掉/扫描根收窄造成假绿）', () => {
    // 扫描根钉死：CLI/scanProject 的默认根必须就是本测试的 webui/src。
    // 只断言「文件数 > 0」时，把根目录收窄（如只扫 components/）仍会绿。
    expect(SCAN_SRC_DIR).toBe(SRC_DIR)
    const files = listSourceFiles(SCAN_SRC_DIR)
    // 文件数钉死（T7 迁移终态 80 + T8 新增 utils/dataLabels.js = 81 个源文件
    // + 卡 #1088 新增 components/ImageViewer.jsx = 82
    // + 会话详情页小分辨率自适应新增 utils/rzClamp.js = 83；
    // 新增/删除源文件需同步更新本断言）
    expect(files).toHaveLength(83)
    // 每个顶层源码目录都必须有文件进入清单：某个目录整体消失（遍历被打断/根被收窄）立即失败
    for (const sentinel of [
      'App.jsx', 'api/index.js', 'components/TasksTab.jsx', 'hooks/useDshHost.js',
      'lib/lastRoute.js', 'stores/app.js', 'utils/loadMetrics.js', 'views/Settings.jsx',
    ]) {
      expect(files).toContain(sentinel)
    }
    expect(scanProjectWrappedKeys(SCAN_SRC_DIR).length).toBeGreaterThan(0)
  })

  it('未包装中文串归零、例外单列且与基线一致', () => {
    // 子进程跑 CLI：与人工/CI 用的入口完全一致（cwd=webui/）
    const out = execFileSync(process.execPath, ['scripts/i18n-scan.mjs', '--json'], {
      cwd: WEBUI_DIR,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    const result = JSON.parse(out)
    // 形状与自洽：files 明细条数 = 总量 = literals + jsxText
    expect(Array.isArray(result.files)).toBe(true)
    expect(result.files.length).toBe(result.unwrapped)
    expect(result.literals + result.jsxText).toBe(result.unwrapped)
    expect(result.files.every((f) => f.kind === 'literal' || f.kind === 'jsx')).toBe(true)
    // 归零：T7 是最后一批迁移，三种计数都必须严格等于 0（不是「不超过基线」的含糊语义）
    expect(result.unwrapped).toBe(0)
    expect(result.literals).toBe(0)
    expect(result.jsxText).toBe(0)
    // 例外：逐条等于文档化清单（文件 + 原文），并带理由；例外数量不得悄悄增长
    expect(result.exceptions.map((e) => ({ file: e.file, text: e.text })))
      .toEqual(DOCUMENTED_EXCEPTIONS.map((e) => ({ file: e.file, text: e.text })))
    expect(result.exceptions.every((e) => typeof e.reason === 'string' && e.reason.length > 0))
      .toBe(true)
    // 基线：零残留 + 例外数固定；与本次扫描逐项一致
    const baseline = JSON.parse(
      fs.readFileSync(path.join(WEBUI_DIR, 'scripts/i18n-baseline.json'), 'utf8'),
    )
    expect(baseline).toEqual({ unwrapped: 0, literals: 0, jsxText: 0, exceptions: 1 })
    expect(baseline.unwrapped).toBe(result.unwrapped)
    expect(baseline.literals).toBe(result.literals)
    expect(baseline.jsxText).toBe(result.jsxText)
    expect(baseline.exceptions).toBe(result.exceptions.length)
  })
})
