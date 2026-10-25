/**
 * backend/lib/runner.js 单测（node --test，零依赖）——**M3 只搬的两个只读口**：
 * `unitBusy`（项目忙不忙 = 提交时会不会排队）与 `unitState`（会话「队列」徽标）。
 *
 * 任务点名的覆盖项：
 *   ① `unitState` 的**位次算术**（前缀成员 + waiting 更小 seq + 1；total = 项目成员键数）；
 *   ② `unitBusy` 的窗口几何：serial（N=1：任一前缀行即忙）/ parallel（N=5）/ 前缀含 `t:`
 *      时窗口收 1（任务串行红线）/ 活跃 `ext:` 行**与 N 无关**地挡全部平台单元；
 *   ③ `windowN` 的 mode 读取锚点（= `board.settings_of` 的归一：未知档 ⇒ serial）。
 *
 * 所有场景都往 **mkdtemp 临时库** 里插真行（`m3fixture.mjs`），不 mock、不碰生产库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as runner from '../lib/runner.js';
import { freshDb, insertProject, insertWait, setBoardSettings } from './m3fixture.mjs';

/** 每个测试自带夹具；测试体跑完必关连接 */
function withFixture(tag, fn) {
  const fx = freshDb(tag);
  try {
    return fn(fx);
  } finally {
    fx.close();
  }
}

test('常量：KIND_OF_KEY 四类（**不含 ext**——外部条目永不被平台拾取）/ KEY_PREFIX 互逆', () => {
  assert.deepEqual(runner.KIND_OF_KEY, { t: 'task', c: 'card', m: 'msg', a: 'answer' });
  assert.deepEqual(runner.KEY_PREFIX, { task: 't', card: 'c', msg: 'm', answer: 'a' });
  assert.equal(runner.PARALLEL_PREFIX_N, 5, 'parallel 队首责任区长度（runner.PARALLEL_PREFIX_N）');
  // 互逆性（runner.py 的 `_KEY_PREFIX = {v: k for k, v in _KIND_OF_KEY.items()}`）
  for (const [k, v] of Object.entries(runner.KIND_OF_KEY)) {
    assert.equal(runner.KEY_PREFIX[v], k);
  }
  assert.equal(runner.KIND_OF_KEY.e, undefined, 'ext 不在拾取面');
});

test('prefixMembers / prefixWindowBlocked：纯函数的窗口几何（t: 在场收 N=1；a: 折抵）', () => {
  const rows = [
    { project_id: 1, kind: 'task', target_id: '1', state: 'running' },
    { project_id: 1, kind: 'card', target_id: '2', state: 'starting' },
    { project_id: 1, kind: 'card', target_id: '3', state: 'finishing' },
    { project_id: 1, kind: 'card', target_id: '4', state: 'waiting' },
    { project_id: 2, kind: 'ext', target_id: '9', state: 'running' },
  ];
  const members = runner.prefixMembers(rows);
  // finishing 不计（收尾窗口不再占补位名额）；waiting 不计；ext 计入（入场即 running）
  assert.deepEqual([...members.get(1)].sort(), ['c:2', 't:1']);
  assert.deepEqual([...members.get(2)], ['ext:9']);

  const keys = members.get(1);
  // key=null（整窗读口）：2 个前缀 ≥ 1 ⇒ 忙；排除自己的键后 1 个 ≥ 1 ⇒ 仍忙
  assert.equal(runner.prefixWindowBlocked(keys, null, 'card', 1), true);
  assert.equal(runner.prefixWindowBlocked(keys, 'c:2', 'card', 1), true, 't:1 仍在场');
  // 前缀含 t: ⇒ 候选 kind 非 task 时 N 收 1（parallel 下也挡）
  assert.equal(runner.prefixWindowBlocked(new Set(['t:1']), null, 'card', 5), true,
    't: 在场 ⇒ N 收 1（任务串行红线）');
  // 候选自己就是 t:（排除后无他键）⇒ 不挡；而「候选 t:、场上有两个 c: 前缀、N=1」
  // 才是任务真正被挡的形态：others = 2 个 c: ≥ 1
  assert.equal(runner.prefixWindowBlocked(new Set(['t:9']), 't:9', 'task', 1), false,
    '排除掉自己就没有前缀了（任务自身恒 N=1，故不再挡）');
  assert.equal(runner.prefixWindowBlocked(new Set(['c:1', 'c:2']), 't:9', 'task', 1), true,
    '其他单元占着运行位 ⇒ 任务留队');
  // 全是 c: 前缀：N=5 时 2 个不挡
  assert.equal(runner.prefixWindowBlocked(new Set(['c:1', 'c:2']), null, 'card', 5), false);
  assert.equal(runner.prefixWindowBlocked(new Set(['c:1', 'c:2']), null, 'card', 2), true);
  // a: 候选折抵 exempt（本卡 c: / 同会话 m:）；ext: **不折抵**
  assert.equal(runner.prefixWindowBlocked(new Set(['c:7']), 'a:7', 'answer', 1, ['c:7']), false,
    'a: 候选取目标会话自身占位折抵 ⇒ 解锁');
  assert.equal(runner.prefixWindowBlocked(new Set(['ext:7']), 'a:7', 'answer', 1, ['ext:7']), false,
    'ext: 不在折抵面（#610 收敛）：① ext 不在折抵面、② 1 个他键 < N=1 为假');
});

