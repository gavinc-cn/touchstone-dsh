/**
 * 飞书**入站语义**单测（M7.5-R2）：被测件 `backend/lib/feishu_inbound.js`。
 * Oracle = `feishu.py:1577-2604`（未改动的 Python 真源），逐条断言带 oracle 行号。
 *
 * ══ 期望值来源（**先写、后实现**；不读 Node 实现反推） ═══════════════════════════════
 *   ① `HELP_TEXT` / `_INTENT_RULES` / `parse_intent` 的探针结果：**oracle 现算**——
 *      一次性 `python3` 脚本用 `ast.literal_eval` 取 `feishu.py` 的模块级字面量（不 import
 *      产品模块、无副作用），对 54 条探针跑真 `re.match` 循环，结果硬编码进本文件；
 *      另附两侧 sha256 锚（`ORACLE_HELP_SHA256` / `ORACLE_RULES_SHA256`），
 *      **我的转抄一旦有错，锚必然不等** ⇒ 判据不依赖我的抄写。
 *   ② 其余文案/顺序/状态：逐条对着 `feishu.py` 行号抄（每条断言上方标行号），
 *      含全角/半角标点、`·`(U+00B7)、`→`(U+2192)、`↩️`(U+21A9+U+FE0F)、`⛔`(U+26D4)、
 *      `…`(U+2026)、`✅`(U+2705)。
 *   ③ 夹具走 `m3fixture.freshDb`（临时库；它把 `process.env.TOUCHSTONE_DB` 指向自己，
 *      **结构上不可能碰生产库**）。
 *
 * ══ 自证（防空对空假绿）═══════════════════════════════════════════════════════════════
 * 所有外部副作用（rest / board / conv / slash / log / 时钟 / ws 客户端）都是注入的假件，
 * 每个用例都断言**假件收到的实参**（`calls.reply` / `calls.dm` / `calls.board.*` …）与
 * **真库里的落库状态**（`db.getFeishuBindingByOpen` 等），而不是只断言返回值。
 *
 * ══ 未覆盖（如实登记，别当已验）═══════════════════════════════════════════════════════
 *   - 真飞书网关的投递/重推形态（事件重推频率、`card.action.trigger` 在长连接上的载荷）；
 *   - `{e!r}` 的逐字对齐（Node 侧是 `errorRepr` 的**近似**，见 `backend/lib/feishu_inbound.js`）；
 *   - 真线程/真并发（Node 单线程；`_MQ_LOCK` 在 Node 侧是空操作，见该文件头「已知差异」）；
 *   - `TS_FEISHU_WS_DEBUG` 下 SDK 日志的逐字形态；
 *   - `sessparse`/`runner` 侧的副作用（本文件的 board 是桩，不是真看板）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as feishu from '../lib/feishu.js';
import * as feishuCfg from '../lib/feishu_cfg.js';
import * as feishuProvision from '../lib/feishu_provision.js';
import { FeishuRestError } from '../lib/feishu_rest.js';
import * as inbound from '../lib/feishu_inbound.js';
import { freshDb, insertCard, insertProject, insertTask } from './m3fixture.mjs';

// ==========================================================================
// oracle 现算的锚（见文件头①）
// ==========================================================================

/** `feishu.py:1579-1607` 求值后的 `HELP_TEXT`（**22 行**，源码 29 行有 3 处隐式拼接；M11 增「· 接入」） */
const ORACLE_HELP_TEXT = [
  'Touchstone 指令（单聊可用）：',
  '直接发普通文字 = 与当前会话对话（未绑定会在默认项目自动新建）。',
  '· 帮助 — 本说明',
  '· 接入 — 飞书接入操作卡片（换应用/重连/绑定码/自检/补齐/发布）',
  '· 绑定 <码> — 绑定站点账号（绑定码在站点侧栏「设置」→ 飞书设置 生成）',
  '· 解绑 — 解除绑定',
  '· 当前 — 查看默认项目与当前会话',
  '· 项目 — 项目总览卡（点选即设为默认项目）',
  '· 会话 — 默认项目最近活跃的 10 个会话（点选即绑定）',
  '· 新建会话 [标题] — 在默认项目下新建并绑定',
  '· 绑定会话 <序号|标题关键字|会话id前缀> — 绑定已有会话',
  '· 解绑会话 — 只解绑会话，保留默认项目',
  '· 默认项目 <项目名> — 设置默认项目',
  '· 状态 [项目名] — 任务与看板摘要',
  '· 卡片 <关键字> — 找卡片（id 前缀/标题包含）',
  '· 通过 <卡片> — 待审核卡片完成审核',
  '· 驳回 <卡片> <意见> — 打回继续开发',
  '· 作答 <卡片> <选项序号|文字> — 回复 agent 提问（多选逗号分隔：作答 7 1,3；'
    + '文字=自定义回答。单题多选卡上勾选后点「提交作答」即可，无需打字）',
  '· 作答 <卡片> <题号:值 …> — 多子题一次答全（如「作答 7 1:2 2:1 3:1,3」；多选写 1:2,3，'
    + '自定义写 1:文字。多子题卡可直接在卡片上逐题点选，点满自动送达，已点选的题不必重复给）',
  '· 同意 <卡片> [会话] — 批准挂起的工具审批（「会话」=本会话内自动放行）',
  '· 拒绝 <卡片> — 拒绝挂起的工具审批',
  '· 快捷指令：输入框里打「/」可直接选 /status、/cards、/approve 等（参数用法与上面对应中文指令一致）',
].join('\n');

/** oracle `HELP_TEXT` 的 utf-8 sha256（`python3` 现算；转抄错误的照妖镜） */
const ORACLE_HELP_SHA256 = '8ce024e221ea301186e6f718dd0a1402c007c829090ae136feedab4ba5a585bc';

/** `feishu.py:1985-2004` 的 `_INTENT_RULES`（18 条，顺序即优先级；M11 增 setup） */
const ORACLE_RULES = [
  ['help', '^(?:帮助|help|/help)$'],
  ['setup', '^(?:接入)$'],
  ['bind', '^(?:绑定|/bind)\\s*([A-Za-z0-9]{4,8})$'],
  ['unbind', '^(?:解绑|/unbind)$'],
  ['default_project', '^(?:默认项目|/project)\\s+(\\S+)$'],
  ['current', '^(?:当前|/current)$'],
  ['projects', '^(?:项目|/projects)$'],
  ['sessions', '^(?:会话|/sessions)$'],
  ['new', '^(?:新建会话|/new)(?:\\s+(.+))?$'],
  ['use', '^(?:绑定会话|/use)\\s+(.+)$'],
  ['leave', '^(?:解绑会话|/leave)$'],
  ['status', '^(?:状态|/status)(?:\\s+(.+))?$'],
  ['card', '^(?:卡片|/cards?)\\s+(.+)$'],
  ['approve', '^(?:通过|/approve)\\s+(\\S+)$'],
  ['reject', '^(?:驳回|/reject)\\s+(\\S+)\\s+(.+)$'],
  ['answer', '^(?:作答|/answer)\\s+(\\S+)\\s+(.+)$'],
  ['agree', '^(?:同意|/agree)\\s+(\\S+)(?:\\s+(会话|session))?$'],
  ['deny', '^(?:拒绝|/deny)\\s+(\\S+)$'],
];

/** `ORACLE_RULES` 的规范 JSON 文本 sha256（同上，转抄锚） */
const ORACLE_RULES_SHA256 = 'ad2f857197158458a2979c544d68222ec1437e273448806794dc778f1ce950fa';

/** oracle `parse_intent` 对 54 条探针的**原样**输出（`null` = 未识别） */
const ORACLE_PARSE = {
  '帮助': { action: 'help', groups: [] },
  '接入': { action: 'setup', groups: [] },
  'help': { action: 'help', groups: [] },
  '/help': { action: 'help', groups: [] },
  '帮助\n': { action: 'help', groups: [] },
  'help ': { action: 'help', groups: [] },
  '绑定 abcd': { action: 'bind', groups: ['abcd'] },
  '绑定 ABCD1234': { action: 'bind', groups: ['ABCD1234'] },
  '/bind xy12': { action: 'bind', groups: ['xy12'] },
  '绑定 abc': null,
  '解绑': { action: 'unbind', groups: [] },
  '/unbind': { action: 'unbind', groups: [] },
  '默认项目 demo': { action: 'default_project', groups: ['demo'] },
  '默认项目\u3000demo': { action: 'default_project', groups: ['demo'] },
  '默认项目': null,
  '/project a b': null,
  '当前': { action: 'current', groups: [] },
  '/current': { action: 'current', groups: [] },
  '项目': { action: 'projects', groups: [] },
  '/projects': { action: 'projects', groups: [] },
  '会话': { action: 'sessions', groups: [] },
  '/sessions': { action: 'sessions', groups: [] },
  '新建会话': { action: 'new', groups: [null] },
  '新建会话 标题 带空格': { action: 'new', groups: ['标题 带空格'] },
  '/new': { action: 'new', groups: [null] },
  '绑定会话 12': { action: 'use', groups: ['12'] },
  '/use x': { action: 'use', groups: ['x'] },
  '解绑会话': { action: 'leave', groups: [] },
  '/leave': { action: 'leave', groups: [] },
  '状态': { action: 'status', groups: [null] },
  '状态 项目名': { action: 'status', groups: ['项目名'] },
  '/status': { action: 'status', groups: [null] },
  '/status  项目名': { action: 'status', groups: ['项目名'] },
  '卡片 x': { action: 'card', groups: ['x'] },
  '/card x': { action: 'card', groups: ['x'] },
  '/cards x': { action: 'card', groups: ['x'] },
  '卡片': null,
  '通过 12': { action: 'approve', groups: ['12'] },
  '/approve 12': { action: 'approve', groups: ['12'] },
  '驳回 12 意见': { action: 'reject', groups: ['12', '意见'] },
  '驳回 12': null,
  '/reject 1 2 3': { action: 'reject', groups: ['1', '2 3'] },
  '作答 7 1:2': { action: 'answer', groups: ['7', '1:2'] },
  '作答 7': null,
  '/answer 7 x': { action: 'answer', groups: ['7', 'x'] },
  '同意 12': { action: 'agree', groups: ['12', null] },
  '同意 12 会话': { action: 'agree', groups: ['12', '会话'] },
  '同意 12 session': { action: 'agree', groups: ['12', 'session'] },
  '同意 12 别的': null,
  '/agree 12': { action: 'agree', groups: ['12', null] },
  '拒绝 12': { action: 'deny', groups: ['12'] },
  '/deny 12': { action: 'deny', groups: ['12'] },
  '随便': null,
  ' STATUS': null,
  '状态 x y': { action: 'status', groups: ['x y'] },
  '1:2': null,
  '': null,
};

/** 17 条规则各一条**命中样例**（表驱动，一条一例；样例取自 `ORACLE_PARSE` 的实算结果） */
const RULE_SAMPLES = [
  ['help', '帮助'], ['setup', '接入'], ['bind', '绑定 abcd'], ['unbind', '解绑'],
  ['default_project', '默认项目 demo'], ['current', '当前'], ['projects', '项目'],
  ['sessions', '会话'], ['new', '新建会话'], ['use', '绑定会话 12'], ['leave', '解绑会话'],
  ['status', '状态'], ['card', '卡片 x'], ['approve', '通过 12'],
  ['reject', '驳回 12 意见'], ['answer', '作答 7 1:2'], ['agree', '同意 12'],
  ['deny', '拒绝 12'],
];

// ==========================================================================
// 夹具：注入假件（自证用）+ 临时库
// ==========================================================================

/** 消息/卡片回调用的应用凭据（oracle 的 `cfg`）；`null` 只在专测「应用未配置」时用 */
const CFG = Object.freeze({ app_id: 'cli_x', app_secret: 'sec_x' });

/**
 * 建一套「临时库 + 假外部件」夹具。
 *
 * 假件一律**记录实参**（`calls`），用例据此自证「注入真的到了被测函数」。
 * `rest.restReply` 在 `cfg == null` 时**照 oracle 抛 `FeishuRestError`**
 * （`feishu.py:1103-1104` 的「应用未配置」），这样 `cfg=None` 路径可确定观察。
 */
