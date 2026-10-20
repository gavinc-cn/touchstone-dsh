/**
 * 飞书斜杠指令族单测（M7-R4）：`lib/feishu_slash.js` ↔ `feishu.py:1194-1574`。
 *
 * 期望值来源（**不读 Node 实现反推**）：
 *   ① **oracle 源码文本**（`feishu.py`）：`SLASH_COMMANDS`/`SLASH_ICON_KEYS`/`_SLASH_NAMES`/
 *      `_SLASH_PERM_CODES`/`_SLASH_PERM_HINT`/`_SLASH_ICON_HINT`/99992402 文案全部用正则从
 *      Python 原文里抽出来当期望值（常量改一个字，本文件立刻红）——见 `oracleCommands()` 等；
 *   ② **真 oracle 探针**：`python3 -c "import feishu; json.dumps(feishu.slash_perm_card(...))"`，
 *      两张权限卡 JSON 文本的 sha256 实测为
 *      `cli_x` ⇒ `576b947a…633a`（1089 字节）、`app_id=""` ⇒ `31a204a5…989c`（1083 字节）；
 *   ③ oracle 探针实测的状态文案（逐字照抄进各用例）：
 *      · 无凭据 slash_status ⇒ `未配置应用凭据（App ID/App Secret），先在上方「飞书机器人配置」保存后重试`，
 *        sync/clear 的文案**短一截**（`未配置应用凭据（App ID/App Secret）`）且只有
 *        `{ok, need_scope, error}` 三个键；
 *      · 假凭据（真响应 `{"code":10003,"data":{},"msg":"invalid param"}`）⇒
 *        `token 获取失败 code=10003 invalid param` 原样进 `error`，`need_scope:false`。
 *
 * 替身 fetch：不连真网。未脚本化的 URL 直接抛错（漏网请求立刻打红），用例 `finally` 还原。
 * 夹具：`m3fixture.freshDb`（临时库；它把 `TOUCHSTONE_DB` 指向自己，漏传 options 也落不进生产库）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as slash from '../lib/feishu_slash.js';
import { FEISHU_HOST, FeishuRestError, _TOKEN_CACHE } from '../lib/feishu_rest.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import { freshDb } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// oracle 源码抽取（期望值真源）
// --------------------------------------------------------------------------

// Python 后端源码在 backend_py/（2026-10-19 起）
const FEISHU_PY = path.resolve(import.meta.dirname, '..', '..', 'backend_py', 'feishu.py');
const TOKEN_URL = `${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`;
const SLASH_URL = `${FEISHU_HOST}${slash.SLASH_API}`;

const PY = fs.readFileSync(FEISHU_PY, 'utf8');

/** `SLASH_COMMANDS = ( ("名","说明","图标"), … )` ⇒ [[名, 说明, 图标], …]（逐行解析 oracle 原文） */
function oracleCommands() {
  const block = /^SLASH_COMMANDS = \(\n([\s\S]*?)^\)$/m.exec(PY);
  assert.ok(block, 'feishu.py 里找不到 `SLASH_COMMANDS = (` … `)` 块');
  const rows = [...block[1].matchAll(/^\s*\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\),\s*$/gm)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.equal(rows.length, 17, 'oracle 源码应恰有 17 条指令');
  return rows;
}

/** `SLASH_ICON_KEYS = frozenset(( "…", … ))` ⇒ 键数组 */
function oracleIconKeys() {
  const block = /^SLASH_ICON_KEYS = frozenset\(\(\n([\s\S]*?)^\)\)$/m.exec(PY);
  assert.ok(block, 'feishu.py 里找不到 SLASH_ICON_KEYS 块');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 多行拼接的字符串常量 ⇒ 合并后的文本（`_SLASH_PERM_HINT`） */
function oracleJoinedLiteral(name) {
  const block = new RegExp(`^${name} = \\(([\\s\\S]*?)\\)$`, 'm').exec(PY);
  assert.ok(block, `feishu.py 里找不到 ${name}`);
  return [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
}

/** 单行字符串常量 ⇒ 文本 */
function oracleLiteral(name) {
  const hit = new RegExp(`^${name} = "([^"]*)"$`, 'm').exec(PY);
  assert.ok(hit, `feishu.py 里找不到 ${name}`);
  return hit[1];
}

const ORACLE_ROWS = oracleCommands();
const ORACLE_ICONS = oracleIconKeys();
const PERM_HINT = oracleJoinedLiteral('_SLASH_PERM_HINT');
const ICON_HINT = oracleLiteral('_SLASH_ICON_HINT');
const PARAM_HINT = /if code == 99992402:\n        return "([^"]*)"/.exec(PY)[1];

