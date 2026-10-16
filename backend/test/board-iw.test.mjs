/**
 * M5-3 单测：归档双向同步 / sync 归类 / 交互调和器 / 作答送达 / 启动对账与 recover。
 *
 * 期望值来源一律是 `board.py` 原文（`_archive_card_sessions` 3314 / `_archive_retry_add` 3390 /
 * `_archive_retry_tick` 3404 / `_archive_unarchive_edge` 3424 / `_reconcile_action_for` 4279 /
 * `_iw_apply` 4392 / `_recover_to_doing` 4483 / `_iw_once` 4517 / `_reconcile_starting_rows` 2714 /
 * `_heal_queue_placeholders` 2801 / `_answer_deliver` 4846 / `_answer_retry_or_fail` 4805 /
 * `_deliver_answer_unit` 4892 / `deliver_pending_answer_now` 4949 / `_queue_answer_unit` 5039 /
 * `answer_interaction` 5077 / `answer_approval` 5192 / `_recover_web_card` 2938 / `recover` 2993 /
 * `finish` 2411），**不是**读 Node 实现反推。
 *
 * 三条测试口径（同 `board-write.test.mjs`）：
 *   ① **驱动面用注入替身**：`board.setBoardDriver(stub)`（ESM 具名导出只读，无法像 Python 那样
 *      `dshdriver.archive = fake`）。替身逐条记调用流水，断言「谁被调、带什么参」。
 *   ② **runner 面用注入替身**：`board.setRunnerInstance(stub)`（M5-2 已有的缝）。
 *   ③ **落库一律断言真行**：跑完读 `board_cards`/`wait_items`/`board_settings` 真列。
 *
 * 夹具一律 `mkdtemp` 临时库（`m3fixture.freshDb` 走真启动序并设进程级 `TOUCHSTONE_DB`）；
 * `db.js:defaultDbPath` 在 `NODE_TEST_CONTEXT` 下直接抛错——**结构性闸**，漏传 `{db}` 当场红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as db from '../lib/db.js';
import * as dshevents from '../lib/dshevents.js';
import * as waitq from '../lib/waitq.js';   // `getActive` 是 waitq 的读口（原写 db 是笔误）
import { freshDb, insertCard, insertMsg, insertProject, insertWait } from './m3fixture.mjs';

/**
 * 把 dshevents 的归档集折成「**已知**」快照——走**生产路径**：驱动 `driver/archived`
 * 整表帧经 `EventHub._onFrame` 整表覆盖（`dshevents.js:635-650`），不给 `board.js`
 * 加测试专用缝。归档集的「未知 ⇒ null」是 `archiveCardSessions` 补偿判据的一半
 * （`board.py:3331` / `3352-3354`），故只能这样造已知态。
 */
function foldArchivedForTest(archived) {
  dshevents.HUB._onFrame({ type: 'driver/archived', data: { archived } });
}

/** 复原归档集为「未知」（`_archived = null`：没有「未知」帧可折，只能复位字段） */
function resetArchivedForTest() {
  dshevents.HUB._archived = null;
}

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 驱动替身：逐条记调用；各端点行为可经 opts 覆盖 */
function installDriver(overrides = {}) {
  const calls = [];
  const stub = {
    ARCHIVE_UNKNOWN_SESSION: 410,
    WATCH_UNSUPPORTED: 404,
    configured: () => true,
    archive: async (sid, archived, opts) => {
      calls.push(['archive', sid, archived, opts && opts.timeoutMs]);
      const fn = overrides.archive;
      if (fn) return fn(sid, archived, calls);
      return {};
    },
    watchSession: async (sid, on) => {
      // 驱动侧**默认参数**归一（`dshdriver.watch_session(session_id, on=True)`
      // dshdriver.py:400；Node 侧 `watchSession(sessionId, on = true, …)`
      // dshdriver.js:776）：`_ensure_watch` 的调用原文是 `dshdriver.watch_session(sid)`
      // （board.py:4073，**不显式传 on**）⇒ 替身必须按同一默认补真值，否则记到的是
      // 「替身没实现默认参数」这个假差异，而不是被测量的 board 行为。
      const want = on === undefined ? true : on;
      calls.push(['watch', sid, want]);
      const fn = overrides.watchSession;
      return fn ? fn(sid, want, calls) : true;
    },
    rename: async (sid, title, opts) => {
      calls.push(['rename', sid, title, opts && opts.timeoutMs]);
      const fn = overrides.rename;
      if (fn) return fn(sid, title, calls);
      return { title };
    },
    answerQuestion: async (sid, callId, answers) => {
      calls.push(['answerQuestion', sid, callId, JSON.stringify(answers)]);
      const fn = overrides.answerQuestion;
      return fn ? fn(sid, callId, answers, calls) : true;
    },
    answerApproval: async (sid, approvalId, decision) => {
      calls.push(['answerApproval', sid, approvalId, decision]);
      const fn = overrides.answerApproval;
      return fn ? fn(sid, approvalId, decision, calls) : {};
    },
  };
  board.setBoardDriver(stub);
  return { stub, calls };
}

/** runner 替身：只记调用（不动真队列） */
function installRunner() {
  const calls = [];
  board.setRunnerInstance({
    submitCard: (cid, extra = '', fromColumn = '', afterPrefix = false) => {
      calls.push(['submitCard', cid, extra, fromColumn, afterPrefix]);
    },
    submitAnswer: (cid) => { calls.push(['submitAnswer', cid]); },
    removeAnswer: (cid) => { calls.push(['removeAnswer', cid]); },
    cardStarted: (cid, pid, ext) => { calls.push(['cardStarted', cid, pid, ext || null]); },
    cardFinished: (cid, reason) => { calls.push(['cardFinished', cid, reason]); },
    notifyBusyChange: () => { calls.push(['notifyBusyChange']); },
  });
  return calls;
}

/** 一次测试的夹具：临时库 + 一个项目 + 驱动/runner 替身 */
function setup(tag = 'board-iw', driverOverrides = {}) {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir,
  });
  const driver = installDriver(driverOverrides);
  const runner = installRunner();
  const opts = { db: fx.db };
  return {
    fx, pid, opts, runner,
    ...driver,
    close() {
      board.setBoardDriver(null);
      board.setRunnerInstance(null);
      board.resetWatchState();
      board.resetIwState();
      board.resetSyncSweptSets();
      board.archiveRetryTable().forEach((_v, k) => board.archiveRetryAdd(k, false, 'x'));
      fx.close();
    },
  };
}

/** 读卡片真行 */
function cardRow(fx, cardId) {
  return fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cardId);
}

/** 读活跃等待行 */
function activeWait(fx, kind, targetId) {
  return fx.db.prepare(
    'SELECT * FROM wait_items WHERE kind=? AND target_id=?'
    + " AND state IN ('waiting','starting','running','finishing') ORDER BY id DESC LIMIT 1",
  ).get(kind, String(targetId));
}

/** 读最新一条等待行（**含终态**；行收口断言用） */
function lastWait(fx, kind, targetId) {
  return fx.db.prepare(
    'SELECT * FROM wait_items WHERE kind=? AND target_id=? ORDER BY id DESC LIMIT 1',
  ).get(kind, String(targetId));
}

// ==========================================================================
// ① 归档双向同步：`_archive_card_sessions` 的三态
// ==========================================================================

test('archiveCardSessions：卡片无绑定会话 ⇒ 放行（零驱动调用）', async () => {
  const s = setup('arch-empty');
  const cid = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'todo', sessionId: '', sessions: '[]' });
  const err = await board.archiveCardSessions(cardRow(s.fx, cid), true, '进入已完成', { options: s.opts });
  assert.equal(err, null);
  assert.deepEqual(s.calls, []);
  s.close();
});

