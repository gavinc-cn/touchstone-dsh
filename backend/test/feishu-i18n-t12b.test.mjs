/**
 * Task 12b：飞书群推送/接入自检/媒体/看板指令/slash·help 本地化 —— Node 验收测试
 * （与 `tests/test_feishu_i18n_t12b.py` 镜像，两端共用同一组 golden）。
 *
 * 判据：
 *   ① zh 逐字节保全：无偏好 / `TS_I18N=0` 时七类代表 payload 的 sha256 与改动前
 *      HEAD（`cdf050f`）相同（golden 与 Python 测试同源）；
 *   ② 英文面：同一 ctx 的 en 渲染逐字断言 + sha256 与 Python 孪生**同一组常量**
 *      （`EN_GOLDEN`）⇒ 两端 payload 逐字节相同；
 *   ③ 语言源（R22）：群推送=项目所有者；接入/自检/媒体/看板/帮助/slash=收件人；
 *      无偏好/坏值/读库异常 ⇒ zh；`TS_I18N=0` ⇒ zh 且**零偏好读库**（真计数断言，
 *      不是「一碰就抛被兜底吞掉」的假绿）；
 *   ④ R23：slash 注册说明保持中文，只本地化回复/帮助/权限卡。
 *
 * 全程离线：REST/db 均以桩/临时库注入，绝不发真实飞书请求。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as feishu from '../lib/feishu.js';
import { userLang, projectLang } from '../lib/feishu_cfg.js';
import * as inbound from '../lib/feishu_inbound.js';
import { doctor, _LAST_PROBE_TS } from '../lib/feishu_provision.js';
import { FeishuRestError, _TOKEN_CACHE } from '../lib/feishu_rest.js';
import * as slash from '../lib/feishu_slash.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import { freshDb, insertProject } from './m3fixture.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const shaObj = (obj) => sha256(pyJsonDumps(obj));

/** 改动前 HEAD（cdf050f）同 ctx 的 sha256（与 Python 测试 `ZH_GOLDEN` 逐字相同） */
const ZH_GOLDEN = {
  push_group: 'ea77f449188f24b4ee37351c104ff2f0b717fd88831b13a418174f43a3009679',
  push_payload: '88ffc2130423fdee230b5559f782b0384221a9db3cdd4572ec69be06aeb4b477',
  setup_card: '815792f877b10a143eb3a6c152299a3e583b8487773dda9225520b3e7dd542bb',
  doctor_msg: '88af92fae4dbf39bbf3abdd55c722510c4030f48e81400e9b885298da562b0f1',
  board_card_detail: '4df5b967f149d8055ab899bcb558745977538db633f1cf5491883ecc74ded1ea',
  help_reply: '8ce024e221ea301186e6f718dd0a1402c007c829090ae136feedab4ba5a585bc',
  slash_perm_card: '576b947afa4d62a0dce7b4a23ad710699671c21b1834bc835c2d61337208633a',
};
/** 同一组 ctx 的英文渲染 sha256（与 Python 测试 `EN_GOLDEN` 逐字相同） */
const EN_GOLDEN = {
  push_group: '39db043790eeac1966678f34cac3b7103429e2a464d16748241578f430caa1e2',
  push_payload: '3af5c1513405cd067564dfd120f1db44d6e13458409c4e2b381c91a660000e2d',
  setup_card: '78fdb8b2d871b39b29d1c3d4fcf655c8d64a254c98b5838ea5e0f3671e7ae3b0',
  doctor_msg: '6cb26cd7092b126cfd7f39da71e0b55c49611dab0b1c50573d7bc134ff80a18e',
  board_card_detail: '97a34a8de511e2fb61df8f5bffceda049fff6148c0d9f3240f9f2abe054e5283',
  help_reply: '68893a059d5b8afeaec1a0fa81cf27f11eb395af87bb09fe28955d5e8e32d189',
  slash_perm_card: '5563b42b600291a8595264abda962791069f7eb85d67e56dcae7426f2b7f64db',
};
/** 修复轮：doctor「发送测试消息」DM 的 en sha256（Python 孪生断言同一常量） */
const EN_DOCTOR_PROBE_SHA = '431bff5f5264dbb635814cd90aabdf3ca8afea31e3abba8a5013296cf737c080';

const HAN = /[\u4e00-\u9fff]/;
const PROTOCOL_TOKENS = [
  '新建会话', '绑定会话', '解绑会话', '默认项目',
  '帮助', '接入', '绑定', '解绑', '当前', '项目', '会话', '状态', '卡片',
  '通过', '驳回', '作答', '同意', '拒绝', '「设置」',
];

