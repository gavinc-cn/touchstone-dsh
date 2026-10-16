/**
 * 飞书族数据访问单测（M7-R1）：`lib/db.js` 的 17 个访问函数 + `lib/feishu_cfg.js` 的读助手。
 *
 * 期望值来源（**不读 Node 实现反推**）：
 *   - `db.py:1423-1623` 的 17 个函数逐行对照；`feishu.py:31-145`（常量/`user_config`/
 *     `notify_events`/`hook_of`）与 `:1053-1071`（`app_config`/`inbound_status`）逐行对照；
 *   - 每条边界另用**真 Python 探针**（`/tmp`，不入库）在同一批场景上实测复核，逐条记在下面
 *     各用例的注释里。关键实测结论（**探针原文，不是推断**）：
 *       · dedup：`push('t','s','p','D1',7)` → 1，再 push 同 D1 → `None`，D1 行数 1；
 *         `mark(1,'sent',0,0,'')` 后再 push 同 D1 → 2（新行）；`dedup_key=''` 连推两次 → 3, 4；
 *         dedup **不看 user_id**（u7 推过 K 后 u8 推 K → `None`）；
 *       · `due(999.9999)`→[2,3,4]，`due(1000)`→[2,3,4,5]（**含相等**）；
 *       · `recent()` id 序 [5,4,3,2,1]（新→旧），`recent(50,99)`→[]（另一用户不出现）；
 *       · 同 openId 重绑同一 user：`bound_at` 由 `1999-01-01 00:00:00` 刷成当前时刻，
 *         且表里另有更高 rowid 行时 rowid 1 → 3 ⇒ **DELETE 删掉了自己那行**，走普通插入；
 *         同 openId 换 user：`bound_at` 保留旧值（ON CONFLICT 分支不更新它）；
 *       · 把 INSERT 打成必失败（触发器 RAISE(ABORT)）后旧行仍在 ⇒ DELETE 被同一事务回滚；
 *       · `set_feishu_cur_session(title=None)` → `cur_title=''`；sid/project 传 None → `''`/0；
 *         行不存在 no-op（行数不变）；`clear` 后 `default_project_id` 保留 77；
 *       · 落库 JSON 原文（`json.dumps(obj, ensure_ascii=False)`）逐字节见 JSON 用例；
 *       · `notify_events`/`hook_of` 的矩阵见 feishu_cfg 段（探针输出逐条贴在各断言旁）。
 *
 * 夹具口径：临时库（`m3fixture.freshDb`，**绝不碰生产库**）；写口显式给库位置——主体用
 * `{dbPath}`（走「自开连接 + BEGIN/COMMIT」的生产缺省路径），「同一事务」那条**必须**用它
 * （`{db}` 句柄复用时事务边界归调用方，见 `withWriteDb` 文档，测不到回滚）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as cfg from '../lib/feishu_cfg.js';
import { freshDb, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 时间戳形态（`now_str()` 口径：本地时间 `YYYY-MM-DD HH:MM:SS`） */
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 临时库 + 两个项目（feishu_cfg 段用） */
function setup(tag) {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, { userId: 1, name: 'P-feishu' });
  return { ...fx, pid, opts: { dbPath: fx.dbPath } };
}

/** 读一行（真 SQL，绕开被测函数；返回普通对象，node:sqlite 的行是 null 原型） */
function rowOf(fx, sql, ...args) {
  const row = fx.db.prepare(sql).get(...args);
  return row === undefined ? null : { ...row };
}

/** 读多行 */
function rowsOf(fx, sql, ...args) {
  return fx.db.prepare(sql).all(...args).map((row) => ({ ...row }));
}

/** 数一行 */
function countOf(fx, sql, ...args) {
  return Number(fx.db.prepare(sql).get(...args).n);
}

/** 入队一行（封装 `feishuOutboxPush`，让出参只剩 id） */
function push(fx, dedupKey, userId = 0, target = 'tgt', secret = 'sec') {
  return db.feishuOutboxPush(target, secret, '{"text": "x"}', dedupKey, userId,
    { dbPath: fx.dbPath });
}

// --------------------------------------------------------------------------
// 1. feishu_user_cfgs：get / set / list
// --------------------------------------------------------------------------

test('getFeishuUserCfg：无记录 → {}；set 后读回同一对象（整对象覆盖，不是合并）', () => {
  const fx = setup('feishu-cfg');
  assert.deepEqual(db.getFeishuUserCfg(7, fx.opts), {});

  db.setFeishuUserCfg(7, { enabled: false, default_webhook: 'http://a/' }, fx.opts);
  assert.deepEqual(db.getFeishuUserCfg(7, fx.opts),
    { enabled: false, default_webhook: 'http://a/' });

  // 覆盖：旧键消失（Python 是整对象覆盖，`excluded.json`）
  db.setFeishuUserCfg(7, { app_id: 'cli_x' }, fx.opts);
  assert.deepEqual(db.getFeishuUserCfg(7, fx.opts), { app_id: 'cli_x' });
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_user_cfgs'), 1);
  fx.close();
});

