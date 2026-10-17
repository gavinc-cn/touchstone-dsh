/**
 * 飞书配置读助手（M7-R1；`feishu.py:31-145` 常量/`user_config`/`notify_events`/`hook_of`
 * 与 `:1053-1071` 的 `app_config`/`inbound_status` 的对应物）。
 *
 * **本文件的职责边界：只做「读配置 / 选目的地」**——取用户级配置、判定项目级事件闸门、
 * 算出群 webhook 目的地、报告入站连接状态。**不渲染通知文案、不投递、不发任何网络请求**：
 * 渲染与出站属 `backend/lib/feishu.js`（后续 R2 车道），本文件不碰。这与 Python 的分工
 * 一字不差：`user_config`/`app_config`/`notify_events`/`hook_of`/`inbound_status` 全是纯读，
 * 发送线程（`feishu.py:2599+`）与 REST（`:1039+`）在别的函数里。
 *
 * 零 npm 依赖（只用 `./db.js` 的读口）。
 *
 * 与 Python 的形态差异（有意，逐条登记）：
 *   - 常量在 Python 是 tuple，这里用**冻结数组**（保序、可迭代，语义最接近）；对拍按元素比。
 *   - `notify_events` 在 Python 返回 `set[str]`，这里返回 **`Set`**（同构；顺序为
 *     `FEISHU_EVENTS` 的过滤序，Python set 无定义序——按集合语义比，别比顺序）。
 *   - 纯读函数末位多一个 `options = {db, dbPath, env}`（与 `db.js` 既有读口同形），
 *     逐层透传给 db 访问函数。
 *   - 非 dict 的 `feishu_user_cfgs.json`（手工改库才会出现）：Python 会在 `cfg.get(...)`
 *     上抛 `AttributeError`，这里 `appConfig` 回 `null`（宽松）。属**已知分歧**，登记在
 *     M7-R1 未验项里；`hookOf` ／ `notifyEvents` 走的 `dictGet` 对 `null` 同样抛 TypeError。
 *
 * 【M7.5 接缝 —— 入站线程注册表】`inboundStatus` 依赖入站线程注册表（`feishu.py:1608`
 * 的 `_WS_THREADS`），而入站 WS 长连接是 **M7.5** 才做的。本文件先把**注册表本体与
 * 注册/注销接口**（`setInboundThread` / `clearInboundThread`）摆好：
 *   - 注册表值的契约 = 与 Python `threading.Thread` 同形的 `{ isAlive(): boolean }`；
 *     M7.5 的 WS 客户端句柄用一个两行适配器套上再注册（或直接给它加 `isAlive()`）。
 *   - **今天没有任何注册方** ⇒ `inboundStatus(userId).thread` 必然是 `false`。这是
 *     **当前线程模型的正确返回，不是占位假值**（等价于 Python 进程刚起来、还没
 *     `start_inbound_for` 时的形态：`_WS_THREADS` 空 ⇒ `thread=False`）。
 *   - M7.5 要往里塞真状态：照 `feishu.py:1632-1643` 的 `start_inbound_for` 实现，
 *     成功拉起后 `setInboundThread(userId, handle)`；并保留同一条判据
 *     （`cur.is_alive()` 为假 = 需要重拉；凭据缺失不拉）。线程退出后 Python 侧条目
 *     残留、靠 `is_alive()` 判死 ⇒ 这里同形（不自动清扫），差别只是 Node 要显式注销。
 *   - 未覆盖：本文件不实现 `start_inbound_all()` 的遍历拉起（M7.5）。
 */
import { getFeishuHook, getFeishuUserCfg, getProject } from './db.js';

/** 全部可选事件类别（对齐 `feishu.FEISHU_EVENTS`(feishu.py:31)，顺序即渲染/对拍顺序） */
export const FEISHU_EVENTS = Object.freeze([
  'blocked_interaction', 'task_failed', 'card_review',
]);

/**
 * 未单独绑定项目时的默认事件集（对齐 `feishu.FEISHU_DEFAULT_EVENTS`(feishu.py:35)）：
 * 交互等待/任务失败开、卡片待审核默认关——与设置页 `GET /api/projects/<pid>/feishu-hook`
 * 的默认回显一致；2026-10-10 前回落分支写死全事件，那是「界面未勾选却实际会推」的实障来源。
 */
export const FEISHU_DEFAULT_EVENTS = Object.freeze(['blocked_interaction', 'task_failed']);

/** 入站线程注册表（`user_id` → 线程形对象；对齐 `feishu._WS_THREADS`，见文件头 M7.5 接缝） */
const INBOUND_THREADS = new Map();
/**
 * `user_id` → **拉起该线程时**用的 app_id（对齐 `feishu._WS_APP_ID`，M10 2026-10-17）。
 * 为什么需要：lark SDK 无干净停止 ⇒ 换凭据后旧连接仍在跑、只有重启站点才换；
 * doctor 靠它判「线程绑的应用 ≠ 配置里的应用」，否则那一项会一直假绿。
 */