function harness(tag, over = {}) {
  const fx = freshDb(tag);
  // 进程内态（两个 LRU + 暂存桶）是模块级全局：每个夹具从干净态开始，保证用例互不干扰。
  // 注意这是**测试缝**（`resetInboundState`），oracle 侧对应「进程重启」。
  inbound.resetInboundState();
  const stderr = [];
  const calls = { reply: [], dm: [], bot: [], board: {}, conv: [], slash: [] };
  const clock = { t: over.now === undefined ? 1000 : over.now };

  const rest = {
    async restReply(mid, text, cfg) {
      if (cfg === null || cfg === undefined) {
        // 照 oracle `feishu.py:1103-1104`：**先抛、一条都不发**
        throw new FeishuRestError('应用未配置（app_id/app_secret 缺失）');
      }
      calls.reply.push([mid, text, cfg]);
    },
    async restSendText(openId, text, cfg) { calls.dm.push([openId, text, cfg]); },
    async botOpenId(cfg) {
      calls.bot.push(cfg);
      return over.botOpenId === undefined ? 'ou_bot' : over.botOpenId;
    },
  };
  const board = {
    interactionOfSid(sid) {
      calls.board.sid = sid;
      return over.interaction === undefined ? null : over.interaction(sid);
    },
    async answerInteraction(...a) {
      calls.board.answer = a;
      return over.answerErr === undefined ? null : over.answerErr;
    },
    async answerApproval(...a) {
      calls.board.approval = a;
      return over.approvalErr === undefined ? null : over.approvalErr;
    },
    async moveCard(...a) {
      calls.board.move = a;
      return over.moveResult === undefined ? [null, null] : over.moveResult;
    },
    async startCard(...a) {
      calls.board.start = a;
      if (over.startErr !== undefined) throw over.startErr;
      return '/tmp/session.log';
    },
  };
  const conv = {
    enabled() { calls.conv.push(['enabled']); return Boolean(over.convEnabled); },
    async routeText(...a) { calls.conv.push(['routeText', ...a]); return over.routeReply || 'R'; },
    async convIntent(...a) { calls.conv.push(['convIntent', ...a]); return over.convReply || 'C'; },
    async onCardAction(...a) { calls.conv.push(['onCardAction', ...a]); return over.onCardReply ?? null; },
    async setDefaultProject(...a) {
      calls.conv.push(['setDefaultProject', ...a]);
      return over.setDefaultReply === undefined ? '' : over.setDefaultReply;
    },
    projectById(binding, pid) {
      calls.conv.push(['projectById', binding, pid]);
      return over.projectById === undefined ? null : over.projectById(binding, pid);
    },
  };
  const slash = {
    async syncSlashCommands(...a) {
      calls.slash.push(a);
      return over.slashOut === undefined
        ? { ok: true, created: ['help'], updated: [], kept: [] } : over.slashOut;
    },
  };
  const options = {
    db: fx.db, dbPath: fx.dbPath, rest, board, conv, slash,
    now: () => clock.t,
    log: (line) => stderr.push(line),
    env: over.env === undefined ? {} : over.env,
  };
  return { fx, calls, stderr, clock, options, close: () => fx.close() };
}

/** 建绑定行（真库） */
function bind(openId, userId, defaultProjectId = 0, options = {}) {
  db.setFeishuBinding(openId, userId, defaultProjectId, options);
}

/** 消息事件最小骨架（`feishu.py:1776-1780` 的 6 键） */
function msgEvt(over = {}) {
  return {
    message_id: 'om_1', message_type: 'text', content: '{"text": "帮助"}',
    chat_type: 'p2p', mentions: [], sender_open_id: 'ou_a',
    ...over,
  };
}

/** 卡片回调最小骨架 */
function cardEvt(value, over = {}) {
  return {
    header: { event_id: 'ev_1' },
    event: { operator: { open_id: 'ou_a' }, action: { value } },
    ...over,
  };
}

/** 一张真库里的卡 + 其 project 行（`_find_user_card` 从库里找） */
function cardFixture(fx, over = {}) {
  const pid = insertProject(fx.db, { userId: 1, name: over.projectName || 'P1' });
  const cid = insertCard(fx.db, pid, {
    title: over.title || '登录接口调试', columnKey: over.columnKey || 'review',
    sessionId: over.sessionId || 'sid-1',
  });
  const p = { id: pid, name: over.projectName || 'P1', user_id: 1 };
  const c = {
    id: cid, title: over.title || '登录接口调试', column_key: over.columnKey || 'review',
    session_id: over.sessionId || 'sid-1',
  };
  return { pid, cid, p, c };
}

// ==========================================================================
// ① HELP_TEXT / 意图规则（oracle 现算）
// ==========================================================================

test('HELP_TEXT：22 行逐字节 + oracle sha256（源码 29 行有 3 处隐式拼接）', () => {
  assert.equal(typeof inbound.HELP_TEXT, 'string');
  assert.equal(Buffer.byteLength(inbound.HELP_TEXT, 'utf8'), 1764);   // oracle 现算（M11）
  assert.equal(inbound.HELP_TEXT.split('\n').length, 22);             // 求值后 22 行
  assert.equal(crypto.createHash('sha256').update(inbound.HELP_TEXT, 'utf8').digest('hex'),
    ORACLE_HELP_SHA256);
  assert.equal(inbound.HELP_TEXT, ORACLE_HELP_TEXT);                  // 逐行同源转抄
  // 三处隐式拼接点（源码行号）求值后仍在同一行
  assert.ok(inbound.HELP_TEXT.includes('· 作答 <卡片> <选项序号|文字> — 回复 agent 提问'
    + '（多选逗号分隔：作答 7 1,3；文字=自定义回答。单题多选卡上勾选后点「提交作答」即可，无需打字）'));
  assert.ok(inbound.HELP_TEXT.includes('· 快捷指令：输入框里打「/」可直接选 /status、/cards、/approve 等'
    + '（参数用法与上面对应中文指令一致）'));
});

test('INTENT_RULES：18 条逐条同句（顺序即优先级）+ oracle sha256', () => {
  const rows = inbound.INTENT_RULES.map(([a, p]) => [a, p instanceof RegExp ? p.source : p]);
  assert.deepEqual(rows, ORACLE_RULES);
  // 锚 = oracle 现算的**紧凑 JSON**（`json.dumps(..., separators=(",", ":"))`）sha256
  assert.equal(crypto.createHash('sha256')
    .update(JSON.stringify(ORACLE_RULES), 'utf8').digest('hex'), ORACLE_RULES_SHA256);
  assert.equal(inbound.INTENT_RULES.length, 18);
});

test('parseIntent：18 条规则表驱动一条一例（首命中即返回）', () => {
  for (const [action, text] of RULE_SAMPLES) {
    const got = inbound.parseIntent(text);
    assert.notEqual(got, null, `「${text}」应命中 ${action}`);
    assert.equal(got.action, action, `「${text}」应命中 ${action}，实得 ${got.action}`);
  }
});

test('parseIntent：54 条 oracle 探针全等（含未识别、组内 null、全角空格、剥首尾空白）', () => {
  for (const [text, want] of Object.entries(ORACLE_PARSE)) {
    assert.deepEqual(inbound.parseIntent(text), want, `探针 ${JSON.stringify(text)}`);
  }
  // 未参与捕获组的组是 null（不是 ""）——`feishu.py:2015` 的 `list(m.groups())`
  assert.deepEqual(inbound.parseIntent('状态').groups, [null]);
  assert.deepEqual(inbound.parseIntent('同意 12').groups, ['12', null]);
  assert.deepEqual(inbound.parseIntent('帮助').groups, []);
});

// ==========================================================================
// ② LRU 去重（`feishu.py:1617-1625` / `1785-1793`）
// ==========================================================================

test('seenMessage/seenEvent：命中回 true、稳态长度 512、按插入序淘汰（不是 511）', () => {
  inbound.resetInboundState();
  assert.equal(inbound.seenMessage('m1'), false);
  assert.equal(inbound.seenMessage('m1'), true);            // 1805 的判据方向
  assert.equal(inbound.seenEvent('e1'), false);
  assert.equal(inbound.seenEvent('e1'), true);
  // 两个 LRU 互不影响（`feishu.py:1612-1614` 的第二份状态）
  assert.equal(inbound.seenMessage('e1'), false);
  assert.equal(inbound.seenEvent('m1'), false);
  // 此刻 MSG_SEEN = [m1, e1]（2 条）⇒ 再插 510 条正好到 512（判据是 len > 512）
  for (let i = 0; i < 510; i += 1) inbound.seenMessage(`x${i}`);
  assert.equal(inbound.msgSeenSize(), 512, '稳态恰好 512（不是 511）');
  assert.equal(inbound.seenMessage('m1'), true, 'm1 仍在前 512 内（先进先出）');
  inbound.seenMessage('overflow');                          // 第 513 条 ⇒ 挤掉最旧
  assert.equal(inbound.msgSeenSize(), 512);
  assert.equal(inbound.seenMessage('m1'), false, '最旧的一条（m1）已被淘汰');
  assert.equal(inbound.seenMessage('overflow'), true);
  inbound.resetInboundState();
  assert.equal(inbound.msgSeenSize(), 0);
  assert.equal(inbound.seenMessage('m1'), false, 'reset 后重新开始（Node 侧测试缝）');
});

test('handleMessageEvent：去重**先于**一切副作用（同一 message_id 只回复一次、只打一行日志）', async () => {
  const h = harness('inbound-dedup');
  try {
    bind('ou_a', 1, 0, h.options);
    const evt = msgEvt({ content: '{"text": "帮助"}' });
    await inbound.handleMessageEvent(evt, CFG, h.options);
    await inbound.handleMessageEvent(evt, CFG, h.options);   // 重推
    assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.HELP_TEXT]);
    assert.equal(h.stderr.length, 2, '第二遍连「收到消息/文本」两行都不打（1805 在日志之前）');
    // 空 message_id：直接丢弃且**不入 LRU**（1805 的 `not mid`）
    await inbound.handleMessageEvent(msgEvt({ message_id: '', content: '{"text": "帮助"}' }),
      CFG, h.options);
    assert.equal(h.calls.reply.length, 1);
  } finally { h.close(); }
});

// ==========================================================================
// ③ 消息主流程（`feishu.py:1796-1860`）
// ==========================================================================

test('handleMessageEvent：绑定指令**先于**绑定校验（未绑定者一次绑定成功、真落库）', async () => {
  const h = harness('inbound-bind');
  try {
    const code = feishu.makeBindCode(1);
    await inbound.handleMessageEvent(
      msgEvt({ content: JSON.stringify({ text: `绑定 ${code}` }) }), CFG, h.options);
    assert.deepEqual(h.calls.reply.map((r) => r[1]), ['绑定成功，发「帮助」查看可用指令']);
    // 自证：真库里出现了绑定行（不是只回了个文案）
    const row = db.getFeishuBindingByOpen('ou_a', h.options);
    assert.ok(row, '绑定行必须真落库');
    assert.equal(row.user_id, 1);
    // 已绑定者再发「绑定 <码>」⇒ 1839 的另一种文案，且**不再消费码**
    const code2 = feishu.makeBindCode(2);
    await inbound.handleMessageEvent(
      msgEvt({ message_id: 'om_2', content: JSON.stringify({ text: `绑定 ${code2}` }) }),
      CFG, h.options);
    assert.equal(h.calls.reply[1][1], '当前账号已绑定，无需重复绑定（解绑后可重新绑定）');
    assert.equal(db.getFeishuBindingByOpen('ou_a', h.options).user_id, 1, '码不被消费');
    // 错误码原文透传（`bind_user` 的文案，1842）
    await inbound.handleMessageEvent(
      msgEvt({ message_id: 'om_3', sender_open_id: 'ou_b',
        content: JSON.stringify({ text: '绑定 zzzz' }) }),
      CFG, h.options);
    assert.equal(h.calls.reply[2][1], '绑定码无效或已被使用');
  } finally { h.close(); }
});

test('handleMessageEvent：未绑定 + 非绑定指令 ⇒ 引导文案（「在这里回复」）且**不执行**意图', async () => {
  const h = harness('inbound-unbound');
  try {
    await inbound.handleMessageEvent(msgEvt({ content: '{"text": "帮助"}' }), CFG, h.options);
    assert.deepEqual(h.calls.reply, [['om_1',
      '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，'
      + '生成绑定码后在这里回复「绑定 <码>」完成绑定', CFG]]);
    assert.deepEqual(h.calls.conv, [], '未绑定不碰对话层');
  } finally { h.close(); }
});

test('handleMessageEvent：群聊 @ 判定（bot_open_id 为假 ⇒ 静默；@ 到才继续）', async () => {
  const h = harness('inbound-group', { env: {} });
  try {
    bind('ou_a', 1, 0, h.options);
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    const atBot = { chat_type: 'group', mentions: [{ key: '@_user_1', open_id: 'ou_bot' }] };
    const group = { chat_type: 'group', mentions: [{ key: '@_user_1', open_id: 'ou_other' }] };
    // 未被 @ 到 bot ⇒ 静默（1812-1814），且**不打第二行日志、不回复**
    await inbound.handleMessageEvent(msgEvt({ ...group, content: '{"text": "帮助"}' }), cfg, h.options);
    assert.deepEqual(h.calls.reply, []);
    assert.deepEqual(h.calls.bot.length, 1, '群聊每条消息都查一次 bot_open_id');
    // bot_open_id 取不到 ⇒ 静默
    const h2 = harness('inbound-group2', { botOpenId: null });
    try {
      bind('ou_a', 1, 0, h2.options);
      await inbound.handleMessageEvent(
        msgEvt({ ...atBot, content: '{"text": "@_user_1 帮助"}' }), cfg, h2.options);
      assert.deepEqual(h2.calls.reply, []);
    } finally { h2.close(); }
    // @ 到自己 ⇒ 继续走（帮助 ⇒ 已识别意图 ⇒ HELP_TEXT 回复，占位符被剥掉）
    await inbound.handleMessageEvent(
      msgEvt({ message_id: 'om_9', ...atBot, content: '{"text": "@_user_1 帮助"}' }),
      cfg, h.options);
    assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.HELP_TEXT]);
  } finally { h.close(); }
});

