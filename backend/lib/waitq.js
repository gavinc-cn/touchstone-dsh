/**
 * 统一等待项核心（`waitq.py` 1342 行的 Node 对应物）——**读口 + 写口全量**。
 *
 * M3 搬读口（成员键 / 读口 / 位次 / 消息读口）；**M4 补写口**：入队与分数序插入（前缀后
 * / 消息落点 / 拖拽改序）、认领与起跑证实（`claim` / `markRunning` / `enterRunning`）、
 * 状态机迁移（`markFinishing` / 终态 / 放回 / 取消）、行证据与心跳（`touchUnit` /
 * `markEvidence` / `evidencePid`）、对账与自检（`selfcheck` / `reconcileUnits` /
 * `selfcheckUnits` / `pruneFinished`）、卡片四操作（`enqueueCard` /
 * `insertCardAfterPrefix` / `insertCardForceStart` / `cancelCardWait` /
 * `setCardWaitPlaceholder`）、外部条目（`insertExt`）与消息六态迁移（`msgEnqueue` /
 * `msgClaim` / `msgRequeue` / `msgFinish` / `msgCancel` / `msgRecoverFail` / `msgPrune`）。
 * 函数排布**照 `waitq.py` 原始顺序**：SQL 文本逐字照抄、判据逐条对齐、rowcount 守卫与
 * 返回类型（行 id / `[row_id, seq]` / 行对象 / bool / list）逐点一致。
 *
 * 排队模型的权威表述在 `doc_ai/spec/queue/排队与占用.md` 与 `waitq.py` 模块头（行即条目、
 * 两表唯一写路径、v3 各批裁决 R1/R3/R4/R6/R7/R11/R13/R14 等）。
 *
 * ── 与 Python 的形态差异（唯一必要的差异，语义等价） ─────────────────────────────
 *   ① **连接取自 `options`**：Python `db.connect()` 是「每调用一条短连接」；Node 侧统一为
 *      `fn(业务参数…, {db?|dbPath?|env?})`——读口走 `withReadDb`、写口走 `withWriteDb`
 *      （事务边界见 ⑤）。传 `options.db`（已打开句柄）则复用且不关，缺省自开短连接并
 *      close（口径与 `db.js:withReadDb` 逐点同）。`memberKey` / `evidencePid` 这类不碰
 *      DB 的纯函数不收 `options`（与 Python 同形：它们只吃入参）。
 *   ② **行对象是普通对象**（`node:sqlite` 的 null 原型行已在这里摊平成普通对象）：
 *      `row.state` 与 `row['state']` 等价，字段名保持 snake_case（跨语言契约）。
 *   ③ **`int(...)` 的 ValueError 分支**：Python `answer_pending_card_ids()` 用
 *      `int(r[0])`，target_id 非数字会**抛 ValueError**（不是跳过）。Node 侧
 *      `Number.parseInt('abc', 10)` 给 NaN，**不抛**；故显式补一个 NaN 判据跳过该行。
 *      这是有意的宽松化：本函数只服务展示派生（N+1 消除），一行坏数据不该让整块看板
 *      500；Python 侧真撞上会 500 且同样不可能给出正确答案。见 `answerPendingCardIds`。
 *   ④ SQL 里的活跃态 IN 片段由 `ACTIVE_STATES` 单点生成（`_ACTIVE_IN`），与 Python
 *      同源同形——改状态机时两版一起改。
 *   ⑤ **事务边界**：Python `with db.connect() as conn:`（短连接 + 成功 commit / 异常
 *      rollback）→ Node `withWriteDb(options, fn)`（缺省自开短连接并包 `BEGIN`…`COMMIT`，
 *      异常 `ROLLBACK` + 重抛；给 `{db}` 则**复用且不开事务**，边界归调用方）。块内复用
 *      连接的助手一律 `xxxOn(handle, …)`；**严禁嵌套 `withWriteDb`**。差异只在加锁时刻：
 *      Python 的隐式事务在首条 DML 才 BEGIN，Node 在块首就 BEGIN（DEFERRED，纯 SELECT
 *      只取 SHARED）——进程内单事件循环 + 同库单实例锁之下两者等价，见
 *      `db.js:withWriteDb` 的长注释。
 *   ⑥ **rowcount 守卫**：Python `cur.rowcount == 1` → Node `Number(info.changes) === 1`
 *      （`node:sqlite` 的 `run()` 返回 `{changes, lastInsertRowid}`）。
 *   ⑦ **IntegrityError 分支**：Python `except sqlite3.IntegrityError` 是**整个约束族**
 *      （唯一索引 2067 / NOT NULL 1299 都算）→ Node 判 `err.code === 'ERR_SQLITE_ERROR'`
 *      且 `(err.errcode & 0xff) === 19`（`SQLITE_CONSTRAINT`=19）。重查兜底不存在时
 *      **重抛原错**（照 Python 的裸 `raise`）。
 *   ⑧ **异常面**：Python `raise ValueError` → Node `TypeError`（未知等待项 kind，消息含
 *      「未知等待项」）/ `RangeError`（`reposition` 缺邻行、区间倒置）。JS 没有
 *      `ValueError`；对拍器（`tools/parity/waitq-run.mjs:errorToken`）把两者都归
 *      `value_error` 桶。
 *   ⑨ **JSON**：写侧一律 `pyJsonDumps`（= `json.dumps(..., ensure_ascii=False)` 逐字节、
 *      键序=插入序；`db.js` 既有设施）。读侧（meta/evidence 合入前的解析）用 `JSON.parse`
 *     并在失败时降级成 `{}`——`db.js` 的 `pyJsonLoads` **未导出**，故此处与 Python 有一
 *      处已知差异：`NaN`/`Infinity` 字面量在 Python `json.loads` 合法、Node 侧按坏 JSON
 *      降级。平台自身只往这两列写字符串/整数（`pyJsonDumps` 仅对非有限浮点吐这两种
 *      字面量），该形态在本模块的 meta/evidence 上不可达；真出现时对拍会现形。
 *  ⑩ **Unicode 面**：Python `target.isdigit()` 认全角数字且 `int()` 能解析，Node 侧只认
 *      ASCII `^[0-9]+$`（其余按「引用不可解析」处理）；Python `str(None)` 给 `'None'` 而
 *      JS `String(null)` 给 `'null'`。两者都只影响平台写不出的形态（target_id 一律由
 *      `str(int)` / 平台 id 拼写），本文件统一 `String(...)` + ASCII 数字，写成有意差异。
 *  ⑪ **心跳 / 毫秒戳**：Python `time.time()` → `Date.now() / 1000`（epoch 秒浮点）；
 *      Python `int(time.time() * 1000)` → `Date.now()`（整数毫秒）。
 *  ⑫ **按码点截断**：Python `error[:300]` 按字符（码点）截断 → Node 用
 *      `Array.from(str).slice(0, 300).join('')`；`.slice(0, 300)` 按 UTF-16 码元会把 emoji
 *      劈成半个代理对（`msgFinish` 的 300 字上限，见 `truncateChars`）。
 *  ⑬ **日志**：Python `print(..., flush=True)` → Node `console.log`（同 stdout 一行）。
 *  ⑭ **常量导出**：卡片排队占位文案 `_CARD_QUEUE_TEXT` → 导出 `CARD_QUEUE_TEXT`（M5 的
 *      board 写路径与单测要逐字比对这条中文串；Python 侧带下划线但同样被测试引用）。
 *  ⑮ **参数形态**：写口一律**按 `waitq.py` 的位置顺序平铺**，末位再加 `options`（对拍器
 *      按位置传参，对象袋会错位）。`msgRows` 的对象袋是 M3 既有读口形态，未动。
 *  ⑯ **`position` 的返回形态**：M3 读口返回 `{pos, total}`，Python 是元组 `(pos, total)`
 *      ——对拍器把元组摊成 `[pos, total]`，故该 op 会现一条**已声明的形态差异**（读口按
 *      M3 契约不动，M4 未改）。
 *
 * 零 npm 依赖：只用 `node:` 内建模块 + 本仓库内模块（`db.js` 的连接契约、`pyjson.js`、
 * `proc.js:pidAlive`）。
 */

import { getBoardCard, getTask, nowStr, withReadDb, withWriteDb } from './db.js';
import { pidAlive } from './proc.js';
import { pyJsonDumps } from './pyjson.js';

// --------------------------------------------------------------------------
// 常量（逐条对齐 waitq.py:37-67；**改这里必须同时改 waitq.py**）
// --------------------------------------------------------------------------

/** 等待项五类 kind（v2d T4 加 ext：外部直跑会话，不由平台启动） */
export const KIND_TASK = 'task';
export const KIND_CARD = 'card';
export const KIND_MSG = 'msg';
export const KIND_ANSWER = 'answer';
export const KIND_EXT = 'ext';
export const KINDS = Object.freeze([KIND_TASK, KIND_CARD, KIND_MSG, KIND_ANSWER, KIND_EXT]);

/**
 * 状态机七枚举（v2a T1，裁决 R3）：claimed 被 starting 吸收。
 * 注意 `STATE_*` 是**别名**（存量引用面），不是第二套取值——与 Python 同（waitq.py:55-57）。
 */
export const WAITING = 'waiting';
export const STARTING = 'starting';
export const RUNNING = 'running';
export const FINISHING = 'finishing';
export const DONE = 'done';
export const FAILED = 'failed';
export const CANCELLED = 'cancelled';

/** 别名（照 waitq.py:55-57；`claimed` 无别名——唯一引用点已切到 STATE_STARTING） */
export const STATE_WAITING = WAITING;
export const STATE_STARTING = STARTING;
export const STATE_RUNNING = RUNNING;
export const STATE_FINISHING = FINISHING;
export const STATE_DONE = DONE;
export const STATE_FAILED = FAILED;
export const STATE_CANCELLED = CANCELLED;

/** 活跃态（活跃唯一索引 / active_items 扫描口径） */
export const ACTIVE_STATES = Object.freeze([WAITING, STARTING, RUNNING, FINISHING]);
/** 调度口径运行前缀（位次口径另含 FINISHING，见裁决 R7） */
export const PREFIX_STATES = Object.freeze([STARTING, RUNNING]);

/**
 * 成员键前缀（行即成员；v3a 起前缀/位次/窗口的键空间）。拾取侧 `runner._KEY_PREFIX`
 * 有意不含 ext——外部条目永不被平台拾取；本表含 ext 行（外部条目入场即 running，
 * 是运行前缀的正式成员）。
 */
const MEMBER_PREFIX = Object.freeze({
  [KIND_TASK]: 't', [KIND_CARD]: 'c', [KIND_MSG]: 'm',
  [KIND_ANSWER]: 'a', [KIND_EXT]: 'ext',
});

/** SQL IN 片段（唯一出处，照 waitq.py:59 的 `_ACTIVE_IN`） */
const ACTIVE_IN = ACTIVE_STATES.map((s) => `'${s}'`).join(',');

/**
 * `return_to_waiting` 可放回态 = 活跃非 waiting（照 waitq.py:61 的 `_RETURNABLE_IN`；
 * starting/running/finishing 三态同型放回）。
 */
const RETURNABLE_IN = ACTIVE_STATES.filter((s) => s !== WAITING)
  .map((s) => `'${s}'`).join(',');

// --------------------------------------------------------------------------
// M4 写路径常量（逐条对齐 waitq.py:240-241、704、947、971；**改这里必须同时改 waitq.py**）
// --------------------------------------------------------------------------

/**
 * 分数序插入的前缀态 SQL IN 片段（照 waitq.py:241 的 `_PREFIX_IN`）。
 *
 * seq 为 REAL 分数序（SQLite INTEGER 亲和列原样存小数，无需 DDL 迁移）：落尾仍
 * `MAX(seq)+1`（现行语义不变），中间插入取相邻中点；间隙 < 阈值先对项目区间行等距重排
 * （仅 UPDATE seq，行 id 稳定——沿用 P3 inject 裁决 R4 口径）。
 */
const PREFIX_IN = PREFIX_STATES.map((s) => `'${s}'`).join(',');

/** 间隙阈值：低于此值先对区间行等距重排（仅 UPDATE seq）再插入（waitq.py:240） */
const SEQ_REBALANCE_EPS = 1e-9;

/**
 * 活跃态超龄阈值（秒）：超过且无可证明证据 = 可疑泄漏（waitq.py:704）。
 * v2d T3 起判据覆盖 starting/running/finishing 三态。
 */
