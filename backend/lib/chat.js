/**
 * session 对话的**消息生命周期**（`chat.py` 1189 行的 Node 对应物；M3 只读子集 + M4 写/流程口）。
 *
 * 权威语义来源是 `chat.py` 的模块 docstring（下面逐条搬过来，改代码前必读）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 核心模型：消息是统一队列的第三类单元 `m:<msg_id>`
 * ══════════════════════════════════════════════════════════════════════════════
 *   ① 用户在会话窗发的每条消息都走**统一队列**：消息行登记在 `chat_msgs`（权威，用户可见
 *      生命周期 queued→running→done/yielded/error/cancelled），队列行在 `wait_items`
 *      （kind=msg，管「队列拾取互斥」）——两套状态机互不替代。
 *   ② 入队后由 `runner` 的 worker 补位拾取（同项目串行：项目忙就按入队顺序等），拾起后
 *      调 `runUnit(msgId)`。
 *   ③ `runUnit` 负责「投递 + 等 turn 结束」：`msgClaim` 原子 queued→running（与 `injectNow`
 *      的 `waitq.claim` 互斥互补），执行体按**行 + 提交时定格的 meta 快照**重建（闭包不可
 *      持久化，故 family/model/comment_id 定格进等待项 meta），终态 done/yielded/error 落表，
 *      且**等待项行的终态在同一函数闭环**（裁决 R6：终态归执行体，runner 影子段不再管 m:）。
 *   ④ turn 挂起等用户作答（`driver/interaction`）⇒ **提前让位**：STATE_YIELDED——消息已送达、
 *      运行位（等待项行）即释放，队首单元照常起跑；用户作答后会话恢复并重新成为占用源。
 *   ⑤ 单元执行期间持有项目占用 ⇒ 该项目后续任务/卡片也要等它结束（**双向串行**，
 *      「任务按项目串行」红线）。
 *   ⑥ 重启存活：排队消息照常执行；执行中被中断的记 error、**不重投**（msg 重发非幂等，
 *      见 `waitq.msg_recover_fail`）。
 *   ⑦ 「立即注入」（`injectNow`）：用户点按钮即撤销排队并立刻投递（dsh：steer 注入当前 turn
 *      的最近 step 边界，会话空闲则起一轮）——不等队列、不等 turn 结束、不持运行位。
 *   ⑧ 外部会话（C 批 T5）：用户在 dsh GUI 里直跑/接管的会话（`owned:false`）也能投递，但必须
 *      在**入队之前**过 `externalPreflight`（宿主有活 agent ∧ 平台已向驱动声明看管）；前提
 *      不成立即抛 `DeliveryRefused`，消息**不落 chat_msgs/wait_items 行**——把「必然失败的
 *      静默排队」变成「发送即明确文案」。池内会话与未对齐（未知）路径**不会**抛它。
 *   ⑨ 并发约束（由 server 层保证）：同一会话同时最多一个对话单元；同一会话可连发多条消息
 *      （按入队顺序串行执行）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `_CHATS`（进程内对话登记表）：Node 侧是普通 Map，**不再需要锁**
 * ══════════════════════════════════════════════════════════════════════════════
 * Python 用 `_CHATS` dict + `threading.Lock`（HTTP 线程池 / runner 线程 / SSE 线程并发读写，
 * 连 `_new_msg_id` 的发号都共用那把锁）。Node 是**单事件循环**：本模块每一次「读—改—写」
 * 都跑在同一个 tick 里（中间没有 await），`dshevents` 的订阅回调也是同步调用 ⇒ 进程内不存在
 * 并发交错，锁没有可保护的对象。要守的纪律只有一条：**不要把 await 塞进这些临界区**
 * （例：`state` 里 `rec.exit_code` 的顺手回填在 await 前后各自成段）。同理 `_DSH_SUB` 的
 * 「旁表 + 锁」退化成「旁表 + 同 tick 原子操作」——Python 的 `_dsh_sub_reap_locked` 在 Node
 * 侧没有锁可持（`dshSubReap`）。**不引入 worker_threads**（那会让上述论证失效，届时要重审）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 同步 / 异步契约（本文件最容易做错的一处）
 * ══════════════════════════════════════════════════════════════════════════════
 * Python 是线程 + `time.sleep` / `threading.Event` 阻塞；Node 的对应写法是 `await` + 定时器
 * （setTimeout 的 promise 版）。故下列函数是 **async，调用方必须 await**：
 *   `submit` / `start` / `runUnit` / `injectNow` / `stop` / `sendNow` / `dshSendNow` /
 *   `dshSend` / `dshBaselineSince` / `dshWaitTurn` / `dshWaitTurnViaEvents` / `waitTurn` /
 *   `waitWebBusy` / `injectSend` / `reviveHostSession` / `dshBusy`；`state`/`running` 见下。
 * 其余一律**同步**（不许 await），尤其 `rebuildRun` / `rebuildInject`——**载荷读取是同步的**，
 * 只有它们返回的 thunk 才是 async：Python `_rebuild_run(msg_id)` 先同步读行/meta/项目行、
 * 再返回闭包，Node 逐点保留这个时序（`msgPayload` 同步读，thunk 里才 await 投递）。
 * **所有 `waitq.*` / `db.*` 调用一律同步直调**（`node:sqlite` 是同步 API）：绝不把它们包进
 * `then`/`Promise.all` 里去改变调用顺序或事务边界。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `state` / `running`：**一律 async**（有意差异 ①）
 * ══════════════════════════════════════════════════════════════════════════════
 * Python `state()` 是同步函数（无 `_CHATS` 记录时直接 return base，有记录才调同步的
 * `dsh_busy`）。Node 侧 `dshBusy` 是**远端读**、只能 async ⇒ `state`/`running` **整体
 * async，调用方一律 await**：`await` 一处都不能漏，否则 Promise 会被静默序列化成 `{}`
 * （M4 的路由接线点 `routes/sessions.js` 已按此口径 await）。
 * 分支本身逐点照 Python：无 sid / 无登记记录 / 非 dsh 记录 ⇒ base（不做任何 I/O）；
 * 有 dsh 记录 ⇒ 读一次驱动状态，`!busy` 且 `exit_code` 为 null 时顺手回填 0。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * M5 缝：board 投递桥（**注入式，不许静默成功**）
 * ══════════════════════════════════════════════════════════════════════════════
 * Python 里 chat 对 board 的依赖只有三处，Node 侧 board.js（M5）尚无对应函数，故做成显式
 * 注入口 `setBoardBridge({ensureWatch, deliverUnit, deliverNow})`；未注册时：
 *   ① `externalPreflight` 第⑤步的 `board._ensure_watch(sid)` ⇒ `ensureWatch` 视作**返回
 *      false** ⇒ 外部会话按 Python 的「看管声明失败」文案拒投（逐字一致，不落行）；
 *   ② `rebuildRun` 的卡片评论分支 `board._deliver_unit(...)` ⇒ 抛「卡片投递桥未接线（M5）」
 *      错，由 `runUnit`（或 `submit` 的同步路径）收口成该 msg 单元的 **error 终态**
 *      （`chat_msgs.error` 就是该文案）；
 *   ③ `rebuildInject` 的卡片评论分支 `board._deliver_now(...)` ⇒ 同上；`injectNow` 按投递
 *      失败路径把消息放回排队（returnToWaiting + msgRequeue）后**原样上抛**。
 *   三条都是响亮失败，绝无静默成功。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 与 Python 的有意差异（逐条 + 理由）
 * ══════════════════════════════════════════════════════════════════════════════
 *   ① `state`/`running` 一律 async（Python 是同步函数；见上）。
 *   ② `dshBusy`/`dshBaselineSince` 的宽容读：Python 对非 dict 响应 `.get()` 会 AttributeError，
 *      Node 用 `(st || {})` 吞成 false/空串（与 M3 本文件既有口径、`dshdriver.js` 差异⑦同源；
 *      只影响「驱动返回畸形正文」这一异常形态）。
 *   ③ `msgsOfSid` 的 120 字截断按 UTF-16 码元（Python 按码点）——只服务前端 chip 预览。
 *   ④ `msgEnqueue` 的 `queue` 参数逐字对应 `waitq.py:1179` 的形参表（`queue=false` ＝
 *      「runner 单例缺位的同步路径不写等待项」，P5 R13 的孤儿行收口）。
 *   ⑤ 等 turn 的本地节拍/时限全走毫秒定时器，但**判定顺序、超时文案、时限口径与 Python 逐条
 *      同**（`TICK`/`TURN_START_GRACE`/`DSH_WAIT_TURN_TIMEOUT` 保持 Python 的秒值）。
 *   ⑥ 终态钩子若返回 thenable，本文件补一个 `.catch` 留痕（Node 的未处理拒绝会杀进程；Python
 *      的同步钩子没有这个形态）——钩子的调用点与调用语义不变。
 *   ⑦ waitq 的 M4 写口经**运行期符号门**调用（`wq(name)` + `missingWaitqSymbols()`）：并行
 *      移植窗口里缺符号时抛**指名**的中文错误，而不是整文件链接失败（只读口照常可用）。
 *   ⑧ `lib.ensureRuntimeDirs` / `runner.appendLog` / `runner.LOG_DIR_NAME` 已由 M4 的兄弟模块
 *      落地，本文件**优先用共享实现**（`runtimeDir`/`logDirName`/`appendLog` 三个薄包装就是
 *      唯一读点）；本地等价兜底保留，用于并行移植窗口与旧树（避免静态 import 缺符号导致
 *      整文件链接失败）。
 *
 * 零 npm 依赖：只用 `node:` 内建模块 + 本仓库内模块。
 */

import fs from 'node:fs';
import path from 'node:path';

import { agentFamily } from './agents.js';
import { getProject, withReadDb } from './db.js';
import * as dshevents from './dshevents.js';
import {
  DshDriverError,
  TurnWaiter,
  cancel as driverCancel,
  feedInto as driverFeedInto,
  prompt as driverPrompt,
  resumeSession as driverResumeSession,
  status as driverStatus,
  steer as driverSteer,
} from './dshdriver.js';
import * as libMod from './lib.js';
import { pyJsonDumps } from './pyjson.js';
import * as runnerMod from './runner.js';
import * as waitq from './waitq.js';

/**
 * session_id -> 对话记录：`{task_id, started_at, message, exit_code, log_path, dsh_plugin?, since?}`。
 *
 * 登记写入点是 `register`（`_register`），读取点是 `state` / `stop` / 等 turn 时的
 * `log_path` 缺省回落。**Node 单事件循环下不需要锁**（见文件头「不再需要锁」），
 * 用 Map 而不是对象：Python dict 的对应物，`get` 无原型污染。
 */
export const CHAT_REGISTRY = new Map();

/** msg_id 自增序号（`_MSG_SEQ`；仅发号用，记录本体在 `chat_msgs` 表） */
let MSG_SEQ = 0;

/** 消息状态机（逐条对齐 chat.py:54-59） */
export const STATE_QUEUED = 'queued';       // 已入队，等项目空闲
export const STATE_RUNNING = 'running';     // 正在执行（发送中 / 等 turn 结束）
export const STATE_DONE = 'done';           // 已送达且 turn 结束
export const STATE_YIELDED = 'yielded';     // 已送达；turn 挂起等作答，运行位已让出
export const STATE_ERROR = 'error';         // 执行失败（error 字段为原因）
export const STATE_CANCELLED = 'cancelled'; // 排队中被取消

/** 单条对话消息长度上限（`MESSAGE_MAX`；站点 `POST …/messages` 与飞书通用对话共用） */
export const MESSAGE_MAX = 20000;
/** 终态记录保留时长（秒）——前端取过失败原因后回收（`MSG_KEEP_SEC`） */
export const MSG_KEEP_SEC = 600;
/** 消息登记表规模上限（`MSG_MAX`）：超出丢最旧的终态记录 */
export const MSG_MAX = 200;
/** turn 启动宽限（秒）：未见 `turn/started` 判「turn 压根没起来」（`TURN_START_GRACE`） */
export const TURN_START_GRACE = 60;
/** 等 turn 结束的本地检查节拍（秒，与 runner 轮次轮询一致；`TICK`） */
export const TICK = 2;

/**
 * dsh 等 turn 结束的**总时限**（秒，P7a 缺陷 G 兜底）。
 *
 * 链路保活正常但服务端就是不推 `turn/end` 时，只等 `TurnWaiter` 会永远等下去——实测
 * （假 driver 单订阅缺陷期间）`chat_msgs` 卡 running、`wait_items` 的 `m:` 行卡 starting
 * 4 分钟以上、项目运行位永久被占，只有重启能解。到点写一行会话日志并按「本轮结束」
 * 返回 null，让行收口、补位继续；纯本地 deadline，不引入远端轮询。45 分钟口径：runner
 * 侧没有轮次硬超时（唯一护栏是「turn 压根没起来」的 120s），故取「一轮合法长跑」的
 * 经验上限，够长到不误杀正常长轮；环境变量可覆盖（单测调小用）。
 */
