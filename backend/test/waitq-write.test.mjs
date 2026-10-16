/**
 * `backend/lib/waitq.js` **写路径**单测（node --test，零依赖）——M4 统一队列写口的证据。
 *
 * 与 `waitq.test.mjs`（M3 只读子集）的分工：那个钉读口的过滤/排序/位次算术，本文件钉
 * **每一个写口的真实契约**——SQL 守卫、rowcount 判据、事务边界、返回类型、文案字节。
 *
 * 三条硬约束（与 M3 单测同源，见 `m3fixture.mjs` 文件头）：
 *   ① **临时库、绝不碰生产库**：每个测试 `mkdtemp` 一份全新库（`freshDb`），跑完关句柄；
 *   ② **建库走真启动序**（`db.initDb` ⇒ schema + 收敛 + 种子 + 声明式迁移），保证
 *      `idx_wait_active` 那条**部分唯一索引**与生产同源——「同类同目标至多一条活跃行」
 *      这条不变量是多数幂等门禁的判据来源，手工建表会把它测丢；
 *   ③ **造场景用真 SQL 插真行**，不 mock：断言直接读回库里的列（`q1`/`qa`）。
 *
 * 写调用一律走 `W(fx)`（`{dbPath}`）——那是 `withWriteDb` 的**真事务路径**（自开短连接 +
 * `BEGIN`…`COMMIT`），与 Python `with db.connect() as conn:` 同形；读回走 `R(fx)`
 * （`{db: fx.db}`）复用夹具句柄。另有两例专测 `{db}` 形态的事务边界归调用方（见末段）。
 *
 * 覆盖清单（逐条对应 waitq.py 的写口）：
 *   - 常量与导出面 / 文案字节（`CARD_QUEUE_TEXT`）；
 *   - `enqueue`：幂等复用、未知 kind、meta 逐字节、not_before 数值口径、终态后再入队新行；
 *   - `insertAfterPrefix`：前缀后/等待区最前几何、**间隙亚 eps 等距重排**（行 id 稳定、
 *     他项目行不动）；
 *   - `msgInsertSeq`（经 `msgEnqueue`）：消息落点 FIFO（第二条不插到第一条之前）；
 *   - `reposition`：中点、单侧邻行（界外一步）、不存在行返回 false、两种入参错误；
 *   - `claim`/`claimByTarget`/`markRunning`/`markFinishing`/`enterRunning`（四条分支）；
 *   - 终态机（`markDone`/`markFailed`/`finishByTarget`/`setTerminal` 的活跃守卫）与
 *     `returnToWaiting`（not_before / bump_retry / 终态拒绝）；
 *   - `cancel`（states 过滤、空数组防御、reason 落 meta）与 `cancelAllActive`（exclude）；
 *   - 行证据：`touchUnit`（last_seen + evidence JSON）、`markEvidence`（不动 last_seen）、
 *     `evidencePid`（bool/坏 JSON/空串）；
 *   - `selfcheck`（超龄无证据纯报告、新鲜心跳豁免、I1 违约两类、重复行）+ `unitAge` 豁免；
 *   - `reconcileUnits`/`selfcheckUnits`：三态判活（探针注入）、可证死分流（cancelled/failed）、
 *     pid 进程证据、managed 豁免、min_age 豁免、健康积压静默；
 *   - `pruneFinished`（超窗终态删、窗内/活跃/ended_at 空保留）；
 *   - 卡片四操作 + 占位文案 + from_column 持久化 + **单事务原子性**（触发器造中途失败）；
 *   - `insertExt`（running 入场、幂等复用）；
 *   - msg 六态迁移（queued→running→queued→done/error/cancelled）+ 300 字**按码点**截断 +
 *     `msgPrune` 两条回收口径。
 *
 * 「能真的抓到错」的做法：断言一律打在**列值/返回类型/边界关系**上（不是「没抛异常」），
 * 并配他项目哨兵行、终态对照行与反面对照（如断言邻行未被改写）。改错 SQL 的 WHERE、
 * 去掉 rowcount 守卫、把 `>=` 写成 `>`，本文件都会红。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { pidAlive } from '../lib/proc.js';
import * as waitq from '../lib/waitq.js';
import { freshDb, insertCard, insertProject, insertTask, insertWait } from './m3fixture.mjs';

/** 写连接：`{dbPath}` = 真事务路径（自开短连接 + BEGIN…COMMIT） */
const W = (fx) => ({ dbPath: fx.dbPath });
/** 读连接：复用夹具句柄（读口不关调用方句柄） */
const R = (fx) => ({ db: fx.db });

/** 每个测试自带夹具；测试体跑完必关连接（写口自开的短连接各自已关） */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return fn(fx);
  } finally {
    fx.close();
  }
}

/** 单行读（真 SQL；`undefined` ⇒ 未命中） */
function q1(fx, sql, ...args) {
  const row = fx.db.prepare(sql).get(...args);
  return row === undefined ? null : { ...row };
}

/** 多行读 */
function qa(fx, sql, ...args) {
  return fx.db.prepare(sql).all(...args).map((r) => ({ ...r }));
}

/** 等待项行按 id（断言常用；未命中 null） */
function itemRow(fx, id) {
  return q1(fx, 'SELECT * FROM wait_items WHERE id=?', id);
}

/** 卡片行按 id */
function cardRow(fx, id) {
  return q1(fx, 'SELECT * FROM board_cards WHERE id=?', id);
}

/** 某项目活跃等待项的 (成员键, seq) 列表（seq 升序）——位次断言用 */
function seqOf(fx, id) {
  return q1(fx, 'SELECT seq FROM wait_items WHERE id=?', id).seq;
}

// --------------------------------------------------------------------------
// 常量与导出面
// --------------------------------------------------------------------------

test('常量：卡片排队文案逐字节、超龄/回收窗口阈值（改 waitq.py 时两侧一起改）', () => {
  // 前端与对拍都比字节：一个字符都不许差（照 waitq.py:971）
  assert.equal(waitq.CARD_QUEUE_TEXT, '排队等待：统一队列');
  assert.equal(waitq.CLAIM_STALE_S, 1800);
  assert.equal(waitq.PRUNE_FINISHED_KEEP_S, 86400);
});

test('导出面：M4 写口一件不少（缺一个都说明这条写路径没搬过来）', () => {
  const writeNames = [
    'enqueue', 'insertAfterPrefix', 'reposition',
    'claim', 'claimByTarget', 'markRunning', 'enterRunning', 'markFinishing',
    'markDone', 'markFailed', 'finishByTarget', 'returnToWaiting',
    'cancel', 'cancelAllActive',
    'touchUnit', 'markEvidence', 'evidencePid',
    'selfcheck', 'reconcileUnits', 'selfcheckUnits', 'pruneFinished',
    'enqueueCard', 'insertCardAfterPrefix', 'insertCardForceStart',
    'cancelCardWait', 'setCardWaitPlaceholder', 'insertExt',
    'msgEnqueue', 'msgClaim', 'msgRequeue', 'msgFinish', 'msgCancel',
    'msgRecoverFail', 'msgPrune',
  ];
  for (const name of writeNames) {
    assert.equal(typeof waitq[name], 'function', `waitq.${name} 不是函数`);
  }
});

// --------------------------------------------------------------------------
// enqueue：幂等入队（活跃唯一索引兜底）
// --------------------------------------------------------------------------

test('enqueue：落尾 +1、meta 逐字节、not_before 数值口径、终态后再入队新行', () => {
  withFixture('wq-w-enq1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'waiting', seq: 7 });

    const id = waitq.enqueue('card', 902, pid, { a: 1, b: '中' }, '0.5', W(fx));
    const row = itemRow(fx, id);
    assert.equal(row.state, 'waiting');
    assert.equal(row.kind, 'card');
    assert.equal(row.target_id, '902', 'target_id 一律字符串落 TEXT 列');
    assert.equal(row.project_id, pid);
    assert.equal(row.seq, 8, '落尾 = 全局 MAX(seq)+1（既有语义不变）');
    assert.equal(row.not_before, 0.5, "字符串 '0.5' 按 float 口径吃下（照 Python float()）");
    assert.equal(row.meta, '{"a": 1, "b": "中"}', 'pyJsonDumps 口径：ensure_ascii=False + 插入序');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // meta 缺省 ⇒ '{}'（不是 NULL、不是空串）
    const id2 = waitq.enqueue('card', 903, pid, null, 0, W(fx));
    assert.equal(itemRow(fx, id2).meta, '{}');
    assert.equal(itemRow(fx, id2).not_before, 0);

    // 终态后再入队：新行（活跃唯一索引只约束活跃行；且 meta 是新载荷）
    assert.equal(waitq.markDone(id, W(fx)), true);
    const id3 = waitq.enqueue('card', 902, pid, { late: true }, 0, W(fx));
    assert.notEqual(id3, id, '终态行不参与复用，必须插新行');
    assert.equal(itemRow(fx, id3).meta, '{"late": true}');
  });
});

