/**
 * 路由族：看板读 + 看板两条 SSE（M3 读路径）
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头）：
 *   - `GET /api/projects/<id>/board/stream`                      → `_api_board_stream`（SSE）
 *   - `GET /api/projects/<id>/board/sessions/<sid>/stream`       → `_api_board_session_stream`（SSE）
 *   - `GET /api/projects/<id>/board`                             → `_api_get_board`
 *   - `GET /api/projects/<id>/board/sessions`                    → `_api_board_sessions`
 *   - `GET /api/projects/<id>/board/media/<fid>`                 → `_api_board_get_media`（字节）
 *   - `GET /api/projects/<id>/board/trash`                       → `_api_board_trash_list`
 *   - `GET /api/projects/<id>/board/cards/<id>/worktree`         → `_api_board_card_worktree_preview`
 *
 * 两条 SSE 的路径正则**必须先于**其他 `/board/*` 正则（Python `_route_get` 里就在最前，
 * `server.py:1360-1366` 对 `server.py:1384-1413`）。卡片/回收站/评论/设置的写路径属 M5；
 * `/board/session/*`（会话内容）归 `./sessions.js`。
 *
 * ── 逐点照抄 Python 的四处（改前先对着 server.py 核） ────────────────────────────────
 * 1. **两条 SSE 的帧语义**（`server.py:5029`/`5102`）：`hello` 首帧 → `localbus.wait(topic,
 *    since, 15s)` 循环 —— 有变更发 `refresh`、无变更发注释帧 `: keepalive\n\n`；
 *    `since` 每次刷新；**头部带 `X-Accel-Buffering: no`**（只有看板这两条流有）；
 *    客户端断开一律静默收尾（Python 吞 BrokenPipe/ConnectionReset/OSError/ValueError）。
 * 2. **订阅者成对摘除**：`dshevents.subscribe(on_dsh_frame)` 后，`finally` 必须
 *    `unsubscribe` —— 漏摘就是「每开一次看板页泄漏一个订阅者」。客户端断开、写失败、
 *    抛异常三条路径都走同一个 finally。
 * 3. **看板流的绑定 sid 集合**：本项目全部卡片的 `session_id ∪ sessions[]`（坏 JSON 跳过，
 *    对齐 `_sids()` 的 `except (ValueError, TypeError)`）；dsh 状态帧只有 sid 落在集合内才
 *    `localbus.publish(board_topic)`（其余帧被过滤，不产生刷新）。**每 30s 重算一次**
 *    （新绑定的会话最多滞后 30s 才能被事件覆盖）。
 * 4. **卡片附件**：fid 白名单 `^m\d+_[0-9a-f]{10}\.[A-Za-z0-9]{1,10}$` 不匹配即 400
 *    `bad fid`（防路径穿越）；MIME 由扩展名反查 `BOARD_MEDIA_EXTS`（17 项，表照抄
 *    `server.py:2822-2830`），查不到落 `application/octet-stream`；目录 =
 *    `<work_dir or <project_dir>/.touchstone>/board_media`；读不到走 `ctx.file` 的
 *    404 `not found` + text/plain（Python `_send_file` 同形）。
 *
 * ── 与 Python 的两处**形态**差异（语义等价，写在这里防评审重复提问） ────────────────
 * ① **等待口 Promise 化**：Python 每条 SSE 占一个线程阻塞在 `localbus.wait`；Node 是事件
 *    循环，断开信号走 `res.on('close')` 与 wait 竞速（`Promise.race`）——不然已断开的连接
 *    要等满 15s 才收尾。收尾时那个 wait 的定时器最多再活 15s（`ChangeBus` 无取消口），
 *    但它不写任何东西、不持有连接。
 * ② **宽容读**：`_api_board_sessions` / `_board_owns_sid` 在 Python 里对坏 `sessions` JSON
 *    是**未捕获**的 `json.loads`（会 500）；Node 侧与 `board.card_json` 同口径按空表处理
 *    （M3 全仓既定口径，见 `lib/board.js` 文件头差异⑦）。正常库里 `sessions` 恒为合法 JSON。
 *
 * ── 单测时序缝（不是生产开关） ─────────────────────────────────────────────────────
 * `_setSseTiming()` 可缩短两个纯时序窗口（keepalive 等待 15s、绑定集合重算 30s），仅供
 * `backend/test/board-route.test.mjs` 使用——与 Python 测试 monkeypatch `server.localbus.wait`
 * 是同一件事。生产路径恒取模块常量，**不读环境变量、无外部开关**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import * as agents from '../lib/agents.js';
import * as board from '../lib/board.js';
import * as dbmod from '../lib/db.js';
import { DshDriverError } from '../lib/dshdriver.js';
import * as dshdriver from '../lib/dshdriver.js';
import * as dshevents from '../lib/dshevents.js';
import * as localbus from '../lib/localbus.js';
import { pyStrip } from '../lib/lib.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import { PyB64Error, b64decode } from '../lib/pybase64.js';
import { unquote } from '../lib/query.js';
import { DSH_EFFORT_LEVELS, DSH_PERMISSION_PRESETS, familyCapabilities, normalizeEffort,
  sessFamily } from '../lib/servercaps.js';
import * as sessparse from '../lib/sessparse.js';
import { cancelQueueAction, injectMsg } from './sessions.js';

// --------------------------------------------------------------------------
// 常量（照抄 server.py:2820-2830 / 5029-5154 的字面量）
// --------------------------------------------------------------------------

/** 卡片附件子目录名 + 单文件上限（上限只写路径侧用到，M5 上传端点才校验） */
const BOARD_MEDIA_SUBDIR = 'board_media';

/** MIME → 扩展名（`_api_board_upload_media` / `_api_board_get_media` 共用；逐项照抄） */
const BOARD_MEDIA_EXTS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'text/plain': 'txt', 'text/csv': 'csv',
  'text/html': 'html', 'application/pdf': 'pdf', 'application/json': 'json',
  'application/zip': 'zip', 'application/gzip': 'gz',
  'application/x-tar': 'tar', 'application/x-sh': 'sh',
  'application/x-python': 'py',
};

/** 扩展名 → MIME（Python 每次请求现建 `{v: k for k, v in ...}`；预建一份等价，扩展名无重复） */
const BOARD_MEDIA_TYPES = Object.fromEntries(
  Object.entries(BOARD_MEDIA_EXTS).map(([mime, ext]) => [ext, mime]),
);

/** 反查不到的兜底类型（Python 同字面量） */
const BOARD_MEDIA_FALLBACK_TYPE = 'application/octet-stream';

/** fid 白名单（`_api_board_get_media` 的路径穿越闸；与 Python 正则逐字相同） */
const BOARD_MEDIA_FID_RE = /^m\d+_[0-9a-f]{10}\.[A-Za-z0-9]{1,10}$/;

/** keepalive 等待窗口（毫秒）：`localbus.wait(topic, since, 15.0)` */
export const SSE_WAIT_MS = 15000;
/** 看板流绑定 sid 集合重算周期（毫秒）：`time.time() - bound_at > 30` */
export const SSE_BOUND_REFRESH_MS = 30000;

/** 单测可缩短的时序窗口（初值＝生产常量；见文件头「单测时序缝」） */
let sseTiming = { waitMs: SSE_WAIT_MS, boundRefreshMs: SSE_BOUND_REFRESH_MS };