export const DSH_WAIT_TURN_TIMEOUT = 2700.0;
/** 总时限的环境变量名（`DSH_WAIT_TURN_TIMEOUT_ENV`；每次调用现读，进程内可热改） */
export const DSH_WAIT_TURN_TIMEOUT_ENV = 'TS_DSH_WAIT_TURN_TIMEOUT';

/** 外部会话投递总开关（回滚阀）：`TS_EXTERNAL_DELIVER=0` ⇒ 外部会话一律拒投 */
export const EXTERNAL_DELIVER_ENV = 'TS_EXTERNAL_DELIVER';
/** 宿主会话存活兜底总开关（回滚阀）：`TS_HOST_SESSION_REVIVE=0` ⇒ 不接回 */
export const HOST_REVIVE_ENV = 'TS_HOST_SESSION_REVIVE';

/** `_DSH_SUB` 条数上限（超出按建订阅时刻从旧到新回收） */
export const DSH_SUB_MAX = 32;
/** 预订阅惰性过期（秒）：投递后无人取走即回收 */
export const DSH_SUB_TTL = 120.0;

/** 可续聊的 agent 族白名单（`chat.CHAT_FAMILIES`，单族化后只剩 dsh 插件） */
export const CHAT_FAMILIES = Object.freeze(['dsh_plugin']);

/** 「卡片投递桥未接线（M5）」——board.js 的两条卡片投递口还没移植时的响亮失败文案 */
export const CARD_BRIDGE_MISSING = '卡片投递桥未接线（M5）：board._deliver_unit/_deliver_now '
  + '尚未移植，卡片评论消息无法投递';

/** 运行产物目录名兜底（`runner.LOG_DIR_NAME`；共享常量优先，见 `logDirName`） */
const LOG_DIR_NAME = '.web';
/** 运行产物目录清单兜底（`lib.RUNTIME_DIR_NAMES`，顺序即 .gitignore 追加顺序） */
const RUNTIME_DIR_NAMES = ['.web', '.live', 'board_media'];

// --------------------------------------------------------------------------
// 错误类（逐条对齐 chat.py:77-94；`instanceof` 可判定，中文文案逐字一致）
// --------------------------------------------------------------------------

/**
 * 「立即注入」被拒（消息已不在排队中 / 不支持注入）：消息未动，仍在队列。
 *
 * 与投递失败的区分：被拒 → 端点 400、消息继续排队；投递失败 → 端点 502、消息按原位次
 * 退回排队（`returnToWaiting` 不动 seq，见 `injectNow`）。
 * Python 是 `RuntimeError` 子类；Node 的对应物是 `Error` 子类（判据一律 `instanceof`）。
 */
export class InjectRefused extends Error {
  /** @param {string} message 中文文案（端点原样回给前端） */
  constructor(message) {
    super(message);
    this.name = 'InjectRefused';
  }
}

/**
 * 外部会话投递前置闸拒绝（C 批 T5）：消息**未入队、未落行**。
 *
 * 与投递失败（`DshDriverError`，消息落 `chat_msgs.state=error`）的区分：本异常在入队
 * **之前**由 `externalPreflight` 抛出，`chat_msgs`/`wait_items` 都查不到这次发送——
 * 把「必然失败的静默排队」变成「点发送即刻的明确文案」。触发面只有外部会话
 * （`owned:false`）且前提不成立：宿主无活 agent（会话已结束）/ 看管声明失败 / 回滚阀关闭。
 * 池内会话与未对齐（未知）路径**不会**抛本异常。
 */
export class DeliveryRefused extends Error {
  /** @param {string} message 中文文案（端点原样回给前端） */
  constructor(message) {
    super(message);
    this.name = 'DeliveryRefused';
  }
}

/**
 * 本会话消息的展示视图（排队/执行中 + 近期失败）：
 * `{id, text, state, error, created_at}`。
 *
 * 终态正常记录（done/yielded/cancelled）不发——前端 chip 由「被会话收录」自行清除。
 * `text` 截 120 字（Python 切片 `[:120]`；Node 的 `slice` 按 UTF-16 码元，与 Python 按
 * 码点不同——中文 BMP 内一致，emoji 等代理对可能差 1 个字符。**有意的形态差异**：
 * 截断只服务前端 chip 的短预览，不参与任何判据）。
 *
 * 末尾**再按 created_at 排一次序**：SQL 已是 `ORDER BY created_at, id`，这里的重复排序
 * 照抄 Python（`out.sort` 稳定 ⇒ 同 created_at 时保持 SQL 的 id 序，结果不变）。
 *
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Array<{id: string, text: string, state: string, error: string, created_at: number}>}
 */
export function msgsOfSid(sid, options = {}) {
  if (!sid) return [];
  const rows = waitq.msgRows({ sid, states: [STATE_QUEUED, STATE_RUNNING, STATE_ERROR] }, options);
  const out = rows.map((r) => ({
    id: r.id,
    text: String(r.message === null || r.message === undefined ? '' : r.message).slice(0, 120),
    state: r.state,
    error: r.error,
    created_at: r.created_at,
  }));
  out.sort((a, b) => {
    if (a.created_at === b.created_at) return 0;
    return a.created_at < b.created_at ? -1 : 1;
  });
  return out;
}

/**
 * 本会话是否有排队/执行中的消息单元（`m:` 入队后到结束/取消之间）。
 *
 * 看板调和器判定「本卡会话即将或正在由平台消息驱动」用：消息进统一队列后、轮到执行前
 * 会话并不 busy，仅凭 web busy 会漏判——阻塞列卡片在消息排队/执行期间应视作运行中
 * （回「正在开发」列）。表驱动：`state ∈ {queued,running}` 任一行即真。
 *
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {boolean}
 */
export function liveOfSid(sid, options = {}) {
  if (!sid) return false;
  return waitq.msgRows({ sid, states: [STATE_QUEUED, STATE_RUNNING] }, options).length > 0;
}

/**
 * 有**排队中**消息（尚未轮到执行）的卡片 id 集合（看板 payload 批量预计算用）。
 *
 * 数据源 = `waitq.msg_queued_card_ids()`：`chat_msgs` 里 `state='queued'` 且
 * `card_id IS NOT NULL` 的 distinct 集合。卡片会话的「排队中」徽标就靠它——平台已收下
 * 消息、等空闲送达，卡片按「排队中」呈现且不点亮「会话运行中」。
 *
 * ⚠ **集合元素口径（2026-10-12 M4 归位为 int，与 Python 一致）**：Python 的
 * `chat.queued_card_ids()` 就是 `waitq.msg_queued_card_ids()` 的直通壳（`chat.py:438`），
 * 返回 **int 集合**；M3 的 Node 只读子集把实现放在了本文件并改成**字符串**集合、
 * `board.js` 配套按 `String(r.id)` 查——两侧自洽，所以读端点对拍看不出差异（值只喂给
 * `card_json` 的布尔位）。M4 的 op 级对拍把它照出来了（集合元素类型即契约），故：
 * 实现归位 `waitq.msgQueuedCardIds`（int），本函数退化为**直通**（保留导出名，
 * 兼容 M3 的 `board.js` 调用面），`board.js` 改成按 `Number(r.id)` 查。
 * 非数字 `card_id`（TEXT 存量行的理论形态）在 Node 侧是 `NaN`——Python 侧 `int()`
 * 直接抛，两侧都属不可达形态，不额外兜。
 *
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Set<number>}
 */
export function queuedCardIds(options = {}) {
  return waitq.msgQueuedCardIds(options);
}

/**
 * 消息记录只读摘要（端点归属校验用）：
 * `{id, sid, project_id, task_id, card_id, state}`。记录不存在返回 null。
 *
 * `state` 的口径（照 Python，P4 起）：**优先读等待项行**（`waitq.getActive(KIND_MSG,…)`
 * 的 `state`）——行态才是队列权威（waiting/starting/running/…）；行不在场时回落
 * `chat_msgs.state`（queued/running/done/error/cancelled）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {{id: string, sid: string, project_id: number, task_id: number|null,
 *            card_id: number|null, state: string}|null}
 */
export function msgInfo(msgId, options = {}) {
  const r = msgId ? waitq.msgGet(msgId, options) : null;
  if (r === null) return null;
  // `state` **取 chat_msgs 行**（照 Python `msg_info`：`{"state": r["state"]}`，chat.py:449）。
  // M4 的实现曾在「有活跃等待项行」时改取等待项行的 state——那是自创口径：两表在竞态窗口内
  // 本就不同步，谁覆盖谁都没有依据，而 Python 是唯一真源。M4.5 由 S2 报告点出（现状零影响，
  // 因为唯一调用方 `_inject_msg` 只读 id/sid/project_id/task_id，但它会潜伏到有人按 state
  // 判「还在不在排队」的那天）。
  return {
    id: r.id,
    sid: r.sid,
    project_id: r.project_id,
    task_id: r.task_id,
    card_id: r.card_id,
    state: r.state,
  };
}

/**
 * dsh 插件会话是否正在跑 turn（驱动不可用按 false，交由发送路径报错）。
 *
 * 读插件内存态（`/status`）——会话状态由 dsh 侧 `agent/status` 事件维护，这里只是读一次
 * （Python 语）。**Node 侧是 async**（M2 驱动客户端全异步，见文件头同步/异步契约）。
 *
 * 异常口径逐点照 Python：`except dshdriver.DshDriverError: return False` ⇒ 只有
 * `DshDriverError` 被吞成 false；其他异常照常外抛（Python 同）。Python 的
 * `response.get("status")` 在响应非 dict 时会 AttributeError（不是 DshDriverError ⇒
 * 上抛），Node 用 `(st || {})` 会把它吞成 false ⇒ **有意的宽容化**（文件头差异②），
 * 与 M2 `dshdriver.js` 文件头差异⑦「宽容读」同一口径。
 *
 * @param {string} sid
 * @returns {Promise<boolean>}
 */
export async function dshBusy(sid) {
  try {
    const st = await driverStatus(sid);
    return (st || {}).status === 'running';
  } catch (err) {
    if (err && err.name === 'DshDriverError') return false;
    throw err;
  }
}

/**
 * 对话状态：`{running, queued, msgs, started_at?, message?, exit_code?}`。
 *
 * `running` = 有进行中的对话（dsh 族读插件内存态会话状态）；`queued` = 排队中消息数；
 * `msgs` = 排队/执行中与近期失败消息（前端排队 chip 与失败提示用）。
 *
 * 判定阶梯与 Python 逐条同（`chat.py:1141-1165`）：
 *   ① 先算 `base`（表驱动，**再**判 sid——故空 sid 也照样把 `queued`/`msgs` 算出来）；
 *   ② 无 sid / 无登记记录 / 非 dsh 记录 ⇒ 直接返回 base（**不做任何 I/O**，与 Python 早退同支）；
 *   ③ 有 dsh 记录 ⇒ `dshBusy(sid)`；`!busy` 且 `exit_code === null` 时**顺手把进程内记录的
 *      `exit_code` 写成 0**（Python 原样如此，不落库），返回带三键的对象。
 * **async**（`dshBusy` 是远端读）：调用方一律 `await`，否则拿到的是 Promise 真值。
 *
 * ⚠ 返回的 base 是**新对象**（每次调用现造）：调用方可以就地改字段（`routes/sessions.js`
 * 就地把 `running` 与看板 busy 合并），不会污染登记表或影响下一次调用。
 *
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Promise<{running: boolean, queued: number, msgs: object[],
 *                    started_at?: number, message?: string, exit_code?: number|null}>}
 */
export async function state(sid, options = {}) {
  const msgs = msgsOfSid(sid, options);
  const base = {
    running: false,
    queued: msgs.filter((m) => m.state === STATE_QUEUED).length,
    msgs,
  };
  if (!sid) return base;                        // 与 Python 的 `if not sid: return base` 同支
  const rec = CHAT_REGISTRY.get(sid);
  if (rec === undefined) return base;           // 与 Python 的 `rec is None: return base` 同支
  if (!rec.dsh_plugin) return base;             // 防呆：非 dsh 记录不再产生，按空闲呈现
  const busy = await dshBusy(sid);
  if (!busy && rec.exit_code === null) rec.exit_code = 0;
  return {
    ...base,
    running: busy,
    started_at: rec.started_at,
    message: rec.message,
    exit_code: rec.exit_code,
  };
}

/**
 * 是否有进行中的对话（Python `state(sid)["running"]` 的直读）。
 * **async**，与 `state` 同（**调用方一律 await**，见文件头差异①）。
 *
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Promise<boolean>}
 */
export async function running(sid, options = {}) {
  return (await state(sid, options)).running;
}

