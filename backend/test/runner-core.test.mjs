/**
 * `backend/lib/runner.js` 的 **M4 调度内核**单测（`node --test`，零依赖）。
 *
 * 对拍对象：`runner.py` 的模块级 helper（84-186 / 2379-2482）与 `Runner` 类（188-1160）。
 * 覆盖项（与任务书的 ①-⑮ 一一对应，文末追加自检循环与 Waiter）：
 *   ① 窗口闸 serial/parallel + 前缀含 `t:` ⇒ N 收 1；② `not_before` 留队 + 队首阻塞（同项目
 *   本轮不再向下补位）；③ ext 行闸（parallel 下同样挡）；④ c: 占位失效；⑤ t: 非排队态；
 *   ⑥ pipeline 后段（parent 未 done 留队 / parent 不存在 ⇒ 行 done + cancel）；⑦ a: 脏 target；
 *   ⑧ claim 的 rowcount 仲裁；⑨ claim 后窗口复判失败 ⇒ 放回 waiting；⑩ `recover` 四类映射 +
 *   **收口先于补建**；⑪ `stop` 的 waiting/starting 两分支；⑫ restart/resume/rerunLoad 的字段
 *   与写序；⑬ `unit_state`/`unit_busy`/`holders_text`/`project_holder_details`；⑭
 *   `reconcile_units`（探针三态）+ `set_liveness_probe` 透传；⑮ 三个缝未接线时抛具名错误且
 *   **行确实落终态**。
 *
 * 三条硬约束（照 `runner.test.mjs` / `m3fixture.mjs` 的既有口径）：
 *   ① **临时库、绝不用生产库**：每例 `mkdtemp` + `db.initDb`，末尾 close；
 *   ② **不起真后台循环**：一律 `new Runner(true, …)`（启动闸关着）+ 手动 pump
 *      （`pickLocked` / `claimAndStartLocked` / `runPickedUnit` 直调）——断言确定性；
 *   ③ **造场景用真 SQL 插真行**（不 mock）；顺序类断言用 `wait_items`/`tasks` 上的
 *      AFTER 触发器落审计表，而不是猜实现。
 *
 * 缝（`setUnitHandlers` / `setBoardFinishHook` / `setBoardSelfcheckHooks` / `setFailureNotifier`
 * / `setInstance`）是**模块级**状态：每个用例自带 try/finally 复位，避免跨例串味。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as runner from '../lib/runner.js';
import * as waitq from '../lib/waitq.js';
import {
  freshDb, insertCard, insertMsg, insertProject, insertTask, insertWait, setBoardSettings,
} from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 生产库护栏（**本文件最先执行的一步**）
// --------------------------------------------------------------------------
// 所有访问口都收末位 `options = {db?, dbPath?, env?}`；缺了那个袋子就会回落
// `TOUCHSTONE_DB || ~/.touchstone/touchstone.db`——即**生产库**。本文件把
// `TOUCHSTONE_DB` 指到一个一次性临时目录：任何漏传 options 的调用只会打到这个空库里
// （真漏了会在断言上红，而不是悄悄写坏生产库）。`node --test` 每个文件独立进程，不外溢。
process.env.TOUCHSTONE_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ts-runner-core-guard-')), 'never-touch.db',
);

// --------------------------------------------------------------------------
// 夹具与断言 helpers
// --------------------------------------------------------------------------

/**
 * 每例自带临时库夹具；函数体可同步可 async（await 完再 close）。
 * @param {string} tag
 * @param {(fx: object) => any} fn
 */
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

/** 下一个队列位次（`MAX(seq)+1`；造行时显式给 seq，保证顺序可预期） */
function nextSeq(handle) {
  return Number(handle.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM wait_items').get().n);
}

/** 取等待项行（同键多行时取最新一条——活跃唯一索引保证活跃行至多一条） */
function waitRow(fx, kind, targetId) {
  return fx.db.prepare('SELECT * FROM wait_items WHERE kind=? AND target_id=?'
    + ' ORDER BY id DESC LIMIT 1').get(kind, String(targetId));
}

/** 行态（行不存在 ⇒ null） */
function rowState(fx, kind, targetId) {
  const row = waitRow(fx, kind, targetId);
  return row === undefined ? null : row.state;
}

/** 行 meta（坏 JSON 按 {}） */
function metaOf(fx, kind, targetId) {
  const row = waitRow(fx, kind, targetId);
  if (row === undefined) return {};
  try { return JSON.parse(row.meta || '{}'); } catch { return {}; }
}

/** `tasks` 行 */
function taskRow(fx, taskId) {
  return fx.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
}

/** `board_cards` 行 */
function cardRow(fx, cardId) {
  return fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cardId);
}

/** 给任务行补写 fixture 未覆盖的列（payload / load_rerun 等） */
function setTaskFields(fx, taskId, fields) {
  const cols = Object.keys(fields);
  fx.db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
    .run(...cols.map((c) => fields[c]), taskId);
}

/**
 * 造一张「可被补位器拾取」的卡片单元：卡在 doing + block_kind=queue，等待项行给指定态。
 * @returns {number} 卡片 id
 */
function queuedCard(fx, projectId, opts = {}) {
  const {
    state = 'waiting', seq = null, columnKey = 'doing', blockKind = 'queue', cardOpts = {},
  } = opts;
  const cid = insertCard(fx.db, projectId, { columnKey, blockKind, ...cardOpts });
  insertWait(fx.db, {
    projectId, kind: 'card', targetId: cid, state, seq: seq === null ? nextSeq(fx.db) : seq,
  });
  return cid;
}

/** 造一个任务单元（任务行 status=queued + waiting t: 行） */
function queuedTask(fx, projectId, opts = {}) {
  const { seq = null, ...taskOpts } = opts;
  const tid = insertTask(fx.db, projectId, taskOpts);
  return tid;
}

/**
 * **停闸** Runner：执行循环全停在启动闸后（绝不放行、绝不后台拾取），手动 pump 用。
 * @param {object} fx
 */
function parkedRunner(fx) {
  return new runner.Runner(true, { db: fx.db });
}

/** 捕获 `console.log` 输出（同步体） */
function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

