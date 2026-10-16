/**
 * M5-1 写路径单测：卡片依赖 / 五列门禁 / doing 列手势 / 列内拖排 / 出队原语。
 *
 * 期望值来源一律是 `board.py` 原文（`set_parent` 297 / `move_card` 315 / `_doing_gesture` 494 /
 * `reorder_plan` 595 / `move_into_plan` 621 / `reorder_card` 641 / `_reorder_doing_card` 671 /
 * `_dequeue_card` 3193 / `_leave_doing` 3224 / 小判据 1863-1904·3797-3812），
 * **不是**读 Node 实现反推——反推只能证明「自己跟自己一致」。
 *
 * 两条测试口径：
 *   ① **跨批缝用记录桩**：`moveCard` 的起跑/停止/收尾/归档四条分支属 M5-2/M5-3，
 *      这里注入记录桩并**断言调用契约**（谁被调、带什么参、什么顺序）——比让未注入的
 *      缝抛错更有信息量，也把「缝的参数形状」钉成契约（M5-2 接线时改了形状这里会红）。
 *   ② **落库一律断言真行**：跑完读 `board_cards`/`wait_items` 真列（不 mock），
 *      因为 M5 的价值就在「列/占位/队序三者同拍」。
 *
 * 夹具一律 `mkdtemp` 临时库（`m3fixture.freshDb` 走真启动序），**绝不碰生产库**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as db from '../lib/db.js';
import {
  freshDb, insertCard, insertProject, insertWait, setBoardSettings,
} from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/**
 * 装记录桩（每次 setup 都重装，防测试间串状态）。
 * @returns {Array<Array>} 调用流水：`[name, ...args]`
 */
function installHooks() {
  const calls = [];
  // 桩的硬闸：**options 必须带 `{db}`**，否则当场炸。
  // 为什么值得单列：`db.js` 的读写口把「options 缺省」解释为「自开缺省库连接」= 生产库。
  // 于是「缝的形参错位」这类错误不会报错，而是**静默读写生产库**——2026-10-13 已连踩两次
  // （`enterDoing` 对象形态落到 `extra`；漏传一位使 `options` 落到 `queueWorktree`，
  // 导致单测写生产库）。桩不接受缺省值，把这一类错误变成红色断言。
  const requireDb = (name, options) => {
    if (options === null || options === undefined || typeof options !== 'object'
        || options.db === undefined || options.db === null) {
      throw new Error(`${name} 桩：options 必须带 {db}（漏传/错位会回落**生产库**）`);
    }
  };
  board.setBoardHooks({
    // 桩的形参**逐位对齐 Python `_enter_doing(project, card, extra, force, worktree,
    // queueWorktree, options)`**（7 位）——少一位就落到 `queueWorktree`、`options` 落空。
    enterDoing: (project, card, extra = '', force = false, worktree = false,
      queueWorktree = false, options = null) => {
      requireDb('enterDoing', options);
      calls.push(['enterDoing', card.id, force === true, extra]);
      // 起跑成功的最小副作用：落 doing（真实现由 M5-2 提供；这里只让调用方拿到卡）
      db.updateBoardCard(card.id, false, { column_key: 'doing', block_kind: null, block_text: '' },
        options);
      return [board.cardJson(db.getBoardCard(card.id, options), {}, options), null];
    },
    // 第 2 参就是 db options 袋（不是 `{options}`）——传错会让实现内部的读口回落缺省库路径
    stopCard: (cardId, options = null) => {
      requireDb('stopCard', options);
      calls.push(['stopCard', cardId, true]);
    },
    finish: (key, reason, opts = {}) => {
      calls.push(['finish', key, reason, opts.toColumn ?? null, opts.markUnread !== false]);
    },
    archiveCardSessions: (card, archived, reason, opts = {}) => {
      calls.push(['archive', card.id, archived, reason, opts.strict !== false]);
      return null;
    },
  });
  return calls;
}

/** 一次测试的夹具：临时库 + 一个项目 + 记录桩 */
function setup(tag = 'board-write') {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, { userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir });
  const calls = installHooks();
  const opts = { db: fx.db };
  return { fx, pid, calls, opts, ...fx };
}

/** 读卡片真行 */
function cardRow(fx, cardId) {
  return fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cardId);
}

/** 读活跃等待行（`kind=card`） */
function activeCardWait(fx, cardId) {
  return fx.db.prepare(
    "SELECT * FROM wait_items WHERE kind='card' AND target_id=?"
    + ' ORDER BY id DESC LIMIT 1',
  ).get(String(cardId));
}

