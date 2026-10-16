/**
 * 飞书斜杠指令族（M7-R4；`feishu.py:1194-1574` 的对应物）。
 *
 * 机制背景（照抄 `feishu.py:1186-1192` 的注释）：飞书客户端输入「/」弹出的指令面板由开放平台
 * **按应用维度**下发；应用用 OpenAPI 注册若干条指令（名称 + 说明 + 图标），用户选中即把
 * 「/名称 [参数]」当普通文本消息发给机器人（走既有 im.message.receive_v1 长连接）。
 * 注册/更新约 5 分钟服务端生效 + 客户端约 3 分钟缓存；PC 飞书 7.70+、移动 7.71+。
 *
 * 逐点对齐 oracle（行号即 `feishu.py`）：
 *   - `SLASH_API`(:1194) / `SLASH_COMMANDS`(:1198，**17 条，逐条照抄含中文说明与 icon_key**)；
 *   - `_SLASH_NAMES`(:1217) / `_SLASH_PERM_CODES`(:1219) / `SLASH_ICON_KEYS`(:1229，官方全表 72 键)；
 *   - `slashErrorHint`(:1334) / `_needScope`(:1346)；
 *   - `listSlashCommands`(:1351) / `createSlashCommand`(:1363) / `updateSlashCommand`(:1373) /
 *     `deleteSlashCommand`(:1380) / `_slashUpsert`(:1385)；
 *   - `slashStatus`(:1412) / `syncSlashCommands`(:1433) / `clearSlashCommands`(:1468)；
 *   - `slashPermCard`(:1504) / `sendSlashPermCard`(:1536)。
 *
 * 三条**不许「顺手改」**的语义：
 *   ① 同步**只增/改自己的**指令，**绝不删**用户的其他指令（`extra` 只报不动）；
 *   ② `_slashUpsert` 的差异判定 = 说明**或图标**不一致即更新（图标现已证明可回读，严格判定
 *      既幂等、又能自愈存量指令）；创建撞名 `40000000` 时重取列表按 `command_id` 转更新，
 *      使重复点击「注册/同步」必然收敛而不是报错；
 *   ③ 缺 scope 的三个业务码 `99991640/99991672/99991679` 走 `need_scope` 标记 + 权限引导文案
 *      （设置页据此提供「发飞书权限卡片」入口）。
 *
 * 与 Python 的形态差异（有意，逐条登记）：
 *   - 全部 async；返回值 Promise。Python 是同步阻塞。
 *   - tuple → **冻结数组**、frozenset → `Set`（成员测试同构；`Object.freeze` 对 Set 无约束力，
 *     别往里 add）。对拍按元素/集合比，别比容器类型。
 *   - `slash_upsert` 的 `str` 键 dict（`by_name`）⇒ 接受 **`Map` 或普通对象**（`nameGet` 兼容两者）。
 *   - `send_slash_perm_card` 返回 Python tuple ⇒ 这里返回**数组** `[ok, err]`（同 `db.js` 的
 *     `listFeishuUserCfgs` 对 `list[tuple]` 的处理）。
 *   - 末位多一个 `options = {db, dbPath, env}`（对齐 `feishu_cfg.js`/`db.js` 既有读口形态），
 *     逐层透传给 `appConfig`/`getFeishuBindingByUser`。**不传就会落进缺省库路径**（生产库！），
 *     调用方必传。
 *   - `sorted()` 用**码点比较**（Python 语义；JS 默认 `sort` 是 UTF-16 码元序，emoji 上分叉）。
 *
 * 零 npm 依赖（只用 `./feishu_rest.js`、`./feishu_cfg.js`、`./db.js`）。
 */
import { getFeishuBindingByUser } from './db.js';
import { appConfig } from './feishu_cfg.js';
import {
  FEISHU_DOMAIN, FeishuRestError, rest, restSendCard,
} from './feishu_rest.js';