/** 捕获 `console.log` 输出（async 体） */
async function captureLogsAsync(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

/** 轮询等待某条件成立（自检循环这类真定时器的用例用） */
async function waitFor(predicate, timeoutMs = 2000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/**
 * 在临时库上装**写序审计**触发器（§⑩「收口先于补建」的观测面，见文件头约束③）：
 * 把 `wait_items` 的 INSERT/UPDATE 与 `tasks` 的 UPDATE 按发生顺序记进 `_audit`。
 */
function installAudit(handle) {
  handle.exec('CREATE TABLE IF NOT EXISTS _audit(id INTEGER PRIMARY KEY, op TEXT)');
  handle.exec("CREATE TRIGGER IF NOT EXISTS _audit_wait_ins AFTER INSERT ON wait_items"
    + " BEGIN INSERT INTO _audit(op) VALUES('insert:wait:' || NEW.kind); END");
  handle.exec("CREATE TRIGGER IF NOT EXISTS _audit_wait_upd AFTER UPDATE ON wait_items"
    + " BEGIN INSERT INTO _audit(op) VALUES('update:wait:' || NEW.state); END");
  handle.exec("CREATE TRIGGER IF NOT EXISTS _audit_task_upd AFTER UPDATE ON tasks"
    + " BEGIN INSERT INTO _audit(op) VALUES('update:task:' || NEW.status); END");
}

/** 读审计序列 */
function auditOps(handle) {
  return handle.prepare('SELECT op FROM _audit ORDER BY id').all().map((r) => r.op);
}

/** 清审计（每个「写序」断言前调用一次） */
function clearAudit(handle) {
  handle.prepare('DELETE FROM _audit').run();
}

// --------------------------------------------------------------------------
// 常量 / Waiter
// --------------------------------------------------------------------------

test('常量与静态口：WORKERS / LOAD_ROUND_NO / PARALLEL_PREFIX_N / 四个队列键 / 缝文案', () => {
  assert.equal(runner.Runner.WORKERS, 6, 'Python Runner.WORKERS = 6');
  assert.equal(runner.WORKERS, 6);
  assert.equal(runner.Runner.LOAD_ROUND_NO, 2, '压测首次发压轮次号');
  assert.equal(runner.Runner.PARALLEL_PREFIX_N, runner.PARALLEL_PREFIX_N);
  assert.equal(runner.PARALLEL_PREFIX_N, 5);
  assert.equal(runner.SELFCHECK_INTERVAL, 60.0);
  assert.equal(runner.SELFCHECK_MIN_AGE, 15.0);
  assert.equal(runner.WAIT_TICK_MS, 5000, '5s 节拍兜底（补位时机④）');

  assert.equal(runner.Runner.tkey(7), 't:7');
  assert.equal(runner.Runner.ckey(7), 'c:7');
  assert.equal(runner.Runner.mkey('1700000000000-1'), 'm:1700000000000-1');
  assert.equal(runner.Runner.akey(7), 'a:7');

  // 缝文案必须点明缺什么（M5 卡片、M6 任务）；`answer` 自 2026-10-16（M10）起改口径：
  // 实现体 M5 就在 `board.deliverAnswerUnit`，曾经缺的只是 `server.js` 的注册 ⇒ 文案讲「未接线」，
  // 不再写「未移植」（真机上那句「未移植」把人指向了错的排查方向）。
  assert.match(runner.UNIT_HANDLER_MISSING.task, /未移植（M6）/);
  assert.match(runner.UNIT_HANDLER_MISSING.card, /未移植（M5）/);
  assert.match(runner.UNIT_HANDLER_MISSING.answer, /未接线.*deliverAnswerUnit/);
  const err = new runner.UnitHandlerMissing('x');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'UnitHandlerMissing');
});

test('Waiter：notifyAll 唤醒全部等待者；wait 超时也 resolve（不吊住进程）', async () => {
  const w = new runner.Waiter();
  let n = 0;
  const p1 = w.wait(60_000).then(() => { n += 1; });
  const p2 = w.wait(60_000).then(() => { n += 1; });
  assert.equal(w.size, 2);
  w.notifyAll();
  await Promise.all([p1, p2]);
  assert.equal(n, 2, 'notifyAll 唤醒全部');
  assert.equal(w.size, 0, '唤醒后等待集合清空');
  await w.wait(1);                       // 超时也 resolve（= Python wait(timeout) 返回 False）
  assert.equal(w.size, 0);
  // 已 resolve 的等待者再 notify 不炸
  w.notifyAll();
});

// --------------------------------------------------------------------------
// ① 窗口闸（serial / parallel / 前缀含 t:）
// --------------------------------------------------------------------------

test('① pickLocked 窗口闸：serial 满 ⇒ 留队；parallel N=5；前缀含 t: ⇒ N 收 1；跨项目并行', () => withFixture('pick1', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const p2 = insertProject(fx.db, { name: 'p2' });

  // —— serial（无 board_settings 行 ⇒ 归一为 serial）：一条运行前缀行即满 ——
  const c1 = queuedCard(fx, p1, { state: 'running', seq: 1 });
  const c2 = queuedCard(fx, p1, { state: 'waiting', seq: 2 });
  assert.equal(r.windowN(p1, 'card', o), 1, '无设置行 ⇒ serial（N=1）');
  assert.equal(r.pickLocked(o), null, 'serial：前缀 1 行 = 满 ⇒ 本项目本轮不补位');
  // 他项目不受影响（跨项目并行；head_blocked 是 per-project 的）
  const c3 = queuedCard(fx, p2, { state: 'waiting', seq: 3 });
  assert.equal(r.pickLocked(o), `c:${c3}`, '他项目照常补位');

  // —— parallel：4 条前缀 < 5 ⇒ 放行 ——
  setBoardSettings(fx.db, p1, { mode: 'parallel' });
  assert.equal(r.windowN(p1, 'card', o), 5);
  insertWait(fx.db, { projectId: p1, kind: 'card', targetId: 901, state: 'running', seq: 10 });
  insertWait(fx.db, { projectId: p1, kind: 'card', targetId: 902, state: 'running', seq: 11 });
  insertWait(fx.db, { projectId: p1, kind: 'card', targetId: 903, state: 'running', seq: 12 });
  assert.equal(r.pickLocked(o), `c:${c2}`, '4 条前缀 < N=5 ⇒ 放行（c1 + 901/902/903）');
  // 第 5 条前缀 ⇒ 满（本项目留队；他项目照常补位）
  insertWait(fx.db, { projectId: p1, kind: 'card', targetId: 904, state: 'running', seq: 13 });
  assert.equal(r.pickLocked(o), `c:${c3}`, 'p1 满 ⇒ 跳过 p1、拾他项目（跨项目并行）');
  assert.equal(rowState(fx, 'card', c2), 'waiting', 'c2 留队未动');
  fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='card' AND target_id=?")
    .run(String(c3));
  assert.equal(r.pickLocked(o), null, '5 条前缀 = N ⇒ 无他项目可补 ⇒ null');
  // 前缀含 t: ⇒ N 收 1（任务串行红线：parallel 下同样挡）
  const p3 = insertProject(fx.db, { name: 'p3' });
  setBoardSettings(fx.db, p3, { mode: 'parallel' });
  const t9 = insertTask(fx.db, p3, { name: 't9', status: 'running' });
  insertWait(fx.db, { projectId: p3, kind: 'task', targetId: t9, state: 'running', seq: 20 });
  const c4 = queuedCard(fx, p3, { state: 'waiting', seq: 21 });
  assert.equal(r.pickLocked(o), null,
    'parallel + 前缀含 t: ⇒ N 收 1（1 条他键 ≥ 1 即满）');
  // 把 t: 行落终态 ⇒ 窗口恢复 5，放行
  fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='task' AND target_id=?")
    .run(String(t9));
  assert.equal(r.pickLocked(o), `c:${c4}`);
  void c1; void c3;
}));

test('① 窗口闸边界：t: 候选扣除自身后仍看他键；finishing 行不计前缀（R7/PREFIX_STATES）', () => withFixture('pick2', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  setBoardSettings(fx.db, p1, { mode: 'parallel' });
  // finishing 行不计前缀（PREFIX_STATES 只有 starting/running）⇒ 不挡
  queuedCard(fx, p1, { state: 'finishing', seq: 1 });
  const tid = insertTask(fx.db, p1, { name: 'task', status: 'queued' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tid, state: 'waiting', seq: 2 });
  assert.equal(r.pickLocked(o), `t:${tid}`, 'finishing 不占补位名额');
  // 任务候选（t:）恒 N=1：场上已有一条 running c: ⇒ 留队
  queuedCard(fx, p1, { state: 'running', seq: 3 });
  const tid2 = insertTask(fx.db, p1, { name: 'task2', status: 'queued' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tid2, state: 'waiting', seq: 4 });
  assert.equal(r.pickLocked(o), null, '其他单元占着运行位 ⇒ 任务留队（N 恒 1）');
}));

// --------------------------------------------------------------------------
// ② not_before + 队首阻塞
// --------------------------------------------------------------------------

test('② not_before 未到留队（不向后补位）；到期后放行', () => withFixture('pick3', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  // 队首：退避未到的 t: 行（not_before = 未来 300s）
  const t1 = insertTask(fx.db, p1, { name: 'backoff', status: 'queued' });
  insertWait(fx.db, {
    projectId: p1, kind: 'task', targetId: t1, state: 'waiting', seq: 1,
    notBefore: Date.now() / 1000 + 300,
  });
  // 队首之后：一张合法可拾取的卡（若实现「向下补位」就会被拾起 ⇒ 这里必须仍留队）
  const c1 = queuedCard(fx, p1, { state: 'waiting', seq: 2 });
  assert.equal(r.pickLocked(o), null, '队首 not_before 未到 ⇒ 本项目本轮不再向下补位');
  // 退避到期（not_before 落到现在之前）⇒ 队首放行
  fx.db.prepare('UPDATE wait_items SET not_before=? WHERE kind=? AND target_id=?')
    .run(Date.now() / 1000 - 1, 'task', String(t1));
  assert.equal(r.pickLocked(o), `t:${t1}`, '退避到期 ⇒ 队首照常拾取');
  void c1;
}));

// --------------------------------------------------------------------------
// ③ ext 行闸
// --------------------------------------------------------------------------