/**
 * 17 条清单的**字面量副本**（人工逐条抄自 `feishu.py:1198-1216`）。它与
 * `oracleCommands()`（源码正则抽取）、`slash.SLASH_COMMANDS`（Node 实现）三方互证：
 * 三者缺一，抄写错误就可能被「实现抄错=期望也抄错」双双掩盖。
 */
const EXPECTED_ROWS = [
  ['help', '查看可用指令', 'skill_outlined'],
  ['bind', '绑定站点账号：/bind 绑定码', 'member_outlined'],
  ['unbind', '解除站点账号绑定', 'clear_outlined'],
  ['project', '设置默认项目：/project 项目名', 'home_outlined'],
  ['current', '查看默认项目与当前会话', 'home_outlined'],
  ['projects', '项目总览卡：点选设为默认项目', 'database_outlined'],
  ['sessions', '默认项目最近会话：点选绑定', 'chat_outlined'],
  ['new', '在默认项目下新建会话并绑定：/new [标题]', 'add-chat-ai_outlined'],
  ['use', '绑定已有会话：/use 序号|关键字|会话id前缀', 'global-link_outlined'],
  ['leave', '解绑当前会话（保留默认项目）', 'clear_outlined'],
  ['status', '查看任务与看板摘要：/status [项目名]', 'database_outlined'],
  ['cards', '查找卡片：/cards 关键字（id 前缀 / 标题包含）', 'codeblock_outlined'],
  ['approve', '通过待审核卡片：/approve 卡片', 'flag_outlined'],
  ['reject', '驳回卡片继续开发：/reject 卡片 意见', 'edit_outlined'],
  ['answer', '回复 agent 提问：/answer 卡片 选项序号|文字', 'chat_outlined'],
  ['agree', '批准挂起的工具审批：/agree 卡片 [session]', 'sent_outlined'],
  ['deny', '拒绝挂起的工具审批：/deny 卡片', 'ai-block_outlined'],
];
const DESIRED = EXPECTED_ROWS.map(([command, description, icon]) => ({ command, description, icon }));

/** 卡片 JSON 文本的 sha256（oracle `json.dumps(..., ensure_ascii=False)` 实测锚） */
const CARD_SHA = '576b947afa4d62a0dce7b4a23ad710699671c21b1834bc835c2d61337208633a';
const CARD_NOAPP_SHA = '31a204a578cd224d82f27103958faef0accd21def9fd0ef7241125e32d07989c';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;

function resp(body, status = 200) {
  const text = typeof body === 'string' ? body : pyJsonDumps(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function okToken() {
  return resp({ code: 0, msg: 'ok', tenant_access_token: 't-abc', expire: 7200 });
}

/** 记录器替身：未脚本化 ⇒ 抛错（任何漏网请求都会把用例打红） */
function installFetch(script) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const reply = script(call, calls.length - 1);
    if (reply === undefined) {
      throw new Error(`替身 fetch 收到未脚本化请求 #${calls.length}：${call.method} ${call.url}`);
    }
    return reply;
  };
  return calls;
}

/** 预热 token 缓存（把「token 请求」从请求序列里摘掉，便于断言 REST 序列） */
function warmToken(appId = 'cli_abc', token = 't-abc') {
  _TOKEN_CACHE.set(appId, { token, expire: Date.now() / 1000 + 3600 });
}

async function withStub(script, body) {
  _TOKEN_CACHE.clear();
  const calls = installFetch(script);
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = REAL_FETCH;
    _TOKEN_CACHE.clear();
  }
}

/** 造一个带凭据的临时库（返回 `{fx, options}`） */
function withCreds(tag, cfg = { app_id: 'cli_abc', app_secret: 's3cret' }, userId = 7) {
  const fx = freshDb(tag);
  if (cfg !== null) db.setFeishuUserCfg(userId, cfg, { dbPath: fx.dbPath });
  return { fx, options: { dbPath: fx.dbPath } };
}

// --------------------------------------------------------------------------
// 常量族：逐条对 oracle 源码
// --------------------------------------------------------------------------

