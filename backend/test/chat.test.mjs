/**
 * backend/lib/chat.js 单测（node --test，零依赖）——**只读子集** + 两条 M3 边界。
 *
 * 覆盖：
 *   ① 表驱动读口：`msgsOfSid`（三态过滤 + 截断 + 排序）/ `liveOfSid` / `queuedCardIds`
 *      / `msgInfo`（等待项行态优先，行不在场回落 chat_msgs 态）；
 *   ② **边界①**：`state` 的空登记表分支——`_CHATS` 在 M3 恒空 ⇒ 与「刚起的 Python
 *      实例」逐点同（`running:false`，且**不带** started_at/message/exit_code 三键）；
 *   ③ `dshBusy` 的「驱动不可用 ⇒ false」分支（未配置驱动 ⇒ DshDriverError(-1) 被吞）。
 *
 * 所有场景都往 **mkdtemp 临时库** 里插真行（`m3fixture.mjs`），不 mock、不碰生产库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as chat from '../lib/chat.js';
import { freshDb, insertMsg, insertProject, insertWait } from './m3fixture.mjs';

/** 每个测试自带夹具；测试体跑完必关连接 */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return fn(fx);
  } finally {
    fx.close();
  }
}

test('常量：六状态 + CHAT_FAMILIES 单族 + CHAT_REGISTRY 恒空（M3 边界①的显式载体）', () => {
  assert.deepEqual(
    [chat.STATE_QUEUED, chat.STATE_RUNNING, chat.STATE_DONE,
      chat.STATE_YIELDED, chat.STATE_ERROR, chat.STATE_CANCELLED],
    ['queued', 'running', 'done', 'yielded', 'error', 'cancelled'],
  );
  assert.deepEqual([...chat.CHAT_FAMILIES], ['dsh_plugin']);
  assert.equal(chat.CHAT_REGISTRY.size, 0, '进程内对话登记表在 M3 恒空（写入点属 M4/M5）');
});

test('msgsOfSid：只发 queued/running/error 三态；text 截 120；created_at 升序（同刻按 id）', () => {
  withFixture('chat1', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const sid = 'session-chat1';
    insertMsg(fx.db, {
      id: 'b', projectId: pid, sid, message: 'B' + 'x'.repeat(200), state: 'error',
      error: 'boom', createdAt: 2000,
    });
    insertMsg(fx.db, { id: 'a', projectId: pid, sid, message: 'A', state: 'running', createdAt: 1000 });
    // 终态正常记录（done/yielded/cancelled）不发
    insertMsg(fx.db, { id: 'c', projectId: pid, sid, message: 'C', state: 'done', createdAt: 3000 });
    insertMsg(fx.db, { id: 'd', projectId: pid, sid, message: 'D', state: 'yielded', createdAt: 4000 });
    insertMsg(fx.db, { id: 'e', projectId: pid, sid, message: 'E', state: 'cancelled', createdAt: 5000 });

    const msgs = chat.msgsOfSid(sid, o);
    assert.deepEqual(msgs.map((m) => m.id), ['a', 'b'], '只发三态 + 升序');
    assert.deepEqual(msgs.map((m) => m.state), ['running', 'error']);
    assert.equal(msgs[1].error, 'boom');
    assert.equal(msgs[1].text.length, 120, 'text 截 120 字');
    assert.equal(msgs[0].created_at, 1000);
    // 空 sid / 未知 sid
    assert.deepEqual(chat.msgsOfSid('', o), []);
    assert.deepEqual(chat.msgsOfSid('nope', o), []);
  });
});

test('liveOfSid：queued|running 任一行即真（done/error 不算）', () => {
  withFixture('chat2', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    assert.equal(chat.liveOfSid('session-x', o), false);
    assert.equal(chat.liveOfSid('', o), false);
    insertMsg(fx.db, { id: 'm2', projectId: pid, sid: 'session-x', state: 'error', createdAt: 1 });
    assert.equal(chat.liveOfSid('session-x', o), false, 'error 不是「排队/执行中」');
    insertMsg(fx.db, { id: 'm1', projectId: pid, sid: 'session-x', state: 'queued', createdAt: 2 });
    assert.equal(chat.liveOfSid('session-x', o), true);
    // 另一会话不受影响
    assert.equal(chat.liveOfSid('session-y', o), false);
  });
});