export const CLAIM_STALE_S = 1800;

/** `wait_items` 终态行回收默认保留窗（秒；R14 口径保守，waitq.py:947） */
export const PRUNE_FINISHED_KEEP_S = 86400;

/**
 * 卡片排队占位文案（照 waitq.py:971 的 `_CARD_QUEUE_TEXT`，与 `board._enter_doing`
 * 原文案逐字一致）。前端与对拍都比字节，**一个字符都不许改**。
 */
export const CARD_QUEUE_TEXT = '排队等待：统一队列';

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/**
 * `node:sqlite` 行（null 原型）→ 普通对象；未命中（undefined）归一为 null，
 * 与 Python `fetchone() is None` 同判据（口径同 `db.js:plainRow`）。
 * @param {object|undefined} row
 * @returns {object|null}
 */
function plainRow(row) {
  return row === undefined ? null : { ...row };
}

/**
 * 同上，批量。
 * @param {object[]} rows
 * @returns {object[]}
 */
function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

/**
 * 参数绑定前把 undefined 归一为 null（node:sqlite 拒绑 undefined；Python 侧等价于 None）。
 * @param {unknown} value
 * @returns {unknown}
 */
function bindable(value) {
  return value === undefined ? null : value;
}

/**
 * `sqlite3.IntegrityError` 的 Node 对应物（**整个约束族**，不只是唯一索引）。
 *
 * Python `except sqlite3.IntegrityError` 也吃 NOT NULL（1299）等约束错——`enqueue` /
 * `insert_after_prefix` / `enter_running` / `insert_ext` / 卡片入队都用同一 idiom：
 * 「撞约束 → 重查活跃行 → 有则复用、没有则裸 `raise`」。故这里的判据必须是
 * `SQLITE_CONSTRAINT`（主码 19）一族，而不是只认 2067。
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isIntegrityError(err) {
  return Boolean(err) && err.code === 'ERR_SQLITE_ERROR' && (Number(err.errcode) & 0xff) === 19;
}

/**
 * Python 字典/字符串/列表的**真值**判据（空 dict / 空串 / 空数组为假）。
 *
 * 用在照抄 `if meta:` / `if not patch:` 的地方：JS 里 `{}` 与 `[]` 都是 truthy，直接写
 * `if (patch)` 会让 Python 侧「空 patch 直接 no-op」的分支跑成「解析 + 重写 JSON」——
 * 列值会从坏 JSON/空串被归一成 `{}`，对拍看得见。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasEntries(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * 本地时间字符串（`YYYY-MM-DD HH:MM:SS`），照 Python `time.strftime(fmt, time.localtime(sec))`。
 *
 * 为什么不用 `nowStr()`：那个取「此刻」，而 `pruneFinished` / `selfcheck` 要的是
 * 「此刻 - N 秒」的格式化文本（同库文本时间戳口径，字符串比较即时间序）。
 *
 * @param {number} seconds epoch 秒（可带小数，`Date` 内部按毫秒截断）
 * @returns {string}
 */
function localTimeStr(seconds) {
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 本地时间字符串 → epoch 秒（照 Python `time.mktime(time.strptime(ts, fmt))`）。
 *
 * 只服务 `unitAge` 的回落分支，调用方把**任何**失败（类型不对/格式不符/NaN）当
 * 「解析失败」处理——与 Python 的 `except (ValueError, TypeError, OverflowError)` 同侧。
 * 月/日/时/分/秒放宽到 1-2 位（Python `%m` 同样接受非补零写法），其余按 `strptime` 的
 * 严格面（整串必须匹配、不许有尾巴）。
 *
 * @param {unknown} text
 * @returns {number} epoch 秒
 * @throws {TypeError|RangeError} 非字符串 / 格式不符
 */
function parseLocalSeconds(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`时间戳必须是字符串（收到 ${text === null ? 'null' : typeof text}）`);
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(text);
  if (m === null) throw new RangeError(`时间戳格式不符: ${text}`);
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`时间戳不可解析: ${text}`);
  return ms / 1000;
}

/**
 * 按**码点**截断（照 Python 字符串切片 `s[:n]`）。
 *
 * `.slice(0, n)` 按 UTF-16 码元切，会把 emoji 之类的代理对劈成半个（写库即成坏 UTF-8
 * 形态的孤立代理）；`Array.from` 按码点迭代，与 CPython 的 str 语义一致。
 *
 * @param {unknown} text
 * @param {number} n
 * @returns {string}
 */
function truncateChars(text, n) {
  return Array.from(String(text === null || text === undefined ? '' : text)).slice(0, n).join('');
}

/**
 * ASCII 数字串 → 整数（照 Python `target.isdigit()` + `int(target)` 的可用面）；
 * 非纯 ASCII 数字返回 null（= 引用不可解析，见文件头差异⑩）。
 * @param {unknown} target
 * @returns {number|null}
 */
function targetInt(target) {
  return typeof target === 'string' && /^[0-9]+$/.test(target) ? Number(target) : null;
}

// --------------------------------------------------------------------------
// 成员键与读口（waitq.py:70-232）
// --------------------------------------------------------------------------

/**
 * 等待项行 → 成员键（`t:`/`c:`/`m:`/`a:`/`ext:` + target_id）。
 *
 * 前缀/位次/窗口的唯一键空间（行即成员，唯一来源 R1；v3d 起无第二来源）。
 * 未知 kind 回落 `kind:target`（照 Python `_MEMBER_PREFIX.get(kind, kind)`）。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @returns {string}
 */
export function memberKey(kind, targetId) {
  const prefix = MEMBER_PREFIX[kind] !== undefined ? MEMBER_PREFIX[kind] : kind;
  return `${prefix}:${targetId}`;
}

// --------------------------------------------------------------------------
// 写口 · meta 合入与入队（waitq.py:78-117）
// --------------------------------------------------------------------------

/**
 * 行内 meta JSON 合入 patch（持连接调用；坏 JSON / 非对象按空对象处理）。
 *
 * 键序照 `dict.update`：既有键留在原位，新键按 patch 的顺序追加（`pyJsonDumps` 保插入序）。
 *
 * @param {object} handle 写连接（调用方持事务边界）
 * @param {object} row `{id, meta}`（`getItemOn` / 显式 SELECT 的行）
 * @param {object} patch 要合入的键值对
 */
function mergeMetaOn(handle, row, patch) {
  let cur;
  try {
    cur = JSON.parse(row.meta || '{}');
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  } catch {
    cur = {};
  }
  Object.assign(cur, patch);
  handle.prepare('UPDATE wait_items SET meta=? WHERE id=?')
    .run(pyJsonDumps(cur), bindable(row.id));
}

/**
 * 入队等待项（幂等：同类同目标已有活跃行 → 返回既有行 id）。
 *
 * 并发安全（照 Python）：INSERT 优先、活跃唯一索引兜底；撞唯一索引说明并发下已有活跃行，
 * 重查并复用其 id（避免 check-then-insert 竞态抛 IntegrityError 被静默吞掉）。非活跃
 * 唯一索引冲突（重查不到活跃行）**上抛原错**，交给调用方。
 *
 * @param {string} kind 五 kind 之一（未知抛 `TypeError`，照 Python `ValueError`）
 * @param {string|number} targetId 目标 id（一律 `String(...)` 落 TEXT 列）
 * @param {number} projectId
 * @param {object|null} [meta] 行 meta（缺省 `{}`）
 * @param {number} [notBefore] 最早可拾取时间（epoch 秒）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 写连接（见 `db.js:withWriteDb`）
 * @returns {number} 等待项 id（既有行 id 或新行 id）
 */
export function enqueue(kind, targetId, projectId, meta = null, notBefore = 0.0, options = {}) {
  if (!KINDS.includes(kind)) throw new TypeError(`未知等待项 kind: ${kind}`);
  const target = String(targetId);
  return withWriteDb(options, (handle) => {
    try {
      const info = handle.prepare(
        'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
        + ' created_at, not_before, meta)'
        + " VALUES (?,?,?,'waiting',"
        + ' (SELECT COALESCE(MAX(seq),0)+1 FROM wait_items),?,?,?)',
      ).run(bindable(projectId), kind, target, nowStr(),
        Number(notBefore || 0), pyJsonDumps(meta || {}));
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      const row = handle.prepare(
        'SELECT id FROM wait_items WHERE kind=? AND target_id=?'
        + ` AND state IN (${ACTIVE_IN})`,
      ).get(kind, target);
      if (row === undefined) throw err;     // 非活跃唯一索引冲突：上抛，交给调用方
      return row.id;
    }
  });
}

/**
 * 按 id 取等待项行（无则 null）。
 * @param {number} itemId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object|null}
 */
export function getItem(itemId, options = {}) {
  return withReadDb(options, (handle) => getItemOn(handle, itemId));
}

/** `getItem` 的持连接版本（内部复用；避免嵌套调用各开一条连接） */
function getItemOn(handle, itemId) {
  if (itemId === null || itemId === undefined) return null;
  return plainRow(handle.prepare('SELECT * FROM wait_items WHERE id=?').get(bindable(itemId)));
}

/**
 * 取同类同目标的活跃等待项行（无则 null）。`target_id` 一律按字符串比对（行里存的是
 * TEXT，Python 侧同样 `str(target_id)`）。
 * @param {string} kind
 * @param {string|number} targetId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object|null}
 */
export function getActive(kind, targetId, options = {}) {
  return withReadDb(options, (handle) => getActiveOn(handle, kind, targetId));
}

/** `getActive` 的持连接版本 */
function getActiveOn(handle, kind, targetId) {
  return plainRow(handle.prepare(
    'SELECT * FROM wait_items WHERE kind=? AND target_id=?'
    + ` AND state IN (${ACTIVE_IN})`,
  ).get(bindable(kind), bindable(String(targetId))));
}

/**
 * 活跃等待项列表（seq 升序；projectId 给定时仅该项目）。
 * @param {number|null} [projectId]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object[]}
 */
export function activeItems(projectId = null, options = {}) {
  return withReadDb(options, (handle) => activeItemsOn(handle, projectId));
}

/** `activeItems` 的持连接版本 */
function activeItemsOn(handle, projectId = null) {
  let sql = `SELECT * FROM wait_items WHERE state IN (${ACTIVE_IN})`;
  const args = [];
  if (projectId !== null && projectId !== undefined) {
    sql += ' AND project_id=?';
    args.push(projectId);
  }
  sql += ' ORDER BY seq';
  return plainRows(handle.prepare(sql).all(...args.map(bindable)));
}

/**
 * 有活跃 answer 等待项（已作答·待送达）的卡片 id 集合（P6 批量派生用；口径同为四活跃态行）。
 *
 * Python 用 `int(r[0])` ⇒ 非数字 target_id 抛 ValueError；Node 的 parseInt 给 NaN，
 * 这里显式跳过 NaN 行（见文件头差异③：只服务展示派生，一行坏数据不该打穿读板）。
 *
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {Set<number>}
 */
export function answerPendingCardIds(options = {}) {
  return withReadDb(options, (handle) => {
    const out = new Set();
    for (const row of handle.prepare(
      'SELECT DISTINCT target_id FROM wait_items'
      + ` WHERE kind=? AND state IN (${ACTIVE_IN})`,
    ).all(KIND_ANSWER)) {
      const cid = Number.parseInt(row.target_id, 10);
      if (!Number.isNaN(cid)) out.add(cid);
    }
    return out;
  });
}

/**
 * `c:` 等待项为 starting 态的卡片 id 集合（queue_state `starting` 枚举批量派生用，裁决 R6）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {Set<number>}
 */
export function startingCardIds(options = {}) {
  return withReadDb(options, (handle) => {
    const out = new Set();
    for (const row of handle.prepare(
      'SELECT DISTINCT target_id FROM wait_items WHERE kind=? AND state=\'starting\'',
    ).all(KIND_CARD)) {
      const cid = Number.parseInt(row.target_id, 10);
      if (!Number.isNaN(cid)) out.add(cid);
    }
    return out;
  });
}

/**
 * 项目是否有活跃 ext 行（外部条目读口，v2d T4 裁决 R13）。
 *
 * 注意 v3a 契约：**不得**给 `active_ext` 增加任何「第二遍历源」（Python 侧同款注释）。
 * 调度侧的项目外部条目闸不查本函数——`runner._pick_locked` 直接用本轮已取到的行集。
 *
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {boolean}
 */
export function activeExt(projectId, options = {}) {
  return withReadDb(options, (handle) => activeExtOn(handle, projectId));
}

