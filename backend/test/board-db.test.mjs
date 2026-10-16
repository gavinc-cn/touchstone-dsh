/**
 * 看板写口单测（M5-1）：`lib/db.js` 的卡片 / 评论 / 设置写口（`db.py:1140-1394` 的对应物）。
 *
 * 期望值来源（**不读 Node 实现反推**）：`db.py` 的
 * `insert_board_card`(1148) / `update_board_card`(1242) / `mark_card_viewed`(1280) /
 * `trash_board_card`(1296) / `restore_board_card`(1306) / `purge_board_card`(1315) /
 * `purge_trashed_cards`(1326) / `insert_board_comment`(1340) / `update_board_comment`(1359) /
 * `delete_board_comment`(1370) / `set_board_settings`(1389) 逐行对照；
 * 每条语义另用**真 Python 探针**在同一批场景上实测复核过（探针在 /tmp，不入库）：
 *   - todo 列尾 = `MAX(sort_order)+1` **含回收站卡**（trashed 卡占号）：实测手工放一张
 *     `trashed=1, sort_order=50` 的 todo 卡后新卡取 51；
 *   - 同列写回**照刷** `updated_at`、也照发信号，只是不置 `unread`；
 *   - 卡不存在 ⇒ 连 `updated_at` 都不写、不发信号；
 *   - `purge_trashed_cards` 空/非空**都不发信号**（Python 全函数无 localbus 调用）。
 *
 * 夹具口径：临时库（`m3fixture.freshDb`，**绝不碰生产库**）；写口一律显式给库位置 ——
 * 主体用 `{dbPath}`（走「自开连接 + BEGIN/COMMIT」的生产缺省路径），另有一条用 `{db}`
 * 钉住调用方句柄（路由层今天就是这么传的），两者结果必须一致。
 * 变更信号用 `localbus.seq(topic)` 的**增量**观测（publish 只动序号、不带载荷）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import { BUS, boardTopic, seq } from '../lib/localbus.js';
import { freshDb, insertCard, insertComment, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 时间戳形态（`now_str()` 口径：本地时间 `YYYY-MM-DD HH:MM:SS`） */
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 临时库 + 两个项目（`other` 用来证明信号只落在本项目的 topic 上） */
function setup() {
  const fx = freshDb('board-db');
  const pid = insertProject(fx.db, { userId: 1, name: 'P-board' });
  const other = insertProject(fx.db, { userId: 1, name: 'P-other' });
  return { ...fx, pid, other, opts: { dbPath: fx.dbPath } };
}

/** 卡片行（普通对象；未命中 null） */
function cardRow(fx, id) {
  const row = fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(id);
  return row === undefined ? null : { ...row };
}

/** 评论行（普通对象；未命中 null） */
function commentRow(fx, id) {
  const row = fx.db.prepare('SELECT * FROM board_comments WHERE id=?').get(id);
  return row === undefined ? null : { ...row };
}

/** 看板设置列原文（不给就是 null） */
function settingsRaw(fx, pid) {
  const row = fx.db.prepare('SELECT json FROM board_settings WHERE project_id=?').get(pid);
  return row === undefined ? null : row.json;
}

/** 该 topic 的当前信号序号（断言用增量，避免跨测试的累计值干扰） */
function sig(projectId) {
  return seq(boardTopic(projectId));
}

/** 时间戳与「现在」的秒差（本地时间解析；给 `withinSecondsOfNow` 用） */
function secondsFromNow(ts) {
  return Math.abs(Date.now() - new Date(ts.replace(' ', 'T')).getTime()) / 1000;
}

// --------------------------------------------------------------------------
// 建卡
// --------------------------------------------------------------------------