test('queuedCardIds：仅 state=queued 且 card_id 非空；元素是 **int**（= Python waitq.msg_queued_card_ids）', () => {
  withFixture('chat3', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    insertMsg(fx.db, { id: 'q1', projectId: pid, sid: 's', cardId: 11, state: 'queued', createdAt: 1 });
    insertMsg(fx.db, { id: 'q2', projectId: pid, sid: 's', cardId: 11, state: 'queued', createdAt: 2 });
    insertMsg(fx.db, { id: 'q3', projectId: pid, sid: 's', cardId: 12, state: 'running', createdAt: 3 });
    insertMsg(fx.db, { id: 'q4', projectId: pid, sid: 's', cardId: null, state: 'queued', createdAt: 4 });
    insertMsg(fx.db, { id: 'q5', projectId: pid, sid: 's', cardId: 13, state: 'done', createdAt: 5 });

    const ids = chat.queuedCardIds(o);
    assert.deepEqual([...ids].sort((a, b) => a - b), [11], '只有 queued 且带卡片的进集合，且去重');
    // M4 归位：Python `waitq.msg_queued_card_ids()` 返回 int 集合，`chat.queued_card_ids()`
    // 是它的直通壳（chat.py:438）⇒ Node 侧同为 int（M3 曾是字符串，见 chat.js 注释）。
    assert.equal(typeof [...ids][0], 'number', 'int 口径（与 Python 一致）');
  });
});

test('msgInfo：state 恒取 chat_msgs 行（照 Python `msg_info`，等待项行在场也不覆盖）', () => {
  withFixture('chat4', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    insertMsg(fx.db, {
      id: 'mi1', projectId: pid, sid: 'session-m', taskId: 5, cardId: 6,
      message: 'hello', state: 'queued', createdAt: 1,
    });
    assert.deepEqual(chat.msgInfo('mi1', o), {
      id: 'mi1', sid: 'session-m', project_id: pid, task_id: 5, card_id: 6, state: 'queued',
    });
    // 有活跃等待项行 ⇒ **仍**取 chat_msgs.state（M4.5 收口：M4 曾写成「行态优先」，
    // 那是自创口径；Python `msg_info`(chat.py:441-450) 的 state 就是 `r["state"]`）
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: 'mi1', state: 'waiting', seq: 1,
    });
    assert.equal(chat.msgInfo('mi1', o).state, 'queued');
    fx.db.prepare("UPDATE chat_msgs SET state='running' WHERE id='mi1'").run();
    assert.equal(chat.msgInfo('mi1', o).state, 'running');
    // 行终态后同样只看 chat_msgs
    fx.db.prepare("UPDATE wait_items SET state='done' WHERE target_id='mi1'").run();
    assert.equal(chat.msgInfo('mi1', o).state, 'running');
    // 记录不存在 ⇒ null（终态 600s 回收窗口不变）
    assert.equal(chat.msgInfo('nope', o), null);
  });
});

test('边界①：state 的空登记表分支 = 刚起的 Python 实例（表驱动字段真实现，三键不出现）', async () => {
  // M4 起 `chat.state` 是 **async**（dshBusy 是远端读，Node 无同步 HTTP；见 chat.js 文件头
  // 「同步-异步契约」）。本用例的语义与 M3 逐条相同，只是改 await 形态。
  const fx = freshDb('chat5');
  try {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const sid = 'session-state';
    assert.equal(chat.CHAT_REGISTRY.size, 0, '前提：登记表恒空');

    // 无消息：base = {running:false, queued:0, msgs:[]}
    assert.deepEqual(await chat.state(sid, o), { running: false, queued: 0, msgs: [] });
    assert.deepEqual(await chat.state('', o), { running: false, queued: 0, msgs: [] });
    assert.deepEqual(await chat.state(null, o), { running: false, queued: 0, msgs: [] });

    // 有消息：queued 计数与 msgs 是**表驱动真实现**（只有 running 恒 false）
    insertMsg(fx.db, { id: 's1', projectId: pid, sid, message: 'one', state: 'queued', createdAt: 10 });
    insertMsg(fx.db, { id: 's2', projectId: pid, sid, message: 'two', state: 'queued', createdAt: 11 });
    insertMsg(fx.db, { id: 's3', projectId: pid, sid, message: 'three', state: 'running', createdAt: 12 });
    insertMsg(fx.db, { id: 's4', projectId: pid, sid, message: 'four', state: 'error', error: 'e', createdAt: 13 });

    const st = await chat.state(sid, o);
    assert.equal(st.running, false, '空登记表 ⇒ running 恒 false（等价刚起的 Python 实例）');
    assert.equal(st.queued, 2, 'queued 只数 state=queued 的');
    assert.deepEqual(st.msgs.map((m) => m.id), ['s1', 's2', 's3', 's4']);
    assert.deepEqual(Object.keys(st), ['running', 'queued', 'msgs'],
      '**不带** started_at/message/exit_code 三键（Python 空登记表分支同）');

    // 空 sid 也照样算 queued/msgs（Python 先算 base 再判 sid）
    const empty = await chat.state('', o);
    assert.equal(empty.queued, 0);
    assert.deepEqual(empty.msgs, []);

    // running() 是 state().running 的直读
    assert.equal(await chat.running(sid, o), false);
  } finally {
    fx.close();
  }
});