function assertNoChinese(text, extra = []) {
  let cleaned = text;
  for (const token of [...new Set([...PROTOCOL_TOKENS, ...extra])]
    .sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.split(token).join('');
  }
  assert.equal(HAN.test(cleaned), false, `英文面仍含中文: ${JSON.stringify(text)}`);
}

const ZH_PUSH_CTX = {
  card_id: 7, title: '登录接口调试', kind: 'question',
  question: '用哪个方案？', options: ['方案甲', '方案乙'],
  multi_select: false, allow_other: false, answerable: true, questions_count: 1,
};
const EN_PUSH_CTX = {
  card_id: 7, title: 'Login API', kind: 'question',
  question: 'Which plan?', options: ['Plan A', 'Plan B'],
  multi_select: false, allow_other: false, answerable: true, questions_count: 1,
};
// 多子题 / 审批推送的 en 渲染（T12b 修复轮补的 golden；与 Python 孪生同一组 sha256）
const EN_MULTI_PUSH_CTX = {
  card_id: 12, title: 'Multi-question card', kind: 'question', answerable: true,
  questions: [
    { header: 'Plan', question: 'Which plan?',
      options: [{ label: 'Plan A', description: 'faster' }, { label: 'Plan B' }] },
    { header: 'Scope', question: 'Which scope?', options: ['Small', 'Large'],
      multi_select: true, allow_other: true },
  ],
};
const EN_APPROVAL_PUSH_CTX = { card_id: 9, title: 'Approval card', kind: 'approval',
  tool: 'Bash', action: 'run tests', input: 'npm test' };
const EN_MULTI_PUSH_SHA = '61c5ab10a6c5a0f04e8da275b10dd3a2e1240e4d862fb8b83fc773447ea815da';
const EN_APPROVAL_PUSH_SHA = 'dacdf313e9796fad67e8871051b67f0d9e9a118ec336a462d93901f670fd60d7';
const ZH_BOARD = [{ name: '对拍项目' },
  { id: 9, title: '待审卡片', column_key: 'blocked', block_text: '等依赖',
    last_error: 'timeout' }];
const EN_BOARD = [{ name: 'Demo' },
  { id: 9, title: 'Pending card', column_key: 'blocked', block_text: 'waiting on dep',
    last_error: 'timeout' }];
const DOCTOR_ZH = {
  summary: { ok: 3, fail: 1, warn: 0, skip: 4 },
  items: [
    { key: 'creds', label: '应用凭据', state: 'fail', detail: '未配置',
      hint: '去设置页保存' },
    { key: 'token', label: 'token', state: 'ok', detail: 'ok', hint: '' },
  ],
};
const DOCTOR_EN = {
  summary: { ok: 3, fail: 1, warn: 0, skip: 4 },
  items: [
    { key: 'creds', label: 'App credentials', state: 'fail',
      detail: 'not configured', hint: 'save them on the settings page' },
    { key: 'token', label: 'token', state: 'ok', detail: 'ok', hint: '' },
  ],
};

const UID = 992001;
const UID_OWNER = 992002;
const BINDING = {
  open_id: 'ou_t12b', user_id: UID, cur_sid: '', cur_title: '', cur_bound_at: '',
  cur_project_id: 0, default_project_id: 0,
};

/** 七类代表 payload（中文语境中文数据；英文语境 ASCII 数据）。 */
async function payloads(tag, lang, projectName, projectId) {
  const fx = freshDb(tag);
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    const pid = insertProject(fx.db, { userId: 1, name: projectName });
    const push = feishu.render('blocked_interaction',
      lang === 'zh' ? ZH_PUSH_CTX : EN_PUSH_CTX, pid, 'https://ts.example',
      { ...options, lang });
    const captured = [];
    const doctorOptions = {
      ...options,
      rest: { async restSendText(openId, text) { captured.push(text); } },
      provision: {
        doctor: () => (lang === 'zh' ? DOCTOR_ZH : DOCTOR_EN),
      },
      log: () => {},
    };
    await inbound.setupSlowAction(1, 'ou_x', 'doctor', null, doctorOptions, lang);
    return {
      push_group: push,
      push_payload: feishu.payload(push),
      setup_card: inbound.setupCard(1, 'cli_new', 'cli_old', 'nonce1234', lang),
      doctor_msg: captured[0],
      board_card_detail: inbound.cardDetail(...(lang === 'zh' ? ZH_BOARD : EN_BOARD),
        lang),
      help_reply: inbound.helpText(lang),
      slash_perm_card: slash.slashPermCard('cli_x', 7, lang),
    };
  } finally {
    fx.close();
  }
}

function hashes(p) {
  return {
    push_group: sha256(p.push_group),
    push_payload: sha256(p.push_payload),
    setup_card: shaObj(p.setup_card),
    doctor_msg: sha256(p.doctor_msg),
    board_card_detail: sha256(p.board_card_detail),
    help_reply: sha256(p.help_reply),
    slash_perm_card: shaObj(p.slash_perm_card),
  };
}

