/**
 * 路由族：个人飞书配置 / 绑定 / 投递记录 —— 7 个端点（M7-R3）。
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头）：
 *   - `GET    /api/me/feishu-cfg`      → `_api_me_feishu_cfg_get`(server.py:1734)
 *   - `POST   /api/me/feishu-cfg`      → `_api_me_feishu_cfg_set`(server.py:1757)
 *   - `PATCH  /api/me/feishu-cfg`      → 同函数（server.py:1252 的 PATCH 分支）
 *   - `POST   /api/me/feishu-bindcode` → `_api_me_feishu_bindcode`(server.py:2115)
 *   - `GET    /api/me/feishu`          → `_api_me_feishu_get`(server.py:2122)
 *   - `DELETE /api/me/feishu`          → `_api_me_feishu_delete`(server.py:2136)
 *   - `GET    /api/me/feishu/outbox`   → `_api_me_feishu_outbox`(server.py:1808)
 *
 * 七条都是**字面路径**（无正则），与既有十族的前缀互不吞并：`/api/me/feishu` 与
 * `/api/me/feishu/outbox` 各自精确相等才命中，`/api/me/feishu-cfg`、`/api/me/feishu-bindcode`
 * 是另外两个字面量（对端车道的 `/api/me/feishu-hook/apply`、`/api/me/feishu/slash-commands`
 * 等同样如此）⇒ 挂表位置不影响分派，本族整族追加在表末。
 *
 * ══ 七条「照抄才不失真」的口径（全部是 oracle 逐字实测，见计划 §1.8）═════════════════
 * 1. **成功体两种字节形态**：`DELETE /api/me/feishu` 回的是硬编码字节串 `b'{"ok":true}'`
 *    (2141) ⇒ **紧凑、无空格**，必须 `ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8')`；
 *    同一族的 `GET|POST|PATCH /api/me/feishu-cfg` 走 `json.dumps` ⇒ `{"ok": true, …}` **带空格**，
 *    走 `ctx.json`。实测两次：`'{"ok":true}'`(CL=11) vs `'{"ok": true, "inbound_started": false, "verify": null}'`。
 * 2. **`GET cfg` 的八个键与固定插入序**：`enabled`/`push_enabled`/`default_webhook`/
 *    `has_default_secret`/`base_url`/`app_id`/`has_app_secret`/`inbound`（`inbound` 内
 *    `configured`/`thread`）。`json.dumps` 保持插入序 ⇒ 键序变了就是字节差。
 * 3. **两个开关缺键按 `true` 回显**（1740/1742 的 `cfg.get(k, True)`，走 `pyTruthy`）——
 *    存量配置零迁移；**键存在但值为假**（`null`/`0`/`""`/`[]`/`{}`）才回 false。
 *    非空串一律真（`"0"`/`"false"` ⇒ true）。
 * 4. **`has_*` 是 `bool(原值)`**（1743/1749）：`" "` ⇒ true（**不 strip**）、`""`/`null`/`0` ⇒ false；
 *    secret 永不回显，只回布尔。`base_url`/`app_id` **不打码**。
 * 5. **打码一律「码点」不是 UTF-16 单元**：`default_webhook` 走 `lib.js:maskWebhook`
 *    （`len<=48` 原样、否则前 48 码点 + `…`）、`open_id` 走 `lib.js:maskOpenId`
 *    （`len>6` ⇒ 前 6 码点 + `…`）。用 `String.length` 会在 emoji 边界差 1。
 * 6. **`GET /api/me/feishu` 的 `default_project` 无归属校验**（2131-2133）：拿绑定行的
 *    `default_project_id` 直查 `db.get_project`，**不查 user_id** ⇒ 指向他人项目也回显其项目名。
 *    这是既有可观测契约，**照抄、不「顺手修」**（多用户隔离红线在「能不能改」上，不在这条只读回显上）。
 * 7. **`outbox`**：字段恒序 `id,status,retries,last_error,created_at,target`；
 *    `db.feishu_outbox_recent(50, user_id=…)` 的 `ORDER BY id DESC LIMIT 50` **硬编码**
 *    （handler 压根没读 `parsed` ⇒ `?limit=1` 静默忽略）；`user_id=0` 的遗留行对任何用户不可见
 *    （SQL 的 `WHERE user_id=?` 天然排除）。
 *
 * ══ 三条「看着能简化、其实一改就分叉」的坑 ═══════════════════════════════════════
 * ① **强制改密闸只对 POST 存在**：`server.py:1023`(do_GET) 与 `:1040`(do_POST) 调
 *    `_must_change_pw_blocked`，而 `do_PATCH`(1227) / `do_DELETE`(1266) **只有 401 检查**。
 *    实测：持一次性口令的账号 GET/POST cfg ⇒ 403 `{"error":"请先修改初始口令"}`，
 *    **PATCH cfg 与 DELETE feishu ⇒ 200**。这道闸在 `server.js`（按方法判，见那里的注释），
 *    本文件**不许**再写一遍，也不许给 PATCH/DELETE 补门（补了就是分叉）。
 * ② **读体的时机**：`do_POST:1048` 给每个 POST 统一读体、`do_PATCH:1262` 在调用 handler
 *    之前读体 ⇒ 两个写方法都必须在 handler 里 `await ctx.readBody()`；`GET`/`DELETE`
 *    全程不读体（`_api_me_feishu_delete`/`_api_me_feishu_get` 里没有 `_read_json`）。
 *    读体还会把非对象 JSON 折成 `{}`（`_read_json` 的 `isinstance(data, dict)` 收口）⇒
 *    **handler 拿到的 body 一定是普通对象**，`Object.hasOwn(body, k)` 与 Python `k in body` 等价。
 * ③ **非对象的 cfg 行 ⇒ 掐断连接**：`feishu_user_cfgs.json` 是合法 JSON 但非对象（`null`/`[]`/
 *    `123`）时，oracle 在 `cfg.get(...)` 上抛 AttributeError ⇒ **0 字节断连**（不是 500、不是默认值）。
 *    故本文件的 `cfgGet` 显式拒绝非普通对象并抛 TypeError，由 `dispatchSafely` 收口成
 *    `res.destroy()`（与 `routes/feishu_hook.js` 的 `eventsAllowed` 同一约定）。
 *    注意「坏 JSON / 空串」**不**走这条路：`db.get_feishu_user_cfg` 的 ValueError 分支给 `{}`
 *    ⇒ 安全默认（两档区别是「合法 JSON 非对象」vs「根本不是 JSON」）。
 *
 * ══ 与 Python 的一处**有意**差异（登记，不擅自「修」oracle）═══════════════════════
 * `_mask_webhook`(1727) 对**非字符串**的存量值（手工改库才会出现）会 `len(123)` 抛 TypeError
 * ⇒ 断连；本文件的 `lib.js:maskWebhook` 对非字符串走 `String(url)`（回 `"123"`）。与
 * `routes/feishu_hook.js` 复用同一个冻结助手、保持全站单一口径，故不在这里另造一套。
 * 只有手工改库能触发，不在 HTTP 可达面内。
 */