/** `activeExt` 的持连接版本 */
function activeExtOn(handle, projectId) {
  return handle.prepare(
    'SELECT 1 FROM wait_items WHERE project_id=? AND kind=?'
    + ` AND state IN (${ACTIVE_IN}) LIMIT 1`,
  ).get(bindable(projectId), KIND_EXT) !== undefined;
}

/**
 * 活跃 ext 行列表（seq 升序；projectId 给定时仅该项目）。
 * @param {number|null} [projectId]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object[]}
 */
export function activeExtItems(projectId = null, options = {}) {
  let sql = `SELECT * FROM wait_items WHERE kind=? AND state IN (${ACTIVE_IN})`;
  const args = [KIND_EXT];
  if (projectId !== null && projectId !== undefined) {
    sql += ' AND project_id=?';
    args.push(projectId);
  }
  sql += ' ORDER BY seq';
  return withReadDb(options, (handle) => plainRows(handle.prepare(sql).all(...args.map(bindable))));
}

/**
 * 同项目 waiting 等待项位次 `(pos, total)`（1 基；非 waiting 返回 `(0, 0)`）。
 *
 * v2a T4 归一（裁决 R7，位次含运行前缀）：
 *   pos = 前缀成员数 + waiting 中 seq 更小者 + 1；total = 项目成员总数。
 * **v3a 读口切行**：前缀成员 = starting/running/finishing 行（唯一来源）——与
 * `runner.unitState` 手算同口径。Python 无生产调用方（生产位次走 unit_state），
 * 本函数留自测与对拍。
 *
 * **返回数组 `[pos, total]` 而非对象**（2026-10-12 M4 修正）：Python 返回的是元组
 * `(pos, total)`，M3 的 Node 只读子集误用了 `{pos, total}`——因为本函数**没有任何
 * HTTP 调用方**，M3 的读端点对拍照不到它（M4 的 op 级对拍一跑就现形）。形态即契约，
 * 故对齐 Python；`runner.unitState` 的 `{state, pos, total}` 是**另一个**函数（那个
 * 确实是对象，照 Python），两者不要混。
 *
 * 逐点保留的两个细节（照 Python）：
 *   ① **同键去重**：`prefix_keys`/`total_keys` 是集合，同单元多行只计一次；
 *   ② **`ahead` 在遇到本行之前累加**：升序遍历 + 「同键已计前缀则跳过」= 同键的
 *      前方 waiting 行不重复计位。
 *
 * @param {number} itemId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {[number, number]} `[pos, total]`
 */
export function position(itemId, options = {}) {
  return withReadDb(options, (handle) => positionOn(handle, itemId));
}

/** `position` 的持连接版本 */
function positionOn(handle, itemId) {
  const row = getItemOn(handle, itemId);
  if (row === null || row.state !== STATE_WAITING) return [0, 0];
  const rows = handle.prepare(
    'SELECT id, kind, target_id, state FROM wait_items WHERE project_id=?'
    + ` AND state IN (${ACTIVE_IN}) ORDER BY seq`,
  ).all(bindable(row.project_id));
  const prefixKeys = new Set();
  const totalKeys = new Set();
  const waiting = [];                    // [行 id, 成员键]，seq 升序
  for (const r of rows) {
    const rk = memberKey(r.kind, r.target_id);
    totalKeys.add(rk);
    if (r.state === STATE_WAITING) waiting.push([r.id, rk]);
    else prefixKeys.add(rk);             // starting/running/finishing：位次前缀
  }
  let ahead = 0;
  for (const [rid, rk] of waiting) {
    if (rid === itemId) {
      // 本行即查询目标：位次 = 前缀成员数 + 前方未计前缀的等待行数 + 1
      return [prefixKeys.size + ahead + 1, totalKeys.size];
    }
    if (prefixKeys.has(rk)) continue;    // 同键已计前缀（同单元不重复计位）
    ahead += 1;                          // waiting 且 seq 更小者（升序遍历）
  }
  return [0, 0];
}

// --------------------------------------------------------------------------
// 写口 · 分数序插入与认领（waitq.py:235-616，裁决 R4）
// --------------------------------------------------------------------------
// seq 为 REAL 分数序：落尾仍 MAX(seq)+1（enqueue 语义不变），中间插入取相邻中点；间隙
// < SEQ_REBALANCE_EPS 先对项目区间行等距重排（仅 UPDATE seq，行 id 稳定）。

/**
 * 间隙挤压再平衡（waitq.py:244）：本项目 seq ≤ hi 的全部行按序等距重排到 `(floor, hi]`
 * （`floor` = 区间最小行的**全局**前驱 seq，无前驱取 `最小行 seq - 1`；hi 行本身落在原值
 * 不动）。仅 UPDATE seq，行 id 稳定、行序不变；他项目行不改写（跨项目交错行可能被本项目
 * 行越过——间隙挤压下的可接受扰动，小口径记录；呼出方需持连接，与本模块其他写函数同
 * 事务语义）。返回重排行数。
 *
 * @param {object} handle 写连接
 * @param {number} projectId
 * @param {number} hi 区间上界（含）
 * @returns {number} 重排行数
 */
function rebalanceIntervalOn(handle, projectId, hi) {
  const rows = handle.prepare(
    'SELECT id, seq FROM wait_items WHERE project_id=? AND seq <= ? ORDER BY seq, id',
  ).all(bindable(projectId), hi);
  const n = rows.length;
  if (n === 0) return 0;
  const pred = handle.prepare('SELECT MAX(seq) s FROM wait_items WHERE seq < ?')
    .get(rows[0].seq).s;
  const floor = (pred === null || pred === undefined) ? rows[0].seq - 1.0 : pred;
  const step = (hi - floor) / n;   // n 个点：floor+step … floor+n*step=hi（hi 行不动）
  const upd = handle.prepare('UPDATE wait_items SET seq=? WHERE id=?');
  rows.forEach((r, i) => upd.run(floor + step * (i + 1), r.id));
  return n;
}

/**
 * `(lo, hi)` 开区间中点 seq（waitq.py:266）；间隙 < `SEQ_REBALANCE_EPS` 先对项目区间
 * 等距重排（行 id 稳定），再取本项目 hi 前最末行与 hi 的中点（落点紧贴 hi 前）。
 *
 * 重排后本项目 hi 前无行的兜底取 `(lo, hi)` 浮点中点（float64 中点恒可表示且必落区间内；
 * 旧 `hi-1.0` 在亚 eps 间隙会跌出下界——终审 Minor-1）。
 *
 * @param {object} handle 写连接
 * @param {number} projectId
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function midSeqOn(handle, projectId, lo, hi) {
  if (hi - lo >= SEQ_REBALANCE_EPS) return (lo + hi) / 2;
  rebalanceIntervalOn(handle, projectId, hi);
  const last = handle.prepare(
    'SELECT MAX(seq) s FROM wait_items WHERE project_id=? AND seq < ?',
  ).get(bindable(projectId), hi).s;
  return (last === null || last === undefined) ? (lo + hi) / 2 : (last + hi) / 2;
}

/**
 * 「最后一个运行中条目之后」= 等待区最前的位次（waitq.py:280；锁内/事务内调用；
 * `insertAfterPrefix` 几何唯一出处，v2b T2 起 `insertCardAfterPrefix` 共用）。
 *
 * 位次几何（全局 seq 轴）：P=本项目前缀行（state∈PREFIX_STATES）最大 seq；W=本项目等待行
 * 最小 seq。W 存在 → 下界 `L=max(P.seq, W 的全局前驱.seq)`，`seq_new=(L+W.seq)/2`
 * （保项目内「前缀全在等待前」不变量）；W 不存在 → `seq_new=全局 MAX(seq)+1`（落尾，与
 * `enqueue` 兼容）。间隙 < `SEQ_REBALANCE_EPS` 时对项目区间行按序等距重排（行 id 稳定）。
 *
 * @param {object} handle 写连接
 * @param {number} projectId
 * @returns {number}
 */
function afterPrefixSeqOn(handle, projectId) {
  const pfx = handle.prepare(
    'SELECT MAX(seq) s FROM wait_items WHERE project_id=?'
    + ` AND state IN (${PREFIX_IN})`,
  ).get(bindable(projectId)).s;
  const w = handle.prepare(
    "SELECT MIN(seq) s FROM wait_items WHERE project_id=? AND state='waiting'",
  ).get(bindable(projectId)).s;
  if (w === null || w === undefined) {
    return handle.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM wait_items').get().s;
  }
  const pred = handle.prepare('SELECT MAX(seq) s FROM wait_items WHERE seq < ?').get(w).s;
  const lows = [pfx, pred].filter((x) => x !== null && x !== undefined);
  const lo = lows.length ? Math.max(...lows) : w - 1.0;   // 无前驱：界外一步
  return midSeqOn(handle, projectId, lo, w);
}

/**
 * 「最后一个运行中条目之后」= 等待区最前（waitq.py:305，设计 §2.2 插入规则基本形态）。
 *
 * 位次几何见 `afterPrefixSeqOn`；活跃唯一索引冲突时幂等复用现行语义（返回既有行）。
 * 返回 `[row_id, seq_new]`（照 Python 元组）。
 *
 * @param {string} kind 五 kind 之一（未知抛 `TypeError`）
 * @param {string|number} target
 * @param {number} projectId
 * @param {object|null} [meta]
 * @param {number} [notBefore]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {[number, number]}
 */
export function insertAfterPrefix(kind, target, projectId, meta = null, notBefore = 0,
  options = {}) {
  if (!KINDS.includes(kind)) throw new TypeError(`未知等待项 kind: ${kind}`);
  const targetId = String(target);
  return withWriteDb(options, (handle) => {
    try {
      const seqNew = afterPrefixSeqOn(handle, projectId);
      const info = handle.prepare(
        'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
        + ' created_at, not_before, meta)'
        + " VALUES (?,?,?,'waiting',?,?,?,?)",
      ).run(bindable(projectId), kind, targetId, seqNew, nowStr(),
        Number(notBefore || 0), pyJsonDumps(meta || {}));
      return [Number(info.lastInsertRowid), seqNew];
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      const row = handle.prepare(
        'SELECT id, seq FROM wait_items WHERE kind=? AND target_id=?'
        + ` AND state IN (${ACTIVE_IN})`,
      ).get(kind, targetId);
      if (row === undefined) throw err;     // 非活跃唯一索引冲突：上抛，交给调用方
      return [row.id, row.seq];
    }
  });
}

/**
 * 会话消息落点（waitq.py:333，v2 §2.2 插入规则的消息分支，2026-09-25 对齐「待对齐项」）：
 * 「最后一个运行中条目之后」，且排在同项目已排队的用户动作行（waiting `m:`/`a:`）之后
 * ——消息优先于等待区卡片/任务（`c:`/`t:`），同项目用户动作之间保持到达序 FIFO（否则
 * 第二条消息会插到第一条之前，同会话消息序被反转）。
 *
 * 几何（复用 `midSeqOn` 区间语义，锁内/事务内调用）：base = 本项目「前缀行 ∪ 等待用户
 * 动作行」的最大 seq；base 为空（无前缀无用户动作）退化为 `afterPrefixSeqOn`（等待区最
 * 前）；hi = 本项目 `seq>base` 的首个等待行，无 hi 落全局尾；lo = `max(base, hi 的全局
 * 前驱)`，取 `(lo, hi)` 中点。
 *
 * @param {object} handle 写连接
 * @param {number} projectId
 * @returns {number}
 */
function msgInsertSeqOn(handle, projectId) {
  const base = handle.prepare(
    'SELECT MAX(seq) s FROM wait_items WHERE project_id=?'
    + ` AND (state IN (${PREFIX_IN})`
    + ` OR (state='waiting' AND kind IN ('${KIND_MSG}','${KIND_ANSWER}')))`,
  ).get(bindable(projectId)).s;
  if (base === null || base === undefined) return afterPrefixSeqOn(handle, projectId);
  const hi = handle.prepare(
    "SELECT MIN(seq) s FROM wait_items WHERE project_id=? AND state='waiting' AND seq > ?",
  ).get(bindable(projectId), base).s;
  if (hi === null || hi === undefined) {
    return handle.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM wait_items').get().s;
  }
  const pred = handle.prepare('SELECT MAX(seq) s FROM wait_items WHERE seq < ?').get(hi).s;
  const lo = (pred === null || pred === undefined) ? base : Math.max(base, pred);
  return midSeqOn(handle, projectId, lo, hi);
}