/** 斜杠指令 OpenAPI 根路径（`feishu.py:1194`；`rest` 会再补一层 `/open-apis` 前缀判定） */
export const SLASH_API = '/open-apis/application/v7/app_slash_commands';

/**
 * 冻结「元组表」的每一行（Python tuple of tuples 的对应物：保序、不可变、按元素比）。
 * @param {any[][]} rows
 * @returns {ReadonlyArray<ReadonlyArray<any>>}
 */
function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/**
 * TS 期望指令清单（指令名, 中文说明, icon_key）。对齐 `feishu.SLASH_COMMANDS`(feishu.py:1198-1216)：
 * 指令名与 `_INTENT_RULES` 的 `/别名` 一一对应（**顺序即面板顺序**）；`icon_key` **必须**取
 * `SLASH_ICON_KEYS` 内的值，表外的键（含按语义自造的）创建即报业务码 40000031
 * （2026-10-09 真机取证：自造的 `add_outlined`/`link_outlined` 让同步停在 15/17 条）。
 */
export const SLASH_COMMANDS = freezeRows([
  ['help', '查看可用指令', 'skill_outlined'],
  ['bind', '绑定站点账号：/bind 绑定码', 'member_outlined'],
  ['unbind', '解除站点账号绑定', 'clear_outlined'],
  ['project', '设置默认项目：/project 项目名', 'home_outlined'],
  ['current', '查看默认项目与当前会话', 'home_outlined'],
  ['projects', '项目总览卡：点选设为默认项目', 'database_outlined'],
  ['sessions', '默认项目最近会话：点选绑定', 'chat_outlined'],
  ['new', '在默认项目下新建会话并绑定：/new [标题]', 'add-chat-ai_outlined'],
  ['use', '绑定已有会话：/use 序号|关键字|会话id前缀', 'global-link_outlined'],
  ['leave', '解绑当前会话（保留默认项目）', 'clear_outlined'],
  ['status', '查看任务与看板摘要：/status [项目名]', 'database_outlined'],
  ['cards', '查找卡片：/cards 关键字（id 前缀 / 标题包含）', 'codeblock_outlined'],
  ['approve', '通过待审核卡片：/approve 卡片', 'flag_outlined'],
  ['reject', '驳回卡片继续开发：/reject 卡片 意见', 'edit_outlined'],
  ['answer', '回复 agent 提问：/answer 卡片 选项序号|文字', 'chat_outlined'],
  ['agree', '批准挂起的工具审批：/agree 卡片 [session]', 'sent_outlined'],
  ['deny', '拒绝挂起的工具审批：/deny 卡片', 'ai-block_outlined'],
]);

/** 指令名元组（`feishu._SLASH_NAMES`(:1217)；判「是不是 TS 自己的指令」用） */
export const _SLASH_NAMES = Object.freeze(SLASH_COMMANDS.map((row) => row[0]));

/** 缺权限/scope 类业务码（`feishu.py:1219`：99991640 lacks permission；另两码同为 scope 相关） */
export const _SLASH_PERM_CODES = Object.freeze([99991640, 99991672, 99991679]);

/** 缺「应用指令」权限的中文引导（`feishu._SLASH_PERM_HINT`:1220-1221，逐字照抄） */
const SLASH_PERM_HINT = '应用缺少「应用指令」权限：飞书开发者后台 → 权限管理，添加 '
  + 'application:app_slash_command:read 与 write，创建并发布新版本后重试';

/** icon_key 非法的中文引导（`feishu._SLASH_ICON_HINT`:1222，逐字照抄） */
const SLASH_ICON_HINT = '指令图标 icon_key 不合法（取值见官方 Slash Command Icon Key 说明）';

/**
 * 官方「Slash Command Icon Key 说明」全量可选值（`feishu.SLASH_ICON_KEYS`:1229-1254，共 72 个，
 * 2026-10-09 抄自开放平台文档）。Python 是 `frozenset` ⇒ 这里用 `Set`（同构，成员测试走 `.has`）。
 * 表外的键一律非法（创建/更新报 40000031）。缺省 `skill_outlined`。
 */
