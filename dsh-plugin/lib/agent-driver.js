/**
 * Touchstone dsh 插件 — 进程内 agent 驱动（路线 A 核心）
 *
 * 职责：把平台（Python 侧）的「一次任务 = 一个常驻会话」需求，翻译成 dsh 宿主
 * 进程内的 agent 运行时调用，并把会话事件**推**回 Python（SSE），而不是让 Python
 * 轮询状态。设计依据见 doc_ai/plan/202610/20261001_2057_*.md §三（路线 A）与
 * doc_ai/spec/dsh_plugin/dsh插件形态.md。
 *
 * 为什么必须推送而不是「再开一个查状态接口」（方案 §3.3 的关键前提）：
 *   轮询对象从 kimi web 换成 dsh 插件，kimiweb 那套 TTL/SWR/线程池/负缓存补丁会
 *   原样复活。dsh 侧 `agent/status` 仅在状态变化时 emit、`turn/end` 天然是事件，
 *   所以通道做成 SSE 长连才有意义。
 *
 * 对外契约（全部挂在 webServer 的 `${DRIVER_PREFIX}` 前缀下，仅回环可达 + 令牌校验）：
 *   GET  /touchstone-agent/health              就绪探测（agents 服务是否可用）
 *   GET  /touchstone-agent/live                当前可见会话表（含外部直跑会话，零 REST 探测）
 *   GET  /touchstone-agent/status?session_id=  单会话状态 + last_seq（SSE 续传基准）
 *   GET  /touchstone-agent/events?session_id=&since=  SSE 事件流（首发 ring 内 seq>since 的帧）
 *   POST /touchstone-agent/session             建会话或恢复会话 {cwd, task, session_id?, model?, provider?}
 *   POST /touchstone-agent/prompt              followup 投递一轮提示词
 *   POST /touchstone-agent/steer               运行中插话（steer）
 *   POST /touchstone-agent/cancel              优雅中断（cancel，保留已流式交付的文本）
 *   POST /touchstone-agent/dispose             释放常驻会话（可选连会话存储一起删）
 *   GET  /touchstone-agent/archived            宿主归档集整表（看板「已完成」与 dsh 会话归档同步）
 *   POST /touchstone-agent/archive             {session_id, archived} 归档/取消归档（幂等）
 *
 * 状态帧（scope=state）新增 `driver/archived`：归档集**整表快照**（不是增量），
 * 变化时推一帧（`domain/changed` 事件为主 + keepalive 15s 兜底比对）；平台侧
 * 据此把「dsh 里归档/取消归档」同步成看板卡片进/出「已完成」。
 *
 * 红线：
 *  1. 仅接受回环来源（remoteAddress ∈ LOOPBACK）+ `x-ts-driver-token` 匹配，
 *     否则任何人都能通过 dsh 的 0.0.0.0 监听驱动 agent 执行任意命令。
 *  2. 不 import 任何 npm 第三方包；`@deepseek-ai/dsh-llm` 只为 createUserMessage，
 *     解析不到时降级为等价的本地构造（见 _userMessage）。
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** 驱动路由前缀（与 /touchstone 反代前缀并列，互不重叠） */
export const DRIVER_PREFIX = '/touchstone-agent';

/** 每会话事件环大小：SSE 断线重连时按 seq 续传，超出即丢弃最旧帧 */
const RING_MAX = 500;
/** 全局状态环容量（P4）：状态帧只带精简字段，2000 帧足够覆盖一次断连补偿 */
const STATE_RING_MAX = 2000;
/** 模型目录缓存 TTL（provider 端可能真发请求；与平台侧 agent_models 缓存同量级） */
const MODELS_TTL_MS = 60000;

/** `ask_user_question` tool/call 登记的有效期（毫秒）：提问请求紧跟工具调用到达，
 *  超过这个窗口的登记不可能再配对，随新登记淘汰（内存有界） */
const QUESTION_CALL_TTL_MS = 120000;

/** tool/call 登记表上限（条）：极端情况下（大量提问工具调用未配对）也不涨破内存 */
const QUESTION_CALL_MAX = 64;

/** SSE keepalive 注释帧间隔（毫秒）：防中间层按空闲超时切断长连 */
const KEEPALIVE_MS = 15000;

/**
 * 归档集兜底扫描间隔（毫秒；纯内存读，不产生任何 HTTP/磁盘 IO）。
 *
 * 2026-10-07 实测定因：宿主 `WorkspaceRegistry.setState()` 的顺序是
 * `await global.set(state)` → `this.state = state`，而 `domain/changed` 正是在
 * `global.set` 内部**同步**发出的 ⇒ 监听器执行时 registry 的
 * `archivedSessionIds` 读到的仍是**旧快照**（官方 registry 的内存缓存尚未刷新）。
 * 旧实现据此比对 key 判定「没变化」而早退，一次帧都不推——dsh 侧归档只能等
 * 15s 的 `_keepalive` 兜底（真机四组实测：归档 RPC 13~19ms 返回，帧延迟
 * 1.1/6.1/6.1/13.8s）。事件路径已改为**直接取事件载荷**里的权威新值
 * （见 `_onDomainChanged`），本定时器只作二道兜底：事件再丢/形态再变时，
 * 变化也能在 3s 内推出去（原兜底是 15s）。
 */
const ARCHIVE_SWEEP_MS = 3000;

/** 请求体上限（字节）：提示词可能很长，给足余量 */
const MAX_BODY = 8 * 1024 * 1024;

/** 单条文本块转发上限（字符）：与 runner.DIALOGUE_TEXT_LIMIT 同量级，
 *  超出部分对平台侧对话渲染无意义，截断可显著降低 SSE 带宽 */
const TEXT_BLOCK_LIMIT = 20000;

/** 可驱动 agent 的合法来源地址（Node 在不同栈下回环地址写法不同，三种都收） */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 平台会话池里的一格：一个平台任务/卡片 ↔ 一个常驻 dsh 会话 */
class DriverSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.task = '';                     // 平台侧标识（任务 id / 卡 id），仅用于展示与日志
    this.cwd = '';
    this.handle = null;                 // AgentHandle（dispose 能力归本插件持有）
    this.agent = null;                  // Agent 运行时对象
    this.status = 'idle';               // idle | running（agent/status 事件维护）
    this.lastTurnReason = null;         // 最近一次 turn/end 的 reason.kind
    this.inbox = [];                    // 宿主 inbox 排队行（P6 #21）
    this.interaction = null;            // 挂起等作答/审批的实况（null = 无）
    this.permissionMode = '';           // 平台三档（manual/yolo/auto）：/permission 带 mode 时记下
    this.permissionPreset = '';         // 宿主 preset 实况（permissionPresets.current 回读）
    // 本插件为该会话安装的**模型选择对象**（`installModelSelection` 的第二个参数，
    // 形状 {current, assembled}）。/model 切换成功后要把它一起改写：模型选择是 dsh
    // 自己的选择对象 + 本插件安装的选择对象两套钩子，二者不一致时请求最终按注册顺序
    // 由**先注册者**（本插件的）覆盖——只调 selectModel 而不改这里，切换会「回执成功
    // 但请求还用旧档」。2026-10-04 随思考等级一起修。
    this.selection = null;
    this.ring = [];                     // 最近事件帧（SSE 重连续传）
    this.lastSeq = 0;                   // 已转发的最大会话 seq（不含合成帧）
    this.clients = new Set();           // 打开的 SSE 响应对象
    this.createdAt = Date.now();
  }

  /** 推一帧给所有订阅者，并入环（ring 溢出丢最旧）。 */
  publish(frame) {
    if (typeof frame.seq === 'number' && frame.seq > this.lastSeq) this.lastSeq = frame.seq;
    this.ring.push(frame);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    const line = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(line);
      } catch {
        this.clients.delete(res);        // 写失败即客户端已断，交由 close 事件清理
      }
    }
  }
}

/** 图片魔数嗅探（dsh 会话图片的 content-type 由此判定；平台侧只放行这几种）。 */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF'
      && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

/**
 * 从消息 content 块数组里抽纯文本（dsh 的 content 是块数组，平台只关心 text 块）。
 * @param {unknown} content - Message.content（块数组或已拼接字符串）
 * @returns {string} 拼接后的文本
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * 转发前裁剪事件：`assistant/message` 的 `stream`（逐 token 流式记录）与超长
 * 文本块对平台无用，去掉后可让帧体积降一个数量级。
 * @param {object} event - SessionEvent 信封 {type, seq, time, data}
 * @returns {object} 可 JSON 序列化的精简副本
 */
function trimEvent(event) {
  const data = { ...(event.data || {}) };
  delete data.stream;
  const msg = data.message;
  if (msg && typeof msg === 'object') {
    const copy = { ...msg };
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.map((block) => {
        if (block && typeof block === 'object' && block.type === 'text'
            && typeof block.text === 'string' && block.text.length > TEXT_BLOCK_LIMIT) {
          return { ...block, text: block.text.slice(0, TEXT_BLOCK_LIMIT), truncated: true };
        }
        return block;
      });
    }
    data.message = copy;
  }
  return { seq: event.seq, time: event.time, type: event.type, data };
}

/**
 * 进程内 agent 驱动：持有平台会话池、订阅会话事件、对外暴露回环 HTTP 契约。
 *
 * 生命周期：`start()` 注册路由并等 agents 服务就绪；`dispose()` 注销路由、关闭
 * 所有 SSE、释放全部常驻会话（插件停用/热重载时由 dsh 调用）。
 */
export class AgentDriver {
  /**
   * @param {object} ctx - 插件 ctx（已声明注入 webServer）
   * @param {object} logger - 日志器（ctx.logger('touchstone')）
   */
  constructor(ctx, logger) {
    this.ctx = ctx;
    this.logger = logger;
    /** 驱动令牌：随子进程环境变量下发，Python 每次请求回带；防止同机其它进程驱动 agent */
    this.token = randomUUID();
    /** 平台持有的会话（建/恢复由本插件完成，handle 归本插件） */
    this.sessions = new Map();
    /** 全局可见会话（含用户自己直跑的）：外部会话发现通道，替代逐会话 REST 探测 */
    this.observed = new Map();
    /** agents 服务就绪标记（未就绪时路由返回 503，Python 侧据此降级为 CLI 形态） */
    this.ready = false;
    this.agentCtx = null;
    this.fiber = null;
    this._routes = [];
    this._timer = null;
    /** 归档集快速兜底扫描定时器（见 ARCHIVE_SWEEP_MS） */
    this._sweepTimer = null;
    this._userMessageFactory = null;
    /** 平台侧审批 id 序号（`ap-<n>`；ApprovalRequestEvent 无 id，见 _onApprovalRequest） */
    this._approvalSeq = 0;
    /**
     * 插件**认领中**的提问：callId → {sid, mark, resolve, reject, finish, lane, ...}
     * （2026-10-04 修 #791 认领；2026-10-06 修 #837 起改为**双通道**：平台经
     * `/answer` 兑现，dsh GUI 的原生作答同样兑现——先到者胜，见 `_holdQuestion`）。
     * 只装平台自持会话的提问；兑现或中止即从表里摘除；外部会话的提问一律让位
     * 原生作答者，不入本表。
     */
    this.questions = new Map();
    /**
     * `ask_user_question` 的 tool/call 登记：callId → {sid, at}（bounded）。
     * 两个用途：① legacy 模式提问不带 `wait.callId`，用真实 tool callId 作平台侧
     * 提问标识（拿不到就自造 `tsq-*`）；② `tool/result` 到达即知提问已收口 → 清
     * 挂起标记（外部会话由 GUI 作答时，插件没有别的收口信号）。
     */
    this.questionCalls = new Map();
    this._questionSeq = 0;                 // 自造提问标识序号（`tsq-<n>-<t36>`）
    this._modelsCache = null;              // {at, value} 模型目录缓存（/models）
    this._inboxSeq = 0;                    // 宿主 inbox 行兜底 id 序号
    /**
     * 全局状态流（P4 事件化）：状态帧环 + 订阅者 + 全局序号。
     *
     * 与每个会话自己的 ring 分工：会话 ring 是**完整会话事件**（喂 runner 的
     * turn 等待、SSE 渲染）；这里只发**状态变更**（created/disposed/agent/status/
     * turn 起止/interaction），字段精简、全局单一序号——Python 侧一个 SSE 连接
     * 就能维护所有 dsh 会话的实时态，不必逐会话 `/status` 轮询。
     */
    this.stateSeq = 0;
    this.stateRing = [];
    this.stateClients = new Set();
    /**
     * 归档集快照（看板归档同步，2026-10-05）：`ctx.workspaceRegistry.archivedSessionIds`
     * 的最近一次已发布值（换行拼接的 key，便于整表比对）。null=尚未取到。
     */
    this._archivedKey = null;
  }