test('常量族：SLASH_API / 17 条指令 / _SLASH_NAMES / 权限码 / 72 个 icon 键（逐条对 oracle 源码）', () => {
  assert.equal(slash.SLASH_API, /^SLASH_API = "([^"]*)"$/m.exec(PY)[1]);
  assert.equal(slash.SLASH_COMMANDS.length, 17, 'SLASH_COMMANDS 必须是 17 条');
  // 三方互证：字面量副本 == oracle 源码正则抽取 == Node 模块（顺序也照抄：顺序即面板顺序）
  assert.deepEqual(EXPECTED_ROWS, ORACLE_ROWS, '字面量副本与 oracle 源码抽取不一致');
  assert.deepEqual(slash.SLASH_COMMANDS.map((row) => [...row]), EXPECTED_ROWS);
  assert.deepEqual([...slash._SLASH_NAMES], EXPECTED_ROWS.map((row) => row[0]));
  assert.deepEqual([...slash._SLASH_PERM_CODES],
    /^_SLASH_PERM_CODES = \(([^)]*)\)$/m.exec(PY)[1].split(',').map((n) => Number(n.trim())));

  // 名称唯一、说明非空（说明为空飞书报 99992402）
  assert.equal(new Set(ORACLE_ROWS.map((row) => row[0])).size, 17, '指令名必须唯一');
  for (const [name, desc] of ORACLE_ROWS) {
    assert.ok(name.length > 0 && desc.length > 0, `${name} 的名/说明不得为空`);
    assert.ok(!name.includes('/'), `${name} 指令名不得含「/」`);
  }

  // 图标全表：集合逐一相等，且清单里每个图标都在表内（表外的键创建即 40000031）
  assert.equal(ORACLE_ICONS.length, 72, 'oracle 全表应为 72 个键');
  assert.deepEqual([...slash.SLASH_ICON_KEYS].sort(), [...new Set(ORACLE_ICONS)].sort());
  assert.equal(slash.SLASH_ICON_KEYS.size, 72);
  for (const [name, , icon] of ORACLE_ROWS) {
    assert.ok(slash.SLASH_ICON_KEYS.has(icon), `${name} 的图标 ${icon} 不在官方全表内`);
  }
});

test('slashErrorHint / _needScope：三个 scope 码、40000031、99992402、兜底（文案取自 oracle 源码）', () => {
  for (const code of [99991640, 99991672, 99991679]) {
    assert.equal(slash.slashErrorHint(new FeishuRestError('x', code)), PERM_HINT, `code=${code}`);
    assert.equal(slash._needScope(new FeishuRestError('x', code)), true, `need_scope code=${code}`);
  }
  assert.equal(slash.slashErrorHint(new FeishuRestError('x', 40000031)), ICON_HINT);
  assert.equal(slash._needScope(new FeishuRestError('x', 40000031)), false);
  assert.equal(slash.slashErrorHint(new FeishuRestError('x', 99992402)), PARAM_HINT);
  // 兜底 = str(err)；无 code 属性 ⇒ None（不匹配任何分支）
  assert.equal(slash.slashErrorHint(new FeishuRestError('REST /x code=1 boom', 1)), 'REST /x code=1 boom');
  assert.equal(slash.slashErrorHint(new Error('plain')), 'plain');
  assert.equal(slash._needScope(new Error('plain')), false);
  assert.equal(slash._needScope(null), false);
  assert.equal(slash.slashErrorHint(null), 'None', 'Python str(None) = "None"');
});

// --------------------------------------------------------------------------
// 权限卡
// --------------------------------------------------------------------------