export const SLASH_ICON_KEYS = new Set([
  // AI 系（官方表前 31 项）
  'skill_outlined', 'light-ai_outlined', 'chat-ai_outlined',
  'ai-edit-continue_outlined', 'education-ai_outlined', 'ai-trans-switch_outlined',
  'language-ai_outlined', 'toolbar-more-ai_outlined', 'image-ai_outlined',
  'ai-agent_outlined', 'ai-deepthink_outlined', 'ai-style_outlined',
  'ai-reminder_outlined', 'ai-block_outlined', 'ai-simplify-expression_outlined',
  'promptword_outlined', 'meeting-ai_outlined', 'ai-improvewriting_outlined',
  'slash-ai_outlined', 'pa-cost-ai_outlined', 'update-ai_outlined',
  'diagnosis-ai_outlined', 'ai-functions_outlined', 'mic-ai_outlined',
  'search-ai_outlined', 'explanation-ai_outlined', 'add-ai_outlined',
  'add-chat-ai_outlined', 'ai-notification_outlined', 'dynamic-layout_outlined',
  'ai-doc_outlined',
  // 通用（官方表其余 41 项）
  'home_outlined', 'mail_outlined', 'browser-mac_outlined', 'flag_outlined',
  'calendar-line_outlined', 'sent_outlined', 'gift_outlined', 'tag_outlined',
  'cloud_outlined', 'bonus-payroll_outlined', 'vote_outlined', 'chat_outlined',
  'emoji_outlined', 'member_outlined', 'robot_outlined', 'mic_outlined',
  'raisehand_outlined', 'officephone_outlined', 'effects_outlined', 'labs_outlined',
  'computer_outlined', 'clear_outlined', 'mouse_outlined', 'cellphone_outlined',
  'cursor_outlined', 'plugin_outlined', 'edit_outlined', 'style-fillcolor_outlined',
  'codeblock_outlined', 'code_outlined', 'folder_outlined', 'file-link-word_outlined',
  'file-link-sheet_outlined', 'file-link-image_outlined', 'global-link_outlined',
  'champion_outlined', 'local_outlined', 'day_outlined', 'waiting_outlined',
  'database_outlined', 'marketplace_outlined',
]);

/** Python 真值口径（`""`/`0`/`None`/`False`/空容器为假） */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `isinstance(x, dict)`（`node:sqlite` 的行是普通对象，故直接判原型链外的普通对象） */
function isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Python `str(x)` 的可用子集（错误文案里逐字出现；浮点偏差见 `pyjson.js` 文件头） */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value instanceof Error) return value.message;
  return String(value);
}

/** Python `sorted(list[str])`：**按码点**比较（JS 默认 `sort` 是 UTF-16 码元序，astral 字符上分叉） */
function pySorted(values) {
  return [...values].sort((a, b) => pyStrCompare(a, b));
}

/**
 * Python 字符串序（逐码点比较）。两侧都是「最短往返」字符串，故与 CPython 的 `<` 等价。
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 / 0 / 1
 */
