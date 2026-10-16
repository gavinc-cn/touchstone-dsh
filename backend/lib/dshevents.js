/**
 * dsh 状态事件中枢（`dshevents.py` 532 行的 Node 对应物，Node 后端 M2 第四块）。
 *
 * 一条 SSE 连接订阅插件的全局状态流（`GET /touchstone-agent/events?scope=state`），把状态帧
 * 折进进程内的实时态注册表，并唤醒订阅者（看板调和器、server 的 SSE 广播等）。
 *
 * **不变量（方案 §3.4；Python 模块头逐条照抄，改代码前必读）**：
 *
 *   1. **断连 = 未知**：链路断开时 `connected()` 为 false，`get()` 一律返回 `null`——绝不把
 *      「读不到」推断成 `idle`。调用方（看板调和器）按「未知则保持现状」处置。归档集同理：
 *      断连时 `archived()`/`archivedSet()` 返回 `null`（未知），看板不得据此搬列。
 *   2. **重连只做一次对齐**：重连带 `since=<last_seq>` 续传环内帧，补发结束后再做**一次**
 *      `/live` 快照对齐 + **一次** `/archived` 归档集对齐，此后纯事件驱动（静置期零请求）。
 *   3. **快照可信判定**：非空快照 = 权威整表；空快照只有插件声明 `complete === true` 才算
 *      权威空，否则「保留旧表 + `aligned()===false`」（热重载后驱动实例重建的已知形态，见
 *      `doc_ai/bug_report/20261008_1935_*`）。`aligned()` = 在线 ∧ 可信：false ⇒ 一律不据
 *      实况写列；true ⇒ 会话不在注册表才可判「已结束」。
 *   4. **注册表是缓存不是权威**：权威仍是 dsh 会话本身与平台 DB；丢帧/漂移由下一次对齐兜底。
 *
 * ── Python 名 ↔ Node 名（导出面） ─────────────────────────────────────────────────────
 *   方法/函数一律 camelCase；**数据字段与 `stats()` 的键逐字保持 Python 原样**（snake_case），
 *   因为它们是跨语言契约的一部分（注册表条目直接替换 board 的 dsh 状态读口）：
 *
 *     Python（模块级 / 方法）                 Node
 *     dshevents.EventHub                     EventHub
 *     dshevents.HUB                          HUB
 *     start()                                start()                        （同步，返回 boolean）
 *     stop(timeout=2.0)                      stop(timeoutMs=2000)           （异步，返回 Promise）
 *     connected() / aligned()                connected() / aligned()
 *     get(sid)                               get(sid)
 *     session_effort(sid)                    sessionEffort(sid)             （同时是 EventHub 方法）
 *     session_permission_mode(sid)           sessionPermissionMode(sid)     （同时是 EventHub 方法）
 *     snapshot()                             snapshot()
 *     archived(sid) / archived_set()         archived(sid) / archivedSet()
 *     stats()                                stats()
 *     wait(timeout)                          wait(timeoutMs)                → Promise<boolean>
 *     wait_connected(timeout)                waitConnected(timeoutMs)       → Promise<boolean>
 *     subscribe(cb) / unsubscribe(cb)        subscribe(cb) / unsubscribe(cb)
 *     _run / _align / _on_frame              _run / _align / _onFrame
 *     _set_connected / _set_aligned          _setConnected / _setAligned
 *     _merge_permission(live, old)           mergePermission(live, old)     （模块私有，不导出）
 *     RECONNECT_MIN=1.0 / RECONNECT_MAX=10.0 同名同值（秒）
 *     STREAM_IDLE=60.0                       同名同值（秒）；构造参数 streamIdleMs 用毫秒
 *
 *   注册表条目字段（`get()`/`snapshot()`）：`session_id/status/cwd/task/owned/origin/
 *   interaction/last_turn_reason/last_seq/usage/model/permission/inbox/updated_at`；
 *   `stats()` 键：`connected/sessions/aligned/last_seq/frames/reconnects/changed/archived/thread`。
 *
 * ── 与 Python 的语义差异（逐条，均为形态差异或已注明的实现选择） ──────────────────────
 *   ① **异步**：`_run`/`_align`/`stop`/`wait`/`waitConnected` 全返回 Promise（Python 用线程 +
 *      条件变量阻塞）；`_onFrame`/`_setConnected`/`_setAligned` 仍是同步方法（SSE 回调里跑）。
 *      调用方必须 `await`；`start()` 保持同步（只读一次 `configured()` 并起后台循环）。
 *   ② **等待口 Promise 化**：Python `wait(timeout)` / `wait_connected(timeout)` 阻塞在
 *      `threading.Condition` 上；Node 用「等待者集合 + 定时器」：`wait` 在**变更**时 resolve
 *      true、超时（或 `stop()` 的唤醒）resolve false——与 Python 的 `_changed != before` 同口径；
 *      `waitConnected` 就绪 resolve true、超时 false（迟到连接会立刻唤醒，不等满超时）。
 *   ③ **订阅口**：Python `subscribe(cb)` 返回 `cb`、配套 `unsubscribe(cb)`；Node `subscribe(cb)`
 *      返回**退订函数** `() => unsubscribe(cb)`，**同时**导出 `unsubscribe(cb)` 以对齐 Python
 *      调用点（两种写法都可用，见测试「订阅者」一节）。
 *   ④ **退避口径＝Python 的实际行为（恒为基数 1s，不翻倍）**：Python `_run` 的
 *      `finally: backoff = RECONNECT_MIN`（`dshevents.py:240-241`）在 `except` 分支的
 *      `continue` 上也会执行 ⇒ 翻倍被立刻复位，**实测每次重连前都是 1.0s**；docstring 的
 *      「1s→10s 封顶」是落空的意图，属 **Python 侧待议缺陷——要改就两侧一起改**，M2 冻结期
 *      不在 Node 单侧「顺手改进」（方案 §十一 红线 3：两版行为必须等价）。故本文件每次重连
 *      尝试前 sleep 基数，`RECONNECT_MAX` 仍导出以对照 Python 常量但**不参与计算**。退避等待
 *      不发请求，且可被 `stop()` 打断（Node 形态差异，不改变间隔口径）。
 *   ⑤ **线程语义**：`stats().thread` = 消费循环是否在跑（`_running`）；`stop(timeoutMs)` 最多等
 *      这么久（Node 不能阻塞事件循环，故返回 Promise）。`stop()` 会唤醒 `wait`/`waitConnected`/
 *      退避睡眠的等待者（对齐 Python `notify_all()` 的唤醒效果），并**无条件复位运行标记**
 *      （对齐 Python `stop()` 末尾的 `self._thread = None`：超时也允许立刻 `start()`）。重启
 *      安全靠**代际号**：旧循环只认自己那一代，既不会再建流（`_run` 在对齐落地后复核 stop，
 *      消除 stop 后的 `connected=true` 抖动），也不会清掉新循环的在线态（旧代不得与新代并行消费）。
 *   ⑥ **错误类型**：内部「流结束（对端关闭）」用普通 `Error` 抛出（不额外 import
 *      `DshDriverError`；该异常与本文件其余一切异常同路：断连 → 退避 → 重连）。
 *   ⑦ **宽容读**：非对象行/非数值字段按缺省跳过或归零（Python 会抛 `AttributeError`/`ValueError`
 *      并因此走重连）；正常帧形状下两者逐字一致。
 *   ⑧ **集合类型**：Python `set` → Node `Set`；`archivedSet()` 返回副本（修改副本不影响内部）。
 *   ⑨ **日志**：`[dshevents] …` 留痕走 `console.log`（Python 是 `print(..., flush=True)`），
 *      文案逐字相同——插件形态下由薄壳落 `<库目录>/plugin-backend.log`。
 *
 * 只 import `dshdriver.js` 的五个冻结导出：`configured` / `liveSnapshot` / `archived` /
 * `stateStream` / `PRESET_MODES`（最后一个承载 `session_permission_mode` 的 preset→三档反查，
 * Python 侧用的就是 `dshdriver.PRESET_MODES`；`driverUrl`/`authHeaders` 由 dshdriver 内部使用，
 * 本文件不直接调）。契约测试见 `backend/test/dshevents.test.mjs`。
 */