test('insertBoardCard：落 todo 列尾（MAX+1 含回收站卡）、发信号、返回 id', () => {
  const fx = setup();
  // todo 列两张 + doing 列一张 + 一张**回收站里的 todo 卡**（sort_order 手工放大到 50）
  insertCard(fx.db, fx.pid, { title: 'a', columnKey: 'todo' });
  insertCard(fx.db, fx.pid, { title: 'b', columnKey: 'todo' });
  insertCard(fx.db, fx.pid, { title: 'd', columnKey: 'doing' });
  insertCard(fx.db, fx.pid, {
    title: 'trashed-todo', columnKey: 'todo', sortOrder: 50, trashed: 1,
    trashedAt: '2026-10-12 00:00:00',
  });
  insertCard(fx.db, fx.other, { title: 'p2-todo', columnKey: 'todo', sortOrder: 9 });

  const before = sig(fx.pid);
  const beforeOther = sig(fx.other);
  const cid = db.insertBoardCard(fx.pid, 'new', 'desc', 'JIRA-1', fx.opts);

  const row = cardRow(fx, cid);
  assert.ok(Number.isInteger(cid) && cid > 0, `id 必须是正整数，实际 ${cid}`);
  assert.equal(row.project_id, fx.pid);
  assert.equal(row.title, 'new');
  assert.equal(row.description, 'desc');
  assert.equal(row.column_key, 'todo');
  assert.equal(row.sort_order, 51);          // 回收站卡（50）也占号 ⇒ 51（Python 无 trashed 过滤）
  assert.equal(row.jira_key, 'JIRA-1');
  assert.equal(row.trashed, 0);
  assert.equal(row.unread, 0);
  assert.match(row.created_at, TS_RE);
  assert.match(row.updated_at, TS_RE);
  assert.ok(row.updated_at >= row.created_at, 'updated_at 不得早于 created_at');

  // 列尾：非回收站 todo 卡里它序号最大
  const maxTodo = fx.db.prepare(
    "SELECT MAX(sort_order) AS m FROM board_cards"
    + " WHERE project_id=? AND column_key='todo' AND trashed=0").get(fx.pid).m;
  assert.equal(maxTodo, 51);

  assert.equal(sig(fx.pid) - before, 1, '建卡必须发一次本项目看板信号');
  assert.equal(sig(fx.other) - beforeOther, 0, '不得发别的项目 topic 的信号');
  fx.close();
});

test('insertBoardCard：description / jira_key 有缺省（空串），序号继续递增', () => {
  const fx = setup();
  const first = db.insertBoardCard(fx.pid, 'one', 'D', 'K', fx.opts);
  const second = db.insertBoardCard(fx.pid, 'two', undefined, undefined, fx.opts);
  assert.equal(cardRow(fx, first).sort_order, 1);
  const row = cardRow(fx, second);
  assert.equal(row.sort_order, 2);
  assert.equal(row.description, '');
  assert.equal(row.jira_key, '');
  fx.close();
});

// --------------------------------------------------------------------------
// 更新：done_at 派生 / unread 派生 / no-op 边界
// --------------------------------------------------------------------------

test('updateBoardCard：done_at 派生（落 done 盖当前时间、离开清空、显式给的优先）', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, { columnKey: 'todo', updatedAt: '2026-10-12 00:00:00' });

  db.updateBoardCard(cid, true, { column_key: 'done' }, fx.opts);
  let row = cardRow(fx, cid);
  assert.equal(row.column_key, 'done');
  assert.match(row.done_at, TS_RE);
  assert.ok(secondsFromNow(row.done_at) < 10, `done_at 应是「现在」：${row.done_at}`);
  assert.equal(row.unread, 1);                       // 真换列 ⇒ 一并置位
  assert.ok(row.updated_at >= '2026-10-12 00:00:00');

  // 离开 done ⇒ done_at 清空
  db.updateBoardCard(cid, true, { column_key: 'review' }, fx.opts);
  row = cardRow(fx, cid);
  assert.equal(row.done_at, null);

  // 显式给了 done_at ⇒ 不派生（原样写）
  db.updateBoardCard(cid, true, { column_key: 'done', done_at: '2030-01-01 00:00:00' }, fx.opts);
  assert.equal(cardRow(fx, cid).done_at, '2030-01-01 00:00:00');

  // 显式 null 同样优先（Python: `"done_at" not in fields` 才派生）
  db.updateBoardCard(cid, true, { column_key: 'done', done_at: null }, fx.opts);
  assert.equal(cardRow(fx, cid).done_at, null);
  fx.close();
});