test('③ ext 行闸：parallel 下同样挡（与 N 无关）；他项目不受影响', () => withFixture('pick4', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const p2 = insertProject(fx.db, { name: 'p2' });
  setBoardSettings(fx.db, p1, { mode: 'parallel' });
  const c1 = queuedCard(fx, p1, { state: 'waiting', seq: 1 });
  assert.equal(r.pickLocked(o), `c:${c1}`, '无 ext 行 ⇒ 正常补位');
  // 项目 p1 出现活跃 ext 行（外部会话在跑）⇒ 与 N 无关地挡
  const extCard = insertCard(fx.db, p1, { title: 'ext' });
  insertWait(fx.db, { projectId: p1, kind: 'ext', targetId: extCard, state: 'running', seq: 2 });
  assert.equal(r.pickLocked(o), null, 'parallel（N=5）下一条 ext 行同样挡全部平台单元');
  const c2 = queuedCard(fx, p2, { state: 'waiting', seq: 3 });
  assert.equal(r.pickLocked(o), `c:${c2}`, '项目隔离：他项目照常补位');
  // ext 行落终态 ⇒ 恢复
  fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='ext'").run();
  assert.equal(r.pickLocked(o), `c:${c1}`);
}));

// --------------------------------------------------------------------------
// ④ c: 占位失效
// --------------------------------------------------------------------------

test('④ c: 占位失效：卡非 doing+queue ⇒ 行 cancelled「占位失效」并跳过', () => withFixture('pick5', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  // 卡在 todo（无排队占位）
  const c1 = queuedCard(fx, p1, { state: 'waiting', seq: 1, columnKey: 'todo' });
  assert.equal(r.pickLocked(o), null);
  assert.equal(rowState(fx, 'card', c1), 'cancelled', '无效占位就地终态化');
  assert.equal(metaOf(fx, 'card', c1).cancel_reason, '占位失效');
  // 卡在 doing 但 block_kind 不是 queue（如 interaction）⇒ 同样失效
  const c2 = queuedCard(fx, p1, { state: 'waiting', seq: 2, blockKind: 'interaction' });
  assert.equal(r.pickLocked(o), null);
  assert.equal(rowState(fx, 'card', c2), 'cancelled');
  // 卡已删除（行还在）⇒ 同样占位失效
  const c3 = queuedCard(fx, p1, { state: 'waiting', seq: 3 });
  fx.db.prepare('DELETE FROM board_cards WHERE id=?').run(c3);
  assert.equal(r.pickLocked(o), null);
  assert.equal(metaOf(fx, 'card', c3).cancel_reason, '占位失效');
  // 有效占位 ⇒ 放行（不误杀）
  const c4 = queuedCard(fx, p1, { state: 'waiting', seq: 4 });
  assert.equal(r.pickLocked(o), `c:${c4}`);
}));

// --------------------------------------------------------------------------
// ⑤ t: 非排队态
// --------------------------------------------------------------------------

test('⑤ t: 非排队态：任务行 status != queued ⇒ 行 cancelled「非排队态」', () => withFixture('pick6', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const t1 = insertTask(fx.db, p1, { name: 'running-task', status: 'running' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t1, state: 'waiting', seq: 1 });
  assert.equal(r.pickLocked(o), null);
  assert.equal(rowState(fx, 'task', t1), 'cancelled');
  assert.equal(metaOf(fx, 'task', t1).cancel_reason, '非排队态');
  // 任务行被删 ⇒ 同支（task is None）
  const t2 = insertTask(fx.db, p1, { name: 'gone', status: 'queued' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t2, state: 'waiting', seq: 2 });
  fx.db.prepare('DELETE FROM tasks WHERE id=?').run(t2);
  assert.equal(r.pickLocked(o), null);
  assert.equal(metaOf(fx, 'task', t2).cancel_reason, '非排队态');
  // 脏 target（非数字）⇒ 跳过不摘除（防 int() 炸循环）
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: 'abc', state: 'waiting', seq: 3 });
  assert.equal(r.pickLocked(o), null, 't: 脏行跳过（不 cancel、不抛）');
  assert.equal(rowState(fx, 'task', 'abc'), 'waiting', '脏行留队待对账');
  // 正常 queued 任务 ⇒ 放行
  const t3 = insertTask(fx.db, p1, { name: 'ok', status: 'queued' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t3, state: 'waiting', seq: 4 });
  assert.equal(r.pickLocked(o), `t:${t3}`);
}));

// --------------------------------------------------------------------------
// ⑥ pipeline 后段
// --------------------------------------------------------------------------

test('⑥ pipeline 后段：parent 未 done ⇒ 留队；parent 不存在 ⇒ 任务 done + 行 cancel「前段不存在」', () => withFixture('pick7', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const parent = insertTask(fx.db, p1, { name: 'parent', status: 'running' });
  const child = insertTask(fx.db, p1, { name: 'child', taskType: 'pipeline', status: 'queued' });
  setTaskFields(fx, child, { payload: JSON.stringify({ parent_task_id: parent }) });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: child, state: 'waiting', seq: 1 });
  assert.equal(r.pickLocked(o), null, '前段未 done ⇒ 后段留队（队首阻塞）');
  assert.equal(rowState(fx, 'task', child), 'waiting', '行原样留队');
  // 前段完成 ⇒ 放行
  fx.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(parent);
  assert.equal(r.pickLocked(o), `t:${child}`);
  // parent 不存在 ⇒ 任务标 done + 行 cancel
  const orphan = insertTask(fx.db, p1, { name: 'orphan', taskType: 'pipeline', status: 'queued' });
  setTaskFields(fx, orphan, { payload: JSON.stringify({ parent_task_id: 999_999 }) });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: orphan, state: 'waiting', seq: 2 });
  // 先把 child 的行落终态，避免它抢在 orphan 前面（seq 1 < 2）
  assert.equal(r.pickLocked(o), `t:${child}`, '前段 done ⇒ 后段先被拾取（seq 更小）');
  // 正常流程里 worker 会 claim 它；这里直接手动落终态模拟已被拾取
  fx.db.prepare("UPDATE wait_items SET state='starting' WHERE kind='task' AND target_id=?")
    .run(String(child));
  assert.equal(r.pickLocked(o), null);
  assert.equal(rowState(fx, 'task', orphan), 'cancelled');
  assert.equal(metaOf(fx, 'task', orphan).cancel_reason, '前段不存在');
  const oRow = taskRow(fx, orphan);
  assert.equal(oRow.status, 'done', '任务行标 done（后段跳过）');
  assert.equal(oRow.error, '前段任务不存在，后段跳过');
  // 坏 payload（非对象 JSON）⇒ 按「无前段」处理（防御，不炸）
  const bad = insertTask(fx.db, p1, { name: 'bad', taskType: 'pipeline', status: 'queued' });
  setTaskFields(fx, bad, { payload: '[1,2]' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: bad, state: 'waiting', seq: 3 });
  assert.equal(r.pickLocked(o), null);
  assert.equal(metaOf(fx, 'task', bad).cancel_reason, '前段不存在');
}));

// --------------------------------------------------------------------------
// ⑦ a: 脏 target
// --------------------------------------------------------------------------

test('⑦ a: 脏 target（非数字）⇒ 就地 cancel「脏行清理」（不炸循环）', () => withFixture('pick8', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  insertWait(fx.db, { projectId: p1, kind: 'answer', targetId: 'abc', state: 'waiting', seq: 1 });
  assert.equal(r.pickLocked(o), null);
  assert.equal(rowState(fx, 'answer', 'abc'), 'cancelled');
  assert.equal(metaOf(fx, 'answer', 'abc').cancel_reason, '脏行清理');
  // 数字 target 的 a: 行照常参与判定（本卡 c: 活跃行折抵 ⇒ 解锁）
  const c1 = queuedCard(fx, p1, { state: 'running', seq: 2 });
  insertWait(fx.db, { projectId: p1, kind: 'answer', targetId: c1, state: 'waiting', seq: 3 });
  assert.equal(r.pickLocked(o), `a:${c1}`, 'a: 自身占位折抵（本卡 c: 行）⇒ 放行');
}));

// --------------------------------------------------------------------------
// ⑧ claim 的 rowcount 仲裁
// --------------------------------------------------------------------------

