/**
 * backend/lib/board.js 单测（node --test，零依赖）——**只读子集** + 边界清单的证据。
 *
 * 任务点名的覆盖项逐条对上：
 *   ① `boardPayload` 的 doing 列队序重排（`_doing_queue_order` 的 rank 规则 0/1/2）；
 *   ② `cardJson` 的全字段形状（键集合逐字比对 Python `card_json`）；
 *   ③ `queueStateOf` 的**八枚举判定序**（含批量/现算两条入口）；
 *   ④ `isAnswerPending` / `cardStarting` / `extActive` 的**表驱动分支**；
 *   ⑤ `settingsOf` 的深合并与 mode 归一（含坏 JSON、未知档）；
 *   ⑥ `queueStates` 的批量化与 `active_tasks` 的三列上映。
 *
 * 所有场景都往 **mkdtemp 临时库** 里插真行（`m3fixture.mjs`），不 mock、不碰生产库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import { freshDb, insertCard, insertComment, insertProject, insertTask, insertWait,
  setBoardSettings, uniqueCounter } from './m3fixture.mjs';

/** 每个测试自带夹具；测试体跑完必关连接 */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return fn(fx);
  } finally {
    fx.close();
  }
}

/** 从库里取出「卡片行」并逐字段转普通对象（模拟路由层拿到的行） */
function cardRow(fx, id) {
  return { ...fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(id) };
}

test('常量：五列 / 两档模式 / 四排序方案 / 八枚举 queue_state / 任务列映射', () => {
  assert.deepEqual([...board.COLUMNS], ['todo', 'doing', 'blocked', 'review', 'done']);
  assert.deepEqual([...board.MODE_VALUES], ['serial', 'parallel']);
  assert.deepEqual([...board.SORT_MODES],
    ['manual', 'created_desc', 'updated_desc', 'title', 'entered_desc']);
  assert.deepEqual(
    [board.QS_IDLE, board.QS_QUEUED, board.QS_ANSWER, board.QS_INTERACTION,
      board.QS_SERVER, board.QS_FOREIGN, board.QS_STARTING, board.QS_RUNNING],
    ['idle', 'queued_serial', 'answer_pending', 'interaction_pending',
      'server_queued', 'foreign_busy', 'starting', 'running'],
  );
  assert.deepEqual(board.TASK_BOARD_COLUMN, {
    queued: 'doing', running: 'doing', failed: 'review',
    interrupted: 'review', stopped: 'review', done: 'done',
  });
  assert.deepEqual([board.STATE_RUNNING, board.STATE_IDLE, board.STATE_UNKNOWN],
    ['running', 'idle', 'unknown']);
  // SETTINGS_DEFAULT 默认值逐字段（done 列 entered_desc 是唯一非 manual）
  assert.equal(board.SETTINGS_DEFAULT.mode, 'serial');
  assert.equal(board.SETTINGS_DEFAULT.sync_sessions, true);
  assert.deepEqual(board.SETTINGS_DEFAULT.sort,
    { todo: 'manual', doing: 'manual', blocked: 'manual', review: 'manual', done: 'entered_desc' });
});

test('cardTsMs：本地时区解释 + 逐字段校验（坏值/null，不滚动、不抛）', () => {
  // 用「本地时区构造」的期望值对齐 Python `time.mktime(time.strptime(...))`
  const expected = (y, mo, da, h, mi, s) => {
    const d = new Date(0);
    d.setFullYear(y, mo - 1, da);
    d.setHours(h, mi, s, 0);
    return d.getTime();
  };
  assert.equal(board.cardTsMs('2026-10-11 09:44:17'), expected(2026, 10, 11, 9, 44, 17));
  // 秒=60（闰秒）Python 接受；Date 会滚到下一分钟 ⇒ 逐字段校验拦下 ⇒ null
  assert.equal(board.cardTsMs('2026-10-11 09:44:60'), null);
  // 2 月 30 日：Python strptime 抛 ValueError；Date 会滚到 3 月 ⇒ 必须 null
  assert.equal(board.cardTsMs('2026-02-30 00:00:00'), null);
  assert.equal(board.cardTsMs('2026-13-01 00:00:00'), null);
  // 形状不符（Python strptime 的 ValueError 分支）
  assert.equal(board.cardTsMs('2026-10-11T09:44:17'), null);
  assert.equal(board.cardTsMs('2026-10-11'), null);
  assert.equal(board.cardTsMs('garbage'), null);
  // 空值（Python `if not ts_str`）
  assert.equal(board.cardTsMs(''), null);
  assert.equal(board.cardTsMs(null), null);
  assert.equal(board.cardTsMs(undefined), null);
});

