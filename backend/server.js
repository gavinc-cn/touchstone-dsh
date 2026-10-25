#!/usr/bin/env node
/**
 * Touchstone Node 后端 —— 入口（M0：进程契约 + HTTP/静态/SSE 骨架）。
 *
 * 为什么要有它：dsh 插件的后台现在要求用户机器上有 Python 3.12+ 与 pip，这是一键安装的
 * 真正障碍。Node 版与 Python 版**行为等价**、可同时运行、可逐项对拍（见
 * doc_ai/plan/202610/20261011_0835_Node后端重写与双轨共存改造方案.md）。M0 只交付骨架：
 * 薄壳能按同一份 argv 拉起它、面板能打开，业务端点随里程碑逐个补齐。
 *
 * 进程契约（方案 §3.2，薄壳 dsh-plugin/lib/index.js:481-502 是权威）：
 *   argv : <entry> --host 127.0.0.1 --port 0 --web-dir <repoDir>/webui/dist-plugin \
 *          --trust-internal-user --parent-watch
 *   stdout: 必须出现一行 `TOUCHSTONE_LISTEN <port>`（listen 成功后立刻写，**不要求首行**）
 *   stdin : 只读不写 ⇒ `--parent-watch` 时 EOF 即自行退出（父死感知，跨平台同码路径）
 *
 * M0 边界（有意为之，写进文档）：
 *   - 只实现 GET 读路径骨架；写路径在 M3–M5 落地。非 GET 统一 501（与 Python 同状态码，
 *     正文形状留待 M3 对齐）。
 *   - 会话解析属 M2；除 `/api/auth/me` 外的 `/api/*` 端点仍一律 404（M3 起逐个补齐）。
 *
 * M1 现状（2026-10-11）：
 *   - **同库单实例锁已接入**（`lib/lock.js`，语义对齐 Python `lifecycle.SingleInstance`）：
 *     启动时在 `<db>.lock` 上取 SQLite 排它锁（跨语言：Python 的 flock / sqlite3 与 Node 互斥），
 *     被真·另一实例占用则打印占用者并 **exit 3**（与 server.py 同码），`shutdown()` 里 release。
 *   - `--allow-shared-db` 因此成为真实逃生口（lib/args.js 已解析）。
 *   - **数据层已接线**（`lib/db.js`）：取锁 → `initDb()`（建表/收敛/种子/声明式迁移）→
 *     过期会话清理 → 起服务，顺序与 `server.py` 一致；`/api/auth/me` 由契约桩改为读 users 表
 *     （信任头 → admin 行；行不存在时 `/api/*` 一律 401，对齐 Python `_current_user()` 为 None）。
 *     种子横幅走 stderr（Python 走 stdout 的 LISTEN 行之前）：薄壳两者落同一份日志，
 *     而 Node 自有 banner 落在 stderr（**与 Python 不同**：Python 的启动 banner 走 stdout）。
 *     ⚠ M4.5 修正：M0 写的「stdout 首行必须是端口行」**Python 自己就不成立**——实测
 *     `python3 server.py` 的 stdout 首行是 `[waitq] 对账完成：活跃行 0 条，收口 0 条`
 *     （调度核心在起监听前跑启动对账），Node 接上调度核心后同形。薄壳是**逐行**正则
 *     （`dsh-plugin/lib/index.js:663`），因此契约口径 = 「stdout 里恰好一行端口行」。
 *     运行时诊断（`[waitq]`/`[runner]`/`[waitq-selfcheck]`）与 Python 同走 stdout（`console.log`），
 *     以便日志对拍逐行可比；Node 自有 banner 仍留在 stderr（M1 决定，见上）。
 */
import http from 'node:http';

import { REPO_ROOT, parseBackendArgs, resolveWebDir } from './lib/args.js';
import { mustChangePwBlocked } from './lib/access.js';
import { cookieToken } from './lib/cookie.js';
import { getUserById, getUserByName, getSession, initDb, openDb, purgeExpiredSessions,
  schemaVersion } from './lib/db.js';