test('JSON 列落库文本 = pyJsonDumps 逐字节（含 ", " / ": " 与非 ASCII 不转义）', () => {
  const fx = setup('feishu-json');
  // ★ 期望串抄自 Python 探针实测输出（`json.dumps(obj, ensure_ascii=False)`），不是 Node 现算
  db.setFeishuUserCfg(1, {
    a: 1, 中文: '值', xs: [1, 2], default_webhook: 'http://x/',
  }, fx.opts);
  const expected1 = '{"a": 1, "中文": "值", "xs": [1, 2], "default_webhook": "http://x/"}';
  const raw1 = rowOf(fx, 'SELECT json FROM feishu_user_cfgs WHERE user_id=1').json;
  assert.equal(raw1, expected1);                                        // 逐字符
  assert.deepEqual([...Buffer.from(raw1, 'utf8')], [...Buffer.from(expected1, 'utf8')]);  // 逐字节

  // 控制字符/emoji/U+2028：CPython 只转义 `"` `\` 与 < U+0020（\u00xx 小写），
  // DEL/U+2028/`/` 不转义——探针实测原文（Python repr 直接抄进 JS 单引号串，转义规则同形）
  const vec = { q: 'he said "hi"\n\ttab', c: '\x01\x1f', emoji: '🎯', slash: 'a/b', u2028: '\u2028' };
  const expected2 = '{"q": "he said \\"hi\\"\\n\\ttab", "c": "\\u0001\\u001f", "emoji": "🎯", "slash": "a/b", "u2028": "\u2028"}';
  db.setFeishuUserCfg(2, vec, fx.opts);
  const raw2 = rowOf(fx, 'SELECT json FROM feishu_user_cfgs WHERE user_id=2').json;
  assert.equal(raw2, expected2);
  assert.deepEqual([...Buffer.from(raw2, 'utf8')], [...Buffer.from(expected2, 'utf8')]);

  // 非对称数组/嵌套/布尔/null（探针向量 2）
  const expected3 = '{"n": null, "t": true, "f": false, "i": -3, "big": 1234567890123, "nested": {"empty": {}, "arr": []}}';
  db.setFeishuUserCfg(3, {
    n: null, t: true, f: false, i: -3, big: 1234567890123, nested: { empty: {}, arr: [] },
  }, fx.opts);
  assert.equal(rowOf(fx, 'SELECT json FROM feishu_user_cfgs WHERE user_id=3').json, expected3);

  // 读回也走 pyJsonLoads（坏 JSON 之外一律能读回原对象）
  assert.deepEqual(db.getFeishuUserCfg(2, fx.opts), vec);
  fx.close();
});

test('坏 JSON：getFeishuUserCfg 降级 {}，listFeishuUserCfgs 整行丢弃', () => {
  const fx = setup('feishu-badjson');
  db.setFeishuUserCfg(1, { ok: 1 }, fx.opts);
  db.setFeishuUserCfg(2, { ok: 2 }, fx.opts);
  fx.db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?, ?)').run(3, 'not json');

  // 单行：坏 JSON 降级 {}（探针：`get(3)` → {}）
  assert.deepEqual(db.getFeishuUserCfg(3, fx.opts), {});
  // 列表：坏行**整行丢弃**（不是降级 {}——否则会多出 (3, {}) 这一对）
  const listed = db.listFeishuUserCfgs(fx.opts);
  assert.deepEqual(Object.fromEntries(listed), { 1: { ok: 1 }, 2: { ok: 2 } });
  assert.deepEqual(listed.map(([userId]) => userId).sort(), [1, 2]);
  // 每项是二元组 [user_id, dict]（Python list[tuple]）
  for (const item of listed) assert.ok(Array.isArray(item) && item.length === 2);

  // JSON 是数组/标量时原样返回（探针：`get(4)` 对 '[1,2]' → [1, 2]）
  fx.db.prepare('INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?, ?)').run(4, '[1,2]');
  assert.deepEqual(db.getFeishuUserCfg(4, fx.opts), [1, 2]);
  fx.close();
});

// --------------------------------------------------------------------------
// 2. feishu_hooks：get / set
// --------------------------------------------------------------------------