/**
 * 项目 agent 族（`chat.submit_task` 里 `runner.agent_family(project["agent_path"])` 的
 * 等价物；单族化后只回 `dsh_plugin` / `retired`）。
 *
 * 本函数是 `agents.agentFamily` 的**直通**——放在这里的唯一理由是让可续聊白名单
 * （`CHAT_FAMILIES`）有一个入口可查；不复制族判定逻辑（唯一真源在 `agents.js`）。
 *
 * @param {string} agentPath
 * @returns {string}
 */
export function familyOfProject(agentPath) {
  return agentFamily(agentPath);
}

// ══════════════════════════════════════════════════════════════════════════════
// M4：消息生命周期（发号 / 前置闸 / submit / 执行体 / 取消 / 注入 / 投递 / 等 turn）
// 函数顺序尽量对齐 chat.py：112（_new_msg_id）→ 1189（stop）
// ══════════════════════════════════════════════════════════════════════════════

// --------------------------------------------------------------------------
// 小工具（纯函数，全部同步）
// --------------------------------------------------------------------------

/**
 * Python `str(e)` 的等价物：异常 → 可落库/可打日志的中文文本。
 *
 * 为什么不能直接 `String(err)`：`new Error('消息行不存在')` 的 `String()` 是
 * `"Error: 消息行不存在"`，而 Python `str(RuntimeError('消息行不存在'))` 是
 * `"消息行不存在"`——这个文本会进 `chat_msgs.error` 与端点响应，必须逐字一致。
 * `DshDriverError` 覆写了 `toString()`（纯消息），故走 `String()`。
 *
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  if (err === null || err === undefined) return String(err);
  if (err instanceof DshDriverError) return String(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Python `float(raw)` 的等价物（取不到/非法一律回 `fallback`）。
 *
 * 覆盖下划线数字字面量（`float('1_000')` = 1000.0）、`inf`/`nan` 三种拼写；
 * 显式拒绝 `0x`/`0o`/`0b` 前缀（Python `float()` 对它们抛 ValueError ⇒ 回落常量，
 * 而 JS 的 `Number('0x10')` 会给 16，方向相反）。
 *
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {number}
 */
function pyFloatOr(raw, fallback = 0) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return fallback;
  const norm = text.replace(/_/g, '');
  const lower = norm.toLowerCase();
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') {
    return Infinity;
  }
  if (lower === '-inf' || lower === '-infinity') return -Infinity;
  if (lower === 'nan' || lower === '+nan' || lower === '-nan') return NaN;
  if (/^[+-]?0[xob]/i.test(norm)) return fallback;
  const val = Number(norm);
  return Number.isFinite(val) || Number.isNaN(val) ? val : fallback;
}

/**
 * Python `f"{x:g}"` 的等价物（6 位有效数字、去尾零、指数阈值 −4/6）——只服务超时文案。
 *
 * @param {number} value
 * @returns {string}
 */
