/**
 * agent 驱动契约自检（不经 dsh）：用桩 ctx 驱动 lib/agent-driver.js，验证
 * `/touchstone-agent` 的全部端点语义。与 dev-check.mjs 同档（薄壳自检），
 * 但覆盖的是路线 A 的驱动层——它是本插件风险最高的一块，真机验证成本高，
 * 故用桩把契约钉死，改代码时秒级回归。
 *
 * 用法: node scripts/dev-check-driver.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 桩面（与真机 dsh 的对应关系）：
 *   ctx.get('webServer')        → 捕获注册的 prefix 路由 + port（起临时 HTTP 服务分派）
 *   ctx.inject(['agents'], cb)  → 立即以 agentCtx 调 cb（真机等 agents 服务就绪）
 *   agentCtx.agents.create/resume/get、agentCtx.on(...)、ctx.get('agentDefaultModel'|
 *   'agentPresets'|'sessionPersistence'|'userQuestions') 全部按 .d.ts 的形状打桩；
 *   宿主包（@deepseek-ai/dsh-llm 等）在 dsh 之外解析不到 → 自动走降级分支，正是要测的。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentDriver } from '../lib/agent-driver.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/**
 * 造一条「原生作答通道」桩：模拟 dsh Web 客户端问答桥交给插件的 promise。
 * 手工 `resolve()` 表示浏览器侧作答、`fail()` 表示该通道取消/异常。永不自动兑现，
 * 故插件必须靠平台侧 `/answer` 或竞速收口（正是要钉的语义）。
 */
function makeNativeLane() {
  let ok = () => {};
  let ng = () => {};
  const promise = new Promise((resolve, reject) => { ok = resolve; ng = reject; });
  promise.catch(() => {});                 // 与真机同形：无人接管也不算未处理拒绝
  return { promise, resolve: ok, fail: ng };
}

/** 造一个假 agent（形状对齐 @deepseek-ai/dsh-agent 的 Agent 接口）。 */
function makeAgent(id, cwd) {
  return {
    id,
    status: 'idle',
    calls: [],
    session: { id, header: { cwd }, seq: 0 },
    // AgentOptions（/model 的 provider 回退源）
    options: { provider: 'p', model: 'm' },
    followup(msg) { this.calls.push(['followup', msg]); this.status = 'running'; },
    steer(msg) { this.calls.push(['steer', msg]); },
    cancel(cause, opts) { this.calls.push(['cancel', cause, opts]); },
  };
}

/** 造桩 ctx + 桩 agentCtx，返回 {ctx, handlers, opts, agentCtx, events}。 */
function makeCtx() {
  const handlers = {};        // 事件名 -> [fn]
  const opts = {};            // 事件名 -> [ctx.on 第三参（注册选项）]
  const sockets = { agents: new Map(), disposed: [] };
  // 「已由原生通道（dsh GUI）兑现过的提问」显式记账（T3 修复轮扩桩）：真宿主里 GUI 作答后
  // 该提问即从待答表移除，`userQuestions.answer` 对同一 callId 必回 false（平台迟到作答
  // 据此收口）。桩**不改**既有默认返回语义（`callId !== 'gone'`），只对显式记账的 callId
  // 回 false；默认空集 ⇒ 既有 6 个 `/answer` 调用点逐字不受影响。
  sockets.nativeFulfilled = new Set();
  // 工作区注册表桩（形状对齐 dsh-workspace 的 WorkspaceRegistry）：resolveByPath 命中
  // 已有工作区 / create 新建，实体 attachSession 只记录调用。`workspaceFail` 模拟注册表
  // 故障，`workspaceRegistry = undefined` 模拟服务缺席——两种情况驱动都必须降级不抛。
  sockets.workspaceCalls = [];
  const workspaceEntity = (p) => ({
    path: p,
    attached: [],
    async attachSession(sid) {
      this.attached.push(sid);
      sockets.workspaceCalls.push(['attach', p, sid]);
    },
  });
  sockets.workspaces = new Map();
  sockets.archiveCalls = [];
  // 宿主落盘归档集后广播 `domain/changed`（真机由 domain 存储层发出）。
  // **顺序必须照抄真机**（2026-10-07 定因）：官方 `WorkspaceRegistry.setState()` 是
  // `await global.set(state)` → `this.state = state`，而事件在 `global.set` 内部**同步**
  // 发出 ⇒ 监听器执行时 registry 的 `archivedSessionIds` 还是**旧值**，权威新值只在
  // 事件载荷 `change.value` 里。桩若先改 `archived` 再发事件，就会掩盖
  // 「回读 registry 拿到旧快照 ⇒ 一帧不推」这个真机故障（原桩即如此）。
  const fireDomainChanged = (value) => {
    sockets.cacheAtEmit = [...sockets.workspaceRegistry.archived];
    for (const fn of handlers['domain/changed'] || []) {
      try { fn({ domain: 'workspace', table: '', key: '', operation: 'put', value }); } catch { /* 桩忽略 */ }
    }
  };
  sockets.workspaceRegistry = {
    // 归档集（2026-10-05 看板「已完成」同步）：形状对齐 dsh-workspace 的
    // `ctx.workspaceRegistry`——`archivedSessionIds` 是**只读整表**属性，
    // archiveSession 要求会话存在（不存在的抛 WorkspaceUnknownSessionError 同名
    // 错误），unarchiveSession 幂等不校验存在性；两者落盘后由宿主发
    // `domain/changed`（桩这里同步触发，驱动据此推 driver/archived 帧）。
    knownSessions: new Set(),
    archived: [],
    get archivedSessionIds() { return [...this.archived]; },
    /** 当前整表全局态（事件载荷 `change.value` 的真机同形：带 archivedSessionIds）。 */
    stateValue(next) {
      return { initialized: true, workspaceIds: [], pinnedSessionIds: [],
               archivedSessionIds: [...next] };
    },
    async archiveSession(sid, options) {
      sockets.archiveCalls.push(['archive', sid, !!(options && options.stopActivity)]);
      if (this.archived.includes(sid)) return;
      if (!this.knownSessions.has(sid)) {
        const err = new Error(`cannot archive session '${sid}': no such session`);
        err.name = 'WorkspaceUnknownSessionError';
        throw err;
      }
      const next = [...this.archived, sid];
      fireDomainChanged(this.stateValue(next));   // 真机顺序：事件先行（带权威新值）
      this.archived = next;                       // registry 内存缓存随后才刷新
    },
    async unarchiveSession(sid) {
      sockets.archiveCalls.push(['unarchive', sid]);
      if (!this.archived.includes(sid)) return;
      const next = this.archived.filter((x) => x !== sid);
      fireDomainChanged(this.stateValue(next));   // 同上：事件在前、缓存更新在后
      this.archived = next;
    },
    seed(p) {
      const ws = workspaceEntity(p);
      sockets.workspaces.set(p, ws);
      return ws;
    },
    async resolveByPath(p) {
      sockets.workspaceCalls.push(['resolve', p]);
      if (sockets.workspaceFail) throw new Error(sockets.workspaceFail);
      return sockets.workspaces.get(p);
    },
    async create(p) {
      sockets.workspaceCalls.push(['create', p]);
      if (sockets.workspaceFail) throw new Error(sockets.workspaceFail);
      const ws = workspaceEntity(p);
      sockets.workspaces.set(p, ws);
      return ws;
    },
  };
  // 宿主会话表桩（A 批 2026-10-08 会话枚举）：形状对齐 @deepseek-ai/dsh-session 的
  // `SessionStore`——`store` 是 `Map(sid → entry)`，`entry.session` = 活会话对象
  // （另有 cwd/carrier/announced 等本用例不关心的字段）。`sockets.sessions = undefined`
  // 模拟服务缺席（如 dev-check.mjs 的极简桩），枚举必须降级为 complete:false。
  sockets.sessions = { store: new Map() };
  const agentCtx = {
    on(name, fn, options) {
      (handlers[name] ||= []).push(fn);
      (opts[name] ||= []).push(options);
      return () => {};
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      }
      if (name === 'agentPresets') {
        return { resolve: async () => ({ id: 'default' }), mount: async () => ({}) };
      }
      if (name === 'userQuestions') {
        return { answer: (_agent, callId, answer) => {
          sockets.answered = { callId, answer };
          // 已由原生通道兑现过的提问：真宿主回 false（见 sockets.nativeFulfilled 注释）。
          if (sockets.nativeFulfilled.has(callId)) return false;
          return callId !== 'gone';
        } };
      }
      if (name === 'sessionPersistence') return {};
      // 宿主会话表（A 批枚举源）：`/live` 的 complete 声明由它是否可读决定
      if (name === 'sessions') return sockets.sessions;
      // 工作区注册表（侧栏归组用；2026-10-04）：缺席时驱动须降级为「只告警不抛」
      if (name === 'workspaceRegistry') return sockets.workspaceRegistry;
      // P3 对齐端点用到的业务服务（形状对齐 .d.ts：SessionController / CommandsService）
      if (name === 'attachments') {
        // 形状对齐 dsh-attachment：imageHostPath(ref) 返回宿主机只读路径
        return {
          imageHostPath: (ref) => {
            sockets.mediaRef = ref;
            return sockets.mediaPath || '';
          },
        };
      }
      if (name === 'commands') {
        return {
          async execute(agent, line, attachments) {
            sockets.command = { agentId: agent && agent.id, line, attachments: (attachments || []).length };
            return { ok: true };
          },
        };
      }
      // 权限 preset 服务（形状对齐 .d.ts：PermissionPresetService）
      if (name === 'sessionController') {
        // 与真机同名方法合并（下方已有 fork/rename/selectModel 桩，这里补 modelCatalog）
        sockets.catalogCalls = sockets.catalogCalls || 0;
        return {
          async fork(req) {
            sockets.forked = req;
            sockets.forkN = (sockets.forkN || 0) + 1;
            const childId = `session-fork-${sockets.forkN}`;
            // 真机语义（P7a 缺陷 B）：宿主 `sessionController.fork` 内部
            // `ctx.agents.create({sessionId: childId, seed, …})` 造出子会话并注册进
            // registry，写句柄归 fork 调用方作用域且不释放——于是 `agents.get(childId)`
            // 拿得到活 agent，而 `agents.resume(childId)` 必撞写句柄
            // （is already owned by an active write handle）。桩照此注册活 agent；
            // `sockets.forkRegisterAgent=false` 模拟拿不到活 agent（回退分支）。
            if (sockets.forkRegisterAgent !== false) {
              const src = sockets.agents.get(req.sessionId);
              const cwd = (src && src.session.header && src.session.header.cwd)
                || sockets.cwd || '';
              sockets.agents.set(childId, makeAgent(childId, cwd));
            }
            return { sessionId: childId };
          },
          async rename(req) { sockets.renamed = req; return { title: req.title, seq: 1 }; },
          async selectModel(req) {
            sockets.selected = req;
            // 与真宿主同形：resolved selection 里带（可选的）reasoningEffort
            return { selected: { provider: req.provider, model: req.model,
                                 ...(req.reasoningEffort === undefined
                                   ? {} : { reasoningEffort: req.reasoningEffort }) } };
          },
          async modelCatalog() {
            sockets.catalogCalls += 1;
            return {
              default: { provider: 'p', model: 'm' },
              routableProviders: ['p'],
              groups: [{ id: 'p', name: 'Provider P',
                         models: [{ id: 'm', name: 'm', description: '模型 m',
                                    reasoning: { efforts: [{ id: 'low', name: 'Low' },
                                                           { id: 'high', name: 'High' }],
                                                 defaultEffort: 'high' } }] }],
              failures: [],
            };
          },
        };
      }
      if (name === 'permissionPresets') {
        return {
          catalog: () => ({
            options: [{ value: 'workspace-write', name: '工作区可写' },
                      { value: 'danger-full-access', name: '完全访问' }],
            defaultPreset: 'danger-full-access',
          }),
          current: () => sockets.preset || 'danger-full-access',
          resolve: (n) => ({ sandbox: n, approval: n === 'workspace-write' ? 'ask' : 'never' }),
          set: (session, n) => {
            sockets.preset = n;
            sockets.setPreset = { sid: session && session.id, name: n };
          },
        };
      }
      return undefined;
    },
    agents: {
      async create(opts) {
        const agent = makeAgent(opts.sessionId, (opts.meta || {}).cwd || '');
        sockets.agents.set(opts.sessionId, agent);
        sockets.lastCreate = opts;
        return { agent, dispose: async () => { sockets.disposed.push(opts.sessionId); } };
      },
      async resume(opts) {
        const id = opts.resumeSessionId;
        const agent = makeAgent(id, sockets.cwd || '');
        sockets.agents.set(id, agent);
        sockets.lastResume = opts;
        return { agent, dispose: async () => { sockets.disposed.push(id); } };
      },
      get(id) { return sockets.agents.get(id); },
    },
    sockets,
  };
  let routeHandler = null;
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    get(name) {
      if (name === 'webServer') {
        return {
          port: 0,
          register(route) { routeHandler = route.handler; return () => { routeHandler = null; }; },
        };
      }
      return agentCtx.get(name);
    },
    inject(deps, cb) { cb(agentCtx); return { dispose() {} }; },
  };
  return { ctx, agentCtx, handlers, opts, sockets, getHandler: () => routeHandler };
}