// --------------------------------------------------------------------------
// Python int() 的宽松对应物
// --------------------------------------------------------------------------

test('pyIntLoose：Python int() 的接受面与截断面', async () => {
  assert.equal(board.pyIntLoose(7), 7);
  assert.equal(board.pyIntLoose('7'), 7);
  assert.equal(board.pyIntLoose('  7  '), 7);          // 两侧空白
  assert.equal(board.pyIntLoose('+7'), 7);
  assert.equal(board.pyIntLoose('-8'), -8);
  assert.equal(board.pyIntLoose('1_0'), 10);           // 下划线分隔（Python int 接受）
  assert.equal(board.pyIntLoose(7.9), 7);              // 向零截断（int(7.9) == 7）
  assert.equal(board.pyIntLoose(-7.9), -7);
  assert.equal(board.pyIntLoose(true), 1);
  assert.equal(board.pyIntLoose(false), 0);
  assert.equal(board.pyIntLoose(''), null);
  assert.equal(board.pyIntLoose('8.0'), null);         // int('8.0') 抛 ValueError
  assert.equal(board.pyIntLoose('abc'), null);
  assert.equal(board.pyIntLoose('_7'), null);
  assert.equal(board.pyIntLoose('7_'), null);
  assert.equal(board.pyIntLoose('1__0'), null);        // 连续下划线非法
  assert.equal(board.pyIntLoose(null), null);
  assert.equal(board.pyIntLoose(Number.NaN), null);    // int(nan) 抛 ValueError
  assert.equal(board.pyIntLoose(Number.POSITIVE_INFINITY), null);
  assert.equal(board.pyIntLoose(undefined), null);
});

// --------------------------------------------------------------------------
// 卡片依赖
// --------------------------------------------------------------------------

test('descendantIds：沿 parent_card_id 链向下取全部后代', async () => {
  const s = setup('desc');
  const a = insertCard(s.fx.db, s.pid, { title: 'A' });
  const b = insertCard(s.fx.db, s.pid, { title: 'B', parentCardId: a });
  const c = insertCard(s.fx.db, s.pid, { title: 'C', parentCardId: b });
  const d = insertCard(s.fx.db, s.pid, { title: 'D' });   // 无关卡
  assert.deepEqual([...board.descendantIds(s.pid, a, s.opts)].sort((x, y) => x - y), [b, c]);
  assert.deepEqual([...board.descendantIds(s.pid, b, s.opts)], [c]);
  assert.deepEqual([...board.descendantIds(s.pid, d, s.opts)], []);
  s.close();
});

test('setParent：自身/后代/非法/跨项目/回收站父卡一律 cycle，合法落库', async () => {
  const s = setup('setparent');
  const proj2 = insertProject(s.fx.db, { userId: 1, name: 'P2', projectDir: s.dir, workDir: s.dir });
  const a = insertCard(s.fx.db, s.pid, { title: 'A' });
  const b = insertCard(s.fx.db, s.pid, { title: 'B', parentCardId: a });
  const c = insertCard(s.fx.db, s.pid, { title: 'C', parentCardId: b });
  const other = insertCard(s.fx.db, proj2, { title: 'X' });
  const trashed = insertCard(s.fx.db, s.pid, { title: 'T', trashed: 1 });
  const opts = s.opts;

  assert.equal(board.setParent(s.pid, a, a, opts), 'cycle');          // 自己
  assert.equal(board.setParent(s.pid, a, b, opts), 'cycle');          // 后代
  assert.equal(board.setParent(s.pid, a, c, opts), 'cycle');          // 孙代
  assert.equal(board.setParent(s.pid, a, 'abc', opts), 'cycle');      // 非数字
  assert.equal(board.setParent(s.pid, a, 999999, opts), 'cycle');     // 不存在
  assert.equal(board.setParent(s.pid, a, other, opts), 'cycle');      // 跨项目
  assert.equal(board.setParent(s.pid, a, trashed, opts), 'cycle');    // 父卡在回收站

  assert.equal(board.setParent(s.pid, c, a, opts), null);             // 合法：C 依赖 A
  assert.equal(cardRow(s.fx, c).parent_card_id, a);
  assert.equal(board.setParent(s.pid, c, null, opts), null);          // 清空
  assert.equal(cardRow(s.fx, c).parent_card_id, null);

  // Python int(' 12 ') 接受两侧空白 ⇒ 字符串数字也要能绑定
  assert.equal(board.setParent(s.pid, c, ` ${a} `, opts), null);
  assert.equal(cardRow(s.fx, c).parent_card_id, a);
  s.close();
});

