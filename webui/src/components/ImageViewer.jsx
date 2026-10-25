// 会话截图大图查看器（卡 #1088，2026-10-25）
//
// 场景：会话详情页里用户提问的截图原先只是气泡里的 320×200 缩略图（看不见细节），
// 用户要求「单击一下弹出一个页面展示大图」——本组件就是那个浮层。
//
// 形态选择（为什么是**嵌套 Radix Dialog** 而不是自建 portal 遮罩）：
//   会话详情窗本身是一个 Radix Dialog（modal）。若把浮层用 createPortal 挂到外层
//   DialogContent 的 DOM 之外，Radix 的模态层会把它判成「点击外部」→ 单击缩略图大图
//   的同时外层会话窗会被一起 dismiss；且 body 的 pointer-events:none / 滚动锁 / 焦点
//   陷阱都只对 DialogContent 自身放行。嵌套 Dialog 让 Radix 的层栈（DismissableLayer
//   layers / FocusScope focusScopesStack）接管：内层成为最高层 → Esc 只关内层、外层
//   不动；焦点陷阱与 body 锁滚动也自动叠对。
//
// 关闭通道：① 右上角 × ② Esc ③ 点遮罩空白 ④ 点大图本身（与微信/QQ 图片预览一致）。
// 右上角另留「在新标签页打开原图」入口（浏览器原生能力兜底：另存/Ctrl+滚轮缩放）。
// 浮层 DOM 契约（真机 e2e tests/e2e_session_image_view.py 与单测共用）：
//   [data-img-viewer]（根/遮罩，class .imgv-stage）
//   img.imgv-img[data-img-viewer-img]、button[data-img-viewer-close]、
//   a[data-img-viewer-open][target=_blank]
import { useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '../utils/i18n'

export default function ImageViewer({ src, alt = '', onClose }) {
  const { t } = useI18n()
  // 加载失败兜底：图挂了不至于只剩一片黑，给出「新标签页打开原图」出口
  const [failed, setFailed] = useState(false)
  // 同一实例复用到另一张图（父级换 src）时复位失败态
  useEffect(() => { setFailed(false) }, [src])
  if (!src) return null
  const label = alt || t('图片')
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      {/* 全屏透明对话框：样式由 .imgv-* 接管；className 里的 Tailwind 覆盖基类
          （bg-background/p-6/max-w… 等，cn/twMerge 后者胜出），故不能用 .modal。
          aria-describedby=undefined 抑制 Radix「缺 Description」告警（标题已 sr-only）。 */}
      <DialogContent
        className="imgv-modal inset-0 z-[200] h-screen max-h-none w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t('查看大图')}</DialogTitle>
        {/* 整屏即点击热区：点遮罩或大图都关闭；工具条控件各自 stopPropagation */}
        <div className="imgv-stage" data-img-viewer onClick={onClose}>
          <div className="imgv-bar">
            <a className="imgv-btn" data-img-viewer-open href={src} target="_blank" rel="noreferrer"
              title={t('在新标签页打开原图')} aria-label={t('在新标签页打开原图')}
              onClick={(ev) => ev.stopPropagation()}>
              <ExternalLink className="imgv-btn-i" />
            </a>
            <button type="button" className="imgv-btn" data-img-viewer-close
              title={t('关闭（Esc）')} aria-label={t('关闭（Esc）')}
              onClick={(ev) => { ev.stopPropagation(); onClose() }}>
              <X className="imgv-btn-i" />
            </button>
          </div>
          {failed ? (
            <div className="imgv-err">
              <span>{t('图片加载失败')}</span>
              <a className="imgv-raw" href={src} target="_blank" rel="noreferrer"
                onClick={(ev) => ev.stopPropagation()}>{t('在新标签页打开原图')}</a>
            </div>
          ) : (
            <figure className="imgv-figure">
              <img className="imgv-img" data-img-viewer-img src={src} alt={label}
                onError={() => setFailed(true)} />
              {alt ? <figcaption className="imgv-cap">{alt}</figcaption> : null}
            </figure>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