test('cardWorkspace：worktree 非空用 worktree 路径，否则 project_dir（唯一读口）', () => {
  assert.equal(board.cardWorkspace({ project_dir: '/p' }, { worktree: '' }), '/p');
  assert.equal(board.cardWorkspace({ project_dir: '/p' }, { worktree: '   ' }), '/p');
  assert.equal(board.cardWorkspace({ project_dir: '/p' }, { worktree: '/w/card_1' }), '/w/card_1');
  // 缺列（老库）⇒ 回落 project_dir（`_card_opt` 的缺列分支）
  assert.equal(board.cardWorkspace({ project_dir: '/p' }, {}), '/p');
});

test('cardJson：全字段形状逐键（含 unread/sessions/worktree 的可选列容错）', () => {
  withFixture('board1', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, {
      title: 'T', description: 'D', columnKey: 'review', sortOrder: 3,
      sessionId: 'session-abc', sessions: '["session-a","session-b"]',
      blockKind: 'queue', blockText: 'bt', jiraKey: 'JIRA-1',
      lastError: 'boom', lastErrorAt: 1234, scheduledAt: 99,
      worktree: '/w/card_1', doneAt: null, origin: 'jira',
      unread: 1, createdAt: '2026-01-02 03:04:05', updatedAt: '2026-02-03 04:05:06',
    });
    const row = cardRow(fx, cid);
    // 不传 queueState：走「现算」路径（含 isAnswerPending/cardStarting 点查）
    const card = board.cardJson(row, {}, o);
    assert.deepEqual(Object.keys(card), [
      'id', 'project_id', 'title', 'description', 'column', 'sort_order', 'session_id',
      'sessions', 'block_kind', 'block_text', 'parent_card_id', 'origin', 'done_at',
      'trashed', 'trashed_at', 'scheduled_at', 'jira_key', 'last_error', 'last_error_at',
      'worktree', 'created_at', 'updated_at', 'updated_at_ts', 'unread',
      'running', 'busy', 'answer_pending', 'msg_queued', 'queue_state', 'lang',
    ]);
    assert.equal(card.id, cid);
    assert.equal(card.project_id, pid);
    assert.equal(card.column, 'review', 'column 取库里的 column_key');
    assert.deepEqual(card.sessions, ['session-a', 'session-b']);
    assert.equal(card.trashed, false, 'trashed 是布尔（Python bool()）');
    assert.equal(card.unread, true, 'unread 是布尔（Python bool(_card_opt(...) or 0)）');
    assert.equal(card.updated_at_ts, board.cardTsMs('2026-02-03 04:05:06'));
    assert.equal(card.running, false);
    assert.equal(card.busy, false);
    assert.equal(card.answer_pending, false);
    assert.equal(card.msg_queued, false);
    assert.equal(card.queue_state, board.QS_QUEUED, 'block_kind=queue ⇒ queued_serial');
    assert.equal(card.lang, 'zh', 'T13：未冻结/缺列 ⇒ 读侧归一 zh');

    // 显式 queueState ⇒ answer_pending 与之同源（`answer = queue_state == QS_ANSWER`）
    const viaExplicit = board.cardJson(row, {
      queueState: board.QS_ANSWER, running: true, busy: true, msgQueued: true,
    }, o);
    assert.equal(viaExplicit.answer_pending, true);
    assert.equal(viaExplicit.running, true);
    assert.equal(viaExplicit.busy, true);
    assert.equal(viaExplicit.msg_queued, true);

    // 坏 sessions JSON / 缺 worktree 列（老库）⇒ 降级不抛
    const legacy = { ...row, sessions: '{oops' };
    delete legacy.worktree;
    delete legacy.unread;
    delete legacy.lang;                     // 老库无 lang 列也必须降级（T13）
    const degraded = board.cardJson(legacy, {}, o);
    assert.deepEqual(degraded.sessions, []);
    assert.equal(degraded.worktree, '', '缺列回落空串');
    assert.equal(degraded.unread, false);
    assert.equal(degraded.lang, 'zh', '缺 lang 列 ⇒ 归一 zh');
  });
});

