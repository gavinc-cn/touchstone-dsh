/**
 * Task 12a：飞书 DM 出站本地化 —— Node 侧验收测试（与 `tests/test_feishu_i18n.py` 镜像）。
 *
 * 三组判据：
 *   ① **zh 逐字节保全**：无偏好 / `TS_I18N=0` 下代表 payload（提问卡 / 审批卡 / 多题点选卡 /
 *      多题指引与语法帮助 / 指令回执 / 绑定回执 / 对话层回执 / 相对时间）的 utf-8 sha256
 *      与 HEAD（31d1dc7）相同。golden 与 Python 侧**同一组常量**（两端的卡片 JSON 也逐字节
 *      相同：`pyJsonDumps` 与 `json.dumps(ensure_ascii=False)` 同口径）。
 *   ② **英文面**：`lang='en'` / 绑定用户偏好 `{"v":"en"}` 时卡头/按钮/回执/对话层为英文；
 *      飞书**指令词**（作答/同意/默认项目…）按协议保留中文，门禁只放行这批 token。
 *   ③ **语言源语义（R22）**：无偏好 / 坏值 / 读库异常 ⇒ `zh`；`TS_I18N=0` ⇒ `zh` 且不读库；
 *      同一动作内 DM 与 toast 同语言。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as feishu from '../lib/feishu.js';
import * as conv from '../lib/feishu_conv.js';
import * as inbound from '../lib/feishu_inbound.js';
import { userLang, projectLang } from '../lib/feishu_cfg.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import { freshDb, insertProject } from './m3fixture.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const cardSha = (card) => sha256(pyJsonDumps(card));

/** HEAD（31d1dc7）golden（与 Python 测试 `tests/test_feishu_i18n.py` 的 GOLDEN 同源） */
const GOLDEN = {
  question_card: 'd7831a0720879f39d5d83daa4819246fe84edbdd03e652a19918bfb62cd97782',
  approval_card: '15ce9ac0da8637592c97f2056eed0f945c82f0cb0c492aabe36fe2e288df76fe',
  multi_card: '017f0c872f74238f729c8a2ed731c4bcbe524d06d718cbe15e344a77f76b000a',
  multi_hint: 'f3d95646d415d34e1b4d6508834530d5bb0ef3f9ce32eda9166aebd702e2a648',
  multi_answer_help: 'c4bbb506ec2d6ed1ec8fcbe1e70f97c1c236d8e1d0c8ebf45ee9d374869ae1a9',
  instruction_bind_reply: '84010a0d9a54f4d0c55d960dc4fd749e20147b30a1c4e209d4f52df6797ed6d4',
  binding_invalid_receipt: '01cf9e7693da84284af1398915df13e85615fe56a99c0e07ec6bbeea1df2d5fe',
  conv_current_text: '1e83a8f71fc9d460c2bec053d6e880d50f39c25b04a8a24d5bf48d0ef112938a',
  conv_rel_time_just_now: 'de6785d99e028971c6bfb19dc4f6d17d572d196038f7a5d904ffd4c29b148f5a',
};

const HAN = /[\u4e00-\u9fff]/;
// 英文译文里允许保留的中文：飞书**指令词**（协议 token）+ 协议占位符
const PROTOCOL_TOKENS = [
  '新建会话', '绑定会话', '解绑会话', '默认项目',
  '帮助', '接入', '绑定', '解绑', '当前', '项目', '会话', '状态', '卡片',
  '通过', '驳回', '作答', '同意', '拒绝',
  // 站点侧栏标签（英文文案里指向尚未翻译的站点 UI，属**完整预期片段**而非单字放行）
  '「设置」',
];

function assertNoChinese(text, extra = []) {
  let cleaned = text;
  for (const token of [...new Set([...PROTOCOL_TOKENS, ...extra])]
    .sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.split(token).join('');
  }
  assert.equal(HAN.test(cleaned), false, `英文面仍含中文: ${JSON.stringify(text)}`);
}

