/**
 * 看板的 Node 对应物（`board.py` 5284 行）：**M3 = 只读子集**，**M5-1 = 卡片依赖 /
 * 五列门禁 / doing 列手势 / 列内拖排 / 出队原语**；其余写路径（起跑、调和器、
 * 归档同步、调度线程）按 M5-2/M5-3 继续搬，跨批依赖走文件末尾的注入式缝。
 *
 * ── 本文件搬了什么 ──────────────────────────────────────────────────────────────
 * 常量：`COLUMNS` / `MODE_VALUES` / `SETTINGS_DEFAULT` / `SORT_MODES` / `TASK_BOARD_COLUMN`
 *       / `STATE_RUNNING`·`STATE_IDLE`·`STATE_UNKNOWN`（会话三态）/ `QS_*`（八枚举）。
 * 读口：`cardWorkspace` / `cardTsMs` / `cardJson` / `commentJson` / `settingsOf` /
 *       `doingQueueOrder` / `boardPayload` / `webFamily` / `extActive` /
 *       `sessionStateFamily` / `sessionState` / `unitLiveness` / `webBusy` /
 *       `webSessionBusy` / `webBusyMap` / `isAnswerPending` / `cardStarting` /
 *       `queueStateOf` / `queueStates` / `mergePending` / `worktreePreview`。
 *
 * **M5-1 起已搬（写路径第一批）**：`descendantIds` / `setParent` / `moveCard`（含
 * `doingGesture`）/ `reorderPlan`·`moveIntoPlan` / `reorderCard` / `reorderDoingCard` /
 * `dequeueCard` / `leaveDoing` + 小判据 `hasActiveRun`/`wtInFlight`/`sessionInFlight`/
 * `cardUnitActive`/`platformHolds`/`gestureRunPosition`/`startingWindow`。
 * **（M5-2 修正）** 其中 `moveCard`/`doingGesture`/`dequeueCard`/`leaveDoing` 四条**改成
 * async**（它们要 await M5-2 的 async 钩子）——调用方必须 await；值形态（`[card, err]`
 * 数组/字符串哨兵）逐点不变，见文件末尾「异步口径」。
 *
 * **M5-2 起已搬（写路径第二批）**：ext 行族（`upsertExt`/`extCandidates`/`extRefresh`/
 * `recoverExtRows`/`refreshExtRows`/`startExtRecoverAfterConnect`）、起跑（`enterDoing`/
 * `startIntoDoing`/`enterDoingWorktree`/`dequeueStart`/`wtStartBegin`·`wtStartEnd`）、
 * worktree 清理与合并回交（`cleanupCardWorktree`/`buildMergeInstruction`/
 * `handoffWorktreeMerge`）、提示词三支（`buildTaskPrompt`/`buildContinuePrompt`/
 * `buildStartPrompt`）、会话驱动（`startCard`/`startWeb`/`deliverComment`/`deliverUnit`/
 * `deliverNow`/`ensureCardSession`/`stopCard`/`compactSession`/`forkSession`/
 * `forkCompactSession`）、收尾（`finish`/`deleteCardCleanup`/`finishRun`/`watchRunsOnce`）
 * 与小判据（`runPid`/`unitEvidencePid`/`orphanHold`/`stopRecent`/`subagentSession`）。
 * 详见文件末尾「M5-2 写路径」大段的异步口径与形态差异清单。
 *
 * **仍不搬**：交互调和器（`_iw_once` 全族）、归档同步全族、`sync_sessions` 全族、
 * 调度线程（`start_scheduler`/`_watch_once`/`recover`）、作答与送达族、Jira 导入、
 * `_reconcile_starting_rows`/`_heal_queue_placeholders`、`rename_card_session`、
 * `interaction_probe`——以上由 M5-3（作答/归档）与 M7 承接。**跨批调用点一律是注入式缝**：
 * 必经之路（`enterDoing`/`stopCard`/`finish`/`archiveCardSessions`）未注入即抛
 * `BoardHookMissing`；带「不可用即降级」语义的六个口（`syncSessions`/`iwClear`/
 * `ensureWatch`/`watchBeforeDelivery`/`isSubagent`/`feishuCardReview`/`feishuCardBlocked`）走 `optionalHook`
 * 跳过并留到期里程碑，**绝不静默假装成功**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 边界清单（M3 = 「刚起的 Python 实例」口径；每一条都对应 Python 的一个具体分支）
 * ══════════════════════════════════════════════════════════════════════════════
 * ① **`running_map` 的数据源**：M3 恒空表（刚起的 Python 实例 `_RUNS == {}` 同形，
 *    见 `runningMap`）；**M5-1 起读本文件的 `RUNS` 登记表**（`startCard`/`watchOnce`
 *    在 M5-2 写入它）——M3 保留的 `boardPayload(projectId, {runningMap})` 注入面不变，
 *    换的只是数据源。空表时与 M3 逐点相同（`{}`、无键、`JSON.stringify` 给 `{}`）。
 * ② **`_has_active_run` / `_card_unit_active` 已由 M5-1 补上**（`hasActiveRun` /
 *    `cardUnitActive`，读数源分别是进程内 `RUNS` 表与活跃 `c:` 行）。M3 当时不搬的理由
 *    是「本文件里没有调用点」——M5-1 的手势判据（`gestureRunPosition` → `platformHolds`）
 *    正是它们的第一个调用面，故一并落地。**判据口径不变**：`cardUnitActive` 看
 *    starting/running/finishing 三态，与 `cardStarting`/`queueStates` 走
 *    `waitq.startingCardIds()`（只认 starting）**不是**同一判据，两者不许互相顶替。
 * ③ **`sessionState` / `unitLiveness` / `webSessionBusy` / `webBusyMap` 的 `wait` 语义**：
 *    Python `_session_state_family(family, project_dir, sid, wait=True)` 的 `wait` 参数在
 *    单族化（只 dsh_plugin）之后**取值不影响结果**——它只读 `dshevents` 的进程内注册表，
 *    而 `dshevents.get` 是纯内存读、不阻塞（Python docstring 原文：「project_dir / wait
 *    为既有调用面参数（dsh 读口是内存表，不阻塞 REST、取值不影响结果）」）。**故 M3 不需要
 *    任何「等待超时」等价物**；`wait` 仅作为签名参数保留（调用方形态不变）。
 * ④ **断连 = 未知**：`dshevents` 未连接 ⇒ `snapshot()` 给 `{}`、`get()` 给 `null` ⇒
 *    `webBusyMap` 给 `{}`（busy 全 False，与「无信号」的展示口径一致）、`sessionState`
 *    给 `unknown`、`unitLiveness` 给 `'unknown'`。**绝不推断空闲**。
 * ⑤ **`interaction_of_sid`（`_IW_CACHE`）不搬**：调和器缓存属 M5。看板卡片的
 *    `interaction_pending` 判据是**卡片行的 `block_kind === 'interaction'`**（持久列，
 *    照 `queue_state_of`），与 `_IW_CACHE` 无关——故 `boardPayload` 的 `queue_state`
 *    在 M3 是完整的；只有**会话端点 meta** 的 `interaction` 字段会缺（那由 M3 路由
 *    直接给 null，不属本文件）。
 * ⑥ **`active_tasks` 段真实现**：`board_payload` 的任务条目是**纯表读 + 排序**
 *    （`db.list_tasks` + 状态→列映射），不依赖任何进程内状态。
 *
 * ── 与 Python 的形态差异（逐条，均为形态差异而非行为差异） ───────────────────────
 *   ① **同步**：Python 这些读口全同步；M2 的 `dshevents` 读口也是同步的，故本文件全同步。
 *   ② **读连接取自 `options.db`**（`db.js` 读路径契约，见 `db.js`）：缺省自开短连接
 *      并 close，传句柄则复用不关。故所有读口都收末位 `options`。
 *   ③ **行对象是普通对象**；字段名仍 snake_case（跨语言契约），函数名 camelCase。
 *   ④ **`doingQueueOrder` 的返回**：Python 给 `{card_id: (rank, seq)}` 元组；Node 给
 *      `Map<number, [rank, seq]>`（数组元组，比较语义与 Python 元组逐位相同）。
 *      默认键为 `[1, sort_order || 0, id]`（Python 三元组同形；JS 比较器对它做数值比较，
 *      与 Python int 比较一致）。
 *   ⑤ **`queueStateOf` 的参数形态**：Python 是位置参数 `(row, running, busy, msg_queued,
 *      foreign, answer, starting)`；Node 改收一个 opts 对象（`foreign` 在 Python 侧一律
 *      关键字传参，位置易错）。缺省语义与 Python 逐点同（`undefined` ⇒ 现算）。
 *   ⑥ **`cardJson` 多一个可选注入键 `answerPending`**：Python 走「`queue_state is None`
 *      ⇒ 现算」时逐卡点查 `wait_items`（N+1 形态）。Node 保留同一语义，但允许调用方
 *      一次批量取好集合注入；缺省 `null` ⇒ 逐卡点查，**与 Python 完全同形**。
 *   ⑦ **`cardJson` 的 `sessions` 坏 JSON**：Python `json.loads` 抛 ValueError 打穿读板；
 *      Node 按空数组降级（与 `db.js` 读路径「宽容读」同口径）。`sessions` 列由平台自身
 *      写入，坏值只可能来自人工改库。
 *
 * 零 npm 依赖：只用 `node:` 内建模块 + 本仓库内模块。
 */

import fs from 'node:fs';
import path from 'node:path';

import { agentFamily, RETIRED_MSG } from './agents.js';
import * as chatMod from './chat.js';
import { queuedCardIds } from './chat.js';
import * as dbmod from './db.js';
import * as dshMod from './dshdriver.js';
import {
  aligned as eventAligned, archived as eventArchived, archivedSet as eventArchivedSet,
  connected as eventConnected, connected as eventsConnected, get as eventGet, sessionEffort,
  sessionPermissionMode,
  snapshot as eventSnapshot, stats as eventStats, subscribe as eventSubscribe,
  waitConnected,
} from './dshevents.js';
import { ensureRuntimeDirs, pyIntOr, pyJoin, runtimeDir } from './lib.js';
import { pyJsonDumps } from './pyjson.js';

import { killTree, pidAlive } from './proc.js';
import * as sessparseMod from './sessparse.js';
import * as runnerMod from './runner.js';
import {
  activeExt, activeExtItems, activeItems, answerPendingCardIds, cancel as waitqCancel,
  cancelCardWait, claim, evidencePid, finishByTarget, getActive, insertAfterPrefix,
  insertCardForceStart, insertExt, KIND_ANSWER, KIND_CARD, KIND_EXT, markDone, markFailed,
  markFinishing, markRunning, returnToWaiting, setCardWaitPlaceholder, touchUnit,
  FINISHING, RUNNING, STARTING, STATE_FAILED, STATE_WAITING, reposition, startingCardIds,
} from './waitq.js';
// worktree 三件套（create/status/remove）在 M6-1 已整体迁进 `worktree.js`（M5-2 曾临时住在
// 本文件里，并因漏导入 `worktreePath` 而让直起路径必然 ReferenceError；见 `worktree.js` 文件头）。
// 这里只留**调用侧薄别名**：`wtCreate`/`wtStatus`/`wtRemove` 的名字不变，故两条调用链零改动。
import { branchFor, create as wtCreate, git, mergeStatus, preview as worktreePreviewCore,
  remove as wtRemove, repoRoot, status as wtStatus } from './worktree.js';

// --------------------------------------------------------------------------
// 常量（逐条对齐 board.py:41-68、220、4698-4722）
// --------------------------------------------------------------------------

/** 五列定义（顺序即前端列序） */
export const COLUMNS = Object.freeze(['todo', 'doing', 'blocked', 'review', 'done']);

/** 会话实况三态（2026-09-19 运行判定收口）：判定「会话是否在运行」的唯一读路径 */
export const STATE_RUNNING = 'running';
export const STATE_IDLE = 'idle';
export const STATE_UNKNOWN = 'unknown';

/**
 * 看板设置默认值（`board_settings.json` 缺省补齐）。sort = 每列排序方案：
 * manual = 手动拖拽顺序（sort_order），entered_desc = 进入已完成时间新→旧（仅 done 列）。
 */
export const SETTINGS_DEFAULT = Object.freeze({
  mode: 'serial',
  sync_sessions: true,
  jira: Object.freeze({ url: '', user: '', token: '' }),
  sort: Object.freeze({
    todo: 'manual', doing: 'manual', blocked: 'manual', review: 'manual', done: 'entered_desc',
  }),
});

/** 列排序方案合法值（server 设置端点逐列校验用）；entered_desc 仅 done 列可用 */
export const SORT_MODES = Object.freeze(
  ['manual', 'created_desc', 'updated_desc', 'title', 'entered_desc'],
);

/** 并行模式合法值（两档）：serial = 同时只跑一个任务；parallel = 不限制 */
export const MODE_VALUES = Object.freeze(['serial', 'parallel']);

/**
 * 任务状态 → 看板列映射（v2c T4，裁决 R16）：进行中→doing、失败/中断/停止→review、
 * 完成→done；映射外状态不上板（防御未知新态）。
 */
export const TASK_BOARD_COLUMN = Object.freeze({
  queued: 'doing',
  running: 'doing',
  failed: 'review',
  interrupted: 'review',
  stopped: 'review',
  done: 'done',
});

/** queue_state 八枚举（裁决 R2 五态 + v2a T4 starting + 2026-09-25 interaction_pending） */
export const QS_IDLE = 'idle';                            // 无等待无运行
export const QS_QUEUED = 'queued_serial';                 // 等串行位（本项目排队位次）
export const QS_ANSWER = 'answer_pending';                // 已收下待送达（answer 活跃行在场）
export const QS_INTERACTION = 'interaction_pending';      // 提问挂起等作答（block_kind=interaction）
export const QS_SERVER = 'server_queued';                 // 服务端排队（仅会话级）
export const QS_FOREIGN = 'foreign_busy';                 // 等外部会话（项目被外部会话占用）
export const QS_STARTING = 'starting';                    // 启动中（c: 行 starting）
export const QS_RUNNING = 'running';                      // 运行中

// --------------------------------------------------------------------------
// 行取值容错（board.py:74-85 `_card_opt`）
// --------------------------------------------------------------------------

/**
 * 读卡片可选列（列缺失 / 值为 NULL 一律回落 default）。
 *
 * `board_cards.worktree` 是 kanban 一期遗留列（比一期更早的库可能没有该列）——Python
 * `sqlite3.Row` 缺列抛 IndexError，故所有新列的读取一律经本函数，不直接下标访问。
 * Node 的行是普通对象，缺列给 `undefined`（不抛），这里显式归一成 default。
 *
 * 与 `db.rowOpt` 的关系：语义同源（都对齐 `_card_opt`）；本函数保留是因为 `_card_opt`
 * 的语义就是「board 的可选列读取」，且它不依赖 db 模块（纯行操作，可被单测直接调）。
 *
 * @param {object} row
 * @param {string} key
 * @param {unknown} [def]
 * @returns {unknown}
 */
export function cardOpt(row, key, def = '') {
  const v = row === null || row === undefined ? undefined : row[key];
  return v === undefined || v === null ? def : v;
}

/** Python `_card_opt` 的下划线别名（对拍/检索时口径一致） */
export const _card_opt = cardOpt;

// --------------------------------------------------------------------------
// 卡片视图（board.py:88-176）
// --------------------------------------------------------------------------

/**
 * 卡片会话的工作目录：独立 worktree 卡（`board_cards.worktree` 非空）用其 worktree
 * 路径，其余一律仍用 `project_dir`——这是「卡片级 cwd」的**唯一读口**。
 *
 * @param {object} project
 * @param {object} card
 * @returns {string}
 */
export function cardWorkspace(project, card) {
  const wt = String(cardOpt(card, 'worktree') || '').trim();
  return wt || project.project_dir;
}

/**
 * 库内时间串（`YYYY-MM-DD HH:MM:SS`，`db.now_str` 口径 = **服务器本地时间**）→ 毫秒 epoch。
 *
 * 卡面「最后更新时间」的下发形态：库里存的是无时区标记的本地时间串（本容器 = UTC，
 * Windows 原生运行 = +8），前端若直接 `new Date(串)` 会按浏览器本地时区解析 ⇒ 在 UTC
 * 服务器 + 北京浏览器下整整差 8 小时。故一律在服务端换算成 epoch。
 *
 * **解释口径必须与写入口径互逆**（Python 用 `time.mktime(time.strptime(...))`，同按本地
 * 时区反解）：Node 用「本地时区构造 Date」——两者在 Linux(UTC)/Windows(+8) 下都自洽。
 * Python `strptime` 只在 `%Y-%m-%d %H:%M:%S` 字面匹配时成功，故先用锚定正则把同样的
 * 「定长数字 + 分隔符」形状钉住，再逐字段校验构造结果（**捕获 Date 的静默滚动**：
 * `new Date(2026, 12, 1)` 会滚到 2027-01，而 Python 抛 ValueError ⇒ 必须返回 null）。
 *
 * 坏值/空值返回 null（前端不渲染该小字），绝不抛异常打穿读板路径；不用 0 兜底
 * （0 会被前端当 1970 年渲染）。
 *
 * @param {string} tsStr
 * @returns {number|null}
 */
export function cardTsMs(tsStr) {
  if (!tsStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(tsStr));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const da = Number(m[3]);
  const h = Number(m[4]); const mi = Number(m[5]); const s = Number(m[6]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || s > 61) return null;
  const d = new Date(0);
  d.setFullYear(y, mo - 1, da);
  d.setHours(h, mi, s, 0);
  // 构造后逐字段复核：任何滚动（如 2月30日→3月2日）都说明原串不是合法日期 ⇒ null
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da
      || d.getHours() !== h || d.getMinutes() !== mi || d.getSeconds() !== s) {
    return null;
  }
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;         // Python 侧 OverflowError 分支
  return ms;
}

/**
 * 卡片行 → 前端 dict（字段形状与 Python `card_json` **逐键同**，snake_case）。
 *
 * 参数语义照 Python docstring：
 *   - `running`：平台在管运行（M3 恒 false，见文件头边界①）；
 *   - `busy`：会话级运行（平台运行或外部 busy）——前端徽标 `running || busy` 都点亮；
 *   - `msgQueued`：本卡有平台排队中的会话消息单元（`chat.queuedCardIds` 批量预计算）；
 *   - `queueState`：单枚举（判定收口 `queueStateOf`，前端只渲染）。缺省按四参现算；
 *     `boardPayload` 走批量预计算显式传入，此时 `answer_pending` 与之同源
 *     （`queue_state_of` 判定序最高级即 answer 在场 ⟺ answer_pending，免二次点查）。
 *   - `answerPending`：可选注入（Node 侧新增，见文件头差异⑥）。
 *
 * @param {object} row 卡片行
 * @param {{running?: boolean, busy?: boolean, msgQueued?: boolean,
 *          queueState?: string|null, answerPending?: boolean|null}} [opts]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {object}
 */
export function cardJson(row, opts = {}, options = {}) {
  const {
    running = false, busy = false, msgQueued = false,
    queueState = null, answerPending = null,
  } = opts;
  let qs = queueState;
  let answer;
  if (qs === null || qs === undefined) {
    answer = answerPending === null || answerPending === undefined
      ? isAnswerPending(row.id, options) : answerPending;
    qs = queueStateOf(row, { running, busy, msgQueued, answer }, options);
  } else {
    answer = qs === QS_ANSWER;
  }
  let sessions;
  try {
    sessions = JSON.parse(row.sessions || '[]');
  } catch {
    sessions = [];                     // 坏 JSON：按空表（见文件头差异⑦）
  }
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    column: row.column_key,
    sort_order: row.sort_order,
    session_id: row.session_id,
    sessions,
    block_kind: row.block_kind,
    block_text: row.block_text,
    parent_card_id: row.parent_card_id,
    origin: row.origin,
    done_at: row.done_at,
    trashed: Boolean(row.trashed),
    trashed_at: row.trashed_at,
    scheduled_at: row.scheduled_at,
    jira_key: row.jira_key,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
    worktree: cardOpt(row, 'worktree'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_at_ts: cardTsMs(row.updated_at),
    // 状态有更新·用户未打开（2026-10-07 批次）：置位/清除全在 db 层派生维护，读侧只透传布尔
    unread: Boolean(cardOpt(row, 'unread') || 0),
    running,
    busy,
    answer_pending: answer,
    msg_queued: msgQueued,
    queue_state: qs,
  };
}

/**
 * 评论行 → 前端 dict。
 * @param {object} row
 * @returns {object}
 */
export function commentJson(row) {
  return {
    id: row.id,
    card_id: row.card_id,
    text: row.text,
    sent: Boolean(row.sent),
    session_id: row.session_id,
    sent_text: row.sent_text,
    created_at: row.created_at,
  };
}

/**
 * 看板设置（缺省补 `SETTINGS_DEFAULT`；`jira` 与 `sort` 逐字段深合并，存量行缺字段时落
 * 默认值）。`mode` **读取层归一**：已删档的 `readonly-parallel` 与任何未知值一律按
 * `serial` 处理，存量行无需迁移脚本。
 *
 * 逐点照 Python 的三段：① 只认识顶层 `s` 里已有的键（`k in s`）；② `jira` 全量 update
 * （Python 不筛键，多出来的键照留）；③ `sort` **筛键**（`if k in sort`）。
 *
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {object}
 */
export function settingsOf(projectId, options = {}) {
  const s = {
    mode: SETTINGS_DEFAULT.mode,
    sync_sessions: SETTINGS_DEFAULT.sync_sessions,
    jira: { ...SETTINGS_DEFAULT.jira },
    sort: { ...SETTINGS_DEFAULT.sort },
  };
  const saved = dbmod.getBoardSettings(projectId, options);
  for (const k of Object.keys(s)) {
    if (Object.prototype.hasOwnProperty.call(saved, k)) s[k] = saved[k];
  }
  if (!MODE_VALUES.includes(s.mode)) s.mode = 'serial';
  const jira = { ...SETTINGS_DEFAULT.jira };
  Object.assign(jira, saved.jira || {});
  s.jira = jira;
  const sort = { ...SETTINGS_DEFAULT.sort };
  const savedSort = saved.sort || {};
  for (const k of Object.keys(sort)) {
    if (Object.prototype.hasOwnProperty.call(savedSort, k)) sort[k] = savedSort[k];
  }
  s.sort = sort;
  return s;
}

// --------------------------------------------------------------------------
// doing 列队序与看板全量（board.py:196-289）
// --------------------------------------------------------------------------

/**
 * doing 列展示序 = 队序的排序键映射（v2c T2，裁决 R11 小口径；v2d T4 加 ext 行）：
 * `Map<card_id, [rank, seq]>`——
 *   - `c:`/`ext:` 行非 waiting（starting/running/finishing）= 运行位区 **rank 0** 按 seq
 *     （ext 行 target = 卡 id：外部条目的运行位次由此接管）；
 *   - `c:` 行 waiting = 等待区 **rank 2** 按 seq；
 *   - 无 `c:` 行的 answer 占位卡以 `a:` 行 seq 落等待区 **rank 2**（答案单元占用该队位）。
 * 无活跃行的卡（idle 同步卡）**不在映射内**——调用方落 **rank 1** 按 `sort_order` 相对序。
 *
 * 两个逐点保留的细节：
 *   ① 非数字 `target_id` 跳过（Python `except (TypeError, ValueError): continue`）；
 *   ② `order.setdefault(tid, (2, seq))` ⇒ **`c:`/`ext:` 行优先于 `a:` 行**（同卡双行时）。
 *
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Map<number, [number, number]>}
 */
export function doingQueueOrder(projectId, options = {}) {
  const order = new Map();
  const answers = [];
  for (const r of activeItems(projectId, options)) {
    const tid = Number.parseInt(r.target_id, 10);
    if (Number.isNaN(tid)) continue;
    if (r.kind === KIND_CARD || r.kind === KIND_EXT) {
      order.set(tid, [r.state !== STATE_WAITING ? 0 : 2, r.seq]);
    } else if (r.kind === KIND_ANSWER) {
      answers.push([tid, r.seq]);
    }
  }
  for (const [tid, seq] of answers) {
    if (!order.has(tid)) order.set(tid, [2, seq]);   // setdefault：c:/ext: 行优先
  }
  return order;
}

/** Python 下划线别名（对拍/检索） */
export const _doing_queue_order = doingQueueOrder;

/**
 * 卡片 → 是否有运行中的会话（`board.running_map()`，M5-1 起接真数据源）。
 *
 * M3 时该表恒空（见文件头边界①，那时 `_RUNS` 属未搬的进程内状态）；M5-1 起读本文件的
 * `RUNS` 登记表：条目存在即运行中（单族 dsh 的 `proc` 恒 None ⇒ 宽限期内 busy 未起也报
 * True，防误判空闲）；`proc` 非 None 时按进程存活判（Python `proc.poll() is None`）；
 * `aborted` 条目报 False（停止按钮即时反馈，收尾仍由 `_watch_once` 完成）。
 *
 * 形态说明（为什么不是 Map）：Python 是 `{card_id: bool}` dict，路由层
 * （`routes/board.js`）按 `rm[r.id]` 属性访问；另一处消费方（`lib/serverstate.js` 的
 * `boardSessionRunning`）按 `.get(cid)` 写。**两者都不得出错**，故返回值是
 * **只补了 `get`/`has`/`size` 三个非枚举成员的普通对象**：
 *   - 普通对象语义（`Object.keys`/展开/属性访问/JSON）**一个字节都不变**；
 *   - `.get(cid)` = `Boolean(obj[cid])`，即「有该卡且为真 ⇒ true，否则 false」；
 *   - `.has`/`.size` 一并给出，纯粹为对称（Python dict 侧无对应物，不参与对拍）。
 *
 * @returns {Object<number, boolean> & {get: Function, has: Function, size: number}}
 */
export function runningMap() {
  const out = {};
  for (const [cid, rec] of RUNS.entries()) {
    const proc = rec === null || rec === undefined ? null : (rec.proc ?? null);
    if (proc !== null && proc !== undefined) {
      out[cid] = proc.exitCode === null && proc.signalCode === null;
    } else {
      out[cid] = !(rec === null || rec === undefined ? false : rec.aborted);
    }
  }
  Object.defineProperties(out, {
    get: {
      value: (cid) => Boolean(out[cid]),
      enumerable: false, writable: false, configurable: false,
    },
    has: {
      value: (cid) => Object.prototype.hasOwnProperty.call(out, cid) && Boolean(out[cid]),
      enumerable: false, writable: false, configurable: false,
    },
    size: {
      get: () => Object.keys(out).length,
      enumerable: false, configurable: false,
    },
  });
  return out;
}

/**
 * 卡片 busy 批量预计算（`board_payload` 的卡片 `busy` 字段源）。
 *
 * 单族化后只有 dsh_plugin：读 EventHub 的进程内快照——**零请求**。未连接 ⇒ `{}`
 * （busy 全 False，与「无信号」的展示口径一致：看板据此不点亮，不误判），下一帧事件
 * 到达即自动纠正；退场族返回 `{}`。
 *
 * `runningMap` 为既有调用面参数（dsh 分支**不消费**——探测域收窄是旧逐 sid 探测时代的
 * 成本优化，dsh 一次快照即全量卡）。保留参数是为了与 Python 同签名。
 *
 * @param {object} proj
 * @param {object} [runningMapArg]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Object<string, boolean>}
 */
export function webBusyMap(proj, runningMapArg = {}, options = {}) {
  void runningMapArg;
  const fam = webFamily(proj);
  if (fam === null) return {};
  const snap = eventSnapshot();
  const sids = new Set();
  for (const c of dbmod.listBoardCards(proj.id, options)) {
    if (c.session_id) sids.add(c.session_id);
  }
  const out = {};
  for (const sid of sids) {
    const st = snap[sid] || {};
    out[sid] = Boolean(st.status === 'running');
  }
  return out;
}

/**
 * 看板全量：`{cards, comments, settings, active_tasks}`。
 *
 * - `runningMap`：`card_id -> bool`（平台在管运行；**M3 恒空**，见文件头边界①）。
 *   缺省 `{}`（照 Python `running_map = running_map or {}`）。
 * - 卡片 `busy` = 会话级运行（`webBusyMap` 批量预计算）。
 * - `active_tasks` = 任务条目三列上映；doing 序 = 运行中在前 + 创建先后，review/done 序 =
 *   结束时间新→旧；前端按条目 `column` 分列只读渲染，列统计口径 = 看板卡片不含任务。
 * - doing 列卡片**原位重排为队序**（稳定：仅 doing 内部相对序变化，他列原序不动）。
 *
 * 批量化的三处（消除 N+1）：`answer`/`starting` 活跃行各一次查询、msg 排队集合一次查询、
 * 外部占位一次行读（`queueStates`）；Python 侧 `card_json` 走 `queue_state is not None`
 * 分支（`answer = queue_state == QS_ANSWER`）正是为这个。
 *
 * @param {number} projectId
 * @param {{runningMap?: object, db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{cards: object[], comments: object[], settings: object, active_tasks: object[]}}
 */
export function boardPayload(projectId, opts = {}) {
  const { runningMap: rmArg = {}, ...options } = opts;
  const rm = rmArg || {};
  const proj = dbmod.getProject(projectId, options);
  const busyMap = proj !== null && proj !== undefined
    ? webBusyMap(proj, rm, options) : {};
  const queuedCards = queuedCardIds(options);
  const rows = dbmod.listBoardCards(projectId, options);
  const states = queueStates(proj, rows, rm, busyMap, queuedCards, options);
  const cards = rows.map((r) => cardJson(r, {
    running: Boolean(rm[r.id]),
    busy: Boolean(rm[r.id]) || Boolean(busyMap[r.session_id]),
    msgQueued: queuedCards.has(Number(r.id)),
    queueState: states.get(r.id),
  }, options));
  // doing 列原位重排为队序（稳定：仅 doing 内部相对序变化，他列原序不动）
  const doingOrder = doingQueueOrder(projectId, options);
  const doingCards = cards
    .filter((c) => c.column === 'doing')
    .sort((a, b) => compareRank(rankKey(doingOrder, a), rankKey(doingOrder, b)));
  let di = 0;
  const out = cards.map((c) => (c.column === 'doing' ? doingCards[di++] : c));
  const comments = dbmod.listBoardComments(projectId, options).map(commentJson);
  const doingT = [];
  const termT = [];
  for (const r of dbmod.listTasks(projectId, options)) {
    const col = TASK_BOARD_COLUMN[r.status];
    if (col === undefined) continue;          // 映射外状态不上板（防御未知新态）
    const entry = {
      id: r.id,
      project_id: r.project_id,
      name: r.name,
      task_type: r.task_type || 'normal',
      status: r.status,
      current_round: r.current_round,
      session_id: r.session_id,
      error: r.error,
      created_at: r.created_at,
      started_at: r.started_at,
      ended_at: r.ended_at,
      column: col,
    };
    (col === 'doing' ? doingT : termT).push(entry);
  }
  // doing 列保持现状序（运行中在前，排队按创建先后 ≈ 统一队列 FIFO 顺序）；
  // review/done 列按结束时间新→旧（与 done 列 entered_desc 默认同向）
  doingT.sort((a, b) => {
    const ra = a.status !== 'running' ? 1 : 0;
    const rb = b.status !== 'running' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return compareText(a.created_at || '', b.created_at || '');
  });
  termT.sort((a, b) => compareText(b.ended_at || '', a.ended_at || ''));
  return {
    cards: out,
    comments,
    settings: settingsOf(projectId, options),
    active_tasks: doingT.concat(termT),
  };
}

/** 卡片在 doing 队序里的比较键（照 Python `doing_order.get(id, (1, sort_order or 0, id))`） */
function rankKey(order, card) {
  const hit = order.get(card.id);
  if (hit !== undefined) return hit;
  return [1, card.sort_order || 0, card.id];
}

/** 逐位比较 `[rank, seq]` / `[rank, sort_order, id]`（数值比较，照 Python 元组比较） */
function compareRank(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] === undefined ? null : a[i];
    const bv = b[i] === undefined ? null : b[i];
    if (av === bv) continue;
    if (av === null) return -1;                // Python 元组短者小
    if (bv === null) return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

/** 字符串序比较（Python 的 `<` 对 str 是码点序；JS 的 `<` 对字符串是 UTF-16 码元序，BMP 内一致） */
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// --------------------------------------------------------------------------
// 项目族与会话实况（board.py:754-1810）
// --------------------------------------------------------------------------

/**
 * 项目 agent 属于 dsh 插件族时返回 `'dsh_plugin'`，否则 null（退场族）。
 *
 * 单族化（P7b）：kimi/opencode 两族（含其 web 驱动模块）已退场——`agents.agent_family`
 * 只回 `'dsh_plugin'` 或 `'retired'`，后者一律按 null 处置：调用方据 null 走退场族防呆。
 *
 * @param {object} project
 * @returns {string|null}
 */
export function webFamily(project) {
  const family = agentFamily((project && project.agent_path) || '');
  return family === 'dsh_plugin' ? family : null;
}

/** Python 下划线别名 */
export const _web_family = webFamily;

/**
 * 项目是否有活跃 ext 行（= 外部会话在跑，行读口）：展示派生（queue_state 的
 * `foreign_busy` 判定）与 `runner.unit_busy` 的 ext 分量共用。**直通 `waitq.activeExt`**
 * （判据唯一出处，不在这里重写 SQL）。
 *
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {boolean}
 */
export function extActive(projectId, options = {}) {
  return activeExt(projectId, options);
}

/**
 * 三态核心（族参数版；唯一会话状态读路径）：单族化后只有 dsh_plugin——
 * 读 `dshevents` 的进程内注册表（**零请求**：状态由 dsh 的 `agent/status` 事件推来；
 * 未连接/未知会话 ⇒ `unknown`，**绝不推断空闲**）；退场族 / 无 sid 无精确信号 → `unknown`。
 *
 * `projectDir` / `wait` 为既有调用面参数（dsh 读口是内存表，不阻塞、取值不影响结果，
 * 见文件头边界③）。不 ensure、不抛异常（一切异常收敛为 `unknown`）。
 *
 * @param {string|null} family
 * @param {string} projectDir
 * @param {string} sid
 * @param {boolean} [wait]
 * @returns {string}
 */
export function sessionStateFamily(family, projectDir, sid, wait = true) {
  void projectDir; void wait;
  if (family === null || family === undefined || !sid) return STATE_UNKNOWN;
  try {
    if (family !== 'dsh_plugin') return STATE_UNKNOWN;
    const st = eventGet(sid);
    if (st === null || st === undefined) return STATE_UNKNOWN;
    return st.status === 'running' ? STATE_RUNNING : STATE_IDLE;
  } catch {
    return STATE_UNKNOWN;              // 一切异常收敛为 unknown（调用方按场景处置）
  }
}

/** Python 下划线别名 */
export const _session_state_family = sessionStateFamily;

/**
 * 项目会话三态判定：agent_path 归族 + project_dir 定位（见族版核心注释）。
 * @param {object} proj
 * @param {string} sid
 * @param {boolean} [wait]
 * @returns {string}
 */
export function sessionState(proj, sid, wait = true) {
  return sessionStateFamily(webFamily(proj), proj.project_dir, sid, wait);
}

/**
 * 行判活探针（v3c 行口径）：web 族卡按会话三态映射——
 * `running → 'alive'`；`idle → 'dead'`（waitq 侧 R11a 降级不采信，跨轮间隙不误杀）；
 * `unknown → 'unknown'`（探测失败/状态不明只告警）。退场族卡与其他 kind 返回 null
 * ——交 waitq 内建 DB 证据裁活。
 *
 * @param {object} row 活跃等待项行
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {string|null}
 */
export function unitLiveness(row, options = {}) {
  if (row.kind !== KIND_CARD) return null;
  const cid = Number.parseInt(row.target_id, 10);
  if (Number.isNaN(cid)) return null;
  const card = dbmod.getBoardCard(cid, options);
  if (card === null) return null;              // 卡行已删：内建证据即可证死，无需探针
  const proj = dbmod.getProject(card.project_id, options);
  if (proj === null) return null;
  const family = webFamily(proj);
  if (family === null) return null;            // 退场族卡：无精确 busy 信号，交内建证据
  const st = sessionStateFamily(family, proj.project_dir,
    String(card.session_id === null || card.session_id === undefined ? '' : card.session_id).trim());
  if (st === STATE_RUNNING) return 'alive';
  if (st === STATE_IDLE) return 'dead';        // R11a：waitq 侧降级 unknown，不擅动
  return 'unknown';
}

/**
 * web 会话 turn 是否进行中（bool 适配：三态非 running 一律 false）。
 *
 * 已知边界（m8，照 Python）：busy 是**会话级**语义——同一 sid 被其他客户端（如 dsh GUI）
 * 使用/插话同样反映为 busy；仅注明，不改逻辑。
 *
 * @param {string|null} family
 * @param {string} projectDir
 * @param {string} sid
 * @param {boolean} [wait]
 * @returns {boolean}
 */
export function webBusy(family, projectDir, sid, wait = true) {
  return sessionStateFamily(family, projectDir, sid, wait) === STATE_RUNNING;
}

/** Python 下划线别名 */
export const _web_busy = webBusy;

/**
 * web 族单会话实况 busy（展示口径：`unknown` 按 false——不点亮动画不误报）。
 * 单族化后只有 dsh_plugin：读插件内存态（无需 ensure）；退场族 / 无 sid / 异常一律 false。
 *
 * @param {object} proj
 * @param {string} sid
 * @returns {boolean}
 */
