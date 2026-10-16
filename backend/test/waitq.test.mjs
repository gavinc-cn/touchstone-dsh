/**
 * backend/lib/waitq.js 单测（node --test，零依赖）——**只读子集**的证据。
 *
 * 覆盖三类：
 *   ① 常量形状：五 kind、七状态 + `STATE_*` 别名、ACTIVE/PREFIX 口径（改状态机时两侧
 *      一起改的锚点）；
 *   ② 表驱动读口：`getItem`/`getActive`/`activeItems`/`activeExt`/`activeExtItems` 的
 *      **活跃态过滤**与**seq 升序**（用真行造「活跃 vs 终态」「本项目 vs 他项目」对照）；
 *   ③ 位次算术（`position`）：前缀成员 + waiting 更小 seq + 1——**含同键去重**这条
 *      最容易写错的规则（同单元多行时只计一次前缀、前方同键 waiting 不重复计位）。
 *
 * 所有场景都往 **mkdtemp 临时库** 里插真行（`m3fixture.mjs`），不 mock、不碰生产库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as waitq from '../lib/waitq.js';
import { freshDb, insertMsg, insertProject, insertWait, uniqueCounter } from './m3fixture.mjs';

/** 每个测试自带夹具；测试体跑完必关连接 */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return fn(fx);
  } finally {
    fx.close();
  }
}

test('常量：五 kind、七状态、STATE_* 别名与活跃/前缀口径（改状态机时两侧一起改）', () => {
  assert.deepEqual([...waitq.KINDS], ['task', 'card', 'msg', 'answer', 'ext']);
  assert.deepEqual(
    [waitq.WAITING, waitq.STARTING, waitq.RUNNING, waitq.FINISHING,
      waitq.DONE, waitq.FAILED, waitq.CANCELLED],
    ['waiting', 'starting', 'running', 'finishing', 'done', 'failed', 'cancelled'],
  );
  // 别名是**同一个值**（不是第二套取值）：waitq.py:55-57
  assert.equal(waitq.STATE_WAITING, waitq.WAITING);
  assert.equal(waitq.STATE_STARTING, waitq.STARTING);
  assert.equal(waitq.STATE_RUNNING, waitq.RUNNING);
  assert.equal(waitq.STATE_FINISHING, waitq.FINISHING);
  assert.equal(waitq.STATE_DONE, waitq.DONE);
  assert.equal(waitq.STATE_FAILED, waitq.FAILED);
  assert.equal(waitq.STATE_CANCELLED, waitq.CANCELLED);
  // active = 四活跃态；prefix = starting/running（finishing 不计前缀，位次口径另算）
  assert.deepEqual([...waitq.ACTIVE_STATES], ['waiting', 'starting', 'running', 'finishing']);
  assert.deepEqual([...waitq.PREFIX_STATES], ['starting', 'running']);
});

test('memberKey：五 kind 的前缀键空间（未知 kind 回落 kind:target，照 Python get 缺省）', () => {
  assert.equal(waitq.memberKey('task', 7), 't:7');
  assert.equal(waitq.memberKey('card', 7), 'c:7');
  assert.equal(waitq.memberKey('msg', 'm1'), 'm:m1');
  assert.equal(waitq.memberKey('answer', 7), 'a:7');
  assert.equal(waitq.memberKey('ext', 7), 'ext:7');
  assert.equal(waitq.memberKey('weird', 7), 'weird:7');
});

