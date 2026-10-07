/**
 * 客户端快捷键自检（不经 dsh、不经浏览器）：桩 DOM + 桩 shortcuts 服务驱动**真实产物**
 * lib/client.bundle.js，把 2026-10-04 加的两条通道钉死：
 *   ① 官方注册面：命令 id/别名/regions/modals/键位矩阵（desktop 三档纯 Alt+T；
 *      Web 只声明 dsh 白名单放行的 primary+alt+T，web:linux 不声明）；
 *   ② 插件自管 Alt+T：宿主页与面板 iframe 两侧都要能开关，且只认精确 Alt+T；
 *   ③ 兜底：官方 register() 抛错时面板照常注册、自管键照常可用。
 *
 * 用法: node scripts/dev-check-shortcuts.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：快捷键的两条通道横跨「dsh 服务（官方注册表）」「宿主页 document」
 * 「同源 iframe document」三个面，真机复现成本高（要起 dsh 实例 + 真按键），而
 * 这三处逻辑全是纯函数 + 事件监听，桩里可以逐条钉死；真浏览器那一档另由
 * tests/e2e_plugin_shortcut.py（Playwright，隔离 dsh 实例）覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundlePath = path.join(root, 'lib', 'client.bundle.js');

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
    /** 派发一条事件，返回带 preventDefault/stopPropagation 痕迹的事件对象。 */
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

/** 造一个假 iframe 元素：除事件目标外带 contentDocument（同源可达）。 */
function makeIframe() {
  const el = makeTarget('iframe');
  el.clientHeight = 800;
  el.contentDocument = makeTarget('iframe-document');
  return el;
}