// --------------------------------------------------------------------------
// moveCard：硬错误与早退
// --------------------------------------------------------------------------

test('moveCard：卡不存在 / 非法列 / doing→todo 三档硬错误，库不动', async () => {
  const s = setup('move-err');
  const card = insertCard(s.fx.db, s.pid, { title: 'K', columnKey: 'doing' });
  assert.deepEqual(await board.moveCard({ id: s.pid }, 999999, 'todo', '', null, false, s.opts),
    [null, { error: 'card not found' }]);
  assert.deepEqual(await board.moveCard({ id: s.pid }, card, 'nope', '', null, false, s.opts),
    [null, { error: 'bad column' }]);
  assert.deepEqual(await board.moveCard({ id: s.pid }, card, 'todo', '', null, false, s.opts),
    [null, { error: 'doing 不可直接拖回 todo' }]);
  assert.equal(cardRow(s.fx, card).column_key, 'doing');
  assert.equal(s.calls.length, 0);
  s.close();
});

test('moveCard：同列非 doing 早退（返回卡、零写、零钩子）', async () => {
  const s = setup('move-same');
  const card = insertCard(s.fx.db, s.pid, { title: 'K', columnKey: 'review' });
  const before = cardRow(s.fx, card);
  const [out, err] = await board.moveCard({ id: s.pid }, card, 'review', '', null, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.column, 'review');
  assert.equal(cardRow(s.fx, card).updated_at, before.updated_at);   // 一字未写
  assert.equal(s.calls.length, 0);
  s.close();
});

test('moveCard：todo→blocked 记 manual 阻塞、清定时、落列尾、不置 unread、防御性停会话', async () => {
  const s = setup('move-blocked');
  const card = insertCard(s.fx.db, s.pid, {
    title: 'K', columnKey: 'todo', scheduledAt: 1_700_000_000, unread: 0,
  });
  insertCard(s.fx.db, s.pid, { title: 'B1', columnKey: 'blocked' });
  const [out, err] = await board.moveCard({ id: s.pid }, card, 'blocked', '等上游', null, false, s.opts);
  assert.equal(err, null);
  const row = cardRow(s.fx, card);
  assert.equal(row.column_key, 'blocked');
  assert.equal(row.block_kind, 'manual');
  assert.equal(row.block_text, '等上游');
  assert.equal(row.scheduled_at, null);        // 离开 todo 清定时
  assert.equal(row.sort_order, 2);             // 目标列 MAX+1
  assert.equal(row.unread, 0);                 // mark_unread=False：用户本人操作
  assert.equal(out.column, 'blocked');
  assert.deepEqual(s.calls.map((c) => c[0]), ['stopCard']);   // 非 doing 列防御性停会话
  s.close();
});

test('moveCard：非 manual 列忽略 beforeId（落列尾）；manual 列按 beforeId 整列重写', async () => {
  const s = setup('move-before');
  const a = insertCard(s.fx.db, s.pid, { title: 'A', columnKey: 'review', sortOrder: 1 });
  const b = insertCard(s.fx.db, s.pid, { title: 'B', columnKey: 'review', sortOrder: 2 });
  const moving = insertCard(s.fx.db, s.pid, { title: 'M', columnKey: 'todo' });
  const opts = s.opts;

  // 缺省 settings 的 review 列排序方案 = manual? 显式写死一份，两档都测
  setBoardSettings(s.fx.db, s.pid, { sort: { review: 'created_desc' } });
  await board.moveCard({ id: s.pid }, moving, 'review', '', a, false, opts);
  assert.equal(cardRow(s.fx, moving).sort_order, 3);           // 非 manual：列尾
  setBoardSettings(s.fx.db, s.pid, { sort: { review: 'manual' } });
  await board.moveCard({ id: s.pid }, moving, 'todo', '', null, false, opts);
  const [out2, err2] = await board.moveCard({ id: s.pid }, moving, 'review', '', a, false, opts);
  assert.equal(err2, null);
  assert.equal(out2.column, 'review');
  assert.equal(cardRow(s.fx, moving).sort_order, 1);           // 插到 a 之前
  assert.equal(cardRow(s.fx, a).sort_order, 2);
  assert.equal(cardRow(s.fx, b).sort_order, 3);

  // before 不在目标列 ⇒ 400 文案（列不动）
  await board.moveCard({ id: s.pid }, moving, 'todo', '', null, false, opts);
  const [, err3] = await board.moveCard({ id: s.pid }, moving, 'review', '', 999999, false, opts);
  assert.deepEqual(err3, { error: '目标位置卡不在该列' });
  assert.equal(cardRow(s.fx, moving).column_key, 'todo');
  s.close();
});