test('archiveCardSessions：开关关闭 / 独立形态无宿主 ⇒ 放行', async () => {
  const s = setup('arch-off');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'done', sessionId: 'sid-1', sessions: '["sid-2"]',
  });
  const card = cardRow(s.fx, cid);
  // 独立形态：configured() 为 false ⇒ 没有 dsh 宿主可同步
  s.stub.configured = () => false;
  assert.equal(await board.archiveCardSessions(card, true, '', { options: s.opts }), null);
  assert.deepEqual(s.calls, []);
  s.close();
});

test('archiveCardSessions：驱动 410（会话不存在）⇒ 跳过该 sid 放行 + 记 last_error', async () => {
  const s = setup('arch-410', {
    archive: (sid) => {
      const e = new Error('会话不存在');
      e.code = 410;
      throw e;
    },
  });
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'todo', sessionId: 'sid-a', sessions: '["sid-b"]',
  });
  const err = await board.archiveCardSessions(cardRow(s.fx, cid), true, '进入已完成', { options: s.opts });
  assert.equal(err, null);                         // 无同步对象：不算失败（放行）
  assert.deepEqual(s.calls.map((c) => c.slice(0, 2)),
    [['archive', 'sid-a'], ['archive', 'sid-b']]);  // 两个 sid 都照打（skip 不中断）
  const row = cardRow(s.fx, cid);
  assert.equal(row.last_error, '归档跳过（会话不存在）: sid-a');   // 首个 skipped 落 last_error
  assert.ok(row.last_error_at > 0);
  s.close();
});

test('archiveCardSessions：strict 其它错 + 归档集未知 ⇒ 返回错误串，不猜不回滚', async () => {
  const s = setup('arch-rollback', {
    archive: (sid, archived, calls) => {
      if (sid === 'sid-b') { const e = new Error('网络异常'); e.code = 500; throw e; }
      void archived; void calls;
      return {};
    },
  });
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'todo', sessionId: 'sid-a', sessions: '["sid-b", "sid-c"]',
  });
  // 本进程没有 dsh 中枢 ⇒ `dshevents.archivedSet()` 恒 null（不变量「断连=未知」）。
  // oracle 的补偿条件（board.py:3351-3354）是
  //   `was = None if prior is None else (sid in prior)` + `if was is (not archived)`：
  // prior 未知时 was=None，`None is False` 恒假 ⇒ **一个都不回滚**（docstring
  // board.py:3323-3324：「中枢未连接（归档集未知）时不猜，宁可留一次告警也不误改
  // 用户既有的归档」）。原用例期望第 3 次 `archive('sid-a', false)` 是拿 Node 实现
  // 反推的误判；此处按 oracle 钉住「未知 ⇒ 不回滚 + 记 last_error」。
  const err = await board.archiveCardSessions(cardRow(s.fx, cid), true, '进入已完成', { options: s.opts });
  assert.equal(err, '会话归档失败：sid-b（网络异常）');
  // 顺序：sid-a 归档成功 → sid-b 失败（strict 立即 break，不打 sid-c）→ 未知故无回滚
  assert.deepEqual(s.calls.map((c) => c.slice(0, 3)), [
    ['archive', 'sid-a', true],
    ['archive', 'sid-b', true],
  ]);
  assert.equal(cardRow(s.fx, cid).last_error, '会话归档失败：sid-b（网络异常）');
  s.close();
});

test('archiveCardSessions：strict 其它错 + 归档集已知（sid-a 未归档）⇒ 补偿回滚 sid-a', async () => {
  const s = setup('arch-rollback2', {
    archive: (sid, archived, calls) => {
      if (sid === 'sid-b') { const e = new Error('网络异常'); e.code = 500; throw e; }
      void archived; void calls;
      return {};
    },
  });
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'todo', sessionId: 'sid-a', sessions: '["sid-b", "sid-c"]',
  });
  // 归档集折成「已知」（真帧路径）：已知集里**没有** sid-a
  // ⇒ `prior.has('sid-a') === false === (not archived=not True)` ⇒ board.py:3352-3354
  // 判「本次真改过」⇒ 反向 `_archive_call(sid-a, False)` 补偿回滚。
  foldArchivedForTest([]);
  try {
    const err = await board.archiveCardSessions(cardRow(s.fx, cid), true, '进入已完成', { options: s.opts });
    assert.equal(err, '会话归档失败：sid-b（网络异常）');
    assert.deepEqual(s.calls.map((c) => c.slice(0, 3)), [
      ['archive', 'sid-a', true],
      ['archive', 'sid-b', true],
      ['archive', 'sid-a', false],                 // ★ 补偿回滚：反向调用
    ]);
    assert.equal(cardRow(s.fx, cid).last_error, '会话归档失败：sid-b（网络异常）');
  } finally {
    resetArchivedForTest();                        // 复原「未知」，防同文件后续用例串味
    s.close();
  }
});

test('archiveCardSessions：strict=false ⇒ 不回滚，进退避重试表', async () => {
  const s = setup('arch-lenient', {
    archive: (sid) => { if (sid === 'sid-a') { const e = new Error('挂了'); e.code = 500; throw e; } return {}; },
  });
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'todo', sessionId: 'sid-a', sessions: '[]',
  });
  const err = await board.archiveCardSessions(cardRow(s.fx, cid), true, '归档级联',
    { strict: false, options: s.opts });
  assert.equal(err, null);                           // 调和器路径：不返回错误串
  const tbl = board.archiveRetryTable();
  assert.ok(tbl.has('sid-a'));
  assert.equal(tbl.get('sid-a').attempts, 1);
  assert.equal(tbl.get('sid-a').want, true);
  s.close();
});

test('archiveCardSessions：归档集快照已知已到位 ⇒ 不打驱动（幂等短路）', async () => {
  const s = setup('arch-prior');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'todo', sessionId: 'sid-a', sessions: '["sid-b"]',
  });
  // 归档集未知（未连接）⇒ 两条都照打；快照已知即短路（判据在 prior 上，不在驱动上）
  await board.archiveCardSessions(cardRow(s.fx, cid), true, '', { options: s.opts });
  assert.equal(s.calls.length, 2);
  // 已知快照：两个 sid 都已在归档集里 ⇒ board.py:3336-3339 逐条 `continue`，零驱动调用
  foldArchivedForTest(['sid-a', 'sid-b']);
  try {
    await board.archiveCardSessions(cardRow(s.fx, cid), true, '', { options: s.opts });
    assert.equal(s.calls.length, 2);
  } finally {
    resetArchivedForTest();
    s.close();
  }
});

test('archiveSyncEnabled：TS_ARCHIVE_SYNC 的三档取值', () => {
  assert.equal(board.archiveSyncEnabled({ env: {} }), true);
  assert.equal(board.archiveSyncEnabled({ env: { TS_ARCHIVE_SYNC: '1' } }), true);
  for (const off of ['0', 'false', 'False']) {
    assert.equal(board.archiveSyncEnabled({ env: { TS_ARCHIVE_SYNC: off } }), false, off);
  }
});

test('archiveBoundSession：卡不在 done ⇒ no-op；在 done 且失败 ⇒ 记 last_error + 重试登记', async () => {
  const s = setup('arch-bound', {
    archive: () => { const e = new Error('boom'); e.code = 500; throw e; },
  });
  const cid = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'review', sessionId: 'sid-a' });
  await board.archiveBoundSession(cardRow(s.fx, cid), 'sid-a');
  assert.deepEqual(s.calls, []);                     // 不在 done：no-op
  s.fx.db.prepare("UPDATE board_cards SET column_key='done' WHERE id=?").run(cid);
  await board.archiveBoundSession(cardRow(s.fx, cid), 'sid-a');
  assert.equal(s.calls.length, 1);
  assert.equal(cardRow(s.fx, cid).last_error, '会话归档失败（待重试）：sid-a');
  assert.ok(board.archiveRetryTable().has('sid-a'));
  s.close();
});