function pyStrCompare(a, b) {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** `x in _SLASH_PERM_CODES`（Python tuple 的 `in` = 逐个 `==`；字符串不隐式转数字） */
function isPermCode(code) {
  return _SLASH_PERM_CODES.some((candidate) => candidate === code);
}

/**
 * Python `getattr(err, "code", None)`：没有 `code` 属性 ⇒ `null`（`undefined` 同折成 `null`）。
 * @param {any} err
 * @returns {any}
 */
function errCode(err) {
  const code = err === null || err === undefined ? null : err.code;
  return code === undefined ? null : code;
}

/**
 * 说明载荷：`default_value` 兜底 + 中文 i18n。对齐 `feishu._slash_description`(feishu.py:1302-1307)。
 * **图标不放这里**——2026-10-05 线上取证：放 `description` 内可被接受但**被忽略**（回读恒为
 * 默认 `skill_outlined`）；放 item 级 POST/PATCH 均生效。
 * @param {string} desc
 * @returns {{default_value: string, i18n: {zh_cn: string}}}
 */
function slashDescription(desc) {
  return { default_value: desc, i18n: { zh_cn: desc } };
}

/**
 * 远端 item → 说明文本。对齐 `feishu._slash_remote_desc`(feishu.py:1310-1318)：
 * GET 回包是 `{default_value,i18n}` 对象，兼容直接给字符串的形态。
 * @param {any} item
 * @returns {string}
 */
function slashRemoteDesc(item) {
  const d = (item || {}).description;
  if (typeof d === 'string') return d;
  if (isDict(d)) return d.default_value || (d.i18n || {}).zh_cn || '';
  return '';
}

/**
 * 远端 item → icon_key。对齐 `feishu._slash_remote_icon`(feishu.py:1321-1331)：
 * 官方示例把 icon 放 `description` 内、回包示例放 item 级，**两种形态都认**；都取不到按缺省
 * `skill_outlined`（与创建时的默认一致）。
 * @param {any} item
 * @returns {string}
 */
function slashRemoteIcon(item) {
  const candidates = [(item || {}).icon];
  const d = (item || {}).description;
  if (isDict(d)) candidates.push(d.icon);
  for (const holder of candidates) {
    if (isDict(holder) && pyTruthy(holder.icon_key)) return holder.icon_key;
  }
  return 'skill_outlined';
}

/**
 * 飞书业务码 → 用户可操作的中文引导（设置页展示用，不抛异常）。
 * 对齐 `feishu.slash_error_hint`(feishu.py:1334-1343)。
 * @param {any} err 一般是 `FeishuRestError`（带 `code`），也接受任意异常
 * @returns {string}
 */
export function slashErrorHint(err) {
  const code = errCode(err);
  if (isPermCode(code)) return SLASH_PERM_HINT;
  if (code === 40000031) return SLASH_ICON_HINT;
  if (code === 99992402) return '指令参数校验失败：指令名需为不含「/」的标识符，说明不可为空';
  return pyStr(err);
}

/**
 * 该失败是否属「应用缺 scope」类——决定要不要向用户发飞书权限引导卡片。
 * 对齐 `feishu._need_scope`(feishu.py:1346-1348)。
 * @param {any} err
 * @returns {boolean}
 */
export function _needScope(err) {
  return isPermCode(errCode(err));
}

/**
 * 已注册指令列表（GET；需要 `application:app_slash_command:read`）。
 * 对齐 `feishu.list_slash_commands`(feishu.py:1351-1360)。
 * @param {object} cfg 用户应用凭据
 * @returns {Promise<Array<{command_id: string, command: string, description: string,
 *                           icon: string, update_time: string}>>}
 */
export async function listSlashCommands(cfg) {
  const out = await rest('GET', SLASH_API, { cfg });
  const items = ((out.data || {}).items) || [];
  return items.map((i) => ({
    command_id: pyStr(i.command_id || ''),
    command: i.command || '',
    description: slashRemoteDesc(i),
    icon: slashRemoteIcon(i),
    update_time: i.update_time || '',
  }));
}

/**
 * 注册一条指令，返回 `command_id`（重名报 40000000 command already exists）。
 * 对齐 `feishu.create_slash_command`(feishu.py:1363-1370)；icon 走 item 级（实测生效）。
 * @param {object} cfg
 * @param {string} command
 * @param {string} desc
 * @param {string} [iconKey]
 * @returns {Promise<string>}
 */
export async function createSlashCommand(cfg, command, desc, iconKey = 'skill_outlined') {
  const out = await rest('POST', SLASH_API, {
    cfg,
    jsonBody: {
      command,
      description: slashDescription(desc),
      icon: { icon_key: iconKey || 'skill_outlined' },
    },
  });
  return pyStr((out.data || {}).command_id || '');
}

/**
 * 按 `command_id` 更新说明与图标（PATCH 幂等；指令名注册后不可改）。
 * 对齐 `feishu.update_slash_command`(feishu.py:1373-1377)。
 * @param {object} cfg
 * @param {string} commandId
 * @param {string} desc
 * @param {string} [iconKey]
 * @returns {Promise<void>}
 */
export async function updateSlashCommand(cfg, commandId, desc, iconKey = 'skill_outlined') {
  await rest('PATCH', `${SLASH_API}/${commandId}`, {
    cfg,
    jsonBody: {
      description: slashDescription(desc),
      icon: { icon_key: iconKey || 'skill_outlined' },
    },
  });
}

/**
 * 删除一条指令（已删除的再删返回 command_id not found，由调用方按幂等处理）。
 * 对齐 `feishu.delete_slash_command`(feishu.py:1380-1382)。
 * @param {object} cfg
 * @param {string} commandId
 * @returns {Promise<void>}
 */
export async function deleteSlashCommand(cfg, commandId) {
  await rest('DELETE', `${SLASH_API}/${commandId}`, { cfg });
}

/** `by_name` 查表（`feishu._slash_upsert` 的入参）：`Map` 与普通对象都接受；未命中回 `null` */
function nameGet(index, name) {
  if (index instanceof Map) {
    const hit = index.get(name);
    return hit === undefined ? null : hit;
  }
  if (index !== null && typeof index === 'object' && Object.hasOwn(index, name)) return index[name];
  return null;
}

/**
 * 单条幂等 upsert（同步循环内的最小执行单元）：返回 `'created'`/`'updated'`/`'kept'`。
 * 对齐 `feishu._slash_upsert`(feishu.py:1385-1409)。差异判定 = 说明**或图标**不一致即更新；
 * 创建撞名（40000000）时重取列表按 `command_id` 转更新，保证重复点击必然收敛。
 * @param {object} cfg
 * @param {string} name 指令名
 * @param {string} desc 中文说明
 * @param {string} icon icon_key
 * @param {Map<string, object>|object} byName `command -> 远端 item` 查表
 * @returns {Promise<'created'|'updated'|'kept'>}
 */
export async function _slashUpsert(cfg, name, desc, icon, byName) {
  const cur = nameGet(byName, name);
  if (cur !== null) {
    if (cur.description === desc && cur.icon === icon) return 'kept';
    await updateSlashCommand(cfg, cur.command_id, desc, icon);
    return 'updated';
  }
  try {
    await createSlashCommand(cfg, name, desc, icon);
    return 'created';
  } catch (e) {
    if (!(e instanceof FeishuRestError)) throw e;
    if (errCode(e) !== 40000000) throw e;
    const fresh = new Map((await listSlashCommands(cfg)).map((r) => [r.command, r]));
    const again = nameGet(fresh, name);
    if (again === null) throw e;
    await updateSlashCommand(cfg, again.command_id, desc, icon);
    return 'updated';
  }
}

/**
 * 设置页读取口：TS 期望清单 + 飞书侧现状（含用户自己的其他指令）。
 * 对齐 `feishu.slash_status`(feishu.py:1412-1430)：凭据缺失/权限不足等一律走 `error` 字段返回，
 * **不抛异常**（页面照常渲染并给引导）；`need_scope` = 缺「应用指令」scope。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 透传给 `appConfig`
 * @returns {Promise<{configured: boolean, desired: Array<object>, remote: Array<object>,
 *                    extra: string[], need_scope: boolean, error: string}>}
 */
export async function slashStatus(userId, options = {}) {
  const desired = SLASH_COMMANDS.map(([command, description, icon]) =>
    ({ command, description, icon }));
  const cfg = appConfig(userId, options);
  if (cfg === null) {
    return {
      configured: false, desired, remote: [], extra: [], need_scope: false,
      error: '未配置应用凭据（App ID/App Secret），先在上方「飞书机器人配置」保存后重试',
    };
  }
  let remote;
  try {
    remote = await listSlashCommands(cfg);
  } catch (e) {
    if (!(e instanceof FeishuRestError)) throw e;
    return {
      configured: true, desired, remote: [], extra: [],
      need_scope: _needScope(e), error: slashErrorHint(e),
    };
  }
  const extra = pySorted(remote.filter((r) => !_SLASH_NAMES.includes(r.command))
    .map((r) => r.command));
  return { configured: true, desired, remote, extra, need_scope: false, error: '' };
}

/**
 * 把 TS 指令清单幂等同步到飞书：只增/改**自己的**指令，**绝不删**用户的其他指令。
 * 对齐 `feishu.sync_slash_commands`(feishu.py:1433-1465)。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{ok: boolean, created?: string[], updated?: string[], kept?: string[],
 *                    extra?: string[], failed?: string[], need_scope: boolean, error: string}>}
 */
export async function syncSlashCommands(userId, options = {}) {
  const cfg = appConfig(userId, options);
  if (cfg === null) {
    return { ok: false, need_scope: false, error: '未配置应用凭据（App ID/App Secret）' };
  }
  let remote;
  try {
    remote = await listSlashCommands(cfg);
  } catch (e) {
    if (!(e instanceof FeishuRestError)) throw e;
    return { ok: false, need_scope: _needScope(e), error: slashErrorHint(e) };
  }
  const byName = new Map(remote.map((r) => [r.command, r]));
  const buckets = { created: [], updated: [], kept: [] };
  const failed = [];
  let needScope = false;
  for (const [name, desc, icon] of SLASH_COMMANDS) {
    if (!SLASH_ICON_KEYS.has(icon)) {
      // 本地预检：表外的键飞书必回 40000031，先在此拦下——省一次请求，
      // 且不让远端停在「同步到一半」的状态（同步是逐条进行的）
      failed.push(`${name}: ${SLASH_ICON_HINT}`);
      continue;
    }
    try {
      buckets[await _slashUpsert(cfg, name, desc, icon, byName)].push(name);
    } catch (e) {
      if (!(e instanceof FeishuRestError)) throw e;
      needScope = needScope || _needScope(e);
      failed.push(`${name}: ${slashErrorHint(e)}`);
    }
  }
  return {
    ok: failed.length === 0,
    created: buckets.created, updated: buckets.updated, kept: buckets.kept,
    extra: pySorted([...byName.keys()].filter((n) => !_SLASH_NAMES.includes(n))),
    failed, need_scope: needScope,
    error: failed.length > 0 ? failed[0] : '',
  };
}

/**
 * 删除**TS 自己的**指令（名字命中 `SLASH_COMMANDS` 的远端项）；用户其他指令不动。
 * 对齐 `feishu.clear_slash_commands`(feishu.py:1468-1492)。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{ok: boolean, deleted?: string[], extra?: string[], failed?: string[],
 *                    need_scope: boolean, error: string}>}
 */
export async function clearSlashCommands(userId, options = {}) {
  const cfg = appConfig(userId, options);
  if (cfg === null) {
    return { ok: false, need_scope: false, error: '未配置应用凭据（App ID/App Secret）' };
  }
  let remote;
  try {
    remote = await listSlashCommands(cfg);
  } catch (e) {
    if (!(e instanceof FeishuRestError)) throw e;
    return { ok: false, need_scope: _needScope(e), error: slashErrorHint(e) };
  }
  const deleted = [];
  const failed = [];
  let needScope = false;
  for (const r of remote) {
    if (!_SLASH_NAMES.includes(r.command)) continue;
    try {
      await deleteSlashCommand(cfg, r.command_id);
      deleted.push(r.command);
    } catch (e) {
      if (!(e instanceof FeishuRestError)) throw e;
      needScope = needScope || _needScope(e);
      failed.push(`${r.command}: ${slashErrorHint(e)}`);
    }
  }
  return {
    ok: failed.length === 0,
    deleted: pySorted(deleted),
    extra: pySorted(remote.filter((r) => !_SLASH_NAMES.includes(r.command)).map((r) => r.command)),
    failed, need_scope: needScope,
    error: failed.length > 0 ? failed[0] : '',
  };
}

/**
 * 权限引导卡片（schema 2.0，DM 单聊）。对齐 `feishu.slash_perm_card`(feishu.py:1504-1533)：
 * 说明缺哪个 scope、三步怎么开通、开发者后台直达链接，底部「我已开通，重试注册」按钮
 * （卡片无状态，`value` 只带身份 `u` 与动作 `t=sc`，回调时按 open_id→binding 复核）。
 * 链接只给「应用详情页」根 URL（深链路由未在官方文档中出现，不猜）。
 * @param {string} appId
 * @param {number} userId
 * @returns {object} 卡片 dict（逐字节照抄 oracle）
 */
export function slashPermCard(appId, userId) {
  const url = appId ? `${FEISHU_DOMAIN}/app/${appId}` : `${FEISHU_DOMAIN}/app`;
  const content = '**Touchstone 快捷指令**（机器人私聊输入框打「/」弹出的指令面板）'
    + '需要你的飞书应用先开通权限：\n'
    + '· `application:app_slash_command:read`\n'
    + '· `application:app_slash_command:write`\n\n'
    + '**开通三步**：\n'
    + `1. 打开 [开发者后台 · 本应用](${url})，左侧 **开发配置 → 权限管理**，点「开通权限」\n`
    + '2. 搜索 `app_slash_command`，把读、写两个权限都勾上并确认开通\n'
    + '3. 左侧 **应用发布 → 版本管理与发布** → 创建版本并发布'
    + '（权限改动必须发版、过审后才生效）\n\n'
    + '完成后点下面的按钮，我立刻重试注册；若刚发版，可等约 1 分钟再点一次。';
  const uid = pyInt(userId);
  const payload = { t: 'sc', a: 'retry', u: uid };
  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: '🔑 需要开通「应用指令」权限' },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content },
        {
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: '我已开通，重试注册' },
          behaviors: [{ type: 'callback', value: payload }],
        },
      ],
    },
  };
}