function pyG(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const prec = 6;
  const exp = Math.floor(Math.log10(Math.abs(n)));
  if (exp < -4 || exp >= prec) {
    const [mant0, expPart] = n.toExponential(prec - 1).split('e');
    let mant = mant0;
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const sign = expPart.startsWith('-') ? '-' : '+';
    const abs = String(Math.abs(Number(expPart))).padStart(2, '0');
    return `${mant}e${sign}${abs}`;
  }
  let text = n.toPrecision(prec);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

/**
 * `since` / seq 归一成整数（对齐 Python `int(x or 0)`；坏值一律 0）。
 * @param {unknown} value
 * @returns {number}
 */
function toIntSeq(value) {
  if (value === null || value === undefined || value === '' || value === false) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 等待项行 meta 解析（`_msg_meta`）：坏 JSON / 非对象按空对象。
 *
 * 与 `waitq.msgMeta` 的区别：本函数吃**调用方手上那一行**（活跃行），不做二次查询
 * ——Python `_msg_meta(wrow)` 的调用点全部如此。
 *
 * @param {object|null} wrow 等待项行（可为 null）
 * @returns {object}
 */
function parseMeta(wrow) {
  const raw = wrow === null || wrow === undefined ? '' : wrow.meta;
  let meta;
  try {
    meta = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta;
}

/**
 * 运行产物目录（`lib.runtime_dir`）：优先用 `lib.js` 的共享实现。
 * @param {string} workDir
 * @param {string} name
 * @returns {string}
 */
function runtimeDir(workDir, name) {
  if (typeof libMod.runtimeDir === 'function') return libMod.runtimeDir(workDir, name);
  return path.join(workDir, name);
}

/**
 * 运行产物目录名：优先用 `runner.js` 的共享常量（单一真源），缺则回落本地兜底。
 * @returns {string}
 */
function logDirName() {
  return typeof runnerMod.LOG_DIR_NAME === 'string' ? runnerMod.LOG_DIR_NAME : LOG_DIR_NAME;
}

/**
 * 运行产物目录清单：优先用 `lib.js` 的共享常量（单一真源），缺则回落本地兜底。
 * @returns {string[]}
 */
function runtimeDirNames() {
  return Array.isArray(libMod.RUNTIME_DIR_NAMES) ? [...libMod.RUNTIME_DIR_NAMES] : RUNTIME_DIR_NAMES;
}

/**
 * 追加文本到日志（`runner.append_log`，runner.py:2171）：以二进制写、utf-8、吞掉所有
 * 写失败（空路径/目录不存在/无权限都不许影响队列收口）。
 *
 * 优先用 `runner.js` 的共享实现（M4 若补上就该走它）；暂缺时本地等价兜底（文件头差异⑧）。
 *
 * @param {string} logPath
 * @param {string} text
 */
function appendLog(logPath, text) {
  if (typeof runnerMod.appendLog === 'function') {
    runnerMod.appendLog(logPath, text);
    return;
  }
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, Buffer.from(text, 'utf8'));
  } catch {
    // 与 Python `except OSError: pass` 同：日志写失败绝不影响投递/收口
  }
}

/**
 * 确保运行产物目录与 `.gitignore` 就绪（`lib.ensure_runtime_dirs`，lib.py:149）。
 *
 * 优先用 `lib.js` 的共享实现；暂缺时本地等价兜底（文件头差异⑧）。语义逐点：
 *   - 建 `.web`/`.live`/`board_media`（已存在跳过，失败静默）；
 *   - `.gitignore` 缺哪条补哪条（**已有内容一律不动**；文件不存在则新建）；
 *   - 目录/gitignore 写不进去不抛错（后续日志写入自然报启动失败）。
 *
 * @param {string} workDir
 */
function ensureRuntimeDirs(workDir) {
  if (typeof libMod.ensureRuntimeDirs === 'function') {
    libMod.ensureRuntimeDirs(workDir);
    return;
  }
  const names = runtimeDirNames();
  for (const name of names) {
    try {
      fs.mkdirSync(runtimeDir(workDir, name), { recursive: true });
    } catch {
      // 静默（同 Python `except OSError: pass`）
    }
  }
  const gi = path.join(workDir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(gi, 'utf8');
  } catch {
    text = '';                     // 读不到（不存在/无权限）：按空文本处理，仍尝试追加
  }
  try {
    // Python `splitlines()`：\n / \r\n / \r 都算换行
    const lines = new Set(text.split(/\r\n|\r|\n/).map((line) => line.trim()));
    const missing = names
      .filter((name) => !lines.has(`${name}/`))
      .map((name) => `${name}/`);
    if (missing.length) {
      let out = '';
      if (text && !text.endsWith('\n')) out += '\n';
      out += `${missing.join('\n')}\n`;
      fs.appendFileSync(gi, out, 'utf8');
    }
  } catch {
    // 静默（同 Python `except OSError: pass`）
  }
}

// --------------------------------------------------------------------------
// waitq M4 写口的运行期符号门（并行移植窗口；文件头差异⑦）
// --------------------------------------------------------------------------

/** M4 需要的 waitq 写口符号（缺谁报谁；只读口不在表内——它们是 M3 已冻结的存量） */
const WQ_WRITE_SYMBOLS = Object.freeze([
  'msgEnqueue', 'msgPrune', 'msgClaim', 'msgRequeue', 'msgFinish', 'msgCancel',
  'finishByTarget', 'markEvidence', 'claim', 'cancel', 'returnToWaiting',
]);

/**
 * 当前 `waitq.js` 还缺哪些 M4 写口符号（空数组＝齐备）。
 *
 * 存在的理由：命名 import 在**链接期**校验，缺一个符号会让整个 chat.js 加载失败
 * （连只读口都跑不起来）；M4 的 waitq 写口是并行移植的另一路，故这里改成运行期查表，
 * 缺符号时抛**指名**的中文错误。合并完成后本函数返回 `[]`，等价于静态约束。
 *
 * @returns {string[]}
 */
export function missingWaitqSymbols() {
  return WQ_WRITE_SYMBOLS.filter((name) => typeof waitq[name] !== 'function');
}

/**
 * 取一个 waitq 写口函数（缺符号时报明确的错，而不是 TypeError）。
 * @param {string} name
 * @returns {Function}
 */
function wq(name) {
  const fn = waitq[name];
  if (typeof fn !== 'function') {
    throw new Error(`waitq.js 缺写口符号 ${name}（M4 并行移植未完成，见 chat.js 文件头差异⑦）`);
  }
  return fn;
}

// --------------------------------------------------------------------------
// 进程内旁表与注入点
// --------------------------------------------------------------------------

/** sid -> 投递前会话 last_seq：等 turn/end 的 SSE 续传起点（`_DSH_BASELINE`） */
export const DSH_BASELINE = new Map();

/**
 * sid -> 本次投递是否 steer（`_DSH_INJECT`）。
 *
 * 用途只有一个：`dshWaitTurnViaEvents` 判定「本轮 turn/start 帧早于订阅」时，仅当本次
 * 投递是 steer 注入才按「已在跑」播种 `started`。**每次 `dshSend` 都写**（true/false
 * 都写，旧值必须被覆盖——否则上一次 steer 的残留 true 会毒化下一次 followup 的等待）。
 * 池内等待器 `dshWaitTurn` 不读它。
 */
export const DSH_INJECT = new Map();

/** 消息单元终态钩子 `fn(msgId, state)`（`_MSG_DONE_HOOK`；单一注册位，后注册覆盖先注册） */
let MSG_DONE_HOOK = null;

/** board 投递桥（M5 缝；未注册时三处依赖按文件头「M5 缝」各走响亮失败） */
let BOARD_BRIDGE = null;

/**
 * 注册 board 投递桥（M5 接线口）：`{ensureWatch, deliverUnit, deliverNow}`。
 *
 *   - `ensureWatch(sid)` → boolean：对应 `board._ensure_watch`（外部会话投递前置闸第⑤步）；
 *   - `deliverUnit(project, card, comment, message, inject, options)`：对应
 *     `board._deliver_unit`（卡片评论排队投递，等 turn 结束）；
 *   - `deliverNow(project, card, comment, message, inject, options)`：对应
 *     `board._deliver_now`（立即注入，不等 turn）。
 *
 * 未注册（或某个口缺失）时的行为见文件头「M5 缝」：**绝不静默成功**。
 * 传 `null` 注销（回到未接线态）。
 *
 * @param {{ensureWatch?: Function, deliverUnit?: Function, deliverNow?: Function}|null} bridge
 */
export function setBoardBridge(bridge) {
  BOARD_BRIDGE = bridge || null;
}

/** 测试注入点：runner 单例（生产链路不调用；见 `runnerInstance`） */
let RUNNER_TEST_INSTANCE;
let RUNNER_TEST_SET = false;

/**
 * 注入 runner 替身（**测试专用**；`setRunnerInstance(null)` 恢复读真单例）。
 *
 * 为什么需要这个口：Python 测试直接 `runner.INSTANCE = Fake()`，而 Node 的 ESM 命名空间
 * 对象不可写（`runnerMod.INSTANCE = x` 会 TypeError）。本函数是 chat 侧**唯一**的 runner
 * 单例读点（`runnerInstance`）的注入面，生产链路从不调用。
 *
 * @param {object|null} inst
 */
export function setRunnerInstance(inst) {
  RUNNER_TEST_INSTANCE = inst === undefined ? null : inst;
  RUNNER_TEST_SET = true;
}

/**
 * 当前 runner 单例（Python `runner.INSTANCE`）。
 *
 * 读 `runner.js` 的模块级可写单例（`export let INSTANCE`）——命名空间对象按属性读，
 * 每次调用都取最新绑定值（Python 的模块全局语义）。
 *
 * @returns {object|null}
 */
function runnerInstance() {
  if (RUNNER_TEST_SET) return RUNNER_TEST_INSTANCE;
  return runnerMod.INSTANCE === undefined ? null : runnerMod.INSTANCE;
}

// --------------------------------------------------------------------------
// 发号与外部会话前置闸（chat.py:112-166）
// --------------------------------------------------------------------------

/**
 * 消息 id：毫秒时间戳-自增序号（无冒号，可直接作队列键后缀）。
 *
 * Python 用模块锁保护 `_MSG_SEQ`（与 `_CHATS` 共用）；Node 单事件循环下自增天然原子
 * （见文件头「不再需要锁」），故本函数**同步且无锁**。
 *
 * @returns {string}
 */
export function newMsgId() {
  MSG_SEQ += 1;
  return `${Date.now()}-${MSG_SEQ}`;
}

/**
 * 外部会话投递是否开启（`TS_EXTERNAL_DELIVER=0` 关闭；缺省/非法值按开启）。
 *
 * **每次调用现读**（与 `dshWaitTurnLimit` 同口径）：值在进程内可热改，不必重启平台。
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function externalDeliverEnabled({ env = process.env } = {}) {
  return String(env[EXTERNAL_DELIVER_ENV] || '').trim() !== '0';
}

/**
 * 投递前置闸（C 批 T5）：外部会话前提不成立时 **抛 `DeliveryRefused`**（不入队）。
 *
 * 判定阶梯（设计 §5.2；顺序即优先级）：
 *   ① 空 sid ⇒ 放行（既有路径自己报「会话 id 为空」，不改语义）；
 *   ② 注册表未知（`dshevents.get` 为 null：未连接 / 没见过该 sid）⇒ 放行；
 *   ③ 注册表未对齐（`dshevents.aligned()` 为假：热重载后 /live 空表，快照不可信）⇒ 放行
 *      ——**未知 ≠ 外部**，绝不据不可信快照拒投（与「断连=未知」同一不变量）；
 *   ④ `owned` 为真（平台自持会话）⇒ 放行，走池内原路**一个字节不变**；
 *   ⑤ 其余＝外部会话（用户在 dsh GUI 里直跑/接管）：要求「宿主有活 agent」
 *      （`status != 'unknown'`）∧「看管声明成功」（`board._ensure_watch`，幂等、失败不重试）
 *      ——任一不满足即拒投，并按分类文案抛错。
 * 回滚阀 `TS_EXTERNAL_DELIVER=0`：第⑤步整段退化为「外部会话一律拒绝」（连看管都不声明），
 * 池内/未知路径照旧放行。
 *
 * 为什么放在 `submit` 首行：投递的**唯一入口**是统一队列（chat_msgs 行 + m: 等待项一个
 * 事务），一旦落行就必然要等 worker 拾取、失败也只能落 error 终态——闸必须在落行之前。
 *
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @throws {DeliveryRefused}
 */
export function externalPreflight(sid, options = {}) {
  if (!sid) return;
  const st = dshevents.get(sid);
  if (st === null) return;                       // 未知：保持现状（真失败仍由投递错误兜底）
  if (!dshevents.aligned()) return;              // 不可信快照：不据此拒投（未知 ≠ 外部）
  if (st.owned) return;                          // 平台自持会话：池内原路
  // —— 以下为外部会话（用户在 dsh GUI 直跑/接管）：需要显式许可 ——
  if (!externalDeliverEnabled(options)) {
    throw new DeliveryRefused(
      '该会话是 dsh 直跑会话，平台已关闭外部会话投递'
      + `（${EXTERNAL_DELIVER_ENV}=0），请到 dsh 会话窗口发送`,
    );
  }
  if (String(st.status || '') === 'unknown') {
    // 宿主里没有活 agent（会话已结束/被销毁）：投递必然 404，别让用户白等
    throw new DeliveryRefused('会话已结束，无法投递（宿主无活动 agent）');
  }
  // 看管声明（`board._ensure_watch`）：M5 未接线时视作**返回 false**（文件头 M5 缝①）
  const bridge = BOARD_BRIDGE;
  const ensureWatch = bridge !== null && typeof bridge.ensureWatch === 'function'
    ? bridge.ensureWatch : null;
  if (ensureWatch === null || !ensureWatch(sid)) {
    throw new DeliveryRefused(
      '该会话是 dsh 直跑会话，平台未获投递许可（看管声明失败：插件过旧或不可达），'
      + '请到 dsh 会话窗口发送',
    );
  }
}

// --------------------------------------------------------------------------
// 提交消息单元（chat.py:169-214）
// --------------------------------------------------------------------------

/**
 * 登记一条会话消息并投入统一队列（项目忙则排队，空闲则立即执行）。
 *
 * P3 起权威在 `chat_msgs` 表 + `msg` 等待项（`waitq.msgEnqueue` 一个事务双写）。执行体不用
 * 闭包（闭包不可持久化）：`family`/`model` 在提交时定格进等待项 meta，执行时按行＋快照重建
 * （`rebuildRun`，与闭包捕获语义等价）；dsh_plugin 的消息可「立即注入」（`rebuildInject`）。
 *
 * 参数映射（Python → Node，业务参数收成一个对象、末位仍是同一份 `options`）：
 *   `task_id` / `card_id` / `comment_id` / `inject` / `family` / `model` / `extra_meta`
 *   → `taskId` / `cardId` / `commentId` / `inject` / `family` / `model` / `extraMeta`。
 *   `comment_id`：卡片评论投递路径的评论行 id（终态写回 `db.update_board_comment` 用），
 *   随 meta 持久化（chat_msgs 无此列，P3 裁决 R1）。
 *   `extraMeta`：调用方附加载荷（如飞书回流的 `{feishu: {...}}`），键与 family/model/
 *   comment_id **平铺**进同一个 meta；键名由调用方自带命名空间。**覆盖顺序照 Python**：
 *   family/model → comment_id（有值时）→ extraMeta（可覆盖前两者）。
 *   `taskId` 与 `cardId` 同时为空＝纯会话消息（飞书通用对话等）：无任务轮次、无卡片评论
 *   写回，按行重建时走纯会话投递分支。
 * 无 runner 单例（单测/独立脚本）时**同步执行并按原样上抛异常**（保持既有行为，行照常落表、
 * 不写等待项——P5 R13 收口：无拾取方，等待项只会成为孤儿行）；该分支返回终态记录。
 *
 * **async**：无 runner 分支要 await 投递与等 turn（Python 是阻塞线程）。
 *
 * @param {number} projectId
 * @param {string} sid 会话 id
 * @param {string} message 消息原文
 * @param {{taskId?: number|null, cardId?: number|null, commentId?: number|null,
 *          inject?: boolean, family?: string, model?: string, extraMeta?: object|null,
 *          db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{id: string, state: string, queued: boolean}>}
 * @throws {DeliveryRefused} 外部会话前置闸拒投（消息**未落行**）
 */
export async function submit(projectId, sid, message, options = {}) {
  const {
    taskId = null, cardId = null, commentId = null, inject = false,
    family = '', model = '', extraMeta = null,
  } = options;
  externalPreflight(sid, options);          // 首行前置闸：外部会话未获许可即拒投（不落行）
  const msgId = newMsgId();
  wq('msgPrune')(MSG_KEEP_SEC, MSG_MAX, options);   // 终态回收（msg_prune 表版，R8）
  const inst = runnerInstance();
  const payloadMeta = {
    family,
    model,
    ...(commentId ? { comment_id: commentId } : {}),
    ...(extraMeta || {}),
  };
  wq('msgEnqueue')(msgId, projectId, sid, message, taskId, cardId, Boolean(inject),
    payloadMeta, inst !== null, options);
  if (inst === null) {
    // 无统一队列：同步执行（异常上抛）；消息行照常落表、不写等待项（P5 R13）。
    // 载荷不经等待行重建——提交参数直传（与 Python `_rebuild_run(msg_id, meta=payload_meta)` 同）。
    if (!wq('msgClaim')(msgId, options)) {
      return { id: msgId, state: STATE_QUEUED, queued: false };
    }
    let res;
    try {
      res = await rebuildRun(msgId, payloadMeta, options)();
    } catch (err) {
      // error 落行（⑧）+ 随异常上抛给端点
      wq('msgFinish')(msgId, STATE_ERROR, errText(err).slice(0, 300), options);
      throw err;
    }
    const final = res === STATE_YIELDED ? STATE_YIELDED : STATE_DONE;
    wq('msgFinish')(msgId, final, '', options);
    return { id: msgId, state: final, queued: false };
  }
  // 提交时项目已被占用 ⇒ 本消息必然排队（前台据此显示「排队中」）
  const queued = projectBusy(projectId, options);
  inst.submitMsg(msgId, projectId, sid);
  return { id: msgId, state: STATE_QUEUED, queued };
}

/**
 * 项目是否忙（Python `Runner.unit_busy(project_id)`）：M3 起 `runner.js` 已把它实现为
 * **模块级纯表读**（其文件头写明它就是 `chat.submit` 的 queued 字段数据源），故优先用它；
 * 退回实例方法只作兼容（旧的/自定义 runner 单例）。
 *
 * @param {number} projectId
 * @param {object} options
 * @returns {boolean}
 */
function projectBusy(projectId, options) {
  if (typeof runnerMod.unitBusy === 'function') {
    return Boolean(runnerMod.unitBusy(projectId, options));
  }
  const inst = runnerInstance();
  if (inst !== null && typeof inst.unitBusy === 'function') {
    return Boolean(inst.unitBusy(projectId));
  }
  return false;
}

// --------------------------------------------------------------------------
// 执行体重建（chat.py:217-290）
// --------------------------------------------------------------------------

/**
 * 执行体重建的公共载荷（消息行 / 等待项 meta / 项目行）。**同步**（不许 await）。
 *
 * `family`/`model` 为提交时快照（裁决 R2，与闭包捕获等价）；`project` 行执行时现读
 * （与任务轮次同口径）；项目缺失抛错（落消息 error，文案与 Python 逐字同）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{row: object, meta: object, project: object}}
 */
export function msgPayload(msgId, options = {}) {
  const row = waitq.msgGet(msgId, options);
  if (row === null) throw new Error('消息行不存在');
  const meta = parseMeta(waitq.getActive(waitq.KIND_MSG, msgId, options));
  const project = getProject(row.project_id, options);
  if (project === null || project === undefined) throw new Error('项目不存在');
  return { row, meta, project };
}

/**
 * 按行重建消息执行体（P3：闭包改按 kind 分派——设计 §5.3/§6.2）。
 *
 * 三条分支（顺序照 Python）：
 *   ① 纯会话消息（task_id 与 card_id 皆空，如飞书通用对话）→ `sendNow`（合成 task dict 只为
 *      沿用既有调用形状：单族世界里 `sendNow` 只做族校验与 dsh 分派，不消费其中的 id/model）；
 *   ② 任务侧消息（task_id 非空）→ `sendNow`（合成 task dict 同上）；
 *   ③ 卡片评论（card_id 非空）→ `board._deliver_unit`（合成 card/comment dict，执行体只消费
 *      id/session_id/model 与 comment id）——**M5 未接线即抛**（文件头 M5 缝②）。
 * `meta`：调用方已有载荷时直接给定（P5 R13 同步路径不写等待项，提交时定格的 family/model
 * 无行可重建，由 `submit` 透传；缺省读等待项行）。**载荷读取同步发生**（与 Python 的
 * `row, _meta, project = _msg_payload(msg_id)` 同一时序），返回的 thunk 才是 async。
 *
 * @param {string} msgId
 * @param {object|null} [meta]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {() => Promise<string|null>}
 */
export function rebuildRun(msgId, meta = null, options = {}) {
  const { row, meta: rowMeta, project } = msgPayload(msgId, options);
  const useMeta = meta === null || meta === undefined ? rowMeta : meta;
  if (row.task_id === null && row.card_id === null) {
    return async () => sendNow({ id: null, model: useMeta.model || '' }, project,
      useMeta.family || '', row.sid, row.message, Boolean(row.inject), options);
  }
  if (row.task_id !== null) {
    const task = { id: row.task_id, model: useMeta.model || '' };
    return async () => sendNow(task, project, useMeta.family || '', row.sid,
      row.message, Boolean(row.inject), options);
  }
  const card = { id: row.card_id, session_id: row.sid, model: useMeta.model || '' };
  const comment = { id: useMeta.comment_id || 0 };
  return async () => {
    const bridge = BOARD_BRIDGE;
    if (bridge === null || typeof bridge.deliverUnit !== 'function') {
      throw new Error(CARD_BRIDGE_MISSING);
    }
    return bridge.deliverUnit(project, card, comment, row.message, Boolean(row.inject), options);
  };
}

/**
 * 「立即注入」投递体重建（与 `rebuildRun` 同载荷源，chat.py:273-290）：
 *   ① 纯会话消息（task_id 与 card_id 皆空）→ `injectSend`（steer 注入当前 turn，投递后即
 *      返回，不落卡片）；② 任务侧 → `injectSend`（同上，带任务 id）；
 *   ③ 卡片评论 → `board._deliver_now(inject=True)`——**M5 未接线即抛**（文件头 M5 缝③）。
 * 族不支持由 `injectNow` 前置拦截（读 meta.family）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {() => Promise<void>}
 */
export function rebuildInject(msgId, options = {}) {
  const { row, meta, project } = msgPayload(msgId, options);
  if (row.task_id === null && row.card_id === null) {
    return async () => injectSend(project, row.sid, null, row.message, meta.model || '', options);
  }
  if (row.task_id !== null) {
    return async () => injectSend(project, row.sid, row.task_id, row.message,
      meta.model || '', options);
  }
  const card = { id: row.card_id, session_id: row.sid, model: meta.model || '' };
  const comment = { id: meta.comment_id || 0 };
  return async () => {
    const bridge = BOARD_BRIDGE;
    if (bridge === null || typeof bridge.deliverNow !== 'function') {
      throw new Error(CARD_BRIDGE_MISSING);
    }
    return bridge.deliverNow(project, card, comment, row.message, true, options);
  };
}

/**
 * 注册/注销（`fn=null`）消息单元终态钩子；回调异常由 `fireMsgDone` 吞掉。
 *
 * 单一注册位（后注册覆盖先注册）：注册方是 `feishu_conv.start`（server.main 经
 * `feishu.start_notifier` 调用一次）。未注册时 `runUnit` 行为与加钩子前逐字等价。
 *
 * @param {((msgId: string, state: string) => any)|null} fn
 */
export function setMsgDoneHook(fn) {
  MSG_DONE_HOOK = fn === undefined ? null : fn;
}

/**
 * 触发消息单元终态钩子（done/yielded/error 各一次）；**异常绝不影响队列收口**。
 *
 * 钩子是旁路（飞书回流的答复推送）：它跑在**终态记录已落库之后**，自身抛错（推送失败、
 * 会话读失败等）只留痕——队列收口与钩子成败解耦。
 * Node 增补（文件头差异⑥）：钩子返回 thenable 时补一个 `.catch` 留痕（Python 的同步钩子
 * 没有这个形态，而未处理的 Promise 拒绝在 Node 会杀进程）。
 *
 * @param {string} msgId
 * @param {string} state
 */
export function fireMsgDone(msgId, state) {
  const fn = MSG_DONE_HOOK;
  if (fn === null || fn === undefined) return;
  try {
    const ret = fn(msgId, state);
    if (ret !== null && ret !== undefined && typeof ret.then === 'function') {
      Promise.resolve(ret).catch((err) => {
        console.log(`[chat] 终态钩子异常: ${msgId}: ${errText(err)}`);
      });
    }
  } catch (err) {
    console.log(`[chat] 终态钩子异常: ${msgId}: ${errText(err)}`);
  }
}

// --------------------------------------------------------------------------
// 统一队列执行体（chat.py:321-378）
// --------------------------------------------------------------------------

/**
 * 统一队列执行体（runner worker 调用）：执行一条待跑消息；**异常落记录不抛出**。
 *
 * P3：状态权威在 `chat_msgs`——`msgClaim` 原子 queued→running（与 `injectNow` 的
 * `waitq.claim` 互斥互补：等待项被取消/被注入抢先时此处让行）；执行体按行＋快照重建；
 * 终态 done/yielded/error 落表，等待项行终态在同函数闭环（裁决 R6）。yielded＝挂起让位：
 * turn 等用户作答，运行位即行——行终态即释放，队首单元照常起跑。三条终态路各触发一次
 * `fireMsgDone`（done=推答复、yielded=不推、error=推失败回执）。
 *
 * **async，调用方必须 await**（Python 里 runner 在自己的线程里同步调它）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<void>}
 */
export async function runUnit(msgId, options = {}) {
  try {
    const row = waitq.msgGet(msgId, options);
    if (row === null || row.state !== STATE_QUEUED) {
      reapOrphanClaim(msgId, options);   // 竞态窗口 A 收口（P4 必带⑦）
      return;
    }
    if (!wq('msgClaim')(msgId, options)) {
      reapOrphanClaim(msgId, options);   // 竞态窗口 A 收口（P4 必带⑦）
      return;
    }
    let res;
    try {
      res = await rebuildRun(msgId, null, options)();
    } catch (err) {
      const text = errText(err);
      wq('msgFinish')(msgId, STATE_ERROR, text, options);
      wq('finishByTarget')(waitq.KIND_MSG, msgId, waitq.STATE_FAILED, text, options);
      fireMsgDone(msgId, STATE_ERROR);
      return;
    }
    if (res === STATE_YIELDED) {
      console.log(`[chat] 消息单元挂起让位：m:${msgId}（turn 等待作答）`);
      wq('markEvidence')(waitq.KIND_MSG, msgId,
        { desc: '消息投递挂起让位', reason: 'turn 等待作答' }, options);
      wq('msgFinish')(msgId, STATE_YIELDED, '', options);
      wq('finishByTarget')(waitq.KIND_MSG, msgId, waitq.STATE_DONE, '', options);
      fireMsgDone(msgId, STATE_YIELDED);
      return;
    }
    wq('msgFinish')(msgId, STATE_DONE, '', options);
    wq('finishByTarget')(waitq.KIND_MSG, msgId, waitq.STATE_DONE, '', options);
    fireMsgDone(msgId, STATE_DONE);
  } catch (err) {   // 防「线程」拖死（DB 故障等）；行滞留由 selfcheck 兜底
    console.log(`[chat] 消息单元异常: ${msgId}: ${errText(err)}`);
    try {   // 尽力把等待项落 failed（chat_msgs 已不可写时由 selfcheck 兜底）
      wq('finishByTarget')(waitq.KIND_MSG, msgId, waitq.STATE_FAILED,
        errText(err).slice(0, 300), options);
    } catch {
      // 等待项也写不动：留给 selfcheck（与 Python 的空 except 同）
    }
    fireMsgDone(msgId, STATE_ERROR);   // 最外层异常同样只触发一次
  }
}

/**
 * 竞态窗口 A 收口（P4 必带⑦）：早退时若等待项仍挂在「本执行体」名下（`claimed_by=worker`
 * ——排除「立即注入」的 claim，inject-now 路径自行收口），而消息行已不在排队，说明 claim
 * 后、状态迁移前行被并发取消——等待项补终态，防 starting 永挂。窗口 B（inject capture/
 * cancel 交错）由 `waitq.claim` 原子性天然闭合（claim 失败即拒绝），无需代码。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function reapOrphanClaim(msgId, options = {}) {
  const wrow = waitq.getActive(waitq.KIND_MSG, msgId, options);
  if (wrow !== null && wrow.state === waitq.STATE_STARTING && wrow.claimed_by === 'worker') {
    wq('finishByTarget')(waitq.KIND_MSG, msgId, waitq.STATE_FAILED,
      '消息已不在排队中', options);
  }
}

// --------------------------------------------------------------------------
// 取消（chat.py:381-399）
// --------------------------------------------------------------------------

/**
 * 取消排队中的消息（已开始执行的返回 false）。返回是否命中。
 *
 * P3：`chat_msgs` 的 queued→cancelled 原子守卫为仲裁点（R12），等待项权威取消与内存键
 * 摘除随后——与 worker claim 竞态下不双执行、不复活终态行。**同步**。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function cancel(msgId, options = {}) {
  if (!wq('msgCancel')(msgId, '已取消', options)) return false;
  wq('cancel')(waitq.KIND_MSG, msgId, '已取消', null, options);
  const inst = runnerInstance();
  if (inst !== null) inst.removeMsg(msgId);
  return true;
}

/**
 * 取消排队中的消息（按会话 sid 或卡片 id 过滤）；返回取消条数。停止入口共用。
 *
 * 参数映射：Python `cancel_queued(sid=None, card_id=None)` → Node 收一个对象
 * `{sid, cardId}`（多关键字参、且两者语义对称，对象形式避免「谁在前」的调用错误）。
 *
 * @param {{sid?: string|null, cardId?: number|string|null}} [filter]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number}
 */
export function cancelQueued({ sid = null, cardId = null } = {}, options = {}) {
  if (!sid && !cardId) return 0;
  const rows = waitq.msgRows({ sid, cardId, states: [STATE_QUEUED] }, options);
  let count = 0;
  for (const row of rows) {
    if (cancel(row.id, options)) count += 1;
  }
  return count;
}

// --------------------------------------------------------------------------
// 立即注入（chat.py:452-493）
// --------------------------------------------------------------------------

/**
 * 「立即注入」：把平台排队中的消息单元立即投递到目标会话，不再等统一队列。
 *
 * P3：互斥点改为等待项 `waitq.claim` 原子抢占（同 P2「立即送达」模式）——与 worker 的
 * claim 只有一方成功；`chat_msgs` 的 queued→running 由 `msgClaim` 承载状态迁移。抢到后先把
 * 单元从统一队列摘除（`runner.removeMsg`，内存键专用、不碰等待项行）。
 *
 * 被拒（消息不在排队中/不支持注入）抛 `InjectRefused`——消息未动、仍在队列；
 * 投递失败：等待项 `returnToWaiting`（行 id 稳定、seq 不动＝按原位次放回，裁决 R4）+
 * `chat_msgs` 退回 queued，**原样上抛**（端点转 502）；成功返回 undefined（终态 done）。
 *
 * **async**（要 await 投递 thunk）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<void>}
 * @throws {InjectRefused}
 */
export async function injectNow(msgId, options = {}) {
  const row = waitq.msgGet(msgId, options);
  if (row === null) throw new InjectRefused('消息不存在或已回收');
  if (row.state !== STATE_QUEUED) throw new InjectRefused('该消息已不在排队中（可能已开始发送）');
  const wrow = waitq.getActive(waitq.KIND_MSG, msgId, options);
  const meta = parseMeta(wrow);
  if (meta.family !== 'dsh_plugin') throw new InjectRefused('该消息不支持立即注入');
  if (wrow === null || !wq('claim')(wrow.id, 'inject-now', options)) {
    throw new InjectRefused('该消息已不在排队中（可能已开始发送）');
  }
  const inst = runnerInstance();
  if (inst !== null) inst.removeMsg(msgId);   // 出队：唤醒 worker 重挑（权威取消在下行 claim）
  if (!wq('msgClaim')(msgId, options)) {      // 状态迁移（被取消的竞态：放回等待）
    wq('returnToWaiting')(wrow.id, 0.0, false, options);
    throw new InjectRefused('该消息已不在排队中（可能已开始发送）');
  }
  try {
    await rebuildInject(msgId, options)();
  } catch (err) {
    // 投递失败：等待项放回（行 id 稳定、seq 不动＝按原位次放回，meta 随行保留）+ 状态退回
    // 排队——消息不丢，语义与「投递失败仍可在队列里等下一轮」一致；错误由调用方上报
    // 前端 toast（端点 502）
    wq('returnToWaiting')(wrow.id, 0.0, false, options);
    wq('msgRequeue')(msgId, options);
    if (inst !== null) inst.submitMsg(msgId, row.project_id, row.sid);
    throw err;
  }
  wq('msgFinish')(msgId, STATE_DONE, '', options);
  wq('finishByTarget')(waitq.KIND_MSG, msgId, waitq.STATE_DONE, '', options);
}

// --------------------------------------------------------------------------
// 对话登记（chat.py:498-506）
// --------------------------------------------------------------------------

/**
 * 登记对话会话（`_CHATS`）：供 `state` 查询与 `stop` 停止。**同步**。
 *
 * @param {string} sid
 * @param {number|null} taskId
 * @param {string} message 消息原文（记录里截 200 字，照 Python `message[:200]`）
 * @param {{logPath?: string, dshPlugin?: boolean, since?: number|null}} [opts]
 */
export function register(sid, taskId, message, { logPath = '', dshPlugin = false, since = null } = {}) {
  const rec = {
    task_id: taskId,
    started_at: Date.now(),
    // Python `message[:200]` 是**按码点**截断；`.slice` 是 UTF-16 码元（emoji 会提前截半）
    message: [...String(message === null || message === undefined ? '' : message)]
      .slice(0, 200).join(''),
    exit_code: null,
    log_path: logPath,
  };
  if (dshPlugin) {
    // since = 投递前会话 last_seq（等 turn/end 的 SSE 续传起点）
    rec.dsh_plugin = true;
    rec.since = since;
  }
  CHAT_REGISTRY.set(sid, rec);
}

// ══════════════════════════════════════════════════════════════════════════════
// dsh 插件族（路线 A：进程内会话，事件驱动等待）
// ══════════════════════════════════════════════════════════════════════════════

// --------------------------------------------------------------------------
// 投递前预订阅（缺陷 A 修复；chat.py:523-660）
// --------------------------------------------------------------------------
//
// 缺陷（真机 run1–run7，6/6 命中）：外部会话的普通 followup 投递里，`turn/start` 帧到中枢
// 在 +0.072~0.143s，而等待器的 `dshevents.subscribe` 在 +0.084~0.152s ⇒ **帧早到 9~13ms**；
// 全局状态流对进程内订阅者**无回放** ⇒ 该帧永远看不到 ⇒ `started` 恒假 ⇒ 本轮 `turn/end`
// 被丢弃 ⇒ 只能等满 `TURN_START_GRACE`(60s) 收口。有卡路由 `ext:` 行兜住占用（只是状态滞后
// 60s）；**无卡路（任务侧直送 / 飞书绑定会话）会真的提前释放项目运行位**，与仍在跑的外部
// turn 并发改同一工作区 ⇒ 违「任务按项目串行」红线。
//
// 修法：把「订阅 + 帧队列」抽成 `TurnSubscription`，`dshSend` 在**投递之前**先建订阅并放进
// 旁表 `DSH_SUB`（与 `DSH_BASELINE`/`DSH_INJECT` 同款「投递时记、等待时取走即弃」）；
// `dshWaitTurnViaEvents` 优先取走预订阅，取不到再退回「现订阅」（老行为）。硬约束：
//   ① 只对会走事件流路的那一档建（`dshevents.get(sid).owned === false`）：池内/未知的投递
//      零改动、零多余订阅（池内等待器 `dshWaitTurn` 根本不读这张旁表）；
//   ② 不等待的投递不留悬挂订阅：旁表有界（`DSH_SUB_MAX` + TTL 惰性过期 `DSH_SUB_TTL`），
//      出表/取走/投递抛异常一律 `dshevents.unsubscribe`（回调常驻中枢消费者列表，泄漏会让
//      每次状态帧都白调一次）；
//   ③ 帧队列**只收本 sid 的帧**（状态帧低频 ⇒ 无人取走的队列也有界），等待器里的 sid 过滤照旧；
//   ④ **不拿 `status == "running"` 无条件播种 `started`**（I1 安全阀不许写宽）。

/**
 * 一次性帧口袋的内部队列：`put` 同步入队/唤醒等待者，`getNowait` 立即取，
 * `get(timeoutMs)` 到期 resolve `null`（对应 Python 的 `queue.Empty`）。
 *
 * Node 不能阻塞事件循环，故 Python `queue.Queue.get(timeout=…)` 的对应物是「等待者集合 +
 * 定时器」的 Promise。帧一定是对象，故 `null` 作「空」哨兵是安全的。
 */
class FrameQueue {
  constructor() {
    this._items = [];
    this._waiters = [];
  }

  /** 入队（有挂起的取者则直接交棒，不入队） */
  put(item) {
    const waiter = this._waiters.shift();
    if (waiter !== undefined) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.resolve(item);
      return;
    }
    this._items.push(item);
  }

  /** 立即取一帧（无则 null，对应 Python `get_nowait()` 的 `queue.Empty`） */
  getNowait() {
    return this._items.length ? this._items.shift() : null;
  }

  /**
   * 等一帧（超时 resolve null）。
   * @param {number} timeoutMs
   * @returns {Promise<object|null>}
   */
  get(timeoutMs) {
    if (this._items.length) return Promise.resolve(this._items.shift());
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0) this._waiters.splice(idx, 1);
        resolve(null);
      }, Math.max(0, timeoutMs));
      this._waiters.push(waiter);
    });
  }
}

