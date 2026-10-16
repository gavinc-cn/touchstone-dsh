/**
 * M3 只读模块单测的共享夹具（**不是** `.test.mjs`，故不被 `--test` 收集）。
 *
 * 三条硬约束决定了本文件的形态：
 *   ① **临时库、绝不用生产库**：`~/.touchstone/touchstone.db` 正被生产实例使用，连打开
 *      都不允许。这里每个测试自带 `mkdtemp` 目录 + 全新库文件。
 *   ② **建库走真启动序**：`db.initDb({dbPath})`（= `exec schema.sql` → 收敛 → 种子 →
 *      声明式迁移），保证表结构/索引（尤其 `idx_wait_active` 那条**部分唯一索引**）与
 *      生产库同源；手工 CREATE TABLE 会漏掉索引，把「活跃唯一索引」这条不变量测丢。
 *   ③ **造场景用真 SQL 插真行**（不 mock）：`wait_items`/`chat_msgs`/`board_cards`/
 *      `board_comments`/`board_settings`/`tasks` 一律直接 INSERT，读口读出来的就是
 *      生产库里那种普通对象。
 *
 * 连接生命周期：一个夹具一个句柄，测试末尾 `close()`。所有读口都传 `{db: handle}`
 * （`db.js` 读路径契约），因此既不重复开连接，也不会碰缺省库路径。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as db from '../lib/db.js';

/**
 * 建一个「已初始化 + 已打开」的临时库夹具。
 *
 * @param {string} [tag] 目录前缀（便于失败时认领残留目录）
 * @returns {{dbPath: string, dir: string, uniq: number, db: object, close: Function}}
 */
export function freshDb(tag = 'm3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-node-${tag}-`));
  const dbPath = path.join(dir, 'touchstone.db');
  // ★★ 生产库兜底闸（2026-10-13 第三起误写生产库事故的产物，必读）★★
  // `db.js` 的所有读写口都把 `options` 的缺省值当「自开缺省库连接」处理：`defaultDbPath()`
  // 取 `process.env.TOUCHSTONE_DB || ~/.touchstone/touchstone.db`。于是**任何漏传
  // `{db}`（或形参错位导致 options 落空）的调用都会静默读写生产库** —— 本会话已在
  // 「缝的形参错位」上连踩两次（`enterDoing` 少传一位 ⇒ 桩的 options 落空 ⇒ 写生产库；
  // `stopCard` 传 `{options}` 嵌套 ⇒ 读生产库）。
  // 兜底办法：夹具一建立就把**进程级** env 指向自己 ⇒ 之后一切「漏传 options」的调用都落进
  // 这个临时库，单测在结构上不可能再写到生产库（比「每个调用点都记得传」可靠得多）。
  // 注意：env 是进程级的，`node --test` 每个测试文件一个进程 ⇒ 不会互相串库。
  process.env.TOUCHSTONE_DB = dbPath;
  // 空口令 admin、不强制改密（与 db.test.mjs 的 ENV_PASSWORDLESS 同）
  db.initDb({ dbPath, env: { TS_ADMIN_PASSWORDLESS: '1' } });
  const handle = db.openDb(dbPath);
  return {
    dbPath,
    dir,
    uniq: uniqueCounter(),
    db: handle,
    close() {
      try { handle.close(); } catch { /* 已关 */ }
    },
  };
}

let counter = 0;
/** 单测内造唯一 id（同一测试里插多行时用；不依赖时间戳，避免同毫秒撞号） */
export function uniqueCounter() {
  counter += 1;
  return counter;
}

// --------------------------------------------------------------------------
// 造行 helpers（真 SQL；字段名保持 snake_case，与生产库一致）
// --------------------------------------------------------------------------

/** 插一个项目行（返回 id）；`project_dir`/`work_dir` 缺省指向夹具目录（不存在也无妨） */
export function insertProject(handle, opts = {}) {
  const {
    userId = 1, name = 'proj', projectDir = '/tmp/proj', workDir = '',
    agentPath = 'dsh-plugin:/usr/local/bin/dsh',
  } = opts;
  const info = handle.prepare(
    'INSERT INTO projects(user_id, name, project_dir, agent_path, work_dir, bug_dir, created_at)'
    + ' VALUES(?,?,?,?,?,?,?)',
  ).run(userId, name, projectDir, agentPath, workDir || projectDir, '', '2026-10-11 00:00:00');
  return Number(info.lastInsertRowid);
}

/**
 * 插一张卡片（返回 id）。`sortOrder` 缺省按 todo 列自增（与 `db.insert_board_card` 同口径）。
 * 其余列都给了显式缺省，保证 `card_json` 的每个字段都有确定值可断言。
 */
