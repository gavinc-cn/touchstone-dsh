// t() 字面量键覆盖率守卫：源码里每个 t('…') 的 key 都必须在 i18n/en.json 的 web
// 命名空间有词条。
//
// 为什么需要本守卫：未翻译扫描器（i18nScan）只统计「含汉字」的串——像 '：'、
// '（{header}）：' 这类纯标点键不会被它计数，英文界面会直接露出中文全角标点。
// 本守卫按 t() 实参逐键核对词表，不再以「有没有汉字」为判据，因此能覆盖标点键、
// 纯符号键和「汉字 + 占位符」键。
//
// 提取口径与扫描器共用同一套词法（scripts/i18n-scan.mjs 的 scanProjectWrappedKeys）：
//   - 只认裸 t( 的第一个实参位置的字符串字面量（单/双引号），不认 obj.t( / notify(；
//   - 模板串（含 ${...}）与 t('a' + b) 这类动态拼接跳过（无法静态比对，宁可漏计）；
//   - JS 转义（\n 等）还原后再比对（词表 key 里的换行是真实换行）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProjectWrappedKeys, scanWrappedKeys } from '../../scripts/i18n-scan.mjs'

// webui/ 根：本测试位于 webui/src/__tests__/，上溯两级
const WEBUI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// 词表单一真源：仓库根 i18n/en.json（webui/ 之外）
const EN_JSON = path.resolve(WEBUI_DIR, '../i18n/en.json')

// 读取 en 词表（web 命名空间）
function enWeb() {
  const dict = JSON.parse(fs.readFileSync(EN_JSON, 'utf8'))
  return dict.web || {}
}

// 纯比较：返回词表里缺失的 key（按出现顺序去重）。正向守卫与负向对照共用，
// 保证「能失败」的证明走的是与真实守卫完全相同的判定逻辑。
function missingKeys(entries, web) {
  const keys = [...new Set((entries || []).map((e) => e.key))]
  return keys.filter((k) => !Object.prototype.hasOwnProperty.call(web, k))
}

describe('t() 字面量键提取', () => {
  it('提取含标点/纯符号的键，跳过动态拼接与模板串', () => {
    const code = [
      "const a = t('保存')",
      "const b = t('：')",
      "const c = t('（{header}）：', { header: h })",
      "const d = t('a' + rest)",
      'const e = t(`模板 ${x}`)',
    ].join('\n')
    expect(scanWrappedKeys(code).map((e) => e.key)).toEqual(['保存', '：', '（{header}）：'])
  })

  it('还原 JS 字符串转义后再比对（\\n 等与词表 key 一致）', () => {
    expect(scanWrappedKeys("const a = t('第一行\\n第二行')")[0].key).toBe('第一行\n第二行')
    expect(scanWrappedKeys("const b = t('it\\'s')")[0].key).toBe("it's")
  })
})

describe('t() 字面量键覆盖率（i18n/en.json）', () => {
  it('源码中每个 t() 字面量键都有 en 词条', () => {
    const entries = scanProjectWrappedKeys(path.join(WEBUI_DIR, 'src'))
    const missing = missingKeys(entries, enWeb())
    // 失败时逐键列出首次出现位置，便于直接补词条/修 key
    const detail = missing
      .map((k) => {
        const at = entries.find((e) => e.key === k)
        return `  ${JSON.stringify(k)} ← ${at ? `${at.file}:${at.line}` : '?'}`
      })
      .join('\n')
    expect(missing, `缺失 ${missing.length} 个 en 词条：\n${detail}`).toEqual([])
  })

  it('负向对照：fixture 里未登记的标点键会被判为缺失（守卫能失败）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-key-'))
    try {
      fs.mkdirSync(path.join(root, 'components'), { recursive: true })
      fs.writeFileSync(path.join(root, 'components', 'Fixture.jsx'),
        "const a = t('：')\nconst b = t('已登记')\n")
      const entries = scanProjectWrappedKeys(root)
      expect(entries.map((e) => e.key)).toEqual(['：', '已登记'])
      // 词表故意只登记一个：守卫必须点名缺 '：'（旧扫描器因无汉字会漏掉这个键）
      expect(missingKeys(entries, { 已登记: 'Registered' })).toEqual(['：'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