  /**
   * 启动驱动：注册 HTTP 路由 + 等 agents 服务注入。
   * 注入用 ctx.inject 而不是顶层 `export const inject`：本插件的主职责（反代 server.py）
   * 不应因为「某个 profile 没有 agent loop」而整包不加载。
   */
  start() {
    this._registerRoutes();
    this.fiber = this.ctx.inject(['agents'], (agentCtx) => {
      this.agentCtx = agentCtx;
      agentCtx.on('session/event', (session, event) => this._onSessionEvent(session, event));
      agentCtx.on('session/created', (session) => this._observe(session));
      agentCtx.on('session/disposed', (session) => {
        const sid = String(session.id);
        this.observed.delete(sid);
        this._publishState('session/disposed', { sid });
      });
      // agent 状态变更（P0 实测跨插件可见）：payload 形状是 **单个对象**
      // `{agent, status}`（不是 (agent, status) 两参，见 runtime-types.d.ts:252）。
      // dsh 只在状态**变化时** emit，正是事件化的理想源——平台据此维护实时态。
      agentCtx.on('agent/status', (payload) => {
        const agent = payload && payload.agent;
        const status = payload && payload.status;
        const sid = agent ? String(agent.id) : '';
        if (!sid) return;
        const seen = this.observed.get(sid);
        if (seen) { seen.status = String(status || ''); seen.updatedAt = Date.now(); }
        this._publishState('agent/status', { sid, data: { status: String(status || '') } });
      });
      // 提问是 waterfall（非会话事件）：**必须 prepend**（2026-10-04 修 #791，原因见
      // `_onQuestionRequest`）——平台自持会话由插件认领并等 `/answer` 兑现，外部
      // 会话只旁听、原样 next() 交给原生作答者
      agentCtx.on('user-questions/request',
                  (request, next) => this._onQuestionRequest(request, next),
                  { prepend: true });
      // 审批同为 waterfall：默认 next() 让位（GUI 弹窗照常可答）；仅当平台通过
      // `/permission` 接管过该会话（holdApprovals）时才认领，等 `/approval` 送达
      agentCtx.on('approval/request', (request, next) => this._onApprovalRequest(request, next));
      // 宿主 inbox（P6 #21）：排队消息的增/领/弃三个事件都可见 ⇒ 平台会话窗能
      // 展示「宿主排队行」（kimi 侧等价物是 /prompts 的 queued 段）。
      agentCtx.on('agent/inbox/inserted', (payload) => this._onInbox('inserted', payload));
      agentCtx.on('agent/inbox/claimed', (payload) => this._onInbox('claimed', payload));
      agentCtx.on('agent/inbox/discarded', (payload) => this._onInbox('discarded', payload));
      this.ready = true;
      this.logger.info(`touchstone: agent 驱动就绪（会话池 + SSE 事件流，前缀 ${DRIVER_PREFIX}）`);
    });
    // 业务服务延迟注入（2026-10-03 P3）：缺失不阻塞插件加载，调用时按需 get；
    // inject 只是把「服务可能懒创建」这件事触发掉（P0 实测 sessionController
    // 在 get 前是 missing、inject 后 present）。
    this.ctx.inject(['sessionController'], () => {
      this.logger.info('touchstone: sessionController 可用（fork/rename/selectModel）');
    });
    this.ctx.inject(['commands'], () => {
      this.logger.info('touchstone: commands 可用（/compact 触发）');
    });
    this.ctx.inject(['permissionPresets'], () => {
      this.logger.info('touchstone: permissionPresets 可用（权限 preset 切换）');
    });
    // 归档集订阅（看板归档同步，2026-10-05）：与官方 WorkspaceFeed 同源——宿主的
    // 归档集走 domain 存储落盘，每次写入即发 `domain/changed`。事件为主（静置期零
    // 请求），`_keepalive()` 15s 再比对一次兜底（读 registry 内存，不发 HTTP）。
    // 基线帧在注入后立即发一帧，平台（重）连时也能从 stateRing 补到。
    this.ctx.inject(['workspaceRegistry'], (wsCtx) => {
      // 事件挂在注入作用域上（契约自检的桩 ctx 只有 agentCtx 有 on；真机两者同一总线）
      const bus = (wsCtx && typeof wsCtx.on === 'function') ? wsCtx : this.ctx;
      if (bus && typeof bus.on === 'function') {
        bus.on('domain/changed', (change) => this._onDomainChanged(change));
      }
      this._publishArchiveState(true);
      this.logger.info('touchstone: workspaceRegistry 可用（归档集事件 + /archived//archive）');
    });
    this._timer = setInterval(() => this._keepalive(), KEEPALIVE_MS);
    if (this._timer.unref) this._timer.unref();
    // 归档集快速兜底（2026-10-07）：事件为主路径已毫秒级，这里只是二道防线
    this._sweepTimer = setInterval(() => this._publishArchiveState(false),
                                   ARCHIVE_SWEEP_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  /** 停用：注销路由、断开 SSE、释放常驻会话与观察表。 */
  async dispose() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._sweepTimer = null;
    for (const disposeRoute of this._routes) {
      try {
        disposeRoute();
      } catch {
        /* 路由已随 fiber 注销：忽略 */
      }
    }
    this._routes = [];
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) {
      for (const res of entry.clients) {
        try {
          res.end();
        } catch {
          /* 已断开 */
        }
      }
      entry.clients.clear();
      await this._disposeHandle(entry);
    }
    // 认领中的提问：插件要走了，兑现不了——reject 收口（宿主 `ask()` 见信号中止/
    // 异常会归一，tool result 记中断），并清挂起标记、收起 dsh GUI 的提问框，
    // 避免平台侧与浏览器侧各残留一个 pending
    for (const [callId, pending] of [...this.questions]) {
      this.questions.delete(callId);
      try {
        pending.finish();
        pending.cancelLane();
        pending.reject(new Error('touchstone driver disposed before the question settled'));
      } catch {
        /* 已收口/已兑现：忽略 */
      }
    }
    this.questionCalls.clear();
    this.observed.clear();
    this.ready = false;
  }

  /** 会话池快照（Python 侧 /live 端点；零 REST，直接读内存态）。 */
  live() {
    const owned = [...this.sessions.values()].map((entry) => ({
      session_id: entry.sessionId,
      task: entry.task,
      cwd: entry.cwd,
      status: entry.agent ? entry.agent.status : entry.status,
      owned: true,
      interaction: entry.interaction,
      last_turn_reason: entry.lastTurnReason,
      cancelled: Boolean(entry.cancelRequested),   // 平台已发起取消（诊断用）
      usage: entry.usage || null,                  // 上下文用量（assistant/message 累积）
      permission: this._permissionState(entry),    // 会话级权限（{mode, preset}；进程内回读）
      started_at: entry.createdAt,        // 平台侧「运行中会话精确探测」的排序依据
      // 会话头行 origin（子代理='subagent'，主会话=空串）：平台据此不建卡/不占位
      origin: this._sessionOrigin(entry.agent && entry.agent.session),
    }));
    const external = [];
    for (const [sid, info] of this.observed) {
      if (this.sessions.has(sid)) continue;   // 平台自持会话已在 owned 列表
      const live = this.agentCtx ? this.agentCtx.agents.get(sid) : null;
      external.push({
        session_id: sid,
        task: '',
        cwd: info.cwd,
        status: live ? live.status : 'unknown',
        owned: false,
        origin: info.origin || '',          // 子代理会话标记（见 _sessionOrigin）
        interaction: info.interaction || null,
        last_turn_reason: info.lastTurnReason || null,
      });
    }
    return [...owned, ...external];
  }

  // ---------- 会话事件 ----------