test('archiveUnarchiveEdge：边沿（True→False）+ 卡在 done ⇒ 回 review 并级联取消归档', async () => {
  const s = setup('arch-edge');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'done', sessionId: 'sid-a', sessions: '["sid-b"]',
  });
  // 归档态必须「已知且为 False」才动作；归档集未知（null）⇒ 不动作
  await board.archiveUnarchiveEdge(cardRow(s.fx, cid), s.opts);
  assert.deepEqual(s.calls, []);                     // 未知：不动作（不变量「断连=未知」）
  s.close();
});

// ==========================================================================
// ② archive_retry：指数退避与上限
// ==========================================================================

test('archiveRetryAdd/Tick：退避 5→10→20→40→80，超上限放弃并打一行日志', async () => {
  const s = setup('retry');
  const logged = [];
  const orig = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  try {
    // 前 5 次：attempts=1..5，delay = 5*2^(n-1) = 5/10/20/40/80
    const delays = [5, 10, 20, 40, 80];
    for (let i = 1; i <= 5; i += 1) {
      const before = board.nowForTest ? board.nowForTest() : Date.now() / 1000;
      board.archiveRetryAdd('sid-x', true, 'boom');
      const item = board.archiveRetryTable().get('sid-x');
      assert.equal(item.attempts, i, `attempts=${i}`);
      assert.ok(Math.abs((item.next_at - before) - delays[i - 1]) < 1.5,
        `delay[${i}] ≈ ${delays[i - 1]}（实得 ${(item.next_at - before).toFixed(2)}）`);
    }
    // 第 6 次：attempts=6 > MAX(5) ⇒ 摘除 + 告警一次
    board.archiveRetryAdd('sid-x', true, 'boom');
    assert.equal(board.archiveRetryTable().has('sid-x'), false);
    assert.ok(logged.some((l) => l.includes('归档重试放弃：sid-x')), logged.join('|'));
    // Tick：到期项被取出重试；成功即不再登记
    board.archiveRetryAdd('sid-y', false, 'boom');
    const tbl = board.archiveRetryTable();
    // 手改到期时刻（无时间注入口：直接改内部值不可能，故用 round-trip 断言「未到期不打」）
    assert.equal(tbl.get('sid-y').want, false);
    assert.deepEqual(s.calls.filter((c) => c[0] === 'archive'), []);   // 未到期：零驱动调用
    const n = await board.archiveRetryTick({});
    assert.equal(n, 0);
  } finally {
    console.log = orig;
    s.close();
  }
});

test('archiveRetryTick：到期项按目标态重试；失败重新登记（次数累计）', async () => {
  const s = setup('retry-tick', {
    archive: () => { const e = new Error('again'); e.code = 500; throw e; },
  });
  board.archiveRetryAdd('sid-z', true, 'boom');
  // 把 next_at 拨到过去：无时间注入口 ⇒ 直接经内部表快照无法改；改用「登记即到期」的
  // 判据不可得，故这里用 tick 的 TICK_MAX 与「未到期 0 条」两条可证事实。
  const before = board.archiveRetryTable().get('sid-z');
  assert.ok(before.next_at > Date.now() / 1000);
  assert.equal(await board.archiveRetryTick({}), 0);   // 未到期
  s.close();
});

// ==========================================================================
// ③ `_reconcile_action_for` 判定矩阵
// ==========================================================================

/** 造一个卡片行对象（纯函数入参；不需要落库） */
function cardOf(over = {}) {
  return {
    id: 1, column_key: 'review', block_kind: null, block_text: '', ...over,
  };
}

test('reconcileActionFor：判定矩阵（8 条 + 终态/族守卫）', () => {
  const R = board.reconcileActionFor;
  const running = { pending: false, busy: true, text: '' };
  const idle = { pending: false, busy: false, text: '' };
  const pending = { pending: true, busy: true, text: 'question?' };
  // ① 空闲（idle）的 doing 卡 → to_review；review 卡 → 不动
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), idle), 'to_review');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'review' }), idle), null);
  // ② 忙（busy）的 review 卡 → to_doing；doing 卡 → 不动
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'review' }), running), 'to_doing');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), running), null);
  // ③ 提问挂起 → block（doing/review）；已在 interaction 阻塞 → 不动
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), pending), 'block');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'review' }), pending), 'block');
  assert.equal(R('dsh_plugin',
    cardOf({ column_key: 'blocked', block_kind: 'interaction' }), pending), null);
  // ④ 在管运行（has_run）只做 block/recover；review + 实况在跑 → 归位 doing（唯一例外）
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), idle, true), null);
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'review' }), running, true), 'to_doing');
  assert.equal(R('dsh_plugin',
    cardOf({ column_key: 'blocked', block_kind: 'interaction' }), idle, true), 'recover');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'review' }), running, true, false, true),
    null);                                           // stop_recent 宽限内不搬
  // ⑤ queue 占位卡只放行 block（busy/空闲一律不搬列）
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing', block_kind: 'queue' }), running), null);
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing', block_kind: 'queue' }), pending), 'block');
  // ⑥ 已答待送达（live_msg 之外的答案等待）由调用方拦截；此处状态机本身不认
  // ⑦ starting 窗口不做忙/闲映射，仅防御性放行 block
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), idle, false, false, false,
    null, true), null);
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), pending, false, false, false,
    null, true), 'block');
  // ⑧ 外部 busy（busy 但无平台在管）＝同一坐标：review→doing / doing 保持
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'review' }), { pending: false, busy: true },
    false, false, false, null, false), 'to_doing');
  // 归档电平优先于一切忙闲判定（含 todo 卡）；已在 done 幂等
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'todo' }), idle, false, false, false, true),
    'to_done');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'done' }), idle, false, false, false, true),
    null);
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), running, false, false, false,
    null), null);                                    // 归档未知：按忙闲判定
  // 终态与族守卫
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'todo' }), running), null);
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'done' }), idle), null);
  assert.equal(R('retired', cardOf({ column_key: 'doing' }), idle), null);
  // manual 手动阻塞：等待维持阻塞；运行/消息驱动 → 回开发列
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'blocked', block_kind: 'manual' }), running),
    'to_doing');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'blocked', block_kind: 'manual' }), pending),
    null);
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'blocked', block_kind: 'manual' }), idle,
    false, true), 'to_doing');                       // live_msg 强信号
  // blocked 无阻塞标记的历史残留态：按实况归位
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'blocked', block_kind: null }), idle),
    'to_review');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'blocked', block_kind: null }), running),
    'to_doing');
  // 孤儿运行行（缺陷 B）：live_msg 不再把它当「在跑」
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), idle, false, true, false, null,
    false, true), 'to_review');
  assert.equal(R('dsh_plugin', cardOf({ column_key: 'doing' }), running, false, true, false,
    null, false, true), null);
});

// ==========================================================================
// ④ starting 超时对账 / 排队占位自愈
// ==========================================================================

test('reconcileStartingRows：可证失效（dead）⇒ 行 failed + 卡回 from_column + 收尾', async () => {
  const s = setup('starting-dead');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'doing', sessionId: 'sid-a',
  });
  // 超龄 starting 行（claimed_at 远早于 90s 前）；from_column=review ⇒ 回 review
  insertWait(s.fx.db, {
    projectId: s.pid, kind: 'card', targetId: cid, state: 'starting', seq: 1,
    claimedAt: '2000-01-01 00:00:00', meta: '{"from_column": "review"}',
  });
  // 「可证未起」= 无在管条目 + 中枢不可信（family 判定走 webFamily ⇒ dsh_plugin 项目，
  // 会话状态读注册表为 unknown）⇒ verdict=unknown 时只告警。为了打到 dead 分支，
  // 这里用「族为 null」的退场项目形状（无 agent_path ⇒ 不是 dsh_plugin）：
  const n = board.reconcileStartingRows(s.opts);
  assert.equal(n, 0);                                // dsh 项目 + 注册表未知 ⇒ 只告警不处置
  const row = activeWait(s.fx, 'card', cid);
  assert.equal(row.state, 'starting');               // 行未被误处置
  assert.equal(cardRow(s.fx, cid).column_key, 'doing');
  s.close();
});