test('enqueue：撞活跃唯一索引复用既有行 id（含他项目/他 kind 的边界）', () => {
  withFixture('wq-w-enq2', (fx) => {
    const pidA = insertProject(fx.db, { name: 'A' });
    const pidB = insertProject(fx.db, { name: 'B' });

    const id1 = waitq.enqueue('card', 901, pidA, { first: true }, 0, W(fx));
    // 幂等：同类同目标已有活跃行 ⇒ 复用（不插第二行、meta/位次都不动）
    assert.equal(waitq.enqueue('card', 901, pidA, { second: true }, 0, W(fx)), id1);
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE kind='card' AND target_id='901'").length, 1);
    assert.equal(itemRow(fx, id1).meta, '{"first": true}', '复用路径不重写 meta');

    // claimed/starting 仍属活跃态 ⇒ 继续复用（P4 语义：幂等门禁认四活跃态）
    assert.equal(waitq.claim(id1, 'worker', W(fx)), true);
    assert.equal(waitq.enqueue('card', 901, pidA, null, 0, W(fx)), id1);

    // 活跃唯一索引是 (kind,target_id) **全局**的（不按项目）⇒ 换项目仍复用同一行
    assert.equal(waitq.enqueue('card', 901, pidB, null, 0, W(fx)), id1);
    assert.equal(itemRow(fx, id1).project_id, pidA, '复用行仍是首行，不迁移项目');

    // kind 不同 = 另一个键 ⇒ 新行
    const idAns = waitq.enqueue('answer', 901, pidA, null, 0, W(fx));
    assert.notEqual(idAns, id1);
    // target 不同 = 新行
    assert.notEqual(waitq.enqueue('card', 902, pidA, null, 0, W(fx)), id1);
  });
});

test('enqueue：未知 kind 抛 TypeError（照 Python ValueError；消息含「未知等待项」）', () => {
  withFixture('wq-w-enq3', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    assert.throws(() => waitq.enqueue('bogus', 1, pid, null, 0, W(fx)),
      (err) => err instanceof TypeError && /未知等待项 kind: bogus/.test(err.message));
    assert.throws(() => waitq.insertAfterPrefix('bogus', 1, pid, null, 0, W(fx)),
      (err) => err instanceof TypeError && /未知等待项/.test(err.message));
    // 未落任何行（校验在开连接之前）
    assert.equal(qa(fx, 'SELECT id FROM wait_items').length, 0);
  });
});

// --------------------------------------------------------------------------
// 分数序插入：insertAfterPrefix / 间隙重排 / 消息落点
// --------------------------------------------------------------------------

test('insertAfterPrefix：前缀后、等待区最前（他项目哨兵行必须不参与几何）', () => {
  withFixture('wq-w-seq1', (fx) => {
    const pidA = insertProject(fx.db, { name: 'A' });
    const pidB = insertProject(fx.db, { name: 'B' });
    insertWait(fx.db, { projectId: pidA, kind: 'card', targetId: 1, state: 'running', seq: 1.0 });
    const waitId = insertWait(fx.db, {
      projectId: pidA, kind: 'card', targetId: 2, state: 'waiting', seq: 10.0,
    });
    // 他项目哨兵：前缀行（100）与他项目等待行（0.5）——若 SQL 的 project_id 过滤被去掉，
    // 本项目的落点会跑到区间外（100 侧得 55、0.5 侧得 0），下面两条断言即红
    insertWait(fx.db, { projectId: pidB, kind: 'card', targetId: 3, state: 'running', seq: 100.0 });
    insertWait(fx.db, { projectId: pidB, kind: 'card', targetId: 4, state: 'waiting', seq: 0.5 });

    const [id, seq] = waitq.insertAfterPrefix('card', 5, pidA, { k: 'v' }, 0, W(fx));
    assert.ok(seq > 1.0 && seq < 10.0, `落点必须在前缀后、等待区最前，实得 ${seq}`);
    assert.equal(seqOf(fx, id), seq, '返回的 seq_new 就是行里落的值');
    assert.equal(itemRow(fx, id).state, 'waiting');
    assert.equal(itemRow(fx, id).meta, '{"k": "v"}');
    assert.equal(seqOf(fx, waitId), 10.0, '既有等待行不动');
    assert.equal(seqOf(fx, 3), 100.0, '他项目行绝不被改写');
    assert.equal(seqOf(fx, 4), 0.5);

    // 幂等：活跃行在场 ⇒ 返回既有 [id, seq]，位次不动
    assert.deepEqual(waitq.insertAfterPrefix('card', 5, pidA, null, 0, W(fx)), [id, seq]);
  });
});

test('insertAfterPrefix：亚 eps 间隙 → 项目区间等距重排（行 id 稳定、他项目不动）', () => {
  withFixture('wq-w-seq2', (fx) => {
    const pidA = insertProject(fx.db, { name: 'A' });
    const pidB = insertProject(fx.db, { name: 'B' });
    const hi = 1.0 + 1e-12;                       // 间隙 1e-12 < _SEQ_REBALANCE_EPS
    const pfx = insertWait(fx.db, {
      projectId: pidA, kind: 'card', targetId: 1, state: 'running', seq: 1.0,
    });
    const waitId = insertWait(fx.db, {
      projectId: pidA, kind: 'card', targetId: 2, state: 'waiting', seq: hi,
    });
    // 他项目哨兵一：seq ≤ hi 的等待行（只有**丢了 project_id 过滤**的重排才会改写它；
    // 它在正确实现里只参与全局前驱查询，落成重排下界 floor=0.5）
    const guard = insertWait(fx.db, {
      projectId: pidB, kind: 'card', targetId: 3, state: 'waiting', seq: 0.5,
    });
    // 他项目哨兵二：seq > hi（连参与都不该参与）
    const far = insertWait(fx.db, {
      projectId: pidB, kind: 'card', targetId: 4, state: 'waiting', seq: 100.0,
    });

    // 注意 target 用 9：活跃唯一索引是 (kind,target_id) **全局**的，若与 pidB 哨兵同 target
    // 会走「幂等复用他项目行」分支（那是另一条契约，见 enqueue 用例）
    const [id, seqNew] = waitq.insertAfterPrefix('card', 9, pidA, null, 0, W(fx));

    const rows = qa(fx, 'SELECT id, seq FROM wait_items WHERE project_id=? ORDER BY seq', pidA);
    assert.deepEqual(rows.map((r) => r.id), [pfx, id, waitId], '行 id 稳定、行序不变');
    // 重排几何：本区间两行等距铺进 (floor=0.5, hi]，插入点再取前半段中点
    assert.ok(rows[0].seq > 0.5 && rows[0].seq < hi, '区间最小行被重排（原 1.0 已让位）');
    assert.ok(Math.abs(rows[2].seq - hi) < 1e-15, 'hi 行落在原值不动');
    assert.ok(seqNew > rows[0].seq && seqNew < rows[2].seq, '新行严格落在两者之间');
    assert.equal(rows[1].seq, seqNew);
    const gap1 = rows[1].seq - rows[0].seq;
    const gap2 = rows[2].seq - rows[1].seq;
    assert.ok(Math.abs(gap1 - gap2) < 1e-12, `三行等距（间隙挤压下的等距重排口径）：${gap1} vs ${gap2}`);
    // 他项目行绝不被改写（SQL 的 project_id 过滤是判据的一部分）
    assert.equal(seqOf(fx, guard), 0.5);
    assert.equal(seqOf(fx, far), 100.0);
  });
});

test('msgEnqueue 落点：排在已排队用户动作之后（同项目消息保持到达序 FIFO）', () => {
  withFixture('wq-w-seq3', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'running', seq: 1.0 });
    const cardWait = insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: 2, state: 'waiting', seq: 2.0,
    });

    const w1 = waitq.msgEnqueue('m1', pid, 's1', '第一条', null, null, false, null, true, W(fx));
    const w2 = waitq.msgEnqueue('m2', pid, 's1', '第二条', null, null, false, null, true, W(fx));
    const s1 = seqOf(fx, w1);
    const s2 = seqOf(fx, w2);
    assert.ok(s1 > 1.0 && s1 < 2.0, '消息优先于等待区卡片：落在前缀后、等待区最前');
    assert.ok(s2 > s1, '第二条消息不得插到第一条之前（同项目用户动作 FIFO）');
    assert.ok(s2 < seqOf(fx, cardWait), '两条消息都在等待区卡片之前');
    // 后续 enqueue 仍落全局尾（MAX(seq)+1），不插队
    const later = waitq.enqueue('card', 3, pid, null, 0, W(fx));
    assert.ok(seqOf(fx, later) > seqOf(fx, cardWait));
  });
});

// --------------------------------------------------------------------------
// reposition：拖拽落点改序
// --------------------------------------------------------------------------

test('reposition：中点落位、单侧邻行取界外一步、邻行与他项目行不动', () => {
  withFixture('wq-w-rep1', (fx) => {
    const pidA = insertProject(fx.db, { name: 'A' });
    const pidB = insertProject(fx.db, { name: 'B' });
    const a = insertWait(fx.db, { projectId: pidA, kind: 'card', targetId: 1, seq: 1.0 });
    const b = insertWait(fx.db, { projectId: pidA, kind: 'card', targetId: 2, seq: 3.0 });
    const other = insertWait(fx.db, { projectId: pidB, kind: 'card', targetId: 3, seq: 100.0 });

    // 双侧邻行：严格中点
    assert.equal(waitq.reposition(a, 1.0, 3.0, W(fx)), true);
    assert.equal(seqOf(fx, a), 2.0);
    assert.equal(seqOf(fx, b), 3.0, '邻行不动');
    assert.equal(seqOf(fx, other), 100.0, '他项目行不动');

    // 只给上界（区首）：lo = next - 1.0（界外一步）
    assert.equal(waitq.reposition(a, null, 20.0, W(fx)), true);
    assert.ok(seqOf(fx, a) > 19.0 && seqOf(fx, a) < 20.0);

    // 只给下界（区尾）：hi = prev + 1.0
    assert.equal(waitq.reposition(a, 10.0, null, W(fx)), true);
    assert.ok(seqOf(fx, a) > 10.0 && seqOf(fx, a) < 11.0);

    // 行不存在 ⇒ false（不抛、不写）
    assert.equal(waitq.reposition(99999, 1.0, 2.0, W(fx)), false);
  });
});

