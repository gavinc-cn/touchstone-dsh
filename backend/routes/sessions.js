/**
 * 路由族：会话内容读（M3 读路径）—— 看板卡片会话与任务会话共用一套 payload 组装
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头）：
 *   - `GET /api/projects/<id>/board/session/messages`      → `_api_board_session_messages`
 *   - `GET /api/projects/<id>/board/session/media/<mid>`   → `_api_board_session_media`（字节）
 *   - `GET /api/tasks/<id>/session/messages`               → `_api_session_messages`
 *   - `GET /api/tasks/<id>/session/stream`                 → `_api_session_stream`（SSE）
 *   - `GET /api/tasks/<id>/session/media/<mid>`            → `_api_session_media`（字节）
 *
 * 两个 `/board/session/*` 条目在 Python 里属看板族（正则相邻），但实现共用
 * `_session_payload` / `sessparse.resolve_media`，故整族收在本文件。
 *
 * M4.5 追加同一族的**三条任务写端点**（Python 顺序：chat → chat/inject → chat/stop）：
 *   - `POST /api/tasks/<id>/session/chat`        → `_api_session_chat`(4930)
 *   - `POST /api/tasks/<id>/session/chat/inject` → `_api_session_chat_inject`(3781)
 *   - `POST /api/tasks/<id>/session/chat/stop`   → `_api_session_chat_stop`(4994)
 * 看板侧的两条写端点（`/board/session/chat`、`/board/session/inject`，共用 `_inject_msg`）
 * 属 M5。会话的写路径（rewind/profile/answer）同样留待后续里程碑。
 *
 * ## 逐点照抄清单（Python 基准 `server.py`，行号见上）
 * - **两套 `after` 语义不同，别顺手统一**：
 *   `/board/session/messages` 是 `int(after or 0)` + `bad after` 400（非法就给 400）；
 *   `/api/tasks/<id>/session/messages` 是 `int(after) if after.isdigit() else 0`
 *   （非法**静默回落 0**）；SSE 则是 `?after=` 非数字时回落 `Last-Event-ID`，再回落 0。
 * - **`found:false` 的 payload 没有 `total` 键**（三个提前返回分支）：SSE 的 total 回退比较
 *   必须按「无 total」安全处理（Python 原代码在此 `payload["total"]` 直接下标会 KeyError）。
 * - **sid 切换 / total 回退** ⇒ 增量基点归零、用 `after=0` 重取全量再发（同一 tick 内）。
 * - 三帧各自「变了才发」：`meta`（`sort_keys=True` + `ensure_ascii=False`）、`entries`
 *   （带 `id: after-1`）、`chat`（`sort_keys=True` + **`ensure_ascii=True`**——两条帧的
 *   转义口径不同，照抄）。空闲累计 20 拍（≈15s）发一次 `: hb`。
 * - `/board/session/*` 的 sid 归属走 `serverstate.boardOwnsSid`（跨项目读的隔离红线）。
 * - 媒体一律 `await sessparse.resolve_media(...)`（M2 评审 P1：Node 的 `dshdriver.media`
 *   是 async，漏 await 会「静默 404 + 未捕获拒绝崩进程」）。
 */
import { agentFamily } from '../lib/agents.js';
import * as board from '../lib/board.js';
import * as chat from '../lib/chat.js';
import * as dbmod from '../lib/db.js';
import * as dshdriver from '../lib/dshdriver.js';
import { DshDriverError } from '../lib/dshdriver.js';
import * as dshevents from '../lib/dshevents.js';
import { detailText } from '../lib/i18n.js';
import { jsonBody } from '../lib/http.js';
import { pyStrip } from '../lib/lib.js';
import { unquote } from '../lib/query.js';
import * as sessparse from '../lib/sessparse.js';
import {
  DSH_EFFORT_LEVELS, dshLiveSid, effectiveModel, familyCapabilities, normalizeEffort,
  permissionCatalogValues, sessFamily, sessionOwned, sessionPermissionMode,
} from '../lib/servercaps.js';
import {
  boardOwnsSid, boardSessionRunning, projectBusy, sessionQueueState,
  taskSince, unitState,
} from '../lib/serverstate.js';

/** 驱动忙拒绝（409）无第二参时的兜底文案（同 board.js:BUSY_FALLBACK，覆盖门禁按常量登记） */
const BUSY_FALLBACK = '会话运行中，稍后重试';

/** `time.sleep(0.75)` 的 Node 形态；`tickMs<=0` 立即返回（单测用） */
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Python `int(s)`（`s` 来自 parse_qs 的字符串）：空白/正负号/下划线可接受，其余抛错 */
function pyIntStrict(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('bad after');
    return Math.trunc(value);
  }
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(text)) throw new Error('bad after');
  return Number(text.replaceAll('_', ''));
}

/** Python `str.isdigit()`（平台参数只可能是 ASCII 数字；Unicode 数字见报告「未决」） */
function pyIsDigit(text) {
  return /^\d+$/.test(String(text ?? ''));
}

/** Python `json.dumps(..., sort_keys=True)` 的键序（递归；仅键序，不改值） */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * `json.dumps(..., ensure_ascii=True)` 的转义口径：非 ASCII 码点一律 `\uXXXX`
 * （非 BMP 出**两个**转义，与 Python 同）。输入必须是已按 Python 口径序列化的 JSON 文本
 * （`jsonBody`），非 ASCII 只会出现在字符串字面量里，故整段替换是安全的。
 */
function asciiEscape(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out += ch; continue; }
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += `\\u${(0xd800 + (v >> 10)).toString(16).padStart(4, '0')}`
        + `\\u${(0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0')}`;
    } else {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}

/**
 * `_session_context(task_id)`：session 接口公共上下文（任务行 / 项目行 / agent 归族）。
 *
 * 与 Python 的差异只在**响应时机**：Python 先 `self._owned_task`（内含 `_owned_project`，
 * 越权时已回一次 404）再由调用方回 `task not found`；Node 的 `ctx.ownedTask` 已经把
 * 「不存在 → 404 task not found / 不属于本人 → 404 project not found」收口为**一次**响应
 * （见 `./index.js` 文件头契约），故这里返回 null 时调用方**不再**回 404。
 *
 * @returns {Promise<{task: object|null, project: object|null, family: string|null}>}
 */
async function sessionContext(ctx, taskId) {
  const task = ctx.ownedTask(taskId);
  if (task === null) return { task: null, project: null, family: null };
  const project = dbmod.getProject(task.project_id, { db: ctx.db });
  const family = project ? agentFamily(project.agent_path) : 'dsh_plugin';
  return { task, project, family };
}

/** `_owned_task(task_id)` 的**无副作用**版（SSE 循环每拍重读任务行用，不回 404） */
function readTaskQuiet(ctx, taskId) {
  const task = dbmod.getTask(taskId, { db: ctx.db });
  if (task === null || task === undefined) return null;
  const project = dbmod.getProject(task.project_id, { db: ctx.db });
  if (project === null || project === undefined || project.user_id !== ctx.user.id) return null;
  return task;
}

