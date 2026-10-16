/**
 * M7.5-R3 单测：`backend/lib/feishu_conv.js`（`feishu_conv.py:1-920` 全量移植：48 函数 + `_Card`
 * + 31 常量）+ 三条接线缝的**行为**断言（D1 拆名 / `setFailureNotifier` / `setMsgDoneHook`）。
 *
 * 期望值来源（不许读 Node 实现反推）：
 *   ① 逐字文案 = `python3 -c "import feishu_conv as f; print(repr(f.X))"` 的**求值后**文本
 *      （`SESSION_EMPTY`/`MESSAGE_TOO_LONG`/`new_session` 回执在源码里是隐式拼接，数行数会错），
 *      每条另锚一个 oracle 现算的 utf-8 sha256（typo 会被它抓住）；
 *   ② 形状与状态机 = `doc_ai/plan/202610/20261015_0520_M7.5R3对话族与接线缝契约清单.md` §2；
 *   ③ 缝 = 同清单 §5 + Lead 裁决 §9.1（review 3 位 / blocked 4 位，**不许按元数猜形态**）。
 *
 * 三条测试口径：
 *   A. **依赖全注入**：`options.dbmod/rest/chat/feishu/sessparse/dshdriver/dshevents/agents/waitq/
 *      now/log/env` 一律给替身并记流水 —— 对话层不碰真库、不打真飞书（`_dm` 的凭据闸也照测）。
 *   B. **顺序即语义**：所有替身共用一条 `order` 流水，钉「谁先谁后」（baseline 先于 submit、
 *      建会话先于重申绑定、卡片没受理才补文本、DM 先于 toast）。
 *   C. **缝用真模块**：D1/`setFailureNotifier` 走 `m3fixture.freshDb()` 临时库 + 真
 *      `board.js`/`runner.js`（`freshDb` 会把 `TOUCHSTONE_DB` 指到临时库，漏传 options 也写不到生产库）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import * as board from '../lib/board.js';
import * as chatMod from '../lib/chat.js';
import * as conv from '../lib/feishu_conv.js';
import * as db from '../lib/db.js';
import * as feishu from '../lib/feishu.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import * as runner from '../lib/runner.js';
import { freshDb, insertCard, insertMsg, insertProject, insertTask, insertWait } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// oracle 现算锚（`python3 -c` 打印的求值后文本；sha256 为 utf-8 全量 64 位）
// --------------------------------------------------------------------------

const ORA = {
  DRIVER_NEEDED: '飞书通用对话需要 dsh 插件形态（独立形态的站点没有进程内 agent 驱动）',
  NO_DEFAULT_GUIDE: '请先设置默认项目（回复「默认项目 <项目名>」，或发「项目」在卡片上点选）',
  NO_PROJECTS_GUIDE: '你还没有项目，请先到站点创建',
  STALE_NOTE: '（此前绑定的会话已不存在，已解除绑定）',
  UNBIND_NOTE: '已解除此前绑定的会话（下次发消息将在新项目自动新建）',
  PROJECTS_MORE_FMT: '另有 %d 个项目，回复「默认项目 <项目名>」精确设置',
  PROJECTS_TEXT_HINT: '在卡片可用前，可用『默认项目 <项目名>』设置',
  SESSIONS_TEXT_HINT: '可用『绑定会话 <序号|标题关键字|会话id前缀>』绑定',
  TITLE_FMT: '飞书对话 %m-%d %H:%M',
  SESSION_GONE: '该会话已不存在（可能被删除或归档清理），发「会话」刷新列表',
  SESSION_EMPTY: '该默认项目下还没有会话——直接发一句话就会自动新建，或回复「新建会话 <标题>」',
  SESSION_STALE: '列表记忆已过期或序号越界，先发「会话」刷新最近 10 条，再回复「绑定会话 <序号>」',
  SESSION_MISS_FMT: '没找到匹配「%s」的会话，发「会话」看最近 10 条',
  SESSION_MULTI_FMT: '「%s」匹配到多个会话，回复更精确的关键字：\n%s',
  MESSAGE_TOO_LONG: '消息过长（单条上限 %d 字）：请把长内容作为附件/文件发送，或拆成几条短消息再发',
  CONV_ENV: 'TS_FEISHU_CONV',
};

/** oracle 现算的 sha256（`hashlib.sha256(v.encode()).hexdigest()`） */
const ORA_SHA = {
  DRIVER_NEEDED: '134dc1e3542e34d3',
  NO_DEFAULT_GUIDE: '7673b1fdbff76045',
  NO_PROJECTS_GUIDE: '0dc773f7e3385c0d',
  STALE_NOTE: '3c7ed784ed58d97a',
  UNBIND_NOTE: '37a1e6069bbd6837',
  PROJECTS_MORE_FMT: 'a2bd75af7c4edcfa',
  PROJECTS_TEXT_HINT: 'ac8ea873344808d4',
  SESSIONS_TEXT_HINT: 'aad1ccbbbf13e295',
  TITLE_FMT: '7341a8f3e5ba9f4b',
  SESSION_GONE: '5f3093e3b11720eb',
  SESSION_EMPTY: 'a28dfbaf5b94a74e',
  SESSION_STALE: '08df797627dbaaee',
  SESSION_MISS_FMT: 'e7fc8e6caa79e056',
  SESSION_MULTI_FMT: 'd3c66623e2e62e9d',
  MESSAGE_TOO_LONG: '017134dca5d282ef',
  CONV_ENV: 'f7b5fb76b8b6fcf3',
};

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const CARD_BYTES = (card) => Buffer.byteLength(pyJsonDumps(card), 'utf8');
const CFG = { app_id: 'cli_app', app_secret: 'sec' };
/** `SESSION_EMPTY` 求值后的 sha256 全量（前 16 位见 ORA_SHA） */
const sha16 = (s) => sha256(s).slice(0, 16);

// --------------------------------------------------------------------------
// 测试台（全注入替身；一条 order 流水钉顺序）
// --------------------------------------------------------------------------

function makeBinding(over = {}) {
  return {
    open_id: 'ou_a', user_id: 1,
    cur_sid: '', cur_title: '', cur_project_id: 0, cur_bound_at: '',
    default_project_id: 0, ...over,
  };
}

function makeProject(id, over = {}) {
  return {
    id, user_id: 1, name: `P${id}`, project_dir: `/tmp/p${id}`,
    agent_path: 'dsh-plugin:/usr/bin/dsh', model: '', reasoning_effort: '', permission_mode: '',
    ...over,
  };
}

function makeSession(sid, over = {}) {
  return { sid, title: `S-${sid}`, first_prompt: '', mtime: 0, archived: 0, ...over };
}

function harness(over = {}) {
  const order = [];
  const calls = {
    restCard: [], restText: [], db: [], reads: [], submit: [], driver: [], log: [], hook: [],
  };
  const st = {
    projects: [], tasks: [], boardCards: [], counts: {}, binding: makeBinding(),
    sessions: [], sessionExists: () => true, load: () => ({ total: 0, found: true, entries: [] }),
    waits: [], msgMeta: {}, msgGet: null, appCfg: CFG, title: null,
    submitRes: { id: 'm1', state: 'queued', queued: false }, submitErr: null,
    driver: { configured: true }, createSid: 's-new', hook: null,
    env: {}, now: 1_700_000_000,
  };
  const P = (name) => { order.push(name); };

  const dbmod = {
    listProjects: (userId, options) => { P('listProjects'); calls.reads.push(['listProjects', userId]); return st.projects; },
    listTasks: (pid, options) => { P('listTasks'); return st.tasks.filter((t) => t.project_id === pid); },
    listBoardCards: (pid, options) => { P('listBoardCards'); return st.boardCards.filter((c) => c.project_id === pid); },
    boardCountsMany: (pids, options) => { P('boardCountsMany'); const o = {}; for (const p of pids) o[p] = st.counts[p] || {}; return o; },
    getFeishuBindingByOpen: (openId, options) => { P('getBinding'); return st.binding; },
    setFeishuDefaultProject: (openId, pid, options) => { P('setDefaultProject'); calls.db.push(['setDefaultProject', openId, pid]); },
    setFeishuCurSession: (openId, pid, sid, title, options) => {
      P('setCurSession'); calls.db.push(['setCurSession', openId, pid, sid, title]);
    },
    clearFeishuCurSession: (openId, options) => { P('clearCurSession'); calls.db.push(['clearCurSession', openId]); },
  };
  const sessparse = {
    session_exists: (family, sid) => { P('session_exists'); return st.sessionExists(family, sid); },
    list_sessions: (family, cwd) => { P('list_sessions'); return st.sessions; },
    session_title: (family, sid) => {
      P('session_title');
      if (st.title !== null) return st.title;
      const hit = st.sessions.find((it) => it.sid === sid);
      return hit ? hit.title : `T-${sid}`;
    },
    load: (family, sid, agent, after) => { P(`load:${after}`); return st.load(family, sid, agent, after); },
  };
  const dshdriver = {
    configured: () => { P('configured'); return st.driver.configured; },
    splitModel: (m) => { P('splitModel'); calls.driver.push(['splitModel', m]); const i = String(m || '').indexOf('/'); return i > 0 ? [String(m).slice(0, i), String(m).slice(i + 1)] : ['', String(m || '')]; },
    createSession: async (cwd, task, model, provider) => {
      P('createSession'); calls.driver.push(['createSession', cwd, task, model, provider]);
      if (st.driver.createErr) throw st.driver.createErr;
      return st.createSid;
    },
    applySessionDefaults: async (...a) => { P('applySessionDefaults'); calls.driver.push(['applySessionDefaults', ...a]); },
    rename: async (sid, title) => { P('rename'); calls.driver.push(['rename', sid, title]); },
  };
  const dshevents = { get: (sid) => (st.busy && st.busy[sid]) || null };
  const agents = { agentFamily: (p) => { P('agentFamily'); return 'dsh_plugin'; } };
  const waitq = {
    KIND_CARD: 'card', KIND_MSG: 'msg', KIND_ANSWER: 'answer', KIND_EXT: 'ext',
    activeItems: (pid, options) => { P('activeItems'); return st.waits; },
    msgMeta: (msgId, options) => { P('msgMeta'); return st.msgMeta; },
    msgGet: (msgId, options) => { P('msgGet'); return st.msgGet; },
  };
  const rest = {
    restSendCard: async (openId, card, cfg) => { P('restSendCard'); calls.restCard.push([openId, card, cfg]); },
    restSendText: async (openId, text, cfg) => { P('restSendText'); calls.restText.push([openId, text, cfg]); },
  };
  const chat = {
    MESSAGE_MAX: 20000,
    submit: async (projectId, sid, message, options) => {
      P('submit'); calls.submit.push([projectId, sid, message, options]);
      if (st.submitErr) throw st.submitErr;
      return st.submitRes;
    },
    setMsgDoneHook: (fn) => { P('setMsgDoneHook'); st.hook = fn; calls.hook.push(fn); },
  };
  const feishu = { appConfig: (userId) => { P('appConfig'); return st.appCfg; } };

  const options = {
    dbmod, sessparse, dshdriver, dshevents, agents, waitq, rest, chat, feishu,
    now: () => st.now, log: (line) => calls.log.push(line), env: st.env, ...over,
  };
  return { order, calls, st, options, logText: () => calls.log.join('\n') };
}

