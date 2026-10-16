/**
 * 路由族：项目推送绑定（飞书群 webhook）——3 个端点（M7）
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头）：
 *   - `GET   /api/projects/<n>/feishu-hook` → `_api_feishu_hook_get`(server.py:2006)
 *   - `PATCH /api/projects/<n>/feishu-hook` → `_api_feishu_hook_set`(server.py:2028)
 *   - `POST  /api/me/feishu-hook/apply`     → `_api_me_feishu_hook_apply`(server.py:2061)
 *
 * 三条路由都由 `_owned_project`(2142) / `_current_user()` 收口（多用户隔离红线）；
 * 本族前缀与既有七族互不重叠（`/api/projects/<n>/feishu-hook` 不会被
 * `^/api/projects/(\d+)$`、`/board/*`、`/bugs/*` 任何一条吞掉），故挂表顺序不影响分派。
 *
 * ══ 六条「照抄才不失真」的口径（全部是 oracle 逐字实测，不是从本实现反推） ═════════
 * 实测手段：`tests/serverfixture.py` 的隔离实例（临时库 + 随机端口）跑真实 `server.py`，
 * HTTP 级读**原始正文**；数据面另用只读 sqlite 连接直读 `feishu_hooks` 行（证明
 * 「库里的字节」与「回显的顺序」不是同一件事）。
 *
 * 1. **成功体两种字节形态**：`PATCH` 是硬编码字节串 `b'{"ok":true}'`(2059) ⇒ 紧凑、**无空格**，
 *    必须 `ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8')`——全站其它端点的
 *    `{"ok": true}` 是 `json.dumps` 口径，本端点**不许**用 `ctx.json`。
 *    `apply` 的 `json.dumps({...})`(2108) ⇒ 带空格，走 `ctx.json`。404 `b'{"error":"not found"}'`
 *    (2009/2032) 与 400 `'{"error":"events 含非法事件"}'`(2051/2079) 都是硬编码 ⇒ `ctx.error`。
 *    实测：`PATCH → '{"ok":true}'`、`apply → '{"ok": true, "updated": 2, …}'`。
 * 2. **`events` 双口径**：
 *    - 写入口径(2050/2054/2077/2102)＝请求数组**原序原样、不校验重复**，`",".join(...)` 落库
 *      （实测 `["task_failed","task_failed","blocked_interaction"]` ⇒ 库
 *      `"task_failed,task_failed,blocked_interaction"`）；
 *    - 读出口径(2025/2040/2092)＝`FEISHU_EVENTS` **固定序 + 去重**，判活是**子串包含**
 *      `e in (row["events"] or "")`（实测同一行回显 `["blocked_interaction","task_failed"]`）。
 *    ⇒ **响应里的顺序永远不是库里的顺序**。判活走子串包含（白名单是三个互不包含的定值串，
 *    故「前缀误命中」这类问题在本族不存在；`feishu_cfg.js:FEISHU_EVENTS` 与 `feishu.py:31`
 *    逐元素同源）。
 * 3. **`enabled` 真值口径是 Python `bool()`**(2038/2056/2090/2104)：`0`/`false`/`""`/`null`/`[]`/`{}`
 *    ⇒ 0；`1`/`true`/`"0"`/`"false"`/`"1"`/`"x"` ⇒ 1（**非空字符串一律真**）。JS 的
 *    `Boolean([])`/`Boolean({})` 都是 true ⇒ 必须走本文件的 `pyTruthy`。实测 12 档全中。
 * 4. **字符串字段走 `str(v or "").strip()`**(2045/2047/2098/2100)：`true`→`"True"`、
 *    `["a"]`→`"['a']"`、`{"a":1}`→`"{'a': 1}"`（**Python repr 落库并回显**）、`1.5`→`"1.5"`、
 *    `"  pad  "`→`"pad"`、`""`/`null`/`false`/`0` ⇒ 清空。⇒ 本文件的 `pyStr`/`pyReprString`
 *    是必需的：容器**不能**用 `JSON.stringify` 兜底（那会给出 `["a"]`，与 oracle 差两个引号）。
 * 5. **「缺省=不改」对 `events` 的字节不成立——`PATCH` 与 `apply` 都一样**：`events` 是
 *    **每次无条件写**的列(2057-2058 / 2105-2106)；没带 `events` 键时写下去的 `cur_events`
 *    来自**读出口径**（`FEISHU_EVENTS` 固定序 + 去重），故未提交的 events 也会被重排/去重回写
 *    （2054 的 `cur_events = req` 只在**带键**时才换成请求数组）。隔离实例直读库内字节实测：
 *      PATCH 写 `["card_review","task_failed"]`            ⇒ 库 `card_review,task_failed`
 *      PATCH `{"enabled":true}`（**无** events 键）        ⇒ 库 **`task_failed,card_review`**（重排）
 *      PATCH 写 `["task_failed","task_failed","blocked_interaction"]`
 *                                                          ⇒ 库 `task_failed,task_failed,blocked_interaction`
 *      PATCH `{}`（空 body）                               ⇒ 库 **`blocked_interaction,task_failed`**（去重+重排）
 *    「缺省=不改」**只对 `webhook_url`/`webhook_secret`/`enabled` 三列成立**（实测无键时逐字保留）。
 *    另一处同源行为：无绑定行的项目会被**建出新行**——`PATCH` 用 `FEISHU_EVENTS` 去掉
 *    `card_review`(2043)，`apply` 用 `FEISHU_DEFAULT_EVENTS`(2096)（两者当前同值，但来源不同）。
 * 6. **归档项目 `GET`/`PATCH` 完全正常**(2006/2028 都只过 `_owned_project`，不看 `archived`)；
 *    只有 `apply` 排除它并计入 `archived_skipped`(2084-2086)，`updated` 只数被写的未归档项目，
 *    `projects` 名单 = `db.list_projects(user_id)` 的 **id 升序**（`db.js:927` 的 `ORDER BY id`
 *    ＝创建序，实测 `["probe_a","probe_b"]`）。
 *
 * ══ 三条「看着能简化、其实一改就分叉」的坑 ═══════════════════════════════════════
 * ① **`ctx.ownedProject` 不能用**：它回 404 `project not found`，而本族 404 文案是 `not found`
 *    （`b'{"error":"not found"}'`）。故本文件自带 `ownedProjectQuiet()`——只查行、不写响应，
 *    与 Python `_owned_project`(2142) 逐字对应（同 `routes/projects.js` 的同名助手）。
 *    实测：他人项目 / 不存在 / 非数字 / 负数 / 小数 / 尾斜杠 / 空 id 一律
 *    `404 {"error":"not found"}`，与「正则不匹配」的兜底**同形**（不可区分 ⇒ 不泄露存在性）。
 * ② **读体的时机**：`do_PATCH:1262` 在**调用 handler 之前**读体（`self._read_json() or {}`），
 *    `do_POST:1048` 给每个 POST 统一读体 ⇒ 本族 `PATCH` 必须**在归属检查之前** `await ctx.readBody()`
 *    （404 档也要把 body 读掉）。这不是洁癖：没读掉的 body 会留在 keep-alive 连接上污染下一个
 *    请求（实测踩中——见下方「实测附录」）。`GET` 全程不读体。
 * ③ **无 body / 坏 JSON / 非对象 JSON**（数组、字符串、数字、`null`）一律按 `{}` 处理(5256-5266)，
 *    **不 400**：实测六档（无 body / `{bad` / `[1,2]` / `"x"` / `null` / 空）全是 200 `{"ok":true}`。
 *
 * ══ 与 Python 的两处**有意**差异（登记，未擅自「修」oracle） ═════════════════════════
 * A. **路径 id ≥ 2^63**（如 `9223372036854775808`）：Python 的 `int(m.group(1))` 抛
 *    **未捕获 OverflowError** ⇒ 连接被直接掐断、无任何 HTTP 响应（实测 `RemoteDisconnected`）。
 *    Node 侧不写畸形代码去复刻这条：`Number()` 得到浮点、`node:sqlite` 绑一个巨大浮点**不抛**
 *    （实测直接跑 `DatabaseSync` 绑定 `1e20` 正常返回无匹配），于是落到 `getProject` 无行
 *    ⇒ **200 以外的正常 `404 {"error":"not found"}`**。这是「Node 更宽、不做连接层攻击面」的
 *    有意差异，登记在报告里。
 * B. **手工改库把 `events` 列写成非 TEXT**（如整数 5）：Python `e in 5` 抛 TypeError ⇒ 断连；
 *    本文件 `String(raw)` 后按子串判 ⇒ 回空集。只有外部改库才可能触发，不在 HTTP 可达面内。
 *
 * ══ 实测附录（隔离实例原文，2026-10-14） ══════════════════════════════════════════
 *   PATCH 200  : (200, '{"ok":true}')
 *   PATCH 404  : (404, '{"error":"not found"}')
 *   enabled=0/false/""/null/[]/{}  → 库 0；enabled=1/true/"0"/"false"/"1"/"x" → 库 1
 *   url=true → 'True'；url=["a"] → "['a']"；url={"a":1} → "{'a': 1}"；url=0 → ''
 *   PATCH ["card_review","task_failed"] ⇒ 库 'card_review,task_failed'
 *   PATCH {"enabled":true}（无 events） ⇒ 库 'task_failed,card_review'   ← PATCH 也重排
 *   PATCH {} ⇒ 库 'blocked_interaction,task_failed'（去重 + 固定序）
 *   PATCH ["task_failed","task_failed","blocked_interaction"] ⇒ 库按请求原序原样（写入口径）
 *   apply 后库 'task_failed,card_review'（无 events 也重排）；归档 skipped=1、updated 只数未归档
 *   events 写 `[[]]` / `[{}]` / `["card_review",["x"]]` ⇒ Python `set()` TypeError ⇒ 连接被掐断
 *   （RemoteDisconnected）；路径 id ≥ 2^63 ⇒ Python OverflowError ⇒ 连接被掐断
 *   **未命中路由的 PATCH 不读 body** ⇒ 同一 keep-alive 连接的下一个请求被残留 body 污染
 *   （第一版探针就撞上 RemoteDisconnected）。Node 侧未命中兜底**只对 POST** 读体
 *   （`server.js:194`），故未命中的 PATCH 与 Python 同形；本族三条路由（含 404 档）总是命中
 *   并读体，不触发这条——登记它只为说明探针为何要开短连接。
 */