test('getFeishuHook / setFeishuHook：无行 null、插入、冲突覆盖四列', () => {
  const fx = setup('feishu-hook');
  assert.equal(db.getFeishuHook(42, fx.opts), null);

  // 探针：insert 后 → {'project_id': 42, 'webhook_url': 'http://h/', 'webhook_secret': 'sec',
  //                   'events': 'blocked_interaction', 'enabled': 1}
  db.setFeishuHook(42, 'http://h/', 'sec', 'blocked_interaction', 1, fx.opts);
  assert.deepEqual(db.getFeishuHook(42, fx.opts), {
    project_id: 42,
    webhook_url: 'http://h/',
    webhook_secret: 'sec',
    events: 'blocked_interaction',
    enabled: 1,
  });

  // 探针：conflict 后 → url/secret/events/enabled 四列全部换新（enabled: 1 → 0）
  db.setFeishuHook(42, 'http://h2/', 'sec2', 'task_failed,card_review', 0, fx.opts);
  assert.deepEqual(db.getFeishuHook(42, fx.opts), {
    project_id: 42,
    webhook_url: 'http://h2/',
    webhook_secret: 'sec2',
    events: 'task_failed,card_review',
    enabled: 0,
  });
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_hooks'), 1);

  // Python sqlite3 把 bool 适配成 1/0；node:sqlite 拒绑 boolean ⇒ 写口内显式同形转换
  db.setFeishuHook(43, 'u', 's', 'e', true, fx.opts);
  assert.equal(rowOf(fx, 'SELECT enabled FROM feishu_hooks WHERE project_id=43').enabled, 1);
  db.setFeishuHook(43, 'u', 's', 'e', false, fx.opts);
  assert.equal(rowOf(fx, 'SELECT enabled FROM feishu_hooks WHERE project_id=43').enabled, 0);
  fx.close();
});

// --------------------------------------------------------------------------
// 3. feishu_outbox：push 的 dedup（最容易写错的一处）
// --------------------------------------------------------------------------

test('feishuOutboxPush：同 dedupKey 且 pending ⇒ 返回 null 且不插行', () => {
  const fx = setup('feishu-dedup');
  const first = push(fx, 'D1', 7);
  assert.equal(typeof first, 'number');                 // lastrowid
  assert.equal(countOf(fx, "SELECT count(*) AS n FROM feishu_outbox WHERE dedup_key='D1'"), 1);

  // ★ 判据：第二次（仍 pending）返回**严格 null**（不是 undefined、不是旧 id）
  const second = push(fx, 'D1', 7);
  assert.equal(second, null);
  assert.equal(countOf(fx, "SELECT count(*) AS n FROM feishu_outbox WHERE dedup_key='D1'"), 1);
  fx.close();
});

test('feishuOutboxPush：dedupKey 命中 sent/failed 行 ⇒ 照插新行', () => {
  const fx = setup('feishu-dedup2');
  const first = push(fx, 'D1', 7);
  db.feishuOutboxMark(first, 'sent', 0, 0, '', fx.opts);
  const second = push(fx, 'D1', 7);                     // 探针：mark sent 后再 push → 新 id 2
  assert.equal(typeof second, 'number');
  assert.notEqual(second, first);
  const statuses = rowsOf(fx,
    "SELECT status FROM feishu_outbox WHERE dedup_key='D1' ORDER BY id").map((r) => r.status);
  assert.deepEqual(statuses, ['sent', 'pending']);

  // failed 同理（dedup 只看 status='pending'）
  db.feishuOutboxMark(second, 'failed', 3, 0, 'boom', fx.opts);
  const third = push(fx, 'D1', 7);
  assert.notEqual(third, second);
  fx.close();
});

test("feishuOutboxPush：dedupKey='' 恒插（不做去重查询）", () => {
  const fx = setup('feishu-dedup3');
  const a = push(fx, '');
  const b = push(fx, '');
  assert.equal(typeof a, 'number');
  assert.equal(typeof b, 'number');
  assert.notEqual(a, b);
  assert.equal(countOf(fx, "SELECT count(*) AS n FROM feishu_outbox WHERE dedup_key=''"), 2);
  fx.close();
});

test('feishuOutboxPush：dedup 只看 dedupKey，**不看 user_id**', () => {
  const fx = setup('feishu-dedup4');
  assert.equal(typeof push(fx, 'K', 7), 'number');
  assert.equal(push(fx, 'K', 8), null);                 // 探针：换用户推同一 key → None
  assert.equal(countOf(fx, "SELECT count(*) AS n FROM feishu_outbox WHERE dedup_key='K'"), 1);
  fx.close();
});

test('feishuOutboxPush：新行字段与时间口径（next_at 硬编码 0 / created_at=now_str）', () => {
  const fx = setup('feishu-push-row');
  const id = push(fx, 'R1', 7, 'http://hook/', 'sekkret');
  const row = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
  assert.equal(row.user_id, 7);
  assert.equal(row.target, 'http://hook/');
  assert.equal(row.secret, 'sekkret');
  assert.equal(row.payload, '{"text": "x"}');           // payload 原样落库（不做 JSON 处理）
  assert.equal(row.status, 'pending');
  assert.equal(row.retries, 0);
  assert.equal(row.next_at, 0);                        // SQL 字面量 0（不是 now）
  assert.equal(row.dedup_key, 'R1');
  assert.equal(row.last_error, '');
  assert.match(row.created_at, TS_RE);                 // 本地时间口径
  assert.ok(Math.abs(Date.parse(row.created_at.replace(' ', 'T')) - Date.now()) < 10_000);

  // payload 里的中文/引号也是原样（调用方已序列化；本函数不碰）
  const id2 = db.feishuOutboxPush('t', 's', 'raw {"a": 1, "b": "中文"}', '', 0, fx.opts);
  assert.equal(rowOf(fx, 'SELECT payload FROM feishu_outbox WHERE id=?', id2).payload,
    'raw {"a": 1, "b": "中文"}');
  fx.close();
});