test('⑧ claimAndStartLocked：claim 即置 starting；被抢 ⇒ 返回 null 且行态不变', () => withFixture('claim1', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const t1 = insertTask(fx.db, p1, { name: 'task', status: 'queued' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t1, state: 'waiting', seq: 1 });
  const key = `t:${t1}`;
  assert.equal(r.pickLocked(o), key);
  assert.equal(r.claimAndStartLocked(key, o), p1, 'claim 成功 ⇒ 返回 project_id');
  const row = waitRow(fx, 'task', t1);
  assert.equal(row.state, 'starting', 'claim 即占位（waiting → starting）');
  assert.equal(row.claimed_by, 'worker');

  // —— 并发抢走：他人先 claim（行已 starting）⇒ 本次 claim 的 rowcount = 0 ——
  const t2 = insertTask(fx.db, p1, { name: 'task2', status: 'queued' });
  insertWait(fx.db, {
    projectId: p1, kind: 'task', targetId: t2, state: 'waiting', seq: 2,
    claimedBy: '', claimedAt: null,
  });
  assert.equal(waitq.claimByTarget('task', t2, 'other', o), true, '他人先抢到');
  const before = waitRow(fx, 'task', t2);
  assert.equal(r.claimAndStartLocked(`t:${t2}`, o), null, 'claim 失败 ⇒ 放弃本次拾取');
  const after = waitRow(fx, 'task', t2);
  assert.equal(after.state, 'starting', '行态不变（未被回滚成 waiting）');
  assert.equal(after.claimed_by, 'other', 'claimed_by 仍是抢到者（未被改写）');
  assert.equal(before.claimed_by, after.claimed_by);

  // —— 卡片在 pick 之后被删 ⇒ 未 claim 未接手，直接回等待循环 ——
  const ghost = queuedCard(fx, p1, { state: 'waiting', seq: 3 });
  fx.db.prepare('DELETE FROM board_cards WHERE id=?').run(ghost);
  assert.equal(r.claimAndStartLocked(`c:${ghost}`, o), null);
  assert.equal(rowState(fx, 'card', ghost), 'waiting', '未 claim：行保持 waiting 待下轮摘除');

  // —— m:/a: 行已消失（拾取与本行消失的窗口竞态）⇒ null ——
  assert.equal(r.claimAndStartLocked('m:no-such-msg', o), null);
  assert.equal(r.claimAndStartLocked('a:424242', o), null, '无活跃 a: 行 ⇒ null');

  // —— 未知 kind ⇒ claimUnit 放行（照 Python `_claim_unit`），但 t: 分支取不到任务 ⇒ null ——
  assert.equal(runner.claimUnit('x:1', 'worker', o), true, '未知键前缀：claimUnit 恒真');
}));

// --------------------------------------------------------------------------
// ⑨ claim 后窗口复判失败 ⇒ 放回 waiting
// --------------------------------------------------------------------------

test('⑨ claim 后行口径窗口复判失败 ⇒ returnToWaiting（位次保序、claimed_by 清空）', () => withFixture('claim2', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  // serial（N=1）：场上已有活跃 ext 行 ⇒ claim 后复判必失败（ext 键不折抵）
  const extCard = insertCard(fx.db, p1, { title: 'ext' });
  insertWait(fx.db, { projectId: p1, kind: 'ext', targetId: extCard, state: 'running', seq: 1 });
  const c1 = queuedCard(fx, p1, { state: 'waiting', seq: 2 });
  const key = `c:${c1}`;
  assert.equal(r.claimAndStartLocked(key, o), null, '复判失败 ⇒ 放弃本次拾取');
  const row = waitRow(fx, 'card', c1);
  assert.equal(row.state, 'waiting', '行放回 waiting（未占住运行位）');
  assert.equal(row.claimed_by, null, 'claim 痕迹清空');
  assert.equal(row.seq, 2, '位次保序（放回不改 seq）');
  // ext 行终态 ⇒ 同一次调用成功接手
  fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='ext'").run();
  assert.equal(r.claimAndStartLocked(key, o), p1);
  assert.equal(rowState(fx, 'card', c1), 'starting');
}));

test('⑨ unitWindowBlocked / prefixWindowFull：与 pickLocked 同口径（t: 在场收 N=1）', () => withFixture('claim3', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  setBoardSettings(fx.db, p1, { mode: 'parallel' });
  assert.equal(r.prefixWindowFull(p1, o), false);
  const t1 = insertTask(fx.db, p1, { name: 'task', status: 'running' });
  insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t1, state: 'running', seq: 1 });
  assert.equal(r.prefixWindowFull(p1, o), true, '前缀含 t: ⇒ 整窗读口同样收 N=1');
  assert.equal(r.unitWindowBlocked(p1, `t:${t1}`, 'task', [], o), false,
    '扣除自己的行 ⇒ 任务自身不被自己挡');
  assert.equal(r.unitWindowBlocked(p1, 'c:777', 'card', [], o), true,
    'c: 候选：前缀含 t: ⇒ N 收 1 ⇒ 挡');
}));

// --------------------------------------------------------------------------
// ⑩ recover：四类映射 + 收口先于补建
// --------------------------------------------------------------------------

test('⑩ recover：waiting 存活 / a: 放回 / m: 记败 / t: 分流 / running 任务打断 / queued 缺行补建（收口先于补建）', () => withFixture('recover1', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  installAudit(fx.db);
  const notify = [];
  runner.setFailureNotifier((...args) => { notify.push(args); });
  try {
    // —— waiting 行全量存活（四类各一）——
    const cW = queuedCard(fx, p1, { state: 'waiting', seq: 1 });
    insertMsg(fx.db, { id: 'mW', projectId: p1, sid: 's1', state: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'msg', targetId: 'mW', state: 'waiting', seq: 2 });
    const cA = insertCard(fx.db, p1, { title: 'ans' });
    insertWait(fx.db, { projectId: p1, kind: 'answer', targetId: cA, state: 'waiting', seq: 3 });
    const tW = insertTask(fx.db, p1, { name: 'waiting-task', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tW, state: 'waiting', seq: 4 });

    // —— 非 waiting 收口：a: 放回 / m: 记败 / t: queued 放回 / t: 非 queued cancel / c: 不动 ——
    const cA2 = insertCard(fx.db, p1, { title: 'ans2' });
    insertWait(fx.db, { projectId: p1, kind: 'answer', targetId: cA2, state: 'starting', seq: 5 });
    insertMsg(fx.db, { id: 'mS', projectId: p1, sid: 's1', state: 'running' });
    insertWait(fx.db, { projectId: p1, kind: 'msg', targetId: 'mS', state: 'running', seq: 6 });
    const tQ = insertTask(fx.db, p1, { name: 'queued-collapse', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tQ, state: 'starting', seq: 7 });
    const tD = insertTask(fx.db, p1, { name: 'done-collapse', status: 'done' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tD, state: 'running', seq: 8 });
    // 2026-10-24：suspended 属非 waiting 活跃行，按 t: 同款「queued?放回:cancel」收口
    const tSuspQ = insertTask(fx.db, p1, { name: 'suspended-queued', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tSuspQ, state: 'suspended', seq: 10 });
    const tSuspRun = insertTask(fx.db, p1, { name: 'suspended-running', status: 'running',
      sessionId: 'sess-susp' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tSuspRun, state: 'suspended', seq: 11 });
    const cR = queuedCard(fx, p1, { state: 'running', seq: 9 });

    // —— running 任务：杀残留 + 轮次收口 + interrupted + 通知 + 跳后段 ——
    const tRun = insertTask(fx.db, p1, { name: 'running-task', status: 'running', sessionId: 'sess-1' });
    const logPath = path.join(fx.dir, 'task_round_1.log');
    fs.writeFileSync(logPath, '### PID 4000000\nhello\n');   // 不存在的 pid：kill 静默 ESRCH
    db.insertRound(tRun, 1, logPath, 'agent', '', o);
    db.insertRound(tRun, 2, path.join(fx.dir, 'task_load.log'), 'load', '20261011_120000', o);
    const child = insertTask(fx.db, p1, { name: 'child', taskType: 'pipeline', status: 'queued' });
    setTaskFields(fx, child, { payload: JSON.stringify({ parent_task_id: tRun }) });

    // —— queued 任务缺行 ⇒ 防御补建 ——
    const tMiss = insertTask(fx.db, p1, { name: 'missing-row', status: 'queued' });

    r._procs.set(1, { pid: 4000000 });
    r._stop_requested.add(1);
    clearAudit(fx.db);
    const lines = await captureLogsAsync(() => r.recover(o));

    // 内存面清空
    assert.equal(r._procs.size, 0);
    assert.equal(r._stop_requested.size, 0);
    // waiting 行存活
    for (const [kind, target] of [['card', cW], ['msg', 'mW'], ['answer', cA], ['task', tW]]) {
      assert.equal(rowState(fx, kind, target), 'waiting', `${kind} waiting 行存活`);
    }
    // 四类映射
    assert.equal(rowState(fx, 'answer', cA2), 'waiting', 'a: 放回 waiting 重投');
    assert.equal(waitRow(fx, 'answer', cA2).claimed_by, null);
    assert.equal(rowState(fx, 'msg', 'mS'), 'failed', 'm: 记败不重投');
    assert.equal(metaOf(fx, 'msg', 'mS').error, '服务重启中断');
    const mRow = fx.db.prepare('SELECT * FROM chat_msgs WHERE id=?').get('mS');
    assert.equal(mRow.state, 'error', 'chat_msgs 同落 error');
    assert.equal(mRow.error, '服务重启中断');
    assert.equal(rowState(fx, 'task', tQ), 'waiting', 't: 仍 queued ⇒ 放回续跑');
    assert.equal(rowState(fx, 'task', tD), 'cancelled', 't: 非 queued ⇒ 维持 cancel');
    assert.equal(metaOf(fx, 'task', tD).cancel_reason, '服务重启中断');
    assert.equal(rowState(fx, 'task', tSuspQ), 'waiting',
      'suspended + 任务仍 queued ⇒ 同 starting 放回续跑');
    assert.equal(rowState(fx, 'task', tSuspRun), 'cancelled',
      'suspended + 任务已起跑 ⇒ 同 starting 收口 cancel（不重投）');
    assert.equal(metaOf(fx, 'task', tSuspRun).cancel_reason, '服务重启中断');
    assert.equal(rowState(fx, 'card', cR), 'running', 'c: 交 board.recover，本处不动');
    // running 任务（含 recover 前处于等作答让行的 suspended 任务）
    const tr = taskRow(fx, tRun);
    assert.equal(tr.status, 'interrupted');
    assert.equal(tr.error, '服务重启中断');
    assert.ok(tr.ended_at);
    assert.equal(taskRow(fx, tSuspRun).status, 'interrupted',
      'suspended 任务的第二趟收口同 running：interrupted');
    assert.equal(taskRow(fx, child).status, 'done', '后段跳过');
    assert.equal(taskRow(fx, child).error, '前段任务被服务重启中断，后段跳过');
    const rounds = db.listRounds(tRun, o);
    assert.equal(rounds.find((x) => x.kind === 'load').status, 'interrupted', '发压运行行收口');
    assert.equal(rounds.find((x) => x.kind === 'agent').status, 'running',
      'agent 轮次收口沿用轮末口径（recover 不动）');
    assert.deepEqual(notify, [
      [p1, tSuspRun, 'suspended-running', 'normal', '服务重启中断', 0],
      [p1, tRun, 'running-task', 'normal', '服务重启中断', 0],
    ], '失败通知口（M7 缝）收到四元组 + skipped_n（按任务 id 序）');
    // 缺行补建
    assert.equal(rowState(fx, 'task', tMiss), 'waiting');
    // 汇总横幅
    // 注意 n_requeue 的口径：waiting 的 m:/a: 两条 + a: 放回一条 + **t: queued 放回两条**
    // （含 suspended+queued 那条；Python 在 t: 分支同样 `n_requeue += 1`，日志标签一并照抄）
    assert.ok(lines.some((l) => l.includes('[runner] 服务重启：waiting 等待项存活 4 条')
      && l.includes('m:/a: 存活 5 条')), lines.join('|'));
    // 顺序硬约束：非 waiting 收口（放回 waiting）先于 queued 缺行补建（INSERT）
    const ops = auditOps(fx.db);
    const firstReturn = ops.indexOf('update:wait:waiting');
    const firstInsert = ops.indexOf('insert:wait:task');
    assert.ok(firstReturn >= 0, `审计表应看到放回 UPDATE：${ops.join(',')}`);
    assert.ok(firstInsert >= 0, `审计表应看到补建 INSERT：${ops.join(',')}`);
    assert.ok(firstReturn < firstInsert,
      `收口必须先于补建：${ops.join(',')}`);
  } finally {
    runner.setFailureNotifier(null);
  }
}));