import {
  delFeishuBindingByUser, feishuOutboxRecent, getFeishuBindingByUser, getProject,
} from '../lib/db.js';
import { inboundStatus, userConfig } from '../lib/feishu_cfg.js';
import { makeBindCode, saveUserConfig } from '../lib/feishu.js';
import { maskOpenId, maskWebhook } from '../lib/lib.js';

// ---------- Python 语义助手（本文件私有） ----------

/** Python 真值：`""`/`0`/`None`/`False`/空容器为假（JS 的 `[]`/`{}` 是 truthy，必须显式收口） */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * `cfg.get(key, default)` —— 但**先要求 `cfg` 是普通对象**（见文件头坑③）。
 *
 * 不能直接复用 `feishu_cfg.js:dictGet`：那份对 `[]`/`123` 是宽（`Object.hasOwn([], k)` 回 false
 * ⇒ 给默认值），而 oracle 在**任何一种非对象**上都抛（`[]` ⇒ `AttributeError: 'list' object
 * has no attribute 'get'`）⇒ 0 字节断连。这里同形抛，由 `dispatchSafely` 收口。
 */
function cfgGet(cfg, key, dflt = undefined) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    const name = cfg === null ? 'NoneType' : Array.isArray(cfg) ? 'list' : typeof cfg;
    throw new TypeError(`'${name}' object has no attribute 'get'`);
  }
  return Object.hasOwn(cfg, key) ? cfg[key] : dflt;
}

// --------------------------------------------------------------------------
// GET /api/me/feishu-cfg —— 八键 + 打码 + 入站状态
// --------------------------------------------------------------------------