const INBOUND_APP_IDS = new Map();

/**
 * Python 真值口径（`""`/`0`/`None`/`False`/空容器为假）。
 * JS 的 `[]`/`{}` 是 truthy，`if (x)` 直接写会与 oracle 分叉，故显式收口。
 * @param {unknown} value
 * @returns {boolean}
 */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Python `dict.get(key, default)`：**键存在但值为 None 时返回 None**（不是 default）。
 * 直接写 `obj[key] ?? dflt` 会把 None 折成 default，与 oracle 分叉（`default_secret: null`）。
 * @param {object} dict
 * @param {string} key
 * @param {any} [dflt]
 * @returns {any}
 */
function dictGet(dict, key, dflt = undefined) {
  return Object.hasOwn(dict, key) ? dict[key] : dflt;
}

/**
 * Python `str.rstrip("/")`：只削尾部的 `/`（不是 `db.js:pyRstrip` 的空白口径）。
 * 非字符串抛 TypeError（Python 在非 str 上是 `AttributeError`——两边都是响亮失败，
 * 只是异常类型不同，登记为已知分歧）。
 * @param {unknown} value
 * @returns {string}
 */
function rstripSlashes(value) {
  if (typeof value !== 'string') {
    throw new TypeError('base_url 必须是字符串（Python 侧非 str 会抛 AttributeError）');
  }
  return value.replace(/\/+$/, '');
}

/**
 * 用户飞书配置（`feishu_user_cfgs` 表；enabled/base_url/默认 webhook/应用凭据）。
 * 对齐 `feishu.user_config`(feishu.py:72)——就是 `db.get_feishu_user_cfg` 的薄封装。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object}
 */
export function userConfig(userId, options = {}) {
  return getFeishuUserCfg(userId, options);
}

/**
 * 用户自建应用凭据（配置里的 `app_id` + `app_secret`）；任一缺失（或假值）返回 `null`。
 * 对齐 `feishu.app_config`(feishu.py:1053)：入站长连接与 REST 均以用户自己的应用为主体。
 * 注意返回的是**整个配置对象**（不是只挑两个键）——调用方按需取键。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function appConfig(userId, options = {}) {
  const cfg = userConfig(userId, options);
  if (pyTruthy(cfg.app_id) && pyTruthy(cfg.app_secret)) return cfg;
  return null;
}

/**
 * 项目级推送事件闸门（**全通道共用**），对齐 `feishu.notify_events`(feishu.py:78)。
 *
 * 口径（先到先算，逐条照抄）：
 *   1. 先看**用户级总控** `push_enabled`（缺键按开）：关 ⇒ 空集，一票否决（项目行开着也静默）；
 *   2. 有绑定行：`enabled=0` ⇒ 空集（显式关闭，不回落用户配置）；否则取行内勾选的事件
 *      （`row.events` 是逗号拼接串，按 `FEISHU_EVENTS` 全集过滤，未知类别自动丢）；
 *      行内勾空 ⇒ 空集（＝都不推）；
 *   3. 无绑定行：回落项目所有者的 `FEISHU_DEFAULT_EVENTS`，并受用户级旧开关 `enabled`
 *      （缺键按开）约束；项目被删（取不到 owner）时按 `user_id=0` 的配置判定。
 *
 * 返回 `Set<string>`；空集 = 该项目不推任何事件（调用方据此短路，见 `hookOf`）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Set<string>}
 */
export function notifyEvents(projectId, options = {}) {
  const row = getFeishuHook(projectId, options);
  const proj = getProject(projectId, options);
  const ownerId = proj ? proj.user_id : 0;
  const cfg = userConfig(ownerId, options);
  if (!pyTruthy(dictGet(cfg, 'push_enabled', true))) return new Set();   // 总控：一票否决
  if (row !== null) {
    if (!pyTruthy(row.enabled)) return new Set();
    const events = row.events || '';
    return new Set(FEISHU_EVENTS.filter((event) => events.includes(event)));
  }
  if (!pyTruthy(dictGet(cfg, 'enabled', true))) return new Set();
  return new Set(FEISHU_DEFAULT_EVENTS);
}

/**
 * 项目推送**群 webhook 目的地**，对齐 `feishu.hook_of`(feishu.py:117)。
 * 绑定行 URL 优先；行内无 url（或无绑定行）时回落**项目所有者**的用户级默认 webhook
 * （回落要求其总开关 `enabled` 开着且配了 `default_webhook`）。
 *
 * 返回 `{target, secret, events, base_url, user_id}` 或 `null`（不推）。三处易错点照抄：
 *   - 事件闸门**只**由 `notifyEvents` 决定，空集直接 `null`（回落分支同样尊重项目勾选）；
 *   - `base_url` 只在项目存在时算（项目被删 ⇒ 空串），且取 `rstrip("/")` 后的值；
 *   - 回落的 `secret` 用 `dictGet(cfg, "default_secret", "")`（键存在但为 null ⇒ 回 null，
 *     不是 ""——Python `.get(k, d)` 的语义）。
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{target: string, secret: any, events: Set<string>, base_url: string,
 *            user_id: number}|null}
 */