/**
 * `_session_payload(task, project, family, agent, after)`：组装 session messages 主体。
 *
 * 任务行 `session_id` 为空（首轮 agent 未退出、`resume_hint` 尚未解析）时按工作区 +
 * 任务起始时间探测正在写的会话（仅展示，见 `sessparse.live_session_id`）；dsh_plugin
 * 另有精确通道 `dshLiveSid`（驱动池自持会话，不靠 mtime 猜）。
 *
 * 四个提前返回：family 不在 sessparse 白名单 / 无 sid / `load` 未 found —— 这几种
 * payload **没有 `total` 键**（SSE 侧据此安全处理，见文件头）。
 *
 * **async**：`dshLiveSid` 在 Node 是 async（Python 侧同步），调用方一律 await。
 */
export async function sessionPayload(ctx, task, project, family, agent, after) {
  let sid = task.session_id || '';
  // dsh_plugin 的会话即 dsh 宿主会话，sessparse 调用统一经 sessFamily 归一
  const sfamily = sessFamily(family);
  if (!sid && family === 'dsh_plugin') {
    sid = await dshLiveSid(project ? project.project_dir : '');
  }
  if (!sid) {
    sid = sessparse.live_session_id(sfamily, project ? project.project_dir : '', taskSince(task));
  }
  const base = {
    task_id: task.id,
    session_id: sid,
    family,
    model: effectiveModel(task.id, task.model, { db: ctx.db }),
    capabilities: familyCapabilities(family),
    project_busy: project ? projectBusy(project.id, { db: ctx.db }) : false,
    // M4：`chat.state` 接线 `_CHATS` 登记表后**整体 async**（`dshBusy` 是远端读，Node 无同步
    // HTTP）——`await` 一处不能漏，否则 Promise 会被静默序列化成 `{}`（M3 文件头边界①的记账）。
    chat: await chat.state(sid, { db: ctx.db }),
  };
  // 会话级实时态（2026-10-24 任务会话对齐卡片会话；仅在 dsh_plugin 且有 sid 时下发，
  // 值/口径与看板会话 meta 同源）：
  //   sessionEffort（2026-10-04）→ interaction（审批/提问，按需探测 TTL 5s）→
  //   permission（宿主 preset key，缺省不下发）→ sessionModel（缺省不下发）
  //   → queue（宿主 inbox 行，只展示）→ owned（外部会话三态）。
  let interaction = null;
  if (sid && family === 'dsh_plugin') {
    const st = dshevents.get(sid) || {};
    const effort = dshevents.sessionEffort(sid);
    if (effort) base.sessionEffort = effort;
    // 交互（提问/审批）实况：任务会话没有看板 watcher，按需探测并写 watcher 缓存
    // （与作答端点 `taskAnswerInteraction` 共用同一份缓存/白名单；形态同看板
    // `meta.interaction`：pending/kind/qid/approval_id/answerable/questions/options/text…）
    if (project !== null && project !== undefined) {
      interaction = board.interactionProbe(family, project, sid);
    }
    base.interaction = interaction;
    // 权限档：宿主 preset 实况（2026-10-21 起 preset 优先；可能 path-rules 等）
    const pmode = sessionPermissionMode(st);
    if (pmode) base.permission = pmode;
    // 会话级模型（会话窗「模型」展示）：事件流里学到的 provider/model
    const sel = st.model || {};
    if (sel.model) {
      base.sessionModel = sel.provider ? `${sel.provider}/${sel.model}` : sel.model;
    }
    // 宿主 inbox 排队行（P6 #21）：[{id,text}] 同形，只展示、不给「立即注入」
    base.queue = (st.inbox || []).map((msg) => ({
      id: String(msg.id || ''),
      text: String(msg.text || ''),
    }));
    // 会话归属三态（外部会话提示条/停止门控）：true 平台自持 / false 外部 / null 未知
    base.owned = sessionOwned(sid);
  }
  // 统一队列态（会话窗标题「队列」徽标）：本任务单元此刻排队/运行/空闲。
  // 探到正在写的会话（sid 未入库）时 task_id 仍是准确的队列键，照常下发。
  base.unit_state = unitState(project ? project.id : 0, `t:${task.id}`, { db: ctx.db });
  // 展示派生（P6/R2/R10）：任务会话无卡——answer_pending 不在场；server_queued 由宿主
  // inbox 行在场判定；interaction_pending = 交互挂起（2026-10-24 任务侧首次出现该枚举）；
  // 其余按 unit_state/外部条目行退化。
  base.queue_state = sessionQueueState(project ? project.id : 0, base.unit_state, {
    serverQueued: Boolean(base.queue && base.queue.length),
    interactionPending: Boolean((interaction || {}).pending),
  }, { db: ctx.db });
  if (!sessparse.FAMILIES.includes(sfamily)) {
    return { ...base, found: false, reason: 'family' };
  }
  if (!sid) {
    return { ...base, found: false, reason: 'no_session' };
  }
  const data = sessparse.load(sfamily, sid, agent, after);
  if (!data.found) {
    return {
      ...base,
      found: false,
      reason: data.reason === undefined ? 'missing' : data.reason,
      agents: data.agents === undefined ? [] : data.agents,
      agent: data.agent === undefined ? agent : data.agent,
    };
  }
  return { ...base, ...data };
}

/**
 * `_api_board_session_messages(project_id, parsed)`：看板卡片会话只读查看。
 *
 * 405 之外的错误分支（顺序与 Python 同）：项目不归本人 404 → `bad after` 400 →
 * `sid required` 400 → sid 不归属本项目卡片 404 `session not found`。
 */