test('updateBoardCard：unread 只在列真变化时置位（同列写回不置位；markUnread=false 不置位）', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, {
    columnKey: 'todo', updatedAt: '2026-10-12 00:00:00', unread: 0,
  });

  const s0 = sig(fx.pid);
  db.updateBoardCard(cid, true, { column_key: 'doing' }, fx.opts);
  assert.equal(cardRow(fx, cid).unread, 1);
  assert.equal(sig(fx.pid) - s0, 1);

  // 同列写回：updated_at 照刷（SQL 照跑）、信号照发，但不置 unread
  fx.db.prepare("UPDATE board_cards SET unread=0, updated_at='2026-10-12 00:00:00' WHERE id=?")
    .run(cid);
  const s1 = sig(fx.pid);
  db.updateBoardCard(cid, true, { column_key: 'doing' }, fx.opts);
  let row = cardRow(fx, cid);
  assert.equal(row.unread, 0);
  assert.notEqual(row.updated_at, '2026-10-12 00:00:00', 'updated_at 必须照刷');
  assert.equal(sig(fx.pid) - s1, 1);

  // markUnread=false（用户本人在看板上操作）：真换列也不置位
  fx.db.prepare('UPDATE board_cards SET unread=0 WHERE id=?').run(cid);
  db.updateBoardCard(cid, false, { column_key: 'review' }, fx.opts);
  assert.equal(cardRow(fx, cid).unread, 0);

  // Python 真值口径：0 / null 等假值同 false
  db.updateBoardCard(cid, 0, { column_key: 'blocked' }, fx.opts);
  assert.equal(cardRow(fx, cid).unread, 0);
  db.updateBoardCard(cid, null, { column_key: 'doing' }, fx.opts);
  assert.equal(cardRow(fx, cid).unread, 0);

  // 不带 column_key 的更新根本不看 unread
  fx.db.prepare('UPDATE board_cards SET unread=0 WHERE id=?').run(cid);
  db.updateBoardCard(cid, true, { title: 'x' }, fx.opts);
  assert.equal(cardRow(fx, cid).unread, 0);

  // 非空真值（真值判定按 Python：非空数组为真）
  db.updateBoardCard(cid, [1], { column_key: 'review' }, fx.opts);
  assert.equal(cardRow(fx, cid).unread, 1);
  fx.close();
});

test('updateBoardCard：卡不存在 ⇒ 整体 no-op（不写 updated_at、不发信号）', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, {
    columnKey: 'todo', updatedAt: '2026-10-12 00:00:00', unread: 0,
  });
  const snapshot = cardRow(fx, cid);
  const s = sig(fx.pid);

  db.updateBoardCard(999999, true, { column_key: 'done' }, fx.opts);

  assert.equal(sig(fx.pid) - s, 0, '卡不存在不得发信号');
  assert.deepEqual(cardRow(fx, cid), snapshot, '别的卡一个字节都不许动');
  fx.close();
});

test('updateBoardCard：白名单外字段被静默丢弃；过滤后为空即 no-op', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, {
    columnKey: 'todo', updatedAt: '2026-10-12 00:00:00', unread: 0, trashed: 0,
  });
  const snapshot = cardRow(fx, cid);
  const s = sig(fx.pid);

  // unread / trashed / created_at / id 都不在 BOARD_CARD_FIELDS 里 ⇒ 一个都不许进 SQL
  db.updateBoardCard(cid, true, {
    unread: 1, trashed: 1, trashed_at: '2030-01-01 00:00:00', created_at: '2030-01-01 00:00:00',
    id: 4242, bogus: 1,
  }, fx.opts);
  assert.equal(sig(fx.pid) - s, 0);
  assert.deepEqual(cardRow(fx, cid), snapshot);

  // 空对象 / null 同样 no-op（Python 侧 `**fields` 空 dict）
  db.updateBoardCard(cid, true, {}, fx.opts);
  db.updateBoardCard(cid, true, null, fx.opts);
  assert.deepEqual(cardRow(fx, cid), snapshot);

  // 白名单内外混着给：白名单的照写、白名单外的静默丢
  db.updateBoardCard(cid, true, { title: 'T2', bogus: 1 }, fx.opts);
  const row = cardRow(fx, cid);
  assert.equal(row.title, 'T2');
  assert.equal(row.column_key, 'todo');
  assert.equal(row.unread, 0);
  assert.equal(sig(fx.pid) - s, 1, '白名单内字段真写了 ⇒ 发信号');
  fx.close();
});

test('updateBoardCard：不修改调用方传入的 fields（Python 的 **fields 是副本）', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, { columnKey: 'todo' });
  const fields = { column_key: 'done' };
  db.updateBoardCard(cid, true, fields, fx.opts);
  assert.deepEqual(fields, { column_key: 'done' }, '派生列不得回写进调用方的对象');
  assert.equal(cardRow(fx, cid).done_at !== null, true);
  fx.close();
});