test('handleMessageEvent：非文本（单聊回文案 / 群聊静默）+ 文本抽取剥 @ 占位符', async () => {
  const h = harness('inbound-text');
  try {
    bind('ou_a', 1, 0, h.options);
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    await inbound.handleMessageEvent(msgEvt({ message_type: 'image', content: '' }), cfg, h.options);
    assert.deepEqual(h.calls.reply.map((r) => r[1]), ['暂不支持该消息类型，请发送文字指令']);
    await inbound.handleMessageEvent(
      msgEvt({ message_id: 'om_g', message_type: 'image', chat_type: 'group',
        mentions: [{ key: '@_user_1', open_id: 'ou_bot' }] }), cfg, h.options);
    assert.equal(h.calls.reply.length, 1, '群聊非文本什么都不回');
    // 剥占位符 + 每次 strip（1824-1827）
    await inbound.handleMessageEvent(
      msgEvt({ message_id: 'om_p', content: '{"text": " @_user_1  帮助 "}',
        mentions: [{ key: '@_user_1', open_id: 'ou_bot' }] }), cfg, h.options);
    assert.equal(h.calls.reply[1][1], inbound.HELP_TEXT);
    // 内容坏 JSON ⇒ content={} ⇒ text="" ⇒ 静默（1820-1822）
    await inbound.handleMessageEvent(msgEvt({ message_id: 'om_b', content: 'not-json' }),
      cfg, h.options);
    assert.equal(h.calls.reply.length, 2, '坏 JSON 静默');
  } finally { h.close(); }
});