export async function boardSessionMessages(ctx, projectId) {
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const sid = ctx.q('sid', '');
  let after;
  try {
    after = pyIntStrict(ctx.q('after', '0') || 0);
  } catch {
    ctx.error(400, 'bad after');
    return;
  }
  if (!sid) {
    ctx.error(400, 'sid required');
    return;
  }
  const options = { db: ctx.db };
  // sid 必须落在本项目全部卡片的会话并集内（防跨项目读任意会话）
  const owner = boardOwnsSid(row, sid, options);
  if (owner === null) {
    ctx.error(404, 'session not found');
    return;
  }
  const ownerCid = owner.id;
  const family = agentFamily(row.agent_path);
  const agent = ctx.q('agent', 'main') || 'main';
  const data = sessparse.load(sessFamily(family), sid, agent, after);
  if (data && typeof data === 'object') {
    data.session_id = sid;                       // 前端头部徽标展示用（load 结果不含 sid）
    const running = boardSessionRunning(ownerCid, row, sid, options);
    data.capabilities = familyCapabilities(family);
    data.running = running;
    // chat 态 = 卡片会话 busy（含外部直跑）+ 排队/失败消息（统一队列消息单元）
    const chatSt = await chat.state(sid, options);
    chatSt.running = running || Boolean(chatSt.running);
    data.chat = chatSt;
    data.project_busy = projectBusy(projectId, options);
    // 统一队列态（会话窗标题「队列」徽标）：本卡片单元此刻排队/运行/空闲
    data.unit_state = unitState(row.id, `c:${ownerCid}`, options);
    data.card_column = owner.column_key;
    data.card_worktree = String(dbmod.rowOpt(owner, 'worktree', '') || '').trim();
    data.answer_pending = board.isAnswerPending(ownerCid, options);
    // 待答交互（会话窗问答对话框的数据源）：读**调和器缓存** `board._IW_CACHE`
    // —— 由 `board.iwOnce` 每轮从 dsh 状态帧写；缓存为空/无等待时为 null。
    // 这里曾经误用 `serverstate.interactionOfSid`（M3 的「空实例」占位，恒 null），
    // 导致 Node 后端下会话窗永远不出现提问/审批卡片（用户报障：卡 980）。
    data.interaction = board.interactionOfSid(sid);
    data.owned = sessionOwned(sid);              // 三态：true 池内 / false 外部 / null 未知
    data.family = family;
    if (family === 'dsh_plugin') {
      const st = dshevents.get(sid);
      // 会话级模型：事件流里学到就用它，否则留空由前端回落「项目默认模型」
      const sel = (st || {}).model || {};
      if (sel.model) {
        data.sessionModel = sel.provider ? `${sel.provider}/${sel.model}` : sel.model;
      }
      // 会话级权限档（2026-10-21 契约 §5.5）：值是**宿主 preset key**（preset 优先原样回读，
      // 旧插件旧帧的 mode 才走展示兜底映射）；取不到不下发，前端置灰不猜。
      const pmode = sessionPermissionMode(st);
      if (pmode) data.permission = pmode;
      const effort = dshevents.sessionEffort(sid);
      if (effort) data.sessionEffort = effort;
      // 宿主 inbox 排队行：只展示、不提供「立即注入」（dsh 行没有平台 msg_id）
      data.queue = ((st || {}).inbox || []).map((msg) => ({
        id: String(msg.id || ''),
        text: String(msg.text || ''),
      }));
    }
    data.queue_state = sessionQueueState(projectId, data.unit_state, {
      running,
      answerPending: Boolean(data.answer_pending),
      serverQueued: Boolean(data.queue && data.queue.length),
      starting: board.cardStarting(ownerCid, options),
      interactionPending: owner.block_kind === 'interaction',
    }, options);
  }
  ctx.json(200, data);
}

/**
 * `_api_board_session_media(project_id, media_id, parsed)`：看板卡片会话图片字节
 * （board 会话窗无 taskId，图片经「项目 + sid」寻址；归属口径同上）。
 */
export async function boardSessionMedia(ctx, projectId, mediaId) {
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const sid = ctx.q('sid', '');
  if (!sid) {
    ctx.error(400, 'sid required');
    return;
  }
  if (boardOwnsSid(row, sid, { db: ctx.db }) === null) {
    ctx.error(404, 'session not found');
    return;
  }
  const agent = ctx.q('agent', 'main') || 'main';
  const resolved = await sessparse.resolve_media(
    sessFamily(agentFamily(row.agent_path)), sid, agent, unquote(mediaId));
  if (resolved === null) {
    ctx.error(404, 'media not found');
    return;
  }
  ctx.text(200, resolved[0], resolved[1]);
}

/**
 * `_api_session_messages(task_id, parsed)`：session 原始对话内容（一次性拉取；
 * `?agent=&after=` 增量）。
 *
 * 注意 `after` 语义：**非数字静默回落 0**（与 `/board/session/messages` 的 400 不同）。
 */
export async function taskSessionMessages(ctx, taskId) {
  const { task, project, family } = await sessionContext(ctx, taskId);
  if (task === null) return;
  const agent = ctx.q('agent', 'main');
  const afterS = ctx.q('after', '0');
  const after = pyIsDigit(afterS) ? Number(afterS) : 0;
  const payload = await sessionPayload(ctx, task, project, family, agent, after);
  ctx.json(200, payload);
}

/**
 * SSE **首拍游标**解析（`_api_session_stream` 开头的 after 计算）：
 * `?after=<数字>` 优先；否则 `Last-Event-ID + 1`；都不是则 0。
 *
 * ⚠️ 注意 Python 的一个**反直觉但真实**的行为：循环里 `cur_sid` 初值是 `""`，
 * 而首拍 `sid_now` 非空 ⇒ 首拍必定走「sid 切换」分支把 `after` 归一化为 0 并重取全量。
 * 也就是说 `?after=` / `Last-Event-ID` 只影响首拍那次**被丢弃**的请求，帧序列里
 * **看不到**增量（客户端凭 `id:`/`meta.total` 自行去重——Python 注释原文「已乐观截断的
 * 客户端按 seq 过滤不会重复追加」）。本函数照抄该口径，别「顺手修好」而破坏对拍。
 */
export function streamStartAfter(ctx) {
  const afterS = ctx.q('after', '');
  if (pyIsDigit(afterS)) return Number(afterS);
  // EventSource 自动重连时带 Last-Event-ID（上次末条 seq），从其后继续
  const lid = String((ctx.req && ctx.req.headers && ctx.req.headers['last-event-id']) || '');
  return pyIsDigit(lid) ? Number(lid) + 1 : 0;
}

/**
 * `_api_session_stream(task_id, parsed)`：session SSE。
 *
 * 帧与续传逐点照抄（见文件头），循环体本身见 `runSessionStream`（可注入 tick/停止条件，
 * 便于单测；缺省 750ms 一拍）。
 */
export async function taskSessionStream(ctx, taskId, loopOpts = {}) {
  const { task, project, family } = await sessionContext(ctx, taskId);
  if (task === null) return;
  const agent = ctx.q('agent', 'main');
  const after = streamStartAfter(ctx);
  // 会话流**不带** X-Accel-Buffering（只有看板两条流带，见 lib/http.js）。
  // 头部在 after 解析之后再写，与 Python 的先后一致（404 分支已在上面的 context 里返回）。
  const sse = ctx.sse({});
  await runSessionStream(ctx, taskId, { sse, agent, after, task, project, family, ...loopOpts });
}

