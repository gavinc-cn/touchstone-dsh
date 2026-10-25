/**
 * 路由分派 —— `server.py` 的 `do_GET` / `_route_get`（以及 M3 起逐步补齐的
 * `do_POST` / `do_PATCH` / `do_DELETE`）在 Node 侧的对应物。
 *
 * ## 为什么要有这张表，而不是在 server.js 里写 if/elif
 * Python 侧的路由是**顺序敏感**的 if/elif 链：字面路径在前、正则链在后，同一前缀的
 * 「更具体者必须先匹配」（`/api/projects/dup_check` 与 `/api/projects/<id>`、
 * `/board/trash` 与 `/board/<fid>` …）。顺序写错不会报错，只会静默走到错误分支。
 * 把顺序收在**一个**文件里（表即顺序），各族的实现者只往自己的文件里追加条目，
 * 就不会出现「两个人各改一段、合并后顺序变了」这种最难查的错。
 *
 * ## 条目契约（每个 `routes/<族>.js` 导出 `routes` 数组）
 * ```js
 * { method: 'GET',                           // 缺省 'GET'；写路径用 'POST'/'PATCH'/'DELETE'
 *   path: '/api/auth/me',                    // 字面路径（与 re 二选一）
 *   re: /^\/api\/projects\/(\d+)$/,          // 正则（等价 Python `re.match`，锚定开头）
 *   handler: async (ctx, m) => { ... } }     // m = 正则匹配结果（无正则时为 null）
 * ```
 * 表内顺序 = 匹配顺序；跨模块的拼接顺序固定为 `admin → projects → tasks → board →
 * sessions`（各族前缀互不重叠，组内保持 Python 的先后即可）。
 *
 * ## `ctx`（handler 的全部输入）
 * - `req` / `res`：`node:http` 原始对象（SSE 要用）
 * - `db`：已打开的数据库句柄（`node:sqlite` DatabaseSync）
 * - `user`：当前用户行（信任头或 cookie 会话；`/api/*` 走到这里必非空）
 * - `trusted`：本次请求是否带薄壳反代注入的免登信任头（`server.py:_trusted_admin_request`）。
 *   等价 admin 全权，故以它为据的放行（`change_password` 免原口令）不新增任何权限面；
 *   缺省 `false`（公开端点分支显式传 `false`）
 * - `path`：**不含查询串**的路径；`query`：`parseQs()` 结果（Python `parse_qs` 口径）
 * - `q(name, def)`：`parsed.get(name, [def])[0]` 的对应物
 * - `lang`：本条请求的界面语言（`'zh'|'en'`，见 `requestLang()`；首次读取时才解析并缓存）
 * - `json(status, obj)` / `error(status, msg, vars?)` / `text(status, body, type)` /
 *   `file(path, type)` / `redirect(loc)` / `sse(opts)`：响应写口（口径全在 `lib/http.js`）。
 *   `error` / `errorSpaced` 会把字符串文案按 `ctx.lang` 过一遍 `t('api', …)`（缺失回落中文），
 *   两种正文的字节形状不变；第三个参数 `vars` 供带 `{name}` 占位符的词条插值。
 *   **lib 错误透传契约（T10 R18）**：`error`/`errorSpaced` 也接受 `backend/lib/*` 的
 *   `Error`（按 `.i18nKey`/`.i18nVars` 本地化）与 `messageVars()` 返回的
 *   `{message, vars}` 对象；路由层把 lib 的错误值原样传进来即可，不要再先 `String()`。
 * - `ownedProject(id)` / `ownedTask(id)`：Python `_owned_project` / `_owned_task`，
 *   不存在或越权时**已经回过 404**，返回 `null`，调用方直接 return（多用户隔离红线）
 *
 * ## 数据层调用口径（M3 约定，`lib/db.js` 文件头同步）
 * M3 起的读口是**自由函数 + 末位可选 `{dbPath, db, env}`**：不传就按 `defaultDbPath()`
 * 自开短连接（与 Python `with connect()` 同形），传 `{db}` 则复用调用方的常驻句柄。
 * 路由层一律传 `{ db: ctx.db }`（服务器已开好一个常驻连接，省掉每请求多次 open/close）。
 * M1 的五个 auth 函数（`getUserByName(db, ...)` 等）是**首参句柄**形态，保持不动。
 */
import { openSse, readJsonBody, respond, respondError, respondErrorSpaced, respondJson, sendFile,
  sendRedirect } from '../lib/http.js';