import * as dshevents from './lib/dshevents.js';
import * as dshdriver from './lib/dshdriver.js';
import * as board from './lib/board.js';
import * as chat from './lib/chat.js';
import * as feishu from './lib/feishu.js';
import * as feishuConv from './lib/feishu_conv.js';
import * as runnerMod from './lib/runner.js';
import { setMediaFetcher } from './lib/sessparse.js';
import { pidAlive } from './lib/proc.js';
import { respondError, respondUnsupportedMethod, sendRedirect } from './lib/http.js';
import { acquireSingleInstance, resolveDbPath } from './lib/lock.js';
import { seedHint } from './lib/seed_hint.js';
import {
  Runner, reconcileUnits, setBoardFinishHook, setBoardSelfcheckHooks, setInstance,
  setLivenessProbe, setUnitHandlers, startUnitSelfcheck,
} from './lib/runner.js';
import { serveStatic, webDirReady } from './lib/static.js';
import { STATE_CACHE, dispatchSafely, isPublicRoute, makeContext,
  respondMustChangePassword } from './routes/index.js';

/** 反代注入的免登信任头（须与 dsh-plugin/lib/index.js 的 TRUST_HEADER 一致） */
const TRUST_HEADER = 'x-ts-internal-user';

/**
 * 允许 `--trust-internal-user` 的监听地址白名单。
 * 为什么必须有（对齐 `server.py:5423-5428`）：信任头等价 admin 全权，一旦对外网监听，
 * 任何能连上的人都拿到 admin；Python 侧对非回环 host 直接 `exit 1`。Node 侧少这一道，
 * 就等于「改一行 `--host 0.0.0.0` = 局域网 admin 后门」。
 * 名单与 Python **逐字相同**（不含 `::1`）：等价优先于「看起来更全」——差异会在对拍里暴露。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** SPA 页面集合：与 `server.py` 的 `PUBLIC_PAGES` + ("/app","/monitor","/admin","/log") 一致 */
const SPA_PAGES = new Set(['/login', '/app', '/monitor', '/admin', '/log']);

/**
 * 路由分派（`handler` = `server.py:do_GET` 的读路径骨架）。
 * 顺序与 Python 严格一致：`/` 重定向 → SPA 页面 → `/api/*` 鉴权 → 静态（含 SPA 回退）。
 */
