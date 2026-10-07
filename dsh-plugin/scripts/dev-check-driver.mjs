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
  // 宿主落盘归档集后广播 `domain/changed`（真机由 domain 存储层发出；桩同步触发，
  // 用来验证驱动「事件为主」的推帧路径）
  const fireDomainChanged = () => {
    for (const fn of handlers['domain/changed'] || []) {
      try { fn({ domain: 'workspace', table: '', operation: 'put' }); } catch { /* 桩忽略 */ }
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
    async archiveSession(sid, options) {
      sockets.archiveCalls.push(['archive', sid, !!(options && options.stopActivity)]);
      if (this.archived.includes(sid)) return;
      if (!this.knownSessions.has(sid)) {
        const err = new Error(`cannot archive session '${sid}': no such session`);
        err.name = 'WorkspaceUnknownSessionError';
        throw err;
      }
      this.archived.push(sid);
      fireDomainChanged();
    },
    async unarchiveSession(sid) {
      sockets.archiveCalls.push(['unarchive', sid]);
      if (!this.archived.includes(sid)) return;
      this.archived = this.archived.filter((x) => x !== sid);
      fireDomainChanged();
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
          return callId !== 'gone';
        } };
      }
      if (name === 'sessionPersistence') return {};
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
  // 平台自持会话（池内 sid）：插件认领——不调用 next()，返回待兑现 Promise
  let nativeNext = 0;
  let claimResult = null;
  const claimPromise = qHooks[0](
    { agent: sockets.agents.get(sid), wait: { callId: 'call-1' },
      signal: new AbortController().signal,
      questions: [{ id: 'q1', header: 'H', question: 'Q?', detail: 'D',
                    options: [{ label: 'A', description: '选项 A 说明' }] }] },
    () => { nativeNext += 1; return Promise.resolve({ answers: [{ id: 'q1', selected: ['native'] }] }); },
  );
  claimPromise.then((v) => { claimResult = v; }, () => {});
  const st3 = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('提问 → interaction 标记（含 call_id 与逐题）',
    st3.interaction && st3.interaction.call_id === 'call-1'
    && st3.interaction.questions[0].options[0].label === 'A'
    && st3.interaction.questions[0].options[0].description === '选项 A 说明'
    && st3.interaction.questions[0].detail === 'D',
    JSON.stringify(st3.interaction));
  check('平台自持会话：插件认领（不 next()，原生作答者不参与）', nativeNext === 0,
    `next 调用次数=${nativeNext}`);

  // --- 作答：认领中的提问由 /answer 兑现（waterfall 返回值 = 平台作答）---
  const ans = await (await call(base, token, 'POST', '/answer',
    { session_id: sid, call_id: 'call-1', answers: [{ id: 'q1', selected: ['A'] }] })).json();
  await new Promise((r) => setTimeout(r, 10));
  check('作答 → 兑现认领（accepted=true，waterfall 返回值=平台作答）',
    ans.accepted === true && claimResult
    && claimResult.answers[0].selected[0] === 'A',
    JSON.stringify({ ans, claimResult }));
  const afterAnswer = await (await call(base, token, 'GET', `/status?session_id=${sid}`)).json();
  check('作答后挂起标记清除（平台不残留 pending）',
    afterAnswer.interaction === null, JSON.stringify(afterAnswer.interaction));
  const gone = await call(base, token, 'POST', '/answer',
    { session_id: sid, call_id: 'gone', answers: [] });
  const goneBody = await gone.json();
  check('已过期提问 accepted=false（平台据此按 40405 放弃重试）',
    gone.status === 200 && goneBody.accepted === false);

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

  // --- tool/call + tool/result：真实 callId 配提问、结果到达清挂起（外部会话收口）---
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 'session-external-1' },
       { type: 'tool/call', seq: 90, time: Date.now(),
         data: { turn: 1, step: 1, callId: 'tc-ext-1', name: 'ask_user_question', arguments: '{}' } });
    fn({ id: sid },
       { type: 'tool/call', seq: 91, time: Date.now(),
         data: { turn: 1, step: 1, callId: 'tc-pool-1', name: 'ask_user_question', arguments: '{}' } });
  }
  // 池内会话：legacy 提问（无 wait.callId）用真实 tool callId 作提问标识
  const poolPromise = qHooks[0](
    { agent: sockets.agents.get(sid), signal: new AbortController().signal,
      questions: [{ id: 'qp', question: '池内？', options: [{ label: 'P' }] }] },
    () => Promise.resolve({ answers: [] }),
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
  const unknownAr = await call(base, token, 'POST', '/archive',
                               { session_id: 'session-99999999-9999-9999-9999-999999999999',
                                 archived: true });
  check('未知会话归档 → 410（平台跳过该 sid 放行卡片）', unknownAr.status === 410,
    String(unknownAr.status));

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