/** 造假 localStorage（只存字符串；setOpen 会写 'ts.plugin.open'）。 */
function makeStorage() {
  const map = new Map();
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
  const React = {
    createElement(type, props, ...children) {
      // 元素本身也做成事件目标（Panel 会对 iframe 元素挂 'load'），iframe 另带 contentDocument
      const el = Object.assign(makeTarget(String(type)), { type, props: { ...(props || {}) }, children });
      if (type === 'iframe') { el.clientHeight = 800; el.contentDocument = makeTarget('iframe-document'); }
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

// ── 桩 shortcuts 服务（面与真机一致：runtime/platform/catalog/register） ────────
/** 造 shortcuts 服务；catalogRow 给 null 表示本命令未注册/无绑定。 */
function makeShortcuts({ runtime = 'web', platform = 'windows', catalogRow = null, registerError = null } = {}) {
  const service = {
    runtime,
    platform,
    registered: [],
    catalog: { getSnapshot: () => (catalogRow ? [catalogRow] : []) },
    register(command) {
      if (registerError) throw registerError;
      service.registered.push(command);
      return () => { service.registered = service.registered.filter((c) => c !== command); };
    },
  };
  return service;
}

/** 一条 keydown 事件模板（默认就是精确 Alt+T）。 */
const key = (over = {}) => ({ code: 'KeyT', key: 't', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, ...over });

/** 造桩 ctx：slots 立即回调、shortcuts 走 ctx.inject、effect 收集 disposer。 */
function makeCtx({ shortcuts = null, injectShortcuts = true } = {}) {
  const rec = { slots: [], effects: [], scopedEffects: [] };
  const slotsStub = {
    entries: () => [],
    inject: (_name, fn) => { fn(); return () => {}; },
    register: (meta, comp) => { rec.slots.push({ meta, comp }); return () => {}; },
  };
  const scoped = {
    shortcuts,
    effect: (fn, label) => { const cleanup = fn(); rec.scopedEffects.push({ cleanup, label }); return cleanup; },
  };
  const ctx = {
    get: (name) => (name === 'slots' ? slotsStub : undefined),
    effect: (fn) => { const cleanup = fn(); rec.effects.push(cleanup); return cleanup; },
    inject: (names, cb) => {
      if (injectShortcuts && names.includes('shortcuts')) cb(scoped);
      return { dispose() {} };
    },
  };
  return { ctx, rec };
}

/**
 * 搭一套完整环境：载入真实产物 + 桩 DOM/React/ctx，并把 apply 跑起来。
 * @param applyIt - false 时只搭环境不 apply（供「apply 抛错」用例自行调用）。
 * @returns 该环境下所有可观测面（storage / hostDoc / slots / mini React / shortcuts）。
 */
function setup({ shortcuts = null, registerError = null, runtime = 'web', platform = 'windows', catalogRow = null, applyIt = true } = {}) {
  const src = fs.readFileSync(bundlePath, 'utf8');
  const storage = makeStorage();
  const hostDoc = makeTarget('host-document');
  let factory = null;
  // 宿主页 window 桩：除 __ModuleLoader__ 外要有真 window 的事件面（面板打开时消息桥会挂
  // message 监听，见 dev-check-bridge.mjs）与 location/parent（探针只认同源 origin）
  const fakeWindow = makeTarget('host-window');
  fakeWindow.location = { origin: 'http://localhost:4601' };
  fakeWindow.parent = fakeWindow;
  fakeWindow.__ModuleLoader__ = { load: (mod) => { factory = mod.factory; } };
  // 产物是浏览器脚本：`window.__ModuleLoader__.load(...)` 在 Function 作用域里求值
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', src)(fakeWindow, hostDoc, storage);
  if (!factory) throw new Error('bundle 未向 __ModuleLoader__ 注册 factory');

  const mini = makeMiniReact();
  const ex = factory((n) => { if (n === 'react') return mini.React; throw new Error('unexpected require ' + n); });
  const svc = shortcuts || makeShortcuts({ runtime, platform, catalogRow, registerError });
  const { ctx, rec } = makeCtx({ shortcuts: svc });
  if (applyIt) ex.apply(ctx);
  return { ex, svc, ctx, rec, mini, storage, hostDoc };
}

/** 取出某个 slot 注册的组件；slot 注册的是包装组件（() => h(Panel)），需再求值一层。 */
function slotComponent(rec, id) {
  const entry = rec.slots.find((s) => s.meta.id === id);
  if (!entry) return null;
  return entry.comp({});
}

/** 打开面板（自管 Alt+T）→ 渲染 Panel → 返回 iframe 文档句柄。 */
function openPanel(env) {
  env.hostDoc.dispatch(key());
  const wrapped = slotComponent(env.rec, 'touchstone-panel');
  const tree = env.mini.render(wrapped.type, wrapped.props);
  const iframeEl = tree && Array.isArray(tree.children)
    ? tree.children.find((c) => c && c.type === 'iframe') : null;
  const iframeDoc = iframeEl && iframeEl.props.ref && iframeEl.props.ref.current
    ? iframeEl.props.ref.current.contentDocument : null;
  return { wrapped, tree, iframeEl, iframeDoc };
}

/** 重渲染面板（模拟 React 状态变化后的那次 render）。 */
function rerenderPanel(env, wrapped) {
  return env.mini.render(wrapped.type, wrapped.props);
}

const openState = (storage) => storage.getItem('ts.plugin.open');

// ── 用例 ─────────────────────────────────────────────────────────────────────
function caseOfficialRegistration() {
  console.log('== ① 官方快捷键注册面 ==');
  const env = setup();
  const { rec, svc, storage, hostDoc } = env;

  check('两个 UI 槽照常注册', rec.slots.length === 2
    && rec.slots.some((s) => s.meta.id === 'touchstone-toggle')
    && rec.slots.some((s) => s.meta.id === 'touchstone-panel'),
  JSON.stringify(rec.slots.map((s) => s.meta.id)));

  check('注册了官方命令 touchstone.toggle', svc.registered.length === 1 && svc.registered[0].id === 'touchstone.toggle',
    JSON.stringify(svc.registered.map((c) => c.id)));
  const cmd = svc.registered[0];
  const defaults = cmd && cmd.defaults;
  check('desktop 三档默认纯 Alt+T',
    !!defaults && ['macos', 'windows', 'linux'].every((p) => {
      const b = defaults[`desktop:${p}`];
      return b && b.code === 'KeyT' && b.modifiers.length === 1 && b.modifiers[0] === 'alt';
    }), JSON.stringify(defaults));
  check('Web 档只声明白名单放行的 primary+alt+T（macos/windows），linux 不声明',
    !!defaults && ['macos', 'windows'].every((p) => {
      const b = defaults[`web:${p}`];
      return b && b.code === 'KeyT' && b.modifiers.includes('primary') && b.modifiers.includes('alt');
    }) && defaults['web:linux'] === undefined, JSON.stringify(defaults));
  check('regions=page+editable、modals 为空',
    JSON.stringify(cmd.regions) === JSON.stringify(['page', 'editable']) && Array.isArray(cmd.modals) && cmd.modals.length === 0,
    JSON.stringify({ regions: cmd.regions, modals: cmd.modals }));
  check('label 是函数（目录每次刷新重取本地化名）',
    typeof cmd.label === 'function' && typeof cmd.label() === 'string' && cmd.label().includes('Touchstone'));
  check('别名含 touchstone/测试平台', Array.isArray(cmd.aliases) && cmd.aliases.includes('touchstone'));

  const res = cmd.resolve({ region: 'page', modal: null, target: null });
  check('resolve 返回 handled', !!res && res.status === 'handled');
  res.run();
  check('run() 打开面板', openState(storage) === '1', String(openState(storage)));
  res.run();
  check('再 run() 关闭面板', openState(storage) === '0', String(openState(storage)));

  check('宿主页挂了 capture 阶段 keydown 监听', hostDoc.listenerCount('keydown') === 1
    && hostDoc.listeners[0].capture === true, JSON.stringify(hostDoc.listeners));
}

function caseLocalAltT() {
  console.log('== ② 插件自管 Alt+T（宿主页 + 面板 iframe）==');
  const env = setup();
  const { hostDoc, storage, rec, mini } = env;

  const e1 = hostDoc.dispatch(key());
  check('宿主页 Alt+T 打开面板', openState(storage) === '1', String(openState(storage)));
  check('命中即吞事件（preventDefault + stopPropagation）', e1.defaultPrevented && e1.propagationStopped);
  hostDoc.dispatch(key());
  check('再按 Alt+T 关闭面板', openState(storage) === '0');

  // 只认精确 Alt+T：多/少/换修饰键、连发、输入法组合、换键码一律不触发
  const variants = [
    ['Ctrl+Alt+T', key({ ctrlKey: true })],
    ['Alt+Shift+T', key({ shiftKey: true })],
    ['Alt+Meta+T', key({ metaKey: true })],
    ['Alt+T 长按 repeat', key({ repeat: true })],
    ['输入法组合中的 Alt+T', key({ isComposing: true })],
    ['Alt+Y', key({ code: 'KeyY' })],
    ['裸 T', key({ altKey: false })],
  ];
  let none = true;
  for (const [name, ev] of variants) {
    const e = hostDoc.dispatch(ev);
    if (openState(storage) !== '0' || e.defaultPrevented) { none = false; console.log(`       └ ${name} 不该触发`); }
  }
  check('7 种变体都不误触发（状态不变、不吞事件）', none);

  // 打开面板 → 渲染 Panel → iframe 侧也要挂 keydown
  const { wrapped, iframeDoc } = openPanel(env);
  check('面板打开时渲染出 iframe 元素', !!iframeDoc);
  const frameKey = iframeDoc && iframeDoc.listeners.find((l) => l.type === 'keydown');
  check('iframe 文档挂了 capture 阶段 keydown 监听',
    !!frameKey && frameKey.capture === true && iframeDoc.listenerCount('keydown') === 1,
    iframeDoc ? JSON.stringify(iframeDoc.listeners) : 'no iframe doc');

  if (iframeDoc) {
    const e = iframeDoc.dispatch(key());
    check('面板内（焦点在 iframe 里）Alt+T 也能关面板', openState(storage) === '0', String(openState(storage)));
    check('面板内命中同样吞事件', e.defaultPrevented && e.propagationStopped);
  }

  // 关闭面板（2026-10-07 保活改动）：iframe 与它上面的 keydown 监听都**留着** —— 隐藏的
  // iframe 仍会独吞键盘事件，监听还在才能用 Alt+T 把面板按回来；解绑只发生在插件 dispose。
  rerenderPanel(env, wrapped);
  check('面板关闭后 iframe keydown 监听仍在（保活：隐藏 iframe 仍吞键）',
    !!iframeDoc && iframeDoc.listenerCount('keydown') === 1,
    iframeDoc ? String(iframeDoc.listenerCount('keydown')) : 'no iframe doc');
  if (iframeDoc) {
    iframeDoc.dispatch(key());
    check('关闭后 iframe 内 Alt+T 仍能把面板按回来', openState(storage) === '1', String(openState(storage)));
    iframeDoc.dispatch(key());
    check('再按一次关闭（复位到关闭态）', openState(storage) === '0', String(openState(storage)));
  }

  // 卸载整个插件：宿主页监听解绑（ctx.effect 的 disposer）
  mini.unmount();
  for (const cleanup of rec.effects) if (typeof cleanup === 'function') cleanup();
  check('插件 dispose 后宿主页 keydown 监听被解绑', hostDoc.listenerCount('keydown') === 0);
  const frozen = openState(storage);
  const after = hostDoc.dispatch(key());
  check('dispose 后 Alt+T 不再改状态、不再吞事件',
    openState(storage) === frozen && !after.defaultPrevented,
    `${frozen} → ${openState(storage)}`);
}

function caseIframeFollowsOfficialBinding() {
  console.log('== ③ 面板内跟随官方生效键位（用户改键后仍认）==');
  const row = { id: 'touchstone.toggle', binding: { code: 'KeyT', modifiers: ['control', 'alt'] }, issue: null, conflicts: [] };
  const env = setup({ catalogRow: row });
  const { iframeDoc } = openPanel(env);
  const { storage } = env;

  iframeDoc.dispatch(key({ code: 'KeyY', key: 'y' }));
  check('面板内按非生效键位（Alt+Y）不改状态', openState(storage) === '1', String(openState(storage)));
  iframeDoc.dispatch(key({ ctrlKey: true }));
  check('面板内按生效键位 Ctrl+Alt+T 关闭面板（官方绑定生效）', openState(storage) === '0', String(openState(storage)));

  // 官方键位被标不可用/冲突/未绑定时不再认它（与 dsh 目录语义一致）
  const cases = [
    ['issue=unsupported-browser', { ...row, issue: 'unsupported-browser' }],
    ['conflicts 非空', { ...row, conflicts: ['session.new'] }],
    ['未绑定(binding=null)', { ...row, binding: null }],
  ];
  for (const [name, badRow] of cases) {
    const bad = setup({ catalogRow: badRow });
    const open = openPanel(bad);
    open.iframeDoc.dispatch(key({ ctrlKey: true }));
    check(`官方键位${name}时不认该键位（面板仍开着）`, openState(bad.storage) === '1', String(openState(bad.storage)));
  }
}

function caseRegisterFailure() {
  console.log('== ④ 兜底：官方注册失败不拖垮面板 ==');
  const env = setup({ registerError: new Error('Conflicting shortcut defaults: touchstone.toggle'), applyIt: false });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  let threw = '';
  try { env.ex.apply(env.ctx); } catch (error) { threw = error && error.message; } finally { console.warn = origWarn; }

  check('register 抛错不冒泡（apply 不抛）', threw === '', threw);
  check('两个 UI 槽照常注册', env.rec.slots.length === 2);
  check('打了告警日志', warns.some((w) => w.includes('快捷键注册失败')), JSON.stringify(warns));
  env.hostDoc.dispatch(key());
  check('服务不可用时自管 Alt+T 仍能打开面板', openState(env.storage) === '1', String(openState(env.storage)));
}

function caseDesktopRuntime() {
  console.log('== ⑤ desktop 档让位给官方原生键盘桥（不双触发）==');
  const row = { id: 'touchstone.toggle', binding: { code: 'KeyT', modifiers: ['alt'] }, issue: null, conflicts: [] };
  const env = setup({ runtime: 'desktop', catalogRow: row });
  const { hostDoc, storage, svc } = env;

  const e = hostDoc.dispatch(key());
  check('desktop 档自管键不动作（由原生桥派发官方命令）',
    storage.getItem('ts.plugin.open') === null && !e.defaultPrevented);
  svc.registered[0].resolve({ region: 'page', modal: null, target: null }).run();
  check('desktop 档官方命令仍可开面板', openState(storage) === '1', String(openState(storage)));
  const t = hostDoc.dispatch(key());
  check('desktop 档自管键不吞事件（交给宿主/原生处理）', !t.defaultPrevented && openState(storage) === '1');
}

console.log(`== 客户端快捷键自检（产物: ${path.relative(root, bundlePath)}）==`);
caseOfficialRegistration();
caseLocalAltT();
caseIframeFollowsOfficialBinding();
caseRegisterFailure();
caseDesktopRuntime();

console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