test('reposition：入参错误抛 RangeError（两界皆空 / 区间倒置）——照 Python ValueError', () => {
  withFixture('wq-w-rep2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, seq: 1.0 });
    assert.throws(() => waitq.reposition(id, null, null, W(fx)),
      (err) => err instanceof RangeError && /至少给一侧邻行/.test(err.message));
    assert.throws(() => waitq.reposition(id, 5.0, 2.0, W(fx)),
      (err) => err instanceof RangeError && /区间倒置/.test(err.message));
    assert.throws(() => waitq.reposition(id, 2.0, 2.0, W(fx)), RangeError, '相等也倒置');
    assert.equal(seqOf(fx, id), 1.0, '校验失败不落任何写');
  });
});

test('reposition：亚 eps 间隙先等距重排，落点仍严格在 (prev,next) 内', () => {
  withFixture('wq-w-rep3', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const a = insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, seq: 1.0 });
    const hi = 1.0 + 1e-12;
    const b = insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 2, seq: hi });

    assert.equal(waitq.reposition(b, 1.0, hi, W(fx)), true);
    // 重排：floor=0、step=hi/2 ⇒ a=hi/2、b=hi；再取 mid(hi/2,hi)=0.75hi
    assert.equal(seqOf(fx, a), hi / 2, '重排改了邻行 seq（行 id 不变）');
    assert.equal(seqOf(fx, b), (hi / 2 + hi) / 2);
    assert.ok(seqOf(fx, a) < seqOf(fx, b) && seqOf(fx, b) < hi);
  });
});

// --------------------------------------------------------------------------
// 认领与状态机
// --------------------------------------------------------------------------

test('claim/claimByTarget：rowcount 守卫（waiting 守卫、只成功一次、null 幂等 false）', () => {
  withFixture('wq-w-claim1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('task', 1, pid, null, 0, W(fx));

    assert.equal(waitq.claim(id, 'worker-1', W(fx)), true);
    const row = itemRow(fx, id);
    assert.equal(row.state, 'starting');
    assert.equal(row.claimed_by, 'worker-1');
    assert.match(row.claimed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    assert.equal(waitq.claim(id, 'worker-2', W(fx)), false, '已 starting：不能二次认领');
    assert.equal(itemRow(fx, id).claimed_by, 'worker-1', '被拒的认领不改行');
    assert.equal(waitq.claim(null, 'w', W(fx)), false, '空 id 幂等 false（不炸调用方）');
    assert.equal(waitq.claim(99999, 'w', W(fx)), false, '行不存在 ⇒ false');

    // claim_by_target：无活跃行 false；有活跃行转调 claim
    assert.equal(waitq.claimByTarget('card', 1, 'w', W(fx)), false);
    assert.equal(waitq.claimByTarget('task', 1, 'worker-3', W(fx)), false, 'starting 非 waiting');
    const id2 = waitq.enqueue('task', 2, pid, null, 0, W(fx));
    assert.equal(waitq.claimByTarget('task', 2, 'worker-3', W(fx)), true);
    assert.equal(itemRow(fx, id2).claimed_by, 'worker-3');
  });
});

test('markRunning/markFinishing：严格状态守卫（非起始态 false，不炸调用方）', () => {
  withFixture('wq-w-mark1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('card', 1, pid, null, 0, W(fx));

    assert.equal(waitq.markRunning('card', 1, W(fx)), false, 'waiting ≠ starting');
    assert.equal(itemRow(fx, id).state, 'waiting');
    assert.equal(waitq.claim(id, 'w', W(fx)), true);
    assert.equal(waitq.markRunning('card', 1, W(fx)), true);
    assert.equal(itemRow(fx, id).state, 'running');
    assert.equal(waitq.markRunning('card', 1, W(fx)), false, '已 running：幂等拒绝');
    assert.equal(waitq.markRunning('card', 999, W(fx)), false, '无行 ⇒ false');

    assert.equal(waitq.markFinishing('card', 1, W(fx)), true);
    assert.equal(itemRow(fx, id).state, 'finishing');
    assert.equal(waitq.markFinishing('card', 1, W(fx)), false, '已 finishing');
    // 防御面：starting 也容忍（照 Python SQL 的 state IN ('starting','running')）
    const id2 = waitq.enqueue('card', 2, pid, null, 0, W(fx));
    assert.equal(waitq.claim(id2, 'w', W(fx)), true);
    assert.equal(waitq.markFinishing('card', 2, W(fx)), true);
    // 但 waiting 不行
    waitq.enqueue('card', 3, pid, null, 0, W(fx));
    assert.equal(waitq.markFinishing('card', 3, W(fx)), false);
  });
});

test('enterRunning：活跃行升格 / running 幂等 / 终态行同 id 重开并清证据 / 无行新插', () => {
  withFixture('wq-w-ent1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cardId = insertCard(fx.db, pid, { title: '卡' });

    // ① waiting 活跃行 → 直接升格 running（不重排队、不新插行）
    const id = waitq.enqueueCard(cardId, pid, '', '', undefined, W(fx));
    assert.equal(waitq.enterRunning('card', cardId, pid, null, W(fx)), true);
    assert.equal(itemRow(fx, id).state, 'running');
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE kind='card'").length, 1);

    // ② 已是 running ⇒ 幂等 true，行原样不动（含 seq/claim 列/证据）
    waitq.touchUnit('card', cardId, 'busy=1(poll)', W(fx));
    const before = itemRow(fx, id);
    assert.equal(waitq.enterRunning('card', cardId, pid, { extra: '不该合入' }, W(fx)), true);
    const after = itemRow(fx, id);
    assert.equal(after.seq, before.seq);
    assert.equal(after.last_seen, before.last_seen, '活跃行证据不动');
    assert.equal(after.meta, before.meta, '活跃行 meta 不动（不踩 extra/from_column 审计线索）');

    // ③ 终态行 ⇒ 同 id 同 seq 重开，新生命周期必须清证据与认领列
    assert.equal(waitq.markDone(id, W(fx)), true);
    assert.equal(waitq.claim(id, 'w', W(fx)), false, '终态行 claim 不动（守卫）');
    assert.equal(waitq.enterRunning('card', cardId, pid, { reopened: true }, W(fx)), true);
    const re = itemRow(fx, id);
    assert.equal(re.id, id, '同 id 复用（不新造行）');
    assert.equal(re.seq, before.seq, '同 seq（位次延续）');
    assert.equal(re.state, 'running');
    assert.equal(re.ended_at, null);
    assert.equal(re.claimed_at, null);
    assert.equal(re.claimed_by, null);
    assert.equal(re.not_before, 0);
    assert.equal(re.last_seen, 0, '旧会话心跳证据清零');
    assert.equal(re.evidence, '', '旧会话证据清零（pid 陈旧会误判判活/判死）');
    assert.match(re.meta, /"reopened": true/, '重开时 meta 合入');

    // ④ 无行 ⇒ 插入 running 行，位次几何 = 运行前缀尾 / 等待区最前
    const waitId = waitq.enqueue('card', 777, pid, null, 0, W(fx));   // 等待区既有行
    assert.equal(waitq.enterRunning('task', 555, pid, null, W(fx)), true);
    const newId = q1(fx, "SELECT id FROM wait_items WHERE kind='task' AND target_id='555'").id;
    assert.equal(itemRow(fx, newId).state, 'running');
    assert.ok(seqOf(fx, newId) < seqOf(fx, waitId), '新插行落在等待区最前');
    assert.ok(seqOf(fx, newId) > seqOf(fx, id), '且在既有 running 前缀行之后');
  });
});

test('终态机：markDone/markFailed/finishByTarget 只吃活跃行，error 落 meta', () => {
  withFixture('wq-w-term1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const a = waitq.enqueue('task', 1, pid, null, 0, W(fx));
    const b = waitq.enqueue('task', 2, pid, null, 0, W(fx));
    const c = waitq.enqueue('task', 3, pid, null, 0, W(fx));

    assert.equal(waitq.markDone(a, W(fx)), true);
    assert.equal(itemRow(fx, a).state, 'done');
    assert.match(itemRow(fx, a).ended_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(itemRow(fx, a).meta, '{}', '无 error 不写 meta');
    assert.equal(waitq.markDone(a, W(fx)), false, '终态不可再改（rowcount 守卫）');
    assert.equal(waitq.markDone(null, W(fx)), false, '空 id 幂等 false');

    assert.equal(waitq.markFailed(b, '起会话失败', W(fx)), true);
    assert.equal(itemRow(fx, b).state, 'failed');
    assert.equal(itemRow(fx, b).meta, '{"error": "起会话失败"}');

    // finish_by_target：默认 done；指定非 done ⇒ failed(error)
    assert.equal(waitq.finishByTarget('task', 3, 'done', '', W(fx)), true);
    assert.equal(itemRow(fx, c).state, 'done');
    assert.equal(waitq.finishByTarget('task', 3, 'done', '', W(fx)), false, '无活跃行');
    const d = waitq.enqueue('task', 4, pid, null, 0, W(fx));
    assert.equal(waitq.finishByTarget('task', 4, 'failed', '收尾异常', W(fx)), true);
    assert.equal(itemRow(fx, d).state, 'failed');
    assert.equal(itemRow(fx, d).meta, '{"error": "收尾异常"}');
    assert.equal(waitq.finishByTarget('task', 999, 'done', '', W(fx)), false);
  });
});

