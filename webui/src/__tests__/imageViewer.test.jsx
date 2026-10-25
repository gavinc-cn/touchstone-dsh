// 会话截图单击查看大图（卡 #1088，2026-10-25）
//
// 需求：会话详情页里**用户提问**中的截图（markdown 截图 / 附件缩略图），单击弹出
// 全屏大图查看器；Esc 只关查看器（不能把外层会话窗一起关掉，这条由真机 e2e 守，
// 见 tests/e2e_session_image_view.py）。
//
// 为什么用**组件真渲染**而不是纯函数单测：本需求是「点击 → 开浮层」的接线缺陷类
// 场景——纯函数再全也照不到 onClick 委托是否真的挂上（同 interactionCardReadonly.test.jsx
// 的教训）。渲染断言的 DOM 契约与真机 e2e 共用：data-img-viewer / data-img-viewer-img /
// data-img-viewer-close / data-img-viewer-open。
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from '../components/ImageViewer'
import { EntryBody } from '../components/SessionView'
import { setLang } from '../utils/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 本平台附件 fid 形态：m<13 位毫秒>_<10 位 hex>.<ext>（mediaText.MEDIA_PATH_RE 同款）
const FID = 'm1757000000001_0123456789.png'
// 用户提问正文里的本地截图绝对路径 → absToMedia 形态①改写后的媒体端点 URL
const MD_SRC = `/api/projects/7/board/media/${FID}`
const MD_TEXT = `【任务描述】截图里的报错帮我看看\n\n![image.png](/w/board_media/${FID})`

let root = null
let host = null

/** 同步挂载（jsdom + React 18 act 环境；Radix Dialog 的 effect/定时器都在 act 内结算） */
function mount(el) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(el) })
  return host
}

/** 点一个元素（冒泡；React 的 onClick 由根容器委托处理） */
function click(el, init = {}) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ...init,
    }))
  })
}

/** 按一个键（Radix 的 Esc 监听挂在 ownerDocument 捕获阶段） */
function pressKey(key) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true,
    }))
  })
}

/** 挂载 ImageViewer 本体（onClose 用 spy 观察关闭通道） */
function mountViewer(over = {}) {
  const onClose = vi.fn()
  const node = mount(createElement(ImageViewer, {
    src: MD_SRC, alt: '报错截图', onClose, ...over,
  }))
  return { node, onClose }
}

/** 挂载一条 EntryBody（用户/助手气泡；默认项目 7、主 agent） */
function mountEntry(e, over = {}) {
  return mount(createElement(EntryBody, {
    e, wrap: true, agent: 'main', pid: 7, roots: [], ...over,
  }))
}

const viewer = () => document.querySelector('[data-img-viewer]')
const viewerImg = () => document.querySelector('[data-img-viewer-img]')
const closeBtn = () => document.querySelector('[data-img-viewer-close]')

beforeEach(() => {
  setLang('zh')
  document.body.innerHTML = ''
})

afterEach(() => {
  if (root) {
    act(() => root.unmount())
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  document.body.innerHTML = ''
})

describe('ImageViewer：全屏大图查看器本体', () => {
  it('渲染 portal：大图 src/alt 正确、新标签打开入口指向原图', () => {
    mountViewer()
    expect(viewer()).not.toBeNull()
    const img = viewerImg()
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(MD_SRC)
    expect(img.getAttribute('alt')).toBe('报错截图')
    const open = document.querySelector('[data-img-viewer-open]')
    expect(open).not.toBeNull()
    expect(open.getAttribute('href')).toBe(MD_SRC)
    expect(open.getAttribute('target')).toBe('_blank')
  })

  it('关闭通道①：点关闭按钮 → onClose', () => {
    const { onClose } = mountViewer()
    click(closeBtn())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('关闭通道②：Esc → onClose（不把事件留给外层会话窗）', () => {
    const { onClose } = mountViewer()
    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('关闭通道③：点遮罩空白 → onClose', () => {
    const { onClose } = mountViewer()
    click(viewer())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('关闭通道④：点大图本身 → onClose（与微信/QQ 图片预览一致）', () => {
    const { onClose } = mountViewer()
    click(viewerImg())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点工具条按钮不冒泡成「点遮罩关闭」以外的新通道（只记一次）', () => {
    const { onClose } = mountViewer()
    click(document.querySelector('[data-img-viewer-open]'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('EntryBody：用户提问里的截图单击打开大图', () => {
  it('markdown 截图（img.md-img）：点缩略图 → 查看器打开且大图 src == 缩略图 src', () => {
    const node = mountEntry({ seq: 11, kind: 'user', text: MD_TEXT })
    const thumb = node.querySelector('img.md-img')
    expect(thumb).not.toBeNull()
    expect(thumb.getAttribute('src')).toBe(MD_SRC)
    // 点之前无查看器（不能凭空常驻一个浮层）
    expect(viewer()).toBeNull()
    click(thumb)
    expect(viewer()).not.toBeNull()
    expect(viewerImg().getAttribute('src')).toBe(MD_SRC)
    // 关掉后回到无浮层状态
    click(closeBtn())
    expect(viewer()).toBeNull()
  })

  it('附件缩略图（img.sess-img，任务会话）：点缩略图 → 查看器打开', () => {
    const node = mountEntry(
      { seq: 12, kind: 'user', text: '', images: [{ media: 'att-1' }] },
      { taskId: 12, pid: 12 })
    const thumb = node.querySelector('img.sess-img')
    const href = '/api/tasks/12/session/media/att-1?agent=main'
    expect(thumb).not.toBeNull()
    // 缩略图仍包在 <a> 里：中键/右键「新标签页打开」的原生行为不能丢
    expect(thumb.closest('a').getAttribute('href')).toBe(href)
    expect(thumb.closest('a').getAttribute('target')).toBe('_blank')
    click(thumb)
    expect(viewer()).not.toBeNull()
    expect(viewerImg().getAttribute('src')).toBe(href)
  })

  it('附件缩略图（img.sess-img，看板卡片会话）：按卡片会话 sid 寻址', () => {
    const node = mountEntry(
      { seq: 13, kind: 'user', text: '', images: [{ media: 'att-2' }] },
      { boardPid: 9, boardSid: 'session-abc', agent: 'main', pid: 9 })
    const thumb = node.querySelector('img.sess-img')
    const href = '/api/projects/9/board/session/media/att-2?sid=session-abc&agent=main'
    expect(thumb).not.toBeNull()
    click(thumb)
    expect(viewer()).not.toBeNull()
    expect(viewerImg().getAttribute('src')).toBe(href)
  })

  it('修饰键点击（Ctrl/⌘/Shift）保留浏览器「新标签页打开」语义：不弹查看器', () => {
    const node = mountEntry(
      { seq: 14, kind: 'user', text: '', images: [{ media: 'att-3' }] },
      { taskId: 12, pid: 12 })
    const thumb = node.querySelector('img.sess-img')
    click(thumb, { ctrlKey: true })
    expect(viewer()).toBeNull()
  })

  it('作用域守卫：助手回答里的图片单击不弹查看器（本次需求只覆盖用户提问）', () => {
    const node = mountEntry({ seq: 15, kind: 'assistant', text: `看这张图\n\n![shot](/w/board_media/${FID})` })
    const thumb = node.querySelector('img.md-img')
    expect(thumb).not.toBeNull()
    click(thumb)
    expect(viewer()).toBeNull()
  })
})