/**
 * 投递前建立的一次性全局状态流订阅：本 sid 的帧 → 队列。
 *
 * 一个实例＝一次投递的「帧口袋」：`dshSend` 建它（`dshSubOpen`）→ `dshWaitTurnViaEvents`
 * 取走并当帧队列用（`dshSubTake`）→ 等待器 `finally` 或回收路径 `close()`（退订，幂等）。
 * 取不到预订阅时等待器自建同款实例（老行为）。
 */
export class TurnSubscription {
  /** @param {string} sid */
  constructor(sid) {
    this.sid = String(sid === null || sid === undefined ? '' : sid);
    /** 回调（事件消费侧）→ 等待器（本函数）的交接口 */
    this.frames = new FrameQueue();
    /** 建订阅时刻（秒，对齐 Python `time.time()`）——TTL/超限回收的排序键 */
    this.created = Date.now() / 1000;
    this._closed = false;
    // 回调存成**对象同一性稳定**的引用：订阅与退订必须传同一个对象（`dshevents.unsubscribe`
    // 按 `indexOf` 同一性摘除；每次属性访问都会新建 bound method，故存一次，两个方向都稳）
    this._cb = (frame) => this.onFrame(frame);
  }

  /**
   * 中枢订阅回调：只收本 sid 的帧并入队。
   *
   * 契约要求短小（跑在事件消费回调里）：这里只做一次字符串比较 + `put`。按 sid 过滤让
   * 「无人取走的预订阅」队列也保持有界——状态帧是低频事件。
   *
   * @param {object} frame
   */
  onFrame(frame) {
    if (this._closed) return;
    if (String((frame || {}).session_id || '') !== this.sid) return;
    this.frames.put(frame);
  }