test('windowN：t: 恒 1；c:/m:/a: 按项目 mode（parallel ⇒ 5，serial/未知/坏 JSON ⇒ 1）', () => {
  withFixture('runner1', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    assert.equal(runner.windowN('task', pid, o), 1, 't: 恒 1（不看项目设置）');
    assert.equal(runner.windowN('card', pid, o), 1, '无设置行 ⇒ 默认 serial');
    for (const kind of ['card', 'msg', 'answer']) {
      assert.equal(runner.windowN(kind, pid, o), 1);
    }
    setBoardSettings(fx.db, pid, { mode: 'parallel' });
    assert.equal(runner.windowN('card', pid, o), runner.PARALLEL_PREFIX_N);
    assert.equal(runner.windowN('msg', pid, o), runner.PARALLEL_PREFIX_N);
    assert.equal(runner.windowN('answer', pid, o), runner.PARALLEL_PREFIX_N);
    assert.equal(runner.windowN('task', pid, o), 1, '任务恒 1（parallel 也不放行）');
    // 未知档 ⇒ serial（读取层归一，与 board.settingsOf 同）
    setBoardSettings(fx.db, pid, { mode: 'readonly-parallel' });
    assert.equal(runner.windowN('card', pid, o), 1);
    // 坏 JSON ⇒ serial
    setBoardSettings(fx.db, pid, '{oops');
    assert.equal(runner.windowN('card', pid, o), 1);
    // 非对象 JSON ⇒ serial
    setBoardSettings(fx.db, pid, '[1]');
    assert.equal(runner.windowN('card', pid, o), 1);
    // projectId 为 0/空：不读设置，按 serial（照 Python `project_id` 判空）
    assert.equal(runner.windowN('card', 0, o), 1);
  });
});

