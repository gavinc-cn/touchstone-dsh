/**
 * 面板消息桥自检（不经 dsh、不经浏览器）：桩 DOM + 桩 React + 桩 ctx 驱动**真实产物**
 * lib/client.bundle.js，把 2026-10-04 加的「在 dsh 界面打开卡片主会话」桥钉死：
 *   ① 探针应答：能力位由 uiWorkspace 是否就绪决定（未就绪 false ⇒ SPA 侧按钮不渲染）；
 *   ② 打开请求：调 uiWorkspace.openSession(sid) 并关掉全屏面板（弹出语义）；
 *   ③ 拒绝面：来源窗口不是本面板 iframe / 异源 / sid 为空 / openSession 抛错 —— 一律不动作，
 *      失败时面板保持打开（用户视角仍停在自己刚点的卡片上）；
 *   ④ 生命周期：面板关闭即解绑 message 监听（不留悬挂监听）。
 * 协议常量与 SPA 半 webui/src/lib/dshHost.js 逐字一致（那边由
 * webui/src/__tests__/dshHost.test.js 覆盖）。
 *
 * 用法: node scripts/dev-check-bridge.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：这条桥横跨「宿主页 window 的 message 事件」「同源 iframe 的 contentWindow」
 * 「dsh 客户端服务 uiWorkspace」三个面，真机复现要起 dsh 实例 + 真开面板 + 真点按钮；
 * 而三处逻辑都是纯事件处理，桩里可以逐条钉死。真浏览器那一档另由隔离 dsh 实例的
 * Playwright e2e（tests/）覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundlePath = path.join(root, 'lib', 'client.bundle.js');
const ORIGIN = 'http://localhost:4601'; // 面板 iframe 与宿主同源（/touchstone 前缀反代同一站点）

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

// ── 最小 DOM：事件目标（记录监听器 + 派发）+ localStorage + iframe 元素 ──────────
/** 造一个事件目标：监听器按注册顺序保存，支持 capture 标记与 listenerCount 观测。 */
function makeTarget(name) {
  const listeners = [];
  return {
    name,
    listeners,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    listenerCount(type) { return listeners.filter((l) => l.type === type).length; },
    /** 派发一条事件（默认 keydown；message 桥用例显式传 type/data/origin/source）。 */
    dispatch(event) {
      const e = {
        type: 'keydown',
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { e.defaultPrevented = true; },
        stopPropagation() { e.propagationStopped = true; },
        ...event,
      };
      for (const l of [...listeners]) if (l.type === e.type) l.fn(e);
      return e;
    },
  };
}

/** 造假 localStorage（只存字符串；面板开合状态写在 'ts.plugin.open'）。 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

// ── 最小 React：足够跑 Toggle / Panel 的 hooks（同一组件内顺序稳定即可） ────────
/** 造 mini React + 渲染器：createElement / useState / useEffect / useRef。 */
function makeMiniReact() {
  let index = 0;
  const runtime = { values: [], effects: [], pending: [] };
  /** 造 iframe 元素：除事件目标外带同源 contentDocument 与 contentWindow（桥的 e.source 判定面）。 */
  const makeIframe = () => {
    const el = Object.assign(makeTarget('iframe'), { type: 'iframe', props: {}, children: [] });
    el.clientHeight = 800;
    el.contentDocument = makeTarget('iframe-document');
    const win = makeTarget('iframe-window');
    win.posted = [];
    win.postMessage = (msg, targetOrigin) => { win.posted.push({ msg, targetOrigin }); };
    el.contentWindow = win;
    return el;
  };
  const React = {
    createElement(type, props, ...children) {
      // 元素本身也做成事件目标（Panel 会对 iframe 元素挂 'load'）
      const el = type === 'iframe'
        ? makeIframe()
        : Object.assign(makeTarget(String(type)), { type, props: {}, children: [] });
      el.props = { ...(props || {}) };
      el.children = children;
      if (props && props.ref && typeof props.ref === 'object') props.ref.current = el;
      return el;
    },
    useState(initial) {
      const i = index++;
      if (!(i in runtime.values)) runtime.values[i] = typeof initial === 'function' ? initial() : initial;
      return [runtime.values[i], (v) => { runtime.values[i] = v; }];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in runtime.values)) runtime.values[i] = { current: initial };
      return runtime.values[i];
    },
    useEffect(fn, deps) {
      const i = index++;
      runtime.pending.push({ i, fn, deps });
    },
  };
  /** 渲染一个函数组件（同一 runtime 内 hooks 顺序必须稳定），返回元素树。 */
  const render = (component, props) => {
    index = 0;
    runtime.pending = [];
    const tree = component(props || {});
    for (const { i, fn, deps } of runtime.pending) {
      const prev = runtime.effects[i];
      const changed = !prev || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => d !== prev.deps[k]);
      if (!changed) continue;
      if (prev && prev.cleanup) prev.cleanup();
      const cleanup = fn();
      runtime.effects[i] = { deps: deps || [], cleanup: typeof cleanup === 'function' ? cleanup : null };
    }
    return tree;
  };
  /** 卸载：跑掉所有 effect cleanup（模拟组件被换下）。 */
  const unmount = () => {
    for (const slot of runtime.effects) if (slot && slot.cleanup) slot.cleanup();
    runtime.effects = [];
  };
  return { React, render, unmount };
}