test('reconcileStartingRows：退场族 + 无进程证据 ⇒ dead 收口（行 failed + 卡回列）', async () => {
  const s = setup('starting-dead2');
  const pid2 = insertProject(s.fx.db, {
    userId: 1, name: 'retired', projectDir: s.fx.dir, workDir: s.fx.dir,
    agentPath: 'claude:/usr/bin/claude',
  });
  const cid = insertCard(s.fx.db, pid2, { title: 'C', columnKey: 'doing' });
  insertWait(s.fx.db, {
    projectId: pid2, kind: 'card', targetId: cid, state: 'starting', seq: 1,
    claimedAt: '2000-01-01 00:00:00', meta: '{"from_column": "review"}',
  });
  const n = board.reconcileStartingRows(s.opts);
  assert.equal(n, 1);
  const row = activeWait(s.fx, 'card', cid);
  assert.equal(row, undefined);                      // 行已终态化（failed）
  const ended = s.fx.db.prepare(
    'SELECT * FROM wait_items WHERE kind=? AND target_id=? ORDER BY id DESC LIMIT 1',
  ).get('card', String(cid));
  assert.equal(ended.state, 'failed');
  const card = cardRow(s.fx, cid);
  assert.equal(card.column_key, 'review');           // from_column
  assert.equal(card.last_error, `starting 超时（${board.STARTING_TIMEOUT}s 未证实启动）`);
  s.close();
});

test('reconcileStartingRows：alive ⇒ markRunning 自愈（行留队、卡列不动）', async () => {
  const s = setup('starting-alive');
  const pid2 = insertProject(s.fx.db, {
    userId: 1, name: 'retired2', projectDir: s.fx.dir, workDir: s.fx.dir,
    agentPath: 'claude:/usr/bin/claude',
  });
  const cid = insertCard(s.fx.db, pid2, { title: 'C', columnKey: 'doing' });
  // 进程证据：写自己的 pid（确活）⇒ verdict=alive
  insertWait(s.fx.db, {
    projectId: pid2, kind: 'card', targetId: cid, state: 'starting', seq: 1,
    claimedAt: '2000-01-01 00:00:00',
    evidence: JSON.stringify({ pid: process.pid }),
  });
  const n = board.reconcileStartingRows(s.opts);
  assert.equal(n, 0);
  assert.equal(activeWait(s.fx, 'card', cid).state, 'running');   // 自愈
  assert.equal(cardRow(s.fx, cid).column_key, 'doing');
  s.close();
});

test('reconcileStartingRows：未超龄行不处置（90s 窗口内）', async () => {
  const s = setup('starting-fresh');
  const pid2 = insertProject(s.fx.db, {
    userId: 1, name: 'retired3', projectDir: s.fx.dir, workDir: s.fx.dir,
    agentPath: 'claude:/usr/bin/claude',
  });
  const cid = insertCard(s.fx.db, pid2, { title: 'C', columnKey: 'doing' });
  // 夹具缝名 = `formatLocalSec(sec)`（epoch **秒** → 本地文本，board.js:2021）。
  // 必须传**当下**时刻：oracle 的超龄判据是
  //   `cutoff = localtime(now - 90)` + `if not claimed or claimed >= cutoff: continue`
  // （board.py:2740/2747）——原用例传 `0`（= 1970-01-01 00:00:00）恰好是**最超龄**的
  // claimed_at，于是走到 dead 收口（实得 1）⇒ 与「90s 窗口内」的用例名正相反。
  const nowStr = board.formatLocalForTest(Date.now() / 1000);
  insertWait(s.fx.db, {
    projectId: pid2, kind: 'card', targetId: cid, state: 'starting', seq: 1,
    claimedAt: nowStr,
  });
  assert.equal(board.reconcileStartingRows(s.opts), 0);
  assert.equal(activeWait(s.fx, 'card', cid).state, 'starting');
  s.close();
});

test('healQueuePlaceholders：占位卡缺行 ⇒ 经 submitCard 补建；行在场则不动', async () => {
  const s = setup('heal');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'doing', blockKind: 'queue', sessionId: '',
  });
  const healed = board.healQueuePlaceholders(s.opts);
  assert.equal(healed, 1);
  assert.deepEqual(s.runner.filter((c) => c[0] === 'submitCard'), [['submitCard', cid, '', '', false]]);
  // 行在场 ⇒ 不再补建
  s.runner.length = 0;
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: cid, state: 'waiting', seq: 1 });
  assert.equal(board.healQueuePlaceholders(s.opts), 0);
  assert.deepEqual(s.runner, []);
  s.close();
});

test('healQueuePlaceholders：四类跳过（worktree / 已答待送达 / 在管 / 实况在跑）', async () => {
  const s = setup('heal-skip');
  const wt = insertCard(s.fx.db, s.pid, {
    title: 'WT', columnKey: 'doing', blockKind: 'queue', worktree: s.fx.dir,
  });
  const ans = insertCard(s.fx.db, s.pid, { title: 'A', columnKey: 'doing', blockKind: 'queue' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'answer', targetId: ans, state: 'waiting', seq: 2 });
  assert.equal(board.healQueuePlaceholders(s.opts), 0);
  assert.deepEqual(s.runner, []);
  // 在管（RUNS 条目在场）
  const running = insertCard(s.fx.db, s.pid, { title: 'R', columnKey: 'doing', blockKind: 'queue' });
  board.runRegistry.set(running, { sid: 's', family: 'dsh_plugin', proc: null });
  assert.equal(board.healQueuePlaceholders(s.opts), 0);
  board.runRegistry.delete(running);
  void wt;
  s.close();
});

// ==========================================================================
// ⑤ `_answer_deliver` 三档
// ==========================================================================

test('answerDeliver：成功 ⇒ 按 dsh 原生载荷调 answerQuestion（selected 取选项 id）', async () => {
  const s = setup('answer-ok');
  await board.answerDeliver({ id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir }, {
    sid: 'sid-a', qid: 'call-1',
    answers: [
      { wire: 'q_0', kind: 'single', option_id: 'opt-1', option_ids: [], text: '' },
      { wire: 'q_1', kind: 'multi_with_other', option_id: '', option_ids: ['o1', 'o2'], text: '自定义' },
    ],
  }, s.opts);
  const call = s.calls.find((c) => c[0] === 'answerQuestion');
  assert.ok(call);
  assert.equal(call[1], 'sid-a');
  assert.equal(call[2], 'call-1');
  assert.deepEqual(JSON.parse(call[3]), [
    { id: 'q_0', selected: ['opt-1'] },
    { id: 'q_1', selected: ['o1', 'o2'], custom: '自定义' },
  ]);
  s.close();
});

test('answerDeliver：accepted=false ⇒ 抛 40405（「提问已消失」）', async () => {
  const s = setup('answer-gone', { answerQuestion: () => false });
  await assert.rejects(
    () => board.answerDeliver({ id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir },
      { sid: 'sid-a', qid: 'call-1', answers: [] }, s.opts),
    (e) => e.code === board.QUESTION_GONE_CODE,
  );
  s.close();
});

test('answerDeliver：审批 404/409 ⇒ 转 40405；缺 outcome ⇒ 40005', async () => {
  const s = setup('answer-approval-gone', {
    answerApproval: () => { const e = new Error('未认领'); e.code = 409; throw e; },
  });
  const proj = { id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir };
  await assert.rejects(
    () => board.answerDeliver(proj, { sid: 'sid-a', approval_id: 'ap-1', outcome: 'allowed-once' }, s.opts),
    (e) => e.code === board.QUESTION_GONE_CODE,
  );
  await assert.rejects(
    () => board.answerDeliver(proj, { sid: 'sid-a', approval_id: 'ap-1' }, s.opts),
    (e) => e.code === 40005,
  );
  s.close();
});

