/**
 * 项目推送绑定族路由单测（M7）：`GET|PATCH /api/projects/<n>/feishu-hook` +
 * `POST /api/me/feishu-hook/apply`（`backend/routes/feishu_hook.js`）。
 *
 * 期望值来自 oracle（`server.py:2006-2111` + `feishu.py:31-36`），并由本机**隔离实例**
 * （`tests/serverfixture.py`：临时库 + 随机端口 + 真 `server.py`）逐字实测过一遍：
 *   PATCH 200  : (200, '{"ok":true}')                        ← 无空格，**不是** json.dumps 口径
 *   PATCH 404  : (404, '{"error":"not found"}')
 *   apply 200  : '{"ok": true, "updated": 2, "archived_skipped": 1, "projects": [...]}'
 *   enabled=0/false/""/null/[]/{} → 库 0；1/true/"0"/"false"/"1"/"x" → 库 1（bool("0") is True）
 *   url=true→'True'、["a"]→"['a']"、{"a":1}→"{'a': 1}"、0→''（str(v or "").strip()）
 *   events 写 ["card_review","task_failed"] → 库 'card_review,task_failed' → 读 ['task_failed','card_review']
 *   **不带 events 键的 PATCH / apply 后**库变 'task_failed,card_review'  ← events 是无条件写的列，
 *   未提交也会被「读出口径」重排 + 去重回写（`PATCH {}` 实测把重复元素去掉）；「缺省=不改」
 *   只对 webhook_url/webhook_secret/enabled 三列成立
 *   events 写 `[[]]`/`[{}]`/`["card_review",["x"]]` ⇒ Python `set()` 抛 TypeError ⇒ 连接被掐断（无响应）
 *   路径 id ≥ 2^63 ⇒ Python 抛未捕获 OverflowError ⇒ 连接被掐断（Node 侧差异见最后一组用例）
 *
 * 走**真分派链**（`makeContext()` + `dispatch()`，与 `projects-write.test.mjs` 同款）：
 * 本族三条路由与 `/api/projects/<id>`、`/board/*` 同前缀，只有真分派才测得到「谁先匹配」；
 * 且本族的判据大半在**字节层**（紧凑 vs 带空格、库里的 events 顺序 vs 回显顺序），
 * 断言一律落在 `Buffer.toString()` 与 sqlite 原始行上，不看解析后的对象。
 *
 * 读体时机（坑②）：`do_PATCH:1262` 在调用 handler **之前**读体 ⇒ `PATCH` 必须在归属检查
 * 之前 `await ctx.readBody()`，404 档也要把 body 读掉。用例用「请求流的 end 有没有触发」
 * 当探针（同 `projects-write.test.mjs`）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setFeishuHook } from '../lib/db.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb } from './m3fixture.mjs';

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// --------------------------------------------------------------------------
// 测试台（`lib/http.js` 的调用面只有 writeHead/write/end/destroy）
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: 0, headers: null, chunks: [], destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      write(chunk) { cap.chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) cap.chunks.push(Buffer.from(chunk));
      },
      destroy() { cap.destroyed = true; },
    },
  };
}

/**
 * 请求桩：真 `Readable` + `content-length`。`raw` 给**原始正文**（测坏 JSON/非对象 JSON），
 * `body` 给对象（走 `JSON.stringify`），两者都不给 = 无 body。
 * `readState.ended` 精确对应「handler 有没有消费请求体」（暂停态的流不读就不触发 `end`）。
 */
function fakeReq(method, { body, raw } = {}) {
  let text = null;
  if (raw !== undefined) text = Buffer.from(raw, 'utf8');
  else if (body !== undefined) text = Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text === null ? [] : [text], { objectMode: false });
  stream.headers = text === null ? {} : { 'content-length': String(text.length) };
  stream.method = method;
  const readState = { ended: false };
  stream.on('end', () => { readState.ended = true; });
  return { stream, readState };
}