import {
  PRESET_MODES,
  archived as driverArchived,
  configured as driverConfigured,
  liveSnapshot as driverLiveSnapshot,
  stateStream as driverStateStream,
} from './dshdriver.js';

// ---------- 常量（同名同值，单位秒；毫秒口径走构造参数） ----------

/**
 * 重连退避基数（秒）：每次重连尝试前等待这么久；退避等待不发请求。
 *
 * ⚠️ Python 的 `RECONNECT_MAX` 翻倍逻辑实际被 `_run` 的 `finally` 复位吃掉（见文件头差异 ④），
 * 故**有效间隔恒为该基数**；上游 docstring 的「首次 1s，翻倍到 10s 封顶」是落空的意图。
 */
export const RECONNECT_MIN = 1.0;
/** 重连退避上限（秒）：与 Python 同名同值导出**仅供对照**，本实现不参与计算（口径见上） */
export const RECONNECT_MAX = 10.0;
/** 读空闲上限（秒）：插件每 15s 发一次 keepalive 注释帧，这里放宽到 4 倍留抖动余量 */
export const STREAM_IDLE = 60.0;

// ---------- 小工具（逐条对齐 Python 表达式） ----------

/** Python `str(x or "")`：假值（null/undefined/""/0/false）一律得空串，其余转字符串 */
function textOr(value) {
  return value ? String(value) : '';
}