// --------------------------------------------------------------------------
// moveCard：归档闸与待合并闸
// --------------------------------------------------------------------------

test('moveCard：进 done 先归档（失败即整体放弃，列不动）', async () => {
  const s = setup('move-done');
  const card = insertCard(s.fx.db, s.pid, { title: 'K', columnKey: 'review' });
  board.setBoardHooks({
    archiveCardSessions: (c, archived, reason) => {
      s.calls.push(['archive', c.id, archived, reason]);
      return '归档失败：驱动不可用';
    },
  });
  const [out, err] = await board.moveCard({ id: s.pid }, card, 'done', '', null, false, s.opts);
  assert.equal(out, null);
  assert.deepEqual(err, { error: '归档失败：驱动不可用' });
  assert.equal(cardRow(s.fx, card).column_key, 'review');       // 归档先行：一个字节没动
  assert.deepEqual(s.calls, [['archive', card, true, '进入已完成']]);
  installHooks();                                               // 复位成成功桩

  const [out2, err2] = await board.moveCard({ id: s.pid }, card, 'done', '', null, false, s.opts);
  assert.equal(err2, null);
  assert.equal(out2.column, 'done');
  assert.equal(cardRow(s.fx, card).done_at !== null, true);     // done_at 派生
  s.close();
});

test('moveCard：离开 done 取消归档；merge_ack=true 跳过待合并闸', async () => {
  const s = setup('move-undone');
  const card = insertCard(s.fx.db, s.pid, { title: 'K', columnKey: 'done' });
  const [out, err] = await board.moveCard({ id: s.pid }, card, 'review', '', null, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.column, 'review');
  assert.deepEqual(s.calls.filter((c) => c[0] === 'archive'), [['archive', card, false, '离开已完成', true]]);
  assert.equal(cardRow(s.fx, card).done_at, null);              // 离开 done 清 done_at

  // 无 worktree 的卡：待合并闸直接放行（mergePending 给 null）
  const card2 = insertCard(s.fx.db, s.pid, { title: 'K2', columnKey: 'review' });
  const [out2, err2] = await board.moveCard({ id: s.pid }, card2, 'done', '', null, true, s.opts);
  assert.equal(err2, null);
  assert.equal(out2.column, 'done');
  s.close();
});

// --------------------------------------------------------------------------
// moveCard：进 doing / 离开 doing
// --------------------------------------------------------------------------

test('moveCard：进 doing 委托 enterDoing（单一写点）；离开 doing 走 leaveDoing', async () => {
  const s = setup('move-doing');
  const todo = insertCard(s.fx.db, s.pid, { title: 'T', columnKey: 'todo' });
  const [out, err] = await board.moveCard({ id: s.pid }, todo, 'doing', '', null, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.column, 'doing');
  assert.deepEqual(s.calls, [['enterDoing', todo, false, '']]);

  s.calls.length = 0;
  const [out2, err2] = await board.moveCard({ id: s.pid }, todo, 'review', '', null, false, s.opts);
  assert.equal(err2, null);
  assert.equal(out2.column, 'review');
  // stopCard 的第 2 参必须是 db options 袋（`true` = 桩看到 `{db}` 在场）：
  // 传成 `{options}` 时实现内部的读口会回落缺省库路径（= 生产库），量具与单测都要能照出来。
  assert.deepEqual(s.calls,
    [['stopCard', todo, true], ['finish', `c:${todo}`, '移列释放', null, true]]);
  s.close();
});

test('moveCard：doing→blocked 对排队占位卡只显式出队（不跑 leaveDoing）', async () => {
  const s = setup('move-queue-blocked');
  const card = insertCard(s.fx.db, s.pid, {
    title: 'Q', columnKey: 'doing', blockKind: 'queue', blockText: '排队等待：统一队列',
  });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'waiting', seq: 5 });
  const [out, err] = await board.moveCard({ id: s.pid }, card, 'blocked', '手动', null, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.column, 'blocked');
  const row = cardRow(s.fx, card);
  assert.equal(row.block_kind, 'manual');
  assert.equal(row.block_text, '手动');
  const wait = activeCardWait(s.fx, card);
  assert.equal(wait.state, 'cancelled');                        // 行+占位单事务取消
  // 队列占位分支不出队：leaveDoing/finish 不该被调（行已在上方显式取消）
  assert.deepEqual(s.calls.filter((c) => c[0] !== 'stopCard'), []);
  s.close();
});

