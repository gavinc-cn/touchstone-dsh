/**
 * 飞书「供给与自检」族（M7-R5；`feishu.py:2685-2760` + `:2715-2760` + `:2776-2934` 的对应物）。
 *
 * 本文件当前只落**第一个函数** `verifyCredentials`（凭据快检）——它是 R3 车道
 * （`backend/lib/feishu.js` 的 `saveUserConfig`）的输入，故先冻结在这里，避免两条车道
 * 互相等。R5 车道在本文件**追加** `provisionApply`/`provisionStatus`/`provisionStart`/
 * `provisionCancel`/`provisionPublish`/`provisionSupported`/`doctor`；**不要改动本函数**。
 *
 * 逐点对齐 oracle（行号即 `feishu.py`）：
 *   - `verifyCredentials`(:2685 `verify_credentials`) —— 两步：`_tenant_token` 验凭据、
 *     `GET /open-apis/bot/v3/info` 读机器人；**绝不抛出**，一律折成 `{ok, detail}`。
 *
 * 三条**实测契约**（照抄，不许「顺手修正」）：
 *   ① 无凭据时**零请求**：`app_config` 为 None ⇒ 直接回
 *      `{"ok": false, "detail": "应用凭据未配置（App ID / App Secret）"}`；
 *   ② `/bot/v3/info` 的 bot 在响应**顶层**（无 `data` 包裹，与 `botOpenId` 同读法）；
 *      `app_name` 假值回落 `"（未命名）"`（Python `or`），`activate_status == 2` 才算「已启用」；
 *   ③ 异常分两桶：`FeishuRestError` ⇒ `str(e)`（业务码文案，**跨运行时逐字相同**，因为它由
 *      响应 JSON 拼出）；其它异常 ⇒ `探测失败: {e!r}`（**跨运行时文案不同**，已登记为
 *      已知分歧；假上游路径不会走到这里）。
 *
 * 零 npm 依赖（只用 `./feishu_cfg.js` 与 `./feishu_rest.js`）。
 */
import { appConfig, userLang } from './feishu_cfg.js';
import * as i18n from './i18n.js';
import { FeishuRestError, rest, tenantToken } from './feishu_rest.js';

/** Python `str(x)` 的可用子集（文案里逐字出现：`None` / `True` / `2`） */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Python `x or 默认值`（`app_name` 的假值回落口径） */
function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** 异常的 repr（`f"{e!r}"` 的可用子集：`TypeError('fetch failed')` 形态） */
function errRepr(error) {
  if (error instanceof Error) return `${error.name || 'Error'}('${error.message}')`;
  return pyStr(error);
}

/**
 * Python `str(e)` 的可用子集（worker 的 `f"扫码创建失败: {e}"`，feishu.py:3064）。
 *
 * 两种形态都要照抄，因为 oracle 的异常有两族：
 *   - `RegisterAppError(code, description)`（lark_oapi/scene/registration/errors.py）继承了
 *     `Exception.__init__(f"{code}: {description}")` **却带着两个 args** ⇒ `str(e)` 走
 *     `BaseException.__str__` 的「args 长度 ≠ 1」分支，得到**元组 repr**：
 *     `('access_denied', '用户拒绝')`（带引号、逗号后有空格）；
 *   - 普通 `RuntimeError("...")` 只有 1 个 arg ⇒ `str(e)` 就是裸消息。
 * 判据：`code` 与 `description` **同时**是字符串时按元组渲染。这条对得上 oracle 测试
 * `assert "access_denied" in st["error"]`(tests/test_feishu_provision.py:388)。
 */
function pyErrStr(error) {
  if (error instanceof Error) {
    if (typeof error.code === 'string' && typeof error.description === 'string') {
      return `(${pyRepr(error.code)}, ${pyRepr(error.description)})`;
    }
    return error.message;
  }
  return pyStr(error);
}

