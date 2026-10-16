/**
 * `server.py` 顶层「会话/队列派生」helper 的 Node 对应物（M3 读路径 · 会话族）。
 *
 * 归属函数（Python 源在括号里）：
 *   - `projectBusy`           （`_project_busy`:319）
 *   - `unitState`             （`_unit_state`:336，含 `c:` → `a:` 改键规则）
 *   - `boardSessionRunning`   （`_board_session_running`:368）
 *   - `sessionQueueState`     （`_session_queue_state`:428，八枚举判定序）
 *   - `boardOwnsSid`          （`_board_owns_sid`:2765）
 *   - `boardOwned`            （`_board_owned`:2748 的只读版）
 *   - `taskSince`             （`_task_since`:4747）
 *   - `interactionOfSid`      （`board.interaction_of_sid`:4688 的 M3 空实例口径）
 *
 * 命名口径：**函数 camelCase、返回字段沿用 Python 的 snake_case**（字段直接进 JSON
 * 响应，改名就是改契约）。`{state,pos,total}` / `{pending,kind,…}` 这类形状逐字同 Python。
 *
 * ## M3 的两条边界（方案 §四，逐条在这里落地并注明）
 * ① `board.runningMap()` / `chat.state` 的进程内登记表在 M3 恒空 ⇒ `boardSessionRunning`
 *    的「平台在管」分支恒 false（与「刚起的 Python 实例」等价），实况 busy 分支照常走
 *    `dshevents`；真驱动下的非空分支由 M4/M5 接线后自然生效。
 * ② `board.interaction_of_sid` 读调和器缓存 `_IW_CACHE`（属 M5）⇒ 本文件按**空缓存**
 *    返回 `null`（`interaction: null` 仍在 payload 里，键集合与 Python 一致）。
 *
 * 数据层调用口径：M3 约定「自由函数 + 末位可选 `{db, dbPath, env}`」，本文件一律把
 * `options` 原样透传给 `runner`/`board`/`db` 的读口（路由层传 `{db: ctx.db}`）。
 */
import * as board from './board.js';
import * as dbmod from './db.js';
import * as runner from './runner.js';

/** Python `int(s)` 的**严格**形态（`s` 是数字串才给值，其余 null） */
function pyIntOrNull(text) {
  return /^[+-]?\d+$/.test(String(text)) ? Number.parseInt(text, 10) : null;
}

/**
 * `_project_busy(project_id)`：项目是否已有单元在跑（统一队列视角）。
 *
 * Python 在 `runner.INSTANCE is None`（单测/独立脚本）或异常时按 False；Node 侧
 * `runner.unitBusy` 是自由函数（总是可读 wait_items），**没有「实例缺位」这一态**，
 * 但对假值 projectId 与异常同样返回 False（调用方不因展示字段失败）。
 *
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function projectBusy(projectId, options = {}) {
  if (!projectId) return false;
  try {
    return Boolean(runner.unitBusy(projectId, options));
  } catch (error) {
    console.error(`[serverstate] projectBusy 降级为 false：${(error && error.message) || error}`);
    return false;
  }
}

/**
 * `_unit_state(project_id, key)`：单元在统一队列中的态（会话窗「队列」徽标）。
 *
 * 任务会话传 `t:<task_id>`、看板卡片会话传 `c:<card_id>`；
 * **已作答·待送达的卡片改按 `a:<cid>` 键求值**（P6 解冻：answer 等待项才有真实
 * 位次；形状 `{state,pos,total}` 不变）。runner 异常 → `null`（前端按「未下发」不渲染）。
 *
 * 注意改键判定的位置与 Python 一致：`board.isAnswerPending` 的调用**不在** try 内
 * （它自己有兜底），try 只包 `inst.unit_state`（Node：`runner.unitState`）。
 *
 * @param {number} projectId
 * @param {string} key `t:<id>` / `c:<id>` / `a:<id>` / `m:<id>`
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{state:string,pos:number,total:number}|null}
 */
export function unitState(projectId, key, options = {}) {
  if (!projectId) return null;
  let resolved = String(key === null || key === undefined ? '' : key);
  if (resolved.startsWith('c:')) {
    const cid = pyIntOrNull(resolved.slice(2));
    if (cid !== null && board.isAnswerPending(cid, options)) resolved = `a:${cid}`;
  }
  try {
    return runner.unitState(resolved, projectId, options);
  } catch (error) {
    console.error(`[serverstate] unitState 降级为 null：${(error && error.message) || error}`);
    return null;
  }
}

