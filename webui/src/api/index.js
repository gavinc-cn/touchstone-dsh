// API 封装: 同源 cookie, 401 统一跳登录
// 同源根: 独立构建 BASE_URL='/'(去尾→''), dsh 插件构建 '/touchstone/'(去尾→'/touchstone');
// REST/SSE/媒体 URL 统一经它拼前缀——独立形态拼出的路径与原硬编码逐字符一致
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
async function request(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(BASE + url, opts)
  if (res.status === 401) {
    // 登录页内 /api/auth/me 返回 401 属正常(未登录), 不跳转;
    // 其他页面 401 跳回登录页, 用窗口标志防止多次触发整页刷新
    if (window.location.pathname !== BASE + '/login' && !window.__ts_redirecting) {
      window.__ts_redirecting = true
      window.location.href = BASE + '/login'
    }
    throw new Error('unauthorized')
  }
  let data = null
  const text = await res.text()
  if (text) { try { data = JSON.parse(text) } catch { data = text } }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
}

// ---- auth ----
export const authApi = {
  me: () => api.get('/api/auth/me'),
  login: (username, password) => api.post('/api/auth/login', { username, password }),
  register: (username, password) => api.post('/api/auth/register', { username, password }),
  logout: () => api.post('/api/auth/logout'),
  changePassword: (old_password, new_password) =>
    api.post('/api/auth/change_password', { old_password, new_password }),
}

// ---- 当前用户(个人级) ----
export const meApi = {
  // 飞书账号绑定: 状态查询(open_id 打码+默认项目)/生成绑定码(6 位 10 分钟内存态)/解绑
  feishuGet: () => api.get('/api/me/feishu'),
  feishuBindcode: () => api.post('/api/me/feishu-bindcode'),
  feishuUnbind: () => api.del('/api/me/feishu'),
  // 飞书设置(用户级): 自己的应用凭据/默认 webhook/站点地址(打码回显), 仅操作本人配置
  feishuCfgGet: () => api.get('/api/me/feishu-cfg'),
  feishuCfgSet: (body) => api.patch('/api/me/feishu-cfg', body),
  // 自己的投递记录(target 打码)
  feishuOutbox: () => api.get('/api/me/feishu/outbox'),
  // 飞书快捷指令(斜杠指令): 现状(TS 期望清单 + 飞书侧已注册) / 注册同步 / 清除 TS 指令
  feishuSlashGet: () => api.get('/api/me/feishu/slash-commands'),
  feishuSlashSet: (action) => api.post('/api/me/feishu/slash-commands', { action }),
  // 飞书配置自动化(M5): 扫码建应用流程现状(轮询口) / 四动作(start|cancel|apply|publish)
  feishuProvisionGet: () => api.get('/api/me/feishu/provision'),
  feishuProvisionSet: (action, body = {}) =>
    api.post('/api/me/feishu/provision', { action, ...body }),
  // 配置自检(八项); sendProbe=true 时额外发一条测试消息(服务端 60s 频控)
  feishuDoctor: (sendProbe = false) =>
    api.post('/api/me/feishu/doctor', { send_probe: !!sendProbe }),
}