  /** 退订（幂等）：回调必须从中枢订阅者列表里摘掉，否则常驻泄漏 */
  close() {
    if (this._closed) return;
    this._closed = true;
    dshevents.unsubscribe(this._cb);
  }
}

/** sid -> `TurnSubscription`（投递时建、等待时取走即弃；`_DSH_SUB`） */
export const DSH_SUB = new Map();

/**
 * 旁表惰性回收（Python `_dsh_sub_reap_locked`）：过 TTL 与超条数上限的条目出表。
 *
 * 返回**待退订**列表（出表后再 `close()`）：Python 侧注释说「`close()` 要拿中枢的订阅锁，
 * 不在本锁内做」；Node 单事件循环下没有锁可持（凑巧与 Python 的结论一致：先出表、再退订），
 * 保留同样的两段式形态以免日后加锁时踩坑。
 *
 * @returns {TurnSubscription[]}
 */
export function dshSubReap() {
  const now = Date.now() / 1000;
  const stale = [];
  for (const [sid, sub] of [...DSH_SUB.entries()]) {
    if (now - sub.created > DSH_SUB_TTL) {
      DSH_SUB.delete(sid);
      stale.push(sub);
    }
  }
  const over = DSH_SUB.size - DSH_SUB_MAX;
  if (over > 0) {
    // 超限：按建订阅时刻从旧到新回收（同一时刻大量投递时也收敛回上限之内）；
    // Array.prototype.sort 自 ES2019 起稳定 ⇒ 同刻条目保持插入序（与 Python sorted 同）
    const oldest = [...DSH_SUB.entries()]
      .sort((a, b) => a[1].created - b[1].created)
      .slice(0, over);
    for (const [sid, sub] of oldest) {
      DSH_SUB.delete(sid);
      stale.push(sub);
    }
  }
  return stale;
}

/**
 * 投递**之前**建预订阅并放进旁表；返回该订阅（同 sid 的旧订阅覆盖即退订）。
 *
 * 只应由 `dshSend` 在「会话是外部（`owned === false`）」时调用——那是 `waitTurn` 会分流到
 * 事件流路、等待器会取用它的唯一一档。
 *
 * @param {string} sid
 * @returns {TurnSubscription}
 */
export function dshSubOpen(sid) {
  const sub = new TurnSubscription(sid);
  dshevents.subscribe(sub._cb);
  const old = DSH_SUB.get(sub.sid);
  DSH_SUB.set(sub.sid, sub);
  // 入表**之后**回收：条数上限对「当前表」恒成立（新订阅 created 最新，不会被本次摘掉）
  const stale = dshSubReap();
  for (const item of stale) item.close();      // 过期/超限的旧订阅：真退订
  if (old !== undefined) old.close();          // 同 sid 上一次没被取走的预订阅：回收
  return sub;
}

/**
 * 取走该 sid 的预订阅（无则 null）：取走即从旁表删除。
 *
 * 退订责任随之转移给调用方（等待器在 `finally` 里 `close()`）——旁表只负责「投递到取走」
 * 这段短窗口内的保管，取走即弃与 `DSH_BASELINE` 同款语义。
 *
 * @param {string} sid
 * @returns {TurnSubscription|null}
 */
export function dshSubTake(sid) {
  const stale = dshSubReap();
  const key = String(sid === null || sid === undefined ? '' : sid);
  const sub = DSH_SUB.get(key);
  if (sub !== undefined) DSH_SUB.delete(key);
  for (const item of stale) item.close();
  return sub === undefined ? null : sub;
}

/**
 * 按对象回收一个预订阅（投递失败路径）：仅当旁表里仍是它才删，随后退订。
 * @param {TurnSubscription|null} sub
 */
export function dshSubDrop(sub) {
  if (sub === null || sub === undefined) return;
  if (DSH_SUB.get(sub.sid) === sub) DSH_SUB.delete(sub.sid);
  sub.close();
}

// --------------------------------------------------------------------------
// 宿主会话存活兜底（修卡 934；chat.py:675-734）
// --------------------------------------------------------------------------
//
// 现场：dsh 会话活在宿主进程内，插件**热重载 / 宿主重启**会把所有会话 dispose 掉——真机
// 实证两张卡的会话同时落 `turn/end {kind:"aborted", reason:{kind:"disposed"}}`。平台侧
// 卡片/任务的 `session_id` 仍在库、卡照旧在列，用户再发评论 / 点「立即注入」时驱动回 404
// 「会话不在驱动池中」（用户无从判断该怎么办）。
//
// 判据与调和器「会话确已结束」同源：`dshevents.aligned()`（中枢可信）∧ 注册表里没有这个
// sid ⇒ 宿主确实不再持有它。此时按平台既有「有 sid 就 resume」的语义把会话接回池内，再走
// 原投递。未知（未对齐 / 断连）一律不动：未知 ≠ 已失去，零请求、既有行为一个字节不变。

/**
 * 接回总开关（回滚阀）：`TS_HOST_SESSION_REVIVE=0` ⇒ 不接回，退回修复前行为。
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function hostReviveEnabled({ env = process.env } = {}) {
  return String(env[HOST_REVIVE_ENV] || '').trim() !== '0';
}

/**
 * 宿主是否**确已**不再持有该会话（可信快照 ∧ 注册表无此 sid）。
 *
 * 两个条件是「确已」的全部证据：`aligned()` 为假（中枢断连 / 热重载后快照未对齐）时注册表
 * 本就不可信，读不到 sid 只代表**未知**——按全局不变量「未知 ≠ 已结束」，一律返回 false
 * （调用方不动）。读口异常同样按未知处理。**同步**。
 *
 * @param {string} sid
 * @returns {boolean}
 */
export function hostSessionLost(sid) {
  if (!sid) return false;
  try {
    if (!dshevents.aligned()) return false;
    return dshevents.get(sid) === null;
  } catch {
    return false;                 // 读口异常按未知，不阻断投递
  }
}

/**
 * 把「宿主已失去」的会话按既有 resume 语义接回；返回是否**可以投递**。
 *
 * true：会话本来就在宿主里（零请求），或刚被成功接回，或回滚阀关闭（退回旧行为，失败仍由
 * 驱动 404 兜底）。false：确已失去且接不回（会话文件不存在 / 驱动不可达 / 令牌错）——调用方
 * 据此给用户明确文案，而不再发一次必然 404 的投递。
 * `cwd`/`task` 只在真接回时下传（前者对齐 `board.card_workspace`：worktree 卡；后者是驱动侧
 * 的会话标签，与 `_start_web` 同形）。
 *
 * **async**（`resumeSession` 是驱动调用）。
 *
 * @param {string} sid
 * @param {string} [cwd]
 * @param {string} [task]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<boolean>}
 */
export async function reviveHostSession(sid, cwd = '', task = '', options = {}) {
  if (!hostReviveEnabled(options) || !hostSessionLost(sid)) return true;
  try {
    // Python `resume_session(sid, cwd=cwd, task=task)`；Node 形参序为 (sid, task, cwd)
    await driverResumeSession(sid, task, cwd);
  } catch (err) {
    if (err && err.name === 'DshDriverError') {
      console.log(`[chat] 会话接回失败 sid=${sid}: ${errText(err)}`);
      return false;
    }
    throw err;
  }
  console.log(`[chat] 宿主已失去会话，按 resume 接回：sid=${sid}`
    + `（cwd=${cwd || '-'} task=${task || '-'}）`);
  return true;
}

// --------------------------------------------------------------------------
// 投递（chat.py:737-794）
// --------------------------------------------------------------------------

/**
 * 投递基线 seq（等 turn/end 的起点）：驱动 `/status` 拿不到就回落中枢注册表。
 *
 * 判据是「**拿不到** `last_seq`」而不是「`/status` 抛错」：T2 落地后，watched + 活 agent 的
 * 外部会话 `/status` 由 `_externalTarget` 干跑后按外部形状回 200，响应里**刻意没有**
 * `last_seq`——只 catch 异常会让回落分支永不触发、`since` 恒 0（等轮次会把基线之前的历史帧
 * 当成本轮）。两个来源按「先权威后本地」取：
 *   ① 驱动 `/status`（池内会话的权威口径，一次读，不是轮询）；
 *   ② `dshevents.get(sid).last_seq`（中枢已折好的**本地**值，零请求；外部会话/驱动不可达用它）。
 * 两者都取不到返回 0（保持既有「无基线」语义）。**async**。
 *
 * @param {string} sid
 * @returns {Promise<number>}
 */