  /**
   * 全局 `session/event` 监听：只把**平台自持会话**的帧推给 SSE；同时维护
   * `observed` 表，让「已知会话 id 的实时态」不必回 REST/磁盘查。
   */
  _onSessionEvent(session, event) {
    const sid = String(session.id);
    const entry = this.sessions.get(sid);
    // 轮次起止：平台侧「忙/闲 + 轮次结果」的权威事件（P4 状态流也发一份）
    if (event.type === 'turn/start') {
      // 带会话事件 seq：平台侧 turn 归属基线（_web_turn_baseline）改读状态流，
      // 于是整条调和路径不再有任何 /status 调用
      this._publishState('turn/start', { sid, data: { event_seq: event.seq } });
    }
    if (event.type === 'turn/end') {
      // reason 归一（2026-10-03 P0 实测）：用户 cancel 时 dsh 落盘的 reason 是
      // **null**（raw 帧 `{"turn":1,"reason":null}`），而类型声明 reason 恒为
      // TurnEndReason（aborted 等）。平台按「completed/aborted 正常，其余算失败」
      // 的既有口径消费（runner.turn_exit_code / board._web_turn_error），null 会被
      // 判成轮次失败（退出码 1），把「用户主动中断」误报为失败。故此处把 null
      // 归一为 `aborted`（→ 平台 130 / 不算错误），并保留 cancelRequested 供排查。
      const rawReason = event.data ? event.data.reason : null;
      const kind = (rawReason && rawReason.kind)
        || (rawReason == null ? 'aborted' : null);
      if (entry) {
        entry.lastTurnReason = kind || null;
        entry.cancelRequested = false;      // 本轮已收口，标志复位
      }
      const seen = this.observed.get(sid);
      if (seen) seen.lastTurnReason = kind || null;
      this._publishState('turn/end', { sid, data: { reason: kind || null,
                                                     event_seq: event.seq } });
    }
    // 上下文用量（2026-10-03 P3）：dsh 的 TokenUsage 没有「窗口上限」，只有已用量
    // （total 优先，否则 input+output）——平台按「无 max 则画灰环」消费
    if (event.type === 'assistant/message') {
      const usage = event.data && event.data.usage;
      if (usage && entry) {
        const input = Number(usage.inputTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        entry.usage = { input, output,
                        total: Number(usage.totalTokens) || (input + output),
                        cache_read: Number(usage.cacheReadTokens) || 0 };
        // 用量也进全局状态流（P6）：平台侧会话窗的 ctx 圈据此更新，无需轮询 /status
        this._publishState('usage', { sid, data: entry.usage });
      }
    }
    // 会话记录增长（P4 会话窗口事件化）：assistant/user/tool 消息各发一帧
    // 「transcript」——平台侧会话窗口据此做**增量拉取**（after=last_seq+1），
    // 于是 2s 轮询退场、流式文本按条到达（粒度＝一条消息，不是按节拍）。
    // 帧只带会话事件 seq，不带内容（内容仍由会话存储读取，事件层不做格式转换）。
    if (event.type === 'assistant/message' || event.type === 'user/message'
        || event.type === 'tool/result') {
      this._publishState('transcript', { sid, data: { event_seq: event.seq,
                                                     kind: event.type } });
    }
    // 审批是会话事件（log-only audit），与提问共同构成「等人工输入」实况
    if (event.type === 'approval/asked') {
      const mark = { kind: 'approval', id: event.data && event.data.id,
                     tool: (event.data && event.data.toolName) || '',
                     reason: (event.data && event.data.reason) || '' };
      if (entry) entry.interaction = mark;
      const seen = this.observed.get(sid);
      if (seen) seen.interaction = mark;
      this._publishState('driver/interaction', { sid, data: { state: 'asked', interaction: mark } });
    }
    if (event.type === 'approval/decided') {
      if (entry) entry.interaction = null;
      const seen = this.observed.get(sid);
      if (seen) seen.interaction = null;
      this._publishState('driver/interaction', {
        sid, data: { state: 'decided', outcome: (event.data && event.data.outcome) || '' } });
    }
    // 提问的工具调用/结果（2026-10-04 修 #791）：
    //  · tool/call：`ask_user_question` 的真实 callId 只在这里出现——legacy 模式下
    //    的 waterfall 请求**不带** `wait.callId`，故登记下来作平台侧提问标识；
    //  · tool/result：该 callId 的提问已收口（GUI 作答/中断/超时）→ 清挂起标记。
    //    外部会话由 dsh GUI 作答时插件没有别的收口信号，不清就会永远挂在
    //    `observed` 表里（平台一直把该卡当「提问挂起」）。
    if (event.type === 'tool/call') {
      const data = event.data || {};
      if (data.name === 'ask_user_question' && data.callId) {
        this._rememberQuestionCall(sid, String(data.callId));
      }
    } else if (event.type === 'tool/result') {
      const callId = String((((event.data || {}).message) || {}).toolCallId || '');
      const rec = callId ? this.questionCalls.get(callId) : undefined;
      if (rec !== undefined) {
        this.questionCalls.delete(callId);
        // 认领中的提问不收口：timed 模式的提问可能先超时返回 pending，平台仍可按
        // 「continued」迟到作答（此时挂起标记要留着）
        if (rec.sid === sid && !this._heldQuestionOf(sid)) this._clearQuestionMark(sid);
      }
    }
    const seen = this.observed.get(sid);
    if (seen) seen.updatedAt = Date.now();
    if (!entry) return;                        // 外部会话：不入环、不推流（仅观察）
    // 会话流必须与状态流**同口径**归一 turn/end 的 null reason（P7a 真机验收实测缺口）：
    // runner/chat 消费的是会话流（`TurnWaiter` 读 data.reason.kind），上一版只归一了
    // 状态流 ⇒ 用户取消的轮次在状态流里是 aborted、在会话流里仍是 null，
    // `turn_exit_code(null)=1` 把「主动中断」判成轮次失败（任务轮记 failed）。
    let relay = event;
    if (event.type === 'turn/end') {
      const raw = (event.data || {}).reason;
      const kind = (raw && raw.kind) || (raw == null ? 'aborted' : null);
      relay = { ...event, data: { ...(event.data || {}), reason: kind ? { kind } : raw } };
    }
    entry.publish({ sid, ...trimEvent(relay) });
  }

  /** 会话头行的 origin（dsh 子代理会话为 `'subagent'`，主会话/未上报为空串）。
   *
   * 为什么平台需要它（2026-10-07）：子代理会话与主会话同 bucket 同格式，平台侧
   * 原本把每个会话都建成看板卡并在其运行时落 `ext:` 占用行——子代理是主会话的
   * 实现细节，于是「一次派 8 个子代理」＝多 8 张卡 + 项目被占满不补位（实障：
   * 卡 870 排队 5 小时）。平台据此把子代理排除在建卡与占用之外，判定源就是这里。
   * 空串＝未知（绝不能推断成「非子代理」）。
   */
  _sessionOrigin(session) {
    return String((session && session.header && session.header.origin) || '');
  }

  /** `session/created`：登记全局可见会话（外部直跑会话的发现入口）。 */
  _observe(session) {
    const sid = String(session.id);
    const cwd = (session.header && session.header.cwd) || '';
    this.observed.set(sid, {
      cwd,
      origin: this._sessionOrigin(session),
      lastTurnReason: null,
      interaction: null,
      updatedAt: Date.now(),
    });
    this._publishState('session/created', {
      sid, data: { cwd, owned: this.sessions.has(sid), origin: this._sessionOrigin(session) } });
  }

  /**
   * 推一帧**状态**帧给全局订阅者（P4）：入环（溢出丢最旧）+ 广播。
   * 帧形：`{seq, time, type, session_id, data}`——`seq` 是全局单调序号，
   * Python 侧断连重连按 `since=<last_seq>` 补发，无需任何状态轮询。
   */
  _publishState(type, payload) {
    const frame = {
      seq: ++this.stateSeq,
      time: Date.now(),
      type,
      session_id: (payload && payload.sid) || '',
      data: (payload && payload.data) || {},
    };
    this.stateRing.push(frame);
    if (this.stateRing.length > STATE_RING_MAX) {
      this.stateRing.splice(0, this.stateRing.length - STATE_RING_MAX);
    }
    for (const res of this.stateClients) {
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      } catch {
        this.stateClients.delete(res);   // 写失败即已断，交由 close 事件清理
      }
    }
    return frame;
  }