test('unitState：running（活跃非等待行）→ queued（waiting 行带位次）→ idle（无行/已终态）', () => {
  withFixture('runner2', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });

    // 无任何行 ⇒ idle
    assert.deepEqual(runner.unitState('c:1', pid, o), { state: 'idle', pos: 0, total: 0 });

    // starting / running / finishing 三种非 waiting ⇒ 一律 running（活跃非等待即运行上报）
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'starting', seq: 1 });
    assert.deepEqual(runner.unitState('c:1', pid, o), { state: 'running', pos: 0, total: 0 });
    fx.db.prepare("UPDATE wait_items SET state='running' WHERE target_id='1'").run();
    assert.deepEqual(runner.unitState('c:1', pid, o), { state: 'running', pos: 0, total: 0 });
    fx.db.prepare("UPDATE wait_items SET state='finishing' WHERE target_id='1'").run();
    assert.deepEqual(runner.unitState('c:1', pid, o), { state: 'running', pos: 0, total: 0 },
      'finishing 也是「活跃非等待」⇒ 报 running（位次口径才把 finishing 当前缀）');

    // waiting ⇒ queued + 位次：前缀 1（c:1 finishing）+ ahead 0 + 1 = 2
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 2, state: 'waiting', seq: 2 });
    assert.deepEqual(runner.unitState('c:2', pid, o), { state: 'queued', pos: 2, total: 2 });

    // 再放一个 t: waiting：它的位次 = 前缀 1 + ahead 1（c:2 在它前面）+ 1 = 3
    insertWait(fx.db, { projectId: pid, kind: 'task', targetId: 7, state: 'waiting', seq: 3 });
    assert.deepEqual(runner.unitState('t:7', pid, o), { state: 'queued', pos: 3, total: 3 });
    // c:2 不受影响（仍在 t:7 前面）
    assert.deepEqual(runner.unitState('c:2', pid, o), { state: 'queued', pos: 2, total: 3 });

    // 行落终态 ⇒ 数不到 ⇒ idle（下轮挑选自会清理残留脏行）
    fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='card' AND target_id='2'").run();
    assert.deepEqual(runner.unitState('c:2', pid, o), { state: 'idle', pos: 0, total: 0 });
    // 前缀里少了 c:2 不影响 t:7 的位次？
    // c:2 已是终态（不在活跃行集）⇒ 前缀仍是 {c:1}，t:7 的 ahead 仍是 1（c:2 不再计）
    // 等等：c:2 从等待区消失 ⇒ ahead 归 0 ⇒ pos = 1 + 0 + 1 = 2，total = 2（c:1,t:7）
    assert.deepEqual(runner.unitState('t:7', pid, o), { state: 'queued', pos: 2, total: 2 });

    // 2026-10-24：suspended 行仍报 running（活跃非等待），但**不计位次前缀**
    fx.db.prepare("UPDATE wait_items SET state='suspended' "
      + "WHERE kind='task' AND target_id='7'").run();
    assert.deepEqual(runner.unitState('t:7', pid, o), { state: 'running', pos: 0, total: 0 });
    insertWait(fx.db, { projectId: pid, kind: 'task', targetId: 8, state: 'waiting', seq: 10 });
    // 前缀只有 c:1 finishing；t:7 suspended 既非 waiting 也非前缀 ⇒ 不计位次也不挡位
    assert.deepEqual(runner.unitState('t:8', pid, o), { state: 'queued', pos: 2, total: 3 });
  });
});

test('unitState：防御分支（行在他项目按空闲 / 未知键 / 项目为 0 / t: 与 c: 同 target 不串）', () => {
  withFixture('runner3', (fx) => {
    const o = { db: fx.db };
    const p1 = insertProject(fx.db, { name: 'p1' });
    const p2 = insertProject(fx.db, { name: 'p2' });
    insertWait(fx.db, { projectId: p2, kind: 'card', targetId: 5, state: 'running', seq: 1 });

    // 行在他项目（调用方传参漂移）：按空闲返回比报运行中安全
    assert.deepEqual(runner.unitState('c:5', p1, o), { state: 'idle', pos: 0, total: 0 });
    assert.deepEqual(runner.unitState('c:5', p2, o), { state: 'running', pos: 0, total: 0 });

    // 未知键前缀 / 空键 / 项目为 0 ⇒ idle（不抛）
    for (const bad of ['x:1', '', 'ext:5', null, undefined]) {
      assert.deepEqual(runner.unitState(bad, p1, o), { state: 'idle', pos: 0, total: 0 });
    }
    assert.deepEqual(runner.unitState('c:5', 0, o), { state: 'idle', pos: 0, total: 0 });

    // 同 target 不同 kind 不串：p1 放一张 waiting 的 c:6 与一条 waiting 的 m:6
    // （用 6 而不是 5：`idx_wait_active` 是**全局** (kind, target_id) 唯一索引、不含
    //  project_id ⇒ 同 kind 同 target 的活跃行全库只能有一条，跨项目也一样）
    insertWait(fx.db, { projectId: p1, kind: 'card', targetId: 6, state: 'waiting', seq: 2 });
    insertWait(fx.db, { projectId: p1, kind: 'msg', targetId: 6, state: 'waiting', seq: 3 });
    // c:6 位次 1；m:6 位次 2（c:6 在它前面）⇒ 同 target 不同 kind 是两个成员键
    assert.deepEqual(runner.unitState('c:6', p1, o), { state: 'queued', pos: 1, total: 2 });
    assert.deepEqual(runner.unitState('m:6', p1, o), { state: 'queued', pos: 2, total: 2 });
    assert.equal(runner.unitState('a:6', p1, o).state, 'idle', 'a:6 没有行 ⇒ idle');
  });
});

