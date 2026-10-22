import { describe, it, expect } from 'vitest'
import { dirCanGoUp, dirPathText, dirUpTitle, dirRootHint } from '../utils/dirNav'

// 目录选择弹窗「上级」三态（2026-10-22 卡 1044）：普通目录 / 文件系统根（parent 空串）/
// 根视角（parent null）。根视角在 Windows 下是盘符列表（此电脑）。
const NORMAL = { platform: 'windows', path: 'D:\\own\\proj', parent: 'D:\\own', dirs: [] }
const DRIVE_ROOT = { platform: 'windows', path: 'D:\\', parent: '', dirs: [] }
const WIN_ROOTS = { platform: 'windows', path: '', parent: null, dirs: [
  { name: 'C:\\', path: 'C:\\' }, { name: 'D:\\', path: 'D:\\' }] }
const POSIX_ROOT = { platform: 'linux', path: '/', parent: '', dirs: [] }
const POSIX_ROOTS = { platform: 'linux', path: '', parent: null,
  dirs: [{ name: '/', path: '/' }] }

describe('dirCanGoUp：「上级」可点口径', () => {
  it('普通目录与文件系统根可点（根 → 根视角）', () => {
    expect(dirCanGoUp(NORMAL)).toBe(true)
    expect(dirCanGoUp(DRIVE_ROOT)).toBe(true)
    expect(dirCanGoUp(POSIX_ROOT)).toBe(true)
  })

  it('根视角 / 未加载时不可点', () => {
    expect(dirCanGoUp(WIN_ROOTS)).toBe(false)
    expect(dirCanGoUp(POSIX_ROOTS)).toBe(false)
    expect(dirCanGoUp(null)).toBe(false)
    expect(dirCanGoUp(undefined)).toBe(false)
  })
})

describe('dirPathText：路径行文本', () => {
  it('有 path 显示路径本身（盘符根显示 D:\\）', () => {
    expect(dirPathText(NORMAL)).toBe('D:\\own\\proj')
    expect(dirPathText(DRIVE_ROOT)).toBe('D:\\')
    expect(dirPathText(POSIX_ROOT)).toBe('/')
  })

  it('根视角：Windows 显示盘符列表标题，其它平台显示根目录', () => {
    expect(dirPathText(WIN_ROOTS)).toBe('此电脑（选择盘符）')
    expect(dirPathText(POSIX_ROOTS)).toBe('根目录')
  })

  it('未加载返回空串（调用方给占位文案）', () => {
    expect(dirPathText(null)).toBe('')
  })
})

describe('dirUpTitle：「上级」按钮 title', () => {
  it('文件系统根：Windows 说明返回盘符列表，Linux 说明返回根目录', () => {
    expect(dirUpTitle(DRIVE_ROOT)).toBe('返回盘符列表')
    expect(dirUpTitle(POSIX_ROOT)).toBe('返回根目录')
  })

  it('普通目录/根视角/未加载均为「上级目录」', () => {
    expect(dirUpTitle(NORMAL)).toBe('上级目录')
    expect(dirUpTitle(WIN_ROOTS)).toBe('上级目录')
    expect(dirUpTitle(null)).toBe('上级目录')
  })
})

describe('dirRootHint：根视角提示', () => {
  it('Windows 根视角给「进入盘符后可选择盘符根目录」提示', () => {
    expect(dirRootHint(WIN_ROOTS)).toContain('盘符')
  })

  it('非 Windows 根视角、以及非根视角都不出提示', () => {
    expect(dirRootHint(POSIX_ROOTS)).toBe('')
    expect(dirRootHint(DRIVE_ROOT)).toBe('')
    expect(dirRootHint(NORMAL)).toBe('')
    expect(dirRootHint(null)).toBe('')
  })
})