/**
 * **仅供单测**：覆盖 SSE 的两个时序窗口，返回旧值便于还原。
 * 生产代码不得调用（Python 侧等价物是测试里 monkeypatch `localbus.wait`）。
 * @param {{waitMs?: number, boundRefreshMs?: number}} patch
 */
export function _setSseTiming(patch) {
  const old = { ...sseTiming };
  sseTiming = { ...sseTiming, ...patch };
  return old;
}

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/** `session_id ∪ sessions[]`（坏 JSON 按空表，见文件头差异②） */
function cardSids(row) {
  const out = new Set();
  if (row.session_id) out.add(String(row.session_id));
  try {
    const parsed = JSON.parse(row.sessions || '[]');
    for (const v of parsed) out.add(String(v));
  } catch {
    // 坏 JSON：跳过（Python 在 `_sids()` 里同样吞 ValueError/TypeError）
  }
  return out;
}

/** `_sids()`：本项目全部卡片的绑定会话 id 集合 */
function boundSids(projectId, handle) {
  const out = new Set();
  for (const card of dbmod.listBoardCards(projectId, { db: handle })) {
    for (const sid of cardSids(card)) out.add(sid);
  }
  return out;
}

/**
 * `_board_owned(project_id, card_id=None)`：项目归属 + 卡片归属联合校验。
 * `ctx.ownedProject` 越权/不存在时**已回 404**（契约见 `./index.js`），这里直接返回 null 对。
 * @returns {[object|null, object|null]}
 */
function boardOwned(ctx, projectId, cardId = null) {
  const row = ctx.ownedProject(projectId);
  if (row === null) return [null, null];
  if (cardId === null) return [row, null];
  const card = dbmod.getBoardCard(cardId, { db: ctx.db });
  if (card === null || card === undefined || card.project_id !== row.id) {
    ctx.error(404, 'card not found');
    return [null, null];
  }
  return [row, card];
}

/**
 * `_board_owns_sid(row, sid)`：sid 是否归属本项目卡片的会话并集。
 * 返回归属卡片行（调用方可读 id/column_key）；不归属返回 null（防经会话端点读任意会话）。
 */
function boardOwnsSid(row, sid, handle) {
  for (const c of dbmod.listBoardCards(row.id, { db: handle })) {
    if (cardSids(c).has(sid)) return c;
    if (c.session_id && sid === c.session_id) return c;
  }
  return null;
}

/** 卡片附件目录：`<work_dir or <project_dir>/.touchstone>/board_media`（Python 同表达式） */
function mediaDir(row) {
  const base = row.work_dir || path.join(row.project_dir, '.touchstone');
  return path.join(base, BOARD_MEDIA_SUBDIR);
}

/**
 * 看板两条 SSE 的公共循环（`_api_board_stream` / `_api_board_session_stream` 的骨架）。
 *
 * 时序与帧逐点照 Python：hello → 循环 { wait(≤15s)：有变更发 refresh / 超时发 keepalive }
 * → 客户端断开静默收尾。`onCleanup` 在 finally 里无条件执行（摘订阅者）。
 */
async function sseLoop(ctx, { topic, since, hello, refresh, onTick = null, onCleanup }) {
  let conn = null;
  let closed = false;
  let signalClose = null;
  const closedPromise = new Promise((resolve) => { signalClose = resolve; });
  const onClose = () => {
    closed = true;
    signalClose();
  };
  try {
    // 先挂断开监听再写首帧/打开流：三条收尾路径（断开 / 写失败 / 抛异常）都走下面同一个 finally
    if (typeof ctx.res.on === 'function') ctx.res.on('close', onClose);
    conn = ctx.sse({ accelBuffering: true });            // X-Accel-Buffering: no（只这两条流有）
    if (!conn.event('hello', hello)) return;             // 客户端在写首帧前就断了
    for (;;) {
      // 与「客户端断开」竞速：不然已断开的连接要等满一个 keepalive 窗口才收尾
      const next = await Promise.race([
        localbus.wait(topic, since, sseTiming.waitMs),
        closedPromise.then(() => null),
      ]);
      if (closed) break;
      if (next !== null && next !== since) {
        since = next;
        if (!conn.event('refresh', refresh)) break;
      } else if (next !== null) {
        if (!conn.comment('keepalive')) break;           // 写失败＝对端已断
      }
      if (typeof onTick === 'function') onTick();        // 看板流在此重算绑定 sid 集合
    }
  } finally {
    if (typeof ctx.res.off === 'function') ctx.res.off('close', onClose);
    try {
      onCleanup();                                       // 摘订阅者：与 subscribe 成对
    } finally {
      if (conn !== null) conn.end();                     // 对端已断时 end 是 no-op
    }
  }
}

// --------------------------------------------------------------------------
// 端点
// --------------------------------------------------------------------------

/** `_api_get_board`（`server.py:2776`）：看板全量 + 族/能力声明 + 卡片会话标题映射 */
async function getBoard(ctx, m) {
  const projectId = Number(m[1]);
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const payload = board.boardPayload(row.id, { runningMap: board.runningMap(), db: ctx.db });
  // 项目级 agent 族与能力声明（前端看板按 capabilities 泛化门控）
  const family = agents.agentFamily(row.agent_path);
  payload.family = family;
  payload.capabilities = familyCapabilities(family);
  // 卡片相关会话的标题映射（前端列表展示；解析族归一后逐 sid 读取，sessparse 侧有缓存）
  const pfamily = sessFamily(family);
  const titles = {};
  for (const c of payload.cards) {
    for (const sid of c.sessions) {
      if (!Object.prototype.hasOwnProperty.call(titles, sid)) {
        titles[sid] = sessparse.session_title(pfamily, sid);
      }
    }
  }
  payload.session_titles = titles;
  ctx.json(200, payload);
}

/** `_api_board_trash_list`（`server.py:2994`）：回收站列表（项目卡片按删除时间倒序） */
async function boardTrashList(ctx, m) {
  const projectId = Number(m[1]);
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const rm = board.runningMap();
  const cards = dbmod.listTrashedCards(row.id, { db: ctx.db })
    .map((r) => board.cardJson(r, { running: Boolean(rm[r.id]) }, { db: ctx.db }));
  ctx.json(200, { cards });
}

/** `_api_board_sessions`（`server.py:3421`）：工作区已有 agent 会话 + `bound` 标记 */
async function boardSessions(ctx, m) {
  const projectId = Number(m[1]);
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const family = sessFamily(agents.agentFamily(row.agent_path));
  const items = sessparse.list_sessions(family, row.project_dir);
  const bound = new Set();
  for (const c of dbmod.listBoardCards(row.id, { db: ctx.db })) {
    for (const sid of cardSids(c)) bound.add(sid);
  }
  for (const it of items) it.bound = bound.has(it.sid);
  ctx.json(200, { sessions: items });
}

/** `_api_board_get_media`（`server.py:2880`）：卡片附件读取（鉴权 + fid 白名单 + MIME 反查） */
async function boardGetMedia(ctx, m) {
  const projectId = Number(m[1]);
  const fid = m[2];
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  if (!BOARD_MEDIA_FID_RE.test(fid)) {
    ctx.error(400, 'bad fid');
    return;
  }
  const ext = fid.slice(fid.lastIndexOf('.') + 1).toLowerCase();
  const ctype = Object.prototype.hasOwnProperty.call(BOARD_MEDIA_TYPES, ext)
    ? BOARD_MEDIA_TYPES[ext] : BOARD_MEDIA_FALLBACK_TYPE;
  await ctx.file(path.join(mediaDir(row), fid), ctype);
}