test('边界①（M4 已接线）：登记表有 dsh 记录 ⇒ 真读驱动；驱动不可达按空闲并回填 exit_code=0', async () => {
  // M3 的这条绊线（「登记表非空 ⇒ 抛 /M3 不可达/」）在 M4 被**有意拆掉**：接线后该分支
  // 真读驱动。现在钉住的是 M4 语义——驱动不可达时 `dshBusy` 吞 `DshDriverError` 给 false，
  // 且 `!busy && exit_code is None` 时**顺手回填 0**（回填写在进程内记录上，不落库）。
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  const savedToken = process.env.TS_AGENT_DRIVER_TOKEN;
  delete process.env.TS_AGENT_DRIVER_URL;      // 未配置驱动 = 独立形态（dshdriver.configured() 假）
  delete process.env.TS_AGENT_DRIVER_TOKEN;
  const fx = freshDb('chat6');
  const sid = 'session-injected';
  try {
    const o = { db: fx.db };
    const rec = { dsh_plugin: true, started_at: 1, message: 'm', exit_code: null };
    chat.CHAT_REGISTRY.set(sid, rec);
    const st = await chat.state(sid, o);
    assert.equal(st.running, false, '驱动不可达 ⇒ dsh_busy 吞错给 false');
    assert.equal(st.started_at, 1);
    assert.equal(st.message, 'm');
    assert.equal(st.exit_code, 0, '!busy 且 exit_code 为 None ⇒ 回填 0（Python 同）');
    assert.equal(rec.exit_code, 0, '回填写在登记表记录上（进程内，不落库）');
    assert.deepEqual(Object.keys(st),
      ['running', 'queued', 'msgs', 'started_at', 'message', 'exit_code'],
      '键序照 Python 的 `{**base, running:…, …}`（base 三键在前，覆写不挪位）');

    // 非 dsh 记录（防呆分支）仍按空闲呈现、不带三键
    chat.CHAT_REGISTRY.set('session-other', { dsh_plugin: false });
    assert.deepEqual(await chat.state('session-other', o), { running: false, queued: 0, msgs: [] });
  } finally {
    chat.CHAT_REGISTRY.delete(sid);
    chat.CHAT_REGISTRY.delete('session-other');
    fx.close();
    if (savedUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = savedUrl;
    if (savedToken === undefined) delete process.env.TS_AGENT_DRIVER_TOKEN;
    else process.env.TS_AGENT_DRIVER_TOKEN = savedToken;
  }
  assert.equal(chat.CHAT_REGISTRY.size, 0, '测试自清理，不污染其他测试文件（同进程）');
});

test('dshBusy：未配置驱动 ⇒ DshDriverError(-1) 被吞成 false（独立形态行为，照 Python）', async () => {
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  const savedToken = process.env.TS_AGENT_DRIVER_TOKEN;
  delete process.env.TS_AGENT_DRIVER_URL;
  delete process.env.TS_AGENT_DRIVER_TOKEN;
  try {
    assert.equal(await chat.dshBusy('session-any'), false, '驱动不可用按 false，交由发送路径报错');
  } finally {
    if (savedUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = savedUrl;
    if (savedToken === undefined) delete process.env.TS_AGENT_DRIVER_TOKEN;
    else process.env.TS_AGENT_DRIVER_TOKEN = savedToken;
  }
});

test('familyOfProject：直通 agents.agentFamily（单族世界只回 dsh_plugin / retired）', () => {
  assert.equal(chat.familyOfProject('dsh-plugin:/usr/local/bin/dsh'), 'dsh_plugin');
  assert.equal(chat.familyOfProject(''), 'dsh_plugin', '空 agent_path 是默认族');
  assert.equal(chat.familyOfProject('/usr/bin/kimi'), 'retired');
  assert.equal(chat.familyOfProject('/usr/bin/dsh'), 'retired', '裸 dsh CLI 已退场');
});
