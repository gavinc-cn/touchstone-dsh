/**
 * 调度核心**接线**测试（M4.5）：真起 `backend/server.js` 子进程，钉住 `main()` 里那串启动序
 * 与「board 缺口」的声明方式。
 *
 * 为什么必须是真进程 + 真库（照 `contract.test.mjs` 的口径）：本里程碑新增的东西**不在任何
 * 函数签名里**——它是「启动序」：`setLivenessProbe(null) → setInstance(Runner(bootGate=true))
 * → await recover() → reconcileUnits() → releaseBootGate() → startUnitSelfcheck()`，以及
 * 「board.recover 缺席」这件事的可见性。函数级单测（`runner-core.test.mjs`）覆盖不了
 * 「server 有没有按这个顺序调」。
 *
 * 三条断言各自证明什么：
 *   ① **对账真跑了、且跑在起监听之前**：stdout 里 `[waitq] 对账完成：活跃行 N 条…` 必须在
 *      `TOUCHSTONE_LISTEN` **之前**（`reconcileUnits` 在 main 里位于 bind 之前 ⇒ 也就位于
 *      启动闸放行之前；这正是 Python「提前拾取会被对账误裁」的防线）；
 *   ② **worker 真的活了、启动闸真的放行了**：预置一条 free 项目里的 waiting `t:` 行，启动后
 *      它必须被拾取并落到终态。当前 `t:` 执行体未移植（M6）⇒ 终态是 `failed` + 错误文案点名
 *      M6 —— 这条同时是**边界钉**：M6 落地后本断言要改成「任务真的跑了」；
 *   ③ **board 启动步已接全、缺口横幅已消失、且 ext 行按承诺不被误动**：M5 起 `board.recover()`
 *      夹在两次 recover 与对账之间、`startScheduler()` 在放行之后（stderr 不再有「未移植（M5）」）；
 *      预置的活跃 `ext:` 行在启动后**仍在**（中枢未连 ⇒ `dshevents` 快照为空 ⇒
 *      `extCandidates` 无候选 ⇒ 按「探测不可用一律保行」；这正是「启动时不误杀外部占用」的判据）。
 *
 * 期望值来源：`server.py:5481-5505` 的启动序 + `waitq.py:877-900`（对账口径），不是读实现反推。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import { insertCard, insertProject, insertTask, insertWait } from './m3fixture.mjs';

const SERVER_JS = path.resolve(import.meta.dirname, '..', 'server.js');

/** 造临时 WEB_DIR（等价于 webui/dist-plugin 的最小形态；server.js 缺 index.html 会直接退出） */
function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wire-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body></body></html>\n');
  return dir;
}

/**
 * 建一个**预置好行**的临时库（先 `initDb` 真建表，再显式 SQL 插行——不手工 CREATE TABLE）。
 * @returns {{dbPath: string, dir: string, ids: object}}
 */
function seedDb({ freeProject = false, extBlockedProject = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wire-db-'));
  const dbPath = path.join(dir, 't.db');
  db.initDb({ dbPath, env: { TS_ADMIN_PASSWORDLESS: '1' } });
  const handle = db.openDb(dbPath);
  const ids = {};
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(path.join(workDir, 'free_style'), { recursive: true });
  try {
    if (extBlockedProject) {
      const pid = insertProject(handle, { userId: 1, name: 'P-ext', workDir });
      const cid = insertCard(handle, pid, { columnKey: 'todo', sessionId: 'sid-ext-0001' });
      insertWait(handle, { projectId: pid, kind: 'ext', targetId: cid, state: 'running',
        seq: 1, lastSeen: 1, evidence: '{"desc":"外部会话在跑","reason":"接线测试"}' });
      ids.extProject = pid;
      ids.extCard = cid;
      ids.extWaitId = handle.prepare(
        "SELECT id FROM wait_items WHERE kind='ext' ORDER BY id DESC LIMIT 1").get().id;
    }
    if (freeProject) {
      const pid = insertProject(handle, { userId: 1, name: 'P-free', workDir });
      const tid = insertTask(handle, pid, { status: 'queued' });
      insertWait(handle, { projectId: pid, kind: 'task', targetId: tid, state: 'waiting', seq: 1 });
      ids.freeProject = pid;
      ids.freeTask = tid;
    }
  } finally {
    handle.close();
  }
  return { dbPath, dir, ids, workDir };
}

/** 起一个后端子进程（库路径由调用方给：测试要先预置行），等到端口行 */
async function startBackend({ webDir, dbPath, runDir }) {
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    SERVER_JS,
    '--host', '127.0.0.1', '--port', '0', '--web-dir', webDir,
    '--trust-internal-user', '--parent-watch',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TOUCHSTONE_DB: dbPath, TOUCHSTONE_RUN_DIR: runDir,
      TS_ADMIN_PASSWORDLESS: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `10s 未见 TOUCHSTONE_LISTEN。stdout=${stdout} stderr=${stderr}`)), 10000);
    const tick = () => {
      const m = stdout.match(/^TOUCHSTONE_LISTEN (\d+)/m);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', tick);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`后端提前退出 code=${code} stderr=${stderr}`)); });
    tick();
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { child, port, stdout: () => stdout, stderr: () => stderr, stop };
}