/**
 * 拖拽落点改序（waitq.py:362）：`seq=(prev_seq+next_seq)/2`；仅 UPDATE seq，行 id 稳定
 * （P3 inject R4 口径）；间隙挤压先重排。prev/next 由调用方按落点邻行给出（`null` 表示
 * 区首/区尾，取界外一步）。
 *
 * 行不存在返回 `false`；两界皆空或区间倒置（prev ≥ next）抛错（Node `RangeError`，
 * 照 Python `ValueError`）。
 *
 * 行态守卫说明（v2c T2 补记，v2a 移交项）：本函数**有意不设行态守卫**——调序手势/补位
 * 几何需要挪 starting/running 行（行即成员，运行前缀也按 seq 展示与插位）；终态行被挪
 * 无害（读侧全部只认活跃行，seq 改动无消费方）。并发语义由调用方承载：worker 已 claim
 * 的行被挪序不影响该次起跑（仅位次展示瞬态漂移），手势侧幂等兜底见 `board._doing_gesture`。
 *
 * @param {number} rowId
 * @param {number|null} prevSeq
 * @param {number|null} nextSeq
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function reposition(rowId, prevSeq = null, nextSeq = null, options = {}) {
  const hasPrev = prevSeq !== null && prevSeq !== undefined;
  const hasNext = nextSeq !== null && nextSeq !== undefined;
  if (!hasPrev && !hasNext) {
    throw new RangeError('reposition 需至少给一侧邻行 seq');
  }
  if (hasPrev && hasNext && Number(prevSeq) >= Number(nextSeq)) {
    throw new RangeError('reposition 区间倒置：prev_seq 必须小于 next_seq');
  }
  return withWriteDb(options, (handle) => {
    const row = handle.prepare('SELECT project_id FROM wait_items WHERE id=?')
      .get(bindable(rowId));
    if (row === undefined) return false;
    const lo = hasPrev ? Number(prevSeq) : Number(nextSeq) - 1.0;
    const hi = hasNext ? Number(nextSeq) : Number(prevSeq) + 1.0;
    const seqNew = midSeqOn(handle, row.project_id, lo, hi);
    handle.prepare('UPDATE wait_items SET seq=? WHERE id=?')
      .run(seqNew, bindable(rowId));
    return true;
  });
}

/**
 * 拾取（`waiting → starting`，原子：rowcount 判定，已被抢返回 `false`；waitq.py:390）。
 *
 * v2a T1（裁决 R3）：目标态 claimed 改名 starting（claimed 语义被吸收），认领迁移同为
 * rowcount 守卫，互斥语义逐字不变。
 *
 * @param {number} itemId
 * @param {string} [claimer]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function claim(itemId, claimer = '', options = {}) {
  if (itemId === null || itemId === undefined) return false;
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE wait_items SET state='starting', claimed_at=?, claimed_by=?"
      + " WHERE id=? AND state='waiting'",
    ).run(nowStr(), bindable(claimer), bindable(itemId));
    return Number(info.changes) === 1;
  });
}

/**
 * 按 `(kind,target)` 拾取（waitq.py:404）：先查活跃行再原子 `claim`；无活跃行/已被抢
 * 返回 `false`。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {string} [claimer]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function claimByTarget(kind, targetId, claimer = '', options = {}) {
  const row = getActive(kind, targetId, options);
  return row !== null ? claim(row.id, claimer, options) : false;
}

/**
 * `starting → running`（waitq.py:410）：证实运行（proc 存活 / web busy / turn 基线确认）
 * 后由起跑路径调用；非 starting 行返回 `false`（幂等守卫，不炸调用方）。
 *
 * v3a 补充：起跑证实（六条起跑路径）改经 `enterRunning`——本函数保留原语义不变（严格
 * `starting→running`，recover 映射 / starting 超时自愈等既有调用方逐字不动）。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function markRunning(kind, targetId, options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE wait_items SET state='running' WHERE kind=? AND target_id=?"
      + " AND state='starting'",
    ).run(kind, String(targetId));
    return Number(info.changes) === 1;
  });
}

/**
 * 确保 `(kind,target)` 有且只有一条 running 行（v3a 起跑证实统一入口；waitq.py:424）。
 *
 * 「行即条目」（v3 §2.2）：`c:` 行在起跑证实后**保持 running 跨轮存活**，直到会话结束/
 * 出队——旧口径在起跑瞬间把行终态化、跨轮占用另立表征，v3a 起退场。本函数是
 * `markRunning` 的超集（后者严格 `starting→running`，保留给既有调用方）：
 *
 *   - 活跃行（waiting/starting/finishing）→ running（waiting 直接升格：起跑证实即运行，
 *     不重排队、不新插行）；
 *   - 已是 running → 幂等 `true`（行原样不动）；
 *   - 终态行（done/failed/cancelled）→ **复用同一行**（同 id、同 seq）重开 running——出队
 *     （落阻塞/停止/移列/删除）后再起跑不新造行，位次与审计线索延续；
 *   - 无行 → 插入一行 `state=running`，位次几何与 `insertAfterPrefix` 一致
 *     （`afterPrefixSeqOn`：运行前缀尾 / 等待区最前）——force 直起、送达恢复、阻塞解除
 *     归位、recover 重建等「无活跃行」路径在此补齐「行即成员」。
 *
 * 返回 `true` = 行已在 running（本入口幂等且不可失败：起跑证实的成败由起跑方自行判定，
 * 行只是证据面）。并发安全：先查活跃行；写入撞活跃唯一索引 `(kind,target_id)`（他人刚
 * 插入/重开活跃行）→ 重查复用其行，幂等不抛。meta 仅在新建/重开时合并（活跃行 meta 不动，
 * 避免踩 extra/from_column 审计线索）；**行证据同理**——重开终态行 = 新生命周期，
 * evidence/last_seen 一并清零（旧会话证据不得残留到下一条命：pid 陈旧会误判判活/判死），
 * 活跃行证据不动（由 `markEvidence` / `touchUnit` 续写）。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {number} projectId 无行时新建用
 * @param {object|null} [meta] 仅新建/重开时合入
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function enterRunning(kind, targetId, projectId, meta = null, options = {}) {
  const target = String(targetId);
  return withWriteDb(options, (handle) => {
    let row = handle.prepare(
      'SELECT id, state FROM wait_items WHERE kind=? AND target_id=?'
      + ` AND state IN (${ACTIVE_IN})`,
    ).get(kind, target);
    if (row !== undefined) {
      if (row.state !== RUNNING) {
        handle.prepare("UPDATE wait_items SET state='running' WHERE id=?").run(row.id);
      }
      return true;
    }
    const prev = handle.prepare(
      'SELECT id, meta FROM wait_items WHERE kind=? AND target_id=?'
      + ' ORDER BY id DESC LIMIT 1',
    ).get(kind, target);
    if (prev !== undefined) {                 // 终态行重开（同 id 同 seq，不新插行）
      try {
        handle.prepare(
          "UPDATE wait_items SET state='running', ended_at=NULL,"
          + " claimed_at=NULL, claimed_by=NULL, not_before=0,"
          + " last_seen=0, evidence='' WHERE id=?",
        ).run(prev.id);
      } catch (err) {
        if (!isIntegrityError(err)) throw err;
        row = handle.prepare(                   // 并发：他人已重开同键行 → 落在活跃行上
          'SELECT id FROM wait_items WHERE kind=? AND target_id=?'
          + ` AND state IN (${ACTIVE_IN})`,
        ).get(kind, target);
        if (row === undefined) throw err;
        handle.prepare("UPDATE wait_items SET state='running' WHERE id=?").run(row.id);
      }
      if (hasEntries(meta)) mergeMetaOn(handle, prev, meta);
      return true;
    }
    const seqNew = afterPrefixSeqOn(handle, projectId);
    try {
      handle.prepare(
        'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
        + ' created_at, meta)'
        + " VALUES (?,?,?,'running',?,?,?)",
      ).run(bindable(projectId), kind, target, seqNew, nowStr(), pyJsonDumps(meta || {}));
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      row = handle.prepare(                      // 并发：他人刚建活跃行 → 复用其行
        'SELECT id FROM wait_items WHERE kind=? AND target_id=?'
        + ` AND state IN (${ACTIVE_IN})`,
      ).get(kind, target);
      if (row === undefined) throw err;
      handle.prepare("UPDATE wait_items SET state='running' WHERE id=?").run(row.id);
    }
    return true;
  });
}

/**
 * `running → finishing`（waitq.py:496）：唯一收尾点入口（v2d T1，生产面唯此一条——
 * `board.finish` 只对 running 行调用）。SQL 另容忍 starting 作防御面（无生产调用方：
 * 起跑失败 / starting 超时行的终态走 `finishByTarget` / worker finally，不经本迁移）。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function markFinishing(kind, targetId, options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE wait_items SET state='finishing' WHERE kind=? AND target_id=?"
      + " AND state IN ('starting','running')",
    ).run(kind, String(targetId));
    return Number(info.changes) === 1;
  });
}

/**
 * 活跃项落终态（done/failed）；非活跃返回 `false`（waitq.py:508）。
 *
 * 状态守卫落在 UPDATE 上（rowcount 判定），避免读-写之间被并发抢先落终态；error 的 meta
 * 合并在同一事务内、仅落终态成功（`changes === 1`）时执行。
 *
 * @param {number} itemId
 * @param {string} state 终态（`done`/`failed`）
 * @param {string} [error]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
function setTerminal(itemId, state, error = '', options = {}) {
  if (itemId === null || itemId === undefined) return false;
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      'UPDATE wait_items SET state=?, ended_at=?'
      + ` WHERE id=? AND state IN (${ACTIVE_IN})`,
    ).run(state, nowStr(), bindable(itemId));
    if (Number(info.changes) !== 1) return false;
    if (error) {
      const row = handle.prepare('SELECT id, meta FROM wait_items WHERE id=?')
        .get(bindable(itemId));
      mergeMetaOn(handle, row, { error });
    }
    return true;
  });
}

/**
 * 标记完成（投递/送达/会话起跑成功的终态；waitq.py:530）。
 * @param {number} itemId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function markDone(itemId, options = {}) {
  return setTerminal(itemId, DONE, '', options);
}

/**
 * 标记执行失败（起会话失败/送达失败等；error 落 meta；waitq.py:535）。
 * @param {number} itemId
 * @param {string} [error]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function markFailed(itemId, error = '', options = {}) {
  return setTerminal(itemId, FAILED, error, options);
}

/**
 * 按 `(kind,target)` 落终态；无活跃行返回 `false`（waitq.py:540）。
 * @param {string} kind
 * @param {string|number} targetId
 * @param {string} [state] `done`（缺省）走 `markDone`，其余走 `markFailed`
 * @param {string} [error]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function finishByTarget(kind, targetId, state = DONE, error = '', options = {}) {
  const row = getActive(kind, targetId, options);
  if (row === null) return false;
  if (state === DONE) return markDone(row.id, options);
  return markFailed(row.id, error, options);
}

/**
 * `starting/running/finishing → waiting` 放回（重试退避：not_before 最早可拾取时间；
 * bump_retry 累加计数；waitq.py:550）。
 *
 * 状态守卫落在 UPDATE 上（活跃非 waiting 三态 + rowcount 判定）：终态行不会被复活（否则
 * 会与活跃唯一索引冲突）；retries 在 SQL 内累加，免先读后写。v2a T1：claimed 改名
 * starting；放回面扩到 running/finishing（recover 映射：`a:` 行三态同型放回重投）。
 *
 * @param {number} itemId
 * @param {number} [notBefore]
 * @param {boolean} [bumpRetry]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function returnToWaiting(itemId, notBefore = 0.0, bumpRetry = false, options = {}) {
  if (itemId === null || itemId === undefined) return false;
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE wait_items SET state='waiting', claimed_at=NULL, claimed_by=NULL,"
      + ' not_before=?, retries=retries+?'
      + ` WHERE id=? AND state IN (${RETURNABLE_IN})`,
    ).run(Number(notBefore || 0), bumpRetry ? 1 : 0, bindable(itemId));
    return Number(info.changes) === 1;
  });
}

/**
 * 取消活跃等待项（幂等：无活跃行返回 `false`；reason 落 meta；waitq.py:567）。
 *
 * 状态守卫落在 UPDATE 上（四活跃态 + rowcount 判定，与 `setTerminal` 同型）：避免读-写
 * 之间被并发抢先落终态——终态行不再被改写成 cancelled；reason 的 meta 合并在同一事务内、
 * 仅取消成功（`changes === 1`）时执行。
 *
 * `states` 收窄可取消行态（缺省 `null` = 四活跃态，既有调用面逐字不变；v2d T1：作答排队
 * 防御只取 waiting——running/finishing 行终态化归 `board.finish` 唯一收尾点、starting 归
 * worker finally，行态口径统一）。空数组防御（v2d T1 minor 收口）：`states=[]` 语义为
 * 「无可取消态」，直接返回 `false`——原样拼 SQL 会得到 `state IN ()` 语法错。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {string} [reason]
 * @param {string[]|null} [states]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function cancel(kind, targetId, reason = '', states = null, options = {}) {
  if (states !== null && states !== undefined && states.length === 0) {
    return false;                                        // 无可取消态：直接 no-op
  }
  const scope = (states === null || states === undefined)
    ? ACTIVE_IN : states.map((s) => `'${s}'`).join(',');
  return withWriteDb(options, (handle) => {
    const row = handle.prepare(
      'SELECT id, meta FROM wait_items WHERE kind=? AND target_id=?'
      + ` AND state IN (${scope})`,
    ).get(kind, String(targetId));
    if (row === undefined) return false;
    const info = handle.prepare(
      "UPDATE wait_items SET state='cancelled', ended_at=?"
      + ` WHERE id=? AND state IN (${scope})`,
    ).run(nowStr(), row.id);
    if (Number(info.changes) !== 1) {
      return false;          // 读-写之间被并发落终态：不复活也不改写终态行
    }
    if (reason) mergeMetaOn(handle, row, { cancel_reason: reason });
    return true;
  });
}

/**
 * 清空全部活跃等待项（返回条数；waitq.py:600）。
 *
 * `excludeKind`（str 或数组）：answer/msg 已切权威（重启存活），recover 传
 * `[KIND_ANSWER, KIND_MSG]` 保留两类行（`runner.recover` 按表重建内存单元）；task/card 仍
 * 随重启清空。P4 起 recover 不再使用（waiting 全量存活、starting 按类收口，R1）——函数
 * 保留供 selfcheck / 未来对账复用。
 *
 * ⚠ 事务形态照 Python：逐行 `cancel`（**每次一个独立事务**，不整体包一层）。
 *
 * @param {string} [reason]
 * @param {string|string[]|null} [excludeKind]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number}
 */
