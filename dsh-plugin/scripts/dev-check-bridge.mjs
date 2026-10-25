/**
 * 面板消息桥自检（不经 dsh、不经浏览器）：桩 DOM + 桩 React + 桩 ctx 驱动**真实产物**
 * lib/client.bundle.js，把 2026-10-04 加的「在 dsh 界面打开卡片主会话」桥钉死：
 *   ① 探针应答：能力位由 uiWorkspace 是否就绪决定（未就绪 false ⇒ SPA 侧按钮不渲染）；
 *   ② 打开请求：调 uiWorkspace.openSession(sid) 并关掉全屏面板（弹出语义）；
 *   ③ 拒绝面：来源窗口不是本面板 iframe / 异源 / sid 为空 / openSession 抛错 —— 一律不动作，
 *      失败时面板保持打开（用户视角仍停在自己刚点的卡片上）；
 *   ④ 生命周期：面板关闭即解绑 message 监听（不留悬挂监听）。
 * 另钉 2026-10-07 的「保活 + 上次页面」三件事（⑤⑥⑦）：
 *   ⑤ 保活：关闭只把浮层 display:none，iframe 与内嵌 SPA 常驻（重开不重新加载）；
 *   ⑥ 入口路径：iframe src 取内嵌 SPA 记下的「上次页面」（ts.last_route），脏值回落 /touchstone/app；
 *   ⑦ 焦点交还：关闭时把焦点从 iframe 交回宿主页（隐藏的 iframe 仍会独吞键盘事件）。
 * 再钉 2026-10-17 的「窗口装饰区让位」（⑧，卡 987 方案 A）：
 *   ⑧ 浮层顶边 = 桌面壳发布的窗口 chrome 顶带高 —— dsh 的 --dsh-frame-chrome-top /
 *      --dsh-frame-top-clearance（取大）→ WCO 原生接口 → env() 探针三级兜底；全读不到 = 0
 *      （普通浏览器/独立形态行为不变）；resize 后重算；卸载不留监听、不留 env 探针节点。
 * 再钉 2026-10-22 的插件外壳文案双语（⑨）：
 *   ⑨ 语言：入口/关闭按钮读同源 localStorage `ts_lang` 渲染中/英；缺省、非法值、
 *      读取异常一律英文（产品决定 D2），中文文案逐字保留原文。
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

/** 给事件目标补上「document」面（2026-10-09）：侧栏入口的交互态样式表经
 *  `createElement('style')` + `head.appendChild` + `querySelector` 幂等注入 —— 桩里也得真跑
 *  这条路径（否则插件只能静默降级，注入逻辑等于没被测到）。
 *  2026-10-17 起还兜「env(titlebar-area-height) 探针」：createElement('div') + body.appendChild +
 *  getBoundingClientRect + remove；envHeight 为探针量到的高度（0 = 壳不支持）。
 * @returns 同 target，另带 documentElement / body(appendChild·removeChild·children) / orphans。 */
