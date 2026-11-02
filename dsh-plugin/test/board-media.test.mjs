// board_media 图片引用扫描（纯函数，2026-10-29）：
//   平台（飞书截图接收 / 站点会话窗附件）把图片写成 markdown 绝对路径投递给会话；
//   DSH 用户气泡是纯文本渲染、只认原生 image 块，故插件驱动在投递口把这类引用
//   重新识别出来交给宿主 attachments 服务转成原生附件。本文件只钉**纯函数**的
//   识别边界：哪类引用算平台图片、哪种写法必须原样保留、代码块/行内代码不外溢。
//
// 为什么单独测纯函数：真正的转换（读写文件、attachments 服务、模型能力）在
// `scripts/dev-check-driver.mjs` 里用桩端到端跑；这里钉边界，改动时秒级定位。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanBoardMediaImages, isBoardMediaImageRef } from '../lib/board-media.js'

const DIR = '/opt/win/touchstone_projects/demo/board_media'
const PNG = `${DIR}/m1700000000000_abcdef0123.png`
const JPG = `${DIR}/m1700000000001_0123456789.jpg`

describe('isBoardMediaImageRef', () => {
  it('接受平台落盘的 board_media 位图绝对路径', () => {
    assert.equal(isBoardMediaImageRef(PNG), true)
    assert.equal(isBoardMediaImageRef(JPG), true)
    assert.equal(isBoardMediaImageRef(`${DIR}/m1700000000000_0123456789.webp`), true)
    assert.equal(isBoardMediaImageRef(`${DIR}/m1700000000000_0123456789.gif`), true)
    assert.equal(isBoardMediaImageRef(`${DIR}/m1700000000000_0123456789.PNG`), true)
  })

  it('接受 Windows 盘符/UNC 路径（插件也跑在 Windows）', () => {
    assert.equal(isBoardMediaImageRef('C:\\proj\\.touchstone\\board_media\\m1700000000000_0123456789.png'), true)
    assert.equal(isBoardMediaImageRef('\\\\server\\share\\board_media\\m1700000000000_0123456789.jpg'), true)
  })

  it('拒绝 URL、相对路径、非 board_media、非位图扩展名', () => {
    assert.equal(isBoardMediaImageRef('https://x.test/board_media/m1700000000000_0123456789.png'), false)
    assert.equal(isBoardMediaImageRef('file:///opt/win/board_media/m1700000000000_0123456789.png'), false)
    assert.equal(isBoardMediaImageRef('board_media/m1700000000000_0123456789.png'), false)
    assert.equal(isBoardMediaImageRef('/opt/win/projects/board_media/shot.png'), false)
    assert.equal(isBoardMediaImageRef(`${DIR}/m1700000000000_0123456789.svg`), false)
    assert.equal(isBoardMediaImageRef(`${DIR}/m1700000000000_0123456789.bmp`), false)
    assert.equal(isBoardMediaImageRef(`${DIR}/m1700000000000_0123456789.png.bak`), false)
    assert.equal(isBoardMediaImageRef(''), false)
    assert.equal(isBoardMediaImageRef(null), false)
  })
})