export function cancelAllActive(reason = '', excludeKind = null, options = {}) {
  const excludes = new Set(typeof excludeKind === 'string'
    ? [excludeKind] : (excludeKind || []));
  let n = 0;
  for (const row of activeItems(null, options)) {
    if (excludes.has(row.kind)) continue;
    if (cancel(row.kind, row.target_id, reason, null, options)) n += 1;
  }
  return n;
}

// --------------------------------------------------------------------------
// 写口 · 行证据与心跳（waitq.py:619-699；v3c：证据/心跳迁到行，v3 §2.4，裁决 R2/R11）
// --------------------------------------------------------------------------
// last_seen=最近一次心跳时间戳、evidence=证据 JSON 文本（desc/reason/pid 登记证据 +
// busy=…(poll|sse) 心跳证据）。写入口唯一：本段两函数 + enterRunning 的重开清证据；
// 读口：evidencePid（进程证据）与 unitVerdict（对账/自检判活）。

/**
 * 行 evidence JSON 合入 patch → 序列化文本（waitq.py:624）。
 *
 * 坏 JSON / 非对象按空对象处理；列初值为空串（`db.migrate` 默认）等价空对象。
 *
 * @param {object} row `{evidence}` 行
 * @param {object|null} [patch]
 * @returns {string} JSON 文本（`pyJsonDumps` 口径）
 */
function evidenceText(row, patch = null) {
  let cur;
  try {
    cur = JSON.parse(row.evidence || '{}');
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  } catch {
    cur = {};
  }
  Object.assign(cur, patch || {});
  return pyJsonDumps(cur);
}

/**
 * 行心跳（waitq.py:639）：刷新活跃行 last_seen；evidence 非空时合入行 evidence JSON
 * （键 `evidence` / `evidence_at`）。
 *
 * 刷新面=**活跃行**（等待/起始/运行/收尾）：终态行不打点（心跳只对在场条目有意义，收口后
 * 的行不复活）；无活跃行返回 `false`（不抛）。调用面：board 调和器（5s 节拍，仅对在管卡，
 * `busy=1/0(poll)`）与 SSE 钩子（`busy=1(sse)`）。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {string} [evidence]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function touchUnit(kind, targetId, evidence = '', options = {}) {
  const now = Date.now() / 1000;              // 照 Python time.time()（epoch 秒浮点）
  return withWriteDb(options, (handle) => {
    const row = handle.prepare(
      'SELECT id, evidence FROM wait_items WHERE kind=? AND target_id=?'
      + ` AND state IN (${ACTIVE_IN})`,
    ).get(kind, String(targetId));
    if (row === undefined) return false;
    const patch = evidence ? { evidence, evidence_at: now } : null;
    handle.prepare('UPDATE wait_items SET last_seen=?, evidence=? WHERE id=?')
      .run(now, evidenceText(row, patch), row.id);
    return true;
  });
}

/**
 * 登记型证据写入（waitq.py:662；`card_started` 的 desc / reason / pid 登记面）：合入活跃行
 * evidence JSON（同键覆盖）。
 *
 * 无活跃行或 patch 为空返回 `false`（幂等 no-op）。**不动 last_seen**——心跳归 `touchUnit`；
 * 判活读口只认活跃行，故无活跃行时写入无意义。
 *
 * @param {string} kind
 * @param {string|number} targetId
 * @param {object} patch
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function markEvidence(kind, targetId, patch, options = {}) {
  if (!hasEntries(patch)) return false;
  return withWriteDb(options, (handle) => {
    const row = handle.prepare(
      'SELECT id, evidence FROM wait_items WHERE kind=? AND target_id=?'
      + ` AND state IN (${ACTIVE_IN})`,
    ).get(kind, String(targetId));
    if (row === undefined) return false;
    handle.prepare('UPDATE wait_items SET evidence=? WHERE id=?')
      .run(evidenceText(row, patch), row.id);
    return true;
  });
}

/**
 * 行 evidence 的 pid 读取口（waitq.py:683；R11④ 进程证据；无行/无 pid/坏 JSON → `null`）。
 *
 * v3c 起读行 evidence（`card_started` 写入）——CLI 族卡起跑成功后必有；web 族/拾取窗口
 * 无 pid 落 unknown（宁多等不误杀）。`bool` 不算 pid（Python `isinstance(True, int)` 为真，
 * 显式排除；JS 侧 `true` 本就不是 number，天然排除）。
 *
 * 已知差异（文件头差异⑩一族）：Python `isinstance(pid, int)` 把 JSON 浮点字面量（`1.0`）
 * 判为非 pid，JS 侧 `1.0` 与 `1` 同值 ⇒ 会当 pid 用；平台只写 `str(int)` 形状，不可达。
 *
 * @param {object|null} row 行对象（`evidence` 列）
 * @returns {number|null}
 */
export function evidencePid(row) {
  if (row === null || row === undefined) return null;
  let ev;
  try {
    ev = JSON.parse(row.evidence || '{}');
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const pid = ev.pid;
  return (typeof pid === 'number' && Number.isInteger(pid)) ? pid : null;
}

// --------------------------------------------------------------------------
// 写口 · 自检与对账（waitq.py:702-963；P1 骨架 selfcheck 纯报告；v3c 全切行口径）
// --------------------------------------------------------------------------

/**
 * 纯 DB 不变量自检，返回问题描述清单（空列表=健康；waitq.py:708）。
 *
 * 检查项（v3c 行口径，裁决 R12）：
 *   ① 同 `(kind,target)` 多条活跃等待项（唯一索引失效/绕过）；
 *   ② 活跃态（starting/running/finishing，v2d T3 扩面）**超龄且无可证明证据**
 *      （`claimed_at` 越过 `CLAIM_STALE_S` 且判活三态非 alive、`last_seen` 心跳也不再
 *      新鲜）——可疑泄漏，**纯报告面**：行不因超龄被改写（可证死才自动收口的判据在
 *      `unitVerdict`/`selfcheckUnits`，R11 边界沿用）。running/finishing 覆盖 force 落表行
 *      （行留队构成运行前缀）与收尾瞬态；正常持轮会话有 pid 证据或 5s 心跳在场，不误报。
 *      `claimed_at IS NULL` 的行不参与 ②（等待行本就长期在场：排队卡/消息/答案，超龄对其
 *      无意义）；
 *   ③ **I1 违约报告**（R12 新增，纯报告只告警不改行）：卡片不在「正在开发」容器却有活跃
 *      `c:` 行（阻塞/待审核/已完成/待开发一律出队，v3 §2.1 I1）；卡行已删同列报告（行
 *      无主）。经唯一出队原语迁移的路径行先终态、列后搬，故稳态不报（仅搬列窗口的毫秒级
 *      瞬态可被 60s 自检撞见，无害）。
 *
 * ext 行（v2d T4 外部条目）不参与 ②（`claimed_at` 恒空——外部直跑不由平台启动、非认领
 * 行）；其生灭归调和器/入队刷新按项目活跃会话集合对账，**且全程不在 ③ 的扫描集内**——
 * ③ 只取 `kind=KIND_CARD` 的活跃行。反向形态「占位在、行不在」**不在本函数面**：它要读
 * `board_cards` 的排队占位语义，归 `board._heal_queue_placeholders` 的 30s 节拍。
 *
 * @param {((row: object) => string|null)|null} [probe] 行判活探针（web busy 三态；
 *        `selfcheckUnits` 透传，直调缺省 null）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string[]}
 */
export function selfcheck(probe = null, options = {}) {
  const problems = [];
  const now = Date.now() / 1000;
  const cutoff = localTimeStr(now - CLAIM_STALE_S);
  return withReadDb(options, (handle) => {
    const readOptions = { db: handle };
    for (const r of handle.prepare(
      'SELECT kind, target_id, COUNT(*) n FROM wait_items'
      + ` WHERE state IN (${ACTIVE_IN})`
      + ' GROUP BY kind, target_id HAVING n > 1',
    ).all()) {
      problems.push(`等待项重复: kind=${r.kind} target=${r.target_id} n=${r.n}`);
    }
    const stale = handle.prepare(
      'SELECT * FROM wait_items'
      + " WHERE state IN ('starting','running','finishing')"
      + ' AND claimed_at IS NOT NULL AND claimed_at < ?',
    ).all(cutoff);
    const crow = handle.prepare(
      'SELECT id, target_id, state FROM wait_items WHERE kind=?'
      + ` AND state IN (${ACTIVE_IN})`,
    ).all(KIND_CARD);
    // 卡列只取活跃 c: 行涉及的卡（60s 自检不做全表扫描；空集免查）
    const ids = [...new Set(crow.map((r) => r.target_id))].sort();
    const cards = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      for (const r of handle.prepare(
        `SELECT id, column_key FROM board_cards WHERE id IN (${placeholders})`,
      ).all(...ids.map(bindable))) {
        cards.set(String(r.id), r.column_key);
      }
    }
    for (const r of stale) {
      if (unitVerdict(r, probe, readOptions) === 'alive') {
        continue;                      // 有可证明证据（探针/内建 DB/pid 存活）
      }
      if (r.last_seen && now - r.last_seen < CLAIM_STALE_S) {
        continue;                      // 心跳新鲜：在管打点即活性佐证
      }
      problems.push(`${r.state} 超龄无证据: id=${r.id} kind=${r.kind}`
        + ` target=${r.target_id} claimed_at=${r.claimed_at}`);
    }
    for (const r of crow) {            // ③ I1 违约报告（只告警不改行）
      const col = cards.get(r.target_id);
      if (col === undefined) {
        problems.push(`I1 违约: 卡行已删却有活跃 c: 行 id=${r.id}`
          + ` target=${r.target_id} state=${r.state}`);
      } else if (col !== 'doing') {
        problems.push(`I1 违约: 卡 ${r.target_id} 不在正在开发容器`
          + `（column=${col}）却有活跃 c: 行 id=${r.id} state=${r.state}`);
      }
    }
    return problems;
  });
}