test('commentJson：七字段形状 + sent 归一布尔', () => {
  withFixture('board2', (fx) => {
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: 'c' });
    const id = insertComment(fx.db, cid, 'hello', {
      sent: 1, sessionId: 'session-x', sentText: 'delivered', createdAt: '2026-01-01 00:00:00',
    });
    const row = fx.db.prepare('SELECT * FROM board_comments WHERE id=?').get(id);
    const json = board.commentJson({ ...row });
    assert.deepEqual(Object.keys(json), [
      'id', 'card_id', 'text', 'sent', 'session_id', 'sent_text', 'created_at',
    ]);
    assert.equal(json.sent, true);
    assert.equal(json.sent_text, 'delivered');
    assert.equal(json.session_id, 'session-x');
  });
});

test('settingsOf：深合并（jira 全量 / sort 筛键）+ mode 归一（未知档 ⇒ serial）+ 坏 JSON 降级', () => {
  withFixture('board3', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });

    // ① 无记录 ⇒ 全默认
    assert.deepEqual(board.settingsOf(pid, o), {
      mode: 'serial',
      sync_sessions: true,
      jira: { url: '', user: '', token: '' },
      sort: { todo: 'manual', doing: 'manual', blocked: 'manual', review: 'manual',
        done: 'entered_desc' },
    });

    // ② 深合并：sort 只认识已有键（未知键被筛掉）；jira **不筛键**（Python 全量 update）
    setBoardSettings(fx.db, pid, {
      mode: 'parallel',
      sync_sessions: false,
      jira: { url: 'https://j', user: 'u', extra: 'keep-me' },
      sort: { doing: 'title', bogus: 'x' },
      unknown_top: 1,
    });
    const merged = board.settingsOf(pid, o);
    assert.equal(merged.mode, 'parallel');
    assert.equal(merged.sync_sessions, false);
    assert.deepEqual(merged.jira,
      { url: 'https://j', user: 'u', token: '', extra: 'keep-me' }, 'jira 多出来的键照留');
    assert.deepEqual(merged.sort,
      { todo: 'manual', doing: 'title', blocked: 'manual', review: 'manual',
        done: 'entered_desc' }, 'sort 未知键被筛掉、缺的落默认');
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'unknown_top'), false,
      '顶层只认识 SETTINGS_DEFAULT 里已有的键');

    // ③ mode 读取层归一：已删档 readonly-parallel 与任何未知值 ⇒ serial
    for (const bad of ['readonly-parallel', 'nonsense', '', null, 7]) {
      setBoardSettings(fx.db, pid, { mode: bad });
      assert.equal(board.settingsOf(pid, o).mode, 'serial', `mode=${JSON.stringify(bad)} 归一为 serial`);
    }

    // ④ 坏 JSON ⇒ {} ⇒ 全默认（Python 的 json.loads ValueError 分支）
    setBoardSettings(fx.db, pid, '{oops');
    assert.deepEqual(board.settingsOf(pid, o).sort.done, 'entered_desc');
    assert.equal(board.settingsOf(pid, o).mode, 'serial');

    // ⑤ 非对象 JSON ⇒ {}（Node 侧收紧，见 db.getBoardSettings）
    setBoardSettings(fx.db, pid, '[1,2]');
    assert.equal(board.settingsOf(pid, o).mode, 'serial');
  });
});

test('isAnswerPending / cardStarting / extActive：三条表驱动分支（活跃态口径）', () => {
  withFixture('board4', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: 'c', columnKey: 'doing' });

    assert.equal(board.isAnswerPending(cid, o), false);
    assert.equal(board.cardStarting(cid, o), false);
    assert.equal(board.extActive(pid, o), false);

    // answer 活跃行 ⇒ isAnswerPending=true（四活跃态任一）
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: cid, state: 'waiting', seq: 1 });
    assert.equal(board.isAnswerPending(cid, o), true);
    // c: 行 waiting ⇒ cardStarting=false（只有 starting 才算）
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: cid, state: 'waiting', seq: 2 });
    assert.equal(board.cardStarting(cid, o), false);
    // 升为 starting ⇒ true
    fx.db.prepare("UPDATE wait_items SET state='starting' WHERE kind='card' AND target_id=?")
      .run(String(cid));
    assert.equal(board.cardStarting(cid, o), true);
    // 升为 running ⇒ false（starting 与 running 的边界就是「是否证实运行」）
    fx.db.prepare("UPDATE wait_items SET state='running' WHERE kind='card' AND target_id=?")
      .run(String(cid));
    assert.equal(board.cardStarting(cid, o), false);

    // answer 行落终态 ⇒ isAnswerPending=false（活跃口径）
    fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='answer' AND target_id=?")
      .run(String(cid));
    assert.equal(board.isAnswerPending(cid, o), false);

    // ext 行：活跃 ⇒ true；终态 ⇒ false；他项目不串场
    const pid2 = insertProject(fx.db, { name: 'p2' });
    insertWait(fx.db, { projectId: pid, kind: 'ext', targetId: cid, state: 'running', seq: 3 });
    assert.equal(board.extActive(pid, o), true);
    assert.equal(board.extActive(pid2, o), false);
    fx.db.prepare("UPDATE wait_items SET state='failed' WHERE kind='ext'").run();
    assert.equal(board.extActive(pid, o), false);

    // 无 c: / worktree 的卡不参与（未入队 ⇒ 既不 pending 也不 starting）
    const other = insertCard(fx.db, pid, { title: 'other' });
    assert.equal(board.isAnswerPending(other, o), false);
    assert.equal(board.cardStarting(other, o), false);
  });
});

