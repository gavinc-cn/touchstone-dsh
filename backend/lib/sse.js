/**
 * SSE 消费（`dshdriver._stream_events` 的 Node 对应物）：会话事件流与全局状态流共用。
 *
 * 为什么要单独一层：两版后端都要订阅 dsh 插件的事件流（`/events?scope=session|state`），
 * 而这一层的**坑全在收尾与超时**上（Python 侧踩过）：SocketIO 读超时会永久毒化连接、
 * `read(n)` 对 chunked 响应会攒够 n 字节才返回（长连 SSE 下等于永不返回）。Node 侧对应的是
 * `fetch` + `ReadableStream` 读取 + 空闲计时器 + AbortController 主动断开。
 *
 * 契约（与 Python `_stream_events` 逐条对齐）：
 *   - 帧 = `data:` 行里的 JSON（`dshdriver.parse_stream_line`）；注释/空行/其他字段忽略；
 *   - 非 200 ⇒ 抛 `SseError(status, '事件流被拒: …')`（正文取前 200 字，便于排障）；
 *   - **空闲超时**：`idleTimeoutMs` 内没有任何字节（含 keepalive 注释）⇒ `SseError(-2, '事件流空闲超时…')`
 *     —— 任一 chunk（哪怕只是注释）都会重置计时；
 *   - **对端关闭**：流 EOF 且未请求停止 ⇒ `SseError(-2, '事件流被对端关闭')`；
 *   - **主动断开不算异常**：`stop()` 返回真（或 `signal` 被 abort）⇒ 正常返回，`stopped=true`；
 *   - 返回 `{frames, lastSeq, stopped}`，`lastSeq` 是见过的最大 `seq`（重连时传回去续传）。
 */