/** Python `repr(str)` 的可用子集：单引号优先（与 CPython 同选择），串内有单引号则用双引号 */
function pyRepr(value) {
  const text = String(value);
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * stderr 一行（`print(..., file=sys.stderr, flush=True)`）。
 * 走 `console.error` 而不是 `process.stderr.write`：仓库既有单测就是打桩 `console.error`
 * 来抓这几行（`feishu_inbound.js` 的 `defaultLog` 同款理由）。
 */
function logStderr(line) {
  console.error(line);
}

/**
 * 凭据快检（保存凭据后的即时反馈）：token 可取 → 机器人信息可读，两步。
 * 对齐 `feishu.verify_credentials`(feishu.py:2685-2706)。**绝不抛出**。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function verifyCredentials(userId, options = {}) {
  const lang = options.lang;
  const t = (key, vars) => i18n.t('api', key, lang, vars);
  const cfg = appConfig(userId, options);
  if (cfg === null || cfg === undefined) {
    return { ok: false, detail: t('应用凭据未配置（App ID / App Secret）') };
  }
  try {
    await tenantToken(cfg);                     // 第一步：凭据正确性（失败码 10003/10014 等）
    const out = await rest('GET', '/open-apis/bot/v3/info', { cfg });
    // /bot/v3/info 的 bot 在响应**顶层**（无 data 包裹，同 botOpenId 的读法）
    const bot = (out && out.bot) || {};
    const name = pyTruthy(bot.app_name) ? bot.app_name : t('（未命名）');
    const act = bot.activate_status;
    const tail = act === 2 ? t('已启用')
      : t('启用状态={act}（可能未发布/未启用）', { act: pyStr(act) });
    return { ok: true, detail: t('凭据可用：机器人 {name}（{tail}）', { name, tail }) };
  } catch (error) {
    if (error instanceof FeishuRestError) return { ok: false, detail: error.message };
    // 兜底：网络/形态异常一律转文案，不抛到 HTTP 层
    return { ok: false, detail: t('探测失败: {error}', { error: errRepr(error) }) };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// M7-R5 追加段：扫码供给（Device Flow 状态机）/ 应用配置补齐 / 提交发布 / 配置自检
//
// 对应 oracle `feishu.py`：
//   `:1262-1300` 清单真源与总闸、`:2665-2712` `verify_credentials`（上一段，已冻结）、
//   `:2715-2760` `provision_apply`、`:2771-2930` `_doc_item`/`doctor`、
//   `:2930-2965` `_PROVISION`/`_lark_min_ok`/`provision_supported`/`_provision_addons`、
//   `:2985-3043` `provision_status`/`provision_start`/`provision_cancel`、
//   `:3095-3140` `_next_version`/`provision_publish`。
// 逐点对齐（行号即 oracle）：闸门顺序、键序、文案、真值口径（Python `or`/`bool()`/`str()`）一律照抄。
//
// ══ 未移植项与登记的环境差异（**不是实现偷懒，是可观测契约的一部分**）══════════════
// ① **Device Flow 已移植**（M9）：协议客户端在 `backend/lib/feishu_device.js`（RFC 8628 +
//    飞书变体，零 npm 依赖，逐行对齐 `lark_oapi.scene.registration._SyncFlow`）。
//    `provisionSupported()` 因此改为**真能力探测**（见该函数注释），`provisionStart` 的
//    第三/四道闸（进行中未超 TTL、已配置需 force）随之**可达**。
// ② **`supported` 的判据两侧不同源，但同语义**：oracle 判「本机 lark-oapi 版本 ≥ 1.5.5」
//    （`_lark_min_ok`，只读包元数据不 import SDK），Node 判「本运行时能跑 RFC 8628 客户端」。
//    两者都是**运行时能力**的静态判定，不是业务状态。本机两侧都 true ⇒ 量具
//    `http-run.mjs` 的 `NORMALIZE.supported` 仍把它掩成 `<env>`（掩码可撤，读数已等价）。
// ③ **入站长连接（`inbound_ws`）** 的线程态由 M7.5 接线（`feishu_cfg.js:setInboundThread`），
//    本段只读 `inboundStatus()`；`doctor` 因此只保证**无凭据档**两侧确定可比（八项全确定），
//    有凭据档的 `inbound_ws` 是时变项（已登记未验）。
// ④ `_LAST_EVENT_TS` 与 `_TOUCH_EVENT`：oracle 的 `_touch_event`(feishu.py:1290) 是入站
//    handler 的打点口，M7.5 接线时调用；本段先落模块态，`doctor` 的 `inbound_event` 依赖它。
// ══════════════════════════════════════════════════════════════════════════════

// ══ 追加段的 import：**写在末尾**（文件开头那段 import 属「已冻结区」，一字不动）═════
// ESM 的 `import` 声明在模块顶层**任意位置**都合法（模块求值前提升），所以这里再写同源 import
// 既不碰冻结区、也不会产生第二份模块实例。
import { inboundStatus, inboundThreadAppId, userConfig } from './feishu_cfg.js';
import { restSendText } from './feishu_rest.js';
import { _needScope, slashStatus } from './feishu_slash.js';
import { getFeishuBindingByUser, setFeishuUserCfg } from './db.js';
import {
  DEVICE_REQUIRED_CALLBACKS, DEVICE_REQUIRED_EVENTS, DEVICE_REQUIRED_SCOPES,
  _provisionAddons, createCancelEvent, makeDeviceFlow,
} from './feishu_device.js';
import { _TOKEN_CACHE } from './feishu_rest.js';
import { maybeSendSwitchCard, startInboundFor as inboundStartFor } from './feishu_inbound.js';
// `provisionSupported()` 的能力判据之一（与 `feishu_device.js` 里做 addons 编码的是同一个
// 内置模块；「本运行时能否跑 RFC 8628 客户端」= fetch + gzip 两件）。
import { gzipSync } from 'node:zlib';
/** 配置自动化总闸的 env 名（`feishu.py:1262`） */
export const PROVISION_ENV = 'TS_FEISHU_PROVISION';
/** `register_app` 的 lark-oapi 下限（`feishu.py:2932`） */
export const _REGISTER_MIN_VERSION = Object.freeze([1, 5, 5]);
/** 扫码流程状态存活上限（秒），过期视为 idle（`feishu.py:1274`） */
export const PROVISION_TTL = 600;
/** doctor 判「事件订阅真生效」的新鲜窗口（秒）（`feishu.py:1272`） */
export const EVENT_FRESH_S = 300;
/** `send_probe` 每用户频控（秒）（`feishu.py:1273`） */
export const SEND_PROBE_MIN_S = 60;

/**
 * 平台所需权限清单（**唯一真源**，`feishu.py:1263-1269`）：doctor 的 `slash_scope`、
 * `register_app` 的 addons 预置、`application/v7` config 的补齐三处共用同一份。
 * 每项 `[scope_name, token_type, 中文说明]`（第三列是给「人」看的，进不了协议）。
 *
 * 2026-10-22 飞书截图批次：末尾追加 `im:message:readonly`——下载消息里的图片资源
 * （`GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image`）要求
 * `im:message` / `im:message:readonly` / `im:message.history:readonly` 任一；平台用
 * 中权限最窄的 `im:message:readonly`。
 *
 * M9 起 addons 的生成在 `feishu_device.js`（`DEVICE_REQUIRED_*`），本表必须与它**同集**
 * ——否则「创建应用时声明的权限」与「事后 apply 补的权限」会漂移，而这正是本项要防的坑。
 * 故文件末尾有一处一致性断言（启动即炸，不留到线上）。
 */
export const REQUIRED_SCOPES = Object.freeze([
  Object.freeze(['im:message.p2p_msg:readonly', 'tenant', '接收单聊消息']),
  Object.freeze(['im:message.group_at_msg:readonly', 'tenant', '接收群聊 @机器人 消息']),
  Object.freeze(['im:message:send_as_bot', 'tenant', '以机器人身份发消息/卡片']),
  Object.freeze(['application:app_slash_command:read', 'tenant', '读取斜杠指令']),
  Object.freeze(['application:app_slash_command:write', 'tenant', '注册斜杠指令']),
  Object.freeze(['im:message:readonly', 'tenant', '读取消息中的图片/文件资源']),
]);
/** 事件清单（`feishu.py:1270`）：`[event, 中文说明]` */
export const REQUIRED_EVENTS = Object.freeze([Object.freeze(['im.message.receive_v1', '接收消息'])]);
/** 回调清单（`feishu.py:1271`）：`[callback, 中文说明]` */
export const REQUIRED_CALLBACKS = Object.freeze([Object.freeze(['card.action.trigger', '卡片按钮回调'])]);

/** 应用配置/发布端点（官方 application/v7；能力开关在 ability 子路径）（`feishu.py:1277-1281`） */
export const _APP_ABILITY_API = '/open-apis/application/v7/applications/%s/ability';
export const _APP_CONFIG_API = '/open-apis/application/v7/applications/%s/config';
export const _APP_PUBLISH_API = '/open-apis/application/v7/applications/%s/publish';
export const _APP_VERSIONS_API = '/open-apis/application/v6/applications/%s/app_versions';
/** 补齐应用配置所需的权限（冷启动点：扫码新建的应用默认没有它）（`feishu.py:1282`） */
export const _PATCH_SCOPE = 'application:application:patch';
/** 缺 patch 权限时的精确开通引导（`feishu.py:1283-1284`，逐字照抄） */
export const _PATCH_SCOPE_HINT = `应用缺少「${_PATCH_SCOPE}」权限：请到开发者后台 → 权限管理添加该权限`
  + '并创建版本发布；或把该权限对应用设为免审后再试';

/** `user_id -> {state,url,error,app_id,steps,started_at,cancel}`（`feishu.py:2930`，进程内存态） */
export const _PROVISION = new Map();
/** `user_id -> 最近一次收到飞书事件的时刻`（`feishu.py:1286`；`_touch_event` 打点，M7.5 接线） */
export const _LAST_EVENT_TS = new Map();
/** `user_id -> 上次发「测试消息」的时刻`（`feishu.py:2768`，send_probe 频控） */
export const _LAST_PROBE_TS = new Map();

/** 「读状态 → 写状态」串行化（`feishu.py:2931` 的 `_PROVISION_LOCK`）：并发点两下只建一条流程 */
const _PROVISION_LOCK = { tail: Promise.resolve() };
function withProvisionLock(fn) {
  const run = _PROVISION_LOCK.tail.then(fn, fn);
  _PROVISION_LOCK.tail = run.then(() => undefined, () => undefined);
  return run;
}

/** 该进程的 env 取用口：`options.env` 优先（单测/路由传），否则 `process.env`（`os.environ` 口径） */
function envOf(options) {
  return (options && options.env) || process.env;
}

/**
 * 配置自动化写操作总闸（`feishu.provision_enabled`(feishu.py:1296-1299)）：
 * `(os.environ.get(K) or "1") != "0"` ⇒ **缺键与空串都是开**，只有字面 `"0"` 关。
 * 只读的 status/doctor 不受它影响（关掉后仍可体检）。
 */
export function provisionEnabled(env = process.env) {
  return ((env && env[PROVISION_ENV]) || '1') !== '0';
}

/**
 * 本机是否具备「扫码一键建应用」能力（`feishu.provision_supported`(feishu.py:2967-2969)）。
 *
 * **判据的对应关系**（两侧同语义、不同源）：
 *   - oracle 判 `_lark_min_ok()`(feishu.py:2935-2954)：`importlib.metadata.version("lark-oapi")`
 *     的版本元组 ≥ `(1,5,5)` —— 即「**本运行时有没有 register_app 这个能力**」，
 *     且刻意**只读包元数据、不 import SDK**（import `lark_oapi.ws.client` 会在模块级
 *     `asyncio.get_event_loop()`，非主线程首次 import 有拿不到事件循环的风险）。
 *   - Node 侧对应的能力 = 「本运行时能否跑 RFC 8628 客户端」：能发 HTTPS 表单 POST
 *     （`globalThis.fetch`）**且**能把 addons 压成 gzip（`node:zlib` 的 `gzipSync`）。
 *     两者都是**运行时能力的静态判定**，不是业务状态（与凭据、总闸、用户配置都无关）；
 *     与 oracle 一样**不做任何 I/O**（不探网、不读库、不读 env）。
 *
 * 本机（Node 24）两项齐备 ⇒ 回 `true`，与 oracle（lark-oapi 1.7.3）取值一致。
 * 「能力齐备但真去扫码会失败」属下一层失败面，由 `provisionStart` 与 worker 如实报错。
 */
export function provisionSupported() {
  return typeof globalThis.fetch === 'function' && typeof gzipSync === 'function';
}

/**
 * `_register_app_impl`(feishu.py:2957-2964) 的对应物：**唯一直接碰 Device Flow 的地方**，
 * 也是测试打桩点（oracle 测试用 `monkeypatch.setattr(feishu, "_register_app_impl", stub)`）。
 *
 * 与 oracle 的差异（登记）：oracle 在这里**再查一次** `_lark_min_ok()`，不达标就抛
 * `RuntimeError("lark-oapi 版本过低或未安装（register_app 需 ≥1.5.5）")`。Node 侧
 * `provisionStart` 已用同语义的 `provisionSupported()` 提前拦下，且两处判据必然同值，
 * 这里不再重复一道（重复只会多一个不可达分支）。
 *
 * @param {(info: {url: string, expire_in: number}) => void} onQrCode
 * @param {(info: {status: string, interval?: number}) => void} onStatusChange
 * @param {{is_set?: () => boolean, isSet?: () => boolean, cancelled?: boolean}} cancelEvent
 * @param {object} addons `_provisionAddons()` 的结果
 * @param {{now?: () => number, sleep?: (s: number) => Promise<void>, defaults?: object}} [proc]
 *        时钟替身（**Node 侧多出来的参数**，oracle 无）：与 `provisionStart` 的 `options` 同性质
 *        ——只影响测试，不改变 oracle 可观测契约。真扫码路径恒不传 ⇒ 走真时钟。
 * @returns {Promise<{client_id: string, client_secret: string, user_info?: object}>}
 */
export function _registerAppImpl(onQrCode, onStatusChange, cancelEvent, addons, proc) {
  return makeDeviceFlow(proc, {
    addons, cancelEvent, onQrCode, onStatusChange, source: _SOURCE_OVERRIDE,
  }).run();
}

/**
 * 测试缝（对齐 `dsh-plugin/lib/index.js` 的 `_setNodeRuntimeProbeForTest`）：
 * **生产路径恒 `null`** ⇒ `_registerAppImpl` 走真 Device Flow。
 * 给缝的理由：真扫码必须有人在飞书里点一下（唯一不可自动化的一步）；没有缝的话
 * `provisionStart` 第 ③④ 道闸与 worker 就只能在真机上验。
 */
let registerAppImplForTest = null;
export function _setRegisterAppImplForTest(fn) {
  registerAppImplForTest = fn;
}

/**
 * `source` 的可覆盖入口（oracle `register_app(source=...)`）：缺省 `null` ⇒ 裸 `"python-sdk"`。
 * **登记为未验项**：`python-sdk` 是照抄 oracle 的取值（`_register_app_impl` 不传 source），
 * 服务端是否校验该字面量未知；擅自改成别的值只会多一个失败面，故保持原值 + 留这个口子。
 */
let _SOURCE_OVERRIDE = null;
export function _setSourceForTest(value) {
  _SOURCE_OVERRIDE = value === undefined ? null : value;
}

/**
 * 后台主体（`feishu._provision_worker`(feishu.py:3045-3090)）：跑 Device Flow →
 * 成功即写凭据 → 起长连接 → 自动补齐应用配置，全过程结果落 `_PROVISION` 供前端轮询。
 *
 * **绝不外抛**：Node 没有守护线程，本函数是 fire-and-forget 的 async，任何漏出的
 * rejection 都会变成 unhandled rejection（进程级告警甚至退出）——所以整个函数体包在
 * try/catch 里，连落库与 `startInboundFor` 那两步也不例外。凭据不入日志。
 *
 * 落库失败（oracle 里 `db.set_feishu_user_cfg` 抛异常会沿线程冒到顶层）在这里折成
 * `failed` + 同文案：Node 侧没有「线程栈打印」这层兜底，静默吞掉才是真正的不一致。
 *
 * @param {number} userId
 * @param {{set?: Function}} cancel
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 进程缝，透传给
 *        依赖。oracle 无此层参数，但 Node 侧 `dbPath`/`env` 是既有惯例且**只影响测试**，
 *        不改变 oracle 可观测契约。
 */
async function _provisionWorker(userId, cancel, options = {}) {
  const st = _PROVISION.get(userId);
  if (st === undefined || st === null) return;   // 状态被清掉（oracle 此处会 KeyError）

  /**
   * 「我是否仍是该用户当前那条流程」。
   *
   * oracle 里 worker 直接闭包持有 `_PROVISION[user_id]` 那个 dict，**永远**写它；只要
   * `provision_start` 没被同用户重入就等价。Node 侧多出一个真实竞态：worker 是
   * fire-and-forget 的 async，可能出现「旧流程还没收尾，用户已重新发起（TTL 过期后
   * `provision_start` 会覆盖 `_PROVISION[user_id]`）」——此时旧 worker 若继续往
   * **自己的** st 上写，还看不出问题；但它若写 `_PROVISION.get(userId)`（比如兜底 catch）
   * 就会把**新**流程打成 failed。
   *
   * 收口办法：所有对 `_PROVISION` 的写入都先过这道闸 —— 只有「`_PROVISION.get(userId).cancel`
   * 就是我手上这个 cancel」才允许写。旧 worker 的顺序完全保留（写自己的 st 或走 stderr），
   * 只是不再污染新流程。这不改变 oracle 的任何可观测输出（同一时刻只有一条流程时恒为真）。
   */
  const isCurrentFlow = () => {
    const cur = _PROVISION.get(userId);
    return cur !== undefined && cur !== null && cur.cancel === cancel;
  };

  // 回调：`on_qr(url)` / `on_status(info)`（feishu.py:3051-3057）。
  // ⚠ **口径是与 oracle 逐字节一致的「原样存」**：`lark_oapi` 调的是
  // `self._on_qr_code({"url": qr_url, "expire_in": expire_in})`（scene/registration:298），
  // 而 oracle 的 `on_qr(url)` 里就是 `st["url"] = url or ""` —— 存进去的是那个 **dict**，
  // 于是 `provision_status()["url"]` 是 `{"url": …, "expire_in": …}`，
  // HTTP 响应里 `url` 是**对象**而非字符串（2026-10-15 M9-R2 用真 oracle 实测钉死，
  // 见 `tests/test_feishu_provision_url_shape.py`）。
  // 首版这里写的是 `(info && info.url) || ''`（取 `.url` ⇒ 字符串）——**那是无意中偏离了
  // oracle**，比对拍用例 `m9_feishu_device_start` 抓出来（`url` 类型 object vs string）。
  // 修法：**恢复 oracle 口径**（本文件是移植件，不许自作主张改可观测输出），
  // 面板那边由**共用前端**做双形态容错（`provisionQrUrl`）——这样两版后端的面板都能用。
  // 这里**不需要** `isCurrentFlow` 闸：两个回调写的是闭包自己的 `st`（旧流程的状态对象），
  // 新流程有它自己的对象，互不干扰 —— 实测把闸去掉没有任何判据变红（见报告「变异 9」）。
  // 真正的越界点是「旧流程拿凭据去落库」——见下面那道闸。
  const onQr = (info) => {
    st.url = pyTruthy(info) ? info : '';          // oracle `url or ""`（空 dict / None / "" ⇒ ""）
  };
  const onStatus = (info) => {
    // 域切换（飞书/Lark）时链接作废，等 SDK 给新链接（旧 URL 已失效，不展示误导）
    if (info !== null && typeof info === 'object' && info.status === 'domain_switched') {
      st.url = '';
    }
  };

  let out = null;
  try {
    const impl = registerAppImplForTest === null ? _registerAppImpl : registerAppImplForTest;
    out = await impl(onQr, onStatus, cancel, _provisionAddons());
  } catch (error) {
    if (st.state !== 'cancelled') {
      st.state = 'failed';
      st.error = `扫码创建失败: ${pyErrStr(error)}`;
    }
    return;
  }
  if (st.state === 'cancelled') return;

  const appId = (out || {}).client_id || '';
  const secret = (out || {}).client_secret || '';
  if (!(appId && secret)) {
    st.state = 'failed';
    st.error = '扫码流程未返回应用凭据（可能超时或未确认），可重新发起';
    return;
  }
  if (!isCurrentFlow()) return;      // 旧流程：凭据不再落库（新流程会自己拿一份）

  // 合并写库：保留既有 enabled / webhook / base_url 等字段，只换应用凭据
  let oldCfg;
  try {
    const cfg = { ...(userConfig(userId, options) || {}) };
    oldCfg = { app_id: cfg.app_id || '', app_secret: cfg.app_secret || '' };  // M11 换应用卡片用
    cfg.app_id = appId;
    cfg.app_secret = secret;
    setFeishuUserCfg(userId, cfg, options);
    _TOKEN_CACHE.delete(appId);          // 新凭据：清同 app_id 的旧 token 缓存（feishu.py:3079）
    st.app_id = appId;
  } catch (error) {
    st.state = 'failed';
    st.error = `扫码创建失败: ${pyErrStr(error)}`;
    return;
  }

  // M11：换应用后旧连接仍在跑（绑定关系也还是旧应用的 open_id）⇒ 用**旧应用**通道发
  // 「确认切换」卡片；用户点按钮后由「先取码、再重连」顺序完成切换（无需重启站点）。
  // 必须在 startInboundFor 之前发：那时旧 runner 还活着、旧 open_id 也还认得。
  await maybeSendSwitchCard(userId, oldCfg, options);
  try {
    inboundStartFor(userId, options);    // 起长连接（失败只留痕，状态里如实呈现）
  } catch (error) {
    logStderr(`feishu provision: 用户 ${userId} 长连接启动异常: ${errRepr(error)}`);
  }

  // canonical（中文）落库：status 读侧再按请求语言映射 steps（T12d），
  // 这样切换页面语言不会让已跑完的步骤语言错乱。
  const applied = await provisionApply(userId, { ...options, lang: 'zh', dataLang: undefined });
  st.steps = applied.steps || [];
  st.state = 'success';
  st.error = applied.ok ? ''
    : `应用已创建，但配置补齐未完成：${applied.error}`;
}

/**
 * 起 worker（`threading.Thread(target=_provision_worker, ...).start()`，feishu.py:3030-3031）。
 *
 * **fire-and-forget**：Node 没有守护线程，返回的 promise 必须自带 catch，
 * 否则 worker 内部任何漏网异常都会变成 unhandled rejection。
 * 同步返回（不 await）——oracle 的 `Thread.start()` 也是立刻返回。
 */
function startProvisionWorker(userId, cancel, options) {
  const run = _provisionWorker(userId, cancel, options);
  run.catch((error) => {
    // 理论上到不了这里（worker 内部全 catch）；真到了也绝不许冒泡成 unhandled rejection。
    // 只在「我还是当前那条流程」时改状态，否则只留痕（见 `_provisionWorker.isCurrentFlow`）。
    const cur = _PROVISION.get(userId);
    if (cur !== undefined && cur !== null && cur.cancel === cancel && cur.state === 'waiting') {
      cur.state = 'failed';
      cur.error = `扫码创建失败: ${pyErrStr(error)}`;
    } else {
      logStderr(`feishu provision: 用户 ${userId} worker 异常: ${errRepr(error)}`);
    }
  });
}

/**
 * 应用配置补齐（`feishu.provision_apply`(feishu.py:2715-2760)）：把平台所需的
 * **机器人能力 + 权限 + 长连接订阅 + 事件 + 回调**一次补齐到用户自己的应用。
 *
 * 两步 ① `PATCH .../ability`（`{bot:{enable:true}}`）② `PATCH .../config`
 * （scope.add_scopes / event.subscription_type=websocket + add_events / callback.add_callbacks）。
 * **失败即停**：第 ① 步失败就只回一条 step（已跑的步骤如实保留）；缺 scope 时 `error`
 * 换成精确开通引导 `_PATCH_SCOPE_HINT`（`_apply_error`），其余原样透出 `str(e)`。
 * 返回键序恒为 `ok / need_patch_scope / error / steps`（Python dict 字面量序）。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export async function provisionApply(userId, options = {}) {
  const lang = options.lang;
  const t = (key, vars) => i18n.t('api', key, lang, vars);
  if (!provisionEnabled(envOf(options))) {
    return { ok: false, need_patch_scope: false, steps: [],
      error: t('配置自动化已关闭（{env}=0）', { env: PROVISION_ENV }) };
  }
  const cfg = appConfig(userId, options);
  if (cfg === null || cfg === undefined) {
    return { ok: false, need_patch_scope: false, steps: [],
      error: t('应用凭据未配置（App ID / App Secret），请先保存凭据') };
  }
  const appId = cfg.app_id;
  const steps = [];
  // ① 机器人能力（错误码 210041 即「未开启机器人能力」，先开它）
  try {
    await rest('PATCH', sprintf(_APP_ABILITY_API, appId),
      { jsonBody: { bot: { enable: true } }, cfg });
    steps.push({ key: 'ability', label: t('开启机器人能力'), ok: true,
      detail: t('已开启') });
  } catch (error) {
    if (!(error instanceof FeishuRestError)) throw error;      // oracle 只吞 FeishuRestError
    steps.push({ key: 'ability', label: t('开启机器人能力'), ok: false,
      detail: error.message });
    return { ok: false, need_patch_scope: _needScope(error),
      error: applyError(error, lang), steps };
  }
  // ② 权限 + 订阅方式（长连接）+ 事件 + 回调（一次 PATCH，减少请求与半生效窗口）
  const body = {
    scope: { add_scopes: REQUIRED_SCOPES.map(([name, tokenType]) =>
      ({ scope_name: name, token_type: tokenType })) },
    event: { subscription_type: 'websocket', add_events: REQUIRED_EVENTS.map(([e]) => e) },
    callback: { callback_type: 'websocket', add_callbacks: REQUIRED_CALLBACKS.map(([c]) => c) },
  };
  try {
    await rest('PATCH', sprintf(_APP_CONFIG_API, appId), { jsonBody: body, cfg });
    steps.push({ key: 'config', label: t('权限 / 长连接订阅 / 事件 / 回调'), ok: true,
      detail: t('已写入（需发布新版本后生效）') });
  } catch (error) {
    if (!(error instanceof FeishuRestError)) throw error;
    steps.push({ key: 'config', label: t('权限 / 长连接订阅 / 事件 / 回调'), ok: false,
      detail: error.message });
    return { ok: false, need_patch_scope: _needScope(error),
      error: applyError(error, lang), steps };
  }
  return { ok: true, need_patch_scope: false, error: '', steps };
}

/** Python `%s` 单参格式化的可用子集（端点模板都是单个 `%s`） */
function sprintf(template, value) {
  return template.replace('%s', String(value));
}

/** `feishu._apply_error`(feishu.py:2708-2712)：缺 patch 权限给精确引导，其余原样透出 */
function applyError(error, lang) {
  if (_needScope(error)) return i18n.t('api', _PATCH_SCOPE_HINT, lang);
  return error.message;
}

/**
 * doctor 单项（`feishu._doc_item`(feishu.py:2771-2773)）：键序 key/label/state/detail/hint，
 * `state ∈ ok|fail|warn|skip`，`hint` 是中文修复指引（缺省空串）。
 */
export function _docItem(key, label, state, detail, hint = '') {
  return { key, label, state, detail, hint };
}

/**
 * doctor 第三项 `inbound_ws`（M10，2026-10-17 新增一档 warn）：线程活着但**绑的不是配置里的
 * 应用** ⇒ 换凭据后没重启站点。这是实测踩过的坑：面板显示「已接入应用 X」、本项也绿，
 * 但消息仍打到旧机器人。文案与 oracle `feishu.doctor` 的同名分支**逐字一致**（两侧各有单测钉住）。
 *
 * 抽成纯函数只为可判：doctor 其余项依赖真网络，端到端测要打桩整套 REST；这一项只取决于
 * 两个入参，纯函数就能把「warn / ok / fail 三档 + 文案」钉死。
 * @param {{thread?: boolean, app_id?: string}} st `{thread: inboundStatus().thread,
 *   app_id: inboundThreadAppId()}` —— 两者来自不同访问口，见 feishu_cfg.js 的形状说明
 * @param {object} cfg 该用户的应用配置（读 `app_id`）
 */
export function inboundWsItem(st, cfg, lang = 'zh') {
  const t = (key, vars) => i18n.t('api', key, lang, vars);
  const thread = pyTruthy(st && st.thread);
  const cfgApp = (cfg && cfg.app_id) || '';
  const threadApp = (st && st.app_id) || '';
  if (thread && cfgApp && threadApp && threadApp !== cfgApp) {
    return _docItem('inbound_ws', t('入站长连接（长连接）'), 'warn',
      t('连接线程仍绑在 {thread}（配置已改为 {cfg}）',
        { thread: threadApp, cfg: cfgApp }),
      t('在机器人私聊发「接入」点「换用新应用」即可免重启切换；仍不生效再重启站点'));
  }
  return _docItem('inbound_ws', t('入站长连接（长连接）'),
    thread ? 'ok' : 'fail',
    thread ? t('连接线程运行中') : t('未运行'),
    thread ? ''
      : t('凭据保存后自动连接；仍不启动看站点日志，并确认事件订阅方式为「长连接」'));
}

/**
 * 逐项配置体检（`feishu.doctor`(feishu.py:2776-2925)）：八项 + summary 计数，**绝不抛出**。
 *
 * 项目顺序与文案逐字照抄 oracle：creds / token / bot / inbound_ws / inbound_event /
 * slash_scope / send_scope / webhook；summary 键序 ok/fail/warn/skip。
 * **无凭据档是唯一两侧确定可比的档**（其余七项都可能因 `inbound_ws` 线程态/网络返回时变——
 * 已登记未验）。`send_probe=true` 只有在「凭据可用 + 已绑定」时才可能走到真发消息（60s 频控）。
 * 语言两个维度（别混）：
 *   - `options.lang`（T12b）：真发那条测试 DM 的**收件人**语言（缺省读绑定用户偏好；
 *     不探测 / 被频控拦下时不读偏好）；
 *   - `options.dataLang`（T12d）：八项 label/detail/hint 的**请求语言**（缺省/zh ⇒ 存量
 *     中文逐字节不变）。
 * @param {number} userId
 * @param {boolean} [sendProbe]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv, lang?: string,
 *          dataLang?: string}} [options]
 */
export async function doctor(userId, sendProbe = false, options = {}) {
  const dataLang = options.dataLang;
  const t = (key, vars) => i18n.t('api', key, dataLang, vars);
  const cfg = { ...(userConfig(userId, options) || {}) };
  const hasCreds = pyTruthy(cfg.app_id) && pyTruthy(cfg.app_secret);
  const items = [_docItem(
    'creds', t('应用凭据（App ID / App Secret）'),
    hasCreds ? 'ok' : 'fail',
    hasCreds ? t('已配置') : t('未配置'),
    hasCreds ? '' : t('在「飞书机器人配置」填入 App ID 与 App Secret 并保存'))];

  let tokenOk = false;
  if (!hasCreds) {
    items.push(_docItem('token', t('凭据有效性（tenant_access_token）'), 'skip',
      t('凭据未配置，跳过'), ''));
  } else {
    try {
      await tenantToken(cfg);
      tokenOk = true;
      items.push(_docItem('token', t('凭据有效性（tenant_access_token）'), 'ok',
        t('token 获取成功'), ''));
    } catch (error) {
      if (error instanceof FeishuRestError) {
        // 上游错误原文（动态/诊断值）按现状透传，不翻译
        items.push(_docItem('token', t('凭据有效性（tenant_access_token）'), 'fail',
          error.message,
          t('核对取值：开发者后台 → 凭证与基础信息 的 App ID / App Secret')));
      } else {
        items.push(_docItem('token', t('凭据有效性（tenant_access_token）'), 'fail',
          t('探测失败: {error}', { error: errRepr(error) }),
          t('检查站点到 open.feishu.cn 的网络')));
      }
    }
  }

  if (!tokenOk) {
    items.push(_docItem('bot', t('机器人能力与启用状态'), 'skip',
      t('凭据未通过，跳过'), ''));
  } else {
    try {
      const out = await rest('GET', '/open-apis/bot/v3/info', { cfg });
      const bot = out.bot || {};
      const act = bot.activate_status;
      const name = pyTruthy(bot.app_name) ? bot.app_name : t('（未命名）');
      const ok = act === 2;
      items.push(_docItem('bot', t('机器人能力与启用状态'), ok ? 'ok' : 'warn',
        t('{name}（activate_status={act}）', { name, act: pyStr(act) }),
        ok ? '' : t('应用能力 → 添加「机器人」，并在版本管理与发布里发布后生效')));
    } catch (error) {
      if (error instanceof FeishuRestError) {
        items.push(_docItem('bot', t('机器人能力与启用状态'), 'fail', error.message,
          t('应用能力 → 添加应用能力 → 机器人，然后创建版本发布')));
      } else {
        items.push(_docItem('bot', t('机器人能力与启用状态'), 'fail',
          t('探测失败: {error}', { error: errRepr(error) }), t('稍后重试')));
      }
    }
  }

  const st = inboundStatus(userId, options);
  if (!hasCreds) {
    items.push(_docItem('inbound_ws', t('入站长连接（长连接）'), 'skip',
      t('凭据未配置，跳过'), ''));
  } else {
    // 「线程绑的 app」走独立访问口（不进 `inboundStatus` 的形状，见 feishu_cfg.js 的说明）
    items.push(inboundWsItem({ thread: st.thread, app_id: inboundThreadAppId(userId) },
      cfg, dataLang));
  }

  const lastEv = _LAST_EVENT_TS.get(userId);
  if (!hasCreds) {
    items.push(_docItem('inbound_event', t('事件订阅（真实收到过消息）'), 'skip',
      t('凭据未配置，跳过'), ''));
  } else if (lastEv && (Date.now() / 1000 - lastEv) <= EVENT_FRESH_S) {
    items.push(_docItem('inbound_event', t('事件订阅（真实收到过消息）'), 'ok',
      t('{n} 秒前收到过事件', { n: Math.trunc(Date.now() / 1000 - lastEv) }), ''));
  } else {
    items.push(_docItem('inbound_event', t('事件订阅（真实收到过消息）'), 'warn',
      lastEv ? t('最近一次事件已超过 5 分钟') : t('尚未收到过事件'),
      t('给机器人**发一条消息**验证：开发者后台 → 事件与回调 → 订阅方式选「长连接」'
        + '并添加 im.message.receive_v1（按钮交互还需回调 card.action.trigger）')));
  }

  if (!tokenOk) {
    items.push(_docItem('slash_scope', t('斜杠指令权限'), 'skip',
      t('凭据未通过，跳过'), ''));
  } else {
    let sl = null;
    try {
      // T12d：slash 诊断也跟随请求语言（固定引导有 api 词条，上游原文透传）
      sl = await slashStatus(userId, { ...options, lang: dataLang });
    } catch (error) {
      // slash_status 只吞 FeishuRestError；响应形态意外（如 data 非 dict）会漏出其他异常
      // —— doctor 承诺绝不外抛，这里降级为该项 fail。
      items.push(_docItem('slash_scope', t('斜杠指令权限'), 'fail',
        t('探测失败: {error}', { error: errRepr(error) }),
        t('稍后重试；仍失败可在「快捷指令」卡手动「注册 / 同步」看具体报错')));
      sl = null;
    }
    if (sl !== null) {
      if (pyTruthy(sl.need_scope)) {
        items.push(_docItem('slash_scope', t('斜杠指令权限'), 'fail',
          pyTruthy(sl.error) ? sl.error : t('缺权限'),
          t('权限管理 添加 application:app_slash_command:read 与 write，'
            + '并创建版本发布；开通后回设置页点「注册 / 同步到飞书」')));
      } else if (pyTruthy(sl.error)) {
        items.push(_docItem('slash_scope', t('斜杠指令权限'), 'warn', String(sl.error),
          t('可在设置页「快捷指令」卡重试')));
      } else {
        items.push(_docItem('slash_scope', t('斜杠指令权限'), 'ok',
          t('权限可用'), ''));
      }
    }
  }

  let binding = null;
  try {
    binding = getFeishuBindingByUser(userId, options);
  } catch {
    binding = null;
  }
  if (!tokenOk || !binding) {
    items.push(_docItem('send_scope', t('发消息权限（可选探测）'), 'skip',
      binding ? t('凭据未通过，跳过') : t('未绑定飞书账号，跳过'),
      binding ? '' : t('先在下方生成绑定码并在飞书里发「绑定 <码>」')));
  } else if (!sendProbe) {
    items.push(_docItem('send_scope', t('发消息权限（可选探测）'), 'skip',
      t('未探测（勾选「发送测试消息」后重跑自检）'), ''));
  } else if ((Date.now() / 1000 - (_LAST_PROBE_TS.get(userId) || 0)) < SEND_PROBE_MIN_S) {
    items.push(_docItem('send_scope', t('发消息权限（可选探测）'), 'skip',
      t('{n} 秒内已发过测试消息，稍后再试', { n: SEND_PROBE_MIN_S }), ''));
  } else {
    try {
      // 真要发这条 DM 才解析语言（无探测/被频控时不读偏好）
      const lang = (options.lang === null || options.lang === undefined)
        ? userLang(userId, options) : options.lang;
      await restSendText(binding.open_id,
        i18n.t('api', '🔍 Touchstone 配置自检：收到这条消息说明「发消息」权限已开通。',
          lang), cfg);
      _LAST_PROBE_TS.set(userId, Date.now() / 1000);
      items.push(_docItem('send_scope', t('发消息权限（可选探测）'), 'ok',
        t('测试消息已发送，去飞书查看'), ''));
    } catch (error) {
      if (error instanceof FeishuRestError) {
        items.push(_docItem('send_scope', t('发消息权限（可选探测）'), 'fail',
          error.message,
          t('权限管理 添加 im:message:send_as_bot 并创建版本发布')));
      } else {
        items.push(_docItem('send_scope', t('发消息权限（可选探测）'), 'fail',
          t('探测失败: {error}', { error: errRepr(error) }), t('稍后重试')));
      }
    }
  }

  const hook = cfg.default_webhook || '';
  items.push(_docItem('webhook', t('默认推送 Webhook'), pyTruthy(hook) ? 'ok' : 'warn',
    pyTruthy(hook) ? t('已配置') : t('未配置（不影响机器人对话，只影响阻塞事件推送）'),
    pyTruthy(hook) ? '' : t('群设置 → 群机器人 → 添加自定义机器人，把 Webhook 填到设置页')));

  const summary = { ok: 0, fail: 0, warn: 0, skip: 0 };
  for (const it of items) summary[it.state] = (summary[it.state] || 0) + 1;
  return { items, summary };
}

/**
 * 扫码流程现状（`feishu.provision_status`(feishu.py:2985-3004)，设置页轮询口，只读）。
 *
 * 键序恒为 `supported/enabled/state/url/error/app_id/steps/age_s`；等待超 TTL 即对外按
 * failed 呈现（"确认链接已超时（10 分钟有效），可重新发起"）；
 * `app_id` = 在跑流程的应用优先，否则回落**用户配置里的 app_id**（只填 app_id 也算「已接入」，
 * 前端据此二次确认；真正的 force 闸门仍按 `app_config` 两件齐全判定）。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
/** 把 `_PROVISION` 里的 canonical（中文）steps 映射到请求语言（key/ok 机器值不动）。 */
function provisionSteps(steps, lang) {
  return (steps || []).map((s) => ({
    ...s,
    label: i18n.t('api', s.label || '', lang),
    detail: i18n.t('api', s.detail || '', lang),
  }));
}

/** `status.error` 的已知文案映射；上游/动态错误原文原样透传（白名单）。 */
function provisionErrorText(error, lang) {
  if (!error) return error;
  if (error === '扫码流程未返回应用凭据（可能超时或未确认），可重新发起') {
    return i18n.t('api', error, lang);
  }
  for (const [prefix, key] of [
    ['扫码创建失败: ', '扫码创建失败: {error}'],
    ['应用已创建，但配置补齐未完成：', '应用已创建，但配置补齐未完成：{error}'],
  ]) {
    if (error.startsWith(prefix)) {
      let inner = error.slice(prefix.length);
      if (inner === _PATCH_SCOPE_HINT) inner = i18n.t('api', inner, lang);
      return i18n.t('api', key, lang, { error: inner });
    }
  }
  return error;
}

export function provisionStatus(userId, options = {}) {
  const lang = options.lang;
  const st = _PROVISION.get(userId) || {};
  // `st.get("state", "idle")`：**键在就取键值**（哪怕空串），只有键缺席才回落 idle
  let state = st.state === undefined ? 'idle' : st.state;
  let error = st.error === undefined ? '' : st.error;
  const now = Date.now() / 1000;
  if (state === 'waiting' && (now - (st.started_at || 0)) > PROVISION_TTL) {
    state = 'failed';
    error = error || i18n.t('api', '确认链接已超时（10 分钟有效），可重新发起', lang);
  }
  const cfgAppId = (userConfig(userId, options) || {}).app_id;
  const appId = pyTruthy(st.app_id) ? st.app_id : (pyTruthy(cfgAppId) ? cfgAppId : '');
  return {
    supported: provisionSupported(),
    enabled: provisionEnabled(envOf(options)),
    state,
    url: st.url || '',
    error: provisionErrorText(error, lang),
    app_id: appId,
    steps: provisionSteps(st.steps, lang),
    age_s: st.started_at ? Math.trunc(now - st.started_at) : 0,
  };
}

/**
 * 发起扫码建应用（`feishu.provision_start`(feishu.py:3006-3033)）。返回键序 `ok/state/url/error`。
 *
 * **闸门顺序逐字照抄 oracle**：① 总闸（`TS_FEISHU_PROVISION=0`）② 运行时能力
 * ③ 已有进行中流程且未超 TTL（返回既有流程现状）④ 已配置应用需 `force`
 * ⑤ 落 `waiting` 状态 + 起 worker（`threading.Thread(...).start()`，:3030-3031）。
 * M9 起 ② 不再恒拦 ⇒ **③④⑤ 全部可达**；四道闸的实现与文案一字未动。
 *
 * 第 ⑤ 步的 `cancel` 用 `createCancelEvent()`（`threading.Event` 的可用子集），
 * **在锁内**建好后交给 worker —— 与 oracle 同为「先登记状态、再起线程」，
 * 故 worker 一定能看到自己那条状态。
 * @param {number} userId
 * @param {boolean} [force] `bool(body.get("force"))` 口径（调用方已折算）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export async function provisionStart(userId, force = false, options = {}) {
  const lang = options.lang;
  const t = (key, vars) => i18n.t('api', key, lang, vars);
  if (!provisionEnabled(envOf(options))) {
    return { ok: false, state: 'idle', url: '',
      error: t('配置自动化已关闭（{env}=0）', { env: PROVISION_ENV }) };
  }
  if (!provisionSupported()) {
    return { ok: false, state: 'idle', url: '',
      error: t('本机 lark-oapi 版本过低（register_app 需 ≥1.5.5），请升级依赖后重试') };
  }
  return withProvisionLock(async () => {
    const cur = _PROVISION.get(userId) || {};
    if (cur.state === 'waiting'
        && (Date.now() / 1000 - (cur.started_at || 0)) <= PROVISION_TTL) {
      return { ok: true, state: 'waiting', url: cur.url || '', error: '' };
    }
    const cfg = appConfig(userId, options);
    if (cfg !== null && cfg !== undefined && !force) {
      return { ok: false, state: 'idle', url: '',
        error: t('已配置应用 {app_id}；如需换应用请确认后重试', { app_id: cfg.app_id }) };
    }
    const cancel = createCancelEvent();
    _PROVISION.set(userId, {
      state: 'waiting', url: '', error: '', app_id: '', steps: [],
      started_at: Date.now() / 1000, cancel,
    });
    startProvisionWorker(userId, cancel, options);
    return { ok: true, state: 'waiting', url: '', error: '' };
  });
}

/**
 * 取消进行中的扫码流程（`feishu.provision_cancel`(feishu.py:3035-3043)）。
 * 键序 `ok/state/error`（**没有 url**）；无进行中流程时 `state` 取当前态（缺省 idle）。
 */
export function provisionCancel(userId, options = {}) {
  const st = _PROVISION.get(userId) || {};
  if (st.state !== 'waiting') {
    return { ok: false, state: st.state === undefined ? 'idle' : st.state,
      error: i18n.t('api', '当前没有进行中的扫码流程', options.lang) };
  }
  st.cancel.set();
  st.state = 'cancelled';
  return { ok: true, state: 'cancelled', error: '' };
}

/**
 * 版本号递增（`feishu._next_version`(feishu.py:3095-3110)）：取远端版本列表里的**最大语义版本**
 * 补丁位 +1（无版本回 `1.0.0`）。解析失败的版本（非 `x.y.z`、非数字段）忽略；
 * 比较用**整数元组**，避免 `"1.0.10" < "1.0.3"` 的字符串序陷阱。
 * @param {Array<object>} items `data.items`（可空/含坏项）
 * @returns {string}
 */
export function _nextVersion(items) {
  let best = null;
  for (const it of items || []) {
    const raw = pyStrip(pyStr((it || {}).version || ''));
    const nums = [];
    let bad = false;
    for (const part of raw.split('.')) {
      const num = pyIntOfPart(part);
      if (num === null) { bad = true; break; }   // `int(...)` 抛 ValueError ⇒ 该项忽略
      nums.push(num);
    }
    if (bad) continue;
    if (nums.length !== 3) continue;             // 段数不对（`1.0`/`1.2.3.4`）⇒ 忽略
    if (best === null || tupleGt(nums, best)) best = nums;
  }
  if (best === null) return '1.0.0';
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}

/**
 * Python `int(part)` 的可用子集：允许首尾空白与数字间的下划线（`int(" 1")` / `int("1_0")`
 * 在 Python 里都合法），非法返回 `null`（对应 Python 的 `ValueError`）。
 */
function pyIntOfPart(part) {
  const text = String(part).trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(text)) return null;
  return Number.parseInt(text.replace(/_/g, ''), 10);
}

