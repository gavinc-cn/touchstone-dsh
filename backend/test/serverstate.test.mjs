/**
 * `backend/lib/serverstate.js` 单测（node --test，零依赖）——M3 会话族的派生层。
 *
 * 为什么这些「派生字段」值得单测：它们直接进会话窗 JSON，判定序错一步就是**静默错语义**
 * （比如「已作答·待送达」本该压掉运行态、`c:` 本该改按 `a:` 求值），而对拍用例只覆盖
 * fixture 里恰好存在的那几种行组合。这里用**真 SQL 造行**把八枚举与改键规则逐条钉住。
 *
 * 夹具：`backend/test/m3fixture.mjs`（临时库 + 真启动序建表 + 真行插入）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as runner from '../lib/runner.js';
import * as st from '../lib/serverstate.js';
import { freshDb, insertCard, insertProject, insertTask, insertWait } from './m3fixture.mjs';

/** 跑一个用例并保证句柄关闭 */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return fn(fx, { db: fx.db });
  } finally {
    fx.close();
  }
}

test('projectBusy：无活跃行 false；有 c:/ext 活跃行 true；假值 projectId false', () => {
  withFixture('state-busy', (fx, o) => {
    const pid = insertProject(fx.db, {});
    assert.equal(st.projectBusy(pid, o), false);
    assert.equal(st.projectBusy(0, o), false);
    const card = insertCard(fx.db, pid, {});
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: card, state: 'running', seq: 1 });
    assert.equal(st.projectBusy(pid, o), true);
    // 外部条目（ext 行）同样计入项目占用
    const pid2 = insertProject(fx.db, { name: 'p2' });
    insertWait(fx.db, { projectId: pid2, kind: 'ext', targetId: '900', state: 'running', seq: 2 });
    assert.equal(st.projectBusy(pid2, o), true);
  });
});

test('unitState：t:/c: 取值 + 运行/排队/空闲 + 假值 projectId 给 null', () => {
  withFixture('state-unit', (fx, o) => {
    const pid = insertProject(fx.db, {});
    const task = insertTask(fx.db, pid, {});
    const card = insertCard(fx.db, pid, {});
    // 无行：idle（与 runner 直读逐字段一致——本函数只是薄封装）
    assert.deepEqual(st.unitState(pid, `t:${task}`, o), runner.unitState(`t:${task}`, pid, o));
    assert.deepEqual(st.unitState(pid, `t:${task}`, o), { state: 'idle', pos: 0, total: 0 });
    // 运行中的 t: 行
    insertWait(fx.db, { projectId: pid, kind: 'task', targetId: task, state: 'running', seq: 1 });
    assert.deepEqual(st.unitState(pid, `t:${task}`, o), { state: 'running', pos: 0, total: 0 });
    // 排队的 c: 行：pos/total 是**真实位次**——含运行前缀（上面那条运行中的 t: 行），
    // 故 pos=2 / total=2（v2a T4 位次口径：前缀成员数 + 等待区排号）
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: card, state: 'waiting', seq: 2 });
    assert.deepEqual(st.unitState(pid, `c:${card}`, o), { state: 'queued', pos: 2, total: 2 });
    // 假值 projectId / 非法 c: 数字（Python `int()` 失败 ⇒ 键保持原样）都给 idle/null
    assert.equal(st.unitState(0, `t:${task}`, o), null);
    assert.deepEqual(st.unitState(pid, 'c:abc', o), { state: 'idle', pos: 0, total: 0 });
  });
});

test('unitState：已作答·待送达的卡片改按 `a:<cid>` 求值（P6 改键规则）', () => {
  withFixture('state-answer-key', (fx, o) => {
    const pid = insertProject(fx.db, {});
    const card = insertCard(fx.db, pid, {});
    // 只有 answer 活跃行：c: 键本身无行（idle），a: 键有 waiting 行（queued pos=1）
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: card, state: 'waiting', seq: 5 });
    const byAnswer = runner.unitState(`a:${card}`, pid, o);
    assert.deepEqual(byAnswer, { state: 'queued', pos: 1, total: 1 });
    assert.deepEqual(st.unitState(pid, `c:${card}`, o), byAnswer,
      'c: 键必须改按 a: 求值（未改键会得到 idle）');
    assert.notDeepEqual(st.unitState(pid, `c:${card}`, o), runner.unitState(`c:${card}`, pid, o));
    // 已作答·待送达还压掉运行态（_board_session_running 的第一条判定）
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: card, state: 'running', seq: 6 });
    assert.equal(st.boardSessionRunning(card, { id: pid }, 'session-x', o), false);
  });
});