/** `_api_board_card_worktree_preview`（`server.py:3158`）：独立 worktree 预览（只读、不落盘） */
async function cardWorktreePreview(ctx, m) {
  const projectId = Number(m[1]);
  const cardId = Number(m[2]);
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  ctx.json(200, board.worktreePreview(row, card));
}

/**
 * `_api_board_stream`（`server.py:5029`）：看板变更事件流。
 *
 * 帧：`hello {project_id}` / `refresh {project_id}` / 注释帧 `: keepalive`。
 * 触发：① 本项目卡片的 db 写路径（`localbus` 由 db 层发布）；② 本项目绑定会话的 dsh 状态帧。
 */
async function boardStream(ctx, m) {
  const projectId = Number(m[1]);
  const project = ctx.ownedProject(projectId);
  if (project === null) return;
  const topic = localbus.boardTopic(projectId);
  // 绑定 sid 集合（dsh 帧按它过滤；新卡会话最多滞后 boundRefreshMs）
  let bound = boundSids(projectId, ctx.db);
  let boundAt = Date.now();
  const onDshFrame = (frame) => {
    // 跑在 dshevents 消费上下文：只做集合判断 + 计数（O(1)，绝不抛）
    const sid = String((frame && frame.session_id) || '');
    if (sid && bound.has(sid)) localbus.publish(topic);
  };
  dshevents.subscribe(onDshFrame);
  // 摘除在 sseLoop 的 finally 里（断开/写失败/异常三条路径同一出口），此处不再重复
  await sseLoop(ctx, {
    topic,
    since: localbus.seq(topic),
    hello: { project_id: projectId },
    refresh: { project_id: projectId },
    onTick: () => {
      if (Date.now() - boundAt > sseTiming.boundRefreshMs) {
        bound = boundSids(projectId, ctx.db);
        boundAt = Date.now();
      }
    },
    onCleanup: () => dshevents.unsubscribe(onDshFrame),
  });
}

/**
 * `_api_board_session_stream`（`server.py:5102`）：会话实时事件流。
 *
 * 帧：`hello {project_id, session_id, events:true}` / `refresh {session_id}` / `: keepalive`。
 * 触发：该 sid 的任一状态帧（`transcript` 逐条消息、`turn/*`、`agent/status`、
 * `driver/interaction`）到达即发一次 refresh —— 前端收到做一次增量拉取。
 * sid 必须归属本项目卡片（`_board_owns_sid`），否则 404 `session not found`。
 */