// --------------------------------------------------------------------------
// ⑪ stop：waiting 分支 / starting 分支
// --------------------------------------------------------------------------

test('⑪ stop：waiting ⇒ cancel + stopped + 跳后段；starting ⇒ 不 cancel 行、只加 _stop_requested', () => withFixture('stop1', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  process.env.TS_AGENT_DRIVER_URL = '';        // 驱动未配置 ⇒ cancel 立即抛 DshDriverError（被吞）
  try {
    // —— waiting 分支 ——
    const t1 = insertTask(fx.db, p1, { name: 'queued', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t1, state: 'waiting', seq: 1 });
    const child = insertTask(fx.db, p1, { name: 'child', taskType: 'pipeline', status: 'queued' });
    setTaskFields(fx, child, { payload: JSON.stringify({ parent_task_id: t1 }) });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: child, state: 'waiting', seq: 2 });
    await r.stop(t1, o);
    assert.equal(taskRow(fx, t1).status, 'stopped', '排队分支立即标 stopped');
    assert.ok(taskRow(fx, t1).ended_at);
    assert.equal(rowState(fx, 'task', t1), 'cancelled');
    assert.equal(metaOf(fx, 'task', t1).cancel_reason, '用户停止');
    assert.equal(taskRow(fx, child).status, 'done', '后段跳过');
    assert.equal(taskRow(fx, child).error, '前段任务已停止，后段跳过');
    assert.equal(rowState(fx, 'task', child), 'cancelled');
    assert.ok(r._stop_requested.has(t1), '停止标记已加');

    // —— starting 分支：行不 cancel、任务状态不动（轮边界收口）——
    const t2 = insertTask(fx.db, p1, { name: 'running', status: 'running', sessionId: 'sess-9' });
    insertWait(fx.db, {
      projectId: p1, kind: 'task', targetId: t2, state: 'starting', seq: 3,
      claimedBy: 'worker', claimedAt: '2026-10-11 00:00:00',
    });
    r._procs.set(t2, { pid: 4_000_000 });      // 不存在的 pid：killTree 空转（不误杀真实进程）
    await r.stop(t2, o);                       // dsh 族 + 有会话 ⇒ 走 driverCancel（此处必然失败被吞）
    assert.equal(rowState(fx, 'task', t2), 'starting', 'starting 行不被 cancel');
    assert.equal(waitRow(fx, 'task', t2).claimed_by, 'worker', 'claim 痕迹保留');
    assert.ok(r._stop_requested.has(t2));
    assert.equal(taskRow(fx, t2).status, 'running', '任务状态不动（轮边界统一落 stopped）');

    // —— 已结束/无行的任务：stop 只是登记标记（不抛）——
    const t3 = insertTask(fx.db, p1, { name: 'norow', status: 'done' });
    await r.stop(t3, o);
    assert.equal(rowState(fx, 'task', t3), null);
  } finally {
    if (savedUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = savedUrl;
  }
}));

// --------------------------------------------------------------------------
// ⑫ restart / resume / rerunLoad / remove
// --------------------------------------------------------------------------