export async function dshBaselineSince(sid) {
  let seq = null;
  try {
    const st = await driverStatus(sid);
    seq = (st || {}).last_seq;                 // 宽容读：见文件头差异②
  } catch (err) {
    if (err && err.name === 'DshDriverError') seq = null;
    else throw err;
  }
  if (seq === null || seq === undefined) {
    seq = (dshevents.get(sid) || {}).last_seq;
  }
  return toIntSeq(seq);
}

/**
 * dsh 插件族投递（chat 与 board 共用）：记基线 → prompt / steer → 返回基线 seq。
 *
 * 投递语义：dsh 的 `followup` 在会话忙时排进 agent inbox（服务端排队），`steer` 则注入当前
 * turn 的最近 step 边界——平台的「发送 / 立即注入」两种语义因此一一对应，无需子进程。
 * 异常抛 `DshDriverError` 由调用方处置。基线来源见 `dshBaselineSince`（外部会话没有
 * `last_seq` ⇒ 回落中枢）。投递的同时把「本次是否 steer」记进旁表 `DSH_INJECT`（I1）：
 * 外部会话的等待器据此决定要不要按「已在跑的 turn」播种 `started`。
 * **投递前预订阅（缺陷 A 修复）**：外部会话先建 `TurnSubscription` 放进 `DSH_SUB`
 * ——`turn/start` 帧可能在 `POST` 返回前后几毫秒到达，等投递返回再订阅就永远看不到；
 * 投递失败当场回收该预订阅。**async**。
 *
 * @param {string} sid
 * @param {string} message
 * @param {boolean} [inject]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<number>} 投递基线 seq
 */
export async function dshSend(sid, message, inject = false, options = {}) {
  if (!sid) throw new DshDriverError(-1, '会话 id 为空，无法投递');
  // 外部会话（`owned === false`）＝ `waitTurn` 会分流到事件流路的那一档：投递前先订阅；
  // 池内/未知不建（池内等待器不读它）。
  let sub = null;
  if ((dshevents.get(sid) || {}).owned === false) sub = dshSubOpen(sid);
  let since;
  try {
    since = await dshBaselineSince(sid);
    if (inject) await driverSteer(sid, message);
    else await driverPrompt(sid, message);
  } catch (err) {
    // 投递失败：预订阅无人会取走，当场回收（不留悬挂订阅）
    dshSubDrop(sub);
    throw err;
  }
  DSH_BASELINE.set(sid, since);
  DSH_INJECT.set(sid, Boolean(inject));   // I1：true/false 都写（覆盖上一次投递的旧值）
  return since;
}

// --------------------------------------------------------------------------
// 等 turn 结束（chat.py:797-1013）
// --------------------------------------------------------------------------

/**
 * 等 turn 结束的总时限（秒）：常量默认 + 环境变量覆盖（非法/非正值回落常量）。
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {number}
 */
export function dshWaitTurnLimit({ env = process.env } = {}) {
  const raw = String(env[DSH_WAIT_TURN_TIMEOUT_ENV] || '').trim();
  if (raw) {
    const val = pyFloatOr(raw, 0);
    if (val > 0) return val;         // NaN/Infinity 的判据与 Python `val > 0` 同（Infinity 合法）
  }
  return DSH_WAIT_TURN_TIMEOUT;
}

/**
 * 写「等待 turn 结束超时」留痕：会话日志 + 平台日志（插件形态落 plugin-backend.log）。
 *
 * 断连与总时限两条收口共用同一行文案（不变量：断连也必须按**超时口径**收口并留痕，绝不判
 * 「正常结束」）；`detail` 只补原因，便于事后区分是哪条收口。`appendLog` 对空/不可写路径
 * 静默跳过（既有语义），故再打一行平台日志兜底——外部卡片投递可能没有 `CHAT_REGISTRY`
 * 记录（`logPath` 为空），此时留痕不能丢。
 *
 * @param {string} logPath
 * @param {string} detail
 */
function logWaitTimeout(logPath, detail) {
  const line = `### 会话等待 turn 结束超时（${detail}）`;
  appendLog(logPath, `${line}\n`);
  console.log(`[chat] ${line}（日志: ${logPath || '无'}）`);
}

/**
 * 等 dsh 会话一次 turn 结束（事件驱动，零远端轮询）。
 *
 * 返回 null（turn 正常/异常/超时收口）或 STATE_YIELDED（turn 挂起等作答，让出运行位）。
 * `since` 缺省取本次投递记录的基线；基线丢失（进程重启等）时退回读当前 `last_seq`。
 * `logPath`：超时原因行的落点（缺省取本会话对话日志 `CHAT_REGISTRY[sid].log_path`）。
 * P7a 缺陷 G：整轮等待带**总时限**（`DSH_WAIT_TURN_TIMEOUT`，环境变量可覆盖）——链路保活
 * 正常但服务端不推 `turn/end` 时不再永久挂起；到点写一行
 * `### 会话等待 turn 结束超时（N s 无 turn/end）` 并按「本轮结束」返回 null，消息单元据此
 * 收口（m: 行 done、项目运行位释放、补位继续）。**async，调用方必须 await**。
 *
 * @param {string} sid
 * @param {number|null} [since]
 * @param {boolean} [yieldOnInteraction]
 * @param {string} [logPath]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>}
 */
export async function dshWaitTurn(sid, since = null, yieldOnInteraction = true, logPath = '',
  options = {}) {
  if (since === null || since === undefined) {
    const base = DSH_BASELINE.get(sid);
    DSH_BASELINE.delete(sid);                 // 取走即弃
    if (base !== undefined) since = base;
  }
  if (since === null || since === undefined) {
    try {
      const st = await driverStatus(sid);
      since = toIntSeq((st || {}).last_seq);
    } catch (err) {
      if (err && err.name === 'DshDriverError') return null;
      throw err;
    }
  }
  if (!logPath) {
    const rec = CHAT_REGISTRY.get(sid);
    logPath = (rec || {}).log_path || '';
  }
  const limit = dshWaitTurnLimit(options);
  const waiter = new TurnWaiter();
  let stopRequested = false;
  const stop = () => stopRequested;
  // feedInto 自带兜底（链路异常 → waiter.fail，返回 null）；这里只防「万一 reject」变成
  // 未处理拒绝（Python 的守护线程没有这个形态，属 Node 必需的兜底）
  const feeding = driverFeedInto(sid, since, waiter, stop);
  if (feeding !== null && feeding !== undefined && typeof feeding.catch === 'function') {
    feeding.catch(() => { /* 收尾竞态：等待器已有 fail 通道 */ });
  }
  const startedMs = Date.now();
  const deadlineMs = startedMs + limit * 1000;
  try {
    for (;;) {
      // 等待窗口 = min(轮询节拍, 距总时限剩余)：既保留 TICK 节拍（未启动宽限的本地检查点），
      // 又让总时限到点即返回（不再多等一个 TICK）
      const now = Date.now();
      const windowMs = Math.max(50, Math.min(TICK * 1000, deadlineMs - now));
      const event = await waiter.wait(windowMs);
      if (event === 'turn_end') return null;
      if (Date.now() >= deadlineMs) {
        // 总时限兜底：写清原因后按「本轮结束」返回，绝不把行永远钉在执行态
        //（logPath 为空时 appendLog 静默跳过，不影响收口）
        appendLog(logPath, `### 会话等待 turn 结束超时（${pyG(limit)}s 无 turn/end）\n`);
        return null;
      }
      if (event === 'interaction') {
        if (yieldOnInteraction) return STATE_YIELDED;   // 已送达；挂起让位（运行位即释放）
        continue;
      }
      if (event === 'error') return null;
      if (!waiter.started && Date.now() - startedMs > TURN_START_GRACE * 1000) {
        return null;                            // turn 未启动：不占着项目位
      }
    }
  } finally {
    stopRequested = true;
  }
}

/**
 * 等 dsh 会话一次 turn 结束——**全局状态流版**（外部会话专用，C 批 T6）。
 *
 * 与 `dshWaitTurn`（按会话 SSE）的分工：外部会话不在驱动池中，`/events?session_id=` 与
 * `/status` 同属池内门禁（404）⇒ 按会话 SSE 一帧都收不到，旧实现随即按「本轮结束」返回
 * （把「读不到」误判成功）。这里改订阅插件的**全局状态流**（`dshevents`：插件对每个会话都发
 * `turn/start`/`turn/end`/`driver/interaction`），平台侧**零请求**——等待只是从进程内队列取帧，
 * 加上每 `TICK` 一次的本地判定（不是远端状态轮询）。
 *
 * 返回 null（本轮结束/超时/断连收口）或 STATE_YIELDED（挂起等作答，让出运行位）。
 * `since`：本轮起点 seq（缺省先取本次投递基线 `DSH_BASELINE`，再回落中枢 `last_seq`）——只用于
 * 过滤 `turn/start`（`event_seq > since` 才算「本轮起来了」），避免上一轮遗留的 turn/start 被
 * 误当本轮。**帧口袋优先用投递前的预订阅**（缺陷 A）：取不到退回「现订阅」（窗口只是收窄）。
 * **举证责任在订阅**：`started` 的判定阶梯一个字未改（不许无条件按 `status=='running'` 播种）。
 * 判定阶梯（顺序即优先级）：
 *   ⓪ steer 注入「已在跑的 turn」按已在跑播种 `started`（I1，两个条件缺一不可）；
 *   ① 本 sid `turn/start` 且 `data.event_seq > since` ⇒ 记 started；
 *   ② started 且本 sid `turn/end` ⇒ 返回 null（本轮结束）；
 *   ③ 本 sid `driver/interaction{state:'asked'}` ⇒ STATE_YIELDED（让位）；
 *   ④ 中枢断连（`dshevents.connected()` 为假）⇒ 超时行留痕 + 返回 null（断连=未知：绝不判
 *      「正常结束」，也绝不把项目运行位钉死）；
 *   ⑤ 到 `dshWaitTurnLimit()` 总时限 ⇒ 同款超时行 + 返回 null；
 *   ⑥ started 为假且超 `TURN_START_GRACE` ⇒ 返回 null（turn 压根没起来，不占位）。
 *
 * @param {string} sid
 * @param {number|null} [since]
 * @param {string} [logPath]
 * @param {boolean} [yieldOnInteraction]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>}
 */