/**
 * 行年龄（秒，自最近一次活动；waitq.py:781）：`last_seen` 心跳优先，回落 `claimed_at` /
 * `created_at`（文本时间戳，同库口径）。
 *
 * 解析失败按 0（=**最年轻**，与「刚活动过的新生行」同侧）：唯一消费面 `selfcheckUnits`
 * 的判据是「`unitAge(row) < min_age` → 跳过处置与告警」（年龄豁免），0 落豁免侧——宁可
 * 晚一拍再处置，也不对无时间戳的行抢先收口（v3 终审修复：原文写「视为最老，不误豁免」，
 * 与代码相反）。
 *
 * @param {object} row
 * @returns {number}
 */
function unitAge(row) {
  const now = Date.now() / 1000;
  if (row.last_seen) return Math.max(0.0, now - Number(row.last_seen));
  const ts = row.claimed_at || row.created_at;
  try {
    return Math.max(0.0, now - parseLocalSeconds(ts));
  } catch {
    return 0.0;                        // ValueError/TypeError/OverflowError 同侧
  }
}

/**
 * 可证死活跃行收口（启动对账 / 周期自检共用，v3c；waitq.py:798）：起步前（waiting/
 * starting）→ cancelled；起步后（running/finishing）→ failed（error=reason）。
 *
 * 分流口径承 `runner.recover` 的按行收口映射（「服务重启中断」同款：未起跑的行本就是取消
 * 语义、已起跑的行按失败收口）；两者都是一次 rowcount 守卫的终态写入（终态行不再被改写，
 * 与行状态机「出队即终态」一致）。命中即打一行日志（含 reason 标签——reason 同时落行
 * meta）。返回是否命中收口。
 *
 * @param {object} row 活跃行
 * @param {string} reason
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
function closeDeadUnit(row, reason, options = {}) {
  const hit = (row.state === WAITING || row.state === STARTING)
    ? cancel(row.kind, row.target_id, reason, null, options)
    : markFailed(row.id, reason, options);
  if (hit) {
    console.log(`[waitq] 收口可证死行 ${memberKey(row.kind, row.target_id)}（${reason}）`);
  }
  return hit;
}

/**
 * 单条活跃行的判活（宁多等不误放行）：返回 `"alive"`/`"dead"`/`"unknown"`
 * （waitq.py:818）。
 *
 * 判据次序（v3c 行口径）：
 *   ① 注入探针（会话 busy 一类外部证据；waitq 不 import board/dshdriver，维持纯 DB 模块
 *      边界）给出确活 → alive；② 探针判死**不采信**，降级 unknown（裁决 R11a：web 会话
 *      idle/不在场是跨轮间隙常态，判死即误杀串行位）；③ 探针缺席/失败/不明 → 内建 DB 证据
 *      兜底（任务行状态、消息行状态、卡行存在性、**行 evidence 的 pid 进程存活**——R11
 *      清单①②③④⑤）；④ 皆无结论 → unknown。
 *
 * **`t:`/`m:` 对应任务/消息行 queued 一律 unknown 不证死**（评审 Important-1）：queued 是
 * 「拾取 → 行置 running」新生窗口的天然形态，与行龄无关——做旧的 queued 残留由 recover
 * 放回/重建后重新拾起，无需以收口清场；可证死只认**终态行/行缺失/pid 进程退**（均非瞬态
 * 证据）。`ext:` 行（外部条目，v2d T4）只认「卡行已删」一支——外部会话实况归调和器按
 * 项目活跃会话集合对账，本函数不裁其活。
 *
 * @param {object} row 活跃行
 * @param {((row: object) => string|null)|null} probe
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {'alive'|'dead'|'unknown'}
 */
function unitVerdict(row, probe, options = {}) {
  if (probe !== null && probe !== undefined) {
    let v = null;
    try {
      v = probe(row);
    } catch {
      v = null;                                    // 探测失败=状态不明，走内建
    }
    if (v === 'alive') return 'alive';
    if (v === 'dead') return 'unknown';            // R11a：探针判死不擅动
  }
  const kind = row.kind;
  const target = row.target_id;
  if (kind === KIND_TASK) {
    const tid = targetInt(target);
    const t = tid === null ? null : getTask(tid, options);
    if (t === null) return 'dead';                 // 任务行已删/引用不可解析（§7.2 ②）
    if (t.status === 'running') return 'alive';
    return t.status === 'queued' ? 'unknown' : 'dead';   // queued=新生窗口
  }
  if (kind === KIND_MSG) {
    const m = msgGet(target, options);
    if (m === null) return 'dead';                 // 消息行缺失（§7.2 ③）
    if (m.state === 'running') return 'alive';
    return m.state === 'queued' ? 'unknown' : 'dead';    // queued=新生窗口
  }
  if (kind === KIND_CARD || kind === KIND_ANSWER) {
    const cid = targetInt(target);
    const card = cid === null ? null : getBoardCard(cid, options);
    if (card === null) return 'dead';              // 卡行已删/引用不可解析（§7.2 ①）
    // R11④ 进程证据（CLI 族卡起跑成功后由 card_started 写入行 evidence.pid，v3c 起读行）：
    // 进程已退即可证死（启动对账收口 CLI 卡残留的主路径），存活即确活；pid 复用的误判
    // 方向是「确活」=宁多等。无 pid（拾取窗口/web 族）落 unknown——宁多等不误杀。
    const pid = evidencePid(row);
    if (pid !== null) return pidAlive(pid) ? 'alive' : 'dead';
    return 'unknown';
  }
  if (kind === KIND_EXT) {
    // 外部条目：卡行已删即无主（可证死）；其余交调和器按实况集合对账
    const cid = targetInt(target);
    const card = cid === null ? null : getBoardCard(cid, options);
    return card === null ? 'dead' : 'unknown';
  }
  return 'unknown';
}

/**
 * 启动对账（v3c 起行口径；waitq.py:877，设计 §7.1/R11）：按**活跃等待项行**逐条判活；
 * 可证死 → 行收口（reason 标签「启动对账：可证明失效」）；活/未知 → 保留。返回处置清单
 * `[{project_id, key, kind, verdict, closed}]`；卡/任务的用户可见收尾沿用既有路径
 * （调和器归位/interrupted），本函数只管队列层。
 *
 * 调用顺序硬约束：必须在 `runner.recover` → `board.recover` 之后跑——board.recover 已把
 * busy web 卡的行置 running 并重建在管条目，提前对账会把在跑的会话误判。新生窗口豁免
 * 落在 `unitVerdict`。**事务形态照 Python**：逐行各自独立事务（不整体包一层）。
 *
 * @param {((row: object) => string|null)|null} [probe]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{project_id: number, key: string, kind: string, verdict: string, closed: boolean}[]}
 */
export function reconcileUnits(probe = null, options = {}) {
  const out = [];
  for (const row of activeItems(null, options)) {
    const verdict = unitVerdict(row, probe, options);
    let closed = false;
    if (verdict === 'dead') closed = closeDeadUnit(row, '启动对账：可证明失效', options);
    out.push({
      project_id: row.project_id,
      key: memberKey(row.kind, row.target_id),
      kind: row.kind,
      verdict,
      closed,
    });
  }
  return out;
}

/**
 * 周期自检处置（v3c 起行口径；waitq.py:903，设计 §7.2/R11）：仅对**可证明失效**的活跃行
 * 自动收口并返回告警/动作清单；状态不明只告警（R11/R11a：运行期 web idle 不判死——跨轮
 * 间隙误杀面，权威收口路径（`_finish_run` / 出队原语）在进程内可靠）。
 *
 * `minAge`：**行年龄豁免**（秒）——行自最近一次活动（last_seen 心跳回落 claimed_at/
 * created_at）距今不足 minAge 的跳过处置与告警（拾取/建行 → 行置 running 稍后的毫秒窗口，
 * 防误杀新生行，与判据内的新生窗口豁免互补防御）。缺省 0=不豁免（纯函数旧语义）。
 *
 * `managed`：**平台在管豁免判据**（v3c 修复轮 Important-2；`board.unit_managed` 经
 * `runner.start_unit_selfcheck` 注入，缺省 null=不豁免）——行所属单元仍在平台在管条目
 * （`_RUNS`）时，其收尾归巡视 `_finish_run`（R4 收尾归属），自检**不越权收口**：否则
 * CLI 卡 agent 进程刚退出（行 evidence.pid 已退=可证死形态）、巡视 30s 节拍未到时，自检会
 * 把一次成功会话的行抢先标 `failed`（污染作为调度权威的审计行，并瞬时造出「卡在 doing 却
 * 无活跃行」的 I1 违约自报）；`card_finished` 门禁 (running, finishing) 届时已见终态行，
 * 错误标签定死。豁免只作用于**收口面**：`_RUNS` 无条目的卡死行（自检是唯一恢复路径）照常
 * 收口，不因本守卫停滞。
 *
 * 告警面（v3c 修复轮 Important-1）只覆盖**平台认领的在跑行**：waiting 行（排队单元/积压卡
 * ——天然无证据，属常态）与 `ext:` 行（外部条目生灭归调和器）不告警——逐条遍历会把 N 条
 * 积压变成每 60s N 行日志，违背「健康时静默」并淹没 R12 报告；`dead` 收口面不受此限
 * （waiting 泄漏行照常收口）。waiting 行同样免探针（无会话可探，且探针在其上只会把 dead
 * 降级 unknown——省 N 次 REST）。R12 的报告扩展（I1 违约报告、「活跃行超龄且无可证明
 * 证据」）在 `selfcheck()` 并入返回——**报告项只告警不改行**，自动收口只走 `dead` 一支。
 *
 * @param {((row: object) => string|null)|null} [probe]
 * @param {number} [minAge]
 * @param {((row: object) => boolean)|null} [managed]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string[]}
 */
export function selfcheckUnits(probe = null, minAge = 0.0, managed = null, options = {}) {
  const problems = [];
  for (const row of activeItems(null, options)) {
    if (minAge > 0 && unitAge(row) < minAge) {
      continue;                                    // 年龄豁免：新生行不动不告警
    }
    // waiting 行免探针（见 docstring）；其余行按注入探针裁活
    const verdict = unitVerdict(row, row.state === WAITING ? null : probe, options);
    const key = memberKey(row.kind, row.target_id);
    if (verdict === 'dead') {
      if (managed !== null && managed !== undefined && managed(row)) {
        continue;              // 平台在管：收尾归巡视（R4），自检不越权收口
      }
      closeDeadUnit(row, '周期自检：可证明失效', options);
      problems.push(`自检收口可证死行: ${key}`);
    } else if (verdict === 'unknown' && row.state !== WAITING && row.kind !== KIND_EXT) {
      problems.push(`行状态不明（仅告警）: ${key}`);
    }
  }
  problems.push(...selfcheck(probe, options));     // 纯报告项并入（含 I1 违约）
  return problems;
}

/**
 * 回收 `wait_items` 终态行（P6，裁决 R14；waitq.py:950）：done/failed/cancelled 且
 * `ended_at` 距今超 keepSec 秒 → 删；活跃行不动。返回删除条数。
 *
 * 量级小、口径保守（默认 86400s）；挂进 `runner.start_unit_selfcheck` 周期尾部（蹭既有
 * 线程，零新线程）。终态行只承载审计/排查看板，超窗删除不影响任何拾取/位次口径（读侧
 * 全部只认活跃行）。
 *
 * @param {number} [keepSec]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 删除条数
 */
export function pruneFinished(keepSec = PRUNE_FINISHED_KEEP_S, options = {}) {
  const cutoff = localTimeStr(Date.now() / 1000 - Number(keepSec));
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "DELETE FROM wait_items WHERE state IN ('done','failed','cancelled')"
      + ' AND ended_at IS NOT NULL AND ended_at <= ?',
    ).run(cutoff);
    return Number(info.changes);
  });
}

// --------------------------------------------------------------------------
// 写口 · 卡片等待项原子操作（waitq.py:966-1139；P4 排队态单写：设计 §9）
// --------------------------------------------------------------------------
// 落点裁决（P4 计划 R6）：路线图「board.py enqueue_card」指调用面；跨表原子只能在单连接
// 单事务内做，故实现放本模块。`board_cards` 不在三表唯一写路径禁令内（禁令只锁
// wait_items/chat_msgs 两表），本段是唯一允许写卡片占位的非 board 函数。

/**
 * 卡片的活跃 `c:` 行（无则 `null`；持连接调用——v3a 入队门禁共用读口；waitq.py:974）。
 * @param {object} handle
 * @param {string} target
 * @returns {object|null}
 */
