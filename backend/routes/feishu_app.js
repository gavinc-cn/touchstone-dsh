/**
 * 路由族：飞书应用面（斜杠指令 + 扫码供给 + 配置自检 + 入站重连）——M7-R4 尾/R5 车道 + M11.1，6 个端点。
 *
 * 归属条目（`server.py` 行号 = 归属条目；顺序照 `_route_get`(1318/1320) 与 `do_POST`(1062-1085)）：
 *   - `GET    /api/me/feishu/slash-commands` → `_api_me_feishu_slash_get`(1818)  → `feishu.slash_status`
 *   - `POST   /api/me/feishu/slash-commands` → `_api_me_feishu_slash_set`(1826)  → sync/clear/notify
 *   - `GET    /api/me/feishu/provision`      → `_api_me_feishu_provision_get`(1767) → `provision_status`
 *   - `POST   /api/me/feishu/provision`      → `_api_me_feishu_provision_set`(1774) → start/cancel/apply/publish
 *   - `POST   /api/me/feishu/doctor`         → `_api_me_feishu_doctor`(1801)     → `doctor`
 *   - `POST   /api/me/feishu/reconnect`      → `_api_me_feishu_reconnect`(1826)  → `restart_inbound_for`（M11.1）
 *
 * 本文件只做**接线**：业务在 `../lib/feishu_slash.js`（更早车道已落地）、
 * `../lib/feishu_provision.js`（R5 追加段）与 `../lib/feishu_inbound.js`（M11 可停长连接）。
 * 路由层负责的判据只有四类，全部逐字照抄 oracle：
 *
 * ══ ① 缺 action 两族**相反**（本族最容易被写歪的一处）═══════════════════════════════
 *   - `/slash-commands`：`action = str(body.get("action") or "sync")` ⇒ **缺省 sync**（200）；
 *     假值（`0`/`false`/`null`/`""`/`[]`/`{}`）走同一条缺省；`str()` 化后不在
 *     `("sync","clear","notify")` 里 ⇒ 400（**大小写敏感**：`"Sync"` 不认；容器走 Python repr）。
 *   - `/provision`：`action = str(body.get("action") or "")` ⇒ 缺省是**空串 ⇒ 400**；
 *     返回体是 `json.dumps({"error": ...})` ⇒ **冒号后带空格**（`ctx.errorSpaced`），
 *     与全站硬编码紧凑错误体（`ctx.error`）**不是一个字节形态**。
 *   - `/reconnect`：**不读任何业务字段**（无 action/无参数）；响应固定三键
 *     `{ok, started, inbound}`，`ok` 恒 true，连接成败走 `started`/`inbound`（见 handler 注释）。
 *
 * ══ ② 三个动作的返回体**键序**（Python dict 插入序，`json.dumps` 保持）════════════════
 *   - `notify`：`{ok, card_sent, card_error}`（字面量）。
 *   - `sync`/`clear`：业务字典 + **追加** `card_sent`/`card_error` 两键 ⇒ 正常档是
 *     `{ok, created, updated, kept, extra, failed, need_scope, error, card_sent, card_error}`
 *     （`clear` 把 created/updated/kept 换成 deleted），而**短路档**（无凭据/列表异常）只有
 *     `{ok, need_scope, error}` + 追加两键——**键集本身也是判据**。
 *   - `need_scope=True` 时**顺手补发权限引导卡片**并把两个键覆盖成发送结果（发不出去也不影响
 *     设置页的报错展示 ⇒ 失败**不**改 `error`）。
 *
 * ══ ③ 读体时机 ═══════════════════════════════════════════════════════════════════════
 *   `do_POST:1048` 在**分派之前**统一读体 ⇒ 四条 POST 一律先 `await ctx.readBody()`
 *   （400 档也要读掉；`/reconnect` 不读业务字段也照样读掉），而两条 GET 全程**不读**
 *   （Python `do_GET` 没有 `_read_json`）。
 *   这不是洁癖：没读掉的 body 会留在 keep-alive 连接上污染下一个请求。
 *
 * ══ ④ 真值口径 ═══════════════════════════════════════════════════════════════════════
 *   `force` 与 `send_probe` 走 Python `bool()`：**非空字符串一律真**（`"0"`/`"false"` ⇒ true），
 *   `[]`/`{}`/`null`/`""`/`0` ⇒ false —— JS 的 `Boolean([])`/`Boolean({})` 都是 true ⇒ 必须走本文件
 *   的 `pyTruthy`。`version`/`remark`/`changelog` 走 `str(v or "")`（容器是 Python repr 形态）。
 *
 * 未移植项与环境差异见 `../lib/feishu_provision.js` 文件头（M9 起 Device Flow **已移植**：
 * 协议客户端在 `../lib/feishu_device.js`，`supported` 改为真能力探测；剩 `inbound_ws` 线程态）；
 * **本文件不重复实现任何业务逻辑**。
 */
