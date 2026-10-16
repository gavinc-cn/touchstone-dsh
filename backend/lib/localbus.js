/**
 * 进程内变更总线（`localbus.py` 91 行的 Node 对应物，Node 后端 M2）。
 *
 * 用途（与 Python 侧逐字同）：看板/会话前端原先定时拉全量 payload；事件化后由本总线唤醒——
 * 写路径（卡片增删改列、行收口）与 dsh 状态帧各发一次「值得重取」信号，前端在事件到达时
 * 才重取，静置期零请求。
 *
 * 三条不变量（照抄 Python 模块头的设计要点，**改代码不得破坏**）：
 *   ① **只发信号不带载荷**：topic ＝ `['board', projectId]`，载荷恒空。携带增量需要维护
 *      增量协议与丢失补发，而 payload 本身很小——「信号 + 客户端重取」最简且不会错；
 *   ② **序号单调**：每个 topic 一条从 1 开始的计数。订阅者记住自己上次看到的 seq，
 *      `wait()` 等到变化或超时（超时用于发 keepalive）。序号单调 ⇒ **漏唤醒只晚一拍，
 *      不会永久丢失**；
 *   ③ **publish 绝不抛、O(1)**：发布点散布在 DB 写路径与 dsh 消费线程里，任何异常都必须
 *      被吞掉（通知失败绝不能影响业务写）。
 *
 * 形态差异（Python → Node，唯一必要的差异，语义等价）：
 *   - Python `wait(topic, since, timeout)` 是**条件变量阻塞**（`threading.Condition`）；
 *     Node 是事件循环 ⇒ `wait(topic, since, timeoutMs)` 返回 **`Promise<number>`**，
 *     resolve 值是「唤醒/超时时刻该 topic 的当前序号」。调用方拿返回值与 `since` 比较即可
 *     判断「有无变化」（超时时两者相等）——与 Python 返回值口径完全一致。
 *   - Python `notify_all()` 会唤醒**所有** topic 的等待者（被误唤醒者读回自己的 seq、值不变，
 *     调用方本就按值判断）；Node 只 settle 该 topic 的等待者。少一次无意义唤醒，观感一致。
 *   - topic 是数组（`['board', 7]`），而 Map/setTimeout 需要**稳定键** ⇒ 内部一律经
 *     `topicKey()` 归一为字符串；`stats().seq` 的键就是这个字符串键（Python 是元组键）。
 *   - `timeoutMs` 单位毫秒（Python 是秒）；省略即无限等待（Python 的 `timeout` 是必填位置
 *     参数，调用方一律会传）。
 */
/** topic → 内部字符串键（JSON 文本；数组 topic 与字符串 topic 不会撞键）。
 *  归一可能抛（如循环引用的 topic）——调用方 `publish()` 已把整段包进 try。 */
export function topicKey(topic) {
  return JSON.stringify(topic);
}

/**
 * 按 topic 计数的进程内变更总线（对齐 `localbus.ChangeBus`）。
 *
 * 内部状态：
 *   `_seq`     Map<key, number> —— 每个 topic 的单调序号（未发布过视为 0）；
 *   `_waiters` Set<{key, since, resolve, timer}> —— 当前挂起的等待者（诊断用计数即它的 size）。
 */
export class ChangeBus {
  constructor() {
    this._seq = new Map();
    this._waiters = new Set();
  }

  /**
   * 发布一次变更：序号 +1 并唤醒该 topic 的等待者。**O(1) 且绝不抛**。
   *
   * 整段（含 topic 归一）包在 try 里：即使调用方递来无法序列化的 topic，也只是这一次通知
   * 失败，业务写路径照常返回。
   *
   * @param {Array|string} topic
   */
  publish(topic) {
    try {
      const key = topicKey(topic);
      this._seq.set(key, (this._seq.get(key) || 0) + 1);
      this._wake(key);
    } catch {
      // noqa：通知失败绝不影响业务（对应 Python 侧的 except Exception: pass）
    }
  }

  /**
   * 当前序号（订阅者用它做「从这里之后的变化」的基准；未发布过为 0）。
   *
   * @param {Array|string} topic
   * @returns {number}
   */
  seq(topic) {
    return this._seq.get(topicKey(topic)) || 0;
  }

  /**
   * 等到 `seq(topic) !== since` 或超时；resolve 当前序号。
   *
   * - 调用时就已经落后（`seq !== since`）⇒ **立即** resolve，不注册等待者；
   * - 否则注册一个等待者，被 `publish` settle 或在 `timeoutMs` 后 settle（超时返回的序号
   *   等于 `since`，调用方据此发 keepalive）；
   * - `timeoutMs` 省略/非有限值 ⇒ 无限等待（只可能被 publish 唤醒）。
   *
   * @param {Array|string} topic
   * @param {number} since 调用方上次看到的序号
   * @param {number} [timeoutMs]
   * @returns {Promise<number>}
   */
  wait(topic, since, timeoutMs) {
    const key = topicKey(topic);
    const current = this._seq.get(key) || 0;
    if (current !== since) return Promise.resolve(current);
    return new Promise((resolve) => {
      const entry = { key, since, resolve, timer: null };
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => this._settle(entry), Math.max(0, timeoutMs));
      }
      this._waiters.add(entry);
    });
  }

  /** 诊断（健康检查、测试断言用）：`{topics, waiters, seq}`，seq 键为 `topicKey()` 口径 */
  stats() {
    const seq = {};
    for (const [key, value] of this._seq) seq[key] = value;
    return { topics: this._seq.size, waiters: this._waiters.size, seq };
  }

  /** 唤醒该 topic 上「序号已变化」的等待者（值未变的继续等，直到自己的超时） */
  _wake(key) {
    const current = this._seq.get(key) || 0;
    for (const entry of [...this._waiters]) {
      if (entry.key === key && entry.since !== current) this._settle(entry);
    }
  }

  /** 结算一个等待者：清定时器 → 摘除 → resolve 当前序号（重复调用幂等） */
  _settle(entry) {
    if (!this._waiters.delete(entry)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(this._seq.get(entry.key) || 0);
  }
}

// 模块级单例：进程内唯一总线（server 与 db 共用）——对齐 Python 的 `BUS = ChangeBus()`
export const BUS = new ChangeBus();

/** 模块级发布（对齐 `localbus.publish`） */
export function publish(topic) {
  BUS.publish(topic);
}

/** 模块级读序号（对齐 `localbus.seq`） */
export function seq(topic) {
  return BUS.seq(topic);
}

/** 模块级等待（对齐 `localbus.wait`；返回 Promise 而非阻塞） */
export function wait(topic, since, timeoutMs) {
  return BUS.wait(topic, since, timeoutMs);
}

/**
 * 看板 topic 构造（单一出口，防各处拼错）。
 *
 * Python `board_topic` 走 `int(project_id)` 归一（`"9"` 与 `9` 同 topic）；Node 用
 * `Number()` 对齐（非数字得到 NaN，与 Python 的 ValueError 一样属于调用方错误）。
 *
 * @param {number|string} projectId
 * @returns {Array} `['board', <number>]`
 */
export function boardTopic(projectId) {
  return ['board', Number(projectId)];
}

/**
 * 单会话 topic（会话窗口事件流用；sid 为字符串，逐字符可比）。
 *
 * @param {string|number} sessionId
 * @returns {Array} `['session', '<sid>']`
 */
export function sessionTopic(sessionId) {
  return ['session', String(sessionId)];
}