import { agentFamily } from '../lib/agents.js';
import { StateCache } from '../lib/casescan.js';
import * as dbmod from '../lib/db.js';
import { isI18nDisabled, resolveLang, resolveLangSignal, t } from '../lib/i18n.js';
import { parseQs, qsGet } from '../lib/query.js';

import { routes as adminRoutes } from './admin.js';
import { routes as agentRoutes } from './agents.js';
import { routes as assetRoutes } from './assets.js';
import { routes as boardRoutes } from './board.js';
import { routes as feishuRoutes } from './feishu.js';
import { routes as feishuAppRoutes } from './feishu_app.js';
import { routes as feishuHookRoutes } from './feishu_hook.js';
import { routes as projectRoutes } from './projects.js';
import { routes as sessionRoutes } from './sessions.js';
import { routes as taskRoutes } from './tasks.js';

/**
 * 全表（顺序即匹配顺序，见文件头）。
 *
 * M6-6 新增两族（`agents` 三条探测 + `builtin-assets` 两条），插在 admin 之后：
 * 位置照 `server.py` 的 `_route_get` 字面路径段（`/api/admin/rag`(1324) →
 * `/api/builtin-assets`(1326) → `/api/agents/*`(1330-1338) → `/api/projects`(1346)）。
 * 三族前缀互不重叠，故顺序本身不影响分派结果——照抄只为「表即顺序」这条契约可读。
 */
export const ROUTES = [
  ...adminRoutes,
  ...assetRoutes,
  ...agentRoutes,
  ...projectRoutes,
  ...taskRoutes,
  ...boardRoutes,
  ...sessionRoutes,
  // M7 追加（`feishu_hook.js` 三条：项目推送绑定）——**只追加、不重排**：
  // 该族前缀（`/api/me/feishu-hook/apply` 字面量 + `/api/projects/<n>/feishu-hook`）与既有
  // 七族任何条目都不重叠（`^/api/projects/(\d+)$`、`/board/*`、`/bugs/*` 都吞不掉它），
  // 故挂表位置对分派结果无影响；放末尾是为了让既有条目的相对顺序一个字节都不动。
  ...feishuHookRoutes,
  // M7 续追加（`feishu.js` 个人配置/绑定族 7 条 + `feishu_app.js` 应用面 6 条）——
  // 同样**只追加、不重排**，两条新族与此前八族前缀互不重叠（`/api/me/feishu*` 三个前缀
  // 互不吞并：`-cfg`/`-bindcode` 是字面路径，`/api/me/feishu`、`/api/me/feishu/outbox`、
  // `/api/me/feishu/slash-commands`、`/api/me/feishu/provision`、`/api/me/feishu/doctor`、
  // `/api/me/feishu/reconnect`（M11.1）
  // 各由自己的匹配条目收口），故挂表位置对分派结果无影响。
  // 注：车道施工期间这两条暂时是空表（占位文件），全部落地后由本表原样生效。
  ...feishuRoutes,
  ...feishuAppRoutes,
];

/**
 * 本条请求是否命中**公开端点**（在鉴权之前分派，见 `server.js` 的公开端点分支）。
 *
 * 判据由 `ROUTES` 里标了 `public: true` 的条目**现算**（单一真相源）：`server.js` 不写死
 * 任何字符串，免得「加了公开端点却忘了改 server.js」这类错误只能靠实例级对拍发现。
 *
 * 对应 oracle `server.py:do_POST`(1027) 的开头两行——`/api/auth/login` 与
 * `/api/auth/register` 在 `_current_user()` **之前**就分派：未登录也必须能打（这正是
 * 「登录」的前提），且**不过强制改密闸**（闸在鉴权之后才调）。
 *
 * 匹配口径与 `dispatch` 完全一致（字面路径精确相等；正则照 `re.match` 只锚开头）。
 * @param {string} method HTTP 方法（大小写不敏感）
 * @param {string} path 不含查询串的路径
 * @returns {boolean}
 */
export function isPublicRoute(method, path) {
  const wanted = String(method || 'GET').toUpperCase();
  for (const route of ROUTES) {
    if (!route.public) continue;
    if ((route.method || 'GET') !== wanted) continue;
    if (route.path !== undefined) {
      if (route.path === path) return true;
      continue;
    }
    const match = route.re.exec(path);
    if (match && match.index === 0) return true;
  }
  return false;
}