// --------------------------------------------------------------------------
// ① 常量（逐字 + sha256）
// --------------------------------------------------------------------------

test('常量：15 条固定文案逐字等于 oracle 现算值（sha256 锚）', () => {
  for (const [name, text] of Object.entries(ORA)) {
    assert.equal(conv[name], text, `${name} 文案与 oracle 不一致`);
    assert.equal(sha16(text), ORA_SHA[name], `${name} 锚失效（测试自身的期望值被改过？）`);
  }
  // 数字常量（oracle §2.0）
  assert.equal(conv.CARD_MAX_BYTES, 8000);
  assert.equal(conv.PROJECTS_MAX, 20);
  assert.equal(conv.PROJECTS_FALLBACK, 10);
  assert.equal(conv.PROJECT_NAME_MAX, 200);
  assert.equal(conv.SESSIONS_MAX, 10);
  assert.equal(conv.LIST_TTL, 1800);
  assert.equal(conv.REPLY_MAX_CHARS, 3000);
  assert.equal(conv.SESSION_NAME_MAX, 60);
  // SESSION_FAIL_TEXTS 是**值语义**（oracle `reply in SESSION_FAIL_TEXTS`）
  assert.deepEqual(conv.SESSION_FAIL_TEXTS, [ORA.NO_DEFAULT_GUIDE, ORA.SESSION_GONE]);
  // 求值后的隐式拼接（不许数源码行）
  assert.equal(conv.MESSAGE_TOO_LONG.replace('%d', '20000'),
    '消息过长（单条上限 20000 字）：请把长内容作为附件/文件发送，或拆成几条短消息再发');
  // `len()` 是码点（oracle `python3 -c "print(len(f.SESSION_EMPTY))"` ⇒ 40）
  assert.equal(conv._clip_name(ORA.SESSION_EMPTY).length, 40);
  assert.equal(Array.from(ORA.SESSION_EMPTY).length, 40);
});

// --------------------------------------------------------------------------
// ② enabled()：TS_FEISHU_CONV 精确语义
// --------------------------------------------------------------------------

test('enabled()：只有 strip 后恰好 "0" 才关（"0 "/" 0" 关；"00"/"false"/"no"/"" 全开）', () => {
  const cases = [
    ['0', false], ['0 ', false], [' 0', false], ['\t0\n', false],
    ['00', true], ['0.0', true], ['false', true], ['FALSE', true], ['no', true],
    ['', true], ['1', true], [' off ', true],
  ];
  for (const [value, want] of cases) {
    assert.equal(conv.enabled({ env: { TS_FEISHU_CONV: value } }), want, `TS_FEISHU_CONV=${JSON.stringify(value)}`);
  }
  assert.equal(conv.enabled({ env: {} }), true, '未设置 ⇒ 开（默认开）');
  assert.equal(conv.enabled({}), true, '不传 options ⇒ 走真 process.env（未设置 ⇒ 开）');
  assert.equal(conv.CONV_ENV, 'TS_FEISHU_CONV');
});

// --------------------------------------------------------------------------
// ③ route_text：长度闸 / 四分支 / 双写 / note 两处拼接形态
// --------------------------------------------------------------------------

test('routeText 闸 0：超 MESSAGE_MAX 直接回执，什么都不提交（不读库、不建会话、不发卡）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  const text = 'x'.repeat(20001);
  const reply = await conv.routeText(makeBinding({ cur_sid: 's1', cur_project_id: 7 }), text, CFG, h.options);
  assert.equal(reply, '消息过长（单条上限 20000 字）：请把长内容作为附件/文件发送，或拆成几条短消息再发');
  assert.deepEqual(h.order, [], '长度闸先于一切：不许有任何副作用调用');
  assert.deepEqual(h.calls.db, []);
  assert.deepEqual(h.calls.submit, []);
});

test('routeText 闸 0 的 len() 是**码点**（emoji 不按 UTF-16 码元算）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  h.st.sessionExists = () => true;
  h.st.load = () => ({ total: 3 });
  const b = makeBinding({ cur_sid: 's1', cur_title: 'T', cur_project_id: 7 });
  // 20000 个 emoji = 40000 个 UTF-16 码元，但 Python len() = 20000 ⇒ **不触发**长度闸
  const reply = await conv.routeText(b, '😀'.repeat(20000), CFG, h.options);
  assert.equal(reply, '已投递到「T」（执行中），跑完把答复发回这里');
  assert.equal(h.calls.submit.length, 1, '码点计数 ⇒ 不误伤 emoji 长消息');
  // 20001 个 emoji ⇒ 触发
  const h2 = harness();
  h2.st.projects = [makeProject(7)];
  assert.equal(await conv.routeText(b, '😀'.repeat(20001), CFG, h2.options),
    '消息过长（单条上限 20000 字）：请把长内容作为附件/文件发送，或拆成几条短消息再发');
  assert.deepEqual(h2.calls.submit, []);
});

test('routeText 分支 1：会话有效 ⇒ 直投，extra_meta 五键（含 baseline 与 family）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '项目甲' })];
  h.st.sessionExists = () => true;
  h.st.load = () => ({ total: 5 });
  const b = makeBinding({ cur_sid: 's1', cur_title: '标题一', cur_project_id: 7, default_project_id: 7 });
  const reply = await conv.routeText(b, '你好', CFG, h.options);
  assert.equal(reply, '已投递到「标题一」（执行中），跑完把答复发回这里');
  assert.equal(h.calls.submit.length, 1);
  const [pid, sid, text, opts] = h.calls.submit[0];
  assert.equal(pid, 7);
  assert.equal(sid, 's1');
  assert.equal(text, '你好');
  assert.equal(opts.family, 'dsh_plugin');
  assert.deepEqual(opts.extraMeta, {
    feishu: { open_id: 'ou_a', user_id: 1, project_id: 7, baseline: 5, title: '标题一' },
  }, '载荷是 {"feishu": {...}} 一层命名空间，五键');
  assert.equal(h.calls.db.some((c) => c[0] === 'setCurSession'), false, '直投分支不重写绑定');
  assert.equal(h.calls.db.some((c) => c[0] === 'clearCurSession'), false);
  // 顺序：baseline 先于 submit
  assert.ok(h.order.indexOf('load:0') < h.order.indexOf('submit'), 'baseline 必须在 submit 之前定格');
});

test('routeText：res.queued 用 Python 真值选「排队中/执行中」', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  h.st.sessionExists = () => true;
  h.st.submitRes = { id: 'm2', state: 'queued', queued: true };
  const b = makeBinding({ cur_sid: 's1', cur_title: 'T', cur_project_id: 7 });
  assert.equal(await conv.routeText(b, 'x', CFG, h.options), '已投递到「T」（排队中），跑完把答复发回这里');
  h.st.submitRes = { id: 'm3', state: 'queued', queued: 0 };
  assert.equal(await conv.routeText(b, 'x', CFG, h.options), '已投递到「T」（执行中），跑完把答复发回这里');
});