test('returnToWaiting：三活跃态放回、not_before/bump_retry、终态拒绝（唯一索引不炸）', () => {
  withFixture('wq-w-ret1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('answer', 1, pid, null, 0, W(fx));
    assert.equal(waitq.claim(id, 'w', W(fx)), true);

    assert.equal(waitq.returnToWaiting(id, 123.0, true, W(fx)), true);
    const row = itemRow(fx, id);
    assert.equal(row.state, 'waiting');
    assert.equal(row.retries, 1, 'bump_retry 在 SQL 内累加');
    assert.equal(row.not_before, 123.0);
    assert.equal(row.claimed_at, null);
    assert.equal(row.claimed_by, null, '认领列一并清空（SQL 显式置 NULL）');
    assert.equal(waitq.returnToWaiting(id, 0, false, W(fx)), false, 'waiting 非可放回态');

    // running / finishing 同型放回（v2a T1 放回面扩张）
    assert.equal(waitq.claim(id, 'w', W(fx)), true);
    assert.equal(waitq.markRunning('answer', 1, W(fx)), true);
    assert.equal(waitq.returnToWaiting(id, 0, false, W(fx)), true);
    assert.equal(waitq.claim(id, 'w', W(fx)), true);
    assert.equal(waitq.markRunning('answer', 1, W(fx)), true);
    assert.equal(waitq.markFinishing('answer', 1, W(fx)), true);
    assert.equal(waitq.returnToWaiting(id, 0, true, W(fx)), true);
    assert.equal(itemRow(fx, id).retries, 2);

    // 终态不可复活
    assert.equal(waitq.claim(id, 'w', W(fx)), true);
    assert.equal(waitq.markDone(id, W(fx)), true);
    assert.equal(waitq.returnToWaiting(id, 0, false, W(fx)), false);
    assert.equal(itemRow(fx, id).state, 'done');
    assert.equal(waitq.returnToWaiting(null, 0, false, W(fx)), false);
  });
});

test('cancel：states 收窄、空数组防御、reason 落 meta、终态拒绝', () => {
  withFixture('wq-w-cancel1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('card', 1, pid, null, 0, W(fx));
    assert.equal(waitq.claim(id, 'w', W(fx)), true);

    // states 收窄：starting 行在 ['waiting'] 口径下不可取消
    assert.equal(waitq.cancel('card', 1, '不该命中', ['waiting'], W(fx)), false);
    assert.equal(itemRow(fx, id).state, 'starting');
    assert.equal(itemRow(fx, id).meta, '{}');

    // 空数组 = 「无可取消态」：直接 false（原样拼 SQL 会得到 state IN () 语法错）
    assert.equal(waitq.cancel('card', 1, '', [], W(fx)), false);

    // 命中口径：reason 落 meta.cancel_reason
    assert.equal(waitq.cancel('card', 1, '用户取消', ['starting'], W(fx)), true);
    assert.equal(itemRow(fx, id).state, 'cancelled');
    assert.equal(itemRow(fx, id).meta, '{"cancel_reason": "用户取消"}');
    assert.match(itemRow(fx, id).ended_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 终态不可改写（并发守卫的语义面）
    assert.equal(waitq.cancel('card', 1, '再取消', null, W(fx)), false);
    assert.equal(itemRow(fx, id).state, 'cancelled');
    // 无活跃行
    assert.equal(waitq.cancel('card', 999, '', null, W(fx)), false);
    // 缺省 states=null = 四活跃态（waiting 能取消）
    waitq.enqueue('card', 2, pid, null, 0, W(fx));
    assert.equal(waitq.cancel('card', 2, '', null, W(fx)), true);
  });
});

test('cancelAllActive：excludeKind 支持 str 与数组，逐条独立取消，计数正确', () => {
  withFixture('wq-w-cancel2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const t = waitq.enqueue('task', 1, pid, null, 0, W(fx));
    const c = waitq.enqueue('card', 1, pid, null, 0, W(fx));
    const a = waitq.enqueue('answer', 1, pid, null, 0, W(fx));
    const m = waitq.msgEnqueue('m1', pid, 's', 'hi', null, null, false, null, true, W(fx));

    // str 形态（P2 recover 口径）
    assert.equal(waitq.cancelAllActive('清场', 'answer', W(fx)), 3);
    assert.equal(itemRow(fx, t).state, 'cancelled');
    assert.equal(itemRow(fx, c).state, 'cancelled');
    assert.equal(itemRow(fx, m).state, 'cancelled');
    assert.equal(itemRow(fx, a).state, 'waiting', 'exclude 的行保留');

    // 数组形态（P3 recover 口径：answer+msg 双存活）
    const t2 = waitq.enqueue('task', 2, pid, null, 0, W(fx));
    assert.equal(waitq.cancelAllActive('再清', ['answer', 'msg'], W(fx)), 1);
    assert.equal(itemRow(fx, t2).state, 'cancelled');
    assert.equal(itemRow(fx, a).state, 'waiting');
    // 幂等：已无活跃行
    assert.equal(waitq.cancelAllActive('三清', null, W(fx)), 1, '只剩 a: 一条活跃');
    assert.equal(waitq.cancelAllActive('四清', null, W(fx)), 0);
  });
});

// --------------------------------------------------------------------------
// 行证据与心跳
// --------------------------------------------------------------------------

test('touchUnit：刷新 last_seen + 合入 evidence JSON；终态不打点', () => {
  withFixture('wq-w-evi1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('card', 1, pid, null, 0, W(fx));
    const t0 = Date.now() / 1000;

    assert.equal(waitq.touchUnit('card', 1, 'busy=1(poll)', W(fx)), true);
    const row = itemRow(fx, id);
    assert.ok(row.last_seen >= t0 - 5 && row.last_seen <= Date.now() / 1000, 'last_seen=墙上时钟');
    const ev = JSON.parse(row.evidence);
    assert.equal(ev.evidence, 'busy=1(poll)');
    assert.ok(Math.abs(ev.evidence_at - row.last_seen) < 1e-6, 'evidence_at 与 last_seen 同一时刻');
    assert.equal(row.evidence, `{"evidence": "busy=1(poll)", "evidence_at": ${ev.evidence_at}}`,
      'pyJsonDumps 口径（键序=插入序、ensure_ascii=False）');

    // 不带 evidence：只刷新 last_seen，evidence 原样保留
    const before = itemRow(fx, id);
    assert.equal(waitq.touchUnit('card', 1, '', W(fx)), true);
    const after = itemRow(fx, id);
    assert.equal(after.evidence, before.evidence, '空 evidence 不重写 JSON');
    assert.ok(after.last_seen >= before.last_seen);

    // 无活跃行（终态）不打点
    assert.equal(waitq.markDone(id, W(fx)), true);
    const done = itemRow(fx, id);
    assert.equal(waitq.touchUnit('card', 1, 'busy=0(poll)', W(fx)), false);
    assert.deepEqual(itemRow(fx, id), done, '终态行一字不改');
    assert.equal(waitq.touchUnit('card', 999, 'x', W(fx)), false);
  });
});

test('markEvidence：只写 evidence（不动 last_seen）、空 patch/no 活跃行 false', () => {
  withFixture('wq-w-evi2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('card', 1, pid, null, 0, W(fx));
    waitq.touchUnit('card', 1, 'busy=1(poll)', W(fx));
    const before = itemRow(fx, id);

    assert.equal(waitq.markEvidence('card', 1, { pid: 4242, desc: '会话已起' }, W(fx)), true);
    const row = itemRow(fx, id);
    assert.equal(row.last_seen, before.last_seen, '登记型证据**不动** last_seen（心跳归 touchUnit）');
    const ev = JSON.parse(row.evidence);
    assert.equal(ev.pid, 4242);
    assert.equal(ev.desc, '会话已起');
    assert.equal(ev.evidence, 'busy=1(poll)', '同键覆盖、异键保留（dict.update 语义）');

    // 空 patch：幂等 no-op（照 Python `if not patch: return False`）
    assert.equal(waitq.markEvidence('card', 1, {}, W(fx)), false);
    assert.equal(waitq.markEvidence('card', 1, null, W(fx)), false);
    // 无活跃行
    assert.equal(waitq.markDone(id, W(fx)), true);
    assert.equal(waitq.markEvidence('card', 1, { pid: 1 }, W(fx)), false);
    assert.equal(itemRow(fx, id).evidence.includes('4242'), true, '终态行不被续写');
  });
});

test('evidencePid：bool/字符串/坏 JSON/空列都不算 pid', () => {
  withFixture('wq-w-evi3', (fx) => {
    assert.equal(waitq.evidencePid(null), null);
    assert.equal(waitq.evidencePid({ evidence: '' }), null);
    assert.equal(waitq.evidencePid({ evidence: '{oops' }), null);
    assert.equal(waitq.evidencePid({ evidence: '[]' }), null);
    assert.equal(waitq.evidencePid({ evidence: '{"pid": true}' }), null, 'bool 不算 pid');
    assert.equal(waitq.evidencePid({ evidence: '{"pid": "12"}' }), null, '字符串不算 pid');
    assert.equal(waitq.evidencePid({ evidence: '{"pid": null}' }), null);
    assert.equal(waitq.evidencePid({ evidence: '{"pid": 4321}' }), 4321);
    // 与真实行联动：markEvidence 写入的 pid 能被读回
    const pid = insertProject(fx.db, { name: 'p' });
    waitq.enqueue('card', 1, pid, null, 0, W(fx));
    waitq.markEvidence('card', 1, { pid: 777 }, W(fx));
    assert.equal(waitq.evidencePid(waitq.getActive('card', 1, R(fx))), 777);
  });
});

// --------------------------------------------------------------------------
// selfcheck（纯报告）与 prune
// --------------------------------------------------------------------------

