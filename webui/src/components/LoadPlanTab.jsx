// 「压测方案」页：方案文档（plan.md）阅读器 + 执行载体源码 + 图表声明 + 指标口径速查
//
// 只读方案包（GET /load/case，走 _owned_task 鉴权）；没有 plan.md 时给出占位提示，
// 不当失败处理（存量任务没有方案文档，但要能看场景与图表声明）。
//
// 2026-10-06 方案页美化批次（方案见 doc_ai/plan/202610/）：
//   ① 排版基座修正——此前 `<article class="lp-plan-doc md-body">` 把两个类放在**同一个**
//      元素上，而 CSS 全部写成后代选择器 `.lp-plan-doc .md-body h2`，一条都没命中；
//      叠加 Tailwind preflight 的 heading/list 归零，整篇 plan.md 渲染成了「一堵无格式文字墙」。
//      现在外壳容器与正文元素分离，正文用统一的 `.md-body` 排版基座。
//   ② 文档化阅读：抬头标题栏（doc 自带的键值抬头）+ 左侧章节导引轨（滚动定位）+
//      表格横向滚动容器 + 章节序号金色化。
//   ③ renderDoc（utils/renderDoc.js）承担「文档级」变换；renderMd 仍是纯行级渲染。
import { useEffect, useMemo, useRef, useState } from 'react'
import { taskApi } from '../api'
import { renderDoc } from '../utils/renderDoc'
import { absToMedia, projectRoots } from '../utils/mediaText'
import { useAppStore } from '../stores/app'
import { t, useI18n } from '../utils/i18n'

// 驱动类型 → 展示文案（机器值 script/scenario/legacy_scenario 不翻译）
function driverLabel(driver) {
  if (driver === 'script') return t('自定义脚本（run.py）')
  if (driver === 'scenario') return t('声明式场景（scenario.json）')
  if (driver === 'legacy_scenario') return t('存量场景（旧布局 load/scenario_<id>.json）')
  return driver
}

/** 可折叠块（原生 details，避免为一段折叠再引组件） */
function Fold({ title, note, children }) {
  return (
    <details className="lp-fold">
      <summary>
        <span className="lp-fold-t">{title}</span>
        {note && <span className="lp-fold-n">{note}</span>}
      </summary>
      <div className="lp-fold-body">{children}</div>
    </details>
  )
}