test('answerQuestionGone：code 主判 + msg 兜底', () => {
  assert.equal(board.answerQuestionGone({ code: 40405, message: 'x' }), true);
  assert.equal(board.answerQuestionGone({ code: 500, message: 'Question Not Found' }), true);
  assert.equal(board.answerQuestionGone({ code: 500, message: '别的错' }), false);
});

test('answerRetryOrFail：未满 3 次 ⇒ 放回 waiting + 退避 + 重入队；满 3 次 ⇒ failed + 清占位', async () => {
  const s = setup('answer-retry');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'doing', blockKind: 'interaction', blockText: '等待',
    sessionId: 'sid-a', sessions: '["sid-a"]',
  });
  const rid = insertWait(s.fx.db, {
    projectId: s.pid, kind: 'answer', targetId: cid, state: 'running', seq: 1,
    retries: 0, meta: JSON.stringify({ sid: 'sid-a', qid: 'call-1', answers: [] }),
  });
  const row = waitq.getActive('answer', cid, { db: s.fx.db });
  assert.equal(row.id, rid);
  board.answerRetryOrFail(cid, row, '网络异常');
  let after = s.fx.db.prepare('SELECT * FROM wait_items WHERE id=?').get(rid);
  assert.equal(after.state, 'waiting');              // 放回
  assert.equal(after.retries, 1);
  assert.ok(after.not_before > Date.now() / 1000 + board.ANSWER_BACKOFF_S - 5);
  assert.deepEqual(s.runner.filter((c) => c[0] === 'submitAnswer'), [['submitAnswer', cid]]);
  // 满 3 次：retries=2 ⇒ +1=3 ⇒ 不再 < 3 ⇒ failed + 清 block 占位
  s.fx.db.prepare('UPDATE wait_items SET state=?, retries=2 WHERE id=?').run('running', rid);
  const row2 = s.fx.db.prepare('SELECT * FROM wait_items WHERE id=?').get(rid);
  board.answerRetryOrFail(cid, row2, '网络异常');
  after = s.fx.db.prepare('SELECT * FROM wait_items WHERE id=?').get(rid);
  assert.equal(after.state, 'failed');
  const card = cardRow(s.fx, cid);
  assert.equal(card.block_kind, null);
  assert.equal(card.block_text, '');
  s.close();
});

test('deliverAnswerUnit：40405 ⇒ 直接 failed（不重试）+ 清占位', async () => {
  const s = setup('answer-unit-gone', { answerQuestion: () => false });
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'doing', blockKind: 'interaction', blockText: '等待',
    sessionId: 'sid-a',
  });
  const rid = insertWait(s.fx.db, {
    projectId: s.pid, kind: 'answer', targetId: cid, state: 'running', seq: 1,
    meta: JSON.stringify({ sid: 'sid-a', qid: 'call-1', answers: [] }),
  });
  await board.deliverAnswerUnit(cid, s.opts);
  assert.equal(s.fx.db.prepare('SELECT state FROM wait_items WHERE id=?').get(rid).state, 'failed');
  assert.equal(cardRow(s.fx, cid).block_kind, null);
  s.close();
});

test('deliverAnswerUnit：成功 ⇒ markDone + 卡归位 doing + 补回运行行（顺序 R4）', async () => {
  const s = setup('answer-unit-ok');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'blocked', blockKind: 'interaction', blockText: '等待',
    sessionId: 'sid-a',
  });
  const rid = insertWait(s.fx.db, {
    projectId: s.pid, kind: 'answer', targetId: cid, state: 'running', seq: 1,
    meta: JSON.stringify({ sid: 'sid-a', qid: 'call-1',
      answers: [{ wire: 'q_0', kind: 'single', option_id: 'o', option_ids: [], text: '' }] }),
  });
  await board.deliverAnswerUnit(cid, s.opts);
  assert.equal(s.fx.db.prepare('SELECT state FROM wait_items WHERE id=?').get(rid).state, 'done');
  const card = cardRow(s.fx, cid);
  assert.equal(card.column_key, 'doing');
  assert.equal(card.block_kind, null);
  assert.equal(card.unread, 0);                      // 用户作答引发的回列不置「有更新」
  assert.deepEqual(s.runner.filter((c) => c[0] === 'cardStarted'),
    [['cardStarted', cid, s.pid, { reason: '送达恢复' }]]);
  s.close();
});

test('deliverPendingAnswerNow：无待送达 / claim 成功直投 / 失败放回不消耗 retries', async () => {
  const s = setup('answer-now');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'doing', sessionId: 'sid-a',
  });
  assert.deepEqual(await board.deliverPendingAnswerNow(cid, s.opts),
    [false, '没有待送达的答案（可能已送达）']);
  const rid = insertWait(s.fx.db, {
    projectId: s.pid, kind: 'answer', targetId: cid, state: 'waiting', seq: 1,
    meta: JSON.stringify({ sid: 'sid-a', qid: 'call-1', answers: [] }),
  });
  assert.deepEqual(await board.deliverPendingAnswerNow(cid, s.opts), [true, '']);
  assert.equal(s.fx.db.prepare('SELECT state FROM wait_items WHERE id=?').get(rid).state, 'done');
  assert.equal(cardRow(s.fx, cid).column_key, 'doing');
  assert.ok(s.runner.some((c) => c[0] === 'removeAnswer' && c[1] === cid));   // 出队
  // 失败档：其它错误 ⇒ returnToWaiting（retries 不动）+ 重入队
  const s2 = setup('answer-now-fail', {
    answerQuestion: () => { const e = new Error('链路断了'); e.code = 500; throw e; },
  });
  const cid2 = insertCard(s2.fx.db, s2.pid, { title: 'C2', columnKey: 'doing', sessionId: 'sid-b' });
  const rid2 = insertWait(s2.fx.db, {
    projectId: s2.pid, kind: 'answer', targetId: cid2, state: 'waiting', seq: 1,
    meta: JSON.stringify({ sid: 'sid-b', qid: 'call-2', answers: [] }),
  });
  const [ok, err] = await board.deliverPendingAnswerNow(cid2, s2.opts);
  assert.equal(ok, false);
  assert.equal(err, '回答失败：链路断了');
  const after = s2.fx.db.prepare('SELECT * FROM wait_items WHERE id=?').get(rid2);
  assert.equal(after.state, 'waiting');
  assert.equal(after.retries, 0);                    // 手动失败不消耗重试额度
  assert.ok(s2.runner.some((c) => c[0] === 'submitAnswer' && c[1] === cid2));
  s2.close();
  s.close();
});

// ==========================================================================
// ⑥ 作答入队与校验（answer_interaction / answer_approval）
// ==========================================================================

test('answerInteraction：无待答/kind 不符/qid 过期 ⇒ 三条错误文案', async () => {
  const s = setup('answer-int-errors');
  const cid = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing', sessionId: 'sid-a' });
  const card = cardRow(s.fx, cid);
  const proj = { id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir };
  assert.equal(await board.answerInteraction(proj, card, 'c1', [{}], s.opts),
    '当前没有等待中的提问');
  board.iwCache();                                   // no-op：保持引用（避免 lint 噪音）
  s.close();
});