const ZH_QUESTION_CTX = {
  card_id: 7, title: '登录鉴权', kind: 'question',
  question: '选哪个场景？', options: ['A 场景', 'B 场景'], answerable: true,
  multi_select: false, allow_other: false, questions_count: 1,
};
const ZH_APPROVAL_CTX = {
  card_id: 12, title: '改配置', kind: 'approval', answerable: false,
  action: 'run_command', tool: 'bash', input: 'ls -la /tmp',
};
const ZH_MULTI_CTX = {
  card_id: 21, title: '多题', kind: 'question', answerable: true,
  questions: [
    { header: '范围', question: '选哪个？', options: ['红', '绿', '蓝'], multi_select: false },
    { header: '补充', question: '还要什么？', options: ['甲', '乙'],
      multi_select: true, allow_other: true, other_label: '其他' },
  ],
};

const QUESTION_CTX = {
  card_id: 7, title: 'Login auth', kind: 'question',
  question: 'Which scenario?', options: ['Scenario A', 'Scenario B'],
  answerable: true, multi_select: false, allow_other: false, questions_count: 1,
};
const APPROVAL_CTX = {
  card_id: 12, title: 'Change config', kind: 'approval', answerable: false,
  action: 'run_command', tool: 'bash', input: 'ls -la /tmp',
};
const MULTI_CTX = {
  card_id: 21, title: 'Multi', kind: 'question', answerable: true,
  questions: [
    { header: 'Scope', question: 'Which one?', options: ['Red', 'Green'], multi_select: false },
    { header: 'Extra', question: 'Anything else?', options: ['A', 'B'],
      multi_select: true, allow_other: true, other_label: 'Other' },
  ],
};

const BINDING = {
  open_id: 'ou_t12a', user_id: 990001, cur_sid: '', cur_title: '', cur_bound_at: '',
  cur_project_id: 0, default_project_id: 0,
};
const EMPTY_DB = {
  listProjects: () => [],
  getFeishuBindingByOpen: () => BINDING,
  delFeishuBindingByOpen: () => {},
};
// 只读空库句柄（`userLang`/`projectLang` 的 hermetic 替身）：无偏好行、项目不存在。
// `withReadDb` 只要求对象带 `prepare`（不满足 `isReadHandle` 也无妨），**不会**回落默认库。
const EMPTY_READ_DB = {
  prepare: () => ({ all: () => [], get: () => undefined }),
  exec: () => {},
};

// ---------------------------------------------------------------------------
// ① zh 逐字节保全（无偏好 = 存量正常情形；TS_I18N=0 = 回滚开关）
// ---------------------------------------------------------------------------

test('zh 卡片 payload 逐字节等于 HEAD golden（与 Python 同 hash）', () => {
  assert.equal(cardSha(feishu.buildInteractionCard(ZH_QUESTION_CTX, '演示项目')),
    GOLDEN.question_card);
  assert.equal(cardSha(feishu.buildInteractionCard(ZH_APPROVAL_CTX, '演示项目')),
    GOLDEN.approval_card);
  assert.equal(cardSha(feishu.buildInteractionCard(ZH_MULTI_CTX, '演示项目')),
    GOLDEN.multi_card);
  assert.equal(sha256(feishu.multiClickHint(21, ZH_MULTI_CTX.questions, [1], [2])),
    GOLDEN.multi_hint);
  assert.equal(sha256(feishu.multiAnswerHelp(21, ZH_MULTI_CTX.questions)),
    GOLDEN.multi_answer_help);
});