test('slashPermCard：卡片逐字（oracle 两张卡的 sha256 锚 + 关键字段）', () => {
  const card = slash.slashPermCard('cli_x', 7);
  assert.equal(sha256(pyJsonDumps(card)), CARD_SHA,
    '整卡 JSON 文本必须与 oracle json.dumps(..., ensure_ascii=False) 逐字节一致');
  assert.equal(card.schema, '2.0');
  assert.deepEqual(card.header, {
    title: { tag: 'plain_text', content: '🔑 需要开通「应用指令」权限' },
    template: 'orange',
  });
  assert.equal(card.body.elements.length, 2);
  assert.equal(card.body.elements[0].tag, 'markdown');
  assert.equal(card.body.elements[0].content,
    '**Touchstone 快捷指令**（机器人私聊输入框打「/」弹出的指令面板）需要你的飞书应用先开通权限：\n'
    + '· `application:app_slash_command:read`\n'
    + '· `application:app_slash_command:write`\n\n'
    + '**开通三步**：\n'
    + '1. 打开 [开发者后台 · 本应用](https://open.feishu.cn/app/cli_x)，左侧 **开发配置 → 权限管理**，点「开通权限」\n'
    + '2. 搜索 `app_slash_command`，把读、写两个权限都勾上并确认开通\n'
    + '3. 左侧 **应用发布 → 版本管理与发布** → 创建版本并发布（权限改动必须发版、过审后才生效）\n\n'
    + '完成后点下面的按钮，我立刻重试注册；若刚发版，可等约 1 分钟再点一次。');
  assert.deepEqual(card.body.elements[1], {
    tag: 'button',
    type: 'primary',
    text: { tag: 'plain_text', content: '我已开通，重试注册' },
    behaviors: [{ type: 'callback', value: { t: 'sc', a: 'retry', u: 7 } }],
  });

  // app_id 为空 ⇒ 链接退到「应用列表」根 URL（官方文档未给深链，不猜）
  const noApp = slash.slashPermCard('', 7);
  assert.equal(sha256(pyJsonDumps(noApp)), CARD_NOAPP_SHA);
  assert.ok(noApp.body.elements[0].content.includes('(https://open.feishu.cn/app)'));
});

// --------------------------------------------------------------------------
// 无凭据 / 假凭据（零真网、固定文案）
// --------------------------------------------------------------------------

test('无凭据：configured:false + desired 17 条 + 固定文案，且**零网络**', async () => {
  const { fx, options } = withCreds('m7r4-nocred', null);
  try {
    await withStub(() => undefined, async (calls) => {
      const status = await slash.slashStatus(7, options);
      assert.deepEqual(status, {
        configured: false,
        desired: DESIRED,
        remote: [],
        extra: [],
        need_scope: false,
        error: '未配置应用凭据（App ID/App Secret），先在上方「飞书机器人配置」保存后重试',
      });
      assert.equal(status.desired.length, 17);

      // sync/clear 的无凭据文案**短一截**，且只有三个键（Python 字面量里就没有分桶键）
      const synced = await slash.syncSlashCommands(7, options);
      assert.deepEqual(Object.keys(synced), ['ok', 'need_scope', 'error']);
      assert.deepEqual(synced, {
        ok: false, need_scope: false, error: '未配置应用凭据（App ID/App Secret）',
      });
      const cleared = await slash.clearSlashCommands(7, options);
      assert.deepEqual(cleared, {
        ok: false, need_scope: false, error: '未配置应用凭据（App ID/App Secret）',
      });

      const [ok, err] = await slash.sendSlashPermCard(7, options);
      assert.equal(ok, false);
      assert.equal(err, '未配置应用凭据（App ID/App Secret），先保存配置再发卡片');

      assert.equal(calls.length, 0, '无凭据不许触网');
    });

    // 半份凭据（只有 app_id 或只有 app_secret）同样算未配置（`app_config` 口径）
    db.setFeishuUserCfg(7, { app_id: 'cli_only' }, options);
    assert.equal((await slash.slashStatus(7, options)).configured, false);
    db.setFeishuUserCfg(7, { app_secret: 'sec_only' }, options);
    assert.equal((await slash.slashStatus(7, options)).configured, false);
  } finally {
    fx.close();
  }
});

test('假凭据：token 失败文案原样进 error、need_scope:false、失败不缓存（三次调用三次 token 请求）', async () => {
  const { fx, options } = withCreds('m7r4-badcred', { app_id: 'cli_fake', app_secret: 'bad' });
  try {
    await withStub((call) => (call.url === TOKEN_URL
      ? resp({ code: 10003, data: {}, msg: 'invalid param' }) : undefined), async (calls) => {
      const status = await slash.slashStatus(7, options);
      assert.deepEqual(status, {
        configured: true,
        desired: DESIRED,
        remote: [],
        extra: [],
        need_scope: false,
        error: 'token 获取失败 code=10003 invalid param',
      });
      const synced = await slash.syncSlashCommands(7, options);
      assert.deepEqual(synced, {
        ok: false, need_scope: false, error: 'token 获取失败 code=10003 invalid param',
      });
      const cleared = await slash.clearSlashCommands(7, options);
      assert.deepEqual(cleared, {
        ok: false, need_scope: false, error: 'token 获取失败 code=10003 invalid param',
      });
      assert.equal(calls.length, 3, 'token 失败不写缓存 ⇒ 三次调用各发一次 token 请求');
      assert.ok(calls.every((c) => c.url === TOKEN_URL), 'token 都没拿到，不许打业务端点');
    });
  } finally {
    fx.close();
  }
});