test('queueStateOf：八枚举判定序（高→低），批量入参与现算入口结果一致', () => {
  withFixture('board5', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: 'c', columnKey: 'doing' });
    const row = cardRow(fx, cid);

    // ① idle：无等待无运行
    assert.equal(board.queueStateOf(row, {}, o), board.QS_IDLE);
    // ② queued_serial：block_kind=queue
    assert.equal(board.queueStateOf({ ...row, block_kind: 'queue' }, {}, o), board.QS_QUEUED);
    // ②' queued_serial：msgQueued（无 c: 行也排队）
    assert.equal(board.queueStateOf(row, { msgQueued: true }, o), board.QS_QUEUED);
    // ③ foreign_busy：排队位 + 项目被外部会话占用（仅 queued 分支才分叉）
    assert.equal(board.queueStateOf({ ...row, block_kind: 'queue' },
      { foreign: true }, o), board.QS_FOREIGN);
    assert.equal(board.queueStateOf(row, { msgQueued: true, foreign: true }, o),
      board.QS_FOREIGN);
    assert.equal(board.queueStateOf(row, { foreign: true }, o), board.QS_IDLE,
      'idle 卡不因项目忙而报 foreign（foreign 只在排队占位分支生效）');
    // ④ running：running 或 busy
    assert.equal(board.queueStateOf(row, { running: true }, o), board.QS_RUNNING);
    assert.equal(board.queueStateOf(row, { busy: true }, o), board.QS_RUNNING);
    // ⑤ starting：显式入参（批量路径口径）
    assert.equal(board.queueStateOf(row, { starting: true }, o), board.QS_STARTING);
    // ⑤' 现算：库里真有 starting 的 c: 行
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: cid, state: 'starting', seq: 1 });
    assert.equal(board.queueStateOf(cardRow(fx, cid), {}, o), board.QS_STARTING);
    // ⑥ interaction_pending：block_kind=interaction（列无关），压 running/starting
    const irow = { ...row, block_kind: 'interaction' };
    assert.equal(board.queueStateOf(irow, {}, o), board.QS_INTERACTION);
    assert.equal(board.queueStateOf(irow, { running: true, busy: true, starting: true }, o),
      board.QS_INTERACTION, '提问挂起压 running（2026-09-25 加这一档的动因）');
    // ⑦ answer_pending 最高级：answer 活跃行在场时压一切
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: cid, state: 'waiting', seq: 2 });
    assert.equal(board.queueStateOf(cardRow(fx, cid),
      { running: true, busy: true, starting: true, msgQueued: true }, o), board.QS_ANSWER);
    assert.equal(board.queueStateOf(irow, {}, o), board.QS_ANSWER);
    // 批量入参 answer=true 与现算同结论
    assert.equal(board.queueStateOf(row, { answer: true }, o), board.QS_ANSWER);
    // 显式 answer=false 时**不再**现算（批量路径的语义：调用方负责给准）；
    // 但 starting 仍会现算（库里那条 c: 行还在 starting）⇒ 结果为 starting
    assert.equal(board.queueStateOf(row, { answer: false }, o), board.QS_STARTING);
    // 显式 starting=false 同理（answer=false + starting=false 才是 idle）
    assert.equal(board.queueStateOf(cardRow(fx, cid), { answer: false, starting: false }, o),
      board.QS_IDLE);

    // 八枚举齐了：idle/queued_serial/foreign_busy/running/starting/interaction_pending/
    // answer_pending；server_queued 是**会话级**枚举（board 的 queue_state_of 不含它 —— 
    // 它由 server._session_queue_state 判定），此处只断言常量在
    assert.equal(board.QS_SERVER, 'server_queued');
  });
});