function createHandler({ webDir, trustInternalUser, db }) {
  /** 本次请求是否带薄壳反代注入的免登信任头（`_trusted_admin_request`） */
  const hasTrustHeader = (req) => Boolean(trustInternalUser && req.headers[TRUST_HEADER] === 'admin');

  /**
   * 当前用户（逐条对齐 `server.py:_current_user`(5240)）：
   *   ① 信任头 + users 里真有 admin 行 ⇒ 该行；**admin 行不存在时继续往下走 cookie 分支**
   *      （Python 是 `if admin is not None: return admin` 的落空，不是 return None）；
   *   ② 取 cookie 里的 `ts_session`；**空串与缺失同处理**（Python `if not token: return None`
   *      —— `_cookie_token` 命中 `ts_session=` 时返回的是空串而非 None，falsy 一并挡掉）；
   *   ③ 查会话行：不存在**或已过期** ⇒ `getSession` 回 null（过期判据在 db 层：`expires_at` 与
   *      本地 now 的字符串比较，见 lib/db.js:getSession）；
   *   ④ 按 `user_id` 取用户行（行可能已被删 ⇒ null ⇒ `/api/*` 401，与 Python 同）。
   *
   * 为什么要有 cookie 分支：M1 只搬了信任头分支，浏览器直连（无薄壳反代）时此后端不认会话
   * ——登录端点下的 cookie 拿不到任何效果（`/api/auth/me` 恒 401）。
   */
  const currentUser = (req) => {
    if (!db) return null;
    if (hasTrustHeader(req)) {
      const admin = getUserByName(db, 'admin');
      if (admin) return admin;
    }
    const token = cookieToken(req.headers);
    if (!token) return null;
    const row = getSession(db, token);
    if (!row) return null;
    return getUserById(db, row.user_id);
  };

  return async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const rawUrl = String(req.url || '/');
    const path = rawUrl.split('?')[0];
    const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';

    // 静态与 SPA 页面（只有 GET 走；Python 侧 do_HEAD/do_PUT/do_OPTIONS 一律 501）
    if (method === 'GET') {
      if (path === '/') {
        // Python: 已登录 → /app，未登录 → /login（插件形态下信任头 + admin 行即已登录）
        sendRedirect(res, currentUser(req) ? '/app' : '/login');
        return;
      }
      if (SPA_PAGES.has(path)) {
        await serveStatic(res, webDir, '/index.html');
        return;
      }
      if (!path.startsWith('/api/')) {
        await serveStatic(res, webDir, path);
        return;
      }
    } else if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
      // 没有 do_HEAD/do_PUT/do_OPTIONS ⇒ Python 的 BaseHTTPRequestHandler 回 501 的 HTML
      // 错误页；这里逐字节复刻（见 lib/http.js:respondUnsupportedMethod），不留白名单
      respondUnsupportedMethod(res, method);
      return;
    }

    // ---- 公开端点（**在鉴权之前**分派，照 `server.py:do_POST`(1027) 头两行）---------
    // `/api/auth/login` 与 `/api/auth/register` 是「未登录也能打」的端点——它们要是排在
    // 鉴权之后，就成了「必须先登录才能登录」的死锁。Python 的顺序是：
    //   path == login/register → 直接处理（**不查 _current_user、不过强制改密闸**）
    //   path.startswith("/api/") → 401 检查 → 强制改密闸 → …
    // 名单由 `routes/index.js:isPublicRoute` 从 ROUTES 里 `public: true` 的条目现算
    // （单一真相源：新增公开端点只改路由表，不在 server.js 里再抄一份字符串）。
    // ctx 的 `user: null` 与 `trusted: false` 是照实描述：公开端点分支上两者都还没有/不适用；
    // 请求体由各 handler 在 Python 的同一位置自己 `await ctx.readBody()`（此处不预读）。
    if (method === 'POST' && isPublicRoute(method, path)) {
      const publicCtx = makeContext({
        req, res, db, user: null, path, search, stateCache: STATE_CACHE, trusted: false,
      });
      if (await dispatchSafely(publicCtx)) return;
    }

    // ---- 鉴权（逐条对齐 Python 的 do_GET/do_POST/do_PATCH/do_DELETE）------------
    // Python 的差别只在「哪些方法对非 /api/ 路径也要登录」：
    //   do_POST：只对 `/api/` 前缀鉴权（非 /api 的 POST 直接落到末尾 404 JSON）；
    //   do_PATCH / do_DELETE：**任何路径**都先鉴权。
    const needsAuth = method === 'POST' ? path.startsWith('/api/') : true;
    const user = currentUser(req);
    if (needsAuth && !user) {
      // 紧凑错误体（与 Python `b'{"error":"unauthorized"}'` 逐字节相同，见 lib/http.js:respondError）
      respondError(res, 401, 'unauthorized');
      return;
    }

    // ---- 强制改密闸（**GET 与 POST 两个方法**）-------------------------------------
    // 照 `server.py:1023`(do_GET) 与 `:1040`(do_POST)：**两个方法都调** `_must_change_pw_blocked`，
    // 且都在各自的 `if path.startswith("/api/")` 之内；`do_PATCH`(1227) 与 `do_DELETE`(1266)
    // 只有 401 检查、**没有**这道闸——顺手给四种方法都加会与 Python 分叉
    // （持一次性口令的账号在 PATCH/DELETE 上会拿到 403 而不是 404/业务码）。
    // 判据本体在 `lib/access.js`（可单测；理由见该文件头）。
    // ⚠ 2026-10-14 订正（M7-R3 车道实测，隔离实例真跑 server.py）：此处**曾经**写成
    //   `method === 'POST'`，且注释声称「照 server.py:1040：只在 do_POST 里调」——**注释与源码不符**。
    //   oracle 实测：`GET /api/me/feishu-cfg` ⇒ 403、`POST` ⇒ 403、`PATCH` ⇒ 200、`DELETE` ⇒ 200、
    //   `PUT` ⇒ 501。漏掉 GET 的后果是「持一次性口令的账号」在 Node 侧能读遍全部 `/api/*` 读端点。
    //   `path.startsWith('/api/')` 这一半也不省：POST 到非 `/api/` 路径时 Python 压根不进鉴权段
    //   （直接落到末尾 404 JSON），少了它会把那种请求错判成 403。
    const pwGated = path.startsWith('/api/') && (method === 'GET' || method === 'POST');
    if (pwGated && mustChangePwBlocked(user, path, { trusted: hasTrustHeader(req) })) {
      // 这条闸在 ctx 构造之前（不能为它提前建 ctx）：响应拼装收在 routes/index.js 的
      // respondMustChangePassword 里，语言解析与 ctx.error 保持单一口径
      // （头/query/用户偏好优先级完全一致；单测见 i18n-ctx.test.mjs）。
      respondMustChangePassword(res, { req, db, user, search });
      return;
    }

    // ---- 路由分派（`backend/routes/index.js` 的顺序表 = Python if/elif 链）-------
    // 写路径的请求体由 `ctx.readBody()` **记忆化按需读**（时机 = Python `do_POST:1048` 那一行，
    // 见 routes/index.js 的注释）——这里不预读，免得把「不读体的端点」也读掉。
    // `trusted` 供 `_api_change_password` 决定是否免校验原口令（= `_trusted_admin_request`，
    // Python 里只认「开关 + 信任头」，**与 admin 行是否存在无关**，故这里照 hasTrustHeader 传）。
    const ctx = makeContext({
      req, res, db, user, path, search, stateCache: STATE_CACHE, trusted: hasTrustHeader(req),
    });
    // 兜底分派：处理器抛异常只关这条连接（Python `handle_error` 语义），绝不让
    // unhandledRejection 把整个后端带走 —— 见 routes/index.js:dispatchSafely
    if (await dispatchSafely(ctx)) return;

    // 未命中：`/api/*` 与非 API 的写方法都回 404 JSON（与 Python 各 do_* 的末行一致）；
    // GET 的非 /api 路径已在上面被静态托管吃掉，走不到这里。
    //
    // **POST 要先读体再回 404**：Python 的 `body = self._read_json() or {}`(1048) 在路径
    // 分发**之前**，所以未命中路径的请求体照样被消费掉；Node 侧不读就留下未消费的请求体，
    // 同一条 keep-alive 连接上的下一个请求语义会与 Python 分叉。读体抛错（非数字
    // Content-Length）时照 Python 口径**不发响应**、直接掐断这条连接。
    if (method === 'POST') {
      try {
        await ctx.readBody();
      } catch (error) {
        console.error('touchstone-node: 请求体读取失败，掐断连接（照 Python ValueError 口径）: '
          + `${(error && error.message) || error}`);
        try {
          res.destroy?.();
        } catch {
          // 连接可能已断：忽略
        }
        return;
      }
    }
    respondError(res, 404, 'not found');
  };
}

