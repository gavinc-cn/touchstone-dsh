/**
 * 卡面标题/描述跟随 DSH（`board.syncSessions` / `syncCardFollow` / `autoTitleForms`）
 * 单测——与 Python `tests/test_board_sync_title.py` 同判据（期望值来源是 `board.py`
 * 的**当前**口径，不是读 Node 实现反推）。
 *
 * 两块：
 *   ① `origin='sync'` 自动卡（2026-10-10 口径）：标题 = DSH 当前标题（末枚
 *      `session/title`）、描述 = 首问全文；用户改过名 ⇒ 整卡不动；幂等。
 *   ② **平台从看板启动过会话的卡**（2026-10-16 扩面，用户诉求「卡面标题/正文与 DSH
 *      保持一致」）：判据 = 会话首问是平台拼的任务提示词（`TASK_PROMPT_TAG` 开头）；
 *      卡标题仍是用户敲进卡里的原文（出现在首问里）⇒ 跟随；改过 ⇒ 不动；列语义仍只
 *      服务 sync 卡（归档不搬列）。
 *
 * 会话一律**真实会话存储**（`setSessionsRoot` 指向临时根 + 真 zstd 会话文件），不只
 * 打桩 `list_sessions`：覆盖「会话头 → 首问/标题扫描 → 同步」整条链路。DB 走夹具临时库
 * （`freshDb` 设进程级 `TOUCHSTONE_DB`，结构性闸：漏传 `{db}` 也落不到生产库）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import * as board from '../lib/board.js';
import * as db from '../lib/db.js';
import * as sp from '../lib/sessparse.js';
import { freshDb, insertCard, insertProject } from './m3fixture.mjs';

const SID = 'session-aaaa1111-2222-3333-4444-555555555555';
const SID2 = 'session-bbbb1111-2222-3333-4444-555555555555';

/** 平台任务提示词样本（`buildTaskPrompt`：标题并入【任务描述】段 + 工作目录段） */
const PLATFORM_TITLE = '帮我看下这个报错';
const PLATFORM_FP = `【任务描述】${PLATFORM_TITLE}\n【工作目录】/tmp/proj`;

/** 造一个真会话文件（多帧：头 + 标题事件 + 用户提问） */
function writeSession(sessionsRoot, cwd, sid, { titles = [], firstPrompt = '' } = {}) {
  const frames = [
    [{ type: 'session', version: 4, id: sid, cwd }],
    titles.map((t, i) => ({ type: 'session/title', seq: i + 1, time: i + 1, data: { title: t } })),
    firstPrompt
      ? [{
        type: 'user/message', seq: 100, time: 100,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: firstPrompt }] },
      }]
      : [],
  ];
  const blob = Buffer.concat(frames.map((frame) => zstdCompressSync(Buffer.from(
    frame.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8',
  ))));
  const dir = path.join(sessionsRoot, path.basename(sp.dsh_bucket(cwd)), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), blob);
}

/** 一次测试的夹具：临时库 + 临时会话根 + 一个项目；返回可断言的卡片行读取口 */
function setup(tag, cardOpts = {}, sessionOpts = {}) {
  const fx = freshDb(`sync-title-${tag}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ts-sync-title-${tag}-`));
  const sessionsRoot = path.join(root, 'sessions');
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  sp.setSessionsRoot(sessionsRoot);
  const pid = insertProject(fx.db, { name: `P-${tag}`, projectDir, workDir: projectDir });
  const cid = cardOpts.skipCard ? null : insertCard(fx.db, pid, cardOpts);
  if (!cardOpts.skipCard) writeSession(sessionsRoot, projectDir, cardOpts.sessionId || SID, sessionOpts);
  const opts = { db: fx.db };
  return {
    fx,
    pid,
    cid,
    opts,
    projectDir,
    sessionsRoot,
    card: () => fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cid),
    /** 跑一拍同步（真 DB 行 + 真会话存储） */
    tick: async () => board.syncSessions(db.getProject(pid, opts), opts),
    close() {
      board.resetSyncSweptSets();
      fx.close();
    },
  };
}