// --------------------------------------------------------------------------
// 4. feishu_outbox：due / mark / recent
// --------------------------------------------------------------------------

test('feishuOutboxDue：next_at <= now 含相等、只取 pending、按 id 升序限量', () => {
  const fx = setup('feishu-due');
  const a = push(fx, '', 7);
  const b = push(fx, '', 7);
  const sent = push(fx, '', 7);
  db.feishuOutboxMark(a, 'pending', 0, 1000, '', fx.opts);       // 到期时刻正好 1000
  db.feishuOutboxMark(b, 'pending', 0, 999.9999, '', fx.opts);   // 早于 now
  db.feishuOutboxMark(sent, 'sent', 0, 0, '', fx.opts);          // 终态：不该出现
  const fresh = db.feishuOutboxPush('t', 's', 'p', '', 7, fx.opts);   // next_at=0（未 mark）

  assert.deepEqual(db.feishuOutboxDue(1000, 5, fx.opts).map((r) => r.id), [a, b, fresh]);
  assert.deepEqual(db.feishuOutboxDue(999.9999, 5, fx.opts).map((r) => r.id), [b, fresh]);
  assert.deepEqual(db.feishuOutboxDue(999.9998, 5, fx.opts).map((r) => r.id), [fresh]);
  assert.equal(db.feishuOutboxDue(1000, 5, fx.opts).some((r) => r.id === sent), false);
  assert.deepEqual(db.feishuOutboxDue(1000, 1, fx.opts).map((r) => r.id), [a]);   // LIMIT
  assert.deepEqual(db.feishuOutboxDue(1000, 0, fx.opts), []);                     // LIMIT 0 = 空
  fx.close();
});

test('feishuOutboxMark：只改四列；id 不存在静默 no-op', () => {
  const fx = setup('feishu-mark');
  const id = push(fx, 'M1', 7, 'http://keep/', 'secret-keep');
  const before = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
  db.feishuOutboxMark(id, 'pending', 2, 55.5, 'err-中文', fx.opts);
  const after = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
  assert.equal(after.status, 'pending');
  assert.equal(after.retries, 2);
  assert.equal(after.next_at, 55.5);
  assert.equal(after.last_error, 'err-中文');
  for (const col of ['user_id', 'target', 'secret', 'payload', 'dedup_key', 'created_at']) {
    assert.equal(after[col], before[col], `${col} 不该被 mark 改动`);
  }
  // 不存在的 id：不抛、不插行
  db.feishuOutboxMark(9999, 'sent', 0, 0, '', fx.opts);
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_outbox'), 1);
  fx.close();
});

test('feishuOutboxRecent：新→旧 + userId 过滤（另一用户的行不许出现）', () => {
  const fx = setup('feishu-recent');
  const a = push(fx, '', 7);            // 探针：recent() → [5,4,3,2,1]（严格降序）
  const b = push(fx, '', 8);
  const c = push(fx, '', 7);
  const d = push(fx, '', 0);            // user_id=0 是合法过滤值
  assert.deepEqual(db.feishuOutboxRecent(50, null, fx.opts).map((r) => r.id), [d, c, b, a]);
  assert.deepEqual(db.feishuOutboxRecent(50, 7, fx.opts).map((r) => r.id), [c, a]);
  assert.equal(db.feishuOutboxRecent(50, 7, fx.opts).every((r) => r.user_id === 7), true);
  assert.deepEqual(db.feishuOutboxRecent(50, 8, fx.opts).map((r) => r.id), [b]);
  assert.deepEqual(db.feishuOutboxRecent(50, 99, fx.opts), []);          // 探针：另一用户 → []
  assert.deepEqual(db.feishuOutboxRecent(50, 0, fx.opts).map((r) => r.id), [d]);
  assert.deepEqual(db.feishuOutboxRecent(2, null, fx.opts).map((r) => r.id), [d, c]);
  assert.deepEqual(db.feishuOutboxRecent(0, null, fx.opts), []);         // LIMIT 0 = 空
  // 缺省参数：limit=50、user_id=None（= 不过滤）
  assert.deepEqual(db.feishuOutboxRecent().length, 4);
  fx.close();
});

// --------------------------------------------------------------------------
// 5. feishu_bindings：get / set / del / 默认项目 / 当前会话
// --------------------------------------------------------------------------