function activeCardRowOn(handle, target) {
  const row = handle.prepare(
    'SELECT id, state, seq FROM wait_items WHERE kind=? AND target_id=?'
    + ` AND state IN (${ACTIVE_IN})`,
  ).get(KIND_CARD, target);
  return row === undefined ? null : { ...row };
}

/**
 * 卡片排队占位投影（条件写：已处 `doing+queue` 时不改写——保 answer 排队路径的空
 * block_text；否则置 `doing+queue` 并清 `scheduled_at`；waitq.py:981）。
 *
 * @param {object} handle
 * @param {string} target 卡 id（TEXT 参数，SQLite 按列亲和转整数比对）
 * @param {string} blockText
 */
function projectCardQueueOn(handle, target, blockText) {
  handle.prepare(
    "UPDATE board_cards SET column_key='doing', block_kind='queue',"
    + ' block_text=?, scheduled_at=NULL, updated_at=?'
    + " WHERE id=? AND NOT (block_kind='queue' AND column_key='doing')",
  ).run(bindable(blockText), nowStr(), bindable(target));
}

/**
 * 卡片入队单事务体（`enqueueCard` / `insertCardAfterPrefix` 共用；v3a 幂等门禁；
 * waitq.py:991）。
 *
 * 位次由调用方给定几何（`seqSql`/`seqArgs`）。返回等待项 id。已有活跃 `c:` 行 → **复用**
 * （不插第二行，位次不动）：
 *   - waiting 行：维持现状语义（复用 + 占位投影照常）；
 *   - starting/running/finishing 行（v3a：起跑证实后跨轮存活的运行行）：只复用，**不回退
 *     行态、也不写「排队等待」占位**——卡在跑而非排队，写占位会让展示与事实相反（旧口径
 *     起跑即终态化，此处撞到的是「无活跃行」，该分支是 v3a 新形态）。
 *
 * 无活跃行 → 插 waiting 行 + 占位投影（行+占位同事务，P4 单写原子红线）。并发安全：
 * INSERT 优先、活跃唯一索引兜底（撞索引=并发下已有活跃行 → 重查复用，与 `enqueue`/
 * `insertAfterPrefix` 同 idiom）。
 *
 * @param {object} handle 写连接
 * @param {string} target 卡 id 字符串
 * @param {number} projectId
 * @param {string} seqSql 位次 SQL 片段（`?` 或 `(SELECT COALESCE(MAX(seq),0)+1 …)`）
 * @param {unknown[]} seqArgs 位次片段占位参数（按序插在 target 之后）
 * @param {{extra?: string, fromColumn?: string, blockText?: string}} [opts]
 * @returns {number} 等待项 id
 */
function cardEnqueueOn(handle, target, projectId, seqSql, seqArgs, opts = {}) {
  const { extra = '', fromColumn = '', blockText = CARD_QUEUE_TEXT } = opts;
  let row = activeCardRowOn(handle, target);
  let itemId;
  if (row === null) {
    let inserted = false;
    try {
      const info = handle.prepare(
        'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
        + ` created_at, meta) VALUES (?,?,?,'waiting', ${seqSql},?,?)`,
      ).run(bindable(projectId), KIND_CARD, target, ...seqArgs.map(bindable), nowStr(),
        pyJsonDumps({
          extra: String(extra || ''),
          from_column: String(fromColumn || ''),
        }));
      itemId = Number(info.lastInsertRowid);
      inserted = true;
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      row = activeCardRowOn(handle, target);
      if (row === null) throw err;      // 非活跃唯一索引冲突：上抛，交给调用方
      itemId = row.id;
    }
    if (inserted) {                     // 照 Python 的 try/else：无异常才写占位并返回
      projectCardQueueOn(handle, target, blockText);
      return itemId;
    }
  }
  itemId = row.id;
  if (row.state === WAITING) projectCardQueueOn(handle, target, blockText);
  return itemId;
}

/**
 * 卡片入队（board 排队路径唯一写入口；waitq.py:1030）：一个事务内写 card 等待项行 +
 * `board_cards` 占位投影——「占位在、行不在 / 行在、占位不在」从结构上消失。
 *
 * 幂等门禁（v3a，I5 同一卡至多一条活跃 `c:` 行）：同类同目标已有活跃行 → 复用（同
 * `enqueue`，位次不动）；其中 waiting 行照常落占位投影，starting/running/finishing 行
 * （跨轮存活的运行行）只复用、不回退行态也不写排队占位（见 `cardEnqueueOn`）。
 * `meta={"extra": 打回意见, "from_column": 排队前列}`——打回意见随 meta 持久化（不再依赖
 * 内存暂存，重启不再丢），from_column 供起跑失败回列（P4 计划裁决 R7）。
 *
 * @param {number|string} cardId
 * @param {number} projectId
 * @param {string} [extra]
 * @param {string} [fromColumn]
 * @param {string} [blockText]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 等待项 id
 */
export function enqueueCard(cardId, projectId, extra = '', fromColumn = '',
  blockText = CARD_QUEUE_TEXT, options = {}) {
  const target = String(cardId);
  return withWriteDb(options, (handle) => cardEnqueueOn(
    handle, target, projectId,
    '(SELECT COALESCE(MAX(seq),0)+1 FROM wait_items)', [],
    { extra, fromColumn, blockText },
  ));
}

/**
 * 卡片入队「运行前缀后」（续跑/手动恢复专用写入口，v2b T2 裁决 R9；waitq.py:1049）：
 * 一个事务内写 card 等待项行（位次=前缀后/等待区最前，与 `insertAfterPrefix` 同几何
 * ——`afterPrefixSeqOn` 唯一出处）+ `board_cards` 占位投影。
 *
 * v2a 子批终审契约（绑定）：续跑切换插入点前必须先落本原子变体——行与占位分两事务会留
 * 崩溃窗口「行在、占位不在」，合法行随后被「占位失效」摘除（P4 单写原子红线）。幂等
 * （复用既有行、位次不动——重复按开始不提前）、占位条件写（保 answer 路径空 block_text）、
 * meta 持久化（extra/from_column）语义与 `enqueueCard` 逐字一致（含 v3a 幂等门禁：已有运行
 * 行只复用不回退），仅位次不同。返回等待项 id。
 *
 * @param {number|string} cardId
 * @param {number} projectId
 * @param {string} [extra]
 * @param {string} [fromColumn]
 * @param {string} [blockText]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 等待项 id
 */
export function insertCardAfterPrefix(cardId, projectId, extra = '', fromColumn = '',
  blockText = CARD_QUEUE_TEXT, options = {}) {
  const target = String(cardId);
  return withWriteDb(options, (handle) => {
    const seqNew = afterPrefixSeqOn(handle, projectId);
    return cardEnqueueOn(handle, target, projectId, '?', [seqNew],
      { extra, fromColumn, blockText });
  });
}

/**
 * force 落表（v2b T4，裁决 R12；waitq.py:1070）：一个事务内插「前缀尾」
 * （`afterPrefixSeqOn` 几何=最后一个运行中条目之后）+ **直入 starting**（out-of-band 立即
 * 启动，不经 worker 拾取）——行从不以 waiting 形态出现，结构上消除「worker 路过见 waiting
 * `c:` 行而占位失效摘除」的拾取竞态窗（force 卡无 `doing+queue` 占位，两段式 insert+claim
 * 留该窗）。起跑证实由调用方 `enterRunning`；会话结束由 `card_finished` 终态化（行即成员
 * 期间构成运行前缀、位次计入）。
 *
 * v3a 幂等门禁：已有活跃 `c:` 行 → **复用**（返回其 `[id, seq]`，行态与位次都不动）——
 * 旧口径按编程错误上抛。force 前调用方已 `cancelCardWait` 清残留，再撞=并发 force /
 * 起跑证实后的跨轮存活行，此时重复插行会撞活跃唯一索引、把行打回 starting 又会破坏「行即
 * 条目」语义。返回 `[row_id, seq_new]`。
 *
 * @param {number|string} cardId
 * @param {number} projectId
 * @param {object|null} [meta]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {[number, number]}
 */
export function insertCardForceStart(cardId, projectId, meta = null, options = {}) {
  const target = String(cardId);
  return withWriteDb(options, (handle) => {
    const row = activeCardRowOn(handle, target);
    if (row !== null) return [row.id, row.seq];
    const seqNew = afterPrefixSeqOn(handle, projectId);
    try {
      const info = handle.prepare(
        'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
        + ' created_at, claimed_at, claimed_by, meta)'
        + " VALUES (?,?,?,'starting',?,?,?,'force',?)",
      ).run(bindable(projectId), KIND_CARD, target, seqNew, nowStr(), nowStr(),
        pyJsonDumps(meta || {}));
      return [Number(info.lastInsertRowid), seqNew];
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      const again = activeCardRowOn(handle, target);
      if (again === null) throw err;    // 非活跃唯一索引冲突：上抛，交给调用方
      return [again.id, again.seq];
    }
  });
}

/**
 * 卡片出队（board 取消路径唯一写入口；waitq.py:1104）：一个事务内取消 card 等待项行 +
 * 清占位投影。双侧 rowcount 守卫：行已终态、或占位已被调用方改写（如 `move_card` 先落了
 * manual 阻塞）则对应侧 no-op——不复活、不覆盖新状态。返回等待项是否命中取消（占位清除
 * 与否不影响返回值）。
 *
 * @param {number|string} cardId
 * @param {string} [reason]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function cancelCardWait(cardId, reason = '', options = {}) {
  const target = String(cardId);
  return withWriteDb(options, (handle) => {
    const row = handle.prepare(
      'SELECT id, meta FROM wait_items WHERE kind=? AND target_id=?'
      + ` AND state IN (${ACTIVE_IN})`,
    ).get(KIND_CARD, target);
    let hit = false;
    if (row !== undefined) {
      const info = handle.prepare(
        "UPDATE wait_items SET state='cancelled', ended_at=?"
        + ` WHERE id=? AND state IN (${ACTIVE_IN})`,
      ).run(nowStr(), row.id);
      if (Number(info.changes) === 1) {
        hit = true;
        if (reason) mergeMetaOn(handle, row, { cancel_reason: reason });
      }
    }
    handle.prepare(
      "UPDATE board_cards SET block_kind=NULL, block_text=''"
      + " WHERE id=? AND block_kind='queue'",
    ).run(bindable(target));
    return hit;
  });
}

/**
 * 仅写占位投影（answer 排队路径专用：等待单元是 answer 行，不建 card 行；waitq.py:1131）。
 * 无条件置 `doing+queue`（与原作答排队分支语义等价；仅 `done_at` 不清这一不可达态差异
 * ——原分支同样不清，列归位由送达执行体兜底）。
 *
 * @param {number|string} cardId
 * @param {string} [blockText]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {void}
 */
export function setCardWaitPlaceholder(cardId, blockText = '', options = {}) {
  return withWriteDb(options, (handle) => {
    handle.prepare(
      "UPDATE board_cards SET column_key='doing', block_kind='queue',"
      + ' block_text=?, updated_at=? WHERE id=?',
    ).run(bindable(blockText), nowStr(), String(cardId));
  });
}

// --------------------------------------------------------------------------
// 写口 · 外部条目 ext 行（waitq.py:1142-1171；v2d T4，裁决 R13）
// --------------------------------------------------------------------------

/**
 * 外部条目落表（waitq.py:1144）：单事务插「运行前缀尾」（`afterPrefixSeqOn` 几何=最后一个
 * 运行中条目之后）+ **直入 running**——外部直跑会话不由平台启动，入场即视为在运行（行即
 * 成员构成运行前缀、位次计入「前面还有几个」；v2 §2.2【已定】）。
 *
 * target=看板卡 id、meta 带 sid；claimed_at 留空（无平台认领——selfcheck 的活跃态超龄无
 * 证据判据只覆盖被 claim 过的行，外部条目不算泄漏）。复数并存（多外部会话各自一行）；并发
 * 安全：INSERT 优先、活跃唯一索引兜底——撞活跃唯一索引说明并发下已有活跃行（`upsert_ext`
 * 的 check-then-insert 窗口），重查复用其行（与 `enqueue`/`insertAfterPrefix` 同 idiom）；
 * 其他冲突仍上抛。返回 `[row_id, seq_new]`。
 *
 * @param {number} projectId
 * @param {number|string} cardId
 * @param {string} [sid]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {[number, number]}
 */