test('⑫ restart/resume/rerunLoad：字段与写序（先改任务状态后写等待项行）；remove 取消排队行', () => withFixture('lifecycle', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  installAudit(fx.db);

  // —— restart：清轮次 + 重置计数 + 保 session ——
  const t1 = insertTask(fx.db, p1, {
    name: 't1', status: 'running', currentRound: 3, sessionId: 'sess-1', error: 'boom',
  });
  db.insertRound(t1, 1, '/tmp/r1.log', 'agent', '', o);
  db.insertRound(t1, 2, '/tmp/r2.log', 'agent', '', o);
  setTaskFields(fx, t1, { new_bugs: 5, ended_at: '2026-10-11 00:00:00' });
  r._stop_requested.add(t1);
  clearAudit(fx.db);
  r.restart(t1, o);
  const a1 = taskRow(fx, t1);
  assert.equal(a1.status, 'queued');
  assert.equal(a1.current_round, 0, '重启=从第一轮重跑');
  assert.equal(a1.new_bugs, 0);
  assert.equal(a1.error, '');
  assert.equal(a1.ended_at, null);
  assert.equal(a1.session_id, 'sess-1', 'session 保留（由 build_cmd 自动恢复）');
  assert.equal(db.listRounds(t1, o).length, 0, '旧轮次一并清空');
  assert.equal(r._stop_requested.has(t1), false, '停止标记清掉');
  assert.equal(rowState(fx, 'task', t1), 'waiting', 'submit 即入队');
  const ops1 = auditOps(fx.db);
  assert.ok(ops1.indexOf('update:task:queued') < ops1.indexOf('insert:wait:task'),
    `写序：先置状态后写行（${ops1.join(',')}）`);

  // —— resume：保留轮次与计数、不动 session ——
  const t2 = insertTask(fx.db, p1, {
    name: 't2', status: 'stopped', currentRound: 2, sessionId: 'sess-2', error: 'x',
  });
  db.insertRound(t2, 1, '/tmp/r3.log', 'agent', '', o);
  clearAudit(fx.db);
  r.resume(t2, o);
  const a2 = taskRow(fx, t2);
  assert.equal(a2.status, 'queued');
  assert.equal(a2.current_round, 2, '续跑保留轮次计数');
  assert.equal(a2.error, '');
  assert.equal(a2.ended_at, null);
  assert.equal(a2.session_id, 'sess-2');
  assert.equal(db.listRounds(t2, o).length, 1, '续跑不清轮次');
  assert.equal(rowState(fx, 'task', t2), 'waiting');
  const ops2 = auditOps(fx.db);
  assert.ok(ops2.indexOf('update:task:queued') < ops2.indexOf('insert:wait:task'));

  // —— rerunLoad：只追加一次发压运行（load_rerun 必须落库）——
  const t3 = insertTask(fx.db, p1, {
    name: 't3', status: 'done', currentRound: 4, sessionId: 'sess-3',
  });
  db.insertRound(t3, 1, '/tmp/l1.log', 'load', '20261011_120000', o);
  clearAudit(fx.db);
  r.rerunLoad(t3, o);
  const a3 = taskRow(fx, t3);
  assert.equal(a3.status, 'queued');
  assert.equal(a3.load_rerun, 1, '只跑发压的标记落库（跨重启存活）');
  assert.equal(a3.error, '');
  assert.equal(a3.ended_at, null);
  assert.equal(a3.current_round, 4, '复压不动轮次计数');
  assert.equal(a3.session_id, 'sess-3', '复压不动 session');
  assert.equal(db.listRounds(t3, o).length, 1, '复压不清轮次');
  assert.equal(rowState(fx, 'task', t3), 'waiting');
  const ops3 = auditOps(fx.db);
  assert.ok(ops3.indexOf('update:task:queued') < ops3.indexOf('insert:wait:task'));

  // —— remove：取消排队行（幂等；非 waiting 行不复活）——
  r.remove(t3, o);
  assert.equal(rowState(fx, 'task', t3), 'cancelled');
  assert.equal(metaOf(fx, 'task', t3).cancel_reason, '任务删除');
  r.remove(t3, o);                       // 幂等
  assert.equal(rowState(fx, 'task', t3), 'cancelled');
}));

// --------------------------------------------------------------------------
// ⑬ unit_state / unit_busy / holders_text / project_holder_details
// --------------------------------------------------------------------------

test('⑬ unit_state/unit_busy 委托模块级读口；project_holder_details/holders_text 行口径', () => withFixture('diag', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  insertWait(fx.db, {
    projectId: p1, kind: 'card', targetId: 11, state: 'running', seq: 1,
    createdAt: '2026-10-11 00:00:00', evidence: JSON.stringify({ evidence: '会话在跑' }),
  });
  insertWait(fx.db, {
    projectId: p1, kind: 'msg', targetId: 'm1', state: 'starting', seq: 2,
    createdAt: 'bad-timestamp', evidence: JSON.stringify({ desc: '消息投递' }),
  });
  insertWait(fx.db, {
    projectId: p1, kind: 'task', targetId: 12, state: 'waiting', seq: 3,
    createdAt: '2026-10-11 00:00:00', evidence: '{oops',
  });
  const details = r.projectHolderDetails(p1, o);
  assert.deepEqual(details.map((d) => d.key), ['c:11', 'm:m1'], '占位者=前缀行（waiting 不计）');
  assert.equal(details[0].evidence, '会话在跑', 'evidence.evidence 优先');
  assert.equal(details[1].evidence, '消息投递', '回落 evidence.desc');
  assert.ok(details[0].since > 0, 'created_at 解析成 epoch 秒');
  assert.ok(Math.abs(details[1].since - Date.now() / 1000) < 5,
    '坏 created_at ⇒ since 按当前时刻（年龄按 0 报）');
  const text = runner.holdersText(r, p1, o);
  assert.match(text, /^c:11（会话在跑，\d+s），m:m1（消息投递，\d+s）$/);
  const p2 = insertProject(fx.db, { name: 'p2' });
  assert.equal(runner.holdersText(r, p2, o), '未知', '空 ⇒ 未知');

  // 实例口 == 模块级口（委托，不是第二份实现）
  assert.deepEqual(r.unitState('c:11', p1, o), runner.unitState('c:11', p1, o));
  assert.deepEqual(r.unitState('c:11', p1, o), { state: 'running', pos: 0, total: 0 });
  // pos = 前缀 2（c:11 running + m:m1 starting）+ ahead 0 + 1 = 3；total = 项目成员键数 3
  assert.deepEqual(r.unitState('t:12', p1, o), { state: 'queued', pos: 3, total: 3 });
  assert.equal(r.unitBusy(p1, o), runner.unitBusy(p1, o));
  assert.equal(r.unitBusy(p1, o), true);
  assert.equal(r.unitBusy(p2, o), false);
  assert.equal(r.prefixMembers(waitq.activeItems(p1, o)).get(p1).size, 2, 'prefixMembers 委托模块级');
  assert.equal(r.windowN(p1, 'task', o), 1, 't: 恒 1');
  // msgWaiting：waiting 行才算排队
  assert.equal(r.msgWaiting('m1', o), false, 'starting 行不算排队');
  insertMsg(fx.db, { id: 'm2', projectId: p1, sid: 's1', state: 'queued' });
  insertWait(fx.db, { projectId: p1, kind: 'msg', targetId: 'm2', state: 'waiting', seq: 4 });
  assert.equal(r.msgWaiting('m2', o), true);
  assert.equal(r.msgWaiting('nope', o), false);
  // sessionHolds：同 sid 的运行中 m: 行 ⇒ true（行口径：活跃 m: 行 ∩ chat_msgs.sid 反查）
  assert.equal(r.sessionHolds(p1, 's1', o), false, 'm1 还没有 chat_msgs 行 ⇒ false');
  insertMsg(fx.db, { id: 'm1', projectId: p1, sid: 's1', state: 'running' });
  assert.equal(r.sessionHolds(p1, 's1', o), true, '同 sid 的 starting m: 行 = 占位者即本会话');
  assert.equal(r.sessionHolds(p1, 'other', o), false, '他 sid 不算');
  assert.equal(r.sessionHolds(p1, '', o), false, '空 sid 恒 false');
}));

// --------------------------------------------------------------------------
// ⑭ reconcile_units（探针三态）+ set_liveness_probe 透传
// --------------------------------------------------------------------------

test('⑭ reconcileUnits：探针三态（alive 保留 / dead 降级 unknown / 无结论走内建证据 ⇒ 可证死收口）+ 汇总行 + setLivenessProbe 透传', () => withFixture('reconcile', (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  // INSTANCE 未设置 ⇒ 直接 return（照 Python `if INSTANCE is None: return`）
  runner.setInstance(null);
  assert.equal(runner.reconcileUnits(o), undefined);
  runner.setInstance(r);
  try {
    const probe = () => 'alive';
    runner.setLivenessProbe(probe);
    assert.equal(r._liveness_probe, probe, 'setLivenessProbe 写到 INSTANCE._liveness_probe');

    // 三态素材：dead（任务行已删）、alive（探针确活）、unknown（探针判死不采信 + queued 新生窗口）
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: 9001, state: 'running', seq: 1 });
    const tAlive = insertTask(fx.db, p1, { name: 'alive', status: 'running' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tAlive, state: 'running', seq: 2 });
    const tUnk = insertTask(fx.db, p1, { name: 'unk', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tUnk, state: 'running', seq: 3 });

    const seen = [];
    runner.setLivenessProbe((row) => {
      seen.push(row.target_id);
      if (row.target_id === String(tAlive)) return 'alive';
      if (row.target_id === String(tUnk)) return 'dead';
      return null;
    });
    const lines = captureLogs(() => runner.reconcileUnits(o));
    assert.equal(seen.length, 3, '每行问一次探针');
    // running 行的收口走 markFailed（waiting/starting 才走 cancel，见 waitq.closeDeadUnit）
    assert.equal(rowState(fx, 'task', 9001), 'failed', '任务行缺失 ⇒ 可证死 ⇒ 收口');
    assert.equal(metaOf(fx, 'task', 9001).error, '启动对账：可证明失效');
    assert.equal(rowState(fx, 'task', tAlive), 'running', '探针确活 ⇒ 保留');
    assert.equal(rowState(fx, 'task', tUnk), 'running',
      '探针判死不采信（R11a）⇒ 降级 unknown ⇒ 保留');
    assert.ok(lines.some((l) => l.includes('对账完成：活跃行 3 条，收口 1 条')), lines.join('|'));
    assert.ok(lines.some((l) => l.includes('t:9001') && l.includes('已收口')), lines.join('|'));
    assert.ok(lines.some((l) => l.includes('t:') && l.includes('unknown')), lines.join('|'));
  } finally {
    runner.setLivenessProbe(null);
    runner.setInstance(null);
  }
  // 拆离后自检/对账一律 no-op（不抛、不写）
  assert.equal(runner.reconcileUnits(o), undefined);
}));