function asDocument(target, { envHeight = 0 } = {}) {
  const styles = [];
  const orphans = []; // 探针这类临时节点: 用例据此断言「用完就摘」
  target.styles = styles;
  target.orphans = orphans;
  target.querySelector = (sel) => {
    const m = /^style\[data-plugin-css="(.*)"\]$/.exec(String(sel));
    return m ? (styles.find((s) => s.dataset.pluginCss === m[1]) || null) : null;
  };
  const makeNode = (tagName) => ({
    tagName,
    style: {},
    dataset: {},
    textContent: '',
    parentNode: null,
    getBoundingClientRect: () => ({ width: 0, height: envHeight }),
    remove() {
      const body = target.body;
      if (body && body.children) {
        const i = body.children.indexOf(this);
        if (i >= 0) body.children.splice(i, 1);
      }
      this.parentNode = null;
      const j = orphans.indexOf(this);
      if (j >= 0) orphans.splice(j, 1);
    },
  });
  target.createElement = (tag) => {
    if (String(tag).toLowerCase() === 'style') {
      const node = { tagName: 'STYLE', dataset: {}, textContent: '' };
      node.remove = () => {
        const i = styles.indexOf(node);
        if (i >= 0) styles.splice(i, 1);
      };
      return node;
    }
    return makeNode(String(tag || '').toUpperCase());
  };
  target.documentElement = makeTarget('documentElement');
  target.head = { appendChild: (node) => { styles.push(node); return node; } };
  target.body = makeTarget('body');
  target.body.children = [];
  target.body.appendChild = (node) => {
    target.body.children.push(node);
    node.parentNode = target.body;
    orphans.push(node);
    return node;
  };
  target.body.removeChild = (node) => {
    const i = target.body.children.indexOf(node);
    if (i >= 0) target.body.children.splice(i, 1);
    node.parentNode = null;
    const j = orphans.indexOf(node);
    if (j >= 0) orphans.splice(j, 1);
  };
  return target;
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
/** 造 mini React + 渲染器：createElement / useState / useEffect / useRef。
 * @param hostDoc - 宿主 document 桩（iframe.blur() 要把焦点从 iframe 上摘掉，得看它）。 */
function makeMiniReact(hostDoc) {
  let index = 0;
  const runtime = { values: [], effects: [], pending: [] };
  let stableIframe = null; // 跨渲染复用的 iframe 元素（见 createElement 注释）
  /** 造 iframe 元素：除事件目标外带同源 contentDocument 与 contentWindow（桥的 e.source 判定面）。 */
  const makeIframe = () => {
    const el = Object.assign(makeTarget('iframe'), { type: 'iframe', props: {}, children: [] });
    el.clientHeight = 800;
    el.contentDocument = makeTarget('iframe-document');
    const win = makeTarget('iframe-window');
    win.posted = [];
    win.postMessage = (msg, targetOrigin) => { win.posted.push({ msg, targetOrigin }); };
    el.contentWindow = win;
    el.blurred = false;
    el.blur = () => { el.blurred = true; if (hostDoc.activeElement === el) hostDoc.activeElement = null; };
    return el;
  };
  const React = {
    createElement(type, props, ...children) {
      // iframe 元素跨渲染复用（真 React 会复用 DOM 节点；桩里不这样，ref/焦点/监听
      // 这些「同一个节点」语义就没法验——保活与焦点交还两处判据都依赖它）
      let el;
      if (type === 'iframe') {
        el = stableIframe || (stableIframe = makeIframe());
      } else {
        el = Object.assign(makeTarget(String(type)), { type, props: {}, children: [] });
      }
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
 * @param open - 面板初始开合状态（缺省 true：与「上次会话开着面板」的常见态一致）。
 * @param lastRoute - 预置的「上次页面」记忆（ts.last_route）；不传=没有记忆。
 * @param chrome - 桌面壳环境桩（2026-10-17 ⑧）:
 *   vars=<CSS 变量名→值> 让 getComputedStyle 返回它; wco=<windowControlsOverlay 桩>;
 *   envHeight=<env() 探针量到的高度>。不传=普通浏览器（三者都读不到）。
 * @param lang - 预置界面语言（localStorage ts_lang）；不传=本浏览器从未选过（缺省英文）。
 * @param storageError - true 时 localStorage.getItem 抛错（隐私模式等），验证读语言回落英文。
 * @returns 该环境下所有可观测面（chromeVars 供 resize 重算用例现场改值）。
 */
function setup({ uiWorkspace, openSessionError = null, open: openInitial = true, lastRoute, chrome, lang, storageError = false } = {}) {
  const src = fs.readFileSync(bundlePath, 'utf8');
  // 预置面板开合状态：Panel 在挂载时才挂 iframe/消息桥，开合状态本来就是记忆值
  const initial = openInitial ? { 'ts.plugin.open': '1' } : {};
  if (lastRoute !== undefined) initial['ts.last_route'] = lastRoute;
  if (lang !== undefined) initial['ts_lang'] = lang;
  const storage = makeStorage(initial);
  // localStorage 读取一律抛错：语言必须回落 en，入口/面板本体不受影响
  if (storageError) storage.getItem = () => { throw new Error('storage denied'); };
  const hostDoc = asDocument(makeTarget('host-document'), {
    envHeight: chrome ? chrome.envHeight : 0,
  });
  hostDoc.activeElement = null;
  hostDoc.body.focused = false;
  hostDoc.body.focus = () => { hostDoc.body.focused = true; };
  const fakeWindow = makeTarget('host-window');
  fakeWindow.location = { origin: ORIGIN };
  fakeWindow.parent = fakeWindow; // 插件在宿主页顶层跑，无父窗口
  const chromeVars = (chrome && chrome.vars) || null;
  if (chromeVars) {
    // 模拟 dsh 桌面壳发布在 <html> 上的 CSS 自定义属性(读不到=空串, 与真机一致)
    fakeWindow.getComputedStyle = () => ({
      getPropertyValue: (name) => (name in chromeVars ? String(chromeVars[name]) : ''),
    });
  }
  if (chrome && chrome.wco) fakeWindow.navigator = { windowControlsOverlay: chrome.wco };
  let factory = null;
  fakeWindow.__ModuleLoader__ = { load: (mod) => { factory = mod.factory; } };
  // 产物是浏览器脚本：`window.__ModuleLoader__.load(...)` 在 Function 作用域里求值
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', src)(fakeWindow, hostDoc, storage);
  if (!factory) throw new Error('bundle 未向 __ModuleLoader__ 注册 factory');

  const mini = makeMiniReact(hostDoc);
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
  return { ex, rec, mini, storage, hostDoc, fakeWindow, service, chromeVars };
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
  const { wrapped, iframeEl, iframeWin } = renderPanel(env);
  panelMessage(env, { type: 'touchstone:open-session', sid: 'sess-abc' });
  check('openSession 收到会话 id', env.service.calls.length === 1 && env.service.calls[0] === 'sess-abc',
    JSON.stringify(env.service.calls));
  check('面板已关闭（开合状态落 0）', openFlag(env.storage) === '0', String(openFlag(env.storage)));
  const tree = env.mini.render(wrapped.type, wrapped.props);
  const kept = tree && Array.isArray(tree.children)
    ? tree.children.find((c) => c && c.type === 'iframe') : null;
  check('关闭 = 浮层 display:none（保活：iframe 不卸载）',
    !!tree && tree.props && tree.props.style && tree.props.style.display === 'none' && !!kept,
    String(tree && tree.props && tree.props.style.display));
  check('保活：关闭后 iframe 仍是同一个元素（SPA 文档没被销毁）', kept === iframeEl,
    kept === iframeEl ? 'same' : 'rebuilt');
  check('没有多余的回包（打开请求只调服务，不回应答）', iframeWin.posted.length === 0,
    JSON.stringify(iframeWin.posted));
}

// ── ⑤ 保活：关闭只隐藏，重开还是原来那篇文档 ─────────────────────────────────
function caseKeepAlive() {
  console.log('== ⑤ 保活：关闭只隐藏，重开不重新加载 ==');
  const env = setup({ uiWorkspace: {} });
  // 首次渲染的元素句柄要留住: iframe 文档上的快捷键监听挂在它身上（桩 React 每次渲染
  // 都会造新元素，只有真 React 才会复用 DOM 节点）
  const { wrapped, tree: opened, iframeEl } = renderPanel(env);
  check('打开态浮层 display:block', opened.props.style.display === 'block',
    String(opened.props.style.display));

  // 面板内 Alt+T 关闭（iframe 里的 keydown 不冒泡到宿主页，走的是 iframe 文档上那层监听）
  iframeEl.contentDocument.dispatch({ type: 'keydown', code: 'KeyT', altKey: true });
  check('面板内 Alt+T 关闭面板', openFlag(env.storage) === '0', String(openFlag(env.storage)));
  const closed = env.mini.render(wrapped.type, wrapped.props);
  check('关闭后浮层仍是 display:none 的容器（iframe 留在 DOM 里，SPA 不重新加载）',
    closed && closed.props.style.display === 'none'
    && !!closed.children.find((c) => c && c.type === 'iframe'),
    String(closed && closed.props.style.display));
  check('关闭后 iframe 文档上的快捷键监听仍在（隐藏 iframe 仍会吞键，靠它按回来）',
    iframeEl.contentDocument.listenerCount('keydown') === 1,
    String(iframeEl.contentDocument.listenerCount('keydown')));

  iframeEl.contentDocument.dispatch({ type: 'keydown', code: 'KeyT', altKey: true });
  const reopened = env.mini.render(wrapped.type, wrapped.props);
  check('再按 Alt+T 面板回来（display:block，同一个 iframe 元素）',
    openFlag(env.storage) === '1' && reopened.props.style.display === 'block'
    && reopened.children.find((c) => c && c.type === 'iframe') === iframeEl,
    `${openFlag(env.storage)} / ${reopened.props.style.display}`);
}

// ── ⑥ 入口路径：iframe src 取内嵌 SPA 记下的「上次页面」 ────────────────────────
function caseEntry() {
  console.log('== ⑥ 入口路径：remembered route → iframe src ==');
  const remembered = setup({ uiWorkspace: {}, lastRoute: '/touchstone/settings/appearance' });
  const rememberedSrc = renderPanel(remembered).iframeEl.props.src;
  check('有记忆 → iframe 直接建在记忆页（不用先落 /app 再跳）',
    rememberedSrc === '/touchstone/settings/appearance', String(rememberedSrc));

  // 脏值/异前缀/插件根一律回落缺省入口（/touchstone/ 会 302 到根相对 /app，跳出插件）
  const dirty = [undefined, '', 'http://evil.test/x', '/other/app', '/touchstone/', '/touchstone', '/touchstone-login'];
  for (const value of dirty) {
    const env = setup({ uiWorkspace: {}, lastRoute: value });
    const got = renderPanel(env).iframeEl.props.src;
    check(`记忆值 ${JSON.stringify(value)} → 回落 /touchstone/app`, got === '/touchstone/app', got);
  }

  // 从没用过面板的会话：不建 iframe，也不挂任何面板侧监听（零开销）
  const fresh = setup({ uiWorkspace: {}, open: false });
  const beforeOpen = renderPanel(fresh).tree;
  check('没打开过面板 → 不建 iframe（渲染 null）', beforeOpen === null, String(beforeOpen));
  fresh.hostDoc.dispatch({ type: 'keydown', code: 'KeyT', altKey: true }); // 宿主页 Alt+T
  const opened = renderPanel(fresh);
  check('首次打开才建 iframe，src 为缺省入口',
    !!opened.iframeEl && opened.iframeEl.props.src === '/touchstone/app',
    String(opened.iframeEl && opened.iframeEl.props.src));
}

// ── ⑦ 焦点交还：关闭时不能把焦点落在隐藏的 iframe 里（否则宿主页 Alt+T 收不到） ──
function caseFocusHandoff() {
  console.log('== ⑦ 焦点交还：关闭时把焦点从 iframe 交回宿主页 ==');
  const env = setup({ uiWorkspace: {} });
  const { wrapped, iframeEl } = renderPanel(env);
  env.hostDoc.activeElement = iframeEl; // 焦点在面板 iframe 上（用户在面板里操作时的常态）
  panelMessage(env, { type: 'touchstone:open-session', sid: 'sess-abc' }); // 关面板
  env.mini.render(wrapped.type, wrapped.props);                            // 跑关闭态 effect
  check('关闭时 iframe 被 blur 且宿主 body 拿回焦点',
    iframeEl.blurred === true && env.hostDoc.body.focused === true,
    `blurred=${iframeEl.blurred} bodyFocused=${env.hostDoc.body.focused}`);
}

// ── ⑧ 窗口装饰区让位：浮层顶边 = 壳发布的窗口 chrome 顶带高 ──────────────────────
function caseWindowChrome() {
  console.log('== ⑧ 窗口装饰区让位：浮层顶边跟着窗口 chrome 顶带走 ==');

  /** 渲染一次面板并取浮层容器(树根)的 style 快照。 */
  const panelStyle = (env) => {
    const { tree } = renderPanel(env);
    return (tree && tree.props && tree.props.style) || {};
  };

  // 普通浏览器/独立形态：没有任何壳标记 ⇒ 顶边 0（与旧版 inset:0 完全等价，行为不变）
  const browser = panelStyle(setup({ uiWorkspace: {} }));
  check('普通浏览器 → 顶边 0（行为不变）', browser.top === 0
    && browser.left === 0 && browser.right === 0 && browser.bottom === 0,
  JSON.stringify(browser));

  // Windows 桌面（非全屏）：dsh 壳把标题栏高同时发布成 chrome-top 与 top-clearance
  const win = panelStyle(setup({
    uiWorkspace: {},
    chrome: { vars: { '--dsh-frame-chrome-top': '40px', '--dsh-frame-top-clearance': '40px' } },
  }));
  check('Windows 桌面 → 顶边 40px（窗口控制按钮整条让出来）', win.top === 40, JSON.stringify(win));

  // macOS 桌面：只发布 top-clearance=48px（红绿灯在左上; chrome-top 仅全屏态才定义）
  const mac = panelStyle(setup({
    uiWorkspace: {},
    chrome: { vars: { '--dsh-frame-top-clearance': '48px' } },
  }));
  check('macOS 桌面 → 顶边 48px（红绿灯让出来）', mac.top === 48, JSON.stringify(mac));

  // Windows 全屏：chrome-top=0 但 Frame 仍按 titlebar 高让位 ⇒ 取 max=40（与主面板同口径）
  const fullscreen = panelStyle(setup({
    uiWorkspace: {},
    chrome: { vars: { '--dsh-frame-chrome-top': '0px', '--dsh-frame-top-clearance': '40px' } },
  }));
  check('Windows 全屏（chrome-top=0）→ 仍取 top-clearance 40px', fullscreen.top === 40,
    JSON.stringify(fullscreen));

  // 旧桌面壳兜底 ②：只开了 WCO、没发布 dsh 变量 ⇒ navigator.windowControlsOverlay 量
  const wco = Object.assign(makeTarget('windowControlsOverlay'), {
    visible: true,
    getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 2400, height: 32 }),
  });
  const byWco = panelStyle(setup({ uiWorkspace: {}, chrome: { wco } }));
  check('只有 WCO 接口（旧壳）→ 顶边 32px', byWco.top === 32, JSON.stringify(byWco));

  // 更老的壳兜底 ③：只支持 env(titlebar-area-*) ⇒ 用探针量到的高度
  const env = setup({ uiWorkspace: {}, chrome: { envHeight: 36 } });
  const byEnv = panelStyle(env);
  check('只有 env() 探针 → 顶边 36px', byEnv.top === 36, JSON.stringify(byEnv));
  check('env 探针用完即摘（宿主 DOM 不留垃圾）', env.hostDoc.body.children.length === 0
    && env.hostDoc.orphans.length === 0,
  `children=${env.hostDoc.body.children.length} orphans=${env.hostDoc.orphans.length}`);

  // 脏值/越界：一律按 0（面板绝不能被一个脏 CSS 变量顶出屏幕）
  const dirty = panelStyle(setup({
    uiWorkspace: {},
    chrome: { vars: { '--dsh-frame-chrome-top': 'not-a-px', '--dsh-frame-top-clearance': '9999px' } },
  }));
  check('脏值/越界 → 顶边 0', dirty.top === 0, JSON.stringify(dirty));

  // 壳换档（resize/全屏/几何变化）后重算：监听在挂、值跟着走、卸载即解绑
  const resizeEnv = setup({
    uiWorkspace: {},
    chrome: { vars: { '--dsh-frame-chrome-top': '40px', '--dsh-frame-top-clearance': '40px' } },
  });
  const { wrapped } = renderPanel(resizeEnv);
  check('挂了 resize/fullscreenchange 重算监听',
    resizeEnv.fakeWindow.listenerCount('resize') === 1
    && resizeEnv.hostDoc.listenerCount('fullscreenchange') === 1,
    `resize=${resizeEnv.fakeWindow.listenerCount('resize')}`
    + ` fs=${resizeEnv.hostDoc.listenerCount('fullscreenchange')}`);
  resizeEnv.chromeVars['--dsh-frame-chrome-top'] = '48px'; // 壳把标题栏调高了
  resizeEnv.chromeVars['--dsh-frame-top-clearance'] = '48px';
  resizeEnv.fakeWindow.dispatch({ type: 'resize' });
  const afterResize = resizeEnv.mini.render(wrapped.type, wrapped.props);
  check('resize 后重新量 → 顶边 48px', afterResize.props.style.top === 48,
    JSON.stringify(afterResize.props.style));
  resizeEnv.mini.unmount();
  check('卸载后重算监听全部解绑',
    resizeEnv.fakeWindow.listenerCount('resize') === 0
    && resizeEnv.hostDoc.listenerCount('fullscreenchange') === 0,
    `resize=${resizeEnv.fakeWindow.listenerCount('resize')}`
    + ` fs=${resizeEnv.hostDoc.listenerCount('fullscreenchange')}`);
}

// ── ⑨ 语言：外壳文案读同源 ts_lang（缺省/非法/异常 → en） ──────────────────────
function caseLang() {
  console.log('== ⑨ 语言：入口/关闭按钮读 ts_lang（缺省/非法/异常 → en）==');

  /** 分别在干净环境里渲染侧栏入口（展开态、面板开着）与面板关闭按钮，取可观测文案面。
   *  入口与面板各用一套 setup：mini React 的 hook 槽按环境复用，混渲染会串状态。 */
  const copyOf = (opts = {}) => {
    const entryEnv = setup({ uiWorkspace: {}, ...opts });
    const entry = entryEnv.rec.slots.find((s) => s.meta.id === 'touchstone-toggle');
    const wrapped = entry.comp({});
    const toggle = entryEnv.mini.render(wrapped.type, { wide: true });

    const panelEnv = setup({ uiWorkspace: {}, ...opts });
    const panel = renderPanel(panelEnv).tree;
    const close = panel && Array.isArray(panel.children)
      ? panel.children.find((c) => c && c.type === 'button') : null;

    return {
      label: toggle.children[1] && toggle.children[1].children[0], // ts_lang=zh 时应为「关闭 Touchstone」
      title: toggle.props.title,
      aria: toggle.props['aria-label'],
      close: close && close.props.title,
    };
  };

  // 缺省（本浏览器从未选过语言）→ 英文（产品决定 D2：默认英文）
  const def = copyOf();
  check('缺省无 ts_lang → 入口/关闭按钮英文',
    def.label === 'Close Touchstone'
    && def.title === 'Touchstone Test Platform (Alt+T to toggle)' && def.aria === def.title
    && def.close === 'Close Touchstone Panel', JSON.stringify(def));

  // 显式 en → 与缺省一致
  const en = copyOf({ lang: 'en' });
  check('ts_lang=en → 入口/关闭按钮英文',
    en.label === 'Close Touchstone'
    && en.title === 'Touchstone Test Platform (Alt+T to toggle)'
    && en.close === 'Close Touchstone Panel', JSON.stringify(en));

  // 显式 zh → 中文原文逐字保留
  const zh = copyOf({ lang: 'zh' });
  check('ts_lang=zh → 入口/关闭按钮中文原文',
    zh.label === '关闭 Touchstone'
    && zh.title === 'Touchstone 测试平台（Alt+T 开关）' && zh.aria === zh.title
    && zh.close === '关闭 Touchstone 面板', JSON.stringify(zh));

  // 非法值（大小写/地区码/空串）→ 英文，不被脏值带偏
  for (const lang of ['fr', 'ZH', 'zh-CN', '']) {
    const got = copyOf({ lang });
    check(`ts_lang=${JSON.stringify(lang)} → 回落英文`,
      got.label === 'Close Touchstone' && got.close === 'Close Touchstone Panel',
      JSON.stringify(got));
  }

  // localStorage 读取抛错（隐私模式）：读语言回落英文，入口照常渲染
  const broken = copyOf({ storageError: true });
  check('localStorage 读取异常 → 英文（入口照常渲染）',
    broken.title === 'Touchstone Test Platform (Alt+T to toggle)' && broken.aria === broken.title,
    JSON.stringify(broken));
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
  const { iframeEl } = renderPanel(env);
  check('挂载后 1 条 message 监听', env.fakeWindow.listenerCount('message') === 1,
    String(env.fakeWindow.listenerCount('message')));
  env.mini.unmount();
  check('卸载后 0 条 message 监听（不留悬挂监听）', env.fakeWindow.listenerCount('message') === 0,
    String(env.fakeWindow.listenerCount('message')));
  check('卸载后 iframe 文档上的快捷键监听一并解绑', iframeEl.contentDocument.listenerCount('keydown') === 0,
    String(iframeEl.contentDocument.listenerCount('keydown')));
}

caseProbe();
caseOpen();
caseReject();
caseLifecycle();
caseKeepAlive();
caseEntry();
caseFocusHandoff();
caseWindowChrome();
caseLang();

console.log(failures ? `\nOVERALL: FAIL (${failures} 项失败)` : '\nOVERALL: PASS');
process.exit(failures ? 1 : 0);