test('zh 回执/对话层逐字节等于 HEAD golden', async () => {
  const reply = await inbound.executeIntent(BINDING, { action: 'bind', groups: [] },
    'ou_t12a', null, { lang: 'zh', dbmod: EMPTY_DB });
  assert.equal(sha256(reply), GOLDEN.instruction_bind_reply);
  assert.equal(sha256(feishu.bindUser('ZZZZZZ', 'ou_t12a')), GOLDEN.binding_invalid_receipt);
  assert.equal(sha256(conv._current_text(BINDING, { lang: 'zh', dbmod: EMPTY_DB })),
    GOLDEN.conv_current_text);
  assert.equal(sha256(conv._rel_time(0, { lang: 'zh' })), GOLDEN.conv_rel_time_just_now);
});

/** 全量 golden 计算（卡片 5 + 回执/对话层 4）；TS_I18N=0 用例复用它，不复制期望值。 */
async function zhGoldenHashes() {
  return {
    question_card: cardSha(feishu.buildInteractionCard(ZH_QUESTION_CTX, '演示项目')),
    approval_card: cardSha(feishu.buildInteractionCard(ZH_APPROVAL_CTX, '演示项目')),
    multi_card: cardSha(feishu.buildInteractionCard(ZH_MULTI_CTX, '演示项目')),
    multi_hint: sha256(feishu.multiClickHint(21, ZH_MULTI_CTX.questions, [1], [2])),
    multi_answer_help: sha256(feishu.multiAnswerHelp(21, ZH_MULTI_CTX.questions)),
    instruction_bind_reply: sha256(await inbound.executeIntent(
      BINDING, { action: 'bind', groups: [] }, 'ou_t12a', null,
      { lang: 'zh', dbmod: EMPTY_DB })),
    binding_invalid_receipt: sha256(feishu.bindUser('ZZZZZZ', 'ou_t12a')),
    conv_current_text: sha256(conv._current_text(BINDING,
      { lang: 'zh', dbmod: EMPTY_DB })),
    conv_rel_time_just_now: sha256(conv._rel_time(0, { lang: 'zh' })),
  };
}

test('无偏好用户：userLang 恒 zh；projectLang 项目不存在 ⇒ zh', () => {
  // 显式传只读空库替身（不碰缺省库）：无偏好行 ⇒ zh；项目行不存在 ⇒ zh
  assert.equal(userLang(990001, { db: EMPTY_READ_DB }), 'zh');
  assert.equal(projectLang(0, { db: EMPTY_READ_DB }), 'zh');
});

test('TS_I18N=0：恒 zh、**不读库**（userLang/projectLang/全量 golden）', async () => {
  const prev = process.env.TS_I18N;
  process.env.TS_I18N = '0';
  try {
    const boom = new Proxy({}, {
      get() { throw new Error('TS_I18N=0 时不应读库'); },
    });
    assert.equal(userLang(990001, { db: boom }), 'zh');
    // Minor 2：项目行也必须在读之前短路（此前 projectLang 先 getProject 再短路）
    assert.equal(projectLang(42, { db: boom }), 'zh');
    // 全量 golden（卡片 5 + 回执/对话层 4）在回滚开关下逐字节不变
    assert.deepEqual(await zhGoldenHashes(), GOLDEN);
    // 显式 lang='en' 也被 t() 压回中文（回滚开关兜底）
    assert.equal(feishu.buildInteractionCard(ZH_QUESTION_CTX, '演示项目', 'en')
      .header.title.content, '🤔 卡片等待回复 [演示项目]');
  } finally {
    if (prev === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = prev;
  }
});

test('偏好语义：无偏好/坏值/读库异常 ⇒ zh；{"v":"en"} ⇒ en', () => {
  const fx = freshDb('t12a-pref');
  try {
    const options = { db: fx.db };
    assert.equal(userLang(9001, options), 'zh');            // 无偏好行
    for (const bad of [{ v: 'fr' }, { v: '' }, 'en', 123, { v: ['en'] }]) {
      db.setUserPref(9001, 0, 'lang', bad, options);
      assert.equal(userLang(9001, options), 'zh', JSON.stringify(bad));
    }
    db.setUserPref(9001, 0, 'lang', { v: 'en' }, options);
    assert.equal(userLang(9001, options), 'en');
    db.setUserPref(9001, 0, 'lang', { v: 'EN-us' }, options);
    assert.equal(userLang(9001, options), 'en');
    // 读库异常 ⇒ zh（绝不抛）
    const boom = { prepare() { throw new Error('db down'); } };
    assert.equal(userLang(9001, { db: boom }), 'zh');
  } finally {
    fx.close();
  }
});

test('projectLang 按项目所有者偏好（en）；项目不存在 ⇒ zh', () => {
  const fx = freshDb('t12a-plang');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath };
    const pid = insertProject(fx.db, { userId: 990005, name: 'proj-owner-en' });
    db.setUserPref(990005, 0, 'lang', { v: 'en' }, options);
    assert.equal(projectLang(pid, options), 'en');
    assert.equal(projectLang(0, options), 'zh');
  } finally {
    fx.close();
  }
});