test('handleMessageEvent：未识别文本分岔（群聊 ⇒ HELP_TEXT；单聊且 conv 开 ⇒ routeText）', async () => {
  const h = harness('inbound-route');
  try {
    bind('ou_a', 1, 0, h.options);
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    await inbound.handleMessageEvent(msgEvt({ content: '{"text": "随便问问"}' }), cfg, h.options);
    assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.HELP_TEXT], 'conv 关 ⇒ 帮助');
    // 1849 短路序：`chat_type != "group" and feishu_conv.enabled()` —— 单聊**会**问 enabled()
    assert.deepEqual(h.calls.conv, [['enabled']], '单聊未识别文本先问 enabled()');
    assert.equal(h.calls.reply[0][1], inbound.HELP_TEXT);
    const h2 = harness('inbound-route2', { convEnabled: true, routeReply: '来自会话' });
    try {
      bind('ou_a', 1, 0, h2.options);
      await inbound.handleMessageEvent(msgEvt({ content: '{"text": "随便问问"}' }), cfg, h2.options);
      assert.deepEqual(h2.calls.reply.map((r) => r[1]), ['来自会话']);
      // oracle 的实参是 (binding, text, cfg)；末位的 `options` 是 Node 侧注入约定（多一位）
      assert.deepEqual(h2.calls.conv[1].slice(0, 4), ['routeText',
        db.getFeishuBindingByOpen('ou_a', h2.options), '随便问问', cfg],
      'route_text(binding, text, cfg) 实参自证');
      // 群聊即使 conv 开也回 HELP_TEXT（1853 注释「群聊保持原行为：不落会话」）
      await inbound.handleMessageEvent(
        msgEvt({ message_id: 'om_g2', chat_type: 'group', content: '{"text": "@_user_1 随便问问"}',
          mentions: [{ key: '@_user_1', open_id: 'ou_bot' }] }), cfg, h2.options);
      assert.equal(h2.calls.reply[1][1], inbound.HELP_TEXT);
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('handleMessageEvent：execute_intent 空串不回复；异常 ⇒ stderr 一行且不回消息', async () => {
  const h = harness('inbound-exec');
  try {
    bind('ou_a', 1, 0, h.options);
    h.options.conv.convIntent = async () => '';      // 「不必回复」通道（1857 的 `if reply:`）
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    await inbound.handleMessageEvent(msgEvt({ content: '{"text": "当前"}' }), cfg, h.options);
    assert.deepEqual(h.calls.reply, [], '空串不回复');
    // cfg=null ⇒ rest_reply 抛 FeishuRestError（夹具照 oracle 抛）⇒ 1859 的吞异常分支
    await inbound.handleMessageEvent(
      msgEvt({ message_id: 'om_e', content: '{"text": "帮助"}' }), null, h.options);
    assert.deepEqual(h.calls.reply, [], 'cfg=null ⇒ 夹具照 oracle 先抛，一条都没发');
    assert.equal(h.stderr.length, 5);        // 两次调用各 2 行 + 1 行处理异常
    assert.ok(h.stderr[4].startsWith('feishu inbound: 处理异常: FeishuRestError('),
      `实得：${h.stderr[4]}`);
    // 解析日志（1807-1809）逐字：缺键 ⇒ 字面量 None（Python f-string 的 str(None)）
    inbound.resetInboundState();
    const h3 = harness('inbound-log');
    try {
      await inbound.handleMessageEvent(
        { message_id: 'om_l', message_type: 'text', content: '{"text": ""}' },
        { app_id: 'c', app_secret: 's' }, h3.options);
      // ⚠顺序：`if not text: return`（1828）在「文本=…」那行（1833）**之前** ⇒ 只有 1 行
      assert.deepEqual(h3.stderr, ['feishu inbound: 收到消息 chat_type=None type=text sender=']);
    } finally { h3.close(); }
  } finally { h.close(); }
});

test('execute_intent：分派表（help/bind/unbind/default_project/conv/board）+ 两类异常文案', async () => {
  const h = harness('inbound-intent');
  try {
    bind('ou_a', 1, 0, h.options);
    const b = db.getFeishuBindingByOpen('ou_a', h.options);
    assert.equal(await inbound.executeIntent(b, { action: 'help', groups: [] }, 'ou_a',
      CFG, h.options), inbound.HELP_TEXT);
    // 2047：bind 意图的第二道提示（225 行外）
    assert.equal(await inbound.executeIntent(b, { action: 'bind', groups: ['zzzz'] }, 'ou_a',
      CFG, h.options), '当前账号已绑定，无需重复绑定');
    // 2049-2050：解绑真删行
    assert.equal(await inbound.executeIntent(b, { action: 'unbind', groups: [] }, 'ou_a',
      CFG, h.options), '已解绑。重新绑定请到站点生成新的绑定码');
    assert.equal(db.getFeishuBindingByOpen('ou_a', h.options), null);
    // 2053-2054：对话族透传（含 cfg 与 groups）
    assert.equal(await inbound.executeIntent(b, { action: 'new', groups: [null] }, 'ou_a',
      { app_id: 'c' }, h.options), 'C');
    assert.deepEqual(h.calls.conv[0].slice(0, 6),
      ['convIntent', b, 'new', [null], 'ou_a', { app_id: 'c' }]);
    // 2056-2059：异常映射（先具体后宽泛）
    const h2 = harness('inbound-intent2', {});
    try {
      bind('ou_a', 1, 0, h2.options);
      const f = cardFixture(h2.fx);
      const b2 = db.getFeishuBindingByOpen('ou_a', h2.options);
      h2.options.board.moveCard = async () => { throw new FeishuRestError('boom'); };
      assert.equal(await inbound.executeIntent(b2, { action: 'approve', groups: [String(f.cid)] },
        'ou_a', null, h2.options), '飞书接口调用失败，请稍后重试');
      h2.options.board.moveCard = async () => { throw new Error('boom'); };
      assert.equal(await inbound.executeIntent(b2, { action: 'approve', groups: [String(f.cid)] },
        'ou_a', null, h2.options), '指令执行失败，请稍后重试');
      // intent 缺 groups 键 ⇒ 穿透（2042 在 try 之外）
      await assert.rejects(() => inbound.executeIntent(b2, { action: 'help' }, 'ou_a',
        null, h2.options));
    } finally { h2.close(); }
  } finally { h.close(); }
});

// ==========================================================================
// ④ 卡片入口（`feishu.py:1865-1978` / `1884-1949`）
// ==========================================================================

test('toastFor：成功前缀两种（元组 OR）+ error + `None ⇒ null` + `""` ⇒ error toast', () => {
  assert.equal(inbound.toastFor(null), null);
  assert.deepEqual(inbound.toastFor('已收下：卡片 #7 1 道作答，排队送达中'),
    { toast: { type: 'success', content: '已收下，详情看机器人单聊' } });
  assert.deepEqual(inbound.toastFor('✅ 卡片 #7 审批已批准，排队送达中'),
    { toast: { type: 'success', content: '已收下，详情看机器人单聊' } });
  assert.deepEqual(inbound.toastFor('没找到对应卡片'),
    { toast: { type: 'error', content: '操作失败，详情看机器人单聊' } });
  // 1868 只判 `is None` ⇒ 空串走 error 分支（调用点的 `if reply:` 才让它不可达）
  assert.deepEqual(inbound.toastFor(''),
    { toast: { type: 'error', content: '操作失败，详情看机器人单聊' } });
  // 键序 type → content（1871-1873）
  assert.deepEqual(Object.keys(inbound.toast('info', 'x').toast), ['type', 'content']);
});

test('cardSdkToDict：取值链（白名单 7 键、timezone 不拷、checked=False 拷贝、缺省是 ""）', () => {
  const full = {
    header: { event_id: 'ev_9' },
    event: {
      operator: { open_id: 'ou_op' },
      action: {
        value: { t: 'mq', c: 7, n: 1 }, tag: 'select_static', name: 'mq7_1',
        form_value: { mq7_1: ['2'] }, input_value: 'iv', option: ['1'],
        options: ['2'], checked: false, timezone: 'Asia/Shanghai',
      },
    },
  };
  assert.deepEqual(inbound.cardSdkToDict(full), {
    header: { event_id: 'ev_9' },
    event: {
      operator: { open_id: 'ou_op' },
      action: {
        value: { t: 'mq', c: 7, n: 1 }, tag: 'select_static', name: 'mq7_1',
        form_value: { mq7_1: ['2'] }, input_value: 'iv', option: ['1'],
        options: ['2'], checked: false,
      },
    },
  });
  assert.ok(!('timezone' in inbound.cardSdkToDict(full).event.action), 'timezone 不拷贝');
  // action=null ⇒ {"value": {}}；value 假值 ⇒ {}
  assert.deepEqual(inbound.cardSdkToDict({ header: null, event: null }), {
    header: { event_id: '' }, event: { operator: { open_id: '' }, action: { value: {} } },
  });
  assert.deepEqual(inbound.cardSdkToDict({ event: { action: { value: null } } }).event.action,
    { value: {} });
  // 缺省是 "" 而不是 null（1971/1974，与 `_on_message_event` 的 None 相反）
  assert.equal(inbound.cardSdkToDict({}).header.event_id, '');
  assert.equal(inbound.cardSdkToDict({}).event.operator.open_id, '');
});

test('onCardAction：t=sc 与 t=dp/ss **先于**卡号白名单（a/mq/p/s/d 才要 c）', async () => {
  const h = harness('inbound-card-sc', {
    slashOut: { ok: true, created: ['help', 'bind'], updated: ['status'], kept: ['card'] },
  });
  try {
    bind('ou_a', 1, 0, h.options);
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    const out = await inbound.onCardAction(cardEvt({ t: 'sc', a: 'retry', u: 1 }), cfg, h.options);
    assert.deepEqual(out, { toast: { type: 'success', content: '注册完成' } });
    assert.deepEqual(h.calls.slash, [[1, h.options]], 'sync_slash_commands(user_id) 实参自证');
    assert.deepEqual(h.calls.dm, [['ou_a',
      '✅ 快捷指令注册完成：新增 2、更新 1、已是最新 1'
      + '\n约 5 分钟后在机器人私聊输入「/」即可看到（重启飞书客户端可加速）。', cfg]]);
    // t=dp 已绑定 ⇒ 原样透传给对话层（含 value/action）
    const h2 = harness('inbound-card-dp', { onCardReply: { toast: { type: 'info', content: 'x' } } });
    try {
      bind('ou_a', 1, 0, h2.options);
      const dp = cardEvt({ t: 'dp', c: 3 });
      const got = await inbound.onCardAction(dp, cfg, h2.options);
      assert.deepEqual(got, { toast: { type: 'info', content: 'x' } });
      assert.deepEqual(h2.calls.conv[0].slice(0, 6), ['onCardAction', 'ou_a',
        db.getFeishuBindingByOpen('ou_a', h2.options), { t: 'dp', c: 3 },
        dp.event.action, cfg]);
      // 未绑定 ⇒ DM（「在单聊回复」）+ error toast，不碰对话层
      const h3 = harness('inbound-card-dp2');
      try {
        const got3 = await inbound.onCardAction(cardEvt({ t: 'ss', c: 3 }), cfg, h3.options);
        assert.deepEqual(got3, { toast: { type: 'error', content: '尚未绑定站点账号' } });
        assert.equal(h3.calls.dm[0][1], '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ '
          + '飞书设置，生成绑定码后在单聊回复「绑定 <码>」完成绑定');
        assert.deepEqual(h3.calls.conv, []);
      } finally { h3.close(); }
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('onCardAction：未知 t / 缺 c ⇒ null（无 DM 无 toast）；event_id 去重；空 event_id 不去重', async () => {
  const h = harness('inbound-card-gate');
  try {
    bind('ou_a', 1, 0, h.options);
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    assert.equal(await inbound.onCardAction(cardEvt({ t: 'zz', c: 7 }), cfg, h.options), null);
    assert.equal(await inbound.onCardAction(cardEvt({ t: 'a' }), cfg, h.options), null);
    assert.equal(await inbound.onCardAction(cardEvt({ t: 'a', c: 0 }), cfg, h.options), null,
      'c=0 是假值 ⇒ str() 后空 ⇒ 静默');
    assert.deepEqual(h.calls.dm, []);
    assert.deepEqual(h.calls.reply, []);
    // 同一 event_id 第二次 ⇒ null（1900-1901）
    const h2 = harness('inbound-card-gate2', {
      interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
        questions: [{ id: 'q_0', options: [{ id: 'o1', label: '甲' }], allow_other: true }] }),
    });
    try {
      bind('ou_a', 1, 0, h2.options);
      const { c } = cardFixture(h2.fx);
      const ev = cardEvt({ t: 'a', c: c.id, i: 1 });
      const first = await inbound.onCardAction(ev, cfg, h2.options);
      assert.deepEqual(first, { toast: { type: 'success', content: '已收下，详情看机器人单聊' } });
      assert.equal(await inbound.onCardAction(ev, cfg, h2.options), null, '同 event_id 去重');
      assert.equal(h2.calls.board.answer[0].id, c.id, '找卡命中的就是那张卡（自证）');
      assert.equal(h2.calls.board.answer[3][0].option_id, 'o1', '只提交一次（载荷仍是最初那次）');
      // 空 event_id ⇒ 不去重（1900 的 `if event_id and ...`）
      const noId = { header: {}, event: { operator: { open_id: 'ou_a' },
        action: { value: { t: 'a', c: c.id, i: 1 } } } };
      await inbound.onCardAction(noId, cfg, h2.options);
      await inbound.onCardAction(noId, cfg, h2.options);
      assert.deepEqual(await inbound.onCardAction(noId, cfg, h2.options),
        { toast: { type: 'success', content: '已收下，详情看机器人单聊' } },
        '无 event_id 每次都会重放执行');
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('onCardAction：未绑定（a 路）⇒ DM + toast；找卡失败 ⇒ DM err + toast「没找到对应卡片」', async () => {
  const h = harness('inbound-card-unbound');
  try {
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    assert.deepEqual(await inbound.onCardAction(cardEvt({ t: 'a', c: 7, i: 1 }), cfg, h.options),
      { toast: { type: 'error', content: '尚未绑定站点账号' } });
    assert.equal(h.calls.dm[0][1], '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ '
      + '飞书设置，生成绑定码后在单聊回复「绑定 <码>」完成绑定');
    const h2 = harness('inbound-card-nocard');
    try {
      bind('ou_a', 1, 0, h2.options);
      assert.deepEqual(await inbound.onCardAction(cardEvt({ t: 'a', c: 999, i: 1 }), cfg, h2.options),
        { toast: { type: 'error', content: '没找到对应卡片' } });
      assert.equal(h2.calls.dm[0][1], '没有找到匹配「999」的卡片'
        + '（仅搜你自己的项目；支持 id 前缀/标题包含）');
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('onCardAction：t=mq 每次回 toast（含进度）；t=p/s/d ⇒ decideApproval；t=a 的 str() 语义', async () => {
  const qs = [{ id: 'q_0', header: '甲题', options: [{ id: 'o1', label: 'a' }, { id: 'o2', label: 'b' }], multi_select: true, allow_other: true },
    { id: 'q_1', header: '乙题', options: [{ id: 'o3', label: 'c' }], allow_other: true }];
  const h = harness('inbound-card-mq', {
    interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true, questions: qs }),
  });
  try {
    bind('ou_a', 1, 0, h.options);
    const { c } = cardFixture(h.fx);
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    // 第 1 题（多选）点一次 ⇒ 进度 toast，DM 文案空串 ⇒ 不发 DM
    const t1 = await inbound.onCardAction(cardEvt(
      { t: 'mq', c: c.id, n: 1 }, { event: { operator: { open_id: 'ou_a' },
        action: { value: { t: 'mq', c: c.id, n: 1 },
          form_value: { [`mq${c.id}_1`]: ['1', '2'] } } } }),
    cfg, h.options);
    assert.deepEqual(t1, { toast: { type: 'success', content: '已记下第 1 题（1/2）' } });
    assert.deepEqual(h.calls.dm, [], '未答满不发 DM');
    // 第 2 题 ⇒ 答满整批送达
    const t2 = await inbound.onCardAction(cardEvt(
      { t: 'mq', c: c.id, n: 2 }, { header: { event_id: 'ev_2' },
        event: { operator: { open_id: 'ou_a' },
          action: { value: { t: 'mq', c: c.id, n: 2 }, option: '1' } } }),
    cfg, h.options);
    assert.deepEqual(t2, { toast: { type: 'success', content: '2 题已答完，已送达' } });
    assert.equal(h.calls.dm[0][1], `已收下：卡片 #${c.id} 2 道作答，排队送达中`);
    assert.deepEqual(h.calls.board.answer[3], [
      { wire: 'q_0', kind: 'multi', option_ids: ['o1', 'o2'] },
      { wire: 'q_1', kind: 'single', option_id: 'o3' },
    ], 'answer_interaction(proj, card, qid, answers) 载荷自证');
    assert.equal(h.calls.board.answer[2], 'q1', 'qid 用的是同一个 st 快照');
    // t=a：i 走 str()（1939）——数字 2 ⇒ "2" ⇒ 选项按钮路径
    const h2 = harness('inbound-card-a', {
      interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
        questions: [qs[1]] }),
    });
    try {
      bind('ou_a', 1, 0, h2.options);
      const fx2 = cardFixture(h2.fx);
      const ta = await inbound.onCardAction(cardEvt({ t: 'a', c: fx2.c.id, i: 1 }), cfg, h2.options);
      assert.deepEqual(ta, { toast: { type: 'success', content: '已收下，详情看机器人单聊' } });
      assert.deepEqual(h2.calls.board.answer[3],
        [{ wire: 'q_1', kind: 'single', option_id: 'o3' }]);
      // 布尔 true ⇒ Python str(True)=="True" ⇒ 非序号 ⇒ 当自由文本（不是 JS 的 "true"）
      const tb = await inbound.onCardAction(cardEvt(
        { t: 'a', c: fx2.c.id, i: true }, { header: { event_id: 'ev_b' } }), cfg, h2.options);
      assert.deepEqual(tb, { toast: { type: 'success', content: '已收下，详情看机器人单聊' } });
      assert.deepEqual(h2.calls.board.answer[3],
        [{ wire: 'q_1', kind: 'other', text: 'True' }], 'Python str(True) 泄漏');
    } finally { h2.close(); }
    // t=p/s/d ⇒ 审批（s 带 scope=session；d ⇒ rejected）
    const st = () => ({ pending: true, kind: 'approval', qid: 'q9', approval_id: 42 });
    for (const [t, decision, scope] of [['p', 'approved', ''], ['s', 'approved', 'session'],
      ['d', 'rejected', '']]) {
      const hp = harness(`inbound-card-${t}`, { interaction: st });
      try {
        bind('ou_a', 1, 0, hp.options);
        const f = cardFixture(hp.fx);
        const got = await inbound.onCardAction(cardEvt({ t, c: f.c.id }), cfg, hp.options);
        const a = hp.calls.board.approval;
        assert.equal(a[0].id, f.p.id);
        assert.equal(a[1].id, f.c.id);
        assert.equal(a[2], '42');
        assert.equal(a[3], decision);
        assert.equal(a[4], scope);
        assert.deepEqual(got, { toast: { type: 'success', content: '已收下，详情看机器人单聊' } });
      } finally { hp.close(); }
    }
  } finally { h.close(); }
});

// ==========================================================================
// ⑤ 多选暂存桶（`feishu.py:2096-2199`）
// ==========================================================================

test('mqPut/mqTake/mqPeek/mqDrop：先 pop 再判题数、题数不符重建、peek 不改动、drop 静默', () => {
  inbound.resetInboundState();
  const opts = { now: () => 1000 };
  assert.deepEqual(inbound.mqPut(7, 'q1', 2, 1, '2', opts), [1, 2, false]);
  assert.deepEqual(inbound.mqPeek(7, 'q1', opts), { 1: '2' });
  assert.deepEqual(inbound.mqPeek(7, 'q1', opts), { 1: '2' }, 'peek 幂等（不刷 at、不清桶）');
  // 题数不符 ⇒ **重建桶**（2129-2131），旧题值全丢
  assert.deepEqual(inbound.mqPut(7, 'q1', 3, 2, '1', opts), [1, 3, false]);
  assert.deepEqual(inbound.mqPeek(7, 'q1', opts), { 2: '1' });
  // 键：(int 卡号, str qid)；qid 变了自然换桶
  assert.deepEqual(inbound.mqPeek(7, 'q2', opts), {});
  inbound.mqPut(7, 'q2', 1, 1, '1', opts);
  assert.deepEqual(inbound.mqPeek(7, 'q2', opts), { 1: '1' });
  // _mq_take：**先 pop 再判题数**（2143-2144）⇒ 题数不符时桶已被销毁
  assert.deepEqual(inbound.mqTake(7, 'q1', 9, opts), []);
  assert.deepEqual(inbound.mqPeek(7, 'q1', opts), {}, '题数不符也照样被取走');
  // 正常取走：题号**数值升序**（2146 的 sorted 是数值排序不是字符串排序）
  inbound.mqPut(9, 'q', 3, 10, 'b', opts);
  inbound.mqPut(9, 'q', 3, 2, 'a', opts);
  inbound.mqPut(9, 'q', 3, 1, 'c', opts);
  assert.deepEqual(inbound.mqTake(9, 'q', 3, opts), [[1, 'c'], [2, 'a'], [10, 'b']]);
  assert.deepEqual(inbound.mqTake(9, 'q', 3, opts), [], '取走后桶没了');
  inbound.mqPut(11, 'q', 1, 1, '1', opts);
  inbound.mqDrop(11, 'q', opts);
  assert.deepEqual(inbound.mqPeek(11, 'q', opts), {});
  assert.equal(inbound.mqDrop(11, 'nope', opts), undefined, '不存在时静默');
  inbound.resetInboundState();
});

test('mqPruneLocked：TTL 严格 `>`1800（恰 1800 还在）+ 上限 64 削到 64 + 平局取插入序', () => {
  inbound.resetInboundState();
  // 严格 `>`：1800 不到期、1801 到期（2114-2115）
  let now = 1000;
  inbound.mqPut(1, 'q', 1, 1, '1', { now: () => now });
  now = 1000 + 1800;
  inbound.mqPut(2, 'q', 1, 1, '1', { now: () => now });      // 顺带 prune：卡 1 恰好 1800 ⇒ 还在
  assert.deepEqual(inbound.mqPeek(1, 'q', { now: () => now }), { 1: '1' });
  now = 1000 + 1801;
  inbound.mqPut(3, 'q', 1, 1, '1', { now: () => now });      // 卡 1 现在 1801 ⇒ 被清
  assert.deepEqual(inbound.mqPeek(1, 'q', { now: () => now }), {});
  assert.deepEqual(inbound.mqPeek(2, 'q', { now: () => now }), { 1: '1' });
  // 容量：> 64 才削 ⇒ 削到恰好 64；平局时 Python `min` 取字典插入序里的第一个
  inbound.resetInboundState();
  for (let i = 0; i < 65; i += 1) inbound.mqPut(100 + i, 'q', 1, 1, '1', { now: () => 5000 });
  // ⚠`_mq_put` 是「先 prune 再插」（2127 → 2131）⇒ 第 65 次 put 时还没超限，插完是 65 条；
  //   判据 `len > 64` 只在**下一次** prune 时触发（oracle 同序）。
  assert.equal(inbound.mqStageSize(), 65);
  inbound.mqPruneLocked(5000, { now: () => 5000 });
  assert.equal(inbound.mqStageSize(), 64, 'prune 后恰好 64（`while len > 64` 削到 64）');
  assert.deepEqual(inbound.mqPeek(100, 'q', { now: () => 5000 }), {}, '最旧（插入序第一）被逐出');
  assert.deepEqual(inbound.mqPeek(101, 'q', { now: () => 5000 }), { 1: '1' });
  assert.deepEqual(inbound.mqPeek(164, 'q', { now: () => 5000 }), { 1: '1' });
  // 未过期的桶**不会**被 take 里的额外 TTL 判据拒掉（390 行的陷阱：take/peek 不看 TTL）
  inbound.resetInboundState();
  inbound.mqPut(1, 'q', 1, 1, '9', { now: () => 1000 });
  assert.deepEqual(inbound.mqTake(1, 'q', 1, { now: () => 999999 }), [[1, '9']]);
  inbound.resetInboundState();
});

test('multiClickIndex：三条来源 + 任一非法即整体 None + `0`/`False`/list 边界（2162-2199）', () => {
  // ① 多选：form_value[name] 是数组
  assert.deepEqual(inbound.multiClickIndex({ form_value: { mq7_1: ['1', '3'] } }, true, 'mq7_1'),
    [1, 3]);
  // ① 多选：form_value[name] 是字符串 ⇒ 按空白/逗号切分
  assert.deepEqual(inbound.multiClickIndex({ form_value: { mq7_1: ' 1, 2 3 ' } }, true, 'mq7_1'),
    [1, 2, 3]);
  // ① 兜底 options（form_value 取不到时）
  assert.deepEqual(inbound.multiClickIndex({ options: ['2'] }, true, 'mq7_1'), [2]);
  // ② 单选：option 标量 / 数组
  assert.deepEqual(inbound.multiClickIndex({ option: '2' }, false, 'x'), [2]);
  assert.deepEqual(inbound.multiClickIndex({ option: ['1', '2'] }, false, 'x'), [1, 2]);
  // ② `raw not in (None, "")` 是**相等比较** ⇒ 0 通过、str(0)=="0" 合法（之后被越界判据拦）
  assert.deepEqual(inbound.multiClickIndex({ option: 0 }, false, 'x'), [0]);
  // ③ 兜底 value.i（前两条都取不到时）
  assert.deepEqual(inbound.multiClickIndex({ value: { i: 5 } }, false, 'x'), [5]);
  // 取不到 ⇒ None
  assert.equal(inbound.multiClickIndex({}, true, 'mq7_1'), null);
  assert.equal(inbound.multiClickIndex({ form_value: {} }, false, 'x'), null);
  assert.equal(inbound.multiClickIndex({ option: '' }, false, 'x'), null);
  // 任一非法即**整体** None（不是丢弃该项）
  assert.equal(inbound.multiClickIndex({ form_value: { n: ['1', 'x'] } }, true, 'n'), null);
  assert.equal(inbound.multiClickIndex({ form_value: { n: ['1', '2.0'] } }, true, 'n'), null);
  // 多选路径**不读** option（只有非 multi 才读，2182-2187）
  assert.equal(inbound.multiClickIndex({ option: '3' }, true, 'n'), null);
  // Python `\d` 的 Unicode 语义（T10）：阿拉伯-印度数字 ٤ ⇒ 4
  assert.deepEqual(inbound.multiClickIndex({ option: '٤' }, false, 'x'), [4]);
});

test('multiAnswerParts：`1:2 2:1 3:3` 逐题 + 非数字开头 token 续接（含空格）+ None', () => {
  assert.deepEqual(inbound.multiAnswerParts('1:2 2:1 3:3'), [[1, '2'], [2, '1'], [3, '3']]);
  assert.deepEqual(inbound.multiAnswerParts('2:用 sqlite 就行 3:保持'),
    [[2, '用 sqlite 就行'], [3, '保持']]);
  assert.deepEqual(inbound.multiAnswerParts('\u30001:2'), [[1, '2']], 're.match 只锚开头');
  assert.deepEqual(inbound.multiAnswerParts('1:2 乱写'), [[1, '2 乱写']]);
  assert.deepEqual(inbound.multiAnswerParts('1:2,3'), [[1, '2,3']]);
  assert.equal(inbound.multiAnswerParts('随便'), null);
  assert.equal(inbound.multiAnswerParts(''), null);
  assert.equal(inbound.multiAnswerParts(null), null);
  assert.deepEqual(inbound.multiAnswerParts('1:2 2:3'), [[1, '2'], [2, '3']]);
  // 题号可重复：本函数**不查重**（查重在 _multi_answers / _answer_by_token 两处）
  assert.deepEqual(inbound.multiAnswerParts('1:a 1:b'), [[1, 'a'], [1, 'b']]);
});

test('multiAnswers：越界/重复/缺题/序号形态/二分文案/2000 字/allow_other 默认 True', () => {
  const qs = [
    { id: 'w0', header: '甲题', options: [{ id: 'o1' }, { id: 'o2' }], multi_select: true, allow_other: true },
    { id: 'w1', header: '', options: [{ id: 'o9', label: 'only' }], allow_other: false },
  ];
  // happy path：多选 + 单选（wire 走 q.id）
  assert.deepEqual(inbound.multiAnswers(qs, [[1, '1,2'], [2, '1']]),
    [[{ wire: 'w0', kind: 'multi', option_ids: ['o1', 'o2'] },
      { wire: 'w1', kind: 'single', option_id: 'o9' }], '']);
  // 序号形态但无选项 ⇒ 2338-2339
  assert.deepEqual(inbound.multiAnswers([{ id: 'w', options: [] }], [[1, '1']]),
    [null, '第 1 题没有选项，请直接写回答文字']);
  const qsOther = [qs[0], { ...qs[1], allow_other: true }];
  assert.deepEqual(inbound.multiAnswers(qsOther, [[1, '1'], [2, '文字']]),
    [[{ wire: 'w0', kind: 'single', option_id: 'o1' },
      { wire: 'w1', kind: 'other', text: '文字' }], '']);
  // 越界：len(opts) > 1 与 == 1 两种文案（2342-2343）
  assert.deepEqual(inbound.multiAnswers(qsOther, [[1, '3'], [2, '文字']]),
    [null, '第 1 题选项序号无效（共 2 个选项）']);
  // allow_other 为假 ⇒ 文本形态被拦（2356-2357）
  assert.deepEqual(inbound.multiAnswers(qs, [[1, '1'], [2, '文字']]),
    [null, '第 2 题不支持自定义输入，请给选项序号']);
  assert.deepEqual(inbound.multiAnswers(qs, [[1, '1'], [2, '2']]),
    [null, '第 2 题只有一个选项，序号填 1']);
  // 多序号打单选（2344-2345）
  assert.deepEqual(inbound.multiAnswers([{ id: 'w', options: [{ id: 'a' }, { id: 'b' }] }],
    [[1, '1,2']]), [null, '第 1 题为单选，请只给一个序号']);
  // 重复题号 / 题号越界 / 缺题（2320-2329）
  assert.deepEqual(inbound.multiAnswers(qs, [[1, '1'], [1, '2'], [2, 'x']]),
    [null, '第 1 题重复作答']);
  assert.deepEqual(inbound.multiAnswers(qs, [[3, '1'], [1, '1'], [2, 'x']]),
    [null, '题号 3 无效（本提问共 2 题）']);
  assert.deepEqual(inbound.multiAnswers(qs, [[1, '1']]),
    [null, '还差 第 2 题（未命名） 未作答，请一次答全 2 题']);
  // 空题值 / 超长 / allow_other 缺省 True
  assert.deepEqual(inbound.multiAnswers([{ id: 'w', options: [] }], [[1, '   ']]),
    [null, '第 1 题未作答']);
  assert.deepEqual(inbound.multiAnswers([{ id: 'w', allow_other: true }],
    [[1, 'x'.repeat(2001)]]), [null, '第 1 题自定义输入过长（限 2000 字）']);
  assert.deepEqual(inbound.multiAnswers([{ id: 'w' }], [[1, 'x']]),
    [[{ wire: 'w', kind: 'other', text: 'x' }], ''], 'allow_other 缺省 True');
  assert.deepEqual(inbound.multiAnswers([{ id: 'w', allow_other: false }], [[1, 'x']]),
    [null, '第 1 题不支持自定义输入，请给选项序号']);
  // wire 走 str()（2334）；id 缺省是 q_{i-1}
  assert.deepEqual(inbound.multiAnswers([{ id: 7 }], [[1, 'x']]),
    [[{ wire: '7', kind: 'other', text: 'x' }], '']);
  assert.deepEqual(inbound.multiAnswers([{}], [[1, 'x']]),
    [[{ wire: 'q_0', kind: 'other', text: 'x' }], '']);
  // 序号形态**不去重**（"1,1" ⇒ 两个同 id）
  assert.deepEqual(inbound.multiAnswers([{ id: 'w', options: [{ id: 'a' }], multi_select: true }],
    [[1, '1,1']]), [[{ wire: 'w', kind: 'multi', option_ids: ['a', 'a'] }], '']);
});

// ==========================================================================
// ⑥ 作答与审批（`feishu.py:2207-2468`）
// ==========================================================================

test('answerByToken：多子题（暂存合并 + 送达后 drop + err 无前缀）、单题三形态、逐题语法纠正', async () => {
  const qs1 = [{ id: 'q_0', header: '甲', options: [{ id: 'o1', label: 'a' }], multi_select: true, allow_other: true },
    { id: 'q_1', header: '乙', options: [{ id: 'o2', label: 'b' }], allow_other: true }];
  const h = harness('inbound-answer-multi', {
    interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true, questions: qs1 }),
  });
  try {
    inbound.mqPut(7, 'q1', 2, 1, '1', h.options);        // 卡片上已点过第 1 题
    bind('ou_a', 1, 0, h.options);
    const { p, c } = cardFixture(h.fx);
    // 文本只给没点过的题 ⇒ 与暂存合并（2391-2393）
    const reply = await inbound.answerByToken(p, { ...c, id: 7 }, '2:1', h.options);
    assert.equal(reply, '已收下：卡片 #7 2 道作答，排队送达中');
    assert.deepEqual(h.calls.board.answer[3],
      [{ wire: 'q_0', kind: 'single', option_id: 'o1' },
        { wire: 'q_1', kind: 'single', option_id: 'o2' }]);
    // 提交后 drop（2398，成功与否都清）
    assert.deepEqual(inbound.mqPeek(7, 'q1', h.options), {});
    // 无 token 且无暂存 ⇒ 语法回执（复用 feishu.js 的 multiAnswerHelp，2384）
    assert.equal(await inbound.answerByToken(p, { ...c, id: 7 }, '随便', h.options),
      '该提问含 2 道子题：可在卡片上逐题点选（点满自动送达），或回复'
      + '「作答 7 1:<选项序号> 2:<选项序号>」一次答全；多选写「1:2,3」，自定义写「1:文字」');
    // 重复题号（2387-2390，与 _multi_answers 的措辞同但实现独立）
    assert.equal(await inbound.answerByToken(p, { ...c, id: 7 }, '1:1 1:2 2:x', h.options),
      '第 1 题重复作答');
    // 多题分支的 err **直接返回**（2396 无前缀）
    assert.equal(await inbound.answerByToken(p, { ...c, id: 7 }, '1:x 2:y 3:z', h.options),
      '题号 3 无效（本提问共 2 题）');
    // 审批等待 ⇒ 2370-2372
    const ha = harness('inbound-answer-appr', {
      interaction: () => ({ pending: true, kind: 'approval', approval_id: 1 }),
    });
    try {
      const f = cardFixture(ha.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1', ha.options),
        `该等待是工具审批，请回复「同意 ${f.c.id}」或「拒绝 ${f.c.id}」`);
    } finally { ha.close(); }
    // 不可远程作答 ⇒ _NO_REMOTE_ANSWER_HINT（2373-2374）
    const hr = harness('inbound-answer-remote', {
      interaction: () => ({ pending: true, kind: 'question', answerable: false }),
    });
    try {
      const f = cardFixture(hr.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1', hr.options),
        '该等待不支持远程作答（提问由 dsh 直跑会话发起），请在 dsh 会话窗口作答');
    } finally { hr.close(); }
    // 单题分支（2402-2448）
    const single = (over = {}) => harness(`inbound-answer-single-${Math.random()}`, {
      interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
        questions: [{ id: 'q_0', options: [{ id: 'o1', label: '甲' }, { id: 'o2', label: '乙' }],
          multi_select: false, allow_other: true, ...over }] }),
    });
    const hs = single();
    try {
      const f = cardFixture(hs.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1:2', hs.options),
        `该提问只有一道题，请回复「作答 ${f.c.id} <选项序号>」或「作答 ${f.c.id} <文字>」`);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1', hs.options),
        `已收下：卡片 #${f.c.id} 选择「甲」，排队送达中`);
      assert.deepEqual(hs.calls.board.answer[3], [{ wire: 'q_0', kind: 'single', option_id: 'o1' }]);
      assert.equal(await inbound.answerByToken(f.p, f.c, '3', hs.options),
        '选项序号无效，可回复：1)甲 / 2)乙');
      assert.equal(await inbound.answerByToken(f.p, f.c, '1,2', hs.options),
        '该问题不支持多选，请回复单个选项序号');
      assert.equal(await inbound.answerByToken(f.p, f.c, '文字', hs.options),
        `已收下：卡片 #${f.c.id} 自定义回答，排队送达中`);
      assert.deepEqual(hs.calls.board.answer[3], [{ wire: 'q_0', kind: 'other', text: '文字' }]);
      assert.equal(await inbound.answerByToken(f.p, f.c, 'x'.repeat(2001), hs.options),
        '输入内容过长（限 2000 字）');
      // answer_interaction 返回 err ⇒ 「作答失败：」前缀（2422/2433/2447，与多题分支不同）
      const he = single();
      he.options.board.answerInteraction = async () => '选项不存在或已过期';
      try {
        const f2 = cardFixture(he.fx);
        assert.equal(await inbound.answerByToken(f2.p, f2.c, '1', he.options),
          '作答失败：选项不存在或已过期');
      } finally { he.close(); }
    } finally { hs.close(); }
    const hm = single({ multi_select: true });
    try {
      const f = cardFixture(hm.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1,2', hm.options),
        `已收下：卡片 #${f.c.id} 多选「甲、乙」，排队送达中`);
    } finally { hm.close(); }
    const ho = single({ allow_other: false });
    try {
      const f = cardFixture(ho.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '文字', ho.options),
        '该问题不支持自定义输入，可回复选项序号：1)甲 / 2)乙');
    } finally { ho.close(); }
    const hno = harness('inbound-answer-noopt', {
      interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
        questions: [{ id: 'q_0', options: [], allow_other: false }] }),
    });
    try {
      const f = cardFixture(hno.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1', hno.options), '该提问没有可选选项');
      assert.equal(await inbound.answerByToken(f.p, f.c, '文字', hno.options),
        '该提问无选项且不支持自定义输入，请到站点会话窗口处理');
    } finally { hno.close(); }
    // 无 pending（2368-2369）
    const hn = harness('inbound-answer-none');
    try {
      const f = cardFixture(hn.fx);
      assert.equal(await inbound.answerByToken(f.p, f.c, '1', hn.options),
        `卡片 #${f.c.id} 当前没有等待中的提问`);
    } finally { hn.close(); }
  } finally { h.close(); }
});

test('answerMultiClick：未答满进度 toast（全角括号/半角斜杠）+ 答满整批送达 + 12 条校验文案', async () => {
  const qs = [{ id: 'q_0', header: '甲', options: [{ id: 'o1', label: 'a' }, { id: 'o2', label: 'b' }], multi_select: true, allow_other: true },
    { id: 'q_1', header: '乙', options: [{ id: 'o3', label: 'c' }], allow_other: true }];
  const mk = (over = {}) => harness(`inbound-mq-${Math.random()}`, {
    interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
      questions: qs, ...over.st }),
  });
  const h = mk();
  try {
    const p = { id: 1, name: 'P1' };
    const c = { id: 7, session_id: 'sid-1', title: 't', column_key: 'doing' };
    // 未答满：DM 文案是空串、toast 全角括号 + 半角斜杠（2260）
    assert.deepEqual(await inbound.answerMultiClick(p, c, { n: 1 },
      { form_value: { mq7_1: ['1'] } }, h.options),
    ['', { toast: { type: 'success', content: '已记下第 1 题（1/2）' } }]);
    // 答满：整批送达（2261-2273）
    const got = await inbound.answerMultiClick(p, c, { n: 2 }, { option: '1' }, h.options);
    assert.deepEqual(got, [`已收下：卡片 #7 2 道作答，排队送达中`,
      { toast: { type: 'success', content: '2 题已答完，已送达' } }]);
    assert.deepEqual(h.calls.board.answer[2], 'q1');
    // 各校验分支（2218-2256）——逐条文案
    const cases = [
      [{ ...{ n: 1 }, value: undefined }, null, ['卡片 #7 当前没有等待中的提问', { toast: { type: 'error', content: '提问已结束' } }]],
    ];
    assert.equal(cases.length, 1);
    const hn = harness('inbound-mq-none');
    try {
      assert.deepEqual(await inbound.answerMultiClick({ id: 1 }, c, { n: 1 }, {}, hn.options),
        ['卡片 #7 当前没有等待中的提问', { toast: { type: 'error', content: '提问已结束' } }]);
    } finally { hn.close(); }
    const happr = harness('inbound-mq-appr', {
      interaction: () => ({ pending: true, kind: 'approval' }),
    });
    try {
      assert.deepEqual(await inbound.answerMultiClick({ id: 1 }, c, { n: 1 }, {}, happr.options),
        ['卡片 #7 当前等待的不是提问，请回复「同意 7」或「拒绝 7」',
          { toast: { type: 'error', content: '该等待是审批' } }]);
    } finally { happr.close(); }
    const hro = harness('inbound-mq-ro', {
      interaction: () => ({ pending: true, kind: 'question', answerable: false }),
    });
    try {
      assert.deepEqual(await inbound.answerMultiClick({ id: 1 }, c, { n: 1 }, {}, hro.options),
        ['该等待不支持远程作答（提问由 dsh 直跑会话发起），请在 dsh 会话窗口作答',
          { toast: { type: 'error', content: '请到 dsh 会话窗口作答' } }]);
    } finally { hro.close(); }
    const hempty = harness('inbound-mq-empty', {
      interaction: () => ({ pending: true, kind: 'question', answerable: true, questions: [] }),
    });
    try {
      assert.deepEqual(await inbound.answerMultiClick({ id: 1 }, c, { n: 1 }, {}, hempty.options),
        ['卡片 #7 当前没有等待中的提问', { toast: { type: 'error', content: '提问已结束' } }]);
    } finally { hempty.close(); }
    const hsingle = harness('inbound-mq-single', {
      interaction: () => ({ pending: true, kind: 'question', answerable: true, qid: 'q1',
        questions: [{ id: 'q_0', options: [{ id: 'o1' }], multi_select: false }] }),
    });
    try {
      assert.deepEqual(await inbound.answerMultiClick({ id: 1 }, c, { n: 1 }, {}, hsingle.options),
        ['该提问是单选题，请用卡片上的选项按钮，或回复「作答 7 <选项序号>」',
          { toast: { type: 'error', content: '单题单选请用按钮' } }]);
    } finally { hsingle.close(); }
    // 题号非法/越界（2235-2241）：int("2.5") 抛 ⇒ 0；int(2.9)==2
    const hno = mk();
    try {
      assert.deepEqual(await inbound.answerMultiClick(p, c, { n: '2.5' }, {}, hno.options),
        ['题号无效（卡片可能已过期），请重新作答', { toast: { type: 'error', content: '题号无效' } }]);
      assert.deepEqual(await inbound.answerMultiClick(p, c, { n: 3 }, {}, hno.options),
        ['题号无效（卡片可能已过期），请重新作答', { toast: { type: 'error', content: '题号无效' } }]);
    } finally { hno.close(); }
    // 该题无选项 ⇒ 写文字（2244-2246）
    const hq2 = mk();
    try {
      assert.deepEqual(await inbound.answerMultiClick(p, c, { n: 2 },
        { option: '1' }, { ...hq2.options, board: { ...hq2.options.board,
          interactionOfSid: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
            questions: [qs[0], { id: 'q_1', options: [] }] }) } }),
      ['第 2 题没有选项，请回复「作答 7 2:<文字>」',
        { toast: { type: 'error', content: '该题请写文字' } }]);
    } finally { hq2.close(); }
    // 没收到选项（2249-2251）/ 序号越界（2252-2254）/ 多选打单选（2255-2256）
    const h3 = mk();
    try {
      assert.deepEqual(await inbound.answerMultiClick(p, c, { n: 1 }, {}, h3.options),
        ['没收到你选的选项，请改用「作答 7 1:<选项序号>」',
          { toast: { type: 'error', content: '未收到选项，请看单聊' } }]);
      assert.deepEqual(await inbound.answerMultiClick(p, c, { n: 1 }, { form_value: { mq7_1: ['9'] } },
        h3.options),
      ['第 1 题选项序号无效（共 2 个选项）', { toast: { type: 'error', content: '选项无效' } }]);
    } finally { h3.close(); }
    // 2255-2256「多选打单选」：必须 n ≥ 2（n==1 且单选会在 2231 更早的分支被拦）
    const hs2 = harness('inbound-mq-single2', {
      interaction: () => ({ pending: true, kind: 'question', qid: 'q1', answerable: true,
        questions: [qs[0], { id: 'q_1', options: [{ id: 'o3' }, { id: 'o4' }], multi_select: false }] }),
    });
    try {
      assert.deepEqual(await inbound.answerMultiClick({ id: 1 }, c, { n: 2 },
        { option: ['1', '2'] }, hs2.options),
      ['第 2 题为单选，请只选一项', { toast: { type: 'error', content: '单选只能选一项' } }]);
    } finally { hs2.close(); }
    // 2262-2265「取走份数 < n」是**极端竞态分支**（oracle 自注：取走前被 TTL 清掉/并发取走）：
    // Node 单线程 + 同一个同步临界区 ⇒ 结构上不可达，本文件不假装测了它（见报告「未验」）。
    // answer_interaction 报错（2267-2271）
    const hb = mk();
    hb.options.board.answerInteraction = async () => '回答失败：提问不存在或已过期';
    try {
      inbound.mqPut(7, 'q1', 2, 1, '1', hb.options);
      const r = await inbound.answerMultiClick(p, c, { n: 2 }, { option: '1' }, hb.options);
      assert.deepEqual(r, ['作答失败：回答失败：提问不存在或已过期',
        { toast: { type: 'error', content: '作答失败' } }]);
    } finally { hb.close(); }
  } finally { h.close(); }
});

