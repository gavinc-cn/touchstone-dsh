// 通过卡片时的「worktree 改动回流」交接框（2026-10-07 批次）
//
// 场景：卡片跑在独立 git worktree 里（`card.worktree` 非空），改动都在 `ts/card-<id>`
// 分支上，主分支一无所知。点「通过」时后端先判定有没有待合并提交
// （`GET .../worktree` 的 `merge` 字段；竞态兜底是 move 端点返回 `merge_pending`）：
//   - 没有  → 不弹本框，卡片照旧直接进「已完成」；
//   - 有    → 弹本框，让用户选「交给 agent 合并」还是「仅通过（不合并）」。
//
// 合并**不由平台执行**：平台只把合并指令投给卡片会话并让卡片回统一队列排队，
// agent 负责同步主分支、解冲突、回流（冲突只有 agent 能解）。干完这轮卡片自动回
// 「待审核」，用户再点「通过」时已无待合并提交，直接完成。
//
// 看板卡片与会话详情窗共用本组件（各自传各自的 info 与回调）。
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'

export default function MergeHandoffDialog({ open, info, busy, disabledReason, onHandoff, onPass, onClose }) {
  const m = info || {}
  const dirty = Number(m.dirty_count || 0)
  return (
    <Dialog open={!!open} onOpenChange={(v) => !v && onClose && onClose()}>
      <DialogContent className="modal">
        <DialogHeader><DialogTitle>通过前：worktree 改动还没回流主分支</DialogTitle></DialogHeader>
        <p className="hint">
          该卡片在独立 worktree 中开发，改动在分支 <span className="font-mono">{m.branch || '—'}</span> 上，
          主分支 <span className="font-mono">{m.target || '—'}</span> 还不知道这些改动。
        </p>
        <p className="hint">
          待合并提交：<b>{m.ahead || 0}</b> 个
          {m.behind ? <>（主分支领先 {m.behind} 个提交，需先同步）</> : null}
        </p>
        {dirty > 0 && (
          <p className="hint">工作树有 {dirty} 处未提交改动，交给 agent 时会先提交它们。</p>
        )}
        <p className="hint">
          「交给 agent 合并」= 平台把合并指令发给卡片主会话并让卡片回开发队列排队：
          agent 先同步主分支最新代码，再尽量快进（不能快进才生成合并提交）回流，冲突由它解决；
          干完这轮卡片自动回「待审核」，那时再点「通过」即完成。
        </p>
        {m.path && <p className="hint break-all">工作树：<span className="font-mono">{m.path}</span></p>}
        {/* 会话还在跑时不能投合并指令（后端 400「会话运行中」）——提前置灰并说明原因 */}
        {disabledReason && <p className="hint">{disabledReason}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="outline" disabled={busy} onClick={onPass}>仅通过（不合并）</Button>
          <Button disabled={busy || !!disabledReason} title={disabledReason || undefined}
            onClick={onHandoff}>
            {busy ? '提交中…' : '交给 agent 合并'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