test('routeText 分支 1 失效（项目易主）⇒ 自动解绑 + STALE_NOTE 用 "\\n" 拼接（无项目档）', async () => {
  const h = harness();
  h.st.projects = [];                       // 项目 7 不在本人列表 ⇒ 失效
  const b = makeBinding({ cur_sid: 's1', cur_title: 'T', cur_project_id: 7 });
  const reply = await conv.routeText(b, '你好', CFG, h.options);
  assert.deepEqual(h.calls.db, [['clearCurSession', 'ou_a']], '失效 ⇒ 清绑定（且只清一次）');
  assert.deepEqual(h.calls.restCard, [], '无项目 ⇒ projects_card 为 None，绝不给一张空卡');
  assert.equal(reply, `${ORA.NO_DEFAULT_GUIDE}\n${ORA.STALE_NOTE}`);
  assert.deepEqual(h.calls.submit, []);
});

test('routeText 分支 2：会话失效后重建 ⇒ note 直贴（+note，**没有**换行）', async () => {
  const h = harness();
  h.st.projects = [makeProject(9)];
  h.st.load = () => ({ total: 2 });
  const b = makeBinding({ cur_sid: 's1', cur_title: 'T', cur_project_id: 7 });
  const reply = await conv.routeText(b, '你好', CFG, h.options);
  // 同一份 note 在 :125 是 `"\n" + note`、在 :148 是 `+ note` —— 两处形态不同，别「统一」
  assert.equal(reply, `已投递到「${conv._new_title(h.options)}」（执行中），跑完把答复发回这里${ORA.STALE_NOTE}`);
  assert.equal(reply.includes('这里\n'), false, '尾部分支不许插换行');
  assert.ok(h.calls.db.some((c) => c[0] === 'clearCurSession'));
});

test('routeText 分支 2：无会话 ⇒ 新建（驱动序列）+ 绑定写两次（幂等重申）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: 'P', model: 'deepseek/deepseek-flash', reasoning_effort: 'high', permission_mode: 'yolo' })];
  h.st.createSid = 's-new';
  h.st.load = () => ({ total: 0 });
  const b = makeBinding({ default_project_id: 7 });
  const reply = await conv.routeText(b, 'hi', CFG, h.options);
  assert.equal(reply, `已投递到「${conv._new_title(h.options)}」（执行中），跑完把答复发回这里`);
  // 驱动调用序列（含关键字实参口径：先 split_model，再 create_session(裸 id + provider)）
  assert.deepEqual(h.calls.driver[0], ['splitModel', 'deepseek/deepseek-flash']);
  assert.deepEqual(h.calls.driver[1],
    ['createSession', '/tmp/p7', conv._new_title(h.options), 'deepseek-flash', 'deepseek']);
  const ad = h.calls.driver.find((c) => c[0] === 'applySessionDefaults');
  assert.deepEqual(ad, ['applySessionDefaults', 's-new', 'deepseek-flash', 'deepseek', 'high', 'yolo', ad[6]]);
  assert.equal(typeof ad[6], 'function', '第 6 位是 log 回调（位置参数，不是关键字名）');
  assert.deepEqual(h.calls.driver.find((c) => c[0] === 'rename'), ['rename', 's-new', conv._new_title(h.options)]);
  // 绑定写两次：_create_in_project(:805) + route_text 重申(:132)
  const writes = h.calls.db.filter((c) => c[0] === 'setCurSession');
  assert.equal(writes.length, 2, '_create_in_project 一次 + route_text 幂等重申一次');
  assert.deepEqual(writes[0], ['setCurSession', 'ou_a', 7, 's-new', conv._new_title(h.options)]);
  assert.deepEqual(writes[1], writes[0]);
  assert.ok(h.order.indexOf('setCurSession') < h.order.indexOf('submit'), '建会话/写绑定先于投递');
});

test('routeText 分支 2：驱动不可用 ⇒ DRIVER_NEEDED（中文引导，不抛栈）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  h.st.driver.configured = false;
  const reply = await conv.routeText(makeBinding({ default_project_id: 7 }), 'hi', CFG, h.options);
  assert.equal(reply, ORA.DRIVER_NEEDED);
  assert.deepEqual(h.calls.driver.filter((c) => c[0] === 'createSession'), []);
});

test('routeText：新建失败（create_session 抛）⇒ "新建会话失败：{e}"（str 不是 repr，全角冒号）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  h.st.driver.createErr = new Error('驱动连接被拒');
  const reply = await conv.routeText(makeBinding({ default_project_id: 7 }), 'hi', CFG, h.options);
  assert.equal(reply, '新建会话失败：驱动连接被拒', '`{e}` 是 str(e) 口径：Error 取 message，不带类名前缀');
  assert.match(h.logText(), /feishu_conv: 新建会话失败 project=7: /, '日志走 _trace（stderr 口径）');
});

test('routeText：无项目且有卡 ⇒ 先发卡再回引导；卡片未被受理也照样回引导（:123 丢返回值）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  h.st.binding = makeBinding({ default_project_id: 0 });
  // 两个项目 + 未指定默认 ⇒ _locate_project 报「请指明项目…」
  h.st.projects = [makeProject(7, { name: '甲' }), makeProject(8, { name: '乙' })];
  const reply = await conv.routeText(h.st.binding, 'hi', CFG, h.options);
  assert.equal(reply, ORA.NO_DEFAULT_GUIDE);
  assert.equal(h.calls.restCard.length, 1, '无默认项目 ⇒ 发总览卡（点选即设默认）');
  assert.equal(h.calls.restCard[0][0], 'ou_a');
  assert.deepEqual(h.calls.submit, []);
  // 卡片没被受理（无凭据）：route_text 这一档**没有**文本兜底（与 conv_intent 的 projects 不同）
  const h2 = harness();
  h2.st.projects = [makeProject(7, { name: '甲' }), makeProject(8, { name: '乙' })];
  const reply2 = await conv.routeText(h2.st.binding, 'hi', null, h2.options);
  assert.equal(reply2, ORA.NO_DEFAULT_GUIDE);
  assert.deepEqual(h2.calls.restCard, [], '凭据缺失 ⇒ 连卡都不发（send_card 的凭据闸）');
  assert.match(h2.logText(), /feishu_conv: 卡片跳过（应用凭据缺失）open_id=ou_a/);
});

test('routeText：投递异常 ⇒ "投递失败：{e}" + note（note 带换行）+ _trace 一行', async () => {
  const h = harness();
  h.st.projects = [makeProject(9)];
  h.st.submitErr = new Error('队列坏了');
  const b = makeBinding({ cur_sid: 's1', cur_title: 'T', cur_project_id: 7 });
  const reply = await conv.routeText(b, 'hi', CFG, h.options);
  assert.equal(reply, `投递失败：队列坏了\n${ORA.STALE_NOTE}`);
  assert.match(h.logText(), /feishu_conv: 投递失败 sid=\S+: Error\('队列坏了'\)/,
    '日志是 {e!r} 口径（与用户可见文案的 str(e) 不同）');
});

test('routeText：没有 cur_title 时 title 回落 sid 前 12 位（切片是码点）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  h.st.sessionExists = () => true;
  const b = makeBinding({ cur_sid: 'abcdefghijklmnop', cur_title: '', cur_project_id: 7 });
  assert.equal(await conv.routeText(b, 'x', CFG, h.options), '已投递到「abcdefghijkl」（执行中），跑完把答复发回这里');
});

// --------------------------------------------------------------------------
// ④ conv_intent：六条意图 + 卡片即回执 + 未知动作兜底
// --------------------------------------------------------------------------

test('convIntent：current 回四行回执（默认项目 / 当前会话 / 绑定时间 / 所属项目）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  const b = makeBinding({
    cur_sid: 's1', cur_title: '标题', cur_project_id: 7, default_project_id: 7,
    cur_bound_at: '2026-10-15 05:00:00',
  });
  assert.equal(await conv.convIntent(b, 'current', [], 'ou_a', CFG, h.options),
    '默认项目：甲\n当前会话：标题（s1）\n绑定时间：2026-10-15 05:00:00\n所属项目：甲');
  // 未绑定会话：两行
  const h2 = harness();
  h2.st.projects = [];
  assert.equal(await conv.convIntent(makeBinding(), 'current', [], 'ou_a', CFG, h2.options),
    '默认项目：未设置\n当前会话：未绑定会话，发消息将自动新建');
});

