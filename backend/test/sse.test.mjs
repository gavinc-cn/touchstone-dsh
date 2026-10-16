/**
 * backend/lib/sse.js 的测试（node --test，零依赖，真起本地 SSE 服务）。
 *
 * 这一层的坑全在收尾/超时（Python 侧踩过：读超时毒化连接、chunked 攒够才返回），故用例都
 * 围绕「什么时候该正常返回、什么时候该报哪种错」：
 *   ① 正常收帧（含一个块多帧、注释行/其他字段被忽略、`seq` 取最大）；
 *   ② 对端关闭 → `SseError(-2)`；③ 空闲超时 → `SseError(-2)` 且报「空闲超时」；
 *   ④ `stop()` 主动停止 → 正常返回 `stopped=true`（不是异常）；⑤ 非 200 → 带状态码与正文。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { parseSseBlock, parseStreamLine, sseUrl, SseError, streamEvents } from '../lib/sse.js';

/** 起一个可编排的 SSE 服务：`handler(res)` 自行写流，测试控制何时收尾 */
async function withSseServer(handler) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('parseStreamLine / parseSseBlock：只认 data 行、坏 JSON 忽略、一块可多帧', () => {
  assert.equal(parseStreamLine(': keepalive'), null);
  assert.equal(parseStreamLine('event: ping'), null);
  assert.equal(parseStreamLine('data: {bad json'), null);
  assert.equal(parseStreamLine('data: 123'), null, '非对象（数字）不算帧');
  assert.deepEqual(parseStreamLine('data: {"seq": 3, "type": "x"}'), { seq: 3, type: 'x' });
  assert.deepEqual(parseSseBlock('data: {"seq":1}\ndata: {"seq":2}\n: c'), [{ seq: 1 }, { seq: 2 }]);
});

test('sseUrl：拼 query，空值跳过（与 Python f-string 口径同）', () => {
  assert.equal(sseUrl('http://h:1/touchstone-agent/', '/events', { scope: 'state', since: 0 }),
    'http://h:1/touchstone-agent/events?scope=state&since=0');
  assert.equal(sseUrl('http://h:1', '/events', { scope: 'state', since: null, q: '' }),
    'http://h:1/events?scope=state');
});

test('正常收帧：多帧 + 注释 keepalive，lastSeq 取最大（收到即主动 stop）', async () => {
  // 注意：对端关闭在契约里是**错误**（未请求停止时链路断了要报 -2，见下一条），所以这条
  // 「正常返回」的路径必须由我们主动 stop——这也是生产里的真实形态（订阅方按需收尾）。
  const srv = await withSseServer((req, res) => {
    res.write(': keepalive\n\n');
    res.write('data: {"seq": 1, "type": "a"}\n\n');
    res.write('data: {"seq": 2, "type": "b"}\ndata: {"seq": 7, "type": "c"}\n\n');
    const t = setInterval(() => res.write(': keepalive\n\n'), 20);
    req.on('close', () => clearInterval(t));
  });
  try {
    const seen = [];
    let enough = false;
    const r = await streamEvents(`${srv.base}/events?scope=state`, {
      onFrame: (f) => { seen.push(f.type); if (seen.length >= 3) enough = true; },
      stop: () => enough,
    });
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(r.frames, 3);
    assert.equal(r.lastSeq, 7, 'lastSeq 取见过的最大 seq');
    assert.equal(r.stopped, true);
  } finally {
    await srv.close();
  }
});

test('对端关闭 ⇒ SseError(-2)（未请求停止时不算正常收尾）', async () => {
  const srv = await withSseServer((req, res) => {
    res.write('data: {"seq": 1}\n\n');
    setTimeout(() => res.end(), 30);
  });
  try {
    await assert.rejects(() => streamEvents(`${srv.base}/events`, {}),
      (e) => e instanceof SseError && e.code === -2 && /对端关闭/.test(e.message));
  } finally {
    await srv.close();
  }
});