test('doingQueueOrder：rank 规则 0/2 + setdefault（c:/ext: 优先于 a:）+ 非数字 target 跳过', () => {
  withFixture('board6', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const c1 = insertCard(fx.db, pid, { title: 'c1', columnKey: 'doing' });
    const c2 = insertCard(fx.db, pid, { title: 'c2', columnKey: 'doing' });
    const c3 = insertCard(fx.db, pid, { title: 'c3', columnKey: 'doing' });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: c1, state: 'running', seq: 10 });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: c2, state: 'waiting', seq: 20 });
    insertWait(fx.db, { projectId: pid, kind: 'ext', targetId: c3, state: 'starting', seq: 30 });
    // 非数字 target：Python `int()` 抛错被 except 吞掉 ⇒ 跳过；Node parseInt 给 NaN ⇒ 跳过
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 'nope', state: 'waiting', seq: 40 });

    const order = board.doingQueueOrder(pid, o);
    assert.equal(order.size, 3, '非数字 target 不进映射');
    assert.deepEqual(order.get(c1), [0, 10], 'c: 非 waiting ⇒ 运行位区 rank0');
    assert.deepEqual(order.get(c2), [2, 20], 'c: waiting ⇒ 等待区 rank2');
    assert.deepEqual(order.get(c3), [0, 30], 'ext: 非 waiting ⇒ 同样 rank0（运行位次由此接管）');

    // setdefault：同卡先有 a: 行、后有 c: 行时以 **c:** 为准（c:/ext: 优先于 a:）
    const c4 = insertCard(fx.db, pid, { title: 'c4', columnKey: 'doing' });
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: c4, state: 'waiting', seq: 50 });
    assert.deepEqual(board.doingQueueOrder(pid, o).get(c4), [2, 50], '只有 a: 行 ⇒ 落等待区');
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: c4, state: 'waiting', seq: 60 });
    assert.deepEqual(board.doingQueueOrder(pid, o).get(c4), [2, 60], 'c: 行优先（覆盖 a: 的 setdefault）');
  });
});

test('boardPayload：doing 列原位重排为队序（rank 0 → 1 → 2），他列原序不动', () => {
  withFixture('board7', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    // doing 列四张卡，sort_order 故意让「无行卡」排最前——重排后必须落 rank1 区
    const a = insertCard(fx.db, pid, { title: 'A-running', columnKey: 'doing', sortOrder: 4 });
    const b = insertCard(fx.db, pid, { title: 'B-waiting', columnKey: 'doing', sortOrder: 3 });
    const c = insertCard(fx.db, pid, { title: 'C-idle', columnKey: 'doing', sortOrder: 1 });
    const d = insertCard(fx.db, pid, { title: 'D-answer', columnKey: 'doing', sortOrder: 2 });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: a, state: 'running', seq: 5 });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: b, state: 'waiting', seq: 3 });
    insertWait(fx.db, { projectId: pid, kind: 'answer', targetId: d, state: 'waiting', seq: 9 });
    // 另列（todo）两张：重排不得动它们
    const t1 = insertCard(fx.db, pid, { title: 'T1', columnKey: 'todo', sortOrder: 2 });
    const t2 = insertCard(fx.db, pid, { title: 'T2', columnKey: 'todo', sortOrder: 1 });

    const payload = board.boardPayload(pid, o);
    const doingIdx = payload.cards.map((x, i) => [x.column, x.id, i])
      .filter(([col]) => col === 'doing').map(([, id]) => id);
    assert.deepEqual(doingIdx, [a, c, b, d],
      'rank0(A) → rank1(C) → rank2(B,D；同 rank 保持他列原序=sort_order 序)');
    // doing 列的**位置槽位**不变（原位替换，不是整体挪到末尾）
    assert.deepEqual(payload.cards.map((x) => x.column),
      ['doing', 'doing', 'doing', 'doing', 'todo', 'todo']);
    // todo 列原序（sort_order 1,2）不动
    assert.deepEqual(payload.cards.filter((x) => x.column === 'todo').map((x) => x.id),
      [t2, t1]);
    // queue_state 随行：**M3 下 running_map 为空 ⇒ 运行中行不产生 running 枚举**。
    // Python 的 `queue_state_of` 只从**入参** running/busy 取运行分量（行态里只有
    // starting 被现算），故库里有 running `c:` 行时分量仍为 false ⇒ 落 idle。
    // answer 行让 answer_pending 卡报最高级枚举；block_kind=queue 的卡报 queued_serial。
    const byId = new Map(payload.cards.map((x) => [x.id, x]));
    assert.equal(byId.get(a).queue_state, board.QS_IDLE,
      'M3 无 _RUNS ⇒ running 行的卡不报 running（枚举的运行分量来自 running_map/busy_map）');
    assert.equal(byId.get(d).queue_state, board.QS_ANSWER);
    assert.equal(byId.get(d).answer_pending, true);
    assert.equal(byId.get(b).queue_state, board.QS_IDLE,
      '等待中的 c: 行也不点亮 running（排队态的枚举要 block_kind=queue / msgQueued 入参）');
    assert.equal(byId.get(c).queue_state, board.QS_IDLE);
    // running_map 为空（M3 边界①）⇒ 所有卡 running=false
    assert.deepEqual(payload.cards.map((x) => x.running), [false, false, false, false, false, false]);

    // 注入非空 running_map：该卡 running/busy 都点亮（但 running_map 的数据源属 M5）
    const withRun = board.boardPayload(pid, { ...o, runningMap: { [a]: true } });
    const aCard = withRun.cards.find((x) => x.id === a);
    assert.equal(aCard.running, true);
    assert.equal(aCard.busy, true);
  });
});