/**
 * 搭一套完整环境：载入真实产物 + 桩 DOM/React/ctx，并把 apply 跑起来。
 * @param uiWorkspace - 桩 uiWorkspace 服务；undefined=宿主半没拿到服务（能力位应为 false）。
 * @param openSessionError - 传 Error 时 openSession 抛该错（覆盖失败路径）。
 * @returns 该环境下所有可观测面。
 */
function setup({ uiWorkspace, openSessionError = null } = {}) {
  const src = fs.readFileSync(bundlePath, 'utf8');
  // 预置面板已打开：Panel 在挂载时才挂 iframe/消息桥，开合状态本来就是记忆值
  const storage = makeStorage({ 'ts.plugin.open': '1' });
  const hostDoc = makeTarget('host-document');
  const fakeWindow = makeTarget('host-window');
  fakeWindow.location = { origin: ORIGIN };
  fakeWindow.parent = fakeWindow; // 插件在宿主页顶层跑，无父窗口
  let factory = null;
  fakeWindow.__ModuleLoader__ = { load: (mod) => { factory = mod.factory; } };
  // 产物是浏览器脚本：`window.__ModuleLoader__.load(...)` 在 Function 作用域里求值
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', src)(fakeWindow, hostDoc, storage);
  if (!factory) throw new Error('bundle 未向 __ModuleLoader__ 注册 factory');

  const mini = makeMiniReact();
  const ex = factory((n) => { if (n === 'react') return mini.React; throw new Error('unexpected require ' + n); });
  const rec = { slots: [], injected: [] };
  const service = uiWorkspace === undefined ? null : {
    calls: [],
    openSession(sid) {
      if (openSessionError) throw openSessionError;
      this.calls.push(sid);
    },
    ...(uiWorkspace || {}),
  };
  const slotsStub = {
    entries: () => [],
    inject: (_name, fn) => { fn(); return () => {}; },
    register: (meta, comp) => { rec.slots.push({ meta, comp }); return () => {}; },
  };
  const ctx = {
    get: (name) => (name === 'slots' ? slotsStub : undefined),
    effect: (fn) => { const cleanup = fn(); return cleanup; },
    inject: (names, cb) => {
      if (names.includes('uiWorkspace')) {
        rec.injected.push(names.join(','));
        if (service) cb({ uiWorkspace: service }); // 服务缺席 = 真机「inject 永不回调」
      }
      return { dispose() {} };
    },
  };
  ex.apply(ctx);
  return { ex, rec, mini, storage, hostDoc, fakeWindow, service };
}

/** 取出某 slot 的组件树（slot 注册的是包装组件，需再求值一层拿到 Panel 树）。
 * 渲染产物与 iframe 窗口句柄一并记回 env（panelMessage 要按它造 e.source）。 */
function renderPanel(env) {
  const entry = env.rec.slots.find((s) => s.meta.id === 'touchstone-panel');
  const wrapped = entry.comp({});
  const tree = env.mini.render(wrapped.type, wrapped.props);
  const iframeEl = tree && Array.isArray(tree.children)
    ? tree.children.find((c) => c && c.type === 'iframe') : null;
  env.iframeEl = iframeEl;
  env.iframeWin = iframeEl ? iframeEl.contentWindow : null;
  return { wrapped, tree, iframeEl, iframeWin: env.iframeWin };
}

/** 从 iframe（或指定来源）派发一条面板消息到宿主页。 */
function panelMessage(env, data, over = {}) {
  return env.fakeWindow.dispatch({
    type: 'message', data, origin: ORIGIN, source: env.iframeWin, ...over,
  });
}

const openFlag = (storage) => storage.getItem('ts.plugin.open');

// ── 用例 ─────────────────────────────────────────────────────────────────────
function caseProbe() {
  console.log('== ① 探针应答：能力位跟着 uiWorkspace 就绪走 ==');
  const env = setup({ uiWorkspace: {} });
  const { iframeWin } = renderPanel(env);
  check('面板打开即挂 message 监听', env.fakeWindow.listenerCount('message') === 1,
    String(env.fakeWindow.listenerCount('message')));
  check('inject 了 uiWorkspace 服务', env.rec.injected.includes('uiWorkspace'),
    JSON.stringify(env.rec.injected));

  panelMessage(env, { type: 'touchstone:host-probe' });
  check('探针 → 应答同源 caps{openSession:true}', iframeWin.posted.length === 1
    && iframeWin.posted[0].msg.type === 'touchstone:host-caps'
    && iframeWin.posted[0].msg.caps.openSession === true
    && iframeWin.posted[0].targetOrigin === ORIGIN,
  JSON.stringify(iframeWin.posted));

  // 服务缺席（旧 dsh / ui-workspace 插件没装）：应答能力位 false，SPA 侧按钮不渲染
  const env2 = setup({});
  const { iframeWin: iframeWin2 } = renderPanel(env2);
  panelMessage(env2, { type: 'touchstone:host-probe' });
  check('uiWorkspace 缺席 → caps{openSession:false}',
    iframeWin2.posted.length === 1 && iframeWin2.posted[0].msg.caps.openSession === false,
    JSON.stringify(iframeWin2.posted));
}