test('getFeishuBindingByOpen/ByUser：未绑返回 null', () => {
  const fx = setup('feishu-bind-get');
  assert.equal(db.getFeishuBindingByOpen('nobody', fx.opts), null);
  assert.equal(db.getFeishuBindingByUser(999, fx.opts), null);
  db.setFeishuBinding('oA', 100, 5, fx.opts);
  assert.equal(db.getFeishuBindingByOpen('oA', fx.opts).user_id, 100);
  assert.equal(db.getFeishuBindingByUser(100, fx.opts).open_id, 'oA');
  assert.equal(db.getFeishuBindingByUser(101, fx.opts), null);
  fx.close();
});

test('setFeishuBinding：新绑四列归零、bound_at 取列默认（localtime）', () => {
  const fx = setup('feishu-bind-new');
  db.setFeishuBinding('oA', 100, 5, fx.opts);
  const row = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  assert.equal(row.user_id, 100);
  assert.equal(row.default_project_id, 5);
  assert.match(row.bound_at, TS_RE);
  assert.equal(row.cur_sid, '');
  assert.equal(row.cur_project_id, 0);
  assert.equal(row.cur_title, '');
  assert.equal(row.cur_bound_at, '');
  // defaultProjectId 缺省 0
  db.setFeishuBinding('oB', 101, undefined, fx.opts);
  assert.equal(db.getFeishuBindingByOpen('oB', fx.opts).default_project_id, 0);
  fx.close();
});

test('setFeishuBinding：先删该 user 名下的其它行（双向一对一）', () => {
  const fx = setup('feishu-bind-swap');
  db.setFeishuBinding('o1', 200, 1, fx.opts);
  db.setFeishuBinding('o2', 200, 2, fx.opts);       // 换号：o1 必须消失
  assert.equal(db.getFeishuBindingByOpen('o1', fx.opts), null);
  assert.equal(db.getFeishuBindingByOpen('o2', fx.opts).user_id, 200);
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings'), 1);

  // 换号后 default_project_id 取新值、四列归零
  db.setFeishuBinding('o3', 200, 3, fx.opts);
  const row = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'o3');
  assert.equal(row.default_project_id, 3);
  assert.equal(row.cur_sid, '');
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings'), 1);
  fx.close();
});

test('setFeishuBinding：同 openId 重绑 ⇒ 四列归零 + default_project_id 取新值 + bound_at 刷新', () => {
  const fx = setup('feishu-bind-rebind');
  db.setFeishuBinding('oA', 100, 5, fx.opts);
  db.setFeishuCurSession('oA', 3, 'sid-1', '标题', fx.opts);
  fx.db.prepare("UPDATE feishu_bindings SET bound_at='1999-01-01 00:00:00' WHERE open_id='oA'")
    .run();

  db.setFeishuBinding('oA', 100, 123, fx.opts);
  const row = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  assert.equal(row.default_project_id, 123);           // 取新值
  assert.equal(row.cur_sid, '');                       // 四列归零
  assert.equal(row.cur_project_id, 0);
  assert.equal(row.cur_title, '');
  assert.equal(row.cur_bound_at, '');
  // ★ 探针判据：bound_at 被**刷新**（'1999-…' → 当前时刻）⇒ 走的是「DELETE 删掉自己那行 +
  //   普通 INSERT」，不是 ON CONFLICT 分支（后者不更新 bound_at）。rowid 同步变化：
  //   探针在「表里另有更高 rowid 行」的场景实测 1 → 3。
  assert.notEqual(row.bound_at, '1999-01-01 00:00:00');
  assert.match(row.bound_at, TS_RE);
  fx.close();
});

test('setFeishuBinding：同 openId 换 user ⇒ ON CONFLICT 分支，bound_at 保留旧值', () => {
  const fx = setup('feishu-bind-conflict');
  db.setFeishuBinding('oA', 100, 1, fx.opts);
  fx.db.prepare("UPDATE feishu_bindings SET bound_at='1999-01-01 00:00:00' WHERE open_id='oA'")
    .run();
  db.setFeishuCurSession('oA', 8, 'sid-old', 'old', fx.opts);

  db.setFeishuBinding('oA', 300, 42, fx.opts);
  const row = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  assert.equal(row.user_id, 300);
  assert.equal(row.default_project_id, 42);
  assert.equal(row.cur_sid, '');                       // 换绑归零
  assert.equal(row.cur_project_id, 0);
  assert.equal(row.cur_title, '');
  assert.equal(row.cur_bound_at, '');
  assert.equal(row.bound_at, '1999-01-01 00:00:00');   // ★ 覆盖分支不动 bound_at（探针实测）
  assert.equal(db.getFeishuBindingByUser(100, fx.opts), null);
  fx.close();
});