/** Python `int(x)` 的宽容版：可转数值则截断取整，否则 0（Python 抛 ValueError ⇒ 走重连） */
function pyInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** `obj` 是普通对象才认；数组/标量/空一律当空对象（对齐 `isinstance(x, dict)`） */
function objectOr(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** 自身属性判定：挡下 `toString` 这类原型键（对齐 Python dict 的缺失语义） */
function hasOwn(obj, key) {
  return obj !== null && typeof obj === 'object'
    && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Python `row.get(key, fallback)`：键存在即取该值（含 null），缺失才回落 fallback */
function getWithDefault(obj, key, fallback) {
  return hasOwn(obj, key) ? obj[key] : fallback;
}

/** `x or []` 的数组口径：非数组一律空表（正常帧恒为数组） */
function arrayOr(value) {
  return Array.isArray(value) ? value : [];
}

/** Python 的 `time.time()`（秒，浮点）——`updated_at` 与之同口径 */
function nowSec() {
  return Date.now() / 1000;
}

/**
 * 权限折叠（`/live` 对齐用，对齐 Python `_merge_permission`）：preset 以宿主实况为准，
 * mode 以平台记下的为准。两者缺一都可能（mode 只有平台切过才有、preset 回读可能为空）——
 * 任一有值就保留一项，都空返回 `null`（＝未知）。
 */
function mergePermission(live, old) {
  const row = objectOr(live);
  const prev = objectOr(old);
  const preset = textOr(row.preset || prev.preset || '');
  const mode = textOr(row.mode || prev.mode || '');
  if (!preset && !mode) return null;
  return { mode, preset };
}

/** 宿主 preset → 平台三档反查（对齐 `dshdriver.PRESET_MODES.get(key, "")`，缺省空串＝未知） */
function presetMode(preset) {
  return hasOwn(PRESET_MODES, preset) ? String(PRESET_MODES[preset]) : '';
}

/** 有限 ms 的等待（`stop()` 的超时用；Promise 竞争，超时后不取消原 Promise） */
function raceTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms)) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), Math.max(0, ms));
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

// ---------- 中枢 ----------

/**
 * dsh 全局状态流的单连接消费器 + 进程内实时态注册表（对齐 `dshevents.EventHub`）。
 *
 * 构造参数只服务测试与运行期调参（Python 侧靠 monkeypatch 模块常量）：
 *   `reconnectMinMs`  重连退避基数（缺省 1000；口径＝恒基数，见文件头差异 ④）
 *   `streamIdleMs`    状态流空闲超时（缺省 60000）
 */
export class EventHub {
  constructor({
    reconnectMinMs = RECONNECT_MIN * 1000,
    streamIdleMs = STREAM_IDLE * 1000,
  } = {}) {
    this._reconnectMinMs = Math.max(0, Number(reconnectMinMs));
    this._streamIdleMs = Math.max(0, Number(streamIdleMs));
    this._sessions = new Map();       // sid -> 实时态（字段见文件头；插入序＝快照序）
    // 宿主归档集（看板「已完成」双向同步）：null=未知（断连/未对齐），Set=已知整表。
    this._archived = null;
    this._connected = false;
    // 快照对齐是否**可信**：只有「(重)连时拿到过权威快照」才置 true；
    // 空快照且插件未声明完整时保留旧表但置 false（见 `_align`）。
    this._aligned = false;
    this._lastSeq = 0;
    this._frames = 0;
    this._reconnects = 0;
    this._changed = 0;               // 变更计数（测试/诊断用；每次变更 +1）
    this._subscribers = [];
    this._waiters = new Set();       // wait() 的等待者
    this._connWaiters = new Set();   // waitConnected() 的等待者
    this._sleeps = new Set();        // 退避睡眠（可被 stop() 打断）
    this._running = false;           // 消费循环是否在跑（stats().thread）
    this._runPromise = null;         // 消费循环的 Promise（stop() 等它收尾）
    this._gen = 0;                   // 循环代际号：每次 start() +1（旧循环只认自己那一代）
    this._stop = false;
  }

  // ---------- 生命周期 ----------

  /**
   * 启动消费循环（幂等）。未配置驱动（独立形态）时不起循环，返回 false（对齐 Python `start`）。
   *
   * Node 侧「起后台循环」＝挂一个 Promise，故本方法是**同步**的：返回是否真的起了循环。
   * 每次调用发放一个**代际号**：`stop()` 超时返回后若立刻再 `start()`（对齐 Python 的
   * `self._thread = None` 语义），旧循环仍在收尾——它只认自己那一代，不会覆盖新循环状态，
   * 也不会再建流（见 `_run`）。
   */
  start() {
    if (!driverConfigured()) return false;
    if (this._running) return false;
    this._gen += 1;
    const gen = this._gen;
    this._stop = false;
    this._running = true;
    const done = () => {
      // 只清理「自己仍是当前那一代」的状态：stop() 超时后立刻重启的场景里，
      // 旧循环收尾不得把新循环的 `_running`/`_runPromise` 清掉
      if (this._gen === gen) {
        this._running = false;
        this._runPromise = null;
      }
    };
    this._runPromise = this._run(gen).then(done, done);
    return true;
  }