  /** 全局状态流 SSE：先补发 `seq > since` 的环内帧，再持续推送。 */
  _stateEvents(req, res, url) {
    const since = Number(url.searchParams.get('since') || '0') || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    for (const frame of this.stateRing) {
      if (typeof frame.seq === 'number' && frame.seq <= since) continue;
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    this.stateClients.add(res);
    const cleanup = () => this.stateClients.delete(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /**
   * `user-questions/request`（waterfall，**prepend 注册**）：提问的观测 + 双通道作答。
   *
   * 为什么必须 prepend（2026-10-04 隔离实例探针实测，修 #791）：
   * dsh Web 的客户端问答桥（`@deepseek-ai/dsh-api-remotes` 把该 waterfall 转发给
   * 浏览器客户端并等它作答）**先于本插件注册且认领后不再回调 `next()`**——默认
   * append 注册的 listener 永远收不到提问（实测：append 与 root-ctx append 两个
   * listener 均不触发，prepend 的才触发）。prepend 只抢「先看」的位置，是否让位
   * 由下面的分支决定，故 Web GUI 对**外部会话**的行为一个字节都没变。
   *
   * 两条分支：
   *  1) 平台自持会话（`/session` 建的池内会话，看板卡与任务轮都走它）：**双通道**——
   *     插件认领（平台 `/answer` 兑现，Touchstone 会话窗渲染选择框可作答）**并且**
   *     把请求交回下游原生链路（dsh Web GUI 同样弹提问框、同样可作答），两侧先答者胜
   *     （竞速口径见 `_holdQuestion`）。
   *      · 为什么必须认领：dsh 阻塞式 `ask_user_question`（tool-ask-user 默认 legacy
   *        模式）**不带 `request.wait.callId`**，而宿主
   *        `userQuestions.answer(agent, callId, …)` 只受理「continued」（前台等待超时
   *        后）的提问——**在途提问只有 waterfall 链内返回答案这一条路**。只让位不认领，
   *        平台的 answerable/作答通道全程空转（#791：Touchstone 会话窗不出现选择框）。
   *      · 为什么要让位（2026-10-06 修 #837）：纯认领时该 waterfall 到插件为止，dsh Web
   *        GUI 收不到提问 —— 提问框只在 Touchstone 侧出现。预期是**两侧都显示**。
   *  2) 其它会话（用户自己直跑/外部会话）：只旁听（发状态帧，平台据此把卡置阻塞、
   *     把 ext 行按挂起处置），`next()` 让原生作答者（dsh Web GUI）照旧作答。
   */
  _onQuestionRequest(request, next) {
    const agent = request && request.agent;
    const sid = agent ? String(agent.id) : '';
    const waitCallId = String((request && request.wait && request.wait.callId) || '');
    const entry = sid ? this.sessions.get(sid) : undefined;
    if (entry !== undefined) {
      // 平台自持会话：双通道。标识优先取宿主给的 wait.callId（timed 模式），
      // 否则取 `ask_user_question` 的真实 tool callId（legacy 模式），再否则自造
      const callId = waitCallId || this._takeQuestionCallId(sid) || this._nextQuestionId();
      // 先留原宿主取消信号（轮次中止/停卡）：打开原生通道会替换请求对象上的
      // `signal`（见 `_openNativeLane`），平台侧的收口仍要认**原信号**
      const hostSignal = request && request.signal;
      const lane = this._openNativeLane(request, next);
      return this._holdQuestion(entry, callId, request, hostSignal, lane);
    }
    if (!sid) return next();
    this._publishQuestionMark(sid, waitCallId, request);
    return next();
  }

  /**
   * 打开「原生作答通道」：把提问交回 waterfall 下游（dsh Web 客户端问答桥 → 浏览器
   * 提问框），返回 `{promise, cancel}`。dsh GUI 的作答经该 promise 回到宿主
   * `ask_user_question`，与平台 `/answer` 是同一条 waterfall 语义。
   *
   * 为什么转发前要替换 `request.signal`（修 #837 的关键；依据是读
   * `@deepseek-ai/dsh-api-gateway` 两个半壳代码，不是猜测）：
   *  · Host 半（`lib/index.js` `startRemoteEvent`）：请求对象上的 `signal` 被登记为该
   *    pending 事件的**宿主取消信号**，一旦 abort 就 `finishRemoteEvent` 并向浏览器补发
   *    `{type:'cancel', eventId}`；
   *  · Client 半（`lib/client.js` 的 `frame.type === 'cancel'`）：收到 cancel 即 abort 该
   *    次投递的 signal ⇒ 客户端问答桥的 `claimSignal` 中止 ⇒ 提问框自行收起、
   *    定时等待（timed 模式）一并释放。
   *  平台先在 Touchstone 侧作答时，这是插件**唯一**能让 dsh GUI 那张框消失的手段
   *  （否则框会留在输入区，用户再答也无人接收）。
   *  `request` 是宿主 `ask()` 里 `{...request, agent}` 造出来的**浅拷贝**，只被本链下游
   *  看到；宿主 `ask()` 自身的取消判断读原对象，故替换不影响它。替换后仍把原信号接进来
   *  （停卡/轮次中止时两端一起收口，行为与替换前一致）。
   *
   * 下游失败（无 Web 客户端问答桥的 profile 如 headless、客户端内部异常）只当该通道
   * 不存在：这里先吃掉 rejection（平台通道仍等 `/answer`），调用方只竞速**成功**值。
   *
   * @returns {{promise: Promise<any>, cancel: (reason?: Error) => void}}
   */
  _openNativeLane(request, next) {
    const upstream = request && request.signal;
    const controller = new AbortController();
    if (upstream) {
      if (upstream.aborted) controller.abort(upstream.reason);
      else if (typeof upstream.addEventListener === 'function') {
        upstream.addEventListener('abort', () => controller.abort(upstream.reason), { once: true });
      }
    }
    try {
      request.signal = controller.signal;      // 网关据此登记取消/收框
    } catch {
      /* 请求对象被冻结（异常形态）：退化为「平台先答时 GUI 的框不自收」，不影响作答 */
    }
    let promise;
    try {
      promise = Promise.resolve(next());
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.catch(() => {});                   // 见 docstring：下游失败由平台通道兜底
    return { promise, cancel: (reason) => { try { controller.abort(reason); } catch { /* 已中止 */ } } };
  }

  /**
   * 认领一个平台自持会话的提问：登记进 `this.questions`、发挂起状态帧，返回的 Promise
   * 由**两个作答通道先到者**兑现——① 平台 `/answer`；② 原生链路（dsh GUI 提问框，
   * `_openNativeLane`）。返回值直接交回宿主 `ask_user_question`。
   *
   * 竞速口径（修 #837，两侧都显示、都可答）：
   *  · 原生链路**成功**即胜出：清平台挂起标记（Touchstone 会话窗的框随之收起），
   *    平台侧迟到的 `/answer` 落到 `svc.answer` 的 continued 通道（accepted=false，
   *    平台按 40405 收口，不空转）。
   *  · 原生链路**失败**不算数（GUI 点「取消」、客户端异常、无客户端的 profile…）：
   *    平台通道继续等 `/answer`。真正的失败只由宿主取消信号（停卡/cancel）给出。
   *  · 平台先答：`_settleQuestion` 主动 abort 原生通道的取消信号 → dsh GUI 的提问框
   *    自行收起（见 `_openNativeLane`），不留「答了也没人收」的死框。
   *
   * 中止（用户停卡/cancel）：宿主 abort 信号触发 → reject 普通 Error，宿主 `ask()`
   * 见「信号已中止」会归一为 ASK_ABORTED（tool result 记中断，与旧行为一致）。
   */
  _holdQuestion(entry, callId, request, hostSignal, lane) {
    const sid = entry.sessionId;
    return new Promise((resolve, reject) => {
      const pending = { sid, callId, mark: null, done: false, finish: null, resolve, reject,
                        lane: lane || null,
                        cancelLane: () => { if (lane) lane.cancel(new Error('the platform answered the question first')); } };
      this.questions.set(callId, pending);
      /** 收口（幂等）：摘表 + 解绑中止监听 + 清挂起标记 */
      pending.finish = () => {
        if (pending.done) return;
        pending.done = true;
        if (this.questions.get(callId) === pending) this.questions.delete(callId);
        if (pending.onAbort && hostSignal
            && typeof hostSignal.removeEventListener === 'function') {
          hostSignal.removeEventListener('abort', pending.onAbort);
        }
        this._clearQuestionMark(sid);
      };
      // 原生通道（dsh GUI）：成功即胜出并清平台挂起标记；失败一律忽略（平台通道仍在）
      if (lane) {
        lane.promise.then((value) => {
          if (pending.done) return;
          pending.finish();
          resolve(value);
        }, () => { /* 见 docstring：旁路故障不判死提问 */ });
      }
      if (hostSignal) {
        if (hostSignal.aborted) {
          pending.finish();
          pending.cancelLane();
          reject(new Error('ask_user_question aborted before the platform answered'));
          return;
        }
        pending.onAbort = () => {
          pending.finish();
          pending.cancelLane();
          reject(new Error('ask_user_question aborted before the platform answered'));
        };
        hostSignal.addEventListener('abort', pending.onAbort);
      }
      pending.mark = this._publishQuestionMark(sid, callId, request);
    });
  }

  /**
   * 兑现认领中的提问（平台 `/answer` 送达）：true=命中并已交付宿主。
   * 平台先答时顺带 abort 原生通道的取消信号——dsh GUI 的提问框随之收起（修 #837）。
   */
  _settleQuestion(callId, answer) {
    const pending = this.questions.get(callId);
    if (pending === undefined) return false;
    pending.finish();
    pending.cancelLane();
    pending.resolve(answer);
    return true;
  }

  /** 本会话是否有认领中的提问（`tool/result` 收口判据；返回 callId 或空串）。 */
  _heldQuestionOf(sid) {
    for (const [callId, pending] of this.questions) {
      if (pending.sid === sid) return callId;
    }
    return '';
  }

  /** 自造提问标识（legacy 模式的提问没有宿主 callId；平台原样回传即可）。 */
  _nextQuestionId() {
    this._questionSeq += 1;
    return `tsq-${this._questionSeq.toString(36)}-${Date.now().toString(36)}`;
  }

  /** 登记 `ask_user_question` 的真实 tool callId（提问标识来源；顺带淘汰过期项）。 */
  _rememberQuestionCall(sid, callId) {
    const now = Date.now();
    for (const [key, rec] of this.questionCalls) {
      if (now - rec.at > QUESTION_CALL_TTL_MS) this.questionCalls.delete(key);
    }
    while (this.questionCalls.size >= QUESTION_CALL_MAX) {
      const oldest = this.questionCalls.keys().next().value;
      this.questionCalls.delete(oldest);
    }
    this.questionCalls.set(callId, { sid, at: now });
  }

  /** 取走（一次性）本会话最近一次 `ask_user_question` 的 callId；无则空串。 */
  _takeQuestionCallId(sid) {
    let found = '';
    let foundAt = 0;
    for (const [callId, rec] of this.questionCalls) {
      if (rec.sid === sid && rec.at >= foundAt) {
        found = callId;
        foundAt = rec.at;
      }
    }
    if (found) this.questionCalls.delete(found);
    return found;
  }

  /**
   * 提问标记（平台 `board._iw_interaction` 消费的挂起实况）：
   * `{kind, call_id, questions:[{id, header, question, detail, multi, options}]}`。
   * 选项保留 `{label, description}` 双字段（dsh `AskUserQuestionOption` 的语义）——
   * 平台会话窗按「label 主行 + description 次行」渲染（kimi web 时代同形）。
   */
  _questionMark(callId, request) {
    const list = ((request && request.questions) || []).map((q) => ({
      id: (q && q.id) || '',
      header: (q && q.header) || '',
      question: (q && q.question) || '',
      detail: (q && q.detail) || '',
      multi: Boolean(q && q.multiSelect),
      options: ((q && q.options) || []).map((o) => ({
        label: (o && (o.label || o.value)) || '',
        description: (o && o.description) || '',
      })),
    }));
    return { kind: 'question', call_id: callId || '', questions: list };
  }

  /**
   * 记录并广播「提问挂起」标记：会话池（自持会话）+ observed（外部会话）+
   * 全局状态流（P4：外部会话也要发——平台靠它把外部直跑会话映射成 ext 行的挂起态）。
   */
  _publishQuestionMark(sid, callId, request) {
    const mark = this._questionMark(callId, request);
    if (!sid) return mark;
    const entry = this.sessions.get(sid);
    const seen = this.observed.get(sid);
    if (entry) {
      entry.interaction = mark;
      entry.publish({ sid, seq: null, time: Date.now(), type: 'driver/interaction',
                      data: { state: 'asked', interaction: mark } });
    }
    if (seen) seen.interaction = mark;
    this._publishState('driver/interaction', { sid, data: { state: 'asked', interaction: mark } });
    return mark;
  }

  /** 清「提问挂起」标记（作答送达/提问收口）：状态流发一帧非 asked 态即清。 */
  _clearQuestionMark(sid) {
    if (!sid) return;
    const entry = this.sessions.get(sid);
    const seen = this.observed.get(sid);
    if (entry) entry.interaction = null;
    if (seen) seen.interaction = null;
    this._publishState('driver/interaction', { sid, data: { state: 'answered' } });
  }

  /** 周期 keepalive：SSE 注释帧（无 data，不触发客户端 onmessage）+ 归档集兜底比对。 */
  _keepalive() {
    for (const entry of this.sessions.values()) {
      for (const res of entry.clients) {
        try {
          res.write(': keepalive\n\n');
        } catch {
          entry.clients.delete(res);
        }
      }
    }
    // 归档集兜底：`domain/changed` 万一没送达（其它插件把事件吞了/组合层差异），
    // 15s 内也能把变化推出去；registry 内存读，不产生任何 HTTP 请求。
    this._publishArchiveState(false);
  }

  // ---------- 会话归档（看板「已完成」双向同步的宿主侧通道） ----------

  /**
   * 读宿主归档集（registry-global：会话对**所有**分组面隐藏，取消归档恢复原位次）。
   * @returns {string[]|null} 会话 id 数组；workspaceRegistry 不可用/异常 → null（未知）
   */
  _archivedIds() {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) return null;
      const ids = registry.archivedSessionIds;
      return Array.isArray(ids) ? ids.map(String) : null;
    } catch {
      return null;
    }
  }

  /**
   * `domain/changed` → 归档集推帧（事件为主路径）。
   *
   * **为什么取事件载荷而不是回读 registry（2026-10-07 真机实测定因）**：官方
   * `WorkspaceRegistry.setState()` 的写法是 `await this.global.set(state)` **之后**
   * 才更新自己的内存缓存 `this.state`，而 `domain/changed` 正是在 `global.set`
   * 内部**同步**发出的——监听器执行时 `registry.archivedSessionIds` 读到的还是
   * **旧快照**，旧实现据此算出「key 没变」直接早退、一帧都不推；真机表现为
   * 「dsh GUI 归档后要等 15s keepalive 才把卡片搬进『已完成』」（四组实测：
   * RPC 13~19ms，帧延迟 1.1/6.1/6.1/13.8s，全部落在 keepalive 节拍上）。
   * 事件载荷 `change.value` 就是刚落盘的整表状态（与 registry 随后缓存的是同一个
   * 对象引用），取 `archivedSessionIds` 即权威新值；非全局态写入（`table` 非空，
   * 如 workspaces 表记录）不携带该字段 → 回退读 registry（那类写入本就不改归档集）。
   * @param {object} change - `{domain, table, key, operation, value}`
   */
  _onDomainChanged(change) {
    if (!change || change.domain !== 'workspace') return;
    const state = change.table ? null : change.value;
    const ids = (state && Array.isArray(state.archivedSessionIds))
      ? state.archivedSessionIds : undefined;
    this._publishArchiveState(false, ids);
  }

  /**
   * 归档集变化 → 推一帧 `driver/archived` **整表快照**（进 stateRing + 广播）。
   * 整表而非增量：平台卡片绑定的 sid 可能不在会话池/观察表里（历史会话），
   * 整表帧覆盖任意 sid，且平台侧一次覆盖、无需逐会话记账。
   * @param {boolean} force - true=无条件发（启动基线）；false=与上次发布值比对
   * @param {string[]|undefined} ids - 权威归档集（`domain/changed` 事件载荷优先）；
   *   缺省＝回读 registry（keepalive / 快速兜底扫描路径）
   */
  _publishArchiveState(force, ids) {
    const list = Array.isArray(ids) ? ids.map(String) : this._archivedIds();
    if (list === null) return;                // 服务缺失：不发帧（平台侧维持「未知」）
    const key = list.join('\n');
    if (!force && key === this._archivedKey) return;
    this._archivedKey = key;
    this._publishState('driver/archived', { data: { archived: list } });
  }

  /** `GET /archived`：归档集整表（平台 EventHub 在(重)连对齐时取一次）。 */
  _archived(res) {
    const ids = this._archivedIds();
    if (ids === null) {
      this._json(res, 503, { error: 'workspaceRegistry 不可用，归档集不可读' });
      return;
    }
    this._json(res, 200, { archived: ids });
  }

  /**
   * `POST /archive` {session_id, archived}：归档（默认）或取消归档，两条都幂等。
   *
   * 归档走 `stopActivity: true`：平台进入「已完成」时刚停过会话，但 abort 是异步的，
   * 宿主侧可能仍认为有在跑的工作——带此开关由宿主自己先归档再停工作，避免平台因
   * 竞态拿到 `WorkspaceActiveSessionError`。
   * 状态码约定（平台据此分流）：200=成功；**410=会话不存在**（`WorkspaceUnknownSessionError`，
   * 平台按「无同步对象」跳过并放行卡片）；503=服务缺失；其余异常 409/500。
   */
  async _archive(res, req) {
    const body = await this._body(req);
    const sid = String(body.session_id || '');
    const want = body.archived !== false;     // 缺省 = 归档
    if (!sid) {
      this._json(res, 400, { error: 'session_id 不能为空' });
      return;
    }
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry) {
      this._json(res, 503, { error: 'workspaceRegistry 不可用，无法归档' });
      return;
    }
    try {
      if (want) await registry.archiveSession(sid, { stopActivity: true });
      else await registry.unarchiveSession(sid);
    } catch (err) {
      const name = String((err && err.name) || '');
      const msg = String((err && err.message) || err);
      if (name === 'WorkspaceUnknownSessionError' || /cannot archive session/.test(msg)) {
        this._json(res, 410, { error: `会话不存在，无法归档: ${sid}` });
        return;
      }
      this._json(res, 409, { error: msg });
      return;
    }
    // 事件之外再补一帧：不等 domain/changed 的投递时序，响应返回前归档集已可读
    this._publishArchiveState(false);
    this._json(res, 200, { session_id: sid, archived: want });
  }

  // ---------- HTTP 契约 ----------

  /** 注册 `${DRIVER_PREFIX}` 前缀路由（一个 handler 内做子路径分派）。 */
  _registerRoutes() {
    const webServer = this.ctx.get('webServer');
    if (!webServer) {
      this.logger.warn('touchstone: webServer 不可用, agent 驱动不注册路由');
      return;
    }
    const dispose = webServer.register({
      kind: 'prefix',
      path: DRIVER_PREFIX,
      handler: (req, res) => this._handle(req, res),
    });
    this._routes.push(dispose);
  }

  /** 前缀处理器：鉴权 → 子路径分派。 */
  async _handle(req, res) {
    const peer = (req.socket && req.socket.remoteAddress) || '';
    if (!LOOPBACK.has(peer)) {                       // 红线 1：只认回环来源
      this._json(res, 403, { error: `driver 仅接受回环来源（收到 ${peer}）` });
      return;
    }
    if (req.headers['x-ts-driver-token'] !== this.token) {
      this._json(res, 403, { error: 'driver 令牌不匹配' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.slice(DRIVER_PREFIX.length) || '/';
    try {
      if (path === '/health' && req.method === 'GET') return this._json(res, 200, this._health());
      if (path === '/live' && req.method === 'GET') return this._json(res, 200, { sessions: this.live() });
      if (path === '/status' && req.method === 'GET') return this._status(res, url);
      // `?scope=state` = 全局状态流（P4，Python EventHub 唯一连接）；缺省 = 单会话事件流
      if (path === '/events' && req.method === 'GET') {
        if ((url.searchParams.get('scope') || '') === 'state') return this._stateEvents(req, res, url);
        return this._events(req, res, url);
      }
      if (path === '/session' && req.method === 'POST') return await this._session(res, req);
      if (path === '/prompt' && req.method === 'POST') return await this._prompt(res, req);
      if (path === '/answer' && req.method === 'POST') return await this._answer(res, req);
      if (path === '/steer' && req.method === 'POST') return await this._steer(res, req);
      if (path === '/cancel' && req.method === 'POST') return await this._cancel(res, req);
      if (path === '/dispose' && req.method === 'POST') return await this._disposeSession(res, req);
      // P3 对齐端点（2026-10-03）：compact / fork / rename / model
      if (path === '/compact' && req.method === 'POST') return await this._compact(res, req);
      if (path === '/fork' && req.method === 'POST') return await this._fork(res, req);
      if (path === '/rename' && req.method === 'POST') return await this._rename(res, req);
      if (path === '/model' && req.method === 'POST') return await this._model(res, req);
      // P3 第二批（2026-10-03）：审批代答 + 权限 preset
      if (path === '/approval' && req.method === 'POST') return await this._approval(res, req);
      if (path === '/permission' && req.method === 'POST') return await this._permission(res, req);
      if (path === '/presets' && req.method === 'GET') return this._presets(res, url);
      if (path === '/models' && req.method === 'GET') return await this._models(res);
      if (path === '/media' && req.method === 'GET') return await this._media(res, url);
      // 会话归档（看板「已完成」双向同步，2026-10-05）
      if (path === '/archived' && req.method === 'GET') return this._archived(res);
      if (path === '/archive' && req.method === 'POST') return await this._archive(res, req);
      this._json(res, 404, { error: `未知驱动端点 ${path}` });
    } catch (err) {
      this.logger.warn(`touchstone: 驱动 ${path} 失败: ${err && err.message}`);
      this._json(res, 500, { error: String((err && err.message) || err) });
    }
  }

  /** 就绪探测：agent loop 未装载（无 agents 服务）时 ok=false，Python 侧据此报错而非静默挂起。 */
  _health() {
    return {
      ok: this.ready,
      service: 'touchstone-agent-driver',
      prefix: DRIVER_PREFIX,
      live: this.sessions.size,
      observed: this.observed.size,
    };
  }

  /** 单会话状态：含 last_seq（Python 订阅 SSE 时的续传基准）。 */
  _status(res, url) {
    const sid = url.searchParams.get('session_id') || '';
    const entry = this.sessions.get(sid);
    if (!entry) {
      this._json(res, 404, { error: `会话不在驱动池中: ${sid}` });
      return;
    }
    this._json(res, 200, {
      session_id: sid,
      status: entry.agent ? entry.agent.status : entry.status,
      last_seq: entry.lastSeq,
      last_turn_reason: entry.lastTurnReason,
      cancelled: Boolean(entry.cancelRequested),   // 平台是否已发起取消（诊断用）
      usage: entry.usage || null,                  // 上下文用量（input/output/total）
      model: entry.model || null,                  // 会话级模型（/model 切过才有）
      permission: this._permissionState(entry),    // 会话级权限（{mode, preset}）
      inbox: entry.inbox || [],                    // 宿主排队行（{id,text}）
      approval_held: Boolean(entry.holdApprovals), // 平台是否接管了本会话审批
      pending_approval: entry.pendingApproval ? entry.pendingApproval.id : null,
      interaction: entry.interaction,
      cwd: entry.cwd,
      task: entry.task,
      // 会话头行 origin（子代理='subagent'，主会话=空串）——与 /live 同口径
      origin: this._sessionOrigin(entry.agent && entry.agent.session),
    });
  }

  /** SSE 事件流：先补发 ring 内 seq>since 的帧，再持续推送新帧。 */
  _events(req, res, url) {
    const sid = url.searchParams.get('session_id') || '';
    const entry = this.sessions.get(sid);
    if (!entry) {
      this._json(res, 404, { error: `会话不在驱动池中: ${sid}` });
      return;
    }
    const since = Number(url.searchParams.get('since') || '0') || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',          // 反代层不缓冲（本机直连时为兜底声明）
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    for (const frame of entry.ring) {
      if (typeof frame.seq === 'number' && frame.seq <= since) continue;
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    entry.clients.add(res);
    const cleanup = () => entry.clients.delete(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /** 读并解析 JSON 请求体（超限直接 413）。 */
  _body(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('请求体超限'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`请求体不是合法 JSON: ${err.message}`));
        }
      });
      req.on('error', reject);
    });
  }

  /** 建会话 / 恢复会话：session_id 为空则新建（sid 由平台侧生成后回执）。 */
  async _session(res, req) {
    if (!this.ready) {
      this._json(res, 503, { error: 'agent 驱动未就绪（agents 服务不可用）' });
      return;
    }
    const body = await this._body(req);
    const wanted = String(body.session_id || '').trim();
    const cwd = String(body.cwd || '').trim();
    const agentOptions = {};
    if (body.provider) agentOptions.provider = String(body.provider);
    if (body.model) agentOptions.model = String(body.model);
    // sid 用 dsh **原生格式** `session-<uuid>`：会话目录名就是 sid 本身
    // （~/.dsh/sessions/<bucket>/<sid>/），平台侧 sessparse 的
    // SID_DSH_RE（^session-[0-9a-fA-F-]{8,36}$）与 _dsh_session_file 按此定位。
    // 自造前缀（如 touchstone-<uuid>）会让会话窗口 found=false、标题读取失效
    // ——真机实测踩中，2026-10-02。
    const sessionId = wanted || `session-${randomUUID()}`;
    if (this.sessions.has(sessionId)) {          // 幂等：重复建同一 sid 直接回执
      this._json(res, 200, { session_id: sessionId, created: false, resumed: false });
      return;
    }
    let handle;
    let resumed = false;
    const selection = this._resolveModel(body);
    const composition = await this._composeSetup(selection, String(body.preset || ''));
    const setup = composition.setup;
    try {
      if (wanted) {
        if (!this.ctx.get('sessionPersistence')) {
          this._json(res, 503, { error: 'sessionPersistence 服务缺失，无法恢复已有会话' });
          return;
        }
        handle = await this.agentCtx.agents.resume({
          resumeSessionId: wanted,
          agentOptions: Object.keys(agentOptions).length ? agentOptions : undefined,
          setup,
        });
        resumed = true;
      } else {
        handle = await this.agentCtx.agents.create({
          sessionId,
          meta: {
            ...(cwd ? { cwd } : {}),
            // preset 身份落进会话 meta（durable）：恢复会话时宿主据此还原工具与提示段
            ...(composition.agentPreset === undefined
              ? {} : { agentPreset: composition.agentPreset }),
          },
          agentOptions: Object.keys(agentOptions).length ? agentOptions : undefined,
          setup,
        });
      }
    } catch (err) {
      this._json(res, 500, { error: `会话${wanted ? '恢复' : '创建'}失败: ${(err && err.message) || err}` });
      return;
    }
    const entry = new DriverSession(sessionId);
    entry.handle = handle;
    entry.agent = handle.agent;
    entry.task = String(body.task || '');
    entry.cwd = cwd || (handle.agent.session.header && handle.agent.session.header.cwd) || '';
    entry.selection = composition.selection || null;   // /model 之后同步改写它（见 DriverSession.selection）
    this.sessions.set(sessionId, entry);
    // 侧栏归组（2026-10-04 修「平台任务在 dsh 侧栏全落未分组」）：dsh 侧栏按 Workspace
    // 成员表分组，而本驱动走进程内 `agents.create/resume`，绕过了 dsh 唯一会写成员表的
    // 会话命令层 ⇒ 必须自己补一次登记（详见 _attachWorkspace）。
    await this._attachWorkspace(sessionId, entry.cwd);
    this._observe(handle.agent.session);
    // P4：显式「平台已接入」帧——`session/created` 触发时本插件可能还没登记进
    // 池（owned=false），Python EventHub 以本帧为准标记 owned
    const opts = (handle.agent && handle.agent.options) || {};
    const reasoningEffort = String(opts.reasoningEffort || '');
    if (opts.provider || opts.model || reasoningEffort) {
      entry.model = { provider: String(opts.provider || ''), model: String(opts.model || ''),
                      ...(reasoningEffort ? { reasoningEffort } : {}) };
    }
    this._publishState('driver/attached', {
      sid: sessionId, data: { cwd: entry.cwd, task: entry.task, owned: true, resumed,
                              model: entry.model } });
    // 权限实况随接入帧一起推（P4 口径：会话窗控件靠事件点亮，不等首次切换）
    this._publishPermission(entry);
    this.logger.info(`touchstone: 会话 ${sessionId} ${resumed ? '已恢复' : '已创建'}`
                     + `（task=${entry.task || '-'} cwd=${entry.cwd || '-'}）`);
    this._json(res, 200, { session_id: sessionId, created: !resumed, resumed });
  }

  /**
   * 把会话登记进 dsh 工作区（= dsh 侧栏「项目」分组的唯一依据）。
   *
   * 为什么必须做（2026-10-04 实测取证）：dsh 的会话分组**不按 cwd 推导**，而是读
   * Workspace 记录里的 `sessionIds` 成员表——`dsh-client-ui-workspace` 的
   * groupByWorkspace() 按成员表分块，不在任何成员表里的会话全部进 `group.ungrouped`
   * （中文「未分组」）。而写成员表的唯一入口是会话命令层的 `attachSession`：只有
   * `session.create` 请求带 `workspaceId`（GUI 在某个工作区里新建会话）或
   * `session.fork` 的源会话已属某工作区时才会被调用；工作区 registry 的按 cwd 归组只在
   * **首次** bootstrap（initialized=false）对存量会话做一次。本驱动是进程内直接
   * `agents.create/resume`，永远走不到命令层 ⇒ 平台建的会话一律显示「未分组」。
   * 对账证据：人工新建卡的会话 9/9 未分组；GUI 里建的（sync 采纳卡）61/104 已归组；
   * 47 个未分组会话的 cwd 恰等于某个已存在的工作区 —— 缺的是登记，不是 cwd。
   *
   * 做法：按会话 cwd 找同路径工作区（`resolveByPath`，canonical realpath 全等）；
   * 没找到就按该目录新建一个（标题默认取目录名，与 dsh 自身口径一致）。
   * `attachSession` 自带幂等（已在成员表则纯 no-op），重复调用安全；恢复存量会话时
   * 也会走到这里，于是历史遗留的平台会话下次续接即自动归位。
   *
   * 失败只告警不抛：归组是侧栏展示层的事，绝不能让平台任务因分组失败而起跑失败。
   *
   * @param {string} sessionId - 已创建/恢复/接管的会话 id
   * @param {string} cwd - 会话工作目录（空则跳过；平台传的是项目「被测代码目录」）
   */
  async _attachWorkspace(sessionId, cwd) {
    const dir = String(cwd || '').trim();
    if (!dir) return;
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry) {
      this.logger.warn('touchstone: workspaceRegistry 不可用，会话不做侧栏归组');
      return;
    }
    try {
      const workspace = (await registry.resolveByPath(dir)) || (await registry.create(dir));
      await workspace.attachSession(sessionId);
      this.logger.info(`touchstone: 会话 ${sessionId} 已归入工作区 ${workspace.path}`);
    } catch (err) {
      this.logger.warn(`touchstone: 会话 ${sessionId} 归入工作区失败（cwd=${dir}）: `
                       + `${(err && err.message) || err}`);
    }
  }