test('moveCard：拖离时放弃待送达答案（取消活跃 a: 行）', async () => {
  const s = setup('move-answer');
  const card = insertCard(s.fx.db, s.pid, { title: 'A', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'answer', targetId: card, state: 'waiting', seq: 6 });
  assert.equal(board.isAnswerPending(card, s.opts), true);
  await board.moveCard({ id: s.pid }, card, 'blocked', '', null, false, s.opts);
  const ans = s.fx.db.prepare(
    "SELECT * FROM wait_items WHERE kind='answer' AND target_id=? ORDER BY id DESC LIMIT 1",
  ).get(String(card));
  assert.equal(ans.state, 'cancelled');
  assert.equal(board.isAnswerPending(card, s.opts), false);
  s.close();
});

test('moveCard：非 doing 列 → doing 列以外的移列也停会话（防御分支）', async () => {
  const s = setup('move-defensive');
  const card = insertCard(s.fx.db, s.pid, { title: 'R', columnKey: 'review' });
  await board.moveCard({ id: s.pid }, card, 'todo', '', null, false, s.opts);
  assert.deepEqual(s.calls, [['stopCard', card, true]]);
  s.close();
});

// --------------------------------------------------------------------------
// doing 列内手势
// --------------------------------------------------------------------------

test('doingGesture：非队列卡无手势语义（原样返回 200）', async () => {
  const s = setup('gesture-nonqueue');
  const card = insertCard(s.fx.db, s.pid, { title: 'S', columnKey: 'doing' });
  const [out, err] = await board.moveCard({ id: s.pid }, card, 'doing', '', null, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.id, card);
  assert.equal(s.calls.length, 0);
  s.close();
});

test('doingGesture：等待卡落到运行位 = force 手势（enterDoing(force=true)）', async () => {
  const s = setup('gesture-force');
  const running = insertCard(s.fx.db, s.pid, { title: 'RUN', columnKey: 'doing' });
  const waiting = insertCard(s.fx.db, s.pid, { title: 'WAIT', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: running, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: waiting, state: 'waiting', seq: 2 });
  const [out, err] = await board.moveCard({ id: s.pid }, waiting, 'doing', '', running, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.id, waiting);
  assert.deepEqual(s.calls.map((c) => [c[0], c[1], c[2]]), [['enterDoing', waiting, true]]);
  s.close();
});

test('doingGesture：运行卡落到等待卡之后 = 停止手势（递归落 review）', async () => {
  const s = setup('gesture-stop');
  const running = insertCard(s.fx.db, s.pid, { title: 'RUN', columnKey: 'doing' });
  const w1 = insertCard(s.fx.db, s.pid, { title: 'W1', columnKey: 'doing' });
  const w2 = insertCard(s.fx.db, s.pid, { title: 'W2', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: running, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w1, state: 'waiting', seq: 2 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w2, state: 'waiting', seq: 3 });
  // 运行卡拖到 W2 之前（其上方另有等待卡 W1）⇒ 停止
  const [out, err] = await board.moveCard({ id: s.pid }, running, 'doing', '', w2, false, s.opts);
  assert.equal(err, null);
  assert.equal(out.column, 'review');
  assert.equal(cardRow(s.fx, running).column_key, 'review');
  assert.deepEqual(s.calls.map((c) => c[0]), ['stopCard', 'finish']);
  s.close();
});

test('doingGesture：运行卡落到运行位 = no-op；等待卡落等待区 = 调序（只改 seq）', async () => {
  const s = setup('gesture-noop-reorder');
  const r1 = insertCard(s.fx.db, s.pid, { title: 'R1', columnKey: 'doing', sortOrder: 1 });
  const w1 = insertCard(s.fx.db, s.pid, { title: 'W1', columnKey: 'doing', sortOrder: 2 });
  const w2 = insertCard(s.fx.db, s.pid, { title: 'W2', columnKey: 'doing', sortOrder: 3 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: r1, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w1, state: 'waiting', seq: 2 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w2, state: 'waiting', seq: 3 });

  // 运行卡落到运行位（before=r1 自己）：no-op
  const [out1, err1] = await board.moveCard({ id: s.pid }, r1, 'doing', '', r1, false, s.opts);
  assert.equal(err1, null);
  assert.equal(out1.id, r1);

  // 等待卡 w1 落到 w2 之前：seq 交换（w2 原 3，w1 排到 3 之后 ⇒ 取 4/上界 3 之间）
  const [out2, err2] = await board.moveCard({ id: s.pid }, w2, 'doing', '', w1, false, s.opts);
  assert.equal(err2, null);
  assert.equal(out2.id, w2);
  const w2Seq = Number(s.fx.db.prepare(
    "SELECT seq FROM wait_items WHERE kind='card' AND target_id=?",
  ).get(String(w2)).seq);
  const w1Seq = Number(s.fx.db.prepare(
    "SELECT seq FROM wait_items WHERE kind='card' AND target_id=?",
  ).get(String(w1)).seq);
  assert.equal(w2Seq < w1Seq, true);           // w2 排到 w1 之前
  assert.equal(s.calls.length, 0);             // 调序不动会话
  s.close();
});