import { FEISHU_DEFAULT_EVENTS, FEISHU_EVENTS } from '../lib/feishu_cfg.js';
import * as dbmod from '../lib/db.js';
import { maskWebhook, pyStrip } from '../lib/lib.js';

// ---------- Python 语义助手（本文件私有；与 `routes/projects.js` 的同名助手同口径） ----------

/** Python 真值：`""`/`0`/`None`/`False`/空容器为假（JS 的 `[]`/`{}` 是 truthy，必须显式收口） */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `repr(str)` 的可用子集（单引号、转义反斜杠/引号/控制字符） */
function pyReprString(text) {
  let out = "'";
  for (const ch of String(text)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f) {
      out += `\\x${ch.codePointAt(0).toString(16).padStart(2, '0')}`;
    } else out += ch;
  }
  return `${out}'`;
}

/** Python `repr(x)` 的可用子集（str 走 repr 规则，其余用 `pyStr`） */
function pyRepr(value) {
  if (typeof value === 'string') return pyReprString(value);
  return pyStr(value);
}

/**
 * Python `str(x)`（只覆盖 JSON 里会出现的类型）：str→原样；bool→`True`/`False`；null→`None`；
 * 数字→十进制文本；**容器→repr 形态**（`["a"]`⇒`"['a']"`、`{'a': 1}`）。
 *
 * **为什么不用 `JSON.stringify` 兜底**：那给出 `["a"]`/`{"a":1}`，而 oracle 落库并回显的是
 * `['a']`/`{'a': 1}`（实测见文件头第 4 条）——`server.py:2045` 的 `str(...)` 对容器走 repr。
 * 已知残余差异：整数值浮点（JSON `10.0` 在两侧都解析成 10/10.0，取不到原始字面量）⇒ `'10'` vs
 * Python `'10.0'`；与 `lib/builtin-assets.js` 的 `pyStr` 同一条不可消除差异。
 */