test('selfcheck：健康库静默；超龄无证据报告但不改行；新鲜心跳豁免', () => {
  withFixture('wq-w-sc1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cardId = insertCard(fx.db, pid, { title: '卡', columnKey: 'doing' });
    const id = waitq.enqueueCard(cardId, pid, '', '', undefined, W(fx));
    assert.equal(waitq.claim(id, 'w', W(fx)), true);
    assert.deepEqual(waitq.selfcheck(null, R(fx)), [], '健康库必须零报告');

    // 人为做旧 claimed_at（越过 CLAIM_STALE_S）
    fx.db.prepare("UPDATE wait_items SET claimed_at='2000-01-01 00:00:00' WHERE id=?").run(id);
    const problems = waitq.selfcheck(null, R(fx));
    assert.equal(problems.some((p) => p.startsWith('starting 超龄无证据:')), true, problems.join('|'));
    assert.equal(itemRow(fx, id).state, 'starting', '纯报告：行不因超龄被改写');
    assert.equal(itemRow(fx, id).claimed_at, '2000-01-01 00:00:00');

    // 新鲜心跳 = 活性佐证 ⇒ 不再报告
    assert.equal(waitq.touchUnit('card', cardId, 'busy=1(poll)', W(fx)), true);
    assert.equal(waitq.selfcheck(null, R(fx)).some((p) => p.includes('超龄无证据')), false);
  });
});

test('selfcheck：I1 违约报告（卡不在开发容器 / 卡行已删）+ 重复活跃行', () => {
  withFixture('wq-w-sc2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cardId = insertCard(fx.db, pid, { title: '待审卡', columnKey: 'review' });
    const id = waitq.enqueueCard(cardId, pid, '', '', undefined, W(fx));
    // 排队占位把卡落在 doing（I1 稳态：列与行一致 ⇒ 不报）
    assert.equal(cardRow(fx, cardId).column_key, 'doing');
    assert.equal(waitq.selfcheck(null, R(fx)).some((p) => p.includes('I1 违约')), false);

    // 卡被搬离「正在开发」容器（行未终态化 ⇒ I1 违约形态）
    fx.db.prepare("UPDATE board_cards SET column_key='review' WHERE id=?").run(cardId);
    const problems = waitq.selfcheck(null, R(fx));
    assert.equal(problems.some((p) => p.includes('I1 违约') && p.includes(`卡 ${cardId} `)
      && p.includes('column=review')), true, problems.join('|'));
    assert.equal(itemRow(fx, id).state, 'waiting', 'I1 只告警不改行');

    // 归位开发容器后不报
    fx.db.prepare("UPDATE board_cards SET column_key='doing' WHERE id=?").run(cardId);
    assert.equal(waitq.selfcheck(null, R(fx)).some((p) => p.includes('I1 违约')), false);

    // 卡行已删：同列报告（行无主）
    waitq.enqueue('card', 987655, pid, null, 0, W(fx));
    assert.equal(waitq.selfcheck(null, R(fx)).some((p) => p.includes('卡行已删')), true);

    // 重复活跃行（索引被绕过/失效）：DROP 索引后造两行
    fx.db.exec('DROP INDEX idx_wait_active');
    waitq.enqueue('card', 555001, pid, null, 0, W(fx));
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 555001, state: 'waiting', seq: 99 });
    assert.equal(waitq.selfcheck(null, R(fx))
      .some((p) => /等待项重复: kind=card target=555001 n=2/.test(p)), true);
  });
});

test('pruneFinished：只删超窗终态行（窗内 / 活跃 / ended_at 空一律保留）', () => {
  withFixture('wq-w-prune1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const old = waitq.enqueue('task', 1, pid, null, 0, W(fx));
    assert.equal(waitq.markDone(old, W(fx)), true);
    fx.db.prepare("UPDATE wait_items SET ended_at='2000-01-01 00:00:00' WHERE id=?").run(old);

    const fresh = waitq.enqueue('task', 2, pid, null, 0, W(fx));
    assert.equal(waitq.markFailed(fresh, 'x', W(fx)), true);

    const cancelled = waitq.enqueue('task', 3, pid, null, 0, W(fx));
    assert.equal(waitq.cancel('task', 3, '', null, W(fx)), true);
    fx.db.prepare("UPDATE wait_items SET ended_at='2000-01-01 00:00:00' WHERE id=?").run(cancelled);

    const live = waitq.enqueue('card', 4, pid, null, 0, W(fx));      // waiting 活跃行
    const noEnd = insertWait(fx.db, {                                  // 终态但 ended_at 为空
      projectId: pid, kind: 'task', targetId: 5, state: 'done', seq: 50,
    });

    assert.equal(waitq.pruneFinished(600, W(fx)), 2, 'old(done) + cancelled 超窗');
    assert.equal(itemRow(fx, old), null);
    assert.equal(itemRow(fx, cancelled), null);
    assert.equal(itemRow(fx, fresh).state, 'failed', '窗内终态保留');
    assert.equal(itemRow(fx, live).state, 'waiting', '活跃行不动');
    assert.equal(itemRow(fx, noEnd).state, 'done', 'ended_at IS NULL 不回收');
    assert.equal(waitq.pruneFinished(600, W(fx)), 0, '幂等');
  });
});

// --------------------------------------------------------------------------
// 对账与周期自检（行口径判活，三态注入）
// --------------------------------------------------------------------------

test('reconcileUnits：内建 DB 证据三态 + 可证死分流（waiting/starting→cancelled，running→failed）', () => {
  withFixture('wq-w-rc1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const tRun = insertTask(fx.db, pid, { name: '在跑', status: 'running' });
    const tEnd = insertTask(fx.db, pid, { name: '终态', status: 'interrupted' });
    const tQueued = insertTask(fx.db, pid, { name: '排队', status: 'queued' });

    const wRow = waitq.enqueue('card', 970001, pid, null, 0, W(fx));      // 卡行不存在 → waiting 收口
    const sRow = waitq.enqueue('card', 970002, pid, null, 0, W(fx));
    assert.equal(waitq.claim(sRow, 'w', W(fx)), true);                    // starting → cancelled
    const rRow = waitq.enqueue('card', 970003, pid, null, 0, W(fx));
    assert.equal(waitq.claim(rRow, 'w', W(fx)), true);
    assert.equal(waitq.markRunning('card', 970003, W(fx)), true);          // running → failed
    const alive = waitq.enqueue('task', tRun, pid, null, 0, W(fx));
    const dead = waitq.enqueue('task', tEnd, pid, null, 0, W(fx));
    const queued = waitq.enqueue('task', tQueued, pid, null, 0, W(fx));
    const msgGone = waitq.enqueue('msg', 'm-ghost', pid, null, 0, W(fx));

    const out = waitq.reconcileUnits(null, W(fx));
    const v = new Map(out.map((d) => [d.key, d]));
    assert.deepEqual(Object.keys(v.get('c:970001')).sort(),
      ['closed', 'key', 'kind', 'project_id', 'verdict'], '处置清单键名照 Python（跨语言契约）');
    assert.equal(v.get('c:970001').project_id, pid);
    assert.deepEqual([v.get('c:970001').verdict, v.get('c:970001').closed], ['dead', true]);
    assert.deepEqual([v.get('c:970002').verdict, v.get('c:970002').closed], ['dead', true]);
    assert.deepEqual([v.get('c:970003').verdict, v.get('c:970003').closed], ['dead', true]);
    assert.deepEqual([v.get(`t:${tRun}`).verdict, v.get(`t:${tRun}`).closed], ['alive', false]);
    assert.deepEqual([v.get(`t:${tEnd}`).verdict, v.get(`t:${tEnd}`).closed], ['dead', true]);
    assert.deepEqual([v.get(`t:${tQueued}`).verdict, v.get(`t:${tQueued}`).closed],
      ['unknown', false], 'queued=拾取→置 running 的新生窗口，不裁（与行龄无关）');
    assert.deepEqual([v.get('m:m-ghost').verdict, v.get('m:m-ghost').closed], ['dead', true]);

    // 分流：起步前 → cancelled（cancel_reason）、起步后 → failed（error）
    assert.equal(itemRow(fx, wRow).state, 'cancelled');
    assert.equal(itemRow(fx, sRow).state, 'cancelled');
    assert.equal(itemRow(fx, rRow).state, 'failed');
    assert.equal(itemRow(fx, wRow).meta, '{"cancel_reason": "启动对账：可证明失效"}');
    assert.equal(itemRow(fx, rRow).meta, '{"error": "启动对账：可证明失效"}');
    assert.equal(itemRow(fx, alive).state, 'waiting');
    assert.equal(itemRow(fx, queued).state, 'waiting');
    assert.equal(itemRow(fx, msgGone).state, 'cancelled');
  });
});

test('reconcileUnits：探针确活保行、探针判死也不擅动（R11a）', () => {
  withFixture('wq-w-rc2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const tEnd = insertTask(fx.db, pid, { name: '终态', status: 'interrupted' });
    const id = waitq.enqueue('task', tEnd, pid, null, 0, W(fx));

    // 探针判死**不采信**，降级 unknown ⇒ 保留（web idle 是跨轮间隙常态，判死即误杀串行位）
    const out1 = waitq.reconcileUnits(() => 'dead', W(fx));
    assert.deepEqual([out1[0].verdict, out1[0].closed], ['unknown', false]);
    assert.equal(itemRow(fx, id).state, 'waiting');

    // 探针确活 ⇒ alive 保留
    const out2 = waitq.reconcileUnits(() => 'alive', W(fx));
    assert.deepEqual([out2[0].verdict, out2[0].closed], ['alive', false]);
    assert.equal(itemRow(fx, id).state, 'waiting');

    // 探针抛异常 = 状态不明（走内建 DB 证据）
    const out3 = waitq.reconcileUnits(() => { throw new Error('probe 炸'); }, W(fx));
    assert.deepEqual([out3[0].verdict, out3[0].closed], ['dead', true], '探针失败回落内建证据');
    assert.equal(itemRow(fx, id).state, 'cancelled');
  });
});