/**
 * `_board_session_running(owner_cid, proj, sid)`：看板会话运行态（meta.running）。
 *
 * 判定序与 Python 逐点同：无卡 → false；**已作答·待送达 → false**（平台已收下答案、
 * 等空闲送达；会话实况仍 busy 但不算运行）；平台在管（`board.runningMap()`）→ true；
 * 否则会话实况 busy（含用户在 dsh 侧直跑的外部会话）。
 *
 * @param {number} ownerCid
 * @param {object} proj 项目行
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function boardSessionRunning(ownerCid, proj, sid, options = {}) {
  if (!ownerCid) return false;
  if (board.isAnswerPending(ownerCid, options)) return false;
  // `board.runningMap()` 是 **plain object**（Python dict 的对应物，M3 恒空），不是 Map
  const running = board.runningMap();
  const key = String(ownerCid);
  if (Object.prototype.hasOwnProperty.call(running, key) && running[key]) return true;
  return board.webSessionBusy(proj, sid);
}

/**
 * `_session_queue_state(...)`：session meta 的 `queue_state` 派生（八枚举，枚举值见
 * `board.QS_*`）。
 *
 * 判定序（高→低）：`answer_pending` > `server_queued` > `interaction_pending` >
 * `running` > `starting` > `queued_serial`/`foreign_busy` > `idle`。
 * 三个「pending」仅看板卡片会话在场（任务会话恒 false）；`unit_state=running` 同样判
 * running（**行口径**：本单元有运行中行）；`queued` 分叉按项目是否有活跃 `ext:` 行
 * （外部会话在跑）分 `foreign_busy`/`queued_serial`。
 *
 * @param {number} projectId
 * @param {{state:string,pos:number,total:number}|null|undefined} unitStateValue
 * @param {{running?:boolean, answerPending?:boolean, serverQueued?:boolean,
 *          starting?:boolean, interactionPending?:boolean}} [flags]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string} `board.QS_*`
 */
export function sessionQueueState(projectId, unitStateValue, flags = {}, options = {}) {
  const {
    running = false, answerPending = false, serverQueued = false,
    starting = false, interactionPending = false,
  } = flags;
  if (answerPending) return board.QS_ANSWER;
  if (serverQueued) return board.QS_SERVER;
  if (interactionPending) return board.QS_INTERACTION;
  const st = (unitStateValue || {}).state;
  if (running) return board.QS_RUNNING;
  if (starting) return board.QS_STARTING;
  if (st === 'running') return board.QS_RUNNING;
  if (st === 'queued') {
    if (projectId && board.extActive(projectId, options)) return board.QS_FOREIGN;
    return board.QS_QUEUED;
  }
  return board.QS_IDLE;
}

/** `sessions` 列（JSON 数组文本）→ 字符串数组；坏 JSON 按空数组（Python 会抛，见文件头） */
function cardSessions(row) {
  try {
    const parsed = JSON.parse(row.sessions || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `_board_owns_sid(row, sid)`：sid 是否归属本项目卡片的会话并集
 * （每卡 `sessions ∪ {session_id}`）。返回**归属卡片行**（调用方可读
 * `id`/`column_key`/`worktree`/`block_kind` 等）；不归属返回 `null`
 * ——会话端点据此 404，防经会话端点读任意会话（跨项目读的红线）。
 *
 * @param {object} projectRow
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object|null}
 */
export function boardOwnsSid(projectRow, sid, options = {}) {
  if (!projectRow || !sid) return null;
  for (const c of dbmod.listBoardCards(projectRow.id, options)) {
    if (cardSessions(c).includes(sid)) return c;
    if (c.session_id && sid === c.session_id) return c;
  }
  return null;
}

/**
 * `_board_owned(project_id, card_id)` 的**只读版**：项目 + 卡片联合归属校验。
 *
 * 与 Python 的差异：Python 直接 `self._respond(404, …)`（有副作用），本函数只返回行，
 * 由调用方决定回哪条 404——路由层已有 `ctx.ownedProject`（会回 `project not found`），
 * 卡片缺失时调用方回 `card not found`，状态码/正文与 Python 一致。
 *
 * @param {number} projectId
 * @param {number|null} [cardId] 不传＝只校验项目
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{project: object|null, card: object|null}}
 */
export function boardOwned(projectId, cardId = null, options = {}) {
  const project = dbmod.getProject(projectId, options);
  if (project === null || project === undefined) return { project: null, card: null };
  if (cardId === null || cardId === undefined) return { project, card: null };
  const card = dbmod.getBoardCard(cardId, options);
  if (card === null || card === undefined || card.project_id !== project.id) {
    return { project, card: null };
  }
  return { project, card };
}

/**
 * `board.interaction_of_sid(sid)` 的 M3 口径：调和器缓存 `_IW_CACHE` 属 M5 ⇒ **恒 null**
 * （＝「刚起的 Python 实例」）。
 *
 * 为什么仍然发这个键：Python payload 里 `interaction` 一定在场（值可能是 null），
 * 少发键会被对拍器按「键集合差异」抓到，也会让前端多一处 `undefined` 分支。
 */
export function interactionOfSid(sid) {
  return sid ? null : null;   // 保留 sid 形参只为与 Python 同名同签名
}

/**
 * `_task_since(task)`：任务起始时间（epoch **秒**，本地时区，运行中会话探测的时间下界）。
 * `started_at` 优先，回退 `created_at`；格式异常返回 `0`（探测据此直接放弃）。
 *
 * 与 Python `time.mktime(time.strptime(val, "%Y-%m-%d %H:%M:%S"))` 同口径：按**本地时区**
 * 解释（两侧跑在同一台机器、同一 TZ）。
 *
 * @param {object} task 任务行
 * @returns {number}
 */
export function taskSince(task) {
  for (const key of ['started_at', 'created_at']) {
    const val = task ? task[key] : '';
    const ms = parseLocalSeconds(val);
    if (ms !== null) return ms;
  }
  return 0.0;
}

/** `%Y-%m-%d %H:%M:%S`（允许 1-2 位月/日/时分秒与两端空白）→ 本地时区 epoch 秒；不符 → null */
function parseLocalSeconds(val) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})\s*$/.exec(String(val ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s, 0);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms / 1000;
}
