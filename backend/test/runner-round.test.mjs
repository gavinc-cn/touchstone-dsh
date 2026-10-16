/**
 * `backend/lib/runner.js` **M6.5-R3（轮次族 + 日志/读侧族）**的回归钉（`node --test`，零依赖）。
 *
 * 为什么单独一个文件、而不是全交给 `tools/parity/cases-mod/runner_round.json`：
 * 对拍量具（mod-run）的 `seq` 只能给实例方法传 **JSON 实参** —— Python/Node 的**对象句柄**
 * （`dshdriver.TurnWaiter`）无法作为实参跨进 `_wait_turn_end_dsh(task, sid, waiter, log_path)`
 * 的第 3 位（`{'$handle': 'w'}` 这类引用两侧都不认，`args` 只做夹具占位符替换）。
 * 因此「预喂一个 TurnWaiter ⇒ 钉四支等待结果」这条判据在对拍里**结构上不可达**，
 * 只能在这里用真 `TurnWaiter` / 可控的时间替身钉住。对拍用例覆盖的是另一批可达面
 * （见 `runner_round.json` 的 note）。
 *
 * 本文件的判据来源分三类，逐条标注：
 *   ① **Python oracle 实测**（`python3 -c "import runner; …"`，命令与输出记在 M6.5 记录的 R3 节）；
 *   ② **两侧实现共同约定**（如 `TurnWaiter.feed` 把缺失 `reason` 归一成 `aborted`，
 *      Python `dshdriver.py:729-735` 与 `dshdriver.js` 逐条同）；
 *   ③ **本批修掉的缺陷**（`readLogTail` 的 `limit<=0` 切片——见 runner.js 差异㊹）。
 *
 * 两条硬约束（照 `runner-bug.test.mjs` / `m3fixture.mjs` 的既有口径）：
 *   - **临时库、绝不用生产库**：`freshDb` 把 `TOUCHSTONE_DB` 指到一次性目录；
 *   - **不起真后台循环**：`new Runner(true, …)`（启动闸关着），只做直调。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { RETIRED_MSG } from '../lib/agents.js';
import * as db from '../lib/db.js';
import { TurnWaiter } from '../lib/dshdriver.js';
import * as runner from '../lib/runner.js';
import { freshDb, insertProject, insertTask } from './m3fixture.mjs';

/** 每例自带临时库夹具（照 runner-bug.test.mjs 的 withFixture）。 */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    const ret = fn(fx);
    if (ret && typeof ret.then === 'function') return ret.finally(() => fx.close());
    fx.close();
    return ret;
  } catch (err) {
    fx.close();
    throw err;
  }
}

/** 停闸 Runner（执行循环全停在启动闸后，只做直调）。 */
function parkedRunner(fx) {
  return new runner.Runner(true, { db: fx.db });
}

/** 造一个任务行（走真 SQL；字段与生产库一致）。项目名带本文件内自增后缀（projects 有
 *  `(user_id, name)` 唯一索引，同一夹具里插第二个项目不能重名）。 */
let projSeq = 0;
function insertRoundTask(fx, { taskType = 'normal', status = 'queued' } = {}) {
  projSeq += 1;
  const pid = insertProject(fx.db, {
    name: `proj-${projSeq}`, workDir: fx.dir, projectDir: fx.dir,
  });
  const tid = insertTask(fx.db, pid, { name: 'task', status, taskType });
  return { pid, tid };
}

/**
 * 传给轮次族的**完整任务视图**（照 `db.get_task` 的行形状）：`build_prompt` 会按
 * `task['task_type']` / `task['auto_fix']` / `task['extra']` 等逐个下标取键，
 * 少一个键 Python 侧就是 KeyError（Node 侧 `pyGetItem` 同抛）——故这里显式补齐。
 */
function taskView(tid, pid, over = {}) {
  return {
    id: tid, project_id: pid, name: 'task', task_type: 'normal', status: 'queued',
    current_round: 0, session_id: '', model: '', payload: '', start_stage: '', end_stage: '',
    date_from: '', date_to: '', auto_fix: 0, auto_retest: 0, retest: '不复测', extra: '',
    fresh_prompt: 0, new_bugs: 0, load_rerun: 0, stop_type: 'rounds', stop_value: '1',
    created_at: '2026-10-13 00:00:00', started_at: '2026-10-13 00:00:00', error: '',
    ...over,
  };
}