import { inboundStatus } from '../lib/feishu_cfg.js';
import { restartInboundFor } from '../lib/feishu_inbound.js';
import { doctor, provisionApply, provisionCancel, provisionPublish, provisionStart,
  provisionStatus } from '../lib/feishu_provision.js';
import { clearSlashCommands, sendSlashPermCard, slashStatus,
  syncSlashCommands } from '../lib/feishu_slash.js';

// ---------- Python 语义助手（本文件私有；与 `routes/feishu_hook.js` 的同名助手同口径） ----------

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
 * Python `str(v or "")`：str 原样；`None`→`"None"`、bool→`"True"`/`"False"`、数字→十进制文本、
 * **容器→repr 形态**（`["sync"]`⇒`"['sync']"`、`{"a":1}`⇒`"{'a': 1}"`）。
 *
 * 本文件的用途只有一处：把 `action` 折成**与 oracle 同一把尺子**的字符串再去白名单比。
 * 用 `JSON.stringify` 兜底会给出 `["sync"]`——同样不在白名单（结果同为 400），但同一个 `str()`
 * 口径还会经 `version`/`remark`/`changelog` 真的漏进请求体，故照 Python repr 写全。
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

// --------------------------------------------------------------------------
// 路由实现
// --------------------------------------------------------------------------

/** `_api_me_feishu_slash_get`(1818)：现状只读（缺凭据/缺权限都走 `error` 字段，不报错） */
async function apiSlashGet(ctx) {
  ctx.json(200, await slashStatus(ctx.user.id, { db: ctx.db }));
}

/** `_api_me_feishu_slash_set`(1826)：三动作；缺省 sync；缺 scope 时自动补发引导卡片 */
async function apiSlashSet(ctx) {
  const body = await ctx.readBody();                 // 读体在分派之前（见文件头③）
  const action = pyStr(pyTruthy(body.action) ? body.action : 'sync');
  if (action !== 'sync' && action !== 'clear' && action !== 'notify') {
    ctx.errorSpaced(400, 'action 仅支持 sync / clear / notify');
    return;
  }
  const options = { db: ctx.db };
  let out;
  if (action === 'notify') {
    const [ok, err] = await sendSlashPermCard(ctx.user.id, options);
    out = { ok, card_sent: ok, card_error: err };
  } else {
    out = action === 'sync'
      ? await syncSlashCommands(ctx.user.id, options)
      : await clearSlashCommands(ctx.user.id, options);
    // 追加两键（Python 的元组赋值把**不存在的键**加在 dict 末尾；已存在的键改值不改位）
    out.card_sent = false;
    out.card_error = '';
    if (pyTruthy(out.need_scope)) {
      // 缺权限：顺手把引导卡片推到飞书（发不出去也不影响设置页的报错展示）
      const [ok, err] = await sendSlashPermCard(ctx.user.id, options);
      out.card_sent = ok;
      out.card_error = err;
    }
  }
  ctx.json(200, out);
}

/** `_api_me_feishu_provision_get`(1767)：能力/总闸/状态/确认链接/步骤（只读） */
async function apiProvisionGet(ctx) {
  ctx.json(200, provisionStatus(ctx.user.id, { db: ctx.db }));
}