/**
 * SSE 主循环（`_api_session_stream` 的循环体）。
 *
 * 每拍：重读任务行（轮后写入的 `session_id` 对已打开窗口立即生效）→ 组装 payload →
 * sid 切换或 total 回退时归零重发 → meta/entries/chat 三帧各自「变了才发」→ 空闲 20 拍心跳。
 *
 * @param {object} ctx 请求上下文（需要 `db`/`user`/`req`/`res`）
 * @param {number} taskId
 * @param {{sse:object, agent:string, after:number, task:object, project:object|null,
 *          family:string, tickMs?:number, maxIdleTicks?:number, maxTicks?:number,
 *          shouldStop?:() => boolean, sessionPayload?:Function}} opts
 *       单测用 `maxTicks`/`tickMs` 驱动固定拍数；`sessionPayload` 是**注入缝**——用于
 *       构造「total 回退」「sid 切换」这类真文件里难以稳定复现的时序。
 */
export async function runSessionStream(ctx, taskId, opts) {
  const { sse, agent, project, family } = opts;
  const tickMs = opts.tickMs === undefined ? 750 : opts.tickMs;
  const maxIdleTicks = opts.maxIdleTicks === undefined ? 20 : opts.maxIdleTicks;
  const maxTicks = opts.maxTicks === undefined ? Number.POSITIVE_INFINITY : opts.maxTicks;
  let task = opts.task;
  let after = opts.after || 0;
  let curSid = '';
  let lastMeta = null;
  let lastChat = null;
  let idleTicks = 0;
  let closed = false;
  if (ctx.req && typeof ctx.req.on === 'function') ctx.req.on('close', () => { closed = true; });
  if (ctx.res && typeof ctx.res.on === 'function') ctx.res.on('close', () => { closed = true; });

  const getPayload = typeof opts.sessionPayload === 'function' ? opts.sessionPayload : sessionPayload;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (closed) break;
    if (typeof opts.shouldStop === 'function' && opts.shouldStop()) break;
    // 重读任务行：轮次结束把 session_id 写库后，本连接立刻感知
    const fresh = readTaskQuiet(ctx, taskId);
    if (fresh !== null) task = fresh;
    let payload = await getPayload(ctx, task, project, family, agent, after);
    let entries = Array.isArray(payload.entries) ? payload.entries : [];
    const sidNow = payload.session_id || '';
    // found=false 路径 payload **没有 total 键** ⇒ 不参与回退比较（Python 曾在此 KeyError）
    const totalNow = payload.total;
    if (sidNow !== curSid) {
      // 会话对象切换（探测 sid 出现/被真实 sid 纠正）：增量基点归零、重取全量
      curSid = sidNow;
      after = 0;
      payload = await getPayload(ctx, task, project, family, agent, 0);
      entries = Array.isArray(payload.entries) ? payload.entries : [];
    } else if (totalNow !== undefined && totalNow !== null && totalNow < after) {
      // 会话被回退/截断（entries 变短）：增量基点归零重发全量，否则游标卡在旧长度
      after = 0;
      payload = await getPayload(ctx, task, project, family, agent, 0);
      entries = Array.isArray(payload.entries) ? payload.entries : [];
    }
    if (entries.length) after = payload.total;

    // meta：entries/chat 之外的展示信息（found/agents/totals/model/session_id 等）
    const meta = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key !== 'entries' && key !== 'chat') meta[key] = value;
    }
    const metaS = jsonBody(sortKeysDeep(meta));          // Python: ensure_ascii=False, sort_keys=True
    let pushed = false;
    if (metaS !== lastMeta) {
      lastMeta = metaS;
      if (!sse.raw(`event: meta\ndata: ${metaS}\n\n`)) break;
      pushed = true;
    }
    if (entries.length) {
      const body = jsonBody({ entries, total: payload.total });   // Python: ensure_ascii=False
      if (!sse.raw(`id: ${after - 1}\nevent: entries\ndata: ${body}\n\n`)) break;
      pushed = true;
    }
    // chat：Python 这一帧**不带** ensure_ascii=False ⇒ 非 ASCII 走 \uXXXX 转义
    const chatS = asciiEscape(jsonBody(sortKeysDeep(payload.chat || {})));
    if (chatS !== lastChat) {
      lastChat = chatS;
      if (!sse.raw(`event: chat\ndata: ${chatS}\n\n`)) break;
      pushed = true;
    }
    idleTicks = pushed ? 0 : idleTicks + 1;
    if (idleTicks >= maxIdleTicks) {                     // ~15s 一次心跳，防中间层断连
      idleTicks = 0;
      if (!sse.raw(': hb\n\n')) break;
    }
    await sleep(tickMs);
  }
  sse.end();
}

/** `_api_session_media(task_id, media_id, parsed)`：session 图片字节（驱动 /media 取字节） */
export async function taskSessionMedia(ctx, taskId, mediaId) {
  const { task, family } = await sessionContext(ctx, taskId);
  if (task === null) return;
  const agent = ctx.q('agent', 'main');
  const resolved = await sessparse.resolve_media(
    sessFamily(family), task.session_id || '', agent, unquote(mediaId));
  if (resolved === null) {
    ctx.error(404, 'media not found');
    return;
  }
  ctx.text(200, resolved[0], resolved[1]);
}

// --------------------------------------------------------------------------
// M4.5 会话写路径：chat / chat/inject / chat/stop（`sessions.js` 的写侧）
//
// 三条端点的读体时机、分支顺序与错误体形态**逐处照抄 `server.py`**（行号见文件头）；
// 三个易被「顺手优化」掉的坑，改前必读：
//   ① `_api_session_chat` 的 except 顺序是 DshDriverError → OSError → **裸 RuntimeError**。
//      最后一档就是投递前置闸 `chat.DeliveryRefused` 的落点——它必须排在 DshDriverError
//      **之后**（Python 里两者同为 RuntimeError 子类，顺序反了 409/500 会被 400 抢走）；
//      Node 侧两者不同类（判据一律 `instanceof`），顺序仍照抄，免得两版读起来不一样。
//   ② 校验顺序：message 空 → message 超长 → 族白名单 → sid 空（四道闸的先后即文案优先级）。
//   ③ `_inject_msg` 的归属三重判定（msg_id 不存在 / sid 不符 / project_id 不符 /
//      任务路径还要 task_id 相符）都回同一个 404 文案——**不区分**是为了不泄露
//      「这条消息存在但不属于你」。
//   ④ 写口传 `{db: ctx.db}`（与读口一致）：代价是 `withWriteDb({db})` **不开事务**，
//      多语句写口（`waitq.msg_enqueue` 的消息行+等待项行）在崩溃窗口可能半提交，而 Python
//      是「一个事务内」写两行（waitq.py:1181/1195-1209）。终态在正常路径下相同。
//      **为什么不改成不传**：① `{db}` 是本库「加入调用方事务」的惯用法（`cancelAllActive`
//      等循环依赖它，改成无条件 BEGIN 会撞嵌套）；② 不传时写口会按 `defaultDbPath()` 自开
//      连接 —— 单测夹具靠 `{db}` 钉临时库，不传就会写**生产库**（M4.5 实测踩中，见实施记录 §3.7）。
//      正解是给 withWriteDb 加独立选项 `{db, tx: true}` 并逐点判定，属 M5/M6 重构项。
// --------------------------------------------------------------------------