// ---------------------------------------------------------------- sync 卡（旧口径未变）

test('syncCardFollow：DSH 标题更新后 sync 卡标题/描述跟着改，第二拍零写入', async () => {
  const s = setup('sync-follow', {
    title: '【任务描述】帮我看下这个', description: '', columnKey: 'review',
    sessionId: SID, sessions: JSON.stringify([SID]), origin: 'sync',
  }, { titles: ['【任务描述】帮我看下这个', '报错排查'], firstPrompt: '帮我看下这个报错\n细节行' });
  await s.tick();
  let c = s.card();
  assert.equal(c.title, '报错排查');
  assert.equal(c.description, '帮我看下这个报错\n细节行');
  const before = s.card();
  await s.tick();
  assert.deepEqual(s.card(), before);                       // 幂等
  s.close();
});

test('syncCardFollow：用户改过名 ⇒ 标题与描述都不动', async () => {
  const s = setup('sync-renamed', {
    title: '我改的名字', description: '', sessionId: SID, sessions: JSON.stringify([SID]), origin: 'sync',
  }, { titles: ['会话标题'], firstPrompt: '首行\n其余' });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '我改的名字');
  assert.equal(c.description, '');
  s.close();
});

// -------------------------------------------- 平台从看板启动过会话的卡（2026-10-16 扩面）

test('isPlatformTaskSession / inFirstPrompt：判据本身', () => {
  assert.equal(board.isPlatformTaskSession({ first_prompt: PLATFORM_FP }), true);
  assert.equal(board.isPlatformTaskSession({ first_prompt: '  【任务描述】x' }), true);
  assert.equal(board.isPlatformTaskSession({ first_prompt: '用户在 dsh GUI 里问的话' }), false);
  assert.equal(board.isPlatformTaskSession({ first_prompt: '继续' }), false);
  assert.equal(board.isPlatformTaskSession({ first_prompt: '' }), false);
  assert.equal(board.isPlatformTaskSession({}), false);
  assert.equal(board.inFirstPrompt('报错', { first_prompt: '帮我看看报错' }), true);
  assert.equal(board.inFirstPrompt('', { first_prompt: '帮我看看报错' }), false);
  assert.equal(board.inFirstPrompt('   ', { first_prompt: '帮我看看报错' }), false);
  assert.equal(board.inFirstPrompt('用户另写的', { first_prompt: '帮我看看报错' }), false);
  assert.equal(board.inFirstPrompt('报错', {}), false);
});

test('平台启动的卡：标题 = DSH 当前标题、描述 = 首问全文（卡 986 形态）', async () => {
  const s = setup('platform-follow', {
    title: PLATFORM_TITLE, description: '', columnKey: 'review', sessionId: SID,
    sessions: JSON.stringify([SID]), origin: '',
  }, { titles: ['【任务描述】帮我看下这个报错', '报错排查'], firstPrompt: PLATFORM_FP });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '报错排查');
  assert.equal(c.description, PLATFORM_FP);
  assert.equal(c.origin, '');                                // 卡还是用户那张
  assert.equal(c.column_key, 'review');                      // 列不动
  s.close();
});

test('平台启动的卡：跟随是持续的（DSH 再改名仍跟随）且幂等', async () => {
  const s = setup('platform-continue', {
    title: PLATFORM_TITLE, description: '', sessionId: SID, sessions: JSON.stringify([SID]),
    origin: '',
  }, { titles: ['【任务描述】帮我看下这个报错', '报错排查'], firstPrompt: PLATFORM_FP });
  await s.tick();
  assert.equal(s.card().title, '报错排查');
  writeSession(s.sessionsRoot, s.projectDir, SID, {
    titles: ['【任务描述】帮我看下这个报错', '报错排查', '二次改名'], firstPrompt: PLATFORM_FP,
  });
  await s.tick();
  const second = s.card();
  assert.equal(second.title, '二次改名');
  assert.equal(second.description, PLATFORM_FP);
  await s.tick();
  assert.deepEqual(s.card(), second);                        // 第三拍无写入
  s.close();
});