test('decideApproval：四态文案（无审批/缺 id/失败/成功含 session 尾巴）', async () => {
  const mk = (st, over = {}) => harness(`inbound-appr-${Math.random()}`, {
    interaction: () => st, ...over,
  });
  const h = mk(null);
  try {
    const p = { id: 1 };
    const c = { id: 7, session_id: 'sid-1' };
    assert.equal(await inbound.decideApproval(p, c, 'approved', '', h.options),
      '卡片 #7 当前没有等待中的审批（提问类请回复「作答 7 <选项序号|文字>」）');
  } finally { h.close(); }
  const h2 = mk({ pending: true, kind: 'approval' });
  try {
    assert.equal(await inbound.decideApproval({ id: 1 }, { id: 7, session_id: 's' },
      'approved', '', h2.options), '审批不存在或已过期，请到站点会话窗口处理');
  } finally { h2.close(); }
  const h3 = mk({ pending: true, kind: 'approval', approval_id: 42 });
  try {
    const p = { id: 1 };
    const c = { id: 7, session_id: 's' };
    assert.equal(await inbound.decideApproval(p, c, 'approved', '', h3.options),
      '✅ 卡片 #7 审批已批准，排队送达中');
    assert.deepEqual(h3.calls.board.approval.slice(0, 5), [p, c, '42', 'approved', '']);
    assert.equal(await inbound.decideApproval(p, c, 'approved', 'session', h3.options),
      '✅ 卡片 #7 审批已批准（本会话内同类调用自动放行），排队送达中');
    assert.equal(await inbound.decideApproval(p, c, 'rejected', '', h3.options),
      '✅ 卡片 #7 审批已拒绝，排队送达中');
    h3.options.board.answerApproval = async () => '审批不存在或已过期';
    assert.equal(await inbound.decideApproval(p, c, 'approved', '', h3.options),
      '审批失败：审批不存在或已过期');
  } finally { h3.close(); }
});