test('slashStatus：缺 scope 三码 ⇒ need_scope:true + 权限引导逐字；40000031/99992402 ⇒ 各自文案', async () => {
  const { fx, options } = withCreds('m7r4-scope');
  try {
    const cases = [
      [99991640, PERM_HINT, true, 'no permission'],
      [99991672, PERM_HINT, true, 'lacks scope'],
      [99991679, PERM_HINT, true, 'lacks scope'],
      [40000031, ICON_HINT, false, 'invalid icon'],
      [99992402, PARAM_HINT, false, 'invalid param'],
    ];
    for (const [code, hint, needScope, msg] of cases) {
      await withStub((call) => {
        if (call.url === TOKEN_URL) return okToken();
        return call.url === SLASH_URL ? resp({ code, msg }) : undefined;
      }, async (calls) => {
        const status = await slash.slashStatus(7, options);
        assert.equal(status.error, hint, `code=${code}`);
        assert.equal(status.need_scope, needScope, `need_scope code=${code}`);
        assert.deepEqual(status.remote, [], '列表拿不到 ⇒ remote 为空数组（不是缺失）');
        assert.deepEqual(status.extra, []);
        assert.deepEqual(status.desired, DESIRED);
        // 只有成功响应才写 token 缓存 ⇒ 每个用例 1 token + 1 GET
        assert.equal(calls.length, 2, `code=${code} 只应发 token + GET 两次请求`);
        assert.equal(calls[1].url, SLASH_URL);
        assert.equal(calls[1].method, 'GET');
        assert.equal(calls[1].body, undefined, 'GET 列表不带体');
      });
    }
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// 成功分支（替身驱动假上游）：diff 分桶
// --------------------------------------------------------------------------

test('syncSlashCommands：created/updated/kept/extra 分桶 + 请求序列 + 绝不碰他人指令', async () => {
  const { fx, options } = withCreds('m7r4-sync');
  try {
    const remoteItems = [
      // description 是**字符串**、icon 在 item 级 ⇒ 与期望一致 ⇒ kept
      { command_id: 'c-help', command: 'help', description: '查看可用指令', icon: { icon_key: 'skill_outlined' } },
      // 说明不同 ⇒ updated
      { command_id: 'c-bind', command: 'bind', description: { default_value: '旧绑定说明', i18n: { zh_cn: '旧绑定说明' } }, icon: { icon_key: 'skill_outlined' } },
      // 说明不同 ⇒ updated
      { command_id: 'c-proj', command: 'project', description: { default_value: 'x', i18n: {} }, icon: { icon_key: 'home_outlined' } },
      // icon 藏在 description 内（官方示例形态）⇒ 认到 ⇒ kept
      { command_id: 'c-cur', command: 'current', description: { default_value: '查看默认项目与当前会话', i18n: { zh_cn: '查看默认项目与当前会话' }, icon: { icon_key: 'home_outlined' } } },
      // 用户自己的指令 ⇒ 只进 extra，绝不删改
      { command_id: 'c-extra', command: 'my_cmd', description: '用户自己加的', icon: { icon_key: 'robot_outlined' } },
    ];
    const rowOf = (name) => ORACLE_ROWS.find((row) => row[0] === name);
    let listHits = 0;
    await withStub((call) => {
      if (call.url === SLASH_URL && call.method === 'GET') {
        listHits += 1;
        return resp({ code: 0, data: { items: remoteItems } });
      }
      if (call.url === SLASH_URL && call.method === 'POST') return resp({ code: 0, data: { command_id: 'new-id' } });
      if (call.url.startsWith(`${SLASH_URL}/`) && call.method === 'PATCH') return resp({ code: 0 });
      return undefined;
    }, async (calls) => {
      warmToken();
      const out = await slash.syncSlashCommands(7, options);
      assert.equal(out.ok, true);
      assert.equal(out.error, '');
      assert.deepEqual(out.failed, []);
      assert.deepEqual(out.kept, ['help', 'current']);
      assert.deepEqual(out.updated, ['bind', 'project']);
      assert.deepEqual(out.created, ['unbind', 'projects', 'sessions', 'new', 'use', 'leave',
        'status', 'cards', 'approve', 'reject', 'answer', 'agree', 'deny']);
      assert.deepEqual(out.extra, ['my_cmd']);
      assert.equal(out.need_scope, false);
      assert.equal(out.created.length + out.updated.length + out.kept.length, 17);

      // 请求序列：先 1 次 GET 列表，随后按 SLASH_COMMANDS 顺序逐条 upsert
      // （help=kept 无请求 / bind=PATCH / unbind=POST / project=PATCH / current=kept / 其余 12 条 POST）
      assert.equal(listHits, 1);
      assert.deepEqual(calls.map((c) => c.method), [
        'GET', 'PATCH', 'POST', 'PATCH',
        ...Array(12).fill('POST'),
      ]);
      assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 13);
      assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);

      // PATCH 的 URL 与体逐字节（说明 + 图标都按期望清单下发）
      const patches = calls.filter((c) => c.method === 'PATCH');
      assert.deepEqual(patches.map((c) => c.url),
        [`${SLASH_URL}/c-bind`, `${SLASH_URL}/c-proj`]);
      for (const [i, name] of ['bind', 'project'].entries()) {
        const [, desc, icon] = rowOf(name);
        assert.equal(patches[i].body, pyJsonDumps({
          description: { default_value: desc, i18n: { zh_cn: desc } },
          icon: { icon_key: icon },
        }));
      }

      // POST 的体逐字节（command + description + icon；icon 走 item 级）
      const posts = calls.filter((c) => c.method === 'POST');
      const first = rowOf('unbind');
      assert.equal(posts[0].body, pyJsonDumps({
        command: first[0],
        description: { default_value: first[1], i18n: { zh_cn: first[1] } },
        icon: { icon_key: first[2] },
      }));
      assert.equal(posts[0].url, SLASH_URL);

      // 用户自己的指令一次都没被碰过
      assert.equal(calls.some((c) => c.url.includes('c-extra') || (c.body || '').includes('my_cmd')), false);
    });
  } finally {
    fx.close();
  }
});

test('syncSlashCommands：逐条失败进 failed、need_scope 聚合、error = failed[0]', async () => {
  const { fx, options } = withCreds('m7r4-syncfail');
  try {
    await withStub((call) => {
      if (call.url === SLASH_URL && call.method === 'GET') {
        return resp({ code: 0, data: { items: [] } });
      }
      if (call.url === SLASH_URL && call.method === 'POST') {
        // 第一条（help）缺 scope；其余照常建成
        return resp({ code: 99991640, msg: 'no permission' });
      }
      return undefined;
    }, async (calls) => {
      warmToken();
      const out = await slash.syncSlashCommands(7, options);
      assert.equal(out.ok, false);
      assert.equal(out.need_scope, true);
      assert.deepEqual(out.created, []);
      assert.equal(out.failed.length, 17, '逐条失败逐条记账（同步是逐条进行的）');
      assert.equal(out.failed[0], `help: ${PERM_HINT}`);
      assert.equal(out.error, out.failed[0]);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 17, '缺 scope 不中断循环');
    });
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// _slashUpsert：撞名收敛
// --------------------------------------------------------------------------

test('_slashUpsert：撞名 40000000 ⇒ 重取列表转更新（收敛）；非 40000000 直接抛、不重取', async () => {
  const cfg = { app_id: 'cli_abc', app_secret: 's3cret' };
  // ① 撞名 ⇒ GET 重取 + PATCH 转更新
  await withStub((call) => {
    if (call.url === SLASH_URL && call.method === 'GET') {
      return resp({ code: 0, data: { items: [
        { command_id: 'c-ans', command: 'answer', description: { default_value: '旧' }, icon: { icon_key: 'chat_outlined' } },
      ] } });
    }
    if (call.url === SLASH_URL && call.method === 'POST') {
      return resp({ code: 40000000, msg: 'command already exists' });
    }
    if (call.url === `${SLASH_URL}/c-ans` && call.method === 'PATCH') return resp({ code: 0 });
    return undefined;
  }, async (calls) => {
    warmToken();
    const result = await slash._slashUpsert(cfg, 'answer', '新说明', 'chat_outlined', new Map());
    assert.equal(result, 'updated');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace(FEISHU_HOST, '')}`), [
      `POST ${slash.SLASH_API}`,
      `GET ${slash.SLASH_API}`,
      `PATCH ${slash.SLASH_API}/c-ans`,
    ]);
  });

  // ② 撞名但重取后仍查无此名 ⇒ 抛原错（40000000）
  await withStub((call) => {
    if (call.url === SLASH_URL && call.method === 'GET') return resp({ code: 0, data: { items: [] } });
    if (call.url === SLASH_URL && call.method === 'POST') return resp({ code: 40000000, msg: 'command already exists' });
    return undefined;
  }, async (calls) => {
    warmToken();
    await assert.rejects(() => slash._slashUpsert(cfg, 'answer', '新说明', 'chat_outlined', new Map()), (e) => {
      assert.equal(e.code, 40000000);
      assert.equal(e.message, `REST ${slash.SLASH_API} code=40000000 command already exists`);
      return true;
    });
    assert.equal(calls.length, 2, 'POST + 重取 GET，不再 PATCH');
  });

  // ③ 非 40000000 的创建失败 ⇒ 立即抛，不重取列表
  await withStub((call) => {
    if (call.url === SLASH_URL && call.method === 'POST') return resp({ code: 99991640, msg: 'no permission' });
    return undefined;
  }, async (calls) => {
    warmToken();
    await assert.rejects(() => slash._slashUpsert(cfg, 'answer', '新说明', 'chat_outlined', new Map()),
      (e) => e.code === 99991640);
    assert.equal(calls.length, 1, '不触发重取列表');
  });

  // ④ 已存在且说明/图标一致 ⇒ kept（零写请求）；说明一致但图标不同 ⇒ updated
  await withStub((call) => {
    if (call.url === `${SLASH_URL}/c-ans` && call.method === 'PATCH') return resp({ code: 0 });
    return undefined;
  }, async (calls) => {
    warmToken();
    const same = new Map([['answer', { command_id: 'c-ans', command: 'answer', description: '新说明', icon: 'chat_outlined' }]]);
    assert.equal(await slash._slashUpsert(cfg, 'answer', '新说明', 'chat_outlined', same), 'kept');
    assert.equal(calls.length, 0, 'kept 不发任何请求');
    // 普通对象（非 Map）形态的 by_name 也接受
    const stale = { answer: { command_id: 'c-ans', command: 'answer', description: '新说明', icon: 'skill_outlined' } };
    assert.equal(await slash._slashUpsert(cfg, 'answer', '新说明', 'chat_outlined', stale), 'updated');
    assert.equal(calls.length, 1, '图标不一致 ⇒ 一次 PATCH');
  });
});

// --------------------------------------------------------------------------
// clear：只删自己的
// --------------------------------------------------------------------------

test('clearSlashCommands：只删名字命中 TS 清单的，deleted 排序、extra 只报不动', async () => {
  const { fx, options } = withCreds('m7r4-clear');
  try {
    const items = [
      { command_id: 'c-help', command: 'help', description: '查看可用指令', icon: { icon_key: 'skill_outlined' } },
      { command_id: 'c-extra', command: 'my_cmd', description: '用户自己加的', icon: { icon_key: 'robot_outlined' } },
      { command_id: 'c-status', command: 'status', description: '查看任务与看板摘要：/status [项目名]', icon: { icon_key: 'database_outlined' } },
    ];
    await withStub((call) => {
      if (call.url === SLASH_URL && call.method === 'GET') return resp({ code: 0, data: { items } });
      if (call.url === `${SLASH_URL}/c-help` && call.method === 'DELETE') return resp({ code: 0 });
      if (call.url === `${SLASH_URL}/c-status` && call.method === 'DELETE') {
        return resp({ code: 400, msg: 'delete denied' });
      }
      return undefined;
    }, async (calls) => {
      warmToken();
      const out = await slash.clearSlashCommands(7, options);
      assert.equal(out.ok, false, '一条删失败 ⇒ ok=false');
      assert.deepEqual(out.deleted, ['help'], 'deleted 只含成功的，且 sorted');
      assert.deepEqual(out.extra, ['my_cmd']);
      assert.deepEqual(out.failed, [`status: REST ${slash.SLASH_API}/c-status code=400 delete denied`]);
      assert.equal(out.error, out.failed[0]);
      assert.equal(out.need_scope, false);
      assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
        [`${SLASH_URL}/c-help`, `${SLASH_URL}/c-status`]);
      assert.equal(calls.some((c) => c.url.includes('c-extra')), false, '绝不删用户自己的指令');
    });

    // 全成功路径：deleted 按**码点序**排序（Python sorted）
    await withStub((call) => {
      if (call.url === SLASH_URL && call.method === 'GET') return resp({ code: 0, data: { items } });
      if (call.url.startsWith(`${SLASH_URL}/`) && call.method === 'DELETE') return resp({ code: 0 });
      return undefined;
    }, async (calls) => {
      warmToken();
      const out = await slash.clearSlashCommands(7, options);
      assert.deepEqual(out, {
        ok: true, deleted: ['help', 'status'], extra: ['my_cmd'],
        failed: [], need_scope: false, error: '',
      });
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, 2);
    });
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// list 形态 + 权限卡发送
// --------------------------------------------------------------------------

test('listSlashCommands：远端 item 两种 description/icon 形态与缺字段降级', async () => {
  const cfg = { app_id: 'cli_abc', app_secret: 's3cret' };
  await withStub((call) => {
    if (call.url === SLASH_URL && call.method === 'GET') {
      return resp({ code: 0, data: { items: [
        { command_id: 123, command: 'x' },                                     // 数值 id ⇒ 字符串
        { command: 'y', description: { i18n: { zh_cn: '中文兜底' } } },          // default_value 缺 ⇒ i18n.zh_cn
        { command: 'z', description: '直接字符串', icon: { icon_key: 'flag_outlined' } },
        { command: 'w', description: { icon: { icon_key: 'database_outlined' } } },  // icon 在 description 内
      ] } });
    }
    return undefined;
  }, async (calls) => {
    warmToken();
    assert.deepEqual(await slash.listSlashCommands(cfg), [
      { command_id: '123', command: 'x', description: '', icon: 'skill_outlined', update_time: '' },
      { command_id: '', command: 'y', description: '中文兜底', icon: 'skill_outlined', update_time: '' },
      { command_id: '', command: 'z', description: '直接字符串', icon: 'flag_outlined', update_time: '' },
      { command_id: '', command: 'w', description: '', icon: 'database_outlined', update_time: '' },
    ]);
    assert.equal(calls.length, 1);
  });

  // data 为 null / items 缺失 ⇒ 空数组（`(out.get("data") or {}).get("items") or []`）
  await withStub(() => resp({ code: 0, data: null }), async () => {
    warmToken();
    assert.deepEqual(await slash.listSlashCommands(cfg), []);
  });
  await withStub(() => resp({ code: 0 }), async () => {
    warmToken();
    assert.deepEqual(await slash.listSlashCommands(cfg), []);
  });
});

test('sendSlashPermCard：未绑定 / 已绑定成功（卡片体逐字节）/ REST 失败文案', async () => {
  const { fx, options } = withCreds('m7r4-permcard', { app_id: 'cli_x', app_secret: 's3cret' });
  try {
    // ① 未绑定 ⇒ 固定文案、零网络
    await withStub(() => undefined, async (calls) => {
      const [ok, err] = await slash.sendSlashPermCard(7, options);
      assert.equal(ok, false);
      assert.equal(err, '尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复「绑定 <码>」');
      assert.equal(calls.length, 0);
    });

    // ② 已绑定 ⇒ POST 单聊卡片，content 是卡片 JSON 串
    db.setFeishuBinding('ou_user7', 7, 0, options);
    await withStub((call) => {
      if (call.url === TOKEN_URL) return okToken();
      if (call.url.startsWith(`${FEISHU_HOST}/open-apis/im/v1/messages`)) return resp({ code: 0 });
      return undefined;
    }, async (calls) => {
      const [ok, err] = await slash.sendSlashPermCard(7, options);
      assert.equal(ok, true);
      assert.equal(err, '');
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, `${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=open_id`);
      const card = slash.slashPermCard('cli_x', 7);
      assert.equal(calls[1].body, pyJsonDumps({
        receive_id: 'ou_user7', msg_type: 'interactive', content: pyJsonDumps(card),
      }));
    });

    // ③ 发送失败 ⇒ `卡片发送失败：{e}`（str(FeishuRestError) = 文案）
    await withStub((call) => {
      if (call.url === TOKEN_URL) return okToken();
      if (call.url.startsWith(`${FEISHU_HOST}/open-apis/im/v1/messages`)) return resp({ code: 99991640, msg: 'no permission' });
      return undefined;
    }, async () => {
      const [ok, err] = await slash.sendSlashPermCard(7, options);
      assert.equal(ok, false);
      assert.equal(err, `卡片发送失败：REST /open-apis/im/v1/messages code=99991640 no permission`);
    });
  } finally {
    fx.close();
  }
});