test('空闲超时 ⇒ SseError(-2) 且消息点明空闲超时', async () => {
  const srv = await withSseServer((req, res) => {
    res.write('data: {"seq": 1}\n\n');
    // 之后一直不写（连接挂着）⇒ 触发空闲超时
  });
  try {
    await assert.rejects(
      () => streamEvents(`${srv.base}/events`, { idleTimeoutMs: 200 }),
      (e) => e instanceof SseError && e.code === -2 && /空闲超时/.test(e.message));
  } finally {
    await srv.close();
  }
});

test('stop() 主动停止 ⇒ 正常返回 stopped=true（不抛异常）', async () => {
  const srv = await withSseServer((req, res) => {
    res.write('data: {"seq": 1}\n\n');
    const t = setInterval(() => res.write(': keepalive\n\n'), 20);
    req.on('close', () => clearInterval(t));
  });
  try {
    let flag = false;
    setTimeout(() => { flag = true; }, 120);
    const r = await streamEvents(`${srv.base}/events`, { stop: () => flag });
    assert.equal(r.stopped, true);
    assert.equal(r.frames, 1);
  } finally {
    await srv.close();
  }
});

test('非 200 ⇒ SseError(状态码, 正文前 200 字)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => streamEvents(`http://127.0.0.1:${server.address().port}/events`, {}),
      (e) => e instanceof SseError && e.code === 403 && /unauthorized/.test(e.message));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('连接阶段就空闲超时 ⇒ SseError(-2)（不是裸 AbortError）', async () => {
  // 服务端 accept 后**不写任何响应头**：fetch 会一直挂着 ⇒ 应触发空闲超时，
  // 且必须是 -2「空闲超时」（此前会漏出 fetch 的 AbortError，调用方无法据码收口）
  const server = http.createServer(() => { /* 故意不响应 */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => streamEvents(`http://127.0.0.1:${server.address().port}/events`, { idleTimeoutMs: 200 }),
      (e) => e instanceof SseError && e.code === -2 && /空闲超时/.test(e.message));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('连接阶段被 stop ⇒ 正常返回 stopped=true（不抛异常）', async () => {
  const server = http.createServer(() => { /* 故意不响应 */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    let flag = false;
    setTimeout(() => { flag = true; }, 120);
    const r = await streamEvents(`http://127.0.0.1:${server.address().port}/events`,
      { stop: () => flag, idleTimeoutMs: 30000 });
    assert.equal(r.stopped, true);
    assert.equal(r.frames, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('stop() 按真值判定（() => 1 也算停止，对齐 Python）；signal 监听器成对摘除', async () => {
  // 两处评审抓到的无守卫行为（2026-10-11）：
  //   ① `stop() === true` 会把 `() => 1` 这类真值回调误判成「未停止」⇒ 长寿命订阅永不收尾；
  //   ② 外部 signal 往往是长寿命对象，监听器不摘会在它上面随重连线性堆积。
  // 服务端只写一次就静默（不再发 keepalive）⇒ 若 stop 判定失效，空闲超时会在 ~250ms 内
  // 抛错而不是挂死——**让守卫快速失败**（评审用变异体实测过：挂死形态也算红，但太慢不好用）
  const srv = await withSseServer((req, res) => {
    res.write('data: {"seq": 1}\n\n');
  });
  try {
    let n = 0;
    let adds = 0;
    let removes = 0;
    // 可计数的 duck-typed signal：AbortSignal 没有「当前监听器数」自省口
    const signal = {
      aborted: false,
      addEventListener: () => { adds += 1; },
      removeEventListener: () => { removes += 1; },
    };
    const r = await streamEvents(`${srv.base}/events`, {
      stop: () => { n += 1; return 1; },   // 真值 1（不是布尔 true）
      signal,
      idleTimeoutMs: 1500,   // 长于一个看门节拍（250ms）：修复版 ~250ms 就收尾；
                             // 变异版（只认 === true）会在 1.5s 时空闲超时抛错 ⇒ 快速转红
    });
    assert.equal(r.stopped, true, '真值 stop 必须被认定为停止');
    assert.equal(adds, 1, '应挂 1 个 abort 监听器');
    assert.equal(removes, 1, 'abort 监听器必须在 finally 里摘除（否则长寿命 signal 上线性堆积）');
  } finally {
    await srv.close();
  }
});