test('getItem/getActive：活跃态过滤 + target_id 按字符串比对 + 终态行读得到', () => {
  withFixture('waitq1', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const iid = insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: 12, state: 'running', seq: 5,
    });
    // 同类同目标另有一条**终态**行（部分唯一索引只约束活跃行，故可共存）
    insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: 12, state: 'done', seq: 6,
      endedAt: '2026-10-11 01:00:00',
    });

    const byId = waitq.getItem(iid, o);
    assert.equal(byId.kind, 'card');
    assert.equal(byId.target_id, '12', '库里是 TEXT，读出来是字符串（跨语言契约）');
    assert.equal(byId.state, 'running');

    // getActive 只认活跃态 ⇒ 命中 running 那条（不是 done）
    const active = waitq.getActive('card', 12, o);
    assert.equal(active.id, iid);
    assert.equal(active.state, 'running');

    // 数字与字符串 target 是同一行（Python `str(target_id)` 同口径）
    assert.equal(waitq.getActive('card', '12', o).id, iid);

    // 终态行仍在表里：getItem 能按 id 取到，activeItems 里看不到
    const doneRow = waitq.getItem(iid + 1, o);
    assert.equal(doneRow.state, 'done');
    assert.deepEqual(waitq.activeItems(pid, o).map((r) => r.id), [iid]);

    // 未命中
    assert.equal(waitq.getItem(999999, o), null);
    assert.equal(waitq.getItem(null, o), null);
    assert.equal(waitq.getActive('card', 999999, o), null);
  });
});

test('activeItems/activeExtItems：seq 升序 + 项目过滤（他项目行不串场）', () => {
  withFixture('waitq2', (fx) => {
    const o = { db: fx.db };
    const p1 = insertProject(fx.db, { name: 'p1' });
    const p2 = insertProject(fx.db, { name: 'p2' });
    // 故意乱序插入，读口必须按 seq 升序给
    insertWait(fx.db, { projectId: p1, kind: 'card', targetId: 1, seq: 30, state: 'waiting' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: 2, seq: 10, state: 'running' });
    insertWait(fx.db, { projectId: p1, kind: 'ext', targetId: 3, seq: 20, state: 'running' });
    insertWait(fx.db, { projectId: p2, kind: 'card', targetId: 4, seq: 5, state: 'waiting' });
    insertWait(fx.db, {
      projectId: p1, kind: 'card', targetId: 9, seq: 40, state: 'done',
    });

    assert.deepEqual(
      waitq.activeItems(p1, o).map((r) => [r.kind, r.target_id, r.seq]),
      [['task', '2', 10], ['ext', '3', 20], ['card', '1', 30]],
    );
    // 不带 projectId：全项目（p2 的 seq=5 排最前）
    assert.deepEqual(
      waitq.activeItems(null, o).map((r) => r.seq), [5, 10, 20, 30],
    );
    // ext 专用口只给 ext 行，且项目过滤生效
    assert.deepEqual(waitq.activeExtItems(p1, o).map((r) => r.target_id), ['3']);
    assert.deepEqual(waitq.activeExtItems(null, o).map((r) => r.target_id), ['3']);
  });
});

test('activeExt：EXISTS 语义（活跃 ext 行在场才 true；终态 ext 行不算）', () => {
  withFixture('waitq3', (fx) => {
    const o = { db: fx.db };
    const p1 = insertProject(fx.db, { name: 'p1' });
    const p2 = insertProject(fx.db, { name: 'p2' });
    assert.equal(waitq.activeExt(p1, o), false, '无行即 false');

    insertWait(fx.db, { projectId: p1, kind: 'ext', targetId: 1, state: 'running', seq: 1 });
    assert.equal(waitq.activeExt(p1, o), true);
    assert.equal(waitq.activeExt(p2, o), false, '项目隔离');

    // ext 行的终态不算（四活跃态口径）
    insertWait(fx.db, { projectId: p2, kind: 'ext', targetId: 2, state: 'cancelled', seq: 2 });
    assert.equal(waitq.activeExt(p2, o), false);
    // 非 ext 的活跃行不算
    insertWait(fx.db, { projectId: p2, kind: 'card', targetId: 3, state: 'running', seq: 3 });
    assert.equal(waitq.activeExt(p2, o), false);
  });
});