  /** 投递一轮提示词：平台的「一轮」= 一次 followup + 等 turn/end（Python 侧等 SSE 帧）。 */
  async _prompt(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const text = String(body.prompt == null ? '' : body.prompt);
    if (!text) {
      this._json(res, 400, { error: 'prompt 不能为空' });
      return;
    }
    entry.agent.followup(this._userMessage(text));
    this._json(res, 200, { ok: true, session_id: entry.sessionId });
  }

  /**
   * 回答挂起的提问（2026-10-04 修 #791 起分两路；2026-10-06 修 #837 起 dsh GUI 也可答）：
   *
   *  ① 插件**认领中**的提问（平台自持会话的在途提问，`this.questions` 命中）：
   *     兑现认领 Promise——返回值由 waterfall 直接交回宿主 `ask_user_question`。
   *     这是平台答**在途**提问的通道（见 `_onQuestionRequest` 注释）。
   *  ② 认领表未命中：退回宿主 `ctx.userQuestions.answer(agent, callId, …)`——
   *     只对「continued」（前台等待超时后）的提问有效，覆盖 timed 模式超时后
   *     平台迟到作答的场景；accepted=false 表示问题已不存在/已应答（含**用户在
   *     dsh GUI 先答**的情形：#837 起两侧同题，先答者胜），平台侧按
   *     40405「问题已不存在」放弃重试，不空转。
   */
  async _answer(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const callId = String(body.call_id || '');
    if (!callId) {
      this._json(res, 400, { error: 'call_id 不能为空' });
      return;
    }
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const held = this.questions.get(callId);
    if (held !== undefined) {
      if (held.sid !== entry.sessionId) {
        this._json(res, 409, { error: '提问不属于该会话' });
        return;
      }
      this._settleQuestion(callId, { answers });
      this._json(res, 200, { ok: true, accepted: true, session_id: entry.sessionId });
      return;
    }
    const svc = this.agentCtx ? this.agentCtx.get('userQuestions') : null;
    if (!svc || typeof svc.answer !== 'function') {
      this._json(res, 503, { error: 'userQuestions 服务不可用' });
      return;
    }
    let accepted = false;
    try {
      accepted = svc.answer(entry.agent, callId, { answers });
    } catch (err) {
      this._json(res, 409, { error: `作答被拒: ${(err && err.message) || err}` });
      return;
    }
    if (accepted) this._clearQuestionMark(entry.sessionId);   // 受理即清挂起标记
    this._json(res, 200, { ok: true, accepted, session_id: entry.sessionId });
  }