export function webSessionBusy(proj, sid) {
  const family = webFamily(proj);
  if (family === null || !sid) return false;
  try {
    return sessionState(proj, sid) === STATE_RUNNING;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// 展示派生（board.py:4698-4795）
// --------------------------------------------------------------------------

/**
 * 该卡是否有已作答·待送达的答案（作答响应 `queued` 字段用）。
 *
 * P2 起权威在 `wait_items` 表（`kind=answer` 活跃行 waiting/starting/running/finishing）。
 * 看板轮询频率下的单行索引读可接受；批量派生走 `queueStates` →
 * `waitq.answerPendingCardIds` 一次查询。
 *
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {boolean}
 */
export function isAnswerPending(cardId, options = {}) {
  return getActive(KIND_ANSWER, cardId, options) !== null;
}

/**
 * 本卡 `c:` 等待项是否 `starting` 态（已交 runner 拾起、会话未证实运行；
 * `queue_state` 的 `starting` 枚举判据——单行索引点查，批量路径走
 * `waitq.startingCardIds` 一次查询）。
 *
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {boolean}
 */
export function cardStarting(cardId, options = {}) {
  const row = getActive(KIND_CARD, cardId, options);
  return row !== null && row.state === 'starting';
}

/**
 * 单卡 queue_state 纯判定（裁决 R10 优先级，互斥不变量在派生层保证）。
 *
 * 判定序（高→低）：`answer_pending` > `interaction_pending` > `running` > `starting`
 * > `queued_serial`/`foreign_busy` > `idle`。
 *   - `starting` 行在场 = 已在启动，压排队态，与 running 的边界 = 是否证实运行；
 *   - `interaction_pending`（提问挂起，`block_kind === 'interaction'`）压 running：
 *     dsh turn 在等作答期间实况 busy = true，亮「会话运行中」与阻塞容器矛盾；
 *   - 「已收下待送达」与运行并存是唯一例外——本函数按优先级只回一枚枚举，
 *     卡片操作行（⚡ 送达）仍读 `answer_pending` 字段本体（契约不变）；
 *   - `foreign` = true 仅当卡片处于排队占位且项目被外部会话占用时由调用方传入；
 *   - `answer`/`starting`：批量预计算路径传入本卡 answer 活跃行 / `c:` 行 starting
 *     在场与否，缺省分别按 `isAnswerPending` / `cardStarting` 点查。
 *
 * @param {object} row
 * @param {{running?: boolean, busy?: boolean, msgQueued?: boolean, foreign?: boolean,
 *          answer?: boolean|null, starting?: boolean|null}} [opts]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {string}
 */
export function queueStateOf(row, opts = {}, options = {}) {
  const {
    running = false, busy = false, msgQueued = false, foreign = false,
    answer = null, starting = null,
  } = opts;
  let hasAnswer = answer;
  if (hasAnswer === null || hasAnswer === undefined) {
    hasAnswer = isAnswerPending(row.id, options);
  }
  if (hasAnswer) return QS_ANSWER;
  if (row.block_kind === 'interaction') return QS_INTERACTION;
  if (running || busy) return QS_RUNNING;
  let isStarting = starting;
  if (isStarting === null || isStarting === undefined) {
    isStarting = cardStarting(row.id, options);
  }
  if (isStarting) return QS_STARTING;
  if (msgQueued || row.block_kind === 'queue') {
    return foreign ? QS_FOREIGN : QS_QUEUED;
  }
  return QS_IDLE;
}

/**
 * 批量派生 `Map<card_id, queue_state>`（`board_payload` 用，一次预计算避免 N+1：
 * answer 活跃行、`c:` starting 行与 msg 排队集合各一次查询，外部占位一次行读）。
 *
 * `proj` 非 null 时做项目级外部占位判定（项目有活跃 ext 行 = 外部会话在跑）；`proj` 为
 * null 时按无项目上下文降级（`foreign` 恒 false，`foreign_busy` 不可能出现）。
 *
 * @param {object|null} proj
 * @param {object[]} rows
 * @param {object} [runningMap]
 * @param {object} [busyMap]
 * @param {Set<string>} [queuedCards]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Map<number, string>}
 */
export function queueStates(proj, rows, runningMap = {}, busyMap = {},
  queuedCards = new Set(), options = {}) {
  const rm = runningMap || {};
  const bm = busyMap || {};
  const qc = queuedCards || new Set();
  const foreign = proj !== null && proj !== undefined && extActive(proj.id, options);
  const answers = answerPendingCardIds(options);
  const startings = startingCardIds(options);
  const out = new Map();
  for (const r of rows) {
    const running = Boolean(rm[r.id]);
    out.set(r.id, queueStateOf(r, {
      running,
      busy: running || Boolean(bm[r.session_id]),
      msgQueued: qc.has(Number(r.id)),
      foreign,
      answer: answers.has(r.id),
      starting: startings.has(r.id),
    }, options));
  }
  return out;
}

// --------------------------------------------------------------------------
// worktree 预览（board.py:1357-1390）
// --------------------------------------------------------------------------

/**
 * 「通过」前的待合并提交判定（只服务独立 worktree 卡）。返回 dict 或 null。
 *
 * null = 无需询问（非 worktree 卡 / 工作树读不到 / 没有待合并提交）——三种情形都按普通卡
 * 直接完成（用户 2026-10-07 约定：没有可合并的 commit 就直接进已完成；工作树被用户删掉等
 * 读不到的情形拦下来只会卡住「通过」，故一并放行）。
 *
 * @param {object} project
 * @param {object} card
 * @returns {object|null}
 */
export function mergePending(project, card) {
  if (!String(cardOpt(card, 'worktree') || '').trim()) return null;
  const st = mergeStatus(project, card);
  if (!st.ok || st.ahead <= 0) return null;
  return {
    branch: st.branch,
    target: st.target,
    ahead: st.ahead,
    behind: st.behind,
    dirty: st.dirty,
    dirty_count: st.dirty_count,
    path: st.path,
  };
}

/**
 * 卡片「在新 worktree 中开始」入口的预览（server 端点用，**不落盘**）。
 *
 * 返回 `{supported, reason, path, branch, exists, merge}`——`supported=false` 时 `reason`
 * 是给用户看的中文原因（项目不是 git 仓库 / 卡片已有主会话，D10）；前端据此把菜单项置灰
 * 并显示原因，避免用户点了必然失败的入口。`merge` = 待合并提交判定（`None` = 无待合并）：
 * 已经是 worktree 卡的卡片走本端点时前端据它决定「通过」要不要弹合并框。
 *
 * **纯读**：全程只跑 `git rev-parse` / `git rev-list --count` / `git status --porcelain`
 * （`worktree.js`），不建目录、不建分支、不做任何合并。
 *
 * @param {object} project
 * @param {object} card
 * @returns {{supported: boolean, reason: string, path: string, branch: string,
 *            exists: boolean, merge: object|null}}
 */
export function worktreePreview(project, card) {
  const branch = branchFor(card.id);
  const pend = mergePending(project, card);
  const wt = String(cardOpt(card, 'worktree') || '').trim();
  if (wt) {
    // 已是 worktree 卡：续跑自动复用，无需再选（前端一般不再显示该入口）
    return {
      supported: false,
      reason: '该卡片已在独立 worktree 中运行',
      path: cardOpt(card, 'worktree'),
      branch,
      exists: isDirSafe(cardOpt(card, 'worktree')),
      merge: pend,
    };
  }
  if (String(card.session_id || '').trim()) {
    return {
      supported: false,
      reason: '该卡片已有主会话，不能切换到独立 worktree（请新建卡片）',
      path: '',
      branch,
      exists: false,
      merge: pend,
    };
  }
  const pv = worktreePreviewCore(project, card.id);
  if (!pv.ok) {
    return {
      supported: false, reason: pv.error, path: '', branch, exists: false, merge: pend,
    };
  }
  return {
    supported: true,
    reason: '',
    path: pv.path,
    branch: pv.branch,
    exists: pv.exists,
    merge: pend,
  };
}

/** `os.path.isdir` 的对应物（不存在/权限不足一律 false） */
function isDirSafe(p) {
  try {
    return fs.statSync(String(p)).isDirectory();
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// M5-1 写路径：卡片依赖、五列门禁、doing 列手势、列内拖排、出队原语
// （`board.py:281-721` / `3193-3238`）
//
// 交付面：`descendantIds` / `setParent` / `moveCard`（含 `doingGesture`）
//        / `reorderPlan`·`moveIntoPlan`（纯函数）/ `reorderCard` / `reorderDoingCard`
//        / `dequeueCard` / `leaveDoing` + 四条小判据（`hasActiveRun` 等）。
//
// ── 跨批依赖走**注入式缝**（照 M4 `setUnitHandlers` 的先例）───────────────────
// `moveCard` 的四条分支要落 M5-2/M5-3 的函数（起跑 / 停止 / 收尾 / 归档），
// M5-1 阶段它们尚未定义 ⇒ 由 `setBoardHooks` 注入；**未注入时响亮失败**
// （`BoardHookMissing`，文案点明到期里程碑），绝不静默 no-op —— 静默会让
// 「卡片根本没动」看起来像成功，这正是 M4 缝设计的同一条理由。
//
// ── 与 Python 的形态差异（逐条，均为形态差异而非行为差异）───────────────────
// ① 二元返回用**数组** `[card, null]` / `[null, err]`（Python 是 `(card, None)` /
//    `(None, err)` 元组）——调用方按位置解构，形态即契约（照 M4 `position` 先例）。
// ② 全部写口收末位 `options`（`db.js` 读写连接契约）；Python 无此参。
// ③ `_gate_lock` 退化为**单线程原子段**：Node 事件循环里同一同步块不可能被并发
//    进入，故不设锁；代价是**同步段内不许 await**（Python 持锁期间的 DB 写在
//    Node 必须全同步——`db.withWriteDb` 已强制 `fn` 同步）。
// ④ Python `int(x)` 的 Unicode 数字面（`'١٢'`）按仓库 ASCII 口径登记为偏差
//    （spec §23.7）；下划线分隔（`'1_0'`）与两侧空白照 Python 接受。
// ══════════════════════════════════════════════════════════════════════════

// ---------- 进程内登记表（M5-2/M5-3 写入；M5-1 只读） ----------

/** 卡片会话看管表（Python `board._RUNS`）：cardId → 运行条目对象。 */
const RUNS = new Map();

/** worktree 直起窗口（Python `board._WT_STARTING`）：在场即「起跑中，无 c: 行」。 */
const WT_STARTING = new Set();

/**
 * 看管表访问面。Python 侧 `_RUNS` 是模块私有 dict + `_runs_lock`；Node 单线程无锁，
 * 但**不让外部直接拿 Map**：M5-2 起 `startCard`/`watchOnce`/`finishRun` 都写它，
 * 读写经这里收口，等价于 Python 的「同一把锁下的同一张表」。
 */
export const runRegistry = {
  get: (cardId) => RUNS.get(cardId),
  has: (cardId) => RUNS.has(cardId),
  set: (cardId, rec) => { RUNS.set(cardId, rec); return rec; },
  delete: (cardId) => RUNS.delete(cardId),
  keys: () => [...RUNS.keys()],
  get size() { return RUNS.size; },
};

/** worktree 起跑窗口登记集访问面（Python `_wt_start_begin`/`_wt_start_end`）。 */
export const wtRegistry = {
  has: (cardId) => WT_STARTING.has(cardId),
  add: (cardId) => { WT_STARTING.add(cardId); return cardId; },
  delete: (cardId) => WT_STARTING.delete(cardId),
  get size() { return WT_STARTING.size; },
};

// ---------- 跨批钩子（注入式缝） ----------

/**
 * 钩子名 → 到期里程碑（未注入时的错误文案里点名，便于定位「谁还没搬」）。
 *
 * M5-2 追加的四个键（`syncSessions`/`iwClear`/`feishuCardReview`/`ensureWatch`/
 * `watchBeforeDelivery`/`isSubagent`/`feishuCardBlocked`）都是**我的函数体确实要调、但归属 M5-3/M7** 的口：
 * 依用户口径「加新缝，别自己发明简化实现」。`syncSessions` 尤其要留缝而不是删调用——
 * 删了会让 `extRefresh` 的「会话在跑但平台无卡」窗口重新打开（R15 改探测对象的初衷）。
 */
const HOOK_MILESTONES = Object.freeze({
  enterDoing: 'M5-2（起跑与会话驱动）',
  stopCard: 'M5-2（起跑与会话驱动）',
  finish: 'M5-2（收尾与补位）',
  archiveCardSessions: 'M5-3（归档双向同步）',
  syncSessions: 'M5-3（sync 会话归类）',
  iwClear: 'M5-3（交互调和器）',
  ensureWatch: 'M5-3（外部会话看管声明）',
  watchBeforeDelivery: 'M5-3（外部会话看管声明）',
  isSubagent: 'M5-3（sync 会话归类 / sessparse.is_subagent）',
  feishuCardReview: 'M7（飞书推送）',
});

/** 钩子表：值为 null 表示「本批还没搬到」。 */
const HOOKS = {
  enterDoing: null, stopCard: null, finish: null, archiveCardSessions: null,
  syncSessions: null, iwClear: null, ensureWatch: null, watchBeforeDelivery: null,
  isSubagent: null, feishuCardReview: null, feishuCardBlocked: null,
};

/** 看板钩子未注入（响亮失败；对应 M4 的 `UnitHandlerMissing` 口径）。 */
export class BoardHookMissing extends Error {
  constructor(name) {
    super(`看板钩子未注入：${name}（到期 ${HOOK_MILESTONES[name] || '未登记'}）`);
    this.name = 'BoardHookMissing';
    this.hook = name;
  }
}

/**
 * 注入跨批钩子（M5-2/M5-3 落地时由本文件末尾统一调用；也供单测注入桩）。
 * 未知钩子名**报错**（拼错名字必须当场炸，不许静默收下变成「注入了但没生效」）。
 * @param {{enterDoing?: Function, stopCard?: Function, finish?: Function,
 *          archiveCardSessions?: Function}} [hooks]
 */
export function setBoardHooks(hooks = {}) {
  for (const [name, fn] of Object.entries(hooks)) {
    if (!Object.prototype.hasOwnProperty.call(HOOKS, name)) {
      throw new Error(`未知看板钩子：${name}`);
    }
    HOOKS[name] = fn;
  }
}

/** 当前钩子表快照（只读；测试与诊断用）。 */
export function boardHooks() { return { ...HOOKS }; }

/** 取钩子；未注入即抛 `BoardHookMissing`。 */
function hook(name) {
  const fn = HOOKS[name];
  if (typeof fn !== 'function') throw new BoardHookMissing(name);
  return fn;
}

/**
 * 取**可选**钩子；未注入返回 null（调用方按 Python 的「该分支不存在」降级）。
 *
 * 为什么不一律响亮失败：这四个口的 Python 调用点本来就带「不可用即降级」语义——
 * `_ensure_watch` 只在驱动 404（池外）时才被调到、`_watch_before_delivery` 只对池外会话
 * 做声明、`_iw_clear` 清的是内存缓存、`sessparse.is_subagent` 抛异常按 False 处置。
 * 未注入时按「该条件不成立」走，**不改变任何可达路径的判定结果**（M5-3 补齐后逐点恢复）。
 * 但 `enterDoing`/`stopCard`/`finish`/`archiveCardSessions` 四个口是**必经之路**，
 * 一律走 `hook()` 响亮失败——静默会让「卡片根本没动」看起来像成功。
 *
 * @param {string} name
 * @returns {Function|null}
 */
function optionalHook(name) {
  const fn = HOOKS[name];
  return typeof fn === 'function' ? fn : null;
}

// ---------- Python `int()` 的宽松版（解析失败给 null） ----------

/**
 * Python `int(x)` 的宽松对应物：**解析失败返回 `null`**（Python 抛 ValueError）。
 *
 * 口径与 `http.js:pyIntStrict` / `query.js` 一致：两侧 ASCII 空白 + 可选符号 +
 * ASCII 十进制数字（数字之间可夹单个下划线）。数字类型按 Python 语义截断：
 * 整数原样、浮点向零截断（`int(7.9)` = 7）、布尔 0/1、`NaN`/`Infinity` ⇒ null。
 * Unicode 数字（`'١٢'`）不接受——全仓 ASCII 口径，见文件头差异 ④。
 * @param {unknown} value
 * @returns {number|null}
 */
export function pyIntLoose(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return null;
  const body = value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
  if (!/^[+-]?\d(?:_?\d)*$/.test(body)) return null;
  const n = Number(body.replaceAll('_', ''));
  return Number.isFinite(n) ? n : null;
}

// ---------- 四条小判据（board.py:1863-1904 / 3797-3812） ----------

/** 卡片是否有平台在管的运行中会话（Python `_has_active_run`：`_RUNS` 有条目即真）。 */
export function hasActiveRun(cardId) { return RUNS.has(cardId); }

/** worktree 直起窗口在场（Python `_wt_in_flight`）。 */
export function wtInFlight(cardId) { return WT_STARTING.has(cardId); }

/**
 * 卡片会话条目在途判定（Python `_session_in_flight`）。
 *
 * 单族化后条目恒为 dsh（`proc=null`）⇒ 有条目即在途（起跑证实→收尾之间，
 * 宽限期内 busy 未起同样在途，防重入起第二会话）。`proc` 分支保留为防御
 * （历史残留条目）：Node 的 `proc.exitCode === null && signalCode === null`
 * 等价 Python `proc.poll() is None`。
 * @param {number} cardId
 * @returns {boolean}
 */
export function sessionInFlight(cardId) {
  const rec = RUNS.get(cardId);
  if (rec === undefined) return false;
  const proc = rec.proc;
  if (proc === null || proc === undefined) return true;
  return proc.exitCode === null && proc.signalCode === null;
}

/**
 * 活跃 `c:` 行（starting/running/finishing）在场判定（Python `_card_unit_active`，裁决 R6）。
 * 读失败按**不在场**（不阻断开始路径；后续写操作自会报错）。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function cardUnitActive(cardId, options = {}) {
  let row;
  try {
    row = getActive(KIND_CARD, cardId, options);
  } catch {
    return false;
  }
  return row !== null && row !== undefined
    && (row.state === STARTING || row.state === RUNNING || row.state === FINISHING);
}

/**
 * 平台是否持有该卡单元（Python `_platform_holds`）：活跃 `c:` 行 ∨ 在管条目。
 * 两个消费面：ext 行互斥判据、手势运行位判据（`gestureRunPosition`）。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function platformHolds(cardId, options = {}) {
  if (hasActiveRun(cardId)) return true;
  return cardUnitActive(cardId, options);
}

/**
 * 行所属单元是否仍由平台在管（Python `unit_managed`，board.py:1730）——M5-3 漏搬、M5 接线补齐。
 *
 * `waitq.selfcheckUnits` 的 `managed` 判据注入面：**看板卡有在管条目（`_RUNS`）⇒ 其收尾归
 * 巡视 `finishRun`，周期自检不越权收口它的行**。典型形态是「dsh 会话刚结束、巡视尚未收尾」——
 * 行证据已陈旧，但 30s 巡视才是收口权威；自检若抢先，`cardFinished` 的 (running, finishing)
 * 门禁见行已终态，会把一次成功会话的终态写死成 failed（审计污染 + 瞬时 I1 自报）。
 * `_RUNS` 无条目的卡死行不受本判据保护——自检是那种行的唯一恢复路径。
 * t:/m:/a: 行不在判据面（平台在管面 = 看板卡会话）。
 *
 * @param {object} row wait_items 行
 * @returns {boolean}
 */
export function unitManaged(row) {
  if (row === null || row === undefined || row.kind !== KIND_CARD) return false;
  const cid = pyIntLoose(row.target_id);
  if (cid === null) return false;      // Python `int()` 抛 ValueError/TypeError ⇒ False
  return hasActiveRun(cid);
}

/** `unit_managed` 的 Python 名别名。 */
export const _unit_managed = unitManaged;

/** 手势「运行位」状态集（Python `_GESTURE_RUN_STATES`）。 */
const GESTURE_RUN_STATES = Object.freeze([STARTING, RUNNING, FINISHING]);

/**
 * 手势「运行位」判据（Python `_gesture_run_position`，收口轮 C1）：
 * = 平台持有该卡单元 ∧ 非 answer 占位。
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function gestureRunPosition(cardId, options = {}) {
  return !isAnswerPending(cardId, options) && platformHolds(cardId, options);
}

/**
 * 卡片是否处于「起跑窗口」（Python `_starting_window`，2026-10-07 卡 902/903 实障）。
 *
 * 三条起跑路径各自的窗口表征：统一队列路径 = `c:` 行 `starting`；worktree 直起
 * 路径 = `_WT_STARTING` 在场；**已登记在管条目 = 已证实起跑，一律不算窗口**
 * （否则「送达恢复」那种 running 行而无在管条目的形态会被吞掉，会话结束落不回待审核）。
 * @param {number} cardId
 * @param {Set<number>|null} [startingIds] 调用方批量预取（`waitq.startingCardIds()`）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function startingWindow(cardId, startingIds = null, options = {}) {
  if (hasActiveRun(cardId)) return false;
  const ids = startingIds === null || startingIds === undefined
    ? startingCardIds(options) : startingIds;
  return ids.has(cardId) || wtInFlight(cardId);
}

// ---------- 卡片依赖（board.py:281-312） ----------

/**
 * `cardId` 的全部后代 id 集合（沿 `parent_card_id` 链向下；防循环依赖用）。
 * @param {number} projectId
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Set<number>}
 */
export function descendantIds(projectId, cardId, options = {}) {
  const children = new Map();
  for (const r of dbmod.listBoardCards(projectId, options)) {
    if (r.parent_card_id) {
      if (!children.has(r.parent_card_id)) children.set(r.parent_card_id, []);
      children.get(r.parent_card_id).push(r.id);
    }
  }
  const out = new Set();
  const stack = [cardId];
  while (stack.length) {
    const cur = stack.pop();
    for (const cid of children.get(cur) || []) {
      if (!out.has(cid)) { out.add(cid); stack.push(cid); }
    }
  }
  return out;
}

/** `_descendant_ids` 的 Python 名别名（量具按 Python 名派发用）。 */
export const _descendant_ids = descendantIds;

/**
 * 设置父任务依赖（Python `set_parent`）。
 * 自身/后代/非法值/跨项目/父卡已删 ⇒ 返回 `'cycle'`；否则落库返回 `null`。
 * @returns {string|null}
 */
export function setParent(projectId, cardId, parentId, options = {}) {
  let parent = parentId;
  if (parent) {
    const pid = pyIntLoose(parent);
    if (pid === null) return 'cycle';   // 非数字输入按非法依赖处理（Python 同）
    if (pid === cardId || descendantIds(projectId, cardId, options).has(pid)) return 'cycle';
    const row = dbmod.getBoardCard(pid, options);
    if (row === null || row === undefined || row.project_id !== projectId) return 'cycle';
    if (row.trashed) return 'cycle';    // 父卡已在回收站 ⇒ 列表/依赖树均不可见
    parent = pid;
  }
  dbmod.updateBoardCard(cardId, true, { parent_card_id: parent || null }, options);
  return null;
}

/** `set_parent` 的 Python 名别名。 */
export const _set_parent = setParent;

// ---------- 移列总入口（board.py:315-439） ----------

/**
 * 移列总入口（服务端仲裁，Python `move_card`）。
 *
 * 返回 `[card, null]` 或 `[null, err]`；`err` 三种：`{error}`（硬错误，列未变）、
 * `{blocked: 'parent-not-done'}`（父任务拦截，列未变）、`{merge_pending}`（独立
 * worktree 卡进「已完成」且有未回流提交，列未变）。queue 拦截不算错误：卡片落
 * 「正在开发」列排队占位（`block_kind='queue'`）入统一队列，正常返回。
 *
 * 规则照 Python：doing 不可直接拖回 todo；同列非 doing 早退；doing→doing 走手势
 * 映射（`doingGesture`）；跨列默认落目标列尾（MAX+1，与建卡同语义）；目标列排序为
 * manual 且传 `beforeId` 时整列重写 `sort_order` 插到 before 之前；落列一律
 * `mark_unread=false`（拖列是用户本人操作，不给自己提醒）；离开 doing 即出队；
 * 非 doing 列卡移列防御性停会话；手动进 blocked 记 `block_kind='manual'`；
 * 进 done 前先过「待合并提交闸」与归档同步（归档先行，失败即整体放弃）。
 *
 * @param {object} project 项目行
 * @param {number} cardId
 * @param {string} target 目标列
 * @param {string} [blockText] 手动阻塞文本
 * @param {number|string|null} [beforeId] 目标位置卡（manual 列才生效）
 * @param {boolean} [mergeAck] 「仅通过」= 跳过待合并闸
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {[object|null, object|null]}
 */
export async function moveCard(project, cardId, target, blockText = '', beforeId = null,
  mergeAck = false, options = {}) {
  const card = dbmod.getBoardCard(cardId, options);
  if (card === null || card === undefined) return [null, { error: 'card not found' }];
  if (!COLUMNS.includes(target)) return [null, { error: 'bad column' }];
  const src = card.column_key;
  if (src === target) {
    if (target !== 'doing') return [cardJson(card, {}, options), null];
    // doing→doing 同列拖放：手势映射（force / 停止 / 调序 / no-op 四分支）
    return doingGesture(project, card, beforeId, options);
  }
  if (src === 'doing' && target === 'todo') {
    return [null, { error: 'doing 不可直接拖回 todo' }];
  }
  // 待合并提交闸（2026-10-07）：**放在归档同步之前**——这条分支要「列不动」地返回，
  // 先归档再问会把会话归档了却没过卡，留下不一致状态。
  if (target === 'done' && src !== 'done' && !mergeAck) {
    const pend = mergePending(project, card);
    if (pend) return [null, { merge_pending: pend }];
  }
  // 归档同步（2026-10-05）：**归档先行**——先落列再归档的话，失败回滚要连
  // 「已停会话/已出队/已改排序」一起退；先行失败则一个字节都没动。
  // 拖入 doing 的取消归档在 `enterDoing` 里做（start 端点同经该入口，单一写点）。
  if (target === 'done' && src !== 'done') {
    // 形参照实现（M5-3 `archiveCardSessions`）**逐位对齐**且**必须 await**：
    // `(card, archived, reason, {strict, options})`——错位会让 `options` 落空、内层 db 调用
    // 回落缺省库路径（M5-2 事故，见 doc/ai/bug_report/20261012-*）；不 await 则永远拿到
    // 一个真值 Promise，「归档失败」分支会被恒真触发（甚至把正常移列判成失败）。
    const err = await hook('archiveCardSessions')(card, true, '进入已完成', { options });
    if (err) return [null, { error: err }];
  }
  if (src === 'done' && target !== 'done' && target !== 'doing') {
    const err = await hook('archiveCardSessions')(card, false, '离开已完成', { options });
    if (err) return [null, { error: err }];
  }
  if (target === 'doing') {
    // 形参照 Python `_enter_doing(project, card, extra="", force=False, worktree=False,
    // queueWorktree=False, options)` **逐位对齐**（7 个位置，一个都不能少）：
    //   · 首版误用对象形态（`{options}` 当第 3 参）⇒ 落进 `extra`，量具照出
    //     `wait_items.meta.extra === '[object Object]'`（gate_move 246 处差异的主因）；
    //   · 中途漏传一位（只给 6 参）⇒ `options` 落进 `queueWorktree`，实现内层拿不到 `{db}`
    //     而**回落缺省库路径**：单测因此写到了生产库（第三起误写事故）。
    // 两处都是量具/单测抓出来的真事故；`m3fixture.freshDb` 的进程级 env 兜底闸是第二道防线。
    return hook('enterDoing')(project, card, '', false, false, false, options);
  }
  const fields = { column_key: target };
  if (target === 'blocked') {
    fields.block_kind = 'manual';
    fields.block_text = blockText || '';
  } else {
    fields.block_kind = null;
    fields.block_text = '';
  }
  if (src === 'todo') fields.scheduled_at = null;   // 离开待开发清定时
  if (beforeId !== null && beforeId !== undefined
      && settingsOf(card.project_id, options).sort[target] === 'manual') {
    // 跨列插入指定位置（manual 列）：整列重写 sort_order，把卡插到 before 之前
    // （与 reorder_card 同语义）。先校验 before_id 在该列，否则 400（防误插他列/凭空卡）
    const colCards = dbmod.listBoardCards(card.project_id, options)
      .filter((r) => r.column_key === target);
    let plan;
    try {
      plan = moveIntoPlan(colCards, cardId, beforeId);
    } catch (e) {
      if (e instanceof PlanError) return [null, { error: e.message }];
      throw e;
    }
    dbmod.withWriteDb(options, (handle) => {
      const stmt = handle.prepare('UPDATE board_cards SET sort_order=? WHERE id=?');
      for (const [cid, order] of plan) stmt.run(order, cid);
    });
  } else {
    // 跨列移卡落目标列尾（manual 列拖入即列尾；与建卡 MAX+1 同语义）
    dbmod.withWriteDb(options, (handle) => {
      const row = handle.prepare(
        'SELECT COALESCE(MAX(sort_order),0)+1 AS sort_order FROM board_cards'
        + ' WHERE project_id=? AND column_key=?',
      ).get(card.project_id, target);
      fields.sort_order = row.sort_order;
    });
  }
  dbmod.updateBoardCard(cardId, false, fields, options);
  if (isAnswerPending(cardId, options)) {
    // 拖离当前列 = 放弃该卡已作答·待送达的答案（2026-09-17）：覆盖 doing/queue
    // 直接落手动阻塞等不走 stop_card 的路径；停止/删除路径的清理在 stop_card。
    waitqCancel(KIND_ANSWER, cardId, '停止/移列放弃', null, options);
    const inst = runnerMod.INSTANCE;
    if (inst !== null && inst !== undefined) inst.removeAnswer(cardId, options);
  }
  if (card.block_kind === 'queue') {
    // 排队占位拖离：显式出队（行已终态/占位已被上方落列写改写则守卫 no-op）
    cancelCardWait(cardId, '卡片出队', options);
  }
  if (src === 'doing' && target === 'blocked') {
    if (card.block_kind === 'queue') {
      // 排队占位卡无会话无工作区改动（行已在上方显式出队），直接落手动阻塞
    } else {
      // 拖入阻塞 = 离开开发容器 ⇒ 出队（v3b 统一原语：停会话 + 行收口）
      // 注意：`leaveDoing` 是**本文件内部函数**（不是注入缝）——它自己再调
      // `stopCard`/`finish` 两条缝，故这里直接调用，多包一层钩子只会多一处失败面。
      await leaveDoing(dbmod.getBoardCard(cardId, options),
        { stop: true, reason: '出队-拖入阻塞', options });
    }
  } else if (src === 'doing') {
    // 离开开发列即出队——拖入 review/done 时先停会话再行收口
    await leaveDoing(dbmod.getBoardCard(cardId, options),
      { stop: true, reason: '移列释放', options });
  } else if (target !== 'doing') {
    // 防御：非 doing 列的卡也不应留活会话（如评论投递在 review 卡拉起的 headless 续接）
    // 形参照 M5-2 的 `stopCard(cardId, options = {})`：第 2 参就是 **db options 袋**
    // ——M5-1 首版传 `{options}`（嵌套一层）会让它内部的读口拿不到 `{db}` 而回落到
    // **缺省库路径（生产库）**，是比 `extra` 那处更安静的坑（量具的 dump 比对会照出来）。
    await hook('stopCard')(cardId, options);
  }
  return [cardJson(dbmod.getBoardCard(cardId, options), {}, options), null];
}

/** `move_card` 的 Python 名别名。 */
export const _move_card = moveCard;

/**
 * 落点上界 seq（Python `_drop_prev_seq`）：项目活跃行中 seq < nextSeq（null=列尾取全体）
 * 且非被拖行的最大 seq；无则 null（区首）。
 */
function dropPrevSeq(projectId, nextSeq, excludeRowId, options = {}) {
  let prev = null;
  for (const r of activeItems(projectId, options)) {
    if (r.id === excludeRowId) continue;
    if (nextSeq !== null && r.seq >= nextSeq) continue;
    if (prev === null || r.seq > prev) prev = r.seq;
  }
  return prev;
}

/** `_drop_prev_seq` 的 Python 名别名。 */
export const _drop_prev_seq = dropPrevSeq;

/** 落点上方（seq < nextSeq；null=列尾）的等待区卡数（Python `_waiting_cards_above`）。 */
function waitingCardsAbove(projectId, nextSeq, options = {}) {
  let n = 0;
  for (const r of activeItems(projectId, options)) {
    if (r.kind !== KIND_CARD || r.state !== STATE_WAITING) continue;
    if (nextSeq !== null && r.seq >= nextSeq) continue;
    n += 1;
  }
  return n;
}

/** `_waiting_cards_above` 的 Python 名别名。 */
export const _waiting_cards_above = waitingCardsAbove;

/**
 * doing→doing 同列拖放的手势映射（Python `_doing_gesture`，v2c T1 裁决 R10）。
 *
 * 四分支：等待卡落运行位 = force 手势（`enterDoing(force=true)` + best-effort 挪序）；
 * 运行卡落等待区深处 = 停止手势（递归 `moveCard(…, 'review')`）；等待卡落等待区 =
 * 调序（`waitq.reposition`）；运行卡落运行位 = no-op。非队列卡（sync/idle/answer
 * 占位）不参与手势，原样返回 200。
 * @returns {[object|null, object|null]}
 */
export async function doingGesture(project, card, beforeId, options = {}) {
  const dragRow = getActive(KIND_CARD, card.id, options);
  const dragRun = dragRow === null || dragRow === undefined
    ? gestureRunPosition(card.id, options)
    : GESTURE_RUN_STATES.includes(dragRow.state);
  if ((dragRow === null || dragRow === undefined) && !dragRun) {
    return [cardJson(card, {}, options), null];   // 非队列卡：无手势语义
  }
  let beforeRow = null;
  let beforeSeq = null;
  let beforeRun = false;
  if (beforeId !== null && beforeId !== undefined) {
    const bid = pyIntLoose(beforeId);
    if (bid === null) return [null, { error: '目标位置卡不在该列' }];
    if (bid === card.id) return [cardJson(card, {}, options), null];  // 自己压自己=no-op
    const beforeCard = dbmod.getBoardCard(bid, options);
    if (beforeCard === null || beforeCard === undefined || beforeCard.trashed
        || beforeCard.project_id !== card.project_id
        || beforeCard.column_key !== 'doing') {
      return [null, { error: '目标位置卡不在该列' }];
    }
    beforeRow = getActive(KIND_CARD, bid, options);
    if (beforeRow === null || beforeRow === undefined) {
      if (!gestureRunPosition(bid, options)) {
        return [cardJson(card, {}, options), null];   // 落点卡非队列成员：无手势语义
      }
      // 落点卡无活跃行但在管（起跑/收尾窗口）：按运行位处理；无行即无落点 seq
      beforeSeq = null;
      beforeRun = true;
    } else {
      beforeSeq = beforeRow.seq;
      beforeRun = GESTURE_RUN_STATES.includes(beforeRow.state);
    }
  }
  const pid = card.project_id;
  if (dragRun) {
    if (beforeRun) return [cardJson(card, {}, options), null];   // 运行位互拖：no-op
    if (waitingCardsAbove(pid, beforeSeq, options) === 0) {
      // 落等待区最前 = 运行位尾：no-op（防同位拖放误停运行中会话）
      return [cardJson(card, {}, options), null];
    }
    // 停止手势：复用「离开 doing 先停后释放」路径落待审核（递归一层，幂等）
    return moveCard(project, card.id, 'review', '', null, false, options);
  }
  if (beforeRun) {
    // force 手势：跨过运行位往上拖 = 强制运行（落哪算哪，v2 §2.2 例外）
    // 形参逐位对齐 Python `_enter_doing(project, card, extra, force, worktree, ...)`（见 moveCard 同款注释）
    const [newCard, err] = await hook('enterDoing')(project, dbmod.getBoardCard(card.id, options),
      '', true, false, false, options);
    if (err !== null && err !== undefined) return [null, err];
    const row = getActive(KIND_CARD, card.id, options);
    if (row !== null && row !== undefined && beforeSeq !== null) {
      try {
        reposition(row.id, dropPrevSeq(pid, beforeSeq, row.id, options), beforeSeq, options);
      } catch {
        // best-effort：起跑已成功，挪序失败不翻转手势结果
      }
    }
    return [newCard, null];
  }
  // 调序手势：等待区内部（before 等待卡 / 列尾）
  const prevSeq = dropPrevSeq(pid, beforeSeq, dragRow.id, options);
  if (prevSeq === null && beforeSeq === null) {
    return [cardJson(card, {}, options), null];   // 队列仅自身：无位可挪
  }
  try {
    reposition(dragRow.id, prevSeq, beforeSeq, options);
  } catch {
    return [null, { error: '调序落点非法' }];
  }
  return [cardJson(dbmod.getBoardCard(card.id, options), {}, options), null];
}

/** `_doing_gesture` 的 Python 名别名。 */
export const _doing_gesture = doingGesture;

// ---------- 列内拖排（board.py:595-721） ----------

/** 重排纯函数的入参非法（Python `ValueError`）。 */
export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

/**
 * 列内重排纯函数（Python `reorder_plan`，单测覆盖）：`cards` = 该列当前有序卡片行列表。
 * 返回 `[[cardId, sortOrder]]` 全列重写清单（1..n）；把 `cardId` 插到 `beforeId` 之前
 * （`beforeId=null` 列尾）。不在列内抛 `PlanError`（调用方转 400）。
 * @returns {Array<[number, number]>}
 */
export function reorderPlan(cards, cardId, beforeId) {
  const ids = cards.map((c) => c.id);
  if (!ids.includes(cardId)) throw new PlanError('卡片不在目标列');
  if (beforeId !== null && beforeId !== undefined && !ids.includes(beforeId)) {
    throw new PlanError('目标位置卡不在该列');
  }
  let before = beforeId;
  if (before === cardId) before = null;    // 自己压自己按列尾处理（防御）
  const moving = cards.find((c) => c.id === cardId);
  const rest = cards.filter((c) => c.id !== cardId);
  const out = [];
  let placed = false;
  for (const c of rest) {
    if (!placed && before !== null && before !== undefined && c.id === before) {
      out.push(moving);
      placed = true;
    }
    out.push(c);
  }
  if (!placed) out.push(moving);
  return out.map((c, i) => [c.id, i + 1]);
}

/** `reorder_plan` 的 Python 名别名。 */
export const _reorder_plan = reorderPlan;

/**
 * 跨列插入纯函数（Python `move_into_plan`）：`colCards` = 目标列当前有序卡片行列表
 * （不含被移动卡）。返回 `[[cardId, sortOrder]]` 整列重写清单（1..n）——被移动卡自身
 * 序号含在内，调用方统一落库。`beforeId` 不在列内抛 `PlanError`。
 * @returns {Array<[number, number]>}
 */
export function moveIntoPlan(colCards, cardId, beforeId) {
  if (beforeId !== null && beforeId !== undefined
      && !colCards.some((c) => c.id === beforeId)) {
    throw new PlanError('目标位置卡不在该列');
  }
  const out = [];
  let placed = false;
  for (const c of colCards) {
    if (!placed && beforeId !== null && beforeId !== undefined && c.id === beforeId) {
      out.push(cardId);
      placed = true;
    }
    out.push(c.id);
  }
  if (!placed) out.push(cardId);
  return out.map((cid, i) => [cid, i + 1]);
}

/** `move_into_plan` 的 Python 名别名。 */
export const _move_into_plan = moveIntoPlan;

/**
 * 列内拖排入口（Python `reorder_card`，v2c T2 裁决 R11）。
 * doing 列走 `waitq` 位次（`reorderDoingCard`）；其余列仅 manual 模式可用。
 * 返回 `null` = 成功，字符串 = 错误（server 转 400）。
 * @returns {string|null}
 */
export function reorderCard(projectId, cardId, beforeId, options = {}) {
  const card = dbmod.getBoardCard(cardId, options);
  if (card === null || card === undefined || card.project_id !== projectId) return '卡片不存在';
  const col = card.column_key;
  if (col === 'doing') return reorderDoingCard(projectId, card, beforeId, options);
  if (settingsOf(projectId, options).sort[col] !== 'manual') {
    return '当前列排序方案非手动，不可拖排';
  }
  const cards = dbmod.listBoardCards(projectId, options).filter((r) => r.column_key === col);
  let plan;
  try {
    plan = reorderPlan(cards, cardId, beforeId);
  } catch (e) {
    if (e instanceof PlanError) return e.message;
    throw e;
  }
  dbmod.withWriteDb(options, (handle) => {
    // plan 元组为 (cardId, sortOrder)，SQL 占位符顺序为 (sortOrder, id)——此处换位绑定
    // （Python brief 原文直绑会把两列互换导致整列错序/空写，Node 照抄修正后的绑定）
    const stmt = handle.prepare('UPDATE board_cards SET sort_order=? WHERE id=?');
    for (const [cid, order] of plan) stmt.run(order, cid);
  });
  return null;
}

/** `reorder_card` 的 Python 名别名。 */
export const _reorder_card = reorderCard;

/**
 * doing 列调序（Python `_reorder_doing_card`）：改写 `wait_items` 队序
 * （waiting 行间重排，仅 UPDATE seq、行 id 稳定；`sort_order` 不动）。
 * 运行位行与非队列卡不参与（no-op 返回成功）；`beforeId` 指向运行位/非队列卡时
 * 收拢到等待区最前；beforeId 卡须同项目同列非回收站，否则错误文案与 `reorder_plan` 一致。
 * @returns {string|null}
 */
export function reorderDoingCard(projectId, card, beforeId, options = {}) {
  let beforeRow = null;
  let before = beforeId;
  if (beforeId !== null && beforeId !== undefined) {
    const bid = pyIntLoose(beforeId);
    if (bid === null) return '目标位置卡不在该列';
    if (bid === card.id) return null;      // 自己压自己=no-op（与手势同口径防御）
    const beforeCard = dbmod.getBoardCard(bid, options);
    if (beforeCard === null || beforeCard === undefined || beforeCard.trashed
        || beforeCard.project_id !== projectId
        || beforeCard.column_key !== 'doing') {
      return '目标位置卡不在该列';
    }
    before = bid;
    beforeRow = getActive(KIND_CARD, bid, options);
  } else {
    before = null;
  }
  const dragRow = getActive(KIND_CARD, card.id, options);
  if (dragRow === null || dragRow === undefined || dragRow.state !== STATE_WAITING) {
    return null;                            // 运行位行/非队列卡不参与调序：no-op
  }
  let nextSeq;
  if (beforeRow !== null && beforeRow !== undefined && beforeRow.state === STATE_WAITING) {
    nextSeq = beforeRow.seq;                // 落点 = 该等待卡之前
  } else if (before === null) {
    nextSeq = null;                         // 列尾 = 等待区区尾
  } else {
    // 落点收拢等待区最前：before 运行位/非队列卡 → 排到等待区首
    nextSeq = null;
    for (const r of activeItems(projectId, options)) {
      if (r.kind === KIND_CARD && r.state === STATE_WAITING && r.id !== dragRow.id) {
        nextSeq = r.seq;                    // activeItems seq 升序：首行即区首
        break;
      }
    }
    if (nextSeq === null) return null;      // 等待区仅自身：无位可挪
  }
  const prevSeq = dropPrevSeq(projectId, nextSeq, dragRow.id, options);
  if (prevSeq === null && nextSeq === null) return null;   // 队列仅自身（防御）
  try {
    reposition(dragRow.id, prevSeq, nextSeq, options);
  } catch {
    return '调序落点非法';
  }
  return null;
}

/** `_reorder_doing_card` 的 Python 名别名。 */
export const _reorder_doing_card = reorderDoingCard;

// ---------- 容器迁移 = 出队（board.py:3193-3238） ----------

/**
 * 出队收口（Python `_dequeue_card`，v3b 行收口唯一实现）：卡离开「正在开发」容器即出队。
 *
 * 等待区行经 `waitq.cancelCardWait` 取消（行 + 占位单事务）；运行行经唯一收尾点
 * `finish('c:<id>')` 终态化（`toColumn` 给定则一并归位）。`starting` 行**既不取消
 * 也不收口**——起点行的终态归属「拾取方」（worker finally / starting 超时对账）。
 * 无活跃行时各子步幂等 no-op。
 */
export async function dequeueCard(cardId, { reason = '', toColumn = null, markUnread = true,
  options = {} } = {}) {
  const row = getActive(KIND_CARD, cardId, options);
  if (row === null || row === undefined || row.state === STATE_WAITING) {
    cancelCardWait(cardId, reason, options);
  }
  // `finish` 是同步的（见 M5-2 段「异步口径」），但它是**钩子**：await 一次性把
  // 「钩子返回 thenable」的形态收口，防未处理的拒绝打穿事件循环。
  //
  // **形参口径（与 `enterDoing`/`stopCard` 的 7 位/2 位形态同一批约定）**：第 3 参是
  // 「收尾 opts」＝ `{toColumn, markUnread, ...options}`——db 连接袋**平铺**进来，不再
  // 嵌套一层 `options`。嵌套会让收尾实现拿不到 `{db}` 而静默回落生产库（第三起误写生产库
  // 事故的同一条根因，见 `doc_ai/bug_report/20261012-Node单测误写生产库…/`）。
  return hook('finish')(`c:${cardId}`, reason, { toColumn, markUnread, ...options });
}

/** `_dequeue_card` 的 Python 名别名。 */
export const _dequeue_card = dequeueCard;

/**
 * 卡离开「正在开发」容器（Python `_leave_doing`，v3b 统一原语）。
 *
 * `stop=true`（手动拖入阻塞 / 拖离开发列 / 删除等）：先停会话——`stopCard` 内含
 * 取消本卡排队消息 / 放弃待送达答案，「非 doing 列不得有活会话」。`stop=false`
 * （交互挂起自动落阻塞）：只收行——abort 会清掉等待用户答复的 pending 提问，
 * 且该会话在用户作答后照常续跑，不属「停止」语义。随后经 `dequeueCard` 出队收口。
 */
export async function leaveDoing(card, { stop = true, reason = '', options = {} } = {}) {
  if (stop) await hook('stopCard')(card.id, options);   // 第 2 参＝db options 袋（见 moveCard 同款注释）
  await dequeueCard(card.id, { reason, options });
}

/** `_leave_doing` 的 Python 名别名。 */
export const _leave_doing = leaveDoing;

// ══════════════════════════════════════════════════════════════════════════
// M5-2 写路径：ext 行对账、起跑、会话驱动、提示词拼装、收尾
// （`board.py:754-1040`（ext 族）/ `1040-1502`（起跑）/ `1561-1632`（提示词）/
//   `1794-2660`（会话驱动与收尾）/ `3839-3867`（pid/孤儿行判据））
//
// 交付面：`upsertExt`·`extCandidates`·`extRefresh`·`recoverExtRows`·`refreshExtRows`·
//        `startExtRecoverAfterConnect` / `enterDoing`·`startIntoDoing`·`wtStartBegin`·
//        `wtStartEnd`·`enterDoingWorktree`·`cleanupCardWorktree`·`buildMergeInstruction`·
//        `handoffWorktreeMerge`·`dequeueStart` / `buildTaskPrompt`·`buildContinuePrompt`·
//        `buildStartPrompt` / `startCard`·`startWeb`·`deliverComment`·`deliverUnit`·
//        `deliverNow`·`ensureCardSession`·`stopCard`·`compactSession`·`forkSession`·
//        `forkCompactSession`·`finish`·`deleteCardCleanup`·`finishRun`·`watchRunsOnce`·
//        `runPid`·`orphanHold`。
//
// ── 异步口径（M5-2，用户口径 + 计划 §3.2 修正项）──────────────────────────────
// Python 的 `board.py` 全同步，但其调用链会打到 `dshdriver`（create/resume/compact/
// fork/cancel）与 `chat.dshSend`——Node 侧这些必然是 async。故：
//   · **变 async**：`enterDoing` / `startIntoDoing` / `enterDoingWorktree` / `dequeueStart` /
//     `startCard` / `startWeb` / `deliverComment` / `deliverUnit` / `deliverNow` /
//     `ensureCardSession` / `stopCard` / `compactSession` / `forkSession` /
//     `forkCompactSession` / `handoffWorktreeMerge` / `moveCard` / `doingGesture` /
//     `leaveDoing` / `dequeueCard`（后四者是 M5-1 的函数，为接 async 钩子一并改）。
//   · **保持同步**：ext 行族全族、`build_*_prompt` 三支、`finish`、
//     `finishRun`、`watchRunsOnce`、`runPid`、`orphanHold`、`cleanupCardWorktree`、
//     `buildMergeInstruction`、`wtStartBegin/End`。理由照用户口径：**`finish` 只碰
//     waitq/runner/db，三个口全同步**；ext 族的 `finish("ext:…")` 分支同理。
//   · **为什么 `dequeueCard` 仍改 async**：它 await `hook('finish')`——`finish` 是同步函数，
//     但它是**钩子**，await 一次性把「钩子返回 thenable」的形态收口，避免未处理的拒绝
//     打穿事件循环；`deleteCardCleanup` 随之返回 Promise（M5-4 收敛，见该函数注释）。
//   · 单线程原子段：`_gate_lock` 退化为「同一同步块内不 await」；本文件凡「Python 持锁
//     期间做 DB 写」的段落一律保持全同步，**await 一律落在锁外**（`enterDoing` 的入队前
//     `extRefresh`、worktree 创建、起会话三处显式如此）。
//
// ── 与 Python 的形态差异（逐条，均为形态差异而非行为差异）─────────────────────
//   ① `_WT_STARTING` 的 256 上限清理：Python 在 `_wt_start_begin` 里 `clear()`（超限即全清，
//      「重报无罪」策略）；Node 照抄同一形态（`wtRegistry` 的 size > 256 即 clear）。
//   ② 时间源：Python 用 `time.time()`（秒，浮点）；Node 用 `Date.now()/1000`（同一量纲与
//      精度，`_STOP_GRACE_S`/`_STARTING_ALERT_S` 的差值口径逐点相同）。测试可经
//      `setBoardHooks({now})` 冻结。
//   ③ `_RUNS` 条目的时间字段：Python `started_at` 是**毫秒**；Node 侧 RUNS 条目沿用
//      `started_at`（毫秒），另加 `startedAtSec`（秒）供巡视宽限期比较——两字段同源，
//      不改变任何判据。
//   ④ `_ext_candidates` 的 `os.path.abspath` 比对：Node 用 `path.resolve`（POSIX 下同形；
//      不解析符号链接，与 `abspath` 一致）。
//   ⑤ `sync_sessions` / `_iw_clear` / `_ensure_watch` / `_watch_before_delivery` /
//      `sessparse.is_subagent` / `feishu.card_review` 六个口属 M5-3/M7，走**新增注入缝**
//      （见 `HOOK_MILESTONES`），未注入时按「该分支不存在」降级，绝不静默假装成功。
//   ⑥ `worktree.create` / `worktree.status` / `worktree.remove` 三个写口：**M6-1 已迁入
//      `worktree.js`**（本文件只留 `import { create as wtCreate, … }` 薄别名）。M5-2 曾把
//      它们临时实现在本文件里，并顺手漏掉了 `worktreePath` 的导入 ⇒ `enterDoingWorktree`
//      的直起路径必然 `ReferenceError`（M5 的「未验项：真 worktree create/remove」＝它）。
//      现场与修复见 `backend/test/worktree-write.test.mjs` 的「先红后绿」回归用例。
// ══════════════════════════════════════════════════════════════════════════

// ---------- 常量（board.py:1009-1010 / 1422 / 1557-1558 / 1633-1639 / 2178-2182） ----------

/** 启动补跑等中枢首连的上限（秒）：`board.py:EXT_RECOVER_WAIT_SECONDS` */
export const EXT_RECOVER_WAIT_SECONDS = 30.0;

/** 合并任务指令的段落标记（`board.py:MERGE_TASK_MARK`）：以它开头的 extra 原文直发 */
export const MERGE_TASK_MARK = '【合并任务】';

/** 单卡片 prompt 长度上限（`board.py:PROMPT_MAX`，与 `chat.MESSAGE_MAX` 对齐） */
export const PROMPT_MAX = 20000;

/** starting 态超时阈值（秒）：`board.py:_STARTING_TIMEOUT_S`（= 原 90s 宽限补丁） */
export const STARTING_TIMEOUT_S = 90;

/** unknown 分支告警节流窗（秒）：`board.py:_STARTING_ALERT_S` */
export const STARTING_ALERT_S = 300;

/** 「平台刚停过会话」宽限（秒）：`board.py:_STOP_GRACE_S` */
export const STOP_GRACE_S = 15;

/** 卡片 → 上次告警时间戳（秒）（`board.py:_starting_alert_at`；>256 全清的粗粒度回收） */
const STARTING_ALERT_AT = new Map();

/** 卡片 → 上次 `stopCard` 时间戳（秒）（`board.py:_STOP_STAMP`） */
const STOP_STAMP = new Map();

// ---------- 小工具 ----------

/** 异常 → 文本（`str(e)` 口径：`Error` 取 message，不带类名前缀） */
function errText(err) {
  if (err === null || err === undefined) return '';
  if (err instanceof Error) return String(err.message ?? err);
  return String(err);
}

/** `os.path.abspath` 的对应物（不解析符号链接；`path.resolve` 依赖 cwd） */
function abspath(p) {
  return path.resolve(String(p ?? ''));
}

/** 当前时刻（秒，浮点）——`time.time()` 的同量纲对应物（`STOP_GRACE_S` 等窗宽按秒比差） */
function nowSec() {
  return Date.now() / 1000;
}

/** 当前时刻（毫秒 epoch）——`int(time.time() * 1000)` 的对应物 */
function nowMs() {
  return Math.trunc(nowSec() * 1000);
}

/**
 * 本地时刻格式化（`time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(sec))` 的对应物）。
 *
 * 用途：行 `claimed_at` 的超龄比较（`_reconcile_starting_rows`）——两侧口径必须同为
 * **本地时区文本串**（词法序即时间序）。`toISOString` 是 UTC 且带 `T`/`Z`，不能用于此。
 * @param {number} sec epoch 秒
 * @returns {string}
 */
function formatLocalSec(sec) {
  const d = new Date(Number(sec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 测试注入点：runner 替身（生产链路不调用；`setRunnerInstance(null)` 恢复读真单例） */
let RUNNER_TEST_INSTANCE;
let RUNNER_TEST_SET = false;

/**
 * 注入 runner 替身（**测试专用**；与 `chat.setRunnerInstance` 同款缝）。
 *
 * 为什么需要：Python 测试直接 `runner.INSTANCE = Fake()`，而 Node 的 ESM 命名空间对象不可写
 * （`runnerMod.INSTANCE = x` 会 TypeError）。本函数是 board 侧**唯一** runner 单例读点
 * （`runnerInstance`）的注入面——队列分支（`submitCard` 等）单测靠它，否则只能整条
 * 起真 runner（那会把 worker 线程与真实调度拉进单测）。
 *
 * @param {object|null} inst
 */
export function setRunnerInstance(inst) {
  RUNNER_TEST_INSTANCE = inst === undefined ? null : inst;
  RUNNER_TEST_SET = true;
}

/** 当前 runner 单例（Python `runner.INSTANCE`；ESM 命名空间读活绑定） */
function runnerInstance() {
  if (RUNNER_TEST_SET) return RUNNER_TEST_INSTANCE;
  return runnerMod.INSTANCE === undefined ? null : runnerMod.INSTANCE;
}

/** 调用 runner 单例的方法（单例缺位即不调；返回 null 表示退化路径） */
function withRunner(fn) {
  const inst = runnerInstance();
  return inst === null ? null : fn(inst);
}

/** 该卡是否有平台在管运行（`hasActiveRun` + 快照读，收窄两次 Map 访问间的竞态窗口） */
function runRecord(cardId) {
  return RUNS.get(cardId);
}

// ---------- ext 行族（board.py:773-1037） ----------

/**
 * ext 行 target（卡 id 字符串，`finish("ext:<target>")` 键同源）。Python `_ext_target`。
 * @param {object} row
 * @returns {string}
 */
export function extTarget(row) {
  return String(row.target_id);
}

/** `_ext_target` 的 Python 名别名。 */
export const _ext_target = extTarget;

/**
 * 外部直跑会话 → ext 行（幂等；Python `upsert_ext`）。
 *
 * 已有活跃行 / sid 缺失 / 平台持有者在场（活跃 `c:` 行或在管条目）→ 不建行返回 false。
 * 返回是否**新建**（调用方据变化唤醒补位）。
 *
 * @returns {boolean}
 */
export function upsertExt(project, cardId, sid, options = {}) {
  if (!sid || platformHolds(cardId, options)) return false;
  if (getActive(KIND_EXT, cardId, options) !== null) return false;
  insertExt(project.id, cardId, sid, options);
  return true;
}

/** `upsert_ext` 的 Python 名别名。 */
export const _upsert_ext = upsertExt;

/**
 * 项目活跃 ext 行对账（Python `_ext_stale_finish`）：不在目标集（实况已不 busy/卡已非
 * 占位源）且非探测不明（hold 保行）者经唯一收尾点 `finish` 收口。返回是否有行被收口。
 *
 * **脏 target（非整数，理论项）也照收**：Python 的 `except ValueError: cid = None` 只影响
 * 「是否在目标集/hold 集里」的判定（`None` 恒不在），行本身仍会走
 * `finish(f"ext:{target}")` 正常收口——docstring 里「不能建收尾键，跳过」是**措辞误导**
 * （`finish` 的 `ext:` 键取的就是 target 字符串，脏值同样能建键）。本实现逐行照 Python 行为。
 *
 * @returns {boolean}
 */
export function extStaleFinish(projectId, desired, hold, options = {}) {
  let changed = false;
  for (const row of activeExtItems(projectId, options)) {
    const target = extTarget(row);
    const cid = pyIntLoose(target);
    // 键一律字符串化再查（JS 对象键恒字符串；`desired` 由 `extCandidates` 以数字 id 为键构建
    // ——Python 的 `cid in desired` 是 int 键比较，单测也可能直接传 `{1: 'sid'}`）
    if (cid !== null && (Object.prototype.hasOwnProperty.call(desired, String(cid))
        || hold.has(cid))) {
      continue;
    }
    // 第 3 参＝收尾 opts：db 连接袋平铺（不嵌套 `options`，见 `dequeueCard` 同款注释）
    if (hook('finish')(`ext:${target}`, '外部会话结束', { ...options })) changed = true;
  }
  return changed;
}

/** `_ext_stale_finish` 的 Python 名别名。 */
export const _ext_stale_finish = extStaleFinish;

/**
 * 项目内全部活跃 ext 行收口（Python `_finish_all_ext`；退场族/项目已删的防御清理）。
 * 退场族无 busy 信号、外部条目不可能有实况佐证，残留行留着会永久占前缀位次堵死调度。
 * @returns {boolean}
 */
export function finishAllExt(projectId, reason, options = {}) {
  let changed = false;
  for (const row of activeExtItems(projectId, options)) {
    if (hook('finish')(`ext:${extTarget(row)}`, reason, { ...options })) changed = true;
  }
  return changed;
}

/** `_finish_all_ext` 的 Python 名别名。 */
export const _finish_all_ext = finishAllExt;

/**
 * `{sid: 卡片 row}` 反查（Python `_session_card_map`）：卡片 sessions 并集 + 主会话；
 * 绑定口径与 `sync_sessions` 的 bound 映射一致——外部条目对账与建卡投影看到同一张卡。
 *
 * 坏 `sessions` JSON：Python 抛 ValueError 打穿调用方（由 `_ext_refresh` 的 try 兜住
 * 并按「探测不可用」保行）；Node 侧**照抛**（同一条 try 兜住，行为逐点相同）。
 * @returns {Object<string, object>}
 */
export function sessionCardMap(cards) {
  const bound = {};
  for (const c of cards) {
    for (const s of JSON.parse(c.sessions || '[]')) bound[s] = c;
    if (c.session_id) bound[c.session_id] = c;
  }
  return bound;
}

/** `_session_card_map` 的 Python 名别名。 */
export const _session_card_map = sessionCardMap;

/**
 * 该会话是否 dsh **子代理会话**（Python `_subagent_session`；占用豁免判据）。
 *
 * `origin` 显式传入时用调用方手上的值；未传/为空＝未知 → 回落会话头读口
 * （`sessparse.is_subagent`，属 M5-3 ⇒ **注入缝**）；两处都判不了＝false（按主会话处理：
 * 占用判定宁可多等，不可误放行，与「断连＝未知」同向）。
 *
 * @param {string} sid
 * @param {string|null} [origin]
 * @returns {boolean}
 */
export function subagentSession(sid, origin = null) {
  let val = origin;
  if (val === null || val === undefined) {
    try {
      val = (eventGet(sid) || {}).origin || '';
    } catch {
      val = '';
    }
  }
  if (String(val || '') === 'subagent') return true;
  if (String(val || '')) return false;          // 明确上报了别的 origin（主会话）
  try {
    const fn = optionalHook('isSubagent');
    if (fn === null) return false;              // M5-3 未接线：按主会话（见上「宁可多等」）
    return Boolean(fn(sid));
  } catch {
    return false;
  }
}

/** `_subagent_session` 的 Python 名别名。 */
export const _subagent_session = subagentSession;

/**
 * 项目活跃会话集合 → 占位目标/探测不明卡集（Python `_ext_candidates`，R15）。
 *
 * 返回 `{desired, hold, unbound, unknown}`：
 *   - `desired`：`{card_id: sid}` 实况 busy（单族：读 `dshevents` 快照）；
 *   - `hold`：探测不明的卡——保留既有行（dsh 分支探测失败直接抛错，**恒空集**，
 *     与 Python 同：那条 `hold` 只服务退场族）；
 *   - `unbound`：实况 busy 但尚无卡的 sid（调用方按需补一次 `sync_sessions` 投影）；
 *   - `unknown`：不可结论的 sid 集合（Python 侧恒空集）。
 *
 * 探测域收窄（2026-09-27）：只探「绑候选卡 + 未绑卡」会话——绑在 todo/done/挂起
 * interaction 卡上的会话，busy 进不了 desired 也进不了 hold、又不在未绑卡判定面。
 * 未连接事件中枢 ⇒ **抛错**（调用方按「探测不可用」返回 null＝保行，绝不把未知当空闲）。
 *
 * @param {object} project
 * @param {object[]} cards
 * @returns {{desired: Object<number, string>, hold: Set<number>,
 *            unbound: Set<string>, unknown: Set<string>}}
 */
export function extCandidates(project, cards) {
  const fam = webFamily(project);
  if (fam === null) {
    return { desired: {}, hold: new Set(), unbound: new Set(), unknown: new Set() };
  }
  const withSid = cards.filter((c) => c.session_id);
  const bound = sessionCardMap(withSid);
  // 占用候选（可建行）域：非终态列、非挂起 interaction（挂起即出队，豁免面②）
  const cand = new Set(withSid
    .filter((c) => !['todo', 'done'].includes(c.column_key)
      && !(c.column_key === 'blocked' && c.block_kind === 'interaction'))
    .map((c) => c.id));
  const desired = {};
  const hold = new Set();
  const unbound = new Set();
  const unknown = new Set();
  if (!eventsConnected()) {
    throw new dshMod.DshDriverError(-2, '状态事件中枢未连接（未知：保留既有行）');
  }
  const rows = [...Object.values(eventSnapshot())];
  const pdir = abspath(project.project_dir || '');
  for (const r of rows) {
    const sid = String((r && r.session_id) || '');
    if (!sid || (r && r.status) !== 'running') continue;    // 空闲/未知不构成占用
    // 子代理会话不是外部占用：既不建行，也不进 unbound 触发投影
    if (subagentSession(sid, r.origin)) continue;
    // 只认本项目工作目录下的会话：dsh 会话池是宿主全局的
    if (abspath(String((r && r.cwd) || '')) !== pdir) continue;
    const c = bound[sid];
    if (c === undefined) {
      unbound.add(sid);                    // 在跑但平台无卡：调用方补投影后再反查
    } else if (cand.has(c.id) && !platformHolds(c.id)) {
      desired[c.id] = sid;
    }
  }
  return { desired, hold, unbound, unknown };
}

/** `_ext_candidates` 的 Python 名别名。 */
export const _ext_candidates = extCandidates;

/**
 * 入队/恢复前同步刷新 ext 行（Python `_ext_refresh`，裁决 R13/R15）：闭合「外部会话刚起、
 * 调和器尚未巡到」的窗口。
 *
 * 返回 ext 行集合是否变化（true/false）；**探测不可用**（事件中枢未连接/会话枚举失败）
 * 返回 `null`＝未改动（宁可多等不可误放行，旧口径逐字保留）。退场族无 busy 信号：
 * 不建行、在场残留行防御收口。
 *
 * @param {object} project
 * @returns {boolean|null}
 */
export function extRefresh(project, options = {}) {
  const fam = webFamily(project);
  if (fam === null) return finishAllExt(project.id, '退场族无外部占用信号', options);
  let desired; let hold; let unbound; let unknown;
  try {
    ({ desired, hold, unbound, unknown } = extCandidates(
      project, dbmod.listBoardCards(project.id, options),
    ));
    if (unbound.size) {
      // 实况在跑但尚无卡的会话：补一次投影（sync_sessions 幂等）再反查
      hook('syncSessions')(project, options);
      ({ desired, hold, unbound, unknown } = extCandidates(
        project, dbmod.listBoardCards(project.id, options),
      ));
    }
  } catch {
    return null;
  }
  if (unknown.size && Object.keys(desired).length === 0) {
    return null;                            // 探测不明且无确证 busy：本轮不动（保旧值）
  }
  let changed = extStaleFinish(project.id, desired, hold, options);
  for (const [cid, sid] of Object.entries(desired)) {
    if (upsertExt(project, Number(cid), sid, options)) changed = true;
  }
  return changed;
}

/** `_ext_refresh` 的 Python 名别名。 */
export const _ext_refresh = extRefresh;

/**
 * 服务重启时的 ext 行映射（Python `_recover_ext_rows`；`recover()` 尾部调用）。
 *
 * 刷新面＝**有活跃 ext 行的项目 ∪ 有排队卡的项目**（平台停机期间外部会话起跑时行尚未落表，
 * 只按「有行的项目」刷新会让排队卡所在项目在重启后照旧并发起单元）。项目已删 ⇒ 全部行收口；
 * 探测不可用（null）⇒ 行保留（宁可多等）。返回是否有行变化。
 *
 * @param {object[]} [queued] 本机排队卡行清单（`recover` 已算出，复用免二次查询）
 * @returns {boolean}
 */
export function recoverExtRows(queued = [], options = {}) {
  let changed = false;
  const pids = new Set();
  for (const row of activeExtItems(null, options)) pids.add(row.project_id);
  for (const c of queued || []) pids.add(c.project_id);
  for (const pid of pids) {
    const proj = dbmod.getProject(pid, options);
    if (proj === null || proj === undefined) {
      if (finishAllExt(pid, '服务重启外部条目对账', options)) changed = true;
      continue;
    }
    if (extRefresh(proj, options)) changed = true;
  }
  return changed;
}

/** `_recover_ext_rows` 的 Python 名别名。 */
export const _recover_ext_rows = recoverExtRows;

/**
 * 按项目活跃 ext 行的实况对账刷新（Python `refresh_ext_rows`；周期自检/启动补跑共用入口）。
 *
 * 对「有活跃 ext 行的项目」逐个跑 `extRefresh`（未连接 ⇒ null＝保行，绝不把未知当空闲）；
 * 有行变化即唤醒补位（前缀成员变化，时机③），无变化不空唤醒。返回是否有行变化。
 * 项目已删（行残留）走 `finishAllExt` 防御收口（同 recover 口径）。
 *
 * @param {string} [reason]
 * @returns {boolean}
 */
export function refreshExtRows(reason = '外部条目周期对账', options = {}) {
  let changed = false;
  for (const pid of new Set(activeExtItems(null, options).map((r) => r.project_id))) {
    const proj = dbmod.getProject(pid, options);
    if (proj === null || proj === undefined) {
      if (finishAllExt(pid, reason, options)) changed = true;
      continue;
    }
    if (extRefresh(proj, options)) changed = true;
  }
  if (changed) withRunner((inst) => inst.notifyBusyChange(options));
  return changed;
}

/** `refresh_ext_rows` 的 Python 名别名。 */
export const _refresh_ext_rows = refreshExtRows;

/**
 * 启动补跑：等中枢首连就绪后跑一次 ext 行对账（Python `start_ext_recover_after_connect`）。
 *
 * `board.recover()` 尾部的 ext 对账执行在 `dshevents.start()` **之前** ⇒ 那时探测必然
 * 「不可用」、按「宁可多等」一律保行——上一进程留下的僵尸 ext 行会继续占位、重启也救不回来。
 * 本函数由 server 在 `dshevents.start()` 之后调用：等首连（上限 `timeout`，不阻塞启动与
 * 端口绑定），就绪即跑一次 `refreshExtRows`。
 *
 * **形态差异**：Python 起 `threading.Thread(daemon)` 并返回它供测试 join；Node 单线程事件
 * 循环下用「后台 promise + `waitConnected` 定时器」表达同一语义——返回值是一个
 * `Promise<boolean>`（true＝跑过对账，false＝超时/未配置/异常），调用方可 await（测试）
 * 或忽略（生产，同 daemon 线程的 fire-and-forget 语义）。
 *
 * @param {number} [timeout] 秒
 * @returns {Promise<boolean>}
 */
export function startExtRecoverAfterConnect(timeout = EXT_RECOVER_WAIT_SECONDS) {
  const wait = optionalHook('waitConnected');
  const waiter = wait !== null ? wait : ((sec) => waitConnected(sec * 1000));
  return (async () => {
    try {
      if (!(await waiter(timeout))) return false;   // 未就绪：保行，交给运行期兜底
      refreshExtRows('启动补跑');
      return true;
    } catch (e) {                                   // 守护线程不 crash（同 Python noqa）
      console.log(`[board] 启动补跑 ext 行对账异常: ${errText(e)}`);
      return false;
    }
  })();
}

/** `start_ext_recover_after_connect` 的 Python 名别名。 */
export const _start_ext_recover_after_connect = startExtRecoverAfterConnect;

// ---------- 起跑：进 doing 统一入口（board.py:1040-1236） ----------

/**
 * 进 doing 统一入口（Python `_enter_doing`；start 端点 / 拖入 doing / 定时开工共用）。
 *
 * `force=true`：跳过父依赖与排队直接起会话（用户自担风险），reason 标签分「force 直起」/
 * 「serial 直起」，并**落表**（`insertCardForceStart` 单事务插前缀尾 + 直入 starting）；
 * runner 单例缺位 ⇒ 不入队直接起（脱离 server 调试退化）；其余一律入统一队列。入队落点
 * 分流（R9）：`from_column ∈ (review, blocked)` 经 `insertCardAfterPrefix` 插「运行前缀后」，
 * `todo` 经 `enqueueCard` 落等待区末尾。
 *
 * 退场族防呆：`webFamily === null` ⇒ 不落任何起会话路径，直接 `{error: RETIRED_MSG}`。
 * 独立 worktree 模式：`worktree=true` 或卡片已带 worktree 标记 ⇒ 整体转交
 * `enterDoingWorktree`（不写 `wait_items` 行）；`queueWorktree=true` 是唯一例外
 * （合并回交，必须与项目内其他单元串行）。
 *
 * **async**（内部要 await 驱动起会话）；「Python 持锁期间做 DB 写」的段落全部保持同步，
 * await 只落在锁外（`extRefresh` / worktree 创建 / 起会话三处）。
 *
 * @param {object} project
 * @param {object} card
 * @param {string} [extra]
 * @param {boolean} [force]
 * @param {boolean} [worktree] 用户下拉选「在新 worktree 中开始」
 * @param {boolean} [queueWorktree] worktree 卡也走统一队列（合并回交）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<[object|null, object|null]>}
 */
export async function enterDoing(project, card, extra = '', force = false, worktree = false,
  queueWorktree = false, options = {}) {
  if (webFamily(project) === null) return [null, { error: RETIRED_MSG }];
  // 归档同步：从「已完成」起跑先取消归档（本入口是「离开已完成→doing」的单一写点，
  // `moveCard` 对该目标不再重复调用）。失败即整体放弃（列不动）并 400。
  if (card.column_key === 'done') {
    // 同 `moveCard`：形参逐位对齐 + **必须 await**（async 钩子；见那里的长注释）
    const err = await hook('archiveCardSessions')(card, false, '离开已完成', { options });
    if (err) return [null, { error: err }];
  }
  // 独立 worktree 模式（见 docstring）：queue_worktree 时走下面的排队路径
  if (!queueWorktree && (worktree || String(cardOpt(card, 'worktree') || '').trim())) {
    return enterDoingWorktree(project, card, extra, force, Boolean(worktree), options);
  }
  if (card.column_key === 'doing' && card.block_kind === 'queue' && !force) {
    // 幂等：已在队列（P4 单态：占位仅 doing+queue）。防御性补一次入队（自身幂等）
    withRunner((inst) => inst.submitCard(card.id, '', '', false, options));
    return [cardJson(card, {}, options), null];
  }
  // 在管单元预检（R6）：活跃 c: 行（starting/running/finishing）或在管会话条目在途
  if (cardUnitActive(card.id, options) || sessionInFlight(card.id)) {
    const cur = dbmod.getBoardCard(card.id, options);
    if (cur === null || cur === undefined) return [null, { error: '卡片不存在' }];
    return [cardJson(cur, {}, options), { error: '会话运行中，请等待完成或先停止' }];
  }
  const inst = runnerInstance();
  const wantQueue = inst !== null;
  let forceRowId = null;
  let queued;
  // ── 同步原子段（Python 的 `with _gate_lock:`）──
  if (!force && card.column_key !== 'review') {
    const parentId = card.parent_card_id;
    if (parentId) {
      const parent = dbmod.getBoardCard(parentId, options);
      if (parent !== null && parent !== undefined && parent.column_key !== 'done') {
        return [null, { blocked: 'parent-not-done' }];
      }
    }
  }
  if (!force && wantQueue) {
    queued = true;
  } else {
    // 直起（force / runner 缺位退化）：先清可能残留的排队态，再落 doing
    cancelCardWait(card.id, 'force 直起', options);
    if (force && inst !== null) {
      const [rid] = insertCardForceStart(card.id, project.id,
        { extra: String(extra || ''), from_column: card.column_key }, options);
      forceRowId = rid;
    }
    const fields = {
      column_key: 'doing', block_kind: null, block_text: '', last_error: '',
    };                                        // 落 doing 清陈旧错误
    if (card.column_key === 'todo') fields.scheduled_at = null;   // 离开待开发清定时
    dbmod.updateBoardCard(card.id, false, fields, options);       // 用户本人操作：不置未读
    queued = false;
  }
  // ── 原子段结束 ──
  if (queued) {
    // 入队前同步刷新一次外部条目探测（闭合「外部会话刚起、调和器尚未巡到」的竞态窗口）
    const res = extRefresh(project, options);
    if (res) withRunner((i) => i.notifyBusyChange(options));
    // 入队落点分流（R9）：续跑/手动恢复（review/blocked）插「运行前缀后」= 等待区最前；
    // todo 首次起跑落等待区末尾。此刻卡片行未改列 ⇒ from_column 取到排队前列（R7）。
    inst.submitCard(card.id, extra, '', ['review', 'blocked'].includes(card.column_key), options);
    return [cardJson(dbmod.getBoardCard(card.id, options), {}, options), null];
  }
  try {
    await startCard(project, dbmod.getBoardCard(card.id, options), extra, options);
  } catch (e) {
    // 与 runner 队列拾起（dequeueStart）对撞落败：对方已起跑成功（在管条目在场），
    // 放弃回滚、按当前态返回——否则会把对方落好的 doing 踩回原列
    const rivalRunning = sessionInFlight(card.id);
    if (rivalRunning) {
      if (forceRowId !== null) markFailed(forceRowId, '起跑对撞落败', options);
      return [cardJson(dbmod.getBoardCard(card.id, options), {}, options), null];
    }
    // 起会话失败：回滚原列按硬错误返回（last_error 已由 startCard 记录；此路径不得调 finish）
    if (forceRowId !== null) markFailed(forceRowId, errText(e), options);
    dbmod.updateBoardCard(card.id, false, {
      column_key: card.column_key,
      block_kind: card.block_kind,
      block_text: card.block_text || '',
    }, options);
    return [null, { error: errText(e) }];
  }
  // 直起路径落表占住运行位（v3d 去占用后无第二登记：行即占位），reason 按实参分标签
  if (inst !== null) {
    const ext = { reason: force ? 'force 直起' : 'serial 直起' };
    if (forceRowId !== null) {
      // CLI 判据（R11④）：有 proc 补 pid 进行 evidence（单族恒无 proc ⇒ 不写）
      const pid = runPid(card.id);
      if (pid) ext.pid = pid;
    }
    inst.cardStarted(card.id, project.id, ext, options);
  }
  return [cardJson(dbmod.getBoardCard(card.id, options), {}, options), null];
}

/** `_enter_doing` 的 Python 名别名。 */
export const _enter_doing = enterDoing;

/**
 * start 端点专用（Python `start_into_doing`）：语义全部由 `enterDoing` 承载。
 * @returns {Promise<[object|null, object|null]>}
 */
export function startIntoDoing(project, card, extra = '', force = false, worktree = false,
  queueWorktree = false, options = {}) {
  return enterDoing(project, card, extra, force, worktree, queueWorktree, options);
}

/** `start_into_doing` 的 Python 名别名。 */
export const _start_into_doing = startIntoDoing;

/**
 * 登记 worktree 起跑窗口（Python `_wt_start_begin`）；已在窗口内返回 false（本次让位）。
 * 超 256 全清（「重报无罪」策略，见文件头差异①）。
 * @returns {boolean}
 */
export function wtStartBegin(cardId) {
  if (wtRegistry.has(cardId)) return false;
  if (wtRegistry.size > 256) {
    for (const cid of [...wtRegistry.keys()]) wtRegistry.delete(cid);
  }
  wtRegistry.add(cardId);
  return true;
}

/** `_wt_start_begin` 的 Python 名别名。 */
export const _wt_start_begin = wtStartBegin;

/** 释放 worktree 起跑窗口（Python `_wt_start_end`，finally 调用，幂等）。 */
export function wtStartEnd(cardId) {
  wtRegistry.delete(cardId);
}

/** `_wt_start_end` 的 Python 名别名。 */
export const _wt_start_end = wtStartEnd;

/**
 * 独立 worktree 起跑（Python `_enter_doing_worktree`；**不经统一队列**）。
 *
 * 不写 `wait_items` 行 ⇒ 不占项目运行位、不进补位器视野；会话 cwd 经 `cardWorkspace` 取
 * worktree 路径；父依赖门禁与 `enterDoing` 同口径（worktree 只免排队，不免依赖）；起会话
 * 失败回原列 + 保留 `card.worktree` 标记（路径已建，重按开始即复用）。
 *
 * **async**：内部 await `startCard`（驱动）。
 * @returns {Promise<[object|null, object|null]>}
 */
export async function enterDoingWorktree(project, card, extra = '', force = false,
  want = false, options = {}) {
  const cardId = card.id;
  const cardWt = String(cardOpt(card, 'worktree') || '').trim();
  if (want && !cardWt && String(card.session_id || '').trim()) {
    // D10：已有主会话（当初在 project_dir 起的）不允许切 worktree 模式
    return [null, { error: '该卡片已有主会话，无法切换到独立 worktree（请新建卡片）' }];
  }
  // 在管预检 + 起跑窗口互斥（本路径独有）
  if (cardUnitActive(cardId, options) || sessionInFlight(cardId) || !wtStartBegin(cardId)) {
    const cur = dbmod.getBoardCard(cardId, options);
    if (cur === null || cur === undefined) return [null, { error: '卡片不存在' }];
    return [cardJson(cur, {}, options), { error: '会话运行中，请等待完成或先停止' }];
  }
  try {
    // 父依赖门禁（与排队路径同口径）
    if (!force && card.column_key !== 'review' && !cardWt) {
      const parentId = card.parent_card_id;
      if (parentId) {
        const parent = dbmod.getBoardCard(parentId, options);
        if (parent !== null && parent !== undefined && parent.column_key !== 'done') {
          return [null, { blocked: 'parent-not-done' }];
        }
      }
    }
    // worktree 创建/复用是慢操作（git 子进程，可能数秒），必须在锁外做
    const [p, branch, err] = wtCreate(project, cardId);
    if (err) return [null, { error: err }];
    // 锁外创建期间可能有并发起跑：复检一次，让位给已经在管的那条路，避免双会话
    if (sessionInFlight(cardId)) {
      const cur = dbmod.getBoardCard(cardId, options);
      if (cur === null || cur === undefined) return [null, { error: '卡片不存在' }];
      return [cardJson(cur, {}, options), null];
    }
    // 清可能残留的排队态（用户先点了「开始（入队）」又选 worktree 开始）
    cancelCardWait(cardId, 'worktree 直起', options);
    const fields = {
      column_key: 'doing', block_kind: null, block_text: '', last_error: '', worktree: p,
    };
    if (card.column_key === 'todo') fields.scheduled_at = null;
    dbmod.updateBoardCard(cardId, false, fields, options);   // 用户本人操作：不置未读
    let logPath;
    try {
      logPath = await startCard(project, dbmod.getBoardCard(cardId, options), extra, options);
    } catch (e) {
      // 与并发起跑对撞落败：对方已起跑成功，不动列、直接按当前态返回
      if (sessionInFlight(cardId)) {
        return [cardJson(dbmod.getBoardCard(cardId, options), {}, options), null];
      }
      // 起会话失败：回原列（worktree 标记保留）；本路径从未落行，无需行收口
      dbmod.updateBoardCard(cardId, false, {
        column_key: card.column_key,
        block_kind: card.block_kind,
        block_text: card.block_text || '',
      }, options);
      return [null, { error: errText(e) }];
    }
    // 起跑行落一份 worktree 证据（与 `_start_web` 的会话日志同文件，便于事后核对）
    runnerMod.appendLog(logPath, `### worktree 直起 path=${p} branch=${branch}\n`);
    return [cardJson(dbmod.getBoardCard(cardId, options), { running: true }, options), null];
  } finally {
    wtStartEnd(cardId);
  }
}

/** `_enter_doing_worktree` 的 Python 名别名。 */
export const _enter_doing_worktree = enterDoingWorktree;

/**
 * 清理卡片 worktree（Python `cleanup_card_worktree`，server 端点用）。返回 `[ok, err]`。
 *
 * 运行中的卡拒绝（409 语义由 server 落）；删除成功后**清空卡片 worktree 标记**（该卡回到
 * 普通模式；D10 只拦「已有会话切 worktree」，不拦反向）。
 * @returns {[boolean, string]}
 */
export function cleanupCardWorktree(project, card, options = {}) {
  if (cardUnitActive(card.id, options) || sessionInFlight(card.id)) {
    return [false, '会话运行中，请先停止卡片再清理 worktree'];
  }
  const [ok, err] = wtRemove(project, card);
  if (!ok) return [false, err];
  dbmod.updateBoardCard(card.id, true, { worktree: '' }, options);
  return [true, ''];
}

/** `cleanup_card_worktree` 的 Python 名别名。 */
export const _cleanup_card_worktree = cleanupCardWorktree;

/**
 * 生成交给 agent 的合并指令（Python `build_merge_instruction`；原文即 prompt）。
 *
 * 两个路径都写死（工作树 / 主仓库）——agent 的 cwd 是工作树，回流的
 * `git -C <主仓库> merge` 是跨目录操作，不写清楚它会去猜。合并口径：**先同步主分支最新
 * 代码，再回流；尽量 ff，不能 ff 才普通 merge**；冲突由 agent 解，解不了必须 abort。
 *
 * @returns {string}
 */
export function buildMergeInstruction(project, card, st) {
  const main = String(project.project_dir || '').trim();
  const { branch, target, path: wtPath } = st;
  const dirty = pyIntOr(st.dirty_count, 0);
  const head = [
    `${MERGE_TASK_MARK}把卡片 #${card.id} 的独立 worktree 改动合并回主分支。`,
    `工作树：${wtPath}（分支 ${branch}，你的会话工作目录）`,
    `主仓库：${main}（主分支 ${target}）`,
    `待合并提交：${st.ahead} 个`,
  ];
  if (dirty) head.push(`工作树当前有 ${dirty} 处未提交改动，第一步先提交它们。`);
  const steps = [
    '步骤：',
    `1. 提交工作树里的未提交改动（有的话），提交信息带上卡片号 #${card.id}。`,
    '2. 同步主分支最新代码：若项目有远端，先在主仓库执行'
      + ` \`git -C ${main} fetch\`（无远端会失败，忽略即可）；然后在工作树执行`
      + ` \`git -C ${wtPath} merge ${target}\`（主分支已合入过就跳过）。`
      + '冲突在工作树内解决，并跑相关测试确认。',
    `3. 回流合并：在主仓库执行 \`git -C ${main} merge --ff-only ${branch}\``
      + '（能快进就快进，主分支保持线性）；若因主分支又前进而无法快进，'
      + `改用 \`git -C ${main} merge ${branch}\` 生成合并提交，冲突自己解决。`,
    '4. 不要 push，不要 rebase/重置主分支，不要改动与本卡无关的文件。',
    '5. 结束后用一两句话报告：合并是否成功、目标分支名、合并后的 HEAD 短 sha；'
      + '失败就说明卡在哪一步。',
    `若第 2/3 步冲突无法解决：\`git -C ${wtPath} merge --abort\`（工作树侧）或`
      + ` \`git -C ${main} merge --abort\`（主仓库侧）回退，`
      + '绝不留半合并状态，并在报告里说明卡在哪里。',
  ];
  return [head.join('\n'), '', ...steps].join('\n').slice(0, PROMPT_MAX);
}

/** `build_merge_instruction` 的 Python 名别名。 */
export const _build_merge_instruction = buildMergeInstruction;

/**
 * 把「合并 worktree 改动回主分支」交给卡片会话（Python `handoff_worktree_merge`；
 * 回统一队列排队）。平台**只投递不执行**：判定有待合并提交后，把
 * `buildMergeInstruction` 的指令当打回意见送进统一队列（`queueWorktree=true`）。
 *
 * 前置校验：无主会话（没会话就没上下文可投递）/ 无法判定 / 无待合并提交 ⇒ 直接报错。
 *
 * **async**（经 `startIntoDoing`）。
 * @returns {Promise<[object|null, object|null]>}
 */
export function handoffWorktreeMerge(project, card, options = {}) {
  if (!String(card.session_id || '').trim()) {
    return Promise.resolve([null, { error: '该卡片尚无主会话，无法交给 agent 合并' }]);
  }
  const st = mergeStatus(project, card);
  if (!st.ok) return Promise.resolve([null, { error: `无法判定待合并提交：${st.error}` }]);
  if (st.ahead <= 0) return Promise.resolve([null, { error: '该卡片没有待合并的提交（可直接通过）' }]);
  const instruction = buildMergeInstruction(project, card, st);
  return startIntoDoing(project, card, instruction, false, false, true, options);
}

/** `handoff_worktree_merge` 的 Python 名别名。 */
export const _handoff_worktree_merge = handoffWorktreeMerge;

/**
 * runner 拾到排队卡片后的起跑（Python `dequeue_start`；队列已保证项目串行位）。
 *
 * 落 doing + 锁外起会话；起会话失败：清占位 + 卡回 `from_column` 列（随 `enqueue_card`
 * meta 持久化；非法/缺失回落 blocked）返回 false。与 force 直起对撞落败（对方已起跑成功）
 * 时放弃回滚返回 true。`last_error` 已由 `startCard` 记录。
 *
 * **async**（await 驱动起会话 + `finish` 钩子）。
 * @returns {Promise<boolean>}
 */
export async function dequeueStart(project, card, options = {}) {
  const row = getActive(KIND_CARD, card.id, options);
  let meta = {};
  try {
    meta = JSON.parse((row !== null && row !== undefined ? row.meta : '') || '{}');
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  } catch {
    meta = {};
  }
  const extra = String(meta.extra || '');
  const fromCol = String(meta.from_column || '');
  dbmod.updateBoardCard(card.id, true,
    { column_key: 'doing', block_kind: null, block_text: '', last_error: '' }, options);
  try {
    await startCard(project, dbmod.getBoardCard(card.id, options), extra, options);
  } catch {
    // 与 force 直起对撞落败：对方已起跑成功，放弃回滚（回滚会把对方落好的 doing 踩回原列）
    if (sessionInFlight(card.id)) return true;
    // 起跑失败收口：清占位 + 回 from_column 列（不留「占位但已出队」滞留态）
    const back = COLUMNS.includes(fromCol) && fromCol !== 'doing' ? fromCol : 'blocked';
    dbmod.updateBoardCard(card.id, true,
      { column_key: back, block_kind: null, block_text: '' }, options);
    await dequeueCard(card.id, { reason: '起跑失败回滚', options });
    return false;
  }
  return true;
}

/** `dequeue_start` 的 Python 名别名。 */
export const _dequeue_start = dequeueStart;

// ---------- 提示词拼装（board.py:1561-1624） ----------

/**
 * 全量任务提示词（Python `build_task_prompt`）：任务描述（卡片标题并入描述）+ 工作目录 +
 * 附加段。
 *
 * 三个逐点保留的用户约定：① 不区分标题与描述（标题并入【任务描述】段，空标题与卡面占位
 * 「未命名」不参与拼接）；② **无【约定】段**（提交契约不再随首轮 prompt 注入）；
 * ③ **无尾部收束句**（提示词到【工作目录】行收尾）。独立 worktree 卡的【工作目录】改指
 * 其 worktree 路径（经 `cardWorkspace`）并追一行说明分支与主仓库位置（plan D7）。
 *
 * @returns {string}
 */
export function buildTaskPrompt(project, card, extra = '') {
  let title = String(card.title || '').trim();
  if (title === '未命名') title = '';        // 卡面空标题展示占位，不是任务信息
  const desc = String(card.description || '').trim();
  const body = [title, desc].filter((seg) => seg).join('\n\n') || '（无）';
  const workspace = cardWorkspace(project, card);
  let p = `${TASK_PROMPT_TAG}${body}\n【工作目录】${workspace}`;
  const wt = String(cardOpt(card, 'worktree') || '').trim();
  if (wt) {
    p += `\n（本任务运行在独立 git worktree 中：分支 ${branchFor(card.id)}，`
      + `主仓库 ${project.project_dir}）`;
  }
  if (extra) p += `\n【修改意见】${extra}\n请按修改意见继续完善。`;
  return p.slice(0, PROMPT_MAX);
}

/** `build_task_prompt` 的 Python 名别名。 */
export const _build_task_prompt = buildTaskPrompt;

/**
 * 续跑提示词（Python `build_continue_prompt`）：卡片已有主会话、再次进「正在开发」时替代
 * 全量首轮提示词（用户约定 2026-09-11：只发「继续」，重发会被 agent 当新任务从头再走）。
 * 打回意见（extra）随行注入，否则用户的修改要求会丢。
 * @returns {string}
 */
export function buildContinuePrompt(extra = '') {
  let p = '继续';
  if (extra) p += `\n【修改意见】${extra}\n请按修改意见继续完善。`;
  return p.slice(0, PROMPT_MAX);
}

/** `build_continue_prompt` 的 Python 名别名。 */
export const _build_continue_prompt = buildContinuePrompt;

/**
 * 起跑提示词选择（Python `build_start_prompt`）：有可续接主会话（sid 非空）→ 续跑「继续」，
 * 否则全量首轮提示词。合并回交指令（extra 以 `MERGE_TASK_MARK` 开头）**原文直发**。
 * @returns {string}
 */
export function buildStartPrompt(project, card, extra = '', sid = '') {
  if (String(extra).startsWith(MERGE_TASK_MARK)) return String(extra).slice(0, PROMPT_MAX);
  if (sid) return buildContinuePrompt(extra);
  return buildTaskPrompt(project, card, extra);
}

/** `build_start_prompt` 的 Python 名别名。 */
export const _build_start_prompt = buildStartPrompt;

// ---------- 会话驱动（board.py:1794-2040） ----------

/**
 * 中断 web 会话当前 turn（Python `_web_abort`；单族：dsh 的 cancel 保留已流式交付的文本）。
 * `family` / `projectDir` 为既有调用面参数（dsh 无本地服务，cancel 只需 sid）。**async**。
 * @returns {Promise<void>}
 */
export function webAbort(family, projectDir, sid, options = {}) {
  void family; void projectDir;
  return dshMod.cancel(sid, false);
}

/** `_web_abort` 的 Python 名别名。 */
export const _web_abort = webAbort;

/**
 * 向 web 会话发 prompt（Python `_web_send`）：单族只有 dsh_plugin——走进程内驱动的 followup
 * （busy 时排进 agent inbox，同为服务端排队语义；`inject=true` 改走 steer）。**async**，
 * 返回空串（dsh 无 prompt_id 概念，排队行以平台消息 id 表示）。
 * @returns {Promise<string>}
 */
export async function webSend(family, project, sid, text, model = '', inject = false,
  options = {}) {
  void family; void project; void model;
  await chatMod.dshSend(sid, text, Boolean(inject), options);
  return '';
}

/** `_web_send` 的 Python 名别名。 */
export const _web_send = webSend;

/**
 * 发 prompt 前的 turn 归属基线（Python `_web_turn_baseline`）：
 * `[轮次结束原因, 会话事件 seq]`；读取失败/未知返回 `null`（`webTurnRan` 按「跑过」容错）。
 * @returns {Array|null}
 */
export function webTurnBaseline(family, projectDir, sid) {
  void family; void projectDir;
  try {
    const st = eventGet(sid);
    if (st === null || st === undefined) return null;
    return [st.last_turn_reason || '', pyIntOr(st.last_seq, 0)];
  } catch {
    return null;
  }
}

/** `_web_turn_baseline` 的 Python 名别名。 */
export const _web_turn_baseline = webTurnBaseline;

/**
 * 本卡 turn 是否真跑过（Python `_web_turn_ran`，M2 按归属判定）：与发 prompt 前的基线比较
 * ——看轮次原因变化或事件 seq 增长。基线缺失或复核异常按「跑过」容错（不误判负）。
 * @returns {boolean}
 */
export function webTurnRan(rec) {
  const baseline = rec.turn_baseline;
  if (baseline === null || baseline === undefined) return true;
  try {
    const st = eventGet(rec.sid);
    if (st === null || st === undefined) return true;   // 未知：按「跑过」容错
    return (st.last_turn_reason || '') !== baseline[0]
      || pyIntOr(st.last_seq, 0) > baseline[1];
  } catch {
    return true;
  }
}

/** `_web_turn_ran` 的 Python 名别名。 */
export const _web_turn_ran = webTurnRan;

/**
 * web 会话 turn 级错误上浮（Python `_web_turn_error`；`finishRun` 用）：无错返回空串。
 * dsh_plugin：`last_turn_reason`（completed 正常；aborted 是用户主动中断不算错误；
 * error/max-tokens/blocked 上浮为 turn 异常）。读口未知 ⇒ 无错（收尾路径不因此失败）。
 * @returns {string}
 */
export function webTurnError(rec) {
  const sid = rec.sid || '';
  if (!sid) return '';
  try {
    const reason = String((eventGet(sid) || {}).last_turn_reason || '');
    if (['', 'completed', 'aborted'].includes(reason)) return '';
    return `turn 异常结束（${reason}）`;
  } catch {
    return '';
  }
}

/** `_web_turn_error` 的 Python 名别名。 */
export const _web_turn_error = webTurnError;

/**
 * 把 sid 并入卡片 `session_id`/`sessions`（Python `_save_card_sid`）。
 * 卡片已删（起会话中途被删）返回 false，调用方据此放弃启动。
 * @returns {boolean}
 */
export function saveCardSid(cardId, sid, options = {}) {
  const card = dbmod.getBoardCard(cardId, options);
  if (card === null || card === undefined) return false;
  const sessions = JSON.parse(card.sessions || '[]');
  if (!sessions.includes(sid)) sessions.push(sid);
  dbmod.updateBoardCard(cardId, true,
    { session_id: sid, sessions: pyJsonDumps(sessions) }, options);
  return true;
}

/** `_save_card_sid` 的 Python 名别名。 */
export const _save_card_sid = saveCardSid;

/**
 * web 驱动起会话（Python `_start_web`；单族：会话在 dsh 宿主进程内）。
 *
 * 建会话（sid 立即可知，**建完立即入库**，防后续步骤失败丢会话成孤儿）→ 设模型 → 记 turn
 * 归属基线 → 发 prompt → 登记 `RUNS`（proc=null，靠事件中枢/巡视收尾）。有主会话时续接原
 * 会话（走驱动 resume）。失败记 `last_error` 并抛 `Error`；起会话中途卡片被删则记日志并放弃。
 *
 * **async**：`createSession`/`resumeSession`/`applySessionDefaults`/`dshSend` 四处驱动往返。
 * 「异常面」比 Python 宽一格（见 §M5-2 差异⑤）：Python 只捕获 `DshDriverError`/`OSError`，
 * Node 把该段内的一切异常一律包装成同一条中文 `Error`——理由：调用方的回滚分支只认异常本身
 * （`except RuntimeError`），漏包装的异常类型会绕过回滚让卡片停在 doing（静默坏态）。
 *
 * @returns {Promise<string>} 会话日志路径
 */
export async function startWeb(project, card, family, extra = '', options = {}) {
  let sid = String(card.session_id || '').trim();
  const prompt = buildStartPrompt(project, card, extra, sid);
  ensureRuntimeDirs(project.work_dir);
  const logDir = runtimeDir(project.work_dir, runnerMod.LOG_DIR_NAME);
  const logPath = pyJoin(logDir, `board_${card.id}_${Math.trunc(nowSec())}.log`);
  const model = String(card.model || '').trim() || String(project.model || '').trim();
  let baseline = null;
  // 卡片级工作目录：独立 worktree 卡用其 worktree 路径，其余仍是 project_dir
  const workspace = cardWorkspace(project, card);
  const [mProvider, mId] = dshMod.splitModel(model);
  try {
    runnerMod.appendLog(logPath, `### PROMPT ${pyJsonDumps(prompt)}\n`);
    if (workspace !== (project.project_dir || '')) {
      runnerMod.appendLog(logPath, `### WORKDIR ${workspace}（独立 worktree）\n`);
    }
    if (!sid) {
      sid = await dshMod.createSession(workspace, `card-${card.id}`, mId, mProvider);
      if (!sid) throw new Error('驱动响应缺少 session_id');
      if (!saveCardSid(card.id, sid, options)) {      // 建完即入库
        runnerMod.appendLog(logPath, '### 卡片已被删除，会话启动放弃\n');
        throw new Error('卡片已被删除，会话启动放弃');
      }
    } else {
      await dshMod.resumeSession(sid, `card-${card.id}`, workspace, mId, mProvider);
    }
    // 项目级会话默认值（思考等级 + 权限档，best-effort）：取值优先「会话实时态里已有的
    // 显式值」（用户在会话详情页改过的档位跨「开始/打回续改」存活），否则回落项目默认。
    // 2026-10-21 权限档对齐 DSH 目录后，两处取值都是**宿主 preset key**（可能 path-rules 等
    // 自定义档）；`applySessionDefaults` 内部再归一旧档 manual/yolo 别名后直达下发。
    const effort = sessionEffort(sid) || String(dbmod.rowOpt(project, 'reasoning_effort') || '').trim();
    const pmode = sessionPermissionMode(sid)
      || String(dbmod.rowOpt(project, 'permission_mode') || '').trim();
    if (effort || pmode) {
      runnerMod.appendLog(logPath, `### 会话默认值 effort=${effort || '(默认)'} `
        + `permission=${pmode || '(默认)'}\n`);
      await dshMod.applySessionDefaults(sid, mId, mProvider, effort, pmode,
        (t) => runnerMod.appendLog(logPath, t));
    }
    baseline = webTurnBaseline(family, workspace, sid);
    // 起会话首投直接走驱动（与既有 dsh 分支一致）：后续投递才经 `webSend` 统一出口
    await chatMod.dshSend(sid, prompt, false, options);
  } catch (e) {
    dbmod.updateBoardCard(card.id, true,
      { last_error: `会话启动失败: ${errText(e)}`, last_error_at: nowMs() }, options);
    throw new Error(`会话启动失败: ${errText(e)}`);
  }
  // 续接路径 sid 本就在库（归并写法幂等）；此处兜建会话后卡片被删等边角
  if (!saveCardSid(card.id, sid, options)) {
    runnerMod.appendLog(logPath, '### 卡片已被删除，会话启动放弃\n');
    throw new Error('卡片已被删除，会话启动放弃');
  }
  runnerMod.appendLog(logPath, `### WEB ${family} sid=${sid} `
    + `model=${model || '(宿主默认)'}\n`);
  // 双保险（正常路径已被入口的两道判据拦下，此为并发竞态防御）：已有条目则中断本次启动，
  // 尽力 abort 刚建的会话回收之，防同卡双会话脱管
  const old = RUNS.get(card.id);
  if (old !== undefined && old !== null) {
    try {
      await webAbort(family, workspace, sid, options);
    } catch { /* best-effort 回收 */ }
    runnerMod.appendLog(logPath, '### 拒绝登记：已有运行中会话，本次会话已 abort\n');
    throw new Error('会话运行中，拒绝重复启动');
  }
  const startedMs = nowMs();
  RUNS.set(card.id, {
    proc: null,
    sid,
    family,
    project_dir: workspace,
    started_at: startedMs,
    startedAtSec: startedMs / 1000,
    seen_busy: false,
    aborted: false,
    turn_baseline: baseline,
    log_path: logPath,
  });
  return logPath;
}

/** `_start_web` 的 Python 名别名。 */
export const _start_web = startWeb;

/**
 * 开始开发 / 打回续改（Python `start_card`）：起 dsh 插件实时会话（见 `startWeb`）。
 *
 * 会话条目在途 ⇒ 抛 `Error`（防重复起会话顶掉 `RUNS` 在管条目）。起跑窗口的 starting 态
 * 防重入落在**入口侧**（`enterDoing` 先过 `cardUnitActive`）——本函数自身不能查该判据
 * （worker 拾取起跑路径自持 starting 行）。退场族 ⇒ 记 `last_error` 后抛 `RETIRED_MSG`。
 *
 * **async**。
 * @returns {Promise<string>} 会话日志路径
 */
export async function startCard(project, card, extra = '', options = {}) {
  if (sessionInFlight(card.id)) throw new Error('会话运行中，请等待完成或先停止');
  const family = webFamily(project);
  if (family === null) {
    dbmod.updateBoardCard(card.id, true,
      { last_error: RETIRED_MSG, last_error_at: nowMs() }, options);
    throw new Error(RETIRED_MSG);
  }
  return startWeb(project, card, family, extra, options);
}

// ---------- 投递与会话兜底（board.py:2041-2175） ----------

/**
 * 评论投递主会话（Python `deliver_comment`；恒发评论原文，不包任何前缀——2026-10-10 去前缀）。
 *
 * 2026-09-10 起不再立即投递：登记会话消息单元进 runner 统一队列，项目忙时按入队顺序等待；
 * 投递执行期间单元持有项目占用。进队前的前置校验拦住必然失败的投递（无会话/退场族）。
 * runner 单例缺位（单测/独立脚本）⇒ 保持既有立即投递行为。
 *
 * **async**（`chat.submit` 是 async；无单例分支要 await 投递）。
 * @returns {Promise<{id: string, state: string, queued: boolean}|null>}
 */
export async function deliverComment(project, card, commentRow, inject = false, options = {}) {
  const family = webFamily(project);
  const sid = card.session_id;
  const text = commentRow.text;
  if (family === null) throw new Error(RETIRED_MSG);
  if (!sid) throw new Error('尚无会话，请先开始开发');
  const inst = runnerInstance();
  if (inst === null) {
    // 无统一队列（单测/独立脚本）：保持既有立即投递行为
    await deliverNow(project, card, commentRow, text, inject, options);
    return null;
  }
  // 排队中的消息可「立即注入」：family/model/comment_id 提交时定格进等待项 meta
  return chatMod.submit(project.id, sid, text, {
    cardId: card.id,
    commentId: commentRow.id,
    inject,
    family: agentFamily(project.agent_path || ''),
    model: String(card.model || '').trim() || String(project.model || '').trim(),
    ...options,
  });
}

/** `deliver_comment` 的 Python 名别名。 */
export const _deliver_comment = deliverComment;

/**
 * 统一队列消息单元执行体（Python `_deliver_unit`）：投递评论并等该会话结束（执行期间持有
 * 项目占用）。返回即释放占用；`chat.STATE_YIELDED` = turn 挂起等作答、已让位。
 *
 * 参数形态适配（Node 侧由 `chat.js` 的 `rebuildRun` 调用）：
 * `(project, card, commentRow, text, inject, options)`。`card` 可能是**合成 dict**
 * （只带 id/session_id/model）——故除 `cardWorkspace` 外一律回库取真行。
 *
 * **async**。
 * @returns {Promise<string|null>}
 */
export async function deliverUnit(project, card, commentRow, text, inject, options = {}) {
  await deliverNow(project, card, commentRow, text, inject, options);
  const family = webFamily(project);
  if (family !== null) {
    return chatMod.waitTurn(project.project_dir, card.session_id, family, null, '', options);
  }
  // 退场族（防御残留）：等本地子进程（单族化后恒无）
  const rec = runRecord(card.id);
  const proc = rec === null || rec === undefined ? null : rec.proc;
  if (proc !== null && proc !== undefined && typeof proc.wait === 'function') proc.wait();
  return null;
}

/** `_deliver_unit` 的 Python 名别名。 */
export const _deliver_unit = deliverUnit;

/** 卡片会话已不在宿主时的投递文案（`board.py:LOST_SESSION_MSG`，用户可见）。 */
export const LOST_SESSION_MSG = '会话已结束（宿主无活动 agent），消息未送达：'
  + '请点「开始」重新拉起会话后再发送';

/**
 * 投递前确保宿主仍持有该卡会话（Python `_ensure_card_session`；宿主已失去 ⇒ 按 resume 接回）。
 *
 * 判定阶梯（与调和器「会话确已结束」同源，见 `chat.hostSessionLost`）：
 *   ① 宿主仍有该会话（注册表命中 / 中枢未对齐＝未知）⇒ 放行，**零请求**；
 *   ② 确已失去 ∧ 平台自建卡（`origin` 非 `sync`）⇒ 按 `_start_web` 的续接语义 resume 回池；
 *   ③ 确已失去 ∧ sync 卡（`origin='sync'`）⇒ **不接回**（C 批设计「只投递不接管」）。
 * cwd 取 `cardWorkspace`（worktree 卡的会话必须接回它的工作树）。**async**。
 * @returns {Promise<boolean>}
 */
export async function ensureCardSession(project, card, sid, options = {}) {
  if (!chatMod.hostSessionLost(sid)) return true;      // 会话在场/未知：不动作（零请求）
  const cid = cardOpt(card, 'id');
  const row = cid ? dbmod.getBoardCard(cid, options) : null;
  const origin = String(cardOpt(row !== null && row !== undefined ? row : card, 'origin') || '');
  if (origin === 'sync') return false;                 // 外部会话卡：不接管
  return chatMod.reviveHostSession(sid,
    cardWorkspace(project, row !== null && row !== undefined ? row : card), `card-${cid}`, options);
}

/** `_ensure_card_session` 的 Python 名别名。 */
export const _ensure_card_session = ensureCardSession;

/**
 * 评论真正送达（Python `_deliver_now`；立即路径与统一队列执行体共用，text 即评论原文）。
 *
 * 单族：followup 忙时排进 agent inbox；`inject=true` 走 steer。送达前两道人造兜底（顺序
 * 固定，都在 `webSend` 之前）：① **会话存活**（`ensureCardSession` 先接回再投递，接不回则报
 * `LOST_SESSION_MSG`）；② **重声明看管**（C 批终审 I2，`watchBeforeDelivery` 钩子；未接线
 * 时按「该条件不成立」跳过）。退场族无投递通道，直接报错。**async**。
 * @returns {Promise<void>}
 */
export async function deliverNow(project, card, commentRow, text, inject = false, options = {}) {
  const family = webFamily(project);
  const sid = card.session_id;
  if (family !== null) {
    try {
      if (!await ensureCardSession(project, card, sid, options)) {
        throw new Error(LOST_SESSION_MSG);
      }
      const before = optionalHook('watchBeforeDelivery');
      if (before !== null) before(sid, options);
      await webSend(family, project, sid, text, '', Boolean(inject), options);
    } catch (e) {
      throw new Error(`评论投递失败: ${errText(e)}`);
    }
    dbmod.updateBoardComment(commentRow.id, { sent: 1, session_id: sid, sent_text: text },
      options);
    return;
  }
  throw new Error(RETIRED_MSG);              // 退场族无投递通道（单族化）
}

/** `_deliver_now` 的 Python 名别名。 */
export const _deliver_now = deliverNow;

/**
 * 卡片是否刚被平台停过会话（Python `_stop_recent`；宽限期内）。
 *
 * web abort 生效前 busy 可能短暂仍为真——调和器在宽限期内不据 busy 做「阻塞→开发」搬列，
 * 防拖入阻塞瞬间被回弹。
 * @returns {boolean}
 */
export function stopRecent(cardId) {
  const ts = STOP_STAMP.get(cardId);
  return ts !== undefined && (nowSec() - ts) < STOP_GRACE_S;
}

/** `_stop_recent` 的 Python 名别名。 */
export const _stop_recent = stopRecent;

/**
 * 停止卡片运行中的会话（Python `stop_card`；单族：dsh 走驱动 REST cancel）。返回是否命中。
 *
 * 先取消该卡片排队中的会话消息；平台未在管（`RUNS` 无记录）时的兜底：按其 sid 仍可 REST
 * cancel（覆盖外部同步卡与按实况 busy 点亮停止按钮的场景）；无 sid 则无停止通道返回 false。
 * 每次调用登记 `STOP_STAMP`（调和器宽限期）；同时放弃该卡待送达的答案（卡已停/被移列，
 * 迟到送达会唤醒已停会话）。等待区卡（doing/queue 占位）停止即出队收口。
 *
 * **async**（驱动 cancel + `dequeueCard`）。
 * @returns {Promise<boolean>}
 */
export async function stopCard(cardId, options = {}) {
  const ts = nowSec();
  STOP_STAMP.set(cardId, ts);
  if (STOP_STAMP.size > 256) {               // 长期运行防累积：超限时清掉已过期项
    for (const [cid, t] of [...STOP_STAMP.entries()]) {
      if (ts - t > STOP_GRACE_S) STOP_STAMP.delete(cid);
    }
  }
  chatMod.cancelQueued({ cardId }, options);
  if (isAnswerPending(cardId, options)) {    // 放弃该卡待送达答案
    waitqCancel(KIND_ANSWER, cardId, '停止/移列放弃', null, options);
    withRunner((inst) => inst.removeAnswer(cardId, options));
  }
  const rec = runRecord(cardId);
  if (rec === undefined || rec === null) {
    const card = dbmod.getBoardCard(cardId, options);
    if (card === null || card === undefined) return false;
    if (card.column_key === 'doing' && card.block_kind === 'queue') {
      // 等待区卡停止（R9：任意队列中卡可停止→待审核）：无会话可停，统一走出队收口
      await dequeueCard(cardId, { reason: '用户停止', toColumn: 'review', markUnread: false, options });
      return true;
    }
    const proj = dbmod.getProject(card.project_id, options);
    if (proj === null || proj === undefined) return false;
    const fam = webFamily(proj);
    if (fam === null) return false;
    const sid = String(card.session_id || '').trim();
    if (!sid) return false;
    try {
      // dsh 会话活在宿主进程内，平台侧没有可拉起的本地服务——直接走驱动 cancel
      await webAbort(fam, proj.project_dir, sid, options);
      return true;
    } catch {
      return false;                          // 驱动异常不再打穿请求处理器
    }
  }
  if (rec.proc === null || rec.proc === undefined) {
    // web 驱动：先标记 aborted（宽限期内 turn 未起即被 stop 时，巡视据此按正常停止收尾），
    // 再走 REST abort；abort 后 busy 回落，由巡视正常收尾（不算错误停止）
    rec.aborted = true;
    try {
      await webAbort(rec.family, rec.project_dir, rec.sid, options);
      return true;
    } catch {
      return false;
    }
  }
  if (rec.proc.exitCode !== null && rec.proc.exitCode !== undefined) return false;
  try {
    killTree(rec.proc.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** `stop_card` 的 Python 名别名。 */
export const _stop_card = stopCard;

// ---------- compact / fork（board.py:2291-2408） ----------

/** 会话必须属于该卡片（Python 的两处同款前置校验）；不属于即抛 `Error`。 */
function requireCardSession(card, sid) {
  if (!JSON.parse(card.sessions || '[]').includes(sid) && sid !== card.session_id) {
    throw new Error('会话不属于该卡片');
  }
}

/**
 * 对卡片关联会话执行 compact（Python `compact_session`；走驱动 `/compact`，触发即返回——
 * 压缩在 dsh 进程内异步进行）。
 *
 * **池外两跳（2026-10-10 修「卡片 945 无法 compact」）**：插件重载/dsh web 重启后，平台自建
 * 的卡会话在驱动里只剩观察 ⇒ 首跳 404 时经 `ensureWatch` 钩子（`force=true`）补看管声明后
 * 重试一次。未接线（M5-3）⇒ 不补声明、直接按失败抛（与 Python「声明失败」同一分支）。
 *
 * **会话存活前置（2026-10-17 修卡 907「TS 侧 /compact 对已结束会话必失败」）**：上面那条
 * 「池外回落」只对宿主里**仍活着**的会话成立；对宿主里根本没有活 agent 的会话（dsh web
 * 重启、插件重载、久未接续的旧卡），驱动 `/compact` 必 404「会话已结束（宿主无活动 agent）」
 * ——补看管声明也救不回来。而 dsh GUI 自己的 `/compact` 对冷会话是按需 resume 再执行命令
 * （`dsh-api-session-controller.resolve` → `agents.resume`），故这里与投递腿 `deliverNow`
 * 同款：先 `ensureCardSession` 接回（判据/边界同它——中枢未对齐按「未知」不动、sync 卡不
 * 收养、回滚阀 `TS_HOST_SESSION_REVIVE=0` 时不动，均为零请求），再走下面的两跳。接不回
 * **不在此收口**：照旧走两跳，由驱动 404 文案兜底（与修复前完全一致）。
 *
 * `sid` 必须属于该卡片；不支持的族抛 `Error`（server 转 400）。**async**。
 * @returns {Promise<void>}
 */
export async function compactSession(project, card, sid, options = {}) {
  requireCardSession(card, sid);
  const family = agentFamily(project.agent_path || '');
  if (family !== 'dsh_plugin') throw new Error(RETIRED_MSG);
  // 会话存活前置：宿主已失去该会话 ⇒ 先按 resume 语义接回，再压缩（与投递同款）
  await ensureCardSession(project, card, sid, options);
  let last = '';
  for (const attempt of [1, 2]) {
    try {
      await dshMod.compact(sid);
      return;
    } catch (e) {
      last = errText(e);
      const poolMiss = (e && e.code === 404);
      const ensure = optionalHook('ensureWatch');
      const declared = attempt === 1 && poolMiss && ensure !== null
        ? Boolean(ensure(sid, true, options)) : false;
      if (declared) {
        console.log(`[board] 卡片 compact：池外会话补看管声明后重试 sid=${sid}`);
        continue;
      }
      break;
    }
  }
  throw new Error(`compact 失败: ${last}`);
}

/** `compact_session` 的 Python 名别名。 */
export const _compact_session = compactSession;

/**
 * 对卡片关联会话执行「压缩并新建」（Python `fork_compact_session`）：fork 出完整副本 →
 * 把**新会话**压缩（其上下文随即变轻）。返回 `[新会话 sid, true]`。
 * @returns {Promise<[string, boolean]>}
 */
export async function forkCompactSession(project, card, sid, options = {}) {
  requireCardSession(card, sid);
  const family = agentFamily(project.agent_path || '');
  if (family !== 'dsh_plugin') throw new Error(RETIRED_MSG);
  let newSid;
  try {
    newSid = String(((await dshMod.fork(sid)) || {}).new_session_id || '');
    if (!newSid) throw new Error('压缩新建失败: 驱动未返回新会话 id');
    await dshMod.ensureSession(newSid, project.project_dir, `card-${card.id}`, '', '');
    await dshMod.compact(newSid);
    const title = String(card.title || '').trim();
    if (title) {
      try {
        await dshMod.rename(newSid, `${title}（压缩续）`);
      } catch { /* 标题失败不影响主流程 */ }
    }
  } catch (e) {
    if (e instanceof Error && String(e.message).startsWith('压缩新建失败')) throw e;
    throw new Error(`压缩新建失败: ${errText(e)}`);
  }
  return [newSid, true];
}

/** `fork_compact_session` 的 Python 名别名。 */
export const _fork_compact_session = forkCompactSession;

/**
 * fork 卡片关联会话（Python `fork_session`）：经驱动完整复制源会话（历史/上下文全量保留，
 * 同 workspace/cwd），新会话标题「<卡标题>（fork）」。返回新会话 sid。调用方（server 端点）
 * 负责把新 sid 绑定进卡片会话列表（仅追加列表，不抢占主会话）。**async**。
 * @returns {Promise<string>}
 */
export async function forkSession(project, card, sid, options = {}) {
  requireCardSession(card, sid);
  const family = agentFamily(project.agent_path || '');
  if (family !== 'dsh_plugin') throw new Error(RETIRED_MSG);
  let newSid;
  try {
    newSid = String(((await dshMod.fork(sid)) || {}).new_session_id || '');
    if (!newSid) throw new Error('fork 失败: 驱动未返回新会话 id');
    // fork 出的新会话不在驱动池里——平台这里补一次 ensure_session 把它 resume 进池
    await dshMod.ensureSession(newSid, project.project_dir, `card-${card.id}`, '', '');
    const title = String(card.title || '').trim();
    if (title) {
      try {
        await dshMod.rename(newSid, `${title}（fork）`);
      } catch { /* 标题失败不影响 fork 主流程 */ }
    }
  } catch (e) {
    if (e instanceof Error && String(e.message).startsWith('fork 失败')) throw e;
    throw new Error(`fork 失败: ${errText(e)}`);
  }
  return newSid;
}

/** `fork_session` 的 Python 名别名。 */
export const _fork_session = forkSession;

// ---------- 唯一收尾点（board.py:2411-2494） ----------

/**
 * 所有「条目结束」的**唯一收口**（Python `finish`，v2 §2.5.2-4 裁决 R14）。
 *
 * 步骤：finishing 重入门禁（幂等）→ `waitq.markFinishing`（running→finishing，finishing
 * 态唯一生产路径）→ `runner.cardFinished`（行终态门禁 (running,finishing)→done；
 * notify_all = 补位时机②）→ 搬列（`toColumn` 给定且列不同才写）。
 *
 * **保持同步**（用户口径）：只碰 waitq/runner/db，三个口全同步；`ext:` 分支的
 * `finish("ext:…")` 同理。返回值即契约：`ext:` 分支回布尔（是否真实收尾一行），`c:` 分支与
 * 其它键回 `undefined`。
 *
 * `markUnread`：搬列时是否给卡片置「状态有更新·用户未打开」标记（缺省 true=平台/agent
 * 自己搬的列要标记；`false` 只给「用户本人在看板上操作」的收尾路径）。
 *
 * @param {string} unitKey
 * @param {string} reason
 * @param {{toColumn?: string|null, markUnread?: boolean,
 *          options?: object}} [opts]
 * @returns {boolean|undefined}
 */
export function finish(unitKey, reason, { toColumn = null, markUnread = true, options = {} } = {}) {
  const key = String(unitKey);
  if (key.startsWith('ext:')) {
    const target = key.slice(4);
    const row = getActive(KIND_EXT, target, options);
    if (row === null || row === undefined || row.state === FINISHING) {
      return false;                                   // 无活跃行/finishing 重入：幂等 no-op
    }
    markFinishing(KIND_EXT, target, options);         // running→finishing
    if (finishByTarget(KIND_EXT, target, undefined, '', options)) {   // → done
      console.log(`[board] 外部条目收尾：ext:${target}（${reason}）`);
    }
    withRunner((inst) => inst.notifyBusyChange(options));            // 补位时机③
    return true;
  }
  if (!key.startsWith('c:')) return undefined;        // 卡片单元外无收尾语义
  const cardId = pyIntLoose(key.slice(2));
  if (cardId === null) return undefined;              // 脏键（理论项）：无收尾对象
  const inst = runnerInstance();
  if (inst !== null) {
    const row = getActive(KIND_CARD, cardId, options);
    if (row !== null && row !== undefined && row.state === FINISHING) {
      return undefined;                               // finishing 重入幂等
    }
    if (row !== null && row !== undefined && row.state === RUNNING) {
      markFinishing(KIND_CARD, cardId, options);       // running→finishing
    }
    if (inst.cardFinished(cardId, reason, options)) {  // 行收口成功 → reason 落日志
      console.log(`[board] 卡片收尾：c:${cardId}（${reason}）`);
    }
  }
  if (toColumn !== null && toColumn !== undefined) {
    const card = dbmod.getBoardCard(cardId, options);
    if (card !== null && card !== undefined && card.column_key !== toColumn) {
      dbmod.updateBoardCard(cardId, markUnread,
        { column_key: toColumn, block_kind: null, block_text: '' }, options);
    }
  }
  return undefined;
}

/** `finish` 的 Python 名别名。 */
export const _finish = finish;

/**
 * 删除卡片前的平台侧清理（Python `delete_card_cleanup`；server 删除端点在 `stop_card` 之后、
 * 删库行之前调用）：走 `dequeueCard` 出队原语（等待行取消/运行行终态化），防「卡删了但项目
 * 运行位被残留行堵死」。
 *
 * **形态差异（M5-4 收敛，M5-2 待收敛项 2）**：Python 同步、Node 的 `dequeueCard` 是 async
 * ⇒ 本函数**返回 Promise**，调用方必须 `await`。M5-2 曾是「发后不管」（内部
 * `Promise.resolve(...).catch(留痕)`），后果是「删卡 → 立刻查等待行」会看到尚未收口的行
 * ——实例级对拍里就是两侧 dump 分叉。**形参表不变**（`(cardId, options = {})` 冻结契约）；
 * 两个调用点（`DELETE .../board/cards/<cid>` 与 `DELETE .../board/trash/<cid>`）本就在
 * `await`，故改返回值形态不触碰任何调用方。
 *
 * 收口失败不让端点 500：`.catch` 留痕后吞掉（行终态有 60s 自检兜底）。
 * @returns {Promise<void>}
 */
export async function deleteCardCleanup(cardId, options = {}) {
  try {
    await dequeueCard(cardId, { reason: '卡片删除', options });
  } catch (e) {
    console.log(`[board] 卡片删除出队收口失败 c:${cardId}: ${errText(e)}`);
  }
}

/** `delete_card_cleanup` 的 Python 名别名。 */
export const _delete_card_cleanup = deleteCardCleanup;

// ---------- 会话结束收尾与巡视（board.py:2496-2656） ----------

/**
 * 会话结束收尾（Python `_finish_run`）：提取 session id 入库、doing/交互阻塞卡 → review
 * （清交互阻塞标记）、记错误、释放 runner 占用。
 *
 * `reason`：收尾 reason 标签（落卡片日志/审计）。dsh 驱动：sid 启动时已入库，跳过日志回捞；
 * 错误优先经 `webTurnError` 上浮 turn 级真实错误，无则取 `rec.error`（turn 未开始超时兜底）；
 * 用户主动 abort 不算错误。
 *
 * **保持同步**：`iwClear` / `feishuCardReview`（review 路径 3 位）/ `feishuCardBlocked`
 * （blocked 路径 4 位）三个 M5-3/M7 口走**可选钩子**（未注入即跳过，
 * 与 Python 的「该分支不存在」同形）；`finish` 是同步的。
 * @param {number} cardId
 * @param {object} rec
 * @param {string} [reason]
 * @returns {void}
 */
export function finishRun(cardId, rec, reason = '会话结束收尾', options = {}) {
  const logPath = rec.log_path;
  let webErr = '';
  let sid = '';
  if (rec.proc === null || rec.proc === undefined) {
    // dsh 驱动：sid 启动即知已入库；turn 级错误优先，超时错误兜底
    sid = rec.sid || '';
    webErr = webTurnError(rec) || (rec.error || '');
    if (webErr) runnerMod.appendLog(logPath, `### 会话异常结束: ${webErr}\n`);
  } else {
    // CLI 时代防御残留（单族化后条目恒为 dsh，proc=null）：会话提示从日志回捞
    if (rec.usage_path) {
      try {
        const usid = String(JSON.parse(fs.readFileSync(rec.usage_path, 'utf8')).session_id || '');
        if (usid) {
          runnerMod.appendLog(logPath, `${pyJsonDumps({
            role: 'meta', type: 'session.resume_hint', session_id: usid,
          })}\n`);
        }
      } catch { /* 读不到/坏 JSON：跳过（照 Python 空 except） */ }
    }
    sid = '';
  }
  const card = dbmod.getBoardCard(cardId, options);
  if (card === null || card === undefined) {
    // 卡片已删：会话收尾无事可做，但 runner 项目占用必须释放，否则项目队列卡死
    finish(`c:${cardId}`, '会话结束-卡已删', { options });
    return;
  }
  const fields = {};
  if (sid) {
    const sessions = JSON.parse(card.sessions || '[]');
    if (!sessions.includes(sid)) sessions.push(sid);
    fields.session_id = sid;
    fields.sessions = pyJsonDumps(sessions);
  }
  if (rec.proc === null || rec.proc === undefined) {
    if (webErr) {
      fields.last_error = `会话异常: ${webErr}`;
      fields.last_error_at = nowMs();
    } else {
      fields.last_error = '';
    }
  } else {
    const exitCode = rec.proc.exitCode;
    // 用户主动 stop_card（SIGTERM，returncode=-15）属正常停止，不记错误
    if (exitCode && exitCode !== -15) {
      fields.last_error = `会话退出码 ${exitCode}`;
      fields.last_error_at = nowMs();
    } else {
      fields.last_error = '';
    }
  }
  // 仅仍在 doing 的卡片自动流转；交互阻塞卡在 turn 结束时同样流转 review
  // （等待态已随会话结束失效，滞留阻塞列会成死卡）；手动阻塞恒为 manual 不受影响
  const toReview = card.column_key === 'doing'
    || (card.column_key === 'blocked' && card.block_kind === 'interaction');
  if (toReview) {
    // 交互等待已随会话结束失效：清 watcher 缓存，防 stale pending 卡片持续显示「等待回答」
    const clear = optionalHook('iwClear');
    if (clear !== null) clear(card.session_id || '', options);
  }
  if (Object.keys(fields).length) dbmod.updateBoardCard(cardId, true, fields, options);
  if (toReview) {
    const notify = optionalHook('feishuCardReview');
    if (notify !== null) {                     // 待审核推送（默认事件关，旁路；异常吞掉）
      try {
        notify(card.project_id, card, options);
      } catch { /* 通知永不影响收尾 */ }
    }
  }
  // 收尾：行终态化（唯一收尾点）；toColumn 给定且列不同才写（列差守卫）
  finish(`c:${cardId}`, reason, { toColumn: toReview ? 'review' : null, options });
}

/** `_finish_run` 的 Python 名别名。 */
export const _finish_run = finishRun;

/**
 * 在管会话收尾巡视段（Python `_watch_runs_once`；`watchOnce` 的前半拆分，30s 全量对账节拍）。
 *
 * 单族化后条目恒为 dsh（proc=null，会话在 dsh 宿主进程内）：按事件中枢三态读实况——
 * running 记 `seen_busy`；idle 按收尾判据处理；unknown（中枢断连/无信号）本轮跳过。
 * `STARTING_TIMEOUT_S` 内从未见 busy 时：已被 stop（aborted 标记）按正常停止收尾，否则经
 * `webTurnRan` 按归属基线复核——真跑过按正常收尾，没跑过按「turn 未开始」失败收尾。
 *
 * **事件源族快路径**：hub 已知时按注册表实况直接判（短轮与「停止于起跑窗口」不必空等 90s
 * 宽限，串行位不被白占）；hub 断连（null＝未知）时保持现状，绝不把「读不到」推断成「已结束」。
 *
 * 收尾归属：只有本线程真正从 `RUNS` 弹出的条目才收尾——被新会话顶替的旧条目不收。
 *
 * **保持同步**。
 * @returns {Array<[number, object]>} 本轮真正弹出的条目（测试与 `watchOnce` 用）
 */
export function watchRunsOnce(options = {}) {
  const entries = [...RUNS.entries()];
  const done = [];
  const nowMsVal = nowMs();
  for (const [cid, rec] of entries) {
    const proc = rec.proc;
    if (proc !== null && proc !== undefined) {
      if (proc.exitCode !== null && proc.exitCode !== undefined) done.push([cid, rec]);
      continue;
    }
    // dsh 条目：读 EventHub 三态（unknown＝断连/无信号，本轮跳过，下轮再看）
    const st = sessionStateFamily(rec.family, rec.project_dir, rec.sid);
    if (st === STATE_UNKNOWN) continue;
    if (st === STATE_RUNNING) {
      rec.seen_busy = true;
      continue;
    }
    // 事件源族：hub 是权威实况，不必等「某拍观测到 busy」
    if (rec.family === 'dsh_plugin') {
      const hub = eventGet(rec.sid);
      if (hub !== null && hub !== undefined) {
        if (String(hub.status || '') === 'running') {
          rec.seen_busy = true;
          continue;
        }
        if (rec.aborted) {
          done.push([cid, rec]);
          continue;
        }
        // 基线缺失（起跑时 hub 未连接）时不启用快路径：宁可等宽限
        if (rec.turn_baseline !== null && rec.turn_baseline !== undefined && webTurnRan(rec)) {
          done.push([cid, rec]);
          continue;
        }
      }
    }
    if (rec.seen_busy) {
      done.push([cid, rec]);
      continue;
    }
    const startedSec = rec.startedAtSec !== undefined && rec.startedAtSec !== null
      ? rec.startedAtSec : rec.started_at / 1000;
    if (nowMsVal - startedSec * 1000 <= STARTING_TIMEOUT_S * 1000) {
      continue;                              // turn 启动宽限期内（starting 窗口，行级同阈值）
    }
    if (rec.aborted) {
      // 宽限期内被 stop（turn 未起即 abort）：按正常停止收尾，不判负
      done.push([cid, rec]);
      continue;
    }
    if (!webTurnRan(rec)) rec.error = `turn 未开始（${STARTING_TIMEOUT_S}s 未见 busy）`;
    done.push([cid, rec]);
  }
  const popped = [];
  for (const [cid, rec] of done) {
    if (RUNS.get(cid) === rec) {             // 防巡视期间条目被新会话顶替
      RUNS.delete(cid);
      popped.push([cid, rec]);
    }
  }
  for (const [cid, rec] of popped) finishRun(cid, rec, '会话结束收尾', options);
  return popped;
}

/** `_watch_runs_once` 的 Python 名别名。 */
export const _watch_runs_once = watchRunsOnce;

// ---------- pid / 孤儿行判据（board.py:3839-3867） ----------

/**
 * 在管卡会话子进程 pid（Python `run_pid`；无运行条目/web 族无 proc → null）。
 * 单族化后条目恒 proc=null ⇒ 恒 null（保留为 R11④ 进程证据的写入侧数据源）。
 * @returns {number|null}
 */
export function runPid(cardId) {
  const rec = runRecord(cardId);
  if (rec !== undefined && rec !== null && rec.proc !== null && rec.proc !== undefined) {
    return rec.proc.pid ?? null;
  }
  return null;
}

/**
 * `_unit_evidence_pid`（Python）：卡行 evidence 的 pid 读取；无活跃行/无 pid 返回 null。
 * @returns {number|null}
 */
export function unitEvidencePid(cardId, options = {}) {
  const row = getActive(KIND_CARD, cardId, options);
  const pid = evidencePid(row);
  return pid === null || pid === undefined ? null : pid;
}

/** `_unit_evidence_pid` 的 Python 名别名。 */
export const _unit_evidence_pid = unitEvidencePid;

/**
 * 本卡是否持有「无平台在管条目背书」的活跃 `c:` 行（Python `_orphan_hold`，**孤儿运行行**）。
 *
 * 唯一产生面＝作答/立即送达送达成功时 `runner.card_started` 补回的「送达恢复」行：那行由平台
 * 建、而目标会话是外部/接管会话（`RUNS` 里没有它）⇒ 行没有「在管条目」背书。为什么必须与
 * `hasActiveRun` 分开判：调和状态机把 `live_msg` 算作「在跑」，而孤儿行本身就在运行前缀里
 * ⇒ serial 项目里它把本卡自己的排队消息永久挡在队外，状态机又因那条消息判本卡「在跑」= 互等。
 * 故孤儿行只认**实况 busy**。
 * @returns {boolean}
 */
export function orphanHold(cardId, options = {}) {
  return cardUnitActive(cardId, options) && !hasActiveRun(cardId);
}

/** `_orphan_hold` 的 Python 名别名。 */
export const _orphan_hold = orphanHold;

// ══════════════════════════════════════════════════════════════════════════
// M5-3 写路径：归档双向同步、sync 会话归类、交互调和器、作答送达、调度/recover、Jira
// （`board.py:2661-3135`（启动对账/recover）/ `3136-3190`（Jira）/ `3252-3445`（归档同步）/
//   `3446-3796`（sync 归类）/ `3876-4700`（巡视与调和器）/ `4790-5250`（作答与送达））
//
// 交付面：归档族（`archiveSyncEnabled`/`cardSids`/`archiveCall`/`recordCardError`/
//        `archiveCardSessions`/`archiveBoundSession`/`archiveRetryAdd`/`archiveRetryTick`/
//        `archiveUnarchiveEdge`）、sync 族（`splitFirstPrompt`/`fullFirstPrompt`/
//        `isEmptySession`/`isPlaceholderCard`/`platformOwnedSids`/`syncCardFields`/
//        `autoTitleForms`/`syncCardFollow`/`syncSessions`/`syncSessionBusy`）、
//        调和器（`dshOption`/`iwInteraction`/`watchGenerationSync`/`ensureWatch`/
//        `renameCardSession`/`watchCardRefs`/`watchMsgInflight`/`watchPrune`/
//        `watchBeforeDelivery`/`reconcileActionFor`/`iwApply`/`recoverToDoing`/`iwOnce`/
//        `interactionOfSid`/`interactionProbe`/`iwClear`/`startInteractionWatcher`）、
//        作答（`answerQuestionGone`/`answerRetryOrFail`/`dshAnswers`/`answerDeliver`/
//        `deliverAnswerUnit`/`deliverPendingAnswerNow`/`queueAnswerUnit`/`answerInteraction`/
//        `answerApproval`）、启动对账（`startingEvidence`/`reconcileStartingRows`/
//        `healQueuePlaceholders`/`watchOnce`/`startScheduler`/`recoverWebCard`/`recover`）、
//        Jira（`jiraGet`/`jiraMyself`/`jiraImport`）。
//
// ── 异步口径（M5-2 的全局硬约束在此继续生效）──────────────────────────────────
// Python `board.py` 是同步代码，但下列函数体要打 `dshdriver`（真 HTTP）：`archiveCall` /
// `ensureWatch` / `renameCardSession` / `answerDeliver` / `deliverAnswerUnit` /
// `deliverPendingAnswerNow` / `recover`（间接）。**这些一律 async**，调用方必须 await。
// `finish` 保持同步（它只碰 waitq/runner/db，三条口全同步——见其 docstring）。
// 长驻线程 → **单个 `setInterval` 泵 + 到期时刻表**（见本段尾）：Node 单线程下
// 「后台线程」= 定时器回调，每拍 body 全包 `try/catch`（后台拍子不许打死进程）。
//
// ── 与 Python 的形态差异（逐条，均为形态差异而非行为差异）────────────────────
//   ① 形参表逐位对齐 Python + `options` 末位（M5-2 事故冻结的契约，见 §五之三）。
//      唯一的例外是 **db 袋形态**：Python 无 options，Node 的 `setBroadcast`/`setBoardDriver`
//      等测试缝走模块级注入（ESM 命名空间对象不可写，与 `setRunnerInstance` 同款）。
//   ② `dshdriver.*` 一律经**本文件的驱动袋**（`boardDriver()`）取，默认直通 `dshdriver.js`
//      具名导出。为什么加这一层：Node 的 ESM 具名导出是只读活绑定，单测无法像 Python 那样
//      `dshdriver.archive = fake`；`setBoardDriver` 是本文件唯一注入面（同 `setRunnerInstance`）。
//   ③ `_ARCHIVE_RETRY` 的 Python 值是 `[attempts, next_at, want]` 列表；Node 用普通对象
//      （字段同名），**数组下标语义不出现在本文件之外**。
//   ④ `_iw_apply` / `_iw_once` 因 `archiveCardSessions` 与 `dequeueCard` 而 async；Python 的
//      调用点（守护线程 `_loop`、`_watch_once`）在 Node 是定时器回调，await 天然可承载。
//   ⑤ `_watch_prune` 的 Python 锁纪律（锁内只碰记账集合、驱动 I/O 全在锁外）在 Node 退化为
//      **同一同步段内不 await**：本文件不引入锁，但对 `_WATCHED` 的读改写一律收在同步段里
//      （Node 事件循环里同步段即原子段，与 M5-1 的 `_gate_lock` 退化同口径）。
//   ⑥ 诊断行前缀与文案逐字照抄（`[board]` / `[board-sync]`），量具的第三层比对就靠它。
// ══════════════════════════════════════════════════════════════════════════

// ---------- 驱动袋（本文件唯一驱动调用面；默认直通 dshdriver.js） ----------

let BOARD_DRIVER_TEST = null;

/**
 * 注入驱动替身（**测试专用**；与 `setRunnerInstance` 同款缝）。
 *
 * 为什么需要：Node 的 ESM 具名导出是**只读活绑定**，Python 测试那种
 * `dshdriver.archive = fake` 在 Node 会 TypeError。本函数是 board 侧唯一驱动调用面
 * （`boardDriver()`）的注入点；传 null 恢复读真 `dshdriver` 模块。
 *
 * @param {object|null} driver
 */
export function setBoardDriver(driver) {
  BOARD_DRIVER_TEST = driver === undefined ? null : driver;
}

/** 当前驱动袋（Python `dshdriver` 模块本身的对应物） */
function boardDriver() {
  return BOARD_DRIVER_TEST === null ? dshMod : BOARD_DRIVER_TEST;
}

/**
 * 驱动的 `configured()`（Python `dshdriver.configured()`）。
 *
 * 驱动替身未实现该口时按「已配置」处置——替身的存在本身即「我在模拟一个连上的宿主」，
 * 与 Python 测试里 `dshdriver.configured` 被 monkeypatch 成 True 的写法等价。
 */
function driverConfigured(drv) {
  const fn = drv.configured;
  if (typeof fn === 'function') return Boolean(fn());
  return true;
}

// ---------- 归档同步（board.py:3246-3445） ----------

/** 归档同步总开关的环境变量名（Python `ARCHIVE_SYNC_ENV`） */
export const ARCHIVE_SYNC_ENV = 'TS_ARCHIVE_SYNC';
/** 单次归档调用超时（毫秒；Python `_ARCHIVE_TIMEOUT_S` = 10 秒） */
export const ARCHIVE_TIMEOUT_MS = 10000;
/** 重试次数上限（退避 5s→10s→20s→40s→80s；Python `_ARCHIVE_RETRY_MAX`） */
export const ARCHIVE_RETRY_MAX = 5;
/** 退避基数（秒；Python `_ARCHIVE_RETRY_BASE_S`） */
export const ARCHIVE_RETRY_BASE_S = 5.0;
/** 每轮调和最多重试几个（防单轮打爆；Python `_ARCHIVE_RETRY_TICK_MAX`） */
export const ARCHIVE_RETRY_TICK_MAX = 8;
/** `_ARCH_SEEN` 上限（超限按本轮在场集合清理；Python `_ARCH_SEEN_MAX`） */
export const ARCH_SEEN_MAX = 4096;

/** 待重试的归档 sid：sid → {attempts, next_at, want}（Python `_ARCHIVE_RETRY`） */
const ARCHIVE_RETRY = new Map();
/** 外部取消归档的边沿表：sid → 上次观测到的归档态（Python `_ARCH_SEEN`） */
const ARCH_SEEN = new Map();

/** 归档同步总开关（Python `archive_sync_enabled`）。 */
export function archiveSyncEnabled({ env = process.env } = {}) {
  const raw = env[ARCHIVE_SYNC_ENV];
  const val = raw === undefined || raw === null ? '1' : String(raw);
  return !(val === '0' || val === 'false' || val === 'False');
}

/** `archive_sync_enabled` 的 Python 名别名。 */
export const _archive_sync_enabled = archiveSyncEnabled;

/**
 * 卡片全部绑定会话 id（Python `_card_sids`；主会话在前、去重去空）。
 *
 * 坏 `sessions` JSON 按空列表降级（与 `db.js` 读路径「宽容读」同口径）。
 * @param {object} card
 * @returns {string[]}
 */
export function cardSids(card) {
  const out = [];
  const main = String(card.session_id || '').trim();
  if (main) out.push(main);
  let sids = [];
  try {
    sids = JSON.parse(card.sessions || '[]');
  } catch {
    sids = [];
  }
  if (Array.isArray(sids)) {
    for (const sid of sids) {
      const s = String(sid || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** `_card_sids` 的 Python 名别名。 */
export const _card_sids = cardSids;

/**
 * 单会话归档/取消归档（Python `_archive_call`）：返回 `"ok"` / `"unknown"` / 错误串。
 *
 * `"unknown"` = 宿主明确回报「会话不存在」（`ARCHIVE_UNKNOWN_SESSION`）——调用方跳过该 sid
 * （无同步对象），不算失败。**一切异常都在此收成错误串**（归档面任何异常都不许打穿移列）。
 *
 * **async**（驱动 HTTP）。
 * @param {string} sid
 * @param {boolean} archived
 * @returns {Promise<string>}
 */
export async function archiveCall(sid, archived) {
  const drv = boardDriver();
  try {
    await drv.archive(sid, Boolean(archived), { timeoutMs: ARCHIVE_TIMEOUT_MS });
    return 'ok';
  } catch (e) {
    if (e && e.code === drv.ARCHIVE_UNKNOWN_SESSION) return 'unknown';
    return errText(e);
  }
}

/** `_archive_call` 的 Python 名别名。 */
export const _archive_call = archiveCall;

/**
 * 给卡片记一行 last_error（Python `_record_card_error`；写失败绝不上抛）。
 * @param {number} cardId
 * @param {string} text
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function recordCardError(cardId, text, options = {}) {
  try {
    dbmod.updateBoardCard(cardId, true,
      { last_error: String(text).slice(0, 200), last_error_at: nowMs() }, options);
  } catch { /* 记错误本身失败：吞掉（照 Python 空 except） */ }
}

/** `_record_card_error` 的 Python 名别名。 */
export const _record_card_error = recordCardError;

/**
 * 把卡片全部绑定会话置为归档（True）/取消归档（False）（Python `_archive_card_sessions`）。
 *
 * 返回 `null` = 到位（含卡片无绑定会话、开关关闭、独立形态无 dsh 宿主）；
 * `strict=true` 时返回错误串 = 调用方须放弃本次移列（server 端点 400 报前端），
 * 且本次已改动的 sid 已**补偿回滚**到改动前状态。
 * `strict=false`（调和器级联：dsh 侧已改、回滚不了）只记日志 + 退避重试。
 *
 * 会话不存在 → 跳过并记 last_error 提示（历史遗留 sid / 会话存储已删）。
 * 补偿只回滚「本次确实改动过、且改动前状态已知为相反值」的 sid——中枢未连接
 * （归档集未知）时不猜，宁可留一次告警也不误改用户既有的归档。
 *
 * **async**（逐 sid 打驱动）。形参与 M5-1/M5-2 的调用点逐位对齐：
 * `(card, archived, reason = '', { strict = true, options = {} } = {})`。
 *
 * @param {object} card
 * @param {boolean} archived
 * @param {string} [reason]
 * @param {{strict?: boolean, options?: object}} [opts]
 * @returns {Promise<string|null>}
 */
export async function archiveCardSessions(card, archived, reason = '',
  { strict = true, options = {} } = {}) {
  const drv = boardDriver();
  if (!archiveSyncEnabled() || !driverConfigured(drv)) {
    return null;                       // 关闭 / 独立形态：没有 dsh 宿主可同步
  }
  const sids = cardSids(card);
  if (!sids.length) return null;
  const prior = eventArchivedSet();   // null = 未知（补偿判据见 docstring）     // null = 未知（补偿判据见 docstring）
  const changed = [];                  // 本次确认改动的 sid
  const skipped = [];                  // 会话不存在（无同步对象）
  const failed = [];                   // [[sid, err]]；传输类失败通常连带，取首个即可
  for (const sid of sids) {
    if (prior !== null && prior.has(sid) === Boolean(archived)) {
      // 已知已到位：归档集快照说它已是目标态 ⇒ 不必再打驱动（级联归档时主会话
      // 通常已在集合里，省一次幂等调用；快照陈旧也不影响正确性）
      continue;
    }
    const res = await archiveCall(sid, archived);
    if (res === 'ok') {
      changed.push(sid);
    } else if (res === 'unknown') {
      skipped.push(sid);
    } else {
      failed.push([sid, res]);
      if (strict) break;               // 用户路径：首次失败即回滚收口（不再打后续 sid）
    }
  }
  const verb = archived ? '归档' : '取消归档';
  if (failed.length && strict) {
    for (const sid of [...changed].reverse()) {
      const was = prior === null ? null : prior.has(sid);
      if (was === !archived) {         // 原本状态与目标相反 ⇒ 本次真改过
        await archiveCall(sid, !archived);
      }
    }
    const [sid, err] = failed[0];
    const msg = `会话${verb}失败：${sid}（${err}）`;
    recordCardError(card.id, msg);
    return msg;
  }
  if (failed.length) {
    for (const [sid, err] of failed) archiveRetryAdd(sid, archived, err);
    console.log(`[board] 归档同步未到位（${reason || '调和'}）：`
      + `${failed.length} 个会话待重试`);
  }
  if (skipped.length) {
    recordCardError(card.id, `归档跳过（会话不存在）: ${skipped[0]}`);
  }
  return null;
}

/** `_archive_card_sessions` 的 Python 名别名。 */
export const _archive_card_sessions = archiveCardSessions;

/**
 * 卡片在「已完成」时把新绑定的会话也归档（Python `archive_bound_session`）。
 *
 * 调用点：server 改卡端点的 `bind_session`（含 fork / 压缩新建后的绑定）——绑卡动作本身
 * 已生效，这里失败**不回滚绑定**（回滚会话列表代价更大），只记 last_error + 进退避重试；
 * 卡片不在 done / 开关关闭 / 独立形态一律 no-op。**async**（best-effort）。
 *
 * @param {object|null} card
 * @param {string} sid
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
export async function archiveBoundSession(card, sid, reason = '新绑定会话') {
  void reason;
  if (card === null || card === undefined || !sid) return;
  if (card.column_key !== 'done') return;
  const drv = boardDriver();
  if (!archiveSyncEnabled() || !driverConfigured(drv)) return;
  const res = await archiveCall(sid, true);
  if (res === 'unknown') {
    recordCardError(card.id, `归档跳过（会话不存在）: ${sid}`);
  } else if (res !== 'ok') {
    archiveRetryAdd(sid, true, res);
    recordCardError(card.id, `会话归档失败（待重试）：${sid}`);
  }
}

/** `archive_bound_session` 的 Python 名别名。 */
export const _archive_bound_session = archiveBoundSession;

/**
 * 登记一个待重试的归档/取消归档 sid（Python `_archive_retry_add`；指数退避，次数用尽告警一次
 * 并放弃）。
 * @param {string} sid
 * @param {boolean} archived
 * @param {string} [reason]
 */
export function archiveRetryAdd(sid, archived, reason = '') {
  const now = nowSec();
  const item = ARCHIVE_RETRY.get(sid);
  const attempts = (item ? item.attempts : 0) + 1;
  if (attempts > ARCHIVE_RETRY_MAX) {
    ARCHIVE_RETRY.delete(sid);
    console.log(`[board] 归档重试放弃：${sid}（${reason}）`);
    return;
  }
  const delay = Math.min(ARCHIVE_RETRY_BASE_S * (2 ** (attempts - 1)), 300.0);
  ARCHIVE_RETRY.set(sid, { attempts, next_at: now + delay, want: Boolean(archived) });
}

/** `_archive_retry_add` 的 Python 名别名。 */
export const _archive_retry_add = archiveRetryAdd;

/** 待重试表快照（测试与诊断用；Python 侧无此口——`_ARCHIVE_RETRY` 是模块私有 dict） */
export function archiveRetryTable() {
  return new Map([...ARCHIVE_RETRY].map(([k, v]) => [k, { ...v }]));
}

/**
 * 调和器节拍里的归档重试（Python `_archive_retry_tick`；每轮最多 `ARCHIVE_RETRY_TICK_MAX` 个）。
 *
 * 只服务调和器级联（strict=False）留下的未到位项；用户动作路径失败即回滚，不留待重试状态。
 * **async**。
 * @returns {Promise<number>} 本轮真正重试的条数（诊断用）
 */
export async function archiveRetryTick() {
  const drv = boardDriver();
  if (!archiveSyncEnabled() || !driverConfigured(drv)) return 0;
  const now = nowSec();
  let due = [...ARCHIVE_RETRY.entries()]
    .filter(([, v]) => v.next_at <= now)
    .map(([sid, v]) => [sid, v.want ? 1 : 0]);
  due = due.slice(0, ARCHIVE_RETRY_TICK_MAX);
  for (const [sid] of due) {
    ARCHIVE_RETRY.delete(sid);          // 取出即摘（失败会重新登记、次数累计）
  }
  for (const [sid, want] of due) {
    const res = await archiveCall(sid, Boolean(want));
    if (res !== 'ok' && res !== 'unknown') archiveRetryAdd(sid, Boolean(want), res);
  }
  return due.length;
}

/** `_archive_retry_tick` 的 Python 名别名。 */
export const _archive_retry_tick = archiveRetryTick;

/**
 * 观测到「dsh 取消归档」边沿（True→False）且卡片在「已完成」→ 归位「待审核」
 * （Python `_archive_unarchive_edge`）。
 *
 * 用户口径（2026-10-05②）：任一方改状态另一方同步——dsh 侧取消归档，卡片离开「已完成」；
 * 按 I2 顺带把其余绑定会话也取消归档（best-effort + 重试）。
 * read-verify-write：写前重读卡片与归档态，状态已变/未知即跳过（防旧判定覆盖）。
 * 搬列经统一出队原语（`to_column` 落列 + 行收口），与 `iwApply` 同款。**async**。
 *
 * @param {object} card
 * @returns {Promise<void>}
 */
export async function archiveUnarchiveEdge(card, options = {}) {
  const cur = dbmod.getBoardCard(card.id, options);
  if (cur === null || cur === undefined || cur.column_key !== 'done') return;
  if (eventArchived(cur.session_id || '') !== false) {
    return;                             // 已变/未知：不动作
  }
  await dequeueCard(cur.id, { reason: 'dsh 取消归档同步', toColumn: 'review', options });
  await archiveCardSessions(dbmod.getBoardCard(cur.id, options) || cur, false,
    '取消归档级联', { strict: false, options });
}

/** `_archive_unarchive_edge` 的 Python 名别名。 */
export const _archive_unarchive_edge = archiveUnarchiveEdge;

// ---------- session 自动同步（board.py:3446-3796） ----------

/** 退场族 busy 近似窗口（秒；Python `SYNC_BUSY_MTIME_S`，保留为防御） */
export const SYNC_BUSY_MTIME_S = 120;
/** sync 卡标题上限（Python `SYNC_TITLE_MAX`） */
export const SYNC_TITLE_MAX = 200;
/** sync 卡描述上限（Python `SYNC_DESC_MAX`） */
export const SYNC_DESC_MAX = 2000;
/**
 * 平台任务提示词的段标（Python `TASK_PROMPT_TAG`）：`buildTaskPrompt` 的首段。
 * 除拼提示词外还用作**判据**——会话首问以它开头 ⇒ 这个会话是平台按某张卡片的内容拼
 * 提示词启动的（2026-10-16 起这类卡的标题/描述也跟随 DSH，见 `isPlatformTaskSession`）。
 */
export const TASK_PROMPT_TAG = '【任务描述】';

/** 已跑过「存量子代理卡软删收口」的项目 id（Python `_SYNC_SUBAGENT_SWEPT`，每项目一轮） */
const SYNC_SUBAGENT_SWEPT = new Set();
/** 已跑过「存量误建卡软删收口」的项目 id（Python `_SYNC_MISBUILT_SWEPT`，每项目一轮） */
const SYNC_MISBUILT_SWEPT = new Set();

/** 一次性清扫登记表快照（测试用；Python 侧同为模块私有 set） */
export function syncSweptSets() {
  return { subagent: new Set(SYNC_SUBAGENT_SWEPT), misbuilt: new Set(SYNC_MISBUILT_SWEPT) };
}

/** 清空一次性清扫登记表（测试用；Python 侧靠进程重启重建空集） */
export function resetSyncSweptSets() {
  SYNC_SUBAGENT_SWEPT.clear();
  SYNC_MISBUILT_SWEPT.clear();
}

/** `sessparse` 解析族（Python `sessparse.FAMILIES`；单族化后只有 dsh） */
function parseFamilies() {
  const fams = sessparseMod.FAMILIES;
  return Array.isArray(fams) ? fams : [...(fams || [])];
}

/**
 * 首问原文 → (首行, 其余行)（Python `_split_first_prompt`；仅服务**回落标题**与
 * 旧口径描述识别）。
 *
 * 首行超 `SYNC_TITLE_MAX` 的溢出部分并入其余行开头（截断不丢内容）；其余行超
 * `SYNC_DESC_MAX` 截断并补省略号；原文为空 → `['', '']`。
 *
 * @param {string} text
 * @returns {[string, string]}
 */
export function splitFirstPrompt(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return ['', ''];
  const lines = raw.split('\n');
  let first = String(lines[0]).trim();
  let rest = lines.slice(1).join('\n').trim();
  if (first.length > SYNC_TITLE_MAX) {
    const overflow = first.slice(SYNC_TITLE_MAX).trim();
    rest = [overflow, rest].filter((x) => x).join('\n');
    first = first.slice(0, SYNC_TITLE_MAX);
  }
  if (rest.length > SYNC_DESC_MAX) rest = `${rest.slice(0, SYNC_DESC_MAX)}…`;
  return [first, rest];
}

/** `_split_first_prompt` 的 Python 名别名。 */
export const _split_first_prompt = splitFirstPrompt;

/**
 * 首问原文 → 卡描述：首问**全文**（去首尾空白；超 `SYNC_DESC_MAX` 截断补省略号）。
 * Python `_full_first_prompt`。
 * @param {string} text
 * @returns {string}
 */
export function fullFirstPrompt(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return '';
  return raw.length > SYNC_DESC_MAX ? `${raw.slice(0, SYNC_DESC_MAX)}…` : raw;
}

/** `_full_first_prompt` 的 Python 名别名。 */
export const _full_first_prompt = fullFirstPrompt;

/**
 * 空会话判定（A 类闸，Python `_is_empty_session`）：会话已存在但**还没有任何内容**
 * （首问与标题事件皆空）。item 缺失（会话已不在本次枚举里）返回 false——那种情况交既有
 * 「存储被删→done」规则处理，本闸不表态。
 * @param {object|null} item
 * @returns {boolean}
 */
export function isEmptySession(item) {
  if (!item) return false;
  return !String(item.first_prompt || '').trim() && !String(item.title || '').trim();
}

/** `_is_empty_session` 的 Python 名别名。 */
export const _is_empty_session = isEmptySession;

/**
 * 卡面是否仍是「自动写入的占位形态」（Python `_is_placeholder_card`；存量收口的**前置硬闸**）。
 *
 * 占位形态 = 标题为空，或等于某个绑定会话的 sid 短码（`sid[:12]`）。真实标题的卡一律不自动
 * 收口（宁漏不误删）——卡面标题是卡自身的证据，不随会话解析成败摇摆。
 * @param {object} card
 * @param {Set<string>} sids
 * @returns {boolean}
 */
export function isPlaceholderCard(card, sids) {
  const title = String(card.title || '').trim();
  if (!title) return true;
  for (const s of sids) {
    if (!s) continue;
    if (title === String(s).trim().slice(0, 12)) return true;
  }
  return false;
}

/** `_is_placeholder_card` 的 Python 名别名。 */
export const _is_placeholder_card = isPlaceholderCard;

/**
 * 本项目「平台自己持有会话位」的 sid 集合（B 类闸，Python `_platform_owned_sids`）。
 *
 * 两个来源：`tasks.session_id`（任务主会话已有入口）与 `feishu_bindings.cur_sid`
 * （飞书通用对话当前绑定）。看板卡自己的会话不用列——`syncSessions` 的 bound 映射已覆盖；
 * `chat_msgs` **不纳入**（那些会话常常正是 dsh GUI 建出来的外部会话）。
 * 一次查库、单轮复用；表缺失/结构演进按空集（归因失败绝不影响建卡）。
 * @param {number} projectId
 * @returns {Set<string>}
 */
export function platformOwnedSids(projectId, options = {}) {
  const sids = new Set();
  try {
    dbmod.withReadDb(options, (handle) => {
      for (const [sql, args] of [
        ['SELECT session_id AS sid FROM tasks WHERE project_id=? AND session_id<>\'\'',
          [projectId]],
        ['SELECT cur_sid AS sid FROM feishu_bindings'
          + ' WHERE cur_project_id=? AND cur_sid<>\'\'', [projectId]],
      ]) {
        try {
          for (const r of handle.prepare(sql).all(...args)) {
            sids.add(String(r.sid));
          }
        } catch { /* 单表不可用只丢该项，不影响另一项与建卡 */ }
      }
    });
  } catch {
    return new Set();
  }
  const out = new Set();
  for (const s of sids) if (s) out.add(s);
  return out;
}

/** `_platform_owned_sids` 的 Python 名别名。 */
export const _platform_owned_sids = platformOwnedSids;

/**
 * sync 卡平台自动写入形态的 (标题, 描述) 目标值（Python `_sync_card_fields`）。
 *
 * 标题 = **DSH 当前会话标题**（`item.title` = 末枚 `session/title` 事件；无标题事件时回落
 * 首问首行、再回落 sid 短码）；描述 = 首问**全文**。建卡与 `syncCardFollow` 补齐共用同一
 * 口径（幂等）。
 * @param {object} item
 * @param {string} sid
 * @returns {[string, string]}
 */
export function syncCardFields(item, sid) {
  let title = String(item.title || '').trim();
  if (!title) title = splitFirstPrompt(item.first_prompt || '')[0];
  if (!title) title = String(sid).slice(0, 12);
  return [title.slice(0, SYNC_TITLE_MAX), fullFirstPrompt(item.first_prompt || '')];
}

/** `_sync_card_fields` 的 Python 名别名。 */
export const _sync_card_fields = syncCardFields;

/**
 * 平台**可能自动写入过**的卡标题集合（Python `_auto_title_forms`）。
 *
 * 含：空、sid 短码、DSH 当前标题、**全部历史标题事件**、旧口径写入的首问首行。
 * 用户手工改过的标题不在此集合 ⇒ 整卡不再自动覆盖（尊重用户在卡面的改名）。
 * @param {object} item
 * @param {string} sid
 * @returns {Set<string>}
 */
export function autoTitleForms(item, sid) {
  const forms = new Set(['', String(sid).slice(0, 12)]);
  forms.add(String(item.title || '').slice(0, SYNC_TITLE_MAX));
  for (const t of (item.titles || [])) forms.add(String(t || '').slice(0, SYNC_TITLE_MAX));
  forms.add(splitFirstPrompt(item.first_prompt || '')[0]);
  return forms;
}

/** `_auto_title_forms` 的 Python 名别名。 */
export const _auto_title_forms = autoTitleForms;

/**
 * 卡面字段是否仍是「平台按卡片内容拼进首问」的**原文形态**（Python `_in_first_prompt`；
 * 判自动写入用）。
 *
 * 平台起会话时把卡片标题/描述原样拼进首问（`buildTaskPrompt`：标题并入【任务描述】段、
 * 与描述空行分隔）⇒ 卡面字段只要没被用户改过，就必然能在首问原文里原样找到；用户后来
 * 改写过的文本通常不在（⇒ 不覆盖，尊重用户编辑）。空/纯空白一律 false（空标题由
 * `autoTitleForms` 那一档负责）。
 * @param {string} text
 * @param {object} item
 * @returns {boolean}
 */
export function inFirstPrompt(text, item) {
  const t = String(text === null || text === undefined ? '' : text).trim();
  return Boolean(t) && String(item.first_prompt || '').includes(t);
}

/** `_in_first_prompt` 的 Python 名别名。 */
export const _in_first_prompt = inFirstPrompt;

/**
 * 该会话是否「平台按某张卡片的内容拼提示词启动的」（Python `_is_platform_task_session`；
 * 判据 = 首问以段标开头）。
 *
 * 卡片启动腿（`enterDoing` → `buildTaskPrompt`）拼的首问以 `TASK_PROMPT_TAG` 开头；
 * 用户在 dsh GUI 里直跑的会话首问是用户原文、续跑腿是「继续」，都不会命中。用于把正向
 * 同步（DSH 标题/首问 → 卡面）从 sync 卡扩到**平台从看板启动过会话的卡**（2026-10-16
 * 用户诉求：卡面标题/正文与 DSH 保持一致；见 spec/board §48）。
 * @param {object} item
 * @returns {boolean}
 */
export function isPlatformTaskSession(item) {
  return String(item.first_prompt || '').replace(/^\s+/, '').startsWith(TASK_PROMPT_TAG);
}

/** `_is_platform_task_session` 的 Python 名别名。 */
export const _is_platform_task_session = isPlatformTaskSession;

/**
 * 卡面按「DSH 当前标题 + 首问全文」补齐的字段 dict（Python `_sync_card_follow`；
 * 无变化返回 `{}`）。
 *
 * 只认「主会话」：遍历到的会话不是卡的主会话（多会话并集里的子会话）时不动。
 * 只在卡仍由平台自动写入时动——卡标题 ∈ `autoTitleForms`（空 / sid 短码 / 任一枚会话
 * 标题事件 / 旧口径的首问首行）**或**仍是平台拼进首问的原文（`inFirstPrompt`，
 * 2026-10-16 增：服务「平台从看板启动过会话的卡」——它的标题是用户在卡里敲的原文，
 * 不在任何标题事件里）；用户在卡面行内改过标题就整张卡不再自动覆盖（描述也不动）。
 * 描述仅在为空、仍是**旧口径自动写入**（首问除首行）、或仍是平台拼进首问的原文时改成
 * 首问全文；用户写过的描述不覆盖。
 * @returns {object}
 */
export function syncCardFollow(card, item, sid) {
  if (String(card.session_id || sid) !== String(sid)) return {};
  const curTitle = String(card.title || '').trim();
  if (!autoTitleForms(item, sid).has(curTitle) && !inFirstPrompt(curTitle, item)) return {};
  const [title, desc] = syncCardFields(item, sid);
  const out = {};
  if (curTitle !== title) out.title = title;
  const curDesc = String(card.description || '').trim();
  const legacyDesc = splitFirstPrompt(item.first_prompt || '')[1];
  if (desc && curDesc !== desc
      && (curDesc === '' || curDesc === legacyDesc || inFirstPrompt(curDesc, item))) {
    out.description = desc;
  }
  return out;
}

/** `_sync_card_follow` 的 Python 名别名。 */
export const _sync_card_follow = syncCardFollow;

/**
 * 自动同步项目 agent 会话到看板（Python `sync_sessions`）。返回新建卡 id 列表。
 *
 * 建卡闸（2026-10-09 两处收窄）：A 类 空会话不投影；B 类 平台自持会话不重复投影。
 * 新建卡（origin='sync'）：标题 = DSH 当前会话标题、描述 = 首问全文，绑定主会话，
 * busy→doing / 空闲→review；存量 sync 卡按同口径补齐 + 归档→done；会话存储被删的 sync 卡
 * 自动进 done；绑子代理会话的存量 sync 卡收口进回收站（每项目一轮）；两类误建卡的存量也按
 * 同款口径收口（每项目一轮）。sync 卡不占 runner 项目占用（外部会话平台控制不了）。
 * **平台从看板启动过会话的卡**（用户建卡 → 开始/回车启动，首问 = 平台拼的任务提示词，
 * 见 `isPlatformTaskSession`）同样按上面同一口径补齐卡面——但**列语义不动**：归档/取消
 * 归档的列映射与各类存量收口仍只服务 `origin='sync'` 卡（用户自己的卡，平台只同步
 * 标题/描述，不替用户搬列、不软删）。用户改过卡名 ⇒ 整卡不动（含描述）。
 *
 * **async**：本函数自身不打驱动，但 `setCardPlaceholder`→无；`webBusy` 走 `dshevents` 内存读。
 * 除 `subagentSession`（注入缝）外全同步——保持 `async` 只为「调用方统一 await」的形态一致。
 *
 * @param {object} project
 * @returns {Promise<number[]>} 新建卡 id 列表
 */
export async function syncSessions(project, options = {}) {
  if (!settingsOf(project.id, options).sync_sessions) return [];
  const rawFamily = agentFamily(project.agent_path);
  // 归族 → 解析族：单族化后只有 dsh_plugin，会话存储解析归 sessparse 的 "dsh" 族
  const family = rawFamily === 'dsh_plugin' ? 'dsh' : rawFamily;
  if (!parseFamilies().includes(family)) return [];
  const items = sessparseMod.list_sessions(family, project.project_dir);
  const cards = dbmod.listBoardCards(project.id, options);
  const bound = sessionCardMap(cards);
  // B 类闸的 sid 集合（每轮一次查库）
  const owned = platformOwnedSids(project.id, options);
  const created = [];
  for (const it of items) {
    const sid = it.sid;
    const archivedFlag = Boolean(it.archived);
    const c = bound[sid];
    // busy 按需判定（2026-09-27）：只有新卡分支消费 busy；存量 sync 卡只用 archived。
    let busy = false;
    if (c === undefined && !isEmptySession(it) && !owned.has(sid)) {
      busy = syncSessionBusy(project, rawFamily, sid, it.mtime);
    }
    if (c === undefined) {
      if (isEmptySession(it)) continue;          // A 类闸：空会话不投影
      if (owned.has(sid)) continue;              // B 类闸：平台自持会话不重复投影
      const [title, desc] = syncCardFields(it, sid);
      const cid = dbmod.insertBoardCard(project.id, title, desc, '', options);
      const col = archivedFlag ? 'done' : (busy ? 'doing' : 'review');
      dbmod.updateBoardCard(cid, true,
        { session_id: sid, sessions: pyJsonDumps([sid]), column_key: col, origin: 'sync' },
        options);
      created.push(cid);
    } else if (c.origin === 'sync' || isPlatformTaskSession(it)) {
      // 卡面补齐（2026-10-07 起服务 sync 卡；2026-10-16 起扩到「平台从看板启动过会话的卡」，
      // 见 `syncCardFollow`）：标题/描述仍是平台自动写入形态时按 DSH 当前标题 + 首问全文
      // 覆盖（用户改过名整卡不动）
      const fields = syncCardFollow(c, it, sid);
      if (Object.keys(fields).length) dbmod.updateBoardCard(c.id, true, fields, options);
      if (c.origin === 'sync'
          && (c.column_key === 'doing' || c.column_key === 'review')
          && !hasActiveRun(c.id)) {
        // dsh 的 busy/空闲 列映射已移交调和器；此处保留归档→done（archived 来源=
        // list_sessions 的宿主归档集文件读，与调和器读驱动帧是两条独立通道）
        const want = archivedFlag ? 'done' : null;
        if (want && c.column_key !== want) {
          dbmod.updateBoardCard(c.id, true, { column_key: want }, options);
        }
      }
    }
  }
  // —— 存量子代理卡收口（2026-10-07 实障修复）——
  if (!SYNC_SUBAGENT_SWEPT.has(project.id)) {
    let dropped = 0;
    for (const c of cards) {
      const sids = new Set(cardSids(c));
      if (c.origin !== 'sync' || !sids.size || hasActiveRun(c.id)) continue;
      let hit = false;
      for (const s of sids) {
        if (subagentSession(s)) { hit = true; break; }
      }
      if (hit) {
        dbmod.trashBoardCard(c.id, options);
        dropped += 1;
      }
    }
    SYNC_SUBAGENT_SWEPT.add(project.id);
    if (dropped) {
      console.log(`[board-sync] 子代理会话卡收口: 软删 ${dropped} 张`
        + `（项目 ${project.id}，见 spec/queue/排队与占用.md）`);
    }
  }
  // —— 存量误建卡收口（2026-10-09；二版：「卡面占位形态」为前置硬闸）——
  if (!SYNC_MISBUILT_SWEPT.has(project.id)) {
    const bySid = {};
    for (const it of items) bySid[it.sid] = it;
    let dropped = 0;
    for (const c of cards) {
      if (c.origin !== 'sync' || hasActiveRun(c.id)) continue;
      const sids = new Set(cardSids(c));
      if (!sids.size || !isPlaceholderCard(c, sids)) continue;   // 真实标题：绝不自动收口
      let ownedHit = false;
      let allEmpty = true;
      for (const s of sids) {
        if (owned.has(s)) ownedHit = true;
        if (!isEmptySession(bySid[s])) allEmpty = false;
      }
      if (ownedHit || allEmpty) {
        dbmod.trashBoardCard(c.id, options);
        dropped += 1;
      }
    }
    SYNC_MISBUILT_SWEPT.add(project.id);
    if (dropped) {
      console.log(`[board-sync] 误建卡收口: 软删 ${dropped} 张`
        + `（项目 ${project.id}：平台自持会话卡 / 空会话占位卡，见 board spec §48）`);
    }
  }
  // 存储被删 → done（list 只回 50 条，不能用「不在列表」判定删除，必须逐卡查存在性）
  for (const c of cards) {
    if (c.origin !== 'sync' || c.column_key === 'done' || hasActiveRun(c.id)) continue;
    const sids = new Set(cardSids(c));
    if (!sids.size) continue;
    let alive = false;
    for (const s of sids) {
      if (sessparseMod.session_exists(family, s)) { alive = true; break; }
    }
    if (!alive) dbmod.updateBoardCard(c.id, true, { column_key: 'done' }, options);
  }
  return created;
}

/** `sync_sessions` 的 Python 名别名。 */
export const _sync_sessions = syncSessions;

/**
 * busy 判定（Python `_sync_session_busy`）：单族化后只有 dsh_plugin——读插件内存态
 * （复用 `webBusy`，`wait=false` 传透；注册表天然非阻塞）。mtime 近似为 CLI 时代的防御残留。
 * 异常视为空闲。
 * @returns {boolean}
 */
export function syncSessionBusy(project, rawFamily, sid, mtime) {
  if (rawFamily === 'dsh_plugin') {
    try {
      return webBusy(rawFamily, project.project_dir, sid, false);
    } catch {
      return false;
    }
  }
  return (nowSec() - Number(mtime || 0)) < SYNC_BUSY_MTIME_S;
}

/** `_sync_session_busy` 的 Python 名别名。 */
export const _sync_session_busy = syncSessionBusy;

// ---------- 交互调和器：等待检测与看管声明（board.py:3876-4278） ----------

/** 调和器缓存（sid → 条目）与启动标志（Python `_IW_CACHE` / `_IW_STARTED`） */
const IW_CACHE = new Map();
let IW_STARTED = false;

/** 外部会话看管记账（Python `_WATCHED`）与上次扫卡时刻（`_WATCH_PRUNE_AT`） */
const WATCHED = new Set();
let WATCH_GEN = null;              // 上次见到的中枢连接代次（None=本进程尚未对过账）
let WATCH_PRUNE_AT = 0.0;          // 上次真正扫卡的时刻（秒；0.0 = 本拍该扫）

/** 看管扫卡节流窗口（秒；Python `WATCH_PRUNE_INTERVAL`，与调和器兜底拍同量级） */
export const WATCH_PRUNE_INTERVAL = 60.0;

/** 卡面改名的驱动调用超时（秒；Python `RENAME_TIMEOUT`） */
export const RENAME_TIMEOUT = 10;

/** 看管记账快照（测试与诊断用；Python 侧为模块私有 set） */
export function watchedSids() { return new Set(WATCHED); }

/** 清空看管记账与代次（测试用；Python 侧靠进程重启重建空集） */
export function resetWatchState() {
  WATCHED.clear();
  WATCH_GEN = null;
  WATCH_PRUNE_AT = 0.0;
}

/** **测试缝**：把「上次扫卡时刻」归零（下一拍必扫）。生产路径不用；见 `resetWatchState`。 */
export function resetWatchPruneAtForTest() { WATCH_PRUNE_AT = 0.0; }

/**
 * dsh 提问选项 → 前端选项对象（Python `_dsh_option`；`{id, label, description}`）。
 *
 * 对纯字符串形态保持兼容（旧插件/测试替身仍可能给 str）。平台侧选项 id 与 label 同值：
 * dsh 的回答只认**选项标签**（`selected=[label]`）。
 * @param {unknown} raw
 * @returns {{id: string, label: string, description: string}}
 */
export function dshOption(raw) {
  let label;
  let desc;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    label = String(raw.label || raw.value || '');
    desc = String(raw.description || '');
  } else {
    label = String(raw === null || raw === undefined ? '' : raw);
    desc = '';
  }
  return { id: label, label, description: desc };
}

/** `_dsh_option` 的 Python 名别名。 */
export const _dsh_option = dshOption;

/**
 * 读 web 会话实况（等待态 + busy）（Python `_iw_interaction`）。
 *
 * 返回 `{pending, busy, kind, qid, question, options, answerable, text, …}`；提问另带
 * `questions`（逐题全量）与首题平面字段；审批带 `approval_id`/`tool`/`action`/`input`。
 * 异常/无 sid / 族不符返回 `null`（该轮跳过，不误移不报错）。单族化后只读 `dshevents`
 * 注册表（零请求）；未连接/未知 ⇒ `null`。
 * @returns {object|null}
 */
export function iwInteraction(family, proj, sid, busyHint = null) {
  void proj; void busyHint;            // 既有调用面参数（dsh 分支不消费）
  if (!sid) return null;
  try {
    if (family !== 'dsh_plugin') return null;
    const st = eventGet(sid);
    if (st === null || st === undefined) return null;
    const busy = st.status === 'running';
    const mark = st.interaction || {};
    if (!busy || !Object.keys(mark).length) {
      return { pending: false, busy, qid: null, question: null, options: null,
        answerable: true, text: '' };
    }
    if (mark.kind === 'approval') {
      const tool = String(mark.tool || '');
      const text = `请求审批：${tool || '工具调用'}`;
      return { pending: true, busy: true, kind: 'approval', qid: null,
        approval_id: String(mark.id || ''), tool, action: tool, input: '',
        question: text, options: null,
        answerable: Boolean(mark.answerable), text: text.slice(0, 80) };
    }
    const qs = [];
    const rawQs = mark.questions || [];
    for (let idx = 0; idx < rawQs.length; idx += 1) {
      const q = rawQs[idx] || {};
      qs.push({
        id: String(q.id || `q_${idx}`),
        question: q.question || '',
        header: q.header || '',
        body: q.detail || '',
        options: (q.options || []).map((o) => dshOption(o)),
        multi_select: Boolean(q.multi),
        allow_other: true,             // dsh 作答支持自由文本（custom 字段）
        other_label: '其他',
        other_description: '',
      });
    }
    const q0 = qs.length ? qs[0] : {};
    const question = q0.question || 'agent 正在等待你的回答';
    // qid 走插件给的 tool call id（= dsh userQuestions.answer 的 callId）
    const callId = String(mark.call_id || '');
    return { pending: true, busy: true, kind: 'question',
      qid: callId, questions: qs,
      wire: q0.id || 'q_0',
      question,
      header: q0.header || '',
      body: q0.body || '',
      options: q0.options || null,
      multi_select: q0.multi_select,
      allow_other: true,
      other_label: '其他',
      other_description: '',
      answerable: Boolean(callId),
      text: question.slice(0, 80) };
  } catch {
    return null;                       // 读注册表异常：本轮跳过
  }
}

/** `_iw_interaction` 的 Python 名别名。 */
export const _iw_interaction = iwInteraction;

/**
 * 中枢重连边沿 ⇒ 清空看管记账（Python `_watch_generation_sync`）；返回是否发生了清空。
 *
 * 依据 `dshevents.stats().reconnects`（纯本地读口，零 HTTP 请求）。为什么必须清：驱动侧
 * `watched` 是插件进程内的易失状态，而平台记账仍写着「已声明过」——不清就会一直命中陈旧
 * 缓存、不再 POST `/watch`（bug_report/20261008_1935 的宿主重载场景）。
 * @returns {boolean}
 */
export function watchGenerationSync() {
  let gen;
  try {
    gen = eventStats().reconnects;
  } catch {
    return false;
  }
  if (gen === null || gen === undefined) return false;
  const prev = WATCH_GEN;
  WATCH_GEN = gen;
  if (prev === null || prev === undefined || prev === gen) return false;
  WATCHED.clear();
  return true;
}

/** `_watch_generation_sync` 的 Python 名别名。 */
export const _watch_generation_sync = watchGenerationSync;

/**
 * 声明「平台看管该会话」（Python `_ensure_watch`；幂等，成功才入缓存）。
 *
 * 失败留痕返回 false，**不重试**（调用方据此拒投并给明确文案；下一轮调和器扫描会自然重试）。
 * `force=true` 跳过缓存命中、强制重发一次声明（唯一调用方是 `renameCardSession` 的 404 重试）。
 * **async**。
 * @returns {Promise<boolean>}
 */
export async function ensureWatch(sid, force = false) {
  sid = String(sid || '');
  if (!sid) return false;
  watchGenerationSync();
  if (!force && WATCHED.has(sid)) return true;
  const drv = boardDriver();
  let ok;
  try {
    ok = Boolean(await drv.watchSession(sid));
  } catch (exc) {
    const hint = (exc && exc.code === drv.WATCH_UNSUPPORTED)
      ? '（插件过旧：无 /watch 端点，请重装插件并重启 dsh web）' : '';
    console.log(`[board] 看管声明失败 sid=${sid}: ${errText(exc)}${hint}`);
    return false;
  }
  if (!ok) {
    console.log(`[board] 看管声明失败 sid=${sid}: 驱动未确认看管（watched=false）`);
    return false;
  }
  WATCHED.add(sid);
  return true;
}

/** `_ensure_watch` 的 Python 名别名。 */
export const _ensure_watch = ensureWatch;

/**
 * 卡面改名 → 同步改 DSH 会话标题（Python `rename_card_session`，best-effort）。
 * 返回 `(ok, error, accepted)` 三元组（Node 用数组 `[ok, error, accepted]`）。
 *
 * 两跳：① `rename`（池内）；② 首跳 404（池外）⇒ `ensureWatch(sid, true)` 后重试一次。
 * 失败**不抛**：卡面是用户的编辑，必须先生效；调用方把原因回给前端。
 * `accepted` = 驱动回执里宿主**接受**的标题（可能被截断），成功时非空。
 * **async**。
 * @returns {Promise<[boolean, string, string]>}
 */
export async function renameCardSession(sid, title) {
  sid = String(sid || '');
  title = String(title || '').trim();
  if (!sid || !title) return [false, '缺少会话或标题，未同步 DSH 会话名', ''];
  const drv = boardDriver();
  let last = '';
  for (const attempt of [1, 2]) {
    try {
      const r = (await drv.rename(sid, title, { timeoutMs: RENAME_TIMEOUT * 1000 })) || {};
      return [true, '', String(r.title || title)];
    } catch (exc) {
      last = errText(exc);
      const poolMiss = exc && exc.code === 404;
      if (attempt === 1 && poolMiss && await ensureWatch(sid, true)) {
        console.log(`[board] 卡面改名：池外会话补看管声明后重试 sid=${sid}`);
        continue;
      }
      break;
    }
  }
  return [false, last, ''];
}

/** `rename_card_session` 的 Python 名别名。 */
export const _rename_card_session = renameCardSession;

/**
 * 看管引用集：全部卡片的 `session_id ∪ sessions`（Python `_watch_card_refs`）。
 *
 * 含归档项目（归档 ≠ 删卡）。坏 JSON 按「无附加会话」防御。
 * @returns {Set<string>}
 */
export function watchCardRefs(options = {}) {
  const refs = new Set();
  for (const proj of dbmod.listProjectsAll(options)) {
    for (const card of dbmod.listBoardCards(proj.id, options)) {
      const sid = String(card.session_id || '');
      if (sid) refs.add(sid);
      try {
        for (const s of JSON.parse(card.sessions || '[]')) {
          if (s) refs.add(String(s));
        }
      } catch { /* 坏 JSON 按无附加会话（防御） */ }
    }
  }
  return refs;
}

/** `_watch_card_refs` 的 Python 名别名。 */
export const _watch_card_refs = watchCardRefs;

/**
 * 该 sid 是否仍有在途消息（活跃 `m:` 行）（Python `_watch_msg_inflight`）。
 *
 * 读口用 `chat.liveOfSid`。读不到按「有在途」保守处理：宁可少撤，不可误撤。
 * @returns {boolean}
 */
export function watchMsgInflight(sid) {
  try {
    return Boolean(chatMod.liveOfSid(sid));
  } catch {
    return true;
  }
}

/** `_watch_msg_inflight` 的 Python 名别名。 */
export const _watch_msg_inflight = watchMsgInflight;

/**
 * 撤掉**确无需要**的看管声明（Python `_watch_prune`；`POST /watch {on:false}`），返回撤销条数。
 *
 * 判据（两条都成立才撤）：① 无卡引用；② 无在途 `m:` 行。撤销成功后**再复核一次**：窗口内
 * 若又冒出新声明/新在途消息，立即补偿重声明——宁可多打一次幂等 `/watch`，不可留「缓存无、
 * 驱动无」而在途消息撞 404。驱动 I/O 全程在同步段之外（锁纪律的 Node 退化形态，见段首差异⑤）。
 *
 * 节流：本函数由 `_iw_once` **每个状态帧**调用一次，而「扫卡」是 O(项目数 × 每卡数) 的 DB 读，
 * 故「扫卡 + 撤销」节流到 `WATCH_PRUNE_INTERVAL`；**代次检查不参与节流**（它是正确性路径）。
 * `WATCHED` 为空（常态）时零 DB 访问。
 *
 * **async**（撤销/补声明要打驱动）。
 * @returns {Promise<number>}
 */
export async function watchPrune() {
  watchGenerationSync();               // 中枢重连过：陈旧记账先作废
  if (!WATCHED.size) return 0;         // 常态：零 DB 访问（不消耗节流窗口）
  const now = nowSec();
  if (now - WATCH_PRUNE_AT < WATCH_PRUNE_INTERVAL) {
    return 0;                          // 本窗口已扫过：只推迟回收，不影响正确性
  }
  WATCH_PRUNE_AT = now;                // 开窗（含扫描异常：下一拍再试）
  const refs = watchCardRefs();
  const candidates = [...WATCHED].filter((s) => !refs.has(s)).sort();
  let n = 0;
  const drv = boardDriver();
  for (const sid of candidates) {
    // —— 撤销前复核（唯一信任点）——
    if (!WATCHED.has(sid) || refs.has(sid) || watchMsgInflight(sid)) continue;
    WATCHED.delete(sid);               // 先出缓存：并发 ensureWatch 转为重新声明
    try {
      await drv.watchSession(sid, false);
    } catch (exc) {
      WATCHED.add(sid);                // 撤销失败：放回，下轮再试
      console.log(`[board] 看管撤销失败 sid=${sid}: ${errText(exc)}`);
      continue;
    }
    // —— 撤销后复核：窗口内并发落下的新声明 / 新在途消息 ⇒ 补偿重声明 ——
    const redeclared = WATCHED.has(sid);
    if (redeclared) WATCHED.delete(sid);          // 清掉再声明：强制真发一次 POST
    if (redeclared || watchMsgInflight(sid)) {
      await ensureWatch(sid);
      continue;
    }
    n += 1;
  }
  return n;
}

/** `_watch_prune` 的 Python 名别名。 */
export const _watch_prune = watchPrune;

/**
 * 送达前对**非池内**（外部）会话重新声明一次看管（Python `_watch_before_delivery`）。
 *
 * 为什么必须补：`watchPrune` 的撤销判据不含活跃 `a:`（作答）行 ⇒ 答案已入队未送达时点，
 * prune 可能已把该 sid 的看管撤掉 ⇒ 送达 `/answer`·`/approval` 撞驱动「未看管」404。
 * 判据用 `dshevents.get(sid)` 的 `owned`：`owned is False` ⇒ 外部会话（需显式看管）；
 * `owned is True`（平台自持）与 `None`（未知）一律不声明。幂等且廉价（命中缓存零请求）。
 * **async**。
 * @returns {Promise<void>}
 */
export async function watchBeforeDelivery(sid) {
  sid = String(sid || '');
  if (!sid) return;
  let st;
  try {
    st = eventGet(sid);
  } catch {
    st = null;
  }
  if (st === null || st === undefined || st.owned) return;   // 未知与平台自持：不碰
  await ensureWatch(sid);
}

/** `_watch_before_delivery` 的 Python 名别名。 */
export const _watch_before_delivery = watchBeforeDelivery;

/** 调和动作 → 落库字段（Python `_RECONCILE_FIELDS`） */
const RECONCILE_FIELDS = {
  recover: { column_key: 'doing', block_kind: null, block_text: '' },
  to_doing: { column_key: 'doing', block_kind: null, block_text: '' },
  to_review: { column_key: 'review', block_kind: null, block_text: '' },
  // to_done 生产路径走 `dequeueCard(toColumn='done')`（行收口 + 搬列一体）；
  // 本项为兜底字段表，保持「动作 -> 字段」表完整（勿直写：会漏行收口）
  to_done: { column_key: 'done', block_kind: null, block_text: '' },
};

/**
 * 调和状态机（**纯函数**，单测覆盖）（Python `_reconcile_action_for`）。
 *
 * 按会话实况 r（pending/busy）、归档态 `archived` 与当前卡状态得出动作：
 * `'block'`（进阻塞+interaction）/ `'recover'`（交互阻塞解除回 doing）/ `'to_doing'` /
 * `'to_review'` / `'to_done'`（主会话已被 dsh 归档）/ `null`（不动）。
 *
 * `archived`（null=未知/false/true）**True 时优先于一切忙闲判定**直接落 `to_done`——dsh
 * 归档即该会话的终态意图；未知（null，中枢断连）一律不动作（不变量「断连=未知」）。
 * `running = busy || (live_msg && !orphan_hold)`（2026-09-11 立，2026-10-10 加孤儿行例外）。
 * 完整判定序见 Python docstring（todo/done 终态不动；manual/queue/starting/pending 四段
 * 各只有一条放行；在管运行只做 block/recover，唯一例外是 review 卡实况在跑 → 归位 doing）。
 *
 * @param {string} family
 * @param {object} card
 * @param {object|null} r
 * @param {boolean} [hasRun]
 * @param {boolean} [liveMsg]
 * @param {boolean} [stopRecent]
 * @param {boolean|null} [archived]
 * @param {boolean} [starting]
 * @param {boolean} [orphanHold]
 * @returns {string|null}
 */
export function reconcileActionFor(family, card, r, hasRun = false, liveMsg = false,
  stopRecent = false, archived = null, starting = false, orphanHold = false) {
  if (family !== 'dsh_plugin') return null;
  if (archived === true) {
    // 归档电平优先（2026-10-05）：主会话已归档 ⇒ 卡片归「已完成」，含 todo 卡
    return card.column_key === 'done' ? null : 'to_done';
  }
  if (card.column_key === 'todo' || card.column_key === 'done') return null;
  const pending = Boolean(r && r.pending);
  const busy = Boolean(r && r.busy);
  // 孤儿运行行只认实况 busy（缺陷 B）：live_msg 不能再把它按「在跑」保住
  const running = busy || (Boolean(liveMsg) && !orphanHold);
  if (card.block_kind === 'manual') {
    if (pending) return null;                    // 等待用户回答：维持阻塞态
    if (stopRecent) return liveMsg ? 'to_doing' : null;
    return running ? 'to_doing' : null;
  }
  if (card.block_kind === 'queue') return pending ? 'block' : null;
  if (starting) {
    // 起跑窗口：busy=False 是「turn 还没开始」而非「已结束」，不做忙/闲列映射
    return pending ? 'block' : null;
  }
  if (pending) {
    if (card.column_key === 'blocked' && card.block_kind === 'interaction') {
      return null;                               // 已在交互阻塞，等待作答
    }
    return 'block';                              // doing / review → 阻塞
  }
  // 无等待
  if (card.column_key === 'blocked' && card.block_kind === 'interaction') {
    if (hasRun) return 'recover';
    return running ? 'to_doing' : 'to_review';
  }
  // blocked 且无阻塞标记（2026-09-17 归位）：按会话实况归位
  if (card.column_key === 'blocked' && !card.block_kind) {
    return (running || hasRun) ? 'to_doing' : 'to_review';
  }
  if (hasRun) {
    // 在管运行：列流转归 finishRun。唯一例外——review 卡实况在跑（起跑窗口误判的遗留形态）
    if (card.column_key === 'review' && running && !stopRecent) return 'to_doing';
    return null;
  }
  if (card.column_key === 'doing') return running ? null : 'to_review';
  if (card.column_key === 'review') return running ? 'to_doing' : null;
  return null;
}

/** `_reconcile_action_for` 的 Python 名别名。 */
export const _reconcile_action_for = reconcileActionFor;

/**
 * 执行调和动作（read-verify-write）（Python `_iw_apply`）。
 *
 * 写库前用 `getBoardCard` 重读当前行，并重评 has_run/live_msg/stop_recent/起跑窗口、重跑状态机：
 * 仅当动作仍成立才写库；否则跳过（保护用户手动拖卡/其他写者不被调和窗口内的旧判定覆盖）。
 * 已答待送达（wait_items 有活跃 answer 等待项）的卡一律跳过：其列归属由作答/送达路径独占。
 *
 * `block` 分支的飞书推送在 Node 是 `feishuCardBlocked`（D1 拆名：原先与 review 路径共用
 * `feishuCardReview`，而两个调用点不带形态标签 ⇒ 无法无歧义复原）——M7 才落地（未注入即跳过，
 * 与 Python 的「该分支不存在」同形；Python 侧推送异常也只留一行诊断）。**async**。
 *
 * @returns {Promise<void>}
 */
export async function iwApply(family, card, action, r, options = {}) {
  const cur = dbmod.getBoardCard(card.id, options);
  if (cur === null || cur === undefined) return;      // 卡片已删：跳过
  if (isAnswerPending(card.id, options)) return;      // 已答待送达：调和动作一律跳过
  const hasRun = hasActiveRun(card.id);
  const liveMsg = chatMod.liveOfSid((cur.session_id || '').trim(), options);
  // 写前复核同样重取「孤儿运行行」（缺陷 B，短路口径同 `iwOnce`）
  const orphan = Boolean(liveMsg) && orphanHold(cur.id, options);
  const again = reconcileActionFor(family, cur, r, hasRun, liveMsg,
    stopRecent(cur.id, options), eventArchived(cur.session_id || ''),
    startingWindow(cur.id, null, options), orphan);
  if (again !== action) return;                       // 状态已变：跳过，不写库
  if (action === 'to_done') {
    // dsh 侧归档 → 卡片进「已完成」（反向规则）：走容器迁移原语收口
    // （归档自带 stopActivity 语义，stop=False 不再发 cancel）；随后级联归档其余绑定
    // 会话（dsh 侧已改、回滚不了）⇒ best-effort + 退避重试（strict=False）。
    await dequeueCard(card.id, { reason: 'dsh 归档同步', toColumn: 'done', options });
    await archiveCardSessions(dbmod.getBoardCard(card.id, options) || cur, true,
      '归档级联', { strict: false, options });
    return;
  }
  if (action === 'block') {
    if (cur.block_kind === 'queue') {
      // 落阻塞 eager 丢排队（v2b T3，裁决 R9）：c: 等待行即取消（行+占位原子）
      cancelCardWait(card.id, '落阻塞丢排队', options);
    }
    dbmod.updateBoardCard(card.id, true,
      { column_key: 'blocked', block_kind: 'interaction',
        block_text: String((r && r.text) || '').slice(0, 80) }, options);
    // M7.5-R3（Lead 裁决 D1）：交互阻塞用**独立钩子名** `feishuCardBlocked`（4 位实参），
    // 不再与 `feishuCardReview`（review 路径的 3 位实参）共用同一个名字——两个调用点不带
    // 形态标签，靠「第 4 位是否存在」猜形态是静默误路由。未注入 = 「该分支不存在」。
    const notify = optionalHook('feishuCardBlocked');
    if (notify !== null) {
      try {
        notify(cur.project_id, cur, r, options);
      } catch (e) {
        console.log(`[board] 交互阻塞飞书推送失败: ${errText(e)}`);
      }
    }
    // 卡离开「正在开发」容器 ⇒ 出队（无条件行收口：容器迁移本身即出队）。
    // 不停止会话（stop=False：abort 会清掉等待用户答复的 pending 提问）。
    try {
      await leaveDoing(cur, { stop: false, reason: '出队-交互阻塞', options });
    } catch { /* 出队失败不阻断调和 */ }
    return;
  }
  if (action === 'recover') {
    // 平台在管运行期交互阻塞解除：直回 doing + 行补回
    recoverToDoing(cur, options);
    return;
  }
  // to_doing **不再落排队占位**（2026-09-13 修订）；收尾归调和器下一轮判定。
  if (action === 'to_review') {
    // 卡归位「待审核」容器 ⇒ 出队行收口（I1：不在正在开发容器即无活跃 c: 行）。
    // 经唯一收尾点 finish 幂等收口（无活跃行时各子步 no-op）。
    await leaveDoing(cur, { stop: false, reason: '出队-归位待审核', options });
  }
  dbmod.updateBoardCard(card.id, true, { ...RECONCILE_FIELDS[action] }, options);
}

/** `_iw_apply` 的 Python 名别名。 */
export const _iw_apply = iwApply;

/**
 * 平台在管运行卡的交互阻塞解除（Python `_recover_to_doing`）：一律直回 doing。
 *
 * 调用方 recover 蕴含平台在管运行（`RUNS` 条目存在）；本卡已有活跃行则直回 doing（行不动），
 * 否则补回运行行（防恢复运行的会话与后续入队单元并发；收尾仍归 `finishRun`）。
 * runner 缺位（退化为直起路径）直写 doing。**保持同步**（只碰 db/waitq/runner）。
 * @returns {void}
 */
export function recoverToDoing(card, options = {}) {
  const pid = card.project_id;
  const inst = runnerInstance();
  dbmod.updateBoardCard(card.id, true, { ...RECONCILE_FIELDS.recover }, options);
  if (inst !== null && !cardUnitActive(card.id, options)) {
    const ext = { reason: '阻塞解除恢复' };
    const rec = RUNS.get(card.id);
    if (rec !== undefined && rec !== null && rec.proc !== null && rec.proc !== undefined) {
      ext.pid = rec.proc.pid;          // CLI 判据（R11④ 进程存活裁活）
    }
    inst.cardStarted(card.id, pid, ext, options);
  }
}

/** `_recover_to_doing` 的 Python 名别名。 */
export const _recover_to_doing = recoverToDoing;

/**
 * 一轮调和扫描（Python `_iw_once`；统一调和器，事件驱动 + 60s 兜底）。
 *
 * 未归档项目的 dsh 族卡片 → 归档电平/边沿两条规则 → 守卫跳过 → 读会话实况（等待态+busy）
 * + 本卡消息单元实况（live_msg）→ 调和状态机 → 写缓存/落库；同轮维护外部条目 ext 行
 * （busy 且无平台持有者 ⇒ 建/保 ext 行；实况空闲/挂起/卡离开发列的行收口）；
 * 行集合变化 notify runner 唤醒排队单元重新挑选。节拍尾部：归档重试、`_ARCH_SEEN` 有界清理、
 * starting 超时对账、看管回收。
 *
 * 实况读口=事件中枢注册表（`iwInteraction`，零请求）。单卡异常不外抛（不影响其他卡/项目）。
 * **async**（本轮回调 `archiveCardSessions`/`iwApply` 等 async 口）。
 *
 * @returns {Promise<void>}
 */
export async function iwOnce(options = {}) {
  const now = nowMs();
  let extChanged = false;
  const seenSids = new Set();          // 本轮在场的归档判定 sid（`_ARCH_SEEN` 有界清理用）
  // 起跑窗口批量读口（一轮一次；逐卡点查会成 N+1）
  const startingIds = startingCardIds(options);
  for (const proj of dbmod.listProjectsAll(options)) {
    if (proj.archived) continue;
    const fam = webFamily(proj);
    if (fam === null) {
      // 退场族无 busy 信号：不构成占用（在场残留行防御收口）
      if (finishAllExt(proj.id, '退场族无外部占用信号', options)) extChanged = true;
      continue;
    }
    const extBusy = {};                // 本轮占位目标：{card_id: sid}（实况 busy）
    const extHold = new Set();         // 探测不明的占用候选卡（保留既有行）
    for (const card of dbmod.listBoardCards(proj.id, options)) {
      try {
        // —— 归档同步（2026-10-05）：读本地归档集快照（零请求），两条规则 ——
        const sid = card.session_id || '';
        const arch = sid ? eventArchived(sid) : null;
        if (sid && arch !== null && arch !== undefined) {
          seenSids.add(sid);
          const prev = ARCH_SEEN.get(sid);
          ARCH_SEEN.set(sid, arch);
          if (prev === true && arch === false && card.column_key === 'done') {
            await archiveUnarchiveEdge(card, options);
            continue;
          }
        }
        if (arch === true && card.column_key !== 'done') {
          await iwApply(fam, card, 'to_done', null, options);
          continue;
        }
        if (card.column_key === 'todo' || card.column_key === 'done') continue;
        if (card.column_key === 'blocked'
            && !['interaction', 'queue', 'manual', null, undefined].includes(card.block_kind)) {
          continue;                    // 其他 blocked 类型（防御）；blocked+None 例外放行
        }
        if (!sid) continue;            // 无会话（从未起跑的真排队卡等）无可探测
        const r = iwInteraction(fam, proj, sid);
        // —— 看管声明（C 批 T5）：外部会话的投递/作答通道以平台显式 `POST /watch` 为闸 ——
        const st = eventGet(sid);
        if (st !== null && st !== undefined && !st.owned) {
          await ensureWatch(sid);
        }
        if (r === null) {
          // 实况读不到：两种语义必须分开（2026-10-07 实障修复，卡 870）——
          // ① 中枢断连＝真未知：保行；② 中枢在线而注册表无此 sid＝会话已不在池。
          if (!eventConnected() && !platformHolds(card.id, options)
              && !subagentSession(sid)) {
            extHold.add(card.id);
          } else if (eventAligned() && !platformHolds(card.id, options)) {
            // ③ 中枢可信却查不到 ⇒ 会话确已结束：补上卡列这一格（写前复核在 iwApply）
            await iwApply(fam, card, 'to_review', null, options);
          }
          continue;                    // 实况读不到：该卡本轮跳过，不搬列
        }
        // —— 外部条目占用候选（v2d T4）：busy 且非挂起、且平台不持有 ——
        if (r.busy && !r.pending && !platformHolds(card.id, options)
            && !subagentSession(sid, r.origin)) {
          extBusy[card.id] = sid;
        }
        if (hasActiveRun(card.id)) {
          // 平台在管运行卡：行心跳 + 证据（touch_unit 幂等，异常由本层 per-card try 兜底）
          touchUnit(KIND_CARD, card.id, `busy=${r.busy ? 1 : 0}(poll)`, options);
        }
        const c = IW_CACHE.get(sid) || {};
        Object.assign(c, r);           // pending/busy/qid/question/options/answerable/text
        c.ts = now;
        IW_CACHE.set(sid, c);
        const liveMsg = chatMod.liveOfSid(sid, options);   // 本卡消息在跑/排队
        // 孤儿运行行只在「本卡确有排队/执行中的消息」时才影响判定 ⇒ 短路那次行点查
        const orphan = Boolean(liveMsg) && orphanHold(card.id, options);
        const action = reconcileActionFor(fam, card, r, hasActiveRun(card.id), liveMsg,
          stopRecent(card.id, options), arch,
          startingWindow(card.id, startingIds, options), orphan);
        if (action) await iwApply(fam, card, action, r, options);
      } catch {
        continue;                      // 单卡异常不外抛（不影响其他卡/项目）
      }
    }
    // —— ext 行对账（每项目一轮；行集合变化唤醒补位，时机①/③）——
    try {
      if (extStaleFinish(proj.id, extBusy, extHold, options)) extChanged = true;
      for (const [cid, sid] of Object.entries(extBusy)) {
        if (upsertExt(proj, Number(cid), sid, options)) extChanged = true;
      }
    } catch {
      continue;
    }
  }
  if (extChanged) withRunner((inst) => inst.notifyBusyChange(options));
  // 归档同步尾巴：调和器级联失败留下的待重试项按退避重发；边沿表按在场集合做有界清理
  try {
    await archiveRetryTick();
  } catch { /* 重试异常不影响本轮其他对账 */ }
  if (ARCH_SEEN.size > ARCH_SEEN_MAX) {
    for (const sid of [...ARCH_SEEN.keys()]) {
      if (!seenSids.has(sid)) ARCH_SEEN.delete(sid);
    }
  }
  // starting 超时对账（v2d T3，裁决 R6）：超龄 starting 行三态复核
  try {
    reconcileStartingRows(options);
  } catch { /* 守护拍子不 crash（同 iwOnce 口径） */ }
  // 看管回收（C 批 T5）：卡删除/换绑会话后撤掉驱动的看管声明
  try {
    await watchPrune();
  } catch { /* 同上：回收失败下轮再来 */ }
}

/** `_iw_once` 的 Python 名别名。 */
export const _iw_once = iwOnce;

/**
 * watcher 缓存读取（Python `interaction_of_sid`）：`{pending, kind, qid, question, options,
 * answerable, text, ts}` 或 `null`（未检测/无等待）。
 * @returns {object|null}
 */
export function interactionOfSid(sid) {
  if (!sid) return null;
  const c = IW_CACHE.get(sid);
  return c ? { ...c } : null;
}

/** `interaction_of_sid` 的 Python 名别名。 */
export const _interaction_of_sid = interactionOfSid;

/** 任务会话按需探测的缓存时效（秒；Python `_IW_PROBE_TTL`） */
export const IW_PROBE_TTL = 5.0;

/**
 * 按需探测一个会话的等待态并写入 watcher 缓存（Python `interaction_probe`；任务会话端点/SSE 用）。
 *
 * 缓存新鲜（≤ `IW_PROBE_TTL`）直接复用，否则探测一次；探测失败（null）保留旧缓存不清态。
 * @returns {object|null}
 */
export function interactionProbe(family, proj, sid) {
  if (!sid) return null;
  const now = nowMs();
  const c = IW_CACHE.get(sid);
  const fresh = Boolean(c && now - Number(c.ts || 0) < IW_PROBE_TTL * 1000);
  if (!fresh) {
    const r = iwInteraction(family, proj, sid);
    if (r !== null) {
      const cc = IW_CACHE.get(sid) || {};
      Object.assign(cc, r);
      cc.ts = now;
      IW_CACHE.set(sid, cc);
    }
  }
  return interactionOfSid(sid);
}

/** `interaction_probe` 的 Python 名别名。 */
export const _interaction_probe = interactionProbe;

/**
 * 清理 watcher 缓存中该 sid 的条目（Python `_iw_clear`；回答成功后调用）。
 *
 * 已答/已流转的卡若残留 stale pending，`interactionOfSid` 会长期返回旧 pending，
 * 导致会话窗重复显示已答提问、阻塞徽标不消失。
 * @returns {void}
 */
export function iwClear(sid) {
  if (!sid) return;
  IW_CACHE.delete(sid);
}

/** `_iw_clear` 的 Python 名别名。 */
export const _iw_clear = iwClear;

/** watcher 缓存快照（测试与诊断用；Python 侧为模块私有 dict） */
export function iwCache() { return new Map([...IW_CACHE].map(([k, v]) => [k, { ...v }])); }

/**
 * **测试缝**：手工灌一条 watcher 缓存条目（`IW_CACHE.set(sid, 条目)`）。
 *
 * 为什么需要：调和器缓存由 `iwOnce` 从 dsh 状态帧学来，单测里要构造「有一道待答提问」
 * 这类状态就得真起一个中枢 + 驱动（重且脆）。Python 侧单测直接改模块私有 dict，
 * Node 侧给一个显式命名的测试缝（与 `routes/board.js:_setSseTiming` 同一先例）。
 * **生产路径不调用它**；名字里的 `ForTest` 就是这条约定。
 * @param {string} sid 会话 id
 * @param {object} patch 缓存条目（浅合并进该 sid 的现有条目）
 */
export function setIwCacheForTest(sid, patch = {}) {
  const cur = IW_CACHE.get(String(sid)) || {};
  IW_CACHE.set(String(sid), { ...cur, ...patch });
}

/** **测试缝**：`formatLocalSec` 的导出别名（用例要构造 `claimed_at` 这类本地时刻文本）。 */
export const formatLocalForTest = formatLocalSec;

/** 清空 watcher 缓存与启动标志（测试用；Python 侧靠进程重启重建） */
export function resetIwState() {
  IW_CACHE.clear();
  IW_STARTED = false;
}

// ---------- 调和器节拍（P4 事件化，board.py:5213-5284） ----------

/** 调和器兜底对账间隔（秒；Python `IW_SAFETY_SECONDS`） */
export const IW_SAFETY_SECONDS = 60.0;
/** 事件风暴合并窗口（秒；Python `IW_DEBOUNCE_SECONDS`） */
export const IW_DEBOUNCE_SECONDS = 0.15;
/** 两轮调和最小间隔（秒；Python `IW_MIN_INTERVAL`） */
export const IW_MIN_INTERVAL = 0.5;

/**
 * 跑一轮调和，**同一时刻至多一轮在飞**（Python 守护线程 `while True` 的 Node 等价物）。
 *
 * 为什么必须去重：Python 的 `_loop` 是单线程串行，而 `setInterval` 的拍子会**重入**
 * （上一轮 await 之处让出事件循环）。叠加一个 `_running` 闸即得同一条串行语义；掉拍只影响
 * 及时性（下一次状态帧或 `IW_SAFETY_SECONDS` 兜底会补上），不影响正确性。
 *
 * @returns {Promise<boolean>} 本轮是否真的跑了（false = 上一轮还在飞，跳过）
 */
let IW_RUNNING = false;
export async function iwTick() {
  if (IW_RUNNING) return false;
  IW_RUNNING = true;
  try {
    await iwOnce();
  } catch (e) {
    console.log(`[board] 调和轮异常: ${errText(e)}`);   // 后台拍子不许打死进程
  } finally {
    IW_RUNNING = false;
  }
  return true;
}

/**
 * 当前是否有一轮调和在飞（测试与诊断用）。
 * @returns {boolean}
 */
export function iwRunning() { return IW_RUNNING; }

let IW_TIMER = null;
let IW_LAST = 0.0;

/**
 * 启动交互检测常驻泵（Python `start_interaction_watcher`；幂等）。
 *
 * Python 是「一个 daemon 线程 + `dshevents.wait(60s)`」；Node 侧等价物是**一个定时器**：
 * `IW_SAFETY_SECONDS` 一拍跑一轮（事件驱动的即时唤醒由 `dshevents.subscribe` 挂钩，
 * 见下），拍内以 `IW_MIN_INTERVAL` 限速（与 Python 的 `IW_MIN_INTERVAL` 同值）。
 * 为什么用 subscribe 而不是 `dshevents.wait` 循环：Node 的 `wait` 是 Promise，循环体在
 * 无事件时会一直挂着（`IW_SAFETY_SECONDS` 兜底拍照旧由定时器给）；订阅回调是同步事件口，
 * 与 Python「状态帧到达即醒」逐点对应，且不会因单轮调和让出事件循环而丢帧。
 *
 * @returns {boolean} 是否本次真的启动了（false = 已在跑）
 */
export function startInteractionWatcher() {
  if (IW_STARTED) return false;
  IW_STARTED = true;
  const kick = () => {
    const now = nowSec();
    const gap = now - IW_LAST;
    const delay = gap < IW_MIN_INTERVAL ? (IW_MIN_INTERVAL - gap) * 1000 : 0;
    setTimeout(() => {
      IW_LAST = nowSec();
      void iwTick();
    }, delay).unref?.();
  };
  try {
    eventSubscribe(() => kick());
  } catch (e) {
    // 留痕（2026-10-16 实障）：这里原本写的是 `dshMod.subscribe(...)`——`dshMod` 是
    // `./dshdriver.js`（无该导出），TypeError 被空 catch 吞掉 ⇒ 事件面从没接上，调和器
    // 退化成只有 `IW_SAFETY_SECONDS` 兜底拍（生产实测：待审核卡追问后 ~60s 才进开发列）。
    // 事件面若真的不可用，必须能定位（不再是静默降级）。
    console.log(`[board] 调和器事件订阅失败（退化为 ${IW_SAFETY_SECONDS}s 兜底轮询）: ${errText(e)}`);
  }
  IW_TIMER = setInterval(() => {
    IW_LAST = nowSec();
    void iwTick();                     // 兜底对账（60s）；事件面未接时的唯一驱动
  }, IW_SAFETY_SECONDS * 1000);
  IW_TIMER.unref?.();
  return true;
}

/** `start_interaction_watcher` 的 Python 名别名。 */
export const _start_interaction_watcher = startInteractionWatcher;

/**
 * 停掉调和器泵（幂等；Python 侧 daemon 线程随进程退出，无对应动作——Node 的定时器需要
 * 显式清，否则单测进程被挂住）。
 * @returns {boolean} 是否本次真的停掉了
 */
export function stopInteractionWatcher() {
  if (!IW_STARTED) return false;
  IW_STARTED = false;
  try {
    if (IW_TIMER !== null) clearInterval(IW_TIMER);
  } catch { /* 已清 */ }
  IW_TIMER = null;
  return true;
}

// ---------- 作答与送达（board.py:4782-5250） ----------

/** 送达失败重试上限（Python `_ANSWER_MAX_RETRIES`） */
export const ANSWER_MAX_RETRIES = 3;
/** 放回后的退避窗口（秒；Python `_ANSWER_BACKOFF_S`） */
export const ANSWER_BACKOFF_S = 30.0;
/** 「提问不存在/已应答」的独立状态码（Python `_QUESTION_GONE_CODE`） */
export const QUESTION_GONE_CODE = 40405;

/**
 * 「问题已不存在」判定（Python `_answer_question_gone`；重试无意义）。
 *
 * envelope code=40405 为主判，msg 含 `not found` 为兜底（防驱动侧 code 口径漂移）。
 * Node 的 `DshDriverError` 把 Python 的 `(code, message)` 二元组摊成 `code` + `message`
 * （见 `dshdriver.js` 类注释），故判据读 `err.code`。
 * @returns {boolean}
 */
export function answerQuestionGone(err) {
  const code = err && err.code !== undefined ? err.code : null;
  const msg = err && err.message !== undefined ? String(err.message) : '';
  return code === QUESTION_GONE_CODE || msg.toLowerCase().includes('not found');
}

/** `_answer_question_gone` 的 Python 名别名。 */
export const _answer_question_gone = answerQuestionGone;

/**
 * 送达失败的统一处置（Python `_answer_retry_or_fail`）：retries+1；未满上限放回 waiting
 * （not_before 退避）并重入队；满上限 `markFailed` + 清占位（watcher 重探 pending 后交互卡
 * 重现、用户可重答——自愈出口与原调和器一致）。**保持同步**（只碰 waitq/db/runner）。
 * @param {number} cardId
 * @param {object} row 活跃 `a:` 行
 * @param {string} err
 * @returns {void}
 */
export function answerRetryOrFail(cardId, row, err) {
  const retries = Number(row.retries || 0) + 1;
  if (retries < ANSWER_MAX_RETRIES) {
    returnToWaiting(row.id, nowSec() + ANSWER_BACKOFF_S, true);
    withRunner((inst) => inst.submitAnswer(cardId));
    console.log(`[board] 答案送达失败（第 ${retries} 次，将重试）`
      + ` card=${cardId}: ${err}`);
    return;
  }
  markFailed(row.id, err);
  dbmod.updateBoardCard(cardId, true, { block_kind: null, block_text: '' });
  console.log(`[board] 答案送达失败（重试 3 次放弃）card=${cardId}: ${err}`);
}

/** `_answer_retry_or_fail` 的 Python 名别名。 */
export const _answer_retry_or_fail = answerRetryOrFail;

/**
 * 平台作答载荷（`answerInteraction` 的 out）→ dsh 原生 answer 载荷（Python `_dsh_answers`）。
 *
 * 平台形态：`[{wire, kind, option_id, option_ids, text}]`；
 * dsh 形态：`[{id, selected: [选项标签], custom: 自由文本}]`。
 * 平台侧选项 id 与 label 同值，故 selected 直接取 id。
 * @param {object[]} out
 * @returns {object[]}
 */
export function dshAnswers(out) {
  const items = [];
  for (const a of (out || [])) {
    const kind = String(a.kind || 'single');
    const ids = (a.option_ids || []).map((x) => String(x));
    const one = String(a.option_id || '');
    const selected = (kind === 'multi' || kind === 'multi_with_other')
      ? ids : (one ? [one] : []);
    const item = { id: String(a.wire || ''), selected };
    if (kind === 'other' || kind === 'multi_with_other') {
      item.custom = String(a.text || '');
    }
    items.push(item);
  }
  return items;
}

/** `_dsh_answers` 的 Python 名别名。 */
export const _dsh_answers = dshAnswers;

/**
 * 按权威行 meta 送达（Python `_answer_deliver`；worker 执行体与「立即送达」共用出口）。
 *
 * 异常原样上抛，退避/重试/40405 分流由调用方处置。单族：meta 的 qid 是 dsh 的 tool callId，
 * 作答走 `/answer`（与 Web GUI 同一条通道）；`accepted=false` ⇒ 抛 `DshDriverError(40405)`。
 * 审批：meta 带 `outcome` 走 `/approval`；未认领（GUI 作答）的 404/409 ⇒ 转 40405。
 * 外部（池外）会话：真正调驱动前经 `watchBeforeDelivery` 幂等补声明看管。
 *
 * **async**。
 * @returns {Promise<void>}
 */
export async function answerDeliver(proj, meta, options = {}) {
  const drv = boardDriver();
  if (webFamily(proj) !== 'dsh_plugin') {
    throw new Error(RETIRED_MSG);      // 退场族无作答送达通道（单族化）
  }
  // 送达前重声明看管（C 批 T7）：外部会话的看管可能已被 `watchPrune` 撤掉
  await watchBeforeDelivery(meta.sid);
  if (meta.approval_id) {
    const outcome = String(meta.outcome || '');
    if (!outcome) throw new dshMod.DshDriverError(40005, 'dsh 审批缺少 outcome（不应发生）');
    try {
      await drv.answerApproval(String(meta.sid || ''), String(meta.approval_id || ''),
        outcome);
    } catch (e) {
      if (e && (e.code === 404 || e.code === 409)) {
        throw new dshMod.DshDriverError(QUESTION_GONE_CODE,
          '审批已不存在（可能已由 dsh GUI 作答）');
      }
      throw e;
    }
    return;
  }
  const accepted = await drv.answerQuestion(String(meta.sid || ''), String(meta.qid || ''),
    dshAnswers(meta.answers || []));
  if (!accepted) {
    throw new dshMod.DshDriverError(QUESTION_GONE_CODE, '提问不存在或已应答');
  }
}

/** `_answer_deliver` 的 Python 名别名。 */
export const _answer_deliver = answerDeliver;

/** 行 meta 的宽容解析（Python 的 `json.loads(row["meta"] or "{}")` + isinstance dict 两段） */
function metaOf(row) {
  try {
    const parsed = JSON.parse(row.meta || '{}');
    return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 答案单元执行体（Python `_deliver_answer_unit`；runner worker 调用，P2 起答案投递唯一路径）。
 *
 * 前置：worker 拾取已 claim。载荷读自行 meta（重启后按表重建的答案同样送达）。成功
 * `markDone` → 卡归位 doing（`mark_unread=false`）→ `cardStarted` 补回运行位（顺序统一 R4）；
 * 「问题已不存在」（40405 类）直接 failed（清占位走自愈出口）；其余失败交 `answerRetryOrFail`；
 * 行已不活跃/项目不存在：cancel 并返回。**async**。
 * @returns {Promise<void>}
 */
export async function deliverAnswerUnit(cardId, options = {}) {
  const row = getActive(KIND_ANSWER, cardId, options);
  if (row === null || row === undefined) return;      // 已取消/已终态：无事可做
  const meta = metaOf(row);
  const proj = dbmod.getProject(row.project_id, options);
  if (proj === null || proj === undefined) {
    waitqCancel(KIND_ANSWER, cardId, '项目不存在', null, options);
    return;
  }
  const inst = runnerInstance();
  try {
    await answerDeliver(proj, meta, options);
  } catch (e) {
    if (answerQuestionGone(e)) {
      markFailed(row.id, errText(e), options);
      dbmod.updateBoardCard(cardId, true, { block_kind: null, block_text: '' }, options);
      console.log(`[board] 答案送达放弃（问题已不存在）card=${cardId}: ${errText(e)}`);
      return;
    }
    answerRetryOrFail(cardId, row, errText(e));
    return;
  }
  // —— 送达成功：终态 → 列归位 → 行补回运行位（顺序统一，R4）——
  markDone(row.id, options);
  // 归位开发列：恢复的会话在跑=运行中卡在开发列；同时兜底落列失败滞留 blocked 的卡。
  // 用户作答引发的回列不置「有更新」标记。
  dbmod.updateBoardCard(cardId, false,
    { column_key: 'doing', block_kind: null, block_text: '' }, options);
  if (inst !== null) {
    inst.cardStarted(cardId, row.project_id, { reason: '送达恢复' }, options);
  }
  console.log(`[board] 答案送达成功：card=${cardId}`);
}

/** `_deliver_answer_unit` 的 Python 名别名。 */
export const _deliver_answer_unit = deliverAnswerUnit;

/**
 * 「立即送达」（Python `deliver_pending_answer_now`）：把已作答·待送达的答案立即交给等待中的
 * 会话（不等项目空闲）。用户按钮入口。
 *
 * P2 起 = claim + 直投：先原子 claim（互斥点——与 worker 拾取竞争时只有一方成功）。成功：
 * `markDone` → 卡归位 → `cardStarted`；失败：「问题已不存在」立即 `markFailed` + 清占位；
 * 其余 `returnToWaiting` 放回（不动 retries）+ 重入队，错误交调用方提示。
 * 返回 `[ok, error]`（Python 元组）。**async**。
 * @returns {Promise<[boolean, string]>}
 */
export async function deliverPendingAnswerNow(cardId, options = {}) {
  const row = getActive(KIND_ANSWER, cardId, options);
  if (row === null || row === undefined || row.state !== STATE_WAITING) {
    return [false, '没有待送达的答案（可能已送达）'];
  }
  if (!claim(row.id, 'deliver-now', options)) {
    return [false, '没有待送达的答案（可能已送达）'];
  }
  const inst = runnerInstance();
  if (inst !== null) inst.removeAnswer(cardId, options);   // 出队：不再等统一队列
  const meta = metaOf(row);
  const proj = dbmod.getProject(row.project_id, options);
  if (proj === null || proj === undefined) {
    waitqCancel(KIND_ANSWER, cardId, '项目不存在', null, options);
    return [false, '项目不存在'];
  }
  try {
    await answerDeliver(proj, meta, options);
  } catch (e) {
    if (answerQuestionGone(e)) {
      // 「问题已不存在」对齐执行体口径：立即放弃不空转重试 3 次
      markFailed(row.id, errText(e), options);
      dbmod.updateBoardCard(cardId, true, { block_kind: null, block_text: '' }, options);
      return [false, `回答失败：${errText(e)}`];
    }
    returnToWaiting(row.id, 0.0, false, options);
    if (inst !== null) inst.submitAnswer(cardId, options);
    return [false, `回答失败：${errText(e)}`];
  }
  markDone(row.id, options);
  // 「立即送达」同队列送达路径口径：用户作答引发的回列不置「有更新」标记
  dbmod.updateBoardCard(cardId, false,
    { column_key: 'doing', block_kind: null, block_text: '' }, options);
  if (inst !== null) {
    inst.cardStarted(cardId, row.project_id, { reason: '立即送达' }, options);
  }
  console.log(`[board] 答案立即送达：card=${cardId}`);
  return [true, ''];
}

/** `deliver_pending_answer_now` 的 Python 名别名。 */
export const _deliver_pending_answer_now = deliverPendingAnswerNow;

/**
 * 作答/审批统一入队（Python `_queue_answer_unit`，v2b T1 裁决 R8 一律入队）。
 *
 * 权威行插「运行中最后一个条目后面」（`insertAfterPrefix`=前缀后/等待区最前；meta 携带完整
 * 送达载荷——重启存活的前提），落 doing/queue 排队占位（前端「排队中」徽标），补位启动时才
 * 由统一队列 worker 送达。
 *
 * 重复作答替换：先取消既有活跃行再全新插入（enqueue 族 API 的幂等语义是「复用既有行、不合入
 * 新 meta」，直接入队会把改答静默吞掉）。落列失败不自毁答案（等待项是权威事实源）。
 * **保持同步**（只碰 waitq/db/runner 与内存缓存）。
 * @returns {void}
 */
export function queueAnswerUnit(proj, cardId, sid, meta, options = {}) {
  if (getActive(KIND_ANSWER, cardId, options) !== null) {
    waitqCancel(KIND_ANSWER, cardId, '重复作答替换', null, options);
  }
  // ★ 通用「前缀后」入队口（waitq.py:305 `insert_after_prefix(kind, target, project_id,
  // meta, not_before)`；board.py:5055 的调用点原文即
  // `waitq.insert_after_prefix(waitq.KIND_ANSWER, card_id, proj["id"], meta=meta)`）。
  // 此前误用了**卡片专用**的 `insertCardAfterPrefix(cardId, projectId, extra, fromColumn,
  // blockText)`：实参整体错位 ⇒ 落出 `kind='card'`/`target_id='answer'` 的野行，答案行
  // 从未入队（作答与审批两条路径全部失效）。2026-10-12 M5-3 修。
  insertAfterPrefix(KIND_ANSWER, cardId, proj.id, meta, 0.0, options);
  withRunner((inst) => inst.submitAnswer(cardId, options));
  try {
    // 占位投影单写（P4 R6：等待单元是 answer 行不建 card 行，纯投影；列归位由送达执行体兜底）
    setCardWaitPlaceholder(cardId, '', options);
    // 防旧队列条目被拾起误发「继续」：只收 waiting 行（防御本义=队列条目不被拾起）
    waitqCancel(KIND_CARD, cardId, '作答排队防御', [STATE_WAITING], options);
    iwClear(sid);                       // 清交互缓存：前端不再显示作答卡
  } catch (e) {
    console.log('[board] 作答排队落列失败（答案已收，列待送达时归位）'
      + ` card=${cardId}: ${errText(e)}`);
  }
}

/** `_queue_answer_unit` 的 Python 名别名。 */
export const _queue_answer_unit = queueAnswerUnit;

/**
 * 作答卡片会话的待答提问（Python `answer_interaction`；单族 dsh_plugin，**整批提交全部子题**）。
 *
 * 先校验 watcher 缓存确为 pending（防已答/过期 qid 重复提交），再校验每题的作答形态。
 * 看板卡路径**一律入队**（`queueAnswerUnit`）；任务侧伪卡（无 id）保持直送，但直送前经
 * `watchBeforeDelivery` 补声明看管。成功后清理 watcher 缓存。
 *
 * `answers = [{wire, kind: single|multi|other|multi_with_other, option_id/option_ids/text}]`
 * 校验一律对缓存里的实况值取白名单：qid 走 `st.qid`（既堵 URL 拼接注入，也防旧 qid 重放）；
 * 每题 wire id 必须命中且不得重复、不得漏题；选项 id 必须落在该题 options 内；kind 与该题
 * 能力对齐；自定义输入限长。
 *
 * 返回 `null`=成功，`str`=错误信息（server 转 400 JSON `{error}`）。**async**（任务侧直送
 * 要打驱动）。
 * @returns {Promise<string|null>}
 */
export async function answerInteraction(proj, card, qid, answers, options = {}) {
  const sid = card.session_id || '';
  const st = sid ? interactionOfSid(sid) : null;
  if (!st || !st.pending) return '当前没有等待中的提问';
  if (st.kind !== 'question') return '当前等待的不是提问';
  if (!qid || String(qid) !== String(st.qid || '')) return '提问不存在或已过期';
  if (!Array.isArray(answers) || !answers.length) return '作答载荷非法';
  let qs = (st.questions || []).filter((q) => q);
  if (!qs.length) {
    // 兜底：旧缓存条目只有首题平面字段
    qs = [{ id: String(st.wire || 'q_0'), options: st.options || [],
      multi_select: Boolean(st.multi_select), allow_other: Boolean(st.allow_other) }];
  }
  const byId = {};
  for (const q of qs) byId[String(q.id || '')] = q;
  const given = {};
  for (const a of answers) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return '作答载荷非法';
    const wid = String(a.wire || '');
    if (!(wid in byId)) return '题目不存在或已过期';
    if (wid in given) return '题目作答重复';
    given[wid] = a;
  }
  if (Object.keys(given).length !== Object.keys(byId).length) return '请回答全部问题';
  const out = [];
  for (const q of qs) {                 // 按题目顺序组装（与前端展示序一致）
    const wid = String(q.id || '');
    const a = given[wid];
    const kind = String(a.kind || 'single');
    const text = String(a.text || '').trim();
    if (!['single', 'multi', 'other', 'multi_with_other'].includes(kind)) {
      return '作答形态非法';
    }
    if ((kind === 'multi' || kind === 'multi_with_other') && !q.multi_select) {
      return '该问题不支持多选';
    }
    if ((kind === 'other' || kind === 'multi_with_other') && !q.allow_other) {
      return '该问题不支持自定义输入';
    }
    const opts = q.options || [];
    const validIds = new Set(opts.map((o) => String(o.id || '')));
    const ids = (a.option_ids || []).map((x) => String(x));
    if (kind === 'multi' || kind === 'multi_with_other') {
      if (kind === 'multi' && !ids.length) return '未选择任何选项';
      if (ids.some((i) => !validIds.has(i))) return '选项不存在或已过期';
    } else if (kind === 'single' && opts.length
        && !validIds.has(String(a.option_id || ''))) {
      // 单选：无 options 的问题不设白名单（兼容无选项提问），有则必须命中
      return '选项不存在或已过期';
    }
    if (kind === 'other' || kind === 'multi_with_other') {
      if (!text) return '请输入内容';
      if (text.length > 2000) return '输入内容过长';
    }
    out.push({ wire: wid, kind, option_id: String(a.option_id || ''),
      option_ids: ids, text });
  }
  // 作答一律入队（v2b T1 裁决 R8）：仅看板卡（有卡 id）参与；任务侧会话保持直送。
  const cardId = card.id === undefined ? null : card.id;
  if (cardId === null || cardId === undefined) {
    const drv = boardDriver();
    if (webFamily(proj) !== 'dsh_plugin') {
      return `回答失败：${RETIRED_MSG}`;      // 退场族无作答通道（单族化）
    }
    await watchBeforeDelivery(sid);
    try {
      if (!await drv.answerQuestion(sid, qid, dshAnswers(out))) {
        return '回答失败：提问不存在或已过期';
      }
    } catch (e) {
      return `回答失败：${errText(e)}`;
    }
    iwClear(sid);
    return null;
  }
  queueAnswerUnit(proj, cardId, sid, { sid, qid, answers: out }, options);
  return null;
}

/** `answer_interaction` 的 Python 名别名。 */
export const _answer_interaction = answerInteraction;

/**
 * 应答卡片会话的待审批请求（Python `answer_approval`；单族 dsh_plugin，approval=ask 档挂起的
 * 工具调用）。
 *
 * 与 `answerInteraction` 同款白名单校验：`approval_id` 必须是缓存里的实况值；
 * `decision ∈ approved/rejected`；`scope="session"` 为「本会话内批准」——dsh 无该语义，
 * 显式拒绝。看板卡路径一律入队；任务侧保持直送（直送前同样补声明看管）。
 * 成功后清 watcher 缓存。返回 `null`=成功，`str`=错误信息。**async**。
 * @returns {Promise<string|null>}
 */
export async function answerApproval(proj, card, approvalId, decision, scope = '',
  options = {}) {
  const sid = card.session_id || '';
  const st = sid ? interactionOfSid(sid) : null;
  if (!st || !st.pending) return '当前没有等待中的审批';
  if (st.kind !== 'approval') return '当前等待的不是审批';
  if (!approvalId || String(approvalId) !== String(st.approval_id || '')) {
    return '审批不存在或已过期';
  }
  decision = String(decision || '');
  if (decision !== 'approved' && decision !== 'rejected') return '审批决定非法';
  scope = String(scope || '');
  if (scope !== '' && scope !== 'session') return '审批范围非法';
  const fam = agentFamily(proj.agent_path || '');
  if (fam !== 'dsh_plugin') return `审批失败：${RETIRED_MSG}`;
  if (scope === 'session') {
    return 'dsh 不支持「本会话内批准」（宿主无 session 级放行语义）';
  }
  const dshOutcome = { approved: 'allowed-once', rejected: 'rejected' }[decision];
  const cardId = card.id === undefined ? null : card.id;
  if (cardId === null || cardId === undefined) {
    await watchBeforeDelivery(sid);
    try {
      await boardDriver().answerApproval(sid, approvalId, dshOutcome);
    } catch (e) {
      return `审批失败：${errText(e)}`;
    }
    iwClear(sid);
    return null;
  }
  const meta = { sid, approval_id: String(approvalId), decision, scope,
    outcome: dshOutcome };              // 送达时直接用宿主 outcome
  queueAnswerUnit(proj, cardId, sid, meta, options);
  return null;
}

/** `answer_approval` 的 Python 名别名。 */
export const _answer_approval = answerApproval;

// ---------- 启动对账 / 调度 / recover（board.py:1551-1560 / 2661-3135 / 3849-3867） ----------

/** 起跑窗口超时（秒；Python `_STARTING_TIMEOUT_S` = 原 `WEB_TURN_START_TIMEOUT`） */
export const STARTING_TIMEOUT = 90;
/**
 * unknown 分支告警节流判据（Python `_starting_alert_due`）：本卡到窗返回 true。
 * @param {number} cardId
 * @returns {boolean}
 */
export function startingAlertDue(cardId) {
  const now = nowSec();
  if (STARTING_ALERT_AT.size > 256) STARTING_ALERT_AT.clear();   // 量小：粗粒度回收
  const last = STARTING_ALERT_AT.get(cardId) || 0;   // 秒（与 M5-2 的登记点同量纲）
  if (now - last < STARTING_ALERT_S) return false;
  STARTING_ALERT_AT.set(cardId, now);
  return true;
}

/** `_starting_alert_due` 的 Python 名别名。 */
export const _starting_alert_due = startingAlertDue;

/**
 * 超龄 starting 行的会话证据三态（alive / dead / unknown）+ 判定时读到的在管条目
 * （Python `_starting_evidence`）。返回 `[verdict, rec]`（Python 元组）。
 *
 * 判据链（可证才动、宁多等不误杀）：
 * ① 在管条目在场：dsh（web）会话 running → alive；会话 idle 且 turn 归属基线未动
 *    （`webTurnRan` 为 false）→ dead；其余 → unknown。
 * ② 无在管条目：dsh 会话 running → alive；其余 → unknown；
 *    族为 null（退场族防御）时按行 `evidence.pid` 的进程证据裁：活 → alive，否则 dead。
 * @returns {[string, object|null]}
 */
export function startingEvidence(card, options = {}) {
  const cid = card.id;
  const rec = RUNS.get(cid);
  if (rec !== undefined && rec !== null) {
    const proc = rec.proc;
    if (proc !== null && proc !== undefined) {
      return [proc.exitCode === null ? 'alive' : 'unknown', rec];
    }
    const st = sessionStateFamily(rec.family, rec.project_dir, rec.sid || '');
    if (st === STATE_RUNNING) return ['alive', rec];
    if (st === STATE_IDLE && !webTurnRan(rec)) return ['dead', rec];
    return ['unknown', rec];
  }
  const proj = dbmod.getProject(card.project_id, options);
  const family = proj === null || proj === undefined ? null : webFamily(proj);
  if (family === null) {
    const pid = unitEvidencePid(cid, options);           // 进程证据读行 evidence.pid
    if (pid !== null && pid !== undefined && pidAlive(pid)) {
      return ['alive', null];                            // 进程面确活（orphan 在跑，行自愈）
    }
    return ['dead', null];                               // 无在管条目 + 无存活进程 = 可证未起
  }
  const st = sessionStateFamily(family, proj.project_dir,
    String(card.session_id || '').trim());
  return [st === STATE_RUNNING ? 'alive' : 'unknown', null];
}

/** `_starting_evidence` 的 Python 名别名。 */
export const _starting_evidence = startingEvidence;

/**
 * starting 行超时对账（Python `_reconcile_starting_rows`；调和器节拍调用）。
 *
 * 对超龄（> `STARTING_TIMEOUT`=90s）的 `c:` starting 行按 `startingEvidence` 三态处置：
 * alive → `markRunning` 自愈（行转 running 留队，卡列/在管条目全不动）；
 * dead → 行 failed（error="starting 超时"）+ 卡回 `meta.from_column`（仅当卡仍在 doing）
 *        + `finish`（唯一收尾点）+ 告警日志；在管条目随处置弹出；
 * unknown → 只告警不处置（按卡节流）。aborted 条目（用户 stop_card）按 unknown 处置。
 * 仅 `c:` 参与（`t:`/`m:`/`a:` 的 starting 是执行全程常态）。**保持同步**（只碰 waitq/db/runner）。
 * @returns {number} 本次处置（dead）的条数——Python 无返回，Node 侧为诊断/测试加的计数
 */
export function reconcileStartingRows(options = {}) {
  const cutoff = formatLocalSec(nowSec() - STARTING_TIMEOUT);
  const nowMsVal = nowMs();
  let handled = 0;
  for (const row of activeItems(null, options)) {
    if (row.kind !== KIND_CARD || row.state !== STARTING) continue;
    const claimed = row.claimed_at || '';
    if (!claimed || claimed >= cutoff) continue;         // 未超龄（同为文本时刻口径）
    const cid = pyIntLoose(row.target_id);
    if (cid === null) continue;
    const card = dbmod.getBoardCard(cid, options);
    if (card === null || card === undefined) continue;   // 卡行已删：行收口归删除路径/recover
    let verdict;
    let rec;
    try {
      [verdict, rec] = startingEvidence(card, options);
    } catch {
      verdict = 'unknown'; rec = null;                   // 探测异常=状态不明：只告警
    }
    if (verdict === 'dead' && rec !== null && rec !== undefined && rec.aborted) {
      verdict = 'unknown';                               // 用户停卡：交巡视按正常停止收尾
    }
    if (verdict === 'alive') {
      if (markRunning(KIND_CARD, cid, options)) {
        console.log(`[board] starting 超时复核：卡 ${cid} 实况在跑 → `
          + `mark_running 自愈（claimed_at=${claimed}）`);
      }
      continue;
    }
    if (verdict === 'unknown') {
      if (startingAlertDue(cid)) {
        console.log(`[board] starting 超时告警（不可证未起，不处置）：卡 ${cid}`
          + ` claimed_at=${claimed}`);
      }
      continue;
    }
    // dead：可证未起——行 failed + 卡回 from_column + 唯一收尾点 + 告警
    if (rec !== null && rec !== undefined && RUNS.get(cid) === rec) {
      RUNS.delete(cid);                                  // 身份守卫同巡视：只弹判定时那条
    }
    finishByTarget(KIND_CARD, cid, STATE_FAILED, 'starting 超时', options);
    const meta = metaOf(row);
    const fields = { last_error: `starting 超时（${STARTING_TIMEOUT}s 未证实启动）`,
      last_error_at: nowMsVal };
    let back = String(meta.from_column || '');
    if (!COLUMNS.includes(back) || back === 'doing') {
      // force 落表行（from_column=doing）起跑未证实 → 回「待审核」更准；缺失/非法仍回落 blocked
      back = back === 'doing' ? 'review' : 'blocked';
    }
    if (card.column_key === 'doing') {
      // 仅起跑窗口（仍在 doing）回列；卡已被他路归位则只记错误不抢列
      fields.column_key = back;
      fields.block_kind = null;
      fields.block_text = '';
    }
    dbmod.updateBoardCard(cid, true, fields, options);
    finish(`c:${cid}`, 'starting 超时', { options });    // 唯一收尾点：行收口 + notify 补位
    handled += 1;
    console.log(`[board] starting 超时：卡 ${cid} 超 ${STARTING_TIMEOUT}s 未证实启动 → `
      + `行 failed、卡回 ${fields.column_key || card.column_key}（claimed_at=${claimed}）`);
  }
  return handled;
}

/** `_reconcile_starting_rows` 的 Python 名别名。 */
export const _reconcile_starting_rows = reconcileStartingRows;

/**
 * 排队占位缺等待项行自愈（Python `_heal_queue_placeholders`；30s 全量对账节拍，2026-10-10 实障卡 936）。
 *
 * 卡片停在「正在开发」+`block_kind='queue'` 但 wait_items 里没有对应的活跃 `c:` 行 ⇒ 补位器
 * 永远拾不到该卡，卡片永久僵在排队态。本函数把 `recover` 尾段那条规则**周期化**：逐张排队占位卡
 * 核对，行缺失即经 `runner.submitCard` 补建（幂等）。
 *
 * 跳过四类（都不是「行丢了」）：已答待送达（活跃 `a:` 行在场）、独立 worktree 卡、
 * 平台在管（`hasActiveRun`）、**会话实况在跑**（注册表 `status==='running'`）。
 * 异常逐卡吞；`runner` 单例缺位只报告不自愈。
 * @returns {number} 本次补建条数
 */
export function healQueuePlaceholders(options = {}) {
  const inst = runnerInstance();
  let queued;
  try {
    queued = dbmod.listQueuedBoardCards(options);
  } catch (e) {
    console.log(`[board] 排队占位自愈扫描失败: ${errText(e)}`);
    return 0;
  }
  let healed = 0;
  for (const card of queued) {
    const cid = pyIntLoose(card.id);
    if (cid === null) continue;                          // 脏 id：理论项，跳过
    try {
      if (String(cardOpt(card, 'worktree') || '').trim()) continue;   // worktree 卡不入队
      if (getActive(KIND_CARD, cid, options) !== null) continue;      // 行在场：正常排队
      if (getActive(KIND_ANSWER, cid, options) !== null) continue;    // 已答待送达
      if (hasActiveRun(cid)) continue;                                // 会话在跑：行归收尾路径
      const sid = String(card.session_id || '').trim();
      if (sid) {
        let st = {};
        try {
          st = eventGet(sid) || {};
        } catch { st = {}; }                             // 读口异常按未知
        if (st.status === 'running') continue;           // 实况在跑：补行会重复投递
      }
      // 占位在、行不在：`enqueue_card` 单事务红线（行+占位原子）声称此形态「从结构上消失」，
      // 出现即异常——先落一行异常报告，再补建
      console.log(`[board] 排队占位缺等待项行（占位在、行不在）：c:${cid}`
        + `（项目 ${card.project_id}）`);
      if (inst === null) continue;                       // runner 缺位：只报告
      inst.submitCard(cid, '', '', false, options);
      healed += 1;
    } catch (e) {
      console.log(`[board] 排队占位补建失败：c:${cid}: ${errText(e)}`);
    }
  }
  return healed;
}

/** `_heal_queue_placeholders` 的 Python 名别名。 */
export const _heal_queue_placeholders = healQueuePlaceholders;

/**
 * 一轮巡视（Python `_watch_once`）：结束会话收尾 + 排队占位缺行自愈 + 定时到点开工 +
 * session 自动同步。
 *
 * 定时扫描：todo 列到点卡片经统一入口进 doing（一律入队）；被门禁拦则清定时记错误；
 * 起会话失败无需再处理（`enterDoing` 已置回 todo）。**async**（`enterDoing` 要 await 起会话）。
 * @returns {Promise<void>}
 */
export async function watchOnce(options = {}) {
  watchRunsOnce(options);
  // 排队占位缺行自愈（30s 节拍）：占位在、行不在 ⇒ 补位器永远拾不到
  try {
    healQueuePlaceholders(options);
  } catch { /* 巡视不因自愈失败中断（下一拍再来） */ }
  const nowMsVal = nowMs();
  let rows = [];
  try {
    dbmod.withReadDb(options, (handle) => {
      rows = handle.prepare(
        "SELECT * FROM board_cards WHERE column_key='todo'"
        + ' AND scheduled_at IS NOT NULL AND scheduled_at<=?').all(nowMsVal);
    });
  } catch (e) {
    console.log(`[board] 定时扫描失败: ${errText(e)}`);
    rows = [];
  }
  for (const r of rows) {
    const proj = dbmod.getProject(r.project_id, options);
    if (proj === null || proj === undefined || proj.archived) continue;   // 归档项目不自动开工
    const [, err] = await enterDoing(proj, r, '', false, false, false, options);
    if (err !== null && err !== undefined && String(err.blocked || '').includes('blocked')) {
      // 父任务未 done：清定时记错误（不再每 30s 重试点燃）
      dbmod.updateBoardCard(r.id, true, { scheduled_at: null,
        last_error: `定时到点但被门禁拦截（${err.blocked}）`, last_error_at: nowMsVal },
      options);
    }
  }
  // session 自动同步：逐项目归类外部 agent 会话（单项目异常不影响其他项目）
  for (const proj of dbmod.listProjectsAll(options)) {
    if (proj.archived) continue;                         // 归档项目不自动同步
    try {
      await syncSessions(proj, options);
    } catch { /* 单项目异常不影响其他项目 */ }
  }
}

/** `_watch_once` 的 Python 名别名。 */
export const _watch_once = watchOnce;

/** 调度节拍（秒；Python 硬编码 5s，每 6 拍跑一次全量对账） */
export const SCHED_TICK_SECONDS = 5;
/** 全量对账间隔（拍数；Python `beat % 6 == 0`） */
export const SCHED_BEAT_EVERY = 6;

let SCHED_STARTED = false;
let SCHED_TIMER = null;
let SCHED_BEAT = 0;
let SCHED_RUNNING = false;

/**
 * 启动看板调度守护泵（Python `start_scheduler`；幂等）。30s 全量对账节拍（`watchOnce`）；
 * 节拍间 5s 唤醒一次（Python 保留的空转拍——单族 dsh 的状态实况由调和器消费，本泵只做全量对账）。
 *
 * Node 形态：`setInterval(SCHED_TICK_SECONDS)` + 拍计数（`beat % SCHED_BEAT_EVERY === 0`）。
 * 拍体全包 `try/catch`（后台拍子不许打死进程）并叠 `SCHED_RUNNING` 重入闸（await 处会让出
 * 事件循环，定时器会重入）。
 * @returns {boolean} 是否本次真的启动了（false = 已在跑）
 */
export function startScheduler() {
  if (SCHED_STARTED) return false;
  SCHED_STARTED = true;
  SCHED_TIMER = setInterval(() => {
    SCHED_BEAT += 1;
    if (SCHED_BEAT % SCHED_BEAT_EVERY !== 0) return;
    if (SCHED_RUNNING) return;                           // 上一拍还在飞：本拍跳过
    SCHED_RUNNING = true;
    Promise.resolve()
      .then(() => watchOnce())
      .catch((e) => { console.log(`[board] 调度节拍异常: ${errText(e)}`); })
      .finally(() => { SCHED_RUNNING = false; });
  }, SCHED_TICK_SECONDS * 1000);
  SCHED_TIMER.unref?.();
  return true;
}

/** `start_scheduler` 的 Python 名别名。 */
export const _start_scheduler = startScheduler;

/** 停掉调度泵（幂等；Python 侧 daemon 线程随进程退出，Node 的定时器需显式清） */
export function stopScheduler() {
  if (!SCHED_STARTED) return false;
  SCHED_STARTED = false;
  try {
    if (SCHED_TIMER !== null) clearInterval(SCHED_TIMER);
  } catch { /* 已清 */ }
  SCHED_TIMER = null;
  return true;
}

/**
 * web 驱动项目的 doing 卡重启恢复（Python `_recover_web_card`）。
 *
 * 会话在 dsh 宿主进程内（平台重启不影响），按事件中枢实况判定——running 重建 `RUNS` 条目
 * （`seen_busy=true`，`proc=null`）继续 watch，否则归位 review。
 *
 * 就绪闸（2026-10-08 批次 C，bug_report/20261008_1935）：本函数在启动序里必然早于
 * `dshevents.start()`，此刻读任何会话都是「未知」；旧口径把「未知」当「空闲」，于是**正在
 * 运行的卡**被搬去待审核。现在：有 sid 而中枢不可信（`aligned()` 为 false）⇒ **不搬列**
 * （也不建 `RUNS`），保留原列等中枢对齐后由调和器按实况归位。
 *
 * 外部直跑卡（`origin=sync`）：busy 时**不收养为平台单元**——外部会话不由平台启动，其占位与
 * 收尾归 ext 行。**async**（`appendLog` 是同步的，但调用链统一 async 形态）。
 * @returns {Promise<void>}
 */
export async function recoverWebCard(proj, card, options = {}) {
  const family = webFamily(proj);
  const sid = String(card.session_id || '').trim();
  if (sid && !eventAligned()) {
    return;                            // 未知 ≠ 空闲：不搬列，交调和器在可信后收口
  }
  let busy = false;
  if (sid) {
    try {
      busy = webBusy(family, proj.project_dir, sid);     // 插件内存态，零 ensure
    } catch (e) {
      if (e instanceof dshMod.DshDriverError) busy = false;
      else busy = false;
    }
  }
  if (!busy) {
    // 重启恢复的列回落不置「有更新」标记：这是平台自己重建视图，不是「你不在时卡片发生了什么」
    dbmod.updateBoardCard(card.id, false, { column_key: 'review' }, options);
    return;
  }
  if (String(card.origin || '') === 'sync') {
    return;                            // 外部直跑：不建 RUNS（见 docstring）
  }
  const logDir = runtimeDir(proj.work_dir, runnerMod.LOG_DIR_NAME);
  const logPath = pyJoin(logDir, `board_${card.id}_${Math.trunc(nowSec())}.log`);
  try {
    runnerMod.appendLog(logPath,
      `### 服务重启恢复：web 会话 ${sid} 仍在运行，继续监视\n`);
  } catch { /* 日志写不进去不阻断恢复（watch 只依赖 sid） */ }
  RUNS.set(card.id, {
    proc: null, sid, family,
    // 卡片级工作目录（独立 worktree 卡=其工作树路径，与 `startWeb` 记账同口径）
    project_dir: cardWorkspace(proj, card),
    started_at: nowMs(),
    seen_busy: true, aborted: false,
    turn_baseline: null, log_path: logPath,
  });
}

/** `_recover_web_card` 的 Python 名别名。 */
export const _recover_web_card = recoverWebCard;

/**
 * 服务重启恢复（Python `recover`）：对每张 doing 卡按族归位，最后重建 runner 统一队列。
 *
 * dsh 族走 `recoverWebCard`（实况 running 重建 watch 条目，否则归位 review）；退场族（原 CLI
 * 路径，保留为防御）：回收 sid、杀残留进程组、归位 review。统一队列重建：仍在运行的卡片
 * （实况重建的 `RUNS` 条目）经 `cardStarted` 重建运行态（行置 running + 证据落行）；`c:` 行按
 * v2a T1 裁决 R3 映射收口（waiting 不动；实况 busy 的 starting → markRunning；无实况
 * starting → cancelled；无实况 running/finishing → failed「服务重启中断」）；排队占位卡按
 * `updated_at,id` 顺序重新入队（行存活的卡不动）。
 *
 * **async**（`recoverWebCard`/`submitCard` 链路；Python 同步）。
 * @returns {Promise<void>}
 */
export async function recover(options = {}) {
  let rows = [];
  dbmod.withReadDb(options, (handle) => {
    rows = handle.prepare("SELECT * FROM board_cards WHERE column_key='doing'").all();
  });
  for (const r of rows) {
    if (r.block_kind === 'queue') {
      continue;   // 排队占位卡：无运行可恢复，留在开发列（统一队列重建会重新入队）
    }
    const proj = dbmod.getProject(r.project_id, options);
    if (proj !== null && proj !== undefined && webFamily(proj) !== null) {
      await recoverWebCard(proj, r, options);
      continue;
    }
    if (proj !== null && proj !== undefined) {
      // 退场族（原 CLI 路径，防御）：日志回捞 sid + 杀残留进程组
      const logDir = runtimeDir(proj.work_dir, runnerMod.LOG_DIR_NAME);
      let logs = [];
      try {
        logs = fs.readdirSync(logDir)
          .filter((f) => f.startsWith(`board_${r.id}_`) && f.endsWith('.log'))
          .map((f) => pyJoin(logDir, f));
      } catch { logs = []; }
      if (logs.length) {
        let logPath = logs[0];
        let best = -1;
        for (const p of logs) {
          try {
            const m = fs.statSync(p).mtimeMs;
            if (m > best) { best = m; logPath = p; }
          } catch { /* 读不到：跳过 */ }
        }
        let sid = '';
        try {
          const text = fs.readFileSync(logPath, 'utf8');
          const m = /"session_id":\s*"([0-9a-fA-F-]+)"/.exec(text);
          sid = m ? m[1] : '';
        } catch { sid = ''; }
        if (sid) {
          let sessions = [];
          try {
            sessions = JSON.parse(r.sessions || '[]');
          } catch { sessions = []; }
          if (!sessions.includes(sid)) sessions.push(sid);
          dbmod.updateBoardCard(r.id, true,
            { session_id: sid, sessions: pyJsonDumps(sessions) }, options);
        }
        let head = '';
        try {
          const fd = fs.openSync(logPath, 'r');
          try {
            const buf = Buffer.alloc(65536);
            const n = fs.readSync(fd, buf, 0, 65536, 0);
            head = buf.subarray(0, n).toString('utf8');
          } finally { fs.closeSync(fd); }
        } catch { head = ''; }
        // `### PID <n>` 平台进度标记（runner.PID_MARK_RE 的 Node 侧同款字面量；解析逻辑
        // 归本文件的 CLI 防御分支，不为此给 runner.js 加导出）
        const m = /### PID (\d+)/.exec(head);
        if (m) {
          try {
            killTree(Number(m[1]));
          } catch { /* 进程可能已随重启消失 */ }
        }
      }
    }
    // 同 recoverWebCard：重启恢复的列回落是平台重建视图，不置「有更新」标记
    dbmod.updateBoardCard(r.id, false, { column_key: 'review' }, options);
  }
  // 统一队列重建：运行中的卡片补回运行行；排队卡片按序重新入队
  const inst = runnerInstance();
  if (inst !== null) {
    const live = [...RUNS.keys()];
    const liveSet = new Set(live);
    // —— c: 等待项行重启映射（v2a T1 裁决 R3；先于下方 card_started 重建段定行态）——
    for (const r of rows) {
      const wrow = getActive(KIND_CARD, r.id, options);
      if (wrow === null || wrow === undefined || wrow.state === STATE_WAITING) continue;
      if (liveSet.has(r.id)) {
        if (wrow.state === STARTING) markRunning(KIND_CARD, r.id, options);
      } else if (wrow.state === STARTING) {
        waitqCancel(KIND_CARD, r.id, '服务重启中断', null, options);
      } else {
        finishByTarget(KIND_CARD, r.id, STATE_FAILED, '服务重启中断', options);
      }
    }
    // —— c: 行全表兜底扫描（v2a T1 minor 收口）：非 doing 卡的活跃 c: 行按同口径收口 ——
    const covered = new Set(rows.map((r) => r.id));
    for (const wrow of activeItems(null, options)) {
      if (wrow.kind !== KIND_CARD || wrow.state === STATE_WAITING) continue;
      const wcid = pyIntLoose(wrow.target_id);
      if (wcid !== null && covered.has(wcid)) continue;
      if (wrow.state === STARTING) {
        waitqCancel(KIND_CARD, wrow.target_id, '服务重启中断', null, options);
      } else {
        finishByTarget(KIND_CARD, wrow.target_id, STATE_FAILED, '服务重启中断', options);
      }
    }
    for (const cid of live) {
      const c = dbmod.getBoardCard(cid, options);
      if (c === null || c === undefined) continue;
      if (String(cardOpt(c, 'worktree') || '').trim()) {
        // 独立 worktree 卡：起跑即**不落队列行**，这里不能补建——card_started→enter_running
        // 会「行缺失则建行」，重启后凭空多出一条占项目运行位的 c: 行，等于把免排队的卡重新
        // 塞回队列。运行事实由 `recoverWebCard` 重建的 RUNS 条目承担，收尾照常走 `finishRun`。
        continue;
      }
      const ext = { reason: 'recover 重建' };
      const rec = RUNS.get(cid);
      if (rec !== undefined && rec !== null && rec.proc !== null && rec.proc !== undefined) {
        ext.pid = rec.proc.pid;
      }
      inst.cardStarted(cid, c.project_id, ext, options);
    }
    const queued = dbmod.listQueuedBoardCards(options);
    // 重建入队前刷新外部条目（ext 行重启映射）：先于 submitCard 的 notify——否则重启后首个
    // 调和 tick 前外部会话在跑也会被立即拾起，竞态窗口照旧。
    if (recoverExtRows(queued, options) && inst !== null) {
      inst.notifyBusyChange(options);
    }
    for (const c of queued) {
      if (getActive(KIND_CARD, c.id, options) === null) {
        // P4 对账：waiting 行存活的卡不动（位次以表 seq 为准）；仅行缺失才补建
        inst.submitCard(c.id, '', '', false, options);
      }
    }
  }
}

/** `recover` 的 Python 名别名。 */
export const _recover = recover;

// ---------- Jira 导入（board.py:3136-3190；服务端代理，避免浏览器 CORS） ----------

/** Jira 请求超时（秒；Python `JIRA_TIMEOUT`） */
export const JIRA_TIMEOUT = 10;

/**
 * Jira GET（Basic Auth）（Python `_jira_get`）。返回 `[status, jsonOrText]`；网络异常返回
 * `[0, 错误串]`。**async**（`fetch`）。
 * @returns {Promise<[number, unknown]>}
 */
export async function jiraGet(cfg, jiraPath, { fetchImpl = fetch } = {}) {
  const url = String(cfg.url || '').replace(/\/+$/, '') + jiraPath;
  const token = Buffer.from(`${cfg.user}:${cfg.token}`, 'utf8').toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JIRA_TIMEOUT * 1000);
  try {
    const resp = await fetchImpl(url, { headers: {
      Authorization: `Basic ${token}`, Accept: 'application/json' },
      signal: controller.signal });
    const raw = await resp.text();
    if (resp.status >= 400) return [resp.status, String(raw).slice(0, 500)];
    try {
      return [resp.status, JSON.parse(raw)];
    } catch (e) {
      return [0, errText(e)];
    }
  } catch (e) {
    return [0, errText(e)];
  } finally {
    clearTimeout(timer);
  }
}

/** `_jira_get` 的 Python 名别名。 */
export const _jira_get = jiraGet;

/**
 * 测试连接（Python `jira_myself`）：GET `/rest/api/3/myself`。返回 `{ok, name|error}`。**async**。
 * @returns {Promise<object>}
 */
export async function jiraMyself(cfg, opts = {}) {
  if (!(cfg.url && cfg.user && cfg.token)) {
    return { ok: false, error: '请填全 Jira 地址 / 用户名 / token' };
  }
  const [status, data] = await jiraGet(cfg, '/rest/api/3/myself', opts);
  if (status === 200 && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return { ok: true, name: data.displayName || data.name || '' };
  }
  return { ok: false, error: `HTTP ${status}: `
    + `${typeof data === 'string' ? data : pyJsonDumps(data).slice(0, 200)}` };
}

/** `jira_myself` 的 Python 名别名。 */
export const _jira_myself = jiraMyself;

/**
 * 导入当前用户未解决的 Jira 工单为看板卡片（Python `jira_import`；`jira_key` 去重，最多 50 条）。
 * **async**（Jira HTTP）。
 * @returns {Promise<object>} `{ok, added, skipped}` 或 `{ok:false, error}`
 */
export async function jiraImport(projectId, options = {}, opts = {}) {
  const cfg = settingsOf(projectId, options).jira || {};
  if (!(cfg.url && cfg.user && cfg.token)) {
    return { ok: false, error: '请先在设置中配置 Jira' };
  }
  const jql = encodeURIComponent(
    'assignee=currentUser() AND resolution=Unresolved ORDER BY updated DESC')
    .replace(/%20/g, '+');
  const [status, data] = await jiraGet(cfg,
    `/rest/api/3/search?jql=${jql}&maxResults=50`, opts);
  if (status !== 200 || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: `HTTP ${status}: ${String(data).slice(0, 200)}` };
  }
  const existing = new Set(dbmod.listBoardCards(projectId, options)
    .map((r) => r.jira_key).filter(Boolean));
  let added = 0;
  let skipped = 0;
  for (const issue of (data.issues || [])) {
    const key = issue.key || '';
    if (!key) continue;
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    const fields = issue.fields || {};
    const summary = String(fields.summary || key).slice(0, 200);
    const desc = `Jira: ${String(cfg.url).replace(/\/+$/, '')}/browse/${key}`;
    dbmod.insertBoardCard(projectId, `[${key}] ${summary}`, desc, key, options);
    added += 1;
  }
  return { ok: true, added, skipped };
}

/** `jira_import` 的 Python 名别名。 */
export const _jira_import = jiraImport;

// ══════════════════════════════════════════════════════════════════════════
// 接线（M5-2 起，**M5-3 补齐**）：钩子注入 + chat 投递桥
//
// 顺序是契约：`setBoardHooks` 必须在所有被注入的函数**定义之后**执行（函数声明会提升，但
// 注入是求值期副作用）。M5-3 起 `archiveCardSessions` 落地并注入——**缝从此不再响亮失败**，
// 未注入只可能来自「有人手工 `setBoardHooks({archiveCardSessions: null})`」（测试桩）。
//
// `feishuCardReview` / `feishuCardBlocked` 由 `server.js` 启动序注入（M7.5-R3 接线；D1 拆名：
// review 路径 3 位 / blocked 路径 4 位）。未注入时走 `optionalHook` 按
// 「该分支不存在」跳过（Python 侧该调用点也只打一行诊断，推送异常从不影响调和）。
//
// ⚠ **形参表本身是契约**（§五之三冻结）：每个钩子的逐位形参写在 `setBoardHooks` 的 JSDoc 里，
// 调用点与实现点任一侧改动都要同步另一侧并在两边各留一行「为什么是这个形态」的注释。
// ══════════════════════════════════════════════════════════════════════════

setBoardHooks({
  enterDoing,          // `_enter_doing`（board.py:1040）——M5-2；7 位：(project, card, extra, force, worktree, queueWorktree, options)
  stopCard,            // `stop_card`（board.py:2191）——M5-2；2 位：(cardId, options)
  finish,              // `finish`（board.py:2411）——M5-2（**同步**，见其 docstring）
  archiveCardSessions, // `_archive_card_sessions`（board.py:3314）——M5-3；4 位：(card, archived, reason, {strict, options})
  syncSessions,        // `sync_sessions`（board.py:3639）——M5-3；2 位：(project, options)
  iwClear,             // `_iw_clear`（board.py:5029）——M5-3；1 位：(sid)
  ensureWatch,         // `_ensure_watch`（board.py:4048）——M5-3；2 位：(sid, force)
  watchBeforeDelivery, // `_watch_before_delivery`（board.py:4230）——M5-3；1 位：(sid)
  // `sessparse.is_subagent(family, sid)` 是 2 位，而钩子契约是 1 位 `(sid)`（调用方
  // `subagentSession` 手上只有 sid）：族单族化后恒为 dsh，故在此**固定 family='dsh'**
  // （与 `syncSessions` 的「归族 → 解析族」口径同源），不把族参数泄进钩子形态。
  isSubagent: (sid) => sessparseMod.is_subagent('dsh', sid),
});

/**
 * chat 投递桥：`_deliver_unit` / `_deliver_now` / `_ensure_watch` 三个口接线。
 *
 * `ensureWatch` 是 **2026-10-22 补接**（修 #1003）：M5-3 落地了 `_ensure_watch` 本体、也经
 * `setBoardHooks` 注入了看板内部调用点，却漏挂到 chat 的投递桥 ⇒ `chat.externalPreflight`
 * 第⑤步永远拿不到「看管声明」口，所有 `owned:false` 会话（dsh GUI 直跑 / `origin='sync'` 卡）
 * 从 TS 会话窗发送恒被拒，文案却写「看管声明失败：插件过旧或不可达」——**一次 `/watch` 都没
 * 发**，与插件新旧无关（实测卡 1003 连发 6 条「继续」全部 400）。现在三个口全接上，未注册
 * 只剩测试桩一种可能；声明失败仍由 `ensureWatch` 返回 false 响亮失败（不静默投递）。
 *
 * 注意 `ensureWatch` 是 **async**（内部打驱动 `POST /watch`）：`chat.externalPreflight` 已
 * 按 `await` 结果判定，绝不能再退回同步 `!ensureWatch(sid)`（Promise 恒真值会误放行）。
 */
chatMod.setBoardBridge({
  ensureWatch,       // `_ensure_watch`（board.py:4048）——M5-3 本体，2026-10-22 补接线（#1003）
  deliverUnit,       // `_deliver_unit`（board.py:2080）——M5-2
  deliverNow,        // `_deliver_now`（board.py:2136）——M5-2
});
