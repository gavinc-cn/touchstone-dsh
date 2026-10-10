// 任务 session 对话视图(复刻 kimi code web 的会话页)
// - 展示 agent 会话原始对话(用户/助手/思考/工具调用与结果/图片), SSE 实时增量更新
// - 支持 main/子 agent 切换、token 用量与耗时汇总、窗口内直接向会话续发消息
// - 头部信息行右侧「在 dsh 界面打开当前会话」入口(仅 dsh 插件面板形态渲染, 见 lib/dshHost)
// - 三种形态: SessionModal(任务列表弹窗) / BugsTab 修复页(常驻内嵌) / 看板会话查看(board 模式)
// - board 模式({projectId, sid, cid}): 不看任务看卡片会话, 无 SSE 走 2s 轮询增量,
//   输入区按 meta.capabilities 门控(评论投递主会话), 图片因 media 端点按任务寻址而降级为占位
// 数据来源: 后端解析 dsh 会话存储(~/.dsh/sessions/**/session*.jsonl.zstd, 多帧 zstd 事件流)
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react'
import { taskApi, boardApi, projectApi } from '../api'
import { useAppStore } from '../stores/app'
import { toast } from '../utils/toast'
import { renderMd } from '../utils/renderMd'
import { absToMedia, mediaDisplayUrl } from '../utils/mediaText'
import { isPlaceholderImage } from '../utils/media'
import ComposerBar, { PERM_OPTS } from './ComposerBar'
import { effortChoices, effortText } from '../utils/sessionEffort'
import FilePreview from './FilePreview'
import MergeHandoffDialog from './MergeHandoffDialog'
import { Button } from '@/components/ui/button'
import { findSlashToken } from '../utils/slashToken'
// 提问索引侧栏的纯派生（用户提问 + agent 问答混排 / 回答文本解析 / 占位与悬浮文案）
import { buildQuestionIndex, questionLabel, questionTitle } from '../utils/sessionQa'
import { useDshHostCaps } from '../hooks/useDshHost'
import { openSessionInDsh } from '../lib/dshHost'
import { List, Wrench, CircleX, Check, Zap, TriangleAlert, Copy, Undo2, ChevronDown, ChevronUp,
         ExternalLink } from 'lucide-react'

/** token 数 → 紧凑文本(1234 → 1.2k) */
function fmtTokens(n) {
  const v = +n || 0
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(v)
}

/** 毫秒 → 时长文本(3661 → 3.7s / 72500 → 1分12s) */
function fmtDur(ms) {
  const v = +ms || 0
  if (v < 1000) return ''
  if (v < 60000) return (v / 1000).toFixed(1) + 's'
  return Math.floor(v / 60000) + '分' + Math.round((v % 60000) / 1000) + 's'
}

/** tool_call 的 args JSON 美化(失败则原文) */
function prettyArgs(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s || '' }
}

/** found:false 原因 → 空态文案（P7b B5 单族化后只有 dsh：无 db_missing 分支） */
const REASON_TEXT = {
  family: '该智能体暂不支持会话查看',
  no_session: '会话尚未生成（任务首轮执行后才有会话）',
  missing: '未找到会话文件（可能已被清理）',
}

/* ---------- 消息流虚拟滚动(2026-09-10) ----------
   会话可达上千条消息, 全量挂 DOM 时浏览器每次击键都要为整份消息树重算布局
   (实测 1024 条: 每键 Layout ~10ms, 且随条数超线性增长 → 输入明显卡顿)。
   方案: 只渲染视口附近的条目, 窗口外上下用等高占位块撑起滚动条(窗口化虚拟滚动),
   DOM 规模恒定在几十条, 击键布局成本回落到短会话水平。 */
const ROW_GAP = 10          // 条目间距(px, 与 .sess-entry margin-bottom 一致; 高度按"含间距"记账)
const EST_ROW_H = 56        // 条目高度估算(含间距); 有实测样本时改用样本均值自适应
const OVERSCAN = 10         // 视口上下各多渲染的条目数(滚动缓冲)
const TAIL_MIN = 60         // 贴底窗口尾部条数
const TAIL_MAX = 240        // 贴底窗口增长上限(超过收缩回 TAIL_MIN, 防 DOM 无界膨胀)
const STICK_PX = 60         // 距底小于该值视为"贴底"(与旧版 atBottom 判定一致)