async function main() {
  const args = parseBackendArgs();
  if (args.trustInternalUser && !LOOPBACK_HOSTS.has(args.host)) {
    // 安全阀（对齐 server.py：解析后、做任何事之前先挡）
    console.error('touchstone-node: 错误: --trust-internal-user 仅允许 --host 127.0.0.1/localhost'
      + `（当前 --host ${args.host}；信任头等价 admin，不得对外网开放）`);
    process.exit(1);
  }
  const webDir = resolveWebDir(args);
  if (!(await webDirReady(webDir))) {
    // 与 Python 侧「无 dist 直接退出」同口径：缺前端就不要假装在后面能跑起来
    console.error(`touchstone-node: 静态目录缺少 index.html，退出: ${webDir}`);
    process.exit(1);
  }

  // ---- 同库单实例锁（M1）----------------------------------------------------------
  // 与 Python 侧 `server.py:5435-5447` **同序同位**：安全阀 → 静态目录校验 → 取锁 → 起服务。
  // 锁口径见 lib/lock.js（`<db>.lock` 上的 SQLite 排它锁，与 Python 的 flock 跨语言互通）；
  // 拿不到就打印占用者与逃生口并 **exit 3**（与 Python 版退出码逐字一致）。
  // 库路径只取一次：锁保护的就是这个库，两处（锁 / initDb）必须同源
  const dbPath = resolveDbPath();
  const instance = acquireSingleInstance({
    dbPath,
    repoDir: REPO_ROOT,
    parentWatch: args.parentWatch,
    allowShared: args.allowSharedDb,
    logger: (msg) => console.error(msg),
  });
  if (!instance.ok) {
    console.error(`touchstone-node: 错误: ${instance.reason}`);
    process.exit(3);
  }

  // ---- 数据层初始化（M1）----------------------------------------------------------
  // 顺序对齐 `server.py`：取锁 → `db.init_db()`（建表/补列收敛/种子/声明式迁移）→
  // 过期会话清理 → 起服务。
  //
  // **为什么跑两次**（对齐 server.py:5329 与 :5479）：Python 侧在**模块导入期**先跑一次
  // `db.init_db()`（注释写明：建表必须先于 runner 全局实例，否则 worker 抢表会让队列静默瘫痪），
  // `main()` 里再跑一次（`_MODULE_SEEDED or db.init_db()`：本次已种子则短路）。净效果是
  // **老库在一次启动里经历两轮迁移**——`2026-09-04_projects_drop_global_unique_name` 重建表
  // 只搬 12 个老列，后加的 9 列(model/archived/skill_* 五列/reasoning_effort/permission_mode)
  // 要等第二轮补列才回来。Node 侧只跑一轮的话，极老库启动后会留下缺列的 projects
  // （任何读 model/archived 的查询都报错），用户侧表现为「切到 Node 版就打不开」。
  // 两轮是这里的**行为契约**，不是补丁：db-run.mjs 的 ancient 夹具逐轮钉住它。
  let db;
  try {
    const boot = initDb({ dbPath });
    const again = boot.seeded ? null : initDb({ dbPath });
    const executedSteps = boot.executed.length + (again ? again.executed.length : 0);
    db = openDb(dbPath);
    purgeExpiredSessions(db);
    // 横幅文案：三档与 seedAdmin 的口令来源一一对应（见 lib/seed_hint.js；
    // 2026-10-16 前空口令档误落「初始口令取自 TS_ADMIN_PASSWORD」文案）
    const hint = seedHint(boot);
    // 文案只报「检查了几步」而不说「执行了几步」（M3 评审 D5）：声明式迁移在**已迁移完**的库上
    // 逐步 no-op（实测同一份快照库起停两次，表行数与文件 sha256 完全不变），旧文案
    // 「本次执行迁移 N 步」读起来像「又迁移了一遍」，排障时会误导。
    console.error(`touchstone-node: 数据库 ${dbPath}（schema 版本 ${schemaVersion(db)}，`
      + `启动检查声明式迁移 ${executedSteps} 步——幂等，已迁移的库上为 no-op）${hint}`);
  } catch (error) {
    console.error(`touchstone-node: 数据层初始化失败 ${dbPath}: ${error && error.message}`);
    instance.release();
    process.exit(1);
  }

  // ---- M4.5/M5 接线：统一队列调度核心 + 看板启动步（启动序硬约束照 `server.py:5481-5505`）
  // 顺序逐条对照 Python：
  //   set_liveness_probe(board.unit_liveness) → runner.recover → **board.recover** →
  //   reconcile_units → release_boot_gate → board.start_scheduler → dshevents.start →
  //   board.start_ext_recover_after_connect → board.start_interaction_watcher →
  //   runner.start_unit_selfcheck
  //
  // ① 判活探针 = `board.unitLiveness`（web 族卡三态映射；对非卡行直接 return None，`board.py:1706`）。
  // ② `recover()` 必须 **await**：Node 侧它是 async（Python 是同步函数）；不 await 会让
  //    `reconcile_units` 在与恢复并发的状态下跑，「先 recover 后对账」这条硬约束就断了。
  // ③ **`board.recover()` 必须夹在 `runner.recover()` 与 `reconcile_units()` 之间**（Python 硬顺序）：
  //    它把 busy web 卡的 `c:` 行置回 running、重建在管条目（`_RUNS`）、刷新 `ext:` 行对账；
  //    对账提前会把 busy web 卡误杀。M4.5 时这一步整组缺席（响亮声明过），M5 补齐。
  // ④ 启动闸 `new Runner(true, …)`：worker 就绪后先停在闸后，等对账跑完再 `releaseBootGate()`
  //    —— 这是 P7a 缺陷 F 的修复口径（提前拾取会被 `reconcile_units` 按证据误裁）。
  // ⑤ `start_ext_recover_after_connect()` 的位置在 **dshevents.start() 之后**：它要等中枢
  //    首连就绪再补跑一次 ext 行对账（启动时中枢未连接的僵尸占用行救不回来，2026-10-07 实障）。
  //    后台线程，不阻塞端口绑定；未就绪直接结束。
  setLivenessProbe(board.unitLiveness);
  // board ↔ runner 的缝（M4 预留、M5 接线）：runner 的收尾口与周期自检的两个 board 读钩子。
  setBoardFinishHook((key, reason) => board.finish(key, reason, { db: null }));
  setBoardSelfcheckHooks({ unitManaged: board.unitManaged, refreshExtRows: board.refreshExtRows });
  const runnerInstance = new Runner(true, { dbPath });
  setInstance(runnerInstance);
  // ---- M6.5/M10 接线：单元执行体（`setUnitHandlers`）--------------------------------
  // 三路**接真**：`t:` → `processTask`（轮次执行体：script_retest / 复压 / retest_bug /
  // fix / pipeline / 轮次循环）、`c:` → `processCard`（看板卡片起跑）、
  // `a:` → `board.deliverAnswerUnit`（答案送达；`runner.py:1087` → `board._deliver_answer_unit`）。
  // 接线前三路一律抛具名错误 `UNIT_HANDLER_MISSING` ⇒ 实例级判据
  // `cases-http/m6_5_runner.json` 接线前是**红**的（rounds 缺行 + error 文案不同），接线后才绿。
  //
  // **`a:` 是 2026-10-16 补接的（M10）**：M6.5 只接了 `t:`/`c:` 并把 `a:` 注明「属 M7」，
  // 但 M7/M7.5/M8/M9 都没接 ⇒ 平台侧作答（TS 会话窗 / 飞书入站；「立即送达」以外的自动路径）
  // 一律「入队成功、永远送不出去」：`runPickedUnit` 的 a: except 分支是「放回等待重投」，
  // 于是**热旋**——真机实测后端 50% CPU、日志 5.5KB/s 涨到 3.9MB（几十万行同一句
  // 「答案送达体未移植（M5）」，而实现体 M5 就在 `board.js` 里，缺的只是这张注册表）。
  // 用户可见现象：在 TS 里答了没反应、答案永远停在「排队中」。与 `routes/sessions.js`
  // 误用 M3 占位桩同属「已实现但没接线」类缺陷（判据缺口也相同：函数级单测照不到接线）。
  //
  // 位置：`setInstance` 之后、`recover()` 之前 —— 执行体在闸后（`releaseBootGate`）才可能被
  // 调用，此处注册只保证「任何一条被拾取的单元都有执行体」，不引入新的启动序。
  setUnitHandlers({
    processTask: (taskId) => runnerInstance.processTask(taskId),
    processCard: (cardId) => runnerInstance.processCard(cardId),
    // `options` 与同段其它 board 口同款：显式传本轮解析出的 `dbPath`（缺省库口径见 db.js）
    deliverAnswerUnit: (cardId) => board.deliverAnswerUnit(cardId, { dbPath }),
  });
  await runnerInstance.recover();
  await board.recover({ dbPath });        // ③ 硬顺序：runner.recover → board.recover → 对账
  reconcileUnits();                       // 顺序硬约束：对账在两次 recover 之后（提前会误杀 busy 卡）
  runnerInstance.releaseBootGate();       // 闸放行点在对账之后
  board.startScheduler();                 // 看板 30s 调度线程（定时卡/巡视/ext 对账）
  console.error('touchstone-node: 调度核心已接线（启动闸已放行；board 启动步随 M5 接全）');

  // ---- M3 接线：会话附件取字节 + dsh 状态事件中枢 ---------------------------------
  // ① `setMediaFetcher(dshdriver.media)`：sessparse 的 `resolve_media` 靠它把 dsh 附件 id
  //    换成字节。**M2 评审 P1 的教训**：`resolve_media` 是 `async`，注入的函数也是 async，
  //    漏了这一步附件会静默 404（更糟的是未捕获拒绝会崩进程）——所以它必须在起服务前接好。
  // ② `dshevents.start()`：看板两条 SSE 与会话 meta 的 dsh 状态读口都依赖它（单条 SSE 订阅
  //    插件的全局状态流）。独立形态（未下发 `TS_AGENT_DRIVER_URL`）下它直接返回 false、
  //    不起线程——与 Python `dshevents.start()` 同口径（Python 侧同样在未配置时 no-op）。
  setMediaFetcher(dshdriver.media);
  const hubStarted = dshevents.start();
  console.error(`touchstone-node: dsh 状态事件中枢 ${hubStarted ? '已启动' : '未启动'
    + '（未下发 TS_AGENT_DRIVER_URL）'}`);

  // ---- board 启动步（顺序照 Python：ext 补跑 → 调和器 → 等待项周期自检）-------------
  // `startExtRecoverAfterConnect()` 等中枢首连后补跑一次 ext 行对账；`startInteractionWatcher()`
  // 是事件驱动的交互调和器（`dshevents.wait` 唤醒 + 60s 兜底）；两者都不阻塞端口绑定。
  board.startExtRecoverAfterConnect();
  board.startInteractionWatcher();

  // ---- 等待项周期自检（`runner.start_unit_selfcheck()`，Python 在 dshevents.start() 之后）----
  // 仅「可证明失效」的行自动收口；拍长 60s、行年龄豁免 15s。`managed` 判据已接
  // `board.unitManaged`（平台在管的卡行不越权收口，收尾归巡视）。
  startUnitSelfcheck();

  // ---- 飞书启动步（照 `server.py:5505-5507`：自检 → 投递线程+终态钩子 → 入站长连接）------
  // ① 投递线程口：注册 chat 的消息终态钩子（M7.5-R3 的 `feishu_conv.start`，函数内调用）
  //    + 起 outbox 投递循环（未配置时空转）；
  // ② 入站口：按用户逐条拉起长连接（凭据齐全才连；用户保存配置时也会即时拉起）。
  // 硬约束：两条都必须在端口绑定之前——否则「端口已可用但入站还没拉起」的窗口里，飞书推来的
  // 消息会丢；且终态钩子必须在入站可能收到第一条消息之前就位（C4/C6）。
  feishu.startNotifier({ dbPath });            // = server.py:5506
  feishu.startInboundAll({ dbPath });          // = server.py:5507

  // ---- 三条接线缝的注入（Lead 裁决 D1；都必须在 listen 之前）--------------------------
  // ③ `chat.setMsgDoneHook`：**不在这里注册**。oracle 的唯一注册位是 `feishu_conv.start()`
  //    （`feishu.py:2676`，在 `start_notifier` 内部，docstring 明说「这是本模块唯一的接线点，
  //    漏掉则回流全哑且无任何报错」）⇒ 上面第 ① 步已经装上。这里再注册一次会变成「两个注册位」
  //    的漂移口子，并掩盖 `feishu_conv.start()` 挂掉的情况（判据见 `tools/parity/test/feishu-seams.test.mjs`）。
  // ④ `runner.setFailureNotifier`：6 位**位置参数**直通 `feishu.taskFailed`——`skippedN` 必须
  //    走第 6 位，**不能**落 `options` 位（`feishu.js:1355-1358` 已登记该坑）。
  runnerMod.setFailureNotifier((projectId, taskId, taskName, taskType, error, skippedN) =>
    feishu.taskFailed(projectId, taskId, taskName, taskType, error, skippedN, { dbPath }));
  // ⑤ `board.setBoardHooks`：D1 拆名后 review 路径 3 位、blocked 路径 4 位，
  //    各自一一对应 `feishu.cardReview` / `feishu.cardBlocked`（不再靠元数猜形态）。
  board.setBoardHooks({ feishuCardReview: feishu.cardReview, feishuCardBlocked: feishu.cardBlocked });

  const server = http.createServer(createHandler({
    webDir,
    trustInternalUser: args.trustInternalUser,
    db,
  }));

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(args.port, args.host, resolve);
    });
  } catch (error) {
    // 薄壳恒传 --port 0（随机端口），端口冲突只会出现在手工指定端口时；不做 Python 的
    // port+1 顺延（那会让「我指定的端口」静默变成另一个端口），直接报错退出。
    console.error(`touchstone-node: 监听失败 ${args.host}:${args.port}: ${error && error.message}`);
    // 起不来就把已取的锁还回去（否则会留下一条死 pid 的 .pid 记录，误导下一次启动的排障）
    instance.release();
    process.exit(1);
  }
  server.on('error', (error) => {
    console.error(`touchstone-node: 服务错误: ${error && error.message}`);
  });

  /**
   * 解析层错误（`clientError`）：**写方法的非法 `Content-Length` 必须无响应即断**。
   *
   * 为什么要有（M4.5 由实例级对拍量具抓出，见实施记录 §3.8）：
   *   - Python 侧 `_read_json` 的 `int(self.headers.get("Content-Length", 0) or 0)` 遇非十进制
   *     抛 ValueError → 一路冒到 socketserver → **不发任何响应、直接断这条连接**
   *     （`lib/http.js:readJsonBody` 的 ② 条契约就是照它写的）；
   *   - Node 侧 llhttp **在解析层就拒收**非法 Content-Length（`HPE_INVALID_CONTENT_LENGTH`），
   *     请求根本进不到 `readJsonBody` ⇒ 契约里那条 reject 分支没机会跑，默认行为是回 400。
   *     实测：`POST /api/tasks/1/session/chat` + `Content-Length: abc` ⇒ Python 0 字节即断、
   *     Node 400。
   * 这里按 `err.rawPacket` 的首行方法名做**窄口径**近似：只对写方法（POST/PATCH/DELETE，即
   * Python 里会走到 `_read_json` 的那些）断连；其余解析错误照 Node 默认回 400
   * （Python 是 400 + 一张 HTML 错误页，两边至少状态码同）。
   *
   * **已知不可对齐的一格**：`GET` + 非法 Content-Length —— Python 的 `do_GET` 压根不读体，
   * 照样 200；而 llhttp 已拒收，Node 永远进不到路由。属协议层差异，登记在实施记录里。
   */
  server.on('clientError', (error, socket) => {
    const raw = error && error.rawPacket ? String(error.rawPacket) : '';
    const method = raw.split(' ', 1)[0].toUpperCase();
    if (error && error.code === 'HPE_INVALID_CONTENT_LENGTH'
        && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
      console.error(`touchstone-node: 非法 Content-Length（${method}）——照 Python int() 口径无响应断连`);
      socket.destroy();
      return;
    }
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  const port = server.address().port;

  // ---- 退出路径与父死感知必须**在打出 LISTEN 行之前**武装好 -------------------------
  // 为什么顺序不能反：端口行是「就绪」的唯一信号，消费方（薄壳 stopBackend、自检、对拍器）
  // 一看到它就可能立刻发 SIGTERM。若 handler 还没注册，进程会**直接死于信号**——release()
  // 与 stdin 看门狗全不跑，现场留下 `.pid` 记录与锁库热日志（M1 实测踩中：db-run 的 server
  // 模式立刻停后端，出现 `sig=SIGTERM` 且 `.pid` 残留）。Python 侧同序：`server.py:5546-5547`
  // 先注册 SIGTERM/SIGINT，`:5562` 才打印 `TOUCHSTONE_LISTEN`。
  let stopping = false;
  const shutdown = (why) => {
    if (stopping) return;
    stopping = true;
    console.error(`touchstone-node: 退出（${why}）`);
    // 先释放单实例锁（关连接即释放 SQLite 锁；`.pid` 记录仅在仍属于自己时删除）。
    // 被 kill -9 时走不到这里——锁由内核释放，这正是选 SQLite 锁的核心理由（测试钉住）。
    try {
      instance.release();
    } catch (error) {
      console.error(`touchstone-node: 释放单实例锁异常（忽略）: ${error && error.message}`);
    }
    // 兜底定时器：长连接（SSE）挂着时 close 回调不会来，不能让父进程等我们
    const hard = setTimeout(() => process.exit(0), 1000);
    if (hard.unref) hard.unref();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('sigterm'));
  process.on('SIGINT', () => shutdown('sigint'));

  // 契约行：薄壳按 stdout 逐行匹配它拿端口（跨 chunk 行缓冲），listen 成功后立刻写。
  // 此刻退出路径已武装完毕，看到这一行的人可以安全地立刻停我们。
  process.stdout.write(`TOUCHSTONE_LISTEN ${port}\n`);
  console.error(`touchstone-node: 就绪 host=${args.host} port=${port} webDir=${webDir}`
    + ` trust=${args.trustInternalUser ? 'on' : 'off'} parentWatch=${args.parentWatch ? 'on' : 'off'}`);

  if (args.parentWatch) {
    // 父死感知 A 通道：stdin 是薄壳开的管道（stdio[0]='pipe'）且**永不写入**，
    // 父进程无论优雅退出还是被 kill -9，OS 都会关闭写端 ⇒ 这里收到 end/close 即退出。
    // 这条路径 Windows/Linux 同码，不需要 Python 侧那条 Linux 专属的 PR_SET_PDEATHSIG。
    //
    // **EOF 后必须复核父存活**（对齐 `lifecycle.arm_parent_watch` 的误报防护，2026-10-11 补）：
    // stdin 不是管道（`< /dev/null`）或被无关方关闭时同样会来 EOF，无条件自杀会让「手工或包装
    // 脚本起后端」莫名其妙退出——实测 `node backend/server.js … < /dev/null` 立刻退出，而 Python
    // 版继续跑（`_watch_stdin` 里 `if not parent_alive(): _fire() else: 记一次误报继续`）。
    const onStdinGone = (why) => {
      const ppid = process.ppid;
      if (ppid > 1 && pidAlive(ppid)) {
        console.error(`touchstone-node: stdin 关闭但父进程仍存活（ppid=${ppid}，${why}）：`
          + '判定为误报，继续运行');
        return;
      }
      shutdown(why);
    };
    process.stdin.resume();
    process.stdin.on('end', () => onStdinGone('parent-eof'));
    process.stdin.on('close', () => onStdinGone('parent-eof'));
    process.stdin.on('error', () => onStdinGone('stdin-error'));
  }
}

await main();