test('setFeishuBinding：DELETE + INSERT 同一事务（INSERT 失败 ⇒ 旧行连同 bound_at 回滚）', () => {
  const fx = setup('feishu-bind-tx');
  db.setFeishuBinding('oT', 900, 1, fx.opts);
  const before = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oT');
  // 让下一次 INSERT 必失败（真触发器，不是 mock）：若 DELETE 与 INSERT 分属两个事务，
  // DELETE 已被提交 ⇒ 旧行会消失；只有同事务回滚才能保住它。
  fx.db.exec("CREATE TRIGGER boom BEFORE INSERT ON feishu_bindings"
    + " WHEN NEW.open_id='oT' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => db.setFeishuBinding('oT', 900, 2, fx.opts));
  const after = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oT');
  assert.notEqual(after, null, 'INSERT 失败后旧行必须还在（DELETE 随事务回滚）');
  assert.equal(after.default_project_id, 1);           // 未被新值 2 覆盖
  assert.equal(after.bound_at, before.bound_at);
  fx.db.exec('DROP TRIGGER boom');
  fx.close();
});

test('delFeishuBindingByOpen/ByUser：删对应行；不存在的行静默 no-op', () => {
  const fx = setup('feishu-bind-del');
  db.setFeishuBinding('oA', 100, 1, fx.opts);
  db.setFeishuBinding('oB', 200, 1, fx.opts);
  db.delFeishuBindingByOpen('oA', fx.opts);
  assert.equal(db.getFeishuBindingByOpen('oA', fx.opts), null);
  assert.equal(db.getFeishuBindingByUser(200, fx.opts).open_id, 'oB');
  db.delFeishuBindingByUser(200, fx.opts);
  assert.equal(db.getFeishuBindingByUser(200, fx.opts), null);
  db.delFeishuBindingByOpen('ghost', fx.opts);          // 不抛
  db.delFeishuBindingByUser(999, fx.opts);              // 不抛
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings'), 0);
  fx.close();
});

test('setFeishuDefaultProject：改默认项目；行不存在 no-op；不动当前会话', () => {
  const fx = setup('feishu-default-proj');
  db.setFeishuBinding('oA', 100, 5, fx.opts);
  db.setFeishuCurSession('oA', 3, 'sid-1', 'T', fx.opts);
  const before = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  db.setFeishuDefaultProject('oA', 77, fx.opts);
  const after = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  assert.equal(after.default_project_id, 77);
  assert.equal(after.cur_sid, before.cur_sid);
  assert.equal(after.cur_project_id, before.cur_project_id);
  assert.equal(after.cur_title, before.cur_title);
  assert.equal(after.bound_at, before.bound_at);        // 也不刷 bound_at
  db.setFeishuDefaultProject('ghost', 7, fx.opts);      // no-op
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings'), 1);
  fx.close();
});

test("setFeishuCurSession：写入四列 + cur_bound_at 取 now_str；空值口径照 Python 的 or", () => {
  const fx = setup('feishu-cur-session');
  db.setFeishuBinding('oA', 100, 5, fx.opts);

  db.setFeishuCurSession('oA', 3, 'sid-1', '标题', fx.opts);
  const row = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  assert.equal(row.cur_sid, 'sid-1');
  assert.equal(row.cur_project_id, 3);
  assert.equal(row.cur_title, '标题');
  assert.match(row.cur_bound_at, TS_RE);
  assert.equal(row.default_project_id, 5);             // 不碰默认项目

  // title 缺省 ⇒ 清空（探针：title 缺省 → cur_title=''；None → ''）
  db.setFeishuCurSession('oA', 3, 'sid-2', undefined, fx.opts);
  assert.equal(db.getFeishuBindingByOpen('oA', fx.opts).cur_title, '');
  db.setFeishuCurSession('oA', 3, 'sid-3', null, fx.opts);
  assert.equal(db.getFeishuBindingByOpen('oA', fx.opts).cur_title, '');
  // sid/project 传 None ⇒ ''/0（`sid or ""` / `int(project_id or 0)`）
  db.setFeishuCurSession('oA', null, null, null, fx.opts);
  const cleared = db.getFeishuBindingByOpen('oA', fx.opts);
  assert.equal(cleared.cur_sid, '');
  assert.equal(cleared.cur_project_id, 0);
  assert.equal(cleared.cur_title, '');
  // int() 口径：数字字符串照样转整数
  db.setFeishuCurSession('oA', '12', 'sid-4', 't', fx.opts);
  assert.equal(rowOf(fx, 'SELECT cur_project_id FROM feishu_bindings WHERE open_id=?', 'oA')
    .cur_project_id, 12);
  fx.close();
});

test('setFeishuCurSession：行不存在 = no-op（不插行、不抛）', () => {
  const fx = setup('feishu-cur-noop');
  db.setFeishuBinding('oA', 100, 5, fx.opts);
  const n = countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings');
  db.setFeishuCurSession('ghost', 3, 'sid', 'ttl', fx.opts);
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings'), n);
  assert.equal(db.getFeishuBindingByOpen('ghost', fx.opts), null);
  fx.close();
});

test('clearFeishuCurSession：四列清空但**保留 defaultProjectId**；未绑 no-op', () => {
  const fx = setup('feishu-clear-cur');
  db.setFeishuBinding('oA', 100, 5, fx.opts);
  db.setFeishuDefaultProject('oA', 77, fx.opts);
  db.setFeishuCurSession('oA', 3, 'sid-9', 'T', fx.opts);
  db.clearFeishuCurSession('oA', fx.opts);
  const row = rowOf(fx, 'SELECT * FROM feishu_bindings WHERE open_id=?', 'oA');
  assert.equal(row.cur_sid, '');
  assert.equal(row.cur_project_id, 0);
  assert.equal(row.cur_title, '');
  assert.equal(row.cur_bound_at, '');
  assert.equal(row.default_project_id, 77);            // 探针：clear 后 77 仍在
  assert.equal(row.user_id, 100);
  db.clearFeishuCurSession('ghost', fx.opts);          // 未绑 no-op
  assert.equal(countOf(fx, 'SELECT count(*) AS n FROM feishu_bindings'), 1);
  fx.close();
});

// --------------------------------------------------------------------------
// 6. feishu_cfg.js：常量 + 读助手（`feishu.py:31-145` / `:1053-1071`）
// --------------------------------------------------------------------------

test('FEISHU_EVENTS / FEISHU_DEFAULT_EVENTS：内容与顺序照 feishu.py:31/35', () => {
  assert.deepEqual([...cfg.FEISHU_EVENTS],
    ['blocked_interaction', 'task_failed', 'card_review']);
  assert.deepEqual([...cfg.FEISHU_DEFAULT_EVENTS], ['blocked_interaction', 'task_failed']);
  assert.equal(Object.isFrozen(cfg.FEISHU_EVENTS), true);
  assert.equal(Object.isFrozen(cfg.FEISHU_DEFAULT_EVENTS), true);
});

test('userConfig / appConfig：凭据缺一即 null；空串按假值（探针逐条）', () => {
  const fx = setup('feishu-cfg-app');
  assert.deepEqual(cfg.userConfig(1, fx.opts), {});
  assert.equal(cfg.appConfig(1, fx.opts), null);                    // 无配置
  db.setFeishuUserCfg(1, { app_id: 'cli_x' }, fx.opts);
  assert.equal(cfg.appConfig(1, fx.opts), null);                    // 只有 app_id
  db.setFeishuUserCfg(1, { app_id: '', app_secret: 's' }, fx.opts);
  assert.equal(cfg.appConfig(1, fx.opts), null);                    // 空串同样算缺失
  const full = { app_id: 'cli_x', app_secret: 's', base_url: 'http://site/' };
  db.setFeishuUserCfg(1, full, fx.opts);
  assert.deepEqual(cfg.appConfig(1, fx.opts), full);                // 返回整个配置对象
  assert.deepEqual(cfg.userConfig(1, fx.opts), full);
  fx.close();
});

test('notifyEvents：事件闸门矩阵（总控一票否决 / 项目行 / 回落默认集）', () => {
  const fx = setup('feishu-notify');
  const pid = fx.pid;
  // 探针：无 hook 无 cfg → {'task_failed','blocked_interaction'}
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set(cfg.FEISHU_DEFAULT_EVENTS));
  // 探针：用户 enabled=False、无 hook → set()
  db.setFeishuUserCfg(1, { enabled: false }, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set());
  // 探针：push_enabled=False（缺 enabled）→ set()，且**先于项目行**判定
  db.setFeishuUserCfg(1, { enabled: true, push_enabled: false }, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set());
  db.setFeishuHook(pid, '', '', 'blocked_interaction', 1, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set());      // 项目行开着也静默

  // 探针：hook enabled=1 events=bi,cr → {'card_review','blocked_interaction'}
  db.setFeishuUserCfg(1, { enabled: true }, fx.opts);
  db.setFeishuHook(pid, '', '', 'blocked_interaction,card_review', 1, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts),
    new Set(['blocked_interaction', 'card_review']));
  // 探针：含未知事件 → 只留合法项（按全集过滤）
  db.setFeishuHook(pid, '', '', 'bogus,blocked_interaction', 1, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set(['blocked_interaction']));
  // 探针：行内勾空 ⇒ 空集（有绑定行就不再回落）
  db.setFeishuHook(pid, '', '', '', 1, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set());
  // 探针：hook enabled=0 ⇒ 空集（不回落用户配置）
  db.setFeishuHook(pid, '', '', 'blocked_interaction', 0, fx.opts);
  assert.deepEqual(cfg.notifyEvents(pid, fx.opts), new Set());

  // 探针：项目不存在(9) → 默认集（owner=0 的配置 = {}）
  assert.deepEqual(cfg.notifyEvents(999999, fx.opts), new Set(cfg.FEISHU_DEFAULT_EVENTS));
  fx.close();
});