export default function LoadPlanTab({ task }) {
  // 订阅语言切换（lang 变化即重渲染；文案用模块级 t 按当前语言求值）
  useI18n()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [active, setActive] = useState('')
  const bodyRef = useRef(null)

  // 任务切换或状态翻转（agent 轮后产出方案）时重取
  useEffect(() => {
    if (!task?.id) return undefined
    let dead = false
    setErr('')
    taskApi.loadCase(task.id)
      .then((x) => { if (!dead) setD(x) })
      .catch((e) => { if (!dead) setErr(e.message) })
    return () => { dead = true }
  }, [task?.id, task?.status])

  // 文档级渲染：标题/抬头/目录/表格滚动容器（plan_md 不变时结果稳定，不做重复解析）。
  // 方案正文里的本地图片引用先经 absToMedia 改写（2026-10-16）：agent 写的截图落在项目根内
  // 时走 `file?inline=1`，否则浏览器会把 `/opt/…` 当同源路径请求（404、图不显示）
  const projects = useAppStore((s) => s.projects)
  const pid = task?.project_id
  const mdRoots = useMemo(() => projectRoots(projects, pid), [projects, pid])
  const doc = useMemo(
    () => renderDoc(absToMedia(d?.plan_md || '', pid, { roots: mdRoots }), { extractHeader: true }),
    [d?.plan_md, pid, mdRoots])

  // 导引轨高亮：取「已滚过阅读线」的最后一个章节（滚动容器顶部 + 120px 为阅读线）。
  // 不用 IntersectionObserver：正文在页内滚动容器里、抬头又占去一屏上沿，观察带很难同时
  // 满足「首屏有高亮」与「滚动不跳号」；直接按 rect 判定既确定又好验证。
  useEffect(() => {
    const root = bodyRef.current
    const outline = doc.outline
    if (!root || !outline.length) { setActive(''); return undefined }
    const heads = outline.map((s) => root.querySelector('#' + s.id)).filter(Boolean)
    if (!heads.length) { setActive(''); return undefined }
    // 向上找第一个「真的在纵向滚动」的祖先（压测面板的 tab 内容区），找不到就按视口算
    let scroller = root.parentElement
    while (scroller && scroller !== document.body
      && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
        && scroller.scrollHeight > scroller.clientHeight + 20)) {
      scroller = scroller.parentElement
    }
    let raf = 0
    const pick = () => {
      raf = 0
      const line = (scroller ? scroller.getBoundingClientRect().top : 0) + 120
      let cur = heads[0]
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= line) cur = h
        else break
      }
      setActive(cur.id)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(pick) }
    pick()
    const target = scroller || window
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [doc])

  /** 跳到某章节（尊重系统「减少动态效果」设置） */
  function goTo(id) {
    const el = bodyRef.current?.querySelector('#' + id)
    if (!el) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    setActive(id)
  }

  if (err) return <div className="hint">{t('方案读取失败：{msg}', { msg: err })}</div>
  if (!d) return <div className="hint">{t('正在读取方案包…')}</div>

  const chartsText = d.charts ? JSON.stringify(d.charts, null, 2) : ''
  const sections = (doc.outline || []).filter((s) => s.level >= 2 && s.level <= 3)
  const title = doc.title || task?.name || t('任务 #{id}', { id: task?.id })
  // 正文结构体检：长文却没有标题/列表/表格 ⇒ 多半是「纯文本方案」。页面只渲染 markdown，
  // 这类方案会挤成一整段；模板已把格式定为硬要求，这里把它显式指出来（属提示，不阻断）。
  const flatDoc = d.plan_found && (d.plan_md || '').length > 400
    && !doc.outline.length && !/<(ul|ol|table)[ >]/.test(doc.html)
  return (
    <div className="lp-plan">
      {flatDoc && (
        <div className="hint lp-warn">
          {t('这份方案正文没有 markdown 结构（无标题 / 列表 / 表格）——页面只渲染 Markdown，纯文本方案会挤成一整段；建议让 agent 按《方案文档模板》重写 plan.md。')}
        </div>
      )}
      <div className={'lp-doc' + (sections.length >= 3 ? ' has-rail' : '')}>
        {/* 章节导引轨：文档够长（≥3 节）才出现；窄屏由 CSS 隐藏 */}
        {sections.length >= 3 && (
          <nav className="lp-doc-rail" aria-label={t('方案目录')}>
            <div className="lp-doc-rail-t">{t('目录')}</div>
            <ol>
              {sections.map((s) => (
                <li key={s.id} className={s.level > 2 ? 'sub' : ''}>
                  <a href={'#' + s.id} className={active === s.id ? 'on' : ''}
                    onClick={(e) => { e.preventDefault(); goTo(s.id) }}>
                    <span className="no">{s.no || '·'}</span>
                    <span className="t">{s.text}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        <article className="lp-doc-main">
          <header className="lp-doc-head">
            <div className="lp-doc-eyebrow">
              <span className="lp-doc-kind">{t('压测方案')} · #{task?.id}</span>
              <span className="lp-doc-chips">
                <span className={'lp-chip' + (d.found ? ' on' : ' off')}>
                  {d.found ? driverLabel(d.driver) : t('未找到执行载体')}
                </span>
                <span className="lp-chip">{d.charts?.panels?.length ? t('面板 {n} 个', { n: d.charts.panels.length }) : t('默认面板')}</span>
                {d.has_html && <span className="lp-chip">{t('自定义视图 ✓')}</span>}
              </span>
            </div>
            <h1 className="lp-doc-title">{title}</h1>
            {doc.meta.length > 0 && (
              <dl className="lp-doc-meta">
                {doc.meta.map((m, i) => (
                  <div className="lp-doc-meta-row" key={i}>
                    <dt>{m.k}</dt>
                    <dd dangerouslySetInnerHTML={{ __html: m.v }} />
                  </div>
                ))}
              </dl>
            )}
          </header>

          {d.plan_found ? (
            <div className="lp-doc-body md-body" ref={bodyRef}
              dangerouslySetInnerHTML={{ __html: doc.html }} />
          ) : (
            <div className="lp-doc-body" ref={bodyRef}>
              <div className="lp-empty-state">
                <div className="lp-empty-t">{t('本任务未生成方案文档')}</div>
                <p>
                  <code>plan.md</code>{' '}
                  {t('由压测第 1 轮的 agent 产出，用来回答「压谁、压多狠、看什么、怎么算通过」。它缺失不影响发压执行，但发压前就没有可复核的书面方案——可在方案包目录')}{' '}
                  <code>load/task_{task?.id}/</code>
                  {/* 词条 key 以空格开头：中文在路径后保留原来的一个空格；英文值是「.」，紧跟路径（不加空格） */}
                  {t(' 下补一份 Markdown 方案。')}
                </p>
              </div>
            </div>
          )}
        </article>
      </div>

      {!d.found && (
        <div className="hint lp-warn">
          {t('本任务的方案包缺失（需在 <案例库根>/load/task_{id}/ 下生成 run.py 或 scenario.json）；发压轮会因此失败。', { id: task?.id })}
        </div>
      )}
      {d.charts_error && (
        <div className="hint lp-warn">{t('图表声明不合法，面板已回退默认：{msg}', { msg: d.charts_error })}</div>
      )}

      <div className="lp-doc-appendix">
        {d.script_text && (
          <Fold title={t('执行载体源码')} note={d.script_name}>
            <pre className="lp-code">{d.script_text}</pre>
          </Fold>
        )}
        {chartsText && (
          <Fold title={t('图表声明')} note="charts.json">
            <pre className="lp-code">{chartsText}</pre>
          </Fold>
        )}
        <Fold title={t('指标口径速查')} note={t('写脚本 / 声明图表时对照')}>
          <ul className="lp-tips">
            <li><code>gauge</code>{t('：瞬时值（rps / lat.p50·p90·p95·p99 / err.rate / conc）')}</li>
            <li><code>counter</code>{t('：单调递增累计值（req.total / 业务计数），面板按窗口增量或速率画')}</li>
            <li><code>labels</code>{t('：维度字典（如')} <code>{t('{"status":"已成交"}')}</code>{t('），同一 metric 靠它区分序列；')}{' '}<code>groupBy</code>{' '}{t('指定的就是这里的键')}</li>
            <li><code>summary</code>{t('：收尾 KPI 行，供单值卡与报告使用')}</li>
          </ul>
        </Fold>
      </div>
    </div>
  )
}