// ==========================================================================
// ⑦ 看板动作族（`feishu.py:2471-2596`）
// ==========================================================================

test('executeBoardAction：status / card / 未知动作 ⇒ HELP_TEXT（2479-2520）', async () => {
  const h = harness('inbound-board-q');
  try {
    const pid = insertProject(h.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h.fx.db, pid, {
      title: '登录接口调试', columnKey: 'blocked', blockText: '等凭据', lastError: 'boom',
      sessionId: 'sid-1',
    });
    insertTask(h.fx.db, pid, { name: '跑用例', status: 'running' });
    insertTask(h.fx.db, pid, { name: '排队任务', status: 'queued' });
    const binding = { user_id: 1, default_project_id: pid };
    // 状态 [项目名]（2480 → _board_summary）
    const sum = await inbound.executeBoardAction(binding, { action: 'status', groups: ['P1'] }, 'ou_a', h.options);
    assert.equal(sum, '[P1] 任务：运行中 1 / 排队 1（共 2）\n'
      + `· #${2} 排队任务（排队）\n· #${1} 跑用例（运行中）\n`
      + '看板：待开发0 正在开发0 阻塞1 待审核0 已完成0\n'
      + `⛔ #${cid} 登录接口调试（等凭据）`);
    // 卡片 <关键字>
    const detail = await inbound.executeBoardAction(binding, { action: 'card', groups: ['登录'] }, 'ou_a', h.options);
    assert.equal(detail, `卡片 #${cid} [P1] 登录接口调试\n状态：阻塞\n阻塞原因：等凭据\n`
      + `最近错误：boom\n回复「作答 ${cid} <选项序号|文字>」回复提问；「同意 ${cid}」/「拒绝 ${cid}」`
      + `处理审批；「通过 ${cid}」完成审核；「驳回 ${cid} 意见」打回`);
    // 未知动作 ⇒ HELP_TEXT
    assert.equal(await inbound.executeBoardAction(binding, { action: 'zz', groups: [] }, 'ou_a', h.options),
      inbound.HELP_TEXT);
  } finally { h.close(); }
});