async function boardSessionStream(ctx, m) {
  const projectId = Number(m[1]);
  // 路由正则对**原始路径**匹配（与 Python `re.match(...self.path)` 同），sid 再 unquote
  const sid = unquote(m[2]);
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const card = boardOwnsSid(row, sid, ctx.db);
  if (card === null) {
    ctx.error(404, 'session not found');
    return;
  }
  const topic = localbus.sessionTopic(sid);
  const onDshFrame = (frame) => {
    if (String((frame && frame.session_id) || '') === sid) localbus.publish(topic);
  };
  dshevents.subscribe(onDshFrame);
  await sseLoop(ctx, {
    topic,
    since: localbus.seq(topic),
    hello: { project_id: projectId, session_id: sid, events: true },
    refresh: { session_id: sid },
    onCleanup: () => dshevents.unsubscribe(onDshFrame),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// M5-4a 看板写端点（第一批：只依赖 M5-1 的库面，不碰会话驱动）
//
// 逐条对齐 `server.py`：建卡 2798 / 回收站还原 3006 / 清空回收站 3031 / 列内拖排 3041 /
// 标记已读 3069 / 加评论 3295 / 删评论 3352 / 改看板设置 3369。
// 需要会话驱动的端点（删卡 / 移列启停 / 投递评论 / 压缩分叉 / worktree 回流 / 附件上传 /
// 作答送达）归 M5-4b，等 `board.py` 的会话驱动面（M5-2/M5-3）落地后再接——见实施计划 §3.5。
//
// ── 三条「照抄 Python 的坏形态」的复刻（不是我们的品味，是 oracle 的行为）────────
// ① `str.strip()[:N]` 的切片按**码点**（Python `str` 语义），`.slice()` 是 UTF-16 码元
//    ——emoji/增补平面字符会分叉，故本文件自带 `cpSlice`（M4.5 在 `chat.register` 踩过同一坑）；
// ② `(body.get("description") or "")[:20000]`：真值非字符串（数字/数组）在 Python 里是
//    `5[:20000]` ⇒ TypeError ⇒ 该连接**无响应即断**；Node 用 `res.destroy()` 复刻同一可观察
//    结果（与 M4.5 `pyStripBare` 同口径：不许「宽容成空串」——那是行为差异）；
// ③ 手写紧凑字节串（`b'{"ok":true}'`）与 `json.dumps({...})`（带 `", "` 分隔）**两种正文形态**
//    在同族端点里混用，逐端点照抄（`ctx.text` vs `ctx.json`）。
// ══════════════════════════════════════════════════════════════════════════

/** Python `dict.get(k)`：只对普通对象取值；数组/标量/缺键一律给缺省（`readJsonBody` 已保证是普通对象） */
function pyGet(obj, key, dflt = null) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return dflt;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

/** Python `bool(x)`：空串/0/空容器/None 皆假（`float('nan')` 为真——`NaN !== 0` 天然成立） */
function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return Object.keys(value).length > 0;
}

/** Python `str(x)` 的**标量面**（容器 repr 是已登记偏差，见 spec §23.7） */
function pyStrScalar(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Python `s[:n]`：按**码点**截断（`.slice` 按 UTF-16 码元，emoji 会切出半个代理对） */
function cpSlice(text, limit) {
  const s = String(text === null || text === undefined ? '' : text);
  const points = Array.from(s);
  return points.length <= limit ? s : points.slice(0, limit).join('');
}

/**
 * 卡片归属校验成功后取「评论行」（Python 是遍历 `list_board_comments` 找 id+card_id 双匹配）。
 *
 * **必须传 `options`**（`{db: ctx.db}`）：读口缺省会自开**缺省库路径**的连接（M4.5 事故的
 * 同一条坑——那次是写口落在生产库）。这里虽只是读，也不许碰生产库。
 */
function findComment(projectId, cardId, commentId, options) {
  for (const c of dbmod.listBoardComments(projectId, options)) {
    if (c.id === commentId && c.card_id === cardId) return c;
  }
  return null;
}

/** `POST /api/projects/<pid>/board/cards`：建卡（`server.py:2798`） */
async function apiBoardCreateCard(ctx, projectId) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  // 允许空标题建卡（用户先建空卡再单击打开详情编辑，标题在详情内补）
  let title = pyGet(body, 'title');
  if (typeof title !== 'string') title = '';        // 非字符串（数字/数组等）按缺失处理
  title = cpSlice(pyStrip(title), 200);
  const descRaw = pyGet(body, 'description');
  const desc = pyTruthy(descRaw) ? descRaw : '';
  if (typeof desc !== 'string') { ctx.res.destroy(); return; }   // Python `5[:20000]` ⇒ TypeError
  const jiraRaw = pyGet(body, 'jira_key');
  const jira = pyTruthy(jiraRaw) ? jiraRaw : '';
  if (typeof jira !== 'string') { ctx.res.destroy(); return; }
  const cid = dbmod.insertBoardCard(row.id, title, cpSlice(desc, 20000), cpSlice(jira, 100),
    { db: ctx.db });
  ctx.json(200, board.cardJson(dbmod.getBoardCard(cid, { db: ctx.db }), {}, { db: ctx.db }));
}

/** `POST /api/projects/<pid>/board/reorder`：列内拖排（`server.py:3041`） */
async function apiBoardReorder(ctx, projectId) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const cardId = board.pyIntLoose(pyGet(body, 'card_id'));
  if (cardId === null) { ctx.error(400, 'card_id required'); return; }
  let beforeId = null;
  const rawBefore = pyGet(body, 'before_id');
  if (rawBefore !== null && rawBefore !== undefined) {
    beforeId = board.pyIntLoose(rawBefore);         // 解析失败按 None（Python 吞掉异常给 None）
  }
  const err = board.reorderCard(row.id, cardId, beforeId, { db: ctx.db });
  if (err) { ctx.errorSpaced(400, err); return; }   // Python `json.dumps({"error": err})` ⇒ 带空格
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `POST /api/projects/<pid>/board/trash/<cid>/restore`：回收站还原（`server.py:3006`） */
async function apiBoardTrashRestore(ctx, projectId, cardId) {
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  if (!card.trashed) { ctx.error(400, 'card not in trash'); return; }
  dbmod.restoreBoardCard(cardId, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `POST /api/projects/<pid>/board/trash/empty`：清空回收站（`server.py:3031`） */
async function apiBoardTrashEmpty(ctx, projectId) {
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  dbmod.purgeTrashedCards(row.id, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `DELETE /api/projects/<pid>/board/trash/<cid>`：彻底删卡（连带评论，`server.py:3018`） */
async function apiBoardTrashPurge(ctx, projectId, cardId) {
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  if (!card.trashed) { ctx.error(400, 'card not in trash'); return; }
  await board.deleteCardCleanup(cardId, { db: ctx.db });   // 幂等兜底：真删前清平台侧残留占用
  dbmod.purgeBoardCard(cardId, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `POST /api/projects/<pid>/board/cards/<cid>/viewed`：清「有更新」标记（`server.py:3069`） */
async function apiBoardMarkViewed(ctx, projectId, cardId) {
  const [row] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const changed = dbmod.markCardViewed(cardId, { db: ctx.db });
  ctx.json(200, { ok: true, unread: false, changed: Boolean(changed) });
}

/** `POST /api/projects/<pid>/board/cards/<cid>/comments`：加评论（`server.py:3295`） */
async function apiBoardAddComment(ctx, projectId, cardId) {
  const body = await ctx.readBody();
  const [row] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const rawText = pyGet(body, 'text');
  const textRaw = pyTruthy(rawText) ? rawText : '';
  if (typeof textRaw !== 'string') { ctx.res.destroy(); return; }  // Python `5.strip()` ⇒ AttributeError
  const text = pyStrip(textRaw);
  if (!text) { ctx.error(400, 'text required'); return; }
  const mid = dbmod.insertBoardComment(cardId, cpSlice(text, 20000), { db: ctx.db });
  const rowC = findComment(row.id, cardId, mid, { db: ctx.db });
  if (rowC === null) { ctx.res.destroy(); return; }   // Python `[...][0]` ⇒ IndexError ⇒ 断连
  ctx.json(200, board.commentJson(rowC));
}

/** `DELETE /api/projects/<pid>/board/cards/<cid>/comments/<comid>`（`server.py:3352`） */
async function apiBoardDeleteComment(ctx, projectId, cardId, commentId) {
  const [row] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  // 评论归属校验（评论 id 全表自增可枚举，防跨项目删除他人评论）
  if (findComment(row.id, cardId, commentId, { db: ctx.db }) === null) {
    ctx.error(404, 'comment not found');
    return;
  }
  dbmod.deleteBoardComment(commentId, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `PATCH /api/projects/<pid>/board/settings`：看板设置（`server.py:3369`） */
async function apiBoardUpdateSettings(ctx, projectId) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const s = board.settingsOf(row.id, { db: ctx.db });
  const mode = pyGet(body, 'mode');
  // 并行模式白名单（serial/parallel 两档；readonly-parallel 2026-09-17 删档，旧前端残余值静默忽略）
  if (board.MODE_VALUES.includes(mode)) s.mode = mode;
  const jira = pyGet(body, 'jira');
  if (jira !== null && typeof jira === 'object' && !Array.isArray(jira)) {
    for (const k of ['url', 'user', 'token']) {
      if (Object.prototype.hasOwnProperty.call(jira, k)) {
        s.jira[k] = cpSlice(pyStrScalar(jira[k]), 500);
      }
    }
  }
  const syncSessions = pyGet(body, 'sync_sessions');
  if (typeof syncSessions === 'boolean') s.sync_sessions = syncSessions;
  // 每列排序方案：逐列白名单（key∈五列、value∈SORT_MODES、entered_desc 仅 done 列）；
  // 逐列合并进现值，非法整份拒绝
  const sort = pyGet(body, 'sort');
  if (sort !== null && typeof sort === 'object' && !Array.isArray(sort)) {
    for (const [col, mode2] of Object.entries(sort)) {
      if (!board.COLUMNS.includes(col) || !board.SORT_MODES.includes(mode2)) {
        ctx.error(400, 'bad sort');
        return;
      }
      if (mode2 === 'entered_desc' && col !== 'done') {
        ctx.error(400, 'bad sort');
        return;
      }
      s.sort[col] = mode2;
    }
  }
  dbmod.setBoardSettings(row.id, s, { db: ctx.db });
  ctx.json(200, s);
}

// ══════════════════════════════════════════════════════════════════════════
// M5-4b 看板写端点（第二批：依赖 M5-2 的会话驱动面）
//
// 逐条对齐 `server.py`：卡动作 move|start|stop 3087 / worktree 清理 3172 / worktree 回流 3193 /
// compact 3215 / fork-compact 3238 / fork 3268 / 投递评论 3310 / 删卡 2980。
// 仍需 M5-3 的端点（PATCH 改卡要 `rename_card_session`/`archive_bound_session`、作答送达、
// 会话 profile/inject/rewind、jira、附件上传）留到下一批。
//
// 三处照抄 Python 的形态（别「顺手统一」）：
//   ① **写死的紧凑体**（`b'{"ok":true}'` / `b'{"error":"sid required"}'`）与
//      `json.dumps(...)`（带空格）在同族端点里混用 —— 逐端点照抄；
//   ② 「父任务拦截 / 待合并询问」**回 200**（`blocked` / `merge_pending` 在 err 里但**不算错误**，
//      前端据此弹确认框，列未变）；
//   ③ `except RuntimeError` ⇒ 400（业务拒绝），`except DshDriverError` ⇒ 409/500 两档
//      （409 是「会话运行中」的忙拒绝，其余按 500 `agent 调用失败: <e>`）。
// ══════════════════════════════════════════════════════════════════════════

/** Python `str(e)`：异常 → 可进正文的文本（`DshDriverError.toString()` 是纯消息；普通 Error 取 `.message`） */
function pyStrErr(err) {
  if (err === null || err === undefined) return String(err);
  if (err instanceof DshDriverError) return String(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

/** `POST .../board/cards/<cid>/(move|start|stop)`：卡动作（`server.py:3087`） */
async function apiBoardCardAction(ctx, projectId, cardId, action) {
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  if (action === 'stop') {
    // body 在 stop 分支按需读（`ctx.readBody` 记忆化，时机对齐 Python `do_POST:1048` 的
    // 「分派前统一读体」）：缺省（旧前端不带体）⇒ 原样停止，响应体一字不变。
    // `mode=cancel_queue` ⇒ 会话窗「取消排队」：纯平台侧取消排队消息、不碰轮次（2026-10-17）。
    const body = await ctx.readBody();
    if (pyStrScalar(pyGet(body, 'mode') || '') === 'cancel_queue') {
      cancelQueueAction(ctx, body, { cardId });
      return;
    }
    const hit = await board.stopCard(cardId, { db: ctx.db });
    ctx.json(200, { ok: true, stopped: hit });
    return;
  }
  const body = await ctx.readBody();
  if (action === 'move') {
    const target = pyStrip(pyStrScalar(pyGet(body, 'column') || ''));
    let beforeId = null;
    const rawBefore = pyGet(body, 'before_id');
    if (rawBefore !== null && rawBefore !== undefined) beforeId = board.pyIntLoose(rawBefore);
    const blockTextRaw = pyGet(body, 'block_text');
    const blockText = cpSlice(pyTruthy(blockTextRaw) ? pyStrScalar(blockTextRaw) : '', 2000);
    const [cardDict, err] = await board.moveCard(row, cardId, target, blockText, beforeId,
      pyTruthy(pyGet(body, 'merge_ack')), { db: ctx.db });
    if (err) {
      if ('blocked' in err || 'merge_pending' in err) { ctx.json(200, err); return; }
      ctx.errorSpaced(400, err.error ?? '');
      return;
    }
    ctx.json(200, { card: cardDict });
    return;
  }
  // start：归档项目禁止；门禁+起会话+落列原子化走 `startIntoDoing`
  if (row.archived) { ctx.error(400, '项目已归档'); return; }
  const opinionRaw = pyGet(body, 'opinion');
  const opinion = cpSlice(pyTruthy(opinionRaw) ? pyStrScalar(opinionRaw) : '', 20000);
  // doing+queue 排队占位卡放行 start（force=true 直起跳队，非 force 幂等补队自愈滞留卡）；
  // done 列放行（已完成卡拖入「正在开发」= 接着干，续接主会话只发「继续」）
  if (!['todo', 'review', 'blocked', 'done'].includes(card.column_key)
      && !(card.column_key === 'doing' && card.block_kind === 'queue')) {
    ctx.error(400, '当前状态不可开始');
    return;
  }
  const [cardDict, err] = await board.startIntoDoing(row, card, opinion,
    pyTruthy(pyGet(body, 'force')), pyTruthy(pyGet(body, 'worktree')), false, { db: ctx.db });
  if (err) {
    if ('blocked' in err) { ctx.json(200, err); return; }   // 父任务拦截：不算错误
    ctx.errorSpaced(400, err.error ?? '');
    return;
  }
  ctx.json(200, { card: cardDict });
}

/** `DELETE /api/projects/<pid>/board/cards/<cid>`：删卡=移入回收站（`server.py:2980`） */
async function apiBoardDeleteCard(ctx, projectId, cardId) {
  const [row] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  await board.stopCard(cardId, { db: ctx.db });           // 运行中进程先停
  await board.deleteCardCleanup(cardId, { db: ctx.db });  // 清平台侧残留（幂等）
  dbmod.trashBoardCard(cardId, { db: ctx.db });
  ctx.text(200, '{"ok":true,"trashed":true}', 'application/json; charset=utf-8');
}

/** `POST .../board/cards/<cid>/comments/<comid>/send`：投递评论（`server.py:3310`） */
async function apiBoardSendComment(ctx, projectId, cardId, commentId) {
  const body = await ctx.readBody();
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const target = findComment(row.id, cardId, commentId, { db: ctx.db });
  if (target === null) { ctx.error(404, 'comment not found'); return; }
  let rec;
  try {
    // inject=true 时立即注入运行中的当前轮；项目忙时登记统一队列消息单元（回 queued=true）
    rec = await board.deliverComment(row, card, target, pyTruthy(pyGet(body, 'inject')),
      { db: ctx.db });
  } catch (e) {
    if (e instanceof DshDriverError) {
      // 409 = 会话运行中（deliver_comment 的忙拒绝）；其余 code 按 500
      if (Array.isArray(e.args) && e.args[0] === 409) {
        ctx.errorSpaced(409, e.args.length > 1 ? e.args[1] : '会话运行中，稍后重试');
      } else {
        ctx.errorSpaced(500, `agent 调用失败: ${pyStrErr(e)}`);
      }
      return;
    }
    ctx.errorSpaced(400, pyStrErr(e));         // Python `except RuntimeError` ⇒ 400（顺序照抄）
  }
  if (rec === undefined) return;
  ctx.json(200, { ok: true, queued: Boolean(rec && rec.queued), msg_id: (rec || {}).id || '' });
}

/** `POST .../board/cards/<cid>/compact|fork-compact|fork`（`server.py:3215/3238/3268`） */
async function apiBoardSessionOp(ctx, projectId, cardId, op) {
  const body = await ctx.readBody();
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const sidRaw = pyGet(body, 'sid');
  const sid = pyStrip(pyTruthy(sidRaw) ? pyStrScalar(sidRaw) : (card.session_id || ''));
  if (!sid) { ctx.error(400, 'sid required'); return; }
  if (board.runningMap().get(cardId)) {
    ctx.errorSpaced(409, '会话运行中，稍后再试');
    return;
  }
  try {
    if (op === 'compact') {
      await board.compactSession(row, card, sid, { db: ctx.db });
      ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
      return;
    }
    if (op === 'fork-compact') {
      const [newSid, compactOk] = await board.forkCompactSession(row, card, sid, { db: ctx.db });
      ctx.json(200, { ok: true, new_sid: newSid, compact_ok: compactOk });
      return;
    }
    const newSid = await board.forkSession(row, card, sid, { db: ctx.db });
    ctx.json(200, { ok: true, new_sid: newSid });
  } catch (e) {
    ctx.errorSpaced(400, pyStrErr(e));         // Python `except RuntimeError` ⇒ 400
  }
}

/** `DELETE .../board/cards/<cid>/worktree`：清理独立 worktree（`server.py:3172`） */
async function apiBoardWorktreeCleanup(ctx, projectId, cardId) {
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  if (board.runningMap().get(cardId)) {
    ctx.errorSpaced(409, '会话运行中，请先停止卡片再清理 worktree');
    return;
  }
  const [ok, err] = board.cleanupCardWorktree(row, card, { db: ctx.db });
  if (!ok) { ctx.errorSpaced(400, err); return; }
  ctx.text(200, '{"ok": true}', 'application/json; charset=utf-8');
}

/** `POST .../board/cards/<cid>/worktree/merge`：把回流合并任务交给卡片会话（`server.py:3193`） */
async function apiBoardWorktreeMerge(ctx, projectId, cardId) {
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const [cardDict, err] = await board.handoffWorktreeMerge(row, card, { db: ctx.db });
  if (err) { ctx.errorSpaced(400, err.error ?? pyStrErr(err)); return; }
  ctx.json(200, { card: cardDict });
}

// ══════════════════════════════════════════════════════════════════════════
// M5-4c 看板写端点（第三批：附件上传 / 改卡 / 作答送达 / 会话 profile·inject·rewind / jira）
//
// 逐条对齐 `server.py`：附件上传 2832 / 改卡 2899 / jira 3404 / 会话 profile 3577 /
// 作答 3703 / 立即送达 3750 / 会话 inject 3765 / 会话 rewind 3833（+ 共用实现
// `_inject_msg` 3795、`_rewind_session_dsh` 3878）。
//
// 四处照抄 Python 的形态（别「顺手统一」）：
//   ① **错误正文两种形态混用**：`PATCH` 改卡的 `bad scheduled_at`/`title required`/循环依赖
//      是硬编码紧凑串（`ctx.error`），会话 profile/rewind 的是 `json.dumps`（`ctx.errorSpaced`）；
//   ② 附件上传**不是 multipart**：正文是 base64 JSON（`{name,mime,data}`），所以不需要
//      表单解析器 —— 计划 §3.5 里「按同一字节口径自解析 multipart」的预案作废（Python 侧
//      就是 JSON，见 `_api_board_upload_media` 文档串）；
//   ③ `data` 的解码走 `lib/pybase64.js`（Python `base64.b64decode` 的**报错口径**，
//      不能用 `Buffer.from(s,'base64')`——它永不报错，坏 base64 会变成垃圾附件 + 200）；
//   ④ 会话 inject 与任务族共用 `sessions.js:injectMsg`（`_inject_msg` 单实现），
//      `taskId` 留 null ⇒ 归属三重判定自动退化成看板版。
// ══════════════════════════════════════════════════════════════════════════

/** 单文件上限 10MB（`server.py:2821` `BOARD_MEDIA_MAX`） */
const BOARD_MEDIA_MAX = 10 * 1024 * 1024;

/**
 * Python `k in obj`（`dict`/`list` 两形态；`str` 是子串判定）。
 *
 * 为什么需要它：改卡的字段判定全是 `if "title" in body` 形态，Python 的 `in` 对 dict 是
 * **键**、对 list 是**成员**、对 str 是**子串**。标量（数字/布尔）在 Python 抛 TypeError
 * （断连）——Node 侧按「宽容」给 false（与 `card_json` 的宽容读同口径，见文件头差异②）。
 */
function pyHas(obj, key) {
  if (obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.includes(key);
  if (typeof obj === 'object') return Object.prototype.hasOwnProperty.call(obj, key);
  if (typeof obj === 'string') return obj.includes(key);
  return false;
}

/** Python `str(x)`：走 `pyStrScalar`（标量面；容器 repr 是已登记偏差） */
function pyStrFull(value) {
  return pyStrScalar(value);
}

/** `json.loads(card["sessions"] or "[]")`：坏 JSON 按空表（M3 宽容口径，见文件头差异②） */
function cardSessionList(card) {
  try {
    const parsed = JSON.parse(card.sessions || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `POST /api/projects/<pid>/board/media`：卡片附件上传（`server.py:2832`）。
 *
 * 正文 `{name, mime, data}`（data = base64）；单文件 ≤10MB；mime 未知按 `bin` 存。
 * 响应 `{fid, url, abs, name, size}`（键序照 Python）。
 */
async function apiBoardUploadMedia(ctx, projectId) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const mimeRaw = pyGet(body, 'mime');
  const mime = cpSlice(pyStrScalar(pyTruthy(mimeRaw) ? mimeRaw : 'application/octet-stream'),
    100);
  const nameRaw = pyGet(body, 'name');
  const name = cpSlice(pyStrScalar(pyTruthy(nameRaw) ? nameRaw : 'file'), 200);
  const dataRaw = pyGet(body, 'data');
  const dataStr = pyStrScalar(pyTruthy(dataRaw) ? dataRaw : '');
  let data;
  try {
    data = b64decode(dataStr);
  } catch (e) {
    if (e instanceof PyB64Error) { ctx.error(400, 'bad base64'); return; }   // 紧凑
    throw e;
  }
  if (data.length === 0) { ctx.error(400, 'empty file'); return; }
  if (data.length > BOARD_MEDIA_MAX) { ctx.error(400, 'file too large'); return; }
  const ext = Object.prototype.hasOwnProperty.call(BOARD_MEDIA_EXTS, mime)
    ? BOARD_MEDIA_EXTS[mime] : 'bin';
  // Python `f"m{int(time.time()*1000)}_{secrets.token_hex(5)}.{ext}"`：毫秒 + 10 位小写 hex
  const fid = `m${Date.now()}_${randomBytes(5).toString('hex')}.${ext}`;
  const mdir = mediaDir(row);
  const abs = path.join(mdir, fid);
  try {
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(abs, data);
  } catch (e) {
    // Python `except OSError as e` ⇒ 500 `save failed: {e}`（带空格；错误文案本身是已登记偏差）
    ctx.errorSpaced(500, `save failed: ${pyStrErr(e)}`);
    return;
  }
  ctx.json(200, { fid, url: `/api/projects/${projectId}/board/media/${fid}`,
    abs, name, size: data.length });
}

/**
 * `PATCH /api/projects/<pid>/board/cards/<cid>`：改卡（`server.py:2899`）。
 *
 * 白名单字段直过；`parent_card_id` 走 `set_parent` 防循环；`bind_session`/`unbind_session`
 * 维护 `sessions`/`session_id`；新绑定会话在 done 卡上补归档同步；卡面改名同步 DSH 会话名
 * （`session_rename` 只如实上报，**不回写卡面**）。
 */
async function apiBoardUpdateCard(ctx, projectId, cardId) {
  const body = await ctx.readBody();
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  if (pyHas(body, 'title') && !pyStrip(pyStrFull(pyGet(body, 'title')))) {
    ctx.error(400, 'title required');                    // 紧凑
    return;
  }
  const fields = {};
  let newlyBound = '';                                   // 本次真正新增的绑定会话
  for (const k of ['title', 'description', 'block_text']) {
    if (pyHas(body, k)) {
      // 标题与建卡同限 200 字，其余长文本 20000
      fields[k] = cpSlice(pyStrFull(pyGet(body, k)), k === 'title' ? 200 : 20000);
    }
  }
  if (pyHas(body, 'scheduled_at')) {
    const v = pyGet(body, 'scheduled_at');
    if (!pyTruthy(v)) {
      fields.scheduled_at = null;                        // Python `int(v) if v else None`
    } else {
      const n = board.pyIntLoose(v);
      if (n === null) { ctx.error(400, 'bad scheduled_at'); return; }
      fields.scheduled_at = n;
    }
  }
  if (pyHas(body, 'session_id')) {                       // 设主会话（须已在 sessions 列表内）
    const sid = pyStrFull(pyGet(body, 'session_id'));
    if (cardSessionList(card).includes(sid)) fields.session_id = sid;
  }
  if (pyHas(body, 'bind_session')) {                     // 绑定外部会话 id
    const sid = pyStrip(pyStrFull(pyGet(body, 'bind_session')));
    if (sid) {
      const sessions = cardSessionList(card);
      if (!sessions.includes(sid)) {
        sessions.push(sid);
        newlyBound = sid;
      }
      fields.sessions = pyJsonDumps(sessions);           // Python `json.dumps(..., ensure_ascii=False)`
      if (!card.session_id) fields.session_id = sid;
    }
  }
  if (pyHas(body, 'unbind_session')) {                   // 解绑（主会话被解绑时取剩余第一个）
    const sid = pyStrFull(pyGet(body, 'unbind_session'));
    const sessions = cardSessionList(card).filter((s) => s !== sid);
    fields.sessions = pyJsonDumps(sessions);
    if (card.session_id === sid) fields.session_id = sessions.length ? sessions[0] : '';
  }
  if (pyHas(body, 'parent_card_id')) {
    const err = board.setParent(row.id, cardId, pyGet(body, 'parent_card_id'), { db: ctx.db });
    if (err) { ctx.error(400, '循环依赖或父任务不存在'); return; }
  }
  if (Object.keys(fields).length) {
    dbmod.updateBoardCard(cardId, true, fields, { db: ctx.db });
  }
  if (newlyBound) {
    // 归档同步（I2「done 卡全部绑定会话都归档」）：best-effort，失败只记提示 + 退避重试。
    // 注意 `archiveBoundSession` 的第三参是 **reason**（Python 同签名），没有 options 位。
    await board.archiveBoundSession(dbmod.getBoardCard(cardId, { db: ctx.db }), newlyBound);
  }
  let renameInfo = null;
  if (pyHas(fields, 'title') && pyStrip(fields.title)
      !== pyStrip(card.title || '')) {
    // 卡面改名 → 同步改 DSH 会话名（只认改后的主会话）；best-effort，失败不改卡面
    const fresh = dbmod.getBoardCard(cardId, { db: ctx.db });
    const sid = String((fresh ? fresh.session_id : '') || '');
    if (sid) {
      const [ok, err, accepted] = await board.renameCardSession(sid, pyStrip(fields.title));
      renameInfo = { ok, session_id: sid };
      if (!ok) {
        renameInfo.error = err;
      } else if (accepted && accepted !== fields.title) {
        // 宿主规范化/截断：只如实上报，**不回写卡面**（卡面是用户原文）
        renameInfo.accepted_title = accepted;
      }
    }
  }
  const payload = board.cardJson(dbmod.getBoardCard(cardId, { db: ctx.db }), {}, { db: ctx.db });
  if (renameInfo) payload.session_rename = renameInfo;
  ctx.json(200, payload);
}

/** `POST .../board/cards/<cid>/interaction/answer`：作答/审批（`server.py:3703`） */
async function apiBoardAnswerInteraction(ctx, projectId, cardId) {
  const body = await ctx.readBody();
  const [row, card] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const fam = agents.agentFamily(row.agent_path);
  if (fam !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持回答问题');
    return;
  }
  let err;
  if (pyTruthy(pyGet(body, 'approval_id'))) {
    // Python 四处都是 `str(body.get(x) or "")` —— **必须带 `or ""`**：`str(None)` 是 `'None'`，
    // 少了它，缺 `qid` 的请求会拿 `'None'` 去比对 qid 白名单，错误文案从
    // `qid/approval_id required` 悄悄变成「提问不存在或已过期」（M5-4c 单测抓到）。
    const orEmpty = (k) => pyStrScalar(pyTruthy(pyGet(body, k)) ? pyGet(body, k) : '');
    err = await board.answerApproval(row, card, orEmpty('approval_id'),
      orEmpty('decision'), orEmpty('scope'), { db: ctx.db });
  } else {
    const qid = pyStrScalar(pyTruthy(pyGet(body, 'qid')) ? pyGet(body, 'qid') : '');
    if (!qid) { ctx.error(400, 'qid/approval_id required'); return; }
    err = await board.answerInteraction(row, card, qid, pyGet(body, 'answers') || [],
      { db: ctx.db });
  }
  if (err) { ctx.errorSpaced(400, err); return; }
  // 一律入队（闲时直送已删）⇒ queued 由 `is_answer_pending` 现读表派生
  ctx.json(200, { ok: true, queued: Boolean(board.isAnswerPending(card.id, { db: ctx.db })) });
}

/** `POST .../board/cards/<cid>/answer/deliver`：「立即送达」待送达答案（`server.py:3750`） */
async function apiBoardDeliverAnswer(ctx, projectId, cardId) {
  const [row] = boardOwned(ctx, projectId, cardId);
  if (row === null) return;
  const [ok, err] = await board.deliverPendingAnswerNow(cardId, { db: ctx.db });
  if (!ok) { ctx.errorSpaced(400, err); return; }
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `POST .../board/sessions/<sid>/profile`：会话级模型/权限档/思考等级（`server.py:3577`） */
async function apiBoardSessionProfile(ctx, projectId, sid) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  if (boardOwnsSid(row, sid, ctx.db) === null) { ctx.error(404, 'session not found'); return; }
  const fam = agents.agentFamily(row.agent_path);
  const model = pyStrScalar(pyTruthy(pyGet(body, 'model')) ? pyGet(body, 'model') : '');
  const pmode = pyStrScalar(pyTruthy(pyGet(body, 'permission_mode'))
    ? pyGet(body, 'permission_mode') : '');
  const effort = pyHas(body, 'reasoning_effort')
    ? normalizeEffort(pyGet(body, 'reasoning_effort')) : '';
  if (fam !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持会话级配置');
    return;
  }
  if (effort === null) {
    ctx.errorSpaced(400, `思考等级非法（${DSH_EFFORT_LEVELS.join('/')} 或留空）`);
    return;
  }
  if (!model && !pmode && !effort) {
    ctx.error(400, 'model/permission_mode/reasoning_effort required');   // 紧凑
    return;
  }
  if (pmode && !Object.prototype.hasOwnProperty.call(DSH_PERMISSION_PRESETS, pmode)) {
    ctx.errorSpaced(400, '权限档非法（manual/yolo/auto）');
    return;
  }
  try {
    if (pmode) {
      // 三档 mode 一并下传（宿主 preset 到三档是多对一，只靠回读 preset 反推不出档位）
      await dshdriver.setPermission(sid, DSH_PERMISSION_PRESETS[pmode], pmode);
    }
    if (model || effort) {
      // 只改思考等级时 model 传空串：插件从会话当前模型选择回读 provider/model
      await dshdriver.setModel(sid, model, '', effort);
    }
  } catch (e) {
    if (e instanceof DshDriverError) { ctx.errorSpaced(502, pyStrErr(e)); return; }
    throw e;
  }
  ctx.json(200, { ok: true, model, permission_mode: pmode, reasoning_effort: effort || '' });
}

/** `POST .../board/sessions/<sid>/inject`：排队消息立即注入（`server.py:3765`） */
async function apiBoardSessionInject(ctx, projectId, sid) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  if (boardOwnsSid(row, sid, ctx.db) === null) { ctx.error(404, 'session not found'); return; }
  // 与任务族同实现（`_inject_msg`）；taskId=null ⇒ 归属判定只查 sid/project_id
  await injectMsg(ctx, row, sid, body, null);
}

/** `POST .../board/sessions/<sid>/rewind`：会话回退＝按边界 fork（`server.py:3833`） */
async function apiBoardSessionRewind(ctx, projectId, sid) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  if (boardOwnsSid(row, sid, ctx.db) === null) { ctx.error(404, 'session not found'); return; }
  const fam = agents.agentFamily(row.agent_path);
  if (fam !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持会话回退');
    return;
  }
  const mid = pyStrScalar(pyTruthy(pyGet(body, 'mid')) ? pyGet(body, 'mid') : '');
  const boundary = sessparse.dsh_fork_boundary(sid, mid);
  if (boundary === null) {
    ctx.errorSpaced(409, '该提问已被回退或会话已变化，请刷新后重试');
    return;
  }
  let newSid;
  try {
    newSid = String(((await dshdriver.fork(sid, boundary)) || {}).new_session_id || '');
    if (!newSid) throw new DshDriverError(-2, 'fork 未返回新会话 id');
    // 接进驱动池：UI 切过去后可直接续聊（不接池则 /rename、/compact 会 404）
    await dshdriver.ensureSession(newSid, row.project_dir, `rewind-${sid.slice(0, 8)}`);
  } catch (e) {
    if (e instanceof DshDriverError) {
      ctx.errorSpaced(502, `回退失败：${pyStrErr(e)}`);
      return;
    }
    throw e;
  }
  // 只创建新会话，**不改绑定**（切换是 UI 的显式动作）；`rebound` 恒 false（看板路径无 task）
  ctx.json(200, { ok: true, new_session_id: newSid, boundary, rebound: false });
}

/** `POST .../board/jira/(test|import)`：Jira 试连/导入（`server.py:3404`） */
async function apiBoardJira(ctx, projectId, action) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  let result;
  if (action === 'test') {
    const cfg = {
      url: pyStrScalar(pyGet(body, 'url') || ''),
      user: pyStrScalar(pyGet(body, 'user') || ''),
      token: pyStrScalar(pyGet(body, 'token') || ''),
    };
    result = await board.jiraMyself(cfg);
  } else {
    result = await board.jiraImport(row.id, { db: ctx.db });
  }
  ctx.json(pyTruthy(pyGet(result, 'ok')) ? 200 : 400, result);
}

/**
 * 路由表（顺序＝匹配顺序；见 `./index.js` 文件头与 `server.py:_route_get`）。
 * 两条 SSE 必须排在最前：`/board/sessions/<sid>/stream` 会被 `/board/sessions` 前缀吞掉吗？
 * 不会——匹配是整段正则，但**顺序仍照 Python**（先流、后普通），免得以后有人放宽正则时踩坑。
 */
export const routes = [
  { method: 'GET', re: /^\/api\/projects\/(\d+)\/board\/stream$/, handler: boardStream },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/board\/sessions\/([^/]+)\/stream$/,
    handler: boardSessionStream,
  },
  { method: 'GET', re: /^\/api\/projects\/(\d+)\/board$/, handler: getBoard },
  { method: 'GET', re: /^\/api\/projects\/(\d+)\/board\/sessions$/, handler: boardSessions },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/board\/media\/([A-Za-z0-9._-]+)$/,
    handler: boardGetMedia,
  },
  { method: 'GET', re: /^\/api\/projects\/(\d+)\/board\/trash$/, handler: boardTrashList },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/worktree$/,
    handler: cardWorktreePreview,
  },
  // ---------- 写路径（顺序照 Python 各 do_* 链里的先后；M5-4c 的条目已按同位补进来）----------
  // do_POST 链：建卡 → 附件上传 → 拖排 → 回收站还原 → 清空回收站 → 卡片动作
  //             → worktree 回流 → 标记已读 → compact/fork → 作答 → 立即送达
  //             → 会话 profile/inject/rewind → 加评论 → 投递评论 → jira
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards$/,
    handler: (ctx, m) => apiBoardCreateCard(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/media$/,
    handler: (ctx, m) => apiBoardUploadMedia(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/reorder$/,
    handler: (ctx, m) => apiBoardReorder(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/trash\/(\d+)\/restore$/,
    handler: (ctx, m) => apiBoardTrashRestore(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/trash\/empty$/,
    handler: (ctx, m) => apiBoardTrashEmpty(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/(move|start|stop)$/,
    handler: (ctx, m) => apiBoardCardAction(ctx, Number(m[1]), Number(m[2]), m[3]),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/worktree\/merge$/,
    handler: (ctx, m) => apiBoardWorktreeMerge(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/viewed$/,
    handler: (ctx, m) => apiBoardMarkViewed(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/compact$/,
    handler: (ctx, m) => apiBoardSessionOp(ctx, Number(m[1]), Number(m[2]), 'compact'),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/fork-compact$/,
    handler: (ctx, m) => apiBoardSessionOp(ctx, Number(m[1]), Number(m[2]), 'fork-compact'),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/fork$/,
    handler: (ctx, m) => apiBoardSessionOp(ctx, Number(m[1]), Number(m[2]), 'fork'),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/interaction\/answer$/,
    handler: (ctx, m) => apiBoardAnswerInteraction(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/answer\/deliver$/,
    handler: (ctx, m) => apiBoardDeliverAnswer(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/sessions\/([\w-]+)\/profile$/,
    handler: (ctx, m) => apiBoardSessionProfile(ctx, Number(m[1]), m[2]),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/sessions\/([\w-]+)\/inject$/,
    handler: (ctx, m) => apiBoardSessionInject(ctx, Number(m[1]), m[2]),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/sessions\/([\w-]+)\/rewind$/,
    handler: (ctx, m) => apiBoardSessionRewind(ctx, Number(m[1]), m[2]),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/comments\/(\d+)\/send$/,
    handler: (ctx, m) => apiBoardSendComment(ctx, Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/comments$/,
    handler: (ctx, m) => apiBoardAddComment(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/board\/jira\/(test|import)$/,
    handler: (ctx, m) => apiBoardJira(ctx, Number(m[1]), m[2]),
  },
  // do_PATCH 链：改卡 → 看板设置
  {
    method: 'PATCH',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)$/,
    handler: (ctx, m) => apiBoardUpdateCard(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'PATCH',
    re: /^\/api\/projects\/(\d+)\/board\/settings$/,
    handler: (ctx, m) => apiBoardUpdateSettings(ctx, Number(m[1])),
  },
  // do_DELETE 链：彻底删卡 → worktree 清理 → 删卡（软删）→ 删评论
  {
    method: 'DELETE',
    re: /^\/api\/projects\/(\d+)\/board\/trash\/(\d+)$/,
    handler: (ctx, m) => apiBoardTrashPurge(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'DELETE',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/worktree$/,
    handler: (ctx, m) => apiBoardWorktreeCleanup(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'DELETE',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)$/,
    handler: (ctx, m) => apiBoardDeleteCard(ctx, Number(m[1]), Number(m[2])),
  },
  {
    method: 'DELETE',
    re: /^\/api\/projects\/(\d+)\/board\/cards\/(\d+)\/comments\/(\d+)$/,
    handler: (ctx, m) => apiBoardDeleteComment(ctx, Number(m[1]), Number(m[2]), Number(m[3])),
  },
];