  /**
   * 停消费循环（退出/测试用）：置标志 + 唤醒所有等待者 + 打断退避睡眠，最多等 `timeoutMs`。
   *
   * 与 Python `stop(timeout=2.0)` 同口径（超时后不再等，且**无条件**复位运行标记——
   * Python 是 `self._thread = None`）：超时返回后立刻 `start()` 必须可用；若旧循环仍在收尾，
   * 它因代际号不匹配而不会覆盖新循环（见 `start`/`_run`）。Node 不能阻塞事件循环 ⇒ 返回 Promise。
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async stop(timeoutMs = 2000) {
    this._stop = true;
    this._wakeWaiters();        // 对齐 notify_all：wait() 被唤醒但值未变 ⇒ resolve false
    this._wakeConnWaiters();
    this._wakeSleeps();         // Node 增补：退避睡眠可打断（Python 的 join 只能干等）
    const run = this._runPromise;
    if (run !== null) await raceTimeout(run, timeoutMs);
    // 无条件复位（对齐 Python `stop()` 末尾的 `self._thread = None`）：**超时也允许立刻重启**。
    this._running = false;
    this._runPromise = null;
  }

  // ---------- 读口（全部本地、无网络） ----------

  /** 链路是否在线（false ⇒ 所有状态读口返回 null＝未知） */
  connected() {
    return this._connected;
  }

  /**
   * 注册表是否**可信**（= 链路在线 ∧ 曾用插件权威快照对齐过）。
   *
   * false ⇒ 一律不据实况写列（未知 ≠ 空闲，同「断连=未知」不变量）；
   * true ⇒ 会话不在注册表即可判「已结束」（`board._iw_once` 的补口）。
   */
  aligned() {
    return Boolean(this._connected && this._aligned);
  }

  /**
   * 单会话实时态；未连接、sid 为空或未知会话返回 `null`（＝未知，不是空闲）。
   *
   * 返回浅拷贝（对齐 Python `dict(item)`）：改顶层字段不影响内部注册表。
   *
   * @param {string} sid
   */
  get(sid) {
    if (!sid) return null;
    if (!this._connected) return null;
    const item = this._sessions.get(String(sid));
    return item ? { ...item } : null;
  }

  /**
   * 会话当前**思考等级**（宿主 reasoningEffort，取不到返回空串）。
   *
   * 数据源＝注册表里 `model` 项（`driver/model` / `driver/attached` 帧折入）。读不到
   * （未连接/未见过该会话）返回 `''`，调用方按「未知」处理，不猜。
   *
   * @param {string} sid
   */
  sessionEffort(sid) {
    const st = this.get(sid) || {};
    const model = st.model || {};
    return textOr(model.reasoningEffort || '');
  }

  /**
   * 会话当前**权限档**（平台三档 manual/yolo/auto，取不到返回空串）。
   *
   * 平台切过的 `mode` 优先（宿主 preset 到三档是多对一，只有 mode 能区分 yolo/auto）；
   * 没有 mode 时按宿主 preset 反查近似档位（外部直跑后接管的会话）。两者皆无返回 `''`。
   *
   * @param {string} sid
   */
  sessionPermissionMode(sid) {
    const st = this.get(sid) || {};
    const perm = st.permission || {};
    const mode = textOr(perm.mode || '');
    if (mode) return mode;
    return presetMode(textOr(perm.preset || ''));
  }