// --------------------------------------------------------------------------
// ⑮ 缝：未接线抛具名错误且行落对应终态（不静默）
// --------------------------------------------------------------------------

test('⑮ 缝未接线：t:/c:/a: 三个口抛 UnitHandlerMissing，行按 Python 分支收口（failed/failed/waiting）', () => withFixture('seam1', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const notified = [];
  runner.setUnitHandlers({});                       // 全注销 = 未接线
  runner.setFailureNotifier((...args) => { notified.push(args); });
  try {
    // —— t:：任务行 failed + 等待项行 failed ——
    const t1 = insertTask(fx.db, p1, { name: 't1', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t1, state: 'waiting', seq: 1 });
    assert.equal(r.claimAndStartLocked(`t:${t1}`, o), p1);
    const resT = await r.runPickedUnit(`t:${t1}`, o);
    assert.ok(resT.error instanceof runner.UnitHandlerMissing, '具名错误（instanceof 可判定）');
    assert.equal(resT.err, `${runner.UNIT_HANDLER_MISSING.task}：t:${t1} 无法执行`);
    assert.equal(rowState(fx, 'task', t1), 'failed', '行确实落终态');
    assert.equal(metaOf(fx, 'task', t1).error, resT.err);
    const tr = taskRow(fx, t1);
    assert.equal(tr.status, 'failed');
    assert.equal(tr.error, resT.err, '任务行 error = 全量异常文本');
    assert.ok(tr.ended_at);
    assert.deepEqual(notified, [[p1, t1, 't1', 'normal', resT.err, 0]],
      '失败通知口收到四元组 + 跳过后段条数');

    // —— c:：等待项行 failed + 卡片记错（就地 UPDATE last_error/last_error_at）——
    const c1 = queuedCard(fx, p1, { state: 'waiting', seq: 2 });
    assert.equal(r.claimAndStartLocked(`c:${c1}`, o), p1);
    const resC = await r.runPickedUnit(`c:${c1}`, o);
    assert.ok(resC.error instanceof runner.UnitHandlerMissing);
    assert.equal(resC.err, `${runner.UNIT_HANDLER_MISSING.card}：c:${c1} 无法执行`);
    assert.equal(rowState(fx, 'card', c1), 'failed');
    assert.equal(cardRow(fx, c1).last_error, resC.err);
    assert.ok(cardRow(fx, c1).last_error_at);

    // —— a:：照 Python 兜底放回 waiting 重投（不计重试额度）——
    const c2 = insertCard(fx.db, p1, { title: 'ans' });
    insertWait(fx.db, { projectId: p1, kind: 'answer', targetId: c2, state: 'waiting', seq: 3 });
    assert.equal(r.claimAndStartLocked(`a:${c2}`, o), p1);
    const resA = await r.runPickedUnit(`a:${c2}`, o);
    assert.ok(resA.error instanceof runner.UnitHandlerMissing);
    assert.equal(resA.err, `${runner.UNIT_HANDLER_MISSING.answer}：a:${c2} 无法执行`);
    assert.equal(rowState(fx, 'answer', c2), 'waiting', 'a: 放回 waiting 重投');
    assert.equal(waitRow(fx, 'answer', c2).claimed_by, null);
    assert.equal(waitRow(fx, 'answer', c2).retries, 0, '不计业务重试额度');

    // —— 部分接线：只接 processTask，其余口照样响亮失败 ——
    let taskCalls = 0;
    runner.setUnitHandlers({ processTask: () => { taskCalls += 1; return true; } });
    const t2 = insertTask(fx.db, p1, { name: 't2', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: t2, state: 'waiting', seq: 4 });
    r.claimAndStartLocked(`t:${t2}`, o);
    const resT2 = await r.runPickedUnit(`t:${t2}`, o);
    assert.deepEqual({ err: resT2.err, cardOk: resT2.cardOk, error: resT2.error },
      { err: '', cardOk: null, error: null });
    assert.equal(taskCalls, 1);
    assert.equal(rowState(fx, 'task', t2), 'done', '接线的口正常收口 done');
    assert.deepEqual(runner.unitHandlers().processCard, null, '未传的口被整组置空');
    const c3 = queuedCard(fx, p1, { state: 'waiting', seq: 5 });
    r.claimAndStartLocked(`c:${c3}`, o);
    const resC3 = await r.runPickedUnit(`c:${c3}`, o);
    assert.ok(resC3.error instanceof runner.UnitHandlerMissing);
  } finally {
    runner.setUnitHandlers({});
    runner.setFailureNotifier(null);
  }
}));

test('⑯ 缝：`a:` 异常兜底放回**带退避**（差异⑫②）——接线缺口不再零延迟热旋', () => withFixture('seamA', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  runner.setUnitHandlers({});                       // 全注销 = 未接线（2026-10-16 真机事故态）
  try {
    const cid = insertCard(fx.db, p1, { title: 'ans' });
    insertWait(fx.db, { projectId: p1, kind: 'answer', targetId: cid, state: 'waiting', seq: 1 });
    assert.equal(r.claimAndStartLocked(`a:${cid}`, o), p1);
    const res = await r.runPickedUnit(`a:${cid}`, o);
    assert.ok(res.error instanceof runner.UnitHandlerMissing);

    // ① **对齐面不动**（Python `runner.py:1110` 的语义）：仍落 waiting、claimed_by 清空、
    //    retries 不涨（retries 只记业务重试额度）——既有断言 ⑮ 逐条继续成立。
    assert.equal(rowState(fx, 'answer', cid), 'waiting');
    assert.equal(waitRow(fx, 'answer', cid).claimed_by, null);
    assert.equal(waitRow(fx, 'answer', cid).retries, 0);

    // ② 新增判据：`not_before` 落在未来（退避档 = 常量；留 ±5s 容差只为避开调度抖动）
    const nb = Number(waitRow(fx, 'answer', cid).not_before);
    const nowSec = Date.now() / 1000;
    assert.ok(nb > nowSec && nb >= nowSec + runner.ANSWER_EXC_BACKOFF_S - 5,
      `放回必须带退避（not_before=${nb} now=${nowSec} 档=${runner.ANSWER_EXC_BACKOFF_S}）`);

    // ③ **行为判据（本用例的真判据）**：当轮不可再拾取 ⇒ 「放回→立即重拾→再抛」热旋不成立。
    //    热旋就是这条为 null 的断言在真机上的反面：50% CPU + 日志 5.5KB/s。
    assert.equal(r.pickLocked(o), null, '退避窗口未到 ⇒ 不重拾（热旋的对立面）');

    // ④ **自证（量具的量具）**：同一行把 not_before 拨回过去 ⇒ 立刻可拾。没有这一步，
    //    ③ 的 null 也可能只是「a: 行本来就拾不到」的假绿。
    fx.db.prepare('UPDATE wait_items SET not_before=0 WHERE kind=? AND target_id=?')
      .run('answer', String(cid));
    assert.equal(r.pickLocked(o), `a:${cid}`, '退避到点即恢复可拾（证明 ③ 的 null 确由退避造成）');
  } finally {
    runner.setUnitHandlers({});
  }
}));