test('unitBusy：serial 任一前缀行即忙；无前缀即不忙；waiting 行不算', () => {
  withFixture('runner4', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    assert.equal(runner.unitBusy(pid, o), false, '空项目不忙');
    assert.equal(runner.unitBusy(0, o), false, '项目 0 ⇒ false（照 Python `bool(project_id)`）');

    // 只有 waiting 行：不是前缀 ⇒ 不忙
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'waiting', seq: 1 });
    assert.equal(runner.unitBusy(pid, o), false, 'waiting 不占运行位');
    // 升为 starting ⇒ 前缀行在场 ⇒ serial 忙
    fx.db.prepare("UPDATE wait_items SET state='starting' WHERE target_id='1'").run();
    assert.equal(runner.unitBusy(pid, o), true);
    // finishing 也**不**占补位名额（PREFIX_STATES 只有 starting/running）
    fx.db.prepare("UPDATE wait_items SET state='finishing' WHERE target_id='1'").run();
    assert.equal(runner.unitBusy(pid, o), false, 'finishing 行不算前缀（收尾窗口不占名额）');
    // running ⇒ 忙
    fx.db.prepare("UPDATE wait_items SET state='running' WHERE target_id='1'").run();
    assert.equal(runner.unitBusy(pid, o), true);
    // 终态 ⇒ 不忙
    fx.db.prepare("UPDATE wait_items SET state='done' WHERE target_id='1'").run();
    assert.equal(runner.unitBusy(pid, o), false);
  });
});

test('unitBusy：parallel 下 4 个前缀不忙、5 个忙；前缀含 t: 时收 N=1', () => {
  withFixture('runner5', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    setBoardSettings(fx.db, pid, { mode: 'parallel' });
    const add = (kind, target, seq) => insertWait(fx.db, {
      projectId: pid, kind, targetId: target, state: 'running', seq,
    });
    for (let i = 1; i <= 4; i += 1) add('card', i, i);
    assert.equal(runner.unitBusy(pid, o), false, 'parallel N=5：4 个前缀未满');
    add('card', 5, 5);
    assert.equal(runner.unitBusy(pid, o), true, '5 个前缀 = 满');
    // 前缀里来一个 t: ⇒ N 收 1（任务串行红线：任务不与任何单元并发改代码）
    fx.db.prepare("UPDATE wait_items SET state='done' WHERE kind='card'").run();
    assert.equal(runner.unitBusy(pid, o), false);
    add('task', 9, 10);
    assert.equal(runner.unitBusy(pid, o), true, 'parallel + 一个 t: 前缀 ⇒ 仍忙（N 收 1）');
  });
});

test('unitBusy：活跃 ext 行**与 N 无关**地挡全部平台单元（parallel 也不例外）', () => {
  withFixture('runner6', (fx) => {
    const o = { db: fx.db };
    const pid = insertProject(fx.db, { name: 'p' });
    setBoardSettings(fx.db, pid, { mode: 'parallel' });
    assert.equal(runner.unitBusy(pid, o), false);
    insertWait(fx.db, { projectId: pid, kind: 'ext', targetId: 3, state: 'running', seq: 1 });
    assert.equal(runner.unitBusy(pid, o), true, 'parallel 下一条 ext 行也挡全部（与 N 无关）');
    // ext 行落终态 ⇒ 不忙
    fx.db.prepare("UPDATE wait_items SET state='cancelled' WHERE kind='ext'").run();
    assert.equal(runner.unitBusy(pid, o), false);
    // 他项目的 ext 行不影响本项目
    const p2 = insertProject(fx.db, { name: 'p2' });
    insertWait(fx.db, { projectId: p2, kind: 'ext', targetId: 4, state: 'running', seq: 2 });
    assert.equal(runner.unitBusy(pid, o), false, '项目隔离');
    assert.equal(runner.unitBusy(p2, o), true);
  });
});