/**
 * 全进程唯一的案例库聚合缓存（= `server.py` 的 `server.state_cache`）。
 *
 * 为什么要有这个导出（M4.5 修 M3 遗留）：M3 时 `routes/projects.js` 与 `routes/tasks.js`
 * **各建了一个 `StateCache`**（当时注释里已登记「L 把共享实例接进 ctx 之后应改掉」）。
 * 两实例在行为上等价（纯派生 + 1s TTL），但同一进程里同一份盘扫两遍，而 M4.5 的
 * `create_task` 要读 `state.library.stats.total` 当 `cases_base` 基线——三处消费者共用一份
 * 缓存才是 Python 的形态。写口唯一：`makeContext` 的 `stateCache` 参数（server.js 传入）。
 */
export const STATE_CACHE = new StateCache();

/**
 * 解析本条请求的界面语言：`X-TS-Lang` → `?lang=` → 用户偏好 → `'zh'`（见 `lib/i18n.js`）。
 *
 * 用户偏好是 T2 落库的形状：`user_prefs(project_id=0, key='lang', value={"v":"zh"|"en"})`，
 * `resolveLang` 内部认 `{v}` 包装。**读库顺序（T10 审查 Minor 3）**：先解析头/query 两档
 * 显式信号；命中就直接返回，**不读库**；只有两者都缺席（且 `TS_I18N≠0`）才读一次偏好。
 * 这样错误路径也不会为「已经由请求头决定语言」的调用多付一条索引查询。
 * 读库失败按「没有偏好」处理（错误响应不能因为偏好读不到再抛错）。
 *
 * 导出供 `server.js` 的「强制改密」403 使用：那条写点在 ctx 构造之前，必须回同一个语言。
 *
 * @param {{req?: object, db?: object, user?: object, search?: string}} parts
 * @returns {'zh'|'en'}
 */
export function requestLang({ req, db, user, search }) {
  const signal = resolveLangSignal({ headers: req && req.headers, query: search });
  if (signal !== null) return signal;
  if (isI18nDisabled()) return 'zh';          // 回滚开关：连偏好都不读
  let userPref = null;
  if (db && user && user.id !== undefined && user.id !== null) {
    try {
      const prefs = dbmod.getUserPrefs(user.id, 0, { db });
      userPref = prefs !== null && typeof prefs === 'object' ? prefs.lang : null;
    } catch {
      userPref = null;
    }
  }
  return resolveLang({ userPref });
}

/**
 * 「强制改密」403 的响应写点（`server.py:_must_change_pw_blocked` 的响应半边）。
 *
 * 为什么抽成导出函数：那条闸在 `makeContext` 之前（不能为它提前建 ctx），但语言解析与
 * 错误正文必须与 `ctx.error` **单一口径**。`server.js` 只负责判定与时机，响应拼装留在
 * 这里，单测就能用真 `requestLang` 钉住「头/query/偏好/回滚开关」四个维度。
 *
 * @param {object} res `node:http` 响应对象（`respondError` 的调用面）
 * @param {{req?: object, db?: object, user?: object, search?: string}} parts
 */
export function respondMustChangePassword(res, parts) {
  respondError(res, 403, t('api', '请先修改初始口令', requestLang(parts)));
}

/**
 * 构造一次请求的 ctx（见文件头契约）。
 * @param {{req: object, res: object, db: object, user: object, path: string, search: string,
 *          stateCache?: object, trusted?: boolean}} parts
 */