/**
 * Python `bool(x)`：空串/0/None/False/**空容器**为假。
 *
 * 为什么不能直接用 `Boolean`：JS 的 `[]`/`{}` 是 truthy，而 Python 的 `bool([])`/`bool({})`
 * 是 False——本文件两处判据（`body.get("inject")`、`str(x or "")`）都吃这个口径。
 */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Python `str(x or "")`（`_api_session_chat` 的 message 与 `_inject_msg` 的 msg_id 共用）。
 *
 * 假值先折成空串再转文本；容器走 JSON 文本兜底——Python 的 `str(dict)` 是 repr 形态，
 * 这里不逐字复刻（与 `sessparse` 的私有 `pyStr` 同一条已知差异：真请求里这两个字段
 * 都是字符串）。
 */
function pyStrOrEmpty(value) {
  if (!pyTruthy(value)) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return JSON.stringify(value);
}

/**
 * Python `len(str)`：**按码点**计数。
 *
 * JS 的 `.length` 是 UTF-16 码元（emoji 等代理对算 2）——直接用它会让含 emoji 的长消息
 * 在 `len(message) > MESSAGE_MAX` 这条判据上提前 400，而 Python 侧放行。
 */
function pyLen(text) {
  return [...text].length;
}


/**
 * 是不是 Python `OSError` 那一档（`_api_session_chat` 的第二个 except ⇒ 500）。
 *
 * Node 没有 OSError 类：文件/管道层失败一律带 `code`（ENOENT/EACCES/EPIPE…）+ `syscall`
 * （open/write/kill）。判据取 **`syscall` 在场**——比裸 `code` 窄（`DshDriverError.code`
 * 是数字、业务错误不带 syscall），把 Node 的 fs 失败映射到 Python 的 `except OSError`。
 * 可达面：无 runner 单例时 `sendNow → dshSendNow` 的 `fs.appendFileSync` 写日志失败。
 */
function isOsError(err) {
  return err instanceof Error && typeof err.syscall === 'string' && err.syscall !== '';
}

/**
 * `_api_session_chat(task_id, body)`：向 session 续发一条消息（登记统一队列消息单元，
 * 由 runner 按项目串行执行）。
 *
 * 项目忙（同项目有任务/卡片会话在跑）时**不再 409 拒绝**，改为排队：消息作为统一队列
 * 第三类单元（`m:<msg_id>`），项目空闲才真正发送；响应 `queued=true` 表示本次未立即执行
 * （前端据此显示「排队中」）。
 *
 * **读体**：Python 在 `do_POST:1048` 统一读体（三条写端点同一时机），故第一行就 `readBody`。
 * 校验与异常顺序见本段文件头 ①②。
 *
 * `bodyOverride`（M6-6 新增，缺省 null）：`_api_load_diagnose`(4616) 在 Python 里调的是
 * `self._api_session_chat(task_id, {"message": text})` —— 传的是**合成 body**，不是请求体。
 * 只有这一处调用点需要它，故做成可选形参而不是第二份实现（免得两处校验逻辑漂移）。
 */
export async function taskSessionChat(ctx, taskId, bodyOverride = null) {
  const body = bodyOverride === null ? await ctx.readBody() : bodyOverride;
  // 无响应副作用（= Python `_session_context`）：三空时由本函数回 404 `task not found`
  const { task, project, family } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');
    return;
  }
  // Python `str(body.get("message") or "").strip()`（假值先折空串，再按 Python 空白集剥两端）
  const message = pyStrip(pyStrOrEmpty(body.message));
  if (!message) {
    ctx.error(400, 'message 不能为空');                  // 硬编码字节串 ⇒ 紧凑
    return;
  }
  if (pyLen(message) > chat.MESSAGE_MAX) {
    ctx.error(400, 'message 过长');                      // 紧凑
    return;
  }
  if (!chat.CHAT_FAMILIES.includes(family)) {
    ctx.error(409, '该 agent 暂不支持对话');              // 紧凑
    return;
  }
  const sid = task.session_id || '';
  if (!sid) {
    ctx.error(409, '会话尚未生成（首轮执行后才有）');      // 紧凑
    return;
  }
  let rec;
  try {
    rec = await chat.start(task, project, message, pyTruthy(body.inject), { db: ctx.db });
  } catch (err) {
    // ① DshDriverError：409 = 会话运行中（chat 侧的忙拒绝，竞态兜底）；其余按 500。
    //    **必须排在最前**——见本段文件头①。
    if (err instanceof DshDriverError) {
      if (err.code === 409) {
        // Python `e.args[1] if len(e.args) > 1 else "会话运行中，稍后重试"`：Node 的
        // `new Error()` 把 message 定为 `''`，「只传 code」与「传了空消息」无法区分；
        // dshdriver 的构造点都带非空消息 ⇒ 空串按「无第二参」回兜底文案。
        ctx.errorSpaced(409, err.message ? String(err.message) : BUSY_FALLBACK);
      } else {
        ctx.errorSpaced(500, 'agent 调用失败: {detail}',
          { detail: detailText(err, ctx.lang) });
      }
      return;
    }
    // ② OSError（Node 的系统错误）⇒ 500，同一文案
    if (isOsError(err)) {
      ctx.errorSpaced(500, 'agent 调用失败: {detail}',
        { detail: detailText(err, ctx.lang) });
      return;
    }
    // ③ 裸 RuntimeError = 投递前置闸 `chat.DeliveryRefused`（外部会话前提不成立）：
    //    消息未入队、未落行 ⇒ 400 + 闸的中文文案，让前端能如实 toast。
    if (err instanceof chat.DeliveryRefused) {
      // lib 错误对象直接透传：ctx.error* 按 .i18nKey/.i18nVars 或 .message 本地化
      ctx.errorSpaced(400, err);
      return;
    }
    // 其余（Python 里不是 RuntimeError/OSError 的异常）逃出 do_POST ⇒ 只断这条连接；
    // Node 侧同理：上抛给 dispatchSafely（它 destroy 这条连接、不补 500）。
    throw err;
  }
  // 成功体是 `json.dumps(..., ensure_ascii=False)`：带空格、键序即下文字面序
  ctx.json(200, {
    ok: true,
    queued: Boolean(rec.queued),
    msg_id: rec.id || '',
    state: rec.state || '',
    // `chat.submit` 的返回记录本就不含 prompt_id（Python 同）⇒ 恒空串，照抄这一键
    prompt_id: rec.prompt_id || '',
  });
}

/**
 * `_api_session_chat_inject(task_id, body)`：把**任务会话**排队中的平台消息立即注入
 * （不等统一队列；dsh_plugin 族）。
 */