/**
 * 当前用户飞书配置读取（`_api_me_feishu_cfg_get` 1734；所有登录用户可访问，各看各的）。
 *
 * 键序与口径见文件头第 2–5 条。`secret` 类只回布尔；`inbound` 是本人入站长连接状态
 * （`feishu_cfg.js:inboundStatus`：`configured` = 凭据齐全、`thread` = 注册表里的线程还活着；
 * M7 无注册方 ⇒ `thread` 恒 false，那是**当前线程模型的正确返回**，不是占位假值）。
 * **全程不读体**（oracle 这个函数的正文里没有 `_read_json`）。
 */
function apiMeFeishuCfgGet(ctx) {
  const cfg = userConfig(ctx.user.id, { db: ctx.db });
  ctx.json(200, {
    enabled: pyTruthy(cfgGet(cfg, 'enabled', true)),
    // 缺键按开回显，与 `feishu.notify_events` 的判定口径一致（存量配置零迁移）
    push_enabled: pyTruthy(cfgGet(cfg, 'push_enabled', true)),
    default_webhook: maskWebhook(cfgGet(cfg, 'default_webhook', '')),
    has_default_secret: pyTruthy(cfgGet(cfg, 'default_secret')),
    base_url: cfgGet(cfg, 'base_url', ''),
    // 入站：自建应用凭据（app_id 非密可回显；secret 只回布尔）
    app_id: cfgGet(cfg, 'app_id', ''),
    has_app_secret: pyTruthy(cfgGet(cfg, 'app_secret')),
    // 本用户入站长连接状态（明示配置/连接进度，避免「存没存上」不可见）
    inbound: inboundStatus(ctx.user.id, { db: ctx.db }),
  });
}

// --------------------------------------------------------------------------
// POST / PATCH /api/me/feishu-cfg —— 同一处理函数
// --------------------------------------------------------------------------

/**
 * 当前用户飞书配置更新（`_api_me_feishu_cfg_set` 1757；PATCH 走 `server.py:1252` 的同一分支）。
 *
 * 业务全在 `feishu.saveUserConfig`（缺省=不改、显式空串=清除、`str(v or "").strip()` 落库、
 * 两个开关走 Python `bool()`）。响应 = `{"ok": true, **out}`，键序 `ok, inbound_started, verify`。
 * `verify` 是凭据**两件齐全**时的即时快检结果，否则 `null`（零网络请求）。
 *
 * POST 的强制改密闸在 `server.js`（`server.py:1040`）；PATCH **没有**这道闸
 * （`server.py:1227` 的 `do_PATCH` 只有 401 检查）——见文件头坑①，本文件不补门。
 */
async function apiMeFeishuCfgSet(ctx) {
  // 读体时机照 `do_POST:1048` / `do_PATCH:1262`（都在调用 handler 之前）
  const body = await ctx.readBody();
  const out = await saveUserConfig(ctx.user.id, body, { db: ctx.db });
  ctx.json(200, { ok: true, ...out });
}

// --------------------------------------------------------------------------
// POST /api/me/feishu-bindcode
// --------------------------------------------------------------------------

/**
 * 生成飞书绑定码（`_api_me_feishu_bindcode` 2115）：6 位、10 分钟有效、**进程内存态**。
 * 响应只有 `{"code": "<6 位>"}` 一个键（**无 TTL 回显**）；每次调用换新码、旧码不从注册表移除。
 * 不读体（oracle 里没有 `_read_json`）。
 */
function apiMeFeishuBindcode(ctx) {
  ctx.json(200, { code: makeBindCode(ctx.user.id) });
}

// --------------------------------------------------------------------------
// GET / DELETE /api/me/feishu
// --------------------------------------------------------------------------

/**
 * 当前用户绑定状态（`_api_me_feishu_get` 2122）：`{"bound": bool}`，已绑才补
 * `open_id`（**码点**打码）与 `default_project`（项目名；`default_project_id` 为 0/取不到行 ⇒ `""`）。
 *
 * `default_project` **无归属校验**（2131-2133 直接用绑定行里的 id 查项目，不比对 user_id）——
 * 指向他人项目也照实回显其项目名。这是既有可观测契约，照抄（见文件头第 6 条）。
 */