export function insertCard(handle, projectId, opts = {}) {
  const {
    title = 'card', description = 'desc', columnKey = 'todo', sortOrder = null,
    sessionId = '', sessions = '[]', blockKind = '', blockText = '',
    parentCardId = null, blockOrigin = null, origin = '', doneAt = null,
    worktree = '', jiraKey = '', lastError = '', lastErrorAt = null,
    scheduledAt = 0, trashed = 0, trashedAt = null, unread = 0,
    createdAt = '2026-10-11 00:00:00', updatedAt = '2026-10-11 00:00:00',
  } = opts;
  let so = sortOrder;
  if (so === null) {
    const row = handle.prepare(
      "SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM board_cards"
      + " WHERE project_id=? AND column_key=?",
    ).get(projectId, columnKey);
    so = row.n;
  }
  const info = handle.prepare(
    'INSERT INTO board_cards(project_id, title, description, column_key, sort_order,'
    + ' session_id, sessions, block_kind, block_text, parent_card_id, origin, done_at,'
    + ' worktree, jira_key, last_error, last_error_at, scheduled_at, trashed, trashed_at,'
    + ' unread, created_at, updated_at)'
    + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(projectId, title, description, columnKey, so, sessionId, sessions, blockKind,
    blockText, parentCardId, origin ?? (blockOrigin || ''), doneAt, worktree, jiraKey,
    lastError, lastErrorAt, scheduledAt, trashed, trashedAt, unread, createdAt, updatedAt);
  return Number(info.lastInsertRowid);
}

/**
 * 插一条等待项（`wait_items`；**显式给 id/seq**，便于钉住位次算术）。
 * 注意 `idx_wait_active` 是 (kind, target_id) 上的部分唯一索引——同 kind 同 target 不得
 * 有两条活跃行（造场景时靠不同 target 或不同 kind 规避）。
 */
export function insertWait(handle, opts = {}) {
  const {
    id = null, projectId, kind, targetId, state = 'waiting', seq = 1,
    createdAt = '2026-10-11 00:00:00', claimedAt = null, claimedBy = '',
    endedAt = null, notBefore = 0, retries = 0, meta = '{}',
    lastSeen = 0, evidence = '{}',
  } = opts;
  let info;
  if (id === null) {
    info = handle.prepare(
      'INSERT INTO wait_items(project_id, kind, target_id, state, seq, created_at,'
      + ' claimed_at, claimed_by, ended_at, not_before, retries, meta, last_seen, evidence)'
      + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(projectId, kind, String(targetId), state, seq, createdAt, claimedAt, claimedBy,
      endedAt, notBefore, retries, meta, lastSeen, evidence);
  } else {
    info = handle.prepare(
      'INSERT INTO wait_items(id, project_id, kind, target_id, state, seq, created_at,'
      + ' claimed_at, claimed_by, ended_at, not_before, retries, meta, last_seen, evidence)'
      + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, projectId, kind, String(targetId), state, seq, createdAt, claimedAt, claimedBy,
      endedAt, notBefore, retries, meta, lastSeen, evidence);
  }
  return Number(info.lastInsertRowid);
}

/** 插一条会话消息（`chat_msgs`）；created_at 是**毫秒**（照 waitq.msg_enqueue） */
export function insertMsg(handle, opts = {}) {
  const {
    id, projectId, sid = '', taskId = null, cardId = null, message = 'hi',
    state = 'queued', error = '', inject = 0,
    createdAt = 1_700_000_000_000, startedAt = null, endedAt = null,
  } = opts;
  handle.prepare(
    'INSERT INTO chat_msgs(id, project_id, sid, task_id, card_id, message, state, error,'
    + ' inject, created_at, started_at, ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(String(id), projectId, sid, taskId, cardId, message, state, error, inject,
    createdAt, startedAt, endedAt);
  return String(id);
}

/** 插一条评论（`board_comments`） */
export function insertComment(handle, cardId, text = 'c', opts = {}) {
  const {
    sent = 0, sessionId = '', sentText = '', createdAt = '2026-10-11 00:00:00',
  } = opts;
  const info = handle.prepare(
    'INSERT INTO board_comments(card_id, text, sent, session_id, sent_text, created_at)'
    + ' VALUES(?,?,?,?,?,?)',
  ).run(cardId, text, sent, sessionId, sentText, createdAt);
  return Number(info.lastInsertRowid);
}

/** 插一个任务（`tasks`）——`board_payload.active_tasks` 段的素材 */
export function insertTask(handle, projectId, opts = {}) {
  const {
    name = 'task', status = 'queued', taskType = 'normal', currentRound = 1,
    sessionId = '', error = '', createdAt = '2026-10-11 00:00:00',
    startedAt = null, endedAt = null,
  } = opts;
  const info = handle.prepare(
    'INSERT INTO tasks(project_id, name, task_type, status, current_round, session_id,'
    + ' error, created_at, started_at, ended_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(projectId, name, taskType, status, currentRound, sessionId, error,
    createdAt, startedAt, endedAt);
  return Number(info.lastInsertRowid);
}

/** 写看板设置（`board_settings.json`；`raw` 传字符串可造坏 JSON） */
export function setBoardSettings(handle, projectId, raw) {
  const json = typeof raw === 'string' ? raw : JSON.stringify(raw);
  handle.prepare('INSERT OR REPLACE INTO board_settings(project_id, json) VALUES(?,?)')
    .run(projectId, json);
}
