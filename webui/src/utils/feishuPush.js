// 设置页「飞书设置」→ 推送总控（用户级 `push_enabled`）的取值与下发口径。
// 抽成纯函数直测（与本目录 feishuHook / bugStatus 等既有口径一致，组件只做渲染）：
// - 总控关 ⇒ 后端 `feishu.notify_events` 一票否决，飞书不再收到**自动推送**
//   （作答卡片、群 webhook 事件等）；用户主动询问/查询的回复与指令回执不在此列。
// - 与旧 `enabled`（只管「未单独设置的项目按默认事件推送」那条回落腿 + 入站连接）
//   是两个独立开关，互不牵连。

// 总控是否开着：服务端没回该键（存量配置 / 旧后端）⇒ 按**开**处理——
// 页面绝不能因为缺键就把用户的推送静默停掉（与后端 `.get("push_enabled", True)` 同口径）。
export function isPushEnabled(cfg) {
  const v = cfg && cfg.push_enabled
  return !(v === 0 || v === false)
}

// 写入总控（返回新对象，不改原 cfg）：0/1 与后端 save_user_config 的布尔化口径一致
export function withPushEnabled(cfg, on) {
  return { ...(cfg || {}), push_enabled: on ? 1 : 0 }
}

// 保存配置的请求体：与 FeishuPanel 既有语义逐字一致（enabled 恒下发；
// webhook/secret 仅在用户输入了内容时才带键 ⇒ 后端「缺省=不改」不会误清已配值），
// 外加总控键。纯字符串字段统一 trim，避免把前后空格写进库。
const STR_KEYS = ['base_url', 'app_id']

export function buildCfgBody(cfg) {
  const c = cfg || {}
  const body = { enabled: !!c.enabled, push_enabled: isPushEnabled(c) }
  for (const k of STR_KEYS) body[k] = (c[k] || '').trim()
  return body
}

// 卡内状态回显：让用户一眼看出「当前推送到底开没开」，并点明总控的作用范围
export function pushStatusText(cfg) {
  return isPushEnabled(cfg)
    ? '当前：推送中（自动推送按各项目的推送绑定与事件勾选送达）'
    : '当前：已停止（飞书不再收到自动推送；你在飞书发指令的查询与对话答复不受影响）'
}