// ---------------------------------------------------------------------------
// ① zh 逐字节保全
// ---------------------------------------------------------------------------

test('zh 七类 payload 逐字节等于改动前 HEAD golden', async () => {
  assert.deepEqual(hashes(await payloads('t12b-zh', 'zh', '对拍项目')),
    ZH_GOLDEN);
});

test('TS_I18N=0：恒 zh、零偏好读库（真计数）、全量 golden 不变', async () => {
  const prev = process.env.TS_I18N;
  process.env.TS_I18N = '0';
  try {
    let touched = 0;
    const statements = [];
    // 计数句柄：任何读库都 +1（不是「一碰就抛」——那会被 userLang 的兜底吞掉）；
    // 同时记录 SQL，用于断言「只允许读绑定行，绝不读 user_prefs」。
    const countingDb = {
      prepare(sql) {
        touched += 1;
        statements.push(sql);
        if (/FROM feishu_bindings/.test(sql)) {
          return { get: () => ({ ...BINDING }), all: () => [], run: () => ({}) };
        }
        throw new Error(`TS_I18N=0 must not read: ${sql}`);
      },
      exec(sql) {
        touched += 1;
        statements.push(sql);
        throw new Error(`TS_I18N=0 must not exec: ${sql}`);
      },
    };
    assert.equal(userLang(UID, { db: countingDb }), 'zh');
    assert.equal(projectLang(42, { db: countingDb }), 'zh');
    assert.equal(touched, 0, `TS_I18N=0 时 userLang/projectLang 读了库 ${touched} 次`);
    assert.deepEqual(hashes(await payloads('t12b-zh-off', 'zh', '对拍项目')),
      ZH_GOLDEN);
    assert.equal(touched, 0, `出站 builder 读了库 ${touched} 次`);

    // 入口级：help 指令（真实 db 访问层 + 计数句柄；只允许一次绑定行读）
    const replies = [];
    const options = {
      db: countingDb,
      rest: { async restReply(mid, text) { replies.push(text); } },
      log: () => {},
    };
    await inbound.handleMessageEvent({
      message_id: 'm-t12b-zero', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: '帮助' }), sender_open_id: 'ou_t12b',
    }, null, options);
    assert.deepEqual(replies, [inbound.HELP_TEXT]);
    assert.equal(statements.length, 1,
      `入口路径读库 ${statements.length} 次: ${JSON.stringify(statements)}`);
    assert.match(statements[0], /FROM feishu_bindings/);
    assert.equal(statements.some((s) => s.includes('user_prefs')), false,
      'TS_I18N=0 不得读偏好');

    // 媒体早退档（媒体关）：TS_I18N=0 ⇒ **零读库**（修复项：不再提前读绑定行）
    statements.length = 0;
    const mediaReplies = [];
    await inbound.handleMediaMessage({
      message_id: 'm-t12b-zero-media', message_type: 'image',
      content: JSON.stringify({ image_key: 'img' }), chat_type: 'p2p',
      mentions: [], sender_open_id: 'ou_t12b',
    }, null, {
      db: countingDb,
      rest: { async restReply(mid, text) { mediaReplies.push(text); } },
      log: () => {},
      env: { TS_FEISHU_MEDIA: '0' },
    });
    assert.deepEqual(mediaReplies, [inbound.MEDIA_TYPE_HINT]);
    assert.equal(statements.length, 0,
      `媒体早退档仍读库: ${JSON.stringify(statements)}`);
  } finally {
    if (prev === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = prev;
  }
});

// ---------------------------------------------------------------------------
// ② 英文面（实际 payload + 双端同 sha）
// ---------------------------------------------------------------------------