export async function taskSessionChatInject(ctx, taskId) {
  const body = await ctx.readBody();
  const { task, project } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');                    // 紧凑
    return;
  }
  const sid = task.session_id || '';
  if (!sid) {
    ctx.error(409, '会话尚未生成（首轮执行后才有）');      // 紧凑
    return;
  }
  await injectMsg(ctx, project, sid, body, taskId);
}

/**
 * `_inject_msg(project, sid, body, task_id=None)`：平台排队消息「立即注入」的共用实现
 * （看板/任务两路；归属与族校验）。
 *
 * 本端点处理**平台统一队列**里的消息单元（项目忙时排队的消息）——撤销排队并立即投递到
 * 会话（有运行中的轮次则注入当前轮，空闲则立即起轮），不再等项目空闲。投递失败消息退回
 * 队列（见 `chat.injectNow`），响应 502 供前端 toast。
 *
 * 看板侧的 `_api_board_session_inject`（3770）走同一实现，M5 接线时把 project 行换成
 * 卡片所属项目行、`taskId` 留 null 即可（归属三重判定里的 task 一项随之跳过）
 * ——M5-4 已按此接线（`routes/board.js:apiBoardSessionInject` 直接 `await injectMsg(...)`）。
 *
 * @param {object} ctx 请求上下文
 * @param {object} project 项目行（消费 `agent_path`/`id`）
 * @param {string} sid 会话 id（调用方已保证非空）
 * @param {object} body 请求体（消费 `msg_id`）
 * @param {number|null} [taskId] 任务路径传入：`msg_id` 的 task_id 必须相符
 */
export async function injectMsg(ctx, project, sid, body, taskId = null) {
  // Python `runner.agent_family`（runner.py:45 是 re-export）——单族世界：只有 dsh_plugin 可注入
  const fam = agentFamily(project.agent_path);
  if (fam !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持立即注入');
    return;
  }
  const info = chat.msgInfo(pyStrOrEmpty(body.msg_id), { db: ctx.db });
  // 归属三重判定（+任务第四重）：不命中就同一个 404 文案，别细分（见本段文件头③）
  if (info === null || info.sid !== sid || info.project_id !== project.id
      || (taskId !== null && info.task_id !== taskId)) {
    ctx.errorSpaced(404, '消息不存在或不在该会话下');
    return;
  }
  try {
    await chat.injectNow(info.id, { db: ctx.db });
  } catch (err) {
    // 被拒（已被 worker 拾起/不可注入）：消息仍在队列，不改状态 ⇒ 400
    if (err instanceof chat.InjectRefused) {
      ctx.errorSpaced(400, err);              // lib 错误对象透传（固定文案 = 词条 key）
      return;
    }
    // 投递失败：消息已按原位次退回排队（chat.injectNow 内），此处只报错 ⇒ 502
    ctx.errorSpaced(502, '注入失败：{detail}', { detail: detailText(err, ctx.lang) });
    return;
  }
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');   // 硬编码字节串 ⇒ 紧凑
}

/**
 * `_api_session_chat_stop(task_id)`：停止进行中的对话进程（同时取消该会话排队中的消息）。
 *
 * Python 的方法签名**不吃 body**（`do_POST` 分派成 `_api_session_chat_stop(int(...))`），
 * 读体仍发生在 `do_POST:1048` 那一次；这里照同一时机把体读掉——不读的话，keep-alive
 * 连接上的下一个请求会撞上未消费的正文（Python 侧必然已读）。
 *
 * `chat.stop` 自 M4 起是 **async**（要 await 驱动的 /cancel）：漏 await 会让「停止」在
 * 响应之后才生效——`cancelQueued` 的落库态与驱动的中断调用都会晚一拍。
 *
 * **2026-10-17 加 `mode`**（设计《双通道继续与停止同效》§4.2(d)、本批只落平台侧）：
 * body `{"mode":"cancel_queue"}` ⇒ 只取消排队消息、**不碰轮次**（走 `cancelQueueAction`，
 * 响应回带被取消消息的全文供前端放回输入框）；缺省/其它值 ⇒ 原样「停止」（旧前端不带体
 * 照常走这条，行为与响应体一字不变）。为什么必须拆开：没有在跑的轮次时会话窗那个
 * 「取消排队」按钮走停止链路必被驱动 404 判成 stopped=false，用户看到的是
 * 「该会话未在运行或无法停止」而排队消息其实已被取消——动作与结果对不上。
 */
export async function taskSessionChatStop(ctx, taskId) {
  const body = await ctx.readBody();                     // 见上：时机照 Python；本批起要消费 mode
  const { task } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');                    // 紧凑
    return;
  }
  const sid = task.session_id || '';
  if (pyStrOrEmpty(body.mode) === STOP_MODE_CANCEL_QUEUE) {
    cancelQueueAction(ctx, body, { sid, taskId });
    return;
  }
  await chat.stop(sid, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');   // 紧凑（Python 是字节串）
}

/** 端点 body 的 `mode` 取值：只有这一个是「取消排队」，其余（含缺省/旧前端不带体）都是「停止」 */
export const STOP_MODE_CANCEL_QUEUE = 'cancel_queue';

/**
 * `mode=cancel_queue` 的共用实现（任务/看板两路）：**只取消平台排队消息，不碰轮次**。
 *
 * 这是会话窗「取消排队」按钮的服务端落点，与「停止」是两件事（用户 2026-10-16 裁定 U4：
 * 停止只打断当前轮；取消排队是另一个显式动作）。**纯平台侧**：删的是 `chat_msgs` 排队行
 * 与 `m:` 等待项行，不经过驱动 ⇒ 池外会话（dsh GUI 直跑/看管未接回）同样有效——这正是
 * 原实现（借用 stop 链路，被驱动 404 判失败）修不好的那一档。
 *
 * 响应回带被取消消息的 `{id,text}`（**全文**，见 `chat.cancelQueuedDetail`）：前端要把
 * 原文放回输入框，而下发给前端的排队行文本被截到 120 字。`cancelled=0` 不是错误
 * （消息可能已被 worker 抢走执行，或已被别的路径取消）——前端据此提示「已不在排队中」。
 *
 * `body.msg_id` 非空 ⇒ 只取消该条（排队行的行内「取消」按钮）；归属判定照 `injectMsg`
 * 的双/三重口径，不命中同一个 404 文案（不细分，避免暴露他人消息是否存在）。
 *
 * @param {object} ctx 请求上下文
 * @param {object} body 请求体（消费 `mode`/`msg_id`）
 * @param {{sid?: string, cardId?: number|null, taskId?: number|null, projectId?: number|null}} [scope]
 */