test('convIntent：projects 卡片送达成功 ⇒ 空串（卡片即回执）；失败 ⇒ _projects_text 兜底', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' }), makeProject(8, { name: '乙' })];
  h.st.binding = makeBinding({ default_project_id: 7 });
  assert.equal(await conv.convIntent(h.st.binding, 'projects', [], 'ou_a', CFG, h.options), '');
  assert.equal(h.calls.restCard.length, 1);
  const card = h.calls.restCard[0][1];
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements.filter((e) => e.tag === 'select_static').length, 1, '唯一根级下拉');
  assert.deepEqual(card.body.elements.at(-1).behaviors,
    [{ type: 'callback', value: { t: 'dp', u: 1 } }], 'behaviors 在元素级，u 是 user_id');
  // 卡片没被受理 ⇒ 文本兜底（绝不静默）
  const h2 = harness();
  h2.st.projects = [makeProject(7, { name: '甲' }), makeProject(8, { name: '乙' })];
  h2.st.binding = makeBinding({ default_project_id: 7 });
  const text = await conv.convIntent(h2.st.binding, 'projects', [], 'ou_a', null, h2.options);
  assert.equal(text, '项目列表：\n· 甲 ✅默认\n· 乙\n' + ORA.PROJECTS_TEXT_HINT);
  // 没有任何项目 ⇒ 只回文案，不发空卡
  const h3 = harness();
  h3.st.projects = [];
  assert.equal(await conv.convIntent(h3.st.binding, 'projects', [], 'ou_a', CFG, h3.options),
    ORA.NO_PROJECTS_GUIDE);
  assert.deepEqual(h3.calls.restCard, []);
});

test('convIntent：sessions 卡片即回执；无默认项目 ⇒ NO_DEFAULT_GUIDE；失败 ⇒ _sessions_text', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  h.st.sessions = [makeSession('s1'), makeSession('s2')];
  const b = makeBinding({ default_project_id: 7 });
  assert.equal(await conv.convIntent(b, 'sessions', [], 'ou_a', CFG, h.options), '');
  const card = h.calls.restCard[0][1];
  assert.equal(card.header.template, 'blue', '会话列表卡是蓝色（总览卡 orange）');
  assert.deepEqual(card.body.elements.at(-1).behaviors,
    [{ type: 'callback', value: { t: 'ss', u: 1 } }]);
  const h2 = harness();
  h2.st.projects = [makeProject(7)];
  h2.st.sessions = [makeSession('s1')];
  assert.equal(await conv.convIntent(makeBinding({ default_project_id: 0 }), 'sessions', [], 'ou_a', CFG, h2.options),
    ORA.NO_DEFAULT_GUIDE);
  assert.deepEqual(h2.calls.restCard, []);
  const h3 = harness();
  h3.st.projects = [makeProject(7, { name: '甲' })];
  h3.st.sessions = [makeSession('s1')];
  const text = await conv.convIntent(makeBinding({ default_project_id: 7 }), 'sessions', [], 'ou_a', null, h3.options);
  assert.equal(text, `「甲」最近会话：\n1. S-s1（s1）\n${ORA.SESSIONS_TEXT_HINT}`);
});

test('convIntent：new 的标题取 groups[0]（None/空 ⇒ 缺省标题）；use/leave 分派', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  const b = makeBinding({ default_project_id: 7 });
  const reply = await conv.convIntent(b, 'new', ['  修登录  '], 'ou_a', CFG, h.options);
  assert.equal(reply, `已新建并绑定「修登录」（项目：甲），接下来发消息都进这个会话；它也会出现在看板（sync 卡，不占运行位）`);
  // groups 为 [None]（正则未匹配可选组）⇒ .strip() 兜住 ⇒ 缺省标题
  const h2 = harness();
  h2.st.projects = [makeProject(7, { name: '甲' })];
  const reply2 = await conv.convIntent(makeBinding({ default_project_id: 7 }), 'new', [null], 'ou_a', CFG, h2.options);
  assert.match(reply2, /^已新建并绑定「飞书对话 \d\d-\d\d \d\d:\d\d」（项目：甲）/);
  // leave（未绑定）
  const h3 = harness();
  assert.equal(await conv.convIntent(makeBinding(), 'leave', [], 'ou_a', CFG, h3.options), '当前未绑定会话');
  const h4 = harness();
  h4.st.projects = [makeProject(7, { name: '甲' })];
  h4.st.sessionExists = () => true;
  assert.equal(await conv.convIntent(makeBinding({ cur_sid: 's1', default_project_id: 7 }), 'leave', [], 'ou_a', CFG, h4.options),
    '已解绑当前会话（默认项目保持为「甲」），下次发消息将自动新建');
  assert.deepEqual(h4.calls.db, [['clearCurSession', 'ou_a']]);
});

test('convIntent：未知动作兜底回 feishu_inbound.js 的 HELP_TEXT（不静默、不留白）', async () => {
  const h = harness();
  const inbound = await import('../lib/feishu_inbound.js');
  assert.equal(await conv.convIntent(makeBinding(), 'no_such_action', [], 'ou_a', CFG, h.options),
    inbound.HELP_TEXT);
});

// --------------------------------------------------------------------------
// ⑤ on_card_action：两道归属复核 + 三类 toast
// --------------------------------------------------------------------------

test('onCardAction t=dp 成功：先 DM 完整回执，再返回轻量 toast（两者文案不同）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  const b = makeBinding({ open_id: 'ou_a', user_id: 1, default_project_id: 0 });
  const out = await conv.onCardAction('ou_a', b, { t: 'dp', u: 1 }, { option: '7' }, CFG, h.options);
  assert.deepEqual(out, { toast: { type: 'success', content: '已设为默认项目' } });
  assert.deepEqual(h.calls.db, [['setDefaultProject', 'ou_a', 7]], '写默认项目');
  assert.deepEqual(h.calls.restText, [['ou_a', '默认项目已设为「甲」', CFG]], 'DM 是完整回执');
  assert.ok(h.order.indexOf('setDefaultProject') < h.order.indexOf('restSendText'), '先写库再 DM');
});

test('onCardAction：防串号（value.u ≠ binding.user_id）⇒ 错误 toast 且不改任何状态', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  const out = await conv.onCardAction('ou_b', makeBinding({ user_id: 1 }), { t: 'dp', u: 2 }, { option: '7' }, CFG, h.options);
  assert.deepEqual(out, { toast: { type: 'error', content: '这张卡片不属于当前账号' } });
  assert.deepEqual(h.calls.db, []);
  assert.deepEqual(h.calls.restText, []);
});

test('onCardAction：项目不在本人列表 ⇒ 错误 toast（不改状态）；action.option 三种形态', async () => {
  const h = harness();
  h.st.projects = [makeProject(7)];
  const b = makeBinding({ user_id: 1 });
  assert.deepEqual(await conv.onCardAction('ou_a', b, { t: 'dp', u: 1 }, { option: '999' }, CFG, h.options),
    { toast: { type: 'error', content: '项目不在你的列表里' } });
  assert.deepEqual(h.calls.db, []);
  // option 是 list（取首个）/ 缺失（回落 value.i）/ 非数字（int() 失败 ⇒ 0 ⇒ 定位失败）
  const h2 = harness();
  h2.st.projects = [makeProject(7, { name: '甲' })];
  const b2 = makeBinding({ user_id: 1 });
  assert.equal((await conv.onCardAction('ou_a', b2, { t: 'dp', u: 1 }, { option: ['7'] }, CFG, h2.options)).toast.type, 'success');
  assert.equal((await conv.onCardAction('ou_a', b2, { t: 'dp', u: 1 }, { value: { i: '7' } }, CFG, h2.options)).toast.type, 'success');
  assert.deepEqual(await conv.onCardAction('ou_a', b2, { t: 'dp', u: 1 }, { option: [] }, CFG, h2.options),
    { toast: { type: 'error', content: '项目不在你的列表里' } }, '空列表 ⇒ "" ⇒ 0 ⇒ 定位失败');
  assert.deepEqual(await conv.onCardAction('ou_a', b2, { t: 'dp', u: 1 }, { option: '7.0' }, CFG, h2.options),
    { toast: { type: 'error', content: '项目不在你的列表里' } }, '"7.0" 不是 Python int 字面量');
  assert.equal(conv._selected_project_id({ option: ' 7 ' }), 7, 'int(str(raw).strip())');
  assert.equal(conv._selected_project_id({ option: '0x1' }), 0);
});