test('英文七类 payload：逐字断言 + sha256 与 Python 孪生同常量', async () => {
  const p = await payloads('t12b-en', 'en', 'Demo');
  assert.ok(p.push_group.startsWith(
    '🤔 Card awaiting reply [Demo]\nCard #7 Login API\n'));
  assert.ok(p.push_group.includes('agent question: Which plan?'));
  assert.ok(p.push_group.includes(
    'Reply 「作答 7 <option index>」 in Feishu to answer with an option'));
  assert.ok(p.push_group.endsWith('Details: https://ts.example'));

  assert.equal(p.setup_card.header.title.content, '🔁 Feishu app changed');
  const buttons = p.setup_card.body.elements.filter((e) => e.tag === 'button')
    .map((e) => e.text.content);
  assert.deepEqual(buttons, ['🔁 Switch to new app', '🔑 Generate bind code',
    '🩺 Run self-check', '🧩 Apply config', '🚀 Publish']);
  assert.ok(p.setup_card.body.elements[0].content
    .includes('**Current app**: `cli_new`'));
  assert.ok(p.setup_card.body.elements[0].content
    .includes('Running · bound to `cli_old`'));

  assert.equal(p.doctor_msg,
    '🩺 Configuration self-check: ok 3 / fail 1 / warn 0 / skip 4\n'
    + '· App credentials: not configured (save them on the settings page)');
  assert.equal(p.board_card_detail,
    'Card #9 [Demo] Pending card\n'
    + 'Status: Blocked\n'
    + 'Blocked reason: waiting on dep\n'
    + 'Last error: timeout\n'
    + 'Reply 「作答 9 <option index|text>」 to answer; 「同意 9」/「拒绝 9」 '
    + 'for approvals; 「通过 9」 to approve; 「驳回 9 <comment>」 to send back');
  assert.ok(p.help_reply.startsWith('Touchstone commands (DM only):\n'));
  assert.ok(p.help_reply.includes('· 帮助 — this help'));
  assert.equal(p.slash_perm_card.header.title.content,
    '🔑 Slash command permission required');
  assert.deepEqual(hashes(p), EN_GOLDEN);
});

test('英文面除协议指令词外无中文（防词条缺失静默回落）', async () => {
  const p = await payloads('t12b-en-scan', 'en', 'Demo');
  assertNoChinese(p.push_group);
  assertNoChinese(pyJsonDumps(p.setup_card));
  assertNoChinese(p.doctor_msg);
  assertNoChinese(p.board_card_detail);
  assertNoChinese(p.help_reply);
  assertNoChinese(pyJsonDumps(p.slash_perm_card));
});

// ---------------------------------------------------------------------------
// ③ 语言源接线（R22）
// ---------------------------------------------------------------------------

test('群推送按项目所有者偏好（en）；无偏好所有者 ⇒ zh', () => {
  const fx = freshDb('t12b-owner');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID_OWNER, 0, 'lang', { v: 'en' }, options);
    const pidEn = insertProject(fx.db, { userId: UID_OWNER, name: 'proj-owner-en' });
    const pidZh = insertProject(fx.db, { userId: UID, name: 'proj-owner-zh' });
    db.setFeishuUserCfg(UID_OWNER, {
      enabled: true, push_enabled: true, default_webhook: 'http://hook',
      default_secret: '', base_url: 'https://ts.example',
    }, options);
    db.setFeishuUserCfg(UID, {
      enabled: true, push_enabled: true, default_webhook: 'http://hook',
      default_secret: '', base_url: 'https://ts.example',
    }, options);
    feishu.pushEvent(pidEn, 'blocked_interaction', EN_PUSH_CTX, options);
    const rowEn = fx.db.prepare(
      'SELECT payload FROM feishu_outbox ORDER BY id DESC LIMIT 1').get();
    const textEn = JSON.parse(rowEn.payload).content.text;
    assert.ok(textEn.startsWith('🤔 Card awaiting reply [proj-owner-en]'));
    assertNoChinese(textEn);
    feishu.pushEvent(pidZh, 'blocked_interaction', ZH_PUSH_CTX, options);
    const rowZh = fx.db.prepare(
      'SELECT payload FROM feishu_outbox ORDER BY id DESC LIMIT 1').get();
    const textZh = JSON.parse(rowZh.payload).content.text;
    assert.ok(textZh.startsWith('🤔 卡片等待回复 [proj-owner-zh]'));
    assert.ok(textZh.includes('agent 提问：'));
  } finally {
    fx.close();
  }
});