/** 只读快照小工具（库是临时库，允许并发读） */
function readDb(dbPath, fn) {
  const h = new DatabaseSync(dbPath);
  try {
    return fn(h);
  } finally {
    h.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等一个条件在时限内成立（轮询只读库；两侧写者是子进程）。
 * 为什么不用固定 sleep：拾取是事件驱动的（入队即 notify），实测毫秒级完成；固定 sleep
 * 既慢又不稳（CI 负载高时 200ms 不够）。超时后把最后观测打出来，失败可自证。
 */
async function waitFor(fn, { timeoutMs = 10000, stepMs = 100, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = fn();
    if (last) return last;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

test('接线①：启动对账在起监听之前跑，且 ext 行按承诺保留；board 缺口声明在 stderr', { timeout: 40000 },
  async () => {
    const webDir = makeWebDir();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wire-run-'));
    const fx = seedDb({ extBlockedProject: true });
    const b = await startBackend({ webDir, dbPath: fx.dbPath, runDir });
    try {
      const out = b.stdout();
      // ① 对账真的跑了，且逐行报告了那条 ext 行（unknown = 不处置）
      assert.match(out, /^\[waitq\] 对账 ext:\d+（项目 \d+）：unknown$/m, `stdout=${JSON.stringify(out)}`);
      assert.match(out, /^\[waitq\] 对账完成：活跃行 1 条，收口 0 条$/m, `stdout=${JSON.stringify(out)}`);
      // ② 对账行在端口行**之前**（= 起监听之前 ⇒ 也在启动闸放行之前）
      const iReconcile = out.indexOf('[waitq] 对账完成');
      const iListen = out.indexOf('TOUCHSTONE_LISTEN');
      assert.ok(iReconcile >= 0 && iListen > iReconcile,
        `对账必须早于端口行：reconcile@${iReconcile} listen@${iListen} stdout=${JSON.stringify(out)}`);
      // ③ **M5 起 board 启动步已接全**（缺口横幅必须消失）：
      //    `board.recover()` 夹在两次 recover 与对账之间、`startScheduler()` 在放行之后 ——
      //    stderr 只该有「已接线」那一行，不该再有「未移植（M5）」。
      const err = b.stderr();
      assert.ok(!/未移植（M5）/.test(err),
        `board 缺口横幅应已删除（M5 已接线）：stderr=${err}`);
      assert.match(err, /调度核心已接线（启动闸已放行；board 启动步随 M5 接全）/, `stderr=${err}`);
      assert.match(err, /dsh 状态事件中枢/, `stderr=${err}`);
      // ④ ext 行仍在（中枢未连 ⇒ 探测不可用 ⇒ 一律保行；这正是「启动时不误杀外部占用」的判据），卡也在
      const row = readDb(fx.dbPath, (h) => h.prepare('SELECT state, kind FROM wait_items WHERE id=?')
        .get(fx.ids.extWaitId));
      assert.equal(row.state, 'running', 'ext 行被误动了（中枢未连时不该收口它）');
      assert.equal(row.kind, 'ext');
      const card = readDb(fx.dbPath, (h) => h.prepare('SELECT id FROM board_cards WHERE id=?')
        .get(fx.ids.extCard));
      assert.ok(card, '卡行不该消失');
    } finally {
      await b.stop();
    }
  });

test('接线②：worker 活着 + 启动闸已放行——free 项目的 waiting t: 行被拾取并落终态', { timeout: 40000 },
  async () => {
    const webDir = makeWebDir();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wire-run-'));
    const fx = seedDb({ freeProject: true });
    const b = await startBackend({ webDir, dbPath: fx.dbPath, runDir });
    try {
      // 拾取是事件驱动（入队/启动放行都会 notify），实测毫秒级；给足上限只为抗负载
      // 终态错误文本落 `meta.error`（setTerminal → mergeMetaOn；wait_items 没有 error 列）
      const got = await waitFor(() => {
        const row = readDb(fx.dbPath, (h) => h.prepare(
          'SELECT state, meta FROM wait_items WHERE kind=? AND target_id=?')
          .get('task', String(fx.ids.freeTask)));
        if (!row || row.state === 'waiting' || row.state === 'starting') return null;
        return { state: row.state, error: (JSON.parse(row.meta || '{}') || {}).error || '' };
      }, { what: 't: 行落终态' });
      assert.ok(got, '10s 内 t: 行仍未落终态 ⇒ worker 没在跑（启动闸没放行 / 没接线）');
      // **M6.5（2026-10-14）起执行体已接真**，本用例的期望随之改写（原期望是「未移植（M6）⇒ failed」）：
      //   ① **行落 `done`**：`processTask` 把「驱动不可用」在**轮次内部**收口成任务失败，**不抛异常**
      //      ⇒ `runPickedUnit` 的 `err` 为空 ⇒ `waitq.finishByTarget(DONE)`。行态 `failed` 只属于
      //      「执行体自己抛了」的情形——那正是接线前的样子。
      //   ② **任务行落 failed**，错误文案是轮次退出码（真执行体的收口），不再是 `UNIT_HANDLER_MISSING`。
      //   ③ **轮次行真落了**：这是「执行体真的跑了」最直接的落库证据（接线前一行都没有）。
      assert.equal(got.state, 'done',
        `M6.5 起 t: 执行体已接线 ⇒ 单元正常执行完（失败在轮次里收口，不是抛异常）；实际 ${JSON.stringify(got)}`);
      assert.equal(got.error, '', '执行体不该抛异常：驱动不可用是轮次内部的失败，不是单元异常');
      const task = readDb(fx.dbPath, (h) => h.prepare('SELECT status, error FROM tasks WHERE id=?')
        .get(fx.ids.freeTask));
      assert.equal(task.status, 'failed',
        '驱动未配置 ⇒ 轮次退出码 -1 ⇒ 任务 failed（真执行体的收口）');
      assert.match(task.error, /^第 \d+ 轮退出码 -1$/, `task.error=${task.error}`);
      const round = readDb(fx.dbPath, (h) => h.prepare(
        'SELECT kind, status, exit_code FROM rounds WHERE task_id=? ORDER BY round_no DESC LIMIT 1')
        .get(fx.ids.freeTask));
      assert.ok(round, '执行体必须真开一轮（接线前 rounds 表里一行都没有）');
      assert.equal(round.kind, 'agent');
      assert.equal(round.status, 'failed');
      assert.equal(round.exit_code, -1);
      // 端到端反证：这次失败是**真的走了 worker**（不是「行没被看见所以没动」）
      const out = b.stdout() + b.stderr();
      assert.match(out, /\[waitq\] 对账完成/, `stdout=${JSON.stringify(b.stdout())}`);
    } finally {
      await b.stop();
    }
  });

test('接线③：ext 行在场 ⇒ 该项目的 waiting t: 行**不被拾取**（补位闸；阻塞源可用性自证）', { timeout: 40000 },
  async () => {
    const webDir = makeWebDir();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wire-run-'));
    const fx = seedDb({ extBlockedProject: true, freeProject: true });
    // 给阻塞项目也放一条 waiting t: 行：它必须一直 waiting
    const h = db.openDb(fx.dbPath);
    const tid = insertTask(h, fx.ids.extProject, { status: 'queued' });
    insertWait(h, { projectId: fx.ids.extProject, kind: 'task', targetId: tid, state: 'waiting', seq: 2 });
    h.close();
    const b = await startBackend({ webDir, dbPath: fx.dbPath, runDir });
    try {
      // ① 阻塞项目的行：等 2.5s（远超事件驱动的拾取时延）仍必须 waiting
      await sleep(2500);
      const blocked = readDb(fx.dbPath, (hh) => hh.prepare(
        'SELECT state FROM wait_items WHERE kind=? AND target_id=?')
        .get('task', String(tid)));
      assert.equal(blocked.state, 'waiting',
        'ext 行在场时该项目不该补位（M4.5 夹具的阻塞源就靠这条）'
        + ` stdout=${JSON.stringify(b.stdout())}`);
      const blockedTask = readDb(fx.dbPath, (hh) => hh.prepare('SELECT status FROM tasks WHERE id=?').get(tid));
      assert.equal(blockedTask.status, 'queued');
      // ② 同时 free 项目的行**必须已被拾取**——否则上面的 waiting 可能只是「worker 整体没跑」
      const picked = readDb(fx.dbPath, (hh) => hh.prepare(
        'SELECT state FROM wait_items WHERE kind=? AND target_id=?')
        .get('task', String(fx.ids.freeTask)));
      // M6.5 起执行体已接真：free 项目的行被拾取并**正常执行完**（`err` 空 ⇒ 行落 done；任务自身
      // 因驱动未配置而 failed，属轮次内部收口，见「接线②」的完整断言）。
      assert.equal(picked.state, 'done',
        `free 项目应被正常拾取并执行完（正对照） stdout=${JSON.stringify(b.stdout())}`);
    } finally {
      await b.stop();
    }
  });