// --------------------------------------------------------------------------
// 已读标记
// --------------------------------------------------------------------------

test('markCardViewed：只有真清才返回 true 并发信号；不刷 updated_at；无卡返回 false', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, {
    columnKey: 'doing', unread: 1, updatedAt: '2026-10-12 00:00:00',
  });

  const s0 = sig(fx.pid);
  assert.equal(db.markCardViewed(cid, fx.opts), true);
  let row = cardRow(fx, cid);
  assert.equal(row.unread, 0);
  assert.equal(row.updated_at, '2026-10-12 00:00:00', '查看不得刷 updated_at');
  assert.equal(sig(fx.pid) - s0, 1);

  // 第二次：本来就是 0 ⇒ false 且不发信号
  const s1 = sig(fx.pid);
  assert.equal(db.markCardViewed(cid, fx.opts), false);
  assert.equal(sig(fx.pid) - s1, 0);

  // 无卡 ⇒ false、不发信号、不抛
  const s2 = sig(fx.pid);
  assert.equal(db.markCardViewed(999999, fx.opts), false);
  assert.equal(sig(fx.pid) - s2, 0);
  fx.close();
});

// --------------------------------------------------------------------------
// 回收站
// --------------------------------------------------------------------------

test('回收站三连：trash → restore → purge；purge 连带删评论、用删前的 project_id 发信号', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, {
    columnKey: 'review', updatedAt: '2026-10-12 00:00:00', sortOrder: 7,
  });
  const c1 = insertComment(fx.db, cid, 'c1');
  const c2 = insertComment(fx.db, cid, 'c2');
  const cidOther = insertCard(fx.db, fx.other, { columnKey: 'todo' });
  const cOther = insertComment(fx.db, cidOther, 'other-card-comment');

  let s = sig(fx.pid);
  db.trashBoardCard(cid, fx.opts);
  let row = cardRow(fx, cid);
  assert.equal(row.trashed, 1);
  assert.match(row.trashed_at, TS_RE);
  assert.notEqual(row.updated_at, '2026-10-12 00:00:00');
  assert.equal(row.column_key, 'review', '软删不动列与序号');
  assert.equal(row.sort_order, 7);
  assert.equal(commentRow(fx, c1) !== null, true, '回收站里评论保留待还原');
  assert.equal(sig(fx.pid) - s, 1);

  s = sig(fx.pid);
  db.restoreBoardCard(cid, fx.opts);
  row = cardRow(fx, cid);
  assert.equal(row.trashed, 0);
  assert.equal(row.trashed_at, null);
  assert.equal(row.column_key, 'review');
  assert.equal(row.sort_order, 7);
  assert.equal(sig(fx.pid) - s, 1);

  // 真删：评论连带、信号落在本项目 topic（删后读不到行 ⇒ 必须用删前的 project_id）
  db.trashBoardCard(cid, fx.opts);
  const sBefore = sig(fx.pid);
  const sOther = sig(fx.other);
  db.purgeBoardCard(cid, fx.opts);
  assert.equal(cardRow(fx, cid), null);
  assert.equal(commentRow(fx, c1), null);
  assert.equal(commentRow(fx, c2), null);
  assert.equal(sig(fx.pid) - sBefore, 1, 'purge 必须发本项目信号');
  assert.equal(sig(fx.other) - sOther, 0);
  assert.equal(commentRow(fx, cOther) !== null, true, '别的项目/别的卡片的评论不受影响');

  // 已经不存在 ⇒ 不发信号、不抛（Python `if pid_row:`）
  const sGone = sig(fx.pid);
  db.purgeBoardCard(cid, fx.opts);
  assert.equal(sig(fx.pid) - sGone, 0);

  // 不存在的卡上 trash / restore：UPDATE 0 行 + notifyCardChange 读不到行 ⇒ 同样不发信号
  db.trashBoardCard(cid, fx.opts);
  db.restoreBoardCard(cid, fx.opts);
  assert.equal(sig(fx.pid) - sGone, 0);
  fx.close();
});