  /** 全部已知会话的实时态快照（未连接时返回 `{}`；值为浅拷贝） */
  snapshot() {
    if (!this._connected) return {};
    const out = {};
    for (const [sid, item] of this._sessions) {
      // 走 defineProperty 而不是 `out[sid] = …`：sid 是外部字符串，`__proto__` 这类键
      // 直接赋值会改原型而不是加属性（Python dict 无此坑）
      Object.defineProperty(out, sid, {
        value: { ...item }, enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }

  /**
   * 会话是否被宿主归档（True/False；**未知返回 `null`**：未连接、尚未对齐、sid 为空）——
   * 调用方按「未知不动作」处置，绝不把读不到当成「未归档」。
   *
   * @param {string} sid
   */
  archived(sid) {
    if (!sid) return null;
    if (this._archived === null) return null;
    return this._archived.has(String(sid));
  }

  /** 归档集副本（未知返回 `null`）；整表口径，供批量对账（如「done 卡绑定会话」扫描） */
  archivedSet() {
    return this._archived === null ? null : new Set(this._archived);
  }

  /** 诊断信息（`/api` 健康与测试断言用；键与 Python 逐字相同） */
  stats() {
    return {
      connected: this._connected,
      sessions: this._sessions.size,
      aligned: Boolean(this._connected && this._aligned),
      last_seq: this._lastSeq,
      frames: this._frames,
      reconnects: this._reconnects,
      changed: this._changed,
      archived: this._archived === null ? null : this._archived.size,
      thread: this._running,
    };
  }

  // ---------- 订阅（推变更；回调在消费循环里跑，必须短小） ----------

  /**
   * 注册变更回调，返回**退订函数**（Node 形态；Python 返回 `callback` 本体）。
   * 配套的 `unsubscribe(cb)` 同时导出，两种写法等价。
   *
   * 回调收到**原始帧**；回调抛异常被吞（不影响消费与其他订阅者）。
   *
   * @param {(frame: object) => void} callback
   * @returns {() => void}
   */
  subscribe(callback) {
    this._subscribers.push(callback);
    return () => this.unsubscribe(callback);
  }

  /** 退订（重复退订/退订未注册的回调静默——对齐 Python 吞 `ValueError`） */
  unsubscribe(callback) {
    const idx = this._subscribers.indexOf(callback);
    if (idx >= 0) this._subscribers.splice(idx, 1);
  }

  /**
   * 等一次变更：变更 resolve `true`（事件到达即醒），超时 resolve `false`。
   *
   * 看板调和器的驱动口：醒后读的是**本地注册表**（不是远端状态）——超时只作对账兜底。
   * `timeoutMs` 省略/非有限值＝一直等（对齐 Python 的条件变量 `wait(None)`）。
   * `stop()` 的唤醒不算变更 ⇒ resolve `false`（对齐 Python `_changed != before` 口径）。
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  wait(timeoutMs) {
    const before = this._changed;
    return new Promise((resolve) => {
      const entry = { before, resolve, timer: null };
      const ms = Number(timeoutMs);
      if (Number.isFinite(ms)) {
        entry.timer = setTimeout(() => this._settleWaiter(entry), Math.max(0, ms));
      }
      this._waiters.add(entry);
    });
  }

  /**
   * 等（首）次连接就绪：就绪 resolve `true`，超时 resolve `false`。
   *
   * 启动补跑用（server 在 `start()` 之后等它就绪，再对账 ext 行）——未配置驱动/宿主不可达时
   * 至多等满 `timeoutMs`；**绝不把「未连接」当成就绪**（不变量 1）。
   *
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  waitConnected(timeoutMs) {
    if (this._connected) return Promise.resolve(true);
    const limit = Math.max(0, Number(timeoutMs) || 0);
    const deadline = Date.now() + limit;
    return new Promise((resolve) => {
      const entry = {
        resolve,
        timer: null,
        // 唤醒/到期复核：已连接 ⇒ true；剩余时间为 0 ⇒ false；否则续等剩余时间
        check: () => {
          if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          if (this._connected) {
            this._connWaiters.delete(entry);
            resolve(true);
            return;
          }
          const remain = deadline - Date.now();
          if (remain <= 0) {
            this._connWaiters.delete(entry);
            resolve(false);
            return;
          }
          entry.timer = setTimeout(entry.check, remain);
        },
      };
      this._connWaiters.add(entry);
      entry.check();
    });
  }

  // ---------- 内部：连接与折叠 ----------

  /**
   * 消费循环：每次（重）连前做一次对齐（首连的初始快照 + 补断连期间的增删），
   * 然后挂 `since=last_seq` 的状态流；任何异常都走「断连=未知 → 退避 → 重连」。
   *
   * **退避口径＝Python 的实际行为（恒为基数）**：每次重连尝试前 sleep 基数，不翻倍——
   * Python `dshevents.py:240-241` 的 `finally: backoff = RECONNECT_MIN` 会把 `except` 分支
   * `continue` 前的翻倍立刻复位，实测每次都是 1.0s（见文件头差异 ④）。`RECONNECT_MAX` 只导出
   * 对照、不参与计算；**要改成真退避必须两侧一起改**。
   *
   * **代际守卫**（`gen`）：`stop()` 超时返回后旧循环可能还在收尾（正在等的 `/live` 才返回），
   * 而调用方已 `start()` 了新循环。故本函数内一切「我是否还应继续/是否可改状态」的判据都走
   * `stopped()`/`current()`：旧代不得建流（否则 stop 之后还会出现一次 `connected=true` 抖动）、
   * 不得清掉新循环的在线态。
   */
  async _run(gen = this._gen) {
    const current = () => this._gen === gen;      // 自己仍是当前那一代
    const stopped = () => this._stop || !current();
    const backoff = this._reconnectMinMs;         // 恒基数：翻倍逻辑被 Python 的 finally 吃掉
    try {
      while (!stopped()) {
        try {
          await this._align();
          // stop（或换代）在对齐期间到达：不再建流——否则 stop 之后还会出现一次
          // connected=true 抖动（实测轨迹：[301,false],[1403,true],[1704,false]）
          if (stopped()) break;
          this._setConnected(true);
          await driverStateStream((frame) => this._onFrame(frame), {
            since: this._lastSeq,
            stop: stopped,
            idleTimeoutMs: this._streamIdleMs,
          });
          // 状态流正常返回只可能是「被 stop 主动断开」（sse.js 契约）：对端关闭一律以异常回来
          if (stopped()) break;
          throw new Error('状态流结束（对端关闭）');
        } catch {
          if (current()) this._setConnected(false);
          if (stopped()) break;
          await this._sleep(backoff);
          if (stopped()) break;
        }
      }
    } finally {
      // 只有仍是当前那一代才置断连：旧代收尾不得把新循环已建立的链路置回未知
      if (current()) this._setConnected(false);
    }
  }

  /**
   * 一次性 `/live` + `/archived` 快照对齐：以插件视角覆盖注册表（权威快照）。
   *
   * 只在（重）连时调用——静置期不产生任何请求（两条各一次）。失败语义：
   *   - `/live` 取不到 ⇒ 保留旧表 + `_aligned=false` + 留痕（宁可留旧值，不可误判空闲）；
   *   - `/archived` 取不到 ⇒ 归档集保持「未知」（null），调用方一律不动作；
   *   - 空快照且插件未声明 `complete === true` ⇒ 保留旧表 + 不可信（不变量 3）。
   *
   * Node 形态差异：异步（两条读口都是 Promise）。
   */
  async _align() {
    let rows = [];
    let complete = false;
    try {
      // 用 liveSnapshot()（原始 dict）而不是 live()（行表 list）——旧写法把行表当 dict 取
      // `.sessions`，`/live` 非空时必抛 ⇒ 中枢永久未对齐（2026-10-08 修正，Python 同）。
      const resp = (await driverLiveSnapshot()) || {};
      rows = arrayOr(resp.sessions);
      complete = resp.complete === true;
    } catch (error) {
      this._setAligned(false);             // 取不到快照＝不能确认任何事
      console.log(`[dshevents] /live 对齐失败（${(error && error.message) || error}）：`
        + `保留 ${this._sessions.size} 条既有会话、标记未对齐`);
      return;
    }
    let archived = null;
    try {
      archived = new Set(arrayOr(await driverArchived()).filter((s) => s).map((s) => String(s)));
    } catch {
      archived = null;                     // 归档集缺省=未知（旧插件没这端点也不得推断）
    }
    const now = nowSec();
    const fresh = new Map();
    for (const raw of rows) {
      const row = objectOr(raw);
      const sid = textOr(row.session_id);
      if (!sid) continue;
      const old = this._sessions.get(sid) || {};
      fresh.set(sid, {
        session_id: sid,
        status: textOr(row.status || old.status || ''),
        cwd: row.cwd || old.cwd || '',
        task: row.task || old.task || '',
        owned: Boolean(getWithDefault(row, 'owned', getWithDefault(old, 'owned', false))),
        // origin 是会话固有属性（subagent / 空＝未知）：快照没带就保留事件里学到的值，
        // 别把已认出的子代理会话在重连对齐时又变成未知
        origin: textOr(row.origin || old.origin || ''),
        // /live 的 interaction 可能为 null（此刻无等待）；已挂起的 interaction 若快照里
        // 没带，保留事件里学到的值，避免抖动
        interaction: getWithDefault(row, 'interaction', getWithDefault(old, 'interaction', null)),
        permission: mergePermission(row.permission, old.permission),
        last_turn_reason: getWithDefault(row, 'last_turn_reason',
          getWithDefault(old, 'last_turn_reason', null)),
        last_seq: row.last_seq !== undefined && row.last_seq !== null
          ? pyInt(row.last_seq) : pyInt(old.last_seq || 0),
        usage: old.usage === undefined ? null : old.usage,
        model: old.model === undefined ? null : old.model,
        inbox: old.inbox || [],
        updated_at: now,
      });
    }
    // —— 快照可信判定 ——
    // 非空快照 = 权威整表；空快照只有插件声明完整（complete）才算权威空。其余情况
    // （热重载后驱动实例重建、不重枚举已有会话 ⇒ 空表）＝**未知**：旧表原样保留
    // （宁可多等不可误放行），只把可信标志置 false。
    const trusted = fresh.size > 0 || complete;
    if (trusted) this._sessions = fresh;
    const kept = this._sessions.size;
    this._aligned = trusted;
    if (archived !== null) this._archived = archived;
    this._touch();
    if (!trusted && kept) {
      // 留痕：这是可诊断的降级态，不是静默——旧表保留期间看板列不做忙/闲写入，
      // 直到下一次权威快照。
      console.log(`[dshevents] /live 空快照且插件未声明完整：保留 ${kept} 条既有会话、`
        + '标记未对齐（热重载后驱动实例重建的已知形态，见 bug_report/20261008_1935）');
    }
  }

  /** 置「快照可信」标志（变更才唤醒订阅者，对齐 Python `_set_aligned`） */
  _setAligned(value) {
    const flag = Boolean(value);
    if (this._aligned !== flag) {
      this._aligned = flag;
      this._touch();
    }
  }

  /** 置「链路在线」标志（变更才唤醒；断连时归档集一并作废为未知，对齐 `_set_connected`） */
  _setConnected(value) {
    const flag = Boolean(value);
    if (this._connected !== flag) {
      this._connected = flag;
      if (flag) {
        this._reconnects += 1;
      } else {
        // 断连=未知：归档集同样作废，绝不让陈旧快照驱动卡片搬列
        this._archived = null;
      }
      this._touch();
      this._wakeConnWaiters();
    }
  }

  /**
   * 折叠一帧状态帧进注册表并唤醒订阅者（跑在消费循环里）。
   *
   * 帧类型与字段（逐条对齐 Python `_on_frame`；注意 last-wins 与「只在该状态下才改」）：
   *   `agent/status`       status
   *   `turn/start`         status=running；`event_seq` → 会话 last_seq
   *   `turn/end`           last_turn_reason；`event_seq` → 会话 last_seq；
   *                        **仅当 status==='running' 才置 idle**
   *   `driver/attached`    owned=true（帧是权威标记）；cwd/task 非空才覆盖；model 非空才覆盖
   *   `driver/model`       整对象覆盖 `data`
   *   `driver/permission`  `{mode, preset}`（都转字符串）
   *   `driver/inbox`       整表覆盖 `items`
   *   `driver/detached`    owned=false
   *   `driver/interaction` `state==='asked'` ⇒ 存 `interaction`，否则置空
   *   `usage`              四个 int 字段 input/output/total/cache_read
   *   `session/created`    cwd + `origin`（缺字段保持旧值/空串＝未知，绝不推断）
   *   `session/disposed`   删该会话
   *   `driver/archived`    **无 sid 的全局帧**：整表覆盖归档集（不进会话注册表）
   *
   * @param {object} frame
   */
  _onFrame(frame) {
    const typ = textOr(frame && frame.type);
    const sid = textOr(frame && frame.session_id);
    const data = objectOr(frame && frame.data);
    const seq = frame ? frame.seq : undefined;
    if (typ === 'driver/archived') {
      // 归档集整表快照（无 session_id 的全局帧）：整表覆盖，不做增量合并——插件侧每次
      // 变化都发全量，平台按「最后一次」为准，丢帧由重连对齐兜底。
      if (Number.isInteger(seq) && seq > this._lastSeq) this._lastSeq = seq;
      this._frames += 1;
      this._archived = new Set(arrayOr(data.archived).filter((s) => s).map((s) => String(s)));
      this._touch();
      this._callSubscribers(frame);
      return;
    }
    if (Number.isInteger(seq) && seq > this._lastSeq) this._lastSeq = seq;
    this._frames += 1;
    if (sid) {
      let item = this._sessions.get(sid);
      if (item === undefined) {
        item = {
          session_id: sid, status: '', cwd: '', task: '', owned: false, origin: '',
          interaction: null, last_turn_reason: null, last_seq: 0,
          usage: null, permission: null, inbox: [], updated_at: nowSec(),
        };
        this._sessions.set(sid, item);
      }
      item.updated_at = nowSec();
      if (typ === 'agent/status') {
        item.status = textOr(data.status);
      } else if (typ === 'turn/start') {
        // 起轮即忙：agent/status 随后到达也会给 running，两者一致
        item.status = 'running';
        if (Number.isInteger(data.event_seq)) item.last_seq = data.event_seq;
      } else if (typ === 'turn/end') {
        item.last_turn_reason = getWithDefault(data, 'reason', null);
        if (Number.isInteger(data.event_seq)) item.last_seq = data.event_seq;
        // 轮次收口即闲（排队项会再发 turn/start；agent/status 亦会纠正）
        if (item.status === 'running') item.status = 'idle';
      } else if (typ === 'driver/attached') {
        item.owned = true;
        item.cwd = data.cwd || item.cwd;
        item.task = data.task || item.task;
        if (data.model) item.model = data.model;
      } else if (typ === 'driver/model') {
        item.model = data;
      } else if (typ === 'driver/permission') {
        // 会话级权限：{mode: 平台三档, preset: 宿主实况}（会话窗「权限」控件的数据源）
        item.permission = { mode: textOr(data.mode), preset: textOr(data.preset) };
      } else if (typ === 'driver/inbox') {
        // 宿主 inbox 快照：整表覆盖，平台会话窗据此渲染排队行
        item.inbox = arrayOr(data.items).slice();
      } else if (typ === 'driver/detached') {
        item.owned = false;
      } else if (typ === 'driver/interaction') {
        if (textOr(data.state) === 'asked') {
          item.interaction = getWithDefault(data, 'interaction', null);
        } else {
          item.interaction = null;
        }
      } else if (typ === 'usage') {
        // 上下文用量：dsh 没有窗口上限，故只有 used（前端按「无 max 不画环」消费）
        item.usage = {
          input: pyInt(data.input || 0),
          output: pyInt(data.output || 0),
          total: pyInt(data.total || 0),
          cache_read: pyInt(data.cache_read || 0),
        };
      } else if (typ === 'session/created') {
        item.cwd = data.cwd || item.cwd;
        // 子代理会话标记：缺字段保持旧值/空串＝未知，绝不推断
        item.origin = textOr(data.origin || item.origin || '');
      } else if (typ === 'session/disposed') {
        this._sessions.delete(sid);
      }
    }
    this._touch();
    this._callSubscribers(frame);
  }

  // ---------- 内部：唤醒原语 ----------

  /** 变更计数 +1 并唤醒 `wait()` 的等待者（对齐 `self._changed += 1; notify_all()`） */
  _touch() {
    this._changed += 1;
    this._wakeWaiters();
  }

  /** 唤醒全部 `wait()` 等待者：按各自入场时的计数判定真假（未被唤醒者等自己的超时） */
  _wakeWaiters() {
    for (const entry of [...this._waiters]) this._settleWaiter(entry);
  }

  /** 结算一个 `wait()` 等待者（幂等；返回 `_changed != before`，与 Python 同口径） */
  _settleWaiter(entry) {
    if (!this._waiters.delete(entry)) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.resolve(this._changed !== entry.before);
  }

  /** 唤醒 `waitConnected()` 等待者（复核连接态/剩余时间） */
  _wakeConnWaiters() {
    for (const entry of [...this._connWaiters]) entry.check();
  }

  /** 订阅者回调（锁外调用、逐个 try）：回调抛异常不影响消费与其他订阅者 */
  _callSubscribers(frame) {
    for (const callback of [...this._subscribers]) {
      try {
        callback(frame);
      } catch {
        // 订阅者异常不影响消费
      }
    }
  }

  /** 可被 `stop()` 打断的退避睡眠（Python 是 `time.sleep(backoff)`＋join 干等） */
  _sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        this._sleeps.delete(entry);
        resolve();
      }, Math.max(0, ms));
      this._sleeps.add(entry);
    });
  }

  /** 唤醒全部退避睡眠（`stop()` 用：不必等满 backoff 才收尾） */
  _wakeSleeps() {
    for (const entry of [...this._sleeps]) {
      this._sleeps.delete(entry);
      clearTimeout(entry.timer);
      entry.resolve();
    }
  }
}