/** 起临时 HTTP 服务，把 /touchstone-agent/* 交给已注册的 handler。 */
async function serve(getHandler) {
  const server = http.createServer((req, res) => {
    const h = getHandler();
    if (req.url.startsWith('/touchstone-agent') && h) h(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/touchstone-agent` };
}

/** 带令牌的请求封装。 */
function call(base, token, method, path, body) {
  return fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-ts-driver-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 造一条宿主会话（`SessionStore.store` 的 entry.session 形状：只用到 id + header）。 */
function hostSession(id, cwd, origin) {
  return { id, header: origin ? { cwd, origin } : { cwd } };
}

/**
 * 起一个**独立**驱动实例（自带桩 ctx + 临时 HTTP 服务），回调跑完自动收尾。
 *
 * 为什么需要独立实例：A 批枚举用例要控制「apply 那一刻宿主会话表里有什么」，
 * 而主实例的 store 必须保持为空（否则会污染前面 `/live 列出两个自持会话` 的断言）。
 *
 * @param {Function|null} setup - 可选的桩面预设（拿 sockets 摆布局）
 * @param {Function} fn - 用例体，收 {driver, base, token, sockets, handlers}
 */
async function withDriver(setup, fn) {
  const made = makeCtx();
  if (setup) setup(made.sockets, made);
  const driver = new AgentDriver(made.ctx, made.ctx.logger('t'));
  driver.start();
  const { server, base } = await serve(made.getHandler);
  try {
    return await fn({ ...made, driver, base, token: driver.token });
  } finally {
    await driver.dispose();
    server.close();
  }
}

/** 读 SSE 直到收到 n 帧或超时。 */
async function readFrames(base, token, path, n, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const res = await fetch(base + path, {
    headers: { 'x-ts-driver-token': token }, signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (frames.length < n && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (buf.includes('\n\n')) {
      const [block, rest] = [buf.slice(0, buf.indexOf('\n\n')), buf.slice(buf.indexOf('\n\n') + 2)];
      buf = rest;
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) frames.push(JSON.parse(line.slice(5).trim()));
      }
    }
  }
  ctrl.abort();
  return frames;
}

async function main() {
  console.log('===== agent 驱动契约自检（桩 ctx，不经 dsh）=====');
  const { ctx, handlers, opts, sockets, getHandler } = makeCtx();
  const driver = new AgentDriver(ctx, ctx.logger('t'));
  driver.start();
  const { server, base } = await serve(getHandler);
  const token = driver.token;

  // --- 鉴权闸 ---
  const noToken = await fetch(`${base}/health`);
  check('无令牌被拒(403)', noToken.status === 403, `got ${noToken.status}`);
  const badToken = await fetch(`${base}/health`, { headers: { 'x-ts-driver-token': 'x' } });
  check('错令牌被拒(403)', badToken.status === 403, `got ${badToken.status}`);

  // --- health / live ---
  const health = await (await call(base, token, 'GET', '/health')).json();
  check('health ok 且前缀正确', health.ok === true
    && health.prefix === '/touchstone-agent', JSON.stringify(health));

  // --- 建会话 ---
  const created = await (await call(base, token, 'POST', '/session',
    { cwd: '/tmp/x', task: 't1' })).json();
  check('建会话返回 dsh 原生 sid（session-<uuid>）',
    /^session-[0-9a-f-]{36}$/.test(created.session_id), created.session_id);
  check('建会话装配了 preset 身份与 setup',
    sockets.lastCreate.meta.agentPreset === 'default'
    && typeof sockets.lastCreate.setup === 'function');

  const sid = created.session_id;

  // --- 幂等建会话 ---
  const again = await (await call(base, token, 'POST', '/session',
    { session_id: sid, cwd: '/tmp/x' })).json();
  check('重复建同一 sid 幂等回执', again.created === false && again.resumed === false);

  // --- 恢复会话 ---
  const other = 'session-11111111-2222-3333-4444-555555555555';
  const resumed = await (await call(base, token, 'POST', '/session',
    { session_id: other, cwd: '/tmp/x' })).json();
  check('恢复会话走 resume 且 meta 不带 preset（从持久化还原）',
    resumed.resumed === true && sockets.lastResume.resumeSessionId === other);

  // --- status / live ---
  const st = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('status 返回 idle + last_seq 基准', st.status === 'idle' && st.last_seq === 0);
  const live = await (await call(base, token, 'GET', '/live')).json();
  check('live 列出两个自持会话', live.sessions.length === 2
    && live.sessions.every((s) => s.owned === true), JSON.stringify(live.sessions.length));

  // --- 侧栏归组（Workspace 成员表；2026-10-04 修「平台任务全落未分组」）---
  // dsh 侧栏按 Workspace 成员表分组，本驱动走进程内 agents.create/resume，绕过了唯一会
  // attach 的会话命令层 ⇒ 驱动必须自己补登记：已有工作区复用，没有则按 cwd 新建。
  const wsCalls = sockets.workspaceCalls;
  check('建会话后归组：无工作区 → 按 cwd 新建并 attach',
    wsCalls.some((c) => c[0] === 'create' && c[1] === '/tmp/x')
    && wsCalls.some((c) => c[0] === 'attach' && c[1] === '/tmp/x' && c[2] === sid),
    JSON.stringify(wsCalls));
  check('恢复会话后归组：命中已有工作区 → 不再新建',
    wsCalls.some((c) => c[0] === 'attach' && c[1] === '/tmp/x' && c[2] === other)
    && wsCalls.filter((c) => c[0] === 'create').length === 1,
    JSON.stringify(wsCalls));
  const seeded = sockets.workspaceRegistry.seed('/tmp/ws-pre');
  const pre = await (await call(base, token, 'POST', '/session',
    { cwd: '/tmp/ws-pre', task: 't2' })).json();
  check('预置工作区直接复用（create 不再被调用）',
    !!pre.session_id && seeded.attached.includes(pre.session_id)
    && sockets.workspaceCalls.filter((c) => c[0] === 'create').length === 1,
    JSON.stringify(wsCalls));
  const wsBefore = sockets.workspaceCalls.length;
  const bare = await (await call(base, token, 'POST', '/session', { task: 't3' })).json();
  check('无 cwd 的会话跳过归组（不报错）',
    !!bare.session_id && sockets.workspaceCalls.length === wsBefore);
  // 归组失败不得影响会话创建（平台任务照跑）：注册表报错 / 服务缺席两条降级路径
  sockets.workspaceFail = 'registry down';
  const failed = await (await call(base, token, 'POST', '/session',
    { cwd: '/tmp/x', task: 't4' })).json();
  check('注册表报错 → 会话照常创建（只告警不抛）', !!failed.session_id,
    JSON.stringify(failed));
  delete sockets.workspaceFail;
  const savedRegistry = sockets.workspaceRegistry;
  sockets.workspaceRegistry = undefined;
  const absent = await (await call(base, token, 'POST', '/session',
    { cwd: '/tmp/x', task: 't5' })).json();
  sockets.workspaceRegistry = savedRegistry;
  check('注册表缺席 → 会话照常创建（降级不抛）', !!absent.session_id,
    JSON.stringify(absent));

  // --- 投递 / 插话 ---
  await call(base, token, 'POST', '/prompt', { session_id: sid, prompt: 'hi' });
  const agent = sockets.agents.get(sid);
  const msg = agent.calls.at(-1);
  check('prompt → followup，且消息是 user 角色块数组',
    msg[0] === 'followup' && msg[1].role === 'user'
    && msg[1].content[0].type === 'text' && msg[1].content[0].text === 'hi'
    && msg[1].source.kind === 'user', JSON.stringify(msg[1]));
  await call(base, token, 'POST', '/steer', { session_id: sid, prompt: 'stop' });
  check('steer → agent.steer', agent.calls.at(-1)[0] === 'steer');

  // --- 事件流：会话事件按 seq 推给 SSE（含 ring 补发）---
  const ssePromise = readFrames(base, token, `/events?session_id=${sid}&since=0`, 2);
  await new Promise((r) => setTimeout(r, 100));
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } });
    fn({ id: sid }, { type: 'turn/end', seq: 2, time: Date.now(),
                      data: { turn: 1, reason: { kind: 'completed' } } });
  }
  const frames = await ssePromise;
  check('SSE 收到 turn/start + turn/end（带 seq）',
    frames.length >= 2 && frames[0].type === 'turn/start'
    && frames[1].type === 'turn/end' && frames[1].data.reason.kind === 'completed',
    JSON.stringify(frames.map((f) => f.type)));

  // --- 事件裁剪：stream 字段必须被丢弃 ---
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'assistant/message', seq: 3, time: Date.now(),
                      data: { message: { content: [{ type: 'text', text: 'x' }] },
                              stream: [{ huge: 'y'.repeat(1000) }] } });
  }
  const st2 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('事件转发后 last_seq 前进（seq=3）', st2.last_seq === 3, String(st2.last_seq));

  // --- 提问帧 → interaction 挂起（2026-10-04 修 #791：必须 prepend 注册）---
  // 注册选项是硬契约：dsh Web 客户端问答桥先注册且认领后不再 next()，append 注册
  // 的 listener 在真机上**永远收不到**提问（隔离实例探针实测）。
  const qHooks = handlers['user-questions/request'] || [];
  check('提问 waterfall 以 {prepend:true} 注册（否则真机收不到）',
    qHooks.length >= 1 && (opts['user-questions/request'] || [])[0]
    && opts['user-questions/request'][0].prepend === true,
    JSON.stringify(opts['user-questions/request']));
  // 平台自持会话（池内 sid）：**双通道**（修 #837）——插件认领（平台 /answer 兑现、
  // Touchstone 会话窗渲染选择框）**且** next() 把请求交回原生链路（dsh Web GUI 也弹
  // 提问框），两侧先答者胜。桩里的 next() 给一条手工兑现的通道，模拟浏览器作答。
  let nativeNext = 0;
  let claimResult = null;
  const lane1 = makeNativeLane();
  const host1 = new AbortController();
  const req1 = { agent: sockets.agents.get(sid), wait: { callId: 'call-1' },
                 signal: host1.signal,
                 questions: [{ id: 'q1', header: 'H', question: 'Q?', detail: 'D',
                               options: [{ label: 'A', description: '选项 A 说明' }] }] };
  const claimPromise = qHooks[0](req1, () => { nativeNext += 1; return lane1.promise; });
  claimPromise.then((v) => { claimResult = v; }, () => {});
  const st3 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('提问 → interaction 标记（含 call_id 与逐题）',
    st3.interaction && st3.interaction.call_id === 'call-1'
    && st3.interaction.questions[0].options[0].label === 'A'
    && st3.interaction.questions[0].options[0].description === '选项 A 说明'
    && st3.interaction.questions[0].detail === 'D',
    JSON.stringify(st3.interaction));
  check('平台自持会话：双通道都开——认领 + next() 交原生链路（dsh GUI 也弹框，修 #837）',
    nativeNext === 1, `next 调用次数=${nativeNext}`);
  check('转发前替换 request.signal（平台先答时可主动收起 GUI 提问框，修 #837）',
    req1.signal !== host1.signal && typeof req1.signal.aborted === 'boolean',
    `same=${req1.signal === host1.signal}`);

  // --- 平台先答：认领被兑现，同时原生通道被取消（GUI 的框自行收起） ---
  const ans = await (await call(base, token, 'POST', '/answer',
    { session_id: sid, call_id: 'call-1', answers: [{ id: 'q1', selected: ['A'] }] })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('平台作答 → 兑现认领（accepted=true，waterfall 返回值=平台作答）',
    ans.accepted === true && claimResult
    && claimResult.answers[0].selected[0] === 'A',
    JSON.stringify({ ans, claimResult }));
  check('平台先答 → 原生通道取消信号 abort（dsh GUI 提问框随之消失）',
    req1.signal.aborted === true, `aborted=${req1.signal.aborted}`);
  check('取消原生通道不碰宿主取消信号（停卡语义不受影响）',
    host1.signal.aborted === false, `hostAborted=${host1.signal.aborted}`);
  const afterAnswer = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('作答后挂起标记清除（平台不残留 pending）',
    afterAnswer.interaction === null, JSON.stringify(afterAnswer.interaction));
  const gone = await call(base, token, 'POST', '/answer',
    { session_id: sid, call_id: 'gone', answers: [] });
  const goneBody = await gone.json();
  check('已过期提问 accepted=false（平台据此按 40405 放弃重试）',
    gone.status === 200 && goneBody.accepted === false);

  // --- 原生链路（dsh GUI）先答：返回值即 GUI 作答，平台挂起标记同步清除 ---
  const lane2 = makeNativeLane();
  const req2 = { agent: sockets.agents.get(sid), signal: new AbortController().signal,
                 questions: [{ id: 'q2', question: 'GUI 先答？', options: [{ label: 'G' }] }] };
  let guiResult = null;
  const guiPromise = qHooks[0](req2, () => { nativeNext += 1; return lane2.promise; });
  guiPromise.then((v) => { guiResult = v; }, () => {});
  const stGui = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('GUI 未答时平台侧同样挂起（两侧都显示：平台框 + GUI 框）',
    Boolean(stGui.interaction && stGui.interaction.kind === 'question'),
    JSON.stringify(stGui.interaction));
  lane2.resolve({ answers: [{ id: 'q2', selected: ['G'] }] });
  await new Promise((r) => setTimeout(r, 10));
  check('GUI 先答 → waterfall 返回值=GUI 作答（宿主 ask_user_question 照常收口）',
    Boolean(guiResult && guiResult.answers[0].selected[0] === 'G'), JSON.stringify(guiResult));
  const stGui2 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('GUI 先答 → 平台挂起标记清除（Touchstone 会话窗的框随之收起）',
    stGui2.interaction === null, JSON.stringify(stGui2.interaction));

  // --- 原生链路失败不判死提问（GUI 点取消/客户端异常/无客户端的 profile） ---
  const lane3 = makeNativeLane();
  const req3 = { agent: sockets.agents.get(sid), signal: new AbortController().signal,
                 questions: [{ id: 'q3', question: '旁路故障？', options: [{ label: 'P' }] }] };
  let sideResult = null;
  const sidePromise = qHooks[0](req3, () => { lane3.fail(new Error('ASK_CANCELLED')); return lane3.promise; });
  sidePromise.then((v) => { sideResult = v; }, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const stSide = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('原生链路失败不算数：平台侧提问仍在挂起（等 /answer）',
    Boolean(stSide.interaction && stSide.interaction.kind === 'question'),
    JSON.stringify(stSide.interaction));
  const sideCallId = String((stSide.interaction || {}).call_id || '');
  await (await call(base, token, 'POST', '/answer',
    { session_id: sid, call_id: sideCallId, answers: [{ id: 'q3', selected: ['P'] }] })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('旁路失败后平台作答照常兑现',
    Boolean(sideResult && sideResult.answers[0].selected[0] === 'P'), JSON.stringify(sideResult));

  // --- 外部会话（不在池）：只旁听 + 让位原生作答者（dsh GUI 照旧可答）---
  for (const fn of handlers['session/created'] || []) {
    fn({ id: 'session-external-1', header: { cwd: '/tmp/ext' } });
  }
  let extNext = 0;
  const extAgent = { id: 'session-external-1' };
  const extRet = await qHooks[0](
    { agent: extAgent, signal: new AbortController().signal,
      questions: [{ id: 'qx', question: '外部问答？', options: [{ label: 'X' }] }] },
    () => { extNext += 1; return Promise.resolve({ answers: [{ id: 'qx', selected: ['X'] }] }); },
  );
  check('外部会话：旁听并让位原生作答者（next() 被调用，返回值原样透传）',
    extNext === 1 && extRet && extRet.answers[0].selected[0] === 'X',
    JSON.stringify({ extNext, extRet }));
  const extLive = await (await call(base, token, 'GET', '/live')).json();
  const extRow = (extLive.sessions || []).find((x) => x.session_id === 'session-external-1');
  check('外部会话提问仍进 /live 挂起态（平台据此把卡置阻塞）',
    Boolean(extRow && extRow.interaction && extRow.interaction.kind === 'question'),
    JSON.stringify(extRow && extRow.interaction));
  // 外部会话的 legacy 提问没有宿主 callId：call_id 为空 ⇒ 平台 answerable=false
  check('外部 legacy 提问 call_id 为空（平台只展示、不提供作答）',
    extRow && extRow.interaction.call_id === '', JSON.stringify(extRow && extRow.interaction));

  // --- 子代理会话 origin 上报（2026-10-07：平台据此不建卡、不占项目运行位）---
  // dsh 子代理会话与主会话同 bucket 同格式，只能靠头行区分（实测 origin=subagent、
  // delegationDepth=1）；插件把 origin 上报给平台（/live 对齐 + session/created 状态帧）。
  for (const fn of handlers['session/created'] || []) {
    fn({ id: 'session-subagent-1',
         header: { cwd: '/tmp/sub', origin: 'subagent', parentSession: sid,
                   delegationDepth: 1 } });
  }
  const subLive = await (await call(base, token, 'GET', '/live')).json();
  const subRow = (subLive.sessions || []).find((x) => x.session_id === 'session-subagent-1');
  check('/live 上报 origin（子代理=subagent；主/外部会话=空串，不推断）',
    Boolean(subRow) && subRow.origin === 'subagent' && extRow.origin === '',
    JSON.stringify({ sub: subRow && subRow.origin, ext: extRow && extRow.origin }));

  // --- tool/call + tool/result：真实 callId 配提问、结果到达清挂起（外部会话收口）---
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-external-1' },
       { type: 'tool/call', seq: 90, time: Date.now(),
         data: { turn: 1, step: 1, callId: 'tc-ext-1', name: 'ask_user_question', arguments: '{}' } });
    fn({ id: sid },
       { type: 'tool/call', seq: 91, time: Date.now(),
         data: { turn: 1, step: 1, callId: 'tc-pool-1', name: 'ask_user_question', arguments: '{}' } });
  }
  // 池内会话：legacy 提问（无 wait.callId）用真实 tool callId 作提问标识；
  // 原生通道给一条永不兑现的通道（GUI 尚未作答），标记必须留着等平台 /answer
  const poolPromise = qHooks[0](
    { agent: sockets.agents.get(sid), signal: new AbortController().signal,
      questions: [{ id: 'qp', question: '池内？', options: [{ label: 'P' }] }] },
    () => makeNativeLane().promise,
  );
  let poolAnswered = null;
  poolPromise.then((v) => { poolAnswered = v; }, () => {});
  const stPool = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('legacy 提问用真实 tool callId 作 call_id（无需宿主 wait.callId）',
    stPool.interaction && stPool.interaction.call_id === 'tc-pool-1',
    JSON.stringify(stPool.interaction));
  await (await call(base, token, 'POST', '/answer',
    { session_id: sid, call_id: 'tc-pool-1', answers: [{ id: 'qp', selected: ['P'] }] })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('按真实 tool callId 作答同样兑现认领',
    Boolean(poolAnswered && poolAnswered.answers[0].selected[0] === 'P'),
    JSON.stringify(poolAnswered));
  // 外部会话：GUI 作答 → tool/result 到达 → 插件清挂起标记（无其它收口信号）
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-external-1' },
       { type: 'tool/result', seq: 92, time: Date.now(),
         data: { turn: 1, step: 1, message: { toolCallId: 'tc-ext-1', role: 'tool',
                                              content: [{ type: 'text', text: '{}' }] } } });
  }
  const extLive2 = await (await call(base, token, 'GET', '/live')).json();
  const extRow2 = (extLive2.sessions || []).find((x) => x.session_id === 'session-external-1');
  check('外部会话提问收口（tool/result 到达即清挂起，防卡永久阻塞）',
    Boolean(extRow2 && extRow2.interaction === null),
    JSON.stringify(extRow2 && extRow2.interaction));

  // --- 取消 ---
  await call(base, token, 'POST', '/cancel', { session_id: sid, keep_inbox: true });
  const cancelled = agent.calls.filter((c) => c[0] === 'cancel').at(-1);
  check('cancel → agent.cancel 且带 keepInbox', cancelled[1] === 'user'
    && cancelled[2].keepInbox === true, JSON.stringify(cancelled));
  const st4 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('cancel → /status.cancelled=true（平台已发起取消，供 reason 归一解释）',
    st4.cancelled === true, JSON.stringify(st4.cancelled));

  // --- reason 归一（2026-10-03 P0 实测：用户 cancel 时 dsh 落盘 reason=null）---
  // 平台按 completed/aborted 正常、其余算失败的口径消费；null 若不归一，会让
  // 「用户主动中断」被 runner 判成轮次失败（turn_exit_code(None)=1）。
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'turn/end', seq: 4, time: Date.now(),
                      data: { turn: 2, reason: null } });
  }
  const st5 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('turn/end reason=null → 归一为 aborted（平台映射 130 而非失败）',
    st5.last_turn_reason === 'aborted', String(st5.last_turn_reason));
  check('reason 归一后 cancelled 标志复位', st5.cancelled === false,
    String(st5.cancelled));
  // 显式 reason 不得被归一覆盖
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'turn/end', seq: 5, time: Date.now(),
                      data: { turn: 3, reason: { kind: 'error' } } });
  }
  const st6 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('显式 reason=error 原样保留', st6.last_turn_reason === 'error',
    String(st6.last_turn_reason));

  // P7a 缺陷 H：**会话流**（runner/chat 的 TurnWaiter 消费的那条）也必须看到归一后的
  // reason——上一版只归一了状态流，真机上「用户取消」的任务轮仍被判失败（退出码 1）。
  const sessFrames = await readFrames(base, token,
    `/events?session_id=${sid}&since=0`, 8, 1500);
  const endFrames = sessFrames.filter((f) => f.type === 'turn/end');
  const nullEnd = endFrames.find((f) => f.data && f.data.turn === 2);
  const errEnd = endFrames.find((f) => f.data && f.data.turn === 3);
  check('会话流 turn/end(reason=null) 同样归一为 aborted（P7a 缺陷 H）',
    Boolean(nullEnd) && nullEnd.data.reason && nullEnd.data.reason.kind === 'aborted',
    JSON.stringify(nullEnd && nullEnd.data));
  check('会话流显式 reason 不被覆盖（turn=3 → error）',
    Boolean(errEnd) && errEnd.data.reason && errEnd.data.reason.kind === 'error',
    JSON.stringify(errEnd && errEnd.data));

  // --- P3 对齐端点（2026-10-03）：compact / fork / rename / model / usage ---
  const cpt = await (await call(base, token, 'POST', '/compact', { session_id: sid })).json();
  check('/compact → commands.execute("/compact")（触发即回，异步压缩）',
    cpt.ok === true && cpt.started === true && sockets.command
    && sockets.command.line === '/compact' && sockets.command.agentId === sid,
    JSON.stringify(sockets.command));
  const fk = await (await call(base, token, 'POST', '/fork', { session_id: sid })).json();
  check('/fork → sessionController.fork 且回新 sid',
    fk.ok === true && /^session-fork-/.test(fk.new_session_id || '')
    && sockets.forked.sessionId === sid, JSON.stringify(fk));
  await call(base, token, 'POST', '/fork', { session_id: sid, at_seq: 7 });
  check('/fork 带 at_seq 时透传 seq', sockets.forked.atSeq === 7,
    JSON.stringify(sockets.forked));

  // --- P7a 缺陷 B（2026-10-03 真机）：fork 子会话必须被插件**接管进池** ---
  // 宿主 fork 内部 create 出子会话、写句柄归 fork 调用方作用域且不释放 ⇒ 平台随后的
  // `POST /session {session_id: 子 sid}` 若走 resume 必 500（is already owned by an
  // active write handle），真机上 fork / 压缩新建 / 回退三端点全挂。契约=fork 成功即
  // 接管：子会话在池、handle 留 null、平台 /session 命中幂等早退且不调 resume。
  const forkSid = fk.new_session_id;
  const forkEntry = driver.sessions.get(forkSid);
  check('fork 子会话被接管进池（裸 agent 就位、本池不持 handle、源 cwd 继承）',
    !!forkEntry && forkEntry.agent === sockets.agents.get(forkSid)
    && forkEntry.handle === null && forkEntry.cwd === '/tmp/x'
    && forkEntry.task === 't1',
    JSON.stringify({ inPool: !!forkEntry, handle: forkEntry && forkEntry.handle,
                     cwd: forkEntry && forkEntry.cwd, task: forkEntry && forkEntry.task }));
  const resumeBefore = sockets.lastResume;
  const adopt = await (await call(base, token, 'POST', '/session',
    { session_id: forkSid, cwd: '/tmp/x', task: 'card-1' })).json();
  check('接管后 /session 同 sid 幂等早退（created=false/resumed=false，不调 resume）',
    adopt.created === false && adopt.resumed === false && sockets.lastResume === resumeBefore,
    JSON.stringify({ adopt, resumeCalled: sockets.lastResume !== resumeBefore }));
  const live2 = await (await call(base, token, 'GET', '/live')).json();
  const adopted = live2.sessions.find((s) => s.session_id === forkSid);
  check('/live 把接管会话列为自持（owned=true）',
    !!adopted && adopted.owned === true && adopted.cwd === '/tmp/x'
    && adopted.task === 't1', JSON.stringify(adopted));
  await call(base, token, 'POST', '/prompt', { session_id: forkSid, prompt: '分支第一轮' });
  const forkAgent = sockets.agents.get(forkSid);
  check('接管会话可直接投递（/prompt → 宿主 agent.followup）',
    forkAgent.calls.at(-1)[0] === 'followup'
    && forkAgent.calls.at(-1)[1].content[0].text === '分支第一轮',
    JSON.stringify(forkAgent.calls.at(-1)));
  // ② `agents.get` 未命中（宿主未注册/版本差异）→ 保持原行为：不接管、不抛，
  //    子会话仍交平台 `/session` 的 resume 路径（真机上即原有的失败路径）。
  sockets.forkRegisterAgent = false;
  const fk2 = await (await call(base, token, 'POST', '/fork', { session_id: sid })).json();
  check('agents.get 未命中 → 不接管，fork 照常回执（不抛）',
    fk2.ok === true && !!fk2.new_session_id && !driver.sessions.has(fk2.new_session_id),
    JSON.stringify(fk2));
  const res2 = await (await call(base, token, 'POST', '/session',
    { session_id: fk2.new_session_id, cwd: '/tmp/x', task: 'card-2' })).json();
  check('未接管时 /session 仍走 resume（原行为不变）',
    res2.resumed === true && sockets.lastResume.resumeSessionId === fk2.new_session_id,
    JSON.stringify({ res2, lastResume: sockets.lastResume.resumeSessionId }));
  sockets.forkRegisterAgent = true;

  const rn = await (await call(base, token, 'POST', '/rename',
    { session_id: sid, title: '新标题' })).json();
  check('/rename → sessionController.rename 且回标题',
    rn.ok === true && rn.title === '新标题' && sockets.renamed.sessionId === sid,
    JSON.stringify(rn));
  const rn2 = await call(base, token, 'POST', '/rename', { session_id: sid, title: '  ' });
  check('/rename 空标题 → 400', rn2.status === 400);
  const md = await (await call(base, token, 'POST', '/model',
    { session_id: sid, model: 'deepseek-official/deepseek-flash' })).json();
  check('/model → selectModel（provider/model 拆分）',
    md.ok === true && sockets.selected.provider === 'deepseek-official'
    && sockets.selected.model === 'deepseek-flash', JSON.stringify(sockets.selected));
  const md2 = await (await call(base, token, 'POST', '/model',
    { session_id: sid, model: 'plain-model' })).json();
  check('/model 只给模型名 → 沿用 agent 当前 provider',
    md2.ok === true && sockets.selected.provider === 'p'
    && sockets.selected.model === 'plain-model', JSON.stringify(sockets.selected));
  const md3 = await call(base, token, 'POST', '/model', { session_id: sid, model: '' });
  check('/model 空模型名 → 400', md3.status === 400);
  // 2026-10-04：思考等级（reasoning_effort）——带模型一起切 / 只给等级（沿用当前模型）
  const md5 = await (await call(base, token, 'POST', '/model',
    { session_id: sid, model: 'deepseek-official/deepseek-flash',
      reasoning_effort: 'high' })).json();
  check('/model 带 reasoning_effort → selectModel 收到等级且回执带 selected.reasoningEffort',
    md5.ok === true && sockets.selected.reasoningEffort === 'high'
    && md5.selected.reasoningEffort === 'high', JSON.stringify(md5.selected));
  const md6 = await (await call(base, token, 'POST', '/model',
    { session_id: sid, reasoning_effort: 'low' })).json();
  check('/model 只给等级（模型留空）→ 沿用会话当前模型',
    md6.ok === true && sockets.selected.provider === 'deepseek-official'
    && sockets.selected.model === 'deepseek-flash'
    && sockets.selected.reasoningEffort === 'low', JSON.stringify(sockets.selected));
  const stEff = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('/status.model 带 reasoningEffort（会话窗「思考等级」回读源）',
    stEff.model && stEff.model.reasoningEffort === 'low'
    && stEff.model.model === 'deepseek-flash', JSON.stringify(stEff.model));
  const noEff = await call(base, token, 'POST', '/model', { session_id: sid });
  check('/model 模型与等级都空 → 400', noEff.status === 400, String(noEff.status));
  const md4 = await (await call(base, token, 'GET', '/models')).json();
  check('/models → 宿主模型目录（provider 分组原样透出）',
    Array.isArray(md4.groups) && md4.groups.length === 1
    && md4.groups[0].models[0].name === 'm' && md4.default && md4.default.model === 'm',
    JSON.stringify(md4).slice(0, 140));
  check('/models 透传思考等级档位与默认档',
    JSON.stringify(md4.groups[0].models[0].efforts)
      === JSON.stringify([{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }])
    && md4.groups[0].models[0].default_effort === 'high'
    && md4.groups[0].models[0].reasoning === true,
    JSON.stringify(md4.groups[0].models[0]));
  await call(base, token, 'GET', '/models');
  check('/models 60s 缓存（宿主目录只拉一次）', sockets.catalogCalls === 1,
    String(sockets.catalogCalls));
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'assistant/message', seq: 6, time: Date.now(),
                      data: { turn: 3, step: 1, message: { content: [] },
                              usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });
  }
  const st7 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('assistant/message 的 usage 累积到 /status.usage',
    st7.usage && st7.usage.input === 100 && st7.usage.output === 20 && st7.usage.total === 120,
    JSON.stringify(st7.usage));

  // --- P3 第二批：权限 preset + 审批代答（2026-10-03）---
  const delegate = () => { sockets.nextCalled = (sockets.nextCalled || 0) + 1;
                           return Promise.resolve('unavailable'); };
  const askReq = (callId) => ({ agent: sockets.agents.get(sid), toolName: 'bash', callId });
  // 未接管：waterfall 让位（GUI 照常可答）
  const outA = await handlers['approval/request'][0](askReq('c1'), delegate);
  check('未接管审批 → next() 让位（GUI 可答）',
    sockets.nextCalled === 1 && outA === 'unavailable', `${outA}/${sockets.nextCalled}`);
  const pr = await (await call(base, token, 'POST', '/permission',
    { session_id: sid, preset: 'workspace-write' })).json();
  check('/permission → permissionPresets.set，approval=ask 时接管审批',
    pr.ok === true && pr.preset === 'workspace-write' && pr.hold_approvals === true
    && sockets.setPreset && sockets.setPreset.name === 'workspace-write'
    && sockets.setPreset.sid === sid, JSON.stringify(pr));
  // 接管后：认领并挂起，等 /approval 兑现
  const held = handlers['approval/request'][0](askReq('c2'), delegate);
  await new Promise((r) => setTimeout(r, 20));
  const stA = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('接管后审批挂起：interaction=approval(answerable) + pending_approval',
    stA.approval_held === true && !!stA.pending_approval
    && stA.interaction && stA.interaction.kind === 'approval'
    && stA.interaction.answerable === true, JSON.stringify(stA.interaction));
  const ap = await (await call(base, token, 'POST', '/approval',
    { session_id: sid, approval_id: stA.pending_approval, decision: 'allowed-once' })).json();
  check('/approval → 兑现 allowed-once 且 waterfall 收到 outcome',
    ap.ok === true && ap.outcome === 'allowed-once' && await held === 'allowed-once',
    JSON.stringify(ap));
  const ap2 = await call(base, token, 'POST', '/approval',
    { session_id: sid, decision: 'rejected' });
  check('无待决审批 → 409', ap2.status === 409, String(ap2.status));
  const held2 = handlers['approval/request'][0](askReq('c3'), delegate);
  await new Promise((r) => setTimeout(r, 20));
  const ap3 = await call(base, token, 'POST', '/approval',
    { session_id: sid, decision: 'bogus' });
  check('/approval 非法 decision → 400', ap3.status === 400, String(ap3.status));
  await call(base, token, 'POST', '/approval', { session_id: sid, decision: 'rejected' });
  check('兑现 rejected 收口挂起', await held2 === 'rejected', String(await held2));
  const ps = await (await call(base, token, 'GET', `/presets?session_id=${sid}`)).json();
  check('/presets → current + options（供 UI 渲染）',
    ps.current === 'workspace-write' && ps.options.length === 2
    && ps.options[0].value === 'workspace-write', JSON.stringify(ps.options));
  const pr2 = await (await call(base, token, 'POST', '/permission',
    { session_id: sid, preset: 'danger-full-access' })).json();
  check('/permission approval=never → 不接管审批',
    pr2.ok === true && pr2.hold_approvals === false, JSON.stringify(pr2));
  const pr3 = await call(base, token, 'POST', '/permission', { session_id: sid, preset: '  ' });
  check('/permission 空 preset → 400', pr3.status === 400, String(pr3.status));

  // --- 权限档回读（2026-10-04 修「会话窗权限控件恒置灰」）---
  // preset→三档是多对一（yolo/auto 同 preset），故平台随写传 mode，驱动记下并回传
  const permSeq = driver.stateSeq;
  const prm = await (await call(base, token, 'POST', '/permission',
    { session_id: sid, preset: 'workspace-write', mode: 'manual' })).json();
  const permFrames = await readFrames(base, token,
    `/events?scope=state&since=${permSeq}`, 1, 1500);
  check('driver/permission 进状态流（mode+preset 回传）',
    !!prm.permission && prm.permission.mode === 'manual'
    && prm.permission.preset === 'workspace-write'
    && permFrames.some((f) => f.type === 'driver/permission'
      && f.data.mode === 'manual' && f.data.preset === 'workspace-write'),
    JSON.stringify({ prm: prm.permission, frames: permFrames.map((f) => f.type) }));
  const stP = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('/status.permission 回读 {mode, preset}',
    !!stP.permission && stP.permission.mode === 'manual'
    && stP.permission.preset === 'workspace-write', JSON.stringify(stP.permission));
  const liveP = await (await call(base, token, 'GET', '/live')).json();
  const liveRow = (liveP.sessions || []).find((r) => r.session_id === sid);
  check('/live 行含 permission（重连对齐用；进程内回读，零 REST）',
    !!liveRow && !!liveRow.permission && liveRow.permission.mode === 'manual'
    && liveRow.permission.preset === 'workspace-write',
    JSON.stringify(liveRow && liveRow.permission));
  const prBad = await call(base, token, 'POST', '/permission',
    { session_id: sid, preset: 'workspace-write', mode: 'bad mode!' });
  check('/permission 非法 mode → 400', prBad.status === 400, String(prBad.status));
  // 不带 mode（外部工具直打驱动）＝来源不明：清掉 mode，只留 preset 实况
  const prNoMode = await (await call(base, token, 'POST', '/permission',
    { session_id: sid, preset: 'workspace-write' })).json();
  check('/permission 不带 mode → mode 清空、preset 照常回读',
    !!prNoMode.permission && prNoMode.permission.mode === ''
    && prNoMode.permission.preset === 'workspace-write',
    JSON.stringify(prNoMode.permission));

  // --- #20 媒体预览：GET /media 取图片字节 ---
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                             Buffer.from('fakepngdata')]);
  const mediaFile = path.join(os.tmpdir(), `ts-media-${process.pid}.png`);
  fs.writeFileSync(mediaFile, png);
  sockets.mediaPath = mediaFile;
  const aid = 'sha256:' + 'a'.repeat(64);
  const media = await (await call(base, token, 'GET', `/media?id=${aid}`)).json();
  check('/media → base64 字节 + 嗅探出的 content-type',
    media.content_type === 'image/png' && media.bytes === png.length
    && Buffer.from(media.data, 'base64').equals(png)
    && sockets.mediaRef && sockets.mediaRef.attachmentId === aid,
    JSON.stringify(media).slice(0, 120));
  const mdBad = await call(base, token, 'GET', '/media?id=../../etc/passwd');
  check('/media 非法 id → 400（不让插件碰路径拼接）', mdBad.status === 400,
    String(mdBad.status));
  sockets.mediaPath = '';
  const mdMiss = await call(base, token, 'GET', `/media?id=${aid}`);
  check('/media 宿主机无路径 → 404', mdMiss.status === 404, String(mdMiss.status));
  fs.unlinkSync(mediaFile);

  // --- P6 #21：宿主 inbox 排队行 ---
  const seqI = driver.stateSeq;
  for (const fn of handlers['agent/inbox/inserted'] || []) {
    fn({ agent: sockets.agents.get(sid), message: { id: 'ib-1', content: [{ type: 'text', text: '排队一' }] } });
  }
  for (const fn of handlers['agent/inbox/inserted'] || []) {
    fn({ agent: sockets.agents.get(sid), message: { id: 'ib-2', content: '排队二' } });
  }
  const stI = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('inbox inserted → /status.inbox 两行（块数组与纯字符串都抽得出文本）',
    stI.inbox.length === 2 && stI.inbox[0].text === '排队一'
    && stI.inbox[1].text === '排队二', JSON.stringify(stI.inbox));
  for (const fn of handlers['agent/inbox/claimed'] || []) {
    fn({ agent: sockets.agents.get(sid), message: { id: 'ib-1', content: [] } });
  }
  const stI2 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('inbox claimed → 该行离开队列',
    stI2.inbox.length === 1 && stI2.inbox[0].id === 'ib-2', JSON.stringify(stI2.inbox));
  const inboxFrames = await readFrames(base, token,
    `/events?scope=state&since=${seqI}`, 3, 1500);
  check('inbox 变化进状态流（会话窗零轮询刷新）',
    inboxFrames.filter((f) => f.type === 'driver/inbox').length === 3
    && inboxFrames[inboxFrames.length - 1].data.items.length === 1,
    JSON.stringify(inboxFrames.map((f) => f.type)));

  // --- P4：全局状态流 /events?scope=state（2026-10-03）---
  const sbuf = [];                      // 先起消费者，再触发事件（真·推送路径）
  const ctrlS = new AbortController();
  const resS = await fetch(`${base}/events?scope=state&since=0`,
                           { headers: { 'x-ts-driver-token': token }, signal: ctrlS.signal });
  const readerS = resS.body.getReader();
  const decS = new TextDecoder();
  let rawS = '';
  const pumpS = (async () => {          // 持续读，直到 abort（不能按帧数提前退出）
    try {
      for (;;) {
        const { value, done } = await readerS.read();
        if (done) break;
        rawS += decS.decode(value, { stream: true });
        while (rawS.includes('\n\n')) {
          const i = rawS.indexOf('\n\n');
          const block = rawS.slice(0, i);
          rawS = rawS.slice(i + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) sbuf.push(JSON.parse(line.slice(5).trim()));
          }
        }
      }
    } catch { /* abort 收尾 */ }
  })();
  await new Promise((r) => setTimeout(r, 100));
  const ringFrames = sbuf.slice();      // since=0 的补发部分（环内既有帧）
  const ringLast = ringFrames.length ? ringFrames[ringFrames.length - 1].seq : 0;
  check('状态流：since=0 补发环内帧（含 driver/attached）',
    ringFrames.some((f) => f.type === 'driver/attached' && f.session_id === sid)
    && ringFrames.some((f) => f.type === 'driver/attached' && f.session_id === forkSid
                              && f.data.owned === true)
    && ringFrames.every((f) => typeof f.seq === 'number'),
    JSON.stringify(ringFrames.map((f) => f.type)));
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'turn/start', seq: 9, time: Date.now(), data: { turn: 4 } });
    fn({ id: sid }, { type: 'turn/end', seq: 10, time: Date.now(),
                      data: { turn: 4, reason: { kind: 'completed' } } });
  }
  const dl = Date.now() + 1000;
  while (Date.now() < dl && !sbuf.some((f) => f.type === 'turn/end' && f.seq > ringLast)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const pushed = sbuf.filter((f) => f.seq > ringLast);
  check('状态流：turn/start 与 turn/end 实时推送（带 reason）',
    pushed.some((f) => f.type === 'turn/start' && f.session_id === sid)
    && pushed.some((f) => f.type === 'turn/end' && f.data.reason === 'completed'),
    JSON.stringify(pushed.map((f) => `${f.type}:${f.data.reason || ''}`)));
  check('状态流：seq 全局单调（可作重连 since 基准）',
    sbuf.every((f, i) => i === 0 || f.seq > sbuf[i - 1].seq),
    sbuf.map((f) => f.seq).join(','));
  const subCreated = ringFrames.find((f) => f.type === 'session/created'
    && f.session_id === 'session-subagent-1');
  check('状态流：session/created 帧带 origin（EventHub 折进注册表，重连对齐同源）',
    Boolean(subCreated) && subCreated.data.origin === 'subagent',
    JSON.stringify(subCreated && subCreated.data));
  ctrlS.abort();
  // abort 后 pending 的 read() 在 Node 里不保证立刻 reject，故只限时等一等，
  // 不阻塞后续检查（真正的收尾由进程退出完成）
  await Promise.race([pumpS, new Promise((r) => setTimeout(r, 200))]);
  const lastSeq = sbuf.length ? sbuf[sbuf.length - 1].seq : 0;
  // since=最新 的续传语义：连上后**不应补发**，且下一帧正好是 seq 连续的 +1
  // （readFrames 按「收到 n 帧或超时」收口，等不到帧会挂住，故这里主动触发一帧）
  const ctrlA = new AbortController();
  const resA = await fetch(`${base}/events?scope=state&since=${lastSeq}`,
                           { headers: { 'x-ts-driver-token': token }, signal: ctrlA.signal });
  const readerA = resA.body.getReader();
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'turn/start', seq: 11, time: Date.now(), data: { turn: 5 } });
  }
  const firstChunk = await readerA.read();
  ctrlA.abort();
  const firstFrame = JSON.parse(
    new TextDecoder().decode(firstChunk.value).split('data:')[1].split('\n')[0].trim());
  check('状态流：since=最新 只续传新帧（seq 连续、无重放）',
    firstFrame.seq === lastSeq + 1 && firstFrame.type === 'turn/start',
    JSON.stringify(firstFrame));

  // usage 与 driver/model 也进全局状态流（P6：会话窗 ctx 圈 / 模型控件事件化）
  const seq0 = driver.stateSeq;
  for (const fn of handlers['session/event'] || []) {
    fn({ id: sid }, { type: 'assistant/message', seq: 12, time: Date.now(),
                      data: { turn: 5, step: 1, message: { content: [] },
                              usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } });
  }
  await call(base, token, 'POST', '/model', { session_id: sid, model: 'q/w' });
  const extra = await readFrames(base, token, `/events?scope=state&since=${seq0}`, 2, 1500);
  check('usage 与 driver/model 进状态流（会话窗零轮询刷新）',
    extra.some((f) => f.type === 'usage' && f.data.total === 10)
    && extra.some((f) => f.type === 'driver/model' && f.data.model === 'w'),
    JSON.stringify(extra.map((f) => f.type)));

  check('未知端点 404', (await call(base, token, 'GET', '/nope')).status === 404);
  check('不在池的会话 404',
    (await call(base, token, 'GET', '/status?session_id=session-99999999-9999-9999-9999-999999999999')).status === 404);

  // --- 会话归档（看板「已完成」双向同步，2026-10-05）---
  // 契约：GET /archived 整表；POST /archive {archived:true|false} 幂等、归档带
  // stopActivity（平台刚发过 abort，异步生效前宿主可能仍认为有在跑的工作）；
  // 会话不存在 → 410（平台据此跳过该 sid、放行卡片）；归档集变化进状态流
  // `driver/archived`（平台 EventHub 折叠后驱动看板搬列，全程零轮询）。
  sockets.workspaceRegistry.knownSessions.add(sid);
  const arch0 = await (await call(base, token, 'GET', '/archived')).json();
  check('/archived 初始为空表', Array.isArray(arch0.archived) && arch0.archived.length === 0,
    JSON.stringify(arch0));
  const seqAr = driver.stateSeq;
  const ar1 = await (await call(base, token, 'POST', '/archive',
                               { session_id: sid, archived: true })).json();
  const archFrames = await readFrames(base, token, `/events?scope=state&since=${seqAr}`, 1, 1500);
  check('归档：/archive 200 且 driver/archived 帧推整表',
    ar1.archived === true
    && archFrames.some((f) => f.type === 'driver/archived'
      && Array.isArray(f.data.archived) && f.data.archived.includes(sid)),
    JSON.stringify({ ar1, frames: archFrames.map((f) => f.type) }));
  check('归档带 stopActivity（宿主先归档再停工作）',
    sockets.archiveCalls.some((c) => c[0] === 'archive' && c[1] === sid && c[2] === true),
    JSON.stringify(sockets.archiveCalls));
  check('/archived 回读归档集',
    (await (await call(base, token, 'GET', '/archived')).json()).archived.includes(sid));
  const un1 = await (await call(base, token, 'POST', '/archive',
                               { session_id: sid, archived: false })).json();
  check('取消归档：archived=false 生效且回读为空',
    un1.archived === false
    && !(await (await call(base, token, 'GET', '/archived')).json()).archived.includes(sid),
    JSON.stringify(un1));

  // --- 宿主侧（dsh GUI）归档的事件路径（2026-10-07 定因回归）---
  // 真机故障：`domain/changed` 监听器里回读 `registry.archivedSessionIds` 拿到的是
  // **旧快照**（官方 setState 先 emit 后刷缓存）⇒ key 比对判定「没变化」而早退，
  // 归档只能等 15s keepalive 才推帧（实测延迟 1.1~13.8s）。修法＝直接取事件载荷
  // `change.value.archivedSessionIds`。本用例**不走** `/archive` 端点（那条路自带
  // 显式补帧，会掩盖问题），直接调宿主 registry——与 GUI 点击同一条路径。
  //
  // 判定读**进程内状态环**而不是 SSE 读窗口：桩的 `archiveSession` 是同步 emit，
  // 帧必须在 `await` 返回前就入环；定时器回调是宏任务、不可能插进这段同步执行，
  // 所以「环里已有该帧」只可能来自事件路径（读窗口法会被 15s keepalive 撞上假通过）。
  const seqGui = driver.stateSeq;
  await sockets.workspaceRegistry.archiveSession(sid, { stopActivity: true });
  const guiFrame = driver.stateRing[driver.stateRing.length - 1];
  check('宿主侧归档走 domain/changed 当场推帧（不等 15s keepalive / 3s 兜底）',
    driver.stateSeq === seqGui + 1 && guiFrame && guiFrame.type === 'driver/archived'
    && Array.isArray(guiFrame.data.archived) && guiFrame.data.archived.includes(sid),
    JSON.stringify({ seqDelta: driver.stateSeq - seqGui, last: guiFrame && guiFrame.type }));
  check('用例确实复现了真机顺序：事件发出时 registry 缓存仍是旧值',
    Array.isArray(sockets.cacheAtEmit) && !sockets.cacheAtEmit.includes(sid),
    JSON.stringify(sockets.cacheAtEmit));
  // 复位（后续用例假定 sid 未归档）
  await sockets.workspaceRegistry.unarchiveSession(sid);

  // 二道兜底：事件彻底丢失时，3s 快速扫描也能把变化推出去（直接改 registry、不发事件）
  const seqSweep = driver.stateSeq;
  sockets.workspaceRegistry.archived = [...sockets.workspaceRegistry.archived, sid];
  const sweepFrames = await readFrames(base, token, `/events?scope=state&since=${seqSweep}`, 1, 4500);
  check('兜底扫描：事件丢失时 3s 内仍推 driver/archived 帧',
    sweepFrames.some((f) => f.type === 'driver/archived'
      && Array.isArray(f.data.archived) && f.data.archived.includes(sid)),
    JSON.stringify(sweepFrames.map((f) => f.type)));
  sockets.workspaceRegistry.archived = sockets.workspaceRegistry.archived.filter((x) => x !== sid);
  await new Promise((r) => setTimeout(r, 50));

  const unknownAr = await call(base, token, 'POST', '/archive',
                               { session_id: 'session-99999999-9999-9999-9999-999999999999',
                                 archived: true });
  check('未知会话归档 → 410（平台跳过该 sid 放行卡片）', unknownAr.status === 410,
    String(unknownAr.status));

  // --- 宿主已有会话枚举（A 批 2026-10-08）---
  // 实障（bug_report/20261008_1935）：插件重新 apply（热重载 / 面板行开关往返）会重建
  // 驱动实例，而 `observed` 的唯一写入路径是 `session/created`——**已有会话不会再发该
  // 事件** ⇒ `/live` 恒空（真机实测 23 条 → 0 条且 3 分钟不恢复），平台侧 dshevents
  // 对齐拿到空表、对所有外部会话失去可见性（运行中的卡被判待审核）。
  // 修法：apply 时枚举宿主 `sessions` 服务的 store，把已有会话补进观察表，并在 `/live`
  // 里声明 `complete:true`（Python 侧 B 批已按 `resp["complete"] is True` 消费）。
  await withDriver((s) => {
    // apply 前宿主里就有的两条：一条子代理会话、一条主会话
    s.sessions.store.set('session-host-aaa',
                         { session: hostSession('session-host-aaa', '/tmp/host-a', 'subagent') });
    s.sessions.store.set('session-host-bbb',
                         { session: hostSession('session-host-bbb', '/tmp/host-b', '') });
  }, async ({ driver, base, token, sockets, handlers }) => {
    const lv = await (await call(base, token, 'GET', '/live')).json();
    check('A 批：apply 时枚举宿主已有会话（/live 不再恒空）',
      lv.complete === true && lv.sessions.length === 2
      && lv.sessions.every((x) => x.owned === false),
      JSON.stringify(lv));
    check('A 批：枚举行带 origin（子代理判定不依赖磁盘兜底）',
      (lv.sessions.find((x) => x.session_id === 'session-host-aaa') || {}).origin === 'subagent'
      && (lv.sessions.find((x) => x.session_id === 'session-host-bbb') || {}).origin === '',
      JSON.stringify(lv.sessions.map((x) => [x.session_id, x.origin])));
    const hl = await (await call(base, token, 'GET', '/health')).json();
    check('A 批：/health 暴露 enumerated 与 observed（重启后可见性诊断口）',
      hl.ok === true && hl.enumerated === true && hl.observed === 2,
      JSON.stringify(hl));
    // 与 `session/created` 合流：新会话入表、同 sid 覆盖不产生重复行
    for (const fn of handlers['session/created'] || []) {
      fn(hostSession('session-host-ccc', '/tmp/host-c', ''));
      fn(hostSession('session-host-aaa', '/tmp/host-a2', 'subagent'));
    }
    const merged = await (await call(base, token, 'GET', '/live')).json();
    check('A 批：枚举结果与 session/created 合流（同 sid 覆盖、无重复）',
      merged.sessions.length === 3
      && merged.sessions.filter((x) => x.session_id === 'session-host-aaa').length === 1
      && (merged.sessions.find((x) => x.session_id === 'session-host-aaa') || {}).cwd === '/tmp/host-a2',
      JSON.stringify(merged.sessions.map((x) => [x.session_id, x.cwd])));
    // 幂等 + 与自持池去重：平台自建会话同时也在宿主表里（真机常态），只能出一行
    const mine = await (await call(base, token, 'POST', '/session',
                                   { cwd: '/tmp/x', task: 'enum' })).json();
    sockets.sessions.store.set(mine.session_id, { session: hostSession(mine.session_id, '/tmp/x', '') });
    driver._enumerateHostSessions();               // 再枚举一次（幂等）
    const again = await (await call(base, token, 'GET', '/live')).json();
    check('A 批：重复枚举幂等，且与自持池去重（同一 sid 只一行、owned=true）',
      again.sessions.length === 4
      && again.sessions.filter((x) => x.session_id === mine.session_id).length === 1
      && (again.sessions.find((x) => x.session_id === mine.session_id) || {}).owned === true,
      JSON.stringify(again.sessions.map((x) => [x.session_id, x.owned])));
  });

  // 降级：宿主表读不到（服务缺席 / 形状不符）⇒ complete=false，行为退回现状
  // （平台按「未对齐」处理：不写列、不推断），且绝不影响插件其余端点。
  for (const [label, setup] of [
    ['sessions 服务缺席', (s) => { s.sessions = undefined; }],
    ['store 形状不符', (s) => { s.sessions = { store: {} }; }],
  ]) {
    await withDriver(setup, async ({ base, token }) => {
      const lv = await (await call(base, token, 'GET', '/live')).json();
      const hl = await (await call(base, token, 'GET', '/health')).json();
      const made = await (await call(base, token, 'POST', '/session', { cwd: '/tmp/x' })).json();
      check(`A 批：${label} ⇒ complete=false 降级（不抛、其余端点照常）`,
        lv.complete === false && Array.isArray(lv.sessions) && lv.sessions.length === 0
        && hl.ok === true && hl.enumerated === false
        && /^session-/.test(String(made.session_id || '')),
        JSON.stringify({ lv, hl, made }));
    });
  }

  // 延时兜底：apply 那一刻宿主可能仍在恢复工作区（服务还没挂上）⇒ 1s 后再枚举一次
  await withDriver((s) => { s.sessions = undefined; }, async ({ base, token, sockets }) => {
    sockets.sessions = { store: new Map([['session-host-late',
      { session: hostSession('session-host-late', '/tmp/late', '') }]]) };
    const before = await (await call(base, token, 'GET', '/live')).json();
    await new Promise((r) => setTimeout(r, 1300));
    const after = await (await call(base, token, 'GET', '/live')).json();
    check('A 批：apply 时宿主表不可见 → 1s 兜底补枚举（complete 转 true）',
      before.complete === false && after.complete === true
      && after.sessions.some((x) => x.session_id === 'session-host-late'),
      JSON.stringify({ before: before.complete, after }));
  });

  // --- 看管声明（C 批）：非池内会话的注入开关 ---
  // 为什么必须由平台**显式声明**、而不是「非池内即纳管」：宿主进程里存在大量与
  // Touchstone 无关的会话（用户自己开的、子代理派生的），按推断纳管等于给平台开了
  // 「向任意会话注入消息/作答」的口子。T2 投递回落 / T3 提问认领 / T4 审批双通道
  // 都以 `_isWatched` 为唯一判据，故这里把端点与读口形状一并钉死。
  const w1 = await (await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w1' })).json();
  check('POST /watch 声明看管 → watched=true', w1.ok === true && w1.watched === true, JSON.stringify(w1));
  // 形状守卫：下游三批直接调 `_isWatched`，缺席即整批失效（故先判类型再判语义）
  check('_isWatched 只认声明过的 sid（未声明一律 false）',
    typeof driver._isWatched === 'function' && driver._isWatched('session-ext-w1') === true
    && driver._isWatched('session-ext-other') === false,
    JSON.stringify([typeof driver._isWatched, driver._isWatched && driver._isWatched('session-ext-other')]));
  const w2 = await (await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w1' })).json();
  check('watch 幂等', w2.watched === true, JSON.stringify(w2));
  const wh = await (await call(base, token, 'GET', '/health')).json();
  check('/health 暴露 watched 计数', wh.watched === 1, String(wh.watched));
  const w3 = await (await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w1', on: false })).json();
  check('on:false 撤销看管', w3.watched === false, JSON.stringify(w3));
  const w4 = await call(base, token, 'POST', '/watch', { session_id: '' });
  check('缺 session_id → 400', w4.status === 400, String(w4.status));
  // 会话销毁即收口：否则看管表只涨不消，平台会对已不存在的 sid 继续纳管
  await (await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w2' })).json();
  for (const fn of handlers['session/disposed'] || []) fn({ id: 'session-ext-w2' });
  const wh2 = await (await call(base, token, 'GET', '/health')).json();
  check('会话销毁 → 看管声明自动清除', wh2.watched === 0, String(wh2.watched));

  // --- T2 投递回落（C 批）：池外 + 平台看管 + 宿主有活 agent ⇒ 直投，不接管 ---
  // 桩造外部会话：宿主 `sessions.store` 登记（与 /live 同源，形状见 hostSession）+
  // `agents` 表里有活 agent（该表就是驱动的宿主读口 `this.agentCtx.agents`）。
  // 场景对应卡 #919：用户在 dsh GUI 直跑的会话不在平台池里，平台只「声明看管」。
  sockets.sessions.store.set('session-ext-w1',
    { id: 'session-ext-w1', session: hostSession('session-ext-w1', '/tmp/ext') });
  sockets.agents.set('session-ext-w1', makeAgent('session-ext-w1', '/tmp/ext'));
  const watchAgent = sockets.agents.get('session-ext-w1');
  await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w1' });
  const p1 = await (await call(base, token, 'POST', '/prompt',
    { session_id: 'session-ext-w1', prompt: '外部投递' })).json();
  check('watched + 活 agent：/prompt 回落直投（external=true）',
    p1.ok === true && p1.external === true, JSON.stringify(p1));
  check('回落走的是宿主活 agent 的 followup',
    watchAgent.calls.some((c) => c[0] === 'followup'
      && c[1].content[0].text === '外部投递'), JSON.stringify(watchAgent.calls));
  const s1 = await (await call(base, token, 'POST', '/steer',
    { session_id: 'session-ext-w1', prompt: '插话' })).json();
  check('watched：/steer 回落（external=true）',
    s1.ok === true && s1.external === true
    && watchAgent.calls.some((c) => c[0] === 'steer'), JSON.stringify(s1));
  // /status 回落（brief Step 3 第三段）：形状 = 最小实时态 + external + 旁听 interaction，
  // **不含 last_seq**（外部会话的会话事件 seq 不进本池，平台基线口径由 T6 统一走 dshevents）。
  for (const fn of handlers['session/created'] || []) {
    fn({ id: 'session-ext-w1', header: { cwd: '/tmp/ext' } });
  }
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-ext-w1' },
       { type: 'approval/asked', seq: 1, time: Date.now(),
         data: { id: 'ap-ext-1', toolName: 'bash', reason: '外部会话等审批' } });
  }
  const stW = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched + 活 agent：/status 回落（external + 旁听 interaction，不含 last_seq）',
    stW.session_id === 'session-ext-w1' && stW.external === true
    && stW.status === watchAgent.status
    && Boolean(stW.interaction) && stW.interaction.id === 'ap-ext-1'
    && !('last_seq' in stW), JSON.stringify(stW));
  sockets.agents.delete('session-ext-w1');
  // 「闸门唯一实现」取证（评审 Important 1 的修复证据）：先接管驱动的 `_externalTarget` 计数，
  // 再让三个端点各打一次——重构若把判定内联回某个端点，该端点不会命中这里（计数 <3）。
  // 桩在旧代码上 `rawTarget` 为 undefined，故干跑返回 undefined（让断言失败而非抛异常）。
  const rawTarget = driver._externalTarget;
  let targetCalls = 0;
  driver._externalTarget = function spyExternalTarget(res2, sid2) {
    targetCalls += 1;
    return typeof rawTarget === 'function' ? rawTarget.call(this, res2, sid2) : undefined;
  };
  const r2 = await call(base, token, 'POST', '/prompt',
    { session_id: 'session-ext-w1', prompt: 'x' });
  const p2 = await r2.json();
  check('watched 但无活 agent：404「会话已结束（宿主无活动 agent）」',
    r2.status === 404 && String(p2.error || '').includes('会话已结束'), JSON.stringify(p2));
  // 逐字核全串（同场景三端点一次打完）：/prompt·/steer 是闸门自写的分档文案；
  // /status 按控制者裁定保留既有文案（进度记录「T2 顾虑不修」），故与未看管同串。
  const r2b = await call(base, token, 'POST', '/steer',
    { session_id: 'session-ext-w1', prompt: 'x' });
  const p2b = await r2b.json();
  const r2c = await call(base, token, 'GET', '/status?session_id=session-ext-w1');
  const p2c = await r2c.json();
  delete driver._externalTarget;
  check('watched + 无活 agent：三端点 404 逐字核全串（闸门文案分档）',
    r2.status === 404 && p2.error === '会话已结束（宿主无活动 agent）: session-ext-w1'
    && r2b.status === 404 && p2b.error === '会话已结束（宿主无活动 agent）: session-ext-w1'
    && r2c.status === 404 && p2c.error === '会话不在驱动池中: session-ext-w1',
    JSON.stringify({ prompt: { status: r2.status, error: p2.error },
                     steer: { status: r2b.status, error: p2b.error },
                     status: { status: r2c.status, error: p2c.error } }));
  check('三端点共用唯一闸门 _externalTarget（各命中一次）',
    typeof rawTarget === 'function' && targetCalls === 3,
    JSON.stringify({ type: typeof rawTarget, calls: targetCalls }));
  const r3 = await call(base, token, 'POST', '/prompt',
    { session_id: 'session-never-watched', prompt: 'x' });
  const p3 = await r3.json();
  check('未看管会话：404 原文案不变（回归）',
    r3.status === 404 && p3.error === '会话不在驱动池中: session-never-watched', JSON.stringify(p3));
  // 未看管回归（更狠的一条）：宿主**有**活 agent 也不得直投——看管声明是唯一闸门，
  // 否则宿主里任何用户自己的会话都能被平台注入消息（设计 §3.1 的开口理由）。
  sockets.agents.set('session-ext-w3', makeAgent('session-ext-w3', '/tmp/ext'));
  const r4 = await call(base, token, 'POST', '/prompt',
    { session_id: 'session-ext-w3', prompt: 'x' });
  const p4 = await r4.json();
  const r5 = await call(base, token, 'POST', '/steer',
    { session_id: 'session-ext-w3', prompt: 'x' });
  const r6 = await call(base, token, 'GET', '/status?session_id=session-ext-w3');
  check('未看管但宿主有活 agent：/prompt·/steer·/status 一律 404 原文案（看管是唯一闸门）',
    r4.status === 404 && p4.error === '会话不在驱动池中: session-ext-w3'
    && r5.status === 404 && r6.status === 404
    && sockets.agents.get('session-ext-w3').calls.length === 0,
    JSON.stringify({ prompt: p4, steer: r5.status, status: r6.status,
                     calls: sockets.agents.get('session-ext-w3').calls }));
  sockets.agents.delete('session-ext-w3');
  // 池内路径一字不动的两个空 prompt 边角：T2 只把 `text` 求值提前（回落分支要用），
  // 判定顺序未动——池内空 prompt 仍 400，未看管空 prompt 仍先撞 404 原文案（不被 400 截胡）。
  const r7 = await call(base, token, 'POST', '/prompt', { session_id: sid, prompt: '' });
  const p7 = await r7.json();
  const r8 = await call(base, token, 'POST', '/prompt', { session_id: 'session-never-watched' });
  const p8 = await r8.json();
  const r9 = await call(base, token, 'POST', '/steer', { session_id: sid, prompt: '' });
  check('池内空 prompt 仍 400（/prompt·/steer）；未看管空 prompt 仍先撞 404 原文案',
    r7.status === 400 && p7.error === 'prompt 不能为空' && r9.status === 400
    && r8.status === 404 && p8.error === '会话不在驱动池中: session-never-watched',
    JSON.stringify({ prompt: r7.status, steer: r9.status, unwatched: p8 }));

  // --- T3 提问认领第三分支（C 批）：池外 + 平台看管 ⇒ 双通道（认领 + 原生照旧）---
  // 看管的外部会话（用户在 dsh GUI 直跑的）改前只「旁听」：挂起标记的 call_id 走旁听口径，
  // legacy 提问恒为空 ⇒ 平台侧 answerable=false、会话窗不给作答框，只能回 dsh GUI 里答。
  // T3 起与池内会话同款**双通道**：平台认领（`/answer` 兑现 waterfall）**同时**原生链路
  // 照旧打开（dsh GUI 照旧弹框），两侧先答者胜、另一侧按 40405 收口。
  // 桩必须自己重建（T2 段删过 w1 的 agent；旁听表 `observed` 由 `session/created` 写入）。
  sockets.sessions.store.set('session-ext-w1',
    { id: 'session-ext-w1', session: hostSession('session-ext-w1', '/tmp/ext') });
  sockets.agents.set('session-ext-w1', makeAgent('session-ext-w1', '/tmp/ext'));
  for (const fn of handlers['session/created'] || []) {
    fn({ id: 'session-ext-w1', header: { cwd: '/tmp/ext' } });
  }
  await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w1' });
  // watched 外部会话的提问：双通道 + call_id 非空
  let extNative = 0;
  const extLane = makeNativeLane();
  const extHost = new AbortController();
  const extReq = { agent: sockets.agents.get('session-ext-w1'), signal: extHost.signal,
                   wait: { callId: 'call-ext-9' },
                   questions: [{ id: 'q1', question: '外部会话提问？',
                                 options: [{ label: 'A', description: '说明 A' }] }] };
  let extClaim = null;
  const extP = qHooks[0](extReq, () => { extNative += 1; return extLane.promise; });
  extP.then((v) => { extClaim = v; }, () => {});
  const stExt = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话：挂起标记带 call_id（平台 answerable=true）',
    stExt.interaction && stExt.interaction.call_id === 'call-ext-9', JSON.stringify(stExt.interaction));
  check('watched 外部会话：原生通道仍打开（dsh GUI 照旧弹框）', extNative === 1, String(extNative));
  const ansExt = await (await call(base, token, 'POST', '/answer',
    { session_id: 'session-ext-w1', call_id: 'call-ext-9',
      answers: [{ id: 'q1', selected: ['A'] }] })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('外部会话平台作答兑现认领（accepted=true，waterfall 返回值=平台作答）',
    ansExt.accepted === true && extClaim && extClaim.answers[0].selected[0] === 'A',
    JSON.stringify({ ansExt, extClaim }));
  // legacy 提问（无 `wait.callId`，阻塞式 `ask_user_question` 的默认形态）：认领标识必须与
  // 池内同口径回落到 `tool/call` 的真实 callId——只核 `wait.callId` 的那条在改前也恒真，
  // 这一条才是「平台 answerable=true」真正的回归面。
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-ext-w1' },
       { type: 'tool/call', seq: 95, time: Date.now(),
         data: { turn: 1, step: 1, callId: 'tc-ext-w1', name: 'ask_user_question', arguments: '{}' } });
  }
  let extLegacyNative = 0;
  qHooks[0]({ agent: sockets.agents.get('session-ext-w1'), signal: new AbortController().signal,
              questions: [{ id: 'q2', question: '外部 legacy 提问？' }] },
            () => { extLegacyNative += 1; return makeNativeLane().promise; })
    .then(() => {}, () => {});
  const stLegacy = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话 legacy 提问：无 wait.callId 也认领出真实 call_id（平台 answerable=true）',
    Boolean(stLegacy.interaction && stLegacy.interaction.call_id === 'tc-ext-w1'),
    JSON.stringify(stLegacy.interaction));
  const ansLegacy = await (await call(base, token, 'POST', '/answer',
    { session_id: 'session-ext-w1', call_id: 'tc-ext-w1',
      answers: [{ id: 'q2', selected: ['A'] }] })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('watched 外部会话 legacy 提问：平台作答同样兑现认领（原生通道也已打开）',
    ansLegacy.accepted === true && extLegacyNative === 1, JSON.stringify(ansLegacy));
  // 未 watch 的外部会话：行为不变（call_id 空、仍让位）
  sockets.sessions.store.set('session-ext-w2', { id: 'session-ext-w2',
    session: { id: 'session-ext-w2', header: { cwd: '/tmp/ext2' } } });
  sockets.agents.set('session-ext-w2', makeAgent('session-ext-w2', '/tmp/ext2'));
  for (const fn of handlers['session/created'] || []) {      // 旁听表入口（/live 的数据源）
    fn({ id: 'session-ext-w2', header: { cwd: '/tmp/ext2' } });
  }
  let rawNative = 0;
  qHooks[0]({ agent: sockets.agents.get('session-ext-w2'),
              signal: new AbortController().signal,
              questions: [{ id: 'q1', question: '未看管？' }] },
            () => { rawNative += 1; return makeNativeLane().promise; }).then(() => {}, () => {});
  const liveRaw = await (await call(base, token, 'GET', '/live')).json();
  const rawRow = (liveRaw.sessions || []).find((s) => s.session_id === 'session-ext-w2');
  check('未 watch 外部会话：call_id 仍为空（旁听语义回归）',
    Boolean(rawRow && rawRow.interaction && !rawRow.interaction.call_id),
    JSON.stringify(rawRow && rawRow.interaction));
  check('未 watch 外部会话：仍让位原生作答者', rawNative === 1, String(rawNative));
  sockets.agents.delete('session-ext-w2');

  // --- T3 竞速第三态（评审 Important 1 补测）：GUI 先答 ⇒ 平台迟到的 /answer 收口 ---
  // 设计 §4.4 明文：watched 外部会话两侧同题、**先答者胜**；原生通道（dsh GUI）胜出后平台
  // 若迟到，宿主 `userQuestions.answer` 对同一 callId 回 false ⇒ 驱动必须回 200 +
  // `accepted:false`（不是 404、不是 500），平台据此按 40405 放弃重试、不空转。
  // 改前 watched 外部会话一律走 `_lookup` 直接 404（本条迟到作答断言真红）；改后落在
  // `_answer` 的 `_liveAgent` 回落支——该支此前**零覆盖**。
  let extGuiNative = 0;
  let extGuiValue = null;
  const guiLane = makeNativeLane();
  qHooks[0]({ agent: sockets.agents.get('session-ext-w1'), signal: new AbortController().signal,
              wait: { callId: 'call-ext-gui' },
              questions: [{ id: 'q3', question: 'GUI 先答？', options: [{ label: 'G' }] }] },
            () => { extGuiNative += 1; return guiLane.promise; })
    .then((v) => { extGuiValue = v; }, () => {});
  const stGuiExt = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话：GUI 未答时平台侧同样挂起（双通道同显 + 认领标识）',
    Boolean(stGuiExt.interaction) && stGuiExt.interaction.call_id === 'call-ext-gui'
    && extGuiNative === 1,
    JSON.stringify({ interaction: stGuiExt.interaction, native: extGuiNative }));
  guiLane.resolve({ answers: [{ id: 'q3', selected: ['G'] }] });
  await new Promise((r) => setTimeout(r, 10));
  // 真宿主语义：GUI 作答后该提问从待答表移除 ⇒ 同 callId 再答必被拒。这里**显式记账**
  // （不调整桩默认返回），既有 6 个 /answer 调用点语义零漂移。
  sockets.nativeFulfilled.add('call-ext-gui');
  const stGuiMark = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话：GUI 先答 → waterfall 返回值=GUI 作答且平台挂起标记清除',
    Boolean(extGuiValue && extGuiValue.answers[0].selected[0] === 'G')
    && stGuiMark.interaction === null,
    JSON.stringify({ value: extGuiValue, interaction: stGuiMark.interaction }));
  const lateRes = await call(base, token, 'POST', '/answer',
    { session_id: 'session-ext-w1', call_id: 'call-ext-gui',
      answers: [{ id: 'q3', selected: ['A'] }] });
  const lateBody = await lateRes.json();
  check('watched 外部会话：GUI 先答后平台迟到 /answer → 200 + accepted=false（平台按 40405 收口）',
    lateRes.status === 200 && lateBody.accepted === false && lateBody.ok === true
    && lateBody.session_id === 'session-ext-w1',
    JSON.stringify({ status: lateRes.status, body: lateBody }));

  // --- 看管但宿主已无活 agent：/answer 走 404 原文案（同一回落支的另一半，此前零覆盖）---
  // brief Step 3「认领表未命中且无活 agent ⇒ 404 原文案」；文案与 /prompt·/steer 的分档
  // 文案**有意不统一**（控制者裁定留到 T8 一次性决定），故此处钉全串、不改写成「会话已结束」。
  sockets.agents.delete('session-ext-w1');
  const rAbsent = await call(base, token, 'POST', '/answer',
    { session_id: 'session-ext-w1', call_id: 'call-ext-unknown',
      answers: [{ id: 'q3', selected: ['A'] }] });
  const pAbsent = await rAbsent.json();
  check('watched 但宿主无活 agent：/answer 404 原文案（认领表未命中 ⇒ 不假受理）',
    rAbsent.status === 404 && pAbsent.error === '会话不在驱动池中: session-ext-w1',
    JSON.stringify({ status: rAbsent.status, body: pAbsent }));
  // 未看管但宿主有活 agent：/answer 同样不得直投（看管是唯一闸门）——补上评审点名的
  // `_answer` 守卫出口（`:1545-1547`，与上一条的认领未命中出口是两处不同的 `_lookup`），
  // 与 T2 段 `/prompt`·`/steer`·`/status` 三条「未看管一律 404」的第四条同款红线。
  sockets.agents.set('session-ext-w4', makeAgent('session-ext-w4', '/tmp/ext'));
  const answeredBefore = sockets.answered;
  const rLeak = await call(base, token, 'POST', '/answer',
    { session_id: 'session-ext-w4', call_id: 'call-ext-leak',
      answers: [{ id: 'q1', selected: ['X'] }] });
  const pLeak = await rLeak.json();
  check('未看管但宿主有活 agent：/answer 404 原文案且不递宿主（看管是唯一闸门）',
    rLeak.status === 404 && pLeak.error === '会话不在驱动池中: session-ext-w4'
    && sockets.answered === answeredBefore,
    JSON.stringify({ status: rLeak.status, body: pLeak, answered: sockets.answered }));
  sockets.agents.delete('session-ext-w4');

  // --- T4 审批双通道（C 批）：池外 + 平台看管 ⇒ 平台可代答 + 原生框照旧弹 ---
  // 审批链路与提问**同源**（`approval/request` 与 `user-questions/request` 走同一套
  // waterfall 转发）：改前 watched 外部会话的审批只让位（平台看不见、代答不了）；
  // T4 起与池内同款**双通道**——插件认领（平台 `/approval` 兑现 waterfall）**同时**
  // 原生链路照旧打开（dsh GUI 的审批框照常弹、照常可答），两侧先答者胜、另一侧收口。
  // 桩必须自己重建：T3 段删过 w1/w2 的宿主 agent；`/status` 的 interaction 读的是旁听表
  // `observed`（由 `session/created` 真处理器喂入），不是 sockets.sessions.store。
  const apHooks = handlers['approval/request'] || [];
  check('审批 waterfall 以 {prepend:true} 注册',
    apHooks.length >= 1 && (opts['approval/request'] || [])[0]
    && opts['approval/request'][0].prepend === true,
    JSON.stringify(opts['approval/request']));
  sockets.sessions.store.set('session-ext-w1',
    { id: 'session-ext-w1', session: hostSession('session-ext-w1', '/tmp/ext') });
  sockets.agents.set('session-ext-w1', makeAgent('session-ext-w1', '/tmp/ext'));
  for (const fn of handlers['session/created'] || []) {
    fn({ id: 'session-ext-w1', header: { cwd: '/tmp/ext' } });
  }
  await call(base, token, 'POST', '/watch', { session_id: 'session-ext-w1' });
  let apNative = 0;
  const apLane = makeNativeLane();
  const apHost = new AbortController();
  const apReq = { agent: sockets.agents.get('session-ext-w1'), toolName: 'bash',
                  callId: 'tc-ap-1', reason: 'rm -rf', signal: apHost.signal };
  let apLaneResult = null;
  const apP = apHooks[0](apReq, () => { apNative += 1; return apLane.promise; });
  apP.then((v) => { apLaneResult = v; }, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const stAp = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话审批：认领（挂起标记 answerable=true）且原生通道仍开',
    apNative === 1 && stAp.interaction && stAp.interaction.answerable === true
    && stAp.interaction.id, JSON.stringify({ apNative, mark: stAp.interaction }));
  check('watched 外部会话审批：挂起标记形状（kind/tool/call_id/reason 原样带出）',
    Boolean(stAp.interaction) && stAp.interaction.kind === 'approval'
    && stAp.interaction.tool === 'bash' && stAp.interaction.call_id === 'tc-ap-1'
    && stAp.interaction.reason === 'rm -rf', JSON.stringify(stAp.interaction));
  check('watched 外部会话审批：原生通道信号被替换（平台先答时 GUI 框才收得掉）',
    apReq.signal !== apHost.signal,
    JSON.stringify({ replaced: apReq.signal !== apHost.signal }));
  const apId = stAp.interaction ? stAp.interaction.id : '';
  const ap1 = await (await call(base, token, 'POST', '/approval',
    { session_id: 'session-ext-w1', approval_id: apId, decision: 'allowed-once' })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('平台代答审批兑现（accepted/allowed-once）并收起 GUI 框',
    ap1.ok === true && ap1.accepted === true && ap1.outcome === 'allowed-once'
    && apLaneResult === 'allowed-once' && apReq.signal.aborted === true,
    JSON.stringify({ ap1, apLaneResult, aborted: apReq.signal.aborted }));
  const stApAfter = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('平台代答审批后：挂起标记清除（/status interaction=null）',
    stApAfter.interaction === null, JSON.stringify(stApAfter.interaction));
  // GUI 先答（原生通道胜出）⇒ 平台侧挂起收口，迟到的 /approval 落 409（先答者胜）
  const guiApLane = makeNativeLane();
  let guiApValue = null;
  apHooks[0]({ agent: sockets.agents.get('session-ext-w1'), toolName: 'bash',
               callId: 'tc-ap-gui', signal: new AbortController().signal },
             () => guiApLane.promise).then((v) => { guiApValue = v; }, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const stGuiAp = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  const guiApId = stGuiAp.interaction ? stGuiAp.interaction.id : '';
  guiApLane.resolve('rejected');
  await new Promise((r) => setTimeout(r, 10));
  const stGuiAp2 = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话：GUI 先答 → waterfall 返回值=GUI outcome 且平台挂起标记清除',
    guiApValue === 'rejected' && stGuiAp2.interaction === null,
    JSON.stringify({ value: guiApValue, interaction: stGuiAp2.interaction }));
  const lateApRes = await call(base, token, 'POST', '/approval',
    { session_id: 'session-ext-w1', approval_id: guiApId, decision: 'allowed-once' });
  const lateAp = await lateApRes.json();
  check('watched 外部会话：GUI 先答后平台迟到 /approval → 409（认领已收口，不重复兑现）',
    lateApRes.status === 409 && lateAp.error === '当前没有等待中的审批（或已由 GUI 作答）',
    JSON.stringify({ status: lateApRes.status, body: lateAp }));
  // 非法 decision：外部支同样「先校验、再兑现」——不得把非法 outcome 递给宿主
  const apBadLane = makeNativeLane();
  const apBadReq = { agent: sockets.agents.get('session-ext-w1'), toolName: 'bash',
                     callId: 'tc-ap-bad', signal: new AbortController().signal };
  apHooks[0](apBadReq, () => apBadLane.promise).then(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const stBad = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  const badRes = await call(base, token, 'POST', '/approval',
    { session_id: 'session-ext-w1', approval_id: stBad.interaction && stBad.interaction.id,
      decision: 'bogus' });
  const badBody = await badRes.json();
  const stBad2 = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('watched 外部会话：/approval 非法 decision → 400 且不兑现（认领仍在）',
    badRes.status === 400 && Boolean(stBad2.interaction)
    && stBad2.interaction.kind === 'approval',
    JSON.stringify({ status: badRes.status, body: badBody, mark: stBad2.interaction }));
  const cancelAp = await (await call(base, token, 'POST', '/approval',
    { session_id: 'session-ext-w1', decision: 'cancelled' })).json();
  check('watched 外部会话：不带 approval_id 的 /approval 兑现当前在途认领（cancelled + 收框）',
    cancelAp.ok === true && cancelAp.accepted === true && cancelAp.outcome === 'cancelled'
    && apBadReq.signal.aborted === true,
    JSON.stringify({ body: cancelAp, aborted: apBadReq.signal.aborted }));
  await new Promise((r) => setTimeout(r, 10));
  // 审计帧**后到**的最坏顺序（真机主顺序是审计帧在前，见下）：认领期间宿主的
  // `approval/asked` 审计帧不得盖掉平台认领标记——它的 mark 既没有 `ap-<n>` 也没有
  // `answerable`，盖上去平台侧的作答按钮就消失了（读宿主 `dsh-user-approval/lib/index.js`
  // `request()`：先 append `approval/asked`、再跑 `approval/request` waterfall；观察者是
  // 提交后回调，顺序不保证 ⇒ 两条顺序都要成立）。
  const apAuditLane = makeNativeLane();
  const apAuditReq = { agent: sockets.agents.get('session-ext-w1'), toolName: 'bash',
                       callId: 'tc-ap-audit', signal: new AbortController().signal };
  apHooks[0](apAuditReq, () => apAuditLane.promise).then(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const stBeforeAudit = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-ext-w1' },
       { type: 'approval/asked', seq: 201, time: Date.now(),
         data: { id: 'ap-host-201', toolName: 'bash', reason: '宿主审计帧' } });
  }
  const stAfterAudit = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('认领期间宿主 approval/asked 审计帧不覆盖认领标记（id/answerable 保持平台口径）',
    Boolean(stAfterAudit.interaction) && stAfterAudit.interaction.answerable === true
    && stAfterAudit.interaction.id === (stBeforeAudit.interaction && stBeforeAudit.interaction.id)
    && stAfterAudit.interaction.reason === ''
    && stAfterAudit.interaction.call_id === 'tc-ap-audit',
    JSON.stringify({ before: stBeforeAudit.interaction, after: stAfterAudit.interaction }));
  const auditAp = await (await call(base, token, 'POST', '/approval',
    { session_id: 'session-ext-w1', decision: 'rejected' })).json();
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-ext-w1' },
       { type: 'approval/decided', seq: 202, time: Date.now(),
         data: { id: 'ap-host-201', outcome: 'rejected' } });
  }
  const stAfterDecided = await (await call(base, token, 'GET', '/status?session_id=session-ext-w1')).json();
  check('审批兑现后 decided 审计帧照旧收口（平台侧不残留 waiting）',
    auditAp.ok === true && auditAp.outcome === 'rejected' && stAfterDecided.interaction === null,
    JSON.stringify({ body: auditAp, interaction: stAfterDecided.interaction }));
  // 未 watch 的外部会话：仍让位（回归）——宿主**有**活 agent 也不行（看管是唯一闸门），
  // 且请求对象上的 signal 不得被替换（= `_openNativeLane` 没被调用，一个字节没动）。
  sockets.agents.set('session-ext-w2', makeAgent('session-ext-w2', '/tmp/ext2'));
  let apRawNative = 0;
  const apRawLane = makeNativeLane();
  const apRawHost = new AbortController();
  const apRawReq = { agent: sockets.agents.get('session-ext-w2'), toolName: 'bash',
                     callId: 'tc-ap-raw', signal: apRawHost.signal };
  apHooks[0](apRawReq, () => { apRawNative += 1; return apRawLane.promise; })
    .then(() => {}, () => {});
  check('未 watch 外部会话审批：原样让位（回归）', apRawNative === 1, String(apRawNative));
  check('未 watch 外部会话审批：看管为唯一闸门（不认领 + signal 未被替换）',
    driver._isWatched('session-ext-w2') === false && apRawNative === 1
    && apRawReq.signal === apRawHost.signal
    && !(driver.approvals && driver.approvals.has('session-ext-w2')),
    JSON.stringify({ watched: driver._isWatched('session-ext-w2'), native: apRawNative,
                     replaced: apRawReq.signal !== apRawHost.signal }));
  const rawApRes = await call(base, token, 'POST', '/approval',
    { session_id: 'session-ext-w2', decision: 'allowed-once' });
  const rawAp = await rawApRes.json();
  check('未 watch 外部会话：/approval 404 原文案（看管是唯一闸门，不假受理）',
    rawApRes.status === 404 && rawAp.error === '会话不在驱动池中: session-ext-w2',
    JSON.stringify({ status: rawApRes.status, body: rawAp }));
  sockets.agents.delete('session-ext-w2');

  // --- T4 核心交付：`_dropClaims` 收口「看管中会话被 disposed」一态 ---
  // 提问侧在途认领的 **abort** 一态 T3 已由通用 hostSignal 收口；**disposed** 一态此前
  // 无人清理（T3 明文留给 T4 的 `_dropClaims`）：会话销毁后认领悬挂在表里 ⇒ 宿主 `ask()`
  // 永远等不到结果、挂起标记残留。这里把提问与审批两条链的在途认领一并钉死。
  const w5 = 'session-ext-w5';
  sockets.sessions.store.set(w5, { id: w5, session: hostSession(w5, '/tmp/ext5') });
  sockets.agents.set(w5, makeAgent(w5, '/tmp/ext5'));
  for (const fn of handlers['session/created'] || []) {
    fn({ id: w5, header: { cwd: '/tmp/ext5' } });
  }
  await call(base, token, 'POST', '/watch', { session_id: w5 });
  let w5Q = null;
  let w5QErr = null;
  let w5Ap = null;
  let w5ApErr = null;
  let w5QNative = 0;
  let w5ApNative = 0;
  qHooks[0]({ agent: sockets.agents.get(w5), signal: new AbortController().signal,
              wait: { callId: 'call-drop-1' },
              questions: [{ id: 'q1', question: '会话被销毁前在途的提问？' }] },
            () => { w5QNative += 1; return makeNativeLane().promise; })
    .then((v) => { w5Q = v; }, (e) => { w5QErr = e; });
  apHooks[0]({ agent: sockets.agents.get(w5), toolName: 'bash', callId: 'tc-drop-1',
               signal: new AbortController().signal },
             () => { w5ApNative += 1; return makeNativeLane().promise; })
    .then((v) => { w5Ap = v; }, (e) => { w5ApErr = e; });
  await new Promise((r) => setTimeout(r, 10));
  for (const fn of handlers['session/disposed'] || []) fn({ id: w5 });
  await new Promise((r) => setTimeout(r, 10));
  check('disposed 收口：在途提问认领被 reject 且摘表（原生通道同样已打开）',
    Boolean(w5QErr) && w5Q === null && w5QNative === 1
    && !driver.questions.has('call-drop-1'),
    JSON.stringify({ rejected: Boolean(w5QErr), value: w5Q, native: w5QNative,
                     held: driver.questions.has('call-drop-1') }));
  check('disposed 收口：在途审批认领被 reject 且摘表（原生通道同样已打开）',
    Boolean(w5ApErr) && w5Ap === null && w5ApNative === 1 && driver.approvals
    && !driver.approvals.has(w5),
    JSON.stringify({ rejected: Boolean(w5ApErr), value: w5Ap, native: w5ApNative,
                     held: Boolean(driver.approvals && driver.approvals.has(w5)) }));
  const stDropped = await (await call(base, token, 'GET', `/status?session_id=${w5}`)).json();
  check('disposed 收口：看管声明与挂起标记同步清除（/status 回 404 原文案）',
    driver._isWatched(w5) === false && stDropped.error === `会话不在驱动池中: ${w5}`,
    JSON.stringify({ watched: driver._isWatched(w5), status: stDropped }));
  sockets.agents.delete(w5);

  // --- T4：`dispose()` 一态同样收口在途认领（brief 写的 `stop()` 不存在，真实失活口=dispose）---
  // 用独立实例（`withDriver` 自带桩 ctx + 临时服务，收尾时由它调 `driver.dispose()`）：
  // 插件停用/热重载时在途审批认领必须 reject 收口，否则宿主审批 waterfall 永久悬挂。
  let dispoErr = null;
  let dispoDriver = null;
  const dispoSid = 'session-ext-w6';
  await withDriver(null, async ({ driver: d2, base: b2, token: t2, sockets: s2, handlers: h2 }) => {
    dispoDriver = d2;
    s2.agents.set(dispoSid, makeAgent(dispoSid, '/tmp/ext6'));
    await call(b2, t2, 'POST', '/watch', { session_id: dispoSid });
    h2['approval/request'][0]({ agent: s2.agents.get(dispoSid), toolName: 'bash',
                                signal: new AbortController().signal },
                              () => makeNativeLane().promise)
      .then(() => {}, (e) => { dispoErr = e; });
    await new Promise((r) => setTimeout(r, 10));
  });
  check('dispose() 收口：在途审批认领被 reject（插件停用不悬挂）',
    Boolean(dispoErr) && dispoDriver.approvals && dispoDriver.approvals.size === 0,
    JSON.stringify({ rejected: Boolean(dispoErr),
                     held: dispoDriver.approvals ? dispoDriver.approvals.size : null }));

  // --- 释放 ---
  await call(base, token, 'POST', '/dispose', { session_id: sid });
  check('dispose → handle.dispose() 且移出池',
    sockets.disposed.includes(sid) && !driver.sessions.has(sid)
    && driver.sessions.has(other));

  // P7a 缺陷 B：接管条目（handle=null）dispose 只出池，**不销毁宿主会话**——
  // 句柄归宿主 fork 调用方作用域，本插件没有销毁能力；语义=fork 分支留在 dsh 侧可继续用。
  const hostAgent = sockets.agents.get(forkSid);
  const disposedBefore = sockets.disposed.length;
  await call(base, token, 'POST', '/dispose', { session_id: forkSid });
  check('接管条目 dispose 只出池：不碰宿主会话，宿主 agent 仍在',
    !driver.sessions.has(forkSid) && sockets.agents.get(forkSid) === hostAgent
    && sockets.disposed.length === disposedBefore,
    JSON.stringify({ inPool: driver.sessions.has(forkSid),
                     hostAlive: sockets.agents.get(forkSid) === hostAgent,
                     extraDisposed: sockets.disposed.length - disposedBefore }));

  await driver.dispose();
  check('driver.dispose() 后不再注册路由', getHandler() === null);
  server.close();

  console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(1); });