test('answerPendingCardIds/startingCardIds：批量集合语义（活跃态 + 非数字 target 跳过）', () => {
  withFixture('waitq4', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: 11, state: 'waiting', seq: 1 });
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: 13, state: 'finishing', seq: 2 });
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: 15, state: 'done', seq: 3 });
    // 非数字 target：Python 侧 `int()` 会抛 ValueError；Node 侧显式跳过（见模块头差异③）
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: 'abc', state: 'waiting', seq: 4 });

    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 21, state: 'starting', seq: 5 });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 22, state: 'waiting', seq: 6 });

    const answers = waitq.answerPendingCardIds(o);
    assert.deepEqual([...answers].sort((a, b) => a - b), [11, 13], '终态与坏 target 都不进集合');
    const startings = waitq.startingCardIds(o);
    assert.deepEqual([...startings].sort((a, b) => a - b), [21], '只认 starting 态 c: 行');

    // 无 projectId 过滤（两函数都不带项目参数——全库派生，照 Python）
    assert.equal(waitq.answerPendingCardIds(o).size, 2);
  });
});

test('position：位次 = 前缀成员数 + waiting 中 seq 更小者 + 1（含同键去重）', () => {
  withFixture('waitq5', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    // 场景：同步（升序）——t:1 running（前缀）、c:1 running（前缀，与 t:1 不同键）、
    // c:2 waiting、t:2 waiting、c:3 waiting
    insertWait(fx.db, { projectId: pid, kind: 'task', targetId: 1, state: 'running', seq: 1 });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'running', seq: 2 });
    const c2 = insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: 2, state: 'waiting', seq: 3,
    });
    const t2 = insertWait(fx.db, {
      projectId: pid, kind: 'task', targetId: 2, state: 'waiting', seq: 4,
    });
    const c3 = insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: 3, state: 'waiting', seq: 5,
    });

    // c:2 是第一个 waiting：前缀 2 个 + ahead 0 + 1 = 3；total = 5 个成员键
    // 返回**数组** `[pos, total]`（Python 返回元组 `(pos, total)`；M4 归位，见 waitq.js 注释）
    assert.deepEqual(waitq.position(c2, o), [3, 5]);
    // t:2 第二：前缀 2 + ahead 1 + 1 = 4
    assert.deepEqual(waitq.position(t2, o), [4, 5]);
    // c:3 第三：前缀 2 + ahead 2 + 1 = 5
    assert.deepEqual(waitq.position(c3, o), [5, 5]);
    // 非 waiting 行 ⇒ (0,0)
    const running = waitq.getItem(1, o);
    assert.deepEqual(waitq.position(running.id, o), [0, 0]);
    assert.deepEqual(waitq.position(999999, o), [0, 0]);
  });
});

test('position：同键去重在**活跃唯一索引**下不可达（钉住这条不可达性，防后人误当活规则）', () => {
  withFixture('waitq6', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    // `idx_wait_active` 是 (kind, target_id) 上的**部分唯一索引**（WHERE state IN 四活跃态）
    // ⇒ 「前缀里 c:9 running + 等待区又一条 c:9 waiting」这种同键双活跃行**造不出来**：
    // `position` 里的 `if rk in prefix_keys: continue` 因此是**纯防御**（防未知数据形态），
    // 不是可触发的业务路径。这条断言把这个事实钉住：哪天索引被改成非唯一，本测试会红。
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 9, state: 'running', seq: 1 });
    assert.throws(
      () => insertWait(fx.db, {
        projectId: pid, kind: 'card', targetId: 9, state: 'waiting', seq: 2,
      }),
      /UNIQUE constraint failed/,
    );
    // 不同 key 前缀（c:9）不影响其他单元的位次：total 键集去重（同 target 不同 kind 是两键）
    const target = insertWait(fx.db, {
      projectId: pid, kind: 'card', targetId: 10, state: 'waiting', seq: 3,
    });
    assert.deepEqual(waitq.position(target, { db: fx.db }), [2, 2]);
    // 同 target 不同 kind（c:9 与 answer:9）是**两个键**，各计一次
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: 9, state: 'running', seq: 4 });
    const again = waitq.position(target, { db: fx.db });
    assert.deepEqual(again, [3, 3], 'a:9 是另一个成员键，进前缀也进总数');
  });
});