export async function dshWaitTurnViaEvents(sid, since = null, logPath = '',
  yieldOnInteraction = true, options = {}) {
  if (!sid) return null;
  if (since === null || since === undefined) {
    const base = DSH_BASELINE.get(sid);
    DSH_BASELINE.delete(sid);                 // 本次投递记下的基线（取走即弃）
    if (base !== undefined) since = base;
  }
  const injectedRaw = DSH_INJECT.get(sid);
  DSH_INJECT.delete(sid);                     // 本次投递是否 steer（同上取走即弃）
  const injected = Boolean(injectedRaw);
  if (since === null || since === undefined) {
    since = (dshevents.get(sid) || {}).last_seq;
  }
  since = toIntSeq(since);
  if (!logPath) {
    const rec = CHAT_REGISTRY.get(sid);
    logPath = (rec || {}).log_path || '';
  }
  const limit = dshWaitTurnLimit(options);
  const t0 = Date.now();
  const deadlineMs = t0 + limit * 1000;
  // —— I1：steer 注入「已在跑的 turn」按已在跑播种 started ——
  // 两个条件**缺一不可**：① `injected`（本次投递是 steer，`dshSend` 记下的已知事实）；
  // ② 入口本地读一次中枢注册表，实况 `status === "running"`（零请求，不是轮询）。
  // 为什么需要：steer 的目标是**已经在跑的** turn，它的 `turn/start` 帧早于本订阅
  //（全局状态流对进程内订阅者无回放），而 `since`（外部会话取中枢 `last_seq`）恒 ≥ 该
  // turn/start 的 `event_seq` ⇒ 过滤条件 `seq > since` 恒假 ⇒ `started` 恒假 ⇒ 本轮
  // `turn/end` 被丢弃，只能等满 TURN_START_GRACE(60s)：`m:` 行落 done、项目运行位提前释放，
  // 而外部 turn 仍在跑 ⇒ 下一个排队单元与它**并发写同一工作区**（违「任务按项目串行」红线）。
  // 为什么不能无条件读 `status=='running'` 当初值：followup 排在正在跑的**旧** turn 之后时
  //（消息已进 agent inbox、本轮尚未 turn/start），旧 turn 的 `turn/end` 会被误判成本轮结束。
  let started = injected && (dshevents.get(sid) || {}).status === 'running';
  // —— 帧口袋（缺陷 A）：优先取投递前的预订阅，取不到再自建（老行为）——
  let sub = dshSubTake(sid);
  if (sub === null) {
    sub = new TurnSubscription(sid);
    dshevents.subscribe(sub._cb);
  }
  const inbox = sub.frames;

  /**
   * 处理一帧：返回结论（null / 'turn_end' / 'interaction'），必要时推进 started。
   * 只认本 sid 的帧（全局流上混着所有会话的帧）；跨会话帧直接忽略。
   *
   * @param {object} frame
   * @returns {string|null}
   */
  const consume = (frame) => {
    if (String((frame || {}).session_id || '') !== sid) return null;
    const typ = String((frame || {}).type || '');
    const data = (frame || {}).data || {};
    if (typ === 'turn/start') {
      const seq = data.event_seq;
      if (Number.isInteger(seq) && seq > since) started = true;
      return null;
    }
    if (typ === 'turn/end') {
      // started 是「本轮起来了」的闩：started 之前到达的 turn/end 属于上一轮（投递排队/
      // 在途时的遗留帧），不能当成本轮结束。started 有两个来源：① 本函数按 turn/start
      //（seq > since）置真；② 入口按 I1 播种（steer 注入已在跑的 turn）。
      return started ? 'turn_end' : null;
    }
    if (typ === 'driver/interaction' && String(data.state || '') === 'asked') {
      if (yieldOnInteraction) return 'interaction';
      // 不让位时继续等：提问意味着 turn 已在跑（同 TurnWaiter.feed 口径）
      started = true;
    }
    return null;
  };

  try {
    for (;;) {
      let frame = inbox.getNowait();
      if (frame === null) {
        // 队列已取空：做一轮本地判定（链路/时限/宽限），再按节拍阻塞等帧
        const now = Date.now();
        if (!dshevents.connected()) {
          logWaitTimeout(logPath, `状态流断连：${pyG((now - t0) / 1000)}s 无 turn/end`);
          return null;
        }
        if (now >= deadlineMs) {
          logWaitTimeout(logPath, `${pyG(limit)}s 无 turn/end`);
          return null;
        }
        if (!started && now - t0 > TURN_START_GRACE * 1000) {
          return null;                  // turn 未启动：不占着项目位
        }
        // 阻塞等下一帧：窗口 = min(节拍, 距总时限余量, 未起轮时的启动宽限余量)
        // ——让宽限/时限到点即判定，不被 TICK 推迟（TICK 可被环境放大）
        let windowMs = Math.min(TICK * 1000, deadlineMs - now);
        if (!started) windowMs = Math.min(windowMs, TURN_START_GRACE * 1000 - (now - t0));
        frame = await inbox.get(Math.max(50, windowMs));
        if (frame === null) continue;   // 等价 Python `queue.Empty: continue`
      }
      const verdict = consume(frame);
      if (verdict === 'turn_end') return null;
      if (verdict === 'interaction') return STATE_YIELDED;   // 已送达；挂起让位
    }
  } finally {
    // 订阅必须回收（回调常驻中枢消费者列表里）；预订阅与自建订阅同款：取走即弃
    //（`dshSubTake` 已出旁表）+ 这里 `close()` 幂等退订。
    sub.close();
  }
}

// --------------------------------------------------------------------------
// 消息投递体（chat.py:1016-1122）
// --------------------------------------------------------------------------

/**
 * dsh 插件族消息投递体：写对话日志 → 投递 → 等 turn 结束。
 *
 * turn 结束由插件推来的 turn/end 帧判定（事件驱动，零轮询）；「挂起等作答」由
 * driver/interaction 帧实时告知。等轮次走 `waitTurn` 分流口（T6 收口）：外部会话
 * （无卡消息路径的飞书绑定会话、平台重启后变 `owned:false` 的任务会话）订阅**全局状态流**
 * ——按会话 SSE 对池外会话是 404（「读不到」会被误判成本轮结束）。本会话的基线 `since` 与
 * 对话日志落点 `logPath` 逐字透传（缺陷 G 的总时限原因行必须落这条日志）。
 *
 * **async**。
 *
 * @param {object} project 项目行（消费 `work_dir`）
 * @param {string} sid
 * @param {string} message
 * @param {boolean} inject
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>}
 */
export async function dshSendNow(project, sid, message, inject, options = {}) {
  ensureRuntimeDirs(project.work_dir);
  const logDir = runtimeDir(project.work_dir, logDirName());
  const logPath = path.join(logDir, `chat_dsh_${Math.trunc(Date.now() / 1000)}.log`);
  // 这一处**不用** appendLog：Python 是裸 `open(log_path, "ab")`——写失败（目录建不出来等）
  // 会让本条消息落 error，而 `runner.append_log` 的语义是吞 OSError（那是超时留痕的口径）。
  // `Buffer.from(…, 'utf8')` 对孤立代理对给 U+FFFD，等价 Python 的 errors="replace"。
  fs.appendFileSync(logPath, Buffer.from(
    `### PROMPT ${pyJsonDumps(message)}\n### DRIVER dsh_plugin sid=${sid} `
    + `${inject ? 'steer' : 'followup'}\n`, 'utf8',
  ));
  const since = await dshSend(sid, message, inject, options);
  register(sid, null, message, { logPath, dshPlugin: true, since });
  // 分流口：池内/未知 ⇒ 既有按会话 SSE（显式传本会话日志 + 基线）；外部 ⇒ 全局状态流
  return waitTurn(project.work_dir, sid, 'dsh_plugin', since, logPath, options);
}

/**
 * 等一次会话 turn 结束（dsh 单族：订阅事件流等 turn/end，挂起即让位）。
 *
 * dsh_plugin：不走轮询——直接订阅插件推来的事件流等 turn/end，「挂起等作答」由
 * driver/interaction 帧实时告知（见 `dshWaitTurn`）。不设总时长上限（跑到 turn 结束，点
 * 「停止」可中断），turn 未启动的宽限判定（`TURN_START_GRACE`）与总时限兜底
 * （`DSH_WAIT_TURN_TIMEOUT`）都在 `dshWaitTurn` 内。挂起让位：turn 挂起等用户作答时返回
 * STATE_YIELDED——消息已送达，调用方据此落让位终态并释放运行位，队首单元照常起跑。
 *
 * 非 dsh 族（已全部退场）：无 turn 可等，恒返回 null（无投递路径，不会走到）。**async**。
 *
 * @param {string} projectDir
 * @param {string} sid
 * @param {string} family
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>}
 */
export async function waitWebBusy(projectDir, sid, family, options = {}) {
  if (family !== 'dsh_plugin') return null;
  return dshWaitTurn(sid, null, true, '', options);
}

/**
 * 等一次会话 turn 结束的**分流口**（C 批 T6）：按会话归属选等待通道。
 *
 * 外部会话（用户在 dsh GUI 里直跑/接管，注册表 `owned:false`）不在驱动池中，
 * `/events?session_id=` 与 `/status` 同属池内门禁（404）⇒ 按会话 SSE 等不到任何帧，「等不到」
 * 又被当成「本轮结束」（外部会话被误判成功的根因）。故外部会话改走**全局状态流**
 * （`dshWaitTurnViaEvents`：插件每会话都发 turn/start|turn/end，平台侧零请求）。
 *
 * 其余情况一律走既有 `waitWebBusy`（按会话 SSE），**行为一个字节不变**：
 *   - `owned:true` 平台自持会话：权威等待通道就是按会话 SSE；
 *   - 注册表未知（`dshevents.get` 返回 null：链路断连 / 没见过该 sid）：**未知 ≠ 外部**
 *     ——此时无法判定它是外部会话，若改走事件流路，链路降级期会把池内会话立刻按超时收口
 *     （运行位提前释放），是净回归。
 * 未对齐（热重载后 /live 空快照、旧表保留）不单独判：链路仍在线、帧照旧折叠，行里的
 * `owned` 仍是可用判定依据（与前置闸同口径：只有「读不到行」才算未知）。
 *
 * `since` / `logPath` 语义分两种调用形状（照 Python）：
 *   - **都不传**（既有形状）：池内/未知照旧原样调 `waitWebBusy`；
 *   - **传了任一个**：池内/未知改走 `dshWaitTurn`——与旧 `dshSendNow` 直调同参数同返回值。
 * 外部分支两种形状一致：`dshWaitTurnViaEvents`。**async**。
 *
 * @param {string} projectDir
 * @param {string} sid
 * @param {string} family
 * @param {number|null} [since]
 * @param {string} [logPath]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>}
 */
export async function waitTurn(projectDir, sid, family, since = null, logPath = '', options = {}) {
  const st = sid ? dshevents.get(sid) : null;
  if (st === null || st.owned) {
    if ((since === null || since === undefined) && !logPath) {
      return waitWebBusy(projectDir, sid, family, options);   // 既有形状：一字未动
    }
    if (family !== 'dsh_plugin') return null;                 // 族守卫（与 waitWebBusy 同口径）
    return dshWaitTurn(sid, since, true, logPath, options);
  }
  return dshWaitTurnViaEvents(sid, since, logPath, true, options);
}

/**
 * 任务/纯会话消息的实际发送（统一队列单元执行体调用）。
 *
 * dsh_plugin（唯一族）：投递 = driver 的 followup/steer，等 turn 结束由事件流判定
 * （见 `dshSendNow`）；turn 挂起等作答则返回 STATE_YIELDED（挂起让位）——返回时才释放项目
 * 占用，执行期间不会与项目内其他单元并发（让位除外：挂起即提前释放）。**async**。
 *
 * @param {object} task
 * @param {object} project
 * @param {string} family
 * @param {string} sid
 * @param {string} message
 * @param {boolean} inject
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>}
 */
export async function sendNow(task, project, family, sid, message, inject, options = {}) {
  if (family !== 'dsh_plugin') {
    // 单族世界：其余族已全部退场（B0 防呆口径），走到这儿说明有残留调用路径
    throw new Error(`该智能体族已下线，请在项目设置里改绑 dsh 插件：${family || '未知'}`);
  }
  return dshSendNow(project, sid, message, inject, options);
}

/**
 * 「立即注入」投递体（`injectNow` 调用；不等本轮结束）。
 *
 * dsh_plugin（唯一族）：直接 steer（dsh 的 steer 语义就是注入最近 step 边界，空闲则起一轮）
 * ——不轮询 turn 结束、不持有项目占用，因为用户点「立即注入」的语义就是不要排队。
 * `project`/`model` 保留为兼容既有调用签名（dsh 投递不带模型）。**async**。
 *
 * @param {object} project
 * @param {string} sid
 * @param {number|null} taskId
 * @param {string} message
 * @param {string} model
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<void>}
 */
export async function injectSend(project, sid, taskId, message, model, options = {}) {
  const since = await dshSend(sid, message, true, options);
  register(sid, taskId, message, { dshPlugin: true, since });
}

// --------------------------------------------------------------------------
// 入口（chat.py:1125-1189）
// --------------------------------------------------------------------------

/**
 * 发起对话（走统一队列）：登记消息单元并提交 runner，返回消息记录 dict。
 *
 * - 项目空闲：worker 立刻拾起执行（毫秒级），`queued=false`；
 * - 项目忙（同项目有任务/卡片会话在跑）：按入队顺序排队，`queued=true`。
 * 排队中的消息可「立即注入」（不等队列直接投递，见 `injectNow`）：family/model 提交时定格
 * 进等待项 meta，执行时按快照重建（见 `submit`）。**async**。
 *
 * @param {object} task 任务行（消费 `id` / `session_id` / `model`）
 * @param {object} project 项目行（消费 `id` / `agent_path` / `model`）
 * @param {string} message
 * @param {boolean} [inject]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{id: string, state: string, queued: boolean}>}
 */
export async function start(task, project, message, inject = false, options = {}) {
  const family = agentFamily(project.agent_path);
  const sid = task.session_id;
  const model = String(task.model || '').trim() || String(project.model || '').trim();
  return submit(project.id, sid, message, {
    taskId: task.id, inject, family, model, ...options,
  });
}

/**
 * 停止进行中的对话：先取消排队中的消息，再中断正在跑的 turn。
 *
 * dsh 插件族：cancel 优雅中断当前 turn（保留已流式交付的文本）；inbox 里的排队项一并清掉
 * （停止 = 不再执行这条会话上排着的工作）。返回是否命中了运行中的对话（排队取消不算命中）。
 * **async**（中断是驱动调用）。
 *
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<boolean>}
 */
export async function stop(sid, options = {}) {
  cancelQueued({ sid }, options);
  const rec = CHAT_REGISTRY.get(sid);
  if (rec === undefined || !rec.dsh_plugin) return false;
  try {
    await driverCancel(sid);
    return true;
  } catch (err) {
    if (err && err.name === 'DshDriverError') return false;
    throw err;
  }
}
