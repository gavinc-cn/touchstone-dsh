window.__ModuleLoader__.load({
	id: "@gavinc-cn/touchstone-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
// Touchstone 面板 — 浏览器半（cordis 客户端插件; 形态参照 kanban-board 的 factory 体）
// 职责: dsh 侧栏入口按钮(sidebar.footer.action) + 全屏面板(shell.overlay)内嵌
// 插件版 SPA 的 iframe(base=/touchstone/, 同源免登) + 面板消息桥(内嵌 SPA 请求
// 「在 dsh 主界面打开卡片主会话」, 见 attachPanelBridge)。
// 注意 iframe 入口勿用 /touchstone/ 根: 它会 302 到根相对 /app, 在 dsh 宿主上会跳出本插件;
// 未登录跳转由 SPA 路由守卫在客户端完成。缺省入口 /touchstone/app, 有「上次页面」记忆时
// 按记忆路径建 iframe(见 panelEntry), 面板一开就停在用户切走前那一页。
// 纯 JS 函数体(无 JSX/import), 由 scripts/build.mjs 包装为 __ModuleLoader__ factory。

const h = React.createElement;
const OPEN_KEY = 'ts.plugin.open'; // 面板开合状态(localStorage 记忆)
// 上次所在页面(路由级, 由内嵌 SPA 写入; 键名与 webui/src/lib/lastRoute.js **逐字一致**)
const ROUTE_KEY = 'ts.last_route';
let open = false;
try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch { /* 隐私模式等场景忽略 */ }
const listeners = new Set();
function setOpen(v) {
  open = !!v;
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* 同上 */ }
  listeners.forEach((l) => l());
}
// 按钮与面板共享开合状态的最小 store(kanban 同款自研 store 的子集)
function useOpen() {
  const [v, setV] = React.useState(open);
  React.useEffect(() => {
    const l = () => setV(open);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return v;
}

// ── 快捷键(2026-10-04) ──────────────────────────────────────────────────────
// 两条通道并行, 覆盖「dsh 的两种运行档」×「焦点在宿主页 / 在面板 iframe 里」四种状态:
//  ① 官方注册(ctx.shortcuts.register): 命令进 dsh 的快捷键目录, 用户可在「设置 → 快捷键」
//     里看到并改键, 也参与与其它命令的冲突校验。dsh 的 Web 白名单
//     (dsh-client-shortcuts 的 isWebBindingAllowed) **不接受纯 Alt+T** —— Web 档只放行
//     「2 修饰键且含 primary(Windows 为 Ctrl / macOS 为 Cmd)」或「3~4 修饰键」,
//     Linux Web 更只放行三组固定组合; 且 register() 对不合规的默认键位直接抛异常。
//     所以 Web 档默认键位取 primary+alt+T(macOS ⌘⌥T), desktop 三档才用纯 Alt+T。
//  ② 插件自管(纯 Alt+T): 满足「Alt+T 开关面板」的原始诉求; 官方注册覆盖不到的部分
//     (Web 的纯 Alt+T)由它兜底。它还必须自管 iframe 一侧 —— 面板是全屏**同源 iframe**,
//     焦点在它里面时按键不会冒泡到宿主页(与本文件关闭按钮热区的 mousemove 同一个坑)。
const COMMAND_ID = 'touchstone.toggle'; // 官方命令 id(dsh 要求: 小写点分)
const COMMAND_LABEL = '打开/关闭 Touchstone 面板';
const KEY_CODE = 'KeyT';                // 物理键(Alt+T 的 T)
let shortcuts = null;                   // 官方 shortcuts 服务(未注册成功时为 null)

/** 事件是否发生在文本输入控件里(判定口径与 dsh 的适配器一致)。 */
function isEditableTarget(e) {
  const el = e.target;
  return !!(el && el.closest
    && el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

/** 当前设备是否为 macOS(优先用 dsh 判定的平台, 服务缺失时退回 UA 探测)。 */
function isMac() {
  if (shortcuts && shortcuts.platform) return shortcuts.platform === 'macos';
  return /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
}

/** 官方命令当前生效键位(未注册/未绑定/不可用/有冲突一律视为无键位)。 */
function activeBinding() {
  if (!shortcuts) return null;
  try {
    const row = shortcuts.catalog.getSnapshot().find((r) => r.id === COMMAND_ID);
    if (!row || !row.binding || row.issue !== null) return null;
    if (row.conflicts && row.conflicts.length) return null;
    return row.binding; // NormalizedBinding: { code, modifiers: [...] }
  } catch { return null; } // 目录读取异常绝不影响按键判定
}

/** 一条规范化键位是否与本次按键完全一致(修饰键集合精确相等)。 */
function bindingMatches(binding, e) {
  const mods = binding.modifiers || [];
  return e.code === binding.code
    && !!e.ctrlKey === mods.includes('control')
    && !!e.altKey === mods.includes('alt')
    && !!e.shiftKey === mods.includes('shift')
    && !!e.metaKey === mods.includes('meta');
}

/** 插件自管键 Alt+T 判定: 精确 Alt+T(不多不少修饰键) + 排除长按重复/输入法组合;
 *  macOS 的 ⌥T 是「†」字符键, 在可编辑控件里不拦截, 免得用户打不出 †。 */
function isLocalToggleKey(e) {
  if (e.code !== KEY_CODE || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return false;
  if (e.repeat || e.isComposing || e.key === 'Dead') return false;
  return !(isMac() && isEditableTarget(e));
}

/** 键盘触发开关: 命中(官方生效键位或自管 Alt+T)即吞掉事件并翻转面板, 未命中返回 false。
 *  desktop 档直接放行 —— 官方注册表经原生键盘桥接管(焦点在 iframe 里也送得到),
 *  这里再自管会双触发。 */
function toggleByKey(e) {
  if (shortcuts && shortcuts.runtime === 'desktop') return false;
  if (e.repeat) return false;
  const binding = activeBinding();
  if (!isLocalToggleKey(e) && !(binding && bindingMatches(binding, e))) return false;
  e.preventDefault();
  e.stopPropagation();
  setOpen(!open);
  return true;
}

/** 宿主页 keydown 监听体(capture 阶段; 函数引用稳定, 便于 dispose 时精确解绑)。 */
function onHostKey(e) { toggleByKey(e); }

// 侧栏入口按钮(footer.action 槽; wide=侧栏展开态显示文字)
function Toggle(props) {
  const wide = props && props.wide;
  const isOpen = useOpen();
  return h('button', {
    style: {
      display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
      padding: '6px 12px', margin: '2px 0', borderRadius: 8, cursor: 'pointer', border: 'none',
      color: 'var(--dsw-alias-text-l1, #e8e8e8)', fontSize: 13, textAlign: 'left',
      background: 'transparent',
    },
    title: 'Touchstone 测试平台（Alt+T 开关）',
    onClick: () => setOpen(!isOpen),
  }, wide ? (isOpen ? '🧪 关闭 Touchstone' : '🧪 Touchstone') : '🧪');
}

// 关闭按钮自动隐藏(2026-10-03): 常显会盖住被嵌 SPA 侧栏底部的用户名, 所以平时完全隐藏,
// 只在「鼠标靠近左下角热区」或「面板刚打开(先亮一下告诉用户按钮在哪)」时浮现, 离开后淡出。
// 关键点: iframe 铺满整个面板, 光标在 iframe 上的移动**不会**冒泡到宿主页 —— 但 iframe 与
// 宿主同源(/touchstone/app), 宿主可直接在 iframe 的 document 上挂 mousemove。挂不上
// (跨域/加载异常)时退回常显, 绝不出现「隐形又找不到」的按钮。
const CLOSE_ZONE_W = 150;   // 左下角热区宽(px, 自面板左缘起算)
const CLOSE_ZONE_H = 110;   // 左下角热区高(px, 自面板底缘起算)
const CLOSE_HIDE_MS = 600;  // 离开热区后淡出延时
const CLOSE_PEEK_MS = 2600; // 面板打开后先显示多久(教学用户按钮位置)

// ── 面板 ↔ 内嵌 SPA 的消息桥(2026-10-04) ─────────────────────────────────────
// 内嵌的 Touchstone SPA(同源 iframe) 要把卡片主会话「弹出」到 dsh 主界面: dsh 的客户端
// 服务(uiWorkspace.openSession)只在宿主页上下文里可用, iframe 自己拿不到, 故走约定
// postMessage(协议常量与 webui/src/lib/dshHost.js **逐字一致**, 两侧必须同步改):
//   iframe → 宿主  { type: 'touchstone:host-probe' }                      探测宿主能力
//   宿主 → iframe  { type: 'touchstone:host-caps', caps: { openSession } } 应答(能力位)
//   iframe → 宿主  { type: 'touchstone:open-session', sid }               请求在 dsh 打开会话
// 安全: 只认「本面板 iframe 的来源窗口 + 同源 origin」的消息(宿主页里还有别的插件消息);
// 宿主半拿不到 uiWorkspace 时能力位 false ⇒ SPA 侧按钮不渲染(不是点了没反应)。
const MSG_PROBE = 'touchstone:host-probe';
const MSG_CAPS = 'touchstone:host-caps';
const MSG_OPEN = 'touchstone:open-session';
let uiWorkspace = null; // dsh 会话/工作区导航服务(未就绪时 null)

/** 挂面板消息桥(仅面板打开期间有效)。
 * @param el - 面板 iframe 元素(同源嵌入插件版 SPA)。
 * @returns 解绑函数(面板关闭/卸载时调用)。 */
function attachPanelBridge(el) {
  if (!el) return () => {};
  const onMessage = (e) => {
    // 来源窗口必须是本面板 iframe 且同源; 其余一律忽略
    if (e.source !== el.contentWindow || e.origin !== window.location.origin) return;
    const data = e.data || {};
    if (data.type === MSG_PROBE) {
      e.source.postMessage({ type: MSG_CAPS, caps: { openSession: !!uiWorkspace } }, e.origin);
      return;
    }
    if (data.type !== MSG_OPEN) return;
    const sid = typeof data.sid === 'string' ? data.sid.trim() : '';
    if (!sid || !uiWorkspace) return;
    try {
      // 与 dsh 侧栏点会话同一路径(会话控制器 retain mainView + 选中主面板)
      uiWorkspace.openSession(sid);
      setOpen(false); // 弹出语义: 关掉全屏浮层, 露出 dsh 主界面上的该会话
    } catch (error) {
      // 打不开(会话不存在/已归档等)就留在面板里, 用户视角仍停在自己刚点的卡片上
      console.warn('[touchstone] 在 dsh 打开会话失败:', error);
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

// ── 面板入口(2026-10-07) ─────────────────────────────────────────────────────
// 面板 iframe 只在「本会话第一次打开」时建一次, 之后常驻(关闭只隐藏, 见 Panel)。
// 建时的入口路径优先取内嵌 SPA 记下的「上次所在页面」—— 覆盖「dsh 宿主页刷新/重开」
// 这一档: 那时 iframe 必须重建, 但用户仍希望回到切走前的页面。
// 只认本插件前缀的绝对路径; 空值/异前缀/插件根('/touchstone/' 会 302 到根相对 /app,
// 在 dsh 宿主上跳出插件)一律回落 /touchstone/app。
/** 取面板 iframe 的入口路径(localStorage 脏值一律回落缺省入口)。 */
function panelEntry() {
  try {
    const raw = localStorage.getItem(ROUTE_KEY) || '';
    if (raw.startsWith('/touchstone/') && raw !== '/touchstone/') return raw;
  } catch { /* 隐私模式等场景忽略 */ }
  return '/touchstone/app';
}

// 全屏面板: 无顶栏(iframe 吃满全屏) + 关闭按钮悬浮在左下角(位置与 dsh 侧栏入口一致)
// iframe 同源, /touchstone/app 经薄壳反代到 server.py 的插件版 SPA
function Panel() {
  const isOpen = useOpen();
  // 保活(2026-10-07): 打开过就在 DOM 里常驻, 关闭只把容器 display:none —— iframe 一旦
  // 从 DOM 摘掉, 内嵌 SPA 整篇文档就没了, 再打开是全新加载(路由/弹窗/滚动/未提交输入全丢)。
  // mounted 由「打开过」与「当前打开」合成: 首次打开的那一次渲染就带上 iframe(不等 effect
  // 二次渲染, 否则同一次提交里挂载的 effect 看不到 iframe ref)。
  const [everOpened, setEverOpened] = React.useState(isOpen);
  const mounted = everOpened || isOpen;
  const [hover, setHover] = React.useState(false);   // 按钮自身 hover 反馈(内联样式写不了 :hover)
  const [shown, setShown] = React.useState(true);    // 自动隐藏: 当前是否显示
  const [zoneOk, setZoneOk] = React.useState(false); // iframe 同源可达 => 走自动隐藏, 否则常显
  const iframeRef = React.useRef(null);
  const [entry] = React.useState(panelEntry);        // iframe 入口: 只在首次挂载时取一次

  // 打开过就记下(常驻判据), 与开合解耦
  React.useEffect(() => {
    if (isOpen && !everOpened) setEverOpened(true);
  }, [isOpen, everOpened]);

  // 打开面板: 先亮 CLOSE_PEEK_MS, 之后交给热区逻辑收口
  React.useEffect(() => {
    if (!isOpen) return undefined;
    setShown(true);
    const t = setTimeout(() => setShown(false), CLOSE_PEEK_MS);
    return () => clearTimeout(t);
  }, [isOpen]);

  // 关闭面板: 把焦点交还宿主页 —— 2026-10-07 实测, 隐藏(display:none)的 iframe 仍会
  // 独吞键盘事件(document.activeElement 仍指向它、按键派发给它的文档), 不交还的话
  // 宿主页的 Alt+T 再也收不到, 面板就「按不开」了。
  React.useEffect(() => {
    if (isOpen) return undefined;
    const el = iframeRef.current;
    if (!el) return undefined;
    try {
      if (document.activeElement === el && typeof el.blur === 'function') el.blur();
      if (document.body && typeof document.body.focus === 'function') document.body.focus();
    } catch { /* 焦点交还失败不影响面板本体 */ }
    return undefined;
  }, [isOpen]);

  // 同源 iframe 内监听光标: 进左下角热区 => 显示; 离开热区 => 延时淡出
  React.useEffect(() => {
    if (!isOpen) return undefined;
    const el = iframeRef.current;
    if (!el) return undefined;
    let doc = null;
    let pending = null;
    const reveal = () => { clearTimeout(pending); setShown(true); };
    const conceal = () => { clearTimeout(pending); pending = setTimeout(() => setShown(false), CLOSE_HIDE_MS); };
    const onMove = (e) => {
      const inZone = e.clientX <= CLOSE_ZONE_W && e.clientY >= el.clientHeight - CLOSE_ZONE_H;
      if (inZone) reveal(); else conceal();
    };
    const detach = () => {
      if (!doc) return;
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseleave', conceal);
      doc = null;
    };
    // 每次 load 重新挂载(初次附到 about:blank 上无副作用, 真文档就绪后由 load 事件接管)
    const attach = () => {
      detach();
      try { doc = el.contentDocument; } catch { doc = null; }
      if (!doc) { setZoneOk(false); return; } // 跨域等: 退回常显
      setZoneOk(true);
      doc.addEventListener('mousemove', onMove);
      doc.addEventListener('mouseleave', conceal);
    };
    attach();
    el.addEventListener('load', attach);
    return () => { clearTimeout(pending); el.removeEventListener('load', attach); detach(); };
  }, [isOpen, mounted]);

  // 面板内按键: iframe 里的 keydown 不会冒泡到宿主页, 必须挂在 iframe 自己的 document 上。
  // 这层监听**不随开合解绑**(与上面的热区监听不同): 关闭态 iframe 仍可能持有焦点,
  // 那时按键照样派发给它的文档(实测), 监听还在才能用 Alt+T 把面板按回来。
  React.useEffect(() => {
    if (!mounted) return undefined;
    const el = iframeRef.current;
    if (!el) return undefined;
    let doc = null;
    const onKey = (e) => { toggleByKey(e); };
    const detach = () => {
      if (!doc) return;
      doc.removeEventListener('keydown', onKey, true);
      doc = null;
    };
    const attach = () => {
      detach();
      try { doc = el.contentDocument; } catch { doc = null; }
      if (doc) doc.addEventListener('keydown', onKey, true); // 同源 iframe 内也认快捷键
    };
    attach();
    el.addEventListener('load', attach);
    return () => { el.removeEventListener('load', attach); detach(); };
  }, [mounted]);

  // 面板打开期间挂宿主消息桥: iframe 里的 SPA 探能力 / 请求在 dsh 主界面打开会话
  React.useEffect(() => {
    if (!isOpen) return undefined;
    return attachPanelBridge(iframeRef.current);
  }, [isOpen, mounted]);

  if (!mounted) return null; // 从没用过面板的会话零开销(首次打开才建 iframe)
  const visible = !zoneOk || shown; // 自动隐藏不可用时(zoneOk=false)保持常显
  return h('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--dsw-alias-bg-base, #161617)',
      display: isOpen ? 'block' : 'none', // 关闭 = 只隐藏: iframe 与内嵌 SPA 常驻(保活)
    },
  },
    h('iframe', {
      ref: iframeRef, src: entry, title: 'Touchstone',
      style: { display: 'block', width: '100%', height: '100%', border: 'none' },
    }),
    h('button', {
      style: {
        position: 'absolute', left: 12, bottom: 12, zIndex: 1,
        width: 34, height: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: '50%', cursor: 'pointer', fontSize: 14, lineHeight: 1,
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.16))' : 'var(--dsw-alias-bg-layer-2, rgba(40,40,42,0.92))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18))',
        boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        opacity: visible ? (hover ? 1 : 0.9) : 0,
        pointerEvents: visible ? 'auto' : 'none', // 隐藏时不拦截点击(点击照常落到被嵌页面)
        transition: 'opacity 160ms ease, background 120ms ease',
      },
      title: '关闭 Touchstone 面板',
      onMouseEnter: () => { setHover(true); setShown(true); }, // 已浮现时悬停不因热区抖动而消失
      onMouseLeave: () => setHover(false),
      onClick: () => setOpen(false),
    }, '✕'));
}

// cordis 客户端插件入口: 等 slots 服务就位后注册两个 UI 槽, 再挂快捷键
function apply(ctx) {
  const slots = ctx.get('slots');
  if (!slots) return;
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'touchstone-toggle' },
    (props) => h(Toggle, { wide: props && props.wide }),
  ));
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'touchstone-panel' },
    () => h(Panel),
  ));

  // ① 官方快捷键注册(可选服务): 进 dsh「设置 → 快捷键」目录, 可见/可改键/参与冲突校验。
  //    注册失败(键位冲突、白名单不合规等)只告警 —— 快捷键是增强, 绝不能拖垮面板本体。
  ctx.inject(['shortcuts'], (sctx) => {
    try {
      shortcuts = sctx.shortcuts;
      sctx.effect(() => sctx.shortcuts.register({
        id: COMMAND_ID,
        label: () => COMMAND_LABEL,
        aliases: ['touchstone', '测试平台', '面板'],
        // 键位矩阵: desktop 三档纯 Alt+T(官方允许, 原生键盘桥接管);
        // Web 只声明白名单放行的组合 —— web:linux 白名单只放行三组固定组合, 故不声明,
        // 该档由 ② 的自管 Alt+T 兜底。
        defaults: {
          'desktop:macos': { code: KEY_CODE, modifiers: ['alt'] },
          'desktop:windows': { code: KEY_CODE, modifiers: ['alt'] },
          'desktop:linux': { code: KEY_CODE, modifiers: ['alt'] },
          'web:macos': { code: KEY_CODE, modifiers: ['primary', 'alt'] },
          'web:windows': { code: KEY_CODE, modifiers: ['primary', 'alt'] },
        },
        regions: ['page', 'editable'], // 聊天输入框里也认(终端 xterm 不抢)
        modals: [],
        resolve: () => ({ status: 'handled', run: () => setOpen(!open) }),
      }), 'touchstone: 快捷键');
    } catch (error) {
      shortcuts = null;
      console.warn('[touchstone] 快捷键注册失败（面板不受影响）:', error);
    }
  });

  // ② 宿主页自管键: capture 阶段监听, 命中 Alt+T 即吞掉, 不留默认行为。
  ctx.effect(() => {
    document.addEventListener('keydown', onHostKey, true);
    return () => document.removeEventListener('keydown', onHostKey, true);
  });

  // ③ dsh 会话/工作区导航服务: 面板内嵌 SPA 的「在 dsh 打开主会话」要用它
  //    (服务未就绪/不存在时 uiWorkspace 保持 null ⇒ 能力位 false ⇒ SPA 侧按钮不渲染)。
  ctx.inject(['uiWorkspace'], (sctx) => {
    uiWorkspace = sctx.uiWorkspace || null;
  });
}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