export function makeContext({ req, res, db, user, path, search, stateCache = STATE_CACHE,
  trusted = false }) {
  const query = parseQs(search);
  let bodyPromise = null;
  // 语言按请求惰性解析一次：见 requestLang() 的「成功路径零额外查询」说明。
  // 解析本身无副作用（只读 user_prefs），结果缓存在闭包里，同一条请求恒定。
  let langCache = null;
  /** 取（并按请求缓存）本条请求的界面语言；绝不抛错。 */
  const langOf = () => {
    if (langCache === null) langCache = requestLang({ req, db, user, search });
    return langCache;
  };
  /**
   * 错误文案本地化（T10 R18 扩展后的 key+vars 契约）：
   *   - 字符串：直接当 `t('api', …)` 的词条 key（固定文案即中文原文）；
   *   - 错误对象（`Error`）：词条 key 取 `i18nKey`（lib 用 `localizable()` 附加）或
   *     `.message`（固定文案），变量取 `i18nVars`；这样 lib 抛出的用户可见错误可整条
   *     英文化，而 `.message` 仍是渲染后的中文供日志使用；
   *   - `{message, vars}` 普通对象（lib 用 `messageVars()` 返回）：同样按 key+vars 渲染；
   *   - 其余非字符串原样返回，由 `respondError` 继续做既有的 `String(message)` 强制转换
   *     （语义不能变）。
   * @param {unknown} message
   * @param {object=} vars 占位符插值变量（显式传入时压过对象自带的 vars）
   * @returns {unknown}
   */
  const localize = (message, vars) => {
    if (typeof message === 'string') return t('api', message, langOf(), vars);
    if (message !== null && typeof message === 'object') {
      const isError = message instanceof Error;
      const carriesVars = Object.prototype.hasOwnProperty.call(message, 'vars');
      if ((isError || carriesVars) && typeof message.message === 'string') {
        const key = typeof message.i18nKey === 'string' ? message.i18nKey : message.message;
        const merged = vars !== undefined
          ? vars
          : (message.i18nVars !== undefined ? message.i18nVars : message.vars);
        return t('api', key, langOf(), merged);
      }
    }
    return message;
  };
  const ctx = {
    req,
    res,
    db,
    user,
    trusted,
    path,
    query,
    q: (name, def = '') => qsGet(query, name, def),
    stateCache,
    /** 本条请求的界面语言；getter 保证「首次读/首次发错误」时只解析一次。 */
    get lang() {
      return langOf();
    },
    /**
     * 读请求体（记忆化：一次请求只读一次，重复调用返回**同一个对象**）。
     *
     * 位置必须与 Python `do_POST` 的 `body = self._read_json() or {}`（server.py:1048）
     * 对齐——不是「想读就读」：
     *   - `/api/auth/logout`(1520) 在 Python 里**排在读体那行之前**且 handler 内部也不读，
     *     所以**不许调它**（`_api_logout` 全文没有 `_read_json`）；
     *   - `/api/auth/change_password`(1576) 虽然在读体那行之前分派，但**由 handler 自己读体**
     *     （`_api_change_password` 里 `data = self._read_json() or {}`，server.py:1578）——
     *     照 Python 的同一位置在 handler 内调用它。
     *     （2026-10-14 订正：本注释早先把这两条都写成「不读体」，与 oracle 不符；
     *     不读的后果是确定性的：新口令恒空 ⇒ 一律 400「新密码至少 6 位」。）
     *
     * 用法：`const body = await ctx.readBody();`（错误体两种形态的选择见 `ctx.error` 注释）。
     * **必须 await**：`lib/http.js:readJsonBody` 的异常（如非数字 Content-Length）若逃逸，
     * 会由 `dispatchSafely` 掐断这条连接——与 Python 抛 ValueError 只断该连接同形。
     */
    readBody: () => {
      if (bodyPromise === null) bodyPromise = readJsonBody(req);
      return bodyPromise;
    },
    json: (status, value) => respondJson(res, status, value),
    // 错误体两种形态，按 Python 该写点的实际写法选（不能统一！见 lib/http.js 的说明）：
    //   error       = 硬编码字节串口径 `{"error":"..."}`（无空格，Python 里 112 处）
    //   errorSpaced = `json.dumps({"error": ...})` 口径 `{"error": "..."}`（带空格，49 处）
    // 本地化只换 message 的值：两个 respond* 的拼装方式不变，故正文/头部的字节形状不变。
    error: (status, message, vars) => respondError(res, status, localize(message, vars)),
    errorSpaced: (status, message, vars) =>
      respondErrorSpaced(res, status, localize(message, vars)),
    text: (status, body, type = 'text/plain; charset=utf-8', extraHeaders = null) =>
      respond(res, status, body, type, extraHeaders || undefined),
    file: (filePath, type) => sendFile(res, filePath, type),
    redirect: (location) => sendRedirect(res, location),
    sse: (opts) => openSse(res, opts),
  };

  /** `server.py:_owned_project`：非本人或不存在的项目一律 404 `project not found` */
  ctx.ownedProject = (projectId) => {
    // db.js 读口签名（M3 约定）：自由函数 + 末位可选 `{db}`；传句柄即复用服务器的常驻连接
    const row = dbmod.getProject(projectId, { db });
    if (row === null || row === undefined || row.user_id !== user.id) {
      ctx.error(404, 'project not found');
      return null;
    }
    return row;
  };

  /**
   * `server.py:_owned_task`：任务不存在或其项目不归当前用户 ⇒ 404 `task not found`。
   *
   * **不能复用 `ctx.ownedProject`**（M3 实测踩中，由任务族实现者抓出）：Python 的
   * `_owned_project`（server.py:2142）**没有响应副作用**，只 `return None`；越权时
   * `_owned_task` 返回 None，由 `_api_get_task` 统一回 `task not found`。若这里借道
   * 会回 404 的 `ownedProject`，就会发出 `project not found` —— 既与 Python 文案不同
   * （对拍红），也让越权者能从文案差异反推「该任务确实存在」（**信息泄露**）。
   * 这里显式重做归属判定，只回 `task not found` 这一种文案。
   */
  ctx.ownedTask = (taskId) => {
    const row = dbmod.getTask(taskId, { db });
    if (row === null || row === undefined) {
      ctx.error(404, 'task not found');
      return null;
    }
    const owner = dbmod.getProject(row.project_id, { db });
    if (owner === null || owner === undefined || owner.user_id !== user.id) {
      ctx.error(404, 'task not found');
      return null;
    }
    return row;
  };

  /**
   * `server.py:_session_context`(4738)：session 接口公共上下文 =（任务行, 项目行, agent 归族）。
   *
   * **无响应副作用**（与 `_owned_task` 同款）：越权/不存在时三空，由调用方自己回 404
   * `task not found`——各会话端点的文案与时机不同，不许在这里统一回。
   *
   * `family` 的缺省值是 `'dsh_plugin'`（照 Python：项目行拿不到时也返回默认族）。
   * 归属判定走 `ownedTask` 吗？**不走**：`_session_context` 内部就是 `self._owned_task()`，
   * 而 `ctx.ownedTask` 会回 404 —— 那会让「越权」变成「已响应」，各端点随后再回一次
   * （同一响应上二次 writeHead ⇒ Node 抛 `ERR_HTTP_HEADERS_SENT`）。这里复刻纯判定。
   */
  ctx.sessionContext = (taskId) => {
    const task = dbmod.getTask(taskId, { db });
    if (task === null || task === undefined) return { task: null, project: null, family: null };
    const project = dbmod.getProject(task.project_id, { db });
    if (project === null || project === undefined || project.user_id !== user.id) {
      return { task: null, project: null, family: null };
    }
    return { task, project, family: agentFamily(project.agent_path) };
  };

  return ctx;
}