/** 前缀和数组二分: 返回内容坐标 y 所在条目的索引(0-based) */
function rowAt(off, y) {
  let lo = 0
  let hi = off.length - 2
  if (hi < 0 || y <= 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (off[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 单条消息渲染; entries 为 append-only 不可变数据, memo 后历史消息不随新消息重渲染(避免 O(n²) renderMd) */
const Entry = memo(function Entry({ e, taskId, agent, pid, boardPid, boardSid, flash, expand,
                                    rwState, copied,
                                    onCopy, onRewind, onOpenPath }) {
  // 回答正文里的路径链接（.md-path）：点击开文件预览弹窗。内容由
  // dangerouslySetInnerHTML 生成，故用事件委托——只拦 .md-path，普通外链保持默认跳转
  const onBodyClick = useCallback((ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a.md-path') : null
    const p = a && a.getAttribute('data-path')
    if (!p || !onOpenPath) return
    ev.preventDefault()
    onOpenPath(p)
  }, [onOpenPath])
  // 跳转展开（提问索引点 agent 问答项）：把该条的 details 打开——否则落点只是一行
  // 折叠的 `ask_user_question` 标题，看不到问答内容。非受控写法（直接写 DOM open），
  // details 保持浏览器原生开合行为；只在 false→true 时写一次，用户手动折叠不被打扰
  const detRef = useRef(null)
  useEffect(() => { if (expand && detRef.current) detRef.current.open = true }, [expand])
  // 外层包 .sess-entry: data-seq 供提问索引跳转定位; flash 触发背景闪烁高亮
  const body = (() => {
  if (e.kind === 'user') {
    // 附件引用改写: 本平台上传产物 abs 路径 → 项目媒体端点 URL(气泡渲染缩略图/文件链接)
    const text = absToMedia(e.text, pid)
    const hasText = !!(e.text || '').trim()
    return (
      <>
        <div className="sess-msg user">
          <div className="bubble">
            {text && <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMd(text) }}></div>}
            {(e.images || []).map((img, i) => {
              // media 寻址：任务模式按任务、board 模式按 项目+卡片会话 sid；
              // 两者皆不可用（board 未绑定 sid 等）→ [图片] 占位
              const mediaUrl = !img.media ? ''
                : taskId ? taskApi.sessionMediaUrl(taskId, agent, img.media)
                : (boardPid && boardSid
                  ? boardApi.sessionMediaUrl(boardPid, boardSid, agent, img.media) : '')
              return mediaUrl ? (
                <a key={i} href={mediaUrl} target="_blank" rel="noreferrer">
                  <img className="sess-img" src={mediaUrl}
                    alt="图片" onError={(ev) => { ev.currentTarget.closest('a').replaceWith('[图片]') }} />
                </a>
              ) : <span key={i} className="sess-img-ph">[图片]</span>
            })}
          </div>
        </div>
        {/* 动作行（kimi web 的用户气泡 .u-meta 同款＝设计出处）：回退到该提问之前 + 复制该提问。
            rwState: ''=不渲染(族无 rewind 能力/无 anchor 消息 id) on=可点 busy=会话忙置灰 running=回退中 */}
        {(rwState || hasText) && (
          <div className="sess-actrow">
            {rwState && (
              <button type="button"
                className={'sess-act rw' + (rwState === 'on' ? '' : ' off')}
                disabled={rwState !== 'on'}
                title={rwState === 'busy' ? '会话运行中或有排队消息，稍后再试'
                  : rwState === 'running' ? '回退中…'
                  : '回退到该提问之前（撤销该提问及其后对话，不回退文件改动）'}
                onClick={() => onRewind(e)}>
                <Undo2 className="sess-act-i" />
              </button>
            )}
            {hasText && (
              <button type="button" className="sess-act cp"
                title={copied ? '已复制' : '复制该提问'}
                onClick={() => onCopy(e)}>
                {copied ? <Check className="sess-act-i" /> : <Copy className="sess-act-i" />}
              </button>
            )}
          </div>
        )}
      </>
    )
  }
  if (e.kind === 'assistant') {
    return (
      <div className="sess-msg assistant">
        <div className="md-body" onClick={onBodyClick}
          dangerouslySetInnerHTML={{ __html: renderMd(e.text, { pathLinks: true }) }}></div>
      </div>
    )
  }
  if (e.kind === 'think') {
    if (!e.text) return null
    return (
      <details className="sess-msg think">
        <summary>思考过程</summary>
        <div className="think-text">{e.text}</div>
      </details>
    )
  }
  if (e.kind === 'tool_call') {
    return (
      <details className="sess-msg tool" ref={detRef}>
        <summary><Wrench className="inline h-3 w-3" /> {e.name || '工具调用'}</summary>
        <pre>{prettyArgs(e.args)}</pre>
      </details>
    )
  }
  if (e.kind === 'tool_result') {
    return (
      <details className={'sess-msg tool result' + (e.is_error ? ' err' : '')} ref={detRef}>
        <summary>
          {e.is_error ? '错误' : '结果'}{e.name ? ` · ${e.name}` : ''}
          （{String(e.text || '').trim().length} 字符{e.truncated ? ' · 已截断' : ''}）
        </summary>
        <pre>{String(e.text || '').trim()}</pre>
      </details>
    )
  }
  if (e.kind === 'usage') {
    const parts = []
    if (e.input) parts.push('↑' + fmtTokens(e.input))
    if (e.output) parts.push('↓' + fmtTokens(e.output))
    if (e.cache_read) parts.push('缓存 ' + fmtTokens(e.cache_read))
    if (e.duration_ms && fmtDur(e.duration_ms)) parts.push(fmtDur(e.duration_ms))
    if (!parts.length) return null
    return <div className="sess-usage">{parts.join(' · ')}</div>
  }
  if (e.kind === 'divider') {
    return <div className="sess-divider">{e.text}</div>
  }
  if (e.kind === 'error') {
    // 模型请求失败/本轮对话中断(旧族错误通道的渲染分支; dsh 事件流不产出 error
    // 条目——sessparse 侧已无该通道, 此分支保留仅为渲染兜底); 无 detail 时只留标题
    const detail = [e.text, e.code ? `[${e.code}]` : '', e.retryable ? '可重试' : '']
      .filter(Boolean).join(' · ')
    return (
      <div className="sess-msg error">
        <div className="sess-errbox">
          <TriangleAlert className="sess-errbox-i" />
          <div>
            <div className="sess-errbox-t">模型请求失败，本轮对话已中断</div>
            {detail && <div className="sess-errbox-d">{detail}</div>}
          </div>
        </div>
      </div>
    )
  }
  return null
  })()
  return body ? <div className={'sess-entry' + (flash ? ' flash' : '')} data-seq={e.seq}>{body}</div> : null
})

/* 消息流(滚动容器 + 窗口化虚拟滚动): 抽成 memo 组件隔离击键重渲染
   - 只渲染 [start, end) 窗口内的条目, 窗口外上下用等高占位 div 撑起滚动条;
     滚动时按 scrollTop 在前缀和上二分重算窗口(rAF 节流), 实测高度回写缓存修正占位偏差
   - 高度缓存: seq -> 含间距高度(条目 offsetHeight + ROW_GAP); 未测量条目按"已测量样本
     均值"估算(比固定值更贴近真实会话), ResizeObserver 兜底捕获 details 展开/图片加载
   - 贴底模式(距底 < STICK_PX): 窗口固定为尾部, 新消息到达自动跟随(窗口向右增长,
     超过 TAIL_MAX 收缩回 TAIL_MIN —— 收缩发生在用户看底部时, 不影响可见内容)
   - 贴底 snap(写 scrollTop 到底)只在内容/视口确有变化时执行, 且滚动本身不产生重渲染
     (贴底分支保持 state 引用) —— 否则用户小幅上滑会被任何一次重渲染拉回底部
   - props 全传原始值/稳定引用: 击键时(entries 引用不变)整棵子树被 memo 跳过 */
const MessageList = memo(function MessageList({ entries, metaNull, found, reason,
    taskId, agent, pid, boardPid, boardSid, flashSeq, expandSeqs, chatRunning, exitCode, boxRef,
    atBottomRef, onScroll,
    jumpSeq, onJumpHandled, rwEnabled, rwBusy, rewindingMid, copiedSeq, onCopy, onRewind,
    onSwitchSession,
    onOpenPath }) {
  const n = entries.length
  const heightsRef = useRef(new Map())      // seq -> 实测高度(含间距); 离开窗口后保留供回头定位
  const observedRef = useRef(new Set())     // ResizeObserver 已观察节点(尺寸变化兜底)
  const roRef = useRef(null)
  const [tick, setTick] = useState(0)       // 高度缓存版本: 测量/尺寸变化后自增触发重算
  const [range, setRange] = useState(null)  // 渲染窗口 [start, end); null=按尾部推导(首帧)
  const stickRef = useRef(true)             // 贴底模式(新消息跟随)
  const rafRef = useRef(0)
  const jumpRef = useRef(null)              // 待定位的跳转 seq(渲染后定位)
  const holdRafRef = useRef(0)              // 跳转落点连钉帧(rAF 句柄)
  const pinRef = useRef(false)              // 连钉窗口内: 跳过 deltaAbove 补偿(防把落点推走)
  // 上次提交时的滚动容器尺寸 {sh 内容高, ch 视口高}: 贴底 snap 的判据(有变化才跟随)
  const boxViewRef = useRef(null)

  // 前缀和: off[i] = 第 i 条顶部的累计高度; off[n] = 全量内容总高(未测量按估算)
  const off = useMemo(() => {
    const a = new Float64Array(n + 1)
    const h = heightsRef.current
    let sum = 0
    for (const v of h.values()) sum += v
    const est = h.size ? sum / h.size : EST_ROW_H   // 估算自适应: 已测量样本均值
    for (let i = 0; i < n; i++) a[i + 1] = a[i] + (h.get(entries[i].seq) || est)
    return a
  }, [entries, n, tick])
  // 首帧(range=null)按尾部推导, 避免闪一下空列表
  const [rs, re] = range ?? [Math.max(0, n - TAIL_MIN), n]

  // 滚动: rAF 节流后重算窗口(贴底模式保持尾部窗口)
  const handleScroll = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    onScroll()                                 // 外部维护 atBottomRef(贴底判据)
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const b = boxRef.current
      if (!b) return
      setRange((prev) => {
        const [cs, ce] = prev ?? [Math.max(0, n - TAIL_MIN), n]
        // 贴底模式: 窗口已是尾部即原样返回 prev(引用不变, null 也原样返回=按尾部推导)。
        // 这里返回新数组会让**每个滚动事件**都触发一次重渲染, 进而执行下面布局 effect 的
        // 贴底 snap(写 scrollTop=scrollHeight), 把用户刚滚出的位置拉回底部 —— 即"贴底时
        // 慢速滚轮上滑被弹回"的根因(单个滚动位移 < STICK_PX 时永远出不了贴底区)。
        if (stickRef.current) return ce === n ? prev : [Math.max(0, n - TAIL_MIN), n]
        const s = Math.max(0, rowAt(off, b.scrollTop) - OVERSCAN)
        const e = Math.min(n, rowAt(off, b.scrollTop + b.clientHeight) + 1 + OVERSCAN)
        return (s === cs && e === ce) ? prev : [s, Math.max(s + 1, e)]
      })
    })
  }, [boxRef, onScroll, n, off])
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cancelAnimationFrame(holdRafRef.current) }, [])

  // 新消息 / 会话切换: 贴底时窗口向右增长跟随; 非贴底保持阅读位置(仅尾随到新长度)
  // n=0 = 会话切换/重置: 清掉高度缓存与尺寸快照(不同会话 seq 可能复用, 残留会算错
  // 占位高度; 尺寸快照残留会让下面的贴底 snap 误判"无变化"而不跟到底部)
  useLayoutEffect(() => {
    if (!n) {
      if (heightsRef.current.size) heightsRef.current = new Map()
      boxViewRef.current = null
      setRange(null)
      return
    }
    setRange((prev) => {
      const [cs, ce] = prev ?? [Math.max(0, n - TAIL_MIN), n]
      if (atBottomRef.current) {
        const s = (n - cs > TAIL_MAX) ? Math.max(0, n - TAIL_MIN) : Math.min(cs, n - 1)
        return [s, n]
      }
      return [Math.min(cs, n - 1), Math.min(ce, n)]
    })
  }, [n, atBottomRef])

  // 跳转(提问索引): 先把窗口扩到目标附近, 渲染后由下方 effect 定位
  useEffect(() => {
    if (jumpSeq == null) return
    const idx = entries.findIndex((x) => x.seq === jumpSeq)
    if (idx < 0) { onJumpHandled(jumpSeq); return }
    stickRef.current = false
    jumpRef.current = jumpSeq
    setRange([Math.max(0, idx - 5), Math.min(n, idx + 25)])
  }, [jumpSeq, entries, n, onJumpHandled])

  // ResizeObserver: 窗口内条目尺寸变化(details 展开/收起、图片加载)触发重测;
  // 也观察滚动容器自身——composer 高度变化(排队 chip 出现等)会让视口变矮,
  // 需重新贴底, 否则底部内容被遮住一截
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    roRef.current = ro
    if (boxRef.current) ro.observe(boxRef.current)
    return () => {
      ro.disconnect()
      roRef.current = null
      observedRef.current = new Set()
    }
  }, [boxRef])

  // 渲染后: 测量窗口内条目 → 修正高度缓存; 视口上方高度变化补偿 scrollTop(防跳动);
  // 贴底且内容/视口确有变化则跟到内容底部; 顺带维护 RO 观察集与执行跳转定位
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const h = heightsRef.current
    let changed = false
    let deltaAbove = 0
    const firstVis = rowAt(off, box.scrollTop)
    const nodes = box.querySelectorAll('.sess-entry[data-seq]')
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i]
      const seq = +el.dataset.seq
      const hh = el.offsetHeight + ROW_GAP        // 含间距记账
      const old = h.get(seq)
      if (old !== hh) {
        h.set(seq, hh)
        changed = true
        if (rs + i < firstVis) deltaAbove += hh - (old ?? EST_ROW_H)
      }
    }
    if (deltaAbove && !stickRef.current && !pinRef.current) box.scrollTop += deltaAbove
    // 贴底 snap: 仅当"确实有新东西要跟"时执行 —— 内容变高(新消息/展开/图片加载)或
    // 视口变矮(composer 长高、弹窗变矮)。此前是无条件写 scrollTop=scrollHeight,
    // 任何一次无关重渲染(滚动自身、chat 态翻转、RO tick……)都会把用户刚滚出的位置
    // 拉回底部 —— 即贴底时慢速滚轮上滑"弹回"的另一半根因。
    const view = boxViewRef.current
    const grew = !view || box.scrollHeight !== view.sh || box.clientHeight < view.ch
    boxViewRef.current = { sh: box.scrollHeight, ch: box.clientHeight }
    if (stickRef.current && atBottomRef.current && grew) box.scrollTop = box.scrollHeight
    const ro = roRef.current
    if (ro) {
      const seen = new Set()
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i]
        seen.add(el)
        if (!observedRef.current.has(el)) { ro.observe(el); observedRef.current.add(el) }
      }
      for (const el of observedRef.current) {
        if (!seen.has(el)) { ro.unobserve(el); observedRef.current.delete(el) }
      }
    }
    const js = jumpRef.current
    if (js != null) {
      const el = box.querySelector(`[data-seq="${js}"]`)
      if (el) {
        el.scrollIntoView({ block: 'start' })
        jumpRef.current = null
        // 落点连钉：跳转当帧窗口内的高度缓存刚从「估算值」换成「实测值」，紧随其后的
        // deltaAbove 补偿（长会话实测可把落点推出视口数百 px）与 details 展开触发的
        // ResizeObserver 记账还会再动几次滚动位置。故在随后若干帧里：①补偿暂停
        // （pinRef）；②每帧把目标重新钉回顶部，连续 6 帧（≈100ms）都在顶部才收手
        // （上限 20 帧，防记账迟迟不收敛时空转）。
        // 一次性窗口，不常驻监听；用户在此期间的滚动会被这几帧拉回，窗口 ≤330ms 可接受
        cancelAnimationFrame(holdRafRef.current)
        pinRef.current = true
        let left = 20
        let okN = 0
        const repin = () => {
          const b = boxRef.current
          const e2 = b && b.querySelector(`[data-seq="${js}"]`)
          if (!e2 || !b) {
            pinRef.current = false
            holdRafRef.current = 0
            return
          }
          const d = Math.round(e2.getBoundingClientRect().top - b.getBoundingClientRect().top)
          okN = d === 0 ? okN + 1 : 0
          if (d !== 0) e2.scrollIntoView({ block: 'start' })
          if (--left > 0 && okN < 6) {
            holdRafRef.current = requestAnimationFrame(repin)
          } else {
            pinRef.current = false
            holdRafRef.current = 0
          }
        }
        holdRafRef.current = requestAnimationFrame(repin)
        onJumpHandled(js)
      }
    }
    if (changed) setTick((t) => t + 1)
  })

  return (
    <div className="sess-body scroll" ref={boxRef} onScroll={handleScroll}>
      {metaNull ? (
        <div className="sess-empty">加载中…</div>
      ) : !found ? (
        <div className="sess-empty">{REASON_TEXT[reason] || '会话不可用'}</div>
      ) : !n ? (
        <div className="sess-empty">会话暂无内容</div>
      ) : (
        <>
          {rs > 0 && <div className="sess-pad" style={{ height: off[rs] }}></div>}
          {entries.slice(rs, re).map((e) => {
            // 每条提问的回退按钮态：族无 rewind 能力或无 anchor 消息 id → 不渲染；
            // 会话忙（在跑/有排队）→ 置灰（服务端同样 409）；回退中 → 禁用防连点
            const rw = (!rwEnabled || !e.mid) ? ''
              : (rewindingMid === e.mid ? 'running' : (rwBusy ? 'busy' : 'on'))
            return <Entry key={e.seq} e={e} taskId={taskId} agent={agent}
              pid={pid} boardPid={boardPid} boardSid={boardSid}
              flash={flashSeq === e.seq} expand={!!expandSeqs && expandSeqs.has(e.seq)} rwState={rw}
              copied={copiedSeq === e.seq} onCopy={onCopy} onRewind={onRewind}
              onOpenPath={onOpenPath} />
          })}
          {re < n && <div className="sess-pad" style={{ height: off[n] - off[re] }}></div>}
        </>
      )}
      {chatRunning && (
        <div className="sess-running"><span className="sess-pulse"></span>工作中…</div>
      )}
      {!chatRunning && exitCode != null && exitCode !== 0 && (
        <div className="sess-chaterr"><CircleX className="inline h-3 w-3" /> 对话进程异常结束（exit={exitCode}）</div>
      )}
    </div>
  )
})