  /** 插话：运行中 steer 到最近 step 边界（空闲则直接起一个 turn）。 */
  async _steer(res, req) {    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const text = String(body.prompt == null ? '' : body.prompt);
    if (!text) {
      this._json(res, 400, { error: 'prompt 不能为空' });
      return;
    }
    entry.agent.steer(this._userMessage(text));
    this._json(res, 200, { ok: true, session_id: entry.sessionId });
  }

  // ---------- P3 第二批：审批代答 + 权限 preset（2026-10-03）----------

  /**
   * 宿主 inbox 队列行（`agent/inbox/*` 三个事件）：
   * `inserted` 入队、`claimed` 进本步（离开队列）、`discarded` 被丢弃。
   *
   * 平台侧会话窗据此渲染「宿主排队行」（与平台自己的队列消息单元区分：这些行
   * 没有平台 msg_id，故不可「立即注入」，只作展示）。消息文本从 content 块抽，
   * id 用 dsh 消息自带 id（缺失时按入队序号造一个稳定 id）。
   */
  _onInbox(kind, payload) {
    try {
      const agent = payload && payload.agent;
      const sid = agent ? String(agent.id) : '';
      const entry = this.sessions.get(sid);
      const msg = (payload && payload.message) || {};
      const mid = String(msg.id || msg.messageId || '');
      const list = [];
      if (entry) {
        const inbox = entry.inbox || (entry.inbox = []);
        if (kind === 'inserted') {
          inbox.push({ id: mid || `ib-${++this._inboxSeq}`,
                       text: textOf(msg.content) });
        } else {
          // claimed/discarded：按 id 移除；无 id 时按文本移除队首匹配项
          const idx = mid ? inbox.findIndex((m) => m.id === mid)
                          : inbox.findIndex((m) => m.text === textOf(msg.content));
          if (idx >= 0) inbox.splice(idx, 1);
        }
        list.push(...inbox);
      }
      this._publishState('driver/inbox', { sid, data: { items: list } });
    } catch (err) {
      this.logger.warn(`touchstone: inbox 事件处理异常: ${(err && err.message) || err}`);
    }
  }

  /**
   * `approval/request` waterfall：返回 outcome 即「认领」，调用 next() 则让位。
   *
   * - **默认让位**（`holdApprovals=false`）：GUI 的审批弹窗照常作答，平台只旁听
   *   （`approval/asked` 会话事件已经让平台能展示）；
   * - **认领**（平台经 `/permission` 接管过该会话）：把请求挂起，等 `/approval`
   *   送达 `allowed-once|rejected|cancelled`；请求 signal abort（撤回/取消）时
   *   落 `'cancelled'` 收口，不悬挂。
   *
   * 注意 `ApprovalRequestEvent` **没有 id**（id 由服务内部生成、只出现在
   * `approval/asked|decided` 审计事件里），故这里自生成 `ap-<n>` 作为平台侧
   * 的 approval_id，并写进 interaction 标记供平台回传。
   */
  _onApprovalRequest(request, next) {
    try {
      const agent = request && request.agent;
      const sid = String((agent && agent.session && agent.session.id) || '');
      const entry = this.sessions.get(sid);
      if (!entry || !entry.holdApprovals || entry.pendingApproval) return next();
      const id = `ap-${++this._approvalSeq}`;
      const mark = { kind: 'approval', id,
                     tool: (request && request.toolName) || '',
                     call_id: String((request && request.callId) || ''),
                     reason: (request && request.reason) || '',
                     answerable: true };
      entry.interaction = mark;
      entry.publish({ sid, seq: null, time: Date.now(), type: 'driver/interaction',
                      data: { state: 'asked', interaction: mark } });
      this._publishState('driver/interaction', { sid, data: { state: 'asked', interaction: mark } });
      return new Promise((resolve) => {
        const settle = (outcome) => {
          if (!entry.pendingApproval || entry.pendingApproval.id !== id) return;
          entry.pendingApproval = null;
          entry.interaction = null;
          resolve(outcome);
        };
        entry.pendingApproval = { id, settle };
        const signal = request && request.signal;
        if (signal) {
          if (signal.aborted) return settle('cancelled');
          try {
            signal.addEventListener('abort', () => settle('cancelled'), { once: true });
          } catch { /* 无 addEventListener 的实现：忽略，靠 /approval 收口 */ }
        }
        return undefined;
      });
    } catch (err) {
      this.logger.warn(`touchstone: approval/request 处理异常: ${(err && err.message) || err}`);
      return next();
    }
  }

  /** `POST /approval`：{session_id, approval_id?, decision} → 兑现挂起的审批。 */
  async _approval(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const pending = entry.pendingApproval;
    if (!pending) {
      this._json(res, 409, { error: '当前没有等待中的审批（或已由 GUI 作答）' });
      return;
    }
    const wanted = String(body.approval_id == null ? '' : body.approval_id);
    if (wanted && wanted !== pending.id) {
      this._json(res, 404, { error: `审批不存在或已过期: ${wanted}` });
      return;
    }
    const decision = String(body.decision == null ? '' : body.decision);
    if (!['allowed-once', 'rejected', 'cancelled'].includes(decision)) {
      this._json(res, 400, { error: 'decision 非法（allowed-once/rejected/cancelled）' });
      return;
    }
    pending.settle(decision);
    this._json(res, 200, { ok: true, session_id: entry.sessionId, outcome: decision });
  }