test('boardPayload：comments/settings/active_tasks 三段（任务三列上映 + 两种排序）', () => {
  withFixture('board8', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: 'c' });
    insertComment(fx.db, cid, 'one', { createdAt: '2026-01-01 00:00:00' });
    insertComment(fx.db, cid, 'two', { createdAt: '2026-01-02 00:00:00' });
    setBoardSettings(fx.db, pid, { mode: 'parallel' });

    // 状态 → 列：queued/running → doing；failed/interrupted/stopped → review；done → done
    const queued = insertTask(fx.db, pid, {
      name: 'q', status: 'queued', createdAt: '2026-01-03 00:00:00',
    });
    const running = insertTask(fx.db, pid, {
      name: 'r', status: 'running', createdAt: '2026-01-01 00:00:00',
    });
    const stopped = insertTask(fx.db, pid, {
      name: 's', status: 'stopped', endedAt: '2026-01-05 00:00:00',
    });
    const done = insertTask(fx.db, pid, {
      name: 'd', status: 'done', endedAt: '2026-01-09 00:00:00',
    });
    // 映射外状态不上板
    insertTask(fx.db, pid, { name: 'x', status: 'weird' });

    const payload = board.boardPayload(pid, o);
    assert.deepEqual(payload.comments.map((c) => c.text), ['one', 'two']);
    assert.equal(payload.settings.mode, 'parallel');
    assert.deepEqual(payload.active_tasks.map((t) => [t.id, t.column]), [
      // doing 区：运行中在前，再按 created_at 升序
      [running, 'doing'], [queued, 'doing'],
      // review/done 区：ended_at 新→旧
      [done, 'done'], [stopped, 'review'],
    ]);
    assert.equal(payload.active_tasks.length, 4, '映射外状态不上板');
    assert.deepEqual(Object.keys(payload.active_tasks[0]), [
      'id', 'project_id', 'name', 'task_type', 'status', 'current_round',
      'session_id', 'error', 'created_at', 'started_at', 'ended_at', 'column',
    ]);
    assert.equal(payload.active_tasks[0].task_type, 'normal');
  });
});