/** 发一次请求（走真路由表） */
async function call(env, method, target, { body, raw, user } = {}) {
  const { stream, readState } = fakeReq(method, { body, raw });
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: stream,
    res,
    db: env.db,
    user: user === undefined ? env.admin : user,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  const buf = Buffer.concat(cap.chunks);
  return {
    status: cap.status,
    headers: cap.headers,
    hit,
    readState,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

/** 一次请求 + 逐字节正文断言（本族判据的核心形态） */
async function expectBody(env, method, target, opts, status, expectedBody) {
  const r = await call(env, method, target, opts);
  assert.equal(r.status, status, `状态码：${r.text()}`);
  assert.equal(r.text(), expectedBody);
  assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
  return r;
}

// --------------------------------------------------------------------------
// 夹具
// --------------------------------------------------------------------------

/** 临时库 + 两个用户（种子 admin=1 / bob=101）；项目行用真 SQL 插，绑定行走真写口 */
function setup(tag) {
  const fx = freshDb(`fh-${tag}`);
  fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
    + ' VALUES (?,?,?,?,?,?)').run(101, 'bob', 'x', '', 0, '2026-10-12 00:00:00');
  return {
    ...fx,
    admin: fx.db.prepare('SELECT * FROM users WHERE id=1').get(),
    bob: fx.db.prepare('SELECT * FROM users WHERE id=101').get(),
  };
}

let seq = 0;
/** 直接插项目行（只关心 id/name/user_id/archived；其余列给确定值，避免 NULL 干扰） */
function seedProject(env, opts = {}) {
  const { userId = 1, name = 'p', archived = 0 } = opts;
  seq += 1;
  const info = env.db.prepare(
    'INSERT INTO projects(user_id, name, project_dir, agent_path, work_dir, bug_dir,'
    + ' guide_text, commit_spec, deploy_spec, env_label, model,'
    + ' skill_understand, skill_deploy, skill_commit, skill_test, skill_cases,'
    + ' reasoning_effort, permission_mode, created_at, archived)'
    + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(userId, name, `/tmp/pd-${seq}`, 'dsh-plugin:/usr/local/bin/dsh', `/tmp/wd-${seq}`, '',
    '指南', '提交规范', '部署规范', 'dev', 'm0', '', '', '', '', '', '', '',
    '2026-10-12 00:00:00', archived);
  return Number(info.lastInsertRowid);
}

/** 绑定行原始字节（转普通对象：`node:sqlite` 回的是 null 原型对象，deepStrictEqual 会挑原型） */
function hookRow(env, pid) {
  const row = env.db.prepare('SELECT * FROM feishu_hooks WHERE project_id=?').get(pid);
  return row === undefined ? undefined : { ...row };
}
const hookCount = (env) => env.db.prepare(
  'SELECT COUNT(*) AS n FROM feishu_hooks').get().n;
const url = (pid) => `/api/projects/${pid}/feishu-hook`;

const E_DEFAULT = '{"webhook_url": "", "has_webhook_secret": false, "enabled": true,'
  + ' "events": ["blocked_interaction", "task_failed"]}';
const E_NOT_FOUND = '{"error":"not found"}';
const E_OK_LITERAL = '{"ok":true}';
const E_BAD_EVENTS = '{"error":"events 含非法事件"}';

// --------------------------------------------------------------------------
// ① 默认回显 + 成功体字节形态
// --------------------------------------------------------------------------

test('GET 无绑定行：默认回显逐字节（三事件开、card_review 关）；GET 不读体', async (t) => {
  const env = setup('get-default');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'a' });
  const r = await expectBody(env, 'GET', url(pid), {}, 200, E_DEFAULT);
  assert.equal(r.hit, true);
  assert.equal(r.readState.ended, false);            // `_api_feishu_hook_get` 全文无 _read_json
  assert.equal(hookCount(env), 0);                   // 读不建行
  // 写则建行（`set_feishu_hook` 是无条件 UPSERT，2057）：默认事件集 + enabled=1
  await expectBody(env, 'PATCH', url(pid), { body: {} }, 200, E_OK_LITERAL);
  assert.deepEqual(hookRow(env, pid), {
    project_id: pid, webhook_url: '', webhook_secret: '',
    events: 'blocked_interaction,task_failed', enabled: 1,
  });
});

test('成功体两种字节形态：PATCH 是字面量 {"ok":true}（无空格），apply 是 json.dumps（带空格）',
  async (t) => {
    const env = setup('bytes');
    t.after(() => env.close());
    const pid = seedProject(env, { name: 'a' });
    // 全站其它端点的 {"ok": true} 是 json.dumps 口径；本端点不许用 ctx.json
    await expectBody(env, 'PATCH', url(pid), { body: {} }, 200, E_OK_LITERAL);
    await expectBody(env, 'PATCH', url(pid), {}, 200, E_OK_LITERAL);         // 无 body 同样 200
    // bob 零项目 ⇒ apply 正文可逐字节钉死
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id=101').get().n, 0);
    await expectBody(env, 'POST', '/api/me/feishu-hook/apply', { body: {}, user: env.bob }, 200,
      '{"ok": true, "updated": 0, "archived_skipped": 0, "projects": []}');
  });