test('sessionQueueState：八枚举判定序（高→低）', () => {
  withFixture('state-queue', (fx, o) => {
    const pid = insertProject(fx.db, {});
    const running = { state: 'running', pos: 0, total: 0 };
    const queued = { state: 'queued', pos: 2, total: 3 };
    // 前三个 pending 压过一切
    assert.equal(st.sessionQueueState(pid, running, { answerPending: true }, o), board.QS_ANSWER);
    assert.equal(st.sessionQueueState(pid, running, { serverQueued: true, interactionPending: true }, o), board.QS_SERVER);
    assert.equal(st.sessionQueueState(pid, running, { interactionPending: true }, o), board.QS_INTERACTION);
    // 三个 pending 也必须**压过 running 标志**（判定序错置会被这几条抓住）
    assert.equal(st.sessionQueueState(pid, running, { running: true, answerPending: true }, o), board.QS_ANSWER);
    assert.equal(st.sessionQueueState(pid, running, { running: true, serverQueued: true }, o), board.QS_SERVER);
    assert.equal(st.sessionQueueState(pid, running, { running: true, interactionPending: true }, o), board.QS_INTERACTION);
    // answer/server 之间、interaction 之上也有序
    assert.equal(st.sessionQueueState(pid, running, { answerPending: true, serverQueued: true, interactionPending: true }, o), board.QS_ANSWER);
    assert.equal(st.sessionQueueState(pid, running, { serverQueued: true, interactionPending: true }, o), board.QS_SERVER);
    // running 口径（调用方）与行口径（unit_state=running）都判 running
    assert.equal(st.sessionQueueState(pid, { state: 'idle' }, { running: true }, o), board.QS_RUNNING);
    assert.equal(st.sessionQueueState(pid, running, {}, o), board.QS_RUNNING);
    // starting（板卡已交 runner、会话未证实运行）
    assert.equal(st.sessionQueueState(pid, { state: 'idle' }, { starting: true }, o), board.QS_STARTING);
    // queued 分叉：项目有活跃 ext 行 ⇒ foreign_busy，否则 queued_serial
    assert.equal(st.sessionQueueState(pid, queued, {}, o), board.QS_QUEUED);
    insertWait(fx.db, { projectId: pid, kind: 'ext', targetId: '901', state: 'running', seq: 1 });
    assert.equal(st.sessionQueueState(pid, queued, {}, o), board.QS_FOREIGN);
    // 其余 → idle
    assert.equal(st.sessionQueueState(pid, { state: 'idle' }, {}, o), board.QS_IDLE);
    assert.equal(st.sessionQueueState(pid, null, {}, o), board.QS_IDLE);
    // 任务会话传 projectId=0：不给 foreign_busy（Python `project_id and board.ext_active(...)`）
    assert.equal(st.sessionQueueState(0, queued, {}, o), board.QS_QUEUED);
  });
});

test('boardSessionRunning：无卡 false；运行映射命中 true；实况 busy 走 dshevents（M3 未知⇒false）', () => {
  withFixture('state-running', (fx, o) => {
    const pid = insertProject(fx.db, {});
    const proj = { id: pid, agent_path: 'dsh-plugin:/usr/bin/dsh', project_dir: '/tmp/proj' };
    assert.equal(st.boardSessionRunning(0, proj, 'session-x', o), false);
    // M3：runningMap() 恒空 + dshevents 未连接 ⇒ false（与「刚起的 Python 实例」等价）
    assert.equal(st.boardSessionRunning(insertCard(fx.db, pid, {}), proj, 'session-x', o), false);
  });
});

test('boardOwnsSid / boardOwned：session_id ∪ sessions 并集，跨项目取不到', () => {
  withFixture('state-owns', (fx, o) => {
    const pid = insertProject(fx.db, {});
    const pid2 = insertProject(fx.db, { name: 'p2' });
    const c1 = insertCard(fx.db, pid, { sessionId: 'session-main-0001' });
    const c2 = insertCard(fx.db, pid, { sessions: '["session-list-0002","session-list-0003"]' });
    const c3 = insertCard(fx.db, pid2, { sessionId: 'session-other-0009' });
    const row = { id: pid };
    assert.equal(st.boardOwnsSid(row, 'session-main-0001', o).id, c1);
    assert.equal(st.boardOwnsSid(row, 'session-list-0003', o).id, c2);
    assert.equal(st.boardOwnsSid(row, 'session-other-0009', o), null);   // 别的项目
    assert.equal(st.boardOwnsSid(row, 'session-nope', o), null);
    assert.equal(st.boardOwnsSid(row, '', o), null);
    // 回收站里的卡不算（list_board_cards 的 trashed=0 过滤）
    insertCard(fx.db, pid, { sessionId: 'session-trashed-0004', trashed: 1 });
    assert.equal(st.boardOwnsSid(row, 'session-trashed-0004', o), null);
    // 坏 JSON 的 sessions 列：跳过该卡（不炸），不匹配
    fx.db.prepare('UPDATE board_cards SET sessions=? WHERE id=?').run('{bad json', c2);
    assert.equal(st.boardOwnsSid(row, 'session-list-0002', o), null);
    // boardOwned：项目在、卡不在他项目 ⇒ card null
    assert.equal(st.boardOwned(pid, null, o).project.id, pid);
    assert.equal(st.boardOwned(pid, c3, o).card, null);
    assert.equal(st.boardOwned(pid, c1, o).card.id, c1);
    assert.equal(st.boardOwned(999999, null, o).project, null);
  });
});

test('taskSince：started_at 优先、created_at 回退、格式异常给 0（本地时区）', () => {
  assert.equal(st.taskSince({ started_at: '2026-10-11 00:00:00', created_at: '2026-01-01 00:00:00' }),
    new Date(2026, 9, 11, 0, 0, 0, 0).getTime() / 1000);
  assert.equal(st.taskSince({ started_at: '', created_at: '2026-01-01 00:00:00' }),
    new Date(2026, 0, 1, 0, 0, 0, 0).getTime() / 1000);
  assert.equal(st.taskSince({ started_at: 'not-a-date', created_at: '2026-01-01 00:00:00' }),
    new Date(2026, 0, 1, 0, 0, 0, 0).getTime() / 1000);
  assert.equal(st.taskSince({ started_at: 'bad', created_at: 'bad' }), 0);
  assert.equal(st.taskSince({}), 0);
  assert.equal(st.taskSince(null), 0);
});

test('interactionOfSid：M3 口径恒 null（调和器缓存属 M5）', () => {
  assert.equal(st.interactionOfSid('session-x'), null);
  assert.equal(st.interactionOfSid(''), null);
});