test('接入卡/权限卡/看板/媒体/帮助按收件人（绑定用户）语言', async () => {
  const fx = freshDb('t12b-recipient');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    db.setFeishuUserCfg(UID, { app_id: 'cli_x', app_secret: 's' }, options);
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    const cards = [];
    const sent = [];
    const replies = [];
    const opts = {
      ...options,
      rest: {
        async restSendCard(openId, card) { cards.push(card); },
        async restSendText(openId, text) { sent.push(text); },
        async restReply(mid, text) { replies.push(text); },
      },
      log: () => {},
    };

    // 接入卡（发卡入口按收件人语言解析一次）
    const [okSetup] = await inbound.sendSetupCard(UID, null, opts);
    assert.equal(okSetup, true);
    assert.equal(cards.at(-1).header.title.content, '🛠 Feishu setup actions');
    assertNoChinese(pyJsonDumps(cards.at(-1)));

    // slash 权限卡回调：DM 与 toast 同语言
    const toastOut = await inbound.onSlashPermAction('ou_t12b', { u: UID }, null, {
      ...opts,
      slash: { async syncSlashCommands() {
        return { ok: true, created: ['a'], updated: [], kept: ['b'], failed: [] };
      } },
    });
    assert.deepEqual(toastOut,
      { toast: { type: 'success', content: 'Registration complete' } });
    assert.ok(sent.at(-1).startsWith(
      '✅ Slash command registration complete: Created 1, updated 0, '
      + 'already up to date 1'));
    assertNoChinese(sent.at(-1));

    // 看板「状态」：入口（langOfBinding）解析一次
    const pid = insertProject(fx.db, { userId: UID, name: 'proj-en-board' });
    const binding = db.getFeishuBindingByOpen('ou_t12b', options);
    const status = await inbound.executeIntent(
      { ...binding, default_project_id: pid }, { action: 'status', groups: [null] },
      'ou_t12b', null, options);
    assert.ok(status.startsWith('[proj-en-board] Tasks: running 0 / queued 0'));
    assert.ok(status.includes(
      'Board: To Do 0 In progress 0 Blocked 0 In review 0 Done 0'));
    assertNoChinese(status);

    // 媒体回执（关闭档）按收件人语言
    await inbound.handleMediaMessage({
      message_id: 'm-en-media', message_type: 'image',
      content: JSON.stringify({ image_key: 'img' }), chat_type: 'p2p',
      mentions: [], sender_open_id: 'ou_t12b',
    }, null, { ...opts, env: { ...opts.env, TS_FEISHU_MEDIA: '0' } });
    assert.deepEqual(replies.at(-1),
      'This message type is not supported yet; send a text command');
    assertNoChinese(replies.at(-1));

    // 帮助回复
    await inbound.handleMessageEvent({
      message_id: 'm-en-help', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: '帮助' }), sender_open_id: 'ou_t12b',
    }, null, opts);
    assert.ok(replies.at(-1).startsWith('Touchstone commands (DM only):'));
  } finally {
    fx.close();
  }
});

test('无偏好/坏值/读库异常 ⇒ 帮助回中文（绝不抛错）', async () => {
  const fx = freshDb('t12b-fallback');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    const replies = [];
    const run = async (mid, extra = {}) => {
      await inbound.handleMessageEvent({
        message_id: mid, chat_type: 'p2p', message_type: 'text',
        content: JSON.stringify({ text: '帮助' }), sender_open_id: 'ou_t12b',
      }, null, {
        ...options, ...extra,
        rest: { async restReply(m, text) { replies.push(text); } },
        log: () => {},
      });
      return replies.at(-1);
    };
    assert.equal(await run('m-none'), inbound.HELP_TEXT);
    for (const [i, bad] of [{ v: 'fr' }, { v: '' }, 'en', 123, { v: ['en'] }]
      .entries()) {
      db.setUserPref(UID, 0, 'lang', bad, options);
      assert.equal(await run(`m-bad-${i}`), inbound.HELP_TEXT, JSON.stringify(bad));
    }
    // 读库异常：userLang 内部兜底（绝不抛），仍回中文
    const brokenDb = { prepare() { throw new Error('db down'); }, exec() {} };
    assert.equal(await run('m-err', {
      db: brokenDb,
      dbmod: { getFeishuBindingByOpen: () => ({ ...BINDING }) },
    }), inbound.HELP_TEXT);
  } finally {
    fx.close();
  }
});