/** `_api_me_feishu_provision_set`(1774)：四动作；缺 action ⇒ 400（与 slash 族**相反**） */
async function apiProvisionSet(ctx) {
  const body = await ctx.readBody();
  const action = pyStr(pyTruthy(body.action) ? body.action : '');
  const uid = ctx.user.id;
  const options = { db: ctx.db };
  let out;
  if (action === 'start') {
    out = await provisionStart(uid, pyTruthy(body.force), options);
  } else if (action === 'cancel') {
    out = provisionCancel(uid);
  } else if (action === 'apply') {
    out = await provisionApply(uid, options);
  } else if (action === 'publish') {
    out = await provisionPublish(uid, {
      // `str(body.get("version") or "") or None`：空串 ⇒ `None` ⇒ publish 内部自动递增版本
      version: pyStr(pyTruthy(body.version) ? body.version : ''),
      remark: pyStr(pyTruthy(body.remark) ? body.remark : ''),
      changelog: pyStr(pyTruthy(body.changelog) ? body.changelog : ''),
      db: ctx.db,
    });
  } else {
    ctx.errorSpaced(400, 'action 仅支持 start / cancel / apply / publish');
    return;
  }
  ctx.json(200, out);
}

/** `_api_me_feishu_doctor`(1801)：八项自检；`send_probe` 走 Python `bool()` */
async function apiDoctor(ctx) {
  const body = await ctx.readBody();
  ctx.json(200, await doctor(ctx.user.id, pyTruthy(body.send_probe), { db: ctx.db }));
}

/**
 * `_api_me_feishu_reconnect`(1826)：设置页面板「重连入站」按钮的写口（M11.1）。
 *
 * 语义 = `feishu.restart_inbound_for`：停旧长连接 → 用**当前库里**的凭据起新。响应三键定序
 * `{ok, started, inbound}`：`ok` 恒 true（动作已执行，不用 HTTP 错误码表达连接成败），
 * `started` = 是否起了**新**连接，`inbound` = 与 `GET /api/me/feishu-cfg` 的 `inbound`
 * **同形两键**（`configured`/`thread`）。
 *
 * 读体时机照文件头 ③：本端点**不读任何业务字段**，但 POST 必须把体读掉（Python
 * `do_POST:1048` 在分派前统一读）；读在哪一步不重要，重要的是别把它留在 keep-alive 上。
 */
async function apiReconnect(ctx) {
  await ctx.readBody();
  const started = await restartInboundFor(ctx.user.id, { db: ctx.db });
  ctx.json(200, {
    ok: true,
    started: Boolean(started),
    inbound: inboundStatus(ctx.user.id, { db: ctx.db }),
  });
}

// --------------------------------------------------------------------------
// 路由表（6 条；前缀 `/api/me/feishu*` 与其它族互不重叠，挂表位置不影响分派，见 `./index.js`）
// --------------------------------------------------------------------------

export const routes = [
  {
    method: 'GET',
    path: '/api/me/feishu/slash-commands',
    /** 斜杠指令现状（期望清单 17 条 + 远端现状 + 引导文案）。 */
    handler: (ctx) => apiSlashGet(ctx),
  },
  {
    method: 'POST',
    path: '/api/me/feishu/slash-commands',
    /** sync / clear / notify；缺 action 缺省 **sync**；非法 ⇒ 400（带空格体）。 */
    handler: (ctx) => apiSlashSet(ctx),
  },
  {
    method: 'GET',
    path: '/api/me/feishu/provision',
    /** 扫码供给状态（只读；`supported` 是**运行时能力探测**，M9 起 Node 侧真判定，见 lib 文件头）。 */
    handler: (ctx) => apiProvisionGet(ctx),
  },
  {
    method: 'POST',
    path: '/api/me/feishu/provision',
    /** start / cancel / apply / publish；缺 action ⇒ **400**（与 slash 族相反）。 */
    handler: (ctx) => apiProvisionSet(ctx),
  },
  {
    method: 'POST',
    path: '/api/me/feishu/doctor',
    /** 配置自检八项（`send_probe=true` 时额外发一条测试消息，60s 频控）。 */
    handler: (ctx) => apiDoctor(ctx),
  },
  {
    method: 'POST',
    path: '/api/me/feishu/reconnect',
    /** M11.1 面板「重连入站」：停旧 → 用当前库凭据起新；三键 `{ok, started, inbound}`。 */
    handler: (ctx) => apiReconnect(ctx),
  },
];