// --------------------------------------------------------------------------
// ② PATCH 字段语义矩阵
// --------------------------------------------------------------------------

test('PATCH 缺省=不改只对 url/secret/enabled 成立；events 恒按读出口径重排回写（oracle 实测）',
  async (t) => {
    const env = setup('nochange');
    t.after(() => env.close());
    const pid = seedProject(env, { name: 'a' });
    setFeishuHook(pid, 'https://open.feishu.cn/bot/v2/hook/keep', 'sec-1',
      'card_review,task_failed', 0, { db: env.db });
    // 空 body：三列逐字保留，**events 被重排**（2057 无条件写；没带键时写的是读出口径的结果）
    await expectBody(env, 'PATCH', url(pid), { body: {} }, 200, E_OK_LITERAL);
    const afterEmpty = hookRow(env, pid);
    assert.equal(afterEmpty.webhook_url, 'https://open.feishu.cn/bot/v2/hook/keep');
    assert.equal(afterEmpty.webhook_secret, 'sec-1');
    assert.equal(afterEmpty.enabled, 0);
    assert.equal(afterEmpty.events, 'task_failed,card_review');   // ← 隔离实例实测：PATCH 也重排
    // 只带 enabled ⇒ url/secret 保持；events 仍是读出口径（已规范化，故字节不变）
    await expectBody(env, 'PATCH', url(pid), { body: { enabled: true } }, 200, E_OK_LITERAL);
    const after = hookRow(env, pid);
    assert.equal(after.enabled, 1);
    assert.equal(after.webhook_url, 'https://open.feishu.cn/bot/v2/hook/keep');
    assert.equal(after.webhook_secret, 'sec-1');
    assert.equal(after.events, 'task_failed,card_review');
    // 重复元素同样被去重：先直接写库造出「写入口径」的字节，再 PATCH 一个无关字段
    setFeishuHook(pid, 'https://open.feishu.cn/bot/v2/hook/keep', 'sec-1',
      'task_failed,task_failed,blocked_interaction', 1, { db: env.db });
    await expectBody(env, 'PATCH', url(pid), { body: { webhook_url: 'https://x/y' } }, 200,
      E_OK_LITERAL);
    assert.equal(hookRow(env, pid).events, 'blocked_interaction,task_failed');
  });

test('PATCH 显式空串/假值清除 webhook_url 与 webhook_secret', async (t) => {
  const env = setup('clear');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'a' });
  setFeishuHook(pid, 'https://x/y', 'sec', 'task_failed', 1, { db: env.db });
  await expectBody(env, 'PATCH', url(pid), { body: { webhook_url: '', webhook_secret: '' } },
    200, E_OK_LITERAL);
  const row = hookRow(env, pid);
  assert.equal(row.webhook_url, '');
  assert.equal(row.webhook_secret, '');
  assert.equal(row.events, 'task_failed');                 // 未提交的列不动
  await expectBody(env, 'GET', url(pid), {}, 200,
    '{"webhook_url": "", "has_webhook_secret": false, "enabled": true, "events": ["task_failed"]}');
});