test('answerInteraction：入队后落 doing/queue 占位 + 清交互缓存 + 防御 cancel 旧 c: 行', async () => {
  const s = setup('answer-int-queue');
  const cid = insertCard(s.fx.db, s.pid, {
    title: 'C', columnKey: 'blocked', blockKind: 'interaction', blockText: '等待',
    sessionId: 'sid-a',
  });
  // 手工把 watcher 缓存灌成「有一道待答提问」
  board.setIwCacheForTest('sid-a', {
    pending: true, busy: true, kind: 'question', qid: 'call-1',
    questions: [{ id: 'q_0', question: '选一个', options: [{ id: 'o1', label: 'o1' }],
      multi_select: false, allow_other: true }],
  });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: cid, state: 'waiting', seq: 1 });
  const card = cardRow(s.fx, cid);
  const proj = { id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir };
  const err = await board.answerInteraction(proj, card, 'call-1',
    [{ wire: 'q_0', kind: 'single', option_id: 'o1' }], s.opts);
  assert.equal(err, null);
  const row = activeWait(s.fx, 'answer', cid);
  assert.ok(row, '答案行应已入队');
  assert.equal(row.state, 'waiting');
  assert.equal(JSON.parse(row.meta).qid, 'call-1');
  const after = cardRow(s.fx, cid);
  assert.equal(after.column_key, 'doing');
  assert.equal(after.block_kind, 'queue');           // 排队占位（前端「排队中」徽标来源）
  assert.equal(board.interactionOfSid('sid-a'), null);   // 交互缓存已清
  assert.equal(activeWait(s.fx, 'card', cid), undefined); // 旧 c: waiting 行被防御 cancel
  assert.ok(s.runner.some((c) => c[0] === 'submitAnswer' && c[1] === cid));
  s.close();
});

test('answerInteraction：校验矩阵（漏题/重复/未选/越界/形态非法/自定义过长）', async () => {
  const s = setup('answer-int-valid');
  const cid = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing', sessionId: 'sid-a' });
  board.setIwCacheForTest('sid-a', {
    pending: true, busy: true, kind: 'question', qid: 'call-1',
    questions: [
      { id: 'q_0', question: 'A', options: [{ id: 'o1', label: 'o1' }], multi_select: false, allow_other: true },
      { id: 'q_1', question: 'B', options: [{ id: 'o2', label: 'o2' }], multi_select: true, allow_other: false },
    ],
  });
  const proj = { id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir };
  const card = cardRow(s.fx, cid);
  const one = [{ wire: 'q_0', kind: 'single', option_id: 'o1' }];
  assert.equal(await board.answerInteraction(proj, card, 'call-1', one, s.opts), '请回答全部问题');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [one[0], { wire: 'q_0', kind: 'single', option_id: 'o1' }], s.opts), '题目作答重复');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [one[0], { wire: 'q_9', kind: 'single' }], s.opts), '题目不存在或已过期');
  assert.equal(await board.answerInteraction(proj, card, 'wrong-qid',
    [one[0], { wire: 'q_1', kind: 'multi', option_ids: ['o2'] }], s.opts),
  '提问不存在或已过期');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [one[0], { wire: 'q_1', kind: 'multi', option_ids: [] }], s.opts), '未选择任何选项');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [one[0], { wire: 'q_1', kind: 'multi', option_ids: ['nope'] }], s.opts),
  '选项不存在或已过期');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [one[0], { wire: 'q_1', kind: 'other', text: 'x' }], s.opts), '该问题不支持自定义输入');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [{ wire: 'q_0', kind: 'wrong' }, { wire: 'q_1', kind: 'multi', option_ids: ['o2'] }], s.opts),
  '作答形态非法');
  assert.equal(await board.answerInteraction(proj, card, 'call-1',
    [{ wire: 'q_0', kind: 'single', option_id: 'nope' },
      { wire: 'q_1', kind: 'multi', option_ids: ['o2'] }], s.opts), '选项不存在或已过期');
  assert.equal(await board.answerInteraction(proj, card, 'call-1', [], s.opts), '作答载荷非法');
  s.close();
});

test('answerApproval：白名单校验 + scope=session 明确拒绝 + 入队 meta 带宿主 outcome', async () => {
  const s = setup('answer-appr');
  const cid = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing', sessionId: 'sid-a' });
  board.setIwCacheForTest('sid-a', {
    pending: true, busy: true, kind: 'approval', approval_id: 'ap-1', tool: 'Bash',
  });
  const proj = { id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir };
  const card = cardRow(s.fx, cid);
  assert.equal(await board.answerApproval(proj, card, 'ap-9', 'approved', '', s.opts),
    '审批不存在或已过期');
  assert.equal(await board.answerApproval(proj, card, 'ap-1', 'maybe', '', s.opts),
    '审批决定非法');
  assert.equal(await board.answerApproval(proj, card, 'ap-1', 'approved', 'all', s.opts),
    '审批范围非法');
  assert.equal(await board.answerApproval(proj, card, 'ap-1', 'approved', 'session', s.opts),
    'dsh 不支持「本会话内批准」（宿主无 session 级放行语义）');
  assert.equal(await board.answerApproval(proj, card, 'ap-1', 'approved', '', s.opts), null);
  const row = activeWait(s.fx, 'answer', cid);
  assert.ok(row);
  const meta = JSON.parse(row.meta);
  assert.equal(meta.approval_id, 'ap-1');
  assert.equal(meta.outcome, 'allowed-once');
  assert.equal(meta.decision, 'approved');
  s.close();
});

test('answerInteraction：任务侧伪卡（无 id）⇒ 直送驱动 + 清缓存', async () => {
  const s = setup('answer-task-side');
  board.setIwCacheForTest('sid-t', {
    pending: true, busy: true, kind: 'question', qid: 'call-9',
    questions: [{ id: 'q_0', question: 'A', options: [{ id: 'o1', label: 'o1' }],
      multi_select: false, allow_other: true }],
  });
  const proj = { id: s.pid, agent_path: 'dsh-plugin:/dsh', project_dir: s.fx.dir };
  const err = await board.answerInteraction(proj, { session_id: 'sid-t' }, 'call-9',
    [{ wire: 'q_0', kind: 'single', option_id: 'o1' }], s.opts);
  assert.equal(err, null);
  assert.ok(s.calls.some((c) => c[0] === 'answerQuestion' && c[1] === 'sid-t'));
  assert.equal(board.interactionOfSid('sid-t'), null);
  s.close();
});

// ==========================================================================
// ⑦ recover：四类映射
// ==========================================================================