test('hookOf：绑定行优先 / 回落用户默认 webhook / base_url 削尾斜杠 / 空事件 ⇒ null', () => {
  const fx = setup('feishu-hook-of');
  const pid = fx.pid;
  db.setFeishuUserCfg(1, {
    default_webhook: 'http://def/', default_secret: 'ds', base_url: 'http://site///',
  }, fx.opts);

  // 探针：row 有 url → target=row url；base_url 由 'http://site///' 削成 'http://site'
  db.setFeishuHook(pid, 'http://row/', 'rs', 'blocked_interaction', 1, fx.opts);
  assert.deepEqual(cfg.hookOf(pid, fx.opts), {
    target: 'http://row/',
    secret: 'rs',
    events: new Set(['blocked_interaction']),
    base_url: 'http://site',
    user_id: 1,
  });

  // 探针：row 无 url → 回落 default_webhook/default_secret
  db.setFeishuHook(pid, '', '', 'blocked_interaction', 1, fx.opts);
  assert.deepEqual(cfg.hookOf(pid, fx.opts), {
    target: 'http://def/',
    secret: 'ds',
    events: new Set(['blocked_interaction']),
    base_url: 'http://site',
    user_id: 1,
  });

  // 探针：回落但用户 enabled=False / 无 default_webhook ⇒ null
  db.setFeishuUserCfg(1, { default_webhook: 'http://def/', enabled: false }, fx.opts);
  assert.equal(cfg.hookOf(pid, fx.opts), null);
  db.setFeishuUserCfg(1, { base_url: 'http://site///' }, fx.opts);
  assert.equal(cfg.hookOf(pid, fx.opts), null);
  // 探针：base_url 空/缺键 → ''（`.get(...) or ''` 后再 rstrip）
  db.setFeishuUserCfg(1, { default_webhook: 'http://def/', base_url: '' }, fx.opts);
  assert.equal(cfg.hookOf(pid, fx.opts).base_url, '');
  assert.equal(cfg.hookOf(pid, fx.opts).secret, '');                // default_secret 缺键 → ''
  db.setFeishuUserCfg(1, { default_webhook: 'http://def/' }, fx.opts);
  assert.equal(cfg.hookOf(pid, fx.opts).base_url, '');
  // 探针：default_secret 键存在但为 null ⇒ null（Python `.get(k, d)` 只在缺键时给 default）
  db.setFeishuUserCfg(1, { default_webhook: 'http://def/', default_secret: null }, fx.opts);
  assert.equal(cfg.hookOf(pid, fx.opts).secret, null);

  // 探针：events 空集 ⇒ 整个 hookOf 为 null（即使行里有 url）
  db.setFeishuHook(pid, 'http://row/', 'rs', '', 1, fx.opts);
  assert.equal(cfg.hookOf(pid, fx.opts), null);
  // 探针：项目不存在 → null
  assert.equal(cfg.hookOf(999999, fx.opts), null);
  fx.close();
});