function caseOpen() {
  console.log('== ② 打开请求：调 uiWorkspace.openSession + 关面板 ==');
  const env = setup({ uiWorkspace: {} });
  const { wrapped, iframeWin } = renderPanel(env);
  panelMessage(env, { type: 'touchstone:open-session', sid: 'sess-abc' });
  check('openSession 收到会话 id', env.service.calls.length === 1 && env.service.calls[0] === 'sess-abc',
    JSON.stringify(env.service.calls));
  check('面板已关闭（开合状态落 0）', openFlag(env.storage) === '0', String(openFlag(env.storage)));
  const tree = env.mini.render(wrapped.type, wrapped.props);
  check('重渲染返回 null（浮层消失，露出 dsh 主界面）', tree === null || tree === undefined, String(tree));
  check('没有多余的回包（打开请求只调服务，不回应答）', iframeWin.posted.length === 0,
    JSON.stringify(iframeWin.posted));
}

function caseReject() {
  console.log('== ③ 拒绝面：来源/异源/sid/异常都不动作 ==');
  // 来源不是本面板 iframe（宿主页里别的插件窗口、或父页自身）
  const env1 = setup({ uiWorkspace: {} });
  renderPanel(env1);
  panelMessage(env1, { type: 'touchstone:open-session', sid: 'sess-abc' }, { source: makeTarget('other-window') });
  check('非本 iframe 来源 → 不调服务、不关面板',
    env1.service.calls.length === 0 && openFlag(env1.storage) === '1',
    `${JSON.stringify(env1.service.calls)} / ${openFlag(env1.storage)}`);

  // 异源（跨站 iframe 伪造同款消息）
  const env2 = setup({ uiWorkspace: {} });
  renderPanel(env2);
  panelMessage(env2, { type: 'touchstone:open-session', sid: 'sess-abc' }, { origin: 'http://evil.test' });
  check('异源消息 → 不调服务、不关面板',
    env2.service.calls.length === 0 && openFlag(env2.storage) === '1',
    `${JSON.stringify(env2.service.calls)} / ${openFlag(env2.storage)}`);

  // sid 形状不对（空串/非字符串）
  const env3 = setup({ uiWorkspace: {} });
  renderPanel(env3);
  panelMessage(env3, { type: 'touchstone:open-session', sid: '   ' });
  panelMessage(env3, { type: 'touchstone:open-session', sid: 42 });
  panelMessage(env3, { type: 'touchstone:open-session' });
  check('sid 为空/非字符串 → 不调服务、不关面板',
    env3.service.calls.length === 0 && openFlag(env3.storage) === '1',
    `${JSON.stringify(env3.service.calls)} / ${openFlag(env3.storage)}`);

  // 服务在但打不开（会话不存在/已归档）：留在面板里，用户视角不停在自己的卡片上
  const env4 = setup({ uiWorkspace: {}, openSessionError: new Error('session archived') });
  renderPanel(env4);
  const warns = [];
  const nativeWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  panelMessage(env4, { type: 'touchstone:open-session', sid: 'sess-gone' });
  console.warn = nativeWarn;
  check('openSession 抛错 → 面板保持打开且只 warn',
    openFlag(env4.storage) === '1' && warns.length === 1 && warns[0].includes('在 dsh 打开会话失败'),
    `${openFlag(env4.storage)} / ${warns.length}`);

  // 服务缺席时收到打开请求：静默忽略（SPA 侧按钮本就不渲染，防旧前端/手搓消息）
  const env5 = setup({});
  renderPanel(env5);
  panelMessage(env5, { type: 'touchstone:open-session', sid: 'sess-abc' });
  check('uiWorkspace 缺席 → 忽略打开请求且不关面板', openFlag(env5.storage) === '1',
    String(openFlag(env5.storage)));
}

function caseLifecycle() {
  console.log('== ④ 生命周期：面板卸载即解绑 ==');
  const env = setup({ uiWorkspace: {} });
  renderPanel(env);
  check('挂载后 1 条 message 监听', env.fakeWindow.listenerCount('message') === 1,
    String(env.fakeWindow.listenerCount('message')));
  env.mini.unmount();
  check('卸载后 0 条（不留悬挂监听）', env.fakeWindow.listenerCount('message') === 0,
    String(env.fakeWindow.listenerCount('message')));
}

caseProbe();
caseOpen();
caseReject();
caseLifecycle();

console.log(failures ? `\nOVERALL: FAIL (${failures} 项失败)` : '\nOVERALL: PASS');
process.exit(failures ? 1 : 0);