test('doingGesture：落点卡不在 doing 列 ⇒ 400 文案', async () => {
  const s = setup('gesture-badbefore');
  const w = insertCard(s.fx.db, s.pid, { title: 'W', columnKey: 'doing' });
  const other = insertCard(s.fx.db, s.pid, { title: 'O', columnKey: 'review' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w, state: 'waiting', seq: 1 });
  const [out, err] = await board.moveCard({ id: s.pid }, w, 'doing', '', other, false, s.opts);
  assert.equal(out, null);
  assert.deepEqual(err, { error: '目标位置卡不在该列' });
  s.close();
});

// --------------------------------------------------------------------------
// 列内拖排
// --------------------------------------------------------------------------

test('reorderPlan / moveIntoPlan：纯函数边界（列尾、自己压自己、不在列内）', async () => {
  const cards = [{ id: 10 }, { id: 11 }, { id: 12 }];
  assert.deepEqual(board.reorderPlan(cards, 11, null), [[10, 1], [12, 2], [11, 3]]);
  assert.deepEqual(board.reorderPlan(cards, 12, 10), [[12, 1], [10, 2], [11, 3]]);
  assert.deepEqual(board.reorderPlan(cards, 11, 11), [[10, 1], [12, 2], [11, 3]]);  // 自己压自己按列尾
  assert.throws(() => board.reorderPlan(cards, 99, null), board.PlanError);
  assert.throws(() => board.reorderPlan(cards, 10, 99), board.PlanError);
  assert.deepEqual(board.moveIntoPlan(cards, 99, null), [[10, 1], [11, 2], [12, 3], [99, 4]]);
  assert.deepEqual(board.moveIntoPlan(cards, 99, 11), [[10, 1], [99, 2], [11, 3], [12, 4]]);
  assert.throws(() => board.moveIntoPlan(cards, 99, 98), board.PlanError);
});

test('reorderCard：卡不存在 / 非 manual 列拒绝 / manual 列整列重写', async () => {
  const s = setup('reorder');
  const a = insertCard(s.fx.db, s.pid, { title: 'A', columnKey: 'review', sortOrder: 1 });
  const b = insertCard(s.fx.db, s.pid, { title: 'B', columnKey: 'review', sortOrder: 2 });
  const c = insertCard(s.fx.db, s.pid, { title: 'C', columnKey: 'review', sortOrder: 3 });
  assert.equal(board.reorderCard(s.pid, 999999, null, s.opts), '卡片不存在');
  setBoardSettings(s.fx.db, s.pid, { sort: { review: 'updated_desc' } });
  assert.equal(board.reorderCard(s.pid, c, a, s.opts), '当前列排序方案非手动，不可拖排');
  setBoardSettings(s.fx.db, s.pid, { sort: { review: 'manual' } });
  assert.equal(board.reorderCard(s.pid, c, a, s.opts), null);
  assert.equal(cardRow(s.fx, c).sort_order, 1);
  assert.equal(cardRow(s.fx, a).sort_order, 2);
  assert.equal(cardRow(s.fx, b).sort_order, 3);
  // 拖排不刷 updated_at（Python 明写：避免干扰 updated_desc 与排队顺序）
  assert.equal(cardRow(s.fx, a).updated_at, '2026-10-11 00:00:00');
  // before 不在列内 ⇒ 文案
  assert.equal(board.reorderCard(s.pid, c, 999999, s.opts), '目标位置卡不在该列');
  s.close();
});

