// KB-16：卡片标题**显示**映射（英文 UI 不再露出中文规范占位「未命名」）
//   不变量：① 落库规范值仍是中文「未命名」（数据与界面语言无关，en 界面保存也落中文）；
//   ② 只有显示层经过 displayTitle；③ zh 下 displayTitle 逐字节等于原值（zh 零 churn）。
//   另加显示路径守卫：三个看板组件必须经 displayTitle 渲染标题，禁止回退成裸
//   `x.title || t('未命名')`（那会绕过映射、在英文界面露出中文）。
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { displayTitle, UNTITLED_TITLE, setLang, DEFAULT_LANG } from '../utils/i18n'

// webui/src：本测试位于 webui/src/__tests__/，上溯一级
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

afterEach(() => setLang(DEFAULT_LANG))

describe('displayTitle：卡片标题显示映射（KB-16）', () => {
  it('canonical 占位值仍是中文「未命名」（与界面语言无关）', () => {
    expect(UNTITLED_TITLE).toBe('\u672a\u547d\u540d')
  })

  it('zh 下逐字节不变（占位/空/未定义/真实标题）', () => {
    setLang('zh')
    expect(displayTitle(UNTITLED_TITLE)).toBe('未命名')
    expect(displayTitle('')).toBe('未命名')
    expect(displayTitle(undefined)).toBe('未命名')
    expect(displayTitle(null)).toBe('未命名')
    expect(displayTitle('修 bug')).toBe('修 bug')
  })

  it('en 下规范占位显示 Untitled，空值同占位，真实标题原样', () => {
    setLang('en')
    expect(displayTitle(UNTITLED_TITLE)).toBe('Untitled')
    expect(displayTitle('')).toBe('Untitled')
    expect(displayTitle(undefined)).toBe('Untitled')
    expect(displayTitle('Fix bug')).toBe('Fix bug')
  })

  it('只认中文规范占位：用户真实标题「Untitled」不被二次映射（en 原样）', () => {
    setLang('en')
    expect(displayTitle('Untitled')).toBe('Untitled')
  })

  it('语言切换即时生效（同一函数，按当前语言渲染）', () => {
    setLang('en')
    expect(displayTitle(UNTITLED_TITLE)).toBe('Untitled')
    setLang('zh')
    expect(displayTitle(UNTITLED_TITLE)).toBe('未命名')
  })
})

describe('KB-16 显示路径守卫：组件经 displayTitle 渲染标题，不许裸兜底', () => {
  const FILES = [
    'components/BoardTab.jsx',
    'components/BoardDetail.jsx',
    'components/BoardTrash.jsx',
  ]
  for (const rel of FILES) {
    it(`${rel} 使用 displayTitle 且无「.title || t('未命名')」裸兜底`, () => {
      const code = fs.readFileSync(path.join(SRC, rel), 'utf8')
      expect(code).toContain('displayTitle(')
      expect(code).not.toMatch(/\.title \|\| t\('未命名'\)/)
    })
  }

  it('BoardDetail 的入库路径仍写 canonical UNTITLED_TITLE（不能写译文）', () => {
    const code = fs.readFileSync(path.join(SRC, 'components/BoardDetail.jsx'), 'utf8')
    expect(code).toContain('|| UNTITLED_TITLE')
    expect(code).toMatch(/import \{[^}]*UNTITLED_TITLE[^}]*\} from '\.\.\/utils\/i18n'/)
  })

  it('BoardTab 打回弹窗标题也经 displayTitle（canonical 占位不许裸插值）', () => {
    // KB-16 评审 F1：`t('打回「{title}」', { title: rejectFor?.title })` 曾漏接映射，
    // en 下会显示 `Send back "未命名"`。空标题（falsy）仍保留旧字面量，避免 zh 变化。
    const code = fs.readFileSync(path.join(SRC, 'components/BoardTab.jsx'), 'utf8')
    expect(code).toContain('displayTitle(rejectFor')
    expect(code).not.toMatch(/\{\s*title:\s*rejectFor\?\.title\s*\}/)
  })

  it('BoardDetail 会话弹窗：空标题保留旧回落，canonical 占位经 displayTitle', () => {
    // KB-16 评审 F2：旧行为是空标题 → SessionModal 回落到 sid；canonical「未命名」才需要映射。
    const code = fs.readFileSync(path.join(SRC, 'components/BoardDetail.jsx'), 'utf8')
    expect(code).toContain('title: card.title ? displayTitle(card.title) : card.title')
  })
})