test('PATCH 字符串字段 = str(v or "").strip()：true→True、["a"]→[\'a\']、{"a":1}→{\'a\': 1}',
  async (t) => {
    const env = setup('repr');
    t.after(() => env.close());
    const pid = seedProject(env, { name: 'a' });
    // [请求值, 库里应有的字节, GET 回显（= maskWebhook(库)）]
    const cases = [
      [true, 'True', 'True'],
      [['a'], "['a']", "['a']"],
      [{ a: 1 }, "{'a': 1}", "{'a': 1}"],
      [{ b: [1, 'x'] }, "{'b': [1, 'x']}", "{'b': [1, 'x']}"],
      ['  pad  ', 'pad', 'pad'],
      [1.5, '1.5', '1.5'],
      [42, '42', '42'],
      ['', '', ''],
      [null, '', ''],
      [false, '', ''],
      [0, '', ''],
      [[], '', ''],
      [{}, '', ''],
    ];
    for (const [given, stored, echoed] of cases) {
      await expectBody(env, 'PATCH', url(pid), { body: { webhook_url: given } }, 200, E_OK_LITERAL);
      assert.equal(hookRow(env, pid).webhook_url, stored, `库字节：${JSON.stringify(given)}`);
      assert.equal((await call(env, 'GET', url(pid), {})).json().webhook_url, echoed);
    }
    // secret 只回布尔；非字符串同样落 str() 后的字节
    for (const [given, stored, has] of [[true, 'True', true], [['s'], "['s']", true],
      ['  sec  ', 'sec', true], ['', '', false], [null, '', false], [0, '', false]]) {
      await expectBody(env, 'PATCH', url(pid), { body: { webhook_secret: given } }, 200, E_OK_LITERAL);
      assert.equal(hookRow(env, pid).webhook_secret, stored, `库字节：${JSON.stringify(given)}`);
      assert.equal((await call(env, 'GET', url(pid), {})).json().has_webhook_secret, has);
    }
  });

test('PATCH enabled 真值口径 = Python bool()："0"/"false" 都是真，[]/{}/null 都是假', async (t) => {
  const env = setup('enabled');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'a' });
  for (const given of [0, false, '', null, [], {}]) {
    await expectBody(env, 'PATCH', url(pid), { body: { enabled: given } }, 200, E_OK_LITERAL);
    assert.equal(hookRow(env, pid).enabled, 0, `假档：${JSON.stringify(given)}`);
    assert.equal((await call(env, 'GET', url(pid), {})).json().enabled, false);
  }
  for (const given of [1, true, '0', 'false', '1', 'x']) {
    await expectBody(env, 'PATCH', url(pid), { body: { enabled: given } }, 200, E_OK_LITERAL);
    assert.equal(hookRow(env, pid).enabled, 1, `真档：${JSON.stringify(given)}`);
    assert.equal((await call(env, 'GET', url(pid), {})).json().enabled, true);
  }
});

// --------------------------------------------------------------------------
// ③ events 双口径
// --------------------------------------------------------------------------

test('events 写入口径＝原序原样不校验重复；读出口径＝固定序去重（响应顺序≠库顺序）',
  async (t) => {
    const env = setup('events');
    t.after(() => env.close());
    const pid = seedProject(env, { name: 'a' });
    // 重复元素：库逐字保留，回显去重
    await expectBody(env, 'PATCH', url(pid),
      { body: { events: ['task_failed', 'task_failed', 'blocked_interaction'] } }, 200, E_OK_LITERAL);
    assert.equal(hookRow(env, pid).events, 'task_failed,task_failed,blocked_interaction');
    assert.deepEqual((await call(env, 'GET', url(pid), {})).json().events,
      ['blocked_interaction', 'task_failed']);
    // 乱序：库按请求序，回显按 FEISHU_EVENTS 序
    await expectBody(env, 'PATCH', url(pid),
      { body: { events: ['card_review', 'task_failed'] } }, 200, E_OK_LITERAL);
    assert.equal(hookRow(env, pid).events, 'card_review,task_failed');
    assert.deepEqual((await call(env, 'GET', url(pid), {})).json().events,
      ['task_failed', 'card_review']);
    // 空数组 = 清空勾选（合法）
    await expectBody(env, 'PATCH', url(pid), { body: { events: [] } }, 200, E_OK_LITERAL);
    assert.equal(hookRow(env, pid).events, '');
    assert.deepEqual((await call(env, 'GET', url(pid), {})).json().events, []);
  });

test('events 非法（非数组 / 白名单外）⇒ 400 逐字节 + 行不变；含容器则同形抛错（Python 断连）',
  async (t) => {
    const env = setup('events-bad');
    t.after(() => env.close());
    const pid = seedProject(env, { name: 'a' });
    setFeishuHook(pid, 'u', 's', 'card_review', 1, { db: env.db });
    const before = hookRow(env, pid);
    for (const given of ['task_failed', 1, null, true, { a: 1 }, ['bogus'],
      ['task_failed', 'bogus'], ['task_failed', 1], ['card_review', null]]) {
      await expectBody(env, 'PATCH', url(pid), { body: { events: given } }, 400, E_BAD_EVENTS);
      assert.deepEqual(hookRow(env, pid), before, `行被改了：${JSON.stringify(given)}`);
    }
    // 容器元素在 Python 里 `set(req)` 抛 TypeError ⇒ 连接被掐断、无响应（隔离实例实测
    // 三档全是 RemoteDisconnected）。Node 侧同形抛错，由 dispatchSafely 收口成 res.destroy()。
    for (const given of [[[]], [{}], ['card_review', ['x']]]) {
      await assert.rejects(
        call(env, 'PATCH', url(pid), { body: { events: given } }),
        (error) => error instanceof TypeError && /unhashable type/.test(error.message),
        `应抛 TypeError：${JSON.stringify(given)}`);
      assert.deepEqual(hookRow(env, pid), before);
    }
  });