export function cancelQueueAction(ctx, body, scope = {}) {
  const { sid = '', cardId = null, taskId = null, projectId = null } = scope;
  const msgId = pyStrOrEmpty(body.msg_id);
  if (msgId) {
    const info = chat.msgInfo(msgId, { db: ctx.db });
    // Python `sid and info.get("sid") != sid`：只有调用方给了 sid 才比 sid（看板按卡过滤）
    if (info === null || (sid && info.sid !== sid)
        || (projectId !== null && info.project_id !== projectId)
        || (cardId !== null && info.card_id !== cardId)
        || (taskId !== null && info.task_id !== taskId)) {
      ctx.errorSpaced(404, '消息不存在或不在该会话下');
      return;
    }
  }
  const out = chat.cancelQueuedDetail(
    { sid: sid || null, cardId, msgId: msgId || null }, { db: ctx.db });
  ctx.json(200, { ok: true, cancelled: out.cancelled, msgs: out.msgs });
}

// ==========================================================================
// 任务会话四条（M6-6；2026-10-24 任务会话对齐卡片会话扩 profile + 新增 compact）
//   POST /api/tasks/<id>/session/profile              → `_api_task_session_profile`
//   POST /api/tasks/<id>/session/compact              → `_api_task_session_compact`（新）
//   POST /api/tasks/<id>/session/rewind               → `_api_session_rewind`(3849)
//   POST /api/tasks/<id>/session/interaction/answer   → `_api_task_answer_interaction`(3919)
//
// 与看板同族端点的**关键差异**（逐条照 oracle，别顺手复用看板实现）：
//   ① `profile` 2026-10-24 起与看板同能力：`{model?, permission_mode?, reasoning_effort?}`
//      即时下发（权限先于模型，与 applySessionDefaults 同序）+ 回写 tasks 行（permission/
//      model；effort 属会话级不落库）；回执**恒含三键**（与看板 profile 字节同形）。
//      校验顺序：404 → 参数 400 → 族 400 → 无会话 409 → 驱动 502。
//   ② `compact`：busy 判据＝任务轮正在跑（`task.status=='running'`，含等作答挂起期间）；
//      成功体 `{ok:true, started:true}`；族不支持复用看板 compact 的退场族文案。
//   ③ `rewind` 走同一条 `_rewind_session_dsh`，但**任务侧多两步**：`db.update_task(session_id=new_sid)`
//      （任务只有一个会话位，否则后续轮次仍打在旧会话上）与响应里的 `rebound: true`
//      （看板路径恒 false，见 `routes/board.js` 的同名实现）。
//   ④ `answer` 任务侧**直送**：成功体是硬编码 `b'{"ok":true,"queued":false}'`（紧凑，
//      且 queued 恒 false），**不是**看板那条按 `board.is_answer_pending` 现读派生的形态。
// ==========================================================================

/** Python `dict.get(key, dflt)`：键存在但值为 null 时**不**回落 dflt（与 Python 同） */
function pyGet(obj, key, dflt = null) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return dflt;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

/** Python `key in dict`（body 非 dict 时按 False；与 Python `in` 对 dict 的判据同） */
function pyHas(obj, key) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj)
    && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Python `str(x)` 的**标量面**（容器 repr 是已登记偏差，见 board.js 同名私有助手） */
function pyStrScalar(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/**
 * `_api_task_session_profile`（`server.py`）：任务会话级配置（2026-10-24 起与看板对齐）。
 *
 * body `{model?, permission_mode?, reasoning_effort?}`：
 *   - `permission_mode`：manual/yolo 旧别名先归一 → 必须在宿主权限目录（目录不可用时内置
 *     兜底集合）里 → `setPermission(sid, preset)` 即时生效 → `updateTask(permission=preset)`
 *     回写任务默认（下一轮权限链取 tasks.permission）→ 回执 canonical preset；
 *   - `model`：`setModel` 即时 → `updateTask(model=…)` 回写（下一轮 resume 沿用）→ 回执原值；
 *   - `reasoning_effort`：与 model 一次下传，空串=不改，**不落库**（会话级）。
 * 校验顺序（计划 §3.4）：404 → 参数非法 400（effort 非法/三者皆空/权限档非法）→ 族 400 →
 * 无会话 409 → 驱动 502。回执恒含三键（与看板 profile 字节同形）。
 */
export async function taskSessionProfile(ctx, taskId) {
  const body = await ctx.readBody();
  const { task, family } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');                    // 紧凑
    return;
  }
  // 与 Python `str(body.get(x) or "").strip()` 同口径（假值折空、标量转文本、两端 strip）
  const orStrip = (key) => (pyTruthy(pyGet(body, key)) ? pyStrScalar(pyGet(body, key)) : '').trim();
  const model = orStrip('model');
  // 权限档：旧三档别名先归一（manual→workspace-write、yolo→danger-full-access；auto 不在此列，
  // 只有宿主目录里确实有 auto 档才接受，与看板 profile 同口径）
  const pmodeRaw = orStrip('permission_mode');
  const pmode = Object.prototype.hasOwnProperty.call(dshdriver.LEGACY_PERMISSION_ALIASES, pmodeRaw)
    ? dshdriver.LEGACY_PERMISSION_ALIASES[pmodeRaw] : pmodeRaw;
  const effort = pyHas(body, 'reasoning_effort')
    ? normalizeEffort(pyGet(body, 'reasoning_effort')) : '';
  // —— 参数非法（400）——
  if (effort === null) {
    ctx.errorSpaced(400, '思考等级非法（{levels} 或留空）',
      { levels: DSH_EFFORT_LEVELS.join('/') });
    return;
  }
  if (!model && !pmode && !effort) {
    ctx.error(400, 'model/permission_mode/reasoning_effort required');   // 紧凑，同看板
    return;
  }
  if (pmode && !permissionCatalogValues().has(pmode)) {
    ctx.errorSpaced(400, '权限档非法（宿主权限目录里没有该档位）');
    return;
  }
  // —— 族（400）——
  if (family !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持会话级配置');
    return;
  }
  // —— 无会话（409）——
  const sid = task.session_id || '';
  if (!sid) {
    ctx.error(409, '会话尚未生成（首轮执行后才有）');      // 紧凑
    return;
  }
  // —— 即时下发给宿主（失败 502；成功后才回写任务行）——
  try {
    if (pmode) await dshdriver.setPermission(sid, pmode);
    if (model || effort) {
      // model 传原样（可带 provider/ 前缀，插件负责拆）；只改思考等级时 model 传空串让插件
      // 从会话当前模型回读（与看板 profile 一致）
      await dshdriver.setModel(sid, model, '', effort);
    }
  } catch (e) {
    if (e instanceof DshDriverError) {
      ctx.errorSpaced(502, e);                // 驱动错误可能带 i18nKey（如 HTTP 状态）
      return;
    }
    throw e;
  }
  // 写回任务级默认（下一轮起会话/续轮沿用；effort 属会话级、不落任务行）
  if (pmode) dbmod.updateTask(task.id, { permission: pmode }, { db: ctx.db });
  if (model) dbmod.updateTask(task.id, { model }, { db: ctx.db });
  ctx.json(200, { ok: true, model, permission_mode: pmode, reasoning_effort: effort || '' });
}