/** 驱动侧链路错误（与 Python `DshDriverError` 同形：`code` + 中文消息） */
export class SseError extends Error {
  /**
   * @param {number} code 0=HTTP 状态异常；-1=未配置；-2=链路问题（超时/被关）
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SseError';
    this.code = code;
  }
}

/** 停止轮询间隔（对齐 Python `dshdriver.STOP_WATCH_INTERVAL=0.25s`） */
export const STOP_WATCH_INTERVAL_MS = 250;

/**
 * 把一行 SSE 文本解析成帧；注释/空行/非 data 行返回 null（对齐 `parse_stream_line`）。
 * @param {string} line
 * @returns {object|null}
 */
export function parseStreamLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:')) return null;
  try {
    const value = JSON.parse(line.slice('data:'.length).trim());
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 解析一个 `\n\n` 分隔的 SSE 块 → 帧数组（Python 是逐行解析，故一个块可能出多帧）。
 * @param {string} block
 * @returns {object[]}
 */
export function parseSseBlock(block) {
  const frames = [];
  for (const line of String(block).split('\n')) {
    const frame = parseStreamLine(line.trim());
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

/**
 * 订阅一个 SSE 流直到：`stop()` 为真 / `signal` 被 abort / 对端关闭 / 空闲超时。
 *
 * @param {string} url 完整 URL（含 query，调用方负责拼 `since`/`scope`）
 * @param {object} [opts]
 * @param {object} [opts.headers] 附加请求头（驱动 token 等）
 * @param {number} [opts.since] 起始 seq（只用于统计；补发由服务端按 query 处理）
 * @param {(frame: object) => void} [opts.onFrame] 每帧回调
 * @param {() => boolean} [opts.stop] 主动停止探测（每 250ms 查一次）
 * @param {AbortSignal} [opts.signal] 外部取消信号（与 stop 等价）
 * @param {number} [opts.idleTimeoutMs] 空闲超时（缺省 90s，对齐 `STREAM_IDLE_TIMEOUT`）
 * @param {typeof fetch} [opts.fetchImpl] 注入用（测试）
 * @returns {Promise<{frames:number,lastSeq:number,stopped:boolean}>}
 */
export async function streamEvents(url, {
  headers = {},
  since = 0,
  onFrame,
  stop,
  signal,
  idleTimeoutMs = 90000,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  let lastSeq = Number.isInteger(since) ? since : 0;
  let frames = 0;
  let stopped = false;
  let idleTimer = null;
  // `stop()` 按**真值**判定（对齐 Python `if stop is not None and stop():`）：只认 `=== true`
  // 会把 `() => 1` 这类真值回调误判成「未停止」，长寿命订阅下永不收尾。
  const stopWanted = () => (typeof stop === 'function' && Boolean(stop()))
    || (signal !== undefined && signal.aborted === true);
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new SseError(-2,
      `事件流空闲超时（>${Math.round(idleTimeoutMs / 1000)}s 无数据）`)), idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  };
  // 主动停止探测：fetch 的 body reader 阻塞时不响应外部状态，只能旁路轮询 + abort
  const watcher = setInterval(() => {
    if (stopWanted()) {
      stopped = true;
      controller.abort(new SseError(0, 'stopped'));
    }
  }, STOP_WATCH_INTERVAL_MS);
  if (watcher.unref) watcher.unref();
  // 外部取消信号：监听器必须成对摘除（`signal` 往往是长寿命对象——平台侧复用它做整体收尾，
  // 每轮重连都挂一个监听器会在它上面线性堆积 ⇒ 内存与误触发风险）
  const onAbort = () => {
    stopped = true;
    controller.abort(new SseError(0, 'aborted'));
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let response;
  let reader = null;
  try {
    armIdle();
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...headers },
        signal: controller.signal,
      });
    } catch (error) {
      // 连接/响应头阶段被 abort 时 fetch 抛的是 AbortError。**先判主动停止**（那不是异常），
      // 再把「我们自己塞进去的 SseError」还原出来（如空闲超时），最后才当链路失败。
      if (stopped || stopWanted()) return { frames, lastSeq, stopped: true };
      const reason = controller.signal.reason;
      if (reason instanceof SseError) throw reason;
      throw new SseError(-2, `事件流连接失败: ${(error && error.message) || error}`);
    }
    if (response.status !== 200) {
      const detail = await response.text().catch(() => '');
      throw new SseError(response.status, `事件流被拒: ${detail.slice(0, 200)}`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      armIdle();
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // abort 唤醒的读会以 AbortError 形式回来：主动断开不算链路异常
        if (stopped || stopWanted()) { stopped = true; break; }
        const reason = controller.signal.reason;
        if (reason instanceof SseError) throw reason;
        throw new SseError(-2, `事件流读取失败: ${(error && error.message) || error}`);
      }
      if (chunk.done) {
        if (stopped || stopWanted()) { stopped = true; break; }
        throw new SseError(-2, '事件流被对端关闭');
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      while (buffer.includes('\n\n')) {
        const idx = buffer.indexOf('\n\n');
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const frame of parseSseBlock(block)) {
          frames += 1;
          if (Number.isInteger(frame.seq) && frame.seq > lastSeq) lastSeq = frame.seq;
          if (typeof onFrame === 'function') {
            try {
              onFrame(frame);
            } catch {
              // 回调抛异常不影响订阅循环（对齐 Python feed_into 的 on_frame 容错）
            }
          }
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(watcher);
    if (signal) signal.removeEventListener('abort', onAbort);
    // 收尾顺序与实测口径（评审 2026-10-11 复核）：
    //   ① `reader.cancel()` 让读取端立即放弃（不 cancel 也不会长期泄漏——实测 5 轮「连上→stop」
    //      后服务端打开 socket 数都是 0，真正兜底的是 ② 的 abort；但显式 cancel 能让
    //      HTTP 层尽早复用/关闭连接，且避免 reader 挂着 pending read）；
    //   ② `controller.abort()` 才是**保证**连接释放的那一步（fetch 的 socket 归它管）。
    //      ⚠ 不要写成「不 cancel 会挂到 GC 才释放」——那是过度声称，实测不成立。
    if (reader) {
      try {
        await reader.cancel();
      } catch { /* 已关闭/已取消：忽略 */ }
    }
    try {
      controller.abort();
    } catch { /* 已 abort：忽略 */ }
  }
  return { frames, lastSeq, stopped };
}

/** 小工具：把 base + path + query 拼成 URL（对齐 Python 的 `f"{base}/events?{query}"`） */
export function sseUrl(base, pathName, query = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  const qs = usp.toString();
  return `${String(base).replace(/\/$/, '')}${pathName}${qs ? `?${qs}` : ''}`;
}