test('reconcileUnits：行 evidence.pid 进程证据（已退=可证死，存活=确活）', () => {
  withFixture('wq-w-rc3', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const deadCard = insertCard(fx.db, pid, { title: 'pid 死卡' });
    const liveCard = insertCard(fx.db, pid, { title: 'pid 活卡' });

    // 造一个**已回收**的 pid：spawnSync 返回时子进程已被 reap
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.ok(Number.isInteger(child.pid));
    assert.equal(pidAlive(child.pid), false, '前置条件：该 pid 确实已退');

    const d = waitq.enqueueCard(deadCard, pid, '', '', undefined, W(fx));
    waitq.claim(d, 'w', W(fx));
    waitq.markRunning('card', deadCard, W(fx));
    waitq.markEvidence('card', deadCard, { pid: child.pid }, W(fx));

    const l = waitq.enqueueCard(liveCard, pid, '', '', undefined, W(fx));
    waitq.claim(l, 'w', W(fx));
    waitq.markRunning('card', liveCard, W(fx));
    waitq.markEvidence('card', liveCard, { pid: process.pid }, W(fx));

    const out = waitq.reconcileUnits(null, W(fx));
    const v = new Map(out.map((d2) => [d2.key, d2]));
    // 两张卡行都在场 ⇒ 排除「卡行已删」判据，钉 pid 一支的决定性
    assert.deepEqual([v.get(`c:${deadCard}`).verdict, v.get(`c:${deadCard}`).closed], ['dead', true]);
    assert.deepEqual([v.get(`c:${liveCard}`).verdict, v.get(`c:${liveCard}`).closed], ['alive', false]);
    assert.equal(itemRow(fx, d).state, 'failed', '起步后收口：failed（不是 cancelled）');
    assert.equal(itemRow(fx, l).state, 'running');
  });
});

test('selfcheckUnits：可证死收口 + unknown 只告警 + waiting/ext 免告警免探针', () => {
  withFixture('wq-w-scu1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    // 健康积压：排队卡 / 排队消息 / 待送达答案 / queued 任务 / 外部条目（running 入场）
    const card = insertCard(fx.db, pid, { title: '排队卡', columnKey: 'doing' });
    waitq.enqueueCard(card, pid, '', '', undefined, W(fx));
    waitq.msgEnqueue('m-backlog', pid, 's-1', '排队消息', null, null, false, null, true, W(fx));
    waitq.enqueue('answer', card, pid, null, 0, W(fx));
    const tQ = insertTask(fx.db, pid, { name: '排队任务', status: 'queued' });
    waitq.enqueue('task', tQ, pid, null, 0, W(fx));
    const extCard = insertCard(fx.db, pid, { title: '外部卡' });
    waitq.insertExt(pid, extCard, 's-ext', W(fx));

    const probes = [];
    const probe = (row) => { probes.push([row.kind, row.state]); return 'unknown'; };
    assert.deepEqual(waitq.selfcheckUnits(probe, 0, null, W(fx)), [],
      '健康积压必须静默（含 I1：卡在 doing）');
    assert.deepEqual(probes, [['ext', 'running']], 'waiting 行免探针，只有 running 的 ext 行被探');

    // 卡行已删的活跃行 = 可证死 ⇒ 收口 + 清单
    const ghostCard = 980001;
    waitq.enqueue('card', ghostCard, pid, null, 0, W(fx));
    const problems = waitq.selfcheckUnits(probe, 0, null, W(fx));
    assert.equal(problems.some((p) => p === `自检收口可证死行: c:${ghostCard}`), true,
      problems.join('|'));
    assert.equal(waitq.getActive('card', ghostCard, R(fx)), null);
    assert.equal(itemRow(fx, qa(fx, "SELECT id FROM wait_items WHERE target_id=?",
      String(ghostCard))[0].id).meta,
    '{"cancel_reason": "周期自检：可证明失效"}');

    // 已认领的行状态不明 ⇒ 只告警不改行
    const idleCard = insertCard(fx.db, pid, { title: 'idle 卡' });
    const idleId = waitq.enqueueCard(idleCard, pid, '', '', undefined, W(fx));
    assert.equal(waitq.claim(idleId, 'w', W(fx)), true);
    const idleProbe = (row) => (row.target_id === String(idleCard) ? 'dead' : 'unknown');
    const p2 = waitq.selfcheckUnits(idleProbe, 0, null, W(fx));
    assert.equal(p2.some((p) => p.includes(`行状态不明（仅告警）: c:${idleCard}`)), true);
    assert.equal(itemRow(fx, idleId).state, 'starting', '告警不改行');
  });
});

test('selfcheckUnits：managed 豁免只作用于收口面；min_age 与心跳新鲜度双重豁免', () => {
  withFixture('wq-w-scu2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const tEnd = insertTask(fx.db, pid, { name: '终态', status: 'interrupted' });
    const id = waitq.enqueue('task', tEnd, pid, null, 0, W(fx));

    // managed=true ⇒ 平台在管：收尾归巡视，自检不越权收口（也不进清单）
    assert.deepEqual(waitq.selfcheckUnits(null, 0, () => true, W(fx)), []);
    assert.equal(itemRow(fx, id).state, 'waiting');

    // min_age 豁免：新行不动不告警（做旧 created_at 后照常裁）
    assert.deepEqual(waitq.selfcheckUnits(null, 30, null, W(fx)), []);
    assert.equal(itemRow(fx, id).state, 'waiting');
    fx.db.prepare("UPDATE wait_items SET created_at='2020-01-01 00:00:00' WHERE id=?").run(id);
    const problems = waitq.selfcheckUnits(null, 30, null, W(fx));
    assert.equal(problems.some((p) => p === `自检收口可证死行: t:${tEnd}`), true);
    assert.equal(itemRow(fx, id).state, 'cancelled');
    assert.equal(itemRow(fx, id).meta, '{"cancel_reason": "周期自检：可证明失效"}');

    // 新鲜心跳（last_seen）= 活性佐证：做旧 created_at 也不裁（行证据优先）
    const id2 = waitq.enqueue('task', tEnd, pid, null, 0, W(fx));
    waitq.touchUnit('task', tEnd, '任务在跑心跳', W(fx));
    fx.db.prepare("UPDATE wait_items SET created_at='2020-01-01 00:00:00' WHERE id=?").run(id2);
    assert.deepEqual(waitq.selfcheckUnits(null, 30, null, W(fx))
      .filter((p) => p.includes(`t:${tEnd}`)), []);
    assert.equal(itemRow(fx, id2).state, 'waiting');
    // last_seen 做旧后：心跳不再豁免 ⇒ 终态证据照裁
    fx.db.prepare('UPDATE wait_items SET last_seen=? WHERE id=?').run(Date.now() / 1000 - 3600, id2);
    assert.equal(waitq.selfcheckUnits(null, 30, null, W(fx))
      .some((p) => p === `自检收口可证死行: t:${tEnd}`), true);
    assert.equal(itemRow(fx, id2).state, 'cancelled');

    // 时间戳不可解析 ⇒ 行年龄按 0（=**最年轻**，落年龄豁免侧）：宁可晚一拍再处置，
    // 也不对无时间戳的行抢先收口（v3 终审修复：与「视为最老」相反）
    const id3 = waitq.enqueue('task', tEnd, pid, null, 0, W(fx));
    fx.db.prepare("UPDATE wait_items SET created_at='不是时间戳' WHERE id=?").run(id3);
    assert.deepEqual(waitq.selfcheckUnits(null, 30, null, W(fx))
      .filter((p) => p.includes(`t:${tEnd}`)), []);
    assert.equal(itemRow(fx, id3).state, 'waiting', '坏时间戳落豁免侧，不被抢先收口');
  });
});

// --------------------------------------------------------------------------
// 卡片四操作（行 + 占位一事务）
// --------------------------------------------------------------------------

test('enqueueCard：行 + 占位同事务；占位文案逐字节、清 scheduled_at、meta 存 from_column', () => {
  withFixture('wq-w-card1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, {
      title: '卡', columnKey: 'review', scheduledAt: 12345, blockKind: 'manual', blockText: '旧',
    });

    const id = waitq.enqueueCard(cid, pid, '改一下', 'review', undefined, W(fx));
    const row = itemRow(fx, id);
    assert.equal(row.kind, 'card');
    assert.equal(row.state, 'waiting');
    assert.equal(row.target_id, String(cid));
    assert.equal(row.meta, '{"extra": "改一下", "from_column": "review"}',
      'from_column 持久化（起跑失败回列的唯一依据）');
    const card = cardRow(fx, cid);
    assert.equal(card.column_key, 'doing');
    assert.equal(card.block_kind, 'queue');
    assert.equal(card.block_text, '排队等待：统一队列', '文案逐字节（前端比字节）');
    assert.equal(card.scheduled_at, null, '排队占位清 scheduled_at');
    assert.match(card.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 幂等：复用行、位次不动（重复按开始不提前）
    const seq0 = row.seq;
    assert.equal(waitq.enqueueCard(cid, pid, '再点一次', 'todo', undefined, W(fx)), id);
    assert.equal(itemRow(fx, id).seq, seq0);
    assert.equal(itemRow(fx, id).meta, '{"extra": "改一下", "from_column": "review"}');

    // 占位条件写：已处 doing+queue 时**不覆盖**（保 answer 路径的空 block_text）
    waitq.setCardWaitPlaceholder(cid, '', W(fx));
    assert.equal(cardRow(fx, cid).block_text, '');
    waitq.enqueueCard(cid, pid, '', '', undefined, W(fx));
    assert.equal(cardRow(fx, cid).block_text, '', '条件写不覆盖已有占位');
  });
});