test('queueStates：批量派生与逐卡现算同结论；proj=null 时 foreign 恒 false', () => {
  withFixture('board9', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const c1 = insertCard(fx.db, pid, { title: 'c1', columnKey: 'doing' });
    const c2 = insertCard(fx.db, pid, { title: 'c2', columnKey: 'doing', blockKind: 'queue' });
    const c3 = insertCard(fx.db, pid, { title: 'c3', columnKey: 'doing' });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: c1, state: 'starting', seq: 1 });

    const proj = fx.db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    const rows = fx.db.prepare(
      'SELECT * FROM board_cards WHERE project_id=? AND trashed=0 ORDER BY column_key, sort_order, id',
    ).all(pid).map((r) => ({ ...r }));

    // ① 无 ext 行：starting 压排队；block_kind=queue ⇒ queued_serial
    const states = board.queueStates(proj, rows, {}, {}, new Set(), o);
    assert.equal(states.get(c1), board.QS_STARTING, 'starting 行在场压排队');
    assert.equal(states.get(c2), board.QS_QUEUED, 'block_kind=queue ⇒ queued_serial');
    assert.equal(states.get(c3), board.QS_IDLE);

    // ② 项目有活跃 ext 行（= 外部会话在跑）：**所有**排队占位卡改报 foreign_busy
    //    （判据是项目级一次行读，不是逐卡判定——照 Python `queue_states`）
    insertWait(fx.db, { projectId: pid, kind: 'ext', targetId: c3, state: 'running', seq: 2 });
    assert.equal(board.extActive(pid, o), true, '前置：ext 行已落');
    const foreignStates = board.queueStates(proj, rows, {}, {}, new Set(), o);
    assert.equal(foreignStates.get(c2), board.QS_FOREIGN, '排队 + 项目被外部会话占用 ⇒ foreign_busy');
    assert.equal(foreignStates.get(c1), board.QS_STARTING, 'starting 压 foreign（判定序在排队之前）');
    assert.equal(foreignStates.get(c3), board.QS_IDLE, 'ext 行不点亮自己那张卡（它没排队占位）');

    // ③ 排队 + 项目外部占用 ⇒ 该卡 foreign_busy（msgQueued 同分支）
    //    集合元素是 **int**（M4 归位：`chat.queuedCardIds` = Python `waitq.msg_queued_card_ids`）
    const queuedStates = board.queueStates(proj, rows, {}, {}, new Set([c3]), o);
    assert.equal(queuedStates.get(c3), board.QS_FOREIGN);

    // ④ proj=null：无项目上下文降级，foreign 恒 false（foreign_busy 不可能出现）
    const nullProj = board.queueStates(null, rows, {}, {}, new Set([c3]), o);
    assert.equal(nullProj.get(c3), board.QS_QUEUED);
    assert.equal(nullProj.get(c2), board.QS_QUEUED, 'proj=null 时排队卡一律 queued_serial');

    // ⑤ 逐卡现算（cardJson 不传 queueState）——注意逐卡路径**不带** project 上下文，
    //    故 foreign 恒 false，与「proj=null」的批量结果一致……**除 c3 外**：c3 那张卡
    //    在 ③ 的批量入参里被当成「有排队消息」（msgQueued=true），而逐卡现算没有这个
    //    入参 ⇒ 结论不同是**入参不同**，不是两条路径不一致。下面按卡片各自的实际入参对。
    for (const r of rows) {
      const singly = board.cardJson(r, {}, o);
      const expected = r.id === c3 ? board.QS_IDLE : nullProj.get(r.id);
      assert.equal(singly.queue_state, expected, `卡 ${r.id} 两条路径同结论`);
    }
  });
});

test('边界①②③④：running_map 恒空、webBusyMap/webSessionBusy 无信号按 false、sessionState 未知', () => {
  withFixture('board10', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    const cid = insertCard(fx.db, pid, { title: 'c', sessionId: 'session-nope' });

    // 边界①：M5 的 `_RUNS` 在 M3 的等价物是**恒空表**
    assert.deepEqual(board.runningMap(), {});
    assert.equal(board.webFamily({ agent_path: 'dsh-plugin:/x' }), 'dsh_plugin');
    assert.equal(board.webFamily({ agent_path: '/usr/bin/kimi' }), null, '退场族 ⇒ null');
    assert.equal(board.webFamily({ agent_path: '' }), 'dsh_plugin', '空 agent_path 是默认族');

    // 边界④：未连接 dshevents ⇒ 快照空。**注意 webBusyMap 不是空表**——它按项目卡片
    // 的 sid 全量建表（Python 同：`{sid: bool(...)}`），只是每项都 false；「空表」是
    // 退场族/无卡项目才有的形态。busy 全 false = 不点亮、不误判。
    const snap = board.webBusyMap({ id: pid, agent_path: 'dsh-plugin:/x' }, {}, o);
    assert.deepEqual(snap, { 'session-nope': false },
      '项目内所有会话都在表里，值 false（无信号不推断运行）');
    assert.deepEqual(board.webBusyMap({ id: pid, agent_path: '/usr/bin/kimi' }, {}, o), {},
      '退场族 ⇒ 空表');
    // 无卡项目 ⇒ 空表（没有 sid 可建）
    const emptyProj = insertProject(fx.db, { name: 'empty' });
    assert.deepEqual(board.webBusyMap({ id: emptyProj, agent_path: 'dsh-plugin:/x' }, {}, o), {});
    const proj = fx.db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    assert.equal(board.webSessionBusy({ ...proj }, 'session-nope'), false);
    assert.equal(board.webSessionBusy({ ...proj }, ''), false, '无 sid ⇒ false');
    assert.equal(board.webSessionBusy({ ...proj, agent_path: '/usr/bin/kimi' }, 'session-nope'),
      false, '退场族 ⇒ false');
    assert.equal(board.sessionState({ ...proj }, 'session-nope'), board.STATE_UNKNOWN);
    assert.equal(board.sessionStateFamily('dsh_plugin', '/p', ''), board.STATE_UNKNOWN,
      '无 sid ⇒ unknown');
    assert.equal(board.sessionStateFamily(null, '/p', 'sid'), board.STATE_UNKNOWN);
    assert.equal(board.sessionStateFamily('retired', '/p', 'sid'), board.STATE_UNKNOWN);
    assert.equal(board.webBusy('dsh_plugin', '/p', 'sid'), false, 'unknown ⇒ 非 running ⇒ false');

    // 边界③：unitLiveness 走同一三态口（unknown ⇒ 'unknown'；非卡片行 ⇒ null）
    const waitRow = fx.db.prepare(
      'SELECT * FROM wait_items WHERE 1=0',
    );
    void waitRow;
    const cardLine = {
      kind: 'card', target_id: String(cid), project_id: pid, state: 'running',
    };
    assert.equal(board.unitLiveness(cardLine, o), 'unknown',
      '会话未知 ⇒ unknown（探测失败/状态不明只告警）');
    assert.equal(board.unitLiveness({ ...cardLine, kind: 'task' }, o), null,
      '非卡片行 ⇒ null（交 waitq 内建 DB 证据）');
    assert.equal(board.unitLiveness({ ...cardLine, target_id: 'nope' }, o), null,
      'target 非数字 ⇒ null');
    assert.equal(board.unitLiveness({ ...cardLine, target_id: '999999' }, o), null,
      '卡行已删 ⇒ null（内建证据即可证死）');
  });
});