// --------------------------------------------------------------------------
// ④ apply
// --------------------------------------------------------------------------

test('apply 非法 events ⇒ 400 且一行都不写（不建行、不计数）', async (t) => {
  const env = setup('apply-bad');
  t.after(() => env.close());
  seedProject(env, { userId: 101, name: 'b1' });
  seedProject(env, { userId: 101, name: 'b2' });
  await expectBody(env, 'POST', '/api/me/feishu-hook/apply',
    { body: { events: ['bogus'], enabled: true }, user: env.bob }, 400, E_BAD_EVENTS);
  assert.equal(hookCount(env), 0);
});

test('apply：本人全部未归档项目 + 归档跳过 + 无行项目建行 + 名单按 id 升序（创建序）',
  async (t) => {
    const env = setup('apply');
    t.after(() => env.close());
    const p1 = seedProject(env, { name: 'zzz-first' });          // id 小但名字靠后 ⇒ 证明按 id
    const p2 = seedProject(env, { name: 'aaa-second' });
    const p3 = seedProject(env, { name: 'archived', archived: 1 });
    setFeishuHook(p2, 'https://open.feishu.cn/bot/v2/hook/keep-b', '', 'card_review,task_failed',
      0, { db: env.db });
    const r = await expectBody(env, 'POST', '/api/me/feishu-hook/apply',
      { body: { enabled: true } }, 200,
      `{"ok": true, "updated": 2, "archived_skipped": 1, "projects": ["zzz-first", "aaa-second"]}`);
    assert.deepEqual(r.json().projects, ['zzz-first', 'aaa-second']);
    // ① 无绑定行的项目被建行：默认事件集（= FEISHU_DEFAULT_EVENTS，card_review 关）
    assert.equal(hookRow(env, p1).events, 'blocked_interaction,task_failed');
    assert.equal(hookRow(env, p1).enabled, 1);
    // ② 已有行：url 保留（缺省=不改），events 被**重排回写**（无 events 也重排 —— oracle 坑）
    assert.equal(hookRow(env, p2).webhook_url, 'https://open.feishu.cn/bot/v2/hook/keep-b');
    assert.equal(hookRow(env, p2).events, 'task_failed,card_review');
    assert.equal(hookRow(env, p2).enabled, 1);
    // ③ 归档项目一个字节都不动（连行都不建）
    assert.equal(hookRow(env, p3), undefined);
  });

test('apply 带 events：原序原样下发（重复保留）；webhook/secret 空串=清除，缺省=不改', async (t) => {
  const env = setup('apply-events');
  t.after(() => env.close());
  const p1 = seedProject(env, { name: 'a' });
  const p2 = seedProject(env, { name: 'b' });
  setFeishuHook(p2, 'u2', 's2', 'task_failed', 1, { db: env.db });
  await expectBody(env, 'POST', '/api/me/feishu-hook/apply',
    { body: { events: ['card_review', 'task_failed', 'task_failed'] } }, 200,
    '{"ok": true, "updated": 2, "archived_skipped": 0, "projects": ["a", "b"]}');
  assert.equal(hookRow(env, p1).events, 'card_review,task_failed,task_failed');
  assert.equal(hookRow(env, p2).events, 'card_review,task_failed,task_failed');
  assert.equal(hookRow(env, p2).webhook_url, 'u2');        // 未提交 url ⇒ 保留
  assert.equal(hookRow(env, p2).webhook_secret, 's2');
  // 显式空串 ⇒ 清除；enabled 走 bool()
  await expectBody(env, 'POST', '/api/me/feishu-hook/apply',
    { body: { webhook_url: '', webhook_secret: '', enabled: '0' } }, 200,
    '{"ok": true, "updated": 2, "archived_skipped": 0, "projects": ["a", "b"]}');
  assert.equal(hookRow(env, p2).webhook_url, '');
  assert.equal(hookRow(env, p2).webhook_secret, '');
  assert.equal(hookRow(env, p2).enabled, 1);               // bool("0") is True
  // 第二次 apply 没带 events ⇒ 按读出口径重排 + 去重（'card_review,task_failed,task_failed'
  // → 'task_failed,card_review'）；这不是「缺省=不改」，是与单项目 PATCH 同源的写法
  assert.equal(hookRow(env, p2).events, 'task_failed,card_review');
});