test('inboundStatus：configured 看凭据；thread 恒 false（M7.5 注册表接缝）', () => {
  const fx = setup('feishu-inbound');
  // 探针：无配置 → {'configured': False, 'thread': False}
  assert.deepEqual(cfg.inboundStatus(1, fx.opts), { configured: false, thread: false });
  db.setFeishuUserCfg(1, { app_id: 'cli_x' }, fx.opts);
  assert.deepEqual(cfg.inboundStatus(1, fx.opts), { configured: false, thread: false });
  db.setFeishuUserCfg(1, { app_id: 'cli_x', app_secret: 's' }, fx.opts);
  // 探针：凭据齐全 → {'configured': True, 'thread': False}（进程刚起、未拉起长连接）
  assert.deepEqual(cfg.inboundStatus(1, fx.opts), { configured: true, thread: false });

  // M7.5 接缝：注册表放一个线程形对象（`isAlive()`）后 thread 跟着变
  cfg.setInboundThread(1, { isAlive: () => true });
  assert.deepEqual(cfg.inboundStatus(1, fx.opts), { configured: true, thread: true });
  cfg.setInboundThread(1, { isAlive: () => false });          // 线程退出：条目残留、判死
  assert.deepEqual(cfg.inboundStatus(1, fx.opts), { configured: true, thread: false });
  cfg.clearInboundThread(1);
  assert.deepEqual(cfg.inboundStatus(1, fx.opts), { configured: true, thread: false });
  // 注册表按 user_id 分桶：别人的线程不影响本用户
  cfg.setInboundThread(2, { isAlive: () => true });
  assert.equal(cfg.inboundStatus(1, fx.opts).thread, false);
  assert.equal(cfg.inboundStatus(2, fx.opts).thread, true);
  cfg.clearInboundThread(2);
  fx.close();
});
