// utils/queueRestore.js 单测（2026-10-17「取消排队」）：可取消判定 + 原文回填合并 +
// 提示文案三格。纯函数层——状态接线（SessionView 的 setInput/清 chip）不在本层。
//
// 为什么这几条要钉死：用户报障的预期就是「取消的消息应重新显示在输入框中」，而回填的
// 边界（空输入框不留前导换行、有草稿不覆盖、批量按序连接、空白段丢弃）一旦写错，
// 用户丢的是**自己刚打的字**——比原 bug 更糟。
import { describe, expect, it } from 'vitest'

import {
  RESTORE_SEP, cancelQueueToast, cancellableRow, mergeRestoreText,
} from '../utils/queueRestore'

describe('cancellableRow：只有平台排队行可取消', () => {
  it('queued / pending（乐观 chip）带 msgId ⇒ 可取消', () => {
    expect(cancellableRow({ msgId: 'm1', state: 'queued' })).toBe(true)
    expect(cancellableRow({ msgId: 'm1', state: 'pending' })).toBe(true)
  })

  it('dsh 宿主 inbox 行（server，无 msgId）⇒ 不可取消（平台撤不掉宿主队列）', () => {
    expect(cancellableRow({ msgId: '', state: 'server' })).toBe(false)
    expect(cancellableRow({ state: 'server' })).toBe(false)
  })

  it('执行中（running）与残缺行 ⇒ 不可取消', () => {
    expect(cancellableRow({ msgId: 'm1', state: 'running' })).toBe(false)
    expect(cancellableRow({ msgId: 'm1' })).toBe(false)
    expect(cancellableRow(null)).toBe(false)
    expect(cancellableRow(undefined)).toBe(false)
  })
})

describe('mergeRestoreText：原文回填输入框', () => {
  it('输入框为空 ⇒ 就是原文（不加前导/尾随换行）', () => {
    expect(mergeRestoreText('', ['你好'])).toBe('你好')
    expect(mergeRestoreText(null, ['你好'])).toBe('你好')
    expect(mergeRestoreText('   ', ['你好'])).toBe('你好')
  })

  it('输入框有草稿 ⇒ 追加在末尾，草稿一字不动（尾随空白折叠）', () => {
    expect(mergeRestoreText('草稿', ['原文'])).toBe(`草稿${RESTORE_SEP}原文`)
    expect(mergeRestoreText('草稿\n\n', ['原文'])).toBe(`草稿${RESTORE_SEP}原文`)
  })

  it('批量取消 ⇒ 按入队顺序用空行连接', () => {
    expect(mergeRestoreText('', ['一', '二', '三'])).toBe('一\n\n二\n\n三')
  })

  it('空串/纯空白段被丢弃；没有可回填内容时原样返回草稿', () => {
    expect(mergeRestoreText('', ['', '  ', '有内容'])).toBe('有内容')
    expect(mergeRestoreText('草稿', ['', '   '])).toBe('草稿')
    expect(mergeRestoreText('草稿', [])).toBe('草稿')
    expect(mergeRestoreText('草稿', null)).toBe('草稿')
  })

  it('多行消息原样保留（只做段间连接，不动段内换行）', () => {
    expect(mergeRestoreText('', ['第一行\n第二行'])).toBe('第一行\n第二行')
  })
})

describe('cancelQueueToast：如实说明取消结果', () => {
  it('cancelled=0 ⇒ 说明已不在排队中（不假装成功）', () => {
    expect(cancelQueueToast(0, true)).toContain('已不在排队中')
    expect(cancelQueueToast(0, false)).toContain('已不在排队中')
  })

  it('单条 / 批量两口径都点明原文已回到输入框', () => {
    expect(cancelQueueToast(1, true)).toBe('已取消排队，原文已放回输入框')
    expect(cancelQueueToast(3, false)).toBe('已取消 3 条排队消息，原文已放回输入框')
  })
})