/**
 * 按表分派。命中并已响应返回 `true`；无命中返回 `false`（由调用方决定 404/静态回退）。
 *
 * 只在 `dispatchSafely` 内部使用；直接调用方要自己承担处理器异常（会变成
 * unhandledRejection 杀掉进程，见 `dispatchSafely`）。
 */
export async function dispatch(ctx) {
  const method = String(ctx.req.method || 'GET').toUpperCase();
  for (const route of ROUTES) {
    if ((route.method || 'GET') !== method) continue;
    let match = null;
    if (route.path !== undefined) {
      if (route.path !== ctx.path) continue;
    } else {
      match = route.re.exec(ctx.path);
      // Python `re.match` 只锚定开头；表里模式都以 ^ 起头，index!==0 视作不匹配
      if (!match || match.index !== 0) continue;
    }
    await route.handler(ctx, match);
    return true;
  }
  return false;
}

/**
 * `dispatch` 的**带兜底**版本（`server.js` 用这个）：处理器抛异常时只关掉这一条连接，
 * 服务继续跑。
 *
 * 为什么必须有（M3 实测，任务族实现者抓出）：Python 侧处理器抛异常时，`socketserver`
 * 的 `handle_error` 打一条 traceback 后 `shutdown_request` —— **只断这一条连接**，
 * 同一进程的后续请求照常 200。Node 侧若不兜，handler 里的异常会变成
 * `unhandledRejection` **杀掉整个后端进程**（实测：一个 `ReferenceError` ⇒ 进程没了 ⇒
 * 之后所有请求 connection refused）。这是「一个坏请求打挂整个站点」的可用性差异；
 * M4/M5 写路径上线后只会更容易触发，「已响应后再写」抛的 `ERR_HTTP_HEADERS_SENT`
 * 也走这条路。
 *
 * `res.destroy()` 对应 Python 的「掐断这条连接」：**不补发 500**（Python 也不发——
 * 异常路径走不到 `send_error`），客户端看到连接层错误，两版同形。
 */
export async function dispatchSafely(ctx, { logger = console } = {}) {
  try {
    return await dispatch(ctx);
  } catch (error) {
    // 留痕：没有这行日志，线上只会看到「请求莫名失败」，排障成本极高
    logger.error('touchstone-node: 处理器异常（只关这一条连接，服务继续）: '
      + `${(error && error.stack) || error}`);
    try {
      ctx.res?.destroy?.();
    } catch {
      // 连接可能已断：忽略
    }
    return true;                                  // 已接管这次请求（不会再补响应）
  }
}