export function hookOf(projectId, options = {}) {
  const events = notifyEvents(projectId, options);
  if (events.size === 0) return null;
  const row = getFeishuHook(projectId, options);
  const proj = getProject(projectId, options);   // 所有者为 0 时（项目被删）回落 userConfig(0)
  const ownerId = proj ? proj.user_id : 0;
  const baseUrl = proj ? rstripSlashes(userConfig(ownerId, options).base_url || '') : '';
  if (row !== null && row.webhook_url) {
    return {
      target: row.webhook_url,
      secret: row.webhook_secret || '',
      events,
      base_url: baseUrl,
      user_id: ownerId,
    };
  }
  const cfg = userConfig(ownerId, options);
  if (!pyTruthy(dictGet(cfg, 'enabled', true))) return null;
  if (!pyTruthy(dictGet(cfg, 'default_webhook'))) return null;
  return {
    target: dictGet(cfg, 'default_webhook'),
    secret: dictGet(cfg, 'default_secret', ''),
    events,
    base_url: baseUrl,
    user_id: ownerId,
  };
}

/**
 * 用户入站长连接状态摘要（设置页展示用），对齐 `feishu.inbound_status`(feishu.py:1062)：
 * `configured` = 应用凭据齐全（`appConfig` 非 null）；`thread` = 注册表里的线程还活着。
 *
 * `thread: true` 只代表线程还在 `client.start()` 内（SDK 内置重连），连接失败细节看 server.log。
 * **形状是 `GET /api/me/feishu-cfg` 响应的子对象 ⇒ 只许这两键**（「线程绑的哪个应用」
 * 不放进这里，见 `inboundThreadAppId`；加键会改对外契约，node 的形状判据当场会红）。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{configured: boolean, thread: boolean}}
 */
export function inboundStatus(userId, options = {}) {
  const cfg = appConfig(userId, options);
  const thread = INBOUND_THREADS.get(userId);
  return {
    configured: cfg !== null,
    thread: thread !== undefined && thread !== null && Boolean(thread.isAlive()),
  };
}

/**
 * **拉起入站线程时**用的 app_id（对齐 `feishu.inbound_thread_app_id`，M10 2026-10-17）：
 * 换凭据后旧连接仍在跑、只有重启站点才换 ⇒ doctor 靠它判「线程绑的应用 ≠ 配置里的应用」
 * 的假绿。空串 = 本进程没为该用户拉过线程 ⇒ 调用方不许据此告警。
 * 刻意**不并进 `inboundStatus`**：那是 `GET /api/me/feishu-cfg` 的响应子对象。
 * @param {number} userId
 * @returns {string}
 */
export function inboundThreadAppId(userId) {
  return INBOUND_APP_IDS.get(userId) || '';
}

/**
 * 【M7.5 接缝】登记某用户的入站线程（对齐 `feishu._WS_THREADS[user_id] = t`，feishu.py:1643）。
 * 值的契约：`{ isAlive(): boolean }`（与 `threading.Thread` 同形）。幂等覆盖，不校验重复。
 * @param {number} userId
 * @param {{isAlive: () => boolean}} thread
 * @param {string} [appId] 拉起该线程时用的 app_id（对齐 `feishu._WS_APP_ID[user_id]`）
 */
export function setInboundThread(userId, thread, appId = '') {
  INBOUND_THREADS.set(userId, thread);
  INBOUND_APP_IDS.set(userId, appId || '');
}

/**
 * 【M7.5 接缝】注销某用户的入站线程（线程退出/凭据被清时调用）。
 * Python 侧没有对应动作（daemon 线程退出后条目残留、靠 `is_alive()` 判死）；
 * 这里是 Node 侧更诚实的等价物，`inboundStatus` 的返回形态不变。
 * @param {number} userId
 */
export function clearInboundThread(userId) {
  INBOUND_THREADS.delete(userId);
  INBOUND_APP_IDS.delete(userId);
}

/**
 * 【M11 接缝】取某用户当前登记的入站 runner（**内部用**：M11 起要在进程内停连接，
 * `isAlive()` 不够——得拿到 runner 背后的 ws 客户端，见 `feishu_inbound.js:stopInboundFor`）。
 * Python 侧没有对应函数：那边直接读模块级 `_WS_THREADS`/`_WS_CLIENTS` 两个字典。
 * **不并进 `inboundStatus`**（那是 `GET /api/me/feishu-cfg` 的响应子对象，形状只许两键）。
 * @param {number} userId
 * @returns {{isAlive: () => boolean}|null}
 */
export function inboundRunner(userId) {
  return INBOUND_THREADS.get(userId) || null;
}