// 模块级单例：进程内唯一订阅（server 启动时 start()，退出时 stop()）
export const HUB = new EventHub();

// ---------- 模块级薄封装（与 Python 同名函数的调用点一一对应） ----------

/** 启动全局中枢（幂等；独立形态下返回 false 且不起循环） */
export function start() {
  return HUB.start();
}

/** 停全局中枢（返回 Promise；最多等 timeoutMs） */
export function stop(timeoutMs = 2000) {
  return HUB.stop(timeoutMs);
}

/** 链路是否在线 */
export function connected() {
  return HUB.connected();
}

/** 注册表可信读口（在线 ∧ 曾用权威快照对齐）；未对齐 ⇒ 调用方不写列、不推断 */
export function aligned() {
  return HUB.aligned();
}

/** 单会话实时态（未知 ⇒ null） */
export function get(sid) {
  return HUB.get(sid);
}

/** 会话当前思考等级（取不到 ⇒ ''） */
export function sessionEffort(sid) {
  return HUB.sessionEffort(sid);
}

/** 会话当前权限档（取不到 ⇒ ''） */
export function sessionPermissionMode(sid) {
  return HUB.sessionPermissionMode(sid);
}

/** 全部已知会话的实时态快照（未连接 ⇒ {}） */
export function snapshot() {
  return HUB.snapshot();
}

/** 会话是否被宿主归档（未知 ⇒ null） */
export function archived(sid) {
  return HUB.archived(sid);
}

/** 归档集副本（未知 ⇒ null） */
export function archivedSet() {
  return HUB.archivedSet();
}

/** 诊断信息 */
export function stats() {
  return HUB.stats();
}

/** 等一次变更（变更 true / 超时 false） */
export function wait(timeoutMs) {
  return HUB.wait(timeoutMs);
}

/** 等（首）次连接就绪（就绪 true / 超时 false） */
export function waitConnected(timeoutMs) {
  return HUB.waitConnected(timeoutMs);
}

/** 注册变更回调，返回退订函数（配套 `unsubscribe` 同时导出） */
export function subscribe(callback) {
  return HUB.subscribe(callback);
}

/** 退订（与 `subscribe` 返回值等价） */
export function unsubscribe(callback) {
  return HUB.unsubscribe(callback);
}
