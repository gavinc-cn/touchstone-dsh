/**
 * `backend/lib/runner.js` **M6.5-R1 的两条回归钉**（`node --test`，零依赖）。
 *
 * 为什么单独一个文件（而不是并进 `runner-core.test.mjs`）：这两条都是**对拍实测反过来钉
 * Node 侧行为**的判据，判据来源不是「照抄 Python 的形状」，而是「A 侧 oracle 的真实观测」，
 * 值得在文件头留下证据链：
 *
 *   ① `Runner.logTaskLine` / `_log_task_line`（runner.py:1985）：Python 的
 *      `except (OSError, AttributeError)` **不含 TypeError**，而 `task is None` 时
 *      `task["id"]` 抛的正是 TypeError ⇒ Python 侧**外抛**。对拍 A 侧实测：
 *      `{"ok": false, "kind": "TypeError", "error": "'NoneType' object is not subscriptable"}`。
 *      反面教训：本批初版照「防御姿态」写了 `catch (e) { if (e instanceof TypeError) return; }`
 *      —— 那是**静默降级**（A 抛 B 不抛），被 `tools/parity/cases-mod/runner_task.json`
 *      的 `seq log_task_line` 一看就红。修法 = 不写 try/catch。本文件钉住「抛 TypeError」，
 *      防它哪天被「顺手加个兜底」改回去。
 *      错误**文本**随语言不同（引擎文案 vs Python 文案），不去逐字复刻（见 runner.js 差异㉖）。
 *   ② `Runner.applyBugResult` 的 pipeline 分支经私有 `stageIndex` 比阶段序：Python
 *      `tuple.index` 缺项抛 ValueError ⇒ 该轮打成失败；Node 的 `indexOf` 会**静默返回 -1**
 *      （= 静默降级，pipeline 后段变成 no-op）⇒ 本批显式抛。钉住「未知阶段必抛」。
 *
 * 两条硬约束（照 `runner-core.test.mjs` / `m3fixture.mjs` 的既有口径）：
 *   - **临时库、绝不用生产库**：`freshDb` 把 `TOUCHSTONE_DB` 指到一次性目录；
 *   - **不起真后台循环**：`new Runner(true, …)`（启动闸关着），只调纯逻辑方法。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import * as runner from '../lib/runner.js';
import { freshDb, insertProject, insertTask } from './m3fixture.mjs';

/** 每例自带临时库夹具（照 runner-core.test.mjs 的 withFixture）。 */
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

/** 停闸 Runner（执行循环全停在启动闸后，只做直调）。 */
function parkedRunner(fx) {
  return new runner.Runner(true, { db: fx.db });
}

/** 造一轮（返回 log_path 用的文件路径）。`roundNo` 显式给，保证「最新轮次」判据可预期。 */
function insertRound(fx, taskId, roundNo, logPath) {
  fx.db.prepare('INSERT INTO rounds(task_id, round_no, status, log_path, started_at, kind,'
    + ' run_key) VALUES(?,?,?,?,?,?,?)')
    .run(taskId, roundNo, 'running', logPath, '2026-10-11 00:00:00', 'agent', '');
}

// --------------------------------------------------------------------------
// ① `_log_task_line`：不吞异常（Python 的 except 元组不含 TypeError）
// --------------------------------------------------------------------------

test('logTaskLine: task 为 null ⇒ 抛 TypeError（照 Python，绝不静默吞掉）', () => {
  withFixture('runner-bug-log-null', (fx) => {
    const r = parkedRunner(fx);
    // A 侧实测：Python `task["id"]` ⇒ TypeError（`except (OSError, AttributeError)` 不含它）
    assert.throws(() => r.logTaskLine(null, '这行不该被吞', { db: fx.db }), TypeError);
    // 缺 id 的等价面同样是 TypeError（`undefined.id`）
    assert.throws(() => r.logTaskLine(undefined, '同上', { db: fx.db }), TypeError);
  });
});

test('logTaskLine: 无轮次行 ⇒ 静默；有轮次行 ⇒ 追加进**最新**（round_no 最大）那轮的日志', () => {
  withFixture('runner-bug-log-append', (fx) => {
    const pid = insertProject(fx.db, { workDir: fx.dir });
    const tid = insertTask(fx.db, pid, { name: 't', status: 'queued' });
    const r = parkedRunner(fx);
    const log1 = path.join(fx.dir, 'task_%d_round_1.log'.replace('%d', String(tid)));
    const log2 = path.join(fx.dir, `task_${tid}_round_2.log`);
    fs.writeFileSync(log1, '# 轮次 1\n', 'utf8');
    fs.writeFileSync(log2, '# 轮次 2\n', 'utf8');

    // 无轮次行：静默（不上抛、不建文件）
    r.logTaskLine({ id: tid }, '无轮次行不写', { db: fx.db });
    assert.equal(fs.readFileSync(log1, 'utf8'), '# 轮次 1\n');
    assert.equal(fs.readFileSync(log2, 'utf8'), '# 轮次 2\n');

    // 倒序插行（round_no 2 先插）：`list_rounds` 按 round_no 排序 ⇒ 最新 = round 2
    insertRound(fx, tid, 2, log2);
    insertRound(fx, tid, 1, log1);
    r.logTaskLine({ id: tid }, '追加一行', { db: fx.db });
    assert.equal(fs.readFileSync(log1, 'utf8'), '# 轮次 1\n');
    assert.equal(fs.readFileSync(log2, 'utf8'), '# 轮次 2\n### 追加一行\n');
  });
});

// --------------------------------------------------------------------------
// ② `_apply_bug_result` 的 pipeline 分支：阶段序缺项必抛（不静默 no-op）
// --------------------------------------------------------------------------

test('applyBugResult: pipeline + 未知 end_stage ⇒ 抛（`STAGES.index` 的 ValueError 等价）', () => {
  withFixture('runner-bug-stage', (fx) => {
    const pid = insertProject(fx.db, { workDir: fx.dir });
    const tid = insertTask(fx.db, pid, { name: 'p', taskType: 'pipeline' });
    const r = parkedRunner(fx);
    const project = { id: pid, work_dir: fx.dir, cases_root: path.join(fx.dir, 'free_style'),
      bug_dir: path.join(fx.dir, 'bug_report') };
    const task = { id: tid, project_id: pid, task_type: 'pipeline', end_stage: '不存在的阶段',
      payload: '{"bug_dirs": ["x"]}' };
    assert.throws(() => r.applyBugResult(project, task, { db: fx.db }), /is not in tuple/);

    // 空 end_stage 回落 'report'（< retest）⇒ 不联动、不抛
    assert.doesNotThrow(() => r.applyBugResult(project, { ...task, end_stage: '' }, { db: fx.db }));
  });
});