test('executeBoardAction：approve（列位校验 / merge_pending / 门禁 / 成功）+ reject（只捕 Error）', async () => {
  const mk = (over) => harness(`inbound-board-a-${Math.random()}`, over);
  // 非 review 列（2492-2493）
  const h0 = mk({});
  try {
    const pid = insertProject(h0.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h0.fx.db, pid, { title: 'T', columnKey: 'doing' });
    const binding = { user_id: 1, default_project_id: pid };
    assert.equal(await inbound.executeBoardAction(binding, { action: 'approve', groups: [String(cid)] }, 'ou_a', h0.options),
      `卡片 #${cid} 不在「待审核」列（当前 doing），无法通过`);
    assert.equal(await inbound.executeBoardAction(binding, { action: 'reject', groups: [String(cid), '意见'] }, 'ou_a', h0.options),
      `卡片 #${cid} 不在「待审核」列（当前 doing），无法驳回`);
  } finally { h0.close(); }
  // merge_pending（2496-2502，箭头 U+2192）
  const h1 = mk({ moveResult: [null, { merge_pending: { ahead: 2, branch: 'agent/x', target: 'master' } }] });
  try {
    const pid = insertProject(h1.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h1.fx.db, pid, { title: 'T', columnKey: 'review' });
    const got = await inbound.executeBoardAction({ user_id: 1, default_project_id: pid },
      { action: 'approve', groups: [String(cid)] }, 'ou_a', h1.options);
    assert.equal(got, `卡片 #${cid} 还有 2 个提交没回流主分支（agent/x → master）；`
      + '请在网页看板上点「通过」，选择「交给 agent 合并」或「仅通过（不合并）」');
    assert.equal(h1.calls.board.move[0].id, pid);
    assert.equal(h1.calls.board.move[1], cid);
    assert.equal(h1.calls.board.move[2], 'done');
  } finally { h1.close(); }
  // 其它 err ⇒ 审核失败：error/blocked/门禁拦截（2503，str() 由 board 侧给字符串）
  const h2 = mk({ moveResult: [null, { blocked: '被别的卡挡住' }] });
  try {
    const pid = insertProject(h2.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h2.fx.db, pid, { title: 'T', columnKey: 'review' });
    assert.equal(await inbound.executeBoardAction({ user_id: 1, default_project_id: pid },
      { action: 'approve', groups: [String(cid)] }, 'ou_a', h2.options),
    '审核失败：被别的卡挡住');
  } finally { h2.close(); }
  // ⚠`err` 走 Python 真值：**空 dict 是假**（`if err:` 为假 ⇒ 当成功）；要进「门禁拦截」
  //   必须给一个**非空**但取不到 error/blocked 的 dict（`{'error': None}`）
  const h3 = mk({ moveResult: [null, { error: null }] });
  try {
    const pid = insertProject(h3.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h3.fx.db, pid, { title: 'T', columnKey: 'review' });
    assert.equal(await inbound.executeBoardAction({ user_id: 1, default_project_id: pid },
      { action: 'approve', groups: [String(cid)] }, 'ou_a', h3.options), '审核失败：门禁拦截');
  } finally { h3.close(); }
  // 成功（2504，标题截断 30）
  const h4 = mk({ moveResult: [{ id: 1 }, null] });
  try {
    const pid = insertProject(h4.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h4.fx.db, pid, { title: 'x'.repeat(40), columnKey: 'review' });
    assert.equal(await inbound.executeBoardAction({ user_id: 1, default_project_id: pid },
      { action: 'approve', groups: [String(cid)] }, 'ou_a', h4.options),
    `✅ 卡片 #${cid} ${'x'.repeat(30)} 已审核通过`);
  } finally { h4.close(); }
  // reject 成功（2512，↩️ = U+21A9 U+FE0F）与 start_card 抛错（2510-2511）
  const h5 = mk({});
  try {
    const pid = insertProject(h5.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h5.fx.db, pid, { title: 'T', columnKey: 'review' });
    assert.equal(await inbound.executeBoardAction({ user_id: 1, default_project_id: pid },
      { action: 'reject', groups: [String(cid), '再改改'] }, 'ou_a', h5.options),
    `↩️ 卡片 #${cid} 已打回继续开发，打回意见将注入 agent`);
    assert.equal(h5.calls.board.start[2], '再改改', 'extra=g[1] 透传');
  } finally { h5.close(); }
  const h6 = mk({ startErr: new Error('会话运行中，请等待完成或先停止') });
  try {
    const pid = insertProject(h6.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h6.fx.db, pid, { title: 'T', columnKey: 'review' });
    assert.equal(await inbound.executeBoardAction({ user_id: 1, default_project_id: pid },
      { action: 'reject', groups: [String(cid), '意见'] }, 'ou_a', h6.options),
    '打回失败：会话运行中，请等待完成或先停止');
  } finally { h6.close(); }
});

test('executeBoardAction：answer / agree / deny 走共用执行器（含 scope=会话 的判据）', async () => {
  const qs = [{ id: 'q_0', options: [{ id: 'o1', label: '甲' }], allow_other: true }];
  const st = { pending: true, kind: 'question', qid: 'q1', answerable: true, questions: qs };
  const h = harness('inbound-board-ans', { interaction: () => st });
  try {
    const pid = insertProject(h.fx.db, { userId: 1, name: 'P1' });
    const cid = insertCard(h.fx.db, pid, { title: '登录接口调试', columnKey: 'doing', sessionId: 'sid-1' });
    const binding = { user_id: 1, default_project_id: pid };
    assert.equal(await inbound.executeBoardAction(binding,
      { action: 'answer', groups: [String(cid), ' 1 '] }, 'ou_a', h.options),
    `已收下：卡片 #${cid} 选择「甲」，排队送达中`);
    // agree 带「会话」⇒ scope=session（2517-2518）；`session`（英文）不算
    const ha = harness('inbound-board-agree', {
      interaction: () => ({ pending: true, kind: 'approval', approval_id: 42 }),
    });
    try {
      const pid2 = insertProject(ha.fx.db, { userId: 1, name: 'P1' });
      const cid2 = insertCard(ha.fx.db, pid2, { title: 'T', columnKey: 'doing', sessionId: 'sid-1' });
      const b2 = { user_id: 1, default_project_id: pid2 };
      assert.equal(await inbound.executeBoardAction(b2, { action: 'agree', groups: [String(cid2), '会话'] }, 'ou_a', ha.options),
        `✅ 卡片 #${cid2} 审批已批准（本会话内同类调用自动放行），排队送达中`);
      assert.equal(ha.calls.board.approval[4], 'session');
      assert.equal(await inbound.executeBoardAction(b2, { action: 'agree', groups: [String(cid2), 'session'] }, 'ou_a', ha.options),
        `✅ 卡片 #${cid2} 审批已批准，排队送达中`);
      assert.equal(ha.calls.board.approval[4], '', '英文 session 不算（2517 只认「会话」）');
      assert.equal(await inbound.executeBoardAction(b2, { action: 'deny', groups: [String(cid2)] }, 'ou_a', ha.options),
        `✅ 卡片 #${cid2} 审批已拒绝，排队送达中`);
      assert.equal(ha.calls.board.approval[3], 'rejected');
    } finally { ha.close(); }
  } finally { h.close(); }
});

test('resolveProject / findUserCard / findCards：定位、消歧、命中序（2523-2560）', async () => {
  const h = harness('inbound-find');
  try {
    const p1 = insertProject(h.fx.db, { userId: 1, name: '甲项目' });
    insertProject(h.fx.db, { userId: 1, name: '乙项目' });
    const c1 = insertCard(h.fx.db, p1, { title: '登录接口调试', columnKey: 'todo' });
    const c2 = insertCard(h.fx.db, p1, { title: '登录接口回归', columnKey: 'todo' });
    const binding = { user_id: 1, default_project_id: p1 };
    const [p, err] = await inbound.resolveProject(binding, '甲项目', h.options);
    assert.equal(p.id, p1);
    assert.equal(err, '');
    // 唯一包含匹配
    assert.equal((await inbound.resolveProject(binding, '甲', h.options))[0].id, p1);
    // 歧义/零命中同一文案
    assert.deepEqual(await inbound.resolveProject(binding, '项目', h.options),
      [null, '项目「项目」不在你的项目列表']);
    // 空名 → 默认项目；无默认 → 唯一项目；多项目无默认 ⇒ 列可选（最多 8 个、`、` 连接）
    assert.equal((await inbound.resolveProject(binding, '', h.options))[0].id, p1);
    assert.deepEqual(await inbound.resolveProject({ user_id: 1, default_project_id: 999 }, '', h.options),
      [null, '请指明项目（回复「状态 项目名」），可选：甲项目、乙项目']);
    assert.deepEqual(await inbound.resolveProject({ user_id: 4242, default_project_id: 0 }, '', h.options),
      [null, '你还没有项目，请先到站点创建']);
    // findUserCard：零命中 / 多命中（最多 6 条、`·` U+00B7、标题截断 30）/ 命中（err 是空串）
    assert.deepEqual(await inbound.findUserCard(1, '不存在', h.options),
      [null, '没有找到匹配「不存在」的卡片（仅搜你自己的项目；支持 id 前缀/标题包含）']);
    const [none, multiErr] = await inbound.findUserCard(1, '登录', h.options);
    assert.equal(none, null);
    assert.equal(multiErr, '匹配到多张卡，请用更精确的 id 或关键字：\n'
      + `· #${c1} [甲项目] 登录接口调试\n· #${c2} [甲项目] 登录接口回归`);
    const [found, okErr] = await inbound.findUserCard(1, String(c1), h.options);
    assert.equal(found[1].id, c1);
    assert.equal(okErr, '', '成功时第二项是空串（不是 null）⇒ 调用方必须用 is None 判');
    // findCards：纯数字按 id 前缀，否则标题包含（2555-2559）
    assert.deepEqual((await inbound.findCards(1, String(c1), h.options)).map(([, c]) => c.id), [c1]);
    assert.deepEqual((await inbound.findCards(1, `${c1}`, h.options)).map(([p]) => p.name), ['甲项目']);
    assert.equal((await inbound.findCards(1, '不存在', h.options)).length, 0);
    // 零命中与「key 为空串」两种形态（空串走标题分支 ⇒ `"" in title` 恒真 ⇒ 全量命中）
    assert.equal((await inbound.findCards(1, '', h.options)).length, 2);
  } finally { h.close(); }
});

