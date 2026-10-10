// 项目推送绑定（设置页「飞书设置」→「项目推送绑定」卡）的请求构造与回执文案。
// 抽成纯函数直测（与本目录 bugStatus / queueBadge 等既有口径一致，组件只做渲染）：
// - 默认：保存单个项目 → PATCH /api/projects/<pid>/feishu-hook
// - 勾选「同时应用到我的全部项目」→ POST /api/me/feishu-hook/apply
//   （写本人全部未归档项目；webhook/secret 留空不下发 ⇒ 各项目保留自己的值，
//    只统一「启用推送」与事件勾选，2026-10-10 用户需求）

// 保存体：enabled/events 恒下发；webhook/secret 只在用户输入了内容时才带键
// （后端语义：缺省=保持现有值，故「留空」不会把已配好的 webhook 清掉）
export function buildHookBody(hook, input = {}) {
  const body = { enabled: !!(hook && hook.enabled), events: (hook && hook.events) || [] }
  const url = ((input && input.webhook_url) || '').trim()
  if (url) body.webhook_url = url
  if (input && input.webhook_secret) body.webhook_secret = input.webhook_secret
  return body
}

// 保存目标：applyAll=true 走批量端点（不带 pid）；否则走单项目端点。
// 返回 {kind:'all'|'one', body, pid?}，由调用处按 kind 分派到对应 API。
export function hookSaveRequest(applyAll, pid, hook, input = {}) {
  const body = buildHookBody(hook, input)
  return applyAll ? { kind: 'all', body } : { kind: 'one', pid, body }
}

// 批量应用回执：列出实际写入的项目数与跳过的已归档项目数（后端返回 updated/
// archived_skipped/projects）；字段缺失时按 0 兜底，绝不显示 undefined。
export function applyResultText(r) {
  const n = Number(r && r.updated) || 0
  const skipped = Number(r && r.archived_skipped) || 0
  return skipped > 0
    ? `已应用到 ${n} 个项目（跳过 ${skipped} 个已归档）`
    : `已应用到 ${n} 个项目`
}
