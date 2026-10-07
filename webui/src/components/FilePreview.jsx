// 文件预览弹窗：会话详情页把回答里的文件路径变成链接，点击后在这里看内容
// - .md/.markdown 走 renderMd 富文本（复用 .md-body 排版），其余文本按原文 <pre>
// - 二进制只提示不可预览（给下载入口）；超出后端 256KB 截断上限时提示并给全文入口
// - 预览内容里的路径同样可点：压栈换文件，头部出现「返回」（栈深 >1 时）
// - 文件读取限定在项目目录/工作目录之内（server 侧校验，越界/不存在在此展示错误）
import { useCallback, useEffect, useState } from 'react'
import { projectApi } from '../api'
import { renderMd } from '../utils/renderMd'
import { toast } from '../utils/toast'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ArrowLeft, Copy, ExternalLink, FileWarning, TriangleAlert, X } from 'lucide-react'

const MD_RE = /\.(md|markdown)$/i

/** 字节数 → 人类可读（880 B / 12.3 KB / 4.1 MB） */
function fmtSize(n) {
  const v = +n || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

/** 时间戳（秒）→ 本地时间文本 */
function fmtMtime(t) {
  const d = new Date((+t || 0) * 1000)
  return isNaN(d.getTime()) ? '' : d.toLocaleString()
}

export default function FilePreview({ pid, path, onClose }) {
  const [stack, setStack] = useState([path])      // 预览栈（预览内跳转让路径压栈）
  const cur = stack[stack.length - 1]
  const [state, setState] = useState({ loading: true })

  // 拉取当前路径的内容（切换路径即重取；卸载后丢弃回调结果）
  useEffect(() => {
    let alive = true
    setState({ loading: true })
    projectApi.filePreview(pid, cur)
      .then((d) => { if (alive) setState({ data: d }) })
      .catch((e) => { if (alive) setState({ error: e.message || '读取失败' }) })
    return () => { alive = false }
  }, [pid, cur])

  // 预览正文里的路径链接点击（事件委托；普通外链不拦截）
  const onBodyClick = useCallback((ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a.md-path') : null
    const p = a && a.getAttribute('data-path')
    if (!p) return
    ev.preventDefault()
    setStack((s) => (s[s.length - 1] === p ? s : [...s, p]))
  }, [])

  const data = state.data
  const rawUrl = projectApi.fileRawUrl(pid, cur)
  const copyPath = useCallback(() => {
    const p = (data && data.path) || cur
    navigator.clipboard?.writeText(p).then(() => toast('已复制路径'),
      () => toast('复制失败，请手动选择'))
  }, [data, cur])

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="modal fv-modal w-[66vw] h-[78vh] sm:max-w-none flex flex-col gap-2 p-4 overflow-hidden"
        showCloseButton={false}>
        <DialogHeader className="text-left fv-head">
          <div className="fv-titlebar">
            {stack.length > 1 && (
              <button type="button" className="fv-act" title="返回上一个文件"
                onClick={() => setStack((s) => s.slice(0, -1))}>
                <ArrowLeft className="fv-act-i" />
              </button>
            )}
            <DialogTitle className="fv-title" title={(data && data.path) || cur}>
              {(data && data.rel) || cur}
            </DialogTitle>
            <button type="button" className="fv-act" title="复制完整路径" onClick={copyPath}>
              <Copy className="fv-act-i" />
            </button>
            <a className="fv-act" href={rawUrl} target="_blank" rel="noreferrer"
              title="在新标签页打开原文（文本按纯文本展示；二进制下载）">
              <ExternalLink className="fv-act-i" />
            </a>
            <button type="button" className="fv-act" title="关闭（Esc）" onClick={onClose}>
              <X className="fv-act-i" />
            </button>
          </div>
          {data && (
            <div className="fv-meta">
              {fmtSize(data.size)} · {fmtMtime(data.mtime)}
              {data.root === 'work' ? ' · 工作目录' : ' · 项目目录'}
              {data.truncated ? ' · 仅显示前 256KB' : ''}
            </div>
          )}
        </DialogHeader>

        <div className="fv-body">
          {state.loading ? (
            <div className="fv-hint">读取中…</div>
          ) : state.error ? (
            <div className="fv-hint err">
              <TriangleAlert className="fv-hint-i" />
              <span>{state.error}</span>
            </div>
          ) : data.binary ? (
            <div className="fv-hint">
              <FileWarning className="fv-hint-i" />
              <span>二进制文件（{fmtSize(data.size)}），无法预览。
                <a className="md-path" href={rawUrl} target="_blank" rel="noreferrer">下载</a>
              </span>
            </div>
          ) : MD_RE.test(cur) ? (
            // markdown 按富文本渲染（与回答气泡同一渲染器 + 同样可点路径）
            <div className="md-body" onClick={onBodyClick}
              dangerouslySetInnerHTML={{ __html: renderMd(data.text, { pathLinks: true }) }}></div>
          ) : (
            <pre className="fv-pre">{data.text}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