/** 项目视图（照 `db.get_project`：含 `cases_root`/`bug_dir` 派生列）。 */
function projectView(fx, pid) {
  return db.getProject(pid, { db: fx.db });
}

/** 预喂过的真 TurnWaiter（`feed` 的语义与 Python `TurnWaiter.feed` 逐条同）。 */
function fedWaiter(frames) {
  const w = new TurnWaiter();
  for (const frame of frames) w.feed(frame);
  return w;
}

/** 立即超时的等待替身：`waitTurnEndDsh` 只读 `wait/started/error/turnReason/exitCode`
 *  四个面，故可用来把「本地 5s tick」压成 0ms（对拍/单测都不该真等 5s）。 */
function timeoutWaiter(started = false) {
  return {
    started,
    error: null,
    turnReason: null,
    exitCode: null,
    wait: async () => 'timeout',
  };
}

/**
 * 起一台「罐头驱动」HTTP 服务（仅本测试用）：按路径返回 `dshdriver` 各调用点要的回执，
 * `/events` 推一段确定的 SSE 帧。**这不是假驱动模块**（模块不可注入），是**真 HTTP**
 * —— 被测代码走的是真的 `fetch`/SSE 解码/`feedInto`/`TurnWaiter` 全链路。
 */
async function startCannedDriver({ frames = [], statusBody = { last_seq: 7 } } = {}) {
  const seen = { prompts: [], models: [], cancels: [], paths: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.paths.push(`${req.method} ${req.url.split('?')[0]}`);
      const route = `${req.method} ${req.url.split('?')[0]}`;
      if (route === 'GET /health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (route === 'POST /session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ session_id: 's-canned' }));
        return;
      }
      if (route === 'GET /status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(statusBody));
        return;
      }
      if (route === 'POST /prompt') {
        seen.prompts.push(JSON.parse(body || '{}').prompt);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok": true}');
        return;
      }
      if (route === 'POST /model') {
        seen.models.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"selected": {"provider": "p", "model": "m"}}');
        return;
      }
      if (route === 'POST /cancel') {
        seen.cancels.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok": true}');
        return;
      }
      if (route === 'GET /events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        // 保持连接（不 end）：客户端靠 `{aborted:true}` 主动断开，避免「对端关闭」被判链路异常
        req.on('close', () => { /* 客户端断开 */ });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error": "no route"}');
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = new Set();
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  return {
    url,
    seen,
    async close() {
      for (const sock of sockets) sock.destroy();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}

/** 包住「设 env → 跑 → 还原 env → 拆服务」的驱动夹具。 */
async function withDriver(opts, fn) {
  const srv = await startCannedDriver(opts);
  const oldUrl = process.env.TS_AGENT_DRIVER_URL;
  const oldToken = process.env.TS_AGENT_DRIVER_TOKEN;
  process.env.TS_AGENT_DRIVER_URL = srv.url;
  process.env.TS_AGENT_DRIVER_TOKEN = 'tok-parity';
  try {
    return await fn(srv);
  } finally {
    if (oldUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.TS_AGENT_DRIVER_TOKEN;
    else process.env.TS_AGENT_DRIVER_TOKEN = oldToken;
    await srv.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 一、日志 / 读侧族（判据：Python oracle 实测 + 批内修掉的缺陷）
// ══════════════════════════════════════════════════════════════════════════

test('readLogTail: limit 切片照 Python readlines()[-limit:]（0=全文、负数=丢开头）', () => {
  withFixture('runner-round-readtail', (fx) => {
    const p = path.join(fx.dir, 'r.log');
    fs.writeFileSync(p, 'L1\nL2\nL3\n', 'utf8');
    assert.equal(runner.readLogTail(p), 'L1\nL2\nL3\n');            // 默认 200 > 行数
    assert.equal(runner.readLogTail(p, 2), 'L2\nL3\n');
    assert.equal(runner.readLogTail(p, 0), 'L1\nL2\nL3\n');         // Python [-0:] = [0:] = 全文
    assert.equal(runner.readLogTail(p, -1), 'L2\nL3\n');            // Python [1:] = 丢开头 1 行
    assert.equal(runner.readLogTail(p, -99), '');                   // 越界 ⇒ 空串
    assert.equal(runner.readLogTail(path.join(fx.dir, 'nope.log')), '');
    assert.equal(runner.readLogTail(''), '');
    // Python 文本模式是 universal newlines：\r\n / 独立 \r 都归一成 \n
    const crlf = path.join(fx.dir, 'crlf.log');
    fs.writeFileSync(crlf, 'A\r\nB\rC\n', 'utf8');           // universal newlines ⇒ 3 行
    assert.equal(runner.readLogTail(crlf), 'A\nB\nC\n');
    assert.equal(runner.readLogTail(crlf, 1), 'C\n');
    assert.equal(runner.readLogTail(crlf, -2), 'C\n');
  });
});

test('readLogTail: 非法 UTF-8 字节按 errors="replace" 落 U+FFFD（夹具写不出，只有单测能钉）', () => {
  withFixture('runner-round-readtail-bad', (fx) => {
    const p = path.join(fx.dir, 'bad.log');
    fs.writeFileSync(p, Buffer.from([0x41, 0xff, 0x42, 0x0a]));
    assert.equal(runner.readLogTail(p), 'A\uFFFDB\n');
  });
});

test('tailText: 剔 ### 平台行与空行、各自 strip、单空格连接、末尾按码点截断', () => {
  withFixture('runner-round-tailtext', (fx) => {
    const p = path.join(fx.dir, 'load.log');
    fs.writeFileSync(p, '### 平台标记一\n  脚本错误 A  \n\n### 平台标记二\n脚本错误 B\ntail C\n');
    assert.equal(runner.tailText(p), '脚本错误 A 脚本错误 B tail C');
    assert.equal(runner.tailText(p, 5), 'ail C');                   // 码点窗口在**拼接后**的串上
    const astral = path.join(fx.dir, 'astral.log');
    fs.writeFileSync(astral, `### x\n${'😀'.repeat(10)}\n`);
    assert.equal([...runner.tailText(astral, 3)].length, 3);        // 代理对不被劈开
    assert.equal(runner.tailText(path.join(fx.dir, 'nope.log')), '');
  });
});

test('parseSessionHint: 取尾部 200 行内**最后**一个匹配；窗口外/缺文件 ⇒ null', () => {
  withFixture('runner-round-hint', (fx) => {
    const p = path.join(fx.dir, 'r1.log');
    fs.writeFileSync(p, '### 会话 s0\n'
      + '{"role": "meta", "type": "session.resume_hint", "session_id": "old-1"}\n'
      + '普通行也含 "session_id": "fake"（不是 meta 也照正则命中）\n'
      + '{"role": "meta", "type": "session.resume_hint", "session_id": "new-2"}\n');
    assert.equal(runner.parseSessionHint(p), 'new-2');
    // 唯一命中落在第 1 行、后面补 250 个空行 ⇒ 超出 read_log_tail(path, 200) 的窗口
    const far = path.join(fx.dir, 'r2.log');
    fs.writeFileSync(far, '{"role": "meta", "type": "session.resume_hint",'
      + ' "session_id": "too-old"}\n' + '\n'.repeat(250));
    assert.equal(runner.parseSessionHint(far), null);
    assert.equal(runner.parseSessionHint(path.join(fx.dir, 'nope.log')), null);
    // `\s*` 吃换行：键值跨行也算命中（PY_WS 口径）
    const wrap = path.join(fx.dir, 'r3.log');
    fs.writeFileSync(wrap, '{"role": "meta",\n "session_id"\n :\n "wrapped"}\n');
    assert.equal(runner.parseSessionHint(wrap), 'wrapped');
  });
});

test('readLiveSummary: 四字段保序落 JSON；缺文件/坏 JSON ⇒ ""；顶层非对象 ⇒ AttributeError', () => {
  withFixture('runner-round-live', (fx) => {
    const liveDir = path.join(fx.dir, '.live');
    fs.mkdirSync(liveDir, { recursive: true });
    const p = path.join(liveDir, 'live.json');
    fs.writeFileSync(p, '{"phase": "done", "round": 3, "stats": {"new_bug_reports": 2},'
      + ' "stop_condition": {"type": "rounds"}, "ignored": 9}', 'utf8');
    // 顺序/分隔符照 CPython json.dumps(..., ensure_ascii=False)（pyJsonDumps）
    assert.equal(runner.readLiveSummary(fx.dir),
      '{"phase": "done", "round": 3, "stats": {"new_bug_reports": 2},'
      + ' "stop_condition": {"type": "rounds"}}');
    fs.writeFileSync(p, '{坏 JSON', 'utf8');
    assert.equal(runner.readLiveSummary(fx.dir), '');
    fs.writeFileSync(p, '[1, 2]', 'utf8');
    // Python `live.get(...)` 在 list 上抛 AttributeError（**不在** except (OSError, ValueError) 里）
    assert.throws(() => runner.readLiveSummary(fx.dir),
      (e) => e.constructor.name === 'AttributeError'
        && e.message === "'list' object has no attribute 'get'");
    fs.rmSync(p);
    assert.equal(runner.readLiveSummary(fx.dir), '');
    fs.writeFileSync(p, '{}', 'utf8');
    assert.equal(runner.readLiveSummary(fx.dir),
      '{"phase": "", "round": null, "stats": {}, "stop_condition": {}}');
  });
});

test('summaryEntryText: 四 kind + 未知 ⇒ ""；缺 kind ⇒ KeyError；截断按码点', () => {
  assert.equal(runner.summaryEntryText({ kind: 'user', text: 'x'.repeat(1300) }).length, 1300);
  assert.equal(runner.summaryEntryText({ kind: 'meta', text: 'sid' }), 'sid');
  assert.equal([...runner.summaryEntryText({ kind: 'assistant', text: '😀'.repeat(1300) })].length,
    runner.DIALOGUE_RAW_LIMIT);
  assert.equal([...runner.summaryEntryText({ kind: 'tool_result', text: 'y'.repeat(1300) })].length,
    runner.DIALOGUE_RAW_LIMIT);
  assert.equal(runner.summaryEntryText({ kind: 'reject' }), '');
  // Python `entry["kind"]` 缺键抛 KeyError（消息是键的 repr）
  assert.throws(() => runner.summaryEntryText({ text: 'x' }),
    (e) => e.constructor.name === 'KeyError' && e.message === "'kind'");
  // `entry["kind"]` 的下标语义：非 dict ⇒ TypeError（文案与 Python 逐字同）
  assert.throws(() => runner.summaryEntryText(null),
    (e) => e.constructor.name === 'TypeError'
      && e.message === "'NoneType' object is not subscriptable");
});

test('contentText / dshEventToLogLine: null（无需落盘）与空串分明；七种帧的分类', () => {
  assert.equal(runner.contentText('hi'), 'hi');
  assert.equal(runner.contentText([{ type: 'text', text: 'A' }, { type: 'tool_use' },
    { type: 'text', text: 'B' }]), 'AB');
  assert.equal(runner.contentText(123), '');
  assert.equal(runner.contentText(null), '');
  assert.equal(runner.contentText([{ type: 'text' }]), '');
  assert.equal(runner.contentText([{ type: 'text', text: true }]), 'True');   // str(True)，不是 "true"

  assert.equal(runner.dshEventToLogLine({ type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '你好' }] } } }),
  '{"role": "assistant", "content": "你好", "tool_calls": []}\n');
  assert.equal(runner.dshEventToLogLine({ type: 'assistant/message',
    data: { message: { content: [{ type: 'tool_use' }] } } }), null);
  assert.equal(runner.dshEventToLogLine({ type: 'assistant/message',
    data: { message: { content: 'x' }, interrupted: true } }),
  '{"role": "assistant", "content": "（本轮被中断，以下为已交付内容）x", "tool_calls": []}\n');
  assert.equal(runner.dshEventToLogLine({ type: 'tool/call',
    data: { name: 'read', arguments: '{"a": 1}' } }),
  '{"role": "assistant", "content": "", "tool_calls": [{"function":'
  + ' {"name": "read", "arguments": "{\\"a\\": 1}"}}]}\n');
  assert.equal(runner.dshEventToLogLine({ type: 'tool/result',
    data: { message: { toolCallId: 'c1', content: 'oops' },
      error: { name: 'Error', code: 'E1', reason: '炸了' } } }),
  '{"role": "tool", "tool_call_id": "c1", "content": "oops\\n[工具错误 Error: E1 炸了]"}\n');
  assert.equal(runner.dshEventToLogLine({ type: 'turn/end', data: { reason: 'completed' } }), null);
  assert.equal(runner.dshEventToLogLine({ type: 'driver/interaction', data: { state: 'asked' } }),
    '### 会话等待人工输入（提问/审批已推给用户）\n');
  assert.equal(runner.dshEventToLogLine({ type: 'user/message' }), null);
  assert.equal(runner.dshEventToLogLine({ type: 'agent/status' }), null);
  assert.equal(runner.dshEventToLogLine({ type: '什么/都不是' }), null);
  assert.equal(runner.dshEventToLogLine({}), null);
  // 帧本身不是 dict ⇒ Python `frame.get` 抛 AttributeError（Node 侧同抛，不静默）
  assert.throws(() => runner.dshEventToLogLine(null),
    (e) => e.constructor.name === 'AttributeError'
      && e.message === "'NoneType' object has no attribute 'get'");
});

// ══════════════════════════════════════════════════════════════════════════
// 二、`_should_stop`（判据：Python oracle 实测；对拍用例也覆盖同一批档位）
// ══════════════════════════════════════════════════════════════════════════

test('shouldStop: rounds/bugs/deadline/duration/兜底 六档', () => {
  withFixture('runner-round-shouldstop', (fx) => {
    const r = parkedRunner(fx);
    const T = (o) => ({
      stop_type: 'rounds', stop_value: '1', new_bugs: 0, started_at: '', created_at: '', ...o,
    });
    assert.equal(r.shouldStop(T({ stop_value: '1' }), 1), true);
    assert.equal(r.shouldStop(T({ stop_value: '3' }), 2), false);
    assert.equal(r.shouldStop(T({ stop_type: 'bugs', new_bugs: 2, stop_value: '2' }), 1), true);
    assert.equal(r.shouldStop(T({ stop_type: 'deadline', stop_value: '2000-01-01T00:00' }), 1), true);
    assert.equal(r.shouldStop(T({ stop_type: 'deadline', stop_value: '2100-01-01T00:00' }), 1), false);
    // `stop_value=None` ⇒ Python `.replace` 抛 AttributeError 被吃 ⇒ False
    assert.equal(r.shouldStop(T({ stop_type: 'deadline', stop_value: null }), 1), false);
    assert.equal(r.shouldStop(T({ stop_type: 'duration', stop_value: '0',
      started_at: '2020-01-01 00:00:00' }), 1), true);
    assert.equal(r.shouldStop(T({ stop_type: 'duration', stop_value: '999999',
      started_at: '2026-10-13 00:00:00' }), 1), false);
    assert.equal(r.shouldStop(T({ stop_type: 'duration', stop_value: '5', started_at: '坏' }), 1), false);
    assert.equal(r.shouldStop(T({ stop_type: 'bogus' }), 1), true);
    assert.equal(r.shouldStop(T({ stop_type: 'bogus' }), 0), false);
    // 未知类型 + 非法轮数 ⇒ `int()` 的 ValueError 外抛（Python 的 rounds 支没有 try）
    assert.throws(() => r.shouldStop(T({ stop_value: 'abc' }), 1),
      (e) => e.constructor.name === 'ValueError');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、`_run_round` 的退场族守卫 + `_wait_turn_end_dsh` 五支
// ══════════════════════════════════════════════════════════════════════════

test('runRound: 非 dsh_plugin 抛 RuntimeError(RETIRED_MSG)（类名/文案两侧逐字同）', async () => {
  await withFixture('runner-round-retired', async (fx) => {
    const r = parkedRunner(fx);
    for (const agent of ['kimi', 'claude', '', 'retired']) {
      await assert.rejects(() => r.runRound({}, {}, 1, agent, { db: fx.db }),
        (e) => e.constructor.name === 'RuntimeError' && e.message === RETIRED_MSG);
    }
  });
});

test('waitTurnEndDsh: turn_end 三档（completed/aborted/缺失 reason 归一 aborted）+ 日志行', async () => {
  await withFixture('runner-round-wait-turnend', async (fx) => {
    const r = parkedRunner(fx);
    const { tid } = insertRoundTask(fx);
    const mk = (roundNo) => {
      const log = path.join(fx.dir, `task_${tid}_round_${roundNo}.log`);
      return { log, task: { id: tid } };
    };
    const cases = [
      [{ type: 'turn/end', data: { reason: 'completed' } }, 0, 'completed'],
      [{ type: 'turn/end', data: { reason: 'aborted' } }, 130, 'aborted'],
      // 缺失/null 的 reason 由 TurnWaiter 归一成 aborted（Python dshdriver.py:731-733 同款兜底）
      [{ type: 'turn/end', data: {} }, 130, 'aborted'],
      [{ type: 'turn/end', data: { reason: null } }, 130, 'aborted'],
      // dict 形态 reason（老版装机副本）取 `kind`
      [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }, 0, 'completed'],
      [{ type: 'turn/end', data: { reason: 'cancelled' } }, 1, 'cancelled'],
    ];
    let n = 0;
    for (const [frame, expect, reason] of cases) {
      n += 1;
      const { log, task } = mk(n);
      const code = await r.waitTurnEndDsh(task, 's-1', fedWaiter([frame]), log, { db: fx.db });
      assert.equal(code, expect);
      assert.equal(fs.readFileSync(log, 'utf8'), `### 轮次结束 turn_reason=${reason}\n`);
    }
  });
});

test('waitTurnEndDsh: interaction 先喂 ⇒ 记一行并继续等，直到 turn/end', async () => {
  await withFixture('runner-round-wait-interaction', async (fx) => {
    const r = parkedRunner(fx);
    const { tid } = insertRoundTask(fx);
    const log = path.join(fx.dir, 'interaction.log');
    const waiter = new TurnWaiter();
    waiter.feed({ type: 'driver/interaction', data: { state: 'asked' } });
    const pending = r.waitTurnEndDsh({ id: tid }, 's-1', waiter, log, { db: fx.db });
    // interaction 是 consume-on-read：第一次 wait 必然返回它，之后才轮到 turn/end
    setTimeout(() => waiter.feed({ type: 'turn/end', data: { reason: 'completed' } }), 20);
    const code = await pending;
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(log, 'utf8'),
      '### 会话等待人工输入（提问/审批）\n### 轮次结束 turn_reason=completed\n');
  });
});

test('waitTurnEndDsh: 链路错误 ⇒ 1；停止标记 ⇒ 130（并补一次 cancel）；宽限到期 ⇒ 1', async () => {
  await withFixture('runner-round-wait-branches', async (fx) => {
    const r = parkedRunner(fx);
    const { tid } = insertRoundTask(fx);

    // error 支：`fail()` 预置链路错误（空 waiter 只会超时，本支不可达）
    const logErr = path.join(fx.dir, 'err.log');
    const failed = new TurnWaiter();
    failed.fail('事件流被对端关闭');
    assert.equal(await r.waitTurnEndDsh({ id: tid }, 's-1', failed, logErr, { db: fx.db }), 1);
    assert.match(fs.readFileSync(logErr, 'utf8'), /^### 事件流异常: /);

    // 停止支：先 `stop(tid)` 置标记，再用「立即超时」替身把 5s tick 压成 0ms
    const { tid: tid2 } = insertRoundTask(fx);
    await r.stop(tid2, { db: fx.db });
    const logStop = path.join(fx.dir, 'stop.log');
    await withDriver({}, async (srv) => {
      const code = await r.waitTurnEndDsh({ id: tid2 }, 's-1', timeoutWaiter(), logStop, { db: fx.db });
      assert.equal(code, 130);
      // 兜底 cancel 真发出去了（照 Python：runner.stop 已调过一次，这里再补一次）
      assert.deepEqual(srv.seen.cancels, [{ session_id: 's-1', keep_inbox: false }]);
    });
    // cancel 成功 ⇒ 不落任何 cancel 行（appendLog 一次都没被调 ⇒ 文件都不建）
    assert.equal(fs.existsSync(logStop), false);
    // 停止支（驱动不可用）：cancel 抛 DshDriverError ⇒ 记一行、仍返回 130
    const logStop2 = path.join(fx.dir, 'stop2.log');
    assert.equal(await r.waitTurnEndDsh({ id: tid2 }, 's-1', timeoutWaiter(), logStop2,
      { db: fx.db }), 130);
    assert.match(fs.readFileSync(logStop2, 'utf8'), /^### cancel 失败: /);

    // 宽限支：`started=false` + 实例宽限置 -1 ⇒ 不真等 120s
    const { tid: tid3 } = insertRoundTask(fx);
    r.DSH_TURN_START_GRACE = -1;
    const logGrace = path.join(fx.dir, 'grace.log');
    assert.equal(await r.waitTurnEndDsh({ id: tid3 }, 's-1', timeoutWaiter(false), logGrace,
      { db: fx.db }), 1);
    assert.equal(fs.readFileSync(logGrace, 'utf8'), '### turn 未启动（-1s 未见 turn/start）\n');
    // `started=true` 时宽限不生效（只可能被下一个 tick 收口）⇒ 这里用 error 帧收口
    r.DSH_TURN_START_GRACE = 120.0;
    const logStarted = path.join(fx.dir, 'started.log');
    assert.equal(await r.waitTurnEndDsh({ id: tid3 }, 's-1', fedWaiter([
      { type: 'turn/start' }, { type: 'turn/end', data: { reason: 'aborted' } },
    ]), logStarted, { db: fx.db }), 130);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、`_run_round_dshplugin` 整轮（真 HTTP 罐头驱动：真 SSE 解码 + 真 TurnWaiter）
// ══════════════════════════════════════════════════════════════════════════

test('runRoundDshplugin: 驱动不可用 ⇒ 轮次 failed/-1、任务 error、sid 不变', async () => {
  await withFixture('runner-round-nodriver', async (fx) => {
    const old = process.env.TS_AGENT_DRIVER_URL;
    delete process.env.TS_AGENT_DRIVER_URL;
    try {
      const r = parkedRunner(fx);
      const { tid, pid } = insertRoundTask(fx, { taskType: 'normal' });
      const [code, sid] = await r.runRoundDshplugin(projectView(fx, pid),
        taskView(tid, pid), 1, { db: fx.db });
      assert.equal(code, -1);
      assert.equal(sid, '');
      const round = fx.db.prepare('SELECT * FROM rounds WHERE task_id=?').get(tid);
      assert.equal(round.status, 'failed');
      assert.equal(round.exit_code, -1);
      assert.equal(round.kind, 'agent');
      assert.equal(round.summary,
        'dsh 驱动调用失败: dsh agent 驱动不可用（插件未安装/未启用，或 agents 服务未就绪）');
      assert.equal(round.log_path, path.join(fx.dir, '.web', `task_${tid}_round_1.log`));
      const task = fx.db.prepare('SELECT * FROM tasks WHERE id=?').get(tid);
      assert.equal(task.error, round.summary);
      // 该支在第一次 append_log **之前**就抛了 ⇒ 日志文件根本不存在
      assert.equal(fs.existsSync(round.log_path), false);
    } finally {
      if (old !== undefined) process.env.TS_AGENT_DRIVER_URL = old;
    }
  });
});

test('runRoundDshplugin: 整轮成功 —— SSE 帧落日志、turn/end 收口、summary/new_bugs 落库', async () => {
  const frames = [
    { seq: 8, type: 'turn/start', data: {} },
    { seq: 9, type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '干活中' }] } } },
    { seq: 10, type: 'assistant/message', data: { message: { content: [{ type: 'tool_use' }] } } },
    { seq: 11, type: 'tool/call', data: { name: 'shell', arguments: '{"cmd": "ls"}' } },
    { seq: 12, type: 'tool/result',
      data: { message: { toolCallId: 'c9', content: 'ok' }, error: { name: 'Err', code: 3,
        reason: '非零' } } },
    { seq: 13, type: 'user/message', data: {} },              // ⇒ null（不得写出字面量 null 行）
    { seq: 14, type: 'agent/status', data: {} },              // ⇒ null
    { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'text',
      text: '交付完毕' }] }, interrupted: true } },
    { seq: 16, type: 'turn/end', data: { reason: 'completed' } },
  ];
  await withDriver({ frames }, async () => {
    await withFixture('runner-round-ok', async (fx) => {
      const r = parkedRunner(fx);
      const { tid, pid } = insertRoundTask(fx, { taskType: 'normal', model: 'prov/m-1' });
      // live.json：轮次摘要 + new_bugs 的来源
      fs.mkdirSync(path.join(fx.dir, '.live'), { recursive: true });
      fs.writeFileSync(path.join(fx.dir, '.live', 'live.json'),
        '{"phase": "done", "round": 1, "stats": {"passed": 4, "new_bug_reports": 2},'
        + ' "stop_condition": {"type": "rounds"}}', 'utf8');
      const [code, sid] = await r.runRoundDshplugin(projectView(fx, pid),
        taskView(tid, pid, { model: 'prov/m-1' }), 1, { db: fx.db });
      assert.equal(code, 0);
      assert.equal(sid, 's-canned');
      const round = fx.db.prepare('SELECT * FROM rounds WHERE task_id=?').get(tid);
      assert.equal(round.status, 'done');
      assert.equal(round.exit_code, 0);
      assert.equal(round.summary, '{"phase": "done", "round": 1, "stats": {"passed": 4,'
        + ' "new_bug_reports": 2}, "stop_condition": {"type": "rounds"}}');
      const task = fx.db.prepare('SELECT * FROM tasks WHERE id=?').get(tid);
      assert.equal(task.session_id, 's-canned');
      assert.equal(task.new_bugs, 2);
      const log = fs.readFileSync(round.log_path, 'utf8');
      // 订阅先于投递 ⇒ turn/start 之前的空窗不漏帧；帧按到达顺序落盘
      assert.ok(log.includes('### 会话 s-canned（dsh 插件·进程内常驻）\n'));
      assert.ok(log.includes('{"role": "meta", "type": "session.resume_hint",'
        + ' "session_id": "s-canned"}\n'));
      assert.ok(log.includes('### PROMPT '));
      assert.ok(log.includes('{"role": "assistant", "content": "干活中", "tool_calls": []}\n'));
      assert.ok(log.includes('{"role": "assistant", "content": "", "tool_calls":'
        + ' [{"function": {"name": "shell", "arguments": "{\\"cmd\\": \\"ls\\"}"}}]}\n'));
      assert.ok(log.includes('{"role": "tool", "tool_call_id": "c9", "content":'
        + ' "ok\\n[工具错误 Err: 3 非零]"}\n'));
      assert.ok(log.includes('{"role": "assistant",'
        + ' "content": "（本轮被中断，以下为已交付内容）交付完毕", "tool_calls": []}\n'));
      assert.ok(log.includes('### 轮次结束 turn_reason=completed\n'));
      assert.ok(log.includes('### 轮次 1 结束 '));
      // 差异㊵：`null` 行一个字节都不许落盘（Python 侧是 AttributeError 被 feed_into 吞掉）
      assert.equal(log.split('\n').includes('null'), false);
    });
  });
});

test('runRoundDshplugin: turn/end=aborted ⇒ 轮次 failed/130、任务不改 new_bugs', async () => {
  await withDriver({ frames: [{ seq: 1, type: 'turn/start', data: {} },
    { seq: 2, type: 'turn/end', data: { reason: 'aborted' } }] }, async () => {
    await withFixture('runner-round-aborted', async (fx) => {
      const r = parkedRunner(fx);
      const { tid, pid } = insertRoundTask(fx, { taskType: 'normal' });
      const [code] = await r.runRoundDshplugin(projectView(fx, pid),
        taskView(tid, pid), 1, { db: fx.db });
      assert.equal(code, 130);
      const round = fx.db.prepare('SELECT * FROM rounds WHERE task_id=?').get(tid);
      assert.equal(round.status, 'failed');
      assert.equal(round.exit_code, 130);
      assert.equal(round.summary, '');                    // 无 live.json ⇒ 摘要空串
      assert.equal(fx.db.prepare('SELECT new_bugs FROM tasks WHERE id=?').get(tid).new_bugs, 0);
    });
  });
});

test('runRoundDshplugin: 项目思考等级非空 ⇒ 下发 /model 并把告警行落日志', async () => {
  await withDriver({ frames: [{ seq: 1, type: 'turn/end', data: { reason: 'completed' } }] },
    async (srv) => {
      await withFixture('runner-round-effort', async (fx) => {
        const r = parkedRunner(fx);
        const { tid, pid } = insertRoundTask(fx, { taskType: 'normal' });
        const proj = projectView(fx, pid);
        proj.reasoning_effort = 'high';
        await r.runRoundDshplugin(proj, taskView(tid, pid), 1, { db: fx.db });
        assert.deepEqual(srv.seen.models, [{ session_id: 's-canned', model: '',
          reasoning_effort: 'high' }]);
        const round = fx.db.prepare('SELECT * FROM rounds WHERE task_id=?').get(tid);
        assert.ok(fs.readFileSync(round.log_path, 'utf8')
          .includes('### 会话默认思考等级 effort=high\n'));
      });
    });
});