function apiMeFeishuGet(ctx) {
  const row = getFeishuBindingByUser(ctx.user.id, { db: ctx.db });
  const bound = row !== null && row !== undefined;
  const out = { bound };
  if (bound) {
    out.open_id = maskOpenId(row.open_id);
    const proj = pyTruthy(row.default_project_id)
      ? getProject(row.default_project_id, { db: ctx.db })
      : null;
    out.default_project = proj ? proj.name : '';
  }
  ctx.json(200, out);
}

/**
 * 当前用户解绑飞书号（`_api_me_feishu_delete` 2136）。
 *
 * 成功体是**硬编码字节串** `b'{"ok":true}'`（2141）——紧凑、**无空格**，与同族 cfg 的
 * `json.dumps` 口径（`{"ok": true}`）差 1 个字节 ⇒ 必须走 `ctx.text` 而**不是** `ctx.json`。
 * 幂等：无绑定行时 `del_feishu_binding_by_user` 删 0 行、照回同一个字节串。不读体
 * （`do_DELETE` 里没有 `_read_json`；Python 的 `do_DELETE` 只在最前做一次 401 检查）。
 */
function apiMeFeishuDelete(ctx) {
  delFeishuBindingByUser(ctx.user.id, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

// --------------------------------------------------------------------------
// GET /api/me/feishu/outbox
// --------------------------------------------------------------------------

/**
 * 当前用户最近投递记录（`_api_me_feishu_outbox` 1808）：**数组**（不是 `{ok:…}` 包装）。
 *
 * 三处照抄（见文件头第 7 条）：① 字段恒序 `id,status,retries,last_error,created_at,target`；
 * ② `LIMIT 50` 与 `ORDER BY id DESC` **硬编码在 db 层**（handler 不读 query ⇒ `?limit=1` 被静默忽略）；
 * ③ `target` 走 `maskWebhook`（URL 本身含 token 即凭据）。`user_id=0` 的遗留行被 SQL 的
 * `WHERE user_id=?` 天然挡掉——对**任何**用户都不可见。不读体。
 */
function apiMeFeishuOutbox(ctx) {
  const rows = feishuOutboxRecent(50, ctx.user.id, { db: ctx.db });
  ctx.json(200, rows.map((r) => ({
    id: r.id,
    status: r.status,
    retries: r.retries,
    last_error: r.last_error,
    created_at: r.created_at,
    target: maskWebhook(r.target),
  })));
}

// --------------------------------------------------------------------------
// 路由表（七条字面路径，彼此不吞并；整族追加在表末，见文件头）
// --------------------------------------------------------------------------

export const routes = [
  {
    method: 'GET',
    path: '/api/me/feishu-cfg',
    /** 读配置：八键定序、secret 只回布尔、webhook 打码（码点）、带本人入站状态。不读体。 */
    handler: (ctx) => apiMeFeishuCfgGet(ctx),
  },
  {
    method: 'POST',
    path: '/api/me/feishu-cfg',
    /** 写配置（过强制改密闸，闸在 server.js）：缺省=不改、空串=清除；成功体带空格。 */
    handler: (ctx) => apiMeFeishuCfgSet(ctx),
  },
  {
    method: 'PATCH',
    path: '/api/me/feishu-cfg',
    /** 与 POST **同一处理函数**（`server.py:1252`）；唯一差异＝PATCH 不过强制改密闸（闸不在本文件）。 */
    handler: (ctx) => apiMeFeishuCfgSet(ctx),
  },
  {
    method: 'POST',
    path: '/api/me/feishu-bindcode',
    /** 生成 6 位绑定码（进程内存态、10 分钟）：响应只有 code，无 TTL 回显。 */
    handler: (ctx) => apiMeFeishuBindcode(ctx),
  },
  {
    method: 'GET',
    path: '/api/me/feishu',
    /** 绑定状态：未绑只回 `{bound:false}`；已绑补打码 open_id 与项目名（**不校验归属**）。 */
    handler: (ctx) => apiMeFeishuGet(ctx),
  },
  {
    method: 'DELETE',
    path: '/api/me/feishu',
    /** 解绑：成功体是硬编码 `{"ok":true}`（无空格），幂等。不读体。 */
    handler: (ctx) => apiMeFeishuDelete(ctx),
  },
  {
    method: 'GET',
    path: '/api/me/feishu/outbox',
    /** 最近投递记录：数组、字段恒序、`ORDER BY id DESC LIMIT 50` 硬编码、target 打码。 */
    handler: (ctx) => apiMeFeishuOutbox(ctx),
  },
];