test('enqueueCard/insertCardAfterPrefix：已有运行行只复用（不回退行态、不写排队占位）', () => {
  withFixture('wq-w-card2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: '卡', columnKey: 'review' });

    const id = waitq.enqueueCard(cid, pid, '', '', undefined, W(fx));
    assert.equal(waitq.claim(id, 'w', W(fx)), true);
    assert.equal(waitq.markRunning('card', cid, W(fx)), true);   // 起跑证实后跨轮存活
    const seq0 = seqOf(fx, id);
    fx.db.prepare("UPDATE board_cards SET column_key='review', block_kind=NULL, block_text='' WHERE id=?")
      .run(cid);                                                  // 用户视角的当前列

    assert.equal(waitq.enqueueCard(cid, pid, '再点一次', 'review', undefined, W(fx)), id);
    assert.equal(itemRow(fx, id).state, 'running', '行态不回退');
    assert.equal(seqOf(fx, id), seq0, '位次不动');
    assert.equal(cardRow(fx, cid).block_kind, null, '卡在跑而非排队：不写排队占位');
    assert.equal(waitq.insertCardAfterPrefix(cid, pid, '', '', undefined, W(fx)), id, '原子变体同门禁');
    assert.equal(itemRow(fx, id).state, 'running');
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE kind='card' AND target_id=?",
      String(cid)).length, 1, '表里没有第二行（I5：同一卡至多一条活跃 c: 行）');
  });
});

test('insertCardAfterPrefix：位次=前缀后/等待区最前（与 insertAfterPrefix 同几何）', () => {
  withFixture('wq-w-card3', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const runningCard = insertCard(fx.db, pid, { title: '在跑卡' });
    const waitCard = insertCard(fx.db, pid, { title: '排队卡' });
    const cid = insertCard(fx.db, pid, { title: '续跑卡' });
    insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: runningCard, state: 'running', seq: 1.0,
    });
    waitq.enqueueCard(waitCard, pid, '', '', undefined, W(fx));            // 等待区既有行

    const id = waitq.insertCardAfterPrefix(cid, pid, '续改', 'review', undefined, W(fx));
    const row = itemRow(fx, id);
    assert.equal(row.state, 'waiting');
    assert.ok(row.seq > 1.0 && row.seq < seqOf(fx, waitq.getActive('card', waitCard, R(fx)).id),
      '前缀后、等待区最前');
    assert.equal(row.meta, '{"extra": "续改", "from_column": "review"}');
    assert.equal(cardRow(fx, cid).block_kind, 'queue');
    assert.equal(waitq.insertCardAfterPrefix(cid, pid, '', '', undefined, W(fx)), id, '幂等复用');
    assert.equal(itemRow(fx, id).seq, row.seq, '重复调用不改位次');
  });
});

test('insertCardForceStart：直入 starting（claimed_by=force），撞活跃行幂等复用', () => {
  withFixture('wq-w-card4', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: 'force 卡', blockKind: null });
    const [id, seq] = waitq.insertCardForceStart(cid, pid, { extra: 'force' }, W(fx));
    const row = itemRow(fx, id);
    assert.equal(row.state, 'starting', '行从不以 waiting 形态出现（消除拾取竞态窗）');
    assert.equal(row.claimed_by, 'force');
    assert.match(row.claimed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(row.meta, '{"extra": "force"}');
    assert.equal(cardRow(fx, cid).block_kind, null, 'force 卡无 doing+queue 占位');

    // 再撞=并发 force / 跨轮存活行 ⇒ 复用（不插第二行、不改行态）
    assert.deepEqual(waitq.insertCardForceStart(cid, pid, null, W(fx)), [id, seq]);
    assert.equal(itemRow(fx, id).state, 'starting');
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE kind='card'").length, 1);

    // waiting 行同样复用（不再撞活跃唯一索引上抛）
    const cid2 = insertCard(fx.db, pid, { title: '排队卡' });
    const wid = waitq.enqueueCard(cid2, pid, '', '', undefined, W(fx));
    assert.equal(waitq.insertCardForceStart(cid2, pid, null, W(fx))[0], wid);
    assert.equal(itemRow(fx, wid).state, 'waiting');
  });
});

test('cancelCardWait：双侧 rowcount 守卫（行已终态 / 占位已被改写各自 no-op）', () => {
  withFixture('wq-w-card5', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: '卡' });
    waitq.enqueueCard(cid, pid, '', '', undefined, W(fx));
    const id = waitq.getActive('card', cid, R(fx)).id;

    assert.equal(waitq.cancelCardWait(cid, '卡片出队', W(fx)), true);
    assert.equal(itemRow(fx, id).state, 'cancelled');
    assert.equal(itemRow(fx, id).meta,
      '{"extra": "", "from_column": "", "cancel_reason": "卡片出队"}',
      'cancel_reason 合入既有 meta（键序=插入序）');
    assert.equal(cardRow(fx, cid).block_kind, null);
    assert.equal(cardRow(fx, cid).block_text, '');
    assert.equal(waitq.cancelCardWait(cid, '再取消', W(fx)), false, '行已终态：幂等 false');
    assert.equal(itemRow(fx, id).meta,
      '{"extra": "", "from_column": "", "cancel_reason": "卡片出队"}', '不改写已终态行的 meta');

    // 占位已被调用方改写（manual 阻塞）⇒ 不清占位
    const cid2 = insertCard(fx.db, pid, { title: '卡2' });
    waitq.enqueueCard(cid2, pid, '', '', undefined, W(fx));
    fx.db.prepare("UPDATE board_cards SET block_kind='manual', block_text='手动' WHERE id=?").run(cid2);
    assert.equal(waitq.cancelCardWait(cid2, '拖离', W(fx)), true, '行取消仍命中');
    assert.equal(cardRow(fx, cid2).block_kind, 'manual', '占位守卫：不覆盖新状态');
    assert.equal(cardRow(fx, cid2).block_text, '手动');
  });
});

test('enqueueCard 原子性：占位写中途失败 ⇒ 等待项行一并回滚（单事务红线）', () => {
  withFixture('wq-w-card6', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: '卡', blockKind: null });
    // 触发器让占位投影 UPDATE 必失败：行 INSERT 已执行、占位未写 ⇒ 单事务必须整体回滚
    fx.db.exec('CREATE TRIGGER t_block_placeholder BEFORE UPDATE ON board_cards'
      + " BEGIN SELECT RAISE(ABORT, '占位投影写入中崩'); END");

    assert.throws(() => waitq.enqueueCard(cid, pid, '', '', undefined, W(fx)), /占位投影写入中崩/);
    assert.equal(waitq.getActive('card', cid, R(fx)), null, '方向一：等待项行随事务回滚');
    assert.equal(cardRow(fx, cid).block_kind, null, '方向二：不留占位');
    assert.equal(cardRow(fx, cid).column_key, 'todo');

    // 恢复后正常写入：行 + 占位同时在场
    fx.db.exec('DROP TRIGGER t_block_placeholder');
    const id = waitq.enqueueCard(cid, pid, '', '', undefined, W(fx));
    assert.equal(itemRow(fx, id).state, 'waiting');
    assert.equal(cardRow(fx, cid).block_kind, 'queue');
  });
});

test('setCardWaitPlaceholder：只写占位（answer 排队路径），无条件置 doing+queue', () => {
  withFixture('wq-w-card7', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: '卡', columnKey: 'blocked', blockKind: 'manual' });
    waitq.setCardWaitPlaceholder(cid, '', W(fx));
    const card = cardRow(fx, cid);
    assert.equal(card.column_key, 'doing');
    assert.equal(card.block_kind, 'queue');
    assert.equal(card.block_text, '');
    assert.match(card.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 不建 card 等待项（等待单元是 answer 行）
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE kind='card'").length, 0);
    // 文案可自定义（调用方传什么写什么）
    waitq.setCardWaitPlaceholder(cid, '自定义', W(fx));
    assert.equal(cardRow(fx, cid).block_text, '自定义');
  });
});

// --------------------------------------------------------------------------
// 外部条目 ext
// --------------------------------------------------------------------------

test('insertExt：入场即 running、meta 带 sid、claimed_at 留空、撞活跃行幂等复用', () => {
  withFixture('wq-w-ext1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: '外部卡' });
    const [id, seq] = waitq.insertExt(pid, cid, 's-ext', W(fx));
    const row = itemRow(fx, id);
    assert.equal(row.kind, 'ext');
    assert.equal(row.state, 'running', '外部直跑不由平台启动：入场即视为在运行');
    assert.equal(row.target_id, String(cid));
    assert.equal(row.claimed_at, null, '无平台认领（超龄判据只覆盖被 claim 过的行）');
    assert.equal(row.meta, '{"sid": "s-ext"}');
    assert.equal(waitq.activeExt(pid, R(fx)), true);
    assert.equal(row.seq, seq);

    // 撞活跃行 ⇒ 复用（upsert_ext 的 check-then-insert 窗口）
    assert.deepEqual(waitq.insertExt(pid, cid, 's-other', W(fx)), [id, seq]);
    assert.equal(itemRow(fx, id).meta, '{"sid": "s-ext"}', '复用不改 meta');
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE kind='ext'").length, 1);

    // 位次=运行前缀尾/等待区最前；他卡各自一行（复数并存）
    const waitCard = insertCard(fx.db, pid, { title: '排队卡' });
    const w = waitq.enqueueCard(waitCard, pid, '', '', undefined, W(fx));
    const cid2 = insertCard(fx.db, pid, { title: '外部卡2' });
    const [id2] = waitq.insertExt(pid, cid2, '', W(fx));
    assert.ok(seqOf(fx, id2) < seqOf(fx, w), '新 ext 行落在等待区最前');
    assert.equal(itemRow(fx, id2).meta, '{"sid": ""}');
  });
});

// --------------------------------------------------------------------------
// 消息六态迁移
// --------------------------------------------------------------------------