test('媒体失败回执按收件人语言（截图过大档，零 routeText）', async () => {
  const fx = freshDb('t12b-media-en');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    const replies = [];
    const opts = {
      ...options,
      rest: {
        async restReply(mid, text) { replies.push(text); },
        async restBytes() {
          return { data: Buffer.alloc(inbound.MEDIA_MAX_BYTES + 1),
            contentType: 'image/png' };
        },
      },
      conv: { async enabled() { return true; }, async routeText() { throw new Error('不应投递'); } },
      log: () => {},
    };
    await inbound.handleMediaMessage({
      message_id: 'm-en-too-big', message_type: 'image',
      content: JSON.stringify({ image_key: 'img' }), chat_type: 'p2p',
      mentions: [], sender_open_id: 'ou_t12b',
    }, null, opts);
    assert.deepEqual(replies, ['Screenshot receive failed: Image too large '
      + '(10MB per image); compress it and send it again']);
    assertNoChinese(replies[0]);
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// ③b 修复轮：自检探针 / 发卡失败 / slash 重试诊断 / 多子题·审批推送
// ---------------------------------------------------------------------------

/** 整数响应的最小 Response 替身（fetch 桩用；与 `feishu_rest.js` 的取用口径一致） */
function fetchResponse(body, status = 200) {
  return new Response(pyJsonDumps(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

test('doctor 探针 DM 按收件人语言（en 入口级；不探测不读偏好）', async () => {
  const fx = freshDb('t12b-doctor-probe');
  const realFetch = globalThis.fetch;
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    db.setFeishuUserCfg(UID, { app_id: 'cli_probe', app_secret: 's' }, options);
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    _TOKEN_CACHE.set('cli_probe', {
      token: 't-probe', expire: Date.now() / 1000 + 3600,
    });
    _LAST_PROBE_TS.delete(UID);
    const sent = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/open-apis/bot/v3/info')) {
        return fetchResponse({ code: 0, bot: { activate_status: 2, app_name: 'Bot' } });
      }
      if (url.includes('/open-apis/application/v7/app_slash_commands')) {
        return fetchResponse({ code: 0, data: { items: [] } });
      }
      if (url.includes('/open-apis/im/v1/messages')) {
        sent.push(JSON.parse(init.body));
        return fetchResponse({ code: 0, data: {} });
      }
      throw new Error(`替身 fetch 收到未脚本化请求：${url}`);
    };
    const out = await doctor(UID, true, options);
    assert.equal(out.items.find((i) => i.key === 'send_scope').state, 'ok');
    assert.equal(sent.length, 1);
    const text = JSON.parse(sent[0].content).text;
    assert.equal(text, '🔍 Touchstone config self-check: if you received this '
      + 'message, the “send messages” permission is enabled.');
    assert.equal(sha256(text), EN_DOCTOR_PROBE_SHA);
    assertNoChinese(text);

    // 不探测 ⇒ 不解析语言：包一层计数句柄，断言 SQL 里没有 user_prefs
    const sqls = [];
    const wrapped = {
      prepare(sql) { sqls.push(sql); return fx.db.prepare(sql); },
      exec(sql) { sqls.push(sql); return fx.db.exec(sql); },
      close() {},
    };
    _LAST_PROBE_TS.delete(UID);
    await doctor(UID, false, { ...options, db: wrapped });
    assert.equal(sqls.some((s) => s.includes('user_prefs')), false,
      `未发消息却读偏好: ${JSON.stringify(sqls)}`);
  } finally {
    _TOKEN_CACHE.delete('cli_probe');
    _LAST_PROBE_TS.delete(UID);
    globalThis.fetch = realFetch;
    fx.close();
  }
});

test('sendSetupCard REST 失败：en 内层去中文前缀；zh 历史双前缀不变', async () => {
  const fx = freshDb('t12b-setup-fail');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    db.setFeishuUserCfg(UID, { app_id: 'cli_x', app_secret: 's' }, options);
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    const replies = [];
    const opts = {
      ...options,
      rest: {
        async restSendCard() {
          throw new FeishuRestError('send failed code=230001', 230001);
        },
        async restReply(mid, text) { replies.push(text); },
      },
    };
    assert.deepEqual(await inbound.sendSetupCard(UID, null, opts),
      [false, 'send failed code=230001']);
    await inbound.handleMessageEvent({
      message_id: 'om-en-setup-fail', message_type: 'text',
      content: '{"text": "接入"}', chat_type: 'p2p', mentions: [],
      sender_open_id: 'ou_t12b',
    }, null, opts);
    assert.equal(replies.at(-1),
      'Failed to send the card: send failed code=230001');
    assertNoChinese(replies.at(-1));

    // zh 控制线：历史形态是「内层前缀 + 外层前缀」两次（既有用例也钉着它）
    db.setUserPref(UID, 0, 'lang', { v: 'zh' }, options);
    await inbound.handleMessageEvent({
      message_id: 'om-zh-setup-fail', message_type: 'text',
      content: '{"text": "接入"}', chat_type: 'p2p', mentions: [],
      sender_open_id: 'ou_t12b',
    }, null, opts);
    assert.equal(replies.at(-1),
      '卡片发送失败：卡片发送失败：send failed code=230001');
  } finally {
    fx.close();
  }
});

test('权限卡重试失败 DM：slash 诊断随收件人语言（en）；zh 默认逐字不变', async () => {
  const fx = freshDb('t12b-slash-hint');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    db.setFeishuUserCfg(UID, { app_id: 'cli_x', app_secret: 's' }, options);
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    const sent = [];
    const seenLang = [];
    const opts = {
      ...options,
      rest: { async restSendText(openId, text) { sent.push(text); } },
      slash: {
        async syncSlashCommands(userId, inner = {}) {
          seenLang.push(inner.lang);
          return {
            ok: false, need_scope: true,
            error: slash.slashErrorHint(
              new FeishuRestError('REST code=99991672', 99991672), inner.lang),
          };
        },
      },
    };
    const out = await inbound.onSlashPermAction('ou_t12b', { u: UID }, null, opts);
    assert.deepEqual(seenLang, ['en']);
    assert.deepEqual(out,
      { toast: { type: 'error', content: 'Still unsuccessful; see the DM reply' } });
    assert.ok(sent[0].startsWith('❌ Still unsuccessful: The app lacks the '
      + '“app slash command” permission:'), sent[0]);
    assertNoChinese(sent[0]);

    // zh 默认路径：三个固定引导逐字不变（设置页数据面/对拍走默认 lang='zh'）
    assert.equal(slash.slashErrorHint(new FeishuRestError('x', 99991640)),
      '应用缺少「应用指令」权限：飞书开发者后台 → 权限管理，添加 '
      + 'application:app_slash_command:read 与 write，创建并发布新版本后重试');
    assert.equal(slash.slashErrorHint(new FeishuRestError('x', 40000031)),
      '指令图标 icon_key 不合法（取值见官方 Slash Command Icon Key 说明）');
    assert.equal(slash.slashErrorHint(new FeishuRestError('x', 99992402)),
      '指令参数校验失败：指令名需为不含「/」的标识符，说明不可为空');
    for (const code of [99991640, 40000031, 99992402]) {
      assertNoChinese(slash.slashErrorHint(new FeishuRestError('x', code), 'en'));
    }
  } finally {
    fx.close();
  }
});