  /**
   * `GET /models`：宿主模型目录（平台「模型下拉」的 dsh 数据源）。
   *
   * 走 `sessionController.modelCatalog()`——它按 provider 分组返回可用模型、部署默认值
   * 与拉取失败的 provider（provider 端可能真发请求，故这里**缓存 60s**，与平台侧
   * `agent_models` 的 TTL 同量级）。返回扁平化前的原始结构，格式化交给平台：
   * 平台侧模型名统一用 `provider/model` 写法（`/model` 端点会再拆开）。
   */
  async _models(res) {
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCache.at < MODELS_TTL_MS) {
      this._json(res, 200, this._modelsCache.value);
      return;
    }
    const controller = this.ctx.get('sessionController');
    if (!controller || typeof controller.modelCatalog !== 'function') {
      this._json(res, 503, { error: 'sessionController.modelCatalog 不可用' });
      return;
    }
    try {
      const catalog = await controller.modelCatalog();
      const value = {
        default: catalog?.default || null,
        routable_providers: catalog?.routableProviders || [],
        groups: (catalog?.groups || []).map((g) => ({
          id: String(g.id || ''), name: String(g.name || ''),
          models: (g.models || []).map((m) => ({
            id: String(m.id || ''), name: String(m.name || ''),
            description: m.description || '',
            reasoning: Boolean(m.reasoning),
            // 思考等级（2026-10-04）：宿主模型目录的可选档位与其默认档。
            // 平台「思考等级」下拉只列这些值——宿主对模型不支持的档位
            // （resolveCallConfig）直接报 UNSUPPORTED_REASONING_EFFORT，不能瞎列。
            // 老平台忽略这两个新键；老插件不返回时平台回落内置档位表。
            efforts: ((m.reasoning && m.reasoning.efforts) || []).map((e) => ({
              id: String((e && e.id) || ''), name: String((e && e.name) || ''),
            })).filter((e) => e.id),
            default_effort: String((m.reasoning && m.reasoning.defaultEffort) || ''),
          })),
        })),
        failures: (catalog?.failures || []).map((f) => ({
          id: String(f.id || ''), name: String(f.name || ''),
          message: String(f.message || ''),
        })),
      };
      this._modelsCache = { at: now, value };
      this._json(res, 200, value);
    } catch (err) {
      this._json(res, 502, { error: `模型目录读取失败: ${(err && err.message) || err}` });
    }
  }

  /**
   * `GET /media?id=<attachmentId>`：读会话里图片附件的**字节**（平台会话窗预览用）。
   *
   * dsh 的 `ImageBlock.attachment` 只带 `{attachmentId, mediaType, bytes, width,
   * height}`（不可变字节由宿主 attachment 服务持有，`sha256:<64hex>` 形态）。
   * 这里用 `attachments.imageHostPath({attachmentId})` 拿宿主机路径再读文件——
   * 路径由服务自己拼接（`root/objects/<前两位>/<hash>`）并对 id 做正则校验，
   * 插件不碰路径拼接（防穿越）。返回 base64 + 嗅探出的 content-type：
   * 平台侧 `resolve_media` 消费成 `(bytes, ctype)`。
   *
   * 图片只可能出现在 user 内容里（宿主适配器是 text-only 输出），故不需要 agent 维度。
   */
  async _media(res, url) {
    const id = String(url.searchParams.get('id') || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
      this._json(res, 400, { error: 'attachment id 非法（期望 sha256:<64hex>）' });
      return;
    }
    const store = this.ctx.get('attachments');
    if (!store || typeof store.imageHostPath !== 'function') {
      this._json(res, 503, { error: 'attachments 服务不可用（无法读取图片字节）' });
      return;
    }
    let path = '';
    try {
      path = String(store.imageHostPath({ attachmentId: id }) || '');
    } catch (err) {
      this._json(res, 404, { error: `附件引用无效: ${(err && err.message) || err}` });
      return;
    }
    if (!path) {
      this._json(res, 404, { error: '附件不存在（宿主未提供本地路径）' });
      return;
    }
    try {
      const data = await readFile(path);
      const ctype = sniffImageType(data);
      if (!ctype) {
        this._json(res, 415, { error: '不是可识别的图片格式' });
        return;
      }
      this._json(res, 200, { content_type: ctype, bytes: data.length,
                             data: data.toString('base64') });
    } catch (err) {
      this._json(res, 404, { error: `附件读取失败: ${(err && err.message) || err}` });
    }
  }

  /** 权限 preset 服务（`permissionPresets`）的最小封装：不可用时回 undefined。 */
  _permissionService() {
    const svc = this.ctx.get('permissionPresets');
    if (!svc || typeof svc.set !== 'function') return null;
    return svc;
  }

  /**
   * 会话权限状态 `{mode, preset}`（**进程内读取，零 REST**）。
   *
   * - `mode`：平台三档（manual/yolo/auto），只有经平台 `POST /permission`（带 mode）
   *   切过才有值；平台据此在会话窗「权限」控件显示当前档位（此前 meta 不下发该字段，
   *   控件恒置灰——2026-10-04 修）。
   * - `preset`：宿主 `permissionPresets.current(session)` 的实况——会话在平台外被
   *   改过也能回读；回读失败沿用记下的值。
   */
  _permissionState(entry) {
    const out = { mode: entry.permissionMode || '',
                  preset: entry.permissionPreset || '' };
    const svc = this._permissionService();
    const session = (entry.agent && entry.agent.session) || null;
    if (svc && typeof svc.current === 'function' && session) {
      try {
        const cur = String(svc.current(session) || '');
        if (cur) out.preset = cur;
      } catch { /* 回读失败：沿用记下的值 */ }
    }
    return out;
  }

  /** 权限状态进状态流（`driver/permission`，与 `driver/model` 同形）。 */
  _publishPermission(entry) {
    const state = this._permissionState(entry);
    if (state.preset) entry.permissionPreset = state.preset;
    this._publishState('driver/permission', { sid: entry.sessionId, data: state });
    return state;
  }

  /**
   * `POST /permission`：{session_id, preset, mode?} → 切换会话权限 preset。
   *
   * 同时把该会话的审批**交给平台**（`holdApprovals=true`）——preset 若含
   * `approval=ask`，由平台通过 `/approval` 作答；`approval=never` 时瀑布根本
   * 不会被调用，置位无害。这避免了「平台设了 ask 档却没人能答」的死锁。
   *
   * `mode`（可选）＝平台三档 manual/yolo/auto：只是**展示口径**（宿主 preset 到
   * 三档是多对一近似映射，回读 preset 反推不出是哪一档），记进 entry 并经
   * `driver/permission` 帧回给平台，供会话窗「权限」控件显示当前档位。
   * 不传（如外部工具直打驱动）＝来源不明：清掉旧 mode，只保留 preset 实况。
   */
  async _permission(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const preset = String(body.preset == null ? '' : body.preset).trim();
    if (!preset) {
      this._json(res, 400, { error: 'preset 不能为空' });
      return;
    }
    const mode = String(body.mode == null ? '' : body.mode).trim();
    if (mode && !/^[a-z0-9_-]{1,16}$/i.test(mode)) {
      this._json(res, 400, { error: `mode 非法: ${mode}` });
      return;
    }
    const svc = this._permissionService();
    if (!svc) {
      this._json(res, 503, { error: 'permissionPresets 服务不可用，无法切换权限' });
      return;
    }
    let approval = 'ask';
    try {
      const spec = svc.resolve ? svc.resolve(preset) : null;
      if (spec && spec.approval) approval = String(spec.approval);
    } catch (err) {
      this._json(res, 400, { error: `权限 preset 不可用: ${(err && err.message) || err}` });
      return;
    }
    svc.set(entry.agent.session, preset);
    entry.holdApprovals = approval === 'ask';
    entry.permissionPreset = preset;
    entry.permissionMode = mode;
    // 权限进状态流（P4）：会话窗「权限」控件据事件即时刷新，不必回读 /status
    const state = this._publishPermission(entry);
    this._json(res, 200, { ok: true, session_id: entry.sessionId, preset,
                           approval, hold_approvals: entry.holdApprovals,
                           permission: state });
  }

  /** `GET /presets?session_id=`：{current, options, default} —— 平台给 UI 渲染选项。 */
  _presets(res, url) {
    const sid = String(url.searchParams.get('session_id') || '');
    const entry = this.sessions.get(sid);
    if (!entry) {
      this._json(res, 404, { error: `会话不在驱动池中: ${sid}` });
      return;
    }
    const svc = this._permissionService();
    if (!svc || typeof svc.catalog !== 'function') {
      this._json(res, 503, { error: 'permissionPresets 服务不可用' });
      return;
    }
    const catalog = svc.catalog() || {};
    let current = '';
    try {
      current = String(svc.current(entry.agent.session) || '');
    } catch { /* 折叠失败：留空，UI 回退默认显示 */ }
    this._json(res, 200, {
      session_id: sid, current,
      options: catalog.options || [],
      default: catalog.defaultPreset || '',
    });
  }

  /** 优雅中断：cancel 保留队列（keepInbox）与已流式交付的文本。 */
  async _cancel(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    // 记「平台发起过取消」：turn/end 若以 null reason 落地时用于归一为 aborted，
    // 也让 /status 的 cancelled 字段可解释（见 _onSessionEvent 的 reason 归一）
    entry.cancelRequested = true;
    entry.agent.cancel('user', { keepInbox: Boolean(body.keep_inbox) });
    this._json(res, 200, { ok: true, session_id: entry.sessionId });
  }

  // ---------- P3 对齐端点（2026-10-03）----------

  /**
   * `POST /compact`：触发宿主压缩。
   *
   * 走**命令**而不是服务：P0 探针实测 `ctx.compaction` 服务在插件 ctx 不可注入，
   * 而 `commands` 可注入且 `command-compact`（`/compact`）在本 profile 已装载
   * （`--dump-config` 可见）。命令是异步长任务（要过一次模型），故**触发即回**
   * `{started:true}`；真正的失败只落宿主日志（平台侧 compact 语义本来就是"发起"）。
   */
  async _compact(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const commands = this.ctx.get('commands');
    if (!commands || typeof commands.execute !== 'function') {
      this._json(res, 503, { error: 'commands 服务不可用，无法触发 /compact' });
      return;
    }
    const controller = new AbortController();
    Promise.resolve(commands.execute(entry.agent, '/compact', [], controller.signal))
      .then(() => this.logger.info(`touchstone: /compact 完成 sid=${entry.sessionId}`))
      .catch((err) => this.logger.warn(
        `touchstone: /compact 失败 sid=${entry.sessionId}: ${(err && err.message) || err}`));
    this._json(res, 200, { ok: true, session_id: entry.sessionId, started: true });
  }

  /**
   * `POST /fork`：宿主侧 fork（`sessionController.fork`）——完整复制会话为新会话。
   * `at_seq` 可指定精确的事件 seq（缺省=最近一个完整 turn 的前缀）。
   *
   * P7a 缺陷 B（2026-10-03 真机）：新会话是宿主 fork 内部用
   * `ctx.agents.create({sessionId: childId, seed, …})` 造出来的——**写句柄归 fork
   * 调用方作用域且不释放**（返回值只有 `sessionId`）。因此它不能像普通已落盘会话
   * 那样走 `agents.resume`：会话持久化的 write-open 会撞
   * `SessionAlreadyOwnedError: session "…" is already owned by an active write handle`，
   * 真机上表现为 fork / 压缩新建 / 会话回退三端点全 400/502（子会话已落宿主，
   * 平台却接不进来）。故这里 fork 成功后立刻把宿主的活 agent **接管进池**：
   * `agents.get` 只回裸 Agent（handle 只给创建者），本池 handle 留 null，dispose
   * 只出池不销毁宿主会话；平台紧随其后的 `/session` 于是命中幂等早退
   * （created=false/resumed=false），三个功能一起恢复。
   * `agents.get` 拿不到活 agent 时保持原行为：不接管、不抛，仍交平台的 resume 路径。
   */
  async _fork(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const controller = this.ctx.get('sessionController');
    if (!controller || typeof controller.fork !== 'function') {
      this._json(res, 503, { error: 'sessionController 服务不可用，无法 fork' });
      return;
    }
    const atSeq = Number(body.at_seq);
    const request = { sessionId: entry.sessionId };
    if (Number.isFinite(atSeq) && atSeq > 0) request.atSeq = atSeq;
    const value = await controller.fork(request);
    const newSid = String((value && value.sessionId) || '');
    if (!newSid) {
      this._json(res, 500, { error: 'fork 未返回新会话 id' });
      return;
    }
    // P7a 缺陷 B：fork 子会话的写句柄归宿主 fork 调用方作用域，**不能再 resume**
    // ——直接接管活 agent（详见方法头注释）。`agents.get` 缺席/未命中时保持原行为
    // （子会话留给平台 `/session` 的 resume 路径，失败也在那里收口，不在此抛错）。
    const live = (this.agentCtx && this.agentCtx.agents
                  && typeof this.agentCtx.agents.get === 'function')
      ? this.agentCtx.agents.get(newSid) : null;
    if (live && !this.sessions.has(newSid)) {
      const child = new DriverSession(newSid);
      child.agent = live;                    // 句柄归宿主：本池 handle 留 null
      child.cwd = (live.session && live.session.header && live.session.header.cwd)
        || entry.cwd || '';
      child.task = entry.task || '';         // 分支会话服务同一平台对象（卡片/任务）
      const opts = live.options || {};
      const forkEffort = String(opts.reasoningEffort || '');
      if (opts.provider || opts.model || forkEffort) {
        child.model = { provider: String(opts.provider || ''), model: String(opts.model || ''),
                        ...(forkEffort ? { reasoningEffort: forkEffort } : {}) };
      }
      this.sessions.set(newSid, child);
      // 子会话与父会话同 cwd：一并归组（dsh 自家 fork 也是「源会话属工作区则子会话随附」，
      // 本驱动同样绕过了命令层，故在此补一次；失败只告警，不影响 fork 回执）
      await this._attachWorkspace(newSid, child.cwd);
      this._observe(live.session);           // 先入池再 observe：本帧 owned 才为 true
      this._publishState('driver/attached', {
        sid: newSid,
        data: { cwd: child.cwd, task: child.task, owned: true, resumed: false,
                model: child.model },
      });
      // fork 副本继承父会话的权限实况（同一份会话配置），随接入帧推给平台
      this._publishPermission(child);
      this.logger.info(`touchstone: fork 子会话 ${newSid} 已接管（写句柄归宿主，`
                       + `task=${child.task || '-'} cwd=${child.cwd || '-'}）`);
    }
    this._json(res, 200, { ok: true, session_id: entry.sessionId, new_session_id: newSid });
  }

  /** `POST /rename`：会话标题（平台侧「会话命名」；与 dsh 侧栏同一份标题）。 */
  async _rename(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    const title = String(body.title == null ? '' : body.title).trim();
    if (!title) {
      this._json(res, 400, { error: 'title 不能为空' });
      return;
    }
    const controller = this.ctx.get('sessionController');
    if (!controller || typeof controller.rename !== 'function') {
      this._json(res, 503, { error: 'sessionController 服务不可用，无法改名' });
      return;
    }
    const value = await controller.rename({ sessionId: entry.sessionId, title });
    this._json(res, 200, {
      ok: true, session_id: entry.sessionId,
      title: String((value && value.title) || title),
    });
  }

  /**
   * `POST /model`：会话级模型切换（`sessionController.selectModel`）。
   * `model` 支持 `provider/model` 写法；只给模型名时沿用该 agent 当前的 provider
   * （`Agent.options.provider`）；`reasoning_effort` 可选（思考等级）。
   *
   * 2026-10-04：`model` 可以**留空而只改思考等级**——此时按
   * `entry.model → agent.options → agentDefaultModel.currentSelection()` 依次回读
   * 当前 provider/model（平台会话窗的「思考等级」控件就是这么用的：改一档不该顺手
   * 重设模型）。切换成功后同步改写本插件安装的选择对象（`entry.selection`），
   * 否则宿主 sessionController 与本插件两套选择钩子不一致，请求仍按旧档跑。
   */
  async _model(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    let model = String(body.model == null ? '' : body.model).trim();
    let provider = String(body.provider == null ? '' : body.provider).trim();
    const effort = String(body.reasoning_effort == null ? '' : body.reasoning_effort).trim();
    if (model.includes('/')) {
      const [head, ...rest] = model.split('/');
      if (!provider) provider = head;
      model = rest.join('/');
    }
    if (!model && !effort) {
      this._json(res, 400, { error: 'model 与 reasoning_effort 不能同时为空' });
      return;
    }
    const opts = (entry.agent && entry.agent.options) || {};
    const known = entry.model || {};
    if (!model) {
      // 只改思考等级：回读当前模型（entry 记录 → agent options → 部署默认选择）
      model = String(known.model || opts.model || '').trim();
      if (!provider) provider = String(known.provider || opts.provider || '').trim();
      if (!model || !provider) {
        const svc = this.agentCtx ? this.agentCtx.get('agentDefaultModel') : null;
        let fallback = null;
        try {
          fallback = (svc && typeof svc.currentSelection === 'function')
            ? svc.currentSelection() : null;
        } catch { /* 回读失败按缺失处理 */ }
        if (!model) model = String((fallback && fallback.model) || '').trim();
        if (!provider) provider = String((fallback && fallback.provider) || '').trim();
      }
      if (!model || !provider) {
        this._json(res, 400, { error: '当前模型无法回读（请显式传 model/provider）' });
        return;
      }
    } else if (!provider) {
      // 只给模型名：沿用该 agent 当前的 provider（宿主 Agent.options.provider，
      // 与既有契约一致）；回退用 entry 记下的 provider（外部会话/选项缺失时）
      provider = String(opts.provider || known.provider || '').trim();
    }
    if (!provider) {
      this._json(res, 400, { error: 'provider 缺失且无法从当前会话回读（请传 provider/model 或 provider）' });
      return;
    }
    const controller = this.ctx.get('sessionController');
    if (!controller || typeof controller.selectModel !== 'function') {
      this._json(res, 503, { error: 'sessionController 服务不可用，无法切换模型' });
      return;
    }
    const selection = { provider, model };
    if (effort) selection.reasoningEffort = effort;
    const value = await controller.selectModel({ sessionId: entry.sessionId, ...selection });
    const selected = (value && value.selected) || selection;
    entry.model = { provider: String(selected.provider || provider),
                    model: String(selected.model || model),
                    ...(selected.reasoningEffort === undefined
                      ? {} : { reasoningEffort: String(selected.reasoningEffort) }) };
    // 同步本插件安装的选择对象：宿主自己也有一套选择钩子（sessionController.
    // selectionFor），两套同时挂在 `agent/request` waterfall 上时**先注册者**的
    // 后置覆盖生效——本插件的是建会话时注册的，不改写就会出现「/model 回执成功，
    // 请求却仍用旧模型/旧档位」。assembled 留给下一轮 prompt 装配自然刷新。
    if (entry.selection) entry.selection.current = { ...selected };
    // 模型进状态流（P6）：会话窗的「模型」控件据事件即时刷新，不必回读 /status
    this._publishState('driver/model', { sid: entry.sessionId,
                                         data: entry.model });
    this._json(res, 200, {
      ok: true, session_id: entry.sessionId, selected,
    });
  }

  /** 释放常驻会话：停轮次 + 移出 registry/存储（remove=false 时保留磁盘会话可再 resume）。 */
  async _disposeSession(res, req) {
    const body = await this._body(req);
    const entry = this._lookup(res, body);
    if (!entry) return;
    this.sessions.delete(entry.sessionId);
    this._publishState('driver/detached', { sid: entry.sessionId, data: {} });
    for (const client of entry.clients) {
      try {
        client.end();
      } catch {
        /* 已断开 */
      }
    }
    entry.clients.clear();
    await this._disposeHandle(entry);
    this._json(res, 200, { ok: true, session_id: entry.sessionId });
  }

  /** handle.dispose()：停 loop、注销、移出会话存储（平台侧「删会话」语义）。 */
  async _disposeHandle(entry) {
    if (!entry.handle) return;
    try {
      await entry.handle.dispose();
    } catch (err) {
      this.logger.warn(`touchstone: 释放会话 ${entry.sessionId} 失败: ${(err && err.message) || err}`);
    }
    entry.handle = null;
    entry.agent = null;
    this.observed.delete(entry.sessionId);
  }

  /** 从请求体取会话格；缺失即回 404（统一错误出口）。 */
  _lookup(res, body) {
    const sid = String((body && body.session_id) || '');
    const entry = this.sessions.get(sid);
    if (!entry) {
      this._json(res, 404, { error: `会话不在驱动池中: ${sid || '(空)'}` });
      return null;
    }
    return entry;
  }

  /**
   * 构造 user 消息。首选宿主 `@deepseek-ai/dsh-llm` 的 createUserMessage（与官方驱动
   * 完全同构：结构化克隆 + 深冻结 + 随机 id）；该包解析不到时退化为等价本地对象
   * ——MessageId 运行时就是字符串，宿主不按类校验。
   */
  _userMessage(text) {
    const content = [{ type: 'text', text }];
    if (this._userMessageFactory) {
      return this._userMessageFactory({ content, source: { kind: 'user' } });
    }
    return Object.freeze({
      id: randomUUID(), role: 'user', content, source: { kind: 'user' },
    });
  }

  /**
   * 解析本轮 agent 的模型选择：请求显式给了 provider/model 就用它，否则回落到
   * profile 的默认模型服务（`ctx.agentDefaultModel.currentSelection()`）。
   * 两者都没有时返回 null（交由提示词装配报错，平台侧能看到明确原因）。
   */
  _resolveModel(body) {
    if (body.provider || body.model) {
      return { provider: body.provider || undefined, model: body.model || undefined };
    }
    const svc = this.agentCtx ? this.agentCtx.get('agentDefaultModel') : null;
    if (!svc || typeof svc.currentSelection !== 'function') return null;
    try {
      return svc.currentSelection() || null;
    } catch {
      return null;
    }
  }

  /**
   * 生成 create/resume 的 setup：装配「模型选择 + agent preset」。
   *
   * 为什么必须挂 preset（2026-10-02 真机实测踩坑）：编程式 `ctx.agents.create()`
   * 只会得到一个**空壳 agent**——没有工具、没有系统提示段（persona-prefix 等）。
   * 表现是模型把工具调用当纯文本吐出来（DSML 标记）而一个 `tool/call` 事件都没有，
   * 任务 11 秒「完成」却什么都没做。Web GUI 的 sessionController 走的是
   * `agentPresets.resolve() + mount()`（dsh-api-session-controller composeAgent），
   * 这里照抄同一条路：解析默认（或指定）preset id → 写进 session meta.agentPreset
   * → 在 setup 里 mount 到 agent 作用域。
   *
   * preset 不可用（服务缺失）时退化为「仅装模型选择」，与旧行为一致但会记 warn。
   *
   * 返回的 `selection`＝本插件安装给宿主的**可变选择对象**（`{current, assembled}`，
   * 供 `/model` 切换后同步改写——不改写会出现「回执成功但请求仍用旧模型/旧思考等级」，
   * 因为宿主 sessionController 自己那套选择钩子与本插件这套同时挂在同一 waterfall 上）。
   */
  async _composeSetup(selection, presetId) {
    const installer = this._installModelSelection;
    const presets = this.agentCtx ? this.agentCtx.get('agentPresets') : null;
    let resolved;
    if (presets && typeof presets.resolve === 'function') {
      try {
        resolved = (await presets.resolve(presetId || undefined)).id;
      } catch (err) {
        this.logger.warn(`touchstone: agent preset 解析失败(${presetId || '默认'}): `
                         + `${(err && err.message) || err}`);
      }
    } else {
      this.logger.warn('touchstone: agentPresets 服务不可用, 会话将没有工具与系统提示段');
    }
    if (!installer && resolved === undefined) {
      return { setup: undefined, agentPreset: undefined, selection: null };
    }
    // 未显式给模型时（平台留空 = 用宿主默认、_resolveModel 回 null）current 置 undefined：
    // 钩子对 undefined 是「透传」（沿用宿主自己的选择），装上对象本身是为了**后续**
    // `/model` 切换能把新选择写进来（模型/思考等级切换与创建时是否给了模型无关）。
    const selObj = { current: selection || undefined, assembled: undefined };
    return {
      agentPreset: resolved,
      selection: installer ? selObj : null,
      setup: async (agentCtx) => {
        if (installer) installer(agentCtx, selObj);
        if (presets && resolved !== undefined) await presets.mount(agentCtx, resolved);
      },
    };
  }
  /** 统一的 JSON 响应出口（HEAD 之外的请求都不长挂）。 */
  _json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