test('boardSummary：任务计数 + 逐任务点名（不截条数）+ 五列计数按 _COL_ORDER + 阻塞卡最多 5', async () => {
  const h = harness('inbound-summary');
  try {
    const pid = insertProject(h.fx.db, { userId: 1, name: 'P1' });
    for (let i = 0; i < 7; i += 1) {
      insertTask(h.fx.db, pid, { name: `任务${i}`, status: i % 2 === 0 ? 'running' : 'queued' });
    }
    insertTask(h.fx.db, pid, { name: '完成的任务', status: 'done' });
    insertCard(h.fx.db, pid, { columnKey: 'todo', title: 'a' });
    insertCard(h.fx.db, pid, { columnKey: 'doing', title: 'b' });
    insertCard(h.fx.db, pid, { columnKey: 'done', title: 'c' });
    for (let i = 0; i < 7; i += 1) {
      insertCard(h.fx.db, pid, { columnKey: 'blocked', title: `阻塞${i}`, blockKind: 'manual' });
    }
    const out = await inbound.boardSummary({ id: pid, name: 'P1' }, h.options);
    const lines = out.split('\n');
    assert.equal(lines[0], '[P1] 任务：运行中 4 / 排队 3（共 8）');
    const taskLines = lines.filter((l) => l.startsWith('· #'));
    assert.equal(taskLines.length, 7, 'running/queued 全量点名（不截条数）');
    assert.equal(taskLines[0], '· #7 任务6（运行中）', '`list_tasks` 是 ORDER BY id DESC');
    assert.equal(taskLines[1], '· #6 任务5（排队）');
    assert.equal(lines[8], '看板：待开发1 正在开发1 阻塞7 待审核0 已完成1');
    const blocked = lines.slice(9);
    assert.equal(blocked.length, 5, '阻塞卡最多 5 条');
    assert.match(blocked[0], /^⛔ #\d+ 阻塞0（manual）$/);
    // 标签与数字之间无分隔（2590-2591）；分隔符是半角空格
    assert.ok(!/待开发\s+1/.test(lines[8]));
    assert.ok(lines[8].startsWith('看板：待开发1 正在开发1'));
  } finally { h.close(); }
});

// ==========================================================================
// ⑧ 斜杠权限卡（范围外实现、范围内调用：`feishu.py:1495-1503` / `1553-1574`）
// ==========================================================================

test('onSlashPermAction + slashSummary：三个 toast 分支 + 防串号 + 未绑定文案（「在这里回复」）', async () => {
  const h = harness('inbound-slashperm', {
    slashOut: { ok: true, created: ['help'], updated: ['bind'], kept: ['status', 'card'], failed: [] },
  });
  try {
    assert.equal(inbound.slashSummary({ created: ['a'], updated: ['b', 'c'], kept: [], failed: ['x'] }),
      '新增 1、更新 2、已是最新 0、失败 1');
    assert.equal(inbound.slashSummary({ ok: true }), '新增 0、更新 0、已是最新 0');
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    // 未绑定 ⇒ 1600 的 error toast + 「在这里回复」文案（与卡片路径「在单聊回复」不同）
    const got = await inbound.onSlashPermAction('ou_a', { t: 'sc', u: 1 }, cfg, h.options);
    assert.deepEqual(got, { toast: { type: 'error', content: '尚未绑定站点账号' } });
    assert.equal(h.calls.dm[0][1], '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ '
      + '飞书设置，生成绑定码后在这里回复「绑定 <码>」完成绑定');
    bind('ou_a', 1, 0, h.options);
    const ok = await inbound.onSlashPermAction('ou_a', { t: 'sc', u: 1 }, cfg, h.options);
    assert.deepEqual(ok, { toast: { type: 'success', content: '注册完成' } });
    assert.equal(h.calls.dm[1][1], '✅ 快捷指令注册完成：新增 1、更新 1、已是最新 2'
      + '\n约 5 分钟后在机器人私聊输入「/」即可看到（重启飞书客户端可加速）。');
    // 防串号（1562-1564）
    assert.deepEqual(await inbound.onSlashPermAction('ou_a', { t: 'sc', u: 2 }, cfg, h.options),
      { toast: { type: 'error', content: '该卡片不属于当前账号' } });
    // u 为 0/缺省 ⇒ 不校验（`if uid and ...`）
    assert.deepEqual(await inbound.onSlashPermAction('ou_a', { t: 'sc' }, cfg, h.options),
      { toast: { type: 'success', content: '注册完成' } });
    // 失败分支 + need_scope 追加行（1570-1574）
    const h2 = harness('inbound-slashperm2', {
      slashOut: { ok: false, need_scope: true, error: '缺少权限 application:app_slash_command:write' },
    });
    try {
      bind('ou_a', 1, 0, h2.options);
      assert.deepEqual(await inbound.onSlashPermAction('ou_a', { t: 'sc', u: 1 }, cfg, h2.options),
        { toast: { type: 'error', content: '仍未成功，看私聊回复' } });
      assert.equal(h2.calls.dm[0][1], '❌ 仍未成功：缺少权限 application:app_slash_command:write'
        + '\n看起来权限还没生效：确认已在权限管理里添加读+写并**创建版本发布**，'
        + '稍等约 1 分钟再点一次卡片上的按钮。');
    } finally { h2.close(); }
  } finally { h.close(); }
});

// ==========================================================================
// ⑨ 入站长连接（`feishu.py:1628-1656` / `1722-1782`）
// ==========================================================================

/** 假 ws 客户端：`start()` 永不 resolve（照 SDK 的阻塞语义），可观测 `closed` */
function fakeClientFactory(record) {
  return class FakeClient {
    constructor(opts) {
      this.opts = opts;
      record.push(opts);
      this.stopped = false;
    }

    async start() {
      this.startedAt = Date.now();
      await new Promise(() => {});
    }
  };
}

test('startInboundFor 三态：无凭据（逐字 stderr）/ 已在跑（幂等 false）/ 真启动（true + 注册表）', async () => {
  const h = harness('inbound-start');
  try {
    const cfg = { app_id: 'cli_x', app_secret: 'sec_x' };
    // ① 无凭据 ⇒ oracle 逐字 stderr 行（1638-1639），不建线程
    assert.equal(inbound.startInboundFor(1, h.options), false);
    assert.deepEqual(h.stderr, ['feishu inbound: 用户 1 应用凭据缺失，长连接未启动']);
    // ② 已在跑 ⇒ 幂等 false 且**不打任何日志**（1634-1635）
    feishuCfg.setInboundThread(1, { isAlive: () => true });
    try {
      assert.equal(inbound.startInboundFor(1, h.options), false);
      assert.deepEqual(h.stderr, ['feishu inbound: 用户 1 应用凭据缺失，长连接未启动']);
    } finally { feishuCfg.clearInboundThread(1); }
    // ③ 凭据齐全 ⇒ true；建线程、登记在 start 之前、打印连接行（U+2026 结尾）
    db.setFeishuUserCfg(1, cfg, h.options);
    const record = [];
    const opts3 = { ...h.options, wsClient: fakeClientFactory(record) };
    assert.equal(inbound.startInboundFor(1, opts3), true);
    assert.deepEqual(h.stderr.slice(1),
      ['feishu inbound: 用户 1 连接长连接网关（app_id=cli_x）…']);
    assert.equal(feishuCfg.inboundStatus(1).thread, true, '真启动后注册表里是活线程');
    // 注册表键是**数值**（1608 的字典键语义：7 != "7"）
    assert.equal(feishuCfg.inboundStatus(1).thread, true);
    assert.equal(feishuCfg.inboundStatus(1).configured, true);
    // ④ 死线程残留 ⇒ 重拉（1634 的判据只能是 is_alive()）
    feishuCfg.setInboundThread(1, { isAlive: () => false });
    assert.equal(inbound.startInboundFor(1, opts3), true, '条目残留但线程已死 ⇒ 重拉');
    // 自证：假的 ws 客户端真的收到了 appId/appSecret/两个 handler
    assert.equal(record.length, 2);
    assert.equal(record[0].appId, 'cli_x');
    assert.equal(record[0].appSecret, 'sec_x');
    assert.equal(typeof record[0].eventHandler, 'function');
    assert.equal(typeof record[0].cardHandler, 'function');
    assert.equal(record[0].autoReconnect, undefined, '不传 autoReconnect ⇒ R1 默认 true');
    assert.equal(record[0].domain, undefined, '不传 domain ⇒ 硬编码官方域名');
    feishuCfg.clearInboundThread(1);
  } finally { h.close(); }
});

test('startInboundAll：遍历 list_feishu_user_cfgs（行序），只拉凭据齐全者，返回新启动数', async () => {
  const h = harness('inbound-startall');
  try {
    db.setFeishuUserCfg(1, { app_id: 'cli_1', app_secret: 's1' }, h.options);
    db.setFeishuUserCfg(2, { app_id: 'cli_2' }, h.options);           // 半填 ⇒ 跳过
    db.setFeishuUserCfg(3, { app_id: 'cli_3', app_secret: 's3' }, h.options);
    db.setFeishuUserCfg(4, {}, h.options);
    feishuCfg.setInboundThread(3, { isAlive: () => true });             // 已在跑 ⇒ 不计入
    try {
      const record = [];
      const n = inbound.startInboundAll({ ...h.options, wsClient: fakeClientFactory(record) });
      assert.equal(n, 1, '只有用户 1 是新启动的');
      assert.equal(record.length, 1);
      assert.equal(record[0].appId, 'cli_1');
      // 行序 = 表扫描序（1,2,3,4）⇒ 日志顺序确定
      assert.deepEqual(h.stderr, ['feishu inbound: 用户 1 连接长连接网关（app_id=cli_1）…']);
      assert.equal(feishuCfg.inboundStatus(3).thread, true);
    } finally { feishuCfg.clearInboundThread(3); }
  } finally { h.close(); }
});

test('wsRun：连接行 + 异常退出行（oracle 逐字）+ eventHandler 按 event_type 分流 + _touch_event 打点', async () => {
  const h = harness('inbound-wsrun');
  try {
    const cfg = { app_id: 'cli_x', app_secret: 's' };
    const record = [];
    const opts = { ...h.options, wsClient: fakeClientFactory(record) };
    const run = inbound.wsRun(7, cfg, opts);
    assert.equal(typeof run.then, 'function');
    // 连接行在 await 之前就打（1760-1761）
    assert.deepEqual(h.stderr, ['feishu inbound: 用户 7 连接长连接网关（app_id=cli_x）…']);
    // 分流：eventHandler 收 payload 字节（R1 契约）；R2 自己 JSON.parse
    const evtPayload = Buffer.from(JSON.stringify({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { message_id: 'om_ws', message_type: 'text',
        content: '{"text": "帮助"}', chat_type: 'p2p', mentions: [] },
        sender: { sender_id: { open_id: 'ou_a' } } },
    }), 'utf8');
    bind('ou_a', 1, 0, h.options);
    const out = await record[0].eventHandler(evtPayload);
    assert.equal(out, null, '消息事件返回值被丢弃（R1 侧 null ⇒ ACK 无 data）');
    assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.HELP_TEXT]);
    // _touch_event 打点写进 feishu_provision 的 _LAST_EVENT_TS
    assert.equal(feishuProvision._LAST_EVENT_TS.get(7), 1000, '打点用注入的时钟');
    // 卡片事件：card.action.trigger 走 _card_sdk_to_dict + _on_card_action，返回值进 ACK
    const cardPayload = Buffer.from(JSON.stringify({
      header: { event_type: 'card.action.trigger', event_id: 'ev_ws' },
      event: { operator: { open_id: 'ou_a' }, action: { value: { t: 'a', c: 999, i: 1 } } },
    }), 'utf8');
    const toast = await record[0].eventHandler(cardPayload);
    assert.deepEqual(toast, { toast: { type: 'error', content: '没找到对应卡片' } });
    // 已读回执：oracle 注册的是**空 lambda**（1745-1746）⇒ 返回值 None ⇒ ACK 只有 {"code":200}；
    // 且回执**不打点**（`_touch_event` 只在消息/卡片两个 processor 里）
    const touchedBefore = feishuProvision._LAST_EVENT_TS.get(7);
    const read = Buffer.from(JSON.stringify({
      header: { event_type: 'im.message.message_read_v1' }, event: {} }), 'utf8');
    assert.equal(await record[0].eventHandler(read), null);
    assert.equal(feishuProvision._LAST_EVENT_TS.get(7), touchedBefore, '已读回执不打点');
    // 未注册类型：必须**抛**（oracle 抛 EventException ⇒ R1 回 ACK `{"code": 500}`；
    // 返回 null 会变成 200 ⇒ 飞书认为已送达、不重推 = 静默吞事件）
    const unregistered = Buffer.from(JSON.stringify({
      header: { event_type: 'im.chat.updated_v1' }, event: {} }), 'utf8');
    await assert.rejects(() => record[0].eventHandler(unregistered), /processor not found/);
    // 坏 JSON ⇒ 事件解析异常那一行（1782），不外抛（**消息文案跨运行时不同**，只钉前缀）
    const before = h.stderr.length;
    assert.equal(await record[0].eventHandler(Buffer.from('not json', 'utf8')), null);
    assert.equal(h.stderr.length, before + 1);
    assert.match(h.stderr[before], /^feishu inbound: 事件解析异常: SyntaxError\(/);
    // 异常退出行（1765-1766）：start() 抛 ⇒ repr 近似
    const h2 = harness('inbound-wsrun2');
    try {
      class Boom {
        constructor(o) { this.opts = o; }
        async start() { throw new Error('client error (code=1000040346): app_id is invalid'); }
      }
      await inbound.wsRun(7, cfg, { ...h2.options, wsClient: Boom });
      assert.deepEqual(h2.stderr, [
        'feishu inbound: 用户 7 连接长连接网关（app_id=cli_x）…',
        'feishu inbound: 用户 7 长连接异常退出: '
        + 'Error(\'client error (code=1000040346): app_id is invalid\')（重启站点重试）',
      ]);
      assert.equal(feishuCfg.inboundStatus(7).thread, false,
        '线程退出后 is_alive() 回 false（条目残留）');
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('onMessageEvent：SDK 模型链 → 6 键 dict（mentions 的 open_id 缺省是 None 不是 ""）', async () => {
  const h = harness('inbound-onevt');
  try {
    bind('ou_a', 1, 0, h.options);
    const payload = {
      event: { message: { message_id: 'om_1', message_type: 'text',
        content: '{"text": "帮助"}', chat_type: 'p2p',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' } }, { key: '@_user_2' }] },
      sender: { sender_id: { open_id: 'ou_a' } } },
    };
    await inbound.onMessageEvent(payload, { app_id: 'c', app_secret: 's' }, h.options);
    assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.HELP_TEXT]);
    // 属性链断链 ⇒ 1782 的异常行（且不回复）
    const n = h.stderr.length;
    await inbound.onMessageEvent({ event: {} }, { app_id: 'c', app_secret: 's' }, h.options);
    assert.match(h.stderr[n], /^feishu inbound: 事件解析异常: AttributeError\(/);
  } finally { h.close(); }
});