test('reorderDoingCard：只动等待行 seq；运行行/非队列卡 no-op', async () => {
  const s = setup('reorder-doing');
  const r1 = insertCard(s.fx.db, s.pid, { title: 'R1', columnKey: 'doing' });
  const w1 = insertCard(s.fx.db, s.pid, { title: 'W1', columnKey: 'doing' });
  const w2 = insertCard(s.fx.db, s.pid, { title: 'W2', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: r1, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w1, state: 'waiting', seq: 2 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: w2, state: 'waiting', seq: 3 });
  // 运行行不参与调序：no-op
  assert.equal(board.reorderCard(s.pid, r1, null, s.opts), null);
  // w2 拖到 w1 之前 ⇒ seq 变小
  const beforeW2 = Number(s.fx.db.prepare(
    "SELECT seq FROM wait_items WHERE kind='card' AND target_id=?",
  ).get(String(w2)).seq);
  assert.equal(board.reorderCard(s.pid, w2, w1, s.opts), null);
  const afterW2 = Number(s.fx.db.prepare(
    "SELECT seq FROM wait_items WHERE kind='card' AND target_id=?",
  ).get(String(w2)).seq);
  assert.equal(afterW2 < beforeW2, true);
  // before 指向运行位卡 ⇒ 收拢到等待区最前（w2 排到 w1 之前）
  assert.equal(board.reorderCard(s.pid, w2, r1, s.opts), null);
  const w1Seq = Number(s.fx.db.prepare(
    "SELECT seq FROM wait_items WHERE kind='card' AND target_id=?",
  ).get(String(w1)).seq);
  const w2Seq = Number(s.fx.db.prepare(
    "SELECT seq FROM wait_items WHERE kind='card' AND target_id=?",
  ).get(String(w2)).seq);
  assert.equal(w2Seq < w1Seq, true);
  // before 指向不存在/他列卡 ⇒ 文案
  assert.equal(board.reorderCard(s.pid, w2, 999999, s.opts), '目标位置卡不在该列');
  s.close();
});

// --------------------------------------------------------------------------
// 出队原语
// --------------------------------------------------------------------------

test('dequeueCard：等待行取消 + 唯一收尾点 finish（toColumn/markUnread 透传）', async () => {
  const s = setup('dequeue-waiting');
  const card = insertCard(s.fx.db, s.pid, { title: 'W', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'waiting', seq: 3 });
  await board.dequeueCard(card, { reason: '移列释放', toColumn: 'blocked', markUnread: false, options: s.opts });
  assert.equal(activeCardWait(s.fx, card).state, 'cancelled');
  assert.deepEqual(s.calls, [['finish', `c:${card}`, '移列释放', 'blocked', false]]);
  s.close();
});

test('dequeueCard：运行行不被本原语取消（起点/运行终态归拾取方），finish 照常收口', async () => {
  const s = setup('dequeue-running');
  const card = insertCard(s.fx.db, s.pid, { title: 'R', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'running', seq: 3 });
  await board.dequeueCard(card, { reason: '移列释放', options: s.opts });
  assert.equal(activeCardWait(s.fx, card).state, 'running');   // 不抢拾取方的终态标签
  assert.deepEqual(s.calls, [['finish', `c:${card}`, '移列释放', null, true]]);
  s.close();
});

test('leaveDoing：stop=true 先停会话再收行；stop=false 只收行（交互挂起路径）', async () => {
  const s = setup('leave-doing');
  const card = insertCard(s.fx.db, s.pid, { title: 'L', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: card, state: 'waiting', seq: 4 });
  await board.leaveDoing(cardRow(s.fx, card), { reason: '出队-拖入阻塞', stop: true, options: s.opts });
  assert.deepEqual(s.calls.map((c) => c[0]), ['stopCard', 'finish']);

  s.calls.length = 0;
  const card2 = insertCard(s.fx.db, s.pid, { title: 'L2', columnKey: 'doing' });
  await board.leaveDoing(cardRow(s.fx, card2), { reason: '交互挂起', stop: false, options: s.opts });
  assert.deepEqual(s.calls.map((c) => c[0]), ['finish']);
  s.close();
});

test('未注入缝时响亮失败（BoardHookMissing 而非静默 no-op）', async () => {
  const s = setup('hooks-missing');
  const card = insertCard(s.fx.db, s.pid, { title: 'K', columnKey: 'review' });
  board.setBoardHooks({ stopCard: null, finish: null, enterDoing: null, archiveCardSessions: null });
  // setBoardHooks 收 null 视为「未注入」；两种形态都要响亮：同步抛（M5-1 期）与
  // 拒绝的 Promise（M5-2 起 moveCard 是 async）——这条不变量在 Node 的两种形态
  // 都不是「静默 no-op」，故断言写成「两种都算通过、其它一律失败」。
  const expectHookMissing = async (fn) => {
    try {
      await fn();
    } catch (e) {
      assert.equal(e instanceof board.BoardHookMissing, true,
        `期望 BoardHookMissing，实得 ${e && e.name}: ${e && e.message}`);
      return;
    }
    assert.fail('未抛 BoardHookMissing（缝缺失被静默吞掉了）');
  };
  await expectHookMissing(() => board.moveCard({ id: s.pid }, card, 'todo', '', null, false, s.opts));
  await expectHookMissing(() => board.moveCard({ id: s.pid }, card, 'doing', '', null, false, s.opts));
  installHooks();
  s.close();
});