/**
 * `_api_task_session_compact`（`server.py`）：任务会话 compact（压缩上下文，2026-10-24）。
 *
 * 口径同看板 compact：走驱动 `/compact`（插件侧触发即返回；压缩在 dsh 进程内异步进行）。
 * 顺序：404 task not found → 族不支持 400（复用看板 compact 的退场族文案，与
 * `agents.RETIRED_MSG` 逐字一致；此处写中文原文以满足 i18n 静态词条扫描）→
 * 无会话 409 → busy 409（判据=任务轮正在跑 `task.status=='running'`，含等作答挂起期间）→
 * 驱动异常 400（`compact 失败: <detail>`，复用看板 compact 的 i18n key）。
 * 成功 `{ok:true, started:true}`（`json.dumps` 带空格形态，ctx.json）。body 不消费。
 */
export async function taskSessionCompact(ctx, taskId) {
  const { task, family } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');                    // 紧凑
    return;
  }
  if (family !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该智能体族已下线，请在项目设置里改绑 dsh 插件');
    return;
  }
  const sid = task.session_id || '';
  if (!sid) {
    ctx.error(409, '会话尚未生成（首轮执行后才有）');      // 紧凑
    return;
  }
  if (task.status === 'running') {
    ctx.errorSpaced(409, '会话运行中，稍后再试');
    return;
  }
  try {
    await dshdriver.compact(sid);
  } catch (e) {
    if (e instanceof DshDriverError) {
      ctx.errorSpaced(400, 'compact 失败: {detail}', { detail: detailText(e, ctx.lang) });
      return;
    }
    throw e;
  }
  ctx.json(200, { ok: true, started: true });
}

/**
 * `_api_session_rewind`(3849)：把任务会话回退到某条用户提问之前（＝按边界 fork 新会话）。
 *
 * 与看板路径共用 `_rewind_session`（族检查 → `_rewind_session_dsh`），差别只有
 * `task is not None` 触发的 `update_task` 与 `rebound`。**顺序照 oracle**：
 * fork → ensure_session → update_task（前两步失败即 502，不落库）。
 */
export async function taskSessionRewind(ctx, taskId) {
  const body = await ctx.readBody();
  const { task, project, family } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');                    // 紧凑
    return;
  }
  const sid = task.session_id || '';
  if (!sid) {
    ctx.error(409, '会话尚未生成（首轮执行后才有）');      // 紧凑
    return;
  }
  const fam = agentFamily(project.agent_path);
  if (fam !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持会话回退');
    return;
  }
  const mid = String(pyTruthy(pyGet(body, 'mid')) ? pyGet(body, 'mid') : '');
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
    await dshdriver.ensureSession(newSid, project.project_dir, `rewind-${sid.slice(0, 8)}`);
    // 任务侧：任务只有一个会话位 —— 回退后必须把新会话设为任务会话（看板路径无此步）
    dbmod.updateTask(task.id, { session_id: newSid }, { db: ctx.db });
  } catch (e) {
    if (e instanceof DshDriverError) {
      ctx.errorSpaced(502, '回退失败：{detail}', { detail: detailText(e, ctx.lang) });
      return;
    }
    throw e;
  }
  ctx.json(200, { ok: true, new_session_id: newSid, boundary, rebound: true });
}

/**
 * `_api_task_answer_interaction`(3919)：作答任务会话的待答交互（提问 / 审批两路）。
 *
 * 任务会话没有看板 watcher ⇒ 先 `board.interaction_probe` 探测刷新缓存再作答；
 * 成功即 `{"ok":true,"queued":false}`（**硬编码紧凑**，任务侧直送，不看 is_answer_pending）。
 */
export async function taskAnswerInteraction(ctx, taskId) {
  const body = await ctx.readBody();
  const { task, project, family } = ctx.sessionContext(taskId);
  if (task === null) {
    ctx.error(404, 'task not found');                    // 紧凑
    return;
  }
  if (family !== 'dsh_plugin') {
    ctx.errorSpaced(400, '该 agent 族不支持回答问题');
    return;
  }
  const sid = task.session_id || '';
  if (!sid) {
    ctx.error(409, '会话尚未生成（首轮执行后才有）');      // 紧凑
    return;
  }
  board.interactionProbe(family, project, sid);
  const card = { session_id: sid };
  let err;
  if (pyTruthy(pyGet(body, 'approval_id'))) {
    const orEmpty = (k) => pyStrScalar(pyTruthy(pyGet(body, k)) ? pyGet(body, k) : '');
    err = await board.answerApproval(project, card, orEmpty('approval_id'),
      orEmpty('decision'), orEmpty('scope'), { db: ctx.db });
  } else {
    const qid = pyStrScalar(pyTruthy(pyGet(body, 'qid')) ? pyGet(body, 'qid') : '');
    if (!qid) {
      ctx.error(400, 'qid/approval_id required');        // 紧凑
      return;
    }
    err = await board.answerInteraction(project, card, qid, pyGet(body, 'answers') || [],
      { db: ctx.db });
  }
  if (err) {
    ctx.errorSpaced(400, err);
    return;
  }
  ctx.text(200, '{"ok":true,"queued":false}', 'application/json; charset=utf-8');
}

/** 路由表（顺序即匹配顺序；本族前缀与看板/任务族互不重叠） */
export const routes = [
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/board\/session\/messages$/,
    handler: (ctx, m) => boardSessionMessages(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/board\/session\/media\/(.+)$/,
    handler: (ctx, m) => boardSessionMedia(ctx, Number(m[1]), m[2]),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/session\/messages$/,
    handler: (ctx, m) => taskSessionMessages(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/session\/stream$/,
    handler: (ctx, m) => taskSessionStream(ctx, Number(m[1])),
  },
  {
    method: 'GET',
    re: /^\/api\/tasks\/(\d+)\/session\/media\/(.+)$/,
    handler: (ctx, m) => taskSessionMedia(ctx, Number(m[1]), m[2]),
  },
  // --- 写路径（M4.5/M6-6）：顺序 = Python do_POST 的分派顺序 ---
  // （chat → inject → rewind → interaction/answer → profile → compact(2026-10-24) → stop）
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/chat$/,
    handler: (ctx, m) => taskSessionChat(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/chat\/inject$/,
    handler: (ctx, m) => taskSessionChatInject(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/rewind$/,
    handler: (ctx, m) => taskSessionRewind(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/interaction\/answer$/,
    handler: (ctx, m) => taskAnswerInteraction(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/profile$/,
    handler: (ctx, m) => taskSessionProfile(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/compact$/,
    handler: (ctx, m) => taskSessionCompact(ctx, Number(m[1])),
  },
  {
    method: 'POST',
    re: /^\/api\/tasks\/(\d+)\/session\/chat\/stop$/,
    handler: (ctx, m) => taskSessionChatStop(ctx, Number(m[1])),
  },
];