test('worktreePreview：非 git 项目 ⇒ supported=false + 中文原因；已有会话/worktree 卡各自的分支', () => {
  withFixture('board11', (fx) => {
    const pid = insertProject(fx.db, {
      name: 'p', projectDir: '/tmp/ts-not-a-git-repo', workDir: '/tmp/ts-not-a-git-repo',
    });
    const cid = insertCard(fx.db, pid, { title: 'c' });
    const row = cardRow(fx, cid);
    const preview = board.worktreePreview({ project_dir: '/tmp/ts-not-a-git-repo' }, row);
    assert.equal(preview.supported, false);
    assert.match(preview.reason, /不是 git 仓库/);
    assert.equal(preview.branch, `ts/card-${cid}`);
    assert.equal(preview.path, '');
    assert.equal(preview.merge, null, '非 worktree 卡 ⇒ 无待合并判定');

    // 已有主会话的卡：D10 —— 不能切到独立 worktree（此分支**先于** git 判定）
    const withSession = insertCard(fx.db, pid, { title: 's', sessionId: 'session-x' });
    const sPreview = board.worktreePreview({ project_dir: '/tmp/ts-not-a-git-repo' },
      cardRow(fx, withSession));
    assert.equal(sPreview.supported, false);
    assert.match(sPreview.reason, /已有主会话/);
    assert.equal(sPreview.exists, false);

    // 已是 worktree 卡：supported=false（续跑自动复用）、path 回显、exists 反映磁盘
    const wtCard = insertCard(fx.db, pid, { title: 'w', worktree: '/tmp/ts-wt-preview-dir' });
    const wPreview = board.worktreePreview({ project_dir: '/tmp/ts-not-a-git-repo' },
      cardRow(fx, wtCard));
    assert.equal(wPreview.supported, false);
    assert.match(wPreview.reason, /已在独立 worktree 中运行/);
    assert.equal(wPreview.path, '/tmp/ts-wt-preview-dir');
    assert.equal(wPreview.exists, false, '目录不存在 ⇒ false');

    // mergePending：非 worktree 卡 ⇒ null（三种放行情形之一）
    assert.equal(board.mergePending({ project_dir: '/tmp/x' }, cardRow(fx, cid)), null);
  });
});

test('boardPayload：未知项目 ⇒ proj 为 null 时降级但仍给空 payload（不抛）', () => {
  withFixture('board12', (fx) => {
    const o = { db: fx.db };
    const uniq = uniqueCounter();
    const ghost = 900000 + uniq;
    const payload = board.boardPayload(ghost, o);
    assert.deepEqual(payload.cards, []);
    assert.deepEqual(payload.comments, []);
    assert.deepEqual(payload.active_tasks, []);
    assert.equal(payload.settings.mode, 'serial', '无设置行 ⇒ 默认');
  });
});