// --------------------------------------------------------------------------
// 小判据与进程内登记表
// --------------------------------------------------------------------------

test('runningMap：读 RUNS 登记表（aborted 条目报 False、proc 条目按存活）', async () => {
  const s = setup('running-map');
  const c1 = insertCard(s.fx.db, s.pid, { title: 'C1', columnKey: 'doing' });
  const c2 = insertCard(s.fx.db, s.pid, { title: 'C2', columnKey: 'doing' });
  const c3 = insertCard(s.fx.db, s.pid, { title: 'C3', columnKey: 'doing' });
  assert.deepEqual(board.runningMap(), {});
  board.runRegistry.set(c1, { proc: null, aborted: false });     // 单族 dsh：有条目即运行中
  board.runRegistry.set(c2, { proc: null, aborted: true });      // 已 abort：立即报 False
  board.runRegistry.set(c3, { proc: { exitCode: null, signalCode: null } });
  const rm = board.runningMap();
  assert.equal(rm[c1], true);
  assert.equal(rm[c2], false);
  assert.equal(rm[c3], true);
  assert.equal(rm.get(c1), true);
  assert.equal(rm.get(999999), false);
  assert.equal(board.hasActiveRun(c1), true);
  assert.equal(board.sessionInFlight(c1), true);
  assert.equal(board.sessionInFlight(c2), true);                 // 条目在途（aborted 也算在途）
  assert.equal(board.sessionInFlight(999999), false);
  for (const c of [c1, c2, c3]) board.runRegistry.delete(c);
  assert.deepEqual(board.runningMap(), {});
  s.close();
});

test('cardUnitActive / platformHolds / gestureRunPosition：行态 ∪ 在管条目', async () => {
  const s = setup('unit-active');
  const running = insertCard(s.fx.db, s.pid, { title: 'R', columnKey: 'doing' });
  const starting = insertCard(s.fx.db, s.pid, { title: 'S', columnKey: 'doing' });
  const idle = insertCard(s.fx.db, s.pid, { title: 'I', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: running, state: 'running', seq: 1 });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: starting, state: 'starting', seq: 2 });
  assert.equal(board.cardUnitActive(running, s.opts), true);
  assert.equal(board.cardUnitActive(starting, s.opts), true);    // starting 也算在管（裁决 R6）
  assert.equal(board.cardUnitActive(idle, s.opts), false);
  assert.equal(board.platformHolds(running, s.opts), true);
  assert.equal(board.platformHolds(idle, s.opts), false);
  board.runRegistry.set(idle, { proc: null, aborted: false });
  assert.equal(board.platformHolds(idle, s.opts), true);         // 在管条目分支兜底
  assert.equal(board.gestureRunPosition(idle, s.opts), true);
  insertWait(s.fx.db, { projectId: s.pid, kind: 'answer', targetId: idle, state: 'waiting', seq: 9 });
  assert.equal(board.gestureRunPosition(idle, s.opts), false);   // answer 占位卡不参与手势
  board.runRegistry.delete(idle);
  for (const c of [running, starting]) board.runRegistry.delete(c);
  s.close();
});

test('startingWindow：c: 行 starting ∨ worktree 直起窗口；已登记条目一律不算窗口', async () => {
  const s = setup('starting-window');
  const c1 = insertCard(s.fx.db, s.pid, { title: 'C1', columnKey: 'doing' });
  const c2 = insertCard(s.fx.db, s.pid, { title: 'C2', columnKey: 'doing' });
  const c3 = insertCard(s.fx.db, s.pid, { title: 'C3', columnKey: 'doing' });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c1, state: 'starting', seq: 1 });
  assert.equal(board.startingWindow(c1, null, s.opts), true);
  board.wtRegistry.add(c2);
  assert.equal(board.startingWindow(c2, null, s.opts), true);
  assert.equal(board.wtInFlight(c2), true);
  board.wtRegistry.delete(c2);
  assert.equal(board.startingWindow(c2, null, s.opts), false);
  board.runRegistry.set(c3, { proc: null, aborted: false });
  insertWait(s.fx.db, { projectId: s.pid, kind: 'card', targetId: c3, state: 'starting', seq: 2 });
  assert.equal(board.startingWindow(c3, null, s.opts), false);   // 已证实起跑 ⇒ 不是窗口
  board.runRegistry.delete(c3);
  s.close();
});