test('过期绑定码按码所属用户偏好（en）；无效码恒 zh（R22）', () => {
  const fx = freshDb('t12a-bindexp');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath };
    db.setUserPref(990003, 0, 'lang', { v: 'en' }, options);
    feishu._BIND_CODES.set('EXP123', [990003, Date.now() / 1000 - 1]);
    const expired = feishu.bindUser('EXP123', 'ou_exp', options);
    assert.equal(expired,
      'The bind code has expired; generate a new one on the site');
    assertNoChinese(expired);
    assert.equal(feishu.bindUser('ZZZZZZ', 'ou_exp', options), '绑定码无效或已被使用');
  } finally {
    fx.close();
  }
});

test('入口接线：绑定成功回执按**新绑定用户**语言（en），真落库', async () => {
  const fx = freshDb('t12a-bindlang');
  try {
    const replies = [];
    const options = {
      db: fx.db,
      dbPath: fx.dbPath,
      feishu,
      rest: { async restReply(mid, text) { replies.push([mid, text]); } },
      log: () => {},
    };
    db.setUserPref(990004, 0, 'lang', { v: 'en' }, options);
    const code = feishu.makeBindCode(990004);
    await inbound.handleMessageEvent({
      message_id: 'm-t12a-bind-en',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: `绑定 ${code}` }),
      sender_open_id: 'ou_bind',
    }, { app_id: 'cli_x', app_secret: 'sec_x' }, options);
    assert.deepEqual(replies, [['m-t12a-bind-en',
      'Bound successfully; send 「帮助」 to see the available commands']]);
    // 自证：真库里出现绑定行，且语言确实来自该用户偏好（不是常量）
    const row = db.getFeishuBindingByOpen('ou_bind', options);
    assert.ok(row, '绑定行必须真落库');
    assert.equal(row.user_id, 990004);
    assertNoChinese(replies[0][1]);
  } finally {
    fx.close();
  }
});