/** Python `int(x)` 的可用子集：非数值抛 TypeError（Python 也是 TypeError/ValueError） */
function pyInt(value) {
  if (typeof value === 'bigint') return Number(value);
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) throw new TypeError(`int() argument must be a string or a number: ${pyStr(value)}`);
  return Math.trunc(num);
}

/**
 * 向该用户的飞书单聊发权限引导卡片（需已绑定 + 应用凭据齐全）。
 * 对齐 `feishu.send_slash_perm_card`(feishu.py:1536-1550)：未绑定/未配凭据属正常情形，
 * 调用方据此给站点侧提示，**不抛异常**。
 * @param {number} userId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 透传给配置/绑定读口
 * @returns {Promise<[boolean, string]>} `[ok, err]`（Python tuple）
 */
export async function sendSlashPermCard(userId, options = {}) {
  const cfg = appConfig(userId, options);
  if (cfg === null) {
    return [false, '未配置应用凭据（App ID/App Secret），先保存配置再发卡片'];
  }
  const binding = getFeishuBindingByUser(userId, options);
  if (!binding) {
    return [false, '尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复「绑定 <码>」'];
  }
  try {
    await restSendCard(binding.open_id, slashPermCard(cfg.app_id || '', userId), cfg);
    return [true, ''];
  } catch (e) {
    if (!(e instanceof FeishuRestError)) throw e;
    return [false, `卡片发送失败：${pyStr(e)}`];
  }
}