test('msgEnqueue：双表一事务、meta 载荷、inject、queue=false 只写 chat_msgs', () => {
  withFixture('wq-w-msg1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const wid = waitq.msgEnqueue('m1', pid, 's-1', '你好', 3, 5, true,
      { family: 'dsh_plugin', model: 'glm' }, true, W(fx));
    const msg = q1(fx, 'SELECT * FROM chat_msgs WHERE id=?', 'm1');
    assert.equal(msg.state, 'queued');
    assert.equal(msg.sid, 's-1');
    assert.equal(msg.task_id, 3);
    assert.equal(msg.card_id, 5);
    assert.equal(msg.message, '你好');
    assert.equal(msg.inject, 1, 'inject 落 0/1');
    assert.equal(msg.error, '');
    assert.equal(msg.started_at, null);
    assert.ok(Number.isInteger(msg.created_at) && msg.created_at > 1_600_000_000_000,
      'created_at 是毫秒 epoch 整数');

    const wrow = itemRow(fx, wid);
    assert.equal(wrow.kind, 'msg');
    assert.equal(wrow.state, 'waiting');
    assert.equal(wrow.target_id, 'm1');
    assert.equal(wrow.meta, '{"family": "dsh_plugin", "model": "glm"}');
    assert.equal(waitq.msgMeta('m1', R(fx)).model, 'glm');

    // queue=false：只写 chat_msgs（不经队列的同步路径，等待项只会成孤儿行）
    assert.equal(waitq.msgEnqueue('m2', pid, 's-1', '直送', null, null, false, null, false, W(fx)),
      null);
    assert.equal(q1(fx, 'SELECT state FROM chat_msgs WHERE id=?', 'm2').state, 'queued');
    assert.equal(waitq.getActive('msg', 'm2', R(fx)), null);

    // 主键唯一：同 id 重复提交按编程错误上抛
    assert.throws(() => waitq.msgEnqueue('m1', pid, 's-1', 'dup', null, null, false, null, true,
      W(fx)), /UNIQUE constraint failed/);
    assert.equal(qa(fx, "SELECT id FROM wait_items WHERE target_id='m1'").length, 1,
      '整事务回滚：不留半条等待项');
  });
});

test('msg 状态迁移：claim/requeue/cancel/recover_fail 的 queued/running 守卫逐一如实', () => {
  withFixture('wq-w-msg2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    waitq.msgEnqueue('m1', pid, 's-1', 'hi', null, null, false, null, true, W(fx));

    assert.equal(waitq.msgRequeue('m1', W(fx)), false, '非 running 不可退回');
    assert.equal(waitq.msgClaim('m1', W(fx)), true, 'queued→running');
    assert.ok(Number.isInteger(q1(fx, 'SELECT started_at FROM chat_msgs WHERE id=?', 'm1').started_at));
    assert.equal(waitq.msgClaim('m1', W(fx)), false, '已 running：幂等拒绝');
    assert.equal(waitq.msgCancel('m1', '已取消', W(fx)), false, '非 queued 不可取消');
    assert.equal(waitq.msgRequeue('m1', W(fx)), true, 'running→queued（注入失败退回）');
    assert.equal(q1(fx, 'SELECT started_at FROM chat_msgs WHERE id=?', 'm1').started_at, null,
      'started_at 清零');
    assert.equal(waitq.msgCancel('m1', '已取消', W(fx)), true, 'queued→cancelled');
    const row = q1(fx, 'SELECT * FROM chat_msgs WHERE id=?', 'm1');
    assert.equal(row.error, '已取消');
    assert.ok(Number.isInteger(row.ended_at));
    assert.equal(waitq.msgCancel('m1', '已取消', W(fx)), false, '终态不可再改');

    // recover_fail：queued/running → error；终态拒绝
    waitq.msgEnqueue('m2', pid, 's-2', 'hi', null, null, false, null, true, W(fx));
    assert.equal(waitq.msgRecoverFail('m2', '服务重启中断', W(fx)), true);
    assert.equal(q1(fx, 'SELECT state FROM chat_msgs WHERE id=?', 'm2').state, 'error');
    assert.match(q1(fx, 'SELECT error FROM chat_msgs WHERE id=?', 'm2').error, /服务重启中断/);
    assert.equal(waitq.msgRecoverFail('m2', 'x', W(fx)), false);
    waitq.msgEnqueue('m3', pid, 's-3', 'hi', null, null, false, null, true, W(fx));
    assert.equal(waitq.msgClaim('m3', W(fx)), true);
    assert.equal(waitq.msgRecoverFail('m3', '服务重启中断', W(fx)), true, 'running 也收');
    assert.equal(q1(fx, 'SELECT state FROM chat_msgs WHERE id=?', 'm3').state, 'error');
  });
});

test('msgFinish：running→done/error、error 按**码点**截 300 字、终态不可再改', () => {
  withFixture('wq-w-msg3', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    waitq.msgEnqueue('m1', pid, 's-1', 'hi', null, null, false, null, true, W(fx));
    assert.equal(waitq.msgFinish('m1', 'done', '', W(fx)), false, '非 running 不可终态化');
    assert.equal(waitq.msgClaim('m1', W(fx)), true);
    assert.equal(waitq.msgFinish('m1', 'done', '', W(fx)), true);
    assert.equal(q1(fx, 'SELECT state FROM chat_msgs WHERE id=?', 'm1').state, 'done');
    assert.equal(waitq.msgFinish('m1', 'done', '', W(fx)), false, '终态不可再改');

    // 截断：299 个 x + emoji ⇒ 恰好 300 个**码点**且 emoji 完整（naive slice 会劈代理对）
    waitq.msgEnqueue('m2', pid, 's-1', 'hi', null, null, false, null, true, W(fx));
    assert.equal(waitq.msgClaim('m2', W(fx)), true);
    const long = 'x'.repeat(299) + '😀' + 'y'.repeat(50);
    assert.equal(waitq.msgFinish('m2', 'error', long, W(fx)), true);
    const stored = q1(fx, 'SELECT error FROM chat_msgs WHERE id=?', 'm2').error;
    assert.equal(stored, 'x'.repeat(299) + '😀', '按码点截断、emoji 不被劈开');
    assert.equal(Array.from(stored).length, 300);
    assert.equal(stored.includes('\uFFFD'), false, '不得出现替换字符（半个代理对的写入形态）');
  });
});

test('msgPrune：终态超窗回收 + 总数上限删最旧终态（活跃行不删）', () => {
  withFixture('wq-w-msg4', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const nowMs = Date.now();
    const mk = (id, state, endedAt) => fx.db.prepare(
      'INSERT INTO chat_msgs(id,project_id,sid,message,state,error,inject,created_at,ended_at)'
      + ' VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, pid, 's', 'x', state, '', 0, nowMs - 10_000, endedAt);

    mk('old-done', 'done', nowMs - 601_000);        // 超窗终态 → 删
    mk('old-error', 'error', nowMs - 700_000);      // 超窗终态 → 删
    mk('fresh-done', 'done', nowMs - 1000);         // 窗内终态 → 留
    mk('queued', 'queued', null);                   // 活跃 → 留
    mk('running', 'running', null);                 // 活跃 → 留
    mk('no-end', 'done', null);                     // 终态但 ended_at 空 → 留

    assert.equal(waitq.msgPrune(600, 100, W(fx)), 2);
    assert.equal(q1(fx, 'SELECT id FROM chat_msgs WHERE id=?', 'old-done'), null);
    assert.equal(q1(fx, 'SELECT id FROM chat_msgs WHERE id=?', 'old-error'), null);
    assert.equal(q1(fx, 'SELECT id FROM chat_msgs WHERE id=?', 'fresh-done').id, 'fresh-done');
    assert.equal(q1(fx, 'SELECT id FROM chat_msgs WHERE id=?', 'queued').id, 'queued');
    assert.equal(q1(fx, 'SELECT id FROM chat_msgs WHERE id=?', 'no-end').id, 'no-end');
    assert.equal(waitq.msgPrune(600, 100, W(fx)), 0, '幂等');

    // ② 上限：总行数 4 > max_rows=2 ⇒ 按终态时间从旧到新删 2 条（只删终态）
    assert.equal(qa(fx, 'SELECT id FROM chat_msgs').length, 4);
    assert.equal(waitq.msgPrune(600, 2, W(fx)), 2);
    const left = qa(fx, 'SELECT id FROM chat_msgs ORDER BY id').map((r) => r.id);
    assert.deepEqual(left, ['queued', 'running'], '活跃行永不被上限回收');
  });
});

// --------------------------------------------------------------------------
// 事务边界契约（withWriteDb 的两种形态）
// --------------------------------------------------------------------------

test('事务边界：给 {db} 复用调用方句柄且不开事务（回滚由调用方决定）', () => {
  withFixture('wq-w-tx1', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    // 调用方自己开事务：写口只借句柄（嵌套 BEGIN 会直接报错，此处即证明没有嵌套）
    fx.db.exec('BEGIN');
    const id = waitq.enqueue('card', 1, pid, null, 0, { db: fx.db });
    assert.equal(itemRow(fx, id).state, 'waiting', '同一事务内可见');
    fx.db.exec('ROLLBACK');
    assert.equal(waitq.getItem(id, R(fx)), null, '写口没提交：随调用方回滚消失');
    // 句柄仍可用（写口不关调用方句柄）
    assert.ok(fx.db.prepare('SELECT 1 AS x').get());
  });
});

test('事务边界：{dbPath} 自开短连接并提交（异常时整体回滚）', () => {
  withFixture('wq-w-tx2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const id = waitq.enqueue('card', 1, pid, null, 0, W(fx));
    // 自开连接已提交：另一个句柄立刻读得到
    assert.equal(waitq.getItem(id, R(fx)).state, 'waiting');
    // 异常路径：未知 kind 在校验层抛，库里不留痕
    assert.throws(() => waitq.enqueue('bogus', 2, pid, null, 0, W(fx)), TypeError);
    assert.equal(qa(fx, 'SELECT id FROM wait_items').length, 1);
  });
});