function pyStr(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const items = Object.keys(value).map((k) => `${pyRepr(k)}: ${pyRepr(value[k])}`);
    return `{${items.join(', ')}}`;
  }
  return String(value);
}

/** Python `str(v or "").strip()`（`str()` 永不抛，故非字符串也安全） */
function pyStripStr(value) {
  return pyStrip(pyStr(pyTruthy(value) ? value : ''));
}

/** `dict` 键存在判定：`"k" in body`（值 `null` 也算带键 ⇒ 清空/覆盖，不是「缺省」） */
function hasKey(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/**
 * Python `_owned_project`(2142)：只返回行、**不写响应**（404 文案由调用方给 `not found`）。
 * 不能用 `ctx.ownedProject`——那条会回 `project not found`（见文件头坑①）。
 */
function ownedProjectQuiet(ctx, projectId) {
  const row = dbmod.getProject(projectId, { db: ctx.db });
  if (row === null || row === undefined) return null;
  const user = ctx.user;
  if (user === null || user === undefined || row.user_id !== user.id) return null;
  return row;
}

/** `row["events"]` 的**读出口径**(2025)：`FEISHU_EVENTS` 固定序 + 去重（子串包含判活） */
function eventsOfRow(row) {
  const text = pyTruthy(row.events) ? String(row.events) : '';
  return FEISHU_EVENTS.filter((event) => text.includes(event));
}

/** 无绑定行时的默认事件集(2017/2043)：`FEISHU_EVENTS` 去掉 `card_review`（保序） */
function defaultEventsNoRow() {
  return FEISHU_EVENTS.filter((event) => event !== 'card_review');
}

/**
 * `events` 白名单校验(2050/2077)：必须是数组、且每个元素都在 `FEISHU_EVENTS` 里。
 *
 * 非数组 / 元素不在白名单 ⇒ `false`（调用方回 400）。**但元素是容器时 Python 先炸**：
 * `set(req)` 对 list/dict 元素抛 `TypeError: unhashable type` ⇒ 未捕获 ⇒ **连接被掐断、
 * 无 HTTP 响应**（实测 `[[]]`/`[{}]`/`["card_review",["x"]]` 三档全是 `RemoteDisconnected`）。
 * 这里同形抛错（与 `routes/projects.js:pyStripBare`、`lib/db.js:pyIntOf` 同一约定）：
 * `dispatchSafely` 把它收口成 `res.destroy()`，即「只断这一条连接」。
 * 注意 `null`/数字/布尔是**可哈希**的 ⇒ 走正常 400 分支（实测 `["task_failed",1]` ⇒ 400）。
 */
function eventsAllowed(req) {
  if (!Array.isArray(req)) return false;
  for (const item of req) {
    if (item !== null && typeof item === 'object') {
      throw new TypeError(`unhashable type: '${Array.isArray(item) ? 'list' : 'dict'}'`);
    }
  }
  return req.every((event) => FEISHU_EVENTS.includes(event));
}

// --------------------------------------------------------------------------
// GET /api/projects/<n>/feishu-hook —— 读绑定（默认回显 / 打码 / secret 只回布尔）
// --------------------------------------------------------------------------

/**
 * 项目推送绑定读取（`_api_feishu_hook_get` 2006；隔离闸 `_owned_project`）。
 * 无绑定行 ⇒ 200 默认回显（三事件开、`card_review` 关）；有行 ⇒ webhook 走
 * `lib.js:maskWebhook`（**码点**口径，>48 码点截断加 `…`），secret 只回布尔。
 * 键序照 Python dict 字面量（webhook_url → has_webhook_secret → enabled → events）——
 * `json.dumps` 保持插入序，键序变了就是字节差。
 */
function apiFeishuHookGet(ctx, projectId) {
  if (ownedProjectQuiet(ctx, projectId) === null) {
    ctx.error(404, 'not found');
    return;
  }
  const row = dbmod.getFeishuHook(projectId, { db: ctx.db });
  if (row === null || row === undefined) {
    ctx.json(200, {
      webhook_url: '',
      has_webhook_secret: false,
      enabled: true,
      events: defaultEventsNoRow(),
    });
    return;
  }
  ctx.json(200, {
    webhook_url: maskWebhook(row.webhook_url),
    has_webhook_secret: pyTruthy(row.webhook_secret),
    enabled: pyTruthy(row.enabled),
    events: eventsOfRow(row),
  });
}

// --------------------------------------------------------------------------
// PATCH /api/projects/<n>/feishu-hook —— 改绑定（缺省=不改；成功体是字面量）
// --------------------------------------------------------------------------

/**
 * 项目推送绑定更新（`_api_feishu_hook_set` 2028；隔离闸 `_owned_project`）。
 *
 * 「缺省=不改」**只对 `webhook_url`/`webhook_secret`/`enabled` 成立**：`events` 是无条件写的列，
 * body 没带 `events` 键时写下去的是读出口径的结果（固定序 + 去重）⇒ **未提交的 events 也会被
 * 重排/去重回写**（实测见文件头第 5 条）。其余字段「带键即整体覆盖」——空串/null/`false`/`0` = 清除。
 * `events` 非法 ⇒ 400（**此时一行都不写**，实测 11 档行不变）。
 * 成功体是硬编码 `b'{"ok":true}'`（**无空格**）⇒ `ctx.text`，见文件头第 1 条。
 */
async function apiFeishuHookSet(ctx, projectId) {
  // 读体必须在归属检查**之前**（`do_PATCH:1262` 的求值序，见文件头坑②）
  const body = await ctx.readBody();
  if (ownedProjectQuiet(ctx, projectId) === null) {
    ctx.error(404, 'not found');
    return;
  }
  const row = dbmod.getFeishuHook(projectId, { db: ctx.db });
  const hasRow = row !== null && row !== undefined;
  let curUrl = hasRow ? row.webhook_url : '';
  let curSecret = hasRow ? row.webhook_secret : '';
  let curEnabled = hasRow ? pyTruthy(row.enabled) : true;
  let curEvents = hasRow ? eventsOfRow(row) : defaultEventsNoRow();
  if (hasKey(body, 'webhook_url')) curUrl = pyStripStr(body.webhook_url);
  if (hasKey(body, 'webhook_secret')) curSecret = pyStripStr(body.webhook_secret);
  if (hasKey(body, 'events')) {
    if (!eventsAllowed(body.events)) {
      ctx.error(400, 'events 含非法事件');
      return;
    }
    curEvents = body.events;                  // 写入口径：原序原样、不校验重复
  }
  if (hasKey(body, 'enabled')) curEnabled = pyTruthy(body.enabled);
  dbmod.setFeishuHook(projectId, curUrl, curSecret, curEvents.join(','),
    curEnabled ? 1 : 0, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

// --------------------------------------------------------------------------
// POST /api/me/feishu-hook/apply —— 批量应用到本人全部未归档项目
// --------------------------------------------------------------------------

/**
 * 项目推送绑定**批量应用**（`_api_me_feishu_hook_apply` 2061）。设置页「同时应用到我的
 * 全部项目」：把一份配置写进当前用户**本人的全部未归档项目**（归档项目不再产生推送故不纳入；
 * 跨用户一律不碰——多用户隔离红线，实测他人行一个字节未动）。
 *
 * 字段语义与单项目端点**完全对齐**（缺省=不改该字段；`events` 同样是无条件写的列，
 * 没带键时按读出口径重排 + 去重回写，见文件头第 5 条——实测 `card_review,task_failed`
 * ⇒ `task_failed,card_review`）。无绑定行的项目在这里被**建行**（默认事件集）。
 * 返回 `{ok, updated, archived_skipped, projects}`：`projects` = 实际写入的项目名，
 * 顺序 = `list_projects` 的 id 升序（＝创建序），供前端回执列出「改了什么」。
 * `events` 非法 ⇒ 400 且**一行都不写**（含 `archived_skipped` 也不数——整条请求早退）。
 */
async function apiMeFeishuHookApply(ctx) {
  const body = await ctx.readBody();
  let reqEvents = null;
  if (hasKey(body, 'events')) {
    if (!eventsAllowed(body.events)) {
      ctx.error(400, 'events 含非法事件');
      return;
    }
    reqEvents = body.events;
  }
  const names = [];
  let skipped = 0;
  for (const proj of dbmod.listProjects(ctx.user.id, { db: ctx.db })) {
    if (pyTruthy(proj.archived)) {            // 归档项目：不写、只计数
      skipped += 1;
      continue;
    }
    const row = dbmod.getFeishuHook(proj.id, { db: ctx.db });
    const hasRow = row !== null && row !== undefined;
    let curUrl = hasRow ? row.webhook_url : '';
    let curSecret = hasRow ? row.webhook_secret : '';
    let curEnabled = hasRow ? pyTruthy(row.enabled) : true;
    // 无绑定行的默认集与设置页回显一致（`FEISHU_DEFAULT_EVENTS`，2096）
    let curEvents = hasRow ? eventsOfRow(row) : [...FEISHU_DEFAULT_EVENTS];
    if (hasKey(body, 'webhook_url')) curUrl = pyStripStr(body.webhook_url);
    if (hasKey(body, 'webhook_secret')) curSecret = pyStripStr(body.webhook_secret);
    if (reqEvents !== null) curEvents = reqEvents;   // is not None：带了键（哪怕空数组）才覆盖
    if (hasKey(body, 'enabled')) curEnabled = pyTruthy(body.enabled);
    dbmod.setFeishuHook(proj.id, curUrl, curSecret, curEvents.join(','),
      curEnabled ? 1 : 0, { db: ctx.db });
    names.push(proj.name);
  }
  ctx.json(200, {
    ok: true, updated: names.length, archived_skipped: skipped, projects: names,
  });
}

// --------------------------------------------------------------------------
// 路由表（dispatch 先按 method 过滤，故三条互不干扰；前缀与七族不重叠，挂表位置不影响分派）
// --------------------------------------------------------------------------

export const routes = [
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/feishu-hook$/,
    /** 读绑定（404 文案 `not found`）：无行回默认集，有行 webhook 打码、secret 只回布尔。 */
    handler: (ctx, m) => apiFeishuHookGet(ctx, Number(m[1])),
  },
  {
    method: 'PATCH',
    re: /^\/api\/projects\/(\d+)\/feishu-hook$/,
    /** 改绑定：缺省=不改（仅 url/secret/enabled；events 恒按读出口径重排回写）；events 非法 400 不落库。 */
    handler: (ctx, m) => apiFeishuHookSet(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    path: '/api/me/feishu-hook/apply',
    /** 批量应用到本人全部未归档项目：`events` 缺省也会按固定序重排回写（照抄 oracle）。 */
    handler: (ctx) => apiMeFeishuHookApply(ctx),
  },
];