test('onCardAction t=ss：三档 toast（GONE / 失败 / 成功）+ 无条件 DM 完整回执', async () => {
  const b = makeBinding({ user_id: 1, cur_sid: '', default_project_id: 7 });
  // 成功档
  const ok = harness();
  ok.st.projects = [makeProject(7, { name: '甲' })];
  ok.st.sessions = [makeSession('s1', { title: '标题一' })];
  const out1 = await conv.onCardAction('ou_a', b, { t: 'ss', u: 1 }, { option: 's1' }, CFG, ok.options);
  assert.deepEqual(out1, { toast: { type: 'success', content: '已绑定该会话' } });
  assert.deepEqual(ok.calls.restText, [['ou_a', '已绑定「标题一」（项目：甲），接下来发消息都进这个会话', CFG]]);
  assert.deepEqual(ok.calls.db, [['setCurSession', 'ou_a', 7, 's1', '标题一']]);
  // SESSION_GONE：会话不在本项目桶内
  const gone = harness();
  gone.st.projects = [makeProject(7)];
  gone.st.sessions = [makeSession('other')];
  const out2 = await conv.onCardAction('ou_a', b, { t: 'ss', u: 1 }, { option: 's1' }, CFG, gone.options);
  assert.deepEqual(out2, { toast: { type: 'error', content: '会话已不存在，发「会话」刷新列表' } });
  assert.deepEqual(gone.calls.restText, [['ou_a', ORA.SESSION_GONE, CFG]], '失败也 DM（完整回执）');
  assert.deepEqual(gone.calls.db, [], '复验不过一个字都不写');
  // 「绑定失败」档：项目缺失 ⇒ NO_DEFAULT_GUIDE 命中 SESSION_FAIL_TEXTS（SESSION_GONE 已被上一支吃掉）
  const noProj = harness();
  noProj.st.projects = [];
  const out3 = await conv.onCardAction('ou_a', b, { t: 'ss', u: 1 }, { option: 's1' }, CFG, noProj.options);
  assert.deepEqual(out3, { toast: { type: 'error', content: '绑定失败' } });
  assert.deepEqual(noProj.calls.restText, [['ou_a', ORA.NO_DEFAULT_GUIDE, CFG]]);
  // 没取到 sid
  const empty = harness();
  empty.st.projects = [makeProject(7)];
  assert.deepEqual(await conv.onCardAction('ou_a', b, { t: 'ss', u: 1 }, {}, CFG, empty.options),
    { toast: { type: 'error', content: '没有取到要绑定的会话' } });
  assert.deepEqual(empty.calls.restText, [], '取不到 sid ⇒ 不 DM');
  // 未知 t ⇒ None（交给飞书兜底，不更新卡片）
  assert.equal(await conv.onCardAction('ou_a', b, { t: 'zz', u: 1 }, {}, CFG, empty.options), null);
  // DM 的凭据闸：cfg 为假值 ⇒ 现取 app_config(user_id)；取不到 ⇒ 只留痕，绝不打网络
  const nocreds = harness();
  nocreds.st.projects = [makeProject(7, { name: '甲' })];
  nocreds.st.sessions = [makeSession('s1')];
  nocreds.st.appCfg = null;
  await conv.onCardAction('ou_a', b, { t: 'ss', u: 1 }, { option: 's1' }, null, nocreds.options);
  assert.deepEqual(nocreds.calls.restText, []);
  assert.match(nocreds.logText(), /feishu_conv: DM 跳过（应用凭据缺失）open_id=ou_a/);
});

// --------------------------------------------------------------------------
// ⑥ set_default_project / project_by_id
// --------------------------------------------------------------------------

test('setDefaultProject：同项目保留会话绑定（不写 clear、不追加 UNBIND_NOTE）', async () => {
  const h = harness();
  const b = makeBinding({ cur_sid: 's1', cur_project_id: 7, default_project_id: 7 });
  const reply = await conv.setDefaultProject(b, makeProject(7, { name: '甲' }), h.options);
  assert.equal(reply, '默认项目已设为「甲」');
  assert.deepEqual(h.calls.db, [['setDefaultProject', 'ou_a', 7]], '无条件写（同项目也写）');
});

test('setDefaultProject：跨项目 ⇒ 自动解绑 + "\\n" + UNBIND_NOTE；未绑定会话则不追加', async () => {
  const h = harness();
  const b = makeBinding({ cur_sid: 's1', cur_project_id: 7, default_project_id: 7 });
  const reply = await conv.setDefaultProject(b, makeProject(8, { name: '乙' }), h.options);
  assert.equal(reply, `默认项目已设为「乙」\n${ORA.UNBIND_NOTE}`);
  assert.deepEqual(h.calls.db, [['setDefaultProject', 'ou_a', 8], ['clearCurSession', 'ou_a']]);
  const h2 = harness();
  const reply2 = await conv.setDefaultProject(makeBinding({ cur_project_id: 7 }), makeProject(8, { name: '乙' }), h2.options);
  assert.equal(reply2, '默认项目已设为「乙」');
  assert.deepEqual(h2.calls.db, [['setDefaultProject', 'ou_a', 8]]);
});

test('setDefaultProject：换项目作废「会话列表卡」序号记忆；同项目保留', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' }), makeProject(8, { name: '乙' })];
  h.st.sessions = [makeSession('s1'), makeSession('s2')];
  const b = makeBinding({ default_project_id: 7 });
  // 先拿一张列表卡（登记 _LAST_LIST）
  await conv.convIntent(b, 'sessions', [], 'ou_a', CFG, h.options);
  // 同项目重复设置 ⇒ 记忆保留 ⇒ 「绑定会话 1」仍可绑
  await conv.setDefaultProject(b, makeProject(7, { name: '甲' }), h.options);
  assert.match(await conv.convIntent(b, 'use', ['1'], 'ou_a', CFG, h.options), /^已绑定「/);
  // 换项目 ⇒ 记忆作废 ⇒ 序号越界回 SESSION_STALE
  await conv.setDefaultProject(b, makeProject(8, { name: '乙' }), h.options);
  assert.equal(await conv.convIntent(b, 'use', ['1'], 'ou_a', CFG, h.options), ORA.SESSION_STALE);
});

test('projectById：只认本人项目；非数字/不存在 ⇒ null（异常吞成 None）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  const b = makeBinding({ user_id: 1 });
  assert.equal((await conv.projectById(b, 7, h.options)).name, '甲');
  assert.equal(await conv.projectById(b, '7', h.options) !== null, true, 'int("7") 命中');
  assert.equal(await conv.projectById(b, '7.0', h.options), null);
  assert.equal(await conv.projectById(b, 'abc', h.options), null);
  assert.equal(await conv.projectById(b, null, h.options), null);
  assert.equal(await conv.projectById(b, 999, h.options), null);
  // 跨运行时边角（契约清单 §7-U3/U4）：Python 的 int()/isdigit() 认 Unicode 数字，
  // 本模块的 `pyIntStrict`/`pyIsDigit` 逐条对齐 CPython（`Number()`/`/^\d+$/` 都会分叉）
  h.st.projects = [makeProject(12, { name: '十二' })];
  assert.equal((await conv.projectById(b, '١٢', h.options)).name, '十二', 'int("١٢") == 12');
  assert.equal(conv._selected_project_id({ option: '١٢' }), 12);
  // `"²"`：isdigit 真 ⇒ 走序号分支 ⇒ int("²") 抛 ValueError（oracle 由 execute_intent 兜成
  // 「指令执行失败，请稍后重试」，这里钉住抛点与异常名）
  assert.throws(() => conv._use_by_token(b, '²', h.options), (e) => e.pyName === 'ValueError');
});

// --------------------------------------------------------------------------
// ⑦ _Card 别名与体积闸
// --------------------------------------------------------------------------

test('_Card：elements 是读口别名且**不可枚举**（序列化里没有顶层 elements）', () => {
  const els = [{ tag: 'markdown', content: 'x' }];
  const card = conv._card({ template: 'blue' }, els);
  assert.equal(card.elements, els);
  assert.equal(card.body.elements, els);
  assert.deepEqual(Object.keys(card), ['schema', 'header', 'body'], '真实键只有三个（键序即字节序）');
  const text = pyJsonDumps(card);
  assert.equal(text.includes('"elements":[') && text.indexOf('"elements"') < text.indexOf('"body"'),
    false, '发出去的 JSON 不许有顶层 elements（体积翻倍 + 未知字段）');
  assert.equal(text, pyJsonDumps({ schema: '2.0', header: { template: 'blue' }, body: { elements: els } }));
  assert.equal(JSON.parse(text).body.elements.length, 1);
});

test('_card_bytes：与 rest_send_card 同一序列化口径（pyJsonDumps 字节数，不是 JSON.stringify）', () => {
  const card = conv._card({ title: { tag: 'plain_text', content: '会话列表（默认：甲）' }, template: 'blue' },
    [{ tag: 'markdown', content: '**1. 标题** · 刚刚' }]);
  assert.equal(conv._card_bytes(card), CARD_BYTES(card));
  assert.equal(conv._card_bytes(card), Buffer.byteLength(pyJsonDumps(card), 'utf8'));
  assert.notEqual(conv._card_bytes(card), Buffer.byteLength(JSON.stringify(card), 'utf8'),
    'JSON.stringify 少算 ", " 分隔符 ⇒ 体积闸会在临界卡上分叉');
});

test('projectsCard 三道体积闸：超 8000 ⇒ 先删计数行，再收缩条数（绝不发超限卡）', async () => {
  const h = harness();
  h.st.projects = Array.from({ length: 20 }, (_, i) => makeProject(i + 1, { name: `${i + 1}`.padEnd(200, '名') }));
  h.st.counts = Object.fromEntries(h.st.projects.map((p) => [p.id, { doing: 1, blocked: 2, review: 3 }]));
  h.st.binding = makeBinding({ default_project_id: 1, cur_sid: 's1', cur_project_id: 1 });
  const card = await conv._projects_card(h.st.binding, h.options);
  assert.ok(CARD_BYTES(card) <= conv.CARD_MAX_BYTES, `降级后仍超限：${CARD_BYTES(card)}`);
  const marks = card.body.elements.filter((e) => e.tag === 'markdown');
  const listed = marks.filter((m) => /^\*\*\d+名+/.test(m.content)).length;
  assert.ok(listed < 20, `必须收缩条数（实际列出 ${listed} 条）`);
  assert.equal(card.body.elements.filter((e) => e.tag === 'select_static').length, 1);
  const opts = card.body.elements.at(-1).options;
  assert.equal(opts.length, listed, '下拉项与列出的项目严格同序同数');
  assert.equal(marks.some((m) => m.content.includes('任务 运行')), false, '降级 ② 之后不再恢复计数行');
  assert.equal(marks.some((m) => m.content.startsWith('另有 ')), listed < 20,
    '「另有」行只在没列全时出现（降级后必然出现）');
  // 逐字：`PROJECTS_MORE_FMT % extra`（oracle `"另有 %d 个项目，回复「默认项目 <项目名>」精确设置"`）
  const more = marks.find((m) => m.content.startsWith('另有 '));
  assert.equal(more.content, `另有 ${20 - listed} 个项目，回复「默认项目 <项目名>」精确设置`);
  assert.equal(marks[0].content.startsWith('**1'), true, '默认项目置顶');
  assert.equal(opts[0].value, '1', '下拉首项是默认项目（排序与标记一致）');
});