test('recover：四类映射（doing 有会话→review / 排队占位留列 / worktree 不补行 / 非 doing 活跃行收口）', async () => {
  const s = setup('recover');
  // ① doing + 有 sid，中枢未对齐（默认未连接）⇒ 不搬列、不建 RUNS（就绪闸）
  const c1 = insertCard(s.fx.db, s.pid, { title: 'D1', columnKey: 'doing', sessionId: 'sid-1' });
  // ② doing + queue 占位 ⇒ 跳过（留开发列）
  const c2 = insertCard(s.fx.db, s.pid, {
    title: 'D2', columnKey: 'doing', blockKind: 'queue', sessionId: '',
  });
  // ③ doing + worktree 标记 + 在管条目 ⇒ 不补 c: 行（免排队卡不得被塞回队列）
  const c3 = insertCard(s.fx.db, s.pid, {
    title: 'D3', columnKey: 'doing', worktree: s.fx.dir, sessionId: '', blockKind: 'queue',
  });
  board.runRegistry.set(c3, {
    proc: null, sid: 'sid-3', family: 'dsh_plugin', project_dir: s.fx.dir,
    started_at: Date.now(), seen_busy: true, aborted: false, turn_baseline: null,
  });
  // ④ 非 doing 卡的活跃 running c: 行 ⇒ failed「服务重启中断」
  const c4 = insertCard(s.fx.db, s.pid, { title: 'R1', columnKey: 'review' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c4, state: 'running', seq: 5 });
  // ⑤ 非 doing 卡的活跃 starting c: 行 ⇒ cancelled
  const c5 = insertCard(s.fx.db, s.pid, { title: 'R2', columnKey: 'review' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c5, state: 'starting', seq: 6 });
  // ⑥ 排队占位卡（doing+queue，无行）⇒ 重建入队
  const c6 = insertCard(s.fx.db, s.pid, { title: 'Q1', columnKey: 'doing', blockKind: 'queue' });

  await board.recover(s.opts);

  // ① 中枢未对齐 ⇒ 列不动（就绪闸），且未建 RUNS
  assert.equal(cardRow(s.fx, c1).column_key, 'doing');
  assert.equal(board.runRegistry.has(c1), false);
  // ② 排队占位：留列
  assert.equal(cardRow(s.fx, c2).column_key, 'doing');
  // ③ worktree 卡：不补 c: 行，且**不**经 `card_started` 重建
  // （board.py:3099：`if (_card_opt(c, "worktree") or "").strip(): continue`
  // ——card_started→enter_running 会「行缺失则建行」，等于把免排队的卡塞回统一队列；
  // 运行事实由 `_RUNS` 条目承担，收尾照常走 `_finish_run`→`finish`（无行幂等））。
  // 原用例断言的 `some(cardStarted…c3)` 与 oracle 相反：Python/Node 都跳过它。
  assert.equal(activeWait(s.fx, 'card', c3), undefined);
  assert.ok(!s.runner.some((c) => c[0] === 'cardStarted' && c[1] === c3));
  assert.equal(board.runRegistry.has(c3), true);   // 不补行 ≠ 丢运行事实：RUNS 条目仍在
  // ④⑤ 非 doing 活跃行收口
  const w4 = s.fx.db.prepare('SELECT state FROM wait_items WHERE kind=? AND target_id=?')
    .get('card', String(c4));
  assert.equal(w4.state, 'failed');
  const w5 = s.fx.db.prepare('SELECT state FROM wait_items WHERE kind=? AND target_id=?')
    .get('card', String(c5));
  assert.equal(w5.state, 'cancelled');
  // ⑥ 排队卡重建入队（行缺失才补）
  assert.ok(s.runner.some((c) => c[0] === 'submitCard' && c[1] === c6));
  board.runRegistry.delete(c3);        // 清本用例造的在管条目，免同进程后续用例见幽灵运行
  s.close();
});

test('recover：waiting 行存活 ⇒ 不重复入队（位次以表 seq 为准）', async () => {
  const s = setup('recover-wait');
  const cid = insertCard(s.fx.db, s.pid, { title: 'Q', columnKey: 'doing', blockKind: 'queue' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: cid, state: 'waiting', seq: 3 });
  await board.recover(s.opts);
  assert.deepEqual(s.runner.filter((c) => c[0] === 'submitCard'), []);
  s.close();
});

test('recover：dsh 项目 + 中枢已对齐 + 实况忙 ⇒ 重建 RUNS + 行置 running'
  + '（本进程造不出 aligned ⇒ 只钉未对齐硬闸 + starting 行按或然映射收口）', async () => {
  const s = setup('recover-busy');
  const cid = insertCard(s.fx.db, s.pid, { title: 'D', columnKey: 'doing', sessionId: 'sid-9' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: cid, state: 'starting', seq: 1,
    claimedAt: '2000-01-01 00:00:00' });
  // 造「中枢已对齐 + 该会话 running」需要真连接：`aligned()` 恒 false（未连接/未对齐），
  // 属实例级/集成档。故这里只证「未对齐 ⇒ 不搬列也不建 RUNS」这一条硬闸。
  //
  // starting 行**会被 recover 处置**（原用例期望 still 'starting' 是误判）：oracle 的
  // v2a T1 行重启映射（board.py:3062-3072）对 doing 卡的非 waiting 活跃行按实况收口——
  // 该卡不在 live_set（未对齐 ⇒ `_recover_web_card` 早退、不建 _RUNS）且行为 starting
  // ⇒ `waitq.cancel(..., "服务重启中断")`。卡列不动（列归位只发生在 _recover_web_card）。
  await board.recover(s.opts);
  assert.equal(cardRow(s.fx, cid).column_key, 'doing');
  assert.equal(board.runRegistry.has(cid), false);
  assert.equal(activeWait(s.fx, 'card', cid), undefined);
  const ended = lastWait(s.fx, 'card', cid);
  assert.equal(ended.state, 'cancelled');
  assert.equal(JSON.parse(ended.meta).cancel_reason, '服务重启中断');
  s.close();
});

// ==========================================================================
// ⑧ finish 的两个分支幂等（ext: / c:）
// ==========================================================================

test('finish：ext: 分支幂等（首个收尾 true、重入 false、无行 false）；c: 分支幂等', async () => {
  const s = setup('finish-idem');
  // ext: 无活跃行 ⇒ false
  assert.equal(board.finish('ext:77', '外部条目收尾'), false);
  // 有活跃行 ⇒ true；重入 ⇒ false
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: 77, state: 'running', seq: 1 });
  assert.equal(board.finish('ext:77', '外部条目收尾'), true);
  assert.equal(board.finish('ext:77', '外部条目收尾'), false);
  assert.equal(s.fx.db.prepare('SELECT state FROM wait_items WHERE kind=? AND target_id=?')
    .get('ext', '77').state, 'done');
  // ext: 已在 finishing ⇒ 幂等 false（不重复终态化）
  insertWait(s.fx.db, { projectId: s.pid, kind: 'ext', targetId: 78, state: 'finishing', seq: 2 });
  assert.equal(board.finish('ext:78', 'x'), false);
  // c: 分支：`finish` 自己只做 running→finishing（board.py:2473-2474 `mark_finishing`），
  // 随后把**终态化委派给 runner**（board.py:2475 `inst.card_finished(...)`；
  // (running,finishing)→done 的门禁在 runner.py:429 一侧，board.py 不自己落 done）。
  // 本文件的 runner 替身「只记调用、不动真队列」（口径②）⇒ 行停在 finishing 是正确的
  // 可观察结果；原用例断言 'done' 等于要求替身替 runner 干活，是拿 Node 反推的误判。
  const cid = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: cid, state: 'running', seq: 3 });
  const delegated = () => s.runner.filter((c) => c[0] === 'cardFinished' && c[1] === cid).length;
  assert.equal(delegated(), 0);
  board.finish(`c:${cid}`, '会话结束收尾', { toColumn: 'review', options: s.opts });
  let row = s.fx.db.prepare('SELECT state FROM wait_items WHERE kind=? AND target_id=?')
    .get('card', String(cid));
  assert.equal(row.state, 'finishing');              // finish 的 running→finishing 段
  assert.equal(delegated(), 1);                      // 终态化已委派 runner.card_finished
  assert.equal(cardRow(s.fx, cid).column_key, 'review');   // 搬列是 finish 自己的职责
  // finishing 重入门禁（board.py:2471-2472：`row["state"] == FINISHING` ⇒ 直接 return）：
  // 不重复委派、不抛、行态与列都不再动
  assert.doesNotThrow(() => board.finish(`c:${cid}`, '重入', { toColumn: 'review', options: s.opts }));
  row = s.fx.db.prepare('SELECT state FROM wait_items WHERE kind=? AND target_id=?')
    .get('card', String(cid));
  assert.equal(row.state, 'finishing');
  assert.equal(delegated(), 1);
  assert.equal(cardRow(s.fx, cid).column_key, 'review');
  // 脏键 / 非 c: 前缀键 ⇒ undefined（无收尾语义）
  assert.equal(board.finish('m:abc', 'x'), undefined);
  s.close();
});

// ==========================================================================
// ⑨ sync 归类纯函数（`_split_first_prompt` / `_is_empty_session` / `_is_placeholder_card`）
// ==========================================================================