test('⑮ 缝：cardOk 三态（false/None/true）与 board.finish 注入/未接线日志；通知口异常被吞', () => withFixture('seam2', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  const calls = [];
  try {
    // 通知口抛异常 ⇒ 绝不影响调度主流程（照 Python except: pass）
    runner.setFailureNotifier(() => { throw new Error('飞书炸了'); });
    const tErr = insertTask(fx.db, p1, { name: 'tErr', status: 'queued' });
    insertWait(fx.db, { projectId: p1, kind: 'task', targetId: tErr, state: 'waiting', seq: 1 });
    r.claimAndStartLocked(`t:${tErr}`, o);
    const resErr = await r.runPickedUnit(`t:${tErr}`, o);   // 不抛即通过
    assert.ok(resErr.error instanceof runner.UnitHandlerMissing);

    // —— cardOk === false：行 failed「起会话失败」+ board.finish 收尾口 ——
    runner.setUnitHandlers({ processCard: (cid) => { calls.push(['card', cid]); return false; } });
    runner.setBoardFinishHook((key, reason) => { calls.push(['finish', key, reason]); });
    const c1 = queuedCard(fx, p1, { state: 'waiting', seq: 2 });
    r.claimAndStartLocked(`c:${c1}`, o);
    const res1 = await r.runPickedUnit(`c:${c1}`, o);
    assert.deepEqual({ err: res1.err, cardOk: res1.cardOk, error: res1.error },
      { err: '', cardOk: false, error: null });
    assert.equal(rowState(fx, 'card', c1), 'failed');
    assert.equal(metaOf(fx, 'card', c1).error, '起会话失败');
    assert.deepEqual(calls, [['card', c1], ['finish', `c:${c1}`, '起跑失败回滚']]);

    // —— cardOk === null：cancel「卡片状态不符」+ board.finish ——
    calls.length = 0;
    runner.setUnitHandlers({ processCard: () => null });
    const c2 = queuedCard(fx, p1, { state: 'waiting', seq: 3 });
    r.claimAndStartLocked(`c:${c2}`, o);
    const res2 = await r.runPickedUnit(`c:${c2}`, o);
    assert.equal(res2.cardOk, null);
    assert.equal(rowState(fx, 'card', c2), 'cancelled');
    assert.equal(metaOf(fx, 'card', c2).cancel_reason, '卡片状态不符');
    assert.deepEqual(calls, [['finish', `c:${c2}`, '起跑失败回滚']]);

    // —— 没写 return（undefined）按 None 处理（Python `return None` 的等价物）——
    calls.length = 0;
    runner.setUnitHandlers({ processCard: () => { /* 故意不 return */ } });
    const c2b = queuedCard(fx, p1, { state: 'waiting', seq: 4 });
    r.claimAndStartLocked(`c:${c2b}`, o);
    const res2b = await r.runPickedUnit(`c:${c2b}`, o);
    assert.equal(res2b.cardOk, null);
    assert.equal(rowState(fx, 'card', c2b), 'cancelled');

    // —— cardOk === true：行不在此收口（跨轮持有归 board.finish 唯一收尾点）——
    calls.length = 0;
    runner.setUnitHandlers({ processCard: () => true });
    const c3 = queuedCard(fx, p1, { state: 'waiting', seq: 5 });
    r.claimAndStartLocked(`c:${c3}`, o);
    const res3 = await r.runPickedUnit(`c:${c3}`, o);
    assert.deepEqual({ err: res3.err, cardOk: res3.cardOk, error: res3.error },
      { err: '', cardOk: true, error: null });
    assert.equal(rowState(fx, 'card', c3), 'starting', '成功起跑：行留给 board.finish 收口');
    assert.deepEqual(calls, []);

    // —— board.finish 未接线：只打一行、不抛（且不静默）——
    runner.setBoardFinishHook(null);
    runner.setUnitHandlers({ processCard: () => false });
    const c4 = queuedCard(fx, p1, { state: 'waiting', seq: 6 });
    r.claimAndStartLocked(`c:${c4}`, o);
    const lines = await captureLogsAsync(() => r.runPickedUnit(`c:${c4}`, o));
    assert.ok(lines.some((l) => l.includes('[runner] board.finish 未接线（M5）')
      && l.includes(`c:${c4}`)), lines.join('|'));
    assert.equal(rowState(fx, 'card', c4), 'failed');

    // —— board.finish 钩子自身抛异常：只打一行（照 Python「自检兜底」）——
    runner.setBoardFinishHook(() => { throw new Error('收尾炸了'); });
    const c5 = queuedCard(fx, p1, { state: 'waiting', seq: 7 });
    r.claimAndStartLocked(`c:${c5}`, o);
    const lines5 = await captureLogsAsync(() => r.runPickedUnit(`c:${c5}`, o));
    assert.ok(lines5.some((l) => l.includes('起跑失败回滚收尾失败（自检兜底）')), lines5.join('|'));
  } finally {
    runner.setUnitHandlers({});
    runner.setBoardFinishHook(null);
    runner.setFailureNotifier(null);
  }
}));

// --------------------------------------------------------------------------
// 附：周期自检循环（startUnitSelfcheck）
// --------------------------------------------------------------------------

test('附：startUnitSelfcheck 幂等守卫 / 可证死行收口 / 终态行回收 / unitManaged 豁免 / refreshExtRows 钩子', () => withFixture('selfcheck', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  const p1 = insertProject(fx.db, { name: 'p1' });
  // INSTANCE 未设置 ⇒ 直接 return null
  runner.setInstance(null);
  assert.equal(runner.startUnitSelfcheck(0.02, 0, null, o), null);
  runner.setInstance(r);
  const hooks = [];
  const ctl = new AbortController();
  try {
    // 可证死行（任务行已删 + 行龄够老）与超窗终态行（ended_at 很旧 ⇒ pruneFinished 回收）
    // starting 行 ⇒ 收口走 cancel（running 行走 markFailed，⑭ 已覆盖那一支）
    insertWait(fx.db, {
      projectId: p1, kind: 'task', targetId: 8801, state: 'starting', seq: 1,
      createdAt: '2026-01-01 00:00:00',
    });
    insertWait(fx.db, {
      projectId: p1, kind: 'task', targetId: 8802, state: 'done', seq: 2,
      endedAt: '2026-01-01 00:00:00',
    });
    runner.setBoardSelfcheckHooks({
      refreshExtRows: (reason) => { hooks.push(reason); },
    });
    const handle = runner.startUnitSelfcheck(0.02, 0, ctl.signal, o);
    assert.ok(handle !== null && typeof handle.cancel === 'function');
    assert.ok(await waitFor(() => rowState(fx, 'task', 8801) === 'cancelled'),
      '可证死行被自检收口');
    assert.equal(metaOf(fx, 'task', 8801).cancel_reason, '周期自检：可证明失效');
    assert.ok(await waitFor(() => waitRow(fx, 'task', 8802) === undefined),
      '终态行超窗被 pruneFinished 回收');
    assert.ok(hooks.length >= 1 && hooks[0] === '外部条目周期对账', 'refreshExtRows 每拍被调');
    ctl.abort();
    await handle.done;                    // 停机信号 ⇒ 循环收尾（unref 定时器不吊住进程）

    // —— unitManaged 豁免：平台在管单元的行收口归巡视，自检不越权 ——
    insertWait(fx.db, {
      projectId: p1, kind: 'task', targetId: 8803, state: 'running', seq: 3,
      createdAt: '2026-01-01 00:00:00',
    });
    runner.setBoardSelfcheckHooks({ unitManaged: (row) => String(row.target_id) === '8803' });
    const ctl2 = new AbortController();
    const h2 = runner.startUnitSelfcheck(0.02, 0, ctl2.signal, o);
    await waitFor(() => hooks.length >= 2 || rowState(fx, 'task', 8803) === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 80));   // 多跑几拍
    assert.equal(rowState(fx, 'task', 8803), 'running', '在管单元的行自检不收口');
    ctl2.abort();
    await h2.done;

    // —— 生产路径（stop=null）：同一进程内幂等（第二次直接 return null）——
    const h3 = runner.startUnitSelfcheck(30, 15, null, o);
    assert.ok(h3 !== null, '首次启动成功');
    assert.equal(runner.startUnitSelfcheck(30, 15, null, o), null, '幂等守卫：重复启动 return null');
    h3.cancel();
    await h3.done;
  } finally {
    runner.setBoardSelfcheckHooks({});
    runner.setInstance(null);
  }
}));

test('附：拆离 INSTANCE 后自检循环自终（下一拍发现 INSTANCE 为 null 即 return）', () => withFixture('selfcheck2', async (fx) => {
  const o = { db: fx.db };
  const r = parkedRunner(fx);
  runner.setInstance(r);
  try {
    const ctl = new AbortController();
    const handle = runner.startUnitSelfcheck(0.02, 0, ctl.signal, o);
    assert.ok(handle !== null);
    runner.setInstance(null);                  // 模拟套件还原
    assert.ok(await waitFor(() => true), '至少等到一拍');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.done;                         // 循环自终（无需 abort）
  } finally {
    runner.setInstance(null);
  }
}));