/* 提问索引侧边栏: 同上抽 memo,  questions 引用(useMemo 依赖 entries)不变时整棵跳过。
   2026-10-09 起列表=用户提问 + agent 问答(ask_user_question)混排：后者以 🤔 前缀与
   .ask 配色区分，文字取用户回答（未答/被中断为占位文案），未答的整条压暗 */
const QuestionBar = memo(function QuestionBar({ withQBar, qbarOpen, questions, flashSeq, onJump }) {
  if (!withQBar || !qbarOpen) return null
  return (
    <aside className="sess-qbar">
      <div className="sess-qbar-t">提问索引 <span className="sess-qbar-n">{questions.length}</span></div>
      <div className="sess-qbar-list">
        {questions.length === 0 && <div className="sess-qbar-empty">暂无提问</div>}
        {questions.map((q, i) => {
          // 显示文案由 utils/sessionQa 出（user=提问原文；ask=回答/占位），此处只截断折叠
          const label = questionLabel(q).replace(/\s+/g, ' ')
          const ask = q.kind === 'ask'
          return (
            <button key={q.key} type="button"
              className={'sess-qitem' + (ask ? ' ask' : '')
                + (ask && q.state !== 'answered' ? ' pend' : '')
                + (flashSeq === q.seq ? ' on' : '')}
              onClick={() => onJump(q)} title={questionTitle(q)}>
              <span className="sess-qitem-i">{i + 1}</span>
              <span className="sess-qitem-t">
                {ask && <span className="sess-qitem-ask">🤔</span>}
                {label.slice(0, 60)}{label.length > 60 ? '…' : ''}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
})

/* 等待回答 / 待审批的交互卡片（对齐 kimi code＝设计出处，2026-09-10；多子题 2026-09-11；
   多题翻页 + 最小化 2026-09-19）：
   - 提问：一次提问可含多道子题（questions[]）——序号 + 单选
     (radio)/多选(checkbox) + label + description（选项双行形态）；allow_other
     的题追加「其他…」行（other_label/other_description + 文本输入）；底部「提交」
     把全部子题答案**一次提交**（answers 是逐子题 record，缺项即未答；
     2026-09-11 前只渲染/只提交首题，其余子题被静默忽略）
   - 多子题翻页（2026-09-19）：一次只渲染当前一题（向导式），底部「‹ 上一题 / 题号
     进度点（可点跳题，已答高亮）/ 下一题 ›」+ 常驻「提交」（全部答完才可用）；
     允许乱序作答（已答按题 id 存 ans，翻页往返保留）
   - 最小化（2026-09-19）：头行右侧折叠按钮把卡片收成一行摘要条（挡会话消息时
     随时折起），点条展开；折叠态在轮询刷新（meta 更新）间保持
   - 审批（manual 逐条确认档挂起的工具调用）：批准 / 本会话内批准 / 拒绝 三按钮
     （审批面板文案出处 kimi web；decision=approved/rejected，scope=session 本会话内批准）
   data = 会话端点下发的 interaction（见 board._iw_interaction）；answer 由 SessionView
   注入（board / task 各自端点），失败提示在调用方 toast；qid/approval_id 变化重置选择 */
const InteractionCard = memo(function InteractionCard({ data, answer }) {
  // 逐题作答态：{ [题 id]: {sel: [], other: '', useOther: false} }（单选也存数组，统一处理）
  const [ans, setAns] = useState({})
  const [busy, setBusy] = useState(false)
  // 多题翻页态：page=当前显示的子题下标；最小化态：min=收起为一行摘要条
  const [page, setPage] = useState(0)
  const [min, setMin] = useState(false)
  const qid = data?.qid
  const aid = data?.approval_id
  useEffect(() => { setAns({}); setPage(0); setMin(false) }, [qid, aid])
  if (!data?.pending) return null
  // 题目列表：优先 data.questions（1-4 题全量）；兼容仅首题平面字段的旧载荷
  const qs = (data.questions && data.questions.length)
    ? data.questions
    : [{ id: data.wire || 'q_0', question: data.question, header: data.header,
         body: data.body, options: data.options || [], multi_select: data.multi_select,
         allow_other: data.allow_other, other_label: data.other_label,
         other_description: data.other_description }]
  const multiQ = qs.length > 1
  const stOf = (id) => ans[id] || { sel: [], other: '', useOther: false }
  const patch = (id, p) => setAns((s) => ({
    ...s, [id]: { ...(s[id] || { sel: [], other: '', useOther: false }), ...p } }))
  async function run(body) {
    setBusy(true)
    try { await answer(body) } finally { setBusy(false) }
  }
  function pick(q, id) {
    const st = stOf(q.id)
    if (q.multi_select) {
      patch(q.id, { sel: st.sel.includes(id)
        ? st.sel.filter((x) => x !== id) : [...st.sel, id] })
    } else patch(q.id, { sel: [id], useOther: false })
  }
  // 选中「其他…」行（单选清掉已选项；多选保留多选结果）
  function pickOther(q) {
    patch(q.id, q.multi_select ? { useOther: true } : { useOther: true, sel: [] })
  }
  function typeOther(q, text) {
    patch(q.id, q.multi_select ? { other: text, useOther: true }
      : { other: text, useOther: true, sel: [] })
  }
  // 单题答案：多选=multi / multi_with_other / other 三态；单选=选项或自定义输入；
  // 未作答返回 null（提交按钮据此禁用，保证逐题全给）
  function answerOf(q) {
    const st = stOf(q.id)
    const text = (st.other || '').trim()
    if (q.multi_select) {
      if (st.sel.length && text) return { wire: q.id, kind: 'multi_with_other', option_ids: st.sel, text }
      if (st.sel.length) return { wire: q.id, kind: 'multi', option_ids: st.sel }
      if (text) return { wire: q.id, kind: 'other', text }
      return null
    }
    if (st.sel.length) return { wire: q.id, kind: 'single', option_id: st.sel[0] }
    if (text) return { wire: q.id, kind: 'other', text }
    return null
  }
  const answers = qs.map(answerOf)
  const canSubmit = !busy && answers.every(Boolean)
  // 提交：body 带 qid（服务端按缓存白名单校验提问归属，缺了直接 400）
  function submitQuestion() {
    if (!canSubmit) return undefined
    return run({ qid: qid, answers: answers })
  }
  // 当前显示的子题（翻页下标夹取防越界；qid 变化时 effect 已把 page 重置回 0）
  const answeredN = answers.filter(Boolean).length
  const pageIdx = Math.min(Math.max(page, 0), qs.length - 1)
  const cur = qs[pageIdx]
  const st = stOf(cur.id)
  const opts = cur.options || []
  if (data.kind === 'approval') {
    // 最小化：收成一行摘要条（点条展开）
    if (min) {
      return (
        <button type="button" className="sess-interaction-bar" title="展开"
          onClick={() => setMin(false)}>
          <span className="sess-interaction-bar-t">
            🛡 agent 请求审批：{data.action || data.tool || '工具调用'}
          </span>
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      )
    }
    return (
      <div className="sess-interaction">
        <div className="sess-interaction-head">
          <div className="sess-interaction-q">
            🛡 agent 请求审批：{data.action || data.tool || '工具调用'}
          </div>
          <button type="button" className="sess-interaction-min" title="最小化"
            onClick={() => setMin(true)}>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
        {data.input && <pre className="sess-interaction-pre">{data.input}</pre>}
        <div className="sess-interaction-opts">
          <Button size="sm" disabled={busy}
            onClick={() => run({ approval_id: aid, decision: 'approved' })}>批准</Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => run({ approval_id: aid, decision: 'approved', scope: 'session' })}>
            本会话内批准</Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => run({ approval_id: aid, decision: 'rejected' })}>拒绝</Button>
        </div>
      </div>
    )
  }
  // 最小化：收成一行摘要条（多题带已答进度；点条展开）
  if (min) {
    return (
      <button type="button" className="sess-interaction-bar" title="展开"
        onClick={() => setMin(false)}>
        <span className="sess-interaction-bar-t">
          🤔 agent 等待你的回答{multiQ ? ` · 已答 ${answeredN}/${qs.length}` : ''}
        </span>
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
    )
  }
  return (
    <div className="sess-interaction">
      <div className="sess-interaction-head">
        {/* 单题保持原文案；多题带序号并翻页（一次一题），便于对照多子题提问 */}
        <div className="sess-interaction-q">
          🤔 {multiQ ? `问题 ${pageIdx + 1}/${qs.length}` : 'agent 等待你的回答'}
          {cur.header ? `（${cur.header}）` : ''}：
          {cur.question || '（详情见会话记录）'}
        </div>
        <button type="button" className="sess-interaction-min" title="最小化"
          onClick={() => setMin(true)}>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {cur.body && <div className="sess-interaction-body">{cur.body}</div>}
      {data.answerable && (
        <div className="sess-interaction-list">
          {opts.map((o, i) => (
            <label key={o.id} className={'sess-iopt' + (st.sel.includes(o.id) ? ' on' : '')}>
              <input type={cur.multi_select ? 'checkbox' : 'radio'}
                checked={st.sel.includes(o.id)} disabled={busy}
                onChange={() => pick(cur, o.id)} />
              <span className="sess-iopt-key">{i + 1}</span>
              <span className="sess-iopt-text">
                <span className="sess-iopt-label">{o.label}</span>
                {o.description && <span className="sess-iopt-desc">{o.description}</span>}
              </span>
            </label>
          ))}
          {cur.allow_other && (
            <label className={'sess-iopt' + (st.useOther ? ' on' : '')}>
              <input type={cur.multi_select ? 'checkbox' : 'radio'} checked={st.useOther}
                disabled={busy} onChange={() => pickOther(cur)} />
              <span className="sess-iopt-key">{opts.length + 1}</span>
              <span className="sess-iopt-text">
                <span className="sess-iopt-label">{cur.other_label || '其他…'}</span>
                {cur.other_description && (
                  <span className="sess-iopt-desc">{cur.other_description}</span>)}
                <input className="sess-iopt-input" type="text" value={st.other}
                  placeholder={cur.other_label || '其他…'} disabled={busy}
                  onFocus={() => pickOther(cur)}
                  onChange={(e) => typeOther(cur, e.target.value)} />
              </span>
            </label>
          )}
        </div>
      )}
      {/* 底部：多题=翻页导航（上一题/题号进度点/下一题）+ 常驻「提交」；
          单题=原提示文案。answerable=false（仅展示）时多题只出导航不出提交 */}
      {(data.answerable || multiQ) && (
        <div className="sess-interaction-foot">
          {multiQ ? (
            <div className="sess-inav">
              <button type="button" className="sess-inav-btn" disabled={pageIdx === 0}
                onClick={() => setPage(pageIdx - 1)}>‹ 上一题</button>
              {qs.map((qq, i) => (
                <button key={qq.id} type="button"
                  className={'sess-inav-dot' + (i === pageIdx ? ' on' : '')
                    + (answers[i] ? ' done' : '')}
                  title={`第 ${i + 1} 题${answers[i] ? '（已答）' : '（未答）'}`}
                  onClick={() => setPage(i)}>{i + 1}</button>
              ))}
              <button type="button" className="sess-inav-btn"
                disabled={pageIdx === qs.length - 1}
                onClick={() => setPage(pageIdx + 1)}>下一题 ›</button>
            </div>
          ) : (
            <span className="sess-interaction-hint">
              {cur.multi_select ? '可多选，选好后点「提交」' : '选择后点「提交」'}
            </span>
          )}
          {data.answerable && (
            <Button size="sm" disabled={!canSubmit}
              title={!busy && !canSubmit ? '还有题目未作答' : undefined}
              onClick={submitQuestion}>提交</Button>
          )}
        </div>
      )}
    </div>
  )
})

export default function SessionView({ task, board, withQBar = true, onUnitState,
                                     onCardColumn, onPassed }) {
  const taskId = task?.id
  const boardSid = board?.sid                 // board 模式: {projectId, sid, cid}
  const boardPid = board?.projectId
  const boardCid = board?.cid
  const [meta, setMeta] = useState(null)          // found/agents/model/session_id/totals/total 等
  const [entries, setEntries] = useState([])
  const [chatState, setChatState] = useState({ running: false })
  const [agent, setAgent] = useState('main')
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  // 回答里的路径链接（Entry 事件委托上报）当前预览的文件路径（''=不弹预览窗）
  const [previewPath, setPreviewPath] = useState('')
  const [injecting, setInjecting] = useState('')       // 排队消息「立即注入」进行中的行 key
  const [passing, setPassing] = useState(false)        // 「通过」按钮进行中（防连点）
  // 「通过」的 worktree 合并交接（2026-10-07 批次）：mergeFor=后端下发的待合并判定
  // （{branch,target,ahead,behind,dirty,dirty_count,path}），merging=交接请求进行中
  const [mergeFor, setMergeFor] = useState(null)
  const [merging, setMerging] = useState(false)
  const [deliveringAnswer, setDeliveringAnswer] = useState(false)  // 「立即送达」进行中
  // 会话回退（用户提问动作行，dsh 插件族）：copiedSeq=刚复制成功的提问 seq（图标切 ✓
  // 1.4s）；rewinding=回退中的提问 mid（防连点）；成功后就地截断 entry 列表
  const [copiedSeq, setCopiedSeq] = useState(null)
  const [rewinding, setRewinding] = useState('')
  const copyTimerRef = useRef(null)
  const [uploading, setUploading] = useState(false)    // 附件上传中（+按钮/粘贴/拖入共用）
  const [atts, setAtts] = useState([])               // 附件登记(渲染 chips 用, 元素 {md,url,abs,name,mime})
  const [pendingMsgs, setPendingMsgs] = useState([])   // 排队中的插话(乐观显示, 被会话收录后清除)
  // 会话级配置(Task 4): permMode=权限档(manual/yolo/auto；null=meta 未回读前置灰);
  // modelSel=模型乐观选择(未选时以 meta.sessionModel/项目默认兜底);
  // modelOpts=项目 agent 模型列表(模型下拉选项);
  // effortSel=思考等级乐观选择(2026-10-04；未选时以 meta.sessionEffort 兜底, ''=默认档)
  const [permMode, setPermMode] = useState(null)
  const [modelSel, setModelSel] = useState(null)
  const [modelOpts, setModelOpts] = useState({ models: [], default: '' })
  const [effortSel, setEffortSel] = useState(null)
  // / 指令 + skill 菜单: caretPos = textarea 光标位(供 token 探测, -1=未知按输入末尾);
  // slashDismissed = 菜单被 Esc/选中项关闭后的抑制态(下次输入/点击自动撤销);
  // 打开态为派生值: findSlashToken 命中且未抑制(不再要求整框以 / 开头)
  const appStoreProjects = useAppStore((s) => s.projects)
  const [caretPos, setCaretPos] = useState(-1)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashItems, setSlashItems] = useState([])     // [{key,label,desc,type}]
  // 提问索引侧边栏：本会话「用户提问 + agent 问答」混排列表，点击跳转到对应消息
  //（data-seq 锚点 + 闪烁高亮；agent 问答项额外展开提问卡与结果条，见 expandSeqs）
  const [qbarOpen, setQbarOpen] = useState(true)
  const [flashSeq, setFlashSeq] = useState(null)
  const [jumpSeq, setJumpSeq] = useState(null)   // 待跳转 seq: 交给 MessageList 扩窗定位(虚拟滚动)
  const [expandSeqs, setExpandSeqs] = useState(() => new Set())  // 跳转后要展开的条目 seq
  const flashTimerRef = useRef(null)
  const boxRef = useRef(null)
  const atBottomRef = useRef(true)
  const lastSeqRef = useRef(-1)                    // 已收到的最大 seq(增量去重)
  const sidRef = useRef('')                        // 当前推送的 session_id(探测被真实 sid 纠正时重置增量)
  const boardSidRef = useRef('')                   // board 当前会话 sid 最新值(跨会话 stale 写校验, 见下)
  const esRef = useRef(null)
  const sessionUpgradeRef = useRef(null)           // board 模式「轮询→SSE」升级回调(P4 事件化)
  const sessionDebounceRef = useRef(null)          // SSE refresh 去抖定时器
  const taRef = useRef(null)
  const autoGrowLinesRef = useRef([1, 0])   // autoGrow 节流: [上次行数, 上次长度]

  // board 模式的「运行中」来自会话端点 meta.running(卡片会话 busy);
  // 折入 taskRunning 复用现有门控/分态(inputLocked/停止按钮/回退置灰;
  // placeholder 分态 P6 起改读 meta.queue_state, 见 ComposerBar)
  const boardRunning = !!board && !!meta?.running
  const taskRunning = ['running', 'queued'].includes(task?.status) || boardRunning
  const chatRunning = !!chatState?.running
  const caps = meta?.capabilities || {}
  // dsh 宿主能力位（仅 dsh 插件面板形态非空，独立 web 形态恒 null）：决定头部信息行右侧
  // 「在 dsh 界面打开当前会话」按钮的显隐（能力位缺席=按钮不渲染，不是点了没反应）
  const dshCaps = useDshHostCaps()
  // 可打开的会话 id：board 模式取卡片当前会话 sid（弹窗内切会话/fork 后即跟随新值），
  // 任务模式取 meta 推送的 session_id（会话尚未生成时为空 → 按钮置灰）
  const dshSid = boardSid || meta?.session_id || ''
  // 2026-09-10：会话消息统一进平台队列——项目忙/任务运行中不再锁输入（发出即排队，
  // 项目空闲后按入队顺序执行），只有会话不可用(meta.found=false)才锁输入；
  // dsh 会话自身在跑时消息入宿主 inbox 排队（caps.queue；平台队列行可「立即注入」）
  const inputLocked = !meta?.found
  // 排队中消息数：发送按钮「排队」分态信号之一（「项目忙/运行中」分态 P6 起由
  // 服务端 meta.queue_state 承担——ComposerBar 直读；meta.project_busy 随轮询
  // 白名单下发保留兜底（v2c T4 移交①：本单元 idle + 项目被他单元占用时
  // ComposerBar 忙碌预测=qstate非idle || project_busy，aec7d02 实录））
  const queuedN = chatState?.queued || 0

  // 队列状态徽标（弹窗标题行，SessionView 经 onUnitState 上报给 SessionModal）：
  // kind 直取服务端 meta.queue_state（P6 七枚举——v2a T4 加 starting；判定收口
  // 服务端，含会话实况 busy
  // 与外部占用分叉；前端不再拼 unit_state 派生/boardRunning 覆盖——后端派生已含会话
  // 实况，覆盖删除后「被盖掉」问题消失），pos/total 仍由 meta.unit_state 携带
  // （queued_serial/answer_pending 两态展示真实位次）。meta 未下发（runner 缺位/
  // 异常/旧后端）→ null（不渲染）。
  // 不按 meta.found 门控：会话内容暂不可读（首轮会话未落盘/解析失败）时队列态照样有效
  const unitRawState = meta?.unit_state?.state || ''
  const unitQueueState = meta?.queue_state || ''
  const unitPos = meta?.unit_state?.pos || 0
  const unitTotal = meta?.unit_state?.total || 0
  const unitState = useMemo(() => {
    if (!unitQueueState) return null
    return { kind: unitQueueState, pos: unitPos, total: unitTotal }
  }, [unitQueueState, unitPos, unitTotal])
  // 仅依赖派生值上报：值不变时引用不变，标题行不会因 SSE/轮询 tick 反复重渲染
  useEffect(() => { if (onUnitState) onUnitState(unitState) }, [unitState, onUnitState])

  // 卡片所在列（弹窗标题行「卡片队列」徽标，board 模式；在队列态徽标之前展示）：
  // 随 2s 轮询 meta 跟随卡片移列（如通过→已完成、交互阻塞→阻塞）；meta 未下发
  // （旧后端/非卡片会话）→ ''（不渲染）。任务会话无卡片概念，恒不启用。
  const cardColumn = (board && meta?.card_column) || ''
  useEffect(() => { if (onCardColumn) onCardColumn(cardColumn) }, [cardColumn, onCardColumn])

  // 已作答·待送达（board 模式，2026-09-14）：答案已被平台收下、等项目空闲送达。
  // 输入区上方渲染「待送达」行 + 「立即送达」按钮（不等项目空闲）；仅卡片会话有
  // 该语义（任务会话作答直送）。P6 起展示判定读 meta.queue_state（服务端派生），
  // meta.answer_pending 字段保留供端点语义
  const answerPending = !!(board && meta?.queue_state === 'answer_pending')

  // 会话回退（提问动作行里的 ↺，dsh 插件族）：会话在跑/有排队时服务端必拒
  // （409，旧 SESSION_BUSY 语义），按钮置灰等空闲——覆盖任务/卡片单元在跑、会话自身在跑、
  // 平台队列与服务端队列非空；发送中（消息尚未落库）同样置灰
  const rewindEnabled = !!caps.rewind
  const rewindBusy = taskRunning || chatRunning || unitRawState === 'running'
    || queuedN > 0 || (meta?.queue?.length || 0) > 0 || sending
  // 复制 ✓ 反馈定时器卸载清理（防卸载后 setState）
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  /* ---------- / 指令 + skill 菜单 ---------- */
  // 项目行(app store): 定位当前会话所属项目的 agent_path/project_dir, 用于扫描 skill
  const pid = board ? board.projectId : task?.project_id
  const proj = appStoreProjects.find((p) => p.id === pid)

  // skills 数据: 项目 agent 能力扫描（接口已存在; 项目级 skill 目录在 project_dir 下,
  // 与 AppShell 项目弹窗同参: project_dir 优先, 无则回落 work_dir）
  useEffect(() => {
    if (!proj?.agent_path || !pid) return
    let stopped = false
    // 项目/agent 变化时先清掉旧项目的 skill, 避免新 fetch 完成前菜单混入过期项
    setSlashItems((prev) => prev.filter((x) => x.type !== 'skill'))
    projectApi.agentSkills(proj.agent_path, proj.project_dir || proj.work_dir || '')
      .then((sk) => {
        if (stopped) return
        // 后端 /api/agents/skills 返回 {skills:[{name,description,source}]}; 兼容裸数组
        const list = Array.isArray(sk) ? sk : (sk?.skills || [])
        setSlashItems((prev) => [
          ...prev.filter((x) => x.type !== 'skill'),
          ...list.map((x) => ({ key: x.name || x.id, label: x.name || x.id,
            desc: (x.description || x.summary || '').slice(0, 40), type: 'skill' }))])
      })
      .catch(() => { /* skills 拉取失败: 动作组仍可用 */ })
    return () => { stopped = true }
  }, [proj?.agent_path, pid])

  // / 指令表: 平台真实可执行项带 on()(当前环境可用性, 用于菜单显隐与 send 路由)与 run()(执行体);
  // kimi code web 命令面板同款的历史遗留占位全量置灰常显(dis:true, 描述照 kimi code web 截图, 见设计文档第四节)
  const SLASH_CMDS = [
    { key: '/stop', desc: '停止当前对话', type: 'cmd', on: () => !!caps.chat, run: stopChat },
    { key: '/compact', desc: '压缩会话历史', type: 'cmd', on: () => !!board && !!caps.compact,
      run: async () => { await boardApi.compact(boardPid, boardCid, boardSid) } },
    { key: '/new', desc: '创建新会话', type: 'cmd', dis: true },
    { key: '/clear', desc: '清空并新建会话', type: 'cmd', dis: true },
    { key: '/plan', desc: '切换计划模式 开/关', type: 'cmd', dis: true },
    { key: '/swarm', desc: '切换 swarm 模式；/swarm <任务> 直接在 swarm 下执行', type: 'cmd', dis: true },
    { key: '/goal', desc: '创建/控制目标：/goal <目标>、/goal pause|resume|cancel', type: 'cmd', dis: true },
    { key: '/btw', desc: '侧边聊天：/btw <问题> 向 fork 的侧边聊天提问', type: 'cmd', dis: true },
    { key: '/undo', desc: '撤销上一条消息', type: 'cmd', dis: true },
  ]
  // 菜单动作组: 可执行项(当前环境 on() 为真) 并集 skills; 置灰项(dis)常显
  const slashCmds = SLASH_CMDS.filter((c) => c.dis || c.on())
  // token 触发(不再要求 input.startsWith('/')): 由 input + 光标位派生菜单打开态与 query;
  // 光标未知(caretPos=-1)时按输入末尾处理(程序化插入/初始态)
  const slashToken = useMemo(() => findSlashToken(input, caretPos >= 0 ? caretPos : input.length),
    [input, caretPos])
  const slashOpen = slashToken != null && !slashDismissed
  const slashQuery = slashToken ? slashToken.text.slice(1) : ''

  // SSE 连接(切换任务/agent 时重建; total 回退说明会话被重写, 断开全量重连)
  useEffect(() => {
    if (!taskId || board) return undefined
    let stopped = false
    setMeta(null)
    setEntries([])
    setChatState({ running: false })
    setPendingMsgs([])
    setConnected(false)
    lastSeqRef.current = -1
    sidRef.current = ''

    function wireHandlers(es) {
      es.addEventListener('meta', (ev) => {
        if (stopped) return
        const m = JSON.parse(ev.data)
        // 会话对象变化(任务运行中探测出的 sid 被轮后真实 sid 纠正):
        // 重置本地增量, 随后的 entries 事件会带全量
        if (m.session_id && sidRef.current && m.session_id !== sidRef.current) {
          lastSeqRef.current = -1
          setEntries([])
        }
        if (m.session_id) sidRef.current = m.session_id
        // total 回退(会话被重写) → 重置并全量重连
        if (m.found && m.total < lastSeqRef.current + 1) { reconnect(); return }
        setMeta(m)
      })
      es.addEventListener('entries', (ev) => {
        if (stopped) return
        const d = JSON.parse(ev.data)
        if (d.total < lastSeqRef.current + 1) { reconnect(); return }
        const fresh = (d.entries || []).filter((x) => x.seq > lastSeqRef.current)
        if (!fresh.length) return
        lastSeqRef.current = fresh[fresh.length - 1].seq
        setEntries((prev) => [...prev, ...fresh])
        // 排队插话被真实会话收录(新增 user entry 含其文本)后, 清掉本地乐观 chip
        // 注: 用本次新增的 fresh 判定(此闭包内 entries 为陈旧值)
        setPendingMsgs((arr) => arr.filter((p) =>
          !fresh.some((e) => e.kind === 'user' && (e.text || '').includes(p.text.slice(0, 50)))))
      })
      es.addEventListener('chat', (ev) => {
        if (stopped) return
        setChatState(JSON.parse(ev.data))
      })
      es.onopen = () => { if (!stopped) setConnected(true) }
      es.onerror = () => { if (!stopped) setConnected(false) }
    }

    function connect() {
      const es = taskApi.sessionStream(taskId, agent)
      esRef.current = es
      wireHandlers(es)
    }

    function reconnect() {
      lastSeqRef.current = -1
      setEntries([])
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      connect()
    }

    connect()
    return () => {
      stopped = true
      if (esRef.current) { esRef.current.close(); esRef.current = null }
    }
  }, [taskId, agent])

  // board 模式: 增量拉取看板会话端点(after=已见最大 seq+1; total 回退重置重拉)。
  // P4 事件化(2026-10-03): 有推送通道的族(caps.events, 当前 dsh)改为**事件唤醒**——
  // SSE 收到 refresh(该会话任一状态帧: 逐条消息/轮次起止/交互)即拉一次增量,
  // 150ms 去抖; 2s 定时器退场, 只留 60s 兜底。无事件源的族保留原 2s 轮询。
  useEffect(() => {
    if (!boardSid) return undefined
    let stopped = false
    setMeta(null)
    setEntries([])
    setChatState({ running: false })
    setPendingMsgs([])
    setConnected(false)
    lastSeqRef.current = -1
    let es = null
    let timer = setInterval(tick, 2000)          // caps 未到时先按老口径轮询
    const schedule = () => {
      if (sessionDebounceRef.current) return
      sessionDebounceRef.current = setTimeout(() => {
        sessionDebounceRef.current = null
        tick()
      }, 150)
    }
    // caps.events 到位后作一次「升级」：关轮询定时器、开 SSE、留 60s 兜底
    sessionUpgradeRef.current = (useEvents) => {
      if (!useEvents || es) return
      clearInterval(timer)
      timer = setInterval(tick, 60000)
      try {
        es = boardApi.sessionStream(boardPid, boardSid)
        es.addEventListener('hello', schedule)
        es.addEventListener('refresh', schedule)
        // 断线由 EventSource 自动重连（重连后先收 hello），无需手工处理 onerror
      } catch { es = null }
    }
    async function tick() {
      try {
        const d = await boardApi.sessionMessages(boardPid, boardSid, lastSeqRef.current + 1, agent)
        if (stopped) return
        // total 回退(会话存储被重建) → 重置, 下一轮全量重拉
        if (d.found && d.total < lastSeqRef.current + 1) {
          lastSeqRef.current = -1
          setEntries([])
          return
        }
        const fresh = (d.entries || []).filter((x) => x.seq > lastSeqRef.current)
        if (fresh.length) {
          lastSeqRef.current = fresh[fresh.length - 1].seq
          setEntries((prev) => [...prev, ...fresh])
          // 排队评论被真实会话收录(新增 user entry 含其文本)后, 清掉本地乐观 chip
          // (board 评论带【看板评论】包装, 原文本仍被包含, includes 判定有效)
          setPendingMsgs((arr) => arr.filter((p) =>
            !fresh.some((e) => e.kind === 'user' && (e.text || '').includes(p.text.slice(0, 50)))))
        }
        // capabilities/running 由会话端点下发(按项目 agent 族); chat 态=卡片会话 busy;
        // interaction=watcher 缓存的待答交互(作答后下轮轮询自动消失);
        // family/ctx/sessionModel/queue=会话级配置与宿主 inbox 排队行
        // (dsh_plugin 才含 ctx/sessionModel/queue; queue=null 时
        // 保持上次列表——读不到 ≠ 没有排队，避免排队行闪烁);
        // unit_state=该卡片单元在统一队列中的态(位次 pos/total 数据源);
        // queue_state=服务端展示派生七枚举(弹窗标题「队列」徽标, 见 SessionModal);
        // card_column=卡片当前所在列(弹窗标题「卡片队列」徽标, 通过/移列后跟随变化)
        setMeta((prev) => ({ found: d.found, reason: d.reason, agents: d.agents,
                  agent: d.agent, total: d.total, totals: d.totals, session_id: boardSid,
                  capabilities: d.capabilities, running: d.running,
                  interaction: d.interaction,
                  family: d.family, ctx: d.ctx, permission: d.permission,
                  sessionModel: d.sessionModel, sessionEffort: d.sessionEffort,
                  unit_state: d.unit_state,
                  queue_state: d.queue_state, project_busy: d.project_busy,
                  card_column: d.card_column, answer_pending: d.answer_pending,
                  card_worktree: d.card_worktree,
                  queue: d.queue == null ? prev?.queue : d.queue }))
        setChatState(d.chat || { running: false })
        setConnected(true)
      } catch { /* 轮询容错: 下一轮再试 */
        if (!stopped) setConnected(false)
      }
    }
    tick()
    return () => {
      stopped = true
      sessionUpgradeRef.current = null
      clearInterval(timer)
      if (sessionDebounceRef.current) {
        clearTimeout(sessionDebounceRef.current)
        sessionDebounceRef.current = null
      }
      try { es?.close() } catch { /* 已关闭 */ }
    }
  }, [boardSid, boardPid, agent])

  // caps.events 到位（或切换会话后重读）时做一次升级：轮询 → SSE 事件唤醒
  useEffect(() => {
    sessionUpgradeRef.current?.(!!meta?.capabilities?.events)
  }, [meta?.capabilities?.events, boardSid])

  // board 会话切换时同步 sid 快照 ref: 回调里 await(可能秒级, 服务端冷启动更久)返回后
  // 与当前会话比对, 不一致(已切会话)则静默丢弃 state 写与 toast, 防旧请求污染新会话
  useEffect(() => { boardSidRef.current = boardSid }, [boardSid])

  // 排队消息执行失败提示（如会话忙、会话已被删除）：一条一次 toast，
  // 并清掉对应乐观 chip(按后端 msg_id 对齐)；错误记录由后端保留一段时间后回收
  const errToastedRef = useRef(new Set())
  useEffect(() => {
    const errs = (chatState?.msgs || []).filter((m) => m.state === 'error')
    if (!errs.length) return
    for (const m of errs) {
      if (errToastedRef.current.has(m.id)) continue
      errToastedRef.current.add(m.id)
      toast(`消息发送失败：${m.error || '未知原因'}`)
      if (m.id) setPendingMsgs((arr) => arr.filter((p) => p.id !== m.id))
    }
  }, [chatState])

  // 会话级配置(Task 4): board 会话打开/切换时重置选择态(meta 未回读前置灰渲染),
  // 并拉取项目 agent 模型列表(模型下拉选项与思考等级档位来源; 与 AppShell 项目弹窗同端点,
  // dsh-plugin: 前缀由后端识别)
  useEffect(() => {
    setPermMode(null)
    setModelSel(null)
    setEffortSel(null)
    if (!boardSid) return undefined
    let stopped = false
    if (proj?.agent_path) {
      projectApi.agentModels(proj.agent_path)
        .then((r) => { if (!stopped) setModelOpts(r || { models: [], default: '' }) })
        .catch(() => { if (!stopped) setModelOpts({ models: [], default: '' }) })
    } else {
      setModelOpts({ models: [], default: '' })
    }
    return () => { stopped = true }
  }, [boardSid, proj?.agent_path])

  // meta 轮询回读后同步权限档/模型/思考等级显示: 权限档(manual/yolo/auto, 服务端按
  // DSH_PERMISSION_PRESETS 映射)、当前模型与思考等级(dsh reasoningEffort)回读,
  // 与乐观切换结果对齐(服务端异常时轮询回读兜底, 不变则无操作)
  useEffect(() => {
    if (meta?.permission != null) setPermMode(meta.permission)
    if (meta?.sessionModel) setModelSel(meta.sessionModel)
    // sessionEffort 缺键＝宿主还没报（不是「没有档位」）⇒ 只在有值时覆盖乐观值
    if (meta?.sessionEffort) setEffortSel(meta.sessionEffort)
  }, [meta?.permission, meta?.sessionModel, meta?.sessionEffort])

  // 思考等级档位选项（2026-10-04）：按当前**模型**从模型目录取（宿主模型目录只会上报
  // 该模型真正支持的档位）；模型未知/目录无档位信息时回落内置档位表（见 utils/sessionEffort）。
  // 注意取的是模型值（modelSel/meta.sessionModel），不是档位值——档位只用来定当前选中项。
  const effortOpts = useMemo(
    () => effortChoices(modelOpts, modelSel || meta?.sessionModel || modelOpts?.default || ''),
    [modelOpts, modelSel, meta?.sessionModel])

  // 新消息到达时贴底跟随(本来不在底部则不动) —— 已内聚到 MessageList 组件
  const onScroll = useCallback(() => {
    const box = boxRef.current
    atBottomRef.current = box
      ? box.scrollHeight - box.scrollTop - box.clientHeight < 60 : true
  }, [])

  /* ---------- 排队消息列表（2026-09-10） ---------- */
  // 三路来源合并去重（按文本前 40 字对齐）：
  //   1) meta.queue —— dsh 宿主 inbox 排队行（**只展示**：宿主行不带平台 msg_id，
  //      不提供「立即注入」）
  //   2) chat.msgs  —— 平台统一队列消息单元（queued/running；带 msg_id → 可「立即注入」，
  //      撤销排队直接投递进会话当前上下文，见 injectQueued）
  //   3) pendingMsgs —— 本地乐观 chip（服务端尚未收录时的即时反馈）
  // 行 tag 文案按 state 分离（P6）：server=服务端排队 / running=发送中 / 其余=排队中
  // （渲染在 ComposerBar；三路合并本体不变——消息行非徽标，不经 queue_state）
  const queueRows = useMemo(() => {
    const out = []
    const taken = []
    const dup = (text) => taken.some((t) => t && text
      && t.slice(0, 40) === text.slice(0, 40))
    for (const q of (meta?.queue || [])) {
      if (!q?.text) continue
      out.push({ key: 'k' + q.id, text: q.text, msgId: '', state: 'server' })
      taken.push(q.text)
    }
    for (const m of (chatState?.msgs || [])) {
      if (m.state === 'error' || !m.text || dup(m.text)) continue
      out.push({ key: 'm' + m.id, text: m.text, msgId: m.id, state: m.state })
      taken.push(m.text)
    }
    for (const p of pendingMsgs) {
      if (!p.text || dup(p.text)) continue
      out.push({ key: 'p' + (p.id || p.ts), text: p.text,
                 msgId: p.id || '', state: 'pending' })
      taken.push(p.text)
    }
    return out
  }, [meta?.queue, chatState, pendingMsgs])

  /* ---------- 提问索引侧边栏 ---------- */
  // 本会话索引：用户提问（kind='user'）+ agent 问答（kind='ask'，锚定 ask_user_question
  // 那条；回答取配对的 tool_result，未答/中断为占位）混排按 seq 升序；随增量更新。
  // 派生规则与回答文本解析全在 utils/sessionQa（纯函数，单测覆盖）
  const questions = useMemo(() => buildQuestionIndex(entries), [entries])
  // 点击提问项 → 交给 MessageList 扩窗定位（虚拟滚动下目标可能不在渲染窗口内），
  // 定位完成后回调 onJumpHandled 闪烁高亮（data-seq 锚点）。
  // agent 问答项额外登记要展开的条目（提问条 + 配对的结果条）——否则落点只是一行折叠的
  // `ask_user_question` 标题；登记集每次跳转整体替换（只保留本次目标，避免旧目标反复自动展开）
  const jumpTo = useCallback((item) => {
    const q = (item && typeof item === 'object') ? item : { seq: item, kind: 'user' }
    setExpandSeqs(q.kind === 'ask'
      ? new Set([q.seq, q.ansSeq].filter((s) => s != null)) : new Set())
    setJumpSeq(q.seq)
  }, [])
  const onJumpHandled = useCallback((seq) => {
    setJumpSeq(null)
    setFlashSeq(seq)
    clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashSeq(null), 1600)
  }, [])

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    // 节流: 行数未变且长度增量不足折一行(40 字符)时跳过测量 ——
    // 读 scrollHeight 会触发同步布局(特大消息 DOM 下每键一次数 ms), 逐键测量无必要
    const lines = ta.value.split('\n').length
    const len = ta.value.length
    const [pl, pn] = autoGrowLinesRef.current
    if (lines === pl && Math.abs(len - pn) < 40) return
    autoGrowLinesRef.current = [lines, len]
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'
  }

  /* ---------- 附件上传（+按钮/粘贴/拖入共用） ---------- */
  // 读取文件 → base64 上传 → 光标处插入 markdown（图片 ![名](abs) / 文件 [名](abs)）
  async function uploadFiles(files) {
    const list = Array.from(files || [])
    if (!list.length || uploading) return
    const pid = board ? board.projectId : task?.project_id
    if (!pid) return
    for (const f of list) {
      if (f.size > 10 * 1024 * 1024) { toast(`附件过大（>10MB）：${f.name}`); continue }
      // 占位图拦截（1x1/2x2 一类极小图，见 utils/media.js）：来源应用没给有效截图，跳过并提示
      if (await isPlaceholderImage(f)) {
        toast(`已跳过占位图（极小尺寸）：${f.name}（剪贴板里不是有效截图，请重新截图或改用「+」选文件）`)
        continue
      }
      setUploading(true)
      try {
        const data = await new Promise((res, rej) => {
          const fr = new FileReader()
          fr.onload = () => res(String(fr.result || '').split(',')[1] || '')
          fr.onerror = () => rej(new Error('文件读取失败'))
          fr.readAsDataURL(f)
        })
        const r = await boardApi.uploadMedia(pid, {
          name: f.name, mime: f.type || 'application/octet-stream', data })
        // 会话消息引用磁盘绝对路径：agent 进程本机直读；url 仅作展示回退
        const md = (f.type || '').startsWith('image/')
          ? `![${f.name}](${r.abs || r.url})`
          : `[${f.name}](${r.abs || r.url})`
        // 登记附件 chips(图片 chip 缩略图用媒体端点 url——裸 /api/... 经 mediaDisplayUrl 补
        // 同源根前缀, 否则插件形态下打到 dsh 宿主根 401 不显示; 渲染时按 md 是否仍在输入框过滤)
        setAtts((prev) => [...prev, { md, url: mediaDisplayUrl(r.url), abs: r.abs, name: f.name, mime: f.type }])
        const ta = taRef.current
        if (ta && document.activeElement === ta && ta.selectionStart != null) {
          const s = ta.selectionStart, e2 = ta.selectionEnd
          // 函数式更新读最新值：上传期间用户继续输入不丢字（对齐 BoardDetail 模式）
          setInput((prev) => prev.slice(0, s) + md + prev.slice(e2))
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = s + md.length
            setCaretPos(s + md.length)   // 同步光标位: / 菜单 token 探测依据
          })
        } else {
          setInput((prev) => (prev ? prev + '\n' : '') + md + '\n')
          setCaretPos(-1)   // 输入框未聚焦: 光标未知, 按输入末尾处理
        }
        autoGrow()
        toast(`已添加附件：${f.name}`)
      } catch (e) { toast(e.message || '附件上传失败') }
      finally { setUploading(false) }
    }
  }

  function onPasteFiles(e) {
    const items = Array.from(e.clipboardData?.items || [])
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile()).filter(Boolean)
    if (!files.length) return
    e.preventDefault()  // 有文件时不落文本，全走上传通道
    uploadFiles(files)
  }
  function onDropFiles(e) {
    const files = Array.from(e.dataTransfer?.files || [])
    if (!files.length) return
    e.preventDefault()
    uploadFiles(files)
  }

  async function send() {
    const msg = input.trim()
    if (!msg || sending || inputLocked) return
    // / 开头本地命令路由(控制方裁定 3): 仅拦截「纯命令行且命中 SLASH_CMDS」的输入;
    // 未命中命令表的 /xxx 文本仍按普通消息发送, 不吞用户消息
    if (/^\/[\w-]+$/.test(msg)) {
      const c = SLASH_CMDS.find((x) => x.key === msg)
      if (c) {
        // 命中: 置灰/当前环境不可用 → toast 提示并保留输入; 可执行 → 执行指令(清输入+toast)
        if (c.dis || !(c.on && c.on())) { toast(`当前环境不支持 ${msg}`); return }
        setInput(''); setCaretPos(0); requestAnimationFrame(autoGrow)
        try {
          const ok = await c.run()
          if (ok === false) return   // 失败: 被调方已 toast(stopChat 语义)
          toast(`已执行 ${msg}`)
        }
        catch (e) { toast(e.message || `指令执行失败：${msg}`) }
        return   // 命令路由路径均不发送
      }
    }
    setSending(true)
    try {
      if (board) {
        // board 模式: 先存评论再投递主会话(投递记录回卡片详情可见);
        // raw=true 直发原文——本就在会话中对话, 不加【看板评论】任务前缀;
        // 2026-09-19 起不再带 inject(底栏「立即注入」勾选框已移除): 发送即排队,
        // 运行中要立刻插话改由排队行的「立即注入」按钮(平台队列 inject 端点);
        // 项目忙则后端排队(queued=true)
        const c = await boardApi.addComment(boardPid, boardCid, msg)
        const r = await boardApi.sendComment(boardPid, boardCid, c.id, false, true)
        if (r?.queued) setPendingMsgs((arr) => [...arr, {
          text: msg, ts: Date.now(), id: r.msg_id || '' }])
      } else {
        // 发送即排队(后端登记统一队列消息单元), queued=true 时本地乐观登记「排队中」chip
        const r = await taskApi.sessionChat(taskId, msg)
        if (r?.queued) setPendingMsgs((arr) => [...arr, {
          text: msg, ts: Date.now(), id: r.msg_id || '' }])
      }
      setInput('')
      atBottomRef.current = true
      requestAnimationFrame(autoGrow)
    } catch (e) { toast(e.message) } finally { setSending(false) }
  }

  async function stopChat() {
    try {
      // board 模式: 停卡片运行中的会话(卡片级操作); 任务模式: 停进行中的对话进程
      if (board) {
        const r = await boardApi.stopCard(boardPid, boardCid)
        // 后端 stopped=false：会话未在运行或中断失败——如实提示，不假装已停
        if (r && r.stopped === false) { toast('该会话未在运行或无法停止'); return false }
      } else await taskApi.sessionChatStop(taskId)
      // 停止同时取消排队中的消息（后端 chat.stop / stop_card 同语义）：清掉乐观 chip
      setPendingMsgs([])
      return true
    } catch (e) { toast(e.message); return false }
  }

  /* ---------- 会话级配置(Task 4): 权限档/模型切换(仅 board + caps.permission/profile 可交互) ---------- */
  // 权限档切换（三档）：manual 逐条确认 / yolo 自动通过 /
  // auto 完全自主（档位文案与枚举出处 kimi web 客户端，见 kimi-code 仓库；服务端按 DSH_PERMISSION_PRESETS 映射）；切换即
  // 调 profile 端点即时生效，乐观回显 + 轮询回读兜底（sid 快照防 stale 写）
  async function onSetPermission(mode) {
    if (!mode || mode === permMode) return
    const sid = boardSid               // 发起时会话标识: await 后仍是当前会话才写 state/toast
    try {
      await boardApi.setSessionProfile(boardPid, sid, { permission_mode: mode })
      if (sid !== boardSidRef.current) return   // 已切会话: 旧请求结果静默丢弃(防 stale 写)
      setPermMode(mode)
      toast(`权限已切换：${(PERM_OPTS.find((o) => o.value === mode) || {}).label || mode}`)
    } catch (e) {
      if (sid === boardSidRef.current) toast(e.message)
    }
  }
  // 模型切换: 直改会话 profile(即时生效); 乐观回显, 下轮轮询回读兜底(sid 快照防 stale 写)
  async function onSetModel(m) {
    const sid = boardSid
    try {
      await boardApi.setSessionProfile(boardPid, sid, { model: m })
      if (sid !== boardSidRef.current) return
      setModelSel(m)
      toast(`模型已切换：${m}`)
    } catch (e) {
      if (sid === boardSidRef.current) toast(e.message)
    }
  }
  // 思考等级切换（2026-10-04）：看板卡走卡片 profile 端点、任务走任务 session profile 端点
  // （任务侧只开这一项，模型/权限档仍任务级/看板级）。乐观回显 + 轮询回读兜底。
  // 空值（默认档哨兵）不提交——哨兵项本就置灰不可选，这里再兜一层。
  async function onSetEffort(v) {
    if (!v || v === '__default__' || v === effortSel) return
    const sid = boardSid
    try {
      if (board) await boardApi.setSessionProfile(boardPid, sid, { reasoning_effort: v })
      else await taskApi.sessionProfile(taskId, { reasoning_effort: v })
      if (sid && sid !== boardSidRef.current) return   // 已切会话: 旧请求结果静默丢弃
      setEffortSel(v)
      toast(`思考等级已切换：${effortText(v)}`)
    } catch (e) {
      if (!sid || sid === boardSidRef.current) toast(e.message)
    }
  }

  /* ---------- 交互作答 / 排队注入 / 通过（2026-09-10） ---------- */
  // 作答等待中的提问或审批: board 走卡片端点, 任务走任务端点(probe 后同一套
  // 白名单校验); body 形态见 InteractionCard 与 server 端点注释
  async function answerInteraction(body) {
    try {
      const r = board
        ? await boardApi.answerInteraction(boardPid, boardCid, body)
        : await taskApi.answerInteraction(taskId, body)
      toast(r && r.queued
        ? '已提交答案：项目忙，等待空闲后自动送达'
        : '已回答')
    } catch (e) { toast(e.message) }
  }
  // 排队消息「立即注入」：平台统一队列消息单元（msgId）——撤销排队并立即投递到
  // 会话当前上下文（会话有运行中的轮次则注入该轮，空闲则立即起轮），不再等项目空闲。
  // dsh 宿主 inbox 排队行（meta.queue）不带平台 msg_id，只展示、不提供注入。
  async function injectQueued(row) {
    if (!row?.msgId) return
    setInjecting(row.key)
    try {
      if (board) await boardApi.injectSessionMsg(boardPid, boardSid, row.msgId)
      else await taskApi.sessionChatInject(taskId, row.msgId)
      toast('已注入当前上下文')
      // 平台排队行随下轮轮询消失（后端已标记完成）；乐观 chip 按 msg_id 立即清掉
      setPendingMsgs((arr) => arr.filter((p) => p.id !== row.msgId))
    } catch (e) { toast(e.message) } finally { setInjecting('') }
  }
  // 「立即送达」：已作答·待送达的答案不等项目空闲，直接交给等待中的会话
  // （board 卡片端点；送达成功后卡片解除排队占位，下轮轮询 answer_pending 归 False）
  async function deliverAnswer() {
    setDeliveringAnswer(true)
    try {
      await boardApi.deliverAnswer(boardPid, boardCid)
      toast('已送达答案')
    } catch (e) { toast(e.message) } finally { setDeliveringAnswer(false) }
  }
  // 通过: 把当前卡片移入「已完成」列（看板语义同款；卡片在跑则会先停会话），
  // 成功后关闭会话详情弹窗（onPassed 由弹窗壳传入；toast 在关闭后照常展示）
  // 2026-10-07 批次：独立 worktree 卡先查有没有待合并提交（看板卡片同款口径）——
  // 有则弹合并交接框（交给 agent 合并 / 仅通过），没有才直接完成
  async function passCard() {
    setPassing(true)
    try {
      if (board && meta?.card_worktree) {
        let p = null
        try { p = await boardApi.worktreePreview(boardPid, boardCid) } catch (e) { p = null }
        if (p && p.merge && p.merge.ahead > 0) { setMergeFor(p.merge); return }
      }
      await boardApi.moveCard(boardPid, boardCid, 'done')
      toast('已通过，卡片移入「已完成」')
      if (onPassed) onPassed()
    } catch (e) { toast(e.message) } finally { setPassing(false) }
  }
  // 交给 agent 合并（worktree 改动回流主分支）：平台只投递指令 + 让卡片回开发队列
  // 排队；合并由 agent 执行（先同步主分支、尽量快进、冲突自己解）。干完这轮卡片自动
  // 回「待审核」，本弹窗不关闭——用户可以在会话窗里看这一轮怎么合的
  async function handoffMerge() {
    setMerging(true)
    try {
      await boardApi.mergeWorktree(boardPid, boardCid)
      setMergeFor(null)
      toast('已交给 agent 合并：卡片回到开发队列排队，完成后自动回「待审核」')
    } catch (e) { toast(e.message) } finally { setMerging(false) }
  }
  // 仅通过（不合并）：带 merge_ack 再走一次 move（后端跳过待合并闸，分支与工作树保留）
  async function passWithoutMerge() {
    setMergeFor(null)
    setPassing(true)
    try {
      await boardApi.moveCard(boardPid, boardCid, 'done', undefined, null, true)
      toast('已通过，卡片移入「已完成」')
      if (onPassed) onPassed()
    } catch (e) { toast(e.message) } finally { setPassing(false) }
  }
  // 回答里的路径链接（Entry 事件委托上报）→ 打开文件预览弹窗。
  // 稳定引用：MessageList/Entry 均为 memo，回调换引用会让整棵消息子树重渲染
  const openPreview = useCallback((p) => setPreviewPath(p || ''), [])
  // 复制某条提问原文（含附件 markdown 引用，原样复制；kimi web 同款：图标切 ✓ 1.4s）
  function copyEntry(e) {
    const text = e?.text || ''
    if (!text.trim()) return
    const p = navigator.clipboard?.writeText(text)
    if (p && p.catch) p.catch(() => toast('复制失败：浏览器未授予剪贴板权限'))
    setCopiedSeq(e.seq)
    clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedSeq(null), 1400)
  }
  // 回退到该提问之前（dsh 插件族）：确认 → 服务端按边界 fork 出新会话并 rebind →
  // 原提问回填输入框 + 立即重拉消息。只回退对话上下文（宿主无原地 undo，等价实现
  // 是按 seq 边界 fork；不回退文件改动）；
  // 服务端按提问的 anchor 消息 id 定边界（含界面不展示的 slash 锚点）。
  // 注：入口在会话忙时已置灰，此处 busy 只作兜底（服务端 409 带原因）
  async function rewindEntry(e) {
    const mid = e?.mid || ''
    if (!mid || rewinding) return
    const n = entries.filter((x) => x.kind === 'user' && x.seq >= e.seq).length
    const excerpt = (e.text || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!window.confirm(`回退到该提问之前？\n\n将撤销该提问及其后共 ${n} 轮对话：\n${excerpt}${excerpt.length >= 60 ? '…' : ''}\n\n只回退对话上下文，不回退文件改动；此操作不可撤销。`)) return
    setRewinding(mid)
    try {
      // dsh 没有原地 undo：服务端按边界 fork 出新会话并回 new_session_id。
      // 看板模式通知父组件切到新会话（历史已复制到该点，
      // 本地截断视图与新会话内容一致）；任务模式服务端已重绑任务会话，SSE 凭 total
      // 回退自动重拉，这里无需切换。
      const r = board ? await boardApi.rewindSession(boardPid, boardSid, mid)
                      : await taskApi.sessionRewind(taskId, mid)
      if (r?.new_session_id && !r.rebound) {
        toast(`已回退 ${n} 轮对话：历史已复制为新会话，正在切换`)
        onSwitchSession?.(r.new_session_id)
      } else {
        toast(`已回退 ${n} 轮对话，原提问已回填输入框`)
      }
      setInput(e.text || '')      // kimi web 同款：被撤销的提问回填输入框，可改写后重发
      // 乐观截断：被回退的提问及其后条目立即从本地移除（截断点前的 seq 不变），
      // 不闪空态/不留残影；增量基点退到截断点，服务端后续增量从该点继续追加
      // （SSE 游标在 total 回退时由服务端归零重发，本端凭 total 判据重置重拉）
      setEntries((prev) => prev.filter((x) => x.seq < e.seq))
      lastSeqRef.current = e.seq - 1
      autoGrow()
    } catch (err) {
      toast(`回退失败：${err?.message || '未知原因'}`)
    } finally {
      setRewinding('')
    }
  }

  /* ---------- 输入区回调(ComposerBar 为纯展示组件, 行为逻辑留在本组件) ---------- */
  // 附件移除: chips 仅投影, 操作落在输入框文本上(删首个精确匹配的 markdown 片段)
  function onRemoveAtt(md) {
    setInput((prev) => prev.replace(md, ''))
  }
  // 光标位同步: 点击/键盘移动后重算 token(挂原生监听, 不新增 ComposerBar 透传);
  // 点击同时撤销菜单关闭态(用户重新投入编辑)
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return undefined
    const onCaret = () => setCaretPos(ta.selectionStart ?? 0)
    const onClick = () => { setCaretPos(ta.selectionStart ?? 0); setSlashDismissed(false) }
    ta.addEventListener('keyup', onCaret)
    ta.addEventListener('click', onClick)
    return () => { ta.removeEventListener('keyup', onCaret); ta.removeEventListener('click', onClick) }
  }, [caps.chat])
  // 输入变化: 同步输入框 + 光标位 + / 菜单打开态(token 派生, 打字撤销关闭态) + textarea 自适应高度
  function onComposerChange(v) {
    setInput(v)
    setCaretPos(taRef.current?.selectionStart ?? v.length)
    setSlashDismissed(false)
    autoGrow()
  }
  // SlashMenu 选中: cmd/skill 均只作 token 替换(光标置于插入文本后), 不执行 run!
  // 执行走 send() 本地路由, 由用户手动 Enter 触发; 菜单随即关闭(选中置抑制态)
  function onSlashSelect(it) {
    if (!slashToken) return
    const ins = it.type === 'skill' ? `使用 skill「${it.label}」` : it.key
    setSlashDismissed(true)
    setInput((prev) => prev.slice(0, slashToken.start) + ins
      + prev.slice(slashToken.start + slashToken.text.length))
    const pos = slashToken.start + ins.length
    setCaretPos(pos)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) ta.selectionStart = ta.selectionEnd = pos
    })
    autoGrow()
  }
  // SlashMenu 置灰项(dis)点击/回车: 提示当前环境不支持, 不动输入
  function onSlashDisabled(it) {
    toast(`当前环境不支持 ${it.key}`)
  }

  const agents = meta?.agents || []
  const totals = meta?.totals
  const totalsText = totals && meta?.found ? [
    `共 ${meta.total} 条`,
    totals.input ? `↑${fmtTokens(totals.input)}` : '',
    totals.output ? `↓${fmtTokens(totals.output)}` : '',
    totals.cache_read ? `缓存 ${fmtTokens(totals.cache_read)}` : '',
    fmtDur(totals.duration_ms),
  ].filter(Boolean).join(' · ') : ''

  return (
    <div className="sess-view">
      <div className="sess-wrap">
        {/* 提问索引侧边栏（仅弹窗版；列表=本会话用户提问 + agent 问答，点击跳转对应消息） */}
        <QuestionBar withQBar={withQBar} qbarOpen={qbarOpen}
          questions={questions} flashSeq={flashSeq} onJump={jumpTo} />
        <div className="sess-main">
      {/* 头部信息行: 连接状态/session/模型/agent 切换/totals */}
      <div className="sess-sub">
        {withQBar && (
          <button type="button" className="sess-qbar-toggle" title={qbarOpen ? '收起提问索引' : '展开提问索引'}
            onClick={() => setQbarOpen((v) => !v)}>
            <List className="h-3.5 w-3.5" />
          </button>
        )}
        <span className={'sess-conn' + (connected ? ' on' : '')}
          title={connected ? 'SSE 已连接（实时更新）' : '连接中断，自动重连中…'}></span>
        {meta?.session_id && (
          <span className="sess-chip mono" title={meta.session_id}>
            {meta.session_id.replace(/^session_/, '').slice(0, 8)}
          </span>
        )}
        {meta?.model && <span className="sess-chip">{meta.model}</span>}
        {agents.length > 1 && (
          <span className="sess-agents">
            {agents.map((a) => (
              <button key={a.id} type="button"
                className={'sess-agent' + ((meta?.agent || agent) === a.id ? ' on' : '')}
                onClick={() => setAgent(a.id)}>
                {a.id}{a.type === 'sub' ? ' (子)' : ''}
              </button>
            ))}
          </span>
        )}
        <span style={{ flex: 1 }}></span>
        {/* 在 dsh 界面打开当前会话（仅 dsh 插件面板形态渲染；独立 web 形态宿主桥不应答
            caps，按钮不存在）：宿主半收请求后调 uiWorkspace.openSession 在 dsh 主界面
            显示该会话，同时关掉 Touchstone 全屏面板，与看板卡片上那枚 ⧉ 同一条桥
            （契约见 spec/dsh_plugin/dsh插件形态.md §13） */}
        {!!dshCaps?.openSession && (
          <Button size="sm" variant="ghost" className="sess-open-dsh"
            title={dshSid ? '在 dsh 界面打开当前会话' : '尚无会话'}
            disabled={!dshSid}
            onClick={() => openSessionInDsh(dshSid)}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        )}
        {/* 通过：把当前任务（卡片）移入「已完成」列（看板同语义——卡片在跑会先停会话，
            标题加 -- 前缀；仅在 正在开发/待审核 列显示） */}
        {board && ['doing', 'review'].includes(board.column) && (
          <Button size="sm" variant="outline" className="sess-pass" disabled={passing}
            title="通过：卡片移入「已完成」" onClick={passCard}>
            <Check className="h-3.5 w-3.5" /> 通过
          </Button>
        )}
        {totalsText && <span className="sess-totals" title="输入 / 输出 / 缓存读取 / 总耗时">{totalsText}</span>}
      </div>

      {/* 消息流(窗口化虚拟滚动: 只渲染视口附近条目) */}
      <MessageList entries={entries} metaNull={!meta} found={!!meta?.found} reason={meta?.reason}
        taskId={taskId} agent={meta?.agent || agent} pid={board ? boardPid : pid}
        boardPid={board ? boardPid : ''} boardSid={board ? boardSid : ''}
        flashSeq={flashSeq} expandSeqs={expandSeqs} chatRunning={chatRunning} exitCode={chatState?.exit_code}
        boxRef={boxRef} atBottomRef={atBottomRef} onScroll={onScroll}
        jumpSeq={jumpSeq} onJumpHandled={onJumpHandled}
        rwEnabled={rewindEnabled} rwBusy={rewindBusy} rewindingMid={rewinding}
        copiedSeq={copiedSeq} onCopy={copyEntry} onRewind={rewindEntry}
        onOpenPath={openPreview} />

      {/* 等待回答 / 待审批交互卡片（board 与任务会话通用）：对齐 kimi code（设计出处）——
          选项+描述+「其他…」自定义输入+提交；审批 批准/本会话内批准/拒绝；
          answerable=false 时仅展示问题（不出按钮） */}
      {meta?.interaction?.pending && (
        <InteractionCard data={meta.interaction} answer={answerInteraction} />
      )}
      {/* 输入区(复刻 kimi web 的圆角 composer); 按 capabilities.chat 门控
          (不支持对话的族不出输入区; board 模式走评论投递主会话); 抽为 ComposerBar 纯展示组件 */}
      {caps.chat && (
        <ComposerBar
          value={input}
          onChange={onComposerChange}
          atts={atts}
          onRemoveAtt={onRemoveAtt}
          uploading={uploading}
          inputLocked={inputLocked}
          caps={caps}
          meta={meta}
          onSend={send}
          onStop={stopChat}
          chatRunning={chatRunning}
          taskRunning={taskRunning}
          queuedN={queuedN}
          board={board}
          sending={sending}
          permMode={permMode}
          modelSel={modelSel}
          modelOpts={modelOpts}
          onSetModel={onSetModel}
          onSetPermission={onSetPermission}
          effortSel={effortSel}
          effortOpts={effortOpts}
          onSetEffort={onSetEffort}
          queueRows={queueRows}
          injecting={injecting}
          onInject={injectQueued}
          answerPending={answerPending}
          deliveringAnswer={deliveringAnswer}
          onDeliverAnswer={deliverAnswer}
          slashOpen={slashOpen}
          slashQuery={slashQuery}
          slashItems={[...slashCmds, ...slashItems]}
          onSlashSelect={onSlashSelect}
          onSlashClose={() => setSlashDismissed(true)}
          onSlashDisabled={onSlashDisabled}
          onPasteFiles={onPasteFiles}
          onDropFiles={onDropFiles}
          onUploadFiles={uploadFiles}
          taRef={taRef}
        />
      )}
        </div>{/* /sess-main */}
      </div>{/* /sess-wrap */}
      {/* 文件预览弹窗（回答里的路径链接点击打开） */}
      {previewPath && (board ? boardPid : pid) && (
        <FilePreview pid={board ? boardPid : pid} path={previewPath}
          onClose={() => setPreviewPath('')} />
      )}
      {/* 通过前的 worktree 合并交接（2026-10-07 批次，与看板卡片同款弹框）：
          卡片跑在独立 worktree 里、还有提交没回流主分支时弹出 */}
      <MergeHandoffDialog open={!!mergeFor} info={mergeFor} busy={merging}
        disabledReason={(meta?.running || chatState?.running)
          ? '会话运行中：等这一轮跑完，或先点「停止」再交接' : ''}
        onHandoff={handoffMerge} onPass={passWithoutMerge}
        onClose={() => !merging && setMergeFor(null)} />
    </div>
  )
}