test('purgeTrashedCards：空回收站直接返回不发信号；非空删净卡与评论（Python 侧也不发信号）', () => {
  const fx = setup();
  // 空回收站（只有活卡）
  insertCard(fx.db, fx.pid, { title: 'alive', columnKey: 'todo' });
  let s = sig(fx.pid);
  db.purgeTrashedCards(fx.pid, fx.opts);
  assert.equal(sig(fx.pid) - s, 0, '空回收站不发信号');

  // 两张已删卡（各带评论）+ 一张活卡（带评论）+ 另一项目的一张已删卡
  const t1 = insertCard(fx.db, fx.pid, { title: 't1', columnKey: 'todo' });
  const t2 = insertCard(fx.db, fx.pid, { title: 't2', columnKey: 'doing' });
  const live = insertCard(fx.db, fx.pid, { title: 'live', columnKey: 'review' });
  const tc1 = insertComment(fx.db, t1, 'tc1');
  const tc2 = insertComment(fx.db, t2, 'tc2');
  const liveComment = insertComment(fx.db, live, 'live-comment');
  const otherTrashed = insertCard(fx.db, fx.other, { title: 'other-trash', columnKey: 'todo' });
  db.trashBoardCard(t1, fx.opts);
  db.trashBoardCard(t2, fx.opts);
  db.trashBoardCard(otherTrashed, fx.opts);

  s = sig(fx.pid);
  const sOther = sig(fx.other);
  db.purgeTrashedCards(fx.pid, fx.opts);

  assert.equal(cardRow(fx, t1), null);
  assert.equal(cardRow(fx, t2), null);
  assert.equal(commentRow(fx, tc1), null);
  assert.equal(commentRow(fx, tc2), null);
  assert.equal(cardRow(fx, live) !== null, true, '活卡不许被清');
  assert.equal(commentRow(fx, liveComment) !== null, true, '活卡评论不许被清');
  assert.equal(cardRow(fx, otherTrashed) !== null, true, '别的项目的回收站不许被清');
  assert.equal(sig(fx.pid) - s, 0, 'Python 侧非空也不发信号（照抄，不补）');
  assert.equal(sig(fx.other) - sOther, 0);

  // 再清一次（此时已空）同样安全
  db.purgeTrashedCards(fx.pid, fx.opts);
  assert.equal(cardRow(fx, live) !== null, true);
  fx.close();
});

// --------------------------------------------------------------------------
// 评论
// --------------------------------------------------------------------------

test('insertBoardComment / updateBoardComment 白名单 / deleteBoardComment（都不发看板信号）', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, { columnKey: 'todo' });

  const s0 = sig(fx.pid);
  const com = db.insertBoardComment(cid, 'hello', fx.opts);
  const row = commentRow(fx, com);
  assert.ok(Number.isInteger(com) && com > 0);
  assert.equal(row.card_id, cid);
  assert.equal(row.text, 'hello');
  assert.match(row.created_at, TS_RE);
  assert.equal(row.sent, 0);
  assert.equal(row.session_id, '');
  assert.equal(row.sent_text, '');
  assert.equal(sig(fx.pid) - s0, 0, '加评论不发看板信号');

  // 白名单内三个字段照写
  db.updateBoardComment(com, {
    sent: 1, session_id: 'sid-1', sent_text: '已投递', bogus: 1, text: '改文本',
  }, fx.opts);
  const updated = commentRow(fx, com);
  assert.equal(updated.sent, 1);
  assert.equal(updated.session_id, 'sid-1');
  assert.equal(updated.sent_text, '已投递');
  assert.equal(updated.text, 'hello', 'text/created_at/card_id 不在白名单里');

  // 全非法 ⇒ no-op
  db.updateBoardComment(com, { text: 'x', card_id: 999, created_at: 'x', id: 1 }, fx.opts);
  assert.deepEqual(commentRow(fx, com), updated);
  db.updateBoardComment(com, {}, fx.opts);
  assert.deepEqual(commentRow(fx, com), updated);

  db.deleteBoardComment(com, fx.opts);
  assert.equal(commentRow(fx, com), null);
  db.deleteBoardComment(com, fx.opts);              // 幂等：再删不抛
  assert.equal(sig(fx.pid) - s0, 0, '评论写口全程不发看板信号');
  fx.close();
});

// --------------------------------------------------------------------------
// 看板设置
// --------------------------------------------------------------------------