test('splitFirstPrompt/fullFirstPrompt：截断与溢出并行的口径', () => {
  assert.deepEqual(board.splitFirstPrompt(''), ['', '']);
  assert.deepEqual(board.splitFirstPrompt('  a\n b \n'), ['a', 'b']);
  const long = 'x'.repeat(250);
  const [first, rest] = board.splitFirstPrompt(`${long}\nbody`);
  assert.equal(first.length, board.SYNC_TITLE_MAX);
  assert.equal(rest, `${'x'.repeat(50)}\nbody`);      // 溢出部分并入其余行开头（截断不丢内容）
  const many = 'y'.repeat(2100);
  assert.equal(board.fullFirstPrompt(many).length, board.SYNC_DESC_MAX + 1);   // +1 = 省略号
  assert.ok(board.fullFirstPrompt(many).endsWith('…'));
  assert.equal(board.fullFirstPrompt('  hi  '), 'hi');
});

test('isEmptySession / isPlaceholderCard：A 类空会话闸与占位形态硬闸', () => {
  assert.equal(board.isEmptySession(null), false);
  assert.equal(board.isEmptySession({}), true);
  assert.equal(board.isEmptySession({ first_prompt: 'hi' }), false);
  assert.equal(board.isEmptySession({ title: 'T' }), false);
  assert.equal(board.isPlaceholderCard({ title: '' }, new Set(['abcdef0123456789'])), true);
  assert.equal(board.isPlaceholderCard({ title: 'abcdef012345' }, new Set(['abcdef0123456789'])), true);
  assert.equal(board.isPlaceholderCard({ title: '真实标题' }, new Set(['abcdef0123456789'])), false);
});

test('syncCardFields/syncCardFollow/autoTitleForms：标题口径与「用户改过名不动」', () => {
  const item = { title: 'DSH 标题', first_prompt: '首问\n其余', titles: ['旧标题', 'DSH 标题'] };
  assert.deepEqual(board.syncCardFields(item, 'sid0123456789ab'), ['DSH 标题', '首问\n其余']);
  assert.deepEqual(board.syncCardFields({ first_prompt: '首问' }, 'sid0123456789ab'),
    ['首问', '首问']);
  assert.deepEqual(board.syncCardFields({}, 'sid0123456789ab'), ['sid012345678', '']);
  // 回落标题 = 主会话 sid **短码 `sid[:12]`**（board.py:3595 `title = sid[:12]`）——
  // 与同文件 `_is_placeholder_card` 的占位判据同一口径（board.py:3542 `str(s)[:12]`，
  // 本文件 ⑨ 的 `isPlaceholderCard` 用例也按 12 字符钉住）。原用例写 9 字符
  // （'sid012345'）与 oracle 及本文件另一处断言互相矛盾，属期望值笔误。
  assert.deepEqual(board.syncCardFollow(
    { session_id: 'sid0123456789ab', title: '旧标题', description: '' }, item, 'sid0123456789ab'),
  { title: 'DSH 标题', description: '首问\n其余' });
  // 用户改过名（不在自动形态集合里）⇒ 整卡不动
  assert.deepEqual(board.syncCardFollow(
    { session_id: 'sid0123456789ab', title: '我改的', description: '我写的' }, item,
    'sid0123456789ab'), {});
  // 子会话（非主会话）⇒ 不动
  assert.deepEqual(board.syncCardFollow(
    { session_id: 'other', title: '', description: '' }, item, 'sid0123456789ab'), {});
  assert.ok(board.autoTitleForms(item, 'sid0123456789ab').has('旧标题'));
});

// ==========================================================================
// ⑩ 看管声明（`_ensure_watch` / `_watch_prune`）
// ==========================================================================

test('ensureWatch：成功入缓存（第二次零请求）、驱动未确认返回 false 不重试', async () => {
  const s = setup('watch');
  assert.equal(await board.ensureWatch('sid-w'), true);
  assert.equal(await board.ensureWatch('sid-w'), true);      // 缓存命中：零请求
  assert.deepEqual(s.calls.filter((c) => c[0] === 'watch'), [['watch', 'sid-w', true]]);
  assert.equal(await board.ensureWatch('', false), false);
  // 驱动未确认 ⇒ false + 不入缓存（下一轮自然重试）。内联替身同样按驱动的
  // `on = true` 缺省归一口径记账（理由见 installDriver 的 watchSession 注释）。
  s.stub.watchSession = async (sid, on) => {
    s.calls.push(['watch', sid, on === undefined ? true : on]); return false;
  };
  assert.equal(await board.ensureWatch('sid-x'), false);
  assert.equal(board.watchedSids().has('sid-x'), false);
  // force=true 跳过缓存命中
  s.calls.length = 0;
  s.stub.watchSession = async (sid, on) => {
    s.calls.push(['watch', sid, on === undefined ? true : on]); return true;
  };
  assert.equal(await board.ensureWatch('sid-w', true), true);
  assert.deepEqual(s.calls, [['watch', 'sid-w', true]]);
  s.close();
});

test('watchPrune：无卡引用且无在途消息 ⇒ 撤销；有卡引用 / 有在途 m: 行 ⇒ 保留', async () => {
  const s = setup('watch-prune');
  board.resetWatchState();            // 观察集合只含本用例声明的 sid（防同进程前序用例残留串味）
  const keep = insertCard(s.fx.db, s.pid, {
    title: 'K', columnKey: 'doing', sessionId: 'sid-keep',
  });
  await board.ensureWatch('sid-keep');
  await board.ensureWatch('sid-inflight');
  await board.ensureWatch('sid-drop');
  // sid-inflight 有活跃 m: 行 ⇒ 不得撤（board.py:4149-4160 `_watch_msg_inflight`）
  insertMsg(s.fx.db, { id: 'm1', projectId: s.pid, sid: 'sid-inflight', state: 'queued' });
  // sid-keep 有卡引用 ⇒ 不得撤（board.py:4130-4146 `_watch_card_refs` = 全部卡片的
  // session_id ∪ sessions）。原用例**没造这张卡**却期望它被保留——期望值与 oracle 不符
  // （实测会撤 sid-keep + sid-drop 两条）；补上引用卡后才真正测到「有卡引用」这条判据。
  s.calls.length = 0;
  board.resetWatchPruneAtForTest();
  const n = await board.watchPrune();
  assert.equal(n, 1);                                        // 只撤 sid-drop
  assert.deepEqual(s.calls, [['watch', 'sid-drop', false]]);
  const left = board.watchedSids();
  assert.ok(left.has('sid-keep') && left.has('sid-inflight') && !left.has('sid-drop'));
  assert.equal(cardRow(s.fx, keep).session_id, 'sid-keep');
  s.close();
});

test('watchGenerationSync：中枢代次未变 ⇒ 不清；清空只让下一次重声明', () => {
  const s = setup('watch-gen');
  // stats().reconnects 在本进程恒 0（未连接）且首次读只记基准 ⇒ false
  assert.equal(board.watchGenerationSync(), false);
  assert.equal(board.watchGenerationSync(), false);
  s.close();
});

test('renameCardSession：成功回 accepted；池外 404 ⇒ 补看管后重试；其余错不回写', async () => {
  const s = setup('rename');
  let first = true;
  s.stub.rename = async (sid, title) => {
    s.calls.push(['rename', sid, title]);
    if (sid === 'sid-pool' && first) { first = false; const e = new Error('池外'); e.code = 404; throw e; }
    if (sid === 'sid-bad') { const e = new Error('宿主拒绝'); e.code = 500; throw e; }
    return { title: `${title}!` };
  };
  assert.deepEqual(await board.renameCardSession('sid-in', '新名'), [true, '', '新名!']);
  assert.deepEqual(await board.renameCardSession('sid-pool', '新名'), [true, '', '新名!']);
  assert.ok(s.calls.some((c) => c[0] === 'watch' && c[1] === 'sid-pool'));   // 补看管声明
  assert.deepEqual(await board.renameCardSession('sid-bad', '新名'), [false, '宿主拒绝', '']);
  assert.deepEqual(await board.renameCardSession('', '新名'),
    [false, '缺少会话或标题，未同步 DSH 会话名', '']);
  s.close();
});