describe('scanBoardMediaImages', () => {
  it('飞书截图：保留 header、去掉图片行、名字取 alt', () => {
    const text = [
      '[飞书截图] 用户从飞书发送了 1 张截图：',
      `![飞书截图1.jpg](${JPG})`,
    ].join('\n')
    const r = scanBoardMediaImages(text)
    assert.deepEqual(r.images.map((i) => i.path), [JPG])
    assert.equal(r.images[0].name, '飞书截图1.jpg')
    assert.equal(r.kept, '[飞书截图] 用户从飞书发送了 1 张截图：')
    assert.equal(r.reason, 'ok')
  })

  it('站点会话窗：图片夹在文字中间也能转，且不留双空格', () => {
    const r = scanBoardMediaImages(`看这个 ![image.png](${PNG}) 怎么修`)
    assert.deepEqual(r.images.map((i) => i.path), [PNG])
    assert.equal(r.images[0].name, 'image.png')
    assert.equal(r.kept, '看这个 怎么修')
  })

  it('一张纯图片消息：kept 为空串（调用方据此只发 image 块）', () => {
    const r = scanBoardMediaImages(`![image.png](${PNG})`)
    assert.equal(r.images.length, 1)
    assert.equal(r.kept, '')
  })

  it('多张按出现顺序返回；同名路径去重但仍从正文删除', () => {
    const r = scanBoardMediaImages(`![a](${PNG})\n![b](${JPG})\n![c](${PNG})`)
    assert.deepEqual(r.images.map((i) => i.path), [PNG, JPG])
    assert.deepEqual(r.images.map((i) => i.name), ['a', 'b'])
    assert.equal(r.kept, '')
  })

  it('行首缩进保留（列表/缩进语义不被改写）', () => {
    const r = scanBoardMediaImages(`  - 看这个 ![image.png](${PNG})`)
    assert.equal(r.kept, '  - 看这个')
  })

  it('alt 为空时回落文件名', () => {
    const r = scanBoardMediaImages(`![](${PNG})`)
    assert.equal(r.images[0].name, 'm1700000000000_abcdef0123.png')
  })

  it('尖括号包裹的路径也认', () => {
    const r = scanBoardMediaImages(`![ shot ](<${PNG}>)`)
    assert.deepEqual(r.images.map((i) => i.path), [PNG])
    assert.equal(r.images[0].name, 'shot')
  })

  it('非平台图片引用一律原样保留', () => {
    for (const text of [
      `![x](/opt/win/projects/shot.png)`,
      `![x](board_media/m1700000000000_0123456789.png)`,
      `![x](https://x.test/board_media/m1700000000000_0123456789.png)`,
      `[附件](/opt/win/board_media/m1700000000000_0123456789.png)`,
    ]) {
      const r = scanBoardMediaImages(text)
      assert.equal(r.images.length, 0, text)
      assert.equal(r.kept, text, text)
      assert.equal(r.reason, 'none')
    }
  })

  it('围栏代码块里的引用不转（三反引号/三波浪号都算）', () => {
    const fenced = ['```md', `![x](${PNG})`, '```'].join('\n')
    assert.deepEqual(scanBoardMediaImages(fenced), { kept: fenced, images: [], reason: 'none' })
    const tildes = ['~~~', `![x](${PNG})`, '~~~'].join('\n')
    assert.deepEqual(scanBoardMediaImages(tildes), { kept: tildes, images: [], reason: 'none' })
    // 闭合后恢复识别
    const mixed = ['```', `![x](${PNG})`, '```', `![y](${JPG})`].join('\n')
    const r = scanBoardMediaImages(mixed)
    assert.deepEqual(r.images.map((i) => i.path), [JPG])
    assert.equal(r.kept, ['```', `![x](${PNG})`, '```'].join('\n'))
  })

  it('围栏内的 ```js 不误判为闭围栏（闭围栏只能带空白）', () => {
    const text = ['```md', '```js', `![x](${PNG})`, '```'].join('\n')
    const r = scanBoardMediaImages(text)
    assert.equal(r.images.length, 0)
    assert.equal(r.kept, text)
  })

  it('行内代码里的引用不转（反引号成对）', () => {
    const text = `写法是 \`![x](${PNG})\` 这样`
    const r = scanBoardMediaImages(text)
    assert.equal(r.images.length, 0)
    assert.equal(r.kept, text)
  })

  it('超过上限：整体不转（回到原文），不产生半截消息', () => {
    const lines = Array.from({ length: 4 }, (_, i) => `![i${i}](${DIR}/m170000000000${i}_0123456789.png)`)
    const text = lines.join('\n')
    const r = scanBoardMediaImages(text, 3)
    assert.deepEqual(r.images, [])
    assert.equal(r.kept, text)
    assert.equal(r.reason, 'overflow')
  })

  it('空文本/无引用：原样返回', () => {
    assert.deepEqual(scanBoardMediaImages(''), { kept: '', images: [], reason: 'none' })
    assert.deepEqual(scanBoardMediaImages('hello'), { kept: 'hello', images: [], reason: 'none' })
  })
})