/** Python 元组按元素比较（整数序列；长度已由调用方保证相等） */
function tupleGt(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * 提交发布自建应用（`feishu.provision_publish`(feishu.py:3114-3140)）。
 *
 * 版本号缺省自动递增（先 `GET app_versions`，见 `_nextVersion`）；显式版本走
 * `str(version or "").strip()`。返回键序 `ok/version/version_id/need_patch_scope/error`。
 * 发布后仍需**租户管理员审批**才线上生效（无 API，走前端引导）。
 * @param {number} userId
 * @param {{version?: string|null, remark?: string, changelog?: string,
 *          db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export async function provisionPublish(userId, options = {}) {
  const lang = options.lang;
  const t = (key, vars) => i18n.t('api', key, lang, vars);
  if (!provisionEnabled(envOf(options))) {
    return { ok: false, version: '', version_id: '', need_patch_scope: false,
      error: t('配置自动化已关闭（{env}=0）', { env: PROVISION_ENV }) };
  }
  const cfg = appConfig(userId, options);
  if (cfg === null || cfg === undefined) {
    return { ok: false, version: '', version_id: '', need_patch_scope: false,
      error: t('应用凭据未配置（App ID / App Secret），请先保存凭据') };
  }
  const appId = cfg.app_id;
  let ver = pyStrip(pyStr(options.version || ''));
  try {
    if (!ver) {
      const out = await rest('GET', sprintf(_APP_VERSIONS_API, appId), { cfg });
      const items = ((out.data || {}).items) || [];
      ver = _nextVersion(items);
    }
    const body = {
      version: ver,
      remark: options.remark || 'Touchstone 配置自动化',
      changelog: options.changelog || '自动配置：机器人能力 / 权限 / 长连接事件订阅 / 卡片回调',
      pc_default_ability: 'bot',
      mobile_default_ability: 'bot',
    };
    const out = await rest('POST', sprintf(_APP_PUBLISH_API, appId), { jsonBody: body, cfg });
    const data = out.data || {};
    return { ok: true, version: data.version || ver,
      version_id: pyStr(data.version_id || ''), need_patch_scope: false, error: '' };
  } catch (error) {
    if (error instanceof FeishuRestError) {
      return { ok: false, version: ver, version_id: '', need_patch_scope: _needScope(error),
        error: applyError(error, lang) };
    }
    return { ok: false, version: ver, version_id: '', need_patch_scope: false,
      error: t('发布失败: {error}', { error: errRepr(error) }) };
  }
}

/** Python `str.strip()` 的可用子集（默认去首尾空白；`\x1c-\x1f` 等 Python 特有空白不涉及） */
function pyStrip(value) {
  return String(value).replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
}