test('apply 跨用户隔离：他人项目不出现在名单里，行一个字节不动', async (t) => {
  const env = setup('apply-isolation');
  t.after(() => env.close());
  const mine = seedProject(env, { name: 'mine' });
  const theirs = seedProject(env, { userId: 101, name: 'theirs' });
  setFeishuHook(theirs, 'https://other/hook', 'secret', 'task_failed', 1, { db: env.db });
  const before = hookRow(env, theirs);
  await expectBody(env, 'POST', '/api/me/feishu-hook/apply',
    { body: { enabled: false, events: [], webhook_url: 'https://mine/hook' } }, 200,
    '{"ok": true, "updated": 1, "archived_skipped": 0, "projects": ["mine"]}');
  assert.deepEqual(hookRow(env, theirs), before);
  assert.equal(hookRow(env, mine).webhook_url, 'https://mine/hook');
  // 反向：bob 的 apply 也只碰自己的
  await expectBody(env, 'POST', '/api/me/feishu-hook/apply',
    { body: { enabled: true }, user: env.bob }, 200,
    '{"ok": true, "updated": 1, "archived_skipped": 0, "projects": ["theirs"]}');
  assert.equal(hookRow(env, mine).webhook_url, 'https://mine/hook');   // admin 的行未被 bob 改
  assert.equal(hookRow(env, theirs).enabled, 1);
});

// --------------------------------------------------------------------------
// ⑤ 归档项目 / 隔离闸 / 404 字节
// --------------------------------------------------------------------------

test('归档项目在 GET/PATCH 上完全正常（200，可改）；只有 apply 排除它', async (t) => {
  const env = setup('archived');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'arch', archived: 1 });
  await expectBody(env, 'GET', url(pid), {}, 200, E_DEFAULT);
  await expectBody(env, 'PATCH', url(pid), { body: { enabled: false, events: ['card_review'] } },
    200, E_OK_LITERAL);
  assert.equal(hookRow(env, pid).enabled, 0);
  assert.equal(hookRow(env, pid).events, 'card_review');
  await expectBody(env, 'GET', url(pid), {}, 200,
    '{"webhook_url": "", "has_webhook_secret": false, "enabled": false, "events": ["card_review"]}');
});

test('他人/不存在项目 ⇒ 404 {"error":"not found"} 逐字节；不匹配正则的路径同形（server.js 兜底）',
  async (t) => {
    const env = setup('404');
    t.after(() => env.close());
    const mine = seedProject(env, { name: 'mine' });
    const theirs = seedProject(env, { userId: 101, name: 'theirs' });
    seedProject(env, { userId: 101, name: 'theirs2', archived: 1 });
    // 他人项目（admin 访问）与不存在的 id
    await expectBody(env, 'GET', url(theirs), {}, 404, E_NOT_FOUND);
    await expectBody(env, 'PATCH', url(theirs), { body: { enabled: true } }, 404, E_NOT_FOUND);
    await expectBody(env, 'GET', url(999999), {}, 404, E_NOT_FOUND);
    await expectBody(env, 'PATCH', url(999999), { body: {} }, 404, E_NOT_FOUND);
    assert.equal(hookRow(env, theirs), undefined);          // 越权写不落任何行
    assert.equal(hookCount(env), 0);
    // 正则不匹配档：`\d+` 不吃非数字/负号/小数点/尾斜杠 ⇒ 分派未命中，落 server.js:207 的
    // `respondError(res, 404, 'not found')` —— 与上面端点自回的 404 **同一串字节**。
    // 这里现算那条兜底的源头（不写死"我记得它一样"），再断言路径确实不命中本族正则。
    const serverJs = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'server.js'), 'utf8');
    assert.ok(serverJs.includes("respondError(res, 404, 'not found')"),
      'server.js 的未命中兜底形态变了：本用例的「同形」判据要跟着改');
    for (const target of ['/api/projects/abc/feishu-hook', '/api/projects/-1/feishu-hook',
      '/api/projects/1.5/feishu-hook', `${url(mine)}/`, '/api/projects//feishu-hook',
      '/api/projects/1/feishu-hookx']) {
      const r = await call(env, 'GET', target, {});
      assert.equal(r.hit, false, `不该命中：${target}`);
      assert.equal(r.status, 0);            // 未命中时本层不写响应（兜底在 server.js）
    }
  });