test('sessionsCard：零会话也登记空表（卡上无控件）；体积降级后登记条数与卡上条数一致', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  h.st.sessions = [];
  conv._LAST_LIST.clear();
  const card = await conv._sessions_card(makeBinding({ open_id: 'ou_z', default_project_id: 7 }), h.options);
  assert.equal(card.body.elements.length, 1);
  assert.equal(card.body.elements[0].content, ORA.SESSION_EMPTY);
  assert.deepEqual(conv._LAST_LIST.get('ou_z')[1], [], '空列表也登记（序号必然越界）');
  // 超长标题 10 条 ⇒ 体积降级，登记条数必须跟着收缩（防序号错位）
  const h2 = harness();
  h2.st.projects = [makeProject(7, { name: '甲' })];
  h2.st.sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s${i}`, { title: '标'.repeat(60) }));
  conv._LAST_LIST.clear();
  const card2 = await conv._sessions_card(makeBinding({ open_id: 'ou_y', default_project_id: 7 }), h2.options);
  assert.ok(CARD_BYTES(card2) <= conv.CARD_MAX_BYTES);
  const rows = card2.body.elements.filter((e) => e.tag === 'markdown').length;
  assert.equal(conv._LAST_LIST.get('ou_y')[1].length, rows, '登记条数 = 卡上条数');
});

test('_session_row / _rel_time / _session_name：状态标顺序 · 相对时间分档 · 名称 fallback', () => {
  // _rel_time：脏值/未来/0 ⇒ 刚刚；分档用 int(delta // N)
  assert.equal(conv._rel_time(null), '刚刚');
  assert.equal(conv._rel_time('abc'), '刚刚');
  assert.equal(conv._rel_time(0), '刚刚');
  assert.equal(conv._rel_time(-5), '刚刚');
  const now = Math.floor(Date.now() / 1000);
  assert.equal(conv._rel_time(now + 100), '刚刚', '未来时间 ⇒ 刚刚');
  assert.equal(conv._rel_time(now - 90), '1 分钟前');
  assert.equal(conv._rel_time(now - 7200), '2 小时前');
  assert.equal(conv._rel_time(now - 3 * 86400), '3 天前');
  // _session_name fallback 链
  assert.equal(conv._session_name({ title: '  标题  ' }), '标题');
  assert.equal(conv._session_name({ title: '', first_prompt: '首问\n第二行' }), '首问');
  assert.equal(conv._session_name({ title: '', first_prompt: '', sid: 'abcdefghijklmnop' }), 'abcdefghijkl');
  assert.equal(conv._session_name({ title: 'x'.repeat(80) }).length, 60);
  // _session_row：标记顺序 🏃 运行中 → 📦 已归档 → ✅ 当前，无标记时整段为空
  const h = harness();
  h.st.busy = { s1: { status: 'running' } };
  const row = conv._session_row(3, { sid: 's1', title: '甲', mtime: now - 10, archived: 1 }, 's1', h.options);
  assert.equal(row.tag, 'markdown');
  assert.equal(row.content, '**3. 甲** · 刚刚 · 🏃 运行中 📦 已归档 ✅ 当前');
  const plain = conv._session_row(1, { sid: 's9', title: '乙', mtime: now - 10 }, 's1', h.options);
  assert.equal(plain.content, '**1. 乙** · 刚刚');
});

// --------------------------------------------------------------------------
// ⑧ 文本兜底与 use_by_token 三分支
// --------------------------------------------------------------------------

test('_sessions_text：序号取自 _LAST_LIST（与卡片严格同序）', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  h.st.sessions = [makeSession('s1', { title: '一' }), makeSession('s2', { title: '二' })];
  conv._LAST_LIST.clear();
  await conv.convIntent(makeBinding({ open_id: 'ou_t', default_project_id: 7 }), 'sessions', [], 'ou_a', CFG, h.options);
  const text = await conv._sessions_text(makeBinding({ open_id: 'ou_t', default_project_id: 7 }), h.options);
  assert.equal(text, `「甲」最近会话：\n1. 一（s1）\n2. 二（s2）\n${ORA.SESSIONS_TEXT_HINT}`);
  // 记忆缺失 ⇒ 现取一份
  conv._LAST_LIST.clear();
  const text2 = await conv._sessions_text(makeBinding({ open_id: 'ou_t', default_project_id: 7 }), h.options);
  assert.equal(text2, text);
});

test('useByToken：空 token ⇒ SESSION_STALE（不是「绑第 1 条」）；过期/越界同样回引导', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  h.st.sessions = [makeSession('s1')];
  const b = makeBinding({ default_project_id: 7 });
  assert.equal(await conv._use_by_token(b, '', h.options), ORA.SESSION_STALE);
  assert.equal(await conv._use_by_token(b, '1', h.options), ORA.SESSION_STALE, '没有列表记忆 ⇒ 越界');
  // 登记后可用；TTL 过期（>1800 严格大于）失效
  conv._LAST_LIST.clear();
  h.st.now = 1000;
  conv._remember_list('ou_a', ['s1'], h.options);
  assert.match(await conv._use_by_token(b, '1', h.options), /^已绑定「/);
  h.st.now = 1000 + 1800;
  assert.match(await conv._use_by_token(b, '1', h.options), /^已绑定「/, '恰等于 TTL 不算过期（> 才过期）');
  h.st.now = 1000 + 1801;
  assert.equal(await conv._use_by_token(b, '1', h.options), ORA.SESSION_STALE);
  conv._LAST_LIST.clear();
});

test('useByToken：标题包含唯一命中 ⇒ 绑定；多命中 ⇒ 候选最多 8 条；都不中 ⇒ 提示', async () => {
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' })];
  h.st.sessions = [
    makeSession('s1', { title: '修登录 bug' }),
    makeSession('s2', { title: '修登录 页' }),
    makeSession('s3', { title: '别的' }),
  ];
  const b = makeBinding({ default_project_id: 7 });
  assert.equal(await conv._use_by_token(b, '别的', h.options), '已绑定「别的」（项目：甲），接下来发消息都进这个会话');
  assert.equal(await conv._use_by_token(b, '修登录', h.options),
    '「修登录」匹配到多个会话，回复更精确的关键字：\n· 修登录 bug（s1）\n· 修登录 页（s2）');
  assert.equal(await conv._use_by_token(b, 's2', h.options), '已绑定「修登录 页」（项目：甲），接下来发消息都进这个会话',
    'sid 前缀唯一命中（startswith 不是 in）');
  assert.equal(await conv._use_by_token(b, 'zzz', h.options), '没找到匹配「zzz」的会话，发「会话」看最近 10 条');
});

// --------------------------------------------------------------------------
// ⑨ 答复回流：start() 注册 + notify_msg_done 三态
// --------------------------------------------------------------------------

test('start()：真注册 chat.setMsgDoneHook（幂等，重复调用等价于再注册同一个函数）', () => {
  const h = harness();
  conv.start(h.options);
  assert.equal(h.calls.hook.length, 1);
  assert.equal(typeof h.st.hook, 'function');
  conv.start(h.options);
  assert.equal(h.calls.hook.length, 2, '幂等 = 再注册一次（单一注册位，不叠加）');
  assert.equal(typeof h.st.hook, 'function');
});

test('notifyMsgDone：非飞书来源 / 无 open_id / 绑定已变更 ⇒ 一律不推', async () => {
  const h = harness();
  h.st.msgMeta = {};
  await conv._notify_msg_done('m1', 'done', h.options);
  assert.deepEqual(h.calls.restText, []);
  // 有 feishu 载荷但 open_id 空
  const h2 = harness();
  h2.st.msgMeta = { feishu: { open_id: '', user_id: 1 } };
  await conv._notify_msg_done('m1', 'done', h2.options);
  assert.deepEqual(h2.calls.restText, []);
  // 绑定已变更（库里的 user_id 与载荷不一致）
  const h3 = harness();
  h3.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 2, baseline: 0 } };
  h3.st.binding = makeBinding({ open_id: 'ou_a', user_id: 1 });
  await conv._notify_msg_done('m1', 'done', h3.options);
  assert.deepEqual(h3.calls.restText, []);
  assert.match(h3.logText(), /feishu_conv: 答复跳过（绑定已变更）open_id=ou_a/);
  // 无绑定行
  const h4 = harness();
  h4.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1 } };
  h4.st.binding = null;
  await conv._notify_msg_done('m1', 'done', h4.options);
  assert.deepEqual(h4.calls.restText, []);
});

test('notifyMsgDone：yielded 只打 stdout 一行（前缀 [feishu_conv] ，与 _trace 的 stderr 前缀不同）', async () => {
  const h = harness();
  h.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1, baseline: 0 } };
  h.st.binding = makeBinding();
  const lines = [];
  const orig = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await conv._notify_msg_done('m9', 'yielded', h.options);
  } finally { console.log = orig; }
  assert.deepEqual(lines, ['[feishu_conv] 会话挂起等作答，不推答复：m9']);
  assert.deepEqual(h.calls.restText, []);
});

test('notifyMsgDone：error 推失败回执（error 摘要截 200 + 未知原因兜底）', async () => {
  const h = harness();
  h.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1 } };
  h.st.binding = makeBinding();
  h.st.msgGet = { error: 'E'.repeat(300) };
  await conv._notify_msg_done('m1', 'error', h.options);
  assert.equal(h.calls.restText.length, 1);
  assert.equal(h.calls.restText[0][1], `本轮执行失败：${'E'.repeat(200)}（可在站点会话窗查看详情）`);
  // 空 error ⇒ 「未知原因」；行不存在同样是「未知原因」
  const h2 = harness();
  h2.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1 } };
  h2.st.binding = makeBinding();
  h2.st.msgGet = { error: '' };
  await conv._notify_msg_done('m1', 'error', h2.options);
  assert.equal(h2.calls.restText[0][1], '本轮执行失败：未知原因（可在站点会话窗查看详情）');
  const h3 = harness();
  h3.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1 } };
  h3.st.binding = makeBinding();
  h3.st.msgGet = null;
  await conv._notify_msg_done('m1', 'error', h3.options);
  assert.equal(h3.calls.restText[0][1], '本轮执行失败：未知原因（可在站点会话窗查看详情）');
});

test('notifyMsgDone：done 抽 baseline 之后的新增 assistant 文本（双换行连接、空白段丢弃）', async () => {
  const h = harness();
  h.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1, baseline: 4 } };
  h.st.binding = makeBinding();
  h.st.msgGet = { sid: 's1' };
  let seenAfter = null;
  h.st.load = (family, sid, agent, after) => {
    seenAfter = after;
    return {
      found: true,
      entries: [
        { kind: 'user', text: '问题' },
        { kind: 'think', text: '草稿' },
        { kind: 'assistant', text: '答复一' },
        { kind: 'tool_call', text: '工具' },
        { kind: 'assistant', text: '   ' },
        { kind: 'assistant', text: '答复二' },
      ],
    };
  };
  await conv._notify_msg_done('m1', 'done', h.options);
  assert.equal(seenAfter, 4, 'after=baseline（只取本轮新增）');
  assert.deepEqual(h.calls.restText, [['ou_a', '答复一\n\n答复二', CFG]], 'cfg=None ⇒ _dm 现取 app_config');
  // found=false 或异常 ⇒ 不推空消息
  const h2 = harness();
  h2.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1, baseline: 0 } };
  h2.st.binding = makeBinding();
  h2.st.msgGet = { sid: 's1' };
  h2.st.load = () => ({ found: false, entries: [] });
  await conv._notify_msg_done('m1', 'done', h2.options);
  assert.deepEqual(h2.calls.restText, [], '空答复不发 DM');
});

test('_clip_reply：3000 码点闸（含等号）与固定后缀', () => {
  assert.equal(conv._clip_reply(' 短 '), '短', '先 strip');
  const exact = 'a'.repeat(3000);
  assert.equal(conv._clip_reply(exact), exact, '恰等于 3000 不截断');
  const long = 'a'.repeat(3001);
  const clipped = conv._clip_reply(long);
  assert.equal(clipped, 'a'.repeat(2800) + '\n……（内容过长已截断，完整内容见站点会话窗 / 看板）');
  assert.equal(Array.from(clipped).length, 2800 + 28, 'oracle `len(后缀)` = 28');
  // 码点切片：emoji 不会被切半个
  const emoji = '😀'.repeat(3001);
  assert.equal(conv._clip_reply(emoji).startsWith('😀'.repeat(2800)), true);
  assert.equal(conv._clip_reply(emoji).includes('\uFFFD'), false);
});

test('_new_title：本地时间 "飞书对话 MM-DD HH:MM"（零填充、24 小时制）', () => {
  const instant = Date.UTC(2026, 0, 5, 3, 7, 0) / 1000;   // 本地时区换算后仍是单数字月/日/时/分
  const h = harness();
  h.st.now = instant;
  const got = conv._new_title(h.options);
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(instant * 1000)).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  assert.equal(got, `飞书对话 ${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`);
  assert.match(got, /^飞书对话 \d\d-\d\d \d\d:\d\d$/);
  assert.equal(conv.TITLE_FMT, ORA.TITLE_FMT);
});

// --------------------------------------------------------------------------
// ⑩ 三条接线缝（行为断言：注入后真到目标函数）
// --------------------------------------------------------------------------

test('真模块冒烟：真 db.js/waitq.js/sessparse.js/chat.js 全链（签名错位当场红）', async () => {
  const fx = freshDb('r3-real');
  try {
    const pid = insertProject(fx.db, { userId: 1, name: '甲', projectDir: fx.dir, workDir: fx.dir });
    db.setFeishuBinding('ou_real', 1, pid, { db: fx.db });
    insertTask(fx.db, pid, { name: 'T', status: 'queued' });
    insertCard(fx.db, pid, { title: 'C', columnKey: 'todo' });
    insertWait(fx.db, { projectId: pid, kind: 'card', targetId: 1, state: 'running', seq: 1 });
    const binding = db.getFeishuBindingByOpen('ou_real', { db: fx.db });
    const sent = [];
    const rest = {
      restSendCard: async (openId, card, cfg) => { sent.push(['card', openId, card]); },
      restSendText: async (openId, text, cfg) => { sent.push(['text', openId, text]); },
    };
    const options = { db: fx.db, rest, log: () => {}, env: {} };
    // ① 长度闸走**真 chat.js** 的 MESSAGE_MAX（20000）
    assert.equal(await conv.routeText(binding, 'x'.repeat(20001), null, options),
      '消息过长（单条上限 20000 字）：请把长内容作为附件/文件发送，或拆成几条短消息再发');
    // ② current：真 db.listProjects（binding["default_project_id"] → 真行）
    assert.equal(await conv.convIntent(binding, 'current', [], 'ou_real', null, options),
      '默认项目：甲\n当前会话：未绑定会话，发消息将自动新建');
    // ③a 无凭据 ⇒ 卡片发不出 ⇒ 文本兜底（绝不静默；这一档不读计数）
    assert.equal(await conv.convIntent(binding, 'projects', [], 'ou_real', null, options),
      `项目列表：\n· 甲 ✅默认\n${ORA.PROJECTS_TEXT_HINT}`);
    assert.deepEqual(sent, []);
    // ③b projects：真 listTasks + 真 boardCountsMany + 真 listBoardCards + 真 waitq.activeItems
    assert.equal(await conv.convIntent(binding, 'projects', [], 'ou_real', CFG, options), '');
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'card');
    const content = sent[0][2].body.elements[0].content;
    assert.equal(content, '**甲** ✅\n任务 运行 0/排队 1 · 看板 待开发 1/开发中 0/阻塞 0'
      + '/待审核 0/已完成 0 · 队列 卡 1/消息 0/作答 0/外部 0');
    // ④ sessions：真 sessparse.list_sessions（空项目目录 ⇒ 零会话卡 + 空表登记）
    sent.length = 0;
    assert.equal(await conv.convIntent(binding, 'sessions', [], 'ou_real', CFG, options), '');
    assert.equal(sent[0][2].body.elements[0].content, ORA.SESSION_EMPTY);
    // ⑤ notifyMsgDone：真 waitq.msgMeta/msgGet + 真 db.getFeishuBindingByOpen（回流全链）
    insertMsg(fx.db, { id: 'm_real', projectId: pid, sid: 'sid-real', state: 'done' });
    insertWait(fx.db, {
      projectId: pid, kind: 'msg', targetId: 'm_real', state: 'done', seq: 2,
      meta: JSON.stringify({ feishu: { open_id: 'ou_real', user_id: 1, baseline: 0 } }),
    });
    sent.length = 0;
    await conv.notifyMsgDone('m_real', 'done', {
      db: fx.db,
      rest,
      log: () => {},
      sessparse: { load: () => ({ found: true, entries: [{ kind: 'assistant', text: '真答复' }] }) },
      feishu: { appConfig: () => CFG },
    });
    assert.deepEqual(sent, [['text', 'ou_real', '真答复']]);
  } finally {
    fx.close();
  }
});

test('缝①-D1：review 路径真到 cardReview(3 位)、block 路径真到 cardBlocked(4 位)、都不注入时静默跳过', async () => {
  const fx = freshDb('r3-seam-d1');
  const logPath = path.join(fx.dir, 'board.log');
  fs.writeFileSync(logPath, '');
  const prev = board.boardHooks();
  try {
    board.setBoardHooks({ enterDoing: board.enterDoing, stopCard: board.stopCard, finish: board.finish });
    const pid = insertProject(fx.db, { name: 'P', projectDir: fx.dir, workDir: fx.dir });
    const opts = { db: fx.db };
    const seen = [];
    // (c) 两个钩子都不注册：两条分支都必须**静默跳过且不抛**（缺省降级与今天一致）
    const cid0 = insertCard(fx.db, pid, { title: 'C0', columnKey: 'doing', sessionId: 'sid-0', sessions: '["sid-0"]' });
    assert.doesNotThrow(() => board.finishRun(cid0, {
      proc: null, sid: 'sid-1', family: 'dsh_plugin', project_dir: fx.dir, started_at: Date.now(),
      seen_busy: true, aborted: false, turn_baseline: null, log_path: logPath,
    }, '会话结束收尾', opts));
    // (a) review 路径：3 位 (card.project_id, card, options)
    board.setBoardHooks({
      feishuCardReview: (projectId, card, options) => seen.push(['review', projectId, card.id, options]),
      feishuCardBlocked: (projectId, card, interaction, options) =>
        seen.push(['blocked', projectId, card.id, interaction && interaction.text, options]),
    });
    const cid1 = insertCard(fx.db, pid, { title: 'C1', columnKey: 'doing', sessionId: 'sid-a', sessions: '["sid-a"]' });
    board.finishRun(cid1, {
      proc: null, sid: 'sid-b', family: 'dsh_plugin', project_dir: fx.dir, started_at: Date.now(),
      seen_busy: true, aborted: false, turn_baseline: null, log_path: logPath,
    }, '会话结束收尾', opts);
    assert.equal(seen.length, 1, `review 路径必须真到注入的钩子（实际 ${JSON.stringify(seen)}）`);
    assert.deepEqual(seen[0], ['review', pid, cid1, opts]);
    // (b) block 路径：4 位 (card.project_id, card, interaction, options)
    seen.length = 0;
    const cid2 = insertCard(fx.db, pid, { title: 'C2', columnKey: 'doing', sessionId: '', sessions: '[]' });
    const card2 = db.getBoardCard(cid2, opts);
    await board.iwApply('dsh_plugin', card2, 'block', { pending: true, busy: true, text: '问?' }, opts);
    assert.equal(seen.length, 1, `block 路径必须真到 feishuCardBlocked（实际 ${JSON.stringify(seen)}）`);
    assert.deepEqual(seen[0], ['blocked', pid, cid2, '问?', opts]);
  } finally {
    // 复原钩子表（`feishuCardBlocked` 是 D1 新增的键；旧快照里没有它）
    board.setBoardHooks({ feishuCardReview: prev.feishuCardReview || null });
    if ('feishuCardBlocked' in board.boardHooks()) board.setBoardHooks({ feishuCardBlocked: null });
    fx.close();
  }
});

test('缝②：runner.setFailureNotifier 6 位**位置参数**直通 feishu.taskFailed（skipped_n 不许落 options 位）', async () => {
  const fx = freshDb('r3-seam-fail');
  try {
    const pid = insertProject(fx.db, { name: 'P', projectDir: fx.dir, workDir: fx.dir });
    const tid = insertTask(fx.db, pid, { name: '任务N', taskType: 'normal' });
    // 真接线形态（= server.js 的注册表达式）：6 位位置参数直通
    const seen = [];
    const feishuStub = { taskFailed: (...a) => { seen.push(a); return feishu.taskFailed(...a); } };
    runner.setFailureNotifier((projectId, taskId, taskName, taskType, error, skippedN) =>
      feishuStub.taskFailed(projectId, taskId, taskName, taskType, error, skippedN));
    // 钩子行（默认事件含 task_failed）⇒ 端到端能看到「第 6 位到了载荷里」
    fx.db.prepare('INSERT INTO feishu_hooks(project_id, webhook_url, webhook_secret, events, enabled)'
      + ' VALUES(?,?,?,?,?)').run(pid, 'http://127.0.0.1:9/hook', '', 'task_failed', 1);
    await runner.notifyTaskFailed(tid, '炸了', 3, { db: fx.db });
    assert.deepEqual(seen, [[pid, tid, '任务N', 'normal', '炸了', 3]]);
    const rows = fx.db.prepare('SELECT payload, dedup_key FROM feishu_outbox').all();
    assert.equal(rows.length, 1, '推送真落 outbox（证明注册表达式可用）');
    assert.equal(rows[0].dedup_key, `task_failed:${pid}:${tid}`);
    assert.match(rows[0].payload, /pipeline 后段 3 条已连带跳过/,
      'skippedN 必须在第 6 位（若落 options 位，skipped_n 会是 undefined，这行就不存在）');
    assert.match(rows[0].payload, /炸了/);
    // 未接线 ⇒ 静默返回（照 except: pass）
    runner.setFailureNotifier(null);
    await runner.notifyTaskFailed(tid, '再炸一次', 0, { db: fx.db });
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM feishu_outbox').get().n, 1);
  } finally {
    runner.setFailureNotifier(null);
    fx.close();
  }
});

test('接线：R2 的惰性转发器经 6 个名字真调进本模块（名字/位置参数签错一位就断链）', async () => {
  const inbound = await import('../lib/feishu_inbound.js');
  const h = harness();
  h.st.projects = [makeProject(7, { name: '甲' }), makeProject(8, { name: '乙' })];
  h.st.sessionExists = () => true;
  h.st.load = () => ({ total: 2 });
  h.st.binding = makeBinding({
    open_id: 'ou_a', user_id: 1, cur_sid: 's1', cur_title: 'T',
    cur_project_id: 7, default_project_id: 7,
  });
  const replies = [];
  const options = {
    ...h.options,
    rest: {
      restReply: async (mid, text, cfg) => { replies.push([mid, text]); },
      botOpenId: async () => '',
    },
    conv: undefined,      // ★ 故意不注入：走 feishu_inbound.js 的**真**惰性转发器
  };
  // ① enabled + routeText（单聊未识别文本的转交点，feishu.py:1849-1851）
  await inbound.handleMessageEvent({
    message_id: 'om_r3_1', chat_type: 'p2p', message_type: 'text',
    content: JSON.stringify({ text: '随便说点什么' }), sender_open_id: 'ou_a', mentions: [],
  }, null, options);
  assert.deepEqual(replies, [['om_r3_1', '已投递到「T」（执行中），跑完把答复发回这里']],
    '转发器没接上时这里会是 []（R2 把异常吞进日志）');
  assert.equal(h.calls.submit.length, 1);
  assert.equal(h.calls.submit[0][3].extraMeta.feishu.baseline, 2);
  // ② convIntent（execute_intent 的六条白名单）
  assert.equal(await inbound.executeIntent(h.st.binding, { action: 'current', groups: [] }, 'ou_a', null, options),
    '默认项目：甲\n当前会话：T（s1）\n所属项目：甲');
  // ③ setDefaultProject + ④ projectById（`_set_default_project` 的两条路）
  assert.equal(await inbound.setDefaultProject(h.st.binding, '', 7, options), '默认项目已设为「甲」');
  // 换项目 ⇒ 同一次调用内自动解绑当前会话（会话是项目目录下的实体）
  assert.equal(await inbound.setDefaultProject(h.st.binding, '乙', 0, options),
    `默认项目已设为「乙」\n${ORA.UNBIND_NOTE}`);
  assert.equal(await inbound.setDefaultProject(h.st.binding, '', 999, options), '项目不在你的项目列表');
  // ⑤ onCardAction（t=dp 的卡片回调分流，feishu.py:1913-1919）
  const toast = await inbound.onCardAction({
    header: { event_id: 'ev_r3_1' },
    event: { operator: { open_id: 'ou_a' }, action: { value: { t: 'dp', u: 1 }, option: '7' } },
  }, null, options);
  assert.deepEqual(toast, { toast: { type: 'success', content: '已设为默认项目' } });
});

test('缝③：chat.setMsgDoneHook ← feishu_conv.start()，且终态触发真跑到 DM（真 chat 缝）', async () => {
  const h = harness();
  conv.start(h.options);
  // 走真 chat.js 的触发口（注册的是**真模块**的函数）：把假钩子装进真单一注册位
  const prev = null;
  chatMod.setMsgDoneHook(h.st.hook);
  try {
    h.st.msgMeta = { feishu: { open_id: 'ou_a', user_id: 1, baseline: 0 } };
    h.st.binding = makeBinding();
    h.st.msgGet = { sid: 's1' };
    h.st.load = () => ({ found: true, entries: [{ kind: 'assistant', text: '跑完了' }] });
    chatMod.fireMsgDone('m1', 'done');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.deepEqual(h.calls.restText, [['ou_a', '跑完了', CFG]], '终态钩子必须真把答复推回 DM');
  } finally {
    chatMod.setMsgDoneHook(prev);
  }
});