test('平台启动的卡：用户改过卡名 ⇒ 标题与描述都不动', async () => {
  const s = setup('platform-renamed', {
    title: '我改的名字', description: '我写的备注', sessionId: SID, sessions: JSON.stringify([SID]),
    origin: '',
  }, { titles: ['报错排查'], firstPrompt: PLATFORM_FP });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '我改的名字');
  assert.equal(c.description, '我写的备注');
  s.close();
});

test('平台启动的卡：描述是用户后写的（不在首问里）⇒ 只改标题', async () => {
  const s = setup('platform-desc', {
    title: PLATFORM_TITLE, description: '我补充的备注', sessionId: SID,
    sessions: JSON.stringify([SID]), origin: '',
  }, { titles: ['报错排查'], firstPrompt: PLATFORM_FP });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '报错排查');
  assert.equal(c.description, '我补充的备注');
  s.close();
});

test('平台启动的卡：描述仍是平台原文（卡里的图片 markdown）⇒ 刷成首问全文', async () => {
  const img = '![image.png](/tmp/x.png)';
  const fp = `【任务描述】图片显示不出来\n\n${img}\n【工作目录】/tmp/proj`;
  const s = setup('platform-img', {
    title: '图片显示不出来', description: img, sessionId: SID,
    sessions: JSON.stringify([SID]), origin: '',
  }, { titles: ['图片显示'], firstPrompt: fp });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '图片显示');
  assert.equal(c.description, fp);
  s.close();
});

test('平台启动的卡：空标题卡取 DSH 当前标题', async () => {
  const fp = '【任务描述】（无）\n【工作目录】/tmp/proj';
  const s = setup('platform-empty', {
    title: '', description: '', sessionId: SID, sessions: JSON.stringify([SID]), origin: '',
  }, { titles: ['会话标题'], firstPrompt: fp });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '会话标题');
  assert.equal(c.description, fp);
  s.close();
});

test('非平台启动的会话（dsh GUI 直跑）绑定的用户卡：标题/描述一字不动', async () => {
  const s = setup('foreign-session', {
    title: '人工卡标题', description: '', sessionId: SID, sessions: JSON.stringify([SID]), origin: '',
  }, { titles: ['会话标题'], firstPrompt: '用户在 dsh GUI 里直接问的话\n其余' });
  await s.tick();
  const c = s.card();
  assert.equal(c.title, '人工卡标题');
  assert.equal(c.description, '');
  s.close();
});

test('平台启动的卡：归档不搬列（列语义仍只服务 sync 卡）', async () => {
  // 归档集读宿主 workspace.json；本夹具没有它 ⇒ 按未归档。此处直接钉「列不动」的
  // 另一半判据：follow 只写标题/描述两个字段，绝不带 column_key。
  const s = setup('platform-column', {
    title: PLATFORM_TITLE, description: '', columnKey: 'review', sessionId: SID,
    sessions: JSON.stringify([SID]), origin: '',
  }, { titles: ['报错排查'], firstPrompt: PLATFORM_FP });
  await s.tick();
  const c = s.card();
  assert.equal(c.column_key, 'review');
  assert.equal(c.title, '报错排查');
  s.close();
});

test('平台启动的卡：非主会话（fork 子会话）不驱动卡面', async () => {
  const s = setup('platform-fork', {
    title: PLATFORM_TITLE, description: '', sessionId: SID, sessions: JSON.stringify([SID, SID2]),
    origin: '',
  }, { titles: ['报错排查'], firstPrompt: PLATFORM_FP });
  // SID2 是主会话 SID 之外的并集成员：写一份自己的会话存储，卡面仍只认 SID
  writeSession(s.sessionsRoot, s.projectDir, SID2, {
    titles: ['子会话标题'], firstPrompt: '【任务描述】别的任务\n【工作目录】/tmp/proj',
  });
  await s.tick();
  assert.equal(s.card().session_id, SID);
  s.close();
});