test('读体时机：PATCH 在归属检查之前读体（404 档也读掉，避免污染 keep-alive）', async (t) => {
  const env = setup('readbody');
  t.after(() => env.close());
  const theirs = seedProject(env, { userId: 101, name: 'theirs' });
  const bad = await call(env, 'PATCH', url(999999), { body: { enabled: true } });
  assert.equal(bad.status, 404);
  assert.equal(bad.readState.ended, true);          // 404 也读了体
  const other = await call(env, 'PATCH', url(theirs), { body: { enabled: true } });
  assert.equal(other.status, 404);
  assert.equal(other.readState.ended, true);
  // apply 同样读体（do_POST:1048 统一读）
  const app = await call(env, 'POST', '/api/me/feishu-hook/apply', { body: {} });
  assert.equal(app.status, 200);
  assert.equal(app.readState.ended, true);
});

test('无 body / 坏 JSON / 非对象 JSON 一律按 {} 处理（不 400）', async (t) => {
  const env = setup('body');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'a' });
  setFeishuHook(pid, 'keep', 'sec', 'task_failed', 0, { db: env.db });
  for (const opts of [{}, { raw: '{bad' }, { raw: '[1,2]' }, { raw: '"x"' }, { raw: 'null' },
    { raw: '' }, { raw: '42' }]) {
    await expectBody(env, 'PATCH', url(pid), opts, 200, E_OK_LITERAL);
  }
  assert.deepEqual(hookRow(env, pid),
    { project_id: pid, webhook_url: 'keep', webhook_secret: 'sec', events: 'task_failed',
      enabled: 0 });
});

// --------------------------------------------------------------------------
// ⑥ maskWebhook 回显口径（码点，>48 截断加 …）
// --------------------------------------------------------------------------

test('GET webhook_url 回显走 maskWebhook（码点口径：48 码点不打码、49 打码）', async (t) => {
  const env = setup('mask');
  t.after(() => env.close());
  const pid = seedProject(env, { name: 'a' });
  const long = 'h'.repeat(48) + 'x';                        // 49 码点 ⇒ 前 48 + …
  setFeishuHook(pid, long, '', 'task_failed', 1, { db: env.db });
  let got = (await call(env, 'GET', url(pid), {})).json();
  assert.equal(got.webhook_url, 'h'.repeat(48) + '…');
  const emojiEdge = 'h'.repeat(47) + '😀';                  // 48 码点（49 UTF-16 单元）⇒ 不打码
  setFeishuHook(pid, emojiEdge, '', 'task_failed', 1, { db: env.db });
  got = (await call(env, 'GET', url(pid), {})).json();
  assert.equal(got.webhook_url, emojiEdge);
  assert.equal(got.webhook_url.length, 49);                 // UTF-16 长度：证明用的是码点口径
});

// --------------------------------------------------------------------------
// ⑦ 与 Python 的有意差异（登记，不硬凑）
// --------------------------------------------------------------------------

test('路径 id ≥ 2^63：Python 抛 OverflowError 断连；Node 侧落正常 404（登记的有意差异）', async (t) => {
  const env = setup('huge-id');
  t.after(() => env.close());
  // oracle 实测：GET/PATCH /api/projects/9223372036854775808/feishu-hook ⇒ RemoteDisconnected
  // （`int(m.group(1))` 溢出，未捕获）。Node 侧 Number() 得浮点、node:sqlite 绑定不抛、
  // getProject 无行 ⇒ 正常的 404（更宽，不做连接层攻击面）；不写畸形代码去复刻断连。
  for (const huge of ['9223372036854775808', '99999999999999999999']) {
    await expectBody(env, 'GET', `/api/projects/${huge}/feishu-hook`, {}, 404, E_NOT_FOUND);
    await expectBody(env, 'PATCH', `/api/projects/${huge}/feishu-hook`, { body: {} }, 404,
      E_NOT_FOUND);
  }
  assert.equal(hookCount(env), 0);
});