test('msgGet/msgMeta/msgRows：消息读口（state 过滤、created_at 升序、meta 最后一行 + 坏 JSON）', () => {
  withFixture('waitq7', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const uniq = uniqueCounter();
    const sid = `session-${uniq}`;
    // 同毫秒两行：按 id tie-break（照 waitq.msg_rows 的 `ORDER BY created_at, id`）
    insertMsg(fx.db, {
      id: `${uniq}-a`, projectId: pid, sid, message: 'first', state: 'queued', createdAt: 1000,
    });
    insertMsg(fx.db, {
      id: `${uniq}-b`, projectId: pid, sid, message: 'second', state: 'running', createdAt: 1000,
    });
    insertMsg(fx.db, {
      id: `${uniq}-c`, projectId: pid, sid, message: 'later', state: 'error',
      error: 'boom', createdAt: 2000,
    });

    assert.deepEqual(
      waitq.msgRows({ sid }, o).map((r) => r.id),
      [`${uniq}-a`, `${uniq}-b`, `${uniq}-c`],
      'created_at 升序 + 同毫秒按 id',
    );
    assert.deepEqual(
      waitq.msgRows({ sid, states: ['queued', 'running'] }, o).map((r) => r.id),
      [`${uniq}-a`, `${uniq}-b`],
    );
    assert.deepEqual(waitq.msgRows({ sid: 'nope' }, o), []);
    // card_id 过滤 + null 语义（未传 = 不过滤）
    const card = 77 + uniq;
    insertMsg(fx.db, {
      id: `${uniq}-d`, projectId: pid, sid, cardId: card, message: 'c', state: 'queued',
      createdAt: 3000,
    });
    assert.deepEqual(waitq.msgRows({ cardId: card }, o).map((r) => r.id), [`${uniq}-d`]);

    // msgGet：空 id / 未命中 ⇒ null
    assert.equal(waitq.msgGet(`${uniq}-a`, o).state, 'queued');
    assert.equal(waitq.msgGet('', o), null);
    assert.equal(waitq.msgGet('missing', o), null);

    // msgMeta：等待项行上的 meta，取**最后一行**（含终态）
    assert.deepEqual(waitq.msgMeta(`${uniq}-a`, o), {}, '无行 ⇒ {}');
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: `${uniq}-a`, state: 'running', seq: 1,
      meta: '{"family":"dsh_plugin","model":"m1","feishu":{"x":1}}',
    });
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: `${uniq}-a`, state: 'done', seq: 2,
      meta: '{"family":"dsh_plugin","model":"m2"}',
    });
    assert.deepEqual(waitq.msgMeta(`${uniq}-a`, o),
      { family: 'dsh_plugin', model: 'm2' }, '取 id 最大的那一行（含终态）');
    // 坏 JSON ⇒ {}（Python ValueError 分支）
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: `${uniq}-b`, state: 'done', seq: 3, meta: '{oops',
    });
    assert.deepEqual(waitq.msgMeta(`${uniq}-b`, o), {});
    // 非对象 JSON ⇒ {}（Node 侧有意收紧，见模块注释）
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: `${uniq}-c`, state: 'done', seq: 4, meta: '[1,2]',
    });
    assert.deepEqual(waitq.msgMeta(`${uniq}-c`, o), {});
  });
});

test('读连接契约：给 {db} 复用调用方句柄（不自开、不关）；不给也能按 dbPath 自开', () => {
  const fx = freshDb('waitq8');
  try {
    const pid = insertProject(fx.db, { name: 'p' });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'waiting', seq: 1 });
    const viaHandle = waitq.activeItems(pid, { db: fx.db });
    assert.equal(viaHandle.length, 1);
    // 句柄仍可用（没被读口 close）
    assert.ok(fx.db.prepare('SELECT 1 AS x').get());
    // 给 dbPath：自开短连接读同一份数据
    assert.equal(waitq.activeItems(pid, { dbPath: fx.dbPath }).length, 1);
    // 宽容写法：直接把句柄当 options（见 db.js 的 withReadDb 文件头）
    assert.equal(waitq.activeItems(pid, fx.db).length, 1);
  } finally {
    fx.close();
  }
});