test('多子题 / 审批推送 en 渲染：逐字断言 + 与 Python 孪生同 sha256', () => {
  const fx = freshDb('t12b-en-multi');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    const pid = insertProject(fx.db, { userId: 1, name: 'Demo' });
    const multi = feishu.render('blocked_interaction', EN_MULTI_PUSH_CTX, pid,
      'https://ts.example', { ...options, lang: 'en' });
    const approval = feishu.render('blocked_interaction', EN_APPROVAL_PUSH_CTX,
      pid, 'https://ts.example', { ...options, lang: 'en' });
    assert.equal(sha256(multi), EN_MULTI_PUSH_SHA);
    assert.equal(sha256(approval), EN_APPROVAL_PUSH_SHA);
    assert.ok(multi.startsWith('🤔 Card awaiting reply [Demo]\n'
      + 'Card #12 Multi-question card\nagent questions (2 in total):'));
    assert.ok(multi.includes('[1/2 Plan]Which plan?'));
    assert.ok(multi.includes('[2/2 Scope]Which scope?'));
    assert.ok(multi.includes('(Multi-select; Custom: Other)'));
    assert.ok(multi.includes('This question has 2 sub-questions'));
    assertNoChinese(multi);
    assert.equal(approval,
      '🤔 Card awaiting reply [Demo]\nCard #9 Approval card\n'
      + 'Approval request: run tests\nTool: Bash\nInput: npm test\n'
      + 'Reply 「同意 9」 in Feishu to approve, 「拒绝 9」 to reject; '
      + '「同意 9 会话」 auto-approves similar calls in this session\n'
      + 'Details: https://ts.example');
    assertNoChinese(approval);
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// ④ R23：slash 注册 schema 保持中文
// ---------------------------------------------------------------------------

test('slash 注册说明保持中文；只回复/帮助/权限卡本地化', () => {
  const expected = [
    '查看可用指令', '绑定站点账号：/bind 绑定码', '解除站点账号绑定',
    '设置默认项目：/project 项目名', '查看默认项目与当前会话',
    '项目总览卡：点选设为默认项目', '默认项目最近会话：点选绑定',
    '在默认项目下新建会话并绑定：/new [标题]',
    '绑定已有会话：/use 序号|关键字|会话id前缀', '解绑当前会话（保留默认项目）',
    '查看任务与看板摘要：/status [项目名]',
    '查找卡片：/cards 关键字（id 前缀 / 标题包含）',
    '通过待审核卡片：/approve 卡片', '驳回卡片继续开发：/reject 卡片 意见',
    '回复 agent 提问：/answer 卡片 选项序号|文字',
    '批准挂起的工具审批：/agree 卡片 [session]',
    '拒绝挂起的工具审批：/deny 卡片',
  ];
  assert.deepEqual(slash.SLASH_COMMANDS.map((row) => row[1]), expected);
  for (const row of slash.SLASH_COMMANDS) assert.ok(HAN.test(row[1]), row[1]);
  // 权限卡（DM 回复面）随收件人语言；注册说明本身没有 en 版本
  const en = slash.slashPermCard('cli_x', 7, 'en');
  assert.equal(en.header.title.content, '🔑 Slash command permission required');
  assert.equal(slash.slashPermCard('cli_x', 7).header.title.content,
    '🔑 需要开通「应用指令」权限');
  // 英文帮助仍保留中文指令词
  for (const token of ['帮助', '接入', '绑定', '解绑', '当前', '项目', '会话',
    '新建会话', '绑定会话', '解绑会话', '默认项目', '状态', '卡片', '通过',
    '驳回', '作答', '同意', '拒绝']) {
    assert.ok(inbound.helpText('en').includes(token), token);
  }
});

// ---------------------------------------------------------------------------
// ⑤ R26 结转（T12c）：apply/publish 慢动作 DM 的 en 入口级 + setup 内层整句 en
// ---------------------------------------------------------------------------

test('R26：apply/publish 慢动作结果 DM 的 en 入口级（按钮回调）', async () => {
  const fx = freshDb('t12c-setup-slow');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    db.setFeishuBinding('ou_t12b', UID, 0, options);
    const sent = [];
    const out = { apply: { ok: true }, publish: { ok: true, version: '1.2.3' } };
    const opts = {
      ...options,
      rest: { async restSendText(openId, text) { sent.push(text); } },
      provision: {
        async provisionApply() { return out.apply; },
        async provisionPublish() { return out.publish; },
      },
      log: () => {},
    };
    inbound.resetSetupState();
    const okToast = {
      toast: { type: 'success',
        content: 'Received; I will send the result to your DM shortly' },
    };
    const click = async (action) => {
      const nonce = `n-${action}`;
      inbound._SETUP_NONCES.set(nonce, [UID, Date.now() / 1000 + 60]);
      const toast = await inbound.onSetupCardAction(
        'ou_t12b', { t: 'fs', a: action, u: UID, n: nonce }, null, opts);
      // Node 侧慢动作是 `void setupSlowAction(...)`（不 await）⇒ 让出一轮宏任务
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      return toast;
    };

    assert.deepEqual(await click('apply'), okToast);
    assert.equal(sent.at(-1),
      '🧩 Configuration applied: bot ability / permissions / long-connection '
      + 'subscription / events / callbacks written (publish a new version for '
      + 'them to take effect).');
    assert.deepEqual(await click('publish'), okToast);
    assert.equal(sent.at(-1),
      '🚀 Submitted version 1.2.3 for publishing; a tenant admin must still '
      + 'approve it before it takes effect online.');
    out.apply = { ok: false, error: 'boom' };
    out.publish = { ok: false, error: 'boom' };
    // 失败分支同样先回「已收到」toast 再走慢动作（ACK 与结果无关）：
    // 旧版这里只调 click 不断言，测试名里的「四分支 + toast」有一半是空的。
    assert.deepEqual(await click('apply'), okToast);
    assert.equal(sent.at(-1), '❌ Failed to apply configuration: boom');
    assert.deepEqual(await click('publish'), okToast);
    assert.equal(sent.at(-1), '❌ Failed to submit for publishing: boom');
    assertNoChinese(sent.join('\n'));

    // zh 控制线：偏好 zh 的默认路径逐字节等于旧文案（toast 也为中文）
    db.setUserPref(UID, 0, 'lang', { v: 'zh' }, options);
    out.apply = { ok: true };
    assert.deepEqual(await click('apply'), {
      toast: { type: 'success', content: '已收到，结果稍后私聊发你' },
    });
    assert.equal(sent.at(-1),
      '🧩 配置补齐成功：机器人能力 / 权限 / 长连接订阅 / 事件 / '
      + '回调已写入（需发布新版本生效）。');
  } finally {
    inbound.resetSetupState();
    fx.close();
  }
});

test('R26：sendSetupCard 两条内层整句的 en 直接断言', async () => {
  const fx = freshDb('t12c-setup-inner');
  try {
    const options = { db: fx.db, dbPath: fx.dbPath, env: {} };
    db.setUserPref(UID, 0, 'lang', { v: 'en' }, options);
    const opts = {
      ...options, rest: { async restSendCard() {} }, log: () => {},
    };
    assert.deepEqual(await inbound.sendSetupCard(UID, null, opts), [false,
      'App credentials are not configured (App ID / App Secret); save them '
      + 'before sending the card']);
    db.setFeishuUserCfg(UID, { app_id: 'cli_x', app_secret: 's' }, options);
    assert.deepEqual(await inbound.sendSetupCard(UID, null, opts), [false,
      'No Feishu account is bound yet: generate a bind code on the settings '
      + 'page, then reply 「绑定 <code>」 in the bot DM']);

    // zh 控制线：默认路径逐字节不变
    db.setUserPref(UID, 0, 'lang', { v: 'zh' }, options);
    db.setFeishuUserCfg(UID, {}, options);
    inbound.resetSetupState();
    assert.deepEqual(await inbound.sendSetupCard(UID, null, opts), [false,
      '未配置应用凭据（App ID / App Secret），先保存配置再发卡片']);
  } finally {
    inbound.resetSetupState();
    fx.close();
  }
});
