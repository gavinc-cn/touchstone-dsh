import { describe, expect, it } from 'vitest'
import { hasCrossUserDuplicate } from '../utils/dupCheck'

describe('hasCrossUserDuplicate', () => {
  it('同用户重复 ⇒ 不阻断（保持提醒可保存）', () => {
    expect(hasCrossUserDuplicate([{ username: 'admin' }], 'admin')).toBe(false)
  })
  it('他人重复 ⇒ 阻断', () => {
    expect(hasCrossUserDuplicate([{ username: 'bob' }], 'admin')).toBe(true)
  })
  it('混合冲突 ⇒ 阻断（后端本来也保存不了）', () => {
    expect(hasCrossUserDuplicate([{ username: 'admin' }, { username: 'bob' }], 'admin')).toBe(true)
  })
  it('空/非法输入不阻断', () => {
    expect(hasCrossUserDuplicate(null, 'admin')).toBe(false)
    expect(hasCrossUserDuplicate([null, {}], 'admin')).toBe(false)
  })
})