export function insertExt(projectId, cardId, sid = '', options = {}) {
  const target = String(cardId);
  return withWriteDb(options, (handle) => {
    try {
      const seqNew = afterPrefixSeqOn(handle, projectId);
      const info = handle.prepare(
        'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
        + ' created_at, meta)'
        + " VALUES (?,?,?,'running',?,?,?)",
      ).run(bindable(projectId), KIND_EXT, target, seqNew, nowStr(),
        pyJsonDumps({ sid: String(sid || '') }));
      return [Number(info.lastInsertRowid), seqNew];
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      const row = handle.prepare(
        'SELECT id, seq FROM wait_items WHERE kind=? AND target_id=?'
        + ` AND state IN (${ACTIVE_IN})`,
      ).get(KIND_EXT, target);
      if (row === undefined) throw err;   // 非活跃唯一索引冲突：上抛，交给调用方
      return [row.id, row.seq];
    }
  });
}

// --------------------------------------------------------------------------
// 消息（chat_msgs）读写（waitq.py:1174-1342）
// --------------------------------------------------------------------------
// 会话消息的状态权威（chat 内存登记转正）；chat_msgs.state 用消息侧口径
// queued|running|done|error|cancelled，与 wait_items.state（waiting|starting|…）分属两套
// 状态机：等待项管「队列拾取互斥」，消息行管「用户可见生命周期」。

/**
 * 会话消息入队（`chat.submit` 专用写入口；waitq.py:1179）：一个事务内写 chat_msgs 行
 * （`state=queued`，毫秒 epoch 时间戳）+ msg 等待项行（meta 携带执行体重建载荷
 * ——family/model 提交时快照与 comment_id，见 P3 计划裁决 R1）。
 *
 * `queue=false`（P5 R13）：跳过等待项行、只写 chat_msgs——runner 单例缺位的同步路径专用
 * （消息不经队列、无拾取方，等待项只会成为无人认领的孤儿行）。
 *
 * msg_id 主键保证唯一（同 id 重复提交视为编程错误，约束错上抛）；「先写行后补内存键」
 * 纪律由调用方保证（`chat.submit` 先本函数再 `inst.submit_msg`）。位次（2026-09-25 对齐
 * v2 §2.2）：等待项落「最后一个运行中条目之后」且排在同项目已排队用户动作行（`m:`/`a:`）
 * 之后（`msgInsertSeqOn` 几何）——不再是全局队尾 `MAX(seq)+1`；消息优先于等待区卡片/任务，
 * 同项目消息间保持到达序 FIFO。
 *
 * @param {string} msgId
 * @param {number} projectId
 * @param {string} sid
 * @param {string} message
 * @param {number|null} [taskId]
 * @param {number|null} [cardId]
 * @param {boolean} [inject]
 * @param {object|null} [meta]
 * @param {boolean} [queue] false = 只写 chat_msgs、不建等待项
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number|null} 等待项 id（`queue=false` 时 null）
 */
export function msgEnqueue(msgId, projectId, sid, message, taskId = null, cardId = null,
  inject = false, meta = null, queue = true, options = {}) {
  const nowMs = Date.now();
  return withWriteDb(options, (handle) => {
    handle.prepare(
      'INSERT INTO chat_msgs (id, project_id, sid, task_id, card_id,'
      + ' message, state, error, inject, created_at)'
      + " VALUES (?,?,?,?,?,?,'queued','',?,?)",
    ).run(String(msgId), bindable(projectId), bindable(sid), bindable(taskId),
      bindable(cardId), bindable(message), inject ? 1 : 0, nowMs);
    if (!queue) return null;
    const seqNew = msgInsertSeqOn(handle, projectId);
    const info = handle.prepare(
      'INSERT INTO wait_items (project_id, kind, target_id, state, seq,'
      + ' created_at, meta)'
      + " VALUES (?,?,?,'waiting',?,?,?)",
    ).run(bindable(projectId), KIND_MSG, String(msgId), seqNew, nowStr(),
      pyJsonDumps(meta || {}));
    return Number(info.lastInsertRowid);
  });
}



/**
 * 按 id 取消息行（无则 null；终态未回收也算——注入端点归属校验依赖）。
 *
 * 空 id（`''`/null/undefined）返回 null（照 Python `if not msg_id`）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object|null}
 */
export function msgGet(msgId, options = {}) {
  return withReadDb(options, (handle) => msgGetOn(handle, msgId));
}

/** `msgGet` 的持连接版本 */
function msgGetOn(handle, msgId) {
  if (!msgId) return null;
  return plainRow(handle.prepare('SELECT * FROM chat_msgs WHERE id=?')
    .get(bindable(String(msgId))));
}

/**
 * 消息等待项 meta（取该 target 的**最后一行**，含终态行）：飞书回流钩子在终态收口
 * 之后读「提交时定格」的载荷（feishu 命名空间）。无行返回 `{}`，坏 JSON 亦 `{}`。
 *
 * 只读口：口径上不看 state（收口已把行落终态，活跃口径读不到），也不 join
 * chat_msgs——载荷只在等待项行上（chat_msgs 无 meta 列）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object}
 */
export function msgMeta(msgId, options = {}) {
  return withReadDb(options, (handle) => msgMetaOn(handle, msgId));
}

/** `msgMeta` 的持连接版本 */
function msgMetaOn(handle, msgId) {
  const row = handle.prepare(
    'SELECT meta FROM wait_items WHERE kind=? AND target_id=? ORDER BY id DESC LIMIT 1',
  ).get(KIND_MSG, bindable(String(msgId)));
  if (row === undefined) return {};
  let meta;
  try {
    meta = JSON.parse(row.meta || '{}');
  } catch {
    return {};                           // 坏 JSON 按空对象（Python ValueError 分支）
  }
  // Python 侧非 dict 的 JSON（如 `[]`/`3`）也会原样返回；这里对齐成「非对象即空」
  // 是**有意收紧**：调用方一律 `meta.get(...)`，Node 侧非对象取属性会静默给 undefined
  // 而不报错——收紧成 {} 让两侧同为「读不到键」。
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta;
}

/**
 * 消息行查询（chat 读侧专用）：sid/cardId/states 可选过滤，`created_at, id` 升序。
 *
 * `states` 传数组（Python 传元组）；空数组/未传 = 不过滤（照 Python `if states:`）。
 * 同毫秒按 id tie-break（P4 必带⑥）。
 *
 * @param {{sid?: string|null, cardId?: number|string|null, states?: string[]|null}} [opts]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接（`db.js` 读路径契约；见 `db.js`）
 * @returns {object[]}
 */
export function msgRows({ sid = null, cardId = null, states = null } = {}, options = {}) {
  let sql = 'SELECT * FROM chat_msgs WHERE 1=1';
  const args = [];
  if (sid !== null && sid !== undefined) {
    sql += ' AND sid=?';
    args.push(sid);
  }
  if (cardId !== null && cardId !== undefined) {
    sql += ' AND card_id=?';
    args.push(cardId);
  }
  if (states && states.length) {
    sql += ` AND state IN (${states.map(() => '?').join(',')})`;
    args.push(...states);
  }
  sql += ' ORDER BY created_at, id';     // 同毫秒按 id tie-break
  return withReadDb(options, (handle) => plainRows(handle.prepare(sql).all(...args.map(bindable))));
}

/**
 * 有**排队中**消息的卡片 id 集合（`waitq.py:1261` msg_queued_card_ids；看板「排队中」
 * 徽标批量数据源）。仅 `state='queued'` 且 `card_id` 非空。
 *
 * 元素是 **number**（照 Python：`{r["card_id"] for r in …}`，列为 INTEGER）。
 * M3 时本函数落在 `chat.js:queuedCardIds` 且返回**字符串**集合（调用方 `board.js`
 * 用 `has(String(id))` 自洽，因此 HTTP 层看不出差异）；M4 归位到这里并改回 int——
 * 「值即契约」：`chat.queued_card_ids()` 在 Python 里正是本函数的直通壳
 * （`chat.py:438`），Node 侧同样让 `chat.queuedCardIds` 委托本函数（保留导出名，
 * 兼容 M3 的 `board.js` 调用面）。
 *
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {Set<number>}
 */
export function msgQueuedCardIds(options = {}) {
  return withReadDb(options, (handle) => {
    const out = new Set();
    for (const row of handle.prepare(
      "SELECT DISTINCT card_id FROM chat_msgs WHERE state='queued' AND card_id IS NOT NULL",
    ).all()) {
      if (row.card_id === null || row.card_id === undefined) continue;
      out.add(Number(row.card_id));
    }
    return out;
  });
}

/**
 * `queued → running`（原子守卫；`started_at`=毫秒；waitq.py:1269）。worker 执行体与
 * `inject_now` 的状态迁移点（队列级互斥另有等待项 `claim`，两层守卫互补）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function msgClaim(msgId, options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE chat_msgs SET state='running', started_at=?"
      + " WHERE id=? AND state='queued'",
    ).run(Date.now(), String(msgId));
    return Number(info.changes) === 1;
  });
}

/**
 * `running → queued`（`inject_now` 投递失败退回；`started_at` 清零，同原内存语义；
 * waitq.py:1280）。
 *
 * @param {string} msgId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function msgRequeue(msgId, options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE chat_msgs SET state='queued', started_at=NULL"
      + " WHERE id=? AND state='running'",
    ).run(String(msgId));
    return Number(info.changes) === 1;
  });
}

/**
 * `running → done/error`（执行体终态；`ended_at`=毫秒；error 截 300 字与原内存一致；
 * waitq.py:1289）。
 *
 * @param {string} msgId
 * @param {string} state `done` 或 `error`
 * @param {string} [error]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function msgFinish(msgId, state, error = '', options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      'UPDATE chat_msgs SET state=?, error=?, ended_at=?'
      + " WHERE id=? AND state='running'",
    ).run(state, truncateChars(error, 300), Date.now(), String(msgId));
    return Number(info.changes) === 1;
  });
}

/**
 * `queued → cancelled`（用户取消；queued 守卫＝与 worker claim 的仲裁点；waitq.py:1299）。
 *
 * @param {string} msgId
 * @param {string} [error]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function msgCancel(msgId, error = '已取消', options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE chat_msgs SET state='cancelled', error=?, ended_at=?"
      + " WHERE id=? AND state='queued'",
    ).run(bindable(error), Date.now(), String(msgId));
    return Number(info.changes) === 1;
  });
}

/**
 * `queued/running → error`（recover 专用；waitq.py:1309）：msg 重发非幂等，starting 不放回
 * waiting 只记败（P3 计划裁决 R3；error 经 `msgs_of_sid` 下发前端）。
 *
 * @param {string} msgId
 * @param {string} [error]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function msgRecoverFail(msgId, error = '服务重启中断', options = {}) {
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "UPDATE chat_msgs SET state='error', error=?, ended_at=?"
      + " WHERE id=? AND state IN ('queued','running')",
    ).run(bindable(error), Date.now(), String(msgId));
    return Number(info.changes) === 1;
  });
}

/**
 * 回收终态消息行（chat 内存版等价迁移；`chat.submit` 调用；waitq.py:1320）：
 *   ① 终态（done/error/cancelled/yielded）且 `ended_at` 距今超 keepSec 秒 → 删；
 *   ② 总行数超 maxRows → 按终态时间从旧到新删多余（活跃行不删）。
 * 等待项终态行不在本函数范围，由 `pruneFinished` 回收（P6，R14）。
 *
 * @param {number} keepSec
 * @param {number} maxRows
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number} 删除条数
 */
export function msgPrune(keepSec, maxRows, options = {}) {
  const nowMs = Date.now();
  let n = 0;
  return withWriteDb(options, (handle) => {
    const info = handle.prepare(
      "DELETE FROM chat_msgs WHERE state IN"
      + " ('done','error','cancelled','yielded')"
      + ' AND ended_at IS NOT NULL AND ended_at <= ?',
    ).run(nowMs - Number(keepSec) * 1000);
    n += Number(info.changes);
    const extra = Number(handle.prepare('SELECT COUNT(*) n FROM chat_msgs').get().n)
      - Number(maxRows);
    if (extra > 0) {
      const ids = handle.prepare(
        "SELECT id FROM chat_msgs WHERE state IN"
        + " ('done','error','cancelled','yielded')"
        + ' ORDER BY ended_at LIMIT ?',
      ).all(extra).map((r) => r.id);
      const del = handle.prepare('DELETE FROM chat_msgs WHERE id=?');
      for (const id of ids) del.run(bindable(id));
      n += ids.length;
    }
    return n;
  });
}