/**
 * 加载宿主 createUserMessage（异步、可失败）。失败只降级并告警，不阻断驱动。
 * @returns {Promise<Function|null>} 工厂函数或 null
 */
export async function loadUserMessageFactory(logger) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    return mod.createUserMessage;
  } catch (err) {
    if (logger) logger.warn(`touchstone: @deepseek-ai/dsh-llm 不可用, 降级本地构造消息: ${err.message}`);
    return null;
  }
}

/**
 * 加载宿主 installModelSelection（`@deepseek-ai/dsh-agent`）。
 *
 * 为什么必须装：编程式建 agent 时 agent loop **不会**自动套用 profile 的默认模型，
 * 提示词装配里的 `{{model}}` 变量由 installModelSelection 注入；不装的话首轮
 * 直接以 `prompt variable "{{model}}" has no value ... (section
 * "deployment:persona-prefix")` 报错收场（本机真机实测，2026-10-02）。
 * 官方 headless（dsh-headless/lib/index.js:308）走的就是同一条路。
 */
export async function loadModelSelectionInstaller(logger) {
  try {
    const mod = await import('@deepseek-ai/dsh-agent');
    return mod.installModelSelection;
  } catch (err) {
    if (logger) logger.warn(`touchstone: @deepseek-ai/dsh-agent 不可用, 模型选择未安装: ${err.message}`);
    return null;
  }
}