// ---- 项目 ----
export const projectApi = {
  list: () => api.get('/api/projects'),
  get: (id) => api.get(`/api/projects/${id}`),
  create: (body) => api.post('/api/projects', body),
  update: (id, body) => api.patch(`/api/projects/${id}`, body),
  // 删除项目（仅归档项目可删; body 带 confirm_name 供后端二次校验）
  remove: (id, body) => api.del(`/api/projects/${id}`, body),
  // 归档/恢复项目（仅切换 archived 标记，不删数据）
  archive: (id) => api.post(`/api/projects/${id}/archive`),
  unarchive: (id) => api.post(`/api/projects/${id}/unarchive`),
  // 服务端目录浏览（目录选择对话框用; path 为空返回根列表视角）
  fsBrowse: (path) => api.get(`/api/fs/browse?path=${encodeURIComponent(path || '')}`),
  // 在指定目录下新建子目录（目录选择对话框「新建文件夹」，返回 {name, path}）
  fsMkdir: (path, name) => api.post('/api/fs/mkdir', { path, name }),
  dupCheck: (params) => {
    const q = new URLSearchParams(params).toString()
    return api.get(`/api/projects/dup_check?${q}`)
  },
  agents: () => api.get('/api/agents/scan'),
  // 指定 agent 的模型列表(dsh 插件族走宿主 /models 目录; 空/未知/退场路径只回默认模型), 供模型下拉
  agentModels: (agentPath) =>
    api.get(`/api/agents/models?agent_path=${encodeURIComponent(agentPath || '')}`),
  // 指定 agent CLI 可用的 skill 列表(用户级+项目级 SKILL.md 扫描), 供项目能力下拉
  agentSkills: (agentPath, projectDir) =>
    api.get(`/api/agents/skills?agent_path=${encodeURIComponent(agentPath || '')}&project_dir=${encodeURIComponent(projectDir || '')}`),
  // 飞书推送绑定（webhook/事件开关; webhook/secret 打码回显, 留空键=保持不变）
  feishuHookGet: (id) => api.get(`/api/projects/${id}/feishu-hook`),
  feishuHookSet: (id, body) => api.patch(`/api/projects/${id}/feishu-hook`, body),
  // 推送绑定批量应用（「同时应用到我的全部项目」，2026-10-10）：写本人全部未归档项目，
  // 字段语义同 feishuHookSet（缺省=不改 ⇒ webhook 留空即各项目保留原值）
  feishuHookApplyAll: (body) => api.post('/api/me/feishu-hook/apply', body),
  // 项目文件预览（会话详情页点击回答里的路径）：后端限定在项目目录/工作目录之内，
  // 返回 {path,rel,root,name,ext,size,mtime,text,truncated,binary}
  filePreview: (id, path) =>
    api.get(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  // 原文 URL（新标签打开；文本按纯文本展示，二进制走附件下载）
  fileRawUrl: (id, path) =>
    `${BASE}/api/projects/${id}/file?path=${encodeURIComponent(path)}&raw=1`,
}

// ---- 用户 UI 偏好（标签页布局/看板列过滤等，按 用户+项目 维度存服务端） ----
export const prefsApi = {
  get: (pid) => api.get(`/api/prefs?project_id=${pid || 0}`),
  set: (pid, key, value) => api.post('/api/prefs', { project_id: pid || 0, key, value }),
}

// ---- 任务 ----
export const taskApi = {
  list: (pid) => api.get(`/api/projects/${pid}/tasks`),
  create: (pid, body) => api.post(`/api/projects/${pid}/tasks`, body),
  get: (id) => api.get(`/api/tasks/${id}`),
  update: (id, body) => api.patch(`/api/tasks/${id}`, body),
  stop: (id) => api.post(`/api/tasks/${id}/stop`),
  restart: (id) => api.post(`/api/tasks/${id}/restart`),
  // 继续: 修改参数后接着当前 session 续跑(不新建会话)
  continue: (id, body) => api.post(`/api/tasks/${id}/continue`, body),
  remove: (id) => api.del(`/api/tasks/${id}`),
  rounds: (id) => api.get(`/api/tasks/${id}/rounds`),
  dialogue: (id) => api.get(`/api/tasks/${id}/dialogue`),
  log: (id, round, tail = 300) => api.get(`/api/tasks/${id}/log?round=${round}&tail=${tail}`),
  // 压测方案包：方案文档/载体源码/图表声明（meta=1 只取轻量标记，列表徽标用）
  loadCase: (id) => api.get(`/api/tasks/${id}/load/case`),
  loadCaseMeta: (id) => api.get(`/api/tasks/${id}/load/case?meta=1`),
  // 压测运行（2026-10-06 复压批次）：一次发压 = 一次运行（运行键/状态/产物齐备度）
  loadRuns: (id) => api.get(`/api/tasks/${id}/load/runs`),
  // 复压：跳过 agent，用现有方案包直接再发压一次（入统一队列，同项目串行）
  loadRerun: (id) => api.post(`/api/tasks/${id}/load/rerun`),
  // 诊断：把最近一次运行的执行现场（退出码/指标摘要/日志尾）发给该任务会话
  loadDiagnose: (id) => api.post(`/api/tasks/${id}/load/diagnose`),
  // 压测指标：规范样本增量拉取（after 行号续拉）/ SSE（Last-Event-ID 自动续传）；
  // run=运行键（空串=正在跑/最新一次运行）
  loadMetrics: (id, after = 0, limit = 20000, run = '') =>
    api.get(`/api/tasks/${id}/load/metrics?after=${after}&limit=${limit}`
      + (run ? `&run=${encodeURIComponent(run)}` : '')),
  loadReport: (id, run = '') =>
    api.get(`/api/tasks/${id}/load_report${run ? `?run=${encodeURIComponent(run)}` : ''}`),
  loadStream: (id, run = '') =>
    new EventSource(`${BASE}/api/tasks/${id}/load/stream${run ? `?run=${encodeURIComponent(run)}` : ''}`),
  // 逃生舱 panel.html（沙箱 iframe 的 src；服务端带 CSP sandbox 头）
  loadCustomHtmlUrl: (id) => `${BASE}/api/tasks/${id}/load/custom_html`,
  // session 对话窗口: 一次性拉取(初始加载/调试用)
  sessionMessages: (id, agent = 'main', after = 0) =>
    api.get(`/api/tasks/${id}/session/messages?agent=${encodeURIComponent(agent)}&after=${after}`),
  // session SSE(meta/entries/chat 三类事件; 断线自动重连 + Last-Event-ID 续传)
  sessionStream: (id, agent = 'main') =>
    new EventSource(`${BASE}/api/tasks/${id}/session/stream?agent=${encodeURIComponent(agent)}`),
  // session 对话续发; inject=true 时立即注入运行中的当前轮(dsh 等 steer 能力会话生效)
  sessionChat: (id, message, inject = false) =>
    api.post(`/api/tasks/${id}/session/chat`, { message, inject }),
  // 平台排队消息立即注入: msgId 为 chat.msgs 的平台队列消息单元 id——撤销排队立即投递
  // 到会话当前上下文(不等项目空闲; 后端白名单校验归属)
  sessionChatInject: (id, msgId) =>
    api.post(`/api/tasks/${id}/session/chat/inject`, { msg_id: msgId }),
  // 会话回退到某条用户提问之前(dsh): mid 为该提问的 anchor 消息 id——
  // 后端按边界 fork 出新会话(宿主无原地 undo); 忙碌/边界失效 409
  sessionRewind: (id, mid) =>
    api.post(`/api/tasks/${id}/session/rewind`, { mid }),
  // 作答等待中的交互(dsh 插件族): 提问 body={qid,kind?,option_id?/option_ids?/text?};
  // 审批 body={approval_id,decision,scope?}(decision=approved/rejected, scope=session 本会话内批准)
  answerInteraction: (id, body) =>
    api.post(`/api/tasks/${id}/session/interaction/answer`, body),
  sessionChatStop: (id) => api.post(`/api/tasks/${id}/session/chat/stop`),
  // 任务会话级配置（2026-10-04）：body={reasoning_effort}——只开**思考等级**一项
  // （任务会话无权限档交互面、模型按任务/项目每轮下发，后端显式拒绝这两项）
  sessionProfile: (id, body) => api.post(`/api/tasks/${id}/session/profile`, body),
  // session 图片 URL(同源 cookie 直接供 <img src>)
  sessionMediaUrl: (id, agent, mediaId) =>
    `${BASE}/api/tasks/${id}/session/media/${encodeURIComponent(mediaId)}?agent=${encodeURIComponent(agent)}`,
}

// ---- Bug 报告 ----
export const bugApi = {
  list: (pid) => api.get(`/api/projects/${pid}/bugs`),
  get: (pid, dir) => api.get(`/api/projects/${pid}/bugs/${encodeURIComponent(dir)}`),
  // 拒绝报告：平台标记「已拒绝」并创建修例任务（按理由修正用例+沉淀 PITFALLS.md）
  reject: (pid, dir, reason) =>
    api.post(`/api/projects/${pid}/bugs/${encodeURIComponent(dir)}/reject`, { reason }),
}

// ---- 后台管理 ----
export const adminApi = {
  users: () => api.get('/api/admin/users'),
  createUser: (body) => api.post('/api/admin/users', body),
  updateUser: (id, body) => api.patch(`/api/admin/users/${id}`, body),
  deleteUser: (id) => api.del(`/api/admin/users/${id}`),
  // RAG 语义检索全局配置（~/.touchstone/rag.json；api_key 留空=保持现有，clear=true=停用）
  ragGet: () => api.get('/api/admin/rag'),
  ragSet: (body) => api.patch('/api/admin/rag', body),
  ragTest: (body) => api.post('/api/admin/rag/test', body),
}

// ---- 平台内置资产（skill 安装，设置页「内置资产」分区） ----
// 清单与状态：target=user 读用户级（写仅 admin）、target=project 需 project_id
// （读/写都仅项目所有者）；install/uninstall 同一动作语义 = 收敛到清单期望状态
export const builtinAssetApi = {
  list: (target, projectId) => {
    const t = target === 'project' ? 'project' : 'user'
    return api.get(`/api/builtin-assets?target=${t}` +
      (t === 'project' && projectId ? `&project_id=${projectId}` : ''))
  },
  install: (id, target, projectId) =>
    api.post(`/api/builtin-assets/${id}/install`,
      { target, project_id: projectId ?? null }),
  uninstall: (id, target, projectId) =>
    api.post(`/api/builtin-assets/${id}/uninstall`,
      { target, project_id: projectId ?? null }),
}

// ---- 监控 ----
export const stateApi = {
  state: (pid) => api.get(`/api/state?project=${pid}`),
  stream: (pid) => new EventSource(`${BASE}/api/stream?project=${pid}`),
}

// ---- 看板 ----
export const boardApi = {
  get: (pid) => api.get(`/api/projects/${pid}/board`),
  createCard: (pid, body) => api.post(`/api/projects/${pid}/board/cards`, body),
  updateCard: (pid, cid, body) => api.patch(`/api/projects/${pid}/board/cards/${cid}`, body),
  removeCard: (pid, cid) => api.del(`/api/projects/${pid}/board/cards/${cid}`),
  // 移列：beforeId=目标列 manual 时插入到该卡之前（null=落列尾），非 manual 忽略；
  // mergeAck=true 跳过「独立 worktree 卡待合并提交」闸（用户选「仅通过，不合并」时带），
  // 不带且卡有未回流主分支的提交时返回 {merge_pending:{...}} 且列不变（前端弹合并交接框）
  moveCard: (pid, cid, column, block_text, beforeId = null, mergeAck = false) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/move`,
             { column, block_text, before_id: beforeId, merge_ack: !!mergeAck }),
  // 开始开发 / 打回续改（opinion 为打回意见，可空）；force=true 跳过父依赖与排队直接起会话（c: 行直落运行前缀）；
  // worktree=true 由平台新建独立 git worktree 执行该卡且不进项目开发队列（会话 cwd 指向工作树）
  startCard: (pid, cid, opinion, force, worktree) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/start`,
             { opinion, force: !!force, worktree: !!worktree }),
  // 「在新 worktree 中开始」预览（只读不落盘）：返回 {supported, reason, path, branch, exists}；
  // supported=false（项目目录非 git 仓库 / 该卡已有主会话）时 reason 为给人看的中文原因；
  // 另有 merge 字段（2026-10-07）：该 worktree 卡的待合并提交判定 {branch,target,ahead,
  // behind,dirty,dirty_count,path}，null=无待合并（「通过」直接完成）
  worktreePreview: (pid, cid) => api.get(`/api/projects/${pid}/board/cards/${cid}/worktree`),
  // 把 worktree 改动回流主分支的合并任务交给卡片会话（平台只投递指令 + 回统一队列排队，
  // 合并本身由 agent 执行——冲突只有 agent 能解）；成功后卡片回「正在开发」列排队中
  mergeWorktree: (pid, cid) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/worktree/merge`, {}),
  // 清理该卡的独立 worktree（后端判据：会话运行中 409、工作树有未提交改动 400；不带 --force）
  removeWorktree: (pid, cid) => api.del(`/api/projects/${pid}/board/cards/${cid}/worktree`),
  // 停止卡片运行中的会话（CLI 杀进程组；web 走 REST abort）
  stopCard: (pid, cid) => api.post(`/api/projects/${pid}/board/cards/${cid}/stop`),
  // 标记卡片已查看（打开卡片详情 / 点卡面操作行上任意按钮时调用，清「状态有更新」未读标记；幂等）
  markViewed: (pid, cid) => api.post(`/api/projects/${pid}/board/cards/${cid}/viewed`),
  addComment: (pid, cid, text) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/comments`, { text }),
  // 投递评论到主会话; inject=true 时立即注入运行中的当前轮(仅 steer 能力会话生效);
  // raw=true 直发原文不加【看板评论】前缀(会话详情页发送路径专用)
  sendComment: (pid, cid, mid, inject = false, raw = false) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/comments/${mid}/send`, { inject, raw }),
  removeComment: (pid, cid, mid) =>
    api.del(`/api/projects/${pid}/board/cards/${cid}/comments/${mid}`),
  // 项目工作区已有会话列表（绑定下拉用；bound=已绑定某卡片）
  listSessions: (pid) => api.get(`/api/projects/${pid}/board/sessions`),
  // 卡片会话 compact 压缩上下文（sid 缺省=主会话；busy 409，族不支持 400）
  compact: (pid, cid, sid) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/compact`, sid ? { sid } : {}),
  // 压缩并新建：压缩会话摘要 → 新建全新会话并注入摘要（新会话无历史轮次；dsh 插件族；busy 409，族不支持 400）
  forkCompact: (pid, cid, sid) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/fork-compact`, sid ? { sid } : {}),
  // fork 会话：完整复制源会话为新会话（历史/上下文全量保留；dsh 插件族；busy 409，族不支持 400）
  // 仅加入卡片会话列表，不设主——需要主会话切换时点「设主」
  forkSession: (pid, cid, sid) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/fork`, sid ? { sid } : {}),
  // 回答卡片会话的待答交互（dsh 插件族）：提问 body={qid,kind?,option_id?/option_ids?/text?}
  // （kind ∈ single/multi/other/multi_with_other，缺省 single）；审批
  // body={approval_id,decision,scope?}（decision=approved/rejected，scope=session 本会话内批准）
  answerInteraction: (pid, cid, body) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/interaction/answer`, body),
  // 「立即送达」已作答·待送达的答案（不等项目空闲，直接交给等待中的会话）
  deliverAnswer: (pid, cid) =>
    api.post(`/api/projects/${pid}/board/cards/${cid}/answer/deliver`),
  // 平台排队消息立即注入：msgId 为 chat.msgs 的平台队列消息单元 id——撤销排队立即投递
  // 到会话当前上下文（不等项目空闲；后端白名单校验归属）
  injectSessionMsg: (pid, sid, msgId) =>
    api.post(`/api/projects/${pid}/board/sessions/${encodeURIComponent(sid)}/inject`,
      { msg_id: msgId }),
  // 会话回退到某条用户提问之前（dsh）：mid 为该提问的 anchor 消息 id——
  // 后端按边界 fork 出新会话（宿主无原地 undo）；忙碌/边界失效 409
  rewindSession: (pid, sid, mid) =>
    api.post(`/api/projects/${pid}/board/sessions/${encodeURIComponent(sid)}/rewind`,
      { mid }),
  updateSettings: (pid, body) => api.patch(`/api/projects/${pid}/board/settings`, body),
  jiraTest: (pid, body) => api.post(`/api/projects/${pid}/board/jira/test`, body),
  jiraImport: (pid) => api.post(`/api/projects/${pid}/board/jira/import`),
  // 卡片会话只读查看（按 sid 直读，增量 after；agent 切子会话）
  sessionMessages: (pid, sid, after = 0, agent = 'main') =>
    api.get(`/api/projects/${pid}/board/session/messages?sid=${encodeURIComponent(sid)}&after=${after}&agent=${encodeURIComponent(agent)}`),
  // 卡片会话图片 URL（board 会话窗无 taskId，图片经 项目+sid 寻址，同源 cookie 直供 <img src>）
  sessionMediaUrl: (pid, sid, agent, mediaId) =>
    `${BASE}/api/projects/${pid}/board/session/media/${encodeURIComponent(mediaId)}?sid=${encodeURIComponent(sid)}&agent=${encodeURIComponent(agent)}`,
  // 列内手动拖排（manual 模式限定）：beforeId=null 移到列尾；整列重写 sort_order
  reorderCard: (pid, cid, beforeId) =>
    api.post(`/api/projects/${pid}/board/reorder`, { card_id: cid, before_id: beforeId }),
  // 回收站：列表 / 还原 / 彻底删除 / 清空（删除卡片=进回收站，真删走 trash 端点）
  trashList: (pid) => api.get(`/api/projects/${pid}/board/trash`),
  restoreCard: (pid, cid) => api.post(`/api/projects/${pid}/board/trash/${cid}/restore`),
  purgeCard: (pid, cid) => api.del(`/api/projects/${pid}/board/trash/${cid}`),
  emptyTrash: (pid) => api.post(`/api/projects/${pid}/board/trash/empty`),
  // 卡片会话级配置（仅 dsh 插件族）：body={model?, permission_mode?, reasoning_effort?}，
  // 同步直改会话 profile（思考等级 2026-10-04 加入；只改等级时 model 可留空）
  setSessionProfile: (pid, sid, body) =>
    api.post(`/api/projects/${pid}/board/sessions/${encodeURIComponent(sid)}/profile`, body),
  // 卡片附件上传（描述/会话粘贴图片与文件）：body={name, mime, data(base64)}，返回 {fid, url, abs(落盘绝对路径, agent 本机直读)}
  uploadMedia: (pid, body) => api.post(`/api/projects/${pid}/board/media`, body),
  // 看板变更事件流（SSE，P4 事件化）：只发 `hello`/`refresh` 信号，收到即重取一次
  // 看板 payload（鉴权走 cookie，EventSource 不需带头；断线由浏览器自动重连）
  stream: (pid) => new EventSource(`${BASE}/api/projects/${pid}/board/stream`),
  // 单会话实时事件流（SSE，P4 会话窗口事件化）：`hello`/`refresh` 信号，收到即做一次
  // 增量拉取（after=已见最大 seq+1）；仅 `caps.events` 为真的族有推送（当前 dsh_plugin）
  sessionStream: (pid, sid) =>
    new EventSource(`${BASE}/api/projects/${pid}/board/sessions/${encodeURIComponent(sid)}/stream`),
}