test('setBoardSettings：json 字节形态 = CPython json.dumps(..., ensure_ascii=False)', () => {
  const fx = setup();
  const s = sig(fx.pid);
  db.setBoardSettings(fx.pid, { a: '中文', b: [1, 2], c: { d: true }, e: null }, fx.opts);

  const raw = settingsRaw(fx, fx.pid);
  assert.equal(raw, '{"a": "中文", "b": [1, 2], "c": {"d": true}, "e": null}');
  assert.equal(raw.includes('\\u'), false, 'ensure_ascii=False ⇒ 中文不得被转义');
  assert.deepEqual(db.getBoardSettings(fx.pid, { db: fx.db }),
    { a: '中文', b: [1, 2], c: { d: true }, e: null });

  // INSERT OR REPLACE：同项目再写是覆盖（只有一行）
  db.setBoardSettings(fx.pid, { z: 1 }, fx.opts);
  assert.equal(settingsRaw(fx, fx.pid), '{"z": 1}');
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM board_settings WHERE project_id=?')
    .get(fx.pid).n, 1);

  // 空对象 / 非 ASCII 键（Python 侧 ensure_ascii=False 同样原样输出）
  db.setBoardSettings(fx.pid, { 键: '值' }, fx.opts);
  assert.equal(settingsRaw(fx, fx.pid), '{"键": "值"}');

  assert.equal(sig(fx.pid) - s, 0, '设置写口不发看板信号（Python 同）');
  fx.close();
});

// --------------------------------------------------------------------------
// 事务边界与句柄口径
// --------------------------------------------------------------------------

test('信号在写事务的 fn 内发出（COMMIT 之前）——与 Python 同序', () => {
  const fx = setup();
  const cid = insertCard(fx.db, fx.pid, {
    columnKey: 'todo', updatedAt: '2026-10-12 00:00:00', unread: 0,
  });
  const seen = [];
  const orig = BUS.publish;
  // 在 publish 回调里用**另一条连接**读同一行：此刻写事务尚未 COMMIT ⇒ 必须还是旧值
  BUS.publish = function patched(topic) {
    seen.push({
      topic,
      row: fx.db.prepare('SELECT column_key, updated_at FROM board_cards WHERE id=?').get(cid),
    });
    return orig.call(this, topic);
  };
  try {
    db.updateBoardCard(cid, true, { column_key: 'doing' }, fx.opts);
  } finally {
    BUS.publish = orig;
  }
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].topic, boardTopic(fx.pid));
  assert.equal(seen[0].row.column_key, 'todo', '信号必须早于 COMMIT（此时读到旧值）');
  assert.equal(seen[0].row.updated_at, '2026-10-12 00:00:00');
  assert.equal(cardRow(fx, cid).column_key, 'doing', '调用返回后已提交');
  fx.close();
});

test('给 {db} 句柄与给 {dbPath} 结果一致（路由层今天传句柄）', () => {
  const fx = setup();
  const a = db.insertBoardCard(fx.pid, 'via-dbpath', 'D', 'K', { dbPath: fx.dbPath });
  const b = db.insertBoardCard(fx.pid, 'via-handle', 'D', 'K', { db: fx.db });
  assert.equal(cardRow(fx, a).sort_order, 1);
  assert.equal(cardRow(fx, b).sort_order, 2);

  db.updateBoardCard(a, true, { column_key: 'done' }, { db: fx.db });
  assert.equal(cardRow(fx, a).unread, 1);
  assert.equal(cardRow(fx, a).done_at !== null, true);

  assert.equal(db.markCardViewed(a, { db: fx.db }), true);
  assert.equal(db.markCardViewed(a, { db: fx.db }), false);

  db.trashBoardCard(b, { db: fx.db });
  assert.equal(cardRow(fx, b).trashed, 1);
  db.restoreBoardCard(b, { db: fx.db });
  assert.equal(cardRow(fx, b).trashed, 0);
  db.purgeBoardCard(b, { db: fx.db });
  assert.equal(cardRow(fx, b), null);

  const com = db.insertBoardComment(a, 'c', { db: fx.db });
  db.updateBoardComment(com, { sent: 1 }, { db: fx.db });
  assert.equal(commentRow(fx, com).sent, 1);
  db.purgeTrashedCards(fx.pid, { db: fx.db });
  db.deleteBoardComment(com, { db: fx.db });
  assert.equal(commentRow(fx, com), null);
  db.setBoardSettings(fx.pid, { ok: true }, { db: fx.db });
  assert.equal(settingsRaw(fx, fx.pid), '{"ok": true}');
  fx.close();
});