test('入口接线：绑定用户偏好 en ⇒ currentText 英文（不显式传 lang）', () => {
  const fx = freshDb('t12a-wiring');
  try {
    const options = { db: fx.db, dbmod: { listProjects: () => [] } };
    db.setUserPref(990002, 0, 'lang', { v: 'en' }, options);
    const binding = { ...BINDING, user_id: 990002 };
    assert.equal(conv._current_text(binding, options),
      'Default project: not set\n'
      + 'Current session: none bound; sending a message will create one');
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// ② 英文面
// ---------------------------------------------------------------------------

test('英文提问卡：卡头/题面/按钮/指引全英文（数据不译）', () => {
  const card = feishu.buildInteractionCard(QUESTION_CTX, 'Demo', 'en');
  const flat = pyJsonDumps(card);
  assert.equal(card.header.title.content, '🤔 Card awaiting reply [Demo]');
  assert.ok(flat.includes('**agent question**: Which scenario?'));
  assert.ok(flat.includes('Card #7 Login auth'));
  assertNoChinese(flat);
});

test('英文审批卡：三按钮 + 请求/工具/内容行', () => {
  const card = feishu.buildInteractionCard(APPROVAL_CTX, 'Demo', 'en');
  const flat = pyJsonDumps(card);
  assert.ok(flat.includes('**Approval request**: run_command'));
  assert.ok(flat.includes('Tool: bash'));
  assert.ok(flat.includes('Input: ls -la /tmp'));
  const labels = card.body.elements.filter((e) => e.tag === 'button')
    .map((e) => e.text.content);
  assert.deepEqual(labels, ['✅ Approve', '🔁 Approve for this session', '⛔ Reject']);
  assertNoChinese(flat);
});

test('英文多题卡 + 多题指引 + 语法帮助', () => {
  const card = feishu.buildInteractionCard(MULTI_CTX, 'Demo', 'en');
  const flat = pyJsonDumps(card);
  assert.ok(flat.includes('**agent questions (2 in total)**'));
  assert.ok(flat.includes('1/2 Scope'));
  assert.ok(flat.includes('2/2 Extra'));
  assert.ok(flat.includes('Multi-select') && flat.includes('Custom: Other'));
  assert.ok(flat.includes('Please select (multi-select)'));
  assertNoChinese(flat);
  assertNoChinese(feishu.multiClickHint(21, MULTI_CTX.questions, [1], [2], 'en'));
  assertNoChinese(feishu.multiAnswerHelp(21, MULTI_CTX.questions, 'en'));
});

test('英文指引的按钮名与实际英文按钮标签一致（Minor 1）', () => {
  const md = feishu.planDocMarkdown(
    { ...QUESTION_CTX, session_id: 'sess-1' }, { assistant: 'Do A' }, 'Demo', 'en');
  assert.ok(md.includes('tap "Submit answer"'));
  assert.equal(md.includes('提交'), false);
  const hint = feishu.multiClickHint(21, MULTI_CTX.questions, [1], [2], 'en');
  assert.ok(hint.includes('tap "Submit question 2"'));
  assert.equal(hint.includes('提交'), false);
  assertNoChinese(md);
  assertNoChinese(hint);
});

test('英文相对时间复数：1 day ago / 2 days ago（zh 不变）', () => {
  const now = 2_000_000_000;
  const at = (days) => conv._rel_time(now - days * 86400 - 10,
    { lang: 'en', now: () => now });
  assert.equal(at(1), '1 day ago');
  assert.equal(at(2), '2 days ago');
  assert.equal(conv._rel_time(now - 86400 - 10, { lang: 'zh', now: () => now }),
    '1 天前');
});

test('英文回执/对话层/相对时间', async () => {
  assert.equal(await inbound.executeIntent(BINDING, { action: 'unbind', groups: [] },
    'ou_t12a', null, { lang: 'en', dbmod: EMPTY_DB }),
  'Unbound. To bind again, generate a new bind code on the site');
  assert.equal(feishu.bindUser('ZZZZZZ', 'ou_t12a'), '绑定码无效或已被使用');
  assert.equal(conv._rel_time(0, { lang: 'en' }), 'just now');
  assert.equal(conv._leave_session(BINDING, { lang: 'en' }), 'No session is currently bound');
  assertNoChinese(conv._leave_session(BINDING, { lang: 'en' }));
  assertNoChinese(conv._current_text(BINDING, { lang: 'en', dbmod: EMPTY_DB }));
});

test('英文作答校验回执（multiAnswers）+ toast 同语言', () => {
  const [, err] = inbound.multiAnswers(MULTI_CTX.questions, [[1, '9'], [2, '1']],
    { lang: 'en' });
  assert.equal(err, 'Invalid option index for question 1 (2 options)');
  assertNoChinese(err);
  const okToast = inbound.toastFor('✅ Received: card #21 custom answer', 'en');
  assert.equal(okToast.toast.type, 'success');
  assert.equal(okToast.toast.content, '✅ Received; see the bot DM for details');
  const errToast = inbound.toastFor('选项无效', 'en');
  assert.equal(errToast.toast.type, 'error');
  assert.equal(errToast.toast.content, 'Operation failed; see the bot DM for details');
  assertNoChinese(pyJsonDumps(errToast));
});

test('英文面组合扫描：除协议指令词外无中文（防缺词条静默回落）', () => {
  const surfaces = [
    pyJsonDumps(feishu.buildInteractionCard(QUESTION_CTX, 'Demo', 'en')),
    pyJsonDumps(feishu.buildInteractionCard(APPROVAL_CTX, 'Demo', 'en')),
    pyJsonDumps(feishu.buildInteractionCard(MULTI_CTX, 'Demo', 'en')),
    feishu.planQuestionMd(MULTI_CTX, 'en'),
    feishu.planDocMarkdown(
      { ...QUESTION_CTX, session_id: 'sess-1', plan_doc_url: 'https://x/doc' },
      { assistant: 'Do A' }, 'Demo', 'en'),
    feishu.multiClickHint(21, MULTI_CTX.questions, [1], [2], 'en'),
    feishu.multiAnswerHelp(21, MULTI_CTX.questions, 'en'),
    conv._current_text(BINDING, { lang: 'en', dbmod: EMPTY_DB }),
    conv._projects_text(BINDING, { lang: 'en', dbmod: EMPTY_DB }),
    conv._rel_time(0, { lang: 'en' }),
    conv._leave_session(BINDING, { lang: 'en' }),
    inbound.multiAnswers(MULTI_CTX.questions, [[1, '9'], [2, '1']], { lang: 'en' })[1],
    pyJsonDumps(inbound.toastFor('✅ x', 'en')),
  ];
  for (const surface of surfaces) assertNoChinese(surface);
});

test('英文面在卡片上不夹带中文入口文案（未绑定指南/提交按钮）', () => {
  const ctx = {
    card_id: 3, kind: 'question', question: 'Which?', answerable: false,
    questions_count: 1,
  };
  const flat = pyJsonDumps(feishu.buildInteractionCard(ctx, 'Demo', 'en'));
  assert.ok(flat.includes('This waiting cannot be answered remotely'));
  assertNoChinese(flat);
});

test('英文审批回执 + toast 同语言（board 桩，无网络）', async () => {
  const board = {
    interactionOfSid: () => ({ pending: true, kind: 'approval', approval_id: 'a1' }),
    answerApproval: async () => null,
  };
  const reply = await inbound.decideApproval({ id: 1 }, { id: 5, session_id: 's1' },
    'approved', 'session', { lang: 'en', board });
  assert.equal(reply, '✅ Card #5 approved, with similar calls in this session '
    + 'auto-approved; queued for delivery');
  // 无会话范围：词条不带前导空格，分隔空格由英文模板显式给出（Minor 7 约定）
  assert.equal(await inbound.decideApproval({ id: 1 }, { id: 5, session_id: 's1' },
    'approved', '', { lang: 'en', board }), '✅ Card #5 approved; queued for delivery');
  assert.equal(await inbound.decideApproval({ id: 1 }, { id: 5, session_id: 's1' },
    'rejected', '', { lang: 'en', board }), '✅ Card #5 rejected; queued for delivery');
  assertNoChinese(reply);
  const toast = inbound.toastFor(reply, 'en');
  assert.deepEqual(toast, { toast: { type: 'success', content: '✅ Received; see the bot DM for details' } });
});

test('英文作答回执（answerByToken 单选成功）与错误分支', async () => {
  const board = {
    interactionOfSid: () => ({
      pending: true, kind: 'question', answerable: true, qid: 'q1',
      questions: [{ id: 'q_0', options: [{ id: 'o1', label: 'A' }], allow_other: true }],
    }),
    answerInteraction: async () => null,
  };
  const reply = await inbound.answerByToken({ id: 1 }, { id: 5, session_id: 's1' }, '1',
    { lang: 'en', board });
  assert.equal(reply, '✅ Received: card #5 chose "A", queued for delivery');
  assertNoChinese(reply);
  const failedBoard = {
    ...board,
    answerInteraction: async () => 'gate blocked',
  };
  const failed = await inbound.answerByToken({ id: 1 }, { id: 5, session_id: 's1' }, '1',
    { lang: 'en', board: failedBoard });
  assert.equal(failed, 'Answer failed: gate blocked');
  assertNoChinese(failed);
});

// ---------------------------------------------------------------------------
// ④ 审查 Fix round 1：默认项目语言接线 + 答复截断后缀语言
// ---------------------------------------------------------------------------

test('默认项目文本回执按收件人语言（Important 1；与 Python 同一 payload）', async () => {
  const writes = [];
  const dbmod = {
    listProjects: () => [{ id: 7, name: 'proj-en', user_id: 990001 }],
    setFeishuDefaultProject: (openId, pid) => { writes.push([openId, pid]); },
  };
  const convBridge = {
    async setDefaultProject(binding, project, opts) {
      return conv.setDefaultProject(binding, project, opts);
    },
  };
  const call = (lang, name) => inbound.executeIntent(
    BINDING, { action: 'default_project', groups: [name] }, 'ou_t12a', null,
    { lang, dbmod, conv: convBridge });
  const replyEn = await call('en', 'proj-en');
  assert.equal(replyEn, 'Default project set to "proj-en"');
  assertNoChinese(replyEn);
  assert.deepEqual(writes, [['ou_t12a', 7]], '写默认项目仍走同一段写路径');
  assert.equal(await call('zh', 'proj-en'), '默认项目已设为「proj-en」');
  const errEn = await call('en', 'nope');
  assert.equal(errEn, 'Project "nope" is not in your project list');
  assertNoChinese(errEn);
  // 按 id 路径（卡片 t=dp 共用写口）的错误文案同样跟随语言
  assert.equal(await inbound.setDefaultProject(BINDING, '', 999, {
    lang: 'en',
    conv: { projectById: () => null },
  }), 'The project is not in your project list');
});

test('答复回流截断后缀按提交者语言（Important 2；en 长文 / zh 不变）', async () => {
  const suffixEn = '\n…… (content too long and truncated; '
    + 'see the site session window / board for the full text)';
  const suffixZh = '\n……（内容过长已截断，完整内容见站点会话窗 / 看板）';
  const run = async (lang) => {
    const sent = [];
    const options = {
      cfg: { userLang: () => lang },
      dbmod: { getFeishuBindingByOpen: () => ({ open_id: 'ou_clip', user_id: 990006 }) },
      waitq: {
        msgMeta: () => ({ feishu: { open_id: 'ou_clip', user_id: 990006, baseline: 0 } }),
        msgGet: () => ({ sid: 's1' }),
      },
      sessparse: {
        load: () => ({
          found: true,
          entries: [{ kind: 'assistant', text: 'x'.repeat(conv.REPLY_MAX_CHARS + 1) }],
        }),
      },
      feishu: { appConfig: () => ({ app_id: 'cli_x', app_secret: 'sec_x' }) },
      rest: { async restSendText(openId, text) { sent.push([openId, text]); } },
      log: () => {},
    };
    await conv.notifyMsgDone(`m-${lang}`, 'done', options);
    assert.equal(sent.length, 1, '答复必须真的投递（不是被跳过）');
    assert.equal(sent[0][0], 'ou_clip');
    return sent[0][1];
  };
  const en = await run('en');
  assert.ok(en.endsWith(suffixEn), `en 截断后缀仍非英文: ${JSON.stringify(en.slice(-120))}`);
  assertNoChinese(en);
  const zh = await run('zh');
  assert.ok(zh.endsWith(suffixZh));
});
